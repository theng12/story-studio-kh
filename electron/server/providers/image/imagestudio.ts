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
  DEFAULT_IMAGESTUDIO_BASE_URL,
  type ImageStudioTxt2ImgParams,
} from '../../lib/imagestudio-client.js'
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
    const baseUrl = (request.apiKey || '').trim() || DEFAULT_IMAGESTUDIO_BASE_URL
    if (!baseUrl) {
      throw new Error(
        'Image Studio modal URL not configured. ' +
        'Open App Settings → Local Models and set the URL (Tailscale IP + port).',
      )
    }
    if (request.isCancelled?.()) throw new Error('Cancelled by user')

    const repo = repoForModelId(request.modelId)
    if (!repo) throw new Error(`Image Studio provider received unknown model id '${request.modelId}'.`)
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
  },
}

registry.registerImage(imagestudioImageProvider)
