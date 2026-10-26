/**
 * Connecting a Facebook Page, an Instagram professional account, or a TikTok
 * account.
 *
 * Shared with `youtube-oauth.ts` in SPIRIT only: one loopback callback server,
 * a random state, a PKCE verifier, and a token-free public status. The
 * protocols differ enough that sharing the code would have meant a branch in
 * every step, so each provider gets its own small flow over the same shape.
 *
 * ── Meta ────────────────────────────────────────────────────────────────────
 * Meta documents native desktop login as an embedded webview that watches for
 * a fixed `https://www.facebook.com/connect/login_success.html` redirect and
 * reads the token from the fragment. It does NOT document a loopback redirect
 * for desktop apps, and its redirect rules require HTTPS with an exact match.
 * Story Studio therefore asks the owner to register the loopback address they
 * will use — `http://127.0.0.1:<port>/callback` — and exchanges the code
 * server-side. If Meta refuses that URI, the connection fails with Meta's own
 * words and the setup checklist in the HANDOFF says what to register instead.
 *
 * ── TikTok ──────────────────────────────────────────────────────────────────
 * TikTok's Login Kit for Desktop explicitly allows `http://127.0.0.1:*` with a
 * wildcard port, requires PKCE, and requires the challenge to be the HEX
 * encoding of SHA-256 (not the RFC 7636 base64url form). Both are implemented
 * exactly as documented.
 *
 * Sources (read 2026-10-27):
 *   https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 *   https://developers.facebook.com/docs/facebook-login/security
 *   https://developers.tiktok.com/doc/login-kit-desktop
 *   https://developers.tiktok.com/doc/oauth-user-access-token-management
 */

import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { URL, URLSearchParams } from 'node:url'

import type { SocialOAuthProvider } from '../contracts/social-publishing.js'
import type { SocialAccountTokenSecret } from '../services/app-secrets-store.js'
import { socialTransport } from './social-publish/types.js'

export const SOCIAL_OAUTH_TERMINAL_RETENTION_MS = 5 * 60 * 1000
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/** What the owner's app must be approved for. Shown in Settings so setup is not a guess. */
export const SOCIAL_SCOPES: Record<SocialOAuthProvider, readonly string[]> = {
  meta: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'],
  tiktok: ['user.info.basic', 'video.publish'],
}

const META_AUTH_URL = 'https://www.facebook.com/v26.0/dialog/oauth'
const META_TOKEN_URL = 'https://graph.facebook.com/v26.0/oauth/access_token'
const META_PAGES_URL = 'https://graph.facebook.com/v26.0/me/accounts'
const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/'
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'

export interface SocialConnectedAccount {
  platform: 'facebook' | 'instagram' | 'tiktok'
  remote_id: string
  remote_name: string
  /** Facebook / Instagram: the Page the post is made on. */
  page_id?: string
  tokens: SocialAccountTokenSecret
}

export interface SocialOAuthFlowResult {
  accounts: SocialConnectedAccount[]
  granted_scopes: string[]
}

export interface SocialOAuthFlowStatus {
  status: 'pending' | 'success' | 'error' | 'unknown'
  flow_id: string
  result?: { accounts: Array<Omit<SocialConnectedAccount, 'tokens'>>; granted_scopes: string[] }
  error?: string
  error_code?: string
}

/** The provider seam. Tests inject this; production passes nothing. */
export interface SocialOAuthDeps {
  exchangeCode(input: {
    provider: SocialOAuthProvider
    code: string
    code_verifier: string
    redirect_uri: string
    client_id: string
    client_secret: string
  }): Promise<{ access_token: string; refresh_token: string; expires_at: number; scope?: string; open_id?: string }>
  fetchAccounts(input: {
    provider: SocialOAuthProvider
    access_token: string
    app_id: string
  }): Promise<SocialConnectedAccount[]>
  createCallbackServer?: (input: {
    host: string
    port: number
    path: string
    onRequest: (request: { host: string; port: number; path: string; query: Record<string, string> }) => Promise<string>
  }) => Promise<{ close(): Promise<void>; redirect_uri: string }>
  openExternal?: (url: string) => Promise<void>
  now?: () => Date
}

