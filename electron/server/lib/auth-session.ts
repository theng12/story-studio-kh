/**
 * Session-cookie authentication for server mode.
 *
 * Threat model: a single user (the operator) accessing their own headless
 * Mac mini over Tailscale. Tailscale provides the transport security
 * (WireGuard); this module handles credential verification and session
 * tokens at the HTTP layer.
 *
 * Stateless: the cookie carries the session payload (`{username, exp}`)
 * signed with HMAC-SHA256. No server-side session store — restart of the
 * Mac mini doesn't log the user out as long as the same `session_secret`
 * persists in app-settings.json. To revoke ALL sessions, rotate the
 * session_secret (Settings → Server Mode → "Rotate sessions").
 *
 * Password storage: scrypt with 16-byte salt + 64-byte hash, encoded as
 * `salt:hash` hex. Verification is constant-time. Tuning params chosen for
 * a sensible cost on M-series silicon (~50ms per verify) — slow enough to
 * frustrate offline brute force, fast enough that login feels instant.
 */

import crypto from 'crypto'

// ── Password hashing (scrypt) ──────────────────────────────────────────────

const SCRYPT_N = 16384       // 2^14 — ~50ms on M1
const SCRYPT_R = 8
const SCRYPT_P = 1
const SALT_BYTES = 16
const HASH_BYTES = 64

/**
 * Hash a plaintext password for storage. Sync because we call it from
 * setter routes that aren't on the hot path. Returns `salt:hash` hex.
 */
export function hashPassword(plain: string): string {
  if (!plain || typeof plain !== 'string') throw new Error('password required')
  const salt = crypto.randomBytes(SALT_BYTES)
  const hash = crypto.scryptSync(plain, salt, HASH_BYTES, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  })
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

/**
 * Verify a plaintext password against a stored `salt:hash`. Constant-time
 * comparison avoids leaking the prefix of a near-correct guess via timing.
 * Returns false on any malformed input — never throws.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!plain || !stored) return false
  const sep = stored.indexOf(':')
  if (sep === -1) return false
  try {
    const salt = Buffer.from(stored.slice(0, sep), 'hex')
    const expected = Buffer.from(stored.slice(sep + 1), 'hex')
    if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false
    const actual = crypto.scryptSync(plain, salt, HASH_BYTES, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    })
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ── Session cookie signing ─────────────────────────────────────────────────

interface SessionPayload {
  username: string
  exp: number  // unix seconds
}

/**
 * Sign a session payload into a cookie value. Format: `<base64url(json)>.<base64url(hmac)>`.
 * Using base64url avoids cookie escaping headaches with `+`, `/`, `=`.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  const json = JSON.stringify(payload)
  const body = Buffer.from(json, 'utf-8').toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

/**
 * Verify a signed session cookie. Returns the decoded payload on success,
 * null on bad signature, expired, or any malformed input.
 */
export function verifySession(cookie: string, secret: string): SessionPayload | null {
  if (!cookie || !secret) return null
  const dot = cookie.indexOf('.')
  if (dot === -1) return null
  const body = cookie.slice(0, dot)
  const sig = cookie.slice(dot + 1)
  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    const json = Buffer.from(body, 'base64url').toString('utf-8')
    const payload = JSON.parse(json) as SessionPayload
    if (typeof payload.username !== 'string' || typeof payload.exp !== 'number') return null
    if (Date.now() / 1000 >= payload.exp) return null
    return payload
  } catch {
    return null
  }
}

/**
 * Build the Set-Cookie header value for a fresh session.
 *
 * Flags:
 *   - HttpOnly: blocks document.cookie access (XSS can't steal the session).
 *   - SameSite=Lax: standard CSRF defence; Lax (not Strict) so links from
 *     other tabs still work — important when bookmarking the URL.
 *   - Path=/: cookie travels with every same-origin request.
 *   - Max-Age in seconds.
 *   - **No `Secure` flag**: Tailscale carries WireGuard-encrypted bytes but
 *     the HTTP layer is plain :8765. `Secure` would refuse to set the cookie
 *     over plain HTTP. Document-level call-out: this is acceptable on a
 *     trusted tailnet but DO NOT expose this port to the public internet
 *     without putting TLS in front (Caddy / nginx / etc).
 */
