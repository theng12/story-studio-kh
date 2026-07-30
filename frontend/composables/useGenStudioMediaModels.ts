export interface GenStudioVoiceModelInfo {
  id: string
  display_name: string
  description?: string
  available: boolean
  qualification_only: boolean
  pricing_unit?: string
  limits?: Record<string, unknown>
  controls?: Record<string, unknown>
  unlimited_relaxed?: boolean
  legacy_ids?: string[]
}

export interface GenStudioVideoModelInfo {
  id: string
  display_name: string
  description?: string
  available: boolean
  modes: Array<'image-to-video'>
  aspect_ratios: string[]
  variants: Array<{
    duration_seconds: 5 | 10
    resolution: '720p' | '1080p'
    credits_per_video: number
    minimum_credits: number
    price_version: string
  }>
  legacy_ids?: string[]
}

// Two independent live catalogs (voice, video) each get their own freshness
// clock — a stale video catalog shouldn't hold a fresh voice fetch hostage,
// or vice versa — but they share the exact same fresh/ceiling policy via
// `createGenStudioCatalogCache`.
const voiceCache = createGenStudioCatalogCache<GenStudioVoiceModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioVoiceModelInfo[] }>('/app-settings/genstudio/voice-models', { cache: 'no-store' })
    return Array.isArray(response.models) ? response.models : []
  },
})
const videoCache = createGenStudioCatalogCache<GenStudioVideoModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioVideoModelInfo[] }>('/app-settings/genstudio/video-models', { cache: 'no-store' })
    return Array.isArray(response.models) ? response.models : []
  },
})

/** Shared live catalogs. GenStudio remains the source of truth; nothing is copied into project config. */
export function useGenStudioMediaModels() {
  async function refresh(force = false): Promise<void> {
    // Each cache already coalesces its own concurrent callers and skips the
    // network when it's still fresh, so a plain fan-out here is enough —
    // no extra outer "already loading" gate needed.
    const [voiceResult, videoResult] = await Promise.allSettled([
      voiceCache.refresh(force),
      videoCache.refresh(force),
    ])
    void voiceResult
    void videoResult
  }

  const loading = computed(() => voiceCache.loading.value || videoCache.loading.value)
  const loaded = computed(() => voiceCache.loaded.value && videoCache.loaded.value)
  const error = computed(() => [voiceCache.error.value, videoCache.error.value].filter(Boolean).join(' '))
  const lastFetchedAt = computed(() => {
    const values = [voiceCache.lastFetchedAt.value, videoCache.lastFetchedAt.value].filter((v): v is number => v !== null)
    return values.length ? Math.min(...values) : null
  })
  const isStale = computed(() => voiceCache.isStale.value || videoCache.isStale.value)
  const isExpired = computed(() => voiceCache.isExpired.value || videoCache.isExpired.value)
  const isUsable = computed(() => voiceCache.isUsable.value && videoCache.isUsable.value)

  return {
    voiceModels: voiceCache.data,
    videoModels: videoCache.data,
    loading,
    loaded,
    error,
    lastFetchedAt,
    isStale,
    isExpired,
    isUsable,
    refresh,
  }
}
