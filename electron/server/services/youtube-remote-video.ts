/**
 * The ONE answer to "is this episode already on YouTube?".
 *
 * ── Why this exists (tell 13) ─────────────────────────────────────────────
 * Two stores can each claim this fact, and for three review rounds they were
 * never reconciled:
 *
 *   - the durable OPERATION RECORD, written by the redesigned upload path;
 *   - the legacy SIDECAR (`upload-sidecar.ts`), written by the old Upload page
 *     and still the only trace of every episode published before v1.5.0.
 *
 * The Upload Center's refusal and the Publish page both read only the record.
 * The upload GENERATOR branches on the sidecar (`shouldUpdateOnly`). So for an
 * episode the owner published through the old page, every reader agreed it had
 * never been uploaded, the route accepted the upload, the confirm promised "a
 * video cannot be replaced once uploaded" — and the job silently PATCHed the
 * live public video's title, description and tags from local metadata, sending
 * no status object at all. Nothing was uploaded. The owner was told it was.
 *
 * A guard that is correct against the store it reads is blind to the store the
 * executor branches on. The record wins when they disagree, because it is the
 * one with a channel on it and a provenance we wrote deliberately.
 *
 * Upload refusal uses `remoteVideoFor`; retention and completion readers use
 * the evidence helpers below. Publishing decisions remain current-channel
 * scoped while cleanup deliberately checks current and historical channels.
 *
 * Three stores answer here: the operation record, the reconcile link
 * (`episode_video_links`, written independently by `/reconcile/apply`), and the
 * legacy sidecar. All three are channel-scoped, but not equally: `channel_id`
 * is required by the sidecar TYPE and not guaranteed on disk, so a sidecar that
 * cannot name its channel is treated as this channel's rather than as another's.
 *
 * The `youtube_legacy_uploaded` config keys are deliberately NOT consulted:
 * they are boolean "was uploaded" markers with no video id, so they cannot
 * answer the question this function is asked (which video?), and the only code
 * that reads them is the history importer that exists to convert them.
 */

import { listYouTubeOperations } from './youtube-operation-store.js'
import { readSidecarStrict } from './upload-sidecar.js'
import type { ProjectFactsCache } from './utils.js'
import { isYouTubeVideoRemoved, readYouTubeProjectPublishingState } from './youtube-project-publishing-store.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import { isContentSha256Revision, resolveYouTubeSourceRevision } from './youtube-source-video.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getProjectDir } from './project-manager.js'
import type { YouTubeOperationRecordV1 } from './youtube-operation-record-reader.js'
import type { YouTubeProjectPublishingStateV1 } from './youtube-project-publishing-store.js'

export interface RemoteVideo {
  video_id: string
  /** Which store answered. The caller may show this; the owner should never have to guess. */
  source: 'operation_record' | 'reconcile_link' | 'legacy_sidecar'
  /**
   * The video is on a channel this project no longer publishes to. Still a
   * refusal — uploading here would overwrite the only local record of it —
   * but a different sentence from "already on this channel".
   */
  other_channel?: boolean
  channel_id?: string
  lifecycle?: string
}

/** Publication facts carried by one immutable operation, without deciding how a caller should use them. */
export function operationPublicationFacts(record: YouTubeOperationRecordV1): {
  privacy_status?: string
  scheduled_for?: string | null
} {
  if (record.remote_snapshot) {
    return {
      privacy_status: record.remote_snapshot.privacy_status,
      scheduled_for: record.remote_snapshot.scheduled_for,
    }
  }
  if (!record.final_payload) return {}
  try {
    const status = JSON.parse(record.final_payload.status_json) as Record<string, unknown>
    return {
      ...(typeof status.privacyStatus === 'string' ? { privacy_status: status.privacyStatus } : {}),
      ...(typeof status.publishAt === 'string' || status.publishAt === null
        ? { scheduled_for: status.publishAt as string | null }
        : {}),
    }
  } catch {
    return {}
  }
}

export interface YouTubeRetentionEvidence {
  /** Accepted provider identities remain useful for operational counts, but do not authorize deleting a local master. */
  accepted_operations: Array<Pick<YouTubeOperationRecordV1, 'video_id' | 'channel_id' | 'lifecycle'>>
  ready_operations: Array<Pick<YouTubeOperationRecordV1, 'operation_id' | 'video_id' | 'source_revision' | 'channel_id'>>
  reconcile_link?: { video_id: string; channel_id: string; linked_at: string }
  legacy_sidecar?: { video_id: string; channel_id?: string; uploaded_at?: string }
  /** An unfinished/failed record or unreadable receipt means local data stays. */
  protected_reason?: string
}

