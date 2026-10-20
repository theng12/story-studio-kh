/**
 * The read surface the redesigned Upload Center is built on.
 *
 * Phase 3 built the durable truth and deliberately shipped no UI, so none of
 * it was reachable over the wire. This is the first HTTP reader of those
 * stores (confirmed against the code graph before it was written).
 *
 * Two rules shape every handler here:
 *
 *   1. Ordinary page loads are cache-first and cost no YouTube quota
 *      (spec section 7). Exactly ONE route talks to the provider, and its name
 *      says so.
 *   2. An empty answer must say WHY it is empty. "No channel assigned" and
 *      "nothing has been uploaded yet" are different facts, and a screen that
 *      renders them identically is the defect this project keeps finding.
 *
 * Nothing here returns a token, secret, or resumable session URL.
 */

import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { Router } from 'express'

import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { withLock } from '../lib/atomic-store.js'
import { sameInstant } from '../lib/publish-instant.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import type {
  YouTubeEpisodePublishableProjection,
  YouTubeFinalCheckProjection,
  YouTubePublicationProjection,
} from '../contracts/youtube-upload-center.js'
import {
  getProjectYouTubeAssignment,
  readYouTubeConnectionRegistry,
} from '../services/youtube-connection-store.js'
import {
  assertYouTubeOperationAuthorized,
  findForeignEpisodeClaim,
  listYouTubeOperations,
  readYouTubeOperation,
  type YouTubeOperationRecordV1,
  updatePinnedYouTubeOperation,
  updateYouTubeOperation,
} from '../services/youtube-operation-store.js'
import {
  linkYouTubeEpisodeVideo,
  readYouTubeProjectPublishingState,
  recordYouTubeAnalyticsCache,
  recordYouTubePageCursors,
  analyticsForChannel,
  type AnalyticsPartialReason,
  recordYouTubeCommentCache,
  recordYouTubeEpisodePublication,
  recordYouTubeModerationReceipt,
  recordYouTubeReconcileCache,
  recordYouTubeReconcileDecision,
  recordYouTubeRemoteSyncAttempt,
  rollbackYouTubeReconcileDecision,
  setYouTubeReconcileIgnored,
  isYouTubeVideoRemoved,
  recordYouTubeVideoRemoval,
} from '../services/youtube-project-publishing-store.js'
import type { ModerationReceipt } from '../services/youtube-project-publishing-store.js'
import { analyzeYouTubeReconcile } from '../services/youtube-reconcile.js'
import { fetchCommentInbox } from '../services/youtube-comment-inbox.js'
import { postCommentReply } from '../lib/youtube-comments.js'
import { readYouTubeQuota } from '../services/youtube-quota-ledger.js'
import {
  preflightYouTubeChannel,
  readCachedChannelEligibility,
  readYouTubeChannelEligibility,
} from '../services/youtube-channel-eligibility.js'
import { buildYouTubeMetadataPackage, resanitizeStoredSnippet, resolveYouTubeUploadSettings } from '../services/youtube-metadata-package.js'
import { enqueueOrRun, getJobs, isDuplicate } from '../services/job-queue.js'
import type { Job } from '../models/types.js'
import { listUploadThumbnails, resolveUploadMetadata } from '../lib/upload-metadata.js'
import { createProjectFactsCache, resolveEpisodePaths, resolveScenePlanPath, EPISODE_PROBE_BATCH } from '../services/utils.js'
import { findYouTubeSourceVideoPath, resolveYouTubeSourceRevisionCached } from '../services/youtube-source-video.js'
import { getUploadMode } from '../services/upload-store.js'
import { safetyMode } from '../services/safety-checks.js'
import {
  finalCheckVerdict, finalCheckIdentity, finalCheckIdentityMatches, freshStoredExpectation,
  readStoredFinalCheck, readFrozenShape,
  speechEndSecFromScenePlan, finalCheckSummary, finalCheckProgress, startFinalCheck, readPlannedSectionGaps,
  type FinalCheckExpectation,
} from '../lib/final-video-check.js'
import {
  expectationFromFrozenShape, finalFreezeStateFor, finalFreezeStates, planlessExpectationFor,
} from '../services/final-check-expectation.js'
import {
  applyScheduleAssignmentsWithRollback, computeSlots, episodeOrderShifts, getActivePlanId, getPlan,
  latestFutureProjectClaimMs, listPlans, localDayKeyInTz, orderEpisodeCodes,
  readItemSchedule, UploadScheduleBatchWriteError,
} from '../services/upload-plans.js'
import { readSidecarStrict, setScheduledFor } from '../services/upload-sidecar.js'
import { remoteVideoFor, alreadyOnYouTubeReason, OPEN_LIFECYCLES, SUPERSEDED_LIFECYCLES } from '../services/youtube-remote-video.js'
import { UPLOAD_STORE_UNREADABLE, latestEpisodeUploadJob, localUploadProjection } from '../services/youtube-local-upload.js'
import { invalidatePublishingOverviewCache } from '../services/publishing-overview.js'
import { movableLocalClaims } from '../services/episode-autoschedule.js'
import * as im from '../services/idea-manager.js'
import { getProjectDir } from '../services/project-manager.js'
import { COMPARED_FIELDS, compareYouTubeVideo } from '../services/youtube-metadata-comparison.js'
import {
  assertSafeToUploadAgain,
  isConfirmedGoneFromYouTube,
  syncYouTubePublicationState,
} from '../services/youtube-publication-status.js'
import { checkAllYouTubeUploads } from '../services/youtube-status-sync.js'
import {
  YOUTUBE_VIDEO_NOT_FOUND,
  cachedObservation,
  classifyYouTubeSyncFailure,
  isObservationStale,
  legacyUploadsFor,
  newestObservation,
  publicationCacheView,
  readYouTubePublicationCache,
  receiptObservation,
  recordYouTubePublicationObservations,
  refreshYouTubePublications,
  snapshotObservation,
  type ObservedPublication,
  type PublicationCache,
} from '../services/youtube-publication-cache.js'
import {
  listVideoPublicationDetails,
  registryCredentialFor,
  type VideoPublicationDetails,
} from '../lib/youtube-client.js'
import { ANALYTICS_METRICS, VIDEO_FACTS, fetchProjectAnalytics } from '../services/youtube-analytics-cache.js'
import { cursorKey } from '../services/youtube-page-cursor.js'
import { metricNotFetched } from '../services/youtube-analytics-value.js'
import {
  addVideoToPlaylist,
  listRecentUploads,
  setCommentModerationStatus,
  updateVideoMetadata,
} from '../lib/youtube-client.js'
export const router = Router()

function fail(res: import('express').Response, error: unknown, fallback: string): void {
  if (error instanceof YouTubeFoundationError) {
    res.status(error.statusCode).json(error.toPublic())
    return
  }
  const tagged = error as { statusCode?: number; status?: number } | null
  const status = typeof tagged?.statusCode === 'number'
    ? tagged.statusCode
    : typeof tagged?.status === 'number' ? tagged.status : 500
  res.status(status).json(humanizeBackendError(error, fallback))
}

function failScheduleBatch(res: import('express').Response, error: unknown): boolean {
  if (!(error instanceof UploadScheduleBatchWriteError)) return false
  res.status(error.statusCode).json({
    code: error.code,
    detail: error.message,
    committed_episode_codes: error.committed_episode_codes,
    uncertain_episode_codes: error.uncertain_episode_codes,
  })
  return true
}

