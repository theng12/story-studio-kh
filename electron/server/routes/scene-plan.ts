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
import { findIncompleteSubtitleSections, stitchSubtitles } from '../services/subtitle-stitcher.js'
import { requireScenePlanGenStudioModel, SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import {
  computePlanCoverage,
  inspectScenePlanCoverage,
  repairOverlongScenesDeterministically,
  repairPlanCoverageWithSubtitleCues,
  reconcilePlanToSubtitles,
} from '../services/scene-planner.js'
import { parseScenePromptPackSetting, parseScenePromptTokenSetting } from '../services/scene-prompt-batching.js'
import { parsePromptCharCap } from '../services/prompt-char-cap.js'
import { normalizeCreativeDirection } from '../services/scene-creative-direction.js'
import { clearLegacyPlannerFallbackReasons } from '../services/scene-prompt-integrity.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import type { JobType, ScenePlan } from '../models/types.js'

export const router = Router()

function parseCreativeDirection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return normalizeCreativeDirection(value as Record<string, unknown>)
}

async function invalidateScenePlanStatus(slug: string, episodeId: string): Promise<void> {
  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
  episodeStatusCache.invalidate(slug, episodeId)
}

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
  const stage: 'timeline' | 'visual' | 'motion' =
    body.stage === 'visual' || body.stage === 'motion' ? body.stage : 'timeline'
  let model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model && stage !== 'timeline') return res.status(400).json({ detail: 'model is required' })
  if (stage !== 'timeline') {
    try {
      model = await requireScenePlanGenStudioModel(model)
    } catch (error: any) {
      return res.status(409).json(humanizeBackendError(error, 'GenStudio scene-planning model is unavailable'))
    }
  }

  const targetSceneCount = typeof body.target_scene_count === 'number' ? body.target_scene_count : undefined
  const useResearch = body.use_research === false ? false : true  // default true
  const title = typeof body.title === 'string' ? body.title : ''
  // v1.0.242 — visual-prompt detail level (1–4) + global style + custom text.
  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : 4
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''
  // v1.0.468 — image-to-video motion-prompt controls. motion_level 1–4 (omitted
  // → planner falls back to the project default, then 2). generate_motion_prompts
  // defaults to the project setting when omitted (handled in the generator).
  const motionLevel = typeof body.motion_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.motion_level)))
    : undefined
  const generateMotionPrompts = typeof body.generate_motion_prompts === 'boolean'
    ? body.generate_motion_prompts
    : undefined
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
  // Independent windows are the fast/default path. Continuity is explicit now
  // that reviewed image-to-video clips no longer rely on previous-frame img2img.
  const crossWindowContext = body.cross_window_context === true
  const openingMode: 'branded-opening' | 'from-start' | undefined =
    body.opening_mode === 'branded-opening' || body.opening_mode === 'from-start' ? body.opening_mode : undefined
  const openingReservedSec = typeof body.opening_reserved_sec === 'number'
    ? Math.max(0, Math.min(120, body.opening_reserved_sec)) : undefined
  const promptLimit = typeof body.prompt_limit === 'number'
    ? Math.max(1, Math.min(5000, Math.round(body.prompt_limit))) : undefined
  const promptPackSize = parseScenePromptPackSetting(body.prompt_pack_size)
  const promptMaxTokens = parseScenePromptTokenSetting(body.prompt_max_tokens)
  // Resolved by the workspace from the SELECTED image model's published
  // `max_prompt_characters`. Absent = nothing published = no target.
  const promptCharCap = parsePromptCharCap(body.prompt_char_cap)
  const creativeDirection = parseCreativeDirection(body.creative_direction)

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `Scene plan already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `${stage === 'timeline' ? 'Build scene timeline' : stage === 'visual' ? 'Generate visual prompts' : 'Generate motion prompts'} — ${episodeId}`,
    params: {
      episode_id: episodeId,
      title,
      model: model || 'deterministic-timeline',
      target_scene_count: targetSceneCount,
      use_research: useResearch,
      detail_level: detailLevel,
      motion_level: motionLevel,
      generate_motion_prompts: generateMotionPrompts,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
      window_size: windowSize,
      cross_window_context: crossWindowContext,
      planning_mode: planningMode,
      neighbor_context_back: ncBack,
      neighbor_context_forward: ncForward,
      stage,
      opening_mode: openingMode,
      opening_reserved_sec: openingReservedSec,
      prompt_limit: promptLimit,
      prompt_pack_size: promptPackSize,
      prompt_max_tokens: promptMaxTokens,
      prompt_char_cap: promptCharCap,
      creative_direction: creativeDirection,
    },
  })
  res.status(201).json(job)
})

// Kept as a clear compatibility response for older installed clients. Scene
// boundaries are deterministic now; callers must use repair-long-scenes.
router.post('/projects/:slug/scene-plan/:episodeId/replan-scene', (_req, res) => {
  res.status(410).json({
    detail: 'LLM scene re-planning has been retired. Complete and stitch subtitles, then use Repair long scenes (deterministic, no LLM).',
  })
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
  let model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  // v1.0.343 — scene planning/rewrite is an LLM task. Reject IMAGE models up
  // front with a clear, fast error (passing one used to time out deep in the
  // text client as "Unsupported model").
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }
  try {
    model = await requireScenePlanGenStudioModel(model)
  } catch (error: any) {
    return res.status(409).json(humanizeBackendError(error, 'GenStudio scene-planning model is unavailable'))
  }
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })

  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''
  const creativeDirection = parseCreativeDirection(body.creative_direction)
  const promptCharCap = parsePromptCharCap(body.prompt_char_cap)
  // A user-invoked REWORD of a prompt that did not render: same beat, different
  // angle, difficult-subjects guidance applied. Only the explicit action sets
  // it — no failure is inspected to infer it. See lib/image-content-guidance.ts.
  const rewordPrompt = body.reword_prompt === true

  // Shares the scene_plan_run lane — only one job per episode at a time.
  // The frontend bulk-regen loop polls for completion before queuing the next.
  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `${rewordPrompt ? 'Reword' : 'Regen'} prompt — ${episodeId}`,
    params: {
      episode_id: episodeId,
      model,
      regenerate_prompt_scene_id: sceneId,
      reword_prompt: rewordPrompt || undefined,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
      creative_direction: creativeDirection,
      prompt_char_cap: promptCharCap,
    },
  })
  res.status(201).json(job)
})

// ── POST /scene-plan/:ep/regenerate-empty-prompts ─────────────────────
// Repair every missing or duplicated visual prompt through the same bounded,
// durable GenStudio packs used by normal prompt generation.
router.post('/projects/:slug/scene-plan/:episodeId/regenerate-empty-prompts', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  let model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  // Scene planning/rewrite is an LLM task — reject IMAGE models up front.
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }
  try {
    model = await requireScenePlanGenStudioModel(model)
  } catch (error: any) {
    return res.status(409).json(humanizeBackendError(error, 'GenStudio scene-planning model is unavailable'))
  }

  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''
  const creativeDirection = parseCreativeDirection(body.creative_direction)
  const promptPackSize = parseScenePromptPackSetting(body.prompt_pack_size)
  const promptMaxTokens = parseScenePromptTokenSetting(body.prompt_max_tokens)
  const promptCharCap = parsePromptCharCap(body.prompt_char_cap)
  const useResearch = body.use_research !== false

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Repair scene prompts — ${episodeId}`,
    params: {
      episode_id: episodeId,
      model,
      regenerate_empty_prompts: true,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
      creative_direction: creativeDirection,
      prompt_pack_size: promptPackSize,
      prompt_max_tokens: promptMaxTokens,
      prompt_char_cap: promptCharCap,
      use_research: useResearch,
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
    await invalidateScenePlanStatus(slug, episodeId)
    res.json({ ok: true, scene_id: sceneId, visual_prompt: visualPrompt })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save prompt'))
  }
})

