/**
 * Story Studio may stage many independent asset requests, but GenStudio owns
 * account admission, paid/relaxed concurrency, rate limits, and execution.
 * The shared GenStudio admission pool applies the live account limit before
 * any request reaches the service.
 */
export const GENSTUDIO_LOCAL_ADMISSION_MAX = 50

export function resolveGenStudioLocalFanout(itemCount: unknown): number {
  const items = Math.max(1, Math.floor(Number(itemCount)) || 1)
  return Math.min(items, GENSTUDIO_LOCAL_ADMISSION_MAX)
}
