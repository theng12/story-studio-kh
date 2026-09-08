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
import { listVideoPublicationDetails, registryCredentialFor } from '../lib/youtube-client.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import {
  listYouTubeOperations,
  readYouTubeOperation,
  updatePinnedYouTubeOperation,
  updateYouTubeOperation,
} from './youtube-operation-store.js'
import type { RemoteSyncState } from './youtube-project-publishing-store.js'

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

/**
 * `details === null` means the video did not come back. That is "we could not
 * see it", not a state YouTube reported — hence `status_unavailable`, which
 * the persist step refuses to write over a terminal answer.
 */
export function mapYouTubePublicationState(
  details: VideoPublicationDetails | null,
  checked_at: string = new Date().toISOString(),
): YouTubePublicationState {
  if (!details) {
    return { lifecycle: 'status_unavailable', processing: { checked_at } }
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

/**
 * Why a sync did not happen, in terms a screen can act on.
 *
 * "We never reached YouTube" and "YouTube answered and refused" are different
 * facts: the first is the user's network, the second is their account or their
 * quota. Rendering both as "sync failed" tells them nothing about what to do.
 */
function classifySyncFailure(error: unknown): RemoteSyncState['error_code'] {
  const code = (error as { code?: string } | null)?.code
  if (code === 'YOUTUBE_QUOTA_EXHAUSTED') return 'quota_exhausted'
  const message = error instanceof Error ? error.message : String(error)
  // youtube-client throws this exact shape once YouTube has actually answered.
  if (/failed \(\d{3}\)/.test(message) || /quota/i.test(message)) return 'provider_error'
  return 'offline'
}

/** One deliberate whole-project refresh, batched by the client in groups of 50. */
export async function syncProjectYouTubePublicationStates(input: {
  project_slug: string
  account_id: string
}): Promise<ProjectSyncResult> {
  const assignment = await getProjectYouTubeAssignment(input.project_slug)
  if (!assignment) throw new Error('Assign a YouTube channel before syncing publication state.')
  const channelId = assignment.channel_id
  if (input.account_id !== registryCredentialFor(channelId)) {
    throw new Error('The YouTube credential does not match this project’s assigned channel.')
  }
  const records = (await listYouTubeOperations(input.project_slug))
    .filter(record => record.channel_id === channelId && !!record.video_id)

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
    return { channel_id: channelId, checked: 0, updated: 0, outcome: 'failed', error_code: classifySyncFailure(error) }
  }

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
