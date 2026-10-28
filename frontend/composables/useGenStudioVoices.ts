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

import type {
  GenStudioDeliveryInstructionControl,
  GenStudioTtsControl,
  TtsControlValues,
} from '~/utils/tts-controls'
import type { GenStudioCostTier } from '~/utils/genstudio-cost-tier'
import type { RelaxedQueueHint } from '~/utils/genstudio-relaxed-queue'
import type { PriceTruth } from '~/utils/genstudio-price-usd'

/**
 * `TTSModelResponse`. Every field is published by GenStudio except the last
 * one, which the Story Studio backend adds and which is labelled as ours
 * wherever it is shown.
 */
export interface GenStudioTtsModel extends PriceTruth {
  id: string
  display_name: string
  provider_id: string
  provider_name: string
  description: string
  supported_languages: string[]
  credits_per_1000_characters: number
  minimum_credits: number
  maximum_input_characters: number
  supports_speed: boolean
  /** Exact numeric bounds GenStudio publishes for this model's speed control. */
  minimum_speed: number | null
  maximum_speed: number | null
  supports_voice_cloning: boolean
  preview_policy: string
  generation_enabled: boolean
  standard_credits: number | null
  sale_credits: number | null
  sale_ends_at: string | null
  sale_disclaimer: string | null
  queue_class: 'direct' | 'relaxed'
  relaxed_queue_hint: RelaxedQueueHint | null
  /**
   * The identifiers this product also answers to (`customer_handle`,
   * `public_model_id`, `legacy_ids`), exactly as the Gateway published them.
   * The picker matches a saved id against this set through
   * `@shared/genstudio-product-identity`, so a preset holding a superseded id
   * still resolves to the live row instead of leaving the voice picker with no
   * model to scope to.
   */
  legacy_ids?: string[]
  customer_handle?: string | null
  public_model_id?: string | null
  /**
   * `TTSModelResponse.controls[]` — every extra knob THIS model takes, with its
   * own label, type, published bounds, default and description. Rendered as
   * published (`components/TtsControlPanel.vue`); nothing here or downstream
   * names a control, so a model publishing one nobody has seen still works and
   * a model publishing an empty list shows no control section at all. Optional
   * only so an older cached response cannot break the page.
   */
  controls?: GenStudioTtsControl[]
  /**
   * The delivery/emotion control THIS model publishes, with the model's own
   * guidance inside it, or `null`/absent when the Gateway published none
   * (owner, 2026-10-29). Read from the model's own `controls[]` by the backend
   * and re-read on every catalogue read, so a model that gains or loses the
   * capability gains or loses the box with it. `null` means the setting is
   * hidden and no instruction is sent.
   */
  delivery_instruction?: GenStudioDeliveryInstructionControl | null
  /**
   * `TTSModelResponse.pause_parameters[]` — the join pauses (at a paragraph
   * break / after a sentence) this model takes, with its own bounds and
   * default. Absent or empty: its Macs take none yet (an older Studio Hub).
   */
  pause_parameters?: Array<{
    name: 'paragraph_pause_sec' | 'sentence_pause_sec'
    minimum: number | null
    maximum: number | null
    default: number | null
  }>
  /**
   * NOT published by GenStudio: the budget the Story Studio backend plans this
   * model's TTS requests at — `maximum_input_characters` less its own safety
   * margin. Computed server-side from the row above on every catalogue read, so
   * the margin exists in exactly one place. Optional only so an older cached
   * response cannot break the page.
   */
  planned_request_characters?: number
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string
  /** Gateway: false for free work. Optional — older catalogues omit it. */
  chargeable?: boolean
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
  /** The exact provider id whose selected models may browse this library. */
  provider_id: string
}

/**
 * `TTSQuoteResponse` — GenStudio's own figure for one exact script.
 *
 * Numerics are `number | null`, mirroring the backend shape exactly: `null`
 * means GenStudio's 200 quote did not publish that field. It is never a failed
 * call (those surface as an error) and never a zero. Do not `|| 0` any of these
 * for display — a substituted 0 on `credits` reads as free.
 */
export interface GenStudioTtsQuote {
  model_id?: string | null
  model_name?: string | null
  voice_id: string
  voice_tier: string
  billable_characters: number | null
  speed: number | null
  estimated_duration_ms: number | null
  maximum_input_characters: number | null
  credits: number | null
  credits_per_1000_characters: number | null
  price_version: string
  output_format: string
  chargeable: boolean
  generation_enabled: boolean
  notice: string
}

/** One TTS job Story Studio will submit, with GenStudio's figure for it. */
export interface GenStudioQuotedPart {
  section_slug: string
  section_label: string
  /** 1-based position of this job within its section. */
  part: number
  /** How many jobs that section is submitted as. */
  part_count: number
  characters: number
  credits: number
  billable_characters: number
  chargeable: boolean
  /** Null when GenStudio's 200 quote carried no duration for this job. */
  estimated_duration_ms: number | null
  price_version: string
  notice: string
}

