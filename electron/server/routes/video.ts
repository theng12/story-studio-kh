/**
 * Video editor routes — FFmpeg check, asset scanning, presets, and video generation.
 */

import { Router } from 'express'
import { createReadStream, existsSync, statSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import { enqueue, enqueueEpisodeRecoveryOnce, getJobs, isDuplicate, loadAuthoritativeJob, subtitleFinalizerJobId } from '../services/job-queue.js'
import { withLock } from '../lib/atomic-store.js'
import { subtitlePurchaseParams } from '../services/subtitle-recovery.js'
import { checkFfmpeg, prepareUnifiedVideoAssemblyInputs, scanEpisodeAssets } from '../generators/video.js'
import { renderSubtitlePreflightFrames } from '../lib/subtitle-preflight-frames.js'
import { canvasForShortEdge, displayAspectRatio, resolveRenderCanvas } from '../lib/render-canvas.js'
import { inspectSourceAspect } from '../lib/source-aspect.js'
import { inspectPlanTimelineDrift } from '../lib/scene-plan-timeline.js'
import { TRANSITIONS, groupedTransitions, getTransition } from '../models/transitions.js'
import { getAnimation, groupAnimationDefs, toAnimationDef } from '../models/animations.js'
import { buildAnimationFilter } from '../lib/animation-filters.js'
import { cacheToken, cachedFileForToken, getOrRender } from '../services/preview-cache.js'
import { readManifest } from '../services/task-manifest.js'
import { resolveAssetPath } from '../services/path-resolver.js'
import { runFfmpeg, hasDrawtextFilter, hasLibass, getAudioDuration, stillDecoderArgs, escapeFilterPath } from '../lib/ffmpeg-utils.js'
import { compileSceneMotion, compileSceneOverlay } from '../lib/scene-effect-compiler.js'
import {
  listSceneEffectLibrary,
  listSubtitleStylePresets,
  type SceneEffectLibrary,
} from '../services/style-effect-loader.js'
import { normalizeSceneOverlay, type SceneMotionDocument, type SceneOverlayDocument } from '../contracts/scene-effects.js'
import {
  SceneEffectValidationError,
  parseSceneMotionDocument,
  parseSceneOverlayDocument,
} from '../contracts/scene-effects-schema.js'
import { buildSubtitleAssDocument, normalizeSrtOrVtt, parseSrt, trimCuesBeforeStoryStart } from '../lib/subtitle-builder.js'
import { normalizeSubtitleStyle, type SubtitleStyleDocument } from '../contracts/subtitle-style.js'
import { SubtitleStyleValidationError, parseSubtitleStyleDocument } from '../contracts/subtitle-style-schema.js'
import {
  SUBTITLE_PREVIEW_SHORT_EDGE,
  SUBTITLE_PREVIEW_FPS,
  SUBTITLE_PREVIEW_DURATION,
  SUBTITLE_PREVIEW_SAMPLE,
} from '../contracts/subtitle-preview.js'
import { resolveSubtitlesDir, resolveTranscriptionLanguage } from '../generators/subtitles.js'
import { readSelectedSubtitle, resolveBurnSubtitle, writeSelectedSubtitle } from '../lib/subtitle-selection.js'
import { inspectSubtitleText, type SubtitleQualityReport } from '../lib/subtitle-quality.js'
import { inspectSubtitleCompletion } from '../services/subtitle-completion.js'
import { inspectExistingTranscriptSource } from '../services/subtitle-correction.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { findFreshActionJob, readOperationId, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { assertSubtitleTimelineComplete, readSubtitleTimelineIntegrity } from '../services/scene-timeline-integrity.js'
import { allowedSubtitleCueGapSec } from '../services/scene-plan-pacing.js'
import { listTranscriptionModels as listGenStudioTranscriptionModels } from '../lib/genstudio-client.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import type { ScenePlan, VideoSubtitleStyle } from '../models/types.js'
import {
  inspectAudioAssemblyReadiness,
  requireAudioAssemblyReady,
} from '../services/audio-workflow-readiness.js'
import { truncateChars } from '../lib/well-formed-text.js'
import { readVideoVisualSource, setVideoVisualSource } from '../services/video-visual-source.js'

export const router = Router()

// Check FFmpeg availability
router.get('/projects/:slug/video-editor/check-ffmpeg', async (_req, res) => {
  try {
    const result = await checkFfmpeg()
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'FFmpeg check failed'))
  }
})

// Scan episode assets for video editor
router.get('/projects/:slug/video-editor/scan/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params

  try {
    const assets = await scanEpisodeAssets(slug, episodeId)
    res.json(assets)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Asset scan failed'))
  }
})

// The source is durable episode state. Missing/legacy source flags resolve to
// Scene Plan so existing episodes keep their established behaviour.
router.get('/projects/:slug/video-editor/visual-source/:episodeId', async (req, res) => {
  try {
    const state = await readVideoVisualSource(req.params.slug, req.params.episodeId)
    res.json({ source: state.source, image_pool: state.image_pool })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read Video Assembly visual source'))
  }
})

router.put('/projects/:slug/video-editor/visual-source/:episodeId', async (req, res) => {
  try {
    const source = req.body?.source
    if (source !== 'scene_plan' && source !== 'image_pool') {
      return res.status(400).json({ detail: 'source must be scene_plan or image_pool' })
    }
    const state = await setVideoVisualSource(req.params.slug, req.params.episodeId, source)
    res.json({ source: state.source, image_pool: state.image_pool })
  } catch (e: any) {
    res.status(409).json(humanizeBackendError(e, 'Could not set Video Assembly visual source'))
  }
})

// Scan local music files in project directory
router.get('/projects/:slug/video-editor/music-files', async (req, res) => {
  const { slug } = req.params

  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })

    const musicFiles: Array<{ filename: string; path: string; duration?: number }> = []
    const audioExtensions = /\.(mp3|wav|m4a|aac|ogg|flac)$/i

    // Scan project root and music subdirectory
    const locations = [projectDir]
    const musicSubdir = path.join(projectDir, 'music')
    if (existsSync(musicSubdir)) locations.push(musicSubdir)

    const seenPaths = new Set<string>()
    for (const loc of locations) {
      try {
        const files = await fs.readdir(loc)
        for (const file of files) {
          if (!audioExtensions.test(file)) continue
          const fullPath = path.join(loc, file)
          if (seenPaths.has(fullPath)) continue
          seenPaths.add(fullPath)

          // Quick duration probe. Previously spawned `ffprobe` by bare string,
          // which ENOENT'd on packaged Macs without system ffprobe in PATH.
          // `getAudioDuration()` routes through the same resolver that finds
          // the bundled binary inside `.app/Contents/Resources/ffmpeg/`.
          let duration: number | undefined
          try { duration = await getAudioDuration(fullPath) } catch { /* skip */ }

          musicFiles.push({ filename: file, path: fullPath, duration })
        }
      } catch { /* skip inaccessible directories */ }
    }

    res.json(musicFiles)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not scan music files'))
  }
})

// Scan local overlay assets in project directory.
// Looks under `${PROJECT}/overlays/` for video/image files that the
// Overlay Layers UI can attach as a composite layer. Mirrors the
// music-files scanner above — same caching pattern, no ffprobe
// fan-out for static images so the response stays cheap.
router.get('/projects/:slug/video-editor/overlay-files', async (req, res) => {
  const { slug } = req.params

  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })

    type OverlayEntry = {
      filename: string
      path: string
      ext: string
      kind: 'video' | 'image'
      /** Heuristic — `.mov` ProRes 4444, `.webm` VP9 with alpha, `.png`,
       *  `.gif`, and `.apng` typically carry alpha so chroma-key is
       *  unnecessary. The UI uses this to default the chroma-key
       *  toggle off for these types. */
      likely_has_alpha: boolean
      duration?: number
    }
    const videoExtensions = /\.(mp4|mov|webm|mkv|m4v)$/i
    const imageExtensions = /\.(png|gif|apng|webp|jpg|jpeg)$/i
    const alphaFriendly = /\.(mov|webm|png|apng|gif|webp)$/i

    const overlaysDir = path.join(projectDir, 'overlays')
    if (!existsSync(overlaysDir)) {
      // Soft-fail: returning an empty list lets the UI render a
      // "drop files into overlays/" hint without an error toast.
      return res.json({ overlays: [], overlays_dir: overlaysDir, exists: false })
    }

    const out: OverlayEntry[] = []
    try {
      const files = await fs.readdir(overlaysDir)
      for (const file of files) {
        const isVideo = videoExtensions.test(file)
        const isImage = imageExtensions.test(file)
        if (!isVideo && !isImage) continue
        const fullPath = path.join(overlaysDir, file)
        const ext = path.extname(file).toLowerCase()
        let duration: number | undefined
        if (isVideo) {
          // Reuse audio-duration resolver (it probes streams; container
          // doesn't matter to ffprobe). Static images skip — no duration
          // to report.
          try { duration = await getAudioDuration(fullPath) } catch { /* tolerate */ }
        }
        out.push({
          filename: file,
          path: fullPath,
          ext,
          kind: isVideo ? 'video' : 'image',
          likely_has_alpha: alphaFriendly.test(file),
          duration,
        })
      }
    } catch (e: any) {
      return res.status(500).json({ detail: `Could not read ${overlaysDir}: ${e?.message || e}` })
    }

    out.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
    res.json({ overlays: out, overlays_dir: overlaysDir, exists: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not scan overlay files'))
  }
})