// ── POST /scene-plan/:ep/repair-coverage ──────────────────────────────
// Heal an existing plan to FULL audio coverage. Small silent gaps may hold the
// preceding image, but narrated ranges are restored as cue-aligned scenes so a
// missing chapter can never become one 100–300 second frozen image.
router.post('/projects/:slug/scene-plan/:episodeId/repair-coverage', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const sidecarPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(sidecarPath)) {
      return res.status(404).json({ detail: 'No scene_plan.json — run Scene Plan first.' })
    }
    const plan = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
    if (!plan.scenes?.length) return res.status(400).json({ detail: 'scene_plan.json has no scenes.' })

    // Largest audio file in merged_audio/ — same heuristic the assemblers use.
    if (!existsSync(paths.merged_audio_dir)) {
      return res.status(400).json({ detail: 'No merged audio yet — run Audio Merge first, then repair coverage.' })
    }
    let audioPath = ''
    let bestSize = 0
    for (const f of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
      if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
      const st = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
      if (st && st.size > bestSize) { bestSize = st.size; audioPath = path.join(paths.merged_audio_dir, f) }
    }
    if (!audioPath) return res.status(400).json({ detail: 'No merged audio file found — run Audio Merge first.' })
    const audioDur = (await getAudioDuration(audioPath)) || 0
    if (audioDur <= 0) return res.status(400).json({ detail: `Could not read the audio duration of ${path.basename(audioPath)}.` })

    const stitchedPath = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
    const stitchedMetaPath = `${stitchedPath}.json`
    if (!existsSync(stitchedPath) || !existsSync(stitchedMetaPath)) {
      return res.status(400).json({
        detail: 'Stitch a complete subtitle timeline first. Coverage repair uses its cues to avoid creating a long frozen scene.',
      })
    }
    const stitchedMeta = JSON.parse(await fs.readFile(stitchedMetaPath, 'utf-8'))
    const incomplete = Array.from(new Set([
      ...findIncompleteSubtitleSections(stitchedMeta?.sections),
      ...(Array.isArray(stitchedMeta?.missing_sections) ? stitchedMeta.missing_sections : []),
    ]))
    if (incomplete.length) {
      return res.status(400).json({
        detail: `Transcribe the missing subtitle chapters first: ${incomplete.join(', ')}. Stitch again, then repair coverage.`,
      })
    }
    const cues = parseSrt(await fs.readFile(stitchedPath, 'utf-8'))
    if (!cues.length) return res.status(400).json({ detail: 'The stitched subtitle timeline has no cues.' })

    let minSec = 3
    let maxSec = 12
    const continuityPath = path.join(paths.episode_dir, 'continuity.json')
    if (existsSync(continuityPath)) {
      const continuity = JSON.parse(await fs.readFile(continuityPath, 'utf-8')).pacing
      const configuredMin = Number(continuity?.min_sec)
      const configuredMax = Number(continuity?.max_sec)
      if (Number.isFinite(configuredMin) && Number.isFinite(configuredMax) && configuredMax >= configuredMin) {
        minSec = configuredMin
        maxSec = configuredMax
      }
    }

    const repaired = repairPlanCoverageWithSubtitleCues({
      scenes: plan.scenes,
      cues,
      audioDurationSec: audioDur,
      threshold_sec: 20,
      min_sec: minSec,
      max_sec: maxSec,
    })
    plan.scenes = repaired.scenes
    plan.total_duration_sec = audioDur
    await fs.writeFile(sidecarPath, JSON.stringify(plan, null, 2), 'utf-8')
    await invalidateScenePlanStatus(slug, episodeId)
    res.json({
      ok: true,
      audio_duration_sec: audioDur,
      changes: repaired.changes,
      coverage_before: repaired.coverageBefore,
      coverage_after: repaired.coverageAfter,
      repaired_long_scene_count: repaired.repairedLongSceneCount,
      added_scene_count: repaired.addedSceneCount,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to repair plan coverage'))
  }
})

