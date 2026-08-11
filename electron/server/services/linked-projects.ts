/**
 * Linked-projects registry.
 *
 * Lets a single Mac track Story Studio projects whose folders live OUTSIDE
 * the default PROJECTS_ROOT. Together with the existing PROJECTS_ROOT
 * scan, this gives the app a multi-location project list:
 *
 *     Mac A:
 *       PROJECTS_ROOT  = ~/Library/Application Support/Story Studio KH/projects/
 *                        ├── Local-Project/
 *       linked paths  = [
 *         /iCloud/Videos/Channel-One/,
 *         /iCloud/Videos/Channel-Two/,
 *       ]
 *     → All three projects visible on Mac A.
 *
 *     Mac B:
 *       PROJECTS_ROOT  = ~/Library/Application Support/Story Studio KH/projects/
 *                        ├── Beta-Local-Project/
 *       linked paths  = [
 *         /iCloud/Videos/Channel-One/,
 *         /iCloud/Videos/Channel-Two/,
 *       ]
 *     → The two iCloud-resident projects show up on Mac B alongside
 *       its local-only Beta-Local-Project.
 *
 * Storage: the registry is per-Mac, persisted in `app-settings.json` under
 * the key `linked_project_paths` (an array of absolute paths). This file
 * is per-machine — it never syncs to iCloud, so each Mac independently
 * decides which external project folders it's interested in.
 *
 * Why per-Mac and not synced:
 *   - Different Macs have different absolute paths to "the iCloud
 *     projects folder" (~/Library/Mobile Documents/com~apple~CloudDocs/...
 *     can differ subtly across accounts).
 *   - A Mac may legitimately want to ignore a project that exists on
 *     another Mac (e.g. an experimental sandbox you're not ready to
 *     share).
 *   - Adding a project takes seconds — Picker → confirm → done.
 */

import fs from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getAppSetting, setAppSetting } from './app-settings.js'

const APP_SETTINGS_KEY = 'linked_project_paths'

// Mirror app-settings.ts's resolution so the SYNC helpers below can read
// the same file without depending on the (async-only) getAppSetting API.
// project-manager calls getProjectDir + listProjects synchronously from
// many sites that can't easily become async, so the linked-paths lookup
// has to be sync-friendly.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
function resolveAppSettingsPathSync(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'app-settings.json')
  }
  const isPackaged = __dirname.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (isPackaged) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const productName = 'Story Studio KH'
    let userData: string
    if (process.platform === 'darwin') {
      userData = path.join(home, 'Library', 'Application Support', productName)
    } else if (process.platform === 'win32') {
      userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
    } else {
      userData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
    }
    return path.join(userData, 'app-settings.json')
  }
  return path.join(ROOT, 'app-settings.json')
}

export interface LinkedProjectInfo {
  /** Absolute path the registry knows about. */
  path: string
  /** True iff the path exists on disk right now. */
  exists: boolean
  /** Slug from the project.json at that path, when readable. */
  slug?: string
  /** Human-readable name from project.json, when readable. */
  name?: string
  /** Reason this entry isn't usable (only set when something's wrong). */
  reason?: string
  /**
   * When the picked folder is a *parent* of one or more Story Studio
   * projects, list the children we found one level deep. The UI
   * renders these as clickable chips so the user can re-target without
   * re-opening Finder.
   */
  suggestions?: Array<{ path: string; slug: string; name: string }>
}

/**
 * Read the raw absolute-path list from app-settings. Filters out non-
 * strings + non-absolute paths defensively (a hand-edited
 * app-settings.json shouldn't crash the app).
 */
export async function getLinkedProjectPaths(): Promise<string[]> {
  const raw = await getAppSetting(APP_SETTINGS_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p))
}

/**
 * Persist the list back. De-dupes + normalises (path.resolve trims
 * trailing slashes, dot segments) so the same folder isn't registered
 * twice with subtly different strings.
 */
async function setLinkedProjectPaths(paths: string[]): Promise<void> {
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string') continue
    if (!path.isAbsolute(p)) continue
    const norm = path.resolve(p)
    if (seen.has(norm)) continue
    seen.add(norm)
    cleaned.push(norm)
  }
  await setAppSetting(APP_SETTINGS_KEY, cleaned)
  // Bust the sync caches so the next getProjectDir call sees the
  // up-to-date registry without restarting the app.
  _linkedDirCache = null
  _linkedPathsCache = null
}

