/**
 * What YouTube actually has scheduled for a channel.
 *
 * This is a READ-BACK, not a pacing policy: a project with no `upload_pacing`
 * key can still have a year of videos scheduled in YouTube Studio. Nothing here
 * writes config.json, and a missing local window never changes these words.
 *
 * Stored beside the project in `youtube/channel-schedule.json` so a build that
 * does not know this file still reads the project's other stores.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { YouTubeChannelScheduleView, YouTubeScheduledSlot } from '../contracts/publishing-overview.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { listRecentUploads, listVideoStatuses } from '../lib/youtube-client.js'
import { classifyYouTubeSyncFailure } from './youtube-publication-cache.js'
import { getProjectDir } from './project-manager.js'

/** The stored record also names its channel, so an assignment change cannot reuse an old answer. */
export type YouTubeChannelSchedule = YouTubeChannelScheduleView & { channel_id: string | null }

const NOT_READ: YouTubeChannelSchedule = {
  read_at: null,
  channel_id: null,
  state: 'no_data',
  scheduled_count: null,
  next_slot_at: null,
  freshness: 'unknown',
  scheduled_dates: [],
  error: 'Story Studio has not read this channel’s YouTube schedule yet.',
}

const FAILURE_WORDS: Record<string, string> = {
  quota_exhausted: 'YouTube’s daily quota is used up.',
  offline: 'YouTube could not be reached.',
  provider_error: 'YouTube did not answer the schedule read.',
}

/** Plain words for a failure code from the shared YouTube read path. */
export function scheduleFailureWord(error: unknown): string {
  const code = classifyYouTubeSyncFailure(error)
  return FAILURE_WORDS[code ?? ''] ?? FAILURE_WORDS.provider_error!
}

function schedulePath(slug: string): string {
  const dir = getProjectDir(slug)
  if (!dir) throw Object.assign(new Error(`Project ${slug} not found`), { statusCode: 404 })
  return path.join(dir, 'youtube', 'channel-schedule.json')
}

/** A read older than this is stale: a real number from days ago is not current. */
export const SCHEDULE_FRESHNESS_MS = 24 * 60 * 60 * 1000

export function scheduleFreshness(readAt: string | null, now = Date.now()): 'fresh' | 'stale' | 'unknown' {
  if (!readAt || !Number.isFinite(Date.parse(readAt))) return 'unknown'
  return now - Date.parse(readAt) <= SCHEDULE_FRESHNESS_MS ? 'fresh' : 'stale'
}

function decodeSlots(raw: unknown, readAt: string): YouTubeScheduledSlot[] {
  if (!Array.isArray(raw)) return []
  const slots: YouTubeScheduledSlot[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const value = item as Record<string, unknown>
    if (typeof value.video_id !== 'string' || typeof value.publish_at !== 'string'
      || !Number.isFinite(Date.parse(value.publish_at)) || typeof value.date !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) continue
    slots.push({
      date: value.date, video_id: value.video_id, publish_at: value.publish_at,
      read_at: typeof value.read_at === 'string' ? value.read_at : readAt,
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
    })
  }
  return slots
}

function decode(raw: unknown): YouTubeChannelSchedule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.schema_version !== 1) return null
  if (!['scheduled', 'no_data', 'unconfigured', 'read_failed'].includes(value.state as string)) return null
  if (value.read_at !== null && (typeof value.read_at !== 'string' || !Number.isFinite(Date.parse(value.read_at)))) return null
  if (value.channel_id !== null && typeof value.channel_id !== 'string') return null
  if (value.scheduled_count !== null && !Number.isSafeInteger(value.scheduled_count)) return null
  if (value.next_slot_at !== null && (typeof value.next_slot_at !== 'string' || !Number.isFinite(Date.parse(value.next_slot_at)))) return null
  const readAt = value.read_at as string | null
  return {
    read_at: readAt,
    channel_id: value.channel_id as string | null,
    state: value.state as YouTubeChannelSchedule['state'],
    scheduled_count: value.scheduled_count as number | null,
    next_slot_at: value.next_slot_at as string | null,
    freshness: scheduleFreshness(readAt),
    scheduled_dates: decodeSlots(value.scheduled_dates, readAt || ''),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

/** A missing or unreadable file is "not read", never "nothing scheduled". */
export async function readYouTubeChannelSchedule(slug: string, channelId?: string | null): Promise<YouTubeChannelSchedule> {
  const filePath = schedulePath(slug)
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return { ...NOT_READ }
    return { ...NOT_READ, error: 'The saved YouTube schedule could not be read.' }
  }
  const record = decode(raw)
  if (!record) return { ...NOT_READ, error: 'The saved YouTube schedule could not be read.' }
  if (channelId && record.channel_id && record.channel_id !== channelId) {
    return { ...NOT_READ, error: 'This saved schedule belongs to a different YouTube channel.' }
  }
  return record
}

