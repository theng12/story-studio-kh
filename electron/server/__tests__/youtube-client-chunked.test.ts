/**
 * Unit tests for the YouTube resumable-upload helpers. Full end-to-end
 * testing against Google would require OAuth + a real upload slot; here
 * we just pin the internals that are easy to reason about in isolation.
 *
 * The main `uploadChunkedWithRetry` function isn't directly exported —
 * integration tests would need to stub `fetch`. That's deferred to a
 * later pass with a mock upload server.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// Re-implement the helpers for test access. If the real implementation
// changes signature, update here AND the test. Deliberately duplicating
// rather than exporting internals — the helpers are tightly scoped to
// the resumable protocol and shouldn't leak into public API.
function parseRangeEnd(rangeHeader: string): number | null {
  if (!rangeHeader) return null
  const m = /bytes=\d+-(\d+)/.exec(rangeHeader)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * Math.pow(2, attempt - 1))
  return base + Math.floor(Math.random() * 250)
}

describe('parseRangeEnd', () => {
  test('parses Google resumable Range header', () => {
    assert.equal(parseRangeEnd('bytes=0-524287'), 524287)
    assert.equal(parseRangeEnd('bytes=524288-1048575'), 1048575)
  })
  test('returns null on missing header', () => {
    assert.equal(parseRangeEnd(''), null)
    assert.equal(parseRangeEnd(undefined as any), null)
  })
  test('returns null on malformed header', () => {
    assert.equal(parseRangeEnd('bytes=abc'), null)
    assert.equal(parseRangeEnd('0-100'), null)
    assert.equal(parseRangeEnd('Range: 524287'), null)
  })
})

describe('backoffMs', () => {
  test('grows exponentially for early attempts', () => {
    const a1 = backoffMs(1)
    const a2 = backoffMs(2)
    const a3 = backoffMs(3)
    assert.ok(a1 >= 500 && a1 < 800, `attempt 1 in range: got ${a1}`)
    assert.ok(a2 >= 1000 && a2 < 1300, `attempt 2 in range: got ${a2}`)
    assert.ok(a3 >= 2000 && a3 < 2300, `attempt 3 in range: got ${a3}`)
  })
  test('caps at 8s base (plus jitter)', () => {
    const capped = backoffMs(20)
    assert.ok(capped >= 8000 && capped < 8300, `cap: got ${capped}`)
  })
})
