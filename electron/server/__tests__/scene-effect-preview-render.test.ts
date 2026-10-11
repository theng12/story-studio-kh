/**
 * The effect library, rendered for real.
 *
 * The Verified Completion Contract is explicit that a function returning
 * without throwing is not evidence. Every other test in this area asserts on
 * strings; this one drives the actual endpoint, lets FFmpeg build the actual
 * filtergraph, and then asks `ffprobe` what came out — and then reads the
 * PIXELS, because a filtergraph that parses and produces a correctly-sized clip
 * can still be a no-op.
 *
 * That last part matters more here than it did for subtitles. Nine of these
 * effects are compositing operations whose only observable result is a change
 * in pixel values; an overlay that silently drew nothing would satisfy every
 * assertion about duration and stream shape.
 *
 * Skipped — not failed — when the FFmpeg build lacks the filter an effect
 * needs. The check is a real capability probe, so a machine that cannot draw
 * text says so instead of reporting a defect that is not there.
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
import { hasDrawtextFilter } from '../lib/ffmpeg-utils.js'
import { getFFmpegPath, getFFprobePath } from '../services/ffmpeg-manager.js'
import { setAppSetting } from '../services/app-settings.js'
import { cachedFileForToken } from '../services/preview-cache.js'
import {
  BUILT_IN_FOOTAGE_MOTIONS,
  BUILT_IN_OVERLAYS,
  BUILT_IN_SCENE_MOTIONS,
  isHiddenMotion,
} from '../contracts/scene-effect-presets.js'
import { offeredWithSwitches } from '../contracts/scene-effects.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { router as videoRouter } from '../routes/video.js'

const execFileAsync = promisify(execFile)

const temp = await useTempDataDir()
after(async () => { await temp.cleanup() })

/**
 * Point FFmpeg at the binary the DMG actually ships.
 *
 * `getFFmpegPath()` finds the bundled build through `process.resourcesPath`,
 * which only exists under Electron — a bare test process falls through to
 * whatever `ffmpeg` is on PATH, and a Homebrew build frequently has neither
 * freetype nor libass (this developer's has neither). Without this the text
 * cases would skip everywhere and prove nothing while the shipped app draws
 * them fine.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
for (const binary of ['ffmpeg', 'ffprobe'] as const) {
  const bundled = path.join(repoRoot, 'bundled', 'ffmpeg', binary)
  if (existsSync(bundled)) await setAppSetting(`${binary}_path`, bundled)
}

function app() {
  const instance = express()
  instance.use(express.json({ limit: '1mb' }))
  instance.use('/api', videoRouter)
  return instance
}

async function probe(file: string): Promise<{ duration: number; width: number; height: number; frames: number }> {
  const { stdout } = await execFileAsync(await getFFprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,nb_read_frames:format=duration',
    '-of', 'json', file,
  ])
  const parsed = JSON.parse(stdout)
  const stream = parsed.streams?.[0] || {}
  // Read fields BY NAME. The v1.1.0 build lost an hour to a scale test that
  // read the wrong field by counting delimiters and reported a 3x bug that did
  // not exist.
  return {
    duration: Number(parsed.format?.duration ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    frames: Number(stream.nb_read_frames ?? 0),
  }
}

/** Mean RGB of one frame, sampled from a rectangle. Pixels, not promises. */
async function sampleFrame(
  file: string, atSeconds: number, box: { x: number; y: number; w: number; h: number },
): Promise<{ r: number; g: number; b: number }> {
  const raw = path.join(temp.dir, `sample-${Math.random().toString(36).slice(2)}.raw`)
  await execFileAsync(await getFFmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    // Seek AFTER the input so the decode is frame-accurate. An input-side seek
    // lands on the previous keyframe, which on a 3-second VP9 clip can be the
    // very first frame — and would have made every timing assertion here a lie.
    '-i', file, '-ss', String(atSeconds), '-frames:v', '1',
    '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw,
  ])
  const bytes = await fs.readFile(raw)
  await fs.rm(raw, { force: true })
  let r = 0, g = 0, b = 0
  for (let i = 0; i < bytes.length; i += 3) { r += bytes[i]!; g += bytes[i + 1]!; b += bytes[i + 2]! }
  const n = bytes.length / 3
  assert.ok(n > 0, 'ffmpeg produced no pixels to sample')
  return { r: r / n, g: g / n, b: b / n }
}

