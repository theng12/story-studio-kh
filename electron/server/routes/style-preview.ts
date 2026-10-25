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
import { streamTo } from '../lib/stream-file.js'
import { channelStyleTagSourceHash } from '../services/channel-style-previews.js'
import { pathForUserStylePreviewAsset, sharedStylePreviewSlots } from '../services/user-style-previews.js'

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
      detail: 'No Gateway API Key is saved. Add one in Settings → App & Connections.',
    })
  }

  let catalog
  try {
    catalog = await listImageModels(apiKey)
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'Could not load the Gateway image catalog' })
  }
  const selectedModel = catalog.find(model => model.id === modelName)
  if (!selectedModel) {
    return res.status(400).json({
      detail: `The selected model is not in the live Gateway image catalog: ${modelName}`,
    })
  }
  if (!selectedModel.available) {
    return res.status(409).json({
      detail: `${selectedModel.display_name} is currently unavailable in the Gateway.`,
    })
  }
  if (selectedModel.locked) {
    return res.status(409).json({ detail: `${selectedModel.display_name} is locked for this Gateway account.` })
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
      requiresAdmissionPermit: selectedModel.requires_admission_permit,
      requestIdentity: force
        ? `style-preview:${slug}:${randomUUID()}`
        : `style-preview:${slug}:${stablePreviewKey}`,
    })
    source = result.url
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'The Gateway could not make the image' })
  }

  let imageBytes: Buffer
  try {
    if (source.startsWith('data:')) {
      imageBytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
    } else {
      throw new Error('The Gateway returned an unsupported preview artifact')
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
    streamTo(res, stream)
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

/**
 * The pointer a saved style should carry to the style text its previews describe.
 *
 * A channel style's three previews are not stored in this preset: they live in
 * the shared content-addressed store, keyed by the hash of the style text
 * (`services/channel-style-previews.ts`). So the preset records only WHICH text
 * those previews were made from, and that pointer is what makes a later edit
 * visible — the style's own text no longer hashes to it, so the previews on
 * screen are shown as out of date rather than as current.
 *
 * It is derived, not asserted by the client: a pointing hash is written only
 * when three previews really exist for the text being saved, and otherwise the
 * preset keeps pointing at whatever text its previews actually came from —
 * including the text it used to have, which is the whole point of the field.
 * That is why an edit does not clear it.
 */
async function previewSourceHashForSave(description: string, existing?: string): Promise<string | undefined> {
  const hash = channelStyleTagSourceHash(description)
  const stored = await sharedStylePreviewSlots(hash)
  if (stored.length) return hash
  return existing
}

/**
 * Give a saved style the ONE project-local picture it still needs.
 *
 * A style's three previews are held once per style TEXT in the shared store and
 * are read from there by every channel, so nothing is copied for display. But a
 * channel's active art style ALSO feeds one reference image into image-to-image
 * renders, and `services/art-style-resolver.ts` reads that from a file inside the
 * project — which is what the older "save the rendered proof into the project"
 * step used to provide. So a style with no picture of its own yet gets the hero
 * slot copied in as one file.
 *
 * Only when it has none: an existing picture is never overwritten, nothing is
 * ever removed, and no second or third copy is made (§5 — a style's older files
 * are left exactly as they are).
 */
async function seedPresetReferenceImage(
  slug: string,
  presetId: string,
  sourceHash: string,
): Promise<{ preview_filename: string; preview_files: string[]; preview_saved_at: string } | null> {
  const slots = await sharedStylePreviewSlots(sourceHash)
  const hero = slots.find(entry => entry.slot === 'hero') || slots[0]
  if (!hero) return null
  const source = await pathForUserStylePreviewAsset(hero.hash)
  if (!source) return null
  const projDir = pm.getProjectDir(slug)
  if (!projDir) return null
  try {
    const fsMod = await import('fs')
    const fsp = await import('fs/promises')
    const pathMod = await import('path')
    const dir = pathMod.join(projDir, 'style-previews')
    if (!fsMod.existsSync(dir)) await fsp.mkdir(dir, { recursive: true })
    const filename = `${presetId}.png`
    await fsp.writeFile(pathMod.join(dir, filename), await fsp.readFile(source))
    return { preview_filename: filename, preview_files: [filename], preview_saved_at: new Date().toISOString() }
  } catch {
    // A missing reference image costs the style one img2img hint; it must never
    // fail the save the customer asked for.
    return null
  }
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
    // The live model the previews were rendered with, recorded whenever the
    // caller names one. A preset whose previews come from the shared store has
    // no file of its own, so this must not be gated on one existing.
    if (preview_model) preset.preview_model = preview_model
    if (preview_aspect_ratio) preset.preview_aspect_ratio = preview_aspect_ratio
    if (preview_tier) preset.preview_tier = preview_tier
    if (preview_filename) {
      preset.preview_filename = preview_filename
      preset.preview_files = preview_files
      preset.preview_saved_at = preview_saved_at
    }
    const sourceHash = await previewSourceHashForSave(description)
    if (sourceHash) {
      preset.preview_source_hash = sourceHash
      preset.preview_saved_at = preset.preview_saved_at || now
      // A style saved for a text that already has its three previews has no
      // project-local picture of its own: take the hero as its img2img
      // reference. The displayed previews still come from the shared store.
      if (!preset.preview_filename) {
        const seeded = await seedPresetReferenceImage(slug, id, sourceHash)
        if (seeded) {
          preset.preview_filename = seeded.preview_filename
          preset.preview_files = seeded.preview_files
          preset.preview_saved_at = seeded.preview_saved_at
        }
      }
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
    // Re-derive the pointer to the text these previews describe. An edit that
    // has no three previews of its own yet keeps pointing at the text they DID
    // come from, so the earlier images are still shown — and shown as out of
    // date — instead of the style silently losing its previews.
    const keptSourceHash = await previewSourceHashForSave(description, target.preview_source_hash)
    if (keptSourceHash) updated.preview_source_hash = keptSourceHash
    else delete updated.preview_source_hash
    // The model the previews were rendered with is a setting the caller states,
    // not a side effect of attaching files: a preset whose previews live in the
    // shared store has no files to attach and still needs to say what made them.
    if (preview_model) updated.preview_model = preview_model
    if (preview_aspect_ratio) updated.preview_aspect_ratio = preview_aspect_ratio
    if (preview_tier) updated.preview_tier = preview_tier
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
        // The caller asked for a new preview set and none materialized, so the
        // preset has no previews: the pointer must not outlive them.
        delete updated.preview_source_hash
      }
    }

    // A style saved with no picture of its own takes the hero slot as its
    // img2img reference; its three previews still come from the shared store.
    if (!hasNewPreviewPayload && !updated.preview_filename && keptSourceHash) {
      const seeded = await seedPresetReferenceImage(slug, id, keptSourceHash)
      if (seeded) {
        updated.preview_filename = seeded.preview_filename
        updated.preview_files = seeded.preview_files
        updated.preview_saved_at = seeded.preview_saved_at
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
    streamTo(res, stream)
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to serve preset preview' })
  }
})
