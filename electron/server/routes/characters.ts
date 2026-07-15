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
import { existsSync } from 'fs'
import * as cm from '../services/character-manager.js'
import * as cl from '../services/character-library.js'
import * as pm from '../services/project-manager.js'
import { analyzeStyle, visionKeyAvailable } from '../lib/vision-client.js'
import { respondWithError, humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.get('/projects/:slug/characters', async (req, res) => {
  try {
    await cl.ensureProjectCharactersMigrated(req.params.slug)
    const episodeCode = typeof req.query.episode_code === 'string' ? req.query.episode_code : undefined
    res.json(await cm.listCharacters(req.params.slug, { episodeCode }))
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list characters')
  }
})

router.get('/projects/:slug/characters/:id', async (req, res) => {
  try {
    const c = await cm.getCharacter(req.params.slug, req.params.id)
    if (!c) return res.status(404).json({ detail: 'Character not found' })
    res.json(c)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to load character')
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
    const created = await cl.createLibraryCharacter({ ...body, scope: 'project', episode_codes: undefined, projects: [req.params.slug] })
    res.status(201).json(created)
  } catch (e: any) {
    // character-manager throws with .status set on validation/conflict
    // errors; respondWithError honours .statusCode so we mirror via a
    // small fallback to keep the existing 4xx mapping for `.status`.
    if (typeof (e as any)?.status === 'number' && !(e as any)?.statusCode) {
      ;(e as any).statusCode = (e as any).status
    }
    respondWithError(res, e, 'Failed to save character')
  }
})

router.put('/projects/:slug/characters/:id', async (req, res) => {
  try {
    const library = await cl.getLibraryCharacter(req.params.id)
    const updated = library && library.projects?.includes(req.params.slug)
      ? await cl.updateLibraryCharacter(req.params.id, req.body || {})
      : await cm.updateCharacter(req.params.slug, req.params.id, req.body || {})
    if (!updated) return res.status(404).json({ detail: 'Character not found' })
    res.json(updated)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update character')
  }
})

router.put('/projects/:slug/characters/:id/promote', async (req, res) => {
  try {
    const library = await cl.getLibraryCharacter(req.params.id)
    const updated = library && library.projects?.includes(req.params.slug)
      ? cl.resolveForChannel(library, req.params.slug)
      : await cm.promoteToProject(req.params.slug, req.params.id)
    if (!updated) return res.status(404).json({ detail: 'Character not found' })
    res.json(updated)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to promote character')
  }
})

router.delete('/projects/:slug/characters/:id', async (req, res) => {
  try {
    const library = await cl.getLibraryCharacter(req.params.id)
    const ok = library && library.projects?.includes(req.params.slug)
      ? !!(await cl.unassignFromProject(req.params.id, req.params.slug))
      : await cm.deleteCharacter(req.params.slug, req.params.id)
    if (!ok) return res.status(404).json({ detail: 'Character not found' })
    res.json({ ok: true, id: req.params.id })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to delete character')
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

// Serve a character's reference image file. Used by the editor's per-image
// preview thumbnails so users see WHAT they uploaded instead of a filename
// only. Defensive: limits to files actually registered on the character,
// never reads arbitrary paths off the body.
router.get('/projects/:slug/characters/:id/reference-image/:filename', async (req, res) => {
  try {
    const { slug, id, filename } = req.params
    const character = await cm.getCharacter(slug, id)
    if (!character) return res.status(404).json({ detail: `Character '${id}' not found` })
    const images = character.references?.images || []
    if (!images.includes(filename)) {
      return res.status(404).json({ detail: `Reference image '${filename}' not registered on character '${id}'` })
    }
    const abs = cm.referenceImagePath(slug, id, filename)
    if (!existsSync(abs)) return res.status(404).json({ detail: `Reference image file missing on disk: ${filename}` })
    res.sendFile(abs)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not serve reference image'))
  }
})

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
    const library = await cl.getLibraryCharacter(req.params.id)
    const result = library && library.projects?.includes(req.params.slug)
      ? await cl.addLibraryReferenceImage(req.params.id, buf, filename)
      : await cm.addReferenceImage(req.params.slug, req.params.id, buf, filename)
    res.json({ ok: true, relativePath: result.relativePath })
  } catch (e: any) {
    const status = e?.message?.includes('not found') ? 404 : 500
    res.status(status).json({ detail: e.message })
  }
})

// Vision-LLM bootstrap: given an already-uploaded reference image filename
// for a character, run a CHARACTER-focused vision pass and return a rigid
// appearance description ready to drop into the character's description
// field. Lets users skip typing the description from scratch — upload a
// portrait, click "✨ Describe from image", review, save. The single biggest
// continuity lever for image gen (per-scene prompts then reuse the same
// description verbatim, so the model gets the same words every render).
router.post('/projects/:slug/characters/:id/describe-from-image', async (req, res) => {
  const { slug, id } = req.params
  try {
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project not found' })

    const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : ''
    if (!filename) return res.status(400).json({ detail: 'filename is required' })

    // Sanity-check the file belongs to this character + actually exists on
    // disk. Without this guard a maliciously-crafted body could feed any
    // path into the vision call.
    const character = await cm.getCharacter(slug, id)
    if (!character) return res.status(404).json({ detail: `Character '${id}' not found` })
    const images = character.references?.images || []
    if (!images.includes(filename)) {
      return res.status(404).json({ detail: `Reference image '${filename}' not registered on character '${id}'` })
    }
    const imagePath = cm.referenceImagePath(slug, id, filename)
    if (!existsSync(imagePath)) {
      return res.status(404).json({ detail: `Reference image file missing on disk: ${filename}` })
    }

    // Vision auto-routes (kie.ai Claude → GPT-4o fallback) inside
    // analyzeStyle; we only confirm SOME vision key exists for a clean 400.
    if (!(await visionKeyAvailable())) {
      return res.status(400).json({
        detail: 'No vision-capable API key configured. Add a kie.ai OR OpenAI key in Settings → API Keys to use "Describe from image".',
      })
    }

    const focus = typeof req.body?.focus === 'string' ? req.body.focus.trim() : ''
    const result = await analyzeStyle({
      imagePath, focus: focus || null, mode: 'character',
    })
    if (result.style_text === 'NO_CLEAR_SUBJECT') {
      return res.status(422).json({
        detail: 'The vision model could not identify a clear subject in this image. Try a portrait-style image with a single, clearly-framed subject.',
      })
    }
    res.json({ description: result.style_text, model_used: result.model_used })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Character description failed'))
  }
})
