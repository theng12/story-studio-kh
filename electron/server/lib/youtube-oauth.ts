/**
 * YouTube OAuth (installed-app loopback flow).
 *
 * The desktop app spins up a one-shot HTTP server on a random local port,
 * generates an auth URL pointing at that port, and relies on Google's
 * "installed application" flow to redirect back. The redirect hits our
 * loopback server, we exchange the code for tokens, fetch the user's
 * channel metadata, and shut the server down. Nothing on port 80, no
 * deep-link scheme, no embedded browser.
 *
 * Why this shape:
 *   - Loopback + random port is Google's recommended flow for desktop apps.
 *   - Keeping client_id/client_secret in per-project secrets.json lets each
 *     user bring their own Google Cloud OAuth client (quota isolation,
 *     own-branded consent screen, no global secret baked into the app).
 *   - The frontend polls `/upload/oauth/status?flow_id=…` until success so
 *     we don't need a websocket or SSE channel for a one-shot handshake.
 *
 * Flow lifecycle is in-memory only — a pending OAuth flow vanishes if the
 * server restarts. That's fine: the user just clicks Connect again.
 */

import http from 'http'
import { URL, URLSearchParams } from 'url'
import { randomUUID, randomBytes } from 'crypto'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GOOGLE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'

// `youtube.upload` is the bare minimum for videos.insert; `youtube` (full)
// is needed so Reconcile (Phase 6) can list channel uploads. `yt-analytics
// .readonly` powers the Analytics tab + the "what worked" feedback into
// the Ideas + Metadata generators. We ask for all three up front — YouTube
// merges consent so the user sees one prompt.
//
// The exported `ANALYTICS_SCOPE` lets routes detect tokens issued by an
// older build that didn't request analytics access; those accounts need
// a re-auth pass to add the scope.
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly'
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  ANALYTICS_SCOPE,
]

/**
 * True iff the stored token bundle was minted with the analytics scope.
 * Returns false for legacy bundles whose `scope` string predates the
 * 2026-05-02 expansion. Routes consuming analytics data should gate on
 * this and prompt the user to re-authorize when false.
 */
export function tokenHasAnalyticsScope(scope: string | undefined | null): boolean {
  if (!scope) return false
  return scope.split(/\s+/).includes(ANALYTICS_SCOPE)
}

export interface OAuthTokenBundle {
  access_token: string
  refresh_token: string
  /** Unix ms timestamp when `access_token` expires. */
  expires_at: number
  scope: string
}

export interface OAuthFlowResult {
  tokens: OAuthTokenBundle
  channel: {
    channel_id: string
    channel_title: string
    custom_url?: string
    thumbnail_url?: string
  }
}

export interface OAuthFlowState {
  flow_id: string
  auth_url: string
  /** Promise that resolves when the redirect lands (or rejects on error / timeout). */
  promise: Promise<OAuthFlowResult>
  /** Force-close the loopback server and reject pending promise. Idempotent. */
  cancel: () => void
}

interface PendingFlow {
  flow_id: string
  state_token: string
  port: number
  client_id: string
  client_secret: string
  redirect_uri: string
  server: http.Server
  resolve: (r: OAuthFlowResult) => void
  reject: (e: Error) => void
  timeout: NodeJS.Timeout
}

// Keyed by flow_id. Populated on startOAuthFlow, drained on completion /
// cancel / timeout. Exposed (indirectly) via `getFlowStatus` so the frontend
// can poll; a finished flow stays around long enough for the client to
// read its terminal state, then is garbage-collected by the TTL.
const pending = new Map<string, PendingFlow>()
const finished = new Map<string, { ok: true; result: OAuthFlowResult } | { ok: false; error: string }>()
const FINISHED_TTL_MS = 5 * 60 * 1000

function purgeFinished(flowId: string) {
  setTimeout(() => finished.delete(flowId), FINISHED_TTL_MS)
}

/**
 * Kick off the OAuth flow: bind a loopback server, return the URL the
 * frontend should open in the system browser. Resolves when the browser
 * redirect lands (or rejects on timeout/user-cancel/server error).
 *
 * Default timeout is 5 minutes — long enough for users to handle 2FA
 * prompts on a phone without leaving a process dangling forever.
 */
