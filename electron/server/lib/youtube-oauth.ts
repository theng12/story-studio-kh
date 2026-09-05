/**
 * Server-only YouTube OAuth helpers.
 *
 * The desktop app uses a loopback redirect for a one-shot authorization-code
 * flow. Credentials and token bundles stay inside the server boundary; the
 * public polling status is deliberately only a token-free projection of the
 * result; credentials never cross the server boundary.
 */

import http from 'http'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { URL, URLSearchParams } from 'url'

import type { OAuthTokenBundle } from '../services/app-secrets-store.js'

export type { OAuthTokenBundle } from '../services/app-secrets-store.js'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GOOGLE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'
const LOOPBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
export const YOUTUBE_OAUTH_TERMINAL_RETENTION_MS = 5 * 60 * 1000

/** The only YouTube permissions requested by the owner connection flow. */
export const YOUTUBE_OWNER_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const

/** Kept for legacy analytics callers that gate an older token bundle. */
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly'

export function tokenHasAnalyticsScope(scope: string | undefined | null): boolean {
  if (!scope) return false
  return scope.split(/\s+/).includes(ANALYTICS_SCOPE)
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
  promise: Promise<OAuthFlowResult>
  cancel: () => void
}

export interface OAuthRefreshTransportResponse {
  access_token: string
  refresh_token?: string
  expires_at: number
  scope?: string
}

export type OAuthRefreshTransport = (input: {
  refresh_token: string
  client_id: string
  client_secret: string
}) => Promise<OAuthRefreshTransportResponse>

export interface OAuthFlowDeps {
  openExternal?: (url: string) => Promise<void>
  exchangeCode(input: {
    code: string
    code_verifier: string
    redirect_uri: string
    client_id: string
    client_secret: string
  }): Promise<OAuthTokenBundle>
  fetchPrimaryChannel(input: {
    access_token: string
  }): Promise<{
    channel_id: string
    channel_title: string
    custom_url?: string
    thumbnail_url?: string
  } | null>
  refreshAccessToken: OAuthRefreshTransport
  now?: () => Date
  createCallbackServer?: (input: {
    host: string
    port: number
    path: string
    onRequest: (request: { host: string; port: number; path: string; query: Record<string, string> }) => Promise<string>
  }) => Promise<{ close(): Promise<void>; redirect_uri: string }>
}

export type YouTubeOAuthPublicErrorCode =
  | 'YOUTUBE_OAUTH_PROVIDER_REJECTED'
  | 'YOUTUBE_OAUTH_UNAVAILABLE'
  | 'YOUTUBE_OAUTH_STATE_MISMATCH'
  | 'YOUTUBE_OAUTH_REDIRECT_MISMATCH'
  | 'YOUTUBE_OAUTH_TIMEOUT'
  | 'YOUTUBE_OAUTH_CANCELLED'
  | 'YOUTUBE_OAUTH_FLOW_UNKNOWN'

export type YouTubeOAuthPublicStatus =
  | { status: 'pending'; flow_id: string; result?: undefined; error?: undefined; error_code?: undefined }
  | {
      status: 'success'
      flow_id: string
      result: {
        channel: {
          channel_id: string
          channel_title: string
          custom_url?: string
          thumbnail_url?: string
        }
        granted_scopes?: string[]
      }
      error?: undefined
      error_code?: undefined
    }
  | {
      status: 'error'
      flow_id: string
      result?: undefined
      error: string
      error_code: Exclude<YouTubeOAuthPublicErrorCode, 'YOUTUBE_OAUTH_FLOW_UNKNOWN'>
    }
  | {
      status: 'unknown'
      flow_id: string
      result?: undefined
      error: 'This OAuth flow is no longer available. Start again.'
      error_code: 'YOUTUBE_OAUTH_FLOW_UNKNOWN'
    }

type OAuthTerminalErrorCode = Exclude<YouTubeOAuthPublicErrorCode, 'YOUTUBE_OAUTH_FLOW_UNKNOWN'>
type CallbackRequest = { host: string; port: number; path: string; query: Record<string, string> }
type CallbackServer = { close(): Promise<void>; redirect_uri: string }