function hasNonReadyCanonicalIdentity(evidence: YouTubeRetentionEvidence, videoId: string): boolean {
  return evidence.accepted_operations.some(operation =>
    operation.video_id === videoId && operation.lifecycle !== 'ready')
}

/** Usable remote completion when there is no local candidate whose bytes must be matched. */
export function usableYouTubeRemoteEvidence(
  evidence: YouTubeRetentionEvidence,
): { usable: boolean; video_id?: string } {
  const ready = evidence.ready_operations[0]
  if (ready) return { usable: true, video_id: ready.video_id }
  if (evidence.reconcile_link && !hasNonReadyCanonicalIdentity(evidence, evidence.reconcile_link.video_id)) {
    return { usable: true, video_id: evidence.reconcile_link.video_id }
  }
  if (evidence.legacy_sidecar && !hasNonReadyCanonicalIdentity(evidence, evidence.legacy_sidecar.video_id)) {
    return { usable: true, video_id: evidence.legacy_sidecar.video_id }
  }
  return { usable: false }
}

export async function readYouTubeRetentionStores(slug: string): Promise<{
  records: YouTubeOperationRecordV1[]
  state: Pick<YouTubeProjectPublishingStateV1, 'episode_video_links' | 'removed_videos'>
}> {
  const projectDir = getProjectDir(slug)
  if (!projectDir) throw new Error(`Project ${slug} not found`)
  const youtubeDir = path.join(projectDir, 'youtube')
  const operationsDir = path.join(youtubeDir, 'operations')
  const statePath = path.join(youtubeDir, 'project-state.json')
  const records = existsSync(operationsDir) ? await listYouTubeOperations(slug) : []
  const state = existsSync(statePath)
    ? await readYouTubeProjectPublishingState(slug)
    : { episode_video_links: {} }
  return { records, state }
}

/** Read every historical channel when deciding whether a local master may go. */
export async function youtubeRetentionEvidenceFor(
  slug: string,
  episodeCode: string,
  title: string,
  records?: YouTubeOperationRecordV1[],
  state?: Pick<YouTubeProjectPublishingStateV1, 'episode_video_links' | 'removed_videos'>,
  cache?: ProjectFactsCache,
): Promise<YouTubeRetentionEvidence> {
  const stores = records && state ? null : await readYouTubeRetentionStores(slug)
  const all = records ?? stores!.records
  const publishing = state ?? stores!.state
  const episodeRecords = all.filter(record => record.episode_code === episodeCode
    && !isYouTubeVideoRemoved(publishing, episodeCode, record.channel_id, record.video_id))
  const accepted = episodeRecords.filter(record => !!record.video_id?.trim())
    .map(record => ({
      video_id: record.video_id!,
      channel_id: record.channel_id,
      lifecycle: record.lifecycle,
    }))
  const ready = episodeRecords.filter(record => record.lifecycle === 'ready' && !!record.video_id?.trim())
    .map(record => ({
      operation_id: record.operation_id,
      video_id: record.video_id!,
      source_revision: record.source_revision,
      channel_id: record.channel_id,
    }))
  const result: YouTubeRetentionEvidence = { accepted_operations: accepted, ready_operations: ready }
  if (episodeRecords.some(record => record.lifecycle !== 'ready' || !record.video_id?.trim())) {
    result.protected_reason = 'upload evidence is unfinished or not usable'
  }

  const link = publishing.episode_video_links[episodeCode]
  // Upload links are written at provider acceptance, before processing can
  // prove the remote copy usable. Only an independent owner reconciliation
  // decision can authorize retention without a ready operation.
  if (link?.video_id?.trim() && link.source === 'reconcile'
    && !isYouTubeVideoRemoved(publishing, episodeCode, link.channel_id, link.video_id)) {
    result.reconcile_link = {
      video_id: link.video_id.trim(),
      channel_id: link.channel_id,
      linked_at: link.linked_at,
    }
  }

  try {
    const sidecar = await readSidecarStrict(slug, episodeCode, 'youtube', cache)
    if (sidecar?.video_id?.trim() && !sidecar.deleted_at
      && !isYouTubeVideoRemoved(publishing, episodeCode, sidecar.channel_id, sidecar.video_id)) {
      result.legacy_sidecar = {
        video_id: sidecar.video_id.trim(),
        ...(sidecar.channel_id ? { channel_id: sidecar.channel_id } : {}),
        ...(sidecar.uploaded_at ? { uploaded_at: sidecar.uploaded_at } : {}),
      }
    }
  } catch {
    result.protected_reason = 'the historical upload receipt is unreadable'
  }
  return result
}