function thumbnailPreviewUrl(slug: string, filePath: string, cacheKey: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/video-editor/preview-image?path=${encodeURIComponent(filePath)}&k=${encodeURIComponent(cacheKey)}`
}

async function uploadThumbnailPreview(
  slug: string,
  episodeCode: string,
  fallbackTitle: string,
  selectedFilename: string | null | undefined,
) {
  const options = await listUploadThumbnails({
    slug,
    episode_code: episodeCode,
    fallback_title: fallbackTitle,
    platform: 'youtube',
  })
  const publicOptions = await Promise.all(options.map(async option => {
    try {
      const stat = await fsp.stat(option.path)
      return {
        filename: option.filename,
        is_pinned: option.is_pinned,
        url: thumbnailPreviewUrl(slug, option.path, `${stat.size}-${Math.trunc(stat.mtimeMs)}`),
      }
    } catch {
      return {
        filename: option.filename,
        is_pinned: option.is_pinned,
        url: thumbnailPreviewUrl(slug, option.path, 'unavailable'),
      }
    }
  }))
  if (!selectedFilename) return { state: 'none' as const, options: publicOptions }
  const selected = publicOptions.find(option => option.filename === selectedFilename)
  if (!selected) {
    return {
      state: 'unavailable' as const,
      filename: selectedFilename,
      options: publicOptions,
      reason: 'The selected thumbnail is no longer available. Choose another thumbnail before uploading.',
    }
  }
  return { state: 'selected' as const, filename: selected.filename, url: selected.url, options: publicOptions }
}

/**
 * What the owner has to deal with, counted from the durable records.
 *
 * The per-category counts overlap by design — one video can be both
 * `processing` and drifted, and those are two different actions. So the
 * headline count is the number of distinct EPISODES needing attention, not the
 * sum of the categories: "3 things to look at" must not mean two videos.
 */
function attentionFrom(records: YouTubeOperationRecordV1[]) {
  const attention = { processing: 0, failed: 0, rejected: 0, status_unavailable: 0, drift: 0 }
  let recordsNeedingAttention = 0
  for (const record of records) {
    let flagged = false
    if (record.lifecycle === 'processing') { attention.processing++; flagged = true }
    else if (record.lifecycle === 'failed') { attention.failed++; flagged = true }
    else if (record.lifecycle === 'rejected') { attention.rejected++; flagged = true }
    else if (record.lifecycle === 'status_unavailable') { attention.status_unavailable++; flagged = true }
    if (Object.values(record.drift).some(state => state.state !== 'match' && state.state !== 'keep_youtube')) {
      attention.drift++
      flagged = true
    }
    if (flagged) recordsNeedingAttention++
  }
  return { attention, recordsNeedingAttention }
}

/**
 * Only the fields the Upload Center actually renders.
 *
 * The whole record carries the constructed request payload and the resumable
 * session hash. Neither is a credential, and neither has any use in a browser
 * — so neither is sent. Give the UI what it needs, not everything there is.
 */
function publicOperation(record: YouTubeOperationRecordV1) {
  return {
    operation_id: record.operation_id,
    episode_code: record.episode_code,
    channel_id: record.channel_id,
    lifecycle: record.lifecycle,
    origin: record.origin,
    final_action: record.final_action,
    created_at: record.created_at,
    updated_at: record.updated_at,
    ...(record.video_id ? { video_id: record.video_id } : {}),
    ...(record.accepted_at ? { accepted_at: record.accepted_at } : {}),
    ...(record.processing ? { processing: record.processing } : {}),
    ...(record.remote_snapshot ? { last_checked_at: record.remote_snapshot.fetched_at } : {}),
    drift: record.drift,
  }
}

/**
 * Why this project cannot talk to YouTube yet, or null when it can.
 * Ordered from the earliest missing setup step, so the UI can point at the
 * one thing to do next rather than listing everything that is absent.
 */
function unavailableReason(hasApplication: boolean, hasChannels: boolean, assigned: boolean): string | null {
  if (!hasApplication) return 'no_oauth_application'
  if (!hasChannels) return 'no_channel_connected'
  if (!assigned) return 'no_channel_assigned'
  return null
}

const REMOTE_STORE_UNREADABLE = 'Story Studio cannot read the local YouTube records.'

function newestOperations(records: YouTubeOperationRecordV1[]): YouTubeOperationRecordV1[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const updated = Date.parse(b.record.updated_at) - Date.parse(a.record.updated_at)
      return updated || Date.parse(b.record.created_at) - Date.parse(a.record.created_at) || b.index - a.index
    })
    .map(({ record }) => record)
}

const NOT_FOUND_AT_LAST_CHECK = 'YouTube did not return this video at the last check. Check it again to confirm.'

/** The newest observation of this exact video on this channel. An other-channel upload is never read from this cache. */
function observedForEpisode(
  code: string,
  operation: YouTubeOperationRecordV1 | undefined,
  remote: Awaited<ReturnType<typeof remoteVideoFor>>,
  publishingState: Awaited<ReturnType<typeof readYouTubeProjectPublishingState>> | null,
  cache: PublicationCache,
  channelId: string | null,
): ObservedPublication | undefined {
  const videoId = operation?.video_id ?? (remote && !remote.other_channel ? remote.video_id : undefined)
  if (!videoId) return undefined
  const receipt = publishingState?.episode_video_links[code]
  return newestObservation(
    operation ? snapshotObservation(operation) : undefined,
    receipt && receipt.channel_id === channelId && receipt.video_id === videoId ? receiptObservation(code, receipt) : undefined,
    cachedObservation(cache, channelId, videoId),
  )
}

/**
 * `observed` is the newest thing YouTube said about this exact video on this
 * channel - operation snapshot, verified receipt or the publication cache, as
 * `newestObservation` chose. Never local intent.
 */
function publicationProjection(
  operation: YouTubeOperationRecordV1 | undefined,
  remote: Awaited<ReturnType<typeof remoteVideoFor>>,
  publishingState: Awaited<ReturnType<typeof readYouTubeProjectPublishingState>> | null,
  channelId: string | null,
  observed: ObservedPublication | undefined,
  unavailableReason?: string,
): YouTubePublicationProjection {
  if (unavailableReason) return { state: 'unknown', reason: unavailableReason }
  const visibility = observed?.privacy_status
  const videoId = operation?.video_id ?? remote?.video_id
  const publishedAt = (publishingState?.reconcile?.channel_id === channelId
    ? publishingState?.reconcile?.remote_videos.find(video => video.video_id === videoId)?.published_at
    : undefined) ?? observed?.published_at
  // What YouTube last CONFIRMED about this video's publication, kept on the
  // operation as `remote_snapshot`. An answer that did not contain the video
  // carries no privacy and no schedule, and taking those fields from it alone
  // dropped the confirmed private + publishAt to null — so "we cannot see it any
  // more" rendered exactly like "nothing is scheduled" (AGENTS.md §6). The
  // confirmed values are kept and stamped with the moment the answer went
  // missing, and a fresh observation still wins over them.
  const confirmed = operation?.remote_snapshot
  const unverified: Pick<YouTubePublicationProjection, 'visibility' | 'scheduled_at' | 'unverified_since'> = {
    ...(confirmed?.privacy_status ? { visibility: confirmed.privacy_status } : {}),
    ...(confirmed?.scheduled_for ? { scheduled_at: confirmed.scheduled_for } : {}),
    ...(observed?.checked_at ? { unverified_since: observed.checked_at } : {}),
  }
  const fromObservation = (common: { visibility?: string; last_checked_at?: string }): YouTubePublicationProjection => {
    if (observed?.upload_status === YOUTUBE_VIDEO_NOT_FOUND) return { state: 'unknown', ...unverified, ...common, reason: NOT_FOUND_AT_LAST_CHECK }
    if (visibility === 'public') return { state: 'published', ...common, ...(publishedAt ? { published_at: publishedAt } : {}) }
    if (observed?.scheduled_for) return { state: 'scheduled', ...common, scheduled_at: observed.scheduled_for }
    return { state: 'uploaded', ...common }
  }

  if (operation) {
    const lastCheckedAt = observed?.checked_at || operation.processing?.checked_at
    const common = {
      ...(visibility ? { visibility } : {}),
      ...(lastCheckedAt ? { last_checked_at: lastCheckedAt } : {}),
    }
    if (operation.lifecycle === 'failed') {
      return { state: 'failed', ...common, ...(operation.processing?.failure_reason ? { reason: operation.processing.failure_reason } : {}) }
    }
    if (operation.lifecycle === 'rejected') {
      return { state: 'rejected', ...common, ...(operation.processing?.rejection_reason ? { reason: operation.processing.rejection_reason } : {}) }
    }
    if (operation.lifecycle === 'status_unavailable') {
      // "YouTube said it is gone", "YouTube answered without it" and "YouTube
      // said something we do not know" are three different facts; none is "we
      // could not reach YouTube" (that writes nothing). Records from before the
      // distinction carry no word.
      const word = operation.processing?.provider_status
      if (isConfirmedGoneFromYouTube(operation)) {
        return { state: 'unknown', ...common, reason: 'Not found on YouTube: it was deleted or removed. “I Deleted This Video on YouTube” allows a new upload once YouTube confirms it.' }
      }
      return {
        state: 'unknown', ...unverified, ...common,
        reason: word && word !== YOUTUBE_VIDEO_NOT_FOUND
          ? `YouTube reported a status Story Studio does not recognise (${word}).`
          : NOT_FOUND_AT_LAST_CHECK,
      }
    }
    if (operation.lifecycle === 'processing') {
      // A publishAt YouTube itself accepted IS a schedule, even while the video
      // is still being processed: the two facts are not alternatives. The
      // Overview already counts this video as confirmed-scheduled — it reads the
      // same observation index — so dropping the date here made the two screens
      // describe one video differently (Origin Field EP0001, 2026-10-18).
      // Only YouTube's own answer counts; a local plan date is not this field.
      return {
        state: 'processing', ...common,
        ...(observed?.scheduled_for ? { scheduled_at: observed.scheduled_for } : {}),
      }
    }
    if (operation.lifecycle === 'preparing' || operation.lifecycle === 'uploading') return { state: 'unpublished' }
    return fromObservation(common)
  }

  if (!remote) return { state: 'unpublished' }
  if (observed?.checked_at) {
    return fromObservation({ ...(visibility ? { visibility } : {}), last_checked_at: observed.checked_at })
  }
  // Never observed: a legacy sidecar or reconcile link proves a remote video
  // identity only. Its schedule and privacy fields may be local intent, and
  // `uploaded_at` is an acceptance time rather than a publication date.
  return {
    state: 'uploaded',
    ...(remote.other_channel && remote.channel_id
      ? { reason: `This upload belongs to channel ${remote.channel_id}.` }
      : {}),
  }
}

router.get('/projects/:slug/youtube/overview', async (req, res) => {
  try {
    const slug = req.params.slug
    const registry = await readYouTubeConnectionRegistry()
    const assignment = await getProjectYouTubeAssignment(slug)
    const channel = assignment ? registry.channels[assignment.channel_id] ?? null : null
    const records = await listYouTubeOperations(slug)
    const counted = attentionFrom(records)
    const publishing = await readYouTubeProjectPublishingState(slug).catch(() => null)

    // Quota belongs to the Cloud project, so it exists only once an owner
    // application does. Reported as null rather than zeroes: "no ceiling
    // configured" is not "nothing used".
    //
    // And a ledger that cannot be READ is a third thing again. Swallowing that
    // into the same `null` would make a corrupt ledger look identical to a
    // fresh install — the ledger is written to fail loudly on corruption
    // precisely so that cannot happen, and quietly catching it here would
    // throw that away.
    let quota = null
    let quotaUnavailableReason: 'no_oauth_application' | 'ledger_unreadable' | null = 'no_oauth_application'
    if (registry.application) {
      quotaUnavailableReason = null
      try {
        quota = await readYouTubeQuota(registry.application.application_id)
      } catch {
        quotaUnavailableReason = 'ledger_unreadable'
      }
    }

    // Whole-channel freshness is the OLDEST answer among the videos we know,
    // never the newest single one: one fresh operation must not make 72
    // unchecked or day-old schedules look current.
    // Legacy uploads the cache was never told about count as UNCHECKED, so one
    // fresh operation cannot make a back catalogue look current. The sweep runs
    // once for this request; if ideas or a sidecar cannot be read, coverage is
    // reported without legacy uploads (`legacy_included: false`) rather than
    // failing the whole overview.
    const coverage = assignment && publishing
      ? publicationCacheView(publishing, await readYouTubePublicationCache(slug).catch(() => ({})), records, assignment.channel_id, {
        legacy: await legacyUploadsFor(slug, assignment.channel_id, createProjectFactsCache(slug)).catch(() => undefined),
      }).coverage
      : null

    res.json({
      assigned_channel: channel,
      // What YouTube last said this channel may do: long videos, custom
      // thumbnails. Cache-first, so this page load costs no quota — the
      // deliberate provider read is Check All Uploads.
      channel_eligibility: assignment
        ? await readCachedChannelEligibility(slug, assignment.channel_id)
        : null,
      unavailable_reason: unavailableReason(
        !!registry.application,
        Object.keys(registry.channels).length > 0,
        !!assignment,
      ),
      quota,
      quota_unavailable_reason: quotaUnavailableReason,
      attention: counted.attention,
      episodes_needing_attention: counted.recordsNeedingAttention,
      operation_count: records.length,
      // When the data was last actually READ from YouTube: the OLDEST answer.
      // null means only "nothing was ever checked"; videos never checked are
      // counted in `publication_coverage.unchecked_videos`, not folded in here.
      last_remote_sync_at: coverage?.oldest_checked_at ?? null,
      // How much of the channel that covers: checked / unchecked / not-found /
      // stale counts and the uploads-listing state. null = no channel or unreadable state.
      publication_coverage: coverage,
      // And what happened the last time we TRIED. A failed attempt must not
      // make stale data look fresh, so the two are reported separately.
      last_sync_attempt: publishing?.remote_sync ?? null,
    })
  } catch (error) {
    fail(res, error, 'Failed to read the YouTube Upload Center overview.')
  }
})

/**
 * Every schedule and status YouTube itself reported for the assigned channel,
 * each with its own `checked_at` and `stale`, plus listing coverage. Read-only
 * and provider-free: refreshing is POST /youtube/sync (and the background pass).
 * `videos` includes known-but-never-checked videos without `checked_at`.
 */
router.get('/projects/:slug/youtube/publication-cache', async (req, res) => {
  try {
    const slug = req.params.slug
    const channelId = await currentChannelId(slug)
    if (!channelId) {
      res.json({ channel_id: null, unavailable_reason: 'no_channel_assigned', coverage: null, videos: [], schedules: [] })
      return
    }
    const [state, cache, records, legacy] = await Promise.all([
      readYouTubeProjectPublishingState(slug),
      readYouTubePublicationCache(slug),
      listYouTubeOperations(slug),
      legacyUploadsFor(slug, channelId, createProjectFactsCache(slug)).catch(() => undefined),
    ])
    res.json(publicationCacheView(state, cache, records, channelId, { legacy }))
  } catch (error) {
    fail(res, error, 'Failed to read the saved YouTube publication status.')
  }
})

router.get('/projects/:slug/youtube/operations', async (req, res) => {
  try {
    const records = await listYouTubeOperations(req.params.slug)
    res.json({ operations: records.map(publicOperation) })
  } catch (error) {
    fail(res, error, 'Failed to read the YouTube operations.')
  }
})

/**
 * What YouTube says about videos this project has no operation record for.
 *
 * Every other route that reads a video's state starts from an operation row,
 * and a row is only created BY an upload - so a video that went up before the
 * operation store existed (legacy uploads on Boundful EP62-72, Story Sprout
 * SS57-60, TerraNash TN160-161) has no route that can reach it, and the only
 * way to see its state was to open YouTube Studio by hand.
 *
 * Bounded and strictly read-only. It asks about at most 50 ids in one
 * `videos.list`, and it writes nothing anywhere: no upload, no operation, no
 * cache, no episode publication state. A video that belongs to a DIFFERENT
 * channel comes back with `matches_assigned_channel: false` rather than being
 * dropped, so a caller can never mistake a stranger's video for this project's.
 * An id YouTube does not return is reported `found: false`, which is "we could
 * not see it" - not a status.
 */
router.post('/projects/:slug/youtube/video-status', async (req, res) => {
  try {
    const raw = req.body?.video_ids
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50
      || raw.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id))) {
      res.status(400).json({
        code: 'YOUTUBE_VIDEO_IDS_INVALID',
        detail: 'Send between 1 and 50 YouTube video ids as `video_ids`.',
      })
      return
    }
    // The account that speaks for the ASSIGNED channel, exactly as every other
    // provider-touching route resolves it - and it refuses an unassigned
    // project with the 409 this route promises, in plain words.
    const { accountId, channelId } = await accountForCurrentChannel(req.params.slug)
    const ids = [...new Set(raw)]
    let details: Record<string, VideoPublicationDetails>
    try {
      details = await listVideoPublicationDetails(req.params.slug, accountId, ids)
    } catch (error) {
      // "We could not ask" is not an answer YouTube gave. Say so, rather than
      // reporting a video as absent or in some state it may not be in.
      throw new YouTubeFoundationError(
        502,
        'YOUTUBE_STATUS_UNCHECKED',
        `Story Studio could not read these videos from YouTube (${error instanceof Error ? error.message : String(error)}). Nothing was changed; try again.`,
      )
    }
    res.json({
      videos: ids.map((videoId) => {
        const found = details[videoId]
        return {
          video_id: videoId,
          found: !!found,
          channel_id: found?.channelId ?? null,
          matches_assigned_channel: found?.channelId === channelId,
          upload_status: found?.uploadStatus ?? null,
          processing_status: found?.processingStatus ?? null,
          privacy_status: found?.privacyStatus ?? null,
          publish_at: found?.publishAt ?? null,
        }
      }),
      checked_at: new Date().toISOString(),
    })
  } catch (error) {
    fail(res, error, 'Failed to read these videos from YouTube.')
  }
})

/**
 * What this project can actually publish, and what it already has.
 *
 * The Publish page used to list `/youtube/operations` and nothing else. An
 * operation record is only created BY an upload, so a project that had never
 * uploaded had no rows - and Preview, which lives inside a row, and Upload,
 * which lives under a preview, were both unreachable. The page said "Nothing
 * uploaded yet" and offered nothing to press. Every server-side guard worked
 * perfectly on a path no owner could start.
 *
 * The episode list is the same pair the upload route itself checks with
 * (accepted ideas + a rendered final video), so a row appears here exactly when
 * the route would accept it. The operation record is OVERLAID where one exists,
 * rather than being the source: an episode is publishable because it is
 * finished, not because it has been published before.
 */
router.get('/projects/:slug/youtube/publishable', async (req, res) => {
  try {
    const slug = req.params.slug
    const channelId = await currentChannelId(slug)
    let records: YouTubeOperationRecordV1[] = []
    let operationsUnreadable = false
    try {
      records = newestOperations(await listYouTubeOperations(slug))
    } catch {
      operationsUnreadable = true
    }
    const ideas = await im.getIdeas(slug, 'accepted')

    // EVERY accepted episode, newest first. No cap.
    //
    // A 50-cap shipped here for one round and was a capability loss wearing a
    // performance fix: the legacy page that listed everything is gone, there is
    // no offset, and the owner has 854 accepted episodes — so EP0061, the exact
    // episode his own v1.4.84 release notes tell him to repair, was
    // unreachable, along with everything below the newest fifty. A truncation
    // with no door past it is tell 4, not tell 1b.
    //
    // The cost it was hiding is real and is fixed properly: ONE request-scoped
    // facts cache so project.json is read once instead of once per episode, and
    // the per-episode probes run in bounded batches instead of serially.
    const facts = createProjectFactsCache(slug)
    // Read ONCE, outside the loop. `readYouTubeProjectPublishingState` takes the
    // state lock, so calling it per episode serialised the whole sweep.
    let publishingState: Awaited<ReturnType<typeof readYouTubeProjectPublishingState>> | null = null
    let publishingStateUnreadable = false
    try {
      publishingState = await readYouTubeProjectPublishingState(slug)
    } catch {
      publishingStateUnreadable = true
    }
    // A missing or unreadable cache reads as empty: rows fall back to their receipts.
    const publicationCache = await readYouTubePublicationCache(slug).catch(() => ({}))
    let jobs: Job[] = []
    let jobsUnreadable = false
    try {
      jobs = await getJobs(slug, { type: 'youtube_upload' })
    } catch {
      jobsUnreadable = true
    }
    let planTimezone: string | undefined
    let planUnreadable = false
    if (channelId) {
      try {
        const accountId = registryCredentialFor(channelId)
        const [activePlanId, plans] = await Promise.all([
          getActivePlanId(slug, 'youtube', accountId),
          listPlans(slug),
        ])
        planTimezone = plans.find(plan => plan.id === activePlanId)?.schedule.timezone
      } catch {
        planUnreadable = true
      }
    }
    const ordered = ideas
      .filter(idea => !!idea.episode_code)
      .sort((a, b) => episodeCodeOrder(b.episode_code!) - episodeCodeOrder(a.episode_code!))

    // ponytail: the shared per-episode probe bound — the SAME number the global
    // Publishing Overview sweeps with, because this is the same sweep over the
    // same episodes. At 32 wide it queued thousands of fs calls behind the
    // running uploads' own reads and the whole app stopped answering.
    const BATCH = EPISODE_PROBE_BATCH
    const episodes: any[] = []
    for (let i = 0; i < ordered.length; i += BATCH) {
      const batch = await Promise.all(ordered.slice(i, i + BATCH).map(async (idea) => {
        const code = idea.episode_code!
        const title = idea.title || ''
        let sourceVideoPath = ''
        let renderUnknown = false
        try {
          // The exact selector shared with upload admission/execution. A broad
          // asset probe can call a clip or stale export "ready" while the
          // uploader has no source it would actually accept.
          const sourcePaths = await resolveEpisodePaths(slug, code, title, facts)
          sourceVideoPath = await findYouTubeSourceVideoPath(sourcePaths, slug, code, title, facts)
        } catch {
          renderUnknown = true
        }
        const hasVideo = !!sourceVideoPath
        // The final check's stored verdict, read from beside the rendered file it describes. One
        // small JSON read per row, and only for a row that has a rendered file at all.
        const finalCheck = sourceVideoPath ? await readStoredFinalCheck(sourceVideoPath) : null
        // Read once, so the row's line and its `running` flag describe the same moment. With no
        // rendered file there is nothing a check could have been asked about.
        const finalCheckRun = sourceVideoPath
          ? finalCheckProgress(sourceVideoPath)
          : { running: false, error: null, interrupted: false }
        const episodeOperations = records.filter(record => record.episode_code === code
          && onCurrentChannel(channelId, record.channel_id)
          && !isYouTubeVideoRemoved(publishingState ?? {}, code, record.channel_id, record.video_id))
        // A record YouTube has already failed is history: a live one describes
        // the upload that is actually on YouTube, and the failed one is only
        // fallen back to when it is all this episode has (so the row can say
        // WHY it failed).
        let operation = episodeOperations.find(record => !SUPERSEDED_LIFECYCLES.has(record.lifecycle))
          ?? episodeOperations[0]
        const job = latestEpisodeUploadJob(jobs, code, channelId)
        let sidecar: Awaited<ReturnType<typeof readSidecarStrict>> = null
        let sidecarUnreadable = ''
        try {
          sidecar = await readSidecarStrict(slug, code, 'youtube', facts)
        } catch {
          sidecarUnreadable = `Story Studio cannot read its upload record for ${code}, so it cannot tell whether the episode is already on YouTube.`
        }
        // All three stores, through the one predicate — caught PER ROW.
        //
        // `remoteVideoFor` throws when an episode's own SIDECAR cannot be read.
        // Inside a `Promise.all` an uncaught throw rejects the whole sweep, so
        // ONE corrupt `youtube_upload.json` replaced the entire Publish page
        // with a load error for all 854 episodes — a listing endpoint must
        // degrade per row, never collectively.
        //
        // The operation index and publishing state are still read only once.
        // Their failures degrade every row's REMOTE fact to unknown while the
        // local render remains visible; this catch is only for one sidecar.
        let remote = null
        let unreadable = ''
        if (!operationsUnreadable && !publishingStateUnreadable && publishingState) {
          try {
            remote = await remoteVideoFor(slug, code, title, channelId, records, publishingState, facts)
          } catch (error) {
            unreadable = (error as { detail?: string })?.detail
              || sidecarUnreadable
              || `Story Studio cannot read its upload record for ${code}, so it cannot tell whether the episode is already on YouTube.`
          }
        }
        if (remote?.video_id) {
          operation = episodeOperations.find(record => record.video_id === remote.video_id) ?? operation
        }
        const publicationOperation = remote && remote.source !== 'operation_record'
          && operation?.video_id !== remote?.video_id
          ? undefined
          : operation
        const remoteStoresUnreadable = operationsUnreadable || publishingStateUnreadable
        const storeBlockedReason = remoteStoresUnreadable
          ? REMOTE_STORE_UNREADABLE
          : jobsUnreadable
            ? UPLOAD_STORE_UNREADABLE
            : planUnreadable
              ? 'Story Studio cannot read the local upload plan.'
              : unreadable || sidecarUnreadable
        const local: YouTubeEpisodePublishableProjection['local'] = {
          render: renderUnknown
            ? { state: 'unknown' }
            : sourceVideoPath
              ? {
                  state: 'ready',
                  video_url: `/api/projects/${encodeURIComponent(slug)}/video-editor/preview-media?path=${encodeURIComponent(sourceVideoPath)}`,
                }
              : { state: 'missing' },
          upload: localUploadProjection(job, operation, operationsUnreadable || jobsUnreadable, remote),
        }
        // A completed historical job remains history after an explicit removal;
        // it must not make this episode look uploaded forever.
        const explicitlyRemoved = publishingState?.removed_videos?.some(entry =>
          entry.episode_code === code && entry.channel_id === channelId)
        if (explicitlyRemoved && !remote && !operation && local.upload.state === 'succeeded') {
          local.upload = { state: 'none' }
        }
        const writeBlockedReason = storeBlockedReason
          || (local.upload.state === 'queued'
            ? `${code} already has an upload queued.`
            : local.upload.state === 'running'
              ? `${code} already has an upload in progress.`
              : '')
        const publication = publicationProjection(
          publicationOperation,
          remote,
          publishingState,
          channelId,
          observedForEpisode(code, publicationOperation, remote, publishingState, publicationCache, channelId),
          remoteStoresUnreadable ? REMOTE_STORE_UNREADABLE : unreadable || sidecarUnreadable || undefined,
        )
        const schedule_blocked_reason = storeBlockedReason
          || !remote?.video_id
            ? storeBlockedReason || `${code} has no known current-channel YouTube video to schedule.`
            : !remote.channel_id || remote.channel_id !== channelId
              ? `${code} belongs to a different YouTube channel.`
              : publication.visibility === 'public'
                ? `${code} is public on YouTube and cannot be scheduled.`
                : publication.visibility === 'unlisted'
                  ? `${code} is unlisted on YouTube and cannot be scheduled.`
                  : undefined
        return {
          episode_code: code,
          title,
          ...(!renderUnknown ? { has_video: hasVideo } : {}),
          ...(!remoteStoresUnreadable && !unreadable && !sidecarUnreadable
            ? { has_remote_video: !!remote }
            : {}),
          ...(remote?.video_id ? { remote_video_id: remote.video_id } : {}),
          ...(remote ? { remote_source: remote.source } : {}),
          ...(operation ? { operation: publicOperation(operation) } : {}),
          local,
          ...(sourceVideoPath
            ? {
                final_check: {
                  summary: finalCheckSummary(finalCheck, finalCheckRun),
                  passed: !!finalCheck && !finalCheck.stale && finalCheck.result.passed,
                  checked: !!finalCheck,
                  stale: !!finalCheck?.stale,
                  // A check is measured in the background, so the row is where its progress and its
                  // result are read — the page reloads this row while this is true.
                  running: finalCheckRun.running,
                  issues: finalCheck?.result.issues ?? [],
                  // Which check this row is showing. An acknowledgement echoes `checked_at` back so
                  // the answer binds to this verdict about these bytes, not to whatever verdict is
                  // stored by the time the upload is admitted.
                  identity: finalCheckIdentity(finalCheck),
                } satisfies YouTubeFinalCheckProjection,
              }
            : {}),
          publication,
          can_schedule_existing: !schedule_blocked_reason,
          ...(schedule_blocked_reason ? { schedule_blocked_reason } : {}),
          plan: {
            ...(publicationOperation?.remote_snapshot?.scheduled_for
              ? { scheduled_at: publicationOperation.remote_snapshot.scheduled_for }
              : sidecar?.scheduled_for ? { scheduled_at: sidecar.scheduled_for } : {}),
            ...(planTimezone ? { timezone: planTimezone } : {}),
          },
          // The route's own refusal reason, decided ONCE here. The page used to
          // re-derive this ladder in its own order and with its own vocabulary,
          // which is two implementations of one rule (tell 7b).
          ...(writeBlockedReason
            ? { blocked_reason: writeBlockedReason }
            : remote
              ? { blocked_reason: alreadyOnYouTubeReason(code, remote) }
              : renderUnknown
                ? { blocked_reason: `${code}'s rendered video could not be checked.` }
                : !hasVideo
                ? { blocked_reason: `${code} has no rendered video yet.` }
                : {}),
        }
      }))
      episodes.push(...batch)
    }

    res.json({ episodes, total: ordered.length })
  } catch (error) {
    fail(res, error, 'Failed to read what this project can publish.')
  }
})



/**
 * Why the library is empty, or null when it is not.
 *
 * "Nothing uploaded yet", "no channel assigned" and "everything is filtered
 * out" are three different situations with three different next actions. One
 * empty list standing for all of them is the defect this feature keeps
 * producing.
 */
function emptyLibraryReason(
  hasAssignment: boolean,
  operationCount: number,
  publishedCount: number,
): 'no_channel_assigned' | 'nothing_uploaded' | 'nothing_published_yet' | null {
  if (publishedCount > 0) return null
  if (!hasAssignment) return 'no_channel_assigned'
  if (operationCount === 0) return 'nothing_uploaded'
  return 'nothing_published_yet'
}

router.get('/projects/:slug/youtube/library', async (req, res) => {
  try {
    const slug = req.params.slug
    const assignment = await getProjectYouTubeAssignment(slug)
    const current = await currentChannelId(slug)
    const records = await listYouTubeOperations(slug)
    // Only videos YouTube has actually accepted, and only on the channel this
    // project publishes to NOW. A reassigned project must not keep listing the
    // previous channel's videos as if they were still its own - spec section 19
    // scopes every read to the current immutable channel.
    // Asked through the one scoping predicate. It was `!assignment || match`
    // here - an opt-out, not a guard: with no channel assigned it kept EVERY
    // record, so a reassigned project listed the old channel's videos as its
    // own, and the non-empty list made the `no_channel_assigned` state this
    // route declares unreachable.
    const published = records.filter(record => (
      !!record.video_id && onCurrentChannel(current, record.channel_id)
    ))

    const publicationCache = await readYouTubePublicationCache(slug).catch(() => ({}))
    res.json({
      videos: published.map(record => {
        const observed = newestObservation(snapshotObservation(record), cachedObservation(publicationCache, current, record.video_id))
        return {
          ...publicOperation(record),
          comparison: compareYouTubeVideo(record),
          playlists: record.playlists,
          // What YouTube last said (snapshot or the newer cached answer). Absent = never observed.
          ...(observed ? { observed_publication: { ...observed, stale: isObservationStale(observed) } } : {}),
        }
      }),
      empty_reason: emptyLibraryReason(!!assignment, records.length, published.length),
      total: published.length,
    })
  } catch (error) {
    fail(res, error, 'Failed to read the YouTube library.')
  }
})

router.get('/projects/:slug/youtube/library/:operation_id', async (req, res) => {
  try {
    const record = await readYouTubeOperation(req.params.slug, req.params.operation_id)
    if (!record) {
      res.status(404).json({ code: 'YOUTUBE_OPERATION_NOT_FOUND', detail: 'That video is not in this project.' })
      return
    }
    res.json({
      ...publicOperation(record),
      comparison: compareYouTubeVideo(record),
      playlists: record.playlists,
    })
  } catch (error) {
    fail(res, error, 'Failed to read that video.')
  }
})