async function renderPreview(body: Record<string, unknown>): Promise<{ token: string; file: string }> {
  const res = await request(app()).post('/api/projects/demo/video-editor/preview-effect').send(body)
  assert.equal(res.status, 200, `preview failed: ${JSON.stringify(res.body)}`)
  const token = res.body.token as string
  assert.match(token, /^[a-f0-9]{20}\.webm$/, 'token must be the cache-safe shape')
  const file = cachedFileForToken(token)
  assert.ok(file, 'the token must resolve to a cached file')
  return { token, file: file! }
}

const ffmpegAvailable = existsSync(path.join(repoRoot, 'bundled', 'ffmpeg', 'ffmpeg'))
const canDrawText = ffmpegAvailable && await hasDrawtextFilter()

describe('every built-in overlay renders a real clip', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, () => {
  for (const entry of BUILT_IN_OVERLAYS) {
    const needsText = entry.document.kind === 'lower-third'
    const needsImage = entry.document.kind === 'corner-logo'
    test(entry.id, { skip: (needsText && !canDrawText) ? 'FFmpeg build has no drawtext' : false }, async () => {
      // The corner logo ships with no image, which compiles to nothing on
      // purpose. Give it a real one so the render path is actually exercised.
      const params: Record<string, unknown> = {}
      if (needsImage) {
        const logo = path.join(temp.dir, 'logo.png')
        await execFileAsync(await getFFmpegPath(), [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'color=c=0xFF0000:s=64x64', '-frames:v', '1', logo,
        ])
        params.image_path = logo
      }
      const { file } = await renderPreview({
        overlays: [{ id: entry.id, ...(Object.keys(params).length ? { params } : {}) }],
      })
      const info = await probe(file)
      assert.equal(info.width, 480, 'preview width')
      assert.equal(info.height, 270, 'preview height')
      assert.ok(info.duration >= 2.8 && info.duration <= 3.3, `duration was ${info.duration}, expected ~3`)
      assert.ok(info.frames >= 60, `only ${info.frames} frames decoded`)
    })
  }
})

