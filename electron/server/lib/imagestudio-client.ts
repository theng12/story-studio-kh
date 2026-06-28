/**
 * Image Studio KH client — local TTI modal launcher reached over Tailscale.
 *
 * v1.0.151+ — sibling of `voicestudio-client.ts`. Pinokio-launched FastAPI
 * wrapper that fronts fourteen image-generation engine families (FLUX.2
 * klein/dev, FLUX.1 schnell/dev/Kontext, Qwen-Image / Qwen-Edit, FIBO,
 * Z-Image, ...). User loads one family at a time in the wrapper UI, then
 * Story Studio talks to it via this client.
 *
 * No auth — Tailscale handles network security at the transport layer.
 * Default base URL is the user's tailnet IP discovered during the v1.0.151
 * integration probe (http://100.120.246.10:47868); editable in
 * App Settings → Local Models so the value isn't tied to a specific
 * machine. Distinct from Voice Studio's port (`47870`) because Pinokio
 * assigns each modal its own port.
 *
 * Async pipeline (mirrors Voice Studio's flow, swap audio → image):
 *   1. POST /api/generate/txt2img          → { job_id, status, ... }
 *   2. GET  /api/generate/jobs/{job_id}    → poll until status === 'done' | 'failed'
 *   3. GET  /api/generate/jobs/{id}/image  → binary download (PNG)
 *
 * Discovery:
 *   - GET /api/health                       — process + version
 *   - GET /api/generate/availability        — aspect-ratio presets the engines support
 *   - GET /api/catalog                      — full family + model catalog (gating, size, capabilities)
 *   - GET /api/loras                        — user's saved LoRA files (empty by default)
 *   - GET /api/generate/diagnostics         — per-family `ready` flag + dependency status
 *
 * Cancellation: DELETE /api/generate/jobs/{job_id} is called on best-effort
 * cancel; the polling loop terminates on isCancelled regardless.
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { sleepCancellable } from './http-retry.js'
import { parseEndpoints, parseEnabledEndpoints, createDispatcher, type Dispatcher } from './endpoint-pool.js'

// ── Multi-endpoint dispatcher (v1.0.306) ────────────────────────────────────
// The Image Studio URL setting may hold SEVERAL base URLs (one per Mac running
// the modal), comma/space separated — exactly like LM Studio. Before this, the
// image provider passed that whole string to fetch() as one URL, producing
// "Failed to parse URL from <list>/api/generate/txt2img". This mirrors
// getLmstudioDispatcher: a cached least-busy pool with self-healing failover.

const imgDispatcherCache = new Map<string, Dispatcher>()
function imgEndpointsKey(eps: string[]): string { return [...eps].sort().join(',') }

/** First endpoint of a (possibly comma/space-separated) stored URL list. */
export function imagestudioFirst(stored: string | null | undefined): string {
  return parseEndpoints(stored)[0] || ''
}

/**
 * Cached least-busy dispatcher over the Image Studio endpoint list. Returns
 * `dispatcher: null` for the single-endpoint case so the provider's fast path
 * stays a pass-through. Mirrors getLmstudioDispatcher (lmstudio-client.ts).
 */
export function getImagestudioDispatcher(
  stored: string | null | undefined,
): { dispatcher: Dispatcher | null; endpoints: string[] } {
  const eps = parseEnabledEndpoints(stored)
  if (eps.length <= 1) return { dispatcher: null, endpoints: eps }
  const key = imgEndpointsKey(eps)
  let d = imgDispatcherCache.get(key)
  if (!d) { d = createDispatcher(eps); imgDispatcherCache.set(key, d) }
  return { dispatcher: d, endpoints: eps }
}

/**
 * Image Studio modal base URL default.
 *
 * v1.0.207 — **empty by default**, same rationale as Voice Studio: the
 * host is per-user (Bonjour `*.local`, a LAN IP, or a Tailscale IP) and
 * only the port (`47868`) is fixed. The user sets their URL in App
 * Settings → Local Models; when empty the local image model fails fast
 * with a "set your URL" message rather than probing a hardcoded host.
 */
export const DEFAULT_IMAGESTUDIO_BASE_URL = ''

