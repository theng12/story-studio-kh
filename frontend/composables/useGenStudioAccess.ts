import type { GenStudioAccessStatus } from '~/utils/genstudio-relaxed'
import { genStudioPlanNotice, genStudioUnlimitedBadge } from '~/utils/genstudio-relaxed'
import { useApi } from './useApi.js'
import { createGenStudioCatalogCache } from './useGenStudioCatalogCache.js'

const cache = createGenStudioCatalogCache<GenStudioAccessStatus | null>({
  empty: null,
  fetcher: async () => {
    const { get } = useApi()
    return await get<GenStudioAccessStatus>('/app-settings/genstudio/access', { cache: 'no-store' })
  },
})

/**
 * Shared account entitlement cache used by every GenStudio model picker.
 * Credits/plan status is exactly the kind of thing that must not be shown
 * stale-and-unmarked — see `useGenStudioCatalogCache.ts` for the shared
 * freshness policy this now runs on.
 */
export function useGenStudioAccess() {
  const access = cache.data
  const planNotice = computed(() => genStudioPlanNotice(access.value))

  return {
    access,
    loading: cache.loading,
    loaded: cache.loaded,
    error: cache.error,
    lastFetchedAt: cache.lastFetchedAt,
    isStale: cache.isStale,
    isExpired: cache.isExpired,
    isUsable: cache.isUsable,
    planNotice,
    badgeFor: (supportsUnlimited: boolean) => genStudioUnlimitedBadge(supportsUnlimited, access.value),
    refresh: cache.refresh,
  }
}
