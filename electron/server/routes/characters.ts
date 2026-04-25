/**
 * REST endpoints for the Character primitive (Phase 5).
 *
 *   GET    /api/projects/:slug/characters
 *          ?episode_code=EPxxx → optional filter
 *   POST   /api/projects/:slug/characters
 *          body: Partial<Character> with at least name + description
 *   PUT    /api/projects/:slug/characters/:id
 *          body: Partial<Character> patch (id / created_at / source not patchable)
 *   PUT    /api/projects/:slug/characters/:id/promote
 *          → flips scope to 'project', drops episode_codes
 *   DELETE /api/projects/:slug/characters/:id
 *   POST   /api/projects/:slug/characters/:id/reference-image
 *          multipart/form-data with field 'image'
 */

import { Router } from 'express'
import * as cm from '../services/character-manager.js'

export const router = Router()

router.get('/projects/:slug/characters', async (req, res) => {
  try {
    const episodeCode = typeof req.query.episode_code === 'string' ? req.query.episode_code : undefined
    res.json(await cm.listCharacters(req.params.slug, { episodeCode }))
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to list characters: ${e.message}` })
  }
})

router.get('/projects/:slug/characters/:id', async (req, res) => {
  try {
    const c = await cm.getCharacter(req.params.slug, req.params.id)
    if (!c) return res.status(404).json({ detail: 'Character not found' })
    res.json(c)
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to load character: ${e.message}` })
  }
})

router.post('/projects/:slug/characters', async (req, res) => {
  try {
    const body = req.body || {}
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ detail: 'name is required' })
    }
    if (!body.description || typeof body.description !== 'string' || !body.description.trim()) {
      return res.status(400).json({ detail: 'description is required' })
    }
    const created = await cm.createCharacter(req.params.slug, body)
    res.status(201).json(created)
  } catch (e: any) {
    const status = (e as any).status || 500
    res.status(status).json({ detail: e.message })
  }
})

router.put('/projects/:slug/characters/:id', async (req, res) => {
  try {
    const updated = await cm.updateCharacter(req.params.slug, req.params.id, req.body || {})
    if (!updated) return res.status(404).json({ detail: 'Character not found' })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.put('/projects/:slug/characters/:id/promote', async (req, res) => {
  try {
    const updated = await cm.promoteToProject(req.params.slug, req.params.id)
    if (!updated) return res.status(404).json({ detail: 'Character not found' })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.delete('/projects/:slug/characters/:id', async (req, res) => {
  try {
    const ok = await cm.deleteCharacter(req.params.slug, req.params.id)
    if (!ok) return res.status(404).json({ detail: 'Character not found' })
    res.json({ ok: true, id: req.params.id })
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

/**
 * Reference-image upload. The route accepts a base64-encoded payload in the
 * request body for simplicity (no multipart parser dependency added):
 *   { filename: 'aria-portrait.png', data_base64: '...' }
 *
 * Frontend reads the file via FileReader.readAsDataURL and strips the
 * "data:*;base64," prefix before posting. Cap is enforced both in the UI
 * and here (5 MB max — character refs are portraits, not full art).
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

router.post('/projects/:slug/characters/:id/reference-image', async (req, res) => {
  try {
    const { filename, data_base64 } = req.body || {}
    if (typeof filename !== 'string' || !filename.trim()) {
      return res.status(400).json({ detail: 'filename is required' })
    }
    if (typeof data_base64 !== 'string' || !data_base64) {
      return res.status(400).json({ detail: 'data_base64 is required' })
    }
    const buf = Buffer.from(data_base64, 'base64')
    if (buf.length === 0) return res.status(400).json({ detail: 'decoded image is empty' })
    if (buf.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ detail: `Image too large (${buf.length} bytes, max ${MAX_IMAGE_BYTES})` })
    }
    const result = await cm.addReferenceImage(req.params.slug, req.params.id, buf, filename)
    res.json({ ok: true, relativePath: result.relativePath })
  } catch (e: any) {
    const status = e?.message?.includes('not found') ? 404 : 500
    res.status(status).json({ detail: e.message })
  }
})