export async function startOAuthFlow(opts: {
  client_id: string
  client_secret: string
  timeout_ms?: number
}): Promise<OAuthFlowState> {
  const { client_id, client_secret } = opts
  if (!client_id || !client_secret) {
    throw new Error('client_id and client_secret are required (paste them in Upload Center → Settings → YouTube).')
  }

  const flow_id = randomUUID()
  const state_token = randomBytes(16).toString('hex')

  // Bind a loopback server first so we know the port before building the URL.
  const server = http.createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr?.port) resolve(addr.port)
      else reject(new Error('Could not allocate loopback port'))
    })
  })
  const redirect_uri = `http://127.0.0.1:${port}/callback`

  const auth_url = `${GOOGLE_AUTH_URL}?${new URLSearchParams({
    client_id,
    redirect_uri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    // Force consent so Google re-issues a refresh_token even if the user
    // has already granted this client before. Without `prompt=consent` a
    // second connect from the same account returns no refresh_token and
    // we can't refresh silently later.
    prompt: 'consent',
    state: state_token,
  }).toString()}`

  let resolveP!: (r: OAuthFlowResult) => void
  let rejectP!: (e: Error) => void
  const promise = new Promise<OAuthFlowResult>((res, rej) => {
    resolveP = res
    rejectP = rej
  })

  const timeout = setTimeout(() => {
    const p = pending.get(flow_id)
    if (!p) return
    finishFlow(flow_id, { ok: false, error: 'OAuth flow timed out' })
    p.reject(new Error('OAuth flow timed out'))
  }, opts.timeout_ms ?? 5 * 60 * 1000)

  const entry: PendingFlow = {
    flow_id,
    state_token,
    port,
    client_id,
    client_secret,
    redirect_uri,
    server,
    resolve: resolveP,
    reject: rejectP,
    timeout,
  }
  pending.set(flow_id, entry)

  server.on('request', (req, res) => handleCallback(entry, req, res))

  const cancel = () => {
    const p = pending.get(flow_id)
    if (!p) return
    finishFlow(flow_id, { ok: false, error: 'Cancelled by user' })
    p.reject(new Error('Cancelled by user'))
  }

  return { flow_id, auth_url, promise, cancel }
}

function finishFlow(flow_id: string, state: { ok: true; result: OAuthFlowResult } | { ok: false; error: string }) {
  const p = pending.get(flow_id)
  if (!p) return
  pending.delete(flow_id)
  finished.set(flow_id, state)
  clearTimeout(p.timeout)
  // Close gracefully — the response for the final request has already been sent.
  p.server.close()
  purgeFinished(flow_id)
}

async function handleCallback(p: PendingFlow, req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${p.port}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }

    const returnedState = url.searchParams.get('state') || ''
    const code = url.searchParams.get('code') || ''
    const error = url.searchParams.get('error') || ''

    if (error) {
      // Google's `error` param is a well-defined enum in practice, but
      // escape it anyway — any HTML emitted to the user's system browser
      // should be treated as untrusted input.
      respondHtml(res, htmlPage({ title: 'Connection failed', body: `Google returned an error: ${escapeHtml(error)}. You can close this window.` }))
      finishFlow(p.flow_id, { ok: false, error: `Google returned error: ${error}` })
      p.reject(new Error(`Google returned error: ${error}`))
      return
    }
    if (returnedState !== p.state_token) {
      respondHtml(res, htmlPage({ title: 'Connection failed', body: 'Security check failed (state mismatch). Please try again.' }))
      finishFlow(p.flow_id, { ok: false, error: 'State mismatch' })
      p.reject(new Error('State mismatch'))
      return
    }
    if (!code) {
      respondHtml(res, htmlPage({ title: 'Connection failed', body: 'No authorization code returned. Please try again.' }))
      finishFlow(p.flow_id, { ok: false, error: 'No authorization code' })
      p.reject(new Error('No authorization code'))
      return
    }

    // Exchange code for tokens.
    const tokens = await exchangeCodeForTokens({
      code,
      client_id: p.client_id,
      client_secret: p.client_secret,
      redirect_uri: p.redirect_uri,
    })

    // Fetch channel metadata so the UI can show a human-readable name.
    const channel = await fetchPrimaryChannel(tokens.access_token)
    if (!channel) {
      throw new Error('Authenticated, but no YouTube channel found on this Google account.')
    }

    const result: OAuthFlowResult = { tokens, channel }

    respondHtml(res, htmlPage({
      title: 'Connected to YouTube',
      body: `Connected to <strong>${escapeHtml(channel.channel_title)}</strong>. You can close this window and return to Story Studio.`,
    }))
    finishFlow(p.flow_id, { ok: true, result })
    p.resolve(result)
  } catch (e: any) {
    try {
      respondHtml(res, htmlPage({
        title: 'Connection failed',
        body: `Something went wrong: ${escapeHtml(e?.message || 'unknown error')}. You can close this window and try again.`,
      }))
    } catch { /* ignore response errors */ }
    finishFlow(p.flow_id, { ok: false, error: e?.message || 'unknown error' })
    p.reject(e)
  }
}

