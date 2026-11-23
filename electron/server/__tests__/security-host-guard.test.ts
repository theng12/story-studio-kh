/**
 * Host-header guard regression tests (v1.0.99).
 *
 * The host-guard middleware shuts down DNS-rebinding attacks against the
 * embedded :8000 server in Electron desktop mode. Server mode bypasses
 * it (Tailscale + session auth take over). Both branches need to be
 * locked in by tests so a future "let's clean up middleware" pass can't
 * silently delete the desktop-mode protection.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTENT_SECURITY_POLICY,
  UnsafeServiceUrlError,
  isAllowedApplicationNavigation,
  isSafeExternalUrl,
  normalizeServiceBaseUrl,
  requireAllowedHost,
} from '../lib/security.js'

/** Minimal Express-shaped req/res stub. */
function mockReqRes(host: string | undefined) {
  const req: any = { headers: { host } }
  let status = 0
  let payload: any = null
  const res: any = {
    status(code: number) { status = code; return res },
    json(p: any) { payload = p; return res },
  }
  return { req, res, getStatus: () => status, getPayload: () => payload }
}

describe('requireAllowedHost — desktop mode', () => {
  const guard = requireAllowedHost(false)

  test('allows localhost', () => {
    const { req, res, getStatus } = mockReqRes('localhost:8000')
    let nextCalled = false
    guard(req, res, () => { nextCalled = true })
    assert.equal(nextCalled, true)
    assert.equal(getStatus(), 0)
  })

  test('allows 127.0.0.1', () => {
    const { req, res, getStatus } = mockReqRes('127.0.0.1:8000')
    let nextCalled = false
    guard(req, res, () => { nextCalled = true })
    assert.equal(nextCalled, true)
    assert.equal(getStatus(), 0)
  })

  test('allows IPv6 loopback ::1', () => {
    const { req, res, getStatus } = mockReqRes('[::1]:8000')
    let nextCalled = false
    guard(req, res, () => { nextCalled = true })
    assert.equal(nextCalled, true)
    assert.equal(getStatus(), 0)
  })

  test('blocks attacker.com (DNS-rebind attempt)', () => {
    const { req, res, getStatus, getPayload } = mockReqRes('attacker.com')
    let nextCalled = false
    guard(req, res, () => { nextCalled = true })
    assert.equal(nextCalled, false)
    assert.equal(getStatus(), 403)
    assert.deepEqual(getPayload(), { detail: 'Host not allowed' })
  })

  test('blocks bare external IP literal', () => {
    const { req, res, getStatus } = mockReqRes('192.0.2.1:8000')
    guard(req, res, () => {})
    assert.equal(getStatus(), 403)
  })

  test('blocks when host header is missing', () => {
    const { req, res, getStatus } = mockReqRes(undefined)
    guard(req, res, () => {})
    assert.equal(getStatus(), 403)
  })
})

describe('requireAllowedHost — server mode bypass', () => {
  const guard = requireAllowedHost(true)

  test('allows any host (Tailscale hostname, IP, anything)', () => {
    for (const host of [
      // Declared exception to the path-free tree: this is the scanner's own pattern — a made-up
      // tailnet hostname used to prove the guard accepts it. It is not a real machine.
      'macmini-server.tailnet.ts.net',
      '100.64.0.1:8765',
      'attacker.com',
      'localhost',
      undefined,
    ]) {
      const { req, res, getStatus } = mockReqRes(host)
      let nextCalled = false
      guard(req, res, () => { nextCalled = true })
      assert.equal(nextCalled, true, `should allow host=${host} in server mode`)
      assert.equal(getStatus(), 0)
    }
  })
})

describe('service URL validation', () => {
  test('accepts HTTPS and private local/Tailscale HTTP addresses', () => {
    assert.equal(normalizeServiceBaseUrl('https://api.genstudio.example/'), 'https://api.genstudio.example')
    assert.equal(normalizeServiceBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
    assert.equal(normalizeServiceBaseUrl('http://100.64.10.20:8000/'), 'http://100.64.10.20:8000')
    assert.equal(normalizeServiceBaseUrl('http://controller.local:8000/'), 'http://controller.local:8000')
  })

  test('rejects unsafe schemes, public plaintext HTTP, credentials, and query secrets', () => {
    for (const url of [
      'file:///tmp/app',
      'javascript:alert(1)',
      'http://api.genstudio.example',
      'https://user:secret@api.genstudio.example',
      'https://api.genstudio.example?api_key=secret',
      'https://api.genstudio.example/#token',
    ]) {
      assert.throws(() => normalizeServiceBaseUrl(url), UnsafeServiceUrlError, url)
    }
  })
})

describe('Electron navigation boundary', () => {
  const origins = new Set(['http://127.0.0.1:8000', 'http://localhost:3000'])

  test('allows only credential-free application origins in the main window', () => {
    assert.equal(isAllowedApplicationNavigation('http://127.0.0.1:8000/projects', origins), true)
    assert.equal(isAllowedApplicationNavigation('https://example.com', origins), false)
    assert.equal(isAllowedApplicationNavigation('http://user:secret@127.0.0.1:8000', origins), false)
  })

  test('opens only credential-free HTTP(S) links externally', () => {
    assert.equal(isSafeExternalUrl('https://docs.example.com/help'), true)
    assert.equal(isSafeExternalUrl('mailto:owner@example.com'), false)
    assert.equal(isSafeExternalUrl('file:///tmp/secret'), false)
    assert.equal(isSafeExternalUrl('https://user:secret@example.com'), false)
  })

  test('CSP denies eval, objects, frames, and off-origin form submission', () => {
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-eval/)
    assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/)
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/)
    assert.match(CONTENT_SECURITY_POLICY, /form-action 'self'/)
  })
})
