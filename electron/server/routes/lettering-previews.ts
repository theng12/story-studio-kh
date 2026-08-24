/**
 * Visual swatches for the thumbnail font and text-style catalogues.
 *
 *   GET  /api/lettering-styles
 *     Every font and text style with its swatch url when one is cached.
 *     Never generates. This is what the picker reads on every open.
 *
 *   POST /api/lettering-styles/preview
 *     body: { kind, style_id, model, aspect_ratio, force? }
 *     Generates ONE missing swatch and caches it by content hash.
 *
 * Generation is one image per style, once, and cached for ever after — the
 * owner's own framing: "each render is a one time thing. if it's a new style,
 * we just add it as new. no need to discard old stuff that's already working."
 * Adding a style later costs exactly one more image, and nothing already
 * generated is invalidated.
 *
 * The prompt is built HERE from the authoritative catalogue rather than sent by
 * the client, so a swatch always shows the phrase the prompt builder really
 * injects for that style, and no caller can put arbitrary text through a paid
 * image model.
 */
import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../lib/validate.js'
import {
  allLetteringStyles, findLetteringStyle, swatchStyleTag, swatchVariantId,
  SWATCH_FRAMING, SWATCH_WORD, type LetteringKind,
} from '../lib/lettering-swatches.js'
import {
  getCachedStylePreview, saveStylePreview,
} from '../services/style-preview-cache.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { generateImageWithGenStudio, listImageModels } from '../lib/genstudio-client.js'

export const router = Router()

const PreviewSchema = z.object({
  kind: z.enum(['font', 'text']),
  style_id: z.string().min(1).max(120),
  model: z.string().min(1),
  aspect_ratio: z.string().min(1),
  force: z.boolean().optional(),
})

async function cachedUrlFor(kind: LetteringKind, styleId: string, modelId: string, aspectRatio: string) {
  const style = findLetteringStyle(kind, styleId)
  if (!style) return null
  const cached = await getCachedStylePreview({
    styleTag: swatchStyleTag(style),
    modelId,
    aspectRatio,
    tier: '',
    variantId: swatchVariantId(kind),
  })
  return cached ? { hash: cached.hash, url: `/api/style-preview-cache/${cached.hash}` } : null
}

router.get('/lettering-styles', async (req, res) => {
  const modelId = String(req.query.model || '')
  const aspectRatio = String(req.query.aspect_ratio || '16:9')
  const styles = allLetteringStyles()
  // With no model named the picker still renders every style, just without
  // swatches — the list of choices is not a fact about any image model.
  const rows = await Promise.all(styles.map(async (style) => ({
    kind: style.kind,
    id: style.id,
    phrase: style.phrase,
    preview: modelId ? await cachedUrlFor(style.kind, style.id, modelId, aspectRatio) : null,
  })))
  res.json({
    word: SWATCH_WORD,
    styles: rows,
    missing: rows.filter(row => !row.preview).length,
  })
})

router.post('/lettering-styles/preview', validateBody(PreviewSchema), async (req, res) => {
  const kind = req.body.kind as LetteringKind
  const styleId = String(req.body.style_id)
  const modelId = String(req.body.model)
  const aspectRatio = String(req.body.aspect_ratio)
  const force = req.body.force === true

  const style = findLetteringStyle(kind, styleId)
  if (!style) return res.status(404).json({ detail: `Unknown ${kind} style: ${styleId}` })

  const styleTag = swatchStyleTag(style)
  const variantId = swatchVariantId(kind)
  if (!force) {
    const cached = await cachedUrlFor(kind, styleId, modelId, aspectRatio)
    if (cached) return res.json({ ...cached, kind, style_id: styleId, cached: true })
  }

  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    return res.status(400).json({ detail: 'No GenStudio KH API key is saved. Add one in Settings → App & Connections.' })
  }

  let catalog
  try {
    catalog = await listImageModels(apiKey)
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'Could not load the GenStudio image catalog' })
  }
  const selected = catalog.find(model => model.id === modelId)
  if (!selected) return res.status(400).json({ detail: `Not in the live GenStudio image catalog: ${modelId}` })
  if (!selected.available) return res.status(409).json({ detail: `${selected.display_name} is currently unavailable in GenStudio.` })
  if (selected.locked) return res.status(409).json({ detail: `${selected.display_name} is locked for this GenStudio account.` })
  if (selected.aspect_ratios.length && !selected.aspect_ratios.includes(aspectRatio)) {
    return res.status(400).json({ detail: `${selected.display_name} does not support ${aspectRatio}.` })
  }

  const prompt = `${styleTag}. ${SWATCH_FRAMING}`
  if (selected.max_prompt_characters && prompt.length > selected.max_prompt_characters) {
    return res.status(400).json({ detail: `${selected.display_name} accepts up to ${selected.max_prompt_characters.toLocaleString()} prompt characters; this swatch prompt is ${prompt.length.toLocaleString()}.` })
  }

  let source: string
  try {
    const result = await generateImageWithGenStudio(apiKey, {
      prompt,
      modelId,
      aspectRatio,
      // Stable per style so a repeated request is the same paid identity, not
      // a second charge for the same swatch.
      requestIdentity: `lettering-swatch:${variantId}:${styleId}:${modelId}:${aspectRatio}`,
    })
    source = result.url
  } catch (e: any) {
    return res.status(502).json({ detail: e?.message || 'GenStudio image generation failed' })
  }

  let imageBytes: Buffer
  try {
    if (!source.startsWith('data:')) throw new Error('GenStudio returned an unsupported swatch artifact')
    imageBytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
    if (imageBytes.length === 0) throw new Error('Downloaded zero bytes')
  } catch (e: any) {
    return res.status(502).json({ detail: `Failed to read the generated swatch: ${e?.message || e}` })
  }

  const saved = await saveStylePreview({
    styleTag, modelId, aspectRatio, tier: '', variantId, imageBytes,
  })
  res.json({ hash: saved.hash, url: `/api/style-preview-cache/${saved.hash}`, kind, style_id: styleId, cached: false })
})
