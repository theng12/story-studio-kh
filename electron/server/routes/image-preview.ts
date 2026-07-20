/**
 * Image Generator preview surface — three routes powering the
 * "Preview what will be generated" card on /projects/:slug/images.
 *
 *   GET  /api/projects/:slug/episodes/:episodeId/image-prompts
 *     200: { scenes: [{number, title, prompt}], thumbnails: [...] }
 *     404: prompts not generated yet
 *     Pre-flight read of the parsed prompts. Free; just a docx parse.
 *
 *   POST /api/projects/:slug/preview-image
 *     body: { prompt: string, model: string, aspect_ratio: string, tier?: string }
 *     200: { hash, url, cached, created_at, size_bytes, model_id, aspect_ratio, tier }
 *     Generates ONE sample render of the given prompt against the user's
 *     chosen model. Cache-key bundles every input that affects the output
 *     (prompt + model + aspect + tier), so re-clicking the same combo is
 *     free; switching any input invalidates and triggers a fresh render.
 *
 *   GET  /api/image-preview-cache/:hash
 *     200: image/png (immutable cache headers)
 *     404: hash not in cache
 *     Streams the cached PNG so the renderer can drop the URL into a
 *     stable <img src=…> binding.
 */

import path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../lib/validate.js'
import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import { getCached, savePreview, pathForHash } from '../services/image-preview-cache.js'
import type { ImageModelConfig } from '../models/types.js'
import { resolveImageProviderParams } from '../models/image-provider-params.js'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'

export const router = Router()

// ── GET prompts list ─────────────────────────────────────────────────────

router.get('/projects/:slug/episodes/:episodeId/image-prompts', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.query.title as string) || ''
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const paths = await resolveEpisodePaths(slug, episodeId, titleParam)

    // The prompt docx files live alongside the episode's other artifacts.
    // Two files: scene_prompts_docx + thumb_prompts_docx. Either may
    // be missing if the user hasn't generated that mode yet (e.g. ran
    // "scenes only" → no thumbnail_prompts.docx). Parse what's there
    // and return empty arrays for what isn't.
    const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
    const { existsSync } = await import('fs')

    let scenes: any[] = []
    let thumbnails: any[] = []
    let anyFound = false
    // resolveReadPath: prefer .md, fall back to a legacy .docx sibling.
    const scenePath = paths.scene_prompts_docx ? resolveReadPath(paths.scene_prompts_docx) : ''
    const thumbPath = paths.thumb_prompts_docx ? resolveReadPath(paths.thumb_prompts_docx) : ''
    if (scenePath && existsSync(scenePath)) {
      try {
        const parsed = await parseImagePromptsDocx(scenePath)
        scenes = parsed.scenes || []
        anyFound = true
      } catch { /* unreadable — leave empty */ }
    }
    if (thumbPath && existsSync(thumbPath)) {
      try {
        const parsed = await parseImagePromptsDocx(thumbPath)
        thumbnails = parsed.thumbnails || []
        anyFound = true
      } catch { /* unreadable — leave empty */ }
    }

    if (!anyFound) {
      // Distinguish "prompts not generated yet" from "project not found"
      // so the frontend can show a friendly nudge to run Image Prompts
      // first instead of a generic 500.
      return res.status(404).json({
        detail: 'No image prompts found. Run the Image Prompts generator first.',
      })
    }

    res.json({ scenes, thumbnails })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to read image prompts' })
  }
})

// ── POST generate / fetch-from-cache preview ──────────────────────────────

const PreviewImageSchema = z.object({
  prompt: z.string().min(1).max(8000),
  model: z.string().min(1),
  aspect_ratio: z.string().min(1),
  /** Tier id for variable-priced models (e.g. nano-banana high/low).
   *  Flat-priced models ignore this; we still include it in the cache
   *  key so a user toggling tier on a tiered model gets a fresh render. */
  tier: z.string().optional(),
  image_steps: z.number().int().min(1).max(100).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
})

