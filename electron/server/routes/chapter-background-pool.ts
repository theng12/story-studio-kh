import { Router } from 'express'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  getChapterBackgroundPoolState,
  resetChapterBackgroundCursor,
  resolveChapterBackground,
  updateChapterBackgroundPool,
} from '../services/chapter-background-pool.js'
import {
  ChapterBackgroundImportError,
  importChapterBackgroundBytes,
} from '../services/chapter-background-import.js'
import type { ChapterBackgroundItem } from '../contracts/chapter-background-pool.js'

export const router = Router()

router.use('/projects/:slug/chapter-background-pool', (req, res, next) => {
  if (typeof req.params.slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(req.params.slug)) {
    return res.status(400).json({ detail: 'Invalid channel identifier.' })
  }
  next()
})

router.get('/projects/:slug/chapter-background-pool', async (req, res) => {
  try {
    res.json(await getChapterBackgroundPoolState(req.params.slug))
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not load chapter backgrounds'))
  }
})

router.patch('/projects/:slug/chapter-background-pool', async (req, res) => {
  const items = req.body?.items
  if (!Array.isArray(items) || items.some(item => !item || typeof item.id !== 'string'
    || !item.id.trim() || typeof item.name !== 'string' || typeof item.reference !== 'string'
    || !item.reference.trim() || typeof item.enabled !== 'boolean')
    || new Set(items.map(item => item.id.trim())).size !== items.length) {
    return res.status(400).json({ detail: 'Provide distinct chapter backgrounds with id, name, reference and enabled fields.' })
  }
  try {
    // Validate every reference before replacing the saved pool, including disabled entries.
    for (const item of items as ChapterBackgroundItem[]) {
      await resolveChapterBackground(req.params.slug, item.reference)
    }
    await updateChapterBackgroundPool(req.params.slug, items)
    res.json(await getChapterBackgroundPoolState(req.params.slug))
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not save chapter backgrounds'))
  }
})

router.post('/projects/:slug/chapter-background-pool/reset-cursor', async (req, res) => {
  try {
    await resetChapterBackgroundCursor(req.params.slug)
    res.json(await getChapterBackgroundPoolState(req.params.slug))
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not reset chapter background rotation'))
  }
})

/**
 * Import ONE chapter-background image's bytes into this channel's own
 * `backgrounds/` folder. Same base64 body pattern as the channel-profile art
 * upload, so it rides the existing 10 MB JSON parser and the same strict
 * decode/format/size/full-decode validation. The caller's filename is display
 * only. Returns the canonical `${CHANNEL}/backgrounds/<file>` reference the
 * PATCH above accepts; it writes no config, pool or cursor (the caller PATCHes).
 */
router.post('/projects/:slug/chapter-background-pool/import', async (req, res) => {
  try {
    const imported = await importChapterBackgroundBytes(req.params.slug, req.body?.data_base64)
    res.status(201).json(imported)
  } catch (error: any) {
    // Both this route's own errors and the reused strict-base64 decoder carry
    // the status they answer with; anything else is a genuine 500.
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
      ? error.status
      : (error instanceof ChapterBackgroundImportError ? error.status : 500)
    res.status(status).json(humanizeBackendError(error, 'Could not import that chapter background'))
  }
})
