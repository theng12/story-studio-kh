/**
 * Reseason — bulk-rebalance episode folders when the user changes
 * `season_size` on an existing project. Without this, naively editing
 * the value silently breaks every code-path that resolves an episode
 * folder by computed `season_num` (uploads, sidecars, image-status,
 * external-root mirror, etc.) — the data lives at the OLD season
 * grouping while the resolver returns the NEW path.
 *
 * Operation shape (mirrors Compact / Renumber for consistency):
 *
 *   Stage 0 — write `.reseason-undo.json` to project root.
 *   Stage 1 — fs-rename each episode folder from its current
 *             `Season NNN/` parent to the parent computed at the new
 *             season_size. Same path internally; only the parent
 *             segment changes.
 *   Stage 2 — same rename for the external_final_video_root mirror
 *             when configured (reuses the v1.0.43 cascade pattern).
 *   Stage 3 — update project.json's season_size.
 *   Stage 4 — clean up emptied old `Season NNN/` parent dirs that
 *             have no children left after the moves.
 *
 * Revert path runs the inverse: restores old season_size, moves
 * folders back to their old season parents, restores external mirror,
 * deletes the undo sidecar.
 *
 * Failure modes:
 *   - Per-folder fs.rename failures (EXDEV / ENOTEMPTY / target
 *     already occupied) get reported in the result's errors array
 *     and the operation continues for the rest. The undo sidecar is
 *     already on disk by then, so a partial state can be reverted.
 *   - External root unmounted / unset: non-fatal warning, project
 *     tree side still lands.
 *   - `new_size` equal to the current size: no-op; preview returns
 *     an empty moves list so the UI can short-circuit.
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths, episodeNumber } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import {
  resolveExternalFinalVideoDir,
  getChannelExportsBase,
} from './external-video-store.js'

export const RESEASON_UNDO_FILENAME = '.reseason-undo.json'
export const RESEASON_UNDO_TTL_MS = 30 * 24 * 60 * 60 * 1000   // 30 days

export interface ReseasonUndoSidecar {
  schema_version: 1
  performed_at: string
  previous_season_size: number
  new_season_size: number
  /**
   * One entry per episode whose computed season folder changed at the
   * new size. Internal-tree dirs only — external-root mirror moves
   * are recomputed on revert from the same code, so we don't store
   * those paths (they'd double the file size for nothing).
   */
  moves: Array<{
    code: string
    title: string
    /** Episode folder before the reseason ran (project tree). */
    old_dir: string
    /** Episode folder after the reseason (project tree). */
    new_dir: string
  }>
  /**
   * Old season-parent dirs that were rm'd because they became empty
   * after the moves. The revert path recreates them with `mkdir -p`
   * before moving folders back, so even if the user already deleted
   * the parent shell manually post-revert, the move goes through.
   */
  cleaned_up_parents: string[]
}

export interface ReseasonMove {
  code: string
  title: string
  old_dir: string
  new_dir: string
  /** Convenience — the season number transition for UI display. */
  old_season: number
  new_season: number
}

export interface ReseasonPreview {
  current_season_size: number
  new_season_size: number
  /** Moves the operation will perform. Empty when new == current. */
  moves: ReseasonMove[]
  /** Episodes already at the correct parent for the new size. */
  noop_count: number
  /** Total accepted episodes — `moves.length + noop_count`. */
  total_accepted: number
}

export interface ReseasonResult extends ReseasonPreview {
  /** Project-tree moves that landed. */
  moved: Array<{ code: string; from: string; to: string }>
  /** External-root moves that landed (when configured). */
  moved_external: Array<{ code: string; from: string; to: string }>
  /** Per-stage failures. Operation continues; user can revert. */
  errors: Array<{ stage: string; detail: string }>
  /** Old season-parent dirs cleaned up (for the audit trail). */
  cleaned_up_parents: string[]
}

function undoPath(slug: string): string | null {
  const dir = pm.getProjectDir(slug)
  return dir ? path.join(dir, RESEASON_UNDO_FILENAME) : null
}

export async function readReseasonUndo(slug: string): Promise<ReseasonUndoSidecar | null> {
  const p = undoPath(slug)
  if (!p || !existsSync(p)) return null
  try {
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.schema_version !== 1) return null
    if (!Array.isArray(parsed.moves)) return null
    return parsed as ReseasonUndoSidecar
  } catch {
    return null
  }
}