interface PendingFlow {
  flow_id: string
  provider: SocialOAuthProvider
  state: string
  code_verifier: string
  client_id: string
  client_secret: string
  app_id: string
  redirect_uri: string
  server: { close(): Promise<void> }
  deps: SocialOAuthDeps
  clock: () => Date
  timeout: NodeJS.Timeout
  settled: boolean
  resolve: (result: SocialOAuthFlowResult) => void
  reject: (error: Error) => void
}

interface FinishedFlow {
  ok: boolean
  result?: SocialOAuthFlowResult
  error?: string
  error_code?: string
  expires_at: number
  clock: () => Date
}

const pending = new Map<string, PendingFlow>()
const finished = new Map<string, FinishedFlow>()

function nowMs(clock: () => Date): number {
  const value = clock().getTime()
  return Number.isFinite(value) ? value : Date.now()
}

function pkceVerifier(): string {
  // 43–128 characters from the allowed set; 32 random bytes as base64url is 43.
  return randomBytes(32).toString('base64url')
}

/**
 * TikTok requires the HEX encoding of SHA-256 here, which is not RFC 7636's
 * base64url. Its desktop guide says so explicitly; sending the standard form
 * makes the token exchange fail.
 */
function challengeFor(provider: SocialOAuthProvider, verifier: string): string {
  const digest = createHash('sha256').update(verifier).digest()
  return provider === 'tiktok' ? digest.toString('hex') : digest.toString('base64url')
}

function authorizationUrl(input: {
  provider: SocialOAuthProvider
  client_id: string
  redirect_uri: string
  state: string
  code_challenge: string
}): string {
  if (input.provider === 'tiktok') {
    return `${TIKTOK_AUTH_URL}?${new URLSearchParams({
      client_key: input.client_id,
      scope: SOCIAL_SCOPES.tiktok.join(','),
      redirect_uri: input.redirect_uri,
      state: input.state,
      response_type: 'code',
      code_challenge: input.code_challenge,
      code_challenge_method: 'S256',
    }).toString()}`
  }
  return `${META_AUTH_URL}?${new URLSearchParams({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    response_type: 'code',
    scope: SOCIAL_SCOPES.meta.join(','),
    state: input.state,
  }).toString()}`
}

function callbackHtml(ok: boolean): string {
  const title = ok ? 'Account connected' : 'Connection failed'
  const body = ok
    ? 'Story Studio saved this account. You can close this window.'
    : 'Story Studio could not connect that account. Return to Story Studio and try again.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:system-ui;padding:40px;max-width:520px"><h1>${title}</h1><p>${body}</p></body></html>`
}

async function createDefaultCallbackServer(input: {
  host: string
  port: number
  path: string
  onRequest: (request: { host: string; port: number; path: string; query: Record<string, string> }) => Promise<string>
}): Promise<{ close(): Promise<void>; redirect_uri: string }> {
  const server = http.createServer((req, res) => {
    let parsed: URL
    try {
      parsed = new URL(req.url || '/', `http://${input.host}:${input.port}`)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(callbackHtml(false))
      return
    }
    const query = Object.fromEntries(parsed.searchParams.entries())
    void input.onRequest({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : input.port,
      path: parsed.pathname,
      query,
    }).then(html => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      }
    }).catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(callbackHtml(false))
      }
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      if (typeof address === 'object' && address && address.port) resolve(address.port)
      else reject(new Error('Could not allocate loopback port'))
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(input.port, input.host)
  })

  return {
    redirect_uri: `http://${input.host}:${port}${input.path}`,
    close: () => new Promise<void>(resolve => {
      if (!server.listening) { resolve(); return }
      server.close(() => resolve())
    }),
  }
}

