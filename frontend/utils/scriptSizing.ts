export interface EpisodeSizingInput {
  suggestedChapters?: unknown
  suggestedLength?: unknown
  formatDefaultChapters?: unknown
  formatDefaultLengthMinutes?: unknown
  chapterCountRange?: unknown
  wordsPerMinute: number
}

export interface ScriptNarratorStyleOption {
  id: string
  label: string
  description: string
}

export interface ScriptFormatContext {
  id: string
  name: string
  summary: string
  defaultChapterCount: number | null
  defaultLengthMinutes: number | null
  /** 1.4.369 — a short-form Formula's own length, in seconds; supersedes the
   *  whole-minute fields wherever it is present. */
  defaultLengthSeconds: number | null
  lengthSecondsRange: [number, number] | null
  randomizeLength: boolean
  chapterCountRange: [number, number] | null
  lengthMinutesRange: [number, number] | null
  durationPresets: number[] | null
  defaultWordsPerMinute: number | null
  defaultWordsPerChapter: number | null
  narratorStyles: ScriptNarratorStyleOption[]
  defaultNarratorStyleId: string | null
}

export interface ScriptFormatRefreshState {
  selectedEpisodeCode: string
  sizingTouched: boolean
  chapters: number
  wordsPerChapter: number
  formatContext: ScriptFormatContext | null
}

const OPTIONAL_SCRIPT_SIZING_FIELDS = [
  'length',
  'chapters',
  'total_words',
  'words_per_chapter',
] as const

type ScriptSizingField = typeof OPTIONAL_SCRIPT_SIZING_FIELDS[number]
type ScriptSizingValues = Record<ScriptSizingField, number>

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * An episode length suggestion, in MINUTES.
 *
 * "45 min" is minutes; "37 s" and "1 min 5 s" are read by their own units.
 * 1.4.369 added the seconds forms because a Quote Shorts episode's length is
 * drawn in the 10–60 s range and stored on the episode as "37 s"; treating
 * that as 37 minutes is the kind of quiet misread this parser exists to stop.
 * A bare number stays minutes, which is what every older caller sends.
 */
export function parseSuggestedMinutes(value: unknown): number | null {
  if (typeof value === 'number') return positiveNumber(value)
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)]
  if (parts.length) {
    let seconds = 0
    for (const part of parts) {
      const amount = Number(part[1])
      if (!Number.isFinite(amount)) continue
      const unit = part[2]!.toLowerCase()
      if (unit.startsWith('h')) seconds += amount * 3600
      else if (unit.startsWith('m')) seconds += amount * 60
      else seconds += amount
    }
    const minutes = seconds / 60
    return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 10000) / 10000 : null
  }
  const match = text.match(/(\d+(?:\.\d+)?)/)
  return match ? positiveNumber(match[1]) : null
}

/** A length in seconds as the pages show it: "37 s", or "2 min 5 s". */
export function formatLengthSecondsLabel(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 90) return `${whole} s`
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}

export function effectiveFormatPathForEpisode(slug: string, episodeCode?: string): string {
  const base = `/projects/${slug}/effective-format`
  return episodeCode ? `${base}?episode_id=${encodeURIComponent(episodeCode)}` : base
}

export function canSubmitScriptOutline(input: {
  modelReady: boolean
  episodeId: string
  title: string
  sizingDeferred: boolean
  sizing: ScriptSizingValues
}): boolean {
  if (!input.modelReady || !input.episodeId || !input.title) return false
  return input.sizingDeferred || OPTIONAL_SCRIPT_SIZING_FIELDS.every((field) => {
    const value = input.sizing[field]
    return Number.isFinite(value) && value > 0
  })
}

export function scriptOutlineSubmissionParams(
  form: Record<string, unknown>,
  sizingDeferred: boolean,
): Record<string, unknown> {
  const params = { ...form }
  if (!sizingDeferred) return params
  for (const field of OPTIONAL_SCRIPT_SIZING_FIELDS) {
    const value = params[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) delete params[field]
  }
  return params
}

function descriptionSummary(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const trimmed = value.trim()
  const sentenceEnd = trimmed.search(/[.!?](\s|$)/)
  const firstSentence = sentenceEnd > 0 ? trimmed.slice(0, sentenceEnd + 1) : trimmed
  return firstSentence.length > 200 ? `${firstSentence.slice(0, 197)}…` : firstSentence
}

function pair(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'number' && typeof value[1] === 'number'
    ? [value[0], value[1]]
    : null
}

