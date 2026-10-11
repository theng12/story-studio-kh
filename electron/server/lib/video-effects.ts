/**
 * Video Assembly's effect filters.
 *
 * v1.2.0: the three effects that are ALSO in the overlay registry — vignette,
 * letterbox bars, and the corner-logo anchor maths — no longer build their own
 * filters. They call the shared compiler in `lib/scene-effect-compiler.ts`, so
 * the Video Assembly checkbox and a registry overlay of the same name cannot
 * drift apart. Their emitted strings are unchanged, and
 * `__tests__/scene-effect-registry.test.ts` pins that against output captured
 * from v1.1.0.
 *
 * Colour grading and the aged-archive treatment stay here: they are not part
 * of the starter library and were not in this release's scope.
 */

import { anchorOverlayPosition, letterboxBarHeight, letterboxBars, letterboxFit, vignetteAngle } from './scene-effect-compiler.js'

/** Build the `:enable` suffix supported by FFmpeg's visual filters. */
export function buildGateEnable(start: number, end: number): string {
  const expression = buildGateExpression(start, end)
  return expression ? `:enable='${expression}'` : ''
}

/**
 * The same gate as a bare EXPRESSION, for callers that need to AND it with
 * another window. FFmpeg has no boolean `and`, so conjunction is a product of
 * two 0/1 expressions and the `:enable='…'` wrapper has to go on the outside.
 */
export function buildGateExpression(start: number, end: number): string {
  if (start > 0 && end > 0) return `between(t,${start.toFixed(2)},${end.toFixed(2)})`
  if (start > 0) return `gt(t,${start.toFixed(2)})`
  if (end > 0) return `lt(t,${end.toFixed(2)})`
  return ''
}

/** FFmpeg's vignette grows stronger as its lens angle approaches PI/2. */
export function computeVignetteAngle(strengthValue: unknown): number {
  const strength = Math.max(0, Math.min(Number(strengthValue) || 0, 1))
  return vignetteAngle(strength)
}

/**
 * Cinematic bars. `fit` (the default since 1.4.282) shrinks the whole picture
 * between them so nothing is hidden; `cover` draws them over the picture, which
 * hides its top and bottom — the look before 1.4.282, kept as an explicit choice.
 */
export function buildLetterboxFilter(
  inputLabel: string,
  outputLabel: string,
  width: number,
  height: number,
  ratioName: string,
  color: string,
  mode: 'fit' | 'cover' = 'fit',
): string | null {
  const barHeight = letterboxBarHeight(width, height, ratioName)
  if (barHeight <= 0) return null
  if (mode === 'cover') return `${inputLabel}${letterboxBars(barHeight, color)}${outputLabel}`
  return letterboxFit(inputLabel, outputLabel, width, height, barHeight, color, '', () => '')[0]!
}

/**
 * A procedural, asset-free old-film treatment.  It owns its grade, grain,
 * dust, scratches, flicker, and gate weave so enabling it never mutates the
 * separately selectable Video Assembly effects.
 */
export function buildAgedArchiveFilmFilters(opts: {
  input: string
  output: string
  grade: string
  noise: string
  marked: string
  base: string
  weave: string
  shifted: string
  width: number
  height: number
  strength: unknown
  gateSuffix?: string
}): string[] {
  const amount = Math.max(1, Math.min(100, Math.round(Number(opts.strength) || 45))) / 100
  const grain = Math.round(6 + amount * 16)
  const contrast = (1.02 + amount * 0.12).toFixed(3)
  const saturation = Math.max(0.18, 0.72 - amount * 0.26).toFixed(3)
  const flicker = (0.006 + amount * 0.018).toFixed(3)
  const crop = Math.max(2, Math.round(4 + amount * 12) * 2)
  const shift = Math.max(1, Math.round(1 + amount * 3))
  const gate = opts.gateSuffix || ''
  const scratchOpacity = (0.05 + amount * 0.13).toFixed(2)
  const dustOpacity = (0.08 + amount * 0.15).toFixed(2)
  const scratchX = Math.round(opts.width * 0.13)
  const scratchX2 = Math.round(opts.width * 0.77)
  const dustX = Math.round(opts.width * 0.58)
  const dustY = Math.round(opts.height * 0.31)

  return [
    `${opts.input}eq=brightness='${flicker}*sin(2*PI*t*8)':contrast=${contrast}:saturation=${saturation}:eval=frame${gate}${opts.grade}`,
    `${opts.grade}noise=alls=${grain}:allf=t+u${gate}${opts.noise}`,
    `${opts.noise}drawbox=x=${scratchX}:y=0:w=1:h=ih:color=white@${scratchOpacity}:t=fill${gate},` +
      `drawbox=x=${scratchX2}:y=0:w=1:h=ih:color=black@${scratchOpacity}:t=fill${gate},` +
      `drawbox=x=${dustX}:y=${dustY}:w=2:h=2:color=white@${dustOpacity}:t=fill${gate}${opts.marked}`,
    `${opts.marked}split=2${opts.base}${opts.weave}`,
    `${opts.weave}crop=w=iw-${crop}:h=ih-${crop}:x='${crop / 2}+${shift}*sin(2*PI*t*0.73)':y='${crop / 2}+${shift}*cos(2*PI*t*0.53)',` +
      `scale=${opts.width}:${opts.height}:flags=bilinear,setsar=1${opts.shifted}`,
    `${opts.base}${opts.shifted}overlay=0:0${gate}${opts.output}`,
  ]
}

/**
 * Colour grading moved to `lib/color-grade.ts` in v1.5 so the effect-library
 * compiler can build the same grade per scene without importing this module
 * (which imports the compiler). Re-exported so every caller is unchanged.
 */
export { buildColorGradingFilters } from './color-grade.js'

/**
 * Where the logo sits, as `overlay` filter coordinates.
 *
 * The nine named anchors are the registry's, shared with every overlay that
 * hangs off a corner — there is one implementation of this arithmetic now.
 * `custom` stays here because it is not an anchor at all: it is a literal
 * coordinate pair the customer typed, and only the Video Assembly logo control
 * offers it.
 */
/**
 * A custom logo X/Y is typed against the 1920×1080 preview (video-assembly.vue
 * `logoEffectPreviewStyle` places it at value/1920 and value/1080), so it is
 * scaled to the canvas being rendered and kept on it. Before 1.4.264 a 720p
 * render used the 1080p number as-is: TerraNash's x=1650 put the logo past the
 * right edge of a 1280-wide frame.
 */
export function scaleAuthoredPosition(value: number | undefined, canvasSpan: number, authoredSpan: number, size = 0): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(Math.max(0, canvasSpan - size), Math.round(value * canvasSpan / authoredSpan)))
}

export function calculateLogoPosition(
  position: string,
  margin: number,
  customX?: number,
  customY?: number,
): { x: string; y: string } {
  if (position === 'custom' && customX !== undefined && customY !== undefined) return { x: String(customX), y: String(customY) }
  return anchorOverlayPosition(position, margin)
}
