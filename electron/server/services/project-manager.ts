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
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import type {
  AudioModelConfig, CreateProjectRequest, ProjectConfig, ProjectMeta, ProjectSummary,
  SafeProjectConfig, UpdateApiKeysRequest, UpdateConfigRequest, UpdateProjectRequest,
} from '../models/types.js'
import { resolveGenStudioModelId } from './genstudio-model-migration.js'
import { buildManifest, writeManifest, writeManifestCache, getMachineLabel } from './manifest.js'
import { sanitizeProjectSlug } from './slug.js'
import { getSoftDeletedSlugSet, forgetSoftDeletedProject } from './soft-delete.js'
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
function resolveAppSettingsPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'app-settings.json')
  }
  // Try Electron app.getPath('userData') first; fall back to the manual
  // platform branch.
  try {
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'app-settings.json')
  } catch { /* not in Electron (tests / standalone) */ }
  return path.join(getUserDataPath('Story Studio KH'), 'app-settings.json')
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

function resolveProjectsRoot(): string {
  // Test override — highest priority so tests don't touch real data.
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'projects')
  }
  // v1.4.3 — the Library. The one place everything lives, chosen by the user
  // on first run rather than assumed: *"i don't want our app on a new computer
  // to use the default location … i don't have to hunt for the story studio
  // folder inside of /user sth."*
  const library = readSettingSync('library_root')
  if (library) return library

  // Legacy: `projects_root_override` from before the Library existed. Read so
  // an upgrading install keeps working in the window before the boot migration
  // copies it across; `migrateLegacyLocationSettings` then retires the key.
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
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
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
 * Mirror the project's structural metadata to a portable manifest at the
 * root of `output_root`. Called after every metadata change so the file
 * recognises this folder as a Story Studio project on another machine
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
 * Skipped when `output_root` is relative (legacy userData-only project) —
 * the manifest is only useful for folders that actually leave userData.
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

    const outputRootRaw = meta.output_root || './episodes'
    const outputRoot = path.isAbsolute(outputRootRaw)
      ? outputRootRaw
      : path.join(projectDir, outputRootRaw)
    const isExternal = path.isAbsolute(outputRootRaw)

    const manifest = buildManifest(meta, outputRoot, getMachineLabel())

    if (isExternal && existsSync(outputRoot)) {
      try {
        await writeManifest(outputRoot, manifest)
      } catch (e: any) {
        console.warn(`[projects] syncManifest: could not write manifest for ${slug}:`, e.message)
      }
    }

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
    // A folder with no project.json is not a channel. That is the whole
    // membership rule now.
    if (!existsSync(metaPath)) return null

    let meta: ProjectMeta
    let timer: NodeJS.Timeout | undefined
    try {
      // Race the read against a 30s timeout. Clearing the timer in
      // `finally` is critical: an unbounded setTimeout keeps Node's
      // event loop alive past test completion (and after every
      // listProjects call in the running app), so the test runner hangs
      // and the dev process leaks pending timers per request.
      const timeoutPromise = new Promise<ProjectMeta>((_, rej) => {
        timer = setTimeout(() => rej(new Error('READ_TIMEOUT')), READ_TIMEOUT_MS)
      })
      meta = await Promise.race<ProjectMeta>([readJson(metaPath), timeoutPromise])
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
          output_root: cand.dir,
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

    // v1.4.1 corrected the note that used to sit here. It claimed relative
    // paths "live inside the project dir and are always present", so only an
    // absolute path could go missing. That is false: `../Origin Field/episodes`
    // is relative and points OUTSIDE the project dir, and a relative path can
    // name a folder that simply is not there. Both forms can break.
    const { path: outputRootAbs, exists: outputRootExists } = resolveOutputRoot(cand.dir, meta.output_root)

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
      status: 'ready',
    }
  }))

  return summaries.filter((s): s is ProjectSummary => s !== null)
}

/**
 * Store an episodes folder as a RELATIVE path whenever that is possible.
 *
 * ── Why (v1.4.2) ──
 *
 * An absolute `output_root` hardcodes this Mac's username and volume. Move the
 * project to another Mac, or rename the home folder, and it points at nothing —
 * which is exactly how two of the owner's projects broke, and what made "can I
 * move my assets to a new Mac?" a hard question to answer.
 *
 * A relative root resolves against the project's OWN directory (see
 * `resolveOutputRoot`), so as long as the project and its episodes move
 * together the link survives the trip. That is why `./episodes` is the creation
 * default, and why the bulk storage migration already rewrites absolute roots
 * back to relative — this makes the import path agree with both instead of
 * being the one writer that always stored an absolute path.
 *
 * A folder genuinely OUTSIDE the projects root stays absolute: expressing an
 * external volume as a chain of `../` would be fragile and would not survive
 * the move either. Absolute is the honest answer there.
 */
