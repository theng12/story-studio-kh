/**
 * Service for optional integrated YouTube captions (closed captions / subtitle track) upload.
 *
 * Implements Item 17 of release 1.4.386:
 * - OFF by default (`enabled: false`).
 * - Never blocks normal video upload on failure or skip.
 * - Honest states: failure preserves the exact remote video ID.
 * - Deduplication guard: detects existing captions for the language and handles
 *   skip/replace based on channel configuration.
 * - Uses existing YouTube client auth, transport, and live quota handling without
 *   inventing unconfigured quota costs.
 */

import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  type YouTubeCaptionSettings,
  type ResolvedCaptionTrack,
  type YouTubeRemoteCaption,
  type CaptionUploadOutcome,
  normalizeCaptionUploadSettings,
} from '../contracts/youtube-caption-upload.js'
import { fetchWithAuthRetry, youtubeTransport } from '../lib/youtube-client.js'
import { friendlyQuotaErrorMessage } from './upload-quota.js'
import { normalizeSrtOrVtt } from '../lib/subtitle-builder.js'

const YOUTUBE_CAPTIONS_API_URL = 'https://www.googleapis.com/youtube/v3/captions'
const YOUTUBE_CAPTIONS_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/captions'

/**
 * Discovers the best matching subtitle file for an episode.
 *
 * Preference order (when 'auto'):
 * 1. `{code}_stitched.srt` (full stitched episode subtitles)
 * 2. `{code}_whisper.srt` (full whisper transcription subtitles)
 * 3. `{code}.srt` (direct episode subtitles)
 * 4. Any other `{code}*.srt` or `*.srt` file in the subtitles directory.
 */
export async function findEpisodeSubtitleTrack(options: {
  episodeCode: string
  subtitlesDir?: string
  episodeDir?: string
  settings?: Partial<YouTubeCaptionSettings>
}): Promise<ResolvedCaptionTrack | null> {
  const code = options.episodeCode.toUpperCase().trim()
  const settings = normalizeCaptionUploadSettings(options.settings)

  const candidateDirs: string[] = []
  if (options.subtitlesDir && existsSync(options.subtitlesDir)) {
    candidateDirs.push(options.subtitlesDir)
  }
  if (options.episodeDir && existsSync(options.episodeDir)) {
    const sub = path.join(options.episodeDir, 'subtitles')
    if (existsSync(sub) && !candidateDirs.includes(sub)) candidateDirs.push(sub)
    if (!candidateDirs.includes(options.episodeDir)) candidateDirs.push(options.episodeDir)
  }

  // 1. If custom path specified and exists, use it
  if (settings.preferred_source === 'custom' && settings.custom_srt_path) {
    if (existsSync(settings.custom_srt_path)) {
      return await inspectAndLoadSubtitleFile(settings.custom_srt_path, settings.language, settings.track_name)
    }
    return null
  }

  // 2. Scan candidate directories
  for (const dir of candidateDirs) {
    let candidateFilenames: string[]
    if (settings.preferred_source === 'stitched') {
      candidateFilenames = [`${code}_stitched.srt`, `${code.toLowerCase()}_stitched.srt`]
    } else if (settings.preferred_source === 'whisper') {
      candidateFilenames = [`${code}_whisper.srt`, `${code.toLowerCase()}_whisper.srt`]
    } else {
      // 'auto': stitched first, then whisper, then direct code
      candidateFilenames = [
        `${code}_stitched.srt`,
        `${code.toLowerCase()}_stitched.srt`,
        `${code}_whisper.srt`,
        `${code.toLowerCase()}_whisper.srt`,
        `${code}.srt`,
        `${code.toLowerCase()}.srt`,
      ]
    }

    for (const name of candidateFilenames) {
      const fullPath = path.join(dir, name)
      if (existsSync(fullPath)) {
        const loaded = await inspectAndLoadSubtitleFile(fullPath, settings.language, settings.track_name)
        if (loaded && loaded.cues_count > 0) return loaded
      }
    }

    // Fallback in auto mode: search directory for any .srt or .vtt file
    if (settings.preferred_source === 'auto') {
      try {
        const entries = await fsp.readdir(dir)
        const srtFiles = entries
          .filter(e => /\.(srt|vtt)$/i.test(e) && !e.startsWith('.'))
          .sort((a, b) => {
            // prefer files starting with episode code
            const aMatch = a.toUpperCase().startsWith(code)
            const bMatch = b.toUpperCase().startsWith(code)
            if (aMatch && !bMatch) return -1
            if (!aMatch && bMatch) return 1
            return a.localeCompare(b)
          })

        for (const name of srtFiles) {
          const fullPath = path.join(dir, name)
          const loaded = await inspectAndLoadSubtitleFile(fullPath, settings.language, settings.track_name)
          if (loaded && loaded.cues_count > 0) return loaded
        }
      } catch {
        // continue to next dir
      }
    }
  }

  return null
}

