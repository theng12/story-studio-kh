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

/**
 * A model with no positive `provider_submit_concurrency` publication has an
 * unknown submit budget. Unknown is serial, never unlimited.
 */
export const GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT = 1

/**
 * Operator override for a paid tier with real submit headroom. Reads as an
 * env var rather than a setting because it describes the ACCOUNT's contract
 * with its voice provider, not a per-project preference — and because the
 * honest default (serialise) should need a deliberate act to leave.
 */
export const GENSTUDIO_TTS_CONCURRENCY_ENV = 'STORY_STUDIO_TTS_CONCURRENCY'

/**
 * How many TTS requests this run may have in flight at once.
 *
 * @param itemCount  requests staged by this run
 * @param providerSubmitConcurrency the selected model's live optional
 *                                  `provider_submit_concurrency` hint.
 */
export function resolveGenStudioTtsFanout(
  itemCount: unknown,
  providerSubmitConcurrency: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const items = Math.max(1, Math.floor(Number(itemCount)) || 1)
  const override = Number(env[GENSTUDIO_TTS_CONCURRENCY_ENV])
  const publishedHint = typeof providerSubmitConcurrency === 'number'
    && Number.isInteger(providerSubmitConcurrency)
    && providerSubmitConcurrency > 0
    ? providerSubmitConcurrency
    : GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT
  const limit = Number.isInteger(override) && override > 0
    ? Math.min(override, GENSTUDIO_LOCAL_ADMISSION_MAX)
    : Math.min(publishedHint, GENSTUDIO_LOCAL_ADMISSION_MAX)
  return Math.max(1, Math.min(items, limit))
}
