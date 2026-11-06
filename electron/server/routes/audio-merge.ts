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
import { isPreviewablePath } from '../lib/preview-roots.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { resolveAssetPath } from '../services/path-resolver.js'
import {
  inspectChapterAudioReadiness,
} from '../services/audio-workflow-readiness.js'
import { safetyMode } from '../services/safety-checks.js'
import { revalidatePreview, streamTo } from '../lib/stream-file.js'
import { findActivePreset, resolveStepParams } from './pipeline.js'

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
    // First load of an episode that still holds split narration: join each
    // complete chapter so the list shows one file per chapter.
    const { consolidateEpisodeParts } = await import('../services/chapter-parts.js')
    await consolidateEpisodeParts(slug, episodeId, () => {})
    const [assets, chapterAudioReadiness, chapterAudioPresentMode] = await Promise.all([
      scanEpisodeAudioAssets(slug, episodeId),
      inspectChapterAudioReadiness(slug, episodeId),
      safetyMode(slug, 'chapter_audio_present'),
    ])
    res.json({
      ...assets,
      chapter_audio_readiness: chapterAudioReadiness,
      chapter_audio_present_mode: chapterAudioPresentMode,
    })
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
  // Audio Assembly's explicit Apply (VA step 2) sends an episode's approved mixer
  // choices with the channel's EXISTING selected preset: resolve that preset the
  // same way Pipeline does. `channel_intro` must be stated on every such request —
  // a non-empty selection freezes below, `null` deliberately rebuilds the legacy
  // (no channel intro) track. Anything else is refused rather than defaulted.
  const reuseSavedSettings = req.body.reuse_saved_settings === true
  delete req.body.reuse_saved_settings
  if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
  let reusedParams: Record<string, any> | undefined
  let clearChannelIntro = false
  if (reuseSavedSettings) {
    const hasIntroKey = Object.prototype.hasOwnProperty.call(req.body, 'channel_intro')
    const selection = req.body.channel_intro
    if (!hasIntroKey) {
      return res.status(400).json({
        detail: 'Saved Audio Assembly settings need an explicit channel intro choice: pick an intro file, or send channel_intro: null to rebuild without one.',
      })
    }
    if (selection === null) {
      clearChannelIntro = true
    } else if (!selection || typeof selection !== 'object'
      || typeof selection.file !== 'string' || !selection.file.trim() || selection.enabled === false) {
      return res.status(400).json({
        detail: 'The channel intro selection is malformed: choose a file, or send channel_intro: null to rebuild without one.',
      })
    }
    try {
      const config = await pm.getConfig(slug)
      const active = findActivePreset(config, 'audio_merge')
      if (!active.preset) {
        return res.status(400).json({
          detail: `Saved Audio Assembly settings are not available: ${active.missingReason || 'no Audio Assembly preset is selected.'}`,
        })
      }
      const format = await getEffectiveFormat(slug)
      reusedParams = resolveStepParams('audio_merge', episode_id, '', active.preset, format)
    } catch (e: any) {
      return res.status(400).json({
        detail: `Saved Audio Assembly settings could not be resolved: ${e?.message || e}`,
      })
    }
  }
  // Job3 (1.4.384) — an explicit channel-owned intro is frozen HERE, at the
  // job boundary: the chosen bytes are copied and hashed once, so the merge
  // reads exactly what this job was queued with (local and remote consumers
  // of the assembled audio see the same intro). An absent or empty selection
  // deletes the key and the generator takes the release/1.4.383 path
  // untouched — nothing reads or adopts a channel intro on its own.
  if (req.body.channel_intro && typeof req.body.channel_intro === 'object') {
    const picked = typeof req.body.channel_intro.file === 'string' ? req.body.channel_intro.file.trim() : ''
    if (picked && req.body.channel_intro.enabled !== false) {
      try {
        const outputRoot = await pm.getProjectOutputRoot(slug)
        if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })
        const { freezeChannelIntro } = await import('../services/channel-intro-asset.js')
        const frozen = await freezeChannelIntro({ outputRoot, file: picked, slug, episodeId: episode_id })
        req.body.channel_intro = { ...req.body.channel_intro, ...frozen, enabled: true }
        // Nothing was frozen (source unavailable at the boundary): drop the
        // unfrozen path so the generator never treats it as a frozen copy —
        // its existing intro_audio safety mode decides with a loud reason.
        if (!frozen.file) delete req.body.channel_intro.file
      } catch (e: any) {
        return res.status(400).json({ detail: `Channel intro could not be prepared for this run: ${e?.message || e}` })
      }
    } else {
      delete req.body.channel_intro
    }
  }
  if (reuseSavedSettings && reusedParams) {
    // Only these run-specific facts ride over the selected preset: the episode,
    // its explicit intro (or its deliberate absence), and how to write the file.
    // Any other submitted key is ignored so it cannot override the chosen mixer.
    const writeMode = req.body.write_mode
    const frozenIntro = req.body.channel_intro
    req.body = { ...reusedParams, episode_id }
    if (!clearChannelIntro && frozenIntro) req.body.channel_intro = frozenIntro
    if (writeMode !== undefined) req.body.write_mode = writeMode
  }
  const readiness = await inspectChapterAudioReadiness(slug, episode_id)
  if (!readiness.ready
    && (!readiness.present_files.length || await safetyMode(slug, 'chapter_audio_present') === 'block')) {
    return res.status(409).json({ detail: `Audio Assembly is blocked: ${readiness.issues.join(' ')}` })
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
  if (!reuseSavedSettings) {
    req.body.gap_duration = gap_duration ?? fmtMerge?.gapDurationSec ?? 3
    req.body.normalize_volume = normalize_volume ?? fmtMerge?.normalizeVolume ?? false
  }

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
  // CONTAINMENT. `resolveAssetPath` returns a plain absolute path unchanged, so
  // before this the only gate was the file extension and ANY file on the machine
  // with a matching one was streamed back — and in server mode this binds
  // 0.0.0.0. A preview may read the Library and media folders the owner
  // configured, nothing else. See `lib/preview-roots.ts`.
  if (!await isPreviewablePath(filePath, slug)) {
    return res.status(403).json({
      detail: 'That file is outside this project. Previews can read your Library and any media folder you configured.',
    })
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
    if (revalidatePreview(req, res, stat)) return
    res.set('Content-Length', stat.size.toString())
    res.set('Accept-Ranges', 'bytes')

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
      streamTo(res, createReadStream(filePath, { start, end }))
    } else {
      const { createReadStream } = await import('fs')
      streamTo(res, createReadStream(filePath))
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Audio preview failed'))
  }
})
