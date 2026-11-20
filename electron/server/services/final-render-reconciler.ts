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

/**
 * One phase of one row may not hold this process longer than this.
 *
 * Owner, 2026-11-16: EP0105's `video_assembly` ran about 11.5 hours for an
 * 885-second video with progress and bytes null. The reconciler retried it
 * forever with a 30 s–30 min backoff, and because one pass walked its rows one
 * after another (`runShared` was single-flight) a single request that never
 * answered froze EVERY final-render row on that Mac. A ceiling is the difference
 * between "slow" and "stuck", and the row hears it as its own actionable cause.
 */
let phaseStallMs = 5 * 60_000

/** A row that spent longer than its phase ceiling. Named, so the cause says where. */
class FinalRenderStallError extends Error {
  constructor(readonly phase: string) {
    super(`The ${phase} phase did not finish or answer within ${Math.round(phaseStallMs / 60_000)} minutes`)
    this.name = 'FinalRenderStallError'
  }
}

type Identity = { project_slug: string; job_id: string }
type Failure = { count: number; retryAt: number; message?: string }

let started = false
let firstTick: NodeJS.Timeout | null = null
let interval: NodeJS.Timeout | null = null
let inFlight: Promise<void> | null = null
/** Test seams: one row's turn and the candidate list, so isolation can be driven directly. */
let reconcileOneForTesting: ((identity: Identity) => Promise<boolean>) | null = null
let candidatesForTesting: Identity[] | null = null
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
 * 1.4.415 — phases whose work is a TRANSFER, bounded by progress instead of the clock.
 *
 * `importing` moves an output file whose size nobody can predict; a wall-clock ceiling over it can
 * only be wrong in one direction, and it was: this ceiling and `download-video.ts`'s own abort were
 * both 300_000 ms, so a transfer of more than 300 s could never import, and the row named whichever
 * timer fired first — "the importing phase did not finish within 5 minutes" while the download was
 * still running. The transfer now bounds itself on IDLE BYTES (no progress for its own window), and
 * this pass does not race it, so no download is left running unowned either.
 */
const PROGRESS_BOUND_PHASES = new Set<string>(['importing'])

/** Which phases the pass must NOT race against a wall clock (1.4.415). Exported so a test pins it. */
export function isProgressBoundPhase(phase: string): boolean {
  return PROGRESS_BOUND_PHASES.has(phase)
}

const lastNotedPhase = new Map<string, string>()

/**
 * One log line per phase, so a row that goes quiet says where it is.
 *
 * "Logo shape: rounded corners (20%) · 96x96" was the last line EP0105 ever
 * wrote, and everything after it — the staged intent, the upload, the monitor
 * wait — said nothing at all. A long stretch with no line cannot be told apart
 * from a hang, and a phase name in the log is the cheapest fix for that.
 */
async function noteFinalRenderPhase(identity: Identity, phase: string | null): Promise<void> {
  if (!phase) return
  const label = phase.replaceAll('_', ' ')
  const key = identityKey(identity)
  if (lastNotedPhase.get(key) === label) return
  lastNotedPhase.set(key, label)
  try {
    await mutateAuthoritativeJob(identity.project_slug, identity.job_id, job => {
      if (job.type !== 'video_assembly' || job.status !== 'running') return null
      const line = `Final render: ${label}.`
      if (job.output_lines.includes(line)) return null
      job.output_lines.push(line)
      return job
    })
  } catch { /* visibility is best-effort; the ceiling still protects the pass */ }
}

/** The row's own phase, for the log line and the ceiling's reason. */
async function currentPhase(identity: Identity): Promise<string | null> {
  const job = await loadAuthoritativeJob(identity.project_slug, identity.job_id)
  const phase = (job?.final_render_remote_wait as { phase?: unknown } | undefined)?.phase
  return typeof phase === 'string' && phase ? phase : null
}

/**
 * Bound one row's turn. The underlying request keeps its own `AbortSignal`
 * deadline; this is what stops one stuck row from owning the whole pass.
 */
