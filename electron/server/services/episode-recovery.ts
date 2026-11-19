/** Fixed, episode-owned recovery order. Provider/credit decisions belong to subtitle-recovery. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Job, JobType } from '../models/types.js'
import { CIRCULAR_MARKER, repairCircularParams, type RepairableJob } from '../lib/circular-params-repair.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import * as jq from './job-queue.js'
import { findLiveChatModel, savedChatModelGoneMessage } from './live-chat-model.js'
import { getProjectDir, listProjects } from './project-manager.js'
import { computeEpisodeStatus, hasAcceptedFinalVideo } from './asset-status.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { inspectAudioAssemblyReadiness, isScopedChapterTranscription } from './audio-workflow-readiness.js'
import { readStitchPlan } from './subtitle-stitcher.js'
import { inspectSubtitleSourceFreshness } from './subtitle-completion.js'
import { ensureStitchedSubtitle, type EnsureStitchedOptions } from '../lib/subtitle-autostitch.js'
import { verifyWrittenSubtitleTimeline } from './scene-timeline-integrity.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { inspectPlanTimelineDrift, type TimelineDrift } from '../lib/scene-plan-timeline.js'
import { resolveEpisodeMergedAudioChoice, expectedMergedAudioFilename } from '../lib/merged-audio-selection.js'
import { hashSubtitleAudioSources, inspectChapterSubtitleCompletion } from './subtitle-completion.js'
import { readSubtitleSourceAudioHashes } from './subtitle-recovery.js'
import { readLocalMediaCleanupStatus } from './episode-media-cleanup.js'
import { disabledOptionalStepReason } from '../lib/optional-steps.js'
import { withSavedPromptCollection } from '../lib/scene-prompt-collection.js'
import { stampFreshGenerationAction } from '../lib/fresh-generation-action.js'

export const EPISODE_RECOVERY_ORDER = ['audio_merge', 'subtitle_sections', 'subtitle_stitch', 'scene_plan_run', 'contextual_cues', 'continuity_render'] as const
export type EpisodeRecoveryStep = typeof EPISODE_RECOVERY_ORDER[number]
type RecoveryJob = { job_id: string; type: JobType; title: string; params: Job['params']; source_job_id?: string; dispatched?: boolean; manual_image_finish_withheld?: true; stale_redispatched?: true; redispatched?: true }
type RecoveryContinuation = { type: JobType; title?: string; params?: Job['params']; manual_image_finish_withheld?: true }
type NarrationRefreshAcknowledgement = { source_job_id: string; section: string; job_id: string; created_at: string; source_saved_at: string }
export type RecoveryAdmissionSource = 'boot' | 'completion' | 'timer' | 'owner'
export type RecoveryAdmissionAction = 'enqueue' | 'adopt' | 'resume'
/** Append-only evidence of when and why a recovery edge was admitted. */
export interface RecoveryAdmissionEvent {
  step: EpisodeRecoveryStep | 'continuation'
  action: RecoveryAdmissionAction
  at: string
  source: RecoveryAdmissionSource
  job_id?: string
  source_job_ids?: string[]
}
export interface EpisodeRecoveryPlan {
  version: 1
  id: string
  project_slug: string
  episode_id: string
  target: EpisodeRecoveryStep
  steps: Partial<Record<EpisodeRecoveryStep, RecoveryJob>>
  completed: EpisodeRecoveryStep[]
  first_unresolved: EpisodeRecoveryStep | null
  message: string
  continuation?: RecoveryContinuation[]
  continuation_dispatched?: boolean
  continuation_job_id?: string
  pipeline_batch_id?: string
  retry_source_job_ids?: string[]
  next_free_check_at?: string
  narration_refresh_job_ids?: string[]
  narration_refresh_checks?: NarrationRefreshAcknowledgement[]
  /** Last time the owner asked for this recovery (Retry / Recover); automatic passes never set it. */
  owner_requested_at?: string
  /** Append-only admission receipts; never rewritten, and automatic receipts never become authority. */
  admission_events?: RecoveryAdmissionEvent[]
}

function savedNarrationStamp(check: Job): string | null {
  const proof = check.params.narration_refresh_source
  const sections = check.params.sections as string[]
  return proof && typeof proof.saved_at === 'string' && Number.isFinite(Date.parse(proof.saved_at))
    && new Date(proof.saved_at).toISOString() === proof.saved_at && Array.isArray(proof.sections)
    && proof.sections.length === sections.length && new Set(sections.map(section => section.trim().toLowerCase())).size === sections.length
    && new Set(proof.sections.map((section: unknown) => typeof section === 'string' ? section.trim().toLowerCase() : section)).size === sections.length
    && proof.sections.every((section: unknown) => typeof section === 'string'
      && sections.some(item => item.trim().toLowerCase() === section.trim().toLowerCase()))
    ? proof.saved_at : null
}

function savedNarrationSource(check: Job, jobs: Job[]): string | null {
  const stamp = savedNarrationStamp(check)
  if (check.params.narration_refresh_source && !stamp) return null
  const source = jobs.find(job => job.job_id === check.params.narration_refresh_job_id)
  if (source) return source.type === 'audio' && source.project_slug === check.project_slug && source.episode_id === check.episode_id
    && source.params?.then_subtitles === true && !source.force_abandoned && source.status !== 'cancelled'
    ? stamp || source.finished_at || source.started_at || source.created_at : null
  return stamp
}

/** Only a server-stamped child of this episode's narration can request a refresh. */
function narrationRefreshChecks(jobs: Job[]): Job[] {
  return jobs.filter(job => job.type === 'subtitles_transcribe' && isScopedChapterTranscription(job.params)
    && typeof job.params.narration_refresh_job_id === 'string'
    && !!job.params.narration_refresh_job_id.trim()
    && !!savedNarrationSource(job, jobs))
}

/** Each distinct section message once, with the sections it applies to (EP0100 repeated one sentence 17 times). */
export function subtitleStatesMessage(sections: Record<string, { message?: string }> | undefined): string {
  const bySentence = new Map<string, string[]>()
  for (const [section, state] of Object.entries(sections || {})) {
    if (state?.message) bySentence.set(state.message, [...(bySentence.get(state.message) || []), section])
  }
  return [...bySentence].map(([message, names]) => `${names.join(', ')}: ${message}`).join(' ')
}

function recoveryAdmissionEvent(
  step: EpisodeRecoveryStep | 'continuation',
  action: RecoveryAdmissionAction,
  source: RecoveryAdmissionSource,
  jobId?: string,
  sourceJobIds: string[] = [],
): RecoveryAdmissionEvent {
  return {
    step,
    action,
    at: new Date().toISOString(),
    source,
    ...(jobId ? { job_id: jobId } : {}),
    ...(sourceJobIds.length ? { source_job_ids: [...new Set(sourceJobIds)] } : {}),
  }
}

function recordRecoveryAdmission(
  plan: EpisodeRecoveryPlan,
  step: EpisodeRecoveryStep | 'continuation',
  action: RecoveryAdmissionAction,
  source: RecoveryAdmissionSource,
  jobId?: string,
  sourceJobIds: string[] = [],
): void {
  const events = plan.admission_events ||= []
  const last = events.at(-1)
  // Rechecking the same edge is not a new admission; preserve the original receipt.
  if (action === 'adopt' && source !== 'owner' && last?.step === step && last.action === action && last.source === source && last.job_id === jobId) return
  events.push(recoveryAdmissionEvent(step, action, source, jobId, sourceJobIds))
}

async function continueFailedSubtitleCheck(plan: EpisodeRecoveryPlan, job: Job, explicit: boolean, source: RecoveryAdmissionSource): Promise<boolean> {
  if (job.status !== 'error') return false
  if (explicit) {
    await jq.resumeEpisodeRecoveryJob(job.job_id, true)
    recordRecoveryAdmission(plan, 'subtitle_sections', 'resume', 'owner', job.job_id)
    return true
  }
  const states = Object.values(job.params?.subtitle_recovery?.sections || {}) as Array<{ state?: string }>
  if (!states.some(state => state.state === 'waiting_settlement' || state.state === 'free_recovery')) return false
  const due = Date.parse(plan.next_free_check_at || '')
  plan.next_free_check_at ||= new Date(Date.now() + 30_000).toISOString()
  if (Number.isFinite(due) && due <= Date.now()) {
    plan.next_free_check_at = new Date(Date.now() + 30_000).toISOString()
    await jq.resumeEpisodeRecoveryJob(job.job_id)
    recordRecoveryAdmission(plan, 'subtitle_sections', 'resume', source, job.job_id)
    return true
  }
  return false
}

