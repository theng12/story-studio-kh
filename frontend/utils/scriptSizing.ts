export interface EpisodeSizingInput {
  suggestedChapters?: unknown
  suggestedLength?: unknown
  formatDefaultChapters?: unknown
  formatDefaultLengthMinutes?: unknown
  chapterCountRange?: unknown
  wordsPerMinute: number
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

export function resolveEpisodeScriptSizing(input: EpisodeSizingInput): {
  chapters: number
  wordsPerChapter: number
} {
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
    ?? 45
  const wordsPerMinute = positiveNumber(input.wordsPerMinute) ?? 122
  const totalWords = Math.round(durationMinutes * wordsPerMinute)

  return {
    chapters,
    wordsPerChapter: Math.max(1, Math.round(totalWords / chapters)),
  }
}
