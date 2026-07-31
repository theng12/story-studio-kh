/**
 * Per-project B-Roll routes — pick a selection for an episode, queue
 * an assembly job that renders narration + chosen B-Roll into a video.
 *
 *   POST /api/projects/:slug/broll/pick      — generate + persist selection
 *   POST /api/projects/:slug/broll/assemble  — queue render job
 *
 * The selection algorithm itself lives in lib/broll-selector.ts (pure).
 * This route layer reads the project's subscribed pool, the episode's
 * narration duration, and the channel's usage log, then calls the
 * selector and writes the result to the per-episode sidecar.
 */
import { Router } from 'express'
import { existsSync } from 'fs'
import * as pm from '../services/project-manager.js'
import * as bp from '../services/broll-pool-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import { selectBroll } from '../lib/broll-selector.js'
import { saveSelectionSidecar, getSelectionSidecar } from '../services/broll-selection-sidecar.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import type { JobType, BrollUsageEntry } from '../models/types.js'

export const router = Router()

// ── Helpers ────────────────────────────────────────────────────────────

async function resolveTitle(slug: string, episodeCode: string): Promise<string> {
  try {
    const ideas = await im.getIdeas(slug, 'accepted')
    return ideas.find(i => i.episode_code === episodeCode)?.title || ''
  } catch { return '' }
}

/**
 * Read the narration audio's duration. Prefers the merged narration
 * (audio-merge output) if present; falls back to the raw audio dir's
 * first .mp3. Returns 0 when nothing is on disk — caller surfaces an
 * actionable error in that case.
 */
async function readNarrationDurationSec(slug: string, episodeCode: string, title: string): Promise<number> {
  const paths = await resolveEpisodePaths(slug, episodeCode, title)
  const candidates: string[] = []
  // Merged audio dir first (post audio-merge step).
  if (existsSync(paths.merged_audio_dir)) {
    const fsp = await import('fs/promises')
    const files = await fsp.readdir(paths.merged_audio_dir).catch(() => [])
    for (const f of files) {
      if (/\.(mp3|wav|m4a)$/i.test(f) && !f.startsWith('.tmp_')) {
        candidates.push(`${paths.merged_audio_dir}/${f}`)
      }
    }
  }
  // Raw audio dir fallback (single-chapter narration formats land here).
  if (!candidates.length && existsSync(paths.audio_dir)) {
    const fsp = await import('fs/promises')
    const files = await fsp.readdir(paths.audio_dir).catch(() => [])
    for (const f of files) {
      if (/\.mp3$/i.test(f) && !f.startsWith('.tmp_')) {
        candidates.push(`${paths.audio_dir}/${f}`)
      }
    }
  }
  if (!candidates.length) return 0
  // Take the longest — that's the merged narration if present, or the
  // single full-narration file. Avoids accidentally picking a short
  // intro fragment when both exist.
  let longest = 0
  for (const p of candidates) {
    const d = await getAudioDuration(p)
    if (d && d > longest) longest = d
  }
  return longest
}

// ── POST /broll/pick ───────────────────────────────────────────────────

