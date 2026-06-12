/**
 * Routes for the v1.0.107+ background-music pool.
 *
 *   GET    /api/projects/:slug/music-pool                       — full state
 *   PUT    /api/projects/:slug/music-pool                       — strategy / lookback
 *   POST   /api/projects/:slug/music-pool/tracks                — add (copy from a source path)
 *   PATCH  /api/projects/:slug/music-pool/tracks/:filename      — enabled / label
 *   DELETE /api/projects/:slug/music-pool/tracks/:filename      — remove from disk
 *   GET    /api/projects/:slug/music-pool/peek-next?episode_code=X
 *                                                                — what would the cycler pick?
 *   POST   /api/projects/:slug/music-pool/record-pick           — confirm a pick was used
 *
 * The peek/record split prevents the cursor from advancing on every
 * page open — only a confirmed merge (or explicit user action) calls
 * record-pick. The audio-merge job hooks record-pick automatically
 * when its input includes a pool-sourced track.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as mp from '../services/music-pool.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.get('/projects/:slug/music-pool', async (req, res) => {
  try {
    const state = await mp.getPoolState(req.params.slug)
    res.json(state)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load music pool'))
  }
})

router.put('/projects/:slug/music-pool', async (req, res) => {
  try {
    const body = req.body || {}
    const validStrategies = ['sequential', 'random-no-repeat', 'manual']
    if (body.strategy !== undefined && !validStrategies.includes(body.strategy)) {
      return res.status(400).json({ detail: `strategy must be one of: ${validStrategies.join(', ')}` })
    }
    if (body.lookback !== undefined) {
      const n = Number(body.lookback)
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ detail: 'lookback must be a positive number' })
    }
    if (body.cursor !== undefined) {
      const n = Number(body.cursor)
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ detail: 'cursor must be a non-negative number' })
    }
    await mp.updateSettings(req.params.slug, {
      strategy: body.strategy,
      lookback: body.lookback === undefined ? undefined : Number(body.lookback),
      cursor: body.cursor === undefined ? undefined : Number(body.cursor),
    })
    res.json(await mp.getPoolState(req.params.slug))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update music-pool settings'))
  }
})

router.post('/projects/:slug/music-pool/tracks', async (req, res) => {
  try {
    const source = typeof req.body?.source_path === 'string' ? req.body.source_path.trim() : ''
    if (!source) return res.status(400).json({ detail: 'source_path is required (absolute path to the audio file)' })
    const { filename } = await mp.addTrack(req.params.slug, source)
    res.status(201).json({ filename, pool: await mp.getPoolState(req.params.slug) })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Failed to add track'))
  }
})

router.patch('/projects/:slug/music-pool/tracks/:filename', async (req, res) => {
  try {
    const patch: {
      enabled?: boolean
      label?: string
      volume?: number | null
      post_narration_volume?: number | null
      fade_in?: number | null
      fade_out?: number | null
    } = {}
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled
    if (typeof req.body?.label === 'string') patch.label = req.body.label.trim()
    // v1.0.108+ per-track override knobs. null = clear, number = set.
    for (const k of ['volume', 'post_narration_volume', 'fade_in', 'fade_out'] as const) {
      const v = (req.body || {})[k]
      if (v === null) patch[k] = null
      else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ detail: 'No valid fields to update (enabled / label / volume / post_narration_volume / fade_in / fade_out)' })
    }
    await mp.updateTrackMeta(req.params.slug, decodeURIComponent(req.params.filename), patch)
    res.json(await mp.getPoolState(req.params.slug))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update track'))
  }
})

router.delete('/projects/:slug/music-pool/tracks/:filename', async (req, res) => {
  try {
    const result = await mp.removeTrack(req.params.slug, decodeURIComponent(req.params.filename))
    if (!result.removed) return res.status(404).json({ detail: 'Track not found on disk' })
    res.json({ ok: true, pool: await mp.getPoolState(req.params.slug) })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to remove track'))
  }
})

router.get('/projects/:slug/music-pool/peek-next', async (req, res) => {
  try {
    const episode_code = typeof req.query.episode_code === 'string' ? req.query.episode_code : ''
    const result = await mp.peekNext(req.params.slug, episode_code)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to peek next track'))
  }
})

router.post('/projects/:slug/music-pool/record-pick', async (req, res) => {
  try {
    const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : ''
    const episode_code = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    if (!filename || !episode_code) {
      return res.status(400).json({ detail: 'filename and episode_code are required' })
    }
    const result = await mp.recordPick(req.params.slug, episode_code, filename)
    res.json({ ...result, pool: await mp.getPoolState(req.params.slug) })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to record pick'))
  }
})
