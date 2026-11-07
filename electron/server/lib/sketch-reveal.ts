import { createHash } from 'crypto'

import { parseSketchHold, type SketchHoldSetting } from './sketch-hold.js'

/**
 * The Sketch Draw reveal style: how the finished drawing arrives — one style, or a Mix that gives
 * each scene a different one.
 *
 * A dependency-free leaf module on purpose. `services/scene-media-checkpoint.ts` needs the resolved
 * per-scene type when checking freshness, while the generator needs it when rendering, and neither
 * may import the other's queue lifecycle to get it. The resolver here is the ONE definition all
 * three call: the generator, the freshness rule, and Motion Review.
 *
 *   line      bold masses, outlines, interior detail, light tone, then colour sweeping in behind
 *   buildup   a loose pencil block-in, ink over it, hatching for tone, then colour
 *   swipes    six hand passes, each leaving a sharper layer; the one that sharpens rather than arrives
 *   patches   superpixels over colour and depth brush the picture in near-first
 *   bloom     pigment spreads from the near-and-detailed subject outward, with a wet edge
 *   colour    ink, then the picture coloured in colour group by colour group — the subject first
 *             when the scene has a depth map — and the ink eases out so the clip ends on the picture
 *
 * Mix is resolved per scene and NEVER persisted per scene: what the customer picks is the SET, and
 * each rendered clip records only the type it actually resolved to.
 */
export const SKETCH_REVEAL_TYPES = ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour', 'blueprint', 'chalkboard', 'parchment', 'shadows', 'backtofront', 'rough'] as const
export type SketchRevealType = (typeof SKETCH_REVEAL_TYPES)[number]

export const SKETCH_REVEAL_STYLES = [...SKETCH_REVEAL_TYPES, 'mix'] as const
export type SketchRevealStyle = (typeof SKETCH_REVEAL_STYLES)[number]

/** A mix of one type is not a mix; the ceiling is the number of styles that exist. */
export const SKETCH_REVEAL_MIN_MIX = 2
export const SKETCH_REVEAL_MAX_MIX = SKETCH_REVEAL_TYPES.length

export interface SketchRevealSetting {
  style: SketchRevealStyle
  /** Read only when `style` is `mix`: 2 or more distinct types, in the customer's order. */
  mix: SketchRevealType[]
  /**
   * Optional per-scene pins, keyed by the scene id the rest of the app uses. A pin wins over the
   * mix and above the single style, and is part of what a clip is compared against. A pin is a
   * deliberate editorial choice, so it stays valid even after the mix set moves away from it.
   */
  overrides?: Record<string, SketchRevealType>
  /**
   * The optional scene-type mode (owner, 2026-11-05: OFF by default, no type-to-look mappings
   * approved). Absent = off: every scene resolves exactly as it did before this field existed.
   * When on, each scene whose `subject_kind` names a rule draws with that rule's reveal and
   * closing hold; a scene with no rule, or a caller that cannot supply the scene's type, falls
   * through to the style/Mix above. A per-scene pin still wins over a type rule.
   */
  scene_types?: SketchSceneTypeRules
}

/** One scene type's rule: a reveal (a single style or a Mix pool) and/or a closing hold. */
export interface SketchSceneTypeRule {
  /** No `overrides` inside a type rule — pins are per scene and live on the setting itself. */
  reveal?: { style: SketchRevealStyle; mix: SketchRevealType[] }
  hold?: SketchHoldSetting
}

export interface SketchSceneTypeRules {
  /** The mode switch. Absent or false = off, which is the default for every stored setting. */
  enabled: boolean
  /** Keyed by the channel scene-type id (a `subject_kind`, e.g. `interior`). Unknown ids never match. */
  rules: Record<string, SketchSceneTypeRule>
}

/** What a channel that has never opened the control renders with. Not what it is measured against. */
export const DEFAULT_SKETCH_REVEAL: SketchRevealSetting = { style: 'line', mix: [] }

const isType = (value: unknown): value is SketchRevealType =>
  typeof value === 'string' && (SKETCH_REVEAL_TYPES as readonly string[]).includes(value)
const isStyle = (value: unknown): value is SketchRevealStyle =>
  typeof value === 'string' && (SKETCH_REVEAL_STYLES as readonly string[]).includes(value)

