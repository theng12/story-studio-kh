/** Fixed, episode-owned recovery order. Provider/credit decisions belong to subtitle-recovery. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job, JobType } from '../models/types.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import * as jq from './job-queue.js'
import { getProjectDir, listProjects } from './project-manager.js'
import { computeEpisodeStatus } from './asset-status.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { inspectAudioAssemblyReadiness } from './audio-workflow-readiness.js'
import { readStitchPlan } from './subtitle-stitcher.js'
import { ensureStitchedSubtitle, type EnsureStitchedOptions } from '../lib/subtitle-autostitch.js'
import { verifyWrittenSubtitleTimeline } from './scene-timeline-integrity.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { inspectPlanTimelineDrift } from '../lib/scene-plan-timeline.js'

export const EPISODE_RECOVERY_ORDER = ['audio_merge', 'subtitle_sections', 'subtitle_stitch', 'scene_plan_run', 'contextual_cues', 'continuity_render'] as const
export type EpisodeRecoveryStep = typeof EPISODE_RECOVERY_ORDER[number]
type RecoveryJob = { job_id: string; type: JobType; title: string; params: Job['params']; source_job_id?: string; dispatched?: boolean; manual_image_finish_withheld?: true }
type RecoveryContinuation = { type: JobType; title?: string; params?: Job['params']; manual_image_finish_withheld?: true }
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

export function createEpisodeRecoveryPlan(jobs: Job[], sourceJobIds: string[] = []): EpisodeRecoveryPlan {
  if (!jobs.length) throw new Error('Recovery requires an existing episode job.')
  const first = jobs[0]
  const id = randomUUID()
  const plan: EpisodeRecoveryPlan = { version: 1, id, project_slug: first.project_slug, episode_id: first.episode_id,
    target: 'subtitle_stitch', steps: {}, completed: [], first_unresolved: 'audio_merge', message: 'Checking episode prerequisites.' }
  const add = (type: string, title: string, input: Job['params'], source?: Job) => {
    const step = episodeRecoveryStep(type)
    if (!step) return
    const params = structuredClone(input || {})
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
      if (typeof child?.type === 'string') add(child.type, child.title || child.type, child.params || {})
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

/** Read real source cues, not merely non-empty filenames or a stale derivative. */
export async function inspectRecoverySubtitles(episodeDir: string, subtitlesDir: string, code: string, perChapter = true) {
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
  return { expected: stitch.sections.map(section => section.slug), missing, complete: stitch.sections.length > 0 && missing.length === 0 }
}

