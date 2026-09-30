import { Router } from 'express'

import { respondWithError } from '../lib/humanize-backend-error.js'
import {
  getMediaCleanupOperation,
  listMediaCleanupEpisodes,
  startMediaCleanupPreview,
  startMediaCleanupRun,
  stopMediaCleanupOperation,
} from '../services/episode-media-cleanup.js'

export const router = Router()

router.get('/projects/:slug/media-cleanup/episodes', async (req, res) => {
  try {
    res.json(await listMediaCleanupEpisodes(req.params.slug))
  } catch (error) {
    respondWithError(res, error, 'Could not list uploaded episodes for cleanup')
  }
})

router.post('/projects/:slug/media-cleanup/preview', async (req, res) => {
  try {
    const started = await startMediaCleanupPreview(req.params.slug, {
      episode_codes: req.body?.episode_codes,
      categories: req.body?.categories,
      preset: req.body?.preset,
    })
    res.status(202).json(started)
  } catch (error) {
    respondWithError(res, error, 'Could not start the media cleanup check')
  }
})

router.post('/projects/:slug/media-cleanup/run', async (req, res) => {
  try {
    const started = await startMediaCleanupRun(req.params.slug, {
      preview_id: req.body?.preview_id,
      mode: req.body?.mode,
      destination: req.body?.destination,
    })
    res.status(202).json(started)
  } catch (error) {
    respondWithError(res, error, 'Could not start media cleanup')
  }
})

router.get('/projects/:slug/media-cleanup/operations/:id', (req, res) => {
  const operation = getMediaCleanupOperation(req.params.slug, req.params.id)
  if (!operation) return res.status(404).json({ detail: 'Media cleanup operation not found' })
  res.json(operation)
})

router.post('/projects/:slug/media-cleanup/operations/:id/stop', (req, res) => {
  const operation = stopMediaCleanupOperation(req.params.slug, req.params.id)
  if (!operation) return res.status(404).json({ detail: 'Media cleanup operation not found' })
  res.json({ operation_id: operation.id, status: operation.status })
})