const PUBLIC_ERROR_MESSAGES: Record<OAuthTerminalErrorCode, string> = {
  YOUTUBE_OAUTH_PROVIDER_REJECTED: 'YouTube rejected the authorization request. Please try again.',
  YOUTUBE_OAUTH_UNAVAILABLE: 'YouTube is unavailable right now. Please try again.',
  YOUTUBE_OAUTH_STATE_MISMATCH: 'The OAuth security state did not match. Please start again.',
  YOUTUBE_OAUTH_REDIRECT_MISMATCH: 'The OAuth redirect did not match. Please start again.',
  YOUTUBE_OAUTH_TIMEOUT: 'The OAuth flow timed out. Please start again.',
  YOUTUBE_OAUTH_CANCELLED: 'The OAuth flow was cancelled. Please try again.',
}

const UNKNOWN_STATUS: Omit<Extract<YouTubeOAuthPublicStatus, { status: 'unknown' }>, 'flow_id'> = {
  status: 'unknown',
  error: 'This OAuth flow is no longer available. Start again.',
  error_code: 'YOUTUBE_OAUTH_FLOW_UNKNOWN',
}

interface PendingFlow {
  flow_id: string
  state_token: string
  code_verifier: string
  client_id: string
  client_secret: string
  redirect_uri: string
  redirect_host: string
  redirect_port: number
  redirect_path: string
  server: CallbackServer
  deps?: OAuthFlowDeps
  clock: () => Date
  resolve: (result: OAuthFlowResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  abort_controller: AbortController
  terminal: Promise<never>
  terminate: (error: Error) => void
  terminal_error_code?: OAuthTerminalErrorCode
  claimed: boolean
  settled: boolean
  closeStarted: boolean
  closePromise?: Promise<void>
}

type FinishedFlow =
  | { ok: true; result: OAuthFlowResult; expires_at: number; clock: () => Date }
  | { ok: false; error_code: OAuthTerminalErrorCode; error: string; expires_at: number; clock: () => Date }

// `pending` contains callbacks that have not yet been claimed. `active` holds
// a claimed callback while its injected exchange/channel lookups are in flight;
// keeping it separate makes the claim boundary explicit and lets polling stay
// `pending` without exposing any internal flow material.
const pending = new Map<string, PendingFlow>()
const active = new Map<string, PendingFlow>()
const finished = new Map<string, FinishedFlow>()

function normalizeScope(scope: unknown): string | undefined {
  if (typeof scope !== 'string') return undefined
  const normalized = scope.trim().split(/\s+/).filter(Boolean).join(' ')
  return normalized || undefined
}

function normalizeTokenBundle(value: unknown): OAuthTokenBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OAuth provider returned an invalid token bundle')
  }
  const input = value as Record<string, unknown>
  if (typeof input.access_token !== 'string' || !input.access_token
    || typeof input.refresh_token !== 'string' || !input.refresh_token
    || typeof input.expires_at !== 'number' || !Number.isFinite(input.expires_at)) {
    throw new Error('OAuth provider returned an invalid token bundle')
  }
  const result: OAuthTokenBundle = {
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    expires_at: input.expires_at,
  }
  const scope = normalizeScope(input.scope)
  if (scope) result.scope = scope
  return result
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function makeAuthorizationUrl(input: {
  client_id: string
  redirect_uri: string
  state: string
  code_challenge: string
}): string {
  return `${GOOGLE_AUTH_URL}?${new URLSearchParams({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    response_type: 'code',
    scope: YOUTUBE_OWNER_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
    code_challenge: input.code_challenge,
    code_challenge_method: 'S256',
  }).toString()}`
}

function parseRedirectTarget(redirect_uri: string): {
  host: string
  port: number
  path: string
} {
  let parsed: URL
  try {
    parsed = new URL(redirect_uri)
  } catch {
    throw new Error('OAuth callback server returned an invalid redirect')
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password
    || !parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535
    || !parsed.pathname || parsed.search || parsed.hash) {
    throw new Error('OAuth callback server returned an invalid redirect')
  }
  return { host: parsed.hostname, port, path: parsed.pathname }
}

