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
import { randomUUID } from 'node:crypto'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { resolveEpisodeMergedAudioChoice } from '../lib/merged-audio-selection.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { findIncompleteSubtitleSections } from '../services/subtitle-stitcher.js'
import { resolveTranscriptSrt, resolveTranscriptSrtPath, stitchedSrtPath } from '../services/subtitle-correction.js'
import { planEndSec } from '../lib/scene-plan-timeline.js'
import { inspectSubtitleText } from '../lib/subtitle-quality.js'
import { readSubtitleTimelineIntegrity } from '../services/scene-timeline-integrity.js'
import { parseSavedScenePlanPacing, parseScenePacing } from '../contracts/pacing.js'
import { readEpisodeMotionScope, resolveEpisodeMotionSceneIds } from '../services/episode-motion-scope.js'
import { motionPromptSceneIds } from '../services/scene-motion-prompt-scope.js'
import { normalizeMotionScope } from '../contracts/motion-scope.js'
import { readVideoVisualSource } from '../services/video-visual-source.js'
import { allowedSubtitleCueGapSec, resolveScenePlanRepairPacing } from '../services/scene-plan-pacing.js'
import { safetyMode } from '../services/safety-checks.js'
import { requireScenePlanGenStudioModel, SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import {
  COVERAGE_FAIL_SEC,
  inspectScenePlanCoverage,
  repairOverlongScenesDeterministically,
  repairPlanCoverageWithSubtitleCues,
} from '../services/scene-planner.js'
import {
  parseScenePromptPackSetting,
  parseScenePromptTokenSetting,
  type ScenePromptPackSetting,
} from '../services/scene-prompt-batching.js'
import { measureAssemblyOverhead, parsePromptCharCap } from '../services/prompt-char-cap.js'
import { readSceneRenderAssembly, sceneRenderAssemblyParts } from '../services/scene-prompt-assembly.js'
import { freshActionMatch, freshActionFingerprint, readOperationId, readOptionalOperationId, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import {
  composeScenePlanGuidance,
  resolveExactPreset,
  resolveScenePlanPromptCharCap,
  scenePlanPresetReceipt,
} from '../services/preset-authority.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { listImageModels } from '../lib/genstudio-client.js'
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

function scenePromptReplayFingerprint(params: Record<string, unknown>) {
  const model = typeof params.model === 'string'
    ? params.model.trim().replace(/^genstudio-chat:/i, '')
    : ''
  return freshActionFingerprint({
    episode_id: params.episode_id,
    model,
    regenerate_prompt_scene_id: params.regenerate_prompt_scene_id,
    regenerate_prompt_scene_ids: params.regenerate_prompt_scene_ids,
    reword_prompt: params.reword_prompt,
    detail_level: params.detail_level,
    style_prompt: params.style_prompt,
    custom_instructions: params.custom_instructions,
    creative_direction: params.creative_direction,
    prompt_char_cap: params.prompt_char_cap,
    prompt_char_cap_selection: params.prompt_char_cap_selection,
    intended_image_model: params.intended_image_model,
    avoid_legible_text: params.avoid_legible_text,
  })
}

/**
 * The character-ceiling fields exactly as the job will store them.
 *
 * Both the replay fingerprint AND the enqueued params are built from this one
 * object. A lost-response retry re-sends the same body, so the fingerprint it
 * reconstructs must match the one on the stored job byte for byte — two
 * separately-parsed copies of `prompt_char_cap` were enough to turn that retry
 * into a 409.
 */
function scenePromptCapFields(body: Record<string, unknown>) {
  return {
    prompt_char_cap: parsePromptCharCap(body.prompt_char_cap),
    prompt_char_cap_selection: body.prompt_char_cap_selection,
    intended_image_model: typeof body.intended_image_model === 'string' ? body.intended_image_model.trim() : '',
  }
}

async function assertScenePlanVisualSource(slug: string, episodeId: string) {
  const source = await readVideoVisualSource(slug, episodeId)
  if (source.source !== 'scene_plan') throw new Error('This episode uses Image Pool. Open Image Pool selection, or choose Scene Plan before generating scenes.')
  return source.source
}

/** Freeze the episode decision before enqueue; Retry never re-reads a wider scope. */
export async function scenePlanVisualSnapshot(
  slug: string,
  episodeId: string,
  stage: string,
  limit?: number,
  portableMotionScope?: unknown,
) {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const visual_source = await assertScenePlanVisualSource(slug, episodeId)
  if (stage === 'visual') return { visual_source, motion_scope: { mode: 'off' } as const, motion_level: 2, motion_scene_ids: undefined, pacing: undefined }
  const motion = await readEpisodeMotionScope(slug, episodeId, paths.episode_dir)
  const motion_scope = portableMotionScope === undefined
    ? motion.motion_scope
    : normalizeMotionScope(portableMotionScope)
  let pacing
  if (stage === 'timeline') {
    let saved: unknown
    try { saved = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'continuity.json'), 'utf8')).pacing }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    pacing = parseScenePacing(saved)
  }
  let motion_scene_ids: string[] | undefined
  if (stage === 'motion') {
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
    motion_scene_ids = motionPromptSceneIds(plan.scenes, motion_scope, undefined, limit)
  }
  return { visual_source, ...motion, motion_scope, ...(pacing ? { pacing } : {}),
    ...(motion_scene_ids === undefined ? {} : { motion_scene_ids }) }
}

