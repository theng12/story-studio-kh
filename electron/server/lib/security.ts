/**
 * Host-header hardening for the embedded Express server.
 *
 * The default (Electron desktop) posture: the app runs an HTTP server on
 * 127.0.0.1:<random-port> next to a rich renderer. Without a Host check, any
 * web page the user visits could port-scan localhost, find that port, and
 * fire cross-site fetches with credentials — scraping API keys, rewriting
 * `ffmpeg_path` to a planted binary, or tampering with project data. DNS
 * rebinding reaches the same endpoints even if CORS is tightened. The
 * `requireAllowedHost` middleware below is what shuts that class of attack:
 * a request arriving with `Host: attacker.com` is rejected before any route
 * handler runs.
 *
 * Server mode (headless on the network) bypasses the host check — the server
 * is intentionally reachable from the user's iMac via Tailscale, the Host
 * header carries the tailnet hostname, and session-cookie auth carries the
 * security weight instead. The bypass is opt-in via `STORY_STUDIO_SERVER_MODE`
 * or `app-settings.json → server_mode.enabled`.
 *
 * (Historical note: this file used to also export `requireCsrfToken` /
 * `csrfTokenHandler` for an Origin-gated CSRF token, but that mechanism was
 * never wired into any write route or fetched by any frontend caller. Dead
 * code removed in v1.0.72+ — if real CSRF is needed later, do it properly
 * with server-mode-aware Origin allowlisting from the start.)
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
  "media-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
  "connect-src 'self' http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "child-src 'none'",
  "manifest-src 'self'",
].join('; ')

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null
  // IPv6 literal: [::1]:8000 → ::1
  const ipv6 = host.match(/^\[([^\]]+)\]/)
  if (ipv6) return ipv6[1]
  const idx = host.indexOf(':')
  return idx === -1 ? host : host.slice(0, idx)
}

/**
 * Build the host-guard middleware. Pass `serverMode = true` to bypass the
 * check entirely (the caller is running on a network-exposed bind and using
 * session auth for access control).
 */
export function requireAllowedHost(serverMode: boolean) {
  return function (req: any, res: any, next: any): void {
    if (serverMode) return next()
    const host = hostnameOf(req.headers.host as string | undefined)
    if (host && LOCAL_HOSTS.has(host)) return next()
    res.status(403).json({ detail: 'Host not allowed' })
  }
}

/** Security headers shared by API, static renderer, and server-mode responses. */
export function applySecurityHeaders(_req: any, res: any, next: any): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  next()
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return LOCAL_HOSTS.has(normalized)
    || isPrivateIpv4(normalized)
    || normalized.endsWith('.local')
    || normalized.endsWith('.ts.net')
}

export class UnsafeServiceUrlError extends Error {
  readonly statusCode = 400
  readonly expose = true
  readonly code = 'unsafe_service_url'
}

/**
 * Validate and normalize a user-entered backend URL before persistence.
 * Public services require HTTPS; HTTP remains available for loopback, LAN,
 * Bonjour, and Tailscale endpoints. Credentials, query strings, and fragments
 * are rejected so secrets cannot accidentally become part of logs or requests.
 */
export function normalizeServiceBaseUrl(input: string, label = 'Service'): string {
  const trimmed = String(input || '').trim()
  if (!trimmed) return ''

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new UnsafeServiceUrlError(`${label} URL must be a complete http:// or https:// address.`)
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeServiceUrlError(`${label} URL must use http:// or https://.`)
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeServiceUrlError(`${label} URL must not contain a username, password, or API key.`)
  }
  if (parsed.search || parsed.hash) {
    throw new UnsafeServiceUrlError(`${label} URL must not contain query parameters or a fragment.`)
  }
  if (parsed.protocol === 'http:' && !isLocalHttpHost(parsed.hostname)) {
    throw new UnsafeServiceUrlError(`${label} must use HTTPS unless it is a local, LAN, or Tailscale address.`)
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
  return parsed.toString().replace(/\/$/, '')
}

/** Only ordinary, credential-free web links may leave the Electron shell. */
export function isSafeExternalUrl(input: string): boolean {
  try {
    const parsed = new URL(input)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && !parsed.username
      && !parsed.password
  } catch {
    return false
  }
}

export function isAllowedApplicationNavigation(input: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(input)
    if (parsed.username || parsed.password) return false
    return allowedOrigins.has(parsed.origin)
  } catch {
    return false
  }
}
