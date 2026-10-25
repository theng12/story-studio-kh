/**
 * File-based project CRUD service.
 * Each project lives in PROJECTS_ROOT/{slug}/ with project.json, config.json, etc.
 */

import fs from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import {
  DEFAULT_SUBFOLDER_NAMES,
} from '../models/types.js'
import {
  DEFAULT_IMAGE_MODELS, DEFAULT_AUDIO_MODELS, DEFAULT_VOICE_PRESETS, DEFAULT_VIDEO_MODELS,
} from '../models/defaults.js'
import { sanitizeVideoCatalog } from '../models/video-catalog.js'
import { OWNER_STANDARD_SCENE_PACING } from '../contracts/pacing.js'
import { DEFAULT_THUMBNAIL_COUNT } from '../contracts/thumbnail-counts.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import type {
  AudioModelConfig, CreateProjectRequest, ProjectConfig, ProjectMeta, ProjectSummary,
  SafeProjectConfig, UpdateApiKeysRequest, UpdateConfigRequest, UpdateProjectRequest,
} from '../models/types.js'
import { resolveGenStudioModelId } from './genstudio-model-migration.js'
import { buildManifest, writeManifestCache, getMachineLabel } from './manifest.js'
import { sanitizeProjectSlug } from './slug.js'
import { getSoftDeletedSlugSet, forgetSoftDeletedProject } from './soft-delete.js'
import { onAppSettingWritten } from './app-settings.js'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Resolve paths — in packaged Electron, use userData; in dev, use project root
const ROOT = path.resolve(__dirname, '..', '..', '..')

// Detect if we're running inside a packaged Electron app.
// Multiple signals: __dirname contains .asar, process.resourcesPath is set, or
// we can successfully require('electron') and app.isPackaged is true.
function isPackagedApp(): boolean {
  if (__dirname.includes('.asar')) return true
  if (process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE) {
    // Packaged Electron binaries have resourcesPath set
    try {
      const { app } = require('electron')
      return app?.isPackaged === true
    } catch {
      return false
    }
  }
  return false
}

function getUserDataPath(productName: string): string {
  // Compute platform-appropriate user data directory without needing Electron
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', productName)
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
  } else {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
  }
}

/**
 * Compute the path to app-settings.json the same way app-settings.ts does,
 * but synchronously and without requiring app-settings.ts to be loaded
 * (avoids a load-order tangle: app-settings.ts depends on PROJECTS_ROOT
 * via its data-dir resolution branch).
 *
 * Returns the absolute path the file would live at — file may not exist.
 */
/**
 * Where app-settings.json lives — resolved IDENTICALLY to `app-settings.ts`.
 *
 * v1.4.6: these two computations used to disagree in an unpackaged run.
 * `app-settings.ts` (which WRITES) falls back to `<repoRoot>/app-settings.json`
 * when it is not packaged; this reader fell back to the userData folder. So a
 * Library chosen in a dev build was written to one file and read from another,
 * and the app silently carried on with the old location — the setting appeared
 * to save and did nothing.
 *
 * Packaged builds were unaffected, because there both sides resolve to the
 * userData folder. That is exactly why it survived: the only people who could
 * hit it were the ones running from source.
 *
 * The branches below mirror `app-settings.ts:resolveAppSettingsPath` line for
 * line. If that one changes, change this one — or better, delete one of them.
 */
function resolveAppSettingsPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'app-settings.json')
  }
  const isPackaged = __dirnameCompat().includes('.asar')
    || (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (isPackaged) {
    return path.join(getUserDataPath('Story Studio KH'), 'app-settings.json')
  }
  // Unpackaged: the repo root, which is what app-settings.ts writes to.
  return path.join(repoRootCompat(), 'app-settings.json')
}

/** `__dirname` for this module, ESM-safe. */
function __dirnameCompat(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}
/** Repo root, matching `app-settings.ts`'s `ROOT` (services → server → electron → root). */
function repoRootCompat(): string {
  return path.resolve(__dirnameCompat(), '..', '..', '..')
}

/**
 * Read the user's `projects_root_override` setting.
 *
 * Synchronous on purpose: `projectsRoot()` is called from every service in
 * the codebase, much of it synchronous. Resolving asynchronously would
 * require touching hundreds of call sites OR a one-shot await wrapper
 * that's hard to fit alongside existing import patterns.
 *
 * Deliberately NOT memoised. It used to run exactly once per process — as
 * part of the module-load `PROJECTS_ROOT` const — which is precisely the
 * frozen-path bug this module was refactored to remove. app-settings.json is
 * tiny (<1 KB) and this is skipped entirely whenever `STORY_STUDIO_DATA_DIR`
 * is set (tests, and any isolated run), because that branch returns before
 * we get here. Callers that resolve in a loop hoist the result into a local.
 *
 * Returns:
 *   - the absolute override path when set + non-empty
 *   - empty string otherwise (caller falls through to default)
 *
 * Any read/parse error → treated as unset. We never want an unreadable
 * settings file to brick the app's ability to find its projects.
 */
/**
 * Read one string setting out of app-settings.json synchronously.
 *
 * v1.4.3 generalised this from a single-key reader. `projectsRoot()` is sync
 * and called from dozens of hot paths, so the Library location has to be
 * readable without awaiting.
 */
function readSettingSync(key: string): string {
  const settingsPath = resolveAppSettingsPath()
  if (!existsSync(settingsPath)) return ''
  try {
    // Use the readFileSync from node:fs (NOT fs/promises). Top-level
    // import is for fs/promises; pull sync API on demand.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs')
    const raw = readFileSync(settingsPath, 'utf-8')
    const data = JSON.parse(raw)
    const v = data?.[key]
    if (typeof v !== 'string' || !v.trim()) return ''
    // Expand `~` for convenience (the picker emits absolute paths but
    // a user editing app-settings.json by hand might use ~).
    let resolved = v.trim()
    if (resolved.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      if (home) resolved = path.join(home, resolved.slice(1))
    }
    return resolved
  } catch {
    return ''
  }
}

/**
 * The resolved Library path, remembered between calls — and dropped the instant
 * app-settings.json is written.
 *
 * ── What this replaces, and what it must not break ──
 *
 * `projectsRoot()` used to run `readSettingSync()` on EVERY call: an
 * `existsSync`, a `readFileSync` and a `JSON.parse` of app-settings.json,
 * synchronously, on the event loop. That was a deliberate choice with a real
 * reason behind it — the path had to be correct the moment the user re-pointed
 * their Library, and a memoised value would have gone stale. `listProjects()`
 * alone calls into this once per candidate folder, so opening the home page did
 * that read once per channel, and every one of them blocked the whole process.
 * With the disk busy under an FFmpeg render, that is where the app stopped
 * answering.
 *
 * The freshness contract is UNCHANGED and must stay that way. It is now kept by
 * invalidation rather than by re-reading: `onAppSettingWritten` drops this the
 * moment a setting that can MOVE THE LIBRARY is written, so the very next call
 * re-reads from disk. The stale-path bug class the comment on `projectsRoot()`
 * describes — a value frozen before the caller could point it somewhere else —
 * must never come back; anything that can change where the Library is has to
 * invalidate here.
 *
 * ── Why the key matters, and not just the write ──
 *
 * It used to drop on ANY app-settings write, and app-settings.json is written
 * constantly by things that have nothing to do with the Library: the hourly
 * retention status, the queue pause flag and its owner token, the last-seen
 * version. Each of those turned the next `projectsRoot()` — which sits on the
 * per-request path through `getProjectDir` — into an `existsSync` + a
 * `readFileSync` + a `JSON.parse`, synchronously, on the event loop, while ten
 * jobs were saturating the same disk. The setting that can move the Library is
 * `library_root` (and its pre-1.4.3 name `projects_root_override`), so only
 * those two keys invalidate. `appSettingMovesProjectsRoot` is the one place
 * that rule lives.
 *
 * `STORY_STUDIO_DATA_DIR` is checked BEFORE this cache is ever consulted, so the
 * test-isolation property is untouched: a test that claims a temp dir gets its
 * own path with no file read and no cache involvement at all.
 */
let cachedLibraryRoot: string | null = null

/**
 * Can a write to this app-settings key change where the Library is?
 *
 * `library_root` is the one location setting (services/library.ts); the legacy
 * `projects_root_override` is still read, so it can still move the root. Every
 * other key — retention status, queue pause, last-seen version, ffmpeg paths,
 * every tunable — cannot.
 */
export function appSettingMovesProjectsRoot(key: string): boolean {
  return key === 'library_root' || key === 'projects_root_override'
}

function invalidateProjectsRootCache(key: string): void {
  // Anything that cannot move the Library leaves the cached path alone. See the
  // comment above: re-reading here put a synchronous file read on the request
  // path every time an unrelated setting was written.
  if (!appSettingMovesProjectsRoot(key)) return
  cachedLibraryRoot = null
}

// Registered once, at module load. Cheap (adds a callback to a Set) and does no
// I/O, so it is safe in the "merely importing this module must touch nothing"
// sense the comments throughout this file are protecting.
onAppSettingWritten(invalidateProjectsRootCache)

function resolveProjectsRoot(): string {
  // Test override — highest priority so tests don't touch real data, and
  // deliberately ahead of the cache: it is free, it changes between tests in one
  // process, and it must never be remembered.
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'projects')
  }
  if (cachedLibraryRoot !== null) return cachedLibraryRoot
  const resolved = readProjectsRootFromDisk()
  cachedLibraryRoot = resolved
  return resolved
}