export async function deleteReseasonUndo(slug: string): Promise<boolean> {
  const p = undoPath(slug)
  if (!p || !existsSync(p)) return false
  try { await fs.unlink(p); return true } catch { return false }
}

export function isReseasonUndoExpired(plan: ReseasonUndoSidecar, now = Date.now()): boolean {
  const t = Date.parse(plan.performed_at)
  if (!Number.isFinite(t)) return false
  return (now - t) > RESEASON_UNDO_TTL_MS
}

/**
 * Boot-time auto-cleanup. Same shape as `cleanupStaleUndoSidecars`
 * for the renumber-undo flow — 30 days post-perform, reseason undo
 * sidecars are swept on app startup.
 */
export async function cleanupStaleReseasonUndoSidecars(): Promise<string[]> {
  const cleaned: string[] = []
  let projects: Array<{ slug: string }> = []
  try { projects = (await pm.listProjects()) as any } catch { return cleaned }
  for (const p of projects) {
    try {
      const plan = await readReseasonUndo(p.slug)
      if (!plan) continue
      if (!isReseasonUndoExpired(plan)) continue
      await deleteReseasonUndo(p.slug)
      cleaned.push(p.slug)
    } catch { /* per-project failure is non-fatal */ }
  }
  return cleaned
}

// ── Compute ──────────────────────────────────────────────────────────────

function computeSeasonNum(epNum: number, seasonSize: number): number {
  return Math.floor((epNum - 1) / seasonSize) + 1
}

/**
 * Dry-run for the Settings UI's preview modal. Walks accepted ideas,
 * compares each episode's CURRENT season_num (computed from the
 * project's existing season_size) against the NEW one, and lists
 * every move that would happen. No fs / state writes.
 */
export async function previewReseason(slug: string, newSeasonSize: number): Promise<ReseasonPreview> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')
  if (!Number.isInteger(newSeasonSize) || newSeasonSize < 1 || newSeasonSize > 1000) {
    throw new Error(`new_season_size must be a positive integer ≤ 1000 (got ${newSeasonSize})`)
  }

  const currentSize = (meta as any).season_size || 20
  const ideas = await im.getIdeas(slug, 'accepted')
  const moves: ReseasonMove[] = []
  let noop_count = 0

  for (const idea of ideas) {
    if (!idea.episode_code) continue
    const epNum = episodeNumber(idea.episode_code, meta.episode_prefix)
    const oldSeason = computeSeasonNum(epNum, currentSize)
    const newSeason = computeSeasonNum(epNum, newSeasonSize)
    if (oldSeason === newSeason) {
      noop_count++
      continue
    }
    // Resolve OLD path using current meta (current size). Resolve NEW
    // path by temporarily computing — resolveEpisodePaths reads
    // project meta, which still has the old size. So we mirror its
    // template-replace logic here for the new path.
    const oldPaths = await resolveEpisodePaths(slug, idea.episode_code, idea.title || '')
    const newDir = await resolveEpisodeDirAtSize(meta, idea.episode_code, idea.title || '', newSeasonSize)
    moves.push({
      code: idea.episode_code,
      title: idea.title || idea.episode_code,
      old_dir: oldPaths.episode_dir,
      new_dir: newDir,
      old_season: oldSeason,
      new_season: newSeason,
    })
  }

  return {
    current_season_size: currentSize,
    new_season_size: newSeasonSize,
    moves,
    noop_count,
    total_accepted: ideas.filter(i => !!i.episode_code).length,
  }
}

/**
 * Compute the episode dir as if the project had the given season_size,
 * without mutating project meta. Mirrors resolveEpisodePaths' folder
 * template logic but with an injected size — used by both the preview
 * (no writes happened yet) and the apply (during the transition the
 * project meta still has the OLD size at the moment we compute the
 * NEW dir for each move).
 */
