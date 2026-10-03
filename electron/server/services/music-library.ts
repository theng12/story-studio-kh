/**
 * The channel's music library (v1.4.37) — now a filename-keyed view of the Song Pool.
 *
 * WHAT THIS IS NOT. It is not `services/music-pool.ts`, and the two are
 * deliberately separate. That one manages the background bed that ducks under
 * narration: one track chosen per episode, from `{projectDir}/music/`. This one
 * is a channel's record collection at `{projectDir}/music-library/`, and a
 * music-mix video is BUILT FROM it. The owner ruled both stay.
 *
 * Since the music format (phase 1) the metadata lives in the pool's own sidecar,
 * `music-library/library.json` (`services/song-pool.ts`), because a 1,000-song
 * pool with full episode history does not belong in `config.json` and the old
 * 500-row usage log forgot everything after ~27 episodes. The old config rows are
 * migrated into the sidecar on first read and left untouched. This module keeps
 * the old filename-keyed API so the one-picture music video and the old page
 * read and write the same songs as the Song Pool.
 *
 * DISK IS THE TRUTH: a file dropped in through Finder appears; a file deleted
 * through Finder is never listed (and never drawn).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import * as sp from './song-pool.js'
import { moveToTrashSync } from '../lib/trash-move.js'
import type { MusicLibraryTrack, MusicLibraryUsageEntry } from '../models/types.js'

export const MUSIC_LIBRARY_DIRNAME = sp.MUSIC_LIBRARY_DIRNAME

export interface LibraryTrack extends MusicLibraryTrack {
  /** Absolute path on disk. */
  path: string
  /** ISO timestamp of the most recent recorded use, or null. */
  last_used_at: string | null
  /** How many rendered mixes have used this track. */
  times_used: number
}

export interface LibraryState {
  tracks: LibraryTrack[]
  /** Absolute path, so the UI can offer "reveal in Finder". */
  folder: string
  /**
   * Total playable seconds across ENABLED tracks whose length could be measured.
   * Read WITH `unmeasured_enabled_tracks`: greater than zero means this is a
   * floor, not a total (AGENTS.md §6).
   */
  available_seconds: number
  unmeasured_enabled_tracks: number
  recent_usage: MusicLibraryUsageEntry[]
}

/** Resolve {projectDir}/music-library/, creating it if missing. */
export async function getLibraryDir(slug: string): Promise<string | null> {
  const dir = sp.poolDir(slug)
  if (!dir) return null
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true })
  return dir
}

/** A stable id for the tracks that came back from one GenStudio request (derived, never minted). */
export function siblingGroupForJob(jobId: string): string {
  return createHash('sha256').update(`music-siblings\n${jobId}`).digest('hex').slice(0, 16)
}

const listed = (s: sp.SongRecord) => s.status !== 'rejected' && !s.file_missing

export async function listLibrary(slug: string): Promise<LibraryState> {
  const dir = await getLibraryDir(slug)
  if (!dir) return { tracks: [], folder: '', available_seconds: 0, unmeasured_enabled_tracks: 0, recent_usage: [] }
  const pool = await sp.readPool(slug)
  const tracks: LibraryTrack[] = pool.songs.filter(listed)
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(s => ({
      filename: s.file,
      path: path.join(dir, s.file),
      title: s.title,
      // An archived (rejected-but-used) song stays listed but is never drawn.
      enabled: s.enabled && s.status === 'ready',
      ...(s.duration_s !== undefined ? { duration_sec: s.duration_s } : {}),
      ...(s.sibling_group ? { sibling_group: s.sibling_group } : {}),
      ...(s.sibling_index !== undefined ? { sibling_index: s.sibling_index } : {}),
      ...(s.batch_id ? { brief_id: s.batch_id } : {}),
      ...(s.tags.length ? { tags: s.tags } : {}),
      ...(s.gateway_job_id ? { genstudio_job_id: s.gateway_job_id } : {}),
      added_at: s.created_at,
      last_used_at: sp.lastUse(s)?.used_at ?? null,
      times_used: s.episodes.length,
    }))
  const recent = pool.songs.flatMap(s => s.episodes.map(e => ({ filename: s.file, episode_code: e.code, used_at: e.used_at })))
    .sort((a, b) => b.used_at.localeCompare(a.used_at)).slice(0, 20)
  return {
    tracks,
    folder: dir,
    available_seconds: tracks.filter(t => t.enabled).reduce((total, t) => total + (t.duration_sec || 0), 0),
    unmeasured_enabled_tracks: tracks.filter(t => t.enabled && !(Number(t.duration_sec) > 0)).length,
    recent_usage: recent,
  }
}

/** Write metadata for one track (by filename). A file that is not in the folder is ignored. */
export async function upsertTrackMeta(
  slug: string,
  filename: string,
  patch: Partial<MusicLibraryTrack>,
): Promise<void> {
  await sp.updatePool(slug, pool => {
    const song = pool.songs.find(s => s.file === filename && s.status !== 'rejected' && !s.file_missing)
    if (!song) return
    if (patch.title !== undefined) song.title = patch.title
    if (patch.enabled !== undefined) song.enabled = patch.enabled
    if (patch.duration_sec !== undefined) song.duration_s = patch.duration_sec
    if (patch.tags !== undefined) song.tags = [...patch.tags]
    if (patch.sibling_group !== undefined) song.sibling_group = patch.sibling_group
    if (patch.sibling_index !== undefined) song.sibling_index = patch.sibling_index
    if (patch.brief_id !== undefined) song.batch_id = patch.brief_id
    if (patch.genstudio_job_id !== undefined) { song.gateway_job_id = patch.genstudio_job_id; song.source = 'generated' }
  })
}

/** Move a track's file to the project's `_trash` and mark it rejected (history kept). */
export async function removeTrack(slug: string, filename: string): Promise<void> {
  // Refuse anything that is not already a bare filename (values arrive over HTTP).
  if (!filename || filename !== path.basename(filename)) {
    throw new Error(`Invalid track filename: ${filename}`)
  }
  const dir = await getLibraryDir(slug)
  if (!dir) throw new Error(`Project ${slug} has no folder on disk.`)
  const pool = await sp.readPool(slug)
  const song = pool.songs.find(s => s.file === filename && s.status !== 'rejected')
  if (!song) return
  // Remove means "take it away" here, even for a used song: the old page has no archive.
  await sp.updatePool(slug, p => {
    const s = p.songs.find(x => x.id === song.id)!
    const file = path.join(dir, s.file)
    if (existsSync(file)) moveToTrashSync(file, path.join(path.dirname(dir), '_trash', MUSIC_LIBRARY_DIRNAME, s.file))
    s.status = 'rejected'
  })
}

/** Record that a RENDERED mix used these tracks (never a preview). */
export async function recordMixUsage(
  slug: string,
  episodeCode: string,
  filenames: string[],
): Promise<void> {
  if (!filenames.length) return
  const pool = await sp.readPool(slug)
  const ids = pool.songs.filter(s => filenames.includes(s.file) && s.status !== 'rejected').map(s => s.id)
  await sp.recordEpisodeUse(slug, ids, { code: episodeCode, project_slug: slug, used_at: new Date().toISOString() })
}
