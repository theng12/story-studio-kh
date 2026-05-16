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
import { requireAllowedHost } from '../lib/security.js'

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