/** A valid setting, or a plain sentence saying what to fix. Unknown keys are ignored, never trusted. */
export function parseSketchReveal(value: unknown): { ok: true; reveal: SketchRevealSetting } | { ok: false; error: string } {
  const raw = (value ?? null) as Record<string, unknown> | null
  const bad = (error: string) => ({ ok: false as const, error })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('Choose a valid reveal style or a Mix of styles.')
  }
  if (!isStyle(raw.style)) return bad('Choose a valid reveal style or a Mix of styles.')
  const mix: SketchRevealType[] = []
  if (raw.mix !== undefined && raw.mix !== null) {
    if (!Array.isArray(raw.mix)) return bad('A Mix needs a list of styles to choose from.')
    for (const entry of raw.mix) {
      if (!isType(entry)) return bad('A Mix may only contain valid reveal styles.')
      if (mix.includes(entry)) return bad('Each style may appear once in a Mix.')
      mix.push(entry)
    }
  }
  if (raw.style === 'mix' && (mix.length < SKETCH_REVEAL_MIN_MIX || mix.length > SKETCH_REVEAL_MAX_MIX)) {
    return bad(`A Mix needs between ${SKETCH_REVEAL_MIN_MIX} and ${SKETCH_REVEAL_MAX_MIX} styles.`)
  }
  let overrides: Record<string, SketchRevealType> | undefined
  if (raw.overrides !== undefined && raw.overrides !== null) {
    if (typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) return bad('Per-scene reveal pins must be a list of scenes.')
    for (const [sceneId, type] of Object.entries(raw.overrides as Record<string, unknown>)) {
      if (!sceneId.trim() || !isType(type)) return bad('Every per-scene reveal pin must name a scene and a real style.')
      overrides = overrides ?? {}
      overrides[sceneId] = type
    }
  }
  let sceneTypes: SketchSceneTypeRules | undefined
  if (raw.scene_types !== undefined && raw.scene_types !== null) {
    const container = raw.scene_types as Record<string, unknown>
    if (typeof container !== 'object' || Array.isArray(container)) return bad('Scene-type rules must be an object.')
    const rules: Record<string, SketchSceneTypeRule> = {}
    const rawRules = container.rules
    if (rawRules !== undefined && rawRules !== null) {
      if (typeof rawRules !== 'object' || Array.isArray(rawRules)) return bad('Scene-type rules must be keyed by scene type.')
      for (const [kind, entry] of Object.entries(rawRules as Record<string, unknown>)) {
        if (!kind.trim()) return bad('Every scene-type rule must name a scene type.')
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return bad('A scene-type rule must be an object.')
        const source = entry as Record<string, unknown>
        const rule: SketchSceneTypeRule = {}
        if (source.reveal !== undefined && source.reveal !== null) {
          const sub = source.reveal as Record<string, unknown>
          if (typeof sub !== 'object' || Array.isArray(sub) || !isStyle(sub.style)) return bad('A scene-type rule needs a valid reveal style.')
          const subMix: SketchRevealType[] = []
          if (sub.mix !== undefined && sub.mix !== null) {
            if (!Array.isArray(sub.mix)) return bad('A scene-type Mix needs a list of styles.')
            for (const item of sub.mix) {
              if (!isType(item)) return bad('A scene-type Mix may only contain valid reveal styles.')
              if (subMix.includes(item)) return bad('Each style may appear once in a scene-type Mix.')
              subMix.push(item)
            }
          }
          if (sub.style === 'mix' && (subMix.length < SKETCH_REVEAL_MIN_MIX || subMix.length > SKETCH_REVEAL_MAX_MIX)) {
            return bad(`A scene-type Mix needs between ${SKETCH_REVEAL_MIN_MIX} and ${SKETCH_REVEAL_MAX_MIX} styles.`)
          }
          rule.reveal = { style: sub.style, mix: subMix }
        }
        if (source.hold !== undefined && source.hold !== null) {
          const parsedHold = parseSketchHold(source.hold)
          if ('error' in parsedHold) return bad(parsedHold.error)
          rule.hold = parsedHold.hold
        }
        rules[kind] = rule
      }
    }
    // `enabled` defaults to false: OFF by default is the stored default, never inferred from rules
    // being present — a customer can keep rules drafted while the mode is switched off.
    sceneTypes = { enabled: container.enabled === true, rules }
  }
  return {
    ok: true,
    reveal: {
      style: raw.style,
      mix,
      ...(overrides ? { overrides } : {}),
      ...(sceneTypes ? { scene_types: sceneTypes } : {}),
    },
  }
}

