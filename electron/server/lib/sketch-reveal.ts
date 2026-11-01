import { createHash } from 'crypto'

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
  return { ok: true, reveal: { style: raw.style, mix, ...(overrides ? { overrides } : {}) } }
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
  return createHash('sha256').update(JSON.stringify([reveal.style, reveal.mix, overrides])).digest('hex')
}

/**
 * Whether a scene's resolved type depends on the other scenes of its episode. Only a real Mix does:
 * a single style, or a pin, is answered by the scene's own id. A caller that cannot supply the
 * episode's ordered scenes is only ever allowed to skip it when this is false.
 */
export function sketchRevealNeedsScenes(reveal: SketchRevealSetting): boolean {
  return reveal.style === 'mix' && reveal.mix.length >= 2
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
 * Memoised on (episode, setting, ordered scene ids), because the freshness rule asks this question
 * once per scene of a review poll.
 */
export function resolveSketchRevealPlan(
  episodeId: string,
  sceneIds: readonly string[],
  reveal: SketchRevealSetting,
): ReadonlyMap<string, SketchRevealType> {
  const key = `${episodeId.trim().toUpperCase()}\n${sketchRevealFingerprint(reveal)}\n${sceneIds.join(',')}`
  const cached = planCache.get(key)
  if (cached) return cached
  const plan = new Map<string, SketchRevealType>()
  const types = reveal.style === 'mix' ? reveal.mix : [reveal.style]
  const k = types.length
  let previous: SketchRevealType | null = null
  for (const sceneId of sceneIds) {
    const pin = reveal.overrides?.[sceneId]
    let chosen: SketchRevealType
    if (pin) {
      chosen = pin
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

/** The one scene's type, when the setting does not need the rest of the episode. Null means it does. */
export function sketchRevealForSingleScene(reveal: SketchRevealSetting, sceneId: string): SketchRevealType | null {
  if (reveal.overrides?.[sceneId]) return reveal.overrides[sceneId]
  if (reveal.style === 'mix') return reveal.mix.length === 1 ? reveal.mix[0] : null
  return reveal.style
}

/** The words Motion Review shows for a resolved type. */
export const SKETCH_REVEAL_LABELS: Record<SketchRevealType, string> = {
  line: 'Line', buildup: 'Build-up', swipes: 'Swipes', patches: 'Patches', bloom: 'Bloom',
  colour: 'Colour it in', blueprint: 'Blueprint', chalkboard: 'Chalkboard', parchment: 'Old parchment',
  shadows: 'Shadows first', backtofront: 'Back to front', rough: 'Rough to fine',
}
