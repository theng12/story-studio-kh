/**
 * Title-driven episode folder rename.
 *
 * The episode folder template ({code} - {title}) embeds the idea title.
 * When the title changes — auto post-script via the chapter-count sync, or
 * manually via the Scripts page "Sync title to N" button — the on-disk
 * folder name otherwise drifts from the JSON record. The next generator
 * call resolves to the new path, doesn't find it, and creates a fresh
 * empty folder, stranding the script chapters in the old folder.
 *
 * This module renames the folder atomically so the JSON record and disk
 * stay in sync. Unlike `episode-renumber.ts` (which changes {code}, the
 * code that propagates into every subfolder + per-asset filename), here
 * only the parent {title} segment changes — subfolders and inner files
 * are scoped by {code} and stay untouched.
 *
 * Failure modes are absorbed into a `warnings` array and the call site
 * decides whether to surface them. The title rewrite itself is purely
 * cosmetic — a folder rename failure should never fail a script job or
 * a PATCH route.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveEpisodePaths } from './utils.js'

export interface TitleSyncResult {
  /** True when the disk folder was actually renamed. */
  renamed: boolean
  /** Old episode_dir (for logging / paper trail). */
  old_dir: string | null
  /** New episode_dir. Null when both old + new resolved to the same path. */
  new_dir: string | null
  /** Non-fatal hiccups — external mirror rename, cache invalidation, etc.
   *  Caller can log these but should not treat them as failure. */
  warnings: string[]
}

/**
 * Rename an accepted episode's on-disk folder when its title changes.
 *
 * Pre-conditions: caller has ALREADY persisted the new title to the idea
 * record (ideas.json) — this function only touches the filesystem. That
 * ordering matters: if the rename throws, the record is the source of
 * truth and the next folder-creation will pick the new name correctly
 * even though the old folder is stranded. (Stranding is recoverable —
 * the user can move files manually; double-writing the record on a
 * partial failure is not.)
 *
 * No-ops cleanly when:
 *   - oldTitle === newTitle (template would resolve to the same dir)
 *   - the old folder doesn't exist on disk yet (folder gets created at
 *     the new name on the first generator run; nothing to rename)
 *   - the new folder already exists (refuses to clobber — caller logs
 *     a warning and the user resolves it manually)
 *
 * Throws only on programmer error (missing slug / code). All filesystem
 * errors land in `warnings`.
 */