router.post('/projects/:slug/youtube/library/:operation_id/thumbnail', async (req, res) => {
  const slug = req.params.slug
  try {
    if (req.body?.confirm !== true) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Confirm this thumbnail update before sending it to YouTube.',
      })
      return
    }
    const record = await assertYouTubeOperationAuthorized(slug, req.params.operation_id)
    if (!record.video_id) {
      res.status(404).json({ code: 'YOUTUBE_OPERATION_NOT_FOUND', detail: 'That operation has no accepted YouTube video.' })
      return
    }
    const lastThumbnailAction = [...record.actions].reverse()
      .find(action => action.action === 'thumbnail_update')
    if (lastThumbnailAction?.state === 'started' || lastThumbnailAction?.state === 'uncertain') {
      res.status(409).json({
        code: 'YOUTUBE_THUMBNAIL_UPDATE_UNCERTAIN',
        detail: 'The previous thumbnail update may have reached YouTube but was not recorded. Check the video in YouTube Studio before trying again.',
      })
      return
    }
    const title = await acceptedTitleFor(slug, record.episode_code)
    const thumbnailFilename = typeof req.body?.thumbnail_filename === 'string'
      ? req.body.thumbnail_filename.trim()
      : ''
    const metadata = await resolveUploadMetadata({
      slug,
      episode_code: record.episode_code,
      fallback_title: title,
      platform: 'youtube',
      ...(thumbnailFilename ? { thumbnail_filename: thumbnailFilename } : {}),
    })
    if (!metadata.thumbnailPath) {
      res.status(404).json({
        code: 'YOUTUBE_THUMBNAIL_NOT_FOUND',
        detail: `No local thumbnail is available for ${record.episode_code}. Make or pin one first.`,
      })
      return
    }
    if (isDuplicate(slug, record.episode_code, 'youtube_thumbnail_refresh')) {
      res.status(409).json({
        code: 'YOUTUBE_THUMBNAIL_UPDATE_IN_FLIGHT',
        detail: `A thumbnail update is already queued or running for ${record.episode_code}.`,
      })
      return
    }
    const job = await enqueueOrRun({
      project_slug: slug,
      type: 'youtube_thumbnail_refresh',
      episode_id: record.episode_code,
      title: `YouTube thumbnail — ${record.episode_code}`,
      params: {
        operation_id: record.operation_id,
        ...(thumbnailFilename ? { thumbnail_filename: thumbnailFilename } : {}),
      },
    })
    res.status(201).json({
      job_id: job.job_id,
      operation_id: record.operation_id,
      episode_code: record.episode_code,
      video_id: record.video_id,
      channel_id: record.channel_id,
    })
  } catch (error) {
    fail(res, error, 'Failed to start that thumbnail update.')
  }
})

/**
 * Record a per-field decision about a disagreement with YouTube.
 *
 * `keep_youtube` is a durable override keyed by this operation and this field.
 * It never rewrites the episode's master metadata, and because it lives on the
 * operation record it cannot leak into another episode.
 *
 * `review_later` is NOT a resolution. It clears any override and lets the
 * computed comparison show through again, while keeping the date the owner
 * looked - "seen and deferred" is genuinely different from "never opened".
 *
 * It cannot be recorded by deleting the entry: the operation store merges
 * drift (`{ ...before.drift, ...after.drift }`) so a removed key is restored
 * from the previous revision. That merge is deliberate - it stops a partial
 * write losing decisions - so this works within it by overwriting the entry
 * with a non-override state, which the comparison recomputes.
 */
router.post('/projects/:slug/youtube/library/:operation_id/drift', async (req, res) => {
  try {
    const slug = req.params.slug
    const field = typeof req.body?.field === 'string' ? req.body.field : ''
    const decision = typeof req.body?.decision === 'string' ? req.body.decision : ''
    if (!(COMPARED_FIELDS as readonly string[]).includes(field)) {
      res.status(400).json({ detail: 'That is not a field this project compares with YouTube.' })
      return
    }
    if (!['use_story_studio', 'keep_youtube', 'review_later'].includes(decision)) {
      res.status(400).json({ detail: 'That is not a decision this project can record.' })
      return
    }

    // Refuse before writing if this operation is not the assigned channel's.
    const current = await assertYouTubeOperationAuthorized(slug, req.params.operation_id)

    const decidedAt = new Date().toISOString()

    // "Use Story Studio" PUSHES. Spec section 11 says so plainly, and a button
    // that records a decision without performing it is a control that does not
    // do what it says - the owner would see the difference persist forever and
    // the Overview attention count never clear.
    if (decision === 'use_story_studio') {
      if (!current.video_id || !current.final_payload) {
        res.status(409).json({
          code: 'YOUTUBE_OPERATION_NOT_FOUND',
          detail: 'That video has no accepted YouTube identity to update.',
        })
        return
      }
      // Keep the operation's already-authorized immutable channel through the
      // provider request. The credential wrapper rechecks that this channel is
      // still assigned before I/O, so a concurrent reassignment refuses rather
      // than sending this video id with a different channel's token.
      const accountId = registryCredentialFor(current.channel_id)
      // The canonical package that was sent before is the local intent, so the
      // push reuses those bytes — but re-runs the sanitizer over them first.
      // `final_payload` is frozen at accept time, so a payload captured before
      // a sanitizer rule existed still carries what that rule now removes.
      // Idempotent, so anything captured since is untouched.
      const { snippet } = resanitizeStoredSnippet(JSON.parse(current.final_payload.snippet_json))
      const status = JSON.parse(current.final_payload.status_json) as {
        privacyStatus?: 'private' | 'unlisted' | 'public'
        publishAt?: string | null
      }
      if (field === 'title') {
        await updateVideoMetadata({ slug, accountId, videoId: current.video_id, snippet: { title: snippet.title } })
      } else if (field === 'description') {
        await updateVideoMetadata({ slug, accountId, videoId: current.video_id, snippet: { description: snippet.description } })
      } else if (field === 'tags') {
        await updateVideoMetadata({ slug, accountId, videoId: current.video_id, snippet: { tags: snippet.tags } })
      } else if (field === 'privacy_status') {
        if (!status.privacyStatus) throw new Error('The accepted upload does not contain a privacy setting to restore.')
        await updateVideoMetadata({
          slug,
          accountId,
          videoId: current.video_id,
          status: {
            privacyStatus: status.privacyStatus,
            ...(status.privacyStatus === 'private' ? {} : { publishAt: null }),
          },
        })
      } else {
        await updateVideoMetadata({
          slug,
          accountId,
          videoId: current.video_id,
          status: { publishAt: status.publishAt ?? null },
        })
      }
    }

    const update = {
      project_slug: slug,
      operation_id: req.params.operation_id,
      expected_revision: current.revision,
      mutate(record: YouTubeOperationRecordV1) {
        record.drift[field] = {
          // A completed push means the field now agrees. `match` is the only
          // value Overview's attention counter treats as resolved, so writing
          // anything else here would leave the episode flagged forever.
          state: decision === 'keep_youtube'
            ? 'keep_youtube'
            : decision === 'use_story_studio' ? 'match' : 'conflict',
          decided_at: decidedAt,
        }
        // The push made YouTube match what we sent, so the local snapshot is
        // stale until the next sync. Say nothing rather than assert a value we
        // have not read back.
        if (decision === 'use_story_studio') delete record.remote_snapshot
      },
    }
    if (decision === 'use_story_studio') {
      await updatePinnedYouTubeOperation({ ...update, expected_channel_id: current.channel_id })
    } else {
      await updateYouTubeOperation(update)
    }

    const updated = await readYouTubeOperation(slug, req.params.operation_id)
    res.json({ comparison: compareYouTubeVideo(updated!), pushed: decision === 'use_story_studio' })
  } catch (error) {
    fail(res, error, 'Failed to record that decision.')
  }
})

/**
 * What a bulk playlist change would do, WITHOUT doing any of it.
 *
 * Computed entirely from the durable per-operation membership already on the
 * records, so it makes no provider request at all. Probing YouTube per video
 * would be one request per item - the exact shape that turns a fifty-episode
 * preview into fifty quota charges before the owner has agreed to anything.
 */
router.post('/projects/:slug/youtube/playlists/preview', async (req, res) => {
  try {
    const slug = req.params.slug
    const playlistId = typeof req.body?.playlist_id === 'string' ? req.body.playlist_id.trim() : ''
    if (!playlistId) {
      res.status(400).json({ detail: 'Choose a playlist first.' })
      return
    }
    // YouTube refuses membership writes to its own generated playlists.
    if (/^(WL|LL|HL)$/i.test(playlistId) || playlistId.toUpperCase().startsWith('UU')) {
      res.status(400).json({
        code: 'YOUTUBE_PLAYLIST_UNSUPPORTED',
        detail: 'That is a playlist YouTube maintains itself, so videos cannot be added to it.',
      })
      return
    }

    const requested: string[] = Array.isArray(req.body?.operation_ids)
      ? req.body.operation_ids.filter((id: unknown): id is string => typeof id === 'string')
      : []
    const records = await listYouTubeOperations(slug)
    const byId = new Map(records.map(record => [record.operation_id, record]))
    const selected = requested.length ? requested.map(id => byId.get(id)).filter(Boolean) : records

    const additions: string[] = []
    const already_present: string[] = []
    const no_video_id: string[] = []
    for (const record of selected as typeof records) {
      if (!record.video_id) { no_video_id.push(record.episode_code); continue }
      if (record.playlists[playlistId]?.state === 'present') { already_present.push(record.episode_code); continue }
      additions.push(record.operation_id)
    }

    res.json({
      playlist_id: playlistId,
      additions,
      already_present,
      no_video_id,
      unknown_operation_ids: requested.filter(id => !byId.has(id)),
      // One insert is 50 units; skips cost nothing because they are not sent.
      estimated_quota_units: additions.length * 50,
    })
  } catch (error) {
    fail(res, error, 'Failed to preview that playlist change.')
  }
})

/**
 * Apply a bulk playlist change, one video at a time, each with its own receipt.
 *
 * Partial success stays success for the items that completed. Failures are
 * reported per item and are NOT retried here - a blind restart would re-add
 * the videos that already worked. Nothing in this path can enqueue or imply a
 * video upload.
 */
router.post('/projects/:slug/youtube/playlists/apply', async (req, res) => {
  try {
    const slug = req.params.slug
    const playlistId = typeof req.body?.playlist_id === 'string' ? req.body.playlist_id.trim() : ''
    const operationIds: string[] = Array.isArray(req.body?.operation_ids)
      ? req.body.operation_ids.filter((id: unknown): id is string => typeof id === 'string')
      : []
    if (!playlistId || !operationIds.length) {
      res.status(400).json({ detail: 'Choose a playlist and at least one video.' })
      return
    }

    // The account that signs in to the ASSIGNED channel, not merely the
    // project default — see `accountForCurrentChannel`.
    const { accountId } = await accountForCurrentChannel(slug)

    const receipts: Array<{
      operation_id: string
      episode_code: string
      state: 'present' | 'failed' | 'skipped'
      receipt_id?: string
      error_code?: string
      /** The provider outcome is known, but Story Studio could not record it. */
      unrecorded?: boolean
    }> = []

    for (const operationId of operationIds) {
      const record = await readYouTubeOperation(slug, operationId)
      if (!record?.video_id) {
        receipts.push({ operation_id: operationId, episode_code: record?.episode_code ?? 'unknown', state: 'skipped', error_code: 'no_video_id' })
        continue
      }
      if (record.playlists[playlistId]?.state === 'present') {
        receipts.push({ operation_id: operationId, episode_code: record.episode_code, state: 'skipped', error_code: 'already_present' })
        continue
      }

      // Refuse anything that is not this project's current channel.
      await assertYouTubeOperationAuthorized(slug, operationId)
      const receiptId = `playlist_${randomUUID()}`

      // The provider write is its OWN try. Wrapping it together with the
      // bookkeeping write meant a successful add followed by a failed local
      // write was reported as `failed` - and because YouTube does not dedupe,
      // an owner told it failed would retry and add the video twice.
      let added = false
      let providerErrorCode: string | undefined
      try {
        await addVideoToPlaylist({ slug, accountId, playlistId, videoId: record.video_id })
        added = true
      } catch (error) {
        providerErrorCode = (error as { code?: string })?.code ?? 'provider_error'
      }

      const recorded = await updatePinnedYouTubeOperation({
        project_slug: slug, operation_id: operationId, expected_revision: record.revision,
        expected_channel_id: record.channel_id,
        mutate(current) {
          current.playlists[playlistId] = {
            operation_id: operationId,
            receipt_id: receiptId,
            state: added ? 'present' : 'failed',
            updated_at: new Date().toISOString(),
            ...(providerErrorCode ? { error_code: providerErrorCode } : {}),
          }
        },
      }).then(() => true).catch(() => false)

      receipts.push({
        operation_id: operationId,
        episode_code: record.episode_code,
        state: added ? 'present' : 'failed',
        receipt_id: receiptId,
        ...(providerErrorCode ? { error_code: providerErrorCode } : {}),
        // If the local write failed, the durable record does not know what
        // happened. Saying so is the difference between "not attempted" and
        // "attempted and unrecorded" - which a later read cannot otherwise
        // tell apart. Never retry blind on this.
        ...(recorded ? {} : { unrecorded: true }),
      })
    }

    res.json({
      playlist_id: playlistId,
      receipts,
      added: receipts.filter(receipt => receipt.state === 'present').length,
      failed: receipts.filter(receipt => receipt.state === 'failed').length,
      skipped: receipts.filter(receipt => receipt.state === 'skipped').length,
      unrecorded: receipts.filter(receipt => receipt.unrecorded).length,
    })
  } catch (error) {
    fail(res, error, 'Failed to apply that playlist change.')
  }
})

/**
 * Build the reconcile picture from what is already stored.
 *
 * Cache-first: the uploads listing comes from the last deliberate refresh, so
 * opening this screen costs nothing.
 */
async function reconcileAnalysisFor(slug: string) {
  const [records, state, assignment] = await Promise.all([
    listYouTubeOperations(slug),
    readYouTubeProjectPublishingState(slug),
    getProjectYouTubeAssignment(slug),
  ])
  const linked = state.episode_video_links
  const ignored = new Set(state.reconcile?.ignored_video_ids ?? [])
  const linkedVideoIds = new Set(Object.values(linked).map(link => link.video_id))

  // Episodes with an operation but no accepted link yet, ON THE CHANNEL THIS
  // PROJECT PUBLISHES TO NOW.
  //
  // Reassignment rewrites the registry and nothing else, so operations from a
  // previously assigned channel survive indefinitely with their accepted video
  // ids intact. Without this filter those ids read as rank-1 recorded facts and
  // auto-link — pairing the CURRENT channel with a video that belongs to a
  // different one, with no confirmation. The Library route above already scopes
  // its reads this way (spec section 19); this one has to as well.
  const episodes = records
    .filter(record => !linked[record.episode_code])
    // Same predicate. `/reconcile/apply` already refuses without an assignment,
    // so an unassigned project could otherwise see candidates it could never
    // act on - every one of them from a channel it has left.
    .filter(record => onCurrentChannel(assignment?.channel_id ?? null, record.channel_id))
    .map(record => ({
      episode_code: record.episode_code,
      ...(record.video_id ? { recorded_video_id: record.video_id } : {}),
      ...(record.final_payload
        ? { title: (() => { try { return JSON.parse(record.final_payload.snippet_json).title } catch { return undefined } })() }
        : {}),
    }))

  const cacheMatchesChannel = !!assignment && state.reconcile?.channel_id === assignment.channel_id
  const videos = (cacheMatchesChannel ? state.reconcile?.remote_videos ?? [] : [])
    .filter(video => !linkedVideoIds.has(video.video_id) && !ignored.has(video.video_id))

  return {
    analysis: analyzeYouTubeReconcile({ episodes, videos }),
    state,
    ignored: [...ignored],
    fetched_at: cacheMatchesChannel ? state.reconcile?.fetched_at ?? null : null,
    conflicts: conflictingLinks(state.episode_video_links),
  }
}

/**
 * Two episodes linked to the same video (spec section 13's "Conflict").
 *
 * Detected from the local links alone, deliberately. The other candidate for
 * "conflict" - a link pointing at a video the channel listing does not contain
 * - cannot be told apart from YouTube being briefly unreachable, and section 13
 * forbids treating an outage as removal.
 */
function conflictingLinks(links: Record<string, { video_id: string }>): Array<{ video_id: string; episode_codes: string[] }> {
  const byVideo = new Map<string, string[]>()
  for (const [episodeCode, link] of Object.entries(links)) {
    byVideo.set(link.video_id, [...(byVideo.get(link.video_id) ?? []), episodeCode])
  }
  return [...byVideo]
    .filter(([, episodeCodes]) => episodeCodes.length > 1)
    .map(([video_id, episode_codes]) => ({ video_id, episode_codes: episode_codes.sort() }))
}

router.get('/projects/:slug/youtube/reconcile', async (req, res) => {
  try {
    const { analysis, state, ignored, fetched_at, conflicts } = await reconcileAnalysisFor(req.params.slug)
    res.json({
      ...analysis,
      conflicts,
      ignored_video_ids: ignored,
      remote_listed_at: fetched_at,
      // Every "In Story Studio only" conclusion below assumes the listing was
      // the whole channel. When it was not, that assumption is what is wrong,
      // not the episode.
      remote_listing_truncated: state.reconcile?.truncated === true,
      linked_count: Object.keys(state.episode_video_links).length,
      history: state.reconciliation_history,
    })
  } catch (error) {
    fail(res, error, 'Failed to read the reconcile inventory.')
  }
})

/**
 * The ONE provider read here. Uses the channel uploads playlist, never
 * `search.list` (spec section 7), and only when asked.
 */
router.post('/projects/:slug/youtube/reconcile/remote-refresh', async (req, res) => {
  try {
    const slug = req.params.slug
    // The account that signs in to the ASSIGNED channel, not merely the
    // project default — see `accountForCurrentChannel`.
    const { accountId, channelId } = await accountForCurrentChannel(slug)
    const attemptedAt = new Date().toISOString()
    let uploads: Awaited<ReturnType<typeof listRecentUploads>>
    try {
      uploads = await listRecentUploads(slug, accountId)
    } catch (error) {
      // The last successful listing stays; only the attempt is recorded.
      await recordYouTubePublicationObservations({
        project_slug: slug, channel_id: channelId,
        listing: { attempted_at: attemptedAt, outcome: 'failed', error_code: classifyYouTubeSyncFailure(error) },
      }).catch(() => {})
      throw error
    }
    await recordYouTubeReconcileCache({
      project_slug: slug,
      channel_id: channelId,
      remote_videos: uploads.videos.map(video => ({
        video_id: video.videoId,
        ...(video.title ? { title: video.title } : {}),
        ...(video.publishedAt ? { published_at: video.publishedAt } : {}),
      })),
      truncated: uploads.truncated,
    })
    const listed = uploads.videos.filter(video => !!video.videoId)
    await recordYouTubePublicationObservations({
      project_slug: slug, channel_id: channelId,
      listing: {
        attempted_at: attemptedAt, outcome: uploads.truncated ? 'partial' : 'complete',
        videos: listed.map(video => ({
          video_id: video.videoId,
          ...(video.title ? { title: video.title } : {}),
          ...(video.publishedAt ? { published_at: video.publishedAt } : {}),
        })),
      },
    }).catch(() => {}) // the reconcile cache above is saved; this cache catches up next listing
    // The listing carries no publishAt, so ask videos.list about the listed
    // videos, bounded like the listing itself (200 videos, 4 calls).
    const details = await refreshYouTubePublications({
      project_slug: slug, account_id: accountId, channel_id: channelId, max_calls: 4,
      videos: new Map(listed.map(video => [video.videoId, { source: 'channel_listing' as const }])),
    })
    // Reported, because every conclusion drawn from this listing depends on
    // whether it is the whole channel. "In Story Studio only" means "YouTube
    // does not have this" — which is false for anything past the cap.
    res.json({
      listed: uploads.videos.length,
      truncated: uploads.truncated,
      publication_refresh: {
        outcome: details.outcome, requested: details.requested, recorded: details.recorded,
        unrequested: details.unrequested, ...(details.error_code ? { error_code: details.error_code } : {}),
      },
    })
  } catch (error) {
    fail(res, error, 'Failed to list this channel’s videos.')
  }
})

/**
 * What a bulk auto-link would do, by outcome, without doing any of it.
 * Only exact evidence can be applied, so everything else is counted as a
 * reason it cannot — never silently omitted.
 */
