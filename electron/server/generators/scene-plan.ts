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
import { planScenes, planScenesTwoPass, generateVisualPromptOnly, generatePromptsForScenes, generateMotionPromptOnly, generateMotionPromptsForScenes, MOTION_SPECS, resolveMotionLevel, assignDensityToUntagged, repairPlanCoverage, removeNonRenderableScenes } from '../services/scene-planner.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { isCancelled } from '../services/job-queue.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { getConfig } from '../services/project-manager.js'
import { computeStoryStartSec } from '../lib/intro-lead-in.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { callAi, sanitizeJsonControlChars } from '../lib/ai-client.js'
import type { TextGenerationDiagnostics } from '../providers/types.js'
import { scenePromptPackOutputContract } from '../lib/story-output-contracts.js'
import { listChatModels as listGenStudioChatModels, type GenStudioChatModel } from '../lib/genstudio-client.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import {
  parseScenePromptPackSetting,
  parseScenePromptTokenSetting,
  resolveScenePromptPackSize,
  resolveScenePromptTokenBudget,
  type ScenePromptPackSetting,
  type ScenePromptTokenSetting,
} from '../services/scene-prompt-batching.js'
import {
  buildPromptCharCapInstruction,
  describeOverCapPrompts,
  parsePromptCharCap,
  readPromptLength,
} from '../services/prompt-char-cap.js'
import { scanEpisodeAssets } from './video.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { auditScenePromptCompletion, checkpointScenePrompt } from '../services/scene-prompt-checkpoint.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import {
  clearLegacyPlannerFallbackReasons,
  inspectScenePromptIntegrity,
} from '../services/scene-prompt-integrity.js'
import {
  assignCreativeStrategies,
  buildCreativeDirectionPrompt,
  buildStrategyGlossary,
  CREATIVE_PROFILES,
  normalizeCreativeDirection,
} from '../services/scene-creative-direction.js'
import { assignSceneMotionProfile, motionModeLevel } from '../services/scene-motion-profile.js'
import type { Job, SceneCreativeDirection, SceneCreativeStrategy, SceneMotionProfile, ScenePlan } from '../models/types.js'

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
  /** Bulk-repair every empty motion_prompt (for scenes that already have a
   * visual_prompt) through the same durable GenStudio packs as normal motion
   * generation. */
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
  /** Bulk-repair every missing or duplicated visual_prompt through the same
   * durable GenStudio packs as normal visual generation. Time ranges and
   * transcripts are untouched. */
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
  /** New staged workflow. Timeline is deterministic; prompts are separate. */
  stage?: 'timeline' | 'visual' | 'motion'
  opening_mode?: 'branded-opening' | 'from-start'
  opening_reserved_sec?: number
  /** Limit a manual run to the next N pending scenes. Omit for all pending. */
  prompt_limit?: number
  /** The selected GenStudio model's published output limit determines Auto. */
  prompt_pack_size?: ScenePromptPackSetting
  /** Advanced override. Any positive allowance is accepted and clamped to the
   *  SELECTED product's published `max_output_tokens` — never to a fixed list,
   *  which would cap a 128,000-token product at a stale 32,768. */
  prompt_max_tokens?: ScenePromptTokenSetting
  /**
   * The character CEILING every visual prompt is written under, so the prompt
   * survives the image model that will render it. It is never a length to fill:
   * a scene that needs 500 characters keeps 500 under an 8,000 ceiling.
   *
   * The number is GenStudio's published `max_prompt_characters` for the image
   * model the workspace has selected, resolved there (only the workspace knows
   * which image model that is) and sent as a plain number. Absent means the
   * selected model publishes no cap, or the user chose no target: no
   * instruction is added and nothing is warned about. Nothing is ever
   * truncated — see services/prompt-char-cap.ts.
   */
  prompt_char_cap?: number
  /** Single-pass visual interpretation controls. Strategies are assigned
   * locally across the full episode before existing prompt packs are sent. */
  creative_direction?: Partial<SceneCreativeDirection>
}

interface ScenePromptPack {
  pack_id: string
  scene_ids: string[]
  params: { temperature: number; max_tokens: number }
}

interface ScenePromptPayload {
  scene_id: string
  start_sec: number
  end_sec: number
  narration: string
  visual_prompt?: string
  motion_mode?: 'gentle' | 'limited'
  creative_strategy?: SceneCreativeStrategy
  introduction_remainder?: boolean
  previous_visual_prompts?: string[]
  upcoming_narration?: string[]
}

export type ScenePromptCompletionIssueKind = 'provider-omitted' | 'duplicate-prompt' | 'checkpoint-failed' | 'not-durable'

export interface ScenePromptCompletionIssue {
  scene_id: string
  kind: ScenePromptCompletionIssueKind
  detail: string
}

const MAX_AUTOMATIC_PROMPT_REPAIR_ATTEMPTS = 2

/** Split prompt work into bounded provider requests. Keeping this pure makes
 * request counts explicit and regression-testable (322 scenes at 50 per pack
 * is seven GenStudio requests, never 322). */
export function packScenePromptItems<T>(items: readonly T[], packSize: number): T[][] {
  const size = Math.max(1, Math.floor(packSize))
  const packs: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) {
    packs.push(items.slice(offset, offset + size))
  }
  return packs
}

// Older planner helpers still accept this shaped argument, but callAi ignores
// it and resolves only the scoped GenStudio key at the generation boundary.
const GENSTUDIO_ONLY_LEGACY_KEY_BAG = {
  anthropic_api_key: '',
  openai_api_key: '',
  kie_api_key: '',
}

/** Resolve and verify scene-planning work against GenStudio's live catalog. */
export function resolveScenePlanCatalogModel(
  selectedModel: string,
  catalog: readonly GenStudioChatModel[],
): string | null {
  const raw = selectedModel.trim().replace(/^genstudio-chat:/, '')
  if (!raw) return null
  const canonical = resolveGenStudioModelId('chat', raw)
  const match = catalog.find(model => model.available && (model.id === canonical || model.id === raw))
  return match?.id || null
}

export async function requireScenePlanGenStudioModel(selectedModel: string): Promise<string> {
  const model = await getScenePlanGenStudioModel(selectedModel)
  return model.id
}

/** Resolve model identity and live limits together so batching cannot drift
 * from the GenStudio catalog that will execute the request. */
export async function getScenePlanGenStudioModel(selectedModel: string): Promise<GenStudioChatModel> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    throw new Error('Add the scoped GenStudio API key in Settings → This Mac before generating scene prompts.')
  }
  const catalog = await listGenStudioChatModels(apiKey)
  const modelId = resolveScenePlanCatalogModel(selectedModel, catalog)
  const model = modelId ? catalog.find(candidate => candidate.id === modelId) : null
  if (!model) {
    throw new Error(
      `${unavailableLegacyModelMessage('chat', selectedModel)} `
      + 'Scene planning did not call any fallback route.',
    )
  }
  return model
}

