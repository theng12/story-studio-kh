import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  compareYouTubeVideo,
  type ComparedField,
} from '../services/youtube-metadata-comparison.js'
import type { YouTubeOperationRecordV1 } from '../services/youtube-operation-record-reader.js'

const NOW = Date.parse('2026-09-03T12:00:00.000Z')
const FETCHED = '2026-09-03T11:00:00.000Z'

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    fetched_at: FETCHED,
    title: 'Shared Title',
    description: 'Shared description',
    tags: ['alpha', 'beta'],
    privacy_status: 'public',
    scheduled_for: null,
    ...overrides,
  } as NonNullable<YouTubeOperationRecordV1['remote_snapshot']>
}

/** A record whose local intent matches `snapshot()` unless overridden. */
function record(input: {
  snippet?: Record<string, unknown>
  status?: Record<string, unknown>
  live?: Record<string, unknown> | null
  previous?: Record<string, unknown> | null
  drift?: Record<string, { state: string; decided_at?: string }>
} = {}): YouTubeOperationRecordV1 {
  const base: any = {
    schema_version: 1,
    revision: 3,
    operation_id: 'op-1',
    project_slug: 'demo',
    episode_code: 'EP0001',
    channel_id: 'UC-1',
    source_revision: 'src',
    metadata_revision: 'meta',
    created_at: FETCHED,
    updated_at: FETCHED,
    lifecycle: 'ready',
    video_id: 'video-1',
    accepted_at: FETCHED,
    final_payload: {
      snippet_json: JSON.stringify({
        title: 'Shared Title', description: 'Shared description', tags: ['alpha', 'beta'],
        ...input.snippet,
      }),
      status_json: JSON.stringify({ privacyStatus: 'public', ...input.status }),
      source_sha256: 'a'.repeat(64),
    },
    playlists: {},
    drift: input.drift ?? {},
    actions: [],
    origin: 'manual',
    final_action: 'manual_upload',
  }
  if (input.live !== null) base.remote_snapshot = snapshot(input.live ?? {})
  if (input.previous) base.previous_remote_snapshot = snapshot(input.previous)
  return base as YouTubeOperationRecordV1
}

function stateOf(result: ReturnType<typeof compareYouTubeVideo>, field: ComparedField): string {
  return result.fields.find(entry => entry.field === field)!.state
}