router.post('/projects/:slug/youtube/reconcile/preview', async (req, res) => {
  try {
    const { analysis, state } = await reconcileAnalysisFor(req.params.slug)
    const will_link: Array<{ episode_code: string; video_id: string; evidence: string }> = []
    const cannot_link: Array<{ episode_code: string; video_id: string; reason: string }> = []

    const contested = new Set([
      ...analysis.duplicates.filter(d => d.kind === 'episode').map(d => d.id),
    ])
    for (const candidate of analysis.candidates) {
      if (candidate.auto_linkable) {
        will_link.push({ episode_code: candidate.episode_code, video_id: candidate.video_id, evidence: candidate.evidence })
      } else {
        cannot_link.push({
          episode_code: candidate.episode_code,
          video_id: candidate.video_id,
          reason: contested.has(candidate.episode_code) || analysis.duplicates.some(d => d.kind === 'video' && d.id === candidate.video_id)
            ? 'possible_duplicate_needs_review'
            : 'needs_confirmation',
        })
      }
    }

    res.json({
      will_link,
      already_linked: Object.keys(state.episode_video_links).length,
      cannot_link,
      counts: { will_link: will_link.length, already_linked: Object.keys(state.episode_video_links).length, cannot_link: cannot_link.length },
    })
  } catch (error) {
    fail(res, error, 'Failed to preview the reconcile.')
  }
})

/**
 * Apply only what the preview said it would.
 *
 * Local writes only — nothing here contacts YouTube, which is why the
 * remote-success/local-failure problem cannot arise in this area at all.
 */
router.post('/projects/:slug/youtube/reconcile/apply', async (req, res) => {
  try {
    const slug = req.params.slug
    const { analysis } = await reconcileAnalysisFor(slug)
    const requested: string[] | null = Array.isArray(req.body?.episode_codes)
      ? req.body.episode_codes.filter((code: unknown): code is string => typeof code === 'string')
      : null

    const assignment = await getProjectYouTubeAssignment(slug)
    if (!assignment) {
      res.status(409).json({ code: 'YOUTUBE_CHANNEL_NOT_ASSIGNED', detail: 'Assign a YouTube channel first.' })
      return
    }

    const linked: Array<{ episode_code: string; video_id: string; decision_id: string }> = []
    const refused: Array<{ episode_code: string; reason: string }> = []

    for (const candidate of analysis.candidates) {
      if (requested && !requested.includes(candidate.episode_code)) continue
      if (!candidate.auto_linkable) {
        refused.push({ episode_code: candidate.episode_code, reason: 'needs_confirmation' })
        continue
      }
      const decision = await recordYouTubeReconcileDecision({
        project_slug: slug,
        episode_code: candidate.episode_code,
        previous_video_id: null,
        next_video_id: candidate.video_id,
      })
      await linkYouTubeEpisodeVideo({
        project_slug: slug,
        episode_code: candidate.episode_code,
        channel_id: assignment.channel_id,
        video_id: candidate.video_id,
        source: 'reconcile',
        decided_at: decision.decided_at,
      })
      linked.push({ episode_code: candidate.episode_code, video_id: candidate.video_id, decision_id: decision.decision_id })
    }

    res.json({ linked, refused, counts: { linked: linked.length, refused: refused.length } })
  } catch (error) {
    fail(res, error, 'Failed to apply the reconcile.')
  }
})

router.post('/projects/:slug/youtube/reconcile/rollback', async (req, res) => {
  try {
    const decisionId = typeof req.body?.decision_id === 'string' ? req.body.decision_id : ''
    if (!decisionId) {
      res.status(400).json({ detail: 'Name the decision to undo.' })
      return
    }
    const rolled = await rollbackYouTubeReconcileDecision({ project_slug: req.params.slug, decision_id: decisionId })
    if (!rolled) {
      res.status(409).json({ detail: 'That decision does not exist, or has already been undone.' })
      return
    }
    res.json({ decision: rolled })
  } catch (error) {
    fail(res, error, 'Failed to undo that decision.')
  }
})

router.post('/projects/:slug/youtube/reconcile/ignore', async (req, res) => {
  try {
    const videoId = typeof req.body?.video_id === 'string' ? req.body.video_id.trim() : ''
    if (!videoId) {
      res.status(400).json({ detail: 'Name the video to set aside.' })
      return
    }
    await setYouTubeReconcileIgnored({
      project_slug: req.params.slug,
      video_id: videoId,
      ignored: req.body?.ignored !== false,
    })
    res.json({ video_id: videoId, ignored: req.body?.ignored !== false })
  } catch (error) {
    fail(res, error, 'Failed to set that video aside.')
  }
})

/**
 * Refuse a comment this project does not track.
 *
 * The sibling write routes (`/library/:operation_id/drift`,
 * `/playlists/apply`) call `assertYouTubeOperationAuthorized` before touching
 * the provider; the comment writes took a bare id and sent it straight on. A
 * caller could moderate, reply to, or ban the author of ANY comment on any
 * channel the connected account can reach. One function, every caller — the
 * guard belongs where they all pass, not copied three times.
 */
async function assertCommentBelongsToProject(slug: string, commentId: string): Promise<void> {
  const state = await readYouTubeProjectPublishingState(slug)
  const known = state.comments?.comments ?? []
  const comment = known.find(entry => entry.comment_id === commentId)
  if (!comment) {
    throw new YouTubeFoundationError(
      409,
      'YOUTUBE_CHANNEL_MISMATCH',
      'That comment is not in this project’s inbox. Fetch comments again if it is new, then try once more.',
    )
  }

  // Membership is not identity. A cache written before the sweep was scoped
  // can hold a previous channel's comments, and replying to one would post to a
  // stranger's video under this channel's name — comments.insert needs no
  // ownership either. So resolve the comment to its video, the video to its
  // episode link, and the link's channel to the current assignment: the same
  // question `assertYouTubeOperationAuthorized` asks on the sibling routes.
  // Asked through the SAME function the reads filter with. Resolving it here a
  // second way (first matching link wins, rather than any matching link) let a
  // video carrying two links under different channels be listed by the read and
  // then refused by the write — one question must have one answer.
  const ours = await currentChannelVideoIds(slug)
  if (ours === null) {
    throw new YouTubeFoundationError(
      409,
      'YOUTUBE_CHANNEL_NOT_ASSIGNED',
      'Assign a YouTube channel to this project before moderating or replying.',
    )
  }
  if (!ours.has(comment.video_id)) {
    throw new YouTubeFoundationError(
      409,
      'YOUTUBE_CHANNEL_MISMATCH',
      'That comment is on a video this project no longer publishes to.',
    )
  }
}

/**
 * Does this thing belong to the channel the project publishes to NOW?
 *
 * THE single scoping predicate for this feature. Library, Reconcile, Comments
 * and Analytics all ask through it, because each of them originally shipped
 * asking in its own way and each was wrong in its own way (tell 5), and two of
 * them wrote the question as `!current || match` - a KEEP predicate that grants
 * everything when there is no channel (tell 8).
 *
 * Both defects are structurally impossible here: there is one implementation,
 * and `current === null` returns FALSE. A caller cannot accidentally write the
 * opt-out, because the opt-out is not expressible through this function.
 */
function onCurrentChannel(current: string | null, channelId: string | undefined): boolean {
  return current !== null && channelId === current
}

/**
 * The connected account whose channel IS the assigned one.
 *
 * `getDefaultAccountId` answers "which account is the default for this
 * project", which is NOT the same question as "which account speaks for the
 * channel this project publishes to". They were the same question while a
 * project had one account; with two connected accounts they diverge, and the
 * gap is invisible because every downstream check compares RECORD channel ids
 * against the assignment while the request travels on the other account's
 * token. The Analytics report is the clearest case - `ids=channel==MINE`
 * resolves to whoever the token belongs to, and the result was then stamped
 * with the assigned channel's id and cached under it.
 *
 * `generators/youtube-upload.ts` already knew this: it records
 * `provider_channel_id: account.remote_id` and warns on a mismatch. This is
 * that guard, made mandatory, in one place all four provider-touching routes
 * pass through.
 */
async function accountForCurrentChannel(slug: string): Promise<{ accountId: string, channelId: string }> {
  // Every handler that needs a credential comes through here, so the
  // unreadable-registry refusal lives here too. Guarding one handler covered
  // one of twelve; the other eleven still answered a corrupt registry with a
  // bare 500 that named nothing.
  await assertRegistryReadable()
  const current = await currentChannelId(slug)
  if (current === null) {
    throw new YouTubeFoundationError(
      409, 'YOUTUBE_CHANNEL_NOT_ASSIGNED', 'Assign a YouTube channel to this project first.',
    )
  }
  // The REGISTRY first. It is what the redesigned connect flow writes, and
  // until Phase 9 nothing read it for a provider call - so a project connected
  // only through the redesign had a valid grant that no route would use, and
  // every route refused as if the channel were not connected.
  const registry = await readYouTubeConnectionRegistry()
  const granted = registry.channels[current]
  if (granted && registry.application
    && granted.application_id === registry.application.application_id
    && granted.status === 'connected') {
    return { accountId: registryCredentialFor(current), channelId: current }
  }

  throw new YouTubeFoundationError(
    409,
    'YOUTUBE_CHANNEL_NOT_CONNECTED',
    'The assigned YouTube channel needs to be reconnected in Settings → YouTube.',
  )
}

/**
 * Refuse an upload the allowance cannot pay for, BEFORE anything is queued.
 *
 * `video_uploads` counts CALLS, not units - Phase 3 charged videos.insert's
 * 1,600 units into a 100-call bucket and exhausted it in one upload. One
 * upload is one call.
 */
/**
 * Refuse an upload outright when the connection registry will not read.
 *
 * A registry that will not READ is not a registry with no application, but the
 * two collapsed into the same "carry on": the quota preflight opened with
 * `readYouTubeConnectionRegistry().catch(() => null)` followed by
 * `if (!registry?.application) return`, so a corrupt file let every upload
 * through with no ceiling checked (tell 1). Removing that catch was not enough
 * on its own - `accountForCurrentChannel` reads the registry EARLIER on this
 * path, and threw a bare 500 that named nothing.
 *
 * So the guard goes once at the top of the handler, where every later read is
 * downstream of it, rather than at each read. The overview route already
 * refuses rather than guessing (`ledger_unreadable`); this is that refusal,
 * phrased for someone who just pressed Upload.
 */
async function assertRegistryReadable(): Promise<void> {
  try {
    await readYouTubeConnectionRegistry()
  } catch {
    throw new YouTubeFoundationError(
      503,
      'YOUTUBE_LEDGER_UNREADABLE',
      'Story Studio cannot read its YouTube connection record, so it cannot check '
      + "today's upload allowance. Nothing was uploaded.",
    )
  }
}

async function assertYouTubeUploadQuota(slug: string): Promise<void> {
  const registry = await readYouTubeConnectionRegistry()
  // No application means no ceiling to check — a real, nameable state.
  if (!registry.application) return
  // Same rule one level down: a ledger that will not read is not a ledger with room.
  const snapshot = await readYouTubeQuota(registry.application.application_id)
  const bucket = snapshot.buckets.video_uploads
  if (bucket.limit === null) return
  if (bucket.used + 1 > bucket.limit) {
    throw new YouTubeFoundationError(
      429,
      'YOUTUBE_QUOTA_EXHAUSTED',
      `Today's upload allowance is spent (${bucket.used}/${bucket.limit}). It resets at ${snapshot!.resets_at}.`,
    )
  }
}

/** Sortable numeric part of an episode code, so EP0100 beats EP0099 rather than losing to it. */
function episodeCodeOrder(code: string): number {
  // The trailing digits only. Stripping EVERY digit sorted a project whose
  // `episode_prefix` contains one (e.g. "S2EP") by the prefix's digits too.
  const match = /(\d+)\s*$/.exec(code)
  return match ? parseInt(match[1]!, 10) : 0
}

/** The title production gave this episode - what path resolution and the upload both use. */
async function acceptedTitleFor(slug: string, episodeCode: string): Promise<string> {
  const ideas = await im.getIdeas(slug, 'accepted').catch(() => [])
  return ideas.find(entry => (entry.episode_code || '') === episodeCode)?.title || ''
}

/** The channel this project publishes to now, or null when none is assigned. */
async function currentChannelId(slug: string): Promise<string | null> {
  const assignment = await getProjectYouTubeAssignment(slug)
  return assignment?.channel_id ?? null
}

/**
 * The video ids this project currently publishes to, or null when no channel is
 * assigned. The video-shaped form of the same question, for the two surfaces
 * (Comments, Analytics) whose records are keyed by video rather than by channel.
 */
async function currentChannelVideoIds(slug: string): Promise<Set<string> | null> {
  const current = await currentChannelId(slug)
  if (current === null) return null
  const state = await readYouTubeProjectPublishingState(slug)
  return new Set(
    Object.values(state.episode_video_links)
      .filter(link => onCurrentChannel(current, link.channel_id))
      .map(link => link.video_id),
  )
}

type CommentPatch = {
  moderation_status?: string
  channel_replied?: boolean
  append_reply?: { comment_id: string; author: string; text: string; from_channel: boolean }
}

/** The only moderation verbs this product has. No delete: rejection hides. */
const MODERATION_ACTIONS = ['approve', 'reject'] as const
type ModerationAction = typeof MODERATION_ACTIONS[number]

router.get('/projects/:slug/youtube/comments', async (req, res) => {
  try {
    const state = await readYouTubeProjectPublishingState(req.params.slug)
    const cache = state.comments
    // The page needs this to explain WHY fetching is unavailable, rather than
    // letting the operator press the button and collect a 409.
    const ours = await currentChannelVideoIds(req.params.slug)
    if (!cache) {
      res.json({
        comments: [], receipts: [], fetched_at: null,
        partial: false, unreached_video_ids: [], partially_read_video_ids: [],
        comments_disabled_video_ids: [],
        never_fetched: true, channel_assigned: ours !== null,
      })
      return
    }
    // Reported exactly as the sweep found it. Summarising this into "some
    // comments may be missing" would erase which videos were never reached.
    // Scoped to the current channel: a comment every action would refuse must
    // not be listed as this project's workload.
    // Every id the page RENDERS is scoped, not just the comments. A sweep run
    // before a reassignment otherwise named the old channel's videos as "never
    // opened" and "comments turned off" beside an empty list — describing a
    // channel this project no longer publishes to as its own unfinished work.
    // `receipts` stay whole: they are the historical proof of what we did.
    const mine = (ids: string[]): string[] => ids.filter(id => ours?.has(id))
    res.json({
      ...cache,
      unreached_video_ids: mine(cache.unreached_video_ids),
      partially_read_video_ids: mine(cache.partially_read_video_ids ?? []),
      comments_disabled_video_ids: mine(cache.comments_disabled_video_ids),
      comments: cache.comments.filter(comment => ours?.has(comment.video_id)),
      never_fetched: false,
      channel_assigned: ours !== null,
    })
  } catch (error) {
    fail(res, error, 'Failed to read the comment inbox.')
  }
})

/** The one provider READ here. Deliberate, and quota-charged. */
/**
 * The analytics area.
 *
 * Read-only, so the risk is not corruption - it is quietly lying. Every number
 * that leaves these routes is a MetricValue carrying its own state and age, so
 * "YouTube said 0", "we never asked", "YouTube does not offer this here" and
 * "YouTube had nothing to say" cannot collapse into one `0` on the way out.
 */
/**
 * THE analytics response. Both the read and the refresh answer through this.
 *
 * Written as one function after three rounds of review found three separate
 * defects at this one seam - a roster frozen at fetch time, a stale episode
 * CODE on a correct set of numbers, and duplicate rows for a video two episodes
 * share. Each was a local patch to a branch, and each patch created the next
 * defect. Branch parity is now a property of the construction rather than
 * something an audit has to keep re-checking.
 *
 * The rules, in one place:
 *   - the ROSTER comes from the live links, keyed by episode code;
 *   - the NUMBERS come from the cache, matched by video id;
 *   - a roster entry with no measurement is `not_fetched` - not zero, not
 *     absent, and not silently omitted from `partial`;
 *   - two episodes sharing one video are two rows, because that is a state this
 *     product models (Phase 6's "Conflict"), not a duplicate to collapse.
 */
/**
 * The reasons the analytics READ can report.
 *
 * The stored union plus `not_all_measured`, which is derived here from the
 * roster and never written - see ledger tell 11 for why this field is a scalar
 * describing two populations, and why the precedence is not to be re-litigated.
 * Declared so the producer audit can see it: a literal with a producer and no
 * declaration is tell 4 read backwards.
 */
type AnalyticsReadReason =
  | AnalyticsPartialReason
  | 'not_all_measured'

async function analyticsResponseFor(slug: string): Promise<Record<string, unknown>> {
  const current = await currentChannelId(slug)
  const state = await readYouTubeProjectPublishingState(slug)

  const empty = {
    episodes: [] as unknown[], fetched_at: null, partial: false, partial_reason: null,
    unreached_video_ids: [] as string[], start_date: null, end_date: null,
  }
  // A REFUSE predicate, never a KEEP one: with no channel there is no answer to
  // "whose numbers are these", so the declared empty state is returned rather
  // than whatever happens to be cached.
  if (current === null) {
    return { ...empty, never_fetched: true, empty_reason: 'no_channel_assigned' }
  }

  // Cache-first: opening this screen costs nothing. A cache fetched under a
  // different channel is a MISS, which reads as never-fetched rather than as
  // the previous channel's performance.
  const cached = analyticsForChannel(state, current)
  const measured = new Map((cached?.episodes ?? []).map(episode => [episode.video_id, episode]))
  // The title is the accepted idea's, read NOW - never stored with the numbers,
  // for the same reason the code is not (see below).
  const titles = new Map((await im.getIdeas(slug, 'accepted').catch(() => []))
    .filter(idea => !!idea.episode_code)
    .map(idea => [idea.episode_code!, idea.title || '']))
  // Every metric and fact the product has, not_fetched unless the cache says
  // otherwise - so a cache written before a metric existed reads as "not
  // fetched" for it, never as an absent key a renderer might print as 0.
  const allNotFetched = (names: readonly string[]) =>
    Object.fromEntries(names.map(name => [name, metricNotFetched()]))

  const episodes = Object.entries(state.episode_video_links)
    .filter(([, link]) => onCurrentChannel(current, link.channel_id))
    .map(([episodeCode, link]) => ({
      // Labelled from the LIVE link, never from the cache. The cache stored the
      // code as it was at fetch time, so a reconcile that swaps two episodes'
      // videos would otherwise show each one's real numbers under the other's
      // code - both rows wrong, and wrong in a way that reads as correct.
      episode_code: episodeCode,
      title: titles.get(episodeCode) ?? '',
      video_id: link.video_id,
      metrics: { ...allNotFetched(ANALYTICS_METRICS), ...measured.get(link.video_id)?.metrics },
      facts: { ...allNotFetched(VIDEO_FACTS), ...measured.get(link.video_id)?.facts },
    }))

  const unmeasured = [...new Set(
    episodes.filter(episode => !measured.has(episode.video_id)).map(episode => episode.video_id),
  )]

  if (!cached) {
    return {
      ...empty,
      episodes,
      never_fetched: true,
      empty_reason: episodes.length ? null : 'nothing_published_yet',
    }
  }

  // `unreached` means exactly one thing: a row on screen with no numbers. It
  // used to be the union of that with the last ATTEMPT's uncovered list - and
  // since a failed read reports EVERY id as uncovered, a quota failure on a
  // project with ninety days of measurements printed "Not covered: v1, v2, v3"
  // directly above rows showing v1-v3's numbers. The cache is merged, so what
  // the last attempt missed is no longer what the screen is missing.
  const unreached = unmeasured
  return {
    episodes,
    fetched_at: cached.fetched_at,
    partial: cached.partial || unmeasured.length > 0,
    // The CACHED reason wins. Making `not_all_measured` outrank it was wrong in
    // a way that reads as thoughtful: every failure path returns `episodes: []`,
    // so after any failed read every roster row is unmeasured and the real
    // reason was overwritten with "these episodes were published after the last
    // fetch - fetch again to measure them". A missing analytics grant, a
    // revoked token and a deterministic top-200 truncation all became advice to
    // retry, which for all three cannot work. Four of six declared reasons were
    // unreachable through this route: tell 4, manufactured by a fix for tell 4.
    partial_reason: (cached.partial_reason ?? (unmeasured.length ? 'not_all_measured' : null)) as AnalyticsReadReason | null,
    start_date: cached.start_date ?? null,
    end_date: cached.end_date ?? null,
    unreached_video_ids: unreached,
    never_fetched: false,
    empty_reason: episodes.length ? null : 'nothing_published_yet',
  }
}

