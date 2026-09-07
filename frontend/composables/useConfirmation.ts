interface ConfirmationState {
  visible: boolean
  type: string
  typeLabel: string
  action: string
  details: Array<{ label: string; value: string }>
  resolve: ((value: boolean) => void) | null
}

interface GenerationConfirmationContext {
  action: string
  details?: Array<{ label: string; value: string }>
}

const state = reactive<ConfirmationState>({
  visible: false,
  type: '',
  typeLabel: '',
  action: '',
  details: [],
  resolve: null,
})

const TYPE_LABELS: Record<string, string> = {
  script: 'Script Generator',
  scene_prompts: 'Scene Prompts',
  thumb_prompts: 'Thumbnail Prompts',
  scene_images: 'Scene Images',
  thumb_images: 'Thumbnail Images',
  images: 'Images (Scenes + Thumbnails)',
  audio: 'Audio Generator',
  description: 'Description Generator',
  // YouTube Upload Center actions share this dialog so one “don't ask again”
  // preference covers the related actions. They do not carry a GenStudio
  // generation estimate.
  youtube_upload: 'YouTube Upload',
  youtube_metadata_update: 'YouTube Metadata Update',
  youtube_playlist_update: 'YouTube Playlist Update',
}

export function useConfirmation() {
  const { put } = useApi()
  const { config, refreshConfig } = useProject()

  function shouldConfirm(generatorType: string): boolean {
    const prefs = config.value?.confirmation_preferences
    if (!prefs) return true // default: confirm everything
    return prefs[generatorType] !== false
  }

  async function confirmGeneration(
    slug: string,
    type: string,
    _params: Record<string, any>,
    context?: GenerationConfirmationContext,
  ): Promise<boolean> {
    if (!shouldConfirm(type)) return true

    // Confirmation is intentionally local and action-only. GenStudio owns
    // credit admission, reservation, and settlement at job submission.
    state.visible = true
    state.type = type
    state.typeLabel = TYPE_LABELS[type] || type
    state.action = context?.action || ''
    state.details = context?.details || []

    // Wait for user to confirm or cancel
    return new Promise<boolean>((resolve) => {
      state.resolve = resolve
    })
  }

  function confirm(skipFuture: boolean) {
    if (skipFuture && state.type) {
      // Save preference to skip this generator's confirmation
      saveSkipPreference(state.type)
    }
    state.visible = false
    state.resolve?.(true)
    state.resolve = null
    state.action = ''
    state.details = []
  }

  function cancel() {
    state.visible = false
    state.resolve?.(false)
    state.resolve = null
    state.action = ''
    state.details = []
  }

  async function saveSkipPreference(type: string) {
    const route = useRoute()
    const slug = route.params.slug as string
    const prefs = { ...(config.value?.confirmation_preferences || {}) }
    prefs[type] = false
    try {
      await put(`/projects/${slug}/settings/config`, { confirmation_preferences: prefs })
      await refreshConfig(slug)
    } catch { /* silently fail */ }
  }

  return {
    state: readonly(state) as ConfirmationState,
    shouldConfirm,
    confirmGeneration,
    confirm,
    cancel,
  }
}
