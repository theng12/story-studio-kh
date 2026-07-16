/**
 * Image Studio KH image provider — local TTI modal via Tailscale.
 *
 * v1.0.151+ — mirrors the Voice Studio audio provider's shape. The
 * "apiKey" slot in the model registry carries the modal's base URL,
 * not a secret — Tailscale handles auth at the network layer.
 *
 * v1.0.205+ — fully dynamic. Model ids are `imagestudio:<repo>` resolved
 * straight from the live `/api/catalog`, so any model the modal lists works
 * with no per-model wiring (mirrors the Voice Studio engine catalog). The
 * provider routes by request shape + the model's catalog capabilities:
 *   - no reference image            → POST /api/generate/txt2img
 *   - reference + img2img-capable   → POST /api/generate/img2img
 *   - reference + edit-only model   → POST /api/generate/edit
 *
 * `aspectRatio` → width/height uses the same 8 preset ratios
 * `/api/generate/availability` returns.
 */

import { registry } from '../registry.js'
import {
  submitTxt2Img, submitImg2Img, submitEdit, pollJob, jobImageUrl,
  repoForModelId, isImageStudioModelId, capabilitiesForRepo,
  DEFAULT_IMAGESTUDIO_BASE_URL, getImagestudioDispatcher, health as imgHealth,
  type ImageStudioTxt2ImgParams,
} from '../../lib/imagestudio-client.js'
import { runOnPool } from '../../lib/endpoint-pool.js'
import { getHubBackend, hubSubmitJob, hubPollBatch, hubBatchArtifactUrl, getOrUploadHubAsset, invalidateHubAsset, type HubBackend, type HubJobItem } from '../../lib/studiohub-client.js'
import { promises as fsp } from 'fs'

/**
 * Read a local reference image as base64 + mime for the Studio Hub batch API
 * (img2img / edit). Mime is sniffed from the magic bytes so the Hub decodes it
 * correctly regardless of file extension.
 */
async function readImageAsBase64(filePath: string): Promise<{ b64: string; mime: string }> {
  const buf = await fsp.readFile(filePath)
  let mime = 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mime = 'image/jpeg'
  else if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) mime = 'image/png'
  else if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp'
  return { b64: buf.toString('base64'), mime }
}

// v1.0.306 — pre-flight probe timeout. A few of the user's Macs HANG the connect
// (asleep but on the network) rather than refusing it; without this, the 30s
// submit timeout is what eventually frees them. The probe detects an unreachable
// endpoint in ~4s and throws a connection error so runOnPool fails over fast.
const IMAGESTUDIO_PREFLIGHT_PROBE_MS = 4000
import type { ImageProvider, ImageGenerationRequest, ImageGenerationResult } from '../types.js'

/**
 * Aspect ratio → pixel dimensions. Mirrors the preset list returned by
 * GET /api/generate/availability so the modal's recommended dimensions
 * are what we send. Any unknown ratio falls back to 1024×1024.
 */
const ASPECT_PRESETS: Record<string, { width: number; height: number }> = {
  '1:1':  { width: 1024, height: 1024 },
  '16:9': { width: 1344, height:  768 },
  '9:16': { width:  768, height: 1344 },
  '4:3':  { width: 1152, height:  864 },
  '3:4':  { width:  864, height: 1152 },
  '21:9': { width: 1536, height:  640 },
  '3:2':  { width: 1216, height:  832 },
  '2:3':  { width:  832, height: 1216 },
}

function resolveDimensions(aspectRatio: string): { width: number; height: number } {
  return ASPECT_PRESETS[aspectRatio] || ASPECT_PRESETS['1:1']
}

/**
 * Render dimensions for a local Image Studio render: the aspect-ratio base
 * preset scaled by `scalePct` (100 = full preset), rounded to /16 and clamped
 * to the modal's 256–2048 range. Single source of truth shared with the
 * continuity renderer so a Pipeline batch — which carries the preset's
 * `render_scale` percentage rather than explicit pixels — renders at exactly
 * the size the Scene Review page's size picker would have produced.
 */
