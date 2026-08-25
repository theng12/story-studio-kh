/**
 * Import an existing project folder into this machine's userData.
 *
 * Folder-first model: the folder on disk is the source of truth for the
 * project's structural metadata (episode prefix/digits, season layout,
 * subfolder names). A `.story-studio-project.json` manifest inside the
 * folder, if present, is a fast-path hint that gives us a stable
 * `project_id` (so re-importing the same folder detects it as a relocate
 * rather than a duplicate). When the manifest is absent, we infer what
 * we can from the folder contents — and ask the user about anything
 * genuinely ambiguous.
 *
 * Three outcomes:
 *
 *   1. `project_id` matches a project already registered here → RELOCATE.
 *      The user likely moved their synced folder to a new path; we simply
 *      update that project's `output_root` to the new location.
 *
 *   2. `slug` is free → IMPORT. Create a fresh userData entry populated
 *      with the structural metadata (prefix, digits, subfolder_names, etc.).
 *      `config.json` starts empty (local presets are created after import);
 *      `secrets.json` starts empty (API keys stay local to this app).
 *
 *   3. `slug` is taken but by a *different* `project_id` → COLLISION. The
 *      UI prompts for an alternative slug via `options.adopt_as_slug`.
 *
 * What used to travel in v1 (presets, production_standards,
 * required_named_roots, youtube_channel_url) intentionally does NOT. Presets
 * now have one local app-owned list and are not a manifest/cloud concern.
 * See the PortableManifest doc in `models/types.ts`.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { readManifest } from './manifest.js'
import { inferProjectMetadata } from './project-inference.js'
import { sanitizeProjectSlug } from './slug.js'
import type { NeedsConfirmation } from './project-inference.js'
import type { PortableManifest, ProjectMeta, SubfolderNames } from '../models/types.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { projectsRoot, ensureProjectsRoot } from './project-manager.js'
import { normalizeOutputRootForStorage } from './project-manager.js'

export type ImportAction = 'imported' | 'relocated' | 'collision'

export type InspectSource = 'manifest-v2' | 'manifest-v1-legacy' | 'inferred'

/**
 * Unified result for both "inspect this folder so the UI can show a preview"
 * and "commit the import". The UI gets a flat list of structural fields plus
 * a `needs_confirmation` array telling it which fields the inferrer wasn't
 * sure about (so it can render inline fix-up inputs).
 */
export interface InspectResult {
  ok: true
  name: string
  slug: string
  /** Null when we had to infer (we'll mint a fresh UUID at commit time). */
  project_id: string | null
  episode_prefix: string
  episode_digits: number
  season_size: number
  season_prefix: string
  folder_template: string
  subfolder_names: SubfolderNames
  source: InspectSource
  needs_confirmation: NeedsConfirmation[]
  warnings: string[]
  /** Present only when a manifest was read and its project_id matches a
   *  project already registered on this machine. Drives the relocate path. */
  existing_match?: { slug: string; project_id: string }
}

export type InspectError = { ok: false; detail: string }

export interface ImportResult {
  action: ImportAction
  slug: string
  project_id: string
  output_root: string
  warnings: string[]
  /** Present only when `action === 'collision'`. */
  existing_slug?: string
  existing_project_id?: string
}

export interface ImportOptions {
  /** When a slug collision is detected, retry with this override. */
  adopt_as_slug?: string
  /** Field-level confirmations from the UI for anything in `needs_confirmation`. */
  overrides?: {
    episode_prefix?: string
    episode_digits?: number
    season_size?: number
    season_prefix?: string
    name?: string
  }
}

// ── Public entry points ────────────────────────────────────────────────────

/**
 * Read + infer the folder's structural metadata without side effects. Used by
 * the Import dialog's "confirm" step so the user can see what the app detected
 * before committing.
 */
export async function inspectProjectFolder(sourcePath: string): Promise<InspectResult | InspectError> {
  if (!path.isAbsolute(sourcePath)) {
    return { ok: false, detail: 'Source path must be absolute.' }
  }
  if (!existsSync(sourcePath)) {
    return { ok: false, detail: 'Folder not found.' }
  }
  let isDir = false
  try { isDir = (await fs.stat(sourcePath)).isDirectory() } catch { /* fall through */ }
  if (!isDir) return { ok: false, detail: 'Path is not a directory.' }

  const manifest = await readManifest(sourcePath)
  const inference = await inferProjectMetadata(sourcePath)

  if (manifest) {
    // Manifest hint is authoritative for identity (project_id / slug) and
    // preferred for structural fields. Inference still contributes warnings
    // and needs_confirmation — if the manifest disagrees with what's on
    // disk, the user should probably know.
    const source: InspectSource = await detectManifestVersion(sourcePath)
    const existing = await findRegisteredProject(manifest.project_id)
    return {
      ok: true,
      name: manifest.name || inference.name,
      slug: manifest.slug || inference.slug,
      project_id: manifest.project_id,
      episode_prefix: manifest.episode_prefix,
      episode_digits: manifest.episode_digits,
      season_size: manifest.season_size,
      season_prefix: manifest.season_prefix,
      folder_template: manifest.folder_template,
      subfolder_names: { ...DEFAULT_SUBFOLDER_NAMES, ...(manifest.subfolder_names || {}) },
      source,
      needs_confirmation: [],
      warnings: inference.warnings,
      existing_match: existing ? { slug: existing.slug, project_id: existing.project_id! } : undefined,
    }
  }

  // No manifest — pure inference path.
  if (!inference.ok) {
    return { ok: false, detail: inference.error || 'Could not read the folder.' }
  }
  return {
    ok: true,
    name: inference.name,
    slug: inference.slug,
    project_id: null,
    episode_prefix: inference.episode_prefix,
    episode_digits: inference.episode_digits,
    season_size: inference.season_size,
    season_prefix: inference.season_prefix,
    folder_template: inference.folder_template,
    subfolder_names: inference.subfolder_names,
    source: 'inferred',
    needs_confirmation: inference.needs_confirmation,
    warnings: inference.warnings,
  }
}

