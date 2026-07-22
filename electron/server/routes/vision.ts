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
import * as pm from '../services/project-manager.js'
import { GENSTUDIO_VISION_UNAVAILABLE } from '../lib/vision-client.js'

export const router = Router()

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
