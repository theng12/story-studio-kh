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
  qualification_only: boolean
  aspect_ratios: string[]
  default_aspect_ratio: string
  default_steps: number
  min_steps: number
  max_steps: number
  sizes?: GenStudioImageSize[]
}

const catalog = ref<GenStudioImageModelInfo[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

/** One app-wide live catalog cache shared by every image picker/workspace. */
export function useGenStudioImageModels() {
  const { get } = useApi()

  async function refresh(force = false): Promise<void> {
    if (loading.value || (loaded.value && !force)) return
    loading.value = true
    error.value = ''
    try {
      const response = await get<{ models?: GenStudioImageModelInfo[] }>('/app-settings/genstudio/image-models')
      catalog.value = Array.isArray(response.models) ? response.models : []
      loaded.value = true
    } catch (e: any) {
      catalog.value = []
      loaded.value = true
      error.value = e?.data?.detail || e?.message || 'GenStudio KH image catalog unavailable'
    } finally {
      loading.value = false
    }
  }

  function find(modelId: string): GenStudioImageModelInfo | undefined {
    return catalog.value.find(model => model.id === modelId)
  }

  return {
    models: readonly(catalog),
    loading: readonly(loading),
    loaded: readonly(loaded),
    error: readonly(error),
    refresh,
    find,
  }
}
