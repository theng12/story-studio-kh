/**
 * The durable record of what an AUDIT READ of YouTube saw about a video.
 *
 * The all-videos audit (item D) is read-only, but it is not free: every
 * `videos.list` call costs quota from the channel's shared daily allowance.
 * Re-reading videos that have not changed since the last audit therefore wastes
 * the owner's quota and slows the next audit down.
 *
 * This ledger remembers each observation so the listing can skip a video whose
 * record is at least as new as Story Studio's own last metadata write to it.
 *
 * ── Shape: replace-by-id, not append-only ──
 *
 * One entry per video id per channel, holding the LATEST observation. An audit
 * asks "what does YouTube say now?", so replaying every historical observation
 * would grow without bound and answer a question nobody asked. The earlier
 * answer is not lost from YouTube's own side; if a caller needs history it can
 * compare two observations itself.
 *
 * ── Invalidation ──
 *
 * `story_written_at` is bumped when Story Studio updates this video's metadata
 * (`services/youtube-metadata-update`). An entry is CURRENT only when
 * `checked_at >= story_written_at`; a Story write makes the entry stale, so the
 * next audit re-reads exactly that video and no others. An empty
 * `story_written_at` means Story has never written it, so the observation is
 * the only word there is.
 *
 * A record that will not parse is dropped, not fatal: this is a rebuildable
 * cache, and a corrupt file must not stop an audit — it only causes re-reads.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { logLine } from './logger.js'
import { getProjectDir } from './project-manager.js'

export const VIDEO_AUDIT_FILENAME = path.join('youtube', 'video-audit.json')

export type VideoAuditFinding =
  /** YouTube would show a video with no description at all. */
  | 'empty_description'
  /** The description is over YouTube's 5,000-byte limit (bytes, not characters). */
  | 'description_over_limit_bytes'
  /** No tags at all — the video is harder to find. */
  | 'no_tags'
  | 'title_empty'
  | 'title_over_limit'
  | 'title_has_angle_brackets'

export interface VideoAuditEntry {
  video_id: string
  channel_id: string
  /** When YouTube answered about THIS video. */
  checked_at: string
  title: string
  /** Characters, matching how the title limit is measured. */
  description_length: number
  description_empty: boolean
  tag_count: number
  /**
   * The snippet's identity, from `metadataSnippetHash` — the SAME function the
   * metadata-update route compares `expected_baseline_hash` against. Send it
   * back unchanged and the precondition holds.
   *
   * Before 1.4.365 this was a hash over title+description+tags only, computed
   * here, so it could never equal what the update route wanted. Entries
   * carrying one are still readable; `snippet_sha256_algorithm` says which rule
   * produced it, and an entry without that label predates it.
   */
  snippet_sha256: string
  /** Which rule produced `snippet_sha256`. Absent = the pre-1.4.365 3-field hash. */
  snippet_sha256_algorithm?: string
  /**
   * The two fields the hash covers that a caller otherwise cannot see, echoed
   * exactly as YouTube returned them so the hash is checkable rather than
   * something to be trusted.
   */
  category_id?: string
  /** Absent when YouTube echoed no defaultLanguage — NOT the same as "none set". */
  default_language?: string
  /** Absent when YouTube echoed no defaultAudioLanguage — NOT "none set". */
  default_audio_language?: string
  privacy_status: string
  /** null = YouTube reported no schedule; absent is never used (we always write it). */
  publish_at: string | null
  findings: VideoAuditFinding[]
  episode_code?: string
  /** When Story Studio last wrote this video's metadata. A newer write makes the entry stale. */
  story_written_at?: string
  /**
   * The receipt of the last metadata update Story Studio applied to this video
   * (`metadata_updates[].receipt_id` on the operation record). Absent means no
   * receipt was recorded beside this observation.
   */
  story_receipt_id?: string
}

export interface VideoAuditLedger {
  schema_version: 1
  channels: Record<string, { videos: Record<string, VideoAuditEntry> }>
}

