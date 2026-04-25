import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import type { JobType } from '../models/types.js'
import { validateBody } from '../lib/validate.js'
import { GenerateImagesSchema } from '../schemas/index.js'
import { getImageStatus } from '../services/asset-status.js'
import { getImagesReconcileStatus } from '../services/image-reconciler.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

// ── Status endpoint (for the per-episode integrity pill) ─────────────────
router.get('/projects/:slug/episodes/:code/image-status', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const s = await getImageStatus(req.params.slug, req.params.code)
    res.json(s)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute image status'))
  }
})

router.post('/projects/:slug/generate/images', validateBody(GenerateImagesSchema), async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(400).json({ detail: 'Project config not found' })
  // API key validation happens at generation time (provider-specific)

  const mode: string = req.body.mode || 'all'

  // Use distinct job types for scene vs thumbnail images
  let jobType: JobType
  let title: string

  if (mode === 'scenes') {
    jobType = 'scene_images'
    title = 'Scene Images'
  } else if (mode === 'thumbs') {
    jobType = 'thumb_images'
    title = 'Thumbnail Images'
  } else {
    // mode === 'all' — use legacy 'images' type for backward compatibility
    jobType = 'images'
    title = 'Images (all)'
  }

  if (jq.isDuplicate(slug, req.body.episode_id, jobType)) {
    return res.status(409).json({ detail: `${title} generation already queued/running for ${req.body.episode_id}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: jobType,
    episode_id: req.body.episode_id,
    title,
    params: req.body,
  })
  res.status(201).json(job)
})

// Quick read-only check for the Repair button — tells the UI how many
// missing images can be recovered (have a manifest entry) vs need a
// fresh generation. Cheap; safe to call on every page load.
router.get('/projects/:slug/episodes/:code/images-repair-status', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const s = await getImagesReconcileStatus(req.params.slug, req.params.code)
    res.json(s)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute repair status'))
  }
})

// Repair endpoint — runs the reconciler instead of the generator. Free
// to call: the reconciler only downloads from already-paid-for provider
// task results. Files without a stored task id come back as
// "needs_fresh_generation" so the user knows to click Generate for those.
router.post('/projects/:slug/generate/images-repair', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const episodeId: string | undefined = req.body?.episode_id
  if (!episodeId) return res.status(400).json({ detail: 'episode_id is required' })

  if (jq.isDuplicate(slug, episodeId, 'images_repair' as JobType)) {
    return res.status(409).json({ detail: `Image repair already queued/running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'images_repair' as JobType,
    episode_id: episodeId,
    title: 'Image Repair (no credits)',
    params: { episode_id: episodeId },
  })
  res.status(201).json(job)
})
