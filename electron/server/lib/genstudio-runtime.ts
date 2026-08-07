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
 * Speech is the one modality where Story Studio's fan-out is answered by a
 * SINGLE upstream account.
 *
 * GenStudio admission paces Story Studio against the GenStudio account. It
 * cannot pace GenStudio against the voice provider behind the product: a
 * cloned voice lives in exactly one provider workspace, so every section of an
 * episode contends for that one workspace's submit budget however many
 * GenStudio slots are free. Dispatching ten sections at once had six of them
 * rejected with `CLOUD_PROVIDER_EXHAUSTED` — the provider refusing to take ten
 * at a time, not refusing the work, since every rejected section succeeded on
 * its own afterwards.
 *
 * So the ceiling here is per upstream provider, and unknown means one. This is
 * deliberately NOT `resolveGenStudioLocalFanout`: images, video, transcription
 * and chat spread over many products and routes and keep the shared fan-out.
 */
export const GENSTUDIO_TTS_PROVIDER_DISPATCH_LIMITS: Readonly<Record<string, number>> = {
  /**
   * GenStudio's own fleet. Local speech has no upstream account meter to
   * exhaust — it is scheduled by the fleet itself — so a long run keeps the
   * shared fan-out rather than being paid for in wall-clock time.
   */
  'studio-hub-local': GENSTUDIO_LOCAL_ADMISSION_MAX,
}

/**
 * Every cloud voice provider meters submissions per account, and GenStudio
 * publishes `provider_id` only for the models that can speak a cloned voice —
 * exactly the models whose traffic all lands on one workspace. A model that
 * publishes no provider is therefore an UNKNOWN route, not a free one, and
 * unknown routes serialise: guessing wrong towards parallel breaks a ten
 * chapter run, guessing wrong towards serial only makes it slower.
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
 * @param providerId `TTSModelResponse.provider_id` for the selected model,
 *                   exactly as GenStudio published it. Empty/absent is the
 *                   normal shape for a model GenStudio does not attribute to a
 *                   route, and resolves to the serial default.
 */
export function resolveGenStudioTtsFanout(
  itemCount: unknown,
  providerId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const items = Math.max(1, Math.floor(Number(itemCount)) || 1)
  const override = Math.floor(Number(env[GENSTUDIO_TTS_CONCURRENCY_ENV]))
  const limit = Number.isFinite(override) && override > 0
    ? Math.min(override, GENSTUDIO_LOCAL_ADMISSION_MAX)
    : GENSTUDIO_TTS_PROVIDER_DISPATCH_LIMITS[String(providerId ?? '').trim()]
      ?? GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT
  return Math.max(1, Math.min(items, limit))
}
