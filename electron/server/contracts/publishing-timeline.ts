import type { PublishingTimelineEpisode } from './publishing-overview.js'

export interface TimelineArtifacts {
  script?: boolean
  scene_plan?: boolean
  scene_review?: boolean
  images?: boolean
  _unreliable?: boolean
  _scene_images?: { present: number; total: number }
}

/** Production Board artifact facts; queue completion is never an artifact. */
export function timelineArtifactProgress(assets?: TimelineArtifacts): Pick<PublishingTimelineEpisode, 'stage' | 'state' | 'detail'> {
  if (!assets || assets._unreliable) return {
    stage: 'not_checked', state: 'not_checked',
    detail: assets ? 'Episode artifacts could not be read reliably. Open the Production Board to check them.' : 'Episode artifacts have not been checked yet.',
  }
  if (assets.scene_review || assets.images) return {
    stage: 'images', state: 'waiting', detail: 'Scene images are complete; no admissible final video found.',
  }
  if (assets.scene_plan || (assets._scene_images?.present || 0) > 0) return {
    stage: 'images', state: 'waiting', detail: assets._scene_images
      ? `${assets._scene_images.present} of ${assets._scene_images.total} scene images available; scene images are incomplete.`
      : 'Scene Plan is complete; scene images are still pending.',
  }
  if (assets.script) return { stage: 'writing', state: 'waiting', detail: 'Writing is complete; later required work is still pending.' }
  return { stage: 'idea', state: 'waiting', detail: 'Accepted idea. No completed writing or images found.' }
}
