/**
 * 1.4.284 — living pictures and effects clipped to an outline.
 *
 * - Off by default: an overlay without `region` normalises exactly as before,
 *   and an episode without these effects resolves the same stack.
 * - Outlines: shapes rasterise correctly; an uploaded outline is checked for
 *   colour, emptiness and the scene picture's shape.
 * - Pixels: inside the outline the picture moves, outside it every pixel is
 *   the scene clip's own pixel on every frame (lossless check).
 * - A missing outline draws nothing and says so; it never fails the render.
 * - Routes: upload, refusal by name, and Render Exact Preview with a living picture.
 *
 * FFmpeg parts are skipped — not failed — when the bundled FFmpeg is absent.
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

const { normalizeSceneOverlay, isSceneStageOverlay, defaultAtmosphereLoop } = await import('../contracts/scene-effects.js')
const { parseSceneOverlayDocument } = await import('../contracts/scene-effects-schema.js')
const { BUILT_IN_OVERLAYS } = await import('../contracts/scene-effect-presets.js')
const { resolveEpisodeEffectStack, resolveSceneStage, normalizeEpisodeEffects } = await import('../services/episode-effects.js')
const { rasterizeShapes, outlineProblems } = await import('../services/outline-masks.js')
const { getFFmpegPath } = await import('../services/ffmpeg-manager.js')

describe('contract', () => {
  test('an overlay without an outline normalises exactly as before; one with an outline keeps it', () => {
    const rain = normalizeSceneOverlay(defaultAtmosphereLoop('rain'))
    assert.equal('region' in rain, false)
    assert.equal(isSceneStageOverlay(rain), false)
    const outlined = normalizeSceneOverlay({ ...rain, region: { mask: 's1-window.png' } })
    assert.deepEqual(outlined.region, { mask: 's1-window.png', feather_px: 0 })
    assert.equal(isSceneStageOverlay(outlined), true)
    // Junk outlines are dropped, never half-kept.
    assert.equal('region' in normalizeSceneOverlay({ ...rain, region: { mask: '../x.png' } }), false)
    const shaped = normalizeSceneOverlay({ kind: 'living-region', region: { shapes: [{ type: 'ellipse', cx: 0.5, cy: 0.5, rx: 2, ry: 0.1 }] } })
    assert.deepEqual(shaped.region, { shapes: [{ type: 'ellipse', cx: 0.5, cy: 0.5, rx: 1, ry: 0.1 }], feather_px: 8 })
  })

  test('the strict schema names a bad outline and a bad living motion', () => {
    assert.throws(() => parseSceneOverlayDocument({ ...normalizeSceneOverlay({ kind: 'living-region' }), motion: 'lava' }), /motion/)
    assert.throws(() => parseSceneOverlayDocument({ ...normalizeSceneOverlay({ kind: 'living-region' }), region: {} }), /outline needs a mask image or at least one shape/)
    const ok = parseSceneOverlayDocument({ ...normalizeSceneOverlay({ kind: 'living-region' }), region: { shapes: [{ type: 'polygon', points: [[0, 0], [1, 0], [0.5, 1]] }] } })
    assert.equal(ok.kind, 'living-region')
  })

  test('living pictures and outlined effects leave the timeline stack and join their scene', () => {
    const file = normalizeEpisodeEffects({
      episode: [{ uid: 'e', id: 'living-region', params: { region: { mask: 'a.png' } } }, { uid: 'v', id: 'vignette-soft' }],
      scenes: [{ scene_id: 's1', effects: [
        { uid: 'snow', id: 'snow', params: { region: { mask: 's1-window.png' } } },
        { uid: 'flame', id: 'living-region', params: { motion: 'flame', region: { mask: 's1-flame.png' } } },
        { uid: 'rain', id: 'rain' },
      ] }],
    })
    const stack = resolveEpisodeEffectStack({ file, library: BUILT_IN_OVERLAYS, windows: [{ scene_id: 's1', start_sec: 0, end_sec: 10 }], duration: 10 })
    assert.deepEqual(stack.entries.map(e => e.uid), ['rain', 'v'])
    assert.match(stack.notes.join('\n'), /Living Picture skipped on the episode: an outline belongs to one scene's picture/)
    const stage = resolveSceneStage(file, BUILT_IN_OVERLAYS)
    // Layer groups: the living picture (far atmosphere) under the snow (weather).
    assert.deepEqual(stage.get('s1')!.map(item => item.uid), ['flame', 'snow'])
  })
})

describe('outlines', () => {
  test('shapes rasterise: ellipse, rect and an even-odd polygon', () => {
    const W = 20, H = 10
    const at = (buf: Buffer, x: number, y: number) => buf[y * W + x]
    const ellipse = rasterizeShapes([{ type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.4 }], W, H)
    assert.equal(at(ellipse, 10, 5), 255)
    assert.equal(at(ellipse, 1, 5), 0)
    const rect = rasterizeShapes([{ type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5 }], W, H)
    assert.equal(at(rect, 2, 2), 255)
    assert.equal(at(rect, 15, 8), 0)
    const tri = rasterizeShapes([{ type: 'polygon', points: [[0, 1], [1, 1], [0.5, 0]] }], W, H)
    assert.equal(at(tri, 10, 8), 255)
    assert.equal(at(tri, 1, 1), 0)
  })

  test('an outline is refused for colour, emptiness, a full frame, size and the wrong shape', () => {
    const good = { width: 960, height: 540, coverage: 0.1, edge_share: 0.02, colour: false }
    assert.deepEqual(outlineProblems(good, { width: 1920, height: 1080 }), [])
    assert.match(outlineProblems({ ...good, colour: true }).join(' '), /black and white/)
    assert.match(outlineProblems({ ...good, coverage: 0 }).join(' '), /empty/)
    assert.match(outlineProblems({ ...good, coverage: 0.99 }).join(' '), /whole picture/)
    assert.match(outlineProblems({ ...good, width: 32, height: 18 }).join(' '), /between 64 and 8192/)
    assert.match(outlineProblems(good, { width: 1024, height: 1024 }).join(' '), /lines up/)
  })
})

async function makeStill(file: string, w = 320, h = 180): Promise<void> {
  await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:d=1`, '-frames:v', '1', file])
}

/**
 * The luma plane of every frame, read as stored (yuv420p, no conversion): a
 * grey conversion would follow the colour tags, and a staged clip is tagged
 * bt709 where the fixture clip is untagged.
 */
