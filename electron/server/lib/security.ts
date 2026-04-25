/**
 * Local-origin hardening for the embedded Express server.
 *
 * The app runs an HTTP server on 127.0.0.1:<random-port> next to a rich
 * renderer. Without these guards, any web page the user visits can port-scan
 * localhost, find that port, and fire cross-site fetches with credentials —
 * scraping API keys, rewriting `ffmpeg_path` to a planted binary, or
 * tampering with project data. DNS rebinding reaches the same endpoints even
 * if CORS is tightened.
 *
 * Two complementary controls live here:
 *   1. `requireLocalHost` — reject any request whose Host header isn't a
 *      local hostname. Kills DNS rebinding, where the Host still reads
 *      `attacker.com` even though the connection lands on 127.0.0.1.
 *   2. `requireCsrfToken` + `csrfTokenHandler` — a random per-process token
 *      is delivered to the renderer through an Origin-gated GET. Write
 *      endpoints require the token echoed back in `X-Story-Studio-Token`.
 *      Cross-site attackers can't read the token (browsers block the fetch
 *      based on Origin) and can't guess it (256-bit entropy).
 */

import crypto from 'crypto'

export const CSRF_TOKEN = crypto.randomBytes(32).toString('hex')
export const CSRF_HEADER = 'x-story-studio-token'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null
  // IPv6 literal: [::1]:8000 → ::1
  const ipv6 = host.match(/^\[([^\]]+)\]/)
  if (ipv6) return ipv6[1]
  const idx = host.indexOf(':')
  return idx === -1 ? host : host.slice(0, idx)
}

function originHostname(origin: string | undefined): string | null {
  if (!origin) return null
  try { return new URL(origin).hostname } catch { return null }
}

export function requireLocalHost(req: any, res: any, next: any): void {
  const host = hostnameOf(req.headers.host as string | undefined)
  if (host && LOCAL_HOSTS.has(host)) return next()
  res.status(403).json({ detail: 'Host not allowed' })
}

export function requireCsrfToken(req: any, res: any, next: any): void {
  const provided = req.headers[CSRF_HEADER]
  if (typeof provided === 'string' && provided.length === CSRF_TOKEN.length) {
    // Constant-time compare to avoid leaking prefix via timing.
    const a = Buffer.from(provided)
    const b = Buffer.from(CSRF_TOKEN)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next()
  }
  res.status(403).json({ detail: 'Missing or invalid CSRF token' })
}

/**
 * Return the CSRF token — but only to same-origin (local) callers.
 *
 * Browsers set the Origin header on cross-origin fetches and the attacker
 * page can't forge it, so a mismatched hostname is a reliable signal that
 * the caller is hostile. Same-origin GETs from the renderer may omit Origin
 * entirely; that path is allowed.
 */
export function csrfTokenHandler(req: any, res: any): void {
  const origin = req.headers.origin as string | undefined
  if (origin) {
    const host = originHostname(origin)
    if (!host || !LOCAL_HOSTS.has(host)) {
      res.status(403).json({ detail: 'Origin not allowed' })
      return
    }
  }
  res.json({ token: CSRF_TOKEN })
}
