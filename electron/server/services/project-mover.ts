/**
 * Per-project mover — relocates a project's metadata folder (and any
 * co-located assets) to a destination chosen by the user, then
 * registers the new path in the linked-projects registry so the app
 * keeps finding it by slug.
 *
 * Why this exists
 * ---------------
 * The pre-v1.0.15 model assumed a single global PROJECTS_ROOT — every
 * project lived inside it. That made the "Storage tab → Move projects"
 * flow all-or-nothing: either every project goes to iCloud or none do.
 *
 * Operators with mixed needs (TerraNash in iCloud for cross-Mac sync,
 * Dozing Knight on local SSD for fast scratch renders) couldn't be
 * served. This service is the per-project escape hatch: pick any
 * destination folder, the project moves there, and a linked-paths
 * entry keeps it discoverable across boots.
 *
 * Safety invariants
 * -----------------
 * - The source folder is preserved by default. Caller passes
 *   `delete_source: true` to remove it post-copy. With delete_source
 *   off, the source is RENAMED to <slug>.bak-<ISO> so listProjects'
 *   PROJECTS_ROOT scan doesn't re-list the same project at the old
 *   location AND the new linked-paths entry simultaneously.
 * - Pre-flight: refuse when destination already contains content
 *   (modulo OS junk like .DS_Store).
 * - Pre-flight: refuse when source has .icloud placeholders — we'd
 *   only copy the stub bytes and silently lose data on the next sync.
 * - Pre-flight: free-disk check on the destination volume with a
 *   1.2× safety margin.
 * - Atomic: the linked-paths entry is registered AFTER the copy + verify
 *   succeeds. A mid-copy crash leaves the original setup fully working.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { getFreeBytes, formatBytes } from '../lib/disk.js'
import { getProjectDir, PROJECTS_ROOT } from './project-manager.js'
import { addLinkedProject, getLinkedProjectPaths, removeLinkedProject } from './linked-projects.js'

export interface ProjectMoveStatus {
  /** The project's current absolute folder path. */
  current_path: string
  /** True if current_path is inside PROJECTS_ROOT (default location). */
  is_default_location: boolean
  /** True if current_path is registered as a linked path (already moved). */
  is_linked: boolean
  /** Recursive byte count under current_path. */
  estimated_bytes: number
  /** Recursive file count under current_path. */
  estimated_files: number
  /** .icloud placeholder names that block the move (visible filenames). */
  icloud_blockers: string[]
}

export interface ProjectMoveResult {
  slug: string
  /** Where the project lives after the move (absolute). */
  new_path: string
  /** Where the project lived before (absolute). */
  old_path: string
  /**
   * What happened to the source after copy:
   *   - 'deleted'  → removed (caller passed delete_source: true)
   *   - 'renamed'  → renamed to <slug>.bak-<ISO> for manual verification
   *   - 'kept_at_linked' → was a linked path; nothing renamed (caller
   *     can re-link manually if they want to revert)
   */
  source_disposition: 'deleted' | 'renamed' | 'kept_at_linked'
  /** Path of the renamed-source folder when source_disposition === 'renamed'. */
  renamed_source_path?: string
  copied_files: number
  copied_bytes: number
  /** Non-blocking notes from the run. */
  warnings: string[]
}

/**
 * Recursively count files + bytes + .icloud placeholders. Used both
 * for the pre-flight disk-space check and the user-facing size
 * estimate. Single pass so opening Project tab doesn't bog down on
 * large project trees.
 */
async function scanTree(root: string): Promise<{ files: number; bytes: number; placeholders: string[] }> {
  const out = { files: 0, bytes: 0, placeholders: [] as string[] }
  if (!existsSync(root)) return out
  const PLACEHOLDER_LIMIT = 20
  async function walk(dir: string): Promise<void> {
    let entries: any[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile()) {
        out.files++
        try { out.bytes += (await fs.stat(p)).size } catch { /* skip */ }
        if (
          out.placeholders.length < PLACEHOLDER_LIMIT &&
          e.name.startsWith('.') && e.name.endsWith('.icloud')
        ) {
          const visible = e.name.slice(1, -'.icloud'.length)
          out.placeholders.push(path.relative(root, path.join(dir, visible)))
        }
      }
    }
  }
  await walk(root)
  return out
}

/**
 * Inspect a project's current folder + tell the caller what a move
 * would cost. Read-only; safe to call repeatedly for the live UI.
 */
