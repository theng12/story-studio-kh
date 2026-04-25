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
  const model = resolveVisionModel(requestedModel)
  const { apiKey, provider } = keyForModel(config, model)
  if (!apiKey) {
    const label = provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : 'vision provider'
    return res.status(400).json({
      detail: `No ${label} API key configured. Add one in Settings → API Keys, or pick a different vision model.`,
    })
  }

  try {
    const result = await analyzeStyle({ imagePath, model, apiKey, focus: focus || null })
    res.json(result)
  } catch (e: any) {
    console.warn('[vision/analyze-style] failed:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'Style analysis failed'))
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
