/**
 * What YouTube itself last said about every video this project knows, per
 * channel: privacy, publishAt, title and upload status, each with the moment
 * YouTube answered about THAT video.
 *
 * Before this, only operation records kept what videos.list returned. "Check
 * All Uploads" read the same details for every legacy (pre-receipt) upload and
 * then kept only `upload_status`, so 72 videos YouTube reported as scheduled
 * stayed "uploaded" in every screen.
 *
 * One rule for every reader: observations come from the operation snapshot,
 * the verified publication receipt on a reconcile link, and this cache - the
 * NEWEST answer wins. Local intent (a sidecar's `scheduled_for`, a plan) is
 * never an observation. Nothing here writes to YouTube or links anything.
 *
 * Stored in its OWN file, `youtube/publication-cache.json`, never in
 * `project-state.json`: that file is decoded with exact keys, so an older build
 * meeting a new key there refuses every YouTube action for the project. This
 * file is a rebuildable cache - an unreadable one is logged and read as empty,
 * and corruption here cannot reach links, receipts or removals.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { VideoPublicationDetails } from '../lib/youtube-client.js'
import { listVideoPublicationDetails } from '../lib/youtube-client.js'
import * as im from './idea-manager.js'
import { logLine } from './logger.js'
import { getProjectDir } from './project-manager.js'
import { readSidecarStrict } from './upload-sidecar.js'
import type { ProjectFactsCache } from './utils.js'
import type { YouTubeOperationRecordV1 } from './youtube-operation-record-reader.js'
import { listYouTubeOperations } from './youtube-operation-store.js'
import {
  isYouTubeVideoRemoved,
  readYouTubeProjectPublishingState,
  type RemoteSyncOutcome,
  type RemoteSyncState,
  type YouTubeProjectPublishingStateV1,
} from './youtube-project-publishing-store.js'

/** `upload_status` written when YouTube answered and the video was not in the answer. */
export const YOUTUBE_VIDEO_NOT_FOUND = 'not_found'
/** An observation, or a whole-channel listing, older than this is stale. */
export const PUBLICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** videos.list accepts at most 50 ids per request. */
const VIDEOS_PER_CALL = 50

/** One video as YouTube reported it. `checked_at` absent = never asked (not "nothing scheduled"). */
export type ObservedPublication = {
  video_id: string
  source: 'operation' | 'legacy' | 'reconcile' | 'channel_listing'
  episode_code?: string
  /** When videos.list answered about THIS video. */
  checked_at?: string
  /** YouTube's own word (`processed`, `uploaded`, ...), or `not_found`. */
  upload_status?: string
  privacy_status?: string
  /** Observed publishAt. null = YouTube reported none; absent = not reported. */
  scheduled_for?: string | null
  title?: string
  /** From the channel uploads listing only. */
  published_at?: string
  listed_at?: string
}

export type PublicationCacheChannel = {
  videos: Record<string, ObservedPublication>
  /** The channel uploads listing. A failed or truncated attempt keeps the last success. */
  listing?: {
    attempted_at: string
    outcome: 'complete' | 'partial' | 'failed'
    error_code?: RemoteSyncState['error_code']
    complete_at?: string
    partial_at?: string
  }
  /** The last batched videos.list refresh. */
  last_refresh?: {
    attempted_at: string
    outcome: RemoteSyncOutcome
    requested: number
    answered: number
    error_code?: RemoteSyncState['error_code']
  }
}

/** Keyed by channel id: another channel's entries are never read or written for this one. */
export type PublicationCache = Record<string, PublicationCacheChannel>

type PublishingState = Pick<YouTubeProjectPublishingStateV1, 'episode_video_links' | 'removed_videos'>

// ── The file ─────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9_-]+$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const SOURCES = new Set(['operation', 'legacy', 'reconcile', 'channel_listing'])
const ERROR_CODES = new Set(['offline', 'provider_error', 'quota_exhausted'])
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && !RESERVED.has(value)
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const errorCode = (value: unknown) => ERROR_CODES.has(value as string) ? { error_code: value as RemoteSyncState['error_code'] } : {}

