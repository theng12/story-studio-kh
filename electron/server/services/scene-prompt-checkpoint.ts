import fs from 'fs/promises'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { ScenePlan } from '../models/types.js'

export type ScenePromptCheckpointKind = 'visual' | 'motion'

export interface ScenePromptCheckpointResult {
  changed: boolean
  plan: ScenePlan
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
    await writeJsonAtomic(planPath, plan)
    return { changed: true, plan }
  })
}
