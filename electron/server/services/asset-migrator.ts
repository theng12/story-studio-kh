/**
 * Per-project asset migration: relocate a project's `output_root`
 * (where its episode folders, scripts, images, audio, and video files
 * physically live) into the co-located `<projectDir>/episodes/`
 * layout that the rest of the pipeline assumes by default.
 *
 * Why this exists
 * ---------------
 * `PROJECTS_ROOT` (per-project metadata: project.json, config.json,
 * secrets.json, jobs.json) and `output_root` (per-project assets) are
 * two independent storage roots. Users who took the older "Choose
 * project location" wizard ended up with `output_root` set to an
 * absolute path outside the metadata folder (e.g. ~/Downloads/Story
 * Studio/...). When they later run the Storage tab's "Move projects
 * to iCloud" flow, only the metadata follows — the assets stay at
 * the original absolute path. Cross-Mac sync then sees nothing to
 * sync. This service unifies the two: post-migration, output_root
 * is `'./episodes'` (relative) and the next "Move projects" carries
 * everything atomically.
 *
 * Both UIs (Storage tab bulk + Project tab single) call into here.
 *
 * Safety invariants
 * -----------------
 * - The source folder is NEVER touched on success (caller can pass
 *   `delete_source: true` to remove it after; default false).
 * - If the destination already exists with files, refuse — never merge
 *   over user content. Caller can re-run after manually clearing.
 * - .icloud placeholder files (macOS iCloud Drive evictions) are
 *   detected up-front and the migration refuses; copying placeholder
 *   stub bytes would silently lose data.
 * - Free-disk pre-check on the destination volume; refuses if free <
 *   estimate × 1.2 to leave headroom for FS overhead.
 * - project.json is rewritten ONLY after the recursive copy succeeds.
 *   On failure mid-copy, the source still works as-is.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { getFreeBytes, formatBytes } from '../lib/disk.js'
import { getProjectDir, getProjectOutputRoot } from './project-manager.js'

export type AssetLocationKind =
  /** output_root is './episodes' (or another relative path) — already co-located. */
  | 'relative'
  /** output_root is an absolute path that resolves INSIDE the project dir — also co-located, just stamped as absolute. */
  | 'absolute_inside_project_dir'
  /** output_root is an absolute path OUTSIDE the project dir — needs migration to co-locate. */
  | 'absolute_external'
  /** project.json missing / unreadable — caller should treat as a hard error. */
  | 'unknown'

export interface AssetMigrationStatus {
  /** True iff migration would change anything (i.e. kind === 'absolute_external'). */
  needed: boolean
  /** Resolved absolute path of the current output_root (where assets live now). */
  current_output_root: string
  /** Classification of the current output_root vs. the project dir. */
  current_kind: AssetLocationKind
  /** Path the migration would copy assets into: `<projectDir>/episodes`. */
  projected_target: string
  /** Recursive byte size of the source. Best-effort; missing on error. */
  estimated_bytes?: number
  /** Recursive file count of the source. Best-effort; missing on error. */
  estimated_files?: number
  /** Non-blocking observations (e.g. estimate failed). */
  warnings: string[]
  /** Hard blockers (e.g. .icloud placeholders) — refuse to migrate until cleared. */
  blockers: string[]
}

export interface AssetMigrationResult {
  slug: string
  /** Bytes copied across all asset files. */
  copied_bytes: number
  /** File count copied. */
  copied_files: number
  /** Original absolute path — kept on disk on success unless `delete_source`. */
  source_kept_at: string | null
  /** Absolute path of the new output_root after migration. */
  new_output_root_abs: string
  /** Value written into project.json (always './episodes' for the v1 layout). */
  new_output_root_field: string
  /** Best-effort warnings from the run. */
  warnings: string[]
}

/**
 * Walk a directory tree counting files + bytes and detecting macOS
 * iCloud placeholder files (the dot-prefixed, dot-icloud-suffixed
 * stubs that appear when "Optimize Mac Storage" evicts a synced
 * file). Single pass — used both for the size estimate and the
 * placeholder pre-flight.
 */
async function scanSourceTree(root: string): Promise<{
  files: number
  bytes: number
  icloudPlaceholders: string[]
}> {
  const result = { files: 0, bytes: 0, icloudPlaceholders: [] as string[] }
  if (!existsSync(root)) return result
  const PLACEHOLDER_LIMIT = 20  // surface the first 20; truncate beyond
  async function walk(dir: string): Promise<void> {
    let entries: any[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile()) {
        result.files++
        try { result.bytes += (await fs.stat(p)).size } catch { /* skip unreadable */ }
        // macOS evicted-from-disk placeholder: filename starts with '.'
        // and ends with '.icloud'. The visible filename inside Finder
        // strips both — so the user sees `narration.mp3` even when on
        // disk it's `.narration.mp3.icloud` (a few-hundred-byte stub).
        if (
          result.icloudPlaceholders.length < PLACEHOLDER_LIMIT &&
          e.name.startsWith('.') && e.name.endsWith('.icloud')
        ) {
          // Store the visible name (strip leading '.' + trailing '.icloud')
          // because that's what the user sees in Finder + their preset.
          const visible = e.name.slice(1, -'.icloud'.length)
          const visibleRel = path.relative(root, path.join(dir, visible))
          result.icloudPlaceholders.push(visibleRel)
        }
      }
    }
  }
  await walk(root)
  return result
}

