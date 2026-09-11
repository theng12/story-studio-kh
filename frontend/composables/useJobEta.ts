/**
 * The job card's measured arithmetic: counts, speed, freshness, exceptions.
 *
 * WHY THIS FILE EXISTS. The job card used to answer "how is it going?" with a
 * wall of per-scene lines and a raw job id. The replacement answers it with
 * numbers — how many are in flight, how many are left, roughly how long, when
 * something last actually happened — and every one of those numbers has to be
 * MEASURED. The job contract carries no per-item timestamps and no per-item
 * rate, so nothing here may fall back to a table of "audio takes 12s an item".
 * A guess that looks like a measurement is worse than no number at all.
 *
 * Two clocks are available and this module uses both:
 *
 *   1. `item_progress.completed` sampled against wall-clock. The page feeds
 *      one sample per SSE/poll refresh into `recordEtaSample`; the window it
 *      builds is the only evidence of THIS job's speed.
 *   2. `genstudio_jobs[].updated_at`, which the client rewrites on every
 *      record write including the terminal one (see
 *      `electron/server/lib/genstudio-client.ts` — `updated_at:
 *      new Date().toISOString()` sits in the same object literal as
 *      `queue_state`). That makes the newest settled item's `updated_at` a
 *      real settlement clock, so no new server field was needed.
 *
 * Everything is a plain function over plain data — no Vue, no refs — so it can
 * be unit-tested directly the way `useBatchSummary.ts` is.
 */

import { effectiveGenStudioTaskState } from '@shared/provider-task-state'

// ── Shapes ────────────────────────────────────────────────────────────────
// Structural, not imported from the contract, so a test can hand these
// functions a literal without dragging the whole job type along.

export interface JobItemAttemptLike {
  label: string
  key?: string
  state: 'running' | 'waiting_retry'
  attempt: number
  max_attempts: number
  retry_at?: string
  reason?: string
}

export interface ItemProgressLike {
  total: number
  completed: number
  failed: number
  settling?: number
  cancelled?: number
  not_submitted?: number
  concurrency: number
  active: ReadonlyArray<JobItemAttemptLike>
}

export interface RemoteJobLike {
  id?: string
  operation?: string
  state?: string
  queue_state?: string
  updated_at?: string
  failure_code?: string | null
  settled_credits?: number
  /** Nullable on the wire — GenStudio publishes an explicit null. */
  released_credits?: number | null
  reserved_credits?: number
}

export interface AutoRetryLike {
  eligible: boolean
  reason?: string
  attempt?: number
  max_attempts?: number
  next_retry_at?: string
  exhausted?: boolean
}

export interface JobLike {
  type?: string
  status?: string
  started_at?: string | null
  finished_at?: string | null
  item_progress?: ItemProgressLike | null
  genstudio_jobs?: ReadonlyArray<RemoteJobLike> | null
  auto_retry?: AutoRetryLike | null
}

// ── 1. Counts ─────────────────────────────────────────────────────────────

export interface JobItemCounts {
  total: number
  /** Items the provider is working on right now. */
  inFlight: number
  finished: number
  /** Neither finished, failed, nor cancelled. Never negative. */
  remaining: number
  /** Accepted by us but not yet sent to the provider. */
  queued: number
  settling: number
  failed: number
  cancelled: number
}

