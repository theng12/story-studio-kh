/**
 * Meta: Facebook Page videos and Instagram Reels.
 *
 * Both are published from a LOCAL file, never a public URL — Story Studio has
 * no public hosting and must not gain one for this. That decides the flow:
 *
 *   Facebook Page video   POST /{page-id}/videos with `file_url` is out, so the
 *                         resumable session is used: POST /{app-id}/uploads →
 *                         POST /upload:{session} with the bytes → publish with
 *                         the returned handle.
 *   Instagram Reels       POST /{ig-id}/media with `media_type=REELS` and
 *                         `upload_type=resumable` → PUT the bytes to
 *                         rupload.facebook.com/ig-api-upload/… → poll the
 *                         container → POST /{ig-id}/media_publish.
 *
 * Specs are Meta's published ones, checked BEFORE any byte is sent so a 16:9
 * render is refused in words the owner understands instead of failing at Meta.
 *
 * Sources (official docs, read 2026-10-27):
 *   https://developers.facebook.com/docs/video-api/guides/reels-publishing
 *   https://developers.facebook.com/docs/video-api/guides/publishing
 *   https://developers.facebook.com/docs/instagram-platform/content-publishing
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 */

import { socialTransport } from './types.js'
import {
  SocialSpecError,
  type SocialAdapter,
  type SocialPostInput,
  type SocialPostOutput,
} from './types.js'

const GRAPH = 'https://graph.facebook.com/v26.0'
const RUPLOAD = 'https://rupload.facebook.com'

/** Meta publishes 30 API-published Reels per Page per rolling 24 h; the API reports it. */
export const FACEBOOK_REELS_DAILY_LIMIT = 30

/**
 * Instagram's published Reels limits. The Facebook Page video guide publishes
 * no duration or size ceiling, so only the aspect requirement is enforced
 * there — inventing a number would be worse than not having one.
 */
const INSTAGRAM_MAX_BYTES = 300 * 1024 * 1024
const INSTAGRAM_MIN_SECONDS = 3
const INSTAGRAM_MAX_SECONDS = 15 * 60

export function instagramSpecViolation(input: { durationSec: number; width: number; height: number; sizeBytes: number }): string | null {
  if (input.sizeBytes > INSTAGRAM_MAX_BYTES) {
    return `Instagram accepts at most 300 MB; this file is ${(input.sizeBytes / (1024 * 1024)).toFixed(0)} MB.`
  }
  if (input.durationSec < INSTAGRAM_MIN_SECONDS || input.durationSec > INSTAGRAM_MAX_SECONDS) {
    return `Instagram accepts Reels between ${INSTAGRAM_MIN_SECONDS} seconds and 15 minutes; this one is ${Math.round(input.durationSec)} seconds.`
  }
  if (input.height <= input.width) {
    return `Instagram Reels are vertical (9:16). This video is ${input.width}×${input.height}; render a vertical version for Instagram.`
  }
  if (input.width > 1920) {
    return `Instagram accepts at most 1920 pixels across; this video is ${input.width} wide.`
  }
  return null
}

/**
 * Facebook Page videos accept any landscape or portrait video, but a video that
 * Meta cannot read at all is refused here rather than after an upload.
 */
export function facebookSpecViolation(input: { durationSec: number; width: number; height: number; sizeBytes: number }): string | null {
  if (input.sizeBytes <= 0) return 'The video file is empty.'
  if (input.durationSec <= 0) return 'The video file reports no duration.'
  if (input.width <= 0 || input.height <= 0) return 'The video file reports no picture size.'
  return null
}

interface GraphError {
  message?: string
  type?: string
  code?: number
  error_subcode?: number
  error_user_msg?: string
}

/** Meta's own words when it publishes them, and a plain sentence when it does not. */
async function graphFailure(response: Response, what: string): Promise<Error> {
  let body: { error?: GraphError } | null = null
  try { body = await response.json() as { error?: GraphError } } catch { /* provider sent no JSON */ }
  const error = body?.error
  const detail = error?.error_user_msg || error?.message
  const code = error?.code
  // 190 = the access token is no longer valid. That is a reconnect, not a retry:
  // the owner has to grant again, and saying so is the whole value of this branch.
  if (code === 190 || code === 102) {
    return Object.assign(new Error(`${what}: Facebook rejected the saved sign-in. Reconnect this account in Settings → Publishing.`), { code: 'SOCIAL_RECONNECT_REQUIRED' })
  }
  return new Error(detail ? `${what}: ${detail}` : `${what}: Facebook answered ${response.status}.`)
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T
}

