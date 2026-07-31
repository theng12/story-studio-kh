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

import { randomUUID } from 'crypto'
import path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../lib/validate.js'
import * as pm from '../services/project-manager.js'
import {
  getCachedStylePreview,
  hashStylePreviewKey,
  saveStylePreview,
  pathForStylePreviewHash,
} from '../services/style-preview-cache.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { generateImageWithGenStudio, listImageModels } from '../lib/genstudio-client.js'

export const router = Router()

// One stable, coherent proof scene covers the major visual-style dimensions
// without spending five separate image generations.
const STYLE_PREVIEW_VARIANTS = {
  'style-proof': 'A traveler pauses beside a small open-air reading shelter on a winding garden path at golden hour. Show one expressive full-body character, a few tactile props, foreground plants, architectural details, distant landscape depth, and clear natural lighting in one coherent scene. No captions, labels, split panels, collage layout, or written text.',
} as const

type StylePreviewVariantId = keyof typeof STYLE_PREVIEW_VARIANTS

const StylePreviewSchema = z.object({
  style_tag: z.string().min(1).max(2000),
  model: z.string().min(1),
  aspect_ratio: z.string().min(1),
  /** Tier id for variable-priced models (nano-banana high/low etc.). */
  tier: z.string().optional(),
  variant_id: z.literal('style-proof').optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
  /** Explicit reroll: bypass the free cache hit and ask the provider for new pixels. */
  force: z.boolean().optional(),
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
  const variantId = ((req.body.variant_id as StylePreviewVariantId | undefined) || 'style-proof')
  const force = req.body.force === true
  const seed = req.body.seed as number | undefined

  // Cache lookup short-circuits the provider entirely on hit.
  const cached = force
    ? null
    : await getCachedStylePreview({
      styleTag, modelId: modelName, aspectRatio, tier, variantId, seed,
    })
  if (cached) {
    return res.json({
      hash: cached.hash,
      url: `/api/style-preview-cache/${cached.hash}`,
      cached: true,
      model_id: cached.model_id,
      aspect_ratio: cached.aspect_ratio,
      tier: cached.tier,
      variant_id: cached.variant_id,
      created_at: cached.created_at,
      size_bytes: cached.size_bytes,
    })
  }

  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    return res.status(400).json({
      detail: 'No GenStudio KH API key is saved. Add one in Settings → App & Connections.',
    })
  }

  let catalog
  try {
    catalog = await listImageModels(apiKey)
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'Could not load the GenStudio image catalog' })
  }
  const selectedModel = catalog.find(model => model.id === modelName)
  if (!selectedModel) {
    return res.status(400).json({
      detail: `The selected model is not in the live GenStudio image catalog: ${modelName}`,
    })
  }
  if (!selectedModel.available) {
    return res.status(409).json({
      detail: `${selectedModel.display_name} is currently unavailable in GenStudio.`,
    })
  }
  if (selectedModel.aspect_ratios.length && !selectedModel.aspect_ratios.includes(aspectRatio)) {
    return res.status(400).json({
      detail: `${selectedModel.display_name} does not support ${aspectRatio}. Choose ${selectedModel.aspect_ratios.join(', ')}.`,
    })
  }
  // Prompt length is checked against THIS model's published ceiling, when
  // GenStudio publishes one. No published cap means no local check.
  const prompt = `${styleTag}. ${STYLE_PREVIEW_VARIANTS[variantId]}`
  if (selectedModel.max_prompt_characters && prompt.length > selectedModel.max_prompt_characters) {
    return res.status(400).json({
      detail: `${selectedModel.display_name} accepts up to ${selectedModel.max_prompt_characters.toLocaleString()} prompt characters; this preview prompt is ${prompt.length.toLocaleString()}.`,
    })
  }

  const stablePreviewKey = hashStylePreviewKey({
    styleTag,
    modelId: modelName,
    aspectRatio,
    tier,
    variantId,
    seed,
  })
  let source: string
  try {
    const result = await generateImageWithGenStudio(apiKey, {
      prompt,
      modelId: modelName,
      aspectRatio,
      seed: selectedModel.supports_seed === false ? undefined : seed,
      requestIdentity: force
        ? `style-preview:${slug}:${randomUUID()}`
        : `style-preview:${slug}:${stablePreviewKey}`,
    })
    source = result.url
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'GenStudio image generation failed' })
  }

  let imageBytes: Buffer
  try {
    if (source.startsWith('data:')) {
      imageBytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
    } else {
      throw new Error('GenStudio returned an unsupported preview artifact')
    }
    if (imageBytes.length === 0) throw new Error('Downloaded zero bytes')
  } catch (e: any) {
    return res.status(502).json({ detail: `Failed to download generated preview: ${e?.message || e}` })
  }

  const saved = await saveStylePreview({
    styleTag,
    modelId: modelName,
    aspectRatio,
    tier,
    variantId,
    seed,
    imageBytes,
  })
  res.json({
    hash: saved.hash,
    url: `/api/style-preview-cache/${saved.hash}`,
    cached: false,
    model_id: saved.model_id,
    aspect_ratio: saved.aspect_ratio,
    tier: saved.tier,
    variant_id: saved.variant_id,
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
 * Project-level named style presets (v1.0.89+).
 *
 * A preset is a named entry in ProjectConfig.style_presets carrying the
 * style description text + an optional rendered preview PNG copied into
 * `<project>/style-previews/<slug>.png`. Both halves move with the
 * project via iCloud — text in config.json, PNG alongside.
 *
 *   POST   /api/projects/:slug/style-presets       — create/update
 *   DELETE /api/projects/:slug/style-presets/:id   — remove + delete PNG
 *   GET    /api/projects/:slug/style-presets/:id/preview — serve the PNG
 *
 * List goes through the regular /settings/config endpoint — presets
 * live on the config object alongside other project-scoped settings.
 *
 * Caveats:
 *   - The app-wide hash cache (electron/.style-previews/<hash>.png) is
 *     UNCHANGED by these routes. It stays as a perf optimisation for
 *     re-renders of the same (style, model, aspect, tier) tuple.
 *   - Presets share their pool with the Image Prompts page's "Custom"
 *     style dropdown — a preset saved here surfaces there too (and
 *     vice versa). One project-level pool, two surfaces.
 *   - Name collisions auto-bump the slug (`bound-cartoon-2`, `-3`, …).
 *     Display name stays whatever the user typed.
 */
const StylePresetSaveSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(8000),
  /** Optional — hash of an app-wide cache entry to seed the preview from. */
  hash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  /** Optional — multiple cached preview hashes for a richer style gallery. */
  hashes: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(8).optional(),
  /** Existing project-local previews to keep while replacing individual gallery slots. */
  retained_preview_files: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/)).max(8).optional(),
  /** Ordered gallery sources, allowing one generated slot to replace one saved slot safely. */
  gallery_items: z.array(z.union([
    z.object({ hash: z.string().regex(/^[0-9a-f]{16}$/) }),
    z.object({ source_file: z.string().regex(/^[a-zA-Z0-9._-]+$/) }),
  ])).max(8).optional(),
  preview_model: z.string().optional(),
  preview_aspect_ratio: z.string().optional(),
  preview_tier: z.string().optional(),
})

