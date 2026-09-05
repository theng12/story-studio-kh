/**
 * Orphan-video adoption (#7).
 *
 * An "orphan" is a video that lives on the connected YouTube channel but
 * isn't linked to any local episode (no sidecar, no accepted idea whose
 * episode_code appears in the remote title). For creators who've been
 * uploading to YouTube long before Story Studio existed, there can be
 * 100+ orphans on day one.
 *
 * Three adoption modes:
 *   1. `single`       — user types an episode_code for ONE remote video
 *                       (used from the Reconcile review table). Creates an
 *                       accepted idea + sidecar.
 *   2. `continuation` — bulk: assign each orphan the next available code
 *                       after the current max (`next_episode_number` in
 *                       ideas.json). Existing locals keep their codes.
 *   3. `renumber`     — bulk: orphans take the LEADING codes (TN0001 +),
 *                       existing accepted ideas are bumped forward by
 *                       orphan count. Includes disk-folder rename.
 *
 * The renumber path is destructive-ish — every accepted episode's folder
 * on disk gets renamed. We use `fs.rename` which is atomic on same
 * filesystem; on EXDEV we fall back to recursive copy + rm (same pattern
 * as upload-queue's `scanEpisodeImports`).
 *
 * Cross-reference: `electron/server/services/idea-manager.ts` owns the
 * `ideas.json` file. This service reads + mutates it directly (bypassing
 * `acceptIdea`'s code-assignment logic) because we need to force specific
 * codes rather than the next-available auto-incrementer.
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { projectsRoot } from './project-manager.js'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths, formatEpisodeCode, episodeNumber } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { listRecentUploads } from '../lib/youtube-client.js'
import { writeSidecar, readSidecar } from './upload-sidecar.js'
import { describeYouTubeCredential } from './youtube-credential.js'
import { writeUndoSidecar, type RenumberUndoSidecar } from './upload-renumber-undo.js'

export interface OrphanVideo {
  videoId: string
  title: string
  publishedAt: string
  privacyStatus?: string
}

export interface OrphanListResult {
  account_id: string
  orphans: OrphanVideo[]
  already_linked: string[]   // episode_codes that have sidecars
  next_episode_number: number
  remote_total: number
}

/**
 * Fetch channel uploads and partition into (linked, orphans).
 * A remote video is "linked" if its ID appears in any local sidecar.
 * Also returns the project's next_episode_number so the UI can show
 * what continuation codes would be assigned.
 */
export async function listOrphans(slug: string, accountId: string): Promise<OrphanListResult> {
  const [remote, ideas] = await Promise.all([
    listRecentUploads(slug, accountId, { maxPages: 8 }),
    im.getIdeas(slug, 'accepted'),
  ])

  // Index of sidecar video_ids for every accepted idea.
  const linkedVideoIds = new Set<string>()
  const linkedCodes: string[] = []
  for (const idea of ideas) {
    if (!idea.episode_code) continue
    const sc = await readSidecar(slug, idea.episode_code, idea.title || '', 'youtube')
    if (sc?.video_id) {
      linkedVideoIds.add(sc.video_id)
      linkedCodes.push(idea.episode_code)
    }
  }

  const orphans = remote.filter(v => !linkedVideoIds.has(v.videoId))
  const next = await im.getNextEpisodeNumber(slug)

  // Sort orphans by publishedAt ascending so "continuation" and "renumber"
  // both assign codes in chronological order — oldest → lowest number.
  orphans.sort((a, b) => (a.publishedAt || '').localeCompare(b.publishedAt || ''))

  return {
    account_id: accountId,
    orphans,
    already_linked: linkedCodes,
    next_episode_number: next,
    remote_total: remote.length,
  }
}

// ── Adoption primitives ───────────────────────────────────────────────────

interface AdoptedOne {
  episode_code: string
  idea_id: string
  video_id: string
}

/**
 * Write a StoredIdea with a SPECIFIC episode_code, create its folder tree,
 * and write the YouTube sidecar linking it to the remote video. Does NOT
 * touch `next_episode_number` — callers handle that based on the adoption
 * mode (continuation advances it; renumber recalculates it).
 */
