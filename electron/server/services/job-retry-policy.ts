import type { Job, JobType } from '../models/types.js'
import { isFreeFleetModelId } from '../contracts/provider-task-state.js'

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

function localPolicy(reason: string, delays = LOCAL_RETRY_DELAYS_MS): JobAutoRetryPolicy {
  return {
    eligible: true,
    max_attempts: delays.length + 1,
    delays_ms: [...delays],
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

const TEXT_MODEL_TYPES = new Set<JobType>([
  'introduction-only',
  'chapter-only',
  'outline_only',
  'expand_chapters',
  'image_prompts',
  'metadata',
  ])

const IMAGE_MODEL_TYPES = new Set<JobType>([
  'thumb_images',
  'scene_image_generate',
    'continuity_render',
  'composition_generate',
  'image_pool_generate',
])

/**
 * Deny-by-default retry classification.
 *
 * "Free" means no external provider submission: this Mac performs the compute.
 * A free tier on a cloud API is still an API and
 * is deliberately manual-only because automatic resubmission can consume
 * quota or create duplicate provider tasks.
 */
export function resolveJobAutoRetryPolicy(
  job: Pick<Job, 'type' | 'params'>,
): JobAutoRetryPolicy {
  const params = job.params || {}
  if (params.auto_retry === false) {
    return { ...MANUAL_ONLY, reason: 'Automatic retry was disabled for this job.' }
  }

  if (job.type === 'video_assembly') {
    return localPolicy('Local video assembly can retry without provider charges.')
  }

  if (ALWAYS_LOCAL_TYPES.has(job.type)) {
    return localPolicy('Local file processing can retry without provider charges.')
  }

  if (job.type === 'subtitles_transcribe') {
    return {
      ...MANUAL_ONLY,
      reason: 'Story Studio already retries free catalog/network reads and reconnects accepted Gateway tasks. Whole-job replay stays manual so terminal paid work is never submitted twice.',
    }
  }

  if (job.type === 'audio') {
    const model = value(params, 'model')
    if (isLocalAudioModel(model)) return localPolicy('Local TTS preserves completed section audio files.')
    // The owner's own Studio Hub fleet (`studio-hub::`) costs nothing to ask again, and a failed
    // part there is usually the Mac (a slow M1 past its deadline) or Whisper mishearing a short
    // section, not the text (Breeze night-atlas, 2026-10-05: 6 episodes left with one failed part).
    // Each retry submits only the parts still missing on disk, under a fresh request identity.
    return isFreeFleetModelId(model)
      ? localPolicy('Free narration on your own Macs costs nothing to repeat; a retry submits only the missing parts.')
      : MANUAL_ONLY
  }

  if (job.type === 'scene_plan_run' && value(params, 'stage') === 'timeline') {
    return localPolicy('Timeline construction is deterministic local work.')
  }

  if (job.type === 'research_run') {
    return value(params, 'source_provider') === 'llm-only' && isLocalTextModel(value(params, 'model'))
      ? localPolicy('LLM-only research runs on your own Chat Studio.')
      : MANUAL_ONLY
  }

  if (TEXT_MODEL_TYPES.has(job.type) || job.type === 'scene_plan_run') {
    const model = value(params, 'model', 'vision_model', 'ai_model', 'llm_model')
    if (job.type === 'scene_plan_run' && model.startsWith('genstudio-chat:')) {
      // Each retry first reclaims any unresolved pack by its saved idempotency key, so a
      // retry never re-buys a pack. On the owner's free fleet that costs nothing to repeat.
      if (isFreeFleetModelId(model.slice('genstudio-chat:'.length))) {
        return localPolicy('Free scene prompts on your own Macs cost nothing to repeat; a retry first collects any earlier request, then asks only for missing prompts.', FREE_FLEET_RETRY_DELAYS_MS)
      }
      return {
        ...MANUAL_ONLY,
        reason: 'Scene Plan already performs bounded, ID-scoped Gateway prompt repair before it fails; a further provider submission requires a manual Retry.',
      }
    }
    return isLocalTextModel(model)
      ? localPolicy('Chat Studio inference runs on your own hardware and preserves completed items.')
      : MANUAL_ONLY
  }

  if (IMAGE_MODEL_TYPES.has(job.type)) {
    const model = value(params, 'model')
    if (isLocalImageModel(model)) {
      return localPolicy('Image Studio generation runs on your own hardware and preserves completed images.')
    }
    if (job.type === 'continuity_render' && isFreeFleetModelId(model)) {
      return localPolicy('Free scene images on your own Macs cost nothing to repeat; a retry submits only the missing images.', FREE_FLEET_RETRY_DELAYS_MS)
    }
    // The remaining image generators have not proved their terminal-task
    // promotion end to end, so even free fleet work stays manual here. Paid
    // GenStudio work must also stay manual.
    //
    // This used to read `model.startsWith('genstudio-image')`, which silently
    // stopped being true once GenStudio products began publishing customer
    // handles — `gpt-image-2` shares no prefix with anything — and a paid
    // GenStudio job would have fallen through to the generic reason below.
    if (model) {
      return {
        ...MANUAL_ONLY,
        reason: 'Story Studio already retries free catalog/network reads and reconnects accepted Gateway tasks. Whole-job replay stays manual so terminal paid work is never submitted twice.',
      }
    }
    return MANUAL_ONLY
  }

  return MANUAL_ONLY
}