router.post('/projects/:slug/broll/pick', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const {
      episode_id,
      pool_id,
      selection_mode = 'random',
      tags = [],
      pacing_mode = 'rotate',
      segment_seconds = 8,
      broll_lookback,
      // v1.0.89+ — manual picks + motion + transition settings. All
      // optional; when absent the renderer falls back to static no-
      // transition output matching the v1.0.88 behaviour.
      manual_selection,        // Array<{ filename, target_duration }>
      motion_mode,             // 'fixed' | 'rotate' | 'random'
      motion_default,          // 'static' | 'zoom-in' | ...
      motion_pool,             // string[] when motion_mode is rotate/random
      transition_id,           // 'none' | 'crossfade' | ... (TransitionDef id)
      transition_duration,     // 0.1 - 2.0 seconds
    } = req.body || {}

    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
    const effectivePoolId = pool_id || (config as any).broll_pool_id
    if (!effectivePoolId) {
      return res.status(400).json({ detail: 'No B-Roll pool subscribed. Pick one on the B-Roll Picker page or pass pool_id in the request body.' })
    }

    const pool = await bp.getPool(effectivePoolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${effectivePoolId}' not found` })
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — plug in the SSD at ${pool.folder_path} before generating a selection.` })
    }

    const title = await resolveTitle(slug, episode_id)
    const narrationSec = await readNarrationDurationSec(slug, episode_id, title)
    if (!narrationSec) {
      // Format-aware copy: broll-narration is single-chapter so audio-
      // merge usually isn't needed; sleep-story / bound-explainer hits
      // this same code path though, so mention merge when narration is
      // expected to be multi-chapter. Either way the action is the same:
      // run Audio Generator first.
      return res.status(400).json({
        detail: `No narration audio found for ${episode_id}. Run the Audio Generator first — the B-Roll selector sizes the sequence to match narration duration, so audio has to exist before clips can be picked.`,
      })
    }

    const clips = await bp.listClips(effectivePoolId, { includeMissing: false })

    // Cross-episode repeat avoidance — exclude shas from the configured
    // lookback window. lookback=0 means no cross-episode exclusion.
    const effectiveLookback = typeof broll_lookback === 'number'
      ? broll_lookback
      : ((config as any).broll_lookback ?? 10)
    const usageLog: BrollUsageEntry[] = Array.isArray((config as any).broll_usage_log)
      ? (config as any).broll_usage_log
      : []
    const recentShas: string[] = effectiveLookback > 0
      // Last N usage entries — usage log is append-only with truncation,
      // so the tail is the most recent.
      ? Array.from(new Set(usageLog.slice(-effectiveLookback).map(e => e.clip_sha)))
      : []

    // Manual mode short-circuits the selector entirely — the caller has
    // already chosen the clips + per-clip durations in the UI. We still
    // validate every filename exists in the pool so a typo or stale
    // sidecar can't blow up the assembly run later. Repeat-avoidance is
    // user's call in manual mode; we don't second-guess it.
    let result: { selection: any[]; warnings: string[]; pool_size_after_filter: number }
    if (selection_mode === 'manual' && Array.isArray(manual_selection) && manual_selection.length) {
      const bySha = new Map(clips.map(c => [c.filename, c]))
      const valid: any[] = []
      const missing: string[] = []
      for (const entry of manual_selection) {
        const c = bySha.get(entry.filename)
        if (!c) { missing.push(entry.filename); continue }
        const requested = typeof entry.target_duration === 'number'
          ? Math.max(0.5, Math.min(c.duration, entry.target_duration))
          : Math.min(c.duration, 15)
        valid.push({ filename: c.filename, sha256: c.sha256, target_duration: requested })
      }
      const warnings: string[] = []
      if (missing.length) warnings.push(`Skipped ${missing.length} clip(s) not present in the pool: ${missing.slice(0, 5).join(', ')}`)
      result = { selection: valid, warnings, pool_size_after_filter: clips.length }
    } else {
      result = selectBroll({
        pool: clips.map(c => ({
          filename: c.filename,
          duration: c.duration,
          sha256: c.sha256,
          tags: c.tags || [],
          normalized: c.normalized,
          missing: c.missing,
        })),
        target_duration: narrationSec,
        selection_mode,
        tags,
        pacing_mode,
        segment_seconds,
        exclude_shas: recentShas,
      })
    }

    // Validate motion settings. Unknown ids fall back to 'static' rather
    // than failing the call — selector behaviour shouldn't gate on a
    // typo in a UI setting.
    const validMotions = new Set(['static', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'])
    const safeMotion = (s: any): string => (typeof s === 'string' && validMotions.has(s)) ? s : 'static'
    const safeMotionMode = (motion_mode === 'rotate' || motion_mode === 'random') ? motion_mode : 'fixed'
    const safeMotionPool = Array.isArray(motion_pool)
      ? motion_pool.map(safeMotion).filter((m: string) => m !== 'static' || motion_pool.length === 1)
      : ['static']
    const safeTransitionDur = typeof transition_duration === 'number'
      ? Math.max(0.1, Math.min(2.0, transition_duration))
      : 0.5

    await saveSelectionSidecar(slug, episode_id, title, {
      schema_version: 1,
      episode_code: episode_id,
      pool_id: effectivePoolId,
      selection_mode,
      pacing_mode,
      segment_seconds,
      tags,
      broll_volume: typeof req.body?.broll_volume === 'number' ? req.body.broll_volume : 0,
      selection: result.selection,
      target_duration: narrationSec,
      generated_at: new Date().toISOString(),
      warnings: result.warnings,
      motion_mode: safeMotionMode,
      motion_default: safeMotion(motion_default),
      motion_pool: safeMotionPool.length ? safeMotionPool : ['static'],
      transition_id: typeof transition_id === 'string' ? transition_id : 'none',
      transition_duration: safeTransitionDur,
    })

    res.json({
      selection: result.selection.map(s => ({
        ...s,
        pool_id: effectivePoolId,
      })),
      target_duration: narrationSec,
      pool_size_after_filter: result.pool_size_after_filter,
      warnings: result.warnings,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'B-Roll selection failed'))
  }
})

// ── POST /image-pool/pick ──────────────────────────────────────────────
// v1.0.404 — Image Pool (slideshow) selection. Reuses the B-Roll selector in
// 'timed' pacing (N seconds per image) sized to narration length, with
// cross-episode no-repeat from a SEPARATE image usage log + the pool's own
// dedup window. Writes the shared selection sidecar, stamped media:'image' so
// the assembler picks the still-image path.
router.post('/projects/:slug/image-pool/pick', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const { episode_id, pool_id, tags = [], selection_mode = 'random', seconds_per_image, dedup_lookback } = req.body || {}
    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

    const effectivePoolId = pool_id || (config as any).image_pool_id
    if (!effectivePoolId) {
      return res.status(400).json({ detail: 'No image pool selected. Pass pool_id (or set one on the project).' })
    }

    const pool = await bp.getPool(effectivePoolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${effectivePoolId}' not found` })
    if (bp.poolMedia(pool) !== 'image') {
      return res.status(400).json({ detail: `Pool '${effectivePoolId}' is a video pool — pick an Image Pool for the slideshow.` })
    }
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — connect ${pool.folder_path} before picking images.` })
    }

    const ss = pool.slideshow || bp.defaultSlideshowSettings()
    const perImage = Math.max(1, Number(seconds_per_image) || ss.seconds_per_image)
    const lookback = Math.max(0, typeof dedup_lookback === 'number' ? dedup_lookback : ss.dedup_lookback)

    const title = await resolveTitle(slug, episode_id)
    const narrationSec = await readNarrationDurationSec(slug, episode_id, title)
    if (!narrationSec) {
      return res.status(400).json({ detail: `No narration audio found for ${episode_id}. Run the Audio Generator first — the slideshow is sized to narration length.` })
    }

    const clips = await bp.listClips(effectivePoolId, { includeMissing: false })

    // Separate usage log so image dedup is independent of B-Roll's. lookback=0
    // disables cross-episode exclusion. Usage is recorded at assemble time.
    const usageLog: BrollUsageEntry[] = Array.isArray((config as any).image_pool_usage_log)
      ? (config as any).image_pool_usage_log
      : []
    const recentShas = lookback > 0
      ? Array.from(new Set(usageLog.slice(-lookback).map(e => e.clip_sha)))
      : []

    const mode = (selection_mode === 'tagged' || selection_mode === 'themed') ? selection_mode : 'random'
    const result = selectBroll({
      pool: clips.map(c => ({
        filename: c.filename,
        // Stills have duration 0; give the selector the per-image seconds so
        // 'timed' pacing has a sane non-zero segment to work with.
        duration: c.duration || perImage,
        sha256: c.sha256,
        tags: c.tags || [],
        normalized: c.normalized,
        missing: c.missing,
      })),
      target_duration: narrationSec,
      selection_mode: mode,
      tags,
      pacing_mode: 'timed',
      segment_seconds: perImage,
      exclude_shas: recentShas,
    })

    await saveSelectionSidecar(slug, episode_id, title, {
      schema_version: 1,
      episode_code: episode_id,
      pool_id: effectivePoolId,
      media: 'image',
      fit: ss.fit,
      selection_mode: mode,
      pacing_mode: 'timed',
      segment_seconds: perImage,
      tags,
      broll_volume: 0,  // stills are silent; narration + music come from merged audio
      selection: result.selection,
      target_duration: narrationSec,
      generated_at: new Date().toISOString(),
      warnings: result.warnings,
      // Slow Ken Burns when motion is on: a varied pool of gentle zoom/pan.
      motion_mode: ss.motion ? 'random' : 'fixed',
      motion_default: ss.motion ? 'zoom-in' : 'static',
      motion_pool: ss.motion ? ['zoom-in', 'zoom-out', 'pan-left', 'pan-right'] : ['static'],
      transition_id: ss.transition_sec > 0 ? 'crossfade' : 'none',
      transition_duration: ss.transition_sec > 0 ? ss.transition_sec : 0.5,
    })

    res.json({
      selection: result.selection.map(s => ({ ...s, pool_id: effectivePoolId })),
      target_duration: narrationSec,
      images: result.selection.length,
      seconds_per_image: perImage,
      dedup_lookback: lookback,
      pool_size_after_filter: result.pool_size_after_filter,
      warnings: result.warnings,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Image Pool selection failed'))
  }
})

// ── POST /image-pool/materialize ───────────────────────────────────────
// v1.0.411 — the pivot bridge: pick pool images (random, sized to narration,
// cross-episode no-repeat) and write them as the episode's SCENE IMAGES
// (scene_0001.<ext> …) in the images folder. The full Scenes Video Assembly
// editor then scans them as scenes — so overlays, logo, Ken Burns, transitions,
// effects, subtitles, export, and the standard video_assembly status all apply.
// Replaces the bespoke slideshow assembler (retired once the pivot lands).
router.post('/projects/:slug/image-pool/materialize', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })
    const { episode_id, pool_id, seconds_per_image, dedup_lookback } = req.body || {}
    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

    const effectivePoolId = pool_id || (config as any).image_pool_id
    if (!effectivePoolId) return res.status(400).json({ detail: 'No image pool selected.' })
    const pool = await bp.getPool(effectivePoolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${effectivePoolId}' not found` })
    if (bp.poolMedia(pool) !== 'image') return res.status(400).json({ detail: `Pool '${effectivePoolId}' is not an image pool.` })
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — connect ${pool.folder_path} first.` })
    }

    const ss = pool.slideshow || bp.defaultSlideshowSettings()
    const perImage = Math.max(1, Number(seconds_per_image) || ss.seconds_per_image)
    const lookback = Math.max(0, typeof dedup_lookback === 'number' ? dedup_lookback : ss.dedup_lookback)

    const title = await resolveTitle(slug, episode_id)
    const narrationSec = await readNarrationDurationSec(slug, episode_id, title)
    if (!narrationSec) {
      return res.status(400).json({ detail: `No narration audio for ${episode_id}. Run the Audio Generator first — the count is sized to narration length.` })
    }

    const clips = await bp.listClips(effectivePoolId, { includeMissing: false })
    const usageLog: BrollUsageEntry[] = Array.isArray((config as any).image_pool_usage_log)
      ? (config as any).image_pool_usage_log : []
    const recentShas = lookback > 0
      ? Array.from(new Set(usageLog.slice(-lookback).map(e => e.clip_sha))) : []

    const result = selectBroll({
      pool: clips.map(c => ({ filename: c.filename, duration: c.duration || perImage, sha256: c.sha256, tags: c.tags || [], normalized: c.normalized, missing: c.missing })),
      target_duration: narrationSec,
      selection_mode: 'random',
      pacing_mode: 'timed',
      segment_seconds: perImage,
      exclude_shas: recentShas,
    })
    if (!result.selection.length) {
      return res.status(400).json({ detail: 'No images selected — the pool may be empty or everything was used too recently.' })
    }

    // Write the selection into the episode's images folder as scene_NNNN.<ext>
    // so scanEpisodeAssets surfaces them as scenes to the Scenes editor.
    const fsp = await import('fs/promises')
    const path = await import('path')
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    // Write to the SAME folder scanEpisodeAssets reads (resolveSubfolder may
    // return a "✅ …"-prefixed variant if the user marked it done), so the
    // Scenes editor's scan picks the images up.
    const { resolveSubfolderNames } = await import('../services/utils.js')
    const { resolveEpisodeSubfolderDir, assertMediaRootReady } = await import('../services/media-root.js')
    // Fail loud (clear message) if this project routes media to an external
    // root that isn't reachable right now, rather than copying into iCloud.
    await assertMediaRootReady(slug)
    const names = await resolveSubfolderNames(slug, episode_id)
    // Media-aware (Level B): when the project has an external media_root, the
    // materialized scene_NNNN files land on that root (e.g. SSD), not iCloud.
    const imagesDir = await resolveEpisodeSubfolderDir(slug, episode_id, 'images', paths.episode_dir, names.images)
    await fsp.mkdir(imagesDir, { recursive: true })
    // Replace any previously-materialized scene_* files so a re-load is clean.
    const existing = await fsp.readdir(imagesDir).catch(() => [] as string[])
    for (const f of existing) {
      if (/^scene[_ ]?\d+\.(png|jpe?g|webp)$/i.test(f)) await fsp.rm(path.join(imagesDir, f), { force: true }).catch(() => {})
    }
    let n = 0
    for (const entry of result.selection) {
      const src = path.join(pool.folder_path, entry.filename)
      if (!existsSync(src)) continue
      n++
      const ext = (path.extname(entry.filename) || '.png').toLowerCase()
      await fsp.copyFile(src, path.join(imagesDir, `scene_${String(n).padStart(4, '0')}${ext}`))
    }
    if (!n) return res.status(500).json({ detail: 'Could not copy any images into the episode.' })

    // Record usage (separate image log) so cross-episode no-repeat holds.
    const seen = new Set<string>()
    const additions: BrollUsageEntry[] = []
    const now = new Date().toISOString()
    for (const s of result.selection) {
      if (seen.has(s.sha256)) continue
      seen.add(s.sha256)
      additions.push({ clip_sha: s.sha256, clip_filename: s.filename, episode_code: episode_id, used_at: now })
    }
    await pm.updateConfig(slug, { image_pool_usage_log: [...usageLog, ...additions].slice(-300) } as any)

    res.json({ count: n, images_dir: imagesDir, target_duration: narrationSec, seconds_per_image: perImage })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load images into Video Assembly'))
  }
})

// ── POST /broll/materialize ────────────────────────────────────────────
// v1.0.414 — the B-Roll twin of /image-pool/materialize. Picks pool VIDEO
// clips (random, sized to narration, cross-episode no-repeat) and writes them
// as the episode's SCENE files (scene_0001.<ext> …) in the images folder. The
// Scenes Video Assembly editor then scans them as scenes — so overlays, logo,
// transitions, effects, subtitles, export and the standard video_assembly
// status all apply. prepareSceneClips crop-fills + trims each clip to the
// uniform per-scene duration. Retires the bespoke broll-assemble path.
router.post('/projects/:slug/broll/materialize', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })
    const { episode_id, pool_id, seconds_per_clip, use_natural_duration, dedup_lookback, tags = [] } = req.body || {}
    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

    const effectivePoolId = pool_id || (config as any).broll_pool_id
    if (!effectivePoolId) return res.status(400).json({ detail: 'No B-Roll pool selected.' })
    const pool = await bp.getPool(effectivePoolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${effectivePoolId}' not found` })
    if (bp.poolMedia(pool) !== 'video') return res.status(400).json({ detail: `Pool '${effectivePoolId}' is not a video pool.` })
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — connect ${pool.folder_path} first.` })
    }

    const perClip = Math.max(1, Number(seconds_per_clip) || 8)
    const lookback = Math.max(0, typeof dedup_lookback === 'number'
      ? dedup_lookback : ((config as any).broll_lookback ?? 10))

    const title = await resolveTitle(slug, episode_id)
    const narrationSec = await readNarrationDurationSec(slug, episode_id, title)
    if (!narrationSec) {
      return res.status(400).json({ detail: `No narration audio for ${episode_id}. Run the Audio Generator first — the count is sized to narration length.` })
    }

    const clips = await bp.listClips(effectivePoolId, { includeMissing: false })
    const usageLog: BrollUsageEntry[] = Array.isArray((config as any).broll_usage_log)
      ? (config as any).broll_usage_log : []
    const recentShas = lookback > 0
      ? Array.from(new Set(usageLog.slice(-lookback).map(e => e.clip_sha))) : []

    const result = selectBroll({
      pool: clips.map(c => ({ filename: c.filename, duration: c.duration || perClip, sha256: c.sha256, tags: c.tags || [], normalized: c.normalized, missing: c.missing })),
      target_duration: narrationSec,
      selection_mode: 'random',
      tags,
      pacing_mode: use_natural_duration ? 'natural' : 'timed',
      segment_seconds: perClip,
      exclude_shas: recentShas,
    })
    if (!result.selection.length) {
      return res.status(400).json({ detail: 'No clips selected — the pool may be empty or everything was used too recently.' })
    }

    // Write the selection into the episode's images folder as scene_NNNN.<ext>
    // so scanEpisodeAssets surfaces them as scenes to the Scenes editor.
    const fsp = await import('fs/promises')
    const path = await import('path')
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const { resolveSubfolderNames } = await import('../services/utils.js')
    const { resolveEpisodeSubfolderDir, assertMediaRootReady } = await import('../services/media-root.js')
    // Fail loud (clear message) if this project routes media to an external
    // root that isn't reachable right now, rather than copying into iCloud.
    await assertMediaRootReady(slug)
    const names = await resolveSubfolderNames(slug, episode_id)
    // Media-aware (Level B): when the project has an external media_root, the
    // materialized scene_NNNN files land on that root (e.g. SSD), not iCloud.
    const imagesDir = await resolveEpisodeSubfolderDir(slug, episode_id, 'images', paths.episode_dir, names.images)
    await fsp.mkdir(imagesDir, { recursive: true })
    // Replace any previously-materialized scene_* files (image OR video) so a
    // re-load is clean.
    const existing = await fsp.readdir(imagesDir).catch(() => [] as string[])
    for (const f of existing) {
      if (/^scene[_ ]?\d+\.(png|jpe?g|webp|mp4|mov|webm|mkv|m4v)$/i.test(f)) await fsp.rm(path.join(imagesDir, f), { force: true }).catch(() => {})
    }
    let n = 0
    for (const entry of result.selection) {
      const src = path.join(pool.folder_path, entry.filename)
      if (!existsSync(src)) continue
      n++
      const ext = (path.extname(entry.filename) || '.mp4').toLowerCase()
      await fsp.copyFile(src, path.join(imagesDir, `scene_${String(n).padStart(4, '0')}${ext}`))
    }
    if (!n) return res.status(500).json({ detail: 'Could not copy any clips into the episode.' })

    // Record usage (B-Roll log) so cross-episode no-repeat holds.
    const seen = new Set<string>()
    const additions: BrollUsageEntry[] = []
    const now = new Date().toISOString()
    for (const s of result.selection) {
      if (seen.has(s.sha256)) continue
      seen.add(s.sha256)
      additions.push({ clip_sha: s.sha256, clip_filename: s.filename, episode_code: episode_id, used_at: now })
    }
    await pm.updateConfig(slug, { broll_usage_log: [...usageLog, ...additions].slice(-300) } as any)

    res.json({
      count: n,
      images_dir: imagesDir,
      target_duration: narrationSec,
      pacing_mode: use_natural_duration ? 'natural' : 'timed',
      seconds_per_clip: use_natural_duration ? undefined : perClip,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load clips into Video Assembly'))
  }
})

// ── POST /image-pool/generate ──────────────────────────────────────────
// v1.0.410 — grow an Image Pool by generating new stills from prompts and
// dropping them into the pool folder (then indexing them). Runs in this
// project's context so config.image_models + API keys resolve.
router.post('/projects/:slug/image-pool/generate', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const body = req.body || {}
    const poolId = typeof body.pool_id === 'string' ? body.pool_id : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const prompts = Array.isArray(body.prompts)
      ? body.prompts.map((p: any) => String(p || '').trim()).filter(Boolean)
      : []
    if (!poolId) return res.status(400).json({ detail: 'pool_id is required' })
    if (!model) return res.status(400).json({ detail: 'model is required' })
    if (!prompts.length) return res.status(400).json({ detail: 'At least one prompt is required' })

    const pool = await bp.getPool(poolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${poolId}' not found` })
    if (bp.poolMedia(pool) !== 'image') return res.status(400).json({ detail: `Pool '${poolId}' is not an image pool` })
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — connect ${pool.folder_path} first.` })
    }
    // One generate run per pool at a time (it appends files + rescans).
    if (jq.isDuplicate(slug, poolId, 'image_pool_generate' as JobType)) {
      return res.status(409).json({ detail: `Generation already running for pool ${pool.name}` })
    }

    const job = jq.enqueue({
      project_slug: slug,
      type: 'image_pool_generate' as JobType,
      episode_id: poolId,  // pool id threaded via the episode slot (app-level target)
      title: `Generate ${prompts.length} image(s) → ${pool.name}`,
      params: {
        pool_id: poolId,
        prompts,
        model,
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
        image_steps: Number.isInteger(body.image_steps) ? body.image_steps : undefined,
        seed: Number.isInteger(body.seed) ? body.seed : undefined,
        variants: Number.isFinite(Number(body.variants)) ? Number(body.variants) : 1,
        run_id: typeof body.run_id === 'string' ? body.run_id : undefined,
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Image generation failed to queue'))
  }
})

// ── POST /image-pool/suggest-prompts ───────────────────────────────────
// v1.0.410 — LLM helper: turn a short topic into a list of image prompts the
// user can review/edit before generating. Uses the project's text-model key
// resolution (callAi tiers). Returns { prompts: string[] }.
router.post('/projects/:slug/image-pool/suggest-prompts', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const body = req.body || {}
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const count = Math.max(1, Math.min(50, Math.floor(Number(body.count) || 10)))
    if (!topic) return res.status(400).json({ detail: 'topic is required' })
    if (!model) return res.status(400).json({ detail: 'model is required' })

    const { callAi, callAiWithRetry } = await import('../lib/ai-client.js')
    const system = 'You write concise, vivid text-to-image prompts. Output ONLY a JSON array of strings — no prose, no numbering, no code fence.'
    const user = `Write ${count} distinct text-to-image prompts for: "${topic}". `
      + `Each prompt is one self-contained sentence describing a single image (subject, setting, mood, lighting). `
      + `Vary the scenes so a slideshow of them feels diverse. Return a JSON array of ${count} strings.`
    // Standard: a JSON array of N self-contained image prompts.
    const raw = await callAiWithRetry(model, system, user, {}, false, {
      slug, outputBudget: 'standard',
    })

    // Tolerant parse: JSON array if present, else split lines.
    let prompts: string[] = []
    const s = String(raw || '').trim()
    const a = s.indexOf('['); const b = s.lastIndexOf(']')
    if (a >= 0 && b > a) {
      try {
        const arr = JSON.parse(s.slice(a, b + 1))
        if (Array.isArray(arr)) prompts = arr.filter((x: any) => typeof x === 'string')
      } catch { /* fall through to line split */ }
    }
    if (!prompts.length) {
      prompts = s.split('\n').map(l => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean)
    }
    prompts = prompts.map(p => p.trim()).filter(Boolean).slice(0, count)
    if (!prompts.length) return res.status(502).json({ detail: 'The model returned no usable prompts — try again or a different model.' })
    res.json({ prompts })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Prompt suggestion failed'))
  }
})

// ── POST /image-pool/assemble ──────────────────────────────────────────
// v1.0.407 — assemble the Image Pool slideshow. Reuses the broll_assemble
// executor (the sidecar's media:'image' stamp makes it loop stills + crop-fill
// + Ken Burns instead of playing clips). Stills are silent, so no broll_volume.
router.post('/projects/:slug/image-pool/assemble', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const { episode_id, subtitles_enabled, subtitles_style } = req.body || {}
    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

    const title = await resolveTitle(slug, episode_id)
    const sidecar = await getSelectionSidecar(slug, episode_id, title)
    if (!sidecar || !sidecar.selection?.length) {
      return res.status(400).json({ detail: 'No image selection on disk for this episode. Click "Pick images" first.' })
    }
    if ((sidecar as any).media !== 'image') {
      return res.status(400).json({ detail: 'This episode\'s selection is a video B-Roll selection — use B-Roll assemble, or re-pick from an image pool.' })
    }
    if (jq.isDuplicate(slug, episode_id, 'broll_assemble' as JobType)) {
      return res.status(409).json({ detail: `Assembly already queued/running for ${episode_id}` })
    }

    const job = jq.enqueue({
      project_slug: slug,
      type: 'broll_assemble' as JobType,
      episode_id,
      title: `Assemble Image Slideshow — ${episode_id}`,
      params: {
        episode_id,
        title,
        broll_volume: 0,  // stills are silent
        ...(typeof subtitles_enabled === 'boolean' ? { subtitles_enabled } : {}),
        ...(subtitles_style ? { subtitles_style } : {}),
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Image slideshow assembly failed to queue'))
  }
})

// ── POST /broll/assemble ───────────────────────────────────────────────

router.post('/projects/:slug/broll/assemble', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    // v1.0.127+ — subtitles_enabled + subtitles_style flow through to the
    // executor's job params. Both optional; missing → defaults applied
    // inside broll-assemble (enabled=true preserves legacy behaviour for
    // any caller that didn't update; style absent → no force_style).
    const {
      episode_id,
      broll_volume = 0,
      subtitles_enabled,
      subtitles_style,
    } = req.body || {}
    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

    const title = await resolveTitle(slug, episode_id)
    const sidecar = await getSelectionSidecar(slug, episode_id, title)
    if (!sidecar || !sidecar.selection?.length) {
      return res.status(400).json({ detail: 'No B-Roll selection on disk for this episode. Click "Pick B-Roll" first.' })
    }

    if (jq.isDuplicate(slug, episode_id, 'broll_assemble' as JobType)) {
      return res.status(409).json({ detail: `B-Roll assembly already queued/running for ${episode_id}` })
    }

    const job = jq.enqueue({
      project_slug: slug,
      type: 'broll_assemble' as JobType,
      episode_id,
      title: `Assemble B-Roll Video — ${episode_id}`,
      params: {
        episode_id,
        title,
        broll_volume,
        // Forward optional subtitle controls; broll-assemble defaults to
        // enabled=true + no style override when these are absent.
        ...(typeof subtitles_enabled === 'boolean' ? { subtitles_enabled } : {}),
        ...(subtitles_style ? { subtitles_style } : {}),
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'B-Roll assembly failed to queue'))
  }
})