async function materializePresetPreviewFiles(opts: {
  slug: string
  presetId: string
  hashes?: string[]
  hash?: string
  retainedFiles?: string[]
  galleryItems?: Array<{ hash: string } | { source_file: string }>
}): Promise<{
  preview_filename?: string
  preview_files?: string[]
  preview_saved_at?: string
}> {
  const { slug, presetId, hashes, hash, retainedFiles, galleryItems } = opts
  const fsMod = await import('fs')
  const fsp = await import('fs/promises')
  const pathMod = await import('path')
  let preview_filename: string | undefined
  let preview_files: string[] | undefined
  let preview_saved_at: string | undefined
  const requestedHashes = Array.from(new Set(
    (Array.isArray(hashes) && hashes.length ? hashes : (hash ? [hash] : [])).filter(Boolean),
  ))
  const sourceBuffers: Buffer[] = []
  const projDir = pm.getProjectDir(slug)
  if (!projDir) return {}
  if (galleryItems !== undefined) {
    for (const item of galleryItems) {
      if ('source_file' in item) {
        const retainedAbs = pathMod.join(projDir, 'style-previews', item.source_file)
        if (fsMod.existsSync(retainedAbs)) sourceBuffers.push(await fsp.readFile(retainedAbs))
      } else {
        const cachedAbs = await pathForStylePreviewHash(item.hash)
        if (cachedAbs && fsMod.existsSync(cachedAbs)) sourceBuffers.push(await fsp.readFile(cachedAbs))
      }
    }
  } else {
    for (const retainedFile of Array.from(new Set(retainedFiles || []))) {
      const retainedAbs = pathMod.join(projDir, 'style-previews', retainedFile)
      if (fsMod.existsSync(retainedAbs)) sourceBuffers.push(await fsp.readFile(retainedAbs))
    }
    for (const previewHash of requestedHashes) {
      const cachedAbs = await pathForStylePreviewHash(previewHash)
      if (cachedAbs && fsMod.existsSync(cachedAbs)) sourceBuffers.push(await fsp.readFile(cachedAbs))
    }
  }
  if (!sourceBuffers.length) return {}
  const previewsDir = pathMod.join(projDir, 'style-previews')
  if (!fsMod.existsSync(previewsDir)) await fsp.mkdir(previewsDir, { recursive: true })
  preview_files = []
  for (const [index, imageBytes] of sourceBuffers.entries()) {
    const filename = index === 0 ? `${presetId}.png` : `${presetId}-${index + 1}.png`
    await fsp.writeFile(pathMod.join(previewsDir, filename), imageBytes)
    preview_files.push(filename)
  }
  preview_filename = preview_files[0]
  preview_saved_at = new Date().toISOString()
  return { preview_filename, preview_files, preview_saved_at }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'preset'
}