export async function writeYouTubeChannelSchedule(slug: string, record: YouTubeChannelSchedule): Promise<void> {
  const filePath = schedulePath(slug)
  await withLock(filePath, () => writeJsonAtomic(filePath, { schema_version: 1, ...record }, { mode: 0o600 }))
}

/**
 * Build the row's answer from YouTube's own video statuses.
 *
 * `failure` is a plain reason, not a code: a failed or truncated read must say
 * "unknown" rather than counting the part we happened to see as the whole.
 */
export function buildYouTubeScheduleRecord(input: {
  channel_id: string
  read_at: string
  videos?: Record<string, { privacyStatus?: string; publishAt?: string | null }>
  titles?: Record<string, string>
  failure?: string | null
  now?: number
}): YouTubeChannelSchedule {
  const freshness = scheduleFreshness(input.read_at, input.now)
  if (input.failure) {
    return {
      read_at: input.read_at, channel_id: input.channel_id, state: 'read_failed',
      scheduled_count: null, next_slot_at: null, freshness, scheduled_dates: [], error: input.failure,
    }
  }
  const now = input.now ?? Date.now()
  const scheduled: YouTubeScheduledSlot[] = Object.entries(input.videos ?? {})
    .filter(([, video]) => video.privacyStatus === 'private' && typeof video.publishAt === 'string'
      && Number.isFinite(Date.parse(video.publishAt)))
    .map(([video_id, video]) => ({
      video_id,
      date: (video.publishAt as string).slice(0, 10),
      publish_at: video.publishAt as string,
      read_at: input.read_at,
      ...(input.titles?.[video_id] ? { title: input.titles[video_id]! } : {}),
    }))
    .sort((a, b) => a.publish_at.localeCompare(b.publish_at))
  const next = scheduled.map(slot => slot.publish_at).find(slot => Date.parse(slot) >= now) ?? null
  return {
    read_at: input.read_at,
    channel_id: input.channel_id,
    state: scheduled.length ? 'scheduled' : 'unconfigured',
    scheduled_count: scheduled.length,
    next_slot_at: next,
    freshness,
    scheduled_dates: scheduled,
  }
}

/**
 * The one provider read behind this store: the channel's own uploads playlist,
 * then `videos.list` for status.publishAt. Bounded to four playlist pages; the
 * client's existing auth-retry and quota preflight do the rest.
 */
export async function refreshYouTubeChannelSchedule(input: {
  project_slug: string
  account_id: string
  channel_id: string
  max_pages?: number
}): Promise<YouTubeChannelSchedule> {
  const readAt = new Date().toISOString()
  const save = (record: YouTubeChannelSchedule) => writeYouTubeChannelSchedule(input.project_slug, record)
  try {
    const uploads = await listRecentUploads(input.project_slug, input.account_id, { maxPages: input.max_pages ?? 4 })
    if (uploads.truncated) {
      const record = buildYouTubeScheduleRecord({
        channel_id: input.channel_id, read_at: readAt,
        failure: 'the channel listing stopped before the end, so the schedule is incomplete',
      })
      await save(record)
      return record
    }
    const titles = Object.fromEntries(uploads.videos
      .filter(video => video.videoId && video.title)
      .map(video => [video.videoId, video.title]))
    const statuses = await listVideoStatuses(input.project_slug, input.account_id, uploads.videos.map(video => video.videoId))
    const record = buildYouTubeScheduleRecord({ channel_id: input.channel_id, read_at: readAt, videos: statuses, titles })
    await save(record)
    return record
  } catch (error) {
    const record = buildYouTubeScheduleRecord({
      channel_id: input.channel_id, read_at: readAt, failure: scheduleFailureWord(error),
    })
    await save(record)
    return record
  }
}