/** The existing episode lock coalesces the currently known chapter repair batch. */
async function waitForNarrationRefreshChecks(plan: EpisodeRecoveryPlan, jobs: Job[], sourceJobIds: string[], source: RecoveryAdmissionSource): Promise<boolean> {
  if (!plan.narration_refresh_job_ids?.length) return false
  const owned = jobs.filter(job => job.project_slug === plan.project_slug && job.episode_id === plan.episode_id)
  const stamped = narrationRefreshChecks(owned).filter(job => plan.narration_refresh_job_ids!.includes(job.params.narration_refresh_job_id))
  const acknowledgements = new Map((plan.narration_refresh_checks || []).map(check => [`${check.source_job_id}:${check.section.toLowerCase()}`, check]))
  const expected = new Map(acknowledgements)
  for (const check of stamped) for (const section of check.params.sections as string[]) {
    const key = `${check.params.narration_refresh_job_id}:${section.toLowerCase()}`
    if (!expected.has(key)) expected.set(key, { source_job_id: check.params.narration_refresh_job_id, section,
      job_id: check.job_id, created_at: check.created_at, source_saved_at: savedNarrationSource(check, owned)! })
  }
  // ponytail: repair batches are small; scan owned history per chapter, index it if long histories become costly.
  const failed = new Set<Job>()
  const successful: Array<[string, NarrationRefreshAcknowledgement]> = []
  const absent = plan.narration_refresh_job_ids.filter(id => ![...expected.values()].some(check => check.source_job_id === id))
  for (const [key, scope] of expected) {
    const latest = owned.filter(job => job.type === 'subtitles_transcribe' && isScopedChapterTranscription(job.params)
      && job.created_at >= scope.created_at && (job.params.sections as string[]).some(item => item.trim().toLowerCase() === scope.section.trim().toLowerCase()))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
    if (latest && (latest.status !== 'done' || latest.result?.scope_complete !== true)) { failed.add(latest); continue }
    if (!latest && !acknowledgements.has(key)) { absent.push(scope.source_job_id); continue }
    successful.push([key, latest ? { ...scope, job_id: latest.job_id, created_at: latest.created_at } : scope])
  }
  const invalid: string[] = []
  if (successful.length) {
    try {
      const sections = [...new Set(successful.map(([, check]) => check.section))]
      const { resolveSubtitleChapterSources } = await import('../generators/subtitles.js')
      const { audioDir, episodePaths, allSections } = await resolveSubtitleChapterSources(plan.project_slug, plan.episode_id.toUpperCase(), sections)
      const [recorded, coverage] = await Promise.all([
        readSubtitleSourceAudioHashes(episodePaths.subtitles_dir),
        inspectChapterSubtitleCompletion(episodePaths.subtitles_dir, plan.episode_id, sections),
      ])
      for (const [key, check] of successful) {
        const source = allSections.find(section => section.slug.toLowerCase() === check.section.toLowerCase())
        const hash = source && await hashSubtitleAudioSources(source.files.map(file => path.join(audioDir, file)))
        const filename = `${plan.episode_id.toUpperCase()}_${source?.slug || check.section}.srt`
        if (!hash || recorded[filename] !== hash || !coverage.completed_sections.includes(check.section)) invalid.push(check.section)
        else if (owned.some(job => job.job_id === check.source_job_id && job.type === 'audio' && job.status === 'done')
          || stamped.some(job => job.params.narration_refresh_job_id === check.source_job_id && !!savedNarrationStamp(job))
          || acknowledgements.has(key)) acknowledgements.set(key, check)
      }
    } catch (error) {
      plan.message = `Audio Assembly waiting for verified chapter subtitle sources: ${error instanceof Error ? error.message : String(error)}`
      return true
    }
  }
  // These compact, hash-checked acknowledgements survive Clear Finished without
  // turning an absent failed or unknown job into a successful one.
  plan.narration_refresh_checks = [...acknowledgements.values()]
  if (owned.some(job => (job.type === 'audio' || (job.type === 'subtitles_transcribe' && isScopedChapterTranscription(job.params)))
    && ['queued', 'running', 'paused'].includes(job.status))) {
    plan.message = 'Waiting for narration and chapter subtitle checks before Audio Assembly.'
    return true
  }
  if (plan.narration_refresh_job_ids.some(id => {
    const source = owned.find(job => job.job_id === id)
    return source ? source.type !== 'audio' || source.status !== 'done' || source.force_abandoned
      : ![...expected.values()].some(check => check.source_job_id === id && check.source_saved_at)
  })) {
    plan.message = 'Audio Assembly waiting for the saved chapter narration to finish successfully. Retry the failed narration before checking its subtitles.'
    return true
  }
  if (invalid.length) {
    plan.message = `Audio Assembly waiting for current subtitle source evidence for ${[...new Set(invalid)].join(', ')}. Active narration changed or its checked transcript is unavailable. Re-transcribe those chapters; completed chapters are preserved.`
    return true
  }
  if (!absent.length && !failed.size) return false
  for (const job of failed) await continueFailedSubtitleCheck(plan, job, sourceJobIds.includes(job.job_id), source)
  plan.message = `Audio Assembly waiting for chapter subtitle checks. ${[...failed].map(job => job.error || job.title).join(' ')}${absent.length ? ' The saved narration refresh has no verified chapter check; open Subtitles to check the repaired chapters.' : ''}`
  return true
}

const MANUAL_IMAGE_FINISH_GUIDANCE = 'Open Scene Review and use Finish missing images with the current model settings.'

function withholdManualImageFinish(node: { params?: Job['params']; manual_image_finish_withheld?: true }): boolean {
  if (node.params?.manual_image_finish) {
    delete node.params.manual_image_finish
    node.manual_image_finish_withheld = true
  }
  return node.manual_image_finish_withheld === true
}

function withholdManualImageFinishFromPlan(plan: EpisodeRecoveryPlan): void {
  for (const node of Object.values(plan.steps)) if (node) withholdManualImageFinish(node)
  for (const node of plan.continuation || []) withholdManualImageFinish(node)
}

function assertSectionScope(params: Job['params']): void {
  if (params.sections !== undefined && (!Array.isArray(params.sections)
    || params.sections.some((section: unknown) => typeof section !== 'string' || !section.trim()))) {
    throw new Error('Invalid saved subtitle section scope. Select the intended sections explicitly in Subtitles.')
  }
}

export function episodeRecoveryStep(type: string): EpisodeRecoveryStep | null {
  if (type === 'subtitles_transcribe') return 'subtitle_sections'
  if (type === 'scene_images_batch') return 'continuity_render'
  return EPISODE_RECOVERY_ORDER.includes(type as EpisodeRecoveryStep) ? type as EpisodeRecoveryStep : null
}

function repairRecoveryNodeParams(
  plan: EpisodeRecoveryPlan,
  jobId: string,
  input: Job['params'],
  pool: RepairableJob[],
  exactSource?: RepairableJob,
): Job['params'] {
  const bags = (params: Job['params']): Array<Record<string, unknown>> => [params || {},
    ...(Array.isArray(params?.pipeline_chain) ? params.pipeline_chain
      .map((link: { params?: unknown } | null) => link?.params && typeof link.params === 'object'
        ? link.params as Record<string, unknown> : null)
      .filter((bag): bag is Record<string, unknown> => !!bag) : [])]
  const marked = [...new Set(bags(input).flatMap(bag => Object.keys(bag).filter(key => bag[key] === CIRCULAR_MARKER)))]
  if (!marked.length) return structuredClone(input || {})
  const params = structuredClone(input || {})
  const hadBatch = params.pipeline_batch_id !== undefined
  const hadRecovery = params.episode_recovery_id !== undefined
  params.pipeline_batch_id ||= plan.pipeline_batch_id || exactSource?.params?.pipeline_batch_id
  params.episode_recovery_id ||= plan.id
  const target: RepairableJob = {
    job_id: jobId,
    project_slug: plan.project_slug,
    episode_id: plan.episode_id,
    params,
  }
  repairCircularParams([target], [...(exactSource ? [exactSource] : []), ...pool, target], () => {})
  for (const key of marked) {
    if (!bags(params).some(bag => bag[key] !== undefined && bag[key] !== CIRCULAR_MARKER)) {
      throw new Error(`Saved recovery setting ${key} could not be restored from its original Pipeline run. No recovery job was queued.`)
    }
  }
  if (!hadBatch) delete params.pipeline_batch_id
  if (!hadRecovery) delete params.episode_recovery_id
  return params
}

/** Repair old recovery snapshots before they can create or resume a child. Never uses current project defaults. */
export function repairEpisodeRecoveryPlanParams(plan: EpisodeRecoveryPlan, jobs: Job[]): boolean {
  const repairs: Array<[RecoveryJob | RecoveryContinuation, Job['params']]> = []
  for (const node of [...Object.values(plan.steps), ...(plan.continuation || [])]) {
    if (!node) continue
    const sourceJobId = 'source_job_id' in node && typeof node.source_job_id === 'string' ? node.source_job_id : undefined
    const source = sourceJobId ? jobs.find(job => job.job_id === sourceJobId) : undefined
    const jobId = 'job_id' in node && typeof node.job_id === 'string' ? node.job_id : `${plan.id}:${node.type}`
    const params = repairRecoveryNodeParams(plan, jobId, node.params || {}, jobs, source)
    if (!isDeepStrictEqual(params, node.params || {})) repairs.push([node, params])
  }
  for (const [node, params] of repairs) node.params = params
  return repairs.length > 0
}

/**
 * The music levels a saved Audio Assembly node states that CANNOT be linear gain.
 *
 * Levels are linear gain (`0.08` = 8%); every slider that writes one reaches at most 100%, so a
 * stated level above `1` is a percentage written before 1.4.361. Never read as a level and never
 * scaled by size — the value's unit is unknown (`lib/audio-gain.ts`).
 */
function percentShapedMusicLevels(params: Job['params'] | undefined): string[] {
  const music = params?.music as Record<string, unknown> | undefined
  if (!music) return []
  return (['volume', 'post_narration_volume'] as const)
    .filter(key => Number(music[key]) > 1)
    .map(key => `music.${key} = ${music[key]}`)
}

/** Why a recovery node's saved mix cannot be replayed, or null when it can (AGENTS.md §6: name the repair). */
function recoveryMergeLevelRefusal(params: Job['params'] | undefined, episodeId: string): string | null {
  if (params?.level_unit === 'linear') return null
  const levels = percentShapedMusicLevels(params)
  if (!levels.length) return null
  return `Audio Assembly was not queued: ${episodeId.toUpperCase()}'s saved mix settings were written before levels `
    + `became linear gain, so they cannot be replayed (${levels.join(', ')} — 8 is not 8% but eight times the voice). `
    + 'Open Audio Assembly, check the mix with the current preset, and run Audio Assembly from that page.'
}

