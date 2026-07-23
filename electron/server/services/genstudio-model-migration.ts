/**
 * Explicit legacy -> GenStudio catalog migrations.
 *
 * These are identity migrations, not fallbacks: a legacy id is translated
 * only when GenStudio publishes a stable equivalent. Callers must still
 * verify that the translated id is present and available in the live catalog.
 * Unmapped ids are preserved as historical evidence and rejected at runtime.
 */

export type GenStudioModality = 'chat' | 'image' | 'voice' | 'transcription' | 'video'

const CHAT_PREFIX = 'genstudio-chat:'

export const GENSTUDIO_LEGACY_MODEL_MAPS: Readonly<Record<GenStudioModality, Readonly<Record<string, string>>>> = {
  chat: {
    'deepseek-v4-flash': 'genstudio-chat-304c7e5dd2011f75a067-v1',
    'deepseek-v4-flash-openrouter': 'genstudio-chat-304c7e5dd2011f75a067-v1',
    'deepseek-v3-kie': 'genstudio-chat-304c7e5dd2011f75a067-v1',
    'deepseek-v4-pro': 'genstudio-chat-25627d78363a6ba40a0c-v1',
    'deepseek-r1-kie': 'genstudio-chat-25627d78363a6ba40a0c-v1',
    'claude-haiku-4-5': 'genstudio-chat-333dfe40172e84f15126-v1',
    'claude-haiku-4-5-kie': 'genstudio-chat-333dfe40172e84f15126-v1',
    'claude-opus-4-8-kie': 'genstudio-chat-8e9f5baa2e470ef8381d-v1',
    'gemini-2-5-pro-kie': 'genstudio-chat-1ecd36b84ac6fb9c80fa-v1',
    'gemini-3-flash-kie': 'genstudio-chat-b7abf15650287980589c-v1',
  },
  image: {
    'z-image': 'genstudio-image-economy-v1',
    'gpt-image-2': 'genstudio-image-studio-v1',
    'fal-gpt-image-2': 'genstudio-image-studio-v1',
    'gpt-image-2-openai': 'genstudio-image-studio-v1',
    'gpt-image-2-openrouter': 'genstudio-image-studio-v1',
    'nano-banana-2': 'genstudio-image-detail-v1',
    'nano-banana-2-lite': 'genstudio-image-swift-v1',
    'seedream-5-pro': 'genstudio-image-photo-pro-v1',
    'imagestudio:flux': 'genstudio-image-fast-v1',
    'imagestudio-flux': 'genstudio-image-fast-v1',
  },
  voice: {
    'genstudio-qwen3-standard': 'genstudio-standard-v1',
    'genstudio-tts-regular': 'genstudio-standard-v1',
    'genstudio-tts-premium': 'genstudio-clone-v1',
    'genstudio-tts-clone': 'genstudio-clone-v1',
  },
  transcription: {
    'whisper-1': 'genstudio-transcribe-v1',
    'openai-whisper-1': 'genstudio-transcribe-v1',
  },
  video: {},
}

export function stripGenStudioModelPrefix(modality: GenStudioModality, modelId: string): string {
  const value = modelId.trim()
  if (modality === 'chat' && value.startsWith(CHAT_PREFIX)) return value.slice(CHAT_PREFIX.length)
  if (modality === 'video' && value.startsWith('genstudio-video:')) return value.slice('genstudio-video:'.length)
  return value
}

export function resolveGenStudioModelId(modality: GenStudioModality, modelId: string): string | null {
  const value = stripGenStudioModelPrefix(modality, modelId)
  if (!value) return null
  if (value.startsWith('genstudio-')) return value
  return GENSTUDIO_LEGACY_MODEL_MAPS[modality][value] ?? null
}

export function legacyIdsForGenStudioModel(modality: GenStudioModality, modelId: string): string[] {
  return Object.entries(GENSTUDIO_LEGACY_MODEL_MAPS[modality])
    .filter(([, target]) => target === modelId)
    .map(([legacyId]) => legacyId)
}

export function unavailableLegacyModelMessage(modality: GenStudioModality, modelId: string): string {
  return `Saved ${modality} model "${modelId}" is not available through GenStudio. ` +
    'Choose an available GenStudio catalog model; no legacy provider fallback was attempted.'
}

/** Migrate only model-selection fields inside reusable project preset data. */
export function migrateGenStudioPresetModels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(migrateGenStudioPresetModels)
  if (!value || typeof value !== 'object') return value
  const migrated: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
    const isModelSelector = normalizedKey === 'model'
      || normalizedKey === 'model_id'
      || normalizedKey.endsWith('_model')
      || normalizedKey.endsWith('_model_id')
    if (typeof child === 'string' && isModelSelector) {
      const mapped = (Object.keys(GENSTUDIO_LEGACY_MODEL_MAPS) as GenStudioModality[])
        .map(modality => resolveGenStudioModelId(modality, child))
        .find(Boolean)
      migrated[key] = mapped || child
    } else {
      migrated[key] = migrateGenStudioPresetModels(child)
    }
  }
  return migrated
}
