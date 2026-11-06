import { createHash } from 'node:crypto'
import type { GenerationReplacementAttempt } from '../models/types.js'

export type ReplacementKind = 'audio' | 'writing'

export function mergeGenerationReplacementAttempts(previous: GenerationReplacementAttempt[] = [], incoming: GenerationReplacementAttempt[] = []): GenerationReplacementAttempt[] {
  const merged = new Map(previous.map(attempt => [attempt.idempotency_key, attempt]))
  for (const attempt of incoming) {
    const old = merged.get(attempt.idempotency_key)
    if (!old || attempt.revision > old.revision) merged.set(attempt.idempotency_key, attempt)
  }
  return [...merged.values()]
}

export function generationReplacementKey(kind: ReplacementKind, originalKey: string, ordinal = 1): string {
  const seed = ordinal > 1 ? `${originalKey}:retry:${ordinal}` : originalKey
  return `story-${kind}-replacement-${createHash('sha256').update(seed).digest('hex')}`
}
