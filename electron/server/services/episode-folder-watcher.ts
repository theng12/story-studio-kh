/**
 * Per-project FS watcher that invalidates the episode-status cache when
 * files appear/disappear under a project's `episodes/` tree.
 *
 * Why this exists
 * ---------------
 * The episode-status cache invalidates via point-in-time mtime comparison
 * inside `cache.get()`. That works for changes the app itself makes, but
 * iCloud-Drive-delivered files can land *between* requests, leaving a
 * stale "no script" entry until the next request happens to re-stat.
 *
 * This watcher fires synchronously on file events (incl. iCloud Drive
 * deliveries — they go through the file-provider extension which emits
 * normal kernel FS events), parses the episode code from the path, and
 * invalidates the cache entry. The next /episodes call recomputes from
 * disk and the UI flips automatically — no user click, no waiting.
 *
 * Implementation notes
 * --------------------
 * - Uses Node's built-in `fs.watch` with `recursive: true` (macOS + Win;
 *   the Story Studio target platforms). Avoids adding chokidar.
 * - Watcher events are coarse — we don't care which subfolder changed,
 *   we just invalidate the whole episode entry. The cache's mtime check
 *   does the precise work on the next read.
 * - Per-episode coalescing (250ms) so an iCloud burst that drops 13
 *   files into `01 Script/` triggers one invalidation, not 13.
 * - Watchers are created lazily on first cache access for a slug; they
 *   stay alive for the life of the process. `.unref()` so a still-running
 *   watcher doesn't block app shutdown.
 */

import fs from 'fs'
import path from 'path'
import * as pm from './project-manager.js'

const COALESCE_MS = 250

/**
 * Cap on simultaneous active watchers. macOS uses FSEvents under the
 * hood for `fs.watch(recursive: true)`; FSEvents has a per-process
 * stream limit around 32 streams (silently coalesces beyond — events
 * just stop firing for some watchers, no error). We stay well under
 * with an LRU eviction strategy: opening a 26th project closes the
 * least-recently-used watcher. The episode-status cache still
 * recomputes from disk on demand, so the only effect of being evicted
 * is that the project loses proactive (push) invalidation; mtime
 * checks on the next `/episodes` call still catch any change.
 */
const MAX_WATCHERS = 25

type InvalidateFn = (slug: string, code: string) => void

interface WatcherState {
  watcher: fs.FSWatcher
  episodesDir: string
  pendingInvalidations: Map<string, NodeJS.Timeout>
  /**
   * When this watcher went live. The episode-status cache uses it as a
   * trust boundary: an entry confirmed against disk AFTER this moment
   * cannot have gone stale without this watcher firing, so the cache may
   * serve it without re-statting its watched folders. Cleared the moment
   * the watcher is closed, evicted, or errors — see `watcherTrustedSince`.
   */
  startedAt: number
  /** Set false on an 'error' event: events may have stopped arriving. */
  healthy: boolean
}

// Map iteration order is insertion order — we exploit that for LRU.
// `touchSlug` re-inserts on access so the oldest key is always the
// least-recently-used.
const watchers = new Map<string, WatcherState>()
/**
 * In-flight ensureProjectWatcher promises, keyed by slug. Without this,
 * two concurrent first-time `ensureProjectWatcher(slug)` calls both
 * pass the `watchers.has(slug)` sync check, both fs.watch the same
 * dir, and one of the FSWatcher handles is orphaned (never close()d).
 * The cache's hydrate path already dedupes via its own pending-map,
 * but the function is exported and could be called from anywhere.
 */
const ensurePending = new Map<string, Promise<void>>()
let onInvalidate: InvalidateFn | null = null