async function adoptOne(
  slug: string,
  accountId: string,
  channelId: string,
  video: OrphanVideo,
  episode_code: string,
): Promise<AdoptedOne> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  // Add the idea record (status='new'), then promote to accepted with the
  // caller's specific episode_code. Both go through mutateStore so the
  // file lock + auto-heal invariants are preserved on every write —
  // critical because auto-heal is the mechanism that keeps
  // `recycled_numbers` honest (it removes any number that's now in
  // use). Bypassing mutateStore here was the source of the TN0001
  // reuse bug: orphans got adopted via direct file write, so
  // recycled_numbers stayed populated with the slots they'd just
  // filled, and the next acceptIdea handed those codes back out.
  const [created] = await im.addIdeas(slug, [{
    title: video.title || episode_code,
    logline: '(adopted from YouTube)',
    themes: [],
    suggested_chapters: 0,
    suggested_length: '0 min',
    mood: '',
  }], 'orphan-adopt')

  await im.promoteToAccepted(slug, created.id, { episode_code })

  // Create folder tree. Resolve paths AFTER the code is set.
  const paths = await resolveEpisodePaths(slug, episode_code, video.title || '')
  for (const dir of [
    paths.script_dir, paths.scene_prompts_dir, paths.thumb_prompts_dir,
    paths.metadata_dir, paths.bg_dir, paths.thumb_dir,
    paths.audio_dir, paths.video_dir,
  ]) {
    await fs.mkdir(dir, { recursive: true })
  }
  // Episode_info.json so future tools can identify this as an adopted
  // episode rather than a generated one.
  const info = {
    episode_code,
    title: video.title || episode_code,
    logline: '(adopted from YouTube)',
    themes: [],
    suggested_chapters: 0,
    suggested_length: '0 min',
    mood: '',
    model_used: 'orphan-adopt',
    accepted_at: new Date().toISOString(),
    created_from_idea: created.id,
    project: meta.name,
    adopted_from_video_id: video.videoId,
  }
  await writeJsonAtomic(path.join(paths.episode_dir, 'episode_info.json'), info)

  // Sidecar: mark as already-uploaded, with the remote video_id. Privacy
  // defaults to 'public' (orphans are live by definition; the user can
  // change it later via the queue row's Unschedule menu).
  await writeSidecar(slug, episode_code, video.title || '', {
    platform: 'youtube',
    video_id: video.videoId,
    account_id: accountId,
    channel_id: channelId,
    uploaded_at: video.publishedAt || new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    scheduled_for: null,
    privacy_status: (video.privacyStatus as any) || 'public',
    title: video.title || episode_code,
    description: '',
    tags: [],
    thumbnail_set: false,   // we don't know what YT has; Reconcile-style workflow
  })

  return { episode_code, idea_id: created.id, video_id: video.videoId }
}

// ── Mode 1: adopt a single orphan with a user-supplied code ──────────────

export async function adoptSingle(
  slug: string,
  accountId: string,
  video: OrphanVideo,
  episode_code: string,
): Promise<AdoptedOne> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  // Validate the code shape + uniqueness.
  if (!episode_code.startsWith(meta.episode_prefix)) {
    throw new Error(`Episode code must start with "${meta.episode_prefix}"`)
  }
  try { episodeNumber(episode_code, meta.episode_prefix) } catch {
    throw new Error(`Invalid episode code format (expected ${meta.episode_prefix}NNNN)`)
  }
  const ideas = await im.getIdeas(slug, 'accepted')
  if (ideas.some(i => i.episode_code === episode_code)) {
    throw new Error(`Episode code ${episode_code} is already in use`)
  }

  const account = await describeYouTubeCredential(slug, accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  // adoptOne now goes through im.promoteToAccepted which itself bumps
  // next_episode_number when the supplied code is >= current max. The
  // explicit bump below was a duplicate of that logic from the
  // direct-write era — removed so we don't race with auto-heal.
  return await adoptOne(slug, accountId, account.remote_id, video, episode_code)
}

