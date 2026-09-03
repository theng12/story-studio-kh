/**
 * Story Studio may stage many independent asset requests, but GenStudio owns
 * remote admission, rate limits, and execution. Image placement uses explicit
 * admission permits; this module bounds only local worker fanout.
 */
/**
 * The fallback width, used ONLY when GenStudio has published no ceiling.
 *
 * It is no longer the normal cap. See `resolveGenStudioLocalFanout`.
 */
export const GENSTUDIO_LOCAL_ADMISSION_MAX = 50

/**
 * How many requests one job may have in flight at once.
 *
 * v1.4.40 — READ FROM THE ACCOUNT, NOT GUESSED.
 *
 * MEASURED 2026-08-23 on the owner's own batch. He asked whether his 41 fleet
 * machines were all working. They were not: one episode of 108 images was
 * running exactly 50 of them, GenStudio had NOTHING queued, and his account's
 * published burst ceiling was 128. The fleet was not full, the account was not
 * throttling, and nothing was waiting — Story Studio simply never offered more
 * than fifty, because fifty was written here.
 *
 * Staging more is safe by construction: GenStudio owns admission. It runs what
 * it can and queues the rest, so Story cannot flood it — it can only fail to
 * offer enough work, which is exactly what happened. The honest limit is
 * therefore what the ACCOUNT publishes, not a constant in this file.
 *
 * `burst_concurrency_ceiling` is the number GenStudio itself enforces, so a
 * fleet that grows raises this on its own with nothing to remember. The
 * constant survives only as the fallback for a catalogue that publishes no
 * ceiling — unknown stays conservative, never unlimited.
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
  const ceiling = Number(publishedCeiling)
  const limit = Number.isInteger(ceiling) && ceiling > 0
    ? ceiling
    : GENSTUDIO_LOCAL_ADMISSION_MAX
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
