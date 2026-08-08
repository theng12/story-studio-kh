/**
 * YouTube Data API v3 client — thin wrapper covering the endpoints we use.
 *
 * What's here:
 *   - `uploadVideo`           — resumable upload (init → PUT bytes) with progress.
 *   - `updateVideoMetadata`   — PATCH snippet+status on an existing video_id.
 *   - `setThumbnail`          — POST image bytes to thumbnails.set.
 *   - `getValidAccessToken`   — returns a ready-to-use access_token, refreshing
 *                               on demand via the stored refresh_token.
 *   - `listRecentUploads`     — fetches the authenticated channel's uploads
 *                               playlist (used by Phase 6 reconcile).
 *
 * We deliberately don't depend on `googleapis` — the surface is small, the
 * SDK is large, and the resumable-upload path is easier to stream-progress
 * from raw fetch + fs.createReadStream than through the SDK's wrappers.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import type { OAuthTokenBundle } from './youtube-oauth.js'
import { refreshAccessToken } from './youtube-oauth.js'
import * as store from '../services/upload-store.js'
import { checkQuota, recordQuotaUsage, friendlyQuotaErrorMessage, type QuotaKey } from '../services/upload-quota.js'
import { logLine } from '../services/logger.js'
import { prepareThumbnail } from './thumbnail-prepare.js'
import {
  writeResumeSidecar,
  deleteResumeSidecar,
  sessionUrlHash,
} from '../services/upload-resume-sidecar.js'

/**
 * Wrapper around `recordQuotaUsage` that logs at warn level on failure
 * instead of swallowing silently. The underlying YouTube API call has
 * already succeeded by the time we get here, so we never re-throw — but a
 * silent ledger miss leaves the UI showing a stale "0 / 10,000" while
 * Google's real counter ticks up. recordQuotaUsage also writes a
 * `youtube_quota_ledger_stale: true` flag to config.json on failure so the
 * UI banner can warn the user.
 */
async function recordQuotaOrLog(slug: string, key: QuotaKey): Promise<void> {
  try {
    await recordQuotaUsage(slug, key)
  } catch (e: any) {
    logLine('warn', `[upload-quota] ledger write failed: ${e?.message || 'unknown'}`, {
      slug,
      key,
    })
  }
}

const UPLOAD_INIT_URL = 'https://www.googleapis.com/upload/youtube/v3/videos'
const VIDEOS_UPDATE_URL = 'https://www.googleapis.com/youtube/v3/videos'
const THUMBNAILS_SET_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set'
const PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems'
const PLAYLISTS_URL = 'https://www.googleapis.com/youtube/v3/playlists'
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'

export interface VideoSnippet {
  title: string
  description?: string
  tags?: string[]
  /**
   * YouTube videoCategoryId. Defaults to '24' (Entertainment) at upload
   * time when the project config doesn't specify one — Entertainment is
   * the right bucket for narrative / story-driven AI content (Story Studio's
   * primary use case). Older builds defaulted to '22' (People & Blogs);
   * existing projects can be migrated via the Settings → YouTube backfill
   * action.
   */
  categoryId?: string
  defaultLanguage?: string
  defaultAudioLanguage?: string
}

export type PrivacyStatus = 'private' | 'unlisted' | 'public'

export interface VideoStatus {
  privacyStatus: PrivacyStatus
  /** ISO 8601 when to flip to public. Only used when privacyStatus is 'private'. */
  publishAt?: string
  selfDeclaredMadeForKids?: boolean
  /**
   * YouTube's "altered or synthetic content" disclosure (introduced 2024-10).
   * When true, the video is flagged as containing realistic AI-generated,
   * altered, or synthetic content — surfaces a disclosure label under the
   * video on YouTube's UI. Required for compliance when uploading
   * AI-generated narration / images / video.
   *
   * Per YouTube Data API v3 docs, the field is `status.containsSyntheticMedia`.
   * Omit (undefined) to leave the existing flag untouched on `videos.update`;
   * pass `false` to explicitly clear it. Story Studio defaults to `true` for
   * new uploads when the project's `mark_as_ai_generated` flag is set
   * (which is the default for new projects).
   */
  containsSyntheticMedia?: boolean
}

export interface UploadVideoArgs {
  slug: string
  accountId: string
  filePath: string
  snippet: VideoSnippet
  status: VideoStatus
  onProgress?: (bytesSent: number, totalBytes: number) => void
  signal?: AbortSignal
  /**
   * If set, skip the resumable-session init step and resume against this
   * existing session URL. Used by the upload generator when it detects a
   * transient resume sidecar from a prior interrupted run. Caller is
   * responsible for verifying the sidecar's TTL / file_size / account
   * before passing the URL through.
   */
  resumeFromSessionUrl?: string
  /** Episode code for transient sidecar persistence. Required to enable resume. */
  episodeCode?: string
  /** Optional log sink for "Resuming from byte X / Y" surface lines. */
  logLines?: string[]
  /**
   * Keep the transient resumable-session record after YouTube returns the
   * video. The upload generator uses this until it has durably checkpointed
   * the permanent video id, closing the crash window between those writes.
   */
  deferResumeCleanup?: boolean
}