/**
 * The channel's chosen style, or null when it has NEVER been chosen. Null is not "use the default":
 * it is the switch that keeps clips rendered before the control existed fresh, because a channel
 * that has asked for nothing cannot disagree with what it has. A stored value that does not parse
 * is an error to surface, never silently replaced.
 */
export function sketchRevealChoice(value: unknown): SketchRevealSetting | null {
  if (value === undefined || value === null) return null
  const parsed = parseSketchReveal(value)
  if ('error' in parsed) throw new Error(`The channel's saved Sketch Draw reveal style is not valid. ${parsed.error}`)
  return parsed.reveal
}

/** Identity of the setting; part of nothing on disk, only of the resolver's memo key. */
export function sketchRevealFingerprint(reveal: SketchRevealSetting): string {
  const overrides = reveal.overrides
    ? Object.keys(reveal.overrides).sort().map(id => [id, reveal.overrides![id]])
    : []
  const sceneTypes = reveal.scene_types
    ? [
        reveal.scene_types.enabled,
        Object.keys(reveal.scene_types.rules)
          .sort()
          .map(kind => {
            const rule = reveal.scene_types!.rules[kind]
            return [kind, rule.reveal ?? null, rule.hold ?? null]
          }),
      ]
    : null
  return createHash('sha256').update(JSON.stringify([reveal.style, reveal.mix, overrides, sceneTypes])).digest('hex')
}

/**
 * Whether a scene's resolved type depends on the other scenes of its episode. Only a real Mix does:
 * a single style, or a pin, is answered by the scene's own id. A caller that cannot supply the
 * episode's ordered scenes is only ever allowed to skip it when this is false. An enabled scene-type
 * rule whose own reveal is a Mix counts — its scenes also need the ordered plan.
 */
export function sketchRevealNeedsScenes(reveal: SketchRevealSetting): boolean {
  if (reveal.style === 'mix' && reveal.mix.length >= 2) return true
  const rules = sceneTypeRulesFor(reveal)
  if (!rules) return false
  return Object.values(rules.rules).some(rule => rule.reveal?.style === 'mix' && rule.reveal.mix.length >= 2)
}

/**
 * The scene-type rules in force, or null when the mode is off — the default for every stored
 * setting, and the behaviour of every caller that has never heard of this feature.
 */
export function sceneTypeRulesFor(reveal: SketchRevealSetting | null | undefined): SketchSceneTypeRules | null {
  const rules = reveal?.scene_types
  if (!rules || !rules.enabled) return null
  return rules
}

/** The reveal a scene's type asks for, or null to fall through to the pin / style / Mix above. */
export function sceneTypeRevealFor(
  reveal: SketchRevealSetting | null | undefined,
  subjectKind: string | null | undefined,
): { style: SketchRevealStyle; mix: SketchRevealType[] } | null {
  if (!subjectKind) return null
  return sceneTypeRulesFor(reveal)?.rules[subjectKind]?.reveal ?? null
}

/** The closing hold a scene's type asks for, or null to fall through to the episode/channel hold. */
export function sceneTypeHoldFor(
  reveal: SketchRevealSetting | null | undefined,
  subjectKind: string | null | undefined,
): SketchHoldSetting | null {
  if (!subjectKind) return null
  return sceneTypeRulesFor(reveal)?.rules[subjectKind]?.hold ?? null
}

const SALT = 'sketch-reveal-v1'

/** A repeatable index in [0, k) for one scene of one episode. Only the episode and scene id feed it. */
function baseIndex(episodeId: string, sceneId: string, k: number): number {
  const digest = createHash('sha256').update(`${SALT}\n${episodeId.trim().toUpperCase()}\n${sceneId}`).digest()
  return digest.readUIntBE(0, 6) % k
}

const planCache = new Map<string, ReadonlyMap<string, SketchRevealType>>()
/** Test seam: forget memoised plans. */
export function resetSketchRevealPlanCache(): void { planCache.clear() }