export interface ImageStudioTxt2ImgParams {
  /** Required — HuggingFace repo id selecting which model variant to run. */
  repo: string
  prompt: string
  /** Optional negative prompt; defaults to '' server-side. */
  negative_prompt?: string
  width?: number
  height?: number
  /** Number of denoising steps. Default 4 (suits distilled FLUX variants). */
  steps?: number
  /**
   * Classifier-free guidance scale. Default 3.5; distilled models
   * (FLUX.2 klein, FLUX.1 schnell) ignore this and effectively run at 1.0
   * regardless of what we send.
   */
  guidance?: number
  /** Integer seed; omit / null for random. */
  seed?: number | null
  /**
   * On-the-fly quantization bits (4, 6, 8). Lets a non-quantized model
   * load in less memory. Ignored when the picked repo is already
   * quantized (e.g. our default `AITRADER/FLUX2-klein-4B-mlx-4bit`).
   */
  quantize?: number | null
  /** LoRA filenames previously listed via /api/loras. Empty by default. */
  lora_names?: string[]
  /** Parallel-indexed scales for `lora_names`. Empty by default. */
  lora_scales?: number[]
}

/**
 * img2img + edit share txt2img's shape but add a source `image` (sent as a
 * multipart file) and `image_strength`. Verified live 2026-06-02:
 *   POST /api/generate/img2img — multipart: image*, repo*, prompt*, …, image_strength=0.6
 *   POST /api/generate/edit    — multipart: image*, repo*, prompt*, …, image_strength=0.85 (no negative_prompt)
 * `image_strength` is how much of the source to preserve (lower = freer).
 */
export interface ImageStudioImg2ImgParams extends ImageStudioTxt2ImgParams {
  /** Absolute path to the source image on Story Studio's disk. */
  imagePath: string
  /** 0–1; default 0.6 for img2img. Lower = diverge further from the source. */
  image_strength?: number
}

export interface ImageStudioEditParams {
  imagePath: string
  repo: string
  prompt: string
  width?: number
  height?: number
  steps?: number
  guidance?: number
  seed?: number | null
  /** 0–1; default 0.85 for instruction edit (preserve more of the source). */
  image_strength?: number
  quantize?: number | null
  lora_names?: string[]
  lora_scales?: number[]
}

export interface ImageStudioSubmitResponse {
  job_id: string
  status?: ImageStudioJobStatus
  queue_position?: number
  estimated_seconds?: number
}

export type ImageStudioJobStatus =
  | 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ImageStudioJob {
  id?: string
  job_id?: string
  status: ImageStudioJobStatus
  progress?: number
  message?: string
  error?: string | null
  elapsed_seconds?: number
  eta_seconds?: number
}

/**
 * v1.0.153+ — hotfix. Both /api/generate/txt2img and
 * /api/generate/jobs/{id} wrap the payload in `{ job: {...} }` and use
 * the field name `state` (not `status`). v1.0.151 read top-level
 * `data.job_id || data.id` + `job.status` — so every submit reported
 * "no job_id" and every poll loop would have spun forever even if the
 * job_id had been parsed.
 *
 * Verified live against the modal on 2026-05-26 — the running
 * thumbnail job that surfaced the bug (629b1ea64acb) had actually
 * completed successfully on the modal side; only the client couldn't
 * read the result.
 *
 * Accepts either envelope shape (`{job: {...}}` from the modal, or a
 * flat object if the wrapper changes in a later release) and either
 * field name (`state` or `status`). Normalizes alternative spellings
 * so the poll loop's status checks ('done' | 'failed' | 'cancelled')
 * still match.
 */
function unwrapJob(raw: any): ImageStudioJob {
  const j = raw && typeof raw === 'object' && raw.job ? raw.job : (raw || {})
  // state vs status — accept either, prefer the modal's spelling.
  const rawState = j.state ?? j.status
  let status: ImageStudioJobStatus
  switch (rawState) {
    case 'queued': case 'pending': case 'running':
    case 'done': case 'failed': case 'cancelled':
      status = rawState; break
    case 'completed': case 'succeeded': case 'success': case 'finished':
      status = 'done'; break
    case 'error':
      status = 'failed'; break
    default:
      status = (typeof rawState === 'string' ? rawState : 'running') as ImageStudioJobStatus
  }
  return {
    id: j.id || j.job_id,
    job_id: j.job_id || j.id,
    status,
    progress: typeof j.progress === 'number' ? j.progress : undefined,
    message: typeof j.message === 'string' ? j.message : undefined,
    error: j.error ?? null,
    elapsed_seconds: typeof j.elapsed_seconds === 'number' ? j.elapsed_seconds : undefined,
    eta_seconds: typeof j.eta_seconds === 'number' ? j.eta_seconds : undefined,
  }
}