export interface UploadedVideo {
  id: string
  snippet: any
  status: any
}

// ── Token plumbing ────────────────────────────────────────────────────────
// Two refresh paths: proactive (getValidAccessToken — refreshes when our
// stored expires_at is within 60s) and reactive (forceRefreshAccessToken —
// invoked by fetchWithAuthRetry when Google returns 401 on a token we
// thought was valid). The reactive path catches clock skew between this
// machine and Google's clock, mid-session grant revocation, and any
// Google-initiated token invalidation that the local expires_at clock
// can't see. Both routes share refreshAndPersist; if Google rejects the
// refresh_token itself, we surface a distinct "reconnect required" error
// so callers can tell the user to re-run Connect.

async function refreshAndPersist(slug: string, accountId: string): Promise<string> {
  const tokens = await store.readTokens(slug, 'youtube', accountId)
  if (!tokens) throw new Error('No tokens for this account — reconnect YouTube.')
  const client = await store.readOAuthClient(slug, 'youtube')
  if (!client) throw new Error('OAuth client missing — re-enter client_id/client_secret in Settings.')
  try {
    const fresh = await refreshAccessToken({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tokens.refresh_token,
    })
    await store.writeTokens(slug, 'youtube', accountId, fresh)
    return fresh.access_token
  } catch (e: any) {
    throw new Error(`Token refresh failed (${e.message || 'unknown'}). Disconnect and reconnect the YouTube account.`)
  }
}

export async function getValidAccessToken(slug: string, accountId: string): Promise<string> {
  const tokens = await store.readTokens(slug, 'youtube', accountId)
  if (!tokens) throw new Error('No tokens for this account — reconnect YouTube.')
  const now = Date.now()
  // Refresh 60s before the real expiry so in-flight requests don't 401.
  if (tokens.expires_at - 60_000 > now) return tokens.access_token
  return refreshAndPersist(slug, accountId)
}

// Bypass the expires_at check and force a refresh against Google. Used by
// fetchWithAuthRetry when Google rejects a token our clock said was still
// good. Intentionally not exported — callers should go through the wrapper
// rather than re-implementing the retry semantics inline.
async function forceRefreshAccessToken(slug: string, accountId: string): Promise<string> {
  return refreshAndPersist(slug, accountId)
}

// Internal helper. Retries once on 401 by forcing a token refresh.
// Deliberately not exported; every Bearer-authenticated call should route
// through this. Single retry only — if the refresh itself fails, the
// "reconnect required" error from refreshAndPersist bubbles; if the second
// attempt also 401s, we surface that 401 to the caller rather than looping
// (a revoked grant would otherwise burn quota and confuse the user).
/** Exported so sibling modules (e.g. youtube-analytics.ts) can reuse the
 *  proactive-refresh + 401-retry pattern without duplicating the logic. */
export async function fetchWithAuthRetry(
  slug: string,
  accountId: string,
  buildRequest: (accessToken: string) => Promise<Response>,
): Promise<Response> {
  let accessToken = await getValidAccessToken(slug, accountId)
  let resp = await buildRequest(accessToken)
  if (resp.status !== 401) return resp
  // 401 on a token we thought was valid — force a refresh and retry once.
  accessToken = await forceRefreshAccessToken(slug, accountId)
  return buildRequest(accessToken)
}

// ── Resumable upload ──────────────────────────────────────────────────────
//
// Two-step per Google's docs:
//   1. POST the JSON metadata with `uploadType=resumable`; Google returns a
//      `Location` header — the resumable session URL.
//   2. PUT the video bytes to that URL. For Phase 2 we do a single-shot PUT
//      (not chunked); the resumable URL will still accept a restart via the
//      Range mechanism in Phase 3 if we add chunked retry.