router.get('/projects/:slug/youtube/analytics', async (req, res) => {
  try {
    res.json(await analyticsResponseFor(req.params.slug))
  } catch (error) {
    fail(res, error, 'Failed to read analytics.')
  }
})

/**
 * The period the owner asked for, or a plain sentence saying why it cannot be.
 * Neither date given is the default (the last 90 days). Dates are UTC calendar
 * days, as YouTube's reports are.
 */
function analyticsWindow(body: unknown): { start_date?: string, end_date?: string } | { error: string } {
  const { start_date: start, end_date: end } = (body ?? {}) as Record<string, unknown>
  if (start === undefined && end === undefined) return {}
  const real = (value: unknown): value is string => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  if (!real(start) || !real(end)) return { error: 'Choose a real start date and end date.' }
  if (start > end) return { error: 'The start date must be on or before the end date.' }
  if (end > new Date().toISOString().slice(0, 10)) return { error: 'The end date cannot be in the future.' }
  return { start_date: start, end_date: end }
}

/** The one deliberate read. Everything else here is cache-first. */
router.post('/projects/:slug/youtube/analytics/refresh', async (req, res) => {
  try {
    const slug = req.params.slug
    const period = analyticsWindow(req.body)
    if ('error' in period) {
      res.status(400).json({ code: 'ANALYTICS_PERIOD_INVALID', detail: period.error })
      return
    }
    // The account that signs in to the ASSIGNED channel, not merely the
    // project default — see `accountForCurrentChannel`.
    // `accountForCurrentChannel` has already refused an unassigned project and
    // an account that signs in elsewhere, so `channelId` here is both assigned
    // AND the one whose token this request will travel on.
    const { accountId, channelId: current } = await accountForCurrentChannel(slug)
    const registry = await readYouTubeConnectionRegistry()
    if (!registry.application) {
      res.status(409).json({ code: 'YOUTUBE_APPLICATION_NOT_CONFIGURED', detail: 'Configure a YouTube OAuth application first.' })
      return
    }

    const state = await readYouTubeProjectPublishingState(slug)
    const videoIds = [...new Set(
      Object.values(state.episode_video_links)
        .filter(link => onCurrentChannel(current, link.channel_id))
        .map(link => link.video_id),
    )]

    const analytics = await fetchProjectAnalytics({
      project_slug: slug,
      account_id: accountId,
      application_id: registry.application.application_id,
      channel_id: current,
      video_ids: videoIds,
      ...period,
    })

    await recordYouTubeAnalyticsCache({
      project_slug: slug,
      analytics: {
        fetched_at: analytics.fetched_at,
        channel_id: analytics.channel_id,
        start_date: analytics.start_date,
        end_date: analytics.end_date,
        partial: analytics.partial,
        ...(analytics.partial_reason ? { partial_reason: analytics.partial_reason } : {}),
        episodes: analytics.episodes,
      },
    })

    // Answered through the SAME builder the read uses, so the page cannot see
    // one shape after a fetch and a different one on reload.
    res.json({ fetched: analytics.episodes.length, ...(await analyticsResponseFor(slug)) })
  } catch (error) {
    fail(res, error, 'Failed to read analytics from YouTube.')
  }
})

// `GET /analytics/episodes/:code` was built and tested here and called by
// nothing. The page already renders every metric for every episode, so a
// detail endpoint added a second way to ask a question nobody was asking —
// tell 4, the same defect as Phase 5's "Use Story Studio" button and Phase 6's
// evidence rank 8. Deleted rather than left dead. Episode DETAIL proper
// (retention curve, traffic sources) is deferred with a recommendation in the
// master plan; when it is built it needs its own shape, not this stub.

router.post('/projects/:slug/youtube/comments/refresh', async (req, res) => {
  try {
    const slug = req.params.slug
    // The account that signs in to the ASSIGNED channel, not merely the
    // project default — see `accountForCurrentChannel`.
    const { accountId } = await accountForCurrentChannel(slug)
    const state = await readYouTubeProjectPublishingState(slug)
    // The assigned channel id does two jobs: it scopes WHICH videos are swept,
    // and it tells a reply from US apart from a reply from anyone else.
    const assignment = await getProjectYouTubeAssignment(slug)
    if (!assignment) {
      // Same refusal the sibling routes give. Without an assignment there is no
      // answer to "which of these videos are ours", so an unscoped sweep would
      // be the whole hole again; and with no channel id, a reply from US is
      // indistinguishable from anyone else's, so every comment would read
      // "needs reply" forever.
      res.status(409).json({ code: 'YOUTUBE_CHANNEL_NOT_ASSIGNED', detail: 'Assign a YouTube channel first.' })
      return
    }
    // Scoped to the current channel, exactly as Library and Reconcile scope
    // their reads. Reassignment leaves a previous channel's links in place, and
    // commentThreads.list needs no ownership — so an unscoped sweep would pull a
    // stranger's comments into this project's cache with this account's
    // credentials, and everything downstream would treat them as ours.
    // Deduped, as the sibling `listVideoPublicationDetails` dedupes: Phase 6
    // treats two episodes linked to one video as a real "Conflict" state, so a
    // repeated id is expected here and would otherwise be fetched twice, billed
    // twice, and listed twice under one comment id.
    const videoIds = [...new Set(
      Object.values(state.episode_video_links)
        .filter(link => link.channel_id === assignment.channel_id)
        .map(link => link.video_id),
    )]
    const inbox = await fetchCommentInbox({
      project_slug: slug, account_id: accountId, video_ids: videoIds,
      channel_id: assignment.channel_id,
      // Resume where the last sweep stopped. Without this every fetch re-reads
      // the newest batch, so a busy video can never be read past its first one.
      ...(state.page_cursors ? { cursors: state.page_cursors } : {}),
    })
    // This sweep is authoritative for every video it set out to read, so a
    // video that FINISHED has its old cursor removed rather than left behind to
    // resume past the end. Videos it never reached keep theirs.
    const sweptKeys = videoIds
      .filter(id => !inbox.unreached_video_ids.includes(id))
      .map(id => cursorKey('comments', id))
    await recordYouTubePageCursors({
      project_slug: slug, cursors: inbox.next_cursors, covered_keys: sweptKeys,
    })
    await recordYouTubeCommentCache({
      project_slug: slug,
      inbox: {
        fetched_at: inbox.fetched_at,
        partial: inbox.partial,
        ...(inbox.partial_reason ? { partial_reason: inbox.partial_reason } : {}),
        unreached_video_ids: inbox.unreached_video_ids,
        partially_read_video_ids: inbox.partially_read_video_ids,
        comments_disabled_video_ids: inbox.comments_disabled_video_ids,
        comments: inbox.comments,
      },
    })
    res.json({
      fetched: inbox.comments.length,
      partial: inbox.partial,
      ...(inbox.partial_reason ? { partial_reason: inbox.partial_reason } : {}),
      unreached_video_ids: inbox.unreached_video_ids,
      partially_read_video_ids: inbox.partially_read_video_ids,
      restarted_video_ids: inbox.restarted_video_ids,
    })
  } catch (error) {
    fail(res, error, 'Failed to read comments from YouTube.')
  }
})

/**
 * Perform one comment write and receipt it.
 *
 * The provider call is its OWN try. A write that succeeded remotely and then
 * failed to record locally is `unrecorded`, never `failed` — YouTube does not
 * undo a moderation that worked, and an owner told it failed would repeat it.
 */
async function receiptedCommentWrite(input: {
  slug: string
  commentId: string
  action: ModerationReceipt['action']
  perform: () => Promise<void>
  /**
   * What this write makes true of the comment itself, applied only when the
   * provider accepted it. A receipt alone left the list showing the action as
   * still outstanding. A thunk, so a write whose patch depends on what the
   * provider returned can build it after `perform` has run.
   */
  patch?: () => CommentPatch
}): Promise<ModerationReceipt> {
  const receipt: ModerationReceipt = {
    receipt_id: `moderation_${randomUUID()}`,
    comment_id: input.commentId,
    action: input.action,
    decided_at: new Date().toISOString(),
    outcome: 'done',
  }
  try {
    await input.perform()
  } catch (error) {
    receipt.outcome = 'failed'
    receipt.error_code = (error as { code?: string })?.code ?? 'provider_error'
  }
  const recorded = await recordYouTubeModerationReceipt({
    project_slug: input.slug,
    receipt,
    // Only a write that landed may change what the comment says it is.
    ...(receipt.outcome === 'done' && input.patch ? { patch: input.patch() } : {}),
  }).then(() => true).catch(() => false)
  if (!recorded && receipt.outcome === 'done') receipt.outcome = 'unrecorded'
  return receipt
}

router.post('/projects/:slug/youtube/comments/reply', async (req, res) => {
  try {
    const slug = req.params.slug
    const commentId = typeof req.body?.comment_id === 'string' ? req.body.comment_id.trim() : ''
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    if (!commentId || !text.trim()) {
      res.status(400).json({ detail: 'Choose a comment and write a reply.' })
      return
    }
    // The account that signs in to the ASSIGNED channel, not merely the
    // project default — see `accountForCurrentChannel`.
    const { accountId } = await accountForCurrentChannel(slug)
    await assertCommentBelongsToProject(slug, commentId)
    let posted: Awaited<ReturnType<typeof postCommentReply>> | undefined
    const receipt = await receiptedCommentWrite({
      slug, commentId, action: 'reply',
      perform: async () => { posted = await postCommentReply(slug, accountId, commentId, text) },
      // We have now answered it, so it leaves "Needs reply" — and the reply
      // itself is appended, so the thread shows what was just written instead
      // of hiding it until the operator spends quota on a full re-sweep.
      patch: () => ({
        channel_replied: true,
        ...(posted
          ? {
            append_reply: {
              comment_id: posted.id,
              author: posted.author,
              text: posted.text,
              from_channel: true,
            },
          }
          : {}),
      }),
    })
    res.json({ receipt })
  } catch (error) {
    fail(res, error, 'Failed to post that reply.')
  }
})

/**
 * Approve or reject comments. NEVER bans — banning is its own route, one
 * author at a time, so it cannot reach a bulk control by any path.
 */
router.post('/projects/:slug/youtube/comments/moderate', async (req, res) => {
  try {
    const slug = req.params.slug
    const action = typeof req.body?.action === 'string' ? req.body.action : ''
    if (!(MODERATION_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ detail: 'That is not a moderation action this project can perform.' })
      return
    }
    const commentIds: string[] = Array.isArray(req.body?.comment_ids)
      ? req.body.comment_ids.filter((id: unknown): id is string => typeof id === 'string' && !!id.trim())
      : []
    if (!commentIds.length) {
      res.status(400).json({ detail: 'Choose at least one comment.' })
      return
    }
    // The account that signs in to the ASSIGNED channel, not merely the
    // project default — see `accountForCurrentChannel`.
    const { accountId } = await accountForCurrentChannel(slug)

    // Every id is checked before ANY provider call, so a foreign id in a batch
    // refuses the batch rather than being moderated on the way past.
    for (const commentId of commentIds) await assertCommentBelongsToProject(slug, commentId)

    const receipts: ModerationReceipt[] = []
    for (const commentId of commentIds) {
      receipts.push(await receiptedCommentWrite({
        slug, commentId, action: action === 'approve' ? 'approve' : 'reject',
        patch: () => ({ moderation_status: action === 'approve' ? 'published' : 'rejected' }),
        perform: () => setCommentModerationStatus({
          slug, accountId, commentId,
          status: action === 'approve' ? 'published' : 'rejected',
          // Never here. Banning has its own route on purpose.
          banAuthor: false,
        }),
      }))
    }
    res.json({
      receipts,
      counts: {
        done: receipts.filter(r => r.outcome === 'done').length,
        failed: receipts.filter(r => r.outcome === 'failed').length,
        unrecorded: receipts.filter(r => r.outcome === 'unrecorded').length,
      },
    })
  } catch (error) {
    fail(res, error, 'Failed to moderate those comments.')
  }
})

/** What a bulk moderation would do, by outcome, before doing any of it. */
router.post('/projects/:slug/youtube/comments/moderate/preview', async (req, res) => {
  try {
    // Same refusal the write route gives. Coercing anything-not-approve to
    // `reject` meant `action: "delete"` returned a plan to reject — a preview
    // that answers a question nobody asked is worse than no preview.
    const action = typeof req.body?.action === 'string' ? req.body.action : ''
    if (!(MODERATION_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ detail: 'That is not a moderation action this project can perform.' })
      return
    }
    const state = await readYouTubeProjectPublishingState(req.params.slug)
    // Scoped exactly as the inbox read is: previewing over a former channel's
    // comments would promise changes every action then refuses.
    const ours = await currentChannelVideoIds(req.params.slug)
    const cached = (state.comments?.comments ?? []).filter(comment => ours?.has(comment.video_id))
    const byId = new Map(cached.map(comment => [comment.comment_id, comment]))
    const requested: string[] = Array.isArray(req.body?.comment_ids)
      ? req.body.comment_ids.filter((id: unknown): id is string => typeof id === 'string')
      : []

    const targetStatus = action === 'approve' ? 'published' : 'rejected'
    const will_change: string[] = []
    const already: string[] = []
    const unknown: string[] = []
    for (const id of requested) {
      const comment = byId.get(id)
      if (!comment) { unknown.push(id); continue }
      if (comment.moderation_status === targetStatus) { already.push(id); continue }
      will_change.push(id)
    }
    res.json({
      action, will_change, already_in_that_state: already, unknown_comment_ids: unknown,
      counts: { will_change: will_change.length, already: already.length, unknown: unknown.length },
    })
  } catch (error) {
    fail(res, error, 'Failed to preview that moderation.')
  }
})

/**
 * Ban an author, one at a time.
 *
 * A separate route, taking exactly one comment id, so banning can never be
 * reached from a bulk control — spec section 14 requires it to be individual and
 * separately confirmed. YouTube only accepts a ban alongside a rejection, so
 * this rejects and bans together.
 */
router.post('/projects/:slug/youtube/comments/ban', async (req, res) => {
  try {
    const slug = req.params.slug
    // The bulk refusal is checked FIRST and answers with its own code. Someone
    // who sent a list needs to be told banning is individual — not that they
    // forgot a field, which is what the generic check would have said.
    if (Array.isArray(req.body?.comment_ids)) {
      res.status(400).json({
        code: 'YOUTUBE_BAN_IS_INDIVIDUAL',
        detail: 'Authors are banned one at a time, never in bulk.',
      })
      return
    }
    const commentId = typeof req.body?.comment_id === 'string' ? req.body.comment_id.trim() : ''
    if (!commentId) {
      res.status(400).json({ detail: 'Choose the comment whose author you want to ban.' })
      return
    }
    if (req.body?.confirm !== true) {
      res.status(400).json({ detail: 'Banning an author needs an explicit confirmation.' })
      return
    }
    // The account that signs in to the ASSIGNED channel, not merely the
    // project default — see `accountForCurrentChannel`.
    const { accountId } = await accountForCurrentChannel(slug)
    await assertCommentBelongsToProject(slug, commentId)
    const receipt = await receiptedCommentWrite({
      slug, commentId, action: 'reject_and_ban',
      patch: () => ({ moderation_status: 'rejected' }),
      perform: () => setCommentModerationStatus({
        slug, accountId, commentId, status: 'rejected', banAuthor: true,
      }),
    })
    res.json({ receipt })
  } catch (error) {
    fail(res, error, 'Failed to ban that author.')
  }
})

/** Local association only. This action never deletes a video on YouTube. */
router.post('/projects/:slug/youtube/episodes/:episode_code/forget-upload', async (req, res) => {
  try {
    const slug = req.params.slug
    const episodeCode = req.params.episode_code
    if (req.body?.confirm !== true || !req.body?.expected_channel_id || !req.body?.expected_video_id) {
      res.status(400).json({ detail: 'Confirm that you deleted this exact video on YouTube before allowing a new upload.' })
      return
    }
    const { accountId, channelId } = await accountForCurrentChannel(slug)
    if (req.body.expected_channel_id !== channelId) {
      res.status(409).json({ detail: 'The YouTube channel changed. Review the episode again.' })
      return
    }
    const title = await acceptedTitleFor(slug, episodeCode)
    const jobs = await getJobs(slug, { type: 'youtube_upload' })
    if (jobs.some(job => job.type === 'youtube_upload' && job.episode_id === episodeCode
      && ['queued', 'running', 'paused'].includes(job.status))) {
      res.status(409).json({ detail: 'This episode has an upload in progress. Finish or stop that work before removing its association.' })
      return
    }
    const remote = await remoteVideoFor(slug, episodeCode, title, channelId)
    if (!remote || remote.channel_id !== channelId || remote.video_id !== req.body.expected_video_id) {
      res.status(409).json({ detail: 'The episode’s YouTube association changed. Reload and review it again.' })
      return
    }
    if (remote.lifecycle && ['preparing', 'uploading', 'accepted', 'processing'].includes(remote.lifecycle)) {
      res.status(409).json({ detail: 'YouTube has not finished this upload. Check its status before removing the association.' })
      return
    }
    // The owner's word is not enough: YouTube must confirm every video this
    // episode is known by is gone, and nothing on the channel may share its title.
    const known = (await listYouTubeOperations(slug))
      .filter(record => record.episode_code === episodeCode && record.channel_id === channelId && !!record.video_id)
    const sidecar = await readSidecarStrict(slug, episodeCode, 'youtube').catch(() => null)
    await assertSafeToUploadAgain({
      project_slug: slug,
      account_id: accountId,
      video_ids: [remote.video_id, ...known.map(record => record.video_id!), ...(sidecar?.video_id ? [sidecar.video_id] : [])],
      titles: [title, ...known.map(record => record.remote_snapshot?.title || ''), sidecar?.title || ''],
    })
    await recordYouTubeVideoRemoval({
      project_slug: slug, episode_code: episodeCode, channel_id: channelId, video_id: remote.video_id,
    })
    res.json({ episode_code: episodeCode, video_id: remote.video_id, association_removed: true })
  } catch (error) {
    fail(res, error, 'Failed to remove the local upload association.')
  }
})

router.post('/projects/:slug/youtube/preview', async (req, res) => {
  try {
    const episodeCode = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    if (!episodeCode) {
      res.status(400).json({ detail: 'An episode is required to build a preview.' })
      return
    }
    // The disclosure flag and the category are the PROJECT'S, resolved here.
    // They used to be whatever the caller sent: the page hardcoded
    // `mark_as_ai_generated: true` and sent no category, so the "exact payload"
    // panel showed a disclosure the project had turned off and a category it
    // does not use. A caller cannot be the source of a compliance statement.
    const settings = await resolveYouTubeUploadSettings(req.params.slug)
    // And the title the generator will actually use, for the same reason: it
    // resolves the accepted idea's title, so a preview built without one
    // described a different video.
    const previewTitle = await acceptedTitleFor(req.params.slug, episodeCode)
    const built = await buildYouTubeMetadataPackage({
      project_slug: req.params.slug,
      episode_code: episodeCode,
      privacy_status: req.body?.privacy_status === 'public' || req.body?.privacy_status === 'unlisted'
        ? req.body.privacy_status
        : 'private',
      ...(typeof req.body?.publish_at === 'string' && req.body.publish_at ? { publish_at: req.body.publish_at } : {}),
      ...settings,
      fallback_title: previewTitle,
      ...(typeof req.body?.thumbnail_filename === 'string' || req.body?.thumbnail_filename === null
        ? { thumbnail_filename: req.body.thumbnail_filename }
        : {}),
    })
    const thumbnail = await uploadThumbnailPreview(
      req.params.slug, episodeCode, previewTitle, built.thumbnail_filename,
    )
    const sourcePaths = await resolveEpisodePaths(req.params.slug, episodeCode, previewTitle)
    const sourcePath = await findYouTubeSourceVideoPath(sourcePaths, req.params.slug, episodeCode, previewTitle)
    // Hash only an explicitly requested review, never the episode listing.
    const source = sourcePath
      ? { filename: path.basename(sourcePath), revision: await resolveYouTubeSourceRevisionCached(sourcePath) }
      : null
    const { thumbnail_filename: _thumbnailFilename, ...payload } = built
    res.json({ ...payload, thumbnail, source })
  } catch (error) {
    fail(res, error, 'Failed to build the YouTube preview.')
  }
})

