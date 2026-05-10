/**
 * Episode-status cache with mtime-based invalidation.
 *
 * `computeEpisodeStatus()` does ~10–15 fs operations per episode. At 150+
 * episodes that's 1500+ fs ops per /projects/:slug/episodes request — every
 * single time the page is opened. This cache keeps a per-episode status
 * snapshot in memory; subsequent reads stat just the watched folders
 * (~10 stats) and serve cached if mtimes are unchanged.
 *
 * Invalidation surfaces:
 *   1. Implicit (mtime check on read) — catches every real change to disk,
 *      including writes from outside the app (Finder, sync conflicts).
 *   2. Explicit `invalidate(slug, code)` — fast path for known mutations
 *      (job completion, idea status flip). Optional; mtime check is the
 *      safety net.
 *
 * Bounds: in-memory LRU capped at MAX_ENTRIES; in-flight dedup ensures
 * concurrent gets for the same key share one compute promise (avoids
 * thundering-herd recompute).
 *
 * Phase 3 (separate file/PR): persisted manifest at
 *   ${project_root}/.cache/episode-status.json
 * with hydrate-on-demand and debounced flush. This module exposes
 * `_dumpProject(slug)` and `_hydrateProject(slug, entries)` hooks for that
 * layer to plug into without changes to the cache contract.
 */

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { computeEpisodeStatus, type EpisodeStatus } from './asset-status.js'
import { resolveEpisodePaths } from './utils.js'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'
import { bindInvalidator, ensureProjectWatcher } from './episode-folder-watcher.js'

export const SCHEMA_VERSION = 1 as const
const MAX_ENTRIES = 1000

// Phase 3 — persistence
const FLUSH_DEBOUNCE_MS = 5000
const CACHE_FILENAME = 'episode-status.json'

/**
 * Per-project disk cache file path: <userData>/cache/<slug>/episode-status.json
 *
 * Lives in userData (per-machine) — NOT inside the project folder. The
 * project folder may be in iCloud Drive, in which case anything inside
 * it gets synced across machines. Cache state is per-machine (folder
 * mtimes are inherently local), so synced cache files would clobber
 * each other and produce iCloud "(Conflicted copy)" files.
 */
function diskCachePath(slug: string): string {
  return path.join(pm.getUserDataDir(), 'cache', slug, CACHE_FILENAME)
}

/**
 * Legacy cache path that older builds wrote to: <projectDir>/.cache/episode-status.json.
 * Delete on hydrate so the file (which iCloud is currently syncing
 * across machines) stops bouncing. Best-effort — failure to delete is
 * harmless, the file just continues to occupy a few hundred KB.
 */
function legacyDiskCachePath(slug: string): string {
  const dir = pm.getProjectDir(slug) || path.join(pm.PROJECTS_ROOT, slug)
  return path.join(dir, '.cache', CACHE_FILENAME)
}

interface DiskCacheFile {
  schemaVersion: typeof SCHEMA_VERSION
  slug: string
  writtenAt: number
  /** os.hostname() at write time. Diagnostic only — no behaviour depends on it. */
  writtenBy?: string
  entries: EpisodeStatusCacheEntry[]
}

/** Folder path → mtimeMs at compute time. Empty if folder didn't exist. */
type FolderMtimes = Record<string, number>

export interface EpisodeStatusCacheEntry {
  slug: string
  episode_code: string
  status: EpisodeStatus
  computedAt: number
  /**
   * Folders whose contents affect status. Re-statted on every read; if any
   * mtime advanced (or a folder appeared/disappeared), the entry is stale.
   * Stored as a flat record so JSON-persistable as-is in Phase 3.
   */
  watchedMtimes: FolderMtimes
  schemaVersion: typeof SCHEMA_VERSION
}

interface CacheStats {
  hits: number
  staleRecomputes: number
  misses: number
  inflightDedups: number
  invalidations: number
  diskHydrates: number
  diskFlushes: number
  size: number
  inflight: number
}

function cacheKey(slug: string, code: string): string {
  return `${slug}::${code.toUpperCase()}`
}