// ── POST /scene-plan/:ep/repair-long-scenes ───────────────────────────
// Deterministic replacement for the retired per-scene LLM re-plan action.
// Intended for an old plan that bridged missing subtitle chapters: after the
// chapters are transcribed and re-stitched, split only the abnormal ranges and
// preserve every unaffected scene, id, prompt, image, and approval.
router.post('/projects/:slug/scene-plan/:episodeId/repair-long-scenes', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    const stitchedPath = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
    const stitchedMetaPath = `${stitchedPath}.json`
    if (!existsSync(planPath)) return res.status(404).json({ detail: 'No scene plan found.' })
    if (!existsSync(stitchedPath) || !existsSync(stitchedMetaPath)) {
      return res.status(400).json({ detail: 'Stitch a complete subtitle timeline first.' })
    }

    const stitchedMeta = JSON.parse(await fs.readFile(stitchedMetaPath, 'utf-8'))
    const incomplete = Array.from(new Set([
      ...findIncompleteSubtitleSections(stitchedMeta?.sections),
      ...(Array.isArray(stitchedMeta?.missing_sections) ? stitchedMeta.missing_sections : []),
    ]))
    if (incomplete.length) {
      return res.status(400).json({
        detail: `Transcribe the missing subtitle chapters first: ${incomplete.join(', ')}. Then stitch again and retry this repair.`,
      })
    }

    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const cues = parseSrt(await fs.readFile(stitchedPath, 'utf-8'))
    if (!cues.length) return res.status(400).json({ detail: 'The stitched subtitle timeline has no cues.' })

    let minSec = 3
    let maxSec = 12
    const continuityPath = path.join(paths.episode_dir, 'continuity.json')
    if (existsSync(continuityPath)) {
      const continuity = JSON.parse(await fs.readFile(continuityPath, 'utf-8')).pacing
      const configuredMin = Number(continuity?.min_sec)
      const configuredMax = Number(continuity?.max_sec)
      if (Number.isFinite(configuredMin) && Number.isFinite(configuredMax) && configuredMax >= configuredMin) {
        minSec = configuredMin
        maxSec = configuredMax
      }
    }

    const repaired = repairOverlongScenesDeterministically({
      scenes: plan.scenes || [],
      cues,
      threshold_sec: maxSec,
      min_sec: minSec,
      max_sec: maxSec,
    })
    if (!repaired.repairedCount) {
      return res.status(400).json({
        detail: `No scenes exceed the selected ${maxSec}-second pacing cap. If subtitles were just restored, stitch them again before retrying.`,
      })
    }
    plan.scenes = repaired.scenes
    plan.generated_at = new Date().toISOString()
    plan.planning_stage = 'timeline'
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    await invalidateScenePlanStatus(slug, episodeId)
    res.json({
      ok: true,
      repairedCount: repaired.repairedCount,
      addedCount: repaired.addedCount,
      repairedIds: repaired.repairedIds,
      totalScenes: repaired.scenes.length,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to repair long scenes'))
  }
})