async function resolveEpisodeDirAtSize(
  meta: any,
  code: string,
  title: string,
  seasonSize: number,
): Promise<string> {
  const root = await pm.getProjectOutputRoot(meta.slug)
  if (!root) throw new Error('Project output root not configured')
  const seasonPrefix = meta.season_prefix || 'Season'
  const folderTemplate = meta.folder_template || '{season_prefix} {season_num}/{code} - {title}/'
  const epNum = parseInt(code.replace(meta.episode_prefix, ''), 10) || 1
  const seasonNum = Math.floor((epNum - 1) / seasonSize) + 1
  const rel = folderTemplate
    .replace('{season_prefix}', seasonPrefix)
    .replace('{season_num}', seasonNum.toString().padStart(3, '0'))
    .replace('{code}', code)
    .replace('{title}', title || code)
    // Trim trailing slash if the template included one — path.join
    // collapses them but it's clearer in the resulting absolute path
    // when the components are normalised here.
    .replace(/\/+$/, '')
  return path.join(root, rel)
}

// ── Apply ────────────────────────────────────────────────────────────────

export async function applyReseason(slug: string, newSeasonSize: number): Promise<ReseasonResult> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const preview = await previewReseason(slug, newSeasonSize)
  const moved: ReseasonResult['moved'] = []
  const moved_external: ReseasonResult['moved_external'] = []
  const errors: ReseasonResult['errors'] = []
  const cleaned_up_parents: string[] = []

  if (preview.moves.length === 0) {
    // No-op: still update the project meta so a future preview at the
    // same size returns 0 noop without re-walking. But don't write a
    // misleading undo sidecar.
    if (preview.current_season_size !== preview.new_season_size) {
      await pm.updateProject(slug, { season_size: newSeasonSize } as any)
    }
    return { ...preview, moved, moved_external, errors, cleaned_up_parents }
  }

  // Stage 0: write undo sidecar BEFORE any disk moves so a Stage-1
  // failure is recoverable. The sidecar is the safety net the
  // Revert banner reads to offer rollback for 30 days.
  const undoPlan: ReseasonUndoSidecar = {
    schema_version: 1,
    performed_at: new Date().toISOString(),
    previous_season_size: preview.current_season_size,
    new_season_size: newSeasonSize,
    moves: preview.moves.map(m => ({
      code: m.code,
      title: m.title,
      old_dir: m.old_dir,
      new_dir: m.new_dir,
    })),
    cleaned_up_parents: [],
  }
  const p = undoPath(slug)
  if (!p) {
    errors.push({ stage: 'write undo sidecar', detail: 'Project directory not found' })
    return { ...preview, moved, moved_external, errors, cleaned_up_parents }
  }
  try {
    await writeJsonAtomic(p, undoPlan)
  } catch (e: any) {
    errors.push({ stage: 'write undo sidecar', detail: e?.message || 'undo write failed' })
    // Hard-fail: without the sidecar the user has no rollback path,
    // and we promise one in the Settings preview modal.
    return { ...preview, moved, moved_external, errors, cleaned_up_parents }
  }

  // Stage 1: fs-move project-tree folders. Order doesn't matter much
  // (each move is a different parent → different parent), but we do
  // walk in sorted order for predictable error logs.
  const sorted = preview.moves.slice().sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  )
  for (const m of sorted) {
    try {
      if (!existsSync(m.old_dir)) {
        // No folder on disk yet (episode was created but never had
        // its assets generated). Nothing to move; safe to skip.
        continue
      }
      if (m.old_dir === m.new_dir) continue
      await fs.mkdir(path.dirname(m.new_dir), { recursive: true })
      try {
        await fs.rename(m.old_dir, m.new_dir)
      } catch (e: any) {
        if (e?.code === 'EXDEV') {
          // Cross-filesystem fallback (rare for project tree, but the
          // Library itself might sit on a USB / NAS).
          await copyDirRecursive(m.old_dir, m.new_dir)
          await fs.rm(m.old_dir, { recursive: true, force: true })
        } else if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || e?.code === 'EISDIR') {
          errors.push({
            stage: `move ${m.code}`,
            detail: `Target dir ${m.new_dir} already exists. Move or delete it manually, then revert + retry.`,
          })
          continue
        } else {
          throw e
        }
      }
      moved.push({ code: m.code, from: m.old_dir, to: m.new_dir })
    } catch (e: any) {
      errors.push({ stage: `move ${m.code}`, detail: e?.message || 'move failed' })
    }
  }

  // Stage 2: external root mirror. Same per-episode move pattern but
  // on the external_final_video_root subtree. Only fires when the
  // user has the external root configured AND the per-episode
  // external dir exists.
  const externalRoot = await getChannelExportsBase(slug)
  if (externalRoot) {
    for (const m of sorted) {
      try {
        const oldExt = await resolveExternalFinalVideoDir(slug, m.code, m.title)
        // For the new path we need to compute as if season_size were
        // already the new value. Mirror the math here since the
        // external resolver also reads project meta (still has old size).
        const newExt = computeExternalDirAtSize(externalRoot, meta as any, m.code, m.title, newSeasonSize)
        if (!oldExt || !newExt || oldExt === newExt) continue
        if (!existsSync(oldExt)) continue
        await fs.mkdir(path.dirname(newExt), { recursive: true })
        try {
          await fs.rename(oldExt, newExt)
        } catch (e: any) {
          if (e?.code === 'EXDEV') {
            await copyDirRecursive(oldExt, newExt)
            await fs.rm(oldExt, { recursive: true, force: true })
          } else if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || e?.code === 'EISDIR') {
            errors.push({
              stage: `external move ${m.code}`,
              detail: `External target dir ${newExt} already exists. Move or delete it manually.`,
            })
            continue
          } else {
            throw e
          }
        }
        moved_external.push({ code: m.code, from: oldExt, to: newExt })
      } catch (e: any) {
        errors.push({ stage: `external move ${m.code}`, detail: e?.message || 'external move failed' })
      }
    }
  }

  // Stage 3: commit the new season_size to project.json. After this
  // point, every resolveEpisodePaths call returns the new-size paths.
  try {
    await pm.updateProject(slug, { season_size: newSeasonSize } as any)
  } catch (e: any) {
    errors.push({ stage: 'update project meta', detail: e?.message || 'project update failed' })
  }

  // Stage 4: clean up emptied old `Season NNN/` parent dirs. We only
  // delete dirs that are actually empty (defensive — a user might
  // have dropped non-episode files in there). Records the deletes in
  // the undo sidecar so revert can mkdir them back before moving
  // folders.
  const oldParents = new Set(sorted.map(m => path.dirname(m.old_dir)))
  for (const parent of oldParents) {
    try {
      if (!existsSync(parent)) continue
      const remaining = await fs.readdir(parent)
      if (remaining.length === 0) {
        await fs.rmdir(parent)
        cleaned_up_parents.push(parent)
      }
    } catch { /* non-fatal — just leave the empty dir */ }
  }

  // Persist cleaned_up_parents into the undo sidecar so revert
  // restores them if needed.
  if (cleaned_up_parents.length > 0) {
    try {
      undoPlan.cleaned_up_parents = cleaned_up_parents
      await writeJsonAtomic(p, undoPlan)
    } catch { /* non-fatal — revert can still run, it'll just mkdir blindly */ }
  }

  return { ...preview, moved, moved_external, errors, cleaned_up_parents }
}

