/**
 * Audio editor routes — FFmpeg check, asset scanning, and audio merge generation.
 */

import { Router } from 'express'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import { enqueue, isDuplicate } from '../services/job-queue.js'
import { scanEpisodeAudioAssets } from '../generators/audio-merge.js'
import { checkFfmpeg } from '../lib/ffmpeg-utils.js'
import { getAudioMergeStatus } from '../services/asset-status.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

// ── Status endpoint (for the per-episode integrity pill) ─────────────────
router.get('/projects/:slug/episodes/:code/audio-merge-status', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const s = await getAudioMergeStatus(req.params.slug, req.params.code)
    res.json(s)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute audio-merge status'))
  }
})

// Check FFmpeg availability
router.get('/projects/:slug/audio-editor/check-ffmpeg', async (_req, res) => {
  try {
    const result = await checkFfmpeg()
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'FFmpeg check failed'))
  }
})

// Scan episode assets for audio editor
router.get('/projects/:slug/audio-editor/scan/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  try {
    const assets = await scanEpisodeAudioAssets(slug, episodeId)
    res.json(assets)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Asset scan failed'))
  }
})

// Queue audio merge job
router.post('/projects/:slug/generate/audio-merge', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const { episode_id, chapters, gap_duration, normalize_volume, music, background_noise, narration_volume } = req.body
  if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
  if (!chapters || !Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({ detail: 'At least one chapter file path is required' })
  }

  // Apply defaults
  req.body.gap_duration = gap_duration ?? 5
  req.body.normalize_volume = normalize_volume ?? false

  if (isDuplicate(slug, episode_id, 'audio_merge')) {
    return res.status(409).json({ detail: `Audio merge already queued/running for ${episode_id}` })
  }

  const job = enqueue({
    project_slug: slug,
    type: 'audio_merge',
    episode_id,
    title: `Audio merge (${chapters.length} chapters)`,
    params: req.body,
  })
  res.status(201).json(job)
})

// Serve audio file for preview playback
router.get('/projects/:slug/audio-editor/preview-audio', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const filePath = req.query.path as string
  if (!filePath) return res.status(400).json({ detail: 'path query parameter required' })
  if (!existsSync(filePath)) return res.status(404).json({ detail: 'File not found' })

  // Gate: allow project/output paths OR any recognized audio file the user
  // explicitly picked via our native dialog. This is a localhost-only backend
  // so the risk surface is the UI itself, not remote callers.
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
  }
  if (!mimeTypes[ext]) {
    return res.status(403).json({ detail: 'Only audio files may be previewed' })
  }
  const mime = mimeTypes[ext]

  try {
    const stat = await fs.stat(filePath)
    res.set('Content-Type', mime)
    res.set('Content-Length', stat.size.toString())
    res.set('Accept-Ranges', 'bytes')
    res.set('Cache-Control', 'public, max-age=3600')

    // Support range requests for seeking
    const range = req.headers.range
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
      res.status(206)
      res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      res.set('Content-Length', (end - start + 1).toString())
      const { createReadStream } = await import('fs')
      createReadStream(filePath, { start, end }).pipe(res)
    } else {
      const { createReadStream } = await import('fs')
      createReadStream(filePath).pipe(res)
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Audio preview failed'))
  }
})