/**
 * Every job an episode's narration will be submitted as, each priced by
 * GenStudio. `total_credits` is the sum of those returned figures and nothing
 * else — see `describeQuotedTotal` for how it must be labelled.
 *
 * When `quotable` is false the parts are unpriced and `unavailable_reason`
 * says why. `generation_unit_rejected` is the contract mismatch: GenStudio's
 * quote endpoint refused a request body its own TTS model publishes as
 * acceptable, so this narration cannot be quoted at all — the published rate
 * is all there honestly is.
 */
export interface GenStudioNarrationQuote {
  quotable: boolean
  parts: GenStudioQuotedPart[]
  part_count: number
  total_credits: number | null
  total_billable_characters: number | null
  chargeable: boolean
  unavailable_reason: 'quote_disabled' | 'generation_unit_rejected' | 'quote_failed' | null
  unavailable_detail: string
  unavailable_status: number | null
  unquotable_characters: number | null
  model_id: string
  model_name: string
  provider_name: string
  credits_per_1000_characters: number
  minimum_credits: number
  /**
   * The model's published per-request character ceiling, or `null` when
   * GenStudio published none.
   *
   * This was declared `number` and read with an unconditional
   * `.toLocaleString()`, so a published `null` would have crashed the narration
   * page rather than degraded it — which is why gateway-kh deliberately kept
   * publishing an invented `40,000` rather than `null`. The renderer handles
   * absence now, so the gateway can stop inventing one. `null` never means
   * zero, and nothing is calculated locally to replace it.
   */
  maximum_input_characters: number | null
  /**
   * Story Studio's own, not GenStudio's: the boundary these parts were actually
   * planned at, and the fraction of the published one held back to get there.
   */
  planned_request_characters?: number
  request_safety_margin?: number
  /** The control values that were actually priced, as the backend resolved them. */
  controls?: TtsControlValues
  section_count: number
}

/**
 * A voice GenStudio will actually run right now. `catalog_status` and
 * `generation_enabled` are published gates; a voice failing either is still
 * listed (so a saved selection is explicable) but cannot be generated with.
 */
export function voiceIsGenerable(voice: GenStudioVoice): boolean {
  return voice.generation_enabled !== false && voice.catalog_status === 'published'
}

/** What the Gateway calls its own shared voice library (voices any cloning model can use). */
export const GATEWAY_VOICE_LIBRARY = 'Gateway voice library'

/**
 * Where a voice really comes from, for display. A voice in the Gateway's shared library works with
 * every cloning model, so it is shown as "Gateway voice library" and never tied to the engine it was
 * first made with (older Gateways still publish "Studio Hub (this Mac) · Qwen3 TTS" for these).
 * Any other voice keeps the provider and engine exactly as published.
 */
export function voiceSourceText(voice: Pick<GenStudioVoice, 'id' | 'provider' | 'engine_name' | 'voice_tier'>): string {
  if (voice.provider === GATEWAY_VOICE_LIBRARY
    || (voice.voice_tier === 'custom' && voice.id.startsWith('studio-hub-local::'))) return GATEWAY_VOICE_LIBRARY
  return [...new Set([voice.provider, voice.engine_name].filter(Boolean) as string[])].join(' · ')
}