router.post('/projects/:slug/style-presets', validateBody(StylePresetSaveSchema), async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const {
      name,
      description,
      hash,
      hashes,
      retained_preview_files,
      gallery_items,
      preview_model,
      preview_aspect_ratio,
      preview_tier,
    } = req.body as {
      name: string
      description: string
      hash?: string
      hashes?: string[]
      retained_preview_files?: string[]
      gallery_items?: Array<{ hash: string } | { source_file: string }>
      preview_model?: string
      preview_aspect_ratio?: string
      preview_tier?: string
    }

    const existing = Array.isArray((config as any).style_presets) ? (config as any).style_presets : []
    const baseSlug = slugify(name)
    let id = baseSlug
    let n = 2
    while (existing.some((p: any) => p.id === id)) {
      id = `${baseSlug}-${n}`
      n += 1
    }

    const { preview_filename, preview_files, preview_saved_at } = await materializePresetPreviewFiles({
      slug,
      presetId: id,
      hashes,
      hash,
      retainedFiles: retained_preview_files,
      galleryItems: gallery_items,
    })

    const now = new Date().toISOString()
    const preset: any = {
      id, name, description, created_at: now,
    }
    if (preview_filename) {
      preset.preview_filename = preview_filename
      preset.preview_files = preview_files
      preset.preview_model = preview_model
      preset.preview_aspect_ratio = preview_aspect_ratio
      preset.preview_tier = preview_tier
      preset.preview_saved_at = preview_saved_at
    }

    const nextPresets = [...existing, preset]
    await pm.updateConfig(slug, { style_presets: nextPresets } as any)
    res.json(preset)
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to save style preset' })
  }
})

router.put('/projects/:slug/style-presets/:id', validateBody(StylePresetSaveSchema), async (req, res) => {
  const { slug, id } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const existing = Array.isArray((config as any).style_presets) ? (config as any).style_presets : []
    const target = existing.find((p: any) => p.id === id)
    if (!target) return res.status(404).json({ detail: `Preset '${id}' not found` })

    const {
      name,
      description,
      hash,
      hashes,
      retained_preview_files,
      gallery_items,
      preview_model,
      preview_aspect_ratio,
      preview_tier,
    } = req.body as {
      name: string
      description: string
      hash?: string
      hashes?: string[]
      retained_preview_files?: string[]
      gallery_items?: Array<{ hash: string } | { source_file: string }>
      preview_model?: string
      preview_aspect_ratio?: string
      preview_tier?: string
    }

    const currentPreviewFiles = Array.from(new Set([
      ...(Array.isArray(target.preview_files) ? target.preview_files : []),
      ...(target.preview_filename ? [target.preview_filename] : []),
    ]))
    const requestedRetainedFiles = Array.isArray(retained_preview_files)
      ? retained_preview_files.filter(file => currentPreviewFiles.includes(file))
      : undefined
    const requestedGalleryItems = Array.isArray(gallery_items)
      ? gallery_items.filter(item => 'hash' in item || currentPreviewFiles.includes(item.source_file))
      : undefined
    const hasNewPreviewPayload = hash !== undefined ||
      hashes !== undefined ||
      retained_preview_files !== undefined ||
      gallery_items !== undefined
    const replacementPreview = hasNewPreviewPayload
      ? await materializePresetPreviewFiles({
          slug,
          presetId: id,
          hashes,
          hash,
          retainedFiles: requestedRetainedFiles,
          galleryItems: requestedGalleryItems,
        })
      : {}

    if (hasNewPreviewPayload && currentPreviewFiles.length) {
      const replacementFiles = new Set(replacementPreview.preview_files || [])
      try {
        const projDir = pm.getProjectDir(slug)
        if (projDir) {
          const fsp = await import('fs/promises')
          const pathMod = await import('path')
          for (const file of currentPreviewFiles) {
            if (!replacementFiles.has(file)) {
              await fsp.unlink(pathMod.join(projDir, 'style-previews', file)).catch(() => {})
            }
          }
        }
      } catch { /* tolerate */ }
    }

    const updated: any = {
      ...target,
      name,
      description,
    }
    if (hasNewPreviewPayload) {
      if (replacementPreview.preview_filename) {
        updated.preview_filename = replacementPreview.preview_filename
        updated.preview_files = replacementPreview.preview_files
        updated.preview_model = preview_model
        updated.preview_aspect_ratio = preview_aspect_ratio
        updated.preview_tier = preview_tier
        updated.preview_saved_at = replacementPreview.preview_saved_at
      } else {
        delete updated.preview_filename
        delete updated.preview_files
        delete updated.preview_model
        delete updated.preview_aspect_ratio
        delete updated.preview_tier
        delete updated.preview_saved_at
      }
    }

    const nextPresets = existing.map((preset: any) => preset.id === id ? updated : preset)
    await pm.updateConfig(slug, { style_presets: nextPresets } as any)
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to update style preset' })
  }
})