/**
 * Resolve the list of folders whose mtimes determine episode status.
 * Cheap: one project.json read inside resolveEpisodePaths.
 *
 * Title comes from the ideas list — needed because folder_template usually
 * contains "{title}", so the wrong title means we'd watch a non-existent
 * path and never see real changes. If `ideas` isn't passed, load it once
 * here (same fallback as computeEpisodeStatus). Single-episode callers
 * pay one extra ideas.json read; batch callers (the route) pass ideas to
 * avoid even that.
 */
async function resolveWatchedFolders(slug: string, code: string, ideas?: Awaited<ReturnType<typeof im.getIdeas>>): Promise<string[]> {
  let title = ''
  let resolvedIdeas = ideas
  if (!resolvedIdeas) {
    try {
      resolvedIdeas = await im.getIdeas(slug, 'accepted')
    } catch {
      return []
    }
  }
  const CODE = code.toUpperCase()
  const idea = resolvedIdeas.find(i => (i.episode_code || '').toUpperCase() === CODE)
  title = idea?.title || ''

  let paths: Awaited<ReturnType<typeof resolveEpisodePaths>>
  try {
    paths = await resolveEpisodePaths(slug, code, title)
  } catch {
    return []
  }

  // All folders that could affect any status field.
  return [
    paths.episode_dir,        // sibling-folder detection for video_assembly
    paths.script_dir,         // script + introduction
    paths.scene_prompts_dir,  // scene_prompts (and bg_dir image counts via docx mtime)
    paths.thumb_prompts_dir,  // thumb_prompts
    paths.metadata_dir,       // metadata
    paths.bg_dir,             // images
    paths.thumb_dir,          // thumbnails
    paths.audio_dir,          // audio
    paths.merged_audio_dir,   // merged_audio
    paths.video_dir,          // video + video_assembly
  ]
}

/**
 * Stat each folder and return its mtimeMs. Missing folders are simply
 * absent from the result — that absence is itself part of the snapshot,
 * because if a folder later appears, the snapshots won't match.
 */
async function snapshotMtimes(folders: string[]): Promise<FolderMtimes> {
  const result: FolderMtimes = {}
  await Promise.all(
    folders.map(async (p) => {
      try {
        const st = await fs.stat(p)
        result[p] = st.mtimeMs
      } catch {
        // Folder missing — record absence by NOT setting the key. If it
        // later exists, the comparison will see a new key and mark stale.
      }
    }),
  )
  return result
}

/**
 * Compare two folder-mtime snapshots. Returns true iff they describe the
 * exact same set of folders with identical mtimes.
 */
function mtimesUnchanged(prev: FolderMtimes, next: FolderMtimes): boolean {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  if (prevKeys.length !== nextKeys.length) return false
  for (const k of prevKeys) {
    if (!(k in next)) return false
    if (prev[k] !== next[k]) return false
  }
  return true
}

class EpisodeStatusCache {
  private entries = new Map<string, EpisodeStatusCacheEntry>()
  private inflight = new Map<string, Promise<EpisodeStatus>>()
  /** Projects whose disk cache we've already attempted to hydrate this session. */
  private hydrated = new Set<string>()
  /**
   * In-flight hydrate promises, keyed by slug. Concurrent first-time gets
   * for the same project share the same promise — without this, 8 parallel
   * route workers would each pass the "not hydrated yet" check, each kick
   * off a redundant disk read, and each see an empty cache → 8 wasted
   * recomputes before the first set() lands.
   */
  private hydratePending = new Map<string, Promise<void>>()
  /** Per-project debounce timer for flushing to disk. */
  private flushTimers = new Map<string, NodeJS.Timeout>()
  private stats = {
    hits: 0,
    staleRecomputes: 0,
    misses: 0,
    inflightDedups: 0,
    invalidations: 0,
    diskHydrates: 0,
    diskFlushes: 0,
  }

