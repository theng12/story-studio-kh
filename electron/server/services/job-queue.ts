/**
 * Job queue with 3 parallel async workers (script, images, audio).
 * Uses async functions instead of worker threads for simplicity.
 * Each queue processes one job at a time (FIFO).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { redactSensitiveValue } from '../lib/redact-secrets.js'
import { boundGenStudioRequestPreviews, pendingGenStudioEntryId } from '../lib/genstudio-request-preview.js'
import { AsyncLocalStorage } from 'async_hooks'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'node:crypto'
import { projectsRoot, getProjectDir } from './project-manager.js'
import { trackGeneration } from './session-tracker.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import type { Job, JobRemoteCancellation, JobRemoteOperation, JobStats, JobType } from '../models/types.js'
import { assertJobDidNotDeclareIncomplete } from './job-completion.js'
import { jobStreamSignature } from './job-stream-signature.js'
import { isLocalTextModel, resolveJobAutoRetryPolicy } from './job-retry-policy.js'
import { getAppSetting, setAppSetting } from './app-settings.js'
import { classifyJobControl } from './job-control.js'
import { getJobCancellationAuditor, hasJobCancellationAuditor } from './job-cancellation-auditors.js'
import type { JobControl } from '../models/types.js'

// ── Child-process tracking (for cancel → SIGTERM) ───────────────────────────
//
// AsyncLocalStorage lets long-running generators run inside a context that
// identifies their job. Spawn helpers (runFfmpeg, runFfmpegWithStderr) call
// `trackChild(proc)` to register the child against the current job without
// having to thread a jobId through every function signature. When the user
// requests a proven local stop, `requestJobCancellation` sends SIGTERM to every registered child so ffmpeg
// actually stops instead of continuing to burn CPU and disk.
//
// A 5-second SIGKILL fallback handles the rare ffmpeg invocation that
// ignores SIGTERM (e.g., stuck in a syscall).

const jobContext = new AsyncLocalStorage<{ jobId: string }>()
const childrenByJob = new Map<string, Set<ChildProcess>>()

/** Spawn helpers call this AFTER the child starts. Safe no-op if the call
 *  site isn't inside a job context (e.g., /debug/info probing ffmpeg). */
export function trackChild(proc: ChildProcess): void {
  const store = jobContext.getStore()
  if (!store) return
  let set = childrenByJob.get(store.jobId)
  if (!set) {
    set = new Set()
    childrenByJob.set(store.jobId, set)
  }
  set.add(proc)
  const drop = () => {
    const s = childrenByJob.get(store.jobId)
    if (s) {
      s.delete(proc)
      if (s.size === 0) childrenByJob.delete(store.jobId)
    }
  }
  proc.once('close', drop)
  proc.once('exit', drop)
  proc.once('error', drop)
}

/** Current queue job for deep provider clients; undefined outside an executor. */
export function currentJobId(): string | undefined {
  return jobContext.getStore()?.jobId
}

/**
 * Persist a GenStudio-owned state/billing snapshot without interpreting it.
 * This is intentionally additive so old provider evidence stays untouched.
 */
export async function recordGenStudioJob(
  jobId: string,
  snapshot: NonNullable<Job['genstudio_jobs']>[number],
): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return
  const entries = [...(job.genstudio_jobs || [])]
  let index = entries.findIndex(entry => entry.id === snapshot.id)
  if (index < 0 && snapshot.request?.idempotency_key) {
    // The redacted request preview is written BEFORE submission (a request
    // that never gets an id is exactly the one a user needs to read), so it
    // lands under a deterministic `pending:<idempotency-key>` id. Once
    // GenStudio hands back the real id, adopt that entry instead of leaving a
    // duplicate orphan next to it.
    const pendingId = pendingGenStudioEntryId(snapshot.request.idempotency_key)
    index = entries.findIndex(entry => entry.id === pendingId)
  }
  if (index >= 0) {
    const previous = entries[index]!
    // A later state poll carries no request preview; it must not erase the
    // one captured at submission time.
    const request = snapshot.request ?? previous.request
    entries[index] = { ...previous, ...snapshot, ...(request ? { request } : {}) }
  } else entries.push(snapshot)
  job.genstudio_jobs = boundGenStudioRequestPreviews(entries)
  await persistJob(job)
  emitUpdate(job)
  void finalizeSettledProviderJob(job.job_id)
}

function queuedCancellationKey(operation: JobRemoteOperation, providerJobId: string): string {
  return `${operation}:${providerJobId}`
}

/**
 * Atomically claim one already-queued provider cancellation.  The caller that
 * receives true owns the one network POST; every other poller only observes
 * the durable evidence it leaves behind.
 */
export async function claimRemoteCancellation(
  storyJobId: string,
  operation: JobRemoteOperation,
  providerJobId: string,
): Promise<boolean> {
  const job = jobs.get(storyJobId)
  const key = queuedCancellationKey(operation, providerJobId)
  const record = job?.remote_cancellations?.[key]
  if (!job || !record || record.status !== 'queued') return false
  record.status = 'submitting'
  record.updated_at = new Date().toISOString()
  // Claiming is the ownership boundary. Persist it before the provider call
  // can be retried by another in-process poller; a restart reconciles records
  // left in submitting state instead of issuing a second blind POST.
  try {
    await persistJob(job)
  } catch (error) {
    // A control POST without a durable claim can be repeated after a crash.
    // Restore the queued intent so the poller can safely retry persistence;
    // it must not send the provider request on this turn.
    record.status = 'queued'
    record.updated_at = new Date().toISOString()
    throw error
  }
  emitUpdate(job)
  return true
}

/** Record only GenStudio-published cancellation evidence for one exact task. */
export async function recordRemoteCancellation(
  storyJobId: string,
  operation: JobRemoteOperation,
  providerJobId: string,
  evidence: Pick<JobRemoteCancellation, 'status'> & Partial<Omit<JobRemoteCancellation,
    'operation' | 'provider_job_id' | 'requested_at' | 'updated_at' | 'status'>>,
): Promise<void> {
  const job = jobs.get(storyJobId)
  const key = queuedCancellationKey(operation, providerJobId)
  const previous = job?.remote_cancellations?.[key]
  if (!job || !previous) return
  job.remote_cancellations = {
    ...job.remote_cancellations,
    [key]: {
      ...previous,
      ...evidence,
      operation,
      provider_job_id: providerJobId,
      updated_at: new Date().toISOString(),
    },
  }
  await persistJob(job)
  emitUpdate(job)
}

/**
 * A process may crash after persisting `submitting` and before the control
 * socket returns.  A later read-only status poll is the only safe way to
 * release that lock: do not resend the cancellation POST.
 */
export async function reconcileRemoteCancellationFromProvider(
  storyJobId: string,
  operation: JobRemoteOperation,
  providerJobId: string,
  evidence: {
    state: string
    cancelled?: boolean | null
    cancellable?: boolean | null
    cancellation_requested?: boolean | null
    cancellation_note?: string | null
    failure_code?: string | null
    released_credits?: number | null
  },
): Promise<void> {
  const job = jobs.get(storyJobId)
  const key = queuedCancellationKey(operation, providerJobId)
  const previous = job?.remote_cancellations?.[key]
  if (!job || !previous) return
  const settled = evidence.cancelled === true || evidence.state === 'succeeded' || evidence.state === 'failed'
  if (!settled) return
  await recordRemoteCancellation(storyJobId, operation, providerJobId, {
    status: evidence.cancelled === true ? 'confirmed' : 'rejected',
    state: evidence.state,
    ...(evidence.cancellable !== undefined && evidence.cancellable !== null ? { cancellable: evidence.cancellable } : {}),
    ...(evidence.cancelled !== undefined && evidence.cancelled !== null ? { cancelled: evidence.cancelled } : {}),
    ...(evidence.cancellation_requested !== undefined && evidence.cancellation_requested !== null ? { cancellation_requested: evidence.cancellation_requested } : {}),
    ...(evidence.cancellation_note !== undefined ? { cancellation_note: evidence.cancellation_note } : {}),
    ...(evidence.failure_code !== undefined ? { failure_code: evidence.failure_code } : {}),
    ...(Number.isFinite(evidence.released_credits) ? { released_credits: evidence.released_credits as number } : {}),
  })
}

function killChildrenFor(jobId: string): void {
  const set = childrenByJob.get(jobId)
  if (!set || set.size === 0) return
  for (const proc of set) {
    try { proc.kill('SIGTERM') } catch { /* already dead */ }
  }
  // Escalate to SIGKILL after 5s for any child that ignored SIGTERM.
  setTimeout(() => {
    const still = childrenByJob.get(jobId)
    if (!still) return
    for (const proc of still) {
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
    }
  }, 5_000).unref()
}

/**
 * Shutdown helper: SIGTERM every tracked child across every job, then
 * SIGKILL fallback after `killAfterMs`. Returns the list of pids that
 * received SIGTERM so callers can log a summary.
 *
 * Used by the Electron `before-quit` handler. Without this, a clean quit
 * leaves FFmpeg children running until they finish on their own (orphaned
 * to launchd) — they keep writing to the project's output directory while
 * the next launch shows the corresponding job as "Interrupted by app
 * restart". The user sees a failed job and an unexpectedly busy CPU.
 */
export function killAllTrackedChildren(killAfterMs = 2_000): number[] {
  const pids: number[] = []
  for (const set of childrenByJob.values()) {
    for (const proc of set) {
      if (typeof proc.pid === 'number') pids.push(proc.pid)
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
    }
  }
  // Snapshot the current child set so the SIGKILL pass operates on the
  // same processes — not on anything spawned during the drain window.
  const snapshot: ChildProcess[] = []
  for (const set of childrenByJob.values()) for (const p of set) snapshot.push(p)
  setTimeout(() => {
    for (const proc of snapshot) {
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
    }
  }, killAfterMs).unref()
  return pids
}

