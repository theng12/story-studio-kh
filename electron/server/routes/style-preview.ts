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

  let urls: string[]
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

  // Stream the file directly instead of relying on res.sendFile — the
  // built-in Express helper silently 404's on macOS when the project
  // path contains spaces ("Story Studio KH"), even though the file is
  // readable. fs.createReadStream + Content-Type/Length headers behaves
  // identically from the browser's perspective without that quirk.
  try {
    const fsMod = await import('fs')
    const fsp = await import('fs/promises')
    const stat = await fsp.stat(abs)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Length', String(stat.size))
    const stream = fsMod.createReadStream(abs)
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ detail: 'Failed to read cached preview' })
    })
    stream.pipe(res)
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to serve cached preview: ${e?.message || e}` })
  }
})

/**
 * Save a cached style preview into a specific episode's scene-images
 * folder. The global cache stays untouched — this is a COPY into the
 * episode dir so the user has a permanent reference alongside their
 * actual scene renders (handy when reviewing in Finder later).
 *
 *   POST /api/projects/:slug/episodes/:id/style-preview-save
 *     body: { hash, title?, kind? }
 *     200 : { filename, path }
 *
 * Filename encodes (episode, kind, model, aspect, tier) so the file is
 * self-describing and multiple saves don't collide across iterations.
 */
const StylePreviewSaveSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{16}$/, 'hash must be 16 hex chars'),
  title: z.string().optional(),
  kind: z.enum(['scene', 'thumbnail']).optional(),
})

router.post('/projects/:slug/episodes/:id/style-preview-save', validateBody(StylePreviewSaveSchema), async (req, res) => {
  const { slug, id: episodeId } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const { hash, title = '', kind = 'scene' } = req.body as { hash: string; title?: string; kind?: 'scene' | 'thumbnail' }

    // Resolve the cached preview's absolute path. Same hex regex the GET
    // serve route uses — defensive against path traversal in case the
    // body bypasses the schema validator.
    const cachedAbs = await pathForStylePreviewHash(hash)
    if (!cachedAbs) return res.status(404).json({ detail: 'Preview not in cache — re-render before saving.' })

    // Read the cache entry's metadata so the saved filename can encode
    // the model + aspect + tier that produced the image. Avoids "what
    // model was this?" guessing when the user opens the folder later.
    const idx = await (await import('../services/style-preview-cache.js')).getCachedStylePreviewByHash(hash)

    // Pick the destination folder. Scene-tab previews land in the
    // scene-images folder so they sit next to the actual scene renders;
    // thumbnail-tab previews land in the thumbnails folder for the same
    // reason. Both folders are resolved through the same path resolver
    // every other generator uses (handles iCloud relocations, folder-
    // rename edge cases, etc).
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const paths = await resolveEpisodePaths(slug, episodeId, title || '')
    // `bg_dir` is the historical name for the scene-images folder in
    // resolveEpisodePaths — the property name predates the
    // scene/thumbnail split rename. Kept stable across the codebase.
    const destDir = kind === 'thumbnail' ? paths.thumb_dir : paths.bg_dir
    const fsMod = await import('fs')
    const fsp = await import('fs/promises')
    const pathMod = await import('path')

    if (!fsMod.existsSync(destDir)) {
      await fsp.mkdir(destDir, { recursive: true })
    }

    // Filename encodes everything a future viewer would need to make
    // sense of the file without opening the cache index:
    //   EP0001_StylePreview_Scene_gpt-image-2_16-9_1k_v1.png
    const code = episodeId.toUpperCase()
    const kindLabel = kind === 'thumbnail' ? 'Thumbnail' : 'Scene'
    const modelSafe = (idx?.model_id || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-')
    const aspectSafe = (idx?.aspect_ratio || '').replace(/[^a-zA-Z0-9-]/g, '-')
    const tierSafe = (idx?.tier || '').replace(/[^a-zA-Z0-9-]/g, '-')
    const base = `${code}_StylePreview_${kindLabel}_${modelSafe}` +
      (aspectSafe ? `_${aspectSafe}` : '') +
      (tierSafe ? `_${tierSafe}` : '')

    // Bump the version suffix if a previous save with identical
    // metadata exists — the user has been iterating on the same model
    // combo and we don't want to silently overwrite their earlier save.
    const existing = await fsp.readdir(destDir).catch(() => []) as string[]
    let version = 1
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)\\.png$`)
    for (const f of existing) {
      const m = re.exec(f)
      if (m) version = Math.max(version, parseInt(m[1]!, 10) + 1)
    }
    const filename = `${base}_v${version}.png`
    const destPath = pathMod.join(destDir, filename)

    await fsp.copyFile(cachedAbs, destPath)
    res.json({ filename, path: destPath })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to save preview to episode folder' })
  }
})
