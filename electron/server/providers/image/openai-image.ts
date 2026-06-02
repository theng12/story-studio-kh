/**
 * OpenAI Images API provider (official / direct) — v1.0.234.
 *
 * Generates images with the user's OWN OpenAI API key (the same key used for
 * chat). Billed on the OpenAI API platform account — entirely separate from
 * kie.ai credits. Lets a user spend their OpenAI balance on image generation.
 *
 * Two endpoints, picked automatically by request shape:
 *   - text-to-image:  POST https://api.openai.com/v1/images/generations  (JSON)
 *   - image-to-image: POST https://api.openai.com/v1/images/edits         (multipart;
 *                     the reference images are sent as the `image[]` files)
 * Both return base64 (`b64_json`), which we hand back as a `data:` URL so the
 * normal downloadImage pipeline (kie-client.downloadImage) persists it.
 *
 * Note: gpt-image models may require "API Organization Verification" on the
 * OpenAI developer console before they're accessible — we surface a hint if
 * the API reports that.
 */

import fs from 'fs/promises'
import { registry } from '../registry.js'
import type { ImageProvider, ImageGenerationRequest, ImageGenerationResult } from '../types.js'

const OPENAI_IMAGES_BASE = 'https://api.openai.com/v1/images'

/** aspectRatio → an OpenAI-supported size. gpt-image supports square +
 *  landscape (1536x1024) + portrait (1024x1536). Anything else → square. */
function resolveSize(aspectRatio: string): string {
  switch (aspectRatio) {
    case '16:9': case '3:2': case '4:3': case '21:9': return '1536x1024'
    case '9:16': case '2:3': case '3:4': return '1024x1536'
    default: return '1024x1024'
  }
}

function mimeFor(p: string): string {
  const e = p.toLowerCase()
  if (e.endsWith('.jpg') || e.endsWith('.jpeg')) return 'image/jpeg'
  if (e.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

const openaiImageProvider: ImageProvider = {
  meta: {
    id: 'openai-image',
    name: 'OpenAI (direct)',
    // Resolves the user's OpenAI key (apiKeyField → providerId 'openai').
    apiKeyField: 'openai_api_key',
  },

  supportsModel(modelId: string, providerParams: Record<string, any>): boolean {
    return providerParams?.provider === 'openai-image' || modelId.startsWith('openai-image')
  },

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { prompt, apiKey, aspectRatio, providerParams, referenceImagePaths, isCancelled } = request
    if (!apiKey) {
      throw new Error('No OpenAI API key configured. Add one in Settings → API Keys.')
    }
    const model = (providerParams?.api_model as string) || 'gpt-image-2'
    const size = resolveSize(aspectRatio)
    const quality = (providerParams?.quality as string) || 'high'
    if (isCancelled?.()) throw new Error('Cancelled by user')

    const refs = (referenceImagePaths || []).filter(Boolean)
    let resp: Response
    if (refs.length) {
      // ── image-to-image: /v1/images/edits (multipart) ──────────────────
      const form = new FormData()
      form.append('model', model)
      form.append('prompt', prompt)
      form.append('size', size)
      if (quality) form.append('quality', quality)
      for (const p of refs) {
        const buf = await fs.readFile(p)
        // gpt-image accepts multiple input images via repeated `image[]`.
        form.append('image[]', new Blob([buf as any], { type: mimeFor(p) }), p.split('/').pop() || 'ref.png')
      }
      resp = await fetch(`${OPENAI_IMAGES_BASE}/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(180_000),
      })
    } else {
      // ── text-to-image: /v1/images/generations (JSON) ──────────────────
      resp = await fetch(`${OPENAI_IMAGES_BASE}/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
        signal: AbortSignal.timeout(180_000),
      })
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const hint = /verif|must be verified|organization/i.test(text)
        ? ' — gpt-image models require "API Organization Verification": open platform.openai.com → Settings → Organization → Verify, then retry.'
        : ''
      throw new Error(`OpenAI image API failed (${resp.status}): ${text.slice(0, 300)}${hint}`)
    }

    const data = await resp.json() as { data?: Array<{ b64_json?: string; url?: string }> }
    const first = data.data?.[0]
    if (first?.b64_json) {
      // Hand back as a data: URL — downloadImage decodes + writes it.
      return { urls: [`data:image/png;base64,${first.b64_json}`] }
    }
    if (first?.url) return { urls: [first.url] }
    throw new Error('OpenAI image API returned no image data')
  },
}

registry.registerImage(openaiImageProvider)