/** Test-only: count tracked children across all jobs. */
export function _trackedChildCountForTesting(): number {
  let n = 0
  for (const set of childrenByJob.values()) n += set.size
  return n
}

// ── Event bus ───────────────────────────────────────────────────────────────
// Emits 'update' for every persisted job transition and 'cleared' when a
// project's finished jobs get cleared. Consumed by the SSE stream route in
// routes/jobs.ts so the renderer sees state changes the instant they happen
// instead of waiting up to 3 s for the old polling cadence.
//
// setMaxListeners: one listener per open SSE connection. The app is
// single-instance (see main.ts requestSingleInstanceLock) so 50 is orders
// of magnitude beyond anything realistic.
export const jobEvents = new EventEmitter()
jobEvents.setMaxListeners(50)
const lastLiveStreamSignatures = new Map<string, string>()

function emitUpdate(job: Job): void {
  if (job.status === 'running') {
    lastLiveStreamSignatures.set(job.job_id, jobStreamSignature(job))
  } else {
    lastLiveStreamSignatures.delete(job.job_id)
  }
  // Isolate listeners from each other — one bad handler shouldn't break the
  // queue's state machine. EventEmitter.emit is synchronous, so any throw
  // would propagate into the generator; swallow defensively.
  try { jobEvents.emit('update', serializeJob(job)) } catch { /* noop */ }
}

// Stream running jobs' output_lines to SSE subscribers on a modest cadence.
// Without this, emitUpdate only fires on status transitions (queued→running
// and running→done/error/cancelled) plus the occasional account-attribution
// event, so the frontend sees `output_lines` frozen between those sparse
// triggers — visible as "live log goes dark during a 10-minute FFmpeg run"
// until the job completes and one terminal update ships the entire array.
//
// Only changed fingerprints are emitted. Previously every running job sent its
// complete output_lines array every 700 ms even while waiting on a provider;
// those identical frames forced every page to reprocess global job state.
// `.unref()` keeps the timer from holding the process alive at shutdown.
const LIVE_OUTPUT_FLUSH_MS = 1_500
setInterval(() => {
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue
    const signature = jobStreamSignature(job)
    if (lastLiveStreamSignatures.get(job.job_id) === signature) continue
    emitUpdate(job)
  }
}, LIVE_OUTPUT_FLUSH_MS).unref()

export interface JobsClearedEvent { project_slug: string; job_ids: string[] }
function emitCleared(projectSlug: string, jobIds: string[]): void {
  try { jobEvents.emit('cleared', { project_slug: projectSlug, job_ids: jobIds } satisfies JobsClearedEvent) } catch { /* noop */ }
}

// Live work is never subject to history retention. A project may intentionally
// hold hundreds or thousands of queued jobs while GenStudio admits them at the
// account's own pace. Only terminal history is bounded so jobs.json cannot grow
// forever after completed runs.
export const MAX_PERSISTED_TERMINAL_HISTORY = 750
const TERMINAL_JOB_STATUSES = new Set(['done', 'error', 'cancelled'])

function persistedJobTime(job: Pick<Job, 'finished_at' | 'created_at'>): number {
  const raw = job.finished_at || job.created_at
  const parsed = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Preserve every live/nonterminal job and retain only the newest terminal
 * history. The final filter keeps the source ordering intact, which is the
 * durable FIFO order used when queued jobs are restored after restart.
 */
export function retainJobsForPersistence<T extends Pick<Job, 'job_id' | 'status' | 'finished_at' | 'created_at'>>(
  records: T[],
): T[] {
  const terminal = records
    .filter(job => TERMINAL_JOB_STATUSES.has(job.status))
    .sort((a, b) => persistedJobTime(b) - persistedJobTime(a))
    .slice(0, MAX_PERSISTED_TERMINAL_HISTORY)
  const retainedTerminalIds = new Set(terminal.map(job => job.job_id))

  return records.filter(job => (
    !TERMINAL_JOB_STATUSES.has(job.status)
    || retainedTerminalIds.has(job.job_id)
  ))
}

// ── In-memory state ─────────────────────────────────────────────────────────

const jobs = new Map<string, Job>()
const providerFinalizing = new Set<string>()
const cancelled = new Set<string>()
const pauseRequested = new Set<string>()
const loadedProjects = new Set<string>()
const loadingProjects = new Map<string, Promise<void>>()
const PENDING_REMOTE_CANCELLATION_STATUSES = new Set(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])

function hasPendingRemoteCancellation(job: Pick<Job, 'remote_cancellations'>): boolean {
  return Object.values(job.remote_cancellations || {}).some(record => PENDING_REMOTE_CANCELLATION_STATUSES.has(record.status))
}

/**
 * A Story executor returning is not a provider settlement.  Keep its duplicate
 * lock until every durable GenStudio target has an authoritative terminal
 * state; a target excluded from the Cancel button still counts.
 */
export function hasUnsettledProviderWork(job: Pick<Job, 'genstudio_jobs' | 'remote_cancellations'>): boolean {
  // Ordinary providers already keep their own executor pending. This extra
  // cross-target hold begins only once the customer requests cancellation;
  // otherwise legacy durable chat recovery would be stranded without its
  // established retry/reconciliation path.
  if (Object.keys(job.remote_cancellations || {}).length === 0) return false
  if (hasPendingRemoteCancellation(job)) return true
  return (job.genstudio_jobs || []).some(entry => (
    entry.cancelled !== true
    && entry.state !== 'succeeded'
    && entry.state !== 'failed'
  ))
}

function hasCancellationContext(job: Pick<Job, 'remote_cancellations'>): boolean {
  return Object.keys(job.remote_cancellations || {}).length > 0
}

/** Finalize only after a returned local executor and authoritative provider settlement. */
async function finalizeSettledProviderJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'running' || !job.local_execution_complete) return
  if (!hasCancellationContext(job) || hasUnsettledProviderWork(job)) return
  if (providerFinalizing.has(jobId)) return
  providerFinalizing.add(jobId)
  try {
    const evidence = job.genstudio_jobs || []
    if (!evidence.length) return
    if (evidence.every(entry => entry.cancelled === true)) {
      job.status = 'cancelled'
      job.error = null
      job.output_lines.push('GenStudio confirmed cancellation for every provider task.')
    } else if (evidence.some(entry => entry.state === 'failed' && entry.cancelled !== true)) {
      job.status = 'error'
      job.error = 'A GenStudio provider task failed after cancellation reconciliation. Provider evidence is retained.'
      job.output_lines.push(job.error)
    } else if (evidence.some(entry => entry.state === 'succeeded')) {
      const auditor = getJobCancellationAuditor(job.type)
      if (!auditor) {
        job.output_lines.push('Provider work settled, but no output auditor is registered. Keeping this job running until output can be verified.')
        await persistJob(job)
        emitUpdate(job)
        return
      }
      let audit: 'complete' | 'repair-required'
      try { audit = await auditor(serializeJob(job)) }
      catch (error) {
        job.output_lines.push(`Provider work settled, but output audit could not run: ${error instanceof Error ? error.message : String(error)}. Keeping this job running.`)
        await persistJob(job)
        emitUpdate(job)
        return
      }
      if (audit !== 'complete') {
        job.status = 'error'
        job.error = 'Provider output needs repair before this job can be marked complete. Retry repairs only missing output.'
        job.output_lines.push(job.error)
      } else {
        job.status = 'done'
        job.error = null
        job.output_lines.push('Provider work settled and required output was verified.')
      }
    } else {
      // A terminal response with no success, failure, or confirmed cancellation
      // is not a success signal. Keep the duplicate lock and await Task 5's
      // operation-specific reconciliation.
      job.output_lines.push('Provider settlement is terminal but not yet classifiable; keeping this job running for reconciliation.')
      await persistJob(job)
      emitUpdate(job)
      return
    }
    job.finished_at = new Date().toISOString()
    await persistJob(job)
    emitUpdate(job)
  } finally {
    providerFinalizing.delete(jobId)
  }
}

// Durable Story-side queue hold. When set, pump() will not dequeue the next
// job. The Jobs workspace controls it explicitly; provider jobs already
// accepted upstream are allowed to checkpoint before becoming paused.
let queuePaused = false
let queuePauseLoaded = false
const QUEUE_PAUSED_KEY = 'job_queue_paused'

export class JobPausedError extends Error {
  constructor() {
    super('Paused by user')
    this.name = 'JobPausedError'
  }
}

export function isPauseRequested(jobId: string): boolean {
  return pauseRequested.has(jobId)
}

export function throwIfPauseRequested(jobId: string): void {
  if (isPauseRequested(jobId)) throw new JobPausedError()
}

// Simple async FIFO queues
type JobExecutor = (job: Job) => Promise<void>

interface QueueState {
  pending: Job[]
  running: boolean
  executor: JobExecutor | null
}

