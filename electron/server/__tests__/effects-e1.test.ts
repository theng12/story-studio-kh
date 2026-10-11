/**
 * E1 (1.4.287) — the effects that need no model: bedtime dimming, handheld float, the soft blur
 * dissolve / dip to black / ink and watercolour bleed transitions, the shooting star, halation and
 * the fire-pit living motion. "Everything off renders identically" is `effects-e1-off-golden.test.ts`.
 *
 * FFmpeg parts are skipped — not failed — when the bundled FFmpeg is absent.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { useTempDataDir } from './_helpers.js'

const execFileAsync = promisify(execFile)
const temp = await useTempDataDir()
after(async () => { await temp.cleanup() })
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const FF = path.join(repoRoot, 'bundled', 'ffmpeg', 'ffmpeg')
const ffmpegAvailable = existsSync(FF)

const { normalizeSceneMotion, normalizeSceneOverlay, floatOffset } = await import('../contracts/scene-effects.js')
const { parseSceneOverlayDocument, parseSceneMotionDocument } = await import('../contracts/scene-effects-schema.js')
const { BUILT_IN_SCENE_MOTIONS, BUILT_IN_OVERLAYS, findSceneMotion, findBuiltInOverlay } = await import('../contracts/scene-effect-presets.js')
const { compileLivingRegion, compileSceneMotion, compileSceneOverlay, shootingStarExpressions } = await import('../lib/scene-effect-compiler.js')
const { planStillMotion } = await import('../lib/scene-motion-plan.js')
const { canResumeGraph } = await import('../lib/segmented-render.js')
const { planTransitions, buildEngineTransitionFilterComplex, buildVariableXfadeFilterComplex, fallbackXfadeKeywords } = await import('../lib/transition-filters.js')
const { shootingStarAt, createBleedMatte, loopBakeSize, loopFrameCount } = await import('../contracts/effect-loops.js')
const { shootingStarShape } = await import('../contracts/scene-effects.js')
const { describeEffectStack } = await import('../contracts/effects-look.js')
const { resolveSceneMotionDocument } = await import('../lib/animation-filters.js')

let labels = 0
const opts = (extra: Record<string, unknown> = {}) => ({
  input: '[in]', output: '[out]', allocLabel: () => `[x${labels++}]`, w: 1920, h: 1080, duration: 7200, fps: 24, ...extra,
})

describe('bedtime dimming', () => {
  const doc = findBuiltInOverlay('bedtime-dimming')!.document
  test('the plan\'s defaults, and clamped so the dim always starts before it is full', () => {
    assert.deepEqual({ ...doc, schema_version: undefined, timing: undefined }, {
      kind: 'bedtime-dimming', darken_pct: 25, warmth_pct: 40, desaturate_pct: 10, start_pct: 10, full_pct: 85, schema_version: undefined, timing: undefined,
    })
    const odd = normalizeSceneOverlay({ kind: 'bedtime-dimming', darken_pct: 90, warmth_pct: -5, desaturate_pct: 60, start_pct: 70, full_pct: 40 }) as any
    assert.deepEqual([odd.darken_pct, odd.warmth_pct, odd.desaturate_pct, odd.start_pct, odd.full_pct], [50, 0, 30, 70, 71])
  })

  test('one eq of t (never n), ramping across the story timeline; a resumed render can start mid-way', () => {
    const [statement] = compileSceneOverlay(doc, opts({ timeline: { start: 60, end: 3660 } }))!
    assert.match(statement!, /^\[in\]eq=contrast=.*:eval=frame\[out\]$/)
    // start 10% / full 85% of the 3600 s story after a 60 s intro.
    assert.match(statement!, /clip\(\(t-420\.000\)\/2700\.000\\,0\\,1\)/)
    assert.doesNotMatch(statement!, /\bn\b|\bN\b/)
    assert.ok(canResumeGraph(`[0:v]setpts=PTS-STARTPTS[v0];${statement!.replace('[in]', '[v0]').replace('[out]', '[v1]')};[v1]null[vout]`))
  })

  test('K is 0 before the start and 1 after full: measured on real frames, 25% darker and warmer', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
    const [statement] = compileSceneOverlay(doc, { ...opts(), w: 64, h: 36, duration: 10, timeline: { start: 0, end: 10 } })!
    const graph = `color=c=0x808080:s=64x36:r=10:d=10,format=yuv420p[in];${statement};[out]format=rgb24`
    const { stdout } = await execFileAsync(FF, ['-v', 'error', '-filter_complex', graph, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 } as any)
    const frame = (i: number) => (stdout as unknown as Buffer).subarray(i * 64 * 36 * 3, i * 64 * 36 * 3 + 3)
    const luma = (px: Buffer) => 0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!
    const before = frame(5), after = frame(95)
    assert.ok(Math.abs(luma(before) - 128) < 3, `untouched before the start (${[...before]})`)
    const drop = 1 - luma(after) / luma(before)
    assert.ok(Math.abs(drop - 0.25) < 0.03, `25% darker at full, ±3% (${(drop * 100).toFixed(1)}%)`)
    assert.ok(after[0]! > after[2]! + 10, `warmer at full: red over blue (${[...after]})`)
  })

  test('the look says what it does', () => {
    assert.deepEqual(describeEffectStack({ scene_effects: { enabled: true, overlays: [{ id: 'bedtime-dimming', enabled: true }] } }),
      ['Bedtime dimming: 25% darker and warmer, from 10% to 85% of the episode'])
  })
})

describe('handheld float', () => {
  const float = findSceneMotion('float')!
  test('a family of two, never rotating, valid under the strict schema', () => {
    assert.ok(findSceneMotion('float-gentle'))
    for (const m of [float, findSceneMotion('float-gentle')!]) {
      assert.equal(m.document.spin.rate_rad_per_sec, 0)
      assert.doesNotThrow(() => parseSceneMotionDocument(m.document))
    }
    // An older document gains no float field.
    assert.equal('float' in normalizeSceneMotion(BUILT_IN_SCENE_MOTIONS[0]!.document), false)
  })

  test('the native plan drifts inside the 103% overscan, rot 0, seeded and repeatable', () => {
    const plan = planStillMotion(float.document, { w: 1920, h: 1080, fps: 24, duration: 16 })
    assert.ok(plan.supported)
    let moved = 0
    for (const f of plan.frames) {
      assert.equal(f.rot, 0)
      const half = 1920 / f.z / 2
      assert.ok(f.cx - half >= -1e-6 && f.cx + half <= 1920 + 1e-6, 'the window stays inside the picture')
      moved = Math.max(moved, Math.abs(f.cx - 960))
    }
    assert.ok(moved > 5 && moved < 0.8 / 100 * 1920 + 1, `it drifts, at most 0.8% (${moved.toFixed(1)} px)`)
    assert.deepEqual(planStillMotion(float.document, { w: 1920, h: 1080, fps: 24, duration: 16 }), plan)
    const other = resolveSceneMotionDocument({ type: 'float', params: {} as any, sceneIndex: 3 })
    assert.notDeepEqual(floatOffset(other.float!, 2), floatOffset(float.document.float!, 2), 'each scene drifts its own way')
  })

  test('the FFmpeg chain is the same sum of sines in on/fps, no rotate (pinned)', () => {
    const chain = compileSceneMotion(float.document, { w: 1920, h: 1080, fps: 24, duration: 16 })
    assert.equal(chain.some(token => token.startsWith('rotate')), false)
    const zoompan = chain.find(token => token.startsWith('zoompan'))!
    assert.match(zoompan, /:x='floor\(iw\/2-\(iw\/zoom\/2\)\+iw\*0\.00800\*\(0\.5\*sin\(2\*PI\*on\/24\/9\.0000\+/)
    assert.equal(zoompan.split('sin(').length - 1, 7, 'three sines per axis plus the zoom breath')
  })
})

describe('transitions', () => {
  test('a plan names its boundaries only when one of them has an engine', () => {
    assert.equal('ids' in planTransitions({ clipCount: 4, durationSec: 1.5, primaryId: 'crossfade', pool: [], randomizeMode: 'off' }), false)
    const plan = planTransitions({ clipCount: 4, durationSec: 1.5, primaryId: 'dip-black', pool: [], randomizeMode: 'off' })
    assert.deepEqual(plan.ids, ['dip-black', 'dip-black', 'dip-black'])
    assert.deepEqual(plan.xfadeKeywords, ['fadeblack', 'fadeblack', 'fadeblack'], 'the fallback keyword stays the xfade one')
    assert.deepEqual(fallbackXfadeKeywords(['ink-bleed', 'blur-dissolve', 'dip-black', 'wipe-left']), ['fade', 'fade', 'fadeblack', 'wipeleft'])
  })

  test('the bleed boundary is a masked merge between the untouched parts; the others are xfades', () => {
    const graph = buildEngineTransitionFilterComplex({
      inputDurations: [4, 5, 6, 5], transitionDuration: 1.5, ids: ['ink-bleed', 'blur-dissolve', 'dip-black'], width: 1920, height: 1080, fps: 24,
      matteInput: () => '[4:v]',
    })
    assert.equal(graph.split('maskedmerge').length - 1, 1)
    assert.match(graph, /concat=n=3:v=1:a=0\[m0\]/)
    assert.match(graph, /gblur=sigma=12\.00:enable='gte\(t,3\.500\)'/)
    assert.match(graph, /fade=t=out:st=4\.500:d=0\.600/)
    assert.match(graph, /fade=t=in:st=0\.900:d=0\.600/)
    assert.equal(graph.split('xfade=').length - 1, 2)
    // A matte that will not bake: the bleed becomes a plain crossfade at the same offset.
    const fallback = buildEngineTransitionFilterComplex({ inputDurations: [4, 5], transitionDuration: 1.5, ids: ['ink-bleed'], width: 320, height: 180, fps: 24, matteInput: () => null })
    assert.match(fallback, /xfade=transition=fade:duration=1\.5:offset=2\.500\[vout\]/)
  })

  test('the matte grows from black to white', () => {
    for (const variant of ['ink', 'watercolour'] as const) {
      const matte = createBleedMatte(variant, 96, 54, 36)
      const out = new Uint8Array(96 * 54)
      const mean = (i: number) => { matte.draw(i, out); return out.reduce((a, b) => a + b, 0) / out.length }
      assert.equal(mean(0), 0)
      assert.equal(mean(35), 255)
      const mid = mean(18)
      assert.ok(mid > 60 && mid < 200, `${variant} half covered at the middle (${mid.toFixed(0)})`)
    }
  })

  test('every engine boundary keeps the chunk the same length as the xfade chunk, to the frame', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
    const { bakeTransitionMatte } = await import('../lib/effect-loop-baker.js')
    const durations = [4.3, 3.7, 5.1]
    const clips: string[] = []
    for (const [i, d] of durations.entries()) {
      const clip = path.join(temp.dir, `tx${i}.mp4`)
      await execFileAsync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=160x90:r=24:d=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip])
      clips.push(clip)
    }
    const count = async (graph: string, extra: string[] = []) => {
      const out = path.join(temp.dir, `tx-${Math.random().toString(36).slice(2)}.mp4`)
      await execFileAsync(FF, ['-v', 'error', '-y', ...clips.flatMap(c => ['-i', c]), ...extra, '-filter_complex', graph, '-map', '[vout]',
        '-c:v', 'libx264', '-r', '24', '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', out])
      const { stdout } = await execFileAsync(FF.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out])
      return Number(String(stdout).trim())
    }
    const plain = await count(buildVariableXfadeFilterComplex({ inputDurations: durations, transitionDuration: 1.5, xfadeKeywords: ['fade', 'fade'] }))
    const matte = await bakeTransitionMatte('ink', 160, 90, 24, 1.5)
    for (const ids of [['dip-black', 'blur-dissolve'], ['ink-bleed', 'watercolour-bleed'], ['ink-bleed', 'dip-black']]) {
      const graph = buildEngineTransitionFilterComplex({ inputDurations: durations, transitionDuration: 1.5, ids, width: 160, height: 90, fps: 24, matteInput: b => `[${3 + b}:v]` })
      assert.equal(await count(graph, ['-i', matte, '-i', matte]), plain, ids.join(' + '))
    }
  })
})

describe('shooting star', () => {
  const doc = normalizeSceneOverlay({ kind: 'shooting-star', period_sec: 4, chance: 0.7, seed: 3, size: 0.5, region_top: 0, region_bottom: 0.6 }) as any
  test('about one every three minutes by default, in the sky band, and never a fixed loop', () => {
    const d = findBuiltInOverlay('shooting-star')!.document as any
    assert.deepEqual([d.period_sec, d.chance, d.region_top, d.region_bottom], [90, 0.5, 0, 0.4])
    assert.doesNotThrow(() => parseSceneOverlayDocument(d))
    const starts = new Set<number>()
    for (let t = 0; t < 3600; t += 0.5) { const s = shootingStarAt(t, 90, 0.5, 7, 1.2); if (s && s.phase < 0.5 / 1.2) starts.add(Math.floor(t / 90)) }
    assert.ok(starts.size > 10 && starts.size < 30, `about one every three minutes over an hour (${starts.size})`)
  })

  test('the render puts the star where and when the preview does (hash parity, real frames)', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
    const W = 320, H = 180, fps = 24
    const box = loopBakeSize(shootingStarShape(doc), W, H)
    const life = loopFrameCount(shootingStarShape(doc), fps) / fps
    const statements = compileSceneOverlay(doc, { ...opts(), w: W, h: H, duration: 16, fps, loopInput: () => '[1:v]' })!
    const graph = [`[0:v]format=yuv420p[in]`, ...statements, `[out]format=gray`].join(';')
    const { stdout } = await execFileAsync(FF, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=16`,
      '-f', 'lavfi', '-i', `color=c=white:s=${box.w}x${box.h}:r=${fps}`, '-filter_complex', graph, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 } as any)
    const frames = stdout as unknown as Buffer
    let lit = 0
    for (let n = 0; n < 16 * fps; n++) {
      const t = n / fps
      const star = shootingStarAt(t, doc.period_sec, doc.chance, doc.seed, life)
      const frame = frames.subarray(n * W * H, (n + 1) * W * H)
      const sum = frame.reduce((a, b) => a + b, 0)
      if (!star) { assert.equal(sum, 0, `nothing drawn at ${t.toFixed(3)} s`); continue }
      const x = Math.round(star.x * (W - box.w) + box.w / 2), y = Math.round(star.y * (doc.region_bottom * H - box.h) + box.h / 2)
      assert.ok(frame[y * W + x]! > 200, `the box is at the hashed place at ${t.toFixed(3)} s`)
      lit++
    }
    assert.ok(lit > 0, 'at least one star in 16 s')
    assert.ok(shootingStarExpressions(doc, W, H, fps).enable.includes('lt(ld(1),0.7000)'))
  })
})

describe('halation and the presets', () => {
  test('a tinted bloom lays a colour layer over the picture; the plain bloom is untouched', () => {
    const halation = findBuiltInOverlay('halation')!.document
    const statements = compileSceneOverlay(halation, opts())!.join(';')
    assert.match(statements, /color=c=0xFF6A3D/)
    assert.match(statements, /alphamerge/)
    assert.equal('color_hex' in findBuiltInOverlay('bloom-glow')!.document, false)
    for (const id of ['bloom-gentle', 'water-shimmer', 'aurora', 'moon-glow', 'sky-clouds', 'caustics', 'window-drops', 'paper-texture', 'film-dust']) {
      assert.doesNotThrow(() => parseSceneOverlayDocument(findBuiltInOverlay(id)!.document), id)
    }
    assert.equal(BUILT_IN_OVERLAYS.filter(o => o.id === 'halation').length, 1)
  })
})

describe('fire-pit living motion', () => {
  test('coarser and slower than the candle flame: the mock-up\'s Y/16, Y/29, X/13 and 2.3/5.9/11.1 Hz', () => {
    const fire = normalizeSceneOverlay({ kind: 'living-region', motion: 'fire', region: { mask: 's-flame.png' } }) as any
    let n = 0
    const graph = compileLivingRegion(fire, { input: '[a]', output: '[b]', allocLabel: () => `[l${n++}]`, w: 960, h: 540, fps: 24, duration: 6 }).join(';')
    for (const term of ['Y/16-T*2.8000', 'Y/29+T*1.7000', 'X/13+T*2.2000', 'Y/20-T*3.6000', 't*2.3000', 't*5.9000', 't*11.1000']) {
      assert.ok(graph.includes(term), term)
    }
    assert.ok(!graph.includes('Y/12'), 'not the candle flame\'s fine ripple')
  })
})
