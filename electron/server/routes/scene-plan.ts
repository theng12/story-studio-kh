/**
 * Scene Plan routes for the timestamp-driven pipeline (v1.0.143+).
 *
 *   POST /api/projects/:slug/scene-plan/:episodeId/stitch-subtitles
 *   POST /api/projects/:slug/scene-plan/:episodeId/run
 *   GET  /api/projects/:slug/scene-plan/:episodeId
 *   PUT  /api/projects/:slug/scene-plan/:episodeId
 *   DELETE /api/projects/:slug/scene-plan/:episodeId
 */

import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { stitchSubtitles } from '../services/subtitle-stitcher.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import type { JobType, ScenePlan } from '../models/types.js'

export const router = Router()

// ── POST /scene-plan/:ep/stitch-subtitles ─────────────────────────────
// Synchronous (no job queue) — the stitch is just file I/O + math,
// completes in <1s even for long episodes. Returns the result body
// directly so the frontend can render the cue count without polling.
router.post('/projects/:slug/scene-plan/:episodeId/stitch-subtitles', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    // v1.0.398 — self-heal: episodes merged before audio_chapters.json was
    // written (or where it was lost) would dead-end here with "Run Audio
    // Assembly first" even though the per-chapter audio is on disk. Rebuild the
    // sidecar from that audio instead of forcing a re-merge (which would desync
    // already-rendered scenes). No-op when the sidecar already exists.
    const { ensureAudioChaptersSidecar } = await import('../lib/audio-chapters-reconstruct.js')
    await ensureAudioChaptersSidecar({
      episodeDir: paths.episode_dir,
      audioDir: paths.audio_dir,
      mergedAudioDir: paths.merged_audio_dir,
      episodeCode: episodeId.toUpperCase(),
    }).catch(() => null)
    const { computeEpisodeIntroLeadInSec } = await import('../lib/intro-lead-in.js')
    const leadIn = await computeEpisodeIntroLeadInSec(
      paths.episode_dir,
      paths.merged_audio_dir,
      episodeId.toUpperCase(),
    ).catch(() => 0)
    const result = await stitchSubtitles({
      episode_dir: paths.episode_dir,
      subtitles_dir: paths.subtitles_dir,
      episode_code: episodeId.toUpperCase(),
      lead_in_sec: leadIn,
    })
    res.json(result)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Subtitle stitching failed'))
  }
})

// ── POST /scene-plan/:ep/run ──────────────────────────────────────────
router.post('/projects/:slug/scene-plan/:episodeId/run', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  const targetSceneCount = typeof body.target_scene_count === 'number' ? body.target_scene_count : undefined
  const useResearch = body.use_research === false ? false : true  // default true
  const title = typeof body.title === 'string' ? body.title : ''
  // v1.0.242 — visual-prompt detail level (1–4) + global style + custom text.
  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''
  // v1.0.285 — per-window scene count tuning. Validated against the three
  // allowed enum values; anything else (including missing) falls back to
  // 'auto' so the planner uses its model-aware default.
  const windowSize: 'auto' | 'full' | 'small' =
    body.window_size === 'full' || body.window_size === 'small' ? body.window_size : 'auto'
  // v1.0.291 — planning mode + neighbor context for two-pass.
  const planningMode: 'single-pass' | 'two-pass' =
    body.planning_mode === 'two-pass' ? 'two-pass' : 'single-pass'
  const ncBack = typeof body.neighbor_context_back === 'number'
    ? Math.max(0, Math.min(10, Math.round(body.neighbor_context_back)))
    : undefined
  const ncForward = typeof body.neighbor_context_forward === 'number'
    ? Math.max(0, Math.min(10, Math.round(body.neighbor_context_forward)))
    : undefined

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `Scene plan already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Plan scenes — ${episodeId}`,
    params: {
      episode_id: episodeId,
      title,
      model,
      target_scene_count: targetSceneCount,
      use_research: useResearch,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
      window_size: windowSize,
      planning_mode: planningMode,
      neighbor_context_back: ncBack,
      neighbor_context_forward: ncForward,
    },
  })
  res.status(201).json(job)
})