function computeExternalDirAtSize(
  /** This channel's finals folder (`getChannelExportsBase`). */
  channelBase: string,
  meta: any,
  code: string,
  title: string,
  seasonSize: number,
): string {
  const seasonPrefix = meta.season_prefix || 'Season'
  const folderTemplate = meta.folder_template || '{season_prefix} {season_num}/{code} - {title}/'
  const epNum = parseInt(code.replace(meta.episode_prefix, ''), 10) || 1
  const seasonNum = Math.floor((epNum - 1) / seasonSize) + 1
  const rel = folderTemplate
    .replace('{season_prefix}', seasonPrefix)
    .replace('{season_num}', seasonNum.toString().padStart(3, '0'))
    .replace('{code}', code)
    .replace('{title}', title || code)
    .replace(/\/+$/, '')
  return path.join(channelBase, rel)
}

// ── Revert ───────────────────────────────────────────────────────────────

export interface ReseasonRevertResult {
  reverted: Array<{ code: string; from: string; to: string }>
  reverted_external: Array<{ code: string; from: string; to: string }>
  restored_parents: string[]
  errors: Array<{ stage: string; detail: string }>
}

/**
 * Run the inverse of applyReseason. Reads the undo sidecar, restores
 * the old season_size FIRST so resolver semantics match the move
 * targets, then moves folders back to their old parents (recreating
 * any cleaned-up parent dirs along the way), and finally deletes
 * the undo sidecar.
 */
