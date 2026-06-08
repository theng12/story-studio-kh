/**
 * Shared local-modal endpoint pool (v1.0.255).
 *
 * Image Studio and Voice Studio both store their modal URL with the same
 * "URL-as-apiKey" pattern, and that setting may now hold SEVERAL base URLs
 * (one per Mac), comma/space separated. This module turns that string into a
 * health-checked pool and hands work out **least-busy** with **mid-batch
 * failover**, so:
 *   - a powered-off / unreachable Mac is skipped (never sent work),
 *   - a faster Mac naturally takes more (fewest in-flight wins),
 *   - a Mac that drops mid-run is marked down and its task retries elsewhere.
 *
 * Used by the image parallel renderer (continuity-render) and the audio
 * concurrency pool (generators/audio).
 */

/** Split the stored setting into clean base URLs. */
export function parseEndpoints(stored: string | null | undefined): string[] {
  return (stored || '')
    .split(/[\s,]+/)
    .map(u => u.replace(/\/+$/, '').trim())
    .filter(Boolean)
}

// ── Manually-disabled endpoints (v1.0.311) ──────────────────────────────────
// The user can switch an individual Mac OFF in Settings (e.g. a coworker's
// machine that's powered down on weekends, or one they need full CPU on). A
// disabled endpoint is filtered OUT of every dispatch + auto-probe path, so it
// is never health-checked and never sent work — no wasted probe time, no
// dipping into that machine's CPU. The state is persisted per-provider in
// app-settings (endpoint_disabled) and mirrored here in-memory so the hot,
// SYNCHRONOUS dispatcher/probe paths can filter without an async read.
//
// Keyed by full cleaned URL. Local providers use distinct fixed ports
// (LM Studio :1234, Image Studio :47868, Voice Studio :47870), so a URL is
// unambiguous across providers — the union below is safe and lets callers
// filter without threading a providerId through every call site.
const disabledByProvider: Record<string, Set<string>> = {}
let disabledUnion = new Set<string>()

function cleanEndpointKey(u: string): string {
  return (u || '').replace(/\/+$/, '').trim()
}
function rebuildDisabledUnion(): void {
  const next = new Set<string>()
  for (const set of Object.values(disabledByProvider)) for (const u of set) next.add(u)
  disabledUnion = next
}

/** Replace the disabled-URL set for one provider (called at boot + on toggle). */
export function setDisabledEndpoints(providerId: string, urls: string[]): void {
  disabledByProvider[providerId] = new Set((urls || []).map(cleanEndpointKey).filter(Boolean))
  rebuildDisabledUnion()
}

/** True when the URL has NOT been manually switched off. */
export function isEndpointEnabled(url: string): boolean {
  return !disabledUnion.has(cleanEndpointKey(url))
}

/**
 * Like parseEndpoints, but drops any endpoint the user has switched off in
 * Settings. Use this on every DISPATCH + auto-probe path so disabled Macs are
 * never contacted. The explicit "Test" button path keeps using parseEndpoints
 * so the user can still test a machine before re-enabling it.
 */
export function parseEnabledEndpoints(stored: string | null | undefined): string[] {
  const all = parseEndpoints(stored)
  if (disabledUnion.size === 0) return all
  return all.filter(u => !disabledUnion.has(cleanEndpointKey(u)))
}

/** Probe every URL concurrently; partition into online / offline. A probe that
 *  throws counts as offline. */
export async function healthyEndpoints(
  urls: string[],
  probe: (url: string) => Promise<boolean>,
): Promise<{ healthy: string[]; offline: string[] }> {
  const results = await Promise.all(urls.map(async (u) => {
    try { return { u, ok: await probe(u) } } catch { return { u, ok: false } }
  }))
  return {
    healthy: results.filter(r => r.ok).map(r => r.u),
    offline: results.filter(r => !r.ok).map(r => r.u),
  }
}

