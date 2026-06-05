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
  // v1.0.149+ — Voice Studio KH local modal (Pinokio FastAPI wrapper,
  // reached over Tailscale). v1.0.150 dropped the standalone Chatterbox
  // entry (chatterbox-mlx is reachable through Voice Studio's family list).
  voicestudio: 'Voice Studio KH (local)',
  // Image — kie.ai for cloud + Image Studio KH (v1.0.151+) for the
  // local Pinokio modal (FLUX / Qwen / Z-Image on Apple Silicon MLX).
  kie: 'kie.ai',
  imagestudio: 'Image Studio KH (local)',
  // LLM
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  // v1.0.280+ — LM Studio (local OpenAI-compatible LLM on the user's machine).
  lmstudio: 'LM Studio (local)',
}

/**
 * Order providers visually. Anything not in this list slots to the bottom
 * in alphabetical order. Adjusting the list here re-orders every dropdown
 * in the app consistently.
 */
const DEFAULT_ORDER = [
  // TTS ordering — user-reported preference: direct first, then gateways,
  // then local-modal options at the bottom (advanced; require Tailscale +
  // a running Pinokio modal).
  'elevenlabs', 'fal', 'genaipro', 'voicestudio',
  // Image — kie.ai cloud first, then local Pinokio modal at the bottom.
  'kie', 'imagestudio',
  // LLM — DeepSeek first (cheapest, the project default), then OpenRouter,
  // then OpenAI, then the local LM Studio group at the bottom (advanced;
  // requires a running local server). (kie.ai's Claude/GPT/Gemini group sorts
  // under 'kie' above.)
  'deepseek', 'openrouter', 'openai', 'lmstudio',
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
  // v1.0.149+ — Voice Studio KH (Pinokio local modal).
  // v1.0.150 dropped the standalone chatterbox-* prefix (rolled into
  // Voice Studio's family list).
  if (id.startsWith('voicestudio-')) return 'voicestudio'
  return 'fal'
}
