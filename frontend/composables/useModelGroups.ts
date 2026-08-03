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

/**
 * Display names for the identities Story Studio is allowed to NAME on screen.
 *
 * This map is an allowlist, not a lookup table. It holds exactly two kinds of
 * identity:
 *
 *   1. `genstudio` — the gateway every cloud generation travels over. Naming
 *      it is the whole of Story Studio's routing story.
 *   2. Story Studio's own LOCAL features — Voice Studio KH, Image Studio KH,
 *      Chat Studio, macOS `say`. These run on the customer's own machine, so
 *      naming them describes their hardware, not an upstream.
 *
 * Everything else that used to live here — the upstream aggregator and the
 * direct-vendor keys Story Studio carried before the GenStudio-only migration
 * (v1.0.669) — is PRIVATE ROUTING IDENTITY. GenStudio owns provider selection
 * and deliberately does not disclose who it routes to, so those ids must never
 * reach a screen. They are gone from this map on purpose: an id that is not
 * here has no display name, and `publicProviderLabel` returns '' for it rather
 * than falling through to the raw id.
 *
 * A provider GenStudio DOES publish (a voice's `provider`/`engine_name`, a TTS
 * model's `provider_name`) is shown from the catalogue payload itself and never
 * goes through this map — see AGENTS.md → Provider Transparency.
 */
export const PROVIDER_DISPLAY: Record<string, string> = {
  genstudio: 'GenStudio KH',
  // v1.0.149+ — Voice Studio KH local modal (Pinokio FastAPI wrapper,
  // reached over Tailscale). v1.0.150 dropped the standalone Chatterbox
  // entry (chatterbox-mlx is reachable through Voice Studio's family list).
  voicestudio: 'Voice Studio KH (local)',
  // v1.0.329+ — macOS built-in `say` voices (local, free; preview-oriented).
  macos: 'macOS say (built-in · free)',
  // v1.0.151+ — local Pinokio image modal (FLUX / Qwen / Z-Image on MLX).
  imagestudio: 'Image Studio KH (local)',
  // Chat Studio (local Apple-Silicon MLX OpenAI-compatible LLM, self-healing).
  chatstudio: 'Chat Studio (local)',
  // v1.0.497 — Chat Studio also proxies cloud LLM providers. Separate group so
  // local vs cloud is obvious; the label stays neutral and names no vendor.
  'chatstudio-cloud': 'Chat Studio (cloud)',
  // Neutral bucket for an id that could not be attributed to any nameable
  // identity. Display-only — never guess a specific vendor here.
  unknown: 'Other',
}

/**
 * The display name for a provider id, or '' when there is nothing Story Studio
 * may say about it.
 *
 * The empty string is the point. A record written before the GenStudio-only
 * migration can still carry a private routing identity on disk, and the old
 * `PROVIDER_DISPLAY[id] || id` fallback printed those ids raw the moment they
 * were missing from the map. Callers must treat '' as "show no provider" —
 * never as a cue to fall back to the id, and never as a cue to invent one.
 */
export function publicProviderLabel(providerId: string | null | undefined): string {
  if (!providerId) return ''
  return PROVIDER_DISPLAY[providerId] || ''
}

/**
 * Order providers visually. Anything not in this list slots to the bottom
 * in alphabetical order. Adjusting the list here re-orders every dropdown
 * in the app consistently.
 */
const DEFAULT_ORDER = [
  // The gateway first, then the local-only options at the bottom (advanced;
  // they need a running local server, or in Voice Studio's case Tailscale).
  'genstudio', 'voicestudio', 'imagestudio', 'chatstudio', 'chatstudio-cloud', 'macos',
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
    // A group whose provider Story Studio may not name gets a neutral heading.
    // Echoing the raw id here is how an aggregator's name used to reach the
    // picker, so the fallback is a generic word rather than the id.
    label: publicProviderLabel(p) || 'Models',
    items: groups.get(p)!,
  }))
}

/**
 * The provider bucket for an audio model: the explicit `provider` the
 * catalogue published, or the neutral `unknown` bucket.
 *
 * There is deliberately no second guess. This used to sniff the model id —
 * `eleven_*` → elevenlabs, `genaipro-*` → genaipro, everything unrecognized
 * → fal — which is the exact move AGENTS.md forbids: a provider inferred from
 * a name pattern is a claim Story Studio is not entitled to make, and the ids
 * it produced were upstream routing identities that then rendered as vendor
 * names in the picker. An unpublished provider is unknown, never reconstructed.
 */
export function resolveAudioProvider(_id: string, m: { provider?: string }): string {
  return m.provider || 'unknown'
}
