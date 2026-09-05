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
type RecoveryJob = { job_id: string; type: JobType; title: string; params: Job['params']; source_job_id?: string; dispatched?: boolean }
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
  continuation?: Array<{ type: JobType; title?: string; params?: Job['params'] }>
  continuation_dispatched?: boolean
  pipeline_batch_id?: string
  retry_source_job_ids?: string[]
  next_free_check_at?: string
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
      assertSectionScope(params)
      params.force = false
      const missing = source?.result?.missing_sections
      if (Array.isArray(missing)) {
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
export async function inspectRecoverySubtitles(episodeDir: string, subtitlesDir: string, code: string) {
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

async function inspectRecovery(plan: EpisodeRecoveryPlan, jobs: Job[]) {
  const verified = Object.fromEntries(EPISODE_RECOVERY_ORDER.map(step => [step, false])) as Record<EpisodeRecoveryStep, boolean>
  if (jobs.some(job => job.type === 'audio_merge' && ['queued', 'running', 'paused'].includes(job.status))) {
    return { verified, message: 'Waiting for the active Audio Assembly job.' }
  }
  const audio = await inspectAudioAssemblyReadiness(plan.project_slug, plan.episode_id)
  verified.audio_merge = audio.audio_assembly_ready
  if (!verified.audio_merge) return { verified, message: audio.issues.join(' ') }
  const paths = await resolveEpisodePathsByCode(plan.project_slug, plan.episode_id)
  const coverage = await inspectRecoverySubtitles(paths.episode_dir, paths.subtitles_dir, plan.episode_id)
  verified.subtitle_sections = coverage.complete
  const sectionMessage = `${coverage.expected.length - coverage.missing.length}/${coverage.expected.length} sections ready`
  if (!coverage.complete) return { verified, message: sectionMessage, missing: coverage.missing }
  // Never race a still-running transcription's source writes.
  if (jobs.some(job => job.type === 'subtitles_transcribe' && ['queued', 'running', 'paused'].includes(job.status))) {
    return { verified, message: `${sectionMessage}. Scene Plan waiting for subtitle stitch.` }
  }
  try {
    verified.subtitle_stitch = await ensureRecoveryStitch({ episodeDir: paths.episode_dir, subtitlesDir: paths.subtitles_dir,
      mergedAudioDir: paths.merged_audio_dir, episodeCode: plan.episode_id })
  } catch (error) {
    return { verified, message: `Scene Plan waiting for subtitle stitch: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!verified.subtitle_stitch) return { verified, message: `${sectionMessage}. Scene Plan waiting for subtitle stitch.` }
  const status = await computeEpisodeStatus(plan.project_slug, plan.episode_id)
  const scenePlanPath = await resolveScenePlanPath(plan.project_slug, plan.episode_id, paths.episode_dir)
  const drift = await inspectPlanTimelineDrift(scenePlanPath, path.join(paths.subtitles_dir, `${plan.episode_id.toUpperCase()}_stitched.srt`))
  verified.scene_plan_run = status.scene_plan && !drift.stale
  verified.contextual_cues = status.contextual_cues === true
    && (!plan.steps.contextual_cues || status.contextual_cues_generated === true)
  verified.continuity_render = status.scene_review
  return { verified, message: sectionMessage }
}

interface RecoveryStore { version: 1; plans: Record<string, EpisodeRecoveryPlan>; retired_plans?: Record<string, EpisodeRecoveryPlan> }

export async function dispatchEpisodeRecoveryStep(
  plan: EpisodeRecoveryPlan,
  facts: { verified: Record<EpisodeRecoveryStep, boolean>; message: string; missing?: string[] },
  jobs: Job[],
): Promise<void> {
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
    if (plan.continuation?.length && !plan.continuation_dispatched) {
      const [next, ...rest] = plan.continuation
      await jq.enqueueEpisodeRecoveryOnce(`recovery-${plan.id}-continuation`, {
        project_slug: plan.project_slug, episode_id: plan.episode_id, type: next.type, title: next.title,
        params: { ...next.params, episode_id: plan.episode_id, pipeline_chain: rest,
          ...(plan.pipeline_batch_id ? { pipeline_batch_id: plan.pipeline_batch_id } : {}) },
      })
      plan.continuation_dispatched = true
    }
    return
  }
  if (step === 'subtitle_stitch') return
  const node = plan.steps[step]
  const type = step === 'subtitle_sections' ? 'subtitles_transcribe' : step
  const active = jobs.find(job => job.type === type && ['queued', 'running', 'paused'].includes(job.status))
  const existing = active || (node && jobs.find(job => job.job_id === node.job_id))
  if (active && node) { node.job_id = active.job_id; node.dispatched = true }
  if (existing) {
    const states = Object.values(existing.params?.subtitle_recovery?.sections || {}) as Array<{ state?: string; message?: string }>
    plan.message = states.map(state => state.message).filter(Boolean).join(' ') || existing.error || plan.message
    if (step === 'subtitle_sections' && existing.status === 'error'
      && states.some(state => state.state === 'waiting_settlement' || state.state === 'free_recovery')) {
      const due = Date.parse(plan.next_free_check_at || '')
      plan.next_free_check_at ||= new Date(Date.now() + 30_000).toISOString()
      if (Number.isFinite(due) && due <= Date.now()) {
        plan.next_free_check_at = new Date(Date.now() + 30_000).toISOString()
        await jq.resumeSubtitleRecoveryJob(existing.job_id)
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

/** One lock, one record per episode; all callers consume the same queue identities. */
export async function recoverEpisode(projectSlug: string, episodeId: string, create = true, sourceJobIds: string[] = []): Promise<EpisodeRecoveryPlan | null> {
  const projectDir = getProjectDir(projectSlug)
  if (!projectDir) throw new Error('Project not found.')
  await jq.getJobs(projectSlug)
  const file = path.join(projectDir, 'episode-recovery-plans.json')
  return withLock(file, async () => {
    const jobs = (await jq.getJobs(projectSlug)).filter(job => job.episode_id === episodeId)
    const store = await readPlans(file)
    let plan = store.plans[episodeId]
    const selected = sourceJobIds.map(id => jobs.find(job => job.job_id === id))
    if (selected.some(job => !job || !episodeRecoveryStep(job.type) || job.force_abandoned
      || !['error', 'cancelled'].includes(job.status))) throw new Error('Recovery source must be an owned failed or cancelled episode job.')
    // Only an explicit saved-source intent can supersede a cancellation. Replay
    // of the same intent reuses its plan; automatic observers never select it.
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
    try {
      const facts = await inspectRecovery(plan, jobs)
      await dispatchEpisodeRecoveryStep(plan, facts, jobs)
    } catch (error) {
      plan.message = error instanceof Error ? error.message : String(error)
    }
    await writeJsonAtomic(file, store)
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
    return plan
  })
}

/** Called once after queue lanes are registered; progress never depends on an open browser. */
let started = false
export async function startEpisodeRecovery(): Promise<void> {
  if (started) return
  started = true
  const pending = new Map<string, Job>()
  const running = new Set<string>()
  const watching = new Map<string, { project: string; episode: string }>()
  const advance = async (project: string, episode: string, create: boolean) => {
    const plan = await recoverEpisode(project, episode, create)
    const key = `${project}:${episode}`
    if (plan?.first_unresolved) watching.set(key, { project, episode })
    else watching.delete(key)
  }
  const schedule = (job: Job) => {
    const automaticSubtitle = job.type === 'subtitles_transcribe' && job.status === 'error'
    if (!episodeRecoveryStep(job.type) || (!job.params?.episode_recovery_id && !automaticSubtitle)
      || !['done', 'error'].includes(job.status) || job.force_abandoned) return
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
      for (const job of await jq.getJobs(project.slug)) schedule(job)
    } catch (error) { console.warn('[episode-recovery] boot:', error) }
  }
  // Also observes local stitch/cue review changes, which do not emit queue
  // completions. Only unresolved plans are watched; Task 1b still owns every
  // replacement authorization and settlement decision.
  const timer = setInterval(() => {
    for (const [key, scope] of watching) {
      if (running.has(key)) continue
      running.add(key)
      void advance(scope.project, scope.episode, false)
        .catch(error => console.warn('[episode-recovery] recheck:', error.message))
        .finally(() => running.delete(key))
    }
  }, 30_000)
  timer.unref()
}
