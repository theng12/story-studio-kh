/**
 * Scene plan job executor (v1.0.143+). Runs the LLM scene planner
 * against the stitched SRT + optional research/narration context,
 * writes the unified ScenePlan to <episode_dir>/scene_plan.json.
 *
 * Async because the LLM call can take 20-60s on a long episode.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { planScenes, planScenesTwoPass, generateVisualPromptOnly, generatePromptsForScenes, generateMotionPromptOnly, generateMotionPromptsForScenes, resolveMotionLevel, assignDensityToUntagged } from '../services/scene-planner.js'
import { isCancelled } from '../services/job-queue.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { getConfig } from '../services/project-manager.js'
import { computeStoryStartSec } from '../lib/intro-lead-in.js'
import { scanEpisodeAssets } from './video.js'
import type { Job, ScenePlan } from '../models/types.js'

/**
 * v1.0.364 — resolve the effective plan-time style. The channel "Look" is the
 * continuity Style Bible (continuity.json), applied at render to every scene.
 * When the planner isn't given an explicit per-plan style, fall back to that
 * Style Bible so the plan and the render share ONE look — no second field to
 * drift. Returns the explicit value (trimmed) untouched when present.
 */
async function resolveEffectiveStyle(
  explicit: string | undefined,
  episodeDir: string,
  onFallback?: () => void,
): Promise<string | undefined> {
  if (explicit && explicit.trim()) return explicit.trim()
  try {
    const continuityPath = path.join(episodeDir, 'continuity.json')
    if (existsSync(continuityPath)) {
      const cc = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      if (typeof cc?.style_bible === 'string' && cc.style_bible.trim()) {
        onFallback?.()
        return cc.style_bible.trim()
      }
    }
  } catch { /* no continuity style — plan without one */ }
  return explicit
}

interface ScenePlanRunParams {
  episode_id: string
  title?: string
  model: string
  target_scene_count?: number
  /** Whether to include research.json as context (default: true when
   *  the sidecar exists). The frontend exposes this as a checkbox. */
  use_research?: boolean
  /** v1.0.242 — visual-prompt detail level (1–4); see DETAIL_SPECS in the
   *  scene-planner service. */
  detail_level?: number
  /** v1.0.468 — image-to-video motion intensity (1–4); see MOTION_SPECS.
   *  Falls back to the project default (config.default_motion_level), then 2. */
  motion_level?: number
  /** v1.0.468 — generate a per-scene motion_prompt alongside each visual_prompt
   *  (for animating the image into a clip later). Default: project setting
   *  config.motion_prompts_enabled, else true. */
  generate_motion_prompts?: boolean
  /** v1.0.468 — REGENERATE just this scene's motion_prompt (keeps visual_prompt
   *  and everything else). Mutually exclusive with the other regenerate flags. */
  regenerate_motion_prompt_scene_id?: string
  /** v1.0.468 — BULK regenerate every EMPTY motion_prompt (scenes that already
   *  have a visual_prompt). Fans out across the Chat Studio pool. */
  regenerate_empty_motion_prompts?: boolean
  /** v1.0.242 — global visual-style guidance woven into every visual_prompt. */
  style_prompt?: string
  /** v1.0.242 — extra free-text planner instructions for all scenes. */
  custom_instructions?: string
  /** v1.0.245 — when set, RE-PLAN just this scene's time range (fixing an
   *  over-long / auto-filled segment): the planner runs on that scene's
   *  [start, end] only and the result is spliced back in place of it. Every
   *  other scene — and its rendered image — is left untouched. */
  replan_scene_id?: string
  /** v1.0.285 — per-window scene count: 'auto' picks based on model (local
   *  → small, cloud → full); 'full' = 30/window; 'small' = 10/window.
   *  Passed straight to the planner — see ScenePlanRunOptions.window_size. */
  window_size?: 'auto' | 'full' | 'small'
  /** v1.0.508 — cross-window "story so far" continuity. true (default) plans
   *  windows sequentially with a rolling recap; false plans them in PARALLEL
   *  (faster, weaker cross-seam continuity). See ScenePlanRunOptions. */
  cross_window_context?: boolean
  /** v1.0.288 — when set, REGENERATE just this scene's visual_prompt
   *  without touching its time range, transcript_segment, or any other
   *  scene. Much cheaper than replan_scene_id (simple prose LLM call, no
   *  structured JSON output) — works reliably on smaller local models
   *  that fail full-planner JSON. Mutually exclusive with replan_scene_id. */
  regenerate_prompt_scene_id?: string
  /** v1.0.458 — BULK regenerate EVERY empty visual_prompt in one job that
   *  fans out across the LM Studio pool (concurrency = pool size) and
   *  retries transient connection failures. Replaces the old frontend loop
   *  that fired one regenerate-prompt job per scene through a single
   *  endpoint. Time ranges + transcripts are untouched. Mutually exclusive
   *  with regenerate_prompt_scene_id / replan_scene_id. */
  regenerate_empty_prompts?: boolean
  /** v1.0.291 — planning strategy. 'single-pass' (default) uses the
   *  historical windowed LLM planner; 'two-pass' splits cues deterministic-
   *  ally then generates prompts per-scene as plain prose. The two-pass
   *  path is recommended for small local models that fail JSON output. */
  planning_mode?: 'single-pass' | 'two-pass'
  /** v1.0.291 — neighbor-context window for two-pass prompt generation.
   *  See ScenePlanRunOptions.neighbor_context_{back,forward}. */
  neighbor_context_back?: number
  neighbor_context_forward?: number
  /** v1.0.423 — skip the leading "Introduction" chapter (sleep-story welcome /
   *  CTA / breathing) so scenes are planned only for the story. Per-episode
   *  override; falls back to the project default (config.skip_intro_scenes). */
  skip_intro?: boolean
}