const queues: Record<JobType, QueueState> = {
  idea_campaign: { pending: [], running: false, executor: null },
  broll_select: { pending: [], running: false, executor: null },
  // Legacy `script` queue removed in M1 — chapters and intro now flow
  // through `script-only` and `introduction-only` independently. The
  // per-chapter refactor added `chapter-only` for targeted regens.
  'script-only': { pending: [], running: false, executor: null },
  'introduction-only': { pending: [], running: false, executor: null },
  'chapter-only': { pending: [], running: false, executor: null },
  // v1.0.72+ outline-first chunked flow. outline_only is a small LLM call
  // (one batch); expand_chapters is the heavier multi-batch expansion.
  // They share queue plumbing with the other script jobs.
  outline_only: { pending: [], running: false, executor: null },
  expand_chapters: { pending: [], running: false, executor: null },
  image_prompts: { pending: [], running: false, executor: null },
  images: { pending: [], running: false, executor: null },
  scene_images: { pending: [], running: false, executor: null },
  thumb_images: { pending: [], running: false, executor: null },
  // Image repair uses the queue lifecycle but never submits a new provider job.
  images_repair: { pending: [], running: false, executor: null },
  audio: { pending: [], running: false, executor: null },
  audio_merge: { pending: [], running: false, executor: null },
  metadata: { pending: [], running: false, executor: null },
  video: { pending: [], running: false, executor: null },
  video_assembly: { pending: [], running: false, executor: null },
  subtitles_transcribe: { pending: [], running: false, executor: null },
  // Upload Center — YouTube video upload (resumable) + metadata PATCH.
  youtube_upload: { pending: [], running: false, executor: null },
  // Playlist-only update — adds an existing video to a playlist via
  // playlistItems.insert. The executor performs a 1-unit membership read
  // before and after mutation so Retry never creates duplicate entries or
  // repeats the 50-unit insert after an ambiguous provider response.
  // It gets its own queue slot rather
  // than blocking behind the heavier upload queue.
  youtube_playlist_update: { pending: [], running: false, executor: null },
  // Backfill thumbnails onto already-uploaded videos (thumbnails.set only,
  // no re-upload). Quota-paced + resumable — own slot so it doesn't block
  // real uploads.
  youtube_thumbnail_refresh: { pending: [], running: false, executor: null },
  // v1.0.89+: B-Roll normalize job. Re-encodes one stock-footage clip to
  // 1080p at the pool's target fps (24 default, 30 optional) so Video
  // Assembly can concat-demux for speed instead of running a per-frame
  // filtergraph at render time. Auto-queued on import when the pool's
  // auto_normalize flag is on (default).
  broll_normalize: { pending: [], running: false, executor: null },
  // B-Roll assembly — concat selected clips + mix narration → final MP4.
  broll_assemble: { pending: [], running: false, executor: null },
  // Vision-LLM auto-tag — frames a clip's midpoint, asks GPT-4o-mini
  // for short tags, writes to the pool sidecar. Cheap (~$0.002/clip).
  broll_autotag: { pending: [], running: false, executor: null },
  // v1.0.142+: Research phase for the timestamp-driven pipeline.
  // One-shot adapter call (Perplexity / LLM-only)
  // → writes research.json + research.md to the episode dir.
  research_run: { pending: [], running: false, executor: null },
  // v1.0.143+: Scene planner — LLM picks natural narrative beats
  // against the stitched SRT, emits scene_plan.json. 20-60s call.
  scene_plan_run: { pending: [], running: false, executor: null },
  // v1.0.741+: constrained documentary annotation proposals. One durable
  // episode job, internally packed; human review remains mandatory.
  contextual_cues: { pending: [], running: false, executor: null },
  // v1.0.144+: Per-scene image gen for the timestamp-driven pipeline.
  // One job per scene; bulk "Generate all missing" enqueues N of these.
  scene_image_generate: { pending: [], running: false, executor: null },
  // Bulk Scene Plan image generation with per-scene durable checkpoints.
  scene_images_batch: { pending: [], running: false, executor: null },
  // v1.0.470 — Phase 2: animate one scene's image into a clip (image-to-video).
  scene_clip_generate: { pending: [], running: false, executor: null },
  scene_clips_batch: { pending: [], running: false, executor: null },
  // v1.0.410+: generate stills into an Image Pool (grow the pool).
  image_pool_generate: { pending: [], running: false, executor: null },
  // v1.0.194+: continuity-chain sequential renderer. Renders every scene in
  // scene_plan.json in order, each img2img-anchored to the previous render +
  // the character sheet/characters. One long serial job (resumable).
  continuity_render: { pending: [], running: false, executor: null },
  // v1.0.260: Prompt Director — rewrites scene prompts into the explainer
  // composition (guide-at-side + framed subject) per the Visual Recipe.
  prompt_director: { pending: [], running: false, executor: null },
  // v1.0.260: generate the composition LAYOUT template image from a prompt.
  composition_generate: { pending: [], running: false, executor: null },
  // v1.0.386: Fish S2 expression "Tag all" — LLM markup over every section,
  // saved incrementally so it survives the operator leaving the page.
  expression_markup: { pending: [], running: false, executor: null },
}

/**
 * The set of JobTypes that have a real queue lane. `enqueue()` indexes
 * `queues[type]` directly, so enqueuing a type absent here throws a TypeError
 * (`Cannot read 'pending' of undefined`). Exposed so callers/tests can verify a
 * derived job type is enqueueable BEFORE it reaches the queue.
 */
export function knownJobTypes(): JobType[] {
  return Object.keys(queues) as JobType[]
}

/** Preventive audit hook: every declared job type must be wired at boot. */
export function unregisteredJobTypes(): JobType[] {
  return knownJobTypes().filter(type => queues[type].executor == null)
}

// ── Concurrency groups ──────────────────────────────────────────────────────
//
// Most job types run strictly one-at-a-time (their own group, limit 1):
// image/video/audio/ffmpeg/upload work would thrash the machine or trip
// provider rate limits if overlapped. The LLM *text* generators are the
// exception — they're cheap, I/O-bound, and the LM Studio dispatcher already
// spreads concurrent calls least-busy across the endpoint pool. Different
// episodes are independent (separate folders; enqueue dedup already forbids
// two jobs on the *same* episode+type), so several can safely run at once.
//
// GenStudio-bound text jobs share one local staging lane across all types.
// This is not an account execution limit: GenStudio's durable admission queue
// remains authoritative for paid concurrency, submission rate, and capacity.
const LLM_GROUP = 'llm'
const LOCAL_LLM_GROUP = 'local_llm'
const SUBTITLE_TRANSCRIBE_GROUP = 'subtitle_transcribe'
const LLM_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'idea_campaign', 'outline_only', 'expand_chapters', 'metadata', 'image_prompts', 'scene_plan_run',
])
function usesLocalTextFleet(job: Job | undefined): boolean {
  if (!job || !LLM_TYPES.has(job.type)) return false
  if (job.type === 'scene_plan_run' && (job.params?.stage === 'timeline' || job.params?.model === 'deterministic-timeline')) {
    return true
  }
  const model = [job.params?.model, job.params?.vision_model, job.params?.ai_model, job.params?.llm_model]
    .find(value => typeof value === 'string' && value.trim())
  return typeof model === 'string' && isLocalTextModel(model)
}

function groupOf(type: JobType, job?: Job): string {
  if (type === 'subtitles_transcribe') return SUBTITLE_TRANSCRIBE_GROUP
  if (usesLocalTextFleet(job)) return LOCAL_LLM_GROUP
  return LLM_TYPES.has(type) ? LLM_GROUP : type
}
/** Active (running) job count for the shared LLM group. Non-LLM types track
 *  their single slot via `QueueState.running` (unchanged). */
const groupActive: Record<string, number> = {}
/** A generous local staging cap keeps Story responsive without recreating a
 * user-facing concurrency policy that can conflict with GenStudio. */
let llmConcurrency = 50
let subtitleTranscribeConcurrency = 50
export function setLlmConcurrency(n: number): void {
  llmConcurrency = Math.max(1, Math.min(50, Math.floor(Number(n)) || 1))
}
export function getLlmConcurrency(): number {
  return llmConcurrency
}
export function setSubtitleTranscribeConcurrency(n: number): void {
  subtitleTranscribeConcurrency = Math.max(1, Math.min(50, Math.floor(Number(n)) || 1))
  pump('subtitles_transcribe')
}
export function getSubtitleTranscribeConcurrency(): number {
  return subtitleTranscribeConcurrency
}
function groupLimit(group: string): number {
  if (group === LLM_GROUP) return llmConcurrency
  // Local Chat Studio work is admitted immediately; its own dispatcher owns
  // the machine queue and backpressure.
  if (group === LOCAL_LLM_GROUP) return Number.POSITIVE_INFINITY
  if (group === SUBTITLE_TRANSCRIBE_GROUP) return subtitleTranscribeConcurrency
  return 1
}

// ── Persistence ─────────────────────────────────────────────────────────────

function jobsPath(projectSlug: string): string {
  // Honour linked-project locations so iCloud-synced projects read +
  // write their jobs.json in the right place.
  const dir = getProjectDir(projectSlug) || path.join(projectsRoot(), projectSlug)
  return path.join(dir, 'jobs.json')
}

async function persistProjectSnapshot(projectSlug: string): Promise<void> {
  const p = jobsPath(projectSlug)
  await withLock(p, async () => {
    const remaining = retainJobsForPersistence(Array.from(jobs.values())
      .filter(j => j.project_slug === projectSlug)
      .map(j => safeJob(j)))
    await writeJsonAtomic(p, { jobs: remaining })
  })
}

function safeJob(job: Job): Omit<Job, never> {
  // Jobs are both renderer-visible diagnostics and durable project records.
  // Provider adapters should never put credentials in params/output, but this
  // final boundary is deny-by-default so an accidental future field cannot
  // leak into jobs.json, SSE, exports, or support screenshots.
  const copy = redactSensitiveValue(structuredClone(job))
  delete copy.control
  return copy
}

/** Public job snapshots derive controls at the last possible moment. */
function serializeJob(job: Job): Job {
  const copy = safeJob(job)
  copy.control = classifyJobControl(job, {
    remoteCancellationAudited: hasJobCancellationAuditor(job.type),
  })
  return copy
}

async function persistJob(job: Job): Promise<void> {
  const p = jobsPath(job.project_slug)
  // Lock + atomic write: concurrent generators can finish at the same time and
  // would otherwise race `read → splice → write` on this shared file.
  await withLock(p, async () => {
    let data: { jobs: any[] } = { jobs: [] }
    try {
      if (existsSync(p)) {
        data = JSON.parse(await fs.readFile(p, 'utf-8'))
        if (!Array.isArray(data.jobs)) data.jobs = []
      }
    } catch { /* corrupt or missing — start fresh */ }

    const idx = data.jobs.findIndex((j: any) => j.job_id === job.job_id)
    if (idx >= 0) {
      data.jobs[idx] = safeJob(job)
    } else {
      data.jobs.push(safeJob(job))
    }

    data.jobs = retainJobsForPersistence(data.jobs)

    await writeJsonAtomic(p, data)
  })
}

