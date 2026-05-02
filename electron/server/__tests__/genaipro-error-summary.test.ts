/**
 * Tests for summarizeGenaiproErrorBody (lib/genaipro-client.ts).
 *
 * GenAIPro returns HTML maintenance / proxy error pages on 5xx; the
 * job log used to dump the raw `<!DOCTYPE html>...` markup into the
 * UI. This helper detects HTML bodies and turns them into a short
 * action sentence instead.
 *
 * Pure function — no I/O, no async.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeGenaiproErrorBody } from '../lib/genaipro-client.js'

describe('summarizeGenaiproErrorBody', () => {
  test('plain-text body passes through (capped at 300 chars)', () => {
    const body = '{"error":"invalid voice_id"}'
    assert.equal(summarizeGenaiproErrorBody(400, body), body)
  })

  test('long plain-text body gets truncated to 300', () => {
    const body = 'x'.repeat(500)
    const out = summarizeGenaiproErrorBody(400, body)
    assert.equal(out.length, 300)
  })

  test('HTML maintenance page on 503 → action-oriented sentence with title', () => {
    const body = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Đang Bảo Trì - Maintenance</title>
  <style>body { background: #000 }</style>
</head>
<body><h1>503</h1></body>
</html>`
    const out = summarizeGenaiproErrorBody(503, body)
    assert.match(out, /temporarily unavailable/)
    assert.match(out, /Đang Bảo Trì - Maintenance/, 'should surface the parsed <title>')
    assert.match(out, /try again in a few minutes/i)
    assert.match(out, /Settings/, 'should point the user at switching providers')
    assert.doesNotMatch(out, /<!DOCTYPE/, 'no raw HTML in the message')
    assert.doesNotMatch(out, /<html/, 'no raw HTML in the message')
  })

  test('HTML 503 without a parseable title still produces a clean message', () => {
    const body = `<!DOCTYPE html><html><body>Service Unavailable</body></html>`
    const out = summarizeGenaiproErrorBody(503, body)
    assert.match(out, /temporarily unavailable/)
    assert.match(out, /under maintenance/)
    assert.doesNotMatch(out, /<!DOCTYPE/)
    assert.doesNotMatch(out, /<\/body>/)
  })

  test('HTML 502 → upstream gateway message', () => {
    const body = `<!DOCTYPE html><html><head><title>Bad Gateway</title></head></html>`
    const out = summarizeGenaiproErrorBody(502, body)
    assert.match(out, /upstream gateway/)
    assert.doesNotMatch(out, /<!DOCTYPE/)
  })

  test('HTML 504 → upstream gateway message', () => {
    const body = `<html><head><title>Gateway Timeout</title></head></html>`
    const out = summarizeGenaiproErrorBody(504, body)
    assert.match(out, /upstream gateway/)
  })

  test('HTML on a non-5xx status (e.g. 403 from a CDN) → generic HTML notice', () => {
    const body = `<!DOCTYPE html><html><head><title>Forbidden</title></head></html>`
    const out = summarizeGenaiproErrorBody(403, body)
    assert.match(out, /HTML error page/)
    assert.match(out, /Forbidden/, 'title preserved')
    assert.doesNotMatch(out, /<!DOCTYPE/)
  })

  test('handles leading whitespace before <!DOCTYPE>', () => {
    const body = `   \n  <!DOCTYPE html><html></html>`
    const out = summarizeGenaiproErrorBody(503, body)
    assert.match(out, /temporarily unavailable/)
  })

  test('handles uppercase + lowercase doctype variants', () => {
    const lower = `<!doctype html><html></html>`
    const upper = `<!DOCTYPE HTML><HTML></HTML>`
    assert.match(summarizeGenaiproErrorBody(503, lower), /temporarily unavailable/)
    assert.match(summarizeGenaiproErrorBody(503, upper), /temporarily unavailable/)
  })

  test('JSON body that happens to mention <html> is treated as JSON, not HTML', () => {
    const body = `{"detail":"the error contained <html> in the message"}`
    const out = summarizeGenaiproErrorBody(400, body)
    assert.equal(out, body, 'should pass through, not reformat as HTML')
  })

  test('empty body returns empty string', () => {
    assert.equal(summarizeGenaiproErrorBody(503, ''), '')
    assert.equal(summarizeGenaiproErrorBody(503, '   '), '')
  })

  test('multiline title is collapsed to single-line', () => {
    const body = `<!DOCTYPE html><html><head><title>
      Đang Bảo Trì
      - Maintenance
    </title></head></html>`
    const out = summarizeGenaiproErrorBody(503, body)
    assert.match(out, /Đang Bảo Trì - Maintenance/)
  })
})
