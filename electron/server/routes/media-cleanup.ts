import { Router } from 'express'

import { respondWithError } from '../lib/humanize-backend-error.js'
import {
  getMediaCleanupOperation,
  listMediaCleanupEpisodes,
  startMediaCleanupPreview,
  startMediaCleanupRun,
  stopMediaCleanupOperation,
} from '../services/episode-media-cleanup.js'
import { listStorageLeftovers, trashStorageLeftovers } from '../services/storage-leftovers.js'
import { storageSpaceSummary } from '../services/storage-audit.js'

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

/** Free disk and `_trash` sizes (project and Library), shown at the top of Free up space. */
router.get('/projects/:slug/media-cleanup/space', async (req, res) => {
  try {
    res.json(await storageSpaceSummary(req.params.slug))
  } catch (error) {
    respondWithError(res, error, 'Could not measure free space')
  }
})

/** Audio-quality copies and failed-render scratch, offered for `_trash`. */
router.get('/projects/:slug/media-cleanup/leftovers', async (req, res) => {
  try {
    res.json({ leftovers: await listStorageLeftovers(req.params.slug) })
  } catch (error) {
    respondWithError(res, error, 'Could not list leftover files')
  }
})

router.post('/projects/:slug/media-cleanup/leftovers/trash', async (req, res) => {
  try {
    res.json(await trashStorageLeftovers(req.params.slug, req.body?.paths))
  } catch (error) {
    respondWithError(res, error, 'Could not move leftover files to _trash')
  }
})
