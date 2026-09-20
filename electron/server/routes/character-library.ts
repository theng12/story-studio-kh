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
 *
 *   Unified-library assignment (taggable per project):
 *   POST   /api/character-library/:id/assign/:slug    → tag char to project
 *   DELETE /api/character-library/:id/assign/:slug    → untag (reversible)
 *   GET    /api/projects/:slug/library-characters     → assigned to this project
 *   POST   /api/projects/:slug/characters/assign-from-library  { libraryId }
 */

import { Router } from 'express'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import * as cl from '../services/character-library.js'

export const router = Router()

router.get('/character-library', async (_req, res) => {
  try {
    res.json(await cl.listLibrary())
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to list character library: ${e.message}` })
  }
})

router.post('/character-library', async (req, res) => {
  try {
    const created = await cl.createLibraryCharacter(req.body || {})
    res.status(201).json(created)
  } catch (e: any) {
    res.status(e?.status || 400).json({ detail: e.message })
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

router.put('/character-library/:id/channel-profile/:slug', async (req, res) => {
  try {
    const updated = await cl.setChannelProfile(req.params.id, req.params.slug, req.body || null)
    if (!updated) return res.status(404).json({ detail: 'Channel character not found' })
    res.json(updated)
  } catch (e: any) {
    res.status(400).json({ detail: e.message })
  }
})

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

router.get('/character-library/:id/reference-image/:filename', async (req, res) => {
  try {
    const filename = req.params.filename
    // The membership check below is NOT sufficient on its own: it tests the
    // request against `character.references.images`, and `updateLibraryCharacter`
    // merges a caller-supplied `references` object verbatim — so the allow-list
    // could be made to contain the payload. `PUT .../p {"references":{"images":
    // ["../../../../etc/hosts"]}}` followed by this GET read any file on disk.
    // A reference image is always a bare filename, so requiring one closes it
    // whatever the stored list says, and an escaped separator fails this too.
    if (path.basename(filename) !== filename) {
      return res.status(404).json({ detail: 'Reference image not found' })
    }
    const character = await cl.getLibraryCharacter(req.params.id)
    if (!character || !character.references?.images?.includes(filename)) {
      return res.status(404).json({ detail: 'Reference image not found' })
    }
    const file = `${cl.libraryCharacterDir(req.params.id)}/${filename}`
    if (!existsSync(file)) return res.status(404).json({ detail: 'Reference image file missing on disk' })
    // Express sendFile can turn an otherwise readable external-library file
    // into a generic 404 in packaged builds. Reading the verified file here
    // keeps the response deterministic and preserves the actual image bytes.
    const image = await readFile(file)
    res.set('Cache-Control', 'private, max-age=3600')
    res.type(filename).send(image)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return res.status(404).json({ detail: 'Reference image file missing on disk' })
    res.status(500).json({ detail: e.message })
  }
})

router.post('/character-library/:id/reference-image', async (req, res) => {
  try {
    const { filename, data_base64 } = req.body || {}
    if (typeof filename !== 'string' || !filename.trim()) return res.status(400).json({ detail: 'filename is required' })
    if (typeof data_base64 !== 'string' || !data_base64) return res.status(400).json({ detail: 'data_base64 is required' })
    const buf = Buffer.from(data_base64, 'base64')
    if (!buf.length) return res.status(400).json({ detail: 'decoded image is empty' })
    if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ detail: 'Image is larger than 5 MB' })
    res.json({ ok: true, ...(await cl.addLibraryReferenceImage(req.params.id, buf, filename)) })
  } catch (e: any) {
    res.status(e?.message?.includes('not found') ? 404 : 500).json({ detail: e.message })
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

// ── Project assignment (unified-library model) ─────────────────────────────

router.post('/character-library/:id/assign/:slug', async (req, res) => {
  try {
    const updated = await cl.assignToProject(req.params.id, req.params.slug)
    if (!updated) return res.status(404).json({ detail: 'Library character not found' })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.delete('/character-library/:id/assign/:slug', async (req, res) => {
  try {
    const updated = await cl.unassignFromProject(req.params.id, req.params.slug)
    if (!updated) return res.status(404).json({ detail: 'Library character not found' })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.get('/projects/:slug/library-characters', async (req, res) => {
  try {
    res.json(await cl.listForProject(req.params.slug))
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

// Convenience alias so the project Characters page can assign without knowing
// the library route shape: body { libraryId }.
router.post('/projects/:slug/characters/assign-from-library', async (req, res) => {
  try {
    const libraryId = typeof req.body?.libraryId === 'string' ? req.body.libraryId.trim() : ''
    if (!libraryId) return res.status(400).json({ detail: 'libraryId is required' })
    const updated = await cl.assignToProject(libraryId, req.params.slug)
    if (!updated) return res.status(404).json({ detail: `Library character '${libraryId}' not found` })
    res.status(201).json(updated)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})
