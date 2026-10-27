/**
 * Change ONLY the title, description and tags of a video that is ALREADY on
 * YouTube — no re-upload, no new video, nothing else touched.
 *
 * ── The hazard this module exists to avoid ──
 *
 * `videos.update` with `part=snippet` REPLACES the whole snippet. A caller that
 * sends only the fields it wants to change silently erases `categoryId`,
 * `defaultLanguage`, `defaultAudioLanguage` and any other snippet field YouTube
 * returned. A previous "Update metadata" rebuild did exactly that — it built a
 * snippet from local files and PATCHed it onto a live public video, erasing the
 * description and tags when no local metadata file existed (commit 716b4a0b
 * removed it). This module does the opposite:
 *
 *   1. Read the video FRESH (`videos.list part=snippet,status`).
 *   2. Build the update from THAT snippet, overlaying only the named fields.
 *   3. Send `videos.update part=snippet` ONLY — never `part=status`, so
 *      privacyStatus, publishAt, madeForKids, embeddable and license cannot be
 *      changed. Never upload media. Never change the video id.
 *   4. Read the video back and verify the change landed AND the status is
 *      byte-identical to the baseline read. The outcome is evidence, not a
 *      return value.
 *
 * Ownership is the caller's job (`assertYouTubeOperationAuthorized` on the
 * operation record); this module trusts the video id it is given and changes
 * only that video.
 */

import { createHash } from 'node:crypto'

import {
  listVideoSnippetStatus,
  updateVideoMetadata,
  type VideoBackfillView,
} from '../lib/youtube-client.js'
import { utf8Bytes, YOUTUBE_DESCRIPTION_MAX_BYTES_PUBLISHED } from '../lib/youtube-description-limit.js'
import { YT_TAGS_TOTAL_MAX, YT_TITLE_MAX } from '../lib/upload-metadata.js'

export type MetadataUpdateField = 'title' | 'description' | 'tags'

export interface MetadataUpdateFields {
  title?: string
  description?: string
  tags?: string[]
}

/** The snippet fields this operation reads, preserves and can change. */
export interface MetadataSnippetSnapshot {
  title: string
  description: string
  tags: string[]
  categoryId?: string
  defaultLanguage?: string
  defaultAudioLanguage?: string
}

/** Everything in `status` that must be byte-identical before and after. */
export interface MetadataStatusSnapshot {
  privacy_status: string
  publish_at: string | null
  contains_synthetic_media?: boolean
  self_declared_made_for_kids: boolean
  embeddable: boolean
  license: string
  public_stats_viewable: boolean
}

export interface MetadataUpdateOutcome {
  video_id: string
  /** False when the fresh read already matched every supplied field. */
  changed: boolean
  applied_fields: MetadataUpdateField[]
  /** True only when the after-read matched what was sent and the status did not move. */
  verified: boolean
  /** Plain sentences naming every mismatch. Empty when verified. */
  mismatches: string[]
  baseline_snippet_sha256: string
  baseline_snippet: MetadataSnippetSnapshot
  after_snippet: MetadataSnippetSnapshot
  baseline_status: MetadataStatusSnapshot
  after_status: MetadataStatusSnapshot
}

/**
 * A refusal or a provider failure this operation can name.
 *
 * `expose` and `code` let the route answer with a stable code and a plain
 * sentence; `statusCode` carries the HTTP status. It is deliberately NOT a
 * `YouTubeFoundationError`: these codes describe THIS operation, not the
 * foundation's connection/assignment contract.
 */
export class MetadataUpdateError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly expose = true
  readonly mismatches: string[]

  constructor(statusCode: number, code: string, detail: string, mismatches: string[] = [], cause?: unknown) {
    super(detail, cause === undefined ? undefined : { cause })
    this.name = 'MetadataUpdateError'
    this.statusCode = statusCode
    this.code = code
    this.mismatches = mismatches
  }
}

function limitRefusal(detail: string): never {
  throw new MetadataUpdateError(400, 'YOUTUBE_METADATA_LIMIT_EXCEEDED', detail)
}

/**
 * Refuse a value YouTube's own published limits forbid — BEFORE any provider
 * call. Never truncate: a title or description is the owner's text, and
 * silently cutting it is the defect, not the fix. Every message names the
 * figure and the length that broke it.
 */