// ── POST /scene-plan/:ep/reconcile-timings ────────────────────────────
// v1.0.523 — re-anchor an existing plan's scene timings to the CURRENT
// stitched subtitles by matching each scene's transcript text. Fixes a plan
// that drifted out of sync after the audio was re-generated / re-stitched
// (e.g. an intro-skip offset that the new stitch no longer has). Preserves
// every scene id, image, and prompt — no re-plan, no forfeited images.
router.post('/projects/:slug/scene-plan/:episodeId/reconcile-timings', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const sidecarPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(sidecarPath)) {
      return res.status(404).json({ detail: 'No scene_plan.json — run Scene Plan first.' })
    }
    const plan = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
    if (!plan.scenes?.length) return res.status(400).json({ detail: 'scene_plan.json has no scenes.' })

    const stitchedPath = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
    if (!existsSync(stitchedPath)) {
      return res.status(400).json({ detail: 'No stitched subtitles found — stitch subtitles on the Subtitles page first, then reconcile.' })
    }
    const cues = parseSrt(await fs.readFile(stitchedPath, 'utf-8'))
    if (!cues.length) return res.status(400).json({ detail: 'The stitched SRT has no cues.' })

    // Prefer the real audio duration for the last scene's end; fall back to
    // the SRT end inside the helper when it's absent.
    let audioDur = 0
    if (existsSync(paths.merged_audio_dir)) {
      let best = 0
      for (const f of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
        if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
        const st = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
        if (st && st.size > best) { best = st.size; audioDur = (await getAudioDuration(path.join(paths.merged_audio_dir, f))) || 0 }
      }
    }

    const before = computePlanCoverage(plan.scenes, audioDur || cues[cues.length - 1]!.end_sec)
    const r = reconcilePlanToSubtitles(plan.scenes, cues, audioDur || undefined)
    plan.scenes = r.scenes
    plan.total_duration_sec = audioDur || cues[cues.length - 1]!.end_sec
    await fs.writeFile(sidecarPath, JSON.stringify(plan, null, 2), 'utf-8')
    await invalidateScenePlanStatus(slug, episodeId)
    const after = computePlanCoverage(plan.scenes, plan.total_duration_sec)
    res.json({
      ok: true,
      matched: r.matchedCount,
      total: r.scenes.length,
      unmatched_ids: r.unmatchedIds,
      median_shift_sec: r.medianShiftSec,
      changes: r.changes,
      coverage_before: before,
      coverage_after: after,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to reconcile plan timings'))
  }
})

