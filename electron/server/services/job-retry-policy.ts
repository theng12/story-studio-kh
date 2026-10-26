import type { Job, JobType } from '../models/types.js'
import { isFreeFleetModelId } from '../contracts/provider-task-state.js'
import { pipelinePolicyForJob, type PipelineModelPolicyStage } from '../lib/pipeline-model-policy.js'
import { hasFinalRenderRemoteWaitMarker } from '../lib/final-render-remote-wait.js'
import { ImagePromptCapUnavailableError, PromptAssemblyTooLargeError, PromptLengthExceededError } from './prompt-char-cap.js'

export interface JobAutoRetryPolicy {
  eligible: boolean
  max_attempts: number
  delays_ms: number[]
  reason: string
}

const MANUAL_ONLY: JobAutoRetryPolicy = {
  eligible: false,
  max_attempts: 1,
  delays_ms: [],
  reason: 'External or unverified provider work requires a manual Retry.',
}

const LOCAL_RETRY_DELAYS_MS = [2_000, 8_000]
/** A fleet hiccup (a Mac restarting, a model reloading) lasts minutes, not seconds. */
const FREE_FLEET_RETRY_DELAYS_MS = [60_000, 300_000]

/**
 * Test-only compression of the retry SCHEDULE — never of the retry POLICY.
 *
 * A backend test that drives a job to its second attempt otherwise sits through
 * the real wait: 60 s then 300 s for free-fleet work, 2 s then 8 s locally. The
 * assertion is about what the second attempt DOES (which parts it submits, what
 * the log says), never about how long the customer waited first, so the wait is
 * the one part of the scenario with no product property behind it.
 *
 * The override replaces each delay's VALUE and keeps the list's LENGTH, so
 * `max_attempts`, eligibility and the reason are untouched: a test still proves
 * the same number of attempts happen for the same reasons. Production leaves
 * this null and gets the published schedule.
 */
let retryDelaysOverrideMs: number | null = null
export function _setJobAutoRetryDelaysForTesting(ms: number | null): void {
  retryDelaysOverrideMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
    ? Math.floor(ms)
    : null
}

function localPolicy(reason: string, delays = LOCAL_RETRY_DELAYS_MS): JobAutoRetryPolicy {
  return {
    eligible: true,
    max_attempts: delays.length + 1,
    delays_ms: retryDelaysOverrideMs === null
      ? [...delays]
      : delays.map(() => retryDelaysOverrideMs as number),
    reason,
  }
}

function value(params: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = params?.[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().toLowerCase()
  }
  return ''
}

/** Chat Studio can proxy cloud providers. Only a normal chatstudio:<repo>
 * identifier proves that inference stays on the local fleet. */
export function isLocalTextModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized.startsWith('chatstudio:')
    && !normalized.startsWith('chatstudio:provider:')
}

export function isLocalImageModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith('imagestudio:')
}

export function isLocalAudioModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized.startsWith('voicestudio-') || normalized.startsWith('macos-')
}

const ALWAYS_LOCAL_TYPES = new Set<JobType>([
  'audio_merge',
  'broll_select',
  'broll_normalize',
  'broll_assemble',
  // Spend nothing: FFmpeg over songs and images already on disk.
  'music_video',
  'music_episode_build',
])

/**
 * Retrying local work and stopping it safely are separate claims. These four
 * executors are the only ones whose child-process/cooperative-stop behaviour
 * has been proven; a local model name alone never permits a Stop control.
 */
const SAFE_LOCAL_STOP_TYPES = new Set<JobType>([
  'video_assembly',
  'audio_merge',
  'broll_normalize',
  'broll_assemble',
])

export function isProvenLocalStopCapableJob(job: Pick<Job, 'type' | 'params'>): boolean {
  return SAFE_LOCAL_STOP_TYPES.has(job.type)
}

