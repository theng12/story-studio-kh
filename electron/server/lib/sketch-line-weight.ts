/**
 * The Sketch Draw line weight: how heavy the ink is drawn.
 *
 *   thin    a light drawing
 *   normal  the engine's own weight — what every clip drawn before this setting existed was
 *           drawn with, byte for byte
 *   bold    a heavy drawing
 *
 * A SELECTION, never a number copied from anywhere: the engine owns the widths, and this module
 * only names which of its three weights a clip is drawn with. ABSENT means NORMAL, so a channel
 * and an episode that have never chosen one keep every clip they have — the same way the reveal's
 * absent style keeps the clips it has.
 *
 * No dependencies: the backend, the freshness rule, the generator and the native-helper job all
 * import this one definition.
 */
export const SKETCH_LINE_WEIGHTS = ['thin', 'normal', 'bold'] as const
export type SketchLineWeight = (typeof SKETCH_LINE_WEIGHTS)[number]

/** What a channel or an episode that never chose one draws with. */
export const DEFAULT_SKETCH_LINE_WEIGHT: SketchLineWeight = 'normal'

export function isSketchLineWeight(value: unknown): value is SketchLineWeight {
  return typeof value === 'string' && (SKETCH_LINE_WEIGHTS as readonly string[]).includes(value)
}

/** A valid weight, or a plain sentence saying what to fix. */
export function parseSketchLineWeight(value: unknown): { ok: true; weight: SketchLineWeight } | { ok: false; error: string } {
  if (isSketchLineWeight(value)) return { ok: true, weight: value }
  return { ok: false, error: 'Choose a line weight: thin, normal or bold.' }
}

/**
 * The channel's saved weight. ABSENT heals to the default; a stored value that does not parse is
 * an error to surface, never silently replaced by normal.
 */
export function sketchLineWeightSelection(value: unknown): SketchLineWeight {
  if (value === undefined || value === null) return DEFAULT_SKETCH_LINE_WEIGHT
  const parsed = parseSketchLineWeight(value)
  if ('error' in parsed) throw new Error(`The channel's saved Sketch Draw line weight is not valid. ${parsed.error}`)
  return parsed.weight
}
