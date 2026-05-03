/**
 * Renumber rollback (item L).
 *
 * `adoptBulkRenumber` is a destructive three-stage operation:
 *   1. Disk: rename every existing episode's folder to make room for orphans
 *   2. ideas.json: bump every existing accepted idea's code forward by N
 *   3. Adopt orphans into the now-vacant leading codes
 *
 * Half-failures or "I changed my mind" leave the user staring at a
 * differently-numbered project with no path back. This module owns the
 * undo lifecycle:
 *
 *   - `writeUndoSidecar` is called by `adoptBulkRenumber` BEFORE Stage 1,
 *     dumping a plan to `<project>/.renumber-undo.json` so even a crash
 *     mid-stage leaves the user able to revert.
 *
 *   - `revertRenumber` walks the plan in reverse: deletes adopted
 *     orphan ideas + sidecars + folders, applies the inverse rename
 *     patch through `im.applyRenumberPatch`, and renames disk folders
 *     back. End state matches what existed before the renumber.
 *
 *   - `cleanupStaleUndoSidecars` runs at app boot and deletes any
 *     undo sidecar older than 30 days. Long enough to notice a
 *     problem days later, short enough that long-lived projects
 *     don't carry a stale rollback file forever.
 *
 * The sidecar lives at the project root rather than under config.json
 * so it's visible to the user (filesystem audit) and so revert can run
 * without first reading config — useful if the boot-time auto-clean
 * couldn't read config for some reason.
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { deleteSidecar } from './upload-sidecar.js'

export const UNDO_FILENAME = '.renumber-undo.json'
export const UNDO_TTL_MS = 30 * 24 * 60 * 60 * 1000   // 30 days

export interface RenumberUndoSidecar {
  schema_version: 1
  performed_at: string                         // ISO 8601
  rename_plan: Array<{ old_code: string; new_code: string }>
  adopted: Array<{ video_id: string; code: string }>
  /** Captured before applyRenumberPatch ran so revert can restore it. */
  previous_next_episode_number: number
  /** Captured for sanity checks during revert (prefix mismatch = different project). */
  episode_prefix: string
  episode_digits: number
}

function undoPath(slug: string): string | null {
  const dir = pm.getProjectDir(slug)
  return dir ? path.join(dir, UNDO_FILENAME) : null
}

export async function writeUndoSidecar(slug: string, plan: RenumberUndoSidecar): Promise<void> {
  const p = undoPath(slug)
  if (!p) throw new Error('Project directory not found')
  await writeJsonAtomic(p, plan)
}

export async function readUndoSidecar(slug: string): Promise<RenumberUndoSidecar | null> {
  const p = undoPath(slug)
  if (!p || !existsSync(p)) return null
  try {
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw)
    // Defensive — the schema is fixed but a corrupt sidecar shouldn't crash boot.
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.schema_version !== 1) return null
    if (!Array.isArray(parsed.rename_plan)) return null
    if (!Array.isArray(parsed.adopted)) return null
    return parsed as RenumberUndoSidecar
  } catch {
    return null
  }
}

export async function deleteUndoSidecar(slug: string): Promise<boolean> {
  const p = undoPath(slug)
  if (!p || !existsSync(p)) return false
  try {
    await fs.unlink(p)
    return true
  } catch {
    return false
  }
}

/**
 * Returns true when the undo sidecar exists AND is stale enough to
 * auto-delete. The 30-day TTL is measured from `performed_at`.
 */
export function isExpired(plan: RenumberUndoSidecar, now = Date.now()): boolean {
  const t = Date.parse(plan.performed_at)
  if (!Number.isFinite(t)) return false   // bad timestamp — keep, don't trash data
  return (now - t) > UNDO_TTL_MS
}

/**
 * Boot-time auto-cleanup. Walks every project's root looking for an
 * undo sidecar; deletes any older than 30 days. Cheap because the
 * filesystem scan is bounded by project count (typically <10 for
 * personal use) and most projects have no sidecar at all.
 *
 * Returns the slugs that were cleaned up so callers can log a one-line
 * summary on boot.
 */
export async function cleanupStaleUndoSidecars(): Promise<string[]> {
  const cleaned: string[] = []
  let projects: Array<{ slug: string }> = []
  try {
    projects = await pm.listProjects() as any
  } catch {
    return cleaned
  }
  for (const proj of projects) {
    try {
      const plan = await readUndoSidecar(proj.slug)
      if (!plan) continue
      if (!isExpired(plan)) continue
      await deleteUndoSidecar(proj.slug)
      cleaned.push(proj.slug)
    } catch { /* per-project failure is non-fatal — keep going */ }
  }
  return cleaned
}

// ── Revert ───────────────────────────────────────────────────────────────

