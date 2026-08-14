import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'
import { genStudioModelLockReason, selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.js'
import type { GenStudioCostTier } from '../utils/genstudio-cost-tier.js'

export interface GenStudioTranscriptionModel {
  id: string
  display_name: string
  /**
   * The vendor GenStudio publishes for this model (e.g. "openai", "deepgram").
   * Shown, per AGENTS.md → "Provider Transparency" (2026-08-01): a published
   * provider is customer-facing. The picker used to overwrite it with the
   * hardcoded gateway name, which told the customer nothing they could not read
   * from the panel above the field. Empty means GenStudio published none — the
   * row then names no provider rather than falling back to the gateway.
   */
  provider: string
  /** Raw `TranscriptionModelResponse.language`. EMPTY when GenStudio published
   *  nothing — never defaulted to a code or to a sentinel. */
  language: string
  /** Published language codes, empty when GenStudio has not published a list.
   *  Optional so an older backend response still types. See
   *  utils/transcription-language.ts for how the three states are rendered. */
  supported_languages?: string[]
  /** Null when GenStudio has not said whether omitting `language` detects it. */
  supports_language_auto_detect?: boolean | null
  available: boolean
  available_workers: number
  qualification_only: boolean
  /** Published per-SECOND rate. Optional because an older backend build did
   *  not send it; 0 or absent both mean "GenStudio published no rate", which
   *  is rendered as unpublished — never as free. */
  credits_per_second?: number
  /** Floor charged on a priced request, shown alongside the rate so a short
   *  clip's real cost is not misread as rate x seconds. */
  minimum_credits?: number
  price_version?: string
  legacy_ids?: string[]
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string
}

/**
 * GenStudio's published transcription rate, in words.
 *
 * Transcription is priced PER SECOND with a minimum, so both figures are shown
 * together — a rate alone would understate a short clip, which is charged the
 * floor rather than rate x seconds. A model that publishes no rate says so:
 * this app never renders an unpublished price as free, and never multiplies
 * the rate into a total (the quote at submission is the only real figure).
 */
export function describeTranscriptionRate(model: {
  credits_per_second?: number
  minimum_credits?: number
}): string {
  const rate = typeof model.credits_per_second === 'number' && Number.isFinite(model.credits_per_second)
    ? model.credits_per_second
    : null
  if (rate === null) return 'rate not published'
  const floor = typeof model.minimum_credits === 'number' && Number.isFinite(model.minimum_credits)
    && model.minimum_credits > 0
    ? model.minimum_credits
    : null
  const rateText = `${rate} credits/second`
  return floor === null ? rateText : `${rateText}, minimum ${floor}`
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
  const modelId = ref('')

  const models = catalogCache.data
  const selectedModel = computed(() =>
    models.value.find(model => model.id === modelId.value),
  )
  const ready = computed(() => selectedModel.value?.available === true && selectedModel.value?.locked !== true)
  const options = computed(() => models.value.map((model) => {
    return {
      id: model.id,
      label: model.display_name,
      // Grouped and summarised by the PUBLISHED provider. A model GenStudio
      // publishes no provider for falls into a neutral bucket and shows no
      // provider — it is never attributed to a vendor by its id or its name.
      group: model.provider || 'Transcription models',
      provider: model.provider || '',
      // Honest about a gap: an unpublished language is missing data, not
      // "multilingual" and not a blank that reads as a value.
      // Same for the rate: no published rate reads as "not published", never
      // as free. A model priced at 0 credits genuinely is free and says so.
      meta: [model.language || 'language not published', describeTranscriptionRate(model)].join(' · '),
      description: model.qualification_only
        ? 'Available for qualified accounts.'
        : 'Available for transcription.',
      disabled: !model.available || model.locked === true,
      disabledReason: genStudioModelLockReason(model) || (model.available ? undefined : 'This transcription model is temporarily unavailable.'),
      badges: [
        ...(!model.available ? [{ label: 'unavailable', tone: 'warning' as const }] : []),
        ...(model.qualification_only
          ? [{ label: 'qualification', tone: 'info' as const }]
          : []),
      ],
      costTier: model.cost_tier,
    }
  }))

  async function load(): Promise<void> {
    await catalogCache.refresh()
    const selected = selectLiveGenStudioModel(modelId.value, models.value)
    if (selected && selected.id !== modelId.value) modelId.value = selected.id
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
