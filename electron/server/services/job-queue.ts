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
import { deactivateSceneRenderStatus } from './scene-render-status.js'
import { boundGenStudioRequestPreviews, pendingGenStudioEntryId, type GenStudioRequestPreview } from '../lib/genstudio-request-preview.js'
import { AsyncLocalStorage } from 'async_hooks'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'node:crypto'
import { balancedReplacementSettlement, mergeGenerationReplacementAttempts } from './generation-paid-replacement.js'
import { projectsRoot, getProjectDir } from './project-manager.js'
import { trackGeneration } from './session-tracker.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import type { Job, JobRemoteCancellation, JobRemoteOperation, JobStats, JobType, PaidImageReplacementAttempt, PaidImageReplacementPolicySnapshot } from '../models/types.js'
import { assertJobDidNotDeclareIncomplete } from './job-completion.js'
import { jobStreamSignature } from './job-stream-signature.js'
import { isLocalTextModel, resolveJobAutoRetryPolicy } from './job-retry-policy.js'
import { getAppSetting, getPaidImageReplacementSetting, onAppSettingWritten, setAppSetting } from './app-settings.js'
import { classifyJobControl, classifyJobControls } from './job-control.js'
import { getJobCancellationAuditor, hasJobCancellationAuditor } from './job-cancellation-auditors.js'
import { reconcilePendingJobCancellation } from './job-cancellation-reconciler.js'
import {
  isNeverCreatedProviderTask,
  isActiveGenStudioProviderState,
  isUnsettledProviderEntry as isUnsettledProviderEntryShared,
  shouldRecheckStoredTranscriptionAbsence,
} from '../lib/provider-task-state.js'
import { reconciledGenStudioQueueState } from '../contracts/provider-task-state.js'
import { FLEET_BUSY_FAILURE_CODES } from '../lib/genstudio-fleet-busy.js'
import { holdsUnknownOutcome, isSubmissionUncertainCode } from '../lib/genstudio-client.js'
import { isRetryableZeroSettlementImageFailureCode } from './image-paid-replacement.js'
import { getApiKey } from './app-secrets-store.js'
import type { JobControl } from '../models/types.js'
import {
  snapshotProjectContentPackProvenance,
  type ContentPackProjectPinOptions,
} from '../content-packs/project-pins.js'
import { runWithJobContentPackProvenance } from '../content-packs/job-provenance-context.js'
import { readManifest, recordPaidImageReplacementStrict, type TaskManifestEntry } from './task-manifest.js'
import { isDecodableImage } from '../lib/image-validation.js'
import { auditSceneImageCompletion } from './scene-media-checkpoint.js'
import type { GenStudioAdmissionSnapshot } from '../lib/genstudio-admission.js'
import { assertQueuedVisualSource } from './video-visual-source.js'
import { getValidVideoAssemblyCheckpoint } from '../lib/video-assembly-checkpoint.js'
import { isLlmLineupWaitingError } from '../lib/ai-client.js'
import {
  pipelinePolicyForJob,
  readPipelinePolicyAttemptCheckpoint,
} from '../lib/pipeline-model-policy.js'
import { snapshotLlmLineupParams, writingStageForJob } from './llm-lineup.js'

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
  const requestKey = providerRequestKey(snapshot)
  if (requestKey) snapshot = { ...snapshot, request_key: requestKey }
  const entries = [...(job.genstudio_jobs || [])]
  let index = entries.findIndex(entry => entry.operation === snapshot.operation && entry.id === snapshot.id)
  if (index < 0 && requestKey) {
    // The redacted request preview is written BEFORE submission (a request
    // that never gets an id is exactly the one a user needs to read), so it
    // lands under a deterministic `pending:<idempotency-key>` id. Once
    // GenStudio hands back the real id, adopt that entry instead of leaving a
    // duplicate orphan next to it.
    const pendingId = pendingGenStudioEntryId(requestKey)
    index = entries.findIndex(entry => entry.operation === snapshot.operation && entry.id === pendingId)
  }
  if (index >= 0) {
    const previous = entries[index]!
    // A later state poll carries no request preview; it must not erase the
    // one captured at submission time.
    const request = snapshot.request ?? previous.request
    entries[index] = { ...previous, ...snapshot, ...(request ? { request } : {}) }
  } else entries.push(snapshot)
  if (job.generation_replacement_attempts?.some(attempt => attempt.task_id === snapshot.id || attempt.idempotency_key === requestKey)) {
    await mutateAuthoritativeJob(job.project_slug, job.job_id, authoritative => {
      authoritative.generation_replacement_attempts = (authoritative.generation_replacement_attempts || []).map(attempt => {
        if (attempt.task_id !== snapshot.id && attempt.idempotency_key !== requestKey) return attempt
        const settled = balancedReplacementSettlement(snapshot)
        return { ...attempt, task_id: snapshot.id, revision: attempt.revision + 1,
          state: snapshot.state === 'succeeded' ? 'succeeded' : snapshot.state === 'failed' ? 'failed' : 'submitted',
          ...(settled !== null && settled <= attempt.max_credits ? { settled_credits: settled } : {}) }
      })
      return authoritative
    })
  }
  job.genstudio_jobs = boundGenStudioRequestPreviews(mergeDurableJobEvidence(job, { ...job, genstudio_jobs: entries }).genstudio_jobs || [])
  await persistJob(job)
  emitUpdate(job)
  void finalizeSettledProviderJob(job.job_id)
  if (job.type === 'continuity_render') noteAdaptiveImageTailEvent()
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
  if (job.local_execution_complete) void finalizeSettledProviderJob(job.job_id)
}

/**
 * A process may crash after persisting `submitting` and before the control
 * socket returns. A later status read must establish whether it is still
 * cancellable before the idempotent control request may be retried.
 */
