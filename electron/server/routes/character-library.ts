/**
 * REST endpoints for the global character library (Phase 7).
 *
 *   GET    /api/character-library
 *   GET    /api/character-library/:id
 *   PUT    /api/character-library/:id  (edit a library entry in place)
 *   DELETE /api/character-library/:id
 *
 *   POST   /api/projects/:slug/characters/:id/save-to-library
 *          body: { libraryId?, overwrite? } — defaults libraryId to char id
 *
 *   POST   /api/character-library/:id/import-to/:slug
 *          body: { targetId?, scope?, episode_codes?, overwrite? }
 */

import { Router } from 'express'
import * as cl from '../services/character-library.js'

export const router = Router()

router.get('/character-library', async (_req, res) => {
  try {
    res.json(await cl.listLibrary())
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to list character library: ${e.message}` })
  }
})

router.get('/character-library/:id', async (req, res) => {
  try {
    const c = await cl.getLibraryCharacter(req.params.id)
    if (!c) return res.status(404).json({ detail: 'Library character not found' })
    res.json(c)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.put('/character-library/:id', async (req, res) => {
  try {
    const updated = await cl.updateLibraryCharacter(req.params.id, req.body || {})
    if (!updated) return res.status(404).json({ detail: 'Library character not found' })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.delete('/character-library/:id', async (req, res) => {
  try {
    const ok = await cl.deleteLibraryCharacter(req.params.id)
    if (!ok) return res.status(404).json({ detail: 'Library character not found' })
    res.json({ ok: true, id: req.params.id })
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.post('/projects/:slug/characters/:id/save-to-library', async (req, res) => {
  try {
    const saved = await cl.saveToLibrary(req.params.slug, req.params.id, req.body || {})
    res.status(201).json(saved)
  } catch (e: any) {
    const status = (e as any).status || (e?.message?.includes('not found') ? 404 : 500)
    res.status(status).json({ detail: e.message })
  }
})

router.post('/character-library/:id/import-to/:slug', async (req, res) => {
  try {
    const imported = await cl.importFromLibrary(req.params.id, req.params.slug, req.body || {})
    res.status(201).json(imported)
  } catch (e: any) {
    const status = (e as any).status || (e?.message?.includes('not found') ? 404 : 500)
    res.status(status).json({ detail: e.message })
  }
})