function readProjectsRootFromDisk(): string {
  // v1.4.3 — the Library. The one place everything lives, chosen by the user
  // on first run rather than assumed: *"i don't want our app on a new computer
  // to use the default location … i don't have to hunt for the story studio
  // folder inside of /user sth."*
  const library = readSettingSync('library_root')
  if (library) return library

  // Legacy: `projects_root_override` from before the Library existed (<= 1.4.2),
  // read so an install that still carries it keeps its folder.
  const legacy = readSettingSync('projects_root_override')
  if (legacy) return legacy

  // Nothing chosen yet. This is a FRESH INSTALL, and the app will ask before
  // creating anything — the fallback exists so path resolution has an answer
  // during first run, not so the app can quietly adopt it. Nothing is written
  // here: directory creation lives in `ensureProjectsRoot()`.
  try {
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'projects')
  } catch { /* not running inside Electron (e.g. tests) */ }
  return path.join(getUserDataPath('Story Studio KH'), 'projects')
}

/**
 * Diagnostic helpers for the Storage-tab UI. Exported so the route
 * layer can return both `effective_path` (what `projectsRoot()` resolves
 * to right now) and `default_path` (what the userData fallback would give)
 * without re-implementing the platform branching.
 */
export function getProjectsRootDefaultPath(): string {
  try {
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'projects')
  } catch { /* not in Electron */ }
  return path.join(getUserDataPath('Story Studio KH'), 'projects')
}

/**
 * Per-machine user-data directory (NOT inside the projects root).
 * Used by callers that need to store machine-local state — e.g. the
 * episode-status cache, which must not be synced across machines via
 * iCloud (see SS-icloud-cache fix).
 */
export function getUserDataDir(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) return process.env.STORY_STUDIO_DATA_DIR
  try {
    const { app } = require('electron')
    if (app?.getPath) return app.getPath('userData')
  } catch { /* not in Electron */ }
  return getUserDataPath('Story Studio KH')
}

export function getProjectsRootAppSettingsPath(): string {
  return resolveAppSettingsPath()
}

/**
 * One-shot migration: copy projects from legacy dev locations into the
 * canonical projects root (userData/projects) on first startup only.
 *
 * A `.legacy-migration-done` marker is written to the projects root after the
 * first run. Subsequent startups short-circuit — so deleting a project
 * from userData will NOT cause it to be re-seeded from a stale legacy
 * folder on the next launch.
 *
 * Legacy locations:
 *   - {repo}/projects/            (from the original tsx-watch dev setup)
 *   - {repo}/electron/projects/   (from the compiled-JS dev setup)
 *
 * MUST be called explicitly at real application startup, never at module
 * load. Importing this module used to run it, which meant any test — or any
 * tool that merely pulled in a service transitively — copied directories
 * around and wrote a marker file into the developer's real projects folder.
 * Call sites: `electron/main.ts` (packaged / dev Electron boot) and the
 * standalone-listen branch of `electron/server/app.ts` (dev via tsx). Both
 * are genuine server boots; neither runs when a test imports the app.
 */
export function migrateLegacyProjects(): void {
  const root = ensureProjectsRoot()
  const markerPath = path.join(root, '.legacy-migration-done')
  if (existsSync(markerPath)) return

  const legacyRoots = [
    path.join(ROOT, 'projects'),
    path.join(ROOT, 'electron', 'projects'),
  ].filter(p => p !== root && existsSync(p))

  for (const legacy of legacyRoots) {
    let entries: string[] = []
    try { entries = require('fs').readdirSync(legacy) } catch { continue }
    for (const slug of entries) {
      const src = path.join(legacy, slug)
      const dst = path.join(root, slug)
      try {
        const stat = require('fs').statSync(src)
        if (!stat.isDirectory()) continue
        if (existsSync(path.join(dst, 'project.json'))) continue
        require('fs').cpSync(src, dst, { recursive: true, errorOnExist: false })
        console.log(`[projects] Migrated legacy project '${slug}' from ${legacy}`)
      } catch (e) {
        console.warn(`[projects] Could not migrate '${slug}' from ${legacy}:`, e)
      }
    }
  }

  try { require('fs').writeFileSync(markerPath, new Date().toISOString()) } catch {}
}

function resolveTemplatesRoot(): string {
  if (isPackagedApp()) {
    // Templates are bundled via extraResources → inside Contents/Resources/templates
    if (process.resourcesPath) {
      return path.join(process.resourcesPath, 'templates')
    }
  }
  return path.join(ROOT, 'electron', 'templates')
}

/**
 * The projects root, resolved on EVERY access.
 *
 * Deliberately a function and not an exported `const`. `STORY_STUDIO_DATA_DIR`
 * is what redirects project storage into an isolated directory, and it is set
 * by the caller — the Electron main process at boot, `useTempDataDir()` in
 * tests. The old module-scope `const PROJECTS_ROOT = resolveProjectsRoot()`
 * froze the path to whatever it happened to be when the FIRST importer
 * anywhere in the graph pulled this module in, which is before a test's
 * `before()` hook can claim its temp dir. Measured on the full backend suite,
 * 73 of the 147 test processes that load this module bound the developer's
 * REAL projects directory that way — and on this machine that resolves via
 * `projects_root_override` to the owner's actual working folder, not a
 * throwaway userData path.
 *
 * A lazy getter was not an option: ESM named exports cannot be backed by a
 * getter, so no shim could have kept the `PROJECTS_ROOT` import shape honest.
 * The const is therefore DELETED rather than deprecated — that turns every
 * consumer this refactor might have missed into a TypeScript compile error
 * instead of a silently stale path.
 *
 * Same shape as `services/app-settings.ts`, `services/named-roots.ts` and
 * `services/preview-cache.ts`. Directory creation is deferred to
 * `ensureProjectsRoot()` at the actual write sites, so merely resolving the
 * path — or importing this module — never touches the filesystem.
 */
export function projectsRoot(): string {
  return resolveProjectsRoot()
}

export const TEMPLATES_ROOT = resolveTemplatesRoot()

/**
 * Resolve the projects root AND make sure the directory exists.
 *
 * Call this from write paths only. Read paths (`listProjects`, `getProjectDir`)
 * use `projectsRoot()` and tolerate a missing directory, so a read can never
 * create one — that is what let a stray import materialise folders in the
 * developer's real storage location.
 */
export function ensureProjectsRoot(): string {
  const root = projectsRoot()
  // Asserted unconditionally, not just when the directory has to be created:
  // the real hazard is a test writing INTO the developer's existing projects
  // folder, which no `existsSync` check would ever notice.
  assertWriteIsolatedInTests(root, 'projects-root')

  // v1.4.6 — NEVER conjure a Library that has been chosen and is not there.
  //
  // A dozen ordinary read paths reach this — the niche, character, topic-pack
  // and thumbnail-template loaders all create a dot-folder under the root — so
  // an unplugged drive meant the next page load ran `mkdir -p` on the missing
  // Library and brought it back as an EMPTY folder. Two bad things followed:
  //
  //   1. `exists` flipped true, so the honest "your Library is not available,
  //      here is where I looked" was replaced by a silent "you have no
  //      channels" — the exact failure that message was written to prevent.
  //   2. On an external volume, `mkdir -p /Volumes/Drive/Library` creates a
  //      LOCAL folder standing where the mount point belongs, which can then
  //      stop the real drive mounting there at all.
  //
  // Refusing is right: there is nothing to write into a Library that is not
  // present, and the caller failing loudly is how the customer finds out.
  if (isLibraryConfigured() && !existsSync(root)) {
    const err: any = new Error(
      `Your Library is not available. Story Studio looked for "${root}" and it is not there. `
      + 'If it is on a drive that is not plugged in, reconnect it. Nothing has been lost.',
    )
    err.statusCode = 409
    err.code = 'LIBRARY_UNAVAILABLE'
    err.expose = true
    throw err
  }

  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

/** Has a Library been chosen on this machine? Sync, for the guard above. */
export function isLibraryConfigured(): boolean {
  if (process.env.STORY_STUDIO_DATA_DIR) return false
  return !!(readSettingSync('library_root') || readSettingSync('projects_root_override'))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return sanitizeProjectSlug(name)
}

/**
 * Pick a slug that doesn't collide with any existing project directory.
 *
 * The lookup is case-insensitive on purpose: APFS, HFS+, and default NTFS
 * volumes treat "Foo" and "foo" as the same entry, while ext4 on Linux
 * does not. If we deduped with a plain `existsSync` we'd allow two
 * projects whose slugs differ only in case on Linux, then break the first
 * time that folder was copied onto a case-insensitive disk. Comparing
 * lowercased entries once up front avoids the surprise.
 */
function uniqueSlug(base: string): string {
  let existing: Set<string>
  try {
    const entries = require('fs').readdirSync(projectsRoot()) as string[]
    existing = new Set(entries.map((e) => e.toLowerCase()))
  } catch {
    existing = new Set<string>()
  }

  if (!existing.has(base.toLowerCase())) return base

  let counter = 2
  while (existing.has(`${base}-${counter}`.toLowerCase())) counter++
  return `${base}-${counter}`
}

/**
 * Thrown when a project JSON file exists but can't be parsed. Read-modify-write
 * callers MUST NOT swallow this — silently returning `{}` and merging updates
 * back replaces the file with the merged-into-empty object, wiping the rest of
 * the metadata (see docs/architecture/security-reliability.md).
 *
 * Pure readers may catch and degrade to "unavailable" / skip-this-entry;
 * writers must propagate so the request fails loudly rather than corrupting
 * further. `expose` + `status` are read by the Express error middleware in
 * app.ts so the UI sees the message instead of "Internal server error".
 */
export class JsonCorruptError extends Error {
  readonly code = 'JSON_CORRUPT' as const
  readonly status = 409
  readonly expose = true
  readonly filePath: string
  constructor(filePath: string, cause: Error) {
    super(
      `${path.basename(filePath)} is corrupted and cannot be parsed (${cause.message}). ` +
      `Restore from a backup or re-run setup — refusing to overwrite to avoid data loss.`,
    )
    this.name = 'JsonCorruptError'
    this.filePath = filePath
    ;(this as any).cause = cause
  }
}

/**
 * Read and parse a JSON file.
 * - ENOENT → returns `{}` (fresh-file default; most callers existsSync first).
 * - Parse error → throws `JsonCorruptError` so read-modify-write paths abort
 *   rather than writing `{ ...{}, ...updates }` on top of the corrupt file.
 * - Other FS errors (EACCES, EISDIR, …) → propagate; silently defaulting those
 *   to `{}` would destroy data on the next write, same as a parse error.
 */
async function readJson(filePath: string): Promise<any> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf-8')
  } catch (e: any) {
    if (e.code === 'ENOENT') return {}
    throw e
  }
  try {
    return JSON.parse(text)
  } catch (e: any) {
    throw new JsonCorruptError(filePath, e)
  }
}