export function createEpisodeRecoveryPlan(jobs: Job[], sourceJobIds: string[] = [], settingsPool: Job[] = jobs): EpisodeRecoveryPlan {
  if (!jobs.length) throw new Error('Recovery requires an existing episode job.')
  const first = jobs[0]
  const id = randomUUID()
  const plan: EpisodeRecoveryPlan = { version: 1, id, project_slug: first.project_slug, episode_id: first.episode_id,
    target: 'subtitle_stitch', steps: {}, completed: [], first_unresolved: 'audio_merge', message: 'Checking episode prerequisites.' }
  const add = (type: string, title: string, input: Job['params'], source?: Job, settingsSource?: Job) => {
    const step = episodeRecoveryStep(type)
    if (!step) return
    const params = repairRecoveryNodeParams(
      plan,
      source?.job_id || `${first.job_id}:${step}`,
      input,
      settingsPool,
      settingsSource || source,
    )
    delete params.pipeline_chain
    delete params.subtitle_purchase
    if (source?.status === 'cancelled') params.force = false
    if (step === 'subtitle_sections') {
      if (source) params.subtitle_finalizer_job_id = jq.subtitleFinalizerJobId(source)
      assertSectionScope(params)
      params.force = false
      const missing = source?.result?.missing_sections
      if (params.per_chapter === false) params.sections = ['merged']
      else if (Array.isArray(missing)) {
        params.sections = missing.filter((s: unknown) => typeof s === 'string' && s.trim()
          && (!Array.isArray(input.sections) || input.sections.includes(s)))
      }
    }
    // Every level an Audio Assembly request states is LINEAR GAIN today (`1` = unchanged), because
    // the page and the preset boundary convert their percentages once (`lib/audio-gain.ts`). A
    // recovery replays these saved params RAW, so the node records the unit it was written in: a
    // plan saved before 1.4.361 holds `music.volume: 8` (8%), and replaying that would mix the bed
    // eight times too loud. A level above unity is therefore NOT linear gain this app writes (every
    // attenuation slider's linear maximum is 1), so such a node stays unmarked and dispatch
    // refuses it (`recoveryMergeLevelRefusal`) instead of guessing or squeezing it into range.
    if (step === 'audio_merge' && !percentShapedMusicLevels(params).length) params.level_unit = 'linear'
    plan.steps[step] = { job_id: `recovery-${id}-${step}`, type: step === 'subtitle_sections' ? 'subtitles_transcribe' : step as JobType,
      title, params, ...(source ? { source_job_id: source.job_id } : {}) }
    if (EPISODE_RECOVERY_ORDER.indexOf(step) > EPISODE_RECOVERY_ORDER.indexOf(plan.target)) plan.target = step
  }
  // Oldest first; the most recent explicit row owns its settings, not a stale chain descriptor.
  const sorted = [...jobs].sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const job of sorted) {
    const chain = Array.isArray(job.params?.pipeline_chain) ? job.params.pipeline_chain : []
    const lastRecovery = chain.map((child: { type?: string }) => !!episodeRecoveryStep(child?.type || '')).lastIndexOf(true)
    if (chain.length > lastRecovery + 1) {
      plan.continuation = structuredClone(chain.slice(lastRecovery + 1))
      plan.continuation_job_id = lastRecovery === -1 && job.type === 'subtitles_transcribe' && chain[0]?.type === 'metadata'
        ? jq.subtitleFinalizerJobId(job) : undefined
      plan.continuation_dispatched = !!plan.continuation_job_id && job.params.subtitle_finalizer_dispatched === true
      plan.pipeline_batch_id = job.params.pipeline_batch_id
    }
    for (const child of chain) {
      if (typeof child?.type === 'string') add(child.type, child.title || child.type, child.params || {}, undefined, job)
    }
  }
  for (const job of sorted) add(job.type, job.title, job.params, job)
  // Explicit saved-source selection outranks a newer, unrelated history row.
  for (const job of sorted.filter(row => sourceJobIds.includes(row.job_id))) add(job.type, job.title, job.params, job)
  if (sorted.some(job => job.status === 'cancelled' && sourceJobIds.includes(job.job_id))) {
    // Cancellation retry is recovery, including child descriptors and the tail.
    // Audio's no_overwrite creates a paid new version even when force is false.
    for (const node of [...Object.values(plan.steps), ...(plan.continuation || [])]) {
      const params = node.params ||= {}
      params.force = false
      if ('no_overwrite' in params) params.no_overwrite = false
      if (params.generation_mode === 'regenerate' || params.generation_mode === 'new_version') params.generation_mode = 'skip'
    }
  }
  // Manual Finish/Replace authority belongs to its original action identity.
  // Episode recovery records the blocked edge but cannot clone that authority.
  withholdManualImageFinishFromPlan(plan)
  return plan
}

/** An explicit failed row can widen an older completed plan without minting a second recovery epoch. */
function extendPlanFromSelectedFailures(plan: EpisodeRecoveryPlan, selected: Job[], jobs: Job[]): boolean {
  const failed = selected.filter(job => job.status === 'error')
  if (!failed.length) return false
  const before = JSON.stringify(plan)
  const repaired = failed.map(job => {
    const step = episodeRecoveryStep(job.type)!
    const saved = job.params?.episode_recovery_id === plan.id ? plan.steps[step] : undefined
    let params = saved ? { ...saved.params, ...job.params } : job.params
    // Owner Retry of a terminal scene render is a new deliberate request: the
    // saved action's Gateway key would only replay the job that already failed.
    if (step === 'continuity_render' && params?.generation_action?.kind === 'fresh') {
      params = { ...params, ...stampFreshGenerationAction(params, randomUUID()) }
    }
    return { ...job, params: repairRecoveryNodeParams(plan, job.job_id, params, jobs, saved && {
      job_id: saved.job_id,
      project_slug: plan.project_slug,
      episode_id: plan.episode_id,
      params: saved.params,
    }) }
  })
  const extension = createEpisodeRecoveryPlan(repaired, failed.map(job => job.job_id), jobs)
  if (extension.pipeline_batch_id && plan.pipeline_batch_id && extension.pipeline_batch_id !== plan.pipeline_batch_id) {
    throw new Error('The selected failed job belongs to a different Pipeline run. Retry its saved batch instead of joining two continuations.')
  }
  const firstSelected = Math.min(...failed.map(job => EPISODE_RECOVERY_ORDER.indexOf(episodeRecoveryStep(job.type)!)))
  for (const [step, requested] of Object.entries(extension.steps) as Array<[EpisodeRecoveryStep, RecoveryJob]>) {
    if (EPISODE_RECOVERY_ORDER.indexOf(step) < firstSelected) continue
    const existing = plan.steps[step]
    // An accepted edge owns its durable identity and settings, even if its row is temporarily
    // absent after restart. Explicit Retry must join it rather than create competing work.
    const source = failed.find(job => episodeRecoveryStep(job.type) === step)
    const ownsSource = source?.params?.episode_recovery_id === plan.id
    if (existing?.dispatched) {
      // Except a Scene Plan node bound to a failed row that holds no Gateway children (a retired-model
      // attempt) while the owner retries another failed row of this plan: that row's accepted answers
      // would be missed, so the node follows the selection. Anything with children or still live stays.
      const bound = jobs.find(job => job.job_id === existing.job_id)
      if (step === 'scene_plan_run' && ownsSource && source.job_id !== existing.job_id
        && bound?.status === 'error' && !bound.genstudio_jobs?.length) {
        plan.steps[step] = { ...existing, job_id: source.job_id, source_job_id: source.job_id }
      }
      continue
    }
    plan.steps[step] = {
      ...requested,
      job_id: ownsSource ? source.job_id : existing?.job_id || `recovery-${plan.id}-${step}`,
      ...(ownsSource ? { dispatched: true } : existing?.dispatched ? { dispatched: true } : {}),
    }
  }
  if (EPISODE_RECOVERY_ORDER.indexOf(extension.target) > EPISODE_RECOVERY_ORDER.indexOf(plan.target)) {
    plan.target = extension.target
  }
  plan.pipeline_batch_id ||= extension.pipeline_batch_id
  if (extension.continuation?.length && !plan.continuation_dispatched) {
    plan.continuation = extension.continuation
    plan.continuation_job_id ||= extension.continuation_job_id
  }
  plan.retry_source_job_ids = [...new Set([...(plan.retry_source_job_ids || []), ...failed.map(job => job.job_id)])]
  withholdManualImageFinishFromPlan(plan)
  return JSON.stringify(plan) !== before
}

function matchesSavedParams(job: Job, expected: Job['params']): boolean {
  return Object.entries(expected || {}).every(([key, value]) => isDeepStrictEqual(job.params?.[key], value))
}

function recoveryJobTime(job: Job): number {
  const time = Date.parse(job.finished_at || job.started_at || job.created_at || '')
  return Number.isFinite(time) ? time : Number.NaN
}

/** An explicit audio-only run: forced, and its saved chain deliberately names no later step. */
function explicitAudioOnlyReuse(plan: EpisodeRecoveryPlan, job: Job): boolean {
  const merge = plan.steps.audio_merge
  // The audit also stamps unrelated completed rows with this plan id; only the saved edge proves ownership.
  if (merge?.job_id === job.job_id || merge?.source_job_id === job.job_id) return false
  return job.type === 'audio_merge' && job.status === 'done' && !job.force_abandoned
    && job.params?.force === true
    && Array.isArray(job.params?.pipeline_chain) && job.params.pipeline_chain.length === 0
    && job.episode_id?.toUpperCase() === plan.episode_id.toUpperCase()
}

/**
 * The saved Scene Plan edge's own authority: its source row's creation time, else its earliest
 * non-adopt admission. Automatic adoption receipts are never authority, so a recent audit cannot
 * launder an older edge. Null when legacy data carries no such evidence.
 */
function scenePlanAuthorityTime(plan: EpisodeRecoveryPlan, jobs: Job[]): number | null {
  const sourceId = plan.steps.scene_plan_run?.source_job_id
  const source = sourceId ? jobs.find(job => job.job_id === sourceId) : undefined
  const created = Date.parse(source?.created_at || '')
  if (Number.isFinite(created)) return created
  const admitted = (plan.admission_events || [])
    .filter(event => event.step === 'scene_plan_run' && event.action !== 'adopt')
    .map(event => Date.parse(event.at))
    .filter(time => Number.isFinite(time))
  return admitted.length ? Math.min(...admitted) : null
}

/**
 * A newer forced Audio Assembly with an empty saved chain means the owner reused the episode as-is
 * and did not ask for a new Scene Plan. A saved Scene Plan edge older than it is superseded, and an
 * edge whose legacy admission evidence is missing fails closed rather than guessing (AGENTS.md §4/§6).
 * Explicit owner Retry and a Scene Plan with its own newer source stay valid.
 */
function supersedingAudioOnlyReuse(plan: EpisodeRecoveryPlan, jobs: Job[], automatic: boolean): Job | null {
  if (!automatic || !plan.steps.scene_plan_run) return null
  const reuse = jobs.filter(job => explicitAudioOnlyReuse(plan, job))
    .sort((a, b) => (recoveryJobTime(b) || 0) - (recoveryJobTime(a) || 0))[0]
  if (!reuse) return null
  const reuseAt = recoveryJobTime(reuse)
  const ownerAt = Date.parse(plan.owner_requested_at || '')
  if (Number.isFinite(ownerAt) && (!Number.isFinite(reuseAt) || ownerAt > reuseAt)) return null
  const authority = scenePlanAuthorityTime(plan, jobs)
  return !Number.isFinite(reuseAt) || authority === null || authority < reuseAt ? reuse : null
}

