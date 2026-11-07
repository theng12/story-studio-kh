/**
 * The Sketch Draw reveal style, as Motion Review edits it. The server owns the rule
 * (`electron/server/lib/sketch-reveal.ts` decides each scene's type, and freshness compares against
 * the same resolver); this only turns what the customer picked into a setting, or a plain sentence
 * saying what to fix, before anything is sent.
 *
 * The style is THIS EPISODE's, stored beside its pen and hold; the channel value is only the
 * starting default for an episode that has none. Per-scene pins are keyed by scene id, so they are
 * episode state and are excluded from presets (AGENTS.md §5). Scene-type rules key on TYPE ids,
 * which are channel-level editorial configuration, so they may ride a preset — but a preset that
 * carries none must not wipe the live ones (AGENTS.md §5's apply trap).
 */
import { holdFromDraft, type HoldDrafts, type SketchHold } from './sketch-hold'

export const REVEAL_TYPES: string[] = ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour']
export type SketchRevealType = string
export type SketchRevealStyle = SketchRevealType | 'mix'

/** One scene type's rule under the optional scene-type mode: its own reveal and/or closing hold. */
export interface SceneTypeRule {
  reveal?: { style: SketchRevealStyle; mix: SketchRevealType[] }
  hold?: SketchHold
}

export interface SceneTypeRules {
  /** OFF by default. Absent or false: every scene uses the episode's normal reveal. */
  enabled: boolean
  /** Keyed by the channel scene-type id (`subject_kind`). */
  rules: Record<string, SceneTypeRule>
}

export interface SketchReveal {
  style: SketchRevealStyle
  /** Read only when `style` is `mix`: 2–5 distinct types. */
  mix: SketchRevealType[]
  /** Optional per-scene pins, keyed by scene id. Episode-specific, so never saved into a preset. */
  overrides?: Record<string, SketchRevealType>
  /** The optional scene-type mode. Type ids are channel-level, so not episode-specific state. */
  scene_types?: SceneTypeRules
}

/**
 * The 13 approved scene types, mirrored from `electron/server/contracts/scene-image-rules.ts`
 * (`STARTING_SCENE_IMAGE_TYPES`) — the planner's starting set. A channel may edit its own list;
 * a rule naming a type the channel no longer has simply never matches, and is reported as
 * unavailable rather than silently rewritten.
 */
export const SCENE_TYPE_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'character_portrait', label: 'Character portrait' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'simple_map', label: 'Simple map' },
  { id: 'closeup_object', label: 'Close-up object' },
  { id: 'mood_symbolic', label: 'Mood/symbolic' },
  { id: 'character_in_place', label: 'Character in a place' },
  { id: 'group_crowd', label: 'Group/crowd' },
  { id: 'event_action', label: 'Event/action' },
  { id: 'interior', label: 'Interior' },
  { id: 'city_architecture', label: 'City/architecture' },
  { id: 'detailed_map', label: 'Detailed map' },
  { id: 'diagram_chart', label: 'Diagram/chart' },
  { id: 'document_writing', label: 'Document/writing' },
]

/** `''` is not a style: it means the channel has never chosen, so every clip keeps its reveal. */
export type RevealChoice = '' | SketchRevealStyle

export const REVEAL_MIN_MIX = 2
export let REVEAL_MAX_MIX = REVEAL_TYPES.length

export const REVEAL_LABELS: Record<SketchRevealType, string> = {
  line: 'Line', buildup: 'Build-up', swipes: 'Swipes', patches: 'Patches', bloom: 'Bloom',
  colour: 'Colour it in',
}

