/**
 * Which recent episodes a scene is also compared against.
 *
 * Kept apart from the checks so the "how do I find a channel's recent
 * episodes?" question is answered in one place, and so the check itself never
 * has to guess at folder layouts.
 *
 * **Episode-aware by construction (§4).** Every scene here carries its OWN
 * episode code, and nothing from this episode is ever included in the pool it
 * is compared against. A result computed for episode A can only be shown while
 * episode A is open, because the caller asks for exactly that episode's feed.
 *
 * A channel that has fewer than two episodes, or none with images, yields an
 * empty list rather than an error: "there is nothing older to compare with" is
 * a legitimate answer, not a failure.
 */
import { getIdeas } from './idea-manager.js'
import { getProjectDir } from './project-manager.js'
import { readScenePlanForEpisode, resolveEpisodePathsByCode } from './local-screening-episode-reader.js'
import { resolveSceneImageReadPath } from '../generators/scene-image.js'
import { RECENT_EPISODE_WINDOW } from '../contracts/local-duplicate-screening.js'

export interface FeedScene {
  scene_id: string
  scene_index: number
  image_path: string | null
}

export interface RecentEpisodeFeed {
  episode_code: string
  title?: string
  scenes: FeedScene[]
}

/**
 * The channel's most recent other episodes that actually have scene images.
 *
 * Ordered newest-first using the episode's accepted date when there is one,
 * then its code — codes are zero-padded and sort correctly, so a channel whose
 * ideas were imported without dates still gets a sensible window.
 */
export async function resolveRecentEpisodeSceneScreens(
  slug: string,
  currentEpisodeCode: string,
  window = RECENT_EPISODE_WINDOW,
): Promise<RecentEpisodeFeed[]> {
  if (window <= 0) return []
  const current = currentEpisodeCode.toUpperCase()
  const ideas = await getIdeas(slug).catch(() => [])
  const candidates = (ideas || [])
    .filter(idea => idea?.episode_code && idea.episode_code.toUpperCase() !== current)
    .sort((left, right) => {
      const leftDate = left.accepted_at || left.generated_at || ''
      const rightDate = right.accepted_at || right.generated_at || ''
      if (leftDate !== rightDate) return rightDate.localeCompare(leftDate)
      return (right.episode_code || '').localeCompare(left.episode_code || '')
    })

  const feed: RecentEpisodeFeed[] = []
  for (const idea of candidates) {
    if (feed.length >= window) break
    const code = String(idea.episode_code).toUpperCase()
    const entry = await readOneEpisode(slug, code, idea.title).catch(() => null)
    // An episode with no images cannot be compared with anything, so it is
    // skipped rather than reported as a row of not-checked scenes.
    if (entry && entry.scenes.some(scene => scene.image_path)) feed.push(entry)
  }
  return feed
}

async function readOneEpisode(slug: string, code: string, title?: string): Promise<RecentEpisodeFeed> {
  if (!getProjectDir(slug)) throw new Error(`Unknown channel ${slug}`)
  const paths = await resolveEpisodePathsByCode(slug, code)
  const plan = await readScenePlanForEpisode(slug, code, paths.episode_dir)
  const scenes = await Promise.all(
    (plan?.scenes || []).map(async scene => ({
      scene_id: scene.id,
      scene_index: scene.scene_index,
      image_path: await resolveSceneImageReadPath(slug, code, paths.episode_dir, scene.id),
    })),
  )
  return { episode_code: code, title, scenes }
}
