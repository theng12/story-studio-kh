/**
 * Image-edit routes — natural-language image editing via Gemini 2.5 Flash
 * Image or OpenAI gpt-image-1.
 *
 *   GET  /projects/:slug/image-edit/caps    → which models are usable (have keys)
 *   POST /projects/:slug/edit-image         → run an edit
 *
 * File handling is opinionated: the edited output always lands as
 * `{base}_edited_v{N}.png` in the same folder as the source. "Replace
 * original" moves the source to `{base}_pre-edit_{ts}.{ext}` first, then
 * renames the edited version to the original filename. The original is
 * never destroyed — the user can always rename the backup back.
 */
import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import {
  editImage,
  imageEditModelInfo,
  nextEditedVersionPath,
  stashOriginal,
  IMAGE_EDIT_MODELS,
  type ImageEditModel,
} from '../lib/image-edit-client.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

function keyFor(config: any, model: ImageEditModel): {
  apiKey: string
  provider: 'google' | 'openai' | 'kie' | 'fal'
} {
  const info = imageEditModelInfo(model)
  if (!info) return { apiKey: '', provider: 'google' }
  switch (info.provider) {
    case 'google': return { apiKey: (config.google_api_key   || '').trim(), provider: 'google' }
    case 'openai': return { apiKey: (config.openai_api_key   || '').trim(), provider: 'openai' }
    case 'kie':    return { apiKey: (config.kie_api_key      || '').trim(), provider: 'kie' }
    case 'fal':    return { apiKey: (config.fal_api_key      || '').trim(), provider: 'fal' }
  }
}

router.get('/projects/:slug/image-edit/caps', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const hasKey: Record<string, boolean> = {
    google: !!config.google_api_key,
    openai: !!config.openai_api_key,
    kie:    !!config.kie_api_key,
    fal:    !!config.fal_api_key,
  }

  const models = IMAGE_EDIT_MODELS.map(m => ({
    id: m.id,
    provider: m.provider,
    label: m.label,
    flat_cost_usd: m.flatCostUsd,
    supports_mask: !!m.supportsMask,
    has_key: hasKey[m.provider],
  }))
  res.json({
    models,
    // Pick the first model with a key as the UI default. Falling back to
    // Gemini matches the prior behaviour for users with only a Google key
    // configured.
    default: models.find(m => m.has_key)?.id || 'gemini-2.5-flash-image',
  })
})

router.post('/projects/:slug/edit-image', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const imagePath = typeof req.body?.image_path === 'string' ? req.body.image_path.trim() : ''
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : 'gemini-2.5-flash-image'
  const replaceOriginal = req.body?.replace_original === true
  // Optional mask from BrushCanvas. May arrive as a `data:image/png;base64,...`
  // URL or just the bare base64 chunk; both are accepted by `editImage`.
  // Empty/whitespace strings are treated as "no mask" so the prompt-only
  // path is used.
  const maskB64Raw = typeof req.body?.mask_b64 === 'string' ? req.body.mask_b64.trim() : ''
  const maskB64 = maskB64Raw.length > 0 ? maskB64Raw : undefined

  if (!imagePath) return res.status(400).json({ detail: 'image_path is required' })
  if (!prompt) return res.status(400).json({ detail: 'prompt is required' })
  if (!path.isAbsolute(imagePath)) {
    return res.status(400).json({ detail: 'image_path must be an absolute path' })
  }

  const modelInfo = imageEditModelInfo(requestedModel)
  if (!modelInfo) return res.status(400).json({ detail: `Unknown image-edit model: ${requestedModel}` })

  const { apiKey, provider } = keyFor(config, modelInfo.id)
  if (!apiKey) {
    const label = provider === 'google' ? 'Google AI Studio'
      : provider === 'openai' ? 'OpenAI'
      : provider === 'kie'    ? 'kie.ai'
      : provider === 'fal'    ? 'fal.ai'
      : provider
    return res.status(400).json({
      detail: `No ${label} API key configured. Add one in Settings → API Keys, or pick a different model.`,
    })
  }

  try {
    const { imageBytes, model_used } = await editImage({ imagePath, prompt, model: modelInfo.id, apiKey, maskB64 })

    const outputPath = await nextEditedVersionPath(imagePath)
    await fs.writeFile(outputPath, imageBytes)

    let finalPath = outputPath
    let backupPath: string | null = null
    if (replaceOriginal) {
      backupPath = await stashOriginal(imagePath)
      await fs.rename(outputPath, imagePath)
      finalPath = imagePath
    }

    res.json({
      output_path: finalPath,
      model_used,
      replaced_original: replaceOriginal,
      backup_path: backupPath,
    })
  } catch (e: any) {
    console.warn('[image-edit] failed:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'Image edit failed'))
  }
})
