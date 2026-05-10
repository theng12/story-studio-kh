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

import type { ServerModeAuth } from './server-mode.js'

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
export function buildRequireSession(getAuth: () => ServerModeAuth | undefined) {
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

// ── In-memory rate limiter for /api/auth/login ─────────────────────────────

interface RateLimitBucket {
  count: number
  windowStart: number
}
const rateLimitBuckets = new Map<string, RateLimitBucket>()

/**
 * Per-IP rate limit on login attempts. 5 attempts / 60s. Restart resets all
 * buckets — fine for personal use. Returns `true` when the request is allowed
 * (counter incremented), `false` when over the limit (caller responds 429).
 */
export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now()
  const WINDOW_MS = 60_000
  const MAX_ATTEMPTS = 5
  let bucket = rateLimitBuckets.get(ip)
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now }
    rateLimitBuckets.set(ip, bucket)
  }
  bucket.count++
  return bucket.count <= MAX_ATTEMPTS
}
