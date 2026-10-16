/**
 * Auth-session regression tests (v1.0.99).
 *
 * Server mode's auth-session module had zero test coverage before
 * v1.0.99 — auth, session signing, rate-limit, and password hashing
 * were all production-relied-on but unverified. These tests lock in
 * the contracts so future refactors can't silently break the Mac
 * mini deployment path.
 *
 * Scope:
 *   - Password hashing: roundtrip + wrong-password rejected + malformed
 *     stored-hash returns false instead of throwing.
 *   - Session signing: roundtrip + tampered cookie rejected + expired
 *     cookie rejected + missing/empty secret handled.
 *   - Cookie parsing: tolerant of whitespace + multi-cookie headers.
 *   - Rate limiter: 5 attempts allowed, 6th blocked, window reset.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  parseCookieHeader,
  checkLoginRateLimit,
  isOwnerRequest,
  OWNER_WINDOW_HEADER,
  ownerWindowSecret,
} from '../lib/auth-session.js'

describe('hashPassword / verifyPassword', () => {
  test('roundtrips a valid password', () => {
    const stored = hashPassword('correct horse battery staple')
    assert.ok(stored.includes(':'), 'stored format is salt:hash')
    assert.equal(verifyPassword('correct horse battery staple', stored), true)
  })

  test('rejects the wrong password', () => {
    const stored = hashPassword('correct password')
    assert.equal(verifyPassword('wrong password', stored), false)
  })

  test('different salts produce different hashes for same plaintext', () => {
    const a = hashPassword('same input')
    const b = hashPassword('same input')
    assert.notEqual(a, b, 'salts should differ → stored values should differ')
    assert.equal(verifyPassword('same input', a), true)
    assert.equal(verifyPassword('same input', b), true)
  })

  test('returns false instead of throwing on malformed stored hash', () => {
    assert.equal(verifyPassword('anything', ''), false)
    assert.equal(verifyPassword('anything', 'no-colon-malformed'), false)
    assert.equal(verifyPassword('anything', ':only-empty-salt-side'), false)
    assert.equal(verifyPassword('anything', 'nothex:nothex'), false)
  })

  test('empty plaintext is rejected without throwing', () => {
    const stored = hashPassword('real password')
    assert.equal(verifyPassword('', stored), false)
  })
})

describe('signSession / verifySession', () => {
  const SECRET = 'a'.repeat(64)
  const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600

  test('roundtrips a valid session', () => {
    const cookie = signSession({ username: 'alice', exp: FUTURE_EXP }, SECRET)
    const decoded = verifySession(cookie, SECRET)
    assert.deepEqual(decoded, { username: 'alice', exp: FUTURE_EXP })
  })

  test('rejects a cookie signed with a different secret', () => {
    const cookie = signSession({ username: 'alice', exp: FUTURE_EXP }, SECRET)
    assert.equal(verifySession(cookie, 'b'.repeat(64)), null)
  })

  test('rejects a tampered body (signature mismatch)', () => {
    const cookie = signSession({ username: 'alice', exp: FUTURE_EXP }, SECRET)
    const dot = cookie.indexOf('.')
    // Flip a byte in the body half — sig won't match anymore.
    const tamperedBody = 'X' + cookie.slice(1, dot)
    const tampered = tamperedBody + cookie.slice(dot)
    assert.equal(verifySession(tampered, SECRET), null)
  })

  test('rejects an expired session', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const cookie = signSession({ username: 'alice', exp: past }, SECRET)
    assert.equal(verifySession(cookie, SECRET), null)
  })

  test('rejects malformed cookies without throwing', () => {
    assert.equal(verifySession('', SECRET), null)
    assert.equal(verifySession('no-dot-here', SECRET), null)
    assert.equal(verifySession('only.dot', SECRET), null)
    assert.equal(verifySession('a.b.c.d', SECRET), null)
  })

  test('rejects when secret is empty', () => {
    const cookie = signSession({ username: 'alice', exp: FUTURE_EXP }, SECRET)
    assert.equal(verifySession(cookie, ''), null)
  })
})

describe('parseCookieHeader', () => {
  test('returns null when header is missing', () => {
    assert.equal(parseCookieHeader(undefined, 'ssk_session'), null)
    assert.equal(parseCookieHeader('', 'ssk_session'), null)
  })

  test('extracts a single cookie value', () => {
    assert.equal(parseCookieHeader('ssk_session=abc.def', 'ssk_session'), 'abc.def')
  })

  test('extracts a cookie from a multi-cookie header', () => {
    const header = 'other=foo; ssk_session=abc.def; another=bar'
    assert.equal(parseCookieHeader(header, 'ssk_session'), 'abc.def')
  })

  test('tolerates extra whitespace around cookie names', () => {
    const header = '  ssk_session = abc.def ; other=foo'
    assert.equal(parseCookieHeader(header, 'ssk_session'), 'abc.def')
  })

  test('returns null when the named cookie is absent', () => {
    assert.equal(parseCookieHeader('other=foo; another=bar', 'ssk_session'), null)
  })
})

describe('checkLoginRateLimit', () => {
  // Pass an explicit maxAttempts so the test pins the limit it asserts,
  // independent of the configurable default (bumped 5 → 30 in v1.0.107).
  test('allows up to 5 attempts per IP, blocks the 6th', () => {
    // Use a unique IP per test run so previous test buckets don't leak.
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`
    for (let i = 0; i < 5; i++) {
      assert.equal(checkLoginRateLimit(ip, 5), true, `attempt ${i + 1} should be allowed`)
    }
    assert.equal(checkLoginRateLimit(ip, 5), false, '6th attempt should be blocked')
    assert.equal(checkLoginRateLimit(ip, 5), false, '7th attempt should still be blocked')
  })

  test('different IPs are tracked independently', () => {
    const ipA = `198.51.100.${Math.floor(Math.random() * 100) + 1}`
    const ipB = `198.51.100.${Math.floor(Math.random() * 100) + 100}`
    // Exhaust ipA's budget.
    for (let i = 0; i < 5; i++) checkLoginRateLimit(ipA, 5)
    assert.equal(checkLoginRateLimit(ipA, 5), false, 'ipA should be blocked')
    // ipB still has its full budget.
    assert.equal(checkLoginRateLimit(ipB, 5), true, 'ipB should be allowed')
  })
})

describe('isOwnerRequest (owner-only Trash actions)', () => {
  const auth = { username: 'owner', password_hash: '', session_secret: 'a'.repeat(64), session_ttl_hours: 1, login_max_attempts_per_minute: 30 }
  const cookie = (username: string, secret = auth.session_secret) =>
    `ssk_session=${signSession({ username, exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`

  test('a keyless request with no session and no window secret is not the owner, loopback or not', () => {
    assert.equal(isOwnerRequest({ headers: {}, ip: '127.0.0.1' }, auth), false)
    assert.equal(isOwnerRequest({ headers: {} }, undefined), false)
    assert.equal(isOwnerRequest({ headers: { [OWNER_WINDOW_HEADER]: 'guess' } }, auth), false)
  })

  test('the app window\'s per-boot secret is the owner, in desktop mode too (no auth configured)', () => {
    assert.equal(isOwnerRequest({ headers: { [OWNER_WINDOW_HEADER]: ownerWindowSecret() } }, undefined), true)
    assert.ok(ownerWindowSecret().length >= 43)
  })

  test('a valid session cookie for the configured user is the owner; another user, secret or no secret is not', () => {
    assert.equal(isOwnerRequest({ headers: { cookie: cookie('owner') } }, auth), true)
    assert.equal(isOwnerRequest({ headers: { cookie: cookie('someone') } }, auth), false)
    assert.equal(isOwnerRequest({ headers: { cookie: cookie('owner', 'b'.repeat(64)) } }, auth), false)
    assert.equal(isOwnerRequest({ headers: { cookie: cookie('owner') } }, { ...auth, session_secret: '' }), false)
  })
})