export interface ImageStudioHealth {
  ok: boolean
  appVersion?: string
  apiVersion?: string
  hfHome?: string
  error?: string
}

/**
 * Each model in /api/catalog has rich metadata Story Studio surfaces in the
 * Settings UI: repo, label, family + family_label, size_gb, gated flag,
 * apple_optimized, min_unified_memory_gb, capabilities, recommended_hardware.
 * We pass them through to the frontend essentially verbatim so the user can
 * see what they're picking.
 */
export interface ImageStudioCatalogModel {
  repo: string
  label: string
  family: string
  family_label?: string
  size_gb?: number
  gated?: boolean
  quantization?: string | null
  min_unified_memory_gb?: number
  recommended_hardware?: string
  apple_optimized?: boolean
  aliases?: string[]
  capabilities?: string[]
  best_for?: string
  // v1.0.476 — cloud-proxied models (Together / Cloudflare / Pollinations).
  // These run in the cloud, so they have no local engine + need no download/
  // memory. Image Studio flags them explicitly; Story Studio must treat them as
  // always-ready (the local-engine diagnostics never cover them).
  is_cloud?: boolean
  cloud_provider?: string
  // Download state — `{ state: 'cached' | 'absent' | … }`. Cloud models report
  // 'cached'. Used to hide not-yet-downloaded local models from the picker.
  cache?: { state?: string } | null
  // v1.0.477 — credential readiness for cloud models. Image Studio sets one (or
  // both) of these when a cloud model's required API key is MISSING. Handled
  // defensively: a cloud model is "not ready" if cloud_credentials_ok === false
  // OR fit.state === 'needs_key'. Absent on older Image Studio builds → cloud
  // stays ready (prior behaviour). Pollinations needs no key → never flagged.
  cloud_credentials_ok?: boolean
  fit?: { state?: string; label?: string; hint?: string } | null
  // v1.0.478 — per-model dimension menu. Story Studio drives the aspect-ratio +
  // resolution pickers from this instead of a hardcoded table, and resolves a
  // preset's (aspect ratio + quality tier) to the model's matching size. Absent
  // on older Image Studio builds → Story Studio falls back to its static table.
  sizes?: ImageStudioSize[]
  default_aspect_ratio?: string
  supports_custom_dimensions?: boolean
  custom?: { min_px?: number; max_px?: number; step?: number; max_pixels?: number } | null
  cloud_provider_label?: string
  cloud_signup_url?: string
}

/** One concrete output size a model accepts. `tier`: fast | balanced | high |
 *  ultra. `fixed`: the model ignores width/height (single real output). */
export interface ImageStudioSize {
  aspect_ratio: string
  label?: string
  width: number
  height: number
  tier?: string
  default?: boolean
  fixed?: boolean
}

export interface ImageStudioFamily {
  id: string
  label: string
  summary?: string
  how_to_use?: string
}

export interface ImageStudioCatalog {
  families: Record<string, ImageStudioFamily>
  models: ImageStudioCatalogModel[]
}

export interface ImageStudioLora {
  name: string
  size_bytes?: number
  /** Path on the modal's disk; informational. */
  path?: string
}

interface PollOpts {
  isCancelled?: () => boolean
  /** Total wait cap, ms. Default 24 h (see below). */
  timeoutMs?: number
  /** Optional progress hook fired on every successful status response. */
  onProgress?: (job: ImageStudioJob) => void
}

/**
 * v1.0.154+ — was 30 min, bumped to 24 h.
 *
 * Why so generous? FLUX.2 klein 4-bit on the 8 GB M1 (the user's modal
 * Mac) takes ~5 min per image. A deep batch (100-200 scenes) drains
 * serially because only one inference fits in 8 GB unified memory at
 * once. The N-th job's modal-side wait is `(N-1) × 5min` BEFORE
 * inference even starts — so for N=200 that's 16.5 h queued before
 * 5 min running. 24 h covers that worst case with margin and matches
 * the typical "queue overnight" workflow the user described.
 *
 * Generators that prefer a tighter cap can pass `timeoutMs` explicitly;
 * this is just the default when the caller doesn't supply one.
 */
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60_000

