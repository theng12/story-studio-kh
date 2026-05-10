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
