/**
 * Character library routes.
 *
 * Channel Canonical: GET/POST/PUT/DELETE /api/projects/:slug/characters*.
 * The global routes here are READ-ONLY legacy access plus migration control.
 * They never mutate a legacy record.
 *
 *   GET    /api/character-library                 → legacy flat (read-only)
 *   GET    /api/character-library?channel=<slug>  → one channel's owned records
 *   GET    /api/character-library/:id             → one legacy record
 *   GET    /api/character-library/:id?channel=…   → one channel-owned record
 *   GET    /api/character-library/:id/reference-image/:filename[?channel=…]
 *   POST   /api/character-library/:id/...         → 409 read-only (use project routes)
 *   GET    /api/character-library/channel-migration/preview
 *   POST   /api/character-library/channel-migration/apply
 *   POST   /api/character-library/channel-migration/undo  { run_id }
 */

import { Router } from 'express'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import * as cl from '../services/character-library.js'

export const router = Router()

const LEGACY_READ_ONLY = 'Legacy channel characters are read-only. Use /api/projects/:slug/characters after migrating the channel library.'

function channelQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

router.get('/character-library/channel-migration/preview', async (_req, res) => {
  try { res.json(await cl.previewChannelMigration()) }
  catch (e: any) { res.status(500).json({ detail: e.message }) }
})

router.post('/character-library/channel-migration/apply', async (_req, res) => {
  try { res.json(await cl.applyChannelMigration()) }
  catch (e: any) { res.status(500).json({ detail: e.message }) }
})

router.post('/character-library/channel-migration/undo', async (req, res) => {
  try {
    const runId = typeof req.body?.run_id === 'string' ? req.body.run_id : ''
    if (!runId) return res.status(400).json({ detail: 'run_id is required' })
    res.json(await cl.undoChannelMigration(runId))
  } catch (e: any) { res.status(500).json({ detail: e.message }) }
})

router.get('/character-library', async (req, res) => {
  try {
    const channel = channelQuery(req.query.channel)
    res.json(channel ? await cl.listChannelCharacters(channel) : await cl.listLibrary())
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to list character library: ${e.message}` })
  }
})

router.get('/character-library/:id', async (req, res) => {
  try {
    const channel = channelQuery(req.query.channel)
    const c = channel
      ? await cl.getChannelCharacter(channel, req.params.id)
      : await cl.getLibraryCharacter(req.params.id)
    if (!c) return res.status(404).json({ detail: 'Library character not found' })
    res.json(c)
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

router.post('/character-library', (_req, res) => res.status(409).json({ detail: LEGACY_READ_ONLY }))
router.put('/character-library/:id', (_req, res) => res.status(409).json({ detail: LEGACY_READ_ONLY }))
router.delete('/character-library/:id', (_req, res) => res.status(409).json({ detail: LEGACY_READ_ONLY }))

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

router.get('/character-library/:id/reference-image/:filename', async (req, res) => {
  try {
    const filename = req.params.filename
    // A reference image is always a bare filename. This rejects every path
    // form whatever the stored images list says.
    if (path.basename(filename) !== filename) {
      return res.status(404).json({ detail: 'Reference image not found' })
    }
    const channel = channelQuery(req.query.channel)
    const character = channel
      ? await cl.getChannelCharacter(channel, req.params.id)
      : await cl.getLibraryCharacter(req.params.id)
    if (!character || !character.references?.images?.includes(filename)) {
      return res.status(404).json({ detail: 'Reference image not found' })
    }
    const file = channel
      ? path.join(cl.channelCharacterDir(channel, req.params.id), filename)
      : path.join(cl.legacyLibraryCharacterDir(req.params.id), filename)
    if (!existsSync(file)) return res.status(404).json({ detail: 'Reference image file missing on disk' })
    const image = await readFile(file)
    res.set('Cache-Control', 'private, max-age=3600')
    res.type(filename).send(image)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return res.status(404).json({ detail: 'Reference image file missing on disk' })
    res.status(500).json({ detail: e.message })
  }
})

router.post('/character-library/:id/reference-image', (_req, res) => res.status(409).json({ detail: LEGACY_READ_ONLY }))
router.delete('/character-library/:id/reference-image/:filename', (_req, res) => res.status(409).json({ detail: LEGACY_READ_ONLY }))