/** The engine is authoritative, including newly added reveals. */
export function setRevealCatalog(reveals: Array<{ id: string; label: string }>): void {
  REVEAL_TYPES.splice(0, REVEAL_TYPES.length, ...reveals.map(item => item.id))
  for (const item of reveals) REVEAL_LABELS[item.id] = item.label
  REVEAL_MAX_MIX = REVEAL_TYPES.length
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
  if (reveal.style !== 'mix') return REVEAL_LABELS[reveal.style] || reveal.style
  return `Mix: ${reveal.mix.map(type => REVEAL_LABELS[type] || type).join(', ')}`
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
 * The look a Motion Review preset (or "set as channel default") may carry: the style and the mix
 * set, never the per-scene pins — a pin names one episode's scene ids, so a preset that stored them
 * would hand them to whichever episode is open next (AGENTS.md §4/§5). Scene-type rules key on
 * type ids, which are reusable channel-level configuration, so they DO ride along.
 */
export function revealForPreset(reveal: SketchReveal | null): { style: SketchRevealStyle; mix: SketchRevealType[]; scene_types?: SceneTypeRules } | null {
  if (!reveal) return null
  return {
    style: reveal.style,
    mix: [...reveal.mix],
    ...(reveal.scene_types ? { scene_types: { enabled: reveal.scene_types.enabled, rules: { ...reveal.scene_types.rules } } } : {}),
  }
}

/**
 * Apply a preset's stored look to THIS episode's live reveal, keeping the episode's own pins.
 *
 * `usePresets` strips excluded keys on READ as well as write, so the pins are already gone from
 * `data` — which is why they are carried across explicitly from the live value rather than trusted
 * to survive the merge. A preset with no stored style leaves the live reveal alone. Scene-type rules
 * get the same explicit carry when the preset stores none: un-excluding them must not become a
 * wipe of the customer's live rules.
 */
export function applyRevealPreset(data: unknown, live: SketchReveal | null): SketchReveal | null {
  const stored = (data ?? null) as Partial<SketchReveal> | null
  // A style that is not one of ours is a corrupt preset, not a value to send: the server would
  // refuse it and the page would sit in an error state over a look nobody chose.
  if (!stored || typeof stored.style !== 'string' || ![...REVEAL_TYPES, 'mix'].includes(stored.style)) return live
  const parsed = revealFromDraft(stored.style, Array.isArray(stored.mix) ? stored.mix : [])
  if (!parsed.ok || !parsed.reveal) return live
  const next: SketchReveal = { ...parsed.reveal }
  if (live?.overrides) next.overrides = { ...live.overrides }
  const rules = stored.scene_types ?? live?.scene_types
  if (rules) next.scene_types = { enabled: rules.enabled === true, rules: { ...rules.rules } }
  return next
}

/** The scene-type rules in force: the episode's own when it has a reveal, else the channel's. */
export function effectiveSceneTypes(
  episode: SketchReveal | null,
  channel: SketchReveal | null,
): SceneTypeRules | null {
  return episode?.scene_types ?? channel?.scene_types ?? null
}

/** One row of the rules editor before it is turned back into a setting. */
export interface SceneTypeRuleDraft {
  /** `''` = no reveal override for this type; `'mix'` = its own pool; anything else = that style. */
  reveal: '' | SketchRevealStyle
  mix: SketchRevealType[]
  /** `''` = no hold override; otherwise the hold mode, never `'channel'` (a rule is not a fallback). */
  hold: '' | 'off' | 'auto' | 'fixed' | 'range'
  holdDrafts: HoldDrafts
}

function emptyRuleDraft(): SceneTypeRuleDraft {
  return { reveal: '', mix: ['line', 'buildup', 'swipes'], hold: '', holdDrafts: { fixed: '2.5', min: '1.5', max: '3' } }
}

/** The editor rows loaded from a stored setting: every type present, plus any row already edited. */
export function sceneTypeRuleDrafts(
  rules: SceneTypeRules | null | undefined,
  keep: Record<string, SceneTypeRuleDraft> = {},
): Record<string, SceneTypeRuleDraft> {
  const out: Record<string, SceneTypeRuleDraft> = {}
  for (const choice of SCENE_TYPE_CHOICES) {
    const stored = rules?.rules?.[choice.id]
    const draft = keep[choice.id] ?? emptyRuleDraft()
    if (stored) {
      draft.reveal = stored.reveal ? stored.reveal.style : ''
      draft.mix = stored.reveal?.style === 'mix' ? [...stored.reveal.mix] : [...draft.mix]
      if (stored.hold) {
        draft.hold = stored.hold.mode
        draft.holdDrafts = stored.hold.mode === 'fixed'
          ? { ...draft.holdDrafts, fixed: String(stored.hold.seconds) }
          : stored.hold.mode === 'range'
            ? { ...draft.holdDrafts, min: String(stored.hold.min_seconds), max: String(stored.hold.max_seconds) }
            : draft.holdDrafts
      } else {
        draft.hold = ''
      }
    } else if (!keep[choice.id]) {
      // A rule stored under a type the choices no longer list stays visible as unavailable.
      Object.assign(draft, emptyRuleDraft())
    }
    out[choice.id] = draft
  }
  // Types a channel once had but the starting list no longer carries: keep them editable, marked.
  if (rules?.rules) {
    for (const [kind, stored] of Object.entries(rules.rules)) {
      if (out[kind]) continue
      const draft = keep[kind] ?? emptyRuleDraft()
      draft.reveal = stored.reveal ? stored.reveal.style : ''
      if (stored.reveal?.style === 'mix') draft.mix = [...stored.reveal.mix]
      draft.hold = stored.hold?.mode ?? ''
      out[kind] = draft
    }
  }
  return out
}

/**
 * Turn the editor rows back into a setting. Empty rows drop out, so a type with neither a reveal
 * nor a hold is simply not a rule. A Mix with fewer than two styles, or a hold the server would
 * refuse, is an error to show — never a half-saved rule.
 */
export function sceneTypeRulesFromDrafts(
  enabled: boolean,
  drafts: Record<string, SceneTypeRuleDraft>,
): { ok: true; scene_types: SceneTypeRules } | { ok: false; error: string } {
  const rules: Record<string, SceneTypeRule> = {}
  for (const [kind, draft] of Object.entries(drafts)) {
    if (!kind.trim()) continue
    const rule: SceneTypeRule = {}
    if (draft.reveal === 'mix') {
      const picked = REVEAL_TYPES.filter(type => draft.mix.includes(type))
      if (picked.length < 2) return { ok: false, error: `The rule for ${kind} needs at least 2 styles in its Mix.` }
      rule.reveal = { style: 'mix', mix: picked }
    } else if (draft.reveal) {
      rule.reveal = { style: draft.reveal, mix: [] }
    }
    if (draft.hold) {
      const parsed = holdFromDraft(draft.hold, draft.holdDrafts)
      if ('error' in parsed) return { ok: false, error: `The hold rule for ${kind}: ${parsed.error}` }
      if (parsed.hold) rule.hold = parsed.hold
    }
    if (rule.reveal || rule.hold) rules[kind] = rule
  }
  return { ok: true, scene_types: { enabled, rules } }
}

/** Key-order-independent equality, so the dirty check never fires on serialization order alone. */
export function sceneTypesEqual(a: SceneTypeRules | null | undefined, b: SceneTypeRules | null | undefined): boolean {
  const normalize = (value: SceneTypeRules | null | undefined) =>
    value
      ? JSON.stringify({
          enabled: value.enabled,
          rules: Object.keys(value.rules)
            .sort()
            .map(kind => [kind, value.rules[kind].reveal ?? null, value.rules[kind].hold ?? null]),
        })
      : ''
  return normalize(a) === normalize(b)
}
