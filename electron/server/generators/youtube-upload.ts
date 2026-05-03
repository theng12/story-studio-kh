/**
 * YouTube upload job executor.
 *
 * Runs as a normal queued job so the UI gets SSE progress for free. Flow:
 *   1. Read job params (slug, episode_code, account_id, scheduled_for optional)
 *   2. Locate the video file via episode paths (prefers `{code}_final_video.*`,
 *      falls back to the broadened detection from asset-status.ts)
 *   3. ffprobe sanity-check (duration / video stream / audio)
 *   4. Resolve metadata (title/description/tags/thumbnail) via upload-metadata
 *   5. Sidecar check — if a video_id already exists, metadata-only update.
 *      Otherwise resumable upload → then thumbnails.set (best-effort).
 *   6. Write/update the sidecar with the final state
 */

import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import type { Job } from '../models/types.js'
import { resolveEpisodePaths } from '../services/utils.js'
import * as im from '../services/idea-manager.js'
import * as pm from '../services/project-manager.js'
import { isCancelled } from '../services/job-queue.js'
import { probeForUpload } from '../lib/ffprobe-check.js'
import { resolveUploadMetadata, snippetFromMeta } from '../lib/upload-metadata.js'
import { uploadVideo, updateVideoMetadata, setThumbnail, addVideoToPlaylist, type PrivacyStatus } from '../lib/youtube-client.js'
import { readSidecar, writeSidecar, type UploadSidecar } from '../services/upload-sidecar.js'
import * as store from '../services/upload-store.js'
import * as playlistsSvc from '../services/upload-playlists.js'
import {
  readResumeSidecar,
  deleteResumeSidecar,
  isSidecarUsable,
  sessionUrlHash,
} from '../services/upload-resume-sidecar.js'
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'

interface YouTubeUploadParams {
  episode_id: string
  account_id?: string
  scheduled_for?: string | null   // ISO 8601; null/omitted = upload as private, no publishAt
  privacy_status?: PrivacyStatus
  /**
   * When true on the metadata-only path, omit the YouTube `status` block
   * entirely so the existing video's privacyStatus and publishAt stay
   * exactly as they are on YouTube. Default for the per-row "↻ Update
   * metadata" button: users who just want to fix a title typo shouldn't
   * silently flip a published video back to private. Ignored on the
   * fresh-upload path (a new video must declare a privacyStatus).
   */
  preserve_status?: boolean
  /**
   * Per-upload playlist override (A5). If set, wins over the project's
   * default-playlist config. Empty string or null means "fall through to
   * default"; the sentinel `_none_` means "do not add to any playlist
   * even if a default is configured".
   */
  playlist_id?: string | null
  // NOTE: the previous `force_fresh` escape hatch was removed in the
  // production-readiness audit. Re-running an upload on an episode that
  // already has a sidecar always does a metadata-only PATCH; video
  // content is immutable once uploaded. If a "Replace video" feature is
  // ever added, it needs its own explicit confirmation flow, a clear
  // warning that the old YouTube URL will be orphaned, and an optional
  // pre-delete of the old video — not a boolean param.
}

