import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'

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
  /** Published surcharge when this combination is rendered from references. */
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
  chargeable: boolean
  qualification_only: boolean
  credits_per_image?: number | null
  base_credits_per_image?: number | null
  promotion_name?: string
  promotion_discount_percent?: number
  /** Published surcharge for a reference-guided render. Absent = none published. */
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
  legacy_ids?: string[]
}

const cache = createGenStudioCatalogCache<GenStudioImageModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioImageModelInfo[] }>('/app-settings/genstudio/image-models', { cache: 'no-store' })
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
  function find(modelId: string): GenStudioImageModelInfo | undefined {
    return cache.data.value.find(model => model.id === modelId)
  }

  return {
    models: cache.data,
    loading: cache.loading,
    loaded: cache.loaded,
    error: cache.error,
    lastFetchedAt: cache.lastFetchedAt,
    isStale: cache.isStale,
    isExpired: cache.isExpired,
    isUsable: cache.isUsable,
    refresh: cache.refresh,
    find,
  }
}