/** A fresh empty ledger. NEVER a shared constant: callers mutate what they read. */
function emptyLedger(): VideoAuditLedger {
  return { schema_version: 1, channels: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function ledgerPath(slug: string): string {
  const dir = getProjectDir(slug)
  if (!dir) throw new Error(`Unknown project: ${slug}`)
  return path.join(dir, VIDEO_AUDIT_FILENAME)
}

const FINDINGS: ReadonlySet<string> = new Set<VideoAuditFinding>([
  'empty_description', 'description_over_limit_bytes', 'no_tags', 'title_empty', 'title_over_limit', 'title_has_angle_brackets',
])

function decodeEntry(value: unknown, videoId: string, channelId: string): VideoAuditEntry | null {
  if (!isRecord(value)) return null
  const checkedAt = typeof value.checked_at === 'string' ? value.checked_at : ''
  if (!checkedAt) return null
  const title = typeof value.title === 'string' ? value.title : ''
  const findings = Array.isArray(value.findings)
    ? value.findings.filter((finding): finding is VideoAuditFinding =>
        typeof finding === 'string' && FINDINGS.has(finding))
    : []
  return {
    video_id: videoId,
    channel_id: channelId,
    checked_at: checkedAt,
    title,
    description_length: Number.isSafeInteger(value.description_length) ? value.description_length as number : 0,
    description_empty: value.description_empty === true,
    tag_count: Number.isSafeInteger(value.tag_count) ? value.tag_count as number : 0,
    snippet_sha256: typeof value.snippet_sha256 === 'string' ? value.snippet_sha256 : '',
    ...(typeof value.snippet_sha256_algorithm === 'string' && value.snippet_sha256_algorithm
      ? { snippet_sha256_algorithm: value.snippet_sha256_algorithm }
      : {}),
    ...(typeof value.category_id === 'string' && value.category_id ? { category_id: value.category_id } : {}),
    ...(typeof value.default_language === 'string' && value.default_language
      ? { default_language: value.default_language }
      : {}),
    ...(typeof value.default_audio_language === 'string' && value.default_audio_language
      ? { default_audio_language: value.default_audio_language }
      : {}),
    privacy_status: typeof value.privacy_status === 'string' ? value.privacy_status : '',
    publish_at: typeof value.publish_at === 'string' ? value.publish_at : null,
    findings,
    ...(typeof value.episode_code === 'string' && value.episode_code ? { episode_code: value.episode_code } : {}),
    ...(typeof value.story_written_at === 'string' && value.story_written_at
      ? { story_written_at: value.story_written_at }
      : {}),
    ...(typeof value.story_receipt_id === 'string' && value.story_receipt_id
      ? { story_receipt_id: value.story_receipt_id }
      : {}),
  }
}

/**
 * Decode a ledger document. `null` means "not a ledger at all" — a different
 * answer from an empty ledger, so the caller can say the file was unreadable
 * rather than pretend it held nothing.
 */
export function decodeVideoAuditLedger(raw: unknown): VideoAuditLedger | null {
  if (!isRecord(raw) || raw.schema_version !== 1 || !isRecord(raw.channels)) return null
  const channels: VideoAuditLedger['channels'] = {}
  for (const [channelId, channel] of Object.entries(raw.channels)) {
    if (!channelId || !isRecord(channel) || !isRecord(channel.videos)) continue
    const videos: Record<string, VideoAuditEntry> = {}
    for (const [videoId, entry] of Object.entries(channel.videos)) {
      const decoded = decodeEntry(entry, videoId, channelId)
      if (decoded) videos[videoId] = decoded
    }
    channels[channelId] = { videos }
  }
  return { schema_version: 1, channels }
}

/**
 * Parse the ledger file's text. `null` = unreadable. It is NEVER fatal: this is
 * a rebuildable cache, and a corrupt file must only cause re-reads — never stop
 * an audit or a metadata update.
 */
export function parseVideoAuditLedgerText(text: string): VideoAuditLedger | null {
  try {
    return decodeVideoAuditLedger(JSON.parse(text))
  } catch {
    return null
  }
}

async function readUnlocked(filePath: string): Promise<VideoAuditLedger> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger()
    throw error
  }
  const ledger = parseVideoAuditLedgerText(text)
  if (ledger) return ledger
  // Rebuildable: report it and read as empty (which only causes re-reads).
  logLine('warn', 'video audit ledger unreadable; treating as empty', { path: filePath })
  return emptyLedger()
}

