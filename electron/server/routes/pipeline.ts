/**
 * Pipeline batch runner.
 *
 * Lets the user kick off a chain (script → images → audio → audio_merge)
 * for many accepted ideas at once, using each generator's last-used preset
 * for that step's settings. Designed for overnight runs: one click, walk
 * away. The job-queue chain hook in services/job-queue.ts handles the
 * hand-off between steps on successful completion.
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import * as bp from '../services/broll-pool-manager.js'
import type { Format, JobType } from '../models/types.js'
import { computeEpisodeStatus, type EpisodeStatus } from '../services/asset-status.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { writeContinuityConfig } from './continuity.js'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
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
import { listTranscriptionModels } from '../lib/genstudio-client.js'
import { resolveTranscriptionLanguage } from '../generators/subtitles.js'
import { requireSceneClipGenStudioModel } from '../generators/scene-clip.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'

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
const NO_PRESET_STEPS = new Set<BatchStep>()

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
  'introduction-only': { list: 'script_presets',           activeKeys: ['script_last_preset_introduction', 'script_last_preset'] },
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
  code: 'episode_not_accepted' | 'missing_preset' | 'invalid_preset' | 'missing_voice' | 'missing_prerequisite' | 'missing_local_asset' | 'insufficient_disk'
  message: string
  episode_id?: string
  step?: BatchStep
  path?: string
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
   * `script` preset. The channel opening has no model control of its own —
   * on the Script Generator it is written with whatever model the chapters
   * use (scripts.vue `submitIntroduction` sends `form.model`) — so this is
   * the operator's actual selection for `introduction-only`. Null when no
   * script preset carries one; the batch then says so instead of guessing.
   */
  scriptSideChatModel: string | null
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

  const presetByStep: Partial<Record<BatchStep, StoredPreset>> = {}
  const contextualCuesEnabled = config.contextual_cues?.enabled === true
  if (steps.includes('contextual_cues') && !contextualCuesEnabled) {
    issues.push({ code: 'invalid_preset', step: 'contextual_cues', message: 'Enable Contextual Cues in its project setting before adding it to Pipeline.' })
  }
  for (const step of steps) {
    if (NO_PRESET_STEPS.has(step)) continue
    const result = findActivePreset(config, step)
    if (!result.preset) {
      issues.push({ code: 'missing_preset', step, message: result.missingReason || `No active preset for ${step}` })
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

  if (steps.includes('audio')) {
    const audioPreset = presetByStep.audio
    const voice = audioPreset?.data?.form?.voice ?? (audioPreset as any)?.form?.voice
    if (!voice || !String(voice).trim()) {
      issues.push({ code: 'missing_voice', step: 'audio', message: 'Audio preset has no voice selected.' })
    }
  }
  if (steps.includes('broll')) {
    const poolId = (config as any).broll_pool_id
    const pool = poolId ? await bp.getPool(poolId) : null
    if (!poolId || !pool) {
      issues.push({ code: 'invalid_preset', step: 'broll', message: 'No B-Roll pool is subscribed to this project.' })
    } else if (!existsSync(pool.folder_path)) {
      issues.push({ code: 'missing_local_asset', step: 'broll', path: pool.folder_path, message: `B-Roll pool is offline: ${pool.folder_path}` })
    }
  }

  const ideas = await im.getIdeas(slug, 'accepted')
  const ideaByCode = new Map(ideas.filter(i => i.episode_code).map(i => [i.episode_code!, i]))
  const effectiveFormat = await getEffectiveFormat(slug)
  for (const episodeId of episodeIds) {
    if (!ideaByCode.has(episodeId)) {
      issues.push({ code: 'episode_not_accepted', episode_id: episodeId, message: `${episodeId} is not an accepted episode.` })
      continue
    }
    const status = await computeEpisodeStatus(slug, episodeId)
    const available = new Set<BatchStep>()
    for (const step of VALID_STEPS) {
      if (isStepAlreadyDone(status, step, effectiveFormat)) available.add(step)
    }
    for (const step of steps) {
      // A single selected step is normally a targeted repair/regeneration
      // operation. YouTube Finalizer is the exception: it must not spend an
      // LLM call until measured Audio Assembly timing exists.
      if (steps.length === 1 && step !== 'metadata') {
        available.add(step)
        continue
      }
      // `status.contextual_cues` is the readiness answer (nothing outstanding),
      // NOT the "already produced" answer `available` carries — see
      // `prerequisitesForStep`. An episode that never proposed a cue is not
      // held back; one with an unresolved proposal still is.
      const cueReviewPending = contextualCuesEnabled
        && (steps.includes('contextual_cues') || status.contextual_cues === false)
      const missing = prerequisitesForStep(step, cueReviewPending).filter(required => !available.has(required))
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

  const estimateInputs = extractEstimateInputs(presetByStep as Record<BatchStep, StoredPreset>, episodeIds.length)
  const estimatedBytes = estimateRunBatchBytes(steps as EstimateStep[], estimateInputs)
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

  const scriptSideChatModel = steps.includes('introduction-only')
    ? resolveScriptSideChatModel(config)
    : null

  return {
    ok: issues.length === 0, issues, warnings, presetByStep, ideaByCode,
    effectiveFormat, estimatedBytes, freeBytes, scriptSideChatModel,
  }
}

/**
 * The language model a batched channel opening must be written with.
 *
 * The opening has NO model control of its own, by design — there is one
 * language-model picker on the Script Generator and the opening shares it
 * (scripts.vue's `submitIntroduction` sends `form.model`). The typed
 * `introduction` preset therefore stores only the opening's own settings
 * (host name, word target, opening line, beats) and has never carried a
 * model. Read the operator's real selection from the active `script`
 * preset instead, so a batched opening is written by the same product as
 * its chapters rather than by a catalogue default he never chose.
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
  preset: StoredPreset,
  format?: Format | null,
): Record<string, any> {
  const data = preset.data || preset
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
    // Typed `introduction` preset (see scripts.vue introPresets):
    //   { intro: { host_name, word_target, custom_opening, enabled },
    //     introBeats: [{ id, label, enabled, custom? }, ...] }
    // The introduction-only endpoint expects a flat shape with the model
    // pulled from script-side context. Older presets can omit model — this
    // mapper is a pure/sync preset→params transform with no catalog access,
    // so it never invents a literal external model id here. An empty model
    // is resolved against GenStudio's live catalog by the async batch
    // runner (see resolveDefaultChatModel in routes/pipeline.ts's
    // run-batch handler) immediately before the job is enqueued.
    const intro = data.intro || {}
    return {
      episode_id: episodeId,
      title: title || '',
      model: typeof data.model === 'string' ? data.model.trim() : '',
      host_name: intro.host_name,
      word_target: intro.word_target,
      custom_opening: intro.custom_opening,
      beats: Array.isArray(data.introBeats)
        ? data.introBeats.filter((b: any) => b.enabled).map((b: any) => b.label)
        : [],
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
      aspect_ratio: typeof data.aspect_ratio === 'string' && data.aspect_ratio ? data.aspect_ratio : '16:9',
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
  if (!selected) throw new Error('The selected transcription model is no longer available.')
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
): Promise<{ model: string; operation: string; duration_seconds: number; resolution: string }> {
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
    return {
      model: `genstudio-video:${resolved.modelId}`,
      operation: resolved.variant.operation,
      duration_seconds: resolved.variant.duration_seconds,
      resolution: resolved.variant.resolution,
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

function parseBatchRequest(body: any): { episodeIds: string[]; steps: BatchStep[]; force: boolean } {
  const episodeIds = Array.isArray(body?.episode_ids) ? body.episode_ids.filter((x: any) => typeof x === 'string' && x) : []
  const stepsRaw: any[] = Array.isArray(body?.steps) ? body.steps : []
  const steps = stepsRaw.filter((s): s is BatchStep => VALID_STEPS.includes(s))
  return { episodeIds, steps, force: body?.force === true }
}

router.post('/projects/:slug/pipeline/preflight', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const { episodeIds, steps, force } = parseBatchRequest(req.body)
  if (!episodeIds.length) return res.status(400).json({ detail: 'episode_ids must be a non-empty array' })
  if (!steps.length) return res.status(400).json({ detail: 'steps must include at least one valid pipeline step' })
  try {
    const result = await preflightBatch(slug, episodeIds, steps, force)
    res.status(result.ok ? 200 : 422).json({
      ok: result.ok,
      issues: result.issues,
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

router.post('/projects/:slug/pipeline/run-batch', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const { episodeIds: episode_ids, steps, force } = parseBatchRequest(req.body)
  // `force: true` disables per-step idempotency skipping — every selected
  // step runs even if its output already exists. Default is to skip done
  // steps so the batch doesn't silently burn tokens on regeneration.
  if (!episode_ids.length) return res.status(400).json({ detail: 'episode_ids must be a non-empty array' })
  if (!steps.length) return res.status(400).json({ detail: 'steps must include at least one of ' + VALID_STEPS.join(', ') })

  const preflight = await preflightBatch(slug, episode_ids, steps, force)
  if (!preflight.ok) {
    return res.status(400).json({
      detail: preflight.issues.length === 1
        ? `${preflight.issues[0]!.message} Nothing was started.`
        : 'Pipeline preflight found blocking problems. Nothing was started.',
      issues: preflight.issues,
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
  // `introduction-only` is deliberately NOT in this list. The opening has no
  // model control of its own, so a catalogue default here is not a fallback
  // for a missing preference — it silently overrides the model the operator
  // chose for the script, which is the model the opening is written with
  // everywhere else. It reads `preflight.scriptSideChatModel` instead.
  let batchDefaultChatModel: string | null = null
  if (steps.includes('metadata')) {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (apiKey) {
      batchDefaultChatModel = await resolveDefaultChatModel(apiKey).then(r => r.modelId).catch(() => null)
    }
  }

  let pipelineTranscriptionParams: { model: string; language?: string } | null = null
  if (steps.includes('subtitles')) {
    try {
      pipelineTranscriptionParams = await resolvePipelineTranscriptionParams(presetByStep.subtitles)
    } catch (error: unknown) {
      return res.status(400).json({
        detail: `${error instanceof Error ? error.message : 'Select a current transcription model and published language.'} Nothing was started.`,
      })
    }
  }

  let pipelineMotionParams: { model: string; operation: string; duration_seconds: number; resolution: string } | null = null
  if (steps.includes('motion_review')) {
    try {
      pipelineMotionParams = await resolvePipelineMotionParams(presetByStep.motion_review)
    } catch (error: unknown) {
      return res.status(400).json({
        detail: `${error instanceof Error ? error.message : 'Select a current Motion Review variant.'} Nothing was started.`,
      })
    }
  }

  const batch_id = randomUUID()
  const enqueued: Array<{ episode_id: string; job_id: string; type: JobType }> = []
  const reused: Array<{ episode_id: string; job_id: string; type: JobType }> = []
  const skipped: Array<{ episode_id: string; reason: string }> = []
  // Per-episode per-step skips — steps that were in `steps` but whose
  // output already exists. Populated only when `force` is falsy.
  const steps_skipped_as_done: Array<{ episode_id: string; step: BatchStep }> = []
  // Running total of actually-enqueued step count across all episodes,
  // used for the response's `total_jobs_planned` so the number reflects
  // what'll really run (not `episodes × steps`).
  let totalEnqueuedStepCount = 0
  // Character-sheet applies are config writes, not jobs — counted separately
  // so the response can report "wrote continuity.json for N episode(s)".
  let characterSheetsApplied = 0

  for (const episodeId of episode_ids) {
    const idea = ideaByCode.get(episodeId)
    if (!idea) {
      skipped.push({ episode_id: episodeId, reason: 'Not found among accepted ideas' })
      continue
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
    let effectiveSteps: BatchStep[] = steps
    if (!force) {
      const status = await computeEpisodeStatus(slug, episodeId)
      effectiveSteps = steps.filter(step => {
        if (isStepAlreadyDone(status, step, effectiveFormat)) {
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
        const csData = (csPreset?.data ?? csPreset) as any
        const projectMeta = await pm.getProject(slug)
        await writeContinuityConfig(
          slug,
          episodeId,
          csData,
          projectMeta?.continuity_mode || 'independent-stills',
        )
        characterSheetsApplied++
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
        const episodePaths = await resolveEpisodePathsByCode(slug, episodeId)
        const completion = await inspectChunkedScriptCompletion(episodePaths.script_dir, episodeId)
        if (completion.resumable) {
          // An approved outline plus partial chapter files is recoverable.
          // Resume only missing work; rebuilding the outline could discard
          // reviewed creative decisions and spend unnecessary credits.
          chain.push({ type: 'expand_chapters' as JobType, title: `[batch] repair chapters — ${episodeId}`, params: { episode_id: episodeId, title: idea.title || '', model: outlineParams.model, auto_approve: true } })
        } else {
          chain.push({ type: 'outline_only' as JobType, title: `[batch] outline — ${episodeId}`, params: { ...outlineParams, auto_approve: true } })
          chain.push({ type: 'expand_chapters' as JobType, title: `[batch] chapters — ${episodeId}`, params: { episode_id: episodeId, title: idea.title || '', model: outlineParams.model, auto_approve: true } })
        }
        continue
      }
      const jobType = jobTypeForStep(step)
      const jobTitleStep = step === 'image_prompts' ? 'thumbnail_prompts' : step
      const params = resolveStepParams(step, episodeId, idea.title || '', presetByStep[step], effectiveFormat)
      if (step === 'subtitles' && pipelineTranscriptionParams) {
        Object.assign(params, pipelineTranscriptionParams)
      }
      if (step === 'motion_review' && pipelineMotionParams) {
        Object.assign(params, pipelineMotionParams)
      }
      if (step === 'introduction-only' && !params.model) {
        // The opening is written with the script's model. Never substitute a
        // catalogue default here: the operator cannot tell an invented model
        // from one he picked, and this step would quietly run on a different
        // product from every other step in the same batch.
        if (!preflight.scriptSideChatModel) {
          skipped.push({
            episode_id: episodeId,
            reason: 'introduction-only: the channel opening is written with the Script Generator\'s language model, ' +
              'and no active script preset carries one. Open Script Generator, choose a model under Main settings, ' +
              'save the script preset, then run this step again. No model was substituted.',
          })
          continue
        }
        params.model = preflight.scriptSideChatModel
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

    // Nothing to enqueue. If the only selected work was the inline character
    // sheet, that's NOT a skip — we did do the work. Otherwise every step was
    // skipped-as-done, so record the skip.
    if (chain.length === 0) {
      if (!effectiveSteps.includes('character_sheet')) {
        skipped.push({ episode_id: episodeId, reason: 'All selected steps already complete' })
      }
      continue
    }

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
      skipped.push({ episode_id: episodeId, reason: `${first.type} already queued/running` })
      continue
    }

    const job = await jq.enqueue({
      project_slug: slug,
      type: first.type,
      episode_id: episodeId,
      title: first.title,
      params: {
        ...first.params,
        pipeline_chain: rest,
        pipeline_batch_id: batch_id,
      },
    })
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
    steps_skipped_as_done,
    jobs: enqueued,
    reused_jobs: reused,
    steps,
    force,
  })
})