// Scan local ambient tracks in project directory.
// Looks under `${PROJECT}/ambient/` for audio files that the new
// Ambient Tracks UI can layer in parallel (rain + fire + thunder).
// Mirrors the music-files scanner — durations probed via ffprobe so
// the UI can show "rain.mp3 · 4m 12s" without an extra round-trip.
router.get('/projects/:slug/video-editor/ambient-files', async (req, res) => {
  const { slug } = req.params

  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })
    const ambientDir = path.join(projectDir, 'ambient')
    if (!existsSync(ambientDir)) {
      return res.json({ tracks: [], ambient_dir: ambientDir, exists: false })
    }
    const audioExtensions = /\.(mp3|wav|m4a|aac|ogg|flac)$/i
    const tracks: Array<{ filename: string; path: string; duration?: number }> = []
    try {
      const files = await fs.readdir(ambientDir)
      for (const file of files) {
        if (!audioExtensions.test(file)) continue
        const fullPath = path.join(ambientDir, file)
        let duration: number | undefined
        try { duration = await getAudioDuration(fullPath) } catch { /* tolerate */ }
        tracks.push({ filename: file, path: fullPath, duration })
      }
    } catch (e: any) {
      return res.status(500).json({ detail: `Could not read ${ambientDir}: ${e?.message || e}` })
    }
    tracks.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
    res.json({ tracks, ambient_dir: ambientDir, exists: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not scan ambient files'))
  }
})

// Scan local background-plate assets in project directory (v1.0.63+).
// Compilation video layout (compilation-mode / listicle channels) needs a
// looping background video or static image to play behind the per-
// chapter foreground icons. Mirrors the music-files / overlay-files
// scanners — drop sources into ${PROJECT}/backgrounds/, click + Add.
router.get('/projects/:slug/video-editor/background-files', async (req, res) => {
  const { slug } = req.params

  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })

    type BgEntry = {
      filename: string
      path: string
      ext: string
      kind: 'video' | 'image'
      duration?: number
    }
    const videoExts = /\.(mp4|mov|webm|mkv|m4v)$/i
    const imageExts = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i

    const bgDir = path.join(projectDir, 'backgrounds')
    if (!existsSync(bgDir)) {
      return res.json({ backgrounds: [], backgrounds_dir: bgDir, exists: false })
    }
    const out: BgEntry[] = []
    try {
      const files = await fs.readdir(bgDir)
      for (const file of files) {
        const isVideo = videoExts.test(file)
        const isImage = imageExts.test(file)
        if (!isVideo && !isImage) continue
        const fullPath = path.join(bgDir, file)
        const ext = path.extname(file).toLowerCase()
        let duration: number | undefined
        if (isVideo) {
          try { duration = await getAudioDuration(fullPath) } catch { /* tolerate */ }
        }
        out.push({
          filename: file,
          path: fullPath,
          ext,
          kind: isVideo ? 'video' : 'image',
          duration,
        })
      }
    } catch (e: any) {
      return res.status(500).json({ detail: `Could not read ${bgDir}: ${e?.message || e}` })
    }
    out.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
    res.json({ backgrounds: out, backgrounds_dir: bgDir, exists: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not scan background files'))
  }
})

router.post('/projects/:slug/video-editor/backgrounds/open-folder', async (req, res) => {
  const { slug } = req.params
  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })
    const bgDir = path.join(projectDir, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    const { shell } = await import('electron')
    const err = await shell.openPath(bgDir)
    if (err) return res.status(500).json({ detail: `Could not open folder: ${err}` })
    res.json({ ok: true, path: bgDir })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not open backgrounds folder'))
  }
})

// Locate the on-disk episode directory by code. Delegates to the shared
// folder-resolver (v1.0.338 consolidation — this used to be a private
// recursive-walk copy). Used by the chapter-alignment + per-scene-swap
// routes below.
async function findEpisodeDirForRoute(slug: string, episodeCode: string): Promise<string | null> {
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return null
  const { findEpisodeDir } = await import('../lib/folder-resolver.js')
  return findEpisodeDir(outputRoot, episodeCode)
}

// GET the audio_chapters.json sidecar (Workstream B). Returns the
// parsed list of chapters in playback order so the per-scene-swap UI
// can render a column per chapter. Empty list when sidecar is absent
// (typical: user hasn't run Audio Merge yet).
router.get('/projects/:slug/video-editor/audio-chapters', async (req, res) => {
  const { slug } = req.params
  const episodeId = String(req.query.episode_id || '').trim()
  if (!episodeId) return res.status(400).json({ detail: 'episode_id query parameter required' })
  try {
    const episodeDir = await findEpisodeDirForRoute(slug, episodeId)
    if (!episodeDir) return res.json({ sections: [], episode_dir: null, exists: false })
    const sidecarPath = path.join(episodeDir, 'audio_chapters.json')
    if (!existsSync(sidecarPath)) {
      return res.json({ sections: [], episode_dir: episodeDir, exists: false })
    }
    const raw = await fs.readFile(sidecarPath, 'utf-8')
    const parsed = JSON.parse(raw) as {
      sections?: Array<{ slug: string; duration_s: number; source_file?: string }>
    }
    res.json({
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      episode_dir: episodeDir,
      exists: true,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read audio_chapters.json'))
  }
})

// Read-only opening preview. Kept at the historical route so old clients do not
// break; new assembly timing is read from scene_plan.json during render.
router.get('/projects/:slug/video-editor/intro-hold', async (req, res) => {
  const { slug } = req.params
  const episodeId = String(req.query.episode_id || '').trim()
  const introVideoPath = String(req.query.intro_video_path || '').trim()
  if (!episodeId) return res.status(400).json({ detail: 'episode_id query parameter required' })
  try {
    // v1.3.1 — read from the project's real opening clips, not from a
    // `visual_opening_mode` flag someone set on another page months ago.
    const { resolveProjectOpening } = await import('../services/opening-assets.js')
    const { measureOpeningSec } = await import('../lib/opening-duration.js')
    const measuredOpeningSec = await measureOpeningSec(
      (await resolveProjectOpening(slug)).head,
      getAudioDuration,
    ).catch(() => 0)
    const opening_mode = measuredOpeningSec > 0 ? 'branded-opening' : 'from-start'
    const episodeDir = await findEpisodeDirForRoute(slug, episodeId)
    const sidecarPath = episodeDir ? path.join(episodeDir, 'audio_chapters.json') : ''
    if (!episodeDir || !sidecarPath || !existsSync(sidecarPath)) {
      return res.json({ skip_intro_scenes: false, opening_mode, has_intro_chapter: false, story_start_sec: 0, intro_video_sec: 0, hold_sec: 0, intro_label: null })
    }
    const sc = JSON.parse(await fs.readFile(sidecarPath, 'utf-8'))
    const gap = typeof sc.gap_duration_s === 'number' ? sc.gap_duration_s : 0
    const assets = await scanEpisodeAssets(slug, episodeId).catch(() => null)
    const merged = assets?.merged_audio?.[0]?.path || null
    const { computeStoryStartSec } = await import('../lib/intro-lead-in.js')
    const story = await computeStoryStartSec(merged, sc.sections || [], gap)
    let intro_video_sec = 0
    if (introVideoPath && existsSync(introVideoPath)) {
      intro_video_sec = (await getAudioDuration(introVideoPath).catch(() => 0)) || 0
    }
    const story_start_sec = story?.story_start_sec || 0
    const hold_sec = Math.max(0, Math.round((story_start_sec - intro_video_sec) * 100) / 100)
    res.json({
      skip_intro_scenes: false,
      opening_mode,
      has_intro_chapter: !!story,
      intro_label: story?.intro_label || null,
      story_start_sec,
      intro_video_sec,
      hold_sec,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not compute the intro title-card hold'))
  }
})

router.post('/projects/:slug/video-editor/ambient/open-folder', async (req, res) => {
  const { slug } = req.params
  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })
    const ambientDir = path.join(projectDir, 'ambient')
    await fs.mkdir(ambientDir, { recursive: true })
    const { shell } = await import('electron')
    const err = await shell.openPath(ambientDir)
    if (err) return res.status(500).json({ detail: `Could not open folder: ${err}` })
    res.json({ ok: true, path: ambientDir })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not open ambient folder'))
  }
})

// Open the project's overlays/ folder in the OS file manager so the
// user can drop new clips in. Creates the folder on first call so
// the click never fails on a fresh project.
router.post('/projects/:slug/video-editor/overlays/open-folder', async (req, res) => {
  const { slug } = req.params
  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })
    const overlaysDir = path.join(projectDir, 'overlays')
    await fs.mkdir(overlaysDir, { recursive: true })
    // shell.openPath returns '' on success or an error string. Do it
    // via the Electron main-process bridge so packaged builds still
    // get the correct shell.
    const { shell } = await import('electron')
    const err = await shell.openPath(overlaysDir)
    if (err) return res.status(500).json({ detail: `Could not open folder: ${err}` })
    res.json({ ok: true, path: overlaysDir })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not open overlays folder'))
  }
})

