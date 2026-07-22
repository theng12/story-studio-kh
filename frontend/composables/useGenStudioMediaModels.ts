export interface GenStudioVoiceModelInfo {
  id: string
  display_name: string
  description?: string
  available: boolean
  qualification_only: boolean
  pricing_unit?: string
  limits?: Record<string, unknown>
  controls?: Record<string, unknown>
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

const voiceModels = ref<GenStudioVoiceModelInfo[]>([])
const videoModels = ref<GenStudioVideoModelInfo[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

/** Shared live catalogs. GenStudio remains the source of truth; nothing is copied into project config. */
export function useGenStudioMediaModels() {
  const { get } = useApi()

  async function refresh(force = false): Promise<void> {
    if (loading.value || (loaded.value && !force)) return
    loading.value = true
    error.value = ''
    try {
      const [voiceResult, videoResult] = await Promise.allSettled([
        get<{ models?: GenStudioVoiceModelInfo[] }>('/app-settings/genstudio/voice-models', { cache: 'no-store' }),
        get<{ models?: GenStudioVideoModelInfo[] }>('/app-settings/genstudio/video-models', { cache: 'no-store' }),
      ])
      voiceModels.value = voiceResult.status === 'fulfilled' && Array.isArray(voiceResult.value.models)
        ? voiceResult.value.models
        : []
      videoModels.value = videoResult.status === 'fulfilled' && Array.isArray(videoResult.value.models)
        ? videoResult.value.models
        : []
      const failures = [voiceResult, videoResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason?.data?.detail || result.reason?.message)
        .filter(Boolean)
      error.value = failures.join(' ')
    } catch (cause: any) {
      voiceModels.value = []
      videoModels.value = []
      error.value = cause?.data?.detail || cause?.message || 'GenStudio KH media catalog unavailable'
    } finally {
      loaded.value = true
      loading.value = false
    }
  }

  return {
    voiceModels: readonly(voiceModels),
    videoModels: readonly(videoModels),
    loading: readonly(loading),
    loaded: readonly(loaded),
    error: readonly(error),
    refresh,
  }
}
