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

import { promises as fsp } from 'fs'
import path from 'path'
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

// ── Batch job API (image / voice / video) — Phase 2+ ───────────────────────
//
// One uniform async API: submit a batch → poll until queued+running == 0 →
// read each item's artifact_url. Story Studio submits ONE item per call (it
// generates a single asset at a time), so callers read items[0].

export interface HubJobItem {
  prompt: string
  seed?: number
  params?: Record<string, any>
}

export interface HubSubmitBody {
  modality: 'image' | 'voice' | 'music' | 'video'
  model: string
  label?: string
  /** 'pool' (Hub picks least-busy capable studio) | 'studio:<id>'. */
  routing?: string
  sharedParams?: Record<string, any>
  items: HubJobItem[]
}

export interface HubBatchItemResult {
  index: number
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  prompt?: string
  studio?: string
  artifact_url?: string
  artifact_path?: string
  asset_id?: string
  error?: string | null
}

export interface HubBatchStatus {
  id: string
  total?: number
  queued?: number
  running?: number
  done?: number
  error?: number
  cancelled?: boolean
  governor_note?: string
  items: HubBatchItemResult[]
}

export interface HubPollOpts {
  isCancelled?: () => boolean
  timeoutMs?: number
  onProgress?: (s: HubBatchStatus) => void
}

const HUB_BATCH_DEFAULT_TIMEOUT_MS = 10 * 60_000

/** Cancellable sleep — wakes early if isCancelled flips (mirrors pollJob). */
async function sleepCancellable(ms: number, isCancelled?: () => boolean): Promise<void> {
  const step = 250
  let waited = 0
  while (waited < ms) {
    if (isCancelled?.()) return
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)))
    waited += step
  }
}

/**
 * Submit a batch to the Hub. Returns `{ batch_id }`. A connection error phrasing
 * ("Connection error") lets the caller's isConnectionError() drive fallback to
 * the direct pool; a non-connection error (bad model, etc.) surfaces as-is.
 */
export async function hubSubmitJob(
  hubUrl: string,
  token: string | undefined,
  body: HubSubmitBody,
): Promise<{ batch_id: string; items: number }> {
  let resp: Response
  try {
    resp = await fetch(`${hubApiBase(hubUrl)}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hubHeaders(token) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e: any) {
    throw new Error(`Can't reach Studio Hub to submit a job: ${e?.message || e}. Connection error.`)
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`Studio Hub submit failed (${resp.status}): ${t.slice(0, 300)}`)
  }
  const j = await resp.json().catch(() => ({})) as { batch_id?: string; items?: number }
  if (!j?.batch_id) {
    throw new Error(`Studio Hub submit returned no batch_id: ${JSON.stringify(j).slice(0, 200)}`)
  }
  return { batch_id: j.batch_id, items: j.items ?? body.items.length }
}

/**
 * Poll a batch until every item is terminal (queued + running == 0). Returns
 * the final status. Cancels the batch on isCancelled. A connection error while
 * polling is phrased so the caller can fall back to the direct pool.
 */
export async function hubPollBatch(
  hubUrl: string,
  token: string | undefined,
  batchId: string,
  opts: HubPollOpts = {},
): Promise<HubBatchStatus> {
  const deadline = Date.now() + (opts.timeoutMs ?? HUB_BATCH_DEFAULT_TIMEOUT_MS)
  let polls = 0
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) {
      await fetch(`${hubApiBase(hubUrl)}/jobs/${batchId}`, {
        method: 'DELETE', headers: hubHeaders(token),
      }).catch(() => {})
      throw new Error('Cancelled by user')
    }
    let resp: Response
    try {
      resp = await fetch(`${hubApiBase(hubUrl)}/jobs/${batchId}`, {
        headers: { Accept: 'application/json', ...hubHeaders(token) },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e: any) {
      throw new Error(`Can't reach Studio Hub while polling ${batchId}: ${e?.message || e}. Connection error.`)
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      throw new Error(`Studio Hub poll failed (${resp.status}): ${t.slice(0, 300)}`)
    }
    const s = await resp.json() as HubBatchStatus
    try { opts.onProgress?.(s) } catch { /* never let UI plumbing kill polling */ }
    if ((s.queued || 0) + (s.running || 0) === 0) return s
    const sleepMs = polls < 6 ? 2_000 : polls < 18 ? 4_000 : 8_000
    await sleepCancellable(sleepMs, opts.isCancelled)
    polls += 1
  }
  throw new Error(
    `Studio Hub batch ${batchId} did not complete within ` +
    `${Math.round((opts.timeoutMs ?? HUB_BATCH_DEFAULT_TIMEOUT_MS) / 60_000)} min`,
  )
}

