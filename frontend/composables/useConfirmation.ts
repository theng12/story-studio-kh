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

/**
 * Auto-confirm threshold per cost unit. Below the threshold we skip the
 * dialog entirely — showing it for every "1 credit" operation trains the
 * user to dismiss it and then disable the type via "Skip future". Above
 * the threshold, the dialog fires as usual.
 *
 * `force=true` ALWAYS bypasses the threshold (regenerating paid work is
 * the costly path we always want to confirm).
 *
 * Numbers chosen for sleep-story workloads: ~$0.05 USD-equivalent — small
 * enough that a typical 1-scene retest doesn't nag, large enough that any
 * batch of >5 images on a paid model trips the dialog.
 */
const COST_THRESHOLDS: Record<string, number> = {
  USD: 0.05,
  credits: 10,    // kie.ai: 1 credit = $0.005, so 10 credits = $0.05
}

// (USD-per-credit conversion lives in CostConfirmationDialog.vue where
// the dialog formats the figure for display. Threshold logic above only
// needs raw cost vs. unit-specific threshold.)

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
    // v1.0.47 — diagnostic instrumentation. Same investigation as the
    // logs in useVideoAssemblyIo: trace each branch so a re-test on
    // the beta Mac can pinpoint exactly where a click-Generate flow
    // swallows its dialog. Strip in a follow-up commit once the
    // root cause is fixed — grep `[confirmGeneration]`.
    console.log('[confirmGeneration] entry', { type, fps: params?.fps })
    if (!shouldConfirm(type)) {
      console.log('[confirmGeneration] skipped via user pref (shouldConfirm=false)')
      return true
    }

    // Pre-fetch the estimate BEFORE deciding whether to show the dialog —
    // we need the cost number to compare against the threshold. If it's a
    // tiny op (< $0.05 USD-equivalent), skip the dialog entirely so the
    // user isn't trained to dismiss-and-disable.
    let estimate: CostEstimate
    try {
      console.log('[confirmGeneration] awaiting estimate-cost POST')
      estimate = await post<CostEstimate>(`/projects/${slug}/estimate-cost`, { type, params })
      console.log('[confirmGeneration] estimate returned', {
        cost_unit: estimate.cost_unit,
        estimated_cost: estimate.estimated_cost,
      })
    } catch (err) {
      console.warn('[confirmGeneration] estimate-cost threw, falling back to unknown', err)
      estimate = {
        estimated_cost: '?',
        cost_unit: '',
        estimated_duration: 'Unknown',
        details: 'Could not estimate cost',
      }
    }

    // Auto-confirm path. Three exits:
    //   1. cost is unknown ('?') → fall through and show the dialog so the
    //      user can decide rather than auto-proceeding into a black box.
    //   2. force=true → always show; regenerating paid work is the path
    //      we never want to silently pass.
    //   3. cost < threshold for its unit → auto-proceed.
    const numericCost = typeof estimate.estimated_cost === 'number'
      ? estimate.estimated_cost
      : Number(estimate.estimated_cost)
    const threshold = COST_THRESHOLDS[estimate.cost_unit]
    const isForceRegen = params?.force === true
    if (
      Number.isFinite(numericCost) &&
      threshold !== undefined &&
      numericCost < threshold &&
      !isForceRegen
    ) {
      console.log('[confirmGeneration] auto-confirmed (below threshold)', { numericCost, threshold })
      return true
    }

    // Show the dialog. Dialog component reads from `state` reactively.
    console.log('[confirmGeneration] showing dialog')
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