export interface RevertResult {
  /** Adopted orphans whose ideas + sidecars + folders were deleted. */
  removed_adoptions: Array<{ code: string; video_id: string; idea_id: string | null }>
  /** Existing ideas whose codes were rolled back. */
  reverted_renames: Array<{ from_code: string; to_code: string }>
  /** Disk folders renamed back. */
  reverted_folders: Array<{ from_dir: string; to_dir: string }>
  errors: Array<{ stage: string; detail: string }>
}

/**
 * Walk the undo sidecar in reverse:
 *   1. Stage A — delete the adopted orphans (idea + sidecar + folder)
 *   2. Stage B — apply inverse rename patch to ideas.json + restore
 *      next_episode_number
 *   3. Stage C — rename disk folders back to their original codes
 *
 * Stages run in this order because:
 *   - Stage A first frees the orphan codes (1..N) so the inverse patch
 *     in Stage B can move existing ideas back to those codes without
 *     duplicate-code conflicts inside the auto-heal pass.
 *   - Stage C runs last because the inverse rename patch needs the
 *     ideas.json codes to be in their post-renumber state when we look
 *     up the idea IDs by current code.
 */
export async function revertRenumber(slug: string): Promise<RevertResult> {
  const result: RevertResult = {
    removed_adoptions: [],
    reverted_renames: [],
    reverted_folders: [],
    errors: [],
  }
  const plan = await readUndoSidecar(slug)
  if (!plan) {
    result.errors.push({ stage: 'load', detail: 'No renumber-undo sidecar found' })
    return result
  }
  const meta = await pm.getProject(slug)
  if (!meta) {
    result.errors.push({ stage: 'load', detail: 'Project not found' })
    return result
  }
  if (meta.episode_prefix !== plan.episode_prefix) {
    result.errors.push({
      stage: 'load',
      detail: `Project prefix changed since renumber (was ${plan.episode_prefix}, now ${meta.episode_prefix}). Refusing to revert.`,
    })
    return result
  }

  // ── Stage A: remove adopted orphans ──────────────────────────────────
  // Look up each adopted code in the current ideas list, find the idea,
  // delete the folder + sidecar, then call removeIdea so ideas.json is
  // mutated through the auto-heal mutator (which handles
  // recycled_numbers correctly).
  const ideas = await im.getIdeas(slug, 'accepted')
  for (const adopt of plan.adopted) {
    try {
      const idea = ideas.find(i => i.episode_code === adopt.code)
      if (!idea) {
        // Already removed (or never adopted due to a Stage-3 error
        // during the original renumber). Skip — we still want to
        // attempt the rest of the rollback.
        result.removed_adoptions.push({ code: adopt.code, video_id: adopt.video_id, idea_id: null })
        continue
      }
      // Resolve folder paths BEFORE deleting the idea so the resolver
      // still has a valid (code, title) pair to work from.
      const paths = await resolveEpisodePaths(slug, adopt.code, idea.title || adopt.code)

      // Delete the YouTube sidecar file (no-op when absent).
      try { await deleteSidecar(slug, adopt.code, idea.title || adopt.code, 'youtube') }
      catch { /* non-fatal */ }

      // Delete the entire episode folder. Adopted-orphan folders only
      // contain stub episode_info.json + empty subdirs we created in
      // adoptOne, so this is safe (no user content).
      if (existsSync(paths.episode_dir)) {
        try { await fs.rm(paths.episode_dir, { recursive: true, force: true }) }
        catch (e: any) {
          result.errors.push({ stage: `remove folder ${adopt.code}`, detail: e?.message || 'rm failed' })
        }
      }

      await im.removeIdea(slug, idea.id)
      result.removed_adoptions.push({ code: adopt.code, video_id: adopt.video_id, idea_id: idea.id })
    } catch (e: any) {
      result.errors.push({ stage: `remove adoption ${adopt.code}`, detail: e?.message || 'remove failed' })
    }
  }

  // ── Stage B: inverse rename patch ────────────────────────────────────
  // Each rename_plan entry maps `old_code → new_code` (the original
  // direction). To revert we look up the idea currently sitting at
  // `new_code` and rewrite it back to `old_code`. applyRenumberPatch
  // takes idea_ids, so we look those up against the current accepted
  // list (which now no longer includes the deleted orphans).
  const remaining = await im.getIdeas(slug, 'accepted')
  const inverseRenames: Array<{ idea_id: string; new_code: string }> = []
  for (const r of plan.rename_plan) {
    const idea = remaining.find(i => i.episode_code === r.new_code)
    if (!idea) {
      result.errors.push({
        stage: `revert rename ${r.new_code} → ${r.old_code}`,
        detail: `No idea currently at ${r.new_code} — manual edit since renumber? Skipping.`,
      })
      continue
    }
    inverseRenames.push({ idea_id: idea.id, new_code: r.old_code })
  }
  try {
    await im.applyRenumberPatch(slug, {
      renames: inverseRenames,
      // restore next_episode_number to its pre-renumber value
      advance_next_to: plan.previous_next_episode_number,
    })
    // applyRenumberPatch only ADVANCES next; we may need to lower it.
    // Use updateNextEpisodeNumber for that direction.
    if (plan.previous_next_episode_number > 0) {
      await im.updateNextEpisodeNumber(slug, plan.previous_next_episode_number)
    }
    for (const r of plan.rename_plan) {
      result.reverted_renames.push({ from_code: r.new_code, to_code: r.old_code })
    }
  } catch (e: any) {
    result.errors.push({ stage: 'apply inverse rename patch', detail: e?.message || 'patch failed' })
  }

  // ── Stage C: rename disk folders back ────────────────────────────────
  // Sort by NEW number ascending so we shift small → big, avoiding
  // collisions (TN0042 → TN0001 must move before TN0043 → TN0002 if
  // any code overlap exists between the source range and dest range).
  const sortedForFolders = plan.rename_plan.slice().sort((a, b) => {
    const an = parseInt(a.new_code.replace(plan.episode_prefix, ''), 10) || 0
    const bn = parseInt(b.new_code.replace(plan.episode_prefix, ''), 10) || 0
    return an - bn
  })
  // Look up titles by old_code via the remaining ideas list (post-Stage-B
  // they're back at their original codes).
  const finalIdeas = await im.getIdeas(slug, 'accepted')
  const titleByOldCode = new Map<string, string>()
  for (const i of finalIdeas) {
    if (i.episode_code) titleByOldCode.set(i.episode_code, i.title || '')
  }

  for (const r of sortedForFolders) {
    try {
      // The folder is currently at new_code (matches what's on disk).
      // Use new_code + the *original* title (which we recorded against
      // the old_code now) to compute fromPaths.
      const title = titleByOldCode.get(r.old_code) || ''
      const fromPaths = await resolveEpisodePaths(slug, r.new_code, title)
      const toPaths = await resolveEpisodePaths(slug, r.old_code, title)

      if (existsSync(fromPaths.episode_dir) && fromPaths.episode_dir !== toPaths.episode_dir) {
        await fs.mkdir(path.dirname(toPaths.episode_dir), { recursive: true })
        try {
          await fs.rename(fromPaths.episode_dir, toPaths.episode_dir)
        } catch (e: any) {
          if (e?.code === 'EXDEV') {
            await copyDirRecursive(fromPaths.episode_dir, toPaths.episode_dir)
            await fs.rm(fromPaths.episode_dir, { recursive: true, force: true })
          } else {
            throw e
          }
        }
        // Subfolder rename — same logic as forward direction in
        // upload-orphans.ts but with old/new swapped.
        await renameCodeScopedSubfolders(toPaths.episode_dir, r.new_code, r.old_code)
        result.reverted_folders.push({ from_dir: fromPaths.episode_dir, to_dir: toPaths.episode_dir })
      }
    } catch (e: any) {
      result.errors.push({ stage: `rename folder ${r.new_code} → ${r.old_code}`, detail: e?.message || 'rename failed' })
    }
  }

  // Tear down the sidecar — revert is one-shot and re-running it on a
  // reverted project would either no-op or fail confusingly.
  await deleteUndoSidecar(slug)

  return result
}