/**
 * ONE process-wide watcher on the Library's export root.
 *
 * Final videos live at `<library>/Exports/<slug>/Season NNN/<CODE> - <Title>/`,
 * outside the project's `episodes/` tree, and their appearance, replacement or
 * removal changes episode status (Video Assembly). The per-project watcher above
 * cannot see any of that, so the cache's trust boundary — "a confirmed entry
 * cannot go stale without an event" — did not hold for the export root, and a
 * Board verdict could stay wrong until an unrelated file in the project tree
 * moved (NEW-13). This watcher closes that hole: it parses `(slug, code)` out of
 * the path and invalidates the same entry the project watcher would have.
 *
 * Deliberately ONE stream for the whole process rather than one per project:
 * macOS FSEvents silently stops delivering beyond roughly 32 recursive streams,
 * so doubling every project's watcher would break the `MAX_WATCHERS` budget. It
 * is created on first cache access (when the export root exists), re-created if
 * the Library moves, and dropped if the root disappears — an unmounted volume
 * simply loses proactive invalidation, and the cache falls back to its mtime
 * check, which is slower but never stale.
 */
let exportsWatcher: fs.FSWatcher | null = null
let exportsWatcherRoot: string | null = null
const exportsPendingInvalidations = new Map<string, NodeJS.Timeout>()

/**
 * Wire the cache's invalidation hook. Called once at module load time
 * from `episode-status-cache.ts` to avoid a circular import.
 */
export function bindInvalidator(fn: InvalidateFn): void {
  onInvalidate = fn
}

/**
 * Start watching this project's `episodes/` tree if not already watching.
 * Idempotent. Failures (no `episodes/` dir, permission denied) are
 * swallowed — the cache will still work, just without proactive
 * invalidation.
 */
export async function ensureProjectWatcher(slug: string): Promise<void> {
  // Cheap and idempotent once running: the export root is part of episode
  // status, so it is watched whenever this project's tree is.
  await ensureExportsWatcher()
  if (watchers.has(slug)) {
    // Already-watching slugs become MRU on access so the LRU eviction
    // below kicks the right project when we hit the cap.
    touchSlug(slug)
    return
  }
  const inFlight = ensurePending.get(slug)
  if (inFlight) return inFlight

  const promise = startWatcherInner(slug)
  ensurePending.set(slug, promise)
  try {
    await promise
  } finally {
    ensurePending.delete(slug)
  }
}

/** Re-insert at the end of the Map so the oldest entry is always LRU. */
function touchSlug(slug: string): void {
  const state = watchers.get(slug)
  if (!state) return
  watchers.delete(slug)
  watchers.set(slug, state)
}

/** Evict the least-recently-used watcher to free a slot under the cap. */
function evictLRU(): void {
  const oldest = watchers.keys().next().value
  if (oldest === undefined) return
  stopProjectWatcher(oldest)
}

