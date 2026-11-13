/**
 * Tests for humanizeBackendError's domain-code passthrough.
 *
 * Frontend code matches stable error codes (e.g. `NARRATION_MISSING`)
 * to take soft-fail paths instead of showing a red banner. The
 * mechanism: an error class with `expose: true` and `code: '<STABLE>'`
 * gets that code copied into the response under `code`. Plain Node
 * errnos (ENOENT, EACCES…) and codes WITHOUT `expose` are folded into
 * the existing detail/hint messages and not exposed to the frontend.
 */

import { after, before, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ContentPackMissingError } from '../content-packs/project-pins.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { useTempDataDir } from './_helpers.js'

describe('humanizeBackendError — domain code passthrough', () => {
  // humanizeBackendError logs every call via services/logger.ts. No isolation
  // is needed for these tests' own assertions, but the incidental log write
  // still needs a claimed temp dir — see lib/test-isolation.ts.
  let tmp: { dir: string; cleanup: () => Promise<void> }
  before(async () => { tmp = await useTempDataDir() })
  after(async () => { await tmp.cleanup() })

  test('forwards `code` when error has expose: true + string code', () => {
    class MyError extends Error {
      readonly code = 'NARRATION_MISSING' as const
      readonly expose = true
    }
    const out = humanizeBackendError(new MyError('Could not find AT0001_Script_Narration.docx.'))
    assert.equal(out.code, 'NARRATION_MISSING')
    assert.match(out.detail, /Could not find/)
  })

  test('does NOT forward code when expose is missing/false', () => {
    const e = Object.assign(new Error('boom'), { code: 'SOMETHING' })
    const out = humanizeBackendError(e)
    assert.equal(out.code, undefined, 'opting out is the default')
    assert.match(out.detail, /boom/)
  })

  test('does NOT forward Node errnos even though they have a string code', () => {
    // ENOENT is handled by the friendlier branch; the user sees
    // "File not found at <path>", and the response has no `code` field
    // (we want the friendly hint, not the raw errno).
    const e = Object.assign(new Error("ENOENT: no such file or directory, open '/foo'"), {
      code: 'ENOENT',
      path: '/foo',
    })
    const out = humanizeBackendError(e)
    assert.equal(out.code, undefined)
    assert.match(out.detail, /File not found/)
  })

  test('forwards code on the empty-message branch', () => {
    const e = Object.assign(new Error(), { code: 'EMPTY_BODY', expose: true })
    const out = humanizeBackendError(e, 'fallback msg')
    assert.equal(out.code, 'EMPTY_BODY')
  })

  test('non-string code is ignored', () => {
    const e = Object.assign(new Error('hi'), { code: 42, expose: true })
    const out = humanizeBackendError(e)
    assert.equal(out.code, undefined)
  })

  test('forwards bounded exact Content Pack requirements as structured recovery data', () => {
    const out = humanizeBackendError(new ContentPackMissingError([{
      pack_id: 'com.storystudio.history',
      version: '1.2.3',
      item_ids: ['com.storystudio.history.formula'],
      item_kinds: ['series-formula'],
    }]))
    assert.equal(out.code, 'content-pack-missing')
    assert.deepEqual(out.requirements, [{
      pack_id: 'com.storystudio.history',
      version: '1.2.3',
      item_ids: ['com.storystudio.history.formula'],
      item_kinds: ['series-formula'],
    }])
  })
})

describe('humanizeBackendError — unreachable gateway', () => {
  test('connection errors point at the gateway, never at the internet', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND']) {
      const out = humanizeBackendError(Object.assign(new Error('x'), { code }))
      assert.match(out.hint ?? '', /gateway/i, code)
      assert.doesNotMatch(out.hint ?? '', /internet/i, code)
    }
  })
})

describe('humanizeBackendError — what Node fetch actually throws (shell audit 2026-10-03)', () => {
  test('"fetch failed" with ECONNREFUSED in its cause names the Gateway instead of printing "fetch failed"', () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' }),
    })
    const out = humanizeBackendError(refused, 'Failed to test API key')
    assert.doesNotMatch(out.detail, /fetch failed/)
    assert.match(out.detail, /Gateway/)
    assert.match(out.detail, /running/)
  })

  test('a client wrapper around that failure is translated the same way', () => {
    const wrapped = new Error('Gateway account data could not be reached after automatic reconnect attempts.', {
      cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
    })
    assert.match(humanizeBackendError(wrapped).detail, /Gateway not reachable at http:\/\/127\.0\.0\.1:8787/)
  })

  test('AbortSignal.timeout is "did not answer in time", not "The operation was aborted due to timeout"', () => {
    const out = humanizeBackendError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    assert.match(out.detail, /did not answer in time/)
  })

  test('a file error nested in a cause does not relabel an unrelated failure', () => {
    const e = new Error('Episode EP0012 has no script yet.', { cause: Object.assign(new Error('x'), { code: 'ENOENT' }) })
    assert.equal(humanizeBackendError(e).detail, 'Episode EP0012 has no script yet.')
  })
})
