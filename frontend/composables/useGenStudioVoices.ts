/**
 * The GenStudio speech catalogue: voice models, the voices each one serves,
 * the customer's saved voices, the provider voice libraries, and quotes.
 *
 * The contract this follows (AGENTS.md → "Everything Follows the Selected
 * Model" and "Provider Transparency"):
 *
 * - The MODEL is the selection and the pricing axis. Voices are listed below it
 *   and restricted to the ones that model serves.
 * - Every limit, price, capability and provider name shown here is read from
 *   GenStudio. Nothing is inferred from an id, and nothing is remembered past
 *   a selection change — changing the model re-reads the voices.
 * - Saved state belongs to GenStudio. Toggling it re-reads the row rather than
 *   keeping a local copy that could drift.
 * - Provider identity is DISPLAY only. Nothing here selects, ranks or sends a
 *   provider on a generation request.
 */

/** `TTSModelResponse`. Every field is published; none is derived. */
export interface GenStudioTtsModel {
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
}

/** `StandardVoiceResponse`. */
export interface GenStudioVoice {
  id: string
  display_name: string
  language?: string
  description?: string
  provider?: string
  engine_id?: string
  engine_name?: string
  model_revision_id?: string
  model_family?: string
  voice_tier?: string
  voice_revision?: string
  credits_per_1000_characters?: number
  output_format?: string
  catalog_status?: string
  unlimited_relaxed?: boolean
  quote_enabled?: boolean
  generation_enabled?: boolean
  preview_available?: boolean
  preview_url?: string | null
  preview_text?: string | null
  preview_notice?: string | null
  is_saved?: boolean
  tts_model_id?: string | null
  tts_model_name?: string | null
}

export interface GenStudioLibraryVoice {
  public_voice_id: string
  name: string
  description: string
  language: string
  accent?: string | null
  gender?: string | null
  age?: string | null
  use_case?: string | null
  category?: string | null
  preview_available: boolean
  preview_url: string | null
  notice_period_days?: number | null
  genstudio_voice_id?: string | null
  is_saved?: boolean
  credits_per_1000_characters?: number
}

export interface GenStudioVoiceLibrary {
  id: string
  label: string
}

/** `TTSQuoteResponse` — GenStudio's own figure for one exact script. */
export interface GenStudioTtsQuote {
  model_id?: string | null
  model_name?: string | null
  voice_id: string
  voice_tier: string
  billable_characters: number
  speed: number
  estimated_duration_ms: number
  maximum_input_characters: number
  credits: number
  credits_per_1000_characters: number
  price_version: string
  output_format: string
  chargeable: boolean
  generation_enabled: boolean
  notice: string
}

/**
 * A voice GenStudio will actually run right now. `catalog_status` and
 * `generation_enabled` are published gates; a voice failing either is still
 * listed (so a saved selection is explicable) but cannot be generated with.
 */
export function voiceIsGenerable(voice: GenStudioVoice): boolean {
  return voice.generation_enabled !== false && voice.catalog_status === 'published'
}

