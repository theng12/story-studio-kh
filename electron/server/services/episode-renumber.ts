/**
 * Single-episode renumber: change an already-accepted episode's code
 * (e.g. TN0005 → TN0099). Coordinates the cascade:
 *
 *   1. Validate target code (prefix + format + collision)
 *   2. Resolve old + new episode paths
 *   3. fs.rename the episode_dir
 *   4. renameCodeScopedSubfolders — renames `{code}` in subfolder names
 *      AND in file names inside those subfolders (per-asset files like
 *      `{code}_Chapter_01.mp3`, `{code}_Scene01_v1.png`)
 *   5. Update episode_info.json's episode_code field
 *   6. Atomic ideas.json patch via im.applyRenumberPatch (auto-heal pass)
 *   7. Invalidate the episode-status cache
 *
 * The bulk-orphan renumber path in upload-orphans.ts uses similar logic
 * but operates over many ideas atomically. This service is for the
 * per-episode "I want this one episode at a different number" flow
 * exposed via the Ideas page renumber action.
 *
 * Failures are best-effort: if any step after the ideas.json patch
 * fails, the episode is in a half-renamed state. The result includes a
 * `warnings` array so the UI can show what didn't fully complete; the
 * user can re-run rename to fix residue (operations are idempotent).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths, episodeNumber, formatEpisodeCode } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

export interface RenumberResult {
  ok: true
  old_code: string
  new_code: string
  old_dir: string
  new_dir: string
  warnings: string[]
}

/**
 * Rename a single accepted episode to a new code.
 *
 * @throws Error with HTTP-friendly message on validation failure (the
 *   route maps these to 400/409). Errors during the actual fs work
 *   are collected into `warnings` and returned — the rename has
 *   partially landed, the user can recover by re-invoking.
 */
