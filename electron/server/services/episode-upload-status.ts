import { youtubeRetentionEvidenceFor, type readYouTubeRetentionStores } from './youtube-remote-video.js'
import {
  YOUTUBE_VIDEO_NOT_FOUND,
  cachedObservation,
  newestObservation,
  receiptObservation,
  snapshotObservation,
  type ObservedPublication,
  type PublicationCache,
} from './youtube-publication-cache.js'
import type { ProjectFactsCache } from './utils.js'
import type { Job } from '../models/types.js'
import type { YouTubeEpisodeUploadStatus } from '../contracts/youtube-upload-center.js'

/** What YouTube said, as the saved-status fields. Never a sidecar's local `scheduled_for`. */
function observedFields(observed: ObservedPublication): Pick<YouTubeEpisodeUploadStatus, 'visibility' | 'scheduled_for' | 'checked_at'> {
  return {
    ...(observed.privacy_status ? { visibility: observed.privacy_status } : {}),
    ...(observed.scheduled_for !== undefined ? { scheduled_for: observed.scheduled_for } : {}),
    ...(observed.checked_at ? { checked_at: observed.checked_at } : {}),
  }
}

/**
 * Saved upload history, independent of media presence and generation completion. No remote calls.
 * `publications` is the project's publication cache and assigned channel; the channel is used only
 * for a legacy receipt that names none.
 */
export async function readEpisodeUploadStatus(
  slug: string,
  code: string,
  title: string,
  stores: Awaited<ReturnType<typeof readYouTubeRetentionStores>>,
  cache?: ProjectFactsCache,
  job?: Job,
  publications?: { channel_id: string | null; cache: PublicationCache },
): Promise<YouTubeEpisodeUploadStatus> {
  const cached = publications?.cache
  // ponytail: O(episodes × records) on the shared project snapshot; index by episode if histories make reads slow.
  const evidence = await youtubeRetentionEvidenceFor(slug, code, title, stores.records, stores.state, cache)
  const identity = (videoId: string) => ({ video_id: videoId, url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` })
  const ready = evidence.ready_operations[0]
  if (ready) {
    const record = stores.records.find(item => item.operation_id === ready.operation_id)!
    const observed = newestObservation(snapshotObservation(record), cachedObservation(cached, record.channel_id, ready.video_id))
    return {
      state: 'uploaded', source: 'operation_record', ...identity(ready.video_id!),
      ...(observed ? observedFields(observed) : {}),
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
  // Reconciled and legacy uploads: verified only when YouTube itself answered
  // about this exact video on this channel.
  const fromObservation = (source: 'reconcile_link' | 'legacy_sidecar', videoId: string, observed: ObservedPublication | undefined, unverified: string): YouTubeEpisodeUploadStatus => {
    if (observed?.upload_status === YOUTUBE_VIDEO_NOT_FOUND) {
      return { state: 'unknown', source, ...identity(videoId), ...observedFields(observed), reason: 'YouTube did not return this video at the last check.' }
    }
    if (observed?.privacy_status) return { state: 'uploaded', source, ...identity(videoId), ...observedFields(observed) }
    return { state: 'recorded', source, ...identity(videoId), reason: unverified }
  }
  const linked = evidence.reconcile_link
  if (linked) {
    const link = stores.state.episode_video_links[code]
    const observed = newestObservation(
      link?.video_id === linked.video_id ? receiptObservation(code, link) : undefined,
      cachedObservation(cached, linked.channel_id, linked.video_id),
    )
    return fromObservation('reconcile_link', linked.video_id, observed, 'Owner-linked YouTube identity; publication status has not been verified.')
  }
  if (evidence.legacy_sidecar) {
    const legacy = evidence.legacy_sidecar
    return fromObservation('legacy_sidecar', legacy.video_id, cachedObservation(cached, legacy.channel_id ?? publications?.channel_id, legacy.video_id),
      'Historical YouTube record; current publication status has not been verified.')
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
