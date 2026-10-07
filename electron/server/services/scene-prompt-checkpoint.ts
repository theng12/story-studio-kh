import fs from 'fs/promises'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { ScenePlan } from '../models/types.js'
import { inspectScenePromptIntegrity } from './scene-prompt-integrity.js'

export type ScenePromptCheckpointKind = 'visual' | 'motion'

export interface ScenePromptCheckpointResult {
  changed: boolean
  plan: ScenePlan
}

export interface ScenePromptCompletionAudit {
  plan: ScenePlan
  completed_ids: string[]
  missing_ids: string[]
  issues: Array<{ item_id: string; state: 'missing' | 'invalid'; reason: 'missing prompt' | 'duplicate prompt' | 'missing from scene plan' }>
}

/**
 * Re-read the authoritative Scene Plan and prove which requested prompts are
 * durable. Generation code must not report completion from an in-memory
 * worker count because another process, restart, or failed write can make that
 * count disagree with the file consumed by Scene Review.
 */
export async function auditScenePromptCompletion(
  planPath: string,
  targetIds: Iterable<string>,
  kind: ScenePromptCheckpointKind,
): Promise<ScenePromptCompletionAudit> {
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  const requested = [...new Set(targetIds)]
  const sceneById = new Map(plan.scenes.map(scene => [scene.id, scene]))
  const invalidVisualIds = kind === 'visual'
    ? new Set(inspectScenePromptIntegrity(plan.scenes).invalid_ids)
    : null
  const completedIds: string[] = []
  const missingIds: string[] = []
  const issues: ScenePromptCompletionAudit['issues'] = []

  for (const sceneId of requested) {
    const scene = sceneById.get(sceneId)
    const complete = kind === 'motion'
      ? !!scene?.motion_prompt?.trim()
      : !!scene?.visual_prompt?.trim() && !invalidVisualIds!.has(sceneId)
    if (complete) completedIds.push(sceneId)
    else {
      missingIds.push(sceneId)
      const reason = !scene
        ? 'missing from scene plan'
        : kind === 'visual' && invalidVisualIds!.has(sceneId) && !!scene.visual_prompt?.trim()
          ? 'duplicate prompt'
          : 'missing prompt'
      issues.push({ item_id: sceneId, state: reason === 'missing prompt' ? 'missing' : 'invalid', reason })
    }
  }

  return { plan, completed_ids: completedIds, missing_ids: missingIds, issues }
}

/**
 * Persist one generated prompt by stable scene ID. The read-modify-write is
 * locked and atomic so concurrent local workers cannot overwrite each other,
 * and a later pack failure cannot erase prompts that already completed.
 */
export async function checkpointScenePrompt(
  planPath: string,
  sceneId: string,
  text: string,
  kind: ScenePromptCheckpointKind,
): Promise<ScenePromptCheckpointResult> {
  const prompt = text.trim()
  if (!prompt) throw new Error(`Cannot checkpoint an empty ${kind} prompt for ${sceneId}.`)

  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Cannot checkpoint ${kind} prompt: scene ${sceneId} is not in the current timeline.`)

    const key = kind === 'motion' ? 'motion_prompt' : 'visual_prompt'
    if (scene[key]?.trim() === prompt) return { changed: false, plan }

    scene[key] = prompt
    plan.generated_at = new Date().toISOString()
    plan.planning_stage = kind
    await writeJsonAtomic(planPath, plan, { compact: true })
    return { changed: true, plan }
  })
}
