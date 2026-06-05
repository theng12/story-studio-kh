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
import { planScenes } from '../services/scene-planner.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import type { Job, ScenePlan } from '../models/types.js'

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
  const wsIsLocal = model.startsWith('lmstudio:')
  const wsCount = wsMode === 'small' ? 10 : wsMode === 'full' ? 30 : (wsIsLocal ? 10 : 30)
  job.output_lines.push(
    `Window size: ${wsMode}${wsMode === 'auto' ? ` → ${wsCount} scenes/call (${wsIsLocal ? 'local model' : 'cloud model'})` : ` (${wsCount} scenes/call)`}`,
  )
  if (params.style_prompt) job.output_lines.push(`Style: ${params.style_prompt.slice(0, 120)}${params.style_prompt.length > 120 ? '…' : ''}`)
  if (params.custom_instructions) job.output_lines.push(`Custom instructions: ${params.custom_instructions.slice(0, 120)}${params.custom_instructions.length > 120 ? '…' : ''}`)
  job.progress = 10

  const outPath = path.join(paths.episode_dir, SCENE_PLAN_FILENAME)

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
    const replanned = await planScenes({
      stitched_srt_path: stitchedSrt,
      research_path: useResearch ? researchPath : undefined,
      narration_docx_path: resolveReadPath(paths.narration_docx),
      model,
      detail_level: params.detail_level,
      style_prompt: params.style_prompt,
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
    await fs.mkdir(paths.episode_dir, { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(existing, null, 2), 'utf-8')
    job.output_dir = paths.episode_dir
    job.progress = 100
    job.output_lines.push(`Replaced 1 scene with ${newScenes.length} — total now ${existing.scenes.length} scene(s). Done.`)
    return
  }

  const plan: ScenePlan = await planScenes({
    stitched_srt_path: stitchedSrt,
    research_path: useResearch ? researchPath : undefined,
    narration_docx_path: resolveReadPath(paths.narration_docx),
    model,
    target_scene_count: params.target_scene_count,
    detail_level: params.detail_level,
    style_prompt: params.style_prompt,
    custom_instructions: params.custom_instructions,
    pacing,
    // v1.0.285 — per-window scene count tuning (auto = local→small,
    // cloud→full). See ScenePlanRunOptions.window_size for the rationale.
    window_size: params.window_size,
    onWarn: (m) => job.output_lines.push(m),
    // v1.0.226 — chunked planner: it plans the episode in time-windows so the
    // model's output never truncates regardless of length. Surface progress.
    onProgress: (done, totalWindows, scenesSoFar) => {
      job.output_lines.push(`Planned segment ${done}/${totalWindows} — ${scenesSoFar} scene(s) so far…`)
      // Map window progress into the 10–80 band the job reserves for planning.
      job.progress = 10 + Math.round((done / Math.max(1, totalWindows)) * 70)
    },
  })

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

  await fs.mkdir(paths.episode_dir, { recursive: true })
  await fs.writeFile(outPath, JSON.stringify(plan, null, 2), 'utf-8')

  job.output_dir = paths.episode_dir
  job.progress = 100
  job.output_lines.push('Done.')
}
