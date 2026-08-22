/**
 * v1.4.32 — the decision behind "Retry all".
 *
 * WHY THIS IS A SEPARATE, PURE FILE. A combined "Repair & Retry all" button
 * existed once and was removed in v1.0.114 because it had a footgun: when the
 * repair half failed or timed out, the retry half fired anyway and resubmitted
 * work the provider had already done and already billed. Real duplicate TTS
 * charges came out of it. So the rule for the replacement is not "be careful"
 * — it is that a job is only ever resubmitted when its state is DEFINITELY
 * known, and "definitely known" is a decision that must be readable and
 * testable on its own, without mounting a page or spending a credit to observe
 * it.
 *
 * The owner's design, agreed 2026-08-22: two buttons he presses himself, never
 * an automatic chain. Repair all is free and already exists. Retry all is
 * always clickable and sorts what is failed into piles, refusing the pile it
 * cannot vouch for.
 */

/** The counts a repair reports, once both endpoint shapes are reconciled. */
export interface NormalisedRepairResult {
  recovered: number
  /** Items the provider could not supply. A retry is what fills these. */
  stillMissing: number
  totalExpected: number
}

/**
 * Both repair endpoints answer the same question and neither uses the same
 * words for it.
 *
 * `audio-repair` (sync) returns `{recovered, still_missing, total_expected}`
 * straight from audio-reconciler.ts.
 *
 * `images-repair` (queued) returns an `ImageReconcileResult`, which has NO
 * `still_missing` at all — it splits the same number into
 * `needs_fresh_generation` (a manifest entry exists but the provider has no
 * usable result) and `unrecoverable` (no manifest entry to poll). Both mean
 * exactly one thing to a person looking at the Jobs page: the file is not on
 * disk and only a fresh, paid generation will put it there.
 *
 * Until this function existed the Jobs page read `still_missing` and nothing
 * else, so for all three image job types it always found `undefined`, fell
 * through to a bare "✓ repaired" chip, and threw away the most useful number
 * the repair produced. That is not a Retry-all problem — it is a defect in the
 * Repair button that Retry-all merely could not have been built on top of.
 *
 * Returns `null` when the payload proves nothing. A null here means "do not
 * know", and a "do not know" must never be retried.
 */
export function normaliseRepairResult(raw: unknown): NormalisedRepairResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  const totalExpected = num(r.total_expected)
  const recovered = num(r.recovered)
  if (totalExpected === null || recovered === null) return null

  // Shape A — the audio reconciler says it outright.
  const direct = num(r.still_missing)
  if (direct !== null) return { recovered, stillMissing: direct, totalExpected }

  // Shape B — the image reconciler splits it in two. Either field alone is
  // enough: an episode can need fresh generation without anything being
  // unrecoverable, and vice versa.
  const needsFresh = num(r.needs_fresh_generation)
  const unrecoverable = num(r.unrecoverable)
  if (needsFresh !== null || unrecoverable !== null) {
    return { recovered, stillMissing: (needsFresh || 0) + (unrecoverable || 0), totalExpected }
  }

  // Some third shape nobody has seen. Deliberately not guessed at.
  return null
}

/** What a repair attempt left behind for a given job. */
export type RepairRecord =
  /** The repair ran and reported counts. The only state that licenses a retry. */
  | { outcome: 'measured'; result: NormalisedRepairResult }
  /** The repair ran but reported nothing usable — see `normaliseRepairResult`. */
  | { outcome: 'inconclusive' }
  /** The repair threw, timed out, or was refused. */
  | { outcome: 'failed' }

export interface TriageJob {
  job_id: string
  type: string
}

export type TriageBlockReason =
  | 'never_repaired'
  | 'repair_failed'
  | 'repair_inconclusive'

export interface BlockedJob<J extends TriageJob = TriageJob> {
  job: J
  reason: TriageBlockReason
}

