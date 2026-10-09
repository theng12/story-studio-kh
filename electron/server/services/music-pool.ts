/**
 * Background-music pool (v1.0.107+).
 *
 * Project-level pool of music tracks with cycling logic. Files live
 * in {projectDir}/music/ — auto-discovered, so a user can drop in
 * tracks via Finder OR add them through the UI. The project config
 * layers per-track metadata (enabled flag, optional label) + cycling
 * state (strategy, cursor, usage log) on top of the disk view.
 *
 * Strategies:
 *   - 'sequential'        — E1=track1, E2=track2, ..., wraps via cursor
 *   - 'random-no-repeat'  — random pick from tracks NOT used in the
 *                           last N episodes
 *   - 'manual'            — no auto-pick; user picks every episode
 *
 * Call sites:
 *   - listPool(slug)           — admin/UI view of the pool
 *   - peekNext(slug, code)     — read-only "what would be picked?"
 *   - recordPick(slug, code, filename) — advance cursor + log usage
 *                                        AFTER a merge job actually
 *                                        uses the pool's track
 *
 * The peek/record split matters: we don't want the cursor to advance
 * just because someone opened an episode and clicked away. Only an
 * actual successful merge counts as "used".
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import * as pm from './project-manager.js'
import { moveToTrashSync } from '../lib/trash-move.js'
import type {
  VideoMusicConfig,
  MusicPoolTrack,
  MusicPoolUsageEntry,
  ProjectConfig,
} from '../models/types.js'

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i
const LOG_CAP = 100
const DEFAULT_LOOKBACK = 5
const DEFAULT_STRATEGY: 'sequential' | 'random-no-repeat' | 'manual' = 'sequential'

export interface PoolTrack {
  /** Filename inside {projectDir}/music/. */
  filename: string
  /** Absolute path on disk. */
  path: string
  /** Whether the track participates in auto-cycling (false = skipped
   *  by sequential + random-no-repeat picks; still listed in the UI). */
  enabled: boolean
  /** Human-friendly label, falls back to filename when unset. */
  label: string
  /** ISO timestamp of the most recent recorded use, or null when never
   *  used in this project. UI shows this so the user knows what's been
   *  rotated through recently. */
  last_used_at: string | null
  /** Episode_code of the most recent recorded use, mirrors last_used_at. */
  last_used_episode: string | null
  /** v1.0.108+ — per-track override knobs. Undefined = inherit the
   *  merge form's global setting. */
  volume?: number
  post_narration_volume?: number
  fade_in?: number
  fade_out?: number
}

export interface PoolState {
  /** Resolved active strategy (config OR 'sequential' default). */
  strategy: 'sequential' | 'random-no-repeat' | 'manual'
  /** Sequential cursor (0-indexed). */
  cursor: number
  /** Lookback window for random-no-repeat. */
  lookback: number
  /** Auto-discovered + metadata-decorated track list, sorted by filename. */
  tracks: PoolTrack[]
  /** Last 20 usage entries, newest-first. Drives the "what's been
   *  rotated through recently" line in the UI. */
  recent_usage: MusicPoolUsageEntry[]
  /** Absolute path to the project's music folder (so the UI can show
   *  it in a "drop files here via Finder" hint). */
  folder: string
}

/** Resolve {projectDir}/music/, creating it if missing. Returns null
 *  when the project itself can't be located. */
async function getPoolDir(slug: string): Promise<string | null> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return null
  const dir = path.join(projectDir, 'music')
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true })
  return dir
}

/** Read the auto-discovered file list from disk, merge with stored
 *  metadata, prune metadata entries whose files no longer exist. */