export function dimsForAspectScale(aspectRatio: string, scalePct: number): { width: number; height: number } {
  const base = resolveDimensions(aspectRatio)
  const s = (Number.isFinite(scalePct) && scalePct > 0 ? scalePct : 100) / 100
  const r16 = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 16) * 16))
  return { width: r16(base.width * s), height: r16(base.height * s) }
}

/**
 * Distilled FLUX/Z-Image variants (klein, schnell, turbo) run at very few
 * steps and ignore guidance. Everything else needs full step counts. We
 * derive this from the repo string so it holds for any catalog model
 * without a per-model table.
 */
function stepGuidanceDefaults(repo: string): { steps: number; guidance: number } {
  const r = repo.toLowerCase()
  const distilled = r.includes('klein') || r.includes('schnell') || r.includes('turbo')
  return distilled ? { steps: 4, guidance: 1.0 } : { steps: 20, guidance: 3.5 }
}

function commonOverrides(req: ImageGenerationRequest): {
  steps: number; guidance: number; seed?: number; negative_prompt?: string
  lora_names?: string[]; lora_scales?: number[]
} {
  const repo = repoForModelId(req.modelId)!
  const d = stepGuidanceDefaults(repo)
  const out: ReturnType<typeof commonOverrides> = {
    steps: (req.providerParams?.steps as number) || d.steps,
    guidance: (req.providerParams?.guidance as number) ?? d.guidance,
  }
  if (typeof req.providerParams?.negative_prompt === 'string') out.negative_prompt = req.providerParams.negative_prompt
  if (typeof req.providerParams?.seed === 'number') out.seed = req.providerParams.seed
  // LoRAs (advanced): only forward when explicitly set, else the wrapper's
  // own LoRA stack (set in its web UI) stays in effect.
  if (Array.isArray(req.providerParams?.lora_names) && req.providerParams.lora_names.length) {
    out.lora_names = req.providerParams.lora_names
    if (Array.isArray(req.providerParams.lora_scales)) out.lora_scales = req.providerParams.lora_scales
  }
  return out
}

/**
 * Decide which endpoint a reference-image request should hit, from the
 * model's catalog capabilities:
 *   - supports img2img → img2img (general reference-guided regeneration)
 *   - edit-only (Kontext / Qwen-Edit / Fibo-Edit) → edit
 * Falls back to img2img when the catalog can't be reached (most models
 * support it; an edit-only model would then surface a clear server error).
 */
async function resolveRefMode(baseUrl: string, repo: string): Promise<'img2img' | 'edit'> {
  const caps = await capabilitiesForRepo(baseUrl, repo)
  if (caps && !caps.includes('img2img') && caps.includes('edit')) return 'edit'
  return 'img2img'
}

/**
 * Build ONE Studio Hub batch item from an image request — dims, step/guidance
 * overrides, LoRAs, and (for a reference-guided render) the primary anchor as an
 * uploaded asset_id (upload-once) or inline base64. Shared by the single-image
 * Hub path (generateImage) and the multi-scene batch path (renderImageBatchViaHub)
 * so the two never drift. `inlineRefOnly` forces base64 (the stale-asset retry).
 */
