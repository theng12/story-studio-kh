/**
 * The final pass's colour grade: `colorbalance` replaced by a two-input `lut2`.
 *
 * Pinned here: the lightness-weight model (measured from FFmpeg's real `colorbalance`), the filtergraph the grade
 * now emits (gate suffix kept, untouched channels omitted, nothing when there is nothing to do, plane order,
 * rounding), and, where FFmpeg is installed, the numerical match against the real filter on real-shaped data.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { buildColorGradingFilters } from '../lib/video-effects.js'
import { balancedLevel, buildColorbalanceStatements, colorbalanceWeights } from '../lib/grade-balance.js'

function labels() {
  let n = 100
  return { input: '[in]', output: '[out]', allocLabel: () => `[t${n++}]` }
}
const grade = (patch: object, gate = '') =>
  buildColorGradingFilters({ enabled: true, preset: 'none', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0, ...patch } as any, gate, labels())

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

test('a balanced level adds the weighted amounts to the input and clips to the range', () => {
  assert.ok(Math.abs(balancedLevel(0, 0, 0.054, 0, 0) - 0.054 * 0.7) < 1e-9)
  assert.equal(balancedLevel(0.5, 0.5, 0.054, 0.027, 0), 0.5)          // 128 is past the shadow and mid bands
  assert.equal(balancedLevel(0, 0, -0.5, 0, 0), 0)                       // never below black
  assert.equal(balancedLevel(1, 1, 0, 0, 0.5), 1)                        // never above white
  // the offset follows the PIXEL's lightness, not the channel: a dark blue channel in a lighter pixel gets the lighter pixel's weight
  assert.notEqual(balancedLevel(0.1, 0.1, -0.09, 0, 0), balancedLevel(0.1, 0.5, -0.09, 0, 0))
})

test('the grade emits a split, a grey copy and a lut2 with the gate, not colorbalance', () => {
  const g = grade({ preset: 'desert-twilight' }, ":enable='gt(t,2)'")
  assert.equal(g.length, 4)
  assert.match(g[0]!, /^\[in\]eq=brightness=0\.020:contrast=1\.050:saturation=1\.050:enable='gt\(t,2\)'\[t100\]$/)
  assert.equal(g[1], '[t100]format=gbrp,split=2[t101][t102]')
  assert.equal(g[2], '[t102]format=gray,format=gbrp[t103]')
  assert.match(g[3]!, /^\[t101\]\[t103\]lut2=c0='[^']+':c1='[^']+':c2='[^']+':enable='gt\(t,2\)',format=yuv420p\[out\]$/)
  assert.ok(!g.join(';').includes('colorbalance'))
})

test('the table rounds, uses the grey input as lightness, and follows planar RGB order G, B, R', () => {
  const [, , lut] = grade({ warmth: 0.2 }).slice(-3)
  assert.match(lut!, /floor\(x\+255\*0\.7\*\(/)
  assert.match(lut!, /\+0\.5\),0,255\)/)
  assert.match(lut!, /\(2\*y\/255\)/)
  // warmth: red up (c2 positive amounts), blue down (c1 negative), green untouched (c0 absent)
  assert.doesNotMatch(lut!, /c0=/)
  assert.match(lut!, /c1='clip\(floor\(x\+255\*0\.7\*\(-0\.06000\*/)
  assert.match(lut!, /c2='clip\(floor\(x\+255\*0\.7\*\(0\.06000\*/)
})

test('without eq the balance reads the input directly; without balance an eq goes straight to the output', () => {
  const onlyBalance = grade({ warmth: 0.2 })
  assert.ok(onlyBalance[0]!.startsWith('[in]format=gbrp,split=2'))
  assert.ok(onlyBalance.at(-1)!.endsWith('format=yuv420p[out]'))
  assert.deepEqual(grade({ preset: 'noir' }), ["[in]eq=brightness=-0.100:contrast=1.400:saturation=0.000[out]"])
})

test('no warmth, tint, brightness, contrast or saturation means no filters at all', () => {
  assert.deepEqual(grade({}), [])
  assert.equal(buildColorbalanceStatements({ rs: 0, gs: 0, bs: 0, rm: 0, gm: 0, bm: 0 }, labels()), null)
})

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const real = ffmpeg ? test : test.skip

function run(input: Buffer, w: number, h: number, args: string[]): Buffer {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-', ...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input, maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, r.stderr.toString())
  return r.stdout
}

real('against the real colorbalance: within a code value on grey, close on saturated colour', () => {
  const amounts = (w: number, t: number) => ({ rs: w * 0.3, gs: t * -0.2, bs: w * -0.3, rm: w * 0.15, gm: t * -0.1, bm: w * -0.15 })
  const ramp = Buffer.alloc(256 * 3)
  for (let i = 0; i < 256; i++) ramp[i * 3] = ramp[i * 3 + 1] = ramp[i * 3 + 2] = i
  const colour = Buffer.alloc(32768 * 3)
  let seed = 7
  for (let i = 0; i < colour.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; colour[i] = seed >>> 24 }
  for (const [w, t] of [[0.18, 0.04], [-0.15, -0.05], [0.3, 0]] as const) {
    const a = amounts(w, t)
    const old = ['-vf', `colorbalance=rs=${a.rs}:gs=${a.gs}:bs=${a.bs}:rm=${a.rm}:gm=${a.gm}:bm=${a.bm}`]
    const io = { input: '[0:v]', output: '[vout]', allocLabel: (() => { let n = 0; return () => `[x${n++}]` })() }
    const statements = buildColorbalanceStatements(a, io)!
    const mine = ['-filter_complex', `${statements.join(';').replace('format=yuv420p[vout]', 'format=rgb24[vout]')}`, '-map', '[vout]']
    const greyOld = run(ramp, 256, 1, old), greyNew = run(ramp, 256, 1, mine)
    let worstGrey = 0
    for (let i = 0; i < greyOld.length; i++) worstGrey = Math.max(worstGrey, Math.abs(greyOld[i]! - greyNew[i]!))
    assert.ok(worstGrey <= 1, `warmth ${w}: worst grey error ${worstGrey} code values`)
    // Uniform random RGB is the worst case (every pixel saturated): the grey stand-in is not the HSL lightness there.
    const cOld = run(colour, 256, 128, old), cNew = run(colour, 256, 128, mine)
    let sq = 0, worst = 0
    for (let i = 0; i < cOld.length; i++) { const e = cOld[i]! - cNew[i]!; sq += e * e; worst = Math.max(worst, Math.abs(e)) }
    const rmse = Math.sqrt(sq / cOld.length)
    assert.ok(rmse < 3 && worst <= 20, `warmth ${w}: random-colour rmse ${rmse.toFixed(2)}, worst ${worst}`)
  }
})