/** Safe local repair, followed by proof of the actual written timeline. */
export async function ensureRecoveryStitch(options: EnsureStitchedOptions): Promise<boolean> {
  if (!(await inspectRecoverySubtitles(options.episodeDir, options.subtitlesDir, options.episodeCode)).complete) return false
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
  const coverage = await inspectRecoverySubtitles(paths.episodeDir, paths.subtitlesDir, plan.episode_id, !wholeTrack)
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
  const audio = await inspectAudioAssemblyReadiness(plan.project_slug, plan.episode_id)
  if (!audio.audio_assembly_ready) return { verified: unresolved, message: audio.issues.join(' ') }
  const paths = await resolveEpisodePathsByCode(plan.project_slug, plan.episode_id)
  const facts = await inspectRecoverySubtitlePrerequisites(plan, { episodeDir: paths.episode_dir, subtitlesDir: paths.subtitles_dir,
    mergedAudioDir: paths.merged_audio_dir, audioDir: paths.audio_dir, episodeCode: plan.episode_id }, jobs)
  const { verified } = facts
  if (!verified.subtitle_stitch || plan.target === 'subtitle_stitch') return facts
  const status = await computeEpisodeStatus(plan.project_slug, plan.episode_id)
  const scenePlanPath = await resolveScenePlanPath(plan.project_slug, plan.episode_id, paths.episode_dir)
  const drift = await inspectPlanTimelineDrift(scenePlanPath, path.join(paths.subtitles_dir, `${plan.episode_id.toUpperCase()}_stitched.srt`))
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
      await jq.enqueueEpisodeRecoveryOnce(plan.continuation_job_id || `recovery-${plan.id}-continuation`, {
        project_slug: plan.project_slug, episode_id: plan.episode_id, type: next.type, title: next.title,
        params: { ...next.params, episode_id: plan.episode_id, pipeline_chain: rest,
          ...(plan.pipeline_batch_id ? { pipeline_batch_id: plan.pipeline_batch_id } : {}) },
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
  const active = jobs.find(job => job.type === type && ['queued', 'running', 'paused'].includes(job.status))
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
    const states = Object.values(existing.params?.subtitle_recovery?.sections || {}) as Array<{ state?: string; message?: string }>
    plan.message = states.map(state => state.message).filter(Boolean).join(' ') || existing.error || plan.message
    if (existing.status === 'error' && sourceJobIds.length) {
      await jq.resumeEpisodeRecoveryJob(existing.job_id, true)
    } else if (step === 'subtitle_sections' && existing.status === 'error'
      && states.some(state => state.state === 'waiting_settlement' || state.state === 'free_recovery')) {
      const due = Date.parse(plan.next_free_check_at || '')
      plan.next_free_check_at ||= new Date(Date.now() + 30_000).toISOString()
      if (Number.isFinite(due) && due <= Date.now()) {
        plan.next_free_check_at = new Date(Date.now() + 30_000).toISOString()
        await jq.resumeEpisodeRecoveryJob(existing.job_id)
      }
    }
    return
  }
  if (!node) { plan.message += ` Open ${labels[step]} to complete or configure this prerequisite.`; return }
  if (node.dispatched) { plan.message += ' This edge was already dispatched; review its saved result before starting new work.'; return }
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
export async function recoverEpisode(projectSlug: string, episodeId: string, create = true, sourceJobIds: string[] = []): Promise<(EpisodeRecoveryPlan & { dispatch_status: 'queued' | 'running' | 'paused' | 'blocked' | 'complete'; dispatch_job_id?: string }) | null> {
  const projectDir = getProjectDir(projectSlug)
  if (!projectDir) throw new Error('Project not found.')
  await jq.findJobs(projectSlug, () => false) // hydrate only
  const file = path.join(projectDir, 'episode-recovery-plans.json')
  return withLock(`${file}:${episodeId}`, async () => {
    let jobs = await jq.findJobs(projectSlug, job => job.episode_id === episodeId)
    const selected = sourceJobIds.map(id => jobs.find(job => job.job_id === id))
    const plan = await withLock(file, async () => {
      const store = await readPlans(file)
      let plan = store.plans[episodeId]
      if (selected.some(job => !job || !episodeRecoveryStep(job.type) || job.force_abandoned
        || (!['error', 'cancelled'].includes(job.status)
          && !Object.values(plan?.steps || {}).some(node => node.job_id === job.job_id)))) throw new Error('Recovery source must be an owned failed or cancelled episode job.')
      // Only a new explicit cancellation intent starts a new recovery identity.
      const newCancellationIntent = selected.some(job => job!.status === 'cancelled' && !plan?.retry_source_job_ids?.includes(job!.job_id))
      if (!plan || newCancellationIntent) {
        if (!create) return null
        const relevant = jobs.filter(job => episodeRecoveryStep(job.type) && !job.force_abandoned && job.status !== 'cancelled')
        for (const job of selected) if (!relevant.some(row => row.job_id === job!.job_id)) relevant.push(job!)
        if (!relevant.length) throw new Error('No recoverable episode jobs were found.')
        const priorSourceIds = plan?.retry_source_job_ids || []
        if (plan) (store.retired_plans ||= {})[plan.id] = plan
        plan = store.plans[episodeId] = createEpisodeRecoveryPlan(relevant, sourceJobIds)
        plan.retry_source_job_ids = [...new Set([...priorSourceIds, ...sourceJobIds])]
        await writeJsonAtomic(file, store) // identity first, before any queue insertion
      }
      if (plan.project_slug !== projectSlug) throw new Error('Episode recovery belongs to another project.')
      return plan
    })
    if (!plan) return null
    // S12: an audit that changes nothing does not rewrite the plans file.
    const stored = JSON.stringify(plan)
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
      jobs = await jq.findJobs(projectSlug, job => job.episode_id === episodeId)
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
      if (JSON.stringify(row.params.episode_recovery) === JSON.stringify(projection)) continue
      const changed = await jq.mutateAuthoritativeJob(projectSlug, row.job_id, current => ({ ...current,
        params: { ...current.params, episode_recovery: projection, episode_recovery_id: plan.id } }))
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
  const pending = new Map<string, Job>()
  const running = new Set<string>()
  const watching = new Map<string, { project: string; episode: string }>()
  // S12: a blocked plan is re-audited by the timer only when its episode's files changed (or every
  // BLOCKED_RECHECK_MS as a backstop); job completions still advance it at once through `schedule`.
  const blocked = new Map<string, { stamp: string; at: number }>()
  const advance = async (project: string, episode: string, create: boolean) => {
    const key = `${project}:${episode}`
    blocked.delete(key)
    const plan = await recoverEpisode(project, episode, create)
    if (plan?.first_unresolved) watching.set(key, { project, episode })
    else watching.delete(key)
    return plan
  }
  const schedules = (job: Readonly<Job>) => {
    const automaticSubtitle = job.type === 'subtitles_transcribe' && job.status === 'error'
    const completedFreshSubtitle = job.type === 'subtitles_transcribe' && job.status === 'done'
      && job.params?.generation_action?.kind === 'fresh'
    return !(!episodeRecoveryStep(job.type) || (!job.params?.episode_recovery_id && !automaticSubtitle && !completedFreshSubtitle)
      || !['done', 'error'].includes(job.status) || job.force_abandoned)
  }
  const schedule = (job: Job) => {
    if (!schedules(job)) return
    const key = `${job.project_slug}:${job.episode_id}`
    pending.set(key, job)
    if (running.has(key)) return
    running.add(key)
    setImmediate(() => {
      void (async () => {
        // Completion can arrive during an asynchronous artifact audit or queue
        // insertion. Retain it for another pass instead of dropping that edge.
        while (pending.has(key)) {
          const latest = pending.get(key)!
          pending.delete(key)
          await advance(latest.project_slug, latest.episode_id, latest.type === 'subtitles_transcribe' && latest.status === 'error')
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
