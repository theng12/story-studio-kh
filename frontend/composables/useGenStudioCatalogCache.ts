/**
 * One shared caching policy for every GenStudio catalogue composable
 * (`useGenStudioImageModels`, `useGenStudioMediaModels`,
 * `useGenStudioAccess`, `useGenStudioTranscription`,
 * `useGenStudioModelDisplay`).
 *
 * Before this module existed, each composable hand-rolled its own
 * `loading`/`loaded` pair with no TTL: once a catalogue fetched
 * successfully it was treated as fresh for the remaining life of the
 * process, so a user could be shown (and could submit work against) a
 * snapshot that was hours old with no indication anything was stale.
 *
 * Policy, in one place:
 *  - FRESH_MS: a successful fetch is served straight from cache for this
 *    long — `refresh()` without `force` is a no-op.
 *  - STALE_CEILING_MS: past FRESH_MS but under this ceiling, cached data
 *    is STALE — still displayable (better than a blank screen) but
 *    `isUsable` flips false so callers that gate new submissions on
 *    freshness know not to trust it without a refresh.
 *  - Past STALE_CEILING_MS the data is EXPIRED. `isUsable` stays false
 *    and a failed refresh from this state clears the cache instead of
 *    continuing to show it, so nothing ancient is ever presented as
 *    current.
 *  - Concurrent callers coalesce: a `refresh()` call made while another
 *    is in flight returns the same in-flight promise instead of firing a
 *    second network request.
 *
 * Explicit `vue` imports (rather than relying on Nuxt auto-imports) so
 * this module — and anything built on it — stays directly unit-testable
 * from plain `node:test`, matching the existing convention used by
 * `useToast.ts` / `useProject.ts` / etc.
 */
import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue'

/** Cached data younger than this is fresh: `refresh()` is a no-op without `force`. */
export const GENSTUDIO_CATALOG_FRESH_MS = 5 * 60_000

/**
 * Cached data older than this is expired: it must not be presented as
 * usable for new submissions, and a failed refresh from this state
 * clears the cache rather than keep showing it.
 */
export const GENSTUDIO_CATALOG_STALE_CEILING_MS = 30 * 60_000

// A single shared "tick" so every cache's `isStale`/`isExpired` computed
// properties stay reactive (e.g. a badge flipping from "fresh" to "stale"
// while a settings page just sits open) without each cache instance running
// its own timer. The tick is purely a dependency to force Vue to
// re-evaluate — the actual age math below always reads `Date.now()` fresh,
// so any read is correct even between ticks (e.g. right after a fetch, or
// in a test that calls `_tickGenStudioCatalogClockForTests()` directly
// instead of waiting on the real interval).
const tick = ref(0)
let clockTimer: ReturnType<typeof setInterval> | null = null
function ensureClockRunning(): void {
  if (clockTimer || typeof window === 'undefined') return
  clockTimer = setInterval(() => { tick.value += 1 }, 15_000)
  // Never hold the process/test-runner open just to tick a staleness clock.
  clockTimer.unref?.()
}

/** Test-only: force every cache's staleness computeds to re-evaluate against the current clock, without waiting on the real 15s interval. */
export function _tickGenStudioCatalogClockForTests(): void {
  tick.value += 1
}

export interface GenStudioCatalogCacheOptions<T> {
  /** Value held before the first successful fetch, and after an
   *  unrecoverable failure (no usable cache left to fall back to). */
  empty: T
  /** Performs the network call and returns the parsed payload. Throwing
   *  is treated as a failed fetch — never resolve with a fabricated value. */
  fetcher: () => Promise<T>
  freshMs?: number
  staleCeilingMs?: number
}

export interface GenStudioCatalogCache<T> {
  data: Readonly<Ref<T>>
  loading: Readonly<Ref<boolean>>
  loaded: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  /** Epoch ms of the last successful fetch, or null if none has ever completed. */
  lastFetchedAt: Readonly<Ref<number | null>>
  /** Past the fresh window but still under the hard ceiling — displayable, not authoritative. */
  isStale: ComputedRef<boolean>
  /** Past the hard ceiling — must not be offered as usable for new submissions. */
  isExpired: ComputedRef<boolean>
  /** Loaded, not expired, and the last fetch (if any) didn't fail outright. */
  isUsable: ComputedRef<boolean>
  /**
   * Fetch when there is nothing usable cached yet, or when the cache has
   * gone stale. Concurrent calls coalesce onto one in-flight request.
   * Pass `force: true` to bypass the freshness check (e.g. an explicit
   * "Refresh" button) — concurrent calls still coalesce.
   */
  refresh(force?: boolean): Promise<void>
}

export function createGenStudioCatalogCache<T>(
  options: GenStudioCatalogCacheOptions<T>,
): GenStudioCatalogCache<T> {
  const freshMs = options.freshMs ?? GENSTUDIO_CATALOG_FRESH_MS
  const staleCeilingMs = options.staleCeilingMs ?? GENSTUDIO_CATALOG_STALE_CEILING_MS

  const data = ref(options.empty) as Ref<T>
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')
  const lastFetchedAt = ref<number | null>(null)
  let inflight: Promise<void> | null = null

  ensureClockRunning()

  const age = computed(() => {
    void tick.value // dependency only — forces periodic re-evaluation
    return lastFetchedAt.value === null ? Number.POSITIVE_INFINITY : Date.now() - lastFetchedAt.value
  })
  const isStale = computed(() => loaded.value && age.value > freshMs)
  const isExpired = computed(() => loaded.value && age.value > staleCeilingMs)
  const isUsable = computed(() => loaded.value && !isExpired.value && !error.value)

  async function refresh(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && loaded.value && !isStale.value) return
    loading.value = true
    inflight = (async () => {
      try {
        const result = await options.fetcher()
        data.value = result
        error.value = ''
        lastFetchedAt.value = Date.now()
        loaded.value = true
      } catch (cause: any) {
        error.value = cause?.data?.detail || cause?.message || 'GenStudio KH catalog unavailable'
        // A stale-but-still-under-ceiling cache is more useful than a blank
        // screen — keep it displayable. Past the ceiling (or if nothing ever
        // loaded) there is nothing trustworthy left, so clear to `empty`
        // rather than let expired data linger indefinitely.
        if (!loaded.value || isExpired.value) {
          data.value = options.empty
        }
        loaded.value = true
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  return {
    data: readonly(data) as Readonly<Ref<T>>,
    loading: readonly(loading),
    loaded: readonly(loaded),
    error: readonly(error),
    lastFetchedAt: readonly(lastFetchedAt),
    isStale,
    isExpired,
    isUsable,
    refresh,
  }
}
