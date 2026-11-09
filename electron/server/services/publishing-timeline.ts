import type { PublishingTimelineEpisode } from '../contracts/publishing-overview.js'
import { timelineArtifactProgress, type TimelineArtifacts } from '../contracts/publishing-timeline.js'
import type { Job } from '../models/types.js'
import type { ObservedPublication } from './youtube-publication-cache.js'
import { PUBLICATION_CACHE_TTL_MS } from './youtube-publication-cache.js'
import { statusFieldForJob } from '../contracts/episode-step-jobs.js'

type Stage = PublishingTimelineEpisode['stage']

function jobStage(job: Job): Stage {
  const field = statusFieldForJob(job)
  if (field === 'video_assembly' || field === 'music_episode') return 'render'
  if (['scene_plan', 'scene_review', 'motion_review', 'thumbnails'].includes(field || '')) return 'images'
  return 'writing'
}

/** Files prove completion; job rows supply only current work, pauses and failures. */
export function projectTimelineEpisode(input: {
  id: string; code: string; title: string; slug: string; now: number
  plannedAt?: string; uploadJob?: Job; stepJob?: Job
  remoteVideoId?: string; otherChannel?: boolean
  observation?: ObservedPublication; assets?: TimelineArtifacts; final?: boolean
  error?: string
}): PublishingTimelineEpisode {
  const { observation: observed, uploadJob, stepJob } = input
  const checked = observed?.checked_at || null
  const fresh = checked && Number.isFinite(Date.parse(checked))
    ? (input.now - Date.parse(checked) <= PUBLICATION_CACHE_TTL_MS ? 'fresh' : 'stale')
    : 'unknown'
  const result: PublishingTimelineEpisode = {
    id: input.id,
    episode_code: input.code, title: input.title,
    upload_start_at: uploadJob?.started_at || null,
    public_release_at: input.plannedAt || null,
    date_source: input.plannedAt ? 'planned' : 'none',
    stage: 'idea', state: 'waiting',
    detail: 'Accepted idea. No completed writing or images found.',
    url: `/projects/${encodeURIComponent(input.slug)}/board`,
    publication_checked_at: checked, publication_freshness: fresh,
  }
  if (input.error || input.assets?._unreliable) {
    result.stage = 'not_checked'; result.state = 'not_checked'
    result.detail = input.error || 'Episode artifacts could not be read reliably. Open the Production Board to check them.'
    return result
  }
  if (input.code || input.assets) Object.assign(result, timelineArtifactProgress(input.assets))
  if (input.final) {
    result.stage = 'final'; result.state = 'complete'; result.detail = 'A verified, admissible final video is available.'
  }
  const working = stepJob && ['queued', 'running', 'paused', 'error'].includes(stepJob.status) ? stepJob : undefined
  if (working) {
    result.stage = jobStage(working)
    result.state = working.status === 'error' ? 'failed' : working.status === 'paused' ? 'paused' : working.status === 'queued' ? 'waiting' : 'active'
    result.detail = working.error?.split('\n')[0] || `${working.title || working.type}: ${working.status}.`
  }
  if (uploadJob && ['queued', 'running', 'paused', 'error', 'cancelled'].includes(uploadJob.status)) {
    result.stage = input.final ? 'final' : result.stage
    result.state = ['error', 'cancelled'].includes(uploadJob.status) ? 'failed' : uploadJob.status === 'paused' ? 'paused' : uploadJob.status === 'queued' ? 'waiting' : 'active'
    result.detail = uploadJob.error?.split('\n')[0] || `Upload ${uploadJob.status}. Upload start is shown only when the queue records an actual start.`
  }
  if (input.remoteVideoId) {
    result.stage = 'uploaded'; result.state = 'complete'
    result.detail = input.otherChannel
      ? 'Uploaded to another YouTube channel. Current-channel publication is not checked.'
      : 'YouTube video identity recorded. Public visibility is not checked.'
    // A previous local release target is not a future release for an uploaded video.
    result.public_release_at = null; result.date_source = 'none'
  }
  if (observed && !input.otherChannel) {
    if (['not_found', 'failed', 'rejected'].includes(observed.upload_status || '')) {
      result.stage = 'uploaded'; result.state = observed.upload_status === 'not_found' ? 'not_checked' : 'failed'
      result.detail = `YouTube last reported ${observed.upload_status}. Open Upload Center to check this video.`
      return result
    }
    // A listing's published_at is not proof of public visibility. Only a checked
    // observation may confirm a release or mark the video public.
    if (checked && (observed.privacy_status === 'public' || observed.scheduled_for)) {
      result.public_release_at = observed.privacy_status === 'public' ? observed.published_at || null : observed.scheduled_for || null
      result.date_source = result.public_release_at ? 'confirmed' : 'none'
      result.stage = observed.privacy_status === 'public' ? 'public' : 'scheduled'
      result.state = fresh === 'fresh' ? 'complete' : 'not_checked'
      result.detail = `${observed.privacy_status === 'public' ? 'Public' : 'Scheduled'} at the last YouTube check.${fresh === 'fresh' ? '' : ' This observation is stale; current visibility is not checked.'}${observed.privacy_status === 'public' && !observed.published_at ? ' Public release date was not returned.' : ''}`
    }
  }
  return result
}
