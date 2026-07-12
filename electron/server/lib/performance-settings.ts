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

export function resolveLaunchStaggerMs(value: unknown): number {
  if (value == null || value === '') return LAUNCH_STAGGER_DEFAULT_MS
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return LAUNCH_STAGGER_DEFAULT_MS
  return Math.max(LAUNCH_STAGGER_MIN_MS, Math.min(LAUNCH_STAGGER_MAX_MS, parsed))
}
