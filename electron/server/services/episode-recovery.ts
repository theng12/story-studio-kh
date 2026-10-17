/** Fixed, episode-owned recovery order. Provider/credit decisions belong to subtitle-recovery. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Job, JobType } from '../models/types.js'
import { CIRCULAR_MARKER, repairCircularParams, type RepairableJob } from '../lib/circular-params-repair.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import * as jq from './job-queue.js'
import { getProjectDir, listProjects } from './project-manager.js'
import { computeEpisodeStatus } from './asset-status.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { inspectAudioAssemblyReadiness, isScopedChapterTranscription } from './audio-workflow-readiness.js'
import { readStitchPlan } from './subtitle-stitcher.js'
import { inspectSubtitleSourceFreshness } from './subtitle-completion.js'
import { ensureStitchedSubtitle, type EnsureStitchedOptions } from '../lib/subtitle-autostitch.js'
import { verifyWrittenSubtitleTimeline } from './scene-timeline-integrity.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { inspectPlanTimelineDrift } from '../lib/scene-plan-timeline.js'
import { selectMergedAudioFilename } from '../lib/intro-lead-in.js'
import { hashSubtitleAudioSources, inspectChapterSubtitleCompletion } from './subtitle-completion.js'
import { readSubtitleSourceAudioHashes } from './subtitle-recovery.js'
import { readLocalMediaCleanupStatus } from './episode-media-cleanup.js'

export const EPISODE_RECOVERY_ORDER = ['audio_merge', 'subtitle_sections', 'subtitle_stitch', 'scene_plan_run', 'contextual_cues', 'continuity_render'] as const
export type EpisodeRecoveryStep = typeof EPISODE_RECOVERY_ORDER[number]
type RecoveryJob = { job_id: string; type: JobType; title: string; params: Job['params']; source_job_id?: string; dispatched?: boolean; manual_image_finish_withheld?: true; stale_redispatched?: true }
type RecoveryContinuation = { type: JobType; title?: string; params?: Job['params']; manual_image_finish_withheld?: true }
type NarrationRefreshAcknowledgement = { source_job_id: string; section: string; job_id: string; created_at: string; source_saved_at: string }
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

async function continueFailedSubtitleCheck(plan: EpisodeRecoveryPlan, job: Job, explicit: boolean): Promise<void> {
  if (job.status !== 'error') return
  if (explicit) { await jq.resumeEpisodeRecoveryJob(job.job_id, true); return }
  const states = Object.values(job.params?.subtitle_recovery?.sections || {}) as Array<{ state?: string }>
  if (!states.some(state => state.state === 'waiting_settlement' || state.state === 'free_recovery')) return
  const due = Date.parse(plan.next_free_check_at || '')
  plan.next_free_check_at ||= new Date(Date.now() + 30_000).toISOString()
  if (Number.isFinite(due) && due <= Date.now()) {
    plan.next_free_check_at = new Date(Date.now() + 30_000).toISOString()
    await jq.resumeEpisodeRecoveryJob(job.job_id)
  }
}

/** The existing episode lock coalesces the currently known chapter repair batch. */
async function waitForNarrationRefreshChecks(plan: EpisodeRecoveryPlan, jobs: Job[], sourceJobIds: string[]): Promise<boolean> {
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
  for (const job of failed) await continueFailedSubtitleCheck(plan, job, sourceJobIds.includes(job.job_id))
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
    const params = saved ? { ...saved.params, ...job.params } : job.params
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
    if (existing?.dispatched) continue
    const source = failed.find(job => episodeRecoveryStep(job.type) === step)
    const ownsSource = source?.params?.episode_recovery_id === plan.id
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
  if (plan.narration_refresh_job_ids?.length && !plan.steps.audio_merge?.dispatched) {
    return { verified: unresolved, message: 'Chapter repair requires Audio Assembly with the saved mix settings' }
  }
  const audio = await inspectAudioAssemblyReadiness(plan.project_slug, plan.episode_id)
  if (!audio.audio_assembly_ready) return { verified: unresolved, message: audio.issues.join(' ') }
  const paths = await resolveEpisodePathsByCode(plan.project_slug, plan.episode_id)
  const facts = await inspectRecoverySubtitlePrerequisites(plan, { episodeDir: paths.episode_dir, subtitlesDir: paths.subtitles_dir,
    mergedAudioDir: paths.merged_audio_dir, audioDir: paths.audio_dir, episodeCode: plan.episode_id }, jobs)
  const { verified } = facts
  if (!verified.subtitle_stitch || plan.target === 'subtitle_stitch') return facts
  const status = await computeEpisodeStatus(plan.project_slug, plan.episode_id)
  const scenePlanPath = await resolveScenePlanPath(plan.project_slug, plan.episode_id, paths.episode_dir)
  const drift = await inspectPlanTimelineDrift(scenePlanPath, path.join(paths.subtitles_dir, `${plan.episode_id.toUpperCase()}_stitched.srt`),
    path.join(paths.merged_audio_dir, `${plan.episode_id.toUpperCase()}_merged_audio.completion.json`),
    selectMergedAudioFilename(await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[]), plan.episode_id))
  verified.scene_plan_run = status.scene_plan && !drift.stale
  verified.contextual_cues = status.contextual_cues === true
    && (!plan.steps.contextual_cues || status.contextual_cues_generated === true)
  verified.continuity_render = status.scene_review
  return facts
}

