/**
 * The Library — the one place Story Studio keeps everything (v1.4.3).
 *
 * Module-scoped so the first-run gate, the home page and the Storage tab all
 * read the same answer. The status is fetched once and reused; `refresh()` is
 * the only way to re-read it, so a page cannot accidentally trigger a fetch per
 * render on a boot path that runs before anything else.
 */

import { ref } from 'vue'
import { useApi } from './useApi.js'

export interface LibraryStatus {
  /** Has a Library ever been chosen on this machine? False → first run. */
  configured: boolean
  path: string
  /** Is it there right now? False for an unplugged drive or a deleted folder. */
  exists: boolean
  writable: boolean
  /** What to pre-fill the first-run picker with. */
  suggested: string
  assets_dir: string
  exports_dir: string
}

const status = ref<LibraryStatus | null>(null)
const loading = ref(false)
let inFlight: Promise<LibraryStatus | null> | null = null

export function useLibrary() {
  const { get, post, put } = useApi()

  /**
   * Read the Library status, once. Concurrent callers share one request —
   * the boot gate and the page that follows it would otherwise both fire.
   */
  async function load(force = false): Promise<LibraryStatus | null> {
    if (status.value && !force) return status.value
    if (inFlight && !force) return inFlight
    loading.value = true
    inFlight = (async () => {
      try {
        status.value = await get<LibraryStatus>('/library')
        return status.value
      } catch {
        // Never throw at a boot gate: a backend that has not finished starting
        // must not strand the app on a blank screen. Null reads as "unknown",
        // and the gate lets the app through rather than trapping it.
        return null
      } finally {
        loading.value = false
        inFlight = null
      }
    })()
    return inFlight
  }

  /** Check a candidate without creating anything. */
  async function check(path: string) {
    return post<{ ok: boolean; path?: string; will_create?: boolean; reason?: string }>(
      '/library/check', { path },
    )
  }

  /** Adopt a Library for the first time. Creates the folder and its subfolders. */
  async function choose(path: string): Promise<LibraryStatus> {
    const next = await put<LibraryStatus>('/library', { path })
    status.value = next
    return next
  }

  return { status, loading, load, check, choose }
}
