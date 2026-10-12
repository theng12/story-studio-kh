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
import { resolveEpisodePathsByCodeWithSidecar, type ProjectFactsCache } from './utils.js'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'
import { bindInvalidator, ensureProjectWatcher, watcherTrustedSince } from './episode-folder-watcher.js'
import { RESEARCH_JSON_FILENAME, researchFolderName } from '../lib/research-paths.js'

// v14 — visual-source sidecars are watched directly so an Image Pool pick or
// source switch invalidates render readiness in place. Discard v13 rows whose
// watched-mtime snapshot predates that file.
/**
 * v15 — entries now also cover the Library's export root (the per-process
 * watcher in `episode-folder-watcher.ts` invalidates them). Rows persisted by
 * 1.4.218 watched only the project tree, so a final that changed while the app
 * was closed would be served from disk until some unrelated project file moved.
 * Discarding v14 rows recomputes every episode against disk once (NEW-13).
 */
/**
 * v16 — a music channel's episodes carry `music_episode` (the Episode Builder's stitched mix is
 * current), and their Scene Plan no longer needs a subtitle timeline. Discard v15 rows, which have
 * neither, so a music episode does not read "Steps 0/7" narration steps until something moves.
 */
/**
 * v17 — project config, project metadata, and episode metadata outputs are watched directly.
 * Config changes alter readiness and path resolution, while metadata outputs and their completion
 * manifest are rewritten in place without changing the metadata folder mtime. Discard v16 rows so
 * a warm cache cannot miss either kind of change after upgrade.
 */
/**
 * v18 — caption-gap safety modes now determine subtitle completion. Discard v17 rows so statuses
 * computed under the former unconditional gap block are recomputed after upgrade.
 */
export const SCHEMA_VERSION = 18 as const
const MAX_ENTRIES = 1000
/**
 * Watcher-backed reads (see `trusted()`): how long an entry may be served
 * without re-statting its watched folders, and how many episodes of one
 * project may be re-statted per window once entries do age out.
 *
 * These bound a warm list to a few dozen stats instead of one per episode per
 * read, while still walking the whole project back to verified status on its
 * own. That second half is not decoration: `fs.watch` with `recursive: true`
 * can start successfully and then deliver nothing at all (measured on a
 * sandboxed filesystem here, and network/virtualised volumes behave the same
 * way), and it gives no signal when that happens. So the watcher is treated as
 * an optimisation that is usually right, never as the only witness.
 *
 * 1.4.257 — paced. The budget used to refill every second, so on the owner's
 * 405-episode channel a list read that itself took 20–45 s re-audited almost
 * every row, and every row went stale on any `config.json` write. Now the
 * budget refills every 15 s and is sized so a project's rows are all
 * re-checked inside one AUDIT_MAX_AGE_MS cycle (~4 min): a change nobody
 * announced — made while the app was closed, or one the watcher missed — can
 * show up to ~4 min late (owner decision, 2026-10-06). Story's own mutations
 * still invalidate their rows at once; Shift-Refresh forces a full check.
 */
const AUDIT_MAX_AGE_MS = 4 * 60_000
const AUDIT_MIN_BUDGET = 24
const AUDIT_WINDOW_MS = 15_000
/** Windows per cycle the budget is sized for: under AUDIT_MAX_AGE_MS / AUDIT_WINDOW_MS (16), so re-ageing rows cannot starve the rest. */
const AUDIT_WINDOWS_PER_CYCLE = 12
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
  const dir = pm.getProjectDir(slug) || path.join(pm.projectsRoot(), slug)
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
   * When this entry was last confirmed to match disk — set at compute time
   * and refreshed on every mtime-verified read. Compared against the
   * project watcher's start time to decide whether the watched folders
   * still need re-statting. Absent on entries written by older builds,
   * which simply read as "never verified" and get statted once.
   */
  verifiedAt?: number
  /**
   * Folders whose contents affect status. Re-statted on every read; if any
   * mtime advanced (or a folder appeared/disappeared), the entry is stale.
   * Stored as a flat record so JSON-persistable as-is in Phase 3.
   */
  watchedMtimes: FolderMtimes
  schemaVersion: typeof SCHEMA_VERSION
  /**
   * 1.4.257 — the episode list's own per-row reads (visual source, local media
   * cleanup), kept with the status they were read beside. They share the entry's
   * lifetime: any invalidation or stale recompute replaces the entry and drops
   * them. A change to their shape must bump SCHEMA_VERSION like any other field.
   */
  listExtras?: unknown
}

