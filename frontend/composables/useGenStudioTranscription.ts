import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'

export interface GenStudioTranscriptionModel {
  id: string
  display_name: string
  /**
   * GenStudio's raw response currently includes the real upstream vendor
   * (e.g. "openai", "deepgram") here — unlike the image/video/chat catalog
   * routes, this one is not yet stripped server-side. Deliberately never
   * read below: every UI-facing `provider`/`group` label is the hardcoded
   * "GenStudio KH" string so a vendor identity never reaches the screen.
   */
  provider: string
  language: string
  available: boolean
  available_workers: number
  qualification_only: boolean
  unlimited_relaxed?: boolean
}

// Module-level: one shared, TTL-governed transcription catalog for every
// consumer (Subtitles, B-Roll, the account Settings diagnostics panel).
// Selection state (`modelId` below) stays per-caller because "which model
// is picked on this page" is not catalog data.
const catalogCache = createGenStudioCatalogCache<GenStudioTranscriptionModel[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioTranscriptionModel[] }>(
      '/app-settings/genstudio/transcription-models',
      { cache: 'no-store' },
    )
    return Array.isArray(response.models) ? response.models : []
  },
})

/** Shared live transcription catalog state for Subtitles and B-Roll. */
export function useGenStudioTranscriptionModels() {
  const { planNotice, badgeFor, refresh: refreshAccess } = useGenStudioAccess()
  const modelId = ref('')

  const models = catalogCache.data
  const selectedModel = computed(() =>
    models.value.find(model => model.id === modelId.value),
  )
  const ready = computed(() => selectedModel.value?.available === true)
  const options = computed(() => models.value.map((model) => {
    const unlimited = badgeFor(model.unlimited_relaxed === true)
    return {
      id: model.id,
      label: model.display_name,
      group: 'GenStudio KH',
      provider: 'GenStudio KH',
      meta: model.language,
      description: model.qualification_only
        ? 'Available for qualified accounts.'
        : 'Available for transcription.',
      disabled: !model.available,
      disabledReason: model.available ? undefined : 'This transcription model is temporarily unavailable.',
      badges: [
        ...(!model.available ? [{ label: 'unavailable', tone: 'warning' as const }] : []),
        ...(model.qualification_only
          ? [{ label: 'qualification', tone: 'info' as const }]
          : []),
        ...(unlimited ? [unlimited] : []),
      ],
    }
  }))

  async function load(): Promise<void> {
    await Promise.all([catalogCache.refresh(), refreshAccess()])
    // A remembered id is only a preference. Never leave a retired or
    // temporarily unavailable model selected just because it still exists
    // in an old preset; choose a currently usable catalog model instead.
    if (!models.value.some(model => model.id === modelId.value && model.available)) {
      modelId.value = models.value.find(model => model.available)?.id || ''
    }
  }

  const error = computed(() => {
    if (catalogCache.error.value) return catalogCache.error.value
    if (catalogCache.isExpired.value) {
      return 'The transcription model catalog is too old to trust — refresh before starting new work.'
    }
    if (catalogCache.loaded.value && !models.value.length) {
      return 'No transcription models are available right now.'
    }
    return ''
  })

  return {
    models,
    modelId,
    selectedModel,
    options,
    loading: catalogCache.loading,
    error,
    ready,
    planNotice,
    lastFetchedAt: catalogCache.lastFetchedAt,
    isStale: catalogCache.isStale,
    isExpired: catalogCache.isExpired,
    isUsable: catalogCache.isUsable,
    load,
  }
}

/**
 * The shared transcription catalog cache on its own, with no per-caller
 * selection state — used by diagnostics surfaces (GenStudio Catalog
 * Settings) that only need to show what is cached and how fresh it is,
 * without owning a `modelId`.
 */
export function useGenStudioTranscriptionCatalog() {
  return catalogCache
}
