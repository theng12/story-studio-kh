/**
 * YouTube upload job executor.
 *
 * Runs as a normal queued job so the UI gets SSE progress for free. Flow:
 *   1. Read job params (slug, episode_code, account_id, scheduled_for optional)
 *   2. Locate the canonical non-empty `{code}_final_video.*` output
 *   3. ffprobe sanity-check (duration / video stream / audio)
 *   4. Resolve metadata (title/description/tags/thumbnail) via upload-metadata
 *   5. Sidecar check — if a video_id already exists, metadata-only update.
 *      Otherwise resumable upload → then thumbnails.set (best-effort).
 *   6. Write/update the sidecar with the final state
 */

import { syncYouTubePublicationState } from '../services/youtube-publication-status.js'
import fsp from 'fs/promises'
import path from 'path'
import { measureLoudness } from './music-episode-build.js'
import { safetyGate, safetyMode } from '../services/safety-checks.js'
import { existsSync } from 'fs'
import type { Job } from '../models/types.js'
import { resolveEpisodePaths } from '../services/utils.js'
import * as im from '../services/idea-manager.js'
import { isCancelled } from '../services/job-queue.js'
import { probeForUpload } from '../lib/ffprobe-check.js'
import { resolveUploadMetadata, assertUploadMetadataComplete } from '../lib/upload-metadata.js'
import { resolveYouTubeUploadSettings, buildYouTubeMetadataPackage, metadataPackageFromFinalPayload } from '../services/youtube-metadata-package.js'
import { youTubePublishDateRefusal } from '../services/youtube-publish-guard.js'
import { uploadVideo, setThumbnail, type PrivacyStatus } from '../lib/youtube-client.js'
import {
  beginYouTubeOperation,
  completeYouTubeOperation,
  markYouTubeOperationFailedBeforeSession,
  markYouTubeOperationUploading,
  type YouTubeOperationHandle,
} from '../services/youtube-operation-recorder.js'
import { listYouTubeOperations } from '../services/youtube-operation-store.js'
import type { YouTubeMetadataPackage } from '../services/youtube-metadata-package.js'
import {
  checkpointPlaylistSync,
  checkpointPlaylistSyncAtPath,
  checkpointThumbnailStateAtPath,
  checkpointUploadSidecarIdentity,
  inspectUploadSidecarIdentity,
  readShortSidecarAtPath,
  shortSidecarPath,
  writeShortSidecarAtPath,
  type UploadSidecar,
} from '../services/upload-sidecar.js'
import { remoteVideoFor, alreadyOnYouTubeReason } from '../services/youtube-remote-video.js'
import * as store from '../services/upload-store.js'
import * as playlistsSvc from '../services/upload-playlists.js'
import {
  readResumeSidecar,
  deleteResumeSidecar,
  isSidecarUsable,
  sessionUrlHash,
} from '../services/upload-resume-sidecar.js'
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'
import { readStoredFinalCheck } from '../lib/final-video-check.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { ensureYoutubePlaylistMembership } from '../services/youtube-playlist-sync.js'
import { describeYouTubeCredential, resolveYouTubeAccountId } from '../services/youtube-credential.js'
import {
  findYouTubeSourceVideoPath,
  resolveYouTubeSourceRevision,
  resolveYouTubeSourceRevisionFromHandle,
} from '../services/youtube-source-video.js'

interface YouTubeUploadParams {
  episode_id: string
  automatic?: boolean
  account_id?: string
  /**
   * 1.4.374 — a Short's own identity and file.
   *
   * A Short is its own video on the channel: its own record, its own
   * sidecar, its own "already on YouTube" answer. The episode it was cut
   * from is named separately, because the FILE and the FOLDER still belong to
   * that episode.
   */
  short_source?: { id: string; file: string; title: string }
  /** The episode a Short was cut from. Its folder owns the Short's file. */
  parent_episode_code?: string
  /** Channel shown in the confirmation. A changed assignment cannot inherit consent. */
  expected_channel_id?: string
  /** Exact preview revision. Fresh uploads refuse if live inputs changed afterward. */
  expected_package_revision?: string
  /** Source fingerprint captured when the confirmed request was admitted. */
  expected_source_revision?: string
  /** Server-owned exact payload accepted at the route boundary. */
  approved_final_payload?: YouTubeMetadataPackage['final_payload']
  /** Upload-mode choice pinned when the exact package was accepted. */
  approved_upload_mode?: store.UploadMode
  scheduled_for?: string | null   // ISO 8601; null/omitted = upload as private, no publishAt
  privacy_status?: PrivacyStatus
  /**
   * Per-upload playlist override (A5). If set, wins over the project's
   * default-playlist config. Empty string or null means "fall through to
   * default"; the sentinel `_none_` means "do not add to any playlist
   * even if a default is configured".
   */
  playlist_id?: string | null
  /** Exact episode thumbnail selected in Upload preview. */
  thumbnail_filename?: string | null
  /** Safety checks the Upload Center route let through (channel set to Off/Warn); logged on this job. */
  safety_warnings?: Array<{ check: string; message: string }>
  // NOTE: this job only ever UPLOADS. Re-running it on an episode that is
  // already published is REFUSED (see `remoteVideoFor` below), not turned into
  // a metadata PATCH — that behaviour existed until v1.5.0 and silently
  // rewrote live videos. If a "Replace video" feature is ever added it needs
  // its own confirmation flow, a warning that the old URL will be orphaned,
  // and an optional pre-delete — not a boolean param.
}

function hasReviewedFreshUploadParams(params: YouTubeUploadParams): boolean {
  return !!params.expected_channel_id?.trim()
    && !!params.expected_source_revision?.trim()
    && !!params.expected_package_revision?.trim()
    && !!params.approved_final_payload
    && (params.approved_upload_mode === 'private' || params.approved_upload_mode === 'apply-plan')
}