interface RecoveryStore { version: 1; plans: Record<string, EpisodeRecoveryPlan>; retired_plans?: Record<string, EpisodeRecoveryPlan> }

export async function dispatchEpisodeRecoveryStep(
  plan: EpisodeRecoveryPlan,
  facts: { verified: Record<EpisodeRecoveryStep, boolean>; message: string; missing?: string[] },
  jobs: Job[],
  sourceJobIds: string[] = [],
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
  if (!verified.audio_merge && await waitForNarrationRefreshChecks(plan, jobs, sourceJobIds)) {
    plan.completed = []
    plan.first_unresolved = 'audio_merge'
    return
  }
  const step = nextEpisodeRecoveryStep(plan, verified)
  plan.message = step ? `${facts.message}. Waiting for ${labels[step]}.` : 'Episode recovery complete.'
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
  if (active && node) { node.job_id = active.job_id; node.dispatched = true }
  if (node && withholdManualImageFinish(node)) {
    plan.message = MANUAL_IMAGE_FINISH_GUIDANCE
    return
  }
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
    } else if (step === 'subtitle_sections') await continueFailedSubtitleCheck(plan, existing, false)
    return
  }
  if (!node) { plan.message += ` Open ${labels[step]} to complete or configure this prerequisite.`; return }
  if (node.dispatched) { plan.message += ' This edge was already dispatched; review its saved result before starting new work.'; return }
  // Free Up Space removed this episode's media on purpose (it was already uploaded). That is not
  // missing work: only an owner request made after the cleanup may rebuild it, never a restart sweep.
  const cleanup = await readLocalMediaCleanupStatus(plan.project_slug, plan.episode_id)
  if ((cleanup.has_retired_media || cleanup.blocked_reason)
    && !(Date.parse(plan.owner_requested_at || '') > (Date.parse(cleanup.updated_at || '') || 0))) {
    plan.message = 'Free Up Space removed this episode\'s media on purpose, so Story will not rebuild it on its own. Retry it yourself if you want it back.'
    return
  }
  const params: Job['params'] = { ...node.params, episode_id: plan.episode_id, episode_recovery_id: plan.id }
  if (step === 'subtitle_sections') {
    assertSectionScope(node.params)
    params.sections = (facts.missing || []).filter(section => !Array.isArray(node.params.sections) || node.params.sections.includes(section))
    if (!params.sections.length) throw new Error('Missing subtitle sections are outside the saved recovery scope. Select those sections explicitly in Subtitles.')
    params.subtitle_recovery_plan_id ||= plan.id
  }
  await jq.enqueueEpisodeRecoveryOnce(node.job_id, { project_slug: plan.project_slug, episode_id: plan.episode_id,
    type: node.type, title: node.title, params })
  node.dispatched = true
  plan.message = step === 'subtitle_sections' ? `${facts.message}. Recovering existing subtitle task (free).` : `${labels[step]} queued after verified prerequisites.`
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

