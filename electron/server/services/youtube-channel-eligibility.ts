/**
 * What YouTube says this channel may do, before anything is uploaded.
 *
 * Domnak DM0001–DM0003, 2026-10-19: the channel had not been verified, YouTube
 * ACCEPTED all three uploads and then abandoned them as "too long", and the
 * custom thumbnails came back as bare 403s. Nothing in Story Studio had ever
 * asked what the channel is allowed to do — this is that read, and it is the
 * only one.
 *
 * Read-only, one quota unit per refresh (`channels.list?part=status`), cached
 * per channel for six hours so an ordinary page load costs nothing.
 *
 * It never throws. A status that cannot be read is `unknown`, which is
 * deliberately NOT a refusal: "we could not ask" and "the answer is no" must
 * not collapse into one value (AGENTS.md §6).
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { fetchWithAuthRetry, registryChannelOf, youtubeTransport } from '../lib/youtube-client.js'
import { probeForUpload } from '../lib/ffprobe-check.js'
import { logLine } from './logger.js'
import { getProjectDir } from './project-manager.js'

const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'

/** How long one answer about a channel stands before it is asked again. */
export const CHANNEL_ELIGIBILITY_TTL_MS = 6 * 60 * 60 * 1000

/**
 * YouTube's four words for `status.longUploadsStatus`, plus `unknown` for
 * "we could not ask".
 */
export type LongUploadsStatus = 'allowed' | 'eligible' | 'disallowed' | 'unspecified' | 'unknown'

export function longUploadsStatusOf(value: unknown): LongUploadsStatus {
  switch (value) {
    case 'allowed': return 'allowed'
    case 'eligible': return 'eligible'
    case 'disallowed': return 'disallowed'
    case 'longUploadsUnspecified': return 'unspecified'
    default: return 'unknown'
  }
}

/**
 * Only `allowed` means YouTube will keep a video longer than 15 minutes.
 *
 * `eligible` means the channel may ASK to be verified — it is not the
 * permission itself — and `unspecified` is YouTube declining to say. Reading
 * either as permission is the DM0001–DM0003 incident with the sign flipped.
 */
export function longUploadsAllowed(status: LongUploadsStatus): boolean {
  return status === 'allowed'
}

/**
 * The one place YouTube ever says a channel may not have custom thumbnails is
 * a 403 on `thumbnails.set` — reason `forbidden`, worded as a verification
 * problem. `channels.list` publishes no flag for it, so this recorded answer is
 * the evidence every later upload reads.
 *
 * A quota 403 (`quotaExceeded`) and any other 403 are NOT this: the message has
 * to be about thumbnails or verification.
 */
export function isChannelThumbnailForbidden(status: number, body: string): boolean {
  if (status !== 403) return false
  let parsed: any
  try { parsed = JSON.parse(body) } catch { return false }
  const errors: any[] = Array.isArray(parsed?.error?.errors) ? parsed.error.errors : []
  if (!errors.some(error => error?.reason === 'forbidden')) return false
  const text = [parsed?.error?.message, ...errors.map(error => error?.message)].filter(Boolean).join(' ')
  return /thumbnail|verif/i.test(text)
}

/** What an upload may do on this channel, and when YouTube said so. */
export interface YouTubeChannelEligibility {
  channel_id: string
  long_uploads: LongUploadsStatus
  /**
   * Custom thumbnails need a verified channel. `no` is claimed only on recorded
   * evidence (a channel 403); with none, the answer is `yes`.
   */
  thumbnails: 'yes' | 'no'
  /** When YouTube last answered about this channel. null = it never has. */
  checked_at: string | null
  /** True when this answer came from YouTube just now rather than from the cache. */
  fresh: boolean
}

type CachedChannel = {
  long_uploads: LongUploadsStatus
  checked_at: string
  /** Set once YouTube answered a `thumbnails.set` with a channel 403. */
  thumbnail_forbidden_at?: string
}

const ID = /^[A-Za-z0-9_-]+$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const LONG_UPLOADS = new Set<LongUploadsStatus>(['allowed', 'eligible', 'disallowed', 'unspecified', 'unknown'])
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && !RESERVED.has(value)
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function cachePath(slug: string): string {
  const dir = getProjectDir(slug)
  if (!dir) throw Object.assign(new Error(`Project ${slug} not found`), { statusCode: 404 })
  return path.join(dir, 'youtube', 'channel-eligibility.json')
}

