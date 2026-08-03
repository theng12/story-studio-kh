import { readonly, ref } from 'vue'
import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'
import {
  buildGenStudioModelLabelEntries,
  isGenStudioModelId,
  plainGenStudioModelName,
  type GenStudioDisplayCatalogEntry,
} from '../utils/genstudio-model-display.js'

const STORAGE_KEY = 'genstudio_model_display_labels_v1'
const labels = ref<Record<string, string>>({})

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
function readRememberedLabels(): Record<string, string> {
  if (!import.meta.client) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
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
  if (!import.meta.client) return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* best effort */ }
}

/**
 * Resolves GenStudio model ids into the account catalog's published model
 * names. Speech is in the map like every other modality now: the customer picks
 * a TTS model and is charged by it, so the model's own published name is the
 * customer-facing one.
 */
export function useGenStudioModelDisplay() {
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
  }

  function displayName(modelId: unknown): string {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    if (!id) return ''
    return labels.value[id] || id
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
    displayName,
    hasReadableName,
  }
}
