import {
  areBootJobsLoaded,
  clearFinalRenderMonitorTransientHold,
  hasFinalRenderMonitorTransientHold,
  isQueuePaused,
  listFinalRenderReconcileCandidates,
  loadAuthoritativeJob,
  mutateAuthoritativeJob,
  resumeRefusedFinalRenderLocally,
} from './job-queue.js'
import {
  advanceSealedPrivateFinalRenderTransport,
  reconcileSealedPrivateFinalRenderOnce,
} from './final-render-transport.js'
import { FinalRenderCheckHold, recoverFinalRenderImport } from './final-render-import.js'
import { getPrivateFinalRenderSetting } from './app-settings.js'
import {
  FINAL_RENDER_ATTENTION_PREFIX,
  parseFinalRenderRemoteWaitReceipt,
} from '../lib/final-render-remote-wait.js'

const FIRST_TICK_MS = 5_000
const TICK_MS = 30_000
const MAX_BACKOFF_MS = 30 * 60_000
const ACTION_PREFIX = FINAL_RENDER_ATTENTION_PREFIX
const MAX_CAUSE_CHARS = 400

type Identity = { project_slug: string; job_id: string }
type Failure = { count: number; retryAt: number; message?: string }

let started = false
let firstTick: NodeJS.Timeout | null = null
let interval: NodeJS.Timeout | null = null
let inFlight: Promise<void> | null = null
let cursor: Identity | null = null
const failures = new Map<string, Failure>()

function identityKey(identity: Identity): string {
  return `${identity.project_slug}\0${identity.job_id}`
}

/**
 * A cause the customer can act on, in one bounded line. URLs and credential-shaped words are
 * removed: a Gateway address or token must never reach the job row or its log.
 */
function safeFailureCause(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const cleaned = raw
    .replace(/https?:\/\/[^\s]+/gi, '[address]')
    .replace(/\b(?:authorization|bearer|token|api[_-]?key|secret)\b[^\n]{0,80}/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'the remote render could not be reconciled').slice(0, MAX_CAUSE_CHARS)
}

/** Show `message` as the running row's cause (and once in its log). Best-effort. */
async function writeActionableMessage({ project_slug, job_id }: Identity, message: string): Promise<void> {
  try {
    await mutateAuthoritativeJob(project_slug, job_id, job => {
      if (job.type !== 'video_assembly' || job.status !== 'running') return null
      const logged = job.output_lines.includes(message)
      if (job.error === message && logged) return null
      if (!logged) job.output_lines.push(message)
      job.error = message
      return job
    })
  } catch { /* the backoff map still holds the failure; visibility is best-effort */ }
}

/**
 * A reconcile failure is retried with backoff, but it must not stay invisible: the running row
 * carries its cause until that cause is gone. A plan hold records its own message, so it is left
 * alone. Returns the message it recorded, so a skipped retry can restore it.
 */
async function recordActionableFailure(identity: Identity, error: unknown): Promise<string | undefined> {
  if (error instanceof FinalRenderCheckHold) return undefined
  const message = `${ACTION_PREFIX}${safeFailureCause(error)}. This remote render was not completed; its `
    + 'retained evidence is kept while Story Studio tries this row again.'
  await writeActionableMessage(identity, message)
  return message
}

/** Clear only Story Studio's own attention message, just before a fresh attempt. */
async function clearActionableFailure({ project_slug, job_id }: Identity): Promise<void> {
  try {
    await mutateAuthoritativeJob(project_slug, job_id, job => {
      if (job.status !== 'running' || !job.error?.startsWith(ACTION_PREFIX)) return null
      job.error = null
      return job
    })
  } catch { /* best-effort */ }
}

const IMPORT_PHASES = new Set(['output_ready', 'importing', 'imported', 'acknowledged'])

/**
 * Route one row by its persisted receipt. Sending and importing never run while the queue is paused or
 * the setting is off (cancellation still does); monitor phases only ever look up the original key.
 * Returns false when it deliberately did nothing, so a skip is not a failure to back off from.
 */