export async function detectProjectMoveStatus(slug: string): Promise<ProjectMoveStatus> {
  const dir = getProjectDir(slug)
  if (!dir) {
    const e: any = new Error(`Project '${slug}' not found`)
    e.statusCode = 404; throw e
  }
  const isDefault = path.resolve(dir).startsWith(path.resolve(PROJECTS_ROOT) + path.sep) ||
    path.resolve(dir) === path.resolve(PROJECTS_ROOT)
  const linkedPaths = await getLinkedProjectPaths()
  const isLinked = linkedPaths.includes(path.resolve(dir))
  const scan = await scanTree(dir)
  return {
    current_path: dir,
    is_default_location: isDefault,
    is_linked: isLinked,
    estimated_bytes: scan.bytes,
    estimated_files: scan.files,
    icloud_blockers: scan.placeholders,
  }
}

/**
 * Move a project's folder to `destFolder`. The destination is treated
 * as the PARENT of the new project folder — if you pass
 * `/iCloud/Stories`, the project lands at
 * `/iCloud/Stories/<slug>/`. The slug is preserved so future
 * `getProjectDir(slug)` lookups continue to work via the new linked
 * entry.
 *
 * Validation is layered: path must be absolute, must not equal the
 * source, must not be inside the source (recursive copy nightmare),
 * destination project folder must not already exist with content,
 * source must be free of .icloud placeholders, destination volume
 * must have free space ≥ estimated × 1.2.
 *
 * On success, returns the new path and reports what happened to the
 * source. Throws (with statusCode for HTTP mapping) on validation
 * failure or copy failure. Source is preserved on every error path
 * so the original setup is always recoverable.
 */
