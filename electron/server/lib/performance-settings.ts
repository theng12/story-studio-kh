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

/**
 * Voice Studio is serial per direct MLX endpoint, but Studio Hub owns a fleet
 * queue and must receive up to the user's configured workload concurrency.
 */
export function resolveVoiceStudioConcurrency(
  configured: unknown,
  routing: 'direct' | 'hub',
  directPoolSize: number,
): number {
  const base = resolvePerformanceConcurrency(configured)
  if (routing === 'hub') return base
  return Math.max(1, Math.min(base, Math.max(1, Math.floor(directPoolSize))))
}

export function resolveLaunchStaggerMs(value: unknown): number {
  if (value == null || value === '') return LAUNCH_STAGGER_DEFAULT_MS
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return LAUNCH_STAGGER_DEFAULT_MS
  return Math.max(LAUNCH_STAGGER_MIN_MS, Math.min(LAUNCH_STAGGER_MAX_MS, parsed))
}
