/**
 * Pipeline batch runner.
 *
 * Lets the user kick off a chain (script → images → audio → audio_merge)
 * for many accepted ideas at once, using each generator's last-used preset
 * for that step's settings. Designed for overnight runs: one click, walk
 * away. The job-queue chain hook in services/job-queue.ts handles the
 * hand-off between steps on successful completion.
 */

import { Router, type Request, type Response } from 'express'
import { createHash, randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import * as bp from '../services/broll-pool-manager.js'
import type { ContinuityConfig, Format, JobType, ProjectMeta } from '../models/types.js'
import { computeEpisodeStatus, type EpisodeStatus } from '../services/asset-status.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { buildContinuityConfig, defaultContinuityConfig, writeContinuityConfig } from './continuity.js'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createProjectFactsCache, resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import {
  autoCompleteResearchReview,
  hasResearchEvidence,
  isResearchReviewed,
} from '../lib/research-verification.js'
import {
  normalizeResearchMode,
  providerForResearchMode,
} from '../services/research/index.js'
import { normalizeDomainList } from '../services/research/web-capability.js'
import { normalizeCuePlacement, normalizeCuePositionPair } from '../services/contextual-cues.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir } from '../generators/scene-image.js'
import { inspectChunkedScriptCompletion } from '../lib/chunked-narration.js'
import { parseScenePromptPackSetting, parseScenePromptTokenSetting } from '../services/scene-prompt-batching.js'
import {
  estimateRunBatchBytes,
  getFreeBytes,
  formatBytes,
  type EpisodeEstimateInputs,
  type EstimateStep,
} from '../lib/disk.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveDefaultChatModel } from '../services/genstudio-default-model.js'
import { lineupModelPolicies, applyLlmLineupSnapshot, replaceRetiredLineupModels } from '../services/llm-lineup.js'
import { normalizeLlmLineup } from '../contracts/llm-lineup.js'
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'
import { listChatModels, listTranscriptionModels, publishedVideoControls } from '../lib/genstudio-client.js'
import { resolveTranscriptionLanguage } from '../generators/subtitles.js'
import { requireSceneClipGenStudioModel } from '../generators/scene-clip.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage, unavailableTranscriptionModelMessage } from '../services/genstudio-model-migration.js'
import { withLock } from '../lib/atomic-store.js'
import { isDecodableImage } from '../lib/image-validation.js'
import {
  inspectPipelineSubtitleRepairReadiness,
  inspectSubtitleCompletion,
} from '../services/subtitle-completion.js'
import { readSubtitleTimelineIntegrity } from '../services/scene-timeline-integrity.js'
import {
  assignedPipelinePolicy,
  normalizePipelineModelPolicies,
  validatePipelineModelCatalogue,
  type PipelineModelPolicies,
  type PipelineModelPolicyStage,
} from '../lib/pipeline-model-policy.js'
import { readVideoVisualSource, resolveImagePoolSelection } from '../services/video-visual-source.js'
import type { VideoVisualSource } from '../services/video-visual-source.js'
import { parseScenePacing, type ScenePacing } from '../contracts/pacing.js'
import type { MotionScope } from '../contracts/motion-scope.js'
import { readEpisodeMotionScope, resolveEpisodeMotionSceneIds } from '../services/episode-motion-scope.js'
import { motionSceneIdsForNewRequest } from '../services/scene-motion-prompt-scope.js'
import {
  readLocalMediaCleanupStatus,
  type LocalMediaCleanupStatus,
} from '../services/episode-media-cleanup.js'

export const router = Router()

// Step types the batch runner understands.
//
// `script-only` and `introduction-only` replaced the legacy coupled
// `script` step in M1 — there's now exactly one way to generate
// chapters + intro across the entire system, and the user opts in to
// each independently. `introduction-only` requires `script-only` (or
// pre-existing chapters on disk) for context; the pipeline UI gates
// the intro checkbox accordingly.
//
// `image_prompts` and `metadata` are wrapped LLM calls (see
// generators/image-prompts.ts and generators/metadata.ts) — batch mode
// auto-saves without review. `video` is expensive (~$0.50-$2/clip via
// Veo) so it's opt-in; same for `video_assembly` which requires
// images+merged audio to be done.
// v1.0.363 — the batch runner now chains through the audio-paced formats'
// own steps instead of dead-ending at audio_merge. New steps:
//   - subtitles       → enqueues `subtitles_transcribe` (per-chapter SRTs)
//   - scene_plan       → enqueues `scene_plan_run` (places scenes on the audio
//                        timeline; transcript/continuity formats)
//   - scene_review     → enqueues one durable `continuity_render` batch;
//                        GenStudio owns account admission and execution
//   - video_assembly   → enqueues the unified full editor renderer. Scene Plan
//                        timing is applied automatically and remains strict.
//   - character_sheet  → NOT a job. Config-only: applies the saved
//                        `continuity_page` preset to continuity.json inline at
//                        submit time (before scene_plan runs). Handled in the
//                        run-batch loop, never enqueued.
// The `script-only` step is also expanded, at chain-build time, into the
// outline-first pair `outline_only` → `expand_chapters` (both auto-approved)
// to match what the Scripts page actually runs by hand.
type BatchStep =
  | 'research'
  | 'broll'
  | 'script-only'
  | 'introduction-only'
  | 'image_prompts'
  | 'thumb_images'
  | 'audio'
  | 'audio_merge'
  | 'metadata'
  | 'subtitles'
  | 'scene_plan'
  | 'contextual_cues'
  | 'scene_review'
  | 'motion_review'
  | 'character_sheet'
  | 'video_assembly'
// v1.0.373+: Pipeline only exposes split scene/thumbnail image steps. The
// legacy unified `images` job type can still exist in old job history, but
// run-batch no longer accepts it as a step because it can merge scenes and
// thumbnails into one provider run.
export const VALID_STEPS: BatchStep[] = ['research', 'broll', 'script-only', 'introduction-only', 'image_prompts', 'thumb_images', 'audio', 'audio_merge', 'metadata', 'subtitles', 'scene_plan', 'contextual_cues', 'scene_review', 'motion_review', 'character_sheet', 'video_assembly']

// A few Pipeline step ids don't equal their generator's JobType (the id the
// job queue keys its lane + executor on). Any step NOT listed here enqueues
// under its own id, which IS a valid JobType + lane. Steps listed here MUST be
// translated before jq.enqueue() — otherwise enqueue pushes to a non-existent
// queue lane (`queues[type].pending`) and throws a TypeError, which surfaces to
// the user as "Scene Review always errors out". (scene_review runs the
// GenStudio-owned image batch.)
export const STEP_JOB_TYPE: Partial<Record<BatchStep, JobType>> = {
  research: 'research_run',
  broll: 'broll_select',
  subtitles: 'subtitles_transcribe',
  scene_plan: 'scene_plan_run',
  contextual_cues: 'contextual_cues',
  scene_review: 'continuity_render',
  motion_review: 'scene_clips_batch',
}

/**
 * The JobType a pipeline step enqueues under (mirrors the run-batch loop).
 * `script-only` is special: it expands to outline_only → expand_chapters, so it
 * has no single job type. `character_sheet` is applied inline (never a job).
 */
export function jobTypeForStep(step: BatchStep): JobType {
  return STEP_JOB_TYPE[step] || (step as JobType)
}

// Steps that run with the generator's own defaults — no saved preset required.
// v1.4.73 — the Introduction needs no preset, and must not be able to demand
// one. Its recipe is a channel setting read by the generator, and the step is
// now added automatically for a channel that opens with one — so a missing
// preset here would not merely skip the opening, it would fail the WHOLE batch
// with "No active preset for introduction-only" for every channel that had
// never saved one. Mirrored by NO_PRESET_STEPS in pipeline.vue.
const NO_PRESET_STEPS = new Set<BatchStep>(['introduction-only'])
/** Read-only view for tests and for the page that mirrors this list. */
export const NO_PRESET_STEP_IDS: readonly BatchStep[] = [...NO_PRESET_STEPS]

// Per-step preset-storage keys. Matches the configKey used by each
// generator page's usePresets() call. If the user hasn't applied a
// preset for a step, we fail the whole batch with a clear message —
// an unattended overnight run shouldn't silently use built-in
// defaults the user never saw.
//
// `activeKeys` is a priority-ordered list of config keys to look up the
// active preset id under. The first key with a non-empty string value
// wins. This supports the typed-preset system: pages that adopt
// `usePresets({ presetType: 'X' })` write to `<configKey>_last_preset_X`,
// and we list that typed key BEFORE the legacy `<configKey>_last_preset`
// so the typed selection takes precedence — but legacy untyped presets
// (saved before typing existed) still resolve via the fallback.
//
// Steps that don't use typed presets (every step except the future
// script-only / introduction-only) just have a single-element list.
const PRESET_KEYS: Record<BatchStep, { list: string | string[]; activeKeys: string[] }> = {
  research:            { list: 'research_presets',         activeKeys: ['research_last_preset_research', 'research_last_preset'] },
  broll:               { list: 'broll_presets',            activeKeys: ['broll_last_preset_broll', 'broll_last_preset'] },
  // Both script-only and introduction-only share the 'script' configKey
  // (both live on scripts.vue). They use typed-preset keys per
  // usePresets({ presetType }), with a fallback to the legacy untyped
  // key for old presets saved before typing existed. Order matters:
  // typed first wins.
  'script-only':       { list: 'script_presets',           activeKeys: ['script_last_preset_script', 'script_last_preset'] },
  // Inert while `introduction-only` sits in NO_PRESET_STEPS above: the step
  // never asks for a preset, because its recipe is a channel setting. It is
  // kept, and kept CORRECT, so that removing it from that set could never hand
  // the opening a Script preset's fields — which is what the old
  // `script_presets` entry here would have done.
  'introduction-only': { list: 'introduction_presets',     activeKeys: ['introduction_last_preset_introduction'] },
  // Thumbnail prompts remain separate from Scene Plan visual prompts.
  image_prompts:       { list: 'thumbnail_prompts_presets', activeKeys: ['thumbnail_prompts_last_preset'] },
  thumb_images:        { list: 'thumbnail_generator_presets', activeKeys: ['thumbnail_generator_last_preset'] },
  audio:               { list: 'audio_generator_presets',  activeKeys: ['audio_generator_last_preset'] },
  audio_merge:         { list: 'audio_merge_presets',      activeKeys: ['audio_merge_last_preset'] },
  metadata:            { list: 'metadata_presets',         activeKeys: ['metadata_last_preset'] },
  // v1.0.363 — audio-paced format steps. Keys mirror each page's
  // usePresets({ configKey, presetType }) call: typed active pointer first,
  // legacy untyped pointer as fallback. Subtitles has no presetType.
  subtitles:           { list: 'subtitles_generator_presets', activeKeys: ['subtitles_generator_last_preset'] },
  scene_plan:          { list: 'scene_plan_presets',       activeKeys: ['scene_plan_last_preset_scene-plan', 'scene_plan_last_preset'] },
  contextual_cues:     { list: 'contextual_cues_presets',  activeKeys: ['contextual_cues_last_preset_contextual-cues'] },
  scene_review:        { list: 'scene_review_genstudio_presets', activeKeys: ['scene_review_genstudio_last_preset_scene-review'] },
  motion_review:       { list: 'motion_review_presets',    activeKeys: ['motion_review_last_preset_motion-review', 'motion_review_last_preset'] },
  // Character Sheet's whole-page preset (anchor characters, refs, style bible).
  // Not a job — the run-batch loop writes it to continuity.json inline.
  character_sheet:     { list: 'continuity_page_presets',  activeKeys: ['continuity_page_last_preset_continuity-page', 'continuity_page_last_preset'] },
  video_assembly:      { list: 'video_bundle_presets',     activeKeys: ['video_bundle_last_preset'] },
}

interface StoredPreset { id: string; name: string; data?: any; type?: string; [k: string]: any }

interface PreflightIssue {
  code: 'episode_not_accepted' | 'missing_preset' | 'invalid_preset' | 'missing_voice' | 'missing_prerequisite' | 'missing_local_asset' | 'retired_local_media' | 'insufficient_disk'
  message: string
  episode_id?: string
  step?: BatchStep
  path?: string
}

function retiredLocalMediaIssue(episodeId: string, status: LocalMediaCleanupStatus): PreflightIssue {
  const label = status.blocked_reason || (status.categories.some(category => category.pending_files > 0)
    ? 'Local cleanup needs review'
    : status.state === 'archived' ? 'Sources archived' : 'Some local media was deliberately removed')
  return {
    code: 'retired_local_media',
    episode_id: episodeId,
    message: `${episodeId}: ${label}. Routine Pipeline will not regenerate intentionally cleaned media. Use Force re-run to regenerate selected stages; normal prerequisites and provider costs still apply.`,
  }
}

async function retiredUploadedMediaByEpisode(slug: string, episodeIds: string[]): Promise<Map<string, LocalMediaCleanupStatus>> {
  const retired = new Map<string, LocalMediaCleanupStatus>()
  for (const code of episodeIds) {
    const status = await readLocalMediaCleanupStatus(slug, code)
    if (status.has_retired_media || status.blocked_reason) retired.set(code, status)
  }
  return retired
}