// ── Mode 2: bulk adopt with CONTINUATION codes ───────────────────────────
//
// Orphans get the next available codes (next_episode_number, +1, +2, ...).
// Existing locals keep their codes. Simple, non-destructive.

export async function adoptBulkContinuation(
  slug: string,
  accountId: string,
  videos: OrphanVideo[],
): Promise<{ adopted: AdoptedOne[]; errors: Array<{ video_id: string; error: string }> }> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')
  const account = await describeYouTubeCredential(slug, accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  const adopted: AdoptedOne[] = []
  const errors: Array<{ video_id: string; error: string }> = []

  // Re-read next_episode_number from im.* (which goes through mutateStore +
  // auto-heal) before each adopt, so we always pick the right next code
  // even after promoteToAccepted bumped it for the prior orphan.
  for (const video of videos) {
    const num = await im.getNextEpisodeNumber(slug)
    const code = formatEpisodeCode(num, meta.episode_prefix, meta.episode_digits)
    try {
      const r = await adoptOne(slug, accountId, account.remote_id, video, code)
      adopted.push(r)
      // No explicit bump — promoteToAccepted handled it inside mutateStore.
    } catch (e: any) {
      errors.push({ video_id: video.videoId, error: e?.message || 'adopt failed' })
    }
  }
  return { adopted, errors }
}

// ── Mode 3: bulk adopt with RENUMBER (orphans take leading codes) ────────
//
// Destructive operation. Sequence:
//   1. Bump every existing accepted idea's code forward by `N` (number of
//      orphans). Rename their disk folders to match.
//   2. Insert orphans at the original leading codes (TN0001...TNxxxx).
//   3. Recompute next_episode_number so subsequent ideas continue after
//      the last existing one.
//
// Folder rename uses fs.rename; on EXDEV we copy+remove. A failure
// mid-sequence leaves the system half-renumbered — we return a detailed
// report so the user can inspect before re-running. Partial recovery is
// outside the scope of v1.

