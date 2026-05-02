/**
 * Image-edit client — natural-language edits on an existing image.
 *
 * Two backends:
 *
 *   Gemini 2.5 Flash Image (nano-banana) via Google AI Studio
 *     POST https://generativelanguage.googleapis.com/v1beta/models/
 *          gemini-2.5-flash-image-preview:generateContent
 *     Accepts inline base64 image + text prompt, returns edited image
 *     inline. ~$0.039/image, ~5-10s.
 *
 *   OpenAI gpt-image-1 via Images API
 *     POST https://api.openai.com/v1/images/edits
 *     Multipart form with image file + prompt. Returns b64-encoded
 *     edited image. ~$0.04-$0.19/image, ~10-20s.
 *
 * Auto-downscales input to 2048 px long side before upload — beyond that
 * both models hit input limits and cost scales pointlessly.
 */
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'

/**
 * Image-edit models exposed by the picker. Kept as a string union for the
 * direct providers (Gemini, OpenAI) plus a string-typed escape hatch for
 * kie.ai-routed models — those forward straight to `editWithKie` which
 * looks up the per-model wire config from the project's image_models
 * (DEFAULT_IMAGE_MODELS at boot, user-edited in Settings) instead of
 * hard-coding it here. This lets us pick up new kie.ai reference-capable
 * models automatically when DEFAULT_IMAGE_MODELS gains them.
 */
export type ImageEditModel = string

export type ImageEditProvider = 'google' | 'openai' | 'kie' | 'fal'

export interface ImageEditModelMeta {
  id: ImageEditModel
  provider: ImageEditProvider
  label: string
  /** Approximate USD per edit. `null` means tiered/variable; the picker
   *  shows a default range string instead. */
  flatCostUsd: number | null
  /** True when the model accepts a binary mask alongside the image+prompt
   *  for region-targeted edits. Surfaced to the brush UI in Session 3 so
   *  the mask layer is hidden for prompt-only models. */
  supportsMask?: boolean
}

/**
 * Direct-provider models. Wire details live in this file.
 * kie.ai models are appended dynamically by `getKieEditModels()` —
 * keeping that out of the static array means Settings → Models edits
 * to the kie catalog flow through without a code change here.
 */
const DIRECT_PROVIDER_MODELS: ImageEditModelMeta[] = [
  { id: 'gemini-2.5-flash-image', provider: 'google', label: 'Gemini 2.5 Flash Image (Nano-banana, direct)', flatCostUsd: 0.039 },
  { id: 'gpt-image-1',            provider: 'openai', label: 'OpenAI gpt-image-1 (direct)',                   flatCostUsd: null, supportsMask: true },
]

/**
 * fal.ai purpose-built inpainting models. These accept image + mask + prompt
 * and ONLY edit the masked region — no drift on unmasked pixels. Trade-off:
 * mask-only (no prompt-only fallback). Unsuitable for "regenerate the whole
 * image without the watermark" but ideal for "erase exactly this region".
 */
const FAL_PROVIDER_MODELS: ImageEditModelMeta[] = [
  { id: 'fal-lama',               provider: 'fal',    label: 'fal.ai LaMa (mask-based inpaint, brush required)', flatCostUsd: 0.005, supportsMask: true },
]

/**
 * kie.ai reference-image-capable models discovered from the default model
 * catalog at module init. These are pre-flagged with
 * `supports_reference_images: true` and routed through the same kie-client
 * the image-prompts → images pipeline already uses.
 *
 * We pick a stable subset (the ones whose api_model name signals "edit"
 * intent or have been verified in the wider pipeline) so the picker isn't
 * dominated by text-to-image models that happen to accept a reference
 * but produce surprising re-generations rather than targeted edits.
 */
