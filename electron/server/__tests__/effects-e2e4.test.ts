/**
 * E2–E4 (1.4.288) — picture-aware moves and effects.
 *
 * - Contract: the new moves and effects validate; old documents are untouched (the golden file
 *   `effects-e2e4-off-golden.test.ts` pins every 1.4.287 effect byte for byte).
 * - Plan: zoom to subject keeps the window inside the picture and never rotates; the guided tour
 *   visits at most three places, closer ones merged, at a gentle speed.
 * - Fallbacks: no analysis, a flat depth map, a hard cut, FFmpeg for a tour — each renders the
 *   move's plain version and says why; nothing ever fails.
 * - Scene analysis (fake Gateway): stale by picture hash, quality rules, the subject chain,
 *   partial on 503, nothing without a switch and a model, only the tasks needed, small uploads.
 * - Pixels: a 3D photo moves near and far the opposite ways; rack focus moves the sharp plane;
 *   an effect following a found part touches nothing outside it.
 * - The render never calls the network: prepareSceneClips with the client set to throw.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'

const execFileAsync = promisify(execFile)
const temp = await useTempDataDir()
after(async () => { await temp.cleanup() })

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const { setAppSetting } = await import('../services/app-settings.js')
for (const binary of ['ffmpeg', 'ffprobe'] as const) {
  const bundled = path.join(repoRoot, 'bundled', 'ffmpeg', binary)
  if (existsSync(bundled)) await setAppSetting(`${binary}_path`, bundled)
}
const ffmpegAvailable = existsSync(path.join(repoRoot, 'bundled', 'ffmpeg', 'ffmpeg'))

const { normalizeSceneMotion, normalizeSceneOverlay, motionNeeds, offeredWithSwitches, isSceneStageOverlay } = await import('../contracts/scene-effects.js')
const { parseSceneMotionDocument, parseSceneOverlayDocument } = await import('../contracts/scene-effects-schema.js')
const { BUILT_IN_OVERLAYS, BUILT_IN_SCENE_MOTIONS, findSceneMotion } = await import('../contracts/scene-effect-presets.js')
const { planStillMotion, TOUR_MAX_SPEED } = await import('../lib/scene-motion-plan.js')
const { compileSceneMotion } = await import('../lib/scene-effect-compiler.js')
const sa = await import('../services/scene-analysis.js')
const { resolveSceneStage, normalizeEpisodeEffects } = await import('../services/episode-effects.js')
const client = await import('../lib/scene-vision-client.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { getFFmpegPath } = await import('../services/ffmpeg-manager.js')

const motion = (id: string) => findSceneMotion(id)!.document
const NEW_MOTIONS = ['depth-gentle', 'depth', 'depth-strong', 'depth-left', 'depth-right', 'rack-focus-gentle', 'rack-focus', 'rack-focus-strong', 'rack-focus-background', 'subject-gentle', 'subject', 'subject-strong', 'subject-pull', 'tour', 'tour-slow']
const NEW_OVERLAYS = ['sky-clouds-real', 'twinkling-stars-sky', 'shooting-star-sky', 'aurora-sky', 'moon-glow-sky', 'caustics-water', 'water-shimmer-real', 'water-ripples', 'ground-mist-real', 'fireflies-plants', 'flame-found', 'fire-glow-found']

function vision(over: Partial<import('../services/scene-analysis.js').SceneVision> = {}): import('../services/scene-analysis.js').SceneVision {
  return {
    scene_id: 's1', depthMap: '/x/s1.depth.png', depth: { p5: 0.05, p50: 0.4, p95: 0.9, range: 0.85 },
    subject: { box: [0.6, 0.3, 0.2, 0.3], source: 'grounding', depth: 0.7 }, points: [[0.05, 0.4, 0.15, 0.2], [0.35, 0.5, 0.1, 0.1]],
    regions: { sky: { file: 's1.sky.png', band: [0, 0.4] } }, key: 'k', ...over,
  }
}

describe('contract', () => {
  test('every new move and effect validates strictly and normalises to itself', () => {
    for (const id of NEW_MOTIONS) {
      const doc = motion(id)
      assert.doesNotThrow(() => parseSceneMotionDocument(doc), id)
      assert.deepEqual(normalizeSceneMotion(JSON.parse(JSON.stringify(doc))), doc, id)
      assert.ok(motionNeeds(doc).length > 0, `${id} needs scene analysis`)
    }
    for (const id of NEW_OVERLAYS) {
      const doc = BUILT_IN_OVERLAYS.find(o => o.id === id)!.document
      assert.ok(doc.follow, `${id} follows a part of the picture`)
      assert.ok(isSceneStageOverlay(doc))
      assert.doesNotThrow(() => parseSceneOverlayDocument(doc), id)
    }
    // Every older move needs nothing; "band" from the parameter panel means "no follow".
    for (const m of BUILT_IN_SCENE_MOTIONS.filter(m => !NEW_MOTIONS.includes(m.id))) assert.deepEqual(motionNeeds(m.document), [], m.id)
    assert.equal('follow' in parseSceneOverlayDocument({ ...BUILT_IN_OVERLAYS.find(o => o.id === 'rain')!.document, follow: 'band' }), false)
    assert.throws(() => parseSceneOverlayDocument({ ...BUILT_IN_OVERLAYS.find(o => o.id === 'rain')!.document, follow: 'moon' }))
  })

  test('the switches decide what a channel is offered (owner: off = hidden)', () => {
    const off = { depth: false, vision: false }
    assert.equal(offeredWithSwitches(motion('depth'), off), false)
    assert.equal(offeredWithSwitches(motion('depth'), { depth: true, vision: false }), true)
    assert.equal(offeredWithSwitches(motion('rack-focus'), { depth: false, vision: true }), false)
    // Zoom to subject works with depth alone (the nearest large thing is a subject).
    assert.equal(offeredWithSwitches(motion('subject'), { depth: true, vision: false }), true)
    assert.equal(offeredWithSwitches(motion('subject'), off), false)
    assert.equal(offeredWithSwitches(BUILT_IN_OVERLAYS.find(o => o.id === 'sky-clouds-real')!.document, { depth: true, vision: false }), false)
    assert.equal(offeredWithSwitches(motion('ken-burns'), off), true)
  })
})

describe('plan: aim and tour', () => {
  const opts = { w: 960, h: 540, fps: 24, duration: 8 }
  test('zoom to subject turns toward the subject as it zooms, never leaves the picture, never rotates', () => {
    for (const target of [[0.95, 0.05], [0.02, 0.98], [0.7, 0.4]] as Array<[number, number]>) {
      const plan = planStillMotion({ ...motion('subject'), aim: { mode: 'subject', target } }, opts)
      assert.ok(plan.supported)
      const frames = (plan as any).frames as Array<{ z: number; cx: number; cy: number; rot: number }>
      assert.equal(frames[0]!.cx, 480)
      for (const f of frames) {
        assert.equal(f.rot, 0)
        const halfW = 960 / f.z / 2, halfH = 540 / f.z / 2
        assert.ok(f.cx - halfW >= -1e-6 && f.cx + halfW <= 960 + 1e-6, 'window inside horizontally')
        assert.ok(f.cy - halfH >= -1e-6 && f.cy + halfH <= 540 + 1e-6, 'window inside vertically')
      }
      const last = frames[frames.length - 1]!
      assert.ok(Math.sign(last.cx - 480) === Math.sign(target[0] - 0.5), 'ends turned toward the subject')
    }
    // FFmpeg draws the same aim through zoompan.
    const vf = compileSceneMotion({ ...motion('subject'), aim: { mode: 'subject', target: [0.7, 0.4] } }, { w: 960, h: 540, fps: 24, duration: 8 }).join(',')
    assert.match(vf, /\+iw\*0\.20000\*min\(1,max\(0,\(zoom-1\)\/0\.080000\)\)/)
    // A library document (no target yet) compiles exactly as the plain zoom.
    assert.deepEqual(compileSceneMotion(motion('subject'), opts), compileSceneMotion(motion('ken-burns'), opts))
  })

  test('the guided tour holds the window inside, moves gently and never rotates', () => {
    const path3: Array<[number, number]> = [[0.1, 0.5], [0.5, 0.3], [0.9, 0.7]]
    const plan = planStillMotion({ ...motion('tour'), aim: { mode: 'tour', target: path3[0], path: path3 } }, opts) as any
    let maxStep = 0
    for (let n = 0; n < plan.frames.length; n++) {
      const f = plan.frames[n]
      assert.equal(f.rot, 0)
      const halfW = 960 / f.z / 2
      assert.ok(f.cx - halfW >= -1e-6 && f.cx + halfW <= 960 + 1e-6)
      if (n) maxStep = Math.max(maxStep, Math.hypot((f.cx - plan.frames[n - 1].cx) / 960, (f.cy - plan.frames[n - 1].cy) / 540) * 24)
    }
    // Eased legs peak at 1.5x their mean speed; the cap is on the mean.
    assert.ok(maxStep <= TOUR_MAX_SPEED * 1.6, `peak speed ${maxStep} per second`)
    assert.ok(plan.frames[0].cx < plan.frames[plan.frames.length - 1].cx, 'left to right')
  })

  test('tour stops: at most three, near ones merged, left to right', () => {
    const stops = sa.tourPoints([0.4, 0.4, 0.2, 0.2], [[0.42, 0.42, 0.1, 0.1], [0.05, 0.1, 0.1, 0.1], [0.8, 0.6, 0.1, 0.1], [0.7, 0.1, 0.1, 0.1], [0, 0, 0.95, 0.95]])
    assert.equal(stops.length, 3)
    assert.deepEqual(stops.map(s => Number(s[0].toFixed(2))), [0.1, 0.5, 0.85])
  })
})

describe('fallbacks never fail a render', () => {
  const blurFocus = findSceneMotion('blur-focus')!.document
  test('no analysis: the plain move, with the reason', () => {
    for (const id of ['subject', 'tour', 'depth', 'rack-focus']) {
      const out = sa.resolveVisionMotion(motion(id), null, { depthAllowed: true, blurFocus })
      assert.equal(out.depth, null)
      assert.equal(out.document.aim, undefined)
      assert.equal(out.document.depth, undefined)
      assert.ok(out.notes.length, id)
    }
    assert.match(sa.resolveVisionMotion(motion('rack-focus'), null, { depthAllowed: true, blurFocus }).notes.join(), /Blur → Focus/)
    assert.deepEqual(sa.resolveVisionMotion(motion('rack-focus'), null, { depthAllowed: true, blurFocus }).document, blurFocus)
    assert.match(sa.resolveVisionMotion(motion('depth'), null, { depthAllowed: true }).notes.join(), /rendered as Zoom in/)
  })

  test('a hard cut, a flat map, FFmpeg for a tour, too few places', () => {
    assert.match(sa.resolveVisionMotion(motion('depth'), vision(), { depthAllowed: false }).notes.join(), /needs a transition between scenes/)
    assert.match(sa.resolveVisionMotion(motion('depth'), vision({ depthMap: null }), { depthAllowed: true }).notes.join(), /too flat/)
    const ffmpegTour = sa.resolveVisionMotion(motion('tour'), vision(), { depthAllowed: true, ffmpeg: true })
    assert.equal(ffmpegTour.document.aim?.mode, 'subject')
    assert.match(ffmpegTour.notes.join(), /native renderer only/)
    const lonely = sa.resolveVisionMotion(motion('tour'), vision({ points: [] }), { depthAllowed: true })
    assert.equal(lonely.document.aim?.mode, 'subject')
    assert.match(lonely.notes.join(), /fewer than two/)
  })

  test('with analysis: aimed at the subject, depth about the subject', () => {
    const aimed = sa.resolveVisionMotion(motion('subject'), vision(), { depthAllowed: true })
    assert.deepEqual(aimed.document.aim, { mode: 'subject', target: [0.7, 0.45] })
    assert.deepEqual(aimed.notes, [])
    const tour = sa.resolveVisionMotion(motion('tour'), vision(), { depthAllowed: true })
    assert.equal(tour.document.aim?.mode, 'tour')
    assert.equal(tour.document.aim?.path?.length, 3)
    const photo = sa.resolveVisionMotion(motion('depth'), vision(), { depthAllowed: true })
    assert.deepEqual(photo.depth?.spec.parallax, { pct: 1, direction: 'in', focus: 0.7, near: 0.9, far: 0.05 })
    assert.equal(photo.document.depth, undefined, 'the camera itself is the plain Zoom in')
    const rack = sa.resolveVisionMotion(motion('rack-focus-background'), vision(), { depthAllowed: true })
    assert.deepEqual(rack.depth?.spec.rack, { from: 0.7, to: 0.05, sigma_px: 6, range: 0.85 })
    // A big subject keeps a 15% margin: the end zoom is held back.
    const big = sa.resolveVisionMotion(motion('subject-strong'), vision({ subject: { box: [0.1, 0.1, 0.8, 0.8], source: 'grounding' } }), { depthAllowed: true })
    assert.ok(big.document.zoom.to_pct <= 100 / (1.15 * 0.8) + 1e-9)
  })

  test('the subject phrase skips style sentences and takes the first clause', () => {
    assert.equal(sa.subjectPhrase('16-bit pixel art scene, retro RPG aesthetic. A narrow cobbled lane at dawn, Marigold Lane still dark.'), 'A narrow cobbled lane at dawn')
    assert.equal(sa.subjectPhrase('A pixel-art interior of a small room. A woman sits in a wooden chair by a window, holding a mug.'), 'A woman sits in a wooden chair by a window')
    assert.equal(sa.subjectPhrase(''), '')
  })
})

describe('scene analysis with a fake Gateway', () => {
  const dir = path.join(temp.dir, 'episode')
  const W = 64, H = 36
  const grey = (fill: (x: number, y: number) => number, w = W, h = H) => {
    const data = Buffer.alloc(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y)
    return sharp(data, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer()
  }
  let still = ''
  let calls: any[] = []
  let reply: (body: any) => { status: number; body: any; headers?: Record<string, string> } = () => ({ status: 500, body: {} })

  test('setup', async () => {
    await fs.mkdir(dir, { recursive: true })
    // Sky blue on top, green ground, a bright orange flame in the middle.
    const rgb = Buffer.alloc(320 * 180 * 3)
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 3
      const c = y < 70 ? [60, 110, 200] : (x > 150 && x < 170 && y > 100 && y < 130) ? [255, 150, 30] : [50, 140, 60]
      rgb.set(c, i)
    }
    still = path.join(dir, 's1.png')
    await sharp(rgb, { raw: { width: 320, height: 180, channels: 3 } }).png().toFile(still)
    await setApiKey('genstudio', 'test-key')
    client._setVisionFetchForTesting((async (_url: any, init: any) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      const r = reply(body)
      return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers })
    }) as any)
  })

  const goodAnswer = async (body: any) => ({
    ...(body.tasks.includes('depth') ? { depth: { png_b64: (await grey((_x, y) => Math.round(y / H * 230))).toString('base64'), w: W, h: H, near: 'bright', range: 0.9 } } : {}),
    ...(body.tasks.includes('subject') ? {
      subject: { box: [0.4, 0.5, 0.2, 0.3], label: 'a flame', score: 0.8, source: 'grounding' },
      points: [{ box: [0.1, 0.6, 0.1, 0.1], label: 'bush' }],
      caption: 'In this image we can see the sky, grass and fire.',
      segments: {
        sky: { png_b64: (await grey((_x, y) => y < 14 ? 255 : 0)).toString('base64'), w: W, h: H, coverage: 0.38 },
        fire: { png_b64: (await grey(() => 255)).toString('base64'), w: W, h: H, coverage: 1 },
        grass: { png_b64: (await grey((_x, y) => y >= 14 ? 255 : 0)).toString('base64'), w: W, h: H, coverage: 0.6 },
        water: null,
      },
    } : {}),
  })

  test('one request per picture, a small JPEG, only the tasks needed; outlines checked', async () => {
    calls = []
    const answers: any[] = []
    reply = () => ({ status: 200, body: answers.shift() })
    answers.push(await goodAnswer({ tasks: ['depth', 'subject', 'points', 'segments'] }))
    const entry = await sa.analyseScene({ episodeDir: dir, sceneId: 's1', stillPath: still, tasks: ['depth', 'subject', 'points', 'segments'], models: { depth: 'studio-hub::d', vision: 'studio-hub::v' }, visualPrompt: 'Pixel art style. A flame burns in a meadow, at night.' })
    assert.equal(calls.length, 1)
    const sent = Buffer.from(calls[0].image.b64, 'base64')
    assert.equal(calls[0].image.mime, 'image/jpeg')
    assert.ok((await sharp(sent).metadata()).width! <= sa.ANALYSIS_LONG_SIDE)
    assert.equal(calls[0].text, 'A flame burns in a meadow')
    assert.deepEqual(calls[0].model, ['studio-hub::d', 'studio-hub::v'])
    assert.equal(entry.depth?.usable, true)
    assert.equal(entry.subject?.source, 'grounding')
    assert.ok(entry.subject?.depth !== undefined)
    // The whole-frame "fire" outline became the bright orange pixels only.
    assert.ok(entry.regions?.fire && entry.regions.fire.coverage < 0.05, JSON.stringify(entry.regions?.fire))
    assert.ok(entry.regions?.glow)
    assert.ok(entry.regions?.sky && entry.regions?.plants)
    assert.equal(entry.regions?.water, null)
    // Saved, and valid only for this picture.
    assert.ok(await sa.readSceneAnalysis(dir, 's1', still))
    assert.deepEqual(sa.tasksNeeded(entry, { depth: true, vision: true }, { depth: 'studio-hub::d', vision: 'studio-hub::v' }), [])
    assert.deepEqual(sa.tasksNeeded(entry, { depth: true, vision: true }, { depth: 'studio-hub::d2', vision: 'studio-hub::v' }), ['depth'])
    assert.deepEqual(sa.tasksNeeded(null, { depth: true, vision: false }, { depth: 'studio-hub::d', vision: 'studio-hub::v' }), ['depth'])
    assert.deepEqual(sa.tasksNeeded(null, { depth: false, vision: false }, { depth: 'studio-hub::d', vision: 'studio-hub::v' }), [])
  })

  test('a replaced picture is not analysed; a flat map is not usable; a doubtful subject falls to depth', async () => {
    const copy = path.join(dir, 's2.png')
    await fs.copyFile(still, copy)
    reply = () => ({ status: 200, body: {
      depth: { png_b64: '', w: W, h: H },
      subject: { box: [0, 0, 1, 1], score: 0.9, source: 'grounding' }, points: [], caption: '', segments: {},
    } })
    // A flat depth map (range under 0.15) is kept but never used.
    const flat = await grey(() => 120)
    reply = () => ({ status: 200, body: { depth: { png_b64: flat.toString('base64'), w: W, h: H }, subject: { box: [0, 0, 1, 1], score: 0.9, source: 'grounding' }, points: [], caption: '', segments: {} } })
    const entry = await sa.analyseScene({ episodeDir: dir, sceneId: 's2', stillPath: copy, tasks: ['depth', 'subject', 'points', 'segments'], models: { depth: 'd', vision: 'v' } })
    assert.equal(entry.depth?.usable, false)
    assert.equal(entry.subject, null, 'a whole-frame box is not a subject, and a flat map gives none')
    assert.equal(sa.visionFromEntry(dir, entry).depthMap, null)
    await sharp({ create: { width: 320, height: 180, channels: 3, background: '#808080' } }).png().toFile(copy)
    assert.equal(await sa.readSceneAnalysis(dir, 's2', copy), null)
  })

  test('the runner: off without a switch or a model, partial on 503, never doubles a request', async () => {
    const key = 'test/EP1'
    const scenes = [{ scene_id: 's1', still, visual_prompt: '' }, { scene_id: 's3', still, visual_prompt: '' }]
    sa.queueSceneAnalysis({ key, episodeDir: dir, context: async () => ({ switches: { depth: false, vision: false }, models: { depth: 'd', vision: 'v' }, scenes }) })
    await sa._sceneAnalysisIdle()
    assert.equal(sa.sceneAnalysisStatus(key).state, 'off')
    sa.queueSceneAnalysis({ key, episodeDir: dir, context: async () => ({ switches: { depth: true, vision: false }, models: { depth: '', vision: '' }, scenes }) })
    await sa._sceneAnalysisIdle()
    assert.equal(sa.sceneAnalysisStatus(key).state, 'off')
    const original = { ...sa.runnerHooks }
    let attempts = 0
    sa.runnerHooks.sleep = async () => {}
    sa.runnerHooks.analyse = async () => { attempts++; throw new client.VisionGatewayError('NO_VISION_ENGINE: no Mac', 503, 'NO_VISION_ENGINE', 30) }
    try {
      sa.queueSceneAnalysis({ key, episodeDir: path.join(temp.dir, 'other'), context: async () => ({ switches: { depth: true, vision: false }, models: { depth: 'd', vision: '' }, scenes }) })
      await sa._sceneAnalysisIdle()
      const status = sa.sceneAnalysisStatus(key)
      assert.equal(status.state, 'partial')
      assert.match(status.message, /no Mac can analyse right now/)
      assert.ok(attempts <= 2 * 4, 'three retries per picture at most, then it stops')
    } finally {
      Object.assign(sa.runnerHooks, original)
    }
  })

  test('E4: found outlines take the place of hand outlines only where none is drawn', async () => {
    const file = normalizeEpisodeEffects({ episode: [{ uid: 'a', id: 'sky-clouds-real' }, { uid: 'b', id: 'flame-found' }, { uid: 'c', id: 'living-region', params: { motion: 'water' } }] })
    const found = (id: string) => id === 's1' ? { sky: { file: 's1.sky.png', band: [0, 0.4] as [number, number] }, fire: { file: 's1.fire.png', band: [0.5, 0.7] as [number, number] } }
      : id === 's3' ? {} : undefined
    const notes: string[] = []
    const byScene = resolveSceneStage(file, BUILT_IN_OVERLAYS, { scenes: [{ scene_id: 's1' }, { scene_id: 's2' }, { scene_id: 's3' }, { scene_id: 's4' }], outlines: ['s2-sky.png'], found, notes })
    const s1 = byScene.get('s1')!, s2 = byScene.get('s2')!
    assert.equal(byScene.get('s3'), undefined, 'analysed, no sky: no clouds drawn in a room')
    assert.equal(byScene.get('s4')![0]!.document.region, undefined, 'not analysed: the effect keeps its own band')
    assert.deepEqual(s1.find(i => i.uid === 'a@s1')!.document.region, { auto: 's1.sky.png', feather_px: 6 })
    assert.deepEqual(s1.find(i => i.uid === 'a@s1')!.band, [0, 0.4])
    assert.deepEqual(s2.find(i => i.uid === 'a@s2')!.document.region, { mask: 's2-sky.png', feather_px: 0 }, 'a hand outline wins')
    assert.ok(s1.find(i => i.uid === 'b@s1'), 'flames found on s1')
    assert.equal(s2.find(i => i.uid === 'b@s2'), undefined, 'no flame found and none drawn: the Living Picture skips s2')
    assert.equal(s1.find(i => i.uid === 'c@s1'), undefined, 'no water found: skipped')
    assert.match(notes.join('\n'), /follows the sky: 1 with a hand outline, 1 with an outline scene analysis found, 1 in its own band \(not analysed\), 1 left out \(no sky in the picture\)/)
    // Without scene analysis the stage is exactly what 1.4.287 resolved.
    const plain = resolveSceneStage(normalizeEpisodeEffects({ episode: [{ uid: 'c', id: 'living-region', params: { motion: 'water' } }] }), BUILT_IN_OVERLAYS, { scenes: [{ scene_id: 's1' }], outlines: ['s1-water.png'] })
    assert.deepEqual(plain.get('s1')![0]!.document.region, { mask: 's1-water.png', feather_px: 0 })
  })
})

async function lumaFrames(file: string, w: number, h: number): Promise<Buffer[]> {
  const { stdout } = await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 27 } as any)
  const buf = stdout as unknown as Buffer
  const size = w * h * 1.5
  const out: Buffer[] = []
  for (let i = 0; i + size <= buf.length; i += size) out.push(buf.subarray(i, i + w * h))
  return out
}

/** The horizontal shift (pixels) that best lines up `b`'s band of rows/columns with `a`'s. */
function bestShift(a: Buffer, b: Buffer, w: number, x0: number, x1: number, y0: number, y1: number): number {
  let best = 0, bestErr = Infinity
  for (let s = -14; s <= 14; s++) {
    let err = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) err += Math.abs(a[y * w + x]! - b[y * w + x + s]!)
    if (err < bestErr) { bestErr = err; best = s }
  }
  return best
}