async function scanTracks(slug: string, cfg: ProjectConfig | null): Promise<PoolTrack[]> {
  const dir = await getPoolDir(slug)
  if (!dir) return []
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const audioFiles = entries.filter(f => AUDIO_EXT.test(f)).sort((a, b) => a.localeCompare(b))
  const metaByName = new Map<string, MusicPoolTrack>()
  for (const m of cfg?.music_pool_tracks || []) metaByName.set(m.filename, m)
  const usageByName = new Map<string, MusicPoolUsageEntry>()
  for (const u of cfg?.music_pool_usage_log || []) {
    const prev = usageByName.get(u.filename)
    if (!prev || u.used_at > prev.used_at) usageByName.set(u.filename, u)
  }
  const result: PoolTrack[] = []
  for (const filename of audioFiles) {
    const meta = metaByName.get(filename)
    const usage = usageByName.get(filename)
    result.push({
      filename,
      path: path.join(dir, filename),
      enabled: meta?.enabled ?? true,
      label: meta?.label || filename.replace(AUDIO_EXT, '').replace(/[_-]+/g, ' '),
      last_used_at: usage?.used_at || null,
      last_used_episode: usage?.episode_code || null,
      // v1.0.108+ — per-track override knobs (only included when set in
      // the stored metadata; undefined means "inherit global form").
      ...(typeof meta?.volume === 'number' ? { volume: meta.volume } : {}),
      ...(typeof meta?.post_narration_volume === 'number'
        ? { post_narration_volume: meta.post_narration_volume } : {}),
      ...(typeof meta?.fade_in === 'number' ? { fade_in: meta.fade_in } : {}),
      ...(typeof meta?.fade_out === 'number' ? { fade_out: meta.fade_out } : {}),
    })
  }
  return result
}

/** Public — full pool state for the UI panel + audio-merge integration. */
export async function getPoolState(slug: string): Promise<PoolState | null> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return null
  const cfg = await pm.getConfig(slug)
  const tracks = await scanTracks(slug, cfg)
  const strategy = cfg?.music_pool_strategy || DEFAULT_STRATEGY
  const cursor = typeof cfg?.music_pool_cursor === 'number' ? cfg.music_pool_cursor : 0
  const lookback = typeof cfg?.music_pool_lookback === 'number' && cfg.music_pool_lookback > 0
    ? cfg.music_pool_lookback
    : DEFAULT_LOOKBACK
  const log = Array.isArray(cfg?.music_pool_usage_log) ? cfg.music_pool_usage_log : []
  const recent_usage = [...log].sort((a, b) => b.used_at.localeCompare(a.used_at)).slice(0, 20)
  return {
    strategy,
    cursor,
    lookback,
    tracks,
    recent_usage,
    folder: path.join(projectDir, 'music'),
  }
}

/**
 * Compute what the cycler WOULD pick for `episode_code` without
 * mutating state. The UI calls this on episode load to show "Next
 * track: <filename>" before the user commits.
 *
 * Returns null when:
 *   - the pool is empty / all disabled, or
 *   - the strategy is 'manual'
 */
export async function peekNext(slug: string, episode_code: string): Promise<{ track: PoolTrack; reason: string } | null> {
  const state = await getPoolState(slug)
  if (!state) return null
  if (state.strategy === 'manual') return null

  const eligible = state.tracks.filter(t => t.enabled)
  if (!eligible.length) return null

  // Re-merging an episode keeps the track it already has. Without this every
  // re-assembly advanced the cursor and handed the episode the NEXT track —
  // often another episode's (Dreamlands EP0002 re-merge took EP0001's track).
  const cfg = await pm.getConfig(slug)
  const ownUse = (Array.isArray(cfg?.music_pool_usage_log) ? cfg.music_pool_usage_log : [])
    .filter(entry => entry.episode_code === episode_code)
    .sort((a, b) => b.used_at.localeCompare(a.used_at))
    .map(entry => eligible.find(track => track.filename === entry.filename))
    .find((track): track is PoolTrack => !!track)
  if (ownUse) return { track: ownUse, reason: `this episode's track (kept when re-merging)` }

  if (state.strategy === 'sequential') {
    const idx = state.cursor % eligible.length
    const track = eligible[idx]!
    return {
      track,
      reason: `sequential cursor ${state.cursor + 1} / ${eligible.length}`,
    }
  }

  // random-no-repeat — drop tracks used in the last `lookback` UNIQUE
  // episodes. If the lookback window already covers every eligible
  // track, fall back to the least-recently-used one rather than
  // returning null (the user should still get music).
  const recentEpisodes = new Set<string>()
  const recentFilenames = new Set<string>()
  // Walk log oldest→newest then reverse for chronological newest first
  const reversed = [...state.recent_usage].reverse() // recent_usage is newest-first; reversing → oldest-first
  // Actually recent_usage came in newest-first; iterate as-is:
  for (const e of state.recent_usage) {
    if (e.episode_code === episode_code) continue // skip the episode we're picking for
    if (!recentEpisodes.has(e.episode_code)) {
      if (recentEpisodes.size >= state.lookback) break
      recentEpisodes.add(e.episode_code)
    }
    recentFilenames.add(e.filename)
  }
  void reversed // silence unused-var lint; the loop walks state.recent_usage directly
  const fresh = eligible.filter(t => !recentFilenames.has(t.filename))
  if (fresh.length > 0) {
    // Seeded by the episode code, so the page's preview and a Pipeline merge pick the same track.
    const pick = fresh[createHash('sha256').update(episode_code).digest().readUInt32BE(0) % fresh.length]!
    return {
      track: pick,
      reason: `random pick from ${fresh.length} of ${eligible.length} (avoiding last ${recentEpisodes.size} episodes' tracks)`,
    }
  }
  // All eligible tracks are recent — pick the least-recently-used so
  // we still rotate fairly instead of blocking music.
  const byLast = [...eligible].sort((a, b) => (a.last_used_at || '').localeCompare(b.last_used_at || ''))
  return {
    track: byLast[0]!,
    reason: `pool exhausted — picking least-recently-used (${byLast[0]!.label})`,
  }
}