function supersededScenePlanMessage(reuse: Job): string {
  const when = reuse.finished_at || reuse.started_at || reuse.created_at || 'later'
  return `Scene Plan was not re-queued: Audio Assembly ${reuse.job_id} finished later (${when}) and ran Audio Assembly only, `
    + 'without a new Scene Plan, so this saved step may be out of date. '
    + 'Open Jobs and use Retry on Scene Plan if you want it run again.'
}

/** Re-audit the prefix, never trust old completion after inputs changed. */
export function nextEpisodeRecoveryStep(plan: EpisodeRecoveryPlan, verified: Record<EpisodeRecoveryStep, boolean>): EpisodeRecoveryStep | null {
  plan.completed = []
  for (const step of EPISODE_RECOVERY_ORDER) {
    if (EPISODE_RECOVERY_ORDER.indexOf(step) > EPISODE_RECOVERY_ORDER.indexOf(plan.target)) break
    if (!verified[step]) return plan.first_unresolved = step
    plan.completed.push(step)
  }
  return plan.first_unresolved = null
}

const labels: Record<EpisodeRecoveryStep, string> = {
  audio_merge: 'Audio Assembly', subtitle_sections: 'subtitle sections', subtitle_stitch: 'subtitle stitch',
  scene_plan_run: 'Scene Plan', contextual_cues: 'Contextual Cues', continuity_render: 'Scene Review',
}

/**
 * Read real source cues, not merely non-empty filenames or a stale derivative. With the audio
 * folder, a section whose SRT was made from audio that has since changed (re-narrated) is missing
 * too: the stitch refuses it, so counting it complete parked recovery at "subtitle stitch" forever.
 */
export async function inspectRecoverySubtitles(episodeDir: string, subtitlesDir: string, code: string, perChapter = true, audioDir?: string) {
  if (!perChapter) {
    const cues = parseSrt(await fs.readFile(path.join(subtitlesDir, `${code.toUpperCase()}_whisper.srt`), 'utf8').catch(() => ''))
    const complete = cues.some(cue => cue.text.trim() && cue.end_sec > cue.start_sec)
    return { expected: ['merged'], missing: complete ? [] : ['merged'], complete }
  }
  const stitch = await readStitchPlan(episodeDir, subtitlesDir, code)
  if (!stitch.ok) return { expected: [] as string[], missing: [] as string[], complete: false }
  const missing: string[] = []
  for (const section of stitch.matched) {
    const cues = section.source_srt
      ? parseSrt(await fs.readFile(path.join(subtitlesDir, section.source_srt), 'utf8').catch(() => '')) : []
    if (!cues.some(cue => cue.text.trim() && cue.end_sec > cue.start_sec)) missing.push(section.slug)
  }
  if (audioDir) {
    const { stale_sections } = await inspectSubtitleSourceFreshness(episodeDir, audioDir, subtitlesDir, code)
    for (const slug of stale_sections) if (!missing.includes(slug)) missing.push(slug)
  }
  return { expected: stitch.sections.map(section => section.slug), missing, complete: stitch.sections.length > 0 && missing.length === 0 }
}

/** Safe local repair, followed by proof of the actual written timeline. */
export async function ensureRecoveryStitch(options: EnsureStitchedOptions): Promise<boolean> {
  if (!(await inspectRecoverySubtitles(options.episodeDir, options.subtitlesDir, options.episodeCode, true, options.audioDir)).complete) return false
  let outcome = await ensureStitchedSubtitle(options)
  if (!['fresh', 'stitched'].includes(outcome.status) || !outcome.path) return false
  if (await verifyWrittenSubtitleTimeline(options.subtitlesDir, options.episodeCode)) return true
  outcome = await ensureStitchedSubtitle({ ...options, force: true })
  return outcome.status === 'stitched' && await verifyWrittenSubtitleTimeline(options.subtitlesDir, options.episodeCode)
}