/**
 * The publish date, checked one last time before anything leaves this machine.
 *
 * Admission already refused a date that was unusable then. A queued job can
 * wait long enough for a date that was safe to become unsafe, and YouTube does
 * not report the difference: a publishAt in the past publishes the video
 * immediately, with no error. The refusal therefore belongs here too, on the
 * date the package will actually carry — not on the request that was accepted
 * hours ago.
 *
 * No date is not a failure: a private upload with no schedule is a normal
 * upload and has nothing to check.
 */
function publishDateRefusal(pkg: YouTubeMetadataPackage): string | null {
  const publishAt = pkg.status.publishAt
  if (!publishAt) return null
  return youTubePublishDateRefusal(publishAt)
}

/**
 * A passed publication deadline HOLDS the job — it never publishes now and
 * never fails permanently (Story 386 Item 1, owner brief 7). The row is parked
 * with no wake instant (we do not invent a date); Upload Center shows the plain
 * reason and the owner picks a new future date. A date YouTube would still
 * accept passes through untouched.
 *
 * Returns true when the job was held, so the caller returns WITHOUT throwing —
 * a thrown error would mark a correctly-held row as failed.
 */
async function holdForPassedPublishDeadline(job: Job, pkg: YouTubeMetadataPackage, episodeId: string): Promise<boolean> {
  const refusal = publishDateRefusal(pkg)
  if (!refusal) return false
  const { holdJobUntil } = await import('../services/job-queue.js')
  await holdJobUntil(
    job.job_id,
    null,
    `${refusal} The upload is held for ${episodeId}; choose a new future publication date in the Upload Center. Nothing was uploaded.`,
  )
  return true
}

/**
 * Ask the status read back one more question: does YouTube hold what we sent?
 *
 * Two answers matter, and neither can be repaired by Story Studio once the
 * video exists — so both are reported on the job rather than acted on:
 *
 *   - a scheduled upload that comes back NOT private has published already.
 *     That is the exact failure the publish-date guard exists to prevent, and
 *     nothing in the queue would ever say so.
 *   - a publishAt that differs from the one we sent means the date on the
 *     Upload Center screen is not the date on the video.
 *
 * The comparison is by INSTANT, not by string: YouTube formats its own
 * timestamps, and a different string for the same moment is not a mismatch.
 */
function reportPublishedScheduleMismatch(
  job: Job,
  sent: { privacyStatus: PrivacyStatus; publishAt?: string | null },
  readBack: { privacyStatus?: string; publishAt?: string | null } | undefined,
  videoId: string,
): void {
  if (!readBack || !readBack.privacyStatus) return
  const problems: string[] = []
  if (readBack.privacyStatus !== sent.privacyStatus) {
    problems.push(`YouTube has it as ${readBack.privacyStatus}, but ${sent.privacyStatus} was sent`)
  }
  if (!sameInstant(readBack.publishAt, sent.publishAt)) {
    problems.push(
      `YouTube's publish date is ${readBack.publishAt ?? 'none'}, but ${sent.publishAt ?? 'none'} was sent`,
    )
  }
  if (!problems.length) return
  const warning = `YouTube did not keep the schedule this upload sent for ${videoId} — ${problems.join('; ')}. `
    + 'The video was not uploaded under a different schedule on purpose, and Story Studio did not change it; '
    + 'open it in YouTube Studio to see or correct what is live.'
  job.output_lines.push(`⚠ ${warning}`)
  job.result = {
    ...(job.result || {}),
    schedule_readback: {
      video_id: videoId,
      sent_privacy_status: sent.privacyStatus,
      sent_publish_at: sent.publishAt ?? null,
      youtube_privacy_status: readBack.privacyStatus,
      youtube_publish_at: readBack.publishAt ?? null,
      problems,
    },
    warnings: [...((job.result?.warnings as string[] | undefined) || []), warning],
  }
}

/** True when two ISO dates name the same moment. Null and undefined are equal. */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  const at = Date.parse(a)
  const bt = Date.parse(b)
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return a === b
  return at === bt
}

/**
 * An old queued job may continue only when it resumes one exact durable
 * operation. It may not turn into a fresh upload using today's metadata.
 */
async function hasExactResumableRecovery(input: {
  slug: string
  episodeId: string
  accountId: string
  channelId: string
  videoPath: string
  operations: Awaited<ReturnType<typeof listYouTubeOperations>>
}): Promise<boolean> {
  const resume = await readResumeSidecar(input.slug, input.episodeId, 'youtube')
  if (!resume) return false
  const sourceBytes = (await fsp.stat(input.videoPath)).size
  const usable = isSidecarUsable({
    sidecar: resume,
    currentFileSize: sourceBytes,
    currentAccountId: input.accountId,
  })
  if (!usable.ok) return false
  const sourceRevision = await resolveYouTubeSourceRevision(input.videoPath)
  const sessionHash = sessionUrlHash(resume.session_url)
  const open = input.operations.filter(record => record.episode_code === input.episodeId
    && record.channel_id === input.channelId && !record.video_id
    && ['preparing', 'uploading'].includes(record.lifecycle))
  const matches = open.filter(record => record.lifecycle === 'uploading'
    && record.source_revision === sourceRevision && !!record.final_payload
    && (!record.resumable || (
      record.resumable.session_url_hash === sessionHash
      && record.resumable.source_bytes === sourceBytes
    )))
  if (open.length !== 1 || matches.length !== 1) return false
  // Not caught: a blank approved payload must name the episode, not read as "no receipt".
  metadataPackageFromFinalPayload(matches[0]!.final_payload!, input.episodeId)
  return true
}