async function reconcileOne({ project_slug, job_id }: Identity): Promise<boolean> {
  const job = await loadAuthoritativeJob(project_slug, job_id)
  const parsed = parseFinalRenderRemoteWaitReceipt(job?.final_render_remote_wait, job_id)
  const receipt = parsed.ok ? parsed.receipt : null
  if (receipt?.version === 3 && receipt.phase === 'refused') {
    if (receipt.cancel_requested_at !== null || isQueuePaused()) return false
    await resumeRefusedFinalRenderLocally(project_slug, job_id)
    return true
  }
  const sends = receipt?.version === 2 || (receipt?.version === 3 && receipt.phase === 'request_persisted')
  const imports = receipt?.version === 3 && IMPORT_PHASES.has(receipt.phase)
  if (!receipt || (!sends && !imports)) {
    if (receipt?.phase === 'recovery_hold') return false
    await reconcileSealedPrivateFinalRenderOnce(project_slug, job_id)
    return true
  }
  if (receipt.cancel_requested_at === null) {
    if (isQueuePaused() || !(await getPrivateFinalRenderSetting()).enabled) return false
    if (!await clearFinalRenderMonitorTransientHold(project_slug, job_id, receipt)) return true
  } else if (sends) {
    return false // an unsent cancelled intent has nothing to send or observe
  }
  if (sends) {
    const result = await advanceSealedPrivateFinalRenderTransport(project_slug, job_id)
    if (result.kind === 'video-assembly-local') await resumeRefusedFinalRenderLocally(project_slug, job_id)
  }
  else await recoverFinalRenderImport(project_slug, job_id)
  return true
}

async function runPass(now: number): Promise<void> {
  if (!areBootJobsLoaded()) throw new Error('Final render reconciliation requires completed queue boot recovery.')
  const candidates = listFinalRenderReconcileCandidates(cursor, 8)
  if (candidates.length === 0) {
    cursor = null
    return
  }
  for (const identity of candidates) {
    cursor = identity
    const key = identityKey(identity)
    const failure = failures.get(key)
    if (failure && failure.retryAt > now) continue
    let transientHold = false
    try {
      // The previous attempt's cause has had its time; clear it while the row is still running so a
      // successful retry never completes carrying a stale attention message. Completion clears any
      // cause this process could not know about (a restart empties the map).
      if (failure?.message) await clearActionableFailure(identity)
      const didWork = await reconcileOne(identity)
      if (didWork && hasFinalRenderMonitorTransientHold(identity.project_slug, identity.job_id)) {
        transientHold = true
        throw new Error('Final render monitor response requires bounded retry.')
      }
      // Nothing ran (paused queue, setting off, nothing to do): the cause was not fixed.
      if (!didWork && failure?.message) await writeActionableMessage(identity, failure.message)
      failures.delete(key)
    } catch (error) {
      const count = (failure?.count ?? 0) + 1
      const delay = Math.min(TICK_MS * (2 ** Math.min(count - 1, 16)), MAX_BACKOFF_MS)
      // A monitor hold is expected to clear on its own; anything else is the row's real cause.
      const message = transientHold
        ? failure?.message
        : await recordActionableFailure(identity, error)
      // The clear above must not leave a row with no visible cause during a hold window.
      if (transientHold && message) await writeActionableMessage(identity, message)
      failures.set(key, { count, retryAt: now + delay, ...(message ? { message } : {}) })
    }
  }
}

function runShared(now = Date.now()): Promise<void> {
  if (inFlight) return inFlight
  const running = runPass(now)
  const settled = running.finally(() => { inFlight = null })
  inFlight = settled
  return settled
}

function tick(): void {
  if (!started) return
  void runShared()
}

export function startFinalRenderReconciler(): void {
  if (!areBootJobsLoaded()) throw new Error('Final render reconciler cannot start before queue boot recovery is loaded.')
  if (started) return
  started = true
  firstTick = setTimeout(tick, FIRST_TICK_MS)
  firstTick.unref()
  interval = setInterval(tick, TICK_MS)
  interval.unref()
}

export async function runFinalRenderReconcilePassForTesting(now = Date.now()): Promise<void> {
  await runShared(now)
}

export async function _resetFinalRenderReconcilerForTesting(): Promise<void> {
  started = false
  if (firstTick) clearTimeout(firstTick)
  if (interval) clearInterval(interval)
  firstTick = null
  interval = null
  const captured = inFlight
  if (captured) await captured
  cursor = null
  failures.clear()
}
