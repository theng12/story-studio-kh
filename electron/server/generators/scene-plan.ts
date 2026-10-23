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
import { isDeepStrictEqual } from 'node:util'
import { planScenes, planScenesTwoPass, generateVisualPromptOnly, generatePromptsForScenes, generateMotionPromptOnly, generateMotionPromptsForScenes, MOTION_SPECS, resolveMotionLevel, assignDensityToUntagged, inspectScenePlanCoverage, repairPlanCoverage, removeNonRenderableScenes, COVERAGE_FAIL_SEC, styleLeadOverhead } from '../services/scene-planner.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { compareMergedAudio, comparePlanStamp, planNarrationShortfallSec, readNarrationRecord, stampFromCues } from '../lib/scene-plan-timeline.js'
import { checkpointJobState, hasUnsettledProviderEvidence, isCancelled, throwIfPauseRequested } from '../services/job-queue.js'
import { nonRetryable } from '../services/job-retry-policy.js'
import { subtitleChapterLabel } from '../contracts/subtitle-gaps.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath, resolveSubfolderNames } from '../services/utils.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { getConfig } from '../services/project-manager.js'
import { computeStoryStartSec, scenePlanLeadInShiftSec } from '../lib/intro-lead-in.js'
import { narrationSecFromMaster } from '../lib/closing-tail.js'
import { resolveEpisodeMergedAudioChoice, expectedMergedAudioFilename } from '../lib/merged-audio-selection.js'
import { resolveProjectOpening } from '../services/opening-assets.js'
import { describeOpeningHead, measureOpeningSec } from '../lib/opening-duration.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { imagePromptGuidanceBlock, legibleTextGuidanceBlock, resolveAvoidLegibleText } from '../lib/image-content-guidance.js'
import { resolveStyleBible } from '../lib/style-bible.js'
import { callAi, callAiWithModelPolicy, sanitizeJsonControlChars } from '../lib/ai-client.js'
import type { TextGenerationDiagnostics } from '../providers/types.js'
import { scenePromptPackOutputContract } from '../lib/story-output-contracts.js'
import {
  listChatModels as listGenStudioChatModels,
  GenStudioApiError,
  GenStudioChatCapabilityUnavailableError,
  GenStudioChatIncompleteError,
  GenStudioChatProductUnavailableError,
  GenStudioChatRecoveryUnresolvedError,
  isGenStudioInsufficientCredits,
  isGenStudioRequestInProgress,
  isGenStudioSubmissionUncertain,
  type GenStudioChatModel,
} from '../lib/genstudio-client.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import { pipelinePolicyCheckpointStore, pipelinePolicyForJob, pipelinePolicyInputFingerprint } from '../lib/pipeline-model-policy.js'
import {
  SCENE_TIMELINE_ONLY_OUTPUT_BUDGET,
  describeScenePromptPackSize,
  parseScenePromptPackSetting,
  parseScenePromptPackTuning,
  parseScenePromptTokenSetting,
  resolveScenePromptPackSize,
  resolveScenePromptTokenBudget,
  type ScenePromptPackSetting,
  type ScenePromptTokenSetting,
} from '../services/scene-prompt-batching.js'
import {
  addAssemblyOverhead,
  assemblyOverheadOf,
  buildPromptCharCapInstruction,
  describeOverCapPrompts,
  measureAssemblyOverhead,
  parsePromptCharCap,
  promptBodyCeiling,
  readPromptLength,
  type AssemblyOverhead,
  type PromptCharCapSource,
} from '../services/prompt-char-cap.js'
import { readSceneRenderAssembly, sceneRenderAssemblyParts } from '../services/scene-prompt-assembly.js'
import { requireLiveImagePromptCharCapDetail } from '../services/image-prompt-cap.js'
import { scanEpisodeAssets } from './video.js'
import { assertSubtitleTimelineComplete, readSubtitleTimelineIntegrity, restitchIfBroken, safetyCarriesOn, type SubtitleCueGap } from '../services/scene-timeline-integrity.js'
import { allowedSubtitleCueGapSec, resolveScenePlanPacing, type ScenePlanPacing } from '../services/scene-plan-pacing.js'
import { resolveTranscriptSrt, describeTranscriptCorrection, stitchedSrtPath } from '../services/subtitle-correction.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { freshGenerationRequestIdentity } from '../lib/fresh-generation-action.js'
import { auditScenePromptCompletion, checkpointScenePrompt } from '../services/scene-prompt-checkpoint.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import {
  clearLegacyPlannerFallbackReasons,
  inspectScenePromptIntegrity,
  normalizeScenePrompt,
} from '../services/scene-prompt-integrity.js'
import {
  assignCreativeStrategies,
  buildCreativeDirectionPrompt,
  buildStrategyGlossary,
  CREATIVE_PROFILES,
  normalizeCreativeDirection,
} from '../services/scene-creative-direction.js'
import { normalizeMotionScope, type MotionScope } from '../contracts/motion-scope.js'
import { DEFAULT_SCENE_PACING, parseSavedScenePlanPacing, parseScenePacing, type ScenePacing } from '../contracts/pacing.js'
import { readEpisodeMotionScope } from '../services/episode-motion-scope.js'
import { motionPromptSceneIds } from '../services/scene-motion-prompt-scope.js'
import type { Job, SceneCreativeDirection, SceneCreativeStrategy, ScenePlan } from '../models/types.js'
import { truncateChars } from '../lib/well-formed-text.js'
import { withSavedPromptCollection } from '../lib/scene-prompt-collection.js'

/** Older explicit motion jobs used motion_mode=still before motion_choice existed. */
export function motionPromptScenesForRequest<T extends { motion_mode?: string }>(scenes: T[], legacyMotionRequest: boolean): T[] {
  return legacyMotionRequest ? scenes.filter(scene => scene.motion_mode !== 'still') : scenes
}

/**
 * v1.0.364 — resolve the effective plan-time style. The channel "Look" is the
 * continuity Style Bible, applied at render to every scene. When the planner
 * isn't given an explicit per-plan style, fall back to that Style Bible so the
 * plan and the render share ONE look — no second field to drift. Returns the
 * explicit value (trimmed) untouched when present.
 *
 * v1.0.795 — the Style Bible itself now has two tiers: this episode's
 * continuity.json, else the project's standing default (config.json
 * `default_style_bible`). Both are resolved by the shared `resolveStyleBible`
 * so this path and the render path (generators/continuity-render.ts) cannot
 * disagree about which tier is in force. An episode with no Style Bible on a
 * project with no default resolves to nothing, exactly as before.
 */
async function resolveEffectiveStyle(
  explicit: string | undefined,
  slug: string,
  episodeDir: string,
  onFallback?: (source: 'episode' | 'project') => void,
): Promise<string | undefined> {
  if (explicit && explicit.trim()) return explicit.trim()
  const resolved = await resolveStyleBible({ slug, episodeDir })
  if (resolved.text) {
    onFallback?.(resolved.source as 'episode' | 'project')
    return resolved.text
  }
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
   *  Uses the explicit episode value, then 2. */
  motion_level?: number
  /** v1.0.468 — generate a per-scene motion_prompt alongside each visual_prompt
   *  (for animating the image into a clip later), within the saved episode scope. */
  generate_motion_prompts?: boolean
  /** Accepted episode settings and exact prompt targets; retained on Retry. */
  motion_scope?: MotionScope
  motion_scene_ids?: string[]
  pacing?: ScenePacing
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
  /**
   * Pairs with `regenerate_prompt_scene_id`: this rewrite is a user-invoked
   * REWORD of a prompt that did not render. The writer is asked for a
   * different angle on the same beat, with the difficult-subjects guidance
   * applied and the old prompt shown as something to move away from.
   *
   * Only ever set by the explicit "Reword" action. GenStudio's exact terminal
   * IMAGE_CONTENT_REFUSED code can offer this action, but never triggers it;
   * Story Studio does not guess from other failures — see
   * lib/image-content-guidance.ts.
   */
  reword_prompt?: boolean
  /** Scene Plan "Regenerate prompts" for the selected scenes: rewrite only
   *  these scenes' visual_prompt, one after another, with the chosen model. */
  regenerate_prompt_scene_ids?: string[]
  /** Bulk-repair every missing or duplicated visual_prompt through the same
   * durable GenStudio packs as normal visual generation. Time ranges and
   * transcripts are untouched. */
  regenerate_empty_prompts?: boolean
  /** Explicit Jobs-page consent for paid, one-scene-at-a-time repair. */
  auto_repair_missing_prompts?: boolean
  /** Server-derived exact chat keys that must be reclaimed before new work. */
  scene_prompt_recoveries?: Array<{ idempotency_key: string; scene_ids?: string[] }>
  /** v1.0.291 — planning strategy. 'single-pass' (default) uses the
   *  historical windowed LLM planner; 'two-pass' splits cues deterministic-
   *  ally then generates prompts per-scene as plain prose. The two-pass
   *  path is recommended for small local models that fail JSON output, but
   *  no shipped UI selects it (see ScenePlanRunOptions.planning_mode) — an
   *  API caller or a saved run is the only way it is chosen today. */
  planning_mode?: 'single-pass' | 'two-pass'
  /** v1.0.291 — neighbor-context window for two-pass prompt generation.
   *  See ScenePlanRunOptions.neighbor_context_{back,forward}. */
  neighbor_context_back?: number
  neighbor_context_forward?: number
  /** v1.0.423 — skip the leading "Introduction" chapter (sleep-story welcome /
   *  CTA / breathing) so scenes are planned only for the story. Per-episode
   *  override; falls back to the project default (config.skip_intro_scenes). */
  skip_intro?: boolean
  /** v1.0.794 — SCENE prompts only (never thumbnails): describe lettering on
   *  scrolls, signs, and pages as indistinct marks/texture instead of asking
   *  for specific readable words, so a fast image model stops rendering
   *  confident gibberish. Per-run override; falls back to the project default
   *  (config.avoid_legible_text_in_scenes, default ON). See
   *  resolveAvoidLegibleText in lib/image-content-guidance.ts. */
  avoid_legible_text?: boolean
  /** New staged workflow. Timeline is deterministic; prompts are separate. */
  stage?: 'timeline' | 'visual' | 'motion'
  /** Pipeline Force is an explicit whole-plan rebuild, even when stage is omitted. */
  force?: boolean
  // v1.3.1 — `opening_mode` / `opening_reserved_sec` are gone. How long the
  // branded opening runs is a measurable property of the project's own clips,
  // not a setting a request (or a preset behind it) may assert. See
  // `services/opening-assets.ts`. Old presets may still carry the two keys;
  // they are inert, and no stored preset is rewritten to remove them.
  /** Limit a manual run to the next N pending scenes. Omit for all pending. */
  prompt_limit?: number
  /** The selected GenStudio model's published output limit determines Auto. */
  prompt_pack_size?: ScenePromptPackSetting
  /** Advanced override. Any positive allowance is accepted and clamped to the
   *  SELECTED product's published `max_output_tokens` — never to a fixed list,
   *  which would cap a 128,000-token product at a stale 32,768. */
  prompt_max_tokens?: ScenePromptTokenSetting
  /** Stable Pipeline pack layout: retries must never repartition paid prompt work. */
  pipeline_scene_prompt_pack_sizes?: Partial<Record<'visual' | 'motion', number>>
  /** Historical request shape for resuming this job, never current catalogue facts. */
  pipeline_scene_request_plan?: ScenePolicyRequestPlan
  /**
   * The character CEILING every visual prompt is written under, so the prompt
   * survives the image model that will render it. It is never a length to fill:
   * a scene that needs 500 characters keeps 500 under an 8,000 ceiling.
   *
   * A job accepted by the current version also carries `prompt_char_cap_selection`
   * and re-resolves the ceiling against the LIVE catalogue when it runs. Jobs
   * accepted by 1.4.348 and earlier carry only this number: it is then used
   * as-is, as a saved allowance — never re-resolved, never described as a
   * published figure. See services/prompt-char-cap.ts.
   */
  prompt_char_cap?: number
  /** The persisted SELECTION ('auto' / 'none' / a whole number) plus the image
   *  model it was chosen for. Present only on jobs accepted since the live
   *  re-resolution existed; absence means this is a legacy numeric allowance. */
  prompt_char_cap_selection?: unknown
  intended_image_model?: string
  /** Single-pass visual interpretation controls. Strategies are assigned
   * locally across the full episode before existing prompt packs are sent. */
  creative_direction?: Partial<SceneCreativeDirection>
}

function scenePromptRecoveries(value: unknown): Array<{ idempotency_key: string; scene_ids?: string[] }> {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Saved Scene Plan prompt recovery evidence is invalid. No paid request was submitted.')
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Saved Scene Plan prompt recovery evidence is invalid. No paid request was submitted.')
    }
    const record = entry as Record<string, unknown>
    // `scene_ids` is absent when a saved child's scope is unknown (its request preview was pruned):
    // the run then collects whatever the answer covers among the scenes still missing.
    if (Object.keys(record).some(key => key !== 'idempotency_key' && key !== 'scene_ids')
      || typeof record.idempotency_key !== 'string' || !record.idempotency_key.trim()
      || (record.scene_ids !== undefined && (!Array.isArray(record.scene_ids) || !record.scene_ids.length
        || record.scene_ids.some(id => typeof id !== 'string' || !id.trim())
        || new Set(record.scene_ids).size !== record.scene_ids.length))) {
      throw new Error('Saved Scene Plan prompt recovery evidence is invalid. No paid request was submitted.')
    }
    return {
      idempotency_key: record.idempotency_key.trim(),
      ...(record.scene_ids ? { scene_ids: [...record.scene_ids] as string[] } : {}),
    }
  })
}

/**
 * `requestKey` scopes provider evidence to THIS pack's request. Without it, one
 * pack still running at the Gateway made every later pack's ordinary, settled
 * failure look unresolved, so none of them was repaired.
 */
export function scenePromptRequestIsUnresolved(
  job: Pick<Job, 'genstudio_jobs' | 'remote_cancellations'>,
  error: unknown,
  requestKey?: string,
): boolean {
  const evidence = requestKey === undefined ? job : {
    ...job,
    genstudio_jobs: (job.genstudio_jobs || []).filter(entry => (
      entry.request_key === requestKey || entry.request?.idempotency_key === requestKey || entry.id === `pending:${requestKey}`
    )),
  }
  return isGenStudioRequestInProgress(error)
    || isGenStudioSubmissionUncertain(error)
    || error instanceof GenStudioChatRecoveryUnresolvedError
    || hasUnsettledProviderEvidence(evidence)
}

interface ScenePromptPack {
  pack_id: string
  scene_ids: string[]
  params: { temperature: number; max_tokens?: number }
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

interface ScenePolicyRequestPlan {
  model_id: string
  context_window_tokens: number
  max_output_tokens: number | null
  visual_max_tokens: number | null
  active_output_budget: number | null
  prompt_pack_size: number
}

export function readScenePolicyRequestPlan(value: unknown): ScenePolicyRequestPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const plan = value as Record<string, unknown>
  if (typeof plan.model_id !== 'string' || !plan.model_id) return null
  if (typeof plan.context_window_tokens !== 'number' || !Number.isSafeInteger(plan.context_window_tokens) || plan.context_window_tokens < 0) return null
  const positiveOrUnpublished = (key: string): number | null | undefined => {
    const raw = plan[key]
    if (raw === null) return null
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 ? raw : undefined
  }
  // Pre-Task2b checkpoints copied the catalogue's unpublished sentinel. Keep
  // compatibility narrowly on that field; zero is invalid for saved budgets.
  const maxOutputTokens = plan.max_output_tokens === 0
    ? null
    : positiveOrUnpublished('max_output_tokens')
  const visualMaxTokens = positiveOrUnpublished('visual_max_tokens')
  const activeOutputBudget = positiveOrUnpublished('active_output_budget')
  const promptPackSize = typeof plan.prompt_pack_size === 'number'
    && Number.isSafeInteger(plan.prompt_pack_size) && plan.prompt_pack_size >= 1
    ? plan.prompt_pack_size : undefined
  if (maxOutputTokens === undefined || visualMaxTokens === undefined || activeOutputBudget === undefined || promptPackSize === undefined) return null
  return {
    model_id: plan.model_id,
    context_window_tokens: plan.context_window_tokens,
    max_output_tokens: maxOutputTokens,
    visual_max_tokens: visualMaxTokens,
    active_output_budget: activeOutputBudget,
    prompt_pack_size: promptPackSize,
  }
}

