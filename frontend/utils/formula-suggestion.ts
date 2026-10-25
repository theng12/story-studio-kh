/**
 * A suggested Series Formula for a channel that never chose one.
 *
 * Owner mapping, 2026-10-25. The suggestion is an EDITORIAL RECOMMENDATION, not
 * an assignment: nothing here writes to a project. The prompt shows it beside
 * the full picker and the explicit Generic choice, and the customer decides.
 *
 * Two layers:
 *   1. the owner's named channels, matched by exact slug (his ruling);
 *   2. a small keyword fallback so a future channel with an evident subject
 *      gets a useful starting suggestion instead of nothing.
 *
 * A suggestion whose Formula is not installed is ignored by the caller rather
 * than shown as a dead button.
 */

export interface FormulaSuggestionInput {
  slug?: string | null
  name?: string | null
}

export interface FormulaSuggestion {
  formulaId: string
  /** One plain sentence: why this Formula, for this channel. */
  reason: string
}

const BY_SLUG: Readonly<Record<string, FormulaSuggestion>> = Object.freeze({
  'night-atlas-nature': {
    formulaId: 'com.storystudio.formula.sleep-history-compilation',
    reason: 'A night nature channel fits the slow, factual compilation that settles into sleep.',
  },
  'night-atlas-science': {
    formulaId: 'com.storystudio.formula.calm-science-for-sleep',
    reason: 'A sleep science channel fits the quiet, low-arousal explanation of how things work.',
  },
  'night-atlas-mythology': {
    formulaId: 'com.storystudio.formula.mythology-for-sleep',
    reason: 'A mythology sleep channel fits pantheons told as slow, settling stories.',
  },
  'wonder-in-ink': {
    formulaId: 'com.storystudio.formula.counted-explainer',
    reason: 'A whiteboard explainer fits the counted, visual explainer structure.',
  },
  'domnak-kmouch': {
    formulaId: 'com.storystudio.formula.khmer-folk-horror',
    reason: 'A Khmer dark-tales channel fits the Khmer Folk Horror Anthology.',
  },
  pronom: {
    formulaId: 'com.storystudio.formula.khmer-folk-horror',
    reason: 'A Khmer dark-painterly channel fits the Khmer Folk Horror Anthology.',
  },
})

const BY_NAME: ReadonlyArray<readonly [RegExp, FormulaSuggestion]> = Object.freeze([
  [/khmer|domnak|kmouch|pronom/i, {
    formulaId: 'com.storystudio.formula.khmer-folk-horror',
    reason: 'A Khmer dark-tales channel fits the Khmer Folk Horror Anthology.',
  }],
  [/mytholog|pantheon/i, {
    formulaId: 'com.storystudio.formula.mythology-for-sleep',
    reason: 'A mythology channel fits pantheons told as slow, settling stories.',
  }],
  [/science|cosmos|astronom|physics/i, {
    formulaId: 'com.storystudio.formula.calm-science-for-sleep',
    reason: 'A science channel fits the quiet, low-arousal explanation of how things work.',
  }],
  [/nature|wildlife|natural/i, {
    formulaId: 'com.storystudio.formula.sleep-history-compilation',
    reason: 'A nature channel fits the slow, factual compilation that settles into sleep.',
  }],
  [/ink|whiteboard|doodle|explain/i, {
    formulaId: 'com.storystudio.formula.counted-explainer',
    reason: 'A whiteboard explainer fits the counted, visual explainer structure.',
  }],
])

/** The suggested Formula for a channel, or null when nothing sensible matches. */
export function suggestFormulaForChannel(input: FormulaSuggestionInput): FormulaSuggestion | null {
  const slug = (input.slug || '').trim().toLowerCase()
  if (slug && BY_SLUG[slug]) return { ...BY_SLUG[slug] }
  const name = (input.name || '').trim()
  if (!name) return null
  for (const [pattern, suggestion] of BY_NAME) {
    if (pattern.test(name)) return { ...suggestion }
  }
  return null
}
