/**
 * Authentication routes for server mode.
 *
 * Mounted under `/api/auth/*` BEFORE the requireSession middleware in
 * `app.ts`, so login/logout/me are reachable without an existing session.
 *
 * In default mode (Electron desktop) these routes are still mounted but
 * `getServerModeConfig()` returns null, so login attempts return 503.
 * The frontend never hits them outside server mode anyway.
 */

import { Router } from 'express'
import {
  verifyPassword, signSession, buildSessionCookie, buildClearedSessionCookie,
  parseCookieHeader, verifySession, checkLoginRateLimit,
} from '../lib/auth-session.js'
import { getServerModeConfig } from '../lib/server-mode.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

/**
 * POST /api/auth/login { username, password }
 *
 * Verifies credentials, signs a fresh session cookie, returns the username.
 * Rate-limited per peer IP to 5 attempts / 60s. Defends against tailnet-
 * internal brute force; restart resets buckets which is fine for personal use.
 */
router.post('/auth/login', async (req, res) => {
  const peer = req.ip || req.socket?.remoteAddress || 'unknown'
  if (!checkLoginRateLimit(peer)) {
    return res.status(429).json({ detail: 'Too many login attempts. Wait a minute and try again.' })
  }

  const cfg = getServerModeConfig()
  if (!cfg || !cfg.auth) {
    return res.status(503).json({ detail: 'Server mode credentials are not configured.' })
  }

  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!username || !password) {
    return res.status(400).json({ detail: 'Username and password are required.' })
  }
  // Constant-time-ish: ALWAYS run scrypt verify even if username is wrong,
  // to keep timing similar between "no such user" and "wrong password".
  const usernameMatch = username === cfg.auth.username
  const passwordOk = verifyPassword(password, cfg.auth.password_hash)
  if (!usernameMatch || !passwordOk) {
    return res.status(401).json({ detail: 'Invalid username or password.' })
  }

  const ttlSec = cfg.auth.session_ttl_hours * 3600
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const cookie = signSession({ username: cfg.auth.username, exp }, cfg.auth.session_secret)
  res.setHeader('Set-Cookie', buildSessionCookie(cookie, ttlSec))
  res.json({ username: cfg.auth.username })
})

/**
 * POST /api/auth/logout
 *
 * Clears the session cookie. Stateless — this only tells the browser to
 * forget the cookie; the server has no way to revoke a leaked cookie short
 * of rotating session_secret (Settings → "Sign out everywhere").
 */
router.post('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', buildClearedSessionCookie())
  res.status(204).end()
})

/**
 * GET /api/auth/me
 *
 * Returns `{ username }` if the request carries a valid session cookie,
 * 401 otherwise. Used by the SPA on boot to decide login-page vs main-app
 * routing without firing a separate auth fetch on every page nav.
 *
 * Inline session-check (instead of relying on requireSession) because this
 * route is mounted BEFORE that middleware — pre-login probes need to be
 * able to receive a 401 cleanly without the middleware short-circuiting.
 */
router.get('/auth/me', (req, res) => {
  const cfg = getServerModeConfig()
  if (!cfg) {
    // In default (Electron) mode, /auth/me reports a synthetic "local"
    // user so the SPA's auth checks pass without a server-mode round-trip.
    return res.json({ username: '__local__', mode: 'local' })
  }
  if (!cfg.auth?.session_secret) {
    return res.status(503).json({ detail: 'Server mode credentials not configured' })
  }
  const cookie = parseCookieHeader(req.headers.cookie as string | undefined, 'ssk_session')
  if (!cookie) {
    return res.status(401).json({ detail: 'Authentication required' })
  }
  const payload = verifySession(cookie, cfg.auth.session_secret)
  if (!payload || payload.username !== cfg.auth.username) {
    return res.status(401).json({ detail: 'Invalid or expired session' })
  }
  res.json({ username: payload.username, mode: 'server' })
})