async function writeJson(filePath: string, data: any): Promise<void> {
  // All project JSON writes go through withLock + atomic rename to protect
  // concurrent read-modify-write on the same file (e.g. two updateConfig calls).
  await withLock(filePath, async () => {
    await writeJsonAtomic(filePath, data)
  })
}

/**
 * Mirror the project's structural metadata to a portable manifest cache.
 * Called after every metadata change so another machine can recognise this
 * folder as a Story Studio project
 * (and anchors a stable `project_id` for relocate detection). Best-effort:
 * a sync folder being offline must not break the save — we log and move on.
 *
 * Also backfills a stable `project_id` into `project.json` the first time
 * it runs, so the manifest and pointer use a consistent UUID thereafter.
 *
 * Schema v2 only carries structural fields — no presets, no production
 * standards, no YouTube templates. Those are intentionally per-machine
 * (see `manifest.ts` and the PortableManifest doc comment).
 *
 * There used to be a second write, into the episodes folder itself, taken
 * only when that folder sat OUTSIDE the project directory. Since episodes
 * always live at `<projectDir>/episodes` no project can be external any
 * more, so that branch could never fire and is gone; the cache beside
 * `project.json` is the only manifest, and it travels with the folder.
 */
async function syncManifest(slug: string): Promise<void> {
  try {
    const projectDir = getProjectDir(slug) || path.join(projectsRoot(), slug)
    const metaPath = path.join(projectDir, 'project.json')
    if (!existsSync(metaPath)) return
    const meta: ProjectMeta = await readJson(metaPath)

    // Backfill project_id if missing. Re-persist meta only when we had to
    // generate one — avoid a spurious write on every subsequent save.
    if (!meta.project_id) {
      meta.project_id = randomUUID()
      await withLock(metaPath, async () => {
        const current = await readJson(metaPath)
        current.project_id = meta.project_id
        await writeJsonAtomic(metaPath, current)
      })
    }

    const { path: outputRoot } = resolveOutputRoot(projectDir)

    const manifest = buildManifest(meta, outputRoot, getMachineLabel())

    try {
      await writeManifestCache(projectDir, manifest)
    } catch (e: any) {
      console.warn(`[projects] syncManifest: could not write cache for ${slug}:`, e.message)
    }
  } catch (e: any) {
    console.warn(`[projects] syncManifest failed for ${slug}:`, e.message)
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

// (Removed: reconcilePortableFlagsAtStartup. The `portable` project
// flag was the multi-machine-vs-local distinction for the legacy
// manifest-sync feature; now all projects are equivalent and the
// flag is unused. Existing project.json files in the wild may still
// carry `portable: true` — that's fine, we just ignore it.)

export async function listProjects(): Promise<ProjectSummary[]> {
  // v1.4.3 — the Library scan, and nothing else.
  //
  // This used to merge two sources: the folder scan plus a per-Mac
  // `linked_project_paths` registry of folders living anywhere on disk. The
  // owner removed the second idea outright: *"i want to just copy and paste a
  // folder and then connect it. i don't want connection like in the past where
  // i have to link and stuff."* A channel is a folder in the Library that
  // contains a project.json. Copy one in and it appears; take it out and it is
  // gone. There is nothing to register, and so nothing that can disagree with
  // what is actually on disk.
  type Candidate = { dir: string; folderName: string }
  const candidates: Candidate[] = []
  const seenSlugs = new Set<string>()

  // Soft-deleted slugs (the user clicked "Delete project" but we kept
  // the folder on disk). These should not surface in the live list —
  // the home-page "🗑️ Hidden projects" panel surfaces them separately
  // via /soft-deleted-projects.
  const softDeleted = await getSoftDeletedSlugSet()

  // Resolved once per call, not once per process — and reused across the
  // loop below so a listing doesn't re-resolve for every entry.
  const root = projectsRoot()
  let defaultEntries: string[] = []
  try {
    defaultEntries = await fs.readdir(root)
  } catch {
    // The Library is not readable — an unplugged drive, or a folder that has
    // been moved. Returning an empty list here would be the 1.4.2 defect all
    // over again, so the ROUTE checks the Library first and says where it
    // looked; this stays quiet rather than inventing a second message.
  }
  for (const name of defaultEntries.sort()) {
    if (name.startsWith('.')) continue
    // Backup folders left behind by Move this project to… (delete_source
    // off) — the user can verify + restore them but they shouldn't show
    // up as live projects in the list.
    if (/\.bak-/.test(name)) continue
    candidates.push({ dir: path.join(root, name), folderName: name })
  }

  const { readSecrets } = await import('./secrets-store.js')

  // Process every project in parallel. Each candidate is independent
  // (distinct project.json / config.json / secrets.json reads), so this
  // collapses ~N×latency into a single round-trip. At 20+ projects the
  // diff is the difference between snappy and "feels frozen" on home-page
  // load. Returns null for corrupt/missing entries — filtered out below.
  //
  // v1.4.3 — the iCloud-aware path is gone. It probed for a
  // `.<basename>.icloud` stub and reported the row as 'downloading' rather than
  // reading it, because a read would block inside macOS's sync layer. With
  // iCloud support withdrawn the Library is an ordinary folder, so a
  // project.json that is not there is simply not there.
  //
  // The 30-second read timeout STAYS. Its original reason was iCloud, but a
  // read that never returns hangs the whole home page whatever the cause — a
  // stalled network volume or a disk going bad do it too — and the timeout is
  // the only thing that turns that into one slow row instead of a dead app.
  const READ_TIMEOUT_MS = 30_000
  const summaries = await Promise.all(candidates.map(async (cand): Promise<ProjectSummary | null> => {
    const metaPath = path.join(cand.dir, 'project.json')

    let meta: ProjectMeta
    let timer: NodeJS.Timeout | undefined
    let outputRoot: { path: string; exists: boolean }
    try {
      // Race the read against a 30s timeout. Clearing the timer in
      // `finally` is critical: an unbounded setTimeout keeps Node's
      // event loop alive past test completion (and after every
      // listProjects call in the running app), so the test runner hangs
      // and the dev process leaks pending timers per request.
      const timeoutPromise = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('READ_TIMEOUT')), READ_TIMEOUT_MS)
      })
      // Both membership checks are INSIDE the race now, and both are async.
      //
      // They used to be bare synchronous `existsSync` calls sitting outside it:
      // the presence of `project.json`, and the presence of `episodes/`. The
      // timeout was written to stop one bad folder from hanging the home page,
      // but it only ever guarded the JSON read in the middle — so a folder on a
      // stalled volume blocked on the very first `existsSync`, before the race
      // it was supposed to be protected by even began, and blocked the whole
      // process while it did it because the call was synchronous. Two of the
      // three disk touches per channel were outside the guard.
      const readAll = (async () => {
        // A folder with no project.json is not a channel. That is the whole
        // membership rule now.
        const present = await fs.access(metaPath).then(() => true, () => false)
        if (!present) return null
        const parsed = await readJson(metaPath) as ProjectMeta
        // Still checked, deliberately. Removing the ability to CHOOSE the
        // folder does not make the folder certain to be there — one whose
        // `episodes/` was moved in Finder is still missing it. The whole point
        // of the Origin Field fix was that the app must say so rather than
        // render an empty channel, so the check stays; it is simply inside the
        // timeout now, like everything else that touches this disk.
        return { parsed, output: await resolveOutputRootAsync(cand.dir) }
      })()
      const raced = await Promise.race([readAll, timeoutPromise])
      if (!raced) return null
      meta = raced.parsed
      outputRoot = raced.output
    } catch (e: any) {
      // The read never came back. Surface the row rather than dropping it, so
      // a channel that is there but unreadable is visible as a problem instead
      // of silently absent. Other errors (corrupt JSON, permission denied) take
      // the existing skip-and-warn path.
      if (e?.message === 'READ_TIMEOUT') {
        console.warn(`[projects] listProjects: '${cand.folderName}' read timed out after ${READ_TIMEOUT_MS}ms`)
        return {
          name: cand.folderName,
          slug: cand.folderName,
          episode_prefix: '',
          created_at: '',
          has_api_keys: false,
          // Exact even here: project.json is unreadable, but the episodes
          // folder no longer depends on anything inside it.
          output_root: path.join(cand.dir, 'episodes'),
          status: 'downloading',
        }
      }
      console.warn(`[projects] listProjects: skipping '${cand.folderName}' — ${e.message}`)
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
    // Slug from project.json wins; fall back to folder name only when
    // the field is absent (older projects or hand-rolled folders).
    const slug = (typeof meta.slug === 'string' && meta.slug) ? meta.slug : cand.folderName
    if (seenSlugs.has(slug)) return null  // dedupe — default already captured this slug
    if (softDeleted.has(slug)) return null  // hidden via soft-delete tombstone
    seenSlugs.add(slug)

    const secrets = await readSecrets(slug)

    const { path: outputRootAbs, exists: outputRootExists } = outputRoot

    return {
      name: meta.name,
      slug,
      episode_prefix: meta.episode_prefix,
      created_at: meta.created_at,
      has_api_keys: !!secrets.genstudio_api_key,
      // (Removed: portable field. All projects are equivalent now;
      // the synced badge it powered is gone.)
      output_root: outputRootAbs,
      output_root_exists: outputRootExists,
      // v1.0.302 — surfaced so the home-page card can show which format the
      // project follows. Raw id only (e.g. 'narrated-scenes' or the legacy
      // 'sleep-story' alias); the frontend maps it to a friendly name via the
      // format registry, so this stays correct even as formats are renamed.
      format_id: typeof meta.format_id === 'string' ? meta.format_id : undefined,
      niche_id: typeof meta.niche_id === 'string' && meta.niche_id ? meta.niche_id : undefined,
      status: 'ready',
    }
  }))

  return summaries.filter((s): s is ProjectSummary => s !== null)
}

