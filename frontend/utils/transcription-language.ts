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
 * - `unenumerated`  the model published a sentinel like "multilingual": it can
 *                   do many, but GenStudio has not said which. Auto-detect
 *                   plus a free-entry code, clearly marked as unvalidated.
 * - `unpublished`   the model published no language information at all. Same
 *                   controls, DIFFERENT wording — this is missing data, not a
 *                   capability statement.
 *
 * Auto-detect is a separate thing again: a deliberate customer choice to let
 * the model decide. Rendering "auto-detect" and "we were told nothing" the
 * same way would make a gap in GenStudio's catalogue look like a decision
 * somebody made.
 *
 * WHEN GENSTUDIO SHIPS `supported_languages[]`
 * --------------------------------------------
 * `mode` flips to `published` on its own, the picker fills itself from the
 * catalogue, and the free-entry fallback disappears. No release, no code
 * change. See docs/genstudio-handoff/transcription-language-request.md.
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
  /** Auto-detect first, then whatever the model published. Never empty. */
  options: TranscriptionLanguageOption[]
  /** True only when nothing enumerable was published. */
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
    // Auto-detect is always offered, in every state — it is the one choice
    // that needs no catalogue support, because it is implemented by leaving
    // the field off the request entirely.
    options: [
      { value: AUTO_DETECT_LANGUAGE, label: 'Auto-detect' },
      ...codes.map(code => ({ value: code, label: code })),
    ],
    allowsFreeEntry: mode !== 'published',
    publishedLanguage,
    autoDetectPublished: typeof model?.supports_language_auto_detect === 'boolean'
      ? model.supports_language_auto_detect
      : null,
  }
}

/**
 * The starting choice for a model the customer has not chosen a language for.
 *
 * English when the model can take it (the current content), auto-detect when
 * the model published a list that does not include English — inventing a code
 * the model never published would be a guess.
 */
export function defaultTranscriptionLanguage(
  model: TranscriptionLanguageModel | null | undefined,
  fallback: string = DEFAULT_TRANSCRIPTION_LANGUAGE,
): string {
  const codes = publishedTranscriptionLanguages(model)
  if (!codes.length) return fallback
  const match = codes.find(code => code.toLowerCase() === fallback.toLowerCase())
  return match || AUTO_DETECT_LANGUAGE
}

/**
 * Whether a remembered choice (from a preset) still makes sense for the model
 * now selected. A published list is authoritative; a free-entry mode accepts
 * anything the customer typed, because it is explicitly unvalidated.
 */
export function isTranscriptionLanguageUsable(
  choice: string,
  model: TranscriptionLanguageModel | null | undefined,
): boolean {
  const value = (choice || '').trim()
  if (!value) return false
  if (value === AUTO_DETECT_LANGUAGE) return true
  const codes = publishedTranscriptionLanguages(model)
  if (!codes.length) return true
  return codes.some(code => code.toLowerCase() === value.toLowerCase())
}

/**
 * The `language` field for a transcription request — or nothing at all.
 *
 * Auto-detect is implemented by OMITTING the field. That is the whole
 * mechanism: there is no "auto" value on the wire, so a GenStudio model that
 * detects the language sees exactly the request it would have seen before this
 * control existed.
 */
export function transcriptionLanguageRequestFields(choice: string): { language?: string } {
  const value = (choice || '').trim()
  if (!value || value === AUTO_DETECT_LANGUAGE) return {}
  return { language: value }
}
