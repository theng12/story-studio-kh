/**
 * Storage-location migration helper.
 *
 * Copies the contents of the current PROJECTS_ROOT into a user-picked
 * target directory. Designed for the "I want my projects in iCloud
 * Drive" flow:
 *
 *   1. User picks the target via the native folder picker
 *   2. App copies projects/ → {target}/   (this service)
 *   3. App writes the override path to app-settings.json
 *   4. App restarts → boot-time read picks up the new path
 *
 * The user explicitly chose "copy + keep old location" semantics — we
 * never delete the source. The user verifies the new location boots
 * cleanly + manually deletes the old folder once satisfied.
 *
 * Validation refuses pathological targets:
 *   - same as source (no-op)
 *   - inside source (recursive copy of growing tree)
 *   - already non-empty (without explicit merge flag — not in v1)
 *
 * EXDEV (cross-device) is the common failure on cloud-synced volumes:
 *   fs.cp succeeds across devices natively, but native rename would
 *   fail. We use cp throughout so the cross-device case Just Works.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { projectsRoot } from './project-manager.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

export interface MigrationOptions {
  /**
   * When true, allows the target dir to already contain files. Default
   * false (refuses → caller must explicitly opt in). Not exposed in v1
   * UI — keeps the migration clean (no half-merge surprises).
   */
  merge_into_existing?: boolean
}

export interface MigrationResult {
  /** Absolute path of the destination after the copy. */
  target_path: string
  /** Absolute path of the source — left in place per user-locked decision. */
  kept_old_at: string
  /** Total files copied (recursive count). Excludes directory entries. */
  copied_files: number
  /** Total bytes copied across all files. */
  copied_bytes: number
  /**
   * Files copied for projects with external `output_root` (assets
   * folders outside `PROJECTS_ROOT`). Subset of `copied_files` —
   * surfaced separately so the UI can report "metadata X MB · assets
   * Y GB · N projects co-located".
   */
  assets_copied_files: number
  /** Bytes copied during the per-project asset co-location phase. */
  assets_copied_bytes: number
  /**
   * Per-project notes from the asset phase. A project with .icloud
   * placeholders, a missing source, or a destination collision lands
   * here — its metadata still moves, but the assets stay where they
   * were and the recovery banner picks the project up on the next
   * boot. Empty when every project's assets co-located cleanly.
   */
  per_project_asset_warnings: Array<{ slug: string; warning: string }>
  /** Per-issue notes that didn't abort the run (e.g. unreadable files skipped). */
  warnings: string[]
}

/**
 * Validate a candidate target path BEFORE doing any IO. Throws with
 * an HTTP-friendly message + statusCode the route layer maps. The
 * separate function lets the route surface validation errors as 400
 * (caller fix-able) without conflating them with 500 (transient fs
 * problems).
 */
export function validateMigrationTarget(target: string, source: string): { ok: true } {
  if (!target || typeof target !== 'string') {
    const e: any = new Error('target_path is required')
    e.statusCode = 400; throw e
  }
  if (!path.isAbsolute(target)) {
    const e: any = new Error(`target_path must be an absolute path; got: ${target}`)
    e.statusCode = 400; throw e
  }
  // Use path.resolve so trailing slashes / dot segments don't trip the
  // equality + containment checks below.
  const targetAbs = path.resolve(target)
  const sourceAbs = path.resolve(source)
  if (targetAbs === sourceAbs) {
    const e: any = new Error('target_path is the same as the current projects location — nothing to do')
    e.statusCode = 400; throw e
  }
  // Containment check: target must NOT be inside source. Path.relative
  // returns a path that doesn't start with `..` when target is inside
  // source. We add a trailing path.sep to sourceAbs so identically-
  // prefixed siblings (e.g. `/projects` vs `/projects-new`) aren't
  // mistaken for parent-of-relationships.
  const rel = path.relative(sourceAbs, targetAbs)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const e: any = new Error(`target_path cannot be inside the current projects directory (would recurse). source=${sourceAbs} target=${targetAbs}`)
    e.statusCode = 400; throw e
  }
  return { ok: true }
}

/**
 * Recursively count files + bytes in a directory. Used both pre-copy
 * (to size the operation for the UI's confirmation dialog) and post-
 * copy (sanity check that source + target match).
 */
