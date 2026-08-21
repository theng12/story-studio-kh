/**
 * The canvas a render draws on — resolution AND aspect ratio (v1.4.15).
 *
 * Until now the assembler held four hardcoded canvases, all landscape, so the
 * only shape Story Studio could produce locally was 16:9. The image side has
 * offered 9:16 for a long time and a Format can already declare
 * `imagePrompts.recommendedAspect: '9:16'`, which meant a project could
 * generate portrait scene images and then have them letterboxed into a
 * landscape frame with no warning. There was no way to make a Short.
 *
 * ── Why there is no table of canvases ──
 *
 * The owner's standing rule is that anything a future him would want different
 * is data he owns, not a constant. A table of `(resolution × ratio) → w×h`
 * would be exactly the constant he could not change: adding 4:5 for Instagram
 * would mean four new rows and a code release.
 *
 * So there is no table. A resolution tier names its SHORT EDGE in pixels — the
 * number people actually mean by "1080p" — and the aspect ratio is a plain
 * `W:H` string that is parsed, not matched. The canvas falls out of the two.
 * Any ratio anyone can write works, including ones nobody has thought of yet,
 * and the picker list in the UI is a convenience rather than a constraint.
 *
 * The four landscape canvases this replaces come out byte-identical:
 *   720p  16:9 → 1280×720      1440p 16:9 → 2560×1440
 *   1080p 16:9 → 1920×1080     4k    16:9 → 3840×2160
 * which is why every render saved before this release still renders the same
 * frame. `render-canvas.test.ts` pins that.
 */

/**
 * Resolution tier → its SHORT edge in pixels.
 *
 * The short edge is the ratio-independent half of "1080p": a 1080p landscape
 * video is 1080 tall, a 1080p vertical video is 1080 wide, and both carry the
 * same amount of picture across the narrow dimension. Deriving the long edge
 * from the ratio is what lets a new ratio cost nothing.
 */
const SHORT_EDGE: Record<string, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '4k': 2160,
}

export const DEFAULT_RESOLUTION = '1080p'
export const DEFAULT_ASPECT_RATIO = '16:9'

export interface RenderCanvas {
  w: number
  h: number
}

/**
 * `"9:16"` → `{ w: 9, h: 16 }`. Also accepts `16x9`, `16/9` and decimals like
 * `1.85:1`, because those are all shapes a person reasonably types.
 *
 * Returns null for anything that is not a positive ratio, so callers can fall
 * back deliberately rather than encoding a guess here.
 */
export function parseAspectRatio(value?: string | null): RenderCanvas | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i)
  if (!match) return null
  const w = Number(match[1])
  const h = Number(match[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

/** True when the string names a ratio this renderer can draw. */
export function isSupportedAspectRatio(value?: string | null): boolean {
  return parseAspectRatio(value) !== null
}

/** Round up to the nearest even number — yuv420p cannot carry an odd edge. */
function even(value: number): number {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded + 1
}

/**
 * A frame of the given shape whose SHORT edge is `short` pixels.
 *
 * Separate from `resolveRenderCanvas` because the preview surfaces — the
 * transition picker, the motion/overlay picker, the subtitle style preview —
 * are not rendered at a resolution tier but must still follow the ratio the
 * episode will actually be rendered at. A landscape preview of an overlay that
 * will land in a portrait video is the "looks shipped" failure this release
 * exists to avoid.
 */
export function canvasForShortEdge(short: number, aspect?: string | null): RenderCanvas {
  const edge = Number.isFinite(short) && short > 1 ? short : SHORT_EDGE[DEFAULT_RESOLUTION]!
  const ratio = parseAspectRatio(aspect) ?? parseAspectRatio(DEFAULT_ASPECT_RATIO)!
  return ratio.w >= ratio.h
    ? { w: even((edge * ratio.w) / ratio.h), h: even(edge) }
    : { w: even(edge), h: even((edge * ratio.h) / ratio.w) }
}

/**
 * The frame a render will use.
 *
 * An unknown resolution falls back to 1080p and an unparseable ratio falls back
 * to 16:9, both silently — a render is not the place to refuse over a typo in a
 * preset saved by an older build. The request boundary validates the ratio and
 * says so out loud; this function's job is to always produce a legal frame.
 */
export function resolveRenderCanvas(resolution?: string | null, aspect?: string | null): RenderCanvas {
  return canvasForShortEdge(SHORT_EDGE[resolution || ''] ?? SHORT_EDGE[DEFAULT_RESOLUTION]!, aspect)
}

/**
 * The unit every piece of text on the frame is sized against.
 *
 * NOT the height, which is what the assembler used before this release. A
 * caption at `h/18` is 60px on a 1920×1080 frame and 107px on a 1080×1920 one —
 * the same fraction of a dimension that has swapped roles, so portrait captions
 * came out nearly twice as large relative to the width they have to fit inside.
 * The short edge is the same number for every landscape canvas (there `h` IS
 * the short edge, so nothing that shipped changes) and the right one for the
 * other shapes.
 */
export function frameTextUnit(w: number, h: number): number {
  return Math.min(w, h)
}

/**
 * What to CALL the render's shape.
 *
 * The chosen string wins when it parses, because reducing it can rename it: a
 * 21:9 canvas is 2520×1080, which reduces to "7:3" — the same ratio under a
 * name nobody asked for, in a label right beside the picker that says 21:9.
 * Falls back to the reduction when nothing was chosen.
 */
export function displayAspectRatio(requested: string | null | undefined, w: number, h: number): string {
  return parseAspectRatio(requested) ? requested!.trim() : describeAspectRatio(w, h)
}

/** `1920×1080` → `'16:9'`, reduced. For describing a source, not choosing one. */
export function describeAspectRatio(w: number, h: number): string {
  if (!(w > 0) || !(h > 0)) return ''
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(Math.round(w), Math.round(h)) || 1
  return `${Math.round(w) / divisor}:${Math.round(h) / divisor}`
}

/**
 * How far apart two frame shapes are, as a fraction of the wider one.
 *
 * 16:9 against 9:16 is 0.68; 16:9 against 1.85:1 is 0.04. The threshold below
 * is what separates "a slightly different crop" from "this will be rendered
 * inside black bars", which is the only distinction the preflight warning needs
 * to draw.
 */
export function aspectDivergence(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return 0
  return Math.abs(a - b) / Math.max(a, b)
}

/**
 * Past this, a source is a different shape from the canvas rather than a
 * near-miss of it. 0.06 keeps 16:9 sources silent against 1.85:1 and 1.78:1
 * canvases (both under 0.05) while catching every portrait/landscape mismatch.
 */
export const ASPECT_MISMATCH_THRESHOLD = 0.06
