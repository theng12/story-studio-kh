export type MotionShareFormula = 'opening_hook' | 'key_moments' | 'spread' | 'chronological'

/** Default motion scope: 25% video share with opening-hook formula (owner decision, 2026-10-26). */
export const DEFAULT_MOTION_SCOPE: MotionScope = { mode: 'share', share_percent: 25, formula: 'opening_hook' }

/** Episode editorial scope, independent of model capabilities and clip readiness. */
export type MotionScope =
  | { mode: 'off' }
  | { mode: 'opening'; end_sec: number }
  | { mode: 'selected'; scene_ids: string[] }
  | { mode: 'all' }
  | { mode: 'share'; share_percent: number; formula?: MotionShareFormula }

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
  if (scope.mode === 'share') {
    const rawPercent = typeof scope.share_percent === 'number' ? scope.share_percent : 25
    const share_percent = Math.min(100, Math.max(10, Math.round(rawPercent)))
    const allowedFormulas: MotionShareFormula[] = ['opening_hook', 'key_moments', 'spread', 'chronological']
    const formula: MotionShareFormula = allowedFormulas.includes(scope.formula as MotionShareFormula)
      ? (scope.formula as MotionShareFormula)
      : 'opening_hook'
    return { mode: 'share', share_percent, formula }
  }
  throw new Error('Motion scope needs a positive opening time, valid selected scene IDs, or a running time share.')
}

/** Times must be on the narration timeline, without added opening/title clips. */
export function resolveMotionScope(
  scenes: readonly {
    id: string; start_sec: number; end_sec: number
    /** The customer's own mark. */
    key_moment?: boolean
    /** The planner's suggestion, used only where the customer has not decided. */
    key_moment_suggested?: boolean
  }[],
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
  if (scope.mode === 'share') {
    if (!scenes.length) return { scene_ids: [], crossing_scene_ids: [] }
    const totalDuration = scenes.reduce((sum, s) => sum + (s.end_sec - s.start_sec), 0)
    const targetSeconds = (totalDuration * scope.share_percent) / 100
    const formula = scope.formula || 'opening_hook'

    if (formula === 'key_moments') {
      const picked = new Set<string>()
      let accumulated = 0
      // A scene is a key moment when the customer marked it, else when the planner suggested it.
      // The customer's own mark always wins — a suggestion is never presented as their choice.
      const isKeyMoment = (scene: (typeof scenes)[number]) =>
        scene.key_moment ?? scene.key_moment_suggested ?? false
      // Pass 1: key moments
      for (const scene of scenes) {
        if (isKeyMoment(scene) && accumulated < targetSeconds) {
          picked.add(scene.id)
          accumulated += (scene.end_sec - scene.start_sec)
        }
      }
      // Pass 2: fill remaining budget from start
      if (accumulated < targetSeconds) {
        for (const scene of scenes) {
          if (!picked.has(scene.id) && accumulated < targetSeconds) {
            picked.add(scene.id)
            accumulated += (scene.end_sec - scene.start_sec)
          }
        }
      }
      return {
        scene_ids: scenes.filter(s => picked.has(s.id)).map(s => s.id),
        crossing_scene_ids: [],
      }
    }

    if (formula === 'spread') {
      const picked = new Set<string>()
      const avgDuration = totalDuration / scenes.length
      const countNeeded = Math.max(1, Math.min(scenes.length, Math.round(targetSeconds / avgDuration)))
      const step = scenes.length / countNeeded
      for (let i = 0; i < countNeeded; i++) {
        const idx = Math.min(scenes.length - 1, Math.floor(i * step))
        picked.add(scenes[idx]!.id)
      }
      return {
        scene_ids: scenes.filter(s => picked.has(s.id)).map(s => s.id),
        crossing_scene_ids: [],
      }
    }

    // Default & 'opening_hook' / 'chronological': fill from start
    let accumulated = 0
    const selectedIds: string[] = []
    const crossingIds: string[] = []
    for (const scene of scenes) {
      const dur = scene.end_sec - scene.start_sec
      if (accumulated >= targetSeconds && selectedIds.length > 0) break
      if (accumulated + dur <= targetSeconds || selectedIds.length === 0) {
        selectedIds.push(scene.id)
        accumulated += dur
      } else {
        crossingIds.push(scene.id)
        accumulated += dur
        break
      }
    }
    return { scene_ids: selectedIds, crossing_scene_ids: crossingIds }
  }
  return {
    scene_ids: scenes.filter(scene => scene.end_sec <= scope.end_sec).map(scene => scene.id),
    crossing_scene_ids: scenes.filter(scene => scene.start_sec < scope.end_sec && scene.end_sec > scope.end_sec).map(scene => scene.id),
  }
}