async function buildHubImageItem(
  request: ImageGenerationRequest,
  hub: HubBackend,
  inlineRefOnly = false,
): Promise<HubJobItem> {
  const round16 = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 16) * 16))
  const dims = (typeof request.width === 'number' && typeof request.height === 'number')
    ? { width: round16(request.width), height: round16(request.height) }
    : resolveDimensions(request.aspectRatio)
  const o = commonOverrides(request)
  const refs = request.referenceImagePaths
  const sourceImage = Array.isArray(refs) && refs.length ? refs[0] : undefined
  const params: Record<string, any> = {
    width: dims.width, height: dims.height, steps: o.steps, guidance: o.guidance,
  }
  if (o.negative_prompt) params.negative_prompt = o.negative_prompt
  if (o.lora_names) { params.lora_names = o.lora_names; if (o.lora_scales) params.lora_scales = o.lora_scales }
  if (sourceImage) {
    let ref: Record<string, any> | null = null
    if (!inlineRefOnly) {
      const assetId = await getOrUploadHubAsset(hub.hubUrl, hub.hubToken, sourceImage)
      if (assetId) ref = { asset_id: assetId }
    }
    if (!ref) { const { b64, mime } = await readImageAsBase64(sourceImage); ref = { b64, mime } }
    params.reference_images = [ref]
    if (typeof request.providerParams?.image_strength === 'number') {
      params.image_strength = request.providerParams.image_strength
    }
  }
  const item: HubJobItem = { prompt: request.prompt, params }
  if (typeof o.seed === 'number') item.seed = o.seed
  return item
}

export interface HubBatchItemOutcome { url?: string; taskId?: string; error?: string }

/**
 * Render MANY image requests as ONE Studio Hub batch (§6b) — the Hub owns the
 * queue and work-steals every item across the WHOLE fleet, instead of Story
 * Studio submitting N separate jobs capped by its own worker pool. Results
 * stream back per item as they finish (poll-based; no webhook). All requests
 * must share the same model. Throws (connection-phrased) if the Hub is
 * unreachable so the caller can fall back to its per-scene path.
 */
export async function renderImageBatchViaHub(
  requests: ImageGenerationRequest[],
  opts: {
    label?: string
    isCancelled?: () => boolean
    onItemDone?: (index: number, result: HubBatchItemOutcome) => void | Promise<void>
  } = {},
): Promise<void> {
  if (!requests.length) return
  const hub = await getHubBackend()
  if (hub.mode !== 'hub' || !hub.hubUrl) throw new Error('Studio Hub is not the active backend')
  const repo = repoForModelId(requests[0]!.modelId)
  if (!repo) throw new Error(`Studio Hub batch received unknown model id '${requests[0]!.modelId}'.`)
  const items: HubJobItem[] = []
  for (const r of requests) items.push(await buildHubImageItem(r, hub))
  const sub = await hubSubmitJob(hub.hubUrl, hub.hubToken, {
    modality: 'image', model: repo, label: opts.label || 'storystudio-kh', routing: 'pool', items,
  })
  await hubPollBatch(hub.hubUrl, hub.hubToken, sub.batch_id, {
    isCancelled: opts.isCancelled,
    // Generous ceiling — the Hub owns the queue; poll just needs to outlast it.
    timeoutMs: Math.max(20 * 60_000, requests.length * 45_000),
    onItemDone: async (it) => {
      await opts.onItemDone?.(it.index, {
        url: it.state === 'done' && it.artifact_url
          ? hubBatchArtifactUrl(hub.hubUrl, sub.batch_id, it.index)
          : undefined,
        taskId: it.asset_id || sub.batch_id,
        error: it.state === 'done' ? undefined : (it.error || it.state),
      })
    },
  })
}

