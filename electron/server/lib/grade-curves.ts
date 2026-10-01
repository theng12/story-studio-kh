/**
 * `colorbalance`'s warmth/tint look, as three 1-D curves.
 *
 * Every colour-grade preset ends with FFmpeg's `colorbalance` to apply its warmth and tint, and in
 * the final pass that one filter costs about ten times the rest of the chain put together
 * (measured: 41 CPU-seconds per 30 s of 1080p, against 2.4 for decode alone). `curves` does a
 * per-channel 1-D table lookup instead and costs 8.
 *
 * What `colorbalance` computes, per pixel, measured from the real filter and then confirmed to
 * within 0.1 of a code value on 200,000 random pixels:
 *
 *     l  = max(r,g,b) + min(r,g,b)            (twice the HSL lightness, 0..2)
 *     c' = clip(c + 0.7 * (S_c * ws(l) + M_c * wm(l) + H_c * wh(l)))
 *
 *     ws = clip((B - l) * A + 0.5)                                  shadows
 *     wm = clip((l - B) * A + 0.5) * clip((1 - l - B) * A + 0.5)    midtones
 *     wh = clip((l + B - 1) * A + 0.5)                              highlights
 *
 * with A = 4, B = 0.333. The offset a channel receives therefore depends on the pixel's LIGHTNESS,
 * which a per-channel curve cannot see; the curve uses the channel's own value in its place. For a
 * grey pixel the two are identical (exact); for a saturated one the weight differs a little. On
 * real episode frames that costs a mean CIEDE2000 of 0.5-1.0 against the old filter (p95 under 3),
 * where the grade itself is worth 1-2.4: close enough that the two are not told apart side by side,
 * not identical. Estimating the lightness from the pixel's luma instead would bring the mean under
 * 0.1, but needs a multi-input subgraph (and `lut2`), which the final pass's single filter chain
 * cannot take without restructuring; see `docs/render-local.md`.
 */

const A = 4
const B = 0.333
const SCALE = 0.7

function clip01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** The three lightness weights for a lightness `L` in 0..1 (HSL: (max+min)/2). */
export function colorbalanceWeights(L: number): { shadows: number; mids: number; highs: number } {
  const l = 2 * L
  return {
    shadows: SCALE * clip01((B - l) * A + 0.5),
    mids: SCALE * clip01((l - B) * A + 0.5) * clip01((1 - l - B) * A + 0.5),
    highs: SCALE * clip01((l + B - 1) * A + 0.5),
  }
}

export interface ColorbalanceAmounts {
  rs: number; gs: number; bs: number
  rm: number; gm: number; bm: number
  rh?: number; gh?: number; bh?: number
}

/** Output level (0..1) for one channel at input level `v` (0..1), given that channel's three amounts. */
export function channelCurveValue(v: number, shadows: number, mids: number, highs: number): number {
  const w = colorbalanceWeights(v)
  return clip01(v + shadows * w.shadows + mids * w.mids + highs * w.highs)
}

/** The knots (input levels, 0..255) a curve is sampled at: dense enough that pchip reproduces the bands. */
const KNOTS: number[] = [...Array.from({ length: 32 }, (_, i) => i * 8), 255]

function pointList(shadows: number, mids: number, highs: number): string {
  return KNOTS.map(level => {
    const v = level / 255
    return `${v.toFixed(4)}/${channelCurveValue(v, shadows, mids, highs).toFixed(4)}`
  }).join(' ')
}

/**
 * A `curves` filter that stands in for `colorbalance=rs=..:gs=..:bs=..:rm=..:gm=..:bm=..`.
 * A channel the amounts leave untouched is omitted, so a pure warmth change costs two channels.
 * `gateSuffix` is the `:enable='...'` window the caller already uses to time-gate the grade.
 */
export function buildColorbalanceCurves(amounts: ColorbalanceAmounts, gateSuffix = ''): string {
  const channels: Array<[string, number, number, number]> = [
    ['r', amounts.rs, amounts.rm, amounts.rh ?? 0],
    ['g', amounts.gs, amounts.gm, amounts.gh ?? 0],
    ['b', amounts.bs, amounts.bm, amounts.bh ?? 0],
  ]
  const parts = channels
    .filter(([, s, m, h]) => Math.abs(s) > 0.0005 || Math.abs(m) > 0.0005 || Math.abs(h) > 0.0005)
    .map(([name, s, m, h]) => `${name}='${pointList(s, m, h)}'`)
  if (parts.length === 0) return ''
  // pchip is monotone between knots: no overshoot at the band edges, unlike the default natural spline.
  return `curves=${parts.join(':')}:interp=pchip${gateSuffix}`
}