async function productionExchangeCode(input: {
  provider: SocialOAuthProvider
  code: string
  code_verifier: string
  redirect_uri: string
  client_id: string
  client_secret: string
}): Promise<{ access_token: string; refresh_token: string; expires_at: number; scope?: string; open_id?: string }> {
  if (input.provider === 'tiktok') {
    const response = await socialTransport(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: input.client_id,
        client_secret: input.client_secret,
        code: decodeURIComponent(input.code),
        grant_type: 'authorization_code',
        redirect_uri: input.redirect_uri,
        code_verifier: input.code_verifier,
      }).toString(),
    })
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
      const detail = typeof body?.error_description === 'string' ? body.error_description : ''
      throw Object.assign(new Error(detail || 'TikTok rejected the sign-in.'), { code: 'SOCIAL_OAUTH_REJECTED' })
    }
    const expiresIn = Number(body.expires_in)
    return {
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : '',
      expires_at: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86_400) * 1000,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
      ...(typeof body.open_id === 'string' ? { open_id: body.open_id } : {}),
    }
  }

  const tokenUrl = `${META_TOKEN_URL}?${new URLSearchParams({
    client_id: input.client_id,
    client_secret: input.client_secret,
    redirect_uri: input.redirect_uri,
    code: input.code,
  }).toString()}`
  const response = await socialTransport(tokenUrl, { method: 'GET' })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
    const detail = typeof body?.error === 'object' && body.error
      ? String((body.error as { message?: unknown }).message ?? '')
      : ''
    throw Object.assign(new Error(detail || 'Facebook rejected the sign-in.'), { code: 'SOCIAL_OAUTH_REJECTED' })
  }
  const expiresIn = Number(body.expires_in)
  return {
    access_token: body.access_token,
    // Meta has no refresh token in this flow: a long-lived user token is
    // exchanged for a Page token, and both are re-acquired by connecting again.
    refresh_token: '',
    expires_at: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3_600) * 1000,
  }
}

/**
 * Read the Pages this sign-in can post to, and for each Page the Instagram
 * professional account it owns. One sign-in can therefore connect several
 * accounts at once — the owner picks which ones to keep in Settings.
 */
async function productionFetchAccounts(input: {
  provider: SocialOAuthProvider
  access_token: string
  app_id: string
}): Promise<SocialConnectedAccount[]> {
  if (input.provider === 'tiktok') {
    // TikTok identifies the account by open_id, which the token exchange
    // returned. The caller has already put it on the token bundle.
    return []
  }
  const pagesResponse = await socialTransport(`${META_PAGES_URL}?${new URLSearchParams({
    fields: 'id,name,access_token,instagram_business_account{id,username,name}',
    access_token: input.access_token,
  }).toString()}`)
  const body = await pagesResponse.json().catch(() => null) as {
    data?: Array<{
      id?: string
      name?: string
      access_token?: string
      instagram_business_account?: { id?: string; username?: string; name?: string }
    }>
    error?: { message?: string }
  } | null
  if (!pagesResponse.ok || !body) {
    throw Object.assign(new Error(body?.error?.message || 'Facebook would not list the Pages for this sign-in.'), { code: 'SOCIAL_OAUTH_REJECTED' })
  }
  const accounts: SocialConnectedAccount[] = []
  for (const page of body.data || []) {
    if (!page.id || !page.access_token) continue
    const tokens: SocialAccountTokenSecret = {
      application_id: input.app_id,
      access_token: input.access_token,
      refresh_token: '',
      expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
      page_token: page.access_token,
    }
    accounts.push({
      platform: 'facebook',
      remote_id: page.id,
      remote_name: page.name || page.id,
      page_id: page.id,
      tokens,
    })
    const ig = page.instagram_business_account
    if (ig?.id) {
      accounts.push({
        platform: 'instagram',
        remote_id: ig.id,
        remote_name: ig.username ? `@${ig.username}` : (ig.name || ig.id),
        page_id: page.id,
        tokens: { ...tokens },
      })
    }
  }
  return accounts
}

