import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'

export interface GenStudioImageSize {
  aspect_ratio: string
  width: number
  height: number
  label?: string
  default?: boolean
}

export interface GenStudioImageModelInfo {
  id: string
  display_name: string
  description?: string
  available: boolean
  chargeable: boolean
  qualification_only: boolean
  unlimited_relaxed?: boolean
  aspect_ratios: string[]
  default_aspect_ratio: string
  default_steps: number
  min_steps: number
  max_steps: number
  supports_reference_images: boolean
  max_reference_images: number
  reference_strength_mode: string
  supported_reference_strengths: string[]
  sizes?: GenStudioImageSize[]
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
