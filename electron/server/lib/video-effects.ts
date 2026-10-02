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

import type { VideoColorGrading } from '../models/types.js'
import { anchorOverlayPosition, letterboxBarHeight, letterboxBars, vignetteAngle } from './scene-effect-compiler.js'
import { buildColorbalanceStatements, type GraphIo } from './grade-balance.js'

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

/** Draw cinematic bars over the frame without scaling or cropping it. */
export function buildLetterboxFilter(
  inputLabel: string,
  outputLabel: string,
  width: number,
  height: number,
  ratioName: string,
  color: string,
): string | null {
  const barHeight = letterboxBarHeight(width, height, ratioName)
  if (barHeight <= 0) return null
  return `${inputLabel}${letterboxBars(barHeight, color)}${outputLabel}`
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

/** Keep this preset table aligned with the Video Assembly live preview. */
export function buildColorGradingFilters(cg: VideoColorGrading, gateSuffix: string, io: GraphIo): string[] {
  const presets: Record<string, { brightness: number; contrast: number; saturation: number; warmth: number; tint: number }> = {
    none: { brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0 },
    'warm-night': { brightness: -0.05, contrast: 1.1, saturation: 0.9, warmth: 0.15, tint: 0 },
    'cool-moonlight': { brightness: 0.02, contrast: 1.05, saturation: 0.8, warmth: -0.15, tint: -0.05 },
    cinematic: { brightness: -0.03, contrast: 1.2, saturation: 0.85, warmth: 0.05, tint: 0 },
    vintage: { brightness: 0.05, contrast: 0.95, saturation: 0.7, warmth: 0.2, tint: 0.05 },
    'dreamy-haze': { brightness: 0.08, contrast: 0.9, saturation: 0.75, warmth: 0.1, tint: 0.05 },
    'golden-hour': { brightness: 0.03, contrast: 1.1, saturation: 1.1, warmth: 0.25, tint: 0.02 },
    noir: { brightness: -0.1, contrast: 1.4, saturation: 0, warmth: 0, tint: 0 },
    firelight: { brightness: -0.05, contrast: 1.15, saturation: 1, warmth: 0.3, tint: 0 },
    'rainy-dusk': { brightness: -0.02, contrast: 1, saturation: 0.7, warmth: -0.1, tint: 0 },
    'lavender-mist': { brightness: 0.05, contrast: 0.95, saturation: 0.85, warmth: -0.05, tint: 0.08 },
    'forest-canopy': { brightness: -0.03, contrast: 1.1, saturation: 0.95, warmth: -0.05, tint: -0.05 },
    'desert-twilight': { brightness: 0.02, contrast: 1.05, saturation: 1.05, warmth: 0.18, tint: 0.04 },
    'ocean-depths': { brightness: -0.08, contrast: 1.15, saturation: 0.85, warmth: -0.2, tint: -0.03 },
    'sepia-dream': { brightness: 0, contrast: 1.05, saturation: 0.4, warmth: 0.15, tint: 0.05 },
    'frosted-glass': { brightness: 0.15, contrast: 0.85, saturation: 0.65, warmth: -0.05, tint: 0 },
    'autumn-glow': { brightness: 0, contrast: 1.1, saturation: 1.15, warmth: 0.2, tint: 0.03 },
    'starlit-night': { brightness: -0.1, contrast: 1.25, saturation: 0.6, warmth: -0.18, tint: -0.02 },
    'misty-morning': { brightness: 0.1, contrast: 0.9, saturation: 0.7, warmth: -0.08, tint: 0.02 },
  }
  const base = presets[cg.preset] || presets.none
  const brightness = base.brightness + (cg.brightness || 0)
  const contrast = base.contrast * (cg.contrast ?? 1)
  const saturation = base.saturation * (cg.saturation ?? 1)
  const warmth = base.warmth + (cg.warmth || 0)
  const tint = base.tint + (cg.tint || 0)
  const eqParts: string[] = []
  if (Math.abs(brightness) > 0.001) eqParts.push(`brightness=${brightness.toFixed(3)}`)
  if (Math.abs(contrast - 1) > 0.001) eqParts.push(`contrast=${contrast.toFixed(3)}`)
  if (Math.abs(saturation - 1) > 0.001) eqParts.push(`saturation=${saturation.toFixed(3)}`)

  // Warmth and tint used to be one `colorbalance`, by far the most expensive filter in the final pass. A two-input
  // `lut2` reproduces it from the same six amounts at under half the cost; see grade-balance.ts.
  const afterEq = eqParts.length ? io.allocLabel() : null
  const balance = (Math.abs(warmth) > 0.001 || Math.abs(tint) > 0.001)
    ? buildColorbalanceStatements({
        rs: warmth * 0.3, gs: tint * -0.2, bs: warmth * -0.3,
        rm: warmth * 0.15, gm: tint * -0.1, bm: warmth * -0.15,
      }, { input: afterEq ?? io.input, output: io.output, allocLabel: io.allocLabel }, gateSuffix)
    : null
  const eq = eqParts.length
    ? [`${io.input}eq=${eqParts.join(':')}${gateSuffix}${balance ? afterEq : io.output}`]
    : []
  return [...eq, ...(balance ?? [])]
}

/**
 * Where the logo sits, as `overlay` filter coordinates.
 *
 * The nine named anchors are the registry's, shared with every overlay that
 * hangs off a corner — there is one implementation of this arithmetic now.
 * `custom` stays here because it is not an anchor at all: it is a literal
 * coordinate pair the customer typed, and only the Video Assembly logo control
 * offers it.
 */
export function calculateLogoPosition(
  position: string,
  margin: number,
  customX?: number,
  customY?: number,
): { x: string; y: string } {
  if (position === 'custom' && customX !== undefined && customY !== undefined) return { x: String(customX), y: String(customY) }
  return anchorOverlayPosition(position, margin)
}
