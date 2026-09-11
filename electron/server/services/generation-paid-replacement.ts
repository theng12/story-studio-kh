import { createHash } from 'node:crypto'
import type { GenerationReplacementAttempt } from '../models/types.js'

export type ReplacementKind = 'audio' | 'writing'

/** A missing settlement is an outstanding hold, never free allowance. */
export function replacementAllowance(attempts: GenerationReplacementAttempt[], kind: ReplacementKind, ceiling: number): number {
  let used = 0
  for (const attempt of attempts.filter(item => item.kind === kind)) {
    if (!Number.isSafeInteger(attempt.max_credits) || attempt.max_credits < 0) return 0
    const charge = attempt.settled_credits ?? attempt.max_credits
    if (!Number.isSafeInteger(charge) || charge < 0 || charge > attempt.max_credits) return 0
    used += charge
  }
  return Number.isSafeInteger(ceiling) && ceiling > 0 && Number.isSafeInteger(used) ? Math.max(0, ceiling - used) : 0
}

export function mergeGenerationReplacementAttempts(previous: GenerationReplacementAttempt[] = [], incoming: GenerationReplacementAttempt[] = []): GenerationReplacementAttempt[] {
  const merged = new Map(previous.map(attempt => [attempt.idempotency_key, attempt]))
  for (const attempt of incoming) {
    const old = merged.get(attempt.idempotency_key)
    if (!old || attempt.revision > old.revision) merged.set(attempt.idempotency_key, attempt)
  }
  return [...merged.values()]
}

export function generationReplacementKey(kind: ReplacementKind, originalKey: string): string {
  return `story-${kind}-replacement-${createHash('sha256').update(originalKey).digest('hex')}`
}

export function balancedReplacementSettlement(job: {
  state: string; reserved_credits?: number | null; settled_credits?: number | null; released_credits?: number | null
}): number | null {
  const { reserved_credits: reserved, settled_credits: settled, released_credits: released } = job
  return ['failed', 'succeeded'].includes(job.state)
    && [reserved, settled, released].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    && settled! + released! === reserved ? settled! : null
}