function nowMs(clock: () => Date): number {
  const value = clock().getTime()
  return Number.isFinite(value) ? value : Date.now()
}

function scheduleFinishedPurge(flow_id: string): void {
  const timer = setTimeout(() => { finished.delete(flow_id) }, YOUTUBE_OAUTH_TERMINAL_RETENTION_MS)
  timer.unref?.()
}

function unknownStatus(flow_id: string): YouTubeOAuthPublicStatus {
  return { ...UNKNOWN_STATUS, flow_id }
}

function terminalError(code: OAuthTerminalErrorCode): Error {
  return new Error(PUBLIC_ERROR_MESSAGES[code])
}

function closeFlowServer(flow: PendingFlow): Promise<void> {
  if (flow.closeStarted) return flow.closePromise || Promise.resolve()
  flow.closeStarted = true
  try {
    flow.closePromise = Promise.resolve(flow.server.close()).catch(() => {})
  } catch {
    flow.closePromise = Promise.resolve()
  }
  return flow.closePromise
}

function clearPrivateFlowFields(flow: PendingFlow): void {
  flow.code_verifier = ''
  flow.client_secret = ''
  flow.state_token = ''
}

function settleFailure(flow: PendingFlow, error_code: OAuthTerminalErrorCode): boolean {
  if (flow.settled) return false
  flow.settled = true
  flow.terminal_error_code = error_code
  pending.delete(flow.flow_id)
  active.delete(flow.flow_id)
  clearTimeout(flow.timeout)
  finished.set(flow.flow_id, {
    ok: false,
    error_code,
    error: PUBLIC_ERROR_MESSAGES[error_code],
    expires_at: nowMs(flow.clock) + YOUTUBE_OAUTH_TERMINAL_RETENTION_MS,
    clock: flow.clock,
  })
  scheduleFinishedPurge(flow.flow_id)
  void closeFlowServer(flow)
  flow.abort_controller.abort()
  flow.terminate(terminalError(error_code))
  flow.reject(terminalError(error_code))
  clearPrivateFlowFields(flow)
  return true
}

function settleSuccess(flow: PendingFlow, result: OAuthFlowResult): boolean {
  if (flow.settled) return false
  flow.settled = true
  pending.delete(flow.flow_id)
  active.delete(flow.flow_id)
  clearTimeout(flow.timeout)
  finished.set(flow.flow_id, {
    ok: true,
    result,
    expires_at: nowMs(flow.clock) + YOUTUBE_OAUTH_TERMINAL_RETENTION_MS,
    clock: flow.clock,
  })
  scheduleFinishedPurge(flow.flow_id)
  void closeFlowServer(flow)
  flow.resolve(result)
  clearPrivateFlowFields(flow)
  return true
}

function claimFlow(flow_id: string): PendingFlow | null {
  const flow = pending.get(flow_id)
  if (!flow || flow.claimed || flow.settled) return null
  // This synchronous delete is the compare-and-swap boundary: a second
  // callback cannot observe an unclaimed entry while the first awaits I/O.
  pending.delete(flow_id)
  flow.claimed = true
  active.set(flow_id, flow)
  return flow
}

function mapProviderError(error: unknown): OAuthTerminalErrorCode {
  if (error instanceof TypeError) return 'YOUTUBE_OAUTH_UNAVAILABLE'
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    const status = Number(value.status ?? value.statusCode ?? value.status_code
      ?? (value.response && typeof value.response === 'object'
        ? (value.response as Record<string, unknown>).status
        : undefined))
    if (Number.isFinite(status) && status >= 500) return 'YOUTUBE_OAUTH_UNAVAILABLE'
    const providerCode = [value.code, value.error, value.error_code]
      .find(candidate => typeof candidate === 'string') as string | undefined
    const normalizedCode = providerCode?.toLowerCase() || ''
    if (normalizedCode === 'access_denied') return 'YOUTUBE_OAUTH_CANCELLED'
    if (normalizedCode === 'invalid_grant' || normalizedCode === 'invalid_client'
      || normalizedCode === 'unauthorized_client' || normalizedCode === 'invalid_request') {
      return 'YOUTUBE_OAUTH_PROVIDER_REJECTED'
    }
    if (value.name === 'TypeError') return 'YOUTUBE_OAUTH_UNAVAILABLE'
    const message = typeof value.message === 'string' ? value.message.toLowerCase() : ''
    if (/network|fetch failed|socket|connection|timed out|timeout|temporarily unavailable/.test(message)) {
      return 'YOUTUBE_OAUTH_UNAVAILABLE'
    }
    if (normalizedCode === 'econnreset' || normalizedCode === 'etimedout'
      || normalizedCode === 'enotfound' || normalizedCode === 'temporarily_unavailable') {
      return 'YOUTUBE_OAUTH_UNAVAILABLE'
    }
  }
  return 'YOUTUBE_OAUTH_PROVIDER_REJECTED'
}

