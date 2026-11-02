/**
 * useApiData — reactive stale-while-revalidate composable.
 *
 * Returns a reactive view of cached data that updates when the background
 * refresh lands. Pages that use this composable get instant data on return
 * and see an "Updating…" indicator while fresh data loads.
 *
 * The path should include project/episode identity for episode-scoped data,
 * so AGENTS.md section 4 (episode isolation) is enforced at the cache key
 * level — data from one episode cannot appear on another.
 *
 * Usage:
 *   const { data, refreshing, error, updatedAt } = useApiData<MyType>(
 *     () => `/projects/${slug}/episodes/${epId}/scenes`,
 *   )
 *
 * The path argument is a getter (not a raw string) so the cache key updates
 * reactively when route params change. The composable watches the path and
 * re-fetches when it changes, clearing old data from the previous context.
 */

import { ref, watch, onUnmounted, computed, type Ref, getCurrentInstance } from 'vue'
import { useApi } from './useApi'
import { swrGet, swrSubscribe, type CacheEntry } from '../utils/swrCache'

export interface UseApiDataReturn<T> {
  /** The data (stale-while-revalidate — shows cached value immediately). */
  data: Ref<T | null>
  /** True while a background refresh is in flight. */
  refreshing: Ref<boolean>
  /** Last refresh error, or null if the last refresh succeeded. */
  error: Ref<string | null>
  /** Unix ms when data was last successfully fetched, or null. */
  updatedAt: Ref<number | null>
  /** Manually trigger a refresh. */
  refresh: () => void
}

/**
 * Reactive SWR wrapper. Pass a function that returns the path (so route
 * params are captured reactively). Returns refs for data, refreshing state,
 * error, and last-updated timestamp.
 */
export function useApiData<T = any>(
  pathGetter: () => string | null | undefined,
): UseApiDataReturn<T> {
  const { get } = useApi()

  const data = ref<T | null>(null) as Ref<T | null>
  const refreshing = ref(false)
  const error = ref<string | null>(null)
  const updatedAt = ref<number | null>(null)

  // Track the current key so subscriptions don't deliver to a stale context.
  let currentKey: string | null = null
  let unsub: (() => void) | null = null

  // Generation counter: if the path changes while a fetch is in flight,
  // the old fetch's result is discarded when it lands.
  let fetchGeneration = 0

  async function doFetch(path: string, generation: number): Promise<void> {
    const key = `GET:${path}`

    // Unsubscribe from previous key's updates.
    if (unsub) { unsub(); unsub = null }
    currentKey = key

    // Subscribe to updates for this key.
    const sub = (entry: CacheEntry) => {
      if (currentKey !== key) return
      data.value = entry.value
      refreshing.value = entry.refreshing
      error.value = entry.error
      updatedAt.value = entry.updatedAt || null
    }
    unsub = swrSubscribe(key, sub)

    try {
      const result = await swrGet<T>(key, () => get<T>(path))
      // Only update if we're still the current generation (path hasn't changed).
      if (fetchGeneration === generation) {
        data.value = result
      }
    } catch (err: any) {
      if (fetchGeneration === generation) {
        error.value = err?.data?.detail || err?.message || 'Failed to load'
      }
    }
  }

  // Watch the path getter and re-fetch when it changes. Use computed() so
  // the path string is reactive (plain `let` variables don't trigger watch).
  const pathRef = computed(() => pathGetter())

  // Only register lifecycle hooks if we're inside a Vue component setup.
  // Outside setup (e.g. unit tests calling the function directly), the
  // watch still works but onUnmounted would warn.
  const hasInstance = !!getCurrentInstance()

  watch(pathRef, (newPath) => {
    fetchGeneration++
    if (!newPath) {
      data.value = null
      refreshing.value = false
      error.value = null
      updatedAt.value = null
      if (unsub) { unsub(); unsub = null }
      currentKey = null
      return
    }
    void doFetch(newPath, fetchGeneration)
  }, { immediate: true })

  function refresh(): void {
    const path = pathRef.value
    if (path) {
      fetchGeneration++
      void doFetch(path, fetchGeneration)
    }
  }

  if (hasInstance) {
    onUnmounted(() => {
      if (unsub) unsub()
      unsub = null
      currentKey = null
    })
  }

  return { data, refreshing, error, updatedAt, refresh }
}