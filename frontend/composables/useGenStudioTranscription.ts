export interface GenStudioTranscriptionModel {
  id: string
  display_name: string
  provider: string
  language: string
  available: boolean
  available_workers: number
  qualification_only: boolean
}

/** Shared GenStudio transcription catalog state for Subtitles and B-Roll. */
export function useGenStudioTranscriptionModels() {
  const { get } = useApi()
  const models = ref<GenStudioTranscriptionModel[]>([])
  const modelId = ref('')
  const loading = ref(false)
  const error = ref('')

  const selectedModel = computed(() =>
    models.value.find(model => model.id === modelId.value),
  )
  const ready = computed(() => selectedModel.value?.available === true)
  const options = computed(() => models.value.map(model => ({
    id: model.id,
    label: model.display_name,
    group: 'GenStudio KH · transcription',
    provider: model.provider || 'GenStudio KH',
    meta: [
      model.language,
      model.available ? `${model.available_workers} ready worker${model.available_workers === 1 ? '' : 's'}` : 'No ready workers',
    ].filter(Boolean).join(' · '),
    description: model.qualification_only
      ? 'Qualification model published by GenStudio KH.'
      : 'Published by GenStudio KH.',
    badges: [
      ...(model.available
        ? [{ label: 'ready', tone: 'local' as const }]
        : [{ label: 'offline', tone: 'warning' as const }]),
      ...(model.qualification_only
        ? [{ label: 'qualification', tone: 'info' as const }]
        : []),
    ],
  })))

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const response = await get<{ models: GenStudioTranscriptionModel[] }>(
        '/app-settings/genstudio/transcription-models',
        { cache: 'no-store' },
      )
      models.value = Array.isArray(response.models) ? response.models : []
      if (!models.value.some(model => model.id === modelId.value)) {
        modelId.value = (
          models.value.find(model => model.available) || models.value[0]
        )?.id || ''
      }
      if (!models.value.length) {
        error.value = 'GenStudio KH did not publish a transcription model.'
      }
    } catch (cause: any) {
      models.value = []
      error.value = cause?.data?.detail || cause?.message || (
        'Could not load GenStudio KH transcription models. Ensure the saved API key includes audio:transcribe.'
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
    load,
  }
}
