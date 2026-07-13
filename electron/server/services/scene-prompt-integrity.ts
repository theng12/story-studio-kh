import type { ScenePlanEntry } from '../models/types.js'

export interface ScenePromptDuplicateGroup {
  prompt: string
  scene_ids: string[]
}

export interface ScenePromptIntegrity {
  complete: boolean
  empty_ids: string[]
  duplicate_ids: string[]
  duplicate_groups: ScenePromptDuplicateGroup[]
  invalid_ids: string[]
}

export function normalizeScenePrompt(prompt: unknown): string {
  return typeof prompt === 'string'
    ? prompt.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    : ''
}

/**
 * A repeated full prompt is not valid scene work. The first occurrence remains
 * valid; later copies return to the pending pool so they can be regenerated.
 */
export function inspectScenePromptIntegrity(
  scenes: Array<Pick<ScenePlanEntry, 'id' | 'visual_prompt'>>,
): ScenePromptIntegrity {
  const emptyIds: string[] = []
  const duplicateIds: string[] = []
  const grouped = new Map<string, { prompt: string; ids: string[] }>()

  for (const scene of scenes) {
    const normalized = normalizeScenePrompt(scene.visual_prompt)
    if (!normalized) {
      emptyIds.push(scene.id)
      continue
    }
    const existing = grouped.get(normalized)
    if (existing) {
      existing.ids.push(scene.id)
      duplicateIds.push(scene.id)
    } else {
      grouped.set(normalized, { prompt: scene.visual_prompt.trim(), ids: [scene.id] })
    }
  }

  const duplicateGroups = Array.from(grouped.values())
    .filter(group => group.ids.length > 1)
    .map(group => ({ prompt: group.prompt, scene_ids: group.ids }))
  const invalidIds = [...emptyIds, ...duplicateIds]
  return {
    complete: invalidIds.length === 0,
    empty_ids: emptyIds,
    duplicate_ids: duplicateIds,
    duplicate_groups: duplicateGroups,
    invalid_ids: invalidIds,
  }
}

export function assertScenePromptsRenderable(
  scenes: Array<Pick<ScenePlanEntry, 'id' | 'visual_prompt'>>,
  targetIds?: Iterable<string>,
): void {
  const integrity = inspectScenePromptIntegrity(scenes)
  const targets = targetIds ? new Set(targetIds) : null
  const emptyCount = integrity.empty_ids.filter(id => !targets || targets.has(id)).length
  const duplicateCount = integrity.duplicate_ids.filter(id => !targets || targets.has(id)).length
  if (!emptyCount && !duplicateCount) return

  const parts: string[] = []
  if (emptyCount) parts.push(`${emptyCount} missing`)
  if (duplicateCount) parts.push(`${duplicateCount} duplicated`)
  throw new Error(
    `Scene prompts are incomplete (${parts.join(', ')}). `
    + 'Open Scene Plan and run All pending before generating images.',
  )
}

/** Old one-pass planner labels survived after proper prompts were generated. */
export function clearLegacyPlannerFallbackReasons(
  scenes: Array<Pick<ScenePlanEntry, 'boundary_reason'>>,
): number {
  let changed = 0
  for (const scene of scenes) {
    if (scene.boundary_reason && /^auto-(?:filled|split)/i.test(scene.boundary_reason)) {
      delete scene.boundary_reason
      changed++
    }
  }
  return changed
}
