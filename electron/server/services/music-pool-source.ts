/**
 * The Episode Builder's ONE door into song pools.
 *
 * The pool data model belongs to feat/music-pool (`_orchestra/.../music-format/INTERFACES.md`,
 * 2026-10-03 "data model v1": `{project}/music-library/library.json`, `services/song-pool.ts`).
 * This branch was built in parallel, so this file reads that documented file shape itself.
 *
 * ponytail: once feat/music-pool is merged, replace these bodies with `listPools`,
 * `readPool`, `isDrawable` and `recordEpisodeUse` from `services/song-pool.ts` (its
 * `updatePool` owns the per-pool lock) — nothing else in the builder touches a pool.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from './project-manager.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { BuilderSong, ChannelUse } from './music-episode.js'

const LIBRARY_DIRNAME = 'music-library'
const POOL_FILENAME = 'library.json'

/** INTERFACES.md B — the fields the builder reads. */
export interface EpisodeUse { code: string; project_slug: string; used_at: string }
export interface PoolSongRecord {
  id: string
  file: string
  status: 'ready' | 'rejected' | 'archived'
  enabled: boolean
  title: string
  ensemble?: string
  mood?: string
  energy?: number
  tempo_bpm?: number
  key?: string
  scene_idea?: string
  theme?: string
  tags?: string[]
  duration_s?: number
  lufs?: number
  rating?: number | null
  episodes?: EpisodeUse[]
}
interface PoolFile { pool_id: string; name: string; songs: PoolSongRecord[] }

export interface PoolSummary {
  pool_id: string
  name: string
  project_slug: string
  songs: number
  drawable: number
}

export interface ResolvedPoolSong extends BuilderSong {
  project_slug: string
  file: string
  path: string
  lufs?: number
  episodes: EpisodeUse[]
}

function poolFilePath(projectSlug: string): string | null {
  const dir = pm.getProjectDir(projectSlug)
  return dir ? path.join(dir, LIBRARY_DIRNAME, POOL_FILENAME) : null
}

async function readPoolFile(projectSlug: string): Promise<PoolFile | null> {
  const file = poolFilePath(projectSlug)
  if (!file || !existsSync(file)) return null
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  if (!raw || typeof raw.pool_id !== 'string' || !Array.isArray(raw.songs)) {
    throw new Error(`The song pool of ${projectSlug} is unreadable (${POOL_FILENAME} has no pool id or song list).`)
  }
  return { pool_id: raw.pool_id, name: typeof raw.name === 'string' ? raw.name : projectSlug, songs: raw.songs }
}

/** INTERFACES.md: drawable = ready && enabled && file exists && duration_s > 0. */
function drawable(song: PoolSongRecord, filePath: string): boolean {
  return song.status === 'ready' && song.enabled !== false && Number(song.duration_s) > 0 && existsSync(filePath)
}

function resolveSongs(projectSlug: string, pool: PoolFile): ResolvedPoolSong[] {
  const dir = path.dirname(poolFilePath(projectSlug)!)
  return pool.songs
    .filter(song => song && typeof song.id === 'string' && typeof song.file === 'string')
    .map(song => {
      const filePath = path.join(dir, path.basename(song.file))
      const episodes = Array.isArray(song.episodes) ? song.episodes.filter(use => use && typeof use.code === 'string') : []
      return {
        pool_id: pool.pool_id,
        id: song.id,
        project_slug: projectSlug,
        file: path.basename(song.file),
        path: filePath,
        title: song.title?.trim() || song.file.replace(/\.[a-z0-9]+$/i, ''),
        duration_s: Number(song.duration_s) > 0 ? Number(song.duration_s) : 0,
        drawable: drawable(song, filePath),
        rating: typeof song.rating === 'number' ? song.rating : null,
        mood: song.mood, energy: song.energy, tempo_bpm: song.tempo_bpm, key: song.key, ensemble: song.ensemble,
        scene_idea: song.scene_idea, theme: song.theme, tags: Array.isArray(song.tags) ? song.tags : [],
        ...(typeof song.lufs === 'number' && Number.isFinite(song.lufs) ? { lufs: song.lufs } : {}),
        plays: episodes.length,
        episodes,
      }
    })
}

/** Every project that has a song pool. */
export async function listSongPools(): Promise<PoolSummary[]> {
  const out: PoolSummary[] = []
  for (const project of await pm.listProjects()) {
    const pool = await readPoolFile(project.slug).catch(() => null)
    if (!pool) continue
    const songs = resolveSongs(project.slug, pool)
    out.push({
      pool_id: pool.pool_id,
      name: pool.name || project.name,
      project_slug: project.slug,
      songs: songs.length,
      drawable: songs.filter(song => song.drawable).length,
    })
  }
  return out
}

/**
 * The songs of the chosen pools. An empty choice means the channel's own pool.
 * A chosen pool that no longer exists is reported, never silently skipped.
 */
export async function readPoolsForEpisode(channelSlug: string, poolIds: readonly string[]): Promise<{
  pools: PoolSummary[]
  songs: ResolvedPoolSong[]
  missing_pools: string[]
}> {
  const all = await listSongPools()
  const own = all.find(pool => pool.project_slug === channelSlug)
  const wanted = poolIds.length ? poolIds : (own ? [own.pool_id] : [])
  const pools = wanted.map(id => all.find(pool => pool.pool_id === id)).filter((p): p is PoolSummary => !!p)
  const songs: ResolvedPoolSong[] = []
  for (const pool of pools) {
    const file = await readPoolFile(pool.project_slug)
    if (file) songs.push(...resolveSongs(pool.project_slug, file))
  }
  return { pools, songs, missing_pools: wanted.filter(id => !pools.some(pool => pool.pool_id === id)) }
}

/** This channel's rendered episodes across the given songs, for the no-repeat window. */
export function channelUses(songs: readonly ResolvedPoolSong[], channelSlug: string): ChannelUse[] {
  return songs.flatMap(song => song.episodes
    .filter(use => use.project_slug === channelSlug)
    .map(use => ({ code: use.code, at: use.used_at })))
}

/**
 * Record that a RENDERED episode used these songs (SPEC §3: plays mean heard).
 * Idempotent per (song, channel, episode).
 */
export async function recordEpisodeUse(poolProjectSlug: string, songIds: readonly string[], use: EpisodeUse): Promise<number> {
  const file = poolFilePath(poolProjectSlug)
  if (!file || !existsSync(file)) throw new Error(`Song pool of ${poolProjectSlug} is missing; plays were not recorded.`)
  const wanted = new Set(songIds)
  return withLock(file, async () => {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    let added = 0
    for (const song of Array.isArray(raw?.songs) ? raw.songs : []) {
      if (!wanted.has(song?.id)) continue
      song.episodes = Array.isArray(song.episodes) ? song.episodes : []
      if (song.episodes.some((e: EpisodeUse) => e.code === use.code && e.project_slug === use.project_slug)) continue
      song.episodes.push(use)
      added++
    }
    if (added) {
      raw.updated_at = new Date().toISOString()
      await writeJsonAtomic(file, raw)
    }
    return added
  })
}