export async function revertReseason(slug: string): Promise<ReseasonRevertResult> {
  const result: ReseasonRevertResult = {
    reverted: [], reverted_external: [], restored_parents: [], errors: [],
  }
  const plan = await readReseasonUndo(slug)
  if (!plan) {
    result.errors.push({ stage: 'load', detail: 'No reseason-undo sidecar found' })
    return result
  }
  const meta = await pm.getProject(slug)
  if (!meta) {
    result.errors.push({ stage: 'load', detail: 'Project not found' })
    return result
  }

  // Restore project.json's season_size BEFORE moving folders. After
  // this, resolveEpisodePaths returns the OLD-size paths, which the
  // saved old_dir entries already match.
  try {
    await pm.updateProject(slug, { season_size: plan.previous_season_size } as any)
  } catch (e: any) {
    result.errors.push({ stage: 'restore season_size', detail: e?.message || 'project update failed' })
  }

  // Recreate cleaned-up parent dirs first so the moves below don't
  // fail with ENOENT on the destination's parent.
  for (const parent of plan.cleaned_up_parents || []) {
    try {
      await fs.mkdir(parent, { recursive: true })
      result.restored_parents.push(parent)
    } catch (e: any) {
      result.errors.push({ stage: `restore parent ${parent}`, detail: e?.message || 'mkdir failed' })
    }
  }

  // Move project-tree folders back. Each saved entry has the
  // original (old_dir) and post-reseason (new_dir) paths — direction
  // reverses to new_dir → old_dir.
  for (const m of plan.moves) {
    try {
      if (!existsSync(m.new_dir)) continue
      if (m.new_dir === m.old_dir) continue
      await fs.mkdir(path.dirname(m.old_dir), { recursive: true })
      try {
        await fs.rename(m.new_dir, m.old_dir)
      } catch (e: any) {
        if (e?.code === 'EXDEV') {
          await copyDirRecursive(m.new_dir, m.old_dir)
          await fs.rm(m.new_dir, { recursive: true, force: true })
        } else if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || e?.code === 'EISDIR') {
          result.errors.push({
            stage: `revert ${m.code}`,
            detail: `Target dir ${m.old_dir} already exists. Resolve manually then re-run revert.`,
          })
          continue
        } else { throw e }
      }
      result.reverted.push({ code: m.code, from: m.new_dir, to: m.old_dir })
    } catch (e: any) {
      result.errors.push({ stage: `revert ${m.code}`, detail: e?.message || 'revert failed' })
    }
  }

  // External-root reverse. Recompute paths since we don't store them.
  const externalRoot = await getChannelExportsBase(slug)
  if (externalRoot) {
    for (const m of plan.moves) {
      try {
        // After Stage-0 of revert above, project meta has OLD size again.
        // resolveExternalFinalVideoDir uses CURRENT meta, which is now old
        // size — so the natural call gives us the OLD external path.
        const oldExt = await resolveExternalFinalVideoDir(slug, m.code, m.title)
        // For the post-reseason path, recompute with the new size.
        const newExt = computeExternalDirAtSize(externalRoot, meta as any, m.code, m.title, plan.new_season_size)
        if (!oldExt || !newExt || oldExt === newExt) continue
        if (!existsSync(newExt)) continue
        await fs.mkdir(path.dirname(oldExt), { recursive: true })
        try {
          await fs.rename(newExt, oldExt)
        } catch (e: any) {
          if (e?.code === 'EXDEV') {
            await copyDirRecursive(newExt, oldExt)
            await fs.rm(newExt, { recursive: true, force: true })
          } else { throw e }
        }
        result.reverted_external.push({ code: m.code, from: newExt, to: oldExt })
      } catch (e: any) {
        result.errors.push({ stage: `external revert ${m.code}`, detail: e?.message || 'external revert failed' })
      }
    }
  }

  // Tear down the sidecar — revert is one-shot.
  await deleteReseasonUndo(slug)

  return result
}

// ── Helpers ──────────────────────────────────────────────────────────────

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
