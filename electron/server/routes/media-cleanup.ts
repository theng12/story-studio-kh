import { Router } from 'express'

import { respondWithError } from '../lib/humanize-backend-error.js'
import {
  getLibraryMediaCleanupOperation,
  getMediaCleanupOperation,
  listMediaCleanupEpisodes,
  startLibraryMediaCleanupPreview,
  startLibraryMediaCleanupRun,
  startMediaCleanupPreview,
  startMediaCleanupRun,
  stopLibraryMediaCleanupOperation,
  stopMediaCleanupOperation,
} from '../services/episode-media-cleanup.js'
import { listStorageLeftovers, trashStorageLeftovers } from '../services/storage-leftovers.js'
import { storageSpaceSummary } from '../services/storage-audit.js'

export const router = Router()

// ── All-channel maintenance (owner request 2026-10-17) ─────────────────────
//
// One control that shrinks scene images across every channel and one that
// clears uploaded final videos older than 7 days of production across every
// channel, instead of changing channel-by-channel. The backend enumerates the
// channels itself; the request carries only the action. These share the
// per-channel registry and its one-at-a-time global lock, so they can never
// run beside a per-channel cleanup.

router.post('/library/media-cleanup/preview', async (req, res) => {
  try {
    res.status(202).json(await startLibraryMediaCleanupPreview(req.body?.action))
  } catch (error) {
    respondWithError(res, error, 'Could not start the all-channel check')
  }
})

router.post('/library/media-cleanup/run', async (req, res) => {
  try {
    res.status(202).json(await startLibraryMediaCleanupRun({ preview_id: req.body?.preview_id }))
  } catch (error) {
    respondWithError(res, error, 'Could not start the all-channel maintenance')
  }
})

router.get('/library/media-cleanup/operations/:id', (req, res) => {
  const operation = getLibraryMediaCleanupOperation(req.params.id)
  if (!operation) return res.status(404).json({ detail: 'All-channel maintenance operation not found' })
  res.json(operation)
})

router.post('/library/media-cleanup/operations/:id/stop', (req, res) => {
  const operation = stopLibraryMediaCleanupOperation(req.params.id)
  if (!operation) return res.status(404).json({ detail: 'All-channel maintenance operation not found' })
  res.json({ operation_id: operation.id, status: operation.status })
})

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