/**
 * Background music set to "Music Pool" without a file (a Pipeline batch: its Audio Assembly preset
 * keeps the source, not a track) gets the track the Audio Assembly page would show for this
 * episode, with that track's own levels. Null when the request names its own files (the page sends
 * its pick as a file) or the pool has nothing to give.
 */
export async function pickPoolMusic(
  slug: string,
  episode_code: string,
  music: VideoMusicConfig | undefined,
): Promise<{ music: VideoMusicConfig; track: PoolTrack; reason: string } | null> {
  if (!music?.enabled) return null
  // Older presets carry no source; an empty file list there means the pool, as on the page.
  const source = music.source ?? (music.files?.length ? 'manual' : 'pool')
  if (source !== 'pool') return null
  const picked = await peekNext(slug, episode_code)
  if (!picked) return null
  const { track } = picked
  const pct = (v: number | undefined, fallback: number) => typeof v === 'number' ? v / 100 : fallback
  return {
    track,
    reason: picked.reason,
    music: {
      ...music,
      files: [track.path],
      volume: pct(track.volume, music.volume),
      post_narration_volume: pct(track.post_narration_volume, music.post_narration_volume),
      fade_in: track.fade_in ?? music.fade_in,
      fade_out: track.fade_out ?? music.fade_out,
    },
  }
}

/**
 * Record that `filename` was used for `episode_code`. Advances the
 * sequential cursor (when applicable), appends to the usage log, and
 * trims the log to LOG_CAP entries.
 *
 * Idempotent on (filename, episode_code): re-recording the track an
 * episode already had (a re-merge) skips the cursor bump but still logs
 * the use so the UI reflects it.
 */
export async function recordPick(slug: string, episode_code: string, filename: string): Promise<{ logged: boolean }> {
  const cfg = await pm.getConfig(slug)
  if (!cfg) return { logged: false }
  const strategy = cfg.music_pool_strategy || DEFAULT_STRATEGY
  if (strategy === 'manual') return { logged: false }

  const tracks = await scanTracks(slug, cfg)
  const found = tracks.find(t => t.filename === filename)
  if (!found) return { logged: false } // track was deleted from disk between peek + record

  const log: MusicPoolUsageEntry[] = Array.isArray(cfg.music_pool_usage_log) ? [...cfg.music_pool_usage_log] : []
  const now = new Date().toISOString()
  // A re-merge with the track this episode already had is not a new pick.
  const episodeAlreadyHadTrack = log.some(e => e.filename === filename && e.episode_code === episode_code)

  log.push({ filename, episode_code, used_at: now })
  while (log.length > LOG_CAP) log.shift()

  const patch: Partial<ProjectConfig> = { music_pool_usage_log: log }
  if (strategy === 'sequential' && !episodeAlreadyHadTrack) {
    // Advance only when this is a fresh pick (not a re-merge).
    const cursor = typeof cfg.music_pool_cursor === 'number' ? cfg.music_pool_cursor : 0
    patch.music_pool_cursor = cursor + 1
  }
  await pm.updateConfig(slug, patch as any)
  return { logged: true }
}

// ── Track management ─────────────────────────────────────────────────────

/** Copy `sourcePath` into the project's music folder. Returns the
 *  resulting filename (which may be deduped with -2, -3, ... if a
 *  file with the same basename already exists). */
