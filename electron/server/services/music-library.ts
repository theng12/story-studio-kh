/**
 * The channel's music library (v1.4.37).
 *
 * WHAT THIS IS NOT. It is not `services/music-pool.ts`, and the two are
 * deliberately separate. That one manages the background bed that ducks under
 * narration: one track chosen per episode, from `{projectDir}/music/`. This one
 * is a channel's record collection at `{projectDir}/music-library/`, and a
 * music-mix video is BUILT FROM it — many tracks per video, chosen to fill a
 * runtime. The owner ruled both stay, each with its own page, because they are
 * different jobs. Merging the folders would put a narration bed into a mix.
 *
 * WHY A LIBRARY AT ALL. Measured 2026-08-23: one Suno request costs 100 credits
 * ($0.06) and returns two complete tracks of about three minutes. An hour of
 * music is therefore ~10 requests, and a 200-song library is ~$6 ONCE. After
 * that, a video costs nothing to make — video #50 costs what video #2 did. That
 * is the whole economic argument for the format, and it only works if tracks are
 * durable, reusable assets rather than per-video purchases.
 *
 * DISK IS THE TRUTH, exactly as in music-pool. Files are auto-discovered, so the
 * owner can drop tracks in through Finder and they appear. Config layers
 * metadata on top and is pruned on every read, so a Finder delete cannot leave
 * an orphaned row behind.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import * as pm from './project-manager.js'
import type {
  MusicLibraryTrack,
  MusicLibraryUsageEntry,
  ProjectConfig,
} from '../models/types.js'

/** Same set music-pool indexes, so a track can be moved between the two. */
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i
const USAGE_LOG_CAP = 500
export const MUSIC_LIBRARY_DIRNAME = 'music-library'

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
   * Total playable seconds across ENABLED tracks whose length could be measured
   * — what a mix can draw on, as far as the app can prove.
   *
   * v1.4.199 — read this WITH `unmeasured_enabled_tracks`. An enabled track whose
   * duration could not be probed contributed `0` to the total while still
   * counting as available, so the figure was silently LOW and the UI presented
   * it as the whole answer. AGENTS.md §6: a number that cannot be measured must
   * not be reported as a small one.
   */
  available_seconds: number
  /**
   * Enabled tracks whose `duration_sec` is unknown. Greater than zero means
   * `available_seconds` is a **floor**, not a total, and the UI must say so.
   */
  unmeasured_enabled_tracks: number
  recent_usage: MusicLibraryUsageEntry[]
}

/** Resolve {projectDir}/music-library/, creating it if missing. */
export async function getLibraryDir(slug: string): Promise<string | null> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return null
  const dir = path.join(projectDir, MUSIC_LIBRARY_DIRNAME)
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * A stable id for the tracks that came back from one GenStudio request.
 *
 * Derived from the job id rather than minted, so it is identical whether it is
 * computed during the run or recomputed after a crash — the same reasoning that
 * governs every retry identity in this app.
 */
export function siblingGroupForJob(jobId: string): string {
  return createHash('sha256').update(`music-siblings\n${jobId}`).digest('hex').slice(0, 16)
}

function usageIndex(cfg: ProjectConfig | null): Map<string, { last: string | null; count: number }> {
  const index = new Map<string, { last: string | null; count: number }>()
  for (const entry of cfg?.music_library_usage_log || []) {
    const prev = index.get(entry.filename) || { last: null, count: 0 }
    index.set(entry.filename, {
      last: !prev.last || entry.used_at > prev.last ? entry.used_at : prev.last,
      count: prev.count + 1,
    })
  }
  return index
}

/**
 * Read the library: disk file list, decorated with stored metadata.
 *
 * A file with no metadata row is still a track — that is what makes a Finder
 * drop work. It gets its filename as a title and is enabled, because a track
 * the owner deliberately put in the folder should be usable without a second
 * step.
 */
