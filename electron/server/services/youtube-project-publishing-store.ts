import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import type { YouTubeFoundationErrorCode } from '../contracts/youtube-upload-center.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { getProjectDir } from './project-manager.js'
import { projectFactsFor, type ProjectFactsCache } from './utils.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import type { PageCursor } from './youtube-page-cursor.js'
import { logLine } from './logger.js'

export type YouTubeProjectPublishingStateErrorCode = 'YOUTUBE_PROJECT_STATE_CORRUPT' | 'YOUTUBE_PROJECT_STATE_IO'

export class YouTubeProjectPublishingStateError extends Error {
  readonly statusCode = 409
  readonly code: YouTubeProjectPublishingStateErrorCode
  readonly expose = true

  constructor(code: YouTubeProjectPublishingStateErrorCode, detail: string) {
    super(detail)
    this.name = 'YouTubeProjectPublishingStateError'
    this.code = code
  }
}

type EpisodeVideoLink = {
  channel_id: string
  video_id: string
  linked_at: string
  source: 'upload' | 'reconcile'
  /** Provider-confirmed publication facts for non-operation identities. */
  publication?: {
    verified_at: string
    privacy_status: string
    scheduled_for: string | null
  }
}

type ReconciliationDecision = {
  decision_id: string
  episode_code: string
  previous_video_id: string | null
  next_video_id: string
  decided_at: string
  rolled_back_at?: string
}

export interface YouTubeProjectPublishingStateV1 {
  schema_version: 1
  revision: number
  project_slug: string
  episode_video_links: Record<string, EpisodeVideoLink>
  reconciliation_history: ReconciliationDecision[]
  /** Explicit owner decisions; missing provider responses never create these. */
  removed_videos?: Array<{
    episode_code: string
    channel_id: string
    video_id: string
    confirmed_at: string
  }>
  /**
   * The last listing of the channel's uploads, plus the videos the owner has
   * deliberately set aside. Cached so the Reconcile inventory is free to open;
   * refreshing it is an explicit, quota-charged action.
   *
   * Optional, so a state file written before this field stays valid.
   */
  reconcile?: ReconcileCacheState
  /**
   * The cached comment inbox and every moderation receipt.
   *
   * Cached so opening the inbox costs no quota. Receipts are kept even for
   * rejected comments, whose identity YouTube stops returning in normal
   * listings (spec section 14) - without the receipt the action would become
   * unprovable the moment it succeeded.
   *
   * Optional, so a state file written before this field stays valid.
   */
  comments?: CommentCacheState
  /**
   * The last analytics fetch, and the channel it describes.
   *
   * Optional and additive, like every cache here. `channel_id` is the load
   * bearing part: a read for a different channel must be a MISS, because a
   * reassigned project would otherwise show the previous channel's performance
   * as its own - the same defect Library, Reconcile and Comments each shipped.
   */
  analytics?: AnalyticsCacheState
  /**
   * Where each paged sweep resumes, keyed by surface and id. Optional and
   * additive; a file written before this key decodes unchanged.
   */
  page_cursors?: Record<string, PageCursor>
  /**
   * The last deliberate whole-project sync ATTEMPT, successful or not.
   *
   * Separate from "when did we last successfully read something", which is
   * derived from the operations' own snapshots. The two answer different
   * questions: how old is what I am looking at, versus did the last try work.
   * Collapsing them would make an offline machine look freshly synced.
   *
   * Optional so a state file written before this field decodes unchanged.
   */
  remote_sync?: RemoteSyncState
}

export type ReconcileCacheState = {
  channel_id: string
  /**
   * Whether the listing STOPPED EARLY. Additive and optional: a cache written
   * before this field decodes unchanged and reads as "not known to be
   * truncated", which is what it was.
   */
  truncated?: boolean
  fetched_at: string
  remote_videos: Array<{ video_id: string; title?: string; published_at?: string }>
  /** Videos deliberately set aside. Reversible, and never "no match found". */
  ignored_video_ids: string[]
}

export type ModerationReceipt = {
  receipt_id: string
  comment_id: string
  action: 'approve' | 'reject' | 'reject_and_ban' | 'reply'
  decided_at: string
  outcome: 'done' | 'failed' | 'unrecorded'
  error_code?: string
}

/** The only reasons a fetch can be partial. Typed, not a bare string. */
/**
 * The reasons a FETCH can be partial, and therefore the only ones storable.
 *
 * `not_all_measured` is deliberately absent: it is derived at READ time from the
 * roster, never written, so a stored value of it would be a reason no writer
 * produces.
 */
export type AnalyticsPartialReason =
  | 'quota_exhausted'
  | 'provider_error'
  | 'scope_missing'
  | 'not_connected'
  | 'report_truncated'

export type AnalyticsCacheState = {
  fetched_at: string
  channel_id: string
  /**
   * The window the numbers describe. REQUIRED, not optional.
   *
   * A windowless cache was a state the merge could not reason about: with both
   * sides undefined `sameWindow` is trivially true, so a windowless cache would
   * merge with a windowed read and inherit a window it was never measured in -
   * the same defect the window guard exists to prevent, in the branch the guard
   * declared exempt. An asymmetric one (start without end) gave a window made
   * of two different reads.
   *
   * Deleting the state beats guarding it. A cache written before the window was
   * carried now fails decode and takes the droppable path: logged, dropped, and
   * refetched - which costs one report and removes a whole class of edge.
   */
  start_date: string
  end_date: string
  partial: boolean
  partial_reason?: AnalyticsPartialReason
  // No `unreached_video_ids`. It recorded what the last ATTEMPT did not cover,
  // which stopped being what the page shows the moment the cache began merging
  // - the page derives "not covered" from the roster at read time. Documenting
  // a field nobody reads is still tell 4; the same commit deleted `title` for
  // exactly this reason. Old caches carrying it are tolerated below.
  /** Stored as JSON exactly as the four-state metrics were produced. */
  episodes: Array<{
    video_id: string
    metrics: Record<string, unknown>
  }>
}

export type CommentCacheState = {
  fetched_at: string
  /** Exactly what the sweep reported. Never summarised into "some may be missing". */
  partial: boolean
  partial_reason?: string
  unreached_video_ids: string[]
  /** Read, but holding more than one call could return. Additive and optional. */
  partially_read_video_ids?: string[]
  comments_disabled_video_ids: string[]
  comments: Array<{
    comment_id: string
    video_id: string
    author: string
    /** Untrusted, author-controlled text. Stored verbatim, rendered as text. */
    text: string
    published_at: string
    moderation_status: string
    channel_replied: boolean
    reply_count: number
    /**
     * The thread's replies, and whether YouTube still accepts new ones. These
     * were declared on `InboxComment` and produced by the sweep but dropped
     * here, so the page - which requires both - received neither.
     */
    replies: Array<{ comment_id: string; author: string; text: string; from_channel: boolean }>
    can_reply: boolean
  }>
  receipts: ModerationReceipt[]
}

export type RemoteSyncOutcome = 'ok' | 'partial' | 'failed'