/** Tolerant: an entry that is not exactly an answer is dropped, never guessed at. */
function decodeChannel(raw: unknown): CachedChannel | null {
  if (!isRecord(raw) || !LONG_UPLOADS.has(raw.long_uploads as LongUploadsStatus) || !isTime(raw.checked_at)) return null
  return {
    long_uploads: raw.long_uploads as LongUploadsStatus,
    checked_at: raw.checked_at,
    ...(isTime(raw.thumbnail_forbidden_at) ? { thumbnail_forbidden_at: raw.thumbnail_forbidden_at } : {}),
  }
}

function decodeCache(raw: unknown): Record<string, CachedChannel> {
  if (!isRecord(raw) || raw.schema_version !== 1 || !isRecord(raw.channels)) throw new Error('not a channel eligibility cache')
  const out: Record<string, CachedChannel> = {}
  for (const [channelId, value] of Object.entries(raw.channels)) {
    const decoded = isId(channelId) ? decodeChannel(value) : null
    if (decoded) out[channelId] = decoded
  }
  return out
}

/** Missing, unparsable or undecodable reads as empty. Any other IO error is "could not read". */
async function readCacheUnlocked(filePath: string): Promise<Record<string, CachedChannel>> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return {}
    throw error
  }
  try {
    return decodeCache(JSON.parse(text))
  } catch {
    return {}
  }
}

function eligibilityOf(channelId: string, cached: CachedChannel | undefined, fresh: boolean): YouTubeChannelEligibility {
  return {
    channel_id: channelId,
    long_uploads: cached?.long_uploads ?? 'unknown',
    thumbnails: cached?.thumbnail_forbidden_at ? 'no' : 'yes',
    checked_at: cached?.checked_at ?? null,
    fresh,
  }
}

/**
 * The last answer about this channel, from the cache alone.
 *
 * Display callers are cache-first by rule: an ordinary page load costs no
 * YouTube quota. Reading and refreshing are two different actions here, exactly
 * as they are for publication state. null = nothing has ever been asked.
 */
export async function readCachedChannelEligibility(
  project_slug: string,
  channel_id: string,
): Promise<YouTubeChannelEligibility | null> {
  try {
    const cache = await withLock(cachePath(project_slug), () => readCacheUnlocked(cachePath(project_slug)))
    const cached = cache[channel_id]
    return cached ? eligibilityOf(channel_id, cached, false) : null
  } catch {
    return null
  }
}

/**
 * What this channel may do, from the cache when it is still current.
 *
 * `refresh: true` asks YouTube regardless — the Upload Center's own refresh
 * action, and the read the pre-upload gate makes when the cached answer is old.
 */