export async function generateYoutubeUpload(job: Job): Promise<void> {
  const slug = job.project_slug
  const params = (job.params || {}) as YouTubeUploadParams
  const episodeId = params.episode_id || job.episode_id
  if (!episodeId) throw new Error('episode_id is required')
  // A Short is uploaded under its OWN identity, but its file belongs to the
  // episode it was cut from. So the two are read separately from here on:
  // `episodeId` is what every RECORD is written under, `parentCode` is what
  // every FILE is read from.
  const shortSource = params.short_source
  const parentCode = (shortSource ? params.parent_episode_code : undefined) || episodeId

  job.output_lines.push(`YouTube upload — ${episodeId}`)

  const accountId = await resolveYouTubeAccountId(slug, params.account_id)
  if (!accountId) throw new Error('No YouTube channel is assigned. Reconnect it in Settings → YouTube.')
  const account = await describeYouTubeCredential(slug, accountId)
  if (!account) throw new Error('This upload names an old YouTube connection. Reconnect it in Settings → YouTube.')
  if (params.expected_channel_id && params.expected_channel_id !== account.remote_id) {
    if (params.automatic) throw new Error('The assigned YouTube channel changed; nothing was uploaded.')
    await stopOrCarryOn(slug, 'right_channel', job,
      'The assigned YouTube channel changed after confirmation. Preview and confirm the upload again.',
      `The assigned YouTube channel changed after confirmation; uploading to the channel assigned now, ${account.remote_title}.`)
  }
  job.output_lines.push(`Using channel: ${account.remote_title} (${account.remote_id})`)
  for (const passed of params.safety_warnings || []) await safetyGate(slug, passed.check, job, passed.message)

  // Lookup episode + paths. For a Short these are the PARENT episode's: the
  // Short's file sits in that episode's own folder.
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '') === parentCode)
  if (!idea) throw new Error(`Accepted idea not found for ${parentCode}`)
  const paths = await resolveEpisodePaths(slug, parentCode, idea.title || '')

  // "Is this already on YouTube?" is asked BEFORE any local video lookup,
  // because the answer does not depend on a local file — and an episode whose
  // final video has been deleted to save disk space must still be recognised as
  // published rather than refused for the wrong reason. It also avoids an
  // ffprobe on a file that is about to be irrelevant.
  // ONE predicate, the same one the route and the page ask (tell 13). This job
  // used to read the sidecar privately and, when it found a video id, quietly
  // PATCH the live public video instead of uploading — the fourth review's
  // defect. That branch is gone: this job UPLOADS, and refuses if the episode
  // is already published rather than deciding for itself what to do about it.
  // ONE predicate answers this, and it answers the CHANNEL question too. The
  // job used to carry its own channel-mismatch guard: the predicate returned
  // null for an old-channel sidecar (so the page offered Upload and the route
  // accepted it) and the job then refused — the disagreement only visible after
  // the owner pressed the button. Tell 13, fourth instance.
  const operations = await listYouTubeOperations(slug)
  const remote = await remoteVideoFor(slug, episodeId, idea.title || '', account.remote_id, operations)
  // A Short's record is its OWN file inside the shorts folder; the episode's
  // `youtube_upload.json` is the episode's only local record of its final
  // video, and a Short must never overwrite it.
  const sidecarFilePath = shortSource
    ? shortSidecarPath(path.join(paths.episode_dir, 'shorts'), shortSource.id)
    : path.join(paths.episode_dir, 'youtube_upload.json')
  if (remote?.video_id) {
    // Retry after "uploaded, but the thumbnail failed": the video is kept and
    // only the thumbnail is set. Never a second upload.
    const recorded = await readShortSidecarAtPath(sidecarFilePath)
    if (!params.automatic && thumbnailOnlyRetry(recorded, remote.video_id, account.remote_id)) {
      await setRequiredThumbnail(job, {
        slug, episodeId, accountId, videoId: remote.video_id, fallbackTitle: idea.title,
        sidecarPath: sidecarFilePath,
        thumbnailFilename: params.thumbnail_filename,
      })
      return
    }
    throw new Error(`${alreadyOnYouTubeReason(episodeId, remote)} Nothing was uploaded.`)
  }

  // This job always uploads, so the local video file is always required.
  let videoPath: string | null = null
  {
    // Fresh-upload path needs the local video file. We pass slug + code
    // + title so the lookup can check the external_final_video_root
    // (per-machine Settings → Storage path) BEFORE falling back to the
    // project-tree video_dir — same precedence the asset-status detector
    // uses so the pipeline view and the upload generator never disagree
    // about whether the final exists.
    //
    // A Short uploads its OWN cut: the file named in `short_source`, inside
    // the parent episode's shorts folder. The name is a bare file name and it
    // is joined to the folder THIS episode owns, so nothing outside that
    // folder can be uploaded.
    videoPath = shortSource
      ? path.join(paths.episode_dir, 'shorts', path.basename(shortSource.file))
      : await findYouTubeSourceVideoPath(paths, slug, parentCode, idea.title || '')
    if (!videoPath || !existsSync(videoPath)) {
      throw new Error(shortSource
        ? `${shortSource.file} is missing, so nothing was uploaded.`
        : `No final video file found for ${episodeId}. Run Video Assembly or drop a file into this episode's video folder (or the external final-video root if configured in Settings → Storage).`)
    }
    if (params.automatic) {
      // A Short is cut from the episode's final, so the check that applies to
      // it is the EPISODE's final check — the same verdict the cut was made
      // from — not a check of the Short file itself.
      const checkPath = shortSource
        ? await findYouTubeSourceVideoPath(paths, slug, parentCode, idea.title || '')
        : videoPath
      if (!checkPath) throw new Error('The final check is missing; nothing was uploaded.')
      const check = await readStoredFinalCheck(checkPath)
      if (!check || check.stale || !check.result.passed) throw new Error('The final check is missing, stale, or failed; nothing was uploaded.')
    }
    if (!hasReviewedFreshUploadParams(params) && !(await hasExactResumableRecovery({
      slug,
      episodeId,
      accountId,
      channelId: account.remote_id,
      videoPath,
      operations,
    }))) {
      throw new Error('This queued upload predates the required review receipt. Review and confirm the exact video and YouTube details again; nothing was uploaded.')
    }
    job.output_lines.push(`Source video: ${path.relative(paths.episode_dir, videoPath)}`)

    // ffprobe sanity check (duration / streams) — only meaningful for
    // fresh uploads since metadata-only PATCH never reads the file.
    job.output_lines.push('Probing video with ffprobe…')
    const probe = await probeForUpload(videoPath)
    if (!probe.ok) throw new Error(probe.error || 'ffprobe rejected the file')
    job.output_lines.push(`Probe OK — ${Math.round(probe.durationSec / 60)} min · ${probe.width}×${probe.height} · ${probe.hasAudio ? 'audio present' : 'no audio'}`)
    // 1.4.300 — a video with no sound is stopped (the "valid video" safety check, Block by default).
    const silent = !probe.hasAudio || await measureLoudness(videoPath, { truePeak: false }).then(m => m.lufs === null || m.lufs <= -69, () => false)
    if (silent) {
      if (params.automatic) throw new Error(`${path.basename(videoPath)} has no sound. Nothing was uploaded.`)
      await safetyGate(slug, 'valid_video', job, `${path.basename(videoPath)} has no sound${probe.hasAudio ? ' (its audio track is silent)' : ''}. Nothing was uploaded.`)
    }
  }

  // Resolve metadata. A Short keeps the episode's description, tags and
  // thumbnail, and goes up under its OWN title — the moment title its passage
  // was chosen for.
  const meta = await resolveUploadMetadata({
    slug,
    episode_code: parentCode,
    fallback_title: idea.title,
    platform: 'youtube',
    thumbnail_filename: params.thumbnail_filename,
  })
  if (shortSource?.title) {
    meta.title = shortSource.title
    // Model text, same as the episode's own title: the editorial strips apply
    // to it. Skipping them would send a Short whose title began as `# …`.
    meta.title_from_override = false
  }
  // The thumbnail is REQUIRED (owner decision 2026-10-07). Refuse before any
  // quota is spent rather than publish a video with YouTube's frame grab.
  // 1.4.300: the "thumbnail present" safety check — Off/Warn upload without one.
  const hasThumbnail = !!meta.thumbnailPath && existsSync(meta.thumbnailPath)
  if (!hasThumbnail) {
    const reason = missingThumbnailReason(episodeId, meta.thumbnailPath, params.thumbnail_filename)
    if (params.automatic) throw new Error(`${reason} Nothing was uploaded.`)
    await stopOrCarryOn(slug, 'thumbnail_present', job, `${reason} Nothing was uploaded.`,
      `${reason} Uploading without a thumbnail, so YouTube shows its own frame grab.`)
  }
  const privacy: PrivacyStatus = params.privacy_status || 'private'

  let operationHandle!: YouTubeOperationHandle
  let metadataPackage!: YouTubeMetadataPackage
  let videoId: string
  let uploaded: any

  {
    // Hash and upload through one descriptor. Final-video promotion replaces
    // paths atomically, but this job runs in a separate queue lane, so reopening
    // the pathname for every chunk could otherwise send a newer render than the
    // durable SHA-256 receipt describes.
    const sourceHandle = await fsp.open(videoPath, 'r')
    try {
    // Restart-safe resume: if a transient
    // sidecar from a prior interrupted run exists AND its TTL hasn't
    // expired AND file_size matches AND account_id matches, hand the
    // session URL to uploadVideo so it skips init + the 1600-unit quota
    // charge. Mismatches drop the sidecar so the next attempt starts
    // fresh against a usable session.
    const resumeSidecar = await readResumeSidecar(slug, episodeId, 'youtube')
    const sourceBytes = (await sourceHandle.stat()).size
    const sourceRevision = await resolveYouTubeSourceRevisionFromHandle(sourceHandle)
    if (params.expected_source_revision && sourceRevision !== params.expected_source_revision) {
      if (params.automatic) throw new Error('The rendered video changed after automatic upload admission; nothing was uploaded.')
      await stopOrCarryOn(slug, 'reviewed_unchanged', job,
        'The rendered video changed after confirmation. Preview and confirm the upload again; nothing was uploaded.',
        'The rendered video changed after confirmation; uploading the video as it is now.')
    }
    const openOperations = operations.filter(record => record.episode_code === episodeId
      && record.channel_id === account.remote_id && !record.video_id
      && ['preparing', 'uploading'].includes(record.lifecycle))
    let resumeFromSessionUrl: string | undefined
    let recoveredOperation = false
    let uploadModeForRecord!: store.UploadMode
    if (resumeSidecar) {
      const usable = isSidecarUsable({
        sidecar: resumeSidecar,
        currentFileSize: sourceBytes,
        currentAccountId: accountId,
      })
      if (usable.ok) {
        const sessionHash = sessionUrlHash(resumeSidecar.session_url)
        const identityMatches = openOperations.filter(record => record.lifecycle === 'uploading'
          && record.source_revision === sourceRevision
          && record.final_payload)
        const matches = identityMatches.filter(record => !record.resumable || (
          record.resumable.session_url_hash === sessionHash
          && record.resumable.source_bytes === sourceBytes
        ))
        if (openOperations.length !== 1 || matches.length !== 1) {
          throw new Error(`The saved upload session for ${episodeId} does not match exactly one durable operation. Nothing was uploaded; review the interrupted upload before retrying.`)
        }
        const record = matches[0]!
        operationHandle = { operation_id: record.operation_id, channel_id: record.channel_id, revision: record.revision }
        metadataPackage = metadataPackageFromFinalPayload(record.final_payload!, episodeId)
        // Re-checked here, not only at admission: a job can sit in the queue
        // for hours, and the date that was safe when it was admitted can have
        // passed by the time the bytes are sent. A past publishAt does not
        // fail at YouTube — it publishes the video immediately.
        if (await holdForPassedPublishDeadline(job, metadataPackage, episodeId)) return
        // uploadVideo persists the credential-bearing sidecar before it calls
        // the operation checkpoint. A process/store failure in that narrow
        // window leaves a valid session beside the one matching uploading
        // record, but no hash on the record yet. Reconcile that exact pair now,
        // before probing or sending any bytes. Ambiguity was rejected above.
        if (!record.resumable) {
          await markYouTubeOperationUploading({
            project_slug: slug,
            handle: operationHandle,
            source_bytes: sourceBytes,
            session_url_hash: sessionHash,
          })
        }
        recoveredOperation = true
        resumeFromSessionUrl = resumeSidecar.session_url
        job.output_lines.push(
          `Found resumable upload from ${resumeSidecar.created_at} — will resume against existing session ${sessionUrlHash(resumeSidecar.session_url)} (no fresh quota charge).`,
        )
      } else {
        if (openOperations.length) {
          throw new Error(`The saved upload session for ${episodeId} no longer matches its open durable operation. Nothing was uploaded; review the interrupted upload before retrying.`)
        }
        await deleteResumeSidecar(slug, episodeId, 'youtube').catch(() => {})
        const reasonCopy =
          usable.reason === 'expired'
            ? 'previous upload session is older than 6.5 days'
            : usable.reason === 'file_size_mismatch'
              ? 'source video file size changed since the previous upload session'
              : 'YouTube account changed since the previous upload session'
        job.output_lines.push(
          `Discarded stale resume sidecar (${reasonCopy}) — starting a fresh upload.`,
        )
      }
    }

    if (!recoveredOperation) {
      if (openOperations.length || remote) {
        throw new Error(`${alreadyOnYouTubeReason(episodeId, remote ?? {
          video_id: '', source: 'operation_record', channel_id: account.remote_id,
          lifecycle: openOperations[0]?.lifecycle ?? 'uploading',
        })} Nothing was uploaded.`)
      }
      if (params.expected_package_revision) {
        if (!params.approved_final_payload) {
          throw new Error('The approved YouTube upload details are missing. Preview and confirm the upload again; nothing was uploaded.')
        }
        if (params.approved_upload_mode !== 'apply-plan' && params.approved_upload_mode !== 'private') {
          throw new Error('The approved YouTube upload mode is missing. Preview and confirm the upload again; nothing was uploaded.')
        }
        metadataPackage = metadataPackageFromFinalPayload(params.approved_final_payload, episodeId)
        if (metadataPackage.package_revision !== params.expected_package_revision) {
          throw new Error('The approved YouTube upload details are invalid. Preview and confirm the upload again; nothing was uploaded.')
        }
        uploadModeForRecord = params.approved_upload_mode
      } else {
        // Legacy jobs have no approved package, so resolve their mutable upload
        // mode here. Admitted Upload Center jobs use the frozen payload above;
        // a later Settings edit cannot rewrite what the owner approved.
        const uploadMode = await store.getUploadMode(slug, 'youtube')
        uploadModeForRecord = uploadMode
        const publishAt = uploadMode === 'private'
          ? undefined
          : (params.scheduled_for || undefined)
        if (uploadMode === 'private' && params.scheduled_for) {
          job.output_lines.push(`Private-first mode: ignoring plan publishAt (${params.scheduled_for}); manage schedule in YouTube Studio.`)
        }
        const uploadSettings = await resolveYouTubeUploadSettings(slug)
        metadataPackage = await buildYouTubeMetadataPackage({
          project_slug: slug,
          episode_code: episodeId,
          privacy_status: privacy,
          ...(publishAt ? { publish_at: publishAt } : {}),
          ...(uploadSettings.category_id !== undefined ? { category_id: uploadSettings.category_id } : {}),
          mark_as_ai_generated: uploadSettings.mark_as_ai_generated,
          fallback_title: idea.title || '',
          ...(params.thumbnail_filename !== undefined ? { thumbnail_filename: params.thumbnail_filename } : {}),
        })
        // Fresh-path only, on the package that will be sent. Refuse BEFORE any
        // durable record or quota: a description-less upload went out publicly
        // and silent once before (§8).
        assertUploadMetadataComplete({
          title: metadataPackage.snippet.title ?? '',
          description: metadataPackage.snippet.description ?? '',
        }, episodeId)
      }
      // Same check, before ANY durable record is opened: a refused date must
      // leave nothing behind that later reads as an upload in flight. Legacy
      // jobs — no approved package — resolve their date above and go through
      // exactly the same rule; a retry re-checks it.
      if (await holdForPassedPublishDeadline(job, metadataPackage, episodeId)) return
      operationHandle = await beginYouTubeOperation({
        project_slug: slug,
        episode_code: episodeId,
        source_revision: sourceRevision,
        metadata_package: metadataPackage,
        final_action: uploadModeForRecord === 'private' ? 'private_upload' : 'manual_upload',
        provider_channel_id: account.remote_id,
      })
      await markYouTubeOperationUploading({
        project_slug: slug,
        handle: operationHandle,
        source_bytes: sourceBytes,
      })
    }

    for (const change of metadataPackage.modifications) job.output_lines.push(`${change.field}: ${change.reason}`)
    for (const warning of metadataPackage.warnings) job.output_lines.push(`⚠ ${warning}`)
    job.output_lines.push(
      `Metadata — title: "${metadataPackage.snippet.title}", tags: ${metadataPackage.snippet.tags?.length ?? 0}, thumbnail: ${hasThumbnail ? path.basename(meta.thumbnailPath) : 'none'}`,
    )

    // Open and checkpoint the durable operation BEFORE the provider request.
    // If source identity or durable state cannot be recorded, stop: uploading
    // without that evidence makes an interrupted attempt unsafe to retry.
    job.output_lines.push(resumeFromSessionUrl ? 'Resuming resumable upload…' : 'Starting resumable upload…')
    job.output_lines.push(
      metadataPackage.status.containsSyntheticMedia
        ? 'Disclosing video as AI-generated / altered or synthetic content (status.containsSyntheticMedia=true).'
        : 'NOT disclosing video as altered/synthetic — toggle in Settings → YouTube if your content is AI-generated.',
    )
    // Wire cancellation through to fetch: the queue exposes `isCancelled`,
    // and the onProgress callback is a convenient place to poll it mid-
    // stream. When the user clicks Cancel on a long upload, we abort the
    // PUT request so we stop shovelling bytes at Google immediately.
    const abort = new AbortController()
    let uploadTracker: SpeedTracker | null = null
    // Throttle Job-state writes so the SSE stream doesn't get flooded —
    // YouTube's resumable PUT can fire onProgress 50×/s.
    const writeProgress = throttle((sent: number, total: number) => {
      if (!uploadTracker) uploadTracker = new SpeedTracker(5000, total)
      const { speedBps, etaSeconds } = uploadTracker.update(sent)
      job.bytes_done = sent
      job.bytes_total = total
      job.speed_bps = speedBps
      job.eta_seconds = etaSeconds
      const pct = Math.floor((sent / total) * 85)
      if (pct !== job.progress) job.progress = pct
    }, 250)
    try {
      uploaded = await uploadVideo({
      slug,
      accountId,
      filePath: videoPath,
      sourceHandle,
      snippet: metadataPackage.snippet,
      status: metadataPackage.status,
      signal: abort.signal,
      episodeCode: episodeId,
      deferResumeCleanup: true,
      logLines: job.output_lines,
      resumeFromSessionUrl,
      onProgress: (sent, total) => {
        if (isCancelled(job.job_id)) {
          abort.abort()
          return
        }
        // Reserve 0-85 for the upload phase; thumbnail + sidecar take the
        // remaining 15. Progress is byte-accurate since we stream through
        // a ReadableStream that reports chunk sizes.
        writeProgress(sent, total)
      },
        ...(!recoveredOperation ? { onResumableSessionReady: async (hash: string, bytes: number) => {
          await markYouTubeOperationUploading({
            project_slug: slug,
            handle: operationHandle,
            source_bytes: bytes,
            session_url_hash: hash,
          })
        } } : {}),
      })
    } catch (error) {
      if (!await readResumeSidecar(slug, episodeId, 'youtube')) {
        await markYouTubeOperationFailedBeforeSession({
          project_slug: slug,
          handle: operationHandle,
          error_code: 'provider_not_started',
        })
      }
      throw error
    }
    // Freeze metrics at completion so the UI stops mid-flight tickers.
    job.bytes_done = job.bytes_total
    job.speed_bps = 0
    job.eta_seconds = 0
    videoId = uploaded.id
    job.progress = 85
    job.output_lines.push(`Upload complete — video id: ${videoId}`)
    } finally {
      await sourceHandle.close().catch(() => {})
    }
  }

  if (!videoId?.trim()) throw new Error('YouTube returned success without a video id; no upload record was written.')

  // A Short's outcome is recorded HERE, where the video id is known — not at
  // admission, which only queues the upload. Recording it earlier would mark a
  // Short as uploaded while its upload was still running, or had failed, and a
  // retry would then skip it.
  if (shortSource) {
    const { writeShortUploadRecord } = await import('../services/shorts-upload.js')
    await writeShortUploadRecord(path.join(paths.episode_dir, 'shorts'), shortSource.file, {
      file: shortSource.file,
      title: shortSource.title,
      state: 'uploaded',
      video_id: videoId,
      ...(metadataPackage.status.publishAt ? { publish_at: metadataPackage.status.publishAt } : {}),
      uploaded_at: new Date().toISOString(),
    }).catch((error: any) => {
      job.output_lines.push(`⚠ The Short's upload record could not be written (${error?.message || error}). `
        + 'The video is uploaded; reconcile it from the Upload Center.')
    })
  }

  // Checkpoint the permanent remote identity before thumbnail or playlist
  // work. uploadVideo deliberately retains the transient resumable-session
  // sidecar until this durable write succeeds. That closes the crash window
  // that could otherwise make Retry upload the same video again and spend
  // another 1,600 quota units.
  // Built from scratch, carrying NOTHING forward.
  //
  // This spread used to be dead: `existing` came from `readSidecar`, which is
  // null unless a video_id is set, and any non-null value took the update
  // branch instead. Removing that branch and switching to the raw read made the
  // spread LIVE — so a re-upload inherited the previous video's `deleted_at`
  // (re-tombstoning the new video the moment it was created), `thumbnail_set`
  // (making the no-thumbnail warning unreachable and checkpointing the old
  // video's thumbnail state against the new id), `thumbnail_sync`,
  // `playlist_sync`, `last_error` and `uploaded_at`.
  //
  // This IS the permanent `youtube_upload.json`, not the transient
  // resumable-session sidecar (that is `upload-resume-sidecar.ts`). A fresh
  // upload is a fresh video: every field describes THIS one.
  let thumbnail_set = false
  const sidecar: UploadSidecar = {
    platform: 'youtube',
    video_id: videoId,
    account_id: accountId,
    channel_id: account.remote_id,
    uploaded_at: new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    scheduled_for: metadataPackage.status.publishAt || null,
    privacy_status: metadataPackage.status.privacyStatus,
    title: metadataPackage.snippet.title,
    description: metadataPackage.snippet.description || '',
    tags: metadataPackage.snippet.tags || [],
    thumbnail_set,
  }
  // A Short writes ITS OWN record; the episode keeps its own, untouched.
  const identityCheckpoint = shortSource
    ? await (async () => {
      await writeShortSidecarAtPath(sidecarFilePath, sidecar)
      const saved = await readShortSidecarAtPath(sidecarFilePath)
      return {
        saved,
        invalid: inspectUploadSidecarIdentity(saved, {
          platform: 'youtube', video_id: sidecar.video_id, account_id: sidecar.account_id, channel_id: sidecar.channel_id,
        }),
      }
    })()
    : await checkpointUploadSidecarIdentity(slug, episodeId, idea.title || '', sidecar)
  const identityErrors = identityCheckpoint.invalid
  if (identityErrors.length) {
    requireJobCompletion(job, {
      label: 'YouTube remote identity checkpoint',
      expected: 1,
      completed: 0,
      invalid: identityErrors,
      retry_hint: 'Do not upload again manually. Retry first checks the permanent video ID and repairs the local record safely.',
    })
  }
  await deleteResumeSidecar(slug, episodeId, 'youtube').catch(() => {})
  job.output_lines.push(`Permanent upload checkpoint saved for https://youtu.be/${videoId}.`)

  // Same checkpoint, on the new record: accepted identity is durable BEFORE
  // any thumbnail or playlist work, so a crash here can never be mistaken for
  // "never uploaded" and re-spend the quota.
  {
    try {
      await completeYouTubeOperation({
        project_slug: slug,
        episode_code: episodeId,
        handle: operationHandle,
        video_id: videoId,
        metadata_package: metadataPackage,
      })
    } catch (e: any) {
      // The video is already accepted by YouTube. A bookkeeping failure here
      // must never look like an upload failure, and must never trigger a retry
      // that uploads again.
      job.output_lines.push(`⚠ Durable upload record could not be completed (${e?.message || e}). The video is uploaded; reconcile it from the Upload Center.`)
    }
    // One status check straight away, so the record moves on from "accepted"
    // without anyone asking; the background check follows it to "ready".
    // A bookkeeping read: never fatal, never a reason to upload again.
    try {
      const checked = await syncYouTubePublicationState({ project_slug: slug, operation_id: operationHandle.operation_id, account_id: accountId })
      job.output_lines.push(`YouTube status right after upload: ${checked.state.lifecycle}.`)
      // Same read, asked one more question: is the video actually holding the
      // privacy and the date this job sent it? A scheduled upload that comes
      // back public has already published — the very outcome the publish-date
      // guard exists to prevent — and a different publishAt means the plan on
      // the Upload Center screen is not the plan on the video.
      //
      // Reported, never repaired. The upload succeeded and the video is
      // somebody's content; silently changing a live video's visibility is the
      // kind of write this product refuses to make on its own.
      reportPublishedScheduleMismatch(job, metadataPackage.status, checked.details, videoId)
    } catch (e: any) {
      job.output_lines.push(`YouTube status not checked yet (${e?.message || e}); Story Studio checks again in the background.`)
    }
  }

  // Thumbnail — REQUIRED. Tried twice (setThumbnail itself also retries the
  // transient "still processing" race); a failure fails the job further down,
  // after the durable record and the playlist, with the video id kept.
  //
  // A channel that may not have custom thumbnails at all is the one exception:
  // YouTube answers every attempt with the same 403, no choice in Story Studio
  // can satisfy the check, and the owner asked for the video to go up with the
  // thumbnail skipped rather than as a raw provider error.
  let thumb: ThumbnailOutcome = { error: '', channel_forbidden: false }
  if (hasThumbnail) {
    job.output_lines.push('Setting the thumbnail…')
    thumb = await setThumbnailWithRetry(job, { slug, accountId, videoId, filePath: meta.thumbnailPath })
    if (!thumb.error) thumbnail_set = true
  }
  const thumb_error = thumb.error
  const thumbnailVerifiedThisRun = thumbnail_set
  job.progress = 95

  // Merge optional thumbnail details into the current record rather than
  // writing the stale pre-thumbnail object over a concurrent schedule or
  // playlist update.
  const sidecarPath = sidecarFilePath
  await checkpointThumbnailStateAtPath(
    sidecarPath,
    { video_id: videoId, account_id: accountId },
    { set: thumbnail_set, error: thumb_error || undefined, remotely_verified: thumbnailVerifiedThisRun },
  )
  const finalCheckpoint = await readShortSidecarAtPath(sidecarPath)
  const sidecarErrors = inspectUploadSidecarIdentity(finalCheckpoint, {
    platform: 'youtube', video_id: videoId, account_id: accountId, channel_id: account.remote_id,
  })
  requireJobCompletion(job, {
    label: 'YouTube upload record',
    expected: 1,
    completed: sidecarErrors.length ? 0 : 1,
    invalid: sidecarErrors,
    retry_hint: 'The remote video is not re-uploaded when a valid video ID is already recorded; Retry repairs metadata or the local checkpoint safely.',
  })
  job.progress = 100

  job.output_lines.push(`Sidecar written. URL: https://youtu.be/${videoId}`)
  job.output_dir = paths.episode_dir

  // Add to playlist — best-effort post-upload step (A5). Precedence:
  // explicit per-upload override > project default. Empty "_none_" skips.
  // Failures are logged but don't fail the job because the upload itself
  // succeeded; the user can retry with the bulk "Add to playlist" action
  // (Phase 6 polish item, not yet built — for now retry is manual).
  const override = params.playlist_id
  let playlistToUse = ''
  if (override === '_none_') {
    playlistToUse = ''   // explicit skip
  } else if (override && override.trim()) {
    playlistToUse = override.trim()
  } else {
    playlistToUse = await playlistsSvc.getDefaultPlaylist(slug, accountId)
  }
  if (playlistToUse) {
    try {
      const membership = await ensureYoutubePlaylistMembership({
        slug,
        accountId,
        playlistId: playlistToUse,
        videoId,
        isCancelled: () => isCancelled(job.job_id),
      })
      await (shortSource
        ? checkpointPlaylistSyncAtPath(sidecarFilePath, {
          playlist_id: playlistToUse,
          video_id: videoId,
          account_id: accountId,
          channel_id: account.remote_id,
        })
        : checkpointPlaylistSync(slug, episodeId, idea.title || '', {
          playlist_id: playlistToUse,
          video_id: videoId,
          account_id: accountId,
        }))
      job.output_lines.push(
        membership.inserted
          ? `Added to playlist ${playlistToUse} and verified membership.`
          : `Playlist ${playlistToUse} already contains this video; skipped the 50-unit insert.`,
      )
      job.result = { ...(job.result || {}), playlist: { id: playlistToUse, added: true } }
    } catch (e: any) {
      // Optional, so it does not fail the upload — but it is reported in the
      // job result, not only in the log, so "done" never hides it.
      const warning = `The video was not added to playlist ${playlistToUse}: ${e?.message || 'unknown error'}. The upload itself is complete; add it from YouTube Studio or retry the playlist.`
      job.output_lines.push(`⚠ ${warning}`)
      job.result = {
        ...(job.result || {}),
        playlist: { id: playlistToUse, added: false, error: String(e?.message || 'unknown') },
        warnings: [...((job.result?.warnings as string[] | undefined) || []), warning],
      }
    }
  }

  await requireThumbnailSet(slug, job, videoId, thumb)
}

