/**
 * Audio editor routes — FFmpeg check, asset scanning, and audio merge generation.
 */

import { Router } from 'express'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import { enqueue, isDuplicate } from '../services/job-queue.js'
import { renderAudioAssemblyPreview, scanEpisodeAudioAssets } from '../generators/audio-merge.js'
import { audioAssemblyPool, activeAudioAssemblyLayers, type AudioAssemblyPoolKind } from '../contracts/audio-assembly.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
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
import { resolveChannelIntroMusic } from '../services/channel-intro-music.js'

export const router = Router()

// ── Status endpoint (for the per-episode integrity pill) ─────────────────
router.get('/projects/:slug/episodes/:code/audio-merge-status', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const s = await getAudioMergeStatus(req.params.slug, req.params.code)
    // The completion record describes what the CURRENT file was baked with.
    // It is returned beside the integrity answer so the page can say "this
    // merge already has an intro/music" instead of implying a settings change
    // takes effect without a re-merge. A missing or mismatched record says
    // nothing (never "no layers").
    let baked: Record<string, unknown> | undefined
    if (s.present && s.file && s.dir) {
      try {
        const record = JSON.parse(await fs.readFile(
          path.join(s.dir, `${req.params.code.toUpperCase()}_merged_audio.completion.json`), 'utf-8',
        ))
        if (record?.output_filename === s.file) {
          baked = {
            duration_sec: Number(record.duration_sec) || null,
            opening: record.opening ?? null,
            background_music: typeof record.background_music === 'boolean' ? record.background_music : null,
            closing_tail_sec: Number(record.closing_tail_sec) || 0,
          }
        }
      } catch { /* no record: the page shows the file, not a claim about its layers */ }
    }
    res.json(baked ? { ...s, baked } : s)
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

/**
 * One reusable pool per optional layer. Music keeps its own Music Pool (cycling
 * and per-track overrides); ambience, effects and background voice are channel
 * folders scanned the same way, so the page has one picker shape for all three.
 */
router.get('/projects/:slug/audio-editor/layer-files', async (req, res) => {
  const { slug } = req.params
  const kind = String(req.query.kind || '') as AudioAssemblyPoolKind
  const pool = audioAssemblyPool(kind)
  if (!pool?.folder) {
    return res.status(400).json({ detail: 'That layer uses the Music Pool, not a channel folder.' })
  }
  try {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project directory not found' })
    const dir = path.join(projectDir, pool.folder)
    if (!existsSync(dir)) return res.json({ kind, label: pool.label, tracks: [], dir, exists: false })
    const audioExtensions = /\.(mp3|wav|m4a|aac|ogg|flac)$/i
    const tracks: Array<{ filename: string; path: string; duration?: number }> = []
    for (const file of await fs.readdir(dir)) {
      if (!audioExtensions.test(file)) continue
      const fullPath = path.join(dir, file)
      const duration = Number(await getAudioDuration(fullPath).catch(() => undefined)) || undefined
      tracks.push({ filename: file, path: fullPath, duration })
    }
    tracks.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
    res.json({ kind, label: pool.label, tracks, dir, exists: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, `Could not scan ${pool.folder}`))
  }
})

/** The chosen intro clip's own length, so the page's total counts it. */
router.get('/projects/:slug/audio-editor/duration', async (req, res) => {
  const { slug } = req.params
  const outputRoot = (await pm.getProjectOutputRoot(slug)) || undefined
  if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })
  const rawPath = String(req.query.path || '')
  if (!rawPath) return res.status(400).json({ detail: 'path query parameter required' })
  let filePath: string
  try {
    filePath = resolveAssetPath(rawPath, outputRoot)
  } catch (e: any) {
    return res.status(400).json(humanizeBackendError(e, 'Could not resolve that file'))
  }
  if (!await isPreviewablePath(filePath, slug)) {
    return res.status(403).json({ detail: 'That file is outside this project.' })
  }
  if (!existsSync(filePath)) return res.status(404).json({ detail: 'File not found' })
  const seconds = Number(await getAudioDuration(filePath).catch(() => undefined))
  if (!seconds) return res.status(422).json({ detail: 'That file could not be measured.' })
  res.json({ seconds })
})