function getKieEditModels(): ImageEditModelMeta[] {
  // Approx USD per credit on kie.ai. Used to surface a flat-cost figure
  // in the picker. Real billing is in credits; this is a budgeting hint.
  const USD_PER_CREDIT = 0.01
  return [
    { id: 'flux-kontext-pro', provider: 'kie', label: 'Flux Kontext Pro (kie.ai)',     flatCostUsd: 2 * USD_PER_CREDIT },
    { id: 'flux-kontext-max', provider: 'kie', label: 'Flux Kontext Max (kie.ai)',     flatCostUsd: 4 * USD_PER_CREDIT },
    { id: 'qwen-image-2',     provider: 'kie', label: 'Qwen Image 2 — image-edit (kie.ai)', flatCostUsd: 5.6 * USD_PER_CREDIT },
    { id: 'flux-2-pro',       provider: 'kie', label: 'Flux 2 Pro (kie.ai)',           flatCostUsd: null /* tiered 5–7 cr */ },
    { id: 'gpt-image-2',      provider: 'kie', label: 'GPT Image 2 (kie.ai)',          flatCostUsd: null /* tiered 6–16 cr */ },
    { id: 'nano-banana',      provider: 'kie', label: 'Nano Banana (kie.ai)',         flatCostUsd: 12 * USD_PER_CREDIT },
    { id: 'nano-banana-2',    provider: 'kie', label: 'Nano Banana 2 (kie.ai)',        flatCostUsd: null /* tiered 8–18 cr */ },
    { id: 'nano-banana-pro',  provider: 'kie', label: 'Nano Banana Pro (kie.ai)',      flatCostUsd: null /* tiered 18–24 cr */ },
  ]
}

/**
 * Full picker catalog: direct providers first (cheapest paths,
 * known-good behaviour), then kie.ai-routed alternatives, then fal.ai's
 * purpose-built inpainters which require a mask brush.
 */
export const IMAGE_EDIT_MODELS: ImageEditModelMeta[] = [
  ...DIRECT_PROVIDER_MODELS,
  ...getKieEditModels(),
  ...FAL_PROVIDER_MODELS,
]

export function imageEditModelInfo(id: string): ImageEditModelMeta | null {
  return IMAGE_EDIT_MODELS.find(m => m.id === id) || null
}

export interface EditImageInput {
  imagePath: string
  prompt: string
  model: ImageEditModel
  apiKey: string
  /**
   * Optional binary mask matching the source image's dimensions. White
   * pixels = "edit this region", transparent = "leave alone". When
   * provided, the dispatcher routes to the masked-edit code path on
   * providers that support it (fal.ai LaMa, OpenAI gpt-image-1, future
   * kie.ai mask-capable endpoints).
   *
   * Format is whatever the brush-canvas component exports — a base64
   * PNG, optionally as a `data:image/png;base64,...` URL. We strip the
   * prefix in `decodeMaskInput` before handing to providers.
   */
  maskB64?: string
}

export interface EditImageResult {
  /** PNG bytes of the edited image, ready to write to disk. */
  imageBytes: Buffer
  model_used: ImageEditModel
}

async function downscaleIfNeeded(imagePath: string, maxSide = 2048): Promise<{ buffer: Buffer; mime: string }> {
  const img = sharp(imagePath, { failOn: 'none' })
  const meta = await img.metadata()
  const w = meta.width || 0
  const h = meta.height || 0
  const needsResize = Math.max(w, h) > maxSide
  const processed = needsResize
    ? img.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    : img
  // PNG preserves alpha + text-edge sharpness better than JPEG for this use
  // case; Gemini's image editor specifically benefits from PNG input.
  const buffer = await processed.png({ compressionLevel: 6 }).toBuffer()
  return { buffer, mime: 'image/png' }
}

// ── Gemini 2.5 Flash Image (nano-banana) ─────────────────────────────────

async function editWithGemini(input: EditImageInput, image: { buffer: Buffer; mime: string }): Promise<Buffer> {
  // Google's API uses the `-preview` suffix for the image model as of late
  // 2025. If/when they promote to GA, try the bare id first and fall
  // through. For now the preview id is the stable one users can access.
  const model = 'gemini-2.5-flash-image-preview'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(input.apiKey)}`

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: image.mime, data: image.buffer.toString('base64') } },
        { text: input.prompt },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Gemini image edit failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`)
  }
  const data = await res.json() as any
  // Response shape: candidates[0].content.parts[] — find the first part
  // with inlineData (image) and extract.
  const parts = data?.candidates?.[0]?.content?.parts || []
  for (const p of parts) {
    const inline = p?.inlineData || p?.inline_data
    if (inline?.data) {
      return Buffer.from(inline.data, 'base64')
    }
  }
  // Gemini sometimes returns a text refusal or safety block with no image;
  // surface that to the caller instead of an opaque "no image returned".
  const textPart = parts.find((p: any) => typeof p?.text === 'string')
  if (textPart?.text) throw new Error(`Gemini returned text instead of image: ${textPart.text.slice(0, 300)}`)
  throw new Error('Gemini returned no image — check the reference safety policy allows your edit request.')
}