/**
 * Classify a project's output_root relative to its project dir. Pure
 * (no IO beyond the project.json read inside getProjectOutputRoot).
 */
function classifyOutputRoot(absOutputRoot: string, projectDir: string): AssetLocationKind {
  const rootResolved = path.resolve(absOutputRoot)
  const dirResolved = path.resolve(projectDir)
  // path.relative returns '..' or absolute when target is outside source.
  // Inside-or-equal returns a relative path that doesn't start with '..'
  // — including '' for exact equality.
  const rel = path.relative(dirResolved, rootResolved)
  if (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) {
    return 'absolute_inside_project_dir'
  }
  return 'absolute_external'
}

/**
 * Read the on-disk output_root field from project.json without
 * resolving relative paths. Used to distinguish "literally relative"
 * from "absolute path that happens to land inside the project dir".
 */
async function readRawOutputRootField(projectDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8')
    const meta = JSON.parse(raw) as { output_root?: unknown }
    return typeof meta.output_root === 'string' ? meta.output_root : null
  } catch {
    return null
  }
}

/**
 * Inspect a project's current asset location + tell the caller what a
 * migration would do (size estimate, blockers). Read-only; safe to
 * call repeatedly for live UI banners.
 */
export async function detectAssetMigrationStatus(slug: string): Promise<AssetMigrationStatus> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) {
    return {
      needed: false,
      current_output_root: '',
      current_kind: 'unknown',
      projected_target: '',
      warnings: [`Project '${slug}' not found in PROJECTS_ROOT`],
      blockers: [],
    }
  }
  const projectedTarget = path.join(projectDir, 'episodes')
  const rawField = await readRawOutputRootField(projectDir)
  const absOutputRoot = await getProjectOutputRoot(slug)
  if (!absOutputRoot) {
    return {
      needed: false,
      current_output_root: '',
      current_kind: 'unknown',
      projected_target: projectedTarget,
      warnings: [`project.json missing or unreadable for '${slug}'`],
      blockers: [],
    }
  }

  // Distinguish literally-relative on disk from absolute. Three cases
  // collapse to 'relative': missing field (defaults to './episodes' in
  // getProjectOutputRoot), explicitly relative string, or empty string.
  // Anything else is absolute → classify by containment relative to
  // the project dir.
  //
  // Even when an absolute path resolves inside the project dir, it's
  // still stamped as absolute on disk. We treat that as
  // `absolute_inside_project_dir` (needed: false — bytes already
  // co-located). A separate normalise call could rewrite it to './episodes'
  // for portability if we ever want one; for now it's a no-op.
  let kind: AssetLocationKind
  if (rawField === null || rawField === '' || !path.isAbsolute(rawField)) {
    kind = 'relative'
  } else {
    kind = classifyOutputRoot(absOutputRoot, projectDir)
  }

  const status: AssetMigrationStatus = {
    needed: kind === 'absolute_external',
    current_output_root: absOutputRoot,
    current_kind: kind,
    projected_target: projectedTarget,
    warnings: [],
    blockers: [],
  }

  if (kind !== 'absolute_external') return status

  // Source is external — scan it for size + placeholder check.
  if (!existsSync(absOutputRoot)) {
    status.blockers.push(
      `Asset folder doesn't exist on disk: ${absOutputRoot}. ` +
      `Either restore it from backup or use Reset to start a fresh output_root.`,
    )
    return status
  }
  try {
    const scan = await scanSourceTree(absOutputRoot)
    status.estimated_bytes = scan.bytes
    status.estimated_files = scan.files
    if (scan.icloudPlaceholders.length > 0) {
      status.blockers.push(
        `${scan.icloudPlaceholders.length} file(s) in this asset folder are iCloud placeholders ` +
        `(not downloaded to this Mac). Migrating them would copy stub bytes and silently lose data. ` +
        `Open the source folder in Finder, right-click the parent folder → "Download Now", wait for ` +
        `every file to lose the cloud icon, then retry. Examples: ` +
        scan.icloudPlaceholders.slice(0, 3).join(', ') +
        (scan.icloudPlaceholders.length > 3 ? ` … (+${scan.icloudPlaceholders.length - 3} more)` : ''),
      )
    }
  } catch (e: any) {
    status.warnings.push(`Couldn't scan source folder for size estimate: ${e?.message || e}`)
  }
  return status
}

/**
 * Run the migration for a single project. Returns a result on
 * success; throws (with statusCode for HTTP mapping) on validation
 * failure or copy failure. The source folder is preserved unless
 * the caller passes `delete_source: true` AND the copy succeeds.
 */
