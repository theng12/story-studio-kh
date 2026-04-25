/**
 * Voice catalog routes — drives the per-project voice picker.
 *
 *   GET  /projects/:slug/voices/catalog        → merged live/cache/snapshot catalog
 *   POST /projects/:slug/voices/refresh        → force live fetch + update cache
 *   POST /projects/:slug/voices/probe          → { voice_id } → { available: bool }
 *   GET  /projects/:slug/voices/favourites     → { voice_ids: [] }  per-project
 *   PUT  /projects/:slug/voices/favourites     → { voice_ids: [] }  replace list
 *
 * Cache is per-machine (see services/voices-cache.ts); favourites are
 * per-project (stored in project.json alongside voice_presets).
 */
import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { resolveCatalog, fetchAndCache, loadCache } from '../services/voices-cache.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

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

// ── Per-project favourites ─────────────────────────────────────────────────

router.get('/projects/:slug/voices/favourites', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  const ids = Array.isArray(config.voice_favourites) ? config.voice_favourites : []
  res.json({ voice_ids: ids })
})

router.put('/projects/:slug/voices/favourites', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

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
    await pm.updateConfig(slug, { voice_favourites: clean })
    res.json({ voice_ids: clean })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save favourites'))
  }
})