function cachePath(slug: string): string {
  const dir = getProjectDir(slug)
  if (!dir) throw Object.assign(new Error(`Project ${slug} not found`), { statusCode: 404 })
  return path.join(dir, 'youtube', 'publication-cache.json')
}

/** Tolerant: an entry that is not exactly an observation is dropped, never guessed at. */
function decodeObservation(raw: unknown, videoId: string): ObservedPublication | null {
  if (!isRecord(raw) || raw.video_id !== videoId || !isId(videoId) || !SOURCES.has(raw.source as string)) return null
  if (raw.checked_at !== undefined && !isTime(raw.checked_at)) return null
  if (raw.scheduled_for !== undefined && raw.scheduled_for !== null && !isTime(raw.scheduled_for)) return null
  const optionalText = (key: 'upload_status' | 'privacy_status' | 'title' | 'published_at') =>
    typeof raw[key] === 'string' ? { [key]: raw[key] as string } : {}
  return {
    video_id: videoId,
    source: raw.source as ObservedPublication['source'],
    ...(isId(raw.episode_code) ? { episode_code: raw.episode_code } : {}),
    ...(raw.checked_at !== undefined ? { checked_at: raw.checked_at as string } : {}),
    ...optionalText('upload_status'),
    ...optionalText('privacy_status'),
    ...(raw.scheduled_for !== undefined ? { scheduled_for: raw.scheduled_for as string | null } : {}),
    ...optionalText('title'),
    ...optionalText('published_at'),
    ...(isTime(raw.listed_at) ? { listed_at: raw.listed_at } : {}),
  }
}

function decodeCache(raw: unknown): PublicationCache {
  if (!isRecord(raw) || raw.schema_version !== 1 || !isRecord(raw.channels)) throw new Error('not a publication cache')
  const out: PublicationCache = {}
  for (const [channelId, channel] of Object.entries(raw.channels)) {
    if (!isId(channelId) || !isRecord(channel) || !isRecord(channel.videos)) continue
    const videos: Record<string, ObservedPublication> = {}
    for (const [videoId, video] of Object.entries(channel.videos)) {
      const decoded = decodeObservation(video, videoId)
      if (decoded) videos[videoId] = decoded
    }
    const listing = channel.listing
    const refresh = channel.last_refresh
    out[channelId] = {
      videos,
      ...(isRecord(listing) && isTime(listing.attempted_at) && ['complete', 'partial', 'failed'].includes(listing.outcome as string) ? {
        listing: {
          attempted_at: listing.attempted_at,
          outcome: listing.outcome as 'complete' | 'partial' | 'failed',
          ...errorCode(listing.error_code),
          ...(isTime(listing.complete_at) ? { complete_at: listing.complete_at } : {}),
          ...(isTime(listing.partial_at) ? { partial_at: listing.partial_at } : {}),
        },
      } : {}),
      ...(isRecord(refresh) && isTime(refresh.attempted_at) && ['ok', 'partial', 'failed'].includes(refresh.outcome as string)
        && Number.isSafeInteger(refresh.requested) && Number.isSafeInteger(refresh.answered) ? {
        last_refresh: {
          attempted_at: refresh.attempted_at,
          outcome: refresh.outcome as RemoteSyncOutcome,
          requested: refresh.requested as number,
          answered: refresh.answered as number,
          ...errorCode(refresh.error_code),
        },
      } : {}),
    }
  }
  return out
}

/** One line per project while its cache stays unreadable; re-armed by a good read. */
const reportedUnreadable = new Set<string>()

/**
 * Missing (ENOENT), unparsable or undecodable reads as empty. Any other IO
 * error (EACCES, EMFILE, EIO) is "could not read", not "empty": it is rethrown
 * so a transient fault never overwrites the cache with only the new checks.
 * Display callers `.catch` it and fall back to their receipts.
 */