export async function adoptBulkRenumber(
  slug: string,
  accountId: string,
  videos: OrphanVideo[],
): Promise<{
  renamed: Array<{ old_code: string; new_code: string; old_dir: string; new_dir: string }>
  adopted: AdoptedOne[]
  errors: Array<{ stage: string; detail: string }>
}> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')
  const account = await describeYouTubeCredential(slug, accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  const renamed: Array<{ old_code: string; new_code: string; old_dir: string; new_dir: string }> = []
  const adopted: AdoptedOne[] = []
  const errors: Array<{ stage: string; detail: string }> = []

  if (videos.length === 0) {
    return { renamed, adopted, errors }
  }

  const N = videos.length
  // Pull current accepted ideas through the official im.* API so we get
  // a consistent snapshot under the autoheal regime (rather than reading
  // raw ideas.json which would miss any pending heals).
  const allIdeas = await im.getIdeas(slug)
  const accepted = allIdeas.filter(i => i.status === 'accepted' && i.episode_code).slice()
  const currentNext = await im.getNextEpisodeNumber(slug)

  // Sort descending by current episode number so when we rename, the
  // highest numbers move first — prevents collision where shifting
  // TN0001 → TN0051 would conflict with existing TN0051 before it's moved.
  accepted.sort((a: any, b: any) => {
    const an = episodeNumber(a.episode_code!, meta.episode_prefix)
    const bn = episodeNumber(b.episode_code!, meta.episode_prefix)
    return bn - an
  })

  // Stage 0 (item L): dump the rollback plan to .renumber-undo.json BEFORE
  // any disk renames or ideas.json mutations land. Even a crash between
  // here and Stage 3 leaves the user with a recoverable state — the
  // sidecar names every rename + every adopted code, so the revert flow
  // can chase it back to the pre-renumber world.
  //
  // We compute the planned renames + adoptions up-front (no fs work yet)
  // so the sidecar is honest about the *intended* operation. Errors that
  // surface during Stages 1-3 are reported in the response; revert can
  // tolerate partial state because each stage is independently reversible.
  const plannedRenames: Array<{ old_code: string; new_code: string }> = []
  for (const idea of accepted) {
    const oldCode = idea.episode_code!
    const oldNum = episodeNumber(oldCode, meta.episode_prefix)
    const newNum = oldNum + N
    const newCode = formatEpisodeCode(newNum, meta.episode_prefix, meta.episode_digits)
    plannedRenames.push({ old_code: oldCode, new_code: newCode })
  }
  const plannedAdopted: Array<{ video_id: string; code: string }> = videos.map((v, i) => ({
    video_id: v.videoId,
    code: formatEpisodeCode(i + 1, meta.episode_prefix, meta.episode_digits),
  }))
  const undoPlan: RenumberUndoSidecar = {
    schema_version: 1,
    performed_at: new Date().toISOString(),
    rename_plan: plannedRenames,
    adopted: plannedAdopted,
    previous_next_episode_number: currentNext,
    episode_prefix: meta.episode_prefix,
    episode_digits: meta.episode_digits,
  }
  try {
    await writeUndoSidecar(slug, undoPlan)
  } catch (e: any) {
    errors.push({ stage: 'write undo sidecar', detail: e?.message || 'undo write failed' })
    // Hard-fail: without the sidecar the user has no rollback path,
    // and the locked acceptance for item L promises one. Better to
    // refuse the renumber than silently strip the safety net.
    return { renamed, adopted, errors }
  }

  // Stage 1 (fs only): rename folder + subfolders for each existing
  // episode. We do NOT touch ideas.json here — the rename plan is
  // committed atomically in Stage 2 via im.applyRenumberPatch so a
  // partial fs failure doesn't desync state.
  const renamePlan: Array<{ idea_id: string; new_code: string }> = []
  for (const idea of accepted) {
    const oldCode = idea.episode_code!
    const oldNum = episodeNumber(oldCode, meta.episode_prefix)
    const newNum = oldNum + N
    const newCode = formatEpisodeCode(newNum, meta.episode_prefix, meta.episode_digits)
    try {
      const oldPaths = await resolveEpisodePaths(slug, oldCode, idea.title)
      // Compute new paths using a temporary copy of the idea with the
      // new code applied (we don't want to mutate the in-memory idea
      // until Stage 2 commits — keeps fs / state aligned on partial
      // failure).
      const newPaths = await resolveEpisodePaths(slug, newCode, idea.title)

      // Rename the episode folder on disk if it exists.
      if (existsSync(oldPaths.episode_dir) && oldPaths.episode_dir !== newPaths.episode_dir) {
        await fs.mkdir(path.dirname(newPaths.episode_dir), { recursive: true })
        try {
          await fs.rename(oldPaths.episode_dir, newPaths.episode_dir)
        } catch (e: any) {
          if (e?.code === 'EXDEV') {
            // Fallback: recursive copy + remove.
            await copyDirRecursive(oldPaths.episode_dir, newPaths.episode_dir)
            await fs.rm(oldPaths.episode_dir, { recursive: true, force: true })
          } else {
            throw e
          }
        }
      }

      // Per-subfolder rename — the subfolder names include {code}, so
      // `{code} - 01 Script` becomes `{newcode} - 01 Script`.
      await renameCodeScopedSubfolders(newPaths.episode_dir, oldCode, newCode)
      // v1.0.41: rewrite any pinned `selected_thumbnail` filenames in
      // upload_metadata_overrides.json — pinned filenames carry the
      // old code prefix and only a content rewrite keeps the pin
      // pointing at the now-renamed file on disk.
      try {
        const { rewriteSelectedThumbnailOnRename } = await import('./upload-overrides.js')
        await rewriteSelectedThumbnailOnRename(slug, newCode, idea.title || '', oldCode)
      } catch (e: any) {
        errors.push({ stage: `rewrite pin ${oldCode} → ${newCode}`, detail: e?.message || 'pin rewrite failed' })
      }
      // v1.0.43: rename the external-root mirror so the per-episode
      // upload lookup at `external_final_video_root/{slug}/Season NNN/
      // {newCode} - {title}/` still finds the final video.
      try {
        const { renameExternalEpisodeDir } = await import('./external-video-store.js')
        const ext = await renameExternalEpisodeDir(slug, oldCode, newCode, idea.title || '')
        if (ext.attempted && !ext.renamed && ext.detail) {
          errors.push({ stage: `external rename ${oldCode} → ${newCode}`, detail: ext.detail })
        }
      } catch (e: any) {
        errors.push({ stage: `external rename ${oldCode} → ${newCode}`, detail: e?.message || 'external rename failed' })
      }

      renamed.push({
        old_code: oldCode, new_code: newCode,
        old_dir: oldPaths.episode_dir, new_dir: newPaths.episode_dir,
      })
      renamePlan.push({ idea_id: idea.id, new_code: newCode })
    } catch (e: any) {
      errors.push({ stage: `rename ${oldCode} → ${newCode}`, detail: e?.message || 'rename failed' })
    }
  }

  // Stage 2: commit the rename plan atomically through mutateStore.
  // applyRenumberPatch runs auto-heal on commit, which removes any
  // stale recycled_numbers entries that referenced slots about to be
  // filled by the orphan adoption — closing the duplicate-code race
  // that surfaced as "new ideas overwrite TN0001".
  //
  // next_episode_number target: after shift, existing ideas occupy
  // codes N+1..N+accepted.length. Orphans about to fill 1..N. So the
  // first available code after both is N + accepted.length + 1.
  await im.applyRenumberPatch(slug, {
    renames: renamePlan,
    advance_next_to: Math.max(accepted.length + N + 1, currentNext + N),
  })

  // Stage 3: adopt orphans into the now-vacant 1..N slot range.
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i]!
    const code = formatEpisodeCode(i + 1, meta.episode_prefix, meta.episode_digits)
    try {
      const r = await adoptOne(slug, accountId, account.remote_id, video, code)
      adopted.push(r)
    } catch (e: any) {
      errors.push({ stage: `adopt orphan ${video.videoId} as ${code}`, detail: e?.message || 'adopt failed' })
    }
  }

  return { renamed, adopted, errors }
}