async function withStallCeiling<T>(phase: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FinalRenderStallError(phase)), phaseStallMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Route one row by its persisted receipt. Sending and importing never run while the queue is paused or
 * the setting is off (cancellation still does); monitor phases only ever look up the original key.
 * Returns false when it deliberately did nothing, so a skip is not a failure to back off from.
 */
async function reconcileOne({ project_slug, job_id }: Identity): Promise<boolean> {
  const job = await loadAuthoritativeJob(project_slug, job_id)
  const parsed = parseFinalRenderRemoteWaitReceipt(job?.final_render_remote_wait, job_id)
  const receipt = parsed.ok ? parsed.receipt : null
  if (receipt?.version === 3 && (receipt.phase === 'refused' || receipt.phase === 'remote_failed')) {
    // Both are settled: the Gateway will never produce an output for this render. `refused` means
    // it never took the job; `remote_failed` means it took it and then settled it failed. Either
    // way this Mac's lane carries the episode — a hold for the second case had no exit at all.
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
  // Only real rows need boot recovery: a supplied candidate list is already its own authority.
  if (!candidatesForTesting && !areBootJobsLoaded()) {
    throw new Error('Final render reconciliation requires completed queue boot recovery.')
  }
  const candidates = candidatesForTesting ?? listFinalRenderReconcileCandidates(cursor, 8)
  if (candidates.length === 0) {
    cursor = null
    return
  }
  // Rows run independently ACROSS projects, and one at a time WITHIN a project.
  //
  // One row's turn is bounded by its phase ceiling, but walking all of them one
  // after another still meant the pass took as long as their sum — and one row
  // that never answered froze every other final-render row on this Mac (EP0105,
  // 2026-11-16). Each row owns its own failure bookkeeping, so a rejection can no
  // longer be shared.
  //
  // Within one project the rows stay sequential on purpose: staging and commit
  // read-modify-write that project's durable jobs file, and two rows doing it at
  // once can lose one of the two receipts (`final-render-import.test.ts`, "a
  // final render staged by the queue … comes back done" — both rows lost their V3
  // receipt when this ran fully in parallel). Isolation is what the stuck row
  // must not take away, and a different project's rows never touch this file.
  const byProject = new Map<string, Identity[]>()
  for (const identity of candidates) {
    const group = byProject.get(identity.project_slug)
    if (group) group.push(identity)
    else byProject.set(identity.project_slug, [identity])
  }
  await Promise.allSettled([...byProject.values()].map(async group => {
    for (const identity of group) await reconcileRow(identity, now)
  }))
}

async function reconcileRow(identity: Identity, now: number): Promise<void> {
  cursor = identity
  const key = identityKey(identity)
  const failure = failures.get(key)
  if (failure && failure.retryAt > now) return
  let transientHold = false
  try {
    // The previous attempt's cause has had its time; clear it while the row is still running so a
    // successful retry never completes carrying a stale attention message. Completion clears any
    // cause this process could not know about (a restart empties the map).
    if (failure?.message) await clearActionableFailure(identity)
    const phase = (await currentPhase(identity)) ?? 'prepare'
    await noteFinalRenderPhase(identity, phase)
    const runOne = () => (reconcileOneForTesting ?? reconcileOne)(identity)
    const didWork = isProgressBoundPhase(phase)
      ? await runOne()
      : await withStallCeiling(phase, runOne())
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

/** Test-only: replace one row's turn, shorten the ceiling, or supply candidates. */
export function _setFinalRenderReconcileForTesting(input: {
  reconcileOne?: ((identity: Identity) => Promise<boolean>) | null
  candidates?: Identity[] | null
  phaseStallMs?: number | null
}): void {
  if ('reconcileOne' in input) reconcileOneForTesting = input.reconcileOne ?? null
  if ('candidates' in input) candidatesForTesting = input.candidates ?? null
  if ('phaseStallMs' in input) phaseStallMs = typeof input.phaseStallMs === 'number' ? input.phaseStallMs : 5 * 60_000
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
  lastNotedPhase.clear()
  reconcileOneForTesting = null
  candidatesForTesting = null
  phaseStallMs = 5 * 60_000
}