async function readCacheUnlocked(filePath: string, slug: string): Promise<PublicationCache> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return reportUnreadable(slug, error)
  }
  // A newer build's cache is not "empty": refuse it so this build never overwrites it.
  if (isRecord(parsed) && typeof parsed.schema_version === 'number' && parsed.schema_version > 1) {
    throw new Error(`publication cache schema ${parsed.schema_version} is newer than this Story Studio`)
  }
  try {
    const cache = decodeCache(parsed)
    reportedUnreadable.delete(slug)
    return cache
  } catch (error) {
    return reportUnreadable(slug, error)
  }
}

function reportUnreadable(slug: string, error: unknown): PublicationCache {
  if (!reportedUnreadable.has(slug)) {
    reportedUnreadable.add(slug)
    logLine('warn', `[youtube-publication-cache] dropped an unreadable publication cache: ${(error as Error)?.message || 'unknown'}`, { slug })
  }
  return {}
}

/** The project's publication cache. Missing or corrupt reads as empty (rebuilt by asking YouTube again); an IO fault throws. */
export async function readYouTubePublicationCache(slug: string): Promise<PublicationCache> {
  const filePath = cachePath(slug)
  return withLock(filePath, () => readCacheUnlocked(filePath, slug))
}

/**
 * Merge what YouTube said into this channel's cache.
 *
 * Merged, never replaced: a refresh or listing that covered some videos keeps
 * every other entry, an older answer never overwrites a newer one, and a failed
 * listing changes only the attempt (its `complete_at` / `partial_at` survive).
 * Another channel's entries are never touched. Returns how many checks were kept.
 */
export async function recordYouTubePublicationObservations(input: {
  project_slug: string
  channel_id: string
  checks?: ObservedPublication[]
  refresh?: NonNullable<PublicationCacheChannel['last_refresh']>
  listing?: {
    attempted_at: string
    outcome: 'complete' | 'partial' | 'failed'
    error_code?: RemoteSyncState['error_code']
    videos?: Array<{ video_id: string; title?: string; published_at?: string }>
  }
}): Promise<number> {
  if (!isId(input.channel_id)) throw new Error('YouTube channel_id is invalid')
  const filePath = cachePath(input.project_slug)
  return withLock(filePath, async () => {
    const cache = await readCacheUnlocked(filePath, input.project_slug)
    const channel: PublicationCacheChannel = cache[input.channel_id] ?? { videos: {} }
    let kept = 0
    for (const check of input.checks ?? []) {
      const observed = decodeObservation(check, check.video_id)
      if (!observed?.checked_at) continue
      const previous = channel.videos[observed.video_id]
      if (previous?.checked_at && previous.checked_at > observed.checked_at) continue
      channel.videos[observed.video_id] = {
        ...(previous?.published_at ? { published_at: previous.published_at } : {}),
        ...(previous?.listed_at ? { listed_at: previous.listed_at } : {}),
        ...(previous?.episode_code ? { episode_code: previous.episode_code } : {}),
        ...(previous?.title ? { title: previous.title } : {}),
        ...observed,
        source: observed.source === 'channel_listing' && previous ? previous.source : observed.source,
      }
      kept++
    }
    if (input.listing) {
      const { attempted_at, outcome, error_code, videos } = input.listing
      for (const video of outcome === 'failed' ? [] : videos ?? []) {
        if (!isId(video.video_id)) continue
        const previous = channel.videos[video.video_id]
        channel.videos[video.video_id] = {
          ...(previous ?? { video_id: video.video_id, source: 'channel_listing' as const }),
          ...(video.title && !previous?.title ? { title: video.title } : {}),
          ...(video.published_at ? { published_at: video.published_at } : {}),
          listed_at: attempted_at,
        }
      }
      const before = channel.listing
      channel.listing = {
        attempted_at,
        outcome,
        ...(error_code ? { error_code } : {}),
        ...(outcome === 'complete' ? { complete_at: attempted_at } : before?.complete_at ? { complete_at: before.complete_at } : {}),
        ...(outcome === 'partial' ? { partial_at: attempted_at } : before?.partial_at ? { partial_at: before.partial_at } : {}),
      }
    }
    if (input.refresh) channel.last_refresh = { ...input.refresh }
    cache[input.channel_id] = channel
    await writeJsonAtomic(filePath, { schema_version: 1, channels: cache }, { mode: 0o600 })
    return kept
  })
}