describe('three-way metadata comparison', () => {
  test('all three agreeing is in sync, and needs nobody', () => {
    const result = compareYouTubeVideo(record(), NOW)
    for (const field of result.fields) assert.equal(field.state, 'in_sync', field.field)
    assert.equal(result.needs_attention, false)
  })

  test('a video never read from YouTube is unknown, NOT in sync', () => {
    // The defect this guards: an absent snapshot rendering as agreement, so a
    // never-checked video looks identical to a verified one.
    const result = compareYouTubeVideo(record({ live: null }), NOW)
    for (const field of result.fields) assert.equal(field.state, 'unknown', field.field)
    assert.equal(result.live_fetched_at, null)
    assert.equal(result.needs_attention, false, 'unknown is not yet a problem to act on')
  })

  test('a local edit since the last look is Story Studio changed', () => {
    const result = compareYouTubeVideo(record({
      snippet: { title: 'Locally Retitled' },
      previous: {},
    }), NOW)
    assert.equal(stateOf(result, 'title'), 'story_studio_changed')
    assert.equal(stateOf(result, 'description'), 'in_sync')
    assert.equal(result.needs_attention, true)
  })

  test('a remote edit since the last look is YouTube changed', () => {
    const result = compareYouTubeVideo(record({
      live: { title: 'Edited In YouTube Studio' },
      previous: {},
    }), NOW)
    assert.equal(stateOf(result, 'title'), 'youtube_changed')
  })

  test('both moving is a conflict, not a silent winner', () => {
    const result = compareYouTubeVideo(record({
      snippet: { title: 'Local Title' },
      live: { title: 'Remote Title' },
      previous: {},
    }), NOW)
    assert.equal(stateOf(result, 'title'), 'conflict')
    assert.equal(result.needs_attention, true)
  })

  test('a kept-YouTube decision outranks the computation and carries its date', () => {
    const result = compareYouTubeVideo(record({
      snippet: { title: 'Local Title' },
      live: { title: 'Remote Title' },
      previous: {},
      drift: { title: { state: 'keep_youtube', decided_at: '2026-09-02T09:00:00.000Z' } },
    }), NOW)
    const title = result.fields.find(f => f.field === 'title')!
    assert.equal(title.state, 'keep_youtube')
    assert.equal(title.decided_at, '2026-09-02T09:00:00.000Z')
    assert.equal(result.needs_attention, false, 'an answered field is not outstanding')
  })

  test('a field YouTube did not report is unavailable, not a difference', () => {
    const result = compareYouTubeVideo(record({
      snippet: { description: 'We have one' },
      live: { description: '' },
      previous: {},
    }), NOW)
    assert.equal(stateOf(result, 'description'), 'unavailable')
  })

  test('a scheduled video going public on time is not drift', () => {
    // Private + future publishAt becoming public is YouTube doing what it was
    // asked. Calling it drift would make every scheduled upload look wrong the
    // moment it succeeded.
    const past = '2026-09-03T10:00:00.000Z'
    const result = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: past },
      live: { privacy_status: 'public', scheduled_for: null },
      previous: { privacy_status: 'private', scheduled_for: past },
    }), NOW)
    assert.equal(stateOf(result, 'privacy_status'), 'in_sync')
    assert.equal(stateOf(result, 'scheduled_for'), 'in_sync')
  })

  test('a schedule that has NOT come due yet still compares normally', () => {
    const future = '2026-09-04T10:00:00.000Z'
    const result = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: future },
      live: { privacy_status: 'public', scheduled_for: null },
      previous: { privacy_status: 'private', scheduled_for: future },
    }), NOW)
    assert.equal(stateOf(result, 'privacy_status'), 'youtube_changed', 'published early is a real difference')
  })

  test('tag order and whitespace are not treated as edits', () => {
    const result = compareYouTubeVideo(record({
      snippet: { tags: [' alpha ', 'beta'] },
      previous: {},
    }), NOW)
    assert.equal(stateOf(result, 'tags'), 'in_sync')
  })

  test('a first-sync disagreement is not blamed on Story Studio', () => {
    // With no previous snapshot there is no baseline, so movement is
    // unmeasurable and the old logic blamed us for every difference. But
    // `final_payload` is the immutable record of what was SENT and cannot
    // change afterwards, so a live value that differs from it changed on
    // YouTube's side. Telling an owner "you changed this" when they changed
    // nothing is the same defect as any other value meaning two things.
    const result = compareYouTubeVideo(record({ live: { title: 'Remote Title' } }), NOW)
    assert.equal(stateOf(result, 'title'), 'youtube_changed')
    assert.equal(stateOf(result, 'description'), 'in_sync', 'fields that agree still agree')
  })

  test('different tag sets are never flattened into agreement', () => {
    // ['a','b'] and ['a b'] both joined to "a b", so a genuinely different tag
    // set compared as in sync - drift hidden on the only array field.
    const result = compareYouTubeVideo(record({
      snippet: { tags: ['alpha', 'beta'] },
      live: { tags: ['alpha beta'] },
      previous: { tags: ['alpha beta'] },
    }), NOW)
    assert.equal(stateOf(result, 'tags'), 'story_studio_changed')

    const reordered = compareYouTubeVideo(record({
      snippet: { tags: ['alpha', 'beta'] },
      live: { tags: ['alpha', 'beta'] },
      previous: { tags: ['alpha', 'beta'] },
    }), NOW)
    assert.equal(stateOf(reordered, 'tags'), 'in_sync', 'the same tags still agree')
  })

  test('a cancelled schedule is not mistaken for a completed one', () => {
    // The schedule simply disappearing while the video stayed private means the
    // publish never happened. Exempting that as an expected transition hid it.
    const past = '2026-09-03T10:00:00.000Z'
    const result = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: past },
      live: { privacy_status: 'private', scheduled_for: null },
      previous: { privacy_status: 'private', scheduled_for: past },
    }), NOW)
    assert.notEqual(stateOf(result, 'scheduled_for'), 'in_sync', 'a publish that never happened is not in sync')
  })

  test('thumbnail equality is never claimed, only change since the last look', () => {
    const never = compareYouTubeVideo(record(), NOW)
    assert.equal(never.thumbnail_changed_since_last_sync, null, 'no evidence either way')

    const changed = compareYouTubeVideo(record({
      live: { thumbnail_etag: 'https://i.ytimg.test/new.jpg' },
      previous: { thumbnail_etag: 'https://i.ytimg.test/old.jpg' },
    }), NOW)
    assert.equal(changed.thumbnail_changed_since_last_sync, true)

    const same = compareYouTubeVideo(record({
      live: { thumbnail_etag: 'https://i.ytimg.test/same.jpg' },
      previous: { thumbnail_etag: 'https://i.ytimg.test/same.jpg' },
    }), NOW)
    assert.equal(same.thumbnail_changed_since_last_sync, false)
  })

  test('a field with no recorded intent never reads as Story Studio having changed it', () => {
    // An absent local value means "we have no intent recorded", not "our value
    // is empty and therefore differs". Treating the two the same turned every
    // remote edit on such a field into a false conflict.
    const noIntent = record({ snippet: { title: undefined }, previous: {} })
    const payload = JSON.parse((noIntent as any).final_payload.snippet_json)
    delete payload.title
    ;(noIntent as any).final_payload.snippet_json = JSON.stringify(payload)

    const quiet = compareYouTubeVideo(noIntent, NOW)
    assert.equal(stateOf(quiet, 'title'), 'unknown', 'nothing to compare, and YouTube has not moved')

    const moved = record({ snippet: { title: undefined }, live: { title: 'Edited In Studio' }, previous: {} })
    const movedPayload = JSON.parse((moved as any).final_payload.snippet_json)
    delete movedPayload.title
    ;(moved as any).final_payload.snippet_json = JSON.stringify(movedPayload)

    assert.equal(stateOf(compareYouTubeVideo(moved, NOW), 'title'), 'youtube_changed', 'a remote edit is still reportable')
  })

  test('a corrupt final payload degrades to unknown rather than throwing', () => {
    const broken = record({ previous: {} })
    ;(broken as any).final_payload = { snippet_json: '{not json', status_json: '{', source_sha256: 'a'.repeat(64) }
    const result = compareYouTubeVideo(broken, NOW)
    // Local intent is unreadable, so every field reads as YouTube having what
    // we cannot match - never as agreement.
    assert.equal(result.fields.every(field => field.local === null), true)
    assert.notEqual(stateOf(result, 'title'), 'in_sync')
  })

  test('the same schedule instant serialized differently is in sync (first observation)', () => {
    // Story Studio stores the owner's publish_at raw; YouTube echoes the same
    // instant without the fractional seconds. Comparing the raw strings would
    // report a change YouTube never made.
    const result = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
      live: { privacy_status: 'private', scheduled_for: '2031-01-02T03:04:05Z' },
    }), NOW)
    assert.equal(stateOf(result, 'scheduled_for'), 'in_sync')
    assert.equal(result.needs_attention, false)
  })

  test('the same schedule instant serialized differently is in sync with a prior snapshot', () => {
    const result = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
      live: { privacy_status: 'private', scheduled_for: '2031-01-02T03:04:05Z' },
      previous: { privacy_status: 'private', scheduled_for: '2031-01-02T03:04:05.000Z' },
    }), NOW)
    assert.equal(stateOf(result, 'scheduled_for'), 'in_sync')
    assert.equal(stateOf(result, 'privacy_status'), 'in_sync')
    assert.equal(result.needs_attention, false)
  })

  test('an offset spelling of the same schedule instant is in sync', () => {
    const result = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
      live: { privacy_status: 'private', scheduled_for: '2031-01-02T10:04:05+07:00' },
      previous: { privacy_status: 'private', scheduled_for: '2031-01-02T03:04:05.000Z' },
    }), NOW)
    assert.equal(stateOf(result, 'scheduled_for'), 'in_sync')
  })

  test('a genuinely different schedule instant is not in sync', () => {
    const firstLook = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
      live: { privacy_status: 'private', scheduled_for: '2031-01-02T04:04:05Z' },
    }), NOW)
    assert.equal(stateOf(firstLook, 'scheduled_for'), 'youtube_changed')

    const withPrior = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
      live: { privacy_status: 'private', scheduled_for: '2031-01-02T04:04:05Z' },
      previous: { privacy_status: 'private', scheduled_for: '2031-01-02T04:04:05Z' },
    }), NOW)
    assert.equal(stateOf(withPrior, 'scheduled_for'), 'story_studio_changed')
  })

  test('a malformed schedule value stays a visible difference, never in sync', () => {
    const versusValid = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
      live: { privacy_status: 'private', scheduled_for: 'not-a-date' },
      previous: { privacy_status: 'private', scheduled_for: 'not-a-date' },
    }), NOW)
    assert.notEqual(stateOf(versusValid, 'scheduled_for'), 'in_sync')

    const twoDistinctMalformed = compareYouTubeVideo(record({
      status: { privacyStatus: 'private', publishAt: 'not-a-date' },
      live: { privacy_status: 'private', scheduled_for: 'still-not-a-date' },
      previous: { privacy_status: 'private', scheduled_for: 'still-not-a-date' },
    }), NOW)
    assert.notEqual(stateOf(twoDistinctMalformed, 'scheduled_for'), 'in_sync',
      'a malformed value keeps its own spelling instead of collapsing into a blank')
  })

  test('only scheduled_for is canonicalized; other fields still compare exactly', () => {
    const result = compareYouTubeVideo(record({
      snippet: { title: 'Local Title' },
      status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
      live: { title: 'Remote Title', privacy_status: 'private', scheduled_for: '2031-01-02T03:04:05Z' },
      previous: { title: 'Remote Title', privacy_status: 'private', scheduled_for: '2031-01-02T03:04:05Z' },
    }), NOW)
    assert.equal(stateOf(result, 'scheduled_for'), 'in_sync', 'same instant, different spelling, agrees')
    assert.equal(stateOf(result, 'title'), 'story_studio_changed', 'a real title difference is still reported')
  })
})
