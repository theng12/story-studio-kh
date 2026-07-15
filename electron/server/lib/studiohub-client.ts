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
import { createReadStream, createWriteStream } from 'fs'
import path from 'path'
import { Readable } from 'stream'
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

export interface HubModelMachine {
  studio: string
  machine: string
  cached: boolean
  ready?: boolean
}

export interface HubModelInfo {
  repo: string
  label: string
  modality: string
  family_label?: string
  size_gb?: number
  is_cloud?: boolean
  downloaded: boolean
  available?: boolean
  recommended?: boolean
  note?: string
  cached_on?: string[]
  available_on?: string[]
  machines?: HubModelMachine[]
}

export interface HubTranscriptionInventory {
  available: boolean
  default_model?: string
  endpoint_count: number
  ready_count: number
  models: Array<HubModelInfo & { cached: boolean }>
}

async function hubGetJson<T>(
  hubUrl: string,
  token: string | undefined,
  path: string,
  timeoutMs = 20_000,
): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(`${hubApiBase(hubUrl)}${path}`, {
      headers: { Accept: 'application/json', ...hubHeaders(token) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e: any) {
    throw new Error(`Can't reach Studio Hub inventory: ${e?.message || e}. Connection error.`)
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Studio Hub inventory failed (${resp.status}): ${detail.slice(0, 300)}`)
  }
  return resp.json() as Promise<T>
}

export async function hubModels(
  hubUrl: string,
  token: string | undefined,
  modality?: string,
  force = false,
): Promise<HubModelInfo[]> {
  const query = new URLSearchParams()
  if (modality) query.set('modality', modality)
  if (force) query.set('force', 'true')
  const suffix = query.size ? `?${query}` : ''
  const result = await hubGetJson<{ models?: HubModelInfo[] }>(hubUrl, token, `/models${suffix}`)
  return Array.isArray(result.models) ? result.models : []
}

export async function hubCatalog(
  hubUrl: string,
  token: string | undefined,
  modality?: string,
  force = false,
  timeoutMs = 20_000,
): Promise<any[]> {
  const query = new URLSearchParams()
  if (modality) query.set('modality', modality)
  if (force) query.set('force', 'true')
  const suffix = query.size ? `?${query}` : ''
  const result = await hubGetJson<{ models?: any[] }>(hubUrl, token, `/catalog${suffix}`, timeoutMs)
  return Array.isArray(result.models) ? result.models : []
}

export function hubTranscription(
  hubUrl: string,
  token: string | undefined,
  force = false,
): Promise<HubTranscriptionInventory> {
  return hubGetJson(hubUrl, token, `/transcription${force ? '?force=true' : ''}`)
}

export async function hubBroadcastDownload(
  hubUrl: string,
  token: string | undefined,
  repo: string,
  studios: string[],
): Promise<any> {
  const resp = await fetch(`${hubApiBase(hubUrl)}/broadcast/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...hubHeaders(token) },
    body: JSON.stringify({ repo, studios }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Studio Hub model download failed (${resp.status}): ${detail.slice(0, 300)}`)
  }
  return resp.json()
}

export async function hubTranscribeFile(
  hubUrl: string,
  token: string | undefined,
  audioPath: string,
  opts: { model: string; language?: string; wordTimestamps?: boolean; signal?: AbortSignal },
): Promise<any> {
  const data = await fsp.readFile(audioPath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)]), path.basename(audioPath))
  form.append('model', opts.model)
  if (opts.language) form.append('language', opts.language)
  if (opts.wordTimestamps) form.append('word_timestamps', 'true')
  const timeout = AbortSignal.timeout(300_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let resp: Response
  try {
    resp = await fetch(`${hubApiBase(hubUrl)}/transcribe`, {
      method: 'POST', headers: hubHeaders(token), body: form, signal,
    })
  } catch (e: any) {
    throw new Error(`Can't reach Studio Hub transcription: ${e?.message || e}. Connection error.`)
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Studio Hub transcription failed (${resp.status}): ${detail.slice(0, 500)}`)
  }
  return resp.json()
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
  modality: 'image' | 'voice' | 'music' | 'video' | 'render'
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
  sha256?: string
  bytes?: number
  encoder?: string
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
  /** Fired once per item the FIRST time it reaches a terminal state, so a
   *  multi-item batch can save/stream each result as it finishes rather than
   *  waiting for the whole batch (poll-based streaming — no webhook needed). */
  onItemDone?: (item: HubBatchItemResult) => void | Promise<void>
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

async function hubCancelPath(
  hubUrl: string,
  token: string | undefined,
  path: string,
): Promise<void> {
  let lastFailure = 'no response'
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${hubApiBase(hubUrl)}${path}`, {
        method: 'DELETE',
        headers: hubHeaders(token),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok || response.status === 404) return
      const detail = await response.text().catch(() => '')
      lastFailure = `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    } catch (error: any) {
      lastFailure = error?.message || String(error)
    }
    if (attempt < 3) await sleepCancellable(attempt * 250)
  }
  throw new Error(`Studio Hub did not acknowledge cancellation after 3 attempts (${lastFailure})`)
}

/** Cancel a generation batch and require an acknowledgement from Studio Hub. */
export async function hubCancelBatch(
  hubUrl: string,
  token: string | undefined,
  batchId: string,
): Promise<void> {
  await hubCancelPath(hubUrl, token, `/jobs/${encodeURIComponent(batchId)}`)
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
  const seenDone = new Set<number>()
  let polls = 0
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) {
      try {
        await hubCancelBatch(hubUrl, token, batchId)
      } catch (error: any) {
        throw new Error(`Cancelled by user locally, but ${error?.message || error}`)
      }
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
    if (opts.onItemDone) {
      for (const it of s.items || []) {
        if (it && !seenDone.has(it.index) &&
            (it.state === 'done' || it.state === 'error' || it.state === 'cancelled')) {
          seenDone.add(it.index)
          try { await opts.onItemDone(it) } catch { /* a per-item handler must not kill polling */ }
        }
      }
    }
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

// Durable Chat prompt packs. Unlike the OpenAI-compatible gateway, this queue
// survives app restarts and assigns one adaptive pack to each Chat Studio.
export interface HubChatPack {
  pack_id: string
  scene_ids: string[]
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  params?: Record<string, any>
}

export interface HubChatResult {
  scene_id: string
  text: string
}

export interface HubChatPackStatus {
  pack_id: string
  scene_ids: string[]
  state: 'queued' | 'running' | 'done' | 'partial' | 'error' | 'cancelled'
  studio?: string | null
  error?: string | null
  missing_scene_ids?: string[]
  results?: HubChatResult[]
}

export interface HubChatBatchStatus {
  id: string
  status: 'queued' | 'running' | 'done' | 'partial' | 'error' | 'cancelled'
  total_scenes: number
  completed_scenes: number
  packs: HubChatPackStatus[]
}

export async function hubSubmitChatPacks(
  hubUrl: string,
  token: string | undefined,
  body: {
    model: string
    model_cost_tier?: 'local' | 'free' | 'paid'
    kind: 'visual' | 'motion'
    label?: string
    project?: string
    episode?: string
    packs: HubChatPack[]
  },
): Promise<{ batch_id: string; packs: number; scenes: number }> {
  let resp: Response
  try {
    resp = await fetch(`${hubApiBase(hubUrl)}/chat/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hubHeaders(token) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e: any) {
    throw new Error(`Can't reach Studio Hub to submit Chat packs: ${e?.message || e}. Connection error.`)
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Studio Hub Chat submit failed (${resp.status}): ${detail.slice(0, 500)}`)
  }
  const value = await resp.json() as { batch_id?: string; packs?: number; scenes?: number }
  if (!value.batch_id) throw new Error('Studio Hub Chat submit returned no batch_id')
  return { batch_id: value.batch_id, packs: value.packs || body.packs.length, scenes: value.scenes || 0 }
}

export async function hubPollChatPacks(
  hubUrl: string,
  token: string | undefined,
  batchId: string,
  opts: {
    isCancelled?: () => boolean
    timeoutMs?: number
    onProgress?: (status: HubChatBatchStatus) => void | Promise<void>
  } = {},
): Promise<HubChatBatchStatus> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000)
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) {
      try {
        await hubCancelPath(hubUrl, token, `/chat/jobs/${encodeURIComponent(batchId)}`)
      } catch (error: any) {
        throw new Error(`Cancelled by user locally, but ${error?.message || error}`)
      }
      throw new Error('Cancelled by user')
    }
    let resp: Response
    try {
      resp = await fetch(`${hubApiBase(hubUrl)}/chat/jobs/${batchId}`, {
        headers: { Accept: 'application/json', ...hubHeaders(token) },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e: any) {
      throw new Error(`Can't reach Studio Hub while polling Chat batch ${batchId}: ${e?.message || e}. Connection error.`)
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new Error(`Studio Hub Chat poll failed (${resp.status}): ${detail.slice(0, 500)}`)
    }
    const status = await resp.json() as HubChatBatchStatus
    await opts.onProgress?.(status)
    if (['done', 'partial', 'error', 'cancelled'].includes(status.status)) return status
    await sleepCancellable(2_000, opts.isCancelled)
  }
  throw new Error(`Studio Hub Chat batch ${batchId} did not complete within the allowed time`)
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

export interface HubRenderAsset {
  assetId: string
  bytes: number
  sha256: string
  url: string
}

/** Resolve an address a different Mac can use when Story Studio uses localhost. */
export async function hubWorkerReachableUrl(
  hubUrl: string,
  token: string | undefined,
): Promise<string> {
  const base = trimHubUrl(hubUrl)
  if (!isLoopbackHub(base)) return base
  const resp = await fetch(`${hubApiBase(base)}/access`, {
    headers: hubHeaders(token), signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`Studio Hub access-address lookup failed (${resp.status})`)
  const value = await resp.json() as { addresses?: Array<{ url?: string; kind?: string }> }
  const addresses = value.addresses || []
  const selected = addresses.find(a => a.kind === 'tailscale' && a.url)
    || addresses.find(a => a.kind === 'lan' && a.url)
  if (!selected?.url) throw new Error('Studio Hub has no Tailscale or LAN address for render workers')
  return trimHubUrl(selected.url)
}

/** Stream a potentially large render input to Hub without buffering it in RAM. */
export async function hubUploadRenderAsset(
  hubUrl: string,
  workerHubUrl: string,
  token: string | undefined,
  filePath: string,
): Promise<HubRenderAsset> {
  const stat = await fsp.stat(filePath)
  const body = Readable.toWeb(createReadStream(filePath))
  let resp: Response
  try {
    resp = await fetch(`${hubApiBase(hubUrl)}/render-assets`, {
      method: 'POST',
      headers: {
        ...hubHeaders(token),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
        'X-File-Name': path.basename(filePath),
      },
      body: body as any,
      duplex: 'half',
      signal: AbortSignal.timeout(30 * 60_000),
    } as any)
  } catch (e: any) {
    throw new Error(`Can't stream a render asset to Studio Hub: ${e?.message || e}. Connection error.`)
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Studio Hub render-asset upload failed (${resp.status}): ${detail.slice(0, 300)}`)
  }
  const value = await resp.json() as { asset_id: string; bytes: number; sha256: string; path: string }
  return {
    assetId: value.asset_id,
    bytes: value.bytes,
    sha256: value.sha256,
    url: `${trimHubUrl(workerHubUrl)}${value.path}`,
  }
}

export async function hubDeleteRenderAsset(
  hubUrl: string,
  token: string | undefined,
  assetId: string,
): Promise<void> {
  await fetch(`${hubApiBase(hubUrl)}/render-assets/${encodeURIComponent(assetId)}`, {
    method: 'DELETE', headers: hubHeaders(token), signal: AbortSignal.timeout(30_000),
  }).catch(() => {})
}

/** Download a completed worker artifact atomically and verify its SHA-256. */
export async function hubDownloadRenderResult(
  artifactUrl: string,
  token: string | undefined,
  destination: string,
  expectedSha256?: string,
): Promise<void> {
  const crypto = await import('crypto')
  const temp = `${destination}.partial-${Date.now()}`
  const resp = await fetch(artifactUrl, {
    headers: hubHeaders(token), signal: AbortSignal.timeout(30 * 60_000),
  })
  if (!resp.ok || !resp.body) throw new Error(`Render result download failed (${resp.status})`)
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const digest = crypto.createHash('sha256')
  const output = createWriteStream(temp, { flags: 'wx' })
  try {
    for await (const chunk of Readable.fromWeb(resp.body as any)) {
      digest.update(chunk as Buffer)
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve))
    }
    await new Promise<void>((resolve, reject) => {
      output.once('error', reject)
      output.end(resolve)
    })
    const actual = digest.digest('hex')
    if (expectedSha256 && actual !== expectedSha256) {
      throw new Error(`Returned render checksum mismatch (expected ${expectedSha256}, received ${actual})`)
    }
    await fsp.rename(temp, destination)
  } catch (error) {
    output.destroy()
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw error
  }
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

export interface HubFleetStatus {
  ok: boolean
  fleetTokenSet: boolean
  error?: string
}

/** Verify sibling-fleet authentication without returning the credential. */
export async function hubFleetStatus(
  hubUrl: string,
  token?: string,
  timeoutMs = 5_000,
): Promise<HubFleetStatus> {
  const base = trimHubUrl(hubUrl)
  if (!base) return { ok: false, fleetTokenSet: false, error: 'Hub URL is empty' }
  try {
    const resp = await fetch(`${hubApiBase(base)}/fleet`, {
      headers: { Accept: 'application/json', ...hubHeaders(token) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) {
      return {
        ok: false,
        fleetTokenSet: false,
        error: resp.status === 401
          ? 'Hub access token was rejected'
          : `Fleet readiness check failed (${resp.status})`,
      }
    }
    const data = await resp.json().catch(() => ({})) as { fleet_token_set?: boolean }
    return { ok: true, fleetTokenSet: data.fleet_token_set === true }
  } catch (e: any) {
    return { ok: false, fleetTokenSet: false, error: e?.message || String(e) }
  }
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
