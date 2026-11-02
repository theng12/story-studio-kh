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
 * The job's own state answers "may this section be bought again": a transient
 * failure the owner did not cancel. Whether anything was charged belongs to the
 * Gateway; Story keeps no settlement to compare it against.
 */
export function classifySubtitleFailure(failure: SubtitleReplacementInput['failure']): 'blocked' | 'paid' {
  return !failure.transient || failure.cancelled ? 'blocked' : 'paid'
}

export function decideSubtitleReplacement(input: SubtitleReplacementInput): SubtitleReplacementDecision {
  if (classifySubtitleFailure(input.failure) === 'blocked') {
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
