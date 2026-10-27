/**
 * Pipeline batch runner.
 *
 * Lets the user kick off a chain (script → images → audio → audio_merge)
 * for many accepted ideas at once, using each generator's last-used preset
 * for that step's settings. Designed for overnight runs: one click, walk
 * away. The job-queue chain hook in services/job-queue.ts handles the
 * hand-off between steps on successful completion.
 */

import { paidFallbacksWarning, getDefaultModels, type DefaultModelFamily } from '../services/app-settings.js'
import { percentGainToLinear, percentGainToUnitLinear } from '../lib/audio-gain.js'
import { Router, type Request, type Response } from 'express'
import { createHash, randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import { episodeIsIntroEligible } from '../lib/episode-creation-facts.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import type { ContinuityConfig, Format, JobType, ProjectMeta, VideoPostAudio } from '../models/types.js'
import type { EpisodeStatus } from '../services/asset-status.js'
import { episodeStatusCache } from '../services/episode-status-cache.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { buildContinuityConfig, defaultContinuityConfig, writeContinuityConfig } from './continuity.js'
import { readProjectStartingPacing } from '../services/formula-starting-defaults.js'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import {
  createProjectFactsCache,
  projectMetaOnce,
  resolveEpisodePathsByCode,
  resolveScenePlanPath,
  type ProjectFactsCache,
} from '../services/utils.js'
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
import { listImageModels, listTranscriptionModels, publishedVideoControls } from '../lib/genstudio-client.js'
import { resolveTranscriptionLanguage } from '../generators/subtitles.js'
import { requireSceneClipGenStudioModel } from '../generators/scene-clip.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage, unavailableTranscriptionModelMessage } from '../services/genstudio-model-migration.js'
import { withLock } from '../lib/atomic-store.js'
import { stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import { autoApproveOn, resolveExactPreset, resolveScenePlanPromptCharCap, scenePlanPresetReceipt, thumbnailPromptPresetCapInputs } from '../services/preset-authority.js'
import {
  noThumbnailModelMessage,
  thumbnailGeneratorModelFromPreset,
  thumbnailPromptsModelFromPreset,
  type ThumbnailStep,
} from '../services/thumbnail-presets.js'
import { resolveLiveImagePromptCharCap } from '../services/image-prompt-cap.js'
import { pipelineStepLabel } from '../lib/pipeline-continuation.js'
import { SAFETY_CHECKS, safetyMode, safetyModeFromConfig } from '../services/safety-checks.js'
import { isDecodableImage } from '../lib/image-validation.js'
import {
  inspectPipelineSubtitleRepairReadiness,
  inspectSubtitleCompletion,
} from '../services/subtitle-completion.js'
import { readSubtitleTimelineIntegrity } from '../services/scene-timeline-integrity.js'
import { readVideoVisualSource, resolveImagePoolSelection } from '../services/video-visual-source.js'
import type { VideoVisualSource } from '../services/video-visual-source.js'
import { parseScenePacing, type ScenePacing } from '../contracts/pacing.js'
import type { MotionScope } from '../contracts/motion-scope.js'
import { readEpisodeMotionScope, resolveEpisodeMotionSceneIds } from '../services/episode-motion-scope.js'
import { motionSceneIdsForNewRequest } from '../services/scene-motion-prompt-scope.js'
import { resolveSketchDrawEligibleScenes } from './scene-review.js'
import { mapWithConcurrency as mapEpisodes } from '../lib/map-with-concurrency.js'
import { describeEffectStack, duplicatePresetHints, normalizeEffectsLook } from '../contracts/effects-look.js'
import { NARRATION_ONLY_RENDER_KEYS } from '../services/music-episode.js'
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
//                        run-batch loop, never enqueued. The preset's LOOK is
//                        applied; the episode's rhythm is not — `pacing` is
//                        excluded from this preset (owner, 2026-10-17) and
//                        Scene Plan's "Visual timing & motion" owns it. See
//                        applyContinuityPresetForPipeline.
// The `script-only` step is also expanded, at chain-build time, into the
// outline-first pair `outline_only` → `expand_chapters` (both auto-approved)
// to match what the Scripts page actually runs by hand.
type BatchStep =
  | 'research'
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
  // Music channels (SPEC phase 4): Episode Builder's draw (when the episode has no songs yet) + stitch.
  | 'music_build'
// v1.0.373+: Pipeline only exposes split scene/thumbnail image steps. The
// legacy unified `images` job type can still exist in old job history, but
// run-batch no longer accepts it as a step because it can merge scenes and
// thumbnails into one provider run.
export const VALID_STEPS: BatchStep[] = ['research', 'script-only', 'introduction-only', 'image_prompts', 'thumb_images', 'audio', 'audio_merge', 'metadata', 'subtitles', 'scene_plan', 'contextual_cues', 'scene_review', 'motion_review', 'character_sheet', 'video_assembly', 'music_build']

/**
 * A music channel's chain (SPEC phase 4): Episode Builder draw + stitch → scene pictures on the fleet
 * → Video Assembly with the episode's music settings → thumbnail → YouTube Finalizer. Nothing else
 * applies to a channel with no narration, and `music_build` applies to nothing else.
 */
export const MUSIC_STEPS: readonly BatchStep[] = ['music_build', 'scene_review', 'video_assembly', 'thumb_images', 'metadata']

// A few Pipeline step ids don't equal their generator's JobType (the id the
// job queue keys its lane + executor on). Any step NOT listed here enqueues
// under its own id, which IS a valid JobType + lane. Steps listed here MUST be
// translated before jq.enqueue() — otherwise enqueue pushes to a non-existent
// queue lane (`queues[type].pending`) and throws a TypeError, which surfaces to
// the user as "Scene Review always errors out". (scene_review runs the
// GenStudio-owned image batch.)
export const STEP_JOB_TYPE: Partial<Record<BatchStep, JobType>> = {
  research: 'research_run',
  subtitles: 'subtitles_transcribe',
  scene_plan: 'scene_plan_run',
  contextual_cues: 'contextual_cues',
  scene_review: 'continuity_render',
  motion_review: 'scene_clips_batch',
  music_build: 'music_episode_build',
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
// `music_build` is set by the episode itself (Episode Builder settings + the channel formula).
const NO_PRESET_STEPS = new Set<BatchStep>(['introduction-only', 'music_build'])
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
export const PRESET_KEYS: Record<BatchStep, { list: string | string[]; activeKeys: string[] }> = {
  research:            { list: 'research_presets',         activeKeys: ['research_last_preset_research', 'research_last_preset'] },
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
  // Inert: `music_build` is in NO_PRESET_STEPS (its settings live on the episode).
  music_build:         { list: 'music_build_presets',      activeKeys: [] },
}

interface StoredPreset { id: string; name: string; data?: any; type?: string; [k: string]: any }

interface PreflightIssue {
  code: 'episode_not_accepted' | 'missing_preset' | 'invalid_preset' | 'missing_voice' | 'missing_prerequisite' | 'missing_local_asset' | 'retired_local_media' | 'insufficient_disk' | 'captions_missing' | 'closing_tail_unsafe'
  message: string
  episode_id?: string
  step?: BatchStep
  /** For missing_prerequisite: the step it needs (machine-readable; the message is for people). */
  requires?: BatchStep
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

const PREFLIGHT_CONCURRENCY = 8

const mapWithConcurrency = <T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> =>
  mapEpisodes(items, PREFLIGHT_CONCURRENCY, item => fn(item))

async function retiredUploadedMediaByEpisode(
  slug: string,
  episodeIds: string[],
  projectFacts: ProjectFactsCache,
): Promise<Map<string, LocalMediaCleanupStatus>> {
  const retired = new Map<string, LocalMediaCleanupStatus>()
  const statuses = await mapWithConcurrency(episodeIds, code =>
    readLocalMediaCleanupStatus(slug, code, projectFacts))
  for (let index = 0; index < episodeIds.length; index++) {
    const code = episodeIds[index]!
    const status = statuses[index]!
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
  projectFacts: ProjectFactsCache
  startingPacing?: ScenePacing
  /** The channel's formula has `musicFormat`: the music chain and its prerequisites apply. */
  musicChannel: boolean
  /** 1.4.282 — what a Video Assembly in this batch bakes in, and where it comes from. Null without that step. */
  videoEffects: VideoEffectsAnswer | null
  /** 1.4.300 — the requested steps minus those a lenient safety check left out (`stepsLeftOut`). */
  steps: BatchStep[]
  stepsLeftOut: Array<{ step: BatchStep; reason: string }>
  /** Episodes whose run gained missing earlier steps (safety check earlier_step_done Off/Warn), in run order. */
  stepsByEpisode: Map<string, BatchStep[]>
  stepsAdded: Array<{ episode_id: string; steps: BatchStep[] }>
  /** Cleaned-up media still stops an episode at dispatch (not Force, retired_media on Block). */
  retiredMediaBlocks: boolean
  /**
   * The app-wide default models, read once per preflight (Settings → Default models).
   *
   * A step whose preset names no model uses one of these when it is set, instead of being left out.
   * It is only ever READ — never written into a preset or the job params — so changing a default
   * later still reaches the next run (AGENTS §1, §5).
   */
  defaultModels: Awaited<ReturnType<typeof getDefaultModels>>
}

const SAFETY_CHECK_NAME = new Map(SAFETY_CHECKS.map(check => [check.id, check.name]))

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
    ? steps.filter(step => SCENE_PLAN_ONLY_STEPS.has(step))
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
  startingPacing: ScenePacing | undefined,
  projectFacts: ProjectFactsCache,
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
  snapshot.pacing = parseScenePacing(config.pacing === undefined ? startingPacing : config.pacing)
  const motion = await readEpisodeMotionScope(slug, episodeId, source.episode_dir)
  snapshot.motion_scope = motion.motion_scope
  snapshot.motion_level = motion.motion_level

  // An Off episode authorizes no share work — but its text-to-video scenes are an explicit
  // per-scene plan and are always in scope, so the ids are resolved even when Off. With no such
  // scene the list is empty and the paid step queues nothing, exactly as before.
  if (!includeMotionSceneIds) return snapshot
  const planPath = await resolveScenePlanPath(slug, episodeId, source.episode_dir, projectFacts)
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
  startingPacing?: ScenePacing,
): Promise<ContinuityConfig> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(episodeDir, 'continuity.json'), 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return defaultContinuityConfig(mode, startingPacing)
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

/**
 * Apply the same deliberate preset boundary as Character Sheet's manual flow.
 *
 * The episode's rhythm is NOT one of the things this fold may decide. A
 * `continuity_page` preset is a LOOK; `pacing` is excluded from it (owner,
 * 2026-10-17 — see `CONTINUITY_PRESET_EXCLUDE_KEYS`), and Scene Plan's "Visual
 * timing & motion" panel owns the episode's rhythm. So the live value read off
 * disk is carried across whole, whatever the preset body happens to contain:
 * `...data` is spread first precisely so the explicit `pacing` below wins, and
 * a stale preset that still stores a band (every one saved between 2026-08-18
 * and 2026-10-17 does) is stripped here at the boundary rather than being
 * rewritten on disk.
 *
 * The read-then-write pair in the caller is what makes this atomic: the batch
 * reads the episode's current continuity.json, folds the preset's look into
 * it, and writes the result back once.
 */
export function applyContinuityPresetForPipeline(
  current: ContinuityConfig,
  data: Partial<ContinuityConfig> | null | undefined,
): Partial<ContinuityConfig> {
  const keepEpisodeSheet = current.use_episode_sheet === true || current.references?.sheet === true
  return {
    ...(data || {}),
    pacing: current.pacing,
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
/** A music channel's prerequisites: everything after the stitch needs the stitch. */
const MUSIC_STEP_PREREQUISITES: Partial<Record<BatchStep, BatchStep[]>> = {
  music_build: [],
  scene_review: ['music_build'],
  video_assembly: ['scene_review', 'music_build'],
  thumb_images: ['music_build'],
  metadata: ['music_build'],
}

export function prerequisitesForStep(step: BatchStep, cueReviewPending = false, musicChannel = false): BatchStep[] {
  if (musicChannel) return [...(MUSIC_STEP_PREREQUISITES[step] || [])]
  const base = [...(STEP_PREREQUISITES[step] || [])]
  return step === 'scene_review' && cueReviewPending ? [...base, 'contextual_cues'] : base
}

const CHAIN_LINK_STEP: Record<string, BatchStep> = {
  outline_only: 'script-only',
  expand_chapters: 'script-only',
  ...Object.fromEntries(Object.entries(STEP_JOB_TYPE).map(([step, type]) => [type, step as BatchStep])),
}

/**
 * The steps one chain link waits for when an earlier link in the SAME run
 * fails (lib/pipeline-continuation.ts). The prerequisite table, plus two
 * in-run orderings the old straight-line chain enforced implicitly: narration
 * waits for the channel's opening (an episode once reached paid audio without
 * one), and the final video waits for motion clips the run was asked to make,
 * so a failed clip never leaves a "finished" stills-only video behind.
 */
export function pipelineLinkRequirements(
  step: BatchStep,
  runSteps: ReadonlySet<BatchStep>,
  visualSource: VideoVisualSource,
  musicChannel = false,
): BatchStep[] {
  if (musicChannel) return prerequisitesForStep(step, false, true)
  const required = step === 'video_assembly' && visualSource === 'image_pool'
    ? ['audio_merge' as BatchStep]
    : prerequisitesForStep(step, runSteps.has('contextual_cues'))
  if (step === 'audio' && runSteps.has('introduction-only')) required.push('introduction-only')
  if (step === 'video_assembly' && runSteps.has('motion_review')) required.push('motion_review')
  return required
}

export function stampPipelineStepFacts(
  chain: Array<{ type: string; params: Record<string, any> }>,
  visualSource: VideoVisualSource,
  musicChannel = false,
): void {
  const steps = chain.map(link => CHAIN_LINK_STEP[link.type] || link.type as BatchStep)
  const runSteps = new Set(steps)
  chain.forEach((link, index) => {
    link.params = {
      ...link.params,
      pipeline_step: steps[index],
      pipeline_requires: pipelineLinkRequirements(steps[index], runSteps, visualSource, musicChannel),
    }
  })
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
  requestedSteps: BatchStep[],
  force: boolean,
  repairMissing = false,
  presetIds: Partial<Record<BatchStep, string>> = {},
): Promise<BatchPreflight> {
  const issues: PreflightIssue[] = []
  const warnings: string[] = []
  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Project config missing')
  const projectFacts = createProjectFactsCache(slug)
  projectFacts.config = Promise.resolve(config)
  // 1.4.300 — each check below obeys the channel's Off / Warn / Block switch (Settings → Safety checks).
  const mode = (id: string) => safetyModeFromConfig(config, id)
  const warnIf = (id: string, message: string) => {
    if (mode(id) === 'warn') warnings.push(`${message} (Safety check "${SAFETY_CHECK_NAME.get(id) || id}" is set to Warn.)`)
  }
  // Steps a lenient check leaves out of this whole run, with why.
  const leftOut = new Map<BatchStep, string>()
  const leaveOut = (step: BatchStep, id: string, message: string) => {
    leftOut.set(step, message)
    warnIf(id, `${pipelineStepLabel(step)} is left out of this run: ${message}`)
  }
  const runSteps = () => requestedSteps.filter(step => !leftOut.has(step))

  const ideas = await im.getIdeas(slug, 'accepted')
  const ideaByCode = new Map(ideas.filter(i => i.episode_code).map(i => [i.episode_code!, i]))
  // accepted_idea: Off/Warn run an episode whose idea is no longer accepted (dismissed) but still carries its code.
  if (mode('accepted_idea') !== 'block' && episodeIds.some(episodeId => !ideaByCode.has(episodeId))) {
    for (const idea of await im.getIdeas(slug)) {
      const code = idea.episode_code
      if (!code || ideaByCode.has(code) || !episodeIds.includes(code)) continue
      ideaByCode.set(code, idea)
      ideas.push(idea)
      warnIf('accepted_idea', `${code} is not an accepted episode (its idea is ${idea.status}); it runs anyway.`)
    }
  }
  projectFacts.ideas = Promise.resolve(ideas as unknown as Array<Record<string, unknown>>)
  const startingPacing = await readProjectStartingPacing(slug)
  const defaults = await getDefaultModels()
  const effectiveFormat = await getEffectiveFormat(slug)
  const musicChannel = await isMusicChannel(slug)
  const foreignSteps = requestedSteps.filter(step => musicChannel ? !MUSIC_STEPS.includes(step) : step === 'music_build')
  for (const step of foreignSteps) {
    const message = musicChannel
      ? `${pipelineStepLabel(step)} is not part of a music channel (no narration). Untick it.`
      : `${pipelineStepLabel(step)} only runs on a music channel (a Series Formula with a music format). Untick it.`
    if (mode('step_fits_channel') === 'block') issues.push({ code: 'invalid_preset', step, message })
    else leaveOut(step, 'step_fits_channel', message)
  }
  const retiredMediaBlocks = !force && mode('retired_media') === 'block'
  const retiredMediaByEpisode = force ? new Map<string, LocalMediaCleanupStatus>()
    : await retiredUploadedMediaByEpisode(slug, episodeIds, projectFacts)
  const visualSettingsByEpisode = new Map<string, PipelineVisualSettingsSnapshot>()
  const requiredSteps = new Set<BatchStep>()
  // `runSteps()` is read live, never snapshotted: `leftOut` still grows below
  // (the cue switch, then `admitStep` for every required step), and a copy taken
  // before those decisions is what let a left-out step reach the queue.
  const visualRows = await mapWithConcurrency(episodeIds, async episodeId => {
    if (!ideaByCode.has(episodeId)) {
      return {
        episodeId,
        issue: { code: 'episode_not_accepted', episode_id: episodeId, message: `${episodeId} is not an accepted episode.` } as PreflightIssue,
      }
    }
    const retiredMedia = retiredMediaByEpisode.get(episodeId)
    if (retiredMedia && retiredMediaBlocks) {
      return { episodeId, issue: retiredLocalMediaIssue(episodeId, retiredMedia) }
    }
    if (retiredMedia) {
      warnIf('retired_media', `${episodeId}: media Free Up Space removed on purpose will be made again; provider costs apply.`)
    }
    try {
      const source = await readVideoVisualSource(slug, episodeId, projectFacts)
      let episodeSteps = applicablePipelineStepsForVisualSource(runSteps(), source.source).applicable
      // Future-only fact: an automatic opening is added only to an episode
      // whose creation snapshot said intro_eligible. Old/imported episodes
      // have no such fact and are never enqueued, marked missing, or backfilled.
      let introExcluded = false
      if (episodeSteps.includes('introduction-only')) {
        const episodePaths = await resolveEpisodePathsByCode(slug, episodeId, projectFacts).catch(() => null)
        if (!episodePaths || !await episodeIsIntroEligible(episodePaths.episode_dir)) {
          episodeSteps = episodeSteps.filter(step => step !== 'introduction-only')
          introExcluded = true
        }
      }
      if (episodeSteps.includes('video_assembly') && source.source === 'image_pool') {
        await resolveImagePoolSelection(slug, episodeId)
      }
      const includeEpisodeSettings = episodeSteps.some(step =>
        SCENE_PLAN_ONLY_STEPS.has(step) || step === 'video_assembly',
      )
      const visualSettings = await pipelineVisualSettingsSnapshot(
        slug,
        episodeId,
        source,
        includeEpisodeSettings,
        episodeSteps.includes('motion_review') && !episodeSteps.includes('scene_plan'),
        startingPacing,
        projectFacts,
      )
      return { episodeId, episodeSteps, visualSettings, introExcluded }
    } catch (error: any) {
      return {
        episodeId,
        issue: {
          code: 'invalid_preset',
          episode_id: episodeId,
          step: runSteps().includes('video_assembly') ? 'video_assembly' : runSteps().find(step => SCENE_PLAN_ONLY_STEPS.has(step)),
          message: `${episodeId}: ${error?.message || 'Episode visual settings are not ready.'}`,
        } as PreflightIssue,
      }
    }
  })
  const introIneligibleEpisodes = new Set<string>()
  for (const row of visualRows) {
    if (row.issue) {
      issues.push(row.issue)
      continue
    }
    row.episodeSteps?.forEach(step => requiredSteps.add(step))
    if (row.visualSettings) visualSettingsByEpisode.set(row.episodeId, row.visualSettings)
    if (row.introExcluded) {
      introIneligibleEpisodes.add(row.episodeId)
      warnings.push(
        `${row.episodeId}: Introduction was not added automatically because this episode was created ` +
        'before automatic introductions were enabled. Generate one explicitly if you want it — this does not block anything.',
      )
    }
  }

  const presetByStep: Partial<Record<BatchStep, StoredPreset>> = {}
  const contextualCuesEnabled = config.contextual_cues?.enabled === true
  if (requiredSteps.has('contextual_cues') && !contextualCuesEnabled) {
    const message = 'Enable Contextual Cues in its project setting before adding it to Pipeline.'
    if (mode('cues_feature_on') === 'block') issues.push({ code: 'invalid_preset', step: 'contextual_cues', message })
    else {
      // The cue writer refuses a channel with cues switched off, so the step cannot run: leave it out.
      leaveOut('contextual_cues', 'cues_feature_on', 'Contextual Cues are switched off for this channel.')
      requiredSteps.delete('contextual_cues')
    }
  }
  /**
   * Resolve a step's saved preset. A ticked step records its problems (as issues, or as a step left
   * out when the channel's switch allows); a step added only as an earlier step records nothing.
   * Returns why the step cannot run, or null when it can.
   */
  const admitStep = (step: BatchStep, ticked: boolean): string | null => {
    if (NO_PRESET_STEPS.has(step) || presetByStep[step]) return null
    const result = findActivePreset(config, step, presetIds[step])
    // A music episode renders with its own Episode Builder settings; a Video Assembly preset only
    // adds the owner's look (logo, grade…) on top, so it is optional there.
    if (!result.preset && musicChannel && step === 'video_assembly') return null
    if (!result.preset) {
      const message = musicChannel && step === 'scene_review'
        ? 'No pictures preset yet. Open Episode Builder, pick the image model under Scene pictures and save a Pictures preset; Pipeline makes the missing pictures with it.'
        : result.missingReason || `No active preset for ${pipelineStepLabel(step)}`
      if (ticked && mode('step_preset') === 'block') addMissingPresetIssue(issues, visualSettingsByEpisode, step, message)
      else if (ticked) leaveOut(step, 'step_preset', message)
      return message
    }
    // A preset that names no model is not a usable preset either — see
    // PRESET_MODEL_READERS. Said here rather than letting the step enqueue and
    // die inside its generator, and handled through the SAME `step_preset`
    // switch as a missing preset, because to the operator it is the same fact.
    //
    // EXCEPT when this Mac has an app-wide default for that family (Settings →
    // Default models, owner 2026-10-27): the default is then the model this run
    // uses, exactly as a page uses it at read time. Only a default that is SET
    // counts — a default that has left the catalogue is not checked here, and
    // the generator refuses it by name when the step runs, because availability
    // is a live fact this preflight must not freeze.
    if (presetHasNoWritingModel(step, result.preset) && !defaultAdmitsModelLessPreset(step, defaults)) {
      const message = presetModelMissingMessage(step)
      if (ticked && mode('step_preset') === 'block') addMissingPresetIssue(issues, visualSettingsByEpisode, step, message)
      else if (ticked) leaveOut(step, 'step_preset', message)
      return message
    }
    if (step === 'motion_review') {
      const data = result.preset.data ?? result.preset
      if (data?.renderer !== 'sketch_draw') {
        const hasOperation = typeof data?.operation === 'string' && Boolean(data.operation.trim())
        const hasDuration = Number.isFinite(Number(data?.duration_seconds)) && Number(data.duration_seconds) > 0
        const hasResolution = typeof data?.resolution === 'string' && Boolean(data.resolution.trim())
        if (!hasOperation || !hasDuration || !hasResolution) {
          const message = 'Motion Review preset has no exact published clip variant. Open Motion Review, choose a current length and resolution, then save the preset again.'
          if (!ticked) return message
          issues.push({ code: 'invalid_preset', step, message })
        }
      }
    }
    for (const missingPath of collectMissingLocalAssets(result.preset.data ?? result.preset)) {
      const message = `The ${pipelineStepLabel(step)} preset uses a file that isn't available (is the drive connected?): ${missingPath}`
      if (mode('preset_files') !== 'block') {
        // Off/Warn: run with the preset as saved; the step makes what it can without that file.
        warnIf('preset_files', `${message} It runs without that file.`)
        continue
      }
      if (!ticked) return message
      issues.push({ code: 'missing_local_asset', step, path: missingPath, message })
    }
    if (step === 'audio') {
      const voice = result.preset.data?.form?.voice ?? (result.preset as any)?.form?.voice
      if (!voice || !String(voice).trim()) {
        const message = 'Audio preset has no voice selected.'
        // No voice means no narration can be made: Off/Warn leave Audio out rather than run it.
        if (ticked && mode('audio_voice') === 'block') issues.push({ code: 'missing_voice', step: 'audio', message })
        else if (ticked) leaveOut('audio', 'audio_voice', message)
        return message
      }
    }
    presetByStep[step] = step === 'video_assembly' ? withNamedEffectsFrame(config, result.preset) : result.preset
    return null
  }
  for (const step of [...requiredSteps]) {
    if (admitStep(step, true) && leftOut.has(step)) requiredSteps.delete(step)
  }

  // Captions switched on in the Video Assembly preset, for the per-episode check below.
  const vaPreset = presetByStep.video_assembly
  const vaFlat = !musicChannel && vaPreset ? flattenVideoAssemblyBundle(vaPreset.data ?? vaPreset, '', '') : null
  const captionsOn = !!vaFlat?.subtitles
  // A repair stays inside the stages it was asked to repair: it never gains earlier ones.
  const earlierStepMode = repairMissing ? 'block' : mode('earlier_step_done')
  const captionsMode = mode('captions_missing')
  const cueReviewHolds = mode('cue_review') === 'block'
  const statusRows = await mapWithConcurrency(episodeIds, async episodeId => {
    const visualSettings = visualSettingsByEpisode.get(episodeId)
    if (!ideaByCode.has(episodeId) || !visualSettings) return null
    let episodeSteps = applicablePipelineStepsForVisualSource(runSteps(), visualSettings.visual_source).applicable
    const autoIntroExcluded = introIneligibleEpisodes.has(episodeId)
    if (autoIntroExcluded) {
      episodeSteps = episodeSteps.filter(step => step !== 'introduction-only')
    }
    const status = await episodeStatusCache.get(slug, episodeId, ideas, projectFacts)
    const episodeIssues: PreflightIssue[] = []
    const available = new Set<BatchStep>()
    for (const step of VALID_STEPS) {
      if (isStepAlreadyDone(status, step, effectiveFormat)) available.add(step)
    }
    // `status.contextual_cues` is the readiness answer (nothing outstanding),
    // NOT the "already produced" answer `available` carries — see
    // `prerequisitesForStep`. An episode that never proposed a cue is not
    // held back; one with an unresolved proposal still is, while the channel's
    // cue_review switch is Block.
    const cueReviewPending = contextualCuesEnabled
      && (episodeSteps.includes('contextual_cues') || (cueReviewHolds && status.contextual_cues === false))
    const prerequisitesOf = (step: BatchStep): BatchStep[] => musicChannel
      ? prerequisitesForStep(step, false, true)
      : step === 'video_assembly' && visualSettings.visual_source === 'image_pool'
        ? ['audio_merge' as BatchStep]
        : prerequisitesForStep(step, cueReviewPending)
    // earlier_step_done Off/Warn: put a missing earlier step (and its own) into this episode's run,
    // just before the step that needs it. Not possible for a step left out, one that does not apply
    // to this episode, one with no usable preset, or the cue review (a decision, not a file).
    const ordered: BatchStep[] = []
    const added: BatchStep[] = []
    const addEarlier = (required: BatchStep, seen: Set<BatchStep>): boolean => {
      if (available.has(required)) return true
      if (seen.has(required) || leftOut.has(required) || required === 'contextual_cues') return false
      if (!applicablePipelineStepsForVisualSource([required], visualSettings.visual_source).applicable.length) return false
      if (admitStep(required, false)) return false
      seen.add(required)
      if (!prerequisitesOf(required).every(step => addEarlier(step, seen))) return false
      ordered.push(required)
      added.push(required)
      available.add(required)
      requiredSteps.add(required)
      return true
    }
    // Counted on the steps as ticked: a step left out never turns a run into a targeted one.
    const tickedCount = applicablePipelineStepsForVisualSource(requestedSteps, visualSettings.visual_source).applicable.length
    for (const step of episodeSteps) {
      if (ordered.includes(step)) continue // already moved in front of a step that needed it
      // A single selected step is normally a targeted repair/regeneration
      // operation. Downstream Story stages still need their durable artifact:
      // Scene Plan needs Subtitles, and Scene Review needs Scene Plan.
      if (tickedCount === 1 && step !== 'metadata' && step !== 'scene_plan' && step !== 'scene_review' && !musicChannel) {
        // 1.4.288 — except that a final video is never started on a Scene Plan that is not done
        // (one that stops before the narration ends): run Scene Plan, which says why.
        if (step === 'video_assembly' && visualSettings.visual_source === 'scene_plan' && !status.scene_plan) {
          episodeIssues.push({
            code: 'missing_prerequisite',
            episode_id: episodeId,
            step,
            requires: 'scene_plan',
            message: `${episodeId}: ${pipelineStepLabel(step)} needs a finished ${pipelineStepLabel('scene_plan')} first — its scenes must cover the whole narration. Run ${pipelineStepLabel('scene_plan')} on its own page or in this run.`,
          })
        }
        ordered.push(step)
        available.add(step)
        continue
      }
      for (const required of prerequisitesOf(step).filter(required => !available.has(required))) {
        if (earlierStepMode !== 'block' && addEarlier(required, new Set())) continue
        episodeIssues.push({
          code: 'missing_prerequisite',
          episode_id: episodeId,
          step,
          requires: required,
          message: `${episodeId}: ${pipelineStepLabel(step)} needs ${pipelineStepLabel(required)} first — tick ${pipelineStepLabel(required)} in this run too, or finish it on its own page.`,
        })
      }
      ordered.push(step)
      available.add(step)
    }
    if (added.length) {
      warnIf('earlier_step_done', `${episodeId}: added ${added.map(pipelineStepLabel).join(', ')} to this run, because a ticked step needs it first.`)
    }
    if (cueReviewPending === false && contextualCuesEnabled && status.contextual_cues === false && !cueReviewHolds
      && episodeSteps.includes('scene_review')) {
      warnIf('cue_review', `${episodeId}: cues are still waiting for review; Scene Review goes ahead without waiting.`)
    }
    let captionGap = captionsOn && episodeSteps.includes('video_assembly') && !available.has('subtitles')
      ? `${episodeId}: captions are switched on, but this episode has no subtitles yet and Subtitles is not in this run, so its video will have no captions. Tick Subtitles, or switch captions off in the Video Assembly preset.`
      : null
    if (captionGap && captionsMode === 'block') {
      episodeIssues.push({ code: 'captions_missing', episode_id: episodeId, step: 'video_assembly', requires: 'subtitles', message: captionGap })
    }
    if (captionsMode !== 'warn') captionGap = null
    // An old merge asked for a closing it never had: the render re-mixes the audio first, or this says
    // why it cannot (the same decision the render makes, services/closing-tail-remix.ts).
    if (vaFlat?.post_audio && status.merged_audio && ordered.includes('video_assembly')
      && (force || !isStepAlreadyDone(status, 'video_assembly', effectiveFormat))
      && !(force && ordered.includes('audio_merge'))) {
      const { planClosingTailRemix } = await import('../services/closing-tail-remix.js')
      const verdict = await planClosingTailRemix({ slug, code: episodeId, postAudio: vaFlat.post_audio as VideoPostAudio })
      if (verdict.action === 'refuse') {
        episodeIssues.push({ code: 'closing_tail_unsafe', episode_id: episodeId, step: 'video_assembly', message: verdict.reason })
      } else if (verdict.action === 'recover') {
        warnings.push(`${episodeId}: an earlier re-mix of its audio with the closing music was interrupted; `
          + 'Video Assembly finishes or undoes it at render, before anything else.')
      } else if (verdict.action === 'remix') {
        warnings.push(`${episodeId}: its audio was mixed without the ${Number(verdict.wantedSec.toFixed(1))} s closing music this run asks for; `
          + 'Video Assembly re-mixes the audio with it first (a new track beside the original).')
      }
    }
    return { episodeId, status, issues: episodeIssues, captionGap, ordered: (added.length || autoIntroExcluded) ? ordered : null, added }
  })
  const captionGaps: string[] = []
  const stepsByEpisode = new Map<string, BatchStep[]>()
  const stepsAdded: Array<{ episode_id: string; steps: BatchStep[] }> = []
  for (const row of statusRows) {
    if (!row) continue
    issues.push(...row.issues)
    if (row.captionGap) captionGaps.push(row.captionGap)
    if (row.ordered) {
      stepsByEpisode.set(row.episodeId, row.ordered)
      stepsAdded.push({ episode_id: row.episodeId, steps: row.added })
    }
  }
  if (!runSteps().length) {
    issues.push({ code: 'invalid_preset', message: 'No step is left to run in this batch.' })
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
    const message = `Not enough free disk space. Have: ${formatBytes(freeBytes)}; need: approximately ${formatBytes(estimatedBytes)} including safety margin.`
    if (mode('disk_space') === 'block') issues.push({ code: 'insufficient_disk', message })
    else warnIf('disk_space', `${message} The run starts anyway.`)
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
    visualSettingsByEpisode, projectFacts, startingPacing, musicChannel,
    defaultModels: defaults,
    videoEffects: requiredSteps.has('video_assembly') ? withCaptionGaps(videoEffectsAnswer(config, presetByStep.video_assembly, musicChannel), captionGaps) : null,
    // Drop an opening that no eligible episode will run. Explicit manual
    // generation uses its own route and is unaffected. Read live, so the set the
    // queue is handed is the set after every left-out decision above.
    steps: runSteps().filter(step => step !== 'introduction-only' || requiredSteps.has(step)),
    stepsByEpisode, stepsAdded,
    stepsLeftOut: [...leftOut.entries()].map(([step, reason]) => ({ step, reason })),
    retiredMediaBlocks,
  }
}

/**
 * A music episode's step params (SPEC phase 4). Scene pictures are approved as they arrive (the
 * Episode Builder does the same: a picture IS its scene); Video Assembly renders with the episode's
 * own music settings on top of the owner's Video Assembly preset (if any); the thumbnail is drawn
 * from prompts written from the episode when it has none yet.
 */
export async function musicEpisodeStepParams(
  slug: string,
  episodeId: string,
  step: BatchStep,
  params: Record<string, any>,
): Promise<{ params: Record<string, any> } | { skip: string }> {
  if (step === 'scene_review') return { params: { ...params, auto_approve_generated: true } }
  if (step === 'thumb_images') return { params: { ...params, music_thumbnail_prompts: true } }
  if (step !== 'video_assembly') return { params }
  const { readEpisodeDoc, channelStartingSettings } = await import('../services/music-episode-store.js')
  const { musicEpisodeRenderParams } = await import('../services/music-episode.js')
  const doc = await readEpisodeDoc(slug, episodeId).catch(() => null)
  const settings = doc?.settings ?? (await channelStartingSettings(slug)).settings
  return { params: musicEpisodeRenderParams(params, settings) }
}

/** Whether this project is a music channel (its effective formula carries `musicFormat`). */
async function isMusicChannel(slug: string): Promise<boolean> {
  const { getEffectiveNiche } = await import('../services/niche-loader.js')
  return !!(await getEffectiveNiche(slug).catch(() => null) as { musicFormat?: unknown } | null)?.musicFormat
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
    case 'music_build':       return status.music_episode === true
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
    episodeStatusCache.invalidate(slug, episodeId)
    return true
  } catch {
    return false
  }
}

export function findActivePreset(
  config: any, step: BatchStep, explicitPresetId?: string, explicitProvided = explicitPresetId !== undefined,
): { preset: StoredPreset | null; missingReason: string | null } {
  const keys = PRESET_KEYS[step]
  return resolveExactPreset(config, keys.list, keys.activeKeys, explicitPresetId, pipelineStepLabel(step), explicitProvided) as {
    preset: StoredPreset | null
    missingReason: string | null
  }
}

/**
 * Where a step's writing model is read from inside its preset body, for the
 * steps whose preset MUST name one.
 *
 * Story Studio never picks a writing model (coordinator decision 2026-10-03),
 * so a preset that names none is not a USABLE preset: enqueuing it only moves
 * the failure into the generator — `scene-plan.ts`'s `model is required` —
 * minutes later, naming neither the step nor what to do about it. Preflight
 * counts it exactly as it counts a missing preset, so the operator gets a plain
 * message naming the step and where to choose.
 *
 * GENERIC by construction: a step joins this table and inherits the same
 * classification, the same message and the same `step_preset` safety switch.
 * Two steps are deliberately absent — `metadata` and `introduction-only` each
 * already have their own branch in the enqueue loop, with an escape hatch this
 * table cannot see (a carried `pipeline_model_policy`, the channel's own
 * opening model, the script-side model) and a plain message of their own. A
 * step must not be reported twice.
 *
 * The `script-only` reader accepts both shapes `resolveScriptSideChatModel`
 * accepts — a typed preset nests the form, a legacy untyped one is flat — so a
 * preset the rest of the app can read is never called model-less here.
 */
const PRESET_MODEL_READERS: Partial<Record<BatchStep, (body: Record<string, any>) => unknown>> = {
  'script-only': body => body.form?.model ?? body.model,
  scene_plan: body => body.model,
  // The two thumbnail steps (AGENTS §7: thumbnail_prompts_* / thumbnail_generator_*).
  //
  // Their readers are the SAME functions the two enqueue routes use
  // (`services/thumbnail-presets.ts`), so a preset the Thumbnail Prompts page
  // itself can read is never called model-less here, and one that really names
  // no model is refused in PREFLIGHT rather than admitted to die inside its
  // generator — which is what happened to four real `image_prompts` jobs on
  // 2026-10-25, admitted with `model: ''` against a channel whose
  // `thumbnail_prompts_presets` was empty.
  //
  // A step in this table that names no model is left out exactly as if it had no
  // preset at all: the operator gets one plain message naming the step and where
  // to choose, through the same `step_preset` switch.
  image_prompts: thumbnailPromptsModelFromPreset,
  thumb_images: thumbnailGeneratorModelFromPreset,
}

/**
 * True when this step's preset carries no writing model of its own.
 *
 * `false` for every step that is not in `PRESET_MODEL_READERS`: this check has
 * no opinion about steps whose model comes from somewhere else.
 */
export function presetHasNoWritingModel(step: BatchStep, preset: StoredPreset | undefined): boolean {
  if (step === 'motion_review') {
    const body = (preset?.data ?? preset) as Record<string, any> | undefined
    if (body?.renderer === 'sketch_draw') return false
  }
  const reader = PRESET_MODEL_READERS[step]
  if (!reader) return false
  // Presets are stored as `{ id, name, type, data }`; older ones carry the body
  // at the root. Same fallback `scenePlanPresetReceipt` and
  // `resolveScriptSideChatModel` use.
  const body = (preset?.data ?? preset) as Record<string, any> | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) return true
  const model = reader(body)
  return !(typeof model === 'string' && model.trim())
}

/** The two thumbnail steps, for the places that phrase their refusal differently. */
const THUMBNAIL_MODEL_STEPS: readonly BatchStep[] = ['image_prompts', 'thumb_images']

/**
 * Which app-wide default (Settings → Default models) a step's JOB PARAMS fall back to when its
 * preset names no model.
 *
 * Every step that submits a model is here. This one table feeds the fold-in at enqueue time.
 */
const STEP_DEFAULT_MODEL_FAMILY: Partial<Record<BatchStep, DefaultModelFamily>> = {
  'script-only': 'writing',
  scene_plan: 'writing',
  image_prompts: 'writing',
  contextual_cues: 'writing',
  metadata: 'writing',
  thumb_images: 'image',
  scene_review: 'image',
  motion_review: 'video',
  audio: 'audio',
  subtitles: 'transcription',
}

function defaultModelFamilyForStep(step: BatchStep): DefaultModelFamily | null {
  return STEP_DEFAULT_MODEL_FAMILY[step] || null
}

/** The app-wide default this step would use, or '' when it has none. Read-only. */
function defaultModelForStep(
  step: BatchStep,
  defaults: Awaited<ReturnType<typeof getDefaultModels>>,
): string {
  const family = defaultModelFamilyForStep(step)
  return family ? (defaults[family] || '') : ''
}

/**
 * Whether a model-less preset is ADMITTED because this Mac has a default for that step.
 *
 * Narrower than the table above on purpose: admission is only relaxed for the steps
 * `PRESET_MODEL_READERS` already classifies, so the `step_preset` safety check keeps its exact
 * previous reach. Every other step's model comes from its own preset and its own guard.
 */
function defaultAdmitsModelLessPreset(
  step: BatchStep,
  defaults: Awaited<ReturnType<typeof getDefaultModels>>,
): boolean {
  return PRESET_MODEL_READERS[step] ? !!defaultModelForStep(step, defaults) : false
}

function isThumbnailModelStep(step: BatchStep): step is ThumbnailStep {
  return THUMBNAIL_MODEL_STEPS.includes(step)
}

/**
 * The sentence a step whose preset names no model is reported with.
 *
 * The thumbnail steps get the same one-line refusal the enqueue routes give, so
 * "choose a model" reads identically whether the run was started from the page
 * or from Pipeline. Every other step keeps the writing-model wording, which is
 * what it needs.
 */
function presetModelMissingMessage(step: BatchStep): string {
  if (isThumbnailModelStep(step)) return noThumbnailModelMessage(step)
  const label = pipelineStepLabel(step)
  return `${label} has no writing model chosen. Open ${label} and pick one.`
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
    const { title: _stalePresetTitle, episode_id: _stale, customStyleText: _camel, ...restForm } = form
    return {
      ...restForm,
      episode_id: episodeId,
      title: title || form.title || '',
      // The preset stores camelCase; the executor (generators/episode.ts)
      // reads only `custom_style_text`, as the Scripts page sends it.
      custom_style_text: data.customStyleText ?? form.customStyleText ?? restForm.custom_style_text,
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
    // NOTE the count is NOT defaulted here. A preset that names no count is a
    // run that named no count, and the generator takes THE default
    // (contracts/thumbnail-counts: 3) — the same number the page shows. The
    // format's `defaultThumbnails` still wins when the format publishes one.
    const presetModel = thumbnailPromptsModelFromPreset(preset)
    return {
      ...rest,
      // The model the preset names travels with the params, whatever key an
      // older preset stored it under (`form.model`, a flat `model`, or the
      // legacy `prompt_model`). The generator reads `model`; without this a
      // preset that named its model under a legacy key would pass preflight and
      // still reach the writer with nothing chosen.
      ...(presetModel && !String((rest as Record<string, unknown>).model || '').trim()
        ? { model: presetModel }
        : {}),
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
    const renderModel = thumbnailGeneratorModelFromPreset(preset)
    // Pipeline-step variant determines mode. Split steps force the
    // corresponding mode regardless of what the preset carries.
    return {
      ...automaticForm,
      // Same rule as Thumbnail Prompts: the preset's own image model reaches the
      // render, so a batch and the page render with the product the owner chose.
      ...(renderModel && !String(automaticForm.model || '').trim() ? { model: renderModel } : {}),
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
  // Unit: the audio-merge form and its presets store every level as a
  // PERCENTAGE (0–100, matching the sliders), while the generator's request is
  // LINEAR GAIN (`1` = unchanged, `0.08` = 8%). The page converts before it
  // POSTs — see `audio-merge.vue` (`volume: music.volume / 100`) — so a batch
  // must convert at the same boundary or it hands FFmpeg `volume=8.00`
  // (8× the voice) where the customer chose 8%. A preset is the ONLY percent
  // source here, which is why the conversion lives here and nowhere else: the
  // generator must never divide (a linear `1` and a percent `1` are different
  // levels), and nothing may guess the unit from a value's size.
  if (step === 'audio_merge') {
    // A stated level is converted; junk states no level and is OMITTED so the
    // generator's own default applies. Forwarding it raw was the bug: `'8'`
    // reached a linear field and played 8× too loud.
    const gain = (v: unknown): number | undefined => percentGainToLinear(v)
    // The raw percent key is DROPPED before the converted one is written, so a
    // level the preset states badly cannot ride along unconverted.
    const withGain = <T extends Record<string, any>>(block: T | undefined, key: 'volume' | 'post_narration_volume') => {
      if (!block) return undefined
      const { [key]: raw, ...rest } = block
      const level = gain(raw)
      return { ...rest, ...(level !== undefined ? { [key]: level } : {}) }
    }

    const fmtMerge = format?.script.audioMergeDefaults
    const normIntro = withGain(data.intro, 'volume')
    let normMusic: Record<string, any> | undefined = withGain(withGain(data.music, 'volume'), 'post_narration_volume')
    if (normMusic && normMusic.volume === undefined && typeof fmtMerge?.musicVolume === 'number') {
      const vol = percentGainToLinear(fmtMerge.musicVolume)
      if (vol !== undefined) normMusic = { ...normMusic, volume: vol }
    }
    const normNoise = withGain(data.background_noise, 'volume')

    // Multi-track ambient (v1.0.55). Same percent-on-disk shape as the blocks
    // above; a row that names no level stays at unity rather than being muted.
    const liveAmbient = Array.isArray(data.ambient_tracks)
      ? (data.ambient_tracks as any[])
        .filter(t => t && t.enabled && t.source_path)
        .map(t => ({
          id: t.id,
          enabled: true,
          source_path: t.source_path,
          volume: percentGainToUnitLinear(t.volume) ?? 1,
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
    return {
      episode_id: episodeId,
      intro: normIntro,
      music: normMusic,
      background_noise: normNoise,
      ...(liveAmbient.length ? { ambient_tracks: liveAmbient } : {}),
      gap_duration: data.gap_duration ?? fmtMerge?.gapDurationSec,
      normalize_volume: data.normalize_volume ?? fmtMerge?.normalizeVolume,
      // 1.4.270 — the page sends these too; a batch merge used to drop them (voice volume back to 100%).
      ...(gain(data.narration_volume) !== undefined ? { narration_volume: gain(data.narration_volume) } : {}),
      ...(typeof data.chunk_silence_sec === 'number' && data.chunk_silence_sec > 0 ? { chunk_silence_sec: data.chunk_silence_sec } : {}),
    }
  }
  if (step === 'metadata') {
    // metadata preset shape: { sections, model?, titleConfig? } from
    // metadata.vue. Older presets omit model. This mapper is a pure/sync
    // preset→params transform with no catalog access, so it never invents
    // a literal external model id here — it passes the saved value through
    // (or '' when absent). The run-batch handler skips a step with no model
    // with a plain reason — Story never picks one.
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
    return flattenVideoAssemblyBundle(data, episodeId, title, format)
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
      ...(data.method === 'script' ? { method: 'script' } : {}),
      force: data.force === true,
    }
  }
  if (step === 'scene_plan') {
    // Pipeline runs deterministic timing followed by required visual packs.
    // Legacy window-size / pass-mode fields are intentionally not forwarded.
    const reusable = scenePlanPresetReceipt(preset || { id: '', data }).data
    return {
      episode_id: episodeId,
      title: title || '',
      model: reusable.model,
      use_research: reusable.use_research !== false,
      detail_level: 4,
      // v1.3.1 — `opening_mode` / `opening_reserved_sec` are no longer taken
      // from the Scene Plan preset. A preset is a reusable creative choice;
      // how long the branded opening runs is a measurable property of the
      // project's own clips, and the preset's remembered copy went stale
      // (the owner's said `from-start` + 15s against a real 10.0s intro,
      // so every scene landed ~10s after its narration). The timeline stage
      // probes the real clips instead — see services/opening-assets.ts.
      // Stored presets keep the two keys; they are simply never read.
      prompt_pack_size: parseScenePromptPackSetting(reusable.prompt_pack_size),
      prompt_max_tokens: parseScenePromptTokenSetting(reusable.prompt_max_tokens),
      intended_image_model: reusable.intended_image_model,
      prompt_char_cap: reusable.prompt_char_cap,
      creative_direction: reusable.creative_direction && typeof reusable.creative_direction === 'object'
        ? reusable.creative_direction : undefined,
      custom_instructions: typeof reusable.reusable_guidance === 'string' && reusable.reusable_guidance.trim()
        ? reusable.reusable_guidance.trim() : undefined,
      avoid_legible_text: typeof reusable.avoid_legible_text === 'boolean' ? reusable.avoid_legible_text : undefined,
      pacing: reusable.pacing,
      motion_scope: reusable.motion_scope,
      motion_level: reusable.motion_level,
      resolved_preset: preset ? scenePlanPresetReceipt(preset) : undefined,
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
    // The preset's own ratio wins. A preset that names none inherits the
    // channel's shape from the Formula (owner, 2026-10-27) — the same
    // `recommendedAspect` Video Assembly and the Thumbnail Prompts step read —
    // because a vertical channel whose preset predates this step rendering
    // portrait would otherwise have every scene drawn landscape. With neither,
    // the image resolver applies the shared Story default against the live
    // catalogue, exactly as before.
    const presetAspect = typeof data.aspect_ratio === 'string' ? data.aspect_ratio.trim() : ''
    const formatAspect = format?.imagePrompts?.recommendedAspect
    return {
      episode_id: episodeId,
      title: title || '',
      model: data.model,
      ...(presetAspect || formatAspect
        ? { aspect_ratio: presetAspect || formatAspect }
        : {}),
      seed: Number.isInteger(data.seed) ? data.seed : undefined,
      auto_approve_generated: autoApproveOn(data.auto_approve_generated),
    }
  }
  if (step === 'music_build') {
    // Draws the episode's songs first when it has none yet (seeded by the episode code, exactly as
    // Episode Builder's first draw), then stitches. Never makes or buys a song.
    return { episode_id: episodeId, draw_if_empty: true }
  }
  if (step === 'motion_review') {
    if (data.renderer === 'sketch_draw') {
      return {
        episode_id: episodeId,
        renderer: 'sketch_draw',
        visual_source: 'scene_plan',
        auto_approve_clip: data.auto_approve_clip !== undefined ? Boolean(data.auto_approve_clip) : true,
      }
    }
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
): Promise<{ model?: string; language?: string; method?: 'script' }> {
  const params = resolveStepParams('subtitles', '', '', preset)
  // Script-timed subtitles use no transcription model (2026-10-05).
  if (params.method === 'script') return { method: 'script' }
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey.trim()) {
    throw new Error('Transcription is not configured. Add the Gateway API Key in Settings → This Mac.')
  }
  let models: Awaited<ReturnType<typeof listTranscriptionModels>>
  try {
    models = await listTranscriptionModels(apiKey)
  } catch {
    throw new Error('Could not load transcription models. Check the Gateway app is running, then try again.')
  }
  const requestedModel = (typeof params.model === 'string' ? params.model.trim() : '')
    // Last of all, this Mac's app-wide default transcription model (Settings → Default models).
    // Read only — the preset is never rewritten.
    || ((await getDefaultModels()).transcription || '')
  const modelId = resolveGenStudioModelId('transcription', requestedModel)
  if (!modelId) throw new Error(unavailableLegacyModelMessage('transcription', requestedModel || '(none)'))
  const selected = models.find(model => model.id === modelId)
  if (!selected) throw new Error(unavailableTranscriptionModelMessage(modelId))
  if (!selected.available) throw new Error('The selected transcription model is temporarily unavailable.')
  if (selected.locked) throw new Error('The selected transcription model is locked for this Gateway account.')
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
  const model = (typeof params.model === 'string' ? params.model.trim() : '')
    // Last of all, this Mac's app-wide default video model (Settings → Default models).
    || ((await getDefaultModels()).video || '')
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
  format?: Format | null,
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
  // The page has always saved the outro inside the intro slot (`fallback.intro.outro`), as the
  // Intro preset does; only seeded bundles carry a top-level `fallback.outro`. Read both.
  const outro = fb.outro || intro.outro || {}
  const timeline = fb.timeline || {}
  // 1.4.282 — misplaced effect entries are put where they render before the
  // filters below, which only pass entries in their right place.
  const effects = normalizeEffectsLook(fb.effects || {}).look as any
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
  for (const k of ['resolution', 'aspect_ratio', 'quality', 'fps', 'encoding_effort', 'codec', 'format', 'video_bitrate_kbps', 'upscale_sharpen', 'loudness_lufs', 'true_peak_db', 'loudness_tolerance_pct']) {
    if (exportS[k] !== undefined) out[k] = exportS[k]
  }
  const formatAspect = format?.imagePrompts?.recommendedAspect || (format as any)?.aspectRatio
  if (!out.aspect_ratio && formatAspect) {
    out.aspect_ratio = formatAspect
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
  if (timeline.title_image?.enabled) {
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
        overlays: chosen.map((o: any) => ({ id: o.id, enabled: true, params: { ...(o.params || {}) }, ...(o.legacy_slot ? { legacy_slot: o.legacy_slot } : {}) })),
      }
    }
  }
  if (effects.chapter_titles)         out.chapter_titles = effects.chapter_titles
  if (typeof effects.exclude_intro_from_effects === 'boolean') {
    out.exclude_intro_from_effects = effects.exclude_intro_from_effects
  }
  // The page writes the episode's own title into the card whenever an episode is opened, so the
  // saved text is whichever episode was open when the preset was saved. A batch uses this episode's.
  if (effects.title_card?.enabled) out.title_card = { ...effects.title_card, text: title || effects.title_card.text }
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
      // Presets saved before 1.4.286 never kept the checkbox, and `!!undefined` burned captions over
      // every opening. Absent now means "decide as the page does": hidden when the episode opens with
      // a branded opening (the generator reads the Scene Plan reserve).
      ...(typeof subtitles.hide_during_intro === 'boolean' ? { hide_during_intro: subtitles.hide_during_intro } : {}),
      style: subtitles.style,
    }
  }

  return out
}

export interface VideoEffectsAnswer {
  /** Where a batch render's effects come from, in words. */
  source: string
  /** One line per effect the render bakes in, after every filter the flattener applies. */
  effects: string[]
  /** What was moved or skipped, pointer mismatches, and duplicate presets. */
  notes: string[]
  /**
   * 1.4.286 — every setting switched on that a batch video will NOT show, and why. The owner's
   * rule (2026-10-11): "if it's on. it show be showing. if enabled and not showing. it's either
   * failed or a bug". Empty when everything switched on is drawn.
   */
  not_drawn: string[]
}

/**
 * 1.4.286 — the Presentation Frame for a batch. Until this release the page never saved `frame`
 * into the Video Assembly preset's Effects copy, so every batch dropped it even when the channel's
 * Effects preset had it on (refinanced, terranash-sleep-stories). The copy's own frame wins when it
 * is on; otherwise the frame of the Effects preset the bundle names is used when THAT is on. A
 * clone is returned; the stored preset is never changed.
 */
export function withNamedEffectsFrame(config: any, bundle: StoredPreset): StoredPreset {
  const data = bundle?.data ?? bundle
  if (!data?.fallback || data.fallback.effects?.frame?.enabled) return bundle
  const presets: StoredPreset[] = Array.isArray(config?.effects_presets) ? config.effects_presets : []
  const named = typeof data.effects_preset_id === 'string' && data.effects_preset_id
    ? presets.find(p => p.id === data.effects_preset_id)
    : undefined
  const frame = (named?.data ?? named)?.frame
  if (!frame?.enabled) return bundle
  const merged = {
    ...data,
    frame_from_effects_preset: named!.name || named!.id,
    fallback: { ...data.fallback, effects: { ...(data.fallback.effects || {}), frame: { ...frame } } },
  }
  return bundle.data ? { ...bundle, data: merged } : { ...bundle, ...merged }
}

/**
 * 1.4.312 — resolve a chained Final Video against the channel's CURRENT Video Assembly preset.
 *
 * A batch resolves every step's params when the batch is submitted, and a later step's params ride
 * along in `pipeline_chain` until the earlier steps finish — which can be hours. Freezing the run is
 * deliberate for the EPISODE's own decision (pacing, motion scope, visual source: a later settings
 * edit must not retarget a queued chain), but the channel's Effects look is a reusable channel
 * choice, and a look applied after the batch was submitted never reached the queued Final Video. On
 * pronom (2026-10-16) batch `e30d2222`, submitted 09:16:37Z, was 22 minutes older than the channel's
 * base look (09:38:24Z); its Final Video links were dispatched hours later still carrying the 09:16
 * capture — `effect_stack: []` with no `scene_effects` / `color_grading` (`3d9d83de` 16:41:05Z,
 * `2bcbc851` 16:44:27Z, `c07dfed1` 16:47:37Z, `0c30f3bc` on 2026-10-17T00:07:29Z) — while a
 * run-batch of the same single step, 35 minutes after `c07dfed1`, carried the look (`ff0b55d9`,
 * 2026-10-16T17:23:04Z). PR0013 `ffb0a4f1` shows the same empty shape from a different batch
 * (`c06ff328`, 2026-10-17T02:16:30Z) whose own capture instant the receipts do not record.
 *
 * `dispatchChainLink` calls this when it enqueues the link, so the job's params are resolved from the
 * channel's preset at the moment THAT job is submitted — exactly what a run-batch of that one step
 * does, through the same code: `findActivePreset` (honouring the preset the batch named explicitly)
 * + `withNamedEffectsFrame` + `resolveStepParams`. `pipeline_preset_keys` — every key the step's
 * resolution produced, which is the preset's own fields plus the `episode_id` and `title` the
 * resolver sets — is dropped first, so an effect switched off in the meantime is off rather than
 * left behind by the capture, and a channel that deliberately has no look still gets none. The
 * job's params are then the snapshot the render reads: nothing is re-read at render time, and no
 * queued job is rewritten.
 *
 * The link is returned unchanged when the channel now has no usable preset for the step — the
 * batch's accepted snapshot is a complete request, and losing the step would be worse. It is also
 * returned unchanged when the link carries no `pipeline_preset_keys`: without that record there is
 * no way to tell the resolution's keys from the episode's, and a half-refreshed link (a current
 * look merged over a stale one) would be worse than the accepted snapshot it replaces.
 */
export async function resolveChainedVideoAssemblyParams(
  slug: string,
  episodeId: string,
  linkParams: Record<string, any>,
): Promise<Record<string, any>> {
  if (!Array.isArray(linkParams.pipeline_preset_keys)) return linkParams
  const presetKeys: string[] = linkParams.pipeline_preset_keys
  const explicitPresetId = typeof linkParams.pipeline_preset_id === 'string' && linkParams.pipeline_preset_id
    ? linkParams.pipeline_preset_id
    : undefined
  let config: any
  try {
    config = await pm.getConfig(slug)
  } catch {
    return linkParams
  }
  const { preset } = findActivePreset(config, 'video_assembly', explicitPresetId)
  if (!preset) return linkParams
  const fresh = resolveStepParams(
    'video_assembly',
    episodeId,
    typeof linkParams.title === 'string' ? linkParams.title : '',
    withNamedEffectsFrame(config, preset),
  )
  const carried = Object.fromEntries(Object.entries(linkParams).filter(([key]) =>
    !presetKeys.includes(key) && key !== 'pipeline_preset_keys' && key !== 'pipeline_preset_id'))
  return { ...fresh, ...carried, effect_stack: describeEffectStack(fresh) }
}

const fileLabel = (p: unknown) => String(p || '').split('/').pop() || String(p || '')

/**
 * 1.4.286 — what the bundle switches on that a batch render cannot show, each with the reason.
 * Pure: reads the saved slots only, so preflight and run-batch say the same thing.
 */
export function settingsNotDrawn(bundleData: any): string[] {
  const fb = bundleData?.fallback
  if (!fb) return []
  const out: string[] = []
  const intro = fb.intro || {}
  const outro = fb.outro || intro.outro || {}
  const effects = normalizeEffectsLook(fb.effects || {}).look as any
  const titleImage = fb.timeline?.title_image
  if (titleImage?.enabled && !titleImage.image_path) {
    out.push('Title Image is switched on, but its picture is chosen per episode on the Video Assembly page and a preset never keeps it, so batch videos open without a title image. Render on the Video Assembly page to include one, or switch Title Image off and save the Video Assembly preset to clear this.')
  }
  if (intro.enabled && !intro.video_path) out.push('The intro video is switched on but no file is chosen, so batch videos have no intro. Choose the file, or switch the intro off, then save the Video Assembly preset.')
  if (outro.enabled && !outro.video_path) out.push('The outro video is switched on but no file is chosen, so batch videos have no outro. Choose the file, or switch the outro off, then save the Video Assembly preset.')
  for (const clip of Array.isArray(intro.timeline_clips) ? intro.timeline_clips : []) {
    if (!clip || clip.enabled === false) continue
    const where = String(clip.anchor || 'timeline').replace(/_/g, ' ')
    if (clip.kind === 'static' ? !clip.image_path : !clip.video_path) {
      out.push(`A timeline clip (${where}) is switched on but has no ${clip.kind === 'static' ? 'picture' : 'video'} chosen, so batch videos skip it. Choose the file, or switch the clip off, then save the Video Assembly preset.`)
    } else if (clip.kind === 'static' && !(Number(clip.duration_sec) > 0)) {
      out.push(`The still timeline clip (${where}) ${fileLabel(clip.image_path)} has no length, so batch videos skip it. Give it a length, then save the Video Assembly preset.`)
    }
  }
  if (effects.logo?.enabled && !effects.logo.image_path) out.push('The logo is switched on but no logo picture is chosen, so batch videos have no logo. Choose it, or switch the logo off, then save the Video Assembly preset.')
  if (effects.chroma_key?.enabled && !effects.chroma_key.source_path) out.push('The green-screen overlay is switched on but no file is chosen, so batch videos do not show it.')
  if (effects.overlays?.enabled && Array.isArray(effects.overlays.layers)) {
    const empty = effects.overlays.layers.filter((l: any) => l?.enabled && !l.source_path).length
    if (empty) out.push(`${empty} overlay file layer(s) are switched on but have no file chosen, so batch videos do not show them.`)
  }
  return out
}

/** A music episode drops the narration-only settings by design (services/music-episode.ts); say which are on. */
function musicNotDrawn(bundleData: any): string[] {
  const flat = flattenVideoAssemblyBundle(bundleData, '', '') as Record<string, any>
  const on = NARRATION_ONLY_RENDER_KEYS.filter(key => flat[key] !== undefined && flat[key]?.enabled !== false)
  return on.length ? [`Music episodes have no narration, so these Video Assembly settings are left out of their videos by design: ${on.join(', ').replace(/_/g, ' ')}.`] : []
}

/** Per-episode lines (captions with no subtitles) join the preset-level ones. */
function withCaptionGaps(answer: VideoEffectsAnswer | null, gaps: string[]): VideoEffectsAnswer | null {
  return answer && gaps.length ? { ...answer, not_drawn: [...answer.not_drawn, ...gaps] } : answer
}

/**
 * 1.4.282 — the resolved effect stack for preflight and run-batch. A batch
 * renders the Effects copy saved INSIDE the Video Assembly preset; the Effects
 * preset list and its `effects_last_preset` pointer are page tools only. Read
 * live, this says so and flags where the two have drifted apart, without
 * changing which one renders (that would change existing channels' videos).
 */
export function videoEffectsAnswer(config: any, bundle: StoredPreset | undefined, musicChannel = false): VideoEffectsAnswer | null {
  if (!bundle) return null
  const data = bundle.data ?? bundle
  const saved = data?.fallback?.effects || {}
  const effects = describeEffectStack(flattenVideoAssemblyBundle(data, '', ''))
  const notes = [...normalizeEffectsLook(saved).notes]
  const effectsPresets: StoredPreset[] = Array.isArray(config?.effects_presets) ? config.effects_presets : []
  const namedId = typeof data?.effects_preset_id === 'string' ? data.effects_preset_id : ''
  const named = namedId ? effectsPresets.find(p => p.id === namedId) : undefined
  if (named) {
    const theirs = describeEffectStack(named.data)
    const onlyCopy = effects.filter(line => !theirs.includes(line))
    const onlyNamed = theirs.filter(line => !effects.includes(line))
    if (onlyCopy.length || onlyNamed.length) {
      notes.push(`This Video Assembly preset names the Effects preset "${named.name}", but a batch renders the copy saved inside the Video Assembly preset, and that copy differs from "${named.name}" now`
        + ` (only in the copy: ${onlyCopy.join(', ') || 'nothing'}; only in "${named.name}": ${onlyNamed.join(', ') || 'nothing'}).`
        + ` To render "${named.name}", open Video Assembly, apply it, then save the Video Assembly preset.`)
    }
  } else {
    notes.push(namedId
      ? 'The Effects preset this Video Assembly preset names was deleted; the copy saved inside the Video Assembly preset still renders.'
      : 'This Video Assembly preset names no Effects preset; the copy saved inside it is what renders.')
  }
  if (!config?.effects_last_preset) {
    notes.push('No Effects preset is selected on the Video Assembly page (effects_last_preset is empty). That never switches effects off: a batch renders the list above, and the page renders its form.')
  }
  for (const hint of duplicatePresetHints(effectsPresets)) notes.push(`Effects presets: ${hint}`)
  if (data?.frame_from_effects_preset) {
    notes.push(`Presentation frame: taken from the Effects preset "${data.frame_from_effects_preset}". The copy saved inside the Video Assembly preset predates frames being saved there; saving the Video Assembly preset again stores it.`)
  }
  return {
    source: `The Video Assembly preset "${bundle.name || bundle.id}": the Effects copy saved inside it. Batch renders read this, not the Effects preset list.`,
    effects,
    notes,
    not_drawn: musicChannel ? musicNotDrawn(data) : settingsNotDrawn(data),
  }
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
    const ideas = (await im.getIdeas(slug, 'accepted')).filter(idea => !!(idea as any).episode_code)
    type Pending = { episode_id: string; title: string; total: number; approved: number; with_image: number }
    // S8: one facts cache for the request and 8 episodes at a time (was strictly serial, 59–103 s on
    // the mini); each plan is reduced to scene ids + approval flags as soon as it is parsed.
    const facts = createProjectFactsCache(slug)
    const rows = await mapEpisodes(ideas, 8, async (idea): Promise<Pending | null> => {
      const code = (idea as any).episode_code as string
      let paths
      try { paths = await resolveEpisodePathsByCode(slug, code, facts) } catch { return null }
      const planPath = await resolveScenePlanPath(slug, code, paths.episode_dir, facts)
      let scenes: Array<{ id: string; approved: boolean }>
      try {
        scenes = (JSON.parse(await fs.readFile(planPath, 'utf-8'))?.scenes || [])
          .map((scene: any) => ({ id: scene.id, approved: !!scene.approved }))
      } catch { return null }
      if (!scenes.length) return null
      const approved = scenes.filter(s => s.approved).length
      if (approved >= scenes.length) return null   // fully approved — nothing to do
      // v1.0.457 — count renders in the unified named folder OR the legacy flat
      // folder, so consolidated and not-yet-consolidated episodes both count.
      const namedDir = await resolveSceneImagesDir(slug, code, paths.episode_dir, facts).catch(() => '')
      const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
      const listed = await Promise.all([namedDir, legacyDir].map(dir => dir ? fs.readdir(dir).catch(() => [] as string[]) : Promise.resolve([] as string[])))
      const files = new Set(listed.flat())
      const withImage = scenes.filter(s => files.has(`${s.id}.png`)).length
      if (withImage === 0) return null              // nothing rendered yet — can't approve
      return { episode_id: code, title: (idea as any).title || code, total: scenes.length, approved, with_image: withImage }
    })
    res.json({ pending: rows.filter((row): row is Pending => row !== null) })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to compute pending approvals' })
  }
})

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseBatchRequest(body: any): {
  episodeIds: string[]; steps: BatchStep[]; force: boolean; repairMissing: boolean;
  actionId: string; operationId: string; presetIds: Partial<Record<BatchStep, string>>;
  presetIdError: string | null
} {
  const episodeIds = Array.isArray(body?.episode_ids) ? body.episode_ids.filter((x: any) => typeof x === 'string' && x) : []
  const stepsRaw: any[] = Array.isArray(body?.steps) ? body.steps : []
  const steps = stepsRaw.filter((s): s is BatchStep => VALID_STEPS.includes(s))
  let presetIdError: string | null = null
  let presetIds: Partial<Record<BatchStep, string>> = {}
  if (body && Object.prototype.hasOwnProperty.call(body, 'preset_ids')) {
    if (!body.preset_ids || typeof body.preset_ids !== 'object' || Array.isArray(body.preset_ids)) {
      presetIdError = 'preset_ids must be an object mapping Pipeline steps to non-empty preset ids'
    } else {
      const entries = Object.entries(body.preset_ids)
      const invalid = entries.find(([step, id]) => !VALID_STEPS.includes(step as BatchStep)
        || typeof id !== 'string' || !id.trim())
      if (invalid) presetIdError = `preset_ids.${invalid[0]} must name a valid Pipeline step and non-empty preset id`
      else presetIds = Object.fromEntries(entries.map(([step, id]) => [step, (id as string).trim()])) as Partial<Record<BatchStep, string>>
    }
  }
  return {
    episodeIds,
    steps,
    force: body?.force === true,
    repairMissing: body?.repair_missing === true,
    actionId: typeof body?.action_id === 'string' ? body.action_id.trim() : '',
    operationId: typeof body?.operation_id === 'string' ? body.operation_id.trim() : '',
    presetIds,
    presetIdError,
  }
}

function repairRequestError(request: ReturnType<typeof parseBatchRequest>): string | null {
  if (request.presetIdError) return request.presetIdError
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
  params: Record<string, unknown>, actionId: string, fingerprint: string, rawFingerprint?: string,
): Record<string, unknown> {
  const repaired = {
    ...params,
    force: false,
    pipeline_repair: { action_id: actionId },
    pipeline_repair_request_fingerprint: fingerprint,
    ...(rawFingerprint ? { pipeline_repair_raw_request_fingerprint: rawFingerprint } : {}),
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
  return (await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId, { scriptDir: paths.script_dir })).complete
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
  // The opening in a Pipeline run is ALWAYS automatic: the Pipeline page has
  // no manual Introduction checkbox, so its presence in the payload is not an
  // owner override. Manual generation has its own `/generate/introduction-only`
  // route and is untouched.
  if (!steps.includes('introduction-only') && !steps.includes('script-only')) return steps
  // Future-only master switch, default OFF. Requires BOTH the project switch
  // and the channel's Introduction recipe. Turning either on later never
  // retroactively changes existing episodes: those carry no `intro_eligible:
  // true` fact, so preflight filters the step per episode.
  const project = await pm.getProject(slug).catch(() => null)
  const { channelWantsIntroduction } = await import('../services/channel-segments.js')
  const wantsAutomaticIntro = project?.auto_introduction_enabled === true
    && await channelWantsIntroduction(slug)
  if (steps.includes('introduction-only')) {
    return wantsAutomaticIntro ? steps : steps.filter(step => step !== 'introduction-only')
  }
  if (!wantsAutomaticIntro) return steps
  const out = [...steps]
  out.splice(out.indexOf('script-only') + 1, 0, 'introduction-only')
  return out
}

router.post('/projects/:slug/pipeline/preflight', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const parsed = parseBatchRequest(req.body)
  const { episodeIds, steps: requestedSteps, force } = parsed
  const requestError = repairRequestError(parsed)
  if (requestError) return res.status(400).json({ detail: requestError })
  if (!episodeIds.length) return res.status(400).json({ detail: 'episode_ids must be a non-empty array' })
  if (!requestedSteps.length) return res.status(400).json({ detail: 'steps must include at least one valid pipeline step' })
  const steps = await applyChannelSegmentIntent(slug, requestedSteps)
  try {
    const result = await preflightBatch(slug, episodeIds, steps, force, parsed.repairMissing, parsed.presetIds)
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
      video_effects: result.videoEffects,
      steps_left_out: result.stepsLeftOut,
      steps_added: result.stepsAdded,
      ...await paidFallbacksWarning(),
    })
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Pipeline preflight failed' })
  }
})

function acceptedPipelineReplay(
  res: Response,
  batchId: string,
  requestedEpisodeIds: string[],
  requestedSteps: BatchStep[],
  jobs: Awaited<ReturnType<typeof jq.findJobs>>,
  force: boolean,
) {
  const byEpisode = new Map(jobs.filter(job => job.episode_id).map(job => [job.episode_id!, job]))
  const reused_jobs = [...byEpisode.values()].map(job => ({ episode_id: job.episode_id!, job_id: job.job_id, type: job.type }))
  const incomplete_episode_ids = [...new Set(requestedEpisodeIds)].filter(episodeId => !byEpisode.has(episodeId))
  const blocked = incomplete_episode_ids.map(episode_id => ({
    episode_id,
    reason: 'This accepted batch has no saved job for this episode. Its outcome is incomplete or unknown; Retry did not start new work.',
    issues: [{ code: 'accepted_batch_incomplete', episode_id, message: 'No immutable accepted job exists for this episode.' }],
  }))
  return res.status(201).json({
    batch_id: batchId,
    enqueued: 0,
    reused: reused_jobs.length,
    total_jobs_planned: 0,
    character_sheets_applied: 0,
    skipped: [],
    blocked,
    incomplete_episode_ids,
    issues: blocked.flatMap(item => item.issues),
    steps_skipped_as_done: [],
    steps_skipped_as_inapplicable: [],
    jobs: [],
    reused_jobs,
    steps: requestedSteps,
    steps_left_out: [],
    steps_added: [],
    warnings: incomplete_episode_ids.length
      ? ['This replay adopted only episodes with immutable accepted jobs; incomplete episodes remain selected for review.']
      : [],
    force,
    video_effects: null,
  })
}

async function runBatch(req: Request<{ slug: string }>, res: Response) {
  const { slug } = req.params
  const parsed = parseBatchRequest(req.body)
  const { episodeIds: episode_ids, steps: requestedSteps, force, repairMissing, actionId, operationId, presetIds } = parsed
  let existingActionJobs: Awaited<ReturnType<typeof jq.findJobs>> = []
  if (force && UUID_V4.test(operationId)) {
    const rawFingerprint = stampFreshGenerationAction(req.body || {}, operationId).generation_action_fingerprint
    existingActionJobs = await jq.findJobs(slug, job => job.params?.generation_action?.id === operationId)
    if (existingActionJobs.some(job => job.params?.pipeline_batch_id !== operationId)) {
      return res.status(409).json({ detail: 'This operation_id is not owned by this Pipeline batch route.' })
    }
    if (existingActionJobs.some(job => job.params?.generation_action_fingerprint !== rawFingerprint)) {
      return res.status(409).json({ detail: 'This operation_id already belongs to a different Pipeline request.' })
    }
    if (existingActionJobs.length) {
      return acceptedPipelineReplay(res, operationId, episode_ids, requestedSteps, existingActionJobs, true)
    }
  } else if (repairMissing && UUID_V4.test(actionId)) {
    const rawFingerprint = pipelineRepairFingerprint(req.body || {})
    existingActionJobs = await jq.findJobs(slug, job => job.params?.pipeline_repair?.action_id === actionId)
    if (existingActionJobs.some(job => job.params?.pipeline_batch_id !== actionId)) {
      return res.status(409).json({ detail: 'This action_id is not owned by this Pipeline repair route.' })
    }
    if (existingActionJobs.length && existingActionJobs.some(job => !job.params?.pipeline_repair_raw_request_fingerprint)) {
      return res.status(409).json({
        code: 'accepted_repair_unverifiable',
        detail: 'This accepted repair predates immutable raw request receipts. Its saved jobs are preserved, but Retry cannot prove this body and did not start new work.',
        saved_jobs: existingActionJobs.map(job => ({ episode_id: job.episode_id!, job_id: job.job_id, type: job.type })),
      })
    }
    if (existingActionJobs.some(job => job.params?.pipeline_repair_raw_request_fingerprint !== rawFingerprint)) {
      return res.status(409).json({ detail: 'This action_id already belongs to a different Pipeline repair request.' })
    }
    if (existingActionJobs.length) {
      return acceptedPipelineReplay(res, actionId, episode_ids, requestedSteps, existingActionJobs, false)
    }
  }
  const requestError = repairRequestError(parsed)
  if (requestError) return res.status(400).json({ detail: requestError })
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  // `force: true` disables per-step idempotency skipping — every selected
  // step runs even if its output already exists. Default is to skip done
  // steps so the batch doesn't silently burn tokens on regeneration.
  if (!episode_ids.length) return res.status(400).json({ detail: 'episode_ids must be a non-empty array' })
  if (!requestedSteps.length) return res.status(400).json({ detail: 'steps must include at least one of ' + VALID_STEPS.join(', ') })
  const steps = await applyChannelSegmentIntent(slug, requestedSteps)

  const preflight = await preflightBatch(slug, episode_ids, steps, force, repairMissing, presetIds)
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
      ...await paidFallbacksWarning(),
    })
  }
  const presetByStep = preflight.presetByStep as Record<BatchStep, StoredPreset>
  const ideaByCode = preflight.ideaByCode
  const effectiveFormat = preflight.effectiveFormat
  // This Mac's app-wide defaults (Settings → Default models), read once with the preflight.
  const defaults = preflight.defaultModels

  // A `metadata` preset can omit a saved model (legacy presets, or ones that never set one). Story
  // Studio never picks one on the owner's behalf (2026-10-03): such a step is skipped below with a
  // plain reason. `introduction-only` reads `preflight.introductionChatModel` /
  // `preflight.scriptSideChatModel` — the owner's own choices — and nothing else.

  let pipelineTranscriptionParams: Awaited<ReturnType<typeof resolvePipelineTranscriptionParams>> | null = null
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
    const motionData = (presetByStep.motion_review.data ?? presetByStep.motion_review) as Record<string, any>
    if (motionData?.renderer !== 'sketch_draw') {
      try {
        pipelineMotionParams = await resolvePipelineMotionParams(presetByStep.motion_review)
      } catch (error: unknown) {
        return res.status(400).json({
          detail: `${error instanceof Error ? error.message : 'Select a current Motion Review variant.'} Nothing was started.`,
        })
      }
    }
  }

  let pipelineScenePlanPromptCap: number | undefined
  let pipelineScenePlanCapSelection: unknown
  let pipelineScenePlanImageModel = ''
  if (presetByStep.scene_plan) {
    const sceneData = scenePlanPresetReceipt(presetByStep.scene_plan).data
    // The SELECTION and its intended model travel with the job so the executor
    // re-resolves the ceiling live. The number below is the admission receipt.
    pipelineScenePlanCapSelection = sceneData.prompt_char_cap
    pipelineScenePlanImageModel = typeof sceneData.intended_image_model === 'string' ? sceneData.intended_image_model : ''
    if (sceneData.intended_image_model) {
      const apiKey = await getApiKey('genstudio').catch(() => '')
      if (!apiKey) {
        return res.status(400).json({ detail: 'Add the Gateway API Key in Settings before Pipeline generates Scene Plan visual prompts. Nothing was started.' })
      }
      try {
        pipelineScenePlanPromptCap = resolveScenePlanPromptCharCap(sceneData, await listImageModels(apiKey))
      } catch (error: any) {
        return res.status(400).json({ detail: `${error.message} Nothing was started.` })
      }
    } else {
      pipelineScenePlanPromptCap = resolveScenePlanPromptCharCap(sceneData, [])
    }
  }

  /**
   * The CHARACTER CEILING for the thumbnail prompts this batch writes.
   *
   * The Scene Plan step has always resolved its ceiling against the live image
   * catalogue; the Thumbnail Prompts step did not, so a Pipeline run wrote
   * thumbnail prompts with NO ceiling at all — and the image model refused them
   * at render time, identically, three times per episode.
   *
   * The thumbnail preset's OWN ceiling inputs — the SELECTION ('auto' / 'none'
   * / a number) and the image model it was chosen for — travel with the job, so
   * the executor resolves the ceiling when the job RUNS, against the live
   * catalogue. A number resolved at admission time is a snapshot: it can be out
   * of date by the time the job runs, and it is out of date forever on a retry.
   *
   * FAILS CLOSED, exactly like the Scene Plan step above. A preset that names
   * an image model the catalogue no longer publishes has no ceiling to resolve
   * and no model to render with: continuing would write prompts with no limit
   * for a model that does not exist, and the run would only fail later, at
   * render time, having already spent credits. Nothing is invented — no
   * fallback model, no fallback number — and NOTHING IS STARTED.
   */
  const thumbnailCapInputs: { intended_image_model: string; prompt_char_cap: unknown } = presetByStep.image_prompts
    ? thumbnailPromptPresetCapInputs(presetByStep.image_prompts)
    : { intended_image_model: '', prompt_char_cap: undefined }
  if (presetByStep.image_prompts) {
    // The ADMISSION check uses the SAME resolver the executor uses, so a
    // malformed selection (boolean, array, object) is refused here before
    // anything is enqueued — the executor will never see a shape it cannot
    // read. The number resolved here is NOT written into the job; the
    // executor resolves again when the job runs, against the live catalogue.
    const capRefusal = await resolveLiveImagePromptCharCap({
      intendedImageModel: thumbnailCapInputs.intended_image_model,
      setting: thumbnailCapInputs.prompt_char_cap,
      label: 'The Thumbnail Prompts preset',
      nothingHappened: 'Nothing was started.',
    })
    if (capRefusal.error) {
      return res.status(400).json({ detail: capRefusal.error })
    }
  }

  const actionFingerprint = force
    ? stampFreshGenerationAction(req.body || {}, operationId).generation_action_fingerprint
    : repairMissing ? pipelineRepairFingerprint({
    slug,
    episode_ids: [...new Set(episode_ids)].sort(),
    steps,
    presets: Object.fromEntries(steps.map(step => [step, presetByStep[step] || null])),
    effective_format: effectiveFormat,
    transcription: pipelineTranscriptionParams,
    motion: pipelineMotionParams,
    default_chat_model: null,
    introduction_chat_model: preflight.introductionChatModel,
    script_chat_model: preflight.scriptSideChatModel,
    visual_settings: Object.fromEntries(
      [...preflight.visualSettingsByEpisode.entries()].map(([episodeId, settings]) => [episodeId, settings]),
    ),
  }) : ''
  const batch_id = repairMissing ? actionId : force ? operationId : randomUUID()
  const repairRawFingerprint = repairMissing ? pipelineRepairFingerprint(req.body || {}) : ''
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
  // normal prerequisite checks above, as does a channel whose retired_media
  // safety check is Off or Warn.
  if (preflight.retiredMediaBlocks) {
    const retiredAtDispatch = await retiredUploadedMediaByEpisode(slug, eligible_episode_ids, preflight.projectFacts)
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
          ...await paidFallbacksWarning(),
        })
      }
    }
  }

  const cueReviewMode = await safetyMode(slug, 'cue_review')
  const cueReviewHolds = cueReviewMode === 'block'
  const sameStepMode = await safetyMode(slug, 'same_step_queued')
  // Preflight's decision is the run's decision. `preflight.steps` already
  // excludes these, but a step can also arrive from a per-episode step list, and
  // the queue is the one place that must not depend on which list was read: a
  // step preflight left out is never enqueued. See `preflightBatch`.
  const leftOutSteps = new Set(preflight.stepsLeftOut.map(left => left.step))
  const runWarnings: string[] = []
  for (const episodeId of eligible_episode_ids) {
    const runSteps = preflight.stepsByEpisode.get(episodeId) ?? preflight.steps
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
    const applicability = applicablePipelineStepsForVisualSource(runSteps, visualSettings.visual_source)
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
    if (!force && runSteps.includes('research')) {
      await autoCompleteResearchReviewForPipeline(slug, episodeId)
    }

    // Idempotency: drop steps whose outputs are already on disk. Keeps
    // batches cheap on partially-generated episodes. The user can opt out
    // with `force: true` to regenerate everything.
    let effectiveSteps: BatchStep[] = applicability.applicable.filter(step => !leftOutSteps.has(step))
    if (!force) {
      // Strict cache read: re-stat this episode's watched paths at its serial
      // admission point. Reuse the bounded-preflight status only while disk
      // still matches; terminal jobs also invalidate this entry immediately.
      const status = await episodeStatusCache.get(
        slug,
        episodeId,
        [...ideaByCode.values()],
        preflight.projectFacts,
      )
      const repairSubtitlesComplete = repairMissing && runSteps.includes('subtitles')
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
        const projectMeta = await projectMetaOnce(slug, preflight.projectFacts)
        const continuityMode = projectMeta?.continuity_mode || 'independent-stills'
        const episodePaths = await resolveEpisodePathsByCode(slug, episodeId, preflight.projectFacts)
        const currentConfig = await readPipelineContinuityConfig(
          episodePaths.episode_dir,
          continuityMode,
          preflight.startingPacing,
        )
        await writeContinuityConfig(
          slug,
          episodeId,
          applyContinuityPresetForPipeline(currentConfig, csData),
          continuityMode,
        )
        characterSheetsApplied++
        const refreshedSource = await readVideoVisualSource(slug, episodeId, preflight.projectFacts)
        if (refreshedSource.source !== visualSettings.visual_source) {
          throw new Error('visual source changed while Pipeline was preparing this episode; submit it again')
        }
        visualSettings = await pipelineVisualSettingsSnapshot(
          slug,
          episodeId,
          refreshedSource,
          true,
          effectiveSteps.includes('motion_review') && !effectiveSteps.includes('scene_plan'),
          preflight.startingPacing,
          preflight.projectFacts,
        )
      } catch (e: any) {
        skipped.push({ episode_id: episodeId, reason: `Character Sheet could not be applied: ${e?.message || e}` })
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
    let cuesUnreviewed = false
    for (const step of effectiveSteps) {
      if (step === 'character_sheet') continue
      if (step === 'script-only') {
        const outlineParams = resolveStepParams('script-only', episodeId, idea.title || '', presetByStep['script-only'], effectiveFormat)
        // A Script preset that names no model runs on this Mac's app-wide writing default. Read,
        // never written back into the preset.
        const scriptDefault = defaultModelForStep('script-only', defaults)
        if (scriptDefault && !String(outlineParams.model || '').trim()) outlineParams.model = scriptDefault
        const episodePaths = await resolveEpisodePathsByCode(slug, episodeId)
        const completion = await inspectChunkedScriptCompletion(episodePaths.script_dir, episodeId)
        // 1.4.359 — the channel's "Chapters per request" setting is reusable
        // configuration from the Script preset, and the expand links below are
        // hand-built (they take every OTHER sizing field from the outline
        // sidecar), so it has to be carried across explicitly or an unattended
        // batch would silently ignore the owner's choice. Absent in an older
        // preset = this format's own default, exactly as before.
        const expansionBatchParams = {
          chapter_batch_mode: outlineParams.chapter_batch_mode ?? undefined,
          chapters_per_request: outlineParams.chapters_per_request ?? undefined,
          chapter_batch_words: outlineParams.chapter_batch_words ?? undefined,
        }
        if (completion.resumable) {
          // An approved outline plus partial chapter files is recoverable.
          // Resume only missing work; rebuilding the outline could discard
          // reviewed creative decisions and spend unnecessary credits.
          chain.push({ type: 'expand_chapters' as JobType, title: `Pipeline: Script (finish missing chapters) — ${episodeId}`, params: { episode_id: episodeId, title: idea.title || '', model: outlineParams.model, auto_approve: true, ...expansionBatchParams } })
        } else {
          chain.push({ type: 'outline_only' as JobType, title: `Pipeline: Script outline — ${episodeId}`, params: { ...outlineParams, auto_approve: true } })
          chain.push({ type: 'expand_chapters' as JobType, title: `Pipeline: Script chapters — ${episodeId}`, params: { episode_id: episodeId, title: idea.title || '', model: outlineParams.model, auto_approve: true, ...expansionBatchParams } })
        }
        continue
      }
      const jobType = jobTypeForStep(step)
      // A stored preset holding a value the resolvers cannot honour (today:
      // only a malformed `prompt_pack_size`) is SKIPPED and named, not quietly
      // repaired into some other number and not allowed to 500 the whole batch
      // enqueue. The operator sees exactly which episode and why.
      let params: Record<string, any>
      try {
        params = resolveStepParams(step, episodeId, idea.title || '', presetByStep[step], effectiveFormat)
        if (step === 'scene_plan') {
          params.prompt_char_cap = pipelineScenePlanPromptCap
          params.prompt_char_cap_selection = pipelineScenePlanCapSelection
          params.intended_image_model = pipelineScenePlanImageModel
        }
        // The thumbnail prompts this step writes need the same treatment. The
        // preset mapper carries the saved SELECTION ('auto' / 'none' / a
        // number) and the image model it was chosen for; both travel with the
        // job, and the executor resolves the ceiling against the LIVE catalogue
        // when the job runs. A number frozen here would be a snapshot that a
        // catalogue change or a retry could silently contradict.
        if (step === 'image_prompts') {
          params.prompt_char_cap = thumbnailCapInputs.prompt_char_cap
          params.intended_image_model = thumbnailCapInputs.intended_image_model
        }
        // A preset that named no model runs on this Mac's app-wide default for that family
        // (Settings → Default models). The default is folded into the JOB's own params, not into
        // the preset or the channel: a job already queued keeps the model it was admitted with,
        // and the next run re-reads the setting. Sketch Draw motion presets need no video model.
        if (step !== 'motion_review' || params.renderer !== 'sketch_draw') {
          const appDefaultModel = defaultModelForStep(step, defaults)
          if (appDefaultModel && !String(params.model || '').trim()) params.model = appDefaultModel
        }
        // 1.4.282 — readable on the job: exactly what this render bakes in. Never read by the render.
        if (step === 'video_assembly') {
          // 1.4.312 — every key this step's resolution produced, and the preset the batch chose for
          // it. Final Video is the one chained step resolved again when its job is actually
          // submitted (`resolveChainedVideoAssemblyParams`), because the channel's Video Assembly
          // preset is the channel's reusable look. Everything the resolution did not produce — the
          // episode's own visual settings, the step facts, the run's force / repair stamps — is
          // carried across untouched.
          const presetKeys = Object.keys(params)
          params = {
            ...params,
            effect_stack: describeEffectStack(params),
            ...(presetIds[step] ? { pipeline_preset_id: presetIds[step] } : {}),
            pipeline_preset_keys: presetKeys,
          }
        }
      } catch (error: any) {
        skipped.push({
          episode_id: episodeId,
          reason: `${pipelineStepLabel(step)}: ${error?.message || String(error)} Fix the saved preset for this step, then run the batch again.`,
        })
        continue
      }
      // Audio Assembly bakes the closing the Video Assembly preset THIS run renders from asks for — not
      // another episode's last render or a different saved preset (the same block preflight checks).
      if (step === 'audio_merge' && !preflight.musicChannel && effectiveSteps.includes('video_assembly')) {
        const vaBundle = presetByStep['video_assembly']
        const closing = vaBundle ? flattenVideoAssemblyBundle(vaBundle.data ?? vaBundle, '', '').post_audio : undefined
        if (closing && typeof closing === 'object') params.closing_post_audio = closing
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
      if (step === 'motion_review') {
        const motionPresetData = (presetByStep.motion_review?.data ?? presetByStep.motion_review) as Record<string, any> | undefined
        if (motionPresetData?.renderer === 'sketch_draw') {
          try {
            const { queuedSceneIds, skippedReasons } = await resolveSketchDrawEligibleScenes(slug, episodeId)
            if (!queuedSceneIds.length) {
              skipped.push({
                episode_id: episodeId,
                reason: `motion_review: ${skippedReasons[0]?.reason || 'no scenes eligible for Sketch Draw'}`,
              })
              continue
            }
            params.renderer = 'sketch_draw'
            params.motion_scene_ids = queuedSceneIds
            params.visual_source = 'scene_plan'
            params.auto_approve_clip = motionPresetData.auto_approve_clip !== undefined
              ? Boolean(motionPresetData.auto_approve_clip)
              : true
          } catch (error: any) {
            skipped.push({
              episode_id: episodeId,
              reason: `motion_review: ${error?.message || String(error)}`,
            })
            continue
          }
        } else if (pipelineMotionParams) {
          Object.assign(params, pipelineMotionParams)
        }
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
      if (preflight.musicChannel) {
        const music = await musicEpisodeStepParams(slug, episodeId, step, params)
        if ('skip' in music) {
          skipped.push({ episode_id: episodeId, reason: `${pipelineStepLabel(step)}: ${music.skip}` })
          continue
        }
        params = music.params
      }
      // Story Studio never picks a writing model: a metadata preset without one is skipped, said plainly.
      if (step === 'metadata' && !params.model && !params.pipeline_model_policy?.metadata) {
        skipped.push({
          episode_id: episodeId,
          reason: `${pipelineStepLabel(step)}: the preset has no writing model saved. Open it on the YouTube `
            + 'Finalizer page, choose a writing model and save the preset. Story Studio does not pick one for you.',
        })
        continue
      }
      chain.push({
        type: jobType,
        title: `Pipeline: ${pipelineStepLabel(step)} — ${episodeId}`,
        params,
      })
      // Editorial review is a deliberate pipeline handoff, never an implicit
      // background approval. A trusted contextual-cue preset may opt into
      // auto-approval; only then can later image/video stages continue.
      // Safety check cue_review: Off/Warn carry on to Scene Review; the cues stay for review later.
      if (step === 'contextual_cues' && params.auto_approve !== true) {
        if (!cueReviewHolds) {
          cuesUnreviewed = true
          continue
        }
        pausedForCueReview = true
        break
      }
    }

    // Every link carries the same immutable episode decision. Later settings
    // edits cannot retarget a queued chain or widen its motion work.
    // Each link gets its own copy: shared objects across links were what the
    // pre-1.4.266 redactor saved as '[CIRCULAR]'.
    for (const link of chain) {
      const episodeVisualSettings = structuredClone(visualSettings) as Record<string, any>
      if (link.type === 'scene_plan_run') {
        for (const key of ['pacing', 'motion_scope', 'motion_level'] as const) {
          if (link.params[key] !== undefined) delete episodeVisualSettings[key]
        }
      }
      if (link.type === 'scene_clips_batch' && link.params.renderer === 'sketch_draw') {
        delete episodeVisualSettings.motion_scene_ids
      }
      link.params = { ...link.params, ...episodeVisualSettings }
    }
    stampPipelineStepFacts(chain, visualSettings.visual_source, preflight.musicChannel)

    if (repairMissing) {
      for (const link of chain) {
        link.params = applyPipelineRepairParams(link.params, actionId, actionFingerprint, repairRawFingerprint)
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
    const [first, ...rest] = chain

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
      // Safety check same_step_queued: Off/Warn hand the rest of this run to the job already there.
      const joined = sameStepMode === 'block' ? null : await jq.joinActiveSameStep({
        project_slug: slug,
        episode_id: episodeId,
        type: first.type,
        pipeline_chain: rest,
        pipeline_batch_id: batch_id,
      })
      if (joined && !joined.conflict) {
        if (sameStepMode === 'warn') {
          runWarnings.push(`${episodeId}: ${pipelineStepLabel(CHAIN_LINK_STEP[first.type] || first.type)} was already queued or running (job ${joined.job.job_id}); this run joined it.`)
        }
        reused.push({ episode_id: episodeId, job_id: joined.job.job_id, type: joined.job.type })
        totalEnqueuedStepCount += rest.length
        continue
      }
      skipped.push({ episode_id: episodeId, reason: `${pipelineStepLabel(CHAIN_LINK_STEP[first.type] || first.type)} is already queued or running for this episode — see Jobs.` })
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
      }, {}, !preflight.retiredMediaBlocks ? undefined : async () => {
        const status = await readLocalMediaCleanupStatus(slug, episodeId, preflight.projectFacts)
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
    if (cuesUnreviewed && cueReviewMode === 'warn') {
      runWarnings.push(`${episodeId}: Contextual Cues are not approved automatically, so they wait for your review; `
        + 'this run goes on to Scene Review without waiting for it.')
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
    steps_left_out: preflight.stepsLeftOut,
    steps_added: preflight.stepsAdded,
    warnings: [...preflight.warnings, ...runWarnings],
    force,
    video_effects: preflight.videoEffects,
    ...await paidFallbacksWarning(),
  })
}

router.post('/projects/:slug/pipeline/run-batch', async (req, res) => {
  const parsed = parseBatchRequest(req.body)
  if (parsed.repairMissing) return withLock(`pipeline-repair:${req.params.slug}:${parsed.actionId}`, () => runBatch(req, res))
  if (parsed.force) return withLock(`pipeline-force:${req.params.slug}:${parsed.operationId}`, () => runBatch(req, res))
  return runBatch(req, res)
})
