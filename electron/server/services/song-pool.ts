/**
 * The Song Pool store: `{projectDir}/music-library/library.json` (music format, phase 1).
 *
 * One pool per project (= per channel). The file is SELF-CONTAINED — every song's brief,
 * measurements and episode history live in it — and each pool carries a stable `pool_id`, so the
 * Episode Builder can draw from one or several pools across projects (owner decision
 * 2026-10-03). Shape and rules: `_orchestra/audit-20261001/music-format/INTERFACES.md`.
 *
 * Disk stays the truth for audio, exactly as the Music Library always was: a file dropped into
 * the folder through Finder becomes a song on the next read, and a song whose file vanished is
 * marked `file_missing` (and never drawn) rather than erased, because its episode history may
 * back a published tracklist. Nothing is ever hard-deleted: a reject moves the file to the
 * project's `_trash`.
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import * as pm from './project-manager.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { measureTrackSeconds } from './music-render.js'

export const MUSIC_LIBRARY_DIRNAME = 'music-library'
export const POOL_FILENAME = 'library.json'
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i

export interface EpisodeUse { code: string; project_slug: string; used_at: string }

export interface SongRecord {
  id: string
  file: string
  status: 'ready' | 'rejected' | 'archived'
  enabled: boolean
  title: string
  ensemble?: string
  mood?: string
  energy?: number
  tempo_bpm?: number
  tempo_band?: string
  key?: string
  texture?: string
  structure?: string
  length_s?: number
  line?: string
  prompt?: string
  scene_idea?: string
  theme?: string
  tags: string[]
  combo_key?: string
  seed?: number
  writer_model?: string
  music_model?: string
  batch_id?: string
  gateway_job_id?: string
  take_of?: string
  /** Legacy (Suno two-takes-per-request): takes of one request share a group; the old mix keeps them apart. */
  sibling_group?: string
  sibling_index?: number
  source: 'generated' | 'folder'
  created_at: string
  duration_s?: number
  lufs?: number
  true_peak_db?: number
  gap_s?: number
  gap_at_s?: number
  generation_s?: number
  rating: number | null
  episodes: EpisodeUse[]
  /** Recomputed on every read: the audio file is not in the folder. */
  file_missing?: boolean
  /** Ids of duplicate entries for the same file that were folded into this one (1.4.270). */
  merged_ids?: string[]
  /** Songs with lyrics: the sung words and the writer's style line. Absent = instrumental. */
  lyrics?: string
  style?: string
  /**
   * The listen-back: `passed`/`failed` against the channel's threshold with the measured share of lyric
   * words heard in order (`lyrics_match`, 0..1), or `unchecked` when no transcript could be made (then
   * there is no `lyrics_match` at all, never a 0). Only `passed` songs are switched on.
   */
  lyrics_check?: 'passed' | 'failed' | 'unchecked'
  lyrics_match?: number
}

export interface SongPoolFile {
  schema: 'story-studio.song-pool'
  version: 1
  pool_id: string
  name: string
  project_slug: string
  created_at: string
  updated_at: string
  songs: SongRecord[]
}

export const newSongId = () => `s_${randomBytes(6).toString('hex')}`

export function poolDir(slug: string): string | null {
  const projectDir = pm.getProjectDir(slug)
  return projectDir ? path.join(projectDir, MUSIC_LIBRARY_DIRNAME) : null
}

function requireDir(slug: string): string {
  const dir = poolDir(slug)
  if (!dir) throw Object.assign(new Error(`Project ${slug} has no folder on disk.`), { statusCode: 404 })
  return dir
}

/** First read of a pool with no library.json: carry the old Music Library rows across (config is left untouched). */
async function migrate(slug: string): Promise<SongPoolFile> {
  const now = new Date().toISOString()
  const cfg: any = await pm.getConfig(slug).catch(() => null)
  const project = await pm.getProject(slug).catch(() => null)
  const usage = new Map<string, EpisodeUse[]>()
  for (const u of cfg?.music_library_usage_log || []) {
    if (!u?.filename) continue
    const list = usage.get(u.filename) || []
    if (!list.some(e => e.code === u.episode_code)) list.push({ code: String(u.episode_code), project_slug: slug, used_at: String(u.used_at) })
    usage.set(u.filename, list)
  }
  const songs: SongRecord[] = (cfg?.music_library_tracks || []).map((m: any): SongRecord => ({
    id: newSongId(),
    file: String(m.filename),
    status: 'ready',
    enabled: m.enabled !== false,
    title: String(m.title || m.filename).trim(),
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    ...(m.brief_id ? { batch_id: String(m.brief_id) } : {}),
    ...(m.genstudio_job_id ? { gateway_job_id: String(m.genstudio_job_id) } : {}),
    ...(m.sibling_group ? { sibling_group: String(m.sibling_group) } : {}),
    ...(m.sibling_index !== undefined ? { sibling_index: Number(m.sibling_index) } : {}),
    ...(Number(m.duration_sec) > 0 ? { duration_s: Number(m.duration_sec) } : {}),
    source: m.genstudio_job_id ? 'generated' : 'folder',
    created_at: String(m.added_at || now),
    rating: null,
    episodes: usage.get(String(m.filename)) || [],
  }))
  return {
    schema: 'story-studio.song-pool',
    version: 1,
    pool_id: `pool_${randomBytes(6).toString('hex')}`,
    name: project?.name || slug,
    project_slug: slug,
    created_at: now,
    updated_at: now,
    songs,
  }
}