export function assertMetadataFieldsWithinYouTubeLimits(fields: MetadataUpdateFields): void {
  if (fields.title !== undefined) {
    if (typeof fields.title !== 'string') limitRefusal('A YouTube title must be text.')
    const title = fields.title
    if (!title.trim()) limitRefusal('A YouTube title cannot be empty.')
    if (title.includes('<') || title.includes('>')) {
      limitRefusal('A YouTube title cannot contain the < or > characters.')
    }
    const length = [...title].length
    if (length > YT_TITLE_MAX) {
      limitRefusal(
        `A YouTube title can be at most ${YT_TITLE_MAX} characters; this one is ${length}. `
        + 'Shorten it — Story Studio did not truncate it for you.',
      )
    }
  }

  if (fields.description !== undefined) {
    if (typeof fields.description !== 'string') limitRefusal('A YouTube description must be text.')
    const bytes = utf8Bytes(fields.description)
    if (bytes > YOUTUBE_DESCRIPTION_MAX_BYTES_PUBLISHED) {
      limitRefusal(
        `A YouTube description can be at most ${YOUTUBE_DESCRIPTION_MAX_BYTES_PUBLISHED} bytes `
        + `(${YOUTUBE_DESCRIPTION_MAX_BYTES_PUBLISHED} UTF-8 bytes are what YouTube counts, so non-Latin text uses more). `
        + `This one is ${bytes} bytes. Shorten it — Story Studio did not truncate it for you.`,
      )
    }
  }

  if (fields.tags !== undefined) {
    if (!Array.isArray(fields.tags)) limitRefusal('YouTube tags must be a list of words.')
    let total = 0
    fields.tags.forEach((tag, index) => {
      if (typeof tag !== 'string') limitRefusal(`Tag ${index + 1} is not text.`)
      const value = tag.trim()
      if (!value) limitRefusal(`Tag ${index + 1} is empty. Remove it or give it a word.`)
      // YouTube's 500-character budget counts a separator between tags, and a
      // tag containing a space is quoted — the same conservative overhead the
      // upload's own tag cleaner reserves (`lib/upload-metadata.cleanTags`).
      total += [...value].length + (value.includes(' ') ? 4 : 2)
    })
    if (total > YT_TAGS_TOTAL_MAX) {
      limitRefusal(
        `YouTube allows at most ${YT_TAGS_TOTAL_MAX} characters across all tags including separators; `
        + `these total ${total}. Remove some tags — Story Studio did not drop any for you.`,
      )
    }
  }
}

export function metadataSnippetSnapshot(view: VideoBackfillView): MetadataSnippetSnapshot {
  return {
    title: view.title,
    description: view.description,
    tags: [...view.tags],
    categoryId: view.categoryId,
    ...(view.defaultLanguage !== undefined ? { defaultLanguage: view.defaultLanguage } : {}),
    ...(view.defaultAudioLanguage !== undefined ? { defaultAudioLanguage: view.defaultAudioLanguage } : {}),
  }
}

export function metadataStatusSnapshot(view: VideoBackfillView): MetadataStatusSnapshot {
  return {
    privacy_status: view.privacyStatus,
    publish_at: view.publishAt,
    ...(view.containsSyntheticMedia !== undefined
      ? { contains_synthetic_media: view.containsSyntheticMedia }
      : {}),
    self_declared_made_for_kids: view.selfDeclaredMadeForKids,
    embeddable: view.embeddable,
    license: view.license,
    public_stats_viewable: view.publicStatsViewable,
  }
}

/**
 * The stable identity of a snippet, so a caller can say which observation it
 * prepared a change against and the operation can refuse to overwrite a newer
 * one. Key order is fixed here, so the same values always hash the same.
 */
export function metadataSnippetHash(snapshot: MetadataSnippetSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    title: snapshot.title,
    description: snapshot.description,
    tags: snapshot.tags,
    categoryId: snapshot.categoryId ?? null,
    defaultLanguage: snapshot.defaultLanguage ?? null,
    defaultAudioLanguage: snapshot.defaultAudioLanguage ?? null,
  })).digest('hex')
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

async function readFreshView(slug: string, accountId: string, videoId: string): Promise<VideoBackfillView> {
  const views = await listVideoSnippetStatus(slug, accountId, [videoId])
  const view = views[videoId]
  if (!view) {
    throw new MetadataUpdateError(
      502,
      'YOUTUBE_METADATA_READ_FAILED',
      `YouTube did not return video ${videoId}. It may have been deleted, made private, or belong to another channel — nothing was changed.`,
    )
  }
  return view
}

function providerMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.trim() || 'no detail was returned'
}

/**
 * Apply a title/description/tags change to one existing video.
 *
 * Idempotent: when the fresh read already matches every supplied field, no
 * update request is made (`changed: false`), so a retry after success costs a
 * read and nothing else.
 */