export function normalizeOutputRootForStorage(projectDir: string, target: string): string {
  if (!target || !path.isAbsolute(target)) return target || './episodes'
  const root = path.resolve(projectsRoot())
  const abs = path.resolve(target)
  // Only relativise within the projects root. `path.relative` will happily
  // produce `../../../..` chains out to the filesystem root, which are portable
  // in theory and meaningless in practice.
  if (abs !== root && !abs.startsWith(root + path.sep)) return abs
  const rel = path.relative(path.resolve(projectDir), abs)
  if (!rel) return '.'
  // Keep POSIX separators so the value reads the same on any machine.
  const posix = rel.split(path.sep).join('/')
  return posix.startsWith('.') ? posix : `./${posix}`
}

/**
 * Where a project's episodes actually live, and whether that folder is there.
 *
 * One function, because the home page and the project page must not be able to
 * disagree about whether a project is reachable — the whole point of surfacing
 * this is that a person can trust it.
 *
 * `output_root` may be absolute or relative; a relative one resolves against
 * the PROJECT DIR, which is why `./episodes` and `../Origin Field/episodes`
 * both work and both can be wrong.
 */
export function resolveOutputRoot(
  projectDir: string,
  outputRoot: string | undefined | null,
): { path: string; exists: boolean } {
  const raw = outputRoot || ''
  const abs = path.isAbsolute(raw) ? raw : path.join(projectDir, raw || 'episodes')
  return { path: abs, exists: existsSync(abs) }
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

  // ── Resolve + validate output_root ─────────────────────────────────────
  // If the user picked an absolute folder, scope it to {chosenFolder}/{ProjectName}
  // so multiple projects don't collide. Verify we can write there before we
  // create any project state — fail fast with a clear message otherwise.
  let resolvedOutputRoot = req.output_root || './episodes'
  if (path.isAbsolute(resolvedOutputRoot)) {
    // Only append the project name if the user didn't already pick a folder
    // ending with it (e.g., they picked `/Users/foo/Documents/MyProject`).
    const tail = path.basename(resolvedOutputRoot)
    if (tail !== req.name) {
      resolvedOutputRoot = path.join(resolvedOutputRoot, req.name)
    }
    // Nest episodes under an `episodes/` subfolder so a custom-folder
    // project has the SAME shape as a default-location one
    // ({root}/episodes/Season…). Without this, Season folders land
    // directly in the picked folder alongside project.json + cache — the
    // inconsistency older custom-folder projects (Capi, Boundful) showed.
    // Mirrors the './episodes' relative default. The basename guard avoids
    // double-nesting if the user literally picked an `episodes` folder.
    // Only affects NEW projects; existing output_root values are untouched.
    if (path.basename(resolvedOutputRoot) !== 'episodes') {
      resolvedOutputRoot = path.join(resolvedOutputRoot, 'episodes')
    }
    try {
      await fs.mkdir(resolvedOutputRoot, { recursive: true })
      // Write-access probe — surface permission issues up front.
      const probe = path.join(resolvedOutputRoot, '.storystudio-probe')
      await fs.writeFile(probe, '')
      await fs.unlink(probe)
    } catch (e: any) {
      throw new Error(`Cannot write to chosen folder: ${e.message || e}`)
    }
  }

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
    output_root: resolvedOutputRoot,
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
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(configPath)) {
    await writeJson(configPath, {
      image_models: { ...DEFAULT_IMAGE_MODELS },
      voice_presets: [...DEFAULT_VOICE_PRESETS],
      audio_models: { ...DEFAULT_AUDIO_MODELS },
      video_models: { ...DEFAULT_VIDEO_MODELS },
      image_pricing_last_updated: '', audio_pricing_last_updated: '', video_pricing_last_updated: '',
    })
  }
  // No per-project secrets.json is seeded — API keys live in the
  // app-level store (see app-secrets-store.ts). YouTube OAuth state is
  // the only thing that still goes into a per-project secrets.json,
  // and it's written on demand the first time a channel is connected.

  // Ensure production_standards.txt exists
  const standardsPath = path.join(projectDir, 'production_standards.txt')
  if (!existsSync(standardsPath)) {
    await fs.writeFile(standardsPath, '# Production Standards\n\nAdd your story generation guidelines here.\n')
  }

  // Ensure episodes dir + jobs.json
  // v1.0.326 — skip the alias mkdir when the projectDir is itself named
  // 'episodes' (legacy nested-import shape). Otherwise we'd create the
  // doubly-nested `<x>/episodes/episodes/` empty vestige the user found on
  // MineePod. See import-project.ts for the matching guard.
  if (path.basename(projectDir).toLowerCase() !== 'episodes') {
    await fs.mkdir(path.join(projectDir, 'episodes'), { recursive: true })
  }
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
  await withLock(metaPath, async () => {
    const data = await readJson(metaPath)
    const updates = Object.fromEntries(Object.entries(req).filter(([_, v]) => v !== undefined))
    merged = { ...data, ...updates } as ProjectMeta
    await writeJsonAtomic(metaPath, merged)
  })
  await syncManifest(slug)
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

