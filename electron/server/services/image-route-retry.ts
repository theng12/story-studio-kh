/**
 * Automatic recovery from a GenStudio image route that would not take the
 * work *right now* — the image-modality counterpart to
 * `tts-capacity-retry.ts`.
 *
 * Bounded and jittered for the same reason: a 333-scene batch that all hit
 * `CLOUD_PROVIDER_EXHAUSTED` in the same second must not resend them all in
 * the same second, or it reproduces the exact stampede that produced the
 * refusal. Gated by the exact same `isGenStudioRouteExhausted` classifier —
 * retrying is only safe because that code proves no route accepted the
 * submission and the whole reservation was released.
 *
 * Kept as ITS OWN module rather than a re-export of the TTS constants
 * because the two modalities dispatch at very different widths. TTS follows
 * its selected model's published submit hint (or serialises when unknown —
 * see `resolveGenStudioTtsFanout`). Images legitimately fan out to
 * `resolveGenStudioLocalFanout`'s full account concurrency (up to 50 at
 * once) and that width is explicitly NOT being changed by this file. An
 * operator tuning one modality's retry pacing via its env var must not
 * silently move the other's.
 *
 * Retry IDENTITY is deliberately NOT reinvented here. Images already own a
 * deterministic identity chain for exactly this situation —
 * `resolveImageRetryScope` in `lib/manifest-recovery.ts`, which promotes a
 * request's scope from a terminal manifest entry the same way
 * `nextTtsRouteRetryIdentity` promotes a TTS chunk's (same principle: derived
 * from persisted state plus the failed job id, never a clock, a counter, or
 * randomness). `generators/images.ts` calls that directly for each retry
 * instead of forking a second identity scheme that would have to be kept in
 * sync with it forever.
 */

/**
 * Total attempts per image request, including the first. Matches the TTS
 * default (`TTS_ROUTE_RETRY_MAX_ATTEMPTS`) — there is no evidence the two
 * modalities need different bounds, only that they must be independently
 * tunable if that ever stops being true.
 */
export const IMAGE_ROUTE_RETRY_MAX_ATTEMPTS = 4

/** First wait, doubling per attempt. */
export const IMAGE_ROUTE_RETRY_BASE_MS = 15_000

/** Ceiling on a single wait, so the last retry is still spaced, not stalled. */
export const IMAGE_ROUTE_RETRY_MAX_DELAY_MS = 60_000

/** Test/operator override for the base wait. Ignored unless it parses above 0. */
export const IMAGE_ROUTE_RETRY_BASE_MS_ENV = 'STORY_STUDIO_IMAGE_RETRY_BASE_MS'

/**
 * How long to wait before attempt `attempt + 1`.
 *
 * Jittered by up to ±20% — up to `resolveGenStudioLocalFanout`'s full width
 * of scenes can fail against the same exhausted window at once, and an
 * unjittered schedule would send every one of them back in the same instant.
 */
export function imageRouteRetryDelayMs(
  attempt: number,
  env: NodeJS.ProcessEnv = process.env,
  random: () => number = Math.random,
): number {
  const configured = Math.floor(Number(env[IMAGE_ROUTE_RETRY_BASE_MS_ENV]))
  const base = Number.isFinite(configured) && configured > 0 ? configured : IMAGE_ROUTE_RETRY_BASE_MS
  const step = Math.max(0, Math.floor(attempt))
  const backoff = Math.min(base * 2 ** step, Math.max(base, IMAGE_ROUTE_RETRY_MAX_DELAY_MS))
  const jitter = backoff * 0.2 * (random() * 2 - 1)
  return Math.max(0, Math.round(backoff + jitter))
}