export type ScenePromptCompletionIssueKind = 'provider-omitted' | 'duplicate-prompt' | 'checkpoint-failed' | 'not-durable'

export interface ScenePromptCompletionIssue {
  scene_id: string
  kind: ScenePromptCompletionIssueKind
  detail: string
}

const MAX_CONSECUTIVE_STALLED_PROMPT_REPAIR_ATTEMPTS = 2

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

/**
 * A repair set of this many scenes or fewer is sent as one request PER SCENE.
 *
 * WHY, MEASURED — 3,544 recorded scene-prompt attempts, structured-validation
 * failure rate by request size (DeepSeek V4 Flash, the worst offender):
 *
 *     1 scene    0.0%   (0 failures in 19 attempts)
 *     2 scenes  86.4%
 *     7 scenes  70.0%
 *    20 scenes  28.0%
 *    40 scenes  17.4%
 *
 * The curve runs BACKWARDS to intuition: small packs fail far more often than
 * large ones, and a single scene never failed at all. Repair is exactly where
 * small packs occur, and repair re-requests are retried against the same
 * deterministic mangling — so one bad remainder becomes a failure loop that
 * burns the whole repair budget without ever landing a prompt.
 *
 * Splitting small repair sets into single-scene requests trades a handful of
 * extra requests for the only size with no recorded failures. Do NOT "optimize"
 * this back into one compact pack: that is the defect, not the saving.
 */
export const MAX_SCENES_PER_SMALL_REPAIR_PACK = 7

/** Pack size to use for a repair request covering `missingCount` scenes: one
 * scene per request while the set is small (see the measured rates above),
 * otherwise the caller's normal batching. */
export function scenePromptRepairPackSize(missingCount: number, packSize: number): number {
  return missingCount <= MAX_SCENES_PER_SMALL_REPAIR_PACK ? 1 : packSize
}

/** Keep existing pack replay identities byte-stable. Only the new explicit
 * grouped mode opts into a scene suffix. */
export function scenePromptRequestLabel(base: string, sceneIds: readonly string[], appendSceneIds: boolean): string {
  return appendSceneIds ? `${base}:${sceneIds.join(',')}` : base
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
    throw new Error('Add a Gateway API Key in Settings → This Mac before generating scene prompts.')
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
  assertModelCanHoldAJsonContract(model)
  return model
}

async function getScenePlanPolicyPlanningModel(policy: NonNullable<ReturnType<typeof pipelinePolicyForJob>>): Promise<GenStudioChatModel> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) throw new Error('Add a Gateway API Key in Settings → This Mac before generating scene prompts.')
  const catalog = await listGenStudioChatModels(apiKey)
  const candidates = [policy.assigned_model, ...policy.models.filter(model => model !== policy.assigned_model)]
  for (const candidateId of candidates) {
    const candidate = catalog.find(model => model.id === candidateId && model.available)
    if (!candidate) continue
    try {
      assertModelCanHoldAJsonContract(candidate)
      return candidate
    } catch (error) {
      if (!(error instanceof GenStudioChatCapabilityUnavailableError)) throw error
    }
  }
  throw new Error('None of the selected Pipeline Scene Plan products currently publishes structured-output support. No request or credit charge was made.')
}

/**
 * v1.4.37 — refuse a model that cannot be HELD to a JSON contract, before a
 * single request is paid for.
 *
 * WHAT THIS COST BEFORE IT EXISTED. On 2026-08-23 four Scene Plan batches ran
 * on a product publishing `structured_output_mode: none`.
 * GenStudio cannot force such a model to return JSON — it can only ask in the
 * prompt and reject what comes back — so the model complied for two packs of
 * forty scenes and wrote prose for the third. Two episodes failed at exactly
 * 80/111 and 80/113: not a size limit, just where the luck ran out. Each run
 * burned 13 to 30 minutes before saying so, and the automatic repair then asked
 * the SAME model the SAME question twice more, which for a model that cannot do
 * it was never going to work.
 *
 * GenStudio had already diagnosed it precisely — its rejection note reads
 * "another model may answer this contract more reliably" — and Story Studio
 * threw that away, because its own catalogue parser collapsed `'none'` into
 * `'json_object'` and it genuinely could not see the difference.
 *
 * REFUSING RATHER THAN WARNING is deliberate. A model like this works
 * *sometimes*, which is worse than never: it produces half-complete episodes
 * that look like flaky infrastructure rather than a wrong choice. 459 of the
 * 496 products in the catalogue publish `none`, so this is the common case, not
 * an edge one.
 */
export function assertModelCanHoldAJsonContract(model: GenStudioChatModel): void {
  if (model.structured_output_mode !== 'none') return
  const label = model.display_name?.trim() || model.id
  throw new GenStudioChatCapabilityUnavailableError(
    model.id,
    `"${label}" cannot be held to a JSON contract because it publishes no structured-output support. `
      + 'Choose a model that the Gateway publishes structured-output support for and run Scene Plan again. Nothing was charged',
  )
}

/**
 * Exported for its guard test (`__tests__/scene-pack-item-limit.test.ts`), the same
 * way `assertModelCanHoldAJsonContract` is: a refusal nobody can call is a refusal
 * nobody can prove.
 *
 * `itemCount` is the number of scenes the pack asks for. The token budget is checked
 * first and always; the PUBLISHED item limit is the second bound, and only a
 * published one counts (see the comment inside).
 */
