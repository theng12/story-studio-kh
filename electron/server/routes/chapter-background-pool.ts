import { Router } from 'express'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  getChapterBackgroundPoolState,
  resetChapterBackgroundCursor,
  resolveChapterBackground,
  updateChapterBackgroundPool,
} from '../services/chapter-background-pool.js'
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