interface BatchPreflight {
  ok: boolean
  issues: PreflightIssue[]
  warnings: string[]
  presetByStep: Partial<Record<BatchStep, StoredPreset>>
  ideaByCode: Map<string, any>
  effectiveFormat: Format | null
  estimatedBytes: number
  freeBytes: number
  /**
   * The language model the SCRIPT is written with, read from the active
   * `script` preset. This is what a channel opening is written with when the
   * channel has not chosen a model of its own — the behaviour every channel
   * had before the Introduction page gained a picker, and what a blank choice
   * still means. Null when no script preset carries one; the batch then says
   * so instead of guessing.
   */
  scriptSideChatModel: string | null
  /**
   * The model this channel has CHOSEN for its openings on the Introduction
   * page, or null when it has not chosen one — which is the default, and
   * which means "follow the Script Generator" exactly as before the picker
   * existed. Resolved once per batch rather than per episode: it is a channel
   * setting, and reading it in the per-episode loop would be the same answer
   * fetched N times.
   */
  introductionChatModel: string | null
  visualSettingsByEpisode: Map<string, PipelineVisualSettingsSnapshot>
}

interface PipelineVisualSettingsSnapshot {
  visual_source: VideoVisualSource
  pacing?: ScenePacing
  motion_scope?: MotionScope
  motion_level?: number
  motion_scene_ids?: string[]
}

interface BlockedPipelineEpisode {
  episode_id: string
  reason: string
  issues: PreflightIssue[]
}

/**
 * A bad batch setting is unsafe for every episode and therefore remains a
 * batch-wide stop. Episode-scoped prerequisites are different: an overnight
 * batch can still make useful progress for the other selected episodes, and
 * each blocked episode gets its own durable reason instead of being hidden in
 * a generic preflight failure.
 */
function splitPreflightIssues(issues: PreflightIssue[]): {
  globalIssues: PreflightIssue[]
  blocked: BlockedPipelineEpisode[]
} {
  const globalIssues: PreflightIssue[] = []
  const byEpisode = new Map<string, PreflightIssue[]>()
  for (const issue of issues) {
    if (!issue.episode_id) {
      globalIssues.push(issue)
      continue
    }
    const episodeIssues = byEpisode.get(issue.episode_id) || []
    episodeIssues.push(issue)
    byEpisode.set(issue.episode_id, episodeIssues)
  }
  return {
    globalIssues,
    blocked: [...byEpisode.entries()].map(([episode_id, episodeIssues]) => ({
      episode_id,
      reason: episodeIssues.map(issue => issue.message).join(' '),
      issues: episodeIssues,
    })),
  }
}

function eligibleEpisodeIds(episodeIds: string[], blocked: BlockedPipelineEpisode[]): string[] {
  const blockedIds = new Set(blocked.map(episode => episode.episode_id))
  return [...new Set(episodeIds)].filter(episodeId => !blockedIds.has(episodeId))
}

const SCENE_PLAN_ONLY_STEPS = new Set<BatchStep>([
  'character_sheet',
  'scene_plan',
  'scene_review',
  'motion_review',
])

export function applicablePipelineStepsForVisualSource(
  steps: BatchStep[],
  source: VideoVisualSource,
): { applicable: BatchStep[]; inapplicable: BatchStep[] } {
  const inapplicable = source === 'image_pool'
    ? steps.filter(step => SCENE_PLAN_ONLY_STEPS.has(step) || step === 'broll')
    : []
  const skipped = new Set(inapplicable)
  return { applicable: steps.filter(step => !skipped.has(step)), inapplicable }
}

async function pipelineVisualSettingsSnapshot(
  slug: string,
  episodeId: string,
  source: Awaited<ReturnType<typeof readVideoVisualSource>>,
  includeEpisodeSettings: boolean,
  includeMotionSceneIds: boolean,
): Promise<PipelineVisualSettingsSnapshot> {
  const snapshot: PipelineVisualSettingsSnapshot = { visual_source: source.source }
  if (source.source !== 'scene_plan' || !includeEpisodeSettings) return snapshot

  let raw: string | undefined
  try {
    raw = await fs.readFile(path.join(source.episode_dir, 'continuity.json'), 'utf8')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  let config: Record<string, unknown> = {}
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must contain an object')
      config = parsed as Record<string, unknown>
    } catch (error: any) {
      throw new Error(`continuity.json is malformed: ${error?.message || error}`)
    }
  }
  snapshot.pacing = parseScenePacing(config.pacing)
  const motion = await readEpisodeMotionScope(slug, episodeId, source.episode_dir)
  snapshot.motion_scope = motion.motion_scope
  snapshot.motion_level = motion.motion_level

  if (!includeMotionSceneIds || motion.motion_scope.mode === 'off') return snapshot
  const planPath = await resolveScenePlanPath(slug, episodeId, source.episode_dir)
  if (!existsSync(planPath)) return snapshot
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  if (!Array.isArray(plan?.scenes)) throw new Error('scene_plan.json has no valid scenes array')
  const resolved = await resolveEpisodeMotionSceneIds(slug, episodeId, plan.scenes, source.episode_dir)
  snapshot.motion_scene_ids = motionSceneIdsForNewRequest(plan.scenes, resolved.scene_ids)
  return snapshot
}

type ContinuityMode = NonNullable<ProjectMeta['continuity_mode']>