async function handleCallback(flow: PendingFlow, request: { query: Record<string, string> }): Promise<string> {
  if (flow.settled) return callbackHtml(false)
  const { query } = request
  if (query.state !== flow.state) {
    settleFailure(flow, 'SOCIAL_OAUTH_STATE_MISMATCH', 'The sign-in security state did not match. Please start again.')
    return callbackHtml(false)
  }
  if (query.error || query.error_description) {
    settleFailure(flow, 'SOCIAL_OAUTH_REJECTED', query.error_description || 'The provider refused the sign-in.')
    return callbackHtml(false)
  }
  if (!query.code) {
    settleFailure(flow, 'SOCIAL_OAUTH_REJECTED', 'The provider did not return an authorization code.')
    return callbackHtml(false)
  }
  try {
    const tokens = await flow.deps.exchangeCode({
      provider: flow.provider,
      code: query.code,
      code_verifier: flow.code_verifier,
      redirect_uri: flow.redirect_uri,
      client_id: flow.client_id,
      client_secret: flow.client_secret,
    })
    let accounts = await flow.deps.fetchAccounts({
      provider: flow.provider,
      access_token: tokens.access_token,
      app_id: flow.app_id,
    })
    if (flow.provider === 'tiktok') {
      const openId = tokens.open_id
      if (!openId) throw new Error('TikTok did not return the account id, so the account cannot be identified.')
      accounts = [{
        platform: 'tiktok',
        remote_id: openId,
        remote_name: openId,
        tokens: {
          application_id: flow.app_id,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          ...(tokens.scope ? { scope: tokens.scope } : {}),
        },
      }]
    }
    if (!accounts.length) {
      settleFailure(flow, 'SOCIAL_OAUTH_REJECTED', 'That sign-in gave Story Studio no account it can post to. Check that the Page or professional account exists and that the app is approved for posting.')
      return callbackHtml(false)
    }
    settleSuccess(flow, { accounts, granted_scopes: tokens.scope ? tokens.scope.split(/[,\s]+/).filter(Boolean) : [] })
    return callbackHtml(true)
  } catch (error) {
    settleFailure(flow, 'SOCIAL_OAUTH_REJECTED', (error as Error)?.message || 'The provider refused the sign-in.')
    return callbackHtml(false)
  }
}

function settleSuccess(flow: PendingFlow, result: SocialOAuthFlowResult): void {
  if (flow.settled) return
  flow.settled = true
  clearTimeout(flow.timeout)
  void flow.server.close()
  pending.delete(flow.flow_id)
  finished.set(flow.flow_id, { ok: true, result, expires_at: nowMs(flow.clock) + SOCIAL_OAUTH_TERMINAL_RETENTION_MS, clock: flow.clock })
  schedulePurge(flow.flow_id)
  flow.resolve(result)
}

function settleFailure(flow: PendingFlow, error_code: string, error: string): void {
  if (flow.settled) return
  flow.settled = true
  clearTimeout(flow.timeout)
  void flow.server.close()
  pending.delete(flow.flow_id)
  finished.set(flow.flow_id, { ok: false, error, error_code, expires_at: nowMs(flow.clock) + SOCIAL_OAUTH_TERMINAL_RETENTION_MS, clock: flow.clock })
  schedulePurge(flow.flow_id)
  flow.reject(Object.assign(new Error(error), { code: error_code }))
}

function schedulePurge(flowId: string): void {
  const timer = setTimeout(() => { finished.delete(flowId) }, SOCIAL_OAUTH_TERMINAL_RETENTION_MS)
  timer.unref?.()
}