export type RemoteSyncState = {
  attempted_at: string
  outcome: RemoteSyncOutcome
  /** Videos this attempt actually asked YouTube about. */
  checked: number
  /** Why it failed. `offline` means the request never reached YouTube. */
  error_code?: 'offline' | 'provider_error' | 'quota_exhausted'
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const STATE_KEYS = [
  'schema_version', 'revision', 'project_slug', 'episode_video_links', 'reconciliation_history',
] as const
/** Added after the schema shipped; absent in older files, which stay valid. */
const STATE_OPTIONAL_KEYS = ['remote_sync', 'reconcile', 'comments', 'analytics', 'page_cursors', 'removed_videos'] as const
const REMOTE_SYNC_OUTCOMES = ['ok', 'partial', 'failed'] as const
const REMOTE_SYNC_ERROR_CODES = ['offline', 'provider_error', 'quota_exhausted'] as const
const PRIVACY_STATUSES = ['private', 'unlisted', 'public'] as const
const VIDEO_LINK_SOURCES = ['upload', 'reconcile'] as const
const KNOWN_SUBFOLDER_NAMES = Object.keys(DEFAULT_SUBFOLDER_NAMES)
const OPTIONAL_STORED_SUBFOLDER_NAMES = new Set(['subtitles', 'video_assets'])
const REQUIRED_SUBFOLDER_NAMES = KNOWN_SUBFOLDER_NAMES.filter(key => !OPTIONAL_STORED_SUBFOLDER_NAMES.has(key))
const RESERVED_PATH_SEGMENTS = new Set([
  '__proto__', 'constructor', 'prototype',
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function isReservedPathSegment(value: string): boolean {
  const lower = value.toLowerCase()
  const stem = lower.split('.')[0]
  return RESERVED_PATH_SEGMENTS.has(lower) || RESERVED_PATH_SEGMENTS.has(stem)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw stateCorrupt(`unexpected field ${key}`)
  }
  for (const key of required) {
    if (!hasOwn(value, key) || value[key] === undefined) throw stateCorrupt(`missing field ${key}`)
  }
}

function stateCorrupt(detail: string): YouTubeProjectPublishingStateError {
  return new YouTubeProjectPublishingStateError(
    'YOUTUBE_PROJECT_STATE_CORRUPT',
    `YouTube project publishing state is corrupt (${detail}). Refusing to replace it.`,
  )
}

function stateIo(error: unknown): YouTubeProjectPublishingStateError {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'IO_ERROR'
  return new YouTubeProjectPublishingStateError(
    'YOUTUBE_PROJECT_STATE_IO',
    `Unable to read YouTube project publishing state (${code}).`,
  )
}

function foundationError(code: YouTubeFoundationErrorCode, detail: string): YouTubeFoundationError {
  return new YouTubeFoundationError(409, code, detail)
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.trim() !== value || hasControlCharacters(value)) {
    throw stateCorrupt(`invalid ${name}`)
  }
  return value
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name)
  if (result === '.' || result === '..' || result.includes('/') || result.includes('\\') || isReservedPathSegment(result)) {
    throw stateCorrupt(`invalid ${name}`)
  }
  return result
}

function mapKey(value: string, name: string): void {
  if (!value || value.trim() !== value || hasControlCharacters(value) || value.includes('/') || value.includes('\\') || isReservedPathSegment(value)) {
    throw stateCorrupt(`invalid ${name} map key`)
  }
}

function canonicalRelativePath(value: unknown, name: string): string {
  const result = text(value, name)
  if (path.isAbsolute(result) || /^[A-Za-z]:/.test(result) || result.includes('\\') || result.includes(':')) {
    throw stateCorrupt(`invalid ${name}`)
  }
  const segments = result.split('/')
  if (segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || isReservedPathSegment(segment)
  )) || segments.join('/') !== result) {
    throw stateCorrupt(`invalid ${name}`)
  }
  return result
}

function timestamp(value: unknown, name: string): string {
  if (!isCalendarValidTimestamp(value)) throw stateCorrupt(`invalid ${name}`)
  return value
}

function isCalendarValidTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || hasControlCharacters(value)) return false
  const match = TIMESTAMP.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  return month >= 1 && month <= 12
    && day >= 1 && day <= days
    && hour <= 23 && minute <= 59 && second <= 59
    && (match[8] === 'Z' || (Number(match[9]) <= 23 && Number(match[10]) <= 59))
    && Number.isFinite(Date.parse(value))
}