/** Freeze one eligible motion-prompt target before the job is accepted. */
export async function scenePlanMotionPromptSnapshot(slug: string, episodeId: string, sceneId: string) {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const visual_source = await assertScenePlanVisualSource(slug, episodeId)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  if (!plan.scenes.some(scene => scene.id === sceneId)) {
    throw new Error(`Scene ${sceneId} not found in scene_plan.json`)
  }
  const motion = await resolveEpisodeMotionSceneIds(slug, episodeId, plan.scenes, paths.episode_dir)
  if (!motion.scene_ids.includes(sceneId)) {
    throw new Error(`Scene ${sceneId} is outside this episode's saved motion scope.`)
  }
  return {
    visual_source,
    motion_scope: motion.motion_scope,
    motion_level: motion.motion_level,
    motion_scene_ids: [sceneId],
  }
}

async function invalidateScenePlanStatus(slug: string, episodeId: string): Promise<void> {
  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
  episodeStatusCache.invalidate(slug, episodeId)
}

// ── GET /scene-plan-opening ────────────────────────────────────────────
// What Video Assembly will play before the first scene, measured from the
// project's real clips. The Scene Plan page shows this instead of asking the
// customer to remember a number: since v1.3.1 the timeline reserves exactly
// this, so a control that let him type a different one would be a lie.
//
// Deliberately NOT under `/scene-plan/:episodeId` — the opening is a project
// fact, and that path pattern would swallow it as an episode id.
router.get('/projects/:slug/scene-plan-opening', async (req, res) => {
  const { slug } = req.params
  try {
    const { resolveProjectOpening } = await import('../services/opening-assets.js')
    const { measureOpeningSec, describeOpeningHead } = await import('../lib/opening-duration.js')
    const { head, unresolved } = await resolveProjectOpening(slug)
    const seconds = await measureOpeningSec(head, getAudioDuration)
    res.json({
      seconds,
      breakdown: await describeOpeningHead(head, getAudioDuration),
      unresolved,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not measure the opening clips'))
  }
})

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
    // v1.3.4 — no `.catch(() => 0)`. A failure here used to be spelled exactly
    // the same way as "this episode has no intro", so a timeline that started
    // sixteen seconds early was indistinguishable from a correct one. The
    // resolver now says which of the two happened, and the answer travels back
    // to the Subtitles page instead of being swallowed here.
    //
    // v1.4.0 — routed through `ensureStitchedSubtitle` rather than calling the
    // stitcher directly. Every stitch must record the fingerprint of what it was
    // built from, or the automatic freshness check at render time would find no
    // record beside a perfectly good file and rebuild it on every single render.
    // One stitch entry point, one place that writes the record. `force`, because
    // this is the manual button: the customer pressed Re-stitch and expects a
    // stitch, not a report that nothing needed doing.
    const { ensureStitchedSubtitle } = await import('../lib/subtitle-autostitch.js')
    const outcome = await ensureStitchedSubtitle({
      episodeDir: paths.episode_dir,
      subtitlesDir: paths.subtitles_dir,
      mergedAudioDir: paths.merged_audio_dir,
      audioDir: paths.audio_dir,
      episodeCode: episodeId.toUpperCase(),
      force: true,
    })
    if (outcome.status !== 'stitched') {
      // With `force` this is only reachable when there was nothing to stitch at
      // all, which the customer needs told plainly rather than as a fake success.
      return res.status(400).json({ detail: `Nothing to stitch: ${outcome.reason}` })
    }
    res.json({ ...outcome.result, lead_in: outcome.lead_in })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Subtitle stitching failed'))
  }
})

