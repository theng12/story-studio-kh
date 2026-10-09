import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let reader: typeof import('../services/youtube-operation-record-reader.js')
let cleanup: (() => Promise<void>) | undefined
let tempDir = ''

const NOW = '2026-09-01T12:00:00.000Z'

beforeEach(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  reader = await import('../services/youtube-operation-record-reader.js')
})
afterEach(async () => { await cleanup?.(); cleanup = undefined })

function record(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    revision: 1,
    operation_id: 'operation-1',
    project_slug: 'project-1',
    episode_code: 'EP0001',
    channel_id: 'channel-1',
    source_revision: 'source-1',
    metadata_revision: 'metadata-1',
    created_at: NOW,
    updated_at: NOW,
    lifecycle: 'preparing',
    playlists: {},
    drift: {},
    actions: [{ action_id: 'action-1', action: 'manual_upload', classification: 'whole_upload', state: 'started', occurred_at: NOW }],
    origin: 'manual',
    final_action: 'manual_upload',
    ...overrides,
  }
}

describe('YouTube operation record reader', () => {
  test('decodes only the two shipped manual upload actions', () => {
    assert.equal(reader.decodeYouTubeOperationRecord(record()).final_action, 'manual_upload')
    assert.equal(reader.decodeYouTubeOperationRecord(record({ final_action: 'private_upload' })).final_action, 'private_upload')
    for (const invalid of [
      { origin: 'automatic_scheduled' },
      { final_action: 'render_only' },
      { final_action: 'scheduled_upload' },
      { import_provenance: { source_path: 'old.json', source_sha256: 'x', importer_schema_version: 1 } },
      { caption: { state: 'synced' } },
      { analytics_freshness: { fetched_at: NOW, period_start: NOW, period_end: NOW } },
    ]) assert.throws(() => reader.decodeYouTubeOperationRecord(record(invalid)), (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_OPERATION_RECORD_CORRUPT')
  })

  test('requires accepted identity and preserves strict action vocabulary', () => {
    assert.throws(() => reader.decodeYouTubeOperationRecord(record({ lifecycle: 'accepted' })), /accepted video identity/i)
    assert.throws(() => reader.decodeYouTubeOperationRecord(record({
      actions: [{ action_id: 'action-2', action: 'caption_sync', classification: 'independent_post_accept', state: 'started', occurred_at: NOW }],
    })), /action.*classification|corrupt/i)
  })

  // Regression: TN0162–TN0173 on the mini (1.4.266). The description Story
  // uploads, and YouTube returns, is a 707-character string with 13 line
  // feeds. The snapshot decoder treated `\n` as a control character, so every
  // status write was refused with "invalid remote_snapshot.description".
  // This fixture has the same shape (multiline, no CR, not untrimmed) with
  // invented text.
  const MINI_SHAPE_DESCRIPTION = [
    'A slow walk through a rain-soaked forest at dusk.',
    '',
    'Chapters',
    '00:00 Arrival',
    '12:30 The old bridge',
    '25:00 Lanterns',
    '',
    'Narrated for sleep. No music after the first minute.',
    '',
    '#sleepstory #bedtime',
    '',
    'Sound: rain, distant thunder.',
    'Made with care.',
    'Sleep well.',
  ].join('\n')

  function accepted(snapshot: Record<string, unknown>) {
    return record({
      lifecycle: 'accepted', video_id: 'video-1', accepted_at: NOW,
      remote_snapshot: {
        fetched_at: NOW, title: 'Title', description: 'D', tags: [], privacy_status: 'private', scheduled_for: '2026-12-01T15:00:00Z',
        ...snapshot,
      },
    })
  }
  const isCorrupt = (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_OPERATION_RECORD_CORRUPT'

  test('accepts the multiline description YouTube returns for a real upload (mini regression shape)', () => {
    assert.equal(MINI_SHAPE_DESCRIPTION.split('\n').length - 1, 13)
    const decoded = reader.decodeYouTubeOperationRecord(accepted({ description: MINI_SHAPE_DESCRIPTION }))
    assert.equal(decoded.remote_snapshot?.description, MINI_SHAPE_DESCRIPTION)
    // The previous snapshot goes through the same decoder.
    const kept = reader.decodeYouTubeOperationRecord({
      ...accepted({ description: MINI_SHAPE_DESCRIPTION }),
      previous_remote_snapshot: { fetched_at: NOW, title: 'T', description: `Old\n${MINI_SHAPE_DESCRIPTION}\n`, tags: [], privacy_status: 'private', scheduled_for: null },
    })
    assert.equal(kept.previous_remote_snapshot?.description, `Old\n${MINI_SHAPE_DESCRIPTION}\n`)
  })

  test('description text keeps empty, Unicode, tabs, CRLF and edge whitespace exactly as YouTube said it', () => {
    for (const description of [
      '',
      'ដំណេកស្ងប់ 🌙\nសូមរាត្រីសួស្តី',
      'Line one\r\nLine two',
      'Col\tumn',
      '\nstarts with a break',
      'ends with a break\n',
    ]) {
      assert.equal(reader.decodeYouTubeOperationRecord(accepted({ description })).remote_snapshot?.description, description)
    }
  })

  test('still refuses a description that is missing, not text, or carries other control characters', () => {
    const withoutDescription = { fetched_at: NOW, title: 'Title', tags: [], privacy_status: 'private', scheduled_for: null }
    assert.throws(() => reader.decodeYouTubeOperationRecord(record({
      lifecycle: 'accepted', video_id: 'video-1', accepted_at: NOW, remote_snapshot: withoutDescription,
    })), isCorrupt)
    for (const description of [null, 42, ['a'], { text: 'a' }, true, 'nul\u0000', 'bell\u0007', 'vt\u000b', 'del\u007f', 'c1\u0085']) {
      assert.throws(() => reader.decodeYouTubeOperationRecord(accepted({ description })), isCorrupt, JSON.stringify(description))
    }
    // Single-line fields stay single-line.
    assert.throws(() => reader.decodeYouTubeOperationRecord(accepted({ title: 'two\nlines' })), isCorrupt)
    assert.throws(() => reader.decodeYouTubeOperationRecord(accepted({ tags: ['a\nb'] })), isCorrupt)
  })

  test('a multiline description survives save and reload byte for byte', async () => {
    const file = reader.youtubeOperationRecordPath(tempDir, 'operation-1')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const original = accepted({ description: `${MINI_SHAPE_DESCRIPTION}\r\nដំណេកស្ងប់ 🌙` })
    await fs.writeFile(file, JSON.stringify(original, null, 2))
    const loaded = await reader.readYouTubeOperationRecord({ project_dir: tempDir, operation_id: 'operation-1' })
    assert.deepEqual(loaded, reader.decodeYouTubeOperationRecord(original))
    assert.equal(loaded?.remote_snapshot?.description, `${MINI_SHAPE_DESCRIPTION}\r\nដំណេកស្ងប់ 🌙`)
  })

  test('refuses traversal operation ids before reading and preserves corrupt bytes', async () => {
    assert.throws(() => reader.youtubeOperationRecordPath(tempDir, '../escape'), /invalid/i)
    const file = reader.youtubeOperationRecordPath(tempDir, 'operation-1')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const bytes = Buffer.from('{"schema_version":1,"broken":')
    await fs.writeFile(file, bytes)
    await assert.rejects(() => reader.readYouTubeOperationRecord({ project_dir: tempDir, operation_id: 'operation-1' }), /corrupt/i)
    assert.deepEqual(await fs.readFile(file), bytes)
  })
})