export function buildSessionCookie(value: string, maxAgeSeconds: number): string {
  return `ssk_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
}

/**
 * Build the Set-Cookie header that clears the session (Max-Age=0).
 * Browsers immediately purge the cookie on receipt.
 */
export function buildClearedSessionCookie(): string {
  return 'ssk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
}

// ── Cookie parsing (no dep) ────────────────────────────────────────────────

/**
 * Extract a single cookie value from a `Cookie:` header. Returns null when
 * the cookie isn't present. Tolerant of whitespace + multiple cookies.
 */
export function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header || typeof header !== 'string') return null
  const parts = header.split(';')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    if (k !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

// ── requireSession middleware ──────────────────────────────────────────────

import type { ServerModeAuth, AutomationKeyRecord } from './server-mode.js'

// ── Automation keys (`Authorization: Bearer ssk_…`) ────────────────────────
//
// Stored as plain SHA-256, not scrypt: the key is 32 random bytes, so there is
// nothing to brute-force offline and a slow hash would only cost ~50 ms on
// every API call. scrypt exists for low-entropy human passwords.

export const AUTOMATION_KEY_PREFIX = 'ssk_'
const AUTOMATION_KEY_SHAPE = /^ssk_[A-Za-z0-9_-]{43}$/

export function generateAutomationKey(): string {
  return AUTOMATION_KEY_PREFIX + crypto.randomBytes(32).toString('base64url')
}

export function hashAutomationKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

/**
 * The key a request presents, from `Authorization: Bearer …` or `X-Story-Key`.
 * undefined when the request carries neither (it then falls through to the
 * cookie check); an empty or malformed value is still "presented" and fails.
 */
export function readAutomationKeyHeader(headers: Record<string, unknown>): string | undefined {
  const x = headers['x-story-key']
  if (typeof x === 'string') return x.trim()
  const a = headers.authorization
  if (typeof a === 'string' && /^bearer(\s|$)/i.test(a)) return a.slice(6).trim()
  return undefined
}

/** Constant-time match against every stored hash (no early exit). */
export function findAutomationKey(presented: string, keys: AutomationKeyRecord[]): AutomationKeyRecord | null {
  if (!AUTOMATION_KEY_SHAPE.test(presented)) return null
  const actual = Buffer.from(hashAutomationKey(presented), 'hex')
  let match: AutomationKeyRecord | null = null
  for (const key of keys) {
    const expected = Buffer.from(key.hash, 'hex')
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual) && !match) match = key
  }
  return match
}

export type AutomationKeyCheck =
  | { ok: true; key: AutomationKeyRecord }
  | { ok: false; status: 401 | 429; detail: string }

/**
 * Check a presented key, sharing the login rate limiter: an IP over the limit
 * is refused before the key is looked at, and every failure counts as one
 * attempt. Successes do not count, so a busy agent never throttles itself.
 */
export function checkAutomationKey(
  presented: string, peer: string, keys: AutomationKeyRecord[], maxAttempts: number = 30,
): AutomationKeyCheck {
  if (isLoginRateLimited(peer, maxAttempts)) {
    return { ok: false, status: 429, detail: `Too many failed sign-in attempts (max ${maxAttempts}/min). Wait a minute and try again.` }
  }
  const key = findAutomationKey(presented, keys)
  if (key) return { ok: true, key }
  checkLoginRateLimit(peer, maxAttempts)
  return { ok: false, status: 401, detail: 'Invalid or revoked automation key' }
}

/** `…abcd` — the only part of a key that may appear in a log. */
export function automationKeyHint(key: string): string {
  return `…${key.slice(-4)}`
}

export interface RequireSessionOptions {
  getKeys?: () => AutomationKeyRecord[]
  onKeyUsed?: (key: AutomationKeyRecord, peer: string) => void
  onKeyRejected?: (presented: string, peer: string, status: number) => void
}

/**
 * Build a session-required middleware bound to the current server-mode auth
 * config. Express middleware factory pattern — call once at app boot, mount
 * the returned middleware before any route that needs auth.
 *
 * Carve-outs:
 *   1. Loopback (127.0.0.1/::1): the local Electron BrowserWindow on the
 *      Mac mini itself loads from loopback. Showing a login page there
 *      would be hostile UX (user is sitting at the mini = already
 *      authenticated by physical access). Bypassed.
 *   2. `req.skip_auth = true` set by an earlier middleware can also bypass
 *      — used for public probes (/api/health, /api/server-info, /api/auth/*).
 */
export function buildRequireSession(
  getAuth: () => ServerModeAuth | undefined,
  { getKeys = () => [], onKeyUsed, onKeyRejected }: RequireSessionOptions = {},
) {
  return function requireSession(req: any, res: any, next: any): void {
    if (req.skip_auth) return next()

    // Loopback bypass — see carve-out #1 above. `req.ip` reflects the
    // socket peer; trust-proxy is OFF so it can't be spoofed via headers.
    const peer = req.ip || req.socket?.remoteAddress || ''
    if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
      req.user = { username: '__local__' }
      return next()
    }

    const auth = getAuth()

    // Automation key: when presented it decides, cookie or not. Read fresh
    // per request, so a revoked key stops working on the next call.
    const presented = readAutomationKeyHeader(req.headers || {})
    if (presented !== undefined) {
      const result = checkAutomationKey(presented, peer, getKeys(), auth?.login_max_attempts_per_minute)
      if (!result.ok) {
        onKeyRejected?.(presented, peer, result.status)
        res.status(result.status).json({ detail: result.detail })
        return
      }
      req.user = { username: auth?.username || '__automation__', via: 'automation_key', key_id: result.key.id }
      onKeyUsed?.(result.key, peer)
      return next()
    }

    if (!auth || !auth.session_secret) {
      // Server is in server mode but credentials aren't configured yet.
      // Fail closed — the user must complete the first-launch setup.
      res.status(503).json({ detail: 'Server mode credentials not configured' })
      return
    }

    const cookie = parseCookieHeader(req.headers.cookie as string | undefined, 'ssk_session')
    if (!cookie) {
      res.status(401).json({ detail: 'Authentication required' })
      return
    }
    const payload = verifySession(cookie, auth.session_secret)
    if (!payload || payload.username !== auth.username) {
      res.status(401).json({ detail: 'Invalid or expired session' })
      return
    }

    req.user = { username: payload.username }
    next()
  }
}

// ── The owner, for the few actions only the owner may take ─────────────────
//
// The loopback bypass above lets any process on the Mac in as `__local__`, and
// desktop mode has no session at all. So the owner-only routes (Trash: Mac
// Trash, Delete permanently) ask for more: a valid session cookie (the owner's
// browser, signed in), or this per-boot secret, which main.ts adds to the app
// window's own requests (the page never sees it) and which no file holds.

export const OWNER_WINDOW_HEADER = 'x-story-owner'
const OWNER_WINDOW_SECRET = crypto.randomBytes(32).toString('base64url')

/** For main.ts only: the header value its BrowserWindow sends. */
export function ownerWindowSecret(): string { return OWNER_WINDOW_SECRET }

export function isOwnerRequest(req: any, auth: ServerModeAuth | undefined): boolean {
  const header = req.headers?.[OWNER_WINDOW_HEADER]
  if (typeof header === 'string') {
    const a = Buffer.from(header)
    const b = Buffer.from(OWNER_WINDOW_SECRET)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true
  }
  if (!auth?.session_secret || !auth.username) return false
  const payload = verifySession(parseCookieHeader(req.headers?.cookie, 'ssk_session') || '', auth.session_secret)
  return payload?.username === auth.username
}

// ── In-memory rate limiter for /api/auth/login ─────────────────────────────

interface RateLimitBucket {
  count: number
  windowStart: number
}
const rateLimitBuckets = new Map<string, RateLimitBucket>()

/** Whether `ip` is already over the limit, without counting this call. */
export function isLoginRateLimited(ip: string, maxAttempts: number = 30): boolean {
  const bucket = rateLimitBuckets.get(ip)
  return !!bucket && Date.now() - bucket.windowStart < 60_000 && bucket.count >= maxAttempts
}

/**
 * Per-IP rate limit on login attempts. Default 30 attempts / 60s — bumped
 * from the legacy hardcoded 5 in v1.0.107 because auto-fill / typo loops
 * routinely tripped it on the host LAN. Restart resets all buckets — fine
 * for personal use. Returns `true` when the request is allowed (counter
 * incremented), `false` when over the limit (caller responds 429).
 *
 * `maxAttempts` is passed in from the caller (auth route) so the limit
 * can be configured per-installation via app-settings.json
 * (`server_mode.auth.login_max_attempts_per_minute`). Fallback to 30 keeps
 * tests + ad-hoc callers working without plumbing the config through.
 */
export function checkLoginRateLimit(ip: string, maxAttempts: number = 30): boolean {
  const now = Date.now()
  const WINDOW_MS = 60_000
  let bucket = rateLimitBuckets.get(ip)
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now }
    rateLimitBuckets.set(ip, bucket)
  }
  bucket.count++
  return bucket.count <= maxAttempts
}
