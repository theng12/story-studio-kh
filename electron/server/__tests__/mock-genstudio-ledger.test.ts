/**
 * Row `20261122-31x` — the mock provider names its own stray request.
 *
 * One gate run failed `service.requests.length === 0` while the job was correctly held and the
 * submissions were unchanged. 26 equivalent runs never reproduced it, and the request could not be
 * captured because the fixture kept requests in memory and `reset()` wiped them before the assert.
 *
 * What is pinned here: the fixture's `requests` array still behaves exactly as before (the wipe is
 * unchanged, so no other test changes meaning), and a second ledger — never wiped — lets an
 * assertion read what arrived after a `mark()`, with its method and path, and leaves it on disk
 * when `MOCK_GENSTUDIO_EVIDENCE_DIR` is set.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

const evidenceDir = mkdtempSync(join(tmpdir(), 'mock-genstudio-evidence-'))
let service: MockGenStudioService

before(async () => {
  process.env.MOCK_GENSTUDIO_EVIDENCE_DIR = evidenceDir
  service = await startMockGenStudioService()
})

after(async () => {
  await service.close()
  delete process.env.MOCK_GENSTUDIO_EVIDENCE_DIR
  rmSync(evidenceDir, { recursive: true, force: true })
})

function get(path: string): Promise<Response> {
  return fetch(`${service.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}` },
  })
}

describe('the mock Gateway names a stray request', () => {
  test('a request after the wipe is still readable, with its method and path', async () => {
    await get('/v1/models')
    service.reset()
    assert.equal(service.requests.length, 0, 'the wipe itself is unchanged')

    const mark = service.mark()
    await get('/v1/voices')

    const since = service.requestsSince(mark)
    assert.deepEqual(since.map(row => `${row.method} ${row.path}`), ['GET /v1/voices'])
    assert.match(since[0].at, /^\d{4}-\d{2}-\d{2}T/)
    // Requests recorded before the marker are not attributed to it.
    assert.deepEqual(service.requestsSince(0).map(row => `${row.method} ${row.path}`), ['GET /v1/models', 'GET /v1/voices'])
  })

  test('it is written to the evidence directory, so it outlives the test process', async () => {
    const log = join(evidenceDir, 'requests.log')
    assert.ok(existsSync(log), 'requests.log is written when MOCK_GENSTUDIO_EVIDENCE_DIR is set')
    assert.match(readFileSync(log, 'utf8'), /GET \/v1\/voices\n/)
  })
})