async function readPipelineContinuityConfig(
  episodeDir: string,
  mode: ContinuityMode,
): Promise<ContinuityConfig> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(episodeDir, 'continuity.json'), 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return defaultContinuityConfig(mode)
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error: any) {
    throw new Error(`continuity.json is malformed: ${error?.message || error}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('continuity.json is malformed: expected an object')
  }
  return buildContinuityConfig(value as Partial<ContinuityConfig>, mode)
}

function storedPipelinePresetPacing(data: Partial<ContinuityConfig> | null | undefined): ScenePacing | null {
  const pacing = data?.pacing as unknown
  if (!pacing || typeof pacing !== 'object' || Array.isArray(pacing)) return null
  const band = pacing as Record<string, unknown>
  if (!Number.isFinite(band.min_sec) || !Number.isFinite(band.max_sec)) return null
  return parseScenePacing(pacing)
}

/** Apply the same deliberate preset boundary as Character Sheet's manual flow. */
export function applyContinuityPresetForPipeline(
  current: ContinuityConfig,
  data: Partial<ContinuityConfig> | null | undefined,
): Partial<ContinuityConfig> {
  const keepEpisodeSheet = current.use_episode_sheet === true || current.references?.sheet === true
  return {
    ...(data || {}),
    pacing: storedPipelinePresetPacing(data) ?? current.pacing,
    motion_scope: current.motion_scope,
    motion_level: data?.motion_level ?? current.motion_level,
    use_episode_sheet: keepEpisodeSheet,
    references: {
      ...current.references,
      ...(data?.references || {}),
      sheet: keepEpisodeSheet,
    },
  }
}

function addMissingPresetIssue(
  issues: PreflightIssue[],
  visualSettingsByEpisode: Map<string, PipelineVisualSettingsSnapshot>,
  step: BatchStep,
  message: string,
): void {
  const affected = [...visualSettingsByEpisode.entries()]
    .filter(([, settings]) => applicablePipelineStepsForVisualSource([step], settings.visual_source).applicable.length > 0)
    .map(([episodeId]) => episodeId)
  if (affected.length > 0 && affected.length < visualSettingsByEpisode.size) {
    for (const episode_id of affected) issues.push({ code: 'missing_preset', episode_id, step, message })
    return
  }
  issues.push({ code: 'missing_preset', step, message })
}

const STEP_PREREQUISITES: Partial<Record<BatchStep, BatchStep[]>> = {
  broll: ['audio_merge'],
  'introduction-only': ['script-only'],
  // Finalization needs the script plus measured Audio Assembly timing.
  // Subtitles sit before it in the canonical chain but are warning-only:
  // a targeted finalizer run remains valid when subtitle coverage is partial.
  metadata: ['script-only', 'audio_merge'],
  image_prompts: ['script-only'],
  thumb_images: ['image_prompts'],
  audio: ['script-only'],
  audio_merge: ['audio'],
  subtitles: ['audio_merge'],
  character_sheet: ['script-only'],
  scene_plan: ['subtitles'],
  contextual_cues: ['scene_plan'],
  scene_review: ['scene_plan'],
  motion_review: ['scene_review'],
  // Motion Review is optional. Unified assembly uses approved clips where
  // available and exact approved stills everywhere else.
  video_assembly: ['scene_review', 'audio_merge'],
}

/**
 * The Contextual Cues review gate between Scene Plan and Scene Review still
 * exists — its TRIGGER is narrower as of 1.2.7.
 *
 * It used to fire on the project-level `contextual_cues.enabled` flag alone, so
 * switching an OPTIONAL feature on turned every episode in the library into
 * `EP####: scene_review needs contextual_cues earlier in this run or already
 * complete` — eighteen at once on a single Pipeline run, for episodes that had
 * never proposed a cue and so had nothing whatsoever to review.
 *
 * A gate exists to hold work back until a person decides something. With zero
 * proposals there is nothing to decide, exactly as `validateContextualCueTimeline`
 * now reports for the same episode, and as Video Assembly now allows. Both gates
 * answer the same question from that one rule so they cannot drift apart.
 *
 * `cueReviewPending` is therefore the real trigger: cues are enabled AND either
 * this run generates them (keep the ordering honest) or the episode already has
 * something outstanding.
 */
export function prerequisitesForStep(step: BatchStep, cueReviewPending = false): BatchStep[] {
  const base = [...(STEP_PREREQUISITES[step] || [])]
  return step === 'scene_review' && cueReviewPending ? [...base, 'contextual_cues'] : base
}

function collectMissingLocalAssets(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return out
  if (!Array.isArray(value) && (value as any).enabled === false) return out
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && /^(?:music_path|ambient_path|video_path|image_path|source_path|reference_image)$/.test(key)) {
      const candidate = child.trim()
      if (candidate && path.isAbsolute(candidate) && !existsSync(candidate)) out.add(candidate)
      continue
    }
    if (child && typeof child === 'object') collectMissingLocalAssets(child, out)
  }
  return out
}

async function preflightBatch(
  slug: string,
  episodeIds: string[],
  steps: BatchStep[],
  force: boolean,
): Promise<BatchPreflight> {
  const issues: PreflightIssue[] = []
  const warnings: string[] = []
  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Project config missing')
  const projectFacts = createProjectFactsCache(slug)
  projectFacts.config = Promise.resolve(config)

  const ideas = await im.getIdeas(slug, 'accepted')
  const ideaByCode = new Map(ideas.filter(i => i.episode_code).map(i => [i.episode_code!, i]))
  const effectiveFormat = await getEffectiveFormat(slug)
  const retiredMediaByEpisode = force ? new Map<string, LocalMediaCleanupStatus>()
    : await retiredUploadedMediaByEpisode(slug, episodeIds)
  const visualSettingsByEpisode = new Map<string, PipelineVisualSettingsSnapshot>()
  const requiredSteps = new Set<BatchStep>()
  for (const episodeId of episodeIds) {
    if (!ideaByCode.has(episodeId)) {
      issues.push({ code: 'episode_not_accepted', episode_id: episodeId, message: `${episodeId} is not an accepted episode.` })
      continue
    }
    const retiredMedia = retiredMediaByEpisode.get(episodeId)
    if (retiredMedia) {
      issues.push(retiredLocalMediaIssue(episodeId, retiredMedia))
      continue
    }
    try {
      const source = await readVideoVisualSource(slug, episodeId)
      const episodeSteps = applicablePipelineStepsForVisualSource(steps, source.source).applicable
      episodeSteps.forEach(step => requiredSteps.add(step))
      if (episodeSteps.includes('video_assembly') && source.source === 'image_pool') {
        await resolveImagePoolSelection(slug, episodeId)
      }
      const includeEpisodeSettings = episodeSteps.some(step =>
        SCENE_PLAN_ONLY_STEPS.has(step) || step === 'video_assembly',
      )
      visualSettingsByEpisode.set(episodeId, await pipelineVisualSettingsSnapshot(
        slug,
        episodeId,
        source,
        includeEpisodeSettings,
        episodeSteps.includes('motion_review') && !episodeSteps.includes('scene_plan'),
      ))
    } catch (error: any) {
      issues.push({
        code: 'invalid_preset',
        episode_id: episodeId,
        step: steps.includes('video_assembly') ? 'video_assembly' : steps.find(step => SCENE_PLAN_ONLY_STEPS.has(step)),
        message: `${episodeId}: ${error?.message || 'Episode visual settings are not ready.'}`,
      })
    }
  }

  const presetByStep: Partial<Record<BatchStep, StoredPreset>> = {}
  const contextualCuesEnabled = config.contextual_cues?.enabled === true
  if (requiredSteps.has('contextual_cues') && !contextualCuesEnabled) {
    issues.push({ code: 'invalid_preset', step: 'contextual_cues', message: 'Enable Contextual Cues in its project setting before adding it to Pipeline.' })
  }
  for (const step of requiredSteps) {
    if (NO_PRESET_STEPS.has(step)) continue
    const result = findActivePreset(config, step)
    if (!result.preset) {
      addMissingPresetIssue(
        issues,
        visualSettingsByEpisode,
        step,
        result.missingReason || `No active preset for ${step}`,
      )
      continue
    }
    presetByStep[step] = result.preset
    if (step === 'motion_review') {
      const data = result.preset.data ?? result.preset
      const hasOperation = typeof data?.operation === 'string' && Boolean(data.operation.trim())
      const hasDuration = Number.isFinite(Number(data?.duration_seconds)) && Number(data.duration_seconds) > 0
      const hasResolution = typeof data?.resolution === 'string' && Boolean(data.resolution.trim())
      if (!hasOperation || !hasDuration || !hasResolution) {
        issues.push({
          code: 'invalid_preset',
          step,
          message: 'Motion Review preset has no exact published clip variant. Open Motion Review, choose a current length and resolution, then save the preset again.',
        })
      }
    }
    if (step === 'broll' && (result.preset.data?.form?.selection_mode ?? result.preset.form?.selection_mode) === 'manual') {
      issues.push({ code: 'invalid_preset', step, message: 'B-Roll Pipeline cannot use a manual-selection preset. Choose random, tagged, or themed selection.' })
    }
    for (const missingPath of collectMissingLocalAssets(result.preset.data ?? result.preset)) {
      issues.push({
        code: 'missing_local_asset',
        step,
        path: missingPath,
        message: `${step} preset references a local file that is unavailable: ${missingPath}`,
      })
    }
  }

  if (requiredSteps.has('audio')) {
    const audioPreset = presetByStep.audio
    const voice = audioPreset?.data?.form?.voice ?? (audioPreset as any)?.form?.voice
    if (!voice || !String(voice).trim()) {
      issues.push({ code: 'missing_voice', step: 'audio', message: 'Audio preset has no voice selected.' })
    }
  }
  if (requiredSteps.has('broll')) {
    const poolId = (config as any).broll_pool_id
    const pool = poolId ? await bp.getPool(poolId) : null
    if (!poolId || !pool) {
      issues.push({ code: 'invalid_preset', step: 'broll', message: 'No B-Roll pool is subscribed to this project.' })
    } else if (!existsSync(pool.folder_path)) {
      issues.push({ code: 'missing_local_asset', step: 'broll', path: pool.folder_path, message: `B-Roll pool is offline: ${pool.folder_path}` })
    }
  }

  for (const episodeId of episodeIds) {
    const visualSettings = visualSettingsByEpisode.get(episodeId)
    if (!ideaByCode.has(episodeId) || !visualSettings) continue
    const episodeSteps = applicablePipelineStepsForVisualSource(steps, visualSettings.visual_source).applicable
    const status = await computeEpisodeStatus(slug, episodeId, ideas, projectFacts)
    const available = new Set<BatchStep>()
    for (const step of VALID_STEPS) {
      if (isStepAlreadyDone(status, step, effectiveFormat)) available.add(step)
    }
    for (const step of episodeSteps) {
      // A single selected step is normally a targeted repair/regeneration
      // operation. Downstream Story stages still need their durable artifact:
      // Scene Plan needs Subtitles, and Scene Review needs Scene Plan.
      if (episodeSteps.length === 1 && step !== 'metadata' && step !== 'scene_plan' && step !== 'scene_review') {
        available.add(step)
        continue
      }
      // `status.contextual_cues` is the readiness answer (nothing outstanding),
      // NOT the "already produced" answer `available` carries — see
      // `prerequisitesForStep`. An episode that never proposed a cue is not
      // held back; one with an unresolved proposal still is.
      const cueReviewPending = contextualCuesEnabled
        && (episodeSteps.includes('contextual_cues') || status.contextual_cues === false)
      const prerequisites = step === 'video_assembly' && visualSettings.visual_source === 'image_pool'
        ? ['audio_merge' as BatchStep]
        : prerequisitesForStep(step, cueReviewPending)
      const missing = prerequisites.filter(required => !available.has(required))
      for (const required of missing) {
        issues.push({
          code: 'missing_prerequisite',
          episode_id: episodeId,
          step,
          message: `${episodeId}: ${step} needs ${required} earlier in this run or already complete.`,
        })
      }
      available.add(step)
    }
  }

  // Blocked episodes never reach the queue, so reserve disk only for the
  // episodes that can actually run. Otherwise two missing subtitle timelines
  // could make an otherwise-safe eligible batch fail a global disk check.
  const eligibleCount = eligibleEpisodeIds(episodeIds, splitPreflightIssues(issues).blocked).length
  const estimateInputs = extractEstimateInputs(presetByStep as Record<BatchStep, StoredPreset>, eligibleCount)
  const estimatedBytes = estimateRunBatchBytes([...requiredSteps] as EstimateStep[], estimateInputs)
  const outputRoot = await pm.getProjectOutputRoot(slug)
  const freeBytes = await getFreeBytes(outputRoot || pm.projectsRoot())
  if (freeBytes > 0 && freeBytes < estimatedBytes) {
    issues.push({
      code: 'insufficient_disk',
      message: `Not enough free disk space. Have: ${formatBytes(freeBytes)}; need: approximately ${formatBytes(estimatedBytes)} including safety margin.`,
    })
  } else if (freeBytes === 0) {
    warnings.push('Free disk space could not be measured on this storage volume.')
  }

  if (force) warnings.push('Force re-run is enabled; completed outputs may be replaced and provider costs may repeat.')

  const wantsIntroduction = requiredSteps.has('introduction-only')
  const scriptSideChatModel = wantsIntroduction ? resolveScriptSideChatModel(config) : null
  let introductionChatModel: string | null = null
  if (wantsIntroduction) {
    const { getSegmentModel } = await import('../services/channel-segments.js')
    const { INTRODUCTION_SEGMENT_ID } = await import('../lib/episode-segments.js')
    introductionChatModel = (await getSegmentModel(slug, INTRODUCTION_SEGMENT_ID)) || null
  }

  return {
    ok: issues.length === 0, issues, warnings, presetByStep, ideaByCode,
    effectiveFormat, estimatedBytes, freeBytes, scriptSideChatModel, introductionChatModel,
    visualSettingsByEpisode,
  }
}

/**
 * The language model a batched channel opening falls back to.
 *
 * A channel that has not chosen a model for its opening follows the Script
 * Generator, so read the operator's real selection from the active `script`
 * preset. A batched opening is then written by the same product as its
 * chapters rather than by a catalogue default he never chose.
 *
 * Returns null when no script preset carries a model. The caller must then
 * SAY SO rather than substitute one: an invented model is indistinguishable
 * from a chosen one once the job is running, and it spends his credits.
 */
export function resolveScriptSideChatModel(config: Record<string, unknown>): string | null {
  const preset = findActivePreset(config, 'script-only').preset
  // Typed script presets nest the form; legacy untyped ones are flat.
  const data = (preset?.data ?? preset) as { model?: unknown; form?: { model?: unknown } } | null
  const candidate = data?.form?.model ?? data?.model
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

/**
 * Per-step type tag used by usePresets({ presetType }) on the scripts page.
 * When the active-key lookup fails (either missing or pointing at an id no
 * longer in the list — a stale ghost from a deleted preset), we fall back
 * to the most recently saved preset in the list whose `type` matches this
 * map. Keeps pipeline.vue and this resolver in lock-step.
 */
const TYPE_FALLBACK: Partial<Record<BatchStep, string>> = {
  research: 'research',
  broll: 'broll',
  'script-only': 'script',
  'introduction-only': 'introduction',
  // v1.0.363 — typed presets on the audio-paced format pages.
  scene_plan: 'scene-plan',
  contextual_cues: 'contextual-cues',
  scene_review: 'scene-review',
  motion_review: 'motion-review',
  character_sheet: 'continuity-page',
}

/**
 * Is this step's output already on disk? Used by `run-batch` to skip
 * chain links that would otherwise regenerate existing assets — the
 * default "skip-when-done" behaviour keeps batches cheap.
 *
 * `video_assembly` has no stable "complete" marker (bundled asset; depends
 * on the user's export config), so it's never auto-skipped. `video` uses
 * the asset-reconciler's `status.video` (every clip present).
 */
export function isStepAlreadyDone(status: EpisodeStatus, step: BatchStep, format?: Format | null): boolean {
  switch (step) {
    // Research is done once evidence exists. Pipeline still auto-triages an
    // explicitly selected Research stage so its provenance stays honest.
    case 'research':          return status.research
    case 'broll':             return status.video_assembly
    case 'script-only':       return status.script
    case 'introduction-only': return status.introduction
    case 'image_prompts':     return status.thumb_prompts
    case 'thumb_images':      return status.thumbnails
    case 'audio':             return status.audio
    case 'audio_merge':       return status.merged_audio
    case 'metadata':          return status.metadata
    // v1.0.363 — audio-paced format steps.
    case 'subtitles':         return status.subtitles
    case 'scene_plan':        return status.scene_plan
    // "Nothing outstanding" is not the same as "already produced". An episode
    // that never proposed a cue has nothing outstanding — which is why it no
    // longer blocks Scene Review — but an explicitly selected Contextual Cues
    // step must still RUN on it, or the idempotency skip would quietly cancel
    // the very work the user asked for.
    case 'contextual_cues':   return !!status.contextual_cues_generated && !!status.contextual_cues
    case 'scene_review':      return status.scene_review
    case 'motion_review':     return status.motion_review
    case 'character_sheet':   return status.character_sheet
    case 'video_assembly':    return status.video_assembly
  }
}

/**
 * v1.0.761 — Pipeline auto-completion of the claim review on EXISTING research.
 *
 * Requirement: a one-click run must complete unattended, so it cannot be
 * blocked by "research is generated but its claims still need a decision".
 * Requirement 2: the record must stay honest, so the remaining claims are
 * accepted by the machine and the sidecar records
 * `review.completed_by: 'pipeline-auto'`, never `'human'`.
 *
 * No-op unless the sidecar exists, holds real evidence, and still has pending
 * claims. Never creates research, and never touches a triage a person already
 * finished — including the deliberate "I ignored every claim" outcome, which
 * stays incomplete on purpose rather than being silently flipped back to kept.
 * Failures are swallowed: the step then simply runs, and the generator
 * auto-completes the fresh output.
 *
 * Exported for tests.
 */
export async function autoCompleteResearchReviewForPipeline(slug: string, episodeId: string): Promise<boolean> {
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { jsonPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    const existing = JSON.parse(await fs.readFile(jsonPath, 'utf-8'))
    if (!hasResearchEvidence(existing) || isResearchReviewed(existing)) return false

    await fs.writeFile(jsonPath, JSON.stringify(autoCompleteResearchReview(existing), null, 2), 'utf-8')
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, episodeId)
    return true
  } catch {
    return false
  }
}

export function findActivePreset(
  config: any, step: BatchStep,
): { preset: StoredPreset | null; missingReason: string | null } {
  const keys = PRESET_KEYS[step]
  // Some legacy steps can resolve across more than one preset pool. Thumbnail
  // prompts intentionally use only their own preset pool; scene visual
  // planning belongs to Scene Plan.
  const listKeys = Array.isArray(keys.list) ? keys.list : [keys.list]
  const list: StoredPreset[] = listKeys.flatMap(k => (Array.isArray(config?.[k]) ? config[k] : []))
  // Walk activeKeys in order; the first key that points at an existing preset
  // wins. Keep the first non-empty id for the final error message, but don't
  // stop on a stale pointer because split steps can have a stale primary key
  // and a valid fallback key.
  let firstActiveId = ''
  for (const k of keys.activeKeys) {
    const v = typeof config?.[k] === 'string' ? config[k] : ''
    if (!v) continue
    if (!firstActiveId) firstActiveId = v
    const pointedTo = list.find(p => p.id === v)
    if (pointedTo) return { preset: pointedTo, missingReason: null }
  }

  // Type-based fallback — heals stale/missing active pointers by using the
  // most recently saved preset of the matching type. usePresets appends on
  // save, so the last matching entry is newest.
  const wantedType = TYPE_FALLBACK[step]
  if (wantedType) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.type === wantedType) return { preset: list[i], missingReason: null }
    }
  }

  if (!firstActiveId) return { preset: null, missingReason: `No active preset for ${step}. Open the ${step} page, apply a preset, then retry.` }
  return { preset: null, missingReason: `Active preset for ${step} (${firstActiveId}) not found in saved presets.` }
}

/**
 * Translate a stored preset + episode context into the params shape the
 * generator's job executor expects. Each generator's request body differs,
 * so we branch per step.
 *
 * Crucially, we strip `pipeline_chain` / `pipeline_batch_id` from the
 * resulting params and let the job-queue chain hook re-add them at
 * enqueue time — keeps the caller's chain metadata authoritative.
 */
export function resolveStepParams(
  step: BatchStep,
  episodeId: string,
  title: string,
  preset: StoredPreset | undefined,
  format?: Format | null,
): Record<string, any> {
  // v1.4.73 — a step in NO_PRESET_STEPS reaches here with nothing, because it
  // genuinely has no preset to pick. Reading `.data` off `undefined` threw an
  // "Internal server error" for the whole batch.
  const data = (preset?.data || preset || {}) as Record<string, any>
  if (step === 'broll') {
    const form = data.form || data
    if (form.selection_mode === 'manual') {
      throw new Error('Manual B-Roll selection cannot run unattended. Save a random, tagged, or themed preset for Pipeline.')
    }
    return { ...form, episode_id: episodeId, title: title || '' }
  }
  if (step === 'research') {
    const form = data.form || data
    // A preset saved before web search existed carries no mode, and its
    // `source_provider` can only mean the no-web-access route. Never let an
    // unknown value upgrade an unattended batch into a mode that spends
    // web-search credits.
    const mode = normalizeResearchMode(form.research_mode)
    const allowedDomains = mode === 'web-search' ? normalizeDomainList(form.allowed_domains) : []
    const blockedDomains = mode === 'web-search' ? normalizeDomainList(form.blocked_domains) : []
    return {
      episode_id: episodeId,
      title: title || '',
      topic: title || episodeId,
      source_provider: providerForResearchMode(mode),
      research_mode: mode,
      specific_questions: form.specific_questions || undefined,
      max_sources: Number(form.max_sources) > 0 ? Number(form.max_sources) : 8,
      model: form.source_model || form.model || undefined,
      ...(allowedDomains.length ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains.length ? { blocked_domains: blockedDomains } : {}),
    }
  }
  if (step === 'script-only') {
    // Typed `script` preset (see scripts.vue useScripts presets):
    //   { form: { episode_id, title, length, model, style, chapters, ... },
    //     customStyleText: '…' }
    // Legacy untyped preset still includes `intro` at the root; ignore it
    // here — intro is its own step now.
    const form = data.form || {}
    // CRITICAL: the idea's title must win over whatever stale title was
    // saved into the preset at snapshot time. Without this, every batched
    // episode inherits the preset's original title and the script
    // generator creates "{code} - {stale-title}" folders that don't match
    // the real episode (the duplicate-folders bug from before the typed-
    // preset rollout).
    const { title: _stalePresetTitle, episode_id: _stale, ...restForm } = form
    return {
      ...restForm,
      episode_id: episodeId,
      title: title || form.title || '',
      customStyleText: data.customStyleText ?? form.customStyleText,
    }
  }
  if (step === 'introduction-only') {
    // v1.4.73 — the opening's recipe is no longer read from a preset here.
    //
    // A preset is a snapshot of a moment; the opening is a property of the
    // CHANNEL. Keeping the host name and the beat list in a saved preset meant
    // an unattended batch wrote whatever shape happened to be captured the
    // last time somebody pressed Save, while the Introduction page showed
    // something else. The generator now reads the channel's own recipe
    // (see generators/episode.ts and services/channel-segments.ts), so a batch
    // and a button produce the same opening.
    //
    // What is still passed is what genuinely belongs to this run: which
    // episode, its title, and the language model. Older presets can omit the
    // model — this mapper is a pure/sync transform with no catalog access, so
    // it never invents a model id. An empty model is filled from the script's
    // own model by the run-batch handler, or the step is skipped with a reason.
    return {
      episode_id: episodeId,
      title: title || '',
      model: typeof data.model === 'string' ? data.model.trim() : '',
    }
  }
  if (step === 'image_prompts') {
    // This Pipeline step owns YouTube-thumbnail prompts only. Scene visuals
    // come from Scene Plan and must never be inferred from legacy prompt
    // preset fields.
    const form = data.form || {}
    const {
      title: _t,
      episode_id: _e,
      scenes_per_chapter: _legacyScenesPerChapter,
      total_scenes: _legacyTotalScenes,
      chapter_count: _legacyChapterCount,
      chapter_count_override: _legacyChapterCountOverride,
      scene: _legacySceneSettings,
      ...rest
    } = form

    // Older presets may not contain thumbnail defaults. Heal only fields
    // that remain authoritative for the thumbnail surface.
    const fmtIp = format?.imagePrompts
    if (fmtIp) {
      if (!Number((rest as any).thumb_count) && typeof fmtIp.defaultThumbnails === 'number' &&
          fmtIp.defaultThumbnails > 0) {
        ;(rest as any).thumb_count = fmtIp.defaultThumbnails
      }
      if (!(rest as any).aspect_ratio && typeof fmtIp.recommendedAspect === 'string' &&
          fmtIp.recommendedAspect) {
        ;(rest as any).aspect_ratio = fmtIp.recommendedAspect
      }
    }
    return {
      ...rest,
      episode_id: episodeId,
      title: title || '',
      mode: 'thumbnails',
    }
  }
  if (step === 'thumb_images') {
    const form = data.form || {}
    // Inference steps are not a customer control and are no part of the
    // GenStudio image request. Presets saved by older builds can still carry
    // an obsolete image_steps/image_quality pair on disk; strip them so a
    // saved project keeps working without reviving a retired field.
    const automaticForm = { ...form }
    delete automaticForm.image_steps
    delete automaticForm.image_quality
    // Pipeline-step variant determines mode. Split steps force the
    // corresponding mode regardless of what the preset carries.
    return {
      ...automaticForm,
      episode_id: episodeId,
      mode: 'thumbs',
    }
  }
  if (step === 'audio') {
    const form = { ...(data.form || {}) }
    delete form.max_chunk_chars
    const { sections: _sections, generation_mode: generationMode, ...rest } = form
    const hasGenerationMode = ['skip', 'regenerate', 'new_version'].includes(generationMode)
    return {
      ...rest,
      episode_id: episodeId,
      // Batch audio is episode-level. A section list captured while saving a
      // preset is stale for every later episode and can omit Introduction.
      // `all` plus skip-existing safely generates only files still missing.
      sections: 'all',
      ...(hasGenerationMode ? {
        force: generationMode !== 'skip',
        no_overwrite: generationMode === 'new_version',
      } : {}),
    }
  }
  // audio_merge stores config flat on the preset (no form wrapper):
  //   { id, name, intro, music, background_noise, gap_duration, normalize_volume }
  // The generator is patched to auto-resolve `chapters` from disk when
  // missing, so we deliberately OMIT chapters here — they'll be scanned
  // after the preceding audio step finishes.
  //
  // Volume normalisation: the audio-merge form stores volumes as
  // percentages (0–100, matching its sliders), and the standalone
  // page converts to 0–1 decimals before POSTing — see
  // `audio-merge.vue` (`volume: music.volume / 100`). The backend
  // generator passes those decimals straight to FFmpeg's `volume=`
  // filter, which treats values >1 as amplification. Without the
  // conversion below, a preset saying "music at 30%" reached FFmpeg
  // as `volume=30.00` (30× amplification → clipping → audio sounded
  // like 100%), and a preset at 100% reached as `volume=100.00`.
  // This block mirrors the conversion so batch runs respect presets
  // identically to single-episode runs.
  if (step === 'audio_merge') {
    const pct = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v / 100 : undefined

    const normIntro = data.intro ? {
      ...data.intro,
      ...(data.intro.volume !== undefined ? { volume: pct(data.intro.volume) ?? data.intro.volume } : {}),
    } : undefined
    const normMusic = data.music ? {
      ...data.music,
      ...(data.music.volume !== undefined ? { volume: pct(data.music.volume) ?? data.music.volume } : {}),
      ...(data.music.post_narration_volume !== undefined
        ? { post_narration_volume: pct(data.music.post_narration_volume) ?? data.music.post_narration_volume }
        : {}),
    } : undefined
    const normNoise = data.background_noise ? {
      ...data.background_noise,
      ...(data.background_noise.volume !== undefined
        ? { volume: pct(data.background_noise.volume) ?? data.background_noise.volume }
        : {}),
    } : undefined

    // Multi-track ambient (v1.0.55). The page UI stores volume on a
    // 0-100 scale and divides by 100 before POSTing — the bundle
    // snapshot saves the 0-100 form, so we apply the same conversion
    // here. Filter out empty / disabled rows so half-configured
    // layers don't waste an FFmpeg input slot.
    //
    // v1.0.71+: dropped a defensive `t.volume > 1 ? /100 : t.volume`
    // heuristic that was ambiguous at exactly 1.0 (couldn't tell
    // "100% on 0-1 scale" from "1% on 0-100 scale"). ambient_tracks
    // were always 0-100 in the bundle from v1.0.55 inception — no
    // legacy 0-1 saves to protect — so we now match the unconditional
    // divide-by-100 used by intro / music / background_noise above.
    // Closes the audit's #7 footgun.
    const liveAmbient = Array.isArray(data.ambient_tracks)
      ? (data.ambient_tracks as any[])
        .filter(t => t && t.enabled && t.source_path)
        .map(t => ({
          id: t.id,
          enabled: true,
          source_path: t.source_path,
          volume: typeof t.volume === 'number' && Number.isFinite(t.volume)
            ? Math.max(0, Math.min(1, t.volume / 100))
            : 1,
          fade_in: Math.max(0, Number(t.fade_in) || 0),
          fade_out: Math.max(0, Number(t.fade_out) || 0),
          loop: t.loop !== false,
        }))
      : []

    // Format-aware merge defaults (v1.0.72): if the preset's snapshot
    // predates the format-defaults rollout — or the user saved it before
    // touching those fields — fall back to the channel format's
    // audioMergeDefaults block (sleep-story 5s/no-normalize, listicle
    // tighter values, etc.) instead of letting the route below clamp to
    // the historical hardcoded 5s/no-normalize sleep-story defaults.
    const fmtMerge = format?.script.audioMergeDefaults
    return {
      episode_id: episodeId,
      intro: normIntro,
      music: normMusic,
      background_noise: normNoise,
      ...(liveAmbient.length ? { ambient_tracks: liveAmbient } : {}),
      gap_duration: data.gap_duration ?? fmtMerge?.gapDurationSec,
      normalize_volume: data.normalize_volume ?? fmtMerge?.normalizeVolume,
    }
  }
  if (step === 'metadata') {
    // metadata preset shape: { sections, model?, titleConfig? } from
    // metadata.vue. Older presets omit model. This mapper is a pure/sync
    // preset→params transform with no catalog access, so it never invents
    // a literal external model id here — it passes the saved value through
    // (or '' when absent). An empty model is resolved against GenStudio's
    // live catalog by the async batch runner (resolveDefaultChatModel in
    // this file's run-batch handler) immediately before the job is
    // enqueued, and by generateMetadata itself for non-batch calls.
    //
    // Format-aware defaults (v1.0.69+): pull description size, title count,
    // title length, and tag count from the project's effective Format
    // when available. Sleep-story projects keep their historical 5000 /
    // 5 / 100 / 15; listicle / educational get tighter values out of the
    // box (3500 / 5 / 70 / 12 etc.). Falls back to legacy hardcoded
    // numbers if format resolution fails or the format JSON predates
    // the new defaults block.
    const fmtMeta = format?.metadata
    return {
      episode_id: episodeId,
      title: title || '',
      model: typeof data.model === 'string' ? data.model.trim() : '',
      sections: Array.isArray(data.sections) ? data.sections : [],
      max_chars: fmtMeta?.defaultMaxChars ?? 5000,
      title_count: fmtMeta?.defaultTitleCount ?? 5,
      title_max_length: fmtMeta?.defaultTitleMaxLength ?? 100,
      title_platform_preset: 'Universal',
      tag_count: fmtMeta?.defaultTagCount ?? 15,
    }
  }
  if (step === 'video_assembly') {
    // Video-assembly presets are "bundles" referencing 5 slot presets
    // (intro/timeline/effects/subtitles/export) plus a fallback snapshot
    // containing the full config for each slot. The generator
    // (generators/video.ts) reads its request FLAT at the top level
    // (req.chroma_key, req.video_layout, req.background_plate, …), but
    // the bundle stores fields grouped under those 5 slot keys.
    //
    // Earlier code passed the slots through unchanged — so the generator
    // saw nested `params.effects.chroma_key` etc. at top level, which it
    // simply ignored. Result: every batch render dropped logos, color
    // grading, chroma-key, overlays, ambient music, animated chapter
    // titles, compilation-layout backgrounds, and per-scene chapter
    // alignment. Single-episode renders worked because the page POSTs
    // the flat shape directly.
    //
    // This branch now flattens each slot back to top level, mirroring
    // useVideoAssemblyIo.ts:buildPayload(). Fields are spread only when
    // they're meaningfully populated so the v2-feature paths stay
    // disabled for legacy presets that never set them.
    return flattenVideoAssemblyBundle(data, episodeId, title)
  }
  // ── v1.0.363 audio-paced format steps ──────────────────────────────────
  if (step === 'subtitles') {
    // GenStudio is the sole transcription boundary. Old engine/vsModel preset
    // fields are intentionally ignored so legacy presets heal to the current
    // published catalog instead of reaching a retired provider directly.
    return {
      episode_id: episodeId,
      per_chapter: true,
      engine: 'genstudio',
      model: data.model || undefined,
      ...(typeof data.language === 'string' && data.language.trim()
        ? { language: data.language.trim() }
        : {}),
      force: data.force === true,
    }
  }
  if (step === 'scene_plan') {
    // Pipeline runs deterministic timing followed by required visual packs.
    // Legacy window-size / pass-mode fields are intentionally not forwarded.
    return {
      episode_id: episodeId,
      title: title || '',
      model: data.model,
      use_research: data.use_research !== false,
      detail_level: 4,
      // v1.3.1 — `opening_mode` / `opening_reserved_sec` are no longer taken
      // from the Scene Plan preset. A preset is a reusable creative choice;
      // how long the branded opening runs is a measurable property of the
      // project's own clips, and the preset's remembered copy went stale
      // (the owner's said `from-start` + 15s against a real 10.0s intro,
      // so every scene landed ~10s after its narration). The timeline stage
      // probes the real clips instead — see services/opening-assets.ts.
      // Stored presets keep the two keys; they are simply never read.
      prompt_pack_size: parseScenePromptPackSetting(data.prompt_pack_size),
      prompt_max_tokens: parseScenePromptTokenSetting(data.prompt_max_tokens),
      creative_direction: data.creative_direction && typeof data.creative_direction === 'object'
        ? data.creative_direction : undefined,
      style_prompt: (typeof data.style_prompt === 'string' && data.style_prompt.trim()) ? data.style_prompt.trim() : undefined,
      custom_instructions: (typeof data.custom_instructions === 'string' && data.custom_instructions.trim()) ? data.custom_instructions.trim() : undefined,
    }
  }
  if (step === 'contextual_cues') {
    // Batch runs read the same saved preset the Contextual Cues page writes,
    // so this has to accept everything that page can now save. While it
    // collapsed the two bottom corners to 'top-right', a preset placing cues
    // at the bottom worked by hand and silently moved back to the top the
    // moment it was run from Pipeline.
    return {
      episode_id: episodeId,
      model: typeof data.model === 'string' ? data.model : '',
      density: data.density === 'standard' || data.density === 'editorial' ? data.density : 'restrained',
      placement: normalizeCuePlacement(data.placement),
      ...normalizeCuePositionPair(data.position_x_pct, data.position_y_pct),
      auto_approve: data.auto_approve === true,
    }
  }
  if (step === 'scene_review') {
    // Scene Review is GenStudio-owned text-to-image generation. Story Studio
    // supplies the durable item list; GenStudio owns admission and execution.
    return {
      episode_id: episodeId,
      title: title || '',
      model: data.model,
      aspect_ratio: typeof data.aspect_ratio === 'string' && data.aspect_ratio ? data.aspect_ratio : '16:9',
      seed: Number.isInteger(data.seed) ? data.seed : undefined,
      auto_approve_generated: data.auto_approve_generated === true,
    }
  }
  if (step === 'motion_review') {
    return {
      episode_id: episodeId,
      model: data.model,
      aspect_ratio: typeof data.aspect_ratio === 'string' && data.aspect_ratio ? data.aspect_ratio : undefined,
      operation: data.operation,
      duration_seconds: data.duration_seconds,
      resolution: data.resolution,
      auto_approve_clip: true,
    }
  }
  return { episode_id: episodeId }
}

/**
 * Validate the one subtitles preset against the live catalogue before the
 * Pipeline can enqueue any work. The generator repeats this at execution time
 * because a catalogue can change while a job waits in the queue.
 */
async function resolvePipelineTranscriptionParams(
  preset: StoredPreset,
): Promise<{ model: string; language?: string }> {
  const params = resolveStepParams('subtitles', '', '', preset)
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey.trim()) {
    throw new Error('Transcription is not configured. Add an API key in Settings → This Mac → API Keys.')
  }
  let models: Awaited<ReturnType<typeof listTranscriptionModels>>
  try {
    models = await listTranscriptionModels(apiKey)
  } catch {
    throw new Error('Could not load transcription models. Check your connection and try again.')
  }
  const requestedModel = typeof params.model === 'string' ? params.model.trim() : ''
  const modelId = resolveGenStudioModelId('transcription', requestedModel)
  if (!modelId) throw new Error(unavailableLegacyModelMessage('transcription', requestedModel || '(none)'))
  const selected = models.find(model => model.id === modelId)
  if (!selected) throw new Error(unavailableTranscriptionModelMessage(modelId))
  if (!selected.available) throw new Error('The selected transcription model is temporarily unavailable.')
  if (selected.locked) throw new Error('The selected transcription model is locked for this GenStudio account.')
  const language = resolveTranscriptionLanguage(selected, params.language)
  return { model: selected.id, ...(language ? { language } : {}) }
}

/** Resolve an exact saved Motion Review variant against the live catalogue
 * before Pipeline creates fresh paid work. Historical queue entries retain
 * their executor-only fallback; presets must be re-saved instead. */
async function resolvePipelineMotionParams(
  preset: StoredPreset,
): Promise<{ model: string; operation: string; duration_seconds: number; resolution: string; audio?: boolean }> {
  const params = resolveStepParams('motion_review', '', '', preset)
  const model = typeof params.model === 'string' ? params.model.trim() : ''
  const operation = typeof params.operation === 'string' ? params.operation.trim() : ''
  const duration_seconds = Number(params.duration_seconds)
  const resolution = typeof params.resolution === 'string' ? params.resolution.trim() : ''
  if (!model || !operation || !Number.isFinite(duration_seconds) || duration_seconds <= 0 || !resolution) {
    throw new Error('Open Motion Review, choose a current model and published clip variant, then save the preset again.')
  }
  try {
    const resolved = await requireSceneClipGenStudioModel(model, { operation, duration_seconds, resolution })
    // The preset's saved switch is honoured only when THIS model publishes it. A preset saved
    // against a model that offers the choice must not carry it to a model that does not — the
    // lane would ignore it, and the batch would report a silent clip nobody asked for. A
    // non-boolean is refused rather than coerced: `"false"` is a string, not a request.
    const saved = (preset?.data ?? preset) as Record<string, any>
    const publishesAudio = publishedVideoControls(resolved.model.controls)
      .some(control => control.name === 'audio')
    if (saved.audio !== undefined && typeof saved.audio !== 'boolean') {
      throw new Error('The saved Motion Review preset has a non-boolean audio setting. Open Motion Review and save the preset again.')
    }
    const audio = publishesAudio && typeof saved.audio === 'boolean' ? saved.audio : undefined
    return {
      model: `genstudio-video:${resolved.modelId}`,
      operation: resolved.variant.operation,
      duration_seconds: resolved.variant.duration_seconds,
      resolution: resolved.variant.resolution,
      ...(typeof audio === 'boolean' ? { audio } : {}),
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'The selected Motion Review variant is unavailable.'
    throw new Error(`${detail} Open Motion Review, choose a current published variant, then save the preset again.`)
  }
}

/**
 * Flatten a video_assembly bundle's `fallback` slot snapshots up to the
 * top-level request shape that GenerateVideoRequest expects. Mirrors
 * frontend/composables/useVideoAssemblyIo.ts:buildPayload() — keeping
 * these in sync is essential for batch parity with single-episode
 * runs. Exported for test coverage.
 *
 * Why this exists: the bundle's serialised shape groups fields under
 * 5 slot keys (intro/timeline/effects/subtitles/export); the generator
 * reads them flat. Earlier batches passed the slots through verbatim
 * and the generator silently ignored the unknown nested keys.
 */
export function flattenVideoAssemblyBundle(
  bundleData: any,
  episodeId: string,
  title: string,
): Record<string, unknown> {
  const fb = bundleData?.fallback || {}

  // Legacy-preset passthrough (v1.0.69+). Pre-v1.0.64 video_assembly
  // presets stored fields flat at the top of `data` — there's no
  // `fallback` block at all. The bundle-shape branch below would
  // return only {episode_id, title} for those, silently dropping
  // every effect the user had configured. Detect that shape (no
  // `fallback`, but at least one known generator-shape field at
  // bundleData top level) and pass the flat fields straight through
  // so the batch render keeps the user's intent. We log a one-line
  // notice so the operator knows the preset is on borrowed time and
  // can re-save it via the Video Assembly page to migrate to the
  // bundle shape.
  const isLegacyFlat = !bundleData?.fallback && bundleData && typeof bundleData === 'object' && (
    'logo' in bundleData ||
    'color_grading' in bundleData ||
    'chroma_key' in bundleData ||
    'overlays' in bundleData ||
    'video_layout' in bundleData ||
    'background_plate' in bundleData ||
    'chapter_titles' in bundleData ||
    'transition' in bundleData ||
    'scene_animation' in bundleData ||
    'resolution' in bundleData ||
    'codec' in bundleData
  )
  if (isLegacyFlat) {
    console.warn(
      `[pipeline] video_assembly preset has legacy flat shape (no \`fallback\` block). `
      + `Passing fields through; re-save the preset from the Video Assembly page to migrate to the bundle shape.`,
    )
    const {
      episode_id: _episodeId,
      title: _title,
      render_target: _renderTarget,
      remote_render_requested: _remoteRenderRequested,
      ...rest
    } = bundleData
    return {
      ...rest,
      episode_id: episodeId,
      title: title || '',
    }
  }

  const intro = fb.intro || {}
  const outro = fb.outro || {}
  const timeline = fb.timeline || {}
  const effects = fb.effects || {}
  const subtitles = fb.subtitles || {}
  const exportS = fb.export || {}

  const out: Record<string, unknown> = {
    episode_id: episodeId,
    title: title || '',
  }

  // ── Export settings (flat fields: resolution, quality, fps, codec, …)
  // `aspect_ratio` joined this list in 1.4.19. It shipped on the page in
  // 1.4.15 and was never added here, so every batch render was 16:9 whatever
  // the channel asked for — a one-click Short was impossible, silently.
  for (const k of ['resolution', 'aspect_ratio', 'quality', 'fps', 'encoding_effort', 'codec', 'format']) {
    if (exportS[k] !== undefined) out[k] = exportS[k]
  }
  // ── Timeline slot
  if (timeline.scene_recycling)  out.scene_recycling  = timeline.scene_recycling
  if (timeline.duration)         out.duration         = timeline.duration
  if (timeline.post_audio)       out.post_audio       = timeline.post_audio
  if (timeline.transition?.type !== undefined) {
    out.transition = timeline.transition.type
    out.transition_duration = timeline.transition.type === 'none' ? 0 : (timeline.transition.duration ?? 0)
    if (Array.isArray(timeline.transition.pool)) out.transition_pool = timeline.transition.pool
    if (timeline.transition.randomize_mode) out.transition_randomize = timeline.transition.randomize_mode
  }
  if (timeline.scene_animation) {
    out.scene_animation = timeline.scene_animation
    if (Array.isArray(timeline.scene_animation.pool)) out.animation_pool = timeline.scene_animation.pool
    if (timeline.scene_animation.randomize_mode) out.animation_randomize = timeline.scene_animation.randomize_mode
  }
  // The reveal look is resolved fresh on every render, so a batch that dropped it would render a
  // visibly different episode from the one the panel showed — the drift this flattener exists to
  // prevent. Only the engine's own keys travel; an absent block stays absent (reveals off).
  if (timeline.scene_reveal && typeof timeline.scene_reveal === 'object') {
    out.scene_reveal = timeline.scene_reveal
  }
  if (timeline.title_image?.enabled && timeline.title_image.image_path) {
    out.title_image = timeline.title_image
  }

  // ── Intro / outro slots
  if (intro.enabled && intro.video_path) {
    out.intro = { enabled: true, video_path: intro.video_path }
  }
  if (outro.enabled && outro.video_path) {
    out.outro = { enabled: true, video_path: outro.video_path }
  }
  // v1.3.1 — the user's timeline clips live on the intro slot preset and were
  // being dropped here, so a batch render silently omitted every before_intro
  // / after_intro / after_scenes / after_outro clip a single-episode render
  // included. Same defect class as the flattening bug this function was
  // written to fix, one field short. It also matters for opening timing now:
  // Scene Plan counts the head clips in the reserve, so a batch that dropped
  // them would render a shorter opening than the plan reserved.
  if (Array.isArray(intro.timeline_clips) && intro.timeline_clips.length) {
    out.timeline_clips = intro.timeline_clips
  }

  // ── Effects slot — every field flattened to top level
  if (effects.logo?.enabled && effects.logo.image_path) {
    // Logo opacity/scale on the page are 0-100; the single-episode
    // payload divides by 100. We mirror that conversion here so
    // batch-mode logos render with the same intensity.
    const lg = effects.logo
    out.logo = {
      ...lg,
      opacity: typeof lg.opacity === 'number' && lg.opacity > 1 ? lg.opacity / 100 : lg.opacity,
      scale:   typeof lg.scale   === 'number' && lg.scale   > 1 ? lg.scale   / 100 : lg.scale,
    }
  }
  if (effects.color_grading?.enabled) out.color_grading = effects.color_grading
  if (effects.vignette?.enabled)      out.vignette      = effects.vignette
  if (effects.film_grain?.enabled)    out.film_grain    = effects.film_grain
  if (effects.aged_archive_film?.enabled) out.aged_archive_film = effects.aged_archive_film
  if (effects.letterbox?.enabled)     out.letterbox     = effects.letterbox
  if (effects.frame?.enabled)         out.frame         = effects.frame
  if (effects.chroma_key?.enabled && effects.chroma_key.source_path) {
    out.chroma_key = effects.chroma_key
  }
  if (effects.overlays?.enabled && Array.isArray(effects.overlays.layers)) {
    const liveLayers = effects.overlays.layers.filter(
      (l: any) => l && l.enabled && l.source_path,
    )
    if (liveLayers.length) out.overlays = { enabled: true, layers: liveLayers }
  }
  // Per-scene effects. `snapshotEffectsData` has stored these since 1.2.0 and
  // this function never copied them, so every scene effect the owner picked
  // was dropped from a batch render while a single-episode render applied it.
  // Same shape and same condition as buildPayload: only live overlays, and
  // nothing emitted at all when none are chosen, so an untouched config still
  // produces a byte-identical request.
  if (effects.scene_effects?.enabled && Array.isArray(effects.scene_effects.overlays)) {
    const chosen = effects.scene_effects.overlays.filter((o: any) => o && o.enabled)
    if (chosen.length) {
      out.scene_effects = {
        enabled: true,
        overlays: chosen.map((o: any) => ({ id: o.id, enabled: true, params: { ...(o.params || {}) } })),
      }
    }
  }
  if (effects.chapter_titles)         out.chapter_titles = effects.chapter_titles
  if (typeof effects.exclude_intro_from_effects === 'boolean') {
    out.exclude_intro_from_effects = effects.exclude_intro_from_effects
  }
  if (effects.title_card?.enabled) out.title_card = effects.title_card
  if (effects.outro_card?.enabled) out.outro_card = effects.outro_card

  // ── Compilation layout (v1.0.63). Saved to the effects slot under
  // `compilation_layout`. We flatten its sub-fields to the top-level
  // names the generator reads.
  const cl = effects.compilation_layout
  if (cl?.layout === 'compilation') {
    out.video_layout = 'compilation'
    if (cl.background_plate?.source_path) {
      const bp = cl.background_plate
      out.background_plate = {
        enabled: true,
        source_path: bp.source_path,
        loop: bp.loop !== false,
        opacity: typeof bp.opacity === 'number' ? bp.opacity : 1,
      }
    }
    if (cl.foreground_defaults) {
      out.foreground_defaults = {
        scale_pct: cl.foreground_defaults.scale_pct ?? 0.5,
        position: cl.foreground_defaults.position ?? 'center',
        chroma_key: cl.foreground_defaults.chroma_key ?? null,
      }
    }
  }

  // ── Subtitles slot. The bundle deliberately omits `srt_path`
  // (episode-specific); the generator regenerates it per episode
  // from the merged audio when subtitles.enabled is true.
  if (subtitles.enabled) {
    out.subtitles = {
      enabled: true,
      source: subtitles.source,
      // Missing until 1.4.19: a batch render burned captions over the branded
      // opening even when the channel had asked them to sit it out, while the
      // same episode rendered from the page did not.
      hide_during_intro: !!subtitles.hide_during_intro,
      style: subtitles.style,
    }
  }

  return out
}