export function useGenStudioVoices() {
  const { get, post, del } = useApi()

  const models = ref<GenStudioTtsModel[]>([])
  const modelsLoading = ref(false)
  const modelsError = ref('')
  const modelsLoaded = ref(false)
  /**
   * Freshness of the rows above, as the server reported it. The generator page
   * shows these prices and character limits as fact, so it must be able to say
   * when they came from a copy the server kept through a service interruption
   * rather than from a live read.
   */
  const modelsStale = ref(false)
  const modelsLoadedAt = ref<number | null>(null)

  const voices = ref<GenStudioVoice[]>([])
  const voicesLoading = ref(false)
  const voicesError = ref('')
  /** Which model the loaded voices belong to. Cleared on every model change. */
  const voicesModelId = ref<string | null>(null)

  const libraries = ref<GenStudioVoiceLibrary[]>([])
  let modelLoadRevision = 0
  /**
   * Same guard as `modelLoadRevision`, for the voice list. Selecting model B
   * while model A's read is still in flight must leave B's voices on screen:
   * without a revision, A's late reply (or its late failure) writes over B —
   * `voicesModelId` included, which `setSaved` reads to scope a save. Bumped
   * by every `loadVoices` and by `clearVoices`, so a list that was deliberately
   * emptied or blanked cannot be refilled by a read it abandoned.
   */
  let voiceLoadRevision = 0

  async function loadModels(): Promise<void> {
    const revision = ++modelLoadRevision
    modelsLoading.value = true
    modelsError.value = ''
    // A key/base-URL change can make every previous row belong to another
    // account. Keep the saved id in the form, but clear its old catalog facts
    // until this fresh display-only read resolves.
    models.value = []
    modelsLoaded.value = false
    modelsStale.value = false
    modelsLoadedAt.value = null
    try {
      const data = await get<{
        models?: GenStudioTtsModel[]
        freshness?: { stale?: boolean; ageMs?: number }
      }>('/app-settings/genstudio/tts-models', { cache: 'no-store' })
      if (revision !== modelLoadRevision) return
      models.value = Array.isArray(data.models) ? data.models : []
      modelsStale.value = data.freshness?.stale === true
      modelsLoadedAt.value = Date.now() - (Number.isFinite(data.freshness?.ageMs) ? data.freshness!.ageMs as number : 0)
      modelsLoaded.value = true
    } catch (error: any) {
      if (revision !== modelLoadRevision) return
      models.value = []
      modelsStale.value = false
      modelsLoadedAt.value = null
      modelsError.value = error?.data?.detail || error?.message || 'The Gateway voice model catalogue is unavailable.'
    } finally {
      if (revision === modelLoadRevision) modelsLoading.value = false
    }
  }

  function clearVoices(): void {
    // The newest intent is "no voices": any read still in flight is abandoned.
    voiceLoadRevision++
    voicesLoading.value = false
    voices.value = []
    voicesModelId.value = null
    voicesError.value = ''
  }

  /**
   * GenStudio decides compatibility: `model_id` is its own filter, so Story
   * Studio never compares ids to guess which voices a model serves.
   *
   * A model id is REQUIRED. GenStudio scopes `/v1/voices` to a model and
   * refuses an unscoped list (ADR-0016: voices are not portable across
   * engines), so an empty `modelId` used to produce a 422 that read as a broken
   * catalogue. It now short-circuits to the same message the backend gives,
   * without a round trip.
   */
  /**
   * `collection` is GenStudio's own vocabulary (`all` | `explore` | `my` |
   * `cloned`), forwarded verbatim. Which voices count as cloned is GenStudio's
   * to decide — Story Studio must never work it out from `custom_voice_id` or a
   * name, the same way it never infers any other published fact.
   */
  async function loadVoices(modelId: string, search = '', collection = ''): Promise<void> {
    const revision = ++voiceLoadRevision
    if (!modelId.trim()) {
      // This IS the newest load, and it is already finished: a read left in
      // flight for the previous model must not resurrect its list, and it must
      // not leave this state looking like it is still loading.
      voicesLoading.value = false
      voices.value = []
      voicesModelId.value = null
      voicesError.value = 'Choose a voice model first. The Gateway lists voices per model, '
        + 'so there is no voice catalogue to show until one is selected.'
      return
    }
    voicesLoading.value = true
    voicesError.value = ''
    try {
      const query = new URLSearchParams()
      query.set('model_id', modelId.trim())
      if (search.trim()) query.set('search', search.trim())
      if (collection.trim()) query.set('collection', collection.trim())
      const suffix = query.size ? `?${query.toString()}` : ''
      const data = await get<{ voices?: GenStudioVoice[] }>(
        `/app-settings/genstudio/voices${suffix}`,
        { cache: 'no-store' },
      )
      if (revision !== voiceLoadRevision) return
      voices.value = Array.isArray(data.voices) ? data.voices : []
      voicesModelId.value = modelId || null
    } catch (error: any) {
      if (revision !== voiceLoadRevision) return
      voices.value = []
      voicesModelId.value = null
      voicesError.value = error?.data?.detail || error?.message || 'Could not load voices from the Gateway.'
    } finally {
      if (revision === voiceLoadRevision) voicesLoading.value = false
    }
  }

  /**
   * GenStudio owns `is_saved`. The response carries the refreshed row, so the
   * list reflects what GenStudio now says rather than what was clicked.
   */
  async function setSaved(voiceId: string, saved: boolean): Promise<void> {
    const base = `/app-settings/genstudio/voices/${encodeURIComponent(voiceId)}/save`
    // The model this list was scoped by, so the backend can re-read the
    // refreshed row — GenStudio has no unscoped voice read to fall back on.
    const modelId = voicesModelId.value || ''
    const path = modelId ? `${base}?model_id=${encodeURIComponent(modelId)}` : base
    const response = saved
      ? await post<{ voice?: GenStudioVoice | null }>(path, modelId ? { model_id: modelId } : {})
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

  /**
   * GenStudio's exact figures for an episode's narration — one per TTS job it
   * will actually be submitted as.
   *
   * Deliberately episode-scoped rather than "quote this blob of text": the
   * backend re-derives the submitted requests with the same planner the
   * generator uses (normalization, section selection, the split at the selected
   * model's published `maximum_input_characters`), so the parts priced here are
   * the parts billed. Quoting a whole joined script would price a request that
   * is never sent.
   */
  async function quoteNarration(
    projectSlug: string,
    episodeCode: string,
    request: {
      model: string
      voice: string
      speed?: number
      sections?: string
      /**
       * The same control values Generate will send. GenStudio prices controls,
       * so quoting without them would quote different work. Already resolved
       * against the selected model's published list by the caller.
       */
      controls?: TtsControlValues
    },
  ): Promise<GenStudioNarrationQuote> {
    return await post<GenStudioNarrationQuote>(
      `/projects/${projectSlug}/episodes/${encodeURIComponent(episodeCode)}/tts-quote`,
      request,
    )
  }

  return {
    models,
    modelsLoading,
    modelsError,
    modelsLoaded,
    modelsStale,
    modelsLoadedAt,
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
    quoteNarration,
  }
}
