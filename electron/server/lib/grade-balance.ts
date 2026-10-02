/**
 * `colorbalance`'s warmth/tint look, without `colorbalance`.
 *
 * Every colour-grade preset ends with FFmpeg's `colorbalance` to apply its warmth and tint, and in the final
 * pass that one filter costs about ten times the rest of the chain put together (measured: 42 CPU-seconds per
 * 30 s of 1080p, against 2.7 for decode alone).
 *
 * What `colorbalance` computes, per pixel, measured from the real filter and confirmed to within 0.1 of a code
 * value on 200,000 random pixels:
 *
 *     l  = max(r,g,b) + min(r,g,b)            (twice the HSL lightness, 0..2)
 *     c' = clip(c + 0.7 * (S_c * ws(l) + M_c * wm(l) + H_c * wh(l)))
 *
 *     ws = clip((B - l) * A + 0.5)                                  shadows
 *     wm = clip((l - B) * A + 0.5) * clip((1 - l - B) * A + 0.5)    midtones
 *     wh = clip((l + B - 1) * A + 0.5)                              highlights
 *
 * with A = 4, B = 0.333. The offset a channel gets depends on the pixel's LIGHTNESS, not on that channel.
 *
 * The replacement is `lut2`: a lookup table indexed by TWO 8-bit values, built once from an expression, so the
 * per-pixel work is a table read. Its two inputs are the frame (as planar RGB) and the same frame as a grey
 * image, whose value stands in for the lightness. Grey luma differs from HSL lightness only on saturated
 * pixels, and measured on real frames the result is a mean CIEDE2000 of about 0.1 against the old filter (p95
 * about 0.6) at 18 CPU-seconds per 30 s instead of 42. A plain per-channel `curves` is cheaper still (8) but
 * uses the channel's own value as the lightness and costs a mean of 0.75 to 2 on dark, saturated night
 * scenes, so it was not shipped; see `docs/render-local.md`.
 *
 * Two details that matter: the expression rounds (`floor(v+0.5)`), because `lut2` truncates and an unrounded
 * table is a constant half-code-value darkening (a mean dE of 0.26 by itself), and planar RGB plane order is
 * G, B, R, so `c0` is the green amount.
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

/** The new level (0..1) of a channel at input level `v` and lightness `L`, given its three amounts. */
export function balancedLevel(v: number, L: number, shadows: number, mids: number, highs: number): number {
  const w = colorbalanceWeights(L)
  return clip01(v + shadows * w.shadows + mids * w.mids + highs * w.highs)
}

/** The `lut2` expression for one channel: `x` is the channel, `y` the grey image standing in for lightness. */
function channelExpression(shadows: number, mids: number, highs: number): string | null {
  if (Math.abs(shadows) <= 0.0005 && Math.abs(mids) <= 0.0005 && Math.abs(highs) <= 0.0005) return null
  const l = '(2*y/255)'
  const terms: string[] = []
  const num = (value: number) => value.toFixed(5)
  if (Math.abs(shadows) > 0.0005) terms.push(`${num(shadows)}*clip((${B}-${l})*${A}+0.5,0,1)`)
  if (Math.abs(mids) > 0.0005) terms.push(`${num(mids)}*clip((${l}-${B})*${A}+0.5,0,1)*clip((1-${l}-${B})*${A}+0.5,0,1)`)
  if (Math.abs(highs) > 0.0005) terms.push(`${num(highs)}*clip((${l}+${B}-1)*${A}+0.5,0,1)`)
  return `clip(floor(x+255*${SCALE}*(${terms.join('+')})+0.5),0,255)`
}

export interface GraphIo {
  /** The label carrying the picture, e.g. `[v3]`. */
  input: string
  /** The label the graded picture must be written to. */
  output: string
  /** Allocates a fresh intermediate label. */
  allocLabel: () => string
}

/**
 * Filtergraph statements standing in for `colorbalance=rs=..:gs=..:bs=..:rm=..:gm=..:bm=..`, or `null` when the
 * amounts change nothing. `gateSuffix` is the `:enable='...'` window the caller already uses to time-gate the
 * grade; it goes on the `lut2` only (the split and grey conversion are not worth gating).
 */
export function buildColorbalanceStatements(amounts: ColorbalanceAmounts, io: GraphIo, gateSuffix = ''): string[] | null {
  const r = channelExpression(amounts.rs, amounts.rm, amounts.rh ?? 0)
  const g = channelExpression(amounts.gs, amounts.gm, amounts.gh ?? 0)
  const b = channelExpression(amounts.bs, amounts.bm, amounts.bh ?? 0)
  if (!r && !g && !b) return null
  const main = io.allocLabel()
  const side = io.allocLabel()
  const grey = io.allocLabel()
  // planar RGB plane order is G, B, R
  const options = [g ? `c0='${g}'` : '', b ? `c1='${b}'` : '', r ? `c2='${r}'` : ''].filter(Boolean).join(':')
  return [
    `${io.input}format=gbrp,split=2${main}${side}`,
    `${side}format=gray,format=gbrp${grey}`,
    `${main}${grey}lut2=${options}${gateSuffix},format=yuv420p${io.output}`,
  ]
}