export async function inspectRecoverySubtitlePrerequisites(plan: EpisodeRecoveryPlan, paths: EnsureStitchedOptions, jobs: Job[]) {
  const verified = Object.fromEntries(EPISODE_RECOVERY_ORDER.map(step => [step, false])) as Record<EpisodeRecoveryStep, boolean>
  verified.audio_merge = true // The caller establishes Audio Assembly before inspecting subtitles.
  const subtitleParams = plan.steps.subtitle_sections?.params
  const wholeTrack = subtitleParams?.per_chapter === false
  const coverage = await inspectRecoverySubtitles(paths.episodeDir, paths.subtitlesDir, plan.episode_id, !wholeTrack, paths.audioDir)
  // A fresh action promises new artifacts for its saved scope. Existing SRTs
  // can prove an ordinary recovery, but cannot turn a failed fresh request into
  // a completed episode.
  const normalize = (value: string) => value.trim().toLowerCase()
  const expectedByKey = new Map(coverage.expected.map(section => [normalize(section), section]))
  const requestedScope = subtitleParams?.generation_action?.kind === 'fresh'
    ? Array.isArray(subtitleParams.sections) && subtitleParams.sections.length
      ? subtitleParams.sections.filter((section: unknown): section is string => typeof section === 'string' && !!section.trim())
      : coverage.expected
    : []
  const freshScope = Array.from(new Set(requestedScope.map(section => expectedByKey.get(normalize(section))).filter((section): section is string => !!section)))
  const unknownFreshScope = requestedScope.filter(section => !expectedByKey.has(normalize(section)))
  const actionId = typeof subtitleParams?.generation_action?.id === 'string'
    ? subtitleParams.generation_action.id.trim()
    : ''
  const matchingActionJob = (jobId: string | undefined) => jobId && actionId ? jobs.find(row => row.job_id === jobId
    && row.type === 'subtitles_transcribe'
    && row.params?.generation_action?.kind === 'fresh'
    && row.params.generation_action.id === actionId) : undefined
  const sourceActionJob = matchingActionJob(plan.steps.subtitle_sections?.source_job_id)
  const recoveryActionJob = matchingActionJob(plan.steps.subtitle_sections?.job_id)
  const latestActionJob = recoveryActionJob || sourceActionJob
  // A crash can preserve a raw artifact state before the retry writes a final
  // result. Keep the saved source's failed sections until this exact retry has
  // supplied its own terminal result.
  const latestResultJob = recoveryActionJob?.result ? recoveryActionJob : sourceActionJob
  const states = new Map<string, { state?: string }>()
  for (const record of [subtitleParams?.subtitle_recovery?.sections, sourceActionJob?.params?.subtitle_recovery?.sections, recoveryActionJob?.params?.subtitle_recovery?.sections]) {
    for (const [section, state] of Object.entries(record || {})) states.set(normalize(section), state as { state?: string })
  }
  const latestMissing = new Set((latestResultJob?.result?.missing_sections || [])
    .filter((section: unknown): section is string => typeof section === 'string')
    .map(normalize))
  const successfulScope = new Set<string>()
  const addSuccessfulScope = (job: Job) => {
    if (job.result?.complete !== true) return
    const scoped = Array.isArray(job.params?.sections) && job.params.sections.length
      ? job.params.sections.filter((section: unknown): section is string => typeof section === 'string' && !!section.trim())
      : coverage.expected
    for (const section of scoped) {
      const canonical = expectedByKey.get(normalize(section))
      if (canonical) successfulScope.add(normalize(canonical))
    }
  }
  if (latestActionJob) addSuccessfulScope(latestActionJob)
  // A later, independently stamped fresh action may replace this failed one.
  // It must be finished, prove a complete result, and postdate the saved source;
  // no result from the old provider request is reclassified as successful.
  const sourceTime = Date.parse(sourceActionJob?.created_at || '')
  if (Number.isFinite(sourceTime)) {
    for (const job of jobs) {
      if (job.type !== 'subtitles_transcribe' || job.status !== 'done'
        || job.params?.generation_action?.kind !== 'fresh'
        || job.params.generation_action.id === actionId
        || !Number.isFinite(Date.parse(job.created_at)) || Date.parse(job.created_at) < sourceTime) continue
      addSuccessfulScope(job)
    }
  }
  const freshMissing = [
    ...unknownFreshScope,
    ...freshScope.filter(section => {
      const key = normalize(section)
      if (successfulScope.has(key)) return false
      // A whole-track recovery has no per-section writer after raw fetch. Its
      // final result is the only completion proof, so a raw recovery state is
      // never enough to release the edge.
      if (wholeTrack) return true
      return latestMissing.has(key) || states.get(key)?.state !== 'artifact_recovered'
    }),
  ]
  const missing = Array.from(new Set([...coverage.missing, ...freshMissing]))
  verified.subtitle_sections = coverage.complete && freshMissing.length === 0
  const readySections = coverage.expected.filter(section => !missing.some(item => normalize(item) === normalize(section))).length
  const sectionMessage = `${readySections}/${coverage.expected.length} ${wholeTrack ? 'whole track' : 'sections'} ready`
  if (!verified.subtitle_sections) return { verified, message: sectionMessage, missing }
  // Never race a still-running transcription's source writes.
  if (jobs.some(job => job.type === 'subtitles_transcribe' && ['queued', 'running', 'paused'].includes(job.status))) {
    return { verified, message: `${sectionMessage}. Scene Plan waiting for subtitle stitch.` }
  }
  if (wholeTrack && plan.target === 'subtitle_stitch') {
    verified.subtitle_stitch = true // Whole-track transcription has no chapter-stitch edge.
    return { verified, message: sectionMessage }
  }
  try {
    verified.subtitle_stitch = await ensureRecoveryStitch(paths)
  } catch (error) {
    return { verified, message: `Scene Plan waiting for subtitle stitch: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!verified.subtitle_stitch) return { verified, message: wholeTrack
    ? `${sectionMessage}. Whole-track transcription is complete. Scene Plan requires a verified per-section subtitle stitch; no chapter transcription was started.`
    : `${sectionMessage}. Scene Plan waiting for subtitle stitch.` }
  return { verified, message: sectionMessage }
}

async function inspectRecovery(plan: EpisodeRecoveryPlan, jobs: Job[]) {
  const unresolved = Object.fromEntries(EPISODE_RECOVERY_ORDER.map(step => [step, false])) as Record<EpisodeRecoveryStep, boolean>
  if (jobs.some(job => job.type === 'audio_merge' && ['queued', 'running', 'paused'].includes(job.status))) {
    return { verified: unresolved, message: 'Waiting for the active Audio Assembly job.' }
  }
  // A chapter repair needs Audio Assembly only while the saved merge is NOT current: the readiness
  // audit already refuses a missing, unfinished, stale (a chapter changed under it) or rejected
  // merge. A plan left holding an undispatched node after a good merge — the owner ran Audio
  // Assembly from its page, or Clear Finished pruned the job the node named — was re-merging
  // finished, accepted episodes on every boot (AWBU EP0001/2/3/5, night-atlas-science EP0012,
  // 2026-10-27). Let the audit verify audio_merge and the plan complete instead.
  //
  // A narration job that is still going keeps the old wait: its chapters land one at a time, so the
  // merge can look current right up to the moment the next chapter replaces one under it.
  const audio = await inspectAudioAssemblyReadiness(plan.project_slug, plan.episode_id)
  const narrationInFlight = jobs.some(job => job.type === 'audio' && job.episode_id === plan.episode_id
    && ['queued', 'running', 'paused'].includes(job.status))
  if (plan.narration_refresh_job_ids?.length && !plan.steps.audio_merge?.dispatched && (!audio.audio_assembly_ready || narrationInFlight)) {
    return { verified: unresolved, message: 'Chapter repair requires Audio Assembly with the saved mix settings' }
  }
  if (!audio.audio_assembly_ready) return { verified: unresolved, message: audio.issues.join(' ') }
  const paths = await resolveEpisodePathsByCode(plan.project_slug, plan.episode_id)
  const facts = await inspectRecoverySubtitlePrerequisites(plan, { episodeDir: paths.episode_dir, subtitlesDir: paths.subtitles_dir,
    mergedAudioDir: paths.merged_audio_dir, audioDir: paths.audio_dir, episodeCode: plan.episode_id }, jobs)
  const { verified } = facts
  if (!verified.subtitle_stitch || plan.target === 'subtitle_stitch') return facts
  const status = await computeEpisodeStatus(plan.project_slug, plan.episode_id)
  const scenePlanPath = await resolveScenePlanPath(plan.project_slug, plan.episode_id, paths.episode_dir)
  // v1.4.314 — the same merged-track choice the stitcher and renderer use: the
  // owner's pin when he made one, else the base-track rule. A pin that no longer
  // names a real track is NOT ready: the drift check must not fall back to the
  // completion record (which may describe a different track) and claim the plan is
  // verified. The render refuses an invalid pin too.
  const mergedChoice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, plan.episode_id)
  const expectedMerged = expectedMergedAudioFilename(mergedChoice, plan.episode_id)
  const drift = expectedMerged.ok
    ? await inspectPlanTimelineDrift(scenePlanPath, path.join(paths.subtitles_dir, `${plan.episode_id.toUpperCase()}_stitched.srt`),
        path.join(paths.merged_audio_dir, `${plan.episode_id.toUpperCase()}_merged_audio.completion.json`),
        expectedMerged.filename)
    : { stale: true, drift_sec: null, reason: '' }
  verified.scene_plan_run = status.scene_plan && !drift.stale
  // A Scene Plan that cannot be verified must say WHICH timeline moved, or which saved merged track
  // is missing: "Waiting for Scene Plan" alone sent Domnak DM0012/13/14 to a person who had nothing
  // to act on. Appended, so the subtitle coverage the audit proved is not lost. Exported for its own
  // test, like `subtitleStatesMessage`.
  if (!verified.scene_plan_run) facts.message += `. ${scenePlanBlockerMessage(status.scene_plan === true, expectedMerged, drift)}`
  verified.contextual_cues = status.contextual_cues === true
    && (!plan.steps.contextual_cues || status.contextual_cues_generated === true)
  verified.continuity_render = status.scene_review
  return facts
}

/**
 * Why Scene Plan is unverified, in the plan's own words: what is missing and what re-running it
 * rebuilds. Every branch names something a person (or the plan's own next dispatch) can act on.
 */
export function scenePlanBlockerMessage(
  scenePlanDone: boolean,
  merged: { ok: boolean; pinned?: string | null; filename?: string | null },
  drift: TimelineDrift,
): string {
  if (!merged.ok) return `The saved merged-audio choice names ${merged.pinned}, which is not in this episode's merged-audio folder. `
    + 'Pick the track this episode uses (or clear the choice); Scene Plan is checked against that track.'
  if (drift.stale) return `Scene Plan is stale: ${drift.reason} Rebuilding Scene Plan is what re-times every scene against the current narration.`
  if (!scenePlanDone) return 'Scene Plan has not been run for this episode.'
  return 'Scene Plan could not be verified from its saved plan.'
}

interface RecoveryStore { version: 1; plans: Record<string, EpisodeRecoveryPlan>; retired_plans?: Record<string, EpisodeRecoveryPlan> }

const ACCEPTED_FINAL_GUARD_MESSAGE = 'This episode already has an accepted final video, so automatic recovery left it alone. '
  + 'Use Retry to redo a step on purpose.'

export async function dispatchEpisodeRecoveryStep(
  plan: EpisodeRecoveryPlan,
  facts: { verified: Record<EpisodeRecoveryStep, boolean>; message: string; missing?: string[] },
  jobs: Job[],
  sourceJobIds: string[] = [],
  admissionSource: RecoveryAdmissionSource = 'completion',
  observedJobIds: string[] = [],
): Promise<void> {
  // Older persisted plans may predate the withheld marker. Scrub their copied
  // nonce before considering any resume or enqueue path, and retain the marker
  // so later restarts remain a deliberate Scene Review handoff.
  withholdManualImageFinishFromPlan(plan)
  const verified = { ...facts.verified }
  const cancelled = jobs.find(job => job.params?.episode_recovery_id === plan.id && (job.status === 'cancelled' || job.force_abandoned))
  if (cancelled) {
    plan.first_unresolved = episodeRecoveryStep(cancelled.type)
    plan.message = 'Episode recovery stopped after cancellation. Use Retry to start a new recovery plan from the cancelled job.'
    return
  }
  for (const job of jobs) {
    const step = episodeRecoveryStep(job.type)
    if (step && ['queued', 'running', 'paused'].includes(job.status)) verified[step] = false
  }
  // A `dispatched` node can outlive the job it names: Clear Finished and a per-job Delete remove
  // terminal rows, and nothing else clears the flag. When the step's own artifacts already prove
  // the edge complete, the node is not an accepted edge — it is a record of a job that no longer
  // exists, so it stops holding the plan open (and stops refusing the step's next dispatch).
  for (const step of EPISODE_RECOVERY_ORDER) {
    const node = plan.steps[step]
    if (!node?.dispatched || !verified[step]) continue
    if (!jobs.some(job => job.job_id === node.job_id)) node.dispatched = false
  }
  // A step the channel's own settings switch off is SKIPPED, not waited for
  // (AGENTS.md §8). `inspectRecovery` can never verify it — there is no cue
  // timeline, and there will not be one while the feature is off — so without
  // this the plan sits on "Waiting for Contextual Cues" forever, or enqueues the
  // step only to watch its generator refuse. Dropping it is what lets Scene
  // Review and everything after it proceed. Re-enabling the step puts it back in
  // the plan the next time one is built.
  for (const optionalStep of EPISODE_RECOVERY_ORDER) {
    if (!plan.steps[optionalStep]) continue
    if (!disabledOptionalStepReason(plan.project_slug, optionalStep)) continue
    delete plan.steps[optionalStep]
    if (plan.continuation) plan.continuation = plan.continuation.filter(node => node.type !== optionalStep)
    verified[optionalStep] = true
  }
  if (!verified.audio_merge && await waitForNarrationRefreshChecks(plan, jobs, sourceJobIds, admissionSource)) {
    plan.completed = []
    plan.first_unresolved = 'audio_merge'
    return
  }
  // 1.4.413 — a saved chat model the live catalogue no longer publishes used to
  // surface at the step that needs it. Scene Plan comes after Audio Assembly and
  // transcription in this order, so an episode could spend hours re-doing them
  // and then fail on a model that was already known to be gone. Refuse the plan
  // HERE, before any step is dispatched, and say which model and where to pick a
  // current one. `findLiveChatModel` returns `undefined` when the Gateway could
  // not be read — an outage, not a missing product — and the plan proceeds then.
  const scenePlanNode = plan.steps.scene_plan_run
  if (scenePlanNode && !verified.scene_plan_run
    && !jobs.some(job => job.type === 'scene_plan_run' && ['queued', 'running', 'paused'].includes(job.status))) {
    const savedChatModel = scenePlanNode.params?.model
    if (typeof savedChatModel === 'string' && savedChatModel.trim()
      && await findLiveChatModel(savedChatModel) === null) {
      plan.first_unresolved = 'scene_plan_run'
      plan.message = `${savedChatModelGoneMessage(savedChatModel)} Episode recovery stopped before re-running earlier steps.`
      return
    }
  }
  const step = nextEpisodeRecoveryStep(plan, verified)
  plan.message = step ? `${facts.message}. Waiting for ${labels[step]}.` : 'Episode recovery complete.'
  if (step && EPISODE_RECOVERY_ORDER.indexOf(step) >= EPISODE_RECOVERY_ORDER.indexOf('scene_plan_run')) {
    const reuse = supersedingAudioOnlyReuse(plan, jobs, admissionSource !== 'owner' && sourceJobIds.length === 0)
    if (reuse) {
      plan.completed = plan.completed.filter(item => EPISODE_RECOVERY_ORDER.indexOf(item) < EPISODE_RECOVERY_ORDER.indexOf('scene_plan_run'))
      plan.first_unresolved = 'scene_plan_run'
      plan.message = supersededScenePlanMessage(reuse)
      return
    }
  }
  if (!step) {
    if (plan.continuation_job_id && jobs.some(job => jq.subtitleFinalizerJobId(job) === plan.continuation_job_id
      && job.params.subtitle_finalizer_dispatched === true)) plan.continuation_dispatched = true
    if (plan.continuation?.length && !plan.continuation_dispatched) {
      if (plan.continuation.some(node => node.manual_image_finish_withheld)) {
        plan.message = MANUAL_IMAGE_FINISH_GUIDANCE
        return
      }
      const [next, ...rest] = plan.continuation
      const expected = { ...next.params, episode_id: plan.episode_id, pipeline_chain: rest,
        ...(plan.pipeline_batch_id ? { pipeline_batch_id: plan.pipeline_batch_id } : {}) }
      const continuationJobId = plan.continuation_job_id || `recovery-${plan.id}-continuation`
      const activeTail = jobs.filter(job => job.type === next.type
        && ['queued', 'running', 'paused'].includes(job.status))
      // 1.4.312 — a crash between enqueueing this continuation and saving the plan leaves the job
      // this plan started in place under its deterministic id, while `expected` is still the plan's
      // pre-refresh snapshot, so the settings check above no longer matches the job it created. That
      // id is this plan's own identity for the edge — `enqueueEpisodeRecoveryOnce` refuses an id
      // whose project, episode or type differ — so the job it names IS this continuation. Adopting
      // it closes the window without loosening the settings check for any other job.
      const compatible = activeTail.find(job => matchesSavedParams(job, expected))
        ?? activeTail.find(job => job.job_id === continuationJobId)
      if (compatible) {
        plan.continuation_job_id = compatible.job_id
        plan.continuation_dispatched = true
        recordRecoveryAdmission(plan, 'continuation', 'adopt', admissionSource, compatible.job_id, sourceJobIds)
        return
      }
      if (activeTail.length) {
        plan.message = `An accepted ${next.type} job already owns different saved settings; Story kept it and did not queue competing work.`
        return
      }
      // 1.4.312 — Final Video is resolved from the channel's CURRENT Video Assembly preset when its
      // job is actually submitted, so a look applied after the batch was submitted still reaches
      // this render. `expected` above stays the plan's accepted snapshot, for the compatibility
      // check; only what is enqueued is resolved afresh.
      const enqueueParams = next.type === 'video_assembly'
        ? await jq.withCurrentFinalVideoParams(plan.project_slug, plan.episode_id, expected)
        : expected
      await jq.enqueueEpisodeRecoveryOnce(continuationJobId, {
        project_slug: plan.project_slug, episode_id: plan.episode_id, type: next.type, title: next.title,
        params: enqueueParams,
      })
      plan.continuation_dispatched = true
      recordRecoveryAdmission(plan, 'continuation', 'enqueue', admissionSource, continuationJobId, sourceJobIds)
    }
    return
  }
  if (step === 'subtitle_stitch') return
  // Narration for this episode is still being made or replaced. Assembling now
  // would mix old and new chapter takes and be stale the moment the narration
  // job saves its next chapter; the 30-second recheck resumes this edge once it
  // has finished.
  if (step === 'audio_merge' && jobs.some(job => job.type === 'audio' && job.episode_id === plan.episode_id
    && ['queued', 'running', 'paused'].includes(job.status))) {
    plan.message = 'Waiting for narration to finish before Audio Assembly.'
    return
  }
  const node = plan.steps[step]
  const admissionSourceIds = [...new Set([...sourceJobIds, ...observedJobIds, ...(node?.source_job_id ? [node.source_job_id] : [])])]
  const type = step === 'subtitle_sections' ? 'subtitles_transcribe' : step
  const activeSameStep = jobs.filter(job => job.type === type && ['queued', 'running', 'paused'].includes(job.status))
  const ownedActive = node?.dispatched ? activeSameStep.find(job => job.job_id === node.job_id) : undefined
  const active = ownedActive || (node ? activeSameStep.find(job =>
    (!plan.pipeline_batch_id || job.params?.pipeline_batch_id === plan.pipeline_batch_id)
    && matchesSavedParams(job, node.params)) : activeSameStep[0])
  if (!active && activeSameStep.length) {
    plan.message = `An accepted ${labels[step]} job already owns different saved settings; Story kept it and did not queue competing work.`
    return
  }
  // Its earlier transcription finished, yet sections are missing again: the audio changed under
  // them (re-narrated). Transcribe those sections once more under a new identity — once, so a
  // section that stays stale cannot loop.
  if (!active && step === 'subtitle_sections' && node && !node.stale_redispatched
    && jobs.some(job => job.job_id === node.job_id && job.status === 'done')) {
    node.job_id = `${node.job_id}-audio-changed`
    node.dispatched = false
    node.stale_redispatched = true
  }
  const existing = active || (node && jobs.find(job => job.job_id === node.job_id))
  if (active && node) {
    node.job_id = active.job_id
    node.dispatched = true
    recordRecoveryAdmission(plan, step, 'adopt', admissionSource, active.job_id, admissionSourceIds)
  }
  if (node && withholdManualImageFinish(node)) {
    plan.message = MANUAL_IMAGE_FINISH_GUIDANCE
    return
  }
  // A saved merge whose levels predate linear gain is neither queued nor resumed: the job would
  // replay the same percentages. A merge already running cannot be stopped, and one already done
  // is audited on its artifacts, so only new or resumed work is refused (AGENTS.md §6).
  const mergeRefusal = step === 'audio_merge' && node && (!existing || existing.status === 'error')
    ? recoveryMergeLevelRefusal(node.params, plan.episode_id) : null
  if (mergeRefusal) { plan.message = mergeRefusal; return }
  if (existing) {
    if (step === 'continuity_render' && existing.params?.manual_image_finish) {
      plan.message = MANUAL_IMAGE_FINISH_GUIDANCE
      return
    }
    plan.message = subtitleStatesMessage(existing.params?.subtitle_recovery?.sections) || existing.error || plan.message
    if (existing.status === 'error' && sourceJobIds.length) {
      if (node) {
        const restored = Object.entries(node.params || {}).filter(([key, value]) => value !== CIRCULAR_MARKER
          && (existing.params?.[key] === undefined || existing.params[key] === CIRCULAR_MARKER))
        if (restored.length) await jq.mutateAuthoritativeJob(plan.project_slug, existing.job_id, current => ({
          ...current,
          params: Object.fromEntries([...Object.entries(current.params || {}), ...restored.map(([key, value]) => [key, structuredClone(value)])]),
        }))
      }
      await jq.resumeEpisodeRecoveryJob(existing.job_id, true)
      recordRecoveryAdmission(plan, step, 'resume', 'owner', existing.job_id, admissionSourceIds)
    } else if (step === 'subtitle_sections') await continueFailedSubtitleCheck(plan, existing, false, admissionSource)
    return
  }
  if (!node) { plan.message += ` Open ${labels[step]} to complete or configure this prerequisite.`; return }
  // The job this edge was dispatched as is gone from the queue history (Clear Finished / Delete
  // prune terminal rows), and the artifacts above say its output is not complete. Its outcome is
  // unknown, not still running, so re-enqueue that same edge ONCE, under its own identity and saved
  // params — the accepted image identities in `genstudio_recovery` ride along, so nothing already
  // generated is paid for twice. A second loss parks the plan with the handoff below rather than
  // rebuilding in a loop.
  if (node.dispatched) {
    if (node.redispatched) { plan.message += ' This edge was already dispatched; review its saved result before starting new work.'; return }
    node.redispatched = true
    node.dispatched = false
  }
  // Free Up Space removed this episode's media on purpose (it was already uploaded). That is not
  // missing work: only an owner request made after the cleanup may rebuild it, never a restart sweep.
  const cleanup = await readLocalMediaCleanupStatus(plan.project_slug, plan.episode_id)
  if ((cleanup.has_retired_media || cleanup.blocked_reason)
    && !(Date.parse(plan.owner_requested_at || '') > (Date.parse(cleanup.updated_at || '') || 0))) {
    plan.message = 'Free Up Space removed this episode\'s media on purpose, so Story will not rebuild it on its own. Retry it yourself if you want it back.'
    return
  }
  const params: Job['params'] = { ...node.params, episode_id: plan.episode_id, episode_recovery_id: plan.id }
  // A DELIBERATE fresh redo must carry a NEW request identity, or it asks the Gateway for the very
  // key it is stuck on. Scene Plan's chat key is derived from the request content
  // (`genstudio-chat-<sha256>`), so a retry that re-sends the same scenes replays the dead hold
  // forever and re-parks on "Checking the earlier prompt request" (Production 2026-11-17: ten
  // episodes, 45 minutes each, and run-batch did not escape it either — it sends no fresh action,
  // so its key was byte-identical). Stamping a `generation_action` of kind `fresh` changes the
  // identity and nothing else: the collect pass still reads every accepted answer back by its
  // saved key before any new request goes out, so nothing already paid for is asked for twice.
  if (step === 'scene_plan_run' && admissionSource === 'owner') {
    Object.assign(params, stampFreshGenerationAction(params, randomUUID()))
  }
  if (step === 'subtitle_sections') {
    assertSectionScope(node.params)
    params.sections = (facts.missing || []).filter(section => !Array.isArray(node.params.sections) || node.params.sections.includes(section))
    if (!params.sections.length) throw new Error('Missing subtitle sections are outside the saved recovery scope. Select those sections explicitly in Subtitles.')
    params.subtitle_recovery_plan_id ||= plan.id
  }
  // A new Scene Plan row inherits what the failed one holds: its accepted answers (collected first)
  // and the keys it already refused, which a fresh row would otherwise replay.
  const previous = step === 'scene_plan_run'
    ? jobs.find(job => job.job_id === node.source_job_id) ?? jq.getJob(node.source_job_id || '')
    : undefined
  await jq.enqueueEpisodeRecoveryOnce(node.job_id, { project_slug: plan.project_slug, episode_id: plan.episode_id,
    type: node.type, title: node.title, params: previous ? withSavedPromptCollection(params, previous) : params,
    ...(previous?.rejected_idempotency_keys?.length ? { rejected_idempotency_keys: previous.rejected_idempotency_keys } : {}) })
  node.dispatched = true
  recordRecoveryAdmission(plan, step, 'enqueue', admissionSource, node.job_id, admissionSourceIds)
  plan.message = step === 'subtitle_sections' ? `${facts.message}. Recovering existing subtitle task (free).`
    : node.redispatched ? `${labels[step]} re-queued once: the job this edge was dispatched as is no longer in the queue history.`
    : `${labels[step]} queued after verified prerequisites.`
}

async function readPlans(file: string): Promise<RecoveryStore> {
  try {
    const store = JSON.parse(await fs.readFile(file, 'utf8')) as RecoveryStore
    if (store.version !== 1 || !store.plans || Array.isArray(store.plans)
      || Object.entries(store.plans).some(([code, plan]) => !plan || plan.version !== 1 || !plan.id
        || plan.episode_id !== code || !plan.steps || !Array.isArray(plan.completed)
        || !EPISODE_RECOVERY_ORDER.includes(plan.target))) throw new Error('Invalid episode recovery record. Restore its saved identity before retrying.')
    return store
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, plans: {} }
    throw error
  }
}

const UNVERIFIED_REFRESH_SOURCE = 'Narration refresh source could not be verified. Its saved parent identity and chapter source evidence are required before Audio Assembly; missing history is not completion.'

/** Report queue evidence, rather than treating an HTTP 202 as a dispatched job. */
export function episodeRecoveryDispatch(plan: EpisodeRecoveryPlan, jobs: Job[]) {
  const jobId = plan.first_unresolved
    ? plan.steps[plan.first_unresolved]?.job_id
    : plan.continuation_job_id || `recovery-${plan.id}-continuation`
  const job = jobs.find(row => row.job_id === jobId && row.project_slug === plan.project_slug && row.episode_id === plan.episode_id)
  if (job && (job.status === 'queued' || job.status === 'running' || job.status === 'paused')) {
    return { dispatch_status: job.status, dispatch_job_id: job.job_id }
  }
  const complete = plan.first_unresolved === null
    && (!plan.continuation?.length || (plan.continuation_dispatched && job?.status === 'done'))
  return { dispatch_status: complete ? 'complete' as const : 'blocked' as const }
}

const RETIRED_PLANS_SHOWN = 5

/**
 * What the saved plan(s) for one episode say, for a person to read. Never creates, repairs, saves or
 * dispatches anything (`recoverEpisode` can do all four, even with `create` false). Null when no plan
 * is saved. Bounded: the current plan, at most the last few retired ones, six nodes each.
 */
export async function readEpisodeRecoveryPlans(projectSlug: string, episodeId: string) {
  const projectDir = getProjectDir(projectSlug)
  if (!projectDir) throw new Error('Project not found.')
  const store = await readPlans(path.join(projectDir, 'episode-recovery-plans.json'))
  const code = episodeId.toUpperCase()
  const current = store.plans[episodeId] ?? store.plans[code]
  const retired = Object.values(store.retired_plans || {}).filter(plan => plan.episode_id?.toUpperCase() === code).slice(-RETIRED_PLANS_SHOWN)
  if (!current && !retired.length) return null
  const jobs = await jq.findJobs(projectSlug, job => job.episode_id?.toUpperCase() === code)
  const summarize = (plan: EpisodeRecoveryPlan, isCurrent: boolean) => ({
    id: plan.id,
    current: isCurrent,
    target: plan.target,
    first_unresolved: plan.first_unresolved,
    completed: plan.completed,
    message: plan.message.slice(0, 500),
    ...(isCurrent ? episodeRecoveryDispatch(plan, jobs) : {}),
    owner_requested_at: plan.owner_requested_at ?? null,
    pipeline_batch_id: plan.pipeline_batch_id ?? null,
    retry_source_job_ids: (plan.retry_source_job_ids || []).slice(-20),
    admission_events: plan.admission_events ?? [],
    steps: EPISODE_RECOVERY_ORDER.filter(step => plan.steps[step]).map(step => {
      const node = plan.steps[step]!
      return {
        step,
        job_id: node.job_id,
        source_job_id: node.source_job_id ?? null,
        dispatched: node.dispatched === true,
        status: jobs.find(job => job.job_id === node.job_id)?.status ?? 'missing',
      }
    }),
  })
  return { project_slug: projectSlug, episode_id: current?.episode_id ?? retired[0]!.episode_id,
    plans: [...(current ? [summarize(current, true)] : []), ...retired.reverse().map(plan => summarize(plan, false))] }
}

/** Serialize an episode's decisions; share the file lock only while saving records. */
export async function recoverEpisode(projectSlug: string, episodeId: string, create = true, sourceJobIds: string[] = [], observedJobs: Job[] = [], ownerRequest = false, origin?: RecoveryAdmissionSource): Promise<(EpisodeRecoveryPlan & { dispatch_status: 'queued' | 'running' | 'paused' | 'blocked' | 'complete'; dispatch_job_id?: string }) | null> {
  const projectDir = getProjectDir(projectSlug)
  if (!projectDir) throw new Error('Project not found.')
  const admissionSource: RecoveryAdmissionSource = ownerRequest ? 'owner' : origin || 'completion'
  await jq.findJobs(projectSlug, () => false) // hydrate only
  const file = path.join(projectDir, 'episode-recovery-plans.json')
  return withLock(`${file}:${episodeId}`, async () => {
    const currentJobs = async () => {
      const current = await jq.findJobs(projectSlug, job => job.episode_id === episodeId)
      // Completion events are server-owned snapshots. Keep terminal evidence
      // for this pass when Clear Finished wins the race with the file audit.
      for (const job of observedJobs) if (job.project_slug === projectSlug && job.episode_id === episodeId
        && ['done', 'error'].includes(job.status) && !current.some(row => row.job_id === job.job_id)) current.push(job)
      return current
    }
    let jobs = await currentJobs()
    const selected = sourceJobIds.map(id => jobs.find(job => job.job_id === id))
    const plan = await withLock(file, async () => {
      const store = await readPlans(file)
      let plan = store.plans[episodeId]
      if (plan && repairEpisodeRecoveryPlanParams(plan, jobs)) await writeJsonAtomic(file, store)
      // An ABANDONED row is an owner's deliberate stop, not a row to refuse: its own log promises
      // "Retry on this row starts it fresh", so Retry has to mean that. Refusing here was the third
      // half of the 2026-11-17 report — a control that exists and does nothing, on a row the app had
      // just told the owner to press it on.
      if (selected.some(job => !job || !episodeRecoveryStep(job.type)
        || (!['error', 'cancelled'].includes(job.status)
          && !Object.values(plan?.steps || {}).some(node => node.job_id === job.job_id)))) throw new Error('Recovery source must be an owned failed or cancelled episode job.')
      let planDirty = false
      // Explicit cancellation (including an abandon, which ends the row `cancelled`) and a new
      // server-stamped narration refresh own new identities.
      const newCancellationIntent = selected.some(job => (job!.status === 'cancelled' || job!.force_abandoned)
        && !plan?.retry_source_job_ids?.includes(job!.job_id))
      // The repair Assembly reuses the owner's last ordinary mix: a finished merge, never a
      // quality-refresh merge (its marker would replay that old action).
      const priorMerge = jobs.filter(job => job.type === 'audio_merge' && job.status === 'done' && !job.force_abandoned
        && !job.params?.audio_quality_refresh)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
      const completedMerge = jobs.filter(job => job.type === 'audio_merge' && job.status === 'done')
        .sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
      const mergedSourceTime = Date.parse(completedMerge?.started_at || completedMerge?.created_at || '')
      const refreshIds = [...new Set(narrationRefreshChecks(jobs).filter(check => {
        return !Number.isFinite(mergedSourceTime) || Date.parse(savedNarrationSource(check, jobs)!) > mergedSourceTime
      }).map(check => check.params.narration_refresh_job_id as string))]
      const newRefreshIds = refreshIds.filter(id => !plan?.narration_refresh_job_ids?.includes(id))
      const mergeNode = plan?.steps.audio_merge
      const mergeJob = mergeNode && jobs.find(job => job.job_id === mergeNode.job_id)
      // Missing accepted identities have an unknown outcome, not permission to duplicate them.
      const ownsAcceptedMerge = !!mergeNode?.dispatched && ((!mergeJob && !plan?.completed.includes('audio_merge')) || !!mergeJob && ['queued', 'running', 'paused'].includes(mergeJob.status))
      const unverifiedCheck = !newCancellationIntent && !ownsAcceptedMerge && jobs.find(job => job.type === 'subtitles_transcribe'
        && isScopedChapterTranscription(job.params) && typeof job.params.narration_refresh_job_id === 'string'
        && job.status !== 'cancelled' && !job.force_abandoned && !savedNarrationSource(job, jobs)
        && !plan?.narration_refresh_checks?.some(check => check.source_job_id === job.params.narration_refresh_job_id)
        && (!Number.isFinite(mergedSourceTime) || Date.parse(job.created_at) >= mergedSourceTime))
      if (unverifiedCheck) {
        // Automatic passes only log errors, so say it on the check's own job line too (once).
        if (!unverifiedCheck.output_lines?.includes(UNVERIFIED_REFRESH_SOURCE)) {
          const noted = await jq.mutateAuthoritativeJob(projectSlug, unverifiedCheck.job_id, current => ({ ...current,
            output_lines: [...(current.output_lines || []), UNVERIFIED_REFRESH_SOURCE] }))
          if (noted) await jq.checkpointJobState(noted)
        }
        throw new Error(UNVERIFIED_REFRESH_SOURCE)
      }
      const newRefreshIntent = newRefreshIds.length > 0 && plan?.first_unresolved === null && !ownsAcceptedMerge
      if (!plan || newCancellationIntent || newRefreshIntent) {
        if (!create) return null
        const relevant = jobs.filter(job => episodeRecoveryStep(job.type) && !job.force_abandoned && job.status !== 'cancelled')
        for (const job of selected) if (!relevant.some(row => row.job_id === job!.job_id)) relevant.push(job!)
        if (!relevant.length) throw new Error('No recoverable episode jobs were found.')
        const priorSourceIds = plan?.retry_source_job_ids || []
        const savedNode = plan?.steps.audio_merge
        const savedJob = savedNode && jobs.find(job => job.job_id === savedNode.job_id)
        const savedMerge = savedNode && !savedNode.params?.audio_quality_refresh
          && (savedJob ? savedJob.status === 'done' : plan!.completed.includes('audio_merge')) ? savedNode : undefined
        if (plan) (store.retired_plans ||= {})[plan.id] = plan
        plan = store.plans[episodeId] = createEpisodeRecoveryPlan(refreshIds.length && !newCancellationIntent
          ? priorMerge ? [priorMerge] : [narrationRefreshChecks(jobs).at(-1)!]
          : relevant, sourceJobIds)
        if (refreshIds.length && !newCancellationIntent) {
          if (!plan.steps.audio_merge && savedMerge) plan.steps.audio_merge = { ...structuredClone(savedMerge),
            job_id: `recovery-${plan.id}-audio_merge`, dispatched: false }
          if (plan.steps.audio_merge) delete plan.steps.audio_merge.params.audio_quality_refresh
          plan.target = 'subtitle_stitch'
          plan.steps = plan.steps.audio_merge ? { audio_merge: plan.steps.audio_merge } : {}
          delete plan.continuation
          plan.narration_refresh_job_ids = refreshIds
        }
        plan.retry_source_job_ids = [...new Set([...priorSourceIds, ...sourceJobIds])]
        planDirty = true
      } else if (newRefreshIds.length && !ownsAcceptedMerge) {
        plan.narration_refresh_job_ids = [...new Set([...(plan.narration_refresh_job_ids || []), ...newRefreshIds])]
        if (mergeNode && (mergeJob?.status === 'done' || (!mergeJob && plan.completed.includes('audio_merge')))) {
          plan.steps.audio_merge = { ...mergeNode, job_id: `recovery-${plan.id}-audio_merge-${randomUUID()}`, dispatched: false }
        }
        plan.first_unresolved = 'audio_merge'
        planDirty = true
      }
      if (plan.project_slug !== projectSlug) throw new Error('Episode recovery belongs to another project.')
      if (selected.every((job): job is Job => !!job)
        && extendPlanFromSelectedFailures(plan, selected, jobs)) planDirty = true
      // One write for the identity and every extension, still before any queue
      // insertion. A refusal while extending the plan must not leave a
      // half-built record that the next Retry then treats as authoritative.
      if (planDirty) await writeJsonAtomic(file, store)
      return plan
    })
    if (!plan) return null
    // S12: an audit that changes nothing does not rewrite the plans file.
    const stored = JSON.stringify(plan)
    if (ownerRequest) plan.owner_requested_at = new Date().toISOString()
    const save = () => withLock(file, async () => {
      // Another episode may have finished its audit meanwhile. Merge only this
      // episode; never overwrite the other plans with our pre-audit snapshot.
      const store = await readPlans(file)
      if (store.plans[episodeId]?.id !== plan.id) throw new Error('Episode recovery identity changed. Refresh Jobs before retrying.')
      store.plans[episodeId] = plan
      await writeJsonAtomic(file, store)
    })
    withholdManualImageFinishFromPlan(plan)
    if (selected.length > 0 && selected.every(job => !!job?.params?.manual_image_finish)) {
      plan.message = MANUAL_IMAGE_FINISH_GUIDANCE
      await save()
      return { ...plan, dispatch_status: 'blocked' as const }
    }
    const current = episodeRecoveryDispatch(plan, jobs)
    if (current.dispatch_status === 'queued' || current.dispatch_status === 'running' || current.dispatch_status === 'paused') {
      // The accepted job already owns this edge. Rechecking the entire disk
      // while it waits cannot advance it; completion triggers the next audit.
      return { ...plan, ...current }
    }
    // Owner, 2026-10-27: an accepted final is never re-done by automatic recovery — not even for an
    // episode whose pre-render artifacts look stale, and not decided by an artifact audit. Retry /
    // Recover still does whatever it is asked to (`ownerRequest`, and the plan records it), including
    // the steps it goes on to release. A step already queued or running was left to finish by the
    // return above, so nothing is cancelled here. The plan is not deleted: Retry reuses it.
    const leftAlone = !ownerRequest && !plan.owner_requested_at && !!plan.project_slug && !!plan.episode_id
      && await hasAcceptedFinalVideo(plan.project_slug, plan.episode_id)
    if (leftAlone) plan.message = ACCEPTED_FINAL_GUARD_MESSAGE
    let auditFailed = false
    if (!leftAlone) try {
      const facts = await inspectRecovery(plan, jobs)
      jobs = await currentJobs()
      await dispatchEpisodeRecoveryStep(plan, facts, jobs, sourceJobIds, admissionSource, observedJobs.map(job => job.job_id))
    } catch (error) {
      auditFailed = true
      plan.message = error instanceof Error ? error.message : String(error)
    }
    if (JSON.stringify(plan) !== stored) await save()
    for (const row of jobs) {
      const step = episodeRecoveryStep(row.type)
      if (!step || row.status === 'cancelled' || row.force_abandoned) continue
      const deferred = plan.first_unresolved !== null && EPISODE_RECOVERY_ORDER.indexOf(step) > EPISODE_RECOVERY_ORDER.indexOf(plan.first_unresolved)
      const projection = { id: plan.id, first_unresolved: plan.first_unresolved, completed: plan.completed, deferred, message: plan.message }
      // 1.4.276 — a live Pipeline job keeps its own later steps unless this plan
      // took them over (`continuation`). The recovery id makes completion skip
      // the chain, so stamping it here dropped DL0004's Thumbnails and Metadata
      // when a narration refresh (which owns no continuation) adopted Scene Review.
      const keepsChain = !plan.continuation?.length && ['queued', 'running', 'paused'].includes(row.status)
        && Array.isArray(row.params.pipeline_chain) && row.params.pipeline_chain.length > 0
      if (JSON.stringify(row.params.episode_recovery) === JSON.stringify(projection)
        && (!keepsChain || row.params.episode_recovery_id === undefined)) continue
      const changed = await jq.mutateAuthoritativeJob(projectSlug, row.job_id, current => {
        const params = { ...current.params, episode_recovery: projection, episode_recovery_id: plan.id }
        if (keepsChain) delete (params as Partial<typeof params>).episode_recovery_id
        return { ...current, params }
      })
      if (changed) await jq.checkpointJobState(changed)
    }
    const dispatch = auditFailed ? { dispatch_status: 'blocked' as const }
      : episodeRecoveryDispatch(plan, await jq.findJobs(projectSlug, job => job.episode_id === episodeId))
    return { ...plan, ...dispatch }
  })
}

const BLOCKED_RECHECK_MS = 10 * 60_000

/** Size + mtime of every episode folder and artifact path the audit reads; null when unresolvable. */
export async function episodeInputStamp(projectSlug: string, episodeId: string): Promise<string | null> {
  try {
    const paths = await resolveEpisodePathsByCode(projectSlug, episodeId)
    const stats = await Promise.all(Object.values(paths).map(target => fs.stat(target).then(info => `${info.size}:${info.mtimeMs}`, () => '-')))
    return stats.join('|')
  } catch { return null }
}

/** Called once after queue lanes are registered; progress never depends on an open browser. */
let started = false
export async function startEpisodeRecovery(): Promise<void> {
  if (started) return
  started = true
  const pending = new Map<string, { jobs: Job[]; origin: RecoveryAdmissionSource }>()
  const running = new Set<string>()
  const watching = new Map<string, { project: string; episode: string }>()
  // S12: a blocked plan is re-audited by the timer only when its episode's files changed (or every
  // BLOCKED_RECHECK_MS as a backstop); job completions still advance it at once through `schedule`.
  const blocked = new Map<string, { stamp: string; at: number }>()
  const advance = async (project: string, episode: string, create: boolean, observedJobs: Job[] = [], origin: RecoveryAdmissionSource = 'completion') => {
    const key = `${project}:${episode}`
    blocked.delete(key)
    const plan = await recoverEpisode(project, episode, create, [], observedJobs, false, origin)
    if (plan?.first_unresolved) watching.set(key, { project, episode })
    else watching.delete(key)
    return plan
  }
  // Lazy: only a finished subtitle job reaches it, so the boot scan's raw predicate stays cheap.
  const stampedRefresh = (job: Readonly<Job>) => narrationRefreshChecks([job as Job, ...(typeof job.params?.narration_refresh_job_id === 'string'
    ? [jq.getJob(job.params.narration_refresh_job_id)].filter((source): source is Job => !!source) : [])]).includes(job as Job)
  const schedules = (job: Readonly<Job>) => {
    const automaticSubtitle = job.type === 'subtitles_transcribe' && job.status === 'error'
    const completedFreshSubtitle = job.type === 'subtitles_transcribe' && job.status === 'done'
      && (job.params?.generation_action?.kind === 'fresh' || stampedRefresh(job))
    return !(!episodeRecoveryStep(job.type) || (!job.params?.episode_recovery_id && !automaticSubtitle && !completedFreshSubtitle)
      || !['done', 'error'].includes(job.status) || job.force_abandoned)
  }
  const schedule = (job: Job, origin: RecoveryAdmissionSource = 'completion') => {
    if (!schedules(job)) return
    const key = `${job.project_slug}:${job.episode_id}`
    const queued = pending.get(key)
    pending.set(key, { jobs: [...(queued?.jobs || []).filter(row => row.job_id !== job.job_id), job], origin })
    if (running.has(key)) return
    running.add(key)
    setImmediate(() => {
      void (async () => {
        // Completion can arrive during an asynchronous artifact audit or queue
        // insertion. Retain it for another pass instead of dropping that edge.
        while (pending.has(key)) {
          const pass = pending.get(key)!
          pending.delete(key)
          const latest = pass.jobs.at(-1)!
          await advance(latest.project_slug, latest.episode_id, pass.jobs.some(job => job.type === 'subtitles_transcribe'
            && (job.status === 'error' || typeof job.params?.narration_refresh_job_id === 'string')), pass.jobs, pass.origin)
        }
      })()
        .catch(error => console.warn('[episode-recovery]', error.message))
        .finally(() => running.delete(key))
    })
  }
  jq.jobEvents.on('update', schedule)
  for (const project of await listProjects()) {
    const file = path.join(getProjectDir(project.slug)!, 'episode-recovery-plans.json')
    try {
      for (const episodeId of Object.keys((await readPlans(file)).plans)) await advance(project.slug, episodeId, false, [], 'boot')
      for (const job of await jq.findJobs(project.slug, schedules)) schedule(job, 'boot')
    } catch (error) { console.warn('[episode-recovery] boot:', error) }
  }
  // Also observes local stitch/cue review changes, which do not emit queue
  // completions. Only unresolved plans are watched; Task 1b still owns every
  // replacement authorization and settlement decision.
  const timer = setInterval(() => {
    for (const [key, scope] of watching) {
      if (running.has(key)) continue
      running.add(key)
      void (async () => {
        const stamp = await episodeInputStamp(scope.project, scope.episode)
        const last = blocked.get(key)
        if (last && stamp !== null && last.stamp === stamp && Date.now() - last.at < BLOCKED_RECHECK_MS) return
        const plan = await advance(scope.project, scope.episode, false, [], 'timer')
        if (plan?.dispatch_status === 'blocked' && stamp !== null) blocked.set(key, { stamp, at: Date.now() })
      })()
        .catch(error => console.warn('[episode-recovery] recheck:', error.message))
        .finally(() => running.delete(key))
    }
  }, 30_000)
  timer.unref()
}
