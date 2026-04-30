/**
 * Voice catalog routes — drives the voice picker.
 *
 *   GET  /projects/:slug/voices/catalog        → merged live/cache/snapshot catalog
 *   POST /projects/:slug/voices/refresh        → force live fetch + update cache
 *   POST /projects/:slug/voices/probe          → { voice_id } → { available: bool }
 *   GET  /projects/:slug/voices/favourites     → { voice_ids: [] }  per-MACHINE
 *   PUT  /projects/:slug/voices/favourites     → { voice_ids: [] }  replace list
 *
 * The slug in the favourites paths is now ceremonial — favourites moved
 * to app-settings.json (per-machine) so they don't have to be re-curated
 * for every new channel. Catalog cache and favourites both live alongside
 * app-settings.json. The slug-bearing paths remain for frontend
 * compat — the value is the same regardless of which slug is passed.
 */
import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { resolveCatalog, fetchAndCache, loadCache } from '../services/voices-cache.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  getVoiceFavouritesGlobal, setVoiceFavouritesGlobal,
} from '../services/app-settings.js'

export const router = Router()

function getElevenLabsKey(config: any): string | undefined {
  const k = config?.elevenlabs_api_key
  return typeof k === 'string' && k.trim() ? k.trim() : undefined
}

router.get('/projects/:slug/voices/catalog', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const apiKey = getElevenLabsKey(config)
  try {
    const result = await resolveCatalog(apiKey, { language: 'en' })
    // Include has_elevenlabs_key so the picker can render an actionable
    // "Add your key to unlock 100+ voices" banner when the snapshot path
    // was used — users otherwise wonder why they only see 2 voices.
    res.json({ ...result, has_elevenlabs_key: !!apiKey })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to resolve voice catalog'))
  }
})

router.post('/projects/:slug/voices/refresh', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const apiKey = getElevenLabsKey(config)
  if (!apiKey) {
    return res.status(400).json({ detail: 'Add your ElevenLabs API key in Settings before refreshing the voice catalog.' })
  }
  try {
    const fresh = await fetchAndCache(apiKey, { language: 'en' })
    res.json({
      source: 'live',
      fetched_at: fresh.fetched_at,
      voices: fresh.voices,
    })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Voice refresh failed'))
  }
})

router.post('/projects/:slug/voices/probe', async (req, res) => {
  const voiceId = typeof req.body?.voice_id === 'string' ? req.body.voice_id.trim() : ''
  if (!voiceId) return res.status(400).json({ detail: 'voice_id required' })
  const cache = await loadCache()
  if (!cache) return res.json({ available: null, reason: 'no-cache' })
  const found = cache.voices.some(v => v.voice_id === voiceId)
  res.json({ available: found, fetched_at: cache.fetched_at })
})

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