export async function renameEpisodeFolderForTitleChange(
  slug: string,
  code: string,
  oldTitle: string,
  newTitle: string,
): Promise<TitleSyncResult> {
  const warnings: string[] = []

  if (!slug || !code) {
    throw new Error('renameEpisodeFolderForTitleChange: slug and code are required')
  }
  // Empty-string titles are normal during early project setup. Trim before
  // comparing so " Foo " vs "Foo" doesn't trigger a no-op rename to itself.
  const oldT = (oldTitle || '').trim()
  const newT = (newTitle || '').trim()
  if (oldT === newT) {
    return { renamed: false, old_dir: null, new_dir: null, warnings: [] }
  }

  const oldPaths = await resolveEpisodePaths(slug, code, oldTitle)
  const newPaths = await resolveEpisodePaths(slug, code, newTitle)

  // Same path → the folder template doesn't include {title} (custom
  // template), or sanitization collapsed both titles to the same string.
  // Either way nothing to do on disk.
  if (oldPaths.episode_dir === newPaths.episode_dir) {
    return { renamed: false, old_dir: oldPaths.episode_dir, new_dir: null, warnings: [] }
  }

  // Old dir doesn't exist yet — first generator run will mkdir at the new
  // name. This is the common case when the user accepts an idea, edits
  // the title, and then runs the script generator.
  if (!existsSync(oldPaths.episode_dir)) {
    return { renamed: false, old_dir: oldPaths.episode_dir, new_dir: newPaths.episode_dir, warnings: [] }
  }

  // Refuse to clobber an existing destination. Two episodes resolving to
  // the same dir is a corruption case — the user almost certainly wants
  // to investigate manually rather than have us silently merge.
  if (existsSync(newPaths.episode_dir)) {
    warnings.push(
      `Destination already exists: ${newPaths.episode_dir}. ` +
      `Folder rename skipped to avoid clobbering — resolve manually.`,
    )
    return { renamed: false, old_dir: oldPaths.episode_dir, new_dir: newPaths.episode_dir, warnings }
  }

  // Ensure the parent (Season NNN) exists; templates that introduce a new
  // season directory between titles need this to land. Atomic rename only
  // works on the same filesystem — fall back to recursive copy + rm on
  // EXDEV (rare, but possible if output_root sits on a different volume).
  try {
    await fs.mkdir(path.dirname(newPaths.episode_dir), { recursive: true })
    try {
      await fs.rename(oldPaths.episode_dir, newPaths.episode_dir)
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        await copyDirRecursive(oldPaths.episode_dir, newPaths.episode_dir)
        await fs.rm(oldPaths.episode_dir, { recursive: true, force: true })
      } else {
        throw e
      }
    }
  } catch (e: any) {
    warnings.push(`Folder rename failed: ${e?.message || String(e)}`)
    return { renamed: false, old_dir: oldPaths.episode_dir, new_dir: newPaths.episode_dir, warnings }
  }

  // External final-video mirror dir, if the user has configured one.
  // Same {title}-in-path situation, separate filesystem precedent. The
  // existing `renameExternalEpisodeDir` helper is parameterized by code
  // changes — for title-only we need a thin wrapper that resolves both
  // paths from the same code with different titles.
  try {
    const ext = await renameExternalEpisodeDirForTitle(slug, code, oldTitle, newTitle)
    if (ext.attempted && !ext.renamed && ext.detail) {
      warnings.push(`External mirror: ${ext.detail}`)
    }
  } catch (e: any) {
    warnings.push(`External mirror rename failed: ${e?.message || String(e)}`)
  }

  // Episode-status cache keyed by (slug, code) so the path change alone
  // doesn't strictly need invalidation — the cache reads the same logical
  // episode. But asset-readiness uses on-disk timestamps and the next
  // call must re-stat the new path; invalidate to be safe.
  try {
    const { episodeStatusCache } = await import('./episode-status-cache.js')
    episodeStatusCache.invalidateProject(slug)
  } catch (e: any) {
    warnings.push(`Cache invalidation failed: ${e?.message || String(e)}`)
  }

  return {
    renamed: true,
    old_dir: oldPaths.episode_dir,
    new_dir: newPaths.episode_dir,
    warnings,
  }
}

/**
 * External-mirror rename for a title-only change. Mirrors the API of
 * external-video-store.ts:renameExternalEpisodeDir but resolves both
 * source and destination from the same code with different titles
 * (since the existing helper short-circuits when oldCode === newCode).
 */
async function renameExternalEpisodeDirForTitle(
  slug: string,
  code: string,
  oldTitle: string,
  newTitle: string,
): Promise<{ attempted: boolean; renamed: boolean; from_dir: string | null; to_dir: string | null; detail: string | null }> {
  const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
  const oldDir = await resolveExternalFinalVideoDir(slug, code, oldTitle)
  const newDir = await resolveExternalFinalVideoDir(slug, code, newTitle)
  if (!oldDir || !newDir) {
    return { attempted: false, renamed: false, from_dir: oldDir, to_dir: newDir, detail: 'External final video root is not configured.' }
  }
  if (oldDir === newDir) {
    return { attempted: false, renamed: false, from_dir: oldDir, to_dir: newDir, detail: 'Old and new external dirs resolve to the same path.' }
  }
  if (!existsSync(oldDir)) {
    return { attempted: false, renamed: false, from_dir: oldDir, to_dir: newDir, detail: 'No external dir for this episode.' }
  }
  if (existsSync(newDir)) {
    return {
      attempted: true, renamed: false, from_dir: oldDir, to_dir: newDir,
      detail: `Target external dir already exists at ${newDir}. Resolve manually.`,
    }
  }

  await fs.mkdir(path.dirname(newDir), { recursive: true })
  try {
    await fs.rename(oldDir, newDir)
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      await copyDirRecursive(oldDir, newDir)
      await fs.rm(oldDir, { recursive: true, force: true })
    } else {
      throw e
    }
  }
  return { attempted: true, renamed: true, from_dir: oldDir, to_dir: newDir, detail: null }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) await copyDirRecursive(s, d)
    else if (e.isFile()) await fs.copyFile(s, d)
  }
}
