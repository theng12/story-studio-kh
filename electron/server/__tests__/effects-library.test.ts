/**
 * Effects Library v1 (music format phase 3) — the pure parts.
 *
 * The particle/noise program, the new effect kinds and their filters, the
 * per-scene stack resolution and the layer-group ordering. Real FFmpeg runs
 * live in `effects-library-render.test.ts`.
 *
 * What these cannot catch: whether an effect LOOKS right. The render test reads
 * pixels to prove each effect changes the picture; the contact sheets in the
 * build report are the visual check.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  LOOP_VARIANTS,
  createLoopRenderer,
  defaultLoopShape,
  flickerOffset,
  hash01,
  lightningLevel,
  loopBakeSize,
  loopFrameCount,
  loopParticleCount,
  loopShapeKey,
  normalizeLoopShape,
} from '../contracts/effect-loops.js'
import {
  EFFECT_STACK_GROUPS,
  defaultAtmosphereLoop,
  mergeSceneOverlay,
  normalizeSceneOverlay,
  overlayStackGroup,
  type SceneOverlayDocument,
} from '../contracts/scene-effects.js'
import { parseSceneOverlayDocument, SceneEffectValidationError } from '../contracts/scene-effects-schema.js'
import { BUILT_IN_EFFECT_STACKS, BUILT_IN_OVERLAYS, findBuiltInOverlay } from '../contracts/scene-effect-presets.js'
import { effectParamFields, effectCostPerFrame, estimateStackMinutes, effectAmountLabel, effectBadge } from '../contracts/effect-params.js'
import { compileSceneOverlay, lightningExpression, overlayLoopShapes } from '../lib/scene-effect-compiler.js'
import { LOOP_BAKE_VERSION } from '../lib/effect-loop-baker.js'
import {
  DEFAULT_SCENE_FADE_SEC,
  emptyEpisodeEffects,
  normalizeEpisodeEffects,
  resolveEpisodeEffectStack,
} from '../services/episode-effects.js'
import { DEFAULT_STILL_CAMERA_MOVE, resolveVideoAssemblySceneAnimation } from '../generators/video.js'

function labels() {
  let i = 0
  return () => `[t${i++}]`
}

function compile(doc: SceneOverlayDocument, extra: Record<string, unknown> = {}) {
  return compileSceneOverlay(doc, {
    input: '[in]', output: '[out]', allocLabel: labels(), w: 1280, h: 720, duration: 60, fps: 24,
    loopInput: () => '[9:v]', ...extra,
  })
}

describe('atmosphere loops — one program for the preview and the bake', () => {
  test('every variant is seamless: the loop phase 1 draws the same frame as 0', () => {
    for (const variant of LOOP_VARIANTS) {
      const shape = defaultLoopShape(variant)
      const r = createLoopRenderer(shape, 160, 90, 24)
      const a = new Uint8Array(160 * 90), b = new Uint8Array(160 * 90)
      r.drawPhase(0, a); r.drawPhase(1, b)
      let worst = 0
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
      assert.ok(worst <= 1, `${variant}: phase 1 differs from phase 0 by ${worst}`)
    }
  })

  test('the wrap from the last frame to the first is no bigger a jump than any other step', () => {
    for (const variant of LOOP_VARIANTS) {
      const shape = defaultLoopShape(variant)
      const n = 24
      const r = createLoopRenderer(shape, 160, 90, n)
      const frames = Array.from({ length: n }, (_, i) => { const f = new Uint8Array(160 * 90); r.draw(i, f); return f })
      const diff = (x: Uint8Array, y: Uint8Array) => x.reduce((s, v, i) => s + Math.abs(v - y[i]!), 0)
      const steps = frames.slice(1).map((f, i) => diff(frames[i]!, f))
      const wrap = diff(frames[n - 1]!, frames[0]!)
      assert.ok(wrap <= Math.max(...steps) * 1.5 + 50, `${variant}: wrap ${wrap} vs biggest step ${Math.max(...steps)}`)
    }
  })

  test('the same shape and seed draw the same pixels; a different seed does not', () => {
    const shape = defaultLoopShape('snow')
    const draw = (seed: number) => {
      const out = new Uint8Array(160 * 90)
      createLoopRenderer({ ...shape, seed }, 160, 90, 24).draw(5, out)
      return Buffer.from(out).toString('base64')
    }
    assert.equal(draw(7), draw(7))
    assert.notEqual(draw(7), draw(8))
  })

  test('two colour halves split the particles exactly between them', () => {
    const shape = { ...defaultLoopShape('bokeh'), amount: 50 }
    const sum = (subset: 0 | 1 | 2) => {
      const out = new Uint8Array(160 * 90)
      createLoopRenderer({ ...shape, subset }, 160, 90, 24).draw(3, out)
      return out.reduce((s, v) => s + v, 0)
    }
    const all = sum(0), even = sum(1), odd = sum(2)
    assert.ok(even > 0 && odd > 0)
    // Additive drawing, clamped at 255: the halves add up to (about) the whole.
    assert.ok(Math.abs(even + odd - all) / all < 0.05, `${even} + ${odd} vs ${all}`)
  })

  test('amount maps to a particle count, and zero draws nothing', () => {
    assert.equal(loopParticleCount({ ...defaultLoopShape('rain'), amount: 35 }), 1400)
    const out = new Uint8Array(160 * 90)
    createLoopRenderer({ ...defaultLoopShape('rain'), amount: 0 }, 160, 90, 24).draw(0, out)
    assert.equal(out.reduce((s, v) => s + v, 0), 0)
    assert.equal(effectAmountLabel(defaultAtmosphereLoop('rain')), '1,400 drops')
  })

  test('normalising clamps every field and turns an upside-down band the right way up', () => {
    const shape = normalizeLoopShape({ amount: 500, size: -3, layers: 9, region_top: 0.9, region_bottom: 0.2, seed: 'x' }, 'stars')
    assert.equal(shape.amount, 100)
    assert.equal(shape.size, 0.25)
    assert.equal(shape.layers, 3)
    assert.equal(shape.region_top, 0.2)
    assert.equal(shape.region_bottom, 0.9)
    assert.equal(shape.seed, defaultLoopShape('stars').seed)
  })

  test('soft layers bake small and at half rate; sizes are always even', () => {
    assert.deepEqual(loopBakeSize(defaultLoopShape('fog'), 1920, 1080), { w: 480, h: 270 })
    assert.deepEqual(loopBakeSize(defaultLoopShape('rain'), 1281, 721), { w: 1282, h: 722 })
    assert.equal(loopFrameCount(defaultLoopShape('rain'), 24), 48)
  })

  test('the cache key changes with the shape but not with colour', () => {
    const a = defaultAtmosphereLoop('rain')
    const key = (doc: SceneOverlayDocument) => overlayLoopShapes(doc).map(loopShapeKey).join()
    assert.equal(key(a), key({ ...a, color_hex: '#FF0000', opacity: 0.1, darken: 0.3 }))
    assert.notEqual(key(a), key({ ...a, amount: 60 }))
  })

  test('renderer output is pinned to the bake version (bump LOOP_BAKE_VERSION when this changes)', () => {
    const h = createHash('sha1')
    for (const variant of LOOP_VARIANTS) {
      const out = new Uint8Array(192 * 108)
      createLoopRenderer(defaultLoopShape(variant), 192, 108, 24).drawPhase(0.37, out)
      h.update(out)
    }
    // A changed renderer with an unchanged version would serve last week's
    // loops from the cache. If this fails: bump LOOP_BAKE_VERSION, then re-pin.
    assert.equal(LOOP_BAKE_VERSION, 1)
    assert.equal(h.digest('hex'), 'e69b22158846649dc90857ee6fa4866569526fd2')
  })

  test('lightning strikes only in the slots its seed picks, and the flash decays', () => {
    let strikes = 0
    for (let slot = 0; slot < 200; slot++) if (hash01(slot, 7) < 0.5) strikes++
    assert.ok(strikes > 70 && strikes < 130, `about half the slots strike, got ${strikes}`)
    const slot = [...Array(50).keys()].find(s => hash01(s, 7) < 0.5)!
    const at = slot * 25 + 25 * (0.15 + 0.7 * hash01(slot + 0.5, 7))
    assert.ok(lightningLevel(at + 0.001, 25, 0.5, 7) > 0.9)
    assert.ok(lightningLevel(at + 1, 25, 0.5, 7) < 0.01)
    assert.equal(lightningLevel(at - 0.5, 25, 0.5, 7), 0)
    assert.equal(lightningLevel(at, 25, 0, 7), 0)
  })

  test('flicker stays inside its amount', () => {
    for (let t = 0; t < 30; t += 0.07) assert.ok(Math.abs(flickerOffset(t, 0.04, 1)) <= 0.04 + 1e-9)
  })
})

describe('new effect kinds', () => {
  test('sixteen v1.5 effects are in the library, after the original thirteen', () => {
    // 30 since 1.4.284: Living Picture, appended last.
    assert.equal(BUILT_IN_OVERLAYS.length, 30)
    assert.equal(BUILT_IN_OVERLAYS.at(-1)!.id, 'living-region')
    assert.equal(BUILT_IN_OVERLAYS[12]!.id, 'scrim-top')
    for (const id of ['rain', 'snow', 'lightning-flash', 'shimmer-ripple', 'ground-mist', 'cloud-shadows', 'dust-motes', 'petals',
      'fireflies', 'bokeh-orbs', 'embers', 'twinkling-stars', 'light-rays', 'bloom-glow', 'candle-flicker', 'colour-grade-look']) {
      const entry = findBuiltInOverlay(id)
      assert.ok(entry, id)
      // Every built-in is valid under the strict schema a content pack must pass.
      assert.doesNotThrow(() => parseSceneOverlayDocument(entry.document), id)
    }
  })

  test('stack presets name only effects that exist', () => {
    for (const stack of BUILT_IN_EFFECT_STACKS) {
      for (const item of stack.effects) {
        const entry = findBuiltInOverlay(item.id)
        assert.ok(entry, `${stack.name}: ${item.id}`)
        assert.doesNotThrow(() => parseSceneOverlayDocument({ ...entry.document, ...(item.params || {}) }), `${stack.name}: ${item.id}`)
      }
    }
  })

  test('the strict schema refuses an unknown field by name and a variant that does not exist', () => {
    assert.throws(() => parseSceneOverlayDocument({ ...defaultAtmosphereLoop('rain'), sparkle: 1 }), (e: any) => e instanceof SceneEffectValidationError && /sparkle/.test(e.message))
    assert.throws(() => parseSceneOverlayDocument({ ...defaultAtmosphereLoop('rain'), variant: 'hail' }), SceneEffectValidationError)
  })

  test('a fog patch starts from fog, not from rain', () => {
    const fog = mergeSceneOverlay('atmosphere-loop', { variant: 'fog' })
    assert.equal(fog.kind, 'atmosphere-loop')
    assert.equal((fog as any).loop_sec, defaultLoopShape('fog').loop_sec)
  })

  test('documents written before fades existed normalise to no fade', () => {
    const doc = normalizeSceneOverlay({ kind: 'vignette', intensity: 0.4, timing: { start_sec: 0, end_sec: null } })
    assert.deepEqual(doc.timing, { start_sec: 0, end_sec: null, fade_in_sec: 0, fade_out_sec: 0 })
  })

  test('a rain loop composites a tinted mask, darkens under it, and gates to its window', () => {
    const rain = { ...defaultAtmosphereLoop('rain'), timing: { start_sec: 10, end_sec: 20, fade_in_sec: 0, fade_out_sec: 0 } }
    const out = compile(rain)!.join(';')
    assert.match(out, /\[9:v\]format=gray,scale=1280:720:flags=bicubic,setsar=1,lut=c0=val\*0\.5500/)
    assert.match(out, /color=c=0xDFE8F2:s=1280x720:r=24/)
    assert.match(out, /alphamerge/)
    assert.match(out, /eq=brightness=-0\.0600:saturation=1-0\.0900:eval=frame:enable=between\(t\\,10\.00\\,20\.00\)/)
    assert.match(out, /overlay=0:0:shortest=1:enable=between\(t\\,10\.00\\,20\.00\)\[out\]/)
  })

  test('a loop with a second colour composites two halves', () => {
    const doc = findBuiltInOverlay('bokeh-orbs')!.document
    assert.equal(overlayLoopShapes(doc).length, 2)
    assert.equal(compile(doc)!.filter(s => s.includes('alphamerge')).length, 2)
  })

  test('a loop that was not baked draws nothing rather than something else', () => {
    assert.equal(compile(defaultAtmosphereLoop('snow'), { loopInput: () => null }), null)
  })

  test('loop fades ramp the layer alpha; the darkening follows the same envelope', () => {
    const doc = { ...defaultAtmosphereLoop('rain'), timing: { start_sec: 10, end_sec: 20, fade_in_sec: 2, fade_out_sec: 3 } }
    const out = compile(doc)!.join(';')
    assert.match(out, /fade=t=in:st=10\.000:d=2\.000:alpha=1,fade=t=out:st=17\.000:d=3\.000:alpha=1/)
    assert.match(out, /min\(1\\,max\(0\\,\(t-10\.000\)\/2\.000\)\)/)
  })

  test('a plain filter with a fade runs on a copy whose alpha fades; without one it is unchanged', () => {
    const plain = findBuiltInOverlay('vignette-soft')!.document
    const before = compile(plain)
    assert.deepEqual(before, ['[in]vignette=angle=0.8100:mode=forward:eval=init[out]'])
    const faded = compile({ ...plain, timing: { start_sec: 5, end_sec: 15, fade_in_sec: 1, fade_out_sec: 1 } })!
    assert.equal(faded[0], '[in]split=2[t0][t1]')
    assert.ok(faded.some(s => s.includes('format=yuva420p,fade=t=in:st=5.000:d=1.000:alpha=1,fade=t=out:st=14.000:d=1.000:alpha=1')))
    assert.match(faded[faded.length - 1]!, /^\[t0\]\[t3\]overlay=0:0:enable=between\(t\\,5\.00\\,15\.00\)\[out\]$/)
  })

  test('bloom screens blurred highlights on the luma plane only', () => {
    const out = compile(findBuiltInOverlay('bloom-glow')!.document)!.join(';')
    assert.match(out, /lutyuv=y=if\(gt\(val\\,178\)\\,\(val-178\)\*255\/77\\,0\)/)
    assert.match(out, /gblur=sigma=[\d.]+:planes=1/)
    assert.match(out, /blend=c0_mode=screen:c0_opacity=0\.350:c1_opacity=0:c2_opacity=0/)
  })

  test('flicker and lightning are frame expressions of t', () => {
    assert.match(compile(findBuiltInOverlay('candle-flicker')!.document)![0]!, /eq=brightness=0\.0400\*\(0\.5\*sin\(2\*PI\*1\.7000\*t\).*:eval=frame/)
    const lightning = compile(findBuiltInOverlay('lightning-flash')!.document)![0]!
    assert.match(lightning, /eq=brightness=0\.3600\*.*:eval=frame/)
    // The NaN guard: exp() never sees a large positive argument.
    assert.match(lightningExpression(25, 0.5, 7), /exp\(-max\(ld\(3\),0\)\*9\)/)
  })

  test('heat shimmer displaces in planar RGB with two Perlin maps', () => {
    const out = compile(findBuiltInOverlay('shimmer-ripple')!.document)!.join(';')
    assert.match(out, /\[in\]format=gbrp/)
    assert.equal((out.match(/perlin=s=320x180/g) || []).length, 2)
    assert.match(out, /displace=edge=smear/)
  })

  test('the colour grade effect uses the same filters as Video Assembly\'s Colour Grading', () => {
    const out = compile(mergeSceneOverlay('color-grade', { preset: 'noir' }))!.join(';')
    assert.match(out, /eq=brightness=-0\.100:contrast=1\.400:saturation=0\.000/)
    assert.equal(compile(mergeSceneOverlay('color-grade', { preset: 'none' })), null)
  })

  test('layer groups put grade first, weather before light particles, lens and overlays last', () => {
    const order = (id: string) => EFFECT_STACK_GROUPS.indexOf(overlayStackGroup(findBuiltInOverlay(id)!.document))
    assert.ok(order('colour-grade-look') < order('cloud-shadows'))
    assert.ok(order('cloud-shadows') < order('rain'))
    assert.ok(order('rain') < order('ground-mist'))
    assert.ok(order('ground-mist') < order('fireflies'))
    assert.ok(order('fireflies') < order('bloom-glow'))
    assert.ok(order('bloom-glow') < order('vignette-soft'))
    assert.ok(order('vignette-soft') < order('scrim-bottom'))
  })

  test('every kind has a parameter panel, and loops show only their own fields', () => {
    for (const entry of BUILT_IN_OVERLAYS) assert.ok(effectParamFields(entry.document as any).length > 0, entry.id)
    const rain = effectParamFields(defaultAtmosphereLoop('rain')).map(f => f.key)
    assert.ok(rain.includes('layers') && rain.includes('wind_deg') && rain.includes('darken'))
    assert.ok(!rain.includes('beam'))
    assert.equal(effectParamFields(defaultAtmosphereLoop('rain')).find(f => f.key === 'size')!.label, 'Streak length')
    assert.equal(effectBadge(defaultAtmosphereLoop('fog')), 'Noise loop')
    assert.equal(effectBadge(findBuiltInOverlay('bloom-glow')!.document), 'Live filter')
  })

  test('the stack estimate scales with frames and pixels', () => {
    const docs = [defaultAtmosphereLoop('rain'), findBuiltInOverlay('vignette-soft')!.document]
    const full = estimateStackMinutes(docs, { durationSec: 3900, fps: 24, w: 1920, h: 1080 })
    const half = estimateStackMinutes(docs, { durationSec: 1950, fps: 24, w: 1920, h: 1080 })
    assert.ok(full > 0 && Math.abs(full - half * 2) < 1e-9)
    assert.ok(effectCostPerFrame(findBuiltInOverlay('bokeh-orbs')!.document) > effectCostPerFrame(defaultAtmosphereLoop('rain')))
  })
})

describe('episode stacks — whole episode, theme runs and single scenes', () => {
  const library = BUILT_IN_OVERLAYS
  const windows = [
    { scene_id: 's1', start_sec: 10, end_sec: 70, theme: 'rainy' },
    { scene_id: 's2', start_sec: 70, end_sec: 130, theme: 'rainy' },
    { scene_id: 's3', start_sec: 130, end_sec: 200, theme: 'cosy' },
  ]

  test('a scene effect straddles its cuts by half its fade, which defaults to a crossfade length', () => {
    const file = normalizeEpisodeEffects({ scenes: [{ scene_id: 's3', effects: [{ uid: 'a', id: 'snow' }] }] })
    const { entries } = resolveEpisodeEffectStack({ file, library, windows, duration: 300 })
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0]!.document.timing, {
      start_sec: 130 - DEFAULT_SCENE_FADE_SEC / 2, end_sec: 200 + DEFAULT_SCENE_FADE_SEC / 2,
      fade_in_sec: DEFAULT_SCENE_FADE_SEC, fade_out_sec: DEFAULT_SCENE_FADE_SEC,
    })
    assert.equal(entries[0]!.scope, 'scene')
  })

  test('consecutive scenes of a theme share one window, so the rain does not dip at the cut', () => {
    const file = normalizeEpisodeEffects({ themes: [{ theme: 'Rainy', effects: [{ uid: 'r', id: 'rain', fade_in_sec: 4, fade_out_sec: 4 }] }] })
    const { entries } = resolveEpisodeEffectStack({ file, library, windows, duration: 300 })
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.document.timing.start_sec, 8)
    assert.equal(entries[0]!.document.timing.end_sec, 132)
  })

  test('a scene that left the plan is skipped with a sentence, not silently', () => {
    const file = normalizeEpisodeEffects({ scenes: [{ scene_id: 'gone', effects: [{ uid: 'a', id: 'rain' }] }] })
    const result = resolveEpisodeEffectStack({ file, library, windows, duration: 300 })
    assert.equal(result.entries.length, 0)
    assert.match(result.notes[0]!, /scene "gone" skipped: that scene is no longer in this episode's Scene Plan/)
  })

  test('layer groups order the stack unless Custom order is on', () => {
    const effects = [{ uid: 'v', id: 'vignette-soft' }, { uid: 'r', id: 'rain' }, { uid: 'g', id: 'colour-grade-look' }]
    const grouped = resolveEpisodeEffectStack({ file: normalizeEpisodeEffects({ episode: effects }), library, windows, duration: 300 })
    assert.deepEqual(grouped.entries.map(e => e.uid), ['g', 'r', 'v'])
    const custom = resolveEpisodeEffectStack({ file: normalizeEpisodeEffects({ episode: effects, custom_order: true }), library, windows, duration: 300 })
    assert.deepEqual(custom.entries.map(e => e.uid), ['v', 'r', 'g'])
  })

  test('Custom order places a scene effect under the whole-episode stack when its order says so', () => {
    const file = normalizeEpisodeEffects({
      custom_order: true,
      episode: [{ uid: 'fog', id: 'ground-mist', order: 10 }],
      scenes: [{ scene_id: 's1', effects: [{ uid: 'rain', id: 'rain', order: 5 }] }],
    })
    const custom = resolveEpisodeEffectStack({ file, library, windows, duration: 300 })
    assert.deepEqual(custom.entries.map(e => e.uid), ['rain', 'fog'])
    // In layer groups the same orders only decide places inside a group: weather stays under mist.
    const grouped = resolveEpisodeEffectStack({ file: { ...file, custom_order: false }, library, windows, duration: 300 })
    assert.deepEqual(grouped.entries.map(e => e.uid), ['rain', 'fog'])
    const swapped = normalizeEpisodeEffects({ ...file, custom_order: false, scenes: [{ scene_id: 's1', effects: [{ uid: 'rain', id: 'rain', order: 50 }] }] })
    assert.deepEqual(resolveEpisodeEffectStack({ file: swapped, library, windows, duration: 300 }).entries.map(e => e.uid), ['rain', 'fog'])
  })

  test('only the project look\'s new kinds join; a missing pack effect is reported as one', () => {
    const result = resolveEpisodeEffectStack({
      file: normalizeEpisodeEffects({ episode: [{ uid: 'p', id: 'com.example.pack.rain' }] }),
      library, windows, duration: 300,
      projectLook: [{ id: 'vignette-soft', enabled: true }, { id: 'snow', enabled: true }, { id: 'rain', enabled: false }],
    })
    assert.deepEqual(result.entries.map(e => e.id), ['snow'])
    assert.equal(result.entries[0]!.scope, 'project')
    assert.deepEqual(result.unavailable, [{ id: 'com.example.pack.rain', from_content_pack: true }])
  })

  test('params change the effect but can never move its window', () => {
    const file = normalizeEpisodeEffects({ scenes: [{ scene_id: 's1', effects: [{ uid: 'a', id: 'rain', params: { amount: 80, timing: { start_sec: 999 } } }] }] })
    const { entries } = resolveEpisodeEffectStack({ file, library, windows, duration: 300 })
    assert.equal((entries[0]!.document as any).amount, 80)
    assert.equal(entries[0]!.document.timing.start_sec, 9)
  })

  test('the lenient reader drops junk and keeps every good entry', () => {
    const file = normalizeEpisodeEffects({ episode: [null, { id: 'bad id!' }, { id: 'rain' }, { id: 'rain' }], scenes: [{ scene_id: '../x', effects: [{ id: 'snow' }] }] })
    assert.equal(file.episode.length, 2)
    assert.notEqual(file.episode[0]!.uid, file.episode[1]!.uid)
    assert.equal(file.scenes.length, 0)
    assert.deepEqual(normalizeEpisodeEffects(undefined), emptyEpisodeEffects())
  })
})

describe('camera', () => {
  test('a still with no camera move named gets the slow zoom', () => {
    const resolved = resolveVideoAssemblySceneAnimation({ scenes: [] } as any, 3)
    assert.equal(DEFAULT_STILL_CAMERA_MOVE, 'ken-burns')
    assert.equal(resolved.settings.type, 'ken-burns')
    assert.deepEqual(resolved.picks, ['ken-burns', 'ken-burns', 'ken-burns'])
  })

  test('a chosen camera move, including none, is kept', () => {
    const resolved = resolveVideoAssemblySceneAnimation({ scenes: [], scene_animation: { type: 'none' } } as any, 2)
    assert.deepEqual(resolved.picks, ['none', 'none'])
  })
})
