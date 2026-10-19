/**
 * What YouTube says happened to a video, turned into Story Studio's states.
 *
 * Nothing in the app read this before: the existing reads ask only for
 * privacy and schedule, so a video YouTube REJECTED looked exactly like one
 * still processing, forever.
 *
 * The mapping is a pure function so every outcome — including the ones that
 * are awkward to reach against a real API — is directly testable.
 */

import type { YouTubeVideoLifecycle } from '../contracts/youtube-upload-center.js'
import type { VideoPublicationDetails } from '../lib/youtube-client.js'
import { listRecentUploads, listVideoPublicationDetails, registryCredentialFor } from '../lib/youtube-client.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { logLine } from './logger.js'
import {
  listYouTubeOperations,
  readYouTubeOperation,
  updatePinnedYouTubeOperation,
} from './youtube-operation-store.js'
import type { RemoteSyncState } from './youtube-project-publishing-store.js'
import {
  YOUTUBE_VIDEO_NOT_FOUND,
  classifyYouTubeSyncFailure,
  observationFromDetails,
  recordYouTubePublicationObservations,
} from './youtube-publication-cache.js'

/** Lifecycles that are YouTube's final word. Never overwritten by an absence. */
const TERMINAL: ReadonlySet<YouTubeVideoLifecycle> = new Set(['ready', 'failed', 'rejected'])

export interface YouTubePublicationState {
  lifecycle: Extract<YouTubeVideoLifecycle, 'processing' | 'ready' | 'failed' | 'rejected' | 'status_unavailable'>
  processing: {
    checked_at: string
    provider_status?: string
    failure_reason?: string
    rejection_reason?: string
  }
  snapshot?: {
    fetched_at: string
    title: string
    description: string
    tags: string[]
    privacy_status: string
    scheduled_for: string | null
    thumbnail_etag?: string
  }
}

/** `provider_status` written when YouTube answered and the video was not in the answer. */
export { YOUTUBE_VIDEO_NOT_FOUND }

/**
 * YouTube itself confirmed the video is gone: it answered about this video and
 * called it `deleted`.
 *
 * A bare `not_found` is NOT this. An empty `items` array is also exactly what a
 * token that cannot see the video returns — a sign-in for another Google
 * account, a brand channel it does not administer, or a momentary miss — so it
 * is recorded as `unverified`, and only a word YouTube says ABOUT the video
 * (deleted, or a rejected upload) may be reported as a removal. "We could not
 * reach YouTube" never gets here either: a failed request writes nothing.
 */
export function isConfirmedGoneFromYouTube(record: { lifecycle: string; processing?: { provider_status?: string } }): boolean {
  return record.lifecycle === 'status_unavailable'
    && record.processing?.provider_status === 'deleted'
}

/**
 * `details === null` means YouTube answered the owner's request and the video
 * was not in it: the channel owner sees every one of their videos, private or
 * processing, so that is "not found", recorded as `provider_status:
 * not_found`. It is still `status_unavailable`, which the persist step refuses
 * to write over a terminal answer. A request that FAILED never reaches this
 * function — callers write nothing for it ("couldn't check").
 */
export function mapYouTubePublicationState(
  details: VideoPublicationDetails | null,
  checked_at: string = new Date().toISOString(),
): YouTubePublicationState {
  if (!details) {
    return { lifecycle: 'status_unavailable', processing: { checked_at, provider_status: YOUTUBE_VIDEO_NOT_FOUND } }
  }

  const provider_status = details.uploadStatus
  const base = { checked_at, ...(provider_status ? { provider_status } : {}) }

  // Only claim a snapshot when YouTube actually told us the video's privacy.
  //
  // It legitimately omits fields — a rejected video's status block often
  // carries only the rejection. Defaulting to '' invented a privacy setting
  // nobody reported, the operation store correctly refused the record as
  // invalid, and the whole update was dropped: the rejection itself never got
  // written. Better no snapshot than a fabricated one.
  const snapshot = typeof details.privacyStatus === 'string' && details.privacyStatus
    ? {
        fetched_at: checked_at,
        title: details.title ?? '',
        description: details.description ?? '',
        tags: details.tags ?? [],
        privacy_status: details.privacyStatus,
        scheduled_for: details.publishAt ?? null,
        ...(details.thumbnailEtag ? { thumbnail_etag: details.thumbnailEtag } : {}),
      }
    : undefined

  switch (provider_status) {
    case 'processed':
      return { lifecycle: 'ready', processing: base, ...(snapshot ? { snapshot } : {}) }
    case 'failed':
      return {
        lifecycle: 'failed',
        processing: { ...base, ...(details.failureReason ? { failure_reason: details.failureReason } : {}) },
        ...(snapshot ? { snapshot } : {}),
      }
    case 'rejected':
      return {
        lifecycle: 'rejected',
        processing: { ...base, ...(details.rejectionReason ? { rejection_reason: details.rejectionReason } : {}) },
        ...(snapshot ? { snapshot } : {}),
      }
    case 'uploaded':
      return { lifecycle: 'processing', processing: base, ...(snapshot ? { snapshot } : {}) }
    default:
      // A status YouTube has but this build does not recognise is NOT a
      // failure and NOT "ready". Report it as unknown and keep the raw word.
      return { lifecycle: 'status_unavailable', processing: base, ...(snapshot ? { snapshot } : {}) }
  }
}

