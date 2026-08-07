/**
 * Automatic recovery from an upstream voice provider that would not take the
 * work *right now*.
 *
 * `CLOUD_PROVIDER_EXHAUSTED` settles a GenStudio job `failed`, and a settled
 * GenStudio job can never be reopened — replaying its idempotency key returns
 * the same failure forever. So retrying it means submitting a NEW job, which
 * is only safe because that particular code proves no route ever accepted the
 * first one (see `isGenStudioRouteExhausted`). Nothing was done, nothing was
 * charged, and the reservation was released.
 *
 * The identity for the new job is therefore DERIVED, never minted fresh: the
 * same chapter failing against the same GenStudio job always produces the same
 * key. A retry can be replayed — after a crash, a lost response, a restart —
 * and GenStudio hands back the job it already has instead of selling a second
 * one. That is the whole reason this file hashes rather than counts.
 */

import { createHash } from 'crypto'

/**
 * Total attempts per request, including the first.
 *
 * Bounded because `CLOUD_PROVIDER_EXHAUSTED` cannot distinguish "the provider
 * is busy this minute" from "this provider account is out of credit" — both
 * reach GenStudio as a declined submission. Retrying the first is right;
 * retrying the second forever would hold an episode open against a wall. Three
 * spaced retries clear real rate limiting and give up on a wall in ~2 minutes.
 */
export const TTS_ROUTE_RETRY_MAX_ATTEMPTS = 4

/** First wait, doubling per attempt. Long enough to leave a per-minute window. */
export const TTS_ROUTE_RETRY_BASE_MS = 15_000

/** Ceiling on a single wait, so the last retry is still spaced, not stalled. */
export const TTS_ROUTE_RETRY_MAX_DELAY_MS = 60_000

/** Test/operator override for the base wait. Ignored unless it parses above 0. */
export const TTS_ROUTE_RETRY_BASE_MS_ENV = 'STORY_STUDIO_TTS_RETRY_BASE_MS'

/**
 * How long to wait before attempt `attempt + 1`.
 *
 * Jittered by up to ±20% because the sections of one episode fail against the
 * same provider window: an unjittered schedule would send them all back at the
 * same instant and reproduce the stampede the serial dispatch just removed.
 */
export function ttsRouteRetryDelayMs(
  attempt: number,
  env: NodeJS.ProcessEnv = process.env,
  random: () => number = Math.random,
): number {
  const configured = Math.floor(Number(env[TTS_ROUTE_RETRY_BASE_MS_ENV]))
  const base = Number.isFinite(configured) && configured > 0 ? configured : TTS_ROUTE_RETRY_BASE_MS
  const step = Math.max(0, Math.floor(attempt))
  const backoff = Math.min(base * 2 ** step, Math.max(base, TTS_ROUTE_RETRY_MAX_DELAY_MS))
  const jitter = backoff * 0.2 * (random() * 2 - 1)
  return Math.max(0, Math.round(backoff + jitter))
}

/**
 * The request identity for the next attempt.
 *
 * Derived from the identity that failed plus the GenStudio job it failed as,
 * so the whole chain is a pure function of what actually happened. Same
 * failures ⇒ same identity ⇒ same idempotency key ⇒ GenStudio replays instead
 * of charging. A clock or a counter here would break that, which is why
 * neither appears.
 */
export function nextTtsRouteRetryIdentity(currentIdentity: string, failedJobId: string): string {
  const token = createHash('sha256')
    .update(`${currentIdentity}\n${failedJobId}`)
    .digest('hex')
    .slice(0, 12)
  return `${currentIdentity}:route-retry:${token}`
}

/** Sleep that gives up the moment the run is cancelled. */
export function delayUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