/**
 * Build per-episode estimate inputs from the resolved presets so the
 * disk-space precheck can size the batch without scanning each episode's
 * narration / scene assets (those don't exist yet for ungenerated episodes).
 *
 * We pull resolution/quality from the video_assembly preset's `fallback.export`
 * slot (matches the shape used in resolveStepParams), the duration target
 * from the same slot when set to `custom`, and the clip count from the
 * video preset's promptsForm.scene_count. Falls back to defensive defaults
 * when a field is absent — the safety margin in estimateRunBatchBytes
 * absorbs the difference.
 */
/**
 * Pull a named slot ('export'|'timeline'|'effects'|…) out of a stored
 * video_assembly bundle preset. Bundle saves nest fields under
 * `data.fallback.<slot>`; very early presets (and a handful of test
 * fixtures) sometimes store the same shape one level shallower at
 * `data.fallback.<slot>` directly on the preset (no inner data). We
 * accept either, and return `{}` when both miss so callers can pull
 * fields with safe optional chaining.
 */
function extractPresetSlot(preset: StoredPreset | undefined, slot: string): any {
  if (!preset) return {}
  return (preset.data?.fallback?.[slot] ?? preset.fallback?.[slot] ?? {}) as any
}

function extractEstimateInputs(
  presetByStep: Record<BatchStep, StoredPreset>,
  episodeCount: number,
): EpisodeEstimateInputs[] {
  const vaPreset = presetByStep['video_assembly']

  const exportSlot = extractPresetSlot(vaPreset, 'export')
  const resolution = typeof exportSlot.resolution === 'string' ? exportSlot.resolution : undefined
  const quality = typeof exportSlot.quality === 'string' ? exportSlot.quality : undefined

  // Duration: video_assembly preset doesn't carry it (depends on narration);
  // we default to 1 hour inside estimateBytesForStep. If the user pinned a
  // custom duration in the timeline slot, honour the upper bound.
  const timelineSlot = extractPresetSlot(vaPreset, 'timeline')
  let durationSec: number | undefined
  if (timelineSlot?.duration?.mode === 'custom') {
    const max = Number(timelineSlot.duration.max_duration)
    const min = Number(timelineSlot.duration.min_duration)
    if (Number.isFinite(max) && max > 0) durationSec = max
    else if (Number.isFinite(min) && min > 0) durationSec = min
  }

  // Audio: no narration char count available pre-generation. Use the default
  // inside estimateBytesForStep (15k chars) — over-estimating audio by a
  // few MB is harmless next to the GB-scale video numbers. The audio
  // preset isn't read here today; the slot lookup is intentionally absent
  // until per-preset narration char hints get plumbed in.

  const perEpisode: EpisodeEstimateInputs = {
    durationSec,
    resolution,
    quality,
  }
  return Array.from({ length: episodeCount }, () => ({ ...perEpisode }))
}