export async function uploadVideo(args: UploadVideoArgs): Promise<UploadedVideo> {
  const stat = await fsp.stat(args.filePath)
  const totalBytes = stat.size
  if (totalBytes <= 0) throw new Error(`Upload target is empty: ${args.filePath}`)

  let sessionUrl = ''
  let initialCursor = 0

  // ── Resume path ────────────────────────────────────────────────────────
  // Caller persisted a transient sidecar from a prior interrupted run and
  // already verified TTL + file_size + account_id (see upload-resume-sidecar
  // and the upload generator). Probe Google for the server-side high-water
  // mark; if the session is gone (404/410), drop the sidecar and fall
  // through to a fresh init.
  if (args.resumeFromSessionUrl) {
    sessionUrl = args.resumeFromSessionUrl
    try {
      initialCursor = await getResumePoint(sessionUrl, totalBytes, args.signal)
      if (initialCursor === totalBytes) {
        // PUTs landed but we never observed the final 200. Re-issue the
        // probe so Google hands us the video resource it created.
        const finalProbe = await fetch(sessionUrl, {
          method: 'PUT',
          headers: { 'Content-Length': '0', 'Content-Range': `bytes */${totalBytes}` },
          signal: args.signal,
        })
        if (finalProbe.status === 200 || finalProbe.status === 201) {
          const result = await finalProbe.json() as any
          if (args.episodeCode && !args.deferResumeCleanup) {
            await deleteResumeSidecar(args.slug, args.episodeCode, 'youtube').catch(() => {})
          }
          args.onProgress?.(totalBytes, totalBytes)
          if (!result?.id) throw new Error('Resumed upload finished but no video id returned.')
          return { id: result.id, snippet: result.snippet, status: result.status }
        }
        // Probe didn't 200 — fall through and let the chunk loop handle it.
      }
      args.logLines?.push(
        `Resuming upload from byte ${initialCursor} / ${totalBytes} (previous session ${sessionUrlHash(sessionUrl)})`,
      )
      args.onProgress?.(initialCursor, totalBytes)
    } catch (e: any) {
      if (e?.code === 'RESUME_SESSION_GONE') {
        if (args.episodeCode) {
          await deleteResumeSidecar(args.slug, args.episodeCode, 'youtube').catch(() => {})
        }
        args.logLines?.push('Previous upload session expired or was forgotten by Google — starting fresh.')
        sessionUrl = ''
        initialCursor = 0
      } else {
        throw e
      }
    }
  }

  // ── Fresh init path ────────────────────────────────────────────────────
  if (!sessionUrl) {
    // Pre-check quota before we do any work. Throws QuotaExceededError
    // with a user-actionable message; prevents a pointless resumable
    // session that'd 403 partway through. Skipped on the resume path —
    // Google already billed videos.insert at the original session
    // creation, and the persisted sidecar's `quota_charged` flag is the
    // breadcrumb that says "don't double-charge."
    await checkQuota(args.slug, 'videos_insert')

    // Step 1: initiate
    // YouTube rejects videos.insert/update with `publishAt` set when
    // privacyStatus is anything other than 'private'. Silently correct
    // the combination so a caller that passes both doesn't get a
    // confusing 400.
    const effectivePrivacy = args.status.publishAt ? 'private' : args.status.privacyStatus
    const initBody = {
      snippet: {
        title: args.snippet.title,
        description: args.snippet.description || '',
        tags: Array.isArray(args.snippet.tags) ? args.snippet.tags : [],
        categoryId: args.snippet.categoryId || '24',
        ...(args.snippet.defaultLanguage ? { defaultLanguage: args.snippet.defaultLanguage } : {}),
        ...(args.snippet.defaultAudioLanguage ? { defaultAudioLanguage: args.snippet.defaultAudioLanguage } : {}),
      },
      status: {
        privacyStatus: effectivePrivacy,
        ...(args.status.publishAt ? { publishAt: args.status.publishAt } : {}),
        selfDeclaredMadeForKids: !!args.status.selfDeclaredMadeForKids,
        ...(args.status.containsSyntheticMedia !== undefined
          ? { containsSyntheticMedia: !!args.status.containsSyntheticMedia }
          : {}),
      },
    }
    const initResp = await fetchWithAuthRetry(args.slug, args.accountId, (accessToken) =>
      fetch(`${UPLOAD_INIT_URL}?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(totalBytes),
          'X-Upload-Content-Type': 'video/*',
        },
        body: JSON.stringify(initBody),
        signal: args.signal,
      }),
    )
    if (!initResp.ok) {
      const text = await initResp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(initResp.status, text)
      throw new Error(quotaMsg || `Upload init failed (${initResp.status}): ${text.slice(0, 400)}`)
    }
    // Record the quota cost as soon as init succeeds — Google bills a
    // videos.insert at session creation, not at PUT. If the PUT fails later
    // we still spent the 1600 units.
    await recordQuotaOrLog(args.slug, 'videos_insert')
    const location = initResp.headers.get('location') || initResp.headers.get('Location')
    if (!location) throw new Error('Upload init succeeded but no resumable session URL returned.')
    sessionUrl = location

    // Persist the transient sidecar BEFORE the first PUT so an app crash
    // mid-byte-shovel still leaves a recovery anchor. Best-effort — if
    // the persist fails we lose restart-safe resume but the upload
    // itself proceeds normally. Only callers that thread an
    // `episodeCode` through (the upload generator) get this; tests that
    // hit `uploadVideo` directly may skip it.
    if (args.episodeCode) {
      try {
        await writeResumeSidecar(args.slug, args.episodeCode, {
          platform: 'youtube',
          account_id: args.accountId,
          file_path: args.filePath,
          file_size: totalBytes,
          session_url: sessionUrl,
          created_at: new Date().toISOString(),
          quota_charged: true,
        })
      } catch (e: any) {
        logLine('warn', `[upload-resume] sidecar persist failed: ${e?.message || 'unknown'}`, {
          slug: args.slug,
          episode_code: args.episodeCode,
        })
      }
    }
  }

  // ── Chunked PUT (used by both fresh + resume paths) ────────────────────
  // Step 2: upload bytes in chunks with retry + resume. Google's protocol:
  //   - PUT a chunk with `Content-Range: bytes {start}-{end}/{total}`.
  //   - 308 Resume Incomplete = keep going; server's `Range` header tells
  //     us how many bytes it has.
  //   - 200 OK = final chunk accepted, response body has the video.
  //   - 4xx (permanent) = give up. 5xx or network error = retry with
  //     backoff; on persistent failure, query session status to discover
  //     how many bytes the server actually received and resume from there.
  //
  // Chunks are 10 MB by default (40 × 256 KB — Google requires multiples
  // of 256 KB except the final chunk). Small enough that a network blip
  // only costs one chunk's worth of bytes; large enough to keep per-PUT
  // overhead manageable on hour-long videos.
  try {
    const result = await uploadChunkedWithRetry({
      filePath: args.filePath,
      totalBytes,
      sessionUrl,
      startCursor: initialCursor,
      onProgress: args.onProgress,
      signal: args.signal,
    })
    if (!result?.id) throw new Error('Upload succeeded but no video id returned.')
    if (args.episodeCode && !args.deferResumeCleanup) {
      await deleteResumeSidecar(args.slug, args.episodeCode, 'youtube').catch(() => {})
    }
    return { id: result.id, snippet: result.snippet, status: result.status }
  } catch (e: any) {
    // Permanent 4xx (excluding 408/429 which the chunk loop treats as
    // retryable) means the session is unusable going forward — drop the
    // sidecar so the next attempt starts fresh. Cancellation (AbortError)
    // and retryable failures keep the sidecar; that's the whole point of
    // persisting it across restarts.
    const status = typeof e?.uploadStatus === 'number' ? e.uploadStatus : 0
    const isPermanent4xx = status >= 400 && status < 500 && status !== 408 && status !== 429
    if (isPermanent4xx && args.episodeCode) {
      await deleteResumeSidecar(args.slug, args.episodeCode, 'youtube').catch(() => {})
    }
    throw e
  }
}

/**
 * Probe a resumable-upload session for Google's server-side high-water
 * mark. Returns the next byte to send (or `totalBytes` if Google has the
 * complete file). Used in two places:
 *   1. Inside `uploadChunkedWithRetry` after retries are exhausted (was
 *      inline before — now centralised here).
 *   2. By `uploadVideo`'s resume path when starting from a persisted
 *      session URL after an app restart.
 *
 * On 404 / 410 the session is gone — Google forgot it, or it expired
 * before the 7-day cap. Throws an error tagged with
 * `code: 'RESUME_SESSION_GONE'` so callers can clear the transient
 * sidecar and fall through to a fresh init.
 */
export async function getResumePoint(
  sessionUrl: string,
  totalBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  const resp = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': '0',
      'Content-Range': `bytes */${totalBytes}`,
    },
    signal,
  })
  if (resp.status === 308) {
    const range = resp.headers.get('range') || resp.headers.get('Range') || ''
    const parsed = parseRangeEnd(range)
    return parsed != null ? parsed + 1 : 0
  }
  if (resp.status === 200 || resp.status === 201) {
    return totalBytes
  }
  if (resp.status === 404 || resp.status === 410) {
    const err: any = new Error(`Resumable session expired or unknown to Google (${resp.status})`)
    err.code = 'RESUME_SESSION_GONE'
    err.uploadStatus = resp.status
    throw err
  }
  const text = await resp.text().catch(() => '')
  const err: any = new Error(`Resume probe failed (${resp.status}): ${text.slice(0, 200)}`)
  err.uploadStatus = resp.status
  throw err
}

const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024          // 10 MB
const CHUNK_GRANULARITY = 256 * 1024                 // 256 KB — Google's requirement for non-final chunks
const MAX_RETRIES_PER_CHUNK = 5

/**
 * Streams a file to a resumable-upload session URL in chunks. On network
 * error or 5xx, retries the current chunk with exponential backoff; on
 * persistent failure, queries the session to find out how many bytes the
 * server actually received, then resumes from that offset. Emits per-chunk
 * progress so the UI stays responsive on hour-long uploads.
 *
 * Exported mostly for test visibility; callers inside this module use it
 * via uploadVideo.
 */
async function uploadChunkedWithRetry(args: {
  filePath: string
  totalBytes: number
  sessionUrl: string
  /**
   * Byte offset to start uploading from. Defaults to 0; non-zero comes
   * from the resume path where Google's high-water mark has already been
   * probed. The first chunk PUT will be `bytes {startCursor}-...`.
   */
  startCursor?: number
  chunkSize?: number
  onProgress?: (bytesSent: number, totalBytes: number) => void
  signal?: AbortSignal
}): Promise<any> {
  const chunkSize = args.chunkSize ?? DEFAULT_CHUNK_SIZE
  const totalBytes = args.totalBytes
  let cursor = args.startCursor ?? 0

  while (cursor < totalBytes) {
    if (args.signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError')

    const end = Math.min(cursor + chunkSize, totalBytes) - 1
    const chunkLen = end - cursor + 1
    const isFinal = end === totalBytes - 1

    // Retry loop for this chunk.
    let attempt = 0
    let lastErr: any
    while (attempt < MAX_RETRIES_PER_CHUNK) {
      try {
        const chunkStream = fs.createReadStream(args.filePath, { start: cursor, end })
        const webStream = nodeStreamToWeb(chunkStream)
        const resp = await fetch(args.sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunkLen),
            'Content-Type': 'video/*',
            'Content-Range': `bytes ${cursor}-${end}/${totalBytes}`,
          },
          body: webStream as any,
          // @ts-expect-error Node duplex stream requirement for body ReadableStream
          duplex: 'half',
          signal: args.signal,
        })

        if (resp.status === 200 || resp.status === 201) {
          // Final chunk was accepted, response holds the video metadata.
          args.onProgress?.(totalBytes, totalBytes)
          return await resp.json() as any
        }
        if (resp.status === 308) {
          // Keep going. Range header tells us what the server has;
          // trust it rather than assuming our byte count matches.
          const range = resp.headers.get('range') || resp.headers.get('Range') || ''
          const parsed = parseRangeEnd(range)
          cursor = parsed != null ? parsed + 1 : cursor + chunkLen
          args.onProgress?.(cursor, totalBytes)
          break  // next chunk
        }
        if (resp.status >= 500 || resp.status === 408 || resp.status === 429) {
          // Retryable.
          const text = await resp.text().catch(() => '')
          lastErr = new Error(`Chunk PUT failed (${resp.status}): ${text.slice(0, 200)}`)
          attempt++
          await sleep(backoffMs(attempt))
          continue
        }
        // 4xx — permanent.
        const text = await resp.text().catch(() => '')
        if (isFinal && resp.status === 200) {
          // defensive: shouldn't hit, covered above.
          return await resp.json() as any
        }
        const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
        const err: any = new Error(quotaMsg || `Chunk PUT failed (${resp.status}): ${text.slice(0, 400)}`)
        err.uploadStatus = resp.status
        throw err
      } catch (e: any) {
        // Network error / abort / retryable exception — check abort first.
        if (args.signal?.aborted || e?.name === 'AbortError') {
          throw new DOMException('Upload cancelled', 'AbortError')
        }
        lastErr = e
        attempt++
        if (attempt >= MAX_RETRIES_PER_CHUNK) break
        await sleep(backoffMs(attempt))
      }
    }

    // If we exhausted retries, query Google to find out where we really
    // are and resume. This handles the case where our chunk PUT landed
    // partially (server got some bytes, then connection dropped before
    // returning 308). `getResumePoint` is the same helper the cross-
    // restart resume path uses.
    if (attempt >= MAX_RETRIES_PER_CHUNK) {
      try {
        const probed = await getResumePoint(args.sessionUrl, totalBytes, args.signal)
        if (probed === totalBytes) {
          // Upload actually finished during the flurry of retries — ask
          // Google for the video resource it created.
          const finalProbe = await fetch(args.sessionUrl, {
            method: 'PUT',
            headers: { 'Content-Length': '0', 'Content-Range': `bytes */${totalBytes}` },
            signal: args.signal,
          })
          if (finalProbe.status === 200 || finalProbe.status === 201) {
            args.onProgress?.(totalBytes, totalBytes)
            return await finalProbe.json() as any
          }
        } else if (probed > cursor) {
          cursor = probed
          args.onProgress?.(cursor, totalBytes)
          continue
        }
      } catch { /* fall through to throw */ }
      throw lastErr || new Error(`Gave up after ${MAX_RETRIES_PER_CHUNK} retries on chunk starting at byte ${cursor}`)
    }
  }

  // Loop exited without final 200 — shouldn't happen; Google always
  // returns 200 on final chunk. Throw defensively.
  throw new Error('Resumable upload ended without receiving a success response from YouTube.')
}

function nodeStreamToWeb(node: fs.ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      node.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      })
      node.on('end', () => controller.close())
      node.on('error', (err) => controller.error(err))
    },
    cancel() { node.destroy() },
  })
}

/**
 * Extract the last-received byte index from a Google resumable-upload
 * `Range` header. Format: `bytes=0-524287` (inclusive). Returns null on
 * missing/unparseable.
 */
function parseRangeEnd(rangeHeader: string): number | null {
  if (!rangeHeader) return null
  const m = /bytes=\d+-(\d+)/.exec(rangeHeader)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

function backoffMs(attempt: number): number {
  // Exponential with jitter: 500ms, 1s, 2s, 4s, 8s (capped).
  const base = Math.min(8000, 500 * Math.pow(2, attempt - 1))
  return base + Math.floor(Math.random() * 250)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// Verify chunk granularity — called once at module load for docs / tests.
// Google rejects non-final chunks that aren't multiples of 256 KB.
// (Self-doc constant, not a runtime check.)
void CHUNK_GRANULARITY

// ── Metadata-only update ──────────────────────────────────────────────────
// Used when the user hits "Upload" on an episode we've already uploaded —
// we PATCH the existing video instead of creating a new one.

export async function updateVideoMetadata(opts: {
  slug: string
  accountId: string
  videoId: string
  snippet: VideoSnippet
  /**
   * Optional. When omitted, the PATCH only includes `snippet` (title /
   * description / tags / categoryId) — YouTube's privacyStatus and
   * publishAt stay untouched. This is the safe default for the per-row
   * "↻ Update metadata" button: re-pushing privacyStatus would otherwise
   * silently flip a public video back to private, or wipe an existing
   * publishAt schedule, which is rarely what the user wants when they
   * just fixed a typo in the title.
   */
  status?: VideoStatus
}): Promise<UploadedVideo> {
  const body: Record<string, unknown> = {
    id: opts.videoId,
    snippet: {
      title: opts.snippet.title,
      description: opts.snippet.description || '',
      tags: Array.isArray(opts.snippet.tags) ? opts.snippet.tags : [],
      categoryId: opts.snippet.categoryId || '24',
    },
  }
  // Same publishAt/privacy invariant as uploadVideo — enforce here too
  // so metadata-only updates don't 400 on the "scheduled public" footgun.
  // Only build the status block when the caller passed one; omitting it
  // tells YouTube to leave the existing video's status alone.
  if (opts.status) {
    const effectivePrivacy = opts.status.publishAt ? 'private' : opts.status.privacyStatus
    body.status = {
      privacyStatus: effectivePrivacy,
      ...(opts.status.publishAt ? { publishAt: opts.status.publishAt } : {}),
      ...(opts.status.selfDeclaredMadeForKids !== undefined
        ? { selfDeclaredMadeForKids: opts.status.selfDeclaredMadeForKids }
        : {}),
      ...(opts.status.containsSyntheticMedia !== undefined
        ? { containsSyntheticMedia: opts.status.containsSyntheticMedia }
        : {}),
    }
  }
  // The `part` query param must list exactly the fields we're sending.
  // Including `status` when we didn't send a status block makes YouTube
  // wipe the existing status to defaults — defeating the whole point of
  // the preserve-status path.
  const partParam = opts.status ? 'snippet,status' : 'snippet'
  await checkQuota(opts.slug, 'videos_update')
  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
    fetch(`${VIDEOS_UPDATE_URL}?part=${partParam}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `Metadata update failed (${resp.status}): ${text.slice(0, 400)}`)
  }
  await recordQuotaOrLog(opts.slug, 'videos_update')
  const result = await resp.json() as any
  return { id: result.id, snippet: result.snippet, status: result.status }
}

// ── Thumbnail upload ──────────────────────────────────────────────────────
/**
 * v1.0.524 — classify a thumbnails.set failure as worth retrying or not.
 * The video is often still PROCESSING right after upload (transient 400/409),
 * which used to be swallowed as a permanent "skip". 429/5xx are also transient.
 * 403 (channel not verified), 413 (too large — we already downscale, but be
 * safe), and a generic 400 (bad image) are permanent — retrying just wastes
 * quota/time.
 */
export function classifyThumbnailError(status: number, body: string): 'retry' | 'permanent' {
  if (status === 409 || status === 429 || status >= 500) return 'retry'
  if (status === 400 && /processing|not (yet )?ready|try again|transient/i.test(body)) return 'retry'
  return 'permanent'
}

const THUMBNAIL_RETRY_BACKOFF_MS = [3000, 8000, 15000]

export async function setThumbnail(opts: {
  slug: string
  accountId: string
  videoId: string
  filePath: string
}): Promise<void> {
  await checkQuota(opts.slug, 'thumbnails_set')
  // v1.0.524 — guarantee ≤2 MB / ≤1280 px so YouTube doesn't 413 the file.
  // Small images pass through untouched (a crisp PNG stays a PNG).
  const prepared = await prepareThumbnail(opts.filePath)

  // Retry loop for the transient "still processing" race (auth-retry stays
  // inside fetchWithAuthRetry). backoff.length + 1 total attempts.
  for (let attempt = 0; ; attempt++) {
    const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
      fetch(`${THUMBNAILS_SET_URL}?videoId=${encodeURIComponent(opts.videoId)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': prepared.contentType,
        },
        body: prepared.buffer,
      }),
    )
    if (resp.ok) {
      await recordQuotaOrLog(opts.slug, 'thumbnails_set')
      return
    }
    const text = await resp.text().catch(() => '')
    const kind = classifyThumbnailError(resp.status, text)
    if (kind === 'retry' && attempt < THUMBNAIL_RETRY_BACKOFF_MS.length) {
      logLine('warn', `[thumbnail] set ${resp.status} (transient) — retry ${attempt + 1}/${THUMBNAIL_RETRY_BACKOFF_MS.length} for video ${opts.videoId}`, { slug: opts.slug })
      await new Promise(r => setTimeout(r, THUMBNAIL_RETRY_BACKOFF_MS[attempt]!))
      continue
    }
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    // Thumbnail set can fail if the account isn't verified (custom thumbs
    // require a verified channel). Don't hard-fail the whole upload — the
    // caller treats this as a warning.
    throw new Error(quotaMsg || `Thumbnail upload failed (${resp.status}): ${text.slice(0, 300)}. Custom thumbnails require channel verification on YouTube.`)
  }
}

// ── Playlists (A4 + A5) ───────────────────────────────────────────────────

export interface Playlist {
  id: string
  title: string
  description: string
  privacyStatus: 'public' | 'unlisted' | 'private'
  itemCount: number
}

export async function listPlaylists(slug: string, accountId: string): Promise<Playlist[]> {
  await checkQuota(slug, 'playlists_list')
  const out: Playlist[] = []
  let pageToken = ''
  // Cap at 5 pages × 50 = 250 playlists. Channels with more are rare; extend if needed.
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      part: 'snippet,status,contentDetails',
      mine: 'true',
      maxResults: '50',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      fetch(`${PLAYLISTS_URL}?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
      throw new Error(quotaMsg || `playlists.list failed (${resp.status}): ${text.slice(0, 300)}`)
    }
    const data = await resp.json() as any
    for (const pl of (data.items || [])) {
      out.push({
        id: pl.id,
        title: pl.snippet?.title || '(untitled)',
        description: pl.snippet?.description || '',
        privacyStatus: pl.status?.privacyStatus || 'private',
        itemCount: pl.contentDetails?.itemCount || 0,
      })
    }
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  await recordQuotaOrLog(slug, 'playlists_list')
  return out
}

export async function createPlaylist(opts: {
  slug: string
  accountId: string
  title: string
  description?: string
  privacyStatus?: 'public' | 'unlisted' | 'private'
}): Promise<Playlist> {
  await checkQuota(opts.slug, 'playlists_insert')
  const body = {
    snippet: {
      title: opts.title.slice(0, 150),          // YouTube playlist title cap
      description: (opts.description || '').slice(0, 5000),
    },
    status: { privacyStatus: opts.privacyStatus || 'private' },
  }
  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
    fetch(`${PLAYLISTS_URL}?part=snippet,status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `playlists.insert failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  await recordQuotaOrLog(opts.slug, 'playlists_insert')
  const pl = await resp.json() as any
  return {
    id: pl.id,
    title: pl.snippet?.title || opts.title,
    description: pl.snippet?.description || '',
    privacyStatus: pl.status?.privacyStatus || (opts.privacyStatus || 'private'),
    itemCount: 0,
  }
}

export async function addVideoToPlaylist(opts: {
  slug: string
  accountId: string
  playlistId: string
  videoId: string
}): Promise<void> {
  await checkQuota(opts.slug, 'playlist_items_insert')
  const body = {
    snippet: {
      playlistId: opts.playlistId,
      resourceId: { kind: 'youtube#video', videoId: opts.videoId },
    },
  }
  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
    fetch(`${PLAYLIST_ITEMS_URL}?part=snippet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `playlistItems.insert failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  await recordQuotaOrLog(opts.slug, 'playlist_items_insert')
}

/** A one-unit preflight/verification read used to prevent duplicate
 * 50-unit playlist inserts and to prove the remote mutation completed. */
export async function isVideoInPlaylist(opts: {
  slug: string
  accountId: string
  playlistId: string
  videoId: string
}): Promise<boolean> {
  const params = new URLSearchParams({
    part: 'id',
    playlistId: opts.playlistId,
    videoId: opts.videoId,
    maxResults: '1',
  })
  await checkQuota(opts.slug, 'playlist_items_list')
  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, accessToken =>
    fetch(`${PLAYLIST_ITEMS_URL}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `playlistItems.list failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  await recordQuotaOrLog(opts.slug, 'playlist_items_list')
  const data = await resp.json() as { items?: unknown[] }
  return Array.isArray(data.items) && data.items.length > 0
}

// ── Reconcile helpers (used in Phase 6) ───────────────────────────────────

/**
 * Bulk-fetch the live `status` block (privacyStatus + publishAt) for a list
 * of videoIds. Used by the queue's "Sync from YouTube" flow to detect drift
 * between the local sidecar and YouTube's actual state — e.g. a scheduled
 * video that auto-published, or a video the user manually flipped to public
 * in YT Studio.
 *
 * Batches into groups of 50 (YouTube's cap on the `id` parameter). Each
 * batch costs 1 quota unit (`videos_list`), so syncing 200 rows is 4 units.
 *
 * Returns a map keyed by videoId. Videos that don't come back in the
 * response (deleted on YouTube, no longer accessible) are simply absent
 * from the map — callers should treat that as "couldn't sync, skip".
 */
export interface VideoStatusFromYouTube {
  privacyStatus: 'private' | 'unlisted' | 'public'
  /** ISO 8601 — only present when YouTube has the video scheduled. */
  publishAt: string | null
}
export async function listVideoStatuses(slug: string, accountId: string, videoIds: string[]): Promise<Record<string, VideoStatusFromYouTube>> {
  const out: Record<string, VideoStatusFromYouTube> = {}
  // Strip empty / dup ids — YouTube's API treats `id=,X,` as a syntax error
  // on some edge cases, and dups burn payload size.
  const unique = Array.from(new Set(videoIds.filter(Boolean)))
  if (!unique.length) return out
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50)
    await checkQuota(slug, 'videos_list')
    const url = `${VIDEOS_UPDATE_URL}?part=status&id=${batch.map(encodeURIComponent).join(',')}`
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
      throw new Error(quotaMsg || `videos.list failed (${resp.status}): ${text.slice(0, 300)}`)
    }
    await recordQuotaOrLog(slug, 'videos_list')
    const data = await resp.json() as any
    for (const item of (data.items || [])) {
      const vid = item.id as string | undefined
      if (!vid) continue
      const st = item.status || {}
      const privacyStatus: 'private' | 'unlisted' | 'public' = (st.privacyStatus === 'public' || st.privacyStatus === 'unlisted')
        ? st.privacyStatus
        : 'private'
      // `status.publishAt` is YouTube's scheduled-publish time. It's only
      // meaningful when the video is `private` AND scheduled to flip to
      // public at a specific time. We coerce to null for public/unlisted
      // even if YouTube echoes back a historical value — a public video
      // already published, an unlisted video is live but hidden, neither
      // is awaiting a future flip. Belt-and-suspenders for the queue
      // sync-drift detection: if YouTube's response retains an old
      // publishAt on already-public videos, naïvely passing it through
      // would make the drift check think nothing changed.
      const publishAt = (privacyStatus === 'private' && typeof st.publishAt === 'string' && st.publishAt)
        ? st.publishAt
        : null
      out[vid] = { privacyStatus, publishAt }
    }
  }
  return out
}

/**
 * Bulk-fetch the snippet + status fields needed for the YouTube metadata
 * backfill flow (Settings → YouTube → "Apply current settings to all
 * uploaded videos"). Returns categoryId, current synthetic-media flag,
 * and current privacy/publishAt — enough to PATCH without clobbering
 * existing state.
 *
 * Cost: 1 quota unit (`videos_list`) per batch of 50 video IDs.
 *
 * Videos that don't come back (deleted on YouTube, no longer accessible)
 * are absent from the returned map; callers should treat that as "skip".
 */
export interface VideoBackfillView {
  privacyStatus: 'private' | 'unlisted' | 'public'
  publishAt: string | null
  categoryId: string
  /** undefined when YouTube hasn't echoed the field (legacy uploads predate the disclosure). */
  containsSyntheticMedia?: boolean
}
export async function listVideoSnippetStatus(
  slug: string, accountId: string, videoIds: string[],
): Promise<Record<string, VideoBackfillView>> {
  const out: Record<string, VideoBackfillView> = {}
  const unique = Array.from(new Set(videoIds.filter(Boolean)))
  if (!unique.length) return out
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50)
    await checkQuota(slug, 'videos_list')
    const url = `${VIDEOS_UPDATE_URL}?part=snippet,status&id=${batch.map(encodeURIComponent).join(',')}`
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
      throw new Error(quotaMsg || `videos.list failed (${resp.status}): ${text.slice(0, 300)}`)
    }
    await recordQuotaOrLog(slug, 'videos_list')
    const data = await resp.json() as any
    for (const item of (data.items || [])) {
      const vid = item.id as string | undefined
      if (!vid) continue
      const sn = item.snippet || {}
      const st = item.status || {}
      const privacyStatus: 'private' | 'unlisted' | 'public' = (st.privacyStatus === 'public' || st.privacyStatus === 'unlisted')
        ? st.privacyStatus
        : 'private'
      const publishAt = (privacyStatus === 'private' && typeof st.publishAt === 'string' && st.publishAt)
        ? st.publishAt
        : null
      out[vid] = {
        privacyStatus,
        publishAt,
        categoryId: typeof sn.categoryId === 'string' ? sn.categoryId : '24',
        containsSyntheticMedia: typeof st.containsSyntheticMedia === 'boolean'
          ? st.containsSyntheticMedia
          : undefined,
      }
    }
  }
  return out
}