// Serve an audio file for preview playback (music, background noise)
router.get('/projects/:slug/video-editor/preview-audio', async (req, res) => {
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

  // Gate by file type only — this backend binds localhost, so the risk
  // surface is the UI itself. Users pick audio via native dialog.
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

// Stream user-picked image/video media into the live effects preview. Range
// support is required for looping MP4/MOV elements in Chromium.
router.get('/projects/:slug/video-editor/preview-media', async (req, res) => {
  const { slug } = req.params
  const outputRoot = (await pm.getProjectOutputRoot(slug)) || undefined
  if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })
  const rawPath = String(req.query.path || '')
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
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  }
  const mime = mimeTypes[path.extname(filePath).toLowerCase()]
  if (!mime) return res.status(403).json({ detail: 'Unsupported preview media type' })
  try {
    const stat = await fs.stat(filePath)
    const range = req.headers.range
    res.set('Content-Type', mime)
    res.set('Accept-Ranges', 'bytes')
    res.set('Cache-Control', 'private, max-age=300')
    const { createReadStream } = await import('fs')
    if (range) {
      const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-')
      const start = Math.max(0, Number(startRaw) || 0)
      const end = Math.min(stat.size - 1, endRaw ? Number(endRaw) : stat.size - 1)
      res.status(206)
      res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      res.set('Content-Length', String(end - start + 1))
      createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.set('Content-Length', String(stat.size))
      createReadStream(filePath).pipe(res)
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Media preview failed'))
  }
})

// Serve an image file for preview (thumbnails, scene images, logos)
router.get('/projects/:slug/video-editor/preview-image', async (req, res) => {
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

  // Gate by file type only — localhost backend, user-picked paths OK.
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  if (!mimeTypes[ext]) {
    return res.status(403).json({ detail: 'Only image files may be previewed' })
  }
  const mime = mimeTypes[ext]

  try {
    const data = await fs.readFile(filePath)
    res.set('Content-Type', mime)
    // Generated images are frequently replaced at the same path. Revalidate
    // rather than trusting an hour-old Chromium decode/cache entry, which can
    // otherwise leave every preview card blank until the app is restarted.
    res.set('Cache-Control', 'private, no-cache, must-revalidate')
    res.send(data)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Image preview failed'))
  }
})

// ── Transitions catalog + previews ──────────────────────────────────────
// The catalog is project-scoped because it's surfaced in the project's
// video-assembly UI, but the underlying list is global. Project scope also
// lets us later tailor the catalog (e.g. hide GPU-only transitions) based
// on that project's FFmpeg build.

router.get('/projects/:slug/video-editor/transitions/catalog', async (req, res) => {
  const { slug } = req.params
  res.json({ transitions: TRANSITIONS, grouped: groupedTransitions() })
})

/**
 * Render a tiny preview clip demonstrating the given xfade transition.
 * Two preview frames (first + second scene image if available, otherwise
 * coloured gradients) blended over `duration` seconds, output as webm so
 * it can be inlined in a <video> tag.
 *
 * Caching is key — the picker grid requests ~40 previews and we don't want
 * to pay the FFmpeg startup cost on every hover.
 */
/**
 * The SHORT edge every preview clip is drawn at (v1.4.15).
 *
 * It replaces the three separate `480 × 270` pairs, which were 16:9 whatever
 * the render was going to be. 270 keeps every landscape preview byte-identical
 * to the ones already cached.
 */
const PREVIEW_SHORT_EDGE = 270

router.get('/projects/:slug/video-editor/preview-transition', async (req, res) => {
  const { slug } = req.params

  const type = (req.query.type as string) || 'crossfade'
  const duration = Math.max(0.3, Math.min(Number(req.query.duration) || 1.2, 3))
  const episodeId = req.query.episode as string | undefined

  const def = getTransition(type)
  if (!def || !def.xfade) {
    return res.status(400).json({ detail: `Unknown or 'none' transition: ${type}` })
  }

  // Pick two sample images: first two scenes if an episode is hinted,
  // otherwise fall back to lavfi gradients so the UI still has something
  // to show.
  let imgA: string | null = null
  let imgB: string | null = null
  if (episodeId) {
    try {
      const assets = await scanEpisodeAssets(slug, episodeId)
      if (assets.scenes.length >= 2) {
        imgA = assets.scenes[0].path
        imgB = assets.scenes[1].path
      } else if (assets.scenes.length === 1) {
        imgA = assets.scenes[0].path
      }
    } catch { /* fall through to synthetic */ }
  }

  // v1.4.15 — the preview follows the render's shape. A crossfade looks the
  // same in any frame, but the picker sits beside the effect picker, and one
  // landscape thumbnail among portrait ones reads as a bug.
  const { w: W, h: H } = canvasForShortEdge(PREVIEW_SHORT_EDGE, req.query.aspect_ratio as string | undefined)
  const FPS = 24
  const clipSec = 1 // each clip length (so xfade offset at duration - transition)
  const totalSec = clipSec + duration
  const keyParts = [
    'transition-v2',
    def.xfade,
    duration.toFixed(2),
    // The canvas is part of the picture now, so it is part of the cache key —
    // without it a portrait request is served the landscape clip already on disk.
    `${W}x${H}`,
    imgA ? `a:${imgA}` : 'a:synthetic-warm',
    imgB ? `b:${imgB}` : 'b:synthetic-cool',
  ]
  const key = keyParts.join('|')

  try {
    const cached = await getOrRender(key, 'webm', async (outPath) => {
      const args: string[] = ['-y']
      // Input A
      if (imgA && existsSync(imgA)) {
        args.push(...(await stillDecoderArgs(imgA)), '-loop', '1', '-t', clipSec.toString(), '-i', imgA)
      } else {
        args.push('-f', 'lavfi', '-t', clipSec.toString(),
          '-i', `color=c=0xD38B5D:s=${W}x${H}:r=${FPS}`)
      }
      // Input B
      if (imgB && existsSync(imgB)) {
        args.push(...(await stillDecoderArgs(imgB)), '-loop', '1', '-t', clipSec.toString(), '-i', imgB)
      } else {
        args.push('-f', 'lavfi', '-t', clipSec.toString(),
          '-i', `color=c=0x5D8FD3:s=${W}x${H}:r=${FPS}`)
      }
      const offset = Math.max(0, clipSec - duration).toFixed(3)
      const filter = [
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,fps=${FPS}[a0]`,
        `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,fps=${FPS}[a1]`,
        `[a0][a1]xfade=transition=${def.xfade}:duration=${duration}:offset=${offset},format=yuv420p[vout]`,
      ].join(';')
      args.push('-filter_complex', filter)
      args.push('-map', '[vout]')
      args.push('-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'realtime', '-row-mt', '1')
      args.push('-pix_fmt', 'yuv420p', '-an')
      args.push('-t', totalSec.toString())
      args.push(outPath)
      // v1.0.515 — previews are ~1-2s clips; 90s only trips on a genuine wedge
      // (the 5 zombie preview ffmpegs of 2026-07-05 ran 30+ min unbounded).
      await runFfmpeg(args, { timeoutMs: 90_000 })
    })

    const stat = await fs.stat(cached)
    res.set('Content-Type', 'video/webm')
    res.set('Content-Length', stat.size.toString())
    res.set('Cache-Control', 'public, max-age=86400')
    const stream = (await import('fs')).createReadStream(cached)
    stream.pipe(res)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Preview render failed'))
  }
})

// ── Animations catalog + previews ───────────────────────────────────────

router.get('/projects/:slug/video-editor/animations/catalog', async (_req, res) => {
  // v1.2.1 — the same projection, over the merged built-in + installed-pack
  // registry. With zero packs installed this is `ANIMATIONS` exactly.
  const animations = (await listSceneEffectLibrary()).scene_motions.map(toAnimationDef)
  res.json({ animations, grouped: groupAnimationDefs(animations) })
})

/**
 * Render a tiny preview clip demonstrating a single animation applied
 * to the first scene image (or a synthetic gradient if no episode hint).
 * Same caching strategy as transition previews.
 */
router.get('/projects/:slug/video-editor/preview-animation', async (req, res) => {
  const { slug } = req.params

  const type = (req.query.type as string) || 'none'
  const episodeId = req.query.episode as string | undefined
  const def = getAnimation(type)
  if (!def) return res.status(400).json({ detail: `Unknown animation: ${type}` })

  let srcImage: string | null = null
  if (episodeId) {
    try {
      const assets = await scanEpisodeAssets(slug, episodeId)
      if (assets.scenes.length >= 1) srcImage = assets.scenes[0].path
    } catch { /* fall through */ }
  }

  const { w: W, h: H } = canvasForShortEdge(PREVIEW_SHORT_EDGE, req.query.aspect_ratio as string | undefined)
  const FPS = 24, DURATION = 2
  const key = [
    'animation-v2',
    def.id,
    srcImage ? `img:${srcImage}` : 'img:synthetic',
    `${W}x${H}`,
  ].join('|')

  try {
    const cached = await getOrRender(key, 'webm', async (outPath) => {
      const args: string[] = ['-y']
      if (srcImage && existsSync(srcImage)) {
        args.push(...(await stillDecoderArgs(srcImage)), '-loop', '1', '-t', DURATION.toString(), '-i', srcImage)
      } else {
        // Use a gradient so motion is visually obvious on synthetic input.
        args.push(
          '-f', 'lavfi',
          '-t', DURATION.toString(),
          // Pinned, as the effect preview is: `gradients` randomises its ramp
          // endpoints AND its seed when they are left unset, so every tile in
          // the picker grid used to sit over a different-looking backdrop and
          // no two animations could be compared side by side.
          '-i', `gradients=size=${W * 2}x${H * 2}:type=linear:c0=0xD38B5D:c1=0x5D8FD3`
            + `:x0=0:y0=0:x1=${W * 2}:y1=0:nb_colors=2:seed=0:speed=0:r=${FPS}`,
        )
      }
      const vfChain = buildAnimationFilter({
        type: def.id,
        params: {} as any,
        w: W, h: H,
        fps: FPS,
        duration: DURATION,
      })
      vfChain.push('format=yuv420p')
      args.push('-vf', vfChain.join(','))
      args.push('-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'realtime', '-row-mt', '1')
      args.push('-pix_fmt', 'yuv420p', '-r', FPS.toString(), '-an')
      args.push('-t', DURATION.toString())
      args.push(outPath)
      // v1.0.515 — previews are ~1-2s clips; 90s only trips on a genuine wedge
      // (the 5 zombie preview ffmpegs of 2026-07-05 ran 30+ min unbounded).
      await runFfmpeg(args, { timeoutMs: 90_000 })
    })

    const stat = await fs.stat(cached)
    res.set('Content-Type', 'video/webm')
    res.set('Content-Length', stat.size.toString())
    res.set('Cache-Control', 'public, max-age=86400')
    const stream = (await import('fs')).createReadStream(cached)
    stream.pipe(res)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Animation preview render failed'))
  }
})

// ── Effect library: catalogue + preview ─────────────────────────────────────
//
// One catalogue for every effect the app can render — scene motions, B-Roll
// motions and overlays — served from the declarative registry rather than from
// three lists maintained by hand. `broll.vue` used to keep its own copy of the
// motion list; its hints had already drifted from the backend's by v1.1.0.
//
// The preview reuses `preview-cache.ts` and the POST-returns-a-token pattern
// v1.1.0 established for subtitles, for the same reason: an overlay stack is
// far too large for a querystring, but a `<video src>` needs a plain GET.

router.get('/projects/:slug/video-editor/effects/catalog', async (_req, res) => {
  res.json({
    // v1.2.1 — built-ins plus anything an installed Content Pack adds. Every
    // entry carries `origin`, and `refusals` names any pack item that was left
    // out rather than letting it disappear without explanation.
    ...await listSceneEffectLibrary(),
    // Both are FFmpeg build features, and both degrade an effect rather than
    // the whole render. The UI says so at the point of choosing instead of
    // letting the customer discover it in a finished video.
    supports_text_overlays: await hasDrawtextFilter(),
    supports_subtitles: await hasLibass(),
  })
})

/**
 * The caption gallery.
 *
 * New in v1.2.1 and it exists for one reason: `SubtitleStylePicker.vue` used to
 * import the sixteen built-in looks straight out of the contract module through
 * the `@shared` alias, which is fine for data that ships in the bundle and
 * impossible for data that arrives in a pack after the build. The component now
 * asks for the list and keeps its bundled copy as the offline fallback, so the
 * zero-packs case is byte-identical to v1.2.0.
 */
router.get('/projects/:slug/video-editor/subtitles/catalog', async (_req, res) => {
  res.json(await listSubtitleStylePresets())
})

const EFFECT_PREVIEW_FPS = 24
/** Long enough for a drifting light leak or a slow push to read. */
const EFFECT_PREVIEW_DURATION = 3

/**
 * Render one motion + overlay stack over the episode's first scene, or over a
 * synthetic gradient when there is no episode to borrow from.
 *
 * The cache key is the serialised documents, so it covers every field that can
 * affect the image by construction — a new field cannot be forgotten here and
 * serve a stale frame.
 */
async function renderEffectPreview(
  motion: SceneMotionDocument | null,
  overlays: SceneOverlayDocument[],
  backdrop: string | null,
  aspect?: string,
): Promise<{ token: string; width: number; height: number }> {
  // v1.4.15 — this preview MUST follow the ratio. Corner logos, lower thirds,
  // gradient scrims and cinematic bars are all laid out against the frame, so a
  // landscape preview of an overlay bound for a portrait render is exactly the
  // "looks shipped" lie this release set out to avoid.
  const { w: W, h: H } = canvasForShortEdge(PREVIEW_SHORT_EDGE, aspect)
  const FPS = EFFECT_PREVIEW_FPS, DURATION = EFFECT_PREVIEW_DURATION
  const key = [
    'effect-v1',
    backdrop || 'synthetic',
    `${W}x${H}@${DURATION}`,
    JSON.stringify(motion),
    JSON.stringify(overlays),
  ].join('|')

  await getOrRender(key, 'webm', async (outPath) => {
    const args: string[] = ['-y']
    if (backdrop && existsSync(backdrop)) {
      args.push(...(await stillDecoderArgs(backdrop)), '-loop', '1', '-t', DURATION.toString(), '-i', backdrop)
    } else {
      // Supersampled so a zoom has real pixels to move into, exactly as the
      // animation preview does.
      //
      // Every parameter here is pinned, and both of the pins are load-bearing.
      // `gradients` ANIMATES by default, so an un-pinned backdrop would make a
      // static effect look like it was moving. It also picks its ramp endpoints
      // at RANDOM when they are left unset, so two previews of the same effect
      // came out over different backdrops — which is confusing to look at and
      // made this suite's own before/after pixel comparisons meaningless until
      // it was tracked down.
      args.push('-f', 'lavfi', '-t', DURATION.toString(),
        '-i', `gradients=size=${W * 2}x${H * 2}:type=linear:c0=0xD38B5D:c1=0x5D8FD3`
          + `:x0=0:y0=0:x1=${W * 2}:y1=0:nb_colors=2:seed=0:speed=0:r=${FPS}`)
    }

    // The motion is a linear chain; the overlays are labelled statements that
    // may branch. One filtergraph carries both.
    const motionChain = motion
      ? compileSceneMotion(motion, { w: W, h: H, fps: FPS, duration: DURATION })
      : [`scale=${W}:${H}:force_original_aspect_ratio=decrease`,
         `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`, 'setsar=1']

    let index = 0
    const alloc = () => `[e${index++}]`
    let label = alloc()
    const statements: string[] = [`[0:v]${motionChain.join(',')}${label}`]
    for (const overlay of overlays) {
      const next = alloc()
      const compiled = compileSceneOverlay(overlay, {
        input: label, output: next, allocLabel: alloc,
        w: W, h: H, duration: DURATION,
      })
      if (!compiled) continue
      statements.push(...compiled)
      label = next
    }
    // `setparams` is load-bearing, not decoration. A `movie=` branch converted
    // to RGBA tags the composed frames with a GBR colour matrix that survives
    // `format=yuv420p`, and libvpx-vp9 writes that tag into a Profile-0 stream
    // no decoder will accept — the clip encodes without error and then plays
    // back as zero frames. Retagging bt709 before the encoder sees it is the
    // fix. The real render path is unaffected: its base is a decoded yuv420p
    // mp4, so the overlay never negotiates RGB in the first place.
    statements.push(
      `${label}format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709[vout]`,
    )

    args.push('-filter_complex', statements.join(';'))
    args.push('-map', '[vout]')
    args.push('-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'realtime', '-row-mt', '1')
    args.push('-pix_fmt', 'yuv420p', '-r', FPS.toString(), '-an')
    args.push('-t', DURATION.toString())
    args.push(outPath)
    // Previews are short clips; 90s only trips on a genuine wedge (the five
    // zombie preview ffmpegs of 2026-07-05 ran 30+ minutes unbounded).
    await runFfmpeg(args, { timeoutMs: 90_000 })
  })

  return { token: cacheToken(key, 'webm'), width: W, height: H }
}

/**
 * Resolve what the client asked to preview.
 *
 * An overlay may arrive either as a library id (with optional field patches) or
 * as a complete document. A complete document is validated STRICTLY, so an
 * effect authored for a newer engine names its unknown field instead of quietly
 * previewing as something else.
 */
function resolvePreviewOverlays(body: any, library: SceneEffectLibrary): SceneOverlayDocument[] {
  const requested: any[] = Array.isArray(body?.overlays) ? body.overlays
    : body?.overlay ? [body.overlay]
    : []
  return requested.slice(0, 8).map((item) => {
    if (item && typeof item.id === 'string') {
      const entry = library.overlays.find(candidate => candidate.id === item.id)
      if (!entry) throw new SceneEffectValidationError([`unknown effect "${item.id}"`])
      return item.params
        ? normalizeSceneOverlay({ ...entry.document, ...item.params, kind: entry.document.kind })
        : entry.document
    }
    return parseSceneOverlayDocument(item)
  })
}

/**
 * Resolve the motion to preview.
 *
 * `motion_source` is required to disambiguate, not optional politeness: six of
 * the seven footage ids also name a scene animation, and the two render
 * differently on purpose (see MOTION_SOURCES). Searching one registry then the
 * other would have made `pan-left` silently mean the still version forever.
 */
function resolvePreviewMotion(body: any, library: SceneEffectLibrary): SceneMotionDocument | null {
  if (body?.motion && typeof body.motion === 'object') return parseSceneMotionDocument(body.motion)
  if (typeof body?.motion_id !== 'string') return null
  const footage = body?.motion_source === 'footage'
  const registry = footage ? library.footage_motions : library.scene_motions
  const entry = registry.find(candidate => candidate.id === body.motion_id)
  if (entry) return entry.document
  throw new SceneEffectValidationError([
    `unknown ${footage ? 'B-Roll' : 'scene'} motion "${body.motion_id}"`,
  ])
}

router.post('/projects/:slug/video-editor/preview-effect', async (req, res) => {
  const { slug } = req.params
  try {
    const body = req.body || {}
    const library = await listSceneEffectLibrary()
    const overlays = resolvePreviewOverlays(body, library)
    const motion = resolvePreviewMotion(body, library)
    if (overlays.some(o => o.kind === 'lower-third') && !await hasDrawtextFilter()) {
      return res.status(501).json({ detail: 'FFmpeg build lacks drawtext — text overlays cannot be rendered' })
    }
    const backdrop = await subtitlePreviewBackdrop(slug, typeof body.episode === 'string' ? body.episode : undefined)
    const preview = await renderEffectPreview(motion, overlays, backdrop, body.aspect_ratio)
    res.json({
      token: preview.token,
      url: `/api/projects/${encodeURIComponent(slug)}/video-editor/preview-effect?token=${encodeURIComponent(preview.token)}`,
      duration_sec: EFFECT_PREVIEW_DURATION,
      width: preview.width,
      height: preview.height,
      approximations: overlays
        .map(o => library.overlays.find(b => b.document.kind === o.kind)?.approximation)
        .filter(Boolean),
    })
  } catch (e: any) {
    if (e instanceof SceneEffectValidationError) return res.status(400).json({ detail: e.message })
    res.status(500).json(humanizeBackendError(e, 'Effect preview failed'))
  }
})

router.get('/projects/:slug/video-editor/preview-effect', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : ''
  const file = token ? cachedFileForToken(token) : null
  if (!file) return res.status(404).json({ detail: 'Preview expired — render it again.' })
  streamPreview(res, file)
})

// ── Subtitles ────────────────────────────────────────────────────────────
// Three sources, matching the wizard's three tabs:
//   - import   : copy a user-picked .srt/.vtt into the episode's subtitles folder
//   - transcribe: queue a transcription job (handled by the job queue; see executors.ts)
// Both produce a plain .srt on disk; the burn-in filter in the
// generator reads it during the final composition pass.

/** Check what source options are actually usable for the current episode. */
router.get('/projects/:slug/video-editor/subtitles/status/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const [assets, libass, assembly] = await Promise.all([
      scanEpisodeAssets(slug, episodeId),
      hasLibass(),
      inspectAudioAssemblyReadiness(slug, episodeId),
    ])

    const subtitlesDir = await resolveSubtitlesDir(slug, episodeId)
    interface ExistingSrt {
      path: string
      filename: string
      mtime: number
      /**
       * v1.1.0 — whether this transcript was requested WITH per-word timings.
       *   'banked'  — asked for and stored upstream, so word-by-word captions
       *               can become exact for free once GenStudio serves them.
       *   'none'    — transcribed before Story Studio started asking. Word
       *               modes interpolate unless it is re-transcribed.
       *   'unknown' — imported, stitched, or otherwise not the direct output of
       *               a transcription request this episode has a record of.
       */
      word_timings: 'banked' | 'none' | 'unknown'
      /**
       * v1.2.2 — text-quality inspection of this file's cues. Advisory only:
       * nothing downstream gates on it, and the file is never edited. See
       * `lib/subtitle-quality.ts` for the rules and their measured flag rates.
       */
      quality: SubtitleQualityReport | null
    }
    // The transcription manifest is the only local record of what was asked
    // for. No manifest entry means 'unknown' — the honest answer, not a guess.
    const transcriptionManifest = await readManifest(subtitlesDir).catch(() => null)
    const existingSrts: ExistingSrt[] = []
    try {
      const entries = await fs.readdir(subtitlesDir)
      for (const f of entries) {
        if (!/\.(srt|vtt|ass)$/i.test(f)) continue
        const full = path.join(subtitlesDir, f)
        const stat = await fs.stat(full)
        const task = transcriptionManifest?.tasks?.[f]
        const wordTimings: ExistingSrt['word_timings'] = !task || task.operation !== 'transcription'
          ? 'unknown'
          : task.word_timestamps === true ? 'banked' : 'none'
        // Text quality. ASS is a styling document rather than a plain
        // transcript, so it is reported as unchecked (null) instead of being
        // run through cue rules it would trip on markup alone.
        let quality: SubtitleQualityReport | null = null
        if (/\.(srt|vtt)$/i.test(f)) {
          quality = await fs.readFile(full, 'utf-8')
            .then(inspectSubtitleText)
            .catch(() => null)
        }
        existingSrts.push({ path: full, filename: f, mtime: stat.mtimeMs, word_timings: wordTimings, quality })
      }
      existingSrts.sort((a, b) => b.mtime - a.mtime)
    } catch { /* no dir yet — fine */ }

    const stitchedPath = path.join(subtitlesDir, `${episodeId.toUpperCase()}_stitched.srt`)
    const planningTranscript = existsSync(stitchedPath)
      ? await inspectExistingTranscriptSource(subtitlesDir, episodeId)
      : null
    const subtitleTimelineIntegrity = existsSync(stitchedPath)
      ? await readSubtitleTimelineIntegrity(subtitlesDir, episodeId, {
        max_cue_gap_sec: allowedSubtitleCueGapSec(),
        cue_source_path: planningTranscript?.path,
      })
      : null

    res.json({
      has_libass: libass,
      has_merged_audio: assembly.merged_audio_ready,
      has_chapter_audio: assembly.ready,
      audio_assembly_ready: assembly.audio_assembly_ready,
      audio_assembly_issues: assembly.issues,
      existing_srts: existingSrts,
      subtitles_dir: subtitlesDir,
      // v1.0.396 — the user-pinned subtitle to burn (null = AUTO: prefer the
      // full stitched/whisper transcript, skip per-chapter partials).
      selected_subtitle: await readSelectedSubtitle(subtitlesDir),
      // v1.4.0 — the file a render would actually burn, decided by the SAME
      // resolver the renderer uses rather than mirrored in the browser. Video
      // Assembly no longer picks a transcript; it displays this. A second copy
      // of the precedence rule living in the frontend is exactly how a page
      // comes to show one filename while the encoder burns another.
      burn_target: await resolveBurnSubtitle(subtitlesDir)
        .then(p => (p ? path.basename(p) : null))
        .catch(() => null),
      completion: await inspectSubtitleCompletion(assets.episode_dir, subtitlesDir, episodeId),
      timeline_integrity: subtitleTimelineIntegrity,
      planning_transcript_source: planningTranscript?.source ?? null,
      planning_source_revalidation_required: planningTranscript?.planning_source_revalidation_required ?? false,
      // v1.4.0 — the Scene Plan is GENERATED FROM the stitched transcript, so an
      // automatic re-stitch that moves the timeline leaves an existing plan's
      // scene times describing the old one. Repairing the captions while
      // silently leaving the pictures drifted would be the worst outcome
      // available, so the disagreement is reported here. Detection only: nothing
      // rewrites a plan that generated images hang off.
      scene_plan_timeline: await resolveScenePlanPath(slug, episodeId, assets.episode_dir)
        .then(planPath => inspectPlanTimelineDrift(planPath, path.join(subtitlesDir, `${episodeId.toUpperCase()}_stitched.srt`)))
        .catch(() => ({ checked: false, stale: false, drift_sec: null, reason: '' })),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not compute subtitle status'))
  }
})

/** Import a user-picked .srt/.vtt file into the episode's subtitles folder,
 *  normalizing it in the process. The client hands us the source path (via
 *  FilePicker); we copy+normalize rather than referencing the original so
 *  the subtitle stays with the episode even if the source is deleted. */
router.post('/projects/:slug/video-editor/subtitles/import/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params

  const srcPath = req.body?.source_path as string | undefined
  if (!srcPath) return res.status(400).json({ detail: 'source_path is required' })
  if (!existsSync(srcPath)) return res.status(400).json({ detail: 'source file not found' })
  if (!/\.(srt|vtt)$/i.test(srcPath)) {
    return res.status(400).json({ detail: 'Only .srt and .vtt files can be imported' })
  }

  try {
    const raw = await fs.readFile(srcPath, 'utf-8')
    const { srt, cues, warnings } = normalizeSrtOrVtt(raw, { source_filename: srcPath })
    if (cues === 0) return res.status(400).json({ detail: 'File had zero valid cues' })

    const outDir = await resolveSubtitlesDir(slug, episodeId)
    await fs.mkdir(outDir, { recursive: true })
    const outPath = path.join(outDir, `${episodeId.toUpperCase()}_imported.srt`)
    await fs.writeFile(outPath, srt, 'utf-8')

    res.json({ srt_path: outPath, cues, warnings })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Subtitle import failed'))
  }
})

/** Queue a transcription job. Returns the job id so the UI can
 *  poll /jobs/:id for progress. */
router.post('/projects/:slug/video-editor/subtitles/buy-missing/:jobId', async (req, res) => {
  const { slug, jobId } = req.params
  try {
    return await withLock(`subtitle-purchase:${slug}`, async () => {
      const source = await loadAuthoritativeJob(slug, jobId)
      if (!source || source.project_slug !== slug) return res.status(404).json({ detail: 'Subtitle job not found.' })
      const params = subtitlePurchaseParams(source, req.body?.additional_credit_ceiling)
      params.subtitle_finalizer_job_id = subtitleFinalizerJobId(source)
      const job = await enqueueEpisodeRecoveryOnce(`subtitle-purchase-${jobId}`, { project_slug: slug, episode_id: source.episode_id,
        type: 'subtitles_transcribe', title: `Buy missing subtitles (${source.episode_id})`, params })
      return res.status(201).json(job)
    })
  } catch (error) {
    return res.status(409).json({ detail: error instanceof Error ? error.message : 'Subtitle purchase is unavailable.' })
  }
})

router.post('/projects/:slug/video-editor/subtitles/transcribe/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params

  try {
    await requireAudioAssemblyReady(slug, episodeId)
  } catch (error: any) {
    return res.status(409).json({
      detail: error?.message || 'Transcription requires a completed Audio Assembly first.',
    })
  }

  const { getApiKey } = await import('../services/app-secrets-store.js')
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey.trim()) {
    return res.status(400).json({
      detail: 'Transcription is not configured. Add an API key in Settings → This Mac → API Keys.',
    })
  }
  let models
  try {
    models = await listGenStudioTranscriptionModels(apiKey)
  } catch {
    return res.status(502).json({ detail: 'Could not load transcription models. Check your connection and try again.' })
  }
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const migratedModel = resolveGenStudioModelId('transcription', requestedModel)
  if (!migratedModel) {
    return res.status(409).json({ detail: unavailableLegacyModelMessage('transcription', requestedModel || '(none)') })
  }
  const selectedModel = models.find(model => model.id === migratedModel)
  if (!selectedModel) {
    return res.status(400).json({
      detail: requestedModel
        ? 'The selected transcription model is no longer available.'
        : 'No transcription model is available right now.',
    })
  }
  if (!selectedModel.available) {
    return res.status(503).json({
      detail: 'The selected transcription model is temporarily unavailable.',
    })
  }
  if (selectedModel.locked) {
    return res.status(409).json({ detail: 'The selected transcription model is locked for this GenStudio account. Choose an unlocked model.' })
  }
  const requestedLanguage = typeof req.body?.language === 'string' ? req.body.language : undefined
  try {
    resolveTranscriptionLanguage(selectedModel, requestedLanguage)
  } catch (error: any) {
    return res.status(400).json({ detail: error?.message || 'Select a published transcription language before continuing.' })
  }
  const deliberateFresh = req.body?.force === true
  let operationId: string | null
  try {
    operationId = readOperationId(req.body, deliberateFresh)
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  const params = {
    episode_id: episodeId,
    language: requestedLanguage,
    model: selectedModel.id,
    audio_path: req.body?.audio_path,
    force: deliberateFresh,
    per_chapter: req.body?.per_chapter === true,
    sections: Array.isArray(req.body?.sections)
      ? (req.body.sections as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : undefined,
    engine: 'genstudio',
  }
  const queuedParams: Record<string, any> = operationId ? stampFreshGenerationAction(params, operationId) : params
  const enqueueSubtitles = async () => {
    if (operationId) {
      const previous = findFreshActionJob(await getJobs(slug), operationId)
      if (previous) {
        if (previous.params.generation_action_fingerprint !== queuedParams.generation_action_fingerprint) {
          return res.status(409).json({ detail: 'This operation_id already belongs to a different subtitle request.' })
        }
        return res.status(200).json({ ...previous, reused: true })
      }
    }
    if (isDuplicate(slug, episodeId, 'subtitles_transcribe')) {
      return res.status(409).json({ detail: `Transcription already running for ${episodeId}` })
    }

    const job = await enqueue({
      project_slug: slug,
      type: 'subtitles_transcribe',
      episode_id: episodeId,
      title: `Transcribe subtitles (${episodeId})`,
      params: queuedParams,
    })
    return res.status(201).json(job)
  }
  if (operationId) return withLock(`fresh-subtitles:${slug}:${operationId}`, enqueueSubtitles)
  return enqueueSubtitles()
})

/** v1.0.135+ — Delete a single subtitle file from an episode's
 *  subtitles_dir. Lets the user remove a generated/imported subtitle
 *  from inside the app instead of opening Finder.
 *
 *  Strict path validation:
 *   - filename must not contain path separators (`/` or `\`) — blocks
 *     traversal attempts like `../../something`.
 *   - filename must end in `.srt`, `.vtt`, or `.ass` — the same shapes
 *     the burn-in path recognises. We don't delete arbitrary files in
 *     the subtitles dir.
 *   - filename must not start with `.` — protects any future hidden
 *     temp/staging files from collateral deletes.
 *
 *  Returns the updated `existing_srts` list (same shape as the status
 *  endpoint) so the frontend can swap state in-place without a second
 *  GET. */
router.delete('/projects/:slug/video-editor/subtitles/:episodeId/:filename', async (req, res) => {
  const { slug, episodeId, filename } = req.params

  if (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.startsWith('.') ||
    !/\.(srt|vtt|ass)$/i.test(filename)
  ) {
    return res.status(400).json({ detail: `Invalid subtitle filename: ${filename}` })
  }

  try {
    const subtitlesDir = await resolveSubtitlesDir(slug, episodeId)
    const target = path.join(subtitlesDir, filename)

    try {
      await fs.unlink(target)
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        return res.status(404).json({ detail: `Subtitle file not found: ${filename}` })
      }
      throw e
    }

    // Return the fresh listing so the caller can swap state in-place.
    const existingSrts: Array<{ path: string; filename: string; mtime: number }> = []
    try {
      const entries = await fs.readdir(subtitlesDir)
      for (const f of entries) {
        if (!/\.(srt|vtt|ass)$/i.test(f)) continue
        const full = path.join(subtitlesDir, f)
        const stat = await fs.stat(full)
        existingSrts.push({ path: full, filename: f, mtime: stat.mtimeMs })
      }
      existingSrts.sort((a, b) => b.mtime - a.mtime)
    } catch { /* dir gone after the unlink — fine, just return empty */ }

    res.json({ existing_srts: existingSrts, deleted: filename })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not delete subtitle file'))
  }
})

/** v1.0.494 — Read a subtitle file's parsed cues so the Subtitles tab can PREVIEW
 *  the generated text + timings and the user can verify accuracy without opening
 *  Finder. Same strict basename/extension validation as the delete route (no
 *  traversal, only .srt/.vtt/.ass). Returns { filename, cue_count, total_duration_sec,
 *  cues: [{ index, start_sec, end_sec, text }] }. Caps cues returned so a huge
 *  file can't balloon the response — `truncated` flags when the cap was hit. */
router.get('/projects/:slug/video-editor/subtitles/content/:episodeId/:filename', async (req, res) => {
  const { slug, episodeId, filename } = req.params

  if (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.startsWith('.') ||
    !/\.(srt|vtt|ass)$/i.test(filename)
  ) {
    return res.status(400).json({ detail: `Invalid subtitle filename: ${filename}` })
  }

  try {
    const subtitlesDir = await resolveSubtitlesDir(slug, episodeId)
    const target = path.join(subtitlesDir, filename)
    let raw: string
    try {
      raw = await fs.readFile(target, 'utf-8')
    } catch (e: any) {
      if (e?.code === 'ENOENT') return res.status(404).json({ detail: `Subtitle file not found: ${filename}` })
      throw e
    }

    // .ass isn't cue-parseable here — return the raw text so the UI can still
    // show it; .srt/.vtt parse into structured cues (parseSrt handles both the
    // `,` and `.` millisecond separators VTT/SRT use).
    const isAss = /\.ass$/i.test(filename)
    const allCues = isAss ? [] : parseSrt(raw)
    const MAX_CUES = 2000
    const cues = allCues.slice(0, MAX_CUES)
    const totalDuration = allCues.length ? Math.max(...allCues.map(c => c.end_sec)) : 0

    res.json({
      filename,
      is_ass: isAss,
      cue_count: allCues.length,
      truncated: allCues.length > MAX_CUES,
      total_duration_sec: totalDuration,
      cues,
      raw: isAss ? truncateChars(raw, 20000) : undefined,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read subtitle file'))
  }
})

/** v1.0.396 — PIN which subtitle file the next assembly burns.
 *  Body: { filename: "<basename>" } to pin, or { filename: null|"" } to clear
 *  (revert to AUTO). Returns { selected_subtitle }. */
router.put('/projects/:slug/video-editor/subtitles/select/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  const raw = req.body?.filename
  const filename = typeof raw === 'string' ? raw.trim() : ''

  // Validate non-empty pins the same way the delete route does (basename, burnable).
  if (filename && (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.startsWith('.') ||
    !/\.(srt|vtt|ass)$/i.test(filename)
  )) {
    return res.status(400).json({ detail: `Invalid subtitle filename: ${filename}` })
  }

  try {
    const subtitlesDir = await resolveSubtitlesDir(slug, episodeId)
    // Only allow pinning a file that actually exists (avoid a dangling pin).
    if (filename) {
      const target = path.join(subtitlesDir, filename)
      if (!existsSync(target)) {
        return res.status(404).json({ detail: `Subtitle file not found: ${filename}` })
      }
    }
    await writeSelectedSubtitle(subtitlesDir, filename || null)
    res.json({ selected_subtitle: filename || null })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not set subtitle selection'))
  }
})

// ── Subtitle style preview ──────────────────────────────────────────────────
//
// The preview is the SAME ASS document the real burn produces, rendered at a
// smaller PlayRes. That is the whole point of it: `buildSubtitleAssDocument`
// scales every `_px` field by height/1080 and sets PlayRes to the output size,
// so a 640x360 preview and a 1920x1080 burn describe one caption at two
// resolutions. If this endpoint ever grows its own styling logic, the preview
// stops being evidence and becomes decoration.
//
// v1.1.0 changed three things:
//   - 4 seconds, not 1.5, and a twelve-word sentence, not one short line. A
//     word-by-word sweep cannot be judged in 1.5 seconds on four words.
//   - The style arrives as a v2 document in a POST body. Thirty-plus scalars
//     in a querystring was already at its limit and the schema is far larger
//     now; the POST renders and returns a cache token, and a plain GET streams
//     it so the result is still usable as a `<video src>`.
//   - The legacy scalar querystring still works, normalised through the same
//     path, so nothing that already links at this endpoint breaks.

// v1.3.2 — the render size lives in contracts/subtitle-preview.ts so the
// faithfulness test compares the size that actually renders against the burn,
// rather than keeping its own copy of a number this file could change.

/** Resolve the backdrop for a preview — the episode's first scene, or null. */
async function subtitlePreviewBackdrop(slug: string, episodeId?: string): Promise<string | null> {
  if (!episodeId) return null
  try {
    const assets = await scanEpisodeAssets(slug, episodeId)
    return assets.scenes[0]?.path || null
  } catch {
    return null   // fall through to the synthetic gradient
  }
}

/**
 * Render the preview clip for one style, returning its cache token.
 *
 * The cache key is the serialised style document itself, so it covers every
 * field that can affect the image by construction — a new field cannot be
 * forgotten here and serve a stale frame.
 */
async function renderSubtitlePreview(
  style: SubtitleStyleDocument,
  sampleText: string,
  backdrop: string | null,
  aspect?: string,
): Promise<{ token: string; width: number; height: number }> {
  // v1.4.15 — the preview is drawn at the render's own SHAPE. Where a caption
  // wraps, how wide its margins sit and how many lines it takes are the things
  // this preview exists to show, and none of them survive a change of ratio.
  const { w: W, h: H } = canvasForShortEdge(SUBTITLE_PREVIEW_SHORT_EDGE, aspect)
  const FPS = SUBTITLE_PREVIEW_FPS
  const DURATION = SUBTITLE_PREVIEW_DURATION
  const key = [
    'subtitle-v4',
    sampleText.slice(0, 160),
    backdrop || 'synthetic',
    `${W}x${H}@${DURATION}`,
    JSON.stringify(style),
  ].join('|')

  await getOrRender(key, 'webm', async (outPath) => {
    // One cue spanning the clip, wrapped in the same SRT the burn would read.
    const cueText = sampleText.replace(/\r?\n/g, ' ')
    const srt = `1\n00:00:00,150 --> 00:00:0${Math.max(1, Math.floor(DURATION))},000\n${cueText}\n`
    const assFile = path.join(path.dirname(outPath), `${path.basename(outPath, '.webm')}.ass`)
    const rendered = buildSubtitleAssDocument(parseSrt(srt), style, { width: W, height: H })
    await fs.writeFile(assFile, rendered.ass, 'utf-8')
    const args: string[] = ['-y']
    if (backdrop && existsSync(backdrop)) {
      args.push(...(await stillDecoderArgs(backdrop)), '-loop', '1', '-t', DURATION.toString(), '-i', backdrop)
    } else {
      args.push('-f', 'lavfi', '-t', DURATION.toString(),
        '-i', `gradients=size=${W}x${H}:type=linear:c0=0x1a1a2e:c1=0x16213e:r=${FPS}`)
    }
    args.push('-vf',
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,ass=filename=${escapeFilterPath(assFile)},format=yuv420p`,
    )
    args.push('-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'realtime', '-row-mt', '1')
    args.push('-pix_fmt', 'yuv420p', '-r', FPS.toString(), '-an')
    args.push('-t', DURATION.toString())
    args.push(outPath)
    // v1.0.515 — previews are short clips; 90s only trips on a genuine wedge
    // (the 5 zombie preview ffmpegs of 2026-07-05 ran 30+ min unbounded).
    try {
      await runFfmpeg(args, { timeoutMs: 90_000 })
    } finally {
      // A failed preview must not accumulate subtitle documents in cache.
      try { await fs.unlink(assFile) } catch {}
    }
  })

  return { token: cacheToken(key, 'webm'), width: W, height: H }
}

function streamPreview(res: any, file: string): void {
  const stat = statSync(file)
  res.set('Content-Type', 'video/webm')
  res.set('Content-Length', stat.size.toString())
  res.set('Cache-Control', 'public, max-age=86400')
  createReadStream(file).pipe(res)
}

/**
 * POST the style document; get back a token plus the URL that streams it.
 * The body is validated strictly — an unknown field is named in the error
 * rather than silently ignored, so a style authored for a newer engine fails
 * loudly instead of previewing as something else.
 */
router.post('/projects/:slug/video-editor/preview-subtitles', async (req, res) => {
  const { slug } = req.params
  if (!await hasLibass()) {
    return res.status(501).json({ detail: 'FFmpeg build lacks libass — subtitles cannot be rendered' })
  }
  try {
    const body = req.body || {}
    const style = body.style && typeof body.style === 'object'
      ? parseSubtitleStyleDocument(body.style)
      : normalizeSubtitleStyle(body.style)
    const sampleText = typeof body.text === 'string' && body.text.trim()
      ? truncateChars(String(body.text), 400)
      : SUBTITLE_PREVIEW_SAMPLE
    const backdrop = await subtitlePreviewBackdrop(slug, typeof body.episode === 'string' ? body.episode : undefined)
    const preview = await renderSubtitlePreview(style, sampleText, backdrop, body.aspect_ratio)
    res.json({
      token: preview.token,
      url: `/api/projects/${encodeURIComponent(slug)}/video-editor/preview-subtitles?token=${encodeURIComponent(preview.token)}`,
      duration_sec: SUBTITLE_PREVIEW_DURATION,
      width: preview.width,
      height: preview.height,
      word_precision: style.word.mode === 'off' ? null : 'estimated',
    })
  } catch (e: any) {
    if (e instanceof SubtitleStyleValidationError) return res.status(400).json({ detail: e.message })
    res.status(500).json(humanizeBackendError(e, 'Subtitle preview failed'))
  }
})

/**
 * GET the rendered clip.
 *
 * `?token=` streams a clip a POST already produced — the normal path. Without
 * a token the legacy flat query parameters are accepted and normalised, which
 * keeps every previously-shipped caller working unchanged.
 */
router.get('/projects/:slug/video-editor/preview-subtitles', async (req, res) => {
  const { slug } = req.params
  const token = typeof req.query.token === 'string' ? req.query.token : ''
  if (token) {
    const file = cachedFileForToken(token)
    if (!file) return res.status(404).json({ detail: 'Preview expired — render it again.' })
    return streamPreview(res, file)
  }

  if (!await hasLibass()) {
    return res.status(501).json({ detail: 'FFmpeg build lacks libass — subtitles cannot be rendered' })
  }
  const sampleText = typeof req.query.text === 'string' && req.query.text.length > 0
    ? String(req.query.text)
    : SUBTITLE_PREVIEW_SAMPLE
  // Legacy flat query shape. `normalizeSubtitleStyle` upgrades it to a v2
  // document, so this path and the POST path render through identical code.
  const legacy: VideoSubtitleStyle = {
    font_family: (req.query.font_family as string) || 'Helvetica',
    font_size_px: Number(req.query.font_size_px) || 28,
    color_hex: (req.query.color_hex as string) || '#FFFFFF',
    outline_color_hex: (req.query.outline_color_hex as string) || '#000000',
    outline_px: Number(req.query.outline_px) || 2,
    background: ((req.query.background as any) || 'none'),
    position: ((req.query.position as any) || 'bottom'),
    align: ((req.query.align as any) || 'center'),
    position_x_pct: req.query.position_x_pct == null ? undefined : Number(req.query.position_x_pct),
    position_y_pct: req.query.position_y_pct == null ? undefined : Number(req.query.position_y_pct),
    safe_margin_pct: req.query.safe_margin_pct == null ? undefined : Number(req.query.safe_margin_pct),
    max_chars_per_line: Number(req.query.max_chars_per_line) || 42,
    max_lines: Number(req.query.max_lines) || 2,
    animation: ((req.query.animation as any) || 'none'),
  }
  try {
    const backdrop = await subtitlePreviewBackdrop(slug, req.query.episode as string | undefined)
    const produced = await renderSubtitlePreview(
      normalizeSubtitleStyle(legacy), sampleText, backdrop, req.query.aspect_ratio as string | undefined,
    )
    const file = cachedFileForToken(produced.token)
    if (!file) throw new Error('preview render produced no readable output')
    streamPreview(res, file)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Subtitle preview failed'))
  }
})

// Queue an FFmpeg video-assembly job (scenes + narration → final .mp4).
/**
 * Caption preflight — three frames of the video you are about to render, with
 * the real captions burned in (v1.4.0).
 *
 * *"give 3 screenshot in different parts of the video as rendered with the video
 * so we can judge the subtitle is correct before we render the video"*. He found
 * the wrong episode's captions by watching a finished render; three stills make
 * the same fault obvious in seconds, before any encode.
 *
 * This deliberately runs the FULL `prepareUnifiedVideoAssemblyInputs`, not a
 * cheaper subset. Everything the render would do to choose and validate a
 * transcript — bringing the stitch up to date, picking the burn target, refusing
 * a file belonging to another episode — happens here first, so a frame is never
 * produced from inputs the render would have rejected, and a refusal is reported
 * before a person has waited for an encode. The response body is therefore also
 * the answer to "would this render succeed?".
 */
/**
 * Is a caption check still describing the file it was drawn from?
 *
 * Deliberately cheap — one `stat`, no ffmpeg, no episode assembly — because
 * the page asks on every focus. A check whose freshness costs as much as the
 * check itself would simply not get asked.
 */
router.get('/projects/:slug/video-editor/subtitle-preflight/:episodeId/fingerprint', async (req, res) => {
  try {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!rawPath) return res.status(400).json({ detail: 'path query parameter required' })
    const outputRoot = (await pm.getProjectOutputRoot(req.params.slug)) || undefined
    if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })
    let filePath = rawPath
    try {
      // See preview-audio above — absolute episodes dir, not the old
      // relative `output_root` field.
      filePath = resolveAssetPath(rawPath, outputRoot)
    } catch (e: any) {
      return res.status(400).json(humanizeBackendError(e, 'Could not resolve subtitle path'))
    }
    try {
      const st = await fs.stat(filePath)
      res.json({ fingerprint: { mtime_ms: Math.round(st.mtimeMs), size: st.size } })
    } catch {
      // Gone is a change too — a deleted burn target must invalidate the check
      // rather than leave it looking authoritative.
      res.json({ fingerprint: null, missing: true })
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not check the subtitle file'))
  }
})

router.post('/projects/:slug/video-editor/subtitle-preflight/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = { ...(req.body || {}), episode_id: episodeId }
  try {
    const assets = await prepareUnifiedVideoAssemblyInputs(slug, episodeId, body)
    const { w, h } = resolveRenderCanvas(body.resolution, body.aspect_ratio)
    // Whether the scene images fit the chosen frame is a question about the
    // RENDER, not about the captions, so it is answered even when subtitles are
    // switched off — which is precisely the case where nothing else would say it.
    const sourceAspect = await inspectSourceAspect(
      (body.scenes || []).map((s: any) => s?.image_path).filter(Boolean),
      w, h,
    ).catch(() => null)

    const srtPath = body.subtitles?.srt_path
    if (!body.subtitles?.enabled || !srtPath || !existsSync(srtPath)) {
      return res.json({
        frames: [],
        resolution: `${w}x${h}`,
        aspect_ratio: displayAspectRatio(body.aspect_ratio, w, h),
        source_aspect: sourceAspect,
        // Not an error: subtitles may simply be switched off, or this episode
        // may have no transcript at all. The page says which, rather than
        // showing an empty panel that looks like a broken feature.
        skipped: body.subtitles?.enabled
          ? 'This episode has no subtitle file to burn, so there is nothing to check.'
          : 'Subtitles are switched off for this render.',
      })
    }

    const openingSec = assets.scene_plan_timing?.opening_reserved_sec || 0
    // Same rule the renderer applies: captions sit out the opening when there
    // IS one, unless the customer said otherwise.
    const hideIntro = body.subtitles.hide_during_intro == null
      ? openingSec > 0
      : !!body.subtitles.hide_during_intro
    const allCues = parseSrt(await fs.readFile(srtPath, 'utf-8'))
    const cues = hideIntro ? trimCuesBeforeStoryStart(allCues, openingSec) : allCues
    if (!cues.length) {
      return res.status(409).json({
        detail: `${episodeId.toUpperCase()}'s subtitle file contains no usable cues, so there is nothing to burn. `
          + 'Open the Subtitles workspace and re-transcribe or re-stitch this episode.',
      })
    }

    // The narration is the honest denominator: it plays from the composed
    // video's t=0, so a cue's timestamp IS its position in the finished video.
    const durationSec = (await getAudioDuration(assets.merged_audio[0]!.path).catch(() => undefined))
      || cues[cues.length - 1]!.end_sec

    const result = await renderSubtitlePreflightFrames({
      episodeCode: episodeId.toUpperCase(),
      outDir: assets.video_dir,
      cues,
      subtitleFilename: path.basename(srtPath),
      style: normalizeSubtitleStyle(body.subtitles.style),
      width: w,
      height: h,
      scenes: (body.scenes || []).map((s: any) => ({ image_path: s.image_path, duration: s.duration })),
      openingOffsetSec: openingSec,
      durationSec,
      // The same merged narration the duration was measured from, so each
      // frame can be heard as well as read.
      narrationPath: assets.merged_audio[0]?.path || null,
    })
    // v1.4.22 — a fingerprint of the subtitle file these frames were drawn
    // from, so the page can tell when it is showing evidence about a file that
    // has since changed.
    //
    // The owner hit this on EP0051: he opened the check, saw captions that did
    // not match the narration under them, and was about to re-transcribe a
    // transcript that was already correct. The panel was holding a result from
    // before the last re-stitch — `EP0051_stitched.srt` had been rewritten
    // nine minutes after the run that produced what he was looking at.
    //
    // Stale evidence is worse here than no evidence. The whole point of this
    // check is to be the thing you trust before spending an hour on a render,
    // so it must never quietly answer a question about an older file.
    let subtitleFingerprint: { mtime_ms: number; size: number } | null = null
    try {
      const st = await fs.stat(srtPath)
      subtitleFingerprint = { mtime_ms: Math.round(st.mtimeMs), size: st.size }
    } catch { /* the frames are still valid; we just cannot offer a freshness check */ }

    res.json({
      ...result,
      resolution: `${w}x${h}`,
      aspect_ratio: displayAspectRatio(body.aspect_ratio, w, h),
      source_aspect: sourceAspect,
      duration_sec: durationSec,
      hide_during_intro: hideIntro,
      opening_reserved_sec: openingSec,
      subtitle_path: srtPath,
      subtitle_fingerprint: subtitleFingerprint,
    })
  } catch (e: any) {
    // 409 matches the render preflight: this is a "your episode is not ready"
    // answer, not a server fault, and the message already names the repair.
    res.status(409).json(humanizeBackendError(e, 'Caption preflight failed'))
  }
})

// Moved from /generate/video → /generate/video-assembly so the new AI
// Video Generator can own /generate/video.
router.post('/projects/:slug/generate/video-assembly', async (req, res) => {
  const { slug } = req.params

  const { episode_id, scene_recycling, duration } = req.body
  if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
  try {
    const source = await readVideoVisualSource(slug, episode_id)
    if (source.source === 'scene_plan') {
      const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episode_id, SCENE_PLAN_FILENAME)
      await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id, { episodeDir: paths.episode_dir, audioDir: paths.audio_dir })
      const planPath = await resolveScenePlanPath(slug, episode_id, paths.episode_dir)
      if (!existsSync(planPath)) throw new Error('No Scene Plan timeline was found.')
      const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      assertScenePromptsRenderable(plan.scenes)
    }
    await prepareUnifiedVideoAssemblyInputs(slug, episode_id, req.body)
  } catch (e: any) {
    return res.status(409).json({
      detail: e?.message || 'Video Assembly preflight failed. Repair Scene Plan or Scene Review, then retry.',
    })
  }

  // Provide defaults for new required fields if missing
  if (!scene_recycling) {
    req.body.scene_recycling = { seconds_per_scene: 10, shuffle: false, excluded_scenes: [] }
  }
  if (!duration) {
    req.body.duration = { mode: 'auto', min_duration: 0, max_duration: 0 }
  }

  if (isDuplicate(slug, episode_id, 'video_assembly')) {
    return res.status(409).json({ detail: `Video assembly already queued/running for ${episode_id}` })
  }

  // Final FFmpeg assembly is local. Strip retired render-target fields from
  // stale presets before the job is persisted.
  delete req.body.render_target
  delete req.body.remote_render_requested

  const job = await enqueue({
    project_slug: slug,
    type: 'video_assembly',
    episode_id,
    title: `Video Assembly (${req.body.scenes.length} scenes)`,
    params: req.body,
  })
  res.status(201).json(job)
})
