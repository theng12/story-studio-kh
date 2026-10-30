/**
 * Per-chapter word target from what the Formula publishes — never a constant.
 *
 * The Script form already sizes an episode this way on the client
 * (`frontend/utils/scriptSizing.ts`: length minutes × words-per-minute ÷
 * chapters). The server did not: an outline/expansion request that arrived
 * without an explicit `words_per_chapter` (a headless or Production API call —
 * the UI always sends it) fell through to a neutral 550 words per chapter. That
 * made a Quote Shorts episode target a 550-word chapter although its Formula
 * asks for a 45-second Short at 120 wpm (AGENTS.md §1: everything follows the
 * Formula).
 *
 * This is deliberately the same arithmetic, moved to one place both the outline
 * builder and single-chapter regeneration can call. WHEN the Formula publishes
 * no usable length or pace the caller keeps its old neutral default; this
 * function says "I could not work out the answer" with `null` rather than a
 * number that would read as a real target (§6).
 */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export interface FormulaWordTargetInput {
  /** The episode length in minutes (the request's choice, else the Formula's). */
  minutes?: unknown
  /** The Formula's published narration pace. */
  wordsPerMinute?: unknown
  /** Chapter count the words are divided across. */
  chapters?: unknown
}

/** `round(minutes × wordsPerMinute ÷ chapters)`, or `null` when the Formula
 *  does not publish enough to work it out. */
export function formulaWordsPerChapter(input: FormulaWordTargetInput): number | null {
  const minutes = positive(input.minutes)
  const wordsPerMinute = positive(input.wordsPerMinute)
  const chapters = positive(input.chapters)
  if (minutes === null || wordsPerMinute === null || chapters === null) return null
  return Math.max(1, Math.round((minutes * wordsPerMinute) / chapters))
}

/**
 * ONE sizing resolution for every script path — build, rebuild, expansion.
 *
 * THE DEFECT (2026-10-30, DM0021). Its outline was 20 chapters. A `force`
 * rebuild that carried only `force`, `model`, `title` and `episode_id` produced
 * 6 and said nothing: an outline BUILD reads the request, so the episode's own
 * recorded plan (its sidecar `total_chapters` + `generation_params`) was ignored
 * and the count fell through to the Formula's default. A rebuild is the same
 * episode, so its own sizing is its normal sizing; the Formula is the last
 * resort and the chosen source is logged.
 *
 * The chain per field is the request, this episode's existing outline, then the
 * Formula (expansion prefers the episode first, because that outline is what the
 * chapters must line up with). Word sizing stays chapters × words-per-chapter:
 * a per-chapter target, else the total divided, else the Formula's length × pace,
 * else the neutral default — exactly the order `formulaWordsPerChapter` documents.
 */
export interface ScriptSizingFields {
  chapters?: number | null
  length?: number | null
  total_words?: number | null
  words_per_chapter?: number | null
}

/** Where one sizing figure came from. `default` is the neutral fallback. */
export type ScriptSizingSource = 'request' | 'episode' | 'formula' | 'default'

export interface ScriptSizing {
  chapters: number
  length?: number
  wordsPerChapter: number
  totalWords: number
  sources: { chapters: ScriptSizingSource; length: ScriptSizingSource; words: ScriptSizingSource }
}

/** The last resort for a Formula that publishes no usable pace — see the
 *  header: it is a default with a reason, never a number derived from a ratio. */
export const NEUTRAL_WORDS_PER_CHAPTER = 550

export function resolveScriptSizing(input: {
  /** Which side wins when both name a figure. */
  prefer: 'request' | 'episode'
  requested: ScriptSizingFields
  /** This episode's own recorded plan, when it has one. */
  episode?: ScriptSizingFields | null
  formula: { chapters: number; length?: unknown; wordsPerMinute?: unknown }
}): ScriptSizing {
  const ordered: Array<{ source: ScriptSizingSource; fields: ScriptSizingFields | null | undefined }> = input.prefer === 'episode'
    ? [{ source: 'episode', fields: input.episode }, { source: 'request', fields: input.requested }]
    : [{ source: 'request', fields: input.requested }, { source: 'episode', fields: input.episode }]
  const pick = (field: keyof ScriptSizingFields): { value: number; source: ScriptSizingSource } | null => {
    for (const candidate of ordered) {
      const value = positive(candidate.fields?.[field])
      if (value !== null) return { value, source: candidate.source }
    }
    return null
  }

  const chaptersPick = pick('chapters')
  const chapters = chaptersPick?.value ?? Math.max(1, Math.round(Number(input.formula.chapters) || 1))
  const chaptersSource: ScriptSizingSource = chaptersPick?.source ?? 'formula'

  const lengthPick = pick('length')
  const formulaLength = positive(input.formula.length)
  const length = lengthPick?.value ?? formulaLength ?? undefined
  const lengthSource: ScriptSizingSource = lengthPick?.source ?? (formulaLength !== null ? 'formula' : 'default')

  const perChapterPick = pick('words_per_chapter')
  const totalPick = pick('total_words')
  let wordsPerChapter: number
  let wordsSource: ScriptSizingSource
  if (perChapterPick) {
    wordsPerChapter = Math.max(1, Math.floor(perChapterPick.value))
    wordsSource = perChapterPick.source
  } else if (totalPick) {
    wordsPerChapter = Math.max(1, Math.floor(totalPick.value / chapters))
    wordsSource = totalPick.source
  } else {
    const paced = formulaWordsPerChapter({ minutes: length, wordsPerMinute: input.formula.wordsPerMinute, chapters })
    wordsPerChapter = paced ?? NEUTRAL_WORDS_PER_CHAPTER
    wordsSource = paced !== null ? 'formula' : 'default'
  }

  return {
    chapters,
    length,
    wordsPerChapter,
    totalWords: totalPick?.value ?? wordsPerChapter * chapters,
    sources: { chapters: chaptersSource, length: lengthSource, words: wordsSource },
  }
}

/** The source in plain words, for the job log a person reads. */
export function describeScriptSizingSource(source: ScriptSizingSource): string {
  switch (source) {
    case 'request': return "from this run's request"
    case 'episode': return "from this episode's existing outline"
    case 'formula': return 'from the Series Formula'
    default: return 'from the neutral default (no usable formula figure)'
  }
}
