/**
 * The exact three-way comparison Library is built on (spec section 11).
 *
 * Three records, not two:
 *   1. what Story Studio intends   - the finalized `final_payload`
 *   2. what YouTube said LAST time - `previous_remote_snapshot`
 *   3. what YouTube says NOW       - `remote_snapshot`
 *
 * Two would not do. "YouTube changed this" is only knowable by comparing what
 * YouTube says now against what it said before; with a single snapshot every
 * sync overwrites the only evidence that it ever said anything else, and a
 * remote edit becomes indistinguishable from a local one.
 *
 * Pure on purpose: every state below is reachable in a test without a provider.
 */

import type { YouTubeOperationRecordV1 } from './youtube-operation-record-reader.js'
import { canonicalInstant } from '../lib/publish-instant.js'

/** The fields worth comparing. Thumbnails are handled separately - see below. */
export const COMPARED_FIELDS = ['title', 'description', 'tags', 'privacy_status', 'scheduled_for'] as const
export type ComparedField = typeof COMPARED_FIELDS[number]

export type FieldComparisonState =
  /** All three agree. */
  | 'in_sync'
  /** Story Studio's intent moved; YouTube still holds what we last saw. */
  | 'story_studio_changed'
  /** YouTube's value moved and ours did not. */
  | 'youtube_changed'
  /** Both moved, in different directions. Needs a person. */
  | 'conflict'
  /** The owner chose to keep YouTube's value for this field. */
  | 'keep_youtube'
  /** Never compared - no snapshot yet. NOT the same as agreeing. */
  | 'unknown'
  /** We have local intent but YouTube did not report this field. */
  | 'unavailable'

export interface FieldComparison {
  field: ComparedField
  state: FieldComparisonState
  local: string | null
  last_synced: string | null
  live: string | null
  decided_at?: string
}

export interface VideoComparison {
  operation_id: string
  episode_code: string
  video_id: string | null
  /** When the live column was read. Null when YouTube has never been read. */
  live_fetched_at: string | null
  fields: FieldComparison[]
  /** True when any field needs a person. */
  needs_attention: boolean
  /**
   * YouTube never returns the uploaded thumbnail bytes, so byte equality is
   * unprovable. The only honest claim is whether the remote thumbnail
   * reference has changed since we last saw it.
   */
  thumbnail_changed_since_last_sync: boolean | null
}

/** Normalize for comparison only - never for display or for writing. */
function normalize(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) {
    // Element-wise, not joined. Joining on a space made ['a','b'] and ['a b']
    // identical, so a genuinely different tag set compared as in sync - drift
    // hidden on the only array-valued field we compare.
    const entries = value.map(entry => String(entry).trim()).filter(entry => entry.length)
    return entries.length ? JSON.stringify(entries) : null
  }
  const text = String(value).trim()
  return text.length ? text : null
}

function localValues(record: YouTubeOperationRecordV1): Partial<Record<ComparedField, unknown>> {
  if (!record.final_payload) return {}
  let snippet: any = {}
  let status: any = {}
  try { snippet = JSON.parse(record.final_payload.snippet_json) } catch { snippet = {} }
  try { status = JSON.parse(record.final_payload.status_json) } catch { status = {} }
  const values: Partial<Record<ComparedField, unknown>> = {
    title: snippet.title,
    description: snippet.description,
    tags: snippet.tags,
    privacy_status: status.privacyStatus,
    scheduled_for: status.publishAt ?? null,
  }

  // A VERIFIED metadata update from this branch is newer intent than the
  // frozen upload payload, and Story Studio itself put it on YouTube. Leaving
  // `final_payload` as the only local column made the owner's own applied
  // title show up as "YouTube changed this" on the very screen they fixed it
  // from. The receipt is the honest newer answer, and it is only used when the
  // read-back actually matched what was sent — an unverified change says
  // nothing about what local intent now is.
  const applied = [...(record.metadata_updates ?? [])].reverse().find(receipt => receipt.verified)
  if (applied) {
    for (const field of applied.applied_fields) {
      if (field === 'title' || field === 'description' || field === 'tags') {
        values[field] = applied.after_snippet[field]
      }
    }
  }
  return values
}

function snapshotValues(
  snapshot: NonNullable<YouTubeOperationRecordV1['remote_snapshot']> | undefined,
): Record<ComparedField, unknown> | undefined {
  if (!snapshot) return undefined
  return {
    title: snapshot.title,
    description: snapshot.description,
    tags: snapshot.tags,
    privacy_status: snapshot.privacy_status,
    scheduled_for: snapshot.scheduled_for,
  }
}

/**
 * A private video with a future `publishAt` becoming public after that time is
 * YouTube doing exactly what it was asked. Reporting it as drift would make
 * every scheduled upload look wrong the moment it succeeded.
 */
