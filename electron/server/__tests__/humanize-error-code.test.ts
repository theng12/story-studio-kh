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

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

describe('humanizeBackendError — domain code passthrough', () => {
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
})
