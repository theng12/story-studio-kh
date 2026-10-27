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

/**
 * Read only the two motion controls; missing continuity state never authorizes motion.
 *
 * Owner, 2026-10-27 — the 25% / opening-hook share is the default VALUE of the control,
 * not an episode's answer. An episode that never saved a scope is OFF, exactly as it was
 * before the default was introduced: nothing is in its motion scope, Motion Review is not
 * required for its completion, and Pipeline makes no clips for it. A scope the customer
 * saved always wins, and the channel is never read for a default — the value is read at
 * use time by the control (`DEFAULT_MOTION_SCOPE`), never stored anywhere.
 */
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
    motion_scope: config.motion_scope === undefined
      ? { mode: 'off' }
      : normalizeMotionScope(config.motion_scope),
    motion_level: motionLevel(config.motion_level),
  }
}

export async function resolveEpisodeMotionSceneIds(
  slug: string,
  episodeId: string,
  scenes: readonly {
    id: string; start_sec: number; end_sec: number
    key_moment?: boolean
    key_moment_suggested?: boolean
    /** A text-to-video scene is planned per scene, never covered by the share. */
    visual_lane?: string
  }[],
  episodeDir?: string,
): Promise<EpisodeMotionScope & { scene_ids: string[]; crossing_scene_ids: string[] }> {
  const settings = await readEpisodeMotionScope(slug, episodeId, episodeDir)
  const resolved = resolveMotionScope(scenes, settings.motion_scope)
  // Owner, 2026-10-26/27 — a text-to-video scene has no still: its video IS the request, and it
  // is approved in Motion Review (never Scene Review). That is an explicit per-scene plan, not
  // the episode's default share, so it is always in this episode's motion scope — including
  // when the episode saved no scope and is Off. Without this the requirement could never be
  // met: readiness would demand the clip while every generation path refused it as out of scope.
  const textToVideo = new Set(scenes
    .filter(scene => scene.visual_lane === 'text_to_video')
    .map(scene => scene.id))
  if (!textToVideo.size) return { ...settings, ...resolved }
  const inScope = new Set([...resolved.scene_ids, ...textToVideo])
  return {
    ...settings,
    // Scene order, so the page lists them the way the plan does.
    scene_ids: scenes.filter(scene => inScope.has(scene.id)).map(scene => scene.id),
    crossing_scene_ids: resolved.crossing_scene_ids,
  }
}