// ── Small helpers ────────────────────────────────────────────────────────
//
// Note: the prior `readIdeasStore` + `writeIdeasStore` helpers were
// removed when the orphan-adoption flow moved to im.* (which goes
// through mutateStore + auto-heal). Direct ideas.json reads/writes
// from this file would reintroduce the recycled_numbers race that
// caused TN0001 reuse — don't add them back.

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

/**
 * After renaming the episode folder, its subfolders (e.g.
 * `{code} - 01 Script`) still carry the OLD code in their names.
 * Rename each so file-paths stay consistent with the new code.
 */
async function renameCodeScopedSubfolders(episodeDir: string, oldCode: string, newCode: string): Promise<void> {
  if (!existsSync(episodeDir)) return
  const entries = await fs.readdir(episodeDir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!e.name.includes(oldCode)) continue
    const oldPath = path.join(episodeDir, e.name)
    const newName = e.name.replaceAll(oldCode, newCode)
    const newPath = path.join(episodeDir, newName)
    try { await fs.rename(oldPath, newPath) } catch { /* non-fatal: leave stale name */ }
  }
  // Files directly under the episode dir (e.g. `{code}_final_video.mp4`)
  // need renaming too so the broadened detection still fires.
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!e.name.startsWith(oldCode)) continue
    const oldPath = path.join(episodeDir, e.name)
    const newName = e.name.replace(oldCode, newCode)
    const newPath = path.join(episodeDir, newName)
    try { await fs.rename(oldPath, newPath) } catch { /* non-fatal */ }
  }
  // Recurse into subdirectories to rename per-scene files inside (e.g.
  // `{code}_Scene01.mp4`, `{code}_merged_audio.mp3`).
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