export interface RetryAllTriage<J extends TriageJob = TriageJob> {
  /** Safe to resubmit now. */
  retry: J[]
  /** Repaired, and nothing is missing. There is nothing to buy — dismiss them. */
  alreadyComplete: J[]
  /** Not retried, and each says why. Offer Repair rather than guessing. */
  blocked: BlockedJob<J>[]
}

/**
 * Sort failed jobs into the three piles the owner approved.
 *
 * | pile | rule | why |
 * |---|---|---|
 * | retry | the type has no repair path at all | Repair could never have helped, and every generator already skips sections that completed, so a retry buys only what is missing. **32 of 36 job types are in here** — subtitles included, which is why a blanket "repair before you may retry" gate was rejected: it would have permanently blocked the very jobs he was trying to clear. |
 * | retry | repairable, repaired, `stillMissing > 0` | The provider was asked and does not have it. Definite. |
 * | alreadyComplete | repairable, repaired, `stillMissing === 0` | The files are on disk; the original failure was transient. Spending money here buys a duplicate. |
 * | blocked | repairable and never repaired, or the repair failed, or it reported nothing usable | This is the v1.0.114 bug's exact shape. "Might already be done" is not a state you resubmit from. |
 *
 * `canBeRepaired` and `repairRecord` are injected rather than imported so this
 * stays free of the page's `REPAIR_ENDPOINTS` map and its reactive refs, and
 * so a test can state a situation instead of building one.
 */
export function triageFailedJobsForRetryAll<J extends TriageJob>(
  failedJobs: readonly J[],
  canBeRepaired: (job: J) => boolean,
  repairRecord: (jobId: string) => RepairRecord | undefined,
): RetryAllTriage<J> {
  const retry: J[] = []
  const alreadyComplete: J[] = []
  const blocked: BlockedJob<J>[] = []

  for (const job of failedJobs) {
    if (!canBeRepaired(job)) {
      retry.push(job)
      continue
    }
    const record = repairRecord(job.job_id)
    if (!record) {
      blocked.push({ job, reason: 'never_repaired' })
      continue
    }
    if (record.outcome === 'failed') {
      blocked.push({ job, reason: 'repair_failed' })
      continue
    }
    if (record.outcome === 'inconclusive') {
      blocked.push({ job, reason: 'repair_inconclusive' })
      continue
    }
    if (record.result.stillMissing > 0) retry.push(job)
    else alreadyComplete.push(job)
  }

  return { retry, alreadyComplete, blocked }
}

/**
 * The sentence shown before anything is submitted. Written here rather than in
 * the template because "what is about to happen" is the part a confirmation
 * dialog gets wrong: a popup that says "Retry 14 jobs?" cannot tell the owner
 * which of those 14 were proved missing and which were merely never checked.
 * This can.
 */
export function describeRetryAllTriage(triage: RetryAllTriage): string {
  const parts: string[] = []
  if (triage.retry.length) parts.push(`Retrying ${triage.retry.length} job(s).`)
  if (triage.alreadyComplete.length) {
    parts.push(
      `${triage.alreadyComplete.length} already had everything on disk after a repair — `
      + 'nothing to buy, you can dismiss those.',
    )
  }
  if (triage.blocked.length) {
    const never = triage.blocked.filter(b => b.reason === 'never_repaired').length
    const failed = triage.blocked.filter(b => b.reason === 'repair_failed').length
    const unclear = triage.blocked.filter(b => b.reason === 'repair_inconclusive').length
    const why: string[] = []
    if (never) why.push(`${never} never repaired`)
    if (failed) why.push(`${failed} whose repair failed`)
    if (unclear) why.push(`${unclear} whose repair reported nothing usable`)
    parts.push(
      `Left alone: ${triage.blocked.length} (${why.join(', ')}). `
      + 'Your machines may already have finished these and you would pay a second time. Run Repair all first.',
    )
  }
  if (!parts.length) return 'Nothing failed that can be retried.'
  return parts.join(' ')
}
