/**
 * Resolve a saved text-model preference against GenStudio's live catalog.
 *
 * A saved id is a preference, never authority. In particular, historic direct
 * provider ids such as `gpt-4o` must not leave a generator stuck after Story
 * Studio moved all text execution behind GenStudio.
 */
export interface LiveGenStudioModel {
  id: string
  available: boolean
  disabled_reason?: string | null
  supports_vision?: boolean
  legacy_ids?: readonly string[]
}

export function isUsableLiveGenStudioModel(
  model: LiveGenStudioModel,
  requireVision = false,
): boolean {
  return model.available
    && !model.disabled_reason
    && (!requireVision || model.supports_vision === true)
}

/**
 * Keep a valid explicit choice. A saved retired or unavailable product must
 * stay visible for the user to replace; silently switching named products can
 * change quality and price. Only an empty preference may take the first usable
 * live entry. Explicit owner-published aliases remain safe migrations.
 */
export function selectLiveGenStudioModel<T extends LiveGenStudioModel>(
  savedModelId: unknown,
  models: readonly T[],
  requireVision = false,
): T | null {
  const saved = typeof savedModelId === 'string' ? savedModelId.trim() : ''
  const usable = (model: T): boolean => isUsableLiveGenStudioModel(model, requireVision)

  const exact = models.find(model => model.id === saved)
  if (exact && usable(exact)) return exact

  const migrated = saved
    ? models.find(model => usable(model) && model.legacy_ids?.includes(saved))
    : undefined
  if (migrated) return migrated

  return saved ? null : models.find(usable) || null
}
