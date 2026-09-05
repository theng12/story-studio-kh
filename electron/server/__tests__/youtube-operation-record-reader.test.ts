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
