/**
 * One-time migration to move existing projects out of the hidden userData
 * folder and into a user-visible location. Tracked via {userData}/migrations.json.
 *
 * Flag file shape: { v1_output_root_migrated: ['slug1', ...] }
 *
 * A project is considered "needing migration" if its project.json has a
 * relative `output_root` (default '~./episodes') AND its slug is not in the
 * migrated list.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'

const require = createRequire(import.meta.url)

// ── Flag-file location ─────────────────────────────────────────────────────

function resolveFlagPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'migrations.json')
  }
  try {
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'migrations.json')
  } catch {}
  return path.join(process.cwd(), 'migrations.json')
}

interface MigrationFlags {
  v1_output_root_migrated?: string[]
  /**
   * Set once `migrateDescriptionToMetadata` has completed a full pass with no
   * failures. When true, the boot-time folder migration short-circuits and
   * skips the scan across every project. See `folder-migration.ts`.
   */
  description_to_metadata_v1_done?: boolean
}

async function readFlags(): Promise<MigrationFlags> {
  const p = resolveFlagPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'))
  } catch {
    return {}
  }
}

// ── Boot-migration markers (used by folder-migration.ts) ───────────────────

/**
 * True if the "rename 02 Description → 02 Metadata" migration has already
 * completed cleanly. Checked on every boot so we don't re-scan every project
 * after the first successful pass.
 */
export async function isDescriptionToMetadataDone(): Promise<boolean> {
  const flags = await readFlags()
  return !!flags.description_to_metadata_v1_done
}

/**
 * Record that the "02 Description → 02 Metadata" migration finished a clean
 * full pass (every project's project.json updated AND every legacy folder
 * renamed). Only call this after verifying no per-project failures.
 */
export async function markDescriptionToMetadataDone(): Promise<void> {
  const flagPath = resolveFlagPath()
  await withLock(flagPath, async () => {
    const flags = await readFlags()
    flags.description_to_metadata_v1_done = true
    await writeJsonAtomic(flagPath, flags)
  })
}

async function markMigrated(slug: string): Promise<void> {
  // Lock the flag file so two concurrent migrations of different slugs
  // can't clobber each other's additions to the migrated list.
  const flagPath = resolveFlagPath()
  await withLock(flagPath, async () => {
    const flags = await readFlags()
    const list = flags.v1_output_root_migrated || []
    if (!list.includes(slug)) list.push(slug)
    flags.v1_output_root_migrated = list
    await writeJsonAtomic(flagPath, flags)
  })
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface PendingProject {
  slug: string
  name: string
  current_path: string
}

/**
 * List projects that still store episodes inside the app's userData folder.
 * These are safe to offer for migration because their output_root is still
 * relative (i.e., never explicitly picked by the user).
 */
export async function getProjectsNeedingMigration(): Promise<PendingProject[]> {
  const flags = await readFlags()
  const migratedSet = new Set(flags.v1_output_root_migrated || [])

  const projects = await pm.listProjects()
  const pending: PendingProject[] = []

  for (const summary of projects) {
    if (migratedSet.has(summary.slug)) continue
    const meta = await pm.getProject(summary.slug)
    if (!meta) continue
    // Relative output_root = still living inside userData → candidate
    if (meta.output_root && path.isAbsolute(meta.output_root)) continue

    // Compute the current absolute path on disk
    const projectDir = pm.getProjectDir(summary.slug)
    if (!projectDir) continue
    const current = path.join(projectDir, meta.output_root || './episodes')

    pending.push({ slug: summary.slug, name: summary.name, current_path: current })
  }
  return pending
}

// Recursively count regular files under a directory. Used to verify that
// the copy picked up every file before we delete the original.
async function countFiles(dir: string): Promise<number> {
  let n = 0
  async function walk(d: string) {
    let entries: import('fs').Dirent[] = []
    try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) n++
    }
  }
  await walk(dir)
  return n
}

/**
 * Move a project's episodes folder from the hidden userData location to
 * the user-picked folder. Updates project.json with the new absolute path.
 *
 * Safety:
 *   - Destination path = {newRoot}/{projectName}. If the destination already
 *     exists with content, we abort rather than risk overwriting.
 *   - We copy first, verify file counts match, THEN delete the source.
 *   - On any error, the source is left untouched — re-running is safe.
 */
export async function migrateProjectTo(slug: string, newRoot: string): Promise<{ new_path: string; files_moved: number }> {
  if (!path.isAbsolute(newRoot)) throw new Error('new_root must be an absolute path')

  const meta = await pm.getProject(slug)
  if (!meta) throw new Error(`Project ${slug} not found`)

  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new Error(`Project directory missing for ${slug}`)

  const currentPath = path.isAbsolute(meta.output_root || '')
    ? meta.output_root as string
    : path.join(projectDir, meta.output_root || './episodes')

  const destPath = path.join(newRoot, meta.name)

  if (!existsSync(currentPath)) {
    // Nothing to move — just update the metadata and mark done.
    await fs.mkdir(destPath, { recursive: true })
    await updateOutputRoot(slug, destPath)
    await markMigrated(slug)
    return { new_path: destPath, files_moved: 0 }
  }

  // Guard: refuse to clobber a non-empty destination.
  if (existsSync(destPath)) {
    try {
      const existing = await fs.readdir(destPath)
      if (existing.length > 0) {
        throw new Error(`Destination "${destPath}" already exists and isn't empty. Pick a different folder.`)
      }
    } catch (e: any) {
      if (!e.message?.includes('already exists')) { /* readdir hiccup — fall through to mkdir */ }
      else throw e
    }
  }

  await fs.mkdir(newRoot, { recursive: true })

  // Copy recursively
  await fs.cp(currentPath, destPath, { recursive: true, errorOnExist: false, force: false })

  // Verify file count matches — only delete source if copy is complete.
  const srcCount = await countFiles(currentPath)
  const dstCount = await countFiles(destPath)
  if (dstCount < srcCount) {
    throw new Error(`Copy verification failed (${dstCount}/${srcCount} files). Source left untouched.`)
  }

  // Point the project at its new home and remove the old location.
  await updateOutputRoot(slug, destPath)
  try {
    await fs.rm(currentPath, { recursive: true, force: true })
  } catch (e) {
    // Non-fatal: metadata is already updated. User can remove the old folder manually.
    console.error(`[migration] failed to delete old path ${currentPath}:`, e)
  }

  await markMigrated(slug)
  return { new_path: destPath, files_moved: srcCount }
}

async function updateOutputRoot(slug: string, absolutePath: string): Promise<void> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new Error(`Project directory missing for ${slug}`)
  const metaPath = path.join(projectDir, 'project.json')
  // Read-modify-write under the same lock project-manager uses for this
  // path, so a concurrent updateProject call can't race a migration.
  await withLock(metaPath, async () => {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    meta.output_root = absolutePath
    await writeJsonAtomic(metaPath, meta)
  })
}

/** Test-only: mark a slug as migrated without moving anything. */
export async function _markMigratedForTests(slug: string): Promise<void> {
  await markMigrated(slug)
}