async function startWatcherInner(slug: string): Promise<void> {
  if (watchers.has(slug)) return

  // resolveEpisodePaths needs an episode code to compute its episode dir; we
  // just want the project's episodes root. That used to mean reading and
  // parsing project.json for an `output_root`; it is now the one shared
  // resolver, so this watcher can never watch a different folder from the one
  // the generators write into.
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return
  const episodesDir = pm.resolveOutputRoot(projectDir).path

  // Sanity: the dir must exist before we can watch it.
  try {
    const st = await fs.promises.stat(episodesDir)
    if (!st.isDirectory()) return
  } catch {
    return
  }

  // LRU eviction: free a slot if we're at the cap. Done here, AFTER
  // the dir exists, AFTER the readFile of project.json — failed starts
  // shouldn't punish a healthy old watcher.
  while (watchers.size >= MAX_WATCHERS) {
    evictLRU()
  }

  // 2026-10-07 — the stream covers the whole CHANNEL folder, not just
  // `episodes/`: a self-contained channel keeps its finals in
  // `<channel>/Exports/…`, which is part of episode status. One stream per
  // project (not two) keeps us inside the FSEvents budget described above;
  // events outside `episodes/` and `Exports/` (config.json, jobs.json, …) are
  // ignored below.
  const watchedTops = new Set([path.relative(projectDir, episodesDir).split(path.sep)[0], 'Exports'])
  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(projectDir, { recursive: true, persistent: false })
  } catch (e) {
    // recursive watch isn't supported on this platform, or some other
    // setup error. Bail silently — the cache is still correct, just
    // less reactive.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[episode-folder-watcher] failed to watch', slug, ':', (e as Error)?.message)
    }
    return
  }

  const state: WatcherState = {
    watcher,
    episodesDir,
    pendingInvalidations: new Map(),
    startedAt: Date.now(),
    healthy: true,
  }
  watchers.set(slug, state)

  // The 'change' handler receives both 'change' AND 'rename' eventTypes.
  // On macOS with recursive: true (FSEvents) every disk change comes
  // through this single event, so we don't need a separate 'rename'
  // listener. Wrap the body so a thrown handler can't kill the watcher
  // (some Node versions emit 'error' and detach on a synchronous throw).
  watcher.on('change', (_event, rawName) => {
    try {
      if (typeof rawName !== 'string' || !rawName) return
      if (!watchedTops.has(rawName.split(/[\\/]/)[0] || '')) return
      const code = extractEpisodeCode(rawName)
      if (!code) return
      scheduleInvalidate(state, slug, code)
    } catch (e) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[episode-folder-watcher] dispatch error', (e as Error)?.message)
      }
    }
  })
  watcher.on('error', (e) => {
    // An errored watcher may have stopped delivering events. Drop its trust
    // marker so the episode-status cache goes back to re-statting every
    // watched folder — slower, but never stale.
    state.healthy = false
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[episode-folder-watcher] error on', slug, ':', e?.message)
    }
  })

  // No further unref needed — `persistent: false` (passed to fs.watch
  // above) is the documented way to keep the watcher off the event loop
  // at shutdown. The previous _handle.unref() hack reached into Node
  // internals that change between releases.
}

/** Stop one project's watcher (e.g. project deleted). */
export function stopProjectWatcher(slug: string): void {
  const state = watchers.get(slug)
  if (!state) return
  for (const t of state.pendingInvalidations.values()) clearTimeout(t)
  state.pendingInvalidations.clear()
  try { state.watcher.close() } catch { /* ignore */ }
  watchers.delete(slug)
}

/** Stop all watchers — for graceful shutdown / tests. */
export function stopAllWatchers(): void {
  for (const slug of Array.from(watchers.keys())) stopProjectWatcher(slug)
  stopExportsWatcher()
}

/**
 * Coalesce per-episode invalidations. fs.watch fires once per file
 * event, so a 13-file iCloud burst produces 13 events for the same
 * episode. We want one invalidation.
 */
function scheduleInvalidate(state: WatcherState, slug: string, code: string): void {
  const existing = state.pendingInvalidations.get(code)
  if (existing) clearTimeout(existing)
  else if (onInvalidate) {
    // Leading edge: invalidate on the FIRST event of a burst, not only
    // COALESCE_MS after the last one. The cache may serve a watched entry
    // without re-statting it, so a quarter-second of "changed on disk but
    // not yet invalidated" would be a quarter-second of wrong status.
    // Invalidation is a map delete — doing it twice per burst costs nothing.
    onInvalidate(slug, code)
  }
  const t = setTimeout(() => {
    state.pendingInvalidations.delete(code)
    // Trailing edge: the burst has settled, so anything recomputed while it
    // was still landing gets dropped once more.
    if (onInvalidate) onInvalidate(slug, code)
  }, COALESCE_MS)
  if (typeof t.unref === 'function') t.unref()
  state.pendingInvalidations.set(code, t)
}

/**
 * Watch the Library's export root once per process. Failures are swallowed: a
 * missing (or unmounted) root means no proactive invalidation, never a broken
 * cache — the caller's mtime check still runs.
 */