// ── POST /scene-plan/:ep/run ──────────────────────────────────────────
router.post('/projects/:slug/scene-plan/:episodeId/run', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  let operationId: string | null
  try { operationId = readOptionalOperationId(body) || randomUUID() }
  catch (error: any) { return res.status(400).json({ detail: error.message }) }
  return withLock(`fresh-scene-plan:${slug}:${operationId}`, async () => {
    const acceptedFingerprint = stampFreshGenerationAction(body, operationId!).generation_action_fingerprint
    const accepted = (await jq.findJobs(slug, freshActionMatch(operationId!)))[0]
    if (accepted) {
      if (accepted.type !== 'scene_plan_run' || accepted.episode_id !== episodeId) {
        return res.status(409).json({ detail: 'This operation_id already belongs to a different Scene Plan episode or route.' })
      }
      if (accepted.params?.generation_action_fingerprint !== acceptedFingerprint) {
        return res.status(409).json({ detail: 'This operation_id already belongs to a different Scene Plan request.' })
      }
      return res.status(200).json({ ...accepted, reused: true })
    }

    const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  const resolved = resolveExactPreset(
    config,
    'scene_plan_presets',
    ['scene_plan_last_preset_scene-plan', 'scene_plan_last_preset'],
    body.preset_id,
    'Scene Plan',
    Object.prototype.hasOwnProperty.call(body, 'preset_id'),
  )
  if (!resolved.preset) return res.status(409).json({ detail: resolved.missingReason })
  const resolvedPreset = scenePlanPresetReceipt(resolved.preset)
  const presetData = resolvedPreset.data
  const stage: 'timeline' | 'visual' | 'motion' =
    body.stage === 'visual' || body.stage === 'motion' ? body.stage : 'timeline'
  try { await assertScenePlanVisualSource(slug, episodeId) }
  catch (error: any) { return res.status(409).json({ detail: error.message }) }
  let model = typeof presetData.model === 'string' ? presetData.model.trim() : ''
  if (!model && stage !== 'timeline') return res.status(400).json({ detail: 'model is required' })
  if (stage !== 'timeline') {
    try {
      model = await requireScenePlanGenStudioModel(model)
    } catch (error: any) {
      return res.status(409).json(humanizeBackendError(error, 'The scene-planning model is not available right now'))
    }
  }

  const targetSceneCount = typeof body.target_scene_count === 'number' ? body.target_scene_count : undefined
  const useResearch = presetData.use_research === false ? false : true  // default true
  const title = typeof body.title === 'string' ? body.title : ''
  // v1.0.242 — visual-prompt detail level (1–4) + global style + custom text.
  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : 4
  const customInstructions = composeScenePlanGuidance(body.custom_instructions, presetData.reusable_guidance)
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
  // v1.3.1 — `opening_mode` / `opening_reserved_sec` are deliberately NOT read
  // off the request any more. The timeline stage probes the project's real
  // opening clips instead (services/opening-assets.ts), so no caller — page,
  // Pipeline, or a preset behind either — can assert a length the files
  // disagree with. Old clients may still send the fields; they are ignored.
  const promptLimit = typeof body.prompt_limit === 'number'
    ? Math.max(1, Math.min(5000, Math.round(body.prompt_limit))) : undefined
  // A batch size this server cannot honour is REPORTED, never swapped for a
  // different number. `parseScenePromptPackSetting` throws rather than falling
  // back to 'auto' — the old behaviour turned "200" into 50 in silence.
  let promptPackSize: ScenePromptPackSetting
  try {
    promptPackSize = parseScenePromptPackSetting(presetData.prompt_pack_size)
  } catch (error: any) {
    return res.status(400).json({ detail: error?.message || 'Invalid prompt_pack_size' })
  }
  const promptMaxTokens = parseScenePromptTokenSetting(presetData.prompt_max_tokens)
  // Resolved by the workspace from the SELECTED image model's published
  // `max_prompt_characters`. Absent = nothing published = no target.
  let promptCharCap = parsePromptCharCap(presetData.prompt_char_cap)
  if (stage === 'visual' && presetData.intended_image_model) {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) return res.status(409).json({ detail: 'Add the Gateway API Key in Settings before generating visual prompts.' })
    try { promptCharCap = resolveScenePlanPromptCharCap(presetData, await listImageModels(apiKey)) }
    catch (error: any) { return res.status(409).json({ detail: error.message }) }
  }
  const creativeDirection = parseCreativeDirection(presetData.creative_direction)
  // v1.0.794 — SCENE prompts only; the frontend sends the current state of
  // the Scene Plan page's toggle. Omitted → the generator falls back to the
  // project default. Never read by the (separate) Thumbnail Prompts path.
  const avoidLegibleText = typeof presetData.avoid_legible_text === 'boolean' ? presetData.avoid_legible_text : undefined

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `Scene plan already running for ${episodeId}` })
  }

  let visualSnapshot
  try { visualSnapshot = await scenePlanVisualSnapshot(slug, episodeId, stage, promptLimit, presetData.motion_scope) }
  catch (error: any) { return res.status(409).json({ detail: error.message }) }
  if (stage === 'motion' && !visualSnapshot.motion_scene_ids?.length) {
    return res.status(409).json({ detail: 'No missing motion prompts in this episode’s saved scope. Choose motion scenes in Visual timing & motion.' })
  }
  const params = stampFreshGenerationAction({
      ...visualSnapshot,
      episode_id: episodeId,
      title,
      model: model || 'deterministic-timeline',
      target_scene_count: targetSceneCount,
      use_research: useResearch,
      detail_level: detailLevel,
      motion_level: presetData.motion_level ?? visualSnapshot.motion_level,
      generate_motion_prompts: generateMotionPrompts,
      style_prompt: undefined,
      custom_instructions: customInstructions,
      window_size: windowSize,
      cross_window_context: crossWindowContext,
      planning_mode: planningMode,
      neighbor_context_back: ncBack,
      neighbor_context_forward: ncForward,
      stage,
      prompt_limit: promptLimit,
      prompt_pack_size: promptPackSize,
      prompt_max_tokens: promptMaxTokens,
      prompt_char_cap: promptCharCap,
      // The SELECTION, not only the admission-time number. The job re-resolves
      // it against the LIVE catalogue when it runs, so a model or catalogue
      // change between admission and execution follows the selected model.
      // Older queued jobs have no selection; the generator keeps their number.
      prompt_char_cap_selection: presetData.prompt_char_cap,
      creative_direction: creativeDirection,
      avoid_legible_text: avoidLegibleText,
      intended_image_model: presetData.intended_image_model,
      pacing: presetData.pacing ?? visualSnapshot.pacing,
      motion_scope: presetData.motion_scope ?? visualSnapshot.motion_scope,
      resolved_preset: resolvedPreset,
  }, operationId!)
  // Replay identity belongs to the exact client body. Resolved preset and
  // catalogue values are an immutable receipt, not inputs to retry matching.
  params.generation_action_fingerprint = acceptedFingerprint
  const job = await jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `${stage === 'timeline' ? 'Build scene timeline' : stage === 'visual' ? 'Generate visual prompts' : 'Generate motion prompts'} — ${episodeId}`,
    params,
  })
  res.status(201).json(job)
  })
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
//
// `scene_ids` (instead of `scene_id`) is Scene Plan's "Regenerate prompts" for
// the selected scenes: one job rewrites each chosen scene's visual_prompt in
// turn with the page's chosen writing model. Nothing else on those scenes —
// image, approval, timing — is touched.
const MAX_SELECTED_PROMPT_SCENES = 1000
router.post('/projects/:slug/scene-plan/:episodeId/regenerate-prompt', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  let sceneIds: string[] | undefined
  if (body.scene_ids !== undefined) {
    if (!Array.isArray(body.scene_ids) || !body.scene_ids.length || body.scene_ids.length > MAX_SELECTED_PROMPT_SCENES
      || body.scene_ids.some((id: unknown) => typeof id !== 'string' || !id.trim())) {
      return res.status(400).json({ detail: `scene_ids must list 1–${MAX_SELECTED_PROMPT_SCENES} scene ids.` })
    }
    if (body.scene_id !== undefined) return res.status(400).json({ detail: 'Send scene_id or scene_ids, not both.' })
    if (body.reword_prompt === true) return res.status(400).json({ detail: 'Reword works on one scene at a time.' })
    sceneIds = [...new Set<string>(body.scene_ids.map((id: string) => id.trim()))]
  }
  const sceneId = sceneIds ? '' : typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  if (!sceneIds && !sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  const target = sceneIds
    ? { regenerate_prompt_scene_ids: sceneIds }
    : { regenerate_prompt_scene_id: sceneId }
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''

  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''
  const creativeDirection = parseCreativeDirection(body.creative_direction)
  // One parsed copy, used for BOTH the replay fingerprint and the stored job.
  const capFields = scenePromptCapFields(body as Record<string, unknown>)
  // A user-invoked REWORD of a prompt that did not render: same beat, different
  // angle, difficult-subjects guidance applied. Only the explicit action sets
  // it — no failure is inspected to infer it. See lib/image-content-guidance.ts.
  const rewordPrompt = body.reword_prompt === true
  const avoidLegibleText = typeof body.avoid_legible_text === 'boolean' ? body.avoid_legible_text : undefined
  let operationId: string
  try { operationId = readOperationId(body, true)! } catch (error) {
    // Keep the Image Pool boundary ahead of malformed new-request details;
    // only a valid receipt may bypass it to rejoin an existing action below.
    try { await assertScenePlanVisualSource(slug, episodeId) }
    catch (sourceError: any) { return res.status(409).json({ detail: sourceError.message }) }
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }

  return withLock(`fresh-scene-prompt:${slug}:${operationId}`, async () => {
    const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
    if (previous) {
      const replay = {
        episode_id: episodeId,
        model: requestedModel,
        ...target,
        reword_prompt: rewordPrompt || undefined,
        detail_level: detailLevel,
        style_prompt: stylePrompt || undefined,
        custom_instructions: customInstructions || undefined,
        creative_direction: creativeDirection,
        ...capFields,
        avoid_legible_text: avoidLegibleText,
      }
      if (previous.type !== 'scene_plan_run' || scenePromptReplayFingerprint(previous.params as Record<string, unknown>) !== scenePromptReplayFingerprint(replay)) {
        return res.status(409).json({ detail: 'This operation_id already belongs to a different scene prompt request.' })
      }
      return res.status(200).json({ ...previous, reused: true })
    }
    let visualSnapshot
    try { visualSnapshot = await scenePlanVisualSnapshot(slug, episodeId, 'visual') }
    catch (error: any) { return res.status(409).json({ detail: error.message }) }
    let model = requestedModel
    if (!model) return res.status(400).json({ detail: 'model is required' })
    if (sceneIds) {
      // Every selected scene must still be in the saved plan — a stale page
      // selection is reported, never silently narrowed.
      try {
        const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
        const plan = JSON.parse(await fs.readFile(await resolveScenePlanPath(slug, episodeId, paths.episode_dir), 'utf8')) as ScenePlan
        const known = new Set(plan.scenes.map(scene => scene.id))
        const gone = sceneIds.filter(id => !known.has(id))
        if (gone.length) {
          return res.status(409).json({ detail: `${gone.length} selected scene${gone.length === 1 ? ' is' : 's are'} no longer in this episode's plan. Reload the page and select again.` })
        }
      } catch (error: any) {
        if (error?.code === 'ENOENT') return res.status(404).json({ detail: 'No scene plan yet — build the timeline first.' })
        throw error
      }
    }
    // v1.0.343 — scene planning/rewrite is an LLM task. Reject IMAGE models up
    // front with a clear, fast error (passing one used to time out deep in the
    // text client as "Unsupported model").
    if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
      return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
    }
    try {
      model = await requireScenePlanGenStudioModel(model)
    } catch (error: any) {
      return res.status(409).json(humanizeBackendError(error, 'The scene-planning model is not available right now'))
    }
    const params = stampFreshGenerationAction({
      ...visualSnapshot,
      episode_id: episodeId,
      model,
      ...target,
      reword_prompt: rewordPrompt || undefined,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
      creative_direction: creativeDirection,
      ...capFields,
      avoid_legible_text: avoidLegibleText,
    }, operationId)
    if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
      return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'scene_plan_run' as JobType,
      episode_id: episodeId,
      title: sceneIds
        ? `Regenerate prompts (${sceneIds.length} scene${sceneIds.length === 1 ? '' : 's'}) — ${episodeId}`
        : `${rewordPrompt ? 'Reword' : 'Regen'} prompt — ${episodeId}`,
      params,
    })
    return res.status(201).json(job)
  })
})

