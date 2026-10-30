/**
 * Can this browser actually draw that family?
 *
 * A picker row can set `font-family` and hope, but an unknown family silently
 * falls back to the UI font — the row would then show a face the customer is
 * not getting, which is the quiet version of the defect AGENTS §6 bans: "no
 * sample" and "could not tell" must never read as "here it is".
 *
 * So the sample is MEASURED, never assumed. Canvas text metrics say whether the
 * named faces resolve to something other than the fallback:
 *
 *   true  — the family draws as itself; show the sample
 *   false — measured miss; the row says "No sample yet"
 *   null  — no canvas to ask (headless); the caller shows the sample anyway,
 *           because "we could not measure" is not evidence of "no face"
 */

const PROBES = ['mmmmmmmmmmlli 0123', 'MMMMMMWWW iIl1'] as const

/** Two probes compared, so a family that happens to match one width does not read as missing. */
const FALLBACK_FONT = `400 72px 'story-studio-no-such-face', monospace`

/** What an unknown family becomes. Leaving these in would report every miss as a hit. */
const GENERIC = /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|-apple-system|ui-[a-z-]+)$/i

let context: CanvasRenderingContext2D | null | undefined
const confirmed = new Map<string, boolean>()

function ctx2d(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context
  context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  return context
}

/** The named faces of a stack: `Impact, 'Arial Black', sans-serif` → `Impact, 'Arial Black'`. */
function namedFaces(family: string): string {
  return family.split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(part => part && !GENERIC.test(part))
    .join(', ')
}

function widths(spec: string): number[] | null {
  const ctx = ctx2d()
  if (!ctx) return null
  return PROBES.map((probe) => {
    // An unparsable spec keeps the canvas' previous font instead of failing, so
    // reset first: a rejected family must measure as the fallback, not as the
    // family measured just before it.
    ctx.font = FALLBACK_FONT
    ctx.font = spec
    return ctx.measureText(probe).width
  })
}

export function fontSampleAvailable(family: string | null | undefined): boolean | null {
  if (!family?.trim()) return false
  const hit = confirmed.get(family)
  if (hit) return hit

  const fallback = widths(FALLBACK_FONT)
  if (!fallback) return null

  const faces = namedFaces(family)
  if (!faces) return false

  const target = widths(`400 72px ${faces}, monospace`)
  if (!target) return null
  const resolves = PROBES.some((_, i) => target[i] !== fallback[i])
  // Only a confirmed face is cached: fonts can be installed after the first
  // read, and a remembered miss would never be retried in this session.
  if (resolves) confirmed.set(family, true)
  return resolves
}