export async function listLibrary(slug: string): Promise<LibraryState> {
  const dir = await getLibraryDir(slug)
  if (!dir) return { tracks: [], folder: '', available_seconds: 0, unmeasured_enabled_tracks: 0, recent_usage: [] }
  const cfg = await pm.getConfig(slug).catch(() => null)
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const files = entries.filter(f => AUDIO_EXT.test(f)).sort((a, b) => a.localeCompare(b))
  const metaByName = new Map<string, MusicLibraryTrack>()
  for (const m of cfg?.music_library_tracks || []) metaByName.set(m.filename, m)
  const usage = usageIndex(cfg)

  const tracks: LibraryTrack[] = files.map(filename => {
    const meta = metaByName.get(filename)
    const seen = usage.get(filename)
    return {
      filename,
      path: path.join(dir, filename),
      title: meta?.title?.trim() || filename.replace(AUDIO_EXT, ''),
      enabled: meta?.enabled !== false,
      ...(meta?.duration_sec !== undefined ? { duration_sec: meta.duration_sec } : {}),
      ...(meta?.sibling_group ? { sibling_group: meta.sibling_group } : {}),
      ...(meta?.sibling_index !== undefined ? { sibling_index: meta.sibling_index } : {}),
      ...(meta?.brief_id ? { brief_id: meta.brief_id } : {}),
      ...(meta?.tags?.length ? { tags: meta.tags } : {}),
      ...(meta?.genstudio_job_id ? { genstudio_job_id: meta.genstudio_job_id } : {}),
      ...(meta?.added_at ? { added_at: meta.added_at } : {}),
      last_used_at: seen?.last ?? null,
      times_used: seen?.count ?? 0,
    }
  })

  return {
    tracks,
    folder: dir,
    available_seconds: tracks
      .filter(t => t.enabled)
      .reduce((total, t) => total + (t.duration_sec || 0), 0),
    unmeasured_enabled_tracks: tracks
      .filter(t => t.enabled && !(Number(t.duration_sec) > 0))
      .length,
    recent_usage: [...(cfg?.music_library_usage_log || [])]
      .sort((a, b) => b.used_at.localeCompare(a.used_at))
      .slice(0, 20),
  }
}

/**
 * Write metadata for one track, pruning rows whose files are gone.
 *
 * Pruning on write as well as read is what stops a library that has been
 * reorganised through Finder from accumulating rows for tracks nobody has.
 */
export async function upsertTrackMeta(
  slug: string,
  filename: string,
  patch: Partial<MusicLibraryTrack>,
): Promise<void> {
  const dir = await getLibraryDir(slug)
  if (!dir) throw new Error(`Project ${slug} has no folder on disk.`)
  const present = new Set((await fs.readdir(dir).catch(() => [] as string[])).filter(f => AUDIO_EXT.test(f)))
  const cfg = await pm.getConfig(slug).catch(() => null)
  const rows = (cfg?.music_library_tracks || []).filter(r => present.has(r.filename))
  const existing = rows.find(r => r.filename === filename)
  if (existing) Object.assign(existing, patch, { filename })
  else if (present.has(filename)) {
    rows.push({
      filename,
      title: filename.replace(AUDIO_EXT, ''),
      enabled: true,
      added_at: new Date().toISOString(),
      ...patch,
    })
  }
  await pm.updateConfig(slug, { music_library_tracks: rows })
}

/** Delete a track's file and its metadata row. */
export async function removeTrack(slug: string, filename: string): Promise<void> {
  const dir = await getLibraryDir(slug)
  if (!dir) throw new Error(`Project ${slug} has no folder on disk.`)
  // Refuse anything that is not already a bare filename. Callers pass values
  // that arrived over HTTP.
  //
  // The first version of this took `path.basename(filename)` and then checked
  // the result was inside the folder. That check could never fail — basename
  // had already stripped the traversal — so `../../config.json` was silently
  // REWRITTEN to `config.json` and deleted from the library folder instead of
  // being refused. Harmless here only by luck: a caller bug that pointed at the
  // wrong file would have been carried out quietly against a same-named track.
  // Rejecting is the behaviour that surfaces the bug.
  if (!filename || filename !== path.basename(filename)) {
    throw new Error(`Invalid track filename: ${filename}`)
  }
  await fs.rm(path.join(dir, filename), { force: true })
  const cfg = await pm.getConfig(slug).catch(() => null)
  await pm.updateConfig(slug, {
    music_library_tracks: (cfg?.music_library_tracks || []).filter(r => r.filename !== filename),
  })
}

/**
 * Record that a rendered mix used these tracks.
 *
 * Called AFTER a render succeeds, never when a mix is merely previewed — the
 * same peek/record split music-pool uses, and for the same reason: "how often
 * has this been heard" must mean heard, not considered.
 */
export async function recordMixUsage(
  slug: string,
  episodeCode: string,
  filenames: string[],
): Promise<void> {
  if (!filenames.length) return
  const cfg = await pm.getConfig(slug).catch(() => null)
  const usedAt = new Date().toISOString()
  const log = [
    ...(cfg?.music_library_usage_log || []),
    ...filenames.map(filename => ({ filename, episode_code: episodeCode, used_at: usedAt })),
  ]
  await pm.updateConfig(slug, {
    music_library_usage_log: log.slice(Math.max(0, log.length - USAGE_LOG_CAP)),
  })
}
