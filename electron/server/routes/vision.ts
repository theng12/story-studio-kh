/**
 * Vision routes — reference-image analysis for the image-prompts page.
 *
 *   POST /projects/:slug/analyze-style      →  extract style description
 *   POST /projects/:slug/analyze-character  →  describe subject from image
 *   GET  /projects/:slug/vision/caps        →  whether vision is usable
 *
 * GenStudio does not yet expose a qualified image-input language-model route,
 * so these compatibility endpoints fail closed instead of calling a provider
 * or local model directly.
 */
import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import { isPreviewablePath } from '../lib/preview-roots.js'
import { GENSTUDIO_VISION_UNAVAILABLE } from '../lib/vision-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { callChatWithGenStudio, listChatModels, uploadImageSourceWithGenStudio, type GenStudioChatModel } from '../lib/genstudio-client.js'
import { JSON_OBJECT_OUTPUT_CONTRACT } from '../lib/json-output-contract.js'

export const router = Router()

type Detail = 'low' | 'high' | 'auto'

/**
 * Whether this model can be asked to read a reference image.
 *
 * **This gate used to require four fields the gateway never publishes** —
 * `max_input_images`, `supported_detail_levels` and the two image limits — and
 * the parse turns their absence into `0` and `[]`. So `max_input_images >= 1`
 * was false for *every* model in the catalogue and no model was ever eligible:
 * the thumbnail-reference vision feature could not run at all, while the only
 * genuine statement it needed (`supports_vision: true`, which the gateway does
 * publish from the provider's own `architecture.input_modalities`) sat unread
 * beside it. Measured 2026-09-27 — this is `WIRE-3` doing real damage, not a
 * cosmetic gap.
 *
 * The gate now rests on what is published: the model is available, not locked,
 * and *states* image input. `supports_structured_output === false` is a refusal
 * and is honoured; `null` is not, because the JSON contract is validated here
 * after the call either way (`JSON_OBJECT_OUTPUT_CONTRACT`).
 */
function eligibleThumbnailVisionModel(model: GenStudioChatModel): boolean {
  return model.available && model.locked !== true
    && model.supports_vision === true
    && model.supports_structured_output !== false
}

/**
 * The detail level to send, and whose number it is.
 *
 * A model that publishes its levels gets one of its own; a model that publishes
 * none gets Story's `auto` — labelled `story`, because "we chose this" and "the
 * model states this" are different answers and the menu shows which one it is.
 */
function detailFor(model: GenStudioChatModel): { detail: Detail; source: 'model' | 'story' } {
  for (const level of ['high', 'auto', 'low'] as const) {
    if (model.supported_detail_levels.includes(level)) return { detail: level, source: 'model' }
  }
  return { detail: 'auto', source: 'story' }
}

/** Whether the model published any per-image limits at all. */
function referenceLimitsSource(model: GenStudioChatModel): 'model' | 'story' {
  return model.accepted_image_mime_types.length || model.max_image_bytes > 0 || model.max_image_dimension > 0
    ? 'model'
    : 'story'
}
function imageMime(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return ''
  }
}
function thumbnailReferenceDir(slug: string): string {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new Error('Project not found')
  return path.join(projectDir, 'thumbnail-reference-assets')
}
function parseComposition(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
  const value = JSON.parse(cleaned)
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Vision analysis did not return a JSON object')
  return value as Record<string, unknown>
}

/**
 * Private thumbnail-reference analysis. The local source is copied into the
 * project first; only the binary bytes, never its path, go to GenStudio.
 * The saved Story asset survives a GenStudio asset expiry and is therefore
 * safe to put in a named preset or a queued Pipeline snapshot.
 */