export async function reconcileRemoteCancellationFromProvider(
  storyJobId: string,
  operation: JobRemoteOperation,
  providerJobId: string,
  evidence: {
    state: string
    dispatch_state?: 'pre_dispatch' | 'dispatched'
    cancelled?: boolean | null
    cancellable?: boolean | null
    cancellation_requested?: boolean | null
    cancellation_note?: string | null
    failure_code?: string | null
    reserved_credits?: number | null
    settled_credits?: number | null
    released_credits?: number | null
    transcription_absence_verified_at?: string
  },
): Promise<void> {
  const job = jobs.get(storyJobId)
  const key = queuedCancellationKey(operation, providerJobId)
  const previous = job?.remote_cancellations?.[key]
  if (!job || !previous) return
  const settled = evidence.cancelled === true || evidence.state === 'succeeded' || evidence.state === 'failed'
    || isNeverCreatedProviderTask(evidence)
  if (!settled) return
  await recordRemoteCancellation(storyJobId, operation, providerJobId, {
    status: evidence.cancelled === true
      ? 'confirmed'
      // Nothing was rejected — there was never a task to reject.
      : isNeverCreatedProviderTask(evidence) ? 'absent' : 'rejected',
    state: evidence.state,
    ...(evidence.dispatch_state !== undefined ? { dispatch_state: evidence.dispatch_state } : {}),
    ...(evidence.cancellable !== undefined && evidence.cancellable !== null ? { cancellable: evidence.cancellable } : {}),
    ...(evidence.cancelled !== undefined && evidence.cancelled !== null ? { cancelled: evidence.cancelled } : {}),
    ...(evidence.cancellation_requested !== undefined && evidence.cancellation_requested !== null ? { cancellation_requested: evidence.cancellation_requested } : {}),
    ...(evidence.cancellation_note !== undefined ? { cancellation_note: evidence.cancellation_note } : {}),
    ...(evidence.failure_code !== undefined ? { failure_code: evidence.failure_code } : {}),
    ...(typeof evidence.reserved_credits === 'number' && Number.isFinite(evidence.reserved_credits) && evidence.reserved_credits >= 0 ? { reserved_credits: evidence.reserved_credits } : {}),
    ...(typeof evidence.settled_credits === 'number' && Number.isFinite(evidence.settled_credits) && evidence.settled_credits >= 0 ? { settled_credits: evidence.settled_credits } : {}),
    ...(typeof evidence.released_credits === 'number' && Number.isFinite(evidence.released_credits) && evidence.released_credits >= 0 ? { released_credits: evidence.released_credits } : {}),
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
const lastPublicJobStatuses = new Map<string, Job['status']>()
let dirtyJobStreamIds = new Set<string>()

function emitPublicUpdate(job: Job): void {
  if (job.status === 'running') {
    lastLiveStreamSignatures.set(job.job_id, jobStreamSignature(job))
  } else {
    lastLiveStreamSignatures.delete(job.job_id)
  }
  lastPublicJobStatuses.set(job.job_id, job.status)
  if (jobEvents.listenerCount('update') === 0) return
  // Isolate listeners from each other — one bad handler shouldn't break the
  // queue's state machine. EventEmitter.emit is synchronous, so any throw
  // would propagate into the generator; swallow defensively.
  try { jobEvents.emit('update', serializeJob(job)) } catch { /* noop */ }
}

function emitUpdate(job: Job): void {
  const previousStatus = lastPublicJobStatuses.get(job.job_id)
  if (previousStatus === undefined || previousStatus !== job.status) {
    dirtyJobStreamIds.delete(job.job_id)
    emitPublicUpdate(job)
    return
  }
  dirtyJobStreamIds.add(job.job_id)
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
function flushDirtyJobStreams(): void {
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue
    const signature = jobStreamSignature(job)
    if (lastLiveStreamSignatures.get(job.job_id) === signature) continue
    dirtyJobStreamIds.add(job.job_id)
  }

  const pending = dirtyJobStreamIds
  dirtyJobStreamIds = new Set()
  for (const jobId of pending) {
    const job = jobs.get(jobId)
    if (job) emitPublicUpdate(job)
  }
}

export function _flushDirtyJobStreamsForTesting(): void {
  flushDirtyJobStreams()
}

setInterval(() => {
  flushDirtyJobStreams()
}, LIVE_OUTPUT_FLUSH_MS).unref()

export interface JobsClearedEvent { project_slug: string; job_ids: string[] }
function emitCleared(projectSlug: string, jobIds: string[]): void {
  for (const jobId of jobIds) {
    lastPublicJobStatuses.delete(jobId)
    lastLiveStreamSignatures.delete(jobId)
    dirtyJobStreamIds.delete(jobId)
  }
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
const cancellationReconciling = new Set<string>()
const cancellationReconcileTimers = new Map<string, NodeJS.Timeout>()
const cancelled = new Set<string>()
// Terminal history can be removed while its worker is still unwinding.
const activeRunJobIds = new Set<string>()
const pauseRequested = new Set<string>()
const queuePauseReleaseCheckpoints = new Set<string>()
const pausedTransitionClaims = new Set<string>()
const loadedProjects = new Set<string>()
const loadingProjects = new Map<string, Promise<void>>()
const projectRemovalInProgress = new Set<string>()
const PENDING_REMOTE_CANCELLATION_STATUSES = new Set(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])
const RECOVERABLE_GENSTUDIO_OPERATIONS = new Set([
  'voice.tts', 'audio.transcription', 'image.generation', 'video.generation', 'chat.response', 'music.generation',
])

function hasPendingRemoteCancellation(job: Pick<Job, 'remote_cancellations'>): boolean {
  return Object.values(job.remote_cancellations || {}).some(record => PENDING_REMOTE_CANCELLATION_STATUSES.has(record.status))
}

/**
 * One recorded provider task whose outcome can still change.
 *
 * v1.2.8 — every unsettled test in this file used to spell this out inline, so
 * teaching them about a fourth terminal case would have meant four chances to
 * miss one. `not_created` is terminal for the same reason `succeeded` and
 * `failed` are: GenStudio has answered, and no later answer is coming.
 */
function isUnsettledProviderEntry(entry: NonNullable<Job['genstudio_jobs']>[number]): boolean {
  // v1.4.81 — this used to spell the rule out here, and `job-control.ts` spelled
  // a DIFFERENT one out there. See `isSettledProviderEntry` for what that cost.
  return isUnsettledProviderEntryShared(entry)
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
  return (job.genstudio_jobs || []).some(isUnsettledProviderEntry)
}

/** Any durable provider identity is authoritative over a stale local terminal status. */
export function hasUnsettledProviderEvidence(job: Pick<Job, 'genstudio_jobs' | 'remote_cancellations'>): boolean {
  return hasPendingRemoteCancellation(job) || (job.genstudio_jobs || []).some(isUnsettledProviderEntry)
}

function hasCancellationContext(job: Pick<Job, 'remote_cancellations'>): boolean {
  return Object.keys(job.remote_cancellations || {}).length > 0
}

function hasRecoverableUnsettledGenStudioEvidence(job: Pick<Job, 'genstudio_jobs'>): boolean {
  return (job.genstudio_jobs || []).some(entry => (
    RECOVERABLE_GENSTUDIO_OPERATIONS.has(entry.operation)
    && isUnsettledProviderEntry(entry)
    && ((entry.id && !entry.id.startsWith('pending:')) || Boolean(entry.request?.idempotency_key))
  ))
}

/**
 * v1.4.81 — one image GenStudio already finished, that this Mac never downloaded.
 *
 * Deliberately UNLIKE `hasRecoverableUnsettledGenStudioEvidence`, this counts
 * `succeeded` entries. That is the whole point: the owner force-quit mid-batch,
 * GenStudio kept generating and settling for the twenty-one minutes the app was
 * dead, and those images are paid for and sitting on the server. A settled entry
 * is not "nothing left to do" — it is "collect this, for free, before the
 * artifact expires". `tryRecoverImageFromManifestEntry` in the image generators
 * does exactly that, keyed on the task id in `.task-manifest.json`.
 *
 * A terminally failed or never-created entry proves nothing reclaimable, so it
 * is excluded — same reasoning as the audio gate's `state !== 'failed'`.
 */
function hasReclaimableImageEvidence(job: Pick<Job, 'genstudio_jobs'>): boolean {
  return (job.genstudio_jobs || []).some(entry => (
    entry.operation === 'image.generation'
    && entry.cancelled !== true
    && entry.state !== 'failed'
    && !isNeverCreatedProviderTask(entry)
    && ((entry.id && !entry.id.startsWith('pending:')) || Boolean(entry.request?.idempotency_key))
  ))
}

/**
 * Can this job name the SAME output files it named before the restart?
 *
 * Resume reclaims by filename: the generator looks up `.task-manifest.json` for
 * the file it is about to write and reconnects to that saved task id. If a
 * resumed run derives different filenames, every lookup misses, every scene
 * looks missing, and the batch is submitted and paid for a second time while
 * the already-paid images sit orphaned in the folder. So filename stability is
 * a precondition for auto-resume, not a detail.
 */
function hasStableImageOutputIdentity(job: Pick<Job, 'type' | 'params'>): boolean {
  // Scene ids come from scene_plan.json on disk, so `<scene-id>.png` is stable
  // across restarts with nothing to persist and nothing to lose.
  if (job.type === 'continuity_render') return true
  // Pool filenames are `gen-<run_id>-NNNN.png`. `run_id` is persisted onto
  // params by the generator, but a crash in the moments before that first
  // persist would leave a resumed run inventing a fresh one. Require the proof.
  if (job.type === 'image_pool_generate') {
    const runId = (job.params as { run_id?: unknown } | undefined)?.run_id
    return typeof runId === 'string' && runId.trim().length > 0
  }
  return false
}

/** Continue control-plane polling until every accepted sibling is terminal. */
function requiresCancellationReconciliation(job: Pick<Job, 'genstudio_jobs' | 'remote_cancellations'>): boolean {
  // A restart can occur after the final provider status was persisted but
  // before Story recorded its own terminal state. One final read is required
  // to settle that durable evidence through the same cancellation/audit path.
  return hasCancellationContext(job)
    ? hasUnsettledProviderWork(job) || (job.genstudio_jobs || []).length > 0
    : hasRecoverableUnsettledGenStudioEvidence(job)
      || (job.genstudio_jobs || []).some(shouldRecheckStoredTranscriptionAbsence)
}

function mergeGenStudioReconciliationEvidence(
  job: Job,
  operation: NonNullable<Job['genstudio_jobs']>[number]['operation'],
  evidenceId: string,
  provider: {
    id: string
    state: string
    dispatch_state?: 'pre_dispatch' | 'dispatched'
    cancellable?: boolean | null
    cancelled?: boolean | null
    cancellation_requested?: boolean | null
    cancellation_note?: string | null
    failure_code?: string | null
    reserved_credits?: number | null
    settled_credits?: number | null
    released_credits?: number | null
    transcription_absence_verified_at?: string
  },
): void {
  const entries = [...(job.genstudio_jobs || [])]
  const recoveryKey = evidenceId.startsWith('pending:') ? evidenceId.slice('pending:'.length) : undefined
  const matches = entries.reduce<number[]>((indexes, entry, index) => {
    if (entry.operation !== operation) return indexes
    if (entry.id === evidenceId || (recoveryKey && (!entry.id || entry.id.startsWith('pending:')) && entry.request?.idempotency_key === recoveryKey)) {
      indexes.push(index)
    }
    return indexes
  }, [])
  if (matches.length !== 1) return
  const index = matches[0]!
  const prior = entries[index]!
  const {
    dispatch_state: _priorDispatchState,
    cancellable: _priorCancellable,
    cancelled: _priorCancelled,
    cancellation_requested: _priorCancellationRequested,
    cancellation_note: _priorCancellationNote,
    failure_code: _priorFailureCode,
    reserved_credits: _priorReservedCredits,
    settled_credits: _priorSettledCredits,
    released_credits: _priorReleasedCredits,
    transcription_absence_verified_at: _priorTranscriptionAbsenceVerifiedAt,
    ...priorWithoutSyntheticAbsenceFields
  } = prior
  const correctedFalseTranscriptionAbsence = isNeverCreatedProviderTask(prior)
    && shouldRecheckStoredTranscriptionAbsence(prior)
    && provider.id !== evidenceId
  entries[index] = {
    ...(isNeverCreatedProviderTask(prior) ? priorWithoutSyntheticAbsenceFields : prior),
    id: provider.id,
    ...(recoveryKey ? { request_key: recoveryKey } : {}),
    state: provider.state,
    queue_state: reconciledGenStudioQueueState(provider.state),
    ...(provider.dispatch_state !== undefined ? { dispatch_state: provider.dispatch_state } : {}),
    ...(provider.cancellable !== undefined ? { cancellable: provider.cancellable } : {}),
    ...(provider.cancelled !== undefined ? { cancelled: provider.cancelled } : {}),
    ...(provider.cancellation_requested !== undefined ? { cancellation_requested: provider.cancellation_requested } : {}),
    ...(provider.cancellation_note !== undefined ? { cancellation_note: provider.cancellation_note } : {}),
    ...(provider.failure_code !== undefined ? { failure_code: provider.failure_code } : {}),
    ...(typeof provider.reserved_credits === 'number' && Number.isFinite(provider.reserved_credits) ? { reserved_credits: provider.reserved_credits } : {}),
    ...(typeof provider.settled_credits === 'number' && Number.isFinite(provider.settled_credits) ? { settled_credits: provider.settled_credits } : {}),
    ...(typeof provider.released_credits === 'number' && Number.isFinite(provider.released_credits) ? { released_credits: provider.released_credits } : {}),
    ...(provider.transcription_absence_verified_at ? { transcription_absence_verified_at: provider.transcription_absence_verified_at } : {}),
    updated_at: new Date().toISOString(),
  }
  job.genstudio_jobs = coalesceExactProviderEvidence(job, entries)
  if (correctedFalseTranscriptionAbsence) {
    const correction = `GenStudio later located ${operation} ${provider.id}; Story Studio corrected its earlier no-record result without submitting a new request.`
    if (!job.output_lines.includes(correction)) job.output_lines.push(correction)
  }
}

/**
 * v1.2.8 — say, in the job's own log, that GenStudio has no record of a task
 * Story Studio was waiting on.
 *
 * The reason this is spelled out rather than left to a status change: the user
 * is looking at a request that appears to have vanished, and the only question
 * that matters to him is whether he paid for it. GenStudio answering "no such
 * request" is also the answer to that question — a request that was never
 * created was never reserved against and never billed — so the log says so
 * instead of leaving him to infer it. It also states plainly that Story Studio
 * will not resend it, because deciding to resend paid work is his call.
 */
function reportNeverCreatedProviderTasks(
  job: Job,
  absent: Array<{ operation: string; evidence_id: string }>,
): void {
  if (!absent.length) return
  const already = new Set(job.output_lines.slice(-40))
  for (const item of absent) {
    const line = `GenStudio has no record of ${item.operation} ${item.evidence_id}. `
      + 'That request was never created, so nothing was generated and nothing was charged for it.'
    if (!already.has(line)) job.output_lines.push(line)
  }
  const summary = absent.length === 1
    ? 'Story Studio has stopped waiting for it and will not resend it on its own — running this step again is safe, and costs only what the missing item costs.'
    : `Story Studio has stopped waiting for these ${absent.length} requests and will not resend them on its own — running this step again is safe, and costs only what the missing items cost.`
  if (!already.has(summary)) job.output_lines.push(summary)
}

function reportUnverifiedTranscriptionAbsence(job: Job): void {
  if (!(job.genstudio_jobs || []).some(shouldRecheckStoredTranscriptionAbsence)) return
  const correction = 'Story Studio is rechecking an earlier no-record transcription result. Until GenStudio responds, it cannot confirm whether that request was created or charged.'
  if (!job.output_lines.includes(correction)) job.output_lines.push(correction)
}

/**
 * The reason the primary Jobs cancellation control shows while no GenStudio key
 * exists, so the control names the missing key instead of saying only that it is
 * checking (NEW-01).
 */
const MISSING_KEY_RECONCILIATION_DETAIL =
  'The GenStudio API key is not available on this Mac, so this cancellation cannot be confirmed yet. Add it in Settings → This Mac.'

/**
 * Reconciliation has its own persisted set, not a queue worker slot. This is
 * critical after restart: it retains the duplicate lock while allowing normal
 * generation work in the same lane to proceed.
 */
async function reconcileCancellationJob(jobId: string): Promise<void> {
  if (cancellationReconciling.has(jobId)) return
  const job = jobs.get(jobId)
  if (!job || (job.status !== 'running' && job.status !== 'paused') || !requiresCancellationReconciliation(job)) return
  cancellationReconciling.add(jobId)
  try {
    // Do not claim the one cancellation POST before credentials exist. A
    // durable queued intent is safely retryable; a stranded submitting claim
    // is not useful until a later boot/control-plane pass.
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) {
      // The 5-second reschedule in the `finally` below is the mechanism by
      // which a later key save is noticed, so the waiting itself stays. What
      // must not grow is the record of it: an unconfigured Mac used to append
      // this same line — and rewrite jobs.json — once per tick for as long as
      // the job waited. State the fact once, and write only when this pass
      // actually changed something.
      const line = 'Cancellation is waiting for the GenStudio API key to be available on this Mac.'
      let changed = false
      if (!job.output_lines.slice(-8).includes(line)) {
        job.output_lines.push(line)
        changed = true
      }
      // NEW-01 — the Jobs cancellation control derives its copy from
      // `reconciliation_error`, so the same fact must live there too. Without
      // this the primary control said "Checking cancellation" and named no
      // reason while the actionable sentence sat in output_lines only.
      if (job.reconciliation_error !== MISSING_KEY_RECONCILIATION_DETAIL) {
        job.reconciliation_error = MISSING_KEY_RECONCILIATION_DETAIL
        changed = true
      }
      if (changed) {
        await persistJob(job)
        emitUpdate(job)
      }
      return
    }
    for (const [key, record] of Object.entries(job.remote_cancellations || {})) {
      if (record.status !== 'queued') continue
      const claimed = await claimRemoteCancellation(job.job_id, record.operation, record.provider_job_id).catch(() => false)
      if (!claimed) continue
      // The claim changes the in-memory object too. Reconciliation reads the
      // fresh durable state below rather than carrying a stale closure.
      job.output_lines.push(`Checking GenStudio cancellation for ${key}.`)
    }
    const outcome = await reconcilePendingJobCancellation(job, apiKey)
    job.remote_cancellations = outcome.records
    if (outcome.reason && outcome.reason !== job.reconciliation_error) job.output_lines.push(outcome.reason)
    job.reconciliation_error = outcome.reason
    for (const item of outcome.providerJobs) mergeGenStudioReconciliationEvidence(job, item.operation, item.evidence_id, item.job)
    reportNeverCreatedProviderTasks(job, outcome.absent)
    if (outcome.kind === 'pending' && outcome.reason) reportUnverifiedTranscriptionAbsence(job)

    if (outcome.kind === 'pending') {
      // v1.4.81 — this path is reached two ways, and only one of them involves
      // a cancellation. A job that arrived here from `requiresCancellationReconciliation`
      // via `hasRecoverableUnsettledGenStudioEvidence` was never cancelled by
      // anybody; it was interrupted. Telling its owner that Story Studio is
      // "reconciling the provider cancellation" reports an action he did not
      // take, on work he still wants. Say what is actually happening instead.
      const line = job.status === 'paused'
        ? 'Paused. Story Studio is checking already accepted GenStudio work; no new generation request was sent.'
        : hasCancellationContext(job)
          ? 'Story Studio is reconciling the provider cancellation; no new generation request was sent.'
          : 'Story Studio is checking what GenStudio already finished for this job; no new generation request was sent.'
      if (!job.output_lines.slice(-8).includes(line)) job.output_lines.push(line)
    } else if (job.status === 'paused') {
      const line = 'Paused. All previously accepted GenStudio work has settled; Resume will verify files and submit only missing items.'
      if (!job.output_lines.slice(-8).includes(line)) job.output_lines.push(line)
    } else if (!job.local_execution_complete) {
      // A live generator can receive its provider success before it has
      // downloaded/checkpointed the authoritative output. Persist that remote
      // truth now, but leave the duplicate lock and audit for runJob's local
      // boundary. Recovered jobs explicitly set this marker at load time.
      job.output_lines.push('GenStudio settled provider work; waiting for the active local executor to finish saving output before verification.')
    } else {
      await finalizeSettledProviderJob(job.job_id)
    }
    await persistJob(job)
    emitUpdate(job)
    if (outcome.kind !== 'pending' && job.status === 'paused') {
      await recoverSafelySettledStallJobs([job])
    }
  } catch (error) {
    // Fail closed: keep status=running and duplicate lock. A later boot/load
    // or explicit status refresh can resume read-only reconciliation.
    const job = jobs.get(jobId)
    if (job?.status === 'running' || job?.status === 'paused') {
      const reason = redactSensitiveValue(`Cancellation reconciliation is waiting: ${error instanceof Error ? error.message : String(error)}`)
      if (reason !== job.reconciliation_error) job.output_lines.push(reason)
      job.reconciliation_error = reason
      await persistJob(job)
      emitUpdate(job)
    }
  } finally {
    cancellationReconciling.delete(jobId)
    const latest = jobs.get(jobId)
    if ((latest?.status === 'running' || latest?.status === 'paused') && requiresCancellationReconciliation(latest)) {
      const existing = cancellationReconcileTimers.get(jobId)
      if (!existing) {
        const timer = setTimeout(() => {
          cancellationReconcileTimers.delete(jobId)
          scheduleCancellationReconciliation(jobId)
        }, 5_000)
        timer.unref()
        cancellationReconcileTimers.set(jobId, timer)
      }
    }
  }
}

function scheduleCancellationReconciliation(jobId: string): void {
  void reconcileCancellationJob(jobId)
}

// ── v1.2.6 — re-checking a FINISHED job's provider evidence ──────────────
//
// Why this did not already happen: `reconcileCancellationJob` refuses any job
// that is not `running` or `paused`. Every job the dismiss gate blocks is
// `done`, `error` or `cancelled`, so the one piece of machinery that could
// have refreshed the evidence was, by its own guard, permanently ineligible
// for exactly the jobs that needed it. A snapshot entry that was mid-flight
// when the job finished therefore stayed mid-flight for good, and the gate
// kept asserting the provider was still working from a reading it had never
// refreshed. The owner hit this on an EP0058 audio job: nine of ten TTS calls
// succeeded, the tenth was recorded as accepted, and the card could never be
// dismissed even though GenStudio had settled every one of them and was
// holding zero credits.
//
// This is the same reconciliation path, run read-only. A finished job is not
// asking to be cancelled, so it never issues a control POST — it only asks
// what the current state is, writes the answer into the stored evidence, and
// lets the gate decide again.
const historyEvidenceRefreshing = new Map<string, Promise<void>>()

function isFinishedStatus(status: Job['status']): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

/** The gate's own predicate: which finished jobs still carry non-terminal evidence. */
function needsHistoryEvidenceRefresh(job: Job): boolean {
  if (!isFinishedStatus(job.status)) return false
  // v1.2.8 — an abandoned job is one the owner told Story Studio to stop
  // tracking. Re-asking GenStudio about it would re-block the very history row
  // he just cleared himself out of, and would be asking a question he has
  // already said he does not want answered.
  if (job.force_abandoned) return false
  return (job.genstudio_jobs || []).some(entry => (
    entry.state !== 'cancelled' && isUnsettledProviderEntry(entry)
  )) || (job.genstudio_jobs || []).some(shouldRecheckStoredTranscriptionAbsence)
    || hasPendingRemoteCancellation(job)
}

async function refreshFinishedJobProviderEvidence(jobId: string): Promise<void> {
  const inFlight = historyEvidenceRefreshing.get(jobId)
  if (inFlight) return inFlight
  const job = jobs.get(jobId)
  if (!job || !needsHistoryEvidenceRefresh(job)) return
  let settled!: () => void
  const waiter = new Promise<void>(resolve => { settled = resolve })
  historyEvidenceRefreshing.set(jobId, waiter)
  const previous = job.history_evidence_check?.state
  try {
    job.history_evidence_check = { state: 'checking', at: new Date().toISOString() }
    emitUpdate(job)

    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) {
      await recordHistoryEvidenceCheck(job, 'unreachable', previous, 'The GenStudio API key is not available on this Mac, so the provider could not be asked.')
      return
    }

    const outcome = await reconcilePendingJobCancellation(job, apiKey, { readOnly: true })
    job.remote_cancellations = outcome.records
    for (const item of outcome.providerJobs) mergeGenStudioReconciliationEvidence(job, item.operation, item.evidence_id, item.job)
    reportNeverCreatedProviderTasks(job, outcome.absent)
    if (outcome.kind === 'pending' && outcome.reason) reportUnverifiedTranscriptionAbsence(job)

    // v1.2.9 — `needsHistoryEvidenceRefresh` answers false for two entirely
    // different reasons: the evidence really is settled, or the owner abandoned
    // the job and stopped asking. Only the first is a confirmation. If he
    // abandoned it while this check was in flight, saying "GenStudio confirmed
    // every recorded provider task has finished" would write success evidence
    // nobody has — onto the one job we know least about.
    if (job.force_abandoned) {
      delete job.history_evidence_check
      await persistJob(job)
      emitUpdate(job)
      return
    }
    if (!needsHistoryEvidenceRefresh(job)) {
      // GenStudio confirmed everything is terminal. Nothing is outstanding, so
      // the gate opens on this same snapshot with no further clicks.
      delete job.history_evidence_check
      job.output_lines.push('GenStudio confirmed every recorded provider task for this job has finished. This history can now be removed.')
      await persistJob(job)
      emitUpdate(job)
      return
    }
    await recordHistoryEvidenceCheck(
      job,
      outcome.reason ? 'unreachable' : 'unsettled',
      previous,
      outcome.reason ? redactSensitiveValue(outcome.reason) : undefined,
    )
  } catch (error) {
    const latest = jobs.get(jobId)
    if (latest) {
      await recordHistoryEvidenceCheck(
        latest, 'unreachable', previous,
        redactSensitiveValue(`GenStudio status check failed: ${error instanceof Error ? error.message : String(error)}`).slice(0, 320),
      )
    }
  } finally {
    historyEvidenceRefreshing.delete(jobId)
    settled()
  }
}

async function recordHistoryEvidenceCheck(
  job: Job,
  state: 'unreachable' | 'unsettled',
  previous: string | undefined,
  detail?: string,
): Promise<void> {
  job.history_evidence_check = { state, at: new Date().toISOString(), ...(detail ? { detail } : {}) }
  if (previous !== state) {
    job.output_lines.push(state === 'unreachable'
      ? `Story Studio could not confirm this job's remaining provider work with GenStudio.${detail ? ` ${detail}` : ''}`
      : 'GenStudio reports this job still has provider work that has not finished.')
  }
  await persistJob(job)
  emitUpdate(job)
}

function scheduleHistoryEvidenceRefresh(jobId: string): void {
  void refreshFinishedJobProviderEvidence(jobId)
}

/**
 * The enabled "Check GenStudio again" control. Awaited, so the caller learns
 * the real answer rather than being told a check was scheduled.
 */
export async function recheckJobProviderStatus(projectSlug: string, jobId: string): Promise<Job> {
  await loadPersistedJobs(projectSlug)
  const job = jobs.get(jobId)
  if (!job || job.project_slug !== projectSlug) {
    throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
  }
  // Boot refresh publishes an intermediate `unreachable` result before its
  // persistence finishes. A manual check in that window must wait, then issue
  // its own provider read instead of returning as if it had checked.
  await historyEvidenceRefreshing.get(jobId)
  const current = jobs.get(jobId)
  if (!current || current.project_slug !== projectSlug) {
    throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
  }
  if (!needsHistoryEvidenceRefresh(current)) return serializeJob(current)
  await refreshFinishedJobProviderEvidence(jobId)
  return serializeJob(jobs.get(jobId) || job)
}

/** Finalize only after a returned local executor and authoritative provider settlement. */
async function finalizeSettledProviderJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'running' || !job.local_execution_complete) return
  if (!(job.genstudio_jobs || []).length || hasUnsettledProviderEvidence(job)) return
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
    } else if (evidence.some(entry => entry.cancelled === true)) {
      // A mixed success/cancellation is not a complete output set. Preserve
      // every artifact and make the existing Repair path explicit.
      job.status = 'error'
      job.error = 'Provider work settled with mixed completed and cancelled tasks. Repair missing output before Retry.'
      job.result = { ...(job.result || {}), provider_settled: 'mixed', repair_required: true }
      job.output_lines.push(job.error)
    } else if (evidence.some(isNeverCreatedProviderTask)) {
      // v1.2.8 — GenStudio has no record of at least one request this job was
      // waiting on. That is a definite answer, so the job STOPS here instead of
      // falling through to the "terminal but not classifiable" hold below and
      // staying running forever. It is an error rather than a success because
      // whatever that request was for does not exist; it is not a provider
      // failure, and the wording refuses to call it one.
      const missing = evidence.filter(isNeverCreatedProviderTask).length
      job.status = 'error'
      job.error = `GenStudio has no record of ${missing} request${missing === 1 ? '' : 's'} from this job. `
        + `${missing === 1 ? 'It' : 'They'} never reached the provider, so nothing was generated and nothing was charged. `
        + 'Every other request settled. Retry resubmits only what is missing.'
      job.result = { ...(job.result || {}), provider_settled: 'never-created', repair_required: true }
      job.output_lines.push(job.error)
    } else if (evidence.length && evidence.every(entry => entry.state === 'succeeded')) {
      const auditor = getJobCancellationAuditor(job.type)
      if (!auditor) {
        // A settled provider task with no way to verify local output is a dead
        // end, not a wait. The interrupted executor is gone, no control-plane
        // pass will register an auditor, no reconcile timer remains (the
        // evidence is settled), and `retryTerminalJob` refuses a `running` row —
        // so the old "keep running" branch stranded the job with Abandon as its
        // only exit. AGENTS.md §8: unverifiable output is never success, so fail
        // loudly, retain the provider evidence, and let the owner Retry.
        job.status = 'error'
        job.error = 'GenStudio finished this step\'s provider work, but Story Studio cannot verify the local output because no completion audit is registered for this job type. Retry runs this step again; the settled provider task stays recorded as evidence.'
        job.result = { ...(job.result || {}), provider_settled: 'succeeded', repair_required: true }
        job.finished_at = new Date().toISOString()
        job.output_lines.push(job.error)
        await persistJob(job)
        emitUpdate(job)
        return
      }
      let audit: 'complete' | 'repair-required'
      try { audit = await auditor(serializeJob(job)) }
      catch (error) {
        job.status = 'error'
        job.error = 'Completion audit failed; repair missing output before Retry.'
        job.output_lines.push(`${job.error} (${error instanceof Error ? error.message : String(error)})`)
        job.finished_at = new Date().toISOString()
        await persistJob(job)
        emitUpdate(job)
        return
      }
      if (audit !== 'complete') {
        job.status = 'error'
        job.error = 'Provider output needs repair before this job can be marked complete. Retry repairs only missing output.'
        job.result = { ...(job.result || {}), provider_settled: 'succeeded', repair_required: true }
        job.output_lines.push(job.error)
      } else {
        // Mark that THIS path has already re-read the output (it audited just
        // above), so the shared `completeSuccessfulJob` does not audit a second
        // time. `simultaneous final provider updates run the auditor and
        // terminal transition once` pins that contract — an unguarded audit
        // inside `completeSuccessfulJob` broke it, which is why this marker
        // exists instead of a second call.
        job.result = { ...(job.result || {}), provider_settled: 'succeeded', output_audited: 'provider-settlement' }
        await completeSuccessfulJob(job)
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
let queuePauseInitialization: Promise<void> | null = null
const QUEUE_PAUSED_KEY = 'job_queue_paused'
const QUEUE_PAUSE_TRANSITION_LOCK = 'job-queue:pause-transition'

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
export type JobExecutorResult = void | { kind: 'paid-image-wait' }
type JobExecutor = (job: Job) => Promise<JobExecutorResult>

interface QueueState {
  pending: Job[]
  running: boolean
  executor: JobExecutor | null
}

let queuePumpObserverForTesting: ((type: JobType, releasedJobId?: string) => void) | null = null

/** Test-only observation of queue admission attempts and grouped-slot releases. */
export function _observeQueuePumpsForTesting(observer: (type: JobType, releasedJobId?: string) => void): () => void {
  const previous = queuePumpObserverForTesting
  queuePumpObserverForTesting = observer
  return () => {
    if (queuePumpObserverForTesting === observer) queuePumpObserverForTesting = previous
  }
}

const queues: Record<JobType, QueueState> = {
  idea_campaign: { pending: [], running: false, executor: null },
  broll_select: { pending: [], running: false, executor: null },
  // Legacy `script` queue removed in M1 — chapters and intro now flow
  // through `script-only` and `introduction-only` independently. The
  // per-chapter refactor added `chapter-only` for targeted regens.
  'script-only': { pending: [], running: false, executor: null },
  'introduction-only': { pending: [], running: false, executor: null },
  // ── DO NOT GIVE `chapter-only` A PARALLEL LANE ──────────────────────────
  //
  // Its dedup is deliberately narrowed by `chapter_number` (routes/scripts.ts),
  // so several DIFFERENT chapters of one episode can sit in this queue at once.
  // routes/scripts.ts says they "run back-to-back" — that is true only because
  // this is a single-slot lane. `chapter-only` is in no group set, so `groupOf`
  // returns the type name and `pump` takes the `q.running` branch: exactly one
  // runs process-wide.
  //
  // Every one of them calls `assembleUnifiedNarration` (lib/narration-assembly.ts),
  // which rewrites ONE shared narration document for the episode from scratch and
  // contains zero mutual exclusion — verified 2026-08-26: `withLock` appears 0
  // times in that file, and there is no mutex, semaphore or in-flight map either.
  // Two of these running at once would interleave over that one document.
  //
  // So: putting this type in LLM_TYPES (or any other shared-budget group) to make
  // chapter regens faster is a data-loss change, not a throughput change. Lock
  // narration assembly first, then revisit. This has now been proposed twice for
  // the wrong reason, because the reason lived somewhere nobody reads.
  'chapter-only': { pending: [], running: false, executor: null },
  // v1.0.72+ outline-first chunked flow. outline_only is a small LLM call
  // (one batch); expand_chapters is the heavier multi-batch expansion.
  // They share queue plumbing with the other script jobs.
  outline_only: { pending: [], running: false, executor: null },
  expand_chapters: { pending: [], running: false, executor: null },
  image_prompts: { pending: [], running: false, executor: null },
  thumb_images: { pending: [], running: false, executor: null },
  // Image repair uses the queue lifecycle but never submits a new provider job.
  images_repair: { pending: [], running: false, executor: null },
  audio: { pending: [], running: false, executor: null },
  audio_merge: { pending: [], running: false, executor: null },
  // v1.4.37 — its own lane. Music tops up a library ahead of time and is never
  // on the critical path of an episode, so it must not compete with narration
  // audio for that lane's slots.
  music_generate: { pending: [], running: false, executor: null },
  // Assembly is local FFmpeg work that buys nothing, so it shares no lane with
  // anything that spends money and cannot be starved by a paid queue.
  music_video: { pending: [], running: false, executor: null },
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
  // v1.0.470 — Phase 2: animate one scene's image into a clip (image-to-video).
  scene_clip_generate: { pending: [], running: false, executor: null },
  scene_clips_batch: { pending: [], running: false, executor: null },
  // v1.0.410+: generate stills into an Image Pool (grow the pool).
  image_pool_generate: { pending: [], running: false, executor: null },
  // v1.0.194+: continuity-chain sequential renderer. Renders every scene in
  // scene_plan.json in order, each img2img-anchored to the previous render +
  // the character sheet/characters. One long serial job (resumable).
  continuity_render: { pending: [], running: false, executor: null },
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

// ── Shared LLM lineup availability holds ───────────────────────────────────
//
// A temporary language-product absence is neither a failure nor local work to
// sleep through.  Keep the durable job queued, remove it from its lane while
// it waits, and let the timer re-admit that exact job when the published (or
// bounded local) availability time arrives.  This deliberately uses a
// different state from the paid-image wait: no provider request was accepted
// for a lineup hold, and the policy executor owns the saved request keys.
const llmLineupWaitTimers = new Map<string, NodeJS.Timeout>()
const MAX_QUEUE_TIMER_DELAY_MS = 0x7fffffff

function validRetryAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Trust a checkpoint wait only when this job carries the matching, enabled
 * shared-lineup policy.  A loose `retry_at` field is never enough to defer a
 * queue item, especially when it may have provider evidence from other work.
 */
function waitingCheckpointRetryAt(job: Job): string | null {
  if (hasUnsettledProviderEvidence(job)) return null
  const stage = writingStageForJob(job.type)
  if (!stage) return null
  const policy = pipelinePolicyForJob(job.params, stage)
  if (policy?.wait_for_availability !== true) return null
  const checkpoints = job.params?.pipeline_model_checkpoints
  if (!checkpoints || typeof checkpoints !== 'object' || Array.isArray(checkpoints)) return null
  let earliest: string | null = null
  for (const checkpoint of Object.values(checkpoints as Record<string, unknown>)) {
    const parsed = readPipelinePolicyAttemptCheckpoint(checkpoint)
    if (parsed?.status !== 'waiting' || validRetryAtMs(parsed.retry_at) === null) continue
    if (!earliest || Date.parse(parsed.retry_at!) < Date.parse(earliest)) earliest = parsed.retry_at!
  }
  return earliest
}

function lineupWaitRetryAt(job: Job, error?: unknown): string | null {
  if (hasUnsettledProviderEvidence(job)) return null
  if (isLlmLineupWaitingError(error) && validRetryAtMs(error.retryAt) !== null) return error.retryAt
  return waitingCheckpointRetryAt(job)
}

function clearLlmLineupWaitTimer(jobId: string): void {
  const timer = llmLineupWaitTimers.get(jobId)
  if (!timer) return
  clearTimeout(timer)
  llmLineupWaitTimers.delete(jobId)
}

function lineUpWaitingMessage(retryAt: string): string {
  return `Waiting for model availability until ${retryAt}. No provider request was submitted while every eligible model was temporarily unavailable.`
}

async function releaseLlmLineupWaitIfDue(jobId: string): Promise<void> {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'queued' || job.force_abandoned || cancelled.has(jobId) || pauseRequested.has(jobId)) {
    clearLlmLineupWaitTimer(jobId)
    return
  }
  const retryAt = typeof job.params?.llm_lineup_retry_at === 'string' ? job.params.llm_lineup_retry_at : null
  const retryAtMs = validRetryAtMs(retryAt)
  if (!retryAt || retryAtMs === null) {
    clearLlmLineupWaitTimer(jobId)
    return
  }
  if (Date.now() < retryAtMs) {
    scheduleLlmLineupWait(job)
    return
  }
  // A global or per-job pause is authoritative over a due availability check.
  // Resume's normal pump will re-admit this due row without changing the
  // checkpoint or creating any provider identity.
  if (queuePaused || job.pause_origin || job.pause_requested) return

  clearLlmLineupWaitTimer(jobId)
  delete job.params.llm_lineup_retry_at
  job.error = null
  job.finished_at = null
  job.output_lines.push('Model availability recheck is due — returning this saved job to its queue lane.')
  try {
    await persistJob(job)
  } catch (error) {
    // Keep the durable hold in memory when storage is temporarily unavailable.
    // Retrying the release later is safe because no executor was admitted.
    job.params.llm_lineup_retry_at = retryAt
    job.error = lineUpWaitingMessage(retryAt)
    scheduleLlmLineupWait(job, 1_000)
    throw error
  }
  // Controls can win while the durable release write is in flight. Never put
  // a newly paused, cancelled, or abandoned row back into a pending lane.
  if (job.status !== 'queued' || job.force_abandoned || cancelled.has(jobId)
    || pauseRequested.has(jobId) || job.pause_requested || job.pause_origin) return
  emitUpdate(job)
  if (!pendingContains(job.type, job.job_id)) queues[job.type].pending.push(job)
  if (IMAGE_EPISODE_TYPES.has(job.type)) pumpImageEpisodeGroup(imageEpisodeConcurrency)
  else pump(job.type)
}

function scheduleLlmLineupWait(job: Job, minimumDelayMs = 0): boolean {
  const retryAt = typeof job.params?.llm_lineup_retry_at === 'string' ? job.params.llm_lineup_retry_at : null
  const retryAtMs = validRetryAtMs(retryAt)
  if (!retryAt || retryAtMs === null || job.status !== 'queued' || job.force_abandoned || cancelled.has(job.job_id)) {
    clearLlmLineupWaitTimer(job.job_id)
    return false
  }
  clearLlmLineupWaitTimer(job.job_id)
  const delayMs = Math.min(MAX_QUEUE_TIMER_DELAY_MS, Math.max(minimumDelayMs, retryAtMs - Date.now()))
  const timer = setTimeout(() => {
    llmLineupWaitTimers.delete(job.job_id)
    void releaseLlmLineupWaitIfDue(job.job_id).catch(error => {
      console.warn('[job-queue] failed to release LLM lineup availability wait', {
        job_id: job.job_id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, delayMs)
  timer.unref()
  llmLineupWaitTimers.set(job.job_id, timer)
  return true
}

function parkForLlmLineupAvailability(job: Job, retryAt: string): void {
  clearLlmLineupWaitTimer(job.job_id)
  job.params.llm_lineup_retry_at = retryAt
  job.status = 'queued'
  job.finished_at = null
  job.local_execution_complete = false
  job.pause_requested = false
  job.pause_origin = undefined
  job.error = lineUpWaitingMessage(retryAt)
  job.output_lines.push(job.error)
}

function isQueuedLlmLineupWait(job: Job): boolean {
  return job.status === 'queued' && typeof job.params?.llm_lineup_retry_at === 'string'
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
/**
 * v1.4.39 — the image episode group.
 *
 * MEASURED 2026-08-23. The owner queued 50 Scene Review jobs at 100+ images an
 * episode and asked whether his machines were all working. They were not: 21 of
 * 74 online fleet workers were busy and 51 were idle, and a location connected
 * that morning had ONE busy worker out of twenty.
 *
 * The fleet was not the limit and neither was GenStudio — his account is tier 5
 * with priority, so its burst ceiling is 128 concurrent paid jobs and only 25
 * were running. The limit was HERE: every type outside the LLM and subtitle
 * groups falls to `groupLimit() === 1`, one boolean slot per lane. So fifty
 * queued episodes ran strictly one at a time, and each episode's internal
 * fan-out was the only parallelism in the system.
 *
 * These four types all buy images from the same fleet, so they share ONE budget
 * rather than getting a lane each — otherwise four lanes of three would be
 * twelve episodes and the number nobody set is the one that bites.
 */
const IMAGE_EPISODE_GROUP = 'image_episode'
const THUMBNAIL_EPISODE_GROUP = 'thumbnail_episode'
const VIDEO_EPISODE_GROUP = 'video_episode'
const AUDIO_EPISODE_GROUP = 'audio_episode'

/**
 * v1.4.41 — SEPARATE budgets per kind of fleet work, all reading one setting.
 *
 * THE OWNER'S POINT, and it is the one that generalises: "when we reach the
 * last 8 images and the machines stall, the rest of the workers have nothing to
 * do... that's why we must have at least 2-3 episodes able to queue alongside,
 * so when the first finishes it just joins the second. I think this should
 * apply to all types of generation actually."
 *
 * Exactly right, and 1.4.39 only half-did it: `continuity_render` — SCENE
 * REVIEW, the very job type he had 50 of queued — was not in the image group,
 * so the fix missed the batch that prompted it. He found that, not a test.
 *
 * WHY THREE GROUPS RATHER THAN ONE SHARED BUDGET. Audio and image do not
 * compete for the same fleet capability, and one shared number would let a
 * fifty-episode image batch starve a single narration job behind it. Separate
 * budgets mean a kind of work can always start even while another kind is
 * saturated. They read the SAME setting, so there is still one dial.
 *
 * Local-only work (music_video, broll_normalize, video_assembly) is deliberately
 * absent: it is CPU on this Mac, not fleet capacity, and running three at once
 * would compete with the machine the owner is using.
 *
 * v1.4.49 — THUMBNAILS ARE THEIR OWN LANE, for the same reason audio is not in
 * the image lane. The owner: "thumbnail usually is me using cloud api while
 * for the scene review i'll usually use my local flux 2 klein. can we split
 * the 2 so a 3 thumbnail generation doesn't block my local fleet?"
 *
 * He is right and the comment above already said why without going far enough:
 * the test is whether two kinds of work compete for the SAME capacity. Three
 * thumbnail episodes on a cloud API consumed the whole image budget and left
 * forty-one local machines idle waiting for a slot they were never going to
 * take. Separate lanes mean neither can starve the other.
 *
 * Split by JOB TYPE rather than by which model was chosen, deliberately: the
 * lane a job sits in must be knowable when it is queued and must not change
 * under it. If he ever renders thumbnails on the local fleet they get their own
 * budget rather than sharing Scene Review's — a stated trade, and the reason
 * both numbers are his to set.
 */
/**
 * WHY `scene_image_generate` IS NOT HERE — verified 2026-08-26, second time.
 *
 * It has now been proposed twice that this type is missing by oversight, on the
 * grounds that "Generate all missing" fans out one job per scene and so it is
 * the biggest offender in the app. IT DOES NOT, and the reason belongs here
 * rather than only in the test file, because HERE is where the next person
 * edits the set and the reason has to be in front of them when they do.
 *
 * MEASURED, not assumed:
 *   • `POST /scene-review/:ep/generate-missing` enqueues ONE `continuity_render`
 *     covering every missing scene — see routes/scene-review.ts. That type is
 *     already in this set, so the bulk path is already pipelined at the owner's
 *     setting. The UI even says so: "Queued one render for N missing scenes".
 *   • `POST /scene-review/:ep/generate-image` enqueues exactly ONE scene, from
 *     the per-scene regenerate button. One job, one image, no fan-out.
 *
 * So this type is the app's SMALLEST unit of image work, not its largest, and
 * it keeps its own lane deliberately: a one-image repair must never queue
 * behind three bulk renders of a hundred images each. Sharing the budget would
 * make the cheapest, most interactive request in the app wait on the most
 * expensive ones — and buy nothing, because a job that is one image cannot be
 * "batched" any harder than it already is.
 *
 * If `generate-missing` is ever changed back to enqueue per-scene jobs, this
 * decision must be revisited — and the test below fails loudly if it is.
 */
const IMAGE_EPISODE_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'image_pool_generate', 'continuity_render',
])
const THUMBNAIL_EPISODE_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'thumb_images',
])
const VIDEO_EPISODE_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'video', 'scene_clip_generate', 'scene_clips_batch',
])
const AUDIO_EPISODE_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'audio', 'music_generate',
])
const FLEET_EPISODE_GROUPS: ReadonlySet<string> = new Set([
  IMAGE_EPISODE_GROUP, THUMBNAIL_EPISODE_GROUP, VIDEO_EPISODE_GROUP, AUDIO_EPISODE_GROUP,
])
function fleetEpisodeTypesFor(group: string): ReadonlySet<JobType> {
  if (group === THUMBNAIL_EPISODE_GROUP) return THUMBNAIL_EPISODE_TYPES
  if (group === VIDEO_EPISODE_GROUP) return VIDEO_EPISODE_TYPES
  if (group === AUDIO_EPISODE_GROUP) return AUDIO_EPISODE_TYPES
  return IMAGE_EPISODE_TYPES
}
// `research_run` was missing from this set for a long time — an omission, not
// a policy. The release that introduced this group (v1.0.335) names the text types
// it covered and the four lanes it deliberately kept serial; research is in
// neither list, and nothing in the code or history ever gave it a reason to be
// alone. Outside this set `groupOf` falls through to the type's own name and
// `groupLimit` returns 1, so fifty-one queued research jobs ran strictly one at
// a time however high the owner set "Writing jobs at once".
//
// It belongs in the SHARED budget rather than a lane of its own: research is an
// ordinary GenStudio-bound text call, and a second lane would make the real
// number of concurrent writing jobs one nobody chose.
const LLM_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'idea_campaign', 'outline_only', 'expand_chapters', 'metadata', 'image_prompts', 'scene_plan_run',
  'research_run',
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
  if (IMAGE_EPISODE_TYPES.has(type)) return IMAGE_EPISODE_GROUP
  if (THUMBNAIL_EPISODE_TYPES.has(type)) return THUMBNAIL_EPISODE_GROUP
  if (VIDEO_EPISODE_TYPES.has(type)) return VIDEO_EPISODE_GROUP
  if (AUDIO_EPISODE_TYPES.has(type)) return AUDIO_EPISODE_GROUP
  return LLM_TYPES.has(type) ? LLM_GROUP : type
}
/** Active (running) job count for the shared LLM group. Non-LLM types track
 *  their single slot via `QueueState.running` (unchanged). */
