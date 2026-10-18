/**
 * Keep the two job-time Gateway catalogues warm, off the job path.
 *
 * WHY. The TTS and chat catalogues are read when a job needs them, and a read
 * older than `CATALOG_FRESH_MS` triggers a live refresh *at that moment*. On the
 * overloaded production Mac mini those refreshes timed out (an 8-second ceiling
 * against a busy Gateway) and the stale-catalogue guard then refused paid work —
 * the catalogue's age became a generation outage. The refresh is free,
 * idempotent, and its result is good for five minutes, so there is no reason for
 * a job to be the thing that waits for it.
 *
 * WHAT IT IS NOT. Not an authority and not a cache of its own: it calls the same
 * `listTtsModelsSnapshot` / `listChatModelsSnapshot` readers every other caller
 * uses, so a catalogue can only ever be as fresh or as stale as those readers
 * say, and it never invents a row. A failure is logged and dropped — the next
 * tick, or the job that needs the catalogue, tries again.
 *
 * Overlap is impossible twice over: `cachedRemoteSnapshot` single-flights a
 * refresh per catalogue key, and the tick below refuses to start while its own
 * previous run is still going.
 */
import { getApiKey } from './app-secrets-store.js'
import { listChatModelsSnapshot, listTtsModelsSnapshot } from '../lib/genstudio-client.js'

/** The readers' own freshness window: refreshing more often than this would be a no-op. */
export const CATALOG_REFRESH_INTERVAL_MS = 5 * 60_000
/** Let boot settle before the first read; nothing is waiting on it. */
export const CATALOG_REFRESH_FIRST_DELAY_MS = 60_000

/** One pass over both job-time catalogues. Never throws: a failure is the caller's to log. */
export async function refreshGenStudioCatalogues(): Promise<void> {
  const apiKey = (await getApiKey('genstudio')).trim()
  if (!apiKey) return
  // Both, and neither can fail the other: an unreachable chat catalogue must not
  // stop the voice catalogue from being refreshed.
  await Promise.all([
    listTtsModelsSnapshot(apiKey).catch(() => undefined),
    listChatModelsSnapshot(apiKey).catch(() => undefined),
  ])
}

export function startGenStudioCatalogRefreshScheduler(log: (error: unknown) => void): void {
  let ticking = false
  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      await refreshGenStudioCatalogues()
    } finally {
      ticking = false
    }
  }
  const run = () => void tick().catch(log)
  setTimeout(run, CATALOG_REFRESH_FIRST_DELAY_MS).unref?.()
  setInterval(run, CATALOG_REFRESH_INTERVAL_MS).unref?.()
}