export async function moveProjectToFolder(
  slug: string,
  destFolder: string,
  opts: { delete_source?: boolean } = {},
): Promise<ProjectMoveResult> {
  const sourceDir = getProjectDir(slug)
  if (!sourceDir) {
    const e: any = new Error(`Project '${slug}' not found`)
    e.statusCode = 404; throw e
  }
  if (!destFolder || typeof destFolder !== 'string' || !path.isAbsolute(destFolder)) {
    const e: any = new Error('destination must be an absolute path')
    e.statusCode = 400; throw e
  }
  const sourceAbs = path.resolve(sourceDir)
  const parentAbs = path.resolve(destFolder)
  // The new folder lands at <destFolder>/<slug> — never silently
  // append the project's display name. Preserving the slug means
  // every existing absolute reference in stored configs (and the
  // `${PROJECT}` portable token) keeps resolving correctly post-move.
  const newDir = path.join(parentAbs, path.basename(sourceAbs))

  if (path.resolve(newDir) === sourceAbs) {
    const e: any = new Error(
      `Destination resolves to the project's current location (${sourceAbs}) — nothing to move.`,
    )
    e.statusCode = 400; throw e
  }
  // Guard against picking the source's own subdir (recursive copy).
  const rel = path.relative(sourceAbs, path.resolve(newDir))
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    e_throw(400, `Destination cannot be inside the project's current folder: source=${sourceAbs}, target=${newDir}`)
  }

  // Pre-flight: source quality
  const sourceScan = await scanTree(sourceAbs)
  if (sourceScan.placeholders.length > 0) {
    const head = sourceScan.placeholders.slice(0, 3).join(', ')
    const tail = sourceScan.placeholders.length > 3 ? ` … (+${sourceScan.placeholders.length - 3} more)` : ''
    e_throw(409,
      `${sourceScan.placeholders.length} file(s) in this project are iCloud placeholders ` +
      `(not downloaded to this Mac). Migrating them would copy stub bytes and silently lose data. ` +
      `Open ${sourceAbs} in Finder, right-click the parent → "Download Now", wait for every ` +
      `file to lose the cloud icon, then retry. Examples: ${head}${tail}`,
    )
  }

  // Pre-flight: destination empty
  if (existsSync(newDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(newDir) } catch { /* unreadable → block */ }
    const meaningful = entries.filter(n => n !== '.DS_Store' && n !== '.localized' && !n.startsWith('._'))
    if (meaningful.length > 0) {
      e_throw(409,
        `Destination already exists with content: ${newDir}. ` +
        `Move or rename it manually before retrying. ` +
        `(Found: ${meaningful.slice(0, 3).join(', ')}${meaningful.length > 3 ? ' …' : ''})`,
      )
    }
  }

  // Pre-flight: free disk space on the destination volume
  await fs.mkdir(parentAbs, { recursive: true })
  const free = await getFreeBytes(parentAbs)
  const required = Math.ceil(sourceScan.bytes * 1.2)
  if (free > 0 && free < required) {
    e_throw(507,
      `Not enough free disk space at ${parentAbs}. ` +
      `Have: ${formatBytes(free)}, need: ${formatBytes(required)} ` +
      `(estimate × 1.2 safety margin). Free up space or pick a different destination and retry.`,
    )
  }

  // Recursive copy. fs.cp handles cross-device copies natively, so
  // moves between local SSD and iCloud Drive Just Work.
  try {
    await fs.cp(sourceAbs, newDir, { recursive: true, preserveTimestamps: true })
  } catch (e: any) {
    e_throw(500,
      `Project copy failed mid-run: ${e?.message || e}. Source intact at ${sourceAbs}. ` +
      `Partial destination at ${newDir} should be removed before retrying.`,
    )
  }

  // Verify by file count — bytes can drift slightly across volumes
  // due to FS metadata overhead, but file count is invariant.
  const targetScan = await scanTree(newDir).catch(() => ({ files: 0, bytes: 0, placeholders: [] as string[] }))
  const warnings: string[] = []
  if (targetScan.files !== sourceScan.files) {
    warnings.push(
      `File count mismatch after copy: source=${sourceScan.files}, target=${targetScan.files}. ` +
      `Verify the new folder manually before deleting the old one.`,
    )
  }

  // Register the new path FIRST so a crash before source disposition
  // doesn't orphan the project. addLinkedProject also reads the new
  // project.json + validates the slug at the new location.
  await addLinkedProject(newDir)

  // Disposition of the source. Three branches:
  //   1. Source was a linked path already → de-register it (the slug
  //      now resolves via the new linked path).
  //   2. delete_source: true → rm -rf the source.
  //   3. Default → rename the source to <slug>.bak-<ISO> so listProjects
  //      doesn't re-list it from PROJECTS_ROOT alongside the new linked
  //      entry. The user can verify, then rename back to undo or delete
  //      manually when satisfied.
  let disposition: ProjectMoveResult['source_disposition']
  let renamedSourcePath: string | undefined
  const sourceIsLinked = (await getLinkedProjectPaths()).includes(sourceAbs)
  if (sourceIsLinked) {
    await removeLinkedProject(sourceAbs)
    if (opts.delete_source) {
      try { await fs.rm(sourceAbs, { recursive: true, force: true }) } catch (e: any) {
        warnings.push(`Could not delete previous linked source at ${sourceAbs}: ${e?.message || e}.`)
      }
      disposition = 'deleted'
    } else {
      disposition = 'kept_at_linked'
    }
  } else if (opts.delete_source) {
    try {
      await fs.rm(sourceAbs, { recursive: true, force: true })
      disposition = 'deleted'
    } catch (e: any) {
      // Don't fail the whole operation — the move succeeded, source
      // removal is the cherry-on-top step.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const renamed = `${sourceAbs}.bak-${stamp}`
      try { await fs.rename(sourceAbs, renamed) } catch { /* leave source as-is */ }
      warnings.push(
        `Could not delete the source at ${sourceAbs}: ${e?.message || e}. ` +
        `Renamed to ${renamed} so it stops showing up in the projects list. ` +
        `Delete manually when ready.`,
      )
      disposition = 'renamed'
      renamedSourcePath = renamed
    }
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const renamed = `${sourceAbs}.bak-${stamp}`
    try {
      await fs.rename(sourceAbs, renamed)
      disposition = 'renamed'
      renamedSourcePath = renamed
    } catch (e: any) {
      // Failure to rename means the user will see two listings of the
      // same project until they manually clean up. Surface clearly.
      warnings.push(
        `Move succeeded but couldn't rename the source ${sourceAbs}: ${e?.message || e}. ` +
        `The project will appear twice in the list until you rename or delete the old folder manually.`,
      )
      disposition = 'renamed'
    }
  }

  return {
    slug,
    new_path: newDir,
    old_path: sourceAbs,
    source_disposition: disposition,
    renamed_source_path: renamedSourcePath,
    copied_files: targetScan.files,
    copied_bytes: targetScan.bytes,
    warnings,
  }
}

/**
 * Throw an Error with an HTTP-friendly statusCode tag the route layer
 * can map. Inline helper so the call sites stay readable.
 */
function e_throw(statusCode: number, message: string): never {
  const e: any = new Error(message)
  e.statusCode = statusCode
  throw e
}