function callbackErrorHtml(code: OAuthTerminalErrorCode): string {
  return htmlPage({ title: 'Connection failed', body: escapeHtml(PUBLIC_ERROR_MESSAGES[code]) })
}

function callbackUnknownHtml(): string {
  return htmlPage({ title: 'Connection unavailable', body: escapeHtml(UNKNOWN_STATUS.error) })
}

function callbackSettledHtml(flow: PendingFlow): string {
  return flow.terminal_error_code
    ? callbackErrorHtml(flow.terminal_error_code)
    : callbackUnknownHtml()
}

function raceWithFlowTermination<T>(flow: PendingFlow, operation: Promise<T>): Promise<T> {
  return Promise.race([operation, flow.terminal])
}

async function handleCallback(flow_id: string, request: CallbackRequest): Promise<string> {
  // Once a callback has been claimed, every later request is harmless. In
  // particular, a late malformed/foreign duplicate must not be able to turn
  // an already-running provider exchange into a redirect failure.
  if (active.has(flow_id)) return callbackUnknownHtml()
  const existing = pending.get(flow_id)
  if (!existing || existing.settled) return callbackUnknownHtml()

  if (request.host !== existing.redirect_host
    || request.port !== existing.redirect_port
    || request.path !== existing.redirect_path) {
    settleFailure(existing, 'YOUTUBE_OAUTH_REDIRECT_MISMATCH')
    return callbackErrorHtml('YOUTUBE_OAUTH_REDIRECT_MISMATCH')
  }

  const returnedState = typeof request.query.state === 'string' ? request.query.state : ''
  if (returnedState !== existing.state_token) {
    settleFailure(existing, 'YOUTUBE_OAUTH_STATE_MISMATCH')
    return callbackErrorHtml('YOUTUBE_OAUTH_STATE_MISMATCH')
  }

  const flow = claimFlow(flow_id)
  if (!flow) return callbackUnknownHtml()

  const providerError = typeof request.query.error === 'string' ? request.query.error : ''
  if (providerError) {
    const code = providerError === 'access_denied'
      ? 'YOUTUBE_OAUTH_CANCELLED'
      : 'YOUTUBE_OAUTH_PROVIDER_REJECTED'
    settleFailure(flow, code)
    return callbackErrorHtml(code)
  }

  const code = typeof request.query.code === 'string' ? request.query.code : ''
  if (!code) {
    settleFailure(flow, 'YOUTUBE_OAUTH_PROVIDER_REJECTED')
    return callbackErrorHtml('YOUTUBE_OAUTH_PROVIDER_REJECTED')
  }

  try {
    const deps = flow.deps
    if (flow.settled) return callbackSettledHtml(flow)
    const exchange = deps
      ? Promise.resolve().then(() => deps.exchangeCode({
          code,
          code_verifier: flow.code_verifier,
          redirect_uri: flow.redirect_uri,
          client_id: flow.client_id,
          client_secret: flow.client_secret,
        }))
      : exchangeCodeForTokens({
          code,
          code_verifier: flow.code_verifier,
          client_id: flow.client_id,
          client_secret: flow.client_secret,
          redirect_uri: flow.redirect_uri,
          signal: flow.abort_controller.signal,
        })
    const tokens = normalizeTokenBundle(await raceWithFlowTermination(flow, exchange))
    if (flow.settled) return callbackSettledHtml(flow)

    const channel = deps
      ? await raceWithFlowTermination(
          flow,
          Promise.resolve().then(() => deps.fetchPrimaryChannel({ access_token: tokens.access_token })),
        )
      : await raceWithFlowTermination(flow, fetchPrimaryChannel(tokens.access_token, flow.abort_controller.signal))
    if (!channel || typeof channel.channel_id !== 'string' || !channel.channel_id
      || typeof channel.channel_title !== 'string' || !channel.channel_title) {
      throw new Error('OAuth provider returned no primary channel')
    }
    if (flow.settled) return callbackSettledHtml(flow)

    const result: OAuthFlowResult = {
      tokens,
      channel: {
        channel_id: channel.channel_id,
        channel_title: channel.channel_title,
        ...(typeof channel.custom_url === 'string' ? { custom_url: channel.custom_url } : {}),
        ...(typeof channel.thumbnail_url === 'string' ? { thumbnail_url: channel.thumbnail_url } : {}),
      },
    }
    settleSuccess(flow, result)
    const title = escapeHtml(result.channel.channel_title)
    return htmlPage({
      title: 'Connected to YouTube',
      body: `Connected to <strong>${title}</strong>. You can close this window and return to Story Studio.`,
    })
  } catch (error) {
    if (flow.settled) return callbackSettledHtml(flow)
    const code = mapProviderError(error)
    settleFailure(flow, code)
    return callbackErrorHtml(code)
  }
}

