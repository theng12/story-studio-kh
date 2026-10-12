/**
 * The Episode Builder's ONE door into song pools (`services/song-pool.ts`, feat/music-pool).
 *
 * Maps the pool's song records to what the builder's pure decisions need, and keeps the
 * builder's own window rule: this channel's RENDERED uses come from the pools here, its
 * drafted-but-not-rendered episodes from `music-episode-store.ts`.
 */

import path from 'path'
import * as songPool from './song-pool.js'
import type { BuilderSong, ChannelUse } from './music-episode.js'

export type EpisodeUse = songPool.EpisodeUse
export type PoolSummary = songPool.PoolSummary

export interface ResolvedPoolSong extends BuilderSong {
  project_slug: string
  file: string
  path: string
  lufs?: number
  episodes: EpisodeUse[]
  /** Ids of duplicate entries folded into this song (song-pool.ts `mergeDuplicateFiles`). */
  merged_ids?: string[]
  /** Songs with lyrics: the sung words. */
  lyrics?: string
}

function resolveSongs(projectSlug: string, pool: songPool.SongPoolFile): ResolvedPoolSong[] {
  const dir = songPool.poolDir(projectSlug)!
  return pool.songs.map(song => ({
    pool_id: pool.pool_id,
    id: song.id,
    project_slug: projectSlug,
    file: song.file,
    path: path.join(dir, path.basename(song.file)),
    title: song.title?.trim() || song.file,
    duration_s: Number(song.duration_s) > 0 ? Number(song.duration_s) : 0,
    drawable: songPool.isDrawable(song),
    rating: song.rating,
    mood: song.mood, energy: song.energy, tempo_bpm: song.tempo_bpm, key: song.key, ensemble: song.ensemble,
    scene_idea: song.scene_idea, theme: song.theme, tags: song.tags || [],
    ...(typeof song.lufs === 'number' && Number.isFinite(song.lufs) ? { lufs: song.lufs } : {}),
    plays: song.episodes.length,
    episodes: song.episodes,
    ...(song.merged_ids?.length ? { merged_ids: song.merged_ids } : {}),
    ...(song.lyrics ? { lyrics: song.lyrics } : {}),
  }))
}

/** Every project that has a song pool. */
export function listSongPools(): Promise<PoolSummary[]> {
  return songPool.listPools()
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
  const all = await songPool.listPools()
  const own = all.find(pool => pool.project_slug === channelSlug)
  const wanted = poolIds.length ? poolIds : (own ? [own.pool_id] : [])
  const pools = wanted.map(id => all.find(pool => pool.pool_id === id)).filter((p): p is PoolSummary => !!p)
  const songs: ResolvedPoolSong[] = []
  for (const pool of pools) songs.push(...resolveSongs(pool.project_slug, await songPool.readPool(pool.project_slug)))
  return { pools, songs, missing_pools: wanted.filter(id => !pools.some(pool => pool.pool_id === id)) }
}

/** This channel's rendered episodes across the given songs, for the no-repeat window. */
export function channelUses(songs: readonly ResolvedPoolSong[], channelSlug: string): ChannelUse[] {
  return songs.flatMap(song => song.episodes
    .filter(use => use.project_slug === channelSlug)
    .map(use => ({ code: use.code, at: use.used_at })))
}

/** Record that a RENDERED episode used these songs (SPEC §3: plays mean heard). Idempotent. */
export function recordEpisodeUse(poolProjectSlug: string, songIds: readonly string[], use: EpisodeUse): Promise<void> {
  return songPool.recordEpisodeUse(poolProjectSlug, [...songIds], use)
}