export async function generateYoutubeUpload(job: Job): Promise<void> {
  const slug = job.project_slug
  const params = (job.params || {}) as YouTubeUploadParams
  const episodeId = params.episode_id || job.episode_id
  if (!episodeId) throw new Error('episode_id is required')

  job.output_lines.push(`YouTube upload — ${episodeId}`)

  // Resolve account — default if not specified.
  const accountId = params.account_id || (await store.getDefaultAccountId(slug, 'youtube'))
  if (!accountId) throw new Error('No YouTube account connected. Open Upload Center and connect a channel first.')
  const accounts = await store.listAccounts(slug, 'youtube')
  const account = accounts.find(a => a.id === accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found — reconnect in Upload Center.`)
  job.output_lines.push(`Using channel: ${account.remote_title} (${account.remote_id})`)

  // Lookup episode + paths.
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '') === episodeId)
  if (!idea) throw new Error(`Accepted idea not found for ${episodeId}`)
  const paths = await resolveEpisodePaths(slug, episodeId, idea.title || '')

  // Item J — resolve the project's YouTube videoCategories.list ID once
  // for this run; threaded into both snippetFromMeta call sites below
  // (fresh upload + metadata-only PATCH). Falls back to undefined on any
  // error → snippetFromMeta defaults to '22' ("People & Blogs"), the
  // historical hard-code.
  const projectConfig = await pm.getConfig(slug).catch(() => null) as any
  const categoryId: number | undefined = (typeof projectConfig?.category_id === 'number'
    && Number.isFinite(projectConfig.category_id)
    && projectConfig.category_id > 0)
    ? projectConfig.category_id : undefined

  // Branch: fresh upload vs metadata-only update.
  //
  // A sidecar with a video_id means we've uploaded this episode before —
  // any subsequent click is a metadata PATCH on the existing YouTube
  // video, NOT a re-upload (video content is immutable by design). We
  // check the sidecar BEFORE any video-file lookup because:
  //   1. metadata-only PATCH doesn't need the local video at all — and
  //      requiring it broke the "↻ Update metadata" button after users
  //      cleared their local final-video to save disk space (Issue 5,
  //      2026-04-28 batch). The job would fail with "No final video
  //      file found" even though the upload was already on YouTube.
  //   2. ffprobe also runs on the file, so reordering also avoids a
  //      pointless probe on a file we'd never read.
  const existing = await readSidecar(slug, episodeId, idea.title || '', 'youtube')
  const shouldUpdateOnly = !!existing && !!existing.video_id

  let videoPath: string | null = null
  if (!shouldUpdateOnly) {
    // Fresh-upload path needs the local video file. We pass slug + code
    // + title so the lookup can check the external_final_video_root
    // (per-machine Settings → Storage path) BEFORE falling back to the
    // project-tree video_dir — same precedence the asset-status detector
    // uses so the pipeline view and the upload generator never disagree
    // about whether the final exists.
    videoPath = await findFinalVideoPath(paths, slug, episodeId, idea.title || '')
    if (!videoPath) {
      throw new Error(`No final video file found for ${episodeId}. Run Video Assembly or drop a file into this episode's video folder (or the external final-video root if configured in Settings → Storage).`)
    }
    job.output_lines.push(`Source video: ${path.relative(paths.episode_dir, videoPath)}`)

    // ffprobe sanity check (duration / streams) — only meaningful for
    // fresh uploads since metadata-only PATCH never reads the file.
    job.output_lines.push('Probing video with ffprobe…')
    const probe = await probeForUpload(videoPath)
    if (!probe.ok) throw new Error(probe.error || 'ffprobe rejected the file')
    job.output_lines.push(`Probe OK — ${Math.round(probe.durationSec / 60)} min · ${probe.width}×${probe.height} · ${probe.hasAudio ? 'audio present' : 'no audio'}`)
  } else {
    job.output_lines.push(`Metadata-only update — skipping local video lookup (existing upload: ${existing!.video_id}).`)
  }

  // Resolve metadata.
  const meta = await resolveUploadMetadata({
    slug,
    episode_code: episodeId,
    fallback_title: idea.title,
    platform: 'youtube',
  })
  job.output_lines.push(`Metadata — title: "${meta.title}", tags: ${meta.tags.length}, thumbnail: ${meta.thumbnailPath ? 'yes' : 'no'}`)

  // Update-only data-quality guard: if the user clicked "Update metadata"
  // but no metadata.json exists on disk, resolveUploadMetadata silently
  // falls back to title-only (the idea title). Pushing that to YouTube
  // would erase the rich description/tags the user already had on the
  // existing video — a stealth data loss. Refuse with an actionable
  // error instead so the user generates metadata first.
  if (shouldUpdateOnly) {
    const hasMetadataFile = existsSync(paths.metadata_json) || existsSync(paths.metadata_txt)
    if (!hasMetadataFile) {
      throw new Error(
        `No metadata file for ${episodeId}. Generate metadata in the Metadata Generator (or fill it manually) before updating YouTube — ` +
        `pushing the title-only fallback would overwrite the description and tags currently on the YouTube video. ` +
        `Expected file: ${path.relative(paths.episode_dir, paths.metadata_json)}`,
      )
    }
  }

  const privacy: PrivacyStatus = params.privacy_status || 'private'
  // Private-first mode: user wants to manage scheduling inside YouTube
  // Studio directly. We still upload as private (that's always our
  // default) but we DROP any publishAt the plan / item-schedule map
  // computed. The video lands on YouTube with no scheduled transition;
  // YT Studio's scheduling UI takes over. Reading the mode here keeps
  // every upload path (per-row Upload, plan Apply, bulk) honoring it
  // consistently with no callers remembering to gate on their end.
  const uploadMode = await store.getUploadMode(slug, 'youtube')
  const publishAt = uploadMode === 'private'
    ? undefined
    : (params.scheduled_for || undefined)
  if (uploadMode === 'private' && params.scheduled_for) {
    job.output_lines.push(`Private-first mode: ignoring plan publishAt (${params.scheduled_for}); manage schedule in YouTube Studio.`)
  }

  let videoId: string
  let uploaded: any

  if (shouldUpdateOnly) {
    // Channel-mismatch guard. If the project's currently-connected
    // channel differs from the channel the sidecar was written against,
    // PATCHing would resolve videoId against the wrong tokens and
    // YouTube would 404. Surface an actionable message that points at
    // the existing per-row Reset button.
    if (existing!.channel_id && existing!.channel_id !== account.remote_id) {
      throw new Error(
        `This episode was uploaded to channel "${existing!.channel_id}" but your project is now connected to channel "${account.remote_id}" (${account.remote_title}). ` +
        `Click ♻ Reset on this row to clear the old upload record, then Upload again — a fresh video will be created on the current channel. ` +
        `The old video on "${existing!.channel_id}" is unaffected.`
      )
    }
    job.output_lines.push(`Existing upload detected (${existing!.video_id}) — updating metadata in place.`)
    // Preserve current YouTube privacy + publishAt by default. Re-pushing
    // privacyStatus on a metadata-only update would silently flip a
    // public video to private, or wipe an existing schedule, which is
    // almost never what the user wants when they just clicked "↻ Update
    // metadata" to fix a title typo. The caller can opt out by passing
    // preserve_status: false (e.g. a future "Update metadata + privacy"
    // affordance).
    const preserveStatus = params.preserve_status !== false
    if (preserveStatus) {
      job.output_lines.push('Preserving current YouTube privacy + schedule (not changed). Pass preserve_status: false to also update them.')
    }
    uploaded = await updateVideoMetadata({
      slug,
      accountId,
      videoId: existing!.video_id,
      snippet: snippetFromMeta(meta, job.output_lines, categoryId),
      ...(preserveStatus ? {} : { status: { privacyStatus: privacy, publishAt } }),
    })
    videoId = uploaded.id
    job.progress = 90
  } else {
    // Fresh-upload branch — videoPath was assigned + non-null-checked in
    // the matching !shouldUpdateOnly block above. Re-narrow for TS, since
    // the type-narrowing from that block doesn't carry across the meta-
    // resolution code that sits between them.
    if (!videoPath) throw new Error('internal: missing videoPath in fresh-upload branch')
    // Restart-safe resume (audit-reports/10-uploads.md M4): if a transient
    // sidecar from a prior interrupted run exists AND its TTL hasn't
    // expired AND file_size matches AND account_id matches, hand the
    // session URL to uploadVideo so it skips init + the 1600-unit quota
    // charge. Mismatches drop the sidecar so the next attempt starts
    // fresh against a usable session.
    const resumeSidecar = await readResumeSidecar(slug, episodeId, 'youtube')
    let resumeFromSessionUrl: string | undefined
    if (resumeSidecar) {
      const fileStat = await fsp.stat(videoPath).catch(() => null)
      const currentFileSize = fileStat?.size ?? -1
      const usable = isSidecarUsable({
        sidecar: resumeSidecar,
        currentFileSize,
        currentAccountId: accountId,
      })
      if (usable.ok) {
        resumeFromSessionUrl = resumeSidecar.session_url
        job.output_lines.push(
          `Found resumable upload from ${resumeSidecar.created_at} — will resume against existing session ${sessionUrlHash(resumeSidecar.session_url)} (no fresh quota charge).`,
        )
        if (resumeSidecar.created_at && publishAt && resumeSidecar.session_url) {
          // The init snippet was sent to Google when the session was
          // created. publishAt / privacy_status changes the user makes
          // between init and the resumed upload can't be honored here —
          // they'd require a metadata PATCH after the upload completes.
          job.output_lines.push(
            `⚠ Resuming with the original metadata; if you changed scheduled_for or privacy after the original upload started, those changes will need a separate metadata update after the upload completes.`,
          )
        }
      } else {
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

    job.output_lines.push(resumeFromSessionUrl ? 'Resuming resumable upload…' : 'Starting resumable upload…')
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
    uploaded = await uploadVideo({
      slug,
      accountId,
      filePath: videoPath,
      snippet: snippetFromMeta(meta, job.output_lines, categoryId),
      status: { privacyStatus: privacy, publishAt },
      signal: abort.signal,
      episodeCode: episodeId,
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
    })
    // Freeze metrics at completion so the UI stops mid-flight tickers.
    job.bytes_done = job.bytes_total
    job.speed_bps = 0
    job.eta_seconds = 0
    videoId = uploaded.id
    job.progress = 85
    job.output_lines.push(`Upload complete — video id: ${videoId}`)
  }

  // Thumbnail — best-effort. Channel must be verified for custom thumbnails;
  // a failure here is a warning in the sidecar, not a fatal error.
  let thumbnail_set = existing?.thumbnail_set || false
  let thumb_error = ''
  if (meta.thumbnailPath && existsSync(meta.thumbnailPath)) {
    try {
      await setThumbnail({ slug, accountId, videoId, filePath: meta.thumbnailPath })
      thumbnail_set = true
      job.output_lines.push('Thumbnail set ✓')
    } catch (e: any) {
      thumb_error = String(e?.message || 'thumbnail failed')
      job.output_lines.push(`⚠ Thumbnail upload skipped: ${thumb_error}`)
    }
  }
  job.progress = 95

  // Write / refresh sidecar.
  const sidecar: UploadSidecar = {
    platform: 'youtube',
    video_id: videoId,
    account_id: accountId,
    channel_id: account.remote_id,
    uploaded_at: existing?.uploaded_at || new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    scheduled_for: publishAt || null,
    privacy_status: privacy,
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    thumbnail_set,
    last_error: thumb_error || undefined,
  }
  await writeSidecar(slug, episodeId, idea.title || '', sidecar)
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
      await addVideoToPlaylist({ slug, accountId, playlistId: playlistToUse, videoId })
      job.output_lines.push(`Added to playlist ${playlistToUse}.`)
    } catch (e: any) {
      job.output_lines.push(`⚠ Playlist add failed: ${e?.message || 'unknown'} — upload itself is OK.`)
    }
  }
}

