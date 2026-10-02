import { normalizeLlmLineup, type LlmLineup } from '../contracts/llm-lineup.js'
import { assignedPipelinePolicy, type PipelineModelPolicies, type PipelineModelPolicyStage } from '../lib/pipeline-model-policy.js'
import { getConfig } from './project-manager.js'

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
  // Owner decision 2026-10-03: a lineup never follows a gateway-published successor model on its
  // own. A retired choice is named on the Pipeline page instead ("… was retired — choose a replacement").
  return applyLlmLineupSnapshot(type, episodeId, params, normalizeLlmLineup(saved))
}
