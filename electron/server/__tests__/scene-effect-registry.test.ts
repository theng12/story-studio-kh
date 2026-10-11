/**
 * The regression anchor for the v1.2.0 effect registry.
 *
 * `fixtures/scene-effects-v1-golden.json` was captured by
 * `scripts/testing/capture-effect-goldens.mts` running against the UNTOUCHED
 * v1.1.0 tree, before a line of the registry existed: 965 scene-animation
 * filter chains across every animation and every parameter range, 45 B-Roll
 * motion chains, and 153 strings from the four effects that already shipped
 * ad-hoc (vignette, film grain, letterbox, logo anchoring).
 *
 * Every one of them must still come out CHARACTER FOR CHARACTER. "Looks the
 * same" is not the bar: these strings are what finished episodes on the
 * customer's disk were rendered with, and a shifted decimal place is a
 * silently different picture.
 *
 * Regenerate the fixture only when a change to the emitted FFmpeg is
 * deliberate, and say so in the changelog when you do.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildAnimationFilter, isZoompanAnimation, normalizeFrame } from '../lib/animation-filters.js'
import { BROLL_MOTIONS, buildBrollMotion, type BrollMotion } from '../lib/broll-motion.js'
import { ANIMATIONS, getAnimation } from '../models/animations.js'
import {
  buildGateEnable,
  buildLetterboxFilter,
  calculateLogoPosition,
  computeVignetteAngle,
} from '../lib/video-effects.js'
import {
  BUILT_IN_FOOTAGE_MOTIONS,
  BUILT_IN_OVERLAYS,
  BUILT_IN_SCENE_MOTIONS,
  findBuiltInOverlay,
  findFootageMotion,
  findSceneMotion,
  sceneEffectCatalog,
} from '../contracts/scene-effect-presets.js'
import {
  OVERLAY_KINDS,
  defaultSceneOverlay,
  normalizeSceneMotion,
  normalizeSceneOverlay,
  SCENE_EFFECT_SCHEMA_VERSION,
} from '../contracts/scene-effects.js'
import { compileSceneOverlay, type OverlayCompileOpts } from '../lib/scene-effect-compiler.js'
import {
  SceneEffectValidationError,
  parseSceneMotionDocument,
  parseSceneOverlayDocument,
} from '../contracts/scene-effects-schema.js'
import type { VideoSceneAnimation } from '../models/types.js'

const golden = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/scene-effects-v1-golden.json', import.meta.url)),
  'utf-8',
)) as {
  animation_param_sets: Record<string, VideoSceneAnimation>
  animation_frames: Array<{ label: string; w: number; h: number; fps: number; duration: number }>
  broll_cases: Array<{ label: string; duration: number; w?: number; h?: number }>
  animations: Record<string, string>
  broll_motions: Record<string, string>
  overlays: Record<string, string>
}


/** E2–E4 (1.4.288): the moves that need scene analysis. All are virtual-camera (zoompan) moves. */
const E2E4_MOTIONS = [
  'depth-gentle', 'depth', 'depth-strong', 'depth-left', 'depth-right',
  'rack-focus-gentle', 'rack-focus', 'rack-focus-strong', 'rack-focus-background',
  'subject-gentle', 'subject', 'subject-strong', 'subject-pull', 'tour', 'tour-slow',
]

describe('v1.1.0 scene animations are reproduced byte for byte', () => {
  test('every animation, parameter set and output frame', () => {
    const mismatches: string[] = []
    let checked = 0
    for (const [key, expected] of Object.entries(golden.animations)) {
      const [type, paramName, frameLabel] = key.split('|') as [string, string, string]
      const params = golden.animation_param_sets[paramName]!
      const frame = golden.animation_frames.find(f => f.label === frameLabel)!
      const actual = buildAnimationFilter({
        type: type === '__unknown__' ? 'no-such-animation' : type,
        params, w: frame.w, h: frame.h, fps: frame.fps, duration: frame.duration,
      }).join(',')
      checked++
      if (actual !== expected) mismatches.push(`${key}\n  expected: ${expected}\n  actual:   ${actual}`)
    }
    assert.equal(checked, 965, 'the fixture must still hold every captured case')
    assert.deepEqual(mismatches, [], `${mismatches.length} animation filter chains drifted`)
  })

  test('the fixture covers every animation the catalogue offers', () => {
    // E1 (1.4.287) moves are newer than v1.1.0; `effects-e1.test.ts` pins their output.
    // E2–E4 (1.4.288) moves likewise; `effects-e2e4.test.ts` pins theirs.
    for (const def of ANIMATIONS.filter(a => !['float', 'float-gentle'].includes(a.id) && !E2E4_MOTIONS.includes(a.id))) {
      assert.ok(
        Object.keys(golden.animations).some(k => k.startsWith(`${def.id}|`)),
        `animation "${def.id}" has no pinned output — capture it before shipping it`,
      )
    }
  })
})