// ── OpenAI gpt-image-1 ───────────────────────────────────────────────────

async function editWithOpenAI(input: EditImageInput, image: { buffer: Buffer; mime: string }): Promise<Buffer> {
  const { default: OpenAI } = await import('openai')
  const { toFile } = await import('openai/uploads')
  const client = new OpenAI({ apiKey: input.apiKey })
  const file = await toFile(image.buffer, 'reference.png', { type: image.mime })
  // OpenAI's images.edit accepts an optional `mask` field — same
  // dimensions as the source. Transparent pixels = "edit here";
  // opaque = "leave alone". Our brush exports the OPPOSITE (white =
  // edit), so we invert before sending.
  const editArgs: any = {
    model: 'gpt-image-1',
    image: file,
    prompt: input.prompt,
    n: 1,
    size: 'auto',
  }
  if (input.maskB64) {
    const maskBytes = await invertMaskForOpenAI(decodeMaskInput(input.maskB64), image.buffer)
    editArgs.mask = await toFile(maskBytes, 'mask.png', { type: 'image/png' })
  }
  const resp = await client.images.edit(editArgs)
  const b64 = (resp as any).data?.[0]?.b64_json
  if (!b64) throw new Error('OpenAI returned no image bytes — the response was empty or rejected.')
  return Buffer.from(b64, 'base64')
}

// ── Mask helpers (shared) ─────────────────────────────────────────────────

/** Strip a `data:image/png;base64,` prefix if present and decode to bytes. */
function decodeMaskInput(maskB64: string): Buffer {
  const m = maskB64.match(/^data:image\/[a-z]+;base64,(.+)$/)
  const raw = m ? m[1] : maskB64
  return Buffer.from(raw, 'base64')
}

/**
 * OpenAI's mask convention is *opposite* to ours: their transparent pixels
 * are the edit region, ours are. Invert the alpha + drop the colour
 * channels so the result is a valid OpenAI mask matching the source's
 * dimensions.
 *
 * Also pads / crops to the source image's exact dimensions in case the
 * brush canvas was rendered against a downscaled preview.
 */
async function invertMaskForOpenAI(maskBytes: Buffer, sourceBytes: Buffer): Promise<Buffer> {
  const srcMeta = await sharp(sourceBytes).metadata()
  const W = srcMeta.width || 1024
  const H = srcMeta.height || 1024
  // Resize the user's mask to match the (downscaled) source the OpenAI API
  // will operate on — the editWithOpenAI path applies the same downscale
  // upstream, so the mask must align with that buffer not the original
  // file on disk.
  const resized = await sharp(maskBytes)
    .resize(W, H, { fit: 'fill' })
    .png()
    .toBuffer()
  const { data, info } = await sharp(resized)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  // For each pixel, if alpha > 0 (user painted = "edit here"), set the
  // mask pixel to transparent. Otherwise opaque white. RGB doesn't matter
  // to OpenAI but we set it to white for sanity in case the user previews
  // the mask file.
  const out = Buffer.alloc(info.width * info.height * 4)
  for (let i = 0; i < data.length; i += 4) {
    const userAlpha = data[i + 3]
    const editHere = userAlpha > 32  // small threshold for anti-aliased edges
    out[i]     = 255
    out[i + 1] = 255
    out[i + 2] = 255
    out[i + 3] = editHere ? 0 : 255
  }
  return await sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer()
}

// ── fal.ai LaMa (purpose-built inpainting, requires mask) ─────────────────