export async function renameAcceptedEpisode(
  slug: string,
  oldCode: string,
  newCode: string,
): Promise<RenumberResult> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const oldUp = oldCode.toUpperCase()
  const newUp = newCode.toUpperCase()

  if (oldUp === newUp) throw new Error('new_code is the same as old_code')

  // 1. Validate target code shape against project prefix + digits.
  if (!newUp.startsWith(meta.episode_prefix.toUpperCase())) {
    throw new Error(`new_code must start with prefix "${meta.episode_prefix}"`)
  }
  let newNum: number
  try {
    newNum = episodeNumber(newUp, meta.episode_prefix)
  } catch (e: any) {
    throw new Error(`new_code "${newCode}" must be ${meta.episode_prefix}<positive integer>`)
  }
  // Re-format through formatEpisodeCode so leading-zero variations
  // ("TN42" vs "TN0042") canonicalise to the project's digit width.
  const canonicalNew = formatEpisodeCode(newNum, meta.episode_prefix, meta.episode_digits)

  // 2. Look up the source idea + verify the target slot is free.
  const ideas = await im.getIdeas(slug)
  const source = ideas.find(
    i => i.status === 'accepted' && (i.episode_code || '').toUpperCase() === oldUp,
  )
  if (!source) throw new Error(`No accepted episode with code ${oldCode}`)
  const target = ideas.find(
    i => i.status === 'accepted' && (i.episode_code || '').toUpperCase() === canonicalNew.toUpperCase(),
  )
  if (target && target.id !== source.id) {
    // Throw with a 409-flavoured message so the route can surface a
    // distinct "already in use" error rather than a generic 500.
    const err: any = new Error(`Episode code ${canonicalNew} is already in use`)
    err.statusCode = 409
    throw err
  }

  const warnings: string[] = []

  // 3. Resolve old + new paths. The source idea's title is part of the
  //    folder template; the new path uses the same title.
  const oldPaths = await resolveEpisodePaths(slug, source.episode_code!, source.title)
  const newPaths = await resolveEpisodePaths(slug, canonicalNew, source.title)

  // 4. Rename the episode dir on disk. If the source dir doesn't exist
  //    (someone deleted it manually), proceed anyway — just update the
  //    ideas.json so the project's logical state is consistent.
  if (existsSync(oldPaths.episode_dir) && oldPaths.episode_dir !== newPaths.episode_dir) {
    await fs.mkdir(path.dirname(newPaths.episode_dir), { recursive: true })
    if (existsSync(newPaths.episode_dir)) {
      throw new Error(`Destination path already exists: ${newPaths.episode_dir}`)
    }
    try {
      await fs.rename(oldPaths.episode_dir, newPaths.episode_dir)
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        // Cross-device fallback (rare on macOS but possible if
        // output_root is on a different volume).
        await copyDirRecursive(oldPaths.episode_dir, newPaths.episode_dir)
        await fs.rm(oldPaths.episode_dir, { recursive: true, force: true })
      } else {
        throw e
      }
    }
  } else if (!existsSync(oldPaths.episode_dir)) {
    warnings.push(`Source folder did not exist on disk (${oldPaths.episode_dir}) — rename only updated ideas.json`)
  }

  // 5. Cascade-rename subfolders + their inner files. Reuses the
  //    helper already used by the bulk orphan renumber path so the
  //    "what gets renamed" rules are consistent across both flows.
  if (existsSync(newPaths.episode_dir)) {
    try {
      await renameCodeScopedSubfoldersAndFiles(newPaths.episode_dir, source.episode_code!, canonicalNew)
    } catch (e: any) {
      warnings.push(`Per-asset rename had issues: ${e?.message || e}`)
    }
  }

  // The chunked sidecar filename is code-scoped and was renamed above, but
  // its embedded episode_id also drives future write paths. Leaving the old
  // id in JSON makes expansion recreate an old-code sidecar, which appears
  // as a second outline after renumbering.
  const scriptDir = newPaths.script_dir
  const sidecarFile = path.join(scriptDir, `${canonicalNew}_chunked-progress.json`)
  if (existsSync(sidecarFile)) {
    try {
      const sidecar = JSON.parse(await fs.readFile(sidecarFile, 'utf-8'))
      sidecar.episode_id = canonicalNew
      await writeJsonAtomic(sidecarFile, sidecar)
    } catch (e: any) {
      warnings.push(`chunked-progress episode id update failed: ${e?.message || e}`)
    }
  }

  // 6. Update episode_info.json. The file's episode_code field would
  //    otherwise stay stale; downstream code that re-reads it (manifest
  //    sync, project-inference) would see a code mismatch.
  const infoPath = path.join(newPaths.episode_dir, 'episode_info.json')
  if (existsSync(infoPath)) {
    try {
      const raw = await fs.readFile(infoPath, 'utf-8')
      const info = JSON.parse(raw)
      info.episode_code = canonicalNew
      await writeJsonAtomic(infoPath, info)
    } catch (e: any) {
      warnings.push(`episode_info.json update failed: ${e?.message || e}`)
    }
  }

  // 6b. Rewrite pinned `selected_thumbnail` filenames inside
  //     upload_metadata_overrides.json — the file moved with the
  //     episode dir already, but its CONTENT may reference the old
  //     code (pinned filenames look like `{old_code}_Thumb02_v1.png`).
  //     Step 5 renamed the actual file on disk to use the new code, so
  //     the pin needs the same string-replace to keep pointing at it.
  try {
    const { rewriteSelectedThumbnailOnRename } = await import('./upload-overrides.js')
    await rewriteSelectedThumbnailOnRename(slug, canonicalNew, source.title || '', source.episode_code!)
  } catch (e: any) {
    warnings.push(`pin rewrite failed: ${e?.message || e}`)
  }

  // 6c. Rename the external-root mirror dir + inner files (v1.0.43).
  //     Without this, `findFinalVideoPath` in the upload generator
  //     would look at the new code's external path and miss the
  //     final video that's still parked at the old code's path —
  //     uploads silently fail with "No final video file found".
  try {
    const { renameExternalEpisodeDir } = await import('./external-video-store.js')
    const ext = await renameExternalEpisodeDir(slug, source.episode_code!, canonicalNew, source.title || '')
    if (ext.attempted && !ext.renamed && ext.detail) {
      warnings.push(`external rename: ${ext.detail}`)
    }
  } catch (e: any) {
    warnings.push(`external rename failed: ${e?.message || e}`)
  }

  // 7. Atomic ideas.json patch via the helper that ALSO runs auto-heal,
  //    so the old code becomes a recyclable gap and any stale recycled
  //    entries get cleaned in the same write. advance_next_to keeps
  //    next_episode_number ahead of the freshly-claimed slot.
  const currentNext = await im.getNextEpisodeNumber(slug)
  await im.applyRenumberPatch(slug, {
    renames: [{ idea_id: source.id, new_code: canonicalNew }],
    advance_next_to: Math.max(currentNext, newNum + 1),
  })

  // 8. Episode-status cache invalidation — the next pipeline read
  //    needs to see the renamed files at their new paths.
  try {
    const { episodeStatusCache } = await import('./episode-status-cache.js')
    episodeStatusCache.invalidateProject(slug)
  } catch (e: any) {
    warnings.push(`Cache invalidation failed: ${e?.message || e}`)
  }

  return {
    ok: true,
    old_code: source.episode_code!,
    new_code: canonicalNew,
    old_dir: oldPaths.episode_dir,
    new_dir: newPaths.episode_dir,
    warnings,
  }
}