function sharpness(frame: Buffer, w: number, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0
  for (let y = y0; y < y1; y++) for (let x = x0 + 1; x < x1; x++) sum += Math.abs(frame[y * w + x]! - frame[y * w + x - 1]!)
  return sum
}

describe('depth moves and followed outlines, on real pixels', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
  const { applySceneStage } = await import('../lib/scene-stage.js')
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  const dir = path.join(temp.dir, 'pixels')
  await fs.mkdir(dir, { recursive: true })
  const W = 320, H = 180, FPS = 12, D = 2
  const still = path.join(dir, 'still.png')
  await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:d=1`, '-frames:v', '1', still])
  // Left half near (white), right half far (black).
  const depthMap = path.join(dir, 'depth.png')
  const half = Buffer.alloc(160 * 90)
  for (let y = 0; y < 90; y++) for (let x = 0; x < 80; x++) half[y * 160 + x] = 255
  await sharp(half, { raw: { width: 160, height: 90, channels: 1 } }).png().toFile(depthMap)
  const fit = `scale=${W}:${H},setsar=1,format=yuv420p`
  const lossless = ['-c:v', 'ffv1', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(D), '-an']
  const clip = path.join(dir, 'clip.mkv')
  await runFfmpeg(['-y', '-loop', '1', '-t', String(D), '-i', still, '-vf', fit, ...lossless, clip])
  const renderMaskClip = (png: string, out: string) => runFfmpeg(['-y', '-loop', '1', '-t', String(D), '-i', png, '-vf', fit, ...lossless, out]).then(() => {})
  const stage = (name: string, spec: any, items: any[] = []) => applySceneStage({
    clipPath: clip, outPath: path.join(dir, `${name}.mkv`), stillPath: still, episodeDir: dir, items,
    depth: spec ? { name, map: depthMap, spec } : null,
    w: W, h: H, fps: FPS, duration: D, workDir: dir, encodeArgs: lossless, renderMaskClip, log: () => {},
  })

  test('3D photo: the near half and the far half slide opposite ways', async () => {
    const drawn = await stage('photo', { parallax: { pct: 1.5, direction: 'left', focus: 0.5, near: 1, far: 0 } })
    assert.deepEqual(drawn, ['photo'])
    const frames = await lumaFrames(path.join(dir, 'photo.mkv'), W, H)
    const first = frames[0]!, last = frames[frames.length - 1]!
    const near = bestShift(first, last, W, 30, 130, 40, 140)
    const far = bestShift(first, last, W, 190, 290, 40, 140)
    assert.ok(Math.abs(near) >= 3 && Math.abs(far) >= 3, `near ${near}, far ${far}`)
    assert.ok(Math.sign(near) === -Math.sign(far), `near ${near} and far ${far} move opposite ways`)
  })

  test('rack focus: the sharp plane moves from far to near', async () => {
    const drawn = await stage('rack', { rack: { from: 0, to: 1, sigma_px: 8, range: 1 } })
    assert.deepEqual(drawn, ['rack'])
    const frames = await lumaFrames(path.join(dir, 'rack.mkv'), W, H)
    const first = frames[0]!, last = frames[frames.length - 1]!
    assert.ok(sharpness(first, W, 10, 150, 20, 160) < sharpness(last, W, 10, 150, 20, 160), 'near gets sharper')
    assert.ok(sharpness(first, W, 170, 310, 20, 160) > sharpness(last, W, 170, 310, 20, 160), 'far gets softer')
  })

  test('an effect following a found part draws nothing outside it; with none found it keeps its band', async () => {
    const analysisDir = path.join(dir, sa.SCENE_ANALYSIS_DIR)
    await fs.mkdir(analysisDir, { recursive: true })
    const top = Buffer.alloc(160 * 90)
    for (let y = 0; y < 30; y++) for (let x = 0; x < 160; x++) top[y * 160 + x] = 255
    await sharp(top, { raw: { width: 160, height: 90, channels: 1 } }).png().toFile(path.join(analysisDir, 's1.sky.png'))
    const snow = BUILT_IN_OVERLAYS.find(o => o.id === 'snow')!.document
    const followed = normalizeSceneOverlay({ ...snow, amount: 100, follow: 'sky', region: { auto: 's1.sky.png', feather_px: 0 } })
    assert.deepEqual(await stage('followed', null, [{ uid: 'a', name: 'Snow', document: followed, band: [0, 0.33] }]), ['Snow'])
    const base = (await lumaFrames(clip, W, H))[0]!
    let inside = 0
    for (const frame of await lumaFrames(path.join(dir, 'followed.mkv'), W, H)) {
      for (let i = 0; i < frame.length; i++) {
        if (Math.floor(i / W) > H * 0.4) assert.equal(frame[i], base[i], 'nothing changes below the found sky')
        else inside += Math.abs(frame[i]! - base[i]!)
      }
    }
    assert.ok(inside > 0)
    const band = await stage('band', null, [{ uid: 'b', name: 'Snow', document: normalizeSceneOverlay({ ...snow, amount: 100, follow: 'sky' }) }])
    assert.deepEqual(band, ['Snow (its own band: nothing to follow found)'])
  })
})

describe('the render never calls the network', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
  test('prepareSceneClips with depth moves, a vision map and the client set to throw', async () => {
    client._setVisionFetchForTesting((async () => { throw new Error('the render called the network') }) as any)
    const { prepareSceneClips } = await import('../generators/video.js')
    const dir = path.join(temp.dir, 'render')
    await fs.mkdir(path.join(dir, sa.SCENE_ANALYSIS_DIR), { recursive: true })
    const still = path.join(dir, 's.png')
    await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=1', '-frames:v', '1', still])
    const depthMap = path.join(dir, sa.SCENE_ANALYSIS_DIR, 's1.depth.png')
    await sharp(Buffer.alloc(160 * 90, 200), { raw: { width: 160, height: 90, channels: 1 } }).png().toFile(depthMap)
    const v = vision({ depthMap, regions: {} })
    const job: any = { job_id: 'j', output_lines: [], params: {} }
    const clips = await prepareSceneClips(
      [{ image_path: still, duration: 1, plan_scene_id: 's1' } as any, { image_path: still, duration: 1, plan_scene_id: 's2' } as any],
      { type: 'depth' } as any, { enabled: false } as any, 320, 180, { crf: 18, preset: 'medium', fps: 12 }, dir, false,
      { seconds_per_scene: 1, shuffle: false, excluded_scenes: [] } as any, job,
      { pool: [], randomizeMode: 'off', vision: new Map([['s1', v]]), native: { enabled: true, probe: async () => ({ available: false, reason: 'test' }) } },
      [1, 1], 0.5, BUILT_IN_SCENE_MOTIONS as any,
    )
    assert.equal(clips.length, 2)
    const lines = job.output_lines.join('\n')
    assert.match(lines, /\[living: 3D photo\]/)
    assert.match(lines, /Scene 2: 3D photo needs a depth map \(scene not analysed\), rendered as Zoom in/)
  })
})

describe('previews: the gallery ships its own analysed picture', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
  const express = (await import('express')).default
  const request = (await import('supertest')).default
  const { router: effectsRouter } = await import('../routes/effects-library.js')
  const app = express()
  app.use(express.json())
  app.use('/api', effectsRouter)
  test('the sample pictures still match their analysis', async () => {
    for (const id of ['sample-river', 'sample-firepit']) {
      const dir = path.join(repoRoot, 'electron', 'server', 'effects-gallery')
      const entry = await sa.readSceneAnalysis(dir, id, path.join(dir, `${id}.jpg`))
      assert.ok(entry, `${id} analysis matches its picture`)
      assert.ok(entry!.depth?.usable, `${id} depth usable`)
    }
  })
  for (const [kind, id] of [['motion', 'depth'], ['motion', 'subject'], ['overlay', 'sky-clouds-real'], ['overlay', 'fire-glow-found']] as const) {
    test(`${kind} ${id} previews with no episode`, async () => {
      const res = await request(app).get(`/api/projects/none/effects-library/-/gallery/${kind}/${id}`).buffer(true).parse((r, cb) => { const parts: Buffer[] = []; r.on('data', (c: Buffer) => parts.push(c)); r.on('end', () => cb(null, Buffer.concat(parts))) })
      assert.equal(res.status, 200, String(res.body).slice(0, 300))
      assert.ok((res.body as Buffer).length > 1000)
    })
  }
})
