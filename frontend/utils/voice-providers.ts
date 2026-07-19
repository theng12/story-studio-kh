export const VOICE_PROVIDER_OPTIONS = [
  { id: 'elevenlabs', label: 'ElevenLabs' },
  { id: 'fal', label: 'fal.ai' },
  { id: 'genaipro', label: 'GenAIPro' },
  { id: 'kie', label: 'kie.ai' },
  { id: 'fishaudio', label: 'Fish Audio' },
  { id: 'genstudio', label: 'GenStudio KH' },
] as const

export type VoiceProviderId = typeof VOICE_PROVIDER_OPTIONS[number]['id']

export interface SavedVoice {
  name: string
  voice_id: string
  providers: VoiceProviderId[]
}

const PROVIDER_IDS = new Set<string>(VOICE_PROVIDER_OPTIONS.map(option => option.id))
const LEGACY_ELEVEN_GATEWAYS: VoiceProviderId[] = ['elevenlabs', 'fal', 'genaipro', 'kie']

export function normalizeVoiceProviders(value: unknown, legacyProvider?: unknown): VoiceProviderId[] {
  const explicit = Array.isArray(value)
    ? value.filter((provider): provider is VoiceProviderId => typeof provider === 'string' && PROVIDER_IDS.has(provider))
    : []
  const legacy = typeof legacyProvider === 'string' && PROVIDER_IDS.has(legacyProvider)
    ? [legacyProvider as VoiceProviderId]
    : []
  const selected = explicit.length > 0 ? explicit : legacy.length > 0 ? legacy : LEGACY_ELEVEN_GATEWAYS
  const wanted = new Set(selected)
  return VOICE_PROVIDER_OPTIONS.map(option => option.id).filter(provider => wanted.has(provider))
}

export function normalizeSavedVoice(value: unknown): SavedVoice | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const voiceId = typeof input.voice_id === 'string' ? input.voice_id.trim() : ''
  if (!name || !voiceId) return null
  return {
    name,
    voice_id: voiceId,
    providers: normalizeVoiceProviders(input.providers, input.provider),
  }
}

export function normalizeSavedVoices(value: unknown): SavedVoice[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<string, SavedVoice>()
  for (const input of value) {
    const voice = normalizeSavedVoice(input)
    if (!voice) continue
    const existing = byId.get(voice.voice_id)
    if (!existing) {
      byId.set(voice.voice_id, voice)
      continue
    }
    existing.providers = normalizeVoiceProviders([...existing.providers, ...voice.providers])
  }
  return [...byId.values()]
}

export function voiceSupportsProvider(voice: SavedVoice, provider: string): boolean {
  return voice.providers.includes(provider as VoiceProviderId)
}

export function voiceProviderLabel(provider: VoiceProviderId): string {
  return VOICE_PROVIDER_OPTIONS.find(option => option.id === provider)?.label || provider
}

export function firstVoiceProviderIndex(voice: SavedVoice): number {
  const first = voice.providers[0]
  return Math.max(0, VOICE_PROVIDER_OPTIONS.findIndex(option => option.id === first))
}