router.delete('/projects/:slug/style-presets/:id', async (req, res) => {
  const { slug, id } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const existing = Array.isArray((config as any).style_presets) ? (config as any).style_presets : []
    const target = existing.find((p: any) => p.id === id)
    if (!target) return res.status(404).json({ detail: `Preset '${id}' not found` })

    // Remove the project-local preview PNGs (if any). Best-effort — a
    // missing file shouldn't block the config update; the user's intent
    // is "drop this preset from the list."
    const previewFiles = Array.from(new Set([
      ...(Array.isArray(target.preview_files) ? target.preview_files : []),
      ...(target.preview_filename ? [target.preview_filename] : []),
    ]))
    if (previewFiles.length) {
      try {
        const projDir = pm.getProjectDir(slug)
        if (projDir) {
          const fsp = await import('fs/promises')
          const pathMod = await import('path')
          for (const file of previewFiles) {
            await fsp.unlink(pathMod.join(projDir, 'style-previews', file)).catch(() => {})
          }
        }
      } catch { /* tolerate */ }
    }

    await pm.updateConfig(slug, { style_presets: existing.filter((p: any) => p.id !== id) } as any)
    res.json({ ok: true, id })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to delete style preset' })
  }
})

router.get('/projects/:slug/style-presets/:id/preview', async (req, res) => {
  const { slug, id } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const existing = Array.isArray((config as any).style_presets) ? (config as any).style_presets : []
    const target = existing.find((p: any) => p.id === id)
    const requestedFile = typeof req.query.file === 'string' ? req.query.file : ''
    const previewFiles = Array.from(new Set([
      ...(Array.isArray(target?.preview_files) ? target.preview_files : []),
      ...(target?.preview_filename ? [target.preview_filename] : []),
    ]))
    const selectedFile = requestedFile || target?.preview_filename || previewFiles[0]
    if (!selectedFile) return res.status(404).json({ detail: 'No preview saved for this preset' })
    if (!previewFiles.includes(selectedFile)) {
      return res.status(404).json({ detail: 'Requested preview file is not attached to this preset' })
    }

    const projDir = pm.getProjectDir(slug)
    if (!projDir) return res.status(404).json({ detail: 'Project directory not found' })

    const fsMod = await import('fs')
    const fsp = await import('fs/promises')
    const pathMod = await import('path')
    const abs = pathMod.join(projDir, 'style-previews', selectedFile)
    if (!fsMod.existsSync(abs)) return res.status(404).json({ detail: 'Preview file missing on disk' })

    const stat = await fsp.stat(abs)
    res.setHeader('Cache-Control', 'public, max-age=300') // short cache — file can change if user saves over
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Length', String(stat.size))
    const stream = fsMod.createReadStream(abs)
    stream.on('error', () => { if (!res.headersSent) res.status(500).json({ detail: 'Read failed' }) })
    stream.pipe(res)
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to serve preset preview' })
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