const groupActive: Record<string, number> = {}
const activeImageEpisodeJobIds = new Set<string>()
/**
 * Synchronous admission reservations for the in-place Jobs Finish action.
 * `mutateAuthoritativeJob` durably writes before it updates the live map, so
 * the live-job dedupe alone has a small await window. This reservation closes
 * that window for both competing Finish requests and ordinary enqueue calls.
 */
const finishMissingReservations = new Map<string, string>()
function finishMissingReservationKey(projectSlug: string, episodeId: string): string {
  return `${projectSlug}:${episodeId}`
}
/** A generous local staging cap keeps Story responsive without recreating a
 * user-facing concurrency policy that can conflict with GenStudio. */
let llmConcurrency = 50
let subtitleTranscribeConcurrency = 50
let imageEpisodeConcurrency = 1
let imageEpisodeCursor = 0
let imageEpisodeBootAdmissionHolds = 0
/**
 * Thumbnails have their own budget because they usually buy from a cloud API
 * while Scene Review buys from the local fleet. Starts at 1 for the same
 * reason as the image lane: a build that never applies the owner's setting is
 * unchanged rather than surprising.
 */
let thumbnailEpisodeConcurrency = 1
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
/**
 * Starts at 1 — today's behaviour exactly — so a build that never applies the
 * owner's setting is unchanged rather than surprising. `boot` reads the stored
 * value and raises it; nothing here decides policy.
 */
export function setImageEpisodeConcurrency(n: number): void {
  imageEpisodeConcurrency = Math.max(1, Math.min(50, Math.floor(Number(n)) || 1))
  pumpImageEpisodeGroup(imageEpisodeConcurrency)
  for (const group of FLEET_EPISODE_GROUPS) {
    if (group === IMAGE_EPISODE_GROUP) continue
    for (const t of fleetEpisodeTypesFor(group)) pump(t)
  }
  noteAdaptiveImageTailEvent()
}
export function getImageEpisodeConcurrency(): number {
  return imageEpisodeConcurrency
}

export function setThumbnailEpisodeConcurrency(n: number): void {
  thumbnailEpisodeConcurrency = Math.max(1, Math.min(50, Math.floor(Number(n)) || 1))
  for (const t of fleetEpisodeTypesFor(THUMBNAIL_EPISODE_GROUP)) pump(t)
}
export function getThumbnailEpisodeConcurrency(): number {
  return thumbnailEpisodeConcurrency
}

/**
 * The owner's explicit images-per-episode override, or 0 for "follow the
 * account". Held here beside the other live concurrency values so a generator
 * can read it synchronously mid-run rather than awaiting a settings read for
 * every job.
 */
let imageFanoutOverride = 0
export function setImageFanoutOverride(n: unknown): void {
  const value = Math.floor(Number(n))
  imageFanoutOverride = Number.isFinite(value) && value >= 1 ? Math.min(500, value) : 0
}
export function getImageFanoutOverride(): number {
  return imageFanoutOverride
}
function groupLimit(group: string): number {
  if (group === LLM_GROUP) return llmConcurrency
  // Local Chat Studio work is admitted immediately; its own dispatcher owns
  // the machine queue and backpressure.
  if (group === LOCAL_LLM_GROUP) return Number.POSITIVE_INFINITY
  if (group === SUBTITLE_TRANSCRIBE_GROUP) return subtitleTranscribeConcurrency
  if (group === THUMBNAIL_EPISODE_GROUP) return thumbnailEpisodeConcurrency
  if (FLEET_EPISODE_GROUPS.has(group)) return imageEpisodeConcurrency
  return 1
}

// ── Persistence ─────────────────────────────────────────────────────────────

type JobFileLockProbe = (
  operation: 'hydrate' | 'inspect' | 'persist',
  jobsFile: string,
) => void | Promise<void>

let jobFileLockProbeForTesting: JobFileLockProbe | undefined

export type JobPersistenceCounters = {
  project_snapshot_reads: number
  safe_job_calls: number
  atomic_writes: number
  public_serializations: number
}

const jobPersistenceCounters: JobPersistenceCounters = {
  project_snapshot_reads: 0,
  safe_job_calls: 0,
  atomic_writes: 0,
  public_serializations: 0,
}

export function _getJobPersistenceCountersForTesting(): JobPersistenceCounters {
  return { ...jobPersistenceCounters }
}

export function _resetJobPersistenceCountersForTesting(): void {
  for (const key of Object.keys(jobPersistenceCounters) as Array<keyof JobPersistenceCounters>) {
    jobPersistenceCounters[key] = 0
  }
}

/** Test-only inside-lock synchronization; production has no hook installed. */
export function _setJobFileLockProbeForTesting(probe: JobFileLockProbe): () => void {
  const previous = jobFileLockProbeForTesting
  jobFileLockProbeForTesting = probe
  return () => {
    if (jobFileLockProbeForTesting === probe) jobFileLockProbeForTesting = previous
  }
}

function jobsPath(projectSlug: string): string {
  // Honour linked-project locations so iCloud-synced projects read +
  // write their jobs.json in the right place.
  const dir = getProjectDir(projectSlug) || path.join(projectsRoot(), projectSlug)
  return path.join(dir, 'jobs.json')
}

async function persistProjectSnapshot(projectSlug: string): Promise<void> {
  // A project snapshot is an upsert batch, not a replacement.  The process
  // global map is lazy, so replacing from it can erase unloaded durable jobs.
  await Promise.all(Array.from(jobs.values())
    .filter(job => job.project_slug === projectSlug)
    .map(job => {
      const incoming = safeJob(job)
      return persistProjectMutation(projectSlug, {
        kind: 'transform',
        jobId: job.job_id,
        transform: current => mergeDurableJobEvidence(current, incoming),
      })
    }))
}

/**
 * Queue-owned project removal boundary. The in-memory insertion point is
 * synchronous, while persistence is asynchronous, so disk alone cannot
 * protect a delete/unlink immediately after enqueue.
 */
export async function withProjectJobRemovalGuard<T>(
  projectSlug: string,
  projectDir: string,
  action: () => Promise<T>,
): Promise<T> {
  if (projectRemovalInProgress.has(projectSlug)) {
    throw Object.assign(new Error('Project removal is already being checked. Return later and retry.'), { statusCode: 409 })
  }
  projectRemovalInProgress.add(projectSlug)
  try {
    return await withLock(path.join(projectDir, 'jobs.json'), async () => {
      const active = Array.from(jobs.values()).find(job => (
        job.project_slug === projectSlug
        && (!TERMINAL_JOB_STATUSES.has(job.status) || hasUnsettledProviderEvidence(job))
      ))
      if (active) {
        throw Object.assign(
          new Error(`Project has active or unsettled provider job ${active.job_id}. Return later until Story Studio confirms final settlement.`),
          { statusCode: 409 },
        )
      }
      // This is under the same mutex as persistJob, so a queued snapshot
      // finishes before the restart-safe disk evidence is inspected.
      const { assertProjectJobsSafeToRemove } = await import('./project-job-removal-guard.js')
      await assertProjectJobsSafeToRemove(projectDir)
      return action()
    })
  } finally {
    projectRemovalInProgress.delete(projectSlug)
  }
}

function safeJob(job: Job): Omit<Job, never> {
  jobPersistenceCounters.safe_job_calls++
  // Jobs are both renderer-visible diagnostics and durable project records.
  // Provider adapters should never put credentials in params/output, but this
  // final boundary is deny-by-default so an accidental future field cannot
  // leak into jobs.json, SSE, exports, or support screenshots.
  const copy = redactSensitiveValue(structuredClone(job))
  delete copy.control
  delete copy.controls
  return copy
}

/** Public job snapshots derive controls at the last possible moment. */
type RendererPaidImageReplacementAttempt = Pick<PaidImageReplacementAttempt,
  'state' | 'eligible_at' | 'replacement_committed_at' | 'quoted_credits' | 'price_version' | 'actual_settled_credits'> & {
  reason?: NonNullable<PaidImageReplacementAttempt['public_reason']> | 'automatic_replacement_unavailable'
}
type RendererJob = Omit<Job, 'paid_image_replacement_attempts' | 'generation_replacement_attempts' | 'manual_failed_item_replacement'> & {
  paid_image_replacement_attempt?: RendererPaidImageReplacementAttempt
}

export const PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE =
  'Automatic image replacement is unavailable. No replacement was submitted.'

export function recordPaidImageReplacementPublicReason(
  job: Job,
  reason: NonNullable<PaidImageReplacementAttempt['public_reason']>,
): void {
  job.result = {
    ...(job.result || {}),
    image_replacement: { state: 'blocked', reason, submitted: false },
  }
}

function serializeJob(job: Job): RendererJob {
  jobPersistenceCounters.public_serializations++
  const copy = safeJob(job)
  if (copy.params?.manual_image_finish) {
    delete copy.params.manual_image_finish.uncertain_identity_hashes
    delete copy.params.manual_image_finish.expected_uncertain_identity_hashes
  }
  const latestPaidImageAttempt = copy.paid_image_replacement_attempts?.at(-1)
  const privateReasons = (copy.paid_image_replacement_attempts || [])
    .map(attempt => attempt.reason?.trim())
    .filter((reason): reason is string => Boolean(reason))
  delete copy.paid_image_replacement_attempts
  delete copy.generation_replacement_attempts
  delete copy.manual_failed_item_replacement
  const rendererJob: RendererJob = copy
  if (privateReasons.length) {
    if (rendererJob.error && privateReasons.some(reason => rendererJob.error!.includes(reason))) {
      rendererJob.error = PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE
    }
    rendererJob.output_lines = rendererJob.output_lines.map(line => (
      privateReasons.some(reason => line.includes(reason))
        ? PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE
        : line
    ))
  }
  if (latestPaidImageAttempt) {
    rendererJob.paid_image_replacement_attempt = {
      state: latestPaidImageAttempt.state,
      eligible_at: latestPaidImageAttempt.eligible_at,
      ...(latestPaidImageAttempt.replacement_committed_at ? { replacement_committed_at: latestPaidImageAttempt.replacement_committed_at } : {}),
      ...(latestPaidImageAttempt.quoted_credits !== undefined ? { quoted_credits: latestPaidImageAttempt.quoted_credits } : {}),
      ...(latestPaidImageAttempt.price_version ? { price_version: latestPaidImageAttempt.price_version } : {}),
      ...(latestPaidImageAttempt.state === 'blocked' ? {
        reason: latestPaidImageAttempt.public_reason || 'automatic_replacement_unavailable',
      } : {}),
      ...(latestPaidImageAttempt.actual_settled_credits !== undefined ? { actual_settled_credits: latestPaidImageAttempt.actual_settled_credits } : {}),
    }
  }
  rendererJob.controls = classifyJobControls(job, {
    remoteCancellationAudited: hasJobCancellationAuditor(job.type),
  })
  rendererJob.control = classifyJobControl(job, {
    remoteCancellationAudited: hasJobCancellationAuditor(job.type),
  })
  return rendererJob
}

type ProjectPersistenceState = {
  baseline: Map<string, Job> | null
  hydratePromise: Promise<void> | null
  revision: number
  durableRevision: number
  writing: Promise<void> | null
  dirty: boolean
  pendingMutations: number
  waiters: Array<{ revision: number; resolve: () => void; reject: (error: unknown) => void }>
}
type ProjectJobMutation =
  | { kind: 'transform'; jobId: string; transform: (current: Job | null) => Job | null }
  | { kind: 'delete'; jobId: string }
const projectPersistence = new Map<string, ProjectPersistenceState>()

function projectPersistenceState(projectSlug: string): ProjectPersistenceState {
  let state = projectPersistence.get(projectSlug)
  if (!state) {
    state = {
      baseline: null, hydratePromise: null, revision: 0, durableRevision: 0,
      writing: null, dirty: false, pendingMutations: 0, waiters: [],
    }
    projectPersistence.set(projectSlug, state)
  }
  return state
}

async function hydrateProjectBaseline(projectSlug: string, state: ProjectPersistenceState): Promise<void> {
  if (state.baseline) return
  if (!state.hydratePromise) {
    const p = jobsPath(projectSlug)
    state.hydratePromise = withLock(p, async () => {
      assertWriteIsolatedInTests(p, 'job-queue')
      if (jobFileLockProbeForTesting) await jobFileLockProbeForTesting('hydrate', p)
      jobPersistenceCounters.project_snapshot_reads++
      let durable: Job[] = []
      try {
        if (existsSync(p)) {
          const parsed = JSON.parse(await fs.readFile(p, 'utf-8')) as { jobs?: unknown }
          if (!Array.isArray(parsed.jobs)) throw new Error('jobs.json does not contain a jobs array')
          durable = parsed.jobs as Job[]
        }
      } catch (error) {
        state.hydratePromise = null
        throw error
      }
      state.baseline = new Map(durable.map(job => [job.job_id, structuredClone(job)]))
    })
  }
  await state.hydratePromise
}

async function drainProjectPersistence(projectSlug: string, state: ProjectPersistenceState): Promise<void> {
  let failedRevision = state.durableRevision
  let retryAfterFailure = false
  try {
    while (state.dirty) {
      state.dirty = false
      const revision = state.revision
      failedRevision = revision
      const baseline = state.baseline!
      const baselineEntries = new Map(baseline)
      const snapshot = retainJobsForPersistence(Array.from(baseline.values()).map(job => safeJob(job)))
      const retainedIds = new Set(snapshot.map(job => job.job_id))
      const p = jobsPath(projectSlug)
      assertWriteIsolatedInTests(p, 'job-queue')
      await withLock(p, async () => {
        if (jobFileLockProbeForTesting) await jobFileLockProbeForTesting('persist', p)
        await writeJsonAtomic(p, { jobs: snapshot })
        jobPersistenceCounters.atomic_writes++
        for (const [jobId, captured] of baselineEntries) {
          if (!retainedIds.has(jobId) && baseline.get(jobId) === captured) baseline.delete(jobId)
        }
      })
      state.durableRevision = revision
      const ready = state.waiters.filter(waiter => waiter.revision <= revision)
      state.waiters = state.waiters.filter(waiter => waiter.revision > revision)
      ready.forEach(waiter => waiter.resolve())
    }
  } catch (error) {
    state.dirty = true
    // Mutations that arrived after the failed snapshot was captured are still
    // valid later intent. Keep their waiters for the retry instead of making a
    // concurrent pause/cancel report the unrelated snapshot failure.
    const failed = state.waiters.filter(waiter => waiter.revision <= failedRevision)
    state.waiters = state.waiters.filter(waiter => waiter.revision > failedRevision)
    failed.forEach(waiter => waiter.reject(error))
    retryAfterFailure = state.waiters.length > 0
    throw error
  } finally {
    state.writing = null
    if (retryAfterFailure) queueMicrotask(() => startProjectPersistence(projectSlug, state))
  }
}

function applyProjectMutation(state: ProjectPersistenceState, mutation: ProjectJobMutation): Promise<void> {
  if (mutation.kind === 'delete') state.baseline!.delete(mutation.jobId)
  else {
    const previous = state.baseline!.get(mutation.jobId) || null
    const next = mutation.transform(previous ? structuredClone(previous) : null)
    if (next) state.baseline!.set(mutation.jobId, safeJob(next))
  }
  const revision = ++state.revision
  state.dirty = true
  return new Promise<void>((resolve, reject) => state.waiters.push({ revision, resolve, reject }))
}

function startProjectPersistence(projectSlug: string, state: ProjectPersistenceState): void {
  if (!state.writing) {
    state.writing = drainProjectPersistence(projectSlug, state)
    void state.writing.catch(() => {})
  }
}

async function persistProjectMutation(projectSlug: string, mutation: ProjectJobMutation): Promise<void> {
  const state = projectPersistenceState(projectSlug)
  state.pendingMutations++
  try {
    await hydrateProjectBaseline(projectSlug, state)
    // The baseline is process-owned and applyProjectMutation is synchronous.
    // Locking this tiny in-memory step serializes every member of a batch
    // behind the writer, defeating snapshot coalescing. The writer still
    // holds the jobs.json lock for the only disk mutation; mutations arriving
    // while it is writing are picked up by its next dirty pass.
    const durable = applyProjectMutation(state, mutation)
    // Let the current synchronous burst of mutations join the same snapshot
    // before the writer captures its baseline. This is what makes a project
    // batch one atomic write instead of one write per record.
    queueMicrotask(() => startProjectPersistence(projectSlug, state))
    await durable
  } finally {
    state.pendingMutations--
  }
}