/**
 * Persist a durable checkpoint while a long-running executor is still active.
 * Accepted GenStudio work uses this so a monitoring disconnect can reconnect
 * without submitting it again.
 */
export async function checkpointJobState(job: Job): Promise<void> {
  await persistJob(job)
  emitUpdate(job)
}

// ── Lazy load persisted jobs on first access ────────────────────────────────

async function readPersistedJobs(projectSlug: string): Promise<void> {
  const p = jobsPath(projectSlug)
  const resumedTypes = new Set<JobType>()
  try {
    if (existsSync(p)) {
      const data = JSON.parse(await fs.readFile(p, 'utf-8'))
      for (const j of data.jobs || []) {
        if (!jobs.has(j.job_id)) {
          // Durable queued jobs keep their identity and rejoin their lane.
          // Previously-running jobs need a provider checkpoint to recover;
          // otherwise they become a loud interrupted error. Persist every
          // mutation so jobs.json and the in-memory queue cannot disagree.
          let mutated = false
          if (j.status === 'queued') {
            const queue = queues[j.type as JobType]
            if (queue?.executor) {
              j.started_at = null
              j.finished_at = null
              queue.pending.push(j)
              resumedTypes.add(j.type as JobType)
            } else {
              j.status = 'error'
              j.error = 'Interrupted by app restart'
              j.finished_at = j.finished_at || new Date().toISOString()
            }
            mutated = true
          } else if (j.status === 'running') {
            const genStudioRecovery = j.params?.genstudio_recovery
            const genStudioAssets = genStudioRecovery?.version === 1
              && genStudioRecovery?.route === 'genstudio'
              && genStudioRecovery?.assets
              && typeof genStudioRecovery.assets === 'object'
              ? Object.values(genStudioRecovery.assets) as Array<Record<string, unknown>>
              : []
            const recoverableGenStudio = ['audio', 'subtitles_transcribe'].includes(j.type)
              && !!queues[j.type as JobType]?.executor
              && genStudioAssets.some(asset => (
                (asset?.operation === 'tts' || asset?.operation === 'transcription')
                && typeof asset?.idempotency_key === 'string'
                && asset.idempotency_key.startsWith('story-')
                && asset?.state !== 'failed'
              ))
            if (recoverableGenStudio) {
              j.status = 'queued'
              j.started_at = null
              j.finished_at = null
              j.error = null
              j.output_lines = Array.isArray(j.output_lines) ? j.output_lines : []
              j.output_lines.push('↻ Story Studio restarted — resuming the checkpointed GenStudio asset job automatically; the saved request identity will be reused and no direct fallback will run.')
              queues[j.type as JobType].pending.push(j)
              resumedTypes.add(j.type as JobType)
            } else {
              j.status = 'error'
              j.error = 'Interrupted by app restart'
              j.finished_at = j.finished_at || new Date().toISOString()
            }
            mutated = true
          } else if (j.status === 'paused') {
            j.pause_requested = false
            mutated = true
          }
          jobs.set(j.job_id, j)
          if (mutated) {
            try { await persistJob(j) } catch (e: any) {
              // Best-effort — disk full / perms drift. The in-memory
              // mutation still applies for this process; next successful
              // persist (e.g. when the user clicks "clear" or a new job
              // runs) will heal the file via the queue's atomic-rewrite
              // path. Logging at warn level so the operator can spot it
              // if it becomes chronic.
              console.warn('[job-queue] failed to persist interrupted-job mutation', { job_id: j.job_id, error: e?.message })
            }
          }
        }
      }
    }
    for (const type of resumedTypes) pump(type)
  } catch { /* ignore corrupt file */ }
}

async function loadPersistedJobs(projectSlug: string): Promise<void> {
  if (loadedProjects.has(projectSlug)) return
  const existing = loadingProjects.get(projectSlug)
  if (existing) return existing

  const loading = readPersistedJobs(projectSlug)
  loadingProjects.set(projectSlug, loading)
  try {
    await loading
    // Corrupt/missing history is still a settled load: preserve the old
    // one-attempt semantics while every concurrent caller shares this result.
    loadedProjects.add(projectSlug)
  } finally {
    loadingProjects.delete(projectSlug)
  }
}

/**
 * Eager boot scan for checkpointed GenStudio work. Ordinary job history is loaded
 * lazily per project, but recovery cannot depend on somebody opening the Jobs
 * page after a power cut. Executors call this once after every queue lane has
 * been registered; loadPersistedJobs then requeues only checkpoints that can
 * safely reconnect without duplicating generation.
 */
export async function resumeInterruptedJobsAtBoot(): Promise<void> {
  const { listProjects } = await import('./project-manager.js')
  const projects = await listProjects()
  for (const project of projects as Array<{ slug?: string }>) {
    if (typeof project?.slug === 'string' && project.slug) await loadPersistedJobs(project.slug)
  }
}

// ── Queue processing ────────────────────────────────────────────────────────

/**
 * Launch as many pending jobs of `type` as its concurrency group allows.
 * Non-LLM types keep a single slot (`q.running`, unchanged); LLM types share
 * the `llmConcurrency` budget across the whole group. Synchronous: the whole
 * budget is consumed before any launched job yields, so no double-launch race.
 */
function pump(type: JobType): void {
  if (queuePaused) return  // network is down; jobs wait
  const q = queues[type]
  const next = q.pending[0]
  const group = groupOf(type, next)
  if (group === LLM_GROUP || group === LOCAL_LLM_GROUP || group === SUBTITLE_TRANSCRIBE_GROUP) {
    while (q.pending.length > 0 && (groupActive[group] || 0) < groupLimit(group)) {
      if (groupOf(type, q.pending[0]) !== group) break
      const job = q.pending.shift()!
      groupActive[group] = (groupActive[group] || 0) + 1
      runJob(type, job).catch(e => console.error(`[job-queue] Error processing ${type}:`, e))
    }
    // A single job-type FIFO can contain adjacent local and cloud work. They
    // have independent budgets, so let the next lane claim its head now rather
    // than waiting for an unrelated local job to finish first.
    if (q.pending.length > 0 && groupOf(type, q.pending[0]) !== group) {
      queueMicrotask(() => pump(type))
    }
  } else {
    if (q.running || q.pending.length === 0) return
    q.running = true
    const job = q.pending.shift()!
    runJob(type, job).catch(e => console.error(`[job-queue] Error processing ${type}:`, e))
  }
}

/** A freed LLM slot can be taken by ANY text generator, not just the one that
 *  finished — so re-pump every type in the group. */
function pumpGroup(group: string): void {
  if (group === LLM_GROUP || group === LOCAL_LLM_GROUP) for (const t of LLM_TYPES) pump(t)
  else if (group === SUBTITLE_TRANSCRIBE_GROUP) pump('subtitles_transcribe')
}

/** Release the slot a finished job held, then pull in the next work. */
function releaseSlot(type: JobType, job: Job): void {
  const group = groupOf(type, job)
  if (group === LLM_GROUP || group === LOCAL_LLM_GROUP || group === SUBTITLE_TRANSCRIBE_GROUP) {
    groupActive[group] = Math.max(0, (groupActive[group] || 0) - 1)
    pumpGroup(group)
  } else {
    queues[type].running = false
    pump(type)
  }
}

/**
 * Persist a chain handoff failure as its own terminal job. Without this record
 * the completed parent looked successful and batch aggregation had no evidence
 * that every downstream step was silently abandoned.
 */
async function recordChainHandoffFailure(
  parent: Job,
  nextStep: { type?: unknown; title?: unknown; params?: unknown },
  rest: unknown[],
  cause: unknown,
): Promise<Job> {
  const now = new Date().toISOString()
  const type = String(nextStep?.type || 'unknown') as JobType
  const message = cause instanceof Error ? cause.message : String(cause)
  const batchId = parent.params?.pipeline_batch_id
  const failed: Job = {
    job_id: randomUUID().slice(0, 8),
    project_slug: parent.project_slug,
    type,
    episode_id: parent.episode_id,
    title: typeof nextStep?.title === 'string'
      ? nextStep.title
      : `[batch] ${type} — ${parent.episode_id}`,
    status: 'error',
    created_at: now,
    started_at: now,
    finished_at: now,
    error: `Pipeline handoff failed before this step started: ${message}`,
    output_lines: [
      `Previous step: ${parent.type} (${parent.job_id})`,
      `Could not start ${type}: ${message}`,
      'No provider call was made for this step. Use the batch Retry action to run only unfinished work.',
    ],
    params: {
      ...((nextStep?.params && typeof nextStep.params === 'object') ? nextStep.params : {}),
      episode_id: parent.episode_id,
      pipeline_chain: rest,
      ...(batchId ? { pipeline_batch_id: batchId } : {}),
      pipeline_handoff_failed: true,
      pipeline_parent_job_id: parent.job_id,
    },
  }
  jobs.set(failed.job_id, failed)
  await persistJob(failed)
  emitUpdate(failed)
  return failed
}

/**
 * Subtitle verification is warning-only for the late YouTube Finalizer.
 * Preserve the failed subtitle job for repair/audit, but do not abandon a
 * directly-following metadata step: its own finalizer records the incomplete
 * subtitle warning while still using authoritative Audio Assembly timing.
 */
async function continueFinalizerAfterSubtitleFailure(job: Job): Promise<void> {
  if (job.type !== 'subtitles_transcribe') return
  const chain = job.params?.pipeline_chain
  if (!Array.isArray(chain) || chain.length === 0) return
  const [nextStep, ...rest] = chain
  if (nextStep?.type !== 'metadata') return

  try {
    const batchId = job.params?.pipeline_batch_id
    enqueue({
      project_slug: job.project_slug,
      type: 'metadata',
      episode_id: job.episode_id,
      title: nextStep.title || `[batch] metadata — ${job.episode_id}`,
      params: {
        ...(nextStep.params || {}),
        episode_id: job.episode_id,
        pipeline_chain: rest,
        ...(batchId ? { pipeline_batch_id: batchId } : {}),
        subtitle_verification_warning: job.error || 'Subtitle generation did not complete.',
      },
    })
    job.output_lines.push(
      '→ Subtitle verification remains failed and repairable; YouTube Finalizer was still queued with a warning.',
    )
  } catch (error) {
    const failed = await recordChainHandoffFailure(job, nextStep, rest, error)
    job.output_lines.push(
      `Finalizer handoff failed after the subtitle warning (recorded as failed job ${failed.job_id}).`,
    )
  }
}

