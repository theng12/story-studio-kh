/**
 * The Sketch Draw reveal style, as Motion Review edits it. The server owns the rule
 * (`electron/server/lib/sketch-reveal.ts` decides each scene's type, and freshness compares against
 * the same resolver); this only turns what the customer picked into a setting, or a plain sentence
 * saying what to fix, before anything is sent.
 *
 * The style is channel-wide reusable configuration with NO episode-level override, so unlike the
 * pen and the hold there is nothing here about "this episode's own" value.
 */
export const REVEAL_TYPES = ['line', 'buildup', 'swipes', 'patches', 'bloom'] as const
export type SketchRevealType = (typeof REVEAL_TYPES)[number]
export type SketchRevealStyle = SketchRevealType | 'mix'

export interface SketchReveal {
  style: SketchRevealStyle
  /** Read only when `style` is `mix`: 2–5 distinct types. */
  mix: SketchRevealType[]
  /** Optional per-scene pins, keyed by scene id. Editable only through the API today. */
  overrides?: Record<string, SketchRevealType>
}

/** `''` is not a style: it means the channel has never chosen, so every clip keeps its reveal. */
export type RevealChoice = '' | SketchRevealStyle

export const REVEAL_MIN_MIX = 2
export const REVEAL_MAX_MIX = REVEAL_TYPES.length

export const REVEAL_LABELS: Record<SketchRevealType, string> = {
  line: 'Line', buildup: 'Build-up', swipes: 'Swipes', patches: 'Patches', bloom: 'Bloom',
}

/** What the customer picked: null for "not chosen", a setting, or the sentence to show. */
export function revealFromDraft(choice: RevealChoice, mix: SketchRevealType[]): { ok: true; reveal: SketchReveal | null } | { ok: false; error: string } {
  if (choice === '') return { ok: true, reveal: null }
  if (choice !== 'mix') return { ok: true, reveal: { style: choice, mix: [] } }
  const picked = REVEAL_TYPES.filter(type => mix.includes(type))
  if (picked.length < REVEAL_MIN_MIX) return { ok: false, error: `A Mix needs at least ${REVEAL_MIN_MIX} styles.` }
  if (picked.length > REVEAL_MAX_MIX) return { ok: false, error: `A Mix can hold at most ${REVEAL_MAX_MIX} styles.` }
  return { ok: true, reveal: { style: 'mix', mix: picked } }
}

/** The words for a setting, used in the select and the help line. */
export function revealLabel(reveal: SketchReveal | null): string {
  if (!reveal) return 'not chosen'
  if (reveal.style !== 'mix') return REVEAL_LABELS[reveal.style]
  return `Mix: ${reveal.mix.map(type => REVEAL_LABELS[type]).join(', ')}`
}

/** The mix checkboxes as loaded; a single style leaves the usual starting set. */
export function revealMixDraft(reveal: SketchReveal | null): SketchRevealType[] {
  return reveal?.style === 'mix' ? [...reveal.mix] : ['line', 'buildup', 'swipes']
}

/** Which select option a stored setting shows. */
export function revealChoiceOf(reveal: SketchReveal | null): RevealChoice {
  return reveal ? reveal.style : ''
}