async function tallyDir(dir: string): Promise<{ files: number; bytes: number }> {
  if (!existsSync(dir)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  async function walk(d: string): Promise<void> {
    let entries: any[]
    try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile()) {
        files++
        try { bytes += (await fs.stat(p)).size } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

/**
 * Read the on-disk `output_root` field for a project at a given root,
 * resolved to an absolute path. Returns null if project.json is missing
 * or unreadable. Pure read.
 */
async function readProjectOutputRoot(projectDir: string): Promise<{
  raw_field: string | null
  resolved_abs: string
} | null> {
  const metaPath = path.join(projectDir, 'project.json')
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const rawField = typeof meta.output_root === 'string' ? meta.output_root : null
    const out = rawField || './episodes'
    const resolved = path.isAbsolute(out) ? out : path.join(projectDir, out)
    return { raw_field: rawField, resolved_abs: path.resolve(resolved) }
  } catch {
    return null
  }
}

/**
 * Determine whether a project's output_root lives OUTSIDE its project
 * directory and therefore needs to be co-migrated alongside the
 * metadata copy. Returns the absolute source path if yes, null if no
 * (relative paths or absolute paths that already resolve inside the
 * project dir are already co-located).
 */
async function externalOutputRootFor(projectDir: string): Promise<string | null> {
  const r = await readProjectOutputRoot(projectDir)
  if (!r) return null
  // Relative path → resolves inside projectDir → already co-located.
  if (!r.raw_field || !path.isAbsolute(r.raw_field)) return null
  // Absolute → check containment. path.relative returns '..' or absolute
  // when rootResolved is outside dirResolved.
  const rel = path.relative(path.resolve(projectDir), r.resolved_abs)
  if (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) return null
  return r.resolved_abs
}

/**
 * Pre-flight tally — surfaces "this will copy N files (X GB)" for the
 * UI's confirmation dialog. Pure read-only.
 *
 * The breakdown lets the dialog show "metadata 38 MB · assets 274 GB
 * across 2 projects" up front so the operator isn't surprised when
 * a click that previously sized at "tens of MB" turns into a
 * multi-hour copy.
 */
export async function previewMigration(): Promise<{
  source_path: string
  files: number
  bytes: number
  /** Subset of `files`/`bytes` accounted for by external `output_root`s. */
  asset_files: number
  asset_bytes: number
  /** Number of projects whose assets need co-location during the move. */
  projects_with_external_assets: number
}> {
  const root = projectsRoot()
  const metadataT = await tallyDir(root)
  // Walk projects + add up external-asset bytes for each one that has
  // its output_root pointing outside the metadata folder.
  let assetFiles = 0
  let assetBytes = 0
  let withExternal = 0
  let entries: any[] = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch { /* projects root missing — return metadata zeros */ }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    const projectDir = path.join(root, e.name)
    const ext = await externalOutputRootFor(projectDir)
    if (!ext || !existsSync(ext)) continue
    withExternal++
    const t = await tallyDir(ext)
    assetFiles += t.files
    assetBytes += t.bytes
  }
  return {
    source_path: root,
    files: metadataT.files + assetFiles,
    bytes: metadataT.bytes + assetBytes,
    asset_files: assetFiles,
    asset_bytes: assetBytes,
    projects_with_external_assets: withExternal,
  }
}

/**
 * Inspect a candidate target dir to see if it already contains Story
 * Studio projects. Used by the "Use existing folder (no copy)" flow on
 * a second machine: the user picks the iCloud-synced folder that
 * already has projects, the UI confirms how many it found, then sets
 * the override without copying anything.
 *
 * A "project" here is any immediate subdirectory containing a
 * `project.json` file. Lightweight scan — depth-1 only, no recursion
 * into episode folders.
 */
export async function inspectTargetForExistingProjects(targetDir: string): Promise<{
  target_path: string
  exists: boolean
  project_count: number
  /** First 10 project slugs for the preview confirmation. */
  sample_slugs: string[]
}> {
  if (!targetDir || typeof targetDir !== 'string' || !path.isAbsolute(targetDir)) {
    const e: any = new Error('target_path must be an absolute path string')
    e.statusCode = 400; throw e
  }
  const targetAbs = path.resolve(targetDir)
  if (!existsSync(targetAbs)) {
    return { target_path: targetAbs, exists: false, project_count: 0, sample_slugs: [] }
  }

  let entries: any[]
  try {
    entries = await fs.readdir(targetAbs, { withFileTypes: true })
  } catch {
    // Unreadable target — surface as 0 projects rather than 500. The
    // override will still be settable; on restart the dashboard will
    // be empty and the user can re-pick.
    return { target_path: targetAbs, exists: true, project_count: 0, sample_slugs: [] }
  }

  const slugs: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue   // skip dotfolders / cloud metadata dirs
    if (existsSync(path.join(targetAbs, e.name, 'project.json'))) {
      slugs.push(e.name)
    }
  }

  return {
    target_path: targetAbs,
    exists: true,
    project_count: slugs.length,
    sample_slugs: slugs.slice(0, 10),
  }
}

