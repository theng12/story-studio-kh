import { readonly, ref } from 'vue'
import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'
import {
  buildGenStudioModelLabelEntries,
  buildGenStudioModelProviderEntries,
  isGenStudioModelId,
  plainGenStudioModelName,
  type GenStudioDisplayCatalogEntry,
} from '../utils/genstudio-model-display.js'

const STORAGE_KEY = 'genstudio_model_display_labels_v1'
const PROVIDER_STORAGE_KEY = 'genstudio_model_display_providers_v1'
const labels = ref<Record<string, string>>({})
// §2 provider transparency. Display only — nothing dispatches from this map.
const providers = ref<Record<string, string>>({})

// The label map is cumulative and localStorage-persisted by design: once a
// model has been seen, its human-readable name stays available for old
// jobs/usage rows even after the model retires from the live catalog. What
// still needs the shared freshness policy is the underlying fetch — this
// cache tracks "how current is our view of the 4 catalogs" so `loaded`/
// `isStale`/`lastFetchedAt` behave the same way as every other GenStudio
// catalog composable, without ever going backwards on `labels` itself.
const catalogCache = createGenStudioCatalogCache<Record<string, GenStudioDisplayCatalogEntry[]>>({
  empty: {},
  fetcher: async () => {
    const { get } = useApi()
    const endpoints = [
      ['chat', '/app-settings/genstudio/chat-models'],
      ['image', '/app-settings/genstudio/image-models'],
      ['video', '/app-settings/genstudio/video-models'],
      ['transcription', '/app-settings/genstudio/transcription-models'],
      ['tts', '/app-settings/genstudio/tts-models'],
    ] as const
    const results = await Promise.allSettled(endpoints.map(async ([kind, endpoint]) => {
      const response = await get<{ models?: GenStudioDisplayCatalogEntry[] }>(endpoint)
      return [kind, Array.isArray(response.models) ? response.models : []] as const
    }))
    const catalogs: Record<string, GenStudioDisplayCatalogEntry[]> = {}
    let anyFulfilled = false
    for (const result of results) {
      if (result.status === 'fulfilled') {
        catalogs[result.value[0]] = result.value[1]
        anyFulfilled = true
      }
    }
    // Only a total failure (every catalog rejected) is a real fetch error —
    // a single endpoint being down still yields a usable partial map, same
    // as before this composable had a shared cache underneath it.
    if (!anyFulfilled && endpoints.length) throw new Error('GenStudio model catalogs are unavailable.')
    return catalogs
  },
})

/**
 * Remembered labels are healed on the way in. Releases before this one wrote
 * `Name [GenStudio KH]` into this map, and a retired model's remembered label
 * is never refreshed by a catalogue read — so without stripping here, the old
 * gateway suffix would survive forever on exactly the rows (old jobs, old usage)
 * that this map exists to name.
 */
/**
 * The store, or null where there isn't one.
 *
 * A capability check rather than `import.meta.client`. What this code needs to
 * know is whether a storage exists — and asking that question directly is both
 * more honest and testable, where a build constant is neither. Private windows,
 * cleared site data and browsers set to block site data all land here too, and
 * all get the same answer: no remembered names.
 */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readRememberedLabels(): Record<string, string> {
  const storage = store()
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    const healed: Record<string, string> = {}
    for (const [id, label] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof label !== 'string') continue
      const plain = plainGenStudioModelName(label)
      if (plain) healed[id] = plain
    }
    return healed
  } catch {
    return {}
  }
}

function rememberLabels(next: Record<string, string>): void {
  const storage = store()
  if (!storage) return
  try { storage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* best effort */ }
}

/** Same durable-map treatment as the names, so an old job row still names its provider. */
function readRememberedProviders(): Record<string, string> {
  const storage = store()
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(PROVIDER_STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    const healed: Record<string, string> = {}
    for (const [id, provider] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof provider !== 'string' || !provider.trim()) continue
      healed[id] = provider.trim()
    }
    return healed
  } catch {
    return {}
  }
}

function rememberProviders(next: Record<string, string>): void {
  const storage = store()
  if (!storage) return
  try { storage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next)) } catch { /* best effort */ }
}

/**
 * Resolves GenStudio model ids into the account catalog's published model
 * names. Speech is in the map like every other modality now: the customer picks
 * a TTS model and is charged by it, so the model's own published name is the
 * customer-facing one.
 */
