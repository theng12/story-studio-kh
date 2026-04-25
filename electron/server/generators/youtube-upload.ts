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

interface YouTubeUploadParams {
  episode_id: string
  account_id?: string
  scheduled_for?: string | null   // ISO 8601; null/omitted = upload as private, no publishAt
  privacy_status?: PrivacyStatus
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

  // Lookup episode's final video path.
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '') === episodeId)
  if (!idea) throw new Error(`Accepted idea not found for ${episodeId}`)
  const paths = await resolveEpisodePaths(slug, episodeId, idea.title || '')

  const videoPath = await findFinalVideoPath(paths)
  if (!videoPath) {
    throw new Error(`No final video file found for ${episodeId}. Run Video Assembly or drop a file into this episode's video folder.`)
  }
  job.output_lines.push(`Source video: ${path.relative(paths.episode_dir, videoPath)}`)

  // ffprobe sanity check (duration / streams).
  job.output_lines.push('Probing video with ffprobe…')
  const probe = await probeForUpload(videoPath)
  if (!probe.ok) throw new Error(probe.error || 'ffprobe rejected the file')
  job.output_lines.push(`Probe OK — ${Math.round(probe.durationSec / 60)} min · ${probe.width}×${probe.height} · ${probe.hasAudio ? 'audio present' : 'no audio'}`)

  // Resolve metadata.
  const meta = await resolveUploadMetadata({
    slug,
    episode_code: episodeId,
    fallback_title: idea.title,
    platform: 'youtube',
  })
  job.output_lines.push(`Metadata — title: "${meta.title}", tags: ${meta.tags.length}, thumbnail: ${meta.thumbnailPath ? 'yes' : 'no'}`)

  // Decide: fresh upload or metadata-only update?
  // A sidecar with a video_id means we've already uploaded this episode —
  // PATCH metadata in place. Video content is immutable by design.
  const existing = await readSidecar(slug, episodeId, idea.title || '', 'youtube')
  const shouldUpdateOnly = !!existing && !!existing.video_id

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
    uploaded = await updateVideoMetadata({
      slug,
      accountId,
      videoId: existing!.video_id,
      snippet: snippetFromMeta(meta, job.output_lines),
      status: { privacyStatus: privacy, publishAt },
    })
    videoId = uploaded.id
    job.progress = 90
  } else {
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
    uploaded = await uploadVideo({
      slug,
      accountId,
      filePath: videoPath,
      snippet: snippetFromMeta(meta, job.output_lines),
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
        const pct = Math.floor((sent / total) * 85)
        if (pct !== job.progress) {
          job.progress = pct
        }
      },
    })
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
async function findFinalVideoPath(paths: { episode_dir: string; video_dir: string }): Promise<string> {
  const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v']
  const isVideo = (n: string) => VIDEO_EXTS.some(e => n.toLowerCase().endsWith(e))
  const isScene = (n: string) => /[_\- ]scene[_\- ]?\d+/i.test(n)

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
