/** GenStudio catalog identifiers are the only executable model identifiers. */

export type GenStudioModality = 'chat' | 'image' | 'voice' | 'transcription' | 'video'

const CHAT_PREFIX = 'genstudio-chat:'
const VIDEO_PREFIX = 'genstudio-video:'

export function stripGenStudioModelPrefix(modality: GenStudioModality, modelId: string): string {
  const value = modelId.trim()
  if (modality === 'chat' && value.startsWith(CHAT_PREFIX)) return value.slice(CHAT_PREFIX.length)
  if (modality === 'video' && value.startsWith(VIDEO_PREFIX)) return value.slice(VIDEO_PREFIX.length)
  return value
}

/** Reject non-GenStudio ids instead of translating an old provider selection. */
export function resolveGenStudioModelId(modality: GenStudioModality, modelId: string): string | null {
  const value = stripGenStudioModelPrefix(modality, modelId)
  return value.startsWith('genstudio-') ? value : null
}

export function unavailableLegacyModelMessage(modality: GenStudioModality, modelId: string): string {
  return `Saved ${modality} model \"${modelId}\" is retired and was not submitted. Open this generator, choose a current model from the GenStudio catalog, then save the preset again. No generation request or credit charge was made.`
}
