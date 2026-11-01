/**
 * Fail-closed, deterministic eligibility for one paid subtitle replacement.
 * Submission remains outside this pure decision boundary so callers must
 * persist the returned commitment before any provider POST.
 */

export interface SubtitleReplacementAttempt {
  section: string
  originalTaskId: string
  originalIdempotencyKey: string
  inputHash: string
  outputPath: string
  replacementOrdinal: 1
  idempotencyKey: string
  /**
   * The Gateway's own figure for this request, recorded so a later read can
   * prove the quote it bought is still the quote it holds. It is a price the
   * Gateway published, never a budget Story keeps.
   */
  quotedCredits: number
  priceVersion: string
  state: 'committed' | 'submitted' | 'succeeded' | 'failed' | 'blocked'
}

export type SubtitleReplacementDecision =
  | { action: 'free-retry'; reason: string }
  | { action: 'blocked'; reason: string }
  | { action: 'commit'; attempt: SubtitleReplacementAttempt }

export interface SubtitleReplacementInput {
  enabled: boolean
  attempts: SubtitleReplacementAttempt[]
  section: string
  originalTaskId: string
  originalIdempotencyKey: string
  inputHash: string
  outputPath: string
  failure: {
    transient: boolean
    cancelled: boolean
  }
  livePrice: { credits: number; priceVersion: string } | null
}

/**
 * Both must go back to free first: a free/fleet or transient failure retries free exactly as before;
 * the paid lane is only the next step when the free retry is exhausted or the failure isn't free-retryable,
 * and only when its switch is on.
 */
export function classifySubtitleFailure(
  failure: SubtitleReplacementInput['failure'],
  state?: { freeRetriesExhausted?: boolean },
): 'blocked' | 'free-retry' | 'paid' {
  if (!failure.transient || failure.cancelled) return 'blocked'
  if (state?.freeRetriesExhausted) return 'paid'
  return 'free-retry'
}

export function decideSubtitleReplacement(input: SubtitleReplacementInput): SubtitleReplacementDecision {
  if (!input.failure.transient || input.failure.cancelled) {
    return { action: 'blocked', reason: 'the transcription failure is not an eligible transient failure' }
  }
  if (!input.enabled) return { action: 'blocked', reason: 'automatic paid subtitle replacement is Off' }
  if (!input.livePrice || !Number.isFinite(input.livePrice.credits) || input.livePrice.credits < 0 || !input.livePrice.priceVersion.trim()) {
    return { action: 'blocked', reason: 'the current transcription price is unavailable' }
  }
  if (input.attempts.some(attempt => attempt.section === input.section)) {
    return { action: 'blocked', reason: 'this section already has a replacement attempt' }
  }
  const identity = `${input.originalIdempotencyKey}:subtitle-replacement:1`
  return {
    action: 'commit',
    attempt: {
      section: input.section,
      originalTaskId: input.originalTaskId,
      originalIdempotencyKey: input.originalIdempotencyKey,
      inputHash: input.inputHash,
      outputPath: input.outputPath,
      replacementOrdinal: 1,
      idempotencyKey: identity,
      quotedCredits: input.livePrice.credits,
      priceVersion: input.livePrice.priceVersion,
      state: 'committed',
    },
  }
}
