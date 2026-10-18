/**
 * The ONE answer to "what is this episode's local upload doing right now?".
 *
 * Lifted verbatim out of `routes/youtube-upload-center.ts` so the Publish page
 * and the Publishing Overview cannot answer it differently. The overview needs
 * the same notion for a different reason: an episode whose upload is queued,
 * paused or running must count as IN PROGRESS, not as ready to publish — and a
 * second copy of this ladder is exactly how the two screens drift apart.
 *
 * The states are the product's own vocabulary, not this module's invention:
 * `queued` covers a paused job (the owner stopped it; the queue still holds it),
 * `running` is the transfer in flight, and the operation-record branches cover
 * an upload whose queue row is already gone.
 */

import type { Job } from '../models/types.js'
import type { YouTubeLocalUploadProjection } from '../contracts/youtube-upload-center.js'
import type { YouTubeOperationRecordV1 } from './youtube-operation-record-reader.js'
import type { RemoteVideo } from './youtube-remote-video.js'

export const UPLOAD_STORE_UNREADABLE = 'Story Studio cannot read the local upload records.'

/** The episode's latest upload job for this channel, or undefined. */
export function latestEpisodeUploadJob(jobs: Job[], episodeCode: string, channelId: string | null): Job | undefined {
  return jobs
    .filter(job => job.type === 'youtube_upload'
      && job.episode_id === episodeCode
      && job.params?.expected_channel_id === channelId)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .at(-1)
}

export function uploadTransferProjection(job: Job): Pick<YouTubeLocalUploadProjection, 'progress' | 'bytes_done' | 'bytes_total' | 'speed_bps' | 'eta_seconds'> {
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const progress = finite(job.progress)
  const bytes_done = finite(job.bytes_done)
  const bytes_total = finite(job.bytes_total)
  const speed_bps = finite(job.speed_bps)
  const eta_seconds = finite(job.eta_seconds)
  return {
    ...(progress !== undefined ? { progress } : {}),
    ...(bytes_done !== undefined ? { bytes_done } : {}),
    ...(bytes_total !== undefined ? { bytes_total } : {}),
    ...(speed_bps !== undefined ? { speed_bps } : {}),
    ...(eta_seconds !== undefined ? { eta_seconds } : {}),
  }
}

export function localUploadProjection(
  job: Job | undefined,
  operation: YouTubeOperationRecordV1 | undefined,
  operationsUnreadable: boolean,
  remote: RemoteVideo | null,
): YouTubeLocalUploadProjection {
  if (job?.status === 'queued') return { state: 'queued', job_id: job.job_id, ...uploadTransferProjection(job) }
  if (job?.status === 'paused') {
    return { state: 'queued', job_id: job.job_id, ...uploadTransferProjection(job), reason: 'Upload job is paused.' }
  }
  if (job?.status === 'running') return { state: 'running', job_id: job.job_id, ...uploadTransferProjection(job) }
  if (operationsUnreadable) return { state: 'unknown', reason: UPLOAD_STORE_UNREADABLE }
  // A current-channel video identity proves that an upload completed even if
  // a later local retry failed or its terminal queue record is stale.
  if (remote) return { state: 'succeeded' }
  if (job) {
    if (job.status === 'error' || job.status === 'cancelled') {
      return {
        state: 'failed', job_id: job.job_id,
        reason: job.error || (job.status === 'cancelled' ? 'Upload was cancelled.' : 'Upload failed.'),
      }
    }
    return { state: 'succeeded', job_id: job.job_id }
  }
  if (!operation) return { state: 'none' }
  if (operation.lifecycle === 'preparing' || operation.lifecycle === 'uploading') return { state: 'running' }
  if (operation.video_id) return { state: 'succeeded' }
  if (operation.lifecycle === 'failed' || operation.lifecycle === 'rejected') {
    return {
      state: 'failed',
      reason: operation.processing?.failure_reason
        || operation.processing?.rejection_reason
        || 'Upload failed before YouTube accepted it.',
    }
  }
  return { state: 'unknown', reason: UPLOAD_STORE_UNREADABLE }
}

/** An upload is under way — the two states above, named once. */
export function uploadInFlight(state: YouTubeLocalUploadProjection['state']): boolean {
  return state === 'queued' || state === 'running'
}
