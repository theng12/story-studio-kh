/** GenStudio catalog identifiers are the only executable model identifiers. */

import { isRetiredVideoModelId } from '../contracts/retired-video-models.js'

export type GenStudioModality = 'chat' | 'image' | 'voice' | 'transcription' | 'video'

const CHAT_PREFIX = 'genstudio-chat:'
const VIDEO_PREFIX = 'genstudio-video:'

export function stripGenStudioModelPrefix(modality: GenStudioModality, modelId: string): string {
  const value = modelId.trim()
  if (modality === 'chat' && value.startsWith(CHAT_PREFIX)) return value.slice(CHAT_PREFIX.length)
  if (modality === 'video' && value.startsWith(VIDEO_PREFIX)) return value.slice(VIDEO_PREFIX.length)
  return value
}

/**
 * Preserve the exact customer product id returned by GenStudio. Product
 * handles are owner-defined and are not required to start with "genstudio-".
 * Known transport prefixes remain readable for saved pre-product selections.
 */
export function resolveGenStudioModelId(modality: GenStudioModality, modelId: string): string | null {
  const value = stripGenStudioModelPrefix(modality, modelId)
  if (modality === 'video' && isRetiredVideoModelId(value)) return null
  return value && value.length <= 128 ? value : null
}

export function unavailableLegacyModelMessage(modality: GenStudioModality, modelId: string): string {
  return `Saved ${modality} product \"${modelId}\" is retired or unavailable and was not submitted. Open this generator, choose a current product from the GenStudio catalog, then save the preset again. No generation request or credit charge was made.`
}
