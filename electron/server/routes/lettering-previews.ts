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
  swatchStyleTag, swatchVariantId,
  SWATCH_FRAMING, SWATCH_WORD, type LetteringKind,
} from '../lib/lettering-swatches.js'
import { letteringCatalogue, type LetteringCatalogueEntry } from '../services/lettering-catalogue.js'
import {
  getCachedStylePreview, saveStylePreview,
} from '../services/style-preview-cache.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { generateImageWithGenStudio, listImageModels } from '../lib/genstudio-client.js'
import { DEFAULT_HEADLINE_MODE, HEADLINE_MODES } from '../models/thumbnail-headlines.js'
import type { GenStudioImageModel } from '../lib/genstudio-client.js'

export const router = Router()

/**
 * The headline modes the picker offers. A catalogue read, never a generation,
 * so the page can render the choice before anything is spent.
 */
router.get('/thumbnail-headline-modes', (_req, res) => {
  res.json({
    default: DEFAULT_HEADLINE_MODE,
    modes: HEADLINE_MODES.map(mode => ({
      id: mode.id, label: mode.label, summary: mode.summary, invents: mode.invents,
    })),
  })
})

const PreviewSchema = z.object({
  kind: z.enum(['font', 'text']),
  style_id: z.string().min(1).max(120),
  /**
   * Optional, and normally absent. The page that hosts this picker chooses a
   * LANGUAGE model — it writes the prompts — and passing that where an image
   * model belongs is what made every swatch fail with a 400. A swatch is an
   * app-level asset, not a per-project one, so the server picks the image
   * model itself and the page does not have to know one.
   */
  model: z.string().min(1).optional(),
  aspect_ratio: z.string().min(1).optional(),
  force: z.boolean().optional(),
})

const SWATCH_ASPECT = '16:9'

/**
 * The cheapest published image model that can render a 16:9 swatch.
 *
 * Cheapest because a swatch is a small picture of a word, rendered once, and
 * paying a premium rate for thirty-five of them buys nothing. Deterministic on
 * ties by id, because the choice is part of the cache key: a model that moved
 * about would silently orphan every swatch already rendered.
 */
function pickSwatchModel(catalog: readonly GenStudioImageModel[]): GenStudioImageModel | null {
  const usable = catalog.filter(model =>
    model.available && !model.locked && !model.qualification_only
    && (!model.aspect_ratios.length || model.aspect_ratios.includes(SWATCH_ASPECT)))
  if (!usable.length) return null
  return [...usable].sort((left, right) => {
    const leftCost = left.credits_per_image ?? Number.MAX_SAFE_INTEGER
    const rightCost = right.credits_per_image ?? Number.MAX_SAFE_INTEGER
    return leftCost - rightCost || left.id.localeCompare(right.id)
  })[0]!
}

/**
 * A pack style ships its own rendered swatch, so it is never generated here.
 * Only a built-in can miss a swatch, and only a built-in is ever paid for.
 */
function asSwatchStyle(entry: LetteringCatalogueEntry) {
  return { kind: entry.axis, id: entry.id, phrase: entry.phrase }
}

async function findStyle(kind: LetteringKind, styleId: string) {
  return (await letteringCatalogue()).find(row => row.axis === kind && row.id === styleId) || null
}

async function cachedUrlFor(entry: LetteringCatalogueEntry, modelId: string, aspectRatio: string) {
  if (entry.previewUrl) return { hash: '', url: entry.previewUrl }
  const cached = await getCachedStylePreview({
    styleTag: swatchStyleTag(asSwatchStyle(entry)),
    modelId,
    aspectRatio,
    tier: '',
    variantId: swatchVariantId(entry.axis),
  })
  return cached ? { hash: cached.hash, url: `/api/style-preview-cache/${cached.hash}` } : null
}

router.get('/lettering-styles', async (req, res) => {
  const aspectRatio = String(req.query.aspect_ratio || SWATCH_ASPECT)
  // Resolve the SAME model the preview route would choose, or a swatch that
  // exists reads as missing and the owner pays to render it twice.
  let modelId = String(req.query.model || '')
  if (!modelId) {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (apiKey) {
      try { modelId = pickSwatchModel(await listImageModels(apiKey))?.id || '' } catch { modelId = '' }
    }
  }
  const styles = await letteringCatalogue()
  // With no model named the picker still renders every style, just without
  // swatches — the list of choices is not a fact about any image model. A pack
  // style is the exception: its swatch came in the archive, so it shows either
  // way and never waits on an image catalogue.
  const rows = await Promise.all(styles.map(async (style) => ({
    kind: style.axis,
    id: style.id,
    name: style.name,
    description: style.description,
    source: style.source,
    pack_id: style.packId,
    phrase: style.phrase,
    preview: style.previewUrl
      ? { hash: '', url: style.previewUrl }
      : modelId ? await cachedUrlFor(style, modelId, aspectRatio) : null,
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
  const aspectRatio = String(req.body.aspect_ratio || SWATCH_ASPECT)
  const force = req.body.force === true

  const style = await findStyle(kind, styleId)
  if (!style) return res.status(404).json({ detail: `Unknown ${kind} style: ${styleId}` })
  if (style.previewUrl) {
    // Already paid for, inside the pack. Refuse to spend on a second copy.
    return res.json({ hash: '', url: style.previewUrl, kind, style_id: styleId, cached: true, model_id: null })
  }

  const styleTag = swatchStyleTag(asSwatchStyle(style))
  const variantId = swatchVariantId(kind)

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
  const requested = req.body.model ? String(req.body.model) : ''
  const selected = requested
    ? catalog.find(model => model.id === requested) || null
    : pickSwatchModel(catalog)
  if (!selected) {
    return res.status(409).json({
      detail: requested
        ? `Not in the live GenStudio image catalog: ${requested}`
        : `No published GenStudio image model can render a ${aspectRatio} swatch right now.`,
    })
  }
  if (!selected.available) return res.status(409).json({ detail: `${selected.display_name} is currently unavailable in GenStudio.` })
  if (selected.locked) return res.status(409).json({ detail: `${selected.display_name} is locked for this GenStudio account.` })
  if (selected.aspect_ratios.length && !selected.aspect_ratios.includes(aspectRatio)) {
    return res.status(400).json({ detail: `${selected.display_name} does not support ${aspectRatio}.` })
  }
  const modelId = selected.id
  if (!force) {
    const cached = await cachedUrlFor(style, modelId, aspectRatio)
    if (cached) return res.json({ ...cached, kind, style_id: styleId, cached: true, model_id: modelId })
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
  res.json({
    hash: saved.hash, url: `/api/style-preview-cache/${saved.hash}`,
    kind, style_id: styleId, cached: false,
    model_id: modelId, model_label: selected.display_name,
    credits: selected.credits_per_image ?? null,
  })
})