/** Chat work, by the Pipeline policy stage that may choose its model. */
const TEXT_MODEL_STAGES: Partial<Record<JobType, PipelineModelPolicyStage | null>> = {
  'introduction-only': 'introduction-only',
  'chapter-only': 'script-only',
  outline_only: 'script-only',
  expand_chapters: 'script-only',
  image_prompts: 'image_prompts',
  metadata: 'metadata',
  contextual_cues: 'contextual_cues',
  research_run: 'research',
  scene_plan_run: 'scene_plan',
  idea_campaign: 'ideas',
  music_scene_polish: null,
}

/** Chat writing work. Running it again keeps saved answers and collects earlier requests by key where it can. */
export function isChatTextJob(type: string): boolean {
  return type in TEXT_MODEL_STAGES
}

/** Image work that may run on the free fleet. continuity_render is the scene render. */
const IMAGE_MODEL_TYPES = new Set<JobType>([
  'thumb_images',
  'scene_image_generate',
  'continuity_render',
  'composition_generate',
  'image_pool_generate',
])

const PAID_MANUAL_REASON = 'Paid image and transcription work stays manual so it is never submitted twice; press Retry when ready.'

let automaticRetryOffForTests = false
/** Test files that pin manual Retry behaviour turn automatic retry off for that file's process. */
export function _setAutomaticRetryForTesting(enabled: boolean): void {
  automaticRetryOffForTests = !enabled
}

/**
 * Deny-by-default retry classification (owner, 2026-10-07):
 * - free fleet (`studio-hub::`) work always retries by itself, 60 s then 300 s;
 * - chat work retries too, paid included ("LLM is cheap"); a Pipeline run reconnects its
 *   earlier request by the saved key first, and scene prompts collect theirs the same way;
 * - paid image and transcription work stays manual;
 * - local work retries quickly.
 */
export function resolveJobAutoRetryPolicy(
  job: Pick<Job, 'type' | 'params' | 'final_render_remote_wait'>,
): JobAutoRetryPolicy {
  const params = job.params || {}
  if (params.auto_retry === false || automaticRetryOffForTests) {
    return { ...MANUAL_ONLY, reason: 'Automatic retry was disabled for this job.' }
  }

  if (job.type === 'video_assembly') {
    if (hasFinalRenderRemoteWaitMarker(job)) {
      return { ...MANUAL_ONLY, reason: 'Remote video assembly remains parked until its original lineage is reconciled.' }
    }
    return localPolicy('Local video assembly can retry without provider charges.')
  }

  if (ALWAYS_LOCAL_TYPES.has(job.type)) {
    return localPolicy('Local file processing can retry without provider charges.')
  }

  if (job.type === 'subtitles_transcribe') {
    return isFreeFleetModelId(value(params, 'model'))
      ? localPolicy('Free transcription on your own Macs costs nothing to repeat; a retry transcribes only the sections still missing.', FREE_FLEET_RETRY_DELAYS_MS)
      : { ...MANUAL_ONLY, reason: PAID_MANUAL_REASON }
  }

  if (job.type === 'audio') {
    const model = value(params, 'model')
    if (isLocalAudioModel(model)) return localPolicy('Local TTS preserves completed section audio files.')
    // The owner's own Studio Hub fleet (`studio-hub::`) costs nothing to ask again, and a failed
    // part there is usually the Mac (a slow M1 past its deadline) or Whisper mishearing a short
    // section, not the text (Breeze night-atlas, 2026-10-05: 6 episodes left with one failed part).
    // Each retry submits only the parts still missing on disk, under a fresh request identity.
    return isFreeFleetModelId(model)
      ? localPolicy('Free narration on your own Macs costs nothing to repeat; a retry submits only the missing parts.', FREE_FLEET_RETRY_DELAYS_MS)
      : MANUAL_ONLY
  }

  if (job.type === 'scene_plan_run' && value(params, 'stage') === 'timeline') {
    return localPolicy('Timeline construction is deterministic local work.')
  }

  if (job.type in TEXT_MODEL_STAGES) {
    // The EFFECTIVE model: a Pipeline run's policy model overrides `params.model`, exactly as
    // the generators do. No model at all means the generator resolves the project's default
    // chat model, which is still chat — so it retries like any other chat model.
    const stage = TEXT_MODEL_STAGES[job.type]
    const policyModel = stage ? pipelinePolicyForJob(params, stage)?.assigned_model : undefined
    const model = policyModel?.trim().toLowerCase()
      || value(params, 'model', 'vision_model', 'ai_model', 'llm_model')
      || value(params.settings || {}, 'model')
    const product = model.replace(/^genstudio-chat:/, '')
    if (isLocalTextModel(product)) {
      return localPolicy('Chat Studio inference runs on your own hardware and preserves completed items.')
    }
    return localPolicy(isFreeFleetModelId(product)
      ? 'Free writing on your own Macs costs nothing to repeat; a retry first collects any earlier answer, then asks only for what is missing.'
      : 'Writing retries automatically; a retry first collects any earlier answer by its saved key where it has one, then asks only for what is missing.',
    FREE_FLEET_RETRY_DELAYS_MS)
  }

  if (IMAGE_MODEL_TYPES.has(job.type)) {
    const model = value(params, 'model')
    if (isLocalImageModel(model)) {
      return localPolicy('Image Studio generation runs on your own hardware and preserves completed images.')
    }
    if (isFreeFleetModelId(model)) {
      return localPolicy('Free images on your own Macs cost nothing to repeat; a retry submits only the missing images.', FREE_FLEET_RETRY_DELAYS_MS)
    }
    // Paid GenStudio images stay manual. (This once read `model.startsWith('genstudio-image')`,
    // which stopped matching when products began publishing handles such as `gpt-image-2`.)
    return model ? { ...MANUAL_ONLY, reason: PAID_MANUAL_REASON } : MANUAL_ONLY
  }

  return MANUAL_ONLY
}

