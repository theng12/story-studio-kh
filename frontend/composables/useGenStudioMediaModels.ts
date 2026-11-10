import type { PublishedVideoCapabilities } from '@shared/video-capabilities'
import type { PriceTruth } from '../utils/genstudio-price-usd.js'
import type { GenStudioCostTier } from '../utils/genstudio-cost-tier.js'
import { GENSTUDIO_CATALOG_STALE_CEILING_MS } from './useGenStudioCatalogCache.js'
import { normalizeGenStudioLoadedAt } from '../utils/genstudio-freshness.js'

/** A `/v1/tts/models` row — the same catalogue the voice picker selects from. */
export interface GenStudioVoiceModelInfo extends PriceTruth {
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
  /** Exact language codes published for this model. Empty means unpublished. */
  supported_languages: string[]
  legacy_ids?: string[]
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string
}

/** One published boolean switch on a video row. Kept in step with the transport's
 *  `GenStudioVideoControl` (electron/server/lib/genstudio-client.ts): the frontend
 *  cannot import from the Electron server tree, so the shape is declared twice and
 *  both copies are parsed by the same rule — a name to key a value by, a boolean
 *  type, and the lane's own default and note, neither of which is ever coerced. */
export interface GenStudioVideoControl {
  name: string
  type: string
  /** The lane's own default, or `null` when it stated none. */
  default: boolean | null
  /** The lane's own sentence, shown verbatim. `null` when it wrote none. */
  note: string | null
}

export interface GenStudioVideoModelInfo extends PriceTruth, PublishedVideoCapabilities {
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
  /**
   * The lane's own **switches**: every boolean parameter GenStudio publishes for
   * this row, with the lane's default and the lane's own sentence about it.
   *
   * A separate field from `generates_audio` on purpose: that one says the
   * product makes a soundtrack, which says nothing about whether a caller may
   * ask for a clip WITHOUT one. Measured 2026-09-27 — a local Studio Hub video
   * lane published `audio` (default `true`, note and all) and no cloud video lane
   * publishes any switch — so the control is rendered from this list and never
   * from a name Story Studio knows on its own. Absent means none published,
   * which is not the same statement as a published empty list.
   */
  controls?: GenStudioVideoControl[] | null
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

// Two independent live catalogs (voice, video) each get their own freshness
// clock — a stale video catalog shouldn't hold a fresh voice fetch hostage,
// or vice versa — but they share the exact same fresh/ceiling policy via
// `createGenStudioCatalogCache`.
interface BackendCatalogFreshness {
  stale: boolean
  ageMs: number
  loadedAt: number | null
}
interface BackendCatalogFreshnessResponse extends Omit<BackendCatalogFreshness, 'loadedAt'> {
  loadedAt: string | number | null
}

const voiceFreshness = ref<BackendCatalogFreshness | null>(null)
const videoFreshness = ref<BackendCatalogFreshness | null>(null)
const voiceCache = createGenStudioCatalogCache<GenStudioVoiceModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioVoiceModelInfo[]; freshness?: BackendCatalogFreshnessResponse }>('/app-settings/genstudio/tts-models', { cache: 'no-store' })
    voiceFreshness.value = response.freshness
      ? { ...response.freshness, loadedAt: normalizeGenStudioLoadedAt(response.freshness.loadedAt) }
      : null
    return Array.isArray(response.models) ? response.models : []
  },
})
const videoCache = createGenStudioCatalogCache<GenStudioVideoModelInfo[]>({
  empty: [],
  fetcher: async () => {
    const { get } = useApi()
    const response = await get<{ models?: GenStudioVideoModelInfo[]; freshness?: BackendCatalogFreshnessResponse }>('/app-settings/genstudio/video-models', { cache: 'no-store' })
    videoFreshness.value = response.freshness
      ? { ...response.freshness, loadedAt: normalizeGenStudioLoadedAt(response.freshness.loadedAt) }
      : null
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
    const values = [
      voiceFreshness.value?.loadedAt ?? voiceCache.lastFetchedAt.value,
      videoFreshness.value?.loadedAt ?? videoCache.lastFetchedAt.value,
    ].filter((v): v is number => v !== null)
    return values.length ? Math.min(...values) : null
  })
  const isStale = computed(() => voiceFreshness.value?.stale === true || videoFreshness.value?.stale === true
    || voiceCache.isStale.value || videoCache.isStale.value)
  const isExpired = computed(() => (voiceFreshness.value?.stale === true
    && voiceFreshness.value.ageMs > GENSTUDIO_CATALOG_STALE_CEILING_MS)
    || (videoFreshness.value?.stale === true && videoFreshness.value.ageMs > GENSTUDIO_CATALOG_STALE_CEILING_MS)
    || voiceCache.isExpired.value || videoCache.isExpired.value)
  const isUsable = computed(() => voiceCache.isUsable.value && videoCache.isUsable.value
    && !isStale.value && !isExpired.value)

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
