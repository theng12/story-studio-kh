/**
 * Effects Library v1, rendered for real.
 *
 * Pixels, not strings: every new effect must CHANGE the picture through the
 * real preview endpoint; a baked loop must be a real, seamless, cached clip;
 * a scene effect must be visible inside its window and absent outside it; and
 * the Effects Library routes must save, refuse and preview an episode's stacks
 * against a real project folder.
 *
 * Skipped — not failed — when the bundled FFmpeg is absent.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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

const { getFFmpegPath, getFFprobePath } = await import('../services/ffmpeg-manager.js')
const { cachedFileForToken } = await import('../services/preview-cache.js')
const { router: videoRouter } = await import('../routes/video.js')
const { router: effectsRouter } = await import('../routes/effects-library.js')
const { bakeEffectLoop } = await import('../lib/effect-loop-baker.js')
const { defaultLoopShape } = await import('../contracts/effect-loops.js')
const { defaultAtmosphereLoop, LIBRARY_V1_5_KINDS } = await import('../contracts/scene-effects.js')
const { BUILT_IN_OVERLAYS } = await import('../contracts/scene-effect-presets.js')
const { compileSceneOverlay, overlayLoopShapes } = await import('../lib/scene-effect-compiler.js')
const { loopShapeKey } = await import('../contracts/effect-loops.js')

function app() {
  const instance = express()
  instance.use(express.json({ limit: '1mb' }))
  instance.use('/api', videoRouter)
  instance.use('/api', effectsRouter)
  return instance
}

/** One frame as 64x36 grey bytes. */
async function grey(file: string, atSeconds: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(await getFFmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-ss', String(atSeconds), '-frames:v', '1',
    '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { encoding: 'buffer', maxBuffer: 1 << 20 } as any)
  return stdout as unknown as Buffer
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length)
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

async function preview(body: Record<string, unknown>): Promise<string> {
  const res = await request(app()).post('/api/projects/demo/video-editor/preview-effect').send(body)
  assert.equal(res.status, 200, `preview failed: ${JSON.stringify(res.body)}`)
  const file = cachedFileForToken(res.body.token)
  assert.ok(file)
  return file!
}

/** Params that make an effect show on the flat synthetic gradient within 3 s. */
const VISIBLE_ON_GRADIENT: Record<string, Record<string, unknown>> = {
  'bloom-glow': { threshold: 0.3, strength: 0.8 },
  'lightning-flash': { period_sec: 2, chance: 1, strength: 1 },
  'candle-flicker': { amount: 0.2 },
  'shimmer-ripple': { strength_px: 16, region_top: 0, region_bottom: 1 },
  'colour-grade-look': { preset: 'noir' },
  // E1 (1.4.287)
  halation: { threshold: 0.3, strength: 0.8 },
  'bloom-gentle': { threshold: 0.3, strength: 0.8 },
  'water-shimmer': { strength_px: 16, region_top: 0, region_bottom: 1 },
  'shooting-star': { period_sec: 4, chance: 1, size: 2 },
  'bedtime-dimming': { darken_pct: 50, start_pct: 0, full_pct: 20 },
}

describe('every v1.5 effect changes the picture', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, () => {
  // E4 (1.4.288) effects that follow the picture are drawn on scene clips; `effects-e2e4.test.ts` covers them.
  const fresh = BUILT_IN_OVERLAYS.filter(entry => LIBRARY_V1_5_KINDS.includes(entry.document.kind) && !entry.document.follow)
  // 16 in 1.5, then E1 (1.4.287): shooting star, aurora, moon glow, sky clouds, caustics, window
  // drops, paper, film dust, halation, gentle bloom, surface shimmer, bedtime dimming.
  test('there are twenty-eight of them', () => assert.equal(fresh.length, 28))
  for (const entry of fresh) {
    test(entry.id, async () => {
      const base = await preview({ overlays: [] })
      const file = await preview({ overlays: [{ id: entry.id, params: VISIBLE_ON_GRADIENT[entry.id] || {} }] })
      // Lightning and flicker vary over time; compare several moments and keep the largest change.
      let biggest = 0
      for (const at of [0.5, 1.2, 1.9, 2.6]) biggest = Math.max(biggest, meanAbsDiff(await grey(base, at), await grey(file, at)))
      // A displacement barely moves a smooth gradient; any change proves the graph ran.
      const floor = entry.id === 'shimmer-ripple' || entry.id === 'water-shimmer' ? 0.1 : entry.id === 'shooting-star' ? 0.02 : 0.4
      assert.ok(biggest > floor, `${entry.id} changed the picture by only ${biggest.toFixed(3)} grey levels`)
    })
  }
})

describe('baked loops', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, () => {
  test('a loop bakes once to a grey clip of exactly one loop, then comes from the cache', async () => {
    const shape = defaultLoopShape('rain')
    const first = await bakeEffectLoop(shape, 320, 180, 24)
    assert.equal(first.baked, true)
    assert.ok(first.path.startsWith(temp.dir), 'loops are written inside the data dir')
    const { stdout } = await execFileAsync(await getFFprobePath(), [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=width,height,nb_read_frames,pix_fmt', '-of', 'json', first.path,
    ])
    const stream = JSON.parse(stdout).streams[0]
    assert.equal(stream.width, 320)
    assert.equal(stream.height, 180)
    assert.equal(Number(stream.nb_read_frames), 48)
    // x264 stores the grey mask as full-range luma (its 4:0:0 needs a High
    // profile this build does not pick); only the luma plane is ever read.
    assert.ok(['gray', 'yuvj420p'].includes(stream.pix_fmt), stream.pix_fmt)
    const second = await bakeEffectLoop(shape, 320, 180, 24)
    assert.equal(second.baked, false)
    assert.equal(second.path, first.path)
  })

  test('concurrent requests for the same loop share one bake', async () => {
    const shape = { ...defaultLoopShape('snow'), seed: 4242 }
    const [a, b] = await Promise.all([bakeEffectLoop(shape, 320, 180, 24), bakeEffectLoop(shape, 320, 180, 24)])
    assert.equal(a.path, b.path)
  })
})

describe('a scene effect lives in its window and fades', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, () => {
  test('rain from 1 s to 3 s with 1 s fades: absent before, half-strength in the fade, full in the middle', async () => {
    const W = 320, H = 180, D = 4
    const doc = { ...defaultAtmosphereLoop('rain'), opacity: 1, darken: 0, timing: { start_sec: 1, end_sec: 3, fade_in_sec: 1, fade_out_sec: 1 } }
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=${W}x${H}:r=24:d=${D}`]
    const inputs = new Map<string, string>()
    let idx = 1
    for (const shape of overlayLoopShapes(doc)) {
      const baked = await bakeEffectLoop(shape, W, H, 24)
      args.push('-stream_loop', '-1', '-i', baked.path)
      inputs.set(loopShapeKey(shape), `[${idx++}:v]`)
    }
    let n = 0
    const statements = compileSceneOverlay(doc, {
      input: '[0:v]', output: '[v]', allocLabel: () => `[l${n++}]`, w: W, h: H, duration: D, fps: 24,
      loopInput: s => inputs.get(loopShapeKey(s)) ?? null,
    })!
    const out = path.join(temp.dir, 'window.mp4')
    await execFileAsync(await getFFmpegPath(), [...args, '-filter_complex', statements.join(';'), '-map', '[v]', '-t', String(D), '-c:v', 'libx264', '-preset', 'ultrafast', out])
    const plain = await grey(out, 0.5)
    const flat = plain.reduce((s, v) => s + v, 0) / plain.length
    const lift = async (at: number) => ((await grey(out, at)).reduce((s, v) => s + v, 0) / plain.length) - flat
    const rampStart = await lift(1.0)
    const middle = await lift(2.0)
    const after = await lift(3.6)
    assert.ok(middle > 1.5, `rain should lift the picture mid-window, lifted ${middle.toFixed(2)}`)
    assert.ok(rampStart < middle * 0.5, `the fade-in should start near zero (${rampStart.toFixed(2)} vs ${middle.toFixed(2)})`)
    assert.ok(Math.abs(after) < 0.3, `nothing after the window, got ${after.toFixed(2)}`)
  })
})

describe('Effects Library routes', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Effects Fixture', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Rain on the porch', logline: 'A fixture episode.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const scenes = [
    { id: 's1', scene_index: 1, start_sec: 0, end_sec: 30, transcript_segment: 'Rain on the porch roof.', theme: 'rainy' },
    { id: 's2', scene_index: 2, start_sec: 30, end_sec: 60, transcript_segment: 'A kettle on the stove.' },
  ]
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ schema_version: 1, scenes }))
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const imagesDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
  await fs.mkdir(imagesDir, { recursive: true })
  await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x334455:s=640x360', '-frames:v', '1', path.join(imagesDir, 's1.png')])
  const base = `/api/projects/${project.slug}/effects-library/${episodeId}`

  test('an episode with no effects reads as an empty stack with its scenes listed', async () => {
    const res = await request(app()).get(base)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.file.episode, [])
    assert.equal(res.body.has_scene_plan, true)
    assert.deepEqual(res.body.scenes.map((s: any) => [s.id, s.theme]), [['s1', 'rainy'], ['s2', null]])
    assert.ok(res.body.overlays.some((o: any) => o.id === 'rain'))
    assert.ok(res.body.effect_stacks.length >= 3)
  })

  test('a valid stack saves beside the scene plan and reads back', async () => {
    const body = {
      custom_order: false,
      episode: [{ uid: 'g', id: 'colour-grade-look', params: { preset: 'cool-moonlight' } }],
      themes: [{ theme: 'rainy', effects: [{ uid: 'r', id: 'rain', params: { amount: 50 } }] }],
      scenes: [{ scene_id: 's2', effects: [{ uid: 'f', id: 'candle-flicker', fade_in_sec: 3 }] }],
    }
    const res = await request(app()).put(base).send(body)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const onDisk = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'scene_effects.json'), 'utf8'))
    assert.equal(onDisk.scenes[0].effects[0].fade_in_sec, 3)
    const again = await request(app()).get(base)
    assert.equal(again.body.file.themes[0].effects[0].params.amount, 50)
  })

  test('unknown effects, impossible fields and scenes not in the plan are refused by name', async () => {
    const res = await request(app()).put(base).send({
      episode: [{ uid: 'a', id: 'hail' }, { uid: 'b', id: 'rain', params: { amount: 900 } }, { uid: 'c', id: 'rain', params: { glitter: true } }],
      scenes: [{ scene_id: 's9', effects: [{ uid: 'd', id: 'snow' }] }],
    })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /"hail" is not in the effects library/)
    assert.match(res.body.detail, /amount/)
    assert.match(res.body.detail, /glitter/)
    assert.match(res.body.detail, /Scene "s9" is not in this episode's Scene Plan/)
    // Nothing was overwritten by the refused save.
    const kept = await request(app()).get(base)
    assert.equal(kept.body.file.episode[0].id, 'colour-grade-look')
  })

  test('Render Exact Preview renders the real graph over the chosen scene at 960x540 for 6 s', async () => {
    const res = await request(app()).post(`${base}/exact-preview`).send({ scene_id: 's1', overlays: [{ id: 'rain' }, { id: 'vignette-soft' }], motion_id: 'ken-burns' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.backdrop, 'scene')
    assert.equal(res.body.width, 960)
    assert.equal(res.body.height, 540)
    assert.equal(res.body.duration_sec, 6)
    assert.ok(typeof res.body.render_ms === 'number')
    assert.match(res.body.token, /\.mp4$/)
    assert.ok(['native', 'ffmpeg'].includes(res.body.camera_engine))
    const file = cachedFileForToken(res.body.token)
    assert.ok(file && existsSync(file))
    const streamed = await request(app()).get(res.body.url.replace(/^\/api/, '/api'))
    assert.equal(streamed.status, 200)
  })

  test('the render reads the saved stack, places it on the composed timeline, and says what it did', async () => {
    const { resolveEpisodeStackForRender } = await import('../generators/video.js')
    const job: any = { output_lines: [] }
    const stack = await resolveEpisodeStackForRender({
      episodeDir: paths.episode_dir,
      windows: scenes.map(s => ({ scene_id: s.id, start_sec: s.start_sec + 10, end_sec: s.end_sec + 10, theme: (s as any).theme ?? null })),
      duration: 90,
      job,
    })
    assert.ok(stack)
    assert.deepEqual(stack!.entries.map(e => [e.id, e.scope]), [['colour-grade-look', 'episode'], ['rain', 'theme'], ['candle-flicker', 'scene']])
    const flicker = stack!.entries.find(e => e.id === 'candle-flicker')!
    assert.equal(flicker.document.timing.start_sec, 40 - 1.5)
    assert.match(job.output_lines.join('\n'), /Effects Library: 3 effect\(s\), in layer groups/)
  })

  test('an episode with nothing in the Effects Library adds nothing to the render', async () => {
    const { resolveEpisodeStackForRender } = await import('../generators/video.js')
    const job: any = { output_lines: [] }
    assert.equal(await resolveEpisodeStackForRender({ episodeDir: temp.dir, windows: [], duration: 60, job }), null)
    assert.deepEqual(job.output_lines, [])
  })

  test('a channel look seeds a NEW episode once, and never touches an episode that has effects', async () => {
    const { seedEpisodeEffectsFromLook, readEpisodeEffects } = await import('../services/episode-effects.js')
    const dir = path.join(temp.dir, 'fresh-episode')
    await fs.mkdir(dir, { recursive: true })
    const saved = [{ id: 'preset-mine', data: { effects: [{ id: 'snow', params: { amount: 12 } }] } }]
    const first = await seedEpisodeEffectsFromLook(dir, ['stack-snowy-cabin', 'preset-mine', 'gone'], saved)
    assert.equal(first.seeded, true)
    assert.deepEqual(first.unknown, ['gone'])
    const file = await readEpisodeEffects(dir)
    assert.deepEqual(file.episode.map(e => e.id), ['colour-grade-look', 'snow', 'candle-flicker', 'vignette-soft', 'snow'])
    assert.equal(file.episode[4]!.params!.amount, 12)
    const again = await seedEpisodeEffectsFromLook(dir, ['stack-rainy-night'], saved)
    assert.equal(again.seeded, false)
    assert.equal((await readEpisodeEffects(dir)).episode.length, 5)
  })

  test('an unreadable stack file stops the render by name instead of rendering without it', async () => {
    const { resolveEpisodeStackForRender } = await import('../generators/video.js')
    const dir = path.join(temp.dir, 'broken-episode')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'scene_effects.json'), '{ not json')
    await assert.rejects(
      resolveEpisodeStackForRender({ episodeDir: dir, windows: [], duration: 60, job: { output_lines: [] } as any }),
      /scene_effects\.json in this episode could not be read/,
    )
  })
})
