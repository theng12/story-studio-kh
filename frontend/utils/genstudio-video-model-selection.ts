export { isRetiredVideoModelId } from '../../electron/server/contracts/retired-video-models'
import { selectLiveGenStudioModel, type LiveGenStudioModel } from './live-genstudio-model-selection.js'

interface LiveImageToVideoModel extends LiveGenStudioModel {
  modes: readonly string[]
  variants: readonly unknown[]
}

/** Select only rows Motion Review can actually submit with a priced variant. */
export function selectLiveImageToVideoModel<T extends LiveImageToVideoModel>(
  savedModelId: unknown,
  models: readonly T[],
): (T & { available: boolean }) | null {
  const candidates = models
    .filter(model => model.modes.includes('image-to-video'))
    .map(model => ({
      ...model,
      available: model.available && model.variants.length > 0,
    }))
  return selectLiveGenStudioModel(savedModelId, candidates)
}