describe('overlays actually change the picture', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, () => {
  /** The same clip with no overlay at all, for comparison. */
  async function baseline(): Promise<string> {
    const { file } = await renderPreview({ overlays: [] })
    return file
  }

  test('a vignette darkens the corners and leaves the centre alone', async () => {
    const plain = await baseline()
    const { file } = await renderPreview({ overlays: [{ id: 'vignette-heavy' }] })
    const box = { x: 0, y: 0, w: 60, h: 60 }
    const cornerPlain = await sampleFrame(plain, 1.5, box)
    const cornerVignette = await sampleFrame(file, 1.5, box)
    assert.ok(
      cornerVignette.r + cornerVignette.g + cornerVignette.b < (cornerPlain.r + cornerPlain.g + cornerPlain.b) * 0.75,
      `corner should be markedly darker: ${JSON.stringify(cornerVignette)} vs ${JSON.stringify(cornerPlain)}`,
    )
    const centre = { x: 210, y: 105, w: 60, h: 60 }
    const centrePlain = await sampleFrame(plain, 1.5, centre)
    const centreVignette = await sampleFrame(file, 1.5, centre)
    assert.ok(
      centreVignette.r + centreVignette.g + centreVignette.b > (centrePlain.r + centrePlain.g + centrePlain.b) * 0.85,
      'the centre must not be dimmed like an exposure cut',
    )
  })

  test('a bottom scrim darkens the bottom edge and not the top', async () => {
    const plain = await baseline()
    const { file } = await renderPreview({ overlays: [{ id: 'scrim-bottom' }] })
    const bottom = { x: 200, y: 250, w: 80, h: 18 }
    const top = { x: 200, y: 4, w: 80, h: 18 }
    const bottomPlain = await sampleFrame(plain, 1.5, bottom)
    const bottomScrim = await sampleFrame(file, 1.5, bottom)
    const topPlain = await sampleFrame(plain, 1.5, top)
    const topScrim = await sampleFrame(file, 1.5, top)
    assert.ok(bottomScrim.r < bottomPlain.r * 0.6, `bottom should darken: ${bottomScrim.r} vs ${bottomPlain.r}`)
    assert.ok(Math.abs(topScrim.r - topPlain.r) < 6, `top must be untouched: ${topScrim.r} vs ${topPlain.r}`)
  })

  test('letterbox bars are black at the top and bottom edges', async () => {
    const { file } = await renderPreview({ overlays: [{ id: 'letterbox-235' }] })
    const topBar = await sampleFrame(file, 1.5, { x: 200, y: 2, w: 80, h: 10 })
    const bottomBar = await sampleFrame(file, 1.5, { x: 200, y: 258, w: 80, h: 10 })
    for (const [where, sample] of [['top', topBar], ['bottom', bottomBar]] as const) {
      assert.ok(sample.r < 12 && sample.g < 12 && sample.b < 12,
        `${where} bar should be black, got ${JSON.stringify(sample)}`)
    }
    const picture = await sampleFrame(file, 1.5, { x: 200, y: 120, w: 80, h: 30 })
    assert.ok(picture.r + picture.g + picture.b > 60, 'the picture between the bars must survive')
  })

  test('film grain perturbs a flat area frame to frame', async () => {
    const { file } = await renderPreview({ overlays: [{ id: 'film-grain-heavy' }] })
    const box = { x: 200, y: 120, w: 40, h: 40 }
    const a = await sampleFrame(file, 1.0, box)
    const b = await sampleFrame(file, 2.0, box)
    // Temporal grain re-rolls every frame, so two frames of the same gradient
    // cannot be identical.
    assert.notDeepEqual(a, b, 'temporal grain must differ between frames')
  })

  test('a light leak brightens inside its window and nowhere else', async () => {
    const plain = await baseline()
    const { file } = await renderPreview({
      overlays: [{
        id: 'light-leak-warm',
        params: { from_anchor: 'center', to_anchor: 'center', intensity: 0.9, timing: { start_sec: 1, end_sec: 2 } },
      }],
    })
    const box = { x: 210, y: 105, w: 60, h: 60 }
    const before = await sampleFrame(file, 0.4, box)
    const during = await sampleFrame(file, 1.5, box)
    const untouched = await sampleFrame(plain, 0.4, box)
    assert.ok(Math.abs(before.r - untouched.r) < 8,
      `outside its window the leak must not show: ${before.r} vs ${untouched.r}`)
    assert.ok(during.r > before.r + 25,
      `inside its window the leak must brighten: ${during.r} vs ${before.r}`)
    // Warm leak: red must rise faster than blue, or the colour is wrong even
    // though the brightness moved.
    assert.ok(during.r - before.r > during.b - before.b, 'a warm leak must lean red, not blue')
  })

  test('a corner logo lands in the corner it was told to', async () => {
    const logo = path.join(temp.dir, 'corner-logo.png')
    await execFileAsync(await getFFmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=64x64', '-frames:v', '1', logo,
    ])
    const { file } = await renderPreview({
      overlays: [{ id: 'channel-mark', params: { image_path: logo, anchor: 'top-left', margin_px: 40, opacity: 1 } }],
    })
    // margin_px is a 1080-reference value; at 270 high it scales to 10px.
    const onLogo = await sampleFrame(file, 1.5, { x: 14, y: 14, w: 20, h: 20 })
    const opposite = await sampleFrame(file, 1.5, { x: 440, y: 230, w: 20, h: 20 })
    assert.ok(onLogo.g > 150 && onLogo.r < 120, `expected green logo at top-left, got ${JSON.stringify(onLogo)}`)
    assert.ok(opposite.g < 150, 'the opposite corner must be untouched')
  })

  test('a lower third puts light pixels where it said it would', { skip: !canDrawText && 'FFmpeg build has no drawtext' }, async () => {
    const plain = await baseline()
    const { file } = await renderPreview({
      overlays: [{
        id: 'lower-third-clean',
        params: { title: 'MY CHANNEL', subtitle: 'Sleep Stories', fade_in_ms: 0, fade_out_ms: 0 },
      }],
    })
    const band = { x: 10, y: 180, w: 220, h: 80 }
    const before = await sampleFrame(plain, 1.5, band)
    const after = await sampleFrame(file, 1.5, band)
    assert.notEqual(Math.round(after.r), Math.round(before.r), 'the lower third must alter its band')
    const top = { x: 200, y: 4, w: 80, h: 18 }
    const topBefore = await sampleFrame(plain, 1.5, top)
    const topAfter = await sampleFrame(file, 1.5, top)
    assert.ok(Math.abs(topAfter.r - topBefore.r) < 6, 'a lower third must not touch the top of the frame')
  })
})