// ── Reading observations ─────────────────────────────────────────────────

/**
 * Why a request did not get an answer, in terms a screen can act on. "Never
 * reached YouTube" (`offline`) and "YouTube answered and refused" are different.
 */
export function classifyYouTubeSyncFailure(error: unknown): RemoteSyncState['error_code'] {
  const code = (error as { code?: string } | null)?.code
  if (code === 'YOUTUBE_QUOTA_EXHAUSTED') return 'quota_exhausted'
  // The local quota LEDGER being unreadable is not an exhausted allowance.
  if (code?.startsWith('YOUTUBE_QUOTA_LEDGER')) return 'provider_error'
  // Recording a new code would make older builds read the project state as corrupt.
  if (code === 'YOUTUBE_RECONNECT_REQUIRED') return 'provider_error'
  if (code === 'YOUTUBE_TOKEN_REFRESH_FAILED') return (error as { transient?: boolean }).transient ? 'offline' : 'provider_error'
  const message = error instanceof Error ? error.message : String(error)
  // YouTube's own 403 quotaExceeded / dailyLimitExceeded, as `friendlyQuotaErrorMessage` words it.
  if (/daily quota reached|quotaExceeded|dailyLimitExceeded/i.test(message)) return 'quota_exhausted'
  // youtube-client throws this exact shape once YouTube has actually answered.
  if (/failed \(\d{3}\)/.test(message) || /quota/i.test(message)) return 'provider_error'
  return 'offline'
}

/** One videos.list answer about one video. `details === null`: answered, and the video was not in it. */
export function observationFromDetails(
  videoId: string,
  details: VideoPublicationDetails | null,
  checkedAt: string,
  source: ObservedPublication['source'],
  episodeCode?: string,
): ObservedPublication {
  const base = { video_id: videoId, source, ...(episodeCode ? { episode_code: episodeCode } : {}), checked_at: checkedAt }
  if (!details) return { ...base, upload_status: YOUTUBE_VIDEO_NOT_FOUND }
  return {
    ...base,
    ...(details.uploadStatus ? { upload_status: details.uploadStatus } : {}),
    // "Nothing scheduled" is claimed only when YouTube returned the status block.
    ...(details.privacyStatus ? { privacy_status: details.privacyStatus, scheduled_for: details.publishAt ?? null } : {}),
    ...(details.title ? { title: details.title } : {}),
  }
}

export function isObservationStale(entry: Pick<ObservedPublication, 'checked_at' | 'scheduled_for'>, now = Date.now()): boolean {
  const checked = entry.checked_at ? Date.parse(entry.checked_at) : NaN
  if (!Number.isFinite(checked) || now - checked > PUBLICATION_CACHE_TTL_MS) return true
  // A schedule whose moment has passed since we looked is no longer what YouTube shows.
  const at = entry.scheduled_for ? Date.parse(entry.scheduled_for) : NaN
  return Number.isFinite(at) && at <= now && checked < at
}

export function snapshotObservation(record: YouTubeOperationRecordV1): ObservedPublication | undefined {
  const snapshot = record.remote_snapshot
  if (!snapshot || !record.video_id) return undefined
  return {
    video_id: record.video_id, source: 'operation', episode_code: record.episode_code,
    checked_at: snapshot.fetched_at,
    ...(record.processing?.provider_status ? { upload_status: record.processing.provider_status } : {}),
    privacy_status: snapshot.privacy_status, scheduled_for: snapshot.scheduled_for, title: snapshot.title,
  }
}

