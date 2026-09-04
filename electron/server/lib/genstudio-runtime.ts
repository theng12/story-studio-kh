/**
 * Story Studio may stage many independent asset requests, but GenStudio owns
 * remote admission, rate limits, and execution. Image placement uses explicit
 * admission permits; this module bounds only local worker fanout.
 */
/**
 * How many requests one job may have in flight at once.
 *
 * The account's `burst_concurrency_ceiling` is advisory local staging only.
 * GenStudio's exact image permits and central submission gate remain the
 * remote authority. Unknown capacity stays conservative: one worker until a
 * keyed live publication is available, never an invented wide wave.
 *
 * @param publishedCeiling the account's live `burst_concurrency_ceiling`.
 */
export function resolveGenStudioLocalFanout(
  itemCount: unknown,
  publishedCeiling?: unknown,
  ownerOverride?: unknown,
): number {
  const items = Math.max(1, Math.floor(Number(itemCount)) || 1)
  // An explicit setting wins in EITHER direction — lower to leave headroom,
  // higher to stage more than GenStudio will start (it queues the surplus).
  const override = Math.floor(Number(ownerOverride))
  if (Number.isFinite(override) && override >= 1) return Math.max(1, Math.min(items, override))
  const limit = typeof publishedCeiling === 'number'
    && Number.isInteger(publishedCeiling)
    && publishedCeiling > 0
    ? publishedCeiling
    : 1
  return Math.max(1, Math.min(items, limit))
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
 * @param accountBurstConcurrency the selected API key's live optional
 *                                `burst_concurrency_ceiling` advisory.
 */
export function resolveGenStudioTtsFanout(
  itemCount: unknown,
  providerSubmitConcurrency: unknown,
  accountBurstConcurrency?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const items = Math.max(1, Math.floor(Number(itemCount)) || 1)
  const override = Number(env[GENSTUDIO_TTS_CONCURRENCY_ENV])
  const providerHint = typeof providerSubmitConcurrency === 'number'
    && Number.isInteger(providerSubmitConcurrency)
    && providerSubmitConcurrency > 0
    ? providerSubmitConcurrency
    : undefined
  const accountBurst = typeof accountBurstConcurrency === 'number'
    && Number.isInteger(accountBurstConcurrency)
    && accountBurstConcurrency > 0
    ? accountBurstConcurrency
    : undefined
  const publishedLimit = providerHint === undefined
    ? accountBurst
    : accountBurst === undefined ? providerHint : Math.min(providerHint, accountBurst)
  const limit = Number.isInteger(override) && override > 0
    ? override
    : publishedLimit ?? GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT
  return Math.max(1, Math.min(items, limit))
}