async function inspectAndLoadSubtitleFile(
  filePath: string,
  language: string,
  trackName: string,
): Promise<ResolvedCaptionTrack | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    if (!raw.trim()) return null
    const filename = path.basename(filePath)
    const { srt, cues } = normalizeSrtOrVtt(raw, { source_filename: filename })
    if (cues <= 0) return null

    const bytes = Buffer.from(srt, 'utf-8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    return {
      file_path: filePath,
      format: filename.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
      language,
      track_name: trackName,
      size_bytes: bytes.length,
      sha256,
      cues_count: cues,
      content: srt,
    }
  } catch {
    return null
  }
}

/**
 * Lists all existing closed caption tracks for a video from YouTube Data API.
 */
export async function listRemoteVideoCaptions(options: {
  slug: string
  accountId: string
  videoId: string
}): Promise<YouTubeRemoteCaption[]> {
  const url = `${YOUTUBE_CAPTIONS_API_URL}?${new URLSearchParams({
    part: 'snippet',
    videoId: options.videoId,
  })}`

  const resp = await fetchWithAuthRetry(options.slug, options.accountId, async (accessToken) => {
    return youtubeTransport(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    })
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `captions.list failed (${resp.status}): ${text.slice(0, 300)}`)
  }

  const data = (await resp.json()) as { items?: Array<{ id: string; snippet?: Record<string, unknown> }> }
  const items = data.items || []

  return items.map((item) => ({
    id: item.id,
    videoId: String(item.snippet?.videoId || options.videoId),
    language: String(item.snippet?.language || ''),
    name: String(item.snippet?.name || ''),
    isDraft: Boolean(item.snippet?.isDraft),
    status: item.snippet?.status ? String(item.snippet.status) : undefined,
    lastUpdated: item.snippet?.lastUpdated ? String(item.snippet.lastUpdated) : undefined,
  }))
}

/**
 * Builds a multipart/related body for YouTube Data API caption upload.
 */
function buildCaptionMultipartPayload(options: {
  metadata: Record<string, unknown>
  content: string
}): { boundary: string; body: Buffer } {
  const boundary = `----StoryStudioCaptionBoundary${Date.now()}_${Math.random().toString(36).slice(2)}`
  const crlf = '\r\n'

  const metaPart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(options.metadata),
    '',
  ].join(crlf)

  const mediaPartHeader = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    '',
  ].join(crlf)

  const mediaClosing = `${crlf}--${boundary}--${crlf}`

  const body = Buffer.concat([
    Buffer.from(metaPart, 'utf-8'),
    Buffer.from(mediaPartHeader, 'utf-8'),
    Buffer.from(options.content, 'utf-8'),
    Buffer.from(mediaClosing, 'utf-8'),
  ])

  return { boundary, body }
}

/**
 * Inserts a new caption track for a YouTube video.
 */
export async function insertRemoteCaptionTrack(options: {
  slug: string
  accountId: string
  videoId: string
  track: ResolvedCaptionTrack
  isDraft?: boolean
}): Promise<{ caption_id: string; language: string; name: string }> {
  const url = `${YOUTUBE_CAPTIONS_UPLOAD_URL}?part=snippet&uploadType=multipart`

  const metadata = {
    snippet: {
      videoId: options.videoId,
      language: options.track.language,
      name: options.track.track_name,
      isDraft: options.isDraft ?? false,
    },
  }

  const { boundary, body } = buildCaptionMultipartPayload({
    metadata,
    content: options.track.content,
  })

  const resp = await fetchWithAuthRetry(options.slug, options.accountId, async (accessToken) => {
    return youtubeTransport(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    })
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `captions.insert failed (${resp.status}): ${text.slice(0, 300)}`)
  }

  const data = (await resp.json()) as { id?: string; snippet?: { language?: string; name?: string } }
  if (!data?.id) {
    throw new Error('YouTube captions.insert returned success but no caption id.')
  }

  return {
    caption_id: data.id,
    language: String(data.snippet?.language || options.track.language),
    name: String(data.snippet?.name || options.track.track_name),
  }
}

/**
 * Updates an existing caption track on YouTube.
 */
export async function updateRemoteCaptionTrack(options: {
  slug: string
  accountId: string
  captionId: string
  videoId: string
  track: ResolvedCaptionTrack
  isDraft?: boolean
}): Promise<{ caption_id: string; language: string; name: string }> {
  const url = `${YOUTUBE_CAPTIONS_UPLOAD_URL}?part=snippet&uploadType=multipart`

  const metadata = {
    id: options.captionId,
    snippet: {
      videoId: options.videoId,
      language: options.track.language,
      name: options.track.track_name,
      isDraft: options.isDraft ?? false,
    },
  }

  const { boundary, body } = buildCaptionMultipartPayload({
    metadata,
    content: options.track.content,
  })

  const resp = await fetchWithAuthRetry(options.slug, options.accountId, async (accessToken) => {
    return youtubeTransport(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    })
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `captions.update failed (${resp.status}): ${text.slice(0, 300)}`)
  }

  const data = (await resp.json()) as { id?: string; snippet?: { language?: string; name?: string } }
  return {
    caption_id: data?.id || options.captionId,
    language: String(data?.snippet?.language || options.track.language),
    name: String(data?.snippet?.name || options.track.track_name),
  }
}