// ── POST /scene-plan/:ep/set-motion-prompt ────────────────────────────
// v1.0.468 — save ONE scene's hand-edited motion_prompt. Synchronous file edit.
// Does NOT touch approval — the motion prompt drives a (future) clip, not the
// still image, so editing it doesn't invalidate the rendered image. Allows an
// empty string to clear the motion prompt.
router.post('/projects/:slug/scene-plan/:episodeId/set-motion-prompt', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const sceneId = typeof req.body?.scene_id === 'string' ? req.body.scene_id.trim() : ''
  const motionPrompt = typeof req.body?.motion_prompt === 'string' ? req.body.motion_prompt.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })

  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const sidecarPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(sidecarPath)) {
      return res.status(404).json({ detail: 'No scene_plan.json — run Scene Plan first.' })
    }
    const plan = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) return res.status(404).json({ detail: `Scene ${sceneId} not found in scene_plan.json` })

    scene.motion_prompt = motionPrompt
    await fs.writeFile(sidecarPath, JSON.stringify(plan, null, 2), 'utf-8')
    await invalidateScenePlanStatus(slug, episodeId)
    res.json({ ok: true, scene_id: sceneId, motion_prompt: motionPrompt })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save motion prompt'))
  }
})

// ── POST /scene-plan/:ep/regenerate-motion-prompt ─────────────────────
// v1.0.468 — regenerate JUST one scene's motion_prompt (keeps visual_prompt).
router.post('/projects/:slug/scene-plan/:episodeId/regenerate-motion-prompt', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  let model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }
  try {
    model = await requireScenePlanGenStudioModel(model)
  } catch (error: any) {
    return res.status(409).json(humanizeBackendError(error, 'GenStudio scene-planning model is unavailable'))
  }
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  const motionLevel = typeof body.motion_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.motion_level))) : undefined

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }
  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Regen motion prompt — ${episodeId}`,
    params: { episode_id: episodeId, model, regenerate_motion_prompt_scene_id: sceneId, motion_level: motionLevel },
  })
  res.status(201).json(job)
})

// ── POST /scene-plan/:ep/regenerate-empty-motion-prompts ──────────────
// Repair every missing motion prompt through the same bounded, durable
// GenStudio packs used by normal motion generation.
router.post('/projects/:slug/scene-plan/:episodeId/regenerate-empty-motion-prompts', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  let model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }
  try {
    model = await requireScenePlanGenStudioModel(model)
  } catch (error: any) {
    return res.status(409).json(humanizeBackendError(error, 'GenStudio scene-planning model is unavailable'))
  }
  const motionLevel = typeof body.motion_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.motion_level))) : undefined
  const promptPackSize = parseScenePromptPackSetting(body.prompt_pack_size)

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }
  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Repair motion prompts — ${episodeId}`,
    params: {
      episode_id: episodeId,
      model,
      regenerate_empty_motion_prompts: true,
      motion_level: motionLevel,
      prompt_pack_size: promptPackSize,
    },
  })
  res.status(201).json(job)
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
    let incompleteSubtitleSections: string[] = []

    if (existsSync(stitchedMetaPath)) {
      try {
        stitchedMeta = JSON.parse(await fs.readFile(stitchedMetaPath, 'utf-8'))
        incompleteSubtitleSections = Array.from(new Set([
          ...findIncompleteSubtitleSections(stitchedMeta?.sections),
          ...(Array.isArray(stitchedMeta?.missing_sections) ? stitchedMeta.missing_sections : []),
        ]))
      } catch { /* ignore */ }
    }
    if (existsSync(scenePlanPath)) {
      try {
        scenePlan = JSON.parse(await fs.readFile(scenePlanPath, 'utf-8')) as ScenePlan
        if (clearLegacyPlannerFallbackReasons(scenePlan.scenes)) {
          await fs.writeFile(scenePlanPath, JSON.stringify(scenePlan, null, 2), 'utf-8')
        }
      } catch { /* ignore */ }
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
        incomplete_sections: incompleteSubtitleSections,
      } : null,
      plan_stale_vs_stitched: planStaleVsStitched,
      scene_plan: scenePlan,
      coverage_integrity: scenePlan ? inspectScenePlanCoverage(scenePlan) : null,
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
    await invalidateScenePlanStatus(slug, episodeId)
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
    await invalidateScenePlanStatus(slug, episodeId)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete scene plan'))
  }
})