function count(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * The four headline numbers plus the two that only sometimes apply.
 *
 * `remaining` is deliberately derived rather than read: the contract has no
 * "remaining" field, and a job that failed six items has six fewer left to do,
 * not six more. Clamped at zero because a provider that reports `completed`
 * and `failed` from two different polls can briefly overshoot `total`.
 */
export function summariseJobItems(progress: ItemProgressLike | null | undefined): JobItemCounts {
  const total = count(progress?.total)
  const finished = count(progress?.completed)
  const failed = count(progress?.failed)
  const cancelled = count(progress?.cancelled)
  return {
    total,
    inFlight: progress?.active?.length || 0,
    finished,
    remaining: Math.max(0, total - finished - failed - cancelled),
    queued: count(progress?.not_submitted),
    settling: count(progress?.settling),
    failed,
    cancelled,
  }
}

// ── 2. Measured speed and ETA ─────────────────────────────────────────────

/** One observation of a job's completed-count against the wall clock. */
export interface EtaSample {
  at: number
  completed: number
}

/**
 * The evidence bar for showing an ETA at all.
 *
 * Three completions across twenty seconds is the smallest window that can tell
 * "this job is moving at roughly this speed" from "one item happened to land".
 * An ETA derived from a single completion is not an estimate, it is a number
 * with a decimal point in it.
 */
export const ETA_MIN_COMPLETIONS = 3
export const ETA_MIN_OBSERVATION_MS = 20_000
/** Enough history to smooth a burst without holding a whole batch in memory. */
export const ETA_MAX_SAMPLES = 24

/**
 * Append a sample, keeping only the ones that carry information.
 *
 * A refresh where `completed` did not move tells us nothing new about the rate
 * — the elapsed time is read from the clock, not from the sample count — so
 * only changes are stored. The very first sighting IS stored, because it is
 * what "we have been watching since" means.
 */
export function recordEtaSample(
  window: readonly EtaSample[] | undefined,
  sample: EtaSample,
  maxSamples: number = ETA_MAX_SAMPLES,
): EtaSample[] {
  const previous = window || []
  const last = previous[previous.length - 1]
  if (last && last.completed === sample.completed) return previous.slice()
  // A job that restarts its counter (a retry reusing the same job_id) must not
  // be measured across the reset.
  if (last && sample.completed < last.completed) return [{ ...sample }]
  return [...previous, { ...sample }].slice(-Math.max(2, maxSamples))
}

/**
 * Items per second for THIS job, or null when the window cannot support one.
 *
 * Elapsed time is measured to `nowMs`, not to the last sample, so a job that
 * stops completing items sees its measured rate decay instead of freezing at
 * the speed it had before it stalled.
 */
export function rollingItemsPerSecond(
  window: readonly EtaSample[] | undefined,
  nowMs: number,
): number | null {
  const first = window?.[0]
  const last = window?.[window.length - 1]
  if (!first || !last) return null
  const completions = last.completed - first.completed
  const elapsedMs = Math.max(nowMs, last.at) - first.at
  if (completions < ETA_MIN_COMPLETIONS) return null
  if (elapsedMs < ETA_MIN_OBSERVATION_MS) return null
  const rate = completions / (elapsedMs / 1000)
  return rate > 0 ? rate : null
}

export interface FinishedJobLike {
  type?: string
  status?: string
  started_at?: string | null
  finished_at?: string | null
  item_progress?: { total?: number } | null
}

function millis(iso: string | null | undefined): number | null {
  if (!iso) return null
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : null
}

/**
 * The seconds-per-item this job CLASS has actually taken, from history.
 *
 * Median rather than mean: one twenty-minute outlier (a provider outage, a
 * machine that went to sleep mid-run) should not move the estimate for the
 * next run. There is no hardcoded table anywhere — a job type with no finished
 * multi-item history simply has no cadence yet, and the caller shows nothing.
 */
export function medianSecondsPerItem(
  history: readonly FinishedJobLike[] | undefined,
  type: string | undefined,
): number | null {
  if (!history?.length || !type) return null
  const samples: number[] = []
  for (const job of history) {
    if (job.type !== type || job.status !== 'done') continue
    const started = millis(job.started_at)
    const finished = millis(job.finished_at)
    const total = count(job.item_progress?.total)
    if (started === null || finished === null || total <= 0) continue
    const seconds = (finished - started) / 1000
    if (seconds > 0) samples.push(seconds / total)
  }
  if (!samples.length) return null
  samples.sort((a, b) => a - b)
  const middle = Math.floor(samples.length / 2)
  return samples.length % 2
    ? samples[middle]!
    : (samples[middle - 1]! + samples[middle]!) / 2
}

export interface EtaInput {
  remaining: number
  nowMs: number
  window?: readonly EtaSample[]
  history?: readonly FinishedJobLike[]
  type?: string
}

/**
 * Seconds of work left, or null.
 *
 * Priority is evidence quality, not convenience: this job's own measured rate
 * first, the class's measured median second, nothing third. "Nothing" is a
 * legitimate answer and is returned far more often than a guess would be.
 */
export function estimateSecondsRemaining(input: EtaInput): number | null {
  if (input.remaining <= 0) return null
  const rate = rollingItemsPerSecond(input.window, input.nowMs)
  if (rate !== null) return input.remaining / rate
  const cadence = medianSecondsPerItem(input.history, input.type)
  // The median already folds in whatever concurrency that run used, so it is
  // multiplied straight through — dividing by today's concurrency would count
  // the same parallelism twice.
  if (cadence !== null) return input.remaining * cadence
  return null
}

/** Below this the remaining time is not worth a number. */
export const ETA_ALMOST_DONE_SECONDS = 20

/**
 * The ETA as the customer reads it — an approximation, and visibly one.
 * A bare "3:47" invites people to hold us to it.
 */
export function formatEtaApprox(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < ETA_ALMOST_DONE_SECONDS) return 'almost done'
  if (seconds < 60) return `~${Math.round(seconds)} sec left`
  return `~${Math.max(1, Math.round(seconds / 60))} min left`
}