/**
 * v1.0.304 — how long a marked-down endpoint stays out of rotation before it
 * becomes eligible again. The dispatcher is module-scoped and long-lived for
 * LM Studio (see lmstudio-client.ts), so a PERMANENT down-state meant a Mac
 * that recovered after a transient blip (Wi-Fi drop, sleep/wake) stayed
 * excluded forever — the pool only ever shrank. With a TTL, a recovered
 * endpoint rejoins automatically; if it's still down, the next pick's
 * connection error (or pre-flight probe) re-marks it within seconds. 30s is
 * long enough to avoid hammering a genuinely-down Mac, short enough that a
 * recovered one comes back inside a single batch run.
 */
export const ENDPOINT_DOWN_TTL_MS = 30_000

export interface Dispatcher {
  /** Least-busy live endpoint (in-flight++), or null if all are down. */
  pick(): string | null
  /** Mark a previously picked endpoint as finished (in-flight--). */
  release(url: string): void
  /** Take an endpoint out of rotation for ENDPOINT_DOWN_TTL_MS (self-healing). */
  markDown(url: string): void
  /** Endpoints currently in rotation (down-state TTL respected). */
  liveCount(): number
  /** Total endpoints. */
  size: number
}

/** Build a least-busy dispatcher over a fixed set of endpoints. */
export function createDispatcher(urls: string[]): Dispatcher {
  const inflight = new Map<string, number>()
  // downUntil: epoch-ms after which the endpoint is eligible again. Absent =
  // never marked down. A self-healing TTL replaces the old permanent Set.
  const downUntil = new Map<string, number>()
  for (const u of urls) inflight.set(u, 0)
  const isDown = (u: string) => {
    const until = downUntil.get(u)
    return until !== undefined && until > Date.now()
  }
  const live = () => urls.filter(u => !isDown(u))
  return {
    size: urls.length,
    pick() {
      const candidates = live()
      if (!candidates.length) return null
      // v1.0.321 — random tie-break on equal in-flight counts. Without this,
      // JavaScript's stable sort always returned the FIRST endpoint in the
      // input list whenever the pool was idle (all in-flight = 0). A
      // single-chunk retry job that started with the first endpoint broken
      // would hit the same broken endpoint on every retry — the user's
      // EP0002 Chapter 04 case where 3 retries all landed on the same
      // glitched Mac. Randomising ties spreads single-chunk jobs naturally
      // across the pool; multi-chunk jobs still load-balance perfectly
      // because the in-flight counts diverge after the first pick.
      candidates.sort((a, b) => {
        const diff = inflight.get(a)! - inflight.get(b)!
        if (diff !== 0) return diff
        return Math.random() < 0.5 ? -1 : 1
      })
      const u = candidates[0]!
      inflight.set(u, (inflight.get(u) || 0) + 1)
      return u
    },
    release(u) { inflight.set(u, Math.max(0, (inflight.get(u) || 0) - 1)) },
    markDown(u) { downUntil.set(u, Date.now() + ENDPOINT_DOWN_TTL_MS) },
    liveCount() { return live().length },
  }
}

/** A connection-level error (worth failing over to another endpoint) vs a
 *  content error (same prompt would fail anywhere — don't waste the pool). */
export function isConnectionError(e: any): boolean {
  const m = String(e?.message || e).toLowerCase()
  // Kept in sync with the providers' own connection-error detection AND the
  // phrases they wrap failures in ("Can't reach …", "Connection error — failing
  // over …", "… is unreachable"). v1.0.304: added ehostunreach / etimedout /
  // eai_again / econnaborted + the wrapper phrases — previously EHOSTUNREACH
  // (a sleeping Tailscale Mac) got wrapped by the provider but slipped past this
  // matcher, so runOnPool never failed over.
  return /econnrefused|econnreset|econnaborted|enotfound|ehostunreach|etimedout|eai_again|fetch failed|network|socket hang up|timed? ?out|timeout|502|503|504|refused|unreachable|can'?t reach|cannot reach|connection error/.test(m)
}