  /**
   * Read or compute status for one episode.
   *
   * Pass `ideas` (the project's accepted-ideas array) when calling in a
   * batch — saves a per-episode ideas.json read inside computeEpisodeStatus
   * AND inside resolveWatchedFolders.
   */
  async get(slug: string, code: string, ideas?: Awaited<ReturnType<typeof im.getIdeas>>): Promise<EpisodeStatus> {
    const k = cacheKey(slug, code)

    // Lazy hydrate from disk on first access for a project. Cheap miss
    // (one fs.read) on first call per project per process; no-op afterwards.
    // Each loaded entry still goes through mtime validation below — disk
    // values are only hints.
    await this.hydrateProjectIfNeeded(slug)

    // In-flight dedup — multiple concurrent gets share one compute.
    const pending = this.inflight.get(k)
    if (pending) {
      this.stats.inflightDedups++
      return pending
    }

    const entry = this.entries.get(k)
    if (entry) {
      const folders = Object.keys(entry.watchedMtimes)
      const current = await snapshotMtimes(folders)
      if (mtimesUnchanged(entry.watchedMtimes, current)) {
        // HIT — touch to update LRU recency.
        this.touch(k, entry)
        this.stats.hits++
        return entry.status
      }
      // STALE — fall through to recompute.
      this.stats.staleRecomputes++
    } else {
      this.stats.misses++
    }

    return this.computeAndStore(slug, code, ideas)
  }

  private computeAndStore(slug: string, code: string, ideas?: Awaited<ReturnType<typeof im.getIdeas>>): Promise<EpisodeStatus> {
    const k = cacheKey(slug, code)

    // Snapshot the dedup promise so concurrent callers don't both compute.
    const promise = (async () => {
      // Resolve the watched folder list FIRST — we need it to take the
      // mtime snapshot before computeEpisodeStatus reads them. (If we
      // snapshot after, a write that lands during compute would be missed
      // until the NEXT read; better to snapshot first and accept that a
      // write during compute means the next read will see STALE — correct.)
      const folders = await resolveWatchedFolders(slug, code, ideas)
      const watchedMtimes = await snapshotMtimes(folders)

      const status = await computeEpisodeStatus(slug, code, ideas)

      const entry: EpisodeStatusCacheEntry = {
        slug,
        episode_code: code.toUpperCase(),
        status,
        computedAt: Date.now(),
        watchedMtimes,
        schemaVersion: SCHEMA_VERSION,
      }
      // Cache-poisoning guard: if we couldn't resolve watched folders
      // (resolveEpisodePaths threw — typically a transient project.json
      // read failure), `folders` is empty AND watchedMtimes is empty.
      // mtimesUnchanged then returns true on every subsequent read with
      // the same empty result, which means the bad status sticks FOREVER
      // (until the user hard-rescans). Refusing to cache when resolution
      // failed forces a recompute next read — recompute is cheap (~10 fs
      // ops), and on the retry we usually get real folders + correct
      // status.
      //
      // Note: gating on `folders.length`, NOT `watchedMtimes` size — a
      // newly-accepted episode whose subfolders don't exist on disk yet
      // resolves to a non-empty folder list (resolveEpisodePaths just
      // computes paths from the template; doesn't require them to exist)
      // but produces an empty mtimes snapshot. Caching THAT is correct
      // — when the folders eventually appear, the new keys in mtimes will
      // not match the empty snapshot and the cache will correctly stale.
      if (folders.length > 0) {
        this.set(k, entry)
        this.scheduleFlush(slug)
      }
      return status
    })()

    this.inflight.set(k, promise)
    promise.finally(() => {
      // Clear inflight only if it's still our promise (guards against
      // races with explicit invalidation that started a fresh compute).
      if (this.inflight.get(k) === promise) this.inflight.delete(k)
    })
    return promise
  }

  /** Drop a single episode's cached status. Next read recomputes. */
  invalidate(slug: string, code: string): void {
    const k = cacheKey(slug, code)
    if (this.entries.delete(k)) {
      this.stats.invalidations++
      this.scheduleFlush(slug)
    }
  }