describe('every compile path in the motion engine renders', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, () => {
  // One id per distinct branch of the compiler, rather than all thirty-one:
  // the byte-identity suite already proves the strings, and this is here to
  // prove FFmpeg accepts them.
  const paths: Array<[string, string]> = [
    ['ken-burns', 'zoompan / zoom ramp'],
    ['pan-left', 'zoompan / fixed zoom + rate pan'],
    ['pan-diag-br', 'zoompan / two-axis rate pan'],
    ['dolly-in', 'zoompan / per-frame rate pan'],
    ['breathe', 'zoompan / sine zoom'],
    ['rotate-cw', 'rotate + crop'],
    ['fade-in', 'plain + fade'],
    ['fade-out', 'plain + trailing fade'],
    ['blur-focus', 'plain + staged blur'],
    ['none', 'plain'],
  ]
  for (const [id, description] of paths) {
    test(`${id} — ${description}`, async () => {
      assert.ok(BUILT_IN_SCENE_MOTIONS.some(m => m.id === id), `${id} left the registry`)
      const { file } = await renderPreview({ motion_id: id })
      const info = await probe(file)
      assert.equal(info.width, 480)
      assert.equal(info.height, 270)
      assert.ok(info.frames >= 60, `${id} produced only ${info.frames} frames`)
    })
  }

  test('a still camera move actually moves the picture', async () => {
    // `zoom-in`, not `pan-right`. A still pan drifts 2 output pixels per second
    // by design, so over a 3-second preview it moves 6px — on a smooth gradient
    // that is under a level of change per sample box, which is indistinguishable
    // from VP9 noise. The pan's arithmetic is pinned byte-for-byte by the
    // registry suite; what THIS test can honestly prove is that the zoompan
    // camera moves the picture at all, and a 12% zoom shows that plainly.
    const { file } = await renderPreview({ motion_id: 'zoom-in' })
    const box = { x: 40, y: 40, w: 80, h: 80 }
    const early = await sampleFrame(file, 0.2, box)
    const late = await sampleFrame(file, 2.7, box)
    assert.ok(Math.abs(early.r - late.r) > 2,
      `a zoom must change what is under a fixed sample box: ${early.r} vs ${late.r}`)
  })

  test('a footage traverse crosses its slack', async () => {
    // The footage engine crosses 10% of the frame over the clip — 48 pixels
    // here, which is unmistakable even on a smooth gradient.
    const { file } = await renderPreview({ motion_id: 'pan-right', motion_source: 'footage' })
    const box = { x: 40, y: 40, w: 80, h: 80 }
    const early = await sampleFrame(file, 0.2, box)
    const late = await sampleFrame(file, 2.7, box)
    assert.ok(Math.abs(early.r - late.r) > 4,
      `a traverse must sweep the frame: ${early.r} vs ${late.r}`)
  })

  test('a static motion holds still', async () => {
    const { file } = await renderPreview({ motion_id: 'none' })
    const box = { x: 40, y: 40, w: 80, h: 80 }
    const early = await sampleFrame(file, 0.2, box)
    const late = await sampleFrame(file, 2.7, box)
    assert.ok(Math.abs(early.r - late.r) < 3 && Math.abs(early.b - late.b) < 3,
      'a static scene must not drift')
  })
})

