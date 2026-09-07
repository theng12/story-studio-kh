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
import { getEffectiveFormat } from '../services/format-loader.js'
import { resolveAssetPath } from '../services/path-resolver.js'
import {
  inspectChapterAudioReadiness,
  requireChapterAudioReady,
} from '../services/audio-workflow-readiness.js'

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
    const [assets, chapterAudioReadiness] = await Promise.all([
      scanEpisodeAudioAssets(slug, episodeId),
      inspectChapterAudioReadiness(slug, episodeId),
    ])
    res.json({ ...assets, chapter_audio_readiness: chapterAudioReadiness })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Asset scan failed'))
  }
})

// Queue audio merge job
router.post('/projects/:slug/generate/audio-merge', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const { episode_id, chapters, gap_duration, normalize_volume, music, background_noise, narration_volume } = req.body
  // This marker is emitted only by the candidate worker after its bytes and
  // source map have been fenced.  A browser must not be able to turn an
  // ordinary merge into a quality-repair completion path.
  delete req.body.audio_quality_refresh
  if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
  try {
    await requireChapterAudioReady(slug, episode_id)
  } catch (error: any) {
    return res.status(409).json({ detail: error?.message || 'All required audio must be generated first.' })
  }

  // Apply defaults — precedence: request body → format → legacy hardcoded.
  // Format-aware (v1.0.72): each channel format's audioMergeDefaults block
  // provides the "right" values for that style (sleep-story = no normalize,
  // 5s gaps; listicle = no gap, normalize on; etc.) so a stale preset or
  // programmatic enqueue that omits these fields gets format-tuned values
  // instead of the legacy sleep-story-flavoured 5s/no-normalize fallback.
  // Format load failures fall through to the legacy defaults — never break
  // the merge job over a missing format.
  let fmtMerge: { gapDurationSec?: number; normalizeVolume?: boolean } | undefined
  try {
    const fmt = await getEffectiveFormat(slug)
    fmtMerge = fmt?.script.audioMergeDefaults
  } catch { /* format layer must never break the queue submit */ }
  req.body.gap_duration = gap_duration ?? fmtMerge?.gapDurationSec ?? 5
  req.body.normalize_volume = normalize_volume ?? fmtMerge?.normalizeVolume ?? false

  if (isDuplicate(slug, episode_id, 'audio_merge')) {
    return res.status(409).json({ detail: `Audio merge already queued/running for ${episode_id}` })
  }

  const job = await enqueue({
    project_slug: slug,
    type: 'audio_merge',
    episode_id,
    title: `Audio merge (${Array.isArray(chapters) ? chapters.length : 'all'} chapters)`,
    params: req.body,
  })
  res.status(201).json(job)
})

// Serve audio file for preview playback
router.get('/projects/:slug/audio-editor/preview-audio', async (req, res) => {
  const { slug } = req.params
  const outputRoot = (await pm.getProjectOutputRoot(slug)) || undefined
  if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })

  const rawPath = req.query.path as string
  if (!rawPath) return res.status(400).json({ detail: 'path query parameter required' })
  let filePath = rawPath
  try {
    // Absolute episodes dir — `${PROJECT}/…` must expand against the real
    // folder. This used to pass the stored `project.output_root`, which was
    // the RELATIVE './episodes', so a portable path silently expanded against
    // the process cwd and the preview 404'd. Fixed with the field's removal.
    filePath = resolveAssetPath(rawPath, outputRoot)
  } catch (e: any) {
    return res.status(400).json(humanizeBackendError(e, 'Could not resolve preview path'))
  }
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