/** One Meta app id is needed to open a resumable upload session. */
function requireAppId(input: SocialPostInput): string {
  if (!input.credentials.appId) {
    throw new SocialSpecError('The Meta app ID is not saved. Save the Meta application in Settings → Publishing before posting to Facebook.')
  }
  return input.credentials.appId
}

function requirePage(input: SocialPostInput): { pageId: string; token: string } {
  const pageId = input.credentials.pageId
  const token = input.credentials.pageToken
  if (!pageId || !token) {
    throw new SocialSpecError('This account has no Page sign-in saved. Reconnect it in Settings → Publishing.')
  }
  return { pageId, token }
}

/**
 * Stream a local file to an `rupload`-style endpoint.
 *
 * The whole body is read once: these are finished episode renders, and a
 * chunked reader here would add a failure mode (a partial chunk Meta counts as
 * a complete file) for no benefit on files this size.
 */
async function uploadBytes(input: {
  url: string
  headers: Record<string, string>
  filePath: string
  sizeBytes: number
  signal?: AbortSignal
  onProgress?: (sent: number, total: number) => void
}): Promise<Response> {
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(input.filePath)
  if (bytes.byteLength !== input.sizeBytes) {
    throw new Error(`The video changed while it was being posted (${bytes.byteLength} bytes on disk, ${input.sizeBytes} expected). Nothing was published.`)
  }
  input.onProgress?.(0, input.sizeBytes)
  const response = await socialTransport(input.url, {
    method: 'POST',
    headers: input.headers,
    body: new Uint8Array(bytes),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  input.onProgress?.(input.sizeBytes, input.sizeBytes)
  return response
}

/** Facebook Page video: resumable session, then publish with the handle. */
export async function publishFacebookVideo(input: SocialPostInput): Promise<SocialPostOutput> {
  const { pageId, token } = requirePage(input)
  const appId = requireAppId(input)

  const sessionResponse = await socialTransport(`${GRAPH}/${encodeURIComponent(appId)}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      file_name: input.filePath.split('/').pop() || 'video.mp4',
      file_length: String(input.sizeBytes),
      file_type: 'video/mp4',
      access_token: token,
    }).toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!sessionResponse.ok) throw await graphFailure(sessionResponse, 'Facebook refused to open the upload')
  const session = await readJson<{ id?: string }>(sessionResponse)
  if (!session.id) throw new Error('Facebook opened an upload session without an id.')

  input.log(`Facebook upload session ${session.id} opened.`)
  // The session id is already `upload:<id>`; encoding the colon would address a
  // node Meta does not have.
  const uploadResponse = await uploadBytes({
    url: `${GRAPH}/${session.id}`,
    headers: {
      Authorization: `OAuth ${token}`,
      file_offset: '0',
      'Content-Type': 'application/octet-stream',
    },
    filePath: input.filePath,
    sizeBytes: input.sizeBytes,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  })
  if (!uploadResponse.ok) throw await graphFailure(uploadResponse, 'Facebook refused the video bytes')
  const uploaded = await readJson<{ h?: string }>(uploadResponse)
  if (!uploaded.h) throw new Error('Facebook finished the upload without returning a file handle.')

  const publishResponse = await socialTransport(`${GRAPH}/${encodeURIComponent(pageId)}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      fbuploader_video_file_chunk: uploaded.h,
      title: input.title,
      description: input.caption,
      access_token: token,
    }).toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!publishResponse.ok) throw await graphFailure(publishResponse, 'Facebook refused to publish the video')
  const published = await readJson<{ id?: string }>(publishResponse)
  if (!published.id) throw new Error('Facebook accepted the publish request but returned no video id.')

  input.log(`Facebook published video ${published.id}.`)
  return { post_id: published.id, permalink: `https://www.facebook.com/watch/?v=${published.id}` }
}