/**
 * Where a project's episodes live, and whether that folder is there.
 *
 * Always `<projectDir>/episodes`. There is no stored setting behind this and
 * no parameter to override it — that is the whole change.
 *
 * ── Why the flexible version went (the Origin Field defect) ──
 *
 * `project.json` used to carry an `output_root` that could be absolute or
 * relative, and this function resolved it. One project stored
 * `../Origin Field/episodes`, which resolved to a folder that did not exist,
 * so the channel opened empty and nothing on screen explained why. Every one
 * of the owner's real projects stored the default and nothing else, so the
 * flexibility bought nobody anything and cost one broken channel. It is gone,
 * along with the folder picker, the storage normaliser, and the external
 * import path that only existed to serve it.
 *
 * One function, because the home page and the project page must not be able to
 * disagree about whether a project is reachable — the whole point of surfacing
 * this is that a person can trust it. `getProjectOutputRoot()` below is the
 * async, slug-keyed twin for the ~40 callers that only have a slug; the two
 * must always agree, and both now agree by construction rather than by
 * reading the same field carefully.
 *
 * `exists` is computed and returned honestly. This never creates the folder:
 * a missing episodes folder is a fact to report, not one to paper over.
 */
export function resolveOutputRoot(projectDir: string): { path: string; exists: boolean } {
  const abs = path.join(projectDir, 'episodes')
  return { path: abs, exists: existsSync(abs) }
}

/**
 * The async twin of `resolveOutputRoot`, for callers on a request path.
 *
 * Identical answer, computed without blocking the event loop. `listProjects`
 * uses this so its existence check can sit inside the 30-second race that
 * already guards the JSON read: a stalled volume then costs one slow row rather
 * than a frozen process. The sync version stays for the callers that are not on
 * a hot path and would gain nothing from an await.
 */
export async function resolveOutputRootAsync(
  projectDir: string,
): Promise<{ path: string; exists: boolean }> {
  const abs = path.join(projectDir, 'episodes')
  const exists = await fs.access(abs).then(() => true, () => false)
  return { path: abs, exists }
}

export async function getProject(slug: string): Promise<ProjectMeta | null> {
  // Resolve via getProjectDir so a project is found wherever it sits in the
  // Library.
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const metaPath = path.join(projectDir, 'project.json')
  if (!existsSync(metaPath)) return null
  // A corrupt project.json should surface as a 409 to the UI (via the error
  // middleware), not a 404 "Project not found" — the project exists, we just
  // can't read its metadata. Let JsonCorruptError propagate.
  return await readJson(metaPath)
}

/**
 * Coherent project metadata read for cross-file transactions. Callers that
 * also touch Content Pack state acquire coordination/state before entering
 * this project-file lock.
 */
export async function readProjectMetaConsistently(slug: string): Promise<ProjectMeta | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const metaPath = path.join(projectDir, 'project.json')
  if (!existsSync(metaPath)) return null
  return withLock(metaPath, async () => readJson(metaPath))
}

/** Atomic project.json mutation used by Content Pack pin transactions. */
export async function mutateProjectMetaConsistently(
  slug: string,
  mutate: (project: ProjectMeta) => void,
): Promise<ProjectMeta | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const metaPath = path.join(projectDir, 'project.json')
  if (!existsSync(metaPath)) return null
  let updated: ProjectMeta | null = null
  await withLock(metaPath, async () => {
    const project = await readJson(metaPath) as ProjectMeta
    mutate(project)
    await writeJsonAtomic(metaPath, project)
    updated = structuredClone(project)
  })
  await syncManifest(slug)
  return updated
}

/**
 * The Scene Plan preset a NEW channel starts with (owner decision, 2026-10-19):
 * the owner's standard tiered rhythm under a name the owner recognises, so the
 * channel's first episode opens on it and the preset can be re-applied to any
 * later episode.
 *
 * It deliberately carries NO writing model. A model is a live GenStudio choice
 * (AGENTS.md §1) and a channel must not have one baked in by us; the owner
 * picks one in Scene Plan and saves the preset there, exactly as with a preset
 * saved by hand. `motion_scope`/`motion_level` are the same defaults
 * `defaultContinuityConfig` starts an episode with, and are part of the panel's
 * own snapshot shape.
 */
const OWNER_STANDARD_PACING_PRESET_ID = 'preset-owner-standard-pacing'

function ownerStandardPacingPreset(): Record<string, unknown> {
  return {
    id: OWNER_STANDARD_PACING_PRESET_ID,
    name: 'Owner standard pacing',
    type: 'scene-plan',
    data: {
      pacing: structuredClone(OWNER_STANDARD_SCENE_PACING),
      motion_scope: { mode: 'off' },
      motion_level: 2,
    },
  }
}

/**
 * The Thumbnail Prompts preset a NEW channel starts with (owner, 2026-10-25):
 * *"from now on all thumbnail prompts and generation is required to have 3
 * each, so I have something to choose from."* He asked for it to be "set as a
 * preset and saved for any new channels later on, but I guess you can make it a
 * default" — so three is the starting COUNT here, not a hard rule: it is an
 * ordinary editable preset from the moment the channel exists, and the counter
 * on the Thumbnail Prompts page changes it for any later episode.
 *
 * It deliberately carries NO model. Story Studio never picks a writing or an
 * image model (AGENTS §1 and §7; owner 2026-10-17) — the channel's own preset
 * names one when the owner saves it on the Thumbnail Prompts page, exactly as
 * with a hand-saved preset. The Pipeline preflight counts this seeded preset as
 * UNUSABLE until then and says "choose a writing model" rather than enqueuing a
 * run that would fail inside its generator.
 *
 * Only ONE preset is seeded, because the count lives only here: the Thumbnail
 * GENERATOR's page has no count of its own (the images follow the prompts), so a
 * seeded `thumbnail_generator_presets` entry could carry nothing but a model —
 * which is the one thing a seed must not choose.
 */
const NEW_CHANNEL_THUMBNAIL_PRESET_ID = 'preset-new-channel-thumbnails'

function newChannelThumbnailPromptsPreset(): Record<string, unknown> {
  return {
    id: NEW_CHANNEL_THUMBNAIL_PRESET_ID,
    name: 'Three thumbnail options',
    data: { form: { thumb_count: DEFAULT_THUMBNAIL_COUNT } },
  }
}

