import { createHash } from 'crypto'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'

export const PIPELINE_MODEL_POLICY_STAGES = [
  'ideas',
  'script-only',
  'introduction-only',
  'research',
  'metadata',
  'image_prompts',
  'scene_plan',
  'contextual_cues',
] as const

export type PipelineModelPolicyStage = typeof PIPELINE_MODEL_POLICY_STAGES[number]
/** One writing model per step (owner, 2026-10-03). Fallback across models is a Gateway pool. */
export type PipelineModelPolicyMode = 'single'

export interface PipelineModelPolicy {
  mode: PipelineModelPolicyMode
  models: string[]
}

export interface AssignedPipelineModelPolicy extends PipelineModelPolicy {
  assigned_model: string
}

export type PipelinePolicyAttemptStatus = 'in_flight' | 'accepted' | 'succeeded' | 'failed_unaccepted' | 'failed_terminal' | 'unknown' | 'waiting' | 'exhausted'
export interface PipelinePolicyAttemptCheckpoint {
  input_fingerprint: string
  candidates: string[]
  candidate_index: number
  candidate_model: string
  status: PipelinePolicyAttemptStatus
  idempotency_key?: string
  /** Written by older builds; read so their checkpoints stay valid, never written. */
  retry_epochs?: number[]
  retry_at?: string
  updated_at: string
}

export interface PipelinePolicyCheckpointStore {
  read(key: string): unknown
  write(key: string, value: PipelinePolicyAttemptCheckpoint): Promise<void>
}

const ATTEMPT_STATUSES = new Set<PipelinePolicyAttemptStatus>([
  'in_flight', 'accepted', 'succeeded', 'failed_unaccepted', 'failed_terminal', 'unknown', 'waiting', 'exhausted',
])

/** Accept only a complete, self-consistent persisted attempt record. */
export function readPipelinePolicyAttemptCheckpoint(value: unknown): PipelinePolicyAttemptCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const candidateIndex = candidate.candidate_index
  if (typeof candidate.input_fingerprint !== 'string' || !candidate.input_fingerprint
    || !Array.isArray(candidate.candidates) || !candidate.candidates.every(item => typeof item === 'string' && !!item)
    || typeof candidateIndex !== 'number' || !Number.isSafeInteger(candidateIndex) || candidateIndex < 0
    || typeof candidate.candidate_model !== 'string' || !candidate.candidate_model
    || typeof candidate.status !== 'string' || !ATTEMPT_STATUSES.has(candidate.status as PipelinePolicyAttemptStatus)
    || typeof candidate.updated_at !== 'string' || !candidate.updated_at
    || (candidate.idempotency_key !== undefined && (typeof candidate.idempotency_key !== 'string' || !candidate.idempotency_key))
    || (candidate.retry_epochs !== undefined && (!Array.isArray(candidate.retry_epochs)
      || candidate.retry_epochs.length !== candidate.candidates.length
      || candidate.retry_epochs.some(epoch => typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0)))
    || (candidate.retry_at !== undefined && (typeof candidate.retry_at !== 'string' || !candidate.retry_at))) {
    return null
  }
  const index = candidateIndex as number
  if (candidate.candidates[index] !== candidate.candidate_model) return null
  if (candidate.status === 'accepted' && !candidate.idempotency_key) return null
  if (candidate.status === 'waiting' && !candidate.retry_at) return null
  return candidate as unknown as PipelinePolicyAttemptCheckpoint
}

export function pipelinePolicyInputFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

/** A per-job store that preserves independent logical request entries. */
export function pipelinePolicyCheckpointStore(
  params: Record<string, any>,
  persist: () => Promise<void>,
): PipelinePolicyCheckpointStore {
  const checkpoints = () => {
    const value = params.pipeline_model_checkpoints
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, PipelinePolicyAttemptCheckpoint> : {}
  }
  return {
    read: key => checkpoints()[key] || null,
    write: async (key, value) => {
      params.pipeline_model_checkpoints = { ...checkpoints(), [key]: value }
      await persist()
    },
  }
}

export function pipelinePolicyForJob(jobParams: unknown, stage: PipelineModelPolicyStage): AssignedPipelineModelPolicy | null {
  const raw = (jobParams as Record<string, unknown> | null | undefined)?.pipeline_model_policy
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const policy = (raw as Record<string, unknown>)[stage]
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
  const candidate = policy as Record<string, unknown>
  // A job queued by an older build under the retired LLM lineup already carries
  // its model in `params.model`; it runs on that one model like any page job.
  if (candidate.wait_for_availability === true) return null
  const assignedModel = typeof candidate.assigned_model === 'string'
    ? resolveGenStudioModelId('chat', candidate.assigned_model)
    : null
  if (!assignedModel || !Array.isArray(candidate.models)
    || !candidate.models.some(model => typeof model === 'string' && resolveGenStudioModelId('chat', model) === assignedModel)) return null
  // Older builds could queue several models for one step; only the one this
  // episode was assigned ever runs now.
  return { mode: 'single', models: [assignedModel], assigned_model: assignedModel }
}
