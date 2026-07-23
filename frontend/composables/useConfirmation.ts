/** GenStudio is the sole pricing authority. Story Studio shows its live
 * estimate and price version, then GenStudio reserves and settles the final
 * credit amount when the job is submitted. */
interface CreditEstimate {
  estimated_credits: number | null
  price_version: string | null
  pricing_basis: string
  estimated_duration: string | null
  quote_status: 'estimated' | 'exact' | 'not_applicable' | 'unavailable'
}

interface ConfirmationState {
  visible: boolean
  type: string
  typeLabel: string
  estimate: CreditEstimate | null
  loading: boolean
  resolve: ((value: boolean) => void) | null
}

const state = reactive<ConfirmationState>({
  visible: false,
  type: '',
  typeLabel: '',
  estimate: null,
  loading: false,
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
  // YouTube Upload Center actions — all three flow through the same
  // confirmation dialog so a single "don't ask again" toggle covers
  // each of them. The cost-estimation endpoint reports YouTube API
  // quota units (1600 per upload, 50 per metadata/playlist call) so
  // the user sees the impact before bulk-applying to many rows.
  youtube_upload: 'YouTube Upload',
  youtube_metadata_update: 'YouTube Metadata Update',
  youtube_playlist_update: 'YouTube Playlist Update',
}

export function useConfirmation() {
  const { post, put } = useApi()
  const { config, refreshConfig } = useProject()

  function shouldConfirm(generatorType: string): boolean {
    const prefs = config.value?.confirmation_preferences
    if (!prefs) return true // default: confirm everything
    return prefs[generatorType] !== false
  }

  async function confirmGeneration(
    slug: string,
    type: string,
    params: Record<string, any>,
  ): Promise<boolean> {
    if (!shouldConfirm(type)) return true

    let estimate: CreditEstimate
    try {
      estimate = await post<CreditEstimate>(`/projects/${slug}/estimate-cost`, { type, params })
    } catch (err) {
      console.warn('[confirmGeneration] GenStudio credit preflight failed', err)
      estimate = {
        estimated_credits: null,
        price_version: null,
        pricing_basis: 'Could not load the live GenStudio credit estimate. GenStudio remains authoritative when the job is accepted.',
        estimated_duration: null,
        quote_status: 'unavailable',
      }
    }

    // Show the dialog. Dialog component reads from `state` reactively.
    state.visible = true
    state.type = type
    state.typeLabel = TYPE_LABELS[type] || type
    state.loading = false
    state.estimate = estimate

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
  }

  function cancel() {
    state.visible = false
    state.resolve?.(false)
    state.resolve = null
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
