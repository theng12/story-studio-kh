/**
 * Style Preview surface for /projects/:slug/images.
 *
 *   POST /api/projects/:slug/style-preview
 *     body: { style_tag, model, aspect_ratio, tier? }
 *     200 : { hash, url, cached, model_id, aspect_ratio, tier, created_at, size_bytes }
 *     User explicitly picks model + aspect + tier on the Image Generator
 *     page, so we trust what's sent (no first-key-from-config guessing
 *     that caused the kie.ai 422 in the earlier attempt on /image-prompts).
 *
 *   GET /api/style-preview-cache/:hash
 *     200: image/png stream (immutable cache headers).
 *     404: hash not in cache.
 *     Hash IS the content key — never collides with new bytes for the
 *     same hash, so we serve with year-long Cache-Control. Hex-only
 *     regex blocks path traversal.
 */

import path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../lib/validate.js'
import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import * as pm from '../services/project-manager.js'
import {
  getCachedStylePreview,
  saveStylePreview,
  pathForStylePreviewHash,
} from '../services/style-preview-cache.js'
import type { ImageModelConfig } from '../models/types.js'

export const router = Router()

// Neutral baseline scene — same every render so the cache key is the
// (style + model + aspect + tier) tuple and not the prompt. Picked to
// exercise composition + lighting + a recognisable element scale so
// styles read cleanly in the thumbnail.
const BASELINE_SCENE = 'A solitary path winding through autumn trees at golden hour, ' +
  'with a small wooden bench beside it and warm natural light filtering through the leaves.'

const StylePreviewSchema = z.object({
  style_tag: z.string().min(1).max(2000),
  model: z.string().min(1),
  aspect_ratio: z.string().min(1),
  /** Tier id for variable-priced models (nano-banana high/low etc.). */
  tier: z.string().optional(),
})

router.post('/projects/:slug/style-preview', validateBody(StylePreviewSchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const styleTag = (req.body.style_tag as string).trim()
  if (!styleTag) return res.status(400).json({ detail: 'style_tag is empty' })
  const modelName = req.body.model as string
  const aspectRatio = req.body.aspect_ratio as string
  const tier = (req.body.tier as string | undefined) || ''

  // Cache lookup short-circuits the provider entirely on hit.
  const cached = await getCachedStylePreview({ styleTag, modelId: modelName, aspectRatio, tier })
  if (cached) {
    return res.json({
      hash: cached.hash,
      url: `/api/style-preview-cache/${cached.hash}`,
      cached: true,
      model_id: cached.model_id,
      aspect_ratio: cached.aspect_ratio,
      tier: cached.tier,
      created_at: cached.created_at,
      size_bytes: cached.size_bytes,
    })
  }

  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project config not found' })

  const modelConfig: ImageModelConfig | undefined = (config.image_models || {})[modelName]
  if (!modelConfig) {
    return res.status(400).json({ detail: `Unknown image model: ${modelName}` })
  }

  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) {
    return res.status(400).json({ detail: `No image provider registered for: ${providerId}` })
  }

  // Provider params + tier override. Mirrors generators/images.ts.
  const providerParams: Record<string, any> = {
    ...((modelConfig as any).provider_params || {
      endpoint: modelConfig.endpoint,
      poll: modelConfig.poll,
      type: modelConfig.type,
      api_model: modelConfig.api_model,
    }),
  }
  if (tier && Array.isArray((modelConfig as any).tiers)) {
    const tierEntry = (modelConfig as any).tiers.find((t: any) => t.id === tier)
    if (tierEntry?.api_model) providerParams.api_model = tierEntry.api_model
  }

  const apiKey = await resolveApiKeyForProvider(slug, imageProvider.meta, { model: modelName })
  if (!apiKey) {
    return res.status(400).json({
      detail: `No API key configured for ${imageProvider.meta.name}. Add one in Settings → API Keys.`,
    })
  }

  // Style as the leading clause matches how scene prompts thread it in
  // production — keeps the preview faithful to the eventual renders.
  const prompt = `${styleTag}. ${BASELINE_SCENE}`

  let urls: string[] = []
  try {
    const result = await imageProvider.generateImage({
      prompt, apiKey, aspectRatio, modelId: modelName, providerParams,
    })
    urls = result.urls || []
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'Image provider failed' })
  }
  if (!urls.length) return res.status(502).json({ detail: 'Image provider returned no images' })

  let imageBytes: Buffer
  try {
    const dl = await fetch(urls[0]!, { signal: AbortSignal.timeout(120000) })
    if (!dl.ok) throw new Error(`Download failed: ${dl.status}`)
    imageBytes = Buffer.from(await dl.arrayBuffer())
    if (imageBytes.length === 0) throw new Error('Downloaded zero bytes')
  } catch (e: any) {
    return res.status(502).json({ detail: `Failed to download generated preview: ${e?.message || e}` })
  }

  const saved = await saveStylePreview({
    styleTag, modelId: modelName, aspectRatio, tier, imageBytes,
  })
  res.json({
    hash: saved.hash,
    url: `/api/style-preview-cache/${saved.hash}`,
    cached: false,
    model_id: saved.model_id,
    aspect_ratio: saved.aspect_ratio,
    tier: saved.tier,
    created_at: saved.created_at,
    size_bytes: saved.size_bytes,
  })
})

router.get('/style-preview-cache/:hash', async (req, res) => {
  const hash = String(req.params.hash || '')
  if (!/^[0-9a-f]{16}$/.test(hash)) return res.status(400).json({ detail: 'Invalid preview hash' })
  const abs = await pathForStylePreviewHash(hash)
  if (!abs) return res.status(404).json({ detail: 'Preview not cached' })
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('Content-Type', 'image/png')
  res.sendFile(path.resolve(abs))
})
