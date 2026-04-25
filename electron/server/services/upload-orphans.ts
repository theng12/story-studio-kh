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
import { PROJECTS_ROOT } from './project-manager.js'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths, formatEpisodeCode, episodeNumber } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { listRecentUploads } from '../lib/youtube-client.js'
import { writeSidecar, readSidecar } from './upload-sidecar.js'
import * as store from './upload-store.js'

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

  // Add the idea record directly (bypass acceptIdea's auto-code). We use
  // im.addIdeas for the easy path then patch its status + code.
  const [created] = await im.addIdeas(slug, [{
    title: video.title || episode_code,
    logline: '(adopted from YouTube)',
    themes: [],
    suggested_chapters: 0,
    suggested_length: '0 min',
    mood: '',
  }], 'orphan-adopt')

  // Patch to accepted + set code. Go directly through the JSON store —
  // acceptIdea would assign next_episode_number which we're overriding.
  const p = path.join(PROJECTS_ROOT, slug, 'ideas.json')
  const raw = await fs.readFile(p, 'utf-8')
  const data = JSON.parse(raw)
  const ideaIdx = data.ideas.findIndex((i: any) => i.id === created.id)
  if (ideaIdx === -1) throw new Error('Idea insert race: not found after addIdeas')
  data.ideas[ideaIdx].status = 'accepted'
  data.ideas[ideaIdx].episode_code = episode_code
  data.ideas[ideaIdx].accepted_at = new Date().toISOString()
  await writeJsonAtomic(p, data)

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

  const account = (await store.listAccounts(slug, 'youtube')).find(a => a.id === accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  const adopted = await adoptOne(slug, accountId, account.remote_id, video, episode_code)

  // Bump next_episode_number if the user picked a code >= current max.
  // Otherwise leave as-is (they filled in a gap).
  const num = episodeNumber(episode_code, meta.episode_prefix)
  const store2 = await readIdeasStore(slug)
  if (num >= store2.next_episode_number) {
    store2.next_episode_number = num + 1
    await writeIdeasStore(slug, store2)
  }
  return adopted
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
  const account = (await store.listAccounts(slug, 'youtube')).find(a => a.id === accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  const s = await readIdeasStore(slug)
  const adopted: AdoptedOne[] = []
  const errors: Array<{ video_id: string; error: string }> = []

  for (const video of videos) {
    const num = s.next_episode_number
    const code = formatEpisodeCode(num, meta.episode_prefix, meta.episode_digits)
    try {
      const r = await adoptOne(slug, accountId, account.remote_id, video, code)
      adopted.push(r)
      s.next_episode_number = num + 1
      await writeIdeasStore(slug, s)   // persist after each successful adopt
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
  const account = (await store.listAccounts(slug, 'youtube')).find(a => a.id === accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found`)

  const renamed: Array<{ old_code: string; new_code: string; old_dir: string; new_dir: string }> = []
  const adopted: AdoptedOne[] = []
  const errors: Array<{ stage: string; detail: string }> = []

  if (videos.length === 0) {
    return { renamed, adopted, errors }
  }

  const N = videos.length
  const s = await readIdeasStore(slug)
  const accepted = (s.ideas as any[]).filter(i => i.status === 'accepted' && i.episode_code).slice()

  // Sort descending by current episode number so when we rename, the
  // highest numbers move first — prevents collision where shifting
  // TN0001 → TN0051 would conflict with existing TN0051 before it's moved.
  accepted.sort((a: any, b: any) => {
    const an = episodeNumber(a.episode_code!, meta.episode_prefix)
    const bn = episodeNumber(b.episode_code!, meta.episode_prefix)
    return bn - an
  })

  // Stage 1: rename existing episodes. For each, compute new code = old + N,
  // resolve old + new paths, fs.rename.
  for (const idea of accepted) {
    const oldCode = idea.episode_code!
    const oldNum = episodeNumber(oldCode, meta.episode_prefix)
    const newNum = oldNum + N
    const newCode = formatEpisodeCode(newNum, meta.episode_prefix, meta.episode_digits)
    try {
      const oldPaths = await resolveEpisodePaths(slug, oldCode, idea.title)
      // Update the idea's code BEFORE computing new paths so resolveEpisodePaths
      // uses the new code's folder template.
      idea.episode_code = newCode
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

      renamed.push({
        old_code: oldCode, new_code: newCode,
        old_dir: oldPaths.episode_dir, new_dir: newPaths.episode_dir,
      })
    } catch (e: any) {
      errors.push({ stage: `rename ${oldCode} → ${newCode}`, detail: e?.message || 'rename failed' })
    }
  }

  // Stage 2: persist the renumbered ideas list before adopting orphans,
  // so the orphan adoption sees the shifted state.
  // next_episode_number = max(existing new numbers) + N + 1
  //   After shift: existing take codes N+1..N+existing_count.
  //   Orphans will occupy 1..N, so next = (existing_count + N + 1).
  s.next_episode_number = Math.max(accepted.length + N + 1, s.next_episode_number + N)
  await writeIdeasStore(slug, s)

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

async function readIdeasStore(slug: string): Promise<any> {
  const p = path.join(PROJECTS_ROOT, slug, 'ideas.json')
  const raw = await fs.readFile(p, 'utf-8').catch(() => '{"ideas":[],"next_episode_number":1}')
  return JSON.parse(raw)
}

async function writeIdeasStore(slug: string, data: any): Promise<void> {
  const p = path.join(PROJECTS_ROOT, slug, 'ideas.json')
  await writeJsonAtomic(p, data)
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