// v1.0.366 — episodes awaiting Scene Review approval, for the Remote cockpit.
// "Pending" = a scene_plan exists, at least one scene is rendered, and not all
// scenes are approved. Mirrors the per-episode logic in scene-review.ts (count
// approved + rendered), in one call so the cockpit doesn't fan out N requests.
router.get('/projects/:slug/pipeline/pending-approvals', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const ideas = await im.getIdeas(slug, 'accepted')
    const pending: Array<{ episode_id: string; title: string; total: number; approved: number; with_image: number }> = []
    for (const idea of ideas) {
      const code = (idea as any).episode_code
      if (!code) continue
      let paths
      try { paths = await resolveEpisodePathsByCode(slug, code) } catch { continue }
      const planPath = await resolveScenePlanPath(slug, code, paths.episode_dir)
      if (!existsSync(planPath)) continue
      let scenes: any[]
      try { scenes = JSON.parse(await fs.readFile(planPath, 'utf-8'))?.scenes || [] } catch { continue }
      if (!scenes.length) continue
      const approved = scenes.filter(s => s.approved).length
      if (approved >= scenes.length) continue   // fully approved — nothing to do
      // v1.0.457 — count renders in the unified named folder OR the legacy flat
      // folder, so consolidated and not-yet-consolidated episodes both count.
      const namedDir = await resolveSceneImagesDir(slug, code, paths.episode_dir).catch(() => '')
      const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
      const files = new Set<string>()
      if (namedDir && existsSync(namedDir)) for (const f of await fs.readdir(namedDir).catch(() => [] as string[])) files.add(f)
      if (existsSync(legacyDir)) for (const f of await fs.readdir(legacyDir).catch(() => [] as string[])) files.add(f)
      const withImage = scenes.filter(s => files.has(`${s.id}.png`)).length
      if (withImage === 0) continue              // nothing rendered yet — can't approve
      pending.push({ episode_id: code, title: (idea as any).title || code, total: scenes.length, approved, with_image: withImage })
    }
    res.json({ pending })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to compute pending approvals' })
  }
})

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseBatchRequest(body: any): {
  episodeIds: string[]; steps: BatchStep[]; force: boolean; repairMissing: boolean;
  actionId: string; operationId: string; modelPolicies: PipelineModelPolicies; modelPolicyError: string | null
} {
  const episodeIds = Array.isArray(body?.episode_ids) ? body.episode_ids.filter((x: any) => typeof x === 'string' && x) : []
  const stepsRaw: any[] = Array.isArray(body?.steps) ? body.steps : []
  const steps = stepsRaw.filter((s): s is BatchStep => VALID_STEPS.includes(s))
  let modelPolicies: PipelineModelPolicies = {}
  let modelPolicyError: string | null = null
  try {
    modelPolicies = normalizePipelineModelPolicies(body?.model_policies)
  } catch (error: any) {
    modelPolicyError = error?.message || 'Invalid model_policies'
  }
  return {
    episodeIds,
    steps,
    force: body?.force === true,
    repairMissing: body?.repair_missing === true,
    actionId: typeof body?.action_id === 'string' ? body.action_id.trim() : '',
    operationId: typeof body?.operation_id === 'string' ? body.operation_id.trim() : '',
    modelPolicies,
    modelPolicyError,
  }
}