async function createDefaultCallbackServer(input: {
  host: string
  port: number
  path: string
  onRequest: (request: CallbackRequest) => Promise<string>
}): Promise<CallbackServer> {
  const server = http.createServer((req, res) => {
    let parsed: URL | null = null
    try {
      const hostHeader = typeof req.headers.host === 'string' && req.headers.host
        ? req.headers.host
        : `${input.host}:${input.port}`
      parsed = new URL(req.url || '/', `http://${hostHeader}`)
    } catch {
      respondHtml(res, callbackErrorHtml('YOUTUBE_OAUTH_REDIRECT_MISMATCH'))
      return
    }
    const requestPort = parsed.port ? Number(parsed.port) : input.port
    const query = Object.fromEntries(parsed.searchParams.entries())
    void input.onRequest({
      host: parsed.hostname,
      port: requestPort,
      path: parsed.pathname,
      query,
    }).then(html => {
      if (!res.writableEnded) respondHtml(res, html)
    }).catch(() => {
      if (!res.writableEnded) respondHtml(res, callbackUnknownHtml())
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
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
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    }),
  }
}

/**
 * Starts the loopback flow. In production the returned URL is handed to the
 * caller; only an explicitly injected opener is invoked, which keeps the old
 * URL-returning route from opening the browser a second time.
 */
export async function startOAuthFlow(input: {
  client_id: string
  client_secret: string
  timeout_ms?: number
  deps?: OAuthFlowDeps
}): Promise<OAuthFlowState> {
  if (!input.client_id || !input.client_secret) {
    throw new Error('client_id and client_secret are required.')
  }

  const flow_id = randomUUID()
  const state_token = randomBytes(16).toString('hex')
  const pkce = createPkce()
  const createServer = input.deps?.createCallbackServer || createDefaultCallbackServer
  let server: CallbackServer
  try {
    server = await createServer({
      host: LOOPBACK_HOST,
      port: 0,
      path: CALLBACK_PATH,
      onRequest: request => handleCallback(flow_id, request),
    })
  } catch {
    throw terminalError('YOUTUBE_OAUTH_UNAVAILABLE')
  }
  let redirect: { host: string; port: number; path: string }
  try {
    redirect = parseRedirectTarget(server.redirect_uri)
  } catch {
    try {
      await server.close()
    } catch {
      // Callback-server cleanup is best effort; the public setup error stays stable.
    }
    throw terminalError('YOUTUBE_OAUTH_UNAVAILABLE')
  }

  const auth_url = makeAuthorizationUrl({
    client_id: input.client_id,
    redirect_uri: server.redirect_uri,
    state: state_token,
    code_challenge: pkce.challenge,
  })

  let resolvePromise!: (result: OAuthFlowResult) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<OAuthFlowResult>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  // The caller cannot attach a handler until this function returns. Keep all
  // pre-return terminal paths observed without changing the public promise.
  void promise.catch(() => {})
  let terminate!: (error: Error) => void
  const terminal = new Promise<never>((_, reject) => { terminate = reject })
  // Timeout/cancel can terminate a flow before a callback claims it.
  void terminal.catch(() => {})
  const clock = input.deps?.now || (() => new Date())
  const timeoutMs = typeof input.timeout_ms === 'number' && Number.isFinite(input.timeout_ms) && input.timeout_ms >= 0
    ? input.timeout_ms
    : DEFAULT_TIMEOUT_MS

  let flow!: PendingFlow
  const timeout = setTimeout(() => {
    if (!flow.settled) settleFailure(flow, 'YOUTUBE_OAUTH_TIMEOUT')
  }, timeoutMs)
  timeout.unref?.()
  flow = {
    flow_id,
    state_token,
    code_verifier: pkce.verifier,
    client_id: input.client_id,
    client_secret: input.client_secret,
    redirect_uri: server.redirect_uri,
    redirect_host: redirect.host,
    redirect_port: redirect.port,
    redirect_path: redirect.path,
    server,
    deps: input.deps,
    clock,
    resolve: resolvePromise,
    reject: rejectPromise,
    timeout,
    abort_controller: new AbortController(),
    terminal,
    terminate,
    claimed: false,
    settled: false,
    closeStarted: false,
  }
  pending.set(flow_id, flow)

  if (input.deps?.openExternal) {
    const openExternal = input.deps.openExternal
    const opener = Promise.resolve().then(() => openExternal(auth_url))
    const flowFinished = promise.then(() => undefined, () => undefined)
    void Promise.race([opener, flow.terminal, flowFinished]).catch(() => {
      if (!flow.settled) settleFailure(flow, 'YOUTUBE_OAUTH_UNAVAILABLE')
    })
  }

  return {
    flow_id,
    auth_url,
    promise,
    cancel: () => {
      const current = pending.get(flow_id) || active.get(flow_id)
      if (current) settleFailure(current, 'YOUTUBE_OAUTH_CANCELLED')
    },
  }
}

/** Returns the token-free public projection used by connection status services. */
export function getFlowStatus(flow_id: string): YouTubeOAuthPublicStatus {
  if (pending.has(flow_id) || active.has(flow_id)) return { status: 'pending', flow_id }
  const done = finished.get(flow_id)
  if (!done) return unknownStatus(flow_id)
  if (done.expires_at <= nowMs(done.clock)) {
    finished.delete(flow_id)
    return unknownStatus(flow_id)
  }
  if (!done.ok) {
    return {
      status: 'error',
      flow_id,
      error: done.error,
      error_code: done.error_code,
    }
  }
  const result: Extract<YouTubeOAuthPublicStatus, { status: 'success' }>['result'] = {
    channel: { ...done.result.channel },
  }
  const grantedScopes = normalizeScope(done.result.tokens.scope)
  if (grantedScopes) result.granted_scopes = grantedScopes.split(' ')
  return { status: 'success', flow_id, result }
}

async function exchangeCodeForTokens(input: {
  code: string
  code_verifier: string
  redirect_uri: string
  client_id: string
  client_secret: string
  signal?: AbortSignal
}): Promise<OAuthTokenBundle> {
  const body = new URLSearchParams({
    code: input.code,
    code_verifier: input.code_verifier,
    client_id: input.client_id,
    client_secret: input.client_secret,
    redirect_uri: input.redirect_uri,
    grant_type: 'authorization_code',
  })
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: input.signal,
  })
  if (!resp.ok) {
    const error = new Error('OAuth token exchange was rejected') as Error & { status?: number }
    error.status = resp.status
    throw error
  }
  const data = await resp.json() as Record<string, unknown>
  if (typeof data.access_token !== 'string' || !data.access_token
    || typeof data.refresh_token !== 'string' || !data.refresh_token) {
    throw new Error('OAuth provider returned an invalid token bundle')
  }
  const expiresIn = Number(data.expires_in)
  const expiresAt = typeof data.expires_at === 'number' && Number.isFinite(data.expires_at)
    ? data.expires_at
    : Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000
  return normalizeTokenBundle({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    scope: data.scope,
  })
}

