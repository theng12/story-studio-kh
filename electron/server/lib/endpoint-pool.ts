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

export interface Dispatcher {
  /** Least-busy live endpoint (in-flight++), or null if all are down. */
  pick(): string | null
  /** Mark a previously picked endpoint as finished (in-flight--). */
  release(url: string): void
  /** Take an endpoint out of rotation for the rest of the batch. */
  markDown(url: string): void
  /** Endpoints still in rotation. */
  liveCount(): number
  /** Total endpoints. */
  size: number
}

/** Build a least-busy dispatcher over a fixed set of endpoints. */
export function createDispatcher(urls: string[]): Dispatcher {
  const inflight = new Map<string, number>()
  const down = new Set<string>()
  for (const u of urls) inflight.set(u, 0)
  const live = () => urls.filter(u => !down.has(u))
  return {
    size: urls.length,
    pick() {
      const candidates = live()
      if (!candidates.length) return null
      candidates.sort((a, b) => (inflight.get(a)! - inflight.get(b)!))
      const u = candidates[0]!
      inflight.set(u, (inflight.get(u) || 0) + 1)
      return u
    },
    release(u) { inflight.set(u, Math.max(0, (inflight.get(u) || 0) - 1)) },
    markDown(u) { down.add(u) },
    liveCount() { return live().length },
  }
}

/** A connection-level error (worth failing over to another endpoint) vs a
 *  content error (same prompt would fail anywhere — don't waste the pool). */
export function isConnectionError(e: any): boolean {
  const m = String(e?.message || e).toLowerCase()
  return /econnrefused|econnreset|enotfound|fetch failed|network|socket hang up|timed? ?out|timeout|502|503|504|refused|unreachable/.test(m)
}

/**
 * Run `fn(endpoint)` against the pool. Picks least-busy; on a CONNECTION error
 * marks that endpoint down and retries on another (up to the live count); a
 * content error is rethrown immediately. With no dispatcher (single endpoint /
 * cloud), just runs `fn(fallbackUrl)`.
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
      if (!isConnectionError(e)) throw e          // content error — no failover
      dispatcher.markDown(ep)
      lastErr = e
      if (dispatcher.liveCount() === 0) break
    }
  }
  throw lastErr
}