/**
 * Full lifecycle for one job: mark running → run executor → persist final
 * status → chain the next pipeline step → release the slot. Fire-and-forget
 * from pump(); the `finally` guarantees the slot is released even on error so
 * the queue never deadlocks.
 */
async function runJob(type: JobType, job: Job): Promise<void> {
  const q = queues[type]
  try {
    if (cancelled.has(job.job_id)) {
      job.status = 'cancelled'
      job.finished_at = new Date().toISOString()
      jobs.set(job.job_id, job)
      await persistJob(job)
      emitUpdate(job)
      return
    }

    // Mark running and publish the retry contract before the executor starts.
    // The classifier is deny-by-default: an absent/unknown provider is never
    // assumed free, so a future API-backed generator cannot silently resubmit.
    const retryPolicy = resolveJobAutoRetryPolicy(job)
    job.auto_retry = {
      eligible: retryPolicy.eligible,
      reason: retryPolicy.reason,
      attempt: 1,
      max_attempts: retryPolicy.max_attempts,
    }
    job.status = 'running'
    job.pause_requested = false
    job.started_at ||= new Date().toISOString()
    jobs.set(job.job_id, job)
    await persistJob(job)
    emitUpdate(job)

    try {
      if (!q.executor) throw new Error(`No executor registered for job type: ${type}`)
      let completed = false
      let finalError: unknown = null
      for (let attempt = 1; attempt <= retryPolicy.max_attempts; attempt++) {
        job.auto_retry = {
          eligible: retryPolicy.eligible,
          reason: retryPolicy.reason,
          attempt,
          max_attempts: retryPolicy.max_attempts,
        }
        job.error = null
        if (attempt > 1) {
          // Files on disk are the durable partial result. Clear stale transient
          // completion/progress so this attempt must perform its own audit.
          job.result = undefined
          job.progress = 0
          job.output_lines.push(`↻ Local auto-retry attempt ${attempt}/${retryPolicy.max_attempts} — checking disk and repairing only missing work.`)
          await persistJob(job)
          emitUpdate(job)
        }

        try {
          if (cancelled.has(job.job_id)) throw new Error('Cancelled by user')
          throwIfPauseRequested(job.job_id)
          // Run the executor inside a per-job AsyncLocalStorage context so any
          // child processes spawned deep in the call tree register against this
          // job id via `trackChild(proc)`. Without this, a cancelled FFmpeg
          // assembly would keep running until it finished or hit an error.
          await jobContext.run({ jobId: job.job_id }, () => q.executor!(job))
          job.local_execution_complete = true
          throwIfPauseRequested(job.job_id)
          assertJobDidNotDeclareIncomplete(job)
          completed = true
          break
        } catch (error) {
          finalError = error
          if (cancelled.has(job.job_id)) throw error
          if (error instanceof JobPausedError || pauseRequested.has(job.job_id)) throw new JobPausedError()
          if (!retryPolicy.eligible || attempt >= retryPolicy.max_attempts) break

          const delayMs = retryPolicy.delays_ms[attempt - 1] ?? retryPolicy.delays_ms.at(-1) ?? 2_000
          const message = error instanceof Error ? error.message : String(error)
          job.auto_retry.next_retry_at = new Date(Date.now() + delayMs).toISOString()
          job.output_lines.push(
            `↻ Local attempt ${attempt}/${retryPolicy.max_attempts} was incomplete: ${message}`,
            `  Auto-retrying in ${Math.ceil(delayMs / 1_000)}s. Verified files already saved will be kept; no paid API request will be made.`,
          )
          await persistJob(job)
          emitUpdate(job)
          await waitForLocalRetry(job.job_id, delayMs)
        }
      }

      if (!completed) {
        if (job.auto_retry?.eligible) {
          job.auto_retry.exhausted = true
          job.output_lines.push(`✗ Local auto-retry exhausted after ${retryPolicy.max_attempts} attempts. Verified partial files remain on disk; manual Retry starts another free recovery cycle.`)
        } else {
          job.output_lines.push(`ℹ Automatic retry not used: ${retryPolicy.reason}`)
        }
        throw finalError instanceof Error ? finalError : new Error(String(finalError || 'Job failed'))
      }
      if (job.auto_retry) {
        delete job.auto_retry.next_retry_at
        job.auto_retry.exhausted = false
      }
      if (hasUnsettledProviderWork(job)) {
        job.output_lines.push('Provider work remains unsettled. Story Studio will reconcile every accepted task before marking this job complete.')
      } else if (hasCancellationContext(job)) {
        await finalizeSettledProviderJob(job.job_id)
      } else if (cancelled.has(job.job_id)) {
        // Job was cancelled while running — don't override status
        // (a local stop may have already set status from another call context)
        job.status = 'cancelled'
      } else if (job.status === 'running') {
        job.status = 'done'
        // Track generation for session stats
        const typeMap: Record<string, 'script' | 'image' | 'audio'> = { 'script-only': 'script', 'introduction-only': 'script', 'chapter-only': 'script', images: 'image', scene_images: 'image', thumb_images: 'image', audio: 'audio', audio_merge: 'audio', video: 'image' }
        const trackType = typeMap[job.type]
        if (trackType) {
          trackGeneration(job.project_slug, trackType).catch(() => {})
        }

        // Pipeline batch auto-chain: if this job was queued as part of a
        // batch run (see routes/pipeline.ts), enqueue the next step for the
        // same episode. Chain naturally stops on failure/cancellation because
        // we only get here when status === 'running' → 'done' transitions.
        const chain = job.params?.pipeline_chain
        if (Array.isArray(chain) && chain.length > 0) {
          const [nextStep, ...rest] = chain
          if (nextStep && typeof nextStep.type === 'string') {
            try {
              const batchId = job.params.pipeline_batch_id
              const nextParams = {
                ...(nextStep.params || {}),
                episode_id: job.episode_id,
                pipeline_chain: rest,
                ...(batchId ? { pipeline_batch_id: batchId } : {}),
              }
              const joined = nextStep.type === 'continuity_render' && !nextParams.single_scene_id
                ? await joinActiveBulkSceneRender({
                    project_slug: job.project_slug,
                    episode_id: job.episode_id,
                    pipeline_chain: rest,
                    pipeline_batch_id: batchId,
                  })
                : null
              if (joined?.conflict) {
                throw new Error(`An existing scene render already owns a different Pipeline continuation for ${job.episode_id}`)
              }
              if (joined) {
                job.output_lines.push(`→ Joined existing scene render ${joined.job.job_id}; duplicate Hub work was not queued.`)
              } else {
                enqueue({
                  project_slug: job.project_slug,
                  type: nextStep.type as JobType,
                  episode_id: job.episode_id,
                  title: nextStep.title || `[batch] ${nextStep.type} — ${job.episode_id}`,
                  params: nextParams,
                })
                job.output_lines.push(`→ Chained next step: ${nextStep.type}`)
              }
            } catch (e: any) {
              const failed = await recordChainHandoffFailure(job, nextStep, rest, e)
              job.output_lines.push(`Chain-next failed: ${e.message} (recorded as failed job ${failed.job_id})`)
            }
          }
        }
      }
    } catch (e: any) {
      job.local_execution_complete = true
      if (hasCancellationContext(job) && !hasUnsettledProviderWork(job)) {
        await finalizeSettledProviderJob(job.job_id)
        if (job.status !== 'running') {
          // Provider truth has chosen the terminal result; retain the local
          // error as diagnostics only, never let it overwrite that truth.
          job.output_lines.push(`Local executor ended during provider reconciliation: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // If the job was cancelled mid-flight the executor typically rejects
      // with an FFmpeg-exited error or a "Cancelled by user" from a cancel
      // probe — either way, the user's intent is "cancelled", not "error".
      if (job.status !== 'running') {
        // Provider reconciliation above already finalized this job.
      } else if (cancelled.has(job.job_id)) {
        job.status = 'cancelled'
      } else if (hasUnsettledProviderWork(job)) {
        const isPause = e instanceof JobPausedError || pauseRequested.has(job.job_id)
        const message = e instanceof Error ? e.message : String(e)
        job.status = 'running'
        job.error = message
        job.output_lines.push(isPause
          ? `Local pause request retained while provider cancellation is pending: ${message}`
          : `Local executor error retained while provider cancellation is pending: ${message}`)
      } else if (e instanceof JobPausedError || pauseRequested.has(job.job_id)) {
        job.status = 'paused'
        job.pause_requested = false
        job.error = null
        job.output_lines.push('Paused safely. Accepted provider work was allowed to finish and save; Resume will submit only work still missing on disk.')
        pauseRequested.delete(job.job_id)
      } else {
        job.status = 'error'
        job.error = e.message
        job.output_lines.push(`Error: ${e.message}`)
        await continueFinalizerAfterSubtitleFailure(job)
      }
    }

    job.finished_at = job.status === 'paused' || hasUnsettledProviderWork(job)
      || (job.status === 'running' && hasCancellationContext(job))
      ? null
      : new Date().toISOString()
    jobs.set(job.job_id, job)
    await persistJob(job)
    emitUpdate(job)
  } finally {
    releaseSlot(type, job)
  }
}

/** Cancellable backoff between local attempts. Keep the queue slot reserved so
 * a struggling Mac is not flooded with more work while it recovers. */
async function waitForLocalRetry(jobId: string, delayMs: number): Promise<void> {
  const deadline = Date.now() + delayMs
  while (Date.now() < deadline) {
    if (cancelled.has(jobId)) throw new Error('Cancelled by user')
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))))
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function registerExecutor(type: JobType, executor: JobExecutor): void {
  queues[type].executor = executor
}

export async function initializeQueuePauseState(): Promise<void> {
  if (queuePauseLoaded) return
  queuePauseLoaded = true
  queuePaused = (await getAppSetting(QUEUE_PAUSED_KEY).catch(() => false)) === true
}

export async function setQueuePaused(paused: boolean): Promise<void> {
  const wasPaused = queuePaused
  queuePaused = paused
  queuePauseLoaded = true
  await setAppSetting(QUEUE_PAUSED_KEY, paused)
  if (paused) {
    // The global hold prevents every queued item from being submitted. For
    // GenStudio-backed work already running, request a cooperative safe-point
    // pause: accepted items finish downloading, but workers claim no new item.
    const pausable = [...jobs.values()].filter(job =>
      job.status === 'running' && (
        job.type === 'subtitles_transcribe'
        || job.params?.provider === 'genstudio'
        || String(job.params?.model || '').startsWith('genstudio-')
      ),
    )
    await Promise.all(pausable.map(job => pauseJob(job.job_id, 'queue')))
  }
  if (wasPaused && !paused) {
    // Resume only jobs paused by this global hold. A job the user paused
    // explicitly stays paused until its own Resume button is used.
    const heldJobs = [...jobs.values()].filter(job =>
      job.status === 'paused' && job.pause_origin === 'queue',
    )
    for (const job of heldJobs) await resumeJob(job.job_id)
    // Kick every type so queued jobs that never started while held can run.
    for (const type of Object.keys(queues) as JobType[]) {
      pump(type)
    }
  }
}

export function isQueuePaused(): boolean {
  return queuePaused
}

/** Pause one job without cancelling provider work. Queued work is removed
 * before submit; running work observes the request at its next safe boundary. */
export async function pauseJob(jobId: string, origin: 'manual' | 'queue' = 'manual'): Promise<Job | null> {
  const job = jobs.get(jobId)
  if (!job) return null
  if (job.status === 'queued') {
    const q = queues[job.type]
    q.pending = q.pending.filter(candidate => candidate.job_id !== jobId)
    job.status = 'paused'
    job.pause_requested = false
    job.pause_origin = origin
    job.finished_at = null
    job.output_lines.push('Paused before submission. No provider work was started.')
  } else if (job.status === 'running') {
    pauseRequested.add(jobId)
    job.pause_requested = true
    job.pause_origin = origin
    job.output_lines.push('Pause requested. No new items will be submitted; already accepted work will finish checkpointing first.')
  } else if (job.status !== 'paused') {
    return null
  }
  await persistJob(job)
  emitUpdate(job)
  return serializeJob(job)
}

/** Resume the same durable job record. Executors audit disk/manifests first,
 * so accepted or completed items are reclaimed rather than resubmitted. */
export async function resumeJob(jobId: string): Promise<Job | null> {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'paused') return null
  pauseRequested.delete(jobId)
  job.pause_requested = false
  job.pause_origin = undefined
  job.status = 'queued'
  job.started_at = null
  job.finished_at = null
  job.error = null
  job.output_lines.push('Resume requested — verifying saved assets and accepted provider tasks before submitting missing work.')
  queues[job.type].pending.push(job)
  await persistJob(job)
  emitUpdate(job)
  pump(job.type)
  return serializeJob(job)
}

/**
 * Is there already a queued/running job of this kind for the same project +
 * episode? Optional `paramsMatch` predicate narrows the dedupe to a subset of
 * jobs whose params satisfy the predicate — used by `chapter-only` to dedupe
 * per (episode, chapter) instead of per (episode, type), so the user can
 * queue multiple chapter regens in a row without each one rejecting the next.
 */
export function isDuplicate(
  projectSlug: string,
  episodeId: string,
  jobType: string,
  paramsMatch?: (params: any) => boolean,
): boolean {
  for (const job of jobs.values()) {
    if (job.project_slug === projectSlug && job.episode_id === episodeId
        && job.type === jobType && (job.status === 'queued' || job.status === 'running' || job.status === 'paused')) {
      if (paramsMatch && !paramsMatch(job.params || {})) continue
      return true
    }
  }
  return false
}

/**
 * Scene Review used two names for the same episode-wide image workload:
 * `scene_images_batch` from the page and `continuity_render` from Pipeline.
 * Keep the legacy type readable for jobs already in flight, but treat both as
 * one queue resource so they can never submit the same scenes twice.
 */
function isBulkSceneRender(job: Job): boolean {
  if (job.type === 'scene_images_batch') return true
  return job.type === 'continuity_render' && !job.params?.single_scene_id
}

function findActiveBulkSceneRenderInternal(projectSlug: string, episodeId: string): Job | null {
  for (const job of jobs.values()) {
    if (job.project_slug !== projectSlug || job.episode_id !== episodeId) continue
    if (job.status !== 'queued' && job.status !== 'running') continue
    if (isBulkSceneRender(job)) return job
  }
  return null
}

/** Return the existing owner of an episode's full scene-image render, if any. */
export function getActiveBulkSceneRenderJob(projectSlug: string, episodeId: string): Job | null {
  const job = findActiveBulkSceneRenderInternal(projectSlug, episodeId)
  return job ? serializeJob(job) : null
}

export interface SceneRenderJoinResult {
  job: Job
  attached: boolean
  conflict: boolean
}

/**
 * Join Pipeline continuation work to an already-running full scene render.
 * This lets a manually-started Scene Review render become the owner of the
 * Pipeline's remaining steps rather than starting a duplicate render.
 */
export async function joinActiveBulkSceneRender(opts: {
  project_slug: string
  episode_id: string
  pipeline_chain?: unknown[]
  pipeline_batch_id?: string
}): Promise<SceneRenderJoinResult | null> {
  const active = findActiveBulkSceneRenderInternal(opts.project_slug, opts.episode_id)
  if (!active) return null

  const incomingChain = Array.isArray(opts.pipeline_chain) ? opts.pipeline_chain : []
  const existingChain = Array.isArray(active.params?.pipeline_chain) ? active.params.pipeline_chain : []
  const sameChain = JSON.stringify(existingChain) === JSON.stringify(incomingChain)
  const existingBatchId = typeof active.params?.pipeline_batch_id === 'string'
    ? active.params.pipeline_batch_id
    : ''
  if (existingBatchId && opts.pipeline_batch_id && existingBatchId !== opts.pipeline_batch_id) {
    return { job: serializeJob(active), attached: false, conflict: true }
  }
  if (incomingChain.length > 0 && existingChain.length > 0 && !sameChain) {
    return { job: serializeJob(active), attached: false, conflict: true }
  }

  let attached = false
  if (incomingChain.length > 0 && existingChain.length === 0) {
    active.params.pipeline_chain = incomingChain
    attached = true
  }
  if (opts.pipeline_batch_id && !active.params.pipeline_batch_id) {
    active.params.pipeline_batch_id = opts.pipeline_batch_id
    attached = true
  }
  if (attached) {
    active.output_lines.push('→ Pipeline joined this existing scene render; no duplicate batch was submitted.')
    await persistJob(active)
    emitUpdate(active)
  }
  return { job: serializeJob(active), attached, conflict: false }
}

/** True if the given job has been cancelled. Generators should poll this at
 *  safe points inside long-running loops so a user-cancelled job stops
 *  burning provider calls instead of running to completion. */
export function isCancelled(jobId: string): boolean {
  return cancelled.has(jobId)
}

/** Thrown by `enqueue` when the same (project, episode, type) is already
 *  queued or running. Carries HTTP status + expose flag so the global error
 *  handler in app.ts returns a 409 to the client with a useful detail. */
export class DuplicateJobError extends Error {
  status = 409
  expose = true
  constructor(type: JobType, episodeId: string) {
    super(`${type} generation already queued/running for ${episodeId}`)
    this.name = 'DuplicateJobError'
  }
}

/**
 * Sync OR async dispatch — single call site that picks between running
 * an executor inline (returning when it completes) and enqueueing it.
 *
 * Why this exists: today image-prompts and metadata generation run
 * synchronously inside their HTTP route handlers, while everything else
 * goes through the queue. Future work (M5 in the system audit) will
 * migrate them to the queue so they show up in the Jobs tab and become
 * retryable. This adapter is the seam: when the migration happens, the
 * call site changes from `{ sync: true }` to `{ sync: false }` and
 * everything else stays the same. No executor rewrite required.
 *
 * Sync semantics:
 *   - Synthesises a Job, runs the registered executor against it, awaits.
 *   - The job is NOT persisted to disk and does NOT appear in /jobs —
 *     it's a one-shot foreground call. This matches today's synchronous
 *     endpoints' UX: the request is in flight, then it returns.
 *   - Cancellation, deduplication, and SSE updates do NOT apply.
 *   - Throws if the executor throws (route handlers should let Express
 *     translate to a 500 just like they do today).
 *
 * Async semantics: identical to `enqueue` — returns the queued job.
 */
export async function enqueueOrRun(opts: {
  project_slug: string
  type: JobType
  episode_id: string
  title?: string
  params?: Record<string, any>
  sync?: boolean
}): Promise<Job> {
  if (!opts.sync) return enqueue(opts)

  const executor = queues[opts.type]?.executor
  if (!executor) throw new Error(`enqueueOrRun(sync): no executor registered for ${opts.type}`)

  const jobId = randomUUID().slice(0, 8)
  const job: Job = {
    job_id: jobId,
    project_slug: opts.project_slug,
    type: opts.type,
    episode_id: opts.episode_id,
    title: opts.title || '',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: opts.params || {},
  }
  try {
    await executor(job)
    assertJobDidNotDeclareIncomplete(job)
    job.status = 'done'
    job.finished_at = new Date().toISOString()
  } catch (e: any) {
    job.status = 'error'
    job.error = e?.message || String(e)
    job.finished_at = new Date().toISOString()
    throw e
  }
  return serializeJob(job)
}

export function enqueue(opts: {
  project_slug: string
  type: JobType
  episode_id: string
  title?: string
  params?: Record<string, any>
  /** Server-only replacement scope for a terminal GenStudio chat retry. */
  genstudio_chat_retry_scope?: string
  /** Server-only exact replay marker for unresolved GenStudio chat evidence. */
  genstudio_chat_recovery?: true
  /** Server-extracted recovery fields. These are deliberately outside params. */
  genstudio_chat_recovery_key?: string
  genstudio_chat_recovery_purpose?: 'outline' | 'narrative-repair'
  genstudio_chat_recovery_chapters?: number[]
  genstudio_chat_recovery_keys?: string[]
  /** Narrow the duplicate check to jobs whose params satisfy this predicate.
   *  When omitted, dedupe is per (project, episode, type) — the historical
   *  behaviour. chapter-only passes a predicate that compares
   *  `params.chapter_number` so two regens for different chapters can both
   *  enqueue (run back-to-back) without rejecting each other. */
  dedupeParams?: (params: any) => boolean
}): Job {
  if (!queues[opts.type]) {
    throw new Error(`No queue lane registered for job type: ${opts.type}`)
  }
  // Cross-type atomic dedupe for the retired Scene Review batch name and the
  // canonical continuity renderer. Full renders conflict with either full
  // type; a single-scene repair also waits behind an active full render.
  const isBulkRequest = opts.type === 'scene_images_batch'
    || (opts.type === 'continuity_render' && !opts.params?.single_scene_id)
  const isSingleSceneRequest = opts.type === 'continuity_render' && !!opts.params?.single_scene_id
  if ((isBulkRequest || isSingleSceneRequest)
      && findActiveBulkSceneRenderInternal(opts.project_slug, opts.episode_id)) {
    throw new DuplicateJobError(opts.type, opts.episode_id)
  }
  // Atomic dedupe: the check and the insert happen in the same synchronous
  // tick. Callers MUST NOT gate on isDuplicate() separately — two routes
  // racing the check could both pass and both enqueue. This is the single
  // serialisation point for queue insertion.
  if (isDuplicate(opts.project_slug, opts.episode_id, opts.type, opts.dedupeParams)) {
    throw new DuplicateJobError(opts.type, opts.episode_id)
  }

  const jobId = randomUUID().slice(0, 8)
  const job: Job = {
    job_id: jobId,
    project_slug: opts.project_slug,
    type: opts.type,
    episode_id: opts.episode_id,
    title: opts.title || '',
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: [],
    params: opts.params || {},
    ...(opts.genstudio_chat_retry_scope ? { genstudio_chat_retry_scope: opts.genstudio_chat_retry_scope } : {}),
    ...(opts.genstudio_chat_recovery ? { genstudio_chat_recovery: true as const } : {}),
    ...(opts.genstudio_chat_recovery_key ? { genstudio_chat_recovery_key: opts.genstudio_chat_recovery_key } : {}),
    ...(opts.genstudio_chat_recovery_purpose ? { genstudio_chat_recovery_purpose: opts.genstudio_chat_recovery_purpose } : {}),
    ...(opts.genstudio_chat_recovery_chapters?.length ? { genstudio_chat_recovery_chapters: opts.genstudio_chat_recovery_chapters } : {}),
    ...(opts.genstudio_chat_recovery_keys?.length ? { genstudio_chat_recovery_keys: opts.genstudio_chat_recovery_keys } : {}),
  }

  jobs.set(jobId, job)
  queues[opts.type].pending.push(job)
  persistJob(job).catch(e => console.error('[job-queue] Failed to persist:', e))
  // Emit synchronously so SSE subscribers see the new queued job before the
  // route handler replies — otherwise the renderer's optimistic UI and the
  // backend event race on which reaches the user first.
  emitUpdate(job)

  // Kick off processing
  pump(opts.type)

  return serializeJob(job)
}

export async function getJobs(projectSlug: string): Promise<Job[]> {
  await loadPersistedJobs(projectSlug)
  const projectJobs: Job[] = []
  for (const job of jobs.values()) {
    if (job.project_slug === projectSlug) {
      const j = serializeJob(job)
      if (j.status === 'queued') {
        const q = queues[job.type]
        j.queue_position = q ? q.pending.findIndex(p => p.job_id === j.job_id) + 1 : 0
      }
      projectJobs.push(j)
    }
  }

  const order: Record<string, number> = { running: 0, paused: 1, queued: 2, done: 3, cancelled: 4, error: 4 }
  projectJobs.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4))
  return projectJobs
}

export function getJob(jobId: string): Job | null {
  const job = jobs.get(jobId)
  return job ? serializeJob(job) : null
}

/**
 * Re-enqueue a terminal job with the exact durable parameters that produced it.
 *
 * Page-specific Retry maps are useful when a workflow needs special healing,
 * but they are not a safe completeness boundary: every newly registered job
 * type would otherwise become impossible to retry until the frontend learned
 * about it. This queue-level fallback keeps the original record until the new
 * job has been accepted, then removes it from history.
 */
type ChapterChatRetryMode = 'exact-replay' | 'fresh-replacement'
type ChatRecoveryDescriptor = {
  key: string
  purpose: 'outline' | 'narrative-repair'
  chapters?: number[]
}

function chatEntries(job: Job): NonNullable<Job['genstudio_jobs']> {
  return (job.genstudio_jobs || []).filter(entry => entry.operation === 'chat.response')
}

function isResolvedChatEntry(entry: NonNullable<Job['genstudio_jobs']>[number]): boolean {
  return typeof entry.id === 'string'
    && !!entry.id
    && !entry.id.startsWith('pending:')
    && (entry.state === 'succeeded' || entry.state === 'failed')
}

function chapterChatRetryMode(job: Job): ChapterChatRetryMode | undefined {
  const chats = chatEntries(job)
  if (chats.length === 0) return undefined
  const terminalFailure = chats.find(entry =>
    entry.state === 'failed'
    && typeof entry.id === 'string'
    && !!entry.id
    && !entry.id.startsWith('pending:'),
  )
  // A Story retry may replace the provider key only after every chat batch is
  // resolved. Any pending preview or unknown/nonterminal state can still be
  // reattached with the original key, so a fresh scope would risk duplicate
  // paid work.
  return terminalFailure && chats.every(isResolvedChatEntry)
    ? 'fresh-replacement'
    : 'exact-replay'
}

function terminalChatRetryScope(job: Job): string | undefined {
  if (chapterChatRetryMode(job) !== 'fresh-replacement') return undefined
  const terminalFailure = chatEntries(job).find(entry => entry.state === 'failed' && !entry.id.startsWith('pending:'))
  return terminalFailure ? `terminal:${terminalFailure.id}:${job.job_id}` : undefined
}

/**
 * A pending key is usable only when its retained, untruncated server preview
 * proves the exact workflow call that made it. Never infer an order from
 * concurrent chat entries: an ambiguous recovery must stay blocked.
 */
function provenPendingChatRecovery(job: Job): ChatRecoveryDescriptor | null {
  const candidates = chatEntries(job).flatMap<ChatRecoveryDescriptor>(entry => {
    if (!entry.id.startsWith('pending:') || entry.state !== 'submitting') return []
    const key = entry.request?.idempotency_key?.trim()
    const user = entry.request?.messages?.find(message => message.role === 'user')
    if (!key || !user || user.truncated) return []
    if (/^Plan (the chapter structure|a listicle \/ explainer episode)\./.test(user.text)) {
      return [{ key, purpose: 'outline' as const }]
    }
    if (!user.text.includes('RECOVERY INSTRUCTION: This is one bounded repair pass.')) return []
    const slots = user.text.match(/SLOTS TO WRITE NOW:\n([\s\S]*?)\n(?:OUTPUT|Return)/)
    const chapters = slots
      ? [...slots[1].matchAll(/^\s*Chapter (\d+):/gm)].map(match => Number(match[1]))
      : []
    if (!chapters.length || chapters.some(chapter => !Number.isInteger(chapter) || chapter < 1)) return []
    return [{ key, purpose: 'narrative-repair' as const, chapters }]
  })
  return candidates.length === 1 ? candidates[0]! : null
}

export function hasUnresolvedTerminalChapterExpansion(projectSlug: string, episodeId: string): boolean {
  return Array.from(jobs.values()).some(job =>
    job.project_slug === projectSlug
    && job.episode_id === episodeId
    && job.type === 'expand_chapters'
    && (job.status === 'error' || job.status === 'cancelled')
    && chatEntries(job).length > 0
    && chatEntries(job).some(entry => !isResolvedChatEntry(entry)),
  )
}

export function retryTerminalJob(
  projectSlug: string,
  jobId: string,
  replacementParams?: Record<string, any>,
): Job {
  const original = jobs.get(jobId)
  if (!original || original.project_slug !== projectSlug) {
    throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
  }
  if (original.status !== 'error' && original.status !== 'cancelled') {
    throw Object.assign(
      new Error('Only failed or cancelled jobs can be retried.'),
      { status: 409, expose: true },
    )
  }

  const chatBackedRetry = original.type === 'expand_chapters' || original.type === 'outline_only'
  const chapterRetryMode = chatBackedRetry
    ? chapterChatRetryMode(original)
    : undefined
  const anotherUnresolvedExpansionExists = original.type === 'expand_chapters'
    && chapterRetryMode === 'fresh-replacement'
    && Array.from(jobs.values()).some(job =>
      job.job_id !== original.job_id
      && job.project_slug === original.project_slug
      && job.episode_id === original.episode_id
      && job.type === 'expand_chapters'
      && (job.status === 'error' || job.status === 'cancelled')
      && chatEntries(job).some(entry => !isResolvedChatEntry(entry)),
    )
  if (anotherUnresolvedExpansionExists) {
    throw Object.assign(
      new Error('Another terminal chapter expansion has unresolved GenStudio chat evidence.'),
      { status: 409, expose: true },
    )
  }

  // A fresh provider identity is allowed only after every recorded chat batch
  // has settled and at least one failed terminally. Mixed/pending evidence
  // must reattach with the original key. This marker is deliberately minted
  // only from the explicit manual Retry path; pause/resume and lost-response
  // recovery retain the original provider identity.
  const genstudio_chat_retry_scope = chapterRetryMode === 'fresh-replacement'
    ? terminalChatRetryScope(original)
    : undefined
  const recovery = chapterRetryMode === 'exact-replay'
    ? provenPendingChatRecovery(original)
    : null
  const pendingKeys = [...new Set(chatEntries(original)
    .filter(entry => !isResolvedChatEntry(entry))
    .map(entry => entry.request?.idempotency_key?.trim())
    .filter((key): key is string => !!key))]
  const unresolvedChatCount = chatEntries(original).filter(entry => !isResolvedChatEntry(entry)).length
  if (
    chapterRetryMode === 'exact-replay'
    && !recovery
    && unresolvedChatCount > 1
    && pendingKeys.length !== unresolvedChatCount
  ) {
    throw Object.assign(
      new Error('Unresolved GenStudio chat evidence does not prove one recoverable request identity. No provider work was submitted.'),
      { status: 409, expose: true },
    )
  }

  const retried = enqueue({
    project_slug: original.project_slug,
    type: original.type,
    episode_id: original.episode_id,
    title: original.title,
    params: structuredClone(replacementParams || original.params || {}),
    ...(genstudio_chat_retry_scope ? { genstudio_chat_retry_scope } : {}),
    ...(chapterRetryMode === 'exact-replay' ? { genstudio_chat_recovery: true as const } : {}),
    ...(recovery ? {
      genstudio_chat_recovery_key: recovery.key,
      genstudio_chat_recovery_purpose: recovery.purpose,
      ...(recovery.chapters ? { genstudio_chat_recovery_chapters: recovery.chapters } : {}),
      ...(pendingKeys.length ? { genstudio_chat_recovery_keys: pendingKeys } : {}),
    } : pendingKeys.length ? { genstudio_chat_recovery_keys: pendingKeys } : {}),
  })

  jobs.delete(jobId)
  emitCleared(projectSlug, [jobId])
  void persistProjectSnapshot(projectSlug).catch((error) => {
    console.warn('[job-queue] failed to persist retried job replacement', {
      projectSlug,
      jobId,
      error: error?.message,
    })
  })
  return retried
}

/**
 * Resume a terminal chapter expansion from an already-validated form body.
 * It uses that current body only after all chat evidence settled with a
 * failure; mixed evidence replays the exact historical parameters instead.
 */
export function retryTerminalChapterExpansion(
  projectSlug: string,
  jobId: string,
  episodeId: string,
  replacementParams: Record<string, any>,
): Job {
  const original = jobs.get(jobId)
  if (!original || original.project_slug !== projectSlug) {
    throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
  }
  if (original.type !== 'expand_chapters' || original.episode_id !== episodeId) {
    throw Object.assign(
      new Error('Terminal retry job must be a chapter expansion for the same episode.'),
      { status: 409, expose: true },
    )
  }
  const retryMode = chapterChatRetryMode(original)
  if (!retryMode) {
    throw Object.assign(
      new Error('Terminal retry job has no durable GenStudio chat evidence.'),
      { status: 409, expose: true },
    )
  }
  return retryTerminalJob(
    projectSlug,
    jobId,
    retryMode === 'fresh-replacement' ? replacementParams : undefined,
  )
}

/**
 * Record which account served a provider for a running job. Called from the
 * secrets-aware resolver (providers/registry.ts) when `ctx.jobId` is set.
 * Merges into the job's `accounts_used` map — same provider overwrites with
 * the latest label snapshot, different providers accumulate — then fires
 * `jobEvents.emit('update', …)` so the Jobs-page SSE stream picks up the
 * attribution live.
 *
 * Silent no-op when the jobId is unknown (the job finished or was never
 * queued) — attribution is bookkeeping, it must never fail a generation.
 */
export function recordAccountUsed(
  jobId: string,
  providerId: string,
  account: { id: string; label: string },
): void {
  const job = jobs.get(jobId)
  if (!job) return
  if (!job.accounts_used) job.accounts_used = {}
  job.accounts_used[providerId] = { id: account.id, label: account.label }
  emitUpdate(job)
}

export class JobControlError extends Error {
  readonly status = 409
  readonly expose = true
  readonly code: JobControl['code']

  constructor(readonly control: JobControl) {
    super(control.reason)
    this.name = 'JobControlError'
    this.code = control.code
  }
}

function controlFor(job: Job): JobControl {
  return classifyJobControl(job, {
    remoteCancellationAudited: hasJobCancellationAuditor(job.type),
  })
}

async function cancelQueuedBeforeSubmit(job: Job): Promise<Job> {
  cancelled.add(job.job_id)
  pauseRequested.delete(job.job_id)
  if (job.status === 'queued') {
    const q = queues[job.type]
    q.pending = q.pending.filter(candidate => candidate.job_id !== job.job_id)
  }
  job.status = 'cancelled'
  job.pause_requested = false
  job.pause_origin = undefined
  job.finished_at = new Date().toISOString()
  job.output_lines.push('Cancelled before submission. This operation sent no provider request.')
  await persistJob(job)
  emitUpdate(job)
  return serializeJob(job)
}

async function stopLocalJob(job: Job): Promise<Job> {
  cancelled.add(job.job_id)
  job.status = 'cancelled'
  job.finished_at = new Date().toISOString()
  job.output_lines.push('Local processing stopped. This operation sent no provider generation request.')
  killChildrenFor(job.job_id)
  await persistJob(job)
  emitUpdate(job)
  return serializeJob(job)
}

function remoteCancellationKey(target: NonNullable<JobControl['targets']>[number]): string {
  return `${target.operation}:${target.provider_job_id}`
}

async function queueRemoteCancellationTargets(
  job: Job,
  targets: NonNullable<JobControl['targets']>,
): Promise<Job> {
  const now = new Date().toISOString()
  const records = { ...(job.remote_cancellations || {}) }
  let added = 0
  for (const target of targets) {
    const key = remoteCancellationKey(target)
    const existing = records[key]
    // One Story target owns one provider cancellation attempt.  A timeout,
    // 409, or confirmed response is evidence to reconcile, never permission
    // to issue a second blind control POST for the same provider task.
    if (existing) continue
    records[key] = {
      status: 'queued',
      operation: target.operation,
      provider_job_id: target.provider_job_id,
      requested_at: now,
      updated_at: now,
    }
    added++
  }
  job.remote_cancellations = records
  if (added > 0) job.output_lines.push(`Cancellation requested for ${added} provider task${added === 1 ? '' : 's'}; waiting for GenStudio confirmation.`)
  await persistJob(job)
  emitUpdate(job)
  return serializeJob(job)
}

/**
 * Request the one control the server can prove safe for this exact job.
 * Remote requests remain running until GenStudio reports their terminal truth.
 */
export async function requestJobCancellation(projectSlug: string, jobId: string): Promise<Job> {
  await loadPersistedJobs(projectSlug)
  const job = jobs.get(jobId)
  if (!job || job.project_slug !== projectSlug) {
    throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
  }

  // A repeated click must not create another provider cancellation request.
  // Keep returning the durable first request while its authoritative outcome
  // is still being reconciled.
  if (Object.values(job.remote_cancellations || {}).some(record => (
    record.status === 'queued' || record.status === 'submitting' || record.status === 'requested' || record.status === 'reconciling'
  ))) return serializeJob(job)

  const control = controlFor(job)
  if (!control.enabled) throw new JobControlError(control)
  if (control.action === 'cancel-before-submit') return cancelQueuedBeforeSubmit(job)
  if (control.action === 'stop-local') return stopLocalJob(job)
  if (control.action === 'request-remote-cancel') return queueRemoteCancellationTargets(job, control.targets || [])
  throw new JobControlError(control)
}

/** Remove terminal history only. Generated files and provider evidence remain intact. */
export function removeTerminalJob(projectSlug: string, jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || job.project_slug !== projectSlug) return false
  if (!TERMINAL_JOB_STATUSES.has(job.status)) return false
  jobs.delete(jobId)
  emitCleared(projectSlug, [jobId])
  void persistProjectSnapshot(projectSlug).catch(() => {})
  return true
}

export async function clearFinished(projectSlug: string): Promise<number> {
  await loadPersistedJobs(projectSlug)
  let count = 0
  const clearedIds: string[] = []
  for (const [id, job] of jobs.entries()) {
    if (job.project_slug === projectSlug && ['done', 'error', 'cancelled'].includes(job.status)) {
      jobs.delete(id)
      clearedIds.push(id)
      count++
    }
  }
  if (count > 0) emitCleared(projectSlug, clearedIds)
  // Clearing history is a UI housekeeping action, not an asset mutation.
  // Return as soon as memory + SSE are updated; persist the compact snapshot
  // behind the response so an iCloud-backed project cannot freeze the button.
  void persistProjectSnapshot(projectSlug).catch((e) => {
    console.warn('[job-queue] failed to persist cleared history', { projectSlug, error: e?.message })
  })
  return count
}

export function getQueueStats(projectSlug?: string): JobStats {
  let jobList = Array.from(jobs.values())
  if (projectSlug) jobList = jobList.filter(j => j.project_slug === projectSlug)
  return {
    running: jobList.filter(j => j.status === 'running').length,
    queued: jobList.filter(j => j.status === 'queued').length,
    paused: jobList.filter(j => j.status === 'paused').length,
    done: jobList.filter(j => j.status === 'done').length,
    error: jobList.filter(j => j.status === 'error').length,
    total: jobList.length,
  }
}