/**
 * Find the final assembled video for an episode. Mirrors the broadened
 * detection in asset-status.ts but returns a concrete path rather than a
 * boolean — pick the first match the detection logic surfaces.
 */
async function findFinalVideoPath(
  paths: { episode_dir: string; video_dir: string },
  slug: string,
  code: string,
  title: string,
): Promise<string> {
  const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v']
  const isVideo = (n: string) => VIDEO_EXTS.some(e => n.toLowerCase().endsWith(e))
  const isScene = (n: string) => /[_\- ]scene[_\- ]?\d+/i.test(n)

  // 0. EXTERNAL final-video root takes priority over the project tree.
  // When the user has configured `external_final_video_root` (Settings →
  // Storage), the video-assembly generator writes finals there, NOT into
  // the iCloud-synced project tree's video_dir. Without this branch the
  // upload generator would fail with "No final video file found" even
  // though the file is sitting on disk at the user's chosen external
  // location. Mirrors Path E in asset-status.ts so detection + upload
  // stay in lockstep.
  try {
    const { resolveExternalFinalVideoDir } = await import('../services/external-video-store.js')
    const externalDir = await resolveExternalFinalVideoDir(slug, code, title)
    if (externalDir) {
      try {
        const extFiles = await fsp.readdir(externalDir)
        const final = extFiles.find(n => /^[A-Z]+\d+_final_video\./i.test(n) && isVideo(n))
        if (final) return path.join(externalDir, final)
      } catch { /* external dir not yet created — fall through */ }
    }
  } catch { /* import failure — fall through */ }

  // 1. Native `{code}_final_video.*` wins.
  try {
    const videoDirFiles = await fsp.readdir(paths.video_dir)
    const final = videoDirFiles.find(n => /^[A-Z]+\d+_final_video\./i.test(n) && isVideo(n))
    if (final) return path.join(paths.video_dir, final)
    // 2. Any non-scene video in video_dir.
    const nonScene = videoDirFiles.find(n => isVideo(n) && !isScene(n))
    if (nonScene) return path.join(paths.video_dir, nonScene)
  } catch { /* fall through */ }

  // 3. Any video at episode_dir root.
  try {
    const epEntries = await fsp.readdir(paths.episode_dir, { withFileTypes: true })
    const rootVideo = epEntries.find(e => e.isFile() && isVideo(e.name))
    if (rootVideo) return path.join(paths.episode_dir, rootVideo.name)
    // 4. Any video inside a final/assembl/output/export sibling folder.
    for (const e of epEntries) {
      if (!e.isDirectory()) continue
      if (!/(final|assembl|output|export)/i.test(e.name)) continue
      const inner = await fsp.readdir(path.join(paths.episode_dir, e.name))
      const hit = inner.find(n => isVideo(n))
      if (hit) return path.join(paths.episode_dir, e.name, hit)
    }
  } catch { /* ignore */ }

  return ''
}
