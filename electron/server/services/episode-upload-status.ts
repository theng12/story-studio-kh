import { youtubeRetentionEvidenceFor, type readYouTubeRetentionStores } from './youtube-remote-video.js'
import type { ProjectFactsCache } from './utils.js'
import type { Job } from '../models/types.js'
import type { YouTubeEpisodeUploadStatus } from '../contracts/youtube-upload-center.js'

/** Saved upload history, independent of media presence and generation completion. No remote calls. */
export async function readEpisodeUploadStatus(
  slug: string,
  code: string,
  title: string,
  stores: Awaited<ReturnType<typeof readYouTubeRetentionStores>>,
  cache?: ProjectFactsCache,
  job?: Job,
): Promise<YouTubeEpisodeUploadStatus> {
  // ponytail: O(episodes × records) on the shared project snapshot; index by episode if histories make reads slow.
  const evidence = await youtubeRetentionEvidenceFor(slug, code, title, stores.records, stores.state, cache)
  const identity = (videoId: string) => ({ video_id: videoId, url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` })
  const ready = evidence.ready_operations[0]
  if (ready) {
    const record = stores.records.find(item => item.operation_id === ready.operation_id)!
    const snapshot = record.remote_snapshot
    return {
      state: 'uploaded', source: 'operation_record', ...identity(ready.video_id!),
      ...(snapshot ? { visibility: snapshot.privacy_status, scheduled_for: snapshot.scheduled_for, checked_at: snapshot.fetched_at } : {}),
    }
  }
  const accepted = evidence.accepted_operations[0]
  if (accepted) {
    return {
      state: accepted.lifecycle === 'failed' || accepted.lifecycle === 'rejected' ? 'failed'
        : accepted.lifecycle === 'status_unavailable' ? 'unknown' : 'processing',
      source: 'operation_record', ...identity(accepted.video_id!),
    }
  }
  const linked = evidence.reconcile_link
  if (linked) {
    const publication = stores.state.episode_video_links[code]?.publication
    return {
      state: publication ? 'uploaded' : 'recorded', source: 'reconcile_link', ...identity(linked.video_id),
      ...(publication ? { visibility: publication.privacy_status, scheduled_for: publication.scheduled_for, checked_at: publication.verified_at }
        : { reason: 'Owner-linked YouTube identity; publication status has not been verified.' }),
    }
  }
  if (evidence.legacy_sidecar) {
    return {
      state: 'recorded', source: 'legacy_sidecar', ...identity(evidence.legacy_sidecar.video_id),
      reason: 'Historical YouTube record; current publication status has not been verified.',
    }
  }
  if (evidence.protected_reason === 'the historical upload receipt is unreadable') {
    return { state: 'unknown', reason: evidence.protected_reason }
  }
  if (job?.status === 'queued' || job?.status === 'paused') return { state: 'queued' }
  if (job?.status === 'running') return { state: 'uploading' }
  if (job?.status === 'error' || job?.status === 'cancelled') return { state: 'failed', reason: job.error || 'Upload did not complete.' }
  const unfinished = stores.records.find(item => item.episode_code === code && !item.video_id)
  if (unfinished) return { state: unfinished.lifecycle === 'failed' || unfinished.lifecycle === 'rejected' ? 'failed'
    : unfinished.lifecycle === 'status_unavailable' ? 'unknown' : 'uploading' }
  // A terminal queue flag alone never proves that YouTube accepted a video.
  return { state: 'pending' }
}