/**
 * Every operation answer also lands in the channel's publication cache, so all
 * readers see one observed status. Logged, never fatal: the record is the receipt.
 */
async function observeOperations(
  slug: string,
  channelId: string,
  records: Array<{ video_id?: string; episode_code: string }>,
  details: Record<string, VideoPublicationDetails>,
): Promise<void> {
  const checkedAt = new Date().toISOString()
  const checks = records
    .filter(record => !!record.video_id
      && (!details[record.video_id]?.channelId || details[record.video_id]!.channelId === channelId))
    .map(record => observationFromDetails(record.video_id!, details[record.video_id!] ?? null, checkedAt, 'operation', record.episode_code))
  await recordYouTubePublicationObservations({ project_slug: slug, channel_id: channelId, checks }).catch((error) => {
    logLine('warn', `[youtube-status] publication cache not written: ${(error as Error)?.message || 'unknown'}`, { project_slug: slug })
  })
}

/**
 * Read one operation's video from YouTube and persist the outcome.
 *
 * Returns the mapped state and whether it was written. A `status_unavailable`
 * result never overwrites a terminal lifecycle: an answer we could not get is
 * not evidence that a known outcome changed.
 */
export async function syncYouTubePublicationState(input: {
  project_slug: string
  operation_id: string
  account_id: string
}): Promise<{ state: YouTubePublicationState; persisted: boolean; details?: VideoPublicationDetails }> {
  const record = await readYouTubeOperation(input.project_slug, input.operation_id)
  if (!record?.video_id) throw new Error('This YouTube operation has no accepted video to check.')
  const assignment = await getProjectYouTubeAssignment(input.project_slug)
  if (!assignment || assignment.channel_id !== record.channel_id) {
    throw new Error('This YouTube operation belongs to a channel this project no longer publishes to.')
  }
  if (input.account_id !== registryCredentialFor(record.channel_id)) {
    throw new Error('The YouTube credential does not match this project’s assigned channel.')
  }

  const details = await listVideoPublicationDetails(input.project_slug, input.account_id, [record.video_id])
  const remoteDetails = details[record.video_id]
  const state = mapYouTubePublicationState(remoteDetails ?? null)
  await observeOperations(input.project_slug, record.channel_id, [record], details)

  if (state.lifecycle === 'status_unavailable' && TERMINAL.has(record.lifecycle)) {
    return { state, persisted: false, ...(remoteDetails ? { details: remoteDetails } : {}) }
  }

  await updatePinnedYouTubeOperation({
    project_slug: input.project_slug,
    operation_id: input.operation_id,
    expected_revision: record.revision,
    expected_channel_id: record.channel_id,
    mutate(current) {
      current.lifecycle = state.lifecycle
      current.processing = state.processing
      if (state.snapshot) {
        // Keep what YouTube said last time. Overwriting it destroys the only
        // evidence that YouTube's own values changed.
        if (current.remote_snapshot) current.previous_remote_snapshot = current.remote_snapshot
        current.remote_snapshot = state.snapshot
      }
    },
  })
  return { state, persisted: true, ...(remoteDetails ? { details: remoteDetails } : {}) }
}

export interface ProjectSyncResult {
  channel_id: string
  checked: number
  updated: number
  outcome: 'ok' | 'partial' | 'failed'
  error_code?: RemoteSyncState['error_code']
}

/** Accepted by YouTube but not yet a final answer: what the background check follows. */
export const PENDING_YOUTUBE_LIFECYCLES: ReadonlySet<YouTubeVideoLifecycle> = new Set(['accepted', 'processing'])