function trimBaseUrl(baseUrl: string): string {
  const t = (baseUrl || '').trim()
  if (!t) throw new Error('Image Studio base URL is empty. Set it in App Settings → Local Models.')
  return t.replace(/\/+$/, '')
}

function joinUrl(baseUrl: string, p: string): string {
  return `${trimBaseUrl(baseUrl)}${p.startsWith('/') ? p : `/${p}`}`
}

/**
 * Friendly Tailscale-aware connection error. Mirrors the helper in
 * voicestudio-client.ts because the failure modes are identical (modal
 * asleep, port shifted by Pinokio between launches, Tailscale dropped).
 */
function friendlyConnectError(baseUrl: string, e: any): Error {
  const code: string = e?.cause?.code || e?.code || ''
  const msg: string = e?.message || String(e)
  if (code === 'ENOTFOUND' || code === 'ENETUNREACH' || code === 'EAI_AGAIN' || /getaddrinfo|fetch failed/i.test(msg)) {
    return new Error(
      `Cannot reach Image Studio modal at ${baseUrl}. ` +
      `Check that Tailscale is connected and Pinokio is running.`,
    )
  }
  if (code === 'ECONNREFUSED' || /connect.*refused/i.test(msg)) {
    return new Error(
      `Image Studio modal at ${baseUrl} refused the connection. ` +
      `Confirm Pinokio still has the wrapper running on that port — ` +
      `Pinokio sometimes shifts ports between launches.`,
    )
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(msg)) {
    return new Error(
      `Image Studio modal at ${baseUrl} timed out. ` +
      `Tailscale may be reconnecting — try again in a moment.`,
    )
  }
  return e instanceof Error ? e : new Error(msg)
}