const imagestudioImageProvider: ImageProvider = {
  meta: {
    id: 'imagestudio',
    name: 'Image Studio (Local)',
    // Same "URL-as-apiKey" pattern as Voice Studio — the apiKey slot in
    // the registry carries the Tailscale base URL of the Pinokio modal.
    // Tailscale handles auth at the network layer so there's no real
    // secret. Persists per-Mac via the app-secrets-store 'imagestudio' slot.
    apiKeyField: 'imagestudio_base_url',
    providerId: 'imagestudio',
  },

  /**
   * Only handles models whose registry entry routes here via the
   * `provider: 'imagestudio'` field. The kie provider uses a different
   * gate (presence of `endpoint`); we match Voice Studio's stricter
   * shape since the model ids are namespaced (`imagestudio-*`).
   */
  supportsModel(_modelId: string, providerParams: Record<string, any>): boolean {
    return providerParams?.provider === 'imagestudio'
      || isImageStudioModelId(_modelId)
  },

  /**
   * Submit → poll → return the modal's own image URL. The downstream
   * `downloadImage(url, savePath)` in generators/images.ts fetches the
   * URL directly, so the modal stays the source-of-truth for the bytes
   * up to the download step. No temp file dance in the provider —
   * cleaner than the Voice Studio path because images return URLs by
   * convention while audio returns file:// from the registry shape.
   */
  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    // v1.0.306 — the apiKey slot may hold a comma/space-separated LIST of modal
    // URLs (one per Mac). Parse it into a pool: a generateImage call submits +
    // polls on ONE endpoint, and runOnPool fails over to a healthy Mac on a
    // connection error. (Before this, the whole list was passed to fetch() as a
    // single URL → "Failed to parse URL from <list>/api/generate/txt2img".)
    const rawApiKey = (request.apiKey || '').trim() || DEFAULT_IMAGESTUDIO_BASE_URL
    if (!rawApiKey) {
      throw new Error(
        'Image Studio modal URL not configured. ' +
        'Open App Settings → Local Models and set the URL (Tailscale IP + port).',
      )
    }
    if (request.isCancelled?.()) throw new Error('Cancelled by user')

    const repo = repoForModelId(request.modelId)
    if (!repo) throw new Error(`Image Studio provider received unknown model id '${request.modelId}'.`)
    const { dispatcher, endpoints } = getImagestudioDispatcher(rawApiKey)
    const fallbackUrl = endpoints[0] || rawApiKey
    // v1.0.261 — honour an explicit pixel size when the caller sends one (Scene
    // Review's "render size" tier); else fall back to the aspect preset. Clamp
    // to sane bounds and round to /16 (FLUX/MLX engines require it).
    const round16 = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 16) * 16))
    const dims = (typeof request.width === 'number' && typeof request.height === 'number')
      ? { width: round16(request.width), height: round16(request.height) }
      : resolveDimensions(request.aspectRatio)
    const o = commonOverrides(request)
    const refs = request.referenceImagePaths
    const sourceImage = Array.isArray(refs) && refs.length ? refs[0] : undefined

    // Studio Hub routing: when local_backend === 'hub', submit the render to the
    // Hub, which delegates across the fleet. BOTH txt2img and reference-guided
    // (img2img / edit) are supported — a reference image rides along as base64
    // in params.reference_images (Phase 2b; the Hub decodes + forwards it to the
    // studio's img2img/edit and infers the mode from the model's capabilities).
    // Hub and Direct are explicit, mutually exclusive settings. A Hub failure
    // surfaces as-is and never starts duplicate work against the direct pool.
    const hub = await getHubBackend()
    if (hub.mode === 'hub') {
      if (!hub.hubUrl) throw new Error('Studio Hub routing is selected, but no Hub URL is configured.')
        // Submit a 1-item batch. For a reference-guided render, buildHubImageItem
        // prefers an UPLOADED asset_id (upload-once — the same character sheet is
        // reused across a whole render, so we don't re-base64 it per scene) and
        // falls back to inline base64. `inlineOnly` forces base64 (stale-asset
        // retry). buildHubImageItem is shared with renderImageBatchViaHub.
        const runHub = async (inlineOnly: boolean) => {
          const item = await buildHubImageItem(request, hub, inlineOnly)
          const usedAsset = !!((item.params as any)?.reference_images?.[0]?.asset_id)
          const sub = await hubSubmitJob(hub.hubUrl, hub.hubToken, {
            modality: 'image', model: repo, label: 'storystudio-kh', routing: 'pool', items: [item],
          })
          const status = await hubPollBatch(hub.hubUrl, hub.hubToken, sub.batch_id, { isCancelled: request.isCancelled })
          return { item: status.items?.[0], governor: status.governor_note, batchId: sub.batch_id, usedAsset }
        }
        let { item, governor, batchId, usedAsset } = await runHub(false)
        // A cached asset_id can go stale if the Hub restarted and dropped its
        // store — the item errors. Invalidate and retry once with inline base64.
        if (usedAsset && sourceImage && item?.state === 'error') {
          await invalidateHubAsset(sourceImage)
          ;({ item, governor, batchId } = await runHub(true))
        }
        if (!item || item.state !== 'done' || !item.artifact_url) {
          throw new Error(
            `Studio Hub image job did not produce an image: ${item?.error || item?.state || 'no item'}` +
            `${governor ? ` (${governor})` : ''}`,
          )
        }
      return { urls: [hubBatchArtifactUrl(hub.hubUrl, batchId, item.index)], taskId: batchId }
    }

    // Submit + poll on a SINGLE pooled endpoint. runOnPool picks least-busy and,
    // on a connection error (friendlyConnectError → "cannot reach"/"refused",
    // matched by isConnectionError), marks that Mac down and re-runs the whole
    // submit+poll on another. Single-endpoint setups (dispatcher === null) run
    // straight through against fallbackUrl — byte-for-byte the old behaviour.
    return runOnPool(dispatcher, fallbackUrl, async (baseUrl) => {
      if (request.isCancelled?.()) throw new Error('Cancelled by user')
      // Pre-flight reachability probe — skip a hanging Mac in ~4s rather than
      // eating the 30s submit timeout. Only meaningful when pooling (>1
      // endpoint); for a single endpoint we let the submit's own error surface.
      if (dispatcher) {
        const probe = await imgHealth(baseUrl, IMAGESTUDIO_PREFLIGHT_PROBE_MS)
        if (!probe.ok) {
          throw new Error(
            `Image Studio at ${baseUrl} is unreachable: ${probe.error || 'no response'}. ` +
            `Connection error — failing over.`,
          )
        }
      }
      let submit
      if (sourceImage) {
        // Reference-driven: img2img (general) or edit (Kontext/Qwen-Edit), by capability.
        const mode = await resolveRefMode(baseUrl, repo)
        const strength = typeof request.providerParams?.image_strength === 'number'
          ? request.providerParams.image_strength
          : undefined  // let the client/modal default (0.6 img2img, 0.85 edit)
        if (mode === 'edit') {
          submit = await submitEdit(baseUrl, {
            imagePath: sourceImage, repo, prompt: request.prompt,
            width: dims.width, height: dims.height,
            steps: o.steps, guidance: o.guidance, seed: o.seed,
            image_strength: strength, lora_names: o.lora_names, lora_scales: o.lora_scales,
          })
        } else {
          submit = await submitImg2Img(baseUrl, {
            imagePath: sourceImage, repo, prompt: request.prompt,
            width: dims.width, height: dims.height,
            steps: o.steps, guidance: o.guidance, seed: o.seed,
            negative_prompt: o.negative_prompt,
            image_strength: strength, lora_names: o.lora_names, lora_scales: o.lora_scales,
          })
        }
      } else {
        const params: ImageStudioTxt2ImgParams = {
          repo, prompt: request.prompt, width: dims.width, height: dims.height,
          steps: o.steps, guidance: o.guidance, seed: o.seed,
          negative_prompt: o.negative_prompt, lora_names: o.lora_names, lora_scales: o.lora_scales,
        }
        submit = await submitTxt2Img(baseUrl, params)
      }

      await pollJob(baseUrl, submit.job_id, { isCancelled: request.isCancelled })
      // The image lives at /api/generate/jobs/{id}/image on the modal.
      // Return it as a URL string — generators/images.ts's downloadImage
      // helper fetches it directly. Single URL per generate today (the
      // wrapper doesn't batch); array shape kept for interface parity
      // with kie which can return multiple variants per call.
      return { urls: [jobImageUrl(baseUrl, submit.job_id)], taskId: submit.job_id }
    })
  },
}

registry.registerImage(imagestudioImageProvider)
