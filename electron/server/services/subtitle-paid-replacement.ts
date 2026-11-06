/**
 * Fail-closed, deterministic eligibility for configured subtitle retries.
 * Submission remains outside this pure decision boundary so callers must
 * persist the returned commitment before any provider POST.
 */

export interface SubtitleReplacementAttempt {
  section: string
  originalTaskId: string
  originalIdempotencyKey: string
  inputHash: string
  outputPath: string
  replacementOrdinal: number
  idempotencyKey: string
  /**
   * Optional / legacy Gateway figures retained so old ledgers load safely.
   */
  quotedCredits?: number
  priceVersion?: string
  state: 'committed' | 'submitted' | 'succeeded' | 'failed' | 'blocked'
}

export type SubtitleReplacementDecision =
  | { action: 'blocked'; reason: string }
  | { action: 'commit'; attempt: SubtitleReplacementAttempt }

export interface SubtitleReplacementInput {
  enabled: boolean
  maxRetries?: number
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
  livePrice?: { credits: number; priceVersion: string } | null
}

/**
 * The job's own state answers "may this section be retried": a transient
 * failure the owner did not cancel.
 */
export function classifySubtitleFailure(failure: SubtitleReplacementInput['failure']): 'blocked' | 'retry' {
  return !failure.transient || failure.cancelled ? 'blocked' : 'retry'
}

export function decideSubtitleReplacement(input: SubtitleReplacementInput): SubtitleReplacementDecision {
  if (classifySubtitleFailure(input.failure) === 'blocked') {
    return { action: 'blocked', reason: 'the transcription failure is not an eligible transient failure' }
  }
  if (!input.enabled) return { action: 'blocked', reason: 'automatic subtitle retry is Off' }
  const maxRetries = Math.max(1, Math.min(10, input.maxRetries ?? 1))
  const sectionAttempts = input.attempts.filter(attempt => attempt.section === input.section)
  if (sectionAttempts.length >= maxRetries) {
    return { action: 'blocked', reason: `this section already reached the retry limit (${maxRetries})` }
  }
  const nextOrdinal = sectionAttempts.length + 1
  const identity = `${input.originalIdempotencyKey}:subtitle-replacement:${nextOrdinal}`
  return {
    action: 'commit',
    attempt: {
      section: input.section,
      originalTaskId: input.originalTaskId,
      originalIdempotencyKey: input.originalIdempotencyKey,
      inputHash: input.inputHash,
      outputPath: input.outputPath,
      replacementOrdinal: nextOrdinal,
      idempotencyKey: identity,
      ...(input.livePrice?.credits !== undefined ? { quotedCredits: input.livePrice.credits } : {}),
      ...(input.livePrice?.priceVersion ? { priceVersion: input.livePrice.priceVersion } : {}),
      state: 'committed',
    },
  }
}