async function productionRefreshTransport(input: {
  refresh_token: string
  client_id: string
  client_secret: string
}): Promise<OAuthRefreshTransportResponse> {
  const body = new URLSearchParams({
    client_id: input.client_id,
    client_secret: input.client_secret,
    refresh_token: input.refresh_token,
    grant_type: 'refresh_token',
  })
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const error = new Error('OAuth token refresh was rejected') as Error & { status?: number }
    error.status = resp.status
    throw error
  }
  const data = await resp.json() as Record<string, unknown>
  const expiresIn = Number(data.expires_in)
  const expiresAt = typeof data.expires_at === 'number' && Number.isFinite(data.expires_at)
    ? data.expires_at
    : Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000
  return {
    access_token: typeof data.access_token === 'string' ? data.access_token : '',
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expires_at: expiresAt,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  }
}

export async function refreshAccessToken(input: {
  refresh_token: string
  client_id: string
  client_secret: string
  previous_scope?: string
  transport?: OAuthRefreshTransport
}): Promise<OAuthTokenBundle> {
  if (!input.refresh_token || !input.client_id || !input.client_secret) {
    throw new Error('OAuth refresh credentials are required.')
  }
  let response: OAuthRefreshTransportResponse
  try {
    response = await (input.transport || productionRefreshTransport)({
      refresh_token: input.refresh_token,
      client_id: input.client_id,
      client_secret: input.client_secret,
    })
  } catch (error) {
    throw terminalError(mapProviderError(error))
  }

  if (!response || typeof response !== 'object'
    || typeof response.access_token !== 'string' || !response.access_token
    || typeof response.expires_at !== 'number' || !Number.isFinite(response.expires_at)) {
    throw terminalError('YOUTUBE_OAUTH_PROVIDER_REJECTED')
  }
  const result: OAuthTokenBundle = {
    access_token: response.access_token,
    refresh_token: typeof response.refresh_token === 'string' && response.refresh_token
      ? response.refresh_token
      : input.refresh_token,
    expires_at: response.expires_at,
  }
  const scope = typeof response.scope === 'string'
    ? normalizeScope(response.scope)
    : input.previous_scope
  if (scope !== undefined) result.scope = scope
  return result
}

