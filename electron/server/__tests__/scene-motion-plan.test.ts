/**
 * Move-parameter mapping for the native scene-clip renderer.
 *
 * `scene-motion-plan.ts` turns each motion document into per-frame numbers. These tests pin that mapping
 * for every move in the pool the app randomises over, using the same documents the FFmpeg compiler
 * reads, so a registry edit that changes a move changes the plan with it. Numbers worth knowing:
 *
 *   - frame counts equal what the FFmpeg chain produces (`zoompan` rounds, a looped still ceils);
 *   - a pan clamps inside the picture, exactly as `zoompan`'s own x/y clamp does;
 *   - the clock a still's filters read is 25 fps whatever the output rate (measured against FFmpeg 8.1).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILT_IN_SCENE_MOTIONS, BUILT_IN_FOOTAGE_MOTIONS } from '../contracts/scene-effect-presets.js'
import { defaultSceneMotion, mergeSceneMotion } from '../contracts/scene-effects.js'
import { resolveSceneMotionDocument } from '../lib/animation-filters.js'
import { plannedFrameCount, planStillMotion, stillInputFrame } from '../lib/scene-motion-plan.js'

// The 21 moves a "per-scene" episode draws from (the project default pool).
const POOL = [
  'ken-burns', 'ken-burns-reverse', 'zoom-in', 'zoom-out', 'slow-push', 'slow-pull', 'dolly-in',
  'parallax-drift', 'pan-left', 'pan-right', 'pan-up', 'pan-down',
  'pan-diag-tl', 'pan-diag-tr', 'pan-diag-bl', 'pan-diag-br',
  'breathe', 'pulse', 'fade-in', 'fade-out', 'blur-focus',
]
const PARAMS = { type: 'x', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 } as const
const OPTS = { w: 1920, h: 1080, fps: 24, duration: 7.44 }

function plan(type: string, opts = OPTS) {
  const result = planStillMotion(resolveSceneMotionDocument({ type, params: PARAMS as any }), opts)
  assert.ok(result.supported, `${type}: ${result.supported ? '' : result.reason}`)
  return result
}

test('the pool has 21 moves and every one is supported by the native plan', () => {
  assert.equal(POOL.length, 21)
  for (const type of POOL) {
    assert.ok(BUILT_IN_SCENE_MOTIONS.some(motion => motion.id === type), `${type} is in the registry`)
    const p = plan(type)
    assert.ok(p.frames.length > 0)
    for (const frame of p.frames) {
      assert.ok(Number.isFinite(frame.z) && Number.isFinite(frame.cx) && Number.isFinite(frame.cy) && Number.isFinite(frame.rot))
      assert.ok(frame.gain >= 0 && frame.gain <= 1)
    }
  }
  // ...and the rotations, which are not in the default pool but are in the registry.
  assert.equal(plan('rotate-cw').kind, 'spin')
  assert.equal(plan('rotate-ccw').kind, 'spin')
})

test('frame counts match the FFmpeg chain: zoompan rounds, a looped still ceils', () => {
  assert.equal(plan('ken-burns').frames.length, 179)            // round(178.56)
  assert.equal(plan('fade-in').frames.length, 179)              // ceil(178.56)
  assert.equal(plannedFrameCount(true, 24, 7.42), 178)          // round(178.08)
  assert.equal(plannedFrameCount(false, 24, 7.42), 179)         // ceil(178.08)
  assert.equal(plannedFrameCount(false, 24, 1), 24)             // exact products do not gain a frame
  assert.equal(plannedFrameCount(true, 24, 0.01), 1)            // never zero
})

test('zoom ramps run linearly from `from` to just short of `to`, like zoompan', () => {
  const kb = plan('ken-burns')
  assert.equal(kb.kind, 'camera')
  assert.equal(kb.frames[0]!.z, 1)
  const n = kb.frames.length
  assert.ok(Math.abs(kb.frames[n - 1]!.z - (1 + 0.08 * (n - 1) / n)) < 1e-9)
  // a zoom-in keeps the picture centred; z only grows
  assert.ok(kb.frames.every((frame, i) => i === 0 || frame.z > kb.frames[i - 1]!.z))
  assert.ok(kb.frames.every(frame => Math.abs(frame.cx - 960) < 1e-9 && Math.abs(frame.cy - 540) < 1e-9))

  const reverse = plan('ken-burns-reverse')
  assert.ok(Math.abs(reverse.frames[0]!.z - 1.08) < 1e-9)
  assert.ok(reverse.frames.every((frame, i) => i === 0 || frame.z < reverse.frames[i - 1]!.z))

  assert.ok(Math.abs(plan('zoom-in').frames[n - 1]!.z - (1 + 0.12 * (n - 1) / n)) < 1e-9)
  assert.ok(Math.abs(plan('slow-push').frames[n - 1]!.z - (1 + 0.06 * (n - 1) / n)) < 1e-9)
})

test('legacy parameters still steer the legacy moves', () => {
  const doc = resolveSceneMotionDocument({ type: 'ken-burns', params: { ...PARAMS, zoom_start: 100, zoom_end: 120 } as any })
  const p = planStillMotion(doc, OPTS)
  assert.ok(p.supported && Math.abs(p.frames.at(-1)!.z - 1.2) < 0.01)
})

test('pans hold a fixed magnification and drift at output-px per second, clamped inside the picture', () => {
  const left = plan('pan-left')
  assert.ok(left.frames.every(frame => frame.z === 1.08))
  // pan-left is -2 px/s: after 7.44 s the window centre has moved ~14.9 px left of centre
  const startX = left.frames[0]!.cx
  const endX = left.frames.at(-1)!.cx
  assert.ok(Math.abs(startX - 960) < 1e-9)
  assert.ok(Math.abs((startX - endX) - 2 * (left.frames.length - 1) / 24) < 1e-9)
  assert.ok(left.frames.every(frame => frame.cy === 540))

  const down = plan('pan-down')
  assert.ok(down.frames.at(-1)!.cy > down.frames[0]!.cy && down.frames.every(frame => frame.cx === 960))

  // diagonals travel on both axes at speed/sqrt(2)
  const tl = plan('pan-diag-tl')
  assert.ok(tl.frames.at(-1)!.cx < tl.frames[0]!.cx && tl.frames.at(-1)!.cy < tl.frames[0]!.cy)

  // a long clip would pan past the edge of the picture; the window stops at it (slack = w - w/1.08)
  const long = plan('pan-right', { ...OPTS, duration: 120 })
  const slack = 1920 - 1920 / 1.08
  assert.ok(Math.abs(long.frames.at(-1)!.cx - (1920 / 1.08 / 2 + slack)) < 1e-6)
})

test('dolly-in: the tilt is authored per FRAME on the supersampled source, so it converts by the 2x', () => {
  const dolly = plan('dolly-in')
  // y rate 0.6 source-px/frame on the 2x canvas = 0.3 output px/frame, held inside the picture
  const z = dolly.frames[100]!.z
  const winH = 1080 / z
  const expectedY0 = Math.min(Math.max(540 - winH / 2 + 100 * 0.3, 0), 1080 - winH)
  assert.ok(Math.abs(dolly.frames[100]!.cy - (expectedY0 + winH / 2)) < 1e-9)
  // at the first frame the window IS the frame: nothing to drift into yet
  assert.equal(dolly.frames[0]!.cy, 540)
})

test('breathe and pulse swing a sine around their base zoom, one period per clip', () => {
  const breathe = plan('breathe')
  const n = breathe.frames.length
  assert.ok(Math.abs(breathe.frames[0]!.z - 1.03) < 1e-9)
  const quarter = Math.round(n / 4)
  assert.ok(Math.abs(breathe.frames[quarter]!.z - (1.03 + 0.02 * Math.sin(quarter * 2 * Math.PI / n))) < 1e-9)
  assert.ok(breathe.frames.every(frame => frame.z >= 1))
  // pulse shares breathe's legacy binding, so project-level breathe parameters override its own; with none set it keeps 105% +/- 4
  const pulse = planStillMotion(resolveSceneMotionDocument({ type: 'pulse', params: { type: 'x' } as any }), OPTS)
  assert.ok(pulse.supported)
  assert.ok(Math.abs(pulse.frames[0]!.z - 1.05) < 1e-9)
  assert.ok(Math.max(...pulse.frames.map(frame => frame.z)) > 1.08)
})

test('rotation: magnified 1.1x, rate in rad/s, ccw is the opposite sign, on the still\'s 25 fps clock', () => {
  const cw = plan('rotate-cw')
  const ccw = plan('rotate-ccw')
  assert.equal(cw.kind, 'spin')
  assert.ok(cw.frames.every(frame => frame.z === 1.1 && frame.cx === 960 && frame.cy === 540))
  assert.equal(cw.frames[0]!.rot, 0)
  // output frame 20 is input frame 20 of a 25 fps stream: t = n / 25 (no drop yet)
  assert.ok(Math.abs(cw.frames[20]!.rot - 0.02 * 20 / 25) < 1e-12)
  // by frame 100 the 24 fps resampler has dropped three input frames
  assert.ok(Math.abs(cw.frames[100]!.rot - 0.02 * 103 / 25) < 1e-12)
  assert.ok(Math.abs(ccw.frames[100]!.rot + 0.02 * 103 / 25) < 1e-12)
})

test('the still\'s clock: 25 fps reads frame n, 24 fps drops one input frame per 24 after the first 28, others take the nearest', () => {
  assert.equal(stillInputFrame(30, 24), 30)
  assert.equal(stillInputFrame(51, 24), 51)
  assert.equal(stillInputFrame(52, 24), 53)
  assert.equal(stillInputFrame(76, 24), 78)
  assert.equal(stillInputFrame(30, 25), 30)
  assert.equal(stillInputFrame(30, 30), 25)
  assert.equal(stillInputFrame(11, 60), 5)
  assert.equal(stillInputFrame(0, 60), 0)
})

test('fades ramp over round(d x 25) frames of the still\'s clock', () => {
  const fin = plan('fade-in', { ...OPTS, duration: 3 })
  assert.equal(fin.kind, 'static')
  // 3 s clip, share 0.5 -> 1.5 s fade -> 38 frames (37.5 rounds up)
  assert.equal(fin.frames[0]!.gain, 0)
  assert.ok(Math.abs(fin.frames[19]!.gain - 19 / 38) < 1e-12)
  assert.equal(fin.frames[40]!.gain, 1)
  assert.ok(fin.frames.every((frame, i) => i === 0 || frame.gain >= fin.frames[i - 1]!.gain))

  const fout = plan('fade-out', { ...OPTS, duration: 3 })
  assert.equal(fout.frames[0]!.gain, 1)
  assert.equal(fout.frames[38]!.gain, 1)             // starts at round(1.5 x 25) = frame 38
  assert.ok(Math.abs(fout.frames[57]!.gain - (1 - (58 - 38) / 38)) < 1e-12)   // frame 57 is input frame 58
  assert.equal(fout.frames.at(-1)!.gain > 0, true)   // a 3 s clip never reaches full black
})

test('blur-focus: three time-gated sigmas, gates printed to 2 places like the filter string', () => {
  const p = plan('blur-focus')
  assert.equal(p.kind, 'static')
  // gate 1: t < 0.3 x 7.44 = 2.23 -> input frames 0..55 at 25 fps (output frame 54 is input frame 55); sigma 8
  assert.deepEqual(p.frames[0]!.blur, [8])
  assert.deepEqual(p.frames[54]!.blur, [8])
  assert.deepEqual(p.frames[55]!.blur, [4])
  assert.deepEqual(p.frames[100]!.blur, [4])
  assert.deepEqual(p.frames[120]!.blur, [1.5])
  // after the last gate (0.85 x 7.44 = 6.32 s) the picture is sharp
  assert.deepEqual(p.frames.at(-1)!.blur, [])
  // `between()` is inclusive at both ends, so a frame exactly on a shared edge takes both stages
  const edge = planStillMotion(mergeSceneMotion(defaultSceneMotion(), { focus: { stages: [
    { sigma: 6, until_share: 0.4 }, { sigma: 3, until_share: 0.8 }, { sigma: 1, until_share: 1 },
  ] } }), { w: 1920, h: 1080, fps: 25, duration: 2 })
  assert.ok(edge.supported)
  assert.deepEqual(edge.frames[39]!.blur, [3])        // t = 1.56
  assert.deepEqual(edge.frames[40]!.blur, [3, 1])     // t = 1.60 is the end of stage 2 AND the start of stage 3
})

test('a static scene is the identity camera', () => {
  const none = plan('none')
  assert.equal(none.kind, 'static')
  assert.ok(none.frames.every(frame => frame.z === 1 && frame.rot === 0 && frame.gain === 1 && frame.blur.length === 0))
})

test('the plan reports the size the FFmpeg chain prepares the still at', () => {
  assert.deepEqual(plan('ken-burns').prepared, { w: 3840, h: 2160 })
  assert.deepEqual(plan('rotate-cw').prepared, { w: 2112, h: 1188 })
  assert.deepEqual(plan('none').prepared, { w: 1920, h: 1080 })
})

test('what the plan cannot express is refused with a reason, never approximated', () => {
  const footage = BUILT_IN_FOOTAGE_MOTIONS[0]!
  const f = planStillMotion(footage.document, OPTS)
  assert.equal(f.supported, false)
  assert.match((f as any).reason, /footage/)
  const ntsc = planStillMotion(resolveSceneMotionDocument({ type: 'ken-burns', params: PARAMS as any }), { ...OPTS, fps: 29.97 })
  assert.equal(ntsc.supported, false)
  assert.match((ntsc as any).reason, /frame rate/)
  const bad = planStillMotion(resolveSceneMotionDocument({ type: 'ken-burns', params: PARAMS as any }), { ...OPTS, duration: 0 })
  assert.equal(bad.supported, false)
})