export function receiptObservation(
  episodeCode: string,
  link: YouTubeProjectPublishingStateV1['episode_video_links'][string] | undefined,
): ObservedPublication | undefined {
  if (!link?.publication) return undefined
  return {
    video_id: link.video_id, source: 'reconcile', episode_code: episodeCode,
    checked_at: link.publication.verified_at,
    privacy_status: link.publication.privacy_status, scheduled_for: link.publication.scheduled_for,
  }
}

/** Exact match only: this channel, this video id. */
export function cachedObservation(cache: PublicationCache | null | undefined, channelId: string | null | undefined, videoId: string | undefined): ObservedPublication | undefined {
  if (!channelId || !videoId) return undefined
  return cache?.[channelId]?.videos[videoId]
}

/** The newest ANSWERED observation; listing-only facts (`published_at`) are carried over from any of them. */
export function newestObservation(...candidates: Array<ObservedPublication | undefined>): ObservedPublication | undefined {
  const present = candidates.filter((entry): entry is ObservedPublication => !!entry)
  const answered = present.filter(entry => !!entry.checked_at)
    .sort((a, b) => b.checked_at!.localeCompare(a.checked_at!))[0]
  if (!answered) return undefined
  const listed = present.find(entry => entry.published_at)
  return listed && !answered.published_at ? { ...answered, published_at: listed.published_at! } : answered
}

/**
 * Legacy (pre-receipt) uploads on this channel, by video id → episode code.
 * A sidecar naming no channel, and never placed by YouTube, is treated as this channel's.
 */
export async function legacyUploadsFor(slug: string, channelId: string, facts?: ProjectFactsCache): Promise<Map<string, string>> {
  const withRecord = new Set((await listYouTubeOperations(slug, facts))
    .filter(record => record.channel_id === channelId && !!record.video_id)
    .map(record => record.episode_code.toUpperCase()))
  const out = new Map<string, string>()
  for (const idea of await im.getIdeas(slug, 'accepted')) {
    const code = String(idea.episode_code || '').toUpperCase()
    if (!code || withRecord.has(code)) continue
    const sidecar = await readSidecarStrict(slug, code, 'youtube', facts).catch(() => null)
    const videoId = sidecar?.video_id?.trim()
    if (!videoId || sidecar!.deleted_at) continue
    // A sidecar naming no channel is owned by whichever channel YouTube last
    // placed it on, so a reassigned project's old upload settles instead of
    // staying "unchecked" on the new channel forever.
    const owner = sidecar!.channel_id || sidecar!.youtube_check?.channel_id
    if (owner && owner !== channelId) continue
    out.set(videoId, code)
  }
  return out
}

/**
 * Every video this channel's records know of, with its newest observation (or
 * none yet). `legacy` adds legacy uploads the cache has never been told about,
 * so they count as unchecked rather than not existing.
 */
export function observedPublicationIndex(
  state: PublishingState,
  cache: PublicationCache,
  records: YouTubeOperationRecordV1[],
  channelId: string,
  legacy?: Map<string, string>,
): Map<string, ObservedPublication> {
  const found = new Map<string, ObservedPublication[]>()
  const add = (entry: ObservedPublication) => found.set(entry.video_id, [...(found.get(entry.video_id) ?? []), entry])
  for (const record of records) {
    if (record.channel_id !== channelId || !record.video_id
      || isYouTubeVideoRemoved(state, record.episode_code, record.channel_id, record.video_id)) continue
    add(snapshotObservation(record) ?? { video_id: record.video_id, source: 'operation', episode_code: record.episode_code })
  }
  for (const [code, link] of Object.entries(state.episode_video_links)) {
    if (link.channel_id !== channelId || isYouTubeVideoRemoved(state, code, link.channel_id, link.video_id)) continue
    add(receiptObservation(code, link) ?? { video_id: link.video_id, source: 'reconcile', episode_code: code })
  }
  for (const entry of Object.values(cache[channelId]?.videos ?? {})) {
    if (entry.episode_code && isYouTubeVideoRemoved(state, entry.episode_code, channelId, entry.video_id)) continue
    add(entry)
  }
  for (const [videoId, code] of legacy ?? []) {
    if (!isYouTubeVideoRemoved(state, code, channelId, videoId)) add({ video_id: videoId, source: 'legacy', episode_code: code })
  }
  return new Map([...found].map(([videoId, entries]) => {
    const newest = newestObservation(...entries)
    // Known but never answered: the most specific identity, with no checked_at.
    return [videoId, newest ?? entries.find(entry => entry.source !== 'channel_listing') ?? entries[0]!]
  }))
}