// Short mixed previews. The render is transient and never enters the episode
// folder; the id is the only handle, so a stale page cannot read another
// project's preview.
const audioPreviewFiles = new Map<string, { slug: string; path: string; expires: number }>()

router.post('/projects/:slug/audio-assembly/preview', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const outputRoot = (await pm.getProjectOutputRoot(slug)) || undefined
  if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })
  const body = req.body || {}
  const resolve = (value: unknown): string => {
    if (!value) return ''
    try { return resolveAssetPath(String(value), outputRoot) } catch { return '' }
  }
  try {
    const chapters = (Array.isArray(body.chapters) ? body.chapters : []).map(resolve).filter(Boolean)
    if (!chapters.length) return res.status(400).json({ detail: 'Choose at least one chapter before previewing.' })
    const music = body.music?.enabled && Array.isArray(body.music.files)
      ? { ...body.music, files: body.music.files.map(resolve).filter(Boolean) }
      : undefined
    const noise = body.background_noise?.enabled
      ? {
          ...body.background_noise,
          custom_file: body.background_noise.mode === 'custom'
            ? resolve(body.background_noise.custom_file)
            : undefined,
        }
      : undefined
    const tracks = activeAudioAssemblyLayers({
      ambience: body.ambience,
      ambient_tracks: body.ambient_tracks,
      effects_tracks: body.effects_tracks,
      background_voice_tracks: body.background_voice_tracks,
    })
      .map(track => ({ ...track, source_path: resolve(track.source_path) }))
      .filter(track => !!track.source_path)
    const id = randomUUID()
    const outputPath = path.join(os.tmpdir(), `story-audio-preview-${id}.mp3`)
    const { duration_sec } = await renderAudioAssemblyPreview({
      narrationPath: chapters[0]!,
      seconds: Math.max(1, Math.min(60, Number(body.preview_seconds) || 20)),
      narrationVolume: Number(body.narration_volume) || 1,
      music,
      noise,
      ambientTracks: tracks,
      outputPath,
    })
    const expires = Date.now() + 10 * 60_000
    audioPreviewFiles.set(id, { slug, path: outputPath, expires })
    const timer = setTimeout(() => {
      const entry = audioPreviewFiles.get(id)
      if (entry) {
        audioPreviewFiles.delete(id)
        fs.rm(entry.path, { force: true }).catch(() => {})
      }
    }, 10 * 60_000)
    timer.unref?.()
    res.status(201).json({
      id,
      duration_sec,
      url: `/api/projects/${encodeURIComponent(slug)}/audio-assembly/preview/${id}`,
    })
  } catch (e: any) {
    res.status(422).json(humanizeBackendError(e, 'Could not render that preview'))
  }
})

router.get('/projects/:slug/audio-assembly/preview/:id', async (req, res) => {
  const entry = audioPreviewFiles.get(req.params.id)
  if (!entry || entry.slug !== req.params.slug || entry.expires < Date.now() || !existsSync(entry.path)) {
    return res.status(404).json({ detail: 'That preview has expired. Make a new one.' })
  }
  res.set('Content-Type', 'audio/mpeg')
  res.set('Cache-Control', 'no-store')
  res.sendFile(entry.path)
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
  // 1.4.386 — automatic binding. A request that does NOT state `channel_intro`
  // (Pipeline, a manual merge) binds this channel's configured intro music. An
  // explicit pick, or an explicit `null` clear, always wins — and an episode's
  // own saved choice outranks the channel default, so nothing a person chose is
  // overwritten. A channel that configures no intro binds nothing, leaving the
  // release/1.4.383 path exactly as it was.
  if (!Object.prototype.hasOwnProperty.call(req.body, 'channel_intro')) {
    const config = await pm.getConfig(slug)
    const savedEpisode = config?.video_assembly_last_used?.episodes?.[episode_id.trim().toUpperCase()]?.settings ?? null
    const resolved = resolveChannelIntroMusic({
      episodeLastUsedSettings: savedEpisode,
      channelConfig: config,
    })
    if (resolved.settings) req.body.channel_intro = { ...resolved.settings, enabled: true }
  }
  if (req.body.channel_intro === null) delete req.body.channel_intro
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
