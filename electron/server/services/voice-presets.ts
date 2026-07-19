export const VOICE_PROVIDER_IDS = ['elevenlabs', 'fal', 'genaipro', 'kie', 'fishaudio', 'genstudio'] as const
export type VoiceProviderId = typeof VOICE_PROVIDER_IDS[number]

export interface NormalizedVoicePreset {
  name: string
  voice_id: string
  providers: VoiceProviderId[]
}

const VOICE_PROVIDER_SET = new Set<string>(VOICE_PROVIDER_IDS)
const LEGACY_ELEVENLABS_GATEWAYS: VoiceProviderId[] = ['elevenlabs', 'fal', 'genaipro', 'kie']

export function normalizeVoicePreset(input: unknown): NormalizedVoicePreset | null {
  if (!input || typeof input !== 'object') return null
  const row = input as Record<string, unknown>
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  const voiceId = typeof row.voice_id === 'string' ? row.voice_id.trim() : ''
  if (!name || !voiceId) return null

  const explicit = Array.isArray(row.providers)
    ? row.providers.filter((provider): provider is VoiceProviderId => (
      typeof provider === 'string' && VOICE_PROVIDER_SET.has(provider)
    ))
    : []
  const legacyProvider = typeof row.provider === 'string' && VOICE_PROVIDER_SET.has(row.provider)
    ? row.provider as VoiceProviderId
    : null
  const providers = explicit.length > 0
    ? explicit
    : legacyProvider
      ? [legacyProvider]
      : LEGACY_ELEVENLABS_GATEWAYS

  return {
    name,
    voice_id: voiceId,
    providers: VOICE_PROVIDER_IDS.filter(provider => providers.includes(provider)),
  }
}

export function normalizeVoicePresets(inputs: unknown): NormalizedVoicePreset[] {
  if (!Array.isArray(inputs)) return []
  const byId = new Map<string, NormalizedVoicePreset>()
  for (const input of inputs) {
    const normalized = normalizeVoicePreset(input)
    if (!normalized) continue
    const existing = byId.get(normalized.voice_id)
    if (!existing) {
      byId.set(normalized.voice_id, normalized)
      continue
    }
    const merged = new Set([...existing.providers, ...normalized.providers])
    existing.providers = VOICE_PROVIDER_IDS.filter(provider => merged.has(provider))
  }
  return [...byId.values()]
}

export function voiceSupportsProvider(
  inputs: unknown,
  voiceId: unknown,
  provider: unknown,
): boolean {
  if (typeof voiceId !== 'string' || typeof provider !== 'string') return false
  return normalizeVoicePresets(inputs).some(voice =>
    voice.voice_id === voiceId.trim() && voice.providers.includes(provider as VoiceProviderId))
}
