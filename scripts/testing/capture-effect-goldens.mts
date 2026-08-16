/**
 * One-shot capture of the PRE-1.2.0 FFmpeg filter strings for every scene
 * animation and every B-Roll motion, across the parameter ranges each accepts.
 *
 * Run against the v1.1.0 tree to produce
 * `electron/server/__tests__/fixtures/scene-effects-v1-golden.json`, which the
 * declarative registry must then reproduce BYTE FOR BYTE. Kept in the tree so
 * the fixture can be regenerated and re-diffed rather than trusted on faith:
 *
 *   npx tsx scripts/testing/capture-effect-goldens.mts
 *
 * It writes the fixture; it never asserts. The assertion lives in
 * `electron/server/__tests__/scene-effect-registry.test.ts`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAnimationFilter } from '../../electron/server/lib/animation-filters.js'
import { buildBrollMotion, type BrollMotion } from '../../electron/server/lib/broll-motion.js'
import { ANIMATIONS } from '../../electron/server/models/animations.js'
import {
  buildGateEnable,
  buildLetterboxFilter,
  calculateLogoPosition,
  computeVignetteAngle,
} from '../../electron/server/lib/video-effects.js'
import type { VideoSceneAnimation } from '../../electron/server/models/types.js'

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'electron', 'server', '__tests__', 'fixtures', 'scene-effects-v1-golden.json',
)

/**
 * Parameter sets spanning what `VideoSceneAnimation` accepts. `defaults` is the
 * shape the UI ships; the rest push each field to an edge so a conversion that
 * only happens to agree at the default is caught.
 */
const PARAM_SETS: Record<string, VideoSceneAnimation> = {
  defaults: {
    type: 'ken-burns', zoom_start: 100, zoom_end: 108,
    parallax_direction: 'right', parallax_speed: 2,
    breathe_amplitude: 2, breathe_base_zoom: 103,
  },
  zoomWide: {
    type: 'ken-burns', zoom_start: 100, zoom_end: 140,
    parallax_direction: 'right', parallax_speed: 2,
    breathe_amplitude: 2, breathe_base_zoom: 103,
  },
  zoomReversed: {
    type: 'ken-burns', zoom_start: 115, zoom_end: 100,
    parallax_direction: 'right', parallax_speed: 2,
    breathe_amplitude: 2, breathe_base_zoom: 103,
  },
  parallaxLeftSlow: {
    type: 'parallax-drift', zoom_start: 100, zoom_end: 108,
    parallax_direction: 'left', parallax_speed: 1,
    breathe_amplitude: 2, breathe_base_zoom: 103,
  },
  parallaxUpFast: {
    type: 'parallax-drift', zoom_start: 100, zoom_end: 108,
    parallax_direction: 'up', parallax_speed: 5,
    breathe_amplitude: 2, breathe_base_zoom: 103,
  },
  parallaxDown: {
    type: 'parallax-drift', zoom_start: 100, zoom_end: 108,
    parallax_direction: 'down', parallax_speed: 3,
    breathe_amplitude: 2, breathe_base_zoom: 103,
  },
  breatheBig: {
    type: 'breathe', zoom_start: 100, zoom_end: 108,
    parallax_direction: 'right', parallax_speed: 2,
    breathe_amplitude: 6, breathe_base_zoom: 110,
  },
  // Zero is the interesting case: the v1 builders use `||` fallbacks, so a 0
  // silently becomes the default. That behaviour must be preserved exactly.
  zeroes: {
    type: 'breathe', zoom_start: 0, zoom_end: 0,
    parallax_direction: 'right', parallax_speed: 0,
    breathe_amplitude: 0, breathe_base_zoom: 0,
  },
}

/** Output geometries + timings the assembler and the preview actually use. */
const FRAMES = [
  { label: '1920x1080@25fps/6s', w: 1920, h: 1080, fps: 25, duration: 6 },
  { label: '1920x1080@30fps/2.4s', w: 1920, h: 1080, fps: 30, duration: 2.4 },
  { label: '1080x1920@25fps/6s', w: 1080, h: 1920, fps: 25, duration: 6 },
  { label: '640x360@24fps/1.5s', w: 640, h: 360, fps: 24, duration: 1.5 },
  { label: '3840x2160@60fps/12s', w: 3840, h: 2160, fps: 60, duration: 12 },
]

const BROLL_MOTION_IDS: BrollMotion[] = [
  'static', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down',
]

const BROLL_CASES = [
  { label: 'default1080/4s', duration: 4, w: undefined, h: undefined },
  { label: 'default1080/0.05s', duration: 0.05, w: undefined, h: undefined },
  { label: 'default1080/13.75s', duration: 13.75, w: undefined, h: undefined },
  { label: '1080x1920/6s', duration: 6, w: 1080, h: 1920 },
  { label: '640x360/2s', duration: 2, w: 640, h: 360 },
]