/** Instagram Reels: resumable container, poll until FINISHED, then media_publish. */
export async function publishInstagramReel(input: SocialPostInput): Promise<SocialPostOutput> {
  const { token } = requirePage(input)
  const igId = input.credentials.remoteId

  const createResponse = await socialTransport(`${GRAPH}/${encodeURIComponent(igId)}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: input.caption,
      share_to_feed: 'true',
      access_token: token,
    }).toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!createResponse.ok) throw await graphFailure(createResponse, 'Instagram refused to create the Reel')
  const container = await readJson<{ id?: string }>(createResponse)
  if (!container.id) throw new Error('Instagram created a media container without an id.')

  input.log(`Instagram container ${container.id} created.`)
  const uploadResponse = await uploadBytes({
    url: `${RUPLOAD}/ig-api-upload/v26.0/${encodeURIComponent(container.id)}`,
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(input.sizeBytes),
      'Content-Type': 'application/octet-stream',
    },
    filePath: input.filePath,
    sizeBytes: input.sizeBytes,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  })
  if (!uploadResponse.ok) throw await graphFailure(uploadResponse, 'Instagram refused the video bytes')

  // Meta's own guidance: poll once a minute, for no more than five minutes.
  const deadline = Date.now() + 5 * 60 * 1000
  let status = ''
  while (Date.now() < deadline) {
    const statusResponse = await socialTransport(
      `${GRAPH}/${encodeURIComponent(container.id)}?fields=status_code&access_token=${encodeURIComponent(token)}`,
      { method: 'GET', ...(input.signal ? { signal: input.signal } : {}) },
    )
    if (!statusResponse.ok) throw await graphFailure(statusResponse, 'Instagram would not report the Reel status')
    const body = await readJson<{ status_code?: string }>(statusResponse)
    status = body.status_code || ''
    if (status === 'FINISHED') break
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Instagram could not process this video (status ${status}). Nothing was published.`)
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  if (status !== 'FINISHED') {
    throw new Error('Instagram was still processing the video after five minutes. Nothing was published; try again once Instagram has finished with it.')
  }

  const publishResponse = await socialTransport(`${GRAPH}/${encodeURIComponent(igId)}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: container.id, access_token: token }).toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!publishResponse.ok) throw await graphFailure(publishResponse, 'Instagram refused to publish the Reel')
  const published = await readJson<{ id?: string }>(publishResponse)
  if (!published.id) throw new Error('Instagram published the Reel but returned no media id.')

  input.log(`Instagram published media ${published.id}.`)
  return { post_id: published.id, permalink: `https://www.instagram.com/reel/${published.id}/` }
}

export const facebookAdapter: SocialAdapter = {
  specViolation: facebookSpecViolation,
  publish: publishFacebookVideo,
}

// ── Facebook Page photo (Still Posts) ───────────────────────────────────────
//
// A photo is uploaded as multipart `source`, so it needs no public address —
// the same reason the video path exists. Meta's published photo limits are
// 10 MB and JPEG/PNG/GIF/BMP/TIFF; Story's renderer writes PNG.

export const FACEBOOK_PHOTO_MAX_BYTES = 10 * 1024 * 1024

export function facebookPhotoSpecViolation(input: { sizeBytes: number }): string | null {
  if (input.sizeBytes <= 0) return 'The image file is empty.'
  if (input.sizeBytes > FACEBOOK_PHOTO_MAX_BYTES) {
    return `Facebook accepts photos up to 10 MB; this image is ${(input.sizeBytes / (1024 * 1024)).toFixed(1)} MB.`
  }
  return null
}

/** Facebook Page photo: one multipart POST to `/{page-id}/photos`. */
export async function publishFacebookPhoto(input: SocialPostInput): Promise<SocialPostOutput> {
  const { pageId, token } = requirePage(input)
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(input.filePath)
  if (bytes.byteLength !== input.sizeBytes) {
    throw new Error(`The image changed while it was being posted (${bytes.byteLength} bytes on disk, ${input.sizeBytes} expected). Nothing was published.`)
  }
  input.onProgress?.(0, input.sizeBytes)
  const form = new FormData()
  form.append('caption', input.caption)
  form.append('published', 'true')
  form.append('access_token', token)
  form.append('source', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), input.filePath.split('/').pop() || 'post.png')

  const response = await socialTransport(`${GRAPH}/${encodeURIComponent(pageId)}/photos`, {
    method: 'POST',
    body: form,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!response.ok) throw await graphFailure(response, 'Facebook refused the photo')
  const published = await readJson<{ id?: string, post_id?: string }>(response)
  const postId = published.post_id || published.id
  if (!postId) throw new Error('Facebook accepted the photo but returned no post id.')

  input.log(`Facebook published photo ${postId}.`)
  return { post_id: postId, permalink: `https://www.facebook.com/${postId}` }
}

export const instagramAdapter: SocialAdapter = {
  specViolation: instagramSpecViolation,
  publish: publishInstagramReel,
}