export async function startSocialOAuthFlow(input: {
  provider: SocialOAuthProvider
  client_id: string
  client_secret: string
  app_id: string
  /** The loopback URI the owner registered. The server binds its port. */
  redirect_uri: string
  deps?: SocialOAuthDeps
}): Promise<{ flow_id: string; auth_url: string; promise: Promise<SocialOAuthFlowResult> }> {
  let target: URL
  try { target = new URL(input.redirect_uri) } catch { throw new Error('The saved redirect URI is not a valid address.') }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
    throw new Error('The redirect URI must be http://127.0.0.1:<port>/callback. Save that address for this application first.')
  }

  const deps: SocialOAuthDeps = {
    exchangeCode: productionExchangeCode,
    fetchAccounts: productionFetchAccounts,
    ...input.deps,
  }
  const clock = deps.now ?? (() => new Date())
  const flow_id = randomUUID()
  const state = randomBytes(16).toString('hex')
  const code_verifier = pkceVerifier()
  const createServer = deps.createCallbackServer || createDefaultCallbackServer
  const server = await createServer({
    host: target.hostname,
    port: target.port ? Number(target.port) : 0,
    path: target.pathname,
    onRequest: request => handleCallback(flow, { query: request.query }),
  })

  let resolvePromise: (result: SocialOAuthFlowResult) => void = () => {}
  let rejectPromise: (error: Error) => void = () => {}
  const promise = new Promise<SocialOAuthFlowResult>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  // The promise is consumed by the connect service, which turns a rejection
  // into a readable status. An unobserved rejection here would crash the process.
  promise.catch(() => {})

  const flow: PendingFlow = {
    flow_id,
    provider: input.provider,
    state,
    code_verifier,
    client_id: input.client_id,
    client_secret: input.client_secret,
    app_id: input.app_id,
    redirect_uri: server.redirect_uri,
    server,
    deps,
    clock,
    timeout: setTimeout(() => {
      settleFailure(flow, 'SOCIAL_OAUTH_TIMEOUT', 'The sign-in timed out. Please start again.')
    }, CALLBACK_TIMEOUT_MS),
    settled: false,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
  flow.timeout.unref?.()
  pending.set(flow_id, flow)

  const auth_url = authorizationUrl({
    provider: input.provider,
    client_id: input.client_id,
    redirect_uri: server.redirect_uri,
    state,
    code_challenge: challengeFor(input.provider, code_verifier),
  })

  if (deps.openExternal) {
    void deps.openExternal(auth_url).catch(() => {
      settleFailure(flow, 'SOCIAL_OAUTH_UNAVAILABLE', 'Story Studio could not open the sign-in page.')
    })
  }

  return { flow_id, auth_url, promise }
}

/** Token-free public projection, exactly like the YouTube flow's. */
export function getSocialFlowStatus(flow_id: string): SocialOAuthFlowStatus {
  if (pending.has(flow_id)) return { status: 'pending', flow_id }
  const done = finished.get(flow_id)
  if (!done) return { status: 'unknown', flow_id, error: 'This sign-in is no longer available. Start again.', error_code: 'SOCIAL_OAUTH_FLOW_UNKNOWN' }
  if (done.expires_at <= nowMs(done.clock)) {
    finished.delete(flow_id)
    return { status: 'unknown', flow_id, error: 'This sign-in is no longer available. Start again.', error_code: 'SOCIAL_OAUTH_FLOW_UNKNOWN' }
  }
  if (!done.ok || !done.result) {
    return { status: 'error', flow_id, error: done.error || 'The sign-in failed.', error_code: done.error_code }
  }
  return {
    status: 'success',
    flow_id,
    result: {
      // The tokens never leave the server: the public projection is identity only.
      accounts: done.result.accounts.map(account => ({
        platform: account.platform,
        remote_id: account.remote_id,
        remote_name: account.remote_name,
        ...(account.page_id ? { page_id: account.page_id } : {}),
      })),
      granted_scopes: done.result.granted_scopes,
    },
  }
}

/** Test-only: drop every in-memory flow so one test cannot see another's. */
export function __resetSocialOAuthFlowsForTests(): void {
  for (const flow of pending.values()) {
    clearTimeout(flow.timeout)
    void flow.server.close()
  }
  pending.clear()
  finished.clear()
}