router.get('/projects/:slug/thumbnail-reference/vision-models', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey) return res.status(400).json({ detail: 'Add a Gateway key first.' })
    const models = (await listChatModels(apiKey)).filter(eligibleThumbnailVisionModel).map(model => ({
      id: model.id, display_name: model.display_name, supported_detail_levels: model.supported_detail_levels,
      cost_tier: model.cost_tier,
      input_credits_per_million_tokens: model.input_credits_per_million_tokens,
      output_credits_per_million_tokens: model.output_credits_per_million_tokens,
      standard_input_credits_per_million_tokens: model.standard_input_credits_per_million_tokens,
      standard_output_credits_per_million_tokens: model.standard_output_credits_per_million_tokens,
      minimum_credits: model.minimum_credits,
      price_version: model.price_version,
      // The shelf and its offer, same as the language picker. This menu is a
      // second place a customer commits to a chat product and pays for it, so
      // a relaxed row must read as relaxed here too — otherwise the cheaper
      // shelf exists on one screen and not on the next.
      queue_class: model.queue_class,
      relaxed_queue_hint: model.relaxed_queue_hint,
      max_input_images: model.max_input_images, accepted_image_mime_types: model.accepted_image_mime_types,
      max_image_bytes: model.max_image_bytes, max_image_dimension: model.max_image_dimension,
      // Whose numbers these are. The per-image limits are not published by any
      // provider today, so the menu must be able to say "Story's own limits"
      // rather than imply the model stated them.
      reference_limits_source: referenceLimitsSource(model),
      detail_source: detailFor(model).source,
      // Published retirement, same as the language picker. This menu is a
      // second place a customer commits to a chat product, and a whitelist
      // that forwards prices but not the withdrawal date is how the first one
      // went unnoticed for weeks.
      deprecation_warning: model.deprecation_warning,
      retires_at: model.retires_at,
    }))
    res.json({ models })
  } catch (error: any) {
    res.status(502).json({ detail: error?.message || 'Could not load Gateway vision models.' })
  }
})

router.post('/projects/:slug/thumbnail-reference/analyze', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const sourcePath = typeof req.body?.source_path === 'string' ? req.body.source_path.trim() : ''
  const modelId = typeof req.body?.model_id === 'string' ? req.body.model_id.trim() : ''
  if (!sourcePath || !modelId) return res.status(400).json({ detail: 'source_path and model_id are required' })
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey) return res.status(400).json({ detail: 'Add a Gateway key first.' })
    const model = (await listChatModels(apiKey)).find(item => item.id === modelId && eligibleThumbnailVisionModel(item))
    if (!model) return res.status(422).json({ detail: 'Select a currently available vision model that supports structured JSON output.' })
    const mime = imageMime(sourcePath)
    if (!mime) {
      return res.status(422).json({ detail: `Story Studio cannot send ${path.extname(sourcePath) || 'that file type'} to a model. Use a PNG, JPEG, WebP or GIF.` })
    }
    // A published list is enforced. An *unpublished* one is not a refusal —
    // absence is not "it accepts nothing" — so the file goes and the gateway's
    // own upload rules answer for it.
    if (model.accepted_image_mime_types.length && !model.accepted_image_mime_types.includes(mime)) {
      return res.status(422).json({ detail: `This model accepts ${model.accepted_image_mime_types.join(', ')}, not this file type.` })
    }
    // CONTAINMENT. `source_path` comes straight from the request body. Before
    // this the only gate was the image extension, so any image on the machine
    // could be read AND UPLOADED to GenStudio — a read-and-exfiltrate
    // primitive, not just a read. Same rule as the preview routes: the Library
    // and media folders the owner configured. See `lib/preview-roots.ts`.
    if (!await isPreviewablePath(sourcePath, slug)) {
      return res.status(403).json({
        detail: 'That file is outside this project. Reference images must come from your Library or a media folder you configured.',
      })
    }
    const bytes = await fs.readFile(sourcePath)
    if (!bytes.length) return res.status(422).json({ detail: 'Reference image is empty.' })
    if (model.max_image_bytes > 0 && bytes.length > model.max_image_bytes) {
      return res.status(422).json({ detail: `Reference image exceeds this model’s ${(model.max_image_bytes / 1024 / 1024).toFixed(1)} MB limit.` })
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const dir = thumbnailReferenceDir(slug)
    await fs.mkdir(dir, { recursive: true })
    const extension = path.extname(sourcePath).toLowerCase()
    const id = `thumbref-${randomUUID()}`
    const storedPath = path.join(dir, `${id}${extension}`)
    await fs.copyFile(sourcePath, storedPath)
    const remote = await uploadImageSourceWithGenStudio(apiKey, storedPath)
    if (model.max_image_dimension > 0 && Math.max(remote.width, remote.height) > model.max_image_dimension) {
      await fs.rm(storedPath, { force: true })
      return res.status(422).json({ detail: `Reference image exceeds this model’s ${model.max_image_dimension}px dimension limit.` })
    }
    const result = await callChatWithGenStudio(apiKey, {
      modelId: model.id,
      system: 'You are a thumbnail composition analyst. Analyse visual composition, hierarchy, framing, text placement, palette, lighting, and style cues. Do not identify or imitate brands, logos, or copyrighted characters. Return only one JSON object.',
      userMessage: 'Analyse this thumbnail as a reusable composition reference. Return exactly this JSON object: {"composition_summary":"","aspect_ratio":"","primary_subject":"","subject_placement":"","visual_hierarchy":[],"title_text_placement":"","palette":[],"lighting":"","style_cues":[],"must_preserve":[],"avoid":[],"reframing_prompt":""}. The reframing_prompt must describe the composition without naming the original work, brand, or creator.',
      // No `topP`: Story Studio never had a top_p value anyone chose. The
      // client no longer sends the field at all — see `GenStudioChatRequest`.
      // `outputContract` is the one mechanism. The deprecated `jsonObject`
      // flag this call used still maps to the same contract internally, which
      // is exactly why it was easy to leave behind.
      temperature: 0.2, maxOutputTokens: 1200, outputContract: JSON_OBJECT_OUTPUT_CONTRACT,
      // The detail level this model states, or Story's own when it states none
      // — `detail_source` in the menu says which, so the choice is never
      // presented as the model's own.
      inputImage: { assetId: remote.id, detail: detailFor(model).detail },
      requestIdentity: `thumbnail-reference:${slug}:${sha256}:${model.id}`,
    })
    const analysis = parseComposition(result.text)
    const reframingPrompt = typeof analysis.reframing_prompt === 'string' ? analysis.reframing_prompt.trim() : ''
    if (!reframingPrompt) throw new Error('Vision analysis is missing reframing_prompt.')
    const reference = {
      id, filename: path.basename(storedPath), sha256, mime_type: mime, size_bytes: bytes.length,
      width: remote.width, height: remote.height, analysis, reframing_prompt: reframingPrompt,
      analysis_model_id: model.id, analysis_model_name: model.display_name, analyzed_at: new Date().toISOString(),
    }
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(reference, null, 2), 'utf8')
    // The active channel reference is intentionally project-owned. Prompt and
    // image-generator presets may carry the same record, while Pipeline can
    // still resolve this durable fallback after a restart.
    await pm.updateConfig(slug, { thumbnail_reference_asset: reference } as any)
    res.json({ reference, analysis_job_id: result.jobId })
  } catch (error: any) {
    res.status(502).json({ detail: error?.message || 'Thumbnail reference analysis failed.' })
  }
})