/**
 * The supported read: every observed video and schedule on this channel, with
 * coverage and staleness. A `not_found` answer is a final word, not data age:
 * it is counted on its own and never sets or freezes the freshness figures.
 */
export function publicationCacheView(
  state: PublishingState,
  cache: PublicationCache,
  records: YouTubeOperationRecordV1[],
  channelId: string,
  options: { now?: number; legacy?: Map<string, string> } = {},
) {
  const now = options.now ?? Date.now()
  const videos = [...observedPublicationIndex(state, cache, records, channelId, options.legacy).values()]
    .map(entry => ({ ...entry, stale: isObservationStale(entry, now) }))
    .sort((a, b) => a.video_id.localeCompare(b.video_id))
  const gone = videos.filter(entry => entry.upload_status === YOUTUBE_VIDEO_NOT_FOUND)
  const live = videos.filter(entry => entry.upload_status !== YOUTUBE_VIDEO_NOT_FOUND)
  const checked = live.map(entry => entry.checked_at).filter((at): at is string => !!at).sort()
  const channel = cache[channelId]
  const listing = channel?.listing
  const lastListed = [listing?.complete_at, listing?.partial_at].filter((at): at is string => !!at).sort().at(-1)
  const completeAt = listing?.complete_at ? Date.parse(listing.complete_at) : NaN
  return {
    channel_id: channelId,
    ttl_ms: PUBLICATION_CACHE_TTL_MS,
    coverage: {
      /** False when the legacy sidecar sweep was not available: legacy uploads never checked are then missing from these counts. */
      legacy_included: options.legacy !== undefined,
      known_videos: videos.length,
      checked_videos: checked.length,
      unchecked_videos: live.length - checked.length,
      not_found_videos: gone.length,
      stale_videos: live.filter(entry => entry.stale).length,
      oldest_checked_at: checked[0] ?? null,
      newest_checked_at: checked.at(-1) ?? null,
      listing: {
        state: !lastListed ? 'never' as const : lastListed === listing?.complete_at ? 'complete' as const : 'partial' as const,
        complete_at: listing?.complete_at ?? null,
        partial_at: listing?.partial_at ?? null,
        stale: !Number.isFinite(completeAt) || now - completeAt > PUBLICATION_CACHE_TTL_MS,
        last_attempt: listing
          ? { attempted_at: listing.attempted_at, outcome: listing.outcome, ...(listing.error_code ? { error_code: listing.error_code } : {}) }
          : null,
      },
      last_refresh: channel?.last_refresh ?? null,
    },
    videos,
    schedules: videos
      .filter(entry => entry.privacy_status === 'private' && !!entry.scheduled_for)
      .sort((a, b) => a.scheduled_for!.localeCompare(b.scheduled_for!)),
  }
}

// ── Refreshing ───────────────────────────────────────────────────────────

export interface PublicationRefreshResult {
  outcome: RemoteSyncOutcome
  error_code?: RemoteSyncState['error_code']
  /** Ids sent to YouTube this run. */
  requested: number
  /** Ids the call bound left for a later run. */
  unrequested: number
  calls: number
  /** Raw answers for the ids in answered calls. */
  details: Record<string, VideoPublicationDetails>
  /** Ids whose call was answered (found or not), after the wrong-account guard. */
  answered: string[]
  recorded: number
}

/**
 * Ask YouTube about these videos, 50 per call and at most `max_calls` calls,
 * and record every answer. A failed call keeps what earlier calls learned and
 * writes nothing for its own ids; a video YouTube places on another channel is
 * not recorded under this one.
 */
