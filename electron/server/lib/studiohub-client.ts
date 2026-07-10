/**
 * Studio Hub KH client — the single control-plane that fronts the Studio fleet
 * (Image / Voice / Chat / Music / Video servers across many Macs on Tailscale).
 *
 * When `local_backend === 'hub'` (App Settings → Local Models), the local
 * providers route generation through the Hub instead of hitting each Mac
 * directly, and the Hub delegates to a least-busy / capability-matched studio.
 * A Hub failure AUTO-FALLS-BACK to the direct pool (see each provider), so the
 * Hub is an optimisation, never a hard single point of failure.
 *
 * Auth: `X-Hub-Token` header. Loopback (127.0.0.1 / localhost) is token-exempt
 * on the Hub, so when Story Studio runs ON the Hub machine the token is unused
 * and stays empty. The token slot ('hub' in app-secrets) only matters for an
 * off-Hub-machine install pointing at the Hub's tailnet address.
 *
 * Contract (see studiohub-mac STORYSTUDIO_INTEGRATION.md):
 *   - Chat  : OpenAI-compatible gateway  POST {hub}/studio/chat/v1/chat/completions
 *   - Batch : POST {hub}/api/hub/jobs  → poll GET {hub}/api/hub/jobs/{batch_id}
 *             → fetch each item's artifact_url  (image / voice / video)  [Phase 2+]
 *   - Health: GET {hub}/api/health   (open, no token)
 *
 * Phase 1 (this file) implements config resolution + chat-gateway plumbing +
 * health. The batch submit/poll/artifact helpers are added in Phase 2 (image).
 */

import { getApiKey } from '../services/app-secrets-store.js'
import { getLocalBackend, getHubUrl } from '../services/app-settings.js'

export interface HubBackend {
  /** Active local backend. 'hub' means route through Studio Hub. */
  mode: 'direct' | 'hub'
  /** Hub base URL (no trailing slash), e.g. http://127.0.0.1:47873. */
  hubUrl: string
  /** Optional X-Hub-Token; '' when unused (loopback / on-Hub-machine). */
  hubToken: string
}

/** Strip trailing slashes so path joins never produce a `//` (the 404 trap). */
export function trimHubUrl(url: string): string {
  return (url || '').trim().replace(/\/+$/, '')
}

/**
 * Root base for the Hub's OpenAI-compatible chat gateway: `{hub}/studio/chat`.
 * The chatstudio client's `chatstudioApiBase()` appends `/v1`, yielding the
 * gateway's `{hub}/studio/chat/v1` — so its `/chat/completions` and `/models`
 * calls land on the documented gateway paths with no other change.
 */
export function hubChatRootBase(hubUrl: string): string {
  return `${trimHubUrl(hubUrl)}/studio/chat`
}

/** Base for the Hub's batch job API: `{hub}/api/hub`. [used in Phase 2+] */
export function hubApiBase(hubUrl: string): string {
  return `${trimHubUrl(hubUrl)}/api/hub`
}

/** Auth headers for a Hub request. Empty object when no token (loopback). */
export function hubHeaders(token: string | undefined | null): Record<string, string> {
  return token && token.trim() ? { 'X-Hub-Token': token.trim() } : {}
}

/** True for a loopback Hub URL — token-exempt, so a missing token is fine. */
export function isLoopbackHub(hubUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test((hubUrl || '').trim())
}

/**
 * Resolve the active backend + Hub connection from settings/secrets. Reads the
 * per-machine `local_backend` + `hub_url` app-settings and the optional `hub`
 * token secret. Cheap (small JSON reads); called once per generation entry.
 */
export async function getHubBackend(): Promise<HubBackend> {
  const [mode, hubUrl, hubToken] = await Promise.all([
    getLocalBackend(),
    getHubUrl(),
    getApiKey('hub').catch(() => ''),
  ])
  return { mode, hubUrl: trimHubUrl(hubUrl), hubToken: (hubToken || '').trim() }
}

export interface HubHealth {
  ok: boolean
  appVersion?: string
  error?: string
}

/**
 * Liveness probe for the Hub itself (`GET /api/health`, token-exempt). Never
 * throws — returns `{ ok:false, error }`. Used to decide Hub-vs-direct fallback
 * and to power the Settings "Hub online" indicator.
 */
export async function hubHealth(hubUrl: string, timeoutMs = 4000): Promise<HubHealth> {
  const base = trimHubUrl(hubUrl)
  if (!base) return { ok: false, error: 'Hub URL is empty' }
  try {
    const resp = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return { ok: false, error: `Hub health failed (${resp.status})` }
    const data = await resp.json().catch(() => ({})) as { ok?: boolean; app_version?: string }
    return { ok: data.ok === true, appVersion: data.app_version }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
