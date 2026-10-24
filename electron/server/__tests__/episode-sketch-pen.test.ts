/**
 * Each episode keeps its own Sketch Draw pen (1.4.352).
 *
 * The pen used to be channel-wide, so choosing one stale every other episode's sketch clips. An
 * episode may now carry its own pen in `sketch_pen.json` beside its Scene Plan; an episode without
 * one follows the channel default. Freshness, completion, asset status, approval and Assembly all
 * resolve the pen through resolveSketchDrawSettings, so these tests drive that one resolver and
 * the freshness rule on top of it, with real episode folders.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let checkpoint: typeof import('../services/scene-media-checkpoint.js')
let penStore: typeof import('../services/episode-sketch-pen.js')
let paths: typeof import('../services/utils.js')
let version: typeof import('../lib/native-scene-clip-version.js')
let app: express.Express
let PNG: Buffer

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const sharp = (await import('sharp')).default
  PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 120, b: 220 } } }).png().toBuffer()
  pm = await import('../services/project-manager.js')
  checkpoint = await import('../services/scene-media-checkpoint.js')
  penStore = await import('../services/episode-sketch-pen.js')
  paths = await import('../services/utils.js')
  version = await import('../lib/native-scene-clip-version.js')
  const { router } = await import('../routes/scene-review.js')
  const { router: profile } = await import('../routes/channel-profile.js')
  app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', router)
  app.use('/api', profile)
})
after(async () => { await cleanup() })

async function channel(name: string, pen: 'none' | 'plain' | 'name' | 'logo' = 'none') {
  const project = await pm.createProject({ name })
  await pm.updateConfig(project.slug, { motion_presentation: { renderer: 'sketch_draw', pen } } as any)
  return project.slug
}

/** A real episode folder with a Scene Plan, so the pen resolves beside it exactly as the routes do. */
async function episode(slug: string, code: string) {
  const resolved = await paths.resolveEpisodePathsByCode(slug, code)
  await fs.mkdir(resolved.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(resolved.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [] }))
  const found = await paths.resolveEpisodePathsByCodeWithSidecar(slug, code, 'scene_plan.json')
  const image = path.join(found.episode_dir, `${code}.png`)
  await fs.writeFile(image, PNG)
  return { code, dir: found.episode_dir, image }
}

/** A sketch clip rendered under whatever pen `slug`/`code` resolve to right now. */
async function renderedUnderCurrentPen(slug: string, code: string) {
  const s = await checkpoint.resolveSketchDrawSettings(slug, code)
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A', visual_prompt: 'A',
    approved: true, motion_choice: 'clip' as const, clip_source_image_version: 'v1',
    clip_renderer: 'sketch_draw' as const, image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG),
    clip_scene_window_seconds: 4,
    clip_sketch: { helper_version: version.NATIVE_SCENE_CLIP_VERSION, fps: s.fps, frames: Math.round(4 * s.fps),
      width: s.width, height: s.height, pen_fingerprint: s.penFingerprint,
      hold_frames: checkpoint.sketchHoldFramesFor(s, code, 'scene-1', Math.round(4 * s.fps)), hold_fingerprint: s.holdFingerprint },
  }
}

const reason = (slug: string, ep: { code: string; dir: string; image: string }, scene: Awaited<ReturnType<typeof renderedUnderCurrentPen>>) =>
  checkpoint.sceneClipStaleReason(scene, { slug, episodeId: ep.code, episodeDir: ep.dir, imagePath: ep.image })

