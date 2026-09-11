import { resolveMotionScope, type MotionScope } from '../contracts/motion-scope.js'

type PromptScene = {
  id: string; start_sec: number; end_sec: number
  visual_prompt?: string; motion_prompt?: string; motion_choice?: string; motion_mode?: string
}

/** Deliberate Still choices are not required work when a new scoped request is
 * accepted. Call this only while creating the initial ID snapshot; retries use
 * their saved IDs unchanged. */
export function motionSceneIdsForNewRequest(
  scenes: readonly Pick<PromptScene, 'id' | 'motion_choice'>[],
  resolvedIds: readonly string[],
): string[] {
  const deliberateStill = new Set(scenes.filter(scene => scene.motion_choice === 'still').map(scene => scene.id))
  return resolvedIds.filter(id => !deliberateStill.has(id))
}

/** A saved batch never grows when completed scenes disappear from the pending list. */
export function motionPromptSceneIds(
  scenes: readonly PromptScene[], scope: MotionScope, savedIds?: string[], limit?: number,
): string[] {
  const ids = new Set(resolveMotionScope(scenes, savedIds === undefined
    ? scope : { mode: 'selected', scene_ids: savedIds }).scene_ids)
  const pending = scenes.filter(scene => ids.has(scene.id) && scene.visual_prompt?.trim()
    && scene.motion_choice !== 'still' && !scene.motion_prompt?.trim()).map(scene => scene.id)
  return savedIds === undefined && limit !== undefined ? pending.slice(0, Math.max(1, Math.floor(limit))) : pending
}