/**
 * Inspect a folder + return what the registry would record about it.
 * Used both by `addLinkedProject` (to validate before saving) and by
 * the bulk-status endpoint that powers the All Projects page.
 */
export async function inspectLinkedPath(absPath: string): Promise<LinkedProjectInfo> {
  if (!path.isAbsolute(absPath)) {
    return {
      path: absPath,
      exists: false,
      reason: 'Path must be absolute',
    }
  }
  const norm = path.resolve(absPath)
  if (!existsSync(norm)) {
    return { path: norm, exists: false, reason: 'Folder does not exist on disk' }
  }
  const metaPath = path.join(norm, 'project.json')
  if (!existsSync(metaPath)) {
    // Common confusion: the user picked the PARENT folder
    // (e.g. iCloud's "Story Studio KH/projects/") instead of the
    // per-project folder. Scan one level deep so the UI can suggest
    // the right child(ren) instead of forcing them back to Finder.
    const suggestions: Array<{ path: string; slug: string; name: string }> = []
    try {
      const entries = await fs.readdir(norm, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue        // skip dotfiles + .icloud stubs
        if (/\.bak-/.test(e.name)) continue          // skip move-leftover backups
        const child = path.join(norm, e.name)
        const childMeta = path.join(child, 'project.json')
        if (!existsSync(childMeta)) continue
        try {
          const meta = JSON.parse(await fs.readFile(childMeta, 'utf-8'))
          const slug = typeof meta.slug === 'string' && meta.slug ? meta.slug : e.name
          const name = typeof meta.name === 'string' && meta.name ? meta.name : slug
          suggestions.push({ path: child, slug, name })
        } catch { /* malformed child project.json — skip silently */ }
      }
    } catch { /* couldn't list dir — fall through to plain reason */ }

    if (suggestions.length > 0) {
      return {
        path: norm,
        exists: true,
        reason: suggestions.length === 1
          ? `That's a parent folder — the project itself is inside: ${path.basename(suggestions[0]!.path)}`
          : `That's a parent folder. Found ${suggestions.length} projects inside — pick one below.`,
        // The UI keys off `suggestions` to render clickable chips that
        // re-fill the path input with the child folder.
        suggestions,
      }
    }

    return {
      path: norm,
      exists: true,
      reason: 'No project.json found in this folder — pick a Story Studio project root (the folder named after your project, containing project.json)',
    }
  }
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const slug = typeof meta.slug === 'string' && meta.slug ? meta.slug : path.basename(norm)
    const name = typeof meta.name === 'string' && meta.name ? meta.name : slug
    return { path: norm, exists: true, slug, name }
  } catch (e: any) {
    return {
      path: norm,
      exists: true,
      reason: `project.json couldn't be read: ${e?.message || e}`,
    }
  }
}

/**
 * Add a folder to the registry. Validates by reading project.json and
 * surfacing the same error shapes the UI already handles for the
 * Storage tab's "Use existing folder" flow. Idempotent — adding the
 * same path twice is a no-op.
 */
export async function addLinkedProject(absPath: string): Promise<LinkedProjectInfo> {
  const info = await inspectLinkedPath(absPath)
  if (info.reason) {
    const e: any = new Error(info.reason)
    e.statusCode = 400
    throw e
  }
  const current = await getLinkedProjectPaths()
  if (!current.includes(info.path)) {
    current.push(info.path)
    await setLinkedProjectPaths(current)
  }
  // Re-adding a slug that was previously soft-deleted is the user
  // saying "I want this back" — auto-clear the tombstone. Lazy import
  // to avoid a circular dep at module-load time (soft-delete imports
  // PROJECTS_ROOT from project-manager which imports us).
  if (info.slug) {
    try {
      const { forgetSoftDeletedProject } = await import('./soft-delete.js')
      await forgetSoftDeletedProject(info.slug)
    } catch { /* non-fatal */ }
  }
  return info
}

/**
 * Remove a path from the registry. Doesn't touch the folder on disk —
 * the user can re-add it later or move/delete the folder manually.
 * Returns true iff the path was registered (and is now gone).
 */
export async function removeLinkedProject(absPath: string): Promise<boolean> {
  const { assertProjectJobsSafeToRemove } = await import('./project-job-removal-guard.js')
  await assertProjectJobsSafeToRemove(path.resolve(absPath))
  const norm = path.isAbsolute(absPath) ? path.resolve(absPath) : absPath
  const current = await getLinkedProjectPaths()
  const next = current.filter(p => p !== norm)
  if (next.length === current.length) return false
  await setLinkedProjectPaths(next)
  return true
}

