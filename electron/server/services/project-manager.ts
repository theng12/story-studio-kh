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
import { toUnified, fromUnified } from '../models/unified.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import type {
  CreateProjectRequest, ProjectConfig, ProjectMeta, ProjectSummary,
  SafeProjectConfig, UpdateApiKeysRequest, UpdateConfigRequest, UpdateProjectRequest,
} from '../models/types.js'
import { buildManifest, writeManifest, writeManifestCache, getMachineLabel } from './manifest.js'
import { sanitizeProjectSlug } from './slug.js'
import { getLinkedDirCache, listLinkedProjects } from './linked-projects.js'
import { getSoftDeletedSlugSet, softDeleteProject, forgetSoftDeletedProject } from './soft-delete.js'
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
 * Read the user's `projects_root_override` setting at boot.
 *
 * Synchronous on purpose: PROJECTS_ROOT is exported as a const and used
 * by every service in the codebase. Resolving asynchronously would
 * require touching hundreds of call sites OR a one-shot await wrapper
 * that's hard to fit alongside existing import patterns. Sync read is
 * safe — app-settings.json is tiny (<1 KB) and we read it exactly once
 * per process lifetime.
 *
 * Returns:
 *   - the absolute override path when set + non-empty
 *   - empty string otherwise (caller falls through to default)
 *
 * Any read/parse error → treated as unset. We never want an unreadable
 * settings file to brick the app's ability to find its projects.
 */
function readProjectsRootOverrideSync(): string {
  const settingsPath = resolveAppSettingsPath()
  if (!existsSync(settingsPath)) return ''
  try {
    // Use the readFileSync from node:fs (NOT fs/promises). Top-level
    // import is for fs/promises; pull sync API on demand.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs')
    const raw = readFileSync(settingsPath, 'utf-8')
    const data = JSON.parse(raw)
    const v = data?.projects_root_override
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
  // User-configured override via Settings → Storage → Projects storage
  // location. Per-machine — lives in app-settings.json which doesn't
  // sync. Lets the user point the projects folder at iCloud Drive (or
  // any cloud-synced location) without setting an env var manually.
  const override = readProjectsRootOverrideSync()
  if (override) return override

  // Always prefer Electron's userData path (same in dev and packaged).
  // This avoids projects living inside the source tree — previous behaviour
  // was sensitive to whether the entry was tsx source or compiled JS.
  try {
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'projects')
  } catch { /* not running inside Electron (e.g. tests) */ }
  return path.join(getUserDataPath('Story Studio KH'), 'projects')
}

/**
 * Diagnostic helpers for the Storage-tab UI. Exported so the route
 * layer can return both `effective_path` (what THIS process resolved
 * at boot) and `default_path` (what the userData fallback would give)
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
 * canonical PROJECTS_ROOT (userData/projects) on first startup only.
 *
 * A `.legacy-migration-done` marker is written to PROJECTS_ROOT after the
 * first run. Subsequent startups short-circuit — so deleting a project
 * from userData will NOT cause it to be re-seeded from a stale legacy
 * folder on the next launch.
 *
 * Legacy locations:
 *   - {repo}/projects/            (from the original tsx-watch dev setup)
 *   - {repo}/electron/projects/   (from the compiled-JS dev setup)
 */