/**
 * Where the episode's spoken content stops in its final video, from the episode's own Scene Plan:
 * the merged narration the plan was timed against, or failing that the last cue it stitched.
 *
 * 0 when the episode has no plan to read — "not recorded", never a measured 0 s. The final check
 * reports a silence it cannot place as unknown rather than as speech.
 */
async function speechEndSecForEpisode(slug: string, episodeCode: string, episodeDir: string): Promise<number> {
  try {
    const planPath = await resolveScenePlanPath(slug, episodeCode, episodeDir)
    return speechEndSecFromScenePlan(JSON.parse(await fsp.readFile(planPath, 'utf-8')))
  } catch {
    return 0
  }
}

/**
 * Start the final check on an episode's finished video. The verdict is stored beside it when the
 * check finishes; this answers as soon as the check is running.
 *
 * Video Assembly runs this by itself at the end of every render; this is for the file that was made
 * before that, or for a re-check after the owner changed something. It measures against the plan the
 * sidecar recorded (the plan the file was MADE for, not today's settings). A file with no sidecar —
 * one rendered before this feature existed — still gets the checks that need no plan: black
 * stretches, silence, and the picture/sound clocks, with the speech end read from the episode's
 * Scene Plan so a silence can be placed instead of guessed at.
 *
 * 202, not 200: measuring a 2–2.5 h final is one full decode and takes minutes, and the check used
 * to run inside this request, so it died with the socket. It now runs on its own and the row the
 * page already loads carries the result — `final_check.running` while it measures, then the verdict
 * the sidecar holds. A second request for a file already being measured joins that run.
 */
router.post('/projects/:slug/youtube/final-check', async (req, res) => {
  const slug = req.params.slug
  try {
    const episodeCode = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    if (!episodeCode) {
      res.status(400).json({ detail: 'Choose an episode to check.' })
      return
    }
    const episodeTitle = await acceptedTitleFor(slug, episodeCode)
    const sourcePaths = await resolveEpisodePaths(slug, episodeCode, episodeTitle)
    const sourceVideoPath = await findYouTubeSourceVideoPath(sourcePaths, slug, episodeCode, episodeTitle)
    if (!sourceVideoPath) {
      res.status(409).json({
        code: 'YOUTUBE_NO_RENDERED_VIDEO',
        detail: `${episodeCode} has no rendered video yet.`,
      })
      return
    }
    const stored = await readStoredFinalCheck(sourceVideoPath)
    // Only a verdict that still describes THIS file's bytes is evidence about it. A verdict the file
    // has outlived would measure these bytes against the previous final's plan, tail and intro — and
    // its echoed `frozen_at` would skip the fresh resolution below that can answer for the file that
    // is actually on disk (2026-10-20).
    const recorded = freshStoredExpectation(stored)
    const expected: FinalCheckExpectation = {
      planned_sec: 0,
      tail: { sec: 0, from_end_sec: 0 },
      closing_music: false,
      width: 0,
      height: 0,
      subtitles_path: null,
      ...(recorded ?? {}),
      // Where the speech stops, so the check can tell a silence inside it from the file simply
      // ending. A render records its own narration end; a file from before that existed has no plan
      // of its own, so the episode's Scene Plan supplies the merged narration it was timed against
      // (Night Atlas Science EP0006, 2026-10-19). 0 = neither could say, and the check then reports
      // a silence it cannot place as unknown instead of calling it speech.
      speech_end_sec: Number(recorded?.speech_end_sec) > 0
        ? Number(recorded!.speech_end_sec)
        : await speechEndSecForEpisode(slug, episodeCode, sourcePaths.episode_dir),
    }
    // The planned pauses between sections, so one that shows up as silence is not read as a gap in
    // the speech (Night Atlas History EP0014: a 5 s chapter pause at 1:28:25). A render records its
    // own; an older file takes the episode's current `audio_chapters.json`.
    const sectionGaps = expected.section_gaps ?? await readPlannedSectionGaps(sourcePaths.episode_dir)
    if (sectionGaps) expected.section_gaps = sectionGaps
    // What this final's own settings put around the narration — the tail clips and the post-roll
    // after it, and where its branded intro sits — for a file that carries no plan of its own.
    //
    // Read from the FROZEN record beside the final, never from the live preset: the owner's decision
    // (2026-10-20) keeps the already-made Sprout finals on their long silent still tail while future
    // episodes drop that clip, so today's settings no longer describe this file
    // (`services/final-check-expectation.ts`). A freeze taken now, while the settings can still be
    // shown to be unchanged, is written down for every later check; a final with no freeze whose
    // settings have moved is reported as unknown rather than measured against a preset it never saw.
    if (!(Number(expected.planned_sec) > 0) && !expected.frozen_at && !expected.expectation_unknown) {
      const stat = await fsp.stat(sourceVideoPath).catch(() => null)
      const settled = await planlessExpectationFor({
        slug, episode_code: episodeCode, episode_dir: sourcePaths.episode_dir,
        video_path: sourceVideoPath, mtime_ms: stat?.mtimeMs ?? 0,
      })
      if (settled.kind === 'frozen') Object.assign(expected, expectationFromFrozenShape(settled.shape))
      else expected.expectation_unknown = settled.reason
    }
    const { started } = startFinalCheck(sourceVideoPath, expected)
    res.status(202).json({
      episode_code: episodeCode,
      // False when a check on this file was already running and this request joined it.
      started,
      running: true,
      summary: finalCheckSummary(stored, finalCheckProgress(sourceVideoPath)),
    })
  } catch (error) {
    fail(res, error, 'Failed to start the final check on that video.')
  }
})

/**
 * Read the stored verdict of an episode's final check IN FULL.
 *
 * The POST above answers 202, and the publishable row carries a reduced projection — `passed`,
 * `issues`, `identity`, `running` — so what the check actually MEASURED (expected versus actual,
 * the file it measured, each issue's own words) was only readable on disk. This is that sidecar over
 * the wire: one file beside the finished video, never a second check, so it stays bounded and safe
 * to read on a poll.
 *
 * 404 when no verdict is stored, with the row's own one-line answer saying which kind of "none" it
 * is (never asked, could not run, or a run the app restarted out of). A file with no rendered video
 * answers 409 with the same code the POST uses, so the two routes cannot disagree about why.
 */
router.get('/projects/:slug/youtube/final-check', async (req, res) => {
  const slug = req.params.slug
  try {
    const episodeCode = typeof req.query?.episode_code === 'string' ? req.query.episode_code.trim() : ''
    if (!episodeCode) {
      res.status(400).json({ detail: 'Choose an episode to check.' })
      return
    }
    const episodeTitle = await acceptedTitleFor(slug, episodeCode)
    const sourcePaths = await resolveEpisodePaths(slug, episodeCode, episodeTitle)
    const sourceVideoPath = await findYouTubeSourceVideoPath(sourcePaths, slug, episodeCode, episodeTitle)
    if (!sourceVideoPath) {
      res.status(409).json({
        code: 'YOUTUBE_NO_RENDERED_VIDEO',
        detail: `${episodeCode} has no rendered video yet.`,
      })
      return
    }
    const stored = await readStoredFinalCheck(sourceVideoPath)
    // Whether a freeze is beside the file, and what it was taken from. Carried on BOTH answers: the
    // 404 used to be returned before anything looked beside the file, so a final nobody had checked
    // yet could not say whether it had been frozen — which is exactly what a channel's own history
    // needs to be read back for (2026-10-20).
    const freeze = await finalFreezeStateFor(slug, episodeCode, episodeTitle).catch(() => null)
    if (!stored) {
      res.status(404).json({
        code: 'YOUTUBE_NO_FINAL_CHECK',
        detail: finalCheckSummary(null, finalCheckProgress(sourceVideoPath)),
        frozen_expectation: await readFrozenShape(sourceVideoPath).then(frozen => frozen?.shape ?? null),
        freeze_state: freeze,
      })
      return
    }
    res.json({
      episode_code: episodeCode,
      // True while a check is measuring this file right now; the verdict below is then the previous
      // one, which `stale` and `identity` already describe.
      running: finalCheckProgress(sourceVideoPath).running,
      stale: stored.stale,
      identity: finalCheckIdentity(stored),
      // What this final's own expectation was frozen to, when one was taken, so a plan-less final's
      // expected length and intro can be read back and verified without the app
      // (`frozenExpectationPath` holds the same record beside the file).
      frozen_expectation: await readFrozenShape(sourceVideoPath).then(frozen => frozen?.shape ?? null),
      freeze_state: freeze,
      result: stored.result,
    })
  } catch (error) {
    fail(res, error, 'Failed to read the final check result.')
  }
})

/**
 * Every final this channel has, with the freeze beside it — verdict or no verdict.
 *
 * The check's own read answers 404 before it looks beside the file, so a final that has never been
 * checked could not say whether its expectation was frozen before the channel's settings moved. That
 * is the question a channel's history has to answer — every plan-less final must have its shape
 * written down before the preset changes — so this lists them all: the freeze, what it was taken
 * from, and, when there is none, which evidence was missing.
 *
 * Read-only. It asks the same evidence chain the boot sweep uses, with `freeze: false`, so looking
 * at a channel can never take a freeze on it.
 */
router.get('/projects/:slug/youtube/freeze-states', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!getProjectDir(slug)) return res.status(404).json({ detail: 'Project not found' })
    const states = await finalFreezeStates(slug)
    res.json({
      project_slug: slug,
      finals: states.length,
      frozen: states.filter(s => s.frozen && !s.frozen.stale).length,
      unknown: states.filter(s => !s.frozen && s.unknown_reason).length,
      // A final whose verdict recorded its own plan needs no freeze: its sidecar IS the record.
      planned: states.filter(s => s.planned_sec > 0).length,
      episodes: states,
    })
  } catch (error) {
    fail(res, error, 'Failed to read the frozen expectations for that channel.')
  }
})

/**
 * Publish -> Upload. The one route that puts a video on YouTube.
 *
 * MANUAL only. It never touches `executeScheduledYouTubeUpload`; the automatic
 * scheduled boundary stays uncalled and default-off, and a tripwire test asserts
 * this path cannot reach it.
 *
 * Sibling-diffed against `/playlists/apply` and `/comments/moderate` before it
 * was written, and it carries every guard both of them have:
 *   - the credential resolves through `accountForCurrentChannel`, so the token
 *     belongs to the ASSIGNED channel (Phase 9 blocker 2);
 *   - quota is checked BEFORE the work is queued, against `video_uploads`,
 *     which counts CALLS - Phase 3's defect was charging units into it;
 *   - the package is rebuilt here rather than trusted from the client: a
 *     caller-supplied package is an authorization decision made by the caller,
 *     and a package cached past a model change is stale (tell 6 - re-sanitise
 *     on send, and assert what LEFT).
 *
 * One upload in flight per episode. A second request while an operation is
 * open is refused and NAMES the operation, because "nothing happened" and
 * "something is already happening" are different answers.
 */
router.post('/projects/:slug/youtube/upload', async (req, res) => {
  const slug = req.params.slug
  try {
    const episodeCode = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    if (!episodeCode) {
      res.status(400).json({ detail: 'Choose an episode to upload.' })
      return
    }
    if (req.body?.confirm !== true) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Uploading publishes to YouTube. Confirm the episode and channel first.',
      })
      return
    }
    const expectedChannelId = typeof req.body?.expected_channel_id === 'string'
      ? req.body.expected_channel_id.trim()
      : ''
    if (!expectedChannelId) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Preview the upload and confirm its YouTube channel first.',
      })
      return
    }
    // The channel this will publish to, and the credential that signs in to it.
    const { accountId, channelId } = await accountForCurrentChannel(slug)
    // 1.4.300 safety checks: Block refuses as before; Off/Warn let the upload go and the job logs it
    // (Warn also lists it on the job).
    const passedChecks: Array<{ check: string; message: string }> = []
    const letThrough = async (check: string, message: string): Promise<boolean> => {
      if (await safetyMode(slug, check) === 'block') return false
      passedChecks.push({ check, message })
      return true
    }
    if (expectedChannelId !== channelId && !await letThrough('right_channel',
      'The assigned YouTube channel changed after preview; uploading to the channel assigned now.')) {
      res.status(409).json({
        code: 'YOUTUBE_CHANNEL_CHANGED',
        detail: 'The assigned YouTube channel changed after preview. Preview and confirm the upload again.',
      })
      return
    }

    // FIRST, before anything about the local files.
    //
    // This used to sit after the rendered-video precondition, so a renamed
    // episode — whose video the title-derived probe could no longer find — was
    // refused as "no rendered video yet" when the true and far more important
    // answer was "this is already on YouTube". The safety-critical check does
    // not depend on a local file and must not queue behind one.
    //
    // The SAME predicate the page asked. Reading only operation records here
    // meant a legacy-sidecar episode passed this check, reached the generator,
    // and was silently PATCHed instead of uploaded — with the owner told an
    // upload had started.
    const episodeTitle = await acceptedTitleFor(slug, episodeCode)
    const existing = await remoteVideoFor(slug, episodeCode, episodeTitle, channelId)
    if (existing) {
      const record = (await listYouTubeOperations(slug))
        .find(entry => entry.episode_code === episodeCode
          && onCurrentChannel(channelId, entry.channel_id)
          && (!!entry.video_id || OPEN_LIFECYCLES.includes(entry.lifecycle)))
      res.status(409).json({
        code: existing.video_id ? 'YOUTUBE_ALREADY_PUBLISHED' : 'YOUTUBE_UPLOAD_ALREADY_IN_FLIGHT',
        detail: alreadyOnYouTubeReason(episodeCode, existing),
        remote_source: existing.source,
        ...(existing.video_id ? { video_id: existing.video_id } : {}),
        ...(record ? { operation_id: record.operation_id, lifecycle: record.lifecycle } : {}),
      })
      return
    }

    // SECOND, and still before any local-file question: has ANOTHER project
    // already uploaded this episode code to this channel? — owner decision #7
    // (2026-09-20).
    //
    // This is a WARNING the caller may click through, never a refusal. Two
    // different series may legitimately share one channel and both have an
    // "Episode 1", so a hard 409 here would block real work to catch a typo.
    // The answer comes from `video-claims.json` — the one cross-project store —
    // which now carries the episode code that made each claim (schema v2; v1
    // claims read as "episode unknown" and can never match).
    // 1.4.300 "episode number used by another project" safety check: Warn (default) asks as
    // above, Off does not ask, Block refuses even when confirmed.
    const claimMode = await safetyMode(slug, 'episode_number_claim')
    if (claimMode !== 'off' && (claimMode === 'block' || req.body?.acknowledge_foreign_episode !== true)) {
      const foreign = await findForeignEpisodeClaim({
        project_slug: slug,
        channel_id: channelId,
        episode_code: episodeCode,
      })
      if (foreign && claimMode === 'block') {
        res.status(409).json({
          code: 'YOUTUBE_EPISODE_CODE_CLAIMED_ELSEWHERE_BLOCKED',
          detail: `${episodeCode} has already been uploaded to this channel by the project "${foreign.project_slug}". `
            + 'The safety check "Episode number used by another project" is set to Block for this channel, so nothing was uploaded.',
          foreign_project_slug: foreign.project_slug,
          confirmable: false,
        })
        return
      }
      if (foreign) {
        res.status(409).json({
          code: 'YOUTUBE_EPISODE_CODE_CLAIMED_ELSEWHERE',
          detail: `${episodeCode} has already been uploaded to this channel by the project `
            + `"${foreign.project_slug}". Uploading this project's ${episodeCode} as well will put a second `
            + `video with the same episode number on the same channel. Confirm to upload anyway.`,
          foreign_project_slug: foreign.project_slug,
          confirmable: true,
        })
        return
      }
    }

    // There must be something to upload. Without this the job starts, spends
    // its guard checks, and dies at the file read — after the owner has been
    // told an upload began.
    //
    // The TITLE matters: path resolution substitutes it into the folder name,
    // so passing '' looks in `Season 001/EP0001 - /`, a directory that exists
    // for no titled episode — and every upload was refused as "no rendered
    // video". Every other caller in the tree passes the title; so does the
    // route this replaced.
    const sourcePaths = await resolveEpisodePaths(slug, episodeCode, episodeTitle)
    const sourceVideoPath = await findYouTubeSourceVideoPath(sourcePaths, slug, episodeCode, episodeTitle)
    if (!sourceVideoPath) {
      res.status(409).json({
        code: 'YOUTUBE_NO_RENDERED_VIDEO',
        detail: `${episodeCode} has no rendered video yet.`,
      })
      return
    }

    // ── The final check gate — THIS ROUTE'S ONLY ADDITION (lib/final-video-check.ts) ──────────
    //
    // Every other guard was green and the finished file was still wrong: a planned 25 s music
    // closing rendered silent, and uploads were abandoned because the file was longer than the
    // plan. The verdict is measured at the end of Video Assembly and stored beside the rendered
    // file, bound to its size and mtime, so a re-render makes it stale rather than misleading.
    //
    // Warn (the default) asks once and the owner answers: "Upload anyway" resends this same body
    // with `acknowledge_final_check`, the click-through `episode_number_claim` already uses. Off
    // skips the question; Block refuses without one. Nothing here blocks an upload permanently.
    const storedCheck = await readStoredFinalCheck(sourceVideoPath)
    // An acknowledgement may name the verdict it is answering (`final_check_checked_at`, the row's
    // own `final_check.identity.checked_at`). When it does, the answer only counts for THAT check of
    // THAT file: a re-render, or a check run again since the owner looked, means they answered about
    // something that is no longer there. A body that names no verdict is admitted exactly as before,
    // so nothing older than this field changes behaviour.
    const reviewedCheckAt = typeof req.body?.final_check_checked_at === 'string'
      ? req.body.final_check_checked_at.trim()
      : ''
    if (reviewedCheckAt && !finalCheckIdentityMatches(storedCheck, reviewedCheckAt)) {
      res.status(409).json({
        code: 'YOUTUBE_FINAL_CHECK_CHANGED',
        detail: `${episodeCode}'s finished video is not the one that check was taken on — it was `
          + 'checked again, or the file was rewritten, after you looked. Look at the check that is '
          + 'stored now and decide on that.',
        // Not confirmable: re-answering the same stale identity would fail again, and the only way
        // forward is to look at the verdict that is there now.
        confirmable: false,
        final_check: storedCheck
          ? {
              passed: storedCheck.result.passed,
              stale: storedCheck.stale,
              issues: storedCheck.result.issues,
              identity: finalCheckIdentity(storedCheck),
            }
          : { passed: false, stale: false, issues: [], identity: null },
      })
      return
    }
    const checkReason = finalCheckVerdict(storedCheck)
    if (checkReason) {
      const checkMode = await safetyMode(slug, 'final_check')
      if (checkMode !== 'off' && (checkMode === 'block' || req.body?.acknowledge_final_check !== true)) {
        res.status(409).json({
          code: 'YOUTUBE_FINAL_CHECK_FAILED',
          detail: `${episodeCode}'s finished video ${checkReason}. Upload it anyway to publish it as it is.`,
          // Block is a deliberate refusal: no click-through is offered, and none would work.
          confirmable: checkMode !== 'block',
          final_check: storedCheck
            ? {
                passed: storedCheck.result.passed,
                stale: storedCheck.stale,
                issues: storedCheck.result.issues,
                // What a click-through answers about: the caller echoes `identity.checked_at` back.
                identity: finalCheckIdentity(storedCheck),
              }
            : { passed: false, stale: false, issues: [], identity: null },
        })
        return
      }
      if (checkMode !== 'off') {
        passedChecks.push({ check: 'final_check', message: `The finished video ${checkReason}; you chose to upload it anyway.` })
      }
    }
    // The reviewed revision travels to the job. This route does NOT re-derive
    // it, and that is the whole point of this block.
    //
    // It used to read and SHA-256 the entire rendered final here — a 2-4 GB
    // read for a 96-minute 1080p render — to answer "do the bytes still match
    // what was reviewed?". On the Mac mini that read competes with the running
    // upload's own reads of the same file: measured 2026-10-18, the same POST
    // took 2.3 s when the bytes were still in the page cache and 115.6 s when
    // they were not (PR0011, job created 115.58 s after the request, past the
    // caller's 120 s timeout). The 1.4.152 size/mtime/inode cache only helps
    // while its entry survives; any move, re-copy or restart of the final
    // makes the next POST pay the full read again.
    //
    // The generator answers the SAME question better and already answers it:
    // it hashes the OPEN HANDLE it uploads from
    // (`resolveYouTubeSourceRevisionFromHandle`) and runs the same
    // `reviewed_unchanged` safety check on that digest — refusing before any
    // operation record is written, before any quota is charged and before a
    // single byte is sent. So the request path keeps the cheap question (is
    // there a rendered file at all — above) and the exact one moves to the
    // bytes actually sent.
    const reviewedSourceRevision = typeof req.body?.expected_source_revision === 'string'
      ? req.body.expected_source_revision.trim()
      : ''
    if (!reviewedSourceRevision) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Review the rendered video before confirming its upload.',
      })
      return
    }
    // Already open? Refuse and say which. `accepted` and later mean the video
    // exists on YouTube: uploading again would create a duplicate nobody asked
    // for, and YouTube has no "replace" for content.
    // "Already on YouTube" is a VIDEO ID, whatever the lifecycle says.
    // Built HERE, from the live sources, at request time. The Preview the owner
    // saw was built by the same builder from the same resolver; rebuilding is
    // what makes a model or limit change since then impossible to smuggle
    // through, and is why no package is frozen and replayed (tell 6).
    const built = await buildYouTubeMetadataPackage({
      project_slug: slug,
      episode_code: episodeCode,
      privacy_status: req.body?.privacy_status === 'public' || req.body?.privacy_status === 'unlisted'
        ? req.body.privacy_status
        : 'private',
      ...(typeof req.body?.publish_at === 'string' && req.body.publish_at ? { publish_at: req.body.publish_at } : {}),
      // Same resolver the preview used, so the two cannot disagree.
      ...(await resolveYouTubeUploadSettings(slug)),
      fallback_title: episodeTitle,
      ...(typeof req.body?.thumbnail_filename === 'string' || req.body?.thumbnail_filename === null
        ? { thumbnail_filename: req.body.thumbnail_filename }
        : {}),
    })
    const expectedPackageRevision = typeof req.body?.expected_package_revision === 'string'
      ? req.body.expected_package_revision.trim()
      : ''
    if (!expectedPackageRevision) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Preview the exact YouTube upload details before confirming.',
      })
      return
    }
    if (expectedPackageRevision !== built.package_revision && !await letThrough('reviewed_unchanged',
      'The YouTube upload details changed after preview; uploading the details as they are now.')) {
      res.status(409).json({
        code: 'YOUTUBE_PREVIEW_STALE',
        detail: 'The YouTube upload details changed after preview. Preview and confirm the upload again.',
      })
      return
    }
    // A reviewed publish_at is an explicit scheduling choice for THIS upload.
    // Keep ordinary no-date uploads on the configured private/apply-plan mode.
    const approvedUploadMode = built.status.publishAt ? 'apply-plan' : await getUploadMode(slug, 'youtube')

    // Pre-upload channel eligibility (owner-approved, 2026-10-19).
    //
    // Domnak DM0001–DM0003: YouTube ACCEPTED three uploads from a channel that
    // was not verified for long videos and then abandoned every one of them as
    // "too long". The refusal belongs HERE — before anything is queued, in words
    // that name the fix — not twenty minutes later as a provider verdict. A
    // channel we cannot ask about is never refused.
    const preflight = await preflightYouTubeChannel({
      project_slug: slug, account_id: accountId, channel_id: channelId, file_path: sourceVideoPath,
    })
    if (preflight.refusal && req.body?.acknowledge_unverified_channel !== true) {
      res.status(409).json({
        code: 'YOUTUBE_CHANNEL_NOT_VERIFIED_FOR_LONG_VIDEOS',
        detail: preflight.refusal,
        channel_eligibility: preflight.eligibility,
        confirmable: true,
      })
      return
    }

    // Before the job, not inside it. A job queued against an exhausted
    // allowance fails later, somewhere the owner is not looking.
    await assertYouTubeUploadQuota(slug)

    const job = await enqueueOrRun({
      project_slug: slug,
      type: 'youtube_upload',
      episode_id: episodeCode,
      params: {
        episode_id: episodeCode,
        account_id: accountId,
        expected_channel_id: channelId,
        expected_package_revision: built.package_revision,
        // The revision the owner actually reviewed. The generator compares it
        // with the hash of the open handle it uploads from and runs the
        // `reviewed_unchanged` safety check on that comparison — the same
        // check, on the bytes that are sent, instead of on a second read of
        // the whole file in the request.
        expected_source_revision: reviewedSourceRevision,
        approved_final_payload: built.final_payload,
        approved_upload_mode: approvedUploadMode,
        ...(built.thumbnail_filename !== undefined ? { thumbnail_filename: built.thumbnail_filename } : {}),
        privacy_status: built.status.privacyStatus,
        // `scheduled_for`, not `publish_at` — that is the key the generator
        // reads. Emitting the wrong one uploaded a scheduled episode as private
        // with no transition date, so it would have stayed private forever.
        ...(built.status.publishAt ? { scheduled_for: built.status.publishAt } : {}),
        ...(passedChecks.length ? { safety_warnings: passedChecks } : {}),
      },
    })

    res.json({
      job_id: job.job_id,
      episode_code: episodeCode,
      channel_id: channelId,
      privacy_status: built.status.privacyStatus,
    })
  } catch (error) {
    fail(res, error, 'Failed to start that upload.')
  }
})

