/**
 * Colour grading — one implementation for Video Assembly's Colour Grading
 * control and the effect library's per-scene `color-grade` effect.
 *
 * Moved out of `lib/video-effects.ts` (which re-exports it) so the effect
 * compiler can use it without an import cycle. The preset table lives in
 * `contracts/scene-effects.ts` so the live preview reads the same numbers.
 * Emitted filters are unchanged; `__tests__/grade-balance.test.ts` pins them.
 */

import type { VideoColorGrading } from '../models/types.js'
import { COLOR_GRADE_PRESET_VALUES } from '../contracts/scene-effects.js'
import { buildColorbalanceStatements, type GraphIo } from './grade-balance.js'

/** Keep this preset table aligned with the Video Assembly live preview. */
export function buildColorGradingFilters(cg: VideoColorGrading, gateSuffix: string, io: GraphIo): string[] {
  const presets = COLOR_GRADE_PRESET_VALUES as Record<string, typeof COLOR_GRADE_PRESET_VALUES['none']>
  const base = presets[cg.preset] || presets.none!
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
