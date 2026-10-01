/**
 * The final pass's colour grade: `colorbalance` replaced by `curves`.
 *
 * Pinned here: the lightness-weight model (measured from FFmpeg's real `colorbalance`), the filter
 * string the grade now emits (gate suffix kept, untouched channels omitted, nothing when there is
 * nothing to do), and, where FFmpeg is installed, the numerical match against the real filter:
 * exact on grey, within a few code values on saturated colour (the documented price of a 1-D curve).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { buildColorGradingFilters } from '../lib/video-effects.js'
import { buildColorbalanceCurves, channelCurveValue, colorbalanceWeights } from '../lib/grade-curves.js'

const grade = (patch: object, gate = '') =>
  buildColorGradingFilters({ enabled: true, preset: 'none', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0, ...patch } as any, gate)

test('the lightness weights are the ones colorbalance applies: shadows, mids and highlights tile the range', () => {
  // measured on a grey ramp with colorbalance=rs=0.1 / rm=0.1 / rh=0.1, in units of full scale per unit amount
  const at = (v: number) => colorbalanceWeights(v / 255)
  assert.ok(Math.abs(at(0).shadows - 0.7) < 1e-9 && at(0).mids === 0 && at(0).highs === 0)
  assert.ok(Math.abs(at(24).shadows - 0.7) < 0.02)                 // flat top of the shadow band
  assert.ok(Math.abs(at(48).shadows - 0.24) < 0.02, `shadow weight at 48 is ${at(48).shadows}`)
  assert.ok(at(64).shadows === 0 && Math.abs(at(64).mids - 0.7) < 0.02)
  assert.ok(Math.abs(at(96).mids - 0.12) < 0.02 && Math.abs(at(96).highs - 0.59) < 0.02)
  assert.ok(Math.abs(at(160).highs - 0.7) < 1e-9 && at(160).mids === 0)
  for (let v = 0; v <= 255; v++) {
    const w = at(v)
    assert.ok(w.shadows >= 0 && w.mids >= 0 && w.highs >= 0 && w.shadows + w.mids + w.highs <= 0.71)
  }
})

test('a channel curve adds the weighted amounts to the input and clips to the range', () => {
  assert.ok(Math.abs(channelCurveValue(0, 0.054, 0, 0) - 0.054 * 0.7) < 1e-9)
  assert.equal(channelCurveValue(0.5, 0.054, 0.027, 0), 0.5)         // 128 is past the shadow and mid bands
  assert.equal(channelCurveValue(0, -0.5, 0, 0), 0)                   // never below black
  assert.equal(channelCurveValue(1, 0, 0, 0.5), 1)                    // never above white
})

test('the grade emits curves, not colorbalance, with the gate carried over', () => {
  const g = grade({ preset: 'desert-twilight' }, ":enable='gt(t,2)'")
  assert.doesNotMatch(g, /colorbalance/)
  assert.match(g, /^eq=brightness=0\.020:contrast=1\.050:saturation=1\.050:enable='gt\(t,2\)',curves=r='/)
  assert.match(g, /:interp=pchip:enable='gt\(t,2\)'$/)
  assert.match(g, /r='[^']+':g='[^']+':b='[^']+'/)
})

test('a channel the amounts leave alone is omitted; a pure warmth change touches red and blue only', () => {
  const warm = grade({ warmth: 0.2 })
  assert.match(warm, /^curves=r='[^']+':b='[^']+':interp=pchip$/)
  assert.doesNotMatch(warm, /g='/)
  const tinted = grade({ tint: 0.1 })
  assert.match(tinted, /^curves=g='[^']+':interp=pchip$/)
})

test('no warmth or tint means no curve at all, so a neutral grade costs nothing extra', () => {
  assert.equal(grade({}), '')
  assert.equal(grade({ preset: 'noir' }).includes('curves'), false)
  assert.equal(buildColorbalanceCurves({ rs: 0, gs: 0, bs: 0, rm: 0, gm: 0, bm: 0 }), '')
})

test('knots are strictly increasing and every output stays inside 0..1', () => {
  const s = buildColorbalanceCurves({ rs: 0.09, gs: 0, bs: -0.09, rm: 0.045, gm: 0, bm: -0.045 })
  for (const channel of s.match(/='([^']+)'/g)!) {
    const pairs = channel.slice(2, -1).split(' ').map(p => p.split('/').map(Number) as [number, number])
    assert.ok(pairs.length >= 30)
    for (let i = 1; i < pairs.length; i++) assert.ok(pairs[i]![0] > pairs[i - 1]![0])
    for (const [, y] of pairs) assert.ok(y >= 0 && y <= 1)
    assert.equal(pairs[0]![0], 0)
    assert.equal(pairs.at(-1)![0], 1)
  }
})

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const real = ffmpeg ? test : test.skip

function run(input: Buffer, w: number, h: number, vf: string): Buffer {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-', '-vf', `${vf},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input, maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, r.stderr.toString())
  return r.stdout
}

real('against the real colorbalance: within 2 code values on grey, close on colour, for the shipped presets\' amounts', () => {
  const amounts = (w: number, t: number) => ({ rs: w * 0.3, gs: t * -0.2, bs: w * -0.3, rm: w * 0.15, gm: t * -0.1, bm: w * -0.15 })
  const ramp = Buffer.alloc(256 * 3)
  for (let i = 0; i < 256; i++) ramp[i * 3] = ramp[i * 3 + 1] = ramp[i * 3 + 2] = i
  const colour = Buffer.alloc(32768 * 3)
  let seed = 7
  for (let i = 0; i < colour.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; colour[i] = seed >>> 24 }
  for (const [w, t] of [[0.18, 0.04], [-0.15, -0.05], [0.3, 0]] as const) {
    const a = amounts(w, t)
    const old = `colorbalance=rs=${a.rs}:gs=${a.gs}:bs=${a.bs}:rm=${a.rm}:gm=${a.gm}:bm=${a.bm}`
    const curves = buildColorbalanceCurves(a)
    const greyOld = run(ramp, 256, 1, old), greyNew = run(ramp, 256, 1, curves)
    let worstGrey = 0
    for (let i = 0; i < greyOld.length; i++) worstGrey = Math.max(worstGrey, Math.abs(greyOld[i]! - greyNew[i]!))
    assert.ok(worstGrey <= 2, `warmth ${w}: worst grey error ${worstGrey} code values`)

    // Uniform random RGB is the worst case (every pixel saturated): the 1-D curve cannot see the pixel's lightness.
    const cOld = run(colour, 256, 128, old), cNew = run(colour, 256, 128, curves)
    let sq = 0, worst = 0
    for (let i = 0; i < cOld.length; i++) { const e = cOld[i]! - cNew[i]!; sq += e * e; worst = Math.max(worst, Math.abs(e)) }
    const rmse = Math.sqrt(sq / cOld.length)
    assert.ok(rmse < 6 && worst <= 24, `warmth ${w}: random-colour rmse ${rmse.toFixed(2)}, worst ${worst}`)
  }
})