// ── POST /scene-plan/:ep/regenerate-empty-prompts ─────────────────────
// Repair every missing or duplicated visual prompt through the same bounded,
// durable GenStudio packs used by normal prompt generation.
router.post('/projects/:slug/scene-plan/:episodeId/regenerate-empty-prompts', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  let visualSnapshot
  try { visualSnapshot = await scenePlanVisualSnapshot(slug, episodeId, 'visual') }
  catch (error: any) { return res.status(409).json({ detail: error.message }) }
  let model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  // Scene planning/rewrite is an LLM task — reject IMAGE models up front.
  if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
    return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
  }
  try {
    model = await requireScenePlanGenStudioModel(model)
  } catch (error: any) {
    return res.status(409).json(humanizeBackendError(error, 'The scene-planning model is not available right now'))
  }

  const detailLevel = typeof body.detail_level === 'number'
    ? Math.min(4, Math.max(1, Math.round(body.detail_level)))
    : undefined
  const stylePrompt = typeof body.style_prompt === 'string' ? body.style_prompt.trim() : ''
  const customInstructions = typeof body.custom_instructions === 'string' ? body.custom_instructions.trim() : ''
  const creativeDirection = parseCreativeDirection(body.creative_direction)
  // A batch size this server cannot honour is REPORTED, never swapped for a
  // different number. `parseScenePromptPackSetting` throws rather than falling
  // back to 'auto' — the old behaviour turned "200" into 50 in silence.
  let promptPackSize: ScenePromptPackSetting
  try {
    promptPackSize = parseScenePromptPackSetting(body.prompt_pack_size)
  } catch (error: any) {
    return res.status(400).json({ detail: error?.message || 'Invalid prompt_pack_size' })
  }
  const promptMaxTokens = parseScenePromptTokenSetting(body.prompt_max_tokens)
  // The SELECTION and the model it was chosen for travel with the job; the
  // executor resolves the ceiling live. A legacy client sends only the number,
  // which is kept as a saved allowance.
  const capFields = scenePromptCapFields(body as Record<string, unknown>)
  const useResearch = body.use_research !== false
  const avoidLegibleText = typeof body.avoid_legible_text === 'boolean' ? body.avoid_legible_text : undefined

  if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
    return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'scene_plan_run' as JobType,
    episode_id: episodeId,
    title: `Repair scene prompts — ${episodeId}`,
    params: {
      ...visualSnapshot,
      episode_id: episodeId,
      model,
      regenerate_empty_prompts: true,
      detail_level: detailLevel,
      style_prompt: stylePrompt || undefined,
      custom_instructions: customInstructions || undefined,
      creative_direction: creativeDirection,
      prompt_pack_size: promptPackSize,
      prompt_max_tokens: promptMaxTokens,
      ...capFields,
      use_research: useResearch,
      avoid_legible_text: avoidLegibleText,
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

    await withLock(sidecarPath, async () => {
      // Re-read under the lock: the plan was read before the checks above, and a
      // job or another request may have written the file since.
      const fresh = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
      const target = fresh.scenes.find(item => item.id === sceneId)
      if (!target) throw new Error(`Scene ${sceneId} not found in scene_plan.json`)
      target.visual_prompt = visualPrompt
      target.approved = false  // image is now stale vs the edited prompt
      await writeJsonAtomic(sidecarPath, fresh)
    })
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

    // The merged track this episode renders with — the owner's explicit choice
    // when he made one (v1.4.314), else the largest file (the long-standing
    // heuristic). Repairing coverage against a track the render will not use
    // would re-time the plan to the wrong narration.
    if (!existsSync(paths.merged_audio_dir)) {
      return res.status(400).json({ detail: 'No merged audio yet — run Audio Merge first, then repair coverage.' })
    }
    const mergedChoice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, episodeId)
    if (mergedChoice.source === 'invalid') {
      return res.status(409).json({
        detail: `${episodeId.toUpperCase()}'s selected merged audio "${mergedChoice.pinned}" is not in this `
          + 'episode\'s merged-audio folder. Choose this episode\'s narration again in Video Assembly Step 1, then retry.',
      })
    }
    let audioPath = ''
    if (mergedChoice.source === 'selected') {
      audioPath = path.join(paths.merged_audio_dir, mergedChoice.filename!)
    } else if (mergedChoice.source === 'unset') {
      let bestSize = 0
      for (const f of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
        if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
        const st = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
        if (st && st.size > bestSize) { bestSize = st.size; audioPath = path.join(paths.merged_audio_dir, f) }
      }
    }
    if (!audioPath) return res.status(400).json({ detail: 'No merged audio file found — run Audio Merge first.' })
    const audioDur = (await getAudioDuration(audioPath)) || 0
    if (audioDur <= 0) return res.status(400).json({ detail: `Could not read the audio duration of ${path.basename(audioPath)}.` })

    const stitchedPath = stitchedSrtPath(paths.subtitles_dir, episodeId)
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
    // Integrity is judged on the raw stitch; cues are read from the corrected
    // transcript so a repaired scene carries the script's words, not Whisper's.
    const transcriptPath = await resolveTranscriptSrtPath({
      subtitles_dir: paths.subtitles_dir, script_dir: paths.script_dir, episode_code: episodeId,
    })
    const cues = parseSrt(await fs.readFile(transcriptPath, 'utf-8'))
    if (!cues.length) return res.status(400).json({ detail: 'The stitched subtitle timeline has no cues.' })
    // The plan's end is the later of the measured audio and the verified captions —
    // the SAME number the continuation reader compares against
    // (`plan.total_duration_sec < current.last_cue_end_sec - 0.001`). Repaired to the
    // audio alone, a plan whose captions end a few ms later is written shorter than
    // its own timeline, so Scene Plan then rejects the repair it just made and
    // demands a rebuild (DL0011: 6083.290 < 6083.292).
    const repairedEndSec = planEndSec(audioDur, cues)

    // Defer parsing the current draft until the locked plan read proves this is
    // a legacy plan without its own pacing snapshot. A malformed unrelated
    // draft must not block repair of a plan whose saved timing is authoritative.
    const continuityPath = path.join(paths.episode_dir, 'continuity.json')
    const continuityText = await fs.readFile(continuityPath, 'utf8').catch((error: any) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })

    // Everything above is preparation that does not touch the plan (ffprobe, SRT
    // parsing, pacing config) and is deliberately OUTSIDE the lock. Only the
    // read-transform-write below needs mutual exclusion, so it is all it holds.
    const repaired = await withLock(sidecarPath, async () => {
      // Re-read under the lock: the plan was read before the checks above, and a
      // job or another request may have written the file since.
      const fresh = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
      const repairPacing = resolveScenePlanRepairPacing(fresh.pacing, continuityText)
      const result = repairPlanCoverageWithSubtitleCues({
        scenes: fresh.scenes,
        cues,
        audioDurationSec: repairedEndSec,
        threshold_sec: 20,
        min_sec: repairPacing.min_sec,
        max_sec: repairPacing.max_sec,
        pacing: repairPacing.pacing,
        // Opt-in, never inferred: holding scene 1 across a long unplanned
        // opening is an editorial choice with a visible consequence, so it
        // happens only when the request asks for it by name.
        hold_head_scene: (req.body as any)?.hold_head_scene === true,
      })
      fresh.scenes = result.scenes
      fresh.total_duration_sec = repairedEndSec
      await writeJsonAtomic(sidecarPath, fresh)
      return result
    })
    await invalidateScenePlanStatus(slug, episodeId)
    // A head gap this repair deliberately left alone is the one deficit the
    // caller cannot see in `changes` (nothing changed). Name it, so the page
    // can offer the choice instead of reporting a no-op repair.
    const headGapLeft = repaired.coverageAfter.headGapSec > COVERAGE_FAIL_SEC
      ? repaired.coverageAfter.headGapSec
      : 0
    res.json({
      ok: true,
      audio_duration_sec: audioDur,
      changes: repaired.changes,
      coverage_before: repaired.coverageBefore,
      coverage_after: repaired.coverageAfter,
      repaired_long_scene_count: repaired.repairedLongSceneCount,
      added_scene_count: repaired.addedSceneCount,
      head_gap_left_sec: headGapLeft,
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
    const stitchedPath = stitchedSrtPath(paths.subtitles_dir, episodeId)
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

    // Integrity above is judged on the raw stitch; the cues a repaired scene
    // inherits its narration from come from the corrected transcript.
    const transcriptPath = await resolveTranscriptSrtPath({
      subtitles_dir: paths.subtitles_dir, script_dir: paths.script_dir, episode_code: episodeId,
    })
    const cues = parseSrt(await fs.readFile(transcriptPath, 'utf-8'))
    if (!cues.length) return res.status(400).json({ detail: 'The stitched subtitle timeline has no cues.' })

    // As in coverage repair, keep the draft opaque until the locked plan read
    // establishes that this older plan has no saved pacing of its own.
    const continuityPath = path.join(paths.episode_dir, 'continuity.json')
    const continuityText = await fs.readFile(continuityPath, 'utf8').catch((error: any) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })

    // Prep (SRT parse, pacing config) stays outside the lock; only the
    // read-transform-write is serialised.
    const repaired = await withLock(planPath, async () => {
      // Re-read under the lock: the plan was read before the checks above, and a
      // job or another request may have written the file since.
      const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      const repairPacing = resolveScenePlanRepairPacing(fresh.pacing, continuityText)
      const result = repairOverlongScenesDeterministically({
        scenes: fresh.scenes || [],
        cues,
        threshold_sec: repairPacing.max_sec,
        min_sec: repairPacing.min_sec,
        max_sec: repairPacing.max_sec,
        pacing: repairPacing.pacing,
      })
      // Nothing to repair — leave the file untouched and let the caller answer 400.
      if (!result.repairedCount) return { ...result, hasSavedPacing: fresh.pacing !== undefined, repairMaxSec: repairPacing.max_sec }
      fresh.scenes = result.scenes
      fresh.generated_at = new Date().toISOString()
      fresh.planning_stage = 'timeline'
      await writeJsonAtomic(planPath, fresh)
      return { ...result, hasSavedPacing: fresh.pacing !== undefined, repairMaxSec: repairPacing.max_sec }
    })
    if (!repaired.repairedCount) {
      // v1.4.82 — do not claim "nothing exceeds the cap" when scenes DO exceed
      // it and merely hold too little subtitle material to divide. That wording
      // sent people back to re-stitch subtitles that were already correct.
      const detail = repaired.unsplittableCount
        ? `${repaired.unsplittableCount} scene(s) run past the ${repaired.hasSavedPacing ? 'saved Scene Plan pacing cap' : `selected ${repaired.repairMaxSec}-second pacing cap`} but could not be split further — `
          + 'each holds a single indivisible subtitle cue, or spans a silent gap with no narration to cut on. '
          + 'Shorten those holds by hand in Scene Plan, or raise the pacing maximum in Visual timing & motion.'
        : `No scenes exceed the ${repaired.hasSavedPacing ? 'saved Scene Plan pacing cap' : `selected ${repaired.repairMaxSec}-second pacing cap`}. If subtitles were just restored, stitch them again before retrying.`
      return res.status(400).json({ detail, unsplittable_count: repaired.unsplittableCount })
    }
    await invalidateScenePlanStatus(slug, episodeId)
    res.json({
      ok: true,
      unsplittable_count: repaired.unsplittableCount,
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
    const { reconcileScenePlanTimings } = await import('../services/scene-plan-reconcile.js')
    res.json({ ok: true, ...await reconcileScenePlanTimings(slug, episodeId) })
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 400 || e?.statusCode === 409) return res.status(e.statusCode).json({ detail: e.message })
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

    await withLock(sidecarPath, async () => {
      // Re-read under the lock: the plan was read before the checks above, and a
      // job or another request may have written the file since.
      const fresh = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
      const target = fresh.scenes.find(item => item.id === sceneId)
      if (!target) throw new Error(`Scene ${sceneId} not found in scene_plan.json`)
      target.motion_prompt = motionPrompt
      await writeJsonAtomic(sidecarPath, fresh)
    })
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
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  let operationId: string
  try { operationId = readOperationId(body, true)! } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
  return withLock(`fresh-motion-prompt:${slug}:${operationId}`, async () => {
    const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
    if (previous) {
      const previousModel = typeof previous.params.model === 'string'
        ? previous.params.model.replace(/^genstudio-chat:/, '') : ''
      const requestedModelId = requestedModel.replace(/^genstudio-chat:/, '')
      if (previous.episode_id !== episodeId
        || previous.params.regenerate_motion_prompt_scene_id !== sceneId
        || requestedModelId !== previousModel) {
        return res.status(409).json({ detail: 'This operation_id already belongs to a different motion prompt request.' })
      }
      return res.status(200).json({ ...previous, reused: true })
    }
    try { await assertScenePlanVisualSource(slug, episodeId) }
    catch (error: any) { return res.status(409).json({ detail: error.message }) }
    let motionSnapshot
    try { motionSnapshot = await scenePlanMotionPromptSnapshot(slug, episodeId, sceneId) }
    catch (error: any) { return res.status(409).json({ detail: error.message }) }
    let model = requestedModel
    if (!model) return res.status(400).json({ detail: 'model is required' })
    if (/^(imagestudio|kie|fal|runware|replicate):/i.test(model)) {
      return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
    }
    try {
      model = await requireScenePlanGenStudioModel(model)
    } catch (error: any) {
      return res.status(409).json(humanizeBackendError(error, 'The scene-planning model is not available right now'))
    }
    const params = stampFreshGenerationAction({
      ...motionSnapshot,
      episode_id: episodeId,
      model,
      regenerate_motion_prompt_scene_id: sceneId,
    }, operationId)
    if (jq.isDuplicate(slug, episodeId, 'scene_plan_run' as JobType)) {
      return res.status(409).json({ detail: `A scene-plan job is already running for ${episodeId}` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'scene_plan_run' as JobType,
      episode_id: episodeId,
      title: `Regen motion prompt — ${episodeId}`,
      params,
    })
    return res.status(201).json(job)
  })
})

// ── GET /scene-plan/:ep ───────────────────────────────────────────────
// Returns the existing plan + status flags so the page can render the
// 3-step wizard correctly (stitch ready? plan ready? drift?).
router.get('/projects/:slug/scene-plan/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const stitchedPath = stitchedSrtPath(paths.subtitles_dir, episodeId)
    const stitchedMetaPath = `${stitchedPath}.json`
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
          // A read path that writes. Same rule applies: re-read under the lock and
          // strip the legacy reasons from THAT copy, or this GET can quietly undo a
          // write a running job made between its own read and this migration.
          scenePlan = await withLock(scenePlanPath, async () => {
            const fresh = JSON.parse(await fs.readFile(scenePlanPath, 'utf-8')) as ScenePlan
            if (clearLegacyPlannerFallbackReasons(fresh.scenes)) await writeJsonAtomic(scenePlanPath, fresh)
            return fresh
          })
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
    if (existsSync(stitchedPath)) {
      try {
        const stitchedMs = (await fs.stat(stitchedPath)).mtimeMs
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
    if (existsSync(scenePlanPath) && existsSync(stitchedPath)) {
      try {
        const planMs = (await fs.stat(scenePlanPath)).mtimeMs
        const stitchedMs = (await fs.stat(stitchedPath)).mtimeMs
        if (stitchedMs > planMs + 2000) planStaleVsStitched = true
      } catch { /* best-effort */ }
    }

    // What the planner will actually read, and why. Surfaced rather than left
    // implicit: a correction the operator cannot see is a correction they
    // cannot audit when a place name looks wrong on screen.
    const transcript = await resolveTranscriptSrt({
      subtitles_dir: paths.subtitles_dir, script_dir: paths.script_dir, episode_code: episodeId,
    })

    // v1.2.2 — text quality of the exact transcript the planner will read.
    //
    // This matters more here than on a caption. Scene Plan turns this text into
    // each scene's `transcript_segment`, which is fed verbatim to the model
    // that writes the image prompts — so a hallucinated block does not merely
    // look wrong in a subtitle, it buys wrong pictures. Someone about to spend
    // credits on a batch of images deserves to see it beforehand.
    //
    // Advisory only: it is reported, never enforced. Planning stays available.
    const transcriptQuality = transcript.path
      ? await fs.readFile(transcript.path, 'utf-8').then(inspectSubtitleText).catch(() => null)
      : null
    const captionGapMode = await safetyMode(slug, 'caption_gap')
    const subtitleTimelineIntegrity = existsSync(stitchedPath)
      ? await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId, {
        max_cue_gap_sec: allowedSubtitleCueGapSec(),
        cue_source_path: transcript.path,
      }).then(integrity => ({
        ...integrity,
        caption_gap_mode: captionGapMode,
        complete: integrity.missing_sections.length === 0
          && (captionGapMode !== 'block' || !integrity.blocking_cue_gaps?.length),
      }))
      : null
    const responsePlan = scenePlan
      ? { ...scenePlan, ...(scenePlan.pacing === undefined ? {} : { pacing: parseSavedScenePlanPacing(scenePlan.pacing) }) }
      : null
    // What the scene renderer appends to every prompt — measured with the same
    // composition it submits, and re-read on every load. The page compares each
    // stored prompt against the BODY budget this leaves, so its "N of M
    // characters" counter describes the same ceiling the render will meet.
    const renderAssembly = await readSceneRenderAssembly(slug, paths.episode_dir)
    const promptRenderOverhead = measureAssemblyOverhead(
      sceneRenderAssemblyParts(renderAssembly.characters, renderAssembly.styleBible, true),
    )

    res.json({
      stitched_srt: existsSync(stitchedPath) ? {
        path: stitchedPath,
        meta: stitchedMeta,
        drifts_from_current_merge: stitchedDrift,
        stale_vs_subtitles: stitchedStaleVsSubs,
        incomplete_sections: incompleteSubtitleSections,
      } : null,
      transcript_source: {
        path: transcript.path,
        corrected: transcript.corrected,
        cues_in: transcript.report?.cues_in ?? null,
        cues_out: transcript.report?.cues_out ?? null,
        cues_dropped: transcript.report?.cues_dropped ?? null,
        cues_rewritten: transcript.report?.cues_rewritten ?? null,
        chapters_corrected: transcript.report?.chapters_corrected ?? null,
        chapters_refused: transcript.report?.chapters_refused ?? null,
        warnings: transcript.report?.warnings ?? [],
        refused_chapters: (transcript.report?.chapters || [])
          .filter(chapter => !chapter.accepted)
          .map(chapter => ({ slug: chapter.slug, reason_code: chapter.reason_code || 'unknown' })),
        skipped_reason: transcript.report?.skipped_reason ?? null,
        quality: transcriptQuality,
      },
      timeline_integrity: subtitleTimelineIntegrity,
      plan_stale_vs_stitched: planStaleVsStitched,
      scene_plan: responsePlan,
      prompt_render_overhead: {
        characters: promptRenderOverhead.characters,
        parts: promptRenderOverhead.parts,
      },
      coverage_integrity: scenePlan ? inspectScenePlanCoverage(scenePlan) : null,
      audio_merged: existsSync(audioChaptersPath),
      audio_merge_gap_s: audioMergeGap,
      research_available: existsSync(researchPath),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read scene plan status'))
  }
})

/** Exactly the fields `services/scene-media-checkpoint.ts` writes for an image or clip. */
const SCENE_MEDIA_FIELDS = [
  'approved', 'image_path', 'rendered_prompt', 'image_version', 'image_sha256', 'motion_choice',
  'clip_path', 'rendered_motion_prompt', 'clip_source_image_version',
  'clip_requested_duration_seconds', 'clip_duration_seconds', 'clip_shortfall_mode',
  'clip_renderer', 'clip_source_image_sha256', 'clip_scene_window_seconds', 'clip_sketch',
] as const

/** Scene Plan edits text and timing; media on disk is authoritative for every scene id it still has. */
export function keepSavedSceneMedia(incoming: ScenePlan, onDisk: ScenePlan | null): ScenePlan {
  const saved = new Map((onDisk?.scenes || []).map(scene => [scene.id, scene]))
  return {
    ...incoming,
    scenes: incoming.scenes.map(scene => {
      const fresh = saved.get(scene.id)
      if (!fresh) return scene
      const merged: Record<string, unknown> = { ...scene }
      for (const field of SCENE_MEDIA_FIELDS) {
        if (fresh[field] === undefined) delete merged[field]
        else merged[field] = fresh[field]
      }
      return merged as unknown as typeof scene
    }),
  }
}

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
    // A whole-document replacement from the client, locked so it cannot land in
    // the middle of another writer. Image/clip results are owned by the render
    // checkpoints, so for every scene that still exists the on-disk media wins:
    // an editor opened before a render finished must not erase that render.
    await withLock(sidecarPath, async () => {
      const onDisk = await fs.readFile(sidecarPath, 'utf-8').then(text => JSON.parse(text) as ScenePlan, () => null)
      await writeJsonAtomic(sidecarPath, keepSavedSceneMedia(body as ScenePlan, onDisk))
    })
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
    // Deleting is a writer too. v1.4.72 serialised every writer of this file
    // and this one was missed, because it removes the document rather than
    // editing it — which reads like the one case that cannot lose an update.
    // It is in fact the worst of them: a job holding the lock mid
    // read-modify-write recreates the file on its way out (writeJsonAtomic
    // does mkdir -p and never checks for existence), so an unlocked unlink
    // lands in the gap and the plan the user just deleted comes back — minus
    // whatever that job did not know about. The user reloads and sees a plan
    // they deleted. Taking the same lock makes the delete wait for the job to
    // finish, so the file is gone and stays gone.
    await withLock(sidecarPath, async () => {
      try {
        await fs.unlink(sidecarPath)
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e
      }
    })
    await invalidateScenePlanStatus(slug, episodeId)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete scene plan'))
  }
})