/** Serialize an episode's decisions; share the file lock only while saving records. */
export async function recoverEpisode(projectSlug: string, episodeId: string, create = true, sourceJobIds: string[] = [], observedJobs: Job[] = [], ownerRequest = false): Promise<(EpisodeRecoveryPlan & { dispatch_status: 'queued' | 'running' | 'paused' | 'blocked' | 'complete'; dispatch_job_id?: string }) | null> {
  const projectDir = getProjectDir(projectSlug)
  if (!projectDir) throw new Error('Project not found.')
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
      if (selected.some(job => !job || !episodeRecoveryStep(job.type) || job.force_abandoned
        || (!['error', 'cancelled'].includes(job.status)
          && !Object.values(plan?.steps || {}).some(node => node.job_id === job.job_id)))) throw new Error('Recovery source must be an owned failed or cancelled episode job.')
      // Explicit cancellation and a new server-stamped narration refresh own new identities.
      const newCancellationIntent = selected.some(job => job!.status === 'cancelled' && !plan?.retry_source_job_ids?.includes(job!.job_id))
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
        await writeJsonAtomic(file, store) // identity first, before any queue insertion
      } else if (newRefreshIds.length && !ownsAcceptedMerge) {
        plan.narration_refresh_job_ids = [...new Set([...(plan.narration_refresh_job_ids || []), ...newRefreshIds])]
        if (mergeNode && (mergeJob?.status === 'done' || (!mergeJob && plan.completed.includes('audio_merge')))) {
          plan.steps.audio_merge = { ...mergeNode, job_id: `recovery-${plan.id}-audio_merge-${randomUUID()}`, dispatched: false }
        }
        plan.first_unresolved = 'audio_merge'
        await writeJsonAtomic(file, store)
      }
      if (plan.project_slug !== projectSlug) throw new Error('Episode recovery belongs to another project.')
      if (selected.every((job): job is Job => !!job)
        && extendPlanFromSelectedFailures(plan, selected, jobs)) await writeJsonAtomic(file, store)
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
    let auditFailed = false
    try {
      const facts = await inspectRecovery(plan, jobs)
      jobs = await currentJobs()
      await dispatchEpisodeRecoveryStep(plan, facts, jobs, sourceJobIds)
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
  const pending = new Map<string, Job[]>()
  const running = new Set<string>()
  const watching = new Map<string, { project: string; episode: string }>()
  // S12: a blocked plan is re-audited by the timer only when its episode's files changed (or every
  // BLOCKED_RECHECK_MS as a backstop); job completions still advance it at once through `schedule`.
  const blocked = new Map<string, { stamp: string; at: number }>()
  const advance = async (project: string, episode: string, create: boolean, observedJobs: Job[] = []) => {
    const key = `${project}:${episode}`
    blocked.delete(key)
    const plan = await recoverEpisode(project, episode, create, [], observedJobs)
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
  const schedule = (job: Job) => {
    if (!schedules(job)) return
    const key = `${job.project_slug}:${job.episode_id}`
    pending.set(key, [...(pending.get(key) || []).filter(row => row.job_id !== job.job_id), job])
    if (running.has(key)) return
    running.add(key)
    setImmediate(() => {
      void (async () => {
        // Completion can arrive during an asynchronous artifact audit or queue
        // insertion. Retain it for another pass instead of dropping that edge.
        while (pending.has(key)) {
          const observed = pending.get(key)!
          pending.delete(key)
          const latest = observed.at(-1)!
          await advance(latest.project_slug, latest.episode_id, observed.some(job => job.type === 'subtitles_transcribe'
            && (job.status === 'error' || typeof job.params?.narration_refresh_job_id === 'string')), observed)
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
      for (const episodeId of Object.keys((await readPlans(file)).plans)) await advance(project.slug, episodeId, false)
      for (const job of await jq.findJobs(project.slug, schedules)) schedule(job)
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
        const plan = await advance(scope.project, scope.episode, false)
        if (plan?.dispatch_status === 'blocked' && stamp !== null) blocked.set(key, { stamp, at: Date.now() })
      })()
        .catch(error => console.warn('[episode-recovery] recheck:', error.message))
        .finally(() => running.delete(key))
    }
  }, 30_000)
  timer.unref()
}