export async function getUploadsPlaylistId(slug: string, accountId: string): Promise<string> {
  const url = `${CHANNELS_URL}?${new URLSearchParams({ part: 'contentDetails', mine: 'true' })}`
  const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
    fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
  )
  if (!resp.ok) throw new Error(`channels.list failed (${resp.status})`)
  await recordQuotaOrLog(slug, 'channels_list')
  const data = await resp.json() as any
  const id = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!id) throw new Error('No uploads playlist found on authenticated channel.')
  return id
}

export async function listRecentUploads(slug: string, accountId: string, opts: { maxPages?: number } = {}): Promise<Array<{ videoId: string; title: string; publishedAt: string; privacyStatus?: string }>> {
  const playlistId = await getUploadsPlaylistId(slug, accountId)
  const maxPages = opts.maxPages ?? 4  // 4 × 50 = 200 videos before pagination stops
  let pageToken = ''
  const items: Array<{ videoId: string; title: string; publishedAt: string; privacyStatus?: string }> = []
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      part: 'snippet,status',
      playlistId,
      maxResults: '50',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const url = `${PLAYLIST_ITEMS_URL}?${params}`
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
    )
    if (!resp.ok) throw new Error(`playlistItems.list failed (${resp.status})`)
    await recordQuotaOrLog(slug, 'playlist_items_list')
    const data = await resp.json() as any
    for (const it of data.items || []) {
      items.push({
        videoId: it.snippet?.resourceId?.videoId || '',
        title: it.snippet?.title || '',
        publishedAt: it.snippet?.publishedAt || '',
        privacyStatus: it.status?.privacyStatus,
      })
    }
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return items
}