function dateOnly(value: unknown, name: string): string {
  const result = text(value, name)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result)
  if (!match) throw stateCorrupt(`invalid ${name}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  if (month < 1 || month > 12 || day < 1 || day > days) throw stateCorrupt(`invalid ${name}`)
  return result
}

function finiteInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw stateCorrupt(`invalid ${name}`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw stateCorrupt(`invalid ${name}`)
  return value as T
}

function decodeEpisodeVideoLinks(value: unknown): Record<string, EpisodeVideoLink> {
  if (!isRecord(value)) throw stateCorrupt('episode_video_links is not an object')
  return Object.fromEntries(Object.entries(value).map(([episode, link]) => {
    mapKey(episode, 'episode_video_links')
    if (!isRecord(link)) throw stateCorrupt('episode video link is invalid')
    exactKeys(link, ['channel_id', 'video_id', 'linked_at', 'source'], ['publication'])
    const publication = link.publication
    if (publication !== undefined && (!isRecord(publication)
      || typeof publication.privacy_status !== 'string'
      || (publication.scheduled_for !== null && typeof publication.scheduled_for !== 'string'))) {
      throw stateCorrupt('episode video link publication is invalid')
    }
    return [episode, {
      channel_id: identifier(link.channel_id, 'episode video link channel_id'),
      video_id: identifier(link.video_id, 'episode video link video_id'),
      linked_at: timestamp(link.linked_at, 'episode video link linked_at'),
      source: oneOf(link.source, VIDEO_LINK_SOURCES, 'episode video link source'),
      ...(publication ? {
        publication: {
          verified_at: timestamp(publication.verified_at, 'episode video link publication verified_at'),
          privacy_status: publication.privacy_status as string,
          scheduled_for: publication.scheduled_for === null ? null : timestamp(publication.scheduled_for, 'episode video link publication scheduled_for'),
        },
      } : {}),
    }]
  }))
}

function decodeReconciliationHistory(value: unknown): ReconciliationDecision[] {
  if (!Array.isArray(value)) throw stateCorrupt('reconciliation_history is not an array')
  const decisions = value.map((decision) => {
    if (!isRecord(decision)) throw stateCorrupt('reconciliation decision is invalid')
    exactKeys(decision, ['decision_id', 'episode_code', 'previous_video_id', 'next_video_id', 'decided_at'], ['rolled_back_at'])
    return {
      decision_id: identifier(decision.decision_id, 'reconciliation decision_id'),
      episode_code: identifier(decision.episode_code, 'reconciliation episode_code'),
      previous_video_id: decision.previous_video_id === null ? null : identifier(decision.previous_video_id, 'reconciliation previous_video_id'),
      next_video_id: identifier(decision.next_video_id, 'reconciliation next_video_id'),
      decided_at: timestamp(decision.decided_at, 'reconciliation decided_at'),
      ...(hasOwn(decision, 'rolled_back_at') ? { rolled_back_at: timestamp(decision.rolled_back_at, 'reconciliation rolled_back_at') } : {}),
    }
  })
  if (new Set(decisions.map(decision => decision.decision_id)).size !== decisions.length) {
    throw stateCorrupt('duplicate reconciliation decision id')
  }
  return decisions
}

function decodeRemovedVideos(value: unknown): NonNullable<YouTubeProjectPublishingStateV1['removed_videos']> {
  if (!Array.isArray(value)) throw stateCorrupt('removed_videos is not an array')
  return value.map(entry => {
    if (!isRecord(entry)) throw stateCorrupt('removed video receipt is invalid')
    exactKeys(entry, ['episode_code', 'channel_id', 'video_id', 'confirmed_at'])
    return {
      episode_code: identifier(entry.episode_code, 'removed video episode'),
      channel_id: identifier(entry.channel_id, 'removed video channel'),
      video_id: identifier(entry.video_id, 'removed video id'),
      confirmed_at: timestamp(entry.confirmed_at, 'removed video confirmation'),
    }
  })
}

export function isYouTubeVideoRemoved(
  state: Pick<YouTubeProjectPublishingStateV1, 'removed_videos'>,
  episodeCode: string,
  channelId: string | null | undefined,
  videoId: string | undefined,
): boolean {
  return !!videoId && !!channelId && !!state.removed_videos?.some(entry =>
    entry.episode_code === episodeCode && entry.channel_id === channelId && entry.video_id === videoId)
}

function decodeState(raw: unknown, expectedProjectSlug: string): YouTubeProjectPublishingStateV1 {
  if (!isRecord(raw)) throw stateCorrupt('the project publishing state is not an object')
  exactKeys(raw, STATE_KEYS, STATE_OPTIONAL_KEYS)
  if (raw.schema_version !== 1) throw stateCorrupt('schema_version is invalid')
  if (raw.project_slug !== expectedProjectSlug) throw stateCorrupt('project_slug does not match its project')
  return {
    schema_version: 1,
    revision: finiteInteger(raw.revision, 'revision'),
    project_slug: identifier(raw.project_slug, 'project_slug'),
    episode_video_links: decodeEpisodeVideoLinks(raw.episode_video_links),
    reconciliation_history: decodeReconciliationHistory(raw.reconciliation_history),
    ...(hasOwn(raw, 'removed_videos') ? { removed_videos: decodeRemovedVideos(raw.removed_videos) } : {}),
    ...(hasOwn(raw, 'remote_sync') ? { remote_sync: decodeRemoteSync(raw.remote_sync) } : {}),
    ...(hasOwn(raw, 'reconcile') ? { reconcile: decodeReconcile(raw.reconcile) } : {}),
    ...(hasOwn(raw, 'comments') ? { comments: decodeComments(raw.comments) } : {}),
    ...droppableAnalytics(raw.analytics, expectedProjectSlug),
    ...(hasOwn(raw, 'page_cursors') ? { page_cursors: decodePageCursors(raw.page_cursors) } : {}),
  }
}

function nonEmpty(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw stateCorrupt(`${name} is empty`)
  return text
}

/** The only metric states this product has. Anything else is a corrupt file. */
const METRIC_STATES = new Set(['value', 'not_fetched', 'not_available', 'no_data'])
/** The only reasons a fetch can be partial. An unknown one is corruption. */
const ANALYTICS_PARTIAL_REASONS: readonly AnalyticsPartialReason[] = [
  'quota_exhausted', 'provider_error', 'scope_missing', 'not_connected', 'report_truncated',
]

function oneOfState(
  value: unknown, allowed: readonly AnalyticsPartialReason[], name: string,
): AnalyticsPartialReason {
  const text = String(value) as AnalyticsPartialReason
  if (!allowed.includes(text)) throw stateCorrupt(`${name} is not a reason this product has`)
  return text
}

/** And the only metric NAMES. A key nobody declared is corruption too. */
const ANALYTICS_METRIC_NAMES = new Set([
  'views', 'watch_minutes', 'avg_view_seconds', 'avg_view_percentage',
  'likes', 'comments', 'shares',
])

function decodePageCursors(raw: unknown): Record<string, PageCursor> {
  if (!isRecord(raw)) throw stateCorrupt('page_cursors is not an object')
  const out: Record<string, PageCursor> = {}
  for (const [key, value] of Object.entries(raw)) {
    // A key from a state file must never reach Object.prototype.
    if (RESERVED_KEYS.has(key) || !key || key.includes('/') || key.includes('\\')) {
      throw stateCorrupt(`page_cursors key ${key} is invalid`)
    }
    if (!isRecord(value)) throw stateCorrupt(`page_cursors.${key} is not an object`)
    exactKeys(value, ['channel_id', 'token', 'issued_at'])
    out[key] = {
      channel_id: identifier(value.channel_id, `page_cursors.${key}.channel_id`),
      // An empty token would resume "from the beginning" while reporting a
      // resume — a silent restart that never reaches `restarted_video_ids`.
      token: nonEmpty(value.token, `page_cursors.${key}.token`),
      issued_at: normalizeTimestamp(value.issued_at, `page_cursors.${key}.issued_at`),
    }
  }
  return out
}

/**
 * Decode the analytics cache, or drop it.
 *
 * The one field in this state that may be discarded rather than defended,
 * because it is the one field that can be rebuilt by asking YouTube again.
 */
/** An inclusive YYYY-MM-DD bound. A cache without one is not decodable. */
function windowDate(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw stateCorrupt(`${name} is not a calendar date`)
  return text
}

/**
 * Slugs already reported as having an unreadable cache.
 *
 * `decodeState` runs on every READ, so an unrepaired cache would log on every
 * page open - thousands of identical lines burying the one that matters. One
 * line per project while the cache stays broken.
 *
 * A successful decode REMOVES the slug, so a later, different failure on the
 * same project is heard. Without that the Set is a one-way latch and the second
 * fault is silent for the life of the process, which runs for days.
 */
const reportedUnreadableAnalytics = new Set<string>()

function droppableAnalytics(raw: unknown, projectSlug: string): { analytics?: AnalyticsCacheState } {
  try {
    const analytics = decodeAnalytics(raw)
    // Re-armed on success. Without this the Set is a one-way latch: after a
    // refetch repairs the cache, a SECOND and different failure on the same
    // project is silent forever - and this process lives for days.
    reportedUnreadableAnalytics.delete(projectSlug)
    return { analytics }
  } catch (error) {
    if (reportedUnreadableAnalytics.has(projectSlug)) return {}
    reportedUnreadableAnalytics.add(projectSlug)
    // Dropped, but never in silence. `decodeState` runs on the WRITE path too,
    // so a decoder bug here would persist an empty cache and then answer
    // "Fetched N" for numbers nobody can see - indistinguishable from
    // never-fetched, forever, with nothing anywhere to say why.
    logLine('warn', `[youtube-analytics] dropped an unreadable analytics cache: ${(error as Error)?.message || 'unknown'}`, {
      slug: projectSlug,
    })
    return {}
  }
}

function decodeAnalytics(raw: unknown): AnalyticsCacheState {
  if (!isRecord(raw)) throw stateCorrupt('analytics is not an object')
  // `unreached_video_ids` is OPTIONAL and ignored: caches written before it was
  // dropped still decode rather than being thrown away for carrying a field.
  exactKeys(raw,
    ['fetched_at', 'channel_id', 'partial', 'episodes', 'start_date', 'end_date'],
    ['partial_reason', 'unreached_video_ids'])
  if (!Array.isArray((raw as Record<string, unknown>).episodes)) {
    throw stateCorrupt('analytics.episodes is not an array')
  }
  return {
    fetched_at: normalizeTimestamp(raw.fetched_at, 'analytics.fetched_at'),
    channel_id: identifier(raw.channel_id, 'analytics.channel_id'),
    start_date: windowDate(raw.start_date, 'analytics.start_date'),
    end_date: windowDate(raw.end_date, 'analytics.end_date'),
    partial: raw.partial === true,
    ...(raw.partial_reason !== undefined
      ? { partial_reason: oneOfState(raw.partial_reason, ANALYTICS_PARTIAL_REASONS, 'analytics.partial_reason') }
      : {}),
    episodes: (raw.episodes as unknown[]).map((entry, i) => {
      if (!isRecord(entry)) throw stateCorrupt(`analytics.episodes[${i}] is not an object`)
      if (!isRecord(entry.metrics)) throw stateCorrupt(`analytics.episodes[${i}].metrics is not an object`)
      // Validated, not passed through. An unrecognised state is a CORRUPT
      // file, not a fifth state: the page's renderer falls back to "Not
      // fetched" for anything it does not know, so an unchecked value here
      // would surface as a plausible answer instead of an error.
      for (const [name, metric] of Object.entries(entry.metrics)) {
        const where = `analytics.episodes[${i}].metrics.${name}`
        if (!ANALYTICS_METRIC_NAMES.has(name)) throw stateCorrupt(`${where} is not a metric this product has`)
        if (!isRecord(metric)) throw stateCorrupt(`${where} is not an object`)
        if (!METRIC_STATES.has(String(metric.state))) throw stateCorrupt(`${where} has an unknown state`)
        // Exact keys per state, so a field nobody declared cannot ride along
        // and a required one cannot go missing. `not_fetched` carries no
        // timestamp because there is nothing to date; the other three must.
        if (metric.state === 'not_fetched') {
          exactKeys(metric, ['state'])
        } else if (metric.state === 'value') {
          exactKeys(metric, ['state', 'value', 'fetched_at'])
          if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
            throw stateCorrupt(`${where} claims a value but carries no number`)
          }
        } else if (metric.state === 'not_available') {
          exactKeys(metric, ['state', 'reason', 'fetched_at'])
          if (typeof metric.reason !== 'string' || !metric.reason.trim()) {
            throw stateCorrupt(`${where} is unavailable without a reason`)
          }
        } else {
          exactKeys(metric, ['state', 'fetched_at'])
        }
        if (metric.state !== 'not_fetched') {
          normalizeTimestamp(metric.fetched_at, `${where}.fetched_at`)
        }
      }
      // A cache written before this field was dropped still carries `title`;
      // there is no exactKeys on the episode entry, so it is simply ignored.
      return {
        video_id: identifier(entry.video_id, `analytics.episodes[${i}].video_id`),
        metrics: entry.metrics,
      }
    }),
  }
}

function decodeComments(raw: unknown): CommentCacheState {
  if (!isRecord(raw)) throw stateCorrupt('comments is not an object')
  exactKeys(raw,
    ['fetched_at', 'partial', 'unreached_video_ids', 'comments_disabled_video_ids', 'comments', 'receipts'],
    ['partial_reason', 'partially_read_video_ids'])
  for (const key of ['unreached_video_ids', 'comments_disabled_video_ids', 'comments', 'receipts']) {
    if (!Array.isArray((raw as Record<string, unknown>)[key])) throw stateCorrupt(`comments.${key} is not an array`)
  }
  return {
    fetched_at: normalizeTimestamp(raw.fetched_at, 'comments.fetched_at'),
    partial: raw.partial === true,
    ...(raw.partial_reason !== undefined ? { partial_reason: String(raw.partial_reason) } : {}),
    unreached_video_ids: (raw.unreached_video_ids as unknown[]).map((id, i) => identifier(id, `comments.unreached_video_ids[${i}]`)),
    ...(raw.partially_read_video_ids !== undefined
      ? {
        partially_read_video_ids: (raw.partially_read_video_ids as unknown[])
          .map((id, i) => identifier(id, `comments.partially_read_video_ids[${i}]`)),
      }
      : {}),
    comments_disabled_video_ids: (raw.comments_disabled_video_ids as unknown[]).map((id, i) => identifier(id, `comments.comments_disabled_video_ids[${i}]`)),
    comments: (raw.comments as unknown[]).map((entry, i) => {
      if (!isRecord(entry)) throw stateCorrupt(`comments.comments[${i}] is not an object`)
      return {
        comment_id: identifier(entry.comment_id, `comments.comments[${i}].comment_id`),
        video_id: String(entry.video_id ?? ''),
        author: String(entry.author ?? ''),
        text: String(entry.text ?? ''),
        published_at: String(entry.published_at ?? ''),
        moderation_status: String(entry.moderation_status ?? 'published'),
        channel_replied: entry.channel_replied === true,
        reply_count: Number(entry.reply_count ?? 0) || 0,
        // Additive: a cache written before these fields existed still decodes.
        // An absent `can_reply` reads as true rather than false - YouTube is
        // the authority on whether a reply is accepted, and defaulting to
        // false would silently disable replying on every older record.
        replies: (Array.isArray(entry.replies) ? entry.replies : []).map((reply, r) => {
          if (!isRecord(reply)) throw stateCorrupt(`comments.comments[${i}].replies[${r}] is not an object`)
          return {
            comment_id: identifier(reply.comment_id, `comments.comments[${i}].replies[${r}].comment_id`),
            author: String(reply.author ?? ''),
            text: String(reply.text ?? ''),
            from_channel: reply.from_channel === true,
          }
        }),
        can_reply: entry.can_reply !== false,
      }
    }),
    receipts: (raw.receipts as unknown[]).map((entry, i) => {
      if (!isRecord(entry)) throw stateCorrupt(`comments.receipts[${i}] is not an object`)
      return {
        receipt_id: identifier(entry.receipt_id, `comments.receipts[${i}].receipt_id`),
        comment_id: identifier(entry.comment_id, `comments.receipts[${i}].comment_id`),
        action: String(entry.action) as ModerationReceipt['action'],
        decided_at: normalizeTimestamp(entry.decided_at, `comments.receipts[${i}].decided_at`),
        outcome: String(entry.outcome) as ModerationReceipt['outcome'],
        ...(entry.error_code !== undefined ? { error_code: String(entry.error_code) } : {}),
      }
    }),
  }
}

function decodeReconcile(raw: unknown): ReconcileCacheState {
  if (!isRecord(raw)) throw stateCorrupt('reconcile is not an object')
  exactKeys(raw, ['channel_id', 'fetched_at', 'remote_videos', 'ignored_video_ids'], ['truncated'])
  if (!Array.isArray(raw.remote_videos)) throw stateCorrupt('reconcile.remote_videos is not an array')
  if (!Array.isArray(raw.ignored_video_ids)) throw stateCorrupt('reconcile.ignored_video_ids is not an array')
  return {
    channel_id: identifier(raw.channel_id, 'reconcile.channel_id'),
    fetched_at: normalizeTimestamp(raw.fetched_at, 'reconcile.fetched_at'),
    ...(raw.truncated !== undefined ? { truncated: raw.truncated === true } : {}),
    remote_videos: raw.remote_videos.map((entry, index) => {
      if (!isRecord(entry)) throw stateCorrupt(`reconcile.remote_videos[${index}] is not an object`)
      exactKeys(entry, ['video_id'], ['title', 'published_at'])
      return {
        video_id: identifier(entry.video_id, `reconcile.remote_videos[${index}].video_id`),
        ...(entry.title !== undefined ? { title: String(entry.title) } : {}),
        ...(entry.published_at !== undefined ? { published_at: String(entry.published_at) } : {}),
      }
    }),
    ignored_video_ids: raw.ignored_video_ids.map((id, index) => identifier(id, `reconcile.ignored_video_ids[${index}]`)),
  }
}

function decodeRemoteSync(raw: unknown): RemoteSyncState {
  if (!isRecord(raw)) throw stateCorrupt('remote_sync is not an object')
  exactKeys(raw, ['attempted_at', 'outcome', 'checked'], ['error_code'])
  if (typeof raw.outcome !== 'string' || !(REMOTE_SYNC_OUTCOMES as readonly string[]).includes(raw.outcome)) {
    throw stateCorrupt('remote_sync outcome is invalid')
  }
  if (raw.error_code !== undefined
    && (typeof raw.error_code !== 'string' || !(REMOTE_SYNC_ERROR_CODES as readonly string[]).includes(raw.error_code))) {
    throw stateCorrupt('remote_sync error_code is invalid')
  }
  return {
    attempted_at: normalizeTimestamp(raw.attempted_at, 'remote_sync.attempted_at'),
    outcome: raw.outcome as RemoteSyncOutcome,
    checked: finiteInteger(raw.checked, 'remote_sync.checked'),
    ...(raw.error_code !== undefined ? { error_code: raw.error_code as RemoteSyncState['error_code'] } : {}),
  }
}

function emptyState(projectSlug: string): YouTubeProjectPublishingStateV1 {
  return {
    schema_version: 1,
    revision: 0,
    project_slug: projectSlug,
    episode_video_links: {},
    reconciliation_history: [],
  }
}

async function readStateUnlocked(filePath: string, projectSlug: string): Promise<YouTubeProjectPublishingStateV1> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(filePath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyState(projectSlug)
    throw stateIo(error)
  }
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw stateCorrupt('invalid JSON')
  }
  return decodeState(raw, projectSlug)
}

async function writeStateUnlocked(filePath: string, state: YouTubeProjectPublishingStateV1): Promise<void> {
  await writeJsonAtomic(filePath, state, { mode: 0o600 })
}

function cloneState(state: YouTubeProjectPublishingStateV1): YouTubeProjectPublishingStateV1 {
  return structuredClone(state)
}



function normalizeProjectSlug(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || hasControlCharacters(value) || value.includes('/') || value.includes('\\') || RESERVED_KEYS.has(value) || value === '.' || value === '..') {
    throw new Error('YouTube project_slug is invalid')
  }
  return value
}

function normalizeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || hasControlCharacters(value) || value.includes('/') || value.includes('\\') || RESERVED_KEYS.has(value) || value === '.' || value === '..') {
    throw new Error(`YouTube ${name} is invalid`)
  }
  return value
}

function normalizeTimestamp(value: unknown, name: string): string {
  if (!isCalendarValidTimestamp(value)) {
    throw new Error(`YouTube ${name} is invalid`)
  }
  return value
}

function projectNotFound(projectSlug: string): Error {
  return Object.assign(new Error(`YouTube project '${projectSlug}' was not found`), {
    code: 'PROJECT_NOT_FOUND',
    statusCode: 404,
    expose: true,
  })
}

function projectMetadataCorrupt(projectSlug: string, detail: string): Error {
  return Object.assign(new Error(`YouTube project metadata for '${projectSlug}' is corrupt (${detail}). Refusing to derive publishing paths.`), {
    code: 'JSON_CORRUPT',
    statusCode: 409,
    expose: true,
  })
}

function metadataText(value: unknown, projectSlug: string, name: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || hasControlCharacters(value)) {
    throw projectMetadataCorrupt(projectSlug, `invalid ${name}`)
  }
  return value
}

function metadataPathSegment(value: unknown, projectSlug: string, name: string): string {
  const result = metadataText(value, projectSlug, name)
  if (result.includes('/') || result.includes('\\') || result.includes(':') || result === '.' || result === '..' || isReservedPathSegment(result)) {
    throw projectMetadataCorrupt(projectSlug, `invalid ${name} path segment`)
  }
  return result
}

function metadataRelativeTemplate(value: unknown, projectSlug: string): string {
  const result = metadataText(value, projectSlug, 'folder_template')
  if (path.isAbsolute(result) || /^[A-Za-z]:/.test(result) || result.includes('\\') || result.includes(':')) {
    throw projectMetadataCorrupt(projectSlug, 'invalid folder_template path')
  }
  const segments = result.split('/')
  const hasOnlyCanonicalSegments = segments.every((segment, index) => (
    (index === segments.length - 1 && segment === '')
      || (segment !== '' && segment !== '.' && segment !== '..' && !isReservedPathSegment(segment))
  ))
  if (!hasOnlyCanonicalSegments || segments.length === 1 && segments[0] === '') {
    throw projectMetadataCorrupt(projectSlug, 'invalid folder_template path')
  }
  return result
}

function assertProjectMetadata(value: unknown, projectSlug: string): void {
  if (!isRecord(value)) throw projectMetadataCorrupt(projectSlug, 'the JSON value is not an object')
  if (value.slug !== projectSlug) throw projectMetadataCorrupt(projectSlug, 'slug does not match the requested project')
  metadataPathSegment(value.slug, projectSlug, 'slug')
  metadataPathSegment(value.name, projectSlug, 'name')
  if (!isCalendarValidTimestamp(value.created_at)) throw projectMetadataCorrupt(projectSlug, 'created_at is not a calendar-valid timestamp')
  metadataPathSegment(value.episode_prefix, projectSlug, 'episode_prefix')
  metadataPathSegment(value.season_prefix, projectSlug, 'season_prefix')
  metadataRelativeTemplate(value.folder_template, projectSlug)
  if (typeof value.episode_digits !== 'number' || !Number.isSafeInteger(value.episode_digits) || value.episode_digits <= 0) {
    throw projectMetadataCorrupt(projectSlug, 'episode_digits is invalid')
  }
  if (typeof value.season_size !== 'number' || !Number.isSafeInteger(value.season_size) || value.season_size <= 0) {
    throw projectMetadataCorrupt(projectSlug, 'season_size is invalid')
  }
  if (!isRecord(value.subfolder_names)) throw projectMetadataCorrupt(projectSlug, 'subfolder_names is invalid')
  const names = value.subfolder_names
  const actualKeys = Object.keys(names)
  if (REQUIRED_SUBFOLDER_NAMES.some(key => !hasOwn(names, key))
    || actualKeys.some(key => !KNOWN_SUBFOLDER_NAMES.includes(key))) {
    throw projectMetadataCorrupt(projectSlug, 'subfolder_names is missing required keys or contains unknown keys')
  }
  for (const key of actualKeys) metadataPathSegment(names[key], projectSlug, `subfolder_names.${key}`)
}

async function readStrictProjectMetadata(projectDir: string, projectSlug: string): Promise<void> {
  const metadataPath = path.join(projectDir, 'project.json')
  let bytes: Buffer
  try {
    bytes = await fs.readFile(metadataPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw projectNotFound(projectSlug)
    throw projectMetadataCorrupt(projectSlug, 'project.json could not be read')
  }
  let metadata: unknown
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    metadata = JSON.parse(decoded)
  } catch {
    throw projectMetadataCorrupt(projectSlug, 'project.json is not valid UTF-8 JSON')
  }
  assertProjectMetadata(metadata, projectSlug)
}

async function resolveValidatedProject(projectSlug: string): Promise<{ project_slug: string; project_dir: string; state_path: string }> {
  const projectDirValue = getProjectDir(projectSlug)
  if (!projectDirValue || !path.isAbsolute(projectDirValue)) throw projectNotFound(projectSlug)
  const projectDir = path.resolve(projectDirValue)
  await readStrictProjectMetadata(projectDir, projectSlug)
  return {
    project_slug: projectSlug,
    project_dir: projectDir,
    state_path: path.join(projectDir, 'youtube', 'project-state.json'),
  }
}

function assertInputKeys(value: unknown, required: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('YouTube project publishing input is invalid')
  exactKeys(value, required)
}

async function currentAssignment(projectSlug: string, channelId: string) {
  const assignment = await getProjectYouTubeAssignment(projectSlug)
  if (!assignment) throw foundationError('YOUTUBE_CHANNEL_NOT_ASSIGNED', 'Assign a YouTube channel before continuing.')
  if (assignment.channel_id !== channelId) {
    throw foundationError('YOUTUBE_ASSIGNMENT_CHANGED', 'The project YouTube channel assignment changed; reload it and try again.')
  }
  return assignment
}



/**
 * The project's YouTube publishing state, parsed at most once per cache.
 *
 * MEASURED 2026-09-18, cold `/episodes` on the 302-episode project: 604 reads
 * of `youtube/project-state.json` — twice per episode. `readYouTubeRetentionStores`
 * asked for it directly, and `youtube-operation-store.resolveProject` asked
 * again while resolving each operation listing. One request, one answer.
 *
 * Only pass a cache on a READ path — the same reasoning as
 * `listYouTubeOperations`.
 */
export async function readYouTubeProjectPublishingState(
  project_slug: string,
  cache?: ProjectFactsCache,
): Promise<YouTubeProjectPublishingStateV1> {
  const projectSlug = normalizeProjectSlug(project_slug)
  const scoped = projectFactsFor(cache, projectSlug)
  const read = async (): Promise<YouTubeProjectPublishingStateV1> => {
    const project = await resolveValidatedProject(projectSlug)
    return withLock(project.state_path, async () => cloneState(await readStateUnlocked(project.state_path, projectSlug)))
  }
  if (!scoped) return read()
  scoped.publishingState ??= read()
  try {
    return await scoped.publishingState as YouTubeProjectPublishingStateV1
  } catch (error) {
    // A failed read must not be remembered as the answer for the rest of the
    // request: drop it so the next caller genuinely retries.
    scoped.publishingState = undefined
    throw error
  }
}



/** Preserve the old identity while allowing a deliberate new upload. */
export async function recordYouTubeVideoRemoval(input: {
  project_slug: string
  episode_code: string
  channel_id: string
  video_id: string
}): Promise<void> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const episodeCode = normalizeIdentifier(input.episode_code, 'episode_code')
  const channelId = normalizeIdentifier(input.channel_id, 'channel_id')
  const videoId = normalizeIdentifier(input.video_id, 'video_id')
  const project = await resolveValidatedProject(projectSlug)
  await withLock(project.state_path, async () => {
    const assignment = await getProjectYouTubeAssignment(projectSlug)
    if (assignment?.channel_id !== channelId) {
      throw foundationError('YOUTUBE_ASSIGNMENT_CHANGED', 'The YouTube channel changed. Review this episode again.')
    }
    const current = await readStateUnlocked(project.state_path, projectSlug)
    if (isYouTubeVideoRemoved(current, episodeCode, channelId, videoId)) return
    const next = cloneState(current)
    next.removed_videos = [...(current.removed_videos ?? []), {
      episode_code: episodeCode, channel_id: channelId, video_id: videoId,
      confirmed_at: new Date().toISOString(),
    }]
    next.revision = current.revision + 1
    await writeStateUnlocked(project.state_path, decodeState(next, projectSlug))
  })
}

export async function linkYouTubeEpisodeVideo(input: {
  project_slug: string
  episode_code: string
  channel_id: string
  video_id: string
  source: 'upload' | 'reconcile'
  decided_at: string
}): Promise<YouTubeProjectPublishingStateV1> {
  assertInputKeys(input, ['project_slug', 'episode_code', 'channel_id', 'video_id', 'source', 'decided_at'])
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const episodeCode = normalizeIdentifier(input.episode_code, 'episode_code')
  const channelId = normalizeIdentifier(input.channel_id, 'channel_id')
  const videoId = normalizeIdentifier(input.video_id, 'video_id')
  if (!VIDEO_LINK_SOURCES.includes(input.source)) throw new Error('YouTube episode video source is invalid')
  const decidedAt = normalizeTimestamp(input.decided_at, 'decided_at')
  const project = await resolveValidatedProject(projectSlug)

  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const existing = current.episode_video_links[episodeCode]
    if (existing && existing.channel_id === channelId && existing.video_id === videoId && existing.source === input.source) {
      return cloneState(current)
    }
    if (existing && !isYouTubeVideoRemoved(current, episodeCode, existing.channel_id, existing.video_id)) {
      const explicitDecision = input.source === 'reconcile' && current.reconciliation_history.some(decision => (
        decision.episode_code === episodeCode
        && decision.previous_video_id === existing.video_id
        && decision.next_video_id === videoId
        && !decision.rolled_back_at
      ))
      if (!explicitDecision) {
        throw foundationError('YOUTUBE_VIDEO_ID_CONFLICT', 'The episode already has a different immutable YouTube video link.')
      }
    }
    const next = cloneState(current)
    next.episode_video_links[episodeCode] = {
      channel_id: channelId,
      video_id: videoId,
      linked_at: decidedAt,
      source: input.source,
    }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return cloneState(decoded)
  })
}

/** Persist a provider-confirmed publication receipt on an existing remote link. */
export async function recordYouTubeEpisodePublication(input: {
  project_slug: string
  episode_code: string
  channel_id: string
  video_id: string
  verified_at: string
  privacy_status: string
  scheduled_for: string | null
}): Promise<YouTubeProjectPublishingStateV1> {
  assertInputKeys(input, ['project_slug', 'episode_code', 'channel_id', 'video_id', 'verified_at', 'privacy_status', 'scheduled_for'])
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const episodeCode = normalizeIdentifier(input.episode_code, 'episode_code')
  const channelId = normalizeIdentifier(input.channel_id, 'channel_id')
  const videoId = normalizeIdentifier(input.video_id, 'video_id')
  const verifiedAt = normalizeTimestamp(input.verified_at, 'verified_at')
  if (typeof input.privacy_status !== 'string' || !input.privacy_status) throw new Error('privacy_status is required')
  if (input.scheduled_for !== null && typeof input.scheduled_for !== 'string') throw new Error('scheduled_for must be an ISO time or null')
  const scheduledFor = input.scheduled_for === null ? null : normalizeTimestamp(input.scheduled_for, 'scheduled_for')
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const existing = current.episode_video_links[episodeCode]
    if (!existing || existing.channel_id !== channelId || existing.video_id !== videoId) {
      throw foundationError('YOUTUBE_VIDEO_ID_CONFLICT', 'The verified YouTube video no longer matches this episode link.')
    }
    const next = cloneState(current)
    next.episode_video_links[episodeCode] = {
      ...existing,
      publication: { verified_at: verifiedAt, privacy_status: input.privacy_status, scheduled_for: scheduledFor },
    }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return cloneState(decoded)
  })
}

/**
 * Record that a deliberate sync was attempted, and how it went.
 *
 * Written even when the attempt FAILED — that is the whole point. A screen has
 * to be able to say "we tried and could not reach YouTube" rather than showing
 * stale data as if it were current.
 */
export async function recordYouTubeRemoteSyncAttempt(input: {
  project_slug: string
  outcome: RemoteSyncOutcome
  checked: number
  error_code?: RemoteSyncState['error_code']
  attempted_at?: string
}): Promise<YouTubeProjectPublishingStateV1> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  if (!(REMOTE_SYNC_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new Error('YouTube remote sync outcome is invalid')
  }
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const next = cloneState(current)
    next.remote_sync = {
      attempted_at: input.attempted_at ?? new Date().toISOString(),
      outcome: input.outcome,
      checked: Math.max(0, Math.trunc(input.checked)),
      ...(input.error_code ? { error_code: input.error_code } : {}),
    }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return cloneState(decoded)
  })
}

/** Replace the cached uploads listing. The ignore list is preserved. */
export async function recordYouTubeReconcileCache(input: {
  project_slug: string
  channel_id: string
  remote_videos: ReconcileCacheState['remote_videos']
  /** True when the listing stopped before it had seen the whole channel. */
  truncated?: boolean
  fetched_at?: string
}): Promise<YouTubeProjectPublishingStateV1> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const next = cloneState(current)
    next.reconcile = {
      channel_id: normalizeIdentifier(input.channel_id, 'channel_id'),
      ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
      fetched_at: input.fetched_at ?? new Date().toISOString(),
      remote_videos: input.remote_videos.map(video => ({ ...video })),
      ignored_video_ids: current.reconcile?.ignored_video_ids ?? [],
    }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return cloneState(decoded)
  })
}

/** Set a video aside, or bring it back. Reversible by design. */
export async function setYouTubeReconcileIgnored(input: {
  project_slug: string
  video_id: string
  ignored: boolean
}): Promise<YouTubeProjectPublishingStateV1> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const videoId = normalizeIdentifier(input.video_id, 'video_id')
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const next = cloneState(current)
    const existing = current.reconcile
    if (!existing) throw new Error('Refresh the YouTube reconcile inventory before changing ignored videos.')
    const ignored = new Set(existing.ignored_video_ids)
    if (input.ignored) ignored.add(videoId)
    else ignored.delete(videoId)
    next.reconcile = { ...existing, ignored_video_ids: [...ignored].sort() }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return cloneState(decoded)
  })
}

/**
 * Append a reconcile decision. History is append-only and never rewritten:
 * `linkYouTubeEpisodeVideo` reads it to authorise replacing an existing link,
 * and a rollback stamps the entry rather than removing it.
 */
export async function recordYouTubeReconcileDecision(input: {
  project_slug: string
  episode_code: string
  previous_video_id: string | null
  next_video_id: string
}): Promise<ReconciliationDecision> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const episodeCode = normalizeIdentifier(input.episode_code, 'episode_code')
  const nextVideoId = normalizeIdentifier(input.next_video_id, 'next_video_id')
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const decision: ReconciliationDecision = {
      decision_id: `reconcile_${randomUUID()}`,
      episode_code: episodeCode,
      previous_video_id: input.previous_video_id,
      next_video_id: nextVideoId,
      decided_at: new Date().toISOString(),
    }
    const next = cloneState(current)
    next.reconciliation_history = [...current.reconciliation_history, decision]
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return decision
  })
}

/** Stamp a decision as rolled back. The entry itself is preserved. */
export async function rollbackYouTubeReconcileDecision(input: {
  project_slug: string
  decision_id: string
}): Promise<ReconciliationDecision | null> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const target = current.reconciliation_history.find(entry => entry.decision_id === input.decision_id)
    if (!target || target.rolled_back_at) return null

    // Only the decision that produced the CURRENT link may be undone.
    //
    // Otherwise undoing an older decision reaches past a newer one: D1 links
    // E to V1, D2 replaces it with V2, and rolling back D1 would delete V2 -
    // a link D1 never created and nobody asked to remove. A superseded
    // decision is undone by undoing what superseded it.
    const currentLink = current.episode_video_links[target.episode_code]
    if (currentLink?.video_id !== target.next_video_id) return null

    const next = cloneState(current)
    const rolledBackAt = new Date().toISOString()
    next.reconciliation_history = next.reconciliation_history.map(entry => (
      entry.decision_id === input.decision_id ? { ...entry, rolled_back_at: rolledBackAt } : entry
    ))
    // Restore what the link was before this decision. A decision that created
    // a link removes it; one that replaced a link puts the old one back, on the
    // same channel the link it is replacing was on - never a fabricated one.
    if (target.previous_video_id) {
      next.episode_video_links[target.episode_code] = {
        channel_id: currentLink.channel_id,
        video_id: target.previous_video_id,
        linked_at: rolledBackAt,
        source: 'reconcile',
      }
    } else {
      delete next.episode_video_links[target.episode_code]
    }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return { ...target, rolled_back_at: rolledBackAt }
  })
}

/** Replace the cached inbox. Receipts are never dropped by a refresh. */
/**
 * Replace the resume points for the surfaces this sweep touched.
 *
 * MERGED, not overwritten: a sweep that covered three of ten videos must not
 * erase the other seven's resume points, or those videos silently restart at
 * their newest batch on the next sweep - the exact bug the cursor exists to
 * fix, reintroduced by the writer instead of the reader.
 *
 * A video that finished sends no cursor and has its old one REMOVED, so
 * "finished" never resumes past the end.
 */
export async function recordYouTubePageCursors(input: {
  project_slug: string
  cursors: Record<string, PageCursor>
  /** Keys this sweep is authoritative for. Defaults to the ones it produced. */
  covered_keys?: string[]
}): Promise<void> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const project = await resolveValidatedProject(projectSlug)
  await withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const next = cloneState(current)
    const merged = { ...(current.page_cursors ?? {}) }
    for (const key of input.covered_keys ?? Object.keys(input.cursors)) delete merged[key]
    Object.assign(merged, input.cursors)
    next.page_cursors = merged
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
  })
}

/**
 * Merge a read's measurements into the cache, keyed by video id.
 *
 * A BLIND OVERWRITE here erased everything a failed read did not cover: one
 * Fetch that hit quota, a provider error, or a grant without the analytics
 * scope replaced ninety days of measurements with nothing - under a banner
 * reading "what you see below was fetched before the allowance ran out", with
 * nothing below. The scope path reaches it without a single provider call.
 *
 * So it merges, exactly as `recordYouTubePageCursors` merges resume points and
 * `recordYouTubeCommentCache` preserves receipts. Three stores in this file,
 * one rule: **a partial write keeps what it did not cover.**
 *
 * A read that measured nothing keeps the previous `fetched_at` and window too -
 * those describe the measurements, and the measurements are the old ones. Only
 * `partial`, `partial_reason` and `unreached_video_ids` take the new read's
 * word, because those describe the ATTEMPT, which is what just happened.
 */
export async function recordYouTubeAnalyticsCache(input: {
  project_slug: string
  analytics: AnalyticsCacheState
}): Promise<YouTubeProjectPublishingStateV1> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const next = cloneState(current)
    const incoming = input.analytics
    // A cache describing a DIFFERENT channel is not a base to merge onto: its
    // numbers belong to work this project no longer publishes.
    //
    // Nor is a cache from a different WINDOW. This state carries ONE window for
    // ALL its episodes, so merging measurements taken over different periods
    // labels the survivors with a window they were never measured in. The old
    // blind overwrite kept "one read, one window" implicitly; the merge dropped
    // that invariant, and the route asks for "last 90 days ending today" every
    // time, so the window moves daily. A read that measured NOTHING is the
    // exception: it changes no numbers, so there is nothing to mislabel.
    // Both sides always carry a window now, so this compares two real values
    // rather than two absences.
    const sameWindow = current.analytics?.start_date === incoming.start_date
      && current.analytics?.end_date === incoming.end_date
    const previous = current.analytics?.channel_id === incoming.channel_id
      && (incoming.episodes.length === 0 || sameWindow)
      ? current.analytics
      : undefined

    const merged = new Map((previous?.episodes ?? []).map(episode => [episode.video_id, episode]))
    for (const episode of incoming.episodes) merged.set(episode.video_id, episode)
    // A video this project no longer links is not its work. Kept, an
    // unlink-then-relink would resurface months-old numbers with no banner
    // saying how old they are.
    const linked = new Set(Object.values(current.episode_video_links).map(link => link.video_id))
    for (const videoId of [...merged.keys()]) {
      if (!linked.has(videoId)) merged.delete(videoId)
    }

    const measuredSomething = incoming.episodes.length > 0
    next.analytics = {
      ...incoming,
      // A read that measured nothing changed no numbers, so the timestamp and
      // window still describe the SURVIVING measurements, not this attempt.
      ...(measuredSomething || !previous
        ? {}
        : {
          fetched_at: previous.fetched_at,
          start_date: previous.start_date,
          end_date: previous.end_date,
        }),
      episodes: [...merged.values()],
    }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return cloneState(decoded)
  })
}

/**
 * The cached analytics, but ONLY if they describe the channel asked about.
 *
 * A cache is not cleared on reassignment, so serving it unconditionally would
 * show the previous channel's views, watch time and likes as this project's
 * own - numbers a creator would read as facts about their current work. A
 * different channel is a MISS, which the caller renders as `not_fetched`
 * rather than as zero.
 */
export function analyticsForChannel(
  state: YouTubeProjectPublishingStateV1,
  channelId: string | null,
): AnalyticsCacheState | null {
  const cached = state.analytics
  if (!cached || !channelId) return null
  return cached.channel_id === channelId ? cached : null
}

export async function recordYouTubeCommentCache(input: {
  project_slug: string
  inbox: Omit<CommentCacheState, 'receipts'>
}): Promise<YouTubeProjectPublishingStateV1> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const project = await resolveValidatedProject(projectSlug)
  return withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const next = cloneState(current)
    next.comments = { ...input.inbox, receipts: current.comments?.receipts ?? [] }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
    return cloneState(decoded)
  })
}

/**
 * Append a moderation receipt.
 *
 * Append-only: a rejected comment stops appearing in YouTube's normal
 * listings, so the receipt is the only remaining proof the action happened.
 */
/**
 * Append a receipt and, when the write actually landed, move the comment it
 * describes. Without the patch the receipt said "rejected" while the cached
 * comment still read `published`, so the list kept offering an action already
 * taken and the counts described a workload that no longer existed. One
 * function so all three write routes get it.
 */
export async function recordYouTubeModerationReceipt(input: {
  project_slug: string
  receipt: ModerationReceipt
  /** Applied to the receipt's own comment only, and only when it is given. */
  patch?: {
    moderation_status?: string
    channel_replied?: boolean
    /** The reply we just posted, so the thread shows it without a re-sweep. */
    append_reply?: { comment_id: string; author: string; text: string; from_channel: boolean }
  }
}): Promise<void> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const project = await resolveValidatedProject(projectSlug)
  await withLock(project.state_path, async () => {
    const current = await readStateUnlocked(project.state_path, projectSlug)
    const next = cloneState(current)
    const existing = current.comments ?? {
      fetched_at: new Date().toISOString(), partial: false,
      unreached_video_ids: [], comments_disabled_video_ids: [], comments: [], receipts: [],
    }
    const patch = input.patch
    next.comments = {
      ...existing,
      comments: patch
        ? existing.comments.map(comment => {
          if (comment.comment_id !== input.receipt.comment_id) return comment
          const { append_reply: appended, ...fields } = patch
          // Appended, not recounted: `reply_count` is YouTube's number, and the
          // reply we just posted is one more than it last reported.
          return {
            ...comment,
            ...fields,
            ...(appended
              ? {
                replies: [...comment.replies, appended],
                reply_count: comment.reply_count + 1,
              }
              : {}),
          }
        })
        : existing.comments,
      receipts: [...existing.receipts, input.receipt],
    }
    next.revision = current.revision + 1
    const decoded = decodeState(next, projectSlug)
    await writeStateUnlocked(project.state_path, decoded)
  })
}