const animations: Record<string, string> = {}
for (const def of ANIMATIONS) {
  for (const [paramName, params] of Object.entries(PARAM_SETS)) {
    for (const frame of FRAMES) {
      const key = `${def.id}|${paramName}|${frame.label}`
      animations[key] = buildAnimationFilter({
        type: def.id, params, w: frame.w, h: frame.h, fps: frame.fps, duration: frame.duration,
      }).join(',')
    }
  }
}
// Unknown ids must keep falling back to the static chain.
for (const frame of FRAMES) {
  animations[`__unknown__|defaults|${frame.label}`] = buildAnimationFilter({
    type: 'no-such-animation', params: PARAM_SETS.defaults!, w: frame.w, h: frame.h,
    fps: frame.fps, duration: frame.duration,
  }).join(',')
}

const brollMotions: Record<string, string> = {}
for (const motion of BROLL_MOTION_IDS) {
  for (const c of BROLL_CASES) {
    brollMotions[`${motion}|${c.label}`] = buildBrollMotion({
      motion, duration: c.duration, ...(c.w ? { w: c.w } : {}), ...(c.h ? { h: c.h } : {}),
    })
  }
}
// The `!opts.motion` guard and the unreachable-switch fallback.
for (const c of BROLL_CASES) {
  brollMotions[`__empty__|${c.label}`] = buildBrollMotion({
    motion: '' as BrollMotion, duration: c.duration, ...(c.w ? { w: c.w } : {}), ...(c.h ? { h: c.h } : {}),
  })
  brollMotions[`__unknown__|${c.label}`] = buildBrollMotion({
    motion: 'no-such-motion' as BrollMotion, duration: c.duration,
    ...(c.w ? { w: c.w } : {}), ...(c.h ? { h: c.h } : {}),
  })
}

// ── Overlays that already shipped ad-hoc ────────────────────────────────────
//
// Vignette, film grain, letterbox and the corner logo exist today as one-off
// config fields and inline filter strings in `runFinalComposition`. The overlay
// registry takes over their construction, so their current output is pinned
// here too — the render path must not shift by one character.

const overlays: Record<string, string> = {}

for (const strength of [0, 0.05, 0.25, 0.4, 0.7, 1, 1.5, -1]) {
  overlays[`vignette-angle|${strength}`] = computeVignetteAngle(strength).toFixed(4)
  // The exact filter statement `runFinalComposition` pushes, both gated and not.
  for (const gate of ['', `:enable='between(t,12.00,930.50)'`]) {
    overlays[`vignette-filter|${strength}|${gate ? 'gated' : 'ungated'}`] =
      `vignette=angle=${computeVignetteAngle(strength).toFixed(4)}:mode=forward:eval=init${gate}`
  }
}

for (const strength of [1, 15, 15.4, 50, 100]) {
  for (const gate of ['', `:enable='gt(t,12.00)'`]) {
    overlays[`film-grain|${strength}|${gate ? 'gated' : 'ungated'}`] =
      `noise=alls=${Math.round(strength)}:allf=t+u${gate}`
  }
}

for (const ratio of ['2.35:1', '2.00:1', '1.85:1', 'unknown-ratio']) {
  for (const [label, w, h] of [['1080p', 1920, 1080], ['vertical', 1080, 1920], ['4k', 3840, 2160], ['square', 1080, 1080]] as const) {
    for (const color of ['black', 'white', '#101010']) {
      overlays[`letterbox|${ratio}|${label}|${color}`] =
        String(buildLetterboxFilter('[v0]', '[v1]', w, h, ratio, color))
    }
  }
}

for (const position of [
  'top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right', 'custom', 'nonsense',
]) {
  for (const margin of [0, 20, 200]) {
    const plain = calculateLogoPosition(position, margin)
    overlays[`logo-pos|${position}|${margin}`] = `${plain.x}|${plain.y}`
    const custom = calculateLogoPosition(position, margin, 37, 91)
    overlays[`logo-pos-custom|${position}|${margin}`] = `${custom.x}|${custom.y}`
  }
}

for (const [start, end] of [[0, 0], [12, 0], [0, 930.5], [12, 930.5], [-3, 4]] as const) {
  overlays[`gate|${start}|${end}`] = buildGateEnable(start, end)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify({
  captured_from: 'v1.1.0 lib/animation-filters.ts + lib/broll-motion.ts + lib/video-effects.ts',
  animation_param_sets: PARAM_SETS,
  animation_frames: FRAMES,
  broll_cases: BROLL_CASES,
  animations,
  broll_motions: brollMotions,
  overlays,
}, null, 2)}\n`)

console.log(
  `wrote ${Object.keys(animations).length} animation, ${Object.keys(brollMotions).length} b-roll `
  + `and ${Object.keys(overlays).length} overlay cases to ${OUT}`,
)