export async function importProjectFromFolder(
  sourcePath: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const inspect = await inspectProjectFolder(sourcePath)
  if (!inspect.ok) throw new Error(inspect.detail)

  const applied = applyOverrides(inspect, opts.overrides)

  // Case 1 — relocate. Same project_id, different path on disk.
  if (applied.project_id) {
    const existing = await findRegisteredProject(applied.project_id)
    if (existing) {
      if (existing.output_root !== sourcePath) {
        await updateOutputRoot(existing.slug, sourcePath)
      }
      return {
        action: 'relocated',
        slug: existing.slug,
        project_id: applied.project_id,
        output_root: sourcePath,
        warnings: applied.warnings,
      }
    }
  }

  // Case 2/3 — fresh import. Honour `adopt_as_slug` when supplied.
  const desiredSlug = opts.adopt_as_slug?.trim().toLowerCase() || applied.slug
  const sluggy = sanitizeProjectSlug(desiredSlug)
  const finalProjectId = applied.project_id || randomUUID()

  const collision = await findProjectBySlug(sluggy)
  if (collision && collision.project_id !== finalProjectId) {
    return {
      action: 'collision',
      slug: sluggy,
      project_id: finalProjectId,
      output_root: sourcePath,
      warnings: applied.warnings,
      existing_slug: collision.slug,
      existing_project_id: collision.project_id || '',
    }
  }

  await writeProjectFromInspection(sluggy, applied, finalProjectId, sourcePath)

  return {
    action: 'imported',
    slug: sluggy,
    project_id: finalProjectId,
    output_root: sourcePath,
    warnings: applied.warnings,
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Re-export so existing imports (if any) keep working. New code should
 * import `sanitizeProjectSlug` directly from `./slug.js`.
 */
export { sanitizeProjectSlug as sanitizeSlug }

/** Apply user-supplied override values to an inspect result before commit. */
function applyOverrides(inspect: InspectResult, overrides?: ImportOptions['overrides']): InspectResult {
  if (!overrides) return inspect
  const out: InspectResult = { ...inspect }
  if (typeof overrides.name === 'string' && overrides.name.trim()) {
    out.name = overrides.name.trim()
    out.slug = sanitizeProjectSlug(overrides.name)
  }
  if (typeof overrides.episode_prefix === 'string' && overrides.episode_prefix) {
    out.episode_prefix = overrides.episode_prefix
  }
  if (typeof overrides.episode_digits === 'number' && overrides.episode_digits > 0) {
    out.episode_digits = overrides.episode_digits
  }
  if (typeof overrides.season_size === 'number' && overrides.season_size > 0) {
    out.season_size = overrides.season_size
  }
  if (typeof overrides.season_prefix === 'string' && overrides.season_prefix) {
    out.season_prefix = overrides.season_prefix
  }
  return out
}

/**
 * Peek at the raw file to tell v1 from v2 — `readManifest` normalises both
 * to v2 shape in memory. Used only for the inspect preview's `source` label.
 */
async function detectManifestVersion(sourcePath: string): Promise<InspectSource> {
  try {
    const raw = await fs.readFile(path.join(sourcePath, '.story-studio-project.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.schema_version === 1) return 'manifest-v1-legacy'
    if (parsed?.schema_version === 2) return 'manifest-v2'
  } catch { /* fall through */ }
  return 'manifest-v2'
}

interface RegisteredProject {
  slug: string
  project_id?: string
  output_root: string
}

async function findRegisteredProject(projectId: string): Promise<RegisteredProject | null> {
  if (!projectId) return null
  let slugs: string[] = []
  try { slugs = await fs.readdir(projectsRoot()) } catch { return null }
  for (const slug of slugs) {
    const meta = await safeReadMeta(slug)
    if (!meta) continue
    if (meta.project_id === projectId) {
      return { slug, project_id: meta.project_id, output_root: meta.output_root }
    }
  }
  return null
}

async function findProjectBySlug(slug: string): Promise<RegisteredProject | null> {
  const meta = await safeReadMeta(slug)
  if (!meta) return null
  return { slug, project_id: meta.project_id, output_root: meta.output_root }
}

async function safeReadMeta(slug: string): Promise<ProjectMeta | null> {
  const p = path.join(projectsRoot(), slug, 'project.json')
  if (!existsSync(p)) return null
  try {
    const raw = await fs.readFile(p, 'utf-8')
    return JSON.parse(raw) as ProjectMeta
  } catch {
    return null
  }
}

async function updateOutputRoot(slug: string, newRoot: string): Promise<void> {
  const metaPath = path.join(projectsRoot(), slug, 'project.json')
  await withLock(metaPath, async () => {
    // A raw JSON.parse here used to throw on corruption and surface as an
    // opaque "SyntaxError" to the import flow. Worse, if we'd mirrored the
    // silent {} fallback from project-manager.readJson, writing {output_root}
    // on its own would have wiped the slug / project_id / episode_prefix.
    // Refuse to touch the file if we can't read it — the user keeps every
    // other field and gets a clear error in the import dialog.
    let raw: string
    try {
      raw = await fs.readFile(metaPath, 'utf-8')
    } catch (e: any) {
      const wrapped = new Error(
        `Cannot read project.json for '${slug}' to update output_root: ${e.message}`,
      )
      ;(wrapped as any).expose = true
      ;(wrapped as any).status = 409
      throw wrapped
    }
    let data: any
    try {
      data = JSON.parse(raw)
    } catch (e: any) {
      const wrapped = new Error(
        `project.json for '${slug}' is corrupted and cannot be parsed (${e.message}). ` +
        `Restore from a backup before importing — refusing to overwrite to avoid data loss.`,
      )
      ;(wrapped as any).expose = true
      ;(wrapped as any).status = 409
      throw wrapped
    }
    // v1.4.2 — stored relative when the folder is inside the projects root.
    // An absolute root hardcodes this Mac's username and volume, which is how
    // two real projects broke; a relative one moves with the project.
    data.output_root = normalizeOutputRootForStorage(path.dirname(metaPath), newRoot)
    await writeJsonAtomic(metaPath, data)
  })
}

/**
 * Seed a fresh `{userData}/projects/{slug}` directory from an InspectResult
 * (either manifest-derived or pure inference).
 *
 * Writes `project.json`, an empty `config.json`, `secrets.json` (empty —
 * API keys are per-machine), and `jobs.json`. No `production_standards.txt`
 * seeding: production standards are a per-machine setup step now.
 *
 * Also makes the `episodes/` alias folder so legacy code paths that assume
 * `{userData}/projects/{slug}/episodes` exists still work.
 */
async function writeProjectFromInspection(
  slug: string,
  inspect: InspectResult,
  projectId: string,
  outputRoot: string,
): Promise<void> {
  const projectDir = path.join(ensureProjectsRoot(), slug)
  await fs.mkdir(projectDir, { recursive: true })

  const subfolderNames: SubfolderNames = {
    ...DEFAULT_SUBFOLDER_NAMES,
    ...(inspect.subfolder_names || {}),
  }

  const meta: ProjectMeta = {
    name: inspect.name,
    slug,
    project_id: projectId,
    // Projects imported from a synced folder are by definition portable.
    portable: true,
    episode_prefix: inspect.episode_prefix,
    episode_digits: inspect.episode_digits,
    season_size: inspect.season_size,
    season_prefix: inspect.season_prefix,
    folder_template: inspect.folder_template,
    subfolder_names: subfolderNames,
    // v1.4.2 — see the note in `updateOutputRoot`. Same reason, other branch.
    output_root: normalizeOutputRootForStorage(projectDir, outputRoot),
    created_at: new Date().toISOString(),
  }
  await writeJsonAtomic(path.join(projectDir, 'project.json'), meta)

  // config.json starts empty. Model catalogs re-hydrate from defaults on
  // first read via project-manager.getConfig; presets stay empty until the
  // user sets them up in Settings (~5 min per-machine setup, by design).
  await writeJsonAtomic(path.join(projectDir, 'config.json'), {})

  // No empty secrets.json is seeded any more — provider API keys live
  // app-level (see app-secrets-store.ts). The per-project secrets.json
  // is created on-demand only when a YouTube OAuth account is connected.

  const jobsPath = path.join(projectDir, 'jobs.json')
  if (!existsSync(jobsPath)) {
    await writeJsonAtomic(jobsPath, { jobs: [] })
  }

  // Create the episodes alias so path.join(projectDir, 'episodes') never
  // fails; the real output lives at outputRoot.
  // v1.0.326 — guard against the projectDir already being NAMED 'episodes'.
  // The tree that exposed this was an imported project nested under an
  // `episodes/` sub-folder (output_root: './episodes' from an earlier import
  // wrapper). Re-running this code on that tree would create the bogus
  // `<project>/episodes/episodes/` empty directory the user found. The path
  // join is only needed when the projectDir isn't already that name.
  if (path.basename(projectDir).toLowerCase() !== 'episodes') {
    await fs.mkdir(path.join(projectDir, 'episodes'), { recursive: true })
  }
}