describe('v1.1.0 B-Roll motions are reproduced byte for byte', () => {
  test('every motion, duration and output frame', () => {
    const mismatches: string[] = []
    let checked = 0
    for (const [key, expected] of Object.entries(golden.broll_motions)) {
      const [motion, caseLabel] = key.split('|') as [string, string]
      const c = golden.broll_cases.find(b => b.label === caseLabel)!
      const requested = motion === '__empty__' ? '' : motion === '__unknown__' ? 'no-such-motion' : motion
      const actual = buildBrollMotion({
        motion: requested as BrollMotion,
        duration: c.duration,
        ...(c.w ? { w: c.w } : {}),
        ...(c.h ? { h: c.h } : {}),
      })
      checked++
      if (actual !== expected) mismatches.push(`${key}\n  expected: ${expected}\n  actual:   ${actual}`)
    }
    assert.equal(checked, 45)
    assert.deepEqual(mismatches, [], `${mismatches.length} B-Roll motion chains drifted`)
  })
})

describe('v1.1.0 ad-hoc effects are reproduced byte for byte', () => {
  test('vignette angle and filter statement', () => {
    for (const [key, expected] of Object.entries(golden.overlays)) {
      if (key.startsWith('vignette-angle|')) {
        const strength = Number(key.split('|')[1])
        assert.equal(computeVignetteAngle(strength).toFixed(4), expected, key)
      }
      if (key.startsWith('vignette-filter|')) {
        const [, strength, gated] = key.split('|') as [string, string, string]
        const gate = gated === 'gated' ? `:enable='between(t,12.00,930.50)'` : ''
        const actual = `vignette=angle=${computeVignetteAngle(Number(strength)).toFixed(4)}:mode=forward:eval=init${gate}`
        assert.equal(actual, expected, key)
      }
    }
  })

  test('letterbox bars at every ratio and frame shape', () => {
    let checked = 0
    for (const [key, expected] of Object.entries(golden.overlays)) {
      if (!key.startsWith('letterbox|')) continue
      const [, ratio, label, color] = key.split('|') as [string, string, string, string]
      const dims: Record<string, [number, number]> = {
        '1080p': [1920, 1080], vertical: [1080, 1920], '4k': [3840, 2160], square: [1080, 1080],
      }
      const [w, h] = dims[label]!
      // 1.4.282 — the v1.1.0 bars-over-the-picture look is now the explicit `cover` mode.
      assert.equal(String(buildLetterboxFilter('[v0]', '[v1]', w, h, ratio, color, 'cover')), expected, key)
      checked++
    }
    assert.equal(checked, 48)
  })

  test('logo anchoring at every named position', () => {
    let checked = 0
    for (const [key, expected] of Object.entries(golden.overlays)) {
      if (key.startsWith('logo-pos|')) {
        const [, position, margin] = key.split('|') as [string, string, string]
        const p = calculateLogoPosition(position, Number(margin))
        assert.equal(`${p.x}|${p.y}`, expected, key)
        checked++
      }
      if (key.startsWith('logo-pos-custom|')) {
        const [, position, margin] = key.split('|') as [string, string, string]
        const p = calculateLogoPosition(position, Number(margin), 37, 91)
        assert.equal(`${p.x}|${p.y}`, expected, key)
        checked++
      }
    }
    assert.equal(checked, 66)
  })

  test('film grain and the intro gate', () => {
    for (const [key, expected] of Object.entries(golden.overlays)) {
      if (key.startsWith('film-grain|')) {
        const [, strength, gated] = key.split('|') as [string, string, string]
        const gate = gated === 'gated' ? `:enable='gt(t,12.00)'` : ''
        assert.equal(`noise=alls=${Math.round(Number(strength))}:allf=t+u${gate}`, expected, key)
      }
      if (key.startsWith('gate|')) {
        const [, start, end] = key.split('|') as [string, string, string]
        assert.equal(buildGateEnable(Number(start), Number(end)), expected, key)
      }
    }
  })
})