export async function updateYouTubeVideoMetadata(input: {
  slug: string
  accountId: string
  videoId: string
  fields: MetadataUpdateFields
  /** Refuse when the fresh snippet is not the one the caller prepared against. */
  expected_baseline_hash?: string
}): Promise<MetadataUpdateOutcome> {
  const { slug, accountId, videoId, fields } = input
  assertMetadataFieldsWithinYouTubeLimits(fields)

  let baseline: VideoBackfillView
  try {
    baseline = await readFreshView(slug, accountId, videoId)
  } catch (error) {
    if (error instanceof MetadataUpdateError) throw error
    throw new MetadataUpdateError(
      502,
      'YOUTUBE_METADATA_READ_FAILED',
      `YouTube could not be asked for ${videoId}'s current details, so nothing was changed. ${providerMessage(error)}`,
      [],
      error,
    )
  }

  const baselineSnippet = metadataSnippetSnapshot(baseline)
  const baselineStatus = metadataStatusSnapshot(baseline)
  const baselineHash = metadataSnippetHash(baselineSnippet)

  if (input.expected_baseline_hash !== undefined
    && input.expected_baseline_hash.trim() !== baselineHash) {
    throw new MetadataUpdateError(
      409,
      'YOUTUBE_METADATA_BASELINE_STALE',
      `The video's details on YouTube are not the ones this change was prepared against `
      + `(expected ${input.expected_baseline_hash.slice(0, 12)}…, YouTube now reports ${baselineHash.slice(0, 12)}…). `
      + 'Nothing was changed. Read the video again and prepare the update from the current values.',
    )
  }

  // Only fields whose supplied value actually differs from the live one are
  // "applied". A retry that repeats the same values therefore sends nothing.
  const appliedFields: MetadataUpdateField[] = []
  if (fields.title !== undefined && fields.title !== baseline.title) appliedFields.push('title')
  if (fields.description !== undefined && fields.description !== baseline.description) appliedFields.push('description')
  if (fields.tags !== undefined && !sameTags(fields.tags, baseline.tags)) appliedFields.push('tags')

  if (!appliedFields.length) {
    return {
      video_id: videoId,
      changed: false,
      applied_fields: [],
      verified: true,
      mismatches: [],
      baseline_snippet_sha256: baselineHash,
      baseline_snippet: baselineSnippet,
      after_snippet: baselineSnippet,
      baseline_status: baselineStatus,
      after_status: baselineStatus,
    }
  }

  // The overlay names only the changed values. `updateVideoMetadata` fills
  // every other snippet field from the SAME fresh read this function just
  // made, so categoryId/defaultLanguage/defaultAudioLanguage are carried over
  // exactly as YouTube returned them, and the If-Match etag is that read's.
  const overlay: MetadataUpdateFields = {}
  if (appliedFields.includes('title')) overlay.title = fields.title
  if (appliedFields.includes('description')) overlay.description = fields.description
  if (appliedFields.includes('tags')) overlay.tags = fields.tags

  try {
    await updateVideoMetadata({ slug, accountId, videoId, snippet: overlay, baseline })
  } catch (error) {
    // The junk gate (`assertPublishableMetadata`) runs inside the client, and
    // its findings are about the TEXT, not about the provider. Reporting a
    // heading in the title as "YouTube refused" would send the owner to
    // reconnect a channel that is working perfectly.
    if (error instanceof Error && /not fit to publish/i.test(error.message)) {
      throw new MetadataUpdateError(400, 'YOUTUBE_METADATA_JUNK', error.message, [], error)
    }
    throw new MetadataUpdateError(
      502,
      'YOUTUBE_METADATA_UPDATE_FAILED',
      `YouTube refused or could not apply the change to ${videoId}. Nothing on Story Studio's side was changed. ${providerMessage(error)}`,
      [],
      error,
    )
  }

  let after: VideoBackfillView
  try {
    after = await readFreshView(slug, accountId, videoId)
  } catch (error) {
    throw new MetadataUpdateError(
      502,
      'YOUTUBE_METADATA_UNVERIFIED',
      `YouTube accepted the change to ${videoId}, but Story Studio could not read the video back to verify it. `
      + 'The change may already be live — reload the video (Sync) before trying again. '
      + providerMessage(error),
      [],
      error,
    )
  }

  const afterSnippet = metadataSnippetSnapshot(after)
  const afterStatus = metadataStatusSnapshot(after)
  const mismatches: string[] = []

  if (appliedFields.includes('title') && after.title !== fields.title) {
    mismatches.push(`the title YouTube now returns is "${after.title}", not the "${fields.title}" that was sent`)
  }
  if (appliedFields.includes('description') && after.description !== fields.description) {
    mismatches.push('the description YouTube now returns is not the one that was sent')
  }
  if (appliedFields.includes('tags') && !sameTags(after.tags, fields.tags ?? [])) {
    mismatches.push('the tags YouTube now returns are not the ones that were sent')
  }

  // Status must not have moved at all. `part=status` was never sent, so any
  // change here came from somewhere else — and the owner must be told.
  const statusKeys = Object.keys(baselineStatus) as Array<keyof MetadataStatusSnapshot>
  for (const key of statusKeys) {
    const before = JSON.stringify(baselineStatus[key])
    const now = JSON.stringify(afterStatus[key])
    if (before !== now) mismatches.push(`${key.replace(/_/g, ' ')} changed from ${before} to ${now}`)
  }

  return {
    video_id: videoId,
    changed: true,
    applied_fields: appliedFields,
    verified: mismatches.length === 0,
    mismatches,
    baseline_snippet_sha256: baselineHash,
    baseline_snippet: baselineSnippet,
    after_snippet: afterSnippet,
    baseline_status: baselineStatus,
    after_status: afterStatus,
  }
}