/** One whole-project refresh, batched by the client in groups of 50. `only_pending` limits it to unfinished uploads. */
export async function syncProjectYouTubePublicationStates(input: {
  project_slug: string
  account_id: string
  only_pending?: boolean
}): Promise<ProjectSyncResult> {
  const assignment = await getProjectYouTubeAssignment(input.project_slug)
  if (!assignment) throw new Error('Assign a YouTube channel before syncing publication state.')
  const channelId = assignment.channel_id
  if (input.account_id !== registryCredentialFor(channelId)) {
    throw new Error('The YouTube credential does not match this project’s assigned channel.')
  }
  const records = (await listYouTubeOperations(input.project_slug))
    .filter(record => record.channel_id === channelId && !!record.video_id
      && (!input.only_pending || PENDING_YOUTUBE_LIFECYCLES.has(record.lifecycle)))

  if (!records.length) return { channel_id: channelId, checked: 0, updated: 0, outcome: 'ok' }

  let details: Record<string, VideoPublicationDetails>
  try {
    details = await listVideoPublicationDetails(
      input.project_slug,
      input.account_id,
      records.map(record => record.video_id!),
    )
  } catch (error) {
    // The request itself failed, so nothing was learned about any video. The
    // local records are left exactly as they were.
    return { channel_id: channelId, checked: 0, updated: 0, outcome: 'failed', error_code: classifyYouTubeSyncFailure(error) }
  }

  // The owner's own credential sees every video on the channel. An answer
  // holding NONE of several known uploads is far likelier a token for another
  // Google account than a channel emptied overnight: nothing is concluded.
  const distinct = new Set(records.map(record => record.video_id!))
  if (distinct.size >= 3 && !records.some(record => details[record.video_id!])) {
    return { channel_id: channelId, checked: 0, updated: 0, outcome: 'failed', error_code: 'provider_error' }
  }

  await observeOperations(input.project_slug, channelId, records, details)
  let updated = 0
  let failedWrites = 0
  for (const record of records) {
    const state = mapYouTubePublicationState(details[record.video_id!] ?? null)
    if (state.lifecycle === 'status_unavailable' && TERMINAL.has(record.lifecycle)) continue
    try {
      await updatePinnedYouTubeOperation({
        project_slug: input.project_slug,
        operation_id: record.operation_id,
        expected_revision: record.revision,
        expected_channel_id: record.channel_id,
        mutate(current) {
          current.lifecycle = state.lifecycle
          current.processing = state.processing
          if (state.snapshot) {
            if (current.remote_snapshot) current.previous_remote_snapshot = current.remote_snapshot
            current.remote_snapshot = state.snapshot
          }
        },
      })
      updated++
    } catch {
      // A record that moved under us, or refused the transition. The rest of
      // the batch is still worth keeping — this is reported as partial, never
      // rolled back, and never retried automatically.
      failedWrites++
    }
  }

  return {
    channel_id: channelId,
    checked: records.length,
    updated,
    outcome: failedWrites > 0 ? 'partial' : 'ok',
  }
}

function comparableTitle(title: string | undefined): string {
  return (title || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The duplicate guard before an episode may be uploaded again. YouTube must
 * CONFIRM that every video this episode is known by is gone, and no video on
 * the channel may carry one of the episode's titles. "Could not ask" refuses
 * too — only a confirmed answer opens the door. (TN0162/TN0163 each have two
 * video ids: an earlier "not returned" answer was enough to upload again.)
 */
export async function assertSafeToUploadAgain(input: {
  project_slug: string
  account_id: string
  video_ids: string[]
  titles: string[]
}): Promise<void> {
  const ids = [...new Set(input.video_ids.filter(Boolean))]
  const unchecked = (error: unknown) => new YouTubeFoundationError(409, 'YOUTUBE_STATUS_UNCHECKED',
    `Story Studio could not check YouTube (${error instanceof Error ? error.message : String(error)}). Nothing changed; try again.`)
  let details: Record<string, VideoPublicationDetails>
  let uploads: Awaited<ReturnType<typeof listRecentUploads>>
  try {
    details = await listVideoPublicationDetails(input.project_slug, input.account_id, ids)
    uploads = await listRecentUploads(input.project_slug, input.account_id, { maxPages: 10 })
  } catch (error) {
    throw unchecked(error)
  }
  const still = ids.find(id => details[id] && details[id]!.uploadStatus !== 'deleted')
  if (still) {
    throw new YouTubeFoundationError(409, 'YOUTUBE_ALREADY_PUBLISHED',
      `YouTube still has video ${still} (${details[still]!.uploadStatus || 'status not given'}). Delete it in YouTube Studio first, or keep it; nothing was changed here.`)
  }
  const wanted = new Set(input.titles.map(comparableTitle).filter(Boolean))
  const twin = uploads.videos.find(video => !!video.videoId && !ids.includes(video.videoId) && wanted.has(comparableTitle(video.title)))
  if (twin) {
    throw new YouTubeFoundationError(409, 'YOUTUBE_ALREADY_PUBLISHED',
      `Video ${twin.videoId} on this channel already has the title “${twin.title}”, so this episode may already be uploaded. Link it in Upload Center → Reconcile instead of uploading again.`)
  }
}
