import type { PublishingOverviewChannel } from '../../electron/server/contracts/publishing-overview'
import { timelineArtifactProgress, type TimelineArtifacts } from '../../electron/server/contracts/publishing-timeline'

interface EpisodeRow {
  episode_code: string
  status?: TimelineArtifacts
  scene_images?: { present: number; total: number }
  episode_error?: string
}

/** Reuse the cached Production Board read without holding up the global overview. */
export async function loadPublishingTimelineStages(
  channels: PublishingOverviewChannel[],
  getRows: (path: string) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<void> {
  const pending = channels.filter(channel => channel.timeline?.episodes.some(episode => episode.stage === 'not_checked'))
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
    while (isCurrent() && cursor < pending.length) {
      const channel = pending[cursor++]!
      const episodes = channel.timeline!.episodes.filter(episode => episode.stage === 'not_checked')
      try {
        const response = await getRows(`/projects/${encodeURIComponent(channel.slug)}/episodes`)
        if (!Array.isArray(response)) throw new Error('Invalid episode list')
        if (!isCurrent()) return
        const rows = new Map((response as EpisodeRow[]).map(row => [row.episode_code, row]))
        for (const episode of episodes) {
          const row = rows.get(episode.episode_code)
          if (!row?.status || typeof row.status.script !== 'boolean' || row.episode_error) {
            episode.detail = row?.episode_error || 'Production Board did not return this episode’s artifact status. Not checked.'
          } else Object.assign(episode, timelineArtifactProgress({ ...row.status, _scene_images: row.scene_images }))
        }
      } catch {
        if (!isCurrent()) return
        for (const episode of episodes) episode.detail = 'Production Board artifacts could not be loaded. Reopen Calendar to retry; status is not checked.'
      }
    }
  }))
}
