/**
 * The Sketch Draw reveal style, as Motion Review edits it. The server owns the rule
 * (`electron/server/lib/sketch-reveal.ts` decides each scene's type, and freshness compares against
 * the same resolver); this only turns what the customer picked into a setting, or a plain sentence
 * saying what to fix, before anything is sent.
 *
 * The style is THIS EPISODE's, stored beside its pen and hold; the channel value is only the
 * starting default for an episode that has none. Per-scene pins are keyed by scene id, so they are
 * episode state and are excluded from presets (AGENTS.md §5).
 */
export const REVEAL_TYPES = ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour'] as const
export type SketchRevealType = (typeof REVEAL_TYPES)[number]
export type SketchRevealStyle = SketchRevealType | 'mix'

export interface SketchReveal {
  style: SketchRevealStyle
  /** Read only when `style` is `mix`: 2–5 distinct types. */
  mix: SketchRevealType[]
  /** Optional per-scene pins, keyed by scene id. Episode-specific, so never saved into a preset. */
  overrides?: Record<string, SketchRevealType>
}

/** `''` is not a style: it means the channel has never chosen, so every clip keeps its reveal. */
export type RevealChoice = '' | SketchRevealStyle

export const REVEAL_MIN_MIX = 2
export const REVEAL_MAX_MIX = REVEAL_TYPES.length

export const REVEAL_LABELS: Record<SketchRevealType, string> = {
  line: 'Line', buildup: 'Build-up', swipes: 'Swipes', patches: 'Patches', bloom: 'Bloom',
  colour: 'Colour it in',
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

/**
 * The look a Motion Review preset may carry: the style and the mix set, never the per-scene pins.
 * A pin names one episode's scene ids, so a preset that stored them would hand them to whichever
 * episode is open next (AGENTS.md §4/§5).
 */
export function revealForPreset(reveal: SketchReveal | null): { style: SketchRevealStyle; mix: SketchRevealType[] } | null {
  return reveal ? { style: reveal.style, mix: [...reveal.mix] } : null
}

/**
 * Apply a preset's stored look to THIS episode's live reveal, keeping the episode's own pins.
 *
 * `usePresets` strips excluded keys on READ as well as write, so the pins are already gone from
 * `data` — which is why they are carried across explicitly from the live value rather than trusted
 * to survive the merge. A preset with no stored style leaves the live reveal alone.
 */
export function applyRevealPreset(data: unknown, live: SketchReveal | null): SketchReveal | null {
  const stored = (data ?? null) as Partial<SketchReveal> | null
  // A style that is not one of ours is a corrupt preset, not a value to send: the server would
  // refuse it and the page would sit in an error state over a look nobody chose.
  if (!stored || typeof stored.style !== 'string' || ![...REVEAL_TYPES, 'mix'].includes(stored.style)) return live
  const parsed = revealFromDraft(stored.style, Array.isArray(stored.mix) ? stored.mix : [])
  if (!parsed.ok || !parsed.reveal) return live
  return live?.overrides ? { ...parsed.reveal, overrides: { ...live.overrides } } : parsed.reveal
}