type UploadCenterPlanAssignment = { episode_code: string, publishAt: string, previous_publish_at?: string }

type UploadCenterPlanPreview = {
  plan_id: string
  channel_id: string
  ordered_episode_codes: string[]
  assignments: UploadCenterPlanAssignment[]
  /** Episodes whose date differs from plain walk order because dates follow episode order. */
  order_shifted: string[]
  skipped_existing: string[]
  latest_existing_claim: string | null
  schedule: Record<string, string>
  sidecar_schedule: Record<string, string | null>
}

function scheduleRouteError(statusCode: number, detail: string): Error & { statusCode: number } {
  return Object.assign(new Error(detail), { statusCode })
}

async function previewUploadCenterPlan(
  slug: string,
  expectedChannelId: string,
  planId: string,
  episodeCodes: unknown,
): Promise<UploadCenterPlanPreview> {
  if (!expectedChannelId) {
    throw new YouTubeFoundationError(
      400, 'YOUTUBE_CHANNEL_NOT_ASSIGNED', 'Review the YouTube channel before planning publication times.',
    )
  }
  if (!planId) throw scheduleRouteError(400, 'Choose an active YouTube upload plan.')
  const { accountId, channelId } = await accountForCurrentChannel(slug)
  if (expectedChannelId !== channelId) {
    throw new YouTubeFoundationError(
      409, 'YOUTUBE_ASSIGNMENT_CHANGED', 'The assigned YouTube channel changed. Reload the Upload Center and preview again.',
    )
  }
  const [plan, activePlanId] = await Promise.all([
    getPlan(slug, planId),
    getActivePlanId(slug, 'youtube', accountId),
  ])
  if (!plan || plan.platform !== 'youtube' || plan.account_id !== accountId || activePlanId !== plan.id) {
    throw scheduleRouteError(409, 'The selected plan is no longer active for this YouTube channel. Reload the Upload Center and choose the active plan.')
  }
  const requested = orderEpisodeCodes(Array.isArray(episodeCodes) ? episodeCodes : [])
  if (!requested.length) throw scheduleRouteError(400, 'Choose one or more episodes to plan.')
  const acceptedIdeas = await im.getIdeas(slug, 'accepted')
  const accepted = new Set(acceptedIdeas
    .map(idea => idea.episode_code)
    .filter((code): code is string => !!code))
  const unknown = requested.find(code => !accepted.has(code))
  if (unknown) throw scheduleRouteError(404, `${unknown} is not an accepted episode.`)

  // A local plan claim is movable only while it is still local planning data.
  // Queue state and any canonical/legacy YouTube evidence belong to the
  // upload/publication flows and must never be reassigned by this local save.
  const [schedule, jobs, operations, publishingState, publicationCache] = await Promise.all([
    readItemSchedule(slug),
    getJobs(slug, { type: 'youtube_upload' }),
    listYouTubeOperations(slug),
    readYouTubeProjectPublishingState(slug),
    readYouTubePublicationCache(slug).catch(() => ({})),
  ])
  const activeUploadCodes = new Set(jobs
    .filter(job => job.type === 'youtube_upload'
      && ['queued', 'running', 'paused'].includes(job.status))
    .map(job => job.episode_id))
  const remoteByCode = new Map<string, Awaited<ReturnType<typeof remoteVideoFor>>>()
  const missingRemoteCandidates = new Set<string>()
  const now = Date.now()
  const facts = createProjectFactsCache(slug)
  const sidecar_schedule: Record<string, string | null> = {}
  for (const code of requested) {
    if (activeUploadCodes.has(code)) continue
    const scheduledAt = schedule[code]
    if (scheduledAt && Number.isFinite(Date.parse(scheduledAt)) && Date.parse(scheduledAt) > now) continue
    sidecar_schedule[code] = (await readSidecarStrict(slug, code, 'youtube', facts))?.scheduled_for ?? null
    const idea = acceptedIdeas.find(candidate => candidate.episode_code === code)
    const remote = await remoteVideoFor(
      slug, code, idea?.title || '', channelId, operations, publishingState, facts,
    )
    if (!remote) continue
    remoteByCode.set(code, remote)
    const operation = operations.find(record => record.episode_code === code
      && onCurrentChannel(channelId, record.channel_id)
      && !isYouTubeVideoRemoved(publishingState, code, record.channel_id, record.video_id)
      && (record.video_id?.trim() === remote.video_id
        || (remote.source === 'operation_record'
          && !remote.video_id && OPEN_LIFECYCLES.includes(record.lifecycle))))
    const publication = publicationProjection(
      operation, remote, publishingState, channelId,
      observedForEpisode(code, operation, remote, publishingState, publicationCache, channelId),
    )
    if (publication.state === 'uploaded'
      && !publication.scheduled_at
      && publication.visibility !== 'public'
      && publication.visibility !== 'unlisted') {
      missingRemoteCandidates.add(code)
    }
  }
  const overdue = requested.filter(code => {
    const value = schedule[code]
    return !!value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now
      && !activeUploadCodes.has(code)
      && !remoteByCode.has(code)
  })
  const overdueCodes = new Set(overdue)
  const missing = requested.filter(code => !schedule[code]
    && !activeUploadCodes.has(code)
    && (!remoteByCode.has(code) || missingRemoteCandidates.has(code)))
  const candidateCodes = new Set([...overdue, ...missing])
  const candidates = requested.filter(code => candidateCodes.has(code))
  const skipped_existing = requested.filter(code => !!schedule[code] && !candidateCodes.has(code))
  const latestMs = candidates.length
    ? await latestFutureProjectClaimMs(slug, 'youtube', candidateCodes)
    : 0
  const slots = candidates.length
    ? computeSlots(plan.schedule, candidates.length, {
        notBefore: new Date(now),
        ...(latestMs ? { minStartDate: new Date(latestMs) } : {}),
      })
    : []
  if (slots.length < candidates.length) {
    throw scheduleRouteError(400, `Plan "${plan.name}" cannot generate ${candidates.length} future slot(s).`)
  }
  const past = slots.find(slot => Date.parse(slot) <= now)
  if (past) throw scheduleRouteError(400, `Plan "${plan.name}" produced a past publish time (${past}).`)

  // Dates follow episode order. The new slots and every future date of an
  // episode not on YouTube yet are handed back out in episode-code order, so a
  // lower-numbered episode planned late takes the earliest of them. Episodes
  // already on YouTube or uploading are not in the pool and keep their dates.
  const fresh: Record<string, string> = {}
  candidates.forEach((code, index) => { fresh[code] = slots[index]! })
  const movable = candidates.length ? await movableLocalClaims(slug, channelId, schedule, now) : {}
  for (const code of candidateCodes) delete movable[code]
  const shifts = episodeOrderShifts({ ...movable, ...fresh })
  const shiftedExisting = Object.keys(shifts).filter(code => !candidateCodes.has(code))
  for (const code of shiftedExisting) {
    sidecar_schedule[code] = (await readSidecarStrict(slug, code, 'youtube', facts))?.scheduled_for ?? null
  }
  const assigned = orderEpisodeCodes([...candidates, ...shiftedExisting])
  return {
    plan_id: plan.id,
    channel_id: channelId,
    ordered_episode_codes: requested,
    assignments: assigned.map(episode_code => ({
      episode_code,
      publishAt: shifts[episode_code] ?? fresh[episode_code]!,
      ...(overdueCodes.has(episode_code) || !candidateCodes.has(episode_code)
        ? { previous_publish_at: schedule[episode_code]! }
        : {}),
    })),
    order_shifted: orderEpisodeCodes(Object.keys(shifts)),
    skipped_existing,
    latest_existing_claim: latestMs ? new Date(latestMs).toISOString() : null,
    schedule,
    sidecar_schedule,
  }
}

function publicPlanPreview(preview: UploadCenterPlanPreview) {
  const { plan_id, channel_id, ordered_episode_codes, assignments, order_shifted, skipped_existing, latest_existing_claim } = preview
  return { plan_id, channel_id, ordered_episode_codes, assignments, order_shifted, skipped_existing, latest_existing_claim }
}

function sameAssignments(actual: UploadCenterPlanAssignment[], expected: unknown): boolean {
  if (!Array.isArray(expected) || expected.length !== actual.length) return false
  return actual.every((assignment, index) => {
    const candidate = expected[index]
    return !!candidate && typeof candidate === 'object'
      && (candidate as Record<string, unknown>).episode_code === assignment.episode_code
      && (candidate as Record<string, unknown>).publishAt === assignment.publishAt
      && (candidate as Record<string, unknown>).previous_publish_at === assignment.previous_publish_at
  })
}

/** Read-only exact plan assignment for Upload Center's selected local rows. */
router.post('/projects/:slug/youtube/plan/preview', async (req, res) => {
  try {
    const preview = await previewUploadCenterPlan(
      req.params.slug,
      typeof req.body?.expected_channel_id === 'string' ? req.body.expected_channel_id.trim() : '',
      typeof req.body?.plan_id === 'string' ? req.body.plan_id.trim() : '',
      req.body?.episode_codes,
    )
    res.json(publicPlanPreview(preview))
  } catch (error) {
    fail(res, error, 'Failed to preview this YouTube plan.')
  }
})

/**
 * Persist only the exact, previously previewed local claims. This intentionally
 * makes no YouTube request: existing remote videos are scheduled individually
 * after their live private status and ETag have been checked.
 */
router.post('/projects/:slug/youtube/plan/apply', async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Confirm the exact YouTube plan assignments before saving them.',
      })
      return
    }
    const projectDir = getProjectDir(req.params.slug)
    if (!projectDir) throw scheduleRouteError(404, 'That project no longer exists.')
    const result = await withLock(path.join(projectDir, 'youtube', 'upload-center-plan.lock'), async () => {
      // Recompute and fence while holding this endpoint's schedule lock. Each
      // claim writes only its own sidecar field, so an unrelated legacy plan
      // writer cannot be erased by a stale complete-map replacement.
      const preview = await previewUploadCenterPlan(
        req.params.slug,
        typeof req.body?.expected_channel_id === 'string' ? req.body.expected_channel_id.trim() : '',
        typeof req.body?.plan_id === 'string' ? req.body.plan_id.trim() : '',
        req.body?.episode_codes,
      )
      if (!sameAssignments(preview.assignments, req.body?.expected_assignments)) {
        return { stale: true as const, preview }
      }
      const titles = new Map((await im.getIdeas(req.params.slug, 'accepted'))
        .filter(idea => !!idea.episode_code)
        .map(idea => [idea.episode_code!, idea.title || '']))
      const jobs = await getJobs(req.params.slug, { type: 'youtube_upload' })
      for (const assignment of preview.assignments) {
        const active = jobs.some(job => job.type === 'youtube_upload'
          && job.episode_id === assignment.episode_code
          && ['queued', 'running', 'paused'].includes(job.status))
        if (active) throw scheduleRouteError(409, `${assignment.episode_code} now has an upload in progress. Refresh and review its plan again.`)
      }
      await applyScheduleAssignmentsWithRollback(
        preview.assignments,
        preview.sidecar_schedule,
        (episodeCode, scheduledFor, expected) => setScheduledFor(
          req.params.slug, episodeCode, titles.get(episodeCode) || '', 'youtube', scheduledFor, expected,
        ),
      )
      return { stale: false as const, preview }
    })
    if (result.stale) {
      res.status(409).json({
        code: 'YOUTUBE_PLAN_PREVIEW_STALE',
        detail: 'The available YouTube plan slots changed. Preview the selected episodes again before saving.',
        ...publicPlanPreview(result.preview),
      })
      return
    }
    res.json(publicPlanPreview(result.preview))
  } catch (error) {
    if (failScheduleBatch(res, error)) return
    fail(res, error, 'Failed to save this YouTube plan.')
  }
})

// ── Re-lay planned dates ──────────────────────────────────────────────────
//
// The gap this closes: `previewUploadCenterPlan` treats a FUTURE local claim as
// untouchable (`if (scheduledAt > now) continue`, reported as `skipped_existing`)
// and `canPlanEpisode` in the publish page refuses the same episodes, so a video
// that was handed a date it should not have kept could never be re-dated from
// any surface. That rule is right for "plan what is unscheduled" and useless for
// "fix the dates I already have", which is a different customer intent.
//
// Two properties are deliberate, not incidental:
//
//   YOUTUBE IS NEVER TOUCHED. Only local planned dates move. An episode that
//   already exists on the channel is reported in `skipped` rather than
//   re-dated, because a local date disagreeing with a live `publishAt` is worse
//   than no local date at all — that video's own schedule owns its time, and
//   pretending otherwise would make the row lie.
//
//   OTHER EPISODES KEEP THEIR SLOTS. Days already claimed by an episode outside
//   the selection are handed to `computeSlots` as blocked, so the re-lay flows
//   around them rather than double-booking, and the preview names the days it
//   stepped over. The customer's chosen start date is a floor, never a
//   permission to collide.

type UploadCenterRelayoutSkip = { episode_code: string, reason: string }

type UploadCenterRelayoutPreview = {
  plan_id: string
  channel_id: string
  start_date: string
  timezone: string
  ordered_episode_codes: string[]
  assignments: UploadCenterPlanAssignment[]
  skipped: UploadCenterRelayoutSkip[]
  occupied_days: string[]
  schedule: Record<string, string>
  sidecar_schedule: Record<string, string | null>
}

/** `YYYY-MM-DD` that round-trips, so `2026-02-31` is refused rather than rolled over. */
function isValidStartDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

