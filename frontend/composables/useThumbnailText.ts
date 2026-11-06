import { ref, computed, watch, onBeforeUnmount, getCurrentInstance, type Ref } from 'vue'
import type { ThumbnailFont, ThumbnailTextPreset, ThumbnailTextStyle, ThumbnailTextVariant, ThumbnailTextSuggestions, ThumbnailTextRenderRequest, ThumbnailTextRenderReport, ThumbnailTextLanguage, ThumbnailTextLanguageSettings } from '@shared/thumbnail-text'
import { useApi } from './useApi.js'
import { usePresets, DEFAULT_EXCLUDE_KEYS, type Preset } from './usePresets.js'
import { fontsForText, thumbnailTextStyleOnly, thumbnailTextReportValid } from '../utils/thumbnail-text.js'

export async function requestThumbnailTextPreview(path: string, body: ThumbnailTextRenderRequest, signal?: AbortSignal): Promise<{ url: string; report: ThumbnailTextRenderReport }> {
  const response = await fetch(`/api${path}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.detail || `Exact preview failed (${response.status}). Try again.`)
  }
  if (response.headers.get('Content-Type')?.includes('image/png')) {
    const header = response.headers.get('X-Thumbnail-Text-Report')
    if (!header) throw new Error('Exact preview did not include its render report. Try again.')
    const report = JSON.parse(header)
    return { url: URL.createObjectURL(await response.blob()), report }
  }
  const result = await response.json()
  if (typeof result.image_base64 !== 'string' || !result.image_base64 || !result.report) {
    throw new Error('Exact preview is incomplete. Try again.')
  }
  return { url: `data:image/png;base64,${result.image_base64}`, report: result.report }
}

export function useThumbnailText(scope: {
  slug: string
  episode: Ref<string>
  visible: Ref<boolean>
  /** THIS episode's own artwork, as the backend returns it. Membership in this
   *  list is what decides whether a source may be used — never a filename
   *  remembered from another episode (AGENTS §4). */
  sources: Ref<Array<{ filename: string }>>
  /** The file the page pointed the editor at (a pinned or clicked thumbnail). */
  initialSource: Ref<string>
}) {
  const { get, post, put } = useApi()
  const text = ref('')
  const source = ref('')
  const fonts = ref<ThumbnailFont[]>([])
  const builtins = ref<ThumbnailTextPreset[]>([])
  const presetEntries: Preset[] = []
  const style = ref<ThumbnailTextStyle | null>(null)
  const variants = ref<ThumbnailTextVariant[]>([])
  const suggestions = ref<ThumbnailTextSuggestions | null>(null)
  /** The channel's own audience language, read from the backend authority (never a local copy). */
  const channelLanguage = ref<ThumbnailTextLanguage | null>(null)
  /** This episode's own choice for its thumbnail text, or null to follow the channel language. */
  const languageOverride = ref<ThumbnailTextLanguage | null>(null)
  const exactUrl = ref('')
  const report = ref<ThumbnailTextRenderReport | null>(null)
  const error = ref('')
  const suggestionError = ref('')
  const notice = ref('')
  const loading = ref(false)
  const rendering = ref(false)
  const applying = ref(false)
  const suggesting = ref(false)
  const saved = ref<ThumbnailTextVariant | null>(null)
  let generation = 0
  let editRevision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const path = computed(() => `/projects/${scope.slug}/episodes/${encodeURIComponent(scope.episode.value)}/thumbnail-text`)
  /** The language the thumbnail text is actually written in: the override, else the channel's. */
  const effectiveLanguage = computed<ThumbnailTextLanguage | null>(() => languageOverride.value ?? channelLanguage.value)
  /** True when this episode has not overridden the language. */
  const followsChannel = computed(() => languageOverride.value === null)
  /** Ownership is looked up, never parsed out of a filename. */
  const owns = (filename: string) => !!filename && scope.sources.value.some(image => image.filename === filename)
  const availableFonts = computed(() => fontsForText(fonts.value, text.value))
  const selectedFont = computed(() => availableFonts.value.find(font => font.id === style.value?.font_id))
  const request = computed<ThumbnailTextRenderRequest | null>(() => style.value && source.value && text.value.trim()
    ? { source_filename: source.value, text: text.value, style: thumbnailTextStyleOnly(style.value) } : null)
  const canApply = computed(() => !!request.value && !!selectedFont.value && !loading.value && !rendering.value
    && !applying.value && thumbnailTextReportValid(report.value))
  const presets = usePresets<ThumbnailTextStyle>({
    slug: scope.slug, configKey: 'thumbnail_text', presetType: 'thumbnail-text',
    lastPresetKey: 'thumbnail_text_last_preset', builtInPresets: presetEntries,
    excludeKeys: [...DEFAULT_EXCLUDE_KEYS, 'text', 'source', 'source_filename'],
    snapshot: () => thumbnailTextStyleOnly(style.value!),
    apply: data => { style.value = thumbnailTextStyleOnly(data) },
  })
  const detail = (e: any) => e?.data?.detail || e?.message || 'Could not complete this action. Try again.'
  function clearPreview() {
    clearTimeout(timer)
    controller?.abort()
    if (exactUrl.value.startsWith('blob:')) URL.revokeObjectURL(exactUrl.value)
    exactUrl.value = ''
    report.value = null
    rendering.value = false
    editRevision++
  }
  async function loadVariants() {
    const current = generation
    const result = await get<ThumbnailTextVariant[]>(`${path.value}/variants`, { cache: 'no-store' })
    if (current === generation && scope.visible.value) variants.value = result
  }
  /**
   * Read the effective language and its source from the backend. The channel's language comes from
   * the one authority there, so a stale copy can never disagree with the rest of the app (§1).
   */
  async function loadLanguageSettings() {
    const current = generation
    const settings = await get<ThumbnailTextLanguageSettings>(`${path.value}/settings`, { cache: 'no-store' })
    if (current !== generation) return
    channelLanguage.value = settings.channel_language
    languageOverride.value = settings.override
  }
  /**
   * Choose a language for THIS episode's thumbnail text, or null to follow the channel again. Never
   * touches the channel's own language; the backend refuses if the episode folder is missing.
   */
  async function setLanguageOverride(language: ThumbnailTextLanguage | null) {
    const current = generation
    try {
      const settings = await put<ThumbnailTextLanguageSettings>(`${path.value}/settings`, { language })
      if (current !== generation) return
      channelLanguage.value = settings.channel_language
      languageOverride.value = settings.override
      notice.value = settings.override
        ? `Headline language set to ${settings.override === 'km' ? 'Khmer' : 'English'} for this episode's thumbnail text. The channel language is unchanged.`
        : 'Headline language follows the channel language again.'
    } catch (e) { if (current === generation) error.value = detail(e) }
  }
  async function initialize() {
    const current = generation
    loading.value = true
    try {
      const [fontList, looks] = await Promise.all([
        get<ThumbnailFont[]>('/thumbnail-text/fonts'), get<ThumbnailTextPreset[]>('/thumbnail-text/presets/builtin'),
      ])
      if (current !== generation) return
      fonts.value = fontList
      builtins.value = looks
      presetEntries.splice(0, presetEntries.length, ...looks.map(p => ({ id: p.id, name: p.name, data: p.style, builtin: true, type: 'thumbnail-text' as const })))
      if (!style.value) style.value = looks[0] ? thumbnailTextStyleOnly(looks[0].style) : null
      await presets.load()
      if (current !== generation) return
      // Not swallowed: a file that cannot be read must show as an error, never as "follows the
      // channel" — an unknown language and an absent one must not look the same (§6).
      await loadLanguageSettings()
      if (current !== generation) return
      await loadVariants()
    } catch (e) { if (current === generation) error.value = detail(e) }
    finally { if (current === generation) loading.value = false }
  }
  watch([scope.episode, scope.visible], ([episode, visible], old) => {
    generation++
    clearPreview()
    text.value = ''; source.value = ''; variants.value = []; suggestions.value = null
    // The language is this episode's own (or the channel's); the previous episode's must not stand.
    channelLanguage.value = null; languageOverride.value = null
    saved.value = null; error.value = ''; suggestionError.value = ''; applying.value = false; suggesting.value = false
    loading.value = false
    if (old?.[0] && old[0] !== episode) notice.value = 'Episode changed. Cleared the previous headline, source, suggestions, variants and previews. Choose this episode’s artwork to start again.'
    else notice.value = ''
    if (visible && episode) { resolveSource(); void initialize() }
  }, { immediate: true, flush: 'sync' })
  /**
   * Adopt the source the page pointed at ONLY when this episode actually owns
   * it. Runs after an episode change (with source blanked) and again whenever
   * the episode's own file list arrives, so the selection is restored when it
   * is derivable and stays blank when it is not — never the previous
   * episode's artwork (AGENTS §4).
   */
  function resolveSource() {
    if (source.value) {
      if (owns(source.value)) return
      source.value = ''
      clearPreview()
      notice.value = 'The selected artwork is no longer part of this episode. Source and preview cleared; choose replacement artwork.'
      return
    }
    if (owns(scope.initialSource.value)) source.value = scope.initialSource.value
  }
  watch(() => scope.sources.value, () => resolveSource(), { deep: true })
  watch(availableFonts, list => {
    if (!style.value || !list.length) return
    if (!list.some(font => font.id === style.value!.font_id)) {
      style.value.font_id = list[0].id
      notice.value = `Font changed to ${list[0].label} to cover this headline’s writing system.`
    }
    const font = list.find(font => font.id === style.value!.font_id)
    if (font && !font.weights.includes(style.value.weight)) style.value.weight = font.weights[0]
  }, { deep: true })
  watch(() => style.value?.font_id, () => {
    if (style.value && selectedFont.value && !selectedFont.value.weights.includes(style.value.weight)) style.value.weight = selectedFont.value.weights[0]
  })
  async function renderExact() {
    clearPreview()
    if (!scope.visible.value || !request.value || !selectedFont.value) return
    const current = generation, revision = editRevision, body = JSON.parse(JSON.stringify(request.value))
    controller = new AbortController()
    rendering.value = true
    error.value = ''
    try {
      const result = await requestThumbnailTextPreview(`${path.value}/preview`, body, controller.signal)
      if (current !== generation || revision !== editRevision) {
        if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url)
        return
      }
      exactUrl.value = result.url; report.value = result.report
    } catch (e: any) {
      if (current === generation && revision === editRevision && e?.name !== 'AbortError') error.value = detail(e)
    } finally { if (current === generation && revision === editRevision) rendering.value = false }
  }
  watch(request, () => {
    clearPreview(); saved.value = null
    if (request.value && scope.visible.value && selectedFont.value) {
      rendering.value = true
      timer = setTimeout(() => void renderExact(), 450)
    }
  }, { deep: true, flush: 'sync' })
  async function moreSuggestions() {
    if (suggesting.value) return
    const current = generation
    suggesting.value = true; suggestionError.value = ''
    try {
      const result = await post<ThumbnailTextSuggestions>(`${path.value}/suggestions`, {})
      if (current === generation) suggestions.value = result
    } catch (e) { if (current === generation) suggestionError.value = detail(e) }
    finally { if (current === generation) suggesting.value = false }
  }
  function chooseSuggestion(value: string) { text.value = value }
  async function apply(pin = false) {
    if (!canApply.value || !request.value) return
    const current = generation, revision = editRevision
    applying.value = true; error.value = ''
    try {
      const result = await post<ThumbnailTextVariant>(`${path.value}/apply`, { ...request.value, ...(pin ? { pin: true } : {}) })
      if (current !== generation) return
      await loadVariants()
      if (revision === editRevision) saved.value = result
      notice.value = pin ? `${result.filename} saved and pinned for upload.` : `${result.filename} saved as a separate text variant.`
      return result
    } catch (e) { if (current === generation) error.value = detail(e) }
    finally { if (current === generation) applying.value = false }
  }
  async function pinVariant(variant: ThumbnailTextVariant) {
    if (variant.stale) return
    const current = generation
    try {
      await post(`/projects/${scope.slug}/episodes/${encodeURIComponent(scope.episode.value)}/thumbnails/pin`, { filename: variant.filename, platform: 'youtube' })
      if (current !== generation) return
      notice.value = `${variant.filename} pinned for upload.`
      return variant
    } catch (e) { if (current === generation) error.value = detail(e) }
  }
  function reapply(variant: ThumbnailTextVariant, filenames: string[]) {
    saved.value = null
    text.value = variant.text
    source.value = filenames.includes(variant.source_filename) ? variant.source_filename : ''
    notice.value = source.value
      ? 'Restored this variant’s headline on the current artwork using the editor’s current look. Review the exact preview before applying.'
      : 'Restored the headline; its source artwork is missing. Choose replacement artwork and review the exact preview.'
  }
  async function presetAction(action: () => unknown) {
    try { await action() } catch (e) { error.value = detail(e) }
  }
  // Lifecycle hooks only exist under a component instance; the module is also
  // imported from plain node:test, which has none. Cleanup still happens in
  // the app, and the parent also closes the editor on navigation.
  if (getCurrentInstance()) onBeforeUnmount(() => { generation++; clearPreview() })
  return { text, source, style, fonts, availableFonts, selectedFont, builtins, presets, variants, suggestions, exactUrl, report,
    error, suggestionError, notice, loading, rendering, applying, suggesting, saved, canApply, initialize, renderExact,
    moreSuggestions, chooseSuggestion, apply, pinVariant, reapply, presetAction,
    channelLanguage, languageOverride, effectiveLanguage, followsChannel, setLanguageOverride }
}
