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
import type { FileHandle } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { OAuthTokenBundle } from './youtube-oauth.js'
import { OAUTH_GRANT_REVOKED_CODES, refreshAccessToken } from './youtube-oauth.js'
import { friendlyQuotaErrorMessage, QUOTA_COST, type QuotaKey } from '../services/upload-quota.js'
import { logLine } from '../services/logger.js'
import { prepareThumbnail } from './thumbnail-prepare.js'
import {
  writeResumeSidecar,
  deleteResumeSidecar,
  sessionUrlHash,
} from '../services/upload-resume-sidecar.js'
import { assertPublishableMetadata } from './metadata-scaffold.js'

/**
 * The one door every YouTube request goes through.
 *
 * This module had fifteen bare `fetch(` calls, so the only way to test it was
 * to patch the global — which silently affects every other module in the same
 * process. Routing them through one binding lets a test hand this file a fake
 * transport and nothing else. Production keeps the platform `fetch`.
 *
 * Test-only: `__setYouTubeTransportForTests` is never called by product code.
 */
let youtubeFetch: typeof fetch = (...args) => globalThis.fetch(...args)

/**
 * The same seam, for sibling modules that make YouTube requests of their own.
 *
 * `youtube-comments.ts` called the global `fetch` directly while this file
 * routed everything through the binding — a guard present in one file and
 * absent in its neighbour, which left every comment request untestable and
 * able to reach the real API from a test.
 */
export const youtubeTransport: typeof fetch = (...args) => youtubeFetch(...args)

export function __setYouTubeTransportForTests(transport: typeof fetch): void {
  youtubeFetch = transport
}

export function __resetYouTubeTransportForTests(): void {
  youtubeFetch = (...args) => globalThis.fetch(...args)
}

export interface YouTubeQuotaPermit {
  application_id: string
  channel_id: string
  key: QuotaKey
}

export interface YouTubeCredentialContext {
  access_token: string
  application_id: string
  channel_id: string
}

export async function recordQuotaOrLog(permit: YouTubeQuotaPermit | null): Promise<void> {
  await recordCloudProjectQuota(permit)
}

/**
 * Also charge the Cloud-project ledger, which is the one the redesigned Upload
 * Center reads.
 *
 * Quota belongs to the Google Cloud project, and every OAuth client sharing it
 * shares the counter. This is the only local quota authority.
 *
 * Charged from the single funnel every call site already goes through, rather
 * than from twelve separate sites, so a new endpoint cannot forget to pay.
 *
 * Best-effort in exactly the same way the operation recorder is: a project with
 * no owner application or no assigned channel has nothing to charge, and must
 * keep working. Never throws — the API call already succeeded by the time this
 * runs, and a bookkeeping failure must not fail it.
 */
/**
 * How much one call costs in the Cloud-project ledger.
 *
 * The buckets do NOT share a unit (spec section 6): `video_uploads` and
 * `search` count CALLS with a default ceiling of 100 per day, while
 * `other_endpoints` counts UNITS with a ceiling of 10,000. Charging
 * videos.insert's 1,600 units into the 100-CALL upload bucket instantly
 * exhausted it on the first upload.
 */
function cloudProjectQuotaCharge(key: QuotaKey): { bucket: 'video_uploads' | 'other_endpoints'; amount: number } {
  return key === 'videos_insert'
    ? { bucket: 'video_uploads', amount: 1 }
    : { bucket: 'other_endpoints', amount: QUOTA_COST[key] }
}

/**
 * Refuse a request that would exceed the Cloud-project ceiling for its bucket.
 *
 * Unlike the charge, this one THROWS: refusing before the request is the whole
 * point. The caller supplies the exact application and channel captured with
 * the token, so a later reassignment cannot move this request to another
 * ledger.
 */
export async function checkCloudProjectQuota(context: YouTubeCredentialContext, key: QuotaKey): Promise<YouTubeQuotaPermit> {
  const { checkYouTubeQuota } = await import('../services/youtube-quota-ledger.js')
  // NOT `.catch(() => null)`. This is the funnel every provider request passes
  // through, and swallowing the read made a corrupt registry mean "no ceiling,
  // carry on" - the same tell-1 collapse the upload route had, on the path that
  // guards ALL of them. An unreadable registry now refuses here, loudly.
  const charge = cloudProjectQuotaCharge(key)
  await checkYouTubeQuota(context.application_id, charge.bucket, charge.amount)
  return {
    application_id: context.application_id,
    channel_id: context.channel_id,
    key,
  }
}

