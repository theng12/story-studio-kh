/**
 * TikTok: the Content Posting API's Direct Post flow.
 *
 * Flow (official docs, read 2026-10-27):
 *   1. POST /v2/post/publish/creator_info/query/ — required FIRST. It answers
 *      which privacy levels this creator may use and the longest video they may
 *      post, so the request is built from the answer rather than from a constant.
 *   2. POST /v2/post/publish/video/init/ — with `source: FILE_UPLOAD`, returns
 *      `publish_id` and `upload_url`.
 *   3. PUT the bytes to that `upload_url`, in sequential chunks. Chunks are 5 MB
 *      to 64 MB; the last may be up to 128 MB; 1 to 1000 chunks.
 *   4. POST /v2/post/publish/status/fetch/ until `PUBLISH_COMPLETE` or `FAILED`.
 *
 * Success is `PUBLISH_COMPLETE` with a post id — an accepted init request is not
 * a post, which is exactly the shape AGENTS §8 forbids reporting as done.
 *
 * Sources:
 *   https://developers.tiktok.com/doc/content-posting-api-get-started
 *   https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *   https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 */

import { socialTransport } from './types.js'
import {
  SocialSpecError,
  type SocialAdapter,
  type SocialPostInput,
  type SocialPostOutput,
} from './types.js'

const API = 'https://open.tiktokapis.com/v2'

const MIN_CHUNK = 5 * 1024 * 1024
const MAX_CHUNK = 64 * 1024 * 1024
const MAX_LAST_CHUNK = 128 * 1024 * 1024
const MAX_CHUNKS = 1000
const MAX_BYTES = 4 * 1024 * 1024 * 1024
const MIN_DIMENSION = 360
const MAX_DIMENSION = 4096

/** TikTok's own failure words, from the fail_reason table, as sentences. */
const FAIL_REASON_TEXT: Record<string, string> = {
  file_format_check_failed: 'TikTok rejected the file format. It accepts MP4, WebM or MOV with H.264, H.265, VP8 or VP9.',
  video_duration_check_failed: 'TikTok rejected the video length for this account.',
  video_resolution_check_failed: 'TikTok rejected the picture size.',
  video_aspect_ratio_check_failed: 'TikTok rejected the video shape.',
  frame_rate_check_failed: 'TikTok rejected the frame rate.',
  internal: 'TikTok reported an internal error. Nothing was published; try again.',
}

export function tiktokSpecViolation(input: { durationSec: number; width: number; height: number; sizeBytes: number }): string | null {
  if (input.sizeBytes <= 0) return 'The video file is empty.'
  if (input.sizeBytes > MAX_BYTES) {
    return `TikTok accepts at most 4 GB; this file is ${(input.sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB.`
  }
  for (const [label, value] of [['width', input.width], ['height', input.height]] as const) {
    if (value < MIN_DIMENSION || value > MAX_DIMENSION) {
      return `TikTok accepts ${label} between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels; this video is ${input.width}×${input.height}.`
    }
  }
  if (input.height <= input.width) {
    return `TikTok posts are vertical. This video is ${input.width}×${input.height}; render a vertical version for TikTok.`
  }
  return null
}

/**
 * The chunk plan TikTok requires. Computed from the size, never remembered:
 * `total_chunk_count` is floor(size / chunk), and the remainder rides in the
 * last chunk (which may exceed `chunk_size`, up to 128 MB).
 */
export function planChunks(sizeBytes: number): { chunkSize: number; totalChunks: number } {
  if (sizeBytes <= MIN_CHUNK) return { chunkSize: sizeBytes, totalChunks: 1 }
  // The smallest chunk that keeps the count under the limit, and the last
  // chunk within its own ceiling.
  let chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.ceil(sizeBytes / MAX_CHUNKS)))
  for (;;) {
    const totalChunks = Math.max(1, Math.floor(sizeBytes / chunkSize))
    const lastChunk = sizeBytes - chunkSize * (totalChunks - 1)
    if (lastChunk <= MAX_LAST_CHUNK || chunkSize >= MAX_CHUNK) return { chunkSize, totalChunks }
    chunkSize = Math.min(MAX_CHUNK, chunkSize + MIN_CHUNK)
  }
}

interface TikTokEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; log_id?: string }
}

