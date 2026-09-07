import { computed, ref } from 'vue'
import { useApi } from './useApi.js'
import {
  createGenStudioCatalogCache,
  GENSTUDIO_CATALOG_STALE_CEILING_MS,
} from './useGenStudioCatalogCache.js'
import type { GenStudioCostTier } from '../utils/genstudio-cost-tier.js'
import { findGenStudioProduct } from '../../electron/server/contracts/genstudio-product-identity'
import { normalizeGenStudioLoadedAt } from '../utils/genstudio-freshness.js'

/** One published `(resolution, aspect_ratio)` pair from the image catalog. */
export interface GenStudioImageOutputOption {
  resolution: string
  aspect_ratio: string
  width: number
  height: number
  is_default: boolean
  /** Price of THIS combination. Absent = GenStudio published none for the row. */
  credits_per_image?: number
  /** Undiscounted price of this combination, when a promotion is running. */
  base_credits_per_image?: number
  price_version?: string
  /** Published full effective rate when this combination is rendered from references. */
  reference_generation_credits?: number
  reference_generation_price_version?: string
}

/**
 * The customer-facing view of one live GenStudio image model.
 *
 * Optional here means GenStudio published nothing for that model — render "—"
 * or omit the control rather than filling in a plausible value.
 */
export interface GenStudioImageModelInfo {
  id: string
  display_name: string
  provider_name?: string
  description?: string
  available: boolean
  availability_note?: string
  chargeable?: boolean
  qualification_only: boolean
  credits_per_image?: number | null
  base_credits_per_image?: number | null
  promotion_name?: string
  promotion_discount_percent?: number
  /** Published full effective rate for a reference-guided render. Absent = not published. */
  reference_generation_credits?: number
  aspect_ratios: string[]
  default_aspect_ratio: string
  default_resolution?: string
  output_options?: GenStudioImageOutputOption[]
  supports_reference_images: boolean
  supports_image_to_image?: boolean
  supports_seed?: boolean
  min_reference_images?: number
  max_reference_images: number
  reference_image_max_dimension?: number
  reference_strength_mode: string
  supported_reference_strengths: string[]
  max_prompt_characters?: number
  prompt_token_allowance?: number
  operations?: string[]
  /** Owner-defined public handle, e.g. `gpt-image-2`. GenStudio republishes
   *  image and video products under this name; a preset saved earlier holds
   *  the raw id, so both name the same product. */
  customer_handle?: string | null
  public_model_id?: string | null
  legacy_ids?: string[]
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string
}

interface BackendCatalogFreshness {
  stale: boolean
  ageMs: number
  loadedAt: number | null
}
interface BackendCatalogFreshnessResponse extends Omit<BackendCatalogFreshness, 'loadedAt'> {
  loadedAt: string | number | null
}

const backendFreshness = ref<BackendCatalogFreshness | null>(null)
const cache = createGenStudioCatalogCache<GenStudioImageModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{
      models?: GenStudioImageModelInfo[]
      freshness?: BackendCatalogFreshnessResponse
    }>('/app-settings/genstudio/image-models', { cache: 'no-store' })
    backendFreshness.value = response.freshness
      ? { ...response.freshness, loadedAt: normalizeGenStudioLoadedAt(response.freshness.loadedAt) }
      : null
    return Array.isArray(response.models) ? response.models : []
  },
})

/**
 * One app-wide live catalog cache shared by every image picker/workspace.
 * See `useGenStudioCatalogCache.ts` for the freshness/staleness policy —
 * `models` stays populated with the last good snapshot while stale, and is
 * only cleared once it is past the hard ceiling with no successful refresh.
 */
export function useGenStudioImageModels() {
  const sourceIsStale = computed(() => backendFreshness.value?.stale === true)
  const sourceIsExpired = computed(() => sourceIsStale.value
    && (backendFreshness.value?.ageMs || 0) > GENSTUDIO_CATALOG_STALE_CEILING_MS)
  const isStale = computed(() => sourceIsStale.value || cache.isStale.value)
  const isExpired = computed(() => sourceIsExpired.value || cache.isExpired.value)
  const isUsable = computed(() => !cache.loading.value
    && cache.isUsable.value && !isStale.value && !isExpired.value)
  const lastFetchedAt = computed(() => backendFreshness.value?.loadedAt ?? cache.lastFetchedAt.value)

  function find(modelId: string): GenStudioImageModelInfo | undefined {
    return findGenStudioProduct(cache.data.value, modelId)
  }

  return {
    models: cache.data,
    loading: cache.loading,
    loaded: cache.loaded,
    error: cache.error,
    lastFetchedAt,
    isStale,
    isExpired,
    isUsable,
    sourceFreshness: backendFreshness,
    refresh: cache.refresh,
    find,
  }
}
