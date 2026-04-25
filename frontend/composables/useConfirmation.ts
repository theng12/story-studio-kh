/**
 * Cost estimation confirmation dialog composable.
 * Shows a modal before generation with estimated cost, duration, and current balance.
 * Respects per-generator skip preferences stored in project config.
 */

interface CostEstimate {
  estimated_cost: number | string
  cost_unit: string
  estimated_duration: string
  details: string
  current_balance?: number | string
}

interface ConfirmationState {
  visible: boolean
  type: string
  typeLabel: string
  estimate: CostEstimate | null
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
}

export function useConfirmation() {
  const { post, put } = useApi()
  const { config, refreshConfig } = useProject()

  function shouldConfirm(generatorType: string): boolean {
    const prefs = (config.value as any)?.confirmation_preferences
    if (!prefs) return true // default: confirm everything
    return prefs[generatorType] !== false
  }

  async function confirmGeneration(
    slug: string,
    type: string,
    params: Record<string, any>,
  ): Promise<boolean> {
    if (!shouldConfirm(type)) return true

    // Fetch cost estimate from backend
    state.visible = true
    state.type = type
    state.typeLabel = TYPE_LABELS[type] || type
    state.loading = true
    state.estimate = null

    try {
      state.estimate = await post<CostEstimate>(`/projects/${slug}/estimate-cost`, { type, params })
    } catch {
      state.estimate = {
        estimated_cost: '?',
        cost_unit: '',
        estimated_duration: 'Unknown',
        details: 'Could not estimate cost',
      }
    }
    state.loading = false

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
    const prefs = { ...((config.value as any)?.confirmation_preferences || {}) }
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
