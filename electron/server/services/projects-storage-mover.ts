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
import { PROJECTS_ROOT } from './project-manager.js'

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
 * Pre-flight tally — surfaces "this will copy N files (X GB)" for the
 * UI's confirmation dialog. Pure read-only.
 */
export async function previewMigration(): Promise<{
  source_path: string
  files: number
  bytes: number
}> {
  const t = await tallyDir(PROJECTS_ROOT)
  return { source_path: PROJECTS_ROOT, files: t.files, bytes: t.bytes }
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
  const source = PROJECTS_ROOT

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

  return {
    target_path: targetAbs,
    kept_old_at: source,
    copied_files: targetTally.files,
    copied_bytes: targetTally.bytes,
    warnings,
  }
}