export async function createProject(
  req: CreateProjectRequest,
  initialContentPins: Pick<ProjectMeta, 'content_pack_versions' | 'content_pack_items'> = {},
): Promise<ProjectMeta> {
  const slug = uniqueSlug(slugify(req.name))
  const projectDir = path.join(ensureProjectsRoot(), slug)
  // If a tombstone exists for this slug, clear it — the user is
  // explicitly creating a project here; honour that over a stale
  // "this slug was hidden earlier" memory. Cheap idempotent call.
  await forgetSoftDeletedProject(slug).catch(() => { /* non-fatal */ })

  // (Removed: the resolve-and-validate block for a user-picked episodes
  // folder — the scoping to {chosenFolder}/{ProjectName}, the `episodes/`
  // nesting that made a picked folder match the default shape, and the
  // write-access probe. A channel's episodes now always live at
  // `<projectDir>/episodes`, created below, so there is nothing to resolve
  // and nowhere else to probe.)

  // New channels always begin from the adaptive blank base. Do not honor a
  // template supplied by an older client: the former blank/sleep-story fork
  // bundled stale production assumptions into new channels.
  const templateDir = path.join(TEMPLATES_ROOT, 'blank')
  if (existsSync(templateDir)) {
    await fs.cp(templateDir, projectDir, { recursive: true })
  } else {
    await fs.mkdir(projectDir, { recursive: true })
  }

  // Build metadata
  const meta: ProjectMeta = {
    name: req.name,
    slug,
    project_id: randomUUID(),
    // (Removed: portable field. All projects are equivalent — cloud
    // sync is configured app-wide via Settings → Storage, not per
    // project. The .story-studio-project.json manifest is still
    // written into every project folder by syncManifest, so projects
    // remain importable across machines via the project_id stamp.)
    episode_prefix: req.episode_prefix || 'EP',
    episode_digits: req.episode_digits || 4,
    season_size: req.season_size || 20,
    season_prefix: req.season_prefix || 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: { ...DEFAULT_SUBFOLDER_NAMES },
    created_at: new Date().toISOString(),
    // New channels use the one continuity workflow. Existing projects retain
    // their persisted format, and Settings remains the explicit place to
    // change it after creation.
    format_id: 'continuity-chain',
    continuity_mode: req.continuity_mode || 'independent-stills',
    // Niche is optional (subject-domain layer, orthogonal to format).
    // Unset = no niche, generators behave exactly like format defaults.
    // We trust the wizard to pass a valid id; the niche-loader logs and
    // falls back to null on missing files so a stale id doesn't break
    // the project.
    ...(req.niche_id ? { niche_id: req.niche_id } : {}),
    ...(req.topic_pack_ids?.length ? { topic_pack_ids: [...new Set(req.topic_pack_ids)] } : {}),
    // Absent stays absent: a legacy create must not gain a language field and
    // change prompt bytes. The two-value enum is the whole catalogue.
    ...(req.content_language ? { content_language: req.content_language } : {}),
    // Default OFF: only an explicit true is persisted.
    ...(req.auto_introduction_enabled === true ? { auto_introduction_enabled: true } : {}),
    ...(initialContentPins.content_pack_versions
      ? { content_pack_versions: structuredClone(initialContentPins.content_pack_versions) }
      : {}),
    ...(initialContentPins.content_pack_items
      ? { content_pack_items: structuredClone(initialContentPins.content_pack_items) }
      : {}),
  }

  // Merge with any template defaults
  const existing = await readJson(path.join(projectDir, 'project.json'))
  await writeJson(path.join(projectDir, 'project.json'), { ...existing, ...meta })

  // Ensure config.json exists. API keys live in a sibling secrets.json file
  // (see secrets-store.ts) rather than here — keeps secrets out of config
  // diffs/exports and lets us lock the file down to 0600.
  //
  // In practice this is a MERGE, not a first write: the blank template already
  // ships a config.json (`electron/templates/blank/config.json`), so the copy
  // above has already placed one. Reading it first keeps whatever the template
  // declares, and is what lets the seed below run on the real creation path
  // rather than in a block that never executes.
  const configPath = path.join(projectDir, 'config.json')
  const templateConfig = existsSync(configPath) ? await readJson(configPath) as Record<string, unknown> : null
  await writeJson(configPath, {
    ...(templateConfig ?? {
      image_models: { ...DEFAULT_IMAGE_MODELS },
      voice_presets: [...DEFAULT_VOICE_PRESETS],
      audio_models: { ...DEFAULT_AUDIO_MODELS },
      video_models: { ...DEFAULT_VIDEO_MODELS },
      image_pricing_last_updated: '', audio_pricing_last_updated: '', video_pricing_last_updated: '',
      // Operational audio-quality work is opt-in for every new channel.
      audio_quality: { mode: 'off' },
      // v1.4.20 — the channel's publishing rhythm, chosen at creation. Only
      // written when the caller supplied one: an absent cadence must stay
      // absent rather than become a default nobody chose, because
      // `ensurePlanForAccount` treats "has a cadence" as permission to make a
      // plan on the owner's behalf.
      ...(req.publish_cadence?.schedule ? { publish_cadence: {
        schedule: req.publish_cadence.schedule,
        defaults: req.publish_cadence.defaults
          || { privacy_status: 'private', made_for_kids: false },
      } } : {}),
      ...(req.auto_schedule_on_render === true ? { auto_schedule_on_render: true } : {}),
    }),
    // Owner decision, 2026-10-19 — a NEW channel starts with the owner's
    // standard tiered rhythm (see OWNER_STANDARD_SCENE_PACING): the channel's
    // own starting pacing, which every episode reads until it saves its own,
    // plus the Scene Plan preset of the same rhythm marked last-used. Both are
    // ordinary editable settings from then on, an episode still changes its
    // rhythm in Scene Plan's Visual timing & motion panel, and this runs only
    // at creation, so no existing channel is ever rewritten.
    //
    // A channel whose Series Formula names its own starting scene length
    // overwrites `default_scene_pacing` afterwards
    // (services/formula-starting-defaults.ts) — the Formula is the more
    // specific choice, and the preset stays available by name either way.
    default_scene_pacing: structuredClone(OWNER_STANDARD_SCENE_PACING),
    scene_plan_presets: [ownerStandardPacingPreset()],
    'scene_plan_last_preset_scene-plan': OWNER_STANDARD_PACING_PRESET_ID,
    // Owner decision, 2026-10-25 — a NEW channel's thumbnail work starts at
    // three prompts (and therefore three candidate images), as an ordinary
    // Thumbnail Prompts preset marked last-used, naming no model. See
    // `newChannelThumbnailPromptsPreset`. Written only here, at creation, so an
    // existing channel is never rewritten and nothing already on disk is
    // backfilled: episodes that were complete under their own count stay
    // complete, and an accepted thumbnail is never regenerated or replaced.
    thumbnail_prompts_presets: [newChannelThumbnailPromptsPreset()],
    thumbnail_prompts_last_preset: NEW_CHANNEL_THUMBNAIL_PRESET_ID,
  })
  // No per-project secrets.json is seeded — API keys live in the
  // app-level store (see app-secrets-store.ts). YouTube OAuth state is
  // the only thing that still goes into a per-project secrets.json,
  // and it's written on demand the first time a channel is connected.

  // Ensure production_standards.txt exists
  const standardsPath = path.join(projectDir, 'production_standards.txt')
  if (!existsSync(standardsPath)) {
    await fs.writeFile(standardsPath, '# Production Standards\n\nAdd your story generation guidelines here.\n')
  }

  // Ensure episodes dir + jobs.json.
  //
  // (Removed: the v1.0.326 guard that skipped this mkdir when the project dir
  // was itself named 'episodes'.) It was aimed at the legacy nested-import
  // shape, where the folder a person registered WAS the episodes root, and it
  // was in the wrong function to do that — `createProject` always makes
  // `<projectsRoot>/<slug>`, so the only thing the guard ever caught was a
  // channel the person named "Episodes". That channel then never got its
  // episodes folder, and now reports "Folder missing" forever, because
  // `resolveOutputRoot` looks for `<projectDir>/episodes` unconditionally.
  // The import path the guard was written for is gone; the folder every
  // channel needs is not optional.
  await fs.mkdir(path.join(projectDir, 'episodes'), { recursive: true })
  const jobsPath = path.join(projectDir, 'jobs.json')
  if (!existsSync(jobsPath)) await writeJson(jobsPath, { jobs: [] })

  // Stage 2: mirror initial metadata + presets into the portable manifest.
  // Best-effort — never blocks project creation if the sync folder is
  // temporarily unreachable.
  await syncManifest(slug)

  return meta
}

export async function updateProject(slug: string, req: UpdateProjectRequest): Promise<ProjectMeta | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const metaPath = path.join(projectDir, 'project.json')
  if (!existsSync(metaPath)) return null
  let merged: ProjectMeta | null = null
  let changed = false
  await withLock(metaPath, async () => {
    const data = await readJson(metaPath)
    const updates = Object.fromEntries(Object.entries(req).filter(([_, v]) => v !== undefined))
    merged = { ...data, ...updates } as ProjectMeta
    // A no-op save must not touch project.json: every episode-status row
    // depends on its mtime, so a rewrite stales the whole Production Board.
    changed = JSON.stringify(merged) !== JSON.stringify(data)
    if (changed) await writeJsonAtomic(metaPath, merged)
  })
  if (changed) await syncManifest(slug)
  return merged
}

/**
 * Result of a non-destructive delete. The dialog uses these fields to
 * tell the user "your files are still at <path> — open in Finder?".
 */
export interface DeleteProjectResult {
  /** True iff the project actually existed before the call. */
  ok: boolean
  /** What we did:
   *  - 'soft_deleted': default-location project, slug added to the
   *    soft-delete tombstone list. Folder untouched on disk.
   */
  disposition?: 'soft_deleted'
  /** Absolute path that's now orphaned on disk — what the dialog
   *  shows + what the "Open in Finder" button reveals. */
  orphan_path?: string
  /** Human name from project.json so the dialog can say
   *  "<Project Name> files are still at …" rather than just the slug. */
  name?: string
}

/**
 * Soft-delete a project: unregister it from the app, leave every byte on disk.
 * The user gets a banner naming the path; the home page's "🗑️ Hidden channels"
 * panel surfaces it for restore or an explicit hard-delete.
 *
 * The folder stays in the Library and would be picked up by the next scan, so
 * the slug is recorded in `soft_deleted_slugs` and `listProjects` filters by
 * that set. v1.4.3 removed the second branch this used to have for projects
 * outside the Library, because there are none.
 */