export function parseDirectPackResults(
  raw: string,
  expectedIds: string[],
  kind: 'visual' | 'motion',
): Map<string, string> {
  const clean = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  let parsed: any
  try {
    parsed = JSON.parse(sanitizeJsonControlChars(clean))
  } catch {
    // Preserve complete rows from a response truncated after several valid
    // scene objects. Retry/manual repair then asks only for omitted IDs.
    const recovered: unknown[] = []
    for (let start = 0; start < clean.length; start++) {
      if (clean[start] !== '{') continue
      let depth = 0
      let quoted = false
      let escaped = false
      for (let i = start; i < clean.length; i++) {
        const char = clean[i]!
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
          continue
        }
        if (char === '"') { quoted = true; continue }
        if (char === '{') depth++
        else if (char === '}') depth--
        if (depth !== 0) continue
        try {
          const row = JSON.parse(sanitizeJsonControlChars(clean.slice(start, i + 1)))
          if (row?.scene_id || row?.id) recovered.push(row)
        } catch { /* this object is not a complete scene row */ }
        break
      }
    }
    if (!recovered.length) return new Map()
    parsed = recovered
  }
  const candidate = Array.isArray(parsed)
    ? parsed
    : parsed?.results ?? parsed?.prompts ?? parsed
  const allowed = new Set(expectedIds)
  const results = new Map<string, string>()
  if (Array.isArray(candidate)) {
    const keys = kind === 'motion'
      ? ['motion_prompt', 'prompt', 'text']
      : ['visual_prompt', 'prompt', 'text']
    for (const row of candidate) {
      const id = row?.scene_id ?? row?.id
      const value = keys.map(key => row?.[key]).find(value => typeof value === 'string' && value.trim())
      if (allowed.has(id) && value) results.set(id, value.trim())
    }
  } else if (candidate && typeof candidate === 'object') {
    for (const [id, value] of Object.entries(candidate)) {
      if (allowed.has(id) && typeof value === 'string' && value.trim()) results.set(id, value.trim())
    }
  }
  return results
}

/**
 * Checkpoint every usable member of a provider pack independently. One bad
 * scene row or one failed disk write must not prevent later valid rows from
 * becoming durable; the final completion audit will report only what remains.
 */
export async function checkpointPackPromptResults(
  entries: Iterable<readonly [string, string]>,
  expectedIds: ReadonlySet<string>,
  savedIds: Set<string>,
  persist: (sceneId: string, text: string) => Promise<void>,
): Promise<string[]> {
  const errors: string[] = []
  for (const [sceneId, text] of entries) {
    if (savedIds.has(sceneId)) continue
    if (!expectedIds.has(sceneId)) {
      errors.push(`unexpected scene ID ${sceneId}`)
      continue
    }
    if (!text.trim()) {
      errors.push(`${sceneId}: empty prompt`)
      continue
    }
    try {
      await persist(sceneId, text)
      savedIds.add(sceneId)
    } catch (error: any) {
      errors.push(`${sceneId}: ${error?.message || String(error)}`)
    }
  }
  return errors
}

/** Explain why a durable completion audit rejected a requested scene. This is
 * deliberately derived from the saved plan rather than trusting a provider
 * count, so the job log distinguishes a model omission from a duplicate that
 * Story Studio correctly refused to accept. */
export function diagnoseScenePromptCompletionIssues(input: {
  plan: Pick<ScenePlan, 'scenes'>
  requestedIds: readonly string[]
  missingIds: readonly string[]
  providerResults: ReadonlyMap<string, string>
  checkpointErrors?: readonly string[]
}): ScenePromptCompletionIssue[] {
  const duplicateSourceById = new Map<string, string>()
  for (const group of inspectScenePromptIntegrity(input.plan.scenes).duplicate_groups) {
    const [source, ...duplicates] = group.scene_ids
    if (!source) continue
    for (const id of duplicates) duplicateSourceById.set(id, source)
  }
  const checkpointErrorById = new Map<string, string>()
  for (const error of input.checkpointErrors || []) {
    const id = input.requestedIds.find(candidate => error.startsWith(`${candidate}:`))
    if (id) checkpointErrorById.set(id, error)
  }
  return input.missingIds.map(sceneId => {
    const duplicateSource = duplicateSourceById.get(sceneId)
    if (duplicateSource) {
      return {
        scene_id: sceneId,
        kind: 'duplicate-prompt',
        detail: `duplicate prompt matches ${duplicateSource}`,
      }
    }
    const checkpointError = checkpointErrorById.get(sceneId)
    if (checkpointError) {
      return { scene_id: sceneId, kind: 'checkpoint-failed', detail: checkpointError }
    }
    if (!input.providerResults.has(sceneId)) {
      return { scene_id: sceneId, kind: 'provider-omitted', detail: 'provider omitted the scene ID from its response' }
    }
    return { scene_id: sceneId, kind: 'not-durable', detail: 'prompt was returned but did not verify on disk' }
  })
}

export const SCENE_PLAN_FILENAME = 'scene_plan.json'

