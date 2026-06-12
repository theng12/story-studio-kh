/**
 * ttl-cache.ts — tiny stale-while-revalidate TTL cache for provider probes.
 *
 * v1.0.337 — Why this exists: provider-list endpoints (/voicestudio/voices,
 * /voicestudio/models, /macos/voices, …) probe external endpoints on EVERY
 * dropdown open. On large projects the episode-status scan saturates the
 * libuv thread pool, those probes get slow or fail, and the UI renders an
 * empty dropdown ("missing providers"). Caching the last-good answer with a
 * short TTL means: (a) repeat opens are instant, (b) a probe failure serves
 * the last-known-good list instead of nothing.
 *
 * Semantics of swrFetch():
 *   - fresh cache hit            → return cached value, no loader call
 *   - miss / expired / refresh   → run loader
 *       - loader succeeds        → store + return
 *       - loader fails           → if ANY cached value exists (even expired),
 *                                   return it flagged stale; else rethrow
 *
 * Deliberately NOT used for per-project data (episode status has its own
 * mtime-aware cache) — this is for provider/world state that changes rarely
 * and where last-known-good beats an error.
 */

interface Entry<T> {
  value: T
  at: number
}

export class TtlCache<T = unknown> {
  private map = new Map<string, Entry<T>>()
  constructor(private ttlMs: number, private maxEntries = 50) {}

  /** Fresh value or undefined (expired entries stay for stale fallback). */
  get(key: string): T | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    return Date.now() - e.at <= this.ttlMs ? e.value : undefined
  }

  /** Any value regardless of age — the stale-fallback read. */
  getStale(key: string): T | undefined {
    return this.map.get(key)?.value
  }

  set(key: string, value: T): void {
    // Refresh insertion order so the eviction below is LRU-ish.
    this.map.delete(key)
    this.map.set(key, { value, at: Date.now() })
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  delete(key: string): void { this.map.delete(key) }
  clear(): void { this.map.clear() }
}

export interface SwrResult<T> {
  value: T
  /** True when served from cache (fresh hit) without calling the loader. */
  fromCache: boolean
  /** True when the loader FAILED and we fell back to an expired entry. */
  stale: boolean
}

/**
 * In-flight dedupe: concurrent swrFetch calls for the same key share one
 * loader promise instead of stampeding the upstream.
 */
const inflight = new Map<string, Promise<unknown>>()

export async function swrFetch<T>(
  cache: TtlCache<T>,
  key: string,
  loader: () => Promise<T>,
  opts: { forceRefresh?: boolean } = {},
): Promise<SwrResult<T>> {
  if (!opts.forceRefresh) {
    const fresh = cache.get(key)
    if (fresh !== undefined) return { value: fresh, fromCache: true, stale: false }
  }

  const inflightKey = `${key}` // cache instances are per-endpoint modules; key collision across caches is acceptable only if keys are namespaced by caller
  const existing = inflight.get(inflightKey) as Promise<T> | undefined
  if (existing && !opts.forceRefresh) {
    try {
      const value = await existing
      return { value, fromCache: true, stale: false }
    } catch {
      // fall through to stale handling below
    }
  }

  const p = loader()
  inflight.set(inflightKey, p as Promise<unknown>)
  try {
    const value = await p
    cache.set(key, value)
    return { value, fromCache: false, stale: false }
  } catch (e) {
    const stale = cache.getStale(key)
    if (stale !== undefined) return { value: stale, fromCache: true, stale: true }
    throw e
  } finally {
    if (inflight.get(inflightKey) === (p as Promise<unknown>)) inflight.delete(inflightKey)
  }
}
