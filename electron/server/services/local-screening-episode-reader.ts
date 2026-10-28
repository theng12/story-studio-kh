/**
 * Reading one episode's scenes, for duplicate screening.
 *
 * Both the per-episode check and the recent-episode feed need the same three
 * facts — the scene list, each scene's index, and the picture that actually
 * exists for it — and both must resolve them the way Scene Review does, or a
 * legacy `scene_images/` folder would silently screen nothing.
 *
 * Kept in its own module so neither caller grows a second copy of the layout
 * rules (§4: ownership and location are facts to look up, not strings to
 * guess).
 */
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'

import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { resolveSceneImageReadPath } from '../generators/scene-image.js'
import type { ScenePlan } from '../models/types.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'

export { resolveEpisodePathsByCode }

export interface EpisodeScene {
  scene_id: string
  scene_index: number
  image_path: string | null
}

/**
 * The episode's plan, or null when it has none yet.
 *
 * A missing `scene_plan.json` is an ordinary state for an episode that has just
 * been accepted, not an error — the caller reports `not_checked` with that
 * reason.
 */
export async function readScenePlanForEpisode(
  slug: string,
  code: string,
  episodeDir: string,
): Promise<ScenePlan | null> {
  const planPath = await resolveScenePlanPath(slug, code, episodeDir).catch(() => null)
  if (!planPath || !existsSync(planPath)) return null
  try {
    return JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  } catch {
    return null
  }
}

/** Every scene of this episode, with the path to its picture when one exists. */
export async function readEpisodeScenes(slug: string, code: string): Promise<EpisodeScene[]> {
  const paths = await resolveEpisodePathsByCode(slug, code)
  const plan = await readScenePlanForEpisode(slug, code, paths.episode_dir)
  if (!plan?.scenes?.length) return []
  return Promise.all(plan.scenes.map(async scene => ({
    scene_id: scene.id,
    scene_index: scene.scene_index,
    image_path: await resolveSceneImageReadPath(slug, code, paths.episode_dir, scene.id),
  })))
}

/** The scene-plan filename, re-exported so callers do not import the generator for one constant. */
export { SCENE_PLAN_FILENAME }