// ── 3. Freshness — when did something last actually happen ────────────────

function remoteState(remote: RemoteJobLike): string {
  return effectiveGenStudioTaskState(remote)
}

function isSettledRemote(remote: RemoteJobLike): boolean {
  const state = remoteState(remote)
  return state === 'not_created'
    || state === 'failed'
    || state === 'cancelled'
    || /success|succeed|complete|done|settled/.test(state)
}

/**
 * When work last visibly moved, in epoch ms, or null if it never has.
 *
 * Two independent clocks, whichever is more recent:
 *   • the last observed increase in `item_progress.completed` (our own
 *     sampling — a window of one sample is a first sighting, not a completion,
 *     so it does not count);
 *   • the newest `updated_at` among SETTLED remote items, which GenStudio's
 *     client rewrites as each item reaches its terminal state.
 *
 * Null rather than zero when there is nothing: a card must say nothing at all
 * rather than claim "0s ago" for a job that has never completed anything.
 */
export function lastProgressAt(
  window: readonly EtaSample[] | undefined,
  remoteJobs: readonly RemoteJobLike[] | null | undefined,
): number | null {
  let latest: number | null = null
  if (window && window.length >= 2) {
    latest = window[window.length - 1]!.at
  }
  for (const remote of remoteJobs || []) {
    if (!isSettledRemote(remote)) continue
    const at = millis(remote.updated_at)
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest
}

/** "40s ago" / "4 min ago" / "2h 5m ago" — the same unit grammar as the page. */
export function formatAgo(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
}

/** The whole line, or null when there is no measured progress to report. */
export function describeFreshness(lastAt: number | null, nowMs: number): string | null {
  if (lastAt === null) return null
  return `last progress: ${formatAgo(nowMs - lastAt)}`
}

/**
 * How many typical item-times may pass before a quiet job looks wrong.
 *
 * Dimensionless on purpose. The DURATION is never written down here — it is
 * this multiple times the cadence the job class has actually been measured at,
 * so a job type that takes four minutes an item and one that takes four
 * seconds get different thresholds without anyone maintaining a table.
 */
export const STALE_CADENCE_MULTIPLE = 3

/**
 * The gap after which quiet becomes abnormal, or null when this job class has
 * no measured cadence yet — in which case the card shows the plain elapsed
 * text with no colour, because we have nothing to call it late against.
 */
export function stalenessThresholdMs(
  cadenceSecondsPerItem: number | null,
  multiple: number = STALE_CADENCE_MULTIPLE,
): number | null {
  if (cadenceSecondsPerItem === null || !(cadenceSecondsPerItem > 0)) return null
  return cadenceSecondsPerItem * multiple * 1000
}

export function isProgressStale(
  lastAt: number | null,
  nowMs: number,
  cadenceSecondsPerItem: number | null,
): boolean {
  const threshold = stalenessThresholdMs(cadenceSecondsPerItem)
  if (lastAt === null || threshold === null) return false
  return nowMs - lastAt > threshold
}

// ── 4. Exceptions, one plain-words line each ──────────────────────────────

export interface JobExceptionLine {
  key: string
  text: string
}

/**
 * What a backoff says when the server sent no reason.
 *
 * Capacity-neutral on purpose: how much capacity exists, and how much of it is
 * busy, is internal. A customer is told there is demand, not how large the
 * thing serving them is.
 */
export const WAITING_FALLBACK_REASON = 'high demand right now'

export interface SettlementSummary {
  confirmed: boolean
  charged: number
  returned: number
  held: number
}

function settlementNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Published settlement must be complete and balanced before it is final. */
export function summariseSettlement(remotes: readonly RemoteJobLike[] | null | undefined): SettlementSummary {
  const items = remotes || []
  let confirmed = items.length > 0
  let charged = 0
  let returned = 0
  let held = 0
  for (const remote of items) {
    const reserved = settlementNumber(remote.reserved_credits)
    const settled = settlementNumber(remote.settled_credits)
    const released = settlementNumber(remote.released_credits)
    if (settled !== null) charged += settled
    if (released !== null) returned += released
    if (!isSettledRemote(remote) && reserved !== null && (settled ?? 0) === 0 && (released ?? 0) === 0) held += reserved
    if (!isSettledRemote(remote)
      || reserved === null || settled === null || released === null
      || settled + released !== reserved) confirmed = false
  }
  return { confirmed, charged, returned, held }
}

function secondsUntil(iso: string | undefined, nowMs: number): number | null {
  const at = millis(iso)
  return at === null ? null : Math.max(0, Math.round((at - nowMs) / 1000))
}

/**
 * One line per thing that went wrong, in the register the owner asked for:
 * what failed, what it cost, what happens next. No codes, no ids, no counts
 * standing in for the work — those all live in Technical details.
 *
 * Deliberately uncapped. A wall of per-scene lines for work that is going FINE
 * is what this redesign removes; a line per genuine exception is the thing it
 * adds, and truncating that would put the customer back to guessing.
 */
export function describeJobExceptions(
  job: JobLike | null | undefined,
  nowMs: number,
): JobExceptionLine[] {
  if (!job) return []
  const counts = summariseJobItems(job.item_progress)
  const waiting = (job.item_progress?.active || []).find(item => item.state === 'waiting_retry')
  const lines: JobExceptionLine[] = []
  if (waiting) {
    const seconds = secondsUntil(waiting.retry_at, nowMs)
    lines.push({ key: 'waiting-retry', text: seconds && seconds > 0
      ? `Retrying automatically in ${seconds}s — no action needed.`
      : 'Retrying automatically now — no action needed.' })
  } else if (counts.failed > 0) {
    const contentRefused = (job.genstudio_jobs || []).some(remote =>
      remoteState(remote) === 'failed' && remote.operation === 'image.generation' && remote.failure_code === 'IMAGE_CONTENT_REFUSED')
    const noun = String(job.type || '').includes('image')
      || contentRefused
      || job.genstudio_jobs?.some(remote => String(remote.operation || '').startsWith('image.'))
      ? 'image'
      : 'item'
    const plural = counts.failed === 1 ? noun : `${noun}s`
    const prefix = counts.finished > 0
      ? `${counts.finished.toLocaleString()} ${counts.finished === 1 ? noun : `${noun}s`} ${counts.finished === 1 ? 'is' : 'are'} ready. `
      : ''
    lines.push({
      key: 'output-gap',
      text: `${prefix}${counts.failed.toLocaleString()} ${plural} ${counts.failed === 1 ? 'needs' : 'need'} another try.`
        + (contentRefused ? ' Review the prompt before trying again.' : ''),
    })
  } else if (counts.remaining > 0 && (counts.queued > 0
      || (job.genstudio_jobs || []).some(remote => remoteState(remote) === 'waiting_account_capacity'))) {
    lines.push({ key: 'waiting-capacity', text: 'Waiting for capacity — Story Studio will continue automatically.' })
  } else if (counts.remaining > 0 && !counts.inFlight && !(job.genstudio_jobs || []).length) {
    lines.push({ key: 'waiting-start', text: 'Waiting to start.' })
  }
  const settlement = summariseSettlement(job.genstudio_jobs)
  if ((job.genstudio_jobs || []).length && !settlement.confirmed) {
    const returned = settlement.returned > 0 ? `${settlement.returned.toLocaleString()} credits returned so far. ` : ''
    lines.push({ key: 'credit-pending', text: `${returned}Credit outcome pending — Story Studio is checking GenStudio.` })
  }

  return lines
}

/** True only when there is a real exception to inspect. */
export function hasJobExceptions(job: JobLike | null | undefined, nowMs: number): boolean {
  return describeJobExceptions(job, nowMs).length > 0
}

// ── 5. Cancellation, said in work rather than in job states ───────────────

/**
 * The owner's own wording for a stop, with the real count substituted:
 * "Cancelling 16 queued items — credits for unstarted work are released."
 *
 * The count is the work that has NOT been submitted, because that is exactly
 * the work whose credits come back. Items already in flight are not promised.
 */
export function describeCancellation(job: JobLike | null | undefined): string {
  const counts = summariseJobItems(job?.item_progress)
  const queued = counts.queued || Math.max(0, counts.remaining - counts.inFlight)
  if (queued <= 0) {
    return 'Stopping this job — credits for unstarted work are released.'
  }
  return `Cancelling ${queued.toLocaleString()} queued item${queued === 1 ? '' : 's'}`
    + ' — credits for unstarted work are released.'
}
