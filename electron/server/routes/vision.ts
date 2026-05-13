/**
 * Vision routes — reference-image analysis for the image-prompts page.
 *
 *   POST /projects/:slug/analyze-style  →  extract style description
 *   GET  /projects/:slug/vision/caps    →  which vision models are usable
 *
 * The heavy lifting (downscale + SDK dispatch + prompt) lives in
 * lib/vision-client.ts; this file is thin glue.
 */
import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { analyzeStyle, resolveVisionModel, VISION_CAPABLE_MODELS } from '../lib/vision-client.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

function keyForModel(config: any, model: string): { apiKey: string; provider: 'anthropic' | 'openai' | null } {
  if (model.startsWith('claude')) {
    return { apiKey: config.anthropic_api_key || '', provider: 'anthropic' }
  }
  if (model.startsWith('gpt')) {
    return { apiKey: config.openai_api_key || '', provider: 'openai' }
  }
  return { apiKey: '', provider: null }
}

/**
 * Auto-pick a vision-capable model the user has the key for. Mirrors the
 * fallback logic in routes/characters.ts:describe-from-image so users who
 * only have an OpenAI key still get vision features without manual model
 * picking. Honours an explicit `requested` model only if its key exists.
 */
function pickVisionModel(config: any, requested: string): { model: string; apiKey: string } | null {
  if (requested) {
    const resolved = resolveVisionModel(requested)
    const { apiKey } = keyForModel(config, resolved)
    if (apiKey) return { model: resolved, apiKey }
  }
  if (config.anthropic_api_key) return { model: 'claude-sonnet-4-6', apiKey: config.anthropic_api_key }
  if (config.openai_api_key)    return { model: 'gpt-4o',            apiKey: config.openai_api_key }
  return null
}

router.post('/projects/:slug/analyze-style', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const imagePath = typeof req.body?.image_path === 'string' ? req.body.image_path.trim() : ''
  if (!imagePath) {
    return res.status(400).json({ detail: 'image_path is required' })
  }
  const focus = typeof req.body?.focus === 'string' ? req.body.focus.trim() : ''
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const picked = pickVisionModel(config, requestedModel)
  if (!picked) {
    return res.status(400).json({
      detail: 'No vision-capable API key configured. Add an Anthropic OR OpenAI key in Settings → API Keys to use style extraction.',
    })
  }

  try {
    const result = await analyzeStyle({ imagePath, model: picked.model, apiKey: picked.apiKey, focus: focus || null })
    res.json(result)
  } catch (e: any) {
    console.warn('[vision/analyze-style] failed:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'Style analysis failed'))
  }
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
  const focus = typeof req.body?.focus === 'string' ? req.body.focus.trim() : ''
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const picked = pickVisionModel(config, requestedModel)
  if (!picked) {
    return res.status(400).json({
      detail: 'No vision-capable API key configured. Add an Anthropic OR OpenAI key in Settings → API Keys to use character description.',
    })
  }

  try {
    const result = await analyzeStyle({ imagePath, model: picked.model, apiKey: picked.apiKey, focus: focus || null, mode: 'character' })
    if (result.style_text === 'NO_CLEAR_SUBJECT') {
      return res.status(422).json({
        detail: 'The vision model could not identify a clear subject in this image. Try a portrait-style image with a single, clearly-framed subject.',
      })
    }
    // Return under the same `style_text` field the style route uses so the
    // frontend can share its rendering — but rename for the consumer.
    res.json({ description: result.style_text, model_used: result.model_used })
  } catch (e: any) {
    console.warn('[vision/analyze-character] failed:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'Character description failed'))
  }
})

/**
 * Frontend uses this to (a) know which vision models to show in the picker
 * and (b) grey out ones the user doesn't have a key for.
 */
router.get('/projects/:slug/vision/caps', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const hasAnthropic = !!config.anthropic_api_key
  const hasOpenAi = !!config.openai_api_key

  const models = Array.from(VISION_CAPABLE_MODELS).map(id => {
    const provider: 'anthropic' | 'openai' | 'unknown' =
      id.startsWith('claude') ? 'anthropic' : id.startsWith('gpt') ? 'openai' : 'unknown'
    const hasKey = provider === 'anthropic' ? hasAnthropic : provider === 'openai' ? hasOpenAi : false
    return { id, provider, has_key: hasKey }
  })
  res.json({
    models,
    default: 'claude-sonnet-4-6',
  })
})