export const SCENE_PLAN_FILENAME = 'scene_plan.json'

export async function runScenePlanJob(job: Job): Promise<void> {
  const params = job.params as ScenePlanRunParams
  const { episode_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)

  // Resolve inputs.
  const stitchedSrt = path.join(paths.subtitles_dir, `${episode_id.toUpperCase()}_stitched.srt`)
  const researchPath = (await resolveResearchPaths(paths.episode_dir, episode_id)).jsonPath
  const useResearch = params.use_research !== false  // default true

  // continuity-chain (v1.0.193): density pacing. The user sets the per-episode
  // band on the Character Sheet page (continuity.json); fall back to a 2–8s
  // "live" default when the format is continuity-chain but no config exists yet.
  let pacing: { min_sec: number; max_sec: number; mode: 'live' } | undefined
  try {
    const fmt = await getEffectiveFormat(job.project_slug)
    if (fmt?.visualSource === 'continuity-chain') {
      pacing = { min_sec: 2, max_sec: 8, mode: 'live' }
      const continuityPath = path.join(paths.episode_dir, 'continuity.json')
      if (existsSync(continuityPath)) {
        try {
          const cfg = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
          const mn = Number(cfg?.pacing?.min_sec)
          const mx = Number(cfg?.pacing?.max_sec)
          if (Number.isFinite(mn) && Number.isFinite(mx) && mx >= mn) {
            pacing = { min_sec: mn, max_sec: mx, mode: 'live' }
          }
        } catch { /* keep the default pacing */ }
      }
    }
  } catch { /* non-continuity project or format load failed — no pacing */ }

  // v1.0.337 — per-project guide cast density (config.json `character_density`).
  // Only meaningful for continuity (pacing set). Unset → undefined: single-pass
  // uses the 40% default; two-pass stays untagged (renderer treats as character)
  // — i.e. exactly the pre-config behaviour. Set → both modes honour it.
  let characterDensity: number | undefined
  if (pacing) {
    try {
      const cfg = await getConfig(job.project_slug)
      const raw = (cfg as any)?.character_density
      if (raw != null && Number.isFinite(Number(raw))) {
        characterDensity = Math.max(0, Math.min(100, Math.round(Number(raw))))
      }
    } catch { /* default density applies */ }
  }

  job.output_lines.push(`Model: ${model}`)
  job.output_lines.push(`Stitched SRT: ${stitchedSrt}`)
  if (useResearch) job.output_lines.push(`Research context: ${researchPath}`)
  job.output_lines.push(`Narration docx: ${paths.narration_docx}`)
  if (pacing) job.output_lines.push(`Continuity pacing: ${pacing.min_sec}–${pacing.max_sec}s (live, denser on busy passages)`)
  const DETAIL_LABELS: Record<number, string> = { 1: 'Concise', 2: 'Standard', 3: 'Detailed', 4: 'Cinematic' }
  job.output_lines.push(`Visual detail: ${DETAIL_LABELS[params.detail_level ?? 2] ?? 'Standard'} (level ${params.detail_level ?? 2})`)
  // v1.0.285 — surface the chosen window size + the resolved count so the
  // user can see whether 'auto' picked Full or Small for their model.
  const wsMode = params.window_size || 'auto'
  const wsIsLocal = model.startsWith('chatstudio:')
  const wsCount = wsMode === 'small' ? 10 : wsMode === 'full' ? 30 : (wsIsLocal ? 10 : 30)
  job.output_lines.push(
    `Window size: ${wsMode}${wsMode === 'auto' ? ` → ${wsCount} scenes/call (${wsIsLocal ? 'local model' : 'cloud model'})` : ` (${wsCount} scenes/call)`}`,
  )
  if (params.style_prompt) job.output_lines.push(`Style: ${params.style_prompt.slice(0, 120)}${params.style_prompt.length > 120 ? '…' : ''}`)
  if (params.custom_instructions) job.output_lines.push(`Custom instructions: ${params.custom_instructions.slice(0, 120)}${params.custom_instructions.length > 120 ? '…' : ''}`)
  job.progress = 10

  // v1.0.467 — scene_plan.json lives in the "03 Scene Prompts" folder now
  // (with a legacy episode-root fallback for older episodes). One resolved
  // path drives every read + in-place rewrite below, so they all stay in sync.
  const outPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)

  // ── v1.0.288 — REGENERATE just the visual_prompt for one scene ──────────
  // Keeps time range + transcript_segment + every other scene EXACTLY as-is.
  // Only `scene.visual_prompt` changes. Much smaller LLM call than re-plan
  // (single prose paragraph, no JSON structure), so it works reliably on
  // smaller local models that fail the full planner's structured output.
  // The salvage path for the original v1.0.286 bulk re-plan: when a local
  // model can't produce JSON but CAN produce prose, this regenerates the
  // empty prompts in place.
  if (params.regenerate_prompt_scene_id) {
    if (!existsSync(outPath)) throw new Error('No scene_plan.json to regenerate prompts for — run the full planner first.')
    const existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
    const targetIdx = existing.scenes.findIndex(s => s.id === params.regenerate_prompt_scene_id)
    if (targetIdx < 0) throw new Error(`Scene ${params.regenerate_prompt_scene_id} not found in scene_plan.json`)
    const target = existing.scenes[targetIdx]!
    if (!target.transcript_segment || !target.transcript_segment.trim()) {
      throw new Error(`Scene #${target.scene_index} has no transcript_segment to base a prompt on. Edit it first or use Re-plan.`)
    }
    job.output_lines.push(
      `Regenerating visual prompt for scene #${target.scene_index} `
      + `(${target.start_sec.toFixed(1)}–${target.end_sec.toFixed(1)}s, ${(target.end_sec - target.start_sec).toFixed(1)}s) — `
      + `time range and transcript unchanged, only the prompt is rewritten.`,
    )
    const [anthropic_api_key, openai_api_key, kie_api_key] = await Promise.all([
      getApiKey('anthropic').catch(() => ''),
      getApiKey('openai').catch(() => ''),
      getApiKey('kie').catch(() => ''),
    ])
    // v1.0.343 — keep the rewrite ON-STYLE. The Scene Review reprompt doesn't
    // pass a style_prompt, so the LLM used to invent its own art direction and
    // drift from the channel look. Fall back to the episode's continuity Style
    // Bible (the same text the renderer appends to every prompt) so the rewritten
    // prompt matches the rendered style instead of fighting it. v1.0.364 — this
    // fallback is now the shared `resolveEffectiveStyle` used by every plan path.
    const stylePromptForRewrite = await resolveEffectiveStyle(
      params.style_prompt, paths.episode_dir,
      () => job.output_lines.push('Using the episode Style Bible to keep the rewrite on-style.'),
    )
    const newPrompt = await generateVisualPromptOnly({
      transcript_segment: target.transcript_segment,
      model,
      detail_level: params.detail_level,
      style_prompt: stylePromptForRewrite,
      custom_instructions: params.custom_instructions,
      apiKeys: { anthropic_api_key, openai_api_key, kie_api_key },
      slug: job.project_slug,
    })
    if (!newPrompt || !newPrompt.trim()) {
      throw new Error('Model returned an empty prompt. Try a stronger model or fill the prompt in manually.')
    }
    // v1.0.260 — if Visual Recipe has composed a prompt into `visual_prompt`,
    // the raw planner output lives in `visual_prompt_raw`. Updating only
    // `visual_prompt` here is the right move (the user is asking for a new
    // prompt right now), but we also clear `visual_prompt_raw` so future
    // recipe compositions see a fresh starting point — otherwise the recipe
    // would re-compose from the old raw and overwrite the user's new prompt.
    target.visual_prompt = newPrompt
    if (target.visual_prompt_raw) {
      target.visual_prompt_raw = newPrompt
    }
    existing.generated_at = new Date().toISOString()
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(existing, null, 2), 'utf-8')
    job.output_dir = paths.episode_dir
    job.progress = 100
    job.output_lines.push(`✓ Prompt regenerated (${newPrompt.length} chars). Other scenes untouched.`)
    return
  }

  // ── v1.0.458 — BULK regenerate every empty visual_prompt in ONE job ─────
  // Same per-scene prose call as the single regenerate above, but it finds
  // EVERY empty-prompt scene (with a non-empty transcript) and generates them
  // in one job that fans out across the LM Studio pool — replacing the old
  // frontend loop that fired one job per scene serially through a single
  // endpoint. Transient connection failures are retried, so a brief local-
  // model hiccup no longer leaves prompts permanently blank.
  if (params.regenerate_empty_prompts) {
    if (!existsSync(outPath)) throw new Error('No scene_plan.json to regenerate prompts for — run the full planner first.')
    const existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
    const targetIndices: number[] = []
    existing.scenes.forEach((s, i) => {
      const noPrompt = !s.visual_prompt || !s.visual_prompt.trim()
      const hasTranscript = !!(s.transcript_segment && s.transcript_segment.trim())
      if (noPrompt && hasTranscript) targetIndices.push(i)
    })
    if (!targetIndices.length) {
      job.progress = 100
      job.output_lines.push('No empty prompts to regenerate — every scene with a transcript already has a prompt.')
      job.output_dir = paths.episode_dir
      return
    }
    job.output_lines.push(
      `Bulk-regenerating ${targetIndices.length} empty visual prompt(s) of ${existing.scenes.length} scene(s) — `
      + `time ranges + transcripts unchanged, prompts that already exist serve as continuity context.`,
    )
    const [anthropic_api_key, openai_api_key, kie_api_key] = await Promise.all([
      getApiKey('anthropic').catch(() => ''),
      getApiKey('openai').catch(() => ''),
      getApiKey('kie').catch(() => ''),
    ])
    // Keep the rewrites ON-STYLE — same Style Bible fallback the single
    // regenerate and the full plan use (v1.0.364).
    const stylePromptForRewrite = await resolveEffectiveStyle(
      params.style_prompt, paths.episode_dir,
      () => job.output_lines.push('Using the episode Style Bible to keep the rewrites on-style.'),
    )
    const failed = await generatePromptsForScenes(existing.scenes, targetIndices, {
      model,
      detail_level: params.detail_level,
      style_prompt: stylePromptForRewrite,
      custom_instructions: params.custom_instructions,
      neighbor_context_back: params.neighbor_context_back,
      neighbor_context_forward: params.neighbor_context_forward,
      apiKeys: { anthropic_api_key, openai_api_key, kie_api_key },
      slug: job.project_slug,
      should_cancel: () => isCancelled(job.job_id),
      onWarn: (m) => job.output_lines.push(m),
      onProgress: (done, total) => {
        // Map into the 10–95 band the job reserves for the work.
        job.progress = 10 + Math.round((done / Math.max(1, total)) * 85)
      },
    })
    existing.generated_at = new Date().toISOString()
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(existing, null, 2), 'utf-8')
    job.output_dir = paths.episode_dir
    job.progress = 100
    const succeeded = targetIndices.length - failed
    job.output_lines.push(
      `✓ Bulk regen complete — ${succeeded} prompt(s) filled`
      + (failed ? `, ${failed} still empty (re-run the button to retry, or fill them in manually).` : '.'),
    )
    return
  }

  // ── v1.0.468 — REGENERATE just one scene's motion_prompt ────────────────
  // Keeps visual_prompt + everything else; rewrites only the motion instruction.
  if (params.regenerate_motion_prompt_scene_id) {
    if (!existsSync(outPath)) throw new Error('No scene_plan.json to regenerate a motion prompt for — run the full planner first.')
    const existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
    const targetIdx = existing.scenes.findIndex(s => s.id === params.regenerate_motion_prompt_scene_id)
    if (targetIdx < 0) throw new Error(`Scene ${params.regenerate_motion_prompt_scene_id} not found in scene_plan.json`)
    const target = existing.scenes[targetIdx]!
    if (!target.visual_prompt || !target.visual_prompt.trim()) {
      throw new Error(`Scene #${target.scene_index} has no visual_prompt to animate — write the image prompt first.`)
    }
    let projDefaultMotion: number | undefined
    try { projDefaultMotion = (await getConfig(job.project_slug) as any)?.default_motion_level } catch { /* default applies */ }
    const motionLevel = resolveMotionLevel(params.motion_level, projDefaultMotion)
    job.output_lines.push(`Regenerating motion prompt for scene #${target.scene_index} (intensity level ${motionLevel}) — visual prompt + timing unchanged.`)
    const [a, o, k] = await Promise.all([
      getApiKey('anthropic').catch(() => ''),
      getApiKey('openai').catch(() => ''),
      getApiKey('kie').catch(() => ''),
    ])
    const motionStyle = await resolveEffectiveStyle(params.style_prompt, paths.episode_dir)
    const newMotion = await generateMotionPromptOnly({
      transcript_segment: target.transcript_segment,
      visual_prompt: target.visual_prompt,
      model,
      motion_level: motionLevel,
      style_prompt: motionStyle,
      custom_instructions: params.custom_instructions,
      apiKeys: { anthropic_api_key: a, openai_api_key: o, kie_api_key: k },
      slug: job.project_slug,
    })
    if (!newMotion || !newMotion.trim()) {
      throw new Error('Model returned an empty motion prompt. Try a stronger model or fill it in manually.')
    }
    target.motion_prompt = newMotion
    existing.generated_at = new Date().toISOString()
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(existing, null, 2), 'utf-8')
    job.output_dir = paths.episode_dir
    job.progress = 100
    job.output_lines.push(`✓ Motion prompt regenerated (${newMotion.length} chars). Other scenes untouched.`)
    return
  }

  // ── v1.0.468 — BULK regenerate every EMPTY motion_prompt ────────────────
  if (params.regenerate_empty_motion_prompts) {
    if (!existsSync(outPath)) throw new Error('No scene_plan.json to regenerate motion prompts for — run the full planner first.')
    const existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
    const targetIndices: number[] = []
    existing.scenes.forEach((s, i) => {
      const hasVisual = !!(s.visual_prompt && s.visual_prompt.trim())
      const noMotion = !s.motion_prompt || !s.motion_prompt.trim()
      if (hasVisual && noMotion) targetIndices.push(i)
    })
    if (!targetIndices.length) {
      job.progress = 100
      job.output_lines.push('No empty motion prompts to regenerate — every scene with a visual prompt already has one.')
      job.output_dir = paths.episode_dir
      return
    }
    let projDefaultMotion: number | undefined
    try { projDefaultMotion = (await getConfig(job.project_slug) as any)?.default_motion_level } catch { /* default applies */ }
    const motionLevel = resolveMotionLevel(params.motion_level, projDefaultMotion)
    job.output_lines.push(`Bulk-regenerating ${targetIndices.length} empty motion prompt(s) — intensity level ${motionLevel}; visual prompts + timing unchanged.`)
    const [a, o, k] = await Promise.all([
      getApiKey('anthropic').catch(() => ''),
      getApiKey('openai').catch(() => ''),
      getApiKey('kie').catch(() => ''),
    ])
    const motionStyle = await resolveEffectiveStyle(params.style_prompt, paths.episode_dir)
    const failed = await generateMotionPromptsForScenes(existing.scenes, targetIndices, {
      model,
      motion_level: motionLevel,
      style_prompt: motionStyle,
      custom_instructions: params.custom_instructions,
      apiKeys: { anthropic_api_key: a, openai_api_key: o, kie_api_key: k },
      slug: job.project_slug,
      should_cancel: () => isCancelled(job.job_id),
      onWarn: (m) => job.output_lines.push(m),
      onProgress: (done, total) => { job.progress = 10 + Math.round((done / Math.max(1, total)) * 85) },
    })
    existing.generated_at = new Date().toISOString()
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(existing, null, 2), 'utf-8')
    job.output_dir = paths.episode_dir
    job.progress = 100
    const succeeded = targetIndices.length - failed
    job.output_lines.push(
      `✓ Bulk motion regen complete — ${succeeded} prompt(s) filled`
      + (failed ? `, ${failed} still empty (re-run to retry, or fill them in manually).` : '.'),
    )
    return
  }

  // ── v1.0.245 — targeted RE-PLAN of one scene's range ────────────────────
  // Fixes an over-long / auto-filled blob without touching the rest of the
  // plan (or any already-rendered images). Plans only that scene's [start,end]
  // and splices the result in place of it.
  if (params.replan_scene_id) {
    if (!existsSync(outPath)) throw new Error('No scene_plan.json to re-plan — run the full planner first.')
    const existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
    const targetIdx = existing.scenes.findIndex(s => s.id === params.replan_scene_id)
    if (targetIdx < 0) throw new Error(`Scene ${params.replan_scene_id} not found in scene_plan.json`)
    const target = existing.scenes[targetIdx]!
    job.output_lines.push(
      `Re-planning scene #${target.scene_index} (${target.start_sec.toFixed(1)}–${target.end_sec.toFixed(1)}s, ` +
      `${(target.end_sec - target.start_sec).toFixed(1)}s) — other scenes + their images are untouched.`,
    )
    const replanStyle = await resolveEffectiveStyle(
      params.style_prompt, paths.episode_dir,
      () => job.output_lines.push('No style prompt set — using the episode Style Bible for the re-plan.'),
    )
    const replanned = await planScenes({
      stitched_srt_path: stitchedSrt,
      research_path: useResearch ? researchPath : undefined,
      narration_docx_path: resolveReadPath(paths.narration_docx),
      model,
      detail_level: params.detail_level,
      style_prompt: replanStyle,
      custom_instructions: params.custom_instructions,
      pacing,
      range: { start_sec: target.start_sec, end_sec: target.end_sec },
      // v1.0.285 — re-plan honours the user's chosen window size too. For a
      // single-scene range this rarely produces more than one window, but
      // passing it keeps behaviour consistent with the full-plan path.
      window_size: params.window_size,
      onWarn: (m) => job.output_lines.push(m),
    })
    const newScenes = replanned.scenes
    if (!newScenes.length) throw new Error('Re-plan produced no scenes for that range.')
    // Splice in place of the target; renumber; everything else (incl image_path) is preserved.
    existing.scenes.splice(targetIdx, 1, ...newScenes)
    existing.scenes.forEach((s, i) => { s.scene_index = i + 1 })
    existing.generated_at = new Date().toISOString()
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(existing, null, 2), 'utf-8')
    job.output_dir = paths.episode_dir
    job.progress = 100
    job.output_lines.push(`Replaced 1 scene with ${newScenes.length} — total now ${existing.scenes.length} scene(s). Done.`)
    return
  }

  // v1.0.291 — branch on planning mode. 'two-pass' uses deterministic
  // split + per-scene prompts (works on small local models); 'single-pass'
  // (default) keeps the historical windowed LLM behaviour.
  const planningMode = params.planning_mode === 'two-pass' ? 'two-pass' : 'single-pass'
  const planner = planningMode === 'two-pass' ? planScenesTwoPass : planScenes
  if (planningMode === 'two-pass') {
    const back = params.neighbor_context_back ?? 2
    const forward = params.neighbor_context_forward ?? 1
    job.output_lines.push(
      `Planning mode: two-pass (deterministic split + per-scene prompts, neighbor context ${back} back / ${forward} forward)`,
    )
  } else {
    job.output_lines.push('Planning mode: single-pass (windowed LLM)')
  }

  const effectiveStyle = await resolveEffectiveStyle(
    params.style_prompt, paths.episode_dir,
    () => job.output_lines.push('No style prompt set — using the episode Style Bible for the plan.'),
  )

  // v1.0.423 — sleep-story intro skip. When on (per-episode override, else the
  // project default), drop the leading "Introduction" chapter so scenes are
  // planned only for the story. story_start is computed the SAME way the video
  // render holds the title card, so the two stay in lockstep.
  let skipUntilSec = 0
  let wantSkipIntro = params.skip_intro
  if (wantSkipIntro == null) {
    try { wantSkipIntro = !!(await getConfig(job.project_slug) as any)?.skip_intro_scenes } catch { wantSkipIntro = false }
  }
  if (wantSkipIntro) {
    try {
      const chaptersPath = path.join(paths.episode_dir, 'audio_chapters.json')
      if (existsSync(chaptersPath)) {
        const sc = JSON.parse(await fs.readFile(chaptersPath, 'utf-8'))
        const gap = typeof sc.gap_duration_s === 'number' ? sc.gap_duration_s : 0
        const assets = await scanEpisodeAssets(job.project_slug, episode_id).catch(() => null)
        const merged = assets?.merged_audio?.[0]?.path || null
        const story = await computeStoryStartSec(merged, sc.sections || [], gap)
        if (story) {
          skipUntilSec = story.story_start_sec
          job.output_lines.push(`Intro skip: ON — planning from ${skipUntilSec.toFixed(1)}s (after the "${story.intro_label}" chapter). Earlier cues are excluded.`)
        } else {
          job.output_lines.push('Intro skip: ON but no "Introduction" chapter found in audio_chapters.json — planning the full transcript.')
        }
      } else {
        job.output_lines.push('Intro skip: ON but audio_chapters.json is missing — run Audio Assembly first; planning the full transcript.')
      }
    } catch (e: any) {
      job.output_lines.push(`Intro skip: could not compute story start (${e?.message || e}) — planning the full transcript.`)
    }
  }

  const plan: ScenePlan = await planner({
    stitched_srt_path: stitchedSrt,
    skip_until_sec: skipUntilSec,
    research_path: useResearch ? researchPath : undefined,
    narration_docx_path: resolveReadPath(paths.narration_docx),
    model,
    target_scene_count: params.target_scene_count,
    detail_level: params.detail_level,
    style_prompt: effectiveStyle,
    custom_instructions: params.custom_instructions,
    pacing,
    character_density: characterDensity,
    // v1.0.285 — per-window scene count tuning (auto = local→small,
    // cloud→full). See ScenePlanRunOptions.window_size for the rationale.
    // Ignored by planScenesTwoPass.
    window_size: params.window_size,
    // v1.0.508 — story-so-far continuity toggle (default true = sequential).
    cross_window_context: params.cross_window_context,
    // v1.0.291 — two-pass-specific; ignored by planScenes (single-pass).
    neighbor_context_back: params.neighbor_context_back,
    neighbor_context_forward: params.neighbor_context_forward,
    onWarn: (m) => job.output_lines.push(m),
    // v1.0.226 — chunked planner: it plans the episode in time-windows so the
    // model's output never truncates regardless of length. Surface progress.
    onProgress: (done, totalWindows, scenesSoFar) => {
      job.output_lines.push(`Planned segment ${done}/${totalWindows} — ${scenesSoFar} image scene(s) so far…`)
      // Map window progress into the 10–80 band the job reserves for planning.
      job.progress = 10 + Math.round((done / Math.max(1, totalWindows)) * 70)
    },
  })

  // v1.0.337 — apply the configured guide density to any scenes the planner
  // left untagged (two-pass / salvage). Single-pass scenes keep the LLM's
  // classification. Skipped entirely when density is unset (back-compat).
  if (characterDensity != null) {
    const before = plan.scenes.filter(s => !s.scene_type).length
    assignDensityToUntagged(plan.scenes, characterDensity)
    const charCount = plan.scenes.filter(s => s.scene_type === 'character').length
    job.output_lines.push(
      `Guide cast: ${characterDensity}% target → ${charCount}/${plan.scenes.length} character scene(s)` +
      (before ? ` (${before} untagged scene(s) distributed)` : '') +
      (characterDensity === 0 ? ' — no guide character' : characterDensity >= 100 ? ' — guide in every scene' : ''),
    )
  }

  job.progress = 80
  if ((plan.planned_in_windows ?? 1) > 1) {
    job.output_lines.push(`Planned in ${plan.planned_in_windows} segments (long episode — chunked so the model never truncates).`)
  }
  job.output_lines.push(`Planner returned ${plan.scenes.length} scene(s). Writing ${SCENE_PLAN_FILENAME}…`)

  // v1.0.225 — coverage check. If the salvaged/returned plan stops well short
  // of the audio's end, the model's output was truncated mid-episode; warn
  // loudly so the user knows the tail isn't planned (vs silently looking done).
  const lastEnd = plan.scenes.length ? plan.scenes[plan.scenes.length - 1]!.end_sec : 0
  const total = plan.total_duration_sec || 0
  if (total > 0 && lastEnd < total * 0.97) {
    const pct = Math.round((lastEnd / total) * 100)
    job.output_lines.push(
      `⚠ Plan covers only ~${pct}% of the audio (${lastEnd.toFixed(0)}s of ${total.toFixed(0)}s). ` +
      `The model's output was likely truncated — the planned scenes are valid, but the rest of the ` +
      `episode isn't covered. Re-run with a larger-output model, or widen the pacing band to reduce scene count.`,
    )
  }

  // Persist the plan with visual prompts BEFORE the motion pass. Motion
  // generation is a second, potentially long LLM phase — if it crashes, is
  // cancelled, or the app restarts, the (expensive) image scenes are already on
  // disk instead of being lost with it. Same partial-progress protection the
  // visual planner's chunking gives.
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, JSON.stringify(plan, null, 2), 'utf-8')

  // ── v1.0.468 — motion-prompt pass ───────────────────────────────────────
  // Generate a per-scene image-to-video motion_prompt, seeded with each scene's
  // just-written visual_prompt so the two are cohesive. Runs for BOTH planning
  // modes (the planner has already produced visual_prompts by here). Opt-out via
  // params.generate_motion_prompts === false or the project's motion_prompts_enabled.
  let wantMotion = params.generate_motion_prompts
  if (wantMotion == null) {
    try { wantMotion = (await getConfig(job.project_slug) as any)?.motion_prompts_enabled !== false } catch { wantMotion = true }
  }
  if (wantMotion) {
    let projDefaultMotion: number | undefined
    let promptModel = ''
    try {
      const cfg = await getConfig(job.project_slug) as any
      projDefaultMotion = cfg?.default_motion_level
      // v1.0.509 — use the fast "prompt model" for motion prompts when set;
      // else fall back to the planner model. Short, simple outputs → a fast
      // model here cuts the (sequential-on-cloud) motion phase substantially.
      if (typeof cfg?.prompt_model === 'string' && cfg.prompt_model.trim()) promptModel = cfg.prompt_model.trim()
    } catch { /* defaults apply */ }
    const motionModel = promptModel || model
    const motionLevel = resolveMotionLevel(params.motion_level, projDefaultMotion)
    const targets = plan.scenes.map((s, i) => (s.visual_prompt?.trim() ? i : -1)).filter(i => i >= 0)
    if (targets.length) {
      const [a, o, k] = await Promise.all([
        getApiKey('anthropic').catch(() => ''),
        getApiKey('openai').catch(() => ''),
        getApiKey('kie').catch(() => ''),
      ])
      const MOTION_LABELS: Record<number, string> = { 1: 'Still', 2: 'Gentle', 3: 'Moderate', 4: 'Lively' }
      job.output_lines.push(
        `Generating motion prompts for ${targets.length} scene(s) — intensity ${MOTION_LABELS[motionLevel] ?? motionLevel} (level ${motionLevel})` +
        (promptModel ? ` · fast prompt model: ${motionModel}` : '') + '…',
      )
      // Throttled incremental save so finished motion prompts survive a
      // mid-phase crash / cancel (mirrors the visual planner's protection).
      let saveInFlight = false
      let lastSavedAt = 0
      const persist = async (done: number, total: number) => {
        if (saveInFlight) return
        if (done - lastSavedAt < 10 && done < total) return // save every 10, and at the end
        saveInFlight = true
        lastSavedAt = done
        try { await fs.writeFile(outPath, JSON.stringify(plan, null, 2), 'utf-8') } catch { /* best-effort */ }
        finally { saveInFlight = false }
      }
      const failed = await generateMotionPromptsForScenes(plan.scenes, targets, {
        model: motionModel,
        motion_level: motionLevel,
        style_prompt: effectiveStyle,
        custom_instructions: params.custom_instructions,
        apiKeys: { anthropic_api_key: a, openai_api_key: o, kie_api_key: k },
        slug: job.project_slug,
        should_cancel: () => isCancelled(job.job_id),
        onWarn: (m) => job.output_lines.push(m),
        onProgress: (done, total) => {
          if (done % 10 === 0 || done === total) job.output_lines.push(`${done}/${total} motion prompt(s) so far…`)
          job.progress = 80 + Math.round((done / Math.max(1, total)) * 18) // 80→98 band
          void persist(done, total)
        },
      })
      const made = targets.length - failed
      job.output_lines.push(
        failed
          ? `✓ Motion prompts: ${made}/${targets.length} written (${failed} left empty — use "Regen empty motion prompts").`
          : `✓ Motion prompts: ${made}/${targets.length} written.`,
      )
    }
  }

  // Final save — captures the last batch of motion prompts.
  await fs.writeFile(outPath, JSON.stringify(plan, null, 2), 'utf-8')

  job.output_dir = paths.episode_dir
  job.progress = 100
  job.output_lines.push('Done.')
}