function repairRequestError(request: ReturnType<typeof parseBatchRequest>): string | null {
  if (request.modelPolicyError) return request.modelPolicyError
  if (request.repairMissing) {
    if (request.operationId) return 'operation_id cannot be combined with repair_missing'
    if (!UUID_V4.test(request.actionId)) return 'repair_missing requires a valid action_id UUID'
    if (request.force) return 'repair_missing cannot be combined with force'
    return null
  }
  if (request.actionId) return 'action_id is only valid with repair_missing'
  if (request.force && !UUID_V4.test(request.operationId)) return 'force requires a valid operation_id UUID'
  if (!request.force && request.operationId) return 'operation_id is only valid with force'
  return null
}

async function validatePipelinePoliciesAgainstCatalogue(policies: PipelineModelPolicies): Promise<string | null> {
  if (!Object.keys(policies).length) return null
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) return 'model_policies requires a configured GenStudio API key so each selected product can be checked before submission.'
  let catalogue
  try {
    catalogue = await listChatModels(apiKey)
  } catch {
    return 'model_policies could not be checked against GenStudio’s live language-model catalogue. Nothing was started; retry when the catalogue is reachable.'
  }
  Object.assign(policies, replaceRetiredLineupModels({ pipeline_model_policy: policies }, catalogue).pipeline_model_policy)
  const explicit = Object.fromEntries(Object.entries(policies).filter(([, policy]) => !policy?.wait_for_availability))
  const errors = validatePipelineModelCatalogue(explicit, catalogue)
  const structuredStages = new Set<PipelineModelPolicyStage>(['research', 'image_prompts', 'scene_plan', 'contextual_cues'])
  for (const [stage, policy] of Object.entries(policies) as Array<[PipelineModelPolicyStage, PipelineModelPolicies[PipelineModelPolicyStage]]>) {
    if (!policy) continue
    if (policy.wait_for_availability) {
      const eligible = policy.models.some(modelId => {
        const model = findGenStudioProduct(catalogue, modelId)
        return model && !model.locked && !model.qualification_only
          && (!model.available || (model.max_output_tokens > 0
            && (!structuredStages.has(stage) || (model.supports_structured_output && model.structured_output_mode !== 'none'))))
      })
      if (!eligible) errors.push(`LLM lineup has no published model compatible with ${stage}. Update the lineup before starting this stage.`)
      continue
    }
    for (const modelId of policy.models) {
      const model = findGenStudioProduct(catalogue, modelId)
      if (!model) continue
      if (model.locked === true) {
        errors.push(`model_policies.${stage}: product "${modelId}" is locked for this account`)
      }
      // An unavailable row is retained as an explicit backup candidate: no
      // request will be sent to it now, and GenStudio may publish its limits
      // again before a later retry. Validate submission capabilities only for
      // products that are currently usable.
      if (model.available !== false && (!Number.isInteger(model.max_output_tokens) || model.max_output_tokens < 1)) {
        errors.push(`model_policies.${stage}: product "${modelId}" publishes no usable max_output_tokens for this workflow`)
      }
      if (model.available !== false && structuredStages.has(stage)
        && (model.supports_structured_output !== true || model.structured_output_mode === 'none')) {
        errors.push(`model_policies.${stage}: product "${modelId}" does not publish structured-output support required by this stage`)
      }
    }
  }
  return errors.length ? errors.join('; ') : null
}

async function inheritSavedPipelineLineup(slug: string, parsed: ReturnType<typeof parseBatchRequest>) {
  const lineup = normalizeLlmLineup((await pm.getConfig(slug))?.llm_lineup)
  const inherited = lineupModelPolicies(lineup)
  const stages = new Set<string>(parsed.steps)
  if (stages.has('script-only')) stages.add('introduction-only')
  parsed.modelPolicies = {
    ...Object.fromEntries(Object.entries(inherited).filter(([stage]) => stages.has(stage))),
    ...parsed.modelPolicies,
  }
  return lineup
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function pipelineRepairFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function applyPipelineRepairParams(
  params: Record<string, unknown>, actionId: string, fingerprint: string,
): Record<string, unknown> {
  const repaired = {
    ...params,
    force: false,
    pipeline_repair: { action_id: actionId },
    pipeline_repair_request_fingerprint: fingerprint,
  }
  if ('no_overwrite' in repaired) repaired.no_overwrite = false
  return repaired
}

async function missingSceneIds(slug: string, episodeId: string): Promise<string[] | null> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) return null
  const scenes = JSON.parse(await fs.readFile(planPath, 'utf8'))?.scenes
  if (!Array.isArray(scenes)) return []
  const namedDir = await resolveSceneImagesDir(slug, episodeId, paths.episode_dir).catch(() => '')
  const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
  const missing: string[] = []
  for (const scene of scenes) {
    if (typeof scene?.id !== 'string' || !scene.id) continue
    const named = namedDir ? await isDecodableImage(path.join(namedDir, `${scene.id}.png`)) : false
    const legacy = named ? false : await isDecodableImage(path.join(legacyDir, `${scene.id}.png`))
    const recorded = named || legacy || (typeof scene.image_path === 'string' && await isDecodableImage(scene.image_path))
    if (!recorded) missing.push(scene.id)
  }
  return missing
}