describe('per-episode Sketch Draw pen', () => {
  test('EP1 on the channel default and EP2 with its own pen are both fresh at the same time', async () => {
    const slug = await channel('Both fresh')
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    const clip1 = await renderedUnderCurrentPen(slug, 'EP001')
    await penStore.writeEpisodeSketchPen(slug, 'EP002', 'name')
    const clip2 = await renderedUnderCurrentPen(slug, 'EP002')

    assert.notEqual(clip1.clip_sketch.pen_fingerprint, clip2.clip_sketch.pen_fingerprint)
    assert.equal(await reason(slug, ep1, clip1), null)
    assert.equal(await reason(slug, ep2, clip2), null)
    assert.equal((await checkpoint.resolveEpisodePen(slug, 'EP001')).pen_source, 'channel')
    assert.deepEqual(await checkpoint.resolveEpisodePen(slug, 'EP002'),
      { pen: 'name', pen_source: 'episode', episode_pen: 'name', channel_pen: 'none' })
  })

  test('changing EP2 never stales EP1; clearing it returns EP2 to the channel default', async () => {
    const slug = await channel('Override then clear')
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    const clip1 = await renderedUnderCurrentPen(slug, 'EP001')
    const clip2 = await renderedUnderCurrentPen(slug, 'EP002')

    await penStore.writeEpisodeSketchPen(slug, 'EP002', 'plain')
    assert.equal(await reason(slug, ep1, clip1), null, 'EP1 is untouched')
    assert.equal(await reason(slug, ep2, clip2), 'stale pen configuration')

    await penStore.writeEpisodeSketchPen(slug, 'EP002', null)
    assert.equal(await penStore.readEpisodeSketchPen(slug, 'EP002'), null)
    assert.equal(await reason(slug, ep2, clip2), null, 'back on the channel pen, the old clip is fresh again')
    // The file is kept (and says "follow the channel"), never deleted.
    assert.equal(JSON.parse(await fs.readFile(path.join(ep2.dir, penStore.EPISODE_SKETCH_PEN_FILENAME), 'utf8')).pen, null)
  })

  test('changing the channel pen stales only the episodes without a pen of their own', async () => {
    const slug = await channel('Channel change')
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    await penStore.writeEpisodeSketchPen(slug, 'EP002', 'name')
    const clip1 = await renderedUnderCurrentPen(slug, 'EP001')
    const clip2 = await renderedUnderCurrentPen(slug, 'EP002')

    await pm.updateConfig(slug, { motion_presentation: { renderer: 'sketch_draw', pen: 'plain' } } as any)
    assert.equal(await reason(slug, ep1, clip1), 'stale pen configuration')
    assert.equal(await reason(slug, ep2, clip2), null)
  })

  test('migration: with no sidecar the pen is the channel pen, the legacy fingerprint, and nothing is written', async () => {
    const slug = await channel('Migration')
    const ep = await episode(slug, 'EP001')
    // A clip stamped before episodes had pens: sha256 of the channel's {mode:'none'} identity.
    const legacy = await renderedUnderCurrentPen(slug, 'EP001')
    legacy.clip_sketch.pen_fingerprint = sha(JSON.stringify({ mode: 'none' }))
    assert.equal(await reason(slug, ep, legacy), null)
    await assert.rejects(fs.stat(path.join(ep.dir, penStore.EPISODE_SKETCH_PEN_FILENAME)), { code: 'ENOENT' })
  })

  test('a malformed pen file is a loud, plain failure, never silently "no pen"', async () => {
    const slug = await channel('Malformed')
    const ep = await episode(slug, 'EP001')
    const clip = await renderedUnderCurrentPen(slug, 'EP001')
    await fs.writeFile(path.join(ep.dir, penStore.EPISODE_SKETCH_PEN_FILENAME), '{ not json')
    await assert.rejects(penStore.readEpisodeSketchPen(slug, 'EP001'), /malformed/)
    assert.equal(await reason(slug, ep, clip), 'Sketch Draw settings could not be checked. Choose the pen and Video Assembly frame rate again.')
    await fs.writeFile(path.join(ep.dir, penStore.EPISODE_SKETCH_PEN_FILENAME), JSON.stringify({ pen: 'brand' }))
    await assert.rejects(penStore.readEpisodeSketchPen(slug, 'EP001'), /unknown pen/)
  })

  test('the pen is never written into the channel config or an episode that has no folder', async () => {
    const slug = await channel('Storage')
    await episode(slug, 'EP001')
    await penStore.writeEpisodeSketchPen(slug, 'EP001', 'name')
    const config = await pm.getConfig(slug)
    assert.deepEqual(config?.motion_presentation, { renderer: 'sketch_draw', pen: 'none' })
    const ghost = await paths.resolveEpisodePathsByCode(slug, 'EP099')
    await assert.rejects(penStore.writeEpisodeSketchPen(slug, 'EP099', 'plain'), /no folder yet/)
    await assert.rejects(fs.stat(ghost.episode_dir), { code: 'ENOENT' })
  })
})

