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

export type ImageEditModel = 'gemini-2.5-flash-image' | 'gpt-image-1'

export const IMAGE_EDIT_MODELS: Array<{ id: ImageEditModel; provider: 'google' | 'openai'; label: string; flatCostUsd: number | null }> = [
  { id: 'gemini-2.5-flash-image', provider: 'google', label: 'Gemini 2.5 Flash Image (Nano-banana)', flatCostUsd: 0.039 },
  { id: 'gpt-image-1',            provider: 'openai', label: 'OpenAI gpt-image-1',                   flatCostUsd: null },
]

export function imageEditModelInfo(id: string) {
  return IMAGE_EDIT_MODELS.find(m => m.id === id) || null
}

export interface EditImageInput {
  imagePath: string
  prompt: string
  model: ImageEditModel
  apiKey: string
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
  const resp = await client.images.edit({
    model: 'gpt-image-1',
    image: file as any,
    prompt: input.prompt,
    n: 1,
    size: 'auto',
  } as any)
  const b64 = (resp as any).data?.[0]?.b64_json
  if (!b64) throw new Error('OpenAI returned no image bytes — the response was empty or rejected.')
  return Buffer.from(b64, 'base64')
}

// ── Dispatcher ────────────────────────────────────────────────────────────

export async function editImage(input: EditImageInput): Promise<EditImageResult> {
  if (!input.apiKey) throw new Error('API key required for image editing')
  if (!input.prompt?.trim()) throw new Error('Edit prompt is required')
  if (!input.imagePath || !existsSync(input.imagePath)) {
    throw new Error(`Reference image not found: ${input.imagePath}`)
  }

  const image = await downscaleIfNeeded(input.imagePath)

  let imageBytes: Buffer
  if (input.model === 'gemini-2.5-flash-image') {
    imageBytes = await editWithGemini(input, image)
  } else if (input.model === 'gpt-image-1') {
    imageBytes = await editWithOpenAI(input, image)
  } else {
    throw new Error(`Unsupported image-edit model: ${input.model}`)
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