async function frames(file: string, w: number, h: number): Promise<Buffer[]> {
  const { stdout } = await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 27 } as any)
  const buf = stdout as unknown as Buffer
  const size = w * h * 1.5
  const out: Buffer[] = []
  for (let i = 0; i + size <= buf.length; i += size) out.push(buf.subarray(i, i + w * h))
  return out
}

describe('the scene stage, on real pixels', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
  const { applySceneStage } = await import('../lib/scene-stage.js')
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  const dir = path.join(temp.dir, 'stage')
  await fs.mkdir(dir, { recursive: true })
  const W = 320, H = 180, FPS = 12, D = 2
  const still = path.join(dir, 'still.png')
  await makeStill(still)
  const fit = `scale=${W}:${H},setsar=1,format=yuv420p`
  // Lossless, so "untouched" can be checked pixel for pixel.
  const lossless = ['-c:v', 'ffv1', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(D), '-an']
  const clip = path.join(dir, 'clip.mkv')
  await runFfmpeg(['-y', '-loop', '1', '-t', String(D), '-i', still, '-vf', fit, ...lossless, clip])
  const renderMaskClip = (png: string, out: string) => runFfmpeg(['-y', '-loop', '1', '-t', String(D), '-i', png, '-vf', fit, ...lossless, out]).then(() => {})
  // Left half moves; nothing right of x = 0.5 (plus the feather) may change.
  const region = { shapes: [{ type: 'rect', x: 0, y: 0, w: 0.4, h: 1 }], feather_px: 4 }

  for (const motion of ['flame', 'glow', 'steam', 'water', 'sky', 'pulse'] as const) {
    test(`${motion}: inside the outline moves, outside it is the clip's own pixel on every frame`, async () => {
      const out = path.join(dir, `${motion}.mkv`)
      const log: string[] = []
      const drawn = await applySceneStage({
        clipPath: clip, outPath: out, stillPath: still, episodeDir: null,
        items: [{ uid: motion, name: motion, document: normalizeSceneOverlay({ kind: 'living-region', motion, strength: 1.5, region }) }],
        w: W, h: H, fps: FPS, duration: D, workDir: dir, encodeArgs: lossless, renderMaskClip, log: line => log.push(line),
      })
      assert.deepEqual(drawn, [motion], log.join('\n'))
      const base = (await frames(clip, W, H))[0]!
      const moved = await frames(out, W, H)
      assert.ok(moved.length >= D * FPS - 1)
      let insideChange = 0
      for (const frame of moved) {
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x
            if (x >= W * 0.5) assert.equal(frame[i], base[i], `pixel ${x},${y} outside the outline changed`)
            else insideChange += Math.abs(frame[i]! - base[i]!)
          }
        }
      }
      assert.ok(insideChange > 0, 'the outlined part should move')
    })
  }

  test('snow clipped to an outline falls only inside it', async () => {
    const out = path.join(dir, 'snow.mkv')
    const snow = BUILT_IN_OVERLAYS.find(o => o.id === 'snow')!.document
    const drawn = await applySceneStage({
      clipPath: clip, outPath: out, stillPath: still, episodeDir: null,
      items: [{ uid: 'snow', name: 'Snow', document: normalizeSceneOverlay({ ...snow, amount: 100, region: { shapes: [{ type: 'rect', x: 0.6, y: 0, w: 0.4, h: 1 }], feather_px: 0 } }) }],
      w: W, h: H, fps: FPS, duration: D, workDir: dir, encodeArgs: lossless, renderMaskClip, log: () => {},
    })
    assert.deepEqual(drawn, ['Snow'])
    const base = (await frames(clip, W, H))[0]!
    let inside = 0
    for (const frame of await frames(out, W, H)) {
      for (let i = 0; i < frame.length; i++) {
        const x = i % W
        if (x < W * 0.55) assert.equal(frame[i], base[i])
        else inside += Math.abs(frame[i]! - base[i]!)
      }
    }
    assert.ok(inside > 0, 'snow should show inside the outline')
  })

  test('a missing outline draws nothing, writes nothing and says why', async () => {
    const out = path.join(dir, 'missing.mkv')
    const log: string[] = []
    const drawn = await applySceneStage({
      clipPath: clip, outPath: out, stillPath: still, episodeDir: dir,
      items: [
        { uid: 'a', name: 'Living Picture', document: normalizeSceneOverlay({ kind: 'living-region', region: { mask: 'gone.png' } }) },
        { uid: 'b', name: 'Living Picture', document: normalizeSceneOverlay({ kind: 'living-region' }) },
      ],
      w: W, h: H, fps: FPS, duration: D, workDir: dir, encodeArgs: lossless, renderMaskClip, log: line => log.push(line),
    })
    assert.deepEqual(drawn, [])
    assert.equal(existsSync(out), false)
    assert.match(log.join('\n'), /outline "gone.png" is missing/)
    assert.match(log.join('\n'), /it has no outline/)
  })

  test('Video Assembly scene clips draw the living picture and log it (FFmpeg path)', async () => {
    const { prepareSceneClips } = await import('../generators/video.js')
    const clipsDir = path.join(dir, 'clips')
    await fs.mkdir(clipsDir, { recursive: true })
    const job: any = { job_id: 'j', output_lines: [], params: {} }
    const byScene = new Map([['s1', [{ uid: 'f', name: 'Living Picture', document: normalizeSceneOverlay({ kind: 'living-region', motion: 'water', strength: 2, region }) }]]])
    const clips = await prepareSceneClips(
      [{ image_path: still, duration: 1, plan_scene_id: 's1' } as any, { image_path: still, duration: 1, plan_scene_id: 's2' } as any],
      { type: 'none' } as any, { enabled: false } as any, W, H, { crf: 18, preset: 'medium', fps: FPS }, clipsDir, false,
      { seconds_per_scene: 1, shuffle: false, excluded_scenes: [] } as any, job,
      { pool: [], randomizeMode: 'off', sceneStage: { byScene, episodeDir: null } },
      [1, 1], 0, [],
    )
    const lines = job.output_lines.join('\n')
    assert.match(lines, /\[living: Living Picture\]/)
    const living = await frames(clips[0]!, W, H)
    const plain = await frames(clips[1]!, W, H)
    let inside = 0, outside = 0
    for (let i = 0; i < living[0]!.length; i++) {
      const d = Math.abs(living[living.length - 1]![i]! - living[0]![i]!)
      if (i % W < W * 0.35) inside += d
      else if (i % W > W * 0.5) outside += d
    }
    assert.ok(inside > outside * 5, `inside ${inside} should move far more than outside ${outside}`)
    assert.equal(plain.length, living.length)
  })
})

