/**
 * Per-chapter word target from what the Formula publishes — never a constant.
 *
 * The Script form already sizes an episode this way on the client
 * (`frontend/utils/scriptSizing.ts`: length minutes × words-per-minute ÷
 * chapters). The server did not: an outline/expansion request that arrived
 * without an explicit `words_per_chapter` (a headless or Production API call —
 * the UI always sends it) fell through to a neutral 550 words per chapter. That
 * made a Quote Shorts episode target a 550-word chapter although its Formula
 * asks for a one-minute Short at 120 wpm (AGENTS.md §1: everything follows the
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