export async function deleteProject(slug: string): Promise<DeleteProjectResult> {
  const projectDir = getProjectDir(slug)
  if (!projectDir || !existsSync(projectDir)) return { ok: false }
  const { withProjectJobRemovalGuard } = await import('./job-queue.js')
  return withProjectJobRemovalGuard(slug, projectDir, async () => {
    // Best-effort read of project.json so the post-delete dialog can
    // show the human name. Missing/corrupt project.json is non-fatal —
    // the dialog falls back to the slug.
    let meta: ProjectMeta | null = null
    try {
      const raw = await readJson(path.join(projectDir, 'project.json'))
      meta = raw as ProjectMeta
    } catch { /* fall through */ }

    // v1.4.3 — one disposition. Every project lives in the Library now, so
    // hiding one always means the soft-delete tombstone; the 'unlinked' branch
    // that used to unregister an outside-the-Library folder went with the
    // registry itself. The folder is never touched either way.
    const { softDeleteProjectAfterGuard } = await import('./soft-delete.js')
    await softDeleteProjectAfterGuard(slug)
    return {
      ok: true,
      disposition: 'soft_deleted',
      orphan_path: projectDir,
      name: meta?.name || slug,
    }
  })
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Per-entry shallow merge of a built-in default catalog with a project's
 * on-disk override. For each model id:
 *   - If only the default has it → carry the default through (new model).
 *   - If only the project has it → drop it. Model inventory is application-
 *     managed now; arbitrary project-level custom models are retired.
 *   - If both have it → merge `{ ...default, ...project }` so user-edited
 *     fields win on conflict, but default-only fields (e.g. `tiers` /
 *     `default_tier` added in a later release) flow through to the
 *     existing project without forcing a config rewrite.
 *
 * The previous full-dict override hid every new field behind whatever
 * shape was on disk, which is why the 2026-04-28 Kie.ai tier additions
 * didn't surface for existing projects until this merge changed.
 */
/**
 * Provider infrastructure fields — slug, endpoint, poll URL, payload type,
 * and the kie.ai-specific i2i slug override + ref/aspect field names —
 * MUST come from defaults, not from the project's saved config. When a
 * provider changes their model slug (kie.ai shipped `nano-banana-2` after
 * we'd already saved `google/nano-banana-2` per-project, breaking every
 * existing project), the user-customizable shell (label / credits /
 * tiers / prompt_char_cap) preserves their customisations but the wiring
 * gets re-pointed automatically.
 */
const PROVIDER_INFRA_FIELDS = new Set([
  'api_model', 'api_model_i2i', 'endpoint', 'poll', 'type',
  'refs_field', 'refs_upload', 'aspect_field', 'provider', 'provider_params', 'input_params', 'supports_reference_images',
  'is_custom',
])

export function mergeCatalog<T extends Record<string, any>>(
  defaults: Record<string, T>,
  saved: Record<string, T> | null | undefined,
): Record<string, T> {
  const out: Record<string, T> = {}
  // Start with defaults so new ids appear unconditionally.
  for (const [id, def] of Object.entries(defaults)) {
    const projectEntry = saved?.[id]
    if (!projectEntry) {
      out[id] = def
      continue
    }
    // saved entries win for user-customisable fields BUT infrastructure
    // fields (slug, endpoint, ref field names) always come from defaults
    // so provider-side slug changes auto-propagate.
    const merged: any = { ...def, ...projectEntry }
    for (const k of PROVIDER_INFRA_FIELDS) {
      if (def && k in def) merged[k] = (def as any)[k]
      else if (projectEntry && !(k in def)) delete merged[k]
    }
    out[id] = merged as T
  }
  return out
}

/**
 * Remove the retired per-job TTS chunk override from every saved Audio
 * Generator preset shape. Older releases stored it under `data.form`, while
 * imported presets can carry it at the root, so this deliberately walks the
 * complete preset tree. Current model limits remain in `audio_models`.
 */
export function sanitizeAudioGeneratorPresets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAudioGeneratorPresets)
  if (!value || typeof value !== 'object') return value
  const clean: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'max_chunk_chars') continue
    clean[key] = sanitizeAudioGeneratorPresets(child)
  }
  return clean
}

/**
 * Story Studio keeps no local TTS product catalogue. The customer picks a model
 * from GenStudio's live `/v1/tts/models` and is charged by it, so there is
 * nothing here to synthesise. Historical `audio_models` stay untouched on disk
 * as audit/import evidence and never become executable configuration.
 */
export function genStudioOnlyAudioModels(
  _saved: Record<string, AudioModelConfig> | null | undefined,
): Record<string, AudioModelConfig> {
  void _saved
  return {}
}

export function isPresetConfigKey(key: string): boolean {
  return key.endsWith('_presets') || /_last_preset(?:_[a-z0-9-]+)?$/.test(key)
}

function migratePresetField(_key: string, value: unknown): unknown { return value }

/**
 * Migrate every reusable preset family, including future generators, instead
 * of maintaining a brittle allow-list. Audio presets also lose the retired
 * per-job chunk override. This mutates the supplied config so any subsequent
 * settings save persists the complete migration in one atomic write.
 */
export function migrateProjectPresetFields<T extends Record<string, any>>(config: T): T {
  const mutable = config as Record<string, any>
  for (const key of Object.keys(config)) {
    if (!isPresetConfigKey(key)) continue
    const clean = key === 'audio_generator_presets'
      ? sanitizeAudioGeneratorPresets(mutable[key])
      : mutable[key]
    mutable[key] = migratePresetField(key, clean)
  }
  return config
}

export async function getConfig(slug: string): Promise<ProjectConfig | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(configPath)) return null
  const raw = await readJson(configPath)
  migrateProjectPresetFields(raw)
  raw.audio_quality = normalizeAudioQualityConfig(raw.audio_quality)

  // Merge defaults into each catalog so new default entries (e.g. new
  // ElevenLabs models) surface in existing projects without forcing
  // recreation. We do NOT write to disk — if the user edits a model in
  // Settings → Models and saves, updateConfig will persist whatever's
  // in the reactive state.
  //
  // Per-entry shallow merge (NOT per-dict): for ids that exist in BOTH
  // the default catalog and the project's saved config, we want
  // user-edited fields (custom label, custom credits_per_image) to win
  // BUT new default-only fields (e.g. tiers/default_tier added in the
  // 2026-04-28 Kie.ai pricing refresh) to flow through to existing
  // projects. The previous full-object override hid every new field
  // behind whatever shape was on disk, so existing projects never saw
  // tier-aware pricing despite running a tier-aware build.
  raw.image_models = mergeCatalog(DEFAULT_IMAGE_MODELS, raw.image_models)
  const savedAudioModels = raw.audio_models
  raw.audio_models = genStudioOnlyAudioModels(savedAudioModels)
  raw.video_models = sanitizeVideoCatalog(mergeCatalog(DEFAULT_VIDEO_MODELS, raw.video_models))
  if (!raw.voice_presets || !raw.voice_presets.length) {
    raw.voice_presets = [...DEFAULT_VOICE_PRESETS]
  }

  // The retired Add Custom Model feature stored a duplicate unified catalog.
  // Never expose it to callers, even while an older config.json still carries it.
  delete raw.models

  // GenStudio credentials are app-level and never copied into project files.
  const { readSecrets } = await import('./secrets-store.js')
  const secrets = await readSecrets(slug)
  raw.genstudio_api_key = secrets.genstudio_api_key ?? ''
  raw.google_api_key = secrets.google_api_key ?? ''
  return raw
}

/**
 * Operational narration review is project-scoped. Treat legacy, malformed,
 * and absent values as Off rather than silently authorising inspection or paid
 * repair when an unrelated Settings draft is saved.
 */
export function normalizeAudioQualityConfig(value: unknown): { mode: 'off' | 'flag_issues' | 'check_and_repair'; alternate_transcription_model?: string } {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const mode = raw.mode === 'flag_issues' || raw.mode === 'check_and_repair' ? raw.mode : 'off'
  const alternate = typeof raw.alternate_transcription_model === 'string'
    ? raw.alternate_transcription_model.trim()
    : ''
  return { mode, ...(alternate ? { alternate_transcription_model: alternate } : {}) }
}