interface CacheStats {
  hits: number
  staleRecomputes: number
  misses: number
  inflightDedups: number
  invalidations: number
  diskHydrates: number
  diskFlushes: number
  /** Hits served on the watcher's word, with no folder stats at all. */
  watchedHits: number
  size: number
  inflight: number
}

function cacheKey(slug: string, code: string): string {
  return `${slug}::${code.toUpperCase()}`
}

function projectStatusDependencyPaths(slug: string): string[] {
  const projectDir = pm.getProjectDir(slug) || path.join(pm.projectsRoot(), slug)
  return [path.join(projectDir, 'config.json'), path.join(projectDir, 'project.json')]
}

/**
 * Resolve the list of folders whose mtimes determine episode status.
 * Resolve by code plus the audio manifest so title changes cannot leave the
 * cache watching a non-existent folder.
 */
async function resolveWatchedFolders(
  slug: string,
  code: string,
  ideas?: Awaited<ReturnType<typeof im.getIdeas>>,
  cache?: ProjectFactsCache,
): Promise<string[]> {
  // `ideas` is retained in the signature for caller compatibility. The
  // by-code resolver performs its own canonical lookup and can also locate a
  // renamed sibling by the audio manifest.
  void ideas
  let paths: Awaited<ReturnType<typeof resolveEpisodePathsByCodeWithSidecar>>
  try {
    paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json', cache)
  } catch {
    return []
  }
  // Metadata JSON/text outputs and the completion manifest are rewritten in
  // place. Their parent directory does not move when that happens, so retain
  // the current files in the snapshot alongside the directory itself. A
  // later create/remove still changes the directory mtime.
  const metadataFiles = (await fs.readdir(paths.metadata_dir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile())
    .map(entry => path.join(paths.metadata_dir, entry.name))

  // All folders (and a couple of files) whose changes could affect any status
  // field. NOTE: stat works on files too — we watch scene_plan.json directly
  // because the planner/renderer/approval flow REWRITES it IN PLACE (which
  // changes the file's mtime but NOT the episode_dir's), and scene images land
  // in a scene_images/ subfolder (episode_dir's mtime doesn't move for writes
  // inside a sibling). Without these two, scene_plan / scene_review never
  // refresh after the first plan was created. (v1.0.276)
  return [
    ...projectStatusDependencyPaths(slug),  // config readiness plus project format/path settings
    paths.episode_dir,        // sibling-folder detection for video_assembly
    path.join(paths.episode_dir, 'scene_plan.json'),  // scene_plan + scene_review (legacy root location, in-place rewrites)
    // v1.0.467 — scene_plan.json now lives in the "03 Scene Prompts" folder.
    // In-place rewrites change the FILE's mtime but not the folder's, so we must
    // watch the file directly (watching scene_prompts_dir alone would miss them).
    path.join(paths.scene_prompts_dir, 'scene_plan.json'),  // scene_plan + scene_review (new location)
    path.join(paths.episode_dir, 'scene_images'),     // scene_review (per-scene images)
    // v1.0.760 — research.json is rewritten IN PLACE when the user verifies or
    // un-verifies. That moves the FILE's mtime, not the research folder's or
    // episode_dir's, so the file itself must be watched or a verify would not
    // refresh the Production Board / pending filter until something else changed.
    path.join(paths.episode_dir, researchFolderName(code), RESEARCH_JSON_FILENAME),
    paths.script_dir,         // script + introduction
    paths.scene_prompts_dir,  // scene_prompts (and bg_dir image counts via docx mtime)
    paths.thumb_prompts_dir,  // thumb_prompts
    paths.metadata_dir,       // metadata
    ...metadataFiles,         // metadata outputs/manifests rewritten in place
    paths.bg_dir,             // images
    paths.thumb_dir,          // thumbnails
    paths.audio_dir,          // audio
    path.join(paths.episode_dir, 'audio_chapters.json'), // expected subtitle sections
    path.join(paths.episode_dir, 'broll-selection.json'), // visual source + frozen Image Pool selection (rewritten in place)
    paths.subtitles_dir,      // per-section/full-track subtitle completion
    paths.merged_audio_dir,   // merged_audio
    paths.video_dir,          // video + video_assembly
    paths.video_assets_dir,   // motion_review image-to-video clips
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
    watchedHits: 0,
  }
  /** Slug whose entries must survive LRU eviction — the one being read. */
  private activeSlug: string | null = null
  /** Per-project re-stat allowance, so an audit sweep stays bounded. */
  private auditBudget = new Map<string, { windowStart: number, used: number, limit: number }>()

  /**
   * Read or compute status for one episode, always verifying the cached
   * entry against disk. This is the strict path: every read re-stats the
   * episode's watched folders, so a change made a millisecond ago — by this
   * app, by Finder, by an iCloud delivery — is picked up immediately.
   *
   * Pass `ideas` (the project's accepted-ideas array) when calling in a
   * batch — saves a per-episode ideas.json read inside computeEpisodeStatus
   * AND inside resolveWatchedFolders.
   */
  async get(
    slug: string,
    code: string,
    ideas?: Awaited<ReturnType<typeof im.getIdeas>>,
    // v1.4.48 — the caller's request-scoped snapshot of the project's
    // unchanging facts. A full list shares ONE; a single-episode read passes
    // nothing and behaves exactly as before. See `ProjectFactsCache`.
    cache?: ProjectFactsCache,
  ): Promise<EpisodeStatus> {
    return this.read(slug, code, ideas, cache, false)
  }

  /**
   * The same read, for building the whole project's episode list.
   *
   * Difference: where a live folder watcher has been running since an entry
   * was last confirmed against disk, this serves the entry WITHOUT
   * re-statting it — the watcher would already have deleted it had anything
   * changed. That is the whole point: verifying 302 unchanged episodes cost
   * ~3,200 stats on every navigation, to learn nothing had changed.
   *
   * Single-episode reads deliberately do NOT take this path. A page that
   * just wrote a file asks about one episode and must see disk truth with no
   * dependence on event timing; a list is a summary of a project that is not
   * being edited under the cursor, and it still re-verifies a rolling slice
   * of episodes on every pass (see `trusted`).
   */
  async getForList(
    slug: string,
    code: string,
    ideas?: Awaited<ReturnType<typeof im.getIdeas>>,
    cache?: ProjectFactsCache,
  ): Promise<EpisodeStatus> {
    return this.read(slug, code, ideas, cache, true)
  }

  private async read(
    slug: string,
    code: string,
    ideas: Awaited<ReturnType<typeof im.getIdeas>> | undefined,
    cache: ProjectFactsCache | undefined,
    trustWatcher: boolean,
  ): Promise<EpisodeStatus> {
    const k = cacheKey(slug, code)
    // The project being read is the one that must stay resident — see set().
    this.activeSlug = slug

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
      if (trustWatcher && this.trusted(slug, entry)) {
        // HIT with no filesystem work at all: this project has a live
        // watcher that has been running since the entry was last confirmed,
        // so any change would already have deleted it. This is what keeps a
        // 300-episode list from doing 3,000 stats to learn nothing changed.
        this.touch(k, entry)
        this.stats.hits++
        this.stats.watchedHits++
        return entry.status
      }
      const folders = Object.keys(entry.watchedMtimes)
      const current = await snapshotMtimes(folders)
      if (mtimesUnchanged(entry.watchedMtimes, current)) {
        // HIT — touch to update LRU recency, and record that disk agreed
        // just now so the watcher can vouch for it from here on.
        entry.verifiedAt = Date.now()
        this.touch(k, entry)
        this.stats.hits++
        return entry.status
      }
      // STALE — fall through to recompute.
      this.stats.staleRecomputes++
    } else {
      this.stats.misses++
    }

    return this.computeAndStore(slug, code, ideas, cache)
  }

  private computeAndStore(
    slug: string,
    code: string,
    ideas?: Awaited<ReturnType<typeof im.getIdeas>>,
    cache?: ProjectFactsCache,
  ): Promise<EpisodeStatus> {
    const k = cacheKey(slug, code)

    // Snapshot the dedup promise so concurrent callers don't both compute.
    const promise = (async () => {
      // Resolve the watched folder list FIRST — we need it to take the
      // mtime snapshot before computeEpisodeStatus reads them. (If we
      // snapshot after, a write that lands during compute would be missed
      // until the NEXT read; better to snapshot first and accept that a
      // write during compute means the next read will see STALE — correct.)
      const folders = await resolveWatchedFolders(slug, code, ideas, cache)
      const watchedMtimes = await snapshotMtimes(folders)
      const projectDependencies = new Set(projectStatusDependencyPaths(slug))
      const hasEpisodeSnapshot = Object.keys(watchedMtimes).some(p => !projectDependencies.has(p))
      // The snapshot moment, not the post-compute moment: anything that
      // lands during the compute must still count as "after verification".
      const verifiedAt = Date.now()

      const status = await computeEpisodeStatus(slug, code, ideas, cache)

      const entry: EpisodeStatusCacheEntry = {
        slug,
        episode_code: code.toUpperCase(),
        status,
        computedAt: Date.now(),
        verifiedAt,
        watchedMtimes,
        schemaVersion: SCHEMA_VERSION,
      }
      // Cache-poisoning guards. Three independent reasons NOT to cache a
      // computed entry:
      //
      //   1. (v1.0.76) `folders.length === 0` — resolveEpisodePaths threw,
      //      so we don't even know which folders to watch. Caching here
      //      would freeze the empty-mtimes snapshot, and mtimesUnchanged
      //      would return true forever → bad status sticks until the
      //      user hard-rescans. Recompute is cheap (~10 fs ops) and the
      //      retry usually picks up the real paths.
      //
      //   2. (v1.0.78) `status._unreliable === true` — readdir errored
      //      on at least one of the watched folders during the compute,
      //      typically iCloud transience (subfolder evicted, EBUSY
      //      mid-sync, ENOENT during a just-delivered move). The boolean
      //      status fields derived from those reads are unreliable and
      //      we MUST not freeze them. Same recovery shape as #1 — drop
      //      this entry, recompute on the next read, by which point
      //      iCloud has usually settled.
      //
      //   3. No EPISODE-SPECIFIC mtimes in the snapshot, for the same reason
      //      as #1 and by the same mechanism. A newly-accepted episode resolves
      //      to a real folder list (resolveEpisodePaths computes paths from the
      //      template and does not require them to exist) while none of those
      //      folders is on disk yet. The shared config.json/project.json files
      //      may exist, but they cannot reveal that this episode's first folder
      //      appeared later.
      //
      //      This note used to say caching that was correct, because when
      //      the folders appeared "the new keys in mtimes will not match
      //      the empty snapshot". They never appear. The staleness check
      //      stats `Object.keys(entry.watchedMtimes)` — the keys ALREADY
      //      stored — so a project-only snapshot keeps comparing those same
      //      unchanged shared files and becomes a permanent hit. Measured: an
      //      episode read once before its script existed still reported
      //      `script: false` after the script really landed, for the life
      //      of the process, with nothing the owner could do about it.
      //
      //      The disk path already knew this — `hydrateProjectIfNeeded`
      //      drops empty-snapshot rows as poisoned. Only the in-memory
      //      path still created them.
      const unreliable = (status as any)._unreliable === true
      if (folders.length > 0 && hasEpisodeSnapshot && !unreliable) {
        this.set(k, entry)
        this.scheduleFlush(slug)
      }
      return status
    })()

    this.inflight.set(k, promise)
    void promise.then(() => {
      // Clear inflight only if it's still our promise (guards against
      // races with explicit invalidation that started a fresh compute).
      if (this.inflight.get(k) === promise) this.inflight.delete(k)
    }, () => {
      if (this.inflight.get(k) === promise) this.inflight.delete(k)
    })
    return promise
  }

  /**
   * May this entry be served without re-statting its watched folders?
   *
   * Only when a healthy watcher for the project has been running since the
   * entry was last confirmed against disk — every change since then would
   * have fired an event and deleted the entry. Three things deliberately
   * refuse trust:
   *
   *   - No watcher (never started, unsupported platform, LRU-evicted,
   *     closed, or errored) → verify against disk, exactly as before. A
   *     broken watcher costs speed, never correctness.
   *   - An entry last verified BEFORE the watcher went live — including
   *     every entry hydrated from disk at startup — and an entry older than
   *     AUDIT_MAX_AGE_MS are re-verified, paced by the project's audit
   *     budget per AUDIT_WINDOW_MS (see the constants). That is the backstop
   *     for events the OS coalesced away or dropped and for changes made while
   *     the app was closed: a warm list stays cheap, yet the project walks
   *     itself back to fully verified within one cycle without anyone asking.
   */
  private trusted(slug: string, entry: EpisodeStatusCacheEntry): boolean {
    const since = watcherTrustedSince(slug)
    if (since === null) return false
    const verifiedAt = entry.verifiedAt ?? 0
    if (verifiedAt >= since && Date.now() - verifiedAt < AUDIT_MAX_AGE_MS) return true
    // Aged out, or last confirmed before this watcher went live (a row loaded
    // from disk at startup): re-verify if this project's audit allowance
    // permits, else serve it now and let a later request pick it up.
    return !this.consumeAuditBudget(slug)
  }

  /** True when this project may spend one re-stat in the current window. */
  private consumeAuditBudget(slug: string): boolean {
    const now = Date.now()
    let b = this.auditBudget.get(slug)
    if (!b || now - b.windowStart > AUDIT_WINDOW_MS) {
      const rows = this._dumpProject(slug).length
      b = { windowStart: now, used: 0, limit: Math.max(AUDIT_MIN_BUDGET, Math.ceil(rows / AUDIT_WINDOWS_PER_CYCLE)) }
      this.auditBudget.set(slug, b)
    }
    if (b.used >= b.limit) return false
    b.used++
    return true
  }

  /**
   * Per-row list reads cached on the status entry they were read beside (see
   * `listExtras`). `status` must be the object this cache just returned for
   * the row: if the entry was replaced meanwhile, the value is computed and
   * returned but not kept, so it can never outlive the status it belongs to.
   */
  async listExtras<T>(slug: string, code: string, status: EpisodeStatus, compute: () => Promise<T>): Promise<T> {
    const k = cacheKey(slug, code)
    const before = this.entries.get(k)
    if (before?.status === status && before.listExtras !== undefined) return before.listExtras as T
    const value = await compute()
    const entry = this.entries.get(k)
    if (entry?.status === status) {
      entry.listExtras = value
      this.scheduleFlush(slug)
    }
    return value
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
    this.auditBudget.clear()
    this.activeSlug = null
    this.stats = { hits: 0, staleRecomputes: 0, misses: 0, inflightDedups: 0, invalidations: 0, diskHydrates: 0, diskFlushes: 0, watchedHits: 0 }
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
    void promise.then(
      () => this.hydratePending.delete(slug),
      () => this.hydratePending.delete(slug),
    )
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
      const victim = this.evictionVictim()
      if (victim === undefined) break
      this.entries.delete(victim)
    }
  }

  /**
   * Which entry to drop when the cache is full.
   *
   * Plain LRU is wrong here: this machine holds ~1,557 persisted rows across
   * 12 projects against a 1,000-entry cap, so hydrating a second project
   * could evict the rows of the project the user is actually looking at —
   * and every one of those evictions is a full recompute on their next
   * click. So residency is project-aware: the least-recently-used entry
   * that does NOT belong to the project currently being read is evicted
   * first, and the active project is only touched once it is the sole
   * occupant (a single project larger than the whole cap, where plain LRU
   * is the only sensible answer).
   */
  private evictionVictim(): string | undefined {
    const activePrefix = this.activeSlug ? `${this.activeSlug}::` : null
    let lru: string | undefined
    for (const k of this.entries.keys()) {
      if (lru === undefined) lru = k
      if (activePrefix === null || !k.startsWith(activePrefix)) return k
    }
    return lru
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

/**
 * A job that just finished (done, failed or cancelled) may have written or
 * removed this episode's files. Drop its cached status at once instead of
 * waiting for the folder watcher or the paced re-check. Jobs without an
 * episode drop the whole project. Wired to the queue's update events at boot.
 */
export function invalidateForFinishedJob(job: { project_slug?: string; episode_id?: string; status?: string }): void {
  if (!job?.project_slug || !['done', 'error', 'cancelled'].includes(String(job.status))) return
  if (job.episode_id) episodeStatusCache.invalidate(job.project_slug, job.episode_id)
  else episodeStatusCache.invalidateProject(job.project_slug)
}