// ── Reference-image assets (upload-once) ───────────────────────────────────
//
// Continuity render reuses ONE reference (a character sheet / style ref) across
// every scene in an episode. Uploading it once and referencing it by `asset_id`
// avoids re-base64-ing megabytes into every per-scene job. Cache keyed by file
// identity (path + size + mtime) AND the Hub URL, so the first scene uploads and
// the rest reuse it; a changed file re-uploads.

const assetCache = new Map<string, { hubUrl: string; assetId: string }>()

async function assetCacheKey(filePath: string): Promise<string> {
  const st = await fsp.stat(filePath)
  return `${filePath}:${st.size}:${Math.round(st.mtimeMs)}`
}

/** Upload a file to the Hub's asset store; returns its `asset_id`. */
export async function hubUploadAsset(
  hubUrl: string,
  token: string | undefined,
  filePath: string,
): Promise<string> {
  const buf = await fsp.readFile(filePath)
  const form = new FormData()
  form.append('file', new Blob([buf]), path.basename(filePath))
  let resp: Response
  try {
    resp = await fetch(`${hubApiBase(hubUrl)}/assets/upload`, {
      method: 'POST', headers: hubHeaders(token), body: form, signal: AbortSignal.timeout(60_000),
    })
  } catch (e: any) {
    throw new Error(`Can't reach Studio Hub to upload a reference asset: ${e?.message || e}. Connection error.`)
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`Studio Hub asset upload failed (${resp.status}): ${t.slice(0, 200)}`)
  }
  const j = await resp.json().catch(() => ({})) as { asset_id?: string }
  if (!j?.asset_id) throw new Error('Studio Hub asset upload returned no asset_id')
  return j.asset_id
}

/**
 * Return a cached `asset_id` for `filePath` on this Hub, uploading it on first
 * use. Returns `null` on ANY failure so the caller can fall back to inline
 * base64 — upload-once is an optimisation, never required for correctness.
 */
export async function getOrUploadHubAsset(
  hubUrl: string,
  token: string | undefined,
  filePath: string,
): Promise<string | null> {
  try {
    const key = await assetCacheKey(filePath)
    const hit = assetCache.get(key)
    if (hit && hit.hubUrl === hubUrl) return hit.assetId
    const assetId = await hubUploadAsset(hubUrl, token, filePath)
    assetCache.set(key, { hubUrl, assetId })
    return assetId
  } catch {
    return null
  }
}

/** Drop a file's cached asset_id (e.g. the Hub restarted and dropped the store). */
export async function invalidateHubAsset(filePath: string): Promise<void> {
  try {
    assetCache.delete(await assetCacheKey(filePath))
  } catch { /* file gone — nothing to invalidate */ }
}

// ── Fleet control (ops) ────────────────────────────────────────────────────
//
// Powers the Settings "Fleet control" panel: list the fleet's studios and
// start / stop / restart a stuck or offline one — without leaving Story Studio.

export interface HubStudio {
  id: string
  modality?: string
  machine?: string
  machine_label?: string
  status?: string
  host?: string
  port?: number
  app_version?: string
  emoji?: string
}

/** List the fleet's studios (up/down) via the Hub. */
export async function hubStudios(hubUrl: string, token: string | undefined): Promise<HubStudio[]> {
  const resp = await fetch(`${hubApiBase(hubUrl)}/studios`, {
    headers: { Accept: 'application/json', ...hubHeaders(token) },
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`Studio Hub studios failed (${resp.status})`)
  const j = await resp.json().catch(() => ({})) as { studios?: HubStudio[] }
  return Array.isArray(j?.studios) ? j.studios : []
}

/** Start or stop a studio via the Hub (pterm lifecycle). Never throws. */
export async function hubStudioAction(
  hubUrl: string,
  token: string | undefined,
  studioId: string,
  action: 'start' | 'stop',
): Promise<{ ok: boolean; error?: string }> {
  let resp: Response
  try {
    resp = await fetch(`${hubApiBase(hubUrl)}/studios/${encodeURIComponent(studioId)}/${action}`, {
      method: 'POST', headers: hubHeaders(token), signal: AbortSignal.timeout(20_000),
    })
  } catch (e: any) {
    return { ok: false, error: `Can't reach Studio Hub: ${e?.message || e}` }
  }
  const j = await resp.json().catch(() => ({})) as { ok?: boolean; error?: string; detail?: string }
  if (!resp.ok) return { ok: false, error: j?.detail || j?.error || `HTTP ${resp.status}` }
  return { ok: j?.ok !== false, error: j?.error }
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