export async function getSafeConfig(slug: string): Promise<any | null> {
  const config = await getConfig(slug)
  if (!config) return null
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const raw = await readJson(path.join(projectDir, 'config.json'))
  migrateProjectPresetFields(raw)
  // Account list (Delivery 2) — masked values only. The legacy `has_*_key`
  // booleans below stay populated from the default account for any UI
  // surface that hasn't migrated to the accounts map yet.
  const { listAllAccounts } = await import('./secrets-accounts.js')
  const accountsByProvider = await listAllAccounts(slug).catch(() => ({}))

  const safe: any = {
    // The retired LLM lineup's one-time record (what was kept, and whether the
    // Pipeline notice was closed). The lineup itself is never served again.
    llm_lineup_migration: config.llm_lineup_migration,
    has_genstudio_key: !!config.genstudio_api_key,
    has_google_key: !!(config as any).google_api_key,
    // v1.0.150 — Chatterbox standalone provider removed. The
    // chatterbox_enabled / chatterbox_reference_id fields stay in the
    // project.json on disk if they were set in pre-1.0.150 projects, but
    // we no longer surface them in the safe config response — the
    // frontend has nothing left to do with them.
    // Item J — YouTube videoCategories.list ID for fresh uploads + PATCHes.
    // Pass through unchanged; default-22 logic lives in upload-metadata.ts
    // so old projects without the field keep working without migration.
    category_id: typeof (config as any).category_id === 'number'
      ? (config as any).category_id : undefined,
    // v1.4.29 — the channel's publishing rhythm and the switch that gives each
    // finished episode a publish time.
    //
    // BOTH WERE WRITE-ONLY UNTIL NOW, and that is worse than it sounds. This
    // function returns an explicit whitelist; `updateConfig` passes unknown
    // keys through. So 1.4.20's cadence panel SAVED correctly and then read
    // back nothing — it showed an empty form every time it was opened, however
    // carefully the owner had filled it in. If he then pressed Save on that
    // blank form for any reason, it overwrote the real cadence with defaults
    // and silently switched auto-scheduling off.
    //
    // Found because he asked "do i need to tick somewhere?" and the honest
    // answer required reading the setting back, which nothing could do.
    publish_cadence: (config as any).publish_cadence,
    auto_schedule_on_render: (config as any).auto_schedule_on_render === true,
    // Fall back to defaults when the project was created before defaults
    // were seeded (keeps the Settings → Models tab populated for old projects).
    image_models: (config.image_models && Object.keys(config.image_models).length)
      ? config.image_models
      : { ...DEFAULT_IMAGE_MODELS },
    image_pricing_last_updated: config.image_pricing_last_updated || '',
    // Voice curation is now per-machine (app-settings.json); the boot
    // migration merges legacy per-project lists into global. Falls back
    // to the project value during the transition window so a user who
    // upgrades and immediately opens the settings page still sees their
    // curation. After the migration runs once, project-side values are
    // ignored on read but kept on disk so older app builds still see them.
    voice_presets: await (async () => {
      const { getVoicePresetsGlobal } = await import('./app-settings.js')
      const { normalizeVoicePresets, publicVoicePresets } = await import('./voice-presets.js')
      const global = await getVoicePresetsGlobal()
      // publicVoicePresets narrows `providers` to the gateway on the way out.
      // Storage keeps its legacy transport keys; the wire never carries them.
      if (global.length > 0) return publicVoicePresets(global)
      // Pre-migration fallback: per-project value if set, else seeded default.
      if (config.voice_presets && config.voice_presets.length) {
        return publicVoicePresets(normalizeVoicePresets(config.voice_presets))
      }
      return publicVoicePresets(normalizeVoicePresets([...DEFAULT_VOICE_PRESETS]))
    })(),
    voice_favourites: await (async () => {
      const { getVoiceFavouritesGlobal } = await import('./app-settings.js')
      const global = await getVoiceFavouritesGlobal()
      if (global.length > 0) return global
      return Array.isArray(config.voice_favourites) ? config.voice_favourites : []
    })(),
    // User-saved style presets (from /analyze-style or manual entry). Per-
    // project — passes through unchanged. Older configs without the field
    // surface as an empty array so the frontend dropdown stays well-behaved.
    style_presets: Array.isArray((config as any).style_presets)
      ? (config as any).style_presets
      : [],
    // v1.0.518 — the project's active art style id. Echoed so a GET after a
    // save round-trips the value (updateConfig persists it via passthrough,
    // but without this echo the next GET would strip it and the picker's
    // v-model would reset to blank).
    active_style_preset_id: typeof (config as any).active_style_preset_id === 'string'
      ? (config as any).active_style_preset_id
      : undefined,
    // v1.4.1 — per-EPISODE overlay windows, echoed for the same reason
    // `active_style_preset_id` above is. `updateConfig` persists this through
    // the schema's passthrough, but this response is an ALLOW-LIST: without an
    // entry here the value writes to disk correctly and is invisible on the
    // next load, so every overlay would silently come back untimed. It carries
    // episode codes and numbers only — no secrets.
    overlay_time_ranges: (config as any).overlay_time_ranges &&
      typeof (config as any).overlay_time_ranges === 'object'
      ? (config as any).overlay_time_ranges
      : undefined,
    thumbnail_reference_asset: (config as any).thumbnail_reference_asset || undefined,
    // v1.0.337 — continuity guide cast density (0–100; undefined = 40% default).
    character_density: typeof (config as any).character_density === 'number' ? (config as any).character_density : undefined,
    // v1.0.795 — the Scene Plan page's PROJECT-LEVEL settings. Each is written
    // by a PUT to /settings/config (updateConfig persists it via passthrough)
    // and read back through this safe shape — but none of them was echoed, so
    // every GET stripped the saved value and the page re-rendered its default.
    // Same class of bug the active_style_preset_id echo above was added to fix.
    //
    // This was worse than a cosmetic reset. The Scene Plan form seeds its
    // per-run parameters from these fields (`generate_motion_prompts` and
    // `avoid_legible_text` in scene-plan.vue), and a per-run value OUTRANKS the
    // project default in the resolvers. So a project that switched Motion
    // Prompts on, or switched "Avoid readable text" off, silently got the
    // opposite on every run: the page read the missing field as the default and
    // then sent that default as an explicit override. Echoing them makes the
    // saved setting real. A field that was never set stays undefined and
    // resolves to exactly the same default as before.
    default_style_bible: typeof (config as any).default_style_bible === 'string'
      ? (config as any).default_style_bible
      : undefined,
    avoid_legible_text_in_scenes: typeof (config as any).avoid_legible_text_in_scenes === 'boolean'
      ? (config as any).avoid_legible_text_in_scenes
      : undefined,
    motion_prompts_enabled: typeof (config as any).motion_prompts_enabled === 'boolean'
      ? (config as any).motion_prompts_enabled
      : undefined,
    skip_intro_scenes: typeof (config as any).skip_intro_scenes === 'boolean'
      ? (config as any).skip_intro_scenes
      : undefined,
    default_motion_level: typeof (config as any).default_motion_level === 'number'
      ? (config as any).default_motion_level
      : undefined,
    // Scene Plan batch tuning. These replaced a hardcoded 50-scene cap that
    // silently overrode a correct model-aware derivation; each is the owner's
    // number, with NO ceiling in code. Undefined means "never set", which
    // resolves to the documented defaults in
    // `services/scene-prompt-batching.ts` (300 / 0.75 / 250). Echoed here for
    // the same reason as the fields above: `updateConfig` writes them through
    // the passthrough, but this response is an allow-list, so without an entry
    // the saved value would be invisible on the next read and the page would
    // re-render its default.
    scene_prompt_tokens_per_scene: typeof (config as any).scene_prompt_tokens_per_scene === 'number'
      ? (config as any).scene_prompt_tokens_per_scene
      : undefined,
    scene_prompt_output_safety_fraction: typeof (config as any).scene_prompt_output_safety_fraction === 'number'
      ? (config as any).scene_prompt_output_safety_fraction
      : undefined,
    scene_prompt_batch_size: typeof (config as any).scene_prompt_batch_size === 'number'
      ? (config as any).scene_prompt_batch_size
      : undefined,
    // Research page → "Approve claims automatically". Echoed for the same
    // reason as the toggles above: this response is an allow-list, so without
    // an entry the saved value would be invisible on the next read and the
    // page would re-render its default. Undefined means "never set", which
    // resolves to OFF (lib/research-verification.ts).
    research_auto_approve_claims: typeof (config as any).research_auto_approve_claims === 'boolean'
      ? (config as any).research_auto_approve_claims
      : undefined,
    visual_opening_mode: typeof (config as any).visual_opening_mode === 'string'
      ? (config as any).visual_opening_mode
      : undefined,
    // Thumbnail text layer (owner, 2026-10-24). Off unless a channel opts in, so every existing
    // channel is untouched. Echoed here for the same reason as the toggles above: this response is
    // an allow-list, so without an entry the saved value would be invisible on the next read and the
    // page would re-render its default.
    thumbnail_text_layer_enabled: typeof (config as any).thumbnail_text_layer_enabled === 'boolean'
      ? (config as any).thumbnail_text_layer_enabled
      : undefined,
    branded_opening_duration_sec: typeof (config as any).branded_opening_duration_sec === 'number'
      ? (config as any).branded_opening_duration_sec
      : undefined,
    audio_models: (config.audio_models && Object.keys(config.audio_models).length)
      ? config.audio_models
      : { ...DEFAULT_AUDIO_MODELS },
    video_models: ((config as any).video_models && Object.keys((config as any).video_models).length)
      ? (config as any).video_models
      : { ...DEFAULT_VIDEO_MODELS },
    video_pricing_last_updated: (config as any).video_pricing_last_updated || '',
    audio_pricing_last_updated: config.audio_pricing_last_updated || '',
    // Multi-account listing (Delivery 2). Masked keys only; raw apiKey
    // values never leave the server.
    accounts: accountsByProvider,
    // Pass through user settings
    youtube_templates: raw.youtube_templates || undefined,
    youtube_last_template: raw.youtube_last_template || undefined,
    script_settings: raw.script_settings || undefined,
    confirmation_preferences: raw.confirmation_preferences || undefined,
    audio_quality: normalizeAudioQualityConfig(raw.audio_quality),
    intro_standards: raw.intro_standards || '',
    standards_presets: raw.standards_presets || [],
    intro_presets: raw.intro_presets || [],
    // v1.4.73 — what this channel has decided about its episode segments (the
    // opening, and whatever positioned segments follow it later). This echo is
    // load-bearing for exactly the reason the long comment above describes:
    // `updateConfig` writes it to disk through the passthrough, but this
    // response is an allow-list, so without an entry here the saved value
    // would be invisible on the next read and the channel would look as though
    // it had never been asked. Left undefined when the channel has never been
    // asked, which is a different fact from "answered no" — see
    // services/channel-segments.ts.
    episode_segments: ((raw as any).episode_segments && typeof (raw as any).episode_segments === 'object')
      ? (raw as any).episode_segments
      : undefined,
  }

  // Pass through every project-side-only key the UI uses:
  // - *_presets / *_last_preset (all generator tabs use usePresets())
  // - custom_* (ideas tab autocomplete pools)
  // - audio_merge_* (explicit older keys)
  // API keys are already filtered out via the safe shape above.
  const SENSITIVE = new Set([
    'kie_api_key', 'fal_api_key', 'openai_api_key', 'anthropic_api_key', 'genaipro_api_key', 'elevenlabs_api_key', 'google_api_key',
  ])
  for (const key of Object.keys(raw)) {
    if (SENSITIVE.has(key)) continue
    if (key in safe) continue
    // The pattern below covers the new video-assembly slot presets (intro,
    // timeline, effects, subtitles, export, and the video_bundle wrapper)
    // without special-casing each one — they all use the standard
    // `{slot}_presets` / `{slot}_last_preset` convention.
    // `_last_preset` MUST also match the typed variants
    // (`script_last_preset_introduction`, `script_last_preset_script`) written
    // by usePresets({ presetType }). The earlier `endsWith('_last_preset')`
    // rule dropped them from the API response, so the frontend loaded empty
    // activeIds on refresh and the saved preset never auto-applied —
    // reproduced on a beta-tester machine where the config had valid typed
    // pointers but the UI still showed "— none —".
    const shouldPassThrough =
      isPresetConfigKey(key) ||
      key.endsWith('_templates') ||
      key.endsWith('_last_template') ||
      key.startsWith('custom_') ||
      key === 'script_custom_styles' ||
      // Video Assembly's last-render settings (per episode + channel starting point).
      key === 'video_assembly_last_used'
    if (shouldPassThrough) safe[key] = migratePresetField(key, raw[key])
  }

  return safe
}