export async function migrateProjectAssets(
  slug: string,
  opts: { delete_source?: boolean } = {},
): Promise<AssetMigrationResult> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) {
    const e: any = new Error(`Project '${slug}' not found in PROJECTS_ROOT`)
    e.statusCode = 404; throw e
  }

  const status = await detectAssetMigrationStatus(slug)
  if (!status.needed) {
    const e: any = new Error(
      `Project '${slug}' assets are already co-located (kind=${status.current_kind}). Nothing to migrate.`,
    )
    e.statusCode = 400; throw e
  }
  if (status.blockers.length > 0) {
    const e: any = new Error(`Asset migration blocked: ${status.blockers.join(' | ')}`)
    e.statusCode = 409; throw e
  }

  const source = status.current_output_root
  const target = status.projected_target
  const targetParent = path.dirname(target)

  // Refuse to merge over an existing destination — a user who's
  // already populated `<projectDir>/episodes` (e.g. via a fresh
  // template) shouldn't have it silently fused with another folder's
  // contents. Treat OS junk (.DS_Store, ._*) as ignorable.
  if (existsSync(target)) {
    let entries: string[] = []
    try { entries = await fs.readdir(target) } catch { /* unreadable → block */ }
    const meaningful = entries.filter(e =>
      e !== '.DS_Store' && e !== '.localized' && !e.startsWith('._'),
    )
    if (meaningful.length > 0) {
      const e: any = new Error(
        `Destination already exists with content: ${target}. Move or rename it manually before migrating, ` +
        `or pick a different target. (Found: ${meaningful.slice(0, 3).join(', ')}${meaningful.length > 3 ? ' …' : ''})`,
      )
      e.statusCode = 409; throw e
    }
  }

  // Free-disk pre-check on the destination volume. PROJECTS_ROOT and
  // the projectDir are typically on the same volume, but we check the
  // exact parent to be safe.
  const free = await getFreeBytes(targetParent)
  const estimated = status.estimated_bytes || 0
  if (free > 0 && estimated > 0 && free < Math.ceil(estimated * 1.2)) {
    const e: any = new Error(
      `Not enough free disk space at ${targetParent}. ` +
      `Have: ${formatBytes(free)}, need: ${formatBytes(Math.ceil(estimated * 1.2))} ` +
      `(estimate × 1.2 safety). Free up space or pick a smaller migration scope and retry.`,
    )
    e.statusCode = 507; throw e // HTTP 507 Insufficient Storage
  }

  await fs.mkdir(targetParent, { recursive: true })

  // Recursive copy. fs.cp handles cross-device automatically (EXDEV is
  // the common failure mode on cloud-synced volumes); native impl
  // falls through to read+write so this just works there too.
  try {
    await fs.cp(source, target, {
      recursive: true,
      preserveTimestamps: true,
      // errorOnExist defaults to false; we already validated emptiness
      // above so there's nothing inside to clash with anyway.
    })
  } catch (e: any) {
    const err: any = new Error(
      `Asset copy failed mid-run: ${e?.message || e}. Source intact at ${source}. ` +
      `Partial destination at ${target} should be removed before retrying.`,
    )
    err.statusCode = 500
    throw err
  }

  // Verify file counts match — bytes can drift slightly for FS metadata
  // overhead but file count is a hard invariant.
  const targetScan = await scanSourceTree(target).catch(() => ({ files: 0, bytes: 0, icloudPlaceholders: [] }))
  const warnings: string[] = []
  if (status.estimated_files != null && targetScan.files !== status.estimated_files) {
    warnings.push(
      `File count mismatch after copy: source=${status.estimated_files}, target=${targetScan.files}. ` +
      `Verify the new folder manually before deleting the old one.`,
    )
  }

  // Atomically rewrite project.json so output_root is the relative
  // canonical form. We do this AFTER the copy succeeds so a mid-copy
  // crash leaves the original setup fully working.
  const projectJsonPath = path.join(projectDir, 'project.json')
  let meta: any = {}
  try {
    meta = JSON.parse(await fs.readFile(projectJsonPath, 'utf-8'))
  } catch (e: any) {
    // File should exist (we read it via getProjectOutputRoot above).
    // If it's gone now, surface it but don't roll back the copy — the
    // user has the assets at the new location and can manually rebuild
    // project.json from the metadata template.
    warnings.push(`project.json read failed during rewrite: ${e?.message || e}. Bytes are at ${target} regardless.`)
  }
  meta.output_root = './episodes'
  await writeJsonAtomic(projectJsonPath, meta, { mode: 0o600 })

  // Optional source removal — only after the field rewrite is durable.
  let sourceKeptAt: string | null = source
  if (opts.delete_source) {
    try {
      await fs.rm(source, { recursive: true, force: true })
      sourceKeptAt = null
    } catch (e: any) {
      warnings.push(
        `Migration succeeded but couldn't remove the old source at ${source}: ${e?.message || e}. ` +
        `Delete it manually when ready.`,
      )
    }
  }

  return {
    slug,
    copied_bytes: targetScan.bytes,
    copied_files: targetScan.files,
    source_kept_at: sourceKeptAt,
    new_output_root_abs: target,
    new_output_root_field: './episodes',
    warnings,
  }
}