  /** Drop all entries for a project. Used when the project's ideas list changes. */
  invalidateProject(slug: string): void {
    const prefix = `${slug}::`
    let dropped = false
    for (const k of this.entries.keys()) {
      if (k.startsWith(prefix)) {
        this.entries.delete(k)
        this.stats.invalidations++
        dropped = true
      }
    }
    if (dropped) this.scheduleFlush(slug)
  }

  /**
   * Hard reset for one project: drop in-memory entries, delete the on-disk
   * cache file, and reset hydration so the next access starts fresh.
   *
   * Used by the "Rescan from disk" UI action — when the user wants to
   * force a full readdir of every episode folder (e.g. an iCloud sync
   * arrived and they don't want to wait for the watcher / mtime check
   * to notice).
   */
  async wipeProject(slug: string): Promise<void> {
    this.invalidateProject(slug)
    this.hydrated.delete(slug)
    const t = this.flushTimers.get(slug)
    if (t) { clearTimeout(t); this.flushTimers.delete(slug) }
    const filePath = diskCachePath(slug)
    try {
      await withLock(filePath, async () => {
        await fs.rm(filePath, { force: true })
      })
    } catch { /* best-effort */ }
  }

  /** Test/diagnostics — wipe everything. Does NOT touch disk caches. */
  clear(): void {
    this.entries.clear()
    this.inflight.clear()
    this.hydrated.clear()
    this.hydratePending.clear()
    for (const t of this.flushTimers.values()) clearTimeout(t)
    this.flushTimers.clear()
    this.stats = { hits: 0, staleRecomputes: 0, misses: 0, inflightDedups: 0, invalidations: 0, diskHydrates: 0, diskFlushes: 0 }
  }

  /**
   * Lazily load a project's persisted cache file the first time it's
   * accessed in this process. Concurrent callers share one in-flight
   * promise — see hydratePending. Failures (missing file, parse error,
   * schema mismatch) silently fall through — the in-memory cache will
   * recompute on demand.
   */
  private hydrateProjectIfNeeded(slug: string): Promise<void> {
    if (this.hydrated.has(slug)) return Promise.resolve()
    const existing = this.hydratePending.get(slug)
    if (existing) return existing

    const promise = (async () => {
      const filePath = diskCachePath(slug)
      const raw = await readJsonOr<DiskCacheFile | null>(filePath, null)
      if (raw && raw.schemaVersion === SCHEMA_VERSION && raw.slug === slug && Array.isArray(raw.entries)) {
        let loaded = 0
        let droppedEmpty = 0
        for (const e of raw.entries) {
          if (!e || e.schemaVersion !== SCHEMA_VERSION || e.slug !== slug) continue
          // Drop pre-v1.0.76 entries that were stored with empty
          // watchedMtimes (transient resolveEpisodePaths failure at
          // compute time poisoned the cache forever — see computeAndStore
          // for the runtime guard). Forces a fresh recompute on next read
          // for any episode whose previous compute couldn't resolve its
          // watched folders. Cheap one-time cleanup at hydrate.
          const mtimes = e.watchedMtimes || {}
          if (Object.keys(mtimes).length === 0) {
            droppedEmpty++
            continue
          }
          this.set(cacheKey(slug, e.episode_code), e)
          loaded++
        }
        if (loaded > 0) this.stats.diskHydrates++
        if (droppedEmpty > 0) {
          console.log(`[episode-status-cache] hydrate: dropped ${droppedEmpty} poisoned entry(s) for ${slug}`)
        }
      }
      // Best-effort cleanup of the legacy in-project cache file. Older
      // builds wrote to <projectDir>/.cache/episode-status.json which
      // iCloud was syncing across machines; remove it so it stops
      // bouncing. Deletion failure is harmless.
      try {
        const legacy = legacyDiskCachePath(slug)
        await fs.rm(legacy, { force: true })
        // Try to remove the now-empty .cache dir too, but only if empty.
        try { await fs.rmdir(path.dirname(legacy)) } catch { /* not empty / not present */ }
      } catch { /* best-effort */ }
      // Start the FS watcher for this project so iCloud-delivered
      // changes invalidate cache entries proactively. Best-effort; if
      // watching fails the cache still works via mtime checks.
      try { await ensureProjectWatcher(slug) } catch { /* best-effort */ }
      // Mark hydrated AFTER population so concurrent callers awaiting this
      // promise observe the populated cache — not "marked hydrated, empty".
      this.hydrated.add(slug)
    })()

    this.hydratePending.set(slug, promise)
    promise.finally(() => this.hydratePending.delete(slug))
    return promise
  }