async function ensureExportsWatcher(): Promise<void> {
  try {
    const { getExternalFinalVideoRoot } = await import('./external-video-store.js')
    const root = await getExternalFinalVideoRoot().catch(() => '')
    if (!root) return
    if (exportsWatcher && exportsWatcherRoot === root) return
    stopExportsWatcher()
    const st = await fs.promises.stat(root).catch(() => null)
    if (!st?.isDirectory()) return
    const watcher = fs.watch(root, { recursive: true, persistent: false })
    watcher.on('change', (_event, rawName) => {
      try {
        if (typeof rawName !== 'string' || !rawName) return
        const segments = rawName.split(/[\\/]/).filter(Boolean)
        const slug = segments[0]
        if (!slug) return
        const code = extractEpisodeCode(rawName)
        // An event with no episode folder in its path (a file dropped at the
        // season or slug level) cannot be attributed to one episode, so it is
        // ignored rather than guessing.
        if (!code) return
        scheduleExportsInvalidate(slug, code)
      } catch (e) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[episode-folder-watcher] export dispatch error', (e as Error)?.message)
        }
      }
    })
    watcher.on('error', () => {
      // Events may have stopped arriving; drop the watcher so the cache goes
      // back to re-statting rather than trusting a dead stream.
      stopExportsWatcher()
    })
    exportsWatcher = watcher
    exportsWatcherRoot = root
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[episode-folder-watcher] failed to watch the export root:', (e as Error)?.message)
    }
  }
}

/** Close the export-root watcher and any debounce it still holds. */
function stopExportsWatcher(): void {
  for (const t of exportsPendingInvalidations.values()) clearTimeout(t)
  exportsPendingInvalidations.clear()
  if (exportsWatcher) {
    try { exportsWatcher.close() } catch { /* ignore */ }
  }
  exportsWatcher = null
  exportsWatcherRoot = null
}

/** Coalesce export-root bursts the same way the per-project watcher does. */
function scheduleExportsInvalidate(slug: string, code: string): void {
  const key = `${slug}::${code}`
  if (exportsPendingInvalidations.has(key)) clearTimeout(exportsPendingInvalidations.get(key)!)
  else if (onInvalidate) onInvalidate(slug, code)
  const t = setTimeout(() => {
    exportsPendingInvalidations.delete(key)
    if (onInvalidate) onInvalidate(slug, code)
  }, COALESCE_MS)
  if (typeof t.unref === 'function') t.unref()
  exportsPendingInvalidations.set(key, t)
}

/**
 * Extract an episode code (e.g. "SS0057") from a path relative to the
 * episodes root. Folder layout is `Season XXX/<CODE> - <Title>/...`,
 * so the second path segment starts with the code followed by " - ".
 *
 * Returns null for events that don't map to a recognisable episode
 * folder (e.g. .DS_Store at the season level).
 */
function extractEpisodeCode(relPath: string): string | null {
  // Normalise separators just in case.
  const segs = relPath.split(/[\\/]/).filter(Boolean)
  // Walk segments looking for one that starts with `<CODE> - `. Resilient
  // to the tree being either Season-organised (`Season 003/SS0057 - ...`)
  // or flat (`SS0057 - ...`).
  for (const seg of segs) {
    const m = seg.match(/^([A-Z]{1,4}\d{3,5}) - /)
    if (m) return m[1]
  }
  return null
}

/**
 * The moment a healthy watcher for `slug` went live, or null when this
 * project has no trustworthy watcher (never started, unsupported platform,
 * evicted by the LRU cap, closed, or errored).
 *
 * The episode-status cache treats this as a trust boundary: a cache entry
 * last confirmed against disk at or after this timestamp cannot have gone
 * stale unnoticed, because any change would have produced an event here.
 * A null answer simply means "verify against disk yourself" — the caller's
 * fallback is the pre-existing mtime check, so a broken or missing watcher
 * degrades to the slower correct path, never to stale status.
 */
export function watcherTrustedSince(slug: string): number | null {
  const state = watchers.get(slug)
  if (!state || !state.healthy) return null
  return state.startedAt
}

/** Test diagnostics for the export-root watcher. */
export function _debugExportsWatcherRoot(): string | null {
  return exportsWatcherRoot
}

/** Test diagnostics. */
export function _debugListWatchers(): { slug: string, episodesDir: string }[] {
  return Array.from(watchers.entries()).map(([slug, s]) => ({ slug, episodesDir: s.episodesDir }))
}
