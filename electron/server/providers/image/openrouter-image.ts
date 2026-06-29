/**
 * OpenRouter image provider — v1.0.236.
 *
 * OpenRouter exposes image-generation models through its OpenAI-compatible
 * CHAT COMPLETIONS endpoint (not a dedicated images route). You ask for image
 * output via `modalities: ["image","text"]`; the generated image comes back
 * base64-encoded in `choices[0].message.images[]`. Image-to-image works by
 * including the input image(s) as `image_url` content blocks in the user
 * message.
 *
 * Billed on the user's OWN OpenRouter credit (the same key used for the
 * OpenRouter LLM models). Token-based, so credits_per_image is 0 in the
 * catalog — watch spend on openrouter.ai.
 *
 * Models wired (see models/defaults.ts):
 *   - openai/gpt-5.4-image-2   (GPT Image 2, via OpenRouter's GPT-5.4 multimodal)
 *
 * NOTE: this chat-image path has no hard size param — aspect ratio is hinted in
 * the prompt. For strict ratio control use the direct OpenAI Images provider
 * (gpt-image-2-openai), which sends a real size.
 */

import fs from 'fs/promises'
import { registry } from '../registry.js'
import type { ImageProvider, ImageGenerationRequest, ImageGenerationResult } from '../types.js'

const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions'

function mimeFor(p: string): string {
  const e = p.toLowerCase()
  if (e.endsWith('.jpg') || e.endsWith('.jpeg')) return 'image/jpeg'
  if (e.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

/** Pull a base64/URL image out of an OpenRouter chat response, tolerating the
 *  couple of shapes seen in the wild (message.images[] is the documented one). */
function extractImageUrl(data: any): string | undefined {
  const msg = data?.choices?.[0]?.message
  if (!msg) return undefined
  // 1) Documented: message.images = [{ type:'image_url', image_url:{ url } }]
  if (Array.isArray(msg.images)) {
    for (const im of msg.images) {
      const u = im?.image_url?.url || im?.url
      if (typeof u === 'string' && u) return u
    }
  }
  // 2) Some responses inline the image as a content block.
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      const u = block?.image_url?.url || (typeof block?.image_url === 'string' ? block.image_url : undefined)
      if (typeof u === 'string' && u) return u
    }
  }
  return undefined
}

const openrouterImageProvider: ImageProvider = {
  meta: {
    id: 'openrouter-image',
    name: 'OpenRouter (image)',
    apiKeyField: 'openrouter_api_key', // → providerId 'openrouter'
  },

  supportsModel(modelId: string, providerParams: Record<string, any>): boolean {
    return providerParams?.provider === 'openrouter-image' || modelId.startsWith('openrouter-image')
  },

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { prompt, apiKey, aspectRatio, providerParams, referenceImagePaths, isCancelled } = request
    if (!apiKey) throw new Error('No OpenRouter API key configured. Add one in Settings → API Keys.')
    const model = (providerParams?.api_model as string) || 'openai/gpt-5.4-image-2'
    if (isCancelled?.()) throw new Error('Cancelled by user')

    // The user message: prompt text + (for img2img) the reference images.
    // OpenRouter has no universal "size" param for Gemini image, so we hint
    // the aspect ratio in the prompt — Gemini honours it reasonably.
    const content: any[] = [
      { type: 'text', text: `${prompt}\n\n(Compose in a ${aspectRatio} aspect ratio.)` },
    ]
    for (const p of (referenceImagePaths || []).filter(Boolean)) {
      const buf = await fs.readFile(p)
      content.push({ type: 'image_url', image_url: { url: `data:${mimeFor(p)};base64,${buf.toString('base64')}` } })
    }

    let resp: Response
    try {
      resp = await fetch(OPENROUTER_CHAT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://story-studio-kh.local',
          'X-Title': 'Story Studio KH',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          modalities: ['image', 'text'],
        }),
        signal: AbortSignal.timeout(180_000),
      })
    } catch (e: any) {
      throw new Error(`OpenRouter image request failed: ${e?.message || e}`)
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`OpenRouter image API failed (${resp.status}): ${text.slice(0, 400)}`)
    }

    const data = await resp.json() as any
    const url = extractImageUrl(data)
    if (!url) {
      // Surface the model's text reply (often explains a refusal) + a snippet.
      const textReply = data?.choices?.[0]?.message?.content
      const reason = typeof textReply === 'string' && textReply.trim() ? ` Model said: "${textReply.slice(0, 200)}"` : ''
      throw new Error(`OpenRouter returned no image for ${model}.${reason} (raw: ${JSON.stringify(data).slice(0, 300)})`)
    }
    // `url` is a data: URL (base64) or an https URL — downloadImage handles both.
    return { urls: [url] }
  },
}

registry.registerImage(openrouterImageProvider)