describe('Effects Library routes with outlines', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, async () => {
  const { router: videoRouter } = await import('../routes/video.js')
  const { router: effectsRouter } = await import('../routes/effects-library.js')
  const { cachedFileForToken } = await import('../services/preview-cache.js')
  const app = () => {
    const instance = express()
    instance.use(express.json({ limit: '10mb' }))
    instance.use('/api', videoRouter)
    instance.use('/api', effectsRouter)
    return instance
  }
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Living Fixture', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Candle by the window', logline: 'A fixture episode.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ schema_version: 1, scenes: [
    { id: 's1', scene_index: 1, start_sec: 0, end_sec: 30, transcript_segment: 'A candle by the window.' },
  ] }))
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const imagesDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
  await fs.mkdir(imagesDir, { recursive: true })
  await makeStill(path.join(imagesDir, 's1.png'), 640, 360)
  const base = `/api/projects/${project.slug}/effects-library/${episodeId}`
  const pngOf = async (lavfi: string, size = '640x360') => {
    const file = path.join(temp.dir, `upload-${Math.random().toString(36).slice(2)}.png`)
    await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${lavfi}:s=${size}`, '-frames:v', '1', '-vf', 'format=rgb24', file])
    return (await fs.readFile(file)).toString('base64')
  }

  test('an outline uploads, is feathered when hard-edged, and is listed', async () => {
    // A white disc on black: a hard-edged outline.
    const file = path.join(temp.dir, 'disc.png')
    await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360',
      '-frames:v', '1', '-vf', "format=gray,geq=lum='255*lte(pow(X-200,2)+pow(Y-180,2),60*60)'", file])
    const data = (await fs.readFile(file)).toString('base64')
    const res = await request(app()).post(`${base}/outlines`).send({ scene_id: 's1', label: 'Flame', data_base64: data })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.mask, 's1-flame.png')
    assert.equal(res.body.feathered_by_story, true)
    const listed = await request(app()).get(base)
    assert.deepEqual(listed.body.outlines, ['s1-flame.png'])
  })

  test('a colour picture, an empty outline and the wrong shape are refused with the reason', async () => {
    const colour = await request(app()).post(`${base}/outlines`).send({ scene_id: 's1', data_base64: await pngOf('testsrc2=d=1') })
    assert.equal(colour.status, 400)
    assert.match(colour.body.detail, /black and white/)
    const empty = await request(app()).post(`${base}/outlines`).send({ scene_id: 's1', data_base64: await pngOf('color=c=black') })
    assert.match(empty.body.detail, /empty/)
    const square = await request(app()).post(`${base}/outlines`).send({ scene_id: 's1', data_base64: await pngOf('color=c=white', '300x300') })
    assert.match(square.body.detail, /lines up|whole picture/)
    const noScene = await request(app()).post(`${base}/outlines`).send({ data_base64: 'AA==' })
    assert.match(noScene.body.detail, /scene_id is required/)
  })

  test('saving refuses a living picture without an outline, with an outline not uploaded, or outside one scene', async () => {
    const res = await request(app()).put(base).send({
      episode: [{ uid: 'e', id: 'living-region', params: { region: { mask: 's1-flame.png' } } }],
      scenes: [{ scene_id: 's1', effects: [
        { uid: 'a', id: 'living-region' },
        { uid: 'b', id: 'living-region', params: { region: { mask: 's1-nothing.png' } } },
      ] }],
    })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /only works in a single scene's stack/)
    assert.match(res.body.detail, /needs an outline/)
    assert.match(res.body.detail, /"s1-nothing.png", which has not been uploaded/)
    const ok = await request(app()).put(base).send({ scenes: [{ scene_id: 's1', effects: [{ uid: 'a', id: 'living-region', params: { region: { mask: 's1-flame.png' } } }] }] })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
  })

  test('Render Exact Preview draws the living picture over the scene', async () => {
    const res = await request(app()).post(`${base}/exact-preview`).send({
      scene_id: 's1', motion_id: 'none',
      overlays: [{ id: 'living-region', params: { motion: 'flame', region: { mask: 's1-flame.png' } } }],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.living, ['Living picture (flame)'], JSON.stringify(res.body.notes))
    const file = cachedFileForToken(res.body.token)
    assert.ok(file && existsSync(file))
    const all = await frames(file!, 960, 540)
    let disc = 0, corner = 0
    for (let y = 0; y < 540; y++) for (let x = 0; x < 960; x++) {
      const d = Math.abs(all[all.length - 1]![y * 960 + x]! - all[0]![y * 960 + x]!)
      if ((x - 300) ** 2 + (y - 270) ** 2 < 60 ** 2) disc += d
      else if (x > 700) corner += d
    }
    assert.ok(disc > corner * 5, `the outlined disc should move (disc ${disc}, far corner ${corner})`)
  })

  test('the gallery shows Living Picture moving inside a sample oval over the scene', async () => {
    const res = await request(app()).get(`${base}/gallery/overlay/living-region?scene=s1`)
    assert.equal(res.status, 200, res.text)
    assert.match(String(res.headers['content-type']), /video/)
  })

  test('E1: Refresh previews drops the Living Picture tile too', async () => {
    // Only the Living Picture tile was drawn for this scene in this file; before 1.4.287 its key was missed.
    const res = await request(app()).post(`${base}/gallery/refresh`).send({ scene: 's1' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(res.body.dropped >= 1, `the living tile is dropped (dropped ${res.body.dropped})`)
  })

  test('E1: an outline drawn as shapes is drawn at the picture size, checked, feathered and stored like an upload', async () => {
    const res = await request(app()).post(`${base}/outlines`).send({
      scene_id: 's1', label: 'Window', feather_px: 6,
      shapes: [{ type: 'rect', x: 0.6, y: 0.1, w: 0.3, h: 0.4 }, { type: 'polygon', points: [[0.1, 0.9], [0.3, 0.6], [0.5, 0.9]] }],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.mask, 's1-window.png')
    assert.equal(res.body.width, 640)
    assert.ok(res.body.coverage > 0.1 && res.body.coverage < 0.3, `coverage ${res.body.coverage}`)
    assert.ok((await request(app()).get(base)).body.outlines.includes('s1-window.png'))
    const bad = await request(app()).post(`${base}/outlines`).send({ scene_id: 's1', shapes: [{ type: 'polygon', points: [[0, 0]] }] })
    assert.equal(bad.status, 400)
    assert.match(bad.body.detail, /at least one ellipse, rectangle or polygon/)
  })

  test('E1: a Living Picture on the whole episode saves with an outline name, not with one scene\'s outline file', async () => {
    const ok = await request(app()).put(base).send({ episode: [{ uid: 'w', id: 'living-region', params: { motion: 'fire', outline: 'flame' } }] })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const file = normalizeEpisodeEffects(ok.body.file)
    const notes: string[] = []
    const stage = resolveSceneStage(file, BUILT_IN_OVERLAYS, { scenes: [{ scene_id: 's1' }, { scene_id: 's2' }], outlines: ['s1-flame.png'], notes })
    assert.deepEqual(stage.get('s1')?.map(item => item.document.region), [{ mask: 's1-flame.png', feather_px: 0 }])
    assert.equal(stage.has('s2'), false)
    assert.match(notes.join('\n'), /moves 1 of 2 scene\(s\) — the ones with an outline named "flame"; the rest have none and stay still/)
    // Its exact preview uses this scene's outline of that name.
    const preview = await request(app()).post(`${base}/exact-preview`).send({ scene_id: 's1', motion_id: 'none', overlays: [{ id: 'living-region', params: { motion: 'fire', outline: 'flame' } }] })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.deepEqual(preview.body.living, ['Living picture (fire)'], JSON.stringify(preview.body.notes))
  })

  test('E1: the exact preview joins this scene and the next with a transition, through the render\'s builder', async () => {
    const res = await request(app()).post(`${base}/exact-preview`).send({ scene_id: 's1', transition_id: 'ink-bleed', motion_id: 'none', duration_sec: 1.5 })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.duration_sec, 4.5)
    const file = cachedFileForToken(res.body.token)
    assert.ok(file && existsSync(file))
    assert.equal((await frames(file!, 960, 540)).length, 108)
  })
})
