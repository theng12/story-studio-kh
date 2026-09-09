import { createHash } from 'crypto'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'

export const PIPELINE_MODEL_POLICY_STAGES = [
  'script-only',
  'introduction-only',
  'research',
  'metadata',
  'image_prompts',
  'scene_plan',
  'contextual_cues',
] as const

export type PipelineModelPolicyStage = typeof PIPELINE_MODEL_POLICY_STAGES[number]
export type PipelineModelPolicyMode = 'single' | 'distribute' | 'backup'

export interface PipelineModelPolicy {
  mode: PipelineModelPolicyMode
  models: string[]
}

export interface AssignedPipelineModelPolicy extends PipelineModelPolicy {
  assigned_model: string
}

export type PipelinePolicyAttemptStatus = 'in_flight' | 'accepted' | 'succeeded' | 'failed_unaccepted' | 'unknown' | 'exhausted'
export interface PipelinePolicyAttemptCheckpoint {
  input_fingerprint: string
  candidates: string[]
  candidate_index: number
  candidate_model: string
  status: PipelinePolicyAttemptStatus
  idempotency_key?: string
  updated_at: string
}

export interface PipelinePolicyCheckpointStore {
  read(key: string): unknown
  write(key: string, value: PipelinePolicyAttemptCheckpoint): Promise<void>
}

export type PipelineModelPolicies = Partial<Record<PipelineModelPolicyStage, PipelineModelPolicy>>

const STAGE_SET = new Set<string>(PIPELINE_MODEL_POLICY_STAGES)
const MODES = new Set<PipelineModelPolicyMode>(['single', 'distribute', 'backup'])
const ATTEMPT_STATUSES = new Set<PipelinePolicyAttemptStatus>([
  'in_flight', 'accepted', 'succeeded', 'failed_unaccepted', 'unknown', 'exhausted',
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
    || (candidate.idempotency_key !== undefined && (typeof candidate.idempotency_key !== 'string' || !candidate.idempotency_key))) {
    return null
  }
  const index = candidateIndex as number
  if (candidate.candidates[index] !== candidate.candidate_model) return null
  if (candidate.status === 'accepted' && !candidate.idempotency_key) return null
  return candidate as unknown as PipelinePolicyAttemptCheckpoint
}

/**
 * Parse the public Pipeline override contract before any jobs are queued.
 * Product ids are normalized through the same migration boundary used by the
 * AI client; no provider or name based equivalence is inferred here.
 */
export function normalizePipelineModelPolicies(value: unknown): PipelineModelPolicies {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('model_policies must be an object keyed by eligible Pipeline stages')
  }

  const result: PipelineModelPolicies = {}
  for (const [stage, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!STAGE_SET.has(stage)) {
      throw new Error(`model_policies does not support the '${stage}' stage`)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`model_policies.${stage} must contain mode and models`)
    }
    const candidate = raw as Record<string, unknown>
    const mode = candidate.mode
    if (typeof mode !== 'string' || !MODES.has(mode as PipelineModelPolicyMode)) {
      throw new Error(`model_policies.${stage}.mode must be single, distribute, or backup`)
    }
    if (!Array.isArray(candidate.models) || candidate.models.length === 0 ||
        candidate.models.some(model => typeof model !== 'string' || !model.trim())) {
      throw new Error(`model_policies.${stage}.models must contain non-empty product ids`)
    }
    const models = candidate.models.map(model => resolveGenStudioModelId('chat', model as string))
    if (models.some(model => !model)) {
      throw new Error(`model_policies.${stage}.models contains an invalid product id`)
    }
    const normalized = models as string[]
    if (new Set(normalized).size !== normalized.length) {
      throw new Error(`model_policies.${stage}.models must contain distinct products`)
    }
    if (mode === 'single' && normalized.length !== 1) {
      throw new Error(`model_policies.${stage}.single requires exactly one product`)
    }
    if ((mode === 'distribute' || mode === 'backup') && normalized.length < 2) {
      throw new Error(`model_policies.${stage}.${mode} requires at least two products`)
    }
    result[stage as PipelineModelPolicyStage] = { mode: mode as PipelineModelPolicyMode, models: normalized }
  }
  return result
}

/** Stable assignment for a stage/episode pair. It is independent of queue order. */
export function assignedPipelineModel(
  stage: PipelineModelPolicyStage,
  episodeId: string,
  policy: PipelineModelPolicy,
): string {
  // Backup order is customer-authored: the first product is always the
  // primary. Only distribution hashes the episode into the selected pool.
  if (policy.mode !== 'distribute') return policy.models[0]!
  const digest = createHash('sha256').update(`${stage}:${episodeId}`).digest()
  const index = digest.readUInt32BE(0) % policy.models.length
  return policy.models[index]!
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

export function assignedPipelinePolicy(
  stage: PipelineModelPolicyStage,
  episodeId: string,
  policy: PipelineModelPolicy,
): AssignedPipelineModelPolicy {
  return { ...policy, assigned_model: assignedPipelineModel(stage, episodeId, policy) }
}

export function pipelinePolicyForJob(jobParams: unknown, stage: PipelineModelPolicyStage): AssignedPipelineModelPolicy | null {
  const raw = (jobParams as Record<string, unknown> | null | undefined)?.pipeline_model_policy
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const policy = (raw as Record<string, unknown>)[stage]
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
  const candidate = policy as Record<string, unknown>
  if (typeof candidate.assigned_model !== 'string' || !candidate.assigned_model.trim()) return null
  try {
    const policy = normalizePipelineModelPolicies({
      [stage]: { mode: candidate.mode, models: candidate.models },
    })[stage]
    const assignedModel = resolveGenStudioModelId('chat', candidate.assigned_model)
    if (!policy || !assignedModel || !policy.models.includes(assignedModel)) return null
    return { ...policy, assigned_model: assignedModel }
  } catch {
    return null
  }
}

/** Return blocking catalogue messages for an already-normalized policy. */
export function validatePipelineModelCatalogue(
  policies: PipelineModelPolicies,
  catalogue: Array<{ id: string; available: boolean; qualification_only: boolean }>,
): string[] {
  const byId = new Map(catalogue.map(model => [model.id, model]))
  const errors: string[] = []
  for (const [stage, policy] of Object.entries(policies)) {
    for (const modelId of policy?.models || []) {
      const model = byId.get(modelId)
      if (!model) errors.push(`model_policies.${stage}: product "${modelId}" is not in the live GenStudio catalogue`)
      // A temporarily unavailable row remains a valid explicit backup
      // candidate: the shared client may switch only after GenStudio proves
      // that this candidate made no request.
      else if (model.qualification_only) errors.push(`model_policies.${stage}: product "${modelId}" is qualification-only and cannot be selected here`)
    }
  }
  return errors
}