/**
 * An error that the same job cannot get past by running again: a preflight or input problem
 * (a plan saved without its pacing snapshot, a subtitle coverage gap). Marked errors skip the
 * automatic retry delays and fail at once with the fix in their message.
 */
export function nonRetryable<E extends Error>(error: E): E {
  return Object.assign(error, { retryable: false })
}

/**
 * Input and configuration refusals ("episode_id is required", "No writing model is chosen", "no title
 * yet"): the job's params lack something no rerun can supply, so they fail once with the reason
 * instead of three tries at 60 s. Matched on the message because they are thrown from many generators.
 *
 * The published-ceiling refusal belongs here too, and it is the one that used to cost three
 * identical attempts: the prompt is a stored artefact, so re-running the job submits the same bytes
 * and the model refuses them the same way. Every attempt was free (the guard fires before the
 * charged POST) and every attempt was wasted.
 */
const INPUT_REFUSAL = [
  /^[a-z_]+ is required$/i,
  /^At least one \w+ is required$/i,
  /\bNo (?:writing )?model (?:is chosen|was picked|selected)\b/i,
  /\bhas no title yet\b/i,
  /accepts up to [\d,]+ prompt characters/i,
]

export function isNonRetryableError(error: unknown): boolean {
  if ((error as { retryable?: unknown } | null)?.retryable === false) return true
  // TYPED first: a prompt the published ceiling will reject is deterministic.
  // The typed identity is what survives the hop through an aggregate completion
  // error, where the wording of the original refusal is gone.
  if (error instanceof PromptLengthExceededError) return true
  // Same shape, different cause: the published ceiling is shorter than the
  // clauses and extras the prompt needs, so no prompt body fits at all.
  if (error instanceof PromptAssemblyTooLargeError) return true
  // The ceiling could not be RESOLVED at all: the selected image model is no
  // longer in the catalogue, the selection is malformed, or the Gateway key is
  // missing. A rerun meets the same catalogue, so it would refuse the same
  // way — three attempts to learn nothing.
  if (error instanceof ImagePromptCapUnavailableError) return true
  const message = error instanceof Error ? error.message.trim() : ''
  return INPUT_REFUSAL.some(pattern => pattern.test(message))
}