/**
 * Scene id -> the reveal type that scene resolves to. `sceneIds` must be EVERY scene of the episode,
 * in plan order: the one way to satisfy "purity" and "no two consecutive scenes share a type" is to
 * resolve in order and look at the previous scene's resolved type. That is still a pure function of
 * the episode and its ordered scene ids, which is what determinism needs — adding or renumbering
 * scenes invalidates the episode anyway, because every clip's window and source image move too.
 *
 * Memoised on (episode, setting, ordered scene ids, and — when the scene-type mode is on — the
 * scene types), because the freshness rule asks this question once per scene of a review poll.
 *
 * `kinds` maps scene id -> the scene's `subject_kind`. It is optional: without it, or with the mode
 * off, the plan is byte-for-byte the one this function has always produced. Precedence is
 * per scene: pin > scene-type rule > style/Mix.
 */
export function resolveSketchRevealPlan(
  episodeId: string,
  sceneIds: readonly string[],
  reveal: SketchRevealSetting,
  kinds?: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, SketchRevealType> {
  const rules = sceneTypeRulesFor(reveal)
  const usesKinds = Boolean(rules && kinds)
  const key =
    `${episodeId.trim().toUpperCase()}\n${sketchRevealFingerprint(reveal)}\n${sceneIds.join(',')}` +
    (usesKinds ? `\n${sceneIds.map(id => kinds![id] ?? '').join(',')}` : '')
  const cached = planCache.get(key)
  if (cached) return cached
  const plan = new Map<string, SketchRevealType>()
  const types = reveal.style === 'mix' ? reveal.mix : [reveal.style]
  const k = types.length
  let previous: SketchRevealType | null = null
  for (const sceneId of sceneIds) {
    const pin = reveal.overrides?.[sceneId]
    const typeRule = usesKinds ? sceneTypeRevealFor(reveal, kinds![sceneId]) : null
    let chosen: SketchRevealType
    if (pin) {
      chosen = pin
    } else if (typeRule) {
      if (typeRule.style === 'mix') {
        // The type's own pool, resolved the same deterministic way as the episode's Mix.
        const pool = typeRule.mix
        chosen = pool[baseIndex(episodeId, sceneId, pool.length)]
        if (pool.length >= 2 && chosen === previous) chosen = pool[(pool.indexOf(chosen) + 1) % pool.length]
      } else {
        chosen = typeRule.style
      }
    } else if (reveal.style !== 'mix') {
      chosen = reveal.style
    } else {
      chosen = types[baseIndex(episodeId, sceneId, k)]
      // Two consecutive scenes never share a type when more than one is picked. One bump always
      // suffices: the collision test compares against the very type we are about to repeat.
      if (k >= 2 && chosen === previous) chosen = types[(types.indexOf(chosen) + 1) % k]
    }
    plan.set(sceneId, chosen)
    previous = chosen
  }
  planCache.set(key, plan)
  if (planCache.size > 64) planCache.delete(planCache.keys().next().value as string)
  return plan
}

/**
 * The one scene's type, when the setting does not need the rest of the episode. Null means it does.
 * `subjectKind` lets an enabled scene-type rule answer on its own; without it the rule cannot apply,
 * exactly like a caller that cannot supply the ordered scenes.
 */
export function sketchRevealForSingleScene(
  reveal: SketchRevealSetting,
  sceneId: string,
  subjectKind?: string | null,
): SketchRevealType | null {
  if (reveal.overrides?.[sceneId]) return reveal.overrides[sceneId]
  const typeRule = sceneTypeRevealFor(reveal, subjectKind)
  if (typeRule) {
    if (typeRule.style === 'mix') return typeRule.mix.length === 1 ? typeRule.mix[0] : null
    return typeRule.style
  }
  if (reveal.style === 'mix') return reveal.mix.length === 1 ? reveal.mix[0] : null
  return reveal.style
}

/** The words Motion Review shows for a resolved type. */
export const SKETCH_REVEAL_LABELS: Record<SketchRevealType, string> = {
  line: 'Line', buildup: 'Build-up', swipes: 'Swipes', patches: 'Patches', bloom: 'Bloom',
  colour: 'Colour it in', blueprint: 'Blueprint', chalkboard: 'Chalkboard', parchment: 'Old parchment',
  shadows: 'Shadows first', backtofront: 'Back to front', rough: 'Rough to fine',
}