// ── POST /scene-plan/:ep/replan-scene ─────────────────────────────────
// v1.0.245 — re-plan ONE scene's time range (fixes an over-long / auto-filled
// segment). Reuses the scene_plan_run job; the generator splices the result in
// place of the target scene, leaving every other scene + its image untouched.
router.post('/projects/:slug/scene-plan/:episodeId/replan-scene', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  // v1.0.343 — scene planning/rewrite is an LLM task. Reject IMAGE models up
  // front with a clear, fast error (passing one used to time out deep in the
  // text client as "Unsupported model").
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })

  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''
  // v1.0.285 — per-window scene count tuning (mirrors the full-plan route).
  const windowSize: 'auto' | 'full' | 'small' =
    body.window_size === 'full' || body.window_size === 'small' ? body.window_size : 'auto'

  // Shares the scene_plan_run lane, so it won't run alongside a full plan.
  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Re-plan scene — ${episodeId}`,
    params: {
      episode_id: episodeId,
      model,
      replan_scene_id: sceneId,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
      window_size: windowSize,
    },
  })
  res.status(201).json(job)
})

// ── POST /scene-plan/:ep/regenerate-prompt ───────────────────────────
// v1.0.288 — regenerate JUST the visual_prompt for ONE scene. Keeps the
// scene's time boundaries, transcript_segment, scene_index, and id
// untouched — only visual_prompt is rewritten. Vastly more reliable on
// small local models than the full Re-plan because the output is plain
// prose, not structured JSON.
router.post('/projects/:slug/scene-plan/:episodeId/regenerate-prompt', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  // v1.0.343 — scene planning/rewrite is an LLM task. Reject IMAGE models up
  // front with a clear, fast error (passing one used to time out deep in the
  // text client as "Unsupported model").
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })

  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''

  // Shares the scene_plan_run lane — only one job per episode at a time.
  // The frontend bulk-regen loop polls for completion before queuing the next.
  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Regen prompt — ${episodeId}`,
    params: {
      episode_id: episodeId,
      model,
      regenerate_prompt_scene_id: sceneId,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
    },
  })
  res.status(201).json(job)
})

