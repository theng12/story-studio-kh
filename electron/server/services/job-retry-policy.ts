import type { Job, JobType } from '../models/types.js'

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

function localPolicy(reason: string): JobAutoRetryPolicy {
  return {
    eligible: true,
    max_attempts: LOCAL_RETRY_DELAYS_MS.length + 1,
    delays_ms: [...LOCAL_RETRY_DELAYS_MS],
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
  'video_assembly',
  'broll_select',
  'broll_normalize',
  'broll_assemble',
])

const TEXT_MODEL_TYPES = new Set<JobType>([
  'script-only',
  'introduction-only',
  'chapter-only',
  'outline_only',
  'expand_chapters',
  'image_prompts',
  'metadata',
  'prompt_director',
  'expression_markup',
  'broll_autotag',
])

const IMAGE_MODEL_TYPES = new Set<JobType>([
  'images',
  'scene_images',
  'thumb_images',
  'scene_image_generate',
  'scene_images_batch',
  'continuity_render',
  'composition_generate',
  'image_pool_generate',
])

/**
 * Deny-by-default retry classification.
 *
 * "Free" means no external provider submission: this Mac or a Studio Hub
 * worker performs the compute. A free tier on a cloud API is still an API and
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

  if (ALWAYS_LOCAL_TYPES.has(job.type)) {
    return localPolicy('Local file processing can retry without provider charges.')
  }

  if (job.type === 'subtitles_transcribe') {
    return value(params, 'engine') === 'voicestudio'
      ? localPolicy('Voice Studio transcription is local and preserves completed chapter SRT files.')
      : MANUAL_ONLY
  }

  if (job.type === 'audio') {
    return isLocalAudioModel(value(params, 'model'))
      ? localPolicy('Local TTS preserves completed section audio files.')
      : MANUAL_ONLY
  }

  if (job.type === 'scene_plan_run' && value(params, 'stage') === 'timeline') {
    return localPolicy('Timeline construction is deterministic local work.')
  }

  if (job.type === 'research_run') {
    return value(params, 'source_provider') === 'llm-only' && isLocalTextModel(value(params, 'model'))
      ? localPolicy('LLM-only research runs on the local Chat Studio fleet.')
      : MANUAL_ONLY
  }

  if (TEXT_MODEL_TYPES.has(job.type) || job.type === 'scene_plan_run') {
    const model = value(params, 'model', 'vision_model', 'ai_model', 'llm_model')
    return isLocalTextModel(model)
      ? localPolicy('Chat Studio inference runs on the local fleet and preserves completed items.')
      : MANUAL_ONLY
  }

  if (IMAGE_MODEL_TYPES.has(job.type)) {
    return isLocalImageModel(value(params, 'model'))
      ? localPolicy('Image Studio generation runs on the local fleet and preserves completed images.')
      : MANUAL_ONLY
  }

  return MANUAL_ONLY
}