/**
 * v1.0.318 — A per-endpoint capability error: the endpoint is alive and
 * reachable, but it can't serve THIS request right now because the model isn't
 * loaded / cached. Treat this like a connection error for pool purposes — fail
 * over to another endpoint, and mark this one down so the same job doesn't keep
 * hammering it. The standard 30 s self-healing TTL lets the endpoint re-enter
 * the pool once the user finishes the model download, so a paused job retried
 * later just works.
 *
 * Patterns: Voice Studio 409 "Model X is not fully cached. Download it from
 * the Models tab first." and LM Studio 404 / "No models loaded" /
 * "model_not_found" / "has no model … loaded" friendly wraps.
 *
 * Previously these threw outright on the first failing endpoint, even when
 * other endpoints in the same pool had the model loaded — the user's TN1611
 * Kokoro run had 5 Macs online, 2 with the model, 3 without; the 3 without
 * killed every chunk that landed on them instead of being skipped.
 */
export function isModelNotReadyError(e: any): boolean {
  const m = String(e?.message || e).toLowerCase()
  return /not fully cached|no models? loaded|model_not_found|has no model|model.*not.*loaded|not yet loaded|model is not ready|model not ready/.test(m)
}

/**
 * v1.0.320 — A per-endpoint INFERENCE failure: the endpoint is alive, the
 * model is loaded, the request even started running — but the modal failed
 * to produce output on THIS Mac. Different from "model not ready" (which is
 * about pre-flight cache state) because the error happens mid-generation.
 *
 * The user's TN0002 / EP0002 Kokoro run hit this on one of 5 online Macs:
 *
 *   Voice Studio job failed: RuntimeError: mlx-audio didn't produce a wav
 *   file. Temp dir: /var/folders/.../mlxaudio_kokoro-mlx_*
 *
 * The same chunk would have rendered fine on any of the other 4 Macs (the
 * code path is identical) — the failure is environmental: memory pressure,
 * an mlx-audio transient bug, MPS hiccup, anything that doesn't repeat on a
 * fresh attempt. Treating it as failover-class lets the chunk land on a
 * healthy Mac instead of failing the whole job for one Mac's glitch.
 *
 * Patterns deliberately narrow: only known "the inference didn't produce
 * output" phrasings, not a blanket "RuntimeError" match — a malformed prompt
 * or unsupported voice that genuinely fails everywhere should NOT spin
 * through every endpoint before failing. If a new phrasing shows up that we
 * want to catch, add it here.
 */
export function isInferenceFailureError(e: any): boolean {
  const m = String(e?.message || e).toLowerCase()
  return /didn't produce a wav|did not produce a wav|didn't produce.*output|produced no output|no audio produced|wav file not found|failed to generate audio|mlx-audio.*runtimeerror|runtimeerror.*mlx-audio/.test(m)
}

/** A connection error OR a per-endpoint capability error OR a per-endpoint
 *  inference glitch — all worth failing over to another endpoint in the pool.
 *  The dispatcher's 30 s self-healing TTL then lets the marked-down endpoint
 *  back in for the next chunk so a one-off glitch doesn't take it out for
 *  the whole job. */
export function isFailoverableError(e: any): boolean {
  return isConnectionError(e) || isModelNotReadyError(e) || isInferenceFailureError(e)
}

/**
 * Run `fn(endpoint)` against the pool. Picks least-busy; on a connection or
 * per-endpoint capability error (see isFailoverableError), marks that
 * endpoint down and retries on another (up to the live count); a true content
 * error (e.g. a malformed prompt) is rethrown immediately. With no dispatcher
 * (single endpoint / cloud), just runs `fn(fallbackUrl)`.
 */
export async function runOnPool<T>(
  dispatcher: Dispatcher | null,
  fallbackUrl: string,
  fn: (endpoint: string) => Promise<T>,
): Promise<T> {
  if (!dispatcher) return fn(fallbackUrl)
  let lastErr: any
  const maxTries = Math.max(1, dispatcher.size)
  for (let i = 0; i < maxTries; i++) {
    const ep = dispatcher.pick() ?? fallbackUrl
    try {
      const r = await fn(ep)
      dispatcher.release(ep)
      return r
    } catch (e) {
      dispatcher.release(ep)
      if (!isFailoverableError(e)) throw e         // true content error — no failover
      dispatcher.markDown(ep)
      lastErr = e
      if (dispatcher.liveCount() === 0) break
    }
  }
  throw lastErr
}
