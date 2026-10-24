/**
 * Saved previews for the owner's own styles (user style packs).
 *
 *   POST /api/user-style-previews/:styleId/generate
 *     body: { model, aspect_ratio, tier?, slots?, force? }
 *     200 : { style_id, source_hash, images, generated, skipped, failed[], stale }
 *     Renders the previews this style needs, one image at a time, saves each
 *     beside the user style packs, and reports every slot that failed BY NAME.
 *     A slot that is already saved for this style's own text is SKIPPED — so a
 *     retry after a failure regenerates only what is absent and never recharges
 *     for what succeeded. `force` is the deliberate re-render and overrides the
 *     skip.
 *
 *   GET /api/user-style-previews/assets/:hash
 *     200: the saved bytes, content-typed from the decoded image, immutable
 *     400: not a 64-hex content key
 *     404: no saved preview carries that key
 *
 * The prompt is built HERE from the style's own `style_bible` and
 * `negative_prompt`, never sent by the client: a style preview goes through a
 * paid image model, and no caller may put arbitrary text through one. The three
 * framings are the owner's own brief — hero, empty scene, hardest legal case —
 * and they are the same three a signed pack ships.
 */

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'

import { Router } from 'express'
import { z } from 'zod'

import { validateBody } from '../lib/validate.js'
import { generateImageWithGenStudio, listImageModels } from '../lib/genstudio-client.js'
import { streamTo } from '../lib/stream-file.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { findUserStylePackStyle } from '../services/user-style-packs.js'
import {
  USER_STYLE_PREVIEW_SLOTS,
  generateUserStylePreviews,
  pathForUserStylePreviewAsset,
  userStylePreviewPrompts,
  type UserStylePreviewSlot,
} from '../services/user-style-previews.js'

export const router = Router()

const GenerateSchema = z.object({
  model: z.string().min(1),
  aspect_ratio: z.string().min(1),
  /** Tier id for variable-priced models (nano-banana high/low etc.). */
  tier: z.string().optional(),
  /** Omitted means "the previews this style is missing". */
  slots: z.array(z.enum(USER_STYLE_PREVIEW_SLOTS)).min(1).max(USER_STYLE_PREVIEW_SLOTS.length).optional(),
  /** Explicit reroll: ask the provider for new pixels rather than reusing the identity. */
  force: z.boolean().optional(),
})

router.post('/user-style-previews/:styleId/generate', validateBody(GenerateSchema), async (req, res) => {
  const styleId = String(req.params.styleId)
  const style = await findUserStylePackStyle(styleId)
  if (!style) return res.status(404).json({ detail: `No user style pack declares the style ${styleId}` })

  const modelName = req.body.model as string
  const aspectRatio = req.body.aspect_ratio as string
  const tier = (req.body.tier as string | undefined) || ''
  const slots = req.body.slots as UserStylePreviewSlot[] | undefined
  const force = req.body.force === true

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
    return res.status(400).json({ detail: `The selected model is not in the live Gateway image catalog: ${modelName}` })
  }
  if (!selectedModel.available) {
    return res.status(409).json({ detail: `${selectedModel.display_name} is currently unavailable in the Gateway.` })
  }
  if (selectedModel.locked) {
    return res.status(409).json({ detail: `${selectedModel.display_name} is locked for this Gateway account.` })
  }
  if (selectedModel.aspect_ratios.length && !selectedModel.aspect_ratios.includes(aspectRatio)) {
    return res.status(400).json({
      detail: `${selectedModel.display_name} does not support ${aspectRatio}. Choose ${selectedModel.aspect_ratios.join(', ')}.`,
    })
  }
  // Every prompt is checked against THIS model's published ceiling, and the one
  // that is too long is named. A preview whose prompt does not fit is refused
  // before any request, never silently shortened.
  if (selectedModel.max_prompt_characters) {
    const prompts = userStylePreviewPrompts(style)
    for (const slot of USER_STYLE_PREVIEW_SLOTS) {
      if (prompts[slot].length <= selectedModel.max_prompt_characters) continue
      return res.status(400).json({
        detail: `${selectedModel.display_name} accepts up to ${selectedModel.max_prompt_characters.toLocaleString()} prompt characters; this style's ${slot} preview prompt is ${prompts[slot].length.toLocaleString()}. Shorten the style's own text, or choose a model with a longer ceiling.`,
      })
    }
  }

  const result = await generateUserStylePreviews({
    styleId,
    style,
    modelId: selectedModel.id,
    aspectRatio,
    tier,
    force,
    ...(slots ? { slots } : {}),
    async generate({ prompt, requestIdentity }) {
      const rendered = await generateImageWithGenStudio(apiKey, {
        prompt,
        modelId: selectedModel.id,
        aspectRatio,
        requiresAdmissionPermit: selectedModel.requires_admission_permit,
        requestIdentity,
      })
      // The Gateway hands back a data URL for this lane; anything else is not an
      // artifact this route knows how to keep.
      if (!rendered.url.startsWith('data:')) throw new Error('The Gateway returned an unsupported preview artifact')
      const bytes = Buffer.from(rendered.url.slice(rendered.url.indexOf(',') + 1), 'base64')
      if (!bytes.length) throw new Error('The Gateway returned zero bytes')
      return bytes
    },
  })

  res.json({
    style_id: styleId,
    source_hash: result.source_hash,
    images: result.urls,
    generated: result.generated,
    // Asked for and already saved: reported, so a caller never reads "not in
    // `generated`" as "nothing happened".
    skipped: result.skipped,
    failed: result.failed,
    stale: result.stale,
  })
})
router.get('/user-style-previews/assets/:hash', async (req, res) => {
  const hash = String(req.params.hash || '')
  // The content key is 64 hex characters or it is not one of ours. This is also
  // what stops a path ever reaching the filesystem from this route.
  if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ detail: 'Invalid preview asset id' })
  const abs = await pathForUserStylePreviewAsset(hash)
  if (!abs) return res.status(404).json({ detail: 'No saved preview carries that id' })

  // Streamed directly rather than through res.sendFile, which silently 404s on
  // macOS when the user-data path contains spaces — the same reason the app-wide
  // preview cache streams its own bytes.
  try {
    const stat = await fsPromises.stat(abs)
    const extension = abs.slice(abs.lastIndexOf('.') + 1)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('Content-Type', extension === 'png' ? 'image/png' : extension === 'jpg' ? 'image/jpeg' : 'image/webp')
    res.setHeader('Content-Length', String(stat.size))
    const stream = fs.createReadStream(abs)
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ detail: 'Failed to read the saved preview' })
    })
    streamTo(res, stream)
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to serve the saved preview: ${e?.message || e}` })
  }
})
