export const PERFORMANCE_CONCURRENCY_DEFAULT = 3
export const PERFORMANCE_CONCURRENCY_MIN = 1
export const PERFORMANCE_CONCURRENCY_MAX = 50

export const LAUNCH_STAGGER_DEFAULT_MS = 2_000
export const LAUNCH_STAGGER_MIN_MS = 0
export const LAUNCH_STAGGER_MAX_MS = 20_000

export function resolvePerformanceConcurrency(value: unknown): number {
  if (value == null || value === '') return PERFORMANCE_CONCURRENCY_DEFAULT
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return PERFORMANCE_CONCURRENCY_DEFAULT
  return Math.max(PERFORMANCE_CONCURRENCY_MIN, Math.min(PERFORMANCE_CONCURRENCY_MAX, parsed))
}

export type GenerationExecution = 'cloud' | 'local-direct' | 'local-hub'

/**
 * Performance sliders are provider safeguards, not local-fleet throttles.
 *
 * Cloud requests honour the saved cap. Local Direct requests use every
 * reachable model endpoint once, while local Hub requests keep one request in
 * flight per online Studio. The Hub may leave an item queued when an online Mac
 * lacks the selected model; that is intentional and lets the worker join the
 * same running workload as soon as its catalog reports the model ready.
 */
export function resolveGenerationConcurrency(
  configured: unknown,
  execution: GenerationExecution,
  itemCount: number,
  localCapacity = 1,
): number {
  const items = Math.max(1, Math.floor(Number(itemCount)) || 1)
  if (execution === 'cloud') {
    return Math.min(items, resolvePerformanceConcurrency(configured))
  }
  const capacity = Math.max(1, Math.floor(Number(localCapacity)) || 1)
  return Math.min(items, capacity)
}

export function resolveLaunchStaggerMs(value: unknown): number {
  if (value == null || value === '') return LAUNCH_STAGGER_DEFAULT_MS
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return LAUNCH_STAGGER_DEFAULT_MS
  return Math.max(LAUNCH_STAGGER_MIN_MS, Math.min(LAUNCH_STAGGER_MAX_MS, parsed))
}

/** Local Studio work starts immediately; only cloud providers need burst spacing. */
export function resolveGenerationLaunchStaggerMs(
  value: unknown,
  execution: GenerationExecution,
): number {
  return execution === 'cloud' ? resolveLaunchStaggerMs(value) : 0
}