// ── Small helpers ────────────────────────────────────────────────────────
// Mirrors the helpers in upload-orphans.ts so this module can stand alone
// (avoids circular import between the orphan-adoption file and its undo).

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

async function renameCodeScopedSubfolders(episodeDir: string, oldCode: string, newCode: string): Promise<void> {
  if (!existsSync(episodeDir)) return
  const entries = await fs.readdir(episodeDir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!e.name.includes(oldCode)) continue
    const oldP = path.join(episodeDir, e.name)
    const newName = e.name.replaceAll(oldCode, newCode)
    const newP = path.join(episodeDir, newName)
    try { await fs.rename(oldP, newP) } catch { /* non-fatal */ }
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!e.name.startsWith(oldCode)) continue
    const oldP = path.join(episodeDir, e.name)
    const newName = e.name.replace(oldCode, newCode)
    const newP = path.join(episodeDir, newName)
    try { await fs.rename(oldP, newP) } catch { /* non-fatal */ }
  }
  const updatedEntries = await fs.readdir(episodeDir, { withFileTypes: true })
  for (const e of updatedEntries) {
    if (!e.isDirectory()) continue
    const inner = await fs.readdir(path.join(episodeDir, e.name))
    for (const f of inner) {
      if (!f.startsWith(oldCode)) continue
      const oldP = path.join(episodeDir, e.name, f)
      const newName = f.replace(oldCode, newCode)
      const newP = path.join(episodeDir, e.name, newName)
      try { await fs.rename(oldP, newP) } catch { /* non-fatal */ }
    }
  }
}
