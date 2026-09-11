import { existsSync } from 'fs'
import fs from 'fs/promises'
import * as pm from './project-manager.js'
import * as bp from './broll-pool-manager.js'
import * as im from './idea-manager.js'
import { selectBroll } from '../lib/broll-selector.js'
import { saveSelectionSidecar } from './broll-selection-sidecar.js'
import { resolveEpisodePaths } from './utils.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { readVideoVisualSource } from './video-visual-source.js'
import type { BrollUsageEntry } from '../models/types.js'

export interface BrollSelectionParams {
  pool_id?: string
  selection_mode?: 'random' | 'tagged' | 'themed'
  tags?: string[]
  pacing_mode?: 'timed' | 'rotate'
  segment_seconds?: number
  broll_lookback?: number
  broll_volume?: number
  motion_mode?: 'fixed' | 'rotate' | 'random'
  motion_default?: string
  motion_pool?: string[]
  transition_id?: string
  transition_duration?: number
}

async function titleFor(slug: string, episodeId: string): Promise<string> {
  const ideas = await im.getIdeas(slug, 'accepted')
  return ideas.find(idea => idea.episode_code === episodeId)?.title || ''
}

async function narrationDuration(slug: string, episodeId: string, title: string): Promise<number> {
  const paths = await resolveEpisodePaths(slug, episodeId, title)
  const candidates: string[] = []
  for (const dir of [paths.merged_audio_dir, paths.audio_dir]) {
    if (!existsSync(dir)) continue
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (/\.(mp3|wav|m4a)$/i.test(name) && !name.startsWith('.tmp_')) candidates.push(`${dir}/${name}`)
    }
    if (candidates.length) break
  }
  let longest = 0
  for (const candidate of candidates) longest = Math.max(longest, await getAudioDuration(candidate) || 0)
  return longest
}

export async function pickBrollForEpisode(slug: string, episodeId: string, params: BrollSelectionParams): Promise<{ count: number; warnings: string[]; title: string }> {
  if ((await readVideoVisualSource(slug, episodeId)).source === 'image_pool') {
    throw new Error('B-Roll selection is not used for Image Pool episodes. Keep the saved Image Pool picks or switch this episode to Scene Plan first.')
  }
  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Project config not found')
  const poolId = params.pool_id || (config as any).broll_pool_id
  if (!poolId) throw new Error('No B-Roll pool subscribed. Choose one on the B-Roll page first.')
  const pool = await bp.getPool(poolId)
  if (!pool) throw new Error(`B-Roll pool '${poolId}' not found`)
  if (!existsSync(pool.folder_path)) throw new Error(`B-Roll pool is offline. Connect ${pool.folder_path} and retry.`)

  const title = await titleFor(slug, episodeId)
  const duration = await narrationDuration(slug, episodeId, title)
  if (!duration) throw new Error(`No narration audio found for ${episodeId}.`)
  const clips = await bp.listClips(poolId, { includeMissing: false })
  const lookback = typeof params.broll_lookback === 'number' ? params.broll_lookback : ((config as any).broll_lookback ?? 10)
  const usage: BrollUsageEntry[] = Array.isArray((config as any).broll_usage_log) ? (config as any).broll_usage_log : []
  const excluded = lookback > 0 ? Array.from(new Set(usage.slice(-lookback).map(entry => entry.clip_sha))) : []
  const result = selectBroll({
    pool: clips.map(clip => ({ filename: clip.filename, duration: clip.duration, sha256: clip.sha256, tags: clip.tags || [], normalized: clip.normalized, missing: clip.missing })),
    target_duration: duration,
    selection_mode: params.selection_mode || 'random',
    tags: params.tags || [],
    pacing_mode: params.pacing_mode || 'rotate',
    segment_seconds: params.segment_seconds || 8,
    exclude_shas: excluded,
  })
  if (!result.selection.length) throw new Error('No eligible clips matched this B-Roll preset and repeat-avoidance window.')

  const validMotions = new Set(['static', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'])
  const safeMotion = (value: unknown) => typeof value === 'string' && validMotions.has(value) ? value : 'static'
  const motionPool = (params.motion_pool || ['static']).map(safeMotion)
  await saveSelectionSidecar(slug, episodeId, title, {
    schema_version: 1, episode_code: episodeId, pool_id: poolId,
    selection_mode: params.selection_mode || 'random', pacing_mode: params.pacing_mode || 'rotate',
    segment_seconds: params.segment_seconds || 8, tags: params.tags || [], broll_volume: params.broll_volume || 0,
    selection: result.selection, target_duration: duration, generated_at: new Date().toISOString(), warnings: result.warnings,
    motion_mode: params.motion_mode || 'fixed', motion_default: safeMotion(params.motion_default),
    motion_pool: motionPool.length ? motionPool : ['static'], transition_id: params.transition_id || 'none',
    transition_duration: Math.max(0.1, Math.min(2, params.transition_duration || 0.5)),
  })
  return { count: result.selection.length, warnings: result.warnings, title }
}
