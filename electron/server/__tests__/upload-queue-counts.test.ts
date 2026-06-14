/**
 * queueStateCounts powers the Upload Queue "Quick views" badges
 * ("Ready to upload (12)"). Its state branches MUST mirror matchesFilter()
 * so the number next to a view equals what selecting it actually shows.
 *
 * queueStateCounts is pure, but importing routes/upload.js transitively loads
 * project-manager.js, which evaluates PROJECTS_ROOT at module-load time — so
 * we set STORY_STUDIO_DATA_DIR via useTempDataDir() BEFORE the dynamic import
 * (same guard the pipeline-step-skip test documents).
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let queueStateCounts: typeof import('../routes/upload.js').queueStateCounts

before(async () => {
  await useTempDataDir()
  const mod = await import('../routes/upload.js')
  queueStateCounts = mod.queueStateCounts
})

describe('queueStateCounts — mirrors the Show-chip state buckets', () => {
  test('classifies each row into exactly one bucket; deleted shadows uploaded', () => {
    const index = [
      { type: 'episode', deleted_at: null,         uploaded: false, has_local_final: true  }, // ready
      { type: 'episode', deleted_at: null,         uploaded: false, has_local_final: true  }, // ready
      { type: 'episode', deleted_at: null,         uploaded: true,  has_local_final: true  }, // uploaded_local
      { type: 'episode', deleted_at: null,         uploaded: true,  has_local_final: false }, // uploaded_freed
      { type: 'episode', deleted_at: '2026-01-01', uploaded: true,  has_local_final: false }, // deleted_upstream (shadows uploaded)
      { type: 'import',  deleted_at: null,         uploaded: false, has_local_final: false }, // imports
    ] as any[]

    const c = queueStateCounts(index)
    assert.equal(c.ready, 2, 'two not-uploaded-with-video rows')
    assert.equal(c.uploaded_local, 1)
    assert.equal(c.uploaded_freed, 1)
    assert.equal(c.deleted_upstream, 1, 'tombstone shadows the uploaded buckets')
    assert.equal(c.imports, 1)
    assert.equal(c.all, 6, 'all == total index length')
  })

  test('empty index is all-zero', () => {
    const c = queueStateCounts([])
    assert.deepEqual(c, { ready: 0, uploaded_local: 0, uploaded_freed: 0, deleted_upstream: 0, imports: 0, all: 0 })
  })
})