  /**
   * Debounce-flush this project's entries to disk. Multiple mutations
   * within FLUSH_DEBOUNCE_MS coalesce into one write.
   */
  private scheduleFlush(slug: string): void {
    const existing = this.flushTimers.get(slug)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this.flushTimers.delete(slug)
      this.flushProject(slug).catch((e) => {
        // Best-effort: log once and keep serving from memory. Next mutation
        // will retry. Common failure modes: disk full, permission denied,
        // sync conflict — none should bring down the request path.
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[episode-status-cache] flush failed for', slug, ':', (e as Error)?.message)
        }
      })
    }, FLUSH_DEBOUNCE_MS)
    // Don't keep the event loop alive for this timer — the app is still
    // useful even if a pending flush is dropped at shutdown.
    if (typeof t.unref === 'function') t.unref()
    this.flushTimers.set(slug, t)
  }

  /** Test/diagnostics: force-flush a project's entries to disk synchronously. */
  async flushProjectNow(slug: string): Promise<void> {
    const t = this.flushTimers.get(slug)
    if (t) { clearTimeout(t); this.flushTimers.delete(slug) }
    await this.flushProject(slug)
  }

  private async flushProject(slug: string): Promise<void> {
    const entries = this._dumpProject(slug)
    const filePath = diskCachePath(slug)
    const dir = path.dirname(filePath)

    // Serialize disk writes per project so a fast-firing burst doesn't
    // race itself. The locking helper is keyed by file path.
    await withLock(filePath, async () => {
      // If the project has nothing left, remove the file rather than
      // writing an empty array — keeps the .cache folder tidy.
      if (entries.length === 0) {
        await fs.rm(filePath, { force: true })
        return
      }
      try { await fs.mkdir(dir, { recursive: true }) } catch { /* race-safe */ }
      const payload: DiskCacheFile = {
        schemaVersion: SCHEMA_VERSION,
        slug,
        writtenAt: Date.now(),
        writtenBy: os.hostname(),
        entries,
      }
      await writeJsonAtomic(filePath, payload)
      this.stats.diskFlushes++
    })
  }

  /** Diagnostics — counts. */
  getStats(): CacheStats {
    return { ...this.stats, size: this.entries.size, inflight: this.inflight.size }
  }

  /** Phase 3 hook: dump every entry for a project (for persisting). */
  _dumpProject(slug: string): EpisodeStatusCacheEntry[] {
    const prefix = `${slug}::`
    const out: EpisodeStatusCacheEntry[] = []
    for (const [k, v] of this.entries) {
      if (k.startsWith(prefix)) out.push(v)
    }
    return out
  }

  /** Phase 3 hook: hydrate entries from disk. Skips wrong schema. */
  _hydrateProject(slug: string, entries: EpisodeStatusCacheEntry[]): number {
    let loaded = 0
    for (const e of entries) {
      if (e.schemaVersion !== SCHEMA_VERSION) continue
      if (e.slug !== slug) continue
      this.set(cacheKey(slug, e.episode_code), e)
      loaded++
    }
    return loaded
  }

  private set(k: string, entry: EpisodeStatusCacheEntry): void {
    if (this.entries.has(k)) this.entries.delete(k)
    this.entries.set(k, entry)
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  private touch(k: string, entry: EpisodeStatusCacheEntry): void {
    this.entries.delete(k)
    this.entries.set(k, entry)
  }
}

export const episodeStatusCache = new EpisodeStatusCache()

// Let the FS watcher invalidate cache entries when iCloud delivers
// files into a project's episodes tree. Wired here (not in the watcher
// module) to avoid a circular import.
bindInvalidator((slug, code) => episodeStatusCache.invalidate(slug, code))