/** Tag an earlier repair put on a duplicate it switched off; that "off" was never the owner's choice. */
export const DUPLICATE_INDEX_TAG = 'duplicate-index'

/**
 * 1.4.270 — one entry per audio file. Before 1.4.270 a pool read while the generator was still
 * trimming a new file indexed it as an unknown "folder" song, and then the real entry was added too,
 * so a draw could put one song into an episode twice. Every "folder" entry for a file that has
 * another entry (not rejected) is folded into it: the newest generated entry wins (else the first
 * entry), plays and ratings are
 * merged, and the folded ids are kept in `merged_ids` so episode plans that name them still resolve.
 * An entry switched off and tagged `duplicate-index` by an earlier clean-up does not switch the
 * merged song off. No audio file is touched. Returns true when anything was folded.
 */
export function mergeDuplicateFiles(pool: SongPoolFile): boolean {
  const byFile = new Map<string, SongRecord[]>()
  for (const song of pool.songs) {
    if (song.status === 'rejected') continue
    byFile.set(song.file, [...(byFile.get(song.file) || []), song])
  }
  const drop = new Set<SongRecord>()
  for (const group of byFile.values()) {
    if (group.length < 2) continue
    const keep = [...group].reverse().find(song => song.source === 'generated') ?? group[0]!
    const folded = group.filter(song => song === keep || song.source === 'folder')
    if (folded.length < 2) continue
    const owned = folded.filter(song => !song.tags.includes(DUPLICATE_INDEX_TAG))
    for (const other of folded) {
      if (other === keep) continue
      for (const use of other.episodes) {
        if (!keep.episodes.some(e => e.code === use.code && e.project_slug === use.project_slug)) keep.episodes.push(use)
      }
      keep.rating ??= other.rating
      keep.merged_ids = [...new Set([...(keep.merged_ids || []), ...(other.merged_ids || []), other.id])]
      drop.add(other)
    }
    // The kept entry's own on/off is the owner's choice unless an earlier clean-up set it.
    if (keep.tags.includes(DUPLICATE_INDEX_TAG)) keep.enabled = owned.length ? owned.some(song => song.enabled) : true
    keep.tags = [...new Set(folded.flatMap(song => song.tags))].filter(tag => tag !== DUPLICATE_INDEX_TAG)
  }
  if (drop.size) pool.songs = pool.songs.filter(song => !drop.has(song))
  return drop.size > 0
}

/** Load, migrate and reconcile with the folder. Caller holds the lock. */
async function loadLocked(slug: string): Promise<{ pool: SongPoolFile; changed: boolean }> {
  const dir = requireDir(slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, POOL_FILENAME)
  let pool: SongPoolFile
  let changed = false
  try {
    pool = JSON.parse(await fs.readFile(file, 'utf8'))
    if (pool?.schema !== 'story-studio.song-pool' || !Array.isArray(pool.songs)) {
      throw Object.assign(new Error(`${file} is not a song pool file; it was left as it is.`), { statusCode: 500 })
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    pool = await migrate(slug)
    changed = true
  }
  const onDisk = new Set((await fs.readdir(dir).catch(() => [] as string[])).filter(f => AUDIO_EXT.test(f) && !f.startsWith('.')))
  const known = new Set(pool.songs.map(s => s.file))
  for (const s of pool.songs) {
    const missing = s.status !== 'rejected' && !onDisk.has(s.file)
    if (!!s.file_missing !== missing) { changed = true; if (missing) s.file_missing = true; else delete s.file_missing }
  }
  for (const f of [...onDisk].sort()) {
    if (known.has(f)) continue
    const duration = await measureTrackSeconds(path.join(dir, f))
    pool.songs.push({
      id: newSongId(), file: f, status: 'ready', enabled: true, title: f.replace(AUDIO_EXT, ''), tags: [],
      source: 'folder', created_at: new Date().toISOString(), rating: null, episodes: [],
      ...(duration ? { duration_s: duration } : {}),
    })
    changed = true
  }
  if (mergeDuplicateFiles(pool)) changed = true
  if (pool.project_slug !== slug) { pool.project_slug = slug; changed = true }
  return { pool, changed }
}

async function saveLocked(slug: string, pool: SongPoolFile): Promise<void> {
  pool.updated_at = new Date().toISOString()
  await writeJsonAtomic(path.join(requireDir(slug), POOL_FILENAME), pool)
}

const lockKey = (slug: string) => `song-pool:${slug}`

export async function readPool(slug: string): Promise<SongPoolFile> {
  return withLock(lockKey(slug), async () => {
    const { pool, changed } = await loadLocked(slug)
    if (changed) await saveLocked(slug, pool)
    return pool
  })
}

/** The only write path. `mutate` may change `pool` in place; its return value is passed through. */
export async function updatePool<T>(slug: string, mutate: (pool: SongPoolFile) => T | Promise<T>): Promise<{ pool: SongPoolFile; result: T }> {
  return withLock(lockKey(slug), async () => {
    const { pool } = await loadLocked(slug)
    const result = await mutate(pool)
    await saveLocked(slug, pool)
    return { pool, result }
  })
}

export function isDrawable(s: SongRecord): boolean {
  return s.status === 'ready' && s.enabled && !s.file_missing && Number(s.duration_s) > 0
}

export function lastUse(s: SongRecord): EpisodeUse | null {
  return s.episodes.reduce<EpisodeUse | null>((a, e) => (!a || e.used_at > a.used_at ? e : a), null)
}

/**
 * The last `n` distinct episodes of `channelSlug`, newest first, across every given pool —
 * the no-repeat window. Counted in episodes, not days (SPEC §4).
 */
export function episodeWindow(pools: SongPoolFile[], channelSlug: string, n: number): string[] {
  const newest = new Map<string, string>()
  for (const p of pools) for (const s of p.songs) for (const e of s.episodes) {
    if (e.project_slug !== channelSlug) continue
    if (!newest.has(e.code) || e.used_at > newest.get(e.code)!) newest.set(e.code, e.used_at)
  }
  return [...newest.entries()].sort((a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0])).slice(0, Math.max(0, n)).map(([c]) => c)
}