router.post('/projects/:slug/analyze-style', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const imagePath = typeof req.body?.image_path === 'string' ? req.body.image_path.trim() : ''
  if (!imagePath) {
    return res.status(400).json({ detail: 'image_path is required' })
  }
  return res.status(501).json({ code: 'GENSTUDIO_CAPABILITY_UNAVAILABLE', detail: GENSTUDIO_VISION_UNAVAILABLE })
})

// Same vision pipeline as /analyze-style but with a CHARACTER-focused
// prompt — extracts the subject's appearance (species, anatomy, colour
// markings, clothing) so the user can bootstrap a rigid character
// description from a reference portrait instead of typing it from scratch.
// Frontend wires this to a "✨ Describe from image" button on each
// uploaded reference inside the character editor.
router.post('/projects/:slug/analyze-character', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const imagePath = typeof req.body?.image_path === 'string' ? req.body.image_path.trim() : ''
  if (!imagePath) {
    return res.status(400).json({ detail: 'image_path is required' })
  }
  return res.status(501).json({ code: 'GENSTUDIO_CAPABILITY_UNAVAILABLE', detail: GENSTUDIO_VISION_UNAVAILABLE })
})

/**
 * Frontend uses this to hide the feature until GenStudio publishes it.
 */
router.get('/projects/:slug/vision/caps', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  res.json({
    available: false,
    models: [],
    default: '',
    detail: GENSTUDIO_VISION_UNAVAILABLE,
  })
})
