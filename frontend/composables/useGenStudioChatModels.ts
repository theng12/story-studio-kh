import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'

/**
 * The customer-facing view of one live GenStudio language product.
 *
 * Pricing is per MILLION TOKENS, which is why no total can be shown before a
 * run: the output length is not known until the model has written it. Story
 * Studio shows the published rate and defers the total to the figure
 * GenStudio reports on the finished job.
 */
export interface GenStudioChatModelInfo {
  id: string
  display_name: string
  provider_name?: string
  description?: string
  available: boolean
  availability_reason?: 'daily_quota_depleted' | 'temporary_backpressure' | null
  available_again_at?: string | null
  qualification_only: boolean
  context_window_tokens?: number
  max_output_tokens?: number
  input_credits_per_million_tokens?: number
  output_credits_per_million_tokens?: number
  /** The undiscounted rates, published only while GenStudio is applying a sale
   *  to this account. Carried so the rate line under a picker shows the same
   *  struck-through price the picker row does — two surfaces disagreeing about
   *  what a model costs is worse than neither mentioning the sale. */
  standard_input_credits_per_million_tokens?: number | null
  standard_output_credits_per_million_tokens?: number | null
  minimum_credits?: number
  price_version?: string
  locked?: boolean
  lock_reason?: string
}

const cache = createGenStudioCatalogCache<GenStudioChatModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioChatModelInfo[] } | GenStudioChatModelInfo[]>(
      '/app-settings/genstudio/chat-models',
      { cache: 'no-store' },
    )
    if (Array.isArray(response)) return response
    return Array.isArray(response?.models) ? response.models : []
  },
})

/**
 * One app-wide live catalog cache shared by every surface that needs a
 * language product's published rate. Same freshness policy as the image and
 * transcription catalogs — see `useGenStudioCatalogCache.ts`.
 */
export function useGenStudioChatModels() {
  function find(modelId: string): GenStudioChatModelInfo | undefined {
    return cache.data.value.find(model => model.id === modelId)
  }

  return {
    models: cache.data,
    loading: cache.loading,
    loaded: cache.loaded,
    error: cache.error,
    isStale: cache.isStale,
    isUsable: cache.isUsable,
    refresh: cache.refresh,
    find,
  }
}