/** Wait for already-started background writes before a test removes its data root. */
export async function _waitForJobPersistenceForTesting(): Promise<void> {
  let observedIdle = false
  while (true) {
    const states = [...projectPersistence.values()]
    const active = states.flatMap(state => [
      ...(state.writing ? [state.writing] : []),
      ...(state.baseline === null && state.hydratePromise ? [state.hydratePromise] : []),
    ])
    if (active.length === 0 && states.every(state => state.pendingMutations === 0)) {
      if (observedIdle) return
      observedIdle = true
      await new Promise<void>(resolve => setImmediate(resolve))
      continue
    }
    observedIdle = false
    if (active.length > 0) await Promise.allSettled(active)
    else await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Drain tracked children and already-started project writes within the shutdown budget. */
export async function drainJobPersistenceForShutdown(timeoutMs: number): Promise<boolean> {
  let stopped = false
  const drained = (async () => {
    let observedIdle = false
    while (!stopped) {
      const states = [...projectPersistence.values()]
      if (states.some(state => state.dirty && !state.writing && state.pendingMutations === 0)) return false
      const active = states.flatMap(state => [
        ...(state.writing ? [state.writing] : []),
        ...(state.baseline === null && state.hydratePromise ? [state.hydratePromise] : []),
      ])
      const idle = childrenByJob.size === 0 && active.length === 0
        && states.every(state => state.pendingMutations === 0 && !state.dirty)
      if (idle) {
        if (observedIdle) return true
        observedIdle = true
        await new Promise<void>(resolve => setImmediate(resolve))
        continue
      }
      observedIdle = false
      if (active.length === 0) {
        await new Promise<void>(resolve => setImmediate(resolve))
        continue
      }
      const results = await Promise.allSettled(active)
      if (results.some(result => result.status === 'rejected')) return false
    }
    return false
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>(resolve => {
    timer = setTimeout(() => {
      stopped = true
      resolve(false)
    }, Math.max(0, timeoutMs))
    timer.unref?.()
  })
  const result = await Promise.race([drained, timedOut])
  stopped = true
  if (timer) clearTimeout(timer)
  return result
}

type GenStudioEvidence = NonNullable<Job['genstudio_jobs']>[number]

function providerRequestKey(entry: GenStudioEvidence): string | undefined {
  const keys = [entry.request_key, entry.request?.idempotency_key,
    entry.id.startsWith('pending:') ? entry.id.slice('pending:'.length) : undefined]
    .filter((key): key is string => typeof key === 'string' && key.length > 0)
  return new Set(keys).size === 1 ? keys[0] : undefined
}

/**
 * Fold pre-submit receipts into their exact accepted task. Keep the small
 * correlation key independently of the bounded request preview; otherwise
 * merging disk evidence resurrects old placeholders after preview pruning.
 * Legacy image checkpoints provide the same exact ownership proof.
 */
function coalesceExactProviderEvidence(job: Pick<Job, 'params'>, input: GenStudioEvidence[]): GenStudioEvidence[] {
  const byIdentity = new Map<string, GenStudioEvidence>()
  for (let entry of input) {
    const identity = `${entry.operation}:${entry.id}`
    const requestKey = providerRequestKey(entry)
    if (requestKey) entry = { ...entry, request_key: requestKey }
    const existing = byIdentity.get(identity)
    if (!existing) {
      byIdentity.set(identity, entry)
      continue
    }
    const newer = entry.updated_at >= existing.updated_at ? entry : existing
    const older = newer === entry ? existing : entry
    const request = newer.request ?? older.request
    byIdentity.set(identity, { ...older, ...newer, ...(request ? { request } : {}) })
  }

  const acceptedByKey = new Map<string, GenStudioEvidence[]>()
  for (const entry of byIdentity.values()) {
    const requestKey = providerRequestKey(entry)
    if (entry.id.startsWith('pending:') || !requestKey) continue
    const identity = `${entry.operation}:${requestKey}`
    acceptedByKey.set(identity, [...(acceptedByKey.get(identity) || []), entry])
  }
  for (const [identity, entry] of byIdentity) {
    const requestKey = providerRequestKey(entry)
    if (!entry.id.startsWith('pending:') || !requestKey) continue
    // Conflicting task ownership must remain visible until reconciled.
    if (acceptedByKey.get(`${entry.operation}:${requestKey}`)?.length === 1) byIdentity.delete(identity)
  }

  const recovery = job.params?.genstudio_recovery
  if (recovery?.version !== 1 || recovery.route !== 'genstudio'
    || !recovery.assets || typeof recovery.assets !== 'object') return [...byIdentity.values()]
  for (const asset of Object.values(recovery.assets) as Array<Record<string, unknown>>) {
    const taskId = asset?.job_id
    const idempotencyKey = asset?.idempotency_key
    if (asset?.operation !== 'image'
      || typeof taskId !== 'string' || !taskId.trim() || taskId.startsWith('pending:')
      || typeof idempotencyKey !== 'string' || !idempotencyKey.startsWith('story-')) continue
    const real = byIdentity.get(`image.generation:${taskId}`)
    const pendingIdentity = pendingGenStudioEntryId(idempotencyKey)
    const pending = byIdentity.get(`image.generation:${pendingIdentity}`)
    if (!real || !pending || real.operation !== 'image.generation' || pending.operation !== 'image.generation'
      || (real.request_key !== undefined && real.request_key !== idempotencyKey)
      || (pending.request_key !== undefined && pending.request_key !== idempotencyKey)
      || (real.request?.idempotency_key !== undefined && real.request.idempotency_key !== idempotencyKey)
      || (pending.request?.idempotency_key !== undefined && pending.request.idempotency_key !== idempotencyKey)) continue
    byIdentity.delete(`image.generation:${pendingIdentity}`)
  }
  return [...byIdentity.values()]
}

function mergeDurableJobEvidence(previous: Job | null, incoming: Job): Job {
  if (!previous) return {
    ...incoming,
    ...(incoming.genstudio_jobs
      ? { genstudio_jobs: coalesceExactProviderEvidence(incoming, incoming.genstudio_jobs) }
      : {}),
  }
  const providerById = new Map((previous.genstudio_jobs || []).map(entry => [`${entry.operation}:${entry.id}`, entry]))
  for (const entry of incoming.genstudio_jobs || []) {
    const identity = `${entry.operation}:${entry.id}`
    const existing = providerById.get(identity)
    if (!existing || entry.updated_at >= existing.updated_at) providerById.set(identity, entry)
  }
  const remoteCancellations = { ...(previous.remote_cancellations || {}) }
  for (const [key, record] of Object.entries(incoming.remote_cancellations || {})) {
    const existing = remoteCancellations[key]
    if (!existing || record.updated_at >= existing.updated_at) remoteCancellations[key] = record
  }
  const attempts = mergePaidImageReplacementAttempts(
    previous.paid_image_replacement_attempts,
    incoming.paid_image_replacement_attempts,
  )
  const merged = {
    ...incoming,
    generation_replacement_attempts: mergeGenerationReplacementAttempts(previous.generation_replacement_attempts, incoming.generation_replacement_attempts),
    ...(Object.keys(remoteCancellations).length > 0 ? { remote_cancellations: remoteCancellations } : {}),
    ...(attempts ? { paid_image_replacement_attempts: attempts } : {}),
  }
  const providerJobs = coalesceExactProviderEvidence(merged, [...providerById.values()])
  return {
    ...merged,
    ...(providerJobs.length > 0 ? { genstudio_jobs: providerJobs } : {}),
  }
}

async function persistJob(job: Job): Promise<void> {
  const incoming = safeJob(job)
  await persistProjectMutation(job.project_slug, {
    kind: 'transform',
    jobId: job.job_id,
    transform: current => mergeDurableJobEvidence(current, incoming),
  })
  const settled = TERMINAL_JOB_STATUSES.has(job.status)
    || (job.status === 'paused' && !hasUnsettledProviderEvidence(job))
  if (job.type === 'continuity_render' && settled) {
    await deactivateSceneRenderStatus(job.project_slug, job.episode_id, job.job_id).catch(() => {})
  }
}

/**
 * Narrow durable boundary for paid image commitment.  It reads the on-disk
 * authority under the same jobs.json lock as normal queue persistence; callers
 * must not use a worker's stale in-memory copy to authorize a charge.
 */
async function readLockedAuthoritativeJob(file: string, jobId: string): Promise<Job | null> {
  if (!existsSync(file)) return null
  const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { jobs?: unknown }
  if (!Array.isArray(parsed.jobs)) throw new Error('jobs.json does not contain a jobs array')
  const found = (parsed.jobs as Job[]).find(job => job.job_id === jobId)
  return found ? structuredClone(found) : null
}

export async function loadAuthoritativeJob(projectSlug: string, jobId: string): Promise<Job | null> {
  const p = jobsPath(projectSlug)
  return withLock(p, () => readLockedAuthoritativeJob(p, jobId))
}

/** Evaluate one read-only predicate while normal jobs.json persistence is excluded. */
export async function inspectAuthoritativeJob(
  projectSlug: string,
  jobId: string,
  inspect: (job: Job) => boolean,
): Promise<boolean | null> {
  const state = projectPersistenceState(projectSlug)
  await hydrateProjectBaseline(projectSlug, state)
  const p = jobsPath(projectSlug)
  return withLock(p, async () => {
    if (jobFileLockProbeForTesting) await jobFileLockProbeForTesting('inspect', p)
    const found = await readLockedAuthoritativeJob(p, jobId)
    if (!found) return null
    const result = inspect(found)
    if (typeof result !== 'boolean') throw new Error('authoritative job inspection must be synchronous')
    return result
  })
}

/** The paired write side of `loadAuthoritativeJob`, retained as one test seam. */
export async function writeAuthoritativeJob(job: Job): Promise<void> {
  await persistJob(job)
}

/** Test-only fixture reset; production mutations must use the canonical writer. */
export function _forgetProjectPersistenceForTesting(projectSlug: string): void {
  const state = projectPersistence.get(projectSlug)
  if (state?.writing || state?.pendingMutations) throw new Error(`Cannot reset active persistence for ${projectSlug}`)
  projectPersistence.delete(projectSlug)
}

/**
 * Atomic paid-attempt mutation. It shares the normal queue's jobs.json lock,
 * so a checkpoint cannot interleave between a paid read and its durable write.
 */
export async function mutateAuthoritativeJob(
  projectSlug: string,
  jobId: string,
  mutate: (job: Job) => Job | null,
): Promise<Job | null> {
  const state = projectPersistenceState(projectSlug)
  state.pendingMutations++
  try {
    await hydrateProjectBaseline(projectSlug, state)
    const result = await withLock(jobsPath(projectSlug), async () => {
      const found = state.baseline!.get(jobId)
      if (!found) return null
      const transformed = mutate(structuredClone(found))
      if (!transformed) return null
      const next = mergeDurableJobEvidence(found, transformed)
      const durable = applyProjectMutation(state, { kind: 'transform', jobId, transform: () => next })
      return { next, durable }
    })
    if (!result) return null
    startProjectPersistence(projectSlug, state)
    await result.durable
    const live = jobs.get(jobId)
    if (live) Object.assign(live, result.next)
    return structuredClone(result.next)
  } finally {
    state.pendingMutations--
  }
}

/** Persist one provider-side transition of the already committed paid attempt. */
export async function checkpointPaidImageReplacementAttempt(
  job: Job,
  assetKey: string,
  update: Pick<PaidImageReplacementAttempt, 'state'>
    & Partial<Pick<PaidImageReplacementAttempt, 'replacement_task_id' | 'actual_settled_credits' | 'reason'>>,
): Promise<PaidImageReplacementAttempt> {
  const durable = await mutateAuthoritativeJob(job.project_slug, job.job_id, (authoritative) => {
    const attempts = authoritative.paid_image_replacement_attempts || []
    const matches = attempts.filter(attempt => attempt.asset_key === assetKey)
    if (matches.length !== 1) return null
    const current = matches[0]!
    const allowed = current.state === 'waiting'
      ? new Set(['blocked'])
      : current.state === 'committed'
      ? new Set(['submitted', 'succeeded', 'failed', 'blocked'])
      : current.state === 'submitted'
        ? new Set(['succeeded', 'failed', 'blocked'])
        : new Set<string>()
    if (!allowed.has(update.state)) return null
    if (update.state === 'submitted' && !update.replacement_task_id?.trim()) return null
    const next = { ...current, ...update }
    authoritative.paid_image_replacement_attempts = attempts.map(attempt => attempt === current ? next : attempt)
    return authoritative
  })
  if (!durable) throw new Error(`Paid image replacement attempt ${assetKey} could not transition to ${update.state}.`)
  Object.assign(job, durable)
  emitUpdate(job)
  return job.paid_image_replacement_attempts!.find(attempt => attempt.asset_key === assetKey)!
}

/** Block the one existing paid attempt, without inventing an attempt for an ineligible asset. */
export async function checkpointPaidImageReplacementBlockedIfPresent(
  job: Job,
  assetKey: string,
  reason: string,
  publicReason?: NonNullable<PaidImageReplacementAttempt['public_reason']>,
): Promise<boolean> {
  const durable = await mutateAuthoritativeJob(job.project_slug, job.job_id, (authoritative) => {
    const attempts = authoritative.paid_image_replacement_attempts || []
    const matches = attempts.filter(attempt => attempt.asset_key === assetKey)
    if (matches.length !== 1 || !['waiting', 'committed', 'submitted'].includes(matches[0]!.state)) return null
    const current = matches[0]!
    authoritative.paid_image_replacement_attempts = attempts.map(attempt => (
      attempt === current ? {
        ...current, state: 'blocked', reason,
        ...(publicReason ? { public_reason: publicReason } : {}),
      } : attempt
    ))
    return authoritative
  })
  if (!durable) return false
  Object.assign(job, durable)
  emitUpdate(job)
  return true
}

/** Identity-only half used for accepted-artifact reconciliation even after Off. */
function findPaidImageReplacementSubmitPermission(
  job: Job,
  assetKey: string,
  manifestDir: string,
  manifestKey: string,
  entry: TaskManifestEntry,
): PaidImageReplacementAttempt | null {
  const matches = (job.paid_image_replacement_attempts || []).filter(attempt => attempt.asset_key === assetKey)
  if (matches.length !== 1) return null
  const attempt = matches[0]!
  if ((attempt.state !== 'committed' && attempt.state !== 'submitted')
    || attempt.manifest_dir !== manifestDir || attempt.manifest_key !== manifestKey
    || !attempt.replacement_scope || attempt.replacement_scope !== entry.replacement_scope
    || attempt.original_task_id !== entry.task_id
    || attempt.original_idempotency_key !== entry.idempotency_key
    || attempt.input_hash !== entry.input_hash
    || attempt.output_path !== entry.original_output_path
    || entry.replacement_of_task_id !== attempt.original_task_id
    || entry.replacement_quoted_credits !== attempt.quoted_credits
    || entry.replacement_price_version !== attempt.price_version
    || entry.replacement_committed_at !== attempt.replacement_committed_at
    || JSON.stringify(entry.original_output_selector) !== JSON.stringify(attempt.output_selector)
    || JSON.stringify(entry.original_reference_inputs) !== JSON.stringify(attempt.reference_inputs)
    || entry.original_reference_identity_hash !== attempt.reference_identity_hash) return null
  return attempt
}

/** Re-admit a committed POST only while the current machine setting remains On. */
export async function getPaidImageReplacementSubmitPermission(
  job: Job,
  assetKey: string,
  manifestDir: string,
  manifestKey: string,
  entry: TaskManifestEntry,
): Promise<PaidImageReplacementAttempt | null> {
  return withPaidImageWaitSettingGate(async () => {
    const attempt = findPaidImageReplacementSubmitPermission(job, assetKey, manifestDir, manifestKey, entry)
    if (!attempt) return null
    const setting = await getPaidImageReplacementSetting().catch(() => null)
    // An accepted replacement is recovery-only. Never mutate its evidence or
    // grant another POST while Off; the separate artifact permission below
    // may still reconcile a file that the accepted task already finished.
    if (attempt.state === 'submitted') return setting?.enabled ? attempt : null
    if (setting?.enabled) return attempt
    await checkpointPaidImageReplacementBlockedIfPresent(
      job, assetKey, 'paid image replacement is currently off on this machine', 'replacement_disabled',
    )
    return null
  })
}

/** Exact pre-POST guard shared by every supported image generator. */
export async function assertPaidImageReplacementSubmitPermission(
  job: Job,
  assetKey: string,
  manifestDir: string,
  manifestKey: string,
  entry: TaskManifestEntry,
): Promise<void> {
  if (!await getPaidImageReplacementSubmitPermission(job, assetKey, manifestDir, manifestKey, entry)) {
    throw new Error(PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
  }
}

/** Reconcile an existing artifact only after a real replacement task was durably accepted. */
export function getPaidImageReplacementArtifactPermission(
  job: Job,
  assetKey: string,
  manifestDir: string,
  manifestKey: string,
  entry: TaskManifestEntry,
): PaidImageReplacementAttempt | null {
  const attempt = findPaidImageReplacementSubmitPermission(job, assetKey, manifestDir, manifestKey, entry)
  return attempt?.state === 'submitted' && attempt.replacement_task_id?.trim() ? attempt : null
}

/**
 * Build a read-only provider recovery entry for an already accepted paid task.
 * This never grants submit authority: the replacement task id and its
 * strict committed manifest must agree before a generator may issue the status
 * GET that can reclaim the artifact. The secondary GenStudio checkpoint is
 * written after the submitted transition, so a crash may legitimately leave it
 * absent; only an exact checkpoint contributes its idempotency key/state.
 */
export function getPaidImageReplacementRecoveryEntry(
  job: Job,
  assetKey: string,
  manifestDir: string,
  manifestKey: string,
  entry: TaskManifestEntry,
): TaskManifestEntry | null {
  const attempt = getPaidImageReplacementArtifactPermission(job, assetKey, manifestDir, manifestKey, entry)
  if (!attempt?.replacement_task_id) return null
  const recovery = (job.params as any)?.genstudio_recovery
  const checkpoint = recovery?.version === 1 && recovery?.route === 'genstudio'
    ? recovery.assets?.[assetKey]
    : null
  const exactCheckpoint = checkpoint && checkpoint.operation === 'image' && checkpoint.state !== 'failed'
    && checkpoint.job_id === attempt.replacement_task_id
    && typeof checkpoint.idempotency_key === 'string' && checkpoint.idempotency_key.startsWith('story-')
    && (checkpoint.input_hash === undefined || checkpoint.input_hash === attempt.input_hash)
  return {
    ...entry,
    task_id: attempt.replacement_task_id,
    idempotency_key: exactCheckpoint ? checkpoint.idempotency_key : undefined,
    last_state: exactCheckpoint ? checkpoint.state : 'accepted',
  }
}

/**
 * Persist a durable checkpoint while a long-running executor is still active.
 * Accepted GenStudio work uses this so a monitoring disconnect can reconnect
 * without submitting it again.
 */
export async function checkpointJobState(job: Job): Promise<void> {
  await persistJob(job)
  emitUpdate(job)
  if (job.type === 'continuity_render') noteAdaptiveImageTailEvent()
}

const PAID_IMAGE_WAIT_MS = 30 * 60 * 1_000
const PAID_IMAGE_WAIT_TYPES = new Set<JobType>(['continuity_render', 'image_pool_generate', 'thumb_images'])
type PaidImageWaitTimer = unknown
export type PersistedRunningJobLoadStage =
  | 'pause-requested'
  | 'paid-image-wait'
  | 'ordinary-recovery'
  | 'cancellation-reconciliation'
  | 'interrupted-terminalization'
let persistedRunningJobLoadStageObserver: ((jobId: string, stage: PersistedRunningJobLoadStage) => void) | null = null
interface PaidImageWaitRuntime {
  nowMs: () => number
  setTimer: (callback: () => void, delayMs: number) => PaidImageWaitTimer
  clearTimer: (timer: PaidImageWaitTimer) => void
  persistWait: (job: Job) => Promise<void>
  emitWait: (job: Job) => void
}
const defaultPaidImageWaitRuntime: PaidImageWaitRuntime = {
  nowMs: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  persistWait: job => persistJob(job),
  emitWait: job => emitUpdate(job),
}
let paidImageWaitRuntime = defaultPaidImageWaitRuntime
const paidImageWaitTimers = new Map<string, PaidImageWaitTimer>()
const paidImageWaitRequeues = new Map<string, Promise<void>>()
const paidImageCommitHolds = new Set<string>()
let paidImageWaitSettingGate: Promise<void> = Promise.resolve()
let paidImageSettingReconciliation: Promise<void> = Promise.resolve()

async function withPaidImageWaitSettingGate<T>(work: () => Promise<T>): Promise<T> {
  const previous = paidImageWaitSettingGate
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  paidImageWaitSettingGate = previous.then(() => current)
  await previous
  try { return await work() } finally { release() }
}

/** App-settings uses this before writing Off so due work cannot cross it. */
export async function withPaidImageWaitSettingMutation<T>(work: () => Promise<T>): Promise<T> {
  return withPaidImageWaitSettingGate(work)
}

async function withPaidImageWaitJobMutex<T>(jobId: string, work: () => Promise<T>): Promise<T> {
  const previous = paidImageWaitRequeues.get(jobId) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  paidImageWaitRequeues.set(jobId, current)
  await previous
  try { return await work() } finally {
    release()
    if (paidImageWaitRequeues.get(jobId) === current) paidImageWaitRequeues.delete(jobId)
  }
}

/** Deterministic clock/timer seam for restart and lifecycle tests. */
export function _setPaidImageWaitRuntimeForTesting(
  overrides: Partial<PaidImageWaitRuntime>,
): () => void {
  const previous = paidImageWaitRuntime
  paidImageWaitRuntime = { ...defaultPaidImageWaitRuntime, ...overrides }
  return () => {
    for (const timer of paidImageWaitTimers.values()) paidImageWaitRuntime.clearTimer(timer)
    paidImageWaitTimers.clear()
    paidImageWaitRuntime = previous
  }
}

/** Test-only trace seam for proving mutually exclusive restart branch order. */
export function _observePersistedRunningJobLoadStagesForTesting(
  observer: (jobId: string, stage: PersistedRunningJobLoadStage) => void,
): () => void {
  const previous = persistedRunningJobLoadStageObserver
  persistedRunningJobLoadStageObserver = observer
  return () => { persistedRunningJobLoadStageObserver = previous }
}

function observePersistedRunningJobLoadStage(job: Job, stage: PersistedRunningJobLoadStage): void {
  persistedRunningJobLoadStageObserver?.(job.job_id, stage)
}

/** Test-only stale-timer fixture for independent lifecycle cleanup checks. */
export function _seedPaidImageWaitTimerForTesting(jobId: string, timer: PaidImageWaitTimer): () => void {
  const previous = paidImageWaitTimers.get(jobId)
  paidImageWaitTimers.set(jobId, timer)
  return () => {
    if (paidImageWaitTimers.get(jobId) === timer) paidImageWaitTimers.delete(jobId)
    if (previous !== undefined) paidImageWaitTimers.set(jobId, previous)
  }
}

function clearPaidImageWaitTimer(jobId: string): void {
  if (!paidImageWaitTimers.has(jobId)) return
  const timer = paidImageWaitTimers.get(jobId)
  paidImageWaitRuntime.clearTimer(timer)
  paidImageWaitTimers.delete(jobId)
}

function clearAllPaidImageWaitTimers(): void {
  for (const jobId of [...paidImageWaitTimers.keys()]) clearPaidImageWaitTimer(jobId)
}

onAppSettingWritten(key => {
  if (key !== 'paid_image_replacement') return
  const reconcile = () => reconcilePaidImageReplacementSetting()
  paidImageSettingReconciliation = paidImageSettingReconciliation.then(reconcile, reconcile)
})

/** Deterministic test barrier for the asynchronous app-setting listener. */
export async function _awaitPaidImageSettingReconciliationForTesting(): Promise<void> {
  await paidImageSettingReconciliation
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Pure, jobs.json-only half of the durable paid-wait contract. Manifest and
 * artifact checks deliberately stay async below: this fixed predicate must be
 * usable by timer callbacks without turning a filesystem read into hidden IO.
 */
export function getValidPaidImageWait(job: Job): { attempt: PaidImageReplacementAttempt; dueAtMs: number } | null {
  if (
    job.status !== 'running' || job.finished_at !== null || !PAID_IMAGE_WAIT_TYPES.has(job.type)
    || job.pause_requested === true || hasCancellationContext(job) || Boolean(job.force_abandoned)
  ) return null
  const policy = job.paid_image_replacement
  if (
    policy?.enabled !== true || policy.wait_minutes !== 30 || policy.max_replacements_per_asset !== 1
    || !Number.isSafeInteger(policy.additional_credit_ceiling) || (policy.additional_credit_ceiling || 0) <= 0
    || !isNonEmptyString(policy.snapshotted_at) || !Number.isFinite(Date.parse(policy.snapshotted_at))
  ) return null
  const attempts = job.paid_image_replacement_attempts || []
  const waiting = attempts.filter(attempt => attempt.state === 'waiting')
  if (waiting.length !== 1) return null
  const attempt = waiting[0]!
  if (attempts.filter(candidate => candidate.asset_key === attempt.asset_key).length !== 1) return null
  if (
    !isNonEmptyString(attempt.asset_key) || !isNonEmptyString(attempt.manifest_dir)
    || !isNonEmptyString(attempt.manifest_key) || !isNonEmptyString(attempt.output_path)
    || !isNonEmptyString(attempt.original_task_id) || !isNonEmptyString(attempt.original_idempotency_key)
    || !isSha256(attempt.input_hash) || !isSha256(attempt.reference_identity_hash)
    || !FLEET_BUSY_FAILURE_CODES.has(attempt.failure_code) || attempt.replacement_scope !== undefined
    || attempt.replacement_task_id !== undefined || attempt.replacement_committed_at !== undefined
    || attempt.quoted_credits !== undefined || attempt.price_version !== undefined
    || attempt.actual_settled_credits !== undefined || attempt.reason !== undefined
  ) return null
  const selector = attempt.output_selector
  if (
    !selector || !isNonEmptyString(selector.resolution) || !isNonEmptyString(selector.aspect_ratio)
    || !Number.isSafeInteger(selector.width) || selector.width <= 0 || !Number.isSafeInteger(selector.height) || selector.height <= 0
    || (selector.reference_mode !== 'normal' && selector.reference_mode !== 'reference-guided')
    || !Array.isArray(attempt.reference_inputs)
    || !attempt.reference_inputs.every(reference => (
      isNonEmptyString(reference.role) && isNonEmptyString(reference.path) && isSha256(reference.sha256)
    ))
  ) return null
  if (![attempt.reserved_credits, attempt.settled_credits, attempt.released_credits].every(value => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  )) || attempt.reserved_credits !== attempt.settled_credits + attempt.released_credits || attempt.settled_credits <= 0) return null
  const observedAtMs = Date.parse(attempt.terminal_observed_at)
  const dueAtMs = Date.parse(attempt.eligible_at)
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(dueAtMs) || dueAtMs !== observedAtMs + PAID_IMAGE_WAIT_MS) return null
  const checkpoint = (job.params as any)?.genstudio_recovery?.assets?.[attempt.asset_key]
  if (
    !checkpoint || checkpoint.operation !== 'image' || checkpoint.state !== 'failed'
    || checkpoint.job_id !== attempt.original_task_id || checkpoint.idempotency_key !== attempt.original_idempotency_key
    || checkpoint.output_path !== attempt.output_path
  ) return null
  return { attempt, dueAtMs }
}

async function hasBoundPaidImageWaitManifest(job: Job, attempt: PaidImageReplacementAttempt): Promise<boolean> {
  try {
    if (await isDecodableImage(attempt.output_path)) return false
    const entry = (await readManifest(attempt.manifest_dir)).tasks[attempt.manifest_key]
    return Boolean(entry
      && entry.task_id === attempt.original_task_id
      && entry.idempotency_key === attempt.original_idempotency_key
      && entry.operation === 'image' && entry.last_state === 'failed'
      && entry.input_hash === attempt.input_hash
      && entry.original_output_path === attempt.output_path
      && sameJson(entry.original_output_selector, attempt.output_selector)
      && sameJson(entry.original_reference_inputs, attempt.reference_inputs)
      && entry.original_reference_identity_hash === attempt.reference_identity_hash
      && entry.replacement_of_task_id === undefined
      && entry.replacement_scope === undefined
      && entry.replacement_quoted_credits === undefined
      && entry.replacement_price_version === undefined
      && entry.replacement_committed_at === undefined)
  } catch {
    return false
  }
}

function pendingContains(type: JobType, jobId: string): boolean {
  return queues[type].pending.some(job => job.job_id === jobId)
}

function hasPaidImageWaitRuntimePermission(job: Job): boolean {
  return Boolean(queues[job.type]?.executor)
    && !pauseRequested.has(job.job_id)
    && !cancelled.has(job.job_id)
}

async function requeuePaidImageWaitIfDue(job: Job): Promise<boolean> {
  return withPaidImageWaitSettingGate(() => withPaidImageWaitJobMutex(job.job_id, () => requeuePaidImageWaitIfDueNow(job)))
}

async function requeuePaidImageWaitIfDueNow(job: Job): Promise<boolean> {
  const authoritative = await loadAuthoritativeJob(job.project_slug, job.job_id).catch(() => null)
  if (!authoritative) return false
  const valid = getValidPaidImageWait(authoritative)
  if (!valid || !hasPaidImageWaitRuntimePermission(authoritative) || !await hasBoundPaidImageWaitManifest(authoritative, valid.attempt)) {
    clearPaidImageWaitTimer(job.job_id)
    return false
  }
  if (paidImageWaitRuntime.nowMs() < valid.dueAtMs) return false
  const setting = await getPaidImageReplacementSetting().catch(() => null)
  if (!setting?.enabled) {
    clearPaidImageWaitTimer(job.job_id)
    return false
  }
  clearPaidImageWaitTimer(job.job_id)
  if (pendingContains(authoritative.type, authoritative.job_id)) return true
  const next = structuredClone(authoritative)
  next.status = 'queued'
  next.finished_at = null
  next.error = null
  try {
    await paidImageWaitRuntime.persistWait(next)
  } catch {
    return false
  }
  Object.assign(job, next)
  jobs.set(next.job_id, job)
  queues[next.type].pending.push(job)
  paidImageWaitRuntime.emitWait(job)
  if (IMAGE_EPISODE_TYPES.has(next.type)) pumpImageEpisodeGroup(imageEpisodeConcurrency)
  else pump(next.type)
  return true
}

async function schedulePaidImageWait(job: Job): Promise<boolean> {
  return withPaidImageWaitSettingGate(async () => {
    const setting = await getPaidImageReplacementSetting().catch(() => null)
    const valid = getValidPaidImageWait(job)
    if (!setting?.enabled || !valid || !hasPaidImageWaitRuntimePermission(job) || !await hasBoundPaidImageWaitManifest(job, valid.attempt)) {
      clearPaidImageWaitTimer(job.job_id)
      return false
    }
    if (paidImageWaitRuntime.nowMs() >= valid.dueAtMs) return withPaidImageWaitJobMutex(job.job_id, () => requeuePaidImageWaitIfDueNow(job))
    clearPaidImageWaitTimer(job.job_id)
    const timer = paidImageWaitRuntime.setTimer(() => {
      paidImageWaitTimers.delete(job.job_id)
      const current = jobs.get(job.job_id)
      if (current) void requeuePaidImageWaitIfDue(current)
    }, valid.dueAtMs - paidImageWaitRuntime.nowMs())
    paidImageWaitTimers.set(job.job_id, timer)
    return true
  })
}

async function failPaidImageWaitResult(job: Job): Promise<void> {
  if (!jobs.has(job.job_id)) return
  clearPaidImageWaitTimer(job.job_id)
  job.status = 'error'
  job.finished_at = new Date().toISOString()
  job.local_execution_complete = false
  job.error = 'Paid image replacement wait was revoked or could not be durably scheduled. No automatic retry was attempted.'
  job.output_lines.push(job.error)
  try { await paidImageWaitRuntime.persistWait(job) } catch { /* the in-memory terminal state still blocks retry */ }
  try { paidImageWaitRuntime.emitWait(job) } catch { /* a subscriber cannot re-enter retry */ }
}

async function repairAndRequeuePaidImageCommit(job: Job): Promise<boolean> {
  const attempts = job.paid_image_replacement_attempts || []
  const attempt = attempts.find(candidate => candidate.state === 'committed' || candidate.state === 'submitted')
  if (!attempt || job.status !== 'running' || !PAID_IMAGE_WAIT_TYPES.has(job.type) || !queues[job.type]?.executor
    || job.pause_requested === true || pauseRequested.has(job.job_id) || cancelled.has(job.job_id)
    || hasCancellationContext(job) || Boolean(job.force_abandoned)
    || attempts.filter(candidate => candidate.asset_key === attempt.asset_key).length !== 1
    || !isNonEmptyString(attempt.manifest_dir) || !isNonEmptyString(attempt.manifest_key)
    || !isNonEmptyString(attempt.output_path) || !isNonEmptyString(attempt.replacement_scope)
    || !isNonEmptyString(attempt.original_task_id) || !isNonEmptyString(attempt.original_idempotency_key)
    || !isSha256(attempt.input_hash) || !isSha256(attempt.reference_identity_hash)
    || typeof attempt.quoted_credits !== 'number' || !Number.isFinite(attempt.quoted_credits) || attempt.quoted_credits < 0
    || !isNonEmptyString(attempt.price_version) || !isNonEmptyString(attempt.replacement_committed_at)
    || !Number.isFinite(Date.parse(attempt.replacement_committed_at))
    || (attempt.state === 'submitted' && !isNonEmptyString(attempt.replacement_task_id))
  ) return false
  if (attempt.state === 'submitted') {
    const replacementEvidence = (job.genstudio_jobs || []).filter(candidate => (
      candidate.operation === 'image.generation' && candidate.id !== attempt.original_task_id
    ))
    if (replacementEvidence.length && !replacementEvidence.some(candidate => candidate.id === attempt.replacement_task_id)) return false
  }
  const expectedRoot = await resolvePaidImageRepairRoot(job).catch(() => null)
  if (!expectedRoot) return false
  const expectedOutput = path.resolve(expectedRoot, attempt.manifest_key)
  if (
    path.basename(attempt.manifest_key) !== attempt.manifest_key
    || path.resolve(attempt.manifest_dir) !== path.dirname(expectedOutput)
    || path.resolve(attempt.output_path) !== expectedOutput
  ) return false
  try {
    const entry = (await readManifest(attempt.manifest_dir)).tasks[attempt.manifest_key]
    if (!entry || entry.task_id !== attempt.original_task_id || entry.idempotency_key !== attempt.original_idempotency_key
      || entry.operation !== 'image'
      || entry.input_hash !== attempt.input_hash || entry.original_output_path !== attempt.output_path
      || !sameJson(entry.original_output_selector, attempt.output_selector)
      || !sameJson(entry.original_reference_inputs, attempt.reference_inputs)
      || entry.original_reference_identity_hash !== attempt.reference_identity_hash) return false
    const expected = {
      replacement_of_task_id: attempt.original_task_id,
      replacement_scope: attempt.replacement_scope,
      replacement_quoted_credits: attempt.quoted_credits,
      replacement_price_version: attempt.price_version,
      replacement_committed_at: attempt.replacement_committed_at,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (value !== undefined && (entry as any)[key] !== undefined && (entry as any)[key] !== value) return false
    }
    if (Object.entries(expected).some(([key, value]) => value !== undefined && (entry as any)[key] === undefined)) {
      await recordPaidImageReplacementStrict(attempt.manifest_dir, attempt.manifest_key, { ...entry, ...expected })
    }
    const reread = (await readManifest(attempt.manifest_dir)).tasks[attempt.manifest_key]
    if (!reread || !Object.entries(expected).every(([key, value]) => value === undefined || (reread as any)[key] === value)) return false
  } catch {
    return false
  }
  const next = structuredClone(job)
  next.status = 'queued'
  next.finished_at = null
  next.error = null
  try { await paidImageWaitRuntime.persistWait(next) } catch { return false }
  Object.assign(job, next)
  jobs.set(job.job_id, job)
  if (!pendingContains(job.type, job.job_id)) queues[job.type].pending.push(job)
  return true
}

async function failInvalidPaidImageCommitRecovery(job: Job): Promise<void> {
  job.status = 'error'
  job.error = 'Paid image replacement recovery evidence was invalid after restart; no automatic retry was attempted.'
  job.finished_at = new Date().toISOString()
  job.local_execution_complete = false
  job.output_lines = Array.isArray(job.output_lines) ? job.output_lines : []
  job.output_lines.push(job.error)
  jobs.set(job.job_id, job)
  try { await paidImageWaitRuntime.persistWait(job) } catch {}
}

/** Resume only commitments explicitly held by an Off restart scan, in scan order. */
async function reconcilePaidImageReplacementSetting(): Promise<void> {
  await withPaidImageWaitSettingGate(async () => {
    const setting = await getPaidImageReplacementSetting().catch(() => null)
    if (!setting?.enabled) {
      clearAllPaidImageWaitTimers()
      return
    }
    const resumedTypes = new Set<JobType>()
    for (const jobId of [...paidImageCommitHolds]) {
      const job = jobs.get(jobId)
      if (!job || !hasPaidImageCommitAttempt(job) || job.status !== 'running') {
        paidImageCommitHolds.delete(jobId)
        continue
      }
      if (await repairAndRequeuePaidImageCommit(job)) {
        paidImageCommitHolds.delete(jobId)
        resumedTypes.add(job.type)
        continue
      }
      paidImageCommitHolds.delete(jobId)
      await failInvalidPaidImageCommitRecovery(job)
    }
    if ([...resumedTypes].some(type => IMAGE_EPISODE_TYPES.has(type))) {
      pumpImageEpisodeGroup(imageEpisodeConcurrency)
    }
    for (const type of resumedTypes) {
      if (!IMAGE_EPISODE_TYPES.has(type)) pump(type)
    }
  })
}

/** Resolve the canonical existing surface; arbitrary persisted sidecar paths
 * never authorize repair. This is deliberately recovery-only and performs no
 * provider or generator work. */
async function resolvePaidImageRepairRoot(job: Job): Promise<string | null> {
  if (job.type === 'image_pool_generate') {
    const poolId = typeof job.params?.pool_id === 'string' ? job.params.pool_id : ''
    if (!poolId) return null
    const pools = await import('./broll-pool-manager.js')
    const pool = await pools.getPool(poolId)
    return pool && pools.poolMedia(pool) === 'image' && typeof pool.folder_path === 'string'
      ? path.resolve(pool.folder_path) : null
  }
  const { resolveEpisodePathsByCode } = await import('./utils.js')
  const episode = String(job.params?.episode_id || job.episode_id || '').trim()
  if (!episode) return null
  const paths = await resolveEpisodePathsByCode(job.project_slug, episode)
  if (job.type === 'thumb_images') return path.resolve(paths.thumb_dir)
  if (job.type !== 'continuity_render') return null
  const { resolveContinuityRenderOutputDir } = await import('../generators/continuity-render.js')
  const canonical = path.resolve(await resolveContinuityRenderOutputDir(job.project_slug, episode, paths.episode_dir))
  if (typeof job.output_dir === 'string' && path.resolve(job.output_dir) !== canonical) return null
  return canonical
}

function hasPaidImageCommitAttempt(job: Job): boolean {
  return (job.paid_image_replacement_attempts || []).some(attempt => (
    attempt.state === 'committed' || attempt.state === 'submitted'
  ))
}

function hasUnsubmittedPaidImageCommitAttempt(job: Job): boolean {
  return (job.paid_image_replacement_attempts || []).some(attempt => attempt.state === 'committed')
}

async function hasManifestOnlyPaidImageCommitment(attempt: PaidImageReplacementAttempt): Promise<boolean> {
  try {
    const entry = (await readManifest(attempt.manifest_dir)).tasks[attempt.manifest_key]
    return Boolean(entry && [
      entry.replacement_of_task_id,
      entry.replacement_scope,
      entry.replacement_quoted_credits,
      entry.replacement_price_version,
      entry.replacement_committed_at,
    ].some(value => value !== undefined))
  } catch {
    return false
  }
}

// ── Lazy load persisted jobs on first access ────────────────────────────────

async function readPersistedJobs(projectSlug: string): Promise<void> {
  const p = jobsPath(projectSlug)
  const resumedTypes = new Set<JobType>()
  const lineupWaitJobs: Job[] = []
  const reconciliationJobs: string[] = []
  // v1.2.6 — finished rows whose stored evidence is still non-terminal. They
  // never entered cancellation reconciliation (that path only accepts running
  // or paused jobs), which is precisely why their evidence went stale.
  const historyRefreshJobs: string[] = []
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
            if (hasUnsettledProviderEvidence(j)) {
              j.status = 'running'
              j.local_execution_complete = true
              j.started_at ||= new Date().toISOString()
              j.finished_at = null
              j.output_lines = Array.isArray(j.output_lines) ? j.output_lines : []
              j.output_lines.push('↻ Story Studio restarted — durable provider evidence is still settling; this job will not submit a replacement request.')
              if (requiresCancellationReconciliation(j)) reconciliationJobs.push(j.job_id)
              mutated = true
            } else {
              const queuedRetryAt = typeof j.params?.llm_lineup_retry_at === 'string'
                ? j.params.llm_lineup_retry_at
                : null
              const queuedRetryAtMs = validRetryAtMs(queuedRetryAt)
              if (queuedRetryAt && queuedRetryAtMs !== null && queuedRetryAtMs > Date.now()) {
                j.finished_at = null
                lineupWaitJobs.push(j)
              } else {
                // A stale wait is ready immediately after boot. Its durable
                // policy checkpoint stays intact and will make the executor
                // retry the same logical request rather than minting a new one.
                if (queuedRetryAt) delete j.params.llm_lineup_retry_at
                const queue = queues[j.type as JobType]
                if (queue?.executor) {
                  // An image job with a prior admission timestamp is recovery
                  // work. Preserve that class across every boot; ordinary lanes
                  // retain their historical reset behavior.
                  if (!IMAGE_EPISODE_TYPES.has(j.type as JobType)) j.started_at = null
                  j.finished_at = null
                  queue.pending.push(j)
                  resumedTypes.add(j.type as JobType)
                } else {
                  j.status = 'error'
                  j.error = 'Interrupted by app restart'
                  j.finished_at = j.finished_at || new Date().toISOString()
                }
                mutated = true
              }
            }
          } else if (j.status === 'running') {
            observePersistedRunningJobLoadStage(j, 'pause-requested')
            if (j.pause_requested === true) {
              j.status = 'paused'
              j.pause_requested = false
              j.local_execution_complete = true
              j.finished_at = null
              j.output_lines = Array.isArray(j.output_lines) ? j.output_lines : []
              j.output_lines.push('↻ Story Studio restarted — the requested submission pause remains in effect while accepted work is reconciled. Resume is still explicit.')
              if (requiresCancellationReconciliation(j)) reconciliationJobs.push(j.job_id)
              jobs.set(j.job_id, j)
              try { await persistJob(j) } catch {}
              continue
            }
            // A paid wait is deliberately a running job with a terminally
            // failed checkpoint. It must be classified before the ordinary
            // image recovery branch below, which otherwise consumes that
            // checkpoint and before the generic restart terminalization.
            observePersistedRunningJobLoadStage(j, 'paid-image-wait')
            const paidWait = getValidPaidImageWait(j)
            if (paidWait && await hasBoundPaidImageWaitManifest(j, paidWait.attempt)) {
              jobs.set(j.job_id, j)
              const handled = await schedulePaidImageWait(j)
              if (handled) {
                if (j.status === 'queued') resumedTypes.add(j.type as JobType)
                continue
              }
            }
            // jobs.json is authoritative for a committed paid replacement.
            // Repair only an absent manifest mirror, never the reverse.
            if (hasUnsubmittedPaidImageCommitAttempt(j)) {
              const setting = await getPaidImageReplacementSetting().catch(() => null)
              if (!setting?.enabled) {
                jobs.set(j.job_id, j)
                paidImageCommitHolds.add(j.job_id)
                continue
              }
            }
            if (await repairAndRequeuePaidImageCommit(j)) {
              resumedTypes.add(j.type as JobType)
              continue
            }
            if (hasPaidImageCommitAttempt(j)
              || (paidWait && await hasManifestOnlyPaidImageCommitment(paidWait.attempt))) {
              await failInvalidPaidImageCommitRecovery(j)
              continue
            }
            observePersistedRunningJobLoadStage(j, 'ordinary-recovery')
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
            // v1.4.81 — image-episode work resumes for the same reason audio
            // does, and the machinery is already built and proven; this type
            // was simply never added to it.
            //
            // Before this, a scene render caught by a restart stayed `running`
            // forever on the reconcile-only path below: never re-executed,
            // never failed, holding no lane — so the scheduler saw free lanes
            // and started NEW episodes while the interrupted ones sat there.
            // The owner watched three become six. Reclaiming the images he had
            // already paid for then depended on him noticing and clicking Retry.
            //
            // Requeueing cannot spend more than the status quo: Retry runs this
            // same executor with the same disk-based skip and the same manifest
            // reclaim. It only does it automatically, and sooner — which matters,
            // because a provider artifact that expires is money that cannot be
            // collected at all. Note this branch also restores the owner's
            // stated order for free: these jobs are pushed into `pending` here,
            // during load, ahead of the boot `pump()` below, so plain FIFO gives
            // them their lanes back before any never-started job is admitted.
            const recoverableImageEpisode = IMAGE_EPISODE_TYPES.has(j.type as JobType)
              && !!queues[j.type as JobType]?.executor
              && hasStableImageOutputIdentity(j)
              && hasReclaimableImageEvidence(j)
            const recoverableVideoAssembly = j.type === 'video_assembly'
              && !!queues.video_assembly.executor
              && !!(await getValidVideoAssemblyCheckpoint(j, ['running']))
            if ((recoverableGenStudio || recoverableImageEpisode || recoverableVideoAssembly) && !hasCancellationContext(j)) {
              j.status = 'queued'
              // Keep the original admission timestamp so the fair image pump
              // recognises this as recovery work ahead of fresh FIFO.
              if (recoverableVideoAssembly) j.started_at = null
              j.finished_at = null
              j.error = null
              j.output_lines = Array.isArray(j.output_lines) ? j.output_lines : []
              j.output_lines.push(recoverableVideoAssembly
                ? '↻ Story Studio restarted — resuming local Video Assembly from its validated scene-clip checkpoint. Missing or invalid clips and every later stage will be rebuilt.'
                : recoverableImageEpisode
                  ? '↻ Story Studio restarted — resuming this render. Every image GenStudio already finished will be reclaimed from its saved task id at no extra credits, and only genuinely missing scenes will be submitted.'
                  : '↻ Story Studio restarted — resuming the checkpointed GenStudio asset job automatically; the saved request identity will be reused and no direct fallback will run.')
              queues[j.type as JobType].pending.push(j)
              resumedTypes.add(j.type as JobType)
            } else {
              observePersistedRunningJobLoadStage(j, 'cancellation-reconciliation')
              if (requiresCancellationReconciliation(j)) {
                // The provider request already has a durable identity. Never convert it to an
                // interrupted error or requeue it into a generation lane.
                j.local_execution_complete = true
                j.finished_at = null
                j.output_lines = Array.isArray(j.output_lines) ? j.output_lines : []
                j.output_lines.push('↻ Story Studio restarted — reconciling the existing GenStudio request before allowing any retry.')
                reconciliationJobs.push(j.job_id)
              } else {
                observePersistedRunningJobLoadStage(j, 'interrupted-terminalization')
                j.status = 'error'
                j.error = 'Interrupted by app restart'
                j.finished_at = j.finished_at || new Date().toISOString()
              }
            }
            mutated = true
          } else if (j.status === 'paused') {
            // Queue-origin holds are classified only after the durable global
            // setting is initialized. If it is false, the project-batched
            // transition below owns the one persistence write; if true, the
            // durable owner hold is preserved byte-for-byte.
            if (j.pause_origin !== 'queue') {
              if (hasUnsettledProviderEvidence(j)) {
                // A stall hold may only auto-rejoin when the executor itself
                // persisted its cooperative boundary. Provider evidence
                // settling proves nothing about where local execution stopped.
                if (j.pause_origin !== 'stall') j.local_execution_complete = true
                j.finished_at = null
                j.output_lines = Array.isArray(j.output_lines) ? j.output_lines : []
                j.output_lines.push('↻ Story Studio restarted — this batch remains paused while already accepted provider work settles. Resume is still explicit.')
                if (requiresCancellationReconciliation(j)) reconciliationJobs.push(j.job_id)
              }
              j.pause_requested = false
              mutated = true
            }
          }
          jobs.set(j.job_id, j)
          if (needsHistoryEvidenceRefresh(j)) historyRefreshJobs.push(j.job_id)
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
    if ([...resumedTypes].some(type => IMAGE_EPISODE_TYPES.has(type))) {
      pumpImageEpisodeGroup(imageEpisodeConcurrency)
    }
    for (const type of resumedTypes) {
      if (!IMAGE_EPISODE_TYPES.has(type)) pump(type)
    }
    for (const jobId of reconciliationJobs) scheduleCancellationReconciliation(jobId)
    for (const jobId of historyRefreshJobs) scheduleHistoryEvidenceRefresh(jobId)
    for (const job of lineupWaitJobs) scheduleLlmLineupWait(job)
  } catch { /* ignore corrupt file */ }
}

async function loadPersistedJobs(projectSlug: string): Promise<void> {
  if (loadedProjects.has(projectSlug)) return
  const existing = loadingProjects.get(projectSlug)
  if (existing) return existing

  const loading = (async () => {
    await initializeQueuePauseState()
    await readPersistedJobs(projectSlug)
    const released = await transitionPausedJobsToQueuedByProject(
      [...jobs.values()].filter(job => (
        job.project_slug === projectSlug
        && job.status === 'paused'
        && job.pause_origin === 'queue'
      )),
    )
    const stallLanes = await recoverSafelySettledStallJobs(
      [...jobs.values()].filter(job => (
        job.project_slug === projectSlug && job.status === 'paused' && job.pause_origin === 'stall'
      )),
      undefined,
      false,
    )
    for (const type of stallLanes) released.lanes.add(type)
    for (const job of jobs.values()) {
      if (job.project_slug === projectSlug) lastPublicJobStatuses.set(job.job_id, job.status)
    }
    for (const type of released.lanes) pump(type)
  })()
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
  imageEpisodeBootAdmissionHolds++
  try {
    const { listProjects } = await import('./project-manager.js')
    const projects = await listProjects()
    for (const project of projects as Array<{ slug?: string }>) {
      if (typeof project?.slug === 'string' && project.slug) await loadPersistedJobs(project.slug)
    }
  } finally {
    imageEpisodeBootAdmissionHolds = Math.max(0, imageEpisodeBootAdmissionHolds - 1)
    if (imageEpisodeBootAdmissionHolds === 0) pumpImageEpisodeGroup(imageEpisodeConcurrency)
  }
}

// ── Queue processing ────────────────────────────────────────────────────────

/**
 * Launch as many pending jobs of `type` as its concurrency group allows.
 * Non-LLM types keep a single slot (`q.running`, unchanged); LLM types share
 * the `llmConcurrency` budget across the whole group. Synchronous: the whole
 * budget is consumed before any launched job yields, so no double-launch race.
 */
const IMAGE_GROUP_TYPES: readonly JobType[] = ['continuity_render', 'image_pool_generate']

/** Select the next queued image job for one type, keeping recovery FIFO ahead
 * of the fresh FIFO without changing the order within either class. */
function nextImageGroupJob(type: JobType): Job | null {
  const pending = queues[type].pending
  const recoveryIndex = pending.findIndex(job => Boolean(job.started_at))
  const index = recoveryIndex >= 0
    ? recoveryIndex
    : pending.findIndex(job => !job.started_at)
  return index >= 0 ? pending.splice(index, 1)[0] : null
}

/** Admit image jobs from one shared round-robin pump. Capacity is consumed
 * synchronously before any executor can yield, preventing double admission. */
function pumpImageEpisodeGroup(limit: number): void {
  if (queuePaused || imageEpisodeBootAdmissionHolds > 0) return
  let emptyPass = 0
  while ((groupActive[IMAGE_EPISODE_GROUP] || 0) < limit) {
    const type = IMAGE_GROUP_TYPES[(imageEpisodeCursor + emptyPass) % IMAGE_GROUP_TYPES.length]
    const job = nextImageGroupJob(type)
    if (!job) {
      emptyPass++
      if (emptyPass >= IMAGE_GROUP_TYPES.length) return
      continue
    }
    emptyPass = 0
    imageEpisodeCursor = (IMAGE_GROUP_TYPES.indexOf(type) + 1) % IMAGE_GROUP_TYPES.length
    groupActive[IMAGE_EPISODE_GROUP] = (groupActive[IMAGE_EPISODE_GROUP] || 0) + 1
    activeImageEpisodeJobIds.add(job.job_id)
    runJob(type, job).catch(e => console.error(`[job-queue] Error processing ${type}:`, e))
  }
}

function pump(type: JobType): void {
  queuePumpObserverForTesting?.(type)
  if (queuePaused) return  // network is down; jobs wait
  const q = queues[type]
  const next = q.pending[0]
  const group = groupOf(type, next)
  if (group === IMAGE_EPISODE_GROUP) {
    pumpImageEpisodeGroup(groupLimit(group))
  } else if (group === LLM_GROUP || group === LOCAL_LLM_GROUP || group === SUBTITLE_TRANSCRIBE_GROUP || FLEET_EPISODE_GROUPS.has(group)) {
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
  // A freed image slot can be taken by either image type through one fair pump.
  else if (group === IMAGE_EPISODE_GROUP) pumpImageEpisodeGroup(groupLimit(group))
  else if (FLEET_EPISODE_GROUPS.has(group)) for (const t of fleetEpisodeTypesFor(group)) pump(t)
}

/** Release the slot a finished job held, then pull in the next work. */
function releaseSlot(type: JobType, job: Job): void {
  const group = groupOf(type, job)
  if (group === LLM_GROUP || group === LOCAL_LLM_GROUP || group === SUBTITLE_TRANSCRIBE_GROUP || FLEET_EPISODE_GROUPS.has(group)) {
    if (group === IMAGE_EPISODE_GROUP) activeImageEpisodeJobIds.delete(job.job_id)
    groupActive[group] = Math.max(0, (groupActive[group] || 0) - 1)
    queuePumpObserverForTesting?.(type, job.job_id)
    pumpGroup(group)
    if (group === IMAGE_EPISODE_GROUP) noteAdaptiveImageTailEvent()
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
export function subtitleFinalizerJobId(source: string | Pick<Job, 'job_id' | 'params'>): string {
  if (typeof source === 'string') return `subtitle-finalizer-${source}`
  const saved = source.params?.subtitle_finalizer_job_id
  if (saved === undefined) return `subtitle-finalizer-${source.job_id}`
  if (typeof saved !== 'string' || !saved.startsWith('subtitle-finalizer-') || saved.length <= 'subtitle-finalizer-'.length) {
    throw new Error('Invalid saved subtitle finalizer handoff identity.')
  }
  return saved
}

async function continueFinalizerAfterSubtitleFailure(job: Job): Promise<void> {
  if (job.type !== 'subtitles_transcribe') return
  const chain = job.params?.pipeline_chain
  if (!Array.isArray(chain) || chain.length === 0) return
  const [nextStep, ...rest] = chain
  if (nextStep?.type !== 'metadata') return

  try {
    const handoffId = subtitleFinalizerJobId(job)
    job.params.subtitle_finalizer_job_id = handoffId
    if (job.params.subtitle_finalizer_dispatched === true) return
    await persistJob(job) // Derived jobs inherit the owner before any handoff side effect.
    const batchId = job.params?.pipeline_batch_id
    const nextParams = await snapshotLlmLineupParams(job.project_slug, 'metadata', job.episode_id, {
      ...(nextStep.params || {}),
      episode_id: job.episode_id,
      pipeline_chain: rest,
      ...(batchId ? { pipeline_batch_id: batchId } : {}),
      subtitle_verification_warning: job.error || 'Subtitle generation did not complete.',
    })
    await enqueueEpisodeRecoveryOnce(handoffId, {
      project_slug: job.project_slug,
      type: 'metadata',
      episode_id: job.episode_id,
      title: nextStep.title || `[batch] metadata — ${job.episode_id}`,
      params: nextParams,
    })
    job.params.subtitle_finalizer_dispatched = true
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
 * Group 1.1a. `assertJobDidNotDeclareIncomplete` fires only when the executor
 * itself set `result.complete === false`, so an executor that audits nothing
 * passed untouched and a job could report `done` over missing output.
 *
 * For job types that already have a per-type auditor, re-read the artifacts and
 * fail the job when the auditor says `repair-required`.
 *
 * THREE DELIBERATE LIMITS:
 *
 *  1. Skipped when `result.output_audited` is set. The PROVIDER-SETTLEMENT path
 *     audits (`:955`) and then calls this same shared function, so without the
 *     marker every settled job would be audited twice — which is exactly what
 *     the first attempt did, and `simultaneous final provider updates run the
 *     auditor and terminal transition once` caught it.
 *  2. Skipped when the executor declared a verdict (`result.complete` is not
 *     undefined). A declared `true` means it audited its own output; a declared
 *     `false` already threw above.
 *  3. Applies ONLY to types with a registered auditor. The 13 artifact-producing
 *     types that still have none keep today's behaviour — authoring those
 *     auditors is group 1.1b in docs/audit/FIX-PLAN.md.
 *
 * An auditor FAULT is fail-closed, because `registerJobCancellationAuditor`
 * wraps every auditor with `catch { return 'repair-required' }` ("provider
 * success does not make malformed or unreadable local output complete"). The
 * message therefore says "missing or could not verify" rather than claiming the
 * output is missing.
 */
export async function assertAuditedCompletionOnSuccess(job: Job): Promise<void> {
  // A job with recorded provider work is OWNED by the provider-settlement path,
  // which audits once the executor has checkpointed (:955). The executor returns
  // BEFORE that — `provider success during a live executor waits for local
  // output before auditing` pins exactly that ordering — so without this the
  // local pass would audit first and settlement would audit again: two audits,
  // which is what the gate caught.
  //
  // This is a fact about the job (does it have provider work recorded?), not an
  // inference about which code path ran — the distinction that matters, because
  // two earlier attempts failed on inferred predicates.
  if ((job.genstudio_jobs || []).length > 0) return
  if (job.result?.output_audited) return
  if (job.result?.complete !== undefined) return
  const auditor = getJobCancellationAuditor(job.type)
  if (!auditor) return
  const verdict = await auditor(job)
  if (verdict === 'complete') return
  throw new Error(
    `${job.type} reported success, but re-reading its output found required items missing or could not verify it. ` +
    `Nothing already produced was discarded — Retry repairs only the gaps.`,
  )
}

/** One success path for ordinary completions and reconciled provider outputs. */
async function completeSuccessfulJob(job: Job): Promise<void> {
  if (job.status !== 'running') return
  const typeMap: Record<string, 'script' | 'image' | 'audio'> = { 'script-only': 'script', 'introduction-only': 'script', 'chapter-only': 'script', images: 'image', scene_images: 'image', thumb_images: 'image', audio: 'audio', audio_merge: 'audio', video: 'image' }
  const trackType = typeMap[job.type]
  if (trackType) trackGeneration(job.project_slug, trackType).catch(() => {})

  const chain = job.params?.episode_recovery_id ? undefined : job.params?.pipeline_chain
  if (!Array.isArray(chain) || chain.length === 0) {
    job.status = 'done'
    return
  }
  const [nextStep, ...rest] = chain
  if (!nextStep || typeof nextStep.type !== 'string') {
    job.status = 'done'
    return
  }
  try {
    const batchId = job.params.pipeline_batch_id
    const nextParams = await snapshotLlmLineupParams(job.project_slug, nextStep.type, job.episode_id, {
      ...(nextStep.params || {}),
      episode_id: job.episode_id,
      pipeline_chain: rest,
      ...(batchId ? { pipeline_batch_id: batchId } : {}),
    })
    const joined = nextStep.type === 'continuity_render' && !nextParams.single_scene_id
      ? await joinActiveBulkSceneRender({
        project_slug: job.project_slug,
        episode_id: job.episode_id,
        pipeline_chain: Array.isArray(nextParams.pipeline_chain) ? nextParams.pipeline_chain : rest,
        pipeline_batch_id: batchId,
      })
      : null
    if (joined?.conflict) throw new Error(`An existing scene render already owns a different Pipeline continuation for ${job.episode_id}`)
    if (joined) job.output_lines.push(`→ Joined existing scene render ${joined.job.job_id}; duplicate Hub work was not queued.`)
    else {
      const options = { project_slug: job.project_slug, type: nextStep.type as JobType, episode_id: job.episode_id, title: nextStep.title || `[batch] ${nextStep.type} — ${job.episode_id}`, params: nextParams }
      if (job.type === 'subtitles_transcribe' && nextStep.type === 'metadata') {
        const handoffId = subtitleFinalizerJobId(job)
        job.params.subtitle_finalizer_job_id = handoffId
        if (job.params.subtitle_finalizer_dispatched !== true) {
          await persistJob(job)
          await enqueueEpisodeRecoveryOnce(handoffId, options)
          job.params.subtitle_finalizer_dispatched = true
        }
      }
      else await enqueue(options)
      job.output_lines.push(`→ Chained next step: ${nextStep.type}`)
    }
  } catch (error) {
    const failed = await recordChainHandoffFailure(job, nextStep, rest, error)
    job.output_lines.push(`Chain-next failed: ${error instanceof Error ? error.message : String(error)} (recorded as failed job ${failed.job_id})`)
  }
  // enqueue() now verifies exact Content Pack pins asynchronously. Do not
  // expose the parent as Done until its continuation or failure record is
  // durably present; the previous synchronous insertion made this atomic.
  job.status = 'done'
}

/**
 * Full lifecycle for one job: mark running → run executor → persist final
 * status → chain the next pipeline step → release the slot. Fire-and-forget
 * from pump(); the `finally` guarantees the slot is released even on error so
 * the queue never deadlocks.
 */
async function runJob(type: JobType, job: Job): Promise<void> {
  const q = queues[type]
  activeRunJobIds.add(job.job_id)
  try {
    if (cancelled.has(job.job_id)) {
      job.status = 'cancelled'
      job.finished_at = new Date().toISOString()
      jobs.set(job.job_id, job)
      await persistJob(job)
      if (!jobs.has(job.job_id)) return
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
    job.local_execution_complete = false
    job.pause_requested = false
    job.started_at ||= new Date().toISOString()
    jobs.set(job.job_id, job)
    await persistJob(job)
    if (!jobs.has(job.job_id)) return
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
          // Video Assembly's validated checkpoint is the index for those files,
          // so keep only that entry through the existing free local retry.
          const videoAssemblyCheckpoint = job.type === 'video_assembly'
            ? job.result?.video_assembly_checkpoint
            : undefined
          job.result = videoAssemblyCheckpoint
            ? { video_assembly_checkpoint: videoAssemblyCheckpoint }
            : undefined
          job.progress = 0
          job.output_lines.push(`↻ Local auto-retry attempt ${attempt}/${retryPolicy.max_attempts} — checking disk and repairing only missing work.`)
          await persistJob(job)
          emitUpdate(job)
        }

        try {
          if (cancelled.has(job.job_id)) throw new Error('Cancelled by user')
          throwIfPauseRequested(job.job_id)
          await assertQueuedVisualSource(job)
          // Run the executor inside a per-job AsyncLocalStorage context so any
          // child processes spawned deep in the call tree register against this
          // job id via `trackChild(proc)`. Without this, a cancelled FFmpeg
          // assembly would keep running until it finished or hit an error.
          const executorResult = await jobContext.run({ jobId: job.job_id }, () => (
            runWithJobContentPackProvenance(job.content_pack_provenance, () => q.executor!(job))
          ))
          if (!jobs.has(job.job_id)) return
          if (executorResult?.kind === 'paid-image-wait') {
            job.status = 'running'
            job.finished_at = null
            job.local_execution_complete = false
            jobs.set(job.job_id, job)
            // A malformed/revoked wait is fail-closed but is not an executor
            // failure: never enter local retry, completion, or chaining after
            // a generator has declared the durable paid-wait boundary.
            try {
              await paidImageWaitRuntime.persistWait(job)
              if (!jobs.has(job.job_id)) return
              paidImageWaitRuntime.emitWait(job)
              if (!await schedulePaidImageWait(job)) await failPaidImageWaitResult(job)
            } catch {
              await failPaidImageWaitResult(job)
            }
            return
          }
          job.local_execution_complete = true
          assertJobDidNotDeclareIncomplete(job)
          await assertAuditedCompletionOnSuccess(job)
          const completedBeforeAutomaticHold = job.type === 'continuity_render'
            && job.pause_origin === 'stall'
            && pauseRequested.has(job.job_id)
            && hasAuthoritativeCompletionDeclaration(job)
            && !hasUnsettledProviderWork(job)
            && !hasCancellationContext(job)
            && !cancelled.has(job.job_id)
          if (completedBeforeAutomaticHold) {
            pauseRequested.delete(job.job_id)
            job.pause_requested = false
            job.pause_origin = undefined
            job.output_lines.push('Automatic submission hold arrived after all outputs were already verified; completing this job without another run.')
          } else {
            throwIfPauseRequested(job.job_id)
          }
          completed = true
          break
        } catch (error) {
          if (!jobs.has(job.job_id)) return
          finalError = error
          if (cancelled.has(job.job_id)) throw error
          if (error instanceof JobPausedError || pauseRequested.has(job.job_id)) throw new JobPausedError()
          // The policy executor has already proved every selected candidate
          // unaccepted and written its waiting checkpoint. Do not consume a
          // worker slot on local retry backoff; the outer lifecycle parks it.
          if (lineupWaitRetryAt(job, error)) throw error
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
        await completeSuccessfulJob(job)
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
      } else if (lineupWaitRetryAt(job, e)) {
        // Do this before ordinary errors. The executor's checkpoint names a
        // no-submit availability wait; partial files and provider identities
        // stay exactly as the generator recorded them.
        parkForLlmLineupAvailability(job, lineupWaitRetryAt(job, e)!)
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

    // A cancellation/abandonment may retire history during an awaited audit.
    if (!jobs.has(job.job_id)) return
    job.finished_at = isQueuedLlmLineupWait(job) || job.status === 'paused' || hasUnsettledProviderWork(job)
      || (job.status === 'running' && hasCancellationContext(job))
      ? null
      : new Date().toISOString()
    jobs.set(job.job_id, job)
    await persistJob(job)
    if (!jobs.has(job.job_id)) return
    emitUpdate(job)
    // Resume may have been accepted while this worker was already crossing a
    // queue-origin safe point.  The global release scan cannot see a paused
    // row until this final checkpoint is durable, so release it here rather
    // than leaving a globally-resumed queue with one stranded paused job.
    if (
      job.status === 'paused'
      && job.pause_origin === 'queue'
      && queuePauseReleaseCheckpoints.has(job.job_id)
      && !queuePaused
      && !pauseRequested.has(job.job_id)
    ) {
      const transitioned = await transitionPausedJobsToQueuedByProject([job], {
        allowWhileQueuePaused: true,
        requireExecutor: true,
      })
      for (const lane of transitioned.lanes) pump(lane)
    }
    // A cooperative stall pause is safe to reconsider only after its final
    // checkpoint is durable. The same recovery runs on project load, but an
    // uninterrupted app used to leave this settled record paused forever.
    if (job.status === 'paused' && job.pause_origin === 'stall') {
      await recoverSafelySettledStallJobs([job])
    }
    if (isQueuedLlmLineupWait(job)) {
      scheduleLlmLineupWait(job)
    }
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      clearPaidImageWaitTimer(job.job_id)
      clearLlmLineupWaitTimer(job.job_id)
    }
    if (
      (job.status === 'running' && hasUnsettledProviderWork(job))
      || (job.status === 'paused' && job.pause_origin === 'stall' && requiresCancellationReconciliation(job))
    ) scheduleCancellationReconciliation(job.job_id)
    // v1.2.6 — a job can finish while one recorded provider task was still
    // mid-flight. Ask GenStudio now rather than freezing that snapshot into a
    // history row nobody can ever dismiss.
    else if (needsHistoryEvidenceRefresh(job)) scheduleHistoryEvidenceRefresh(job.job_id)
  } finally {
    activeRunJobIds.delete(job.job_id)
    if (!jobs.has(job.job_id)) {
      cancelled.delete(job.job_id)
      clearPaidImageWaitTimer(job.job_id)
      clearLlmLineupWaitTimer(job.job_id)
    }
    queuePauseReleaseCheckpoints.delete(job.job_id)
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

export function initializeQueuePauseState(): Promise<void> {
  if (queuePauseLoaded) return Promise.resolve()
  if (!queuePauseInitialization) {
    queuePauseInitialization = (async () => {
      queuePaused = (await getAppSetting(QUEUE_PAUSED_KEY).catch(() => false)) === true
      queuePauseLoaded = true
    })()
  }
  return queuePauseInitialization
}

export function setQueuePaused(paused: boolean): Promise<void> {
  // Pause and Resume each have a durable phase plus a cooperative worker
  // phase.  Serializing only app-settings writes lets an older Pause request
  // install a safe-point hold after a newer Resume has already scanned for
  // paused rows.  Keep the whole intent transition ordered instead.
  return withLock(QUEUE_PAUSE_TRANSITION_LOCK, () => setQueuePausedUnlocked(paused))
}

async function setQueuePausedUnlocked(paused: boolean): Promise<void> {
  await initializeQueuePauseState()
  if (paused) {
    queuePaused = true
    await setAppSetting(QUEUE_PAUSED_KEY, true)
    // The global hold prevents every queued item from being submitted. For
    // GenStudio-backed work already running, request a cooperative safe-point
    // pause: accepted items finish downloading, but workers claim no new item.
    const pausable = [...jobs.values()].filter(job => job.status === 'running' && classifyJobControls(job, {
      remoteCancellationAudited: hasJobCancellationAuditor(job.type),
    }).some(control => control.action === 'pause-submissions' && control.enabled))
    await Promise.all(pausable.map(job => pauseJob(job.job_id, 'queue')))
    return
  }

  // A queue-origin pause of an already-running job is cooperative. Keep its
  // durable and runtime pause request in place until the worker writes its
  // normal paused checkpoint. The marker makes that checkpoint requeue once
  // the global release is durable, without admitting work across a failed
  // settings write or overriding a later manual pause.
  const pendingQueuePauseCheckpoints = [...jobs.values()].filter(job => (
    job.status === 'running'
    && job.pause_requested === true
    && job.pause_origin === 'queue'
  ))
  await setAppSetting(QUEUE_PAUSED_KEY, false)
  for (const job of pendingQueuePauseCheckpoints) {
    if (
      job.status === 'running'
      && job.pause_requested === true
      && job.pause_origin === 'queue'
      && pauseRequested.has(job.job_id)
    ) queuePauseReleaseCheckpoints.add(job.job_id)
  }
  queuePaused = false
  await transitionPausedJobsToQueuedByProject([...jobs.values()].filter(job => (
    job.status === 'paused' && job.pause_origin === 'queue'
  )))
  // A model-availability timer may have become due while the global queue was
  // paused. Re-arm every durable hold here; due rows schedule a zero-delay
  // release, while future rows keep their original retry time.
  for (const job of jobs.values()) {
    if (job.status === 'queued' && typeof job.params?.llm_lineup_retry_at === 'string') {
      scheduleLlmLineupWait(job)
    }
  }
  // Kick every type so queued jobs that never started while held can run.
  for (const type of Object.keys(queues) as JobType[]) {
    pump(type)
  }
}

export function isQueuePaused(): boolean {
  return queuePaused
}

interface PausedJobTransitionSnapshot {
  job: Job
  pauseRequested: boolean
  pause_requested: Job['pause_requested']
  pause_origin: Job['pause_origin']
  status: Job['status']
  started_at: Job['started_at']
  finished_at: Job['finished_at']
  error: Job['error']
  output_lines: string[]
}

interface PausedJobTransitionResult {
  resumed: Job[]
  noExecutor: Job[]
  persistenceFailed: Job[]
  lanes: Set<JobType>
}

interface PausedJobTransitionOptions {
  allowWhileQueuePaused?: boolean
  requireExecutor?: boolean
}

export interface ResumePausedJobsScope {
  projectSlugs: readonly string[]
  type?: JobType
}

export interface ResumePausedJobsResult {
  requested: number
  resumed: number
  skipped: number
  skipped_reasons?: Array<{
    reason: 'no-executor' | 'persistence-failed'
    count: number
  }>
}

export interface ContinuityTailProof {
  job_id: string
  settling: number
  concurrency: number
  active_asset_keys: string[]
  provider_task_ids: string[]
}

function isNonNegativeWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isAcceptedProviderTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.startsWith('pending:')
}

interface ContinuityTailLocalState {
  output_dir: string
  progress: NonNullable<Job['item_progress']>
  checkpoint: any
  keys: string[]
}

function continuityTailLocalState(job: Job): ContinuityTailLocalState | null {
  if (job.type !== 'continuity_render' || job.status !== 'running' || typeof job.output_dir !== 'string') return null
  const progress = job.item_progress
  if (!progress || !isNonNegativeWhole(progress.total) || !isNonNegativeWhole(progress.completed)
    || !isNonNegativeWhole(progress.failed) || !isNonNegativeWhole(progress.settling)
    || !isNonNegativeWhole(progress.cancelled) || !isNonNegativeWhole(progress.not_submitted)
    || !Number.isSafeInteger(progress.concurrency) || progress.concurrency <= 0
    || !Array.isArray(progress.active)
  ) return null
  if (
    progress.active.length !== progress.settling
    || progress.total !== progress.completed + progress.failed + progress.settling + progress.cancelled + progress.not_submitted
    || progress.not_submitted !== 0
    || progress.settling <= 0
    || progress.settling >= progress.concurrency
  ) return null

  const keys = progress.active.map(item => item?.key)
  if (!keys.every(key => typeof key === 'string' && key.trim().length > 0 && path.basename(key) === key)
    || new Set(keys).size !== keys.length
    || progress.active.some(item => item?.state !== 'running')
  ) return null

  const checkpoint = job.params?.genstudio_recovery
  if (
    !checkpoint || checkpoint.version !== 1 || checkpoint.route !== 'genstudio'
    || !checkpoint.assets || typeof checkpoint.assets !== 'object'
  ) return null

  return { output_dir: job.output_dir, progress, checkpoint, keys: keys as string[] }
}

type ContinuityTailManifestReader = typeof readManifest
let continuityTailManifestReader: ContinuityTailManifestReader = readManifest

/**
 * Read-only, fail-closed evidence that a live Continuity render is in its
 * under-filled final provider wave. The progress key is deliberately the
 * direct manifest/checkpoint filename join; a scene number is display-only.
 */
export async function proveContinuitySettlingTail(job: Job): Promise<ContinuityTailProof | null> {
  const initial = continuityTailLocalState(job)
  if (!initial) return null
  const manifest = await continuityTailManifestReader(initial.output_dir)
  const current = continuityTailLocalState(job)
  if (!current || current.output_dir !== initial.output_dir) return null
  const { progress, checkpoint, keys, output_dir: outputDir } = current
  const providerTaskIds = new Set<string>()
  for (const key of keys) {
    const checkpointEntry = checkpoint.assets[key]
    const manifestEntry = manifest.tasks[key]
    if (
      checkpointEntry?.operation !== 'image'
      || manifestEntry?.operation !== 'image'
      || typeof checkpointEntry.output_path !== 'string'
      || path.resolve(checkpointEntry.output_path) !== path.resolve(outputDir, key)
      || typeof checkpointEntry.input_hash !== 'string'
      || !checkpointEntry.input_hash.trim()
      || typeof manifestEntry.input_hash !== 'string'
      || !manifestEntry.input_hash.trim()
      || checkpointEntry.input_hash !== manifestEntry.input_hash
    ) return null

    const checkpointId = checkpointEntry.job_id
    const manifestId = manifestEntry.task_id
    if (
      (checkpointId !== undefined && !isAcceptedProviderTaskId(checkpointId))
      || !isAcceptedProviderTaskId(manifestId) && !isAcceptedProviderTaskId(checkpointId)
      || isAcceptedProviderTaskId(checkpointId) && isAcceptedProviderTaskId(manifestId) && checkpointId !== manifestId
    ) return null
    const taskId = isAcceptedProviderTaskId(checkpointId) ? checkpointId : manifestId

    const checkpointKey = checkpointEntry.idempotency_key
    const manifestKey = manifestEntry.idempotency_key
    if (
      (checkpointKey !== undefined && !isAcceptedProviderTaskId(checkpointKey))
      || (manifestKey !== undefined && !isAcceptedProviderTaskId(manifestKey))
      || isAcceptedProviderTaskId(checkpointKey) && isAcceptedProviderTaskId(manifestKey) && checkpointKey !== manifestKey
    ) return null
    const idempotencyKey = isAcceptedProviderTaskId(checkpointKey) ? checkpointKey : manifestKey
    if (!idempotencyKey) return null

    const matches = (job.genstudio_jobs || []).filter(entry => entry.id === taskId)
    const provider = matches[0]
    const providerKey = provider?.request?.idempotency_key
    if (
      matches.length !== 1
      || provider.operation !== 'image.generation'
      || provider.cancelled === true
      || !isActiveGenStudioProviderState(provider.state)
      || providerKey !== undefined && providerKey !== idempotencyKey
      || providerTaskIds.has(taskId)
    ) return null
    providerTaskIds.add(taskId)
  }

  if (providerTaskIds.size !== progress.settling || keys.length !== progress.settling) return null
  return {
    job_id: job.job_id,
    settling: progress.settling,
    concurrency: progress.concurrency,
    active_asset_keys: keys,
    provider_task_ids: [...providerTaskIds],
  }
}

/** Test-only synchronization for deterministic manifest-read race fixtures. */
export function _setContinuityTailManifestReaderForTesting(reader: ContinuityTailManifestReader): () => void {
  const previous = continuityTailManifestReader
  continuityTailManifestReader = reader
  return () => {
    if (continuityTailManifestReader === reader) continuityTailManifestReader = previous
  }
}

let adaptiveImageTailAdmissionFlight: Promise<void> | null = null
let adaptiveImageTailEventVersion = 0

function hasPendingImageCandidate(): boolean {
  return IMAGE_GROUP_TYPES.some(type => queues[type].pending.length > 0)
}

function hasExactAdaptiveLocalState(base: number): boolean {
  return !queuePaused
    && imageEpisodeConcurrency === base
    && (groupActive[IMAGE_EPISODE_GROUP] || 0) === base
    && activeImageEpisodeJobIds.size === base
    && hasPendingImageCandidate()
}

function sameContinuityTailProof(left: ContinuityTailProof, right: ContinuityTailProof | null): boolean {
  if (!right) return false
  return left.job_id === right.job_id
    && left.settling === right.settling
    && left.concurrency === right.concurrency
    && left.active_asset_keys.length === right.active_asset_keys.length
    && left.active_asset_keys.every((key, index) => key === right.active_asset_keys[index])
    && left.provider_task_ids.length === right.provider_task_ids.length
    && left.provider_task_ids.every((id, index) => id === right.provider_task_ids[index])
}

export function hasVerifiedGenStudioAdmission(snapshot: GenStudioAdmissionSnapshot | null | undefined): boolean {
  return snapshot?.capacity_verified === true
    && snapshot.limitSource === 'account-overview'
    && Number.isSafeInteger(snapshot.available_paid_slots)
    && snapshot.available_paid_slots > 0
    && snapshot.queue_near_capacity === false
    && snapshot.submissions_blocked === false
    && snapshot.retry_after_ms === 0
}

const PAID_ATTEMPT_STATE_ORDER: Record<PaidImageReplacementAttempt['state'], number> = {
  waiting: 1, committed: 2, submitted: 3, succeeded: 4, failed: 4, blocked: 4,
}

function mergePaidImageReplacementAttempts(
  persisted: PaidImageReplacementAttempt[] | undefined,
  incoming: PaidImageReplacementAttempt[] | undefined,
): PaidImageReplacementAttempt[] | undefined {
  if (!persisted?.length) return incoming
  if (!incoming?.length) return persisted
  const merged = new Map(persisted.map(attempt => [attempt.asset_key, attempt]))
  for (const candidate of incoming) {
    const previous = merged.get(candidate.asset_key)
    if (!previous || PAID_ATTEMPT_STATE_ORDER[candidate.state] > PAID_ATTEMPT_STATE_ORDER[previous.state]) {
      merged.set(candidate.asset_key, candidate)
    }
  }
  return [...merged.values()]
}

async function findContinuityTailProof(): Promise<ContinuityTailProof | null> {
  for (const jobId of [...activeImageEpisodeJobIds]) {
    const job = jobs.get(jobId)
    if (job?.type !== 'continuity_render') continue
    const proof = await proveContinuitySettlingTail(job)
    if (proof) return proof
  }
  return null
}

async function attemptAdaptiveImageTailAdmission(): Promise<void> {
  const base = imageEpisodeConcurrency
  if (!hasExactAdaptiveLocalState(base)) return

  const proof = await findContinuityTailProof()
  if (!proof || !activeImageEpisodeJobIds.has(proof.job_id) || !hasExactAdaptiveLocalState(base)) return

  const current = jobs.get(proof.job_id)
  const freshProof = current ? await proveContinuitySettlingTail(current) : null
  if (
    !hasExactAdaptiveLocalState(base)
    || !activeImageEpisodeJobIds.has(proof.job_id)
    || !sameContinuityTailProof(proof, freshProof)
  ) return

  pumpImageEpisodeGroup(base + 1)
}

/** Request one event-driven, shared capacity proof for a Continuity final wave. */
export function requestAdaptiveImageTailAdmission(): void {
  if (adaptiveImageTailAdmissionFlight) return
  const eventVersion = adaptiveImageTailEventVersion
  adaptiveImageTailAdmissionFlight = attemptAdaptiveImageTailAdmission().catch(() => {}).finally(() => {
    adaptiveImageTailAdmissionFlight = null
    if (adaptiveImageTailEventVersion !== eventVersion) requestAdaptiveImageTailAdmission()
  })
}

function noteAdaptiveImageTailEvent(): void {
  adaptiveImageTailEventVersion++
  requestAdaptiveImageTailAdmission()
}

/** Test-only synchronization for deferred race fixtures. */
export async function _waitForAdaptiveImageTailAdmissionForTesting(): Promise<void> {
  while (adaptiveImageTailAdmissionFlight) await adaptiveImageTailAdmissionFlight
}

function isSafelyRetryableStallImageFailure(
  entry: NonNullable<Job['genstudio_jobs']>[number],
): boolean {
  if (
    entry.operation !== 'image.generation'
    || !entry.id
    || entry.id.startsWith('pending:')
    || entry.state !== 'failed'
    || entry.cancelled === true
    || holdsUnknownOutcome(entry)
    || !isRetryableZeroSettlementImageFailureCode(entry.failure_code)
  ) return false
  const reserved = entry.reserved_credits
  const settled = entry.settled_credits
  const released = entry.released_credits
  return [reserved, settled, released].every(value => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  )) && settled === 0 && released === reserved
}

function hasSafeTerminalStallEvidence(job: Job): boolean {
  if (
    job.type !== 'continuity_render'
    || job.status !== 'paused'
    || job.pause_origin !== 'stall'
    || job.local_execution_complete !== true
    || job.pause_requested === true
    || pauseRequested.has(job.job_id)
    || cancelled.has(job.job_id)
    || hasCancellationContext(job)
    || !queues[job.type]?.executor
    || !hasStableImageOutputIdentity(job)
  ) return false

  const entries = job.genstudio_jobs || []
  if (!entries.length) return false
  return entries.every(entry => {
    if (
      entry.operation !== 'image.generation'
      || !entry.id
      || entry.cancelled === true
    ) return false
    if (isNeverCreatedProviderTask(entry)) {
      return Boolean(entry.request?.idempotency_key)
        && entry.reserved_credits === 0 && entry.settled_credits === 0 && entry.released_credits === 0
    }
    if (entry.id.startsWith('pending:')) return false
    if (entry.state === 'succeeded') return true
    return isSafelyRetryableStallImageFailure(entry)
  })
}

async function hasDurableContinuityStallManifestOwnership(
  job: Job,
  requireOwnedExistingOutputs = false,
): Promise<boolean> {
  const episodeId = job.params?.episode_id
  if (
    typeof job.output_dir !== 'string'
    || typeof episodeId !== 'string'
    || !episodeId
  ) return false

  const checkpoint = job.params.genstudio_recovery
  if (checkpoint?.version !== 1 || checkpoint.route !== 'genstudio' || !checkpoint.assets) return false
  const filenames = Array.isArray(job.params?.scene_ids) && job.params.scene_ids.length
    ? [...new Set(job.params.scene_ids)].map(sceneId => `${sceneId}.png`)
    : Object.keys(checkpoint.assets)
  if (!filenames.length || !filenames.every(filename => (
    typeof filename === 'string'
    && filename.endsWith('.png')
    && path.basename(filename) === filename
  ))) return false
  let outputDir: string
  try {
    const { resolveContinuityRenderOutputDir } = await import('../generators/continuity-render.js')
    outputDir = await resolveContinuityRenderOutputDir(job.project_slug, episodeId)
  } catch {
    return false
  }
  if (path.resolve(job.output_dir) !== path.resolve(outputDir)) return false

  if (requireOwnedExistingOutputs) {
    try {
      const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('./utils.js')
      const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
      const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
      const audit = await auditSceneImageCompletion(
        planPath,
        filenames.map(filename => filename.slice(0, -'.png'.length)),
        [outputDir],
      )
      if (audit.expected !== filenames.length || audit.completed !== audit.expected
        || audit.missing.length || audit.invalid.length || audit.issues.length) return false
    } catch {
      return false
    }
  }

  const manifest = await readManifest(outputDir)
  for (const filename of filenames) {
    const outputPath = path.join(outputDir, filename)
    const manifestEntry = manifest.tasks[filename]
    const checkpointEntry = checkpoint.assets[filename]
    const decodable = await isDecodableImage(outputPath)
    if (decodable && !requireOwnedExistingOutputs) continue
    if (
      manifestEntry?.operation !== 'image'
      || !manifestEntry.idempotency_key
      || checkpointEntry?.operation !== 'image'
      || checkpointEntry.idempotency_key !== manifestEntry.idempotency_key
      || (checkpointEntry.output_path !== undefined && (
        typeof checkpointEntry.output_path !== 'string'
        || path.resolve(checkpointEntry.output_path) !== path.resolve(outputPath)
      ))
    ) return false
    // A stall can happen after reserving the local request key but before
    // receiving its provider id. Reconciliation resolves that exact key; the
    // executor will rejoin it or replay a proven-absent prepared request.
    const prepared = !manifestEntry.task_id && manifestEntry.last_state === 'prepared'
      && !checkpointEntry.job_id && checkpointEntry.state === 'prepared'
      && Boolean(manifestEntry.input_hash) && checkpointEntry.input_hash === manifestEntry.input_hash
    if (prepared && !requireOwnedExistingOutputs) {
      const evidence = (job.genstudio_jobs || []).filter(entry => (
        entry.operation === 'image.generation'
        && entry.request?.idempotency_key === manifestEntry.idempotency_key
      ))
      if (evidence.length !== 1) return false
      continue
    }
    if (!manifestEntry.task_id || checkpointEntry.job_id !== manifestEntry.task_id) return false
    const matchingEvidence = (job.genstudio_jobs || []).filter(entry => (
      entry.operation === 'image.generation' && entry.id === manifestEntry.task_id
    ))
    if (matchingEvidence.length !== 1) return false
    const evidenceKey = matchingEvidence[0]!.request?.idempotency_key
    if ((!decodable || !requireOwnedExistingOutputs) && evidenceKey !== manifestEntry.idempotency_key) return false
    if (evidenceKey !== undefined && evidenceKey !== manifestEntry.idempotency_key) return false
    if (!decodable && requireOwnedExistingOutputs) return false
  }
  return true
}

function hasAuthoritativeCompletionDeclaration(job: Job): boolean {
  const completion = job.result?.completion
  return job.result?.complete === true
    && completion?.complete === true
    && Number.isSafeInteger(completion.expected)
    && completion.expected >= 0
    && completion.completed === completion.expected
    && !(completion.missing?.length)
    && !(completion.invalid?.length)
    && !(completion.issues?.length)
}

function hasVerifiedCompleteStallDeclaration(job: Job): boolean {
  return hasAuthoritativeCompletionDeclaration(job)
    && job.result?.completion?.expected === Object.keys(job.params.genstudio_recovery?.assets || {}).length
    && !((job.params.pipeline_chain as unknown[] | undefined)?.length)
    && (job.genstudio_jobs || []).every(entry => entry.state === 'succeeded')
}

/** Rejoin only evidence-proven stall holds through the ordinary durable lane. */
async function recoverSafelySettledStallJobs(
  selected: Job[],
  afterEligibilityForTesting?: (eligibleJobIds: string[]) => void | Promise<void>,
  pumpReleased = true,
): Promise<Set<JobType>> {
  if (queuePaused) return new Set()
  const eligible: Job[] = []
  for (const job of selected.filter(hasSafeTerminalStallEvidence)) {
    if (hasVerifiedCompleteStallDeclaration(job)) {
      if (!await hasDurableContinuityStallManifestOwnership(job, true)) continue
      if (queuePaused || jobs.get(job.job_id) !== job
        || !hasSafeTerminalStallEvidence(job) || !hasVerifiedCompleteStallDeclaration(job)) continue
      job.status = 'done'
      job.pause_requested = false
      job.pause_origin = undefined
      job.error = null
      job.finished_at = new Date().toISOString()
      job.output_lines.push('Story Studio verified this render was complete while paused and finalized it without running generation again.')
      await persistJob(job)
      emitUpdate(job)
    } else if (await hasDurableContinuityStallManifestOwnership(job)) {
      eligible.push(job)
    }
  }
  if (afterEligibilityForTesting && eligible.length) {
    await afterEligibilityForTesting(eligible.map(job => job.job_id))
  }
  const released = await transitionPausedJobsToQueuedByProject(eligible)
  if (pumpReleased) for (const type of released.lanes) pump(type)
  return released.lanes
}

/** Test-only entry to prove repeated eligible recovery triggers stay idempotent. */
export async function _recoverStallJobForTesting(
  jobId: string,
  afterEligibility?: (eligibleJobIds: string[]) => void | Promise<void>,
): Promise<void> {
  const job = jobs.get(jobId)
  if (job) await recoverSafelySettledStallJobs([job], afterEligibility)
}

/**
 * Durable project-batched paused → queued transition. Queue-origin recovery is
 * its only caller in this task; scoped explicit Resume extends this same seam.
 */
async function transitionPausedJobsToQueuedByProject(
  selected: Job[],
  options: PausedJobTransitionOptions = {},
): Promise<PausedJobTransitionResult> {
  const result: PausedJobTransitionResult = {
    resumed: [],
    noExecutor: [],
    persistenceFailed: [],
    lanes: new Set<JobType>(),
  }
  if (queuePaused && !options.allowWhileQueuePaused) return result

  const seen = new Set<string>()
  const candidates = selected.filter(job => {
    if (seen.has(job.job_id) || job.status !== 'paused' || pausedTransitionClaims.has(job.job_id)) return false
    seen.add(job.job_id)
    const queue = queues[job.type]
    if (options.requireExecutor && !queue?.executor) {
      result.noExecutor.push(job)
      return false
    }
    if (!queue) return false
    pausedTransitionClaims.add(job.job_id)
    return true
  })
  try {
  const byProject = new Map<string, Job[]>()
  for (const job of candidates) {
    const group = byProject.get(job.project_slug) || []
    group.push(job)
    byProject.set(job.project_slug, group)
  }

  const durable = new Set<string>()
  for (const [projectSlug, projectJobs] of byProject) {
    const eligibleJobs = projectJobs.filter(job => (
      pausedTransitionClaims.has(job.job_id)
      && jobs.get(job.job_id) === job
      && job.status === 'paused'
      && !cancelled.has(job.job_id)
    ))
    if (!eligibleJobs.length) continue
    const snapshots: PausedJobTransitionSnapshot[] = eligibleJobs.map(job => ({
      job,
      pauseRequested: pauseRequested.has(job.job_id),
      pause_requested: job.pause_requested,
      pause_origin: job.pause_origin,
      status: job.status,
      started_at: job.started_at,
      finished_at: job.finished_at,
      error: job.error,
      output_lines: [...job.output_lines],
    }))
    for (const { job } of snapshots) {
      pauseRequested.delete(job.job_id)
      job.pause_requested = false
      job.pause_origin = undefined
      job.status = 'queued'
      if (!IMAGE_EPISODE_TYPES.has(job.type)) job.started_at = null
      job.finished_at = null
      job.error = null
      job.output_lines.push('Resume requested — verifying saved assets and accepted provider tasks before submitting missing work.')
    }
    try {
      await persistProjectSnapshot(projectSlug)
      for (const { job } of snapshots) durable.add(job.job_id)
    } catch (error) {
      for (const snapshot of snapshots) {
        const { job } = snapshot
        if (
          job.status === 'queued'
          && job.pause_origin === undefined
          && job.pause_requested !== true
          && !pauseRequested.has(job.job_id)
        ) {
          if (snapshot.pauseRequested) pauseRequested.add(job.job_id)
          else pauseRequested.delete(job.job_id)
          job.pause_requested = snapshot.pause_requested
          job.pause_origin = snapshot.pause_origin
          job.status = snapshot.status
          job.started_at = snapshot.started_at
          job.finished_at = snapshot.finished_at
          job.error = snapshot.error
          job.output_lines = snapshot.output_lines
        }
        result.persistenceFailed.push(job)
      }
      console.warn('[job-queue] failed to persist paused-job release', {
        project_slug: projectSlug,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const job of candidates) {
    if (
      !durable.has(job.job_id)
      || job.status !== 'queued'
      || job.pause_origin !== undefined
      || job.pause_requested === true
      || pauseRequested.has(job.job_id)
    ) continue
    const queue = queues[job.type]
    const lineupRetryAt = typeof job.params?.llm_lineup_retry_at === 'string'
      ? job.params.llm_lineup_retry_at
      : null
    if (lineupRetryAt && validRetryAtMs(lineupRetryAt) !== null) {
      scheduleLlmLineupWait(job)
      emitUpdate(job)
      result.resumed.push(job)
      continue
    }
    if (!queue.pending.some(candidate => candidate.job_id === job.job_id)) {
      queue.pending.push(job)
    }
    emitUpdate(job)
    result.resumed.push(job)
    result.lanes.add(job.type)
  }
  return result
  } finally {
    for (const job of candidates) pausedTransitionClaims.delete(job.job_id)
  }
}

/** Explicitly rejoin every paused record in a server-owned project/type scope. */
export async function resumePausedJobs(scope: ResumePausedJobsScope): Promise<ResumePausedJobsResult> {
  await initializeQueuePauseState()
  const projectSlugs = new Set(scope.projectSlugs)
  const selected = [...jobs.values()].filter(job => (
    job.status === 'paused'
    && !pausedTransitionClaims.has(job.job_id)
    && projectSlugs.has(job.project_slug)
    && (scope.type === undefined || job.type === scope.type)
  ))
  const transitioned = await transitionPausedJobsToQueuedByProject(selected, {
    allowWhileQueuePaused: true,
    requireExecutor: true,
  })
  for (const type of transitioned.lanes) pump(type)

  const skippedReasons: NonNullable<ResumePausedJobsResult['skipped_reasons']> = []
  if (transitioned.noExecutor.length) {
    skippedReasons.push({ reason: 'no-executor', count: transitioned.noExecutor.length })
  }
  if (transitioned.persistenceFailed.length) {
    skippedReasons.push({ reason: 'persistence-failed', count: transitioned.persistenceFailed.length })
  }
  const result: ResumePausedJobsResult = {
    requested: selected.length,
    resumed: transitioned.resumed.length,
    skipped: selected.length - transitioned.resumed.length,
  }
  if (skippedReasons.length) result.skipped_reasons = skippedReasons
  return result
}

/** Pause one job without cancelling provider work. Queued work is removed
 * before submit; running work observes the request at its next safe boundary. */
export async function pauseJob(jobId: string, origin: 'manual' | 'queue' | 'stall' = 'manual'): Promise<Job | null> {
  // Keep the long-standing synchronous state transition for ordinary jobs.
  // Paid waits alone need to serialize with their due callback.
  const current = jobs.get(jobId)
  if (!current || !getValidPaidImageWait(current)) return pauseJobUnlocked(jobId, origin)
  return withPaidImageWaitSettingGate(() => withPaidImageWaitJobMutex(jobId, () => pauseJobUnlocked(jobId, origin)))
}

async function pauseJobUnlocked(jobId: string, origin: 'manual' | 'queue' | 'stall' = 'manual'): Promise<Job | null> {
  const job = jobs.get(jobId)
  if (!job) return null
  clearPaidImageWaitTimer(jobId)
  clearLlmLineupWaitTimer(jobId)
  if (job.status === 'queued') {
    const q = queues[job.type]
    q.pending = q.pending.filter(candidate => candidate.job_id !== jobId)
    job.status = 'paused'
    job.pause_requested = false
    job.pause_origin = origin
    job.finished_at = null
    job.output_lines.push('Paused before submission. No provider work was started.')
  } else if (job.status === 'running') {
    const canPause = classifyJobControls(job, {
      remoteCancellationAudited: hasJobCancellationAuditor(job.type),
    }).some(control => control.action === 'pause-submissions' && control.enabled)
    if (!canPause) return null
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

/** Provider-stall circuit breaker. It stops admission only; no provider cancel is sent. */
export async function pauseJobForStall(jobId: string, reason: string): Promise<Job | null> {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'running' || pauseRequested.has(jobId)) return job ? serializeJob(job) : null
  const paused = await pauseJob(jobId, 'stall')
  if (paused) {
    const current = jobs.get(jobId)
    if (current) {
      current.output_lines.push(`Automatic submission hold: ${reason} Already accepted work is still being monitored; nothing was cancelled or retried.`)
      await persistJob(current)
      emitUpdate(current)
      return serializeJob(current)
    }
  }
  return paused
}

/** Resume the same durable job record. Executors audit disk/manifests first,
 * so accepted or completed items are reclaimed rather than resubmitted. */
export async function resumeJob(jobId: string): Promise<Job | null> {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'paused') return null
  const transitioned = await transitionPausedJobsToQueuedByProject([job], {
    allowWhileQueuePaused: true,
    requireExecutor: true,
  })
  if (transitioned.persistenceFailed.some(candidate => candidate.job_id === jobId)) {
    throw Object.assign(
      new Error('Story Studio could not save this Resume request. The job remains paused; try again after storage is available.'),
      { status: 503, expose: true },
    )
  }
  if (transitioned.noExecutor.some(candidate => candidate.job_id === jobId)) {
    throw Object.assign(
      new Error('This job type is unavailable in the current queue, so it remains paused.'),
      { status: 409, expose: true },
    )
  }
  for (const type of transitioned.lanes) pump(type)
  return transitioned.resumed.find(candidate => candidate.job_id === jobId)
    ? serializeJob(job)
    : null
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
  // v1.4.41 — `scene_images_batch` was the retired generator's bulk type and is
  // gone; `continuity_render` (Scene Review) is now the only bulk renderer.
  return job.type === 'continuity_render' && !job.params?.single_scene_id
}

function findActiveBulkSceneRenderInternal(projectSlug: string, episodeId: string): Job | null {
  for (const job of jobs.values()) {
    if (job.project_slug !== projectSlug || job.episode_id !== episodeId) continue
    if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'paused') continue
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
}, contentPackOptions: ContentPackProjectPinOptions = {}): Promise<Job> {
  if (projectRemovalInProgress.has(opts.project_slug)) {
    throw Object.assign(new Error('Project removal is in progress. Return later before starting new work.'), { statusCode: 409 })
  }
  if (!opts.sync) return enqueue(opts, contentPackOptions)

  const executor = queues[opts.type]?.executor
  if (!executor) throw new Error(`enqueueOrRun(sync): no executor registered for ${opts.type}`)

  const contentPackProvenance = await snapshotProjectContentPackProvenance(
    opts.project_slug,
    opts.type,
    contentPackOptions,
  )
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
    ...(contentPackProvenance.length ? { content_pack_provenance: contentPackProvenance } : {}),
    params: opts.params || {},
  }
  try {
    await runWithJobContentPackProvenance(job.content_pack_provenance, () => executor(job))
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

export interface EnqueueOptions {
  project_slug: string
  type: JobType
  episode_id: string
  title?: string
  params?: Record<string, any>
  /** Server-only durable identity for one episode recovery edge. Never accepted from a request body. */
  episode_recovery_job_id?: string
  /** Server-only replacement scope for a terminal GenStudio chat retry. */
  genstudio_chat_retry_scope?: string
  /** Server-only exact replay marker for unresolved GenStudio chat evidence. */
  genstudio_chat_recovery?: true
  /** Server-extracted recovery fields. These are deliberately outside params. */
  genstudio_chat_recovery_key?: string
  genstudio_chat_recovery_purpose?: 'outline' | 'narrative-repair' | 'narrative-batch'
  genstudio_chat_recovery_chapters?: number[]
  genstudio_chat_recovery_keys?: string[]
  /** Narrow the duplicate check to jobs whose params satisfy this predicate.
   *  When omitted, dedupe is per (project, episode, type) — the historical
   *  behaviour. chapter-only passes a predicate that compares
   *  `params.chapter_number` so two regens for different chapters can both
   *  enqueue (run back-to-back) without rejecting each other. */
  dedupeParams?: (params: any) => boolean
}

/** Internal insertion-only options. Public enqueue callers cannot set policy. */
interface EnqueuePreparedOptions extends EnqueueOptions {
  paid_image_replacement?: PaidImageReplacementPolicySnapshot
  /** Derived from durable queue evidence; public enqueue callers cannot supply it. */
  genstudio_chat_recovery_preview?: GenStudioRequestPreview
  /** Internal retry evidence copied only after an exact read-only provider reconciliation. */
  genstudio_jobs?: Job['genstudio_jobs']
  generation_replacement_attempts?: Job['generation_replacement_attempts']
  manual_failed_item_replacement?: Job['manual_failed_item_replacement']
}

function withoutPaidImageReplacementParam(params: EnqueueOptions['params']): EnqueueOptions['params'] {
  if (!params || !Object.prototype.hasOwnProperty.call(params, 'paid_image_replacement')) return params
  const sanitized = { ...params }
  delete sanitized.paid_image_replacement
  return sanitized
}

function enqueuePrepared(
  opts: EnqueuePreparedOptions,
  contentPackProvenance: Job['content_pack_provenance'] = [],
): Job {
  if (episodeMediaCleanupInProgress.has(episodeMediaAdmissionKey(opts.project_slug, opts.episode_id))) {
    throw Object.assign(
      new Error('Local media cleanup is in progress for this episode. Try again shortly.'),
      { statusCode: 409 },
    )
  }
  if (projectRemovalInProgress.has(opts.project_slug)) {
    throw Object.assign(new Error('Project removal is in progress. Return later before starting new work.'), { statusCode: 409 })
  }
  if (!queues[opts.type]) {
    throw new Error(`No queue lane registered for job type: ${opts.type}`)
  }
  if (opts.type === 'continuity_render'
    && finishMissingReservations.has(finishMissingReservationKey(opts.project_slug, opts.episode_id))) {
    throw new DuplicateJobError(opts.type, opts.episode_id)
  }
  // Cross-type atomic dedupe for the retired Scene Review batch name and the
  // canonical continuity renderer. Full renders conflict with either full
  // type; a single-scene repair also waits behind an active full render.
  const isBulkRequest = opts.type === 'continuity_render' && !opts.params?.single_scene_id
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

  const jobId = opts.episode_recovery_job_id || randomUUID().slice(0, 8)
  if (activeRunJobIds.has(jobId)) {
    throw Object.assign(new Error('This recovery job\'s previous worker is still stopping. Try again once it finishes.'), {
      status: 409, expose: true,
    })
  }
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
    ...(contentPackProvenance.length ? { content_pack_provenance: contentPackProvenance } : {}),
    params: opts.params || {},
    ...(opts.paid_image_replacement ? { paid_image_replacement: opts.paid_image_replacement } : {}),
    ...(opts.genstudio_jobs?.length ? { genstudio_jobs: structuredClone(opts.genstudio_jobs) } : {}),
    ...(opts.generation_replacement_attempts?.length
      ? { generation_replacement_attempts: structuredClone(opts.generation_replacement_attempts) } : {}),
    ...(opts.manual_failed_item_replacement
      ? { manual_failed_item_replacement: structuredClone(opts.manual_failed_item_replacement) } : {}),
    ...(opts.genstudio_chat_retry_scope ? { genstudio_chat_retry_scope: opts.genstudio_chat_retry_scope } : {}),
    ...(opts.genstudio_chat_recovery ? { genstudio_chat_recovery: true as const } : {}),
    ...(opts.genstudio_chat_recovery_key ? { genstudio_chat_recovery_key: opts.genstudio_chat_recovery_key } : {}),
    ...(opts.genstudio_chat_recovery_purpose ? { genstudio_chat_recovery_purpose: opts.genstudio_chat_recovery_purpose } : {}),
    ...(opts.genstudio_chat_recovery_chapters?.length ? { genstudio_chat_recovery_chapters: opts.genstudio_chat_recovery_chapters } : {}),
    ...(opts.genstudio_chat_recovery_keys?.length ? { genstudio_chat_recovery_keys: opts.genstudio_chat_recovery_keys } : {}),
    ...(opts.genstudio_chat_recovery_preview ? { genstudio_chat_recovery_preview: opts.genstudio_chat_recovery_preview } : {}),
  }

  jobs.set(jobId, job)
  // Recovery edges must reach disk before admission. Their saved identity
  // closes the crash window between writing the episode plan and queueing it.
  if (opts.episode_recovery_job_id) return serializeJob(job)
  queues[opts.type].pending.push(job)
  persistJob(job).catch(e => console.error('[job-queue] Failed to persist:', e))
  // Emit synchronously so SSE subscribers see the new queued job before the
  // route handler replies — otherwise the renderer's optimistic UI and the
  // backend event race on which reaches the user first.
  emitUpdate(job)

  // Kick off processing
  pump(opts.type)
  if (IMAGE_EPISODE_TYPES.has(opts.type)) noteAdaptiveImageTailEvent()

  return serializeJob(job)
}

/**
 * Test-only low-level insertion for queue state-machine tests that construct
 * isolated jobs without a durable project Content Pack selection. Production
 * callers must use enqueue(), which snapshots and verifies exact pins first.
 */
export function enqueuePreparedForTest(opts: EnqueueOptions & { started_at?: string | null }): Job {
  const job = enqueuePrepared(opts)
  // Test-only fixture seam for a queued recovery record. Production enqueue
  // remains unchanged and always creates a fresh job with no start timestamp.
  if (opts.started_at) {
    const live = jobs.get(job.job_id)
    if (live?.status === 'queued') {
      live.started_at = opts.started_at
      return serializeJob(live)
    }
  }
  return job
}

/**
 * Serialize one episode's cleanup removal against queue admission. Existing
 * running/queued jobs are still rejected by cleanup; this closes only the
 * narrow gap where a new job could be admitted after cleanup's last check.
 */
const episodeMediaCleanupInProgress = new Set<string>()

function episodeMediaAdmissionKey(projectSlug: string, episodeId: string): string {
  return `${projectSlug}:${episodeId.toUpperCase()}`
}

export function withEpisodeMediaAdmissionLock<T>(
  projectSlug: string,
  episodeId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLock(`episode-media-admission:${episodeMediaAdmissionKey(projectSlug, episodeId)}`, fn)
}

/** Hold the episode admission lock while a reviewed local file is being mutated. */
export function withEpisodeMediaCleanupLock<T>(
  projectSlug: string,
  episodeId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = episodeMediaAdmissionKey(projectSlug, episodeId)
  return withEpisodeMediaAdmissionLock(projectSlug, episodeId, async () => {
    episodeMediaCleanupInProgress.add(key)
    try { return await fn() }
    finally { episodeMediaCleanupInProgress.delete(key) }
  })
}

/** Resolve project pins exactly once, then construct the immutable queued job. */
export async function enqueue(
  opts: EnqueueOptions,
  contentPackOptions: ContentPackProjectPinOptions = {},
  beforeAdmission?: () => Promise<void>,
): Promise<Job> {
  const safeOpts: EnqueueOptions = { ...opts, ...(opts.params ? { params: { ...opts.params } } : {}) }
  delete (safeOpts as EnqueueOptions & { paid_image_replacement?: unknown }).paid_image_replacement
  delete (safeOpts as EnqueueOptions & { genstudio_chat_recovery_preview?: unknown }).genstudio_chat_recovery_preview
  // This marker belongs only to a queue-created availability hold. A request
  // body cannot pre-park a job or suppress its first attempt.
  if (safeOpts.params) delete safeOpts.params.llm_lineup_retry_at
  const { params, ...enqueueOpts } = safeOpts
  // Capture the shared lineup before this job crosses queue admission. The
  // helper keeps an existing job snapshot and explicit stage policy intact.
  const lineupParams = await snapshotLlmLineupParams(
    opts.project_slug,
    opts.type,
    opts.episode_id,
    withoutPaidImageReplacementParam(params) || {},
  )
  const provenance = await snapshotProjectContentPackProvenance(
    opts.project_slug,
    opts.type,
    contentPackOptions,
  )
  const paid_image_replacement = (
    opts.type === 'continuity_render'
    || opts.type === 'image_pool_generate'
    || opts.type === 'thumb_images'
  )
    ? await getPaidImageReplacementSetting().then(setting => ({
      ...setting,
      wait_minutes: 30 as const,
      max_replacements_per_asset: 1 as const,
      snapshotted_at: new Date().toISOString(),
    }))
    : undefined
  return withEpisodeMediaAdmissionLock(opts.project_slug, opts.episode_id, async () => {
    // Pipeline must recheck deliberate cleanup after acquiring admission, so
    // a cleanup completed while it prepared cannot trigger regeneration.
    await beforeAdmission?.()
    return enqueuePrepared({
      ...enqueueOpts,
      params: lineupParams,
      ...(paid_image_replacement ? { paid_image_replacement } : {}),
    }, provenance)
  })
}

export async function enqueueEpisodeRecoveryOnce(jobId: string, opts: EnqueueOptions): Promise<Job> {
  return withLock(`episode-recovery-job:${jobId}`, async () => {
    await loadPersistedJobs(opts.project_slug)
    const existing = jobs.get(jobId)
    if (existing) {
      if (existing.project_slug !== opts.project_slug || existing.episode_id !== opts.episode_id || existing.type !== opts.type) {
        throw new Error('Episode recovery job identity does not match its saved scope.')
      }
      return serializeJob(existing)
    }
    const result = await enqueue({ ...opts, episode_recovery_job_id: jobId })
    const job = jobs.get(result.job_id)!
    try { await persistJob(job) }
    catch (error) { jobs.delete(job.job_id); throw error }
    queues[job.type].pending.push(job)
    emitUpdate(job)
    pump(job.type)
    return serializeJob(job)
  })
}

/** Explicit retries and free subtitle observations retain the same durable identities. */
export async function resumeEpisodeRecoveryJob(jobId: string, explicit = false): Promise<void> {
  await withLock(`episode-recovery-job:${jobId}`, async () => {
    const job = jobs.get(jobId)
    if (!job || job.status !== 'error'
      || !job.params?.episode_recovery_id || (!explicit && job.params.force) || job.force_abandoned || hasCancellationContext(job)) return
    const states = Object.values(job.params?.subtitle_recovery?.sections || {}) as Array<{ state?: string }>
    if (!explicit && (job.type !== 'subtitles_transcribe'
      || !states.some(state => state.state === 'waiting_settlement' || state.state === 'free_recovery'))) return
    const previous = { status: job.status, error: job.error, finished_at: job.finished_at }
    job.status = 'queued'
    job.error = null
    job.finished_at = null
    try { await persistJob(job) }
    catch (error) { Object.assign(job, previous); throw error }
    if (!queues[job.type].pending.some(queued => queued.job_id === jobId)) queues[job.type].pending.push(job)
    emitUpdate(job)
    pump(job.type)
  })
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

/** Every queued, running or paused job of one type on this server, across all projects. */
export function activeJobsOfType(type: Job['type']): Array<Pick<Job, 'project_slug' | 'episode_id' | 'type' | 'status'>> {
  return [...jobs.values()].filter(j => j.type === type && ['queued', 'running', 'paused'].includes(j.status))
}

export function getJob(jobId: string): Job | null {
  const job = jobs.get(jobId)
  return job ? safeJob(job) : null
}

/** Renderer-only single-job snapshot; internal recovery callers use getJob(). */
export function getPublicJob(jobId: string): RendererJob | null {
  const job = jobs.get(jobId)
  return job ? serializeJob(job) : null
}

/**
 * Requeue a failed/cancelled continuity render in place for the Jobs-page
 * Finish missing images action.  This is deliberately separate from the
 * generic retry path: retryTerminalJob creates a fresh history row and drops
 * the original provider evidence, while this action must let the continuity
 * executor recover the saved manifest identities on the same row.
 */
export async function finishMissingImagesInPlace(
  projectSlug: string,
  jobId: string,
): Promise<{ job: Job; reused: boolean }> {
  let reservationKey: string | undefined
  try {
    return await withPaidImageWaitJobMutex(jobId, async () => {
      await loadPersistedJobs(projectSlug)
      const authoritative = await loadAuthoritativeJob(projectSlug, jobId)
      if (!authoritative || authoritative.project_slug !== projectSlug) {
        throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
      }
      if (authoritative.type !== 'continuity_render') {
        throw Object.assign(new Error('Finish missing images is available only for Scene Review jobs.'), { status: 409, expose: true })
      }

      const directMarker = authoritative.params?.jobs_finish_missing_images
      const cancellationPending = Object.values(authoritative.remote_cancellations || {}).some(record => (
        PENDING_REMOTE_CANCELLATION_STATUSES.has(record.status)
      ))
      if ((authoritative.status === 'queued' || authoritative.status === 'running')
        && directMarker && typeof directMarker === 'object') {
        if (cancellationPending) {
          throw Object.assign(
            new Error('This job is still being reconciled after cancellation. Wait for reconciliation before finishing missing images.'),
            { status: 409, expose: true },
          )
        }
        return { job: structuredClone(authoritative), reused: true }
      }
      if (authoritative.status !== 'error' && authoritative.status !== 'cancelled') {
        throw Object.assign(new Error('Only failed or cancelled Scene Review jobs can finish missing images.'), { status: 409, expose: true })
      }
      if (activeRunJobIds.has(jobId)) {
        throw Object.assign(new Error('This image job\'s previous worker is still stopping. Try again once it finishes.'), {
          status: 409, expose: true,
        })
      }
      if (cancellationPending) {
        throw Object.assign(
          new Error('This job is still being reconciled after cancellation. Wait for reconciliation before finishing missing images.'),
          { status: 409, expose: true },
        )
      }
      const params = authoritative.params && typeof authoritative.params === 'object' ? authoritative.params : {}
      if (typeof params.model !== 'string' || !params.model.trim()) {
        throw Object.assign(new Error('The saved Scene Review job has no model settings to reuse.'), { status: 409, expose: true })
      }

      const now = new Date().toISOString()
      const manualActionId = randomUUID()
      const directActionId = randomUUID()
      const durable = await mutateAuthoritativeJob(projectSlug, jobId, current => {
        if (current.project_slug !== projectSlug || current.type !== 'continuity_render') return null
        if (current.status === 'queued' || current.status === 'running') {
          const marker = current.params?.jobs_finish_missing_images
          return marker && typeof marker === 'object' ? current : null
        }
        if (current.status !== 'error' && current.status !== 'cancelled') return null
        if (Object.values(current.remote_cancellations || {}).some(record => PENDING_REMOTE_CANCELLATION_STATUSES.has(record.status))) return null
        const active = findActiveBulkSceneRenderInternal(projectSlug, current.episode_id)
        if (active && active.job_id !== current.job_id) return null
        const key = finishMissingReservationKey(projectSlug, current.episode_id)
        const reservedBy = finishMissingReservations.get(key)
        if (reservedBy && reservedBy !== current.job_id) return null
        finishMissingReservations.set(key, current.job_id)
        reservationKey = key
        const currentParams = current.params && typeof current.params === 'object' ? current.params : {}
        if (typeof currentParams.model !== 'string' || !currentParams.model.trim()) return null
        const next = structuredClone(current)
        const sceneIds = Array.isArray(currentParams.scene_ids)
          ? currentParams.scene_ids
          : (typeof currentParams.single_scene_id === 'string' ? [currentParams.single_scene_id] : undefined)
        next.params = {
          ...currentParams,
          missing_only: true,
          // A direct Jobs action is still the same recovery-first manual path
          // used by Scene Review. Both action ids are server-owned and never
          // accepted from a request body.
          manual_image_finish: {
            action_id: manualActionId,
            replace_uncertain: false,
          },
          jobs_finish_missing_images: {
            action_id: directActionId,
            requested_at: now,
          },
          ...(sceneIds?.length ? { scene_ids: sceneIds } : {}),
        }
        delete next.params.force
        delete next.params.render_attempt_id
        delete next.params.generation_action
        delete next.params.generation_action_fingerprint
        delete next.params.single_scene_id
        delete next.params.pipeline_repair
        delete next.params.pipeline_repair_request_fingerprint
        next.status = 'queued'
        delete next.force_abandoned
        next.started_at = null
        next.finished_at = null
        next.error = null
        next.local_execution_complete = false
        next.pause_requested = false
        next.pause_origin = undefined
        next.auto_retry = undefined
        next.progress = undefined
        next.item_progress = undefined
        next.result = undefined
        next.output_lines = [
          ...(Array.isArray(next.output_lines) ? next.output_lines : []),
          'Finish missing images requested from Jobs — checking saved images and provider work before submitting anything new.',
        ]
        return next
      })
      if (!durable) {
        throw Object.assign(new Error('This image job changed before Finish missing images could be queued. Refresh Jobs and try again.'), { status: 409, expose: true })
      }
      const live = jobs.get(jobId)
      const queued = live || durable
      Object.assign(queued, durable)
      if (!('force_abandoned' in durable)) delete queued.force_abandoned
      jobs.set(jobId, queued)
      cancelled.delete(jobId)
      pauseRequested.delete(jobId)
      if (!pendingContains('continuity_render', jobId)) queues.continuity_render.pending.push(queued)
      emitUpdate(queued)
      pumpImageEpisodeGroup(imageEpisodeConcurrency)
      return { job: structuredClone(queued), reused: false }
    })
  } finally {
    if (reservationKey && finishMissingReservations.get(reservationKey) === jobId) {
      finishMissingReservations.delete(reservationKey)
    }
  }
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
  purpose: 'outline' | 'narrative-repair' | 'narrative-batch'
  chapters?: number[]
  preview: GenStudioRequestPreview
  notCreated: boolean
}

function chatEntries(job: Job): NonNullable<Job['genstudio_jobs']> {
  return (job.genstudio_jobs || []).filter(entry => entry.operation === 'chat.response')
}

function isPreDispatchCreditRefusal(entry: NonNullable<Job['genstudio_jobs']>[number]): boolean {
  return entry.state === 'failed'
    && entry.dispatch_state === 'pre_dispatch'
    && entry.queue_state === 'waiting_credits'
}

function isResolvedChatEntry(entry: NonNullable<Job['genstudio_jobs']>[number]): boolean {
  return isPreDispatchCreditRefusal(entry) || (typeof entry.id === 'string'
    && !!entry.id
    && !entry.id.startsWith('pending:')
    && (entry.state === 'succeeded' || entry.state === 'failed'))
}

function chapterChatRetryMode(job: Job): ChapterChatRetryMode | undefined {
  const chats = chatEntries(job)
  if (chats.length === 0) return undefined
  const terminalFailure = chats.find(entry =>
    isPreDispatchCreditRefusal(entry) || (entry.state === 'failed'
    && typeof entry.id === 'string'
    && !!entry.id
    && !entry.id.startsWith('pending:')),
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
  const creditRefusal = chatEntries(job).find(isPreDispatchCreditRefusal)
  if (creditRefusal) {
    const key = creditRefusal.request?.idempotency_key?.trim() || creditRefusal.id.replace(/^pending:/, '')
    return `credit-refused:${key}:${job.job_id}`
  }
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
    if (!entry.id.startsWith('pending:') || (entry.state !== 'submitting' && entry.state !== 'not_created')) return []
    const preview = entry.request
    if (!preview || preview.messages?.some(message => message.truncated)) return []
    const key = entry.request?.idempotency_key?.trim()
    const user = entry.request?.messages?.find(message => message.role === 'user')
    if (!key || entry.id !== pendingGenStudioEntryId(key) || !user || user.truncated) return []
    if (chatEntries(job).some(other => other !== entry && (
      other.id === pendingGenStudioEntryId(key)
      || other.request?.idempotency_key?.trim() === key
    ))) return []
    if (entry.state === 'not_created' && [
      entry.credit_cost, entry.reserved_credits, entry.settled_credits,
      entry.returned_credits, entry.released_credits,
    ].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value !== 0))) return []
    if (/^Plan (the chapter structure|a listicle \/ explainer episode)\./.test(user.text)) {
      return [{ key, purpose: 'outline' as const, preview, notCreated: entry.state === 'not_created' }]
    }
    const slots = user.text.match(/SLOTS TO WRITE NOW:\n([\s\S]*?)\n(?:OUTPUT|Output|Return)/)
    const chapters = slots
      ? [...slots[1].matchAll(/^\s*Chapter (\d+):/gm)].map(match => Number(match[1]))
      : []
    if (!chapters.length || chapters.some(chapter => !Number.isInteger(chapter) || chapter < 1)) return []
    if (user.text.includes('RECOVERY INSTRUCTION: This is one bounded repair pass.')) {
      return [{ key, purpose: 'narrative-repair' as const, chapters, preview, notCreated: entry.state === 'not_created' }]
    }
    const requested = /^Write (\d+) chapter\(s\) of an in-progress episode\./.exec(user.text)
    if (entry.state !== 'not_created' || !requested || Number(requested[1]) !== chapters.length) return []
    return [{ key, purpose: 'narrative-batch' as const, chapters, preview, notCreated: true }]
  })
  if (candidates.length !== 1) return null
  const recovery = candidates[0]!
  if (recovery.notCreated && chatEntries(job).filter(entry => !isResolvedChatEntry(entry)).length !== 1) return null
  return recovery
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

function currentAudioTtsEvidence(job: Job): GenStudioEvidence[] | null {
  if (job.type !== 'audio') return null
  const assets = job.params?.genstudio_recovery?.assets
  if (!assets || typeof assets !== 'object') return null
  const checkpoints = Object.values(assets as Record<string, any>).filter(entry => entry?.operation === 'tts')
  if (!checkpoints.length) return null
  const matched = new Set<string>()
  const current: GenStudioEvidence[] = []
  for (const entry of checkpoints) {
    const taskId = typeof entry.job_id === 'string' ? entry.job_id.trim() : ''
    const key = typeof entry.idempotency_key === 'string' ? entry.idempotency_key.trim() : ''
    if (!taskId || !key) return null
    const related = (job.genstudio_jobs || []).filter(item => item.operation === 'voice.tts'
      && (item.id === taskId || providerRequestKey(item) === key))
    if (related.length !== 1 || related[0]!.id !== taskId || providerRequestKey(related[0]!) !== key) return null
    const identity = `${taskId}\u0000${key}`
    if (matched.has(identity)) return null
    matched.add(identity)
    current.push(related[0]!)
  }
  return current
}

function hasRelatedUncertainAudioEvidence(job: Job): boolean {
  if (job.type !== 'audio') return false
  const assets = job.params?.genstudio_recovery?.assets
  if (!assets || typeof assets !== 'object') return false
  const checkpoints = Object.values(assets as Record<string, any>).filter(entry => entry?.operation === 'tts')
  return checkpoints.some(entry => (job.genstudio_jobs || []).some(item => item.operation === 'voice.tts'
    && isSubmissionUncertainCode(item.failure_code || '')
    && ((entry.job_id && item.id === entry.job_id)
      || (entry.idempotency_key && providerRequestKey(item) === entry.idempotency_key))))
}

/** A manual child may use ordinary Retry only when every provider key remains exact. */
export function canRetryManualFailedItemExactly(job: Job): boolean {
  if (!job.params?.jobs_replace_failed_items) return false
  if (job.type !== 'audio') return Boolean(job.manual_failed_item_replacement?.requests.length)
  const current = currentAudioTtsEvidence(job)
  return current !== null && current.every(entry => (
    entry.state !== 'failed' || isSubmissionUncertainCode(entry.failure_code || '')
  ))
}

export function retryTerminalJob(
  projectSlug: string,
  jobId: string,
  replacementParams?: Record<string, any>,
  internal?: {
    reconciledGenStudioJobs?: Job['genstudio_jobs']
    manualFailedItemReplacement?: Job['manual_failed_item_replacement']
  },
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
  const exactManualRetry = canRetryManualFailedItemExactly(original)
  const currentAudioEvidence = currentAudioTtsEvidence(original)
  if (hasRelatedUncertainAudioEvidence(original) && currentAudioEvidence === null) {
    throw Object.assign(
      new Error('The saved uncertain audio request does not exactly match every current task identity. No provider work was submitted.'),
      { status: 409, expose: true },
    )
  }
  const creatingManualReplacement = Boolean(internal?.reconciledGenStudioJobs
    && original.params?.jobs_replace_failed_items?.source_job_id === original.job_id)
  if (original.params?.jobs_replace_failed_items && !exactManualRetry && !creatingManualReplacement) {
    throw Object.assign(
      new Error('This manual replacement has a confirmed provider failure. Use Replace failed items to make another deliberate attempt.'),
      { status: 409, expose: true },
    )
  }
  const manualFailedItemReplacement = internal?.manualFailedItemReplacement
    || (exactManualRetry ? original.manual_failed_item_replacement : undefined)
  const exactUncertainAudioRetry = (currentAudioEvidence || []).some(entry => (
    entry.state === 'failed' && isSubmissionUncertainCode(entry.failure_code || '')
  ))
  const reconciledGenStudioJobs = internal?.reconciledGenStudioJobs
    || (exactManualRetry || exactUncertainAudioRetry ? original.genstudio_jobs : undefined)

  const chatBackedRetry = original.type === 'expand_chapters' || original.type === 'outline_only'
  const chapterRetryMode = chatBackedRetry
    ? chapterChatRetryMode(original)
    : undefined
  // v1.2.8 — an abandoned job is exempt. "Generate a new one in its
  // replacement" is the other half of the escape hatch, and refusing the retry
  // on evidence the owner has explicitly chosen to stop waiting for would leave
  // him abandoned AND stuck. Retry never reuses a provider identity here: it
  // submits fresh work, which is what he asked for and what he is paying for.
  if (!original.force_abandoned && hasUnsettledProviderEvidence(original)
    && !(chatBackedRetry && chapterRetryMode === 'exact-replay') && !exactManualRetry) {
    throw Object.assign(
      new Error('This job still has unsettled provider evidence. Story Studio will reconcile it before any fresh retry.'),
      { status: 409, expose: true },
    )
  }
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
  const genstudio_chat_retry_scope = manualFailedItemReplacement
    ? undefined
    : chapterRetryMode === 'fresh-replacement'
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

  const retryParams = structuredClone(replacementParams || original.params || {})
  // v1.4.41 retired the old combined image lane. Its thumbnail shape remains
  // a supported customer action, so move only that exact legacy shape onto the
  // current lane. Scene modes stay rejected before either history mutation.
  const originalType = original.type as string
  let retryType: JobType = original.type
  if (originalType === 'images') {
    if (retryParams.mode !== undefined && retryParams.mode !== 'thumbs') {
      throw Object.assign(
        new Error('Legacy Scene Images are retired. Render planned scenes in Scene Review.'),
        { status: 409, expose: true },
      )
    }
    retryType = 'thumb_images'
  }
  // A manual Finish/Replace nonce authorizes only its original action. Generic
  // retry machinery may retain ordinary continuity behavior, but cannot copy
  // that explicit paid intent into a new queue identity.
  if (original.type === 'continuity_render') delete retryParams.manual_image_finish
  const retried = enqueuePrepared({
    project_slug: original.project_slug,
    type: retryType,
    episode_id: original.episode_id,
    title: original.title,
    params: retryParams,
    ...(reconciledGenStudioJobs?.length
      ? { genstudio_jobs: reconciledGenStudioJobs } : {}),
    ...(original.generation_replacement_attempts?.length
      ? { generation_replacement_attempts: original.generation_replacement_attempts } : {}),
    ...(manualFailedItemReplacement
      ? { manual_failed_item_replacement: manualFailedItemReplacement } : {}),
    ...(genstudio_chat_retry_scope ? { genstudio_chat_retry_scope } : {}),
    ...(chapterRetryMode === 'exact-replay'
      && !(recovery?.notCreated && recovery.purpose === 'narrative-batch')
      ? { genstudio_chat_recovery: true as const }
      : {}),
    ...(recovery ? {
      genstudio_chat_recovery_key: recovery.key,
      genstudio_chat_recovery_purpose: recovery.purpose,
      ...(recovery.chapters ? { genstudio_chat_recovery_chapters: recovery.chapters } : {}),
      ...(pendingKeys.length ? { genstudio_chat_recovery_keys: pendingKeys } : {}),
      ...(recovery.notCreated && recovery.purpose === 'narrative-batch'
        ? { genstudio_chat_recovery_preview: structuredClone(recovery.preview) }
        : {}),
    } : pendingKeys.length ? { genstudio_chat_recovery_keys: pendingKeys } : {}),
  }, original.content_pack_provenance)

  // An old worker must still observe cancellation until its finally runs.
  if (!activeRunJobIds.has(jobId)) cancelled.delete(jobId)
  jobs.delete(jobId)
  emitCleared(projectSlug, [jobId])
  void persistProjectMutation(projectSlug, { kind: 'delete', jobId }).catch((error) => {
    console.warn('[job-queue] failed to persist retried job replacement', {
      projectSlug,
      jobId,
      error: error?.message,
    })
  })
  return retried
}

/**
 * Explicit Jobs action: re-read each failed provider identity, derive the
 * smallest saved audio/writing scope, then atomically replace the terminal
 * Story row. The browser supplies no section, chapter, prompt, or model data.
 */
export async function replaceFailedItems(projectSlug: string, jobId: string): Promise<Job> {
  return withLock(`replace-failed-items:${projectSlug}:${jobId}`, async () => {
    await loadPersistedJobs(projectSlug)
    const existingChild = Array.from(jobs.values()).find(job => (
      job.project_slug === projectSlug
      && job.params?.jobs_replace_failed_items?.source_job_id === jobId
    ))
    if (existingChild) return serializeJob(existingChild) as Job
    const existing = jobs.get(jobId)
    if (!existing || existing.project_slug !== projectSlug) {
      throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
    }
    const savedMarker = existing.params?.jobs_replace_failed_items
    if (savedMarker?.version === 1 && savedMarker.source_job_id === existing.job_id) {
      return retryTerminalJob(projectSlug, jobId, structuredClone(existing.params), {
        reconciledGenStudioJobs: existing.genstudio_jobs,
        ...(existing.manual_failed_item_replacement
          ? { manualFailedItemReplacement: existing.manual_failed_item_replacement } : {}),
      })
    }
    // Resolve any submitting/running evidence before the operation-specific
    // live reads below. This is read-only at GenStudio and cannot create work.
    await recheckJobProviderStatus(projectSlug, jobId)
    const refreshed = jobs.get(jobId)
    if (!refreshed || refreshed.project_slug !== projectSlug) {
      throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
    }
    const { planFailedItemReplacement } = await import('./failed-item-replacement.js')
    const plan = await planFailedItemReplacement(refreshed)
    const requestId = randomUUID()
    const params = {
      ...plan.params,
      jobs_replace_failed_items: {
        version: 1,
        source_job_id: refreshed.job_id,
        requested_at: new Date().toISOString(),
        item_count: plan.itemCount,
      },
    }
    const manualFailedItemReplacement = plan.evidence.some(entry => entry.operation === 'chat.response' && entry.state === 'failed')
      ? {
          source_job_id: refreshed.job_id,
          requests: plan.evidence
            .filter(entry => entry.operation === 'chat.response' && entry.state === 'failed')
            .map((entry, index) => {
              const originalKey = providerRequestKey(entry)!
              const priorManual = refreshed.manual_failed_item_replacement?.requests.find(item => (
                item.replacement_idempotency_key === originalKey
              ))
              const priorAutomatic = refreshed.generation_replacement_attempts?.find(item => (
                item.kind === 'writing' && item.idempotency_key === originalKey
              ))
              return {
                original_task_id: entry.id,
                original_idempotency_key: originalKey,
                prepared_idempotency_key: priorManual?.prepared_idempotency_key
                  || priorManual?.original_idempotency_key
                  || priorAutomatic?.original_idempotency_key
                  || originalKey,
                replacement_idempotency_key: `story-manual-${requestId}-${index + 1}`,
              }
            }),
        }
      : undefined
    const reconciled = await mutateAuthoritativeJob(projectSlug, jobId, job => ({
      ...job,
      params,
      genstudio_jobs: plan.evidence,
      ...(manualFailedItemReplacement
        ? { manual_failed_item_replacement: manualFailedItemReplacement } : {}),
    }))
    if (!reconciled || reconciled.status !== 'error') {
      throw Object.assign(new Error('This job changed while its failed items were checked. Refresh Jobs and try again.'), { status: 409, expose: true })
    }
    return retryTerminalJob(projectSlug, jobId, params, {
      reconciledGenStudioJobs: plan.evidence,
      ...(manualFailedItemReplacement
        ? { manualFailedItemReplacement } : {}),
    })
  })
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

function cancellationControlFor(job: Job): JobControl {
  return classifyJobControls(job, {
    remoteCancellationAudited: hasJobCancellationAuditor(job.type),
  }).find(control => (
    control.action === 'cancel-before-submit'
    || control.action === 'stop-local'
    || control.action === 'request-remote-cancel'
  )) || controlFor(job)
}

async function cancelQueuedBeforeSubmit(job: Job): Promise<Job> {
  if (!getValidPaidImageWait(job)) return cancelQueuedBeforeSubmitUnlocked(job)
  return withPaidImageWaitSettingGate(() => withPaidImageWaitJobMutex(job.job_id, () => cancelQueuedBeforeSubmitUnlocked(job)))
}

async function cancelQueuedBeforeSubmitUnlocked(job: Job): Promise<Job> {
  clearPaidImageWaitTimer(job.job_id)
  clearLlmLineupWaitTimer(job.job_id)
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
  if (!getValidPaidImageWait(job)) return stopLocalJobUnlocked(job)
  return withPaidImageWaitSettingGate(() => withPaidImageWaitJobMutex(job.job_id, () => stopLocalJobUnlocked(job)))
}

async function stopLocalJobUnlocked(job: Job): Promise<Job> {
  clearPaidImageWaitTimer(job.job_id)
  clearLlmLineupWaitTimer(job.job_id)
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
  if (!getValidPaidImageWait(job)) return queueRemoteCancellationTargetsUnlocked(job, targets)
  return withPaidImageWaitSettingGate(() => withPaidImageWaitJobMutex(job.job_id, () => queueRemoteCancellationTargetsUnlocked(job, targets)))
}

async function queueRemoteCancellationTargetsUnlocked(
  job: Job,
  targets: NonNullable<JobControl['targets']>,
): Promise<Job> {
  clearPaidImageWaitTimer(job.job_id)
  clearLlmLineupWaitTimer(job.job_id)
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
  if (job.status === 'queued') queues[job.type].pending = queues[job.type].pending.filter(candidate => candidate.job_id !== job.job_id)
  job.status = 'running'
  job.started_at ||= now
  job.finished_at = null
  job.pause_requested = false
  pauseRequested.delete(job.job_id)
  if (added > 0) job.output_lines.push(`Cancellation requested for ${added} provider task${added === 1 ? '' : 's'}; waiting for GenStudio confirmation.`)
  await persistJob(job)
  emitUpdate(job)
  // Recovered jobs have no executor boundary; live jobs can be inside one.
  // Start the read-only control-plane reconciliation after the one durable
  // intent, with the reconciler retaining one-shot cancellation ownership.
  scheduleCancellationReconciliation(job.job_id)
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

  // NEW-01 — the missing-key reason is written while no key exists, so the
  // primary control can name the key instead of saying only that it is checking.
  // Once a key IS configured that reason is stale, and leaving it standing would
  // make the admission guard below refuse a cancellation the customer can now
  // legitimately request (it classifies any reconciliation_error as
  // return-later). Drop exactly that reason, and only when a key now exists.
  if (job.reconciliation_error === MISSING_KEY_RECONCILIATION_DETAIL) {
    const key = await getApiKey('genstudio').catch(() => '')
    if (key) job.reconciliation_error = undefined
  }

  // A repeated click must not create another provider cancellation request.
  // Keep returning the durable first request while its authoritative outcome
  // is still being reconciled.
  if (Object.values(job.remote_cancellations || {}).some(record => (
    record.status === 'queued' || record.status === 'submitting' || record.status === 'requested' || record.status === 'reconciling'
  ))) return serializeJob(job)

  const control = cancellationControlFor(job)
  if (!control.enabled) throw new JobControlError(control)
  if (control.action === 'cancel-before-submit') return cancelQueuedBeforeSubmit(job)
  if (control.action === 'stop-local') return stopLocalJob(job)
  if (control.action === 'request-remote-cancel') return queueRemoteCancellationTargets(job, control.targets || [])
  throw new JobControlError(control)
}

/**
 * Credit releases this job's OWN log already recorded, as GenStudio published
 * them. The sentence `releasedCreditSettlement` writes into every settled
 * failure — "GenStudio reports N credits released." — is the only durable trace
 * of a release Story Studio ever sees, so it is read back rather than re-derived.
 */
export function readRecordedCreditReleases(lines: readonly string[]): { count: number; total: number } {
  let count = 0
  let total = 0
  for (const line of lines) {
    for (const match of line.matchAll(/GenStudio reports (\d+(?:\.\d+)?) credits released/g)) {
      const released = Number(match[1])
      if (!Number.isFinite(released)) continue
      count += 1
      total += released
    }
  }
  return { count, total: Math.round(total * 1000) / 1000 }
}

/**
 * What abandoning does, and does not, do to money — without asserting a fact
 * this code cannot know.
 *
 * IT USED TO SAY "nothing was refunded", FLATLY. On 2026-08-28 every credit on
 * an abandoned job had already been released by GenStudio, server-side, 43
 * minutes before the owner pressed the button — and the job's own log said so,
 * three lines above the sentence claiming the opposite. Story Studio holds no
 * balance and cannot refund anything; that much is always true and is what the
 * message now says. Whether GenStudio released credits is a question only
 * GenStudio's record answers, so this quotes the job's own evidence when it has
 * some and points at the account when it does not.
 */
function describeAbandonedCreditPosition(lines: readonly string[]): string {
  const released = readRecordedCreditReleases(lines)
  if (!released.count) {
    return 'Credits: Story Studio holds no balance and refunds nothing itself. Whatever GenStudio '
      + 'charged or released for this job is recorded in your GenStudio KH account — check there for the '
      + 'final figure. Abandoning does not change it either way.'
  }
  return `Credits: this job's own log already records GenStudio releasing ${released.total} credit(s) across `
    + `${released.count === 1 ? 'one settled request' : `${released.count} settled requests`}. That release happened `
    + 'in your GenStudio KH account, not here, and abandoning does not undo it. Story Studio holds no balance and '
    + 'refunds nothing itself; your GenStudio KH account has the final figure.'
}

/**
 * v1.2.8 — the owner override: stop tracking this job, whatever state it is in.
 *
 * Every other exit from a job is gated on evidence, correctly. This one is not,
 * because "no exit exists" is not an acceptable outcome for a piece of software
 * the customer has to live in. It makes exactly one claim — that Story Studio
 * has stopped waiting — and deliberately makes no claim about the provider.
 *
 * That is why `genstudio_jobs` and `remote_cancellations` are left byte-for-byte
 * as they stand: abandoning teaches Story Studio nothing about GenStudio, so
 * rewriting the provider record to look settled would be inventing evidence.
 * Any output those tasks produce is still recoverable afterwards, and the log
 * names them so the user knows what he is walking away from.
 */
export async function forceAbandonJob(projectSlug: string, jobId: string): Promise<Job> {
  await loadPersistedJobs(projectSlug)
  const job = jobs.get(jobId)
  if (!job || job.project_slug !== projectSlug) {
    throw Object.assign(new Error('Job not found'), { status: 404, expose: true })
  }
  if (job.force_abandoned) return serializeJob(job)
  return withPaidImageWaitSettingGate(() => withPaidImageWaitJobMutex(job.job_id, () => forceAbandonJobUnlocked(job)))
}

async function forceAbandonJobUnlocked(job: Job): Promise<Job> {

  const unsettled = [
    ...(job.genstudio_jobs || [])
      .filter(isUnsettledProviderEntry)
      .map(entry => `${entry.operation} ${entry.id || 'with no provider job ID'}`),
    ...Object.values(job.remote_cancellations || {})
      .filter(record => PENDING_REMOTE_CANCELLATION_STATUSES.has(record.status))
      .map(record => `${record.operation} ${record.provider_job_id}`),
  ]

  clearPaidImageWaitTimer(job.job_id)
  clearLlmLineupWaitTimer(job.job_id)
  cancelled.add(job.job_id)
  pauseRequested.delete(job.job_id)
  const queue = queues[job.type]
  if (queue) queue.pending = queue.pending.filter(candidate => candidate.job_id !== job.job_id)
  killChildrenFor(job.job_id)
  const timer = cancellationReconcileTimers.get(job.job_id)
  if (timer) {
    clearTimeout(timer)
    cancellationReconcileTimers.delete(job.job_id)
  }

  job.force_abandoned = { at: new Date().toISOString(), unsettled: [...new Set(unsettled)] }
  job.status = 'cancelled'
  job.pause_requested = false
  job.pause_origin = undefined
  job.local_execution_complete = true
  job.reconciliation_error = undefined
  delete job.history_evidence_check
  job.finished_at = new Date().toISOString()
  job.output_lines.push('Abandoned at your request. Story Studio has stopped tracking this job and the queue has moved on.')
  job.output_lines.push(job.force_abandoned.unsettled.length
    ? `No cancellation was sent to GenStudio. ${job.force_abandoned.unsettled.length === 1 ? 'This provider task was' : `These ${job.force_abandoned.unsettled.length} provider tasks were`} still unresolved and may yet finish: ${job.force_abandoned.unsettled.join(', ')}. Anything they produce can still be recovered from the episode.`
    : 'No provider work was outstanding when it was abandoned.')
  job.output_lines.push(describeAbandonedCreditPosition(job.output_lines))
  job.output_lines.push('Run this step again whenever you are ready — Retry on this row starts it fresh.')
  await persistJob(job)
  emitUpdate(job)
  return serializeJob(job)
}

/** Remove terminal history only. Generated files and provider evidence remain intact. */
export function removeTerminalJob(projectSlug: string, jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || job.project_slug !== projectSlug) return false
  // An abandoned job is already the owner's explicit decision to stop waiting;
  // re-applying the unsettled-evidence hold here would put the row back in the
  // dead end that abandoning exists to escape.
  if (!TERMINAL_JOB_STATUSES.has(job.status)) return false
  if (!job.force_abandoned && hasUnsettledProviderEvidence(job)) return false
  clearPaidImageWaitTimer(jobId)
  clearLlmLineupWaitTimer(jobId)
  // A terminal status does not prove its worker has returned yet.
  if (!activeRunJobIds.has(jobId)) cancelled.delete(jobId)
  jobs.delete(jobId)
  if (job.type === 'continuity_render') {
    void deactivateSceneRenderStatus(job.project_slug, job.episode_id, job.job_id).catch(() => {})
  }
  emitCleared(projectSlug, [jobId])
  void persistProjectMutation(projectSlug, { kind: 'delete', jobId }).catch(() => {})
  return true
}

/**
 * The Jobs toolbar's terminal-history subsets. Omitting this selector keeps
 * the legacy clear-all-terminal-history behavior for existing callers.
 */
export type JobHistoryClearStatus = 'finished' | 'failed'

/** Match the Jobs page's display-only Recovered state for a failed subtitle attempt. */
function isVerifiedRecoveredSubtitleJob(job: Job): boolean {
  if (job.type !== 'subtitles_transcribe' || job.status !== 'error'
    || job.params?.force === true || job.params?.generation_action?.kind === 'fresh') return false
  const recovery = job.params?.episode_recovery
  const recoveryId = recovery?.id
  if (typeof recoveryId !== 'string' || !recoveryId.trim()
    || typeof job.params?.episode_recovery_id !== 'string'
    || recoveryId !== job.params.episode_recovery_id) return false
  return Array.isArray(recovery?.completed)
    && recovery.completed.includes('subtitle_sections')
    && recovery.completed.includes('subtitle_stitch')
    && (recovery.first_unresolved === null
      || recovery.first_unresolved === 'scene_plan_run'
      || recovery.first_unresolved === 'contextual_cues'
      || recovery.first_unresolved === 'continuity_render')
}

function matchesHistoryClearStatus(job: Job, status: JobHistoryClearStatus | undefined): boolean {
  if (!isFinishedStatus(job.status)) return false
  if (!status) return true
  if (status === 'finished') return job.status !== 'error' || isVerifiedRecoveredSubtitleJob(job)
  return job.status === 'error' && !isVerifiedRecoveredSubtitleJob(job)
}

export async function clearFinished(projectSlug: string, status?: JobHistoryClearStatus): Promise<number> {
  await loadPersistedJobs(projectSlug)
  let count = 0
  const clearedIds: string[] = []
  const clearedSceneRenderJobs: Array<Pick<Job, 'episode_id' | 'job_id'>> = []
  for (const [id, job] of jobs.entries()) {
    if (job.project_slug === projectSlug && matchesHistoryClearStatus(job, status) && (job.force_abandoned || !hasUnsettledProviderEvidence(job))) {
      clearPaidImageWaitTimer(id)
      clearLlmLineupWaitTimer(id)
      if (!activeRunJobIds.has(id)) cancelled.delete(id)
      jobs.delete(id)
      clearedIds.push(id)
      if (job.type === 'continuity_render') clearedSceneRenderJobs.push(job)
      count++
    }
  }
  void Promise.all(clearedSceneRenderJobs.map(job => (
    deactivateSceneRenderStatus(projectSlug, job.episode_id, job.job_id).catch(() => {})
  )))
  if (count > 0) emitCleared(projectSlug, clearedIds)
  // Clearing history is a UI housekeeping action, not an asset mutation.
  // Return as soon as memory + SSE are updated; persist the compact snapshot
  // behind the response so an iCloud-backed project cannot freeze the button.
  void Promise.all(clearedIds.map(jobId => persistProjectMutation(projectSlug, { kind: 'delete', jobId }))).catch((e) => {
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