// model-drift-allow: retired ids paired with the exact caps Story Studio once
// shipped for them. The pair is historical evidence a migration matches on; it
// must stay frozen or the migration stops recognising the values it heals.
const RETIRED_AUDIO_CHAR_CAPS: Readonly<Record<string, ReadonlySet<number>>> = {
  // GenStudio retired its qualification-only ~30-second/375-character cap.
  // Heal existing projects to the public 15,000-character API boundary.
  'genstudio-qwen3-standard': new Set([375]),
  // CustomVoice does not use Voice Studio's clone-specific splitter. Only
  // migrate its former built-in 2,000 value to the current 3,000 default.
  'voicestudio-qwen3-tts': new Set([2000]),
  // Voice Studio now owns stable internal splitting for these clone engines.
  // Heal every value that Story Studio previously shipped as a built-in while
  // preserving any other deliberately customized cap.
  'voicestudio-qwen3-tts-base-0.6b': new Set([2000, 3000, 5000]),
  'voicestudio-qwen3-tts-base-1.7b': new Set([2000, 3000, 5000]),
  'voicestudio-chatterbox-mlx': new Set([500, 1000]),
  'voicestudio-voxcpm-mlx': new Set([500, 800, 1000]),
}

/** Heal former built-in local TTS caps without replacing deliberate limits. */
export function migrateRetiredAudioDefaults<T extends Record<string, any>>(
  merged: Record<string, T>,
  saved: Record<string, T> | null | undefined,
): Record<string, T> {
  for (const [modelId, retiredCaps] of Object.entries(RETIRED_AUDIO_CHAR_CAPS)) {
    const savedCap = saved?.[modelId]?.tts_soft_max_chars
    const currentDefault = DEFAULT_AUDIO_MODELS[modelId]?.tts_soft_max_chars
    if (typeof savedCap === 'number' && retiredCaps.has(savedCap) && currentDefault) {
      merged[modelId] = {
        ...merged[modelId],
        tts_soft_max_chars: currentDefault,
      }
    }
  }
  return merged
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
    formula_applied_style_id: typeof (config as any).formula_applied_style_id === 'string'
      ? (config as any).formula_applied_style_id
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
    visual_opening_mode: typeof (config as any).visual_opening_mode === 'string'
      ? (config as any).visual_opening_mode
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
    intro_standards: raw.intro_standards || '',
    standards_presets: raw.standards_presets || [],
    intro_presets: raw.intro_presets || [],
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
      key === 'script_custom_styles'
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
  await withLock(configPath, async () => {
    const data = await readJson(configPath)
    applyConfigRequest(data, req)
    await writeJsonAtomic(configPath, data)
  })
  await syncManifest(slug)
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
      await writeJsonAtomic(configPath, finalConfig)
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
 * Resolve where a project's episode folders physically live.
 * - absolute `output_root` (user picked a custom location) is returned as-is
 * - relative `output_root` (default `./episodes`) is resolved against the project dir
 * Returns null if the project itself can't be located.
 */
export async function getProjectOutputRoot(slug: string): Promise<string | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  try {
    const raw = await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8')
    const meta = JSON.parse(raw)
    const out = meta.output_root || './episodes'
    return path.isAbsolute(out) ? out : path.join(projectDir, out)
  } catch {
    return path.join(projectDir, './episodes')
  }
}

export async function getTemplates(): Promise<Array<{ id: string; name: string; description: string }>> {
  const templates: Array<{ id: string; name: string; description: string }> = []
  let entries: string[] = []
  try { entries = await fs.readdir(TEMPLATES_ROOT) } catch { return templates }
  for (const name of entries.sort()) {
    const dir = path.join(TEMPLATES_ROOT, name)
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) continue
    // Don't let a single malformed template shipping in the bundle blow up
    // the whole wizard — skip it with a warning and show the others.
    let meta: any
    try {
      meta = await readJson(path.join(dir, 'project.json'))
    } catch (e: any) {
      console.warn(`[projects] getTemplates: skipping '${name}' — ${e.message}`)
      continue
    }
    templates.push({
      id: name,
      name: meta.name || name.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      description: meta.description || '',
    })
  }
  return templates
}
