/**
 * Stale-while-revalidate (SWR) cache store.
 *
 * Every GET returns cached data immediately and starts a background refresh.
 * Callers get reactive updates when fresh data lands. Failed refreshes keep
 * old data but mark it with an error so nothing is silently shown as fresh.
 *
 * Keys are prefixed by the caller (typically `GET:/path`) so different
 * methods could coexist later. Keys include project/episode identity as the
 * caller supplies the full path — AGENTS.md section 4 (episode isolation) is
 * enforced at the store level: data from one episode cannot appear on
 * another because its key is different.
 *
 * Memory is bounded: LRU eviction by count and approximate bytes. Cleared
 * on sign-out and when connecting to a different server (see `swrClearAll`).
 */

import { ref, type Ref } from 'vue'

/** Cached entry with metadata for freshness display. */
export interface CacheEntry<T = any> {
  value: T | null
  /** Unix ms when this value was stored. 0 = no value yet. */
  updatedAt: number
  /** True while a background refresh is in flight. */
  refreshing: boolean
  /** Last refresh error (cleared on success). */
  error: string | null
  /** True if invalidated by mutation — next read must fetch fresh. */
  invalidated: boolean
}

/** Reactive view returned by swrReactive / used by useApiData. */
export interface ApiDataView<T = any> {
  data: Ref<T | null>
  refreshing: Ref<boolean>
  error: Ref<string | null>
  updatedAt: Ref<number | null>
}

/**
 * Paths that must never be cached. Auth probes, health, live streams,
 * file/media downloads. Callers passing `cache: 'no-store'` or `'reload'`
 * bypass the cache at the useApi layer before reaching swrGet.
 */
