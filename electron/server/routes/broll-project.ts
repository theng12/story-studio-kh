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