export async function readVideoAuditLedger(projectSlug: string): Promise<VideoAuditLedger> {
  const filePath = ledgerPath(projectSlug)
  return withLock(filePath, () => readUnlocked(filePath))
}

/** One channel's observations, keyed by video id. */
export async function readChannelVideoAudit(
  projectSlug: string,
  channelId: string,
): Promise<Record<string, VideoAuditEntry>> {
  const ledger = await readVideoAuditLedger(projectSlug)
  return ledger.channels[channelId]?.videos ?? {}
}

/**
 * Replace (or create) the observation for each video in one channel.
 *
 * Replace-by-id: a newer observation overwrites the older one, except Story's
 * own write marker (`story_written_at`, `story_receipt_id`), which it carries
 * over. Another channel's entries and every video not named here are untouched.
 */
export async function recordVideoAuditEntries(input: {
  project_slug: string
  channel_id: string
  entries: VideoAuditEntry[]
}): Promise<void> {
  if (!input.channel_id) throw new Error('YouTube channel_id is required')
  if (!input.entries.length) return
  const filePath = ledgerPath(input.project_slug)
  await withLock(filePath, async () => {
    const ledger = await readUnlocked(filePath)
    const channel = ledger.channels[input.channel_id] ?? { videos: {} }
    for (const entry of input.entries) {
      if (!entry.video_id || !entry.checked_at) continue
      // A re-read replaces the observation, never Story's own write marker: it is
      // the only join from this entry to the receipt that proves what Story wrote.
      const prior = channel.videos[entry.video_id]
      channel.videos[entry.video_id] = {
        ...entry,
        ...(prior?.story_written_at ? { story_written_at: prior.story_written_at } : {}),
        ...(prior?.story_receipt_id ? { story_receipt_id: prior.story_receipt_id } : {}),
      }
    }
    ledger.channels[input.channel_id] = channel
    await writeJsonAtomic(filePath, ledger)
  })
}

/**
 * Mark that Story Studio itself wrote this video's metadata at `at`.
 *
 * The observation is KEPT — it still says what YouTube showed before the write
 * — but it is no longer current, so the next audit re-reads exactly this video.
 * A video with no observation is left alone: there is nothing to invalidate,
 * and the next audit reads it for the first time anyway.
 *
 * `receipt_id` is the `metadata_updates[].receipt_id` of the write that caused
 * this. Stored beside the marker so a reader can correlate the ledger's "Story
 * wrote here" with the operation record's evidence of what it wrote, without
 * matching on a timestamp that two writes could share.
 */
export async function noteStoryMetadataWrite(input: {
  project_slug: string
  channel_id: string
  video_id: string
  at: string
  receipt_id?: string
}): Promise<void> {
  const filePath = ledgerPath(input.project_slug)
  await withLock(filePath, async () => {
    const ledger = await readUnlocked(filePath)
    const entry = ledger.channels[input.channel_id]?.videos[input.video_id]
    if (!entry) return
    entry.story_written_at = input.at
    if (input.receipt_id) entry.story_receipt_id = input.receipt_id
    await writeJsonAtomic(filePath, ledger)
  })
}

/**
 * Is this observation still the channel's current word?
 *
 * Current when it was taken at or after Story Studio's own last metadata write
 * to the video. An observation taken BEFORE that write describes a video that
 * has since changed, so it must be re-read.
 *
 * An entry whose `snippet_sha256` came from an older, narrower rule is also NOT
 * current. Its title/description/tags are still true — but its hash is not the
 * value the update route compares against, so handing it out would guarantee a
 * phantom `YOUTUBE_METADATA_BASELINE_STALE`. This is a rebuildable cache, so
 * the honest repair is one re-read of exactly that video, after which the entry
 * carries the current rule and its label.
 */
export function videoAuditEntryIsCurrent(
  entry: VideoAuditEntry | undefined,
  currentAlgorithm: string,
): boolean {
  if (!entry?.checked_at) return false
  if (entry.snippet_sha256_algorithm !== currentAlgorithm) return false
  if (!entry.story_written_at) return true
  // Both are ISO-8601 UTC strings from `toISOString()`, so lexical order is
  // chronological order. Parsing would only add a way for a malformed value to
  // read as fresh.
  return entry.checked_at >= entry.story_written_at
}