/**
 * Resolve a slug → linked-project absolute path. Returns null if no
 * linked project carries that slug (or its project.json is unreadable).
 * Used by `getProjectDir` in project-manager when a slug isn't found
 * inside PROJECTS_ROOT.
 *
 * O(N) over linked paths; the list is typically tiny (< 10 entries),
 * and project.json reads are cached at the OS page-cache layer for
 * subsequent calls in the same render.
 */
export async function resolveLinkedSlugToPath(slug: string): Promise<string | null> {
  const paths = await getLinkedProjectPaths()
  for (const p of paths) {
    if (!existsSync(p)) continue
    const metaPath = path.join(p, 'project.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
      const metaSlug = typeof meta.slug === 'string' && meta.slug ? meta.slug : path.basename(p)
      if (metaSlug === slug) return p
    } catch { /* unreadable — skip */ }
  }
  return null
}

/**
 * List every linked project with full metadata. Skips entries pointing
 * at non-existent folders (silent — surfaced via the bulk-status
 * endpoint that the UI uses) and entries whose project.json is gone or
 * unreadable. The caller (listProjects in project-manager) merges
 * this with the PROJECTS_ROOT scan.
 */
export async function listLinkedProjects(): Promise<LinkedProjectInfo[]> {
  const paths = await getLinkedProjectPaths()
  const out: LinkedProjectInfo[] = []
  for (const p of paths) {
    const info = await inspectLinkedPath(p)
    out.push(info)
  }
  return out
}

// ── Sync helpers for project-manager ────────────────────────────────────────
// project-manager.getProjectDir(slug) is sync — it's called from dozens of
// hot-path sites in services that can't easily become async. To make
// linked projects participate in slug → directory resolution without
// breaking those callers, we read app-settings synchronously and walk
// linked paths directly with readFileSync. The data volumes are tiny
// (a handful of linked paths × a few hundred bytes each), so the perf
// hit is negligible compared to making the whole call chain async.

let _linkedDirCache: Map<string, string> | null = null
let _linkedPathsCache: string[] | null = null

/**
 * Read the linked-paths array synchronously from app-settings.json. The
 * sync read is what makes `getProjectDir` (and therefore everything
 * that calls it) able to find linked projects without going async.
 */
export function getLinkedProjectPathsSync(): string[] {
  if (_linkedPathsCache) return _linkedPathsCache
  try {
    const raw = readFileSync(resolveAppSettingsPathSync(), 'utf-8')
    const cfg = JSON.parse(raw)
    const list = cfg?.[APP_SETTINGS_KEY]
    if (!Array.isArray(list)) {
      _linkedPathsCache = []
      return _linkedPathsCache
    }
    _linkedPathsCache = list.filter(
      (p): p is string => typeof p === 'string' && path.isAbsolute(p),
    )
    return _linkedPathsCache
  } catch {
    _linkedPathsCache = []
    return _linkedPathsCache
  }
}

/**
 * Sync slug → directory map for every linked project that's present
 * on disk. Cached at module scope; invalidate via
 * `invalidateLinkedDirCache()` after add/remove/move operations.
 *
 * O(N) build cost (N = number of linked paths), one project.json read
 * per linked path. Re-reading after invalidation is the only time we
 * pay; lookups are O(1) Map gets.
 */
export function getLinkedDirCache(): Map<string, string> {
  if (_linkedDirCache) return _linkedDirCache
  const map = new Map<string, string>()
  for (const linked of getLinkedProjectPathsSync()) {
    if (!existsSync(linked)) continue
    const metaPath = path.join(linked, 'project.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      const slug = typeof meta?.slug === 'string' && meta.slug ? meta.slug : path.basename(linked)
      // PROJECTS_ROOT entries win on conflict — handled by the caller
      // (project-manager.getProjectDir checks default first). Here we
      // just record what every linked path claims its slug is. First
      // path wins on intra-linked duplicates.
      if (!map.has(slug)) map.set(slug, linked)
    } catch { /* skip unreadable */ }
  }
  _linkedDirCache = map
  return _linkedDirCache
}

/**
 * Invalidate both caches. Call after any mutation that could change
 * the registry: add/remove a linked path, move a project, rename,
 * delete on disk. Cheap (just nulls module state).
 */
export function invalidateLinkedDirCache(): void {
  _linkedDirCache = null
  _linkedPathsCache = null
}