async function editWithFalLama(input: EditImageInput): Promise<Buffer> {
  if (!input.maskB64) {
    throw new Error('fal.ai LaMa requires a mask — paint over the area to erase using the brush above.')
  }
  // Read the source image and the mask; both go to fal as data URLs. fal's
  // LaMa endpoint signature: { image_url, mask_url } → { image: { url } }.
  const srcBytes = await fs.readFile(input.imagePath)
  const srcMeta  = await sharp(srcBytes).metadata()
  const srcMime  = `image/${srcMeta.format || 'png'}`
  const srcDataUrl = `data:${srcMime};base64,${srcBytes.toString('base64')}`

  // Resize the mask to source dimensions so LaMa lines up cleanly.
  const W = srcMeta.width || 1024
  const H = srcMeta.height || 1024
  const maskRaw = decodeMaskInput(input.maskB64)
  const maskAligned = await sharp(maskRaw)
    .resize(W, H, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer()
  // LaMa expects WHITE = inpaint region, BLACK = preserve. Our brush
  // gives white-on-transparent; flatten with a black background to get
  // exactly that.
  const maskFlattened = await sharp(maskAligned)
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .png()
    .toBuffer()
  const maskDataUrl = `data:image/png;base64,${maskFlattened.toString('base64')}`

  const submitResp = await fetch('https://queue.fal.run/fal-ai/lama', {
    method: 'POST',
    headers: {
      Authorization: `Key ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_url: srcDataUrl,
      mask_url: maskDataUrl,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!submitResp.ok) {
    const text = await submitResp.text().catch(() => '')
    throw new Error(`fal.ai LaMa submit failed (${submitResp.status}): ${text.slice(0, 300)}`)
  }
  const submitJson: any = await submitResp.json()

  // Direct result vs queued. The fal LaMa endpoint usually returns the
  // result inline; if it queues, poll the response_url.
  let resultUrl: string | undefined =
    submitJson?.image?.url ||
    submitJson?.images?.[0]?.url ||
    submitJson?.output?.url

  if (!resultUrl) {
    const responseUrl = submitJson?.response_url || submitJson?.status_url
    if (!responseUrl) {
      throw new Error('fal.ai LaMa returned no image URL and no queue URL — unexpected response shape.')
    }
    // Lightweight poll loop. LaMa is fast (~5s typical); cap at 90s.
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500))
      const pollResp = await fetch(responseUrl, {
        headers: { Authorization: `Key ${input.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!pollResp.ok) continue
      const pollJson: any = await pollResp.json()
      const url =
        pollJson?.image?.url ||
        pollJson?.images?.[0]?.url ||
        pollJson?.output?.url
      if (url) { resultUrl = url; break }
    }
    if (!resultUrl) {
      throw new Error('fal.ai LaMa polling timed out after 90s without producing an image URL.')
    }
  }

  const resultResp = await fetch(resultUrl, { signal: AbortSignal.timeout(120_000) })
  if (!resultResp.ok) {
    throw new Error(`fal.ai LaMa result download failed (${resultResp.status}): ${resultUrl}`)
  }
  const arrayBuffer = await resultResp.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ── kie.ai (reference-image-capable models) ───────────────────────────────
//
// Routes through the existing kie.ai pipeline (`submitGeneration` →
// `pollForImageUrls` → fetch the result URL into bytes). Re-uses everything
// the regular image-prompts → images flow already paid the engineering cost
// for: payload-shape switching by model `type`, base64-encoded reference
// upload, polling with exponential backoff + cancel probe, redacted error
// surfaces. The only new wiring is "treat the source image as a reference
// + the user's natural-language prompt as the edit instruction" — which is
// exactly the contract the wider pipeline uses for reference-image-aware
// generation.

async function editWithKie(
  input: EditImageInput,
  modelId: string,
): Promise<Buffer> {
  // Lazy-load the kie-client + defaults so the smaller direct-provider path
  // doesn't pay this import cost. DEFAULT_IMAGE_MODELS carries the per-model
  // wire details (endpoint, poll path, payload type) — that's the same dict
  // the image-prompts → images pipeline reads.
  const { submitGeneration, pollForImageUrls } = await import('./kie-client.js')
  const { DEFAULT_IMAGE_MODELS } = await import('../models/defaults.js')

  const modelConfig = (DEFAULT_IMAGE_MODELS as any)[modelId]
  if (!modelConfig) {
    throw new Error(
      `kie.ai image-edit model "${modelId}" is not in DEFAULT_IMAGE_MODELS. ` +
      `If this is a new model, add it to electron/server/models/defaults.ts ` +
      `with supports_reference_images: true.`,
    )
  }
  if (!modelConfig.supports_reference_images) {
    throw new Error(
      `kie.ai model "${modelId}" doesn't support reference images — pick a ` +
      `model that does (Flux Kontext, Qwen Image 2, Nano Banana, etc.).`,
    )
  }

  // Aspect ratio detection — preserve the source image's ratio so kie.ai
  // doesn't re-frame the edit. We only need a rough bucket since most
  // kie endpoints accept '1:1' / '16:9' / '9:16' / '4:3' / '3:4'.
  const meta = await sharp(input.imagePath).metadata()
  const w = meta.width || 1
  const h = meta.height || 1
  const ratio = w / h
  const aspectRatio =
    ratio > 1.7 ? '16:9'
    : ratio > 1.2 ? '4:3'
    : ratio > 0.85 ? '1:1'
    : ratio > 0.6 ? '3:4'
    : '9:16'

  // Submit the edit task. The source image rides as a reference; the kie
  // payload shape (`inputImages` / `image_urls` / `input_images`) is chosen
  // by submitGeneration based on modelConfig.type.
  const taskId = await submitGeneration(
    input.prompt, input.apiKey, aspectRatio, modelConfig,
    { referenceImagePaths: [input.imagePath] },
  )
  const urls = await pollForImageUrls(taskId, input.apiKey, modelConfig)
  if (!urls.length) {
    throw new Error(`kie.ai image edit returned no URLs (model=${modelId}, taskId=${taskId})`)
  }

  // Fetch the first URL into bytes. kie.ai-hosted result URLs typically
  // expire within 24h; we copy to disk immediately via the route handler
  // so the user's edit isn't dependent on that lifetime.
  const url = urls[0]
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!resp.ok) {
    throw new Error(`kie.ai result download failed (${resp.status}): ${url}`)
  }
  const arrayBuffer = await resp.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ── Dispatcher ────────────────────────────────────────────────────────────

export async function editImage(input: EditImageInput): Promise<EditImageResult> {
  if (!input.apiKey) throw new Error('API key required for image editing')
  if (!input.prompt?.trim()) throw new Error('Edit prompt is required')
  if (!input.imagePath || !existsSync(input.imagePath)) {
    throw new Error(`Reference image not found: ${input.imagePath}`)
  }

  const meta = imageEditModelInfo(input.model)
  if (!meta) {
    throw new Error(`Unsupported image-edit model: ${input.model}`)
  }

  // Direct providers process the downscaled buffer in-memory; kie.ai works
  // off the source path (it does its own encoding via the reference-image
  // helper). Avoid the downscale work for the kie path so we don't double-
  // recompress when the caller will hand the file off as a data URL anyway.
  // Reject unsupported mask combinations early so the user sees a clean
  // message instead of a provider-side rejection.
  if (input.maskB64 && !meta.supportsMask) {
    throw new Error(
      `${meta.label} doesn't support mask-based editing. Pick a model with a brush badge ` +
      `(e.g. fal.ai LaMa, OpenAI gpt-image-1) or clear the mask to fall back to prompt-only.`,
    )
  }

  let imageBytes: Buffer
  if (meta.provider === 'google') {
    const image = await downscaleIfNeeded(input.imagePath)
    imageBytes = await editWithGemini(input, image)
  } else if (meta.provider === 'openai') {
    const image = await downscaleIfNeeded(input.imagePath)
    imageBytes = await editWithOpenAI(input, image)
  } else if (meta.provider === 'kie') {
    imageBytes = await editWithKie(input, meta.id)
  } else if (meta.provider === 'fal') {
    imageBytes = await editWithFalLama(input)
  } else {
    throw new Error(`Unsupported image-edit provider: ${meta.provider}`)
  }

  return { imageBytes, model_used: input.model }
}

// ── File versioning helpers ───────────────────────────────────────────────

/**
 * Pick the next `{base}_edited_v{N}.png` name in `dir` that doesn't collide
 * with an existing file. Matches the `_v2.docx` pattern used elsewhere in
 * the app so users see consistent versioning across asset types.
 */
export async function nextEditedVersionPath(originalPath: string, outputDir?: string): Promise<string> {
  const parsed = path.parse(originalPath)
  const targetDir = outputDir || parsed.dir
  const base = parsed.name.replace(/_edited_v\d+$/, '')
  let n = 1
  for (;;) {
    const candidate = path.join(targetDir, `${base}_edited_v${n}.png`)
    if (!existsSync(candidate)) return candidate
    n++
    if (n > 999) throw new Error('Too many edited versions — clean up old _edited_vN.png files.')
  }
}

/**
 * Move the original file to a timestamped `_pre-edit_{ts}.{ext}` backup so
 * the "Replace original" flow is reversible. The backup is in the same
 * directory as the original for discoverability.
 */
export async function stashOriginal(originalPath: string): Promise<string> {
  const parsed = path.parse(originalPath)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
  const backup = path.join(parsed.dir, `${parsed.name}_pre-edit_${ts}${parsed.ext}`)
  await fs.rename(originalPath, backup)
  return backup
}