async function fetchPrimaryChannel(access_token: string, signal?: AbortSignal): Promise<OAuthFlowResult['channel'] | null> {
  const url = `${GOOGLE_CHANNELS_URL}?${new URLSearchParams({ part: 'id,snippet', mine: 'true' }).toString()}`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` }, signal })
  if (!resp.ok) {
    const error = new Error('YouTube channel lookup was rejected') as Error & { status?: number }
    error.status = resp.status
    throw error
  }
  const data = await resp.json() as any
  const item = data?.items?.[0]
  if (!item || typeof item.id !== 'string') return null
  return {
    channel_id: item.id,
    channel_title: typeof item.snippet?.title === 'string' && item.snippet.title ? item.snippet.title : 'Unknown channel',
    ...(typeof item.snippet?.customUrl === 'string' ? { custom_url: item.snippet.customUrl } : {}),
    ...(typeof item.snippet?.thumbnails?.default?.url === 'string' ? { thumbnail_url: item.snippet.thumbnails.default.url } : {}),
  }
}

/** Best-effort remote revoke retained for the existing disconnect path. */
export async function revokeToken(token: string): Promise<void> {
  if (!token) return
  try {
    const resp = await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (!resp.ok && resp.status !== 400) {
      // Local disconnect remains authoritative; remote revoke is best effort.
    }
  } catch {
    // Remote revoke is deliberately non-fatal.
  }
}

function respondHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

function htmlPage(input: { title: string; body: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1117; color: #e6edf3; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { max-width: 520px; padding: 32px 36px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0; line-height: 1.5; color: #c9d1d9; }
  strong { color: #58a6ff; }
</style></head><body><div class="card"><h1>${escapeHtml(input.title)}</h1><p>${input.body}</p></div></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[character] as string))
}