export async function youtubeRetentionProofForFile(
  evidence: YouTubeRetentionEvidence,
  filePath: string,
): Promise<{ usable: boolean; source_revision?: string; operation_id?: string; video_id?: string; channel_id?: string; reason?: string }> {
  const revision = await resolveYouTubeSourceRevision(filePath)
  const matching = evidence.ready_operations.find(record =>
    isContentSha256Revision(record.source_revision) && record.source_revision === revision)
  if (matching) {
    return {
      usable: true,
      source_revision: revision,
      operation_id: matching.operation_id,
      video_id: matching.video_id,
      channel_id: matching.channel_id,
    }
  }

  const hasEvidence = evidence.ready_operations.length > 0
    || !!evidence.reconcile_link || !!evidence.legacy_sidecar || !!evidence.protected_reason
  return {
    usable: false,
    reason: hasEvidence
      ? evidence.protected_reason
        || 'the recorded YouTube upload has no matching content SHA-256 for this local final'
      : 'the episode has no usable YouTube evidence',
  }
}

/** Lifecycles that mean an upload is under way even before a video id exists. */
export const OPEN_LIFECYCLES: ReadonlyArray<string> = [
  'preparing', 'uploading', 'accepted', 'processing', 'ready', 'status_unavailable',
]

/**
 * The video this episode already has on YouTube, or null.
 *
 * `channelId` scopes all three reads, the way every sibling read is scoped — an
 * operation from a channel this project has left says nothing about the one it
 * publishes to now. The sidecar's own `channel_id` is required by the type but
 * not validated on disk, so a sidecar missing it is treated as belonging HERE.
 */