/** The thumbnail's outcome. `error` is '' when it was set. */
interface ThumbnailOutcome {
  error: string
  /** YouTube refused because the CHANNEL may not have custom thumbnails (403). */
  channel_forbidden: boolean
}

/**
 * A safety check that failed: Block keeps today's stop exactly (`stop`); Off/Warn log `carryOn`
 * (Warn also lists it on the job) and return so the upload carries on.
 */
async function stopOrCarryOn(slug: string, id: string, job: Job, stop: string, carryOn: string): Promise<void> {
  if (await safetyMode(slug, id) === 'block') throw new Error(stop)
  await safetyGate(slug, id, job, carryOn)
}

/** Why there is no thumbnail to set, in the owner's words. */
function missingThumbnailReason(episodeId: string, resolvedPath: string, filename: string | null | undefined): string {
  if (filename === null) {
    return `A thumbnail is required to upload ${episodeId}, and none was selected. Pick one in Upload preview.`
  }
  return resolvedPath
    ? `${episodeId}'s thumbnail no longer exists (${resolvedPath}). Make or pin a thumbnail on the Thumbnails page, then try again.`
    : `A thumbnail is required to upload ${episodeId}, and this episode has none. Make or pin one on the Thumbnails page, then try again.`
}

/** setThumbnail, tried a second time on failure. A channel-level 403 is not retried — it cannot change. */
async function setThumbnailWithRetry(
  job: Job,
  opts: { slug: string; accountId: string; videoId: string; filePath: string },
): Promise<ThumbnailOutcome> {
  let error = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await setThumbnail(opts)
      job.output_lines.push('Thumbnail set ✓')
      return { error: '', channel_forbidden: false }
    } catch (e: any) {
      error = String(e?.message || 'thumbnail failed')
      if (e?.code === 'YOUTUBE_CHANNEL_THUMBNAILS_FORBIDDEN') {
        return { error, channel_forbidden: true }
      }
      job.output_lines.push(`⚠ Thumbnail attempt ${attempt} of 2 failed: ${error}`)
    }
  }
  return { error, channel_forbidden: false }
}