/**
 * Cascading rename of code-scoped subfolders + the per-asset files
 * inside them. Mirrors the helper in upload-orphans.ts but is hoisted
 * here so the single-episode flow doesn't have a circular dep on the
 * orphan-adopt module.
 *
 * Renames in three passes (subfolders → root files → inner files) so
 * a partial fs failure on any pass leaves the rest still attempting
 * to land. Errors are swallowed per-file (caller handles aggregation).
 */
async function renameCodeScopedSubfoldersAndFiles(
  episodeDir: string,
  oldCode: string,
  newCode: string,
): Promise<void> {
  if (!existsSync(episodeDir)) return

  // Subfolders that contain the old code in their name (e.g.
  // "{code} - 01 Script") — bulk rename to use the new code.
  const entries = await fs.readdir(episodeDir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!e.name.includes(oldCode)) continue
    const oldPath = path.join(episodeDir, e.name)
    const newName = e.name.replaceAll(oldCode, newCode)
    const newPath = path.join(episodeDir, newName)
    try { await fs.rename(oldPath, newPath) } catch { /* non-fatal: leave stale name */ }
  }
  // Files at the episode dir root (e.g. `{code}_final_video.mp4`).
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!e.name.startsWith(oldCode)) continue
    const oldPath = path.join(episodeDir, e.name)
    const newName = e.name.replace(oldCode, newCode)
    const newPath = path.join(episodeDir, newName)
    try { await fs.rename(oldPath, newPath) } catch { /* non-fatal */ }
  }
  // Recurse into subdirectories — re-list so we see the freshly-renamed
  // subfolder names. Per-asset files (`{code}_Chapter_01.mp3`,
  // `{code}_Scene01_v1.png`, etc.) get renamed here.
  const updatedEntries = await fs.readdir(episodeDir, { withFileTypes: true })
  for (const e of updatedEntries) {
    if (!e.isDirectory()) continue
    const inner = await fs.readdir(path.join(episodeDir, e.name))
    for (const f of inner) {
      if (!f.startsWith(oldCode)) continue
      const oldPath = path.join(episodeDir, e.name, f)
      const newName = f.replace(oldCode, newCode)
      const newPath = path.join(episodeDir, e.name, newName)
      try { await fs.rename(oldPath, newPath) } catch { /* non-fatal */ }
    }
  }
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