async function exchangeCodeForTokens(opts: {
  code: string
  client_id: string
  client_secret: string
  redirect_uri: string
}): Promise<OAuthTokenBundle> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.client_id,
    client_secret: opts.client_secret,
    redirect_uri: opts.redirect_uri,
    grant_type: 'authorization_code',
  })
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Token exchange failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = await resp.json() as any
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Token exchange succeeded but no refresh_token returned. Disconnect this account from Google (myaccount.google.com → security → third-party access) and try again so Google re-issues a refresh token.')
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in || 3600) * 1000),
    scope: String(data.scope || SCOPES.join(' ')),
  }
}

/**
 * Revoke a refresh (or access) token on Google's side. Called on Disconnect
 * so the app drops out of the user's authorized-apps list at
 * myaccount.google.com → security → third-party access. Failure is
 * non-fatal — the caller should proceed with local token wipe regardless,
 * since local removal is the action the user asked for.
 */
export async function revokeToken(token: string): Promise<void> {
  if (!token) return
  try {
    const resp = await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    // 200 = revoked. 400 = already invalid (from a prior revoke, or an
    // expired grant Google already cleaned up). Either way, we're done.
    if (!resp.ok && resp.status !== 400) {
      // Don't throw — caller has already decided to disconnect and the
      // user's local tokens will be wiped regardless. Logging only.
      // Intentional silence keeps the disconnect UX snappy even on flaky
      // networks.
    }
  } catch { /* non-fatal */ }
}

/**
 * Refresh an access_token using the stored refresh_token. The refresh_token
 * itself is long-lived but can be invalidated (user revoked access, grant
 * age > 6 months with inactive use, etc.) — callers should surface 400/401
 * errors as "reconnect required".
 */
export async function refreshAccessToken(opts: {
  client_id: string
  client_secret: string
  refresh_token: string
}): Promise<OAuthTokenBundle> {
  const body = new URLSearchParams({
    client_id: opts.client_id,
    client_secret: opts.client_secret,
    refresh_token: opts.refresh_token,
    grant_type: 'refresh_token',
  })
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Token refresh failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = await resp.json() as any
  return {
    access_token: data.access_token,
    // Google does NOT re-issue a refresh_token on refresh — keep the old one.
    refresh_token: opts.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in || 3600) * 1000),
    scope: String(data.scope || ''),
  }
}

async function fetchPrimaryChannel(access_token: string): Promise<OAuthFlowResult['channel'] | null> {
  const url = `${GOOGLE_CHANNELS_URL}?${new URLSearchParams({
    part: 'id,snippet',
    mine: 'true',
  }).toString()}`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to read channel info (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = await resp.json() as any
  const item = data?.items?.[0]
  if (!item) return null
  return {
    channel_id: item.id,
    channel_title: item.snippet?.title || 'Unknown channel',
    custom_url: item.snippet?.customUrl,
    thumbnail_url: item.snippet?.thumbnails?.default?.url,
  }
}

/**
 * Polled by the frontend to learn whether the loopback redirect has landed.
 * Returns `pending` while the flow is in-flight, `success`/`error` once it
 * terminates. Terminal states are held briefly then GC'd.
 */
export function getFlowStatus(flow_id: string): { status: 'pending' } | { status: 'success'; result: OAuthFlowResult } | { status: 'error'; error: string } | { status: 'unknown' } {
  if (pending.has(flow_id)) return { status: 'pending' }
  const done = finished.get(flow_id)
  if (done) {
    return done.ok ? { status: 'success', result: done.result } : { status: 'error', error: done.error }
  }
  return { status: 'unknown' }
}

function respondHtml(res: http.ServerResponse, html: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

function htmlPage(opts: { title: string; body: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1117; color: #e6edf3; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { max-width: 520px; padding: 32px 36px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0; line-height: 1.5; color: #c9d1d9; }
  strong { color: #58a6ff; }
</style></head><body><div class="card"><h1>${escapeHtml(opts.title)}</h1><p>${opts.body}</p></div></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c] as string))
}