/**
 * Migrate the current PROJECTS_ROOT to `targetDir`. Throws on validation
 * failure (statusCode set for HTTP mapping). On copy failure mid-run,
 * the partial copy at the target is left in place (caller / user
 * decides whether to retry or remove). Source is never modified.
 */
export async function migrateProjectsTo(
  targetDir: string,
  opts: MigrationOptions = {},
): Promise<MigrationResult> {
  const source = projectsRoot()

  validateMigrationTarget(targetDir, source)

  const targetAbs = path.resolve(targetDir)
  const warnings: string[] = []

  // Source must exist + be a dir. If the user has never opened the app
  // before, PROJECTS_ROOT may not exist yet — there's nothing to move,
  // but we'll still create the override (caller can do that separately;
  // this function refuses an empty source as a no-op).
  if (!existsSync(source)) {
    const e: any = new Error(`Current projects directory does not exist on disk (${source}) — nothing to migrate.`)
    e.statusCode = 400; throw e
  }
  const sourceTally = await tallyDir(source)
  if (sourceTally.files === 0) {
    warnings.push(`Source projects directory is empty (${source}) — proceeding will create the target dir but copy nothing.`)
  }

  // Target may or may not exist. If it exists + is non-empty, refuse
  // unless the caller opted into merge_into_existing.
  if (existsSync(targetAbs)) {
    let targetEntries: string[] = []
    try { targetEntries = await fs.readdir(targetAbs) } catch { /* unreadable → treat as empty */ }
    // Filter out OS / cloud junk that's normal in any folder.
    const meaningful = targetEntries.filter(e =>
      e !== '.DS_Store' && e !== '.localized' && !e.startsWith('._'),
    )
    if (meaningful.length && !opts.merge_into_existing) {
      const e: any = new Error(
        `Target already contains files: ${targetAbs}. Pick an empty folder or one you don't mind merging into. ` +
        `(${meaningful.slice(0, 3).join(', ')}${meaningful.length > 3 ? ', …' : ''})`,
      )
      e.statusCode = 409; throw e
    }
  }

  // Ensure the target dir exists. mkdir -p semantics.
  await fs.mkdir(targetAbs, { recursive: true })

  // Use fs.cp for the recursive copy. Native impl handles EXDEV
  // transparently — cross-device copies fall through to read+write
  // automatically. `force: true` lets us overwrite if merge_into_
  // existing was set; without it, fs.cp throws EEXIST per file.
  try {
    await fs.cp(source, targetAbs, {
      recursive: true,
      force: !!opts.merge_into_existing,
      // errorOnExist defaults to false in modern Node when force=false,
      // but on existing same-name files inside the target it'll throw.
      // Since we already validated the target is empty (or merge mode),
      // there's nothing inside to clash with.
      preserveTimestamps: true,
    })
  } catch (e: any) {
    const err: any = new Error(`Copy failed mid-run: ${e?.message || e}. Source intact at ${source}.`)
    err.statusCode = 500
    throw err
  }

  // Post-copy verification: file count must match source. Bytes can
  // legitimately differ slightly if cp normalises filesystem-specific
  // metadata, but the file count is a hard invariant.
  const targetTally = await tallyDir(targetAbs)
  if (targetTally.files !== sourceTally.files) {
    warnings.push(
      `File count mismatch after copy: source=${sourceTally.files}, target=${targetTally.files}. ` +
      `Verify the target manually before deleting the old location.`,
    )
  }
  if (targetTally.bytes !== sourceTally.bytes) {
    warnings.push(
      `Byte size differs after copy: source=${sourceTally.bytes}, target=${targetTally.bytes}. ` +
      `(Likely benign metadata-overhead drift on cross-volume copy.)`,
    )
  }

  // Per-project asset co-location: walk every project at the NEW
  // target. For each whose project.json has an external `output_root`,
  // copy that source folder to <newProjectDir>/episodes/ + rewrite the
  // new copy of project.json to use './episodes' (relative). This is
  // what fixes the "I moved my project to iCloud but the assets stayed
  // on the original Mac" bug — the absolute paths are valid on THIS
  // machine, so we can reach them, copy them into the new layout, and
  // ship a portable, ready-to-sync tree.
  //
  // We operate on the COPY at the target — never touch the source's
  // project.json — so a mid-run failure leaves the original setup
  // fully working. Failures per project don't halt the bulk operation;
  // the project's metadata still moves, the asset gap surfaces via the
  // recovery banner on the next boot.
  let assetFiles = 0
  let assetBytes = 0
  const perProjectWarnings: Array<{ slug: string; warning: string }> = []
  let targetEntries: any[] = []
  try {
    targetEntries = await fs.readdir(targetAbs, { withFileTypes: true })
  } catch { /* unreadable — already warned via tally mismatch above */ }
  for (const e of targetEntries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    const slug = e.name
    const newProjectDir = path.join(targetAbs, slug)
    const externalSource = await externalOutputRootFor(newProjectDir)
    if (!externalSource) continue  // already co-located — skip silently
    if (!existsSync(externalSource)) {
      perProjectWarnings.push({
        slug,
        warning:
          `Asset folder missing on disk (${externalSource}) — metadata moved but assets weren't. ` +
          `Open this project on the new machine and either restore the folder or use Reset to start fresh.`,
      })
      continue
    }
    const dest = path.join(newProjectDir, 'episodes')
    if (existsSync(dest)) {
      // Should be rare — would mean PROJECTS_ROOT/<slug>/episodes already
      // had content alongside the absolute output_root. Refuse to
      // clobber; the per-project recovery flow can resolve.
      let destEntries: string[] = []
      try { destEntries = await fs.readdir(dest) } catch { /* ignore */ }
      const meaningful = destEntries.filter(n => n !== '.DS_Store' && !n.startsWith('._'))
      if (meaningful.length > 0) {
        perProjectWarnings.push({
          slug,
          warning:
            `Destination ${dest} already had content; assets not co-located. ` +
            `Resolve manually then use Project tab → Move asset location to retry.`,
        })
        continue
      }
    }
    try {
      await fs.cp(externalSource, dest, { recursive: true, preserveTimestamps: true })
      const t = await tallyDir(dest)
      assetFiles += t.files
      assetBytes += t.bytes
      // Rewrite the new copy's project.json so output_root points at
      // the relative './episodes' — portable for the next sync hop.
      const metaPath = path.join(newProjectDir, 'project.json')
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
        meta.output_root = './episodes'
        await writeJsonAtomic(metaPath, meta, { mode: 0o600 })
      } catch (rewriteErr: any) {
        perProjectWarnings.push({
          slug,
          warning:
            `Assets co-located at ${dest} but project.json rewrite failed: ${rewriteErr?.message || rewriteErr}. ` +
            `Open project.json manually and set "output_root": "./episodes".`,
        })
      }
    } catch (cpErr: any) {
      perProjectWarnings.push({
        slug,
        warning: `Asset copy failed: ${cpErr?.message || cpErr}. Metadata moved; assets stayed at ${externalSource}.`,
      })
    }
  }

  return {
    target_path: targetAbs,
    kept_old_at: source,
    copied_files: targetTally.files + assetFiles,
    copied_bytes: targetTally.bytes + assetBytes,
    assets_copied_files: assetFiles,
    assets_copied_bytes: assetBytes,
    per_project_asset_warnings: perProjectWarnings,
    warnings,
  }
}