/**
 * Fail the job when the thumbnail is not set, keeping the video id so Retry sets only the thumbnail.
 * With "thumbnail present" Off/Warn the upload is done and keeps YouTube's frame grab.
 *
 * A channel that may not have custom thumbnails is reported, never failed: the
 * video is already on YouTube, no Story Studio choice can change the channel's
 * answer, and the recorded error is what makes Retry set only the thumbnail
 * once the owner has verified the channel.
 */
async function requireThumbnailSet(slug: string, job: Job, videoId: string, thumb: ThumbnailOutcome): Promise<void> {
  if (!thumb.error) return
  if (thumb.channel_forbidden) {
    const message = `${thumb.error} Uploaded as https://youtu.be/${videoId}; the video is kept. `
      + 'Verify the channel in YouTube Studio, then press Retry to set only the thumbnail.'
    job.output_lines.push(`⚠ ${message}`)
    job.result = {
      ...(job.result || {}),
      warnings: [...((job.result?.warnings as string[] | undefined) || []), message],
    }
    return
  }
  if (await safetyMode(slug, 'thumbnail_present') !== 'block') {
    await safetyGate(slug, 'thumbnail_present', job, `Uploaded as https://youtu.be/${videoId}, but the thumbnail `
      + `could not be set: ${thumb.error} The video keeps YouTube's frame grab; Retry sets only the thumbnail.`)
    return
  }
  requireJobCompletion(job, {
    label: 'YouTube thumbnail',
    expected: 1,
    completed: 0,
    missing: ['thumbnail'],
    message: `Uploaded as https://youtu.be/${videoId}, but the thumbnail could not be set: ${thumb.error} `
      + 'The video is kept. Press Retry to set only the thumbnail — nothing is uploaded again.',
  })
}