export async function runScenePlanJob(job: Job): Promise<void> {
  const params = job.params as ScenePlanRunParams
  const { episode_id } = params
  let model = params.model || ''
  if (!episode_id) throw new Error('episode_id is required')
  const packedRepairStage: 'visual' | 'motion' | undefined = params.regenerate_empty_motion_prompts
    ? 'motion'
    : params.regenerate_empty_prompts
      ? 'visual'
      : undefined
  const requestedStage = packedRepairStage || params.stage
  // Only an explicitly requested timeline-only run is model-free. A Pipeline
  // run omits `stage`, which means timeline + all required visual prompts.
  const needsModel = requestedStage !== 'timeline' || !!(
    params.regenerate_prompt_scene_id || params.regenerate_empty_prompts
    || params.regenerate_motion_prompt_scene_id || params.regenerate_empty_motion_prompts
    || params.replan_scene_id
  )
  if (!model && needsModel) throw new Error('model is required')
  if (!model) model = 'deterministic-timeline'
  const promptModel = needsModel ? await getScenePlanGenStudioModel(model) : null
  if (promptModel) model = `genstudio-chat:${promptModel.id}`

  const promptTokenSetting = parseScenePromptTokenSetting(params.prompt_max_tokens)
  const visualMaxTokens = resolveScenePromptTokenBudget(promptModel?.max_output_tokens, promptTokenSetting)
  // Motion records are intentionally short; keeping their batches within 4K
  // prevents a large visual-model allowance from creating truncated motion JSON.
  const activePromptOutputBudget = requestedStage === 'motion'
    ? Math.min(4_096, visualMaxTokens)
    : visualMaxTokens
  const promptPackSetting = parseScenePromptPackSetting(params.prompt_pack_size)
  const promptPackSize = resolveScenePromptPackSize(activePromptOutputBudget, promptPackSetting)
  // A published image-model figure or nothing. No default is invented here.
  const promptCharCap = parsePromptCharCap(params.prompt_char_cap)

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)

  // Resolve inputs.
  const stitchedSrt = path.join(paths.subtitles_dir, `${episode_id.toUpperCase()}_stitched.srt`)
  const researchPath = (await resolveResearchPaths(paths.episode_dir, episode_id)).jsonPath
  const useResearch = params.use_research !== false  // default true

  // Continuity Engine scene rhythm. An explicit Character Sheet range wins;
  // otherwise a Series Formula may supply a two-phase documentary rhythm
  // (denser opening, then long ambient visual holds). Legacy projects retain
  // the historical 1–4s fallback.
  let pacing: {
    min_sec: number
    max_sec: number
    mode: 'live' | 'documentary'
    opening_duration_sec?: number
    settled_min_sec?: number
    settled_max_sec?: number
  } | undefined
  let formulaMotionProfile: SceneMotionProfile | undefined
  try {
    const fmt = await getEffectiveFormat(job.project_slug)
    formulaMotionProfile = fmt?.script.motionProfile
    if (fmt?.visualSource === 'continuity-chain') {
      pacing = { min_sec: 1, max_sec: 4, mode: 'live' }
      const continuityPath = path.join(paths.episode_dir, 'continuity.json')
      if (existsSync(continuityPath)) {
        try {
          const cfg = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
          const mn = Number(cfg?.pacing?.min_sec)
          const mx = Number(cfg?.pacing?.max_sec)
          if (Number.isFinite(mn) && Number.isFinite(mx) && mx >= mn) {
            const openingDuration = Number(cfg?.pacing?.opening_duration_sec)
            const settledMin = Number(cfg?.pacing?.settled_min_sec)
            const settledMax = Number(cfg?.pacing?.settled_max_sec)
            const hasProfile = Number.isFinite(openingDuration) && openingDuration >= 0
              && Number.isFinite(settledMin) && Number.isFinite(settledMax)
              && settledMin >= 1 && settledMax >= settledMin
            pacing = {
              min_sec: mn,
              max_sec: mx,
              mode: hasProfile ? 'documentary' : 'live',
              ...(hasProfile ? {
                opening_duration_sec: openingDuration,
                settled_min_sec: settledMin,
                settled_max_sec: settledMax,
              } : {}),
            }
          }
        } catch { /* keep the default pacing */ }
      } else {
        const profile = fmt.script.visualPacingProfile
        if (profile) {
          pacing = {
            min_sec: profile.opening.min_sec,
            max_sec: profile.opening.max_sec,
            mode: 'documentary',
            opening_duration_sec: profile.opening_duration_sec,
            settled_min_sec: profile.settled.min_sec,
            settled_max_sec: profile.settled.max_sec,
          }
        }
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
  if (formulaMotionProfile) {
    job.output_lines.push(`Motion profile: ${formulaMotionProfile.label} — follows scene role first, then balances still / gentle / limited motion deterministically.`)
  }

  const timelineOnly = params.stage === 'timeline'
  if (timelineOnly) job.output_lines.push('Timeline engine: deterministic (no LLM)')
  else job.output_lines.push(`Prompt model: ${model}`)
  job.output_lines.push(`Stitched SRT: ${stitchedSrt}`)
  if (!timelineOnly && useResearch) job.output_lines.push(`Research context: ${researchPath}`)
  if (pacing) {
    job.output_lines.push(pacing.mode === 'documentary'
      ? `Documentary pacing: first ${Math.round((pacing.opening_duration_sec || 0) / 60)} min ${pacing.min_sec}–${pacing.max_sec}s, then ${pacing.settled_min_sec}–${pacing.settled_max_sec}s ambient holds.`
      : `Continuity pacing: ${pacing.min_sec}–${pacing.max_sec}s (live, denser on busy passages)`)
  }
  if (!timelineOnly) {
    job.output_lines.push('Visual detail: Full detail (110–150 words per scene)')
    job.output_lines.push(
      `Prompt batching: ${promptPackSize} scenes per request (up to ${activePromptOutputBudget.toLocaleString()} output tokens${promptPackSetting === 'auto' ? ', automatic' : ', override'})`,
    )
    job.output_lines.push(promptCharCap
      ? `Prompt length ceiling: ${promptCharCap.toLocaleString()} characters per visual prompt. A ceiling only — prompts stay as short as the scene needs, and an over-length prompt is reported, never shortened.`
      : 'Prompt length ceiling: none — no image-model limit is in force for this run.')
    if (params.style_prompt) job.output_lines.push(`Style: ${params.style_prompt.slice(0, 120)}${params.style_prompt.length > 120 ? '…' : ''}`)
    if (params.custom_instructions) job.output_lines.push(`Custom instructions: ${params.custom_instructions.slice(0, 120)}${params.custom_instructions.length > 120 ? '…' : ''}`)
  }
  job.progress = 10

  // v1.0.467 — scene_plan.json lives in the "03 Scene Prompts" folder now
  // (with a legacy episode-root fallback for older episodes). One resolved
  // path drives every read + in-place rewrite below, so they all stay in sync.
  const outPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)

  // ── Staged continuity workflow ──────────────────────────────────────────
  // Timeline creation is deterministic and free. Visual and optional motion
  // prompts are durable adaptive Hub packs keyed by stable scene IDs, with direct generation as
  // a connection-only fallback. This branch is intentionally before all legacy
  // re-plan modes so those remain available for repairing old plans.
  const isSingleSceneRepair = !!(
    params.regenerate_prompt_scene_id
    || params.regenerate_motion_prompt_scene_id
    || params.replan_scene_id
  )
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id)
  if (requestedStage || !isSingleSceneRepair) {
    const pipelineAutoVisual = requestedStage == null && !isSingleSceneRepair
    let stage: 'timeline' | 'visual' | 'motion' = requestedStage || 'timeline'
    if (stage === 'timeline') {
      const srtText = await fs.readFile(stitchedSrt, 'utf-8')
      const allCues = parseSrt(srtText)
      if (!allCues.length) throw new Error('The stitched subtitle timeline has no cues.')
      let configuredOpeningMode: 'branded-opening' | 'from-start' = 'from-start'
      let configuredOpeningSec = 15
      try {
        const cfg = await getConfig(job.project_slug) as any
        configuredOpeningMode = cfg?.visual_opening_mode === 'branded-opening'
          || (cfg?.visual_opening_mode == null && cfg?.skip_intro_scenes === true)
          ? 'branded-opening' : 'from-start'
        configuredOpeningSec = Number(cfg?.branded_opening_duration_sec) || 15
      } catch { /* defaults apply */ }
      const openingMode = params.opening_mode || configuredOpeningMode
      const openingReserved = openingMode === 'branded-opening'
        ? Math.max(0, Math.min(120, Number(params.opening_reserved_sec) || configuredOpeningSec))
        : 0
      const cues = allCues.filter(c => c.end_sec > openingReserved + 0.001)
      if (!cues.length) throw new Error(`The ${openingReserved.toFixed(1)}s opening covers the entire subtitle timeline.`)
      const { splitScenesDeterministically } = await import('../services/scene-planner.js')
      const minSec = pacing?.min_sec ?? 3
      const maxSec = pacing?.max_sec ?? 12
      const suspiciousGap = allCues.find((cue, index) => {
        if (index === 0) return false
        return cue.start_sec - allCues[index - 1]!.end_sec > Math.max(30, maxSec * 3)
      })
      if (suspiciousGap) {
        const previous = allCues[allCues.indexOf(suspiciousGap) - 1]!
        throw new Error(
          `Subtitle timeline contains an unexplained ${(suspiciousGap.start_sec - previous.end_sec).toFixed(1)}s gap ` +
          `near ${previous.end_sec.toFixed(1)}s. Re-open Subtitles, transcribe any missing chapters, and stitch again.`,
        )
      }
      const splitScenes = splitScenesDeterministically({
        cues,
        min_sec: minSec,
        max_sec: maxSec,
        target_sec: (minSec + maxSec) / 2,
        ...(pacing?.mode === 'documentary'
          ? {
              pacing_profile: {
                opening_duration_sec: pacing.opening_duration_sec || 0,
                settled_min_sec: pacing.settled_min_sec || minSec,
                settled_max_sec: pacing.settled_max_sec || maxSec,
              },
            }
          : {}),
        initial_start_sec: openingReserved,
        idGen: i => `${episode_id.toLowerCase()}-scene-${String(i + 1).padStart(4, '0')}`,
      })
      const timelineCleanup = removeNonRenderableScenes(splitScenes)
      const scenes = timelineCleanup.scenes
      let totalDuration = allCues[allCues.length - 1]!.end_sec
      try {
        const assets = await scanEpisodeAssets(job.project_slug, episode_id)
        const merged = assets?.merged_audio?.[0]?.path
        if (merged && existsSync(merged)) {
          const audioDuration = (await getAudioDuration(merged)) || 0
          if (audioDuration > totalDuration) totalDuration = audioDuration
        }
      } catch { /* stitched SRT duration remains the safe fallback */ }
      if (scenes.length) scenes[scenes.length - 1]!.end_sec = totalDuration
      if (characterDensity != null) assignDensityToUntagged(scenes, characterDensity)
      const builtAt = new Date().toISOString()
      const plan: ScenePlan = {
        schema_version: 1,
        generated_at: builtAt,
        timeline_built_at: builtAt,
        planner_model: model,
        source_stitched_srt: path.basename(stitchedSrt),
        total_duration_sec: totalDuration,
        research_used: useResearch && existsSync(researchPath),
        scenes,
        planned_in_windows: 0,
        planning_stage: 'timeline',
        opening_mode: openingMode,
        opening_reserved_sec: openingReserved,
      }
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      await fs.writeFile(outPath, JSON.stringify(plan, null, 2), 'utf-8')
      job.output_dir = paths.episode_dir
      job.output_lines.push(
        `Timeline ready: ${scenes.length} cue-aligned scene(s), starting at ${openingReserved.toFixed(1)}s. No LLM was used.`,
      )
      if (timelineCleanup.removed_ids.length) {
        job.output_lines.push(
          `Timeline cleanup: removed ${timelineCleanup.removed_ids.length} non-renderable zero-duration scene(s) before prompt generation.`,
        )
      }
      if (!pipelineAutoVisual) {
        job.progress = 100
        return
      }
      // The one-click Pipeline owns the complete required Scene Plan step. It
      // may not report success after creating only the timing shell.
      stage = 'visual'
      job.progress = 20
      job.output_lines.push('Continuing automatically with required visual prompts; motion prompts remain optional.')
    }

    if (!existsSync(outPath)) throw new Error('Create the scene timeline first.')
    const plan = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
    const timelineCleanup = removeNonRenderableScenes(plan.scenes)
    if (timelineCleanup.removed_ids.length) {
      plan.scenes = timelineCleanup.scenes
      await writeJsonAtomic(outPath, plan)
      job.output_lines.push(
        `Timeline cleanup: removed ${timelineCleanup.removed_ids.length} non-renderable zero-duration scene(s)`
        + (timelineCleanup.removed_prompt_ids.length
          ? ` and discarded ${timelineCleanup.removed_prompt_ids.length} unusable prompt checkpoint(s).`
          : '.'),
      )
    }
    clearLegacyPlannerFallbackReasons(plan.scenes)
    // Preserve a useful timeline timestamp when an older empty-prompt plan is
    // resumed. Once generated_at starts advancing with prompt saves it can no
    // longer be used as the timeline build time.
    if (!plan.timeline_built_at && plan.scenes.every(scene => !scene.visual_prompt?.trim())) {
      plan.timeline_built_at = plan.generated_at
    }
    const isMotion = stage === 'motion'
    if (formulaMotionProfile && plan.motion_profile?.id !== formulaMotionProfile.id) {
      plan.motion_profile = structuredClone(formulaMotionProfile)
      for (const scene of plan.scenes) delete scene.motion_mode
    }
    if (isMotion && plan.motion_profile) {
      const assigned = assignSceneMotionProfile(plan.scenes, plan.motion_profile, { preserveExisting: true })
      if (assigned.changed) await writeJsonAtomic(outPath, plan)
      job.output_lines.push(
        `Motion profile ${plan.motion_profile.label}: ${assigned.modes.still} still · ${assigned.modes.gentle} gentle · ${assigned.modes.limited} limited. Still scenes keep their approved image and are not sent to image-to-video.`,
      )
    }
    // Creative interpretation is selected once per plan, then assigned across
    // the full episode before any packs leave this Mac. This keeps variety
    // stable across Hub batches without introducing a second LLM pass.
    const creativeDirection = !isMotion
      ? normalizeCreativeDirection(plan.creative_direction || params.creative_direction)
      : plan.creative_direction
    if (!isMotion) {
      plan.creative_direction = assignCreativeStrategies(
        plan.scenes,
        creativeDirection,
        `${job.project_slug}:${episode_id}`,
        true,
      )
      await writeJsonAtomic(outPath, plan)
      const profile = plan.creative_direction.profile === 'custom'
        ? 'Custom'
        : CREATIVE_PROFILES[plan.creative_direction.profile].label
      job.output_lines.push(
        `Creative direction: ${profile} (${plan.creative_direction.intensity}/4) - strategies assigned across ${plan.scenes.length} scene(s) before packing.`,
      )
    }
    const duplicateVisualIds = new Set(inspectScenePromptIntegrity(plan.scenes).duplicate_ids)
    const pending = plan.scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene }) => isMotion
        ? !!scene.visual_prompt?.trim() && scene.motion_mode !== 'still' && !scene.motion_prompt?.trim()
        : !scene.visual_prompt?.trim() || duplicateVisualIds.has(scene.id))
    const limit = params.prompt_limit == null ? pending.length : Math.max(1, Math.min(5000, Math.round(params.prompt_limit)))
    const targets = pending.slice(0, limit)
    if (!targets.length) {
      job.progress = 100
      job.output_dir = paths.episode_dir
      job.output_lines.push(isMotion ? 'No pending motion prompts.' : 'No pending visual prompts.')
      return
    }
    const isPackedRepair = packedRepairStage === stage
    const targetPacks = packScenePromptItems(targets, promptPackSize)
    if (isPackedRepair) {
      job.output_lines.push(
        `Repairing ${targets.length} ${stage} prompt(s) in ${targetPacks.length} durable GenStudio pack(s) `
        + `(up to ${promptPackSize} scenes per request). Timeline boundaries and completed prompts stay unchanged.`,
      )
    }

    const effectiveStyle = await resolveEffectiveStyle(params.style_prompt, paths.episode_dir)
    const allCues = parseSrt(await fs.readFile(stitchedSrt, 'utf-8'))
    let storyStartSec = 0
    try {
      const chaptersPath = path.join(paths.episode_dir, 'audio_chapters.json')
      if (existsSync(chaptersPath)) {
        const chapters = JSON.parse(await fs.readFile(chaptersPath, 'utf-8'))
        const assets = await scanEpisodeAssets(job.project_slug, episode_id).catch(() => null)
        const story = await computeStoryStartSec(
          assets?.merged_audio?.[0]?.path || null,
          chapters.sections || [],
          Number(chapters.gap_duration_s) || 0,
        )
        storyStartSec = story?.story_start_sec || 0
      }
    } catch { /* story context falls back to later transcript */ }
    const storyContext = allCues
      .filter(c => c.start_sec >= storyStartSec - 0.01)
      .slice(0, 14)
      .map(c => c.text)
      .join(' ')
      .slice(0, 3500)
    let researchContext = ''
    if (!isMotion && useResearch && existsSync(researchPath)) {
      researchContext = (await fs.readFile(researchPath, 'utf-8').catch(() => '')).trim().slice(0, 6000)
    }

    if (!isMotion) job.output_lines.push(`Visual pack output budget: ${visualMaxTokens.toLocaleString()} tokens`)
    let packedMotionLevel = 2
    if (isMotion) {
      let projectDefaultMotion: number | undefined
      try { projectDefaultMotion = (await getConfig(job.project_slug) as any)?.default_motion_level } catch { /* default applies */ }
      packedMotionLevel = resolveMotionLevel(params.motion_level, projectDefaultMotion)
      const motionSpec = MOTION_SPECS[packedMotionLevel] || MOTION_SPECS[2]!
      job.output_lines.push(
        `Motion intensity: ${motionSpec.label} (level ${packedMotionLevel}) · ${motionSpec.allow}`,
      )
    }
    const motionSpec = MOTION_SPECS[packedMotionLevel] || MOTION_SPECS[2]!
    const task = isMotion
      ? `Write one restrained image-to-video motion prompt for each scene. Describe camera, ambient, and subject motion only; do not redesign the image. When a scene specifies motion_mode, follow it exactly: gentle means slow camera drift with one or two ambient elements only; limited means one narration-supported focal movement plus a slow camera move. Never add frantic or ungrounded action. Scenes marked still are intentionally excluded from this request. If no motion_mode is supplied, use the fallback intensity — ${motionSpec.label}: ${motionSpec.allow} Camera: ${motionSpec.camera}`
      : 'Write one full-detail cinematic image-generation prompt (110-150 words) for each scene. Honor each scene\'s assigned creative_strategy while keeping recurring subjects, wardrobe, locations, and visual style continuous. Vary the visual thinking across the pack; do not print or explain strategy labels.'
    // The image model that will RENDER these prompts publishes the ceiling, so
    // the writer is told to fit it up front. Empty when nothing is published.
    const promptCharCapInstruction = isMotion ? '' : buildPromptCharCapInstruction(promptCharCap)
    const payloadBySceneId = new Map<string, ScenePromptPayload>()
    const buildPackMessages = (
      scenePayloads: ScenePromptPayload[],
      recoveryIssues: readonly ScenePromptCompletionIssue[] = [],
    ): Array<{ role: 'system' | 'user'; content: string }> => {
      const recovery = isPackedRepair || recoveryIssues.length > 0
      const rejectedPrompts = recoveryIssues
        .filter(issue => issue.kind === 'duplicate-prompt')
        .map(issue => {
          const prompt = plan.scenes.find(scene => scene.id === issue.scene_id)?.visual_prompt?.trim()
          return prompt ? `${issue.scene_id}: ${prompt}` : ''
        })
        .filter(Boolean)
      return [
        {
          role: 'system',
          content: `${task}${promptCharCapInstruction ? `\n${promptCharCapInstruction}` : ''}\nReturn strict JSON only: {"results":[{"scene_id":"exact input id","${isMotion ? 'motion_prompt' : 'visual_prompt'}":"text"}]}. Start with { and output no analysis, reasoning, markdown, or commentary. Return every ID exactly once. Never invent IDs.${recovery ? ' This is a repair request: return every requested ID, with a non-empty, distinct prompt for each.' : ''}`,
        },
        {
          role: 'user',
          content: [
            effectiveStyle ? `STYLE BIBLE:\n${effectiveStyle}` : '',
            !isMotion && creativeDirection ? buildCreativeDirectionPrompt(creativeDirection) : '',
            !isMotion && creativeDirection ? `STRATEGY GLOSSARY:\n${buildStrategyGlossary(scenePayloads.map(scene => scene.creative_strategy).filter((strategy): strategy is SceneCreativeStrategy => !!strategy))}` : '',
            params.custom_instructions ? `EXTRA RULES:\n${params.custom_instructions}` : '',
            !isMotion && storyContext ? `STORY PREMISE / FIRST STORY PASSAGE:\n${storyContext}` : '',
            researchContext ? `EPISODE RESEARCH:\n${researchContext}` : '',
            isPackedRepair && !isMotion
              ? 'REPAIR CONTINUITY: Each scene may include previous_visual_prompts and upcoming_narration. Use them only to preserve recurring subjects, wardrobe, locations, and visual flow; write a new prompt only for that scene_id.'
              : '',
            !isMotion ? 'For scenes marked introduction_remainder, IGNORE welcome, CTA, subscribe, breathing, and channel language as visual subjects. Depict the story premise and characters instead; narration timing still controls the scene duration.' : '',
            recoveryIssues.length
              ? `AUTOMATIC RECOVERY:\nRepair only the supplied scene IDs. A previous response was rejected for: ${recoveryIssues.map(issue => `${issue.scene_id} (${issue.detail})`).join('; ')}. Give each scene a new, concrete composition; do not repeat a rejected prompt verbatim.`
              : '',
            rejectedPrompts.length ? `REJECTED PROMPTS — DO NOT REUSE:\n${rejectedPrompts.join('\n')}` : '',
            `SCENES:\n${JSON.stringify(scenePayloads)}`,
          ].filter(Boolean).join('\n\n'),
        },
      ]
    }
    const contextBack = Math.max(0, Math.min(10, params.neighbor_context_back ?? 2))
    const contextForward = Math.max(0, Math.min(10, params.neighbor_context_forward ?? 1))
    const packs: ScenePromptPack[] = []
    for (const [packIndex, group] of targetPacks.entries()) {
      const scenePayloads = group.map(({ scene, index }) => ({
        scene_id: scene.id,
        start_sec: scene.start_sec,
        end_sec: scene.end_sec,
        narration: scene.transcript_segment,
        visual_prompt: isMotion ? scene.visual_prompt : undefined,
        motion_mode: isMotion && scene.motion_mode !== 'still' ? scene.motion_mode : undefined,
        creative_strategy: !isMotion ? scene.creative_strategy : undefined,
        introduction_remainder: !isMotion && storyStartSec > 0 && scene.start_sec < storyStartSec,
        previous_visual_prompts: isPackedRepair && !isMotion
          ? plan.scenes
            .slice(Math.max(0, index - contextBack), index)
            .map(item => item.visual_prompt?.trim() || '')
            .filter(Boolean)
          : undefined,
        upcoming_narration: isPackedRepair && !isMotion
          ? plan.scenes
            .slice(index + 1, index + 1 + contextForward)
            .map(item => item.transcript_segment?.trim() || '')
            .filter(Boolean)
          : undefined,
      } satisfies ScenePromptPayload))
      for (const payload of scenePayloads) payloadBySceneId.set(payload.scene_id, payload)
      packs.push({
        pack_id: `${stage}-${String(packIndex + 1).padStart(4, '0')}`,
        scene_ids: group.map(({ scene }) => scene.id),
        // Chat Studio defaults to only 1,024 output tokens, which cannot hold
        // ten 110–150 word visual prompts. Set an explicit pack-sized budget.
        params: {
          temperature: isMotion ? 0.35 : Math.min(0.68, 0.5 + ((creativeDirection?.intensity || 2) * 0.035)),
          max_tokens: isMotion ? activePromptOutputBudget : visualMaxTokens,
        },
      })
    }

    const targetIds = new Set(targets.map(({ scene }) => scene.id))
    const durableTargetIds = new Set<string>()
    const syncMemoryPlan = (fresh: ScenePlan) => {
      plan.generated_at = fresh.generated_at
      plan.planning_stage = fresh.planning_stage
      for (const freshScene of fresh.scenes) {
        const memoryScene = plan.scenes.find(scene => scene.id === freshScene.id)
        if (!memoryScene) continue
        memoryScene.visual_prompt = freshScene.visual_prompt
        memoryScene.motion_prompt = freshScene.motion_prompt
        memoryScene.motion_mode = freshScene.motion_mode
      }
    }
    const persistPrompt = async (sceneId: string, text: string) => {
      if (!targetIds.has(sceneId)) {
        throw new Error(`Provider returned unexpected scene ID ${sceneId}; no prompt was saved for it.`)
      }
      let lastError: unknown
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const checkpoint = await checkpointScenePrompt(outPath, sceneId, text, isMotion ? 'motion' : 'visual')
          syncMemoryPlan(checkpoint.plan)
          durableTargetIds.add(sceneId)
          job.progress = 10 + Math.round((durableTargetIds.size / Math.max(1, targets.length)) * 85)
          return
        } catch (error) {
          lastError = error
          if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 150 * attempt))
        }
      }
      throw new Error(`Could not save ${sceneId} after 5 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    }
    const requestPromptPack = async (input: {
      sceneIds: string[]
      saved: Set<string>
      requestLabel: string
      maxTokens: number
      recoveryIssues?: readonly ScenePromptCompletionIssue[]
    }) => {
      const payloads = input.sceneIds.map(sceneId => payloadBySceneId.get(sceneId)).filter((payload): payload is ScenePromptPayload => !!payload)
      if (payloads.length !== input.sceneIds.length) {
        throw new Error(`Cannot repair unknown scene IDs: ${input.sceneIds.filter(sceneId => !payloadBySceneId.has(sceneId)).join(', ')}`)
      }
      let diagnostics: TextGenerationDiagnostics | undefined
      let results = new Map<string, string>()
      let checkpointErrors: string[] = []
      let requestError = ''
      try {
        const messages = buildPackMessages(payloads, input.recoveryIssues)
        const raw = await callAi(
          model,
          messages[0]!.content,
          messages.slice(1).map(message => message.content).join('\n\n'),
          GENSTUDIO_ONLY_LEGACY_KEY_BAG,
          false,
          {
            slug: job.project_slug,
            jobId: `${job.job_id}:${input.requestLabel}`,
            requestIdentity: `${job.project_slug}:${episode_id}:scene-plan:${stage}:${input.requestLabel}`,
            maxTokens: input.maxTokens,
            outputContract: scenePromptPackOutputContract(input.sceneIds, isMotion ? 'motion' : 'visual'),
            disableReasoning: true,
            temperature: isMotion ? 0.35 : Math.min(0.68, 0.5 + ((creativeDirection?.intensity || 2) * 0.035)),
            onDiagnostics: (details: TextGenerationDiagnostics) => { diagnostics = details },
          },
        )
        results = parseDirectPackResults(raw, input.sceneIds, isMotion ? 'motion' : 'visual')
        checkpointErrors = await checkpointPackPromptResults(
          results,
          new Set(input.sceneIds),
          input.saved,
          persistPrompt,
        )
      } catch (error: any) {
        requestError = error?.message || String(error)
      }
      return { results, checkpointErrors, diagnostics, requestError }
    }
    job.output_lines.push(`Processing ${packs.length} adaptive pack(s) through GenStudio KH (${model}).`)
    const incompletePacks: string[] = []
    for (const pack of packs) {
      if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
      // A resumed run may already have made some rows durable. Never submit
      // or count those rows again.
      const saved = new Set(pack.scene_ids.filter(sceneId => durableTargetIds.has(sceneId)))
      const missing = pack.scene_ids.filter(id => !saved.has(id))
      const initial = await requestPromptPack({
        sceneIds: missing,
        saved,
        requestLabel: pack.pack_id,
        maxTokens: Number(pack.params.max_tokens) || visualMaxTokens,
      })
      let receipt = await auditScenePromptCompletion(outPath, pack.scene_ids, isMotion ? 'motion' : 'visual')
      syncMemoryPlan(receipt.plan)
      for (const sceneId of receipt.completed_ids) durableTargetIds.add(sceneId)
      let issues = diagnoseScenePromptCompletionIssues({
        plan: receipt.plan,
        requestedIds: pack.scene_ids,
        missingIds: receipt.missing_ids,
        providerResults: initial.results,
        checkpointErrors: initial.checkpointErrors,
      })
      const initialFinish = initial.diagnostics?.finishReason || initial.diagnostics?.nativeFinishReason
      const initialTokenSummary = initial.diagnostics?.completionTokens != null
        ? `${initial.diagnostics.completionTokens.toLocaleString()} completion tokens${initial.diagnostics.reasoningTokens ? `, ${initial.diagnostics.reasoningTokens.toLocaleString()} reasoning` : ''}`
        : ''
      let lastError = initial.requestError
        || [
          issues.map(issue => `${issue.scene_id}: ${issue.detail}`).join('; '),
          initialFinish === 'length' ? `provider hit its output limit${initialTokenSummary ? ` (${initialTokenSummary})` : ''}` : '',
        ].filter(Boolean).join('; ')
        || 'provider response did not verify on disk'

      // Once GenStudio has completed the original pack, a bounded repair
      // request is deliberate new work, but it is strictly
      // scoped to the IDs that failed the durable audit. Outstanding IDs stay
      // together in one compact repair pack so a partial provider response can
      // never fan back out into one paid request per scene.
      let automaticRepairAttempts = 0
      for (let attempt = 1; !initial.requestError && receipt.missing_ids.length && attempt <= MAX_AUTOMATIC_PROMPT_REPAIR_ATTEMPTS; attempt++) {
        automaticRepairAttempts = attempt
        const outstanding = [...receipt.missing_ids]
        const repairGroups = [outstanding]
        job.output_lines.push(
          `↻ GenStudio prompt repair ${attempt}/${MAX_AUTOMATIC_PROMPT_REPAIR_ATTEMPTS}: requesting ${outstanding.length} missing or invalid scene prompt(s) only.`,
        )
        const repairResults = new Map<string, string>()
        const repairCheckpointErrors: string[] = []
        const repairRequestErrors: string[] = []
        for (const group of repairGroups) {
          if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
          const groupIssues = issues.filter(issue => group.includes(issue.scene_id))
          const repair = await requestPromptPack({
            sceneIds: group,
            saved,
            requestLabel: `${pack.pack_id}:repair-${attempt}:${group.join(',')}`,
            maxTokens: Math.min(
              isMotion ? activePromptOutputBudget : visualMaxTokens,
              Math.max(2_048, group.length * 768),
            ),
            recoveryIssues: groupIssues,
          })
          for (const [sceneId, prompt] of repair.results) repairResults.set(sceneId, prompt)
          repairCheckpointErrors.push(...repair.checkpointErrors)
          if (repair.requestError) repairRequestErrors.push(repair.requestError)
        }
        receipt = await auditScenePromptCompletion(outPath, pack.scene_ids, isMotion ? 'motion' : 'visual')
        syncMemoryPlan(receipt.plan)
        for (const sceneId of receipt.completed_ids) durableTargetIds.add(sceneId)
        issues = diagnoseScenePromptCompletionIssues({
          plan: receipt.plan,
          requestedIds: pack.scene_ids,
          missingIds: receipt.missing_ids,
          providerResults: repairResults,
          checkpointErrors: repairCheckpointErrors,
        })
        if (!receipt.missing_ids.length) {
          job.output_lines.push(`✓ GenStudio prompt repair verified ${pack.scene_ids.length}/${pack.scene_ids.length} prompts for ${pack.pack_id}.`)
          break
        }
        const repairDetails = [
          ...repairRequestErrors,
          ...issues.map(issue => `${issue.scene_id}: ${issue.detail}`),
        ]
        lastError = repairDetails.join('; ') || lastError
      }
      if (receipt.missing_ids.length) {
        incompletePacks.push(`${pack.pack_id} saved ${receipt.completed_ids.length}/${pack.scene_ids.length}; missing ${receipt.missing_ids.join(', ')} (${lastError})`)
        job.output_lines.push(
          initial.requestError
            ? `Partial checkpoint: ${pack.pack_id} saved ${receipt.completed_ids.length}/${pack.scene_ids.length} on disk. Automatic repair was not started because the original GenStudio request did not finish safely; Manual Retry requests only the missing scene IDs.`
            : `Partial checkpoint: ${pack.pack_id} saved ${receipt.completed_ids.length}/${pack.scene_ids.length} on disk after ${automaticRepairAttempts} automatic repair attempt(s). Manual Retry requests only the missing scene IDs through GenStudio.`,
        )
      } else {
        job.output_lines.push(`Checkpointed ${pack.pack_id}: ${receipt.completed_ids.length}/${pack.scene_ids.length} prompts verified on disk.`)
      }
    }
    if (incompletePacks.length) job.output_lines.push(`Incomplete packs: ${incompletePacks.join(' | ')}`)
    job.output_dir = paths.episode_dir
    const completion = await auditScenePromptCompletion(outPath, targetIds, isMotion ? 'motion' : 'visual')
    syncMemoryPlan(completion.plan)
    if (!isMotion) {
      requireJobCompletion(job, {
        label: 'Visual prompt generation', expected: targets.length, completed: completion.completed_ids.length,
        missing: completion.missing_ids,
        retry_hint: 'Automatic GenStudio repair is exhausted. Retry All pending; image rendering remains blocked until every scene has a unique prompt.',
      })
    } else {
      requireJobCompletion(job, {
        label: 'Motion prompt generation', expected: targets.length, completed: completion.completed_ids.length,
        missing: completion.missing_ids,
        retry_hint: 'Motion is optional until enabled; once enabled, Retry fills only the missing prompts.',
      })
    }
    job.progress = 100
    job.output_lines.push(`Verified ${completion.completed_ids.length}/${targets.length} ${stage} prompt(s) on disk by stable scene ID.`)
    // Advisory only. Every prompt was saved in full; a prompt that overran the
    // ceiling is named so the user can decide, and is never shortened for them.
    if (!isMotion) {
      const overCapNotice = describeOverCapPrompts(
        completion.plan.scenes
          .filter(scene => targetIds.has(scene.id))
          .map(scene => ({ label: `scene #${scene.scene_index}`, text: scene.visual_prompt })),
        promptCharCap,
      )
      if (overCapNotice) job.output_lines.push(overCapNotice)
    }
    return
  }

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
    const creativeDirectionForRewrite = assignCreativeStrategies(
      existing.scenes,
      existing.creative_direction || params.creative_direction,
      `${job.project_slug}:${episode_id}`,
      true,
    )
    existing.creative_direction = creativeDirectionForRewrite
    const newPrompt = await generateVisualPromptOnly({
      transcript_segment: target.transcript_segment,
      model,
      detail_level: params.detail_level,
      style_prompt: stylePromptForRewrite,
      custom_instructions: params.custom_instructions,
      creative_direction: creativeDirectionForRewrite,
      creative_strategy: target.creative_strategy,
      prompt_char_cap: promptCharCap,
      apiKeys: GENSTUDIO_ONLY_LEGACY_KEY_BAG,
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
    clearLegacyPlannerFallbackReasons([target])
    existing.generated_at = new Date().toISOString()
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(existing, null, 2), 'utf-8')
    job.output_dir = paths.episode_dir
    job.progress = 100
    const rewriteLength = readPromptLength(newPrompt, promptCharCap)
    job.output_lines.push(
      `✓ Prompt regenerated (${rewriteLength.characters.toLocaleString()}`
      + `${rewriteLength.cap ? ` / ${rewriteLength.cap.toLocaleString()}` : ''} chars). Other scenes untouched.`,
    )
    if (rewriteLength.over_cap) {
      job.output_lines.push(
        `⚠ ${rewriteLength.overage.toLocaleString()} characters over the ${rewriteLength.cap!.toLocaleString()}-character limit. `
        + 'The prompt was saved in full — shorten it, raise the limit, or render as-is.',
      )
    }
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
    const motionStyle = await resolveEffectiveStyle(params.style_prompt, paths.episode_dir)
    const newMotion = await generateMotionPromptOnly({
      transcript_segment: target.transcript_segment,
      visual_prompt: target.visual_prompt,
      model,
      motion_level: motionLevel,
      style_prompt: motionStyle,
      custom_instructions: params.custom_instructions,
      apiKeys: GENSTUDIO_ONLY_LEGACY_KEY_BAG,
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
      // Live context/output figures for the 'auto' window-size heuristic
      // (see TARGET_SCENES_PER_WINDOW in scene-planner.ts). Absent when this
      // run is model-free (`promptModel` null); the planner then falls back
      // to the smaller, safer window rather than guess.
      context_window_tokens: promptModel?.context_window_tokens,
      max_output_tokens: promptModel?.max_output_tokens,
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
    // Live context/output figures for the 'auto' window-size heuristic (see
    // TARGET_SCENES_PER_WINDOW in scene-planner.ts). Ignored by
    // planScenesTwoPass; absent when this run is model-free.
    context_window_tokens: promptModel?.context_window_tokens,
    max_output_tokens: promptModel?.max_output_tokens,
    target_scene_count: params.target_scene_count,
    detail_level: params.detail_level,
    style_prompt: effectiveStyle,
    custom_instructions: params.custom_instructions,
    pacing,
    character_density: characterDensity,
    // v1.0.285 — per-window scene count tuning ('auto' now sizes off the
    // selected product's published context window; see
    // TARGET_SCENES_PER_WINDOW in scene-planner.ts). Ignored by
    // planScenesTwoPass.
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
  if (formulaMotionProfile) {
    plan.motion_profile = structuredClone(formulaMotionProfile)
    const assigned = assignSceneMotionProfile(plan.scenes, plan.motion_profile)
    job.output_lines.push(
      `Motion profile ${plan.motion_profile.label}: ${assigned.modes.still} still · ${assigned.modes.gentle} gentle · ${assigned.modes.limited} limited.`,
    )
  }

  job.progress = 80
  if ((plan.planned_in_windows ?? 1) > 1) {
    job.output_lines.push(`Planned in ${plan.planned_in_windows} segments (long episode — chunked so the model never truncates).`)
  }
  job.output_lines.push(`Planner returned ${plan.scenes.length} scene(s). Writing ${SCENE_PLAN_FILENAME}…`)

  // v1.0.522 — audio-coverage prevention: probe the REAL merged audio and
  // repair the plan to full coverage before it's ever written. The old
  // v1.0.225 check compared two SRT-derived numbers (last scene end vs
  // total_duration_sec = last cue end), so trailing silence/music and
  // inter-cue gaps were invisible by construction — measured 74s (EP0017) and
  // 204s (EP0018) of narration with no scene. Both assemblers now HARD-FAIL
  // on >2s uncovered, so plans must leave here fully covered.
  {
    let audioDur = 0
    try {
      const assets = await scanEpisodeAssets(job.project_slug, episode_id).catch(() => null)
      const mergedPath = assets?.merged_audio?.[0]?.path
      if (mergedPath && existsSync(mergedPath)) {
        audioDur = (await getAudioDuration(mergedPath)) || 0
      }
    } catch { /* fall through to the SRT-only warning below */ }

    if (audioDur > 0 && plan.scenes.length) {
      const skipHead = skipUntilSec > 0  // intentional intro-skip head is NOT a gap to close here
      const { scenes: repaired, changes, coverageBefore } = repairPlanCoverage(plan.scenes, audioDur)
      // Keep an intentional intro-skip head untouched (repair only pulls ≤2s
      // heads anyway, but don't even do that when the head is by design).
      if (skipHead && plan.scenes[0] && repaired[0]) repaired[0].start_sec = plan.scenes[0].start_sec
      plan.scenes = repaired
      plan.total_duration_sec = audioDur
      for (const line of changes) job.output_lines.push(`Coverage: ${line}`)
      if (!changes.length) {
        job.output_lines.push(`Coverage: plan already covers the full audio (${audioDur.toFixed(1)}s) — no gaps.`)
      } else {
        job.output_lines.push(
          `Coverage: audio ${audioDur.toFixed(1)}s — was missing ${coverageBefore.uncoveredTotalSec.toFixed(1)}s ` +
          `(head ${coverageBefore.headGapSec.toFixed(1)}s, ${coverageBefore.internalGaps.length} internal gap(s) ` +
          `${coverageBefore.internalGapTotalSec.toFixed(1)}s, tail ${coverageBefore.tailGapSec.toFixed(1)}s) — now fully covered.`,
        )
      }
    } else {
      // No merged audio on disk yet (plan made before Audio Merge) — coverage
      // can't be verified against the real file. Keep the legacy SRT-derived
      // truncation warning so a mid-episode LLM cutoff still surfaces.
      const lastEnd = plan.scenes.length ? plan.scenes[plan.scenes.length - 1]!.end_sec : 0
      const total = plan.total_duration_sec || 0
      job.output_lines.push(
        `Coverage: merged audio not found — plan verified against the stitched SRT only. ` +
        `Re-check coverage (Scene Plan → Repair coverage) after Audio Merge.`,
      )
      if (total > 0 && lastEnd < total * 0.97) {
        const pct = Math.round((lastEnd / total) * 100)
        job.output_lines.push(
          `⚠ Plan covers only ~${pct}% of the audio (${lastEnd.toFixed(0)}s of ${total.toFixed(0)}s). ` +
          `The model's output was likely truncated — the planned scenes are valid, but the rest of the ` +
          `episode isn't covered. Re-run with a larger-output model, or widen the pacing band to reduce scene count.`,
        )
      }
    }
  }

  // Persist the plan with visual prompts BEFORE the motion pass. Motion
  // generation is a second, potentially long LLM phase — if it crashes, is
  // cancelled, or the app restarts, the (expensive) image scenes are already on
  // disk instead of being lost with it. Same partial-progress protection the
  // visual planner's chunking gives.
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, JSON.stringify(plan, null, 2), 'utf-8')
  const visualIntegrity = inspectScenePromptIntegrity(plan.scenes)
  requireJobCompletion(job, {
    label: 'Scene planning visual prompts',
    expected: plan.scenes.length,
    completed: plan.scenes.length - visualIntegrity.invalid_ids.length,
    missing: visualIntegrity.invalid_ids,
    retry_hint: 'The valid timeline and prompts were kept. Run All pending to fill missing or duplicated prompts.',
  })

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
    const motionModel = promptModel ? await requireScenePlanGenStudioModel(promptModel) : model
    const motionLevel = resolveMotionLevel(params.motion_level, projDefaultMotion)
    const targets = plan.scenes
      .map((s, i) => (s.visual_prompt?.trim() && s.motion_mode !== 'still' ? i : -1))
      .filter(i => i >= 0)
    if (targets.length) {
      const MOTION_LABELS: Record<number, string> = { 1: 'Still', 2: 'Gentle', 3: 'Moderate', 4: 'Lively' }
      job.output_lines.push(
        `Generating motion prompts for ${targets.length} animated scene(s) — ${plan.motion_profile ? `${plan.motion_profile.label} profile` : `intensity ${MOTION_LABELS[motionLevel] ?? motionLevel} (level ${motionLevel})`}` +
        (promptModel ? ` · fast prompt model: ${motionModel}` : '') + '…',
      )
      const failed = await generateMotionPromptsForScenes(plan.scenes, targets, {
        model: motionModel,
        motion_level: motionLevel,
        motion_level_for_scene: scene => motionModeLevel(scene.motion_mode, motionLevel),
        style_prompt: effectiveStyle,
        custom_instructions: params.custom_instructions,
        apiKeys: GENSTUDIO_ONLY_LEGACY_KEY_BAG,
        slug: job.project_slug,
        should_cancel: () => isCancelled(job.job_id),
        onWarn: (m) => job.output_lines.push(m),
        onProgress: (done, total) => {
          if (done % 10 === 0 || done === total) job.output_lines.push(`${done}/${total} motion prompt(s) so far…`)
          job.progress = 80 + Math.round((done / Math.max(1, total)) * 18) // 80→98 band
        },
        onResult: async (index, prompt) => {
          await checkpointScenePrompt(outPath, plan.scenes[index]!.id, prompt, 'motion')
        },
      })
      const persisted = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
      const missingMotionIds = targets
        .map(index => plan.scenes[index]!.id)
        .filter(sceneId => !persisted.scenes.find(scene => scene.id === sceneId)?.motion_prompt?.trim())
      const made = targets.length - missingMotionIds.length
      job.output_lines.push(
        missingMotionIds.length
          ? `✓ Motion prompts: ${made}/${targets.length} saved (${missingMotionIds.length} left empty — use "Regen empty motion prompts").`
          : `✓ Motion prompts: ${made}/${targets.length} written.`,
      )
      requireJobCompletion(job, {
        label: 'Motion prompt generation', expected: targets.length, completed: made,
        missing: missingMotionIds,
        retry_hint: 'Motion prompts already saved were kept; Retry fills only the remaining gaps.',
      })
      if (failed && !missingMotionIds.length) {
        job.output_lines.push('All motion prompts are durable despite transient worker failures reported during generation.')
      }
    }
  }

  job.output_dir = paths.episode_dir
  job.progress = 100
  job.output_lines.push('Done.')
}