export async function readYouTubeChannelEligibility(input: {
  project_slug: string
  account_id: string
  channel_id: string
  refresh?: boolean
  now?: number
}): Promise<YouTubeChannelEligibility> {
  const now = input.now ?? Date.now()
  const filePath = cachePath(input.project_slug)
  const cached = await withLock(filePath, () => readCacheUnlocked(filePath))
    .then(cache => cache[input.channel_id])
    .catch(() => undefined)

  if (!input.refresh && cached && now - Date.parse(cached.checked_at) < CHANNEL_ELIGIBILITY_TTL_MS) {
    return eligibilityOf(input.channel_id, cached, false)
  }

  let longUploads: LongUploadsStatus
  try {
    const resp = await fetchWithAuthRetry(input.project_slug, input.account_id, accessToken =>
      youtubeTransport(`${CHANNELS_URL}?${new URLSearchParams({ part: 'status', mine: 'true' })}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }), 'channels_list')
    if (!resp.ok) throw new Error(`channels.list failed (${resp.status})`)
    const data = await resp.json() as any
    // Only the requested channel's own answer counts: a sign-in that answers for
    // another channel says nothing about this one, so it stays unknown.
    const item = (data?.items || []).find((entry: any) => entry?.id === input.channel_id)
    if (!item) throw new Error('channels.list did not answer for this channel.')
    longUploads = longUploadsStatusOf(item?.status?.longUploadsStatus)
  } catch (error) {
    // A channel we cannot ask about is `unknown`, never a refusal — and the
    // last answer we do have is better than nothing.
    logLine('warn', `[youtube-eligibility] could not read the channel status: ${(error as Error)?.message || 'unknown'}`, {
      project_slug: input.project_slug, channel_id: input.channel_id,
    })
    return eligibilityOf(input.channel_id, cached, false)
  }

  const checked_at = new Date(now).toISOString()
  let stored: CachedChannel = { long_uploads: longUploads, checked_at }
  await withLock(filePath, async () => {
    const cache = await readCacheUnlocked(filePath)
    const previous = cache[input.channel_id]
    // A thumbnail 403 recorded since this read is evidence too, and dropping it
    // here would make the Upload Center forget it on the next channel refresh.
    stored = {
      ...(previous?.thumbnail_forbidden_at ? { thumbnail_forbidden_at: previous.thumbnail_forbidden_at } : {}),
      long_uploads: longUploads,
      checked_at,
    }
    cache[input.channel_id] = stored
    await writeJsonAtomic(filePath, { schema_version: 1, channels: cache }, { mode: 0o600 })
  }).catch(error => {
    // The answer is still good for this caller; the cache catches up next time.
    logLine('warn', `[youtube-eligibility] could not save the channel status: ${(error as Error)?.message || 'unknown'}`, { project_slug: input.project_slug })
  })
  return eligibilityOf(input.channel_id, stored, true)
}

/**
 * Record the one 403 that proves this channel may not have custom thumbnails.
 *
 * Best-effort by design: it runs on a failure path and must never turn a
 * thumbnail problem into a second one. A non-registry account id is a no-op.
 */
export async function noteYouTubeChannelThumbnailForbidden(input: {
  project_slug: string
  account_id: string
  now?: number
}): Promise<void> {
  const channelId = registryChannelOf(input.account_id)
  if (!channelId) return
  const filePath = cachePath(input.project_slug)
  await withLock(filePath, async () => {
    const cache = await readCacheUnlocked(filePath)
    const previous = cache[channelId]
    cache[channelId] = {
      long_uploads: previous?.long_uploads ?? 'unknown',
      checked_at: previous?.checked_at ?? new Date(input.now ?? Date.now()).toISOString(),
      thumbnail_forbidden_at: new Date(input.now ?? Date.now()).toISOString(),
    }
    await writeJsonAtomic(filePath, { schema_version: 1, channels: cache }, { mode: 0o600 })
  })
}

/** YouTube's own ceiling for a channel it has not verified for long videos. */
export const LONG_VIDEO_LIMIT_SEC = 15 * 60

export const LONG_VIDEO_REFUSAL =
  "This channel isn't verified for videos over 15 minutes. Verify it in YouTube Studio, then upload."

/**
 * The refusal for an upload of this length, or null when there is nothing to
 * refuse.
 *
 * `unknown` never refuses: "we could not ask" is not "the answer is no"
 * (AGENTS.md §6), and blocking a real upload on a network blip is a worse
 * failure than the one this guard exists for.
 */
export function longVideoRefusal(eligibility: YouTubeChannelEligibility, durationSec: number): string | null {
  if (durationSec <= LONG_VIDEO_LIMIT_SEC) return null
  if (longUploadsAllowed(eligibility.long_uploads) || eligibility.long_uploads === 'unknown') return null
  return LONG_VIDEO_REFUSAL
}

/** The length YouTube will judge this file by. 0 when it cannot be read — which never refuses. */
async function uploadDurationSeconds(filePath: string): Promise<number> {
  const probe = await probeForUpload(filePath).catch(() => null)
  return probe?.durationSec ?? 0
}

/**
 * Everything the pre-upload gate needs: how long the video is, what the channel
 * may do, and the refusal to show if there is one.
 *
 * The video's own length is asked FIRST. A video under 15 minutes is fine on
 * any channel, so a channel that does not need to be asked is not asked — no
 * quota spent, and no YouTube call on the path of every ordinary upload.
 */
export async function preflightYouTubeChannel(input: {
  project_slug: string
  account_id: string
  channel_id: string
  file_path: string
}): Promise<{ duration_sec: number; eligibility: YouTubeChannelEligibility | null; refusal: string | null }> {
  const durationSec = await uploadDurationSeconds(input.file_path)
  if (durationSec <= LONG_VIDEO_LIMIT_SEC) return { duration_sec: durationSec, eligibility: null, refusal: null }
  const eligibility = await readYouTubeChannelEligibility(input)
  return { duration_sec: durationSec, eligibility, refusal: longVideoRefusal(eligibility, durationSec) }
}
