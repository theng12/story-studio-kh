/** Episode editorial scope, independent of model capabilities and clip readiness. */
export type MotionScope =
  | { mode: 'off' }
  | { mode: 'opening'; end_sec: number }
  | { mode: 'selected'; scene_ids: string[] }
  | { mode: 'all' }

export function normalizeMotionScope(value: unknown): MotionScope {
  if (value == null) return { mode: 'off' }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a valid motion scope.')
  const scope = value as Record<string, unknown>
  if (scope.mode === 'off' || scope.mode === 'all') return { mode: scope.mode }
  if (scope.mode === 'opening' && typeof scope.end_sec === 'number'
    && Number.isFinite(scope.end_sec) && scope.end_sec > 0) {
    return { mode: 'opening', end_sec: scope.end_sec }
  }
  if (scope.mode === 'selected' && Array.isArray(scope.scene_ids)
    && scope.scene_ids.every(id => typeof id === 'string' && id.trim().length > 0)) {
    return { mode: 'selected', scene_ids: [...new Set(scope.scene_ids as string[])] }
  }
  throw new Error('Motion scope needs a positive opening time or valid selected scene IDs.')
}

/** Times must be on the narration timeline, without added opening/title clips. */
export function resolveMotionScope(
  scenes: readonly { id: string; start_sec: number; end_sec: number }[],
  value: unknown,
): { scene_ids: string[]; crossing_scene_ids: string[] } {
  const scope = normalizeMotionScope(value)
  if (scope.mode === 'off') return { scene_ids: [], crossing_scene_ids: [] }
  const ids = new Set<string>()
  for (const scene of scenes) {
    if (!scene.id || ids.has(scene.id)) throw new Error('Motion scope cannot use missing or duplicate scene IDs. Review the Scene Plan.')
    if (!Number.isFinite(scene.start_sec) || !Number.isFinite(scene.end_sec)
      || scene.start_sec < 0 || scene.end_sec <= scene.start_sec) {
      throw new Error(`Scene ${scene.id} has invalid timing. Review the Scene Plan before generating motion.`)
    }
    ids.add(scene.id)
  }
  if (scope.mode === 'selected') {
    const missing = scope.scene_ids.filter(id => !ids.has(id))
    if (missing.length) throw new Error(`Selected motion scenes no longer exist: ${missing.join(', ')}. Choose the scenes again.`)
    const selected = new Set(scope.scene_ids)
    return { scene_ids: scenes.filter(scene => selected.has(scene.id)).map(scene => scene.id), crossing_scene_ids: [] }
  }
  if (scope.mode === 'all') return { scene_ids: scenes.map(scene => scene.id), crossing_scene_ids: [] }
  return {
    scene_ids: scenes.filter(scene => scene.end_sec <= scope.end_sec).map(scene => scene.id),
    crossing_scene_ids: scenes.filter(scene => scene.start_sec < scope.end_sec && scene.end_sec > scope.end_sec).map(scene => scene.id),
  }
}