async function pipelineSubtitleRepairComplete(slug: string, episodeId: string): Promise<boolean> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const completion = await inspectSubtitleCompletion(paths.episode_dir, paths.subtitles_dir, episodeId)
  if (
    completion.complete
    && completion.mode === 'full-track'
    && completion.full_track_filename
    && !/_stitched\.(?:srt|ass|vtt)$/i.test(completion.full_track_filename)
  ) return true
  const readiness = await inspectPipelineSubtitleRepairReadiness(
    paths.episode_dir,
    paths.subtitles_dir,
    episodeId,
  )
  if (!readiness.expected_sections.length || readiness.affected_sections.length) return false
  return (await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId)).complete
}

/**
 * v1.4.73 — an unattended run follows the channel's intent, not a checkbox.
 *
 * A channel that says it opens with an Introduction gets one on every episode
 * this batch writes. It used to be a separate box that had to be ticked on
 * every run, sitting next to the Script box, and forgetting to tick it is how
 * four episodes reached paid audio with no opening at all.
 *
 * Deliberately narrow: it attaches to a run that WRITES THE SCRIPT, because
 * that is the run that produces the episode. A batch re-rendering audio for
 * finished episodes is not producing episodes and must not silently grow an
 * extra language-model call. The opening also has to come after the chapters
 * it introduces, which is why it is inserted directly behind them rather than
 * appended.
 *
 * The same function serves preflight and the run itself, so what the page is
 * told a run will produce is what the run produces.
 */
export async function applyChannelSegmentIntent(slug: string, steps: BatchStep[]): Promise<BatchStep[]> {
  if (!steps.includes('script-only')) return steps
  if (steps.includes('introduction-only')) return steps
  const { channelWantsIntroduction } = await import('../services/channel-segments.js')
  if (!await channelWantsIntroduction(slug)) return steps
  const out = [...steps]
  out.splice(out.indexOf('script-only') + 1, 0, 'introduction-only')
  return out
}

router.post('/projects/:slug/pipeline/preflight', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const parsed = parseBatchRequest(req.body)
  await inheritSavedPipelineLineup(slug, parsed)
  const { episodeIds, steps: requestedSteps, force } = parsed
  const requestError = repairRequestError(parsed)
  if (requestError) return res.status(400).json({ detail: requestError })
  const policyError = await validatePipelinePoliciesAgainstCatalogue(parsed.modelPolicies)
  if (policyError) return res.status(422).json({ detail: policyError })
  if (!episodeIds.length) return res.status(400).json({ detail: 'episode_ids must be a non-empty array' })
  if (!requestedSteps.length) return res.status(400).json({ detail: 'steps must include at least one valid pipeline step' })
  const steps = await applyChannelSegmentIntent(slug, requestedSteps)
  try {
    const result = await preflightBatch(slug, episodeIds, steps, force)
    const { globalIssues, blocked } = splitPreflightIssues(result.issues)
    const eligible_episode_ids = eligibleEpisodeIds(episodeIds, blocked)
    const canSubmit = globalIssues.length === 0 && eligible_episode_ids.length > 0
    res.status(canSubmit ? 200 : 422).json({
      ok: canSubmit,
      issues: result.issues,
      blocked,
      eligible_episode_ids,
      warnings: result.warnings,
      estimated_bytes: result.estimatedBytes,
      free_bytes: result.freeBytes,
      episodes: episodeIds.length,
      steps: steps.length,
    })
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Pipeline preflight failed' })
  }
})