export async function updateApiKeys(slug: string, req: UpdateApiKeysRequest): Promise<boolean> {
  // API keys now live in a separate secrets.json file (not config.json) so they
  // can be locked down (0600) and stripped from logs. See secrets-store.ts.
  if (!getProjectDir(slug)) return false
  const { writeSecrets } = await import('./secrets-store.js')
  await writeSecrets(slug, req)
  return true
}

async function applyGlobalConfigSideEffects(req: UpdateConfigRequest): Promise<void> {
  // Voice curation is global (app-settings.json); the project-side field is
  // intentionally not rewritten so older builds retain their compatibility.
  if (req.voice_presets) {
    const { setVoicePresetsGlobal } = await import('./app-settings.js')
    await setVoicePresetsGlobal(req.voice_presets as any)
  }
  if ((req as any).voice_favourites) {
    const { setVoiceFavouritesGlobal } = await import('./app-settings.js')
    const ids = (req as any).voice_favourites
    if (Array.isArray(ids)) await setVoiceFavouritesGlobal(ids)
  }
}

function applyConfigRequest(data: Record<string, any>, req: UpdateConfigRequest): void {
  migrateProjectPresetFields(data)
  // Retired custom-model storage. Any normal settings save permanently
  // prunes it from this project's config without requiring a bulk migration.
  delete data.models
  for (const retiredKey of [
    'audio_concurrency',
    'video_concurrency',
    'image_concurrency',
    'subtitle_concurrency',
    'image_launch_stagger_ms',
    'audio_launch_stagger_ms',
    'video_launch_stagger_ms',
    'generation_timeouts',
  ]) {
    delete data[retiredKey]
  }
  if (req.image_models) {
    data.image_models = req.image_models
    data.image_pricing_last_updated = new Date().toISOString().split('T')[0]
  }
  // Pass through project settings, excluding global/retired catalog fields.
  const PROJECT_LEVEL_EXCLUDES = ['image_models', 'voice_presets', 'voice_favourites', 'audio_models', 'video_models', 'models']
  for (const key of Object.keys(req)) {
    if (!PROJECT_LEVEL_EXCLUDES.includes(key)) {
      const requested = key === 'audio_generator_presets'
        ? sanitizeAudioGeneratorPresets((req as any)[key])
        : (req as any)[key]
      ;(data as any)[key] = migratePresetField(key, requested)
    }
  }
  if ((req as any).video_models) {
    data.video_models = sanitizeVideoCatalog((req as any).video_models)
    data.video_pricing_last_updated = new Date().toISOString().split('T')[0]
  }
}

export async function updateConfig(slug: string, req: UpdateConfigRequest): Promise<boolean> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return false
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(configPath)) return false
  await applyGlobalConfigSideEffects(req)
  // Read-modify-write must be atomic against concurrent updateConfig calls.
  let changed = false
  await withLock(configPath, async () => {
    const data = await readJson(configPath)
    const before = JSON.stringify(data)
    applyConfigRequest(data, req)
    // A no-op save must not touch config.json: every episode-status row
    // depends on its mtime, so a rewrite stales the whole Production Board.
    changed = JSON.stringify(data) !== before
    if (changed) await writeJsonAtomic(configPath, data)
  })
  if (changed) await syncManifest(slug)
  return true
}

/**
 * Coordinated signed-selection write. The caller owns the Content Pack
 * coordination lock, then this function takes project.json → config.json in
 * that order. A transitional project record retains both old and new pins
 * while config changes, so a crash can only over-pin safe bytes; it can never
 * expose a newly selected signed item without an exact pin.
 */
export async function updateConfigAndProjectMetaConsistently(
  slug: string,
  req: UpdateConfigRequest,
  mutateProject: (project: ProjectMeta) => void,
  hooks: ConsistentProjectWriteHooks = {},
): Promise<ProjectMeta | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const metaPath = path.join(projectDir, 'project.json')
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(metaPath) || !existsSync(configPath)) return null
  let updated: ProjectMeta | null = null
  await withLock(metaPath, async () => withLock(configPath, async () => {
    const originalProject = await readJson(metaPath) as ProjectMeta
    const originalConfig = await readJson(configPath) as Record<string, any>
    const finalProject = structuredClone(originalProject)
    const finalConfig = structuredClone(originalConfig)
    mutateProject(finalProject)
    applyConfigRequest(finalConfig, req)

    const transitionalProject: ProjectMeta = {
      ...finalProject,
      content_pack_versions: {
        ...(originalProject.content_pack_versions ?? {}),
        ...(finalProject.content_pack_versions ?? {}),
      },
      content_pack_items: {
        ...(originalProject.content_pack_items ?? {}),
        ...(finalProject.content_pack_items ?? {}),
      },
    }
    try {
      await writeJsonAtomic(metaPath, transitionalProject)
      await hooks.afterTransitionalProjectWrite?.()
      await writeJsonAtomic(configPath, finalConfig)
      await hooks.afterConfigWrite?.()
      await hooks.beforeFinalProjectWrite?.()
      await writeJsonAtomic(metaPath, finalProject)
      updated = structuredClone(finalProject)
    } catch (error) {
      await writeJsonAtomic(configPath, originalConfig).catch(() => {})
      await writeJsonAtomic(metaPath, originalProject).catch(() => {})
      throw error
    }
  }))
  await applyGlobalConfigSideEffects(req)
  await syncManifest(slug)
  return updated
}

export interface ConsistentProjectWriteHooks {
  afterTransitionalProjectWrite?: () => Promise<void>
  afterConfigWrite?: () => Promise<void>
  beforeFinalProjectWrite?: () => Promise<void>
}

// ── Standards ───────────────────────────────────────────────────────────────

export async function getStandards(slug: string): Promise<string | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const p = path.join(projectDir, 'production_standards.txt')
  if (!existsSync(p)) return null
  return await fs.readFile(p, 'utf-8')
}

export async function updateStandards(slug: string, content: string): Promise<boolean> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return false
  await fs.writeFile(path.join(projectDir, 'production_standards.txt'), content)
  await syncManifest(slug)
  return true
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a project's folder by slug — inside the Library, or nowhere.
 *
 * v1.4.3 removed the second lookup. There used to be a per-Mac registry of
 * folders living outside the Library, consulted as a fallback, which meant a
 * project could exist for one machine and not another and no listing could be
 * trusted. A channel is now a folder in the Library, so this is a join.
 *
 * Sync by design: dozens of services call this from hot paths. With the
 * registry gone it is a single `existsSync`.
 */
export function getProjectDir(slug: string): string | null {
  const d = path.join(projectsRoot(), slug)
  return existsSync(d) ? d : null
}

/**
 * Where a project's episode folders physically live, by slug — always
 * `<projectDir>/episodes`. Returns null only when the project itself can't be
 * located.
 *
 * The slug-keyed twin of `resolveOutputRoot()`; see that function for why
 * there is nothing to read out of `project.json` any more. This kept its
 * signature (and its ~40 callers) on purpose — only what it computes changed.
 */
export async function getProjectOutputRoot(slug: string): Promise<string | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  return resolveOutputRoot(projectDir).path
}