/**
 * Retry of an upload whose video went up but whose thumbnail did not: the
 * record names the same video on the same channel, not removed, with no
 * thumbnail set AND a recorded thumbnail failure. A legacy record with no
 * thumbnail and no recorded failure is still refused, as before — that is
 * "Backfill thumbnails", not a retry of this upload.
 */
export function thumbnailOnlyRetry(recorded: UploadSidecar | null, videoId: string, channelId: string): boolean {
  return !!recorded
    && recorded.video_id === videoId
    && recorded.channel_id === channelId
    && !recorded.deleted_at
    && recorded.thumbnail_set !== true
    && !!recorded.last_error
}

async function setRequiredThumbnail(job: Job, input: {
  slug: string
  episodeId: string
  accountId: string
  videoId: string
  fallbackTitle?: string
  sidecarPath: string
  thumbnailFilename?: string | null
}): Promise<void> {
  job.output_lines.push(
    `${input.episodeId} is already on YouTube (https://youtu.be/${input.videoId}) without its thumbnail — `
    + 'setting only the thumbnail; the video is not uploaded again.',
  )
  const meta = await resolveUploadMetadata({
    slug: input.slug,
    episode_code: input.episodeId,
    fallback_title: input.fallbackTitle,
    platform: 'youtube',
    ...(input.thumbnailFilename ? { thumbnail_filename: input.thumbnailFilename } : {}),
  })
  if (!meta.thumbnailPath || !existsSync(meta.thumbnailPath)) {
    const reason = missingThumbnailReason(input.episodeId, meta.thumbnailPath, undefined)
    await stopOrCarryOn(input.slug, 'thumbnail_present', job, `${reason} The video stays on YouTube; nothing is uploaded again.`,
      `${reason} The video stays on YouTube with its own frame grab; nothing is uploaded again.`)
    job.progress = 100
    return
  }
  const thumb = await setThumbnailWithRetry(job, {
    slug: input.slug, accountId: input.accountId, videoId: input.videoId, filePath: meta.thumbnailPath,
  })
  await checkpointThumbnailStateAtPath(
    input.sidecarPath,
    { video_id: input.videoId, account_id: input.accountId },
    { set: !thumb.error, error: thumb.error || undefined, remotely_verified: !thumb.error },
  )
  job.output_dir = path.dirname(input.sidecarPath)
  await requireThumbnailSet(input.slug, job, input.videoId, thumb)
  job.progress = 100
}
