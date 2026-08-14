import type { GenStudioCostTier } from '../utils/genstudio-cost-tier.js'

/** A `/v1/tts/models` row — the same catalogue the voice picker selects from. */
export interface GenStudioVoiceModelInfo {
  id: string
  display_name: string
  provider_id: string
  provider_name: string
  description: string
  credits_per_1000_characters: number
  minimum_credits: number
  maximum_input_characters: number
  supports_speed: boolean
  supports_voice_cloning: boolean
  preview_policy: string
  generation_enabled: boolean
  legacy_ids?: string[]
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string
}

export interface GenStudioVideoModelInfo {
  id: string
  display_name: string
  description?: string
  available: boolean
  /** Every mode GenStudio publishes. Story Studio only SUBMITS
   *  'image-to-video' (AGENTS.md), and filters for it at the picker, but the
   *  catalogue is carried through whole. */
  modes: string[]
  aspect_ratios: string[]
  /** Published (duration, resolution) options with their own prices.
   *  Deliberately `number` / `string`: GenStudio publishes durations across
   *  3-15s and resolutions across 480p|720p|1080p|4k, and a literal union
   *  here would be a copy of the catalogue that goes stale on their release,
   *  not ours. */
  variants: Array<{
    operation: string
    duration_seconds: number
    resolution: string
    credits_per_video: number
    minimum_credits: number
    price_version: string
  }>
  /** Does the clip come back with its own audio track? `null` means GenStudio
   *  published nothing, which is NOT "no audio" and is never shown as one.
   *  Story Studio's assembly composes narration over the clip and drops any
   *  embedded track, so a `true` is disclosed at the point of choosing. */
  generates_audio?: boolean | null
  legacy_ids?: string[]
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string
}

// Two independent live catalogs (voice, video) each get their own freshness
// clock — a stale video catalog shouldn't hold a fresh voice fetch hostage,
// or vice versa — but they share the exact same fresh/ceiling policy via
// `createGenStudioCatalogCache`.
const voiceCache = createGenStudioCatalogCache<GenStudioVoiceModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioVoiceModelInfo[] }>('/app-settings/genstudio/tts-models', { cache: 'no-store' })
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