function isExpectedScheduleTransition(
  field: ComparedField,
  local: Partial<Record<ComparedField, unknown>>,
  live: Record<ComparedField, unknown> | undefined,
  now: number,
): boolean {
  if (!live) return false
  const scheduledFor = normalize(local.scheduled_for)
  if (!scheduledFor) return false
  const due = Date.parse(scheduledFor)
  if (!Number.isFinite(due) || due > now) return false

  if (field === 'privacy_status') {
    return normalize(local.privacy_status) === 'private' && normalize(live.privacy_status) === 'public'
  }
  // Once it has published, YouTube drops the schedule. That is the transition
  // completing - but only if it actually went public. A schedule that simply
  // disappeared while the video stayed private is a cancelled publish, and
  // calling that "in sync" would hide it.
  if (field === 'scheduled_for') {
    return normalize(live.scheduled_for) === null && normalize(live.privacy_status) === 'public'
  }
  return false
}

const ATTENTION: ReadonlySet<FieldComparisonState> = new Set([
  'story_studio_changed', 'youtube_changed', 'conflict', 'unavailable',
])

export function compareYouTubeVideo(
  record: YouTubeOperationRecordV1,
  now: number = Date.now(),
): VideoComparison {
  const local = localValues(record)
  const live = snapshotValues(record.remote_snapshot)
  // With only one snapshot, "last time" and "now" are the same observation -
  // which correctly means YouTube has not been seen to change anything yet.
  const lastSynced = snapshotValues(record.previous_remote_snapshot) ?? live

  const fields: FieldComparison[] = COMPARED_FIELDS.map(field => {
    // `scheduled_for` is a date YouTube may spell differently for the same
    // instant (`...:05.000Z` vs `...:05Z`, or an offset), so canonicalize it
    // before comparing. Every other field is compared exactly. A value that
    // does not parse keeps its own spelling, so a malformed value stays a
    // visible difference instead of collapsing into a shared blank.
    const present = (source: Partial<Record<ComparedField, unknown>> | undefined): string | null => {
      if (!source) return null
      const normalized = normalize(source[field])
      return field === 'scheduled_for' ? canonicalInstant(normalized) : normalized
    }
    const localValue = present(local)
    const lastValue = present(lastSynced)
    const liveValue = present(live)

    const decision = record.drift[field]
    const base: FieldComparison = {
      field,
      state: 'unknown',
      local: localValue,
      last_synced: lastValue,
      live: liveValue,
      ...(decision?.decided_at ? { decided_at: decision.decided_at } : {}),
    }

    // A durable "keep YouTube" decision outranks the computation: the owner
    // has already answered this one.
    if (decision?.state === 'keep_youtube') return { ...base, state: 'keep_youtube' }

    // Never compared. An absent snapshot is not agreement.
    if (!live) return base
    if (isExpectedScheduleTransition(field, local, live, now)) return { ...base, state: 'in_sync' }

    // We intend something YouTube did not report at all.
    if (liveValue === null && localValue !== null) return { ...base, state: 'unavailable' }

    const youtubeMoved = liveValue !== lastValue

    // No recorded intent for this field is NOT "our value is empty, so we
    // changed it". We can still report whether YouTube moved; we simply have
    // nothing of our own to compare against.
    if (localValue === null) {
      if (youtubeMoved) return { ...base, state: 'youtube_changed' }
      // Both sides genuinely absent is agreement, not ignorance.
      if (liveValue === null) return { ...base, state: 'in_sync' }
      return { ...base, state: 'unknown' }
    }

    // FIRST OBSERVATION. With no previous snapshot there is no baseline to
    // measure movement against, so `youtubeMoved` is structurally false and
    // every disagreement would be blamed on Story Studio.
    //
    // It is not ours to blame. `final_payload` is the immutable record of what
    // was SENT at accept time and cannot change afterwards, so a live value
    // that differs from it changed on YouTube's side. Saying "you changed
    // this" to an owner who changed nothing is the same defect as any other
    // value standing for two facts.
    if (!record.previous_remote_snapshot) {
      return { ...base, state: localValue === liveValue ? 'in_sync' : 'youtube_changed' }
    }

    const storyStudioMoved = localValue !== lastValue
    // Agreement is agreement FIRST. When Story Studio's own metadata update
    // moved local intent and YouTube to the same value, both columns have
    // moved together — that is the change working, not a conflict. Reading it
    // as one would flag every video the owner just fixed, and flag it forever.
    if (localValue === liveValue) return { ...base, state: 'in_sync' }
    if (storyStudioMoved && youtubeMoved) return { ...base, state: 'conflict' }
    if (storyStudioMoved) return { ...base, state: 'story_studio_changed' }
    if (youtubeMoved) return { ...base, state: 'youtube_changed' }
    // Both false means local === last === live by transitivity, so there is no
    // remaining case: everything agrees.
    return { ...base, state: 'in_sync' }
  })

  const previousThumb = record.previous_remote_snapshot?.thumbnail_etag
  const liveThumb = record.remote_snapshot?.thumbnail_etag

  return {
    operation_id: record.operation_id,
    episode_code: record.episode_code,
    video_id: record.video_id ?? null,
    live_fetched_at: record.remote_snapshot?.fetched_at ?? null,
    fields,
    needs_attention: fields.some(field => ATTENTION.has(field.state)),
    // Only claimable once we have two observations to compare.
    thumbnail_changed_since_last_sync: previousThumb === undefined || liveThumb === undefined
      ? null
      : previousThumb !== liveThumb,
  }
}
