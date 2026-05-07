/**
 * Style preview — single sample image of a `style_tag` description so the
 * user can SEE what their style description will look like before
 * committing to a full scene-prompt batch. Cached app-wide by sha256 of
 * the (normalised) style description so re-using the same description
 * across episodes / projects costs nothing after the first generation.
 *
 *   POST /api/projects/:slug/style-preview
 *     body: { style_tag: string, model?: string, aspect_ratio?: string }
 *     200: { hash, url, cached, style_tag, model_id, created_at, size_bytes }
 *
 *   GET  /api/style-preview-cache/:hash
 *     200: image/png stream (1y cache headers — content keyed by hash so
 *          a cache-buster query isn't needed; renaming the cached file
 *          would change the hash)
 *     404: no such hash on disk
 */

import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../lib/validate.js'
import { registry } from '../providers/registry.js'
import { resolveApiKeyForProvider } from '../providers/registry.js'
import * as pm from '../services/project-manager.js'
import { getCached, savePreview, pathForHash } from '../services/style-preview-cache.js'
import type { ImageModelConfig } from '../models/types.js'

export const router = Router()

// Neutral baseline prompt — same every time. Lets the cache key be the
// style description alone (no per-prompt variation needed). Picked to
// exercise multiple visual cues that style descriptions tend to vary on:
// scene composition (path + trees), lighting (golden hour), and a
// recognisable object scale (single distant figure) so styles read
// cleanly in the thumbnail.
const BASELINE_SCENE = 'A solitary path winding through autumn trees at golden hour, ' +
  'with a small wooden bench beside it and warm natural light filtering through the leaves.'

const StylePreviewSchema = z.object({
  style_tag: z.string().min(1).max(2000),
  /** Image model id from project config.image_models. When omitted, uses
   *  the project's default scene image model — usually the cheapest one
   *  the user has configured (kie.ai nano-banana / google credits). */
  model: z.string().optional(),
  /** Aspect ratio override — defaults to 1:1 (square thumbnail) for the
   *  preview since we just want a style sample, not a final-quality
   *  scene render. Square keeps every style preview the same shape so
   *  the gallery looks consistent. */
  aspect_ratio: z.string().optional(),
})

router.post('/projects/:slug/style-preview', validateBody(StylePreviewSchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const styleTag = (req.body.style_tag as string).trim()
  if (!styleTag) return res.status(400).json({ detail: 'style_tag is empty' })

  // Cache lookup first. The whole point of this feature is "free for
  // re-use" — a hit short-circuits the image-provider path entirely.
  const cached = await getCached(styleTag)
  if (cached) {
    return res.json({
      hash: cached.hash,
      url: `/api/style-preview-cache/${cached.hash}`,
      cached: true,
      style_tag: cached.style_tag,
      model_id: cached.model_id,
      created_at: cached.created_at,
      size_bytes: cached.size_bytes,
    })
  }

  // Cache miss — generate fresh. Resolve provider + model + key the
  // same way generators/images.ts does so the user doesn't have to
  // configure anything specific to previews; the same kie.ai (or
  // alternative) account that powers scene generation handles this too.
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project config not found' })

  const requestedModel = (req.body.model as string | undefined) || ''
  const modelName = requestedModel || pickDefaultImageModel(config.image_models || {})
  if (!modelName) {
    return res.status(400).json({
      detail: 'No image model configured. Open Settings → Models and add at least one image model first.',
    })
  }
  const modelConfig: ImageModelConfig | undefined = (config.image_models || {})[modelName]
  if (!modelConfig) {
    return res.status(400).json({ detail: `Unknown image model: ${modelName}` })
  }

  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) {
    return res.status(400).json({ detail: `No image provider registered for: ${providerId}` })
  }

  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
  }
  const apiKey = await resolveApiKeyForProvider(slug, imageProvider.meta, { model: modelName })
  if (!apiKey) {
    return res.status(400).json({
      detail: `No API key configured for ${imageProvider.meta.name}. Add one in Settings → API Keys.`,
    })
  }

  // Style as a leading clause so the model treats it as the dominant
  // descriptor, matching how scene prompts thread the style_tag in
  // production. Keeps the preview faithful to what the user will see
  // when the same style is used across actual scenes.
  const prompt = `${styleTag}. ${BASELINE_SCENE}`
  const aspectRatio = (req.body.aspect_ratio as string | undefined) || '1:1'

  let urls: string[]
  try {
    const result = await imageProvider.generateImage({
      prompt,
      apiKey,
      aspectRatio,
      modelId: modelName,
      providerParams,
    })
    urls = result.urls || []
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'Image provider failed' })
  }
  if (!urls.length) {
    return res.status(502).json({ detail: 'Image provider returned no images' })
  }

  // Download the first variant into a Buffer so we can persist + index
  // atomically via savePreview. fetch with a generous timeout —
  // kie.ai R2 is usually fast but occasionally has 5-10s round-trips.
  let imageBytes: Buffer
  try {
    const dl = await fetch(urls[0]!, { signal: AbortSignal.timeout(120000) })
    if (!dl.ok) throw new Error(`Download failed: ${dl.status}`)
    imageBytes = Buffer.from(await dl.arrayBuffer())
    if (imageBytes.length === 0) throw new Error('Downloaded zero bytes')
  } catch (e: any) {
    return res.status(502).json({ detail: `Failed to download generated preview: ${e?.message || e}` })
  }

  const saved = await savePreview({ styleTag, imageBytes, modelId: modelName })
  return res.json({
    hash: saved.hash,
    url: `/api/style-preview-cache/${saved.hash}`,
    cached: false,
    style_tag: saved.style_tag,
    model_id: saved.model_id,
    created_at: saved.created_at,
    size_bytes: saved.size_bytes,
  })
})

router.get('/style-preview-cache/:hash', async (req, res) => {
  // Hash is sha256 prefix — restrict to hex to make path traversal impossible.
  const hash = String(req.params.hash || '')
  if (!/^[0-9a-f]{16}$/.test(hash)) return res.status(400).json({ detail: 'Invalid preview hash' })
  const abs = await pathForHash(hash)
  if (!abs) return res.status(404).json({ detail: 'Preview not cached' })
  // Hash IS the content key — content can never change for a given hash,
  // so we can serve with aggressive cache headers. The frontend re-fetches
  // by changing the URL when the user generates a new preview (different
  // hash for different style description).
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('Content-Type', 'image/png')
  res.sendFile(abs)
})

/**
 * Pick a sensible default image model from the project's config when the
 * caller didn't specify one. Prefers a model marked `default: true`, then
 * falls back to the first key in image_models. Returns '' when the
 * project has no image models configured.
 */
function pickDefaultImageModel(imageModels: Record<string, ImageModelConfig>): string {
  const entries = Object.entries(imageModels)
  if (entries.length === 0) return ''
  const flagged = entries.find(([, cfg]) => (cfg as any)?.default === true)
  if (flagged) return flagged[0]
  return entries[0]![0]
}
