/**
 * Group a model catalog by provider for <select><optgroup> rendering.
 *
 * Consistent across every model picker (audio TTS, image, video, LLM) so
 * dropdowns look the same everywhere.
 *
 *   <select>
 *     <optgroup v-for="g in groups" :label="g.label">
 *       <option v-for="m in g.items" :value="m.id">...</option>
 *     </optgroup>
 *   </select>
 */

/** Friendly display names for each provider id. */
export const PROVIDER_DISPLAY: Record<string, string> = {
  // TTS
  elevenlabs: 'ElevenLabs (direct)',
  fal: 'fal.ai (ElevenLabs)',
  genaipro: 'GenAIPro (ElevenLabs)',
  // Image — currently all via kie.ai
  kie: 'kie.ai',
  // LLM
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

/**
 * Order providers visually. Anything not in this list slots to the bottom
 * in alphabetical order. Adjusting the list here re-orders every dropdown
 * in the app consistently.
 */
const DEFAULT_ORDER = [
  // TTS ordering — user-reported preference: direct first, then gateways
  'elevenlabs', 'fal', 'genaipro',
  // Image
  'kie',
  // LLM
  'anthropic', 'openai',
]

export interface ModelGroup<T> {
  provider: string
  label: string
  items: Array<{ id: string; data: T }>
}

export function groupModels<T>(
  models: Record<string, T> | null | undefined,
  getProvider: (id: string, m: T) => string,
): ModelGroup<T>[] {
  if (!models) return []
  const groups = new Map<string, Array<{ id: string; data: T }>>()
  for (const [id, m] of Object.entries(models)) {
    const p = getProvider(id, m)
    if (!groups.has(p)) groups.set(p, [])
    groups.get(p)!.push({ id, data: m })
  }
  const providers = [...groups.keys()]
  providers.sort((a, b) => {
    const ai = DEFAULT_ORDER.indexOf(a)
    const bi = DEFAULT_ORDER.indexOf(b)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })
  return providers.map(p => ({
    provider: p,
    label: PROVIDER_DISPLAY[p] || p,
    items: groups.get(p)!,
  }))
}

/**
 * Provider inference for audio models. Prefers the explicit `provider`
 * field if present (new default catalog) and falls back to prefix matching
 * for legacy model ids.
 */
export function resolveAudioProvider(id: string, m: { provider?: string }): string {
  if (m.provider) return m.provider
  if (id.startsWith('eleven_')) return 'elevenlabs'
  if (id.startsWith('genaipro-')) return 'genaipro'
  return 'fal'
}
