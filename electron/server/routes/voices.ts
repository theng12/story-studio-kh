/**
 * Saved-voice favourites routes.
 *
 *   GET  /projects/:slug/voices/favourites     → { voice_ids: [] }  per-MACHINE
 *   PUT  /projects/:slug/voices/favourites     → { voice_ids: [] }  replace list
 *
 * The slug in the favourites paths is now ceremonial — favourites moved
 * to app-settings.json (per-machine) so they don't have to be re-curated
 * for every new channel. The slug-bearing paths remain for frontend
 * compat — the value is the same regardless of which slug is passed.
 */
import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  getVoiceFavouritesGlobal, setVoiceFavouritesGlobal,
} from '../services/app-settings.js'

export const router = Router()

// ── Global favourites (slug param ceremonial — list is per-machine) ───────

router.get('/projects/:slug/voices/favourites', async (req, res) => {
  // Project-existence check kept so the picker still surfaces a clean
  // 404 when the URL has a stale slug; payload itself is global.
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  const ids = await getVoiceFavouritesGlobal()
  res.json({ voice_ids: ids })
})

router.put('/projects/:slug/voices/favourites', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const input = req.body?.voice_ids
  if (!Array.isArray(input)) {
    return res.status(400).json({ detail: 'voice_ids must be an array of strings' })
  }
  const ids = input
    .filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v: string) => v.trim())

  // Dedupe while preserving order — the UI uses array position for the
  // pin order inside the Favourites section of the picker.
  const seen = new Set<string>()
  const clean: string[] = []
  for (const id of ids) {
    if (!seen.has(id)) { seen.add(id); clean.push(id) }
  }

  try {
    await setVoiceFavouritesGlobal(clean)
    res.json({ voice_ids: clean })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save favourites'))
  }
})
