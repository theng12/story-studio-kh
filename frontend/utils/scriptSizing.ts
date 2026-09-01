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

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function parseSuggestedMinutes(value: unknown): number | null {
  if (typeof value === 'number') return positiveNumber(value)
  if (typeof value !== 'string') return null
  const match = value.match(/(\d+(?:\.\d+)?)/)
  return match ? positiveNumber(match[1]) : null
}

export function effectiveFormatPathForEpisode(slug: string, episodeCode?: string): string {
  const base = `/projects/${slug}/effective-format`
  return episodeCode ? `${base}?episode_id=${encodeURIComponent(episodeCode)}` : base
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
  return {
    id: typeof format.id === 'string' ? format.id : 'unknown',
    name: typeof format.name === 'string' ? format.name : 'Format',
    summary: descriptionSummary(format.description),
    defaultChapterCount: positiveNumber(script.defaultChapterCount),
    defaultLengthMinutes: positiveNumber(script.defaultLengthMinutes),
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
    formatDefaultLengthMinutes: context.defaultLengthMinutes,
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
  const totalWords = Math.round(durationMinutes * wordsPerMinute)

  return {
    chapters,
    wordsPerChapter: Math.max(1, Math.round(totalWords / chapters)),
  }
}