async function runBatch(req: Request<{ slug: string }>, res: Response) {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const parsed = parseBatchRequest(req.body)
  const lineup = await inheritSavedPipelineLineup(slug, parsed)
  const { episodeIds: episode_ids, steps: requestedSteps, force, repairMissing, actionId, operationId, modelPolicies } = parsed
  const requestError = repairRequestError(parsed)
  if (requestError) return res.status(400).json({ detail: requestError })
  const policyError = await validatePipelinePoliciesAgainstCatalogue(modelPolicies)
  if (policyError) return res.status(422).json({ detail: policyError })
  // `force: true` disables per-step idempotency skipping — every selected
  // step runs even if its output already exists. Default is to skip done
  // steps so the batch doesn't silently burn tokens on regeneration.
  if (!episode_ids.length) return res.status(400).json({ detail: 'episode_ids must be a non-empty array' })
  if (!requestedSteps.length) return res.status(400).json({ detail: 'steps must include at least one of ' + VALID_STEPS.join(', ') })
  const steps = await applyChannelSegmentIntent(slug, requestedSteps)

  const preflight = await preflightBatch(slug, episode_ids, steps, force)
  const { globalIssues, blocked } = splitPreflightIssues(preflight.issues)
  let currentIssues = preflight.issues
  let currentBlocked = blocked
  let eligible_episode_ids = eligibleEpisodeIds(episode_ids, currentBlocked)
  if (globalIssues.length || !eligible_episode_ids.length) {
    return res.status(400).json({
      detail: preflight.issues.length === 1
        ? `${preflight.issues[0]!.message} Nothing was started.`
        : 'Pipeline preflight found blocking problems. Nothing was started.',
      issues: preflight.issues,
      blocked: currentBlocked,
      eligible_episode_ids,
      missing: preflight.issues.filter(i => i.code === 'missing_preset').map(i => ({ step: i.step, reason: i.message })),
      warnings: preflight.warnings,
      free_bytes: preflight.freeBytes,
      required_bytes: preflight.estimatedBytes,
      episodes: episode_ids.length,
      steps: steps.length,
    })
  }
  const presetByStep = preflight.presetByStep as Record<BatchStep, StoredPreset>
  const ideaByCode = preflight.ideaByCode
  const effectiveFormat = preflight.effectiveFormat

  // The `metadata` preset can omit a saved model (legacy presets, or ones
  // that never set one). resolveStepParams is a pure/sync mapper with no
  // catalog access, so it leaves `model` empty in that case instead of
  // inventing a literal id. Resolve the live-catalog default ONCE per batch
  // run here (this handler is async and already holds the GenStudio key) so
  // every episode that needs it gets the same current product. A catalog
  // failure never falls back to a hardcoded id — affected steps are
  // individually skipped below with a clear reason.
  //
  // `introduction-only` is deliberately NOT in this list. Its model comes from
  // the channel's own choice or, failing that, from the Script Generator. A
  // catalogue default here would not be a fallback for a missing preference —
  // it would silently override a model the operator did choose. It reads
  // `preflight.introductionChatModel` / `preflight.scriptSideChatModel`.
  let batchDefaultChatModel: string | null = null
  if (presetByStep.metadata) {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (apiKey) {
      batchDefaultChatModel = await resolveDefaultChatModel(apiKey).then(r => r.modelId).catch(() => null)
    }
  }

  let pipelineTranscriptionParams: { model: string; language?: string } | null = null
  if (presetByStep.subtitles) {
    try {
      pipelineTranscriptionParams = await resolvePipelineTranscriptionParams(presetByStep.subtitles)
    } catch (error: unknown) {
      return res.status(400).json({
        detail: `${error instanceof Error ? error.message : 'Select a current transcription model and published language.'} Nothing was started.`,
      })
    }
  }

  let pipelineMotionParams: { model: string; operation: string; duration_seconds: number; resolution: string; audio?: boolean } | null = null
  if (presetByStep.motion_review) {
    try {
      pipelineMotionParams = await resolvePipelineMotionParams(presetByStep.motion_review)
    } catch (error: unknown) {
      return res.status(400).json({
        detail: `${error instanceof Error ? error.message : 'Select a current Motion Review variant.'} Nothing was started.`,
      })
    }
  }

  const actionFingerprint = repairMissing || force ? pipelineRepairFingerprint({
    slug,
    episode_ids: [...new Set(episode_ids)].sort(),
    steps,
    presets: Object.fromEntries(steps.map(step => [step, presetByStep[step] || null])),
    effective_format: effectiveFormat,
    transcription: pipelineTranscriptionParams,
    motion: pipelineMotionParams,
    default_chat_model: batchDefaultChatModel,
    introduction_chat_model: preflight.introductionChatModel,
    script_chat_model: preflight.scriptSideChatModel,
    model_policies: modelPolicies,
    visual_settings: Object.fromEntries(
      [...preflight.visualSettingsByEpisode.entries()].map(([episodeId, settings]) => [episodeId, settings]),
    ),
  }) : ''
  const batch_id = repairMissing ? actionId : force ? operationId : randomUUID()
  const existingActionJobs = repairMissing || force
    ? (await jq.getJobs(slug)).filter(job => repairMissing
      ? job.params?.pipeline_repair?.action_id === actionId
      : job.params?.generation_action?.id === operationId)
    : []
  if (existingActionJobs.some(job => repairMissing
    ? job.params?.pipeline_repair_request_fingerprint !== actionFingerprint
    : job.params?.generation_action_fingerprint !== actionFingerprint)) {
    return res.status(409).json({ detail: 'This action id already belongs to different episodes, stages, or resolved settings.' })
  }
  const existingActionByEpisode = new Map(existingActionJobs.map(job => [job.episode_id, job]))
  const enqueued: Array<{ episode_id: string; job_id: string; type: JobType }> = []
  const reused: Array<{ episode_id: string; job_id: string; type: JobType }> = []
  const skipped: Array<{ episode_id: string; reason: string }> = []
  // Per-episode per-step skips — steps that were in `steps` but whose
  // output already exists. Populated only when `force` is falsy.
  const steps_skipped_as_done: Array<{ episode_id: string; step: BatchStep }> = []
  const steps_skipped_as_inapplicable: Array<{ episode_id: string; step: BatchStep }> = []
  // Running total of actually-enqueued step count across all episodes,
  // used for the response's `total_jobs_planned` so the number reflects
  // what'll really run (not `episodes × steps`).
  let totalEnqueuedStepCount = 0
  // Character-sheet applies are config writes, not jobs — counted separately
  // so the response can report "wrote continuity.json for N episode(s)".
  let characterSheetsApplied = 0

  // The preflight is a preview, not queue authority. Check the verified
  // upload-backed cleanup record again immediately before dispatch so an
  // ordinary batch cannot race a completed local-media cleanup into an
  // unrequested regeneration. Force runs stay deliberate and continue to the
  // normal prerequisite checks above.
  if (!force) {
    const retiredAtDispatch = await retiredUploadedMediaByEpisode(slug, eligible_episode_ids)
    const dispatchIssues = [...retiredAtDispatch.entries()]
      .map(([episodeId, status]) => retiredLocalMediaIssue(episodeId, status))
    if (dispatchIssues.length) {
      currentIssues = [...currentIssues, ...dispatchIssues]
      currentBlocked = splitPreflightIssues(currentIssues).blocked
      eligible_episode_ids = eligibleEpisodeIds(episode_ids, currentBlocked)
      if (!eligible_episode_ids.length) {
        return res.status(400).json({
          detail: dispatchIssues.length === 1
            ? `${dispatchIssues[0]!.message} Nothing was started.`
            : 'Pipeline found media cleaned after preflight. Nothing was started.',
          issues: currentIssues,
          blocked: currentBlocked,
          eligible_episode_ids,
          warnings: preflight.warnings,
          free_bytes: preflight.freeBytes,
          required_bytes: preflight.estimatedBytes,
          episodes: episode_ids.length,
          steps: steps.length,
        })
      }
    }
  }

  for (const episodeId of eligible_episode_ids) {
    const idea = ideaByCode.get(episodeId)
    if (!idea) {
      skipped.push({ episode_id: episodeId, reason: 'Not found among accepted ideas' })
      continue
    }
    const existingAction = existingActionByEpisode.get(episodeId)
    if (existingAction) {
      reused.push({ episode_id: episodeId, job_id: existingAction.job_id, type: existingAction.type })
      continue
    }
    let visualSettings = preflight.visualSettingsByEpisode.get(episodeId)!
    const applicability = applicablePipelineStepsForVisualSource(steps, visualSettings.visual_source)
    for (const step of applicability.inapplicable) {
      steps_skipped_as_inapplicable.push({ episode_id: episodeId, step })
    }

    // v1.0.761 — Pipeline auto-completion of the claim review. An unattended
    // run must never stall on "research exists but its claims still need a
    // decision", and it must not burn a paid research call just to re-earn a
    // review for evidence already on disk. So before the idempotency check,
    // accept any claims still pending — recorded as `pipeline-auto`, never
    // `human`. A fresh generation inside this batch is auto-completed by the
    // generator itself (it sees pipeline_batch_id). `force` skips this: the
    // sidecar is about to be regenerated anyway.
    if (!force && steps.includes('research')) {
      await autoCompleteResearchReviewForPipeline(slug, episodeId)
    }

    // Idempotency: drop steps whose outputs are already on disk. Keeps
    // batches cheap on partially-generated episodes. The user can opt out
    // with `force: true` to regenerate everything.
    let effectiveSteps: BatchStep[] = applicability.applicable
    if (!force) {
      const status = await computeEpisodeStatus(slug, episodeId)
      const repairSubtitlesComplete = repairMissing && steps.includes('subtitles')
        ? await pipelineSubtitleRepairComplete(slug, episodeId)
        : null
      effectiveSteps = effectiveSteps.filter(step => {
        const done = repairSubtitlesComplete != null && step === 'subtitles'
          ? repairSubtitlesComplete
          : isStepAlreadyDone(status, step, effectiveFormat)
        if (done) {
          steps_skipped_as_done.push({ episode_id: episodeId, step })
          return false
        }
        return true
      })
    }

    // Character Sheet is config-only (no job). Apply the saved continuity_page
    // preset to continuity.json NOW — synchronously, before any chain job runs
    // — so scene_plan / scene_review downstream see the anchor config on disk.
    // It's then dropped from the job chain below (never enqueued).
    if (effectiveSteps.includes('character_sheet')) {
      try {
        const csPreset = presetByStep['character_sheet']
        const csData = (csPreset?.data ?? csPreset) as Partial<ContinuityConfig>
        const projectMeta = await pm.getProject(slug)
        const continuityMode = projectMeta?.continuity_mode || 'independent-stills'
        const episodePaths = await resolveEpisodePathsByCode(slug, episodeId)
        const currentConfig = await readPipelineContinuityConfig(
          episodePaths.episode_dir,
          continuityMode,
        )
        await writeContinuityConfig(
          slug,
          episodeId,
          applyContinuityPresetForPipeline(currentConfig, csData),
          continuityMode,
        )
        characterSheetsApplied++
        const refreshedSource = await readVideoVisualSource(slug, episodeId)
        if (refreshedSource.source !== visualSettings.visual_source) {
          throw new Error('visual source changed while Pipeline was preparing this episode; submit it again')
        }
        visualSettings = await pipelineVisualSettingsSnapshot(
          slug,
          episodeId,
          refreshedSource,
          true,
          effectiveSteps.includes('motion_review') && !effectiveSteps.includes('scene_plan'),
        )
      } catch (e: any) {
        skipped.push({ episode_id: episodeId, reason: `character sheet apply failed: ${e?.message || e}` })
        continue
      }
    }

    // Build the job chain. Two transforms vs the raw step list:
    //   • script-only expands into the outline-first pair outline_only →
    //     expand_chapters (both auto-approved) — exactly what the Scripts page
    //     runs by hand, and the path the user gets 100% acceptance on.
    //   • character_sheet is dropped (applied inline above, not a job).
    const chain: Array<{ type: JobType; title: string; params: Record<string, any> }> = []
    let pausedForCueReview = false
    for (const step of effectiveSteps) {
      if (step === 'character_sheet') continue
      if (step === 'broll') {
        const brollParams = resolveStepParams('broll', episodeId, idea.title || '', presetByStep.broll, effectiveFormat)
        chain.push({ type: 'broll_select', title: `[batch] broll selection — ${episodeId}`, params: brollParams })
        chain.push({
          type: 'broll_assemble',
          title: `[batch] broll assembly — ${episodeId}`,
          params: { episode_id: episodeId, title: idea.title || '', broll_volume: brollParams.broll_volume || 0 },
        })
        continue
      }
      if (step === 'script-only') {
        const outlineParams = resolveStepParams('script-only', episodeId, idea.title || '', presetByStep['script-only'], effectiveFormat)
        const scriptPolicy = modelPolicies['script-only']
        const assignedScriptPolicy = scriptPolicy
          ? assignedPipelinePolicy('script-only', episodeId, scriptPolicy)
          : null
        if (assignedScriptPolicy) {
          outlineParams.model = assignedScriptPolicy.assigned_model
          outlineParams.pipeline_model_policy = { 'script-only': assignedScriptPolicy }
        }
        const episodePaths = await resolveEpisodePathsByCode(slug, episodeId)
        const completion = await inspectChunkedScriptCompletion(episodePaths.script_dir, episodeId)
        if (completion.resumable) {
          // An approved outline plus partial chapter files is recoverable.
          // Resume only missing work; rebuilding the outline could discard
          // reviewed creative decisions and spend unnecessary credits.
          chain.push({ type: 'expand_chapters' as JobType, title: `[batch] repair chapters — ${episodeId}`, params: { episode_id: episodeId, title: idea.title || '', model: outlineParams.model, auto_approve: true, ...(outlineParams.pipeline_model_policy ? { pipeline_model_policy: outlineParams.pipeline_model_policy } : {}) } })
        } else {
          chain.push({ type: 'outline_only' as JobType, title: `[batch] outline — ${episodeId}`, params: { ...outlineParams, auto_approve: true } })
          chain.push({ type: 'expand_chapters' as JobType, title: `[batch] chapters — ${episodeId}`, params: { episode_id: episodeId, title: idea.title || '', model: outlineParams.model, auto_approve: true, ...(outlineParams.pipeline_model_policy ? { pipeline_model_policy: outlineParams.pipeline_model_policy } : {}) } })
        }
        continue
      }
      const jobType = jobTypeForStep(step)
      const jobTitleStep = step === 'image_prompts' ? 'thumbnail_prompts' : step
      // A stored preset holding a value the resolvers cannot honour (today:
      // only a malformed `prompt_pack_size`) is SKIPPED and named, not quietly
      // repaired into some other number and not allowed to 500 the whole batch
      // enqueue. The operator sees exactly which episode and why.
      let params: Record<string, any>
      try {
        params = resolveStepParams(step, episodeId, idea.title || '', presetByStep[step], effectiveFormat)
      } catch (error: any) {
        skipped.push({
          episode_id: episodeId,
          reason: `${step}: ${error?.message || String(error)} Fix the saved preset for this step, then run the batch again.`,
        })
        continue
      }
      const policyStage = step as PipelineModelPolicyStage
      const stepPolicy = modelPolicies[policyStage]
      if (stepPolicy) {
        const assigned = assignedPipelinePolicy(policyStage, episodeId, stepPolicy)
        params.model = assigned.assigned_model
        params.pipeline_model_policy = { [policyStage]: assigned }
      }
      if (step === 'subtitles' && pipelineTranscriptionParams) {
        Object.assign(params, pipelineTranscriptionParams)
      }
      if (repairMissing && step === 'scene_review') {
        // When this chain rebuilds Scene Plan, let the renderer derive its IDs
        // from that new plan at execution time rather than freezing stale IDs.
        const sceneIds = effectiveSteps.includes('scene_plan')
          ? null
          : await missingSceneIds(slug, episodeId)
        if (sceneIds?.length === 0) {
          // `continue`, not `break`. This reason is about the scene_review step
          // alone — the images are already there, so there is nothing for it to
          // render. Breaking out of the STEP loop instead dropped every later
          // selected step for this episode (video_assembly, upload, …) without
          // enqueueing it and without saying so: the batch still answered 201
          // carrying only this one skip reason. Every sibling exit in this loop
          // is a `continue` (the preset failure above, introduction-only below,
          // metadata below); this was the only `break`.
          skipped.push({
            episode_id: episodeId,
            reason: 'Scene images are present; review and approve them in Scene Review. The remaining selected steps for this episode are unaffected.',
          })
          continue
        }
        params.missing_only = true
        if (sceneIds) params.scene_ids = sceneIds
        params.manual_image_finish = { action_id: actionId, replace_uncertain: false }
      }
      if (step === 'motion_review' && pipelineMotionParams) {
        Object.assign(params, pipelineMotionParams)
      }
      if (step === 'introduction-only') {
        // Same three sources, same order, as `POST /generate/introduction-only`:
        // the channel's own saved choice, then anything carried on this step,
        // then the Script Generator's model. Never a catalogue default — the
        // operator cannot tell an invented model from one he picked, and this
        // step would quietly run on a different product from every other step
        // in the same batch.
        const resolved = params.pipeline_model_policy
          ? params.model
          : preflight.introductionChatModel
            || params.model
            || preflight.scriptSideChatModel
        if (!resolved) {
          skipped.push({
            episode_id: episodeId,
            reason: 'introduction-only: this channel\'s opening follows the Script Generator\'s language ' +
              'model, and no active script preset carries one. Either choose a model for the opening on the ' +
              'Introduction page, or open Script Generator, choose a model under Main settings and save the ' +
              'script preset. No model was substituted.',
          })
          continue
        }
        params.model = resolved
      }
      if (step === 'metadata' && !params.model) {
        if (!batchDefaultChatModel) {
          skipped.push({
            episode_id: episodeId,
            reason: `${step}: no model saved in the preset and GenStudio's live language-model catalog is unavailable. ` +
              'Open the preset, choose a current model, and save it again, or configure a GenStudio API key.',
          })
          continue
        }
        params.model = batchDefaultChatModel
      }
      chain.push({
        type: jobType,
        title: `[batch] ${jobTitleStep} — ${episodeId}`,
        params,
      })
      // Editorial review is a deliberate pipeline handoff, never an implicit
      // background approval. A trusted contextual-cue preset may opt into
      // auto-approval; only then can later image/video stages continue.
      if (step === 'contextual_cues' && params.auto_approve !== true) {
        pausedForCueReview = true
        break
      }
    }

    // Every link carries the same immutable episode decision. Later settings
    // edits cannot retarget a queued chain or widen its motion work.
    for (const link of chain) link.params = { ...link.params, ...visualSettings }

    if (repairMissing) {
      for (const link of chain) {
        link.params = applyPipelineRepairParams(link.params, actionId, actionFingerprint)
      }
    } else if (force) {
      for (const link of chain) {
        link.params = {
          ...link.params,
          force: true,
          generation_action: { id: operationId, kind: 'fresh' },
          generation_action_fingerprint: actionFingerprint,
        }
      }
    }

    // Nothing to enqueue. If the only selected work was the inline character
    // sheet, that's NOT a skip — we did do the work. Otherwise every step was
    // skipped-as-done, so record the skip.
    if (chain.length === 0) {
      if (!effectiveSteps.includes('character_sheet')
        && !applicability.inapplicable.length
        && !skipped.some(item => item.episode_id === episodeId)) {
        skipped.push({ episode_id: episodeId, reason: 'All selected steps already complete' })
      }
      continue
    }

    // Freeze the complete run before any asynchronous handoff or config edit.
    const [first, ...rest] = chain.map(step => ({
      ...step, params: applyLlmLineupSnapshot(step.type, episodeId, step.params, lineup),
    }))

    // Scene Review and Pipeline share one episode-wide render owner. If the
    // user already started images from Scene Review, join this Pipeline's
    // remaining steps to that active job instead of submitting the same scene
    // set again.
    if (first.type === 'continuity_render' && !first.params.single_scene_id) {
      const joined = await jq.joinActiveBulkSceneRender({
        project_slug: slug,
        episode_id: episodeId,
        pipeline_chain: rest,
        pipeline_batch_id: batch_id,
      })
      if (joined?.conflict) {
        skipped.push({ episode_id: episodeId, reason: 'An existing scene render already belongs to another Pipeline run' })
        continue
      }
      if (joined) {
        reused.push({ episode_id: episodeId, job_id: joined.job.job_id, type: joined.job.type })
        totalEnqueuedStepCount += rest.length
        continue
      }
    }

    // Duplicate guard: skip this episode entirely if its first step is
    // already queued/running. The user can see the existing job in the
    // Jobs tab; silently piling another one on is worse UX than a skip.
    if (jq.isDuplicate(slug, episodeId, first.type)) {
      skipped.push({ episode_id: episodeId, reason: `${first.type} already queued/running` })
      continue
    }

    let cleanupAdmissionIssue: PreflightIssue | null = null
    let job: Awaited<ReturnType<typeof jq.enqueue>>
    try {
      job = await jq.enqueue({
        project_slug: slug,
        type: first.type,
        episode_id: episodeId,
        title: first.title,
        params: {
          ...first.params,
          pipeline_chain: rest,
          pipeline_batch_id: batch_id,
        },
      }, {}, force ? undefined : async () => {
        const status = await readLocalMediaCleanupStatus(slug, episodeId)
        if (status.has_retired_media || status.blocked_reason) {
          cleanupAdmissionIssue = retiredLocalMediaIssue(episodeId, status)
          throw new Error(cleanupAdmissionIssue.message)
        }
      })
    } catch (error) {
      if (!cleanupAdmissionIssue) throw error
      currentIssues.push(cleanupAdmissionIssue)
      currentBlocked = splitPreflightIssues(currentIssues).blocked
      continue
    }
    enqueued.push({ episode_id: episodeId, job_id: job.job_id, type: first.type })
    totalEnqueuedStepCount += chain.length
    if (pausedForCueReview) {
      job.output_lines.push('Pipeline will pause after Contextual Cues. Review and resolve the cue timeline, then run the remaining stages when ready.')
    }
  }

  res.status(201).json({
    batch_id,
    enqueued: enqueued.length,
    reused: reused.length,
    total_jobs_planned: totalEnqueuedStepCount,
    character_sheets_applied: characterSheetsApplied,
    skipped,
    blocked: currentBlocked,
    issues: currentIssues,
    steps_skipped_as_done,
    steps_skipped_as_inapplicable,
    jobs: enqueued,
    reused_jobs: reused,
    steps,
    force,
  })
}

router.post('/projects/:slug/pipeline/run-batch', async (req, res) => {
  const parsed = parseBatchRequest(req.body)
  const requestError = repairRequestError(parsed)
  if (requestError) return res.status(400).json({ detail: requestError })
  if (parsed.repairMissing) return withLock(`pipeline-repair:${req.params.slug}:${parsed.actionId}`, () => runBatch(req, res))
  if (parsed.force) return withLock(`pipeline-force:${req.params.slug}:${parsed.operationId}`, () => runBatch(req, res))
  return runBatch(req, res)
})