describe('episode pen routes', () => {
  test('GET reports channel default and episode pen; PUT sets, validates and clears', async () => {
    const slug = await channel('Routes', 'plain')
    await episode(slug, 'EP001')
    const base = `/api/projects/${slug}/scene-review/EP001/motion-pen`

    assert.deepEqual((await request(app).get(base).expect(200)).body,
      { pen: 'plain', pen_source: 'channel', episode_pen: null, channel_pen: 'plain' })
    assert.deepEqual((await request(app).put(base).send({ pen: 'name' }).expect(200)).body,
      { pen: 'name', pen_source: 'episode', episode_pen: 'name', channel_pen: 'plain' })
    await request(app).put(base).send({ pen: 'brand' }).expect(400)
    await request(app).put(base).send({}).expect(400)
    assert.equal((await request(app).get(base).expect(200)).body.episode_pen, 'name', 'a refused PUT changes nothing')
    assert.deepEqual((await request(app).put(base).send({ pen: null }).expect(200)).body,
      { pen: 'plain', pen_source: 'channel', episode_pen: null, channel_pen: 'plain' })
  })

  test('an unreadable pen file leaves the control usable: GET answers with the error, PUT overwrites the bad file', async () => {
    const slug = await channel('Unreadable', 'plain')
    const ep = await episode(slug, 'EP001')
    const base = `/api/projects/${slug}/scene-review/EP001/motion-pen`
    const clip = await renderedUnderCurrentPen(slug, 'EP001')
    await fs.writeFile(path.join(ep.dir, penStore.EPISODE_SKETCH_PEN_FILENAME), '{ not json')

    const broken = (await request(app).get(base).expect(200)).body
    assert.equal(broken.pen, null, 'the effective pen is unknown, never "none"')
    assert.equal(broken.pen_source, 'unreadable')
    assert.equal(broken.episode_pen, null)
    assert.equal(broken.channel_pen, 'plain')
    assert.match(broken.error, /malformed/)
    // Freshness keeps reporting it, in plain words, until it is fixed.
    assert.equal(await reason(slug, ep, clip), 'Sketch Draw settings could not be checked. Choose the pen and Video Assembly frame rate again.')

    assert.equal((await request(app).put(base).send({ pen: 'name' }).expect(200)).body.pen, 'name')
    assert.equal((await request(app).get(base).expect(200)).body.error, undefined)
    await fs.writeFile(path.join(ep.dir, penStore.EPISODE_SKETCH_PEN_FILENAME), '{ not json')
    assert.equal((await request(app).put(base).send({ pen: null }).expect(200)).body.pen_source, 'channel')
  })

  test('an episode id that is not an episode code is refused with 400 and nothing is written outside the episode', async () => {
    const slug = await channel('Traversal')
    const ep = await episode(slug, 'EP001')
    // A bare '%2E' is a '.' segment the HTTP client collapses away, so it never names an episode.
    for (const bad of ['%2E%2E', '..%2Fx', '..%2F..%2Fx', 'EP001%2F..', 'EP%20001', 'x']) {
      const base = `/api/projects/${slug}/scene-review/${bad}/motion-pen`
      // Refused either by the route's own check (400) or because the router never matches it (404).
      assert.ok([400, 404].includes((await request(app).put(base).send({ pen: 'plain' })).status), bad)
      assert.ok([400, 404].includes((await request(app).get(base)).status), bad)
    }
    assert.equal(await penStore.readEpisodeSketchPen(slug, 'EP001'), null)
    await assert.rejects(penStore.writeEpisodeSketchPen(slug, '../x', 'plain'), /valid episode/)
    await assert.rejects(penStore.readEpisodeSketchPen(slug, '..'), /valid episode/)
    assert.deepEqual((await fs.readdir(ep.dir)).filter(name => name === penStore.EPISODE_SKETCH_PEN_FILENAME), [])
  })

  test('the logo pen is disabled until the channel has a logo, for an episode as for the channel', async () => {
    const slug = await channel('Logo gate')
    await episode(slug, 'EP001')
    const base = `/api/projects/${slug}/scene-review/EP001/motion-pen`
    const refused = await request(app).put(base).send({ pen: 'logo' }).expect(409)
    assert.match(refused.body.detail, /no profile logo/)
    assert.equal(await penStore.readEpisodeSketchPen(slug, 'EP001'), null, 'nothing was stored')

    await request(app).post(`/api/projects/${slug}/channel-profile/logo`)
      .send({ filename: 'logo.png', data_base64: PNG.toString('base64') }).expect(200)
    await request(app).put(base).send({ pen: 'logo' }).expect(200)
    assert.equal((await checkpoint.resolveSketchDrawSettings(slug, 'EP001')).pen.mode, 'logo')
  })

  test('the renderer control saves the renderer without moving the channel default pen', async () => {
    const slug = await channel('Renderer only', 'plain')
    const url = `/api/projects/${slug}/motion-presentation`
    await request(app).put(url).send({ renderer: 'image_to_video' }).expect(200)
    assert.deepEqual((await request(app).get(url).expect(200)).body.renderer, 'image_to_video')
    assert.equal((await request(app).get(url).expect(200)).body.pen, 'plain')
    await request(app).put(url).send({ renderer: 'sketch_draw', pen: 'name' }).expect(200)
    assert.equal((await request(app).get(url).expect(200)).body.pen, 'name', 'an explicit pen still sets the channel default')
    await request(app).put(url).send({ renderer: 'nope' }).expect(400)
  })
})
