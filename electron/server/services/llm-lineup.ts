import { normalizeLlmLineup, type LlmLineup } from '../contracts/llm-lineup.js'
import { assignedPipelinePolicy, type PipelineModelPolicies, type PipelineModelPolicyStage } from '../lib/pipeline-model-policy.js'
import { getConfig } from './project-manager.js'
import { getApiKey } from './app-secrets-store.js'
import { listChatModels, type GenStudioChatModel } from '../lib/genstudio-client.js'
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'

const WRITING_STAGES: Record<string, PipelineModelPolicyStage> = {
  idea_campaign: 'ideas',
  'script-only': 'script-only',
  outline_only: 'script-only',
  expand_chapters: 'script-only',
  'chapter-only': 'script-only',
  'introduction-only': 'introduction-only',
  research_run: 'research',
  metadata: 'metadata',
  image_prompts: 'image_prompts',
  scene_plan_run: 'scene_plan',
  contextual_cues: 'contextual_cues',
}

export function writingStageForJob(type: string): PipelineModelPolicyStage | null {
  return WRITING_STAGES[type] || null
}

/** Follow a published successor during the retirement warning, before request evidence. */
export function replaceRetiredLineupModels(params: Record<string, any>, catalogue: readonly GenStudioChatModel[]): Record<string, any> {
  if (Object.keys(params.pipeline_model_checkpoints || {}).length || params.genstudio_chat_recovery_preview) return params
  const policies = params.pipeline_model_policy
  if (!policies || typeof policies !== 'object') return params
  const next: Record<string, any> = { ...params, pipeline_model_policy: { ...policies } }
  for (const [stage, policy] of Object.entries(policies) as Array<[string, any]>) {
    if (policy?.wait_for_availability !== true || !Array.isArray(policy.models)) continue
    const models = [...new Set<string>(policy.models.map((saved: string) => {
      const product = findGenStudioProduct(catalogue, saved)
      // Retired products disappear from /chat/models. Follow the published
      // successor while the warning row is visible, never infer one by name.
      const retirementWarning = product?.retires_at && Number.isFinite(Date.parse(product.retires_at))
      if (!retirementWarning || !product?.replacement_model_id) return saved
      const replacement = findGenStudioProduct(catalogue, product.replacement_model_id)
      return replacement && !replacement.qualification_only && !replacement.locked
        ? product.replacement_model_id : saved
    }))]
    if (models.some((id, index) => id !== policy.models[index]) || models.length !== policy.models.length) {
      next.pipeline_model_policy[stage] = {
        ...policy, models, assigned_model: models[0], mode: models.length > 1 ? 'backup' : 'single',
      }
      next.model = models[0]
    }
  }
  return next
}

export function lineupModelPolicies(lineup: LlmLineup): PipelineModelPolicies {
  if (!lineup.enabled) return {}
  return Object.fromEntries([...new Set(Object.values(WRITING_STAGES))].map(stage => [stage, {
    mode: lineup.models.length > 1 ? 'backup' : 'single',
    models: [...lineup.models],
    wait_for_availability: true,
    prefer_savings: lineup.prefer_savings,
  }])) as PipelineModelPolicies
}

/** Freeze choices for the whole chain, including a deliberately disabled lineup. */
export function applyLlmLineupSnapshot(
  type: string, episodeId: string, params: Record<string, any>, lineup: LlmLineup,
): Record<string, any> {
  const stage = WRITING_STAGES[type]
  const result: Record<string, any> = {
    ...params,
    ...(stage || Array.isArray(params.pipeline_chain) ? { llm_lineup_snapshot: structuredClone(lineup) } : {}),
  }
  const policy = lineupModelPolicies(lineup)[stage]
  if (stage && policy && !params.pipeline_model_policy?.[stage]) {
    const assigned = assignedPipelinePolicy(stage, episodeId, policy)
    result.pipeline_model_policy = { ...params.pipeline_model_policy, [stage]: assigned }
    result.model = assigned.assigned_model
  }
  if (Array.isArray(params.pipeline_chain)) {
    result.pipeline_chain = params.pipeline_chain.map((step: any) => ({
      ...step,
      params: applyLlmLineupSnapshot(String(step.type), episodeId, step.params || {},
        Object.prototype.hasOwnProperty.call(step.params || {}, 'llm_lineup_snapshot')
          ? normalizeLlmLineup(step.params.llm_lineup_snapshot) : lineup),
    }))
  }
  return result
}

export async function snapshotLlmLineupParams(
  projectSlug: string, type: string, episodeId: string, params: Record<string, any>,
): Promise<Record<string, any>> {
  if (!WRITING_STAGES[type] && !Array.isArray(params.pipeline_chain)) return params
  const saved = Object.prototype.hasOwnProperty.call(params, 'llm_lineup_snapshot')
    ? params.llm_lineup_snapshot
    : (await getConfig(projectSlug))?.llm_lineup
  let result = applyLlmLineupSnapshot(type, episodeId, params, normalizeLlmLineup(saved))
  if (Object.values(result.pipeline_model_policy || {}).some((policy: any) => policy?.wait_for_availability === true)
    && !Object.keys(result.pipeline_model_checkpoints || {}).length) {
    const key = await getApiKey('genstudio').catch(() => '')
    // Catalogue outages must not erase a queued selection or block recovery.
    // The executor still validates the live catalogue before any submission.
    if (key) result = replaceRetiredLineupModels(result, await listChatModels(key).catch(() => []))
  }
  return result
}