function migrateLegacyProjects(): void {
  const markerPath = path.join(PROJECTS_ROOT, '.legacy-migration-done')
  if (existsSync(markerPath)) return

  const legacyRoots = [
    path.join(ROOT, 'projects'),
    path.join(ROOT, 'electron', 'projects'),
  ].filter(p => p !== PROJECTS_ROOT && existsSync(p))

  for (const legacy of legacyRoots) {
    let entries: string[] = []
    try { entries = require('fs').readdirSync(legacy) } catch { continue }
    for (const slug of entries) {
      const src = path.join(legacy, slug)
      const dst = path.join(PROJECTS_ROOT, slug)
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

export const PROJECTS_ROOT = resolveProjectsRoot()
export const TEMPLATES_ROOT = resolveTemplatesRoot()

// Ensure projects dir exists
if (!existsSync(PROJECTS_ROOT)) mkdirSync(PROJECTS_ROOT, { recursive: true })

// One-time migration from legacy dev locations (no-op if nothing to migrate)
migrateLegacyProjects()

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
    const entries = require('fs').readdirSync(PROJECTS_ROOT) as string[]
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
 * the metadata (see audit-reports/08-persistence.md finding #4).
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
    // Linked-aware: a moved project's manifest still needs to refresh.
    const projectDir = getProjectDir(slug) || path.join(PROJECTS_ROOT, slug)
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
  // Build the unified candidate list: default-location projects (subdirs
  // of PROJECTS_ROOT) merged with linked-paths projects (registered via
  // Settings → Storage → Add existing project folder, or implicitly added
  // when a user runs Move this project to… on a non-default destination).
  // Default-location entries win on slug conflict so a hand-edited link
  // can never shadow the canonical project still sitting in PROJECTS_ROOT.
  type Candidate = { dir: string; folderName: string }
  const candidates: Candidate[] = []
  const seenSlugs = new Set<string>()

  // Soft-deleted slugs (the user clicked "Delete project" but we kept
  // the folder on disk). These should not surface in the live list —
  // the home-page "🗑️ Hidden projects" panel surfaces them separately
  // via /soft-deleted-projects.
  const softDeleted = await getSoftDeletedSlugSet()

  let defaultEntries: string[] = []
  try {
    defaultEntries = await fs.readdir(PROJECTS_ROOT)
  } catch { /* PROJECTS_ROOT missing — fall through to linked-only */ }
  for (const name of defaultEntries.sort()) {
    if (name.startsWith('.')) continue
    // Backup folders left behind by Move this project to… (delete_source
    // off) — the user can verify + restore them but they shouldn't show
    // up as live projects in the list.
    if (/\.bak-/.test(name)) continue
    candidates.push({ dir: path.join(PROJECTS_ROOT, name), folderName: name })
  }

  // Linked projects — read project.json's slug to populate the seen set
  // accurately (basename-fallback when slug field is missing).
  const linked = await listLinkedProjects()
  for (const info of linked) {
    if (!info.exists || !info.slug) continue
    candidates.push({ dir: info.path, folderName: info.slug })
  }

  const { readSecrets } = await import('./secrets-store.js')

  // Process every project in parallel. Each candidate is independent
  // (distinct project.json / config.json / secrets.json reads), so this
  // collapses ~N×latency into a single round-trip. At 20+ projects the
  // diff is the difference between snappy and "feels frozen" on home-page
  // load. Returns null for corrupt/missing entries — filtered out below.
  //
  // iCloud-aware path:
  //   1. Check for `.<basename>.icloud` placeholder via
  //      isCloudEvictedPlaceholder. If present, the file is downloading
  //      from iCloud — don't try to read it (would block the OS-level
  //      sync request). Return a 'downloading' stub immediately.
  //   2. Race the readJson against a 30s timeout. If the read doesn't
  //      come back, treat that project as 'downloading' too — the read
  //      is still in flight inside macOS's sync layer; we just stop
  //      waiting for it.
  // The frontend polls /api/projects every 5s while any are
  // 'downloading'; rows promote to 'ready' on the next successful read.
  const READ_TIMEOUT_MS = 30_000
  const { isCloudEvictedPlaceholder } = await import('../lib/http-retry.js')
  const summaries = await Promise.all(candidates.map(async (cand): Promise<ProjectSummary | null> => {
    const metaPath = path.join(cand.dir, 'project.json')
    if (!existsSync(metaPath)) {
      // Not a real file → maybe an iCloud placeholder is sitting next to
      // it. Surface the row as downloading so the user sees it instead
      // of silently dropping the candidate.
      if (await isCloudEvictedPlaceholder(metaPath)) {
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
      return null
    }
    // Quick placeholder probe before any blocking read.
    if (await isCloudEvictedPlaceholder(metaPath)) {
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
      // Timeout = still syncing. Surface as downloading so the user can
      // see the row + come back when iCloud finishes. Other errors
      // (corrupt JSON, perm denied) get the existing skip-and-warn path.
      if (e?.message === 'READ_TIMEOUT') {
        console.warn(`[projects] listProjects: '${cand.folderName}' read timed out after ${READ_TIMEOUT_MS}ms — likely iCloud-syncing`)
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

    // Read secrets + legacy-config check in parallel — each is an independent
    // file read and the result is just a boolean for the summary flag.
    const secretsP = readSecrets(slug)
    let legacyConfigHasKeys = false
    const [secrets, legacyKeys] = await Promise.all([
      secretsP,
      (async () => {
        try {
          const raw = await readJson(path.join(cand.dir, 'config.json'))
          return !!(raw?.openai_api_key || raw?.anthropic_api_key)
        } catch (e: any) {
          if (e?.code !== 'ENOENT') {
            console.warn(`[projects] listProjects: config.json unreadable for '${slug}' — ${e.message}`)
          }
          return false
        }
      })(),
    ])
    if (!secrets.openai_api_key && !secrets.anthropic_api_key) {
      legacyConfigHasKeys = legacyKeys
    }

    // Resolve output_root absolute for presence check. Relative paths live
    // inside the project dir and are always present; only an absolute user-
    // picked folder can go missing after a manual move/rename.
    const outputRootRaw = meta.output_root || ''
    const outputRootAbs = path.isAbsolute(outputRootRaw)
      ? outputRootRaw
      : path.join(cand.dir, outputRootRaw || 'episodes')
    const outputRootExists = existsSync(outputRootAbs)

    return {
      name: meta.name,
      slug,
      episode_prefix: meta.episode_prefix,
      created_at: meta.created_at,
      has_api_keys: !!(secrets.openai_api_key || secrets.anthropic_api_key) || legacyConfigHasKeys,
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

export async function getProject(slug: string): Promise<ProjectMeta | null> {
  // Resolve via getProjectDir so linked projects (those moved out of
  // PROJECTS_ROOT into custom folders) are reachable by slug.
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const metaPath = path.join(projectDir, 'project.json')
  if (!existsSync(metaPath)) return null
  // A corrupt project.json should surface as a 409 to the UI (via the error
  // middleware), not a 404 "Project not found" — the project exists, we just
  // can't read its metadata. Let JsonCorruptError propagate.
  return await readJson(metaPath)
}

export async function createProject(req: CreateProjectRequest): Promise<ProjectMeta> {
  const slug = uniqueSlug(slugify(req.name))
  const projectDir = path.join(PROJECTS_ROOT, slug)
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

  // Copy template
  const templateDir = path.join(TEMPLATES_ROOT, req.template || 'blank')
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
    // v1.0.68+: persist the user's choice from the Channel Format
    // picker (Step 1 of the create wizard). Bare projects without a
    // pick fall through to whatever sleep-story-leaning defaults
    // existed before — getEffectiveFormat resolves missing format_id
    // by reading the bundled sleep-story.json profile.
    ...(req.format_id ? { format_id: req.format_id } : {}),
    // Niche is optional (subject-domain layer, orthogonal to format).
    // Unset = no niche, generators behave exactly like format defaults.
    // We trust the wizard to pass a valid id; the niche-loader logs and
    // falls back to null on missing files so a stale id doesn't break
    // the project.
    ...(req.niche_id ? { niche_id: req.niche_id } : {}),
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
   *  - 'unlinked':     linked project, removed from the linked-projects
   *    registry. Folder untouched on disk (it was always external).
   */
  disposition?: 'soft_deleted' | 'unlinked'
  /** Absolute path that's now orphaned on disk — what the dialog
   *  shows + what the "Open in Finder" button reveals. */
  orphan_path?: string
  /** Human name from project.json so the dialog can say
   *  "<Project Name> files are still at …" rather than just the slug. */
  name?: string
}

/**
 * Soft-delete a project: unregister it from the app, leave every byte
 * on disk. The user gets a banner naming the path; the home-page
 * "🗑️ Hidden projects" chip surfaces it for restore / open-in-Finder /
 * explicit hard-delete.
 *
 * Linked projects skip the soft-delete tombstone because they were
 * never in PROJECTS_ROOT to begin with — removing the registry entry
 * is sufficient to hide them from the list, and re-adding via
 * "Add existing project folder" brings them straight back.
 *
 * Default-location projects can't use the same trick: their folder is
 * still in PROJECTS_ROOT and would be picked up by the next listProjects
 * scan. So we record the slug in soft_deleted_slugs and listProjects
 * filters by that set.
 */
export async function deleteProject(slug: string): Promise<DeleteProjectResult> {
  const projectDir = getProjectDir(slug)
  if (!projectDir || !existsSync(projectDir)) return { ok: false }

  // Best-effort read of project.json so the post-delete dialog can
  // show the human name. Missing/corrupt project.json is non-fatal —
  // the dialog falls back to the slug.
  let meta: ProjectMeta | null = null
  try {
    const raw = await readJson(path.join(projectDir, 'project.json'))
    meta = raw as ProjectMeta
  } catch { /* fall through */ }

  const inDefaultLocation = path.resolve(projectDir).startsWith(path.resolve(PROJECTS_ROOT) + path.sep)

  if (inDefaultLocation) {
    await softDeleteProject(slug)
    return {
      ok: true,
      disposition: 'soft_deleted',
      orphan_path: projectDir,
      name: meta?.name || slug,
    }
  }

  // Linked project: just unregister from the linked-projects list. The
  // folder is external (e.g. iCloud), so we never touch it.
  const { removeLinkedProject } = await import('./linked-projects.js')
  await removeLinkedProject(projectDir)
  return {
    ok: true,
    disposition: 'unlinked',
    orphan_path: projectDir,
    name: meta?.name || slug,
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Per-entry shallow merge of a built-in default catalog with a project's
 * on-disk override. For each model id:
 *   - If only the default has it → carry the default through (new model).
 *   - If only the project has it → carry the project entry through
 *     (user-added custom model — id not in defaults).
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
  'refs_field', 'refs_upload', 'aspect_field', 'provider', 'provider_params', 'supports_reference_images',
])

function mergeCatalog<T extends Record<string, any>>(
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
  // Carry user-added custom entries that aren't in defaults.
  if (saved) {
    for (const [id, m] of Object.entries(saved)) {
      if (!(id in out)) out[id] = m
    }
  }
  return out
}

export async function getConfig(slug: string): Promise<ProjectConfig | null> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(configPath)) return null
  const raw = await readJson(configPath)

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
  raw.audio_models = mergeCatalog(DEFAULT_AUDIO_MODELS, raw.audio_models)
  raw.video_models = mergeCatalog(DEFAULT_VIDEO_MODELS, raw.video_models)
  if (!raw.voice_presets || !raw.voice_presets.length) {
    raw.voice_presets = [...DEFAULT_VOICE_PRESETS]
  }

  // Project the unified model catalog from the merged legacy dicts. Any
  // user-added custom models on disk (raw.models entries whose id doesn't
  // live in the legacy dicts) are appended. Delivery 4 exposes this array
  // to the Settings UI and adds a writer for custom entries.
  raw.models = toUnified(
    { image_models: raw.image_models, audio_models: raw.audio_models, video_models: raw.video_models },
    { customs: Array.isArray(raw.models) ? raw.models : [] },
  )

  // Merge secrets in for callers that need the keys (generators, providers).
  // This is an in-memory merge only — config.json on disk never carries keys.
  // On first read of a legacy project, move any keys found in config.json
  // into secrets.json. Callers never see a shape change.
  const { readSecrets, migrateSecretsFromConfig } = await import('./secrets-store.js')
  let configHadKeys = false
  for (const k of ['kie_api_key', 'fal_api_key', 'openai_api_key', 'anthropic_api_key', 'genaipro_api_key', 'elevenlabs_api_key', 'google_api_key'] as const) {
    if (k in raw) { configHadKeys = true; break }
  }
  if (configHadKeys) {
    await migrateSecretsFromConfig(slug).catch(() => {})
  }
  const secrets = await readSecrets(slug)
  raw.kie_api_key = secrets.kie_api_key ?? ''
  raw.fal_api_key = secrets.fal_api_key ?? ''
  raw.openai_api_key = secrets.openai_api_key ?? ''
  raw.anthropic_api_key = secrets.anthropic_api_key ?? ''
  raw.genaipro_api_key = secrets.genaipro_api_key ?? ''
  raw.elevenlabs_api_key = secrets.elevenlabs_api_key ?? ''
  raw.google_api_key = secrets.google_api_key ?? ''
  return raw
}

export async function getSafeConfig(slug: string): Promise<any | null> {
  const config = await getConfig(slug)
  if (!config) return null
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const raw = await readJson(path.join(projectDir, 'config.json'))
  // Account list (Delivery 2) — masked values only. The legacy `has_*_key`
  // booleans below stay populated from the default account for any UI
  // surface that hasn't migrated to the accounts map yet.
  const { listAllAccounts } = await import('./secrets-accounts.js')
  const accountsByProvider = await listAllAccounts(slug).catch(() => ({}))

  const safe: any = {
    has_kie_key: !!config.kie_api_key,
    has_fal_key: !!config.fal_api_key,
    has_openai_key: !!config.openai_api_key,
    has_anthropic_key: !!config.anthropic_api_key,
    has_genaipro_key: !!(config as any).genaipro_api_key,
    has_elevenlabs_key: !!(config as any).elevenlabs_api_key,
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
      const global = await getVoicePresetsGlobal()
      if (global.length > 0) return global
      // Pre-migration fallback: per-project value if set, else seeded default.
      if (config.voice_presets && config.voice_presets.length) return config.voice_presets
      return [...DEFAULT_VOICE_PRESETS]
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
    // Concurrency knobs (undefined = generator uses its safe default).
    audio_concurrency: typeof (config as any).audio_concurrency === 'number' ? (config as any).audio_concurrency : undefined,
    video_concurrency: typeof (config as any).video_concurrency === 'number' ? (config as any).video_concurrency : undefined,
    image_concurrency: typeof (config as any).image_concurrency === 'number' ? (config as any).image_concurrency : undefined,
    subtitle_concurrency: typeof (config as any).subtitle_concurrency === 'number' ? (config as any).subtitle_concurrency : undefined,
    // v1.0.337 — continuity guide cast density (0–100; undefined = 40% default).
    character_density: typeof (config as any).character_density === 'number' ? (config as any).character_density : undefined,
    // Per-modality launch stagger (ms). 0 / undefined = no stagger; non-zero
    // delays each pool worker's first task by index*stagger to smooth the
    // initial-burst submit that triggers per-second 429s on Kie / fal /
    // ElevenLabs / Veo. See generators/{images,audio,ai-video}.ts.
    image_launch_stagger_ms: typeof (config as any).image_launch_stagger_ms === 'number' ? (config as any).image_launch_stagger_ms : undefined,
    audio_launch_stagger_ms: typeof (config as any).audio_launch_stagger_ms === 'number' ? (config as any).audio_launch_stagger_ms : undefined,
    video_launch_stagger_ms: typeof (config as any).video_launch_stagger_ms === 'number' ? (config as any).video_launch_stagger_ms : undefined,
    // Per-generator timeout overrides (minutes). Currently only TTS is
    // user-settable in the Performance tab; pass the whole map through so
    // future generators can land here without another safe-config patch.
    // Without this echo, a value saved via PUT /settings/config is
    // persisted to disk but the next GET strips it, so the UI's v-model
    // resets to blank — making it look like the save was lost.
    generation_timeouts: (config as any).generation_timeouts && typeof (config as any).generation_timeouts === 'object'
      ? (config as any).generation_timeouts
      : undefined,
    audio_models: (config.audio_models && Object.keys(config.audio_models).length)
      ? config.audio_models
      : { ...DEFAULT_AUDIO_MODELS },
    video_models: ((config as any).video_models && Object.keys((config as any).video_models).length)
      ? (config as any).video_models
      : { ...DEFAULT_VIDEO_MODELS },
    video_pricing_last_updated: (config as any).video_pricing_last_updated || '',
    audio_pricing_last_updated: config.audio_pricing_last_updated || '',
    // Unified catalog — mirrors the legacy dicts above plus any custom
    // entries on disk. Delivery 4 migrates the Settings UI onto this.
    models: config.models ?? [],
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
  // - image_concurrency, audio_merge_* (explicit older keys)
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
      key.endsWith('_presets') ||
      /_last_preset(_[a-z]+)?$/.test(key) ||
      key.endsWith('_templates') ||
      key.endsWith('_last_template') ||
      key.startsWith('custom_') ||
      key === 'script_custom_styles' ||
      key === 'image_concurrency'
    if (shouldPassThrough) safe[key] = raw[key]
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

export async function updateConfig(slug: string, req: UpdateConfigRequest): Promise<boolean> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return false
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(configPath)) return false
  // Voice curation is now global (app-settings.json) — divert before the
  // per-project write so the slug-bearing settings/config endpoint stays
  // a transparent read/write proxy for the frontend. The project-side
  // field is intentionally NOT cleared here — older app builds still
  // expect it to exist.
  if (req.voice_presets) {
    const { setVoicePresetsGlobal } = await import('./app-settings.js')
    await setVoicePresetsGlobal(req.voice_presets as any)
  }
  if ((req as any).voice_favourites) {
    const { setVoiceFavouritesGlobal } = await import('./app-settings.js')
    const ids = (req as any).voice_favourites
    if (Array.isArray(ids)) await setVoiceFavouritesGlobal(ids)
  }
  // Read-modify-write must be atomic against concurrent updateConfig calls.
  await withLock(configPath, async () => {
    const data = await readJson(configPath)
    if (req.image_models) {
      data.image_models = req.image_models
      data.image_pricing_last_updated = new Date().toISOString().split('T')[0]
    }
    if (req.audio_models) {
      data.audio_models = req.audio_models
      data.audio_pricing_last_updated = new Date().toISOString().split('T')[0]
    }
    // Pass through any extra settings (script_settings, youtube_templates, etc.)
    // Excludes voice_presets / voice_favourites — those went to global above
    // and must not be re-written into the project config.
    const PROJECT_LEVEL_EXCLUDES = ['image_models', 'voice_presets', 'voice_favourites', 'audio_models', 'models']
    for (const key of Object.keys(req)) {
      if (!PROJECT_LEVEL_EXCLUDES.includes(key)) {
        (data as any)[key] = (req as any)[key]
      }
    }
    // If the caller sent the unified `models` array, split it back into the
    // legacy dicts so generators (which still key off image_models / audio_models
    // / video_models) stay in lockstep with the canonical list. The legacy
    // fields above take precedence if the caller sent both — we only project
    // from `models` for types the caller didn't explicitly overwrite.
    if (Array.isArray((req as any).models)) {
      const unified = (req as any).models
      const split = fromUnified(unified)
      if (!req.image_models && Object.keys(split.image_models).length) {
        data.image_models = split.image_models
      }
      if (!req.audio_models && Object.keys(split.audio_models).length) {
        data.audio_models = split.audio_models
      }
      if (!(req as any).video_models && Object.keys(split.video_models).length) {
        data.video_models = split.video_models
      }
      data.models = unified
    }
    await writeJsonAtomic(configPath, data)
  })
  await syncManifest(slug)
  return true
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
 * Resolve a project's metadata folder by slug. Two locations are
 * consulted, in priority order:
 *   1. The default `<PROJECTS_ROOT>/<slug>/` location.
 *   2. The per-Mac linked-projects registry — for projects that have
 *      been moved out of PROJECTS_ROOT into custom folders (e.g. one
 *      project in iCloud while others stay local).
 *
 * Sync by design: dozens of services call into this from hot paths
 * that can't easily go async. The linked-paths lookup uses a sync
 * cache built from a single readFileSync of app-settings.json — see
 * linked-projects.ts:getLinkedDirCache for the cost model.
 *
 * Default-location entries win on slug conflict so a hand-edited
 * linked path can never shadow the canonical project that's still
 * sitting in PROJECTS_ROOT.
 */
export function getProjectDir(slug: string): string | null {
  const d = path.join(PROJECTS_ROOT, slug)
  if (existsSync(d)) return d
  const linked = getLinkedDirCache().get(slug)
  if (linked && existsSync(linked)) return linked
  return null
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
