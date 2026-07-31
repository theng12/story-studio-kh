export type GenStudioTtsTier = 'regular' | 'premium' | 'cloned'

export interface GenStudioTtsTierOption {
  id: string
  tier: GenStudioTtsTier
  label: string
  description: string
}

export const GENSTUDIO_TTS_TIER_OPTIONS: readonly GenStudioTtsTierOption[] = [
  {
    id: 'genstudio-tts-regular',
    tier: 'regular',
    label: 'GenStudio TTS Regular',
    description: 'Regular voices from your GenStudio catalog.',
  },
  {
    id: 'genstudio-tts-premium',
    tier: 'premium',
    label: 'GenStudio TTS Premium',
    description: 'Curated premium voices from your GenStudio catalog.',
  },
  {
    id: 'genstudio-tts-clone',
    tier: 'cloned',
    label: 'GenStudio TTS Clone',
    description: 'Private voices cloned for your GenStudio account.',
  },
] as const

const TIER_BY_MODEL_ID = new Map<string, GenStudioTtsTier>(
  GENSTUDIO_TTS_TIER_OPTIONS.map(option => [option.id, option.tier]),
)

export function genStudioTtsTierForModel(modelId: unknown): GenStudioTtsTier | null {
  if (typeof modelId !== 'string') return null
  return TIER_BY_MODEL_ID.get(modelId.trim()) || null
}

export function genStudioTtsModelForTier(tier: unknown): string {
  return GENSTUDIO_TTS_TIER_OPTIONS.find(option => option.tier === tier)?.id
    || GENSTUDIO_TTS_TIER_OPTIONS[0].id
}

/**
 * Old Story releases remembered an engine or provider model. Keep the user's
 * voice selection, but heal the visible product choice to one of GenStudio's
 * three customer tiers. Once the live voice catalog loads, its authoritative
 * voice_tier selects the exact tier.
 */
export function normalizeStoryTtsTierModel(modelId: unknown): string {
  if (typeof modelId !== 'string') return GENSTUDIO_TTS_TIER_OPTIONS[0].id
  const value = modelId.trim()
  if (TIER_BY_MODEL_ID.has(value)) return value
  // model-drift-allow: retired engine id recognised only to heal an old saved
  // selection onto a current tier. Recognising it is not offering it.
  if (value === 'genstudio-clone-v1') return genStudioTtsModelForTier('cloned')
  if (/fish|clone|qwen|chatterbox|voxcpm|eleven|genaipro|kie/i.test(value)) {
    return genStudioTtsModelForTier('premium')
  }
  return genStudioTtsModelForTier('regular')
}
