/**
 * The transcription language control — states, defaults, and what goes on the
 * wire.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN THE PAGE
 * ----------------------------------------------------
 * Story Studio's content is English **for now**. That is a product decision
 * the owner can reverse tomorrow ("i might change my mind tomorrow and support
 * 20 more languages"), so English is a DEFAULT here and nowhere a hardcode:
 * there is no `'en'` in a request type, in the backend catalogue shape, or on
 * any path the customer cannot override. The single place the preference is
 * written down is `DEFAULT_TRANSCRIPTION_LANGUAGE` below.
 *
 * THREE DISTINCT STATES, DELIBERATELY NOT COLLAPSED
 * -------------------------------------------------
 * - `published`     the model published the languages it accepts. Real picker.
 * - `unenumerated`  the model published a sentinel like "multilingual", but
 *                   no usable language list.
 * - `unpublished`   the model published no language information at all.
 *
 * Auto-detect is a separate capability. It is offered only when GenStudio
 * explicitly publishes it; otherwise Story Studio must not omit `language`.
 *
 * `supported_languages[]` now drives the picker. A model that publishes
 * neither a concrete language nor auto-detect has no valid submission state.
 */

/** The choice value meaning "send no `language` and let the model decide". */
export const AUTO_DETECT_LANGUAGE = 'auto'

/**
 * The language Story Studio's content is in TODAY. A default the customer can
 * change on the page and that round-trips through the subtitles preset — never
 * a floor, a ceiling, or a value any request path forces.
 */
export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'en'

/**
 * Values GenStudio puts in `TranscriptionModelResponse.language` that mean
 * "many, unenumerated" rather than naming one language.
 */
const UNENUMERATED_SENTINELS = new Set(['multilingual', 'multi', 'auto', 'any'])

export interface TranscriptionLanguageModel {
  display_name?: string
  language?: string
  supported_languages?: string[]
  supports_language_auto_detect?: boolean | null
}

export type TranscriptionLanguageMode = 'published' | 'unenumerated' | 'unpublished'

export interface TranscriptionLanguageOption {
  value: string
  label: string
}

export interface TranscriptionLanguageControl {
  mode: TranscriptionLanguageMode
  /** Auto-detect first when published, then the model's explicit languages. */
  options: TranscriptionLanguageOption[]
  /** Free-entry is deliberately unsupported: requests must be catalog-valid. */
  allowsFreeEntry: boolean
  /** The raw published string, for display. Empty when nothing was published. */
  publishedLanguage: string
  /** What GenStudio said about auto-detect, or null when it said nothing. */
  autoDetectPublished: boolean | null
}

/**
 * The language codes a model actually published, if any.
 *
 * A single concrete `language` string ("en") IS an enumerable list of one, and
 * is treated as such. A sentinel is not.
 */
export function publishedTranscriptionLanguages(
  model: TranscriptionLanguageModel | null | undefined,
): string[] {
  const list = Array.isArray(model?.supported_languages) ? model!.supported_languages : []
  const codes = list
    .map(code => (typeof code === 'string' ? code.trim() : ''))
    .filter(code => !!code && !UNENUMERATED_SENTINELS.has(code.toLowerCase()))
  if (codes.length) return Array.from(new Set(codes))
  const single = (model?.language || '').trim()
  if (single && !UNENUMERATED_SENTINELS.has(single.toLowerCase())) return [single]
  return []
}

/** The whole control state for one selected model. */
export function transcriptionLanguageControl(
  model: TranscriptionLanguageModel | null | undefined,
): TranscriptionLanguageControl {
  const codes = publishedTranscriptionLanguages(model)
  const publishedLanguage = (model?.language || '').trim()
  const mode: TranscriptionLanguageMode = codes.length
    ? 'published'
    : publishedLanguage
      ? 'unenumerated'
      : 'unpublished'
  return {
    mode,
    options: [
      ...(model?.supports_language_auto_detect === true
        ? [{ value: AUTO_DETECT_LANGUAGE, label: 'Auto-detect' }]
        : []),
      ...codes.map(code => ({ value: code, label: code })),
    ],
    allowsFreeEntry: false,
    publishedLanguage,
    autoDetectPublished: typeof model?.supports_language_auto_detect === 'boolean'
      ? model.supports_language_auto_detect
      : null,
  }
}

/**
 * The starting choice for a model the customer has not chosen a language for.
 *
 * The preferred language when GenStudio publishes it, then the first published
 * language. Auto-detect is only a fallback when the selected model publishes
 * that capability. Otherwise no selection is valid.
 */
export function defaultTranscriptionLanguage(
  model: TranscriptionLanguageModel | null | undefined,
  fallback: string = DEFAULT_TRANSCRIPTION_LANGUAGE,
): string {
  const codes = publishedTranscriptionLanguages(model)
  if (!codes.length) return model?.supports_language_auto_detect === true ? AUTO_DETECT_LANGUAGE : ''
  const match = codes.find(code => code.toLowerCase() === fallback.toLowerCase())
  return match || codes[0]!
}

/**
 * Whether a remembered choice (from a preset) is still published for the
 * model now selected.
 */
export function isTranscriptionLanguageUsable(
  choice: string,
  model: TranscriptionLanguageModel | null | undefined,
): boolean {
  const value = (choice || '').trim()
  if (!value) return false
  if (value === AUTO_DETECT_LANGUAGE) return model?.supports_language_auto_detect === true
  const codes = publishedTranscriptionLanguages(model)
  return codes.some(code => code.toLowerCase() === value.toLowerCase())
}

/**
 * The validated `language` field for a transcription request. Auto-detect is
 * implemented by omission only when the selected model publishes that flag.
 */
export function transcriptionLanguageRequestFields(
  choice: string,
  model: TranscriptionLanguageModel | null | undefined,
): { language?: string } {
  const value = (choice || '').trim()
  const label = model?.display_name || 'the selected transcription model'
  if (!value || value === AUTO_DETECT_LANGUAGE) {
    if (model?.supports_language_auto_detect === true) return {}
    throw new Error(`${label} has not published auto-detect. Select one of its published languages before transcription.`)
  }
  const published = publishedTranscriptionLanguages(model)
  const matched = published.find(code => code.toLowerCase() === value.toLowerCase())
  if (!matched) throw new Error(`${label} does not publish ${value} as a supported language.`)
  return { language: matched }
}
