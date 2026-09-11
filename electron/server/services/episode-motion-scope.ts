import fs from 'fs/promises'
import path from 'path'
import { normalizeMotionScope, resolveMotionScope, type MotionScope } from '../contracts/motion-scope.js'
import { resolveEpisodePathsByCode } from './utils.js'

export interface EpisodeMotionScope {
  motion_scope: MotionScope
  motion_level: number
}

function motionLevel(value: unknown): number {
  if (value === undefined) return 2
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error('motion_level must be a whole number from 1 to 4')
  }
  return value
}

/** Read only the two motion controls; missing continuity state never authorizes motion. */
export async function readEpisodeMotionScope(
  slug: string,
  episodeId: string,
  episodeDir?: string,
): Promise<EpisodeMotionScope> {
  const dir = episodeDir || (await resolveEpisodePathsByCode(slug, episodeId)).episode_dir
  let raw: string
  try {
    raw = await fs.readFile(path.join(dir, 'continuity.json'), 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { motion_scope: { mode: 'off' }, motion_level: 2 }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error: any) {
    throw new Error(`continuity.json motion settings are malformed: ${error?.message || error}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('continuity.json motion settings are malformed.')
  }
  const config = value as Record<string, unknown>
  return {
    motion_scope: normalizeMotionScope(config.motion_scope),
    motion_level: motionLevel(config.motion_level),
  }
}

export async function resolveEpisodeMotionSceneIds(
  slug: string,
  episodeId: string,
  scenes: readonly { id: string; start_sec: number; end_sec: number }[],
  episodeDir?: string,
): Promise<EpisodeMotionScope & { scene_ids: string[]; crossing_scene_ids: string[] }> {
  const settings = await readEpisodeMotionScope(slug, episodeId, episodeDir)
  return { ...settings, ...resolveMotionScope(scenes, settings.motion_scope) }
}
