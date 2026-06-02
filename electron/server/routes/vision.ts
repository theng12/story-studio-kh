/**
 * Vision routes — reference-image analysis for the image-prompts page.
 *
 *   POST /projects/:slug/analyze-style      →  extract style description
 *   POST /projects/:slug/analyze-character  →  describe subject from image
 *   GET  /projects/:slug/vision/caps        →  whether vision is usable
 *
 * The heavy lifting (downscale + provider chain + prompt) lives in
 * lib/vision-client.ts; this file is thin glue. As of v1.0.235 vision
 * resolves its own key/model internally (kie.ai Claude → GPT-4o fallback),
 * so routes no longer pass a model or key — they only pre-check that SOME
 * vision key exists for a clean 400.
 */
import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { analyzeStyle, visionKeyAvailable } from '../lib/vision-client.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.post('/projects/:slug/analyze-style', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const imagePath = typeof req.body?.image_path === 'string' ? req.body.image_path.trim() : ''
  if (!imagePath) {
    return res.status(400).json({ detail: 'image_path is required' })
  }
  const focus = typeof req.body?.focus === 'string' ? req.body.focus.trim() : ''
  if (!(await visionKeyAvailable())) {
    return res.status(400).json({
      detail: 'No vision-capable API key configured. Add a kie.ai OR OpenAI key in Settings → API Keys to use style extraction.',
    })
  }

  try {
    const result = await analyzeStyle({ imagePath, focus: focus || null })
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
  if (!(await visionKeyAvailable())) {
    return res.status(400).json({
      detail: 'No vision-capable API key configured. Add a kie.ai OR OpenAI key in Settings → API Keys to use character description.',
    })
  }

  try {
    const result = await analyzeStyle({ imagePath, focus: focus || null, mode: 'character' })
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
 * Frontend uses this to know whether vision features are usable. Vision now
 * auto-routes (kie.ai Claude → GPT-4o), so there's no model picker — this just
 * reports availability + the effective model label.
 */
router.get('/projects/:slug/vision/caps', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const available = await visionKeyAvailable()
  res.json({
    available,
    models: [{ id: 'auto', provider: 'kie', has_key: available }],
    default: 'auto',
  })
})