export function scriptFormatContextFromResponse(value: unknown): ScriptFormatContext | null {
  if (!value || typeof value !== 'object') return null
  const format = value as Record<string, unknown>
  if (!format.script || typeof format.script !== 'object') return null
  const script = format.script as Record<string, unknown>
  const durationPresets = Array.isArray(script.durationPresets)
    ? script.durationPresets.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0)
    : []
  const narratorStyles = Array.isArray(script.narratorStyles)
    ? script.narratorStyles.flatMap((item): ScriptNarratorStyleOption[] => {
        if (!item || typeof item !== 'object') return []
        const style = item as Record<string, unknown>
        if (typeof style.id !== 'string' || !style.id) return []
        return [{
          id: style.id,
          label: typeof style.label === 'string' && style.label ? style.label : style.id,
          description: typeof style.description === 'string' ? style.description : '',
        }]
      })
    : []
  const secondsRange = pair(script.lengthSecondsRange)
  return {
    id: typeof format.id === 'string' ? format.id : 'unknown',
    name: typeof format.name === 'string' ? format.name : 'Format',
    summary: descriptionSummary(format.description),
    defaultChapterCount: positiveNumber(script.defaultChapterCount),
    defaultLengthMinutes: positiveNumber(script.defaultLengthMinutes),
    defaultLengthSeconds: positiveNumber(script.defaultLengthSeconds),
    lengthSecondsRange: secondsRange,
    randomizeLength: script.randomizeLength === true,
    chapterCountRange: pair(script.chapterCountRange),
    lengthMinutesRange: pair(script.lengthMinutesRange),
    durationPresets: durationPresets.length ? durationPresets : null,
    defaultWordsPerMinute: positiveNumber(script.defaultWordsPerMinute),
    defaultWordsPerChapter: positiveNumber(script.defaultWordsPerChapter),
    narratorStyles,
    defaultNarratorStyleId: typeof script.defaultNarratorStyleId === 'string'
      ? script.defaultNarratorStyleId
      : null,
  }
}

export async function refreshScriptFormatState(options: {
  state: ScriptFormatRefreshState
  requestedEpisodeCode: string
  load: () => Promise<unknown>
  suggestedChapters?: unknown
  suggestedLength?: unknown
  chaptersPinned?: boolean
}): Promise<boolean> {
  const response = await options.load()
  if (options.requestedEpisodeCode !== options.state.selectedEpisodeCode) return false
  const context = scriptFormatContextFromResponse(response)
  if (!context) return false

  // Context is authoritative and must land before any WPM-based sizing.
  options.state.formatContext = context
  if (options.state.sizingTouched) return true

  const sizing = resolveEpisodeScriptSizing({
    suggestedChapters: options.chaptersPinned ? options.state.chapters : options.suggestedChapters,
    suggestedLength: options.suggestedLength,
    formatDefaultChapters: context.defaultChapterCount,
    // A seconds-precision Formula's own length is the fallback duration; the
    // whole-minute field is its long-form counterpart.
    formatDefaultLengthMinutes: context.defaultLengthSeconds !== null
      ? context.defaultLengthSeconds / 60
      : context.defaultLengthMinutes,
    chapterCountRange: options.chaptersPinned ? undefined : context.chapterCountRange,
    wordsPerMinute: context.defaultWordsPerMinute ?? 122,
  })
  if (!sizing) return true
  if (!options.chaptersPinned) options.state.chapters = sizing.chapters
  options.state.wordsPerChapter = parseSuggestedMinutes(options.suggestedLength) === null
    && context.defaultWordsPerChapter !== null
    ? context.defaultWordsPerChapter
    : sizing.wordsPerChapter
  return true
}

export function scriptDeepLinkQuery(input: {
  episodeCode: string
  title: string
  suggestedChapters?: unknown
  suggestedLength?: unknown
}): Record<string, string | number> {
  const minutes = parseSuggestedMinutes(input.suggestedLength)
  return {
    episode_id: input.episodeCode,
    title: input.title,
    ...(positiveNumber(input.suggestedChapters) !== null
      ? { chapters: Math.round(positiveNumber(input.suggestedChapters)!) }
      : {}),
    ...(minutes !== null ? { length: String(minutes) } : {}),
  }
}

export function resolveEpisodeScriptSizing(input: EpisodeSizingInput): {
  chapters: number
  wordsPerChapter: number
} | null {
  const formatDefaultChapters = positiveNumber(input.formatDefaultChapters)
  const suggestedChapters = positiveNumber(input.suggestedChapters)
  const range = Array.isArray(input.chapterCountRange) && input.chapterCountRange.length === 2
    ? [positiveNumber(input.chapterCountRange[0]), positiveNumber(input.chapterCountRange[1])]
    : null
  const suggestionFitsFormat = suggestedChapters !== null && (
    !range
    || range[0] === null
    || range[1] === null
    || (suggestedChapters >= range[0] && suggestedChapters <= range[1])
  )
  const chapters = Math.round(
    suggestionFitsFormat
      ? suggestedChapters!
      : (formatDefaultChapters ?? suggestedChapters ?? 10),
  )

  const durationMinutes = parseSuggestedMinutes(input.suggestedLength)
    ?? positiveNumber(input.formatDefaultLengthMinutes)
  if (durationMinutes === null) return null
  const wordsPerMinute = positiveNumber(input.wordsPerMinute) ?? 122

  return {
    chapters,
    // One rounding, over the division — exactly what the server does
    // (`lib/script-sizing.ts`). Rounding the total first would size a chapter
    // by a number the generator never uses.
    wordsPerChapter: Math.max(1, Math.round((durationMinutes * wordsPerMinute) / chapters)),
  }
}