export async function remoteVideoFor(
  slug: string,
  episodeCode: string,
  title: string,
  channelId: string | null,
  records?: Array<{ episode_code: string, video_id?: string, channel_id?: string, lifecycle: string }>,
  // Both hoisted by a sweeping caller. `state` in particular is read under a
  // lock, so reading it per episode serialised a batch that was meant to run in
  // parallel — removing one N+1 had introduced another.
  state?: Pick<YouTubeProjectPublishingStateV1, 'episode_video_links' | 'removed_videos'>,
  cache?: ProjectFactsCache,
): Promise<RemoteVideo | null> {
  const links = state ?? await readYouTubeProjectPublishingState(slug)

  // 1. The durable operation record. Ours, channel-scoped, richest.
  const all = records ?? await listYouTubeOperations(slug)
  const record = all.find(entry => entry.episode_code === episodeCode
    && entry.channel_id === channelId
    && (!!entry.video_id?.trim() || OPEN_LIFECYCLES.includes(entry.lifecycle))
    && !isYouTubeVideoRemoved(links, episodeCode, entry.channel_id, entry.video_id))
  if (record) {
    return {
      video_id: record.video_id?.trim() || '',
      source: 'operation_record',
      ...(record.channel_id ? { channel_id: record.channel_id } : {}),
      lifecycle: record.lifecycle,
    }
  }

  // 2. The reconcile link. INDEPENDENT of both other stores: `/reconcile/apply`
  //    writes `episode_video_links` with `source: 'reconcile'` and creates
  //    neither a record nor a sidecar. The earlier sweep called this store
  //    "derived, never independent", which was simply wrong — its own type is
  //    `source: 'upload' | 'reconcile'`. So an owner who
  //    linked a channel video to an episode in Reconcile was then told by
  //    Publish that the episode had never been uploaded, and offered to upload
  //    it: a second public video of the same episode.
  const link = links.episode_video_links[episodeCode]
  if (link?.video_id?.trim() && link.channel_id === channelId
    && !isYouTubeVideoRemoved(links, episodeCode, link.channel_id, link.video_id)) {
    return { video_id: link.video_id.trim(), source: 'reconcile_link', channel_id: link.channel_id }
  }

  // 3. The legacy sidecar, for everything published before v1.5.0.
  //
  //    Resolved through the DRIFT-TOLERANT resolver, because the plain one
  //    derives the folder from the CURRENT title: renaming an episode moved the
  //    lookup to a directory that does not exist, the sidecar read as absent,
  //    and every layer agreed the episode had never been uploaded — a duplicate
  //    public upload, from a rename.
  //
  //    A read or parse ERROR propagates. It must not be caught into `null`:
  //    this is the one guard standing between a renamed or damaged episode and
  //    a second public video, and "I could not read it" is not "there is none"
  //    (tell 1). The callers turn it into a loud, coded refusal.
  // STRICT: absent is null (uploadable), unreadable THROWS. The previous
  // version deleted an outer `.catch(() => null)` and called that a fix, while
  // `readSidecarAtPath` swallowed the same failures one layer down — so a
  // corrupt sidecar still read as "never uploaded" and still led to a second
  // public video. The catch that mattered was never the one that was removed.
  let sidecar
  try {
    sidecar = await readSidecarStrict(slug, episodeCode, 'youtube', cache)
  } catch (cause) {
    // Re-thrown, not swallowed: the callers turn this into a refusal the owner
    // can act on. `YOUTUBE_OPERATION_RECORD_CORRUPT` already means exactly this
    // — the local record of an upload cannot be read — so no new code is needed.
    throw new YouTubeFoundationError(
      409,
      'YOUTUBE_OPERATION_RECORD_CORRUPT',
      `Story Studio cannot read its upload record for ${episodeCode}, so it cannot tell whether the `
      + 'episode is already on YouTube. Nothing was uploaded. '
      + `(${(cause as Error)?.message || 'unreadable'})`,
    )
  }
  // A tombstone alone is only a local observation. In particular, the reachable
  // sync path stamps `sync_404` for a missing provider response, which can mean
  // a private video this token cannot see. It must never authorize a duplicate
  // upload. An owner-confirmed removal receipt is authoritative; the one legacy
  // exception is an explicitly manual same-channel mark.
  // `channel_id` is REQUIRED by the type and not guaranteed on disk — the
  // history importer has a dedicated `missing_channel_id` escalation for
  // exactly this. `=== channelId` therefore read a sidecar that cannot say
  // which channel it belongs to as "not this one", i.e. uploadable, i.e. a
  // duplicate. When it cannot say, refuse: a wrongly-refused upload is a
  // message, a wrongly-allowed one is a second video nobody can un-publish.
  if (sidecar?.video_id?.trim()) {
    if (isYouTubeVideoRemoved(links, episodeCode, sidecar.channel_id || channelId, sidecar.video_id)) return null
    // Do not widen old `takedown`/unknown markers into re-upload authority:
    // they were not a verified current-channel deletion. A sidecar with no
    // channel also cannot establish where its video was manually removed.
    if (sidecar.deleted_at && sidecar.deleted_reason === 'manual'
      && !!sidecar.channel_id && sidecar.channel_id === channelId) return null
    // A sidecar naming a DIFFERENT channel is still a refusal, not a null.
    //
    // This was the fourth instance of tell 13: the predicate returned null for
    // an old-channel sidecar (so page and route said "publishable") while the
    // job carried its own guard that refused. One question, two answers, and
    // the disagreement only surfaced after the owner pressed Upload. There is
    // one `youtube_upload.json` per episode, so uploading here would overwrite
    // the only local record of the video on the old channel — which is exactly
    // why the job refused, and why everyone else must too.
    return {
      video_id: sidecar.video_id.trim(),
      source: 'legacy_sidecar',
      ...(sidecar.channel_id ? { channel_id: sidecar.channel_id } : {}),
      // Missing `channel_id` is treated as THIS channel: the field is required
      // by the type and never validated on disk, so "cannot say" must not read
      // as "somewhere else, go ahead".
      ...(channelId && sidecar.channel_id && sidecar.channel_id !== channelId ? { other_channel: true } : {}),
    }
  }
  return null
}

/** Owner-facing sentence for a refusal, naming the video and where we learned of it. */
export function alreadyOnYouTubeReason(episodeCode: string, remote: RemoteVideo): string {
  if (!remote.video_id) return `${episodeCode} already has an upload in progress.`
  if (remote.other_channel) {
    return `${episodeCode} was uploaded to channel ${remote.channel_id} as ${remote.video_id}, `
      + 'and this project now publishes somewhere else. Uploading here would overwrite the only '
      + 'local record of that video.'
  }
  return remote.source === 'legacy_sidecar'
    ? `${episodeCode} is already on YouTube as ${remote.video_id}, published before this version of Story Studio. `
      + 'Uploading again would create a second video; YouTube has no replace.'
    : `${episodeCode} is already on YouTube as ${remote.video_id}.`
}