router.post('/projects/:slug/preview-image', validateBody(PreviewImageSchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const prompt = (req.body.prompt as string).trim()
  const modelName = req.body.model as string
  const aspectRatio = req.body.aspect_ratio as string
  const tier = (req.body.tier as string | undefined) || ''
  const steps = req.body.image_steps as number | undefined
  const seed = req.body.seed as number | undefined

  // Cache lookup first — the whole point of the feature is "free for
  // re-use". Hit short-circuits the provider entirely.
  const cached = await getCached({ prompt, modelId: modelName, aspectRatio, tier, steps, seed })
  if (cached) {
    return res.json({
      hash: cached.hash,
      url: `/api/image-preview-cache/${cached.hash}`,
      cached: true,
      created_at: cached.created_at,
      size_bytes: cached.size_bytes,
      model_id: cached.model_id,
      aspect_ratio: cached.aspect_ratio,
      tier: cached.tier,
    })
  }

  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project config not found' })

  const modelConfig = resolveImageModelConfig(config, modelName)
  if (!modelConfig) {
    return res.status(400).json({ detail: `Unknown image model: ${modelName}` })
  }

  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) {
    return res.status(400).json({ detail: `No image provider registered for: ${providerId}` })
  }

  // Provider params + tier override. Same shape generators/images.ts uses;
  // for tiered models we layer the picked tier's api_model on top so the
  // sample render uses the same tier the user is about to pay for.
  const providerParams = resolveImageProviderParams(modelConfig, tier)

  const apiKey = await resolveApiKeyForProvider(slug, imageProvider.meta, { model: modelName })
  if (!apiKey) {
    return res.status(400).json({
      detail: `No API key configured for ${imageProvider.meta.name}. Add one in Settings → API Keys.`,
    })
  }

  let urls: string[] = []
  try {
    const result = await imageProvider.generateImage({
      prompt,
      apiKey,
      aspectRatio,
      modelId: modelName,
      providerParams,
      steps,
      seed,
    })
    urls = result.urls || []
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'Image provider failed' })
  }
  if (!urls.length) return res.status(502).json({ detail: 'Image provider returned no images' })

  let imageBytes: Buffer
  try {
    const source = urls[0]!
    if (source.startsWith('data:')) {
      imageBytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
    } else {
      const dl = await fetch(source, { signal: AbortSignal.timeout(120000) })
      if (!dl.ok) throw new Error(`Download failed: ${dl.status}`)
      imageBytes = Buffer.from(await dl.arrayBuffer())
    }
    if (imageBytes.length === 0) throw new Error('Downloaded zero bytes')
  } catch (e: any) {
    return res.status(502).json({ detail: `Failed to download generated preview: ${e?.message || e}` })
  }

  const saved = await savePreview({ prompt, modelId: modelName, aspectRatio, tier, steps, seed, imageBytes })
  res.json({
    hash: saved.hash,
    url: `/api/image-preview-cache/${saved.hash}`,
    cached: false,
    created_at: saved.created_at,
    size_bytes: saved.size_bytes,
    model_id: saved.model_id,
    aspect_ratio: saved.aspect_ratio,
    tier: saved.tier,
  })
})

// ── GET cached PNG ────────────────────────────────────────────────────────

router.get('/image-preview-cache/:hash', async (req, res) => {
  // Hash IS the content key (sha256 prefix). Restrict to hex to make
  // path traversal impossible.
  const hash = String(req.params.hash || '')
  if (!/^[0-9a-f]{16}$/.test(hash)) return res.status(400).json({ detail: 'Invalid preview hash' })
  const abs = await pathForHash(hash)
  if (!abs) return res.status(404).json({ detail: 'Preview not cached' })
  // Hash never collides with new content for the same hash, so we can
  // serve with immutable cache headers — the frontend picks up new
  // renders by URL change (different hash for different prompt/model/etc).
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('Content-Type', 'image/png')
  res.sendFile(path.resolve(abs))
})
