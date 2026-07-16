import type { HubBackend } from './studiohub-client.js'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Resolve the shared credential accepted by every protected Studio wrapper. */
export async function resolveStudioFleetToken(
  backend?: HubBackend,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let hub: HubBackend
  if (backend) hub = backend
  else hub = await import('./studiohub-client.js').then(m => m.getHubBackend())
  if (hub.hubToken.trim()) return hub.hubToken.trim()
  if (!hub.hubUrl || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(hub.hubUrl.trim())) return ''
  try {
    const base = hub.hubUrl.trim().replace(/\/+$/, '')
    const resp = await fetchImpl(`${base}/api/hub/fleet`, {
      signal: AbortSignal.timeout(4_000),
    })
    if (!resp.ok) return ''
    const data = await resp.json() as { token?: string }
    return typeof data.token === 'string' ? data.token.trim() : ''
  } catch {
    return ''
  }
}

let cache: { token: string; expiresAt: number } | null = null
let inflight: Promise<string> | null = null

export async function cachedStudioFleetToken(): Promise<string> {
  if (cache && cache.expiresAt > Date.now()) return cache.token
  if (inflight) return inflight
  inflight = resolveStudioFleetToken()
    .then(token => {
      cache = { token, expiresAt: Date.now() + (token ? 300_000 : 15_000) }
      return token
    })
    .finally(() => { inflight = null })
  return inflight
}

/** Authenticated fetch used only when Direct Studio URLs are selected. */
export async function studioFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = await cachedStudioFleetToken()
  if (token && !headers.has('X-Studio-Token')) headers.set('X-Studio-Token', token)
  return fetch(input, { ...init, headers })
}