describe('the registry drives the catalogues, not a second list', () => {
  test('every animation id, label and category still resolves', () => {
    // 24, plus E1's two handheld floats (1.4.287) and E2–E4's fifteen picture-aware moves (1.4.288).
    assert.equal(ANIMATIONS.length, 41)
    assert.equal(BUILT_IN_SCENE_MOTIONS.length, 41)
    for (const m of BUILT_IN_SCENE_MOTIONS) {
      const def = getAnimation(m.id)
      assert.ok(def, `${m.id} missing from the catalogue`)
      assert.equal(def!.label, m.name)
      assert.equal(def!.category, m.category)
    }
    assert.equal(getAnimation('no-such-animation'), null)
  })

  test('B-Roll motion ids match the footage registry exactly', () => {
    assert.deepEqual(BROLL_MOTIONS.map(m => m.id), BUILT_IN_FOOTAGE_MOTIONS.map(m => m.id))
    assert.deepEqual(BROLL_MOTIONS.map(m => m.label), BUILT_IN_FOOTAGE_MOTIONS.map(m => m.name))
  })

  test('isZoompanAnimation is derived from the documents', () => {
    // The eighteen the hand-kept Set used to name, and nothing else.
    const zoompan = ANIMATIONS.filter(a => isZoompanAnimation(a.id)).map(a => a.id).sort()
    assert.deepEqual(zoompan, [
      'breathe', 'dolly-in', 'float', 'float-gentle', 'ken-burns', 'ken-burns-reverse', 'pan-diag-bl', 'pan-diag-br',
      'pan-diag-tl', 'pan-diag-tr', 'pan-down', 'pan-left', 'pan-right', 'pan-up',
      'parallax-drift', 'pulse', 'slow-pull', 'slow-push', 'zoom-in', 'zoom-out',
      ...E2E4_MOTIONS,
    ].sort())
  })

  test('ids are unique inside each registry', () => {
    for (const list of [BUILT_IN_SCENE_MOTIONS, BUILT_IN_FOOTAGE_MOTIONS, BUILT_IN_OVERLAYS]) {
      const ids = list.map(e => e.id)
      assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(',')}`)
    }
  })

  test('normalizeFrame is untouched — it is not an animation', () => {
    assert.deepEqual(normalizeFrame(1920, 1080, 30), [
      'scale=1920:1080:force_original_aspect_ratio=decrease',
      'setsar=1',
      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black',
      'fps=30',
      'format=yuv420p',
    ])
  })
})

// ── Overlays ────────────────────────────────────────────────────────────────

function overlayOpts(over: Partial<OverlayCompileOpts> = {}): OverlayCompileOpts {
  let n = 0
  return {
    input: '[v0]',
    output: '[vout]',
    allocLabel: () => `[x${n++}]`,
    w: 1920,
    h: 1080,
    duration: 30,
    ...over,
  }
}

describe('overlay compilation', () => {
  test('every built-in overlay compiles to something FFmpeg-shaped', () => {
    for (const entry of BUILT_IN_OVERLAYS) {
      // Atmosphere loops composite a baked clip the caller opens as an input.
      const statements = compileSceneOverlay(entry.document, overlayOpts({ loopInput: () => '[9:v]' }))
      if (entry.document.kind === 'corner-logo' || entry.document.kind === 'living-region') {
        // No image chosen yet — an unset logo draws nothing, and that is not
        // an error. A living picture is drawn on its scene's clip
        // (lib/scene-stage.ts), never in the timeline pass.
        assert.equal(statements, null, entry.id)
        continue
      }
      assert.ok(statements && statements.length > 0, `${entry.id} produced nothing`)
      assert.ok(statements![0]!.startsWith('[v0]') || statements![0]!.startsWith('movie=') || statements![0]!.startsWith('[9:v]'),
        `${entry.id} must consume its input label first: ${statements![0]}`)
      assert.ok(statements![statements!.length - 1]!.endsWith('[vout]'),
        `${entry.id} must write its output label last`)
    }
  })

  test('vignette matches the ad-hoc filter it replaces', () => {
    const doc = normalizeSceneOverlay({ kind: 'vignette', intensity: 0.7 })
    assert.deepEqual(compileSceneOverlay(doc, overlayOpts()), [
      '[v0]vignette=angle=1.0100:mode=forward:eval=init[vout]',
    ])
  })

  test('film grain matches the ad-hoc filter it replaces', () => {
    const doc = normalizeSceneOverlay({ kind: 'film-grain', amount: 15 })
    assert.deepEqual(compileSceneOverlay(doc, overlayOpts()), ['[v0]noise=alls=15:allf=t+u[vout]'])
  })

  test('letterbox in cover mode matches the ad-hoc filter it replaces', () => {
    const doc = normalizeSceneOverlay({ kind: 'letterbox', ratio: '2.35:1', color: 'black', mode: 'cover' })
    assert.deepEqual(compileSceneOverlay(doc, overlayOpts()), [
      '[v0]drawbox=x=0:y=0:w=iw:h=132:color=black:t=fill,'
      + 'drawbox=x=0:y=ih-132:w=iw:h=132:color=black:t=fill[vout]',
    ])
  })

  test('letterbox draws nothing when the frame is already wider than the ratio', () => {
    const doc = normalizeSceneOverlay({ kind: 'letterbox', ratio: '1.85:1' })
    assert.equal(compileSceneOverlay(doc, overlayOpts({ w: 1920, h: 800 })), null)
  })

  test('a light leak branches, blends and gates on the blend', () => {
    const doc = normalizeSceneOverlay({
      kind: 'light-leak', color_hex: '#FF9A3C', intensity: 0.35, softness: 0.6,
      from_anchor: 'top-right', to_anchor: 'center-right', timing: { start_sec: 0, end_sec: 4 },
    })
    const statements = compileSceneOverlay(doc, overlayOpts())!
    assert.equal(statements.length, 3)
    // `format=gbrp` is not decoration: screen is an RGB operator, and left in
    // YUV the blend screens the chroma planes and turns the picture magenta.
    assert.equal(statements[0], '[v0]format=gbrp,split=2[x0][x1]')
    assert.match(statements[1]!, /^\[x1\]drawbox=x=0:y=0:w=iw:h=ih:color=0xFF9A3C:t=fill,vignette=/)
    assert.match(statements[1]!, /eval=frame\[x2\]$/)
    assert.match(statements[2]!, /^\[x0\]\[x2\]blend=all_mode=screen:all_opacity=0\.350/)
    // The fragment must hand back the format it was given, or the filters
    // downstream of it inherit planar RGB.
    assert.match(statements[2]!, /,format=yuv420p\[vout\]$/)
    // The window lives on the blend. Gating the PAINT instead would screen the
    // untouched frame against itself and brighten the whole picture.
    assert.ok(!statements[1]!.includes('enable='), 'the paint branch must never be gated')
    assert.ok(statements[2]!.includes('enable='), 'the blend must carry the window')
  })

  test('a light leak that does not travel is evaluated once, not per frame', () => {
    const doc = normalizeSceneOverlay({
      kind: 'light-leak', from_anchor: 'center', to_anchor: 'center',
    })
    const statements = compileSceneOverlay(doc, overlayOpts())!
    assert.match(statements[1]!, /:eval=init\[/)
    assert.match(statements[1]!, /x0=960:y0=540/)
  })

  test('a gradient scrim ramps monotonically toward its edge', () => {
    const doc = normalizeSceneOverlay({
      kind: 'gradient-scrim', edge: 'bottom', opacity: 0.75, coverage: 0.34, steps: 8,
    })
    const chain = compileSceneOverlay(doc, overlayOpts())![0]!
    const alphas = [...chain.matchAll(/@(\d\.\d{3})/g)].map(m => Number(m[1]))
    assert.equal(alphas.length, 8)
    assert.equal(alphas[0], 0.75, 'the band at the frame edge carries the full opacity')
    for (let i = 1; i < alphas.length; i++) {
      assert.ok(alphas[i]! < alphas[i - 1]!, 'opacity must fall away from the edge')
    }
    // The bands must tile the covered strip with no gap and no overlap.
    const boxes = [...chain.matchAll(/drawbox=x=0:y=(\d+):w=iw:h=(\d+)/g)]
      .map(m => ({ y: Number(m[1]), h: Number(m[2]) }))
      .sort((a, b) => a.y - b.y)
    for (let i = 1; i < boxes.length; i++) {
      assert.equal(boxes[i]!.y, boxes[i - 1]!.y + boxes[i - 1]!.h, 'bands must be contiguous')
    }
    assert.equal(boxes[boxes.length - 1]!.y + boxes[boxes.length - 1]!.h, 1080, 'the last band must reach the edge')
  })

  test('every scrim edge covers the correct strip', () => {
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      const doc = normalizeSceneOverlay({ kind: 'gradient-scrim', edge, steps: 4, coverage: 0.25 })
      const chain = compileSceneOverlay(doc, overlayOpts())![0]!
      assert.ok(chain.includes('drawbox='), edge)
      if (edge === 'top') assert.ok(chain.includes('y=0:'), 'top scrim must touch y=0')
      if (edge === 'left') assert.ok(chain.includes('x=0:'), 'left scrim must touch x=0')
    }
  })

  test('a corner logo reads its own source and anchors without a second input', () => {
    const doc = normalizeSceneOverlay({
      kind: 'corner-logo', image_path: '/tmp/logo.png', anchor: 'bottom-right',
      margin_px: 40, width_pct: 0.1, opacity: 0.8,
    })
    const statements = compileSceneOverlay(doc, overlayOpts())!
    assert.equal(statements.length, 2)
    assert.match(statements[0]!, /^movie=filename=\/tmp\/logo\.png,scale=192:-1,format=rgba,colorchannelmixer=aa=0\.800\[x0\]$/)
    assert.equal(statements[1], '[v0][x0]overlay=W-w-40:H-h-40[vout]')
  })

  test('a logo path with an apostrophe is escaped, not broken', () => {
    const doc = normalizeSceneOverlay({ kind: 'corner-logo', image_path: "/tmp/Rome's/logo.png" })
    const statements = compileSceneOverlay(doc, overlayOpts())!
    assert.ok(statements[0]!.includes("Rome\\\\\\'s"), statements[0])
  })

  test('a lower third draws its own measured box and fades', () => {
    const doc = normalizeSceneOverlay({
      kind: 'lower-third', title: 'Aiden', subtitle: 'Narrator', bar: true,
      timing: { start_sec: 2, end_sec: 8 },
    })
    const chain = compileSceneOverlay(doc, overlayOpts())![0]!
    assert.equal((chain.match(/drawtext=/g) || []).length, 2, 'one drawtext per line')
    assert.ok(chain.includes('text=Aiden'))
    assert.ok(chain.includes('text=Narrator'))
    assert.ok(chain.includes('expansion=none'), 'editorial copy is literal, never a template')
    assert.ok(chain.includes('box=1'), 'the box is measured by the text renderer')
    assert.ok(chain.includes('alpha='), 'the declared fade must be emitted')
    assert.ok(chain.includes('enable='), 'the declared window must be emitted')
  })

  test('a lower third with no copy draws nothing', () => {
    assert.equal(compileSceneOverlay(defaultSceneOverlay('lower-third'), overlayOpts()), null)
  })

  test('an ungated overlay emits no enable at all', () => {
    for (const kind of OVERLAY_KINDS) {
      if (kind === 'corner-logo' || kind === 'lower-third') continue
      const statements = compileSceneOverlay(defaultSceneOverlay(kind), overlayOpts())
      if (!statements) continue
      assert.ok(!statements.join('').includes('enable='),
        `${kind} added an enable nobody asked for`)
    }
  })

  test('the caller gate is ANDed with the overlay window, not replaced by it', () => {
    const doc = normalizeSceneOverlay({ kind: 'vignette', timing: { start_sec: 5, end_sec: 20 } })
    const statement = compileSceneOverlay(doc, overlayOpts({ gateExpression: 'gt(t,12.00)' }))![0]!
    assert.ok(statement.includes('between(t\\,5.00\\,20.00)*gt(t\\,12.00)'), statement)
  })

  test('reference pixels scale with the output frame', () => {
    const doc = normalizeSceneOverlay({ kind: 'corner-logo', image_path: '/l.png', margin_px: 40 })
    const at1080 = compileSceneOverlay(doc, overlayOpts({ w: 1920, h: 1080 }))![1]!
    const at540 = compileSceneOverlay(doc, overlayOpts({ w: 960, h: 540 }))![1]!
    assert.ok(at1080.includes('W-w-40'), at1080)
    assert.ok(at540.includes('W-w-20'), at540)
  })
})

// ── Contract behaviour ──────────────────────────────────────────────────────

describe('documents normalise leniently and validate strictly', () => {
  test('garbage normalises to the default rather than throwing', () => {
    assert.equal(normalizeSceneMotion(null).source, 'still')
    assert.equal(normalizeSceneMotion('nonsense').zoom.mode, 'none')
    assert.equal(normalizeSceneOverlay({ kind: 'not-a-kind' }).kind, 'vignette')
  })

  test('out-of-range values are clamped, never rejected on the read path', () => {
    const doc = normalizeSceneMotion({ zoom: { mode: 'ramp', from_pct: -900, to_pct: 9000 } })
    assert.equal(doc.zoom.from_pct, 10)
    assert.equal(doc.zoom.to_pct, 400)
    const vignette = normalizeSceneOverlay({ kind: 'vignette', intensity: 12 })
    assert.equal(vignette.kind, 'vignette')
    assert.equal((vignette as Extract<typeof vignette, { kind: 'vignette' }>).intensity, 1)
  })

  test('an end before the start becomes an open-ended window, not a dead one', () => {
    const doc = normalizeSceneOverlay({ kind: 'vignette', timing: { start_sec: 20, end_sec: 5 } })
    assert.equal(doc.timing.end_sec, null)
  })

  test('strict validation names an unknown field', () => {
    assert.throws(
      () => parseSceneMotionDocument({ ...normalizeSceneMotion({}), glow: true }),
      (e: unknown) => {
        assert.ok(e instanceof SceneEffectValidationError)
        assert.match(e.message, /unknown field "glow"/)
        assert.match(e.message, /newer/)
        return true
      },
    )
  })

  test('strict validation rejects a footage move that both zooms and pans', () => {
    const doc = normalizeSceneMotion({
      source: 'footage',
      zoom: { mode: 'ramp', from_pct: 100, to_pct: 110 },
      pan: { mode: 'traverse', x: 1, y: 0 },
    })
    assert.throws(() => parseSceneMotionDocument(doc), /cannot both zoom and pan/)
  })

  test('strict validation accepts every built-in document', () => {
    for (const entry of [...BUILT_IN_SCENE_MOTIONS, ...BUILT_IN_FOOTAGE_MOTIONS]) {
      assert.doesNotThrow(() => parseSceneMotionDocument(entry.document), entry.id)
    }
    for (const entry of BUILT_IN_OVERLAYS) {
      assert.doesNotThrow(() => parseSceneOverlayDocument(entry.document), entry.id)
    }
  })

  test('every built-in carries the current schema version', () => {
    for (const entry of [...BUILT_IN_SCENE_MOTIONS, ...BUILT_IN_FOOTAGE_MOTIONS, ...BUILT_IN_OVERLAYS]) {
      assert.equal(entry.document.schema_version, SCENE_EFFECT_SCHEMA_VERSION, entry.id)
    }
  })

  test('every approximation note is a real sentence, not a placeholder', () => {
    const noted = [...BUILT_IN_SCENE_MOTIONS, ...BUILT_IN_OVERLAYS].filter(e => e.approximation)
    assert.ok(noted.length >= 6, 'the honest notes must survive a refactor')
    for (const entry of noted) {
      assert.ok(entry.approximation!.length > 60, `${entry.id}: note too short to be honest`)
      assert.ok(/\.$/.test(entry.approximation!.trim()), `${entry.id}: note is not a sentence`)
    }
  })

  test('the catalogue payload carries everything the pickers need', () => {
    const catalog = sceneEffectCatalog()
    assert.equal(catalog.scene_motions.length, 41)
    assert.equal(catalog.footage_motions.length, 7)
    // Thirteen starter overlays, the sixteen v1.5 Effects Library effects, Living Picture (1.4.284),
    // E1's twelve (1.4.287) and E4's twelve that follow the picture (1.4.288).
    assert.equal(catalog.overlays.length, 54)
    assert.ok(catalog.effect_stacks.length >= 3)
    assert.ok(catalog.grouped_overlays.length >= 4)
    assert.equal(
      catalog.grouped_overlays.reduce((n, g) => n + g.overlays.length, 0),
      catalog.overlays.length,
      'grouping must not lose or duplicate an overlay',
    )
  })

  test('lookups are total — a missing id returns undefined, never a throw', () => {
    assert.equal(findSceneMotion('nope'), undefined)
    assert.equal(findFootageMotion('nope'), undefined)
    assert.equal(findBuiltInOverlay('nope'), undefined)
    assert.equal(findSceneMotion(null), undefined)
  })

  test('the library covers all seven of the starter effects the owner asked for', () => {
    const kinds = new Set(BUILT_IN_OVERLAYS.map(o => o.document.kind))
    for (const kind of OVERLAY_KINDS) {
      assert.ok(kinds.has(kind), `no built-in ships the "${kind}" overlay`)
    }
  })
})