/** Liveness probe. Never throws — returns `{ ok: false, error }` on failure. */
export async function health(baseUrl: string, timeoutMs = 5_000): Promise<ImageStudioHealth> {
  try {
    const resp = await fetch(joinUrl(baseUrl, '/api/health'), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) {
      return { ok: false, error: `Health check failed (${resp.status})` }
    }
    const data = await resp.json() as { ok?: boolean; version?: string; app_version?: string; hf_home?: string }
    return {
      ok: data.ok === true,
      apiVersion: data.version,
      appVersion: data.app_version,
      hfHome: data.hf_home,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** Full model + family catalog. Source-of-truth for the Settings UI's model picker. */
export async function catalog(baseUrl: string): Promise<ImageStudioCatalog> {
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/catalog'), {
      signal: AbortSignal.timeout(8_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Image Studio catalog fetch failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = await resp.json() as any
  return {
    families: (data.families && typeof data.families === 'object') ? data.families : {},
    models: Array.isArray(data.models) ? data.models : [],
  }
}

// ── Dynamic model surfacing (mirrors the Voice Studio engine catalog) ──────
//
// Story Studio model id ⇄ HuggingFace repo. The repo IS the modal's model
// identifier, so we use it verbatim behind a stable prefix: `imagestudio:`.
// (The original single static id used dashes — keep it working via alias.)

export const IMAGESTUDIO_MODEL_PREFIX = 'imagestudio:'

/** Pre-dynamic ids → repo, so existing projects' saved selections still run. */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'imagestudio-flux2-klein-mlx-4bit': 'AITRADER/FLUX2-klein-4B-mlx-4bit',
}

/** Story Studio image-model id for a catalog repo. */
export function modelIdForRepo(repo: string): string {
  return IMAGESTUDIO_MODEL_PREFIX + repo
}

/** Resolve a Story Studio model id back to a modal repo, or undefined. */
export function repoForModelId(modelId: string): string | undefined {
  if (modelId.startsWith(IMAGESTUDIO_MODEL_PREFIX)) {
    return modelId.slice(IMAGESTUDIO_MODEL_PREFIX.length)
  }
  return LEGACY_MODEL_ALIASES[modelId]
}

/** True for any id this provider owns (dynamic prefix or a legacy alias). */
export function isImageStudioModelId(modelId: string): boolean {
  return modelId.startsWith(IMAGESTUDIO_MODEL_PREFIX) || modelId in LEGACY_MODEL_ALIASES
}

export interface ImageStudioDiagnosticsEngine {
  family: string
  ready: boolean
  wired: boolean
  deps_ok: boolean
  missing: string[]
}

/** Per-family readiness (engine wired + deps present). NOT download state. */
export async function diagnostics(baseUrl: string): Promise<{ device?: string; engines: ImageStudioDiagnosticsEngine[] }> {
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/generate/diagnostics'), { signal: AbortSignal.timeout(8_000) })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) throw new Error(`Image Studio diagnostics failed (${resp.status})`)
  const data = await resp.json() as any
  const engines: ImageStudioDiagnosticsEngine[] = Array.isArray(data.engines)
    ? data.engines.map((e: any) => ({
        family: String(e.family),
        ready: !!e.ready,
        wired: !!e.wired,
        deps_ok: !!e.deps_ok,
        missing: Array.isArray(e.missing) ? e.missing : [],
      }))
    : []
  return { device: typeof data.device === 'string' ? data.device : undefined, engines }
}

/** Host hardware — used to gate models whose memory floor the Mac can't meet. */
export async function system(baseUrl: string): Promise<{ chip?: string; unified_memory_gb?: number }> {
  try {
    const resp = await fetch(joinUrl(baseUrl, '/api/system'), { signal: AbortSignal.timeout(6_000) })
    if (!resp.ok) return {}
    const d = await resp.json() as any
    return {
      chip: typeof d.chip === 'string' ? d.chip : undefined,
      unified_memory_gb: typeof d.unified_memory_gb === 'number' ? d.unified_memory_gb : undefined,
    }
  } catch { return {} }
}

/** A catalog model annotated with live readiness + memory-fit for the picker. */
export interface ImageStudioModelInfo {
  id: string                  // Story Studio model id (`imagestudio:<repo>`)
  repo: string
  label: string
  family: string
  family_label?: string
  capabilities: string[]      // txt2img | img2img | edit
  size_gb?: number
  gated?: boolean
  apple_optimized?: boolean
  best_for?: string
  ready: boolean              // engine family wired + deps present (always true for cloud)
  fits_memory: boolean        // host unified memory meets the model's floor (always true for cloud)
  // v1.0.476 — cloud-proxied model surfacing.
  is_cloud?: boolean
  cloud_provider?: string     // 'together' | 'cloudflare' | 'pollinations' | …
  downloaded?: boolean        // local model files present (or cloud — nothing to download)
  needs_credentials?: boolean // v1.0.477 — cloud model whose required API key is missing
  cloud_provider_label?: string
  cloud_signup_url?: string
  // v1.0.478 — per-model dimension menu (passed through from the catalog).
  sizes?: ImageStudioSize[]
  default_aspect_ratio?: string
  supports_custom_dimensions?: boolean
  custom?: { min_px?: number; max_px?: number; step?: number; max_pixels?: number } | null
}

/**
 * v1.0.205+ — the dynamic model list for the picker, mirroring Voice
 * Studio's `listAvailableEngines`. Joins the live `/api/catalog` with
 * `/diagnostics` (per-family ready) and `/system` (memory floor). The
 * frontend surfaces these directly, so a model downloaded/enabled on the
 * modal — or any future catalog addition — appears with zero app changes.
 */
export async function listAvailableModels(baseUrl: string): Promise<{
  ok: boolean
  models: ImageStudioModelInfo[]
  unified_memory_gb?: number
  error?: string
}> {
  try {
    const [cat, diag, sys] = await Promise.all([
      catalog(baseUrl),
      diagnostics(baseUrl).catch(() => ({ engines: [] as ImageStudioDiagnosticsEngine[] })),
      system(baseUrl).catch(() => ({} as { unified_memory_gb?: number })),
    ])
    const readyByFamily = new Map(diag.engines.map(e => [e.family, e.ready]))
    const mem = sys.unified_memory_gb
    const models: ImageStudioModelInfo[] = cat.models.map(m => {
      const floor = typeof m.min_unified_memory_gb === 'number' ? m.min_unified_memory_gb : undefined
      // v1.0.476 — cloud-proxied models have no local engine + no download, so the
      // local-engine diagnostics never list them. Treat them as fitting, and ready
      // UNLESS Image Studio reports the required credential is missing (v1.0.477,
      // handled defensively across both signals). Else they'd be permanently
      // unselectable (pre-476) or wrongly selectable without a key (pre-477).
      const isCloud = !!m.is_cloud
      const cloudCredsMissing = isCloud
        && (m.cloud_credentials_ok === false || m.fit?.state === 'needs_key')
      return {
        id: modelIdForRepo(m.repo),
        repo: m.repo,
        label: m.label,
        family: m.family,
        family_label: cat.families[m.family]?.label || m.family_label,
        capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
        size_gb: m.size_gb,
        gated: m.gated,
        apple_optimized: m.apple_optimized,
        best_for: m.best_for,
        ready: isCloud ? !cloudCredsMissing : (readyByFamily.get(m.family) ?? false),
        fits_memory: isCloud ? true : (mem === undefined || floor === undefined ? true : floor <= mem),
        is_cloud: isCloud,
        cloud_provider: m.cloud_provider,
        downloaded: isCloud || m.cache?.state === 'cached',
        needs_credentials: cloudCredsMissing,
        cloud_provider_label: m.cloud_provider_label,
        cloud_signup_url: m.cloud_signup_url,
        sizes: Array.isArray(m.sizes) ? m.sizes : undefined,
        default_aspect_ratio: m.default_aspect_ratio,
        supports_custom_dimensions: m.supports_custom_dimensions,
        custom: m.custom ?? undefined,
      }
    })
    return { ok: true, models, unified_memory_gb: mem }
  } catch (e: any) {
    return { ok: false, models: [], error: e?.message || String(e) }
  }
}

// Short-lived catalog cache so the provider can resolve a repo's
// capabilities (txt2img/img2img/edit) without a network round-trip on
// every generate. 60s TTL — the catalog rarely changes mid-session.
let _capCache: { baseUrl: string; at: number; byRepo: Map<string, string[]> } | null = null
const _CAP_TTL_MS = 60_000

/**
 * Capabilities for a repo, cached. Returns null when the catalog can't be
 * reached and the repo isn't cached — caller should fall back to a sane
 * default (treat as txt2img/img2img capable).
 */
export async function capabilitiesForRepo(baseUrl: string, repo: string): Promise<string[] | null> {
  const now = Date.now()
  if (!_capCache || _capCache.baseUrl !== baseUrl || now - _capCache.at > _CAP_TTL_MS) {
    try {
      const cat = await catalog(baseUrl)
      const byRepo = new Map<string, string[]>()
      for (const m of cat.models) byRepo.set(m.repo, Array.isArray(m.capabilities) ? m.capabilities : [])
      _capCache = { baseUrl, at: now, byRepo }
    } catch {
      if (_capCache?.byRepo.has(repo)) return _capCache.byRepo.get(repo)!
      return null
    }
  }
  return _capCache.byRepo.get(repo) ?? null
}

/** User's saved LoRA files. Empty by default. */
export async function listLoras(baseUrl: string): Promise<ImageStudioLora[]> {
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/loras'), {
      signal: AbortSignal.timeout(6_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Image Studio LoRA list failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = await resp.json() as { loras?: ImageStudioLora[] }
  return Array.isArray(data.loras) ? data.loras : []
}

/** Submit a txt2img job. Returns the new job_id and queue metadata. */
export async function submitTxt2Img(
  baseUrl: string,
  params: ImageStudioTxt2ImgParams,
): Promise<ImageStudioSubmitResponse> {
  const body: Record<string, unknown> = { repo: params.repo, prompt: params.prompt }
  if (params.negative_prompt) body.negative_prompt = params.negative_prompt
  if (typeof params.width === 'number') body.width = params.width
  if (typeof params.height === 'number') body.height = params.height
  if (typeof params.steps === 'number') body.steps = params.steps
  if (typeof params.guidance === 'number') body.guidance = params.guidance
  if (typeof params.seed === 'number') body.seed = params.seed
  if (typeof params.quantize === 'number') body.quantize = params.quantize
  if (Array.isArray(params.lora_names) && params.lora_names.length) {
    body.lora_names = params.lora_names
    body.lora_scales = Array.isArray(params.lora_scales)
      ? params.lora_scales
      : params.lora_names.map(() => 1.0)
  }

  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/generate/txt2img'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Image Studio submit failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  // v1.0.153+ — modal wraps the job in `{ job: {...} }` and uses `state`
  // instead of `status`. unwrapJob handles both envelope variants +
  // field-name spellings so future wrapper changes are absorbed.
  const job = unwrapJob(data)
  if (!job.id) {
    throw new Error(`Image Studio submit returned no job id: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return {
    job_id: job.id,
    status: job.status,
    queue_position: typeof data?.queue_position === 'number' ? data.queue_position : undefined,
    estimated_seconds: typeof data?.estimated_seconds === 'number' ? data.estimated_seconds : undefined,
  }
}

/**
 * Submit a multipart generation job (img2img or edit). Both endpoints take
 * the source image as a `image` file part plus form fields. Verified live.
 * `mode` selects the endpoint; the only field difference is that edit has
 * no negative_prompt (harmless to omit for both here).
 */
async function submitMultipart(
  baseUrl: string,
  mode: 'img2img' | 'edit',
  fields: {
    imagePath: string
    repo: string
    prompt: string
    negative_prompt?: string
    width?: number
    height?: number
    steps?: number
    guidance?: number
    seed?: number | null
    image_strength?: number
    quantize?: number | null
    lora_names?: string[]
    lora_scales?: number[]
  },
): Promise<ImageStudioSubmitResponse> {
  const buf = await fs.readFile(fields.imagePath)
  const form = new FormData()
  // Node's global FormData/Blob (18+). Filename + type keep the server's
  // multipart parser happy; PNG is what our pipeline writes.
  const ext = path.extname(fields.imagePath).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  form.append('image', new Blob([buf as any], { type: mime }), path.basename(fields.imagePath))
  form.append('repo', fields.repo)
  form.append('prompt', fields.prompt)
  if (fields.negative_prompt) form.append('negative_prompt', fields.negative_prompt)
  if (typeof fields.width === 'number') form.append('width', String(fields.width))
  if (typeof fields.height === 'number') form.append('height', String(fields.height))
  if (typeof fields.steps === 'number') form.append('steps', String(fields.steps))
  if (typeof fields.guidance === 'number') form.append('guidance', String(fields.guidance))
  if (typeof fields.seed === 'number') form.append('seed', String(fields.seed))
  if (typeof fields.image_strength === 'number') form.append('image_strength', String(fields.image_strength))
  if (typeof fields.quantize === 'number') form.append('quantize', String(fields.quantize))
  // LoRA params are comma-joined strings on the multipart endpoints (arrays
  // on the JSON txt2img endpoint).
  if (Array.isArray(fields.lora_names) && fields.lora_names.length) {
    form.append('lora_names', fields.lora_names.join(','))
    const scales = Array.isArray(fields.lora_scales) && fields.lora_scales.length
      ? fields.lora_scales
      : fields.lora_names.map(() => 1.0)
    form.append('lora_scales', scales.join(','))
  }

  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, `/api/generate/${mode}`), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Image Studio ${mode} submit failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  const job = unwrapJob(data)
  if (!job.id) {
    throw new Error(`Image Studio ${mode} submit returned no job id: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return {
    job_id: job.id,
    status: job.status,
    queue_position: typeof data?.queue_position === 'number' ? data.queue_position : undefined,
    estimated_seconds: typeof data?.estimated_seconds === 'number' ? data.estimated_seconds : undefined,
  }
}

/** Image-to-image: regenerate from a source image + prompt (caps: img2img). */
export async function submitImg2Img(
  baseUrl: string,
  params: ImageStudioImg2ImgParams,
): Promise<ImageStudioSubmitResponse> {
  return submitMultipart(baseUrl, 'img2img', {
    imagePath: params.imagePath,
    repo: params.repo,
    prompt: params.prompt,
    negative_prompt: params.negative_prompt,
    width: params.width,
    height: params.height,
    steps: params.steps,
    guidance: params.guidance,
    seed: params.seed,
    image_strength: params.image_strength,
    quantize: params.quantize,
    lora_names: params.lora_names,
    lora_scales: params.lora_scales,
  })
}

/** Instruction-edit: apply a text-described change (caps: edit — Kontext/Qwen-Edit). */
export async function submitEdit(
  baseUrl: string,
  params: ImageStudioEditParams,
): Promise<ImageStudioSubmitResponse> {
  return submitMultipart(baseUrl, 'edit', {
    imagePath: params.imagePath,
    repo: params.repo,
    prompt: params.prompt,
    width: params.width,
    height: params.height,
    steps: params.steps,
    guidance: params.guidance,
    seed: params.seed,
    image_strength: params.image_strength,
    quantize: params.quantize,
    lora_names: params.lora_names,
    lora_scales: params.lora_scales,
  })
}

/**
 * Poll a job until done or failed. Same adaptive cadence as the Voice
 * Studio client (2s → 5s → 10s; honours `eta_seconds`). MLX image
 * inference on an M1 typically takes 5–25s for FLUX.2 klein 4-bit at
 * 4 steps; longer for bigger models. The 30-min deadline is comfortably
 * above that and protects against the modal silently wedging.
 */
export async function pollJob(
  baseUrl: string,
  jobId: string,
  opts: PollOpts = {},
): Promise<ImageStudioJob> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let polls = 0
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) {
      await cancelJob(baseUrl, jobId).catch(() => {})
      throw new Error('Cancelled by user')
    }

    let resp: Response
    try {
      resp = await fetch(joinUrl(baseUrl, `/api/generate/jobs/${jobId}`), {
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      throw friendlyConnectError(baseUrl, e)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Image Studio poll failed (${resp.status}): ${text.slice(0, 300)}`)
    }
    // v1.0.153+ — poll response also wraps in `{ job: {...} }` with
    // `state`. unwrapJob normalises to our union; without it the poll
    // loop would never see 'done' because job.status was undefined.
    const raw = await resp.json()
    const job = unwrapJob(raw)
    try { opts.onProgress?.(job) } catch { /* never let UI plumbing kill polling */ }

    if (job.status === 'done') return job
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`Image Studio job ${job.status}: ${job.error || job.message || 'unknown error'}`)
    }

    const baseSleepMs =
      polls < 6 ? 2_000 :
      polls < 18 ? 5_000 :
      10_000
    const eta = typeof job.eta_seconds === 'number' ? job.eta_seconds : 0
    const etaSleep = eta > 8 ? Math.min(eta * 1000 * 0.5, 10_000) : 0
    const sleepMs = Math.max(baseSleepMs, etaSleep)

    await sleepCancellable(sleepMs, opts.isCancelled)
    polls += 1
  }
  throw new Error(`Image Studio job ${jobId} did not complete within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} min`)
}

/** Best-effort server-side cancel. Never throws. */
export async function cancelJob(baseUrl: string, jobId: string): Promise<void> {
  try {
    await fetch(joinUrl(baseUrl, `/api/generate/jobs/${jobId}`), {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    /* fail-quiet — local polling already stopped, server-side cancel is bonus */
  }
}

/**
 * Build the HTTP URL where the finished image lives on the modal. Returned
 * by the provider as one of `urls[]` so generators/images.ts's existing
 * `downloadImage(url, savePath)` pipeline picks it up like any other
 * provider URL — no special-casing for local modals needed.
 */
export function jobImageUrl(baseUrl: string, jobId: string): string {
  return joinUrl(baseUrl, `/api/generate/jobs/${jobId}/image`)
}

/**
 * Direct binary download (used by the test endpoint and preview routes
 * that want bytes rather than a URL). The generators/images.ts path
 * doesn't call this — it consumes the URL via downloadImage instead.
 */
export async function downloadImage(
  baseUrl: string,
  jobId: string,
  outPath: string,
  opts: { signal?: AbortSignal; onProgress?: (bytesReceived: number, totalBytes?: number) => void } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  let resp: Response
  try {
    resp = await fetch(jobImageUrl(baseUrl, jobId), {
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Image Studio image download failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const cl = resp.headers.get('content-length')
  const total = cl ? Number(cl) || undefined : undefined
  let received = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      try { opts.onProgress?.(received, total) } catch { /* never let UI plumbing kill a download */ }
      cb(null, chunk)
    },
  })
  const out = createWriteStream(outPath)
  try {
    await pipeline(Readable.fromWeb(resp.body as any), counter, out)
  } catch (e) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw e
  }
  const stat = await fs.stat(outPath)
  if (stat.size === 0) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw new Error('Image Studio download wrote 0 bytes')
  }
}