export function useGenStudioVoices() {
  const { get, post, del } = useApi()

  const models = ref<GenStudioTtsModel[]>([])
  const modelsLoading = ref(false)
  const modelsError = ref('')
  const modelsLoaded = ref(false)

  const voices = ref<GenStudioVoice[]>([])
  const voicesLoading = ref(false)
  const voicesError = ref('')
  /** Which model the loaded voices belong to. Cleared on every model change. */
  const voicesModelId = ref<string | null>(null)

  const libraries = ref<GenStudioVoiceLibrary[]>([])

  async function loadModels(): Promise<void> {
    modelsLoading.value = true
    modelsError.value = ''
    try {
      const data = await get<{ models?: GenStudioTtsModel[] }>('/app-settings/genstudio/tts-models', { cache: 'no-store' })
      models.value = Array.isArray(data.models) ? data.models : []
      modelsLoaded.value = true
    } catch (error: any) {
      models.value = []
      modelsError.value = error?.data?.detail || error?.message || 'The GenStudio KH voice model catalogue is unavailable.'
    } finally {
      modelsLoading.value = false
    }
  }

  function clearVoices(): void {
    voices.value = []
    voicesModelId.value = null
    voicesError.value = ''
  }

  /**
   * GenStudio decides compatibility: `model_id` is its own filter, so Story
   * Studio never compares ids to guess which voices a model serves. An empty
   * `modelId` deliberately sends no filter and returns every voice on the
   * account, each naming the model that serves it.
   */
  async function loadVoices(modelId: string, search = ''): Promise<void> {
    voicesLoading.value = true
    voicesError.value = ''
    try {
      const query = new URLSearchParams()
      if (modelId.trim()) query.set('model_id', modelId.trim())
      if (search.trim()) query.set('search', search.trim())
      const suffix = query.size ? `?${query.toString()}` : ''
      const data = await get<{ voices?: GenStudioVoice[] }>(
        `/app-settings/genstudio/voices${suffix}`,
        { cache: 'no-store' },
      )
      voices.value = Array.isArray(data.voices) ? data.voices : []
      voicesModelId.value = modelId || null
    } catch (error: any) {
      voices.value = []
      voicesModelId.value = null
      voicesError.value = error?.data?.detail || error?.message || 'The GenStudio KH voice catalogue is unavailable.'
    } finally {
      voicesLoading.value = false
    }
  }

  /**
   * GenStudio owns `is_saved`. The response carries the refreshed row, so the
   * list reflects what GenStudio now says rather than what was clicked.
   */
  async function setSaved(voiceId: string, saved: boolean): Promise<void> {
    const path = `/app-settings/genstudio/voices/${encodeURIComponent(voiceId)}/save`
    const response = saved
      ? await post<{ voice?: GenStudioVoice | null }>(path, {})
      : await del<{ voice?: GenStudioVoice | null }>(path)
    const updated = response?.voice
    voices.value = voices.value.map(voice => (
      voice.id === voiceId
        ? (updated && updated.id === voiceId ? updated : { ...voice, is_saved: saved })
        : voice
    ))
  }

  async function loadLibraries(): Promise<void> {
    try {
      const data = await get<{ libraries?: GenStudioVoiceLibrary[] }>('/app-settings/genstudio/voice-libraries')
      libraries.value = Array.isArray(data.libraries) ? data.libraries : []
    } catch {
      libraries.value = []
    }
  }

  async function browseLibrary(
    library: string,
    options: { search?: string; page?: number } = {},
  ): Promise<{ page: number; has_more: boolean; voices: GenStudioLibraryVoice[] }> {
    const query = new URLSearchParams()
    if (options.search?.trim()) query.set('search', options.search.trim())
    if (options.page) query.set('page', String(options.page))
    const suffix = query.size ? `?${query.toString()}` : ''
    const data = await get<{ page?: number; has_more?: boolean; voices?: GenStudioLibraryVoice[] }>(
      `/app-settings/genstudio/voice-libraries/${encodeURIComponent(library)}${suffix}`,
      { cache: 'no-store' },
    )
    return {
      page: typeof data.page === 'number' ? data.page : 0,
      has_more: data.has_more === true,
      voices: Array.isArray(data.voices) ? data.voices : [],
    }
  }

  async function addLibraryVoice(library: string, publicVoiceId: string): Promise<{ voice_id: string; created: boolean }> {
    return await post<{ voice_id: string; created: boolean }>(
      `/app-settings/genstudio/voice-libraries/${encodeURIComponent(library)}/add`,
      { public_voice_id: publicVoiceId },
    )
  }

  async function libraryPreviewUrl(library: string, publicVoiceId: string): Promise<string> {
    const data = await get<{ audio_url?: string }>(
      `/app-settings/genstudio/voice-libraries/${encodeURIComponent(library)}/${encodeURIComponent(publicVoiceId)}/preview`,
      { cache: 'no-store' },
    )
    return data.audio_url || ''
  }

  /** GenStudio's exact figure for this exact text. Never an estimate. */
  async function quote(request: {
    model_id?: string | null
    voice_id: string
    text: string
    speed?: number
  }): Promise<GenStudioTtsQuote> {
    return await post<GenStudioTtsQuote>('/app-settings/genstudio/tts-quote', request)
  }

  return {
    models,
    modelsLoading,
    modelsError,
    modelsLoaded,
    voices,
    voicesLoading,
    voicesError,
    voicesModelId,
    libraries,
    loadModels,
    loadVoices,
    clearVoices,
    setSaved,
    loadLibraries,
    browseLibrary,
    addLibraryVoice,
    libraryPreviewUrl,
    quote,
  }
}
