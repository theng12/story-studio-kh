/** GenStudio catalog identifiers are the only executable model identifiers. */

import { resolveRetiredImageModelId } from '../contracts/retired-image-models.js'

export type GenStudioModality = 'chat' | 'image' | 'voice' | 'transcription' | 'video'

/**
 * The one sentence a saved video model the live catalogue does not publish gets.
 *
 * There is no retired-id list any more (owner, 2026-10-26): which old model it
 * was is not something the app remembers or explains, and every path says the
 * same plain thing.
 */
export const VIDEO_MODEL_UNAVAILABLE_MESSAGE = 'This model is no longer available — choose another.'

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
  let value = stripGenStudioModelPrefix(modality, modelId)
  // The table lives in `contracts/retired-image-models.ts` so the renderer reads the
  // same one — a preset applied on the page heals the same way a queued job does.
  if (modality === 'image') value = resolveRetiredImageModelId(value) || value
  return value && value.length <= 128 ? value : null
}

export function unavailableLegacyModelMessage(modality: GenStudioModality, modelId: string): string {
  return `Saved ${modality} product \"${modelId}\" is retired or unavailable and was not submitted. Open this generator, choose a current product from the Gateway catalog, then save the preset again. No generation request or credit charge was made.`
}

/**
 * The sentence for a saved transcription model the live catalogue no longer lists.
 *
 * Whisper base and small were shelved: the fleet offers only Whisper turbo. A preset that still
 * names one fails — by decision the owner re-saves it himself, and nothing is swapped silently —
 * but the failure has to say what to do rather than "no longer available".
 */
export function unavailableTranscriptionModelMessage(modelId: string): string {
  if (/whisper[-_ ]?(base|small)/i.test(modelId)) {
    return 'Whisper base/small are no longer offered — choose Whisper turbo in this preset. '
      + 'No request or credit charge was made.'
  }
  return 'The selected transcription model is no longer available. Choose a current model in this preset. '
    + 'No request or credit charge was made.'
}