export function inWindow(s: SongRecord, window: string[], channelSlug: string): boolean {
  return s.episodes.some(e => e.project_slug === channelSlug && window.includes(e.code))
}

/** Record that a RENDERED episode used these songs. Idempotent per (song, project, episode). */
export async function recordEpisodeUse(poolSlug: string, songIds: string[], use: EpisodeUse): Promise<void> {
  if (!songIds.length) return
  await updatePool(poolSlug, pool => {
    const ids = new Set(songIds)
    for (const s of pool.songs) {
      if (!ids.has(s.id) && !s.merged_ids?.some(id => ids.has(id))) continue
      const hit = s.episodes.find(e => e.code === use.code && e.project_slug === use.project_slug)
      if (hit) hit.used_at = use.used_at
      else s.episodes.push({ ...use })
    }
  })
}

/**
 * Reject songs: never drawn again. A song that is in an episode is ARCHIVED (file kept, so the
 * episode's tracklist stays true); any other song's file moves to Story's Trash (`<slug>/music-library/`).
 */
export async function rejectSongs(slug: string, ids: string[]): Promise<{ trashed: string[]; archived: string[] }> {
  const dir = requireDir(slug)
  const { result } = await updatePool(slug, pool => {
    const trashed: string[] = []
    const archived: string[] = []
    for (const s of pool.songs) {
      if (!ids.includes(s.id) || s.status !== 'ready') continue
      if (s.episodes.length) { s.status = 'archived'; archived.push(s.id); continue }
      const file = path.join(dir, s.file)
      if (existsSync(file)) moveToTrashSync(file, path.join(trashRootFor(path.dirname(dir), path.dirname(dir), slug), MUSIC_LIBRARY_DIRNAME, s.file), 'music')
      s.status = 'rejected'
      delete s.file_missing
      trashed.push(s.id)
    }
    return { trashed, archived }
  })
  return result
}

/** Move one file of this pool (a rejected sung take) to Story's Trash (`<slug>/music-library/`); never deleted. */
export function trashPoolFile(slug: string, file: string): string {
  const dir = requireDir(slug)
  return moveToTrashSync(file, path.join(trashRootFor(path.dirname(dir), path.dirname(dir), slug), MUSIC_LIBRARY_DIRNAME, path.basename(file)), 'music')
}

export interface PoolSummary {
  pool_id: string
  name: string
  project_slug: string
  songs: number
  drawable: number
  total_s: number
}

export function summarize(pool: SongPoolFile): PoolSummary {
  const drawable = pool.songs.filter(isDrawable)
  return {
    pool_id: pool.pool_id,
    name: pool.name,
    project_slug: pool.project_slug,
    songs: pool.songs.filter(s => s.status === 'ready').length,
    drawable: drawable.length,
    total_s: Math.round(drawable.reduce((t, s) => t + (s.duration_s || 0), 0)),
  }
}

/** Every project that has a pool (a library.json or a music-library folder). */
export async function listPools(): Promise<PoolSummary[]> {
  const out: PoolSummary[] = []
  for (const p of await pm.listProjects()) {
    const dir = poolDir(p.slug)
    if (!dir || !existsSync(dir)) continue
    try { out.push(summarize(await readPool(p.slug))) } catch { /* an unreadable pool is skipped, not fatal for the list */ }
  }
  return out
}

export async function findPool(poolId: string): Promise<{ slug: string; pool: SongPoolFile } | null> {
  for (const p of await pm.listProjects()) {
    const dir = poolDir(p.slug)
    if (!dir || !existsSync(path.join(dir, POOL_FILENAME))) continue
    const pool = await readPool(p.slug).catch(() => null)
    if (pool?.pool_id === poolId) return { slug: p.slug, pool }
  }
  return null
}
