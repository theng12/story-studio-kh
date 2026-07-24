export interface GenStudioTranscriptionModel {
  id: string
  display_name: string
  provider: string
  language: string
  available: boolean
  available_workers: number
  qualification_only: boolean
  unlimited_relaxed?: boolean
}

/** Shared live transcription catalog state for Subtitles and B-Roll. */
export function useGenStudioTranscriptionModels() {
  const { get } = useApi()
  const { planNotice, badgeFor, refresh: refreshAccess } = useGenStudioAccess()
  const models = ref<GenStudioTranscriptionModel[]>([])
  const modelId = ref('')
  const loading = ref(false)
  const error = ref('')

  const selectedModel = computed(() =>
    models.value.find(model => model.id === modelId.value),
  )
  const ready = computed(() => selectedModel.value?.available === true)
  const options = computed(() => models.value.map((model) => {
    const unlimited = badgeFor(model.unlimited_relaxed === true)
    return {
      id: model.id,
      label: model.display_name,
      group: 'Transcription',
      meta: model.language,
      description: model.qualification_only
        ? 'Available for qualified accounts.'
        : 'Available for transcription.',
      disabled: !model.available,
      disabledReason: model.available ? undefined : 'This transcription model is temporarily unavailable.',
      badges: [
        ...(!model.available ? [{ label: 'unavailable', tone: 'warning' as const }] : []),
        ...(model.qualification_only
          ? [{ label: 'qualification', tone: 'info' as const }]
          : []),
        ...(unlimited ? [unlimited] : []),
      ],
    }
  }))

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const [response] = await Promise.all([
        get<{ models: GenStudioTranscriptionModel[] }>(
          '/app-settings/genstudio/transcription-models',
          { cache: 'no-store' },
        ),
        refreshAccess(),
      ])
      models.value = Array.isArray(response.models) ? response.models : []
      // A remembered id is only a preference. Never leave a retired or
      // temporarily unavailable model selected just because it still exists
      // in an old preset; choose a currently usable catalog model instead.
      if (!models.value.some(model => model.id === modelId.value && model.available)) {
        modelId.value = models.value.find(model => model.available)?.id || ''
      }
      if (!models.value.length) {
        error.value = 'No transcription models are available right now.'
      }
    } catch (cause: any) {
      models.value = []
      error.value = cause?.data?.detail || cause?.message || (
        'Could not load transcription models. Check your connection and try again.'
      )
    } finally {
      loading.value = false
    }
  }

  return {
    models,
    modelId,
    selectedModel,
    options,
    loading,
    error,
    ready,
    planNotice,
    load,
  }
}
