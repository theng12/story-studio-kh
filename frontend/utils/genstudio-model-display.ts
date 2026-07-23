import {
  GENSTUDIO_TTS_TIER_OPTIONS,
  genStudioTtsTierForModel,
  type GenStudioTtsTier,
} from './genstudio-tts-tiers'

export type GenStudioModelKind = 'chat' | 'image' | 'video' | 'transcription'

export interface GenStudioDisplayCatalogEntry {
  id: string
  display_name: string
  legacy_ids?: string[]
}

export interface GenStudioDisplayCatalogs {
  chat?: GenStudioDisplayCatalogEntry[]
  image?: GenStudioDisplayCatalogEntry[]
  video?: GenStudioDisplayCatalogEntry[]
  transcription?: GenStudioDisplayCatalogEntry[]
}

const PREFIX_BY_KIND: Record<GenStudioModelKind, string> = {
  chat: 'genstudio-chat:',
  image: 'genstudio-image:',
  video: 'genstudio-video:',
  transcription: 'genstudio-transcription:',
}

const TTS_TIER_BY_ENGINE_ID: Record<string, GenStudioTtsTier> = {
  'genstudio-standard-v1': 'regular',
  'genstudio-clone-v1': 'cloned',
}

export function brandedGenStudioModelName(displayName: string): string {
  const name = displayName.trim()
  if (!name) return ''
  return /\[\s*GenStudio(?:\s+KH)?\s*\]$/i.test(name)
    ? name.replace(/\[\s*GenStudio(?:\s+KH)?\s*\]$/i, '[GenStudio KH]')
    : `${name} [GenStudio KH]`
}

export function buildGenStudioModelLabelEntries(
  catalogs: GenStudioDisplayCatalogs,
): Array<[string, string]> {
  const labels = new Map<string, string>()
  for (const kind of Object.keys(PREFIX_BY_KIND) as GenStudioModelKind[]) {
    const prefix = PREFIX_BY_KIND[kind]
    for (const model of catalogs[kind] || []) {
      const label = brandedGenStudioModelName(model.display_name)
      if (!model.id?.trim() || !label) continue
      const ids = [model.id, ...(model.legacy_ids || [])]
      for (const rawId of ids) {
        const id = rawId?.trim()
        if (!id) continue
        labels.set(id, label)
        labels.set(`${prefix}${id}`, label)
      }
    }
  }
  return [...labels.entries()]
}

export function genStudioTtsDisplayName(
  modelId: unknown,
  explicitTier?: unknown,
): string {
  const tier = typeof explicitTier === 'string'
    ? explicitTier.trim() as GenStudioTtsTier
    : null
  const normalizedId = typeof modelId === 'string' ? modelId.trim() : ''
  const resolvedTier = (
    GENSTUDIO_TTS_TIER_OPTIONS.some(option => option.tier === tier)
      ? tier
      : genStudioTtsTierForModel(normalizedId)
        || TTS_TIER_BY_ENGINE_ID[normalizedId]
        || 'regular'
  )
  return GENSTUDIO_TTS_TIER_OPTIONS.find(option => option.tier === resolvedTier)?.label
    || GENSTUDIO_TTS_TIER_OPTIONS[0].label
}

export function isGenStudioModelId(modelId: unknown): boolean {
  return typeof modelId === 'string' && /^genstudio(?:-|:)/i.test(modelId.trim())
}