/**
 * Main execution entry point for optional integrated captions upload.
 *
 * Guaranteed contract invariants:
 * 1. If settings are disabled or omitted, skips immediately (returns 'skipped_disabled').
 * 2. If no subtitles exist, skips immediately (returns 'skipped_no_subtitles').
 * 3. Inspects remote captions to deduplicate according to dedupe_mode.
 * 4. NEVER throws: an honest failure outcome ('failed') is returned with the error message
 *    and the remote video ID preserved.
 * 5. Does not alter video ID or fail the overall upload job.
 */
export async function executeOptionalCaptionUpload(params: {
  slug: string
  accountId: string
  videoId: string
  episodeCode: string
  episodeDir?: string
  subtitlesDir?: string
  settings?: unknown
  logLines?: string[]
  trackOverride?: ResolvedCaptionTrack
}): Promise<CaptionUploadOutcome> {
  const { videoId, slug, accountId, episodeCode } = params
  const config = normalizeCaptionUploadSettings(params.settings)

  // 1. Off by default guard
  if (!config.enabled) {
    params.logLines?.push('Closed captions upload is disabled (default); skipped.')
    return {
      status: 'skipped_disabled',
      remote_video_id: videoId,
    }
  }

  // 2. Discover subtitle track
  let track = params.trackOverride ?? null
  if (!track) {
    track = await findEpisodeSubtitleTrack({
      episodeCode,
      episodeDir: params.episodeDir,
      subtitlesDir: params.subtitlesDir,
      settings: config,
    })
  }

  if (!track) {
    const hint = `No valid subtitle file (.srt/.vtt) found for episode ${episodeCode}; skipping captions upload.`
    params.logLines?.push(`⚠ ${hint}`)
    return {
      status: 'skipped_no_subtitles',
      remote_video_id: videoId,
      warning: hint,
    }
  }

  // 3. Deduplication check against remote captions
  try {
    let existingMatch: YouTubeRemoteCaption | undefined
    if (config.dedupe_mode !== 'upload_always') {
      try {
        const remoteCaptions = await listRemoteVideoCaptions({
          slug,
          accountId,
          videoId,
        })
        existingMatch = remoteCaptions.find(
          c => c.language.toLowerCase() === config.language.toLowerCase(),
        )
      } catch (listErr: any) {
        // If listing fails, log warning but proceed with insertion attempt
        params.logLines?.push(`Notice: could not inspect existing remote captions (${listErr?.message || listErr}). Proceeding with upload.`)
      }
    }

    if (existingMatch && config.dedupe_mode === 'skip_if_exists') {
      const msg = `Closed captions track for '${config.language}' already exists on https://youtu.be/${videoId} (id: ${existingMatch.id}); skipped duplicate upload.`
      params.logLines?.push(msg)
      return {
        status: 'skipped_already_exists',
        remote_video_id: videoId,
        caption_id: existingMatch.id,
        language: config.language,
        track_name: config.track_name,
        source_file: track.file_path,
      }
    }

    // 4. Perform upload (update if replacing, otherwise insert)
    params.logLines?.push(`Uploading closed captions track '${config.track_name}' (${config.language}) from ${path.basename(track.file_path)} to https://youtu.be/${videoId}…`)

    if (existingMatch && config.dedupe_mode === 'replace_existing') {
      const updated = await updateRemoteCaptionTrack({
        slug,
        accountId,
        captionId: existingMatch.id,
        videoId,
        track,
        isDraft: config.is_draft,
      })
      params.logLines?.push(`Closed captions updated ✓ (caption ID: ${updated.caption_id})`)
      return {
        status: 'updated',
        remote_video_id: videoId,
        caption_id: updated.caption_id,
        language: updated.language,
        track_name: updated.name,
        source_file: track.file_path,
        details: { sha256: track.sha256, size_bytes: track.size_bytes, cues_count: track.cues_count },
      }
    } else {
      const inserted = await insertRemoteCaptionTrack({
        slug,
        accountId,
        videoId,
        track,
        isDraft: config.is_draft,
      })
      params.logLines?.push(`Closed captions uploaded ✓ (caption ID: ${inserted.caption_id})`)
      return {
        status: 'uploaded',
        remote_video_id: videoId,
        caption_id: inserted.caption_id,
        language: inserted.language,
        track_name: inserted.name,
        source_file: track.file_path,
        details: { sha256: track.sha256, size_bytes: track.size_bytes, cues_count: track.cues_count },
      }
    }
  } catch (err: any) {
    const errorMsg = String(err?.message || err || 'Captions upload failed')
    params.logLines?.push(`⚠ Closed captions upload could not be completed (${errorMsg}). The video upload itself is complete.`)
    return {
      status: 'failed',
      remote_video_id: videoId,
      language: config.language,
      track_name: config.track_name,
      source_file: track.file_path,
      error: errorMsg,
      details: { sha256: track.sha256, size_bytes: track.size_bytes },
    }
  }
}