export function shouldSkipCache(path: string): boolean {
  if (path.startsWith('/auth/')) return true
  if (path.startsWith('/health')) return true
  // Job SSE streams and any other streaming endpoint.
  if (path.endsWith('/stream')) return true
  // Native file-picker shims — these aren't real network reads.
  if (path.startsWith('/system/pick-')) return true
  // File/media downloads — caching a download URL would silently re-download
  // on every mount. The never-cache list.
  if (/\/(?:download|media|blob|audio-preview|video-preview|file-read)(?:[?#/]|$)/.test(path)) return true
  return false
}

/** Approximate byte size of a value for LRU accounting. */
function estimateBytes(value: any): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return value.length * 2
  if (typeof value === 'number' || typeof value === 'boolean') return 8
  if (Array.isArray(value)) {
    let sum = 16
    for (const item of value) sum += estimateBytes(item)
    return sum
  }
  if (typeof value === 'object') {
    let sum = 32
    for (const key of Object.keys(value)) {
      sum += key.length * 2 + estimateBytes(value[key])
    }
    return sum
  }
  return 16
}

const MAX_ENTRIES = 200
const MAX_BYTES = 50 * 1024 * 1024 // 50 MB

type CacheRecord = {
  entry: CacheEntry
  reactive: {
    data: Ref<any>
    refreshing: Ref<boolean>
    error: Ref<string | null>
    updatedAt: Ref<number | null>
  }
  subscribers: Set<(entry: CacheEntry) => void>
  inflight: Promise<any> | null
  lastAccess: number
  bytes: number
}

const store = new Map<string, CacheRecord>()
let totalBytes = 0

/** Global aggregate: true while any entry is refreshing. */
const anyRefreshing = ref(false)
/** Global aggregate: current error entries (for the top-level indicator). */
const errorEntries = ref<Array<{ key: string; error: string }>>([])

function refreshAggregates(): void {
  let refreshing = false
  const errors: Array<{ key: string; error: string }> = []
  for (const [key, rec] of store) {
    if (rec.entry.refreshing) refreshing = true
    if (rec.entry.error) errors.push({ key, error: rec.entry.error })
  }
  anyRefreshing.value = refreshing
  errorEntries.value = errors
}

/** Evict oldest entries until under bounds. */
function evictIfNeeded(): void {
  while (store.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    let oldestKey: string | null = null
    let oldestAccess = Infinity
    for (const [key, rec] of store) {
      if (rec.lastAccess < oldestAccess) {
        oldestAccess = rec.lastAccess
        oldestKey = key
      }
    }
    if (!oldestKey) break
    const rec = store.get(oldestKey)!
    totalBytes -= rec.bytes
    store.delete(oldestKey)
  }
  if (store.size > 0) refreshAggregates()
}

/** Get or create a reactive record for a cache key. */
function getRecord<T>(key: string): CacheRecord {
  let rec = store.get(key)
  if (!rec) {
    const data = ref<T | null>(null)
    const refreshing = ref(false)
    const error = ref<string | null>(null)
    const updatedAt = ref<number | null>(null)
    rec = {
      entry: { value: null, updatedAt: 0, refreshing: false, error: null, invalidated: false },
      reactive: { data, refreshing, error, updatedAt },
      subscribers: new Set(),
      inflight: null,
      lastAccess: Date.now(),
      bytes: 0,
    }
    store.set(key, rec)
  }
  rec.lastAccess = Date.now()
  return rec
}

/** Update reactive refs from a cache entry and notify subscribers. */
function syncReactive(rec: CacheRecord, entry: CacheEntry): void {
  rec.entry = entry
  rec.reactive.data.value = entry.value
  rec.reactive.refreshing.value = entry.refreshing
  rec.reactive.error.value = entry.error
  rec.reactive.updatedAt.value = entry.updatedAt || null
  for (const sub of rec.subscribers) {
    try { sub(entry) } catch { /* subscriber error — don't break the cache */ }
  }
  refreshAggregates()
}

/**
 * Read from cache with stale-while-revalidate semantics.
 *
 * Returns the cached value at once (if any and not invalidated) and starts
 * one background refresh via `fetcher`. When the refresh lands, reactive
 * subscribers and swrReactive refs get the new value. In-flight requests
 * are shared: a second call while a refresh is running joins the same promise.
 *
 * When no cache exists or the entry is invalidated, the call must await
 * the fetch (there is nothing valid to show).
 */
export async function swrGet<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: { skipCache?: boolean },
): Promise<T> {
  if (options?.skipCache || shouldSkipCache(key)) {
    return fetcher()
  }

  const rec = getRecord<T>(key)

  // Already refreshing? Join the in-flight request.
  if (rec.inflight) return rec.inflight as Promise<T>

  const cached = rec.entry.value
  const hasCached = cached !== null && cached !== undefined
  const isInvalidated = rec.entry.invalidated

  // If invalidated or no cache, must await fresh fetch.
  if (!hasCached || isInvalidated) {
    syncReactive(rec, { ...rec.entry, refreshing: true, error: null, invalidated: false })
    // If a mutation lands while this fetch is in flight it sets
    // `rec.inflight = null`. Capture whether we are still the live one so
    // a pre-mutation response can never overwrite a post-mutation value —
    // the same guard the background branch already has.
    const isLive = () => rec.inflight === request

    const request = (async () => {
      try {
        const value = await fetcher()
        if (!isLive()) return value // superseded by a mutation mid-flight
        rec.bytes = estimateBytes(value)
        totalBytes += rec.bytes
        syncReactive(rec, {
          value,
          updatedAt: Date.now(),
          refreshing: false,
          error: null,
          invalidated: false,
        })
        evictIfNeeded()
        return value
      } catch (err: any) {
        syncReactive(rec, {
          ...rec.entry,
          refreshing: false,
          error: err?.data?.detail || err?.message || 'Failed to load',
        })
        throw err
      } finally {
        if (rec.inflight === request) rec.inflight = null
      }
    })()
    rec.inflight = request
    return request as Promise<T>
  }

  // Has cached value and not invalidated: return stale, refresh in background.
  syncReactive(rec, { ...rec.entry, refreshing: true, error: null })

  const background = (async () => {
    try {
      const freshValue = await fetcher()
      const newBytes = estimateBytes(freshValue)
      totalBytes = totalBytes - rec.bytes + newBytes
      rec.bytes = newBytes
      // Only repopulate if we're still the live refresh for this key
      // (invalidate may have fired mid-flight).
      if (rec.inflight === background) {
        syncReactive(rec, {
          value: freshValue,
          updatedAt: Date.now(),
          refreshing: false,
          error: null,
          invalidated: false,
        })
        evictIfNeeded()
      }
      return freshValue
    } catch (err: any) {
      if (rec.inflight === background) {
        // Keep the old value; mark it with the error so the UI shows
        // "Couldn't refresh: <why>" rather than silently fresh.
        syncReactive(rec, {
          ...rec.entry,
          refreshing: false,
          error: err?.data?.detail || err?.message || 'Failed to refresh',
        })
      }
      throw err
    } finally {
      if (rec.inflight === background) rec.inflight = null
    }
  })()
  rec.inflight = background
  // Fire-and-forget: the caller already got the stale value above.
  background.catch(() => { /* swallow — reactive error is enough */ })
  return cached as T
}

/**
 * Invalidate cache entries by exact key, prefix, or RegExp.
 *
 * Called after mutations and job/stream events. Matched entries are marked
 * invalidated so the next read fetches fresh; the reactive refs update
 * so any page showing the data knows to refetch.
 */
export function swrInvalidate(pattern: string | RegExp): void {
  let changed = false
  for (const [key, rec] of [...store]) {
    const matches = typeof pattern === 'string'
      ? (key === pattern || key.startsWith(pattern))
      : pattern.test(key)
    if (matches) {
      // Drop the in-flight promise as well as marking the value stale. The
      // request itself cannot be cancelled, but a reader that arrives after
      // the mutation must not be able to join it and be handed the
      // pre-mutation payload — this is the same guard the old TTL cache
      // had in `expireCacheKey`. The abandoned request still resolves; its
      // `.then` sees it is no longer the live one and writes nothing.
      rec.inflight = null
      syncReactive(rec, {
        ...rec.entry,
        invalidated: true,
        error: null,
      })
      changed = true
    }
  }
  if (changed) refreshAggregates()
}

/**
 * Clear entire cache. Called on sign-out and server change.
 *
 * `useApi` also keeps a small legacy TTL map for three long-lived paths
 * (project config / model catalogue / effective format). It registers a
 * clearer here rather than importing this module back the other way, so
 * the two files never form an import cycle.
 */
export function swrClearAll(): void {
  store.clear()
  totalBytes = 0
  refreshAggregates()
  legacyClearer?.()
}

let legacyClearer: (() => void) | null = null

/** Register a callback that clears any non-SWR cache state. */
export function setLegacyCacheClearer(fn: () => void): void {
  legacyClearer = fn
}

/** Subscribe to entry changes for a key. Returns unsubscribe function. */
export function swrSubscribe(
  key: string,
  callback: (entry: CacheEntry) => void,
): () => void {
  const rec = getRecord(key)
  rec.subscribers.add(callback)
  return () => {
    rec.subscribers.delete(callback)
    // Drop empty records with no value so the store doesn't grow from
    // transient subscribers.
    if (rec.subscribers.size === 0 && rec.entry.value === null && !rec.inflight) {
      totalBytes -= rec.bytes
      store.delete(key)
      refreshAggregates()
    }
  }
}

/** Get reactive view for a key (used by useApiData composable). */
export function swrReactive<T>(key: string): ApiDataView<T> {
  const rec = getRecord<T>(key)
  return {
    data: rec.reactive.data,
    refreshing: rec.reactive.refreshing,
    error: rec.reactive.error,
    updatedAt: rec.reactive.updatedAt,
  }
}

/** Read the global "any refreshing" flag. */
export function swrAnyRefreshing(): Ref<boolean> {
  return anyRefreshing
}

/** Read the current list of errored entries. */
export function swrErrors(): Ref<Array<{ key: string; error: string }>> {
  return errorEntries
}

/** Force-refresh a key by clearing its value; next read will fetch. */
export function swrForceRefresh(key: string): void {
  const rec = store.get(key)
  if (!rec) return
  // Same rule as invalidation: an abandoned in-flight request must not be
  // joinable, or a Retry would be handed the payload that already failed.
  rec.inflight = null
  syncReactive(rec, { ...rec.entry, invalidated: true, updatedAt: 0 })
}

/** For tests: reset internal state. */
export function _swrClearForTests(): void {
  store.clear()
  totalBytes = 0
  refreshAggregates()
}

/** For tests: get current store size. */
export function _swrStatsForTests(): { entries: number; bytes: number } {
  return { entries: store.size, bytes: totalBytes }
}

/** For tests: read a specific entry's current state. */
export function _swrPeekForTests(key: string): CacheEntry | null {
  const rec = store.get(key)
  return rec ? { ...rec.entry } : null
}