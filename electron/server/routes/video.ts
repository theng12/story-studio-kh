/**
 * Video editor routes — FFmpeg check, asset scanning, presets, and video generation.
 */

import { Router } from 'express'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import { enqueue, isDuplicate, setSubtitleTranscribeConcurrency } from '../services/job-queue.js'
import { checkFfmpeg, scanEpisodeAssets } from '../generators/video.js'
import { TRANSITIONS, groupedTransitions, getTransition } from '../models/transitions.js'
import { ANIMATIONS, groupedAnimations, getAnimation } from '../models/animations.js'
import { buildAnimationFilter } from '../lib/animation-filters.js'
import { getOrRender } from '../services/preview-cache.js'
import { resolveAssetPath } from '../services/path-resolver.js'
import { runFfmpeg, hasLibass, getAudioDuration } from '../lib/ffmpeg-utils.js'
import { chaptersFromDurations, chaptersToSrt, normalizeSrtOrVtt, buildAssStyle } from '../lib/subtitle-builder.js'
import { resolveSubtitlesDir } from '../generators/subtitles.js'
import { readSelectedSubtitle, writeSelectedSubtitle } from '../lib/subtitle-selection.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import type { VideoSubtitleStyle } from '../models/types.js'

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
// Compilation video layout (BrainWise / listicle channels) needs a
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

// GET / PUT the scene_chapter_assignments.json sidecar — per-scene
// chapter overrides for the per-scene clip-swap UI (v1.0.57+). The
// PUT validates that every chapter_slug exists in audio_chapters.json
// to catch typos at save time rather than render time.
router.get('/projects/:slug/video-editor/scene-chapter-assignments', async (req, res) => {
  const { slug } = req.params
  const episodeId = String(req.query.episode_id || '').trim()
  if (!episodeId) return res.status(400).json({ detail: 'episode_id query parameter required' })
  try {
    const episodeDir = await findEpisodeDirForRoute(slug, episodeId)
    if (!episodeDir) return res.json({ assignments: [], episode_dir: null, exists: false })
    const sidecarPath = path.join(episodeDir, 'scene_chapter_assignments.json')
    if (!existsSync(sidecarPath)) {
      return res.json({ assignments: [], episode_dir: episodeDir, exists: false })
    }
    const raw = await fs.readFile(sidecarPath, 'utf-8')
    const parsed = JSON.parse(raw) as {
      assignments?: Array<{ scene_number: number; chapter_slug: string }>
    }
    res.json({
      assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
      episode_dir: episodeDir,
      exists: true,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read scene_chapter_assignments.json'))
  }
})

router.put('/projects/:slug/video-editor/scene-chapter-assignments', async (req, res) => {
  const { slug } = req.params
  const episodeId = String(req.body?.episode_id || '').trim()
  if (!episodeId) return res.status(400).json({ detail: 'episode_id required in body' })
  try {
    const episodeDir = await findEpisodeDirForRoute(slug, episodeId)
    if (!episodeDir) return res.status(404).json({ detail: `Episode directory not found for ${episodeId}` })

    // Validate slug references against audio_chapters.json so a typo
    // can't survive into render time.
    const audioChaptersPath = path.join(episodeDir, 'audio_chapters.json')
    const knownSlugs = new Set<string>()
    if (existsSync(audioChaptersPath)) {
      try {
        const raw = await fs.readFile(audioChaptersPath, 'utf-8')
        const parsed = JSON.parse(raw) as { sections?: Array<{ slug: string }> }
        for (const s of parsed.sections || []) {
          if (typeof s?.slug === 'string') knownSlugs.add(s.slug)
        }
      } catch { /* tolerate */ }
    }

    const incoming = Array.isArray(req.body?.assignments) ? req.body.assignments : []
    const cleaned: Array<{ scene_number: number; chapter_slug: string }> = []
    const unknownSlugs = new Set<string>()
    for (const a of incoming) {
      if (typeof a?.scene_number !== 'number' || !Number.isFinite(a.scene_number)) continue
      if (typeof a?.chapter_slug !== 'string' || !a.chapter_slug) continue
      cleaned.push({
        scene_number: Math.round(a.scene_number),
        chapter_slug: a.chapter_slug,
      })
      if (knownSlugs.size > 0 && !knownSlugs.has(a.chapter_slug)) unknownSlugs.add(a.chapter_slug)
    }

    const sidecarPath = path.join(episodeDir, 'scene_chapter_assignments.json')
    await fs.writeFile(sidecarPath, JSON.stringify({ assignments: cleaned }, null, 2))
    res.json({
      ok: true,
      written: cleaned.length,
      sidecar_path: sidecarPath,
      unknown_slugs: Array.from(unknownSlugs),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not write scene_chapter_assignments.json'))
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
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const rawPath = req.query.path as string
  if (!rawPath) return res.status(400).json({ detail: 'path query parameter required' })
  let filePath = rawPath
  try {
    filePath = resolveAssetPath(rawPath, project.output_root)
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

// Serve an image file for preview (thumbnails, scene images, logos)
router.get('/projects/:slug/video-editor/preview-image', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const rawPath = req.query.path as string
  if (!rawPath) return res.status(400).json({ detail: 'path query parameter required' })
  let filePath = rawPath
  try {
    filePath = resolveAssetPath(rawPath, project.output_root)
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
    res.set('Cache-Control', 'public, max-age=3600')
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

  const W = 480, H = 270, FPS = 24
  const clipSec = 1 // each clip length (so xfade offset at duration - transition)
  const totalSec = clipSec + duration
  const keyParts = [
    'transition-v2',
    def.xfade,
    duration.toFixed(2),
    imgA ? `a:${imgA}` : 'a:synthetic-warm',
    imgB ? `b:${imgB}` : 'b:synthetic-cool',
  ]
  const key = keyParts.join('|')

  try {
    const cached = await getOrRender(key, 'webm', async (outPath) => {
      const args: string[] = ['-y']
      // Input A
      if (imgA && existsSync(imgA)) {
        args.push('-loop', '1', '-t', clipSec.toString(), '-i', imgA)
      } else {
        args.push('-f', 'lavfi', '-t', clipSec.toString(),
          '-i', `color=c=0xD38B5D:s=${W}x${H}:r=${FPS}`)
      }
      // Input B
      if (imgB && existsSync(imgB)) {
        args.push('-loop', '1', '-t', clipSec.toString(), '-i', imgB)
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
      await runFfmpeg(args)
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

router.get('/projects/:slug/video-editor/animations/catalog', async (req, res) => {
  const { slug } = req.params
  res.json({ animations: ANIMATIONS, grouped: groupedAnimations() })
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

  const W = 480, H = 270, FPS = 24, DURATION = 2
  const key = [
    'animation-v2',
    def.id,
    srcImage ? `img:${srcImage}` : 'img:synthetic',
  ].join('|')

  try {
    const cached = await getOrRender(key, 'webm', async (outPath) => {
      const args: string[] = ['-y']
      if (srcImage && existsSync(srcImage)) {
        args.push('-loop', '1', '-t', DURATION.toString(), '-i', srcImage)
      } else {
        // Use a gradient so motion is visually obvious on synthetic input.
        args.push(
          '-f', 'lavfi',
          '-t', DURATION.toString(),
          '-i', `gradients=size=${W * 2}x${H * 2}:type=linear:c0=0xD38B5D:c1=0x5D8FD3:r=${FPS}`,
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
      await runFfmpeg(args)
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

// ── Subtitles ────────────────────────────────────────────────────────────
// Three sources, matching the wizard's three tabs:
//   - chapters : derive from the episode's individual chapter audio files
//   - import   : copy a user-picked .srt/.vtt into the episode's subtitles folder
//   - transcribe: queue a Whisper job (handled by the job queue; see executors.ts)
// All three produce a plain .srt on disk; the burn-in filter in the
// generator reads it during the final composition pass.

/** Check what source options are actually usable for the current episode. */
router.get('/projects/:slug/video-editor/subtitles/status/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const [assets, libass, config] = await Promise.all([
      scanEpisodeAssets(slug, episodeId),
      hasLibass(),
      pm.getConfig(slug),
    ])

    const subtitlesDir = await resolveSubtitlesDir(slug, episodeId)
    // v1.0.140+ — Drift detection prep: read the current audio-merge
    // gap from audio_chapters.json (written by the audio-merge job).
    // Each existing SRT's parallel `.srt.json` records the gap that
    // SRT was generated against. Compare to surface a warning when
    // the user re-merged with a different gap but never re-derived
    // the subtitle — the burn-in would drift section-by-section.
    let currentMergeGap: number | null = null
    try {
      const sidecarPath = path.join(assets.episode_dir, 'audio_chapters.json')
      const raw = await fs.readFile(sidecarPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed?.gap_duration_s === 'number') {
        currentMergeGap = parsed.gap_duration_s
      }
    } catch { /* missing sidecar — old merge or no merge yet */ }

    interface ExistingSrt {
      path: string
      filename: string
      mtime: number
      /** v1.0.140+ — gap value this SRT was generated against, when known. */
      generated_with_gap_s?: number | null
      /** v1.0.140+ — true when generated_with_gap_s !== currentMergeGap.
       *  Frontend renders a warning chip on the row when this is true. */
      drifts_from_current_merge?: boolean
      /** Best-effort human description of the drift severity. */
      drift_note?: string
    }
    const existingSrts: ExistingSrt[] = []
    try {
      const entries = await fs.readdir(subtitlesDir)
      for (const f of entries) {
        if (!/\.(srt|vtt|ass)$/i.test(f)) continue
        const full = path.join(subtitlesDir, f)
        const stat = await fs.stat(full)
        const entry: ExistingSrt = { path: full, filename: f, mtime: stat.mtimeMs }

        // Look for the parallel .json metadata sidecar that
        // /subtitles/from-chapters writes alongside its output. If
        // present, we know the exact gap the SRT was generated against.
        try {
          const metaRaw = await fs.readFile(`${full}.json`, 'utf-8')
          const meta = JSON.parse(metaRaw)
          if (typeof meta?.gap_duration_s === 'number') {
            entry.generated_with_gap_s = meta.gap_duration_s
            if (currentMergeGap !== null && meta.gap_duration_s !== currentMergeGap) {
              entry.drifts_from_current_merge = true
              const diff = currentMergeGap - meta.gap_duration_s
              const sign = diff > 0 ? '+' : ''
              entry.drift_note =
                `This SRT was derived with gap=${meta.gap_duration_s}s but the merged audio uses ` +
                `gap=${currentMergeGap}s. Each section's cues drift ${sign}${diff.toFixed(1)}s ` +
                `× section index. Re-derive to fix.`
            }
          }
        } catch { /* no meta sidecar — was hand-imported, Whisper-transcribed, or pre-1.0.140 */ }

        existingSrts.push(entry)
      }
      existingSrts.sort((a, b) => b.mtime - a.mtime)
    } catch { /* no dir yet — fine */ }

    res.json({
      has_libass: libass,
      has_merged_audio: assets.merged_audio.length > 0,
      has_chapter_audio: assets.audio_sections.length > 0,
      has_openai_key: !!(config as any)?.openai_api_key,
      existing_srts: existingSrts,
      subtitles_dir: subtitlesDir,
      current_merge_gap_s: currentMergeGap,
      // v1.0.396 — the user-pinned subtitle to burn (null = AUTO: prefer the
      // full stitched/whisper transcript, skip per-chapter partials).
      selected_subtitle: await readSelectedSubtitle(subtitlesDir),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not compute subtitle status'))
  }
})

/** Derive SRT cues from the episode's individual chapter audio files.
 *  Each chapter is one cue spanning its full duration — suitable for
 *  section markers, not word-level captions.
 *
 *  v1.0.140+ — Gap resolution priority:
 *    1. `req.body.gap_sec` (explicit override from caller, e.g. user
 *       typed a value in the UI form)
 *    2. `audio_chapters.json.gap_duration_s` (the gap the audio-merge
 *       job actually used — written into the sidecar at merge time)
 *    3. Hardcoded 5s fallback (pre-1.0.140 behaviour for legacy projects
 *       whose sidecar predates the gap field)
 *
 *  The sidecar path is the fix for the cross-section drift the user
 *  flagged: without it, anyone whose audio-merge gap was ≠5s saw their
 *  chapters-derived subtitles fall progressively behind the burned-in
 *  audio (each section's cue starts 2-3s late, error compounds). */
router.post('/projects/:slug/video-editor/subtitles/from-chapters/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const assets = await scanEpisodeAssets(slug, episodeId)
    if (assets.audio_sections.length === 0) {
      return res.status(400).json({ detail: 'No chapter audio files found for this episode' })
    }

    // Resolve the gap. Explicit body value wins; else read from the
    // audio-merge sidecar; else default 5. The episode_dir-relative
    // sidecar lookup mirrors the audio-merge generator's write path.
    let gap = typeof req.body?.gap_sec === 'number' ? req.body.gap_sec : null
    let gap_source: 'body' | 'sidecar' | 'default' = 'body'
    if (gap == null) {
      try {
        const sidecarPath = path.join(assets.episode_dir, 'audio_chapters.json')
        const raw = await fs.readFile(sidecarPath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (typeof parsed?.gap_duration_s === 'number') {
          gap = parsed.gap_duration_s
          gap_source = 'sidecar'
        }
      } catch { /* missing or unreadable sidecar — fall through */ }
    }
    if (gap == null) {
      gap = 5
      gap_source = 'default'
    }

    // v1.0.397 — offset cues by the intro lead-in (intro + its gap) so the
    // chapter captions line up with the merged audio instead of running ahead.
    // Best-effort + read-only against the merged file + sidecar; 0 = no intro.
    let leadIn = 0
    try {
      const { computeIntroLeadInSec } = await import('../lib/intro-lead-in.js')
      const merged = assets.merged_audio?.[0]?.path || null
      const parsed = JSON.parse(await fs.readFile(path.join(assets.episode_dir, 'audio_chapters.json'), 'utf-8'))
      leadIn = await computeIntroLeadInSec(merged, parsed.sections || [], typeof parsed.gap_duration_s === 'number' ? parsed.gap_duration_s : gap)
    } catch { /* no merged audio / sidecar — leadIn stays 0 */ }

    const chapters = chaptersFromDurations(
      assets.audio_sections.map(a => ({
        title: a.label || a.filename.replace(/\.[^.]+$/, ''),
        duration_sec: a.duration || 0,
      })),
      gap,
      leadIn,
    )
    const srt = chaptersToSrt(chapters, {
      max_chars_per_line: req.body?.max_chars_per_line,
      max_lines: req.body?.max_lines,
    })

    const outDir = await resolveSubtitlesDir(slug, episodeId)
    await fs.mkdir(outDir, { recursive: true })
    const outPath = path.join(outDir, `${episodeId.toUpperCase()}_chapters.srt`)
    await fs.writeFile(outPath, srt, 'utf-8')

    // v1.0.140+ — Stamp the gap used into a parallel JSON sidecar so
    // the drift-detection in subtitles/status can compare it against
    // the current audio-merge gap and surface a "regen me" warning
    // when they differ. Filename mirrors the SRT for trivial pairing.
    try {
      const meta = {
        srt: path.basename(outPath),
        gap_duration_s: gap,
        gap_source,
        lead_in_sec: leadIn,
        generated_at: new Date().toISOString(),
        cues: chapters.length,
      }
      await fs.writeFile(`${outPath}.json`, JSON.stringify(meta, null, 2))
    } catch { /* best-effort */ }

    res.json({ srt_path: outPath, cues: chapters.length, gap_sec: gap, gap_source, lead_in_sec: leadIn })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not derive subtitles from chapters'))
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

/** Queue a Whisper transcription job. Returns the job id so the UI can
 *  poll /jobs/:id for progress. */
router.post('/projects/:slug/video-editor/subtitles/transcribe/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params

  // v1.0.217+ — engine-aware gating. 'voicestudio' = the local modal's free
  // Whisper STT (no OpenAI key needed); 'openai' = the paid fallback.
  const engine = req.body?.engine === 'voicestudio' ? 'voicestudio' : 'openai'
  const { getApiKey } = await import('../services/app-secrets-store.js')
  if (engine === 'openai') {
    const config = await pm.getConfig(slug)
    const appKey = await getApiKey('openai').catch(() => '')
    if (!appKey && !(config as any)?.openai_api_key) {
      return res.status(400).json({ detail: 'OpenAI API key not configured. Add one in Settings → API Keys, or pick the Voice Studio engine.' })
    }
    setSubtitleTranscribeConcurrency(1)
  } else {
    const { DEFAULT_VOICESTUDIO_BASE_URL, availableTranscribeEndpointCount } = await import('../lib/voicestudio-client.js')
    const baseUrl = (await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!baseUrl) {
      return res.status(400).json({ detail: 'Voice Studio URL not set — add it in Settings → This Mac → Local Models, or pick the OpenAI engine.' })
    }
    const readyEndpoints = await availableTranscribeEndpointCount(baseUrl, req.body?.model).catch(() => 1)
    // One Whisper inference per Mac. With 2-3 model-ready Voice Studio URLs,
    // different episode transcription jobs can run together; one URL stays
    // serial so we don't pile multiple long STT requests onto the same modal.
    setSubtitleTranscribeConcurrency(Math.max(1, Math.min(3, readyEndpoints || 1)))
  }

  if (isDuplicate(slug, episodeId, 'subtitles_transcribe')) {
    return res.status(409).json({ detail: `Transcription already running for ${episodeId}` })
  }

  const job = enqueue({
    project_slug: slug,
    type: 'subtitles_transcribe',
    episode_id: episodeId,
    title: `Transcribe subtitles (${episodeId})`,
    params: {
      episode_id: episodeId,
      language: req.body?.language,
      // Whisper model id. For openai: undefined → 'whisper-1'. For voicestudio:
      // a Whisper repo → resolved to the modal's default_model when absent.
      model: req.body?.model,
      audio_path: req.body?.audio_path,
      // When true, re-run even if the SRT exists. Default false: the generator
      // skips when the SRT is already on disk to avoid re-billing/recompute.
      force: req.body?.force === true,
      // v1.0.216+ — per-chapter mode: transcribe each chapter's clean
      // narration into {code}_{slug}.srt (what Scene Plan's stitcher consumes).
      per_chapter: req.body?.per_chapter === true,
      // v1.0.217+ — transcription engine ('voicestudio' local | 'openai').
      engine,
    },
  })
  res.status(201).json(job)
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

/** Render a ~1.5 s preview clip showing the user's chosen subtitle style
 *  burned over the first scene image. Mirrors the transition/animation
 *  preview endpoints. */
router.get('/projects/:slug/video-editor/preview-subtitles', async (req, res) => {
  const { slug } = req.params

  const sampleText = typeof req.query.text === 'string' && req.query.text.length > 0
    ? String(req.query.text)
    : 'The forest whispered secrets older than memory.'
  const episodeId = req.query.episode as string | undefined
  const style: VideoSubtitleStyle = {
    font_family: (req.query.font_family as string) || 'Helvetica',
    font_size_px: Number(req.query.font_size_px) || 28,
    color_hex: (req.query.color_hex as string) || '#FFFFFF',
    outline_color_hex: (req.query.outline_color_hex as string) || '#000000',
    outline_px: Number(req.query.outline_px) || 2,
    background: ((req.query.background as any) || 'none'),
    position: ((req.query.position as any) || 'bottom'),
    align: ((req.query.align as any) || 'center'),
    max_chars_per_line: Number(req.query.max_chars_per_line) || 42,
    max_lines: Number(req.query.max_lines) || 2,
  }
  if (!await hasLibass()) {
    return res.status(501).json({ detail: 'FFmpeg build lacks libass — subtitles cannot be rendered' })
  }

  let bg: string | null = null
  if (episodeId) {
    try {
      const assets = await scanEpisodeAssets(slug, episodeId)
      bg = assets.scenes[0]?.path || null
    } catch { /* synthetic fallback */ }
  }

  const W = 640, H = 360, FPS = 24, DURATION = 1.5
  const key = [
    'subtitle-v1', sampleText.slice(0, 64), bg || 'synthetic',
    style.font_family, style.font_size_px, style.color_hex, style.outline_color_hex,
    style.outline_px, style.background, style.position, style.align,
    style.max_chars_per_line, style.max_lines,
  ].join('|')

  try {
    const cached = await getOrRender(key, 'webm', async (outPath) => {
      // Write a tiny one-cue SRT spanning the whole preview clip.
      const srtFile = path.join(path.dirname(outPath), `${path.basename(outPath, '.webm')}.srt`)
      const oneCue = `1\n00:00:00,100 --> 00:00:${(DURATION).toFixed(0).padStart(2, '0')},000\n${sampleText}\n`
      await fs.writeFile(srtFile, oneCue, 'utf-8')

      const ass = buildAssStyle(style).replace(/'/g, "\\'")
      // Escape the SRT path for FFmpeg filter graphs (colons in Windows paths
      // collide with the filter argument separator).
      const escapedSrt = srtFile.replace(/\\/g, '/').replace(/:/g, '\\:')
      const args: string[] = ['-y']
      if (bg && existsSync(bg)) {
        args.push('-loop', '1', '-t', DURATION.toString(), '-i', bg)
      } else {
        args.push('-f', 'lavfi', '-t', DURATION.toString(),
          '-i', `gradients=size=${W}x${H}:type=linear:c0=0x1a1a2e:c1=0x16213e:r=${FPS}`)
      }
      args.push('-vf',
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,subtitles=filename='${escapedSrt}':force_style='${ass}',format=yuv420p`,
      )
      args.push('-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'realtime', '-row-mt', '1')
      args.push('-pix_fmt', 'yuv420p', '-r', FPS.toString(), '-an')
      args.push('-t', DURATION.toString())
      args.push(outPath)
      await runFfmpeg(args)
      // Clean up the one-cue SRT now that the preview is encoded.
      try { await fs.unlink(srtFile) } catch {}
    })

    const stat = await fs.stat(cached)
    res.set('Content-Type', 'video/webm')
    res.set('Content-Length', stat.size.toString())
    res.set('Cache-Control', 'public, max-age=86400')
    const stream = (await import('fs')).createReadStream(cached)
    stream.pipe(res)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Subtitle preview failed'))
  }
})

// Queue an FFmpeg video-assembly job (scenes + narration → final .mp4).
// Moved from /generate/video → /generate/video-assembly so the new AI
// Video Generator can own /generate/video.
router.post('/projects/:slug/generate/video-assembly', async (req, res) => {
  const { slug } = req.params

  const { episode_id, scenes, narration_path, scene_recycling, duration } = req.body
  if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ detail: 'At least one scene is required' })
  }
  if (!narration_path) return res.status(400).json({ detail: 'narration_path is required' })

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

  const job = enqueue({
    project_slug: slug,
    type: 'video_assembly',
    episode_id,
    title: `Video Assembly (${scenes.length} scenes)`,
    params: req.body,
  })
  res.status(201).json(job)
})