async function recordCloudProjectQuota(permit: YouTubeQuotaPermit | null): Promise<void> {
  if (!permit) return
  try {
    const { recordYouTubeQuotaAttempt } = await import('../services/youtube-quota-ledger.js')
    const charge = cloudProjectQuotaCharge(permit.key)
    await recordYouTubeQuotaAttempt({
      application_id: permit.application_id,
      channel_id: permit.channel_id,
      bucket: charge.bucket,
      operation: permit.key,
      amount: charge.amount,
    })
  } catch (e: any) {
    logLine('warn', `[youtube-quota] cloud-project ledger write failed: ${e?.message || 'unknown'}`, {
      application_id: permit.application_id,
      channel_id: permit.channel_id,
      key: permit.key,
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
  publishAt?: string | null
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
  embeddable?: boolean
  license?: string
  publicStatsViewable?: boolean
}

export interface UploadVideoArgs {
  slug: string
  accountId: string
  filePath: string
  /** Optional already-open render descriptor, pinned by the upload generator after hashing it. */
  sourceHandle?: FileHandle
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
  /** Persist the session hash in the durable operation before sending bytes. */
  onResumableSessionReady?: (sessionUrlHash: string, sourceBytes: number) => Promise<void>
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

export const REGISTRY_CREDENTIAL_PREFIX = 'registry:'

export function registryCredentialFor(channelId: string): string {
  return `${REGISTRY_CREDENTIAL_PREFIX}${channelId}`
}

export function registryChannelOf(accountId: string): string | null {
  if (!accountId.startsWith(REGISTRY_CREDENTIAL_PREFIX)) return null
  return accountId.slice(REGISTRY_CREDENTIAL_PREFIX.length) || null
}

function reconnectRequired(message: string): Error {
  return Object.assign(new Error(message), { code: 'YOUTUBE_RECONNECT_REQUIRED' })
}

/** Waits between token-refresh attempts after a transient failure (3 attempts in all). */
let TOKEN_REFRESH_RETRY_DELAYS_MS: number[] = [2_000, 8_000]
export function __setTokenRefreshRetryDelaysForTests(delays: number[]): void { TOKEN_REFRESH_RETRY_DELAYS_MS = delays }

async function refreshAndPersist(
  slug: string,
  accountId: string,
  expectedApplicationId?: string,
): Promise<YouTubeCredentialContext> {
  const channelId = registryChannelOf(accountId)
  if (!channelId) {
    throw reconnectRequired('This project has no current YouTube connection. Reconnect it in Settings → YouTube.')
  }
  const connections = await import('../services/youtube-connection-store.js')
  const credential = await connections.readYouTubeRequestCredentialForServer(slug, channelId)
  if (!credential || (expectedApplicationId && credential.application_id !== expectedApplicationId)) {
    throw reconnectRequired('This YouTube connection changed. Reconnect the channel in Settings → YouTube and retry.')
  }
  let fresh!: OAuthTokenBundle
  for (let attempt = 1; ; attempt++) {
    try {
      fresh = await refreshAccessToken({
        client_id: credential.client_id,
        client_secret: credential.client_secret,
        refresh_token: credential.tokens.refresh_token,
        // Google omits `scope` from most refresh responses, and without this the
        // stored grant loses it on the first refresh. Everything that ASKS what
        // a token may do then gets the wrong answer — including the analytics
        // scope check, which would report "grant analytics access" forever on a
        // connection that has it.
        ...(credential.tokens.scope ? { previous_scope: credential.tokens.scope } : {}),
      })
      break
    } catch (e: any) {
      // Only a refused GRANT needs the owner: anything else is Google or the
      // network having a moment, and nothing has been sent to YouTube yet, so
      // a short retry is safe.
      if (OAUTH_GRANT_REVOKED_CODES.has(e?.provider_error)) {
        await connections.markYouTubeChannelSignInExpired(channelId).catch((error: unknown) => {
          logLine('warn', `[youtube-auth] could not mark the channel for Reconnect: ${(error as Error)?.message || 'unknown'}`, { channel_id: channelId })
        })
        throw reconnectRequired('YouTube sign-in expired or was revoked by Google. Press Reconnect for this channel in Settings → YouTube; its settings, playlists and project links are kept.')
      }
      const transient = e?.code === 'YOUTUBE_OAUTH_UNAVAILABLE'
      if (transient && attempt < TOKEN_REFRESH_RETRY_DELAYS_MS.length + 1) {
        await delay(TOKEN_REFRESH_RETRY_DELAYS_MS[attempt - 1]!)
        continue
      }
      throw Object.assign(new Error(transient
        ? `Could not reach Google to renew the YouTube sign-in (tried ${attempt} times). Nothing was sent to YouTube; try again in a few minutes.`
        : `Google refused to renew the YouTube sign-in${e?.provider_error ? ` (${e.provider_error})` : ''}. Check the OAuth application in Settings → YouTube, then try again.`), {
        code: 'YOUTUBE_TOKEN_REFRESH_FAILED',
        transient,
      })
    }
  }
  try {
    const saved = await connections.saveYouTubeChannelTokens({
      channel_id: channelId,
      expected_access_token: credential.tokens.access_token,
      tokens: fresh,
    })
    if (saved) return {
      access_token: fresh.access_token,
      application_id: credential.application_id,
      channel_id: channelId,
    }
    const winner = await connections.readYouTubeRequestCredentialForServer(slug, channelId)
    if (winner?.application_id === credential.application_id) return {
      access_token: winner.tokens.access_token,
      application_id: winner.application_id,
      channel_id: channelId,
    }
    throw new Error('The YouTube connection changed while its token was refreshing.')
  } catch (e: any) {
    throw reconnectRequired(`Saving the renewed YouTube sign-in failed (${e?.message || 'unknown'}). Reconnect the channel in Settings → YouTube.`)
  }
}

export async function getValidCredentialContext(slug: string, accountId: string): Promise<YouTubeCredentialContext> {
  const channelId = registryChannelOf(accountId)
  if (!channelId) {
    throw reconnectRequired('This project has no current YouTube connection. Reconnect it in Settings → YouTube.')
  }
  const { getProjectYouTubeAssignment, readYouTubeRequestCredentialForServer } = await import('../services/youtube-connection-store.js')
  if ((await getProjectYouTubeAssignment(slug))?.channel_id !== channelId) {
    throw reconnectRequired('This project is not assigned to that YouTube channel. Select its channel in Settings → YouTube.')
  }
  const credential = await readYouTubeRequestCredentialForServer(slug, channelId)
  if (!credential) throw reconnectRequired('This YouTube channel needs to be reconnected in Settings → YouTube.')
  const now = Date.now()
  // Refresh 60s before the real expiry so in-flight requests don't 401.
  if (credential.tokens.expires_at - 60_000 > now) return {
    access_token: credential.tokens.access_token,
    application_id: credential.application_id,
    channel_id: channelId,
  }
  return refreshAndPersist(slug, accountId, credential.application_id)
}

export async function getValidAccessToken(slug: string, accountId: string): Promise<string> {
  return (await getValidCredentialContext(slug, accountId)).access_token
}

// Bypass the expires_at check and force a refresh against Google. Used by
// fetchWithAuthRetry when Google rejects a token our clock said was still
// good. Intentionally not exported — callers should go through the wrapper
// rather than re-implementing the retry semantics inline.
async function forceRefreshCredentialContext(
  slug: string,
  accountId: string,
  expectedApplicationId: string,
): Promise<YouTubeCredentialContext> {
  return refreshAndPersist(slug, accountId, expectedApplicationId)
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
  buildRequest: (accessToken: string, context: Readonly<YouTubeCredentialContext>) => Promise<Response>,
  quotaKey?: QuotaKey,
): Promise<Response> {
  const attempt = async (context: YouTubeCredentialContext): Promise<Response> => {
    if (!quotaKey) return buildRequest(context.access_token, context)
    const permit = await checkCloudProjectQuota(context, quotaKey)
    try {
      return await buildRequest(context.access_token, context)
    } finally {
      // The provider received an attempt even when it rejected the request or
      // the transport lost the response. Record every real attempt, including
      // the 401 that causes the one permitted auth retry.
      await recordQuotaOrLog(permit)
    }
  }
  let context = await getValidCredentialContext(slug, accountId)
  let resp = await attempt(context)
  if (resp.status !== 401) return resp
  // 401 on a token we thought was valid — force a refresh and retry once.
  context = await forceRefreshCredentialContext(slug, accountId, context.application_id)
  return attempt(context)
}

// ── Resumable upload ──────────────────────────────────────────────────────
const UPLOAD_START_ATTEMPTS = 3
const RETRYABLE_UPLOAD_START_STATUS = new Set([408, 429, 500, 502, 503, 504])
const TRANSIENT_CONNECTION_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
])
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

function uploadStartNetworkFailure(error: unknown): { detail: string; retry: boolean } | null {
  // Only inspect errors from the transport itself. Never log raw messages:
  // Undici errors can carry URLs, addresses and credentials in their cause.
  const pending: unknown[] = [error]
  const codes: string[] = []
  for (let i = 0; i < pending.length && i < 12; i++) {
    const item = pending[i]
    if (!item || typeof item !== 'object') continue
    const value = item as { code?: unknown; cause?: unknown; errors?: unknown[] }
    if (typeof value.code === 'string') codes.push(value.code)
    if (value.cause) pending.push(value.cause)
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 4))
  }
  const certificate = codes.find(code => CERTIFICATE_CODES.has(code))
  if (certificate) return { detail: `secure connection rejected (${certificate})`, retry: false }
  if (codes.length) {
    const safeCodes = [...new Set(codes.filter(code => TRANSIENT_CONNECTION_CODES.has(code)))]
    return { detail: safeCodes.length ? safeCodes.join(', ') : 'connection error',
      retry: codes.every(code => TRANSIENT_CONNECTION_CODES.has(code)) }
  }
  return error instanceof TypeError && error.message === 'fetch failed'
    ? { detail: 'connection interrupted', retry: true } : null
}

