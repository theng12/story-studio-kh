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
  ceiling: number | null
  attempts: SubtitleReplacementAttempt[]
  section: string
  originalTaskId: string
  originalIdempotencyKey: string
  inputHash: string
  outputPath: string
  failure: {
    transient: boolean
    cancelled: boolean
    reservedCredits: number | null
    settledCredits: number | null
    releasedCredits: number | null
  }
  livePrice: { credits: number; priceVersion: string } | null
}

function completeSettlement(failure: SubtitleReplacementInput['failure']): boolean {
  return [failure.reservedCredits, failure.settledCredits, failure.releasedCredits]
    .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    && failure.settledCredits! + failure.releasedCredits! === failure.reservedCredits
}

export function classifySubtitleFailure(failure: SubtitleReplacementInput['failure']): 'blocked' | 'free-retry' | 'paid' {
  if (!failure.transient || failure.cancelled || !completeSettlement(failure)) {
    return 'blocked'
  }
  if (completeSettlement(failure)
    && failure.settledCredits === 0
    && failure.releasedCredits === failure.reservedCredits) {
    return 'free-retry'
  }
  return 'paid'
}

export function decideSubtitleReplacement(input: SubtitleReplacementInput): SubtitleReplacementDecision {
  const classification = classifySubtitleFailure(input.failure)
  if (classification === 'blocked') return { action: 'blocked', reason: 'the transcription failure is not an eligible settled transient failure' }
  if (classification === 'free-retry') return { action: 'free-retry', reason: 'The Gateway confirmed a fully released zero-settlement transcription failure.' }
  if (!input.enabled) return { action: 'blocked', reason: 'automatic paid subtitle replacement is Off' }
  const ceiling = input.ceiling
  if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling < 1) return { action: 'blocked', reason: 'the subtitle additional-credit ceiling is unavailable' }
  if (!input.livePrice || !Number.isFinite(input.livePrice.credits) || input.livePrice.credits < 0 || !input.livePrice.priceVersion.trim()) {
    return { action: 'blocked', reason: 'the current transcription price is unavailable' }
  }
  if (input.attempts.some(attempt => attempt.section === input.section)) {
    return { action: 'blocked', reason: 'this section already has a replacement attempt' }
  }
  const committed = input.attempts.reduce((sum, attempt) => sum + attempt.quotedCredits, 0)
  if (committed + input.livePrice.credits > ceiling) {
    return { action: 'blocked', reason: 'the replacement exceeds the shared subtitle additional-credit ceiling' }
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