describe('the preview endpoint refuses what it cannot honour', () => {
  test('an unknown effect id is a 400 that names it', async () => {
    const res = await request(app())
      .post('/api/projects/demo/video-editor/preview-effect')
      .send({ overlays: [{ id: 'no-such-effect' }] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /no-such-effect/)
  })

  test('an unknown field in a full document is named, not ignored', async () => {
    const res = await request(app())
      .post('/api/projects/demo/video-editor/preview-effect')
      .send({ overlays: [{ ...BUILT_IN_OVERLAYS[0]!.document, bloom: 3 }] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /bloom/)
  })

  test('an unknown motion id is a 400 that names it', async () => {
    const res = await request(app())
      .post('/api/projects/demo/video-editor/preview-effect')
      .send({ motion_id: 'no-such-motion' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /no-such-motion/)
  })

  test('a scene id is not silently accepted as a B-Roll motion', async () => {
    // Six of the seven footage ids also name a scene animation, and the two
    // render differently. `blur-focus` is scene-only, so asking for it as
    // footage must fail rather than fall through to the scene registry.
    const res = await request(app())
      .post('/api/projects/demo/video-editor/preview-effect')
      .send({ motion_id: 'blur-focus', motion_source: 'footage' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /B-Roll motion "blur-focus"/)
  })

  test('an expired or invented token is a 404, never a path escape', async () => {
    for (const token of ['../../../etc/passwd', 'nope', 'a'.repeat(20) + '.webm']) {
      const res = await request(app())
        .get('/api/projects/demo/video-editor/preview-effect')
        .query({ token })
      assert.equal(res.status, 404, token)
    }
  })

  test('the catalogue serves the whole library and its capability flags', async () => {
    const res = await request(app()).get('/api/projects/demo/video-editor/effects/catalog')
    assert.equal(res.status, 200)
    // 1.4.282 — every motion the menus offer: rotation and parallax-drift stay renderable but are not offered.
    // E2–E4 (1.4.288): picture-aware moves and effects only where the channel has scene analysis on (here: off).
    const off = { depth: false, vision: false }
    assert.equal(res.body.scene_motions.length, BUILT_IN_SCENE_MOTIONS.filter(m => !isHiddenMotion(m) && offeredWithSwitches(m.document, off)).length)
    assert.equal(res.body.footage_motions.length, BUILT_IN_FOOTAGE_MOTIONS.length)
    assert.equal(res.body.overlays.length, BUILT_IN_OVERLAYS.filter(o => offeredWithSwitches(o.document, off)).length)
    assert.equal(typeof res.body.supports_text_overlays, 'boolean')
    assert.equal(typeof res.body.supports_subtitles, 'boolean')
    // The honest notes must survive the trip to the client — they are the whole
    // point of labelling an approximation.
    const scrim = res.body.overlays.find((o: { id: string }) => o.id === 'scrim-bottom')
    assert.ok(scrim.approximation.includes('gradient'), 'the scrim must admit it is banded')
    // v1.2.1 — every entry says where it came from, and nothing was left out.
    assert.deepEqual(res.body.refusals, [])
    assert.ok(res.body.overlays.every((o: { origin?: { origin: string } }) => o.origin?.origin === 'built-in'))
    assert.ok(res.body.scene_motions.every((m: { origin?: { origin: string } }) => m.origin?.origin === 'built-in'))
  })

  test('the caption catalogue serves the free gallery with no pack installed', async () => {
    const res = await request(app()).get('/api/projects/demo/video-editor/subtitles/catalog')
    assert.equal(res.status, 200)
    assert.deepEqual(
      res.body.presets.map((preset: { id: string }) => preset.id),
      BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id),
    )
    assert.deepEqual(res.body.refusals, [])
    assert.ok(res.body.presets.every((p: { origin?: { origin: string } }) => p.origin?.origin === 'built-in'))
  })
})