export async function addTrack(slug: string, sourcePath: string): Promise<{ filename: string }> {
  if (!existsSync(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`)
  if (!AUDIO_EXT.test(sourcePath)) {
    throw new Error('Only audio files are accepted (mp3 / wav / m4a / aac / ogg / flac)')
  }
  const dir = await getPoolDir(slug)
  if (!dir) throw new Error('Project not found')
  let basename = path.basename(sourcePath)
  let dest = path.join(dir, basename)
  let n = 2
  while (existsSync(dest)) {
    const ext = path.extname(basename)
    const stem = basename.slice(0, -ext.length).replace(/-\d+$/, '')
    basename = `${stem}-${n}${ext}`
    dest = path.join(dir, basename)
    n++
  }
  await fs.copyFile(sourcePath, dest)
  return { filename: basename }
}

/** Remove a file from the pool folder + drop its stored metadata.
 *  The file moves to the project's `_trash/music/` — never hard-deleted. */
export async function removeTrack(slug: string, filename: string): Promise<{ removed: boolean }> {
  const dir = await getPoolDir(slug)
  if (!dir) return { removed: false }
  // A track is addressed by a bare filename, and this is an `unlink`. Without
  // this check `DELETE .../music-pool/tracks/..%2F..%2FDocuments%2Fsong.mp3`
  // joined straight out of the pool folder and unlinked that file. The sibling
  // `music-library.ts` already guards exactly here; this is the same rule.
  if (path.basename(filename) !== filename) return { removed: false }
  const full = path.join(dir, filename)
  if (!existsSync(full)) return { removed: false }
  moveToTrashSync(full, path.join(path.dirname(dir), '_trash', path.basename(dir), filename))
  const cfg = await pm.getConfig(slug)
  if (cfg) {
    const tracks = (cfg.music_pool_tracks || []).filter(t => t.filename !== filename)
    await pm.updateConfig(slug, { music_pool_tracks: tracks } as any)
  }
  return { removed: true }
}

/** Update enabled / label / per-track overrides for one track.
 *  Auto-creates the metadata entry if it doesn't exist yet. Passing
 *  `null` for an override clears it (track inherits global form again);
 *  omitting a field leaves the existing value alone. */
export async function updateTrackMeta(
  slug: string,
  filename: string,
  patch: {
    enabled?: boolean
    label?: string
    volume?: number | null
    post_narration_volume?: number | null
    fade_in?: number | null
    fade_out?: number | null
  },
): Promise<void> {
  const cfg = await pm.getConfig(slug)
  if (!cfg) return
  const tracks: MusicPoolTrack[] = Array.isArray(cfg.music_pool_tracks) ? [...cfg.music_pool_tracks] : []
  const idx = tracks.findIndex(t => t.filename === filename)
  const existing: MusicPoolTrack = idx >= 0 ? { ...tracks[idx]! } : { filename, enabled: true }
  if (typeof patch.enabled === 'boolean') existing.enabled = patch.enabled
  if (typeof patch.label === 'string') existing.label = patch.label
  // Override knobs: null = clear (delete the field), number = set,
  // undefined = leave as-is. Lets the UI explicitly opt out of an
  // override without re-saving the rest of the track's metadata.
  for (const k of ['volume', 'post_narration_volume', 'fade_in', 'fade_out'] as const) {
    const v = patch[k]
    if (v === null) delete existing[k]
    else if (typeof v === 'number' && Number.isFinite(v)) existing[k] = v
  }
  if (idx >= 0) tracks[idx] = existing
  else tracks.push(existing)
  await pm.updateConfig(slug, { music_pool_tracks: tracks } as any)
}

/** Update strategy / lookback. Other fields ignored. */
export async function updateSettings(
  slug: string,
  patch: { strategy?: 'sequential' | 'random-no-repeat' | 'manual'; lookback?: number; cursor?: number },
): Promise<void> {
  const out: Partial<ProjectConfig> = {}
  if (patch.strategy) out.music_pool_strategy = patch.strategy
  if (typeof patch.lookback === 'number' && patch.lookback > 0) out.music_pool_lookback = Math.floor(patch.lookback)
  if (typeof patch.cursor === 'number' && patch.cursor >= 0) out.music_pool_cursor = Math.floor(patch.cursor)
  if (Object.keys(out).length > 0) await pm.updateConfig(slug, out as any)
}
