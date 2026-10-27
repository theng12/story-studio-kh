import { selectLiveGenStudioModel, type LiveGenStudioModel } from './live-genstudio-model-selection.js'

interface LiveVideoModel extends LiveGenStudioModel {
  modes: readonly string[]
  variants: readonly unknown[]
}

/** Select only rows Motion Review and Scene Plan can actually submit with a priced variant. */
export function selectLiveImageToVideoModel<T extends LiveVideoModel>(
  savedModelId: unknown,
  models: readonly T[],
): (T & { available: boolean }) | null {
  const candidates = models
    .filter(model => model.modes.some(m => ['image-to-video', 'text-to-video'].includes(m)))
    .map(model => ({
      ...model,
      available: model.available && model.variants.length > 0,
    }))
  return selectLiveGenStudioModel(savedModelId, candidates)
}

export const selectLiveVideoModel = selectLiveImageToVideoModel