export function assertScenePromptPackCapability(model: GenStudioChatModel, maxTokens: number | undefined, itemCount: number): void {
  assertModelCanHoldAJsonContract(model)
  if (maxTokens !== undefined && Number.isInteger(model.max_output_tokens) && model.max_output_tokens >= 1 && model.max_output_tokens < maxTokens) {
    throw new GenStudioChatCapabilityUnavailableError(
      model.id,
      `this ${itemCount}-scene pack requires ${maxTokens.toLocaleString()} output tokens, above its published ${model.max_output_tokens.toLocaleString()} limit`,
    )
  }
  // AN UNPUBLISHED ITEM LIMIT IS NOT A LIMIT OF ZERO (fixed 2026-09-26, owner
  // ruling: we follow what a model publishes and invent no ceiling of our own).
  // This used to refuse whenever `max_structured_items_per_request` was null —
  // which is what every row publishes today, including the local lane — so an
  // absent number decided a 30-scene pack could not even be attempted, and the
  // refusal read "above its published unpublished item limit". Contextual Cues
  // was fixed this way in v1.4.224 (`assertContextualCueCapability`); this is the
  // other half of that same fix, and it is the half the 30-scene pack runs
  // through. Only a PUBLISHED limit can refuse now: the token budget checked
  // above still bounds the pack, and a provider refusal is the answer if the
  // lane disagrees.
  const published = model.max_structured_items_per_request
  const structuredItemLimit = typeof published === 'number' && Number.isInteger(published) && published > 0
    ? published
    : null
  if (structuredItemLimit === null) return
  if (structuredItemLimit < itemCount) {
    throw new GenStudioChatCapabilityUnavailableError(
      model.id,
      `this ${itemCount}-scene pack requires ${itemCount} structured items, above its published item limit of ${structuredItemLimit}`,
    )
  }
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
 * Story Studio correctly refused to accept.
 *
 * `responseReceived` IS REQUIRED, AND THAT IS THE POINT.
 *
 * Every issue this function can return is an accusation about the CONTENT of a
 * response — a scene the model skipped, a prompt it repeated, a row that would
 * not save. None of them can be true when no response ever arrived. On
 * 2026-08-28 a GenStudio call died at the provider-identity gate before any
 * content existed, this function was still called with an empty result map, and
 * all fifty scenes were labelled "provider omitted the scene ID from its
 * response" — then those fifty fabrications were fed into the repair prompt as
 * fact, so every paid retry opened by accusing the model of dropping IDs it had
 * never been asked for. A caller must therefore say, in as many words, whether a
 * response came back; when it did not, there is nothing to diagnose. */
export function diagnoseScenePromptCompletionIssues(input: {
  plan: Pick<ScenePlan, 'scenes'>
  requestedIds: readonly string[]
  missingIds: readonly string[]
  providerResults: ReadonlyMap<string, string>
  checkpointErrors?: readonly string[]
  /** False when the request failed before any response content arrived. */
  responseReceived: boolean
}): ScenePromptCompletionIssue[] {
  if (!input.responseReceived) return []
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

/** Retrying cannot add cues; the message names the button that can. */
export function subtitleCoverageGapError(gap: { gap_sec: number; previous_end_sec: number; next_start_sec: number; section_slugs: string[] }): Error {
  const section = gap.section_slugs.length
    ? ` in ${gap.section_slugs.join(' / ')}`
    : ' in a section that could not be mapped'
  const slug = gap.section_slugs[0]
  return nonRetryable(new Error(
    `Subtitle coverage gap: ${gap.gap_sec.toFixed(1)}s without subtitle cues${section}, ` +
    `from ${gap.previous_end_sec.toFixed(1)}s to ${gap.next_start_sec.toFixed(1)}s. ` +
    (slug
      ? `Open Subtitles and press “Re-transcribe ${slug.replaceAll('_', ' ')}” (or “Re-narrate ${subtitleChapterLabel(slug)}” if the narration is silent there), then press Retry on this job. `
      : 'Open Subtitles, press “Re-transcribe” on the chapter it lists (or “Re-narrate” if the narration is silent there), then press Retry on this job. ') +
    'Retrying before that stops here again.',
  ))
}

/**
 * 1.4.300 "No caption gap over 30 seconds" (Off/Warn): the scenes either side of a gap cover it (each
 * scene starts where the one before ends). Block returns false and the caller stops as before.
 */
async function captionGapCarriesOn(job: Job, gaps: SubtitleCueGap[]): Promise<boolean> {
  if (!gaps.length) return true
  const where = gaps.map(gap => `${gap.gap_sec.toFixed(1)}s from ${gap.previous_end_sec.toFixed(1)}s`
    + (gap.section_slugs.length ? ` in ${gap.section_slugs.join(' / ')}` : '')).join('; ')
  return safetyCarriesOn(job, 'caption_gap',
    `The captions have ${gaps.length === 1 ? 'a gap' : `${gaps.length} gaps`} over 30 seconds (${where}). The scenes either side cover it.`)
}

/** A continuation problem that re-aligning the plan to today's captions fixes (1.4.296). */
function realignable(message: string): Error {
  return Object.assign(new Error(message), { realign: true })
}

function scenePlanContinuationError(error: unknown): Error {
  return new Error(
    `Cannot safely continue Scene Plan: ${error instanceof Error ? error.message : String(error)}. `
    + 'The existing plan was kept. Resolve the input issue, then explicitly Rebuild timeline in Scene Plan (or use Pipeline Force) before retrying.',
  )
}

/** Unknown filesystem state is not permission to replace reviewed work. */
async function scenePlanFileExists(filePath: string): Promise<boolean> {
  try {
    const entry = await fs.stat(filePath)
    if (!entry.isFile()) throw new Error(`the saved plan is not a regular file: ${filePath}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

export async function runScenePlanJob(job: Job): Promise<void> {
  const params = job.params as ScenePlanRunParams
  const { episode_id } = params
  const scenePolicy = pipelinePolicyForJob(params, 'scene_plan')
  const sceneCheckpoint = pipelinePolicyCheckpointStore(params, () => checkpointJobState(job))
  const scenePlanPolicyCall: typeof callAi | undefined = scenePolicy
    ? async (...args: Parameters<typeof callAi>) => {
      const [, system, user, apiKeys, stream = false, context = {}] = args
      const requestIdentity = context.requestIdentity
        || `${job.project_slug}:${episode_id || 'episode'}:scene-plan:${pipelinePolicyInputFingerprint({
          system,
          user,
          outputBudget: context.outputBudget,
          maxTokens: context.maxTokens,
          outputContract: context.outputContract,
          images: context.images,
        })}`
      return callAiWithModelPolicy(scenePolicy, system, user, apiKeys, stream, {
        ...context,
        slug: context.slug || job.project_slug,
        requestIdentity,
        pipelinePolicyCheckpoint: sceneCheckpoint,
        pipelinePolicyCheckpointKey: requestIdentity,
        onModelSelected: async selected => {
          await context.onModelSelected?.(selected)
          job.output_lines.push(`[pipeline] scene plan using Gateway product "${selected}".`)
        },
      })
    }
    : undefined
  let model = params.model || ''
  if (scenePolicy) model = scenePolicy.assigned_model
  if (!episode_id) throw new Error('episode_id is required')
  const packedRepairStage: 'visual' | 'motion' | undefined = params.regenerate_empty_motion_prompts
    ? 'motion'
    : params.regenerate_empty_prompts
      ? 'visual'
      : undefined
  const requestedStage = packedRepairStage || params.stage
  // Only an explicitly requested timeline-only run is model-free. A Pipeline
  // run omits `stage`, which means a compatible timeline + required visual
  // prompts. A partial saved plan is continued after compatibility checks.
  const needsModel = requestedStage !== 'timeline' || !!(
    params.regenerate_prompt_scene_id || params.regenerate_prompt_scene_ids?.length || params.regenerate_empty_prompts
    || params.regenerate_motion_prompt_scene_id || params.regenerate_empty_motion_prompts
    || params.replan_scene_id
  )
  if (!model && needsModel) throw new Error('model is required')
  if (!model) model = 'deterministic-timeline'
  // A retry keeps the shape of the requests it already prepared. These are
  // historical job inputs, not a cached catalogue: every NEW policy attempt
  // still validates its actual product below. Saved-key lookups need no live
  // model just to recover output that GenStudio already accepted.
  const rawRequestPlan = scenePolicy ? params.pipeline_scene_request_plan : undefined
  const savedRequestPlan = readScenePolicyRequestPlan(rawRequestPlan)
  if (rawRequestPlan && (!savedRequestPlan || !scenePolicy!.models.includes(savedRequestPlan.model_id))) {
    throw new Error('The saved Scene Plan request shape is invalid; no new request was submitted.')
  }
  const promptModel = savedRequestPlan
    ? { id: savedRequestPlan.model_id, context_window_tokens: savedRequestPlan.context_window_tokens, max_output_tokens: savedRequestPlan.max_output_tokens }
    : needsModel ? (scenePolicy
      ? await getScenePlanPolicyPlanningModel(scenePolicy)
      : await getScenePlanGenStudioModel(model)) : null
  if (promptModel) model = `genstudio-chat:${promptModel.id}`

  const promptTokenSetting = parseScenePromptTokenSetting(params.prompt_max_tokens)
  // A timeline-only run is deliberately model-free, so the model-derived
  // resolver must not be asked for a product allowance it does not have: it
  // would either invent one (the retired 8,192 fallback) or refuse a run that is
  // perfectly valid. `SCENE_TIMELINE_ONLY_OUTPUT_BUDGET` is Story Studio's own
  // local budget and is never displayed as a model's figure — the line that
  // prints the token arithmetic is guarded by `!timelineOnly`.
  const visualMaxTokens = savedRequestPlan
    ? savedRequestPlan.visual_max_tokens
    : (promptModel
      ? resolveScenePromptTokenBudget(promptModel.max_output_tokens, promptTokenSetting)
      : SCENE_TIMELINE_ONLY_OUTPUT_BUDGET)
  // NO stage-specific cap of ours (removed 2026-09-26, owner ruling: we follow
  // the published per-model figure and invent no ceiling). The motion stage used
  // to clamp this to 4,096 "so a large visual-model allowance could not create
  // truncated motion JSON" — but the value it clamped IS the model's published
  // allowance, and this budget drives the wire field, the batch size and the
  // job-log arithmetic, so a 16,384-token model was asked for 4,096 and then
  // described in the log as a 4,096-token model. The batch is already bounded
  // from the published figure by `resolveScenePromptPackSize`
  // (16,384 × 0.75 ÷ 300 ≈ 40 motion scenes per call), which is the protection
  // the old cap was reaching for — derived instead of declared.
  const activePromptOutputBudget = savedRequestPlan
    ? savedRequestPlan.active_output_budget
    : visualMaxTokens
  const promptPackSetting = parseScenePromptPackSetting(params.prompt_pack_size)
  let promptPackTuning = parseScenePromptPackTuning(undefined)
  try { promptPackTuning = parseScenePromptPackTuning(await getConfig(job.project_slug)) } catch { /* defaults apply */ }
  const promptPackSize = savedRequestPlan?.prompt_pack_size
    ?? resolveScenePromptPackSize(activePromptOutputBudget, promptPackSetting, promptPackTuning)
  if (scenePolicy && promptModel && !savedRequestPlan) {
    params.pipeline_scene_request_plan = {
      model_id: promptModel.id,
      context_window_tokens: promptModel.context_window_tokens,
      max_output_tokens: typeof promptModel.max_output_tokens === 'number'
        && Number.isSafeInteger(promptModel.max_output_tokens) && promptModel.max_output_tokens >= 1
        ? promptModel.max_output_tokens : null,
      visual_max_tokens: visualMaxTokens,
      active_output_budget: activePromptOutputBudget,
      prompt_pack_size: promptPackSize,
    }
    await checkpointJobState(job)
  }
  // A published image-model figure or nothing. No default is invented here.
  // Legacy jobs carry this number instead of a selection; see promptBudget().
  const legacyPromptCharCap = parsePromptCharCap(params.prompt_char_cap)

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)

  /** The ceiling in force and where it came from. */
  interface ResolvedPromptCap {
    cap?: number
    /** The model's published figure, when the live catalogue supplied one. */
    publishedCap?: number
    source: PromptCharCapSource
  }
  interface ScenePromptBudget extends ResolvedPromptCap {
    /** Everything added on top of the writer's output (render + style lead). */
    reserved: AssemblyOverhead
    /** The ceiling for the text the writer produces. */
    bodyCeiling?: number
    /** The ceiling for the saved prompt body, which includes the style lead. */
    storedBodyCeiling?: number
    styleLeadCharacters: number
  }

  let promptCapPromise: Promise<ResolvedPromptCap> | undefined
  /**
   * Resolve the ceiling LIVE when this job carries a selection. A job accepted
   * by 1.4.348 or earlier carries only a number: that allowance is kept exactly
   * (never re-resolved, never described as a published figure). Timeline-only
   * runs never call this, so they never reach the image catalogue.
   */
  const resolvePromptCap = (): Promise<ResolvedPromptCap> => {
    if (!promptCapPromise) {
      promptCapPromise = (async () => {
        if (params.prompt_char_cap_selection === undefined) {
          return { cap: legacyPromptCharCap, publishedCap: undefined, source: 'saved' as const }
        }
        const live = await requireLiveImagePromptCharCapDetail({
          intendedImageModel: params.intended_image_model,
          setting: params.prompt_char_cap_selection,
          label: 'The Scene Plan selection',
          nothingHappened: 'No prompts were written.',
        })
        const source: PromptCharCapSource = live.cap !== undefined
          && live.publishedCap !== undefined
          && live.cap === live.publishedCap
          ? 'model'
          : 'chosen'
        return { cap: live.cap, publishedCap: live.publishedCap, source }
      })()
    }
    return promptCapPromise
  }

  let renderOverheadPromise: Promise<AssemblyOverhead> | undefined
  /**
   * Exactly what the scene renderer appends, measured with the SAME composition
   * it submits (services/scene-prompt-assembly.ts). Reserved for every project:
   * `generators/continuity-render.ts` is the only scene-image renderer and it
   * appends these layers regardless of the format's visualSource.
   *
   * The character layer is always included, even for a scene whose type drops
   * it: the writer's budget is one number for every scene in a pack, so it must
   * leave room for the LARGEST assembly the render can produce.
   */
  const renderAssemblyOverhead = (): Promise<AssemblyOverhead> => {
    if (!renderOverheadPromise) {
      renderOverheadPromise = (async () => {
        const assembly = await readSceneRenderAssembly(job.project_slug, paths.episode_dir)
        return measureAssemblyOverhead(sceneRenderAssemblyParts(assembly.characters, assembly.styleBible, true))
      })()
    }
    return renderOverheadPromise
  }

  /**
   * The body budget handed to the writer. `writerStyle` is the exact style text
   * the writer prepends as a lead (`planScenes` / `generateVisualPromptOnly`);
   * omit it where nothing is prepended (the packed repair writer).
   *
   * A ceiling the assembly alone already exceeds is REFUSED here, typed and
   * deterministic, before any scene is written — never handed a one-character
   * body and never caught by a per-scene handler.
   */
  const promptBudget = async (writerStyle?: string): Promise<ScenePromptBudget> => {
    const cap = await resolvePromptCap()
    const render = await renderAssemblyOverhead()
    const styleLeadCharacters = styleLeadOverhead(writerStyle)
    const reserved = addAssemblyOverhead(render, assemblyOverheadOf('style lead', styleLeadCharacters))
    const addedBy = styleLeadCharacters > 0
      ? 'the style lead this writer prepends and the Style Bible and character text the render appends'
      : 'the Style Bible and character text the render appends'
    // The refusal names the pieces a Scene Plan prompt really needs — not the
    // thumbnail clauses — and says what to do about them.
    const refusalDetail = (limit: number, overhead: number): string =>
      `The image model accepts up to ${limit.toLocaleString()} prompt characters, and ${addedBy} already use `
      + `${overhead.toLocaleString()} of them. There is no room for the prompt itself, so no prompt was written and no request was made. `
      + 'Shorten the Style Bible or the anchor character descriptions, or render with a model that publishes a larger limit.'
    const ceilingFor = (overhead: AssemblyOverhead): number | undefined => promptBodyCeiling(cap.cap, overhead, {
      detail: cap.cap === undefined ? undefined : refusalDetail(cap.cap, overhead.characters),
    })
    return {
      ...cap,
      reserved,
      styleLeadCharacters,
      bodyCeiling: ceilingFor(reserved),
      storedBodyCeiling: ceilingFor(render),
    }  }

  /** One honest job line: what the ceiling is, and who chose it. */
  const describePromptCeiling = (cap: ResolvedPromptCap): string => {
    if (!cap.cap) return 'Prompt length ceiling: none — no image-model limit is in force for this run.'
    const source = cap.source === 'model'
      ? 'the selected image model\'s published limit'
      : cap.source === 'saved'
        ? 'the allowance saved with this run, not a live published figure'
        : 'the limit chosen for this run'
    return `Prompt length ceiling: ${cap.cap.toLocaleString()} characters for the assembled prompt (${source}). `
      + 'A ceiling only — prompts stay as short as the scene needs, and an over-length prompt is reported, never shortened.'
  }

  /** What the renderer will add, and the smaller ceiling the writer gets. */
  const describePromptBudget = (budget: ScenePromptBudget): string => {
    if (!budget.cap || budget.bodyCeiling === undefined || budget.reserved.characters === 0) return ''
    const lead = budget.styleLeadCharacters > 0
      ? `, plus ${budget.styleLeadCharacters.toLocaleString()} for the style lead the writer prepends`
      : ''
    return `Prompt assembly: ${budget.reserved.characters.toLocaleString()} characters are added to every prompt — the Style Bible and character text the render appends${lead} — `
      + `so each prompt body is written under ${budget.bodyCeiling.toLocaleString()} characters.`
      + (budget.storedBodyCeiling !== undefined && budget.storedBodyCeiling !== budget.bodyCeiling
        ? ` The saved prompt body may reach ${budget.storedBodyCeiling.toLocaleString()} before the render adds its own text.`
        : '')
  }

  // Resolve inputs.
  //
  // NOT a raw join to `{CODE}_stitched.srt`. The stitched file is Whisper's
  // re-reading of narration we wrote ourselves, so its proper nouns drift
  // (`Neorion` → `Mirion` reached four real image prompts on EP0067) and it
  // hallucinates into silence. `resolveTranscriptSrt` returns the corrected
  // transcript — ASR timings, script words — whenever the script and the audio
  // demonstrably agree, and the untouched original whenever they do not.
  //
  // This single call is why Contextual Cues and the scene visual prompts need
  // no change of their own: both read `transcript_segment` out of
  // scene_plan.json, which is built from these cues.
  // 1.4.300 — before the transcript is read, so the corrected transcript follows a re-stitch.
  await restitchIfBroken(job, {
    subtitlesDir: paths.subtitles_dir, episodeDir: paths.episode_dir, audioDir: paths.audio_dir, mergedAudioDir: paths.merged_audio_dir,
  }, episode_id)
  const transcript = await resolveTranscriptSrt({
    subtitles_dir: paths.subtitles_dir,
    script_dir: paths.script_dir,
    episode_code: episode_id,
  })
  const stitchedSrt = transcript.path
  for (const line of describeTranscriptCorrection(transcript)) job.output_lines.push(line)
  const researchPath = (await resolveResearchPaths(paths.episode_dir, episode_id)).jsonPath
  const useResearch = params.use_research !== false  // default true

  // Resolve draft settings only for new planning. Existing saved plan timestamps
  // remain authoritative during prompt completion and missing-image repairs.
  const usesExistingPlan = requestedStage === 'visual' || requestedStage === 'motion'
    || !!params.regenerate_prompt_scene_id || !!params.regenerate_prompt_scene_ids?.length
    || !!params.regenerate_motion_prompt_scene_id
  let pacing: ScenePlanPacing | undefined
  if (!usesExistingPlan && !params.pacing) {
    pacing = (await resolveScenePlanPacing(job.project_slug, paths.episode_dir)).pacing
  }
  if (params.pacing) {
    const saved = parseScenePacing(params.pacing)
    pacing = { min_sec: saved.min_sec, max_sec: saved.max_sec,
      mode: saved.mode === 'variable' ? 'variable' : 'live',
      ...(saved.mode === 'variable' ? { periods: saved.periods } : {}) }
  }
  // Jobs accepted by older versions have no scope field. Their explicit motion
  // request remains authorized; migrate it once after reading its saved plan.
  const legacyMotionRequest = params.motion_scope === undefined && params.motion_scene_ids === undefined
    && (requestedStage === 'motion' || params.generate_motion_prompts === true)
  let oldMotionLevel: number | undefined
  if (legacyMotionRequest) {
    try { oldMotionLevel = (await getConfig(job.project_slug) as any)?.default_motion_level } catch { /* historical default */ }
  }
  const motionSettings = params.motion_scope !== undefined
    ? { motion_scope: normalizeMotionScope(params.motion_scope), motion_level: params.motion_level ?? 2 }
    : usesExistingPlan && requestedStage !== 'motion'
      ? { motion_scope: { mode: 'off' } as MotionScope, motion_level: 2 }
      : legacyMotionRequest
        ? { motion_scope: { mode: 'all' } as MotionScope, motion_level: resolveMotionLevel(params.motion_level, oldMotionLevel) }
        : await readEpisodeMotionScope(job.project_slug, episode_id, paths.episode_dir)
  const motionScope = normalizeMotionScope(params.motion_scope ?? motionSettings.motion_scope)
  const episodeMotionLevel = params.motion_level ?? motionSettings.motion_level
  const planPacing: ScenePacing = pacing?.periods
    ? { mode: 'variable', min_sec: pacing.min_sec, max_sec: pacing.max_sec, periods: pacing.periods }
    : { min_sec: pacing?.min_sec ?? DEFAULT_SCENE_PACING.min_sec, max_sec: pacing?.max_sec ?? DEFAULT_SCENE_PACING.max_sec }

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

  // v1.0.794 — SCENE prompts only (thumbnails never read this). Per-run
  // override; else the project default, which is ON unless explicitly turned
  // off (see resolveAvoidLegibleText in lib/image-content-guidance.ts).
  let projectAvoidLegibleTextDefault: boolean | undefined
  try { projectAvoidLegibleTextDefault = (await getConfig(job.project_slug) as any)?.avoid_legible_text_in_scenes } catch { /* default applies */ }
  const wantAvoidLegibleText = resolveAvoidLegibleText(params.avoid_legible_text, projectAvoidLegibleTextDefault)

  const timelineOnly = params.stage === 'timeline'
  // A motion-only run writes camera prompts, never image prompts. It must not
  // reach the image catalogue either: nothing it writes is character-capped.
  const motionOnly = requestedStage === 'motion'
    || !!params.regenerate_motion_prompt_scene_id
    || params.regenerate_empty_motion_prompts === true
  const visualPromptWriting = !timelineOnly && !motionOnly
  if (timelineOnly) job.output_lines.push('Timeline engine: deterministic (no LLM)')
  else job.output_lines.push(`Prompt model: ${model}`)
  job.output_lines.push(`Stitched SRT: ${stitchedSrt}`)
  if (!timelineOnly && useResearch) job.output_lines.push(`Research context: ${researchPath}`)
  if (pacing) {
    job.output_lines.push(pacing.periods
      ? `Variable pacing: ${pacing.periods.length} periods on the narration timeline.`
      : pacing.mode === 'documentary'
      ? `Documentary pacing: first ${Math.round((pacing.opening_duration_sec || 0) / 60)} min ${pacing.min_sec}–${pacing.max_sec}s, then ${pacing.settled_min_sec}–${pacing.settled_max_sec}s ambient holds.`
      : `Continuity pacing: ${pacing.min_sec}–${pacing.max_sec}s (live, denser on busy passages)`)
  }
  if (!timelineOnly) {
    job.output_lines.push('Visual detail: Full detail (110–150 words per scene)')
    // Shows the arithmetic, and says out loud when an explicitly requested
    // batch had to be reduced to what the chosen model can return complete.
    // An explicit number is never quietly replaced with a different one.
    job.output_lines.push(
      `Prompt batching: ${describeScenePromptPackSize(activePromptOutputBudget, promptPackSetting, promptPackTuning)}`,
    )
    job.output_lines.push(describePromptCeiling(visualPromptWriting
      ? await resolvePromptCap()
      // Nothing here was read live, so the numeric receipt on the job is
      // presented as exactly that — a saved allowance.
      : { cap: legacyPromptCharCap, publishedCap: undefined, source: 'saved' }))
    if (params.style_prompt) job.output_lines.push(`Style: ${params.style_prompt.slice(0, 120)}${params.style_prompt.length > 120 ? '…' : ''}`)
    if (params.custom_instructions) job.output_lines.push(`Custom instructions: ${params.custom_instructions.slice(0, 120)}${params.custom_instructions.length > 120 ? '…' : ''}`)
    job.output_lines.push(wantAvoidLegibleText
      ? 'Text in images: avoiding legible lettering — scrolls/signs/pages render as texture, not readable words.'
      : 'Text in images: off — this run may write specific readable words into scene prompts.')
  }
  job.progress = 10

  // v1.0.467 — scene_plan.json lives in the "03 Scene Prompts" folder now
  // (with a legacy episode-root fallback for older episodes). One resolved
  // path drives every read + in-place rewrite below, so they all stay in sync.
  const isSingleSceneRepair = !!(
    params.regenerate_prompt_scene_id
    || params.regenerate_prompt_scene_ids?.length
    || params.regenerate_motion_prompt_scene_id
    || params.replan_scene_id
  )
  const ordinaryContinuation = requestedStage == null && !isSingleSceneRepair && params.force !== true
  let outPath: string
  let continueExistingPlan = false
  const continuationCandidates: string[] = []
  if (ordinaryContinuation) {
    try {
      // The shared reader tolerates I/O failures for legacy lookup. A writer
      // must distinguish absent from inaccessible at BOTH possible locations.
      const names = await resolveSubfolderNames(job.project_slug, episode_id)
      const directory = await findSubfolder(paths.episode_dir, names.scene_prompts, { strictIo: true })
        || paths.scene_prompts_dir
      outPath = path.join(directory, SCENE_PLAN_FILENAME)
      continuationCandidates.push(outPath, path.join(paths.episode_dir, SCENE_PLAN_FILENAME))
      for (const candidate of continuationCandidates) {
        if (await withLock(candidate, () => scenePlanFileExists(candidate))) {
          outPath = candidate
          continueExistingPlan = true
          break
        }
      }
    } catch (error) {
      throw scenePlanContinuationError(error)
    }
  } else {
    outPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  }

  // ── Staged continuity workflow ──────────────────────────────────────────
  // Timeline creation is deterministic and free. Visual and optional motion
  // prompts are durable adaptive Hub packs keyed by stable scene IDs, with direct generation as
  // a connection-only fallback. This branch is intentionally before all legacy
  // re-plan modes so those remain available for repairing old plans.
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id, { episodeDir: paths.episode_dir, audioDir: paths.audio_dir }, job)
  if (requestedStage || !isSingleSceneRepair) {
    const pipelineAutoVisual = requestedStage == null && !isSingleSceneRepair
    // Ordinary Pipeline continuation owns the missing prompts, not permission
    // to replace reviewed scene state. Only an absent plan or explicit rebuild
    // creates a timing shell. Validate reuse under the same lock as its read.
    let stage: 'timeline' | 'visual' | 'motion' = requestedStage || (continueExistingPlan ? 'visual' : 'timeline')
    if (stage === 'timeline') {
      const srtText = await fs.readFile(stitchedSrt, 'utf-8')
      const allCues = parseSrt(srtText)
      if (!allCues.length) throw new Error('The stitched subtitle timeline has no cues.')
      // ── The reserved opening is MEASURED, never remembered (v1.3.1) ──────
      //
      // Whatever Video Assembly will play before the first scene is probed
      // here and reserved exactly. `measureOpeningSec` is the SAME function
      // the renderer uses for `preSceneDuration`, over the same four head
      // buckets, so plan time and render time cannot answer this differently:
      // v1.2.7's `sceneTimelineOffsetSec` comes out at 0 and every scene's
      // picture sits under the narration it was planned against.
      //
      // Before this, three remembered copies of "how long is the opening"
      // disagreed — a preset saying `from-start` + 15s, a project config
      // saying `branded-opening` + 10s, and a 10.0s file on disk. The file is
      // the only one that was ever a fact, so it is now the only one asked.
      // No intro → 0 reserved, and nothing moves.
      const { head: openingHead, unresolved: openingUnresolved } =
        await resolveProjectOpening(job.project_slug)
      const openingReserved = await measureOpeningSec(openingHead, getAudioDuration)
      const openingMode: 'branded-opening' | 'from-start' =
        openingReserved > 0 ? 'branded-opening' : 'from-start'
      if (openingReserved > 0) {
        const breakdown = await describeOpeningHead(openingHead, getAudioDuration)
        job.output_lines.push(
          `Opening measured from your Video Assembly clips: ${breakdown} = ${openingReserved.toFixed(2)}s reserved. `
          + 'Scene 1 starts there, so the composed video puts every scene on the narration it was planned against.',
        )
      } else {
        job.output_lines.push('Opening measured from your Video Assembly clips: none — scenes start at the first second.')
      }
      if (openingUnresolved.length) {
        job.output_lines.push(
          `⚠ Not counted in the opening because this Mac cannot play them right now: ${openingUnresolved.join(', ')}. `
          + 'Fix them and re-create the timeline, or the render will start the scenes late.',
        )
      }
      const cues = allCues.filter(c => c.end_sec > openingReserved + 0.001)
      if (!cues.length) throw new Error(`The ${openingReserved.toFixed(1)}s opening covers the entire subtitle timeline.`)
      const { splitScenesDeterministically } = await import('../services/scene-planner.js')
      const minSec = pacing?.min_sec ?? DEFAULT_SCENE_PACING.min_sec
      const maxSec = pacing?.max_sec ?? DEFAULT_SCENE_PACING.max_sec
      const subtitleIntegrity = await readSubtitleTimelineIntegrity(paths.subtitles_dir, episode_id, {
        max_cue_gap_sec: allowedSubtitleCueGapSec(),
        cue_source_path: stitchedSrt,
      })
      const suspiciousGap = subtitleIntegrity.blocking_cue_gaps?.[0]
      if (suspiciousGap && !await captionGapCarriesOn(job, subtitleIntegrity.blocking_cue_gaps!)) {
        job.result = {
          ...(job.result || {}),
          attention: {
            kind: 'subtitle_coverage_gap',
            workspace: 'subtitles',
            episode_id,
            gaps: subtitleIntegrity.blocking_cue_gaps,
          },
        }
        throw subtitleCoverageGapError(suspiciousGap)
      }
      // Cue gaps were decided just above; `complete` also counts them.
      if (subtitleIntegrity.missing_sections.length) {
        throw new Error(
          'Subtitle timeline verification no longer matches the stitched file. ' +
          'Open Subtitles, re-stitch, and recheck before creating the Scene Plan.',
        )
      }
      const splitScenes = splitScenesDeterministically({
        cues,
        min_sec: minSec,
        max_sec: maxSec,
        target_sec: (minSec + maxSec) / 2,
        pacing_periods: pacing?.periods,
        initial_start_sec: openingReserved,
        idGen: i => `${episode_id.toLowerCase()}-scene-${String(i + 1).padStart(4, '0')}`,
      })
      const timelineCleanup = removeNonRenderableScenes(splitScenes)
      const scenes = timelineCleanup.scenes
      let totalDuration = allCues[allCues.length - 1]!.end_sec
      let mergedAudioSec = 0
      try {
        const assets = await scanEpisodeAssets(job.project_slug, episode_id)
        const mergedEntry = assets?.merged_audio?.[0]
        const merged = mergedEntry?.path
        if (merged && existsSync(merged)) {
          // The plan times the NARRATION. A merged master that carries a closing
          // music tail is longer than the speech, and planning scenes across the
          // music would leave the renderer no picture to hold when the words end.
          mergedAudioSec = narrationSecFromMaster(
            (await getAudioDuration(merged)) || 0,
            mergedEntry?.closing_tail_sec || 0,
          )
          if (mergedAudioSec > totalDuration) totalDuration = mergedAudioSec
        }
      } catch { /* stitched SRT duration remains the safe fallback */ }
      if (scenes.length) scenes[scenes.length - 1]!.end_sec = totalDuration
      if (characterDensity != null) assignDensityToUntagged(scenes, characterDensity)
      const builtAt = new Date().toISOString()
      const plan: ScenePlan = {
        schema_version: 1,
        generated_at: builtAt,
        timeline_built_at: builtAt,
        pacing: structuredClone(planPacing),
        planner_model: model,
        source_stitched_srt: path.basename(stitchedSrt),
        // v1.4.0 — record WHICH timeline, not just which file. See the field's
        // doc in models/types.ts: the filename is unchanged by a re-stitch, so
        // it cannot show that this plan's scene times are now out of date.
        source_timeline: stampFromCues(allCues),
        // 1.4.276 — and WHICH merged narration: a re-narrated chapter re-merges
        // the audio without necessarily re-stitching the captions (DL0004).
        ...(mergedAudioSec > 0 ? { source_merged_audio: { duration_sec: Math.round(mergedAudioSec * 1000) / 1000 } } : {}),
        total_duration_sec: totalDuration,
        research_used: useResearch && existsSync(researchPath),
        scenes,
        planned_in_windows: 0,
        planning_stage: 'timeline',
        opening_mode: openingMode,
        opening_reserved_sec: openingReserved,
        // Marks this reserve as probed from real assets rather than typed by a
        // person. The renderer reads it to know it may play the opening clips
        // as they are instead of stretching the intro to fill a remembered
        // number. Absent on every plan built before v1.3.1, and those plans
        // keep their old render path exactly.
        opening_source: 'measured',
      }
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      // A deliberate whole-file REPLACEMENT, not a read-modify-write — but still
      // locked, so a concurrent read-modify-write cannot interleave and write the
      // old timeline back over the new one.
      await withLock(outPath, async () => {
        if (ordinaryContinuation) {
          try {
            for (const candidate of continuationCandidates) {
              if (await scenePlanFileExists(candidate)) {
                throw new Error('a saved plan appeared while planning; Retry to continue it without replacing reviewed work')
              }
            }
          } catch (error) {
            throw scenePlanContinuationError(error)
          }
        }
        await writeJsonAtomic(outPath, plan, { compact: true })
      })
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

    if (!ordinaryContinuation && !existsSync(outPath)) throw new Error('Create the scene timeline first.')
    const isMotion = stage === 'motion'
    // ── Read + the whole-plan rewrites that follow it are ONE locked unit ──
    //
    // This block reads the plan once and then writes the WHOLE document back
    // up to three times. Split across the lock boundary, each of those writes
    // republishes this snapshot over anything a concurrent writer committed in
    // between — a Scene Review approval, a rendered image's checkpoint, Prompt
    // Director. `writeJsonAtomic` cannot prevent that: it only guarantees no
    // reader sees half a file, while the loss here is a complete, valid document
    // that is simply missing someone else's field.
    //
    // Continuation checks and opening probes precede any mutation inside this
    // lock. Every prompt written afterwards uses `checkpointScenePrompt`.
    // 1.4.296 — drift a re-alignment can absorb is healed, not refused: the read below throws a
    // `realign` error once, the plan is re-aligned to today's captions, and the read runs again.
    let realigned = false
    const readPlan = () => withLock(outPath, async () => {
      let plan: ScenePlan
      try {
        plan = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
        if (continueExistingPlan) {
          const cues = parseSrt(await fs.readFile(stitchedSrt, 'utf-8'))
          const integrity = await readSubtitleTimelineIntegrity(paths.subtitles_dir, episode_id, {
            max_cue_gap_sec: allowedSubtitleCueGapSec(), cue_source_path: stitchedSrt,
          })
          if (integrity.missing_sections.length || !cues.length
            || !await captionGapCarriesOn(job, integrity.blocking_cue_gaps || [])) {
            throw new Error('the current subtitle timeline cannot be verified')
          }
          const stored = plan?.source_timeline
          // compareTimeline intentionally treats an absent legacy stamp as
          // advisory unknown. Automatic continuation requires positive proof;
          // never attach today's stamp to a plan whose origin is unknown.
          if (!stored || typeof stored.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(stored.sha256)
            || !Number.isInteger(stored.total_cues) || stored.total_cues < 1
            || !Number.isFinite(stored.first_cue_start_sec) || !Number.isFinite(stored.last_cue_end_sec)) {
            throw realignable('the saved plan has no verifiable subtitle timeline stamp')
          }
          const current = stampFromCues(cues)
          // ONE predicate for "does this plan still describe the narration" — the
          // same either-representation rule the recovery plan and the render
          // advisory use (`comparePlanStamp`). Scene Plan is built from the
          // corrected transcript, but a plan built while the correction was absent
          // or refused records the RAW stitch as its timeline; read against the
          // corrected file alone it looks moved, and every scene's timing was
          // re-anchored on a timeline that had not shifted (Domnak DM0012/13/14).
          const rawStitchedPath = stitchedSrtPath(paths.subtitles_dir, episode_id)
          const raw = rawStitchedPath === stitchedSrt
            ? current
            : await fs.readFile(rawStitchedPath, 'utf-8')
              .then(text => stampFromCues(parseSrt(text)))
              .catch(() => null)
          const drift = comparePlanStamp(stored, current, raw)
          if (drift.stale) throw realignable(drift.reason)
          if (plan.source_merged_audio) {
            const merged = (await scanEpisodeAssets(job.project_slug, episode_id)).merged_audio?.[0]
            // Narration length, not file length: the closing music tail a merge
            // baked in is not part of what the plan's scene times describe.
            const mergedNarrationSec = narrationSecFromMaster(merged?.duration || 0, merged?.closing_tail_sec || 0)
            const audioDrift = compareMergedAudio(plan.source_merged_audio, mergedNarrationSec,
              scenePlanLeadInShiftSec(plan.scenes || [], merged?.opening?.lead_in_sec, mergedNarrationSec))
            if (audioDrift.stale) throw realignable(audioDrift.reason)
          }
          // 1.4.300 "Saved Scene Plan can safely continue" (Off/Warn): a plan with no pacing snapshot
          // adopts today's pacing; a changed rhythm or opening keeps the plan's own and carries on.
          const continues = (problem: string) => safetyCarriesOn(job, 'plan_can_continue', `The saved Scene Plan: ${problem}.`)
          if (plan.pacing === undefined) {
            const problem = 'the saved plan has no pacing snapshot'
            if (!await continues(`${problem}; it adopts this episode's current pacing`)) throw new Error(problem)
            plan.pacing = structuredClone(planPacing)
            await writeJsonAtomic(outPath, plan, { compact: true })
          }
          const savedPacing = parseSavedScenePlanPacing(plan.pacing)
          if (savedPacing.min_sec !== planPacing.min_sec || savedPacing.max_sec !== planPacing.max_sec
            || !isDeepStrictEqual(
              savedPacing.mode === 'variable' ? savedPacing.periods : undefined,
              planPacing.mode === 'variable' ? planPacing.periods : undefined,
            )) {
            const problem = 'the saved plan pacing differs from this episode’s selected rhythm'
            if (!await continues(`${problem}; it keeps its own rhythm`)) throw new Error(problem)
          }
          const opening = await resolveProjectOpening(job.project_slug)
          if (opening.unresolved.length) {
            const problem = `opening assets are unavailable: ${opening.unresolved.join(', ')}`
            if (!await continues(`${problem}; it keeps its own opening`)) throw new Error(problem)
          } else {
            const openingSec = await measureOpeningSec(opening.head, getAudioDuration)
            if (plan.opening_source !== 'measured' || !Number.isFinite(plan.opening_reserved_sec)
              || Math.round(plan.opening_reserved_sec! * 1000) !== Math.round(openingSec * 1000)
              || plan.opening_mode !== (openingSec > 0 ? 'branded-opening' : 'from-start')) {
              const problem = 'the saved plan opening does not match the current measured opening'
              if (!await continues(`${problem}; it keeps its own opening`)) throw new Error(problem)
            }
          }
          if (!Array.isArray(plan.scenes) || !plan.scenes.length || plan.scenes.some(scene =>
            !scene || typeof scene.id !== 'string' || !scene.id.trim()
            || typeof scene.visual_prompt !== 'string' || typeof scene.transcript_segment !== 'string'
            || !Number.isFinite(scene.start_sec) || scene.start_sec < 0
            || !Number.isFinite(scene.end_sec) || scene.end_sec <= scene.start_sec,
          ) || new Set(plan.scenes.map(scene => scene.id)).size !== plan.scenes.length) {
            throw new Error('the saved plan has missing or invalid scene IDs or timing rows')
          }
          const coverage = inspectScenePlanCoverage(plan)
          if (!coverage.authoritative || !coverage.complete
            || plan.total_duration_sec < current.last_cue_end_sec - 0.001) {
            throw realignable('the saved plan does not cover the verified subtitle timeline')
          }
          job.output_lines.push('Continuing the existing scene timeline: reviewed scenes and saved prompts are kept; only missing or invalid visual prompts will be requested.')
        }
      } catch (error) {
        if (!continueExistingPlan) throw error
        if ((error as { realign?: boolean })?.realign && !realigned) throw error
        // Running again reads the same saved plan and stops here again. Offer the fix instead.
        job.result = { ...(job.result || {}), attention: { kind: 'scene_plan_rebuild', workspace: 'scene-plan', episode_id } }
        throw nonRetryable(scenePlanContinuationError(error))
      }
      const timelineCleanup = removeNonRenderableScenes(plan.scenes)
      if (timelineCleanup.removed_ids.length) {
        plan.scenes = timelineCleanup.scenes
        await writeJsonAtomic(outPath, plan, { compact: true })
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
      // Creative interpretation is selected once per plan, then assigned across
      // the full episode before any packs leave this Mac. This keeps variety
      // stable across prompt batches without introducing a second LLM pass.
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
        await writeJsonAtomic(outPath, plan, { compact: true })
        const profile = plan.creative_direction.profile === 'custom'
          ? 'Custom'
          : CREATIVE_PROFILES[plan.creative_direction.profile].label
        job.output_lines.push(
          `Creative direction: ${profile} (${plan.creative_direction.intensity}/4) - strategies assigned across ${plan.scenes.length} scene(s) before packing.`,
        )
      }
      return { plan, creativeDirection }
    })
    let loaded: Awaited<ReturnType<typeof readPlan>>
    try {
      loaded = await readPlan()
    } catch (error) {
      if (!(error as { realign?: boolean })?.realign) throw error
      // 1.4.300 "Scene Plan in step with narration": Block is the stop from before 1.4.296; Off/Warn
      // re-align, and may do so past the 10% limit (an automatic re-align used to refuse that).
      if (!await safetyCarriesOn(job, 'plan_in_step', `The Scene Plan is out of step with today's narration or captions `
        + `(${(error as Error).message.replace(/\.$/, '')}). Story re-aligns it; saved work on retained renderable scenes is kept.`)) {
        job.result = { ...(job.result || {}), attention: { kind: 'scene_plan_rebuild', workspace: 'scene-plan', episode_id } }
        throw nonRetryable(scenePlanContinuationError(error))
      }
      const { realignDriftedScenePlan } = await import('../services/scene-plan-reconcile.js')
      try {
        job.output_lines.push(await realignDriftedScenePlan(job.project_slug, episode_id, (error as Error).message, { auto: false }))
      } catch (realignError) {
        job.result = { ...(job.result || {}), attention: { kind: 'scene_plan_rebuild', workspace: 'scene-plan', episode_id } }
        throw nonRetryable(scenePlanContinuationError(realignError))
      }
      realigned = true
      loaded = await readPlan()
    }
    const { plan, creativeDirection } = loaded
    // 1.4.288 — before any prompt is bought, the scenes must reach the end of today's narration.
    // A short plan fails here, at Scene Plan, not an hour later at Video Assembly (AF EP0136).
    // The completion record is written once per code and can describe a `_v2` beside the base,
    // so name the merged track this episode actually renders with (v1.4.314 — the owner's
    // explicit choice when he made one, else the same base-track rule the stitcher uses)
    // rather than trusting whatever the record happens to name.
    const mergedChoice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, episode_id)
    const expectedMerged = expectedMergedAudioFilename(mergedChoice, episode_id)
    // A pin that no longer names a real track must not be measured against the completion
    // record: the record may describe a different track, and `null` would tell the reader to
    // skip its filename check. Refuse and name the repair, exactly as the render path does.
    if (!expectedMerged.ok) {
      throw new Error(`Scene Plan is blocked: ${episode_id.toUpperCase()}'s selected merged audio `
        + `"${expectedMerged.pinned}" is not in this episode's merged-audio folder (it may have been `
        + 'deleted or renamed). Choose this episode\'s narration again in Video Assembly Step 1, then retry.')
    }
    const narration = await readNarrationRecord(
      path.join(paths.merged_audio_dir, `${episode_id.toUpperCase()}_merged_audio.completion.json`),
      path.join(paths.subtitles_dir, `${episode_id.toUpperCase()}_stitched.srt.json`),
      expectedMerged.filename,
    )
    const shortfallSec = planNarrationShortfallSec(plan.scenes, narration)
    // 1.4.300 "Scene Plan reaches the end of the narration" (Off/Warn): the last scene holds to the end.
    if (shortfallSec > COVERAGE_FAIL_SEC && await safetyCarriesOn(job, 'plan_reaches_end',
      `Scene Plan stops ${shortfallSec.toFixed(1)}s before the narration ends (narration is ${narration!.duration_sec.toFixed(1)}s). `
      + 'Story stretches the last scene to the end of the narration.')) {
      const endSec = narration!.duration_sec
      await withLock(outPath, async () => {
        const fresh = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
        const last = fresh.scenes.reduce((a, b) => (Number(b.end_sec) > Number(a.end_sec) ? b : a))
        last.end_sec = endSec
        fresh.total_duration_sec = Math.max(Number(fresh.total_duration_sec) || 0, endSec)
        await writeJsonAtomic(outPath, fresh, { compact: true })
        plan.scenes = fresh.scenes
        plan.total_duration_sec = fresh.total_duration_sec
      })
    } else if (shortfallSec > COVERAGE_FAIL_SEC) {
      job.result = { ...(job.result || {}), attention: { kind: 'scene_plan_rebuild', workspace: 'scene-plan', episode_id } }
      throw nonRetryable(new Error(
        `Scene Plan stops ${shortfallSec.toFixed(1)}s before the narration ends (narration is ${narration!.duration_sec.toFixed(1)}s). `
        + 'It was built from an older, shorter narration. Rebuild the timeline in Scene Plan (or use Pipeline Force); no prompts or images were requested.',
      ))
    }
    if (narration) job.output_lines.push(`Coverage verified: the scenes reach the end of the ${narration.duration_sec.toFixed(1)}s narration.`)
    const duplicateVisualIds = new Set(inspectScenePromptIntegrity(plan.scenes).duplicate_ids)
    const motionIds = isMotion ? motionPromptSceneIds(motionPromptScenesForRequest(plan.scenes, legacyMotionRequest), motionScope, params.motion_scene_ids, params.prompt_limit) : []
    if (isMotion && params.motion_scene_ids === undefined) {
      params.motion_scene_ids = motionIds
      params.motion_scope = motionScope
      params.motion_level = episodeMotionLevel
      await checkpointJobState(job)
    }
    const motionTargetSet = new Set(motionIds)
    const pending = plan.scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene }) => isMotion
        ? motionTargetSet.has(scene.id)
        : !scene.visual_prompt?.trim() || duplicateVisualIds.has(scene.id))
    const limit = params.prompt_limit == null ? pending.length : Math.max(1, Math.min(5000, Math.round(params.prompt_limit)))
    const targets = isMotion ? pending : pending.slice(0, limit)
    if (!targets.length) {
      job.progress = 100
      job.output_dir = paths.episode_dir
      job.output_lines.push(isMotion ? 'No pending motion prompts.' : 'No pending visual prompts.')
      return
    }
    const isPackedRepair = packedRepairStage === stage
    // Manual Retry is a repair too, and it lands on small sets far more often
    // than the first pass does. Same rule as the automatic path: a set of
    // `MAX_SCENES_PER_SMALL_REPAIR_PACK` or fewer goes one scene per request.
    const explicitPaidRepair = !isMotion && params.auto_repair_missing_prompts === true
    // A saved key is recovery evidence, not consent for a new paid repair.
    // Every retry must reclaim it first, including the ordinary Scene Plan
    // recovery path that preserves the original job's parameters.
    const savedPromptRecoveries = !isMotion
      ? scenePromptRecoveries(withSavedPromptCollection(params, job).scene_prompt_recoveries)
      : []
    const persistedPackSize = scenePolicy ? params.pipeline_scene_prompt_pack_sizes?.[stage] : undefined
    const stablePackSize = Number.isInteger(persistedPackSize) && persistedPackSize! >= 1
      ? persistedPackSize!
      : promptPackSize
    if (scenePolicy && !persistedPackSize) {
      params.pipeline_scene_prompt_pack_sizes = {
        ...params.pipeline_scene_prompt_pack_sizes,
        [stage]: stablePackSize,
      }
      await checkpointJobState(job)
    }
    const effectivePackSize = isPackedRepair
      ? scenePromptRepairPackSize(targets.length, stablePackSize)
      : stablePackSize
    // The explicit paid path audits progress across the whole missing tail.
    // Keep it as one logical set; each request within a pass is still one scene.
    const targetPacks = explicitPaidRepair
      ? [targets]
      : packScenePromptItems(targets, effectivePackSize)
    if (isPackedRepair) {
      job.output_lines.push(explicitPaidRepair
        ? `Paid auto-repair: ${targets.length} missing or duplicated visual prompt(s), one scene per Gateway request. Verified prompts and timeline boundaries stay unchanged; another pass runs only while the durable missing count improves.`
        : `Repairing ${targets.length} ${stage} prompt(s) in ${targetPacks.length} durable Gateway pack(s) `
          + (effectivePackSize === 1 && targets.length > 1
            ? '(one scene per request — small packs fail far more often than single scenes). '
            : `(up to ${effectivePackSize} scenes per request). `)
          + 'Timeline boundaries and completed prompts stay unchanged.')
    }

    const effectiveStyle = await resolveEffectiveStyle(
      params.style_prompt, job.project_slug, paths.episode_dir,
      source => job.output_lines.push(source === 'project'
        ? 'Style: the project default Style Bible (this episode has none of its own).'
        : 'Style: this episode\'s Style Bible from the Character Sheet.'),
    )
    if (!effectiveStyle) {
      // Worth saying out loud: with no art direction at all the writer defaults
      // to describing a photograph, which is what drags modern references into
      // a historical scene. See lib/style-bible.ts.
      job.output_lines.push('Style: none set — prompts will carry no art direction. Set a Style Bible or a project default.')
    }
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
    const storyContextRaw = allCues
      .filter(c => c.start_sec >= storyStartSec - 0.01)
      .slice(0, 14)
      .map(c => c.text)
      .join(' ')
    const storyContext = truncateChars(storyContextRaw, 3500)
    let researchContext = ''
    if (!isMotion && useResearch && existsSync(researchPath)) {
      researchContext = truncateChars((await fs.readFile(researchPath, 'utf-8').catch(() => '')).trim(), 6000)
    }

    if (!isMotion) {
      job.output_lines.push(visualMaxTokens === null
        ? 'Visual pack output budget: none published; max_output_tokens omitted.'
        : `Visual pack output budget: ${visualMaxTokens.toLocaleString()} tokens`)
    }
    let packedMotionLevel = 2
    if (isMotion) {
      packedMotionLevel = resolveMotionLevel(episodeMotionLevel, undefined)
      const motionSpec = MOTION_SPECS[packedMotionLevel] || MOTION_SPECS[2]!
      job.output_lines.push(
        `Motion intensity: ${motionSpec.label} (level ${packedMotionLevel}) · ${motionSpec.allow}`,
      )
    }
    const motionSpec = MOTION_SPECS[packedMotionLevel] || MOTION_SPECS[2]!
    const task = isMotion
      ? `Write one restrained image-to-video motion prompt for each scene. Describe camera, ambient, and subject motion only; do not redesign the image. When a scene specifies motion_mode, follow it exactly: gentle means slow camera drift with one or two ambient elements only; limited means one narration-supported focal movement plus a slow camera move. Never add frantic or ungrounded action. Scenes marked still are intentionally excluded from this request. If no motion_mode is supplied, use the fallback intensity — ${motionSpec.label}: ${motionSpec.allow} Camera: ${motionSpec.camera}`
      : 'Write one full-detail cinematic image-generation prompt (110-150 words) for each scene. Honor each scene\'s assigned creative_strategy while keeping recurring subjects, wardrobe, locations, and visual style continuous. Vary the visual thinking across the pack; do not print or explain strategy labels.'
    // The packed writer stores the model's answer verbatim — it prepends no
    // style lead — so its body ceiling reserves only what the render appends.
    // A ceiling the render's own text already exceeds is refused here, typed,
    // before a single charged request is made.
    const visualBudget = isMotion ? undefined : await promptBudget()
    if (visualBudget) {
      const budgetLine = describePromptBudget(visualBudget)
      if (budgetLine) job.output_lines.push(budgetLine)
    }
    // The image model that will RENDER these prompts publishes the ceiling, so
    // the writer fits the prompt BODY under it. Empty when no limit is in force.
    const promptCharCapInstruction = isMotion ? '' : buildPromptCharCapInstruction(visualBudget!.bodyCeiling, {
      publishedCap: visualBudget!.publishedCap,
      reservedCharacters: visualBudget!.reserved.characters,
      reservedDescription: 'the character descriptions and Style Bible text the render appends',
      capSource: visualBudget!.source,
    })
    const contextBack = Math.max(0, Math.min(10, params.neighbor_context_back ?? 2))
    const contextForward = Math.max(0, Math.min(10, params.neighbor_context_forward ?? 1))
    const payloadBySceneId = new Map<string, ScenePromptPayload>()
    for (const [index, scene] of plan.scenes.entries()) {
      payloadBySceneId.set(scene.id, {
        scene_id: scene.id,
        start_sec: scene.start_sec,
        end_sec: scene.end_sec,
        narration: scene.transcript_segment,
        visual_prompt: isMotion ? scene.visual_prompt : undefined,
        motion_mode: undefined,
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
      })
    }
    const buildPackMessages = (
      scenePayloads: ScenePromptPayload[],
      recoveryIssues: readonly ScenePromptCompletionIssue[] = [],
      // Why a repair is being asked for when there are no per-scene findings to
      // quote: the previous attempt never produced a response to find fault
      // with. The request is still a repair and is still marked as one; it just
      // does not invent a per-scene accusation to justify itself.
      recoveryNote = '',
    ): Array<{ role: 'system' | 'user'; content: string }> => {
      const recovery = isPackedRepair || recoveryIssues.length > 0 || !!recoveryNote
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
          // Visual packs get the shared difficult-subjects guidance; motion
          // packs do not — they describe movement over an already-approved
          // still and introduce no subject matter of their own.
          content: `${task}${promptCharCapInstruction ? `\n${promptCharCapInstruction}` : ''}${isMotion ? '' : imagePromptGuidanceBlock()}${isMotion ? '' : legibleTextGuidanceBlock(wantAvoidLegibleText)}\nReturn strict JSON only: {"results":[{"scene_id":"exact input id","${isMotion ? 'motion_prompt' : 'visual_prompt'}":"text"}]}. Start with { and output no analysis, reasoning, markdown, or commentary. Return every ID exactly once. Never invent IDs.${recovery ? ' This is a repair request: return every requested ID, with a non-empty, distinct prompt for each.' : ''}`,
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
              : recoveryNote
                ? `AUTOMATIC RECOVERY:\nRepair only the supplied scene IDs. ${recoveryNote} Give each scene a new, concrete composition.`
                : '',
            rejectedPrompts.length ? `REJECTED PROMPTS — DO NOT REUSE:\n${rejectedPrompts.join('\n')}` : '',
            `SCENES:\n${JSON.stringify(scenePayloads)}`,
          ].filter(Boolean).join('\n\n'),
        },
      ]
    }
    const packs: ScenePromptPack[] = []
    for (const [packIndex, group] of targetPacks.entries()) {
      packs.push({
        pack_id: `${stage}-${String(packIndex + 1).padStart(4, '0')}`,
        scene_ids: group.map(({ scene }) => scene.id),
        // Chat Studio defaults to only 1,024 output tokens, which cannot hold
        // ten 110–150 word visual prompts. Set an explicit pack-sized budget.
        //
        // One budget for both visual paths: the owner's choice clamped to what the
        // selected model publishes (`visualMaxTokens`). The explicit paid-repair path
        // used to clamp that to a hardcoded `2,048` — the same stage-specific cap of
        // ours the owner removed from the motion stage on 2026-09-26 ("we follow the
        // published per-model figure and invent no ceiling"), and the one shape this
        // module forbids: `describeScenePromptPackSize` reports every reduction, so a
        // number that changes quietly is the defect. Each request on that path carries
        // ONE scene (`packScenePromptItems(missing, 1)`), so the cap never protected
        // against a truncated pack; requests are issued one at a time, so removing it
        // does not raise the peak credit reservation either.
        params: {
          temperature: isMotion ? 0.35 : Math.min(0.68, 0.5 + ((creativeDirection?.intensity || 2) * 0.035)),
          ...(isMotion
            ? (activePromptOutputBudget === null ? {} : { max_tokens: activePromptOutputBudget })
            : visualMaxTokens === null ? {} : { max_tokens: visualMaxTokens }),
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
      maxTokens?: number
      recoveryIssues?: readonly ScenePromptCompletionIssue[]
      recoveryNote?: string
      checkpointSceneIds?: readonly string[]
      recoverByIdempotencyKey?: string
      /** Collect pass: a lost saved request is handed back (`lostResend`) so every other saved key is read before any resend. */
      deferLostResend?: boolean
    }) => {
      const payloads = input.sceneIds.map(sceneId => payloadBySceneId.get(sceneId)).filter((payload): payload is ScenePromptPayload => !!payload)
      if (payloads.length !== input.sceneIds.length) {
        throw new Error(`Cannot repair unknown scene IDs: ${input.sceneIds.filter(sceneId => !payloadBySceneId.has(sceneId)).join(', ')}`)
      }
      let diagnostics: TextGenerationDiagnostics | undefined
      let results = new Map<string, string>()
      let checkpointErrors: string[] = []
      let requestError = ''
      // Whether the ORIGINAL request may still be running, or its billing
      // outcome is unknown. Only that state makes a repair request unsafe —
      // see the repair gate below.
      let requestUnresolved = false
      let preparedIdempotencyKey = ''
      // Did any response CONTENT come back? Set the instant `callAi` returns, so
      // it can never be inferred from a side effect. Everything the completion
      // diagnosis says is a claim about a response's contents, and a request
      // that died on the way out has no contents to make claims about.
      let responseReceived = false
      const startedAt = Date.now()
      // Cooperative Pause means "finish the accepted request, then submit no
      // more". This must be outside the provider-error catch below so a
      // JobPausedError cannot be mistaken for a settled provider failure.
      throwIfPauseRequested(job.job_id)
      try {
        const messages = buildPackMessages(payloads, input.recoveryIssues, input.recoveryNote)
        // **How long this pack's answer is expected to be**, which is what the Gateway forwards
        // to Studio Hub to size the chat job's deadline from. The Hub cannot tell a 100-prompt
        // pack from a one-line question by reading the body, and sizing every job from
        // `max_tokens` would make every job hours long. `sceneIds x tokensPerScene` is the same
        // arithmetic Story already uses to size the pack itself (`maxSafeScenePromptPackSize`),
        // so the expectation and the allowance cannot disagree about what a scene costs. It
        // follows the ids actually being asked for, so a repair of three scenes expects three.
        const expectedOutputTokens = Math.max(
          1,
          Math.round(input.sceneIds.length * promptPackTuning.tokensPerScene),
        )
        const requestIdentity = explicitPaidRepair
          ? `${job.project_slug}:${episode_id}:scene-plan:${stage}:paid-auto-repair:${job.job_id}:${input.requestLabel}`
          : freshGenerationRequestIdentity(job, `scene-plan-${stage}-${input.requestLabel}`)
            ?? `${job.project_slug}:${episode_id}:scene-plan:${stage}:${input.requestLabel}`
        // Saved-key recovery is a read-only provider lookup. It cannot be
        // routed through today's policy candidate: that candidate may have
        // been retired or reassigned after the original request was accepted.
        // `callAi` recognizes `recoverByIdempotencyKey` before catalogue or
        // capability validation, so it reaches the exact GET without opening
        // a path to a replacement POST.
        const raw = await (scenePolicy && !input.recoverByIdempotencyKey ? callAiWithModelPolicy(scenePolicy,
          messages[0]!.content,
          messages.slice(1).map(message => message.content).join('\n\n'),
          GENSTUDIO_ONLY_LEGACY_KEY_BAG,
          false,
          {
            slug: job.project_slug,
            jobId: `${job.job_id}:${input.requestLabel}`,
            requestIdentity,
            pipelinePolicyCheckpoint: sceneCheckpoint,
            pipelinePolicyCheckpointKey: requestIdentity,
            beforeModelAttempt: async selected => {
              const apiKey = await getApiKey('genstudio').catch(() => '')
              if (!apiKey) throw new Error('Add a Gateway API Key in Settings → This Mac before generating scene prompts.')
              const live = (await listGenStudioChatModels(apiKey)).find(candidate => candidate.id === selected)
              if (!live || !live.available) throw new GenStudioChatProductUnavailableError(selected)
              assertScenePromptPackCapability(live, input.maxTokens, input.sceneIds.length)
            },
            onModelSelected: selected => { job.output_lines.push(`[pipeline] scene plan using Gateway product "${selected}".`) },
            onRequestPrepared: (idempotencyKey: string) => { preparedIdempotencyKey = idempotencyKey },
            maxTokens: input.maxTokens,
            expectedOutputTokens,
            outputContract: scenePromptPackOutputContract(input.sceneIds, isMotion ? 'motion' : 'visual'),
            disableReasoning: true,
            temperature: isMotion ? 0.35 : Math.min(0.68, 0.5 + ((creativeDirection?.intensity || 2) * 0.035)),
            onDiagnostics: (details: TextGenerationDiagnostics) => { diagnostics = details },
          },
        ) : callAi(
          model,
          messages[0]!.content,
          messages.slice(1).map(message => message.content).join('\n\n'),
          GENSTUDIO_ONLY_LEGACY_KEY_BAG,
          false,
          {
            slug: job.project_slug,
            jobId: `${job.job_id}:${input.requestLabel}`,
            requestIdentity,
            ...(input.recoverByIdempotencyKey ? {
              recoverByIdempotencyKey: true,
              idempotencyKey: input.recoverByIdempotencyKey,
              allowedRecoveryKeys: [input.recoverByIdempotencyKey],
              ...(input.deferLostResend ? { deferLostResend: true } : {}),
            } : {}),
            onRequestPrepared: (idempotencyKey: string) => { preparedIdempotencyKey = idempotencyKey },
            maxTokens: input.maxTokens,
            expectedOutputTokens,
            outputContract: scenePromptPackOutputContract(input.sceneIds, isMotion ? 'motion' : 'visual'),
            disableReasoning: true,
            temperature: isMotion ? 0.35 : Math.min(0.68, 0.5 + ((creativeDirection?.intensity || 2) * 0.035)),
            onDiagnostics: (details: TextGenerationDiagnostics) => { diagnostics = details },
          },
        ))
        responseReceived = true
        results = parseDirectPackResults(raw, input.sceneIds, isMotion ? 'motion' : 'visual')
        checkpointErrors = await checkpointPackPromptResults(
          results,
          new Set(input.checkpointSceneIds || input.sceneIds),
          input.saved,
          persistPrompt,
        )
        // THROUGHPUT, RECORDED ON SUCCESS.
        //
        // `completionTokens` used to be read only inside an error string, so
        // every request that WORKED threw its own measurement away. That is
        // why the safe batch size had to be argued from an estimate: nobody
        // could say how fast a large pack actually comes back, and what really
        // bounds batch size is wall-clock — how long a request may run — not
        // tokens. That limit is now the owner's own setting
        // (`genstudio_language_timeout_minutes`), and the Scene Plan panel
        // warns against it using an ASSUMED 50 tok/s floor. Every line below
        // is a measured tok/s for a real pack, which is what will eventually
        // replace that assumption. One line per pack makes the next
        // batch-size decision a lookup instead of an argument.
        if (diagnostics?.completionTokens != null) {
          const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000)
          job.output_lines.push(
            `↳ ${input.sceneIds.length} scene(s) · ${diagnostics.completionTokens.toLocaleString()} completion tokens`
            + `${diagnostics.reasoningTokens ? ` (+${diagnostics.reasoningTokens.toLocaleString()} reasoning)` : ''}`
            + ` in ${elapsedSec.toFixed(1)}s = ${Math.round(diagnostics.completionTokens / elapsedSec).toLocaleString()} tok/s`
            + ` · ${Math.round(diagnostics.completionTokens / Math.max(1, input.sceneIds.length))} tokens/scene`,
          )
        }
      } catch (error: any) {
        if (isGenStudioInsufficientCredits(error)) throw error
        if (input.deferLostResend && isGenStudioSubmissionUncertain(error)) {
          return { results, checkpointErrors, diagnostics, requestError: '', requestUnresolved: false, responseReceived: false, lostResend: true }
        }
        requestError = error?.message || String(error)
        requestUnresolved = scenePromptRequestIsUnresolved(job, error, preparedIdempotencyKey || input.recoverByIdempotencyKey || '')
        if (error instanceof GenStudioChatIncompleteError && error.partialText.trim()) {
          responseReceived = true
          results = parseDirectPackResults(error.partialText, input.sceneIds, isMotion ? 'motion' : 'visual')
          checkpointErrors = await checkpointPackPromptResults(
            results,
            new Set(input.checkpointSceneIds || input.sceneIds),
            input.saved,
            persistPrompt,
          )
        }
        // The provider derived this key before its POST. If that POST reaches
        // an ambiguous accepted/running state, carry the exact request and its
        // strict scene scope into an ordinary retry instead of inventing a
        // replacement request. A later read-only recovery decides whether any
        // fresh work is safe.
        if (!input.recoverByIdempotencyKey && preparedIdempotencyKey
          && (isGenStudioRequestInProgress(error) || isGenStudioSubmissionUncertain(error))) {
          const recoveries = scenePromptRecoveries(params.scene_prompt_recoveries)
          if (!recoveries.some(recovery => recovery.idempotency_key === preparedIdempotencyKey)) {
            params.scene_prompt_recoveries = [
              ...recoveries,
              { idempotency_key: preparedIdempotencyKey, scene_ids: [...input.sceneIds] },
            ]
            await checkpointJobState(job)
          }
        }
        if (explicitPaidRepair && error instanceof GenStudioApiError && !requestUnresolved) throw error
      }
      return { results, checkpointErrors, diagnostics, requestError, requestUnresolved, responseReceived, lostResend: false }
    }
    const requestPromptGroups = async (input: {
      groups: string[][]
      saved: Set<string>
      requestLabel: string
      maxTokens?: number
      recoveryIssues?: readonly ScenePromptCompletionIssue[]
      recoveryNote?: string
      appendGroupLabel?: boolean
    }) => {
      const results = new Map<string, string>()
      const checkpointErrors: string[] = []
      const requestErrors: string[] = []
      let diagnostics: TextGenerationDiagnostics | undefined
      let requestUnresolved = false
      let responseReceived = false
      const answeredIds = new Set<string>()
      for (const group of input.groups) {
        if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
        const groupIssues = input.recoveryIssues?.filter(issue => group.includes(issue.scene_id)) || []
        const response = await requestPromptPack({
          sceneIds: group,
          saved: input.saved,
          requestLabel: scenePromptRequestLabel(input.requestLabel, group, input.appendGroupLabel !== false),
          maxTokens: input.maxTokens,
          recoveryIssues: groupIssues,
          recoveryNote: groupIssues.length ? undefined : input.recoveryNote,
        })
        diagnostics = response.diagnostics || diagnostics
        responseReceived ||= response.responseReceived
        if (response.responseReceived) for (const sceneId of group) answeredIds.add(sceneId)
        for (const [sceneId, prompt] of response.results) results.set(sceneId, prompt)
        checkpointErrors.push(...response.checkpointErrors)
        if (explicitPaidRepair && response.checkpointErrors.length) {
          throw new Error(`Story Studio could not save the returned prompt, so paid auto-repair stopped before another request: ${response.checkpointErrors.join('; ')}`)
        }
        if (response.requestError) requestErrors.push(response.requestError)
        if (response.requestUnresolved) {
          requestUnresolved = true
          break
        }
      }
      return {
        results,
        checkpointErrors,
        diagnostics,
        requestError: requestErrors.join('; '),
        requestUnresolved,
        responseReceived,
        answeredIds,
      }
    }
    job.output_lines.push(explicitPaidRepair
      ? `Processing one missing-prompt repair set through the Gateway (${model}).`
      : `Processing ${packs.length} adaptive pack(s) through the Gateway (${model}).`)
    const incompletePacks: string[] = []
    let unresolvedProviderRequest = false
    // Collect first. Every answer this job already holds is read back by its exact saved key before
    // ANY new request goes out, for the whole run and not pack by pack: a fresh pack must never be
    // able to orphan an accepted answer that covers a later one.
    let recoveryUnresolved = false
    const recoveryErrors: string[] = []
    // Two passes. First every saved key is read once, and a key the Gateway lost track of is only
    // noted; then each lost key gets its one resend, for the scenes no other saved answer covered.
    // Resending inside the first pass could buy new work for scenes a LATER saved key already holds.
    const collectSaved = async (index: number, recovery: typeof savedPromptRecoveries[number], deferLostResend: boolean) => {
      const notDurable = targets.map(({ scene }) => scene.id).filter(id => !durableTargetIds.has(id))
      const scope = recovery.scene_ids ?? notDurable
      const checkpointIds = scope.filter(id => notDurable.includes(id))
      if (!checkpointIds.length) return false
      job.output_lines.push(`↻ Checking the earlier prompt request at the Gateway before starting new work (${checkpointIds.length} missing scene(s)).`)
      const recovered = await requestPromptPack({
        sceneIds: scope,
        checkpointSceneIds: checkpointIds,
        saved: new Set(scope.filter(id => !checkpointIds.includes(id))),
        requestLabel: `${stage}:recover-${index + 1}`,
        maxTokens: packs[0]?.params.max_tokens ?? visualMaxTokens ?? undefined,
        recoverByIdempotencyKey: recovery.idempotency_key,
        deferLostResend,
      })
      if (recovered.checkpointErrors.length) {
        throw new Error(`Story Studio recovered the earlier Gateway output but could not save it, so no new paid request was started: ${recovered.checkpointErrors.join('; ')}`)
      }
      if (recovered.lostResend) return true
      if (recovered.requestError) recoveryErrors.push(recovered.requestError)
      recoveryUnresolved ||= recovered.requestUnresolved
      const recoveredReceipt = await auditScenePromptCompletion(outPath, targets.map(({ scene }) => scene.id), isMotion ? 'motion' : 'visual')
      syncMemoryPlan(recoveredReceipt.plan)
      for (const sceneId of recoveredReceipt.completed_ids) durableTargetIds.add(sceneId)
      return false
    }
    const lostRecoveries: Array<[number, typeof savedPromptRecoveries[number]]> = []
    for (const [index, recovery] of savedPromptRecoveries.entries()) {
      if (await collectSaved(index, recovery, true)) lostRecoveries.push([index, recovery])
      if (recoveryUnresolved) break
    }
    for (const [index, recovery] of recoveryUnresolved ? [] : lostRecoveries) {
      await collectSaved(index, recovery, false)
      if (recoveryUnresolved) break
    }
    for (const pack of packs) {
      if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
      // A resumed run may already have made some rows durable. Never submit
      // or count those rows again.
      const saved = new Set(pack.scene_ids.filter(sceneId => durableTargetIds.has(sceneId)))
      const missing = pack.scene_ids.filter(id => !saved.has(id))
      // A fully recovered pack has nothing left to ask for: never POST an empty pack.
      const initial = recoveryUnresolved || !missing.length ? {
        results: new Map<string, string>(),
        checkpointErrors: [] as string[],
        diagnostics: undefined,
        requestError: recoveryErrors.join('; '),
        requestUnresolved: recoveryUnresolved,
        responseReceived: false,
        answeredIds: new Set<string>(),
      } : await requestPromptGroups({
        groups: explicitPaidRepair ? packScenePromptItems(missing, 1) : [missing],
        saved,
        requestLabel: pack.pack_id,
        maxTokens: pack.params.max_tokens ?? visualMaxTokens ?? undefined,
        appendGroupLabel: explicitPaidRepair,
      })
      let receipt = await auditScenePromptCompletion(outPath, pack.scene_ids, isMotion ? 'motion' : 'visual')
      syncMemoryPlan(receipt.plan)
      for (const sceneId of receipt.completed_ids) durableTargetIds.add(sceneId)
      for (const sceneId of receipt.missing_ids) {
        durableTargetIds.delete(sceneId)
        saved.delete(sceneId)
      }
      let issues = diagnoseScenePromptCompletionIssues({
        plan: receipt.plan,
        requestedIds: pack.scene_ids,
        missingIds: explicitPaidRepair
          ? receipt.missing_ids.filter(sceneId => initial.answeredIds.has(sceneId))
          : receipt.missing_ids,
        providerResults: initial.results,
        checkpointErrors: initial.checkpointErrors,
        responseReceived: initial.responseReceived,
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
      // scoped to the IDs that failed the durable audit. A SMALL outstanding
      // set is split one scene per request — see
      // `MAX_SCENES_PER_SMALL_REPAIR_PACK` for the measured rates; a compact
      // pack of two to seven is the single worst shape a repair can take. A
      // larger set still travels as one pack, so a partial provider response
      // can never fan a whole episode back out into one paid request per scene.
      //
      // GATED ON `requestUnresolved`, NOT ON "any error". The distinction is
      // the whole point: a repair is unsafe only while the original submission
      // might still be running (`request_in_progress`) or its billing outcome
      // is unknown (`LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN`) — in those two
      // states a second request races work already paid for. Every other
      // failure means GenStudio settled the job and Story Studio simply could
      // not use the answer, which is exactly the case repair exists to fix.
      // Blocking repair on any error at all is how a whole episode came back
      // 0/333 with the log explaining only that repair "was not started".
      let automaticRepairAttempts = 0
      let priorMissingCount = receipt.missing_ids.length
      let consecutiveStalledRepairAttempts = 0
      let previousRequestUnresolved = initial.requestUnresolved
      for (let attempt = 1; !previousRequestUnresolved && receipt.missing_ids.length
        && (explicitPaidRepair || consecutiveStalledRepairAttempts < MAX_CONSECUTIVE_STALLED_PROMPT_REPAIR_ATTEMPTS); attempt++) {
        automaticRepairAttempts = attempt
        const outstanding = [...receipt.missing_ids]
        const repairGroups = packScenePromptItems(
          outstanding,
          explicitPaidRepair ? 1 : scenePromptRepairPackSize(outstanding.length, outstanding.length),
        )
        job.output_lines.push(
          explicitPaidRepair
            ? `↻ Paid repair pass ${attempt}: requesting ${outstanding.length} still-missing prompt(s), one scene per request.`
            : `↻ Gateway prompt repair ${attempt}: requesting ${outstanding.length} missing or invalid scene prompt(s) only`
              + `${repairGroups.length > 1 ? `, one scene per request (${repairGroups.length} requests — small packs fail far more often than single scenes)` : ''}.`,
        )
        const repairBudget = isMotion ? activePromptOutputBudget : visualMaxTokens
        const repairMaxTokens = repairBudget === null ? undefined : Math.min(
          repairBudget,
          Math.max(2_048, Math.max(...repairGroups.map(group => group.length)) * 768),
        )
        const repair = await requestPromptGroups({
          groups: repairGroups,
          saved,
          requestLabel: `${pack.pack_id}:repair-${attempt}`,
            // WHY 768 HERE AND ~400 IN THE SIZER, DELIBERATELY.
            //
            // `scene-prompt-batching.ts` reserves 300 tokens per scene at a
            // 0.75 safety fraction — about 400 effective — while this repair
            // request asks for 768. Measured over 85,411 real scene prompts,
            // 768 is above the worst single scene ever recorded (561) and more
            // than double the p99 (330), so it is over-cautious in absolute
            // terms. It is left alone on purpose:
            //
            //   - This is a CEILING on one request, not a reservation. Nothing
            //     is billed or reserved for tokens the model does not emit, so
            //     the generosity costs nothing.
            //   - The asymmetry runs in the SAFE direction. The repair budget
            //     being LOOSER than the sizer's means a pack the sizer thought
            //     safe can always be re-requested without truncating. Were it
            //     the tighter of the two, repairs would fail where the original
            //     succeeded — the exact failure repair exists to fix.
            //   - This path only runs after something already went wrong, and
            //     it carries `recoveryIssues` text the original did not. Extra
            //     headroom is worth more here than anywhere else in the file.
            //
            // Tightening it to the sizer's number would REDUCE headroom on the
            // recovery path to save nothing measurable, so it stays. The outer
            // `Math.min` still clamps it to what the model publishes.
          maxTokens: repairMaxTokens,
          recoveryIssues: issues,
            // No findings to quote. Every outstanding scene ID gets an issue
            // whenever a response was seen, so an empty `groupIssues` on a
            // still-missing group means exactly one thing: the attempt before
            // this one produced no response to find fault with. Say that,
            // rather than inheriting — or inventing — an accusation.
          recoveryNote: 'The previous request for these scene IDs ended before any response was received, so no prompt exists for them yet.',
        })
        previousRequestUnresolved = repair.requestUnresolved
        receipt = await auditScenePromptCompletion(outPath, pack.scene_ids, isMotion ? 'motion' : 'visual')
        syncMemoryPlan(receipt.plan)
        for (const sceneId of receipt.completed_ids) durableTargetIds.add(sceneId)
        for (const sceneId of receipt.missing_ids) {
          durableTargetIds.delete(sceneId)
          saved.delete(sceneId)
        }
        issues = diagnoseScenePromptCompletionIssues({
          plan: receipt.plan,
          requestedIds: pack.scene_ids,
          // A scene whose repair request never came back is still missing, and
          // is still reported as missing — it just is not accused of anything.
          missingIds: receipt.missing_ids.filter(sceneId => repair.answeredIds.has(sceneId)),
          providerResults: repair.results,
          checkpointErrors: repair.checkpointErrors,
          responseReceived: repair.answeredIds.size > 0,
        })
        if (!receipt.missing_ids.length) {
          job.output_lines.push(`✓ Gateway prompt repair verified ${pack.scene_ids.length}/${pack.scene_ids.length} prompts for ${pack.pack_id}.`)
          break
        }
        const repairDetails = [
          repair.requestError,
          ...issues.map(issue => `${issue.scene_id}: ${issue.detail}`),
        ].filter(Boolean)
        lastError = repairDetails.join('; ') || lastError
        if (previousRequestUnresolved) {
          lastError = `${lastError}; the last Gateway request is still unresolved, so no replacement request was submitted`
          break
        }
        const improved = receipt.missing_ids.length < priorMissingCount
        priorMissingCount = receipt.missing_ids.length
        if (explicitPaidRepair) {
          if (!improved) {
            job.output_lines.push(`Paid auto-repair stopped after pass ${attempt}: the durable missing count did not improve. Click Auto repair prompts again after reviewing the provider/model result.`)
            break
          }
        } else {
          consecutiveStalledRepairAttempts = improved ? 0 : consecutiveStalledRepairAttempts + 1
          if (consecutiveStalledRepairAttempts >= MAX_CONSECUTIVE_STALLED_PROMPT_REPAIR_ATTEMPTS) {
            job.output_lines.push(`Gateway prompt repair stopped after pass ${attempt}: two consecutive settled passes made no durable progress.`)
            break
          }
        }
      }
      if (receipt.missing_ids.length) {
        unresolvedProviderRequest ||= initial.requestUnresolved || previousRequestUnresolved
        incompletePacks.push(`${pack.pack_id} saved ${receipt.completed_ids.length}/${pack.scene_ids.length}; missing ${receipt.missing_ids.join(', ')} (${lastError})`)
        job.output_lines.push(
          initial.requestUnresolved || previousRequestUnresolved
            ? `Partial checkpoint: ${pack.pack_id} saved ${receipt.completed_ids.length}/${pack.scene_ids.length} on disk. No replacement request was started for this pack because the last Gateway request is still unresolved (${lastError}). ${explicitPaidRepair ? 'Auto repair will recover that exact request before any fresh work.' : 'Retry will reconcile that request before any fresh work.'}`
            : `Partial checkpoint: ${pack.pack_id} saved ${receipt.completed_ids.length}/${pack.scene_ids.length} on disk after ${automaticRepairAttempts} automatic repair attempt(s). Last reason: ${lastError}. Auto repair requests only the missing scene IDs through the Gateway.`,
        )
      } else {
        job.output_lines.push(`Checkpointed ${pack.pack_id}: ${receipt.completed_ids.length}/${pack.scene_ids.length} prompts verified on disk.`)
      }
    }
    if (incompletePacks.length) job.output_lines.push(`Incomplete packs: ${incompletePacks.join(' | ')}`)
    job.output_dir = paths.episode_dir
    let completion = await auditScenePromptCompletion(outPath, targetIds, isMotion ? 'motion' : 'visual')
    syncMemoryPlan(completion.plan)
    // 1.4.300 "Every scene has a picture prompt" (Off/Warn): after the last automatic try, a scene still
    // without one gets a plain prompt written from its own narration line (no request, nothing charged).
    // A Gateway request with no known outcome still stops: its answer may yet arrive and be collected.
    const lastTry = !job.auto_retry?.eligible || job.auto_retry.attempt >= job.auto_retry.max_attempts
    if (!isMotion && completion.missing_ids.length && !unresolvedProviderRequest && lastTry
      && await safetyCarriesOn(job, 'scene_prompts', `${completion.missing_ids.length} scene(s) still have no picture prompt after `
        + `the automatic retries (${completion.missing_ids.slice(0, 5).join(', ')}${completion.missing_ids.length > 5 ? ', …' : ''}). `
        + 'Story writes a plain prompt for each from its own narration line.')) {
      const used = new Set(completion.plan.scenes.map(scene => normalizeScenePrompt(scene.visual_prompt)).filter(Boolean))
      for (const sceneId of completion.missing_ids) {
        const scene = completion.plan.scenes.find(item => item.id === sceneId)
        const line = scene?.transcript_segment?.trim()
        if (!scene || !line) continue
        let prompt = `${effectiveStyle ? `${effectiveStyle.trim()} ` : ''}A picture of this moment in the story: ${line}`
        if (used.has(normalizeScenePrompt(prompt))) prompt += ` (scene ${scene.scene_index})`
        used.add(normalizeScenePrompt(prompt))
        await checkpointScenePrompt(outPath, sceneId, prompt, 'visual')
      }
      completion = await auditScenePromptCompletion(outPath, targetIds, 'visual')
      syncMemoryPlan(completion.plan)
    }
    if (!isMotion) {
      requireJobCompletion(job, {
        label: 'Visual prompt generation', expected: targets.length, completed: completion.completed_ids.length,
        item_name: 'visual prompt',
        missing: completion.missing_ids,
        issues: completion.issues,
        retry_hint: unresolvedProviderRequest
          ? 'The Gateway could not confirm whether an earlier prompt request was accepted. Story Studio saved that request identity and did not submit replacement work. Reconcile it before retrying; verified prompts remain saved.'
          : explicitPaidRepair
          ? 'Paid auto-repair stopped with unresolved prompts. Review the named reason, then click Auto repair prompts again; verified prompts remain saved.'
          : 'Automatic Gateway repair is exhausted. Retry All pending; image rendering remains blocked until every scene has a unique prompt.',
      })
    } else {
      requireJobCompletion(job, {
        label: 'Motion prompt generation', expected: targets.length, completed: completion.completed_ids.length,
        item_name: 'motion prompt',
        missing: completion.missing_ids,
        issues: completion.issues,
        retry_hint: 'Motion is optional until enabled; once enabled, Retry fills only the missing prompts.',
      })
    }
    job.progress = 100
    job.output_lines.push(`Verified ${completion.completed_ids.length}/${targets.length} ${stage} prompt(s) on disk by stable scene ID.`)
    // Advisory only. Every prompt was saved in full; a prompt that overran the
    // BODY budget it was written under is named so the user can decide, and is
    // never shortened for them. Comparing against the body budget (not the
    // model's larger assembled ceiling) is what says whether the render will
    // have room for the Style Bible and character text it appends.
    if (!isMotion) {
      const overCapNotice = describeOverCapPrompts(
        completion.plan.scenes
          .filter(scene => targetIds.has(scene.id))
          .map(scene => ({ label: `scene #${scene.scene_index}`, text: scene.visual_prompt })),
        visualBudget!.storedBodyCeiling,
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
  //
  // `regenerate_prompt_scene_ids` (Scene Plan "Regenerate prompts" for the
  // selected scenes) runs the same rewrite for each chosen scene in turn. Each
  // new prompt is saved as soon as it lands; a scene that fails keeps its old
  // prompt, is named in the job log, and is the only one a Retry rewrites.
  const promptTargetIds = params.regenerate_prompt_scene_ids?.length
    ? params.regenerate_prompt_scene_ids
    : params.regenerate_prompt_scene_id ? [params.regenerate_prompt_scene_id] : null
  if (promptTargetIds) {
    const batch = !!params.regenerate_prompt_scene_ids?.length
    if (!existsSync(outPath)) throw new Error('No scene_plan.json to regenerate prompts for — run the full planner first.')
    const existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
    // Validate a single target before any model work (unchanged behaviour).
    if (!batch) {
      const only = existing.scenes.find(s => s.id === promptTargetIds[0])
      if (!only) throw new Error(`Scene ${promptTargetIds[0]} not found in scene_plan.json`)
      if (!only.transcript_segment || !only.transcript_segment.trim()) {
        throw new Error(`Scene #${only.scene_index} has no transcript_segment to base a prompt on. Edit it first or use Re-plan.`)
      }
    } else {
      job.output_lines.push(
        `Regenerating the visual prompts of ${promptTargetIds.length} selected scene(s) — `
        + 'time ranges, narration, images and approvals stay as they are; only the prompts are rewritten.',
      )
    }
    if (params.reword_prompt) {
      job.output_lines.push(
        'Reword: asking for a different angle on the same beat, with the difficult-subjects guidance applied. '
        + 'The historical substance stays; only the framing changes.',
      )
    }
    // v1.0.343 — keep the rewrite ON-STYLE. The Scene Review reprompt doesn't
    // pass a style_prompt, so the LLM used to invent its own art direction and
    // drift from the channel look. Fall back to the episode's continuity Style
    // Bible (the same text the renderer appends to every prompt) so the rewritten
    // prompt matches the rendered style instead of fighting it. v1.0.364 — this
    // fallback is now the shared `resolveEffectiveStyle` used by every plan path.
    const stylePromptForRewrite = await resolveEffectiveStyle(
      params.style_prompt, job.project_slug, paths.episode_dir,
      source => job.output_lines.push(source === 'project'
        ? 'Using the project default Style Bible to keep the rewrite on-style.'
        : 'Using the episode Style Bible to keep the rewrite on-style.'),
    )
    // This writer prepends `stylePromptForRewrite` as a lead, so reserve that
    // AND what the render appends. Measured once, BEFORE the per-scene loop: a
    // ceiling the assembly alone already exceeds is a deterministic refusal and
    // must surface typed through the batched path, never turn into one scene's
    // "failure" and get retried.
    const rewriteBudget = await promptBudget(stylePromptForRewrite)
    const rewriteBudgetLine = describePromptBudget(rewriteBudget)
    if (rewriteBudgetLine) job.output_lines.push(rewriteBudgetLine)
    const creativeDirectionForRewrite = assignCreativeStrategies(
      existing.scenes,
      existing.creative_direction || params.creative_direction,
      `${job.project_slug}:${episode_id}`,
      true,
    )
    existing.creative_direction = creativeDirectionForRewrite
    const failures: Array<{ item_id: string; state: 'invalid'; reason: string; label: string }> = []
    for (const [position, sceneId] of promptTargetIds.entries()) {
      if (batch && isCancelled(job.job_id)) throw new Error('Cancelled by user')
      try {
        const target = existing.scenes.find(s => s.id === sceneId)
        if (!target) throw new Error('this scene is no longer in the plan')
        if (!target.transcript_segment?.trim()) throw new Error('this scene has no narration text to base a prompt on')
        job.output_lines.push(
          `${params.reword_prompt ? 'Rewording' : 'Regenerating'} visual prompt for scene #${target.scene_index} `
          + `(${target.start_sec.toFixed(1)}–${target.end_sec.toFixed(1)}s, ${(target.end_sec - target.start_sec).toFixed(1)}s)`
          + (batch ? ` — ${position + 1} of ${promptTargetIds.length}.` : ' — time range and transcript unchanged, only the prompt is rewritten.'),
        )
        const newPrompt = await generateVisualPromptOnly({
          transcript_segment: target.transcript_segment,
          model,
          detail_level: params.detail_level,
          style_prompt: stylePromptForRewrite,
          custom_instructions: params.custom_instructions,
          creative_direction: creativeDirectionForRewrite,
          creative_strategy: target.creative_strategy,
          prompt_char_cap: rewriteBudget.bodyCeiling,
          prompt_char_cap_published: rewriteBudget.publishedCap,
          prompt_char_cap_reserved: rewriteBudget.reserved.characters,
          prompt_char_cap_source: rewriteBudget.source,
          avoid_legible_text: wantAvoidLegibleText,
          // A user-invoked reword asks for a different ANGLE on the same beat with
          // the difficult-subjects guidance applied, rather than another pass at
          // the same framing. Nothing infers this from a failure — see
          // lib/image-content-guidance.ts.
          reword: params.reword_prompt === true,
          reword_previous_prompt: params.reword_prompt === true
            ? (target.visual_prompt ?? '')
            : undefined,
          apiKeys: GENSTUDIO_ONLY_LEGACY_KEY_BAG,
          callAi: scenePlanPolicyCall,
          request_identity: freshGenerationRequestIdentity(job, `visual-prompt-${target.id}`),
          slug: job.project_slug,
        })
        if (!newPrompt || !newPrompt.trim()) {
          throw new Error(batch
            ? 'the model returned an empty prompt'
            : 'Model returned an empty prompt. Try a stronger model or fill the prompt in manually.')
        }
        // The read above is separated from this write by a full LLM round-trip, so
        // the snapshot is stale by the time the answer lands. Re-read under the lock
        // and apply only this scene's change, instead of republishing the snapshot
        // over whatever else was written to the episode meanwhile. Only the prompt
        // changes: image, approval and timings are left exactly as they are.
        await fs.mkdir(path.dirname(outPath), { recursive: true })
        await withLock(outPath, async () => {
          const fresh = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
          const scene = fresh.scenes.find(item => item.id === sceneId)
          if (!scene) throw new Error(batch ? 'this scene was removed while its prompt was being written' : `Scene ${sceneId} was removed while its prompt was being regenerated.`)
          scene.visual_prompt = newPrompt
          clearLegacyPlannerFallbackReasons([scene])
          fresh.generated_at = new Date().toISOString()
          await writeJsonAtomic(outPath, fresh)
        })
        // The saved prompt includes the style lead the writer prepended, so it
        // is measured against the saved-body ceiling (the assembled ceiling
        // minus only what the render appends) — the largest body that will fit
        // once rendered. Nothing is shortened either way.
        const rewriteLength = readPromptLength(newPrompt, rewriteBudget.storedBodyCeiling)
        job.output_lines.push(
          `✓ Prompt regenerated (${rewriteLength.characters.toLocaleString()}`
          + `${rewriteLength.cap ? ` / ${rewriteLength.cap.toLocaleString()}` : ''} chars). Other scenes untouched.`,
        )
        if (rewriteLength.over_cap) {
          job.output_lines.push(
            `⚠ ${rewriteLength.overage.toLocaleString()} characters over the ${rewriteLength.cap!.toLocaleString()}-character prompt-body limit. `
            + 'The prompt was saved in full — shorten it, raise the limit, or render as-is.',
          )
        }
      } catch (error: any) {
        if (!batch) throw error
        const reason = String(error?.message || error || 'failed')
        const index = existing.scenes.find(s => s.id === sceneId)?.scene_index
        const label = index ? `#${index}` : sceneId
        failures.push({ item_id: sceneId, state: 'invalid', reason, label })
        job.output_lines.push(`✗ Scene ${label}: ${reason} — its previous prompt is kept.`)
      }
      job.progress = 10 + Math.round(85 * (position + 1) / promptTargetIds.length)
    }
    job.output_dir = paths.episode_dir
    job.progress = 100
    if (batch) {
      // Retry rewrites only the scenes that failed; finished ones are kept.
      if (failures.length) job.params.regenerate_prompt_scene_ids = failures.map(f => f.item_id)
      requireJobCompletion(job, {
        label: 'Regenerate prompts for selected scenes',
        expected: promptTargetIds.length,
        completed: promptTargetIds.length - failures.length,
        item_name: 'scene prompt',
        invalid: failures.map(f => f.item_id),
        issues: failures.map(({ item_id, state, reason }) => ({ item_id, state, reason })),
        message: `${failures.length} of ${promptTargetIds.length} selected scene prompts could not be rewritten `
          + `(scene${failures.length === 1 ? '' : 's'} ${failures.slice(0, 20).map(f => f.label).join(', ')}`
          + `${failures.length > 20 ? `, +${failures.length - 20} more` : ''}) — `
          + 'they keep their previous prompt. The others were rewritten and saved. Retry rewrites only the failed scenes.',
      })
      job.output_lines.push(`Done — ${promptTargetIds.length} of ${promptTargetIds.length} selected scene prompts rewritten.`)
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
    const motionLevel = resolveMotionLevel(episodeMotionLevel, undefined)
    job.output_lines.push(`Regenerating motion prompt for scene #${target.scene_index} (intensity level ${motionLevel}) — visual prompt + timing unchanged.`)
    const motionStyle = await resolveEffectiveStyle(params.style_prompt, job.project_slug, paths.episode_dir)
    const newMotion = await generateMotionPromptOnly({
      transcript_segment: target.transcript_segment,
      visual_prompt: target.visual_prompt,
      model,
      motion_level: motionLevel,
      style_prompt: motionStyle,
      custom_instructions: params.custom_instructions,
      apiKeys: GENSTUDIO_ONLY_LEGACY_KEY_BAG,
      callAi: scenePlanPolicyCall,
      slug: job.project_slug,
      request_identity: freshGenerationRequestIdentity(job, `motion-prompt-${target.id}`),
    })
    if (!newMotion || !newMotion.trim()) {
      throw new Error('Model returned an empty motion prompt. Try a stronger model or fill it in manually.')
    }
    // The read above is separated from this write by a full LLM round-trip, so
    // the snapshot is stale by the time the answer lands. Re-read under the lock
    // and apply only this scene's change, instead of republishing the snapshot
    // over whatever else was written to the episode meanwhile.
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await withLock(outPath, async () => {
      const fresh = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
      const scene = fresh.scenes.find(item => item.id === params.regenerate_motion_prompt_scene_id)
      if (!scene) throw new Error(`Scene ${params.regenerate_motion_prompt_scene_id} was removed while its motion prompt was being regenerated.`)
      scene.motion_prompt = newMotion
      fresh.generated_at = new Date().toISOString()
      await writeJsonAtomic(outPath, fresh)
    })
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
      params.style_prompt, job.project_slug, paths.episode_dir,
      source => job.output_lines.push(source === 'project'
        ? 'No style prompt set — using the project default Style Bible for the re-plan.'
        : 'No style prompt set — using the episode Style Bible for the re-plan.'),
    )
    // The re-plan runs the same writer (which prepends the style lead) and the
    // same renderer, so it gets the same body budget.
    const replanBudget = await promptBudget(replanStyle)
    const replanBudgetLine = describePromptBudget(replanBudget)
    if (replanBudgetLine) job.output_lines.push(replanBudgetLine)
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
      max_output_tokens: promptModel?.max_output_tokens ?? undefined,
      detail_level: params.detail_level,
      style_prompt: replanStyle,
      custom_instructions: params.custom_instructions,
      prompt_char_cap: replanBudget.bodyCeiling,
      prompt_char_cap_published: replanBudget.publishedCap,
      prompt_char_cap_reserved: replanBudget.reserved.characters,
      prompt_char_cap_source: replanBudget.source,
      pacing,
      range: { start_sec: target.start_sec, end_sec: target.end_sec },
      // v1.0.285 — re-plan honours the user's chosen window size too. For a
      // single-scene range this rarely produces more than one window, but
      // passing it keeps behaviour consistent with the full-plan path.
      window_size: params.window_size,
      onWarn: (m) => job.output_lines.push(m),
      callAi: scenePlanPolicyCall,
    })
    const newScenes = replanned.scenes
    if (!newScenes.length) throw new Error('Re-plan produced no scenes for that range.')
    // The read above is separated from this write by a full LLM round-trip, so
    // the snapshot is stale by the time the answer lands. Re-read under the lock
    // and apply only this scene's change, instead of republishing the snapshot
    // over whatever else was written to the episode meanwhile.
    // The splice targets the scene's stable ID in the FRESH plan, not the index
    // captured before the re-plan: another writer may have added or removed
    // scenes since, which would make the old index point at the wrong one.
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    const totalScenes = await withLock(outPath, async () => {
      const fresh = JSON.parse(await fs.readFile(outPath, 'utf-8')) as ScenePlan
      const freshIdx = fresh.scenes.findIndex(item => item.id === params.replan_scene_id)
      if (freshIdx < 0) throw new Error(`Scene ${params.replan_scene_id} was removed while it was being re-planned.`)
      // Splice in place of the target; renumber; everything else (incl image_path) is preserved.
      fresh.scenes.splice(freshIdx, 1, ...newScenes)
      fresh.scenes.forEach((s, i) => { s.scene_index = i + 1 })
      fresh.generated_at = new Date().toISOString()
      await writeJsonAtomic(outPath, fresh)
      return fresh.scenes.length
    })
    job.output_dir = paths.episode_dir
    job.progress = 100
    job.output_lines.push(`Replaced 1 scene with ${newScenes.length} — total now ${totalScenes} scene(s). Done.`)
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
    params.style_prompt, job.project_slug, paths.episode_dir,
    source => job.output_lines.push(source === 'project'
      ? 'No style prompt set — using the project default Style Bible for the plan.'
      : 'No style prompt set — using the episode Style Bible for the plan.'),
  )
  // This writer prepends the style lead and the renderer appends its own
  // layers, so the planner is given the body ceiling that leaves room for both.
  const planBudget = await promptBudget(effectiveStyle)
  const planBudgetLine = describePromptBudget(planBudget)
  if (planBudgetLine) job.output_lines.push(planBudgetLine)

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
    max_output_tokens: promptModel?.max_output_tokens ?? undefined,
    target_scene_count: params.target_scene_count,
    detail_level: params.detail_level,
    style_prompt: effectiveStyle,
    custom_instructions: params.custom_instructions,
    prompt_char_cap: planBudget.bodyCeiling,
    prompt_char_cap_published: planBudget.publishedCap,
    prompt_char_cap_reserved: planBudget.reserved.characters,
    prompt_char_cap_source: planBudget.source,
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
    callAi: scenePlanPolicyCall,
  })

  // Record what this plan did with its opening, the way the deterministic
  // timeline builder already does.
  //
  // The LLM planner never reserves a branded opening — it times scenes against
  // the narration and, when intro skip is on, simply starts later. Until now it
  // wrote nothing about that, so a plan whose scenes began minutes in was
  // indistinguishable from one that opens at 0:00. `inspectScenePlanCoverage`
  // then fell back to its legacy guess ("no opening_mode recorded + a large
  // head gap → probably an old branded opening") and waved the hole through,
  // while Video Assembly — which reads the recorded reserve — refused it. Same
  // plan, two verdicts, and only one of them visible. Stating the mode ends the
  // guess: every consumer now sees the hole, which is what makes the per-episode
  // choice ("Cover the opening", or plan real scenes for it) an actual choice.
  //
  // `from-start` with a zero reserve is the honest pair here: nothing owns the
  // opening yet. It is deliberately NOT `branded-opening`, which would credit
  // the head to an opening clip this episode does not have and let the render
  // gate pass an episode with nothing to show over its first minutes.
  plan.opening_mode = 'from-start'
  plan.opening_reserved_sec = 0
  if (skipUntilSec > 0) {
    job.output_lines.push(
      `Intro skip: scenes start at ${skipUntilSec.toFixed(1)}s and nothing is reserved for the opening yet. `
      + 'Scene Plan and Video Assembly will both show it until you choose what covers it.',
    )
  }

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
  plan.pacing = structuredClone(planPacing)

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
  // As above: the legacy planner produces a whole new plan rather than editing
  // the one on disk, so this replaces the file — under the lock, so it cannot be
  // interleaved with someone else's read-modify-write.
  await withLock(outPath, () => writeJsonAtomic(outPath, plan, { compact: true }))
  const visualIntegrity = inspectScenePromptIntegrity(plan.scenes)
  requireJobCompletion(job, {
    label: 'Scene planning visual prompts',
    expected: plan.scenes.length,
    completed: plan.scenes.length - visualIntegrity.invalid_ids.length,
    missing: visualIntegrity.invalid_ids,
    item_name: 'visual prompt',
    issues: [
      ...visualIntegrity.empty_ids.map(item_id => ({ item_id, state: 'missing' as const, reason: 'missing prompt' })),
      ...visualIntegrity.duplicate_ids.map(item_id => ({ item_id, state: 'invalid' as const, reason: 'duplicate prompt' })),
    ],
    retry_hint: 'The valid timeline and prompts were kept. Run All pending to fill missing or duplicated prompts.',
  })

  // ── v1.0.468 — motion-prompt pass ───────────────────────────────────────
  // Generate a per-scene image-to-video motion_prompt, seeded with each scene's
  // just-written visual_prompt so the two are cohesive. Runs for BOTH planning
  // modes (the planner has already produced visual_prompts by here). Opt-out via
  // params.generate_motion_prompts === false. Scope is an explicit episode choice.
  const wantMotion = params.generate_motion_prompts !== false && (params.motion_scene_ids !== undefined || motionScope.mode !== 'off')
  if (wantMotion) {
    let promptModel = ''
    try {
      const cfg = await getConfig(job.project_slug) as any
      // v1.0.509 — use the fast "prompt model" for motion prompts when set;
      // else fall back to the planner model. Short, simple outputs → a fast
      // model here cuts the (sequential-on-cloud) motion phase substantially.
      if (typeof cfg?.prompt_model === 'string' && cfg.prompt_model.trim()) promptModel = cfg.prompt_model.trim()
    } catch { /* defaults apply */ }
    const motionModel = scenePolicy
      ? scenePolicy.assigned_model
      : promptModel ? await requireScenePlanGenStudioModel(promptModel) : model
    const motionLevel = resolveMotionLevel(episodeMotionLevel, undefined)
    let selectedIds: string[]
    try { selectedIds = motionPromptSceneIds(motionPromptScenesForRequest(plan.scenes, legacyMotionRequest), motionScope, params.motion_scene_ids) }
    catch (error) {
      if (motionScope.mode !== 'selected' || params.motion_scene_ids !== undefined) throw error
      // A deliberate rebuild may replace IDs. The new visual plan is valid;
      // ask for a new motion selection rather than guessing or failing it.
      job.result = { ...job.result, motion_scope_attention: error instanceof Error ? error.message : String(error) }
      job.output_lines.push('Visual plan saved. Re-select motion scenes in Visual timing & motion before generating clips.')
      job.progress = 100
      return
    }
    if (params.motion_scene_ids === undefined) {
      params.motion_scene_ids = selectedIds
      params.motion_scope = motionScope
      params.motion_level = episodeMotionLevel
      await checkpointJobState(job)
    }
    const targetSet = new Set(selectedIds)
    const targets = plan.scenes.map((scene, index) => targetSet.has(scene.id) ? index : -1).filter(index => index >= 0)
    if (targets.length) {
      const MOTION_LABELS: Record<number, string> = { 1: 'Still', 2: 'Gentle', 3: 'Moderate', 4: 'Lively' }
      job.output_lines.push(
        `Generating motion prompts for ${targets.length} animated scene(s) — ${plan.motion_profile ? `${plan.motion_profile.label} profile` : `intensity ${MOTION_LABELS[motionLevel] ?? motionLevel} (level ${motionLevel})`}` +
        (promptModel ? ` · fast prompt model: ${motionModel}` : '') + '…',
      )
      const failed = await generateMotionPromptsForScenes(plan.scenes, targets, {
        model: motionModel,
        motion_level: motionLevel,
        style_prompt: effectiveStyle,
        custom_instructions: params.custom_instructions,
        apiKeys: GENSTUDIO_ONLY_LEGACY_KEY_BAG,
        callAi: scenePlanPolicyCall,
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
        item_name: 'motion prompt',
        missing: missingMotionIds,
        issues: missingMotionIds.map(item_id => ({ item_id, state: 'missing' as const, reason: 'missing prompt' as const })),
        retry_hint: 'Motion prompts already saved were kept; Retry fills only the remaining gaps.',
      })
      if (failed && !missingMotionIds.length) {
        job.output_lines.push('All motion prompts are durable despite transient provider failures reported during generation.')
      }
    }
  }

  job.output_dir = paths.episode_dir
  job.progress = 100
  job.output_lines.push('Done.')
}