async function tiktokCall<T>(input: {
  path: string
  accessToken: string
  body: unknown
  what: string
  signal?: AbortSignal
}): Promise<T> {
  const response = await socialTransport(`${API}${input.path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(input.body ?? {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (response.status === 401) {
    throw Object.assign(new Error(`${input.what}: TikTok rejected the saved sign-in. Reconnect this account in Settings → Publishing.`), { code: 'SOCIAL_RECONNECT_REQUIRED' })
  }
  if (!response.ok) throw new Error(`${input.what}: TikTok answered ${response.status}.`)
  const envelope = await response.json() as TikTokEnvelope<T>
  const code = envelope.error?.code
  if (code && code !== 'ok') {
    const detail = envelope.error?.message
    throw new Error(detail ? `${input.what}: ${detail}` : `${input.what}: TikTok refused (${code}).`)
  }
  if (!envelope.data) throw new Error(`${input.what}: TikTok returned no data.`)
  return envelope.data
}

export async function publishTikTokVideo(input: SocialPostInput): Promise<SocialPostOutput> {
  const token = input.credentials.accessToken

  // 1 — ask what this creator may do. Never assumed.
  const creator = await tiktokCall<{
    privacy_level_options?: string[]
    max_video_post_duration_sec?: number
  }>({ path: '/post/publish/creator_info/query/', accessToken: token, body: {}, what: 'TikTok creator info', ...(input.signal ? { signal: input.signal } : {}) })

  const maxDuration = creator.max_video_post_duration_sec
  if (typeof maxDuration === 'number' && maxDuration > 0 && input.durationSec > maxDuration) {
    throw new SocialSpecError(`TikTok lets this account post up to ${Math.floor(maxDuration / 60)} minutes; this video is ${Math.round(input.durationSec / 60)} minutes.`)
  }
  const privacyLevel = (creator.privacy_level_options || []).includes('PUBLIC_TO_EVERYONE')
    ? 'PUBLIC_TO_EVERYONE'
    : (creator.privacy_level_options || [])[0]
  if (!privacyLevel) throw new SocialSpecError('TikTok did not offer a privacy level for this account, so nothing was posted.')
  // An unaudited client is restricted to SELF_ONLY by TikTok itself; say so
  // rather than letting the owner believe a private post went public.
  if (privacyLevel === 'SELF_ONLY') {
    input.log('TikTok only allows private posts for this app until it passes TikTok’s audit. The post will be visible only to the account owner.')
  }

  const { chunkSize, totalChunks } = planChunks(input.sizeBytes)

  // 2 — initialize.
  const init = await tiktokCall<{ publish_id?: string; upload_url?: string }>({
    path: '/post/publish/video/init/',
    accessToken: token,
    what: 'TikTok refused to start the post',
    ...(input.signal ? { signal: input.signal } : {}),
    body: {
      post_info: {
        title: input.caption || input.title,
        privacy_level: privacyLevel,
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: input.sizeBytes,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      },
    },
  })
  const publishId = init.publish_id
  const uploadUrl = init.upload_url
  if (!publishId) throw new Error('TikTok started the post but returned no publish id.')
  if (!uploadUrl) throw new Error('TikTok started the post but returned no upload address.')

  input.log(`TikTok publish ${publishId} started (${totalChunks} chunk${totalChunks === 1 ? '' : 's'}).`)

  // 3 — sequential chunks. `Content-Range` is zero-based and inclusive.
  const { open } = await import('node:fs/promises')
  const handle = await open(input.filePath, 'r')
  try {
    let offset = 0
    for (let index = 0; index < totalChunks; index++) {
      // TikTok's `total_chunk_count` is floor(size / chunk_size) and the LAST
      // chunk absorbs the remainder, which may exceed `chunk_size` (up to
      // 128 MB). Clamping the last chunk to `chunk_size` would send a short
      // file and TikTok would accept it as complete — a truncated video.
      const length = index === totalChunks - 1 ? input.sizeBytes - offset : chunkSize
      const buffer = Buffer.alloc(length)
      const read = await handle.read(buffer, 0, length, offset)
      if (read.bytesRead !== length) {
        throw new Error(`The video changed while it was being posted (read ${read.bytesRead} of ${length} bytes at ${offset}). Nothing was published.`)
      }
      const response = await socialTransport(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(length),
          'Content-Range': `bytes ${offset}-${offset + length - 1}/${input.sizeBytes}`,
        },
        body: new Uint8Array(buffer),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      // 206 = more chunks expected, 201 = all chunks received.
      if (response.status !== 206 && response.status !== 201) {
        throw new Error(`TikTok refused the video bytes (chunk ${index + 1} of ${totalChunks}, HTTP ${response.status}). Nothing was published.`)
      }
      offset += length
      input.onProgress?.(offset, input.sizeBytes)
    }
  } finally {
    await handle.close()
  }

  // 4 — poll until TikTok says the post is live. A publish_id is not a post.
  const deadline = Date.now() + 5 * 60 * 1000
  let status = ''
  while (Date.now() < deadline) {
    const body = await tiktokCall<{
      status?: string
      fail_reason?: string
      publicaly_available_post_id?: Array<number | string>
    }>({
      path: '/post/publish/status/fetch/',
      accessToken: token,
      body: { publish_id: publishId },
      what: 'TikTok would not report the post status',
      ...(input.signal ? { signal: input.signal } : {}),
    })
    status = body.status || ''
    if (status === 'PUBLISH_COMPLETE') {
      // TikTok's own field name is misspelled in its docs and its API; read it as published.
      const ids = body.publicaly_available_post_id || []
      const postId = ids.length ? String(ids[0]) : publishId
      input.log(`TikTok published post ${postId}.`)
      return { post_id: postId }
    }
    if (status === 'FAILED') {
      const reason = body.fail_reason || ''
      const detail = FAIL_REASON_TEXT[reason] || 'TikTok reported that the post failed.'
      throw new Error(`${detail} Nothing was published.`)
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(`TikTok was still processing the post after five minutes (last status ${status || 'unknown'}). Nothing was confirmed published; check the TikTok account before posting again.`)
}

export const tiktokAdapter: SocialAdapter = {
  specViolation: tiktokSpecViolation,
  publish: publishTikTokVideo,
}