// ── POST /scene-plan/:ep/regenerate-empty-prompts ─────────────────────
// v1.0.458 — bulk-regenerate EVERY empty visual_prompt in ONE job that fans
// out across the LM Studio pool (concurrency = pool size) and retries
// transient connection failures. Replaces the old frontend loop that fired
// one regenerate-prompt job per scene, serially, through a single endpoint —
// which wasted the pool and the user's time on a 47-scene reprompt. Shares
// the scene_plan_run lane, so it won't run alongside a full plan / re-plan.
router.post('/projects/:slug/scene-plan/:episodeId/regenerate-empty-prompts', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  // Scene planning/rewrite is an LLM task — reject IMAGE models up front.
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }

  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Regen empty prompts — ${episodeId}`,
    params: {
      episode_id: episodeId,
      model,
      regenerate_empty_prompts: true,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
    },
  })
  res.status(201).json(job)
})

// ── POST /scene-plan/:ep/set-prompt ───────────────────────────────────
// v1.0.342 — save ONE scene's hand-edited visual_prompt. Powers the inline
// prompt fix in Scene Review's preview lightbox (the LLM sometimes writes a
// prompt that produces the wrong image / off-style render; this lets the user
// correct it on the spot and re-render). Synchronous file edit — no job. Resets
// the scene's approval, since the rendered image is now stale vs the new prompt.
router.post('/projects/:slug/scene-plan/:episodeId/set-prompt', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const sceneId = typeof req.body?.scene_id === 'string' ? req.body.scene_id.trim() : ''
  const visualPrompt = typeof req.body?.visual_prompt === 'string' ? req.body.visual_prompt.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  if (!visualPrompt) return res.status(400).json({ detail: 'visual_prompt is required (non-empty)' })

  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const sidecarPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(sidecarPath)) {
      return res.status(404).json({ detail: 'No scene_plan.json — run Scene Plan first.' })
    }
    const plan = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) return res.status(404).json({ detail: `Scene ${sceneId} not found in scene_plan.json` })

    scene.visual_prompt = visualPrompt
    // If the Visual Recipe composed this prompt, keep the raw in sync so a later
    // re-compose starts from the user's edit, not the stale planner original.
    if (scene.visual_prompt_raw) scene.visual_prompt_raw = visualPrompt
    scene.approved = false  // image is now stale vs the edited prompt
    await fs.writeFile(sidecarPath, JSON.stringify(plan, null, 2), 'utf-8')
    res.json({ ok: true, scene_id: sceneId, visual_prompt: visualPrompt })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save prompt'))
  }
})

// ── GET /scene-plan/:ep ───────────────────────────────────────────────
// Returns the existing plan + status flags so the page can render the
// 3-step wizard correctly (stitch ready? plan ready? drift?).
router.get('/projects/:slug/scene-plan/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const stitchedSrtPath = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
    const stitchedMetaPath = `${stitchedSrtPath}.json`
    const scenePlanPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    const researchPath = (await resolveResearchPaths(paths.episode_dir, episodeId)).jsonPath
    const audioChaptersPath = path.join(paths.episode_dir, 'audio_chapters.json')

    let stitchedMeta: any = null
    let scenePlan: ScenePlan | null = null
    let audioMergeGap: number | null = null

    if (existsSync(stitchedMetaPath)) {
      try { stitchedMeta = JSON.parse(await fs.readFile(stitchedMetaPath, 'utf-8')) } catch { /* ignore */ }
    }
    if (existsSync(scenePlanPath)) {
      try { scenePlan = JSON.parse(await fs.readFile(scenePlanPath, 'utf-8')) as ScenePlan } catch { /* ignore */ }
    }
    if (existsSync(audioChaptersPath)) {
      try {
        const a = JSON.parse(await fs.readFile(audioChaptersPath, 'utf-8'))
        if (typeof a?.gap_duration_s === 'number') audioMergeGap = a.gap_duration_s
      } catch { /* ignore */ }
    }

    // Drift flag: stitched-SRT was built against a different gap than
    // the current audio_chapters.json gap. UI surfaces "re-stitch
    // recommended" so the timing stays accurate.
    let stitchedDrift = false
    if (stitchedMeta && typeof stitchedMeta.gap_duration_s === 'number' && audioMergeGap !== null) {
      if (stitchedMeta.gap_duration_s !== audioMergeGap) stitchedDrift = true
    }

    // v1.0.250 — content staleness by mtime. The gap check above only catches a
    // CHANGED merge gap. If you re-transcribe (fresh per-chapter SRTs) without
    // re-stitching, the gap is unchanged but the stitched SRT is out of date —
    // and the planner reads that stale timeline (the exact "old plan won't
    // update" trap). Flag when any per-chapter subtitle SRT is newer than the
    // stitched SRT (2s tolerance so same-batch writes don't false-positive).
    let stitchedStaleVsSubs = false
    if (existsSync(stitchedSrtPath)) {
      try {
        const stitchedMs = (await fs.stat(stitchedSrtPath)).mtimeMs
        const chapRe = new RegExp(`^${episodeId.toUpperCase()}_Chapter_\\d+\\.srt$`, 'i')
        const entries = await fs.readdir(paths.subtitles_dir)
        for (const n of entries) {
          if (!chapRe.test(n)) continue
          const ms = (await fs.stat(path.join(paths.subtitles_dir, n))).mtimeMs
          if (ms > stitchedMs + 2000) { stitchedStaleVsSubs = true; break }
        }
      } catch { /* best-effort — no subtitles dir / unreadable */ }
    }

    // v1.0.250 — second staleness link: the scene plan is OLDER than the
    // stitched SRT it should be built from (you re-stitched but didn't re-run
    // the plan). This is the other half of "my old plan won't update".
    let planStaleVsStitched = false
    if (existsSync(scenePlanPath) && existsSync(stitchedSrtPath)) {
      try {
        const planMs = (await fs.stat(scenePlanPath)).mtimeMs
        const stitchedMs = (await fs.stat(stitchedSrtPath)).mtimeMs
        if (stitchedMs > planMs + 2000) planStaleVsStitched = true
      } catch { /* best-effort */ }
    }

    res.json({
      stitched_srt: existsSync(stitchedSrtPath) ? {
        path: stitchedSrtPath,
        meta: stitchedMeta,
        drifts_from_current_merge: stitchedDrift,
        stale_vs_subtitles: stitchedStaleVsSubs,
      } : null,
      plan_stale_vs_stitched: planStaleVsStitched,
      scene_plan: scenePlan,
      audio_merged: existsSync(audioChaptersPath),
      audio_merge_gap_s: audioMergeGap,
      research_available: existsSync(researchPath),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read scene plan status'))
  }
})

// ── PUT /scene-plan/:ep ───────────────────────────────────────────────
router.put('/projects/:slug/scene-plan/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body as Partial<ScenePlan> | undefined
  if (!body || body.schema_version !== 1) {
    return res.status(400).json({ detail: 'Invalid scene plan payload (missing schema_version: 1)' })
  }
  if (!Array.isArray(body.scenes)) {
    return res.status(400).json({ detail: 'Invalid scene plan payload (scenes must be an array)' })
  }

  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const sidecarPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true })
    await fs.writeFile(sidecarPath, JSON.stringify(body, null, 2), 'utf-8')
    res.json({ ok: true, sidecar_path: sidecarPath })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save scene plan'))
  }
})

// ── DELETE /scene-plan/:ep ────────────────────────────────────────────
router.delete('/projects/:slug/scene-plan/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const sidecarPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    try {
      await fs.unlink(sidecarPath)
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
    }
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete scene plan'))
  }
})