async function relayoutUploadCenterPlan(
  slug: string,
  expectedChannelId: string,
  planId: string,
  episodeCodes: unknown,
  startDate: string,
): Promise<UploadCenterRelayoutPreview> {
  if (!expectedChannelId) {
    throw new YouTubeFoundationError(
      400, 'YOUTUBE_CHANNEL_NOT_ASSIGNED', 'Review the YouTube channel before editing planned publication times.',
    )
  }
  if (!planId) throw scheduleRouteError(400, 'Choose an active YouTube upload plan.')
  if (!isValidStartDate(startDate)) throw scheduleRouteError(400, 'Choose a valid starting date (YYYY-MM-DD).')

  const { accountId, channelId } = await accountForCurrentChannel(slug)
  if (expectedChannelId !== channelId) {
    throw new YouTubeFoundationError(
      409, 'YOUTUBE_ASSIGNMENT_CHANGED', 'The assigned YouTube channel changed. Reload the Upload Center and preview again.',
    )
  }
  const [plan, activePlanId] = await Promise.all([
    getPlan(slug, planId),
    getActivePlanId(slug, 'youtube', accountId),
  ])
  if (!plan || plan.platform !== 'youtube' || plan.account_id !== accountId || activePlanId !== plan.id) {
    throw scheduleRouteError(409, 'The selected plan is no longer active for this YouTube channel. Reload the Upload Center and choose the active plan.')
  }

  const requested = orderEpisodeCodes(Array.isArray(episodeCodes) ? episodeCodes : [])
  if (!requested.length) throw scheduleRouteError(400, 'Choose one or more episodes to re-date.')
  const acceptedIdeas = await im.getIdeas(slug, 'accepted')
  const accepted = new Set(acceptedIdeas
    .map(idea => idea.episode_code)
    .filter((code): code is string => !!code))
  const unknown = requested.find(code => !accepted.has(code))
  if (unknown) throw scheduleRouteError(404, `${unknown} is not an accepted episode.`)

  const [schedule, jobs, operations, publishingState] = await Promise.all([
    readItemSchedule(slug),
    getJobs(slug, { type: 'youtube_upload' }),
    listYouTubeOperations(slug),
    readYouTubeProjectPublishingState(slug),
  ])
  const activeUploadCodes = new Set(jobs
    .filter(job => job.type === 'youtube_upload'
      && ['queued', 'running', 'paused'].includes(job.status))
    .map(job => job.episode_id))
  const facts = createProjectFactsCache(slug)

  const skipped: UploadCenterRelayoutSkip[] = []
  const sidecar_schedule: Record<string, string | null> = {}
  const movable: string[] = []
  for (const code of requested) {
    if (activeUploadCodes.has(code)) {
      skipped.push({
        episode_code: code,
        reason: `${code} has an upload in progress, so its date is left alone until that finishes.`,
      })
      continue
    }
    const idea = acceptedIdeas.find(candidate => candidate.episode_code === code)
    const remote = await remoteVideoFor(slug, code, idea?.title || '', channelId, operations, publishingState, facts)
    if (remote) {
      skipped.push({
        episode_code: code,
        reason: `${code} already exists on YouTube. This action changes planned dates only, so that video's real publish time is unchanged — edit it from the video's own schedule.`,
      })
      continue
    }
    sidecar_schedule[code] = (await readSidecarStrict(slug, code, 'youtube', facts))?.scheduled_for ?? null
    movable.push(code)
  }

  const tz = plan.schedule.timezone
  const now = Date.now()
  const movableSet = new Set(movable)
  // Only episodes being MOVED keep quiet: an episode that already holds a slot
  // reserves it, whichever side of `now` the booking was made. Past claims are
  // free again (they belong to history, not to the calendar ahead).
  const occupied = new Set<string>()
  for (const [code, value] of Object.entries(schedule)) {
    if (movableSet.has(code)) continue
    const at = Date.parse(value)
    if (!Number.isFinite(at) || at <= now) continue
    occupied.add(localDayKeyInTz(new Date(at), tz))
  }

  const slots = movable.length
    ? computeSlots(
      { ...plan.schedule, start_date: startDate },
      movable.length,
      { notBefore: new Date(now), blockedDays: occupied },
    )
    : []
  if (slots.length < movable.length) {
    const held = occupied.size ? ` ${occupied.size} day(s) are already held by other episodes.` : ''
    throw scheduleRouteError(
      400,
      `Plan "${plan.name}" cannot fit ${movable.length} video(s) from ${startDate}.${held} Choose a later start date.`,
    )
  }

  return {
    plan_id: plan.id,
    channel_id: channelId,
    start_date: startDate,
    timezone: tz,
    ordered_episode_codes: requested,
    assignments: movable.map((episode_code, index) => {
      // Previous is reported for a FUTURE claim too — unlike the plan flow,
      // where only overdue dates are worth showing. Re-dating is precisely the
      // case where the customer must see what each date is changing FROM.
      const previous = schedule[episode_code]
      return {
        episode_code,
        publishAt: slots[index]!,
        ...(previous ? { previous_publish_at: previous } : {}),
      }
    }),
    skipped,
    occupied_days: Array.from(occupied).sort(),
    schedule,
    sidecar_schedule,
  }
}

function publicRelayoutPreview(preview: UploadCenterRelayoutPreview) {
  const { plan_id, channel_id, start_date, timezone, ordered_episode_codes, assignments, skipped, occupied_days } = preview
  return { plan_id, channel_id, start_date, timezone, ordered_episode_codes, assignments, skipped, occupied_days }
}

/** Read-only re-lay proposal for the selected local episodes. */
router.post('/projects/:slug/youtube/plan/relayout/preview', async (req, res) => {
  try {
    const preview = await relayoutUploadCenterPlan(
      req.params.slug,
      typeof req.body?.expected_channel_id === 'string' ? req.body.expected_channel_id.trim() : '',
      typeof req.body?.plan_id === 'string' ? req.body.plan_id.trim() : '',
      req.body?.episode_codes,
      typeof req.body?.start_date === 'string' ? req.body.start_date.trim() : '',
    )
    res.json(publicRelayoutPreview(preview))
  } catch (error) {
    fail(res, error, 'Failed to preview those planned dates.')
  }
})

/**
 * Persist only the exact re-lay that was previewed. Local planned dates only:
 * this makes no YouTube request by design, so a video that already exists on the
 * channel is reported in `skipped` instead of being re-dated behind YouTube.
 */
router.post('/projects/:slug/youtube/plan/relayout/apply', async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Confirm the exact planned dates before saving them.',
      })
      return
    }
    const slug = req.params.slug
    const projectDir = getProjectDir(slug)
    if (!projectDir) throw scheduleRouteError(404, 'That project no longer exists.')
    const result = await withLock(path.join(projectDir, 'youtube', 'upload-center-plan.lock'), async () => {
      // Recompute under the lock so the fence compares against today's facts,
      // not the ones the preview saw. A claim writes only its own sidecar
      // field, so no complete-map replacement can erase a concurrent writer.
      const preview = await relayoutUploadCenterPlan(
        slug,
        typeof req.body?.expected_channel_id === 'string' ? req.body.expected_channel_id.trim() : '',
        typeof req.body?.plan_id === 'string' ? req.body.plan_id.trim() : '',
        req.body?.episode_codes,
        typeof req.body?.start_date === 'string' ? req.body.start_date.trim() : '',
      )
      if (!sameAssignments(preview.assignments, req.body?.expected_assignments)) {
        return { stale: true as const, preview }
      }
      const titles = new Map((await im.getIdeas(slug, 'accepted'))
        .filter(idea => !!idea.episode_code)
        .map(idea => [idea.episode_code!, idea.title || '']))
      const jobs = await getJobs(slug, { type: 'youtube_upload' })
      for (const assignment of preview.assignments) {
        const active = jobs.some(job => job.type === 'youtube_upload'
          && job.episode_id === assignment.episode_code
          && ['queued', 'running', 'paused'].includes(job.status))
        if (active) throw scheduleRouteError(409, `${assignment.episode_code} now has an upload in progress. Refresh and preview its dates again.`)
      }
      await applyScheduleAssignmentsWithRollback(
        preview.assignments,
        preview.sidecar_schedule,
        (episodeCode, scheduledFor, expected) => setScheduledFor(
          slug, episodeCode, titles.get(episodeCode) || '', 'youtube', scheduledFor, expected,
        ),
      )
      return { stale: false as const, preview }
    })
    if (result.stale) {
      res.status(409).json({
        code: 'YOUTUBE_PLAN_PREVIEW_STALE',
        detail: 'The planned dates changed since the preview. Preview those episodes again before saving.',
        ...publicRelayoutPreview(result.preview),
      })
      return
    }
    res.json(publicRelayoutPreview(result.preview))
  } catch (error) {
    if (failScheduleBatch(res, error)) return
    fail(res, error, 'Failed to save those planned dates.')
  }
})

function normalizeFutureScheduleTime(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return null
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return null
  const instant = Date.parse(value)
  if (!Number.isFinite(instant) || instant <= Date.now()) return null
  return new Date(instant).toISOString()
}

/**
 * Change one current-channel video's visibility on YouTube and record exactly
 * what YouTube confirmed. Shared by Schedule and Set visibility (bulk Publish
 * actions use both) so the identity, channel and receipt rules cannot drift
 * between the two routes. `publishAt` set means a private schedule.
 */
type VisibilityOutcome =
  | { status: number; error: { code: string; detail: string } }
  | { recorded: boolean; response: Record<string, unknown> }

async function applyVideoVisibility(input: {
  slug: string
  episodeCode: string
  expectedChannelId: string
  privacy: 'private' | 'public' | 'unlisted'
  publishAt: string | null
  requirePrivacyStatus?: 'private'
  verb: string
}): Promise<VisibilityOutcome> {
  const { slug, episodeCode, expectedChannelId, privacy, publishAt, requirePrivacyStatus, verb } = input
  const idea = (await im.getIdeas(slug, 'accepted')).find(entry => entry.episode_code === episodeCode)
  if (!idea) {
    return { status: 404, error: { code: 'YOUTUBE_OPERATION_NOT_FOUND', detail: 'That episode is not accepted for YouTube publishing.' } }
  }
  const { accountId, channelId } = await accountForCurrentChannel(slug)
  if (expectedChannelId !== channelId) {
    return { status: 409, error: { code: 'YOUTUBE_CHANNEL_CHANGED', detail: 'The assigned YouTube channel changed. Reload the Upload Center and confirm again.' } }
  }
  const [records, publishingState] = await Promise.all([
    listYouTubeOperations(slug),
    readYouTubeProjectPublishingState(slug),
  ])
  const remote = await remoteVideoFor(slug, episodeCode, idea.title || '', channelId, records, publishingState)
  if (!remote?.video_id) {
    return { status: 404, error: { code: 'YOUTUBE_OPERATION_NOT_FOUND', detail: `That episode has no accepted YouTube video to ${verb}.` } }
  }
  if (remote.other_channel || remote.channel_id !== channelId) {
    throw new YouTubeFoundationError(
      409, 'YOUTUBE_CHANNEL_MISMATCH',
      'That episode belongs to a YouTube channel this project no longer publishes to.',
    )
  }
  const updated = await updateVideoMetadata({
    slug,
    accountId,
    videoId: remote.video_id,
    // A schedule is always private-until-publishAt; any other visibility
    // clears a pending publishAt, or the video would still go public then.
    status: { privacyStatus: privacy, publishAt },
    ...(requirePrivacyStatus ? { requirePrivacyStatus } : {}),
  })
  if (updated.id !== remote.video_id || updated.status?.privacyStatus !== privacy
    || !sameInstant(updated.status?.publishAt, publishAt)) {
    throw scheduleRouteError(502, publishAt
      ? 'YouTube did not confirm the requested private schedule. The local receipt was not changed.'
      : `YouTube did not confirm ${episodeCode} as ${privacy}. The local receipt was not changed.`)
  }
  const operation = remote.source === 'operation_record'
    ? records.find(record => record.episode_code === episodeCode
      && record.video_id === remote.video_id && record.channel_id === channelId)
    : undefined
  const recorded = await (async () => {
    if (operation) {
      await updatePinnedYouTubeOperation({
        project_slug: slug,
        operation_id: operation.operation_id,
        expected_revision: operation.revision,
        expected_channel_id: channelId,
        mutate(record) {
          if (record.remote_snapshot) record.previous_remote_snapshot = record.remote_snapshot
          record.remote_snapshot = {
            fetched_at: new Date().toISOString(),
            title: typeof updated.snippet?.title === 'string' ? updated.snippet.title : record.remote_snapshot?.title || '',
            description: typeof updated.snippet?.description === 'string' ? updated.snippet.description : record.remote_snapshot?.description || '',
            tags: Array.isArray(updated.snippet?.tags) ? updated.snippet.tags.filter((tag: unknown) => typeof tag === 'string') : record.remote_snapshot?.tags || [],
            privacy_status: privacy,
            scheduled_for: publishAt,
          }
        },
      })
    } else {
      // A historical sidecar or Reconcile link has no operation record to hold
      // provider facts. Reuse the durable reconcile identity store, then write
      // only the fields YouTube just returned. This is a verified receipt, not
      // a local-plan claim or a synthetic upload operation.
      await linkYouTubeEpisodeVideo({
        project_slug: slug,
        episode_code: episodeCode,
        channel_id: channelId,
        video_id: remote.video_id,
        source: 'reconcile',
        decided_at: new Date().toISOString(),
      })
      await recordYouTubeEpisodePublication({
        project_slug: slug,
        episode_code: episodeCode,
        channel_id: channelId,
        video_id: remote.video_id,
        verified_at: new Date().toISOString(),
        privacy_status: privacy,
        scheduled_for: publishAt,
      })
      await setScheduledFor(slug, episodeCode, idea.title || '', 'youtube', publishAt)
    }
    return true
  })().catch(() => false)
  const response = {
    ...(operation ? { operation_id: operation.operation_id } : {}),
    episode_code: episodeCode,
    video_id: remote.video_id,
    privacy_status: privacy,
    scheduled_at: publishAt,
  }
  return { recorded, response }
}

/**
 * Schedule one known current-channel video without uploading any bytes.
 *
 * The identity comes from the same resolver that keeps Upload from duplicating
 * operation, reconciled, and historical-sidecar videos. The live private check
 * and ETag live inside updateVideoMetadata, so an old local visibility receipt
 * can never turn a public remote video private again.
 */
router.post('/projects/:slug/youtube/episodes/:episode_code/schedule', async (req, res) => {
  try {
    const slug = req.params.slug
    const episodeCode = req.params.episode_code
    if (req.body?.confirm !== true) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Confirm this YouTube schedule before sending it to YouTube.',
      })
      return
    }
    const expectedChannelId = typeof req.body?.expected_channel_id === 'string'
      ? req.body.expected_channel_id.trim()
      : ''
    if (!expectedChannelId) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Review the YouTube channel before confirming this schedule.',
      })
      return
    }
    const requestedPublishAt = typeof req.body?.publish_at === 'string' ? req.body.publish_at.trim() : ''
    const publishAt = normalizeFutureScheduleTime(requestedPublishAt)
    if (!publishAt) {
      res.status(400).json({ detail: 'Choose a valid future publish time.' })
      return
    }
    const outcome = await applyVideoVisibility({
      slug, episodeCode, expectedChannelId,
      privacy: 'private', publishAt, requirePrivacyStatus: 'private', verb: 'schedule',
    })
    if ('error' in outcome) {
      res.status(outcome.status).json(outcome.error)
      return
    }
    if (!outcome.recorded) {
      res.status(503).json({
        code: 'YOUTUBE_SCHEDULE_RECEIPT_UNRECORDED',
        detail: `YouTube accepted the schedule for ${episodeCode}, but Story Studio could not save its local receipt. Retry this same date and time to reconcile it; do not choose a different time until the retry succeeds.`,
        ...outcome.response,
      })
      return
    }
    res.json(outcome.response)
  } catch (error) {
    fail(res, error, 'Failed to schedule that YouTube video.')
  }
})

/**
 * Set one current-channel video's visibility (Public / Unlisted / Private) on
 * YouTube. Used by the Publish page's bulk "Set visibility" one row at a time,
 * each row confirmed by the owner with the exact count first. Any visibility
 * set here clears a pending scheduled publish time — "Private" that still goes
 * public next Tuesday would not be private.
 */
router.post('/projects/:slug/youtube/episodes/:episode_code/visibility', async (req, res) => {
  try {
    const slug = req.params.slug
    const episodeCode = req.params.episode_code
    if (req.body?.confirm !== true) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Confirm this visibility change before sending it to YouTube.',
      })
      return
    }
    const expectedChannelId = typeof req.body?.expected_channel_id === 'string'
      ? req.body.expected_channel_id.trim()
      : ''
    if (!expectedChannelId) {
      res.status(400).json({
        code: 'YOUTUBE_CONFIRMATION_REQUIRED',
        detail: 'Review the YouTube channel before confirming this visibility change.',
      })
      return
    }
    const privacy = req.body?.privacy_status
    if (privacy !== 'public' && privacy !== 'unlisted' && privacy !== 'private') {
      res.status(400).json({ detail: 'Choose Public, Unlisted or Private.' })
      return
    }
    const outcome = await applyVideoVisibility({
      slug, episodeCode, expectedChannelId, privacy, publishAt: null, verb: 'change',
    })
    if ('error' in outcome) {
      res.status(outcome.status).json(outcome.error)
      return
    }
    if (!outcome.recorded) {
      res.status(503).json({
        code: 'YOUTUBE_VISIBILITY_RECEIPT_UNRECORDED',
        detail: `YouTube made ${episodeCode} ${privacy}, but Story Studio could not save its local receipt. Choose the same visibility again to reconcile it.`,
        ...outcome.response,
      })
      return
    }
    res.json(outcome.response)
  } catch (error) {
    fail(res, error, 'Failed to change that video’s visibility on YouTube.')
  }
})

/**
 * "Check All Uploads": a deliberate whole-project refresh, batched in groups of
 * fifty. (Unfinished uploads are also followed in the background — see
 * youtube-status-sync.ts.) The attempt is recorded whether it worked or not — a
 * screen has to be able to say "we tried and could not reach YouTube" instead
 * of showing stale data as if it were current.
 */
router.post('/projects/:slug/youtube/sync', async (req, res) => {
  const slug = req.params.slug
  try {
    // Same guard: a sync reads publication state under this account's token,
    // so the account must be the one that signs in to the assigned channel.
    const { accountId, channelId } = await accountForCurrentChannel(slug)
    // This IS the deliberate provider read, so the channel's own status is
    // re-asked here too: whether long videos and custom thumbnails are allowed.
    // Never fatal — Check All Uploads is about uploads, and a channel status we
    // could not refresh is not a failed check.
    await readYouTubeChannelEligibility({
      project_slug: slug, account_id: accountId, channel_id: channelId, refresh: true,
    }).catch(() => null)
    // "Check All Uploads": every recorded upload, including the ones published
    // before upload receipts existed (their legacy sidecars).
    const result = await checkAllYouTubeUploads({ project_slug: slug, account_id: accountId })
    let attempt_recorded = true
    await recordYouTubeRemoteSyncAttempt({
      project_slug: slug,
      outcome: result.outcome,
      checked: result.checked,
      ...(result.error_code ? { error_code: result.error_code } : {}),
    }).catch(() => { attempt_recorded = false })
    res.json({ ...result, attempt_recorded })
  } catch (error) {
    fail(res, error, 'Failed to sync with YouTube.')
  } finally {
    // The Publishing Overview is a cached sweep of every channel, and this is
    // the deliberate refresh its page offers: whatever this sync found has to
    // be visible on the re-read that follows. Also when it FAILED — a partial
    // sync still moved state, and the owner pressed refresh expecting to see
    // what is there now, not what was there a minute ago.
    invalidatePublishingOverviewCache()
  }
})

/**
 * The other route that spends quota. Deliberate, user-initiated, and
 * bounded to a single video.
 */
router.post('/projects/:slug/youtube/operations/:operation_id/refresh', async (req, res) => {
  try {
    const slug = req.params.slug
    // The account is resolved server-side. A client-supplied account id would
    // be an authorization decision made by the caller.
    const { accountId, channelId } = await accountForCurrentChannel(slug)
    // The record must be ours to ask about — but only the CHANNEL check, not
    // `assertYouTubeOperationAuthorized`, which additionally refuses imported
    // and render-only records because they "cannot authorize remote work".
    // That is a rule about WRITES. Copying it onto this read broke the status
    // check for every imported back-catalogue video, which is exactly the case
    // an owner most wants to look up.
    const record = await readYouTubeOperation(slug, req.params.operation_id)
    if (!record) {
      throw new YouTubeFoundationError(404, 'YOUTUBE_OPERATION_NOT_FOUND', 'That upload record does not exist.')
    }
    if (!onCurrentChannel(channelId, record.channel_id)) {
      throw new YouTubeFoundationError(
        409, 'YOUTUBE_CHANNEL_MISMATCH',
        'That record belongs to a channel this project no longer publishes to.',
      )
    }
    res.json(await syncYouTubePublicationState({
      project_slug: slug,
      operation_id: req.params.operation_id,
      account_id: accountId,
    }))
  } catch (error) {
    fail(res, error, 'Failed to check the video status on YouTube.')
  }
})