export async function uploadVideo(args: UploadVideoArgs): Promise<UploadedVideo> {
  // v1.4.84 — the gate lives HERE, and in `updateVideoMetadata`, because these
  // two functions are the only two doors to the YouTube Data API. Every route,
  // every job, every bulk action goes through one of them, so a caller added
  // next year is covered without anyone remembering to cover it. See
  // lib/metadata-scaffold.ts for what "junk" means and how it was calibrated.
  assertPublishableMetadata(args.snippet)
  const stat = args.sourceHandle ? await args.sourceHandle.stat() : await fsp.stat(args.filePath)
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
        const finalProbe = await youtubeFetch(sessionUrl, {
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
    let initResp: Response | undefined
    for (let attempt = 1; attempt <= UPLOAD_START_ATTEMPTS; attempt++) {
      args.signal?.throwIfAborted()
      let networkFailure: ReturnType<typeof uploadStartNetworkFailure> = null
      try {
        initResp = await fetchWithAuthRetry(args.slug, args.accountId, async (accessToken) => {
          args.signal?.throwIfAborted()
          try {
            return await youtubeFetch(`${UPLOAD_INIT_URL}?uploadType=resumable&part=snippet,status`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Length': String(totalBytes),
                'X-Upload-Content-Type': 'video/*',
              },
              body: JSON.stringify(initBody),
              signal: args.signal,
            })
          } catch (error) {
            networkFailure = uploadStartNetworkFailure(error)
            throw error
          }
        }, 'videos_insert')
      } catch (error) {
        args.signal?.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
        // Auth, quota and local persistence failures retain their own errors.
        // Only a failed network call is eligible for a startup retry.
        const failure = networkFailure as ReturnType<typeof uploadStartNetworkFailure>
        if (!failure) throw error
        if (!failure.retry || attempt === UPLOAD_START_ATTEMPTS) {
          // eslint-disable-next-line preserve-caught-error -- Raw transport causes can contain credentials and session URLs; retain only safe codes.
          throw new Error(`YouTube upload could not start: ${failure.detail}. No video bytes were sent. Check your connection to Google, then Retry this job.`)
        }
        args.logLines?.push(`YouTube upload connection interrupted (${failure.detail}). Retrying session setup (${attempt + 1}/${UPLOAD_START_ATTEMPTS}); no video bytes sent.`)
        await delay(backoffMs(attempt), undefined, { signal: args.signal })
        continue
      }
      if (initResp.ok) break
      const retryAfter = initResp.headers.get('retry-after')
      const retryDelay = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())
      if (RETRYABLE_UPLOAD_START_STATUS.has(initResp.status) && attempt < UPLOAD_START_ATTEMPTS
        && (!Number.isFinite(retryDelay) || retryDelay <= 30_000)) {
        args.logLines?.push(`YouTube session setup returned HTTP ${initResp.status}. Retrying (${attempt + 1}/${UPLOAD_START_ATTEMPTS}); no video bytes sent.`)
        await initResp.body?.cancel().catch(() => {})
        await delay(Math.max(backoffMs(attempt), Number.isFinite(retryDelay) ? retryDelay : 0), undefined, { signal: args.signal })
        continue
      }
      const text = await initResp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(initResp.status, text)
      throw new Error(quotaMsg || `Upload init failed (${initResp.status}): ${text.slice(0, 400)}`)
    }
    if (!initResp?.ok) throw new Error('YouTube upload could not start. No video bytes were sent. Retry this job.')
    // fetchWithAuthRetry records this init attempt even when it fails. Google
    // bills videos.insert at session creation, before any later chunk PUT.
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
        if (args.onResumableSessionReady) throw e
        logLine('warn', `[upload-resume] sidecar persist failed: ${e?.message || 'unknown'}`, {
          slug: args.slug,
          episode_code: args.episodeCode,
        })
      }
    }
    await args.onResumableSessionReady?.(sessionUrlHash(sessionUrl), totalBytes)
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
      sourceHandle: args.sourceHandle,
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
  const resp = await youtubeFetch(sessionUrl, {
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
  sourceHandle?: FileHandle
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
        const chunkStream = args.sourceHandle
          ? args.sourceHandle.createReadStream({ start: cursor, end, autoClose: false })
          : fs.createReadStream(args.filePath, { start: cursor, end })
        const webStream = nodeStreamToWeb(chunkStream)
        const resp = await youtubeFetch(args.sessionUrl, {
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
          const finalProbe = await youtubeFetch(args.sessionUrl, {
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
  snippet?: Partial<VideoSnippet>
  /**
   * Optional. When omitted, the PATCH only includes `snippet` (title /
   * description / tags / categoryId) — YouTube's privacyStatus and
   * publishAt stay untouched. This is the safe default for the per-row
   * "↻ Update metadata" button: re-pushing privacyStatus would otherwise
   * silently flip a public video back to private, or wipe an existing
   * publishAt schedule, which is rarely what the user wants when they
   * just fixed a typo in the title.
   */
  status?: Partial<VideoStatus>
  /** Require the live visibility before an update that schedules publication. */
  requirePrivacyStatus?: PrivacyStatus
}): Promise<UploadedVideo> {
  if (!opts.snippet && !opts.status) throw new Error('Name at least one YouTube metadata part to update.')
  const live = (await listVideoSnippetStatus(opts.slug, opts.accountId, [opts.videoId]))[opts.videoId]
  if (!live) throw new Error('YouTube did not return the exact video requested for metadata update.')
  if (!live.etag) throw new Error('YouTube did not return an ETag; refusing to overwrite metadata without concurrency protection.')
  if (opts.requirePrivacyStatus && live.privacyStatus !== opts.requirePrivacyStatus) {
    const error = new Error(`This video is ${live.privacyStatus}; only a private YouTube video can be scheduled here.`) as Error & { statusCode?: number }
    error.statusCode = 409
    throw error
  }
  const body: Record<string, unknown> = { id: opts.videoId }
  if (opts.snippet) {
    const snippet: VideoSnippet = {
      title: opts.snippet.title ?? live.title,
      description: opts.snippet.description ?? live.description,
      tags: opts.snippet.tags ?? live.tags,
      categoryId: opts.snippet.categoryId ?? live.categoryId,
      ...(opts.snippet.defaultLanguage !== undefined
        ? { defaultLanguage: opts.snippet.defaultLanguage }
        : live.defaultLanguage !== undefined ? { defaultLanguage: live.defaultLanguage } : {}),
      ...(opts.snippet.defaultAudioLanguage !== undefined
        ? { defaultAudioLanguage: opts.snippet.defaultAudioLanguage }
        : live.defaultAudioLanguage !== undefined ? { defaultAudioLanguage: live.defaultAudioLanguage } : {}),
    }
    assertPublishableMetadata(snippet)
    body.snippet = snippet
  }
  // Same publishAt/privacy invariant as uploadVideo — enforce here too
  // so metadata-only updates don't 400 on the "scheduled public" footgun.
  // Only build the status block when the caller passed one; omitting it
  // tells YouTube to leave the existing video's status alone.
  if (opts.status) {
    const publishAt = Object.prototype.hasOwnProperty.call(opts.status, 'publishAt')
      ? opts.status.publishAt : live.publishAt ?? undefined
    const privacyStatus = opts.status.privacyStatus ?? live.privacyStatus
    const effectivePrivacy = publishAt ? 'private' : privacyStatus
    body.status = {
      privacyStatus: effectivePrivacy,
      ...(publishAt ? { publishAt } : {}),
      selfDeclaredMadeForKids: opts.status.selfDeclaredMadeForKids ?? live.selfDeclaredMadeForKids,
      containsSyntheticMedia: opts.status.containsSyntheticMedia ?? live.containsSyntheticMedia,
      embeddable: opts.status.embeddable ?? live.embeddable,
      license: opts.status.license ?? live.license,
      publicStatsViewable: opts.status.publicStatsViewable ?? live.publicStatsViewable,
    }
  }
  // The `part` query param must list exactly the fields we're sending.
  // Including `status` when we didn't send a status block makes YouTube
  // wipe the existing status to defaults — defeating the whole point of
  // the preserve-status path.
  const partParam = [opts.snippet ? 'snippet' : '', opts.status ? 'status' : '']
    .filter(Boolean)
    .join(',')
  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
    youtubeFetch(`${VIDEOS_UPDATE_URL}?part=${partParam}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'If-Match': live.etag,
      },
      body: JSON.stringify(body),
    }),
    'videos_update',
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    if (resp.status === 412) throw new Error('YouTube metadata changed after it was read. Reload the video and review the update again.')
    throw new Error(quotaMsg || `Metadata update failed (${resp.status}): ${text.slice(0, 400)}`)
  }
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
  // v1.0.524 — guarantee ≤2 MB / ≤1280 px so YouTube doesn't 413 the file.
  // Small images pass through untouched (a crisp PNG stays a PNG).
  const prepared = await prepareThumbnail(opts.filePath)

  // Retry loop for the transient "still processing" race (auth-retry stays
  // inside fetchWithAuthRetry). backoff.length + 1 total attempts.
  for (let attempt = 0; ; attempt++) {
    const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
      youtubeFetch(`${THUMBNAILS_SET_URL}?videoId=${encodeURIComponent(opts.videoId)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': prepared.contentType,
        },
        body: prepared.buffer,
      }),
      'thumbnails_set',
    )
    if (resp.ok) {
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
    // require a verified channel). That is a fact about the CHANNEL, not a
    // failure of the upload, and it is the only place YouTube ever says so —
    // so it is recorded, and it is reported in plain words rather than as a
    // raw provider 403. The caller decides what to do with the video.
    const { isChannelThumbnailForbidden, noteYouTubeChannelThumbnailForbidden } =
      await import('../services/youtube-channel-eligibility.js')
    const channelForbidden = isChannelThumbnailForbidden(resp.status, text)
    if (channelForbidden) {
      await noteYouTubeChannelThumbnailForbidden({ project_slug: opts.slug, account_id: opts.accountId }).catch(() => {})
    }
    const message = channelForbidden
      ? 'This channel isn\'t verified for custom thumbnails, so the thumbnail was skipped.'
      : quotaMsg || `Thumbnail upload failed (${resp.status}): ${text.slice(0, 300)}. Custom thumbnails require channel verification on YouTube.`
    const error: Error & { code?: string } = new Error(message)
    if (channelForbidden) error.code = 'YOUTUBE_CHANNEL_THUMBNAILS_FORBIDDEN'
    throw error
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
      youtubeFetch(`${PLAYLISTS_URL}?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      'playlists_list',
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
  return out
}

export async function addVideoToPlaylist(opts: {
  slug: string
  accountId: string
  playlistId: string
  videoId: string
}): Promise<void> {
  const body = {
    snippet: {
      playlistId: opts.playlistId,
      resourceId: { kind: 'youtube#video', videoId: opts.videoId },
    },
  }
  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
    youtubeFetch(`${PLAYLIST_ITEMS_URL}?part=snippet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    'playlist_items_insert',
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `playlistItems.insert failed (${resp.status}): ${text.slice(0, 300)}`)
  }
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
  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, accessToken =>
    youtubeFetch(`${PLAYLIST_ITEMS_URL}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    'playlist_items_list',
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `playlistItems.list failed (${resp.status}): ${text.slice(0, 300)}`)
  }
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
    const url = `${VIDEOS_UPDATE_URL}?part=status&id=${batch.map(encodeURIComponent).join(',')}`
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      youtubeFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
      'videos_list',
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
      throw new Error(quotaMsg || `videos.list failed (${resp.status}): ${text.slice(0, 300)}`)
    }
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
  etag: string
  title: string
  description: string
  privacyStatus: 'private' | 'unlisted' | 'public'
  publishAt: string | null
  categoryId: string
  /** undefined when YouTube hasn't echoed the field (legacy uploads predate the disclosure). */
  containsSyntheticMedia?: boolean
  /**
   * The tags currently live on the video. Already in the `part=snippet` this
   * call requests, so reading it costs no extra request and no extra quota. The
   * backfill needs it to tell "replacing an empty tag list with an empty one"
   * from "erasing the tags a published video has".
   */
  tags: string[]
  defaultLanguage?: string
  defaultAudioLanguage?: string
  selfDeclaredMadeForKids: boolean
  embeddable: boolean
  license: string
  publicStatsViewable: boolean
}
/**
 * Bulk-fetch what a video's PUBLICATION actually is: the processing outcome
 * plus the live snippet/status, for the Upload Center's
 * Processing → Ready / Failed / Rejected states.
 *
 * A new read rather than a wider `part=` on the two existing ones: those two
 * serve the schedule display and the metadata backfill, and quietly changing
 * what they request changes the quota cost of both.
 *
 * A video that does not come back is ABSENT from the map. Absent means "we
 * could not see it", which the caller must not confuse with any known state.
 *
 * Cost: 1 quota unit (`videos_list`) per batch of 50.
 */
export interface VideoPublicationDetails {
  channelId?: string
  uploadStatus?: string
  failureReason?: string
  rejectionReason?: string
  privacyStatus?: string
  publishAt?: string | null
  processingStatus?: string
  /** YouTube's own word for WHY processing stopped (`tooLong`, `transcodeFailed`, …). */
  processingFailureReason?: string
  title?: string
  description?: string
  tags?: string[]
  thumbnailEtag?: string
}

const COMMENTS_MODERATION_URL = 'https://www.googleapis.com/youtube/v3/comments/setModerationStatus'

/**
 * Approve or reject a comment, and optionally ban its author.
 *
 * The first moderation write this product has ever made. Two things are
 * deliberate:
 *
 * `banAuthor` is an explicit argument that defaults to false and is never
 * inferred from the status. Banning is irreversible from Story Studio's side
 * and spec section 14 requires it to be an individual, separately confirmed
 * action - so it can only happen when a caller asks for it in so many words.
 *
 * There is no delete. Spec section 14 gives Story Studio approve, reject and
 * ban; rejection HIDES a comment. A delete path would be a capability nobody
 * asked for, on data that cannot be recovered.
 */
export async function setCommentModerationStatus(opts: {
  slug: string
  accountId: string
  commentId: string
  status: 'published' | 'rejected' | 'heldForReview'
  banAuthor?: boolean
}): Promise<void> {
  if (!opts.commentId) throw new Error('commentId is required')
  if (opts.banAuthor && opts.status !== 'rejected') {
    // YouTube only accepts banAuthor alongside a rejection, and silently
    // ignoring it would mean telling the owner someone was banned when they
    // were not.
    throw new Error('An author can only be banned while rejecting their comment.')
  }
  const url = new URL(COMMENTS_MODERATION_URL)
  url.searchParams.set('id', opts.commentId)
  url.searchParams.set('moderationStatus', opts.status)
  if (opts.banAuthor) url.searchParams.set('banAuthor', 'true')

  const resp = await fetchWithAuthRetry(opts.slug, opts.accountId, (accessToken) =>
    youtubeFetch(url.toString(), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }),
    'comments_insert',
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new Error(quotaMsg || `comments.setModerationStatus failed (${resp.status}): ${text.slice(0, 300)}`)
  }
}

export async function listVideoPublicationDetails(
  slug: string, accountId: string, videoIds: string[],
): Promise<Record<string, VideoPublicationDetails>> {
  const out: Record<string, VideoPublicationDetails> = {}
  const unique = Array.from(new Set(videoIds.filter(Boolean)))
  if (!unique.length) return out
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50)
    const url = `${VIDEOS_UPDATE_URL}?part=snippet,status,processingDetails&id=${batch.map(encodeURIComponent).join(',')}`
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      youtubeFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
      'videos_list',
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
      throw new Error(quotaMsg || `videos.list failed (${resp.status}): ${text.slice(0, 300)}`)
    }
    const data = await resp.json() as any
    for (const item of (data.items || [])) {
      if (!item?.id) continue
      const snippet = item.snippet || {}
      const status = item.status || {}
      out[item.id] = {
        channelId: snippet.channelId,
        uploadStatus: status.uploadStatus,
        failureReason: status.failureReason,
        rejectionReason: status.rejectionReason,
        privacyStatus: status.privacyStatus,
        publishAt: status.publishAt ?? null,
        processingStatus: item.processingDetails?.processingStatus,
        processingFailureReason: item.processingDetails?.processingFailureReason,
        title: snippet.title,
        description: snippet.description,
        tags: Array.isArray(snippet.tags) ? snippet.tags : [],
        thumbnailEtag: snippet.thumbnails?.default?.url,
      }
    }
  }
  return out
}

export async function listVideoSnippetStatus(
  slug: string, accountId: string, videoIds: string[],
): Promise<Record<string, VideoBackfillView>> {
  const out: Record<string, VideoBackfillView> = {}
  const unique = Array.from(new Set(videoIds.filter(Boolean)))
  if (!unique.length) return out
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50)
    const url = `${VIDEOS_UPDATE_URL}?part=snippet,status&id=${batch.map(encodeURIComponent).join(',')}`
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      youtubeFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
      'videos_list',
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
      throw new Error(quotaMsg || `videos.list failed (${resp.status}): ${text.slice(0, 300)}`)
    }
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
        etag: typeof item.etag === 'string' ? item.etag : '',
        title: typeof sn.title === 'string' ? sn.title : '',
        description: typeof sn.description === 'string' ? sn.description : '',
        privacyStatus,
        publishAt,
        categoryId: typeof sn.categoryId === 'string' ? sn.categoryId : '24',
        containsSyntheticMedia: typeof st.containsSyntheticMedia === 'boolean'
          ? st.containsSyntheticMedia
          : undefined,
        tags: Array.isArray(sn.tags) ? sn.tags.filter((tag: unknown) => typeof tag === 'string') : [],
        ...(typeof sn.defaultLanguage === 'string' ? { defaultLanguage: sn.defaultLanguage } : {}),
        ...(typeof sn.defaultAudioLanguage === 'string' ? { defaultAudioLanguage: sn.defaultAudioLanguage } : {}),
        selfDeclaredMadeForKids: st.selfDeclaredMadeForKids === true,
        embeddable: st.embeddable !== false,
        license: typeof st.license === 'string' ? st.license : 'youtube',
        publicStatsViewable: st.publicStatsViewable !== false,
      }
    }
  }
  return out
}

export async function getUploadsPlaylistId(slug: string, accountId: string): Promise<string> {
  const url = `${CHANNELS_URL}?${new URLSearchParams({ part: 'contentDetails', mine: 'true' })}`
  const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
    youtubeFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
    'channels_list',
  )
  if (!resp.ok) throw new Error(`channels.list failed (${resp.status})`)
  const data = await resp.json() as any
  const id = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!id) throw new Error('No uploads playlist found on authenticated channel.')
  return id
}

/**
 * The channel's recent uploads, and whether the listing STOPPED EARLY.
 *
 * It pages to `maxPages` and then returns. Silently. A caller that treats the
 * result as the whole channel concludes that anything past the cap does not
 * exist on YouTube - and Reconcile does exactly that, printing "In Story Studio
 * only: EP0250" for an episode whose video was simply never fetched. That is a
 * false statement about the owner's own back catalogue.
 *
 * So the truncation is returned, not swallowed: `truncated` is true when the
 * page budget ran out while YouTube still had more (tell 1b - a collection
 * returned at its maximum size is a truncation signal, never a complete
 * answer).
 */
export async function listRecentUploads(slug: string, accountId: string, opts: { maxPages?: number } = {}): Promise<{ videos: Array<{ videoId: string; title: string; publishedAt: string; privacyStatus?: string }>, truncated: boolean }> {
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
      youtubeFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
      'playlist_items_list',
    )
    if (!resp.ok) throw new Error(`playlistItems.list failed (${resp.status})`)
    const data = await resp.json() as any
    for (const it of data.items || []) {
      items.push({
        videoId: it.snippet?.resourceId?.videoId || '',
        title: it.snippet?.title || '',
        publishedAt: it.snippet?.publishedAt || '',
        privacyStatus: it.status?.privacyStatus,
      })
    }
    if (!data.nextPageToken) {
      return { videos: items, truncated: false }
    }
    pageToken = data.nextPageToken
  }
  // The loop ended with a page token still in hand: YouTube has more than the
  // budget allowed us to read.
  return { videos: items, truncated: true }
}