export function useGenStudioModelDisplay() {
  /**
   * Load the persisted map into memory WITHOUT touching the network.
   *
   * `refresh()` merges the remembered labels on its way to a catalogue read, so
   * before this existed a caller that never fetched all five catalogues saw an
   * empty map — even though the browser had names for these very ids saved from
   * a previous launch. A picker whose own catalogue read just failed is exactly
   * that caller, and it is the one case where the remembered name is the only
   * thing standing between the customer and a raw internal product id.
   *
   * Idempotent and cheap; safe to call on every mount. Never overwrites a name
   * this session already resolved live.
   */
  function hydrate(): void {
    const remembered = readRememberedLabels()
    if (Object.keys(remembered).length) labels.value = { ...remembered, ...labels.value }
    const rememberedProviders = readRememberedProviders()
    if (Object.keys(rememberedProviders).length) providers.value = { ...rememberedProviders, ...providers.value }
  }

  /**
   * Record names from ANY successful catalogue read, not just the five-endpoint
   * one `refresh()` performs. Every picker in the app reads some slice of the
   * catalogue for itself; each of those reads is a chance to learn a name, and
   * the name it learns is what the next failed read will fall back on.
   */
  function remember(entries: Array<{ id?: unknown; label?: unknown; legacy_ids?: unknown; provider_name?: unknown }>): void {
    const next: Record<string, string> = {}
    const nextProviders: Record<string, string> = {}
    for (const entry of entries || []) {
      const label = typeof entry?.label === 'string' ? plainGenStudioModelName(entry.label) : ''
      const provider = typeof entry?.provider_name === 'string' ? entry.provider_name.trim() : ''
      if (!label && !provider) continue
      const ids = [entry?.id, ...(Array.isArray(entry?.legacy_ids) ? entry.legacy_ids : [])]
      for (const rawId of ids) {
        const id = typeof rawId === 'string' ? rawId.trim() : ''
        if (!id) continue
        if (label) next[id] = label
        if (provider) nextProviders[id] = provider
      }
    }
    if (Object.keys(next).length) {
      labels.value = { ...readRememberedLabels(), ...labels.value, ...next }
      rememberLabels(labels.value)
    }
    if (Object.keys(nextProviders).length) {
      providers.value = { ...readRememberedProviders(), ...providers.value, ...nextProviders }
      rememberProviders(providers.value)
    }
  }

  /**
   * The remembered name, or '' — NEVER the raw id.
   *
   * `displayName()` echoes the id when it has no name, which is right for a log
   * row whose whole job is to identify a record. It is wrong for a control the
   * customer reads as "the model I picked": there, an unrecognised id must
   * produce nothing, so the caller can say something true instead of presenting
   * an internal handle as a product name.
   */
  function knownName(modelId: unknown): string {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    if (!id) return ''
    return labels.value[id] || readRememberedLabels()[id] || ''
  }

  async function refresh(force = false): Promise<void> {
    const remembered = { ...readRememberedLabels(), ...labels.value }
    await catalogCache.refresh(force)
    // A total failure keeps `catalogCache.data` at its last good value (or
    // empty if nothing ever loaded) per the shared ceiling policy — either
    // way `labels` only ever grows, never regresses to raw ids that were
    // previously resolved.
    const current = Object.fromEntries(buildGenStudioModelLabelEntries(catalogCache.data.value))
    labels.value = { ...remembered, ...current }
    rememberLabels(labels.value)
    const rememberedProviders = { ...readRememberedProviders(), ...providers.value }
    const currentProviders = Object.fromEntries(buildGenStudioModelProviderEntries(catalogCache.data.value))
    providers.value = { ...rememberedProviders, ...currentProviders }
    rememberProviders(providers.value)
  }

  function displayName(modelId: unknown): string {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    if (!id) return ''
    return labels.value[id] || id
  }

  /**
   * The provider name the catalogue published for a model id, or ''.
   *
   * Display only (AGENTS.md §2): never inferred from the id or a name pattern,
   * never used to select or rank a provider, and never sent on a request.
   * Absent means the catalogue published none — the row shows nothing.
   */
  function providerName(modelId: unknown): string {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    if (!id) return ''
    return providers.value[id] || readRememberedProviders()[id] || ''
  }

  function hasReadableName(modelId: unknown): boolean {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    return !!id && (!isGenStudioModelId(id) || !!labels.value[id])
  }

  return {
    labels: readonly(labels),
    loaded: catalogCache.loaded,
    loading: catalogCache.loading,
    error: catalogCache.error,
    lastFetchedAt: catalogCache.lastFetchedAt,
    isStale: catalogCache.isStale,
    isExpired: catalogCache.isExpired,
    refresh,
    hydrate,
    remember,
    knownName,
    displayName,
    providerName,
    hasReadableName,
  }
}