export async function refreshYouTubePublications(input: {
  project_slug: string
  account_id: string
  channel_id: string
  videos: Map<string, { source: ObservedPublication['source']; episode_code?: string }>
  max_calls: number
}): Promise<PublicationRefreshResult> {
  const ids = [...input.videos.keys()]
  if (!ids.length) return { outcome: 'ok', requested: 0, unrequested: 0, calls: 0, details: {}, answered: [], recorded: 0 }
  const batches: string[][] = []
  for (let i = 0; i < ids.length && batches.length < Math.max(1, input.max_calls); i += VIDEOS_PER_CALL) {
    batches.push(ids.slice(i, i + VIDEOS_PER_CALL))
  }
  const details: Record<string, VideoPublicationDetails> = {}
  let answered: string[] = []
  let requested = 0
  let calls = 0
  let error_code: RemoteSyncState['error_code'] | undefined
  for (const batch of batches) {
    calls++
    requested += batch.length
    try {
      Object.assign(details, await listVideoPublicationDetails(input.project_slug, input.account_id, batch))
      answered.push(...batch)
    } catch (error) {
      error_code = classifyYouTubeSyncFailure(error)
      break
    }
  }
  const unrequested = ids.length - batches.reduce((sum, batch) => sum + batch.length, 0)
  // The owner's credential sees every video on the channel: an answer with
  // none of several known videos is a token for another account, not an empty channel.
  if (answered.length >= 3 && !answered.some(id => details[id])) {
    answered = []
    error_code = 'provider_error'
  }
  const outcome: RemoteSyncOutcome = error_code
    ? (answered.length ? 'partial' : 'failed')
    : unrequested > 0 ? 'partial' : 'ok'
  const checkedAt = new Date().toISOString()
  const checks = answered
    .filter(id => !details[id]?.channelId || details[id]!.channelId === input.channel_id)
    .map(id => observationFromDetails(id, details[id] ?? null, checkedAt, input.videos.get(id)!.source, input.videos.get(id)!.episode_code))
  const recorded = await recordYouTubePublicationObservations({
    project_slug: input.project_slug,
    channel_id: input.channel_id,
    checks,
    refresh: {
      attempted_at: checkedAt, outcome, requested, answered: answered.length,
      ...(error_code ? { error_code } : {}),
    },
  }).catch(error => {
    // YouTube already answered: the caller's own records still get written; the cache catches up next check.
    logLine('warn', `[youtube-publication-cache] could not record observations: ${(error as Error)?.message || 'unknown'}`, { slug: input.project_slug })
    return 0
  })
  return { outcome, ...(error_code ? { error_code } : {}), requested, unrequested, calls, details, answered, recorded }
}

/**
 * The bounded background refresh: every known video on the channel whose
 * observation is missing or stale - ready, scheduled, reconciled or already
 * cached legacy/listed alike - oldest first. Confirmed-gone videos are a final
 * answer and are left to the deliberate Check All.
 */
export async function refreshStaleYouTubePublications(input: {
  project_slug: string
  account_id: string
  channel_id: string
  max_calls: number
  now?: number
}): Promise<PublicationRefreshResult | null> {
  const [state, cache, records] = await Promise.all([
    readYouTubeProjectPublishingState(input.project_slug),
    readYouTubePublicationCache(input.project_slug),
    listYouTubeOperations(input.project_slug),
  ])
  const stale = [...observedPublicationIndex(state, cache, records, input.channel_id).values()]
    .filter(entry => entry.upload_status !== YOUTUBE_VIDEO_NOT_FOUND && isObservationStale(entry, input.now))
    .sort((a, b) => (a.checked_at ?? '').localeCompare(b.checked_at ?? ''))
  if (!stale.length) return null
  return refreshYouTubePublications({
    ...input,
    videos: new Map(stale.map(entry => [entry.video_id, { source: entry.source, ...(entry.episode_code ? { episode_code: entry.episode_code } : {}) }])),
  })
}
