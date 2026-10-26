/**
 * Each episode keeps its own Sketch Draw reveal style (owner correction, 2026-10-27).
 *
 * The reveal style shipped channel-wide (1.4.360), so changing it touched every episode. The owner
 * never asked for that: "different episodes (and, via Mix and per-scene pins, different scenes) use
 * different effects". The style, the Mix set and the per-scene pins are now the EPISODE's own, in
 * `sketch_reveal.json` beside its Scene Plan; the channel value is only the starting default for an
 * episode that has none. These tests drive the one resolver freshness, generation, status and
 * Assembly all call, plus the routes Motion Review uses.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { DEFAULT_SKETCH_REVEAL, resetSketchRevealPlanCache, resolveSketchRevealPlan, type SketchRevealSetting } from '../lib/sketch-reveal.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let checkpoint: typeof import('../services/scene-media-checkpoint.js')
let revealStore: typeof import('../services/episode-sketch-reveal.js')
let paths: typeof import('../services/utils.js')
let version: typeof import('../lib/native-scene-clip-version.js')
let app: express.Express
let PNG: Buffer

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const SCENES = ['scene-1', 'scene-2', 'scene-3', 'scene-4', 'scene-5', 'scene-6']

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const sharp = (await import('sharp')).default
  PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 120, b: 220 } } }).png().toBuffer()
  pm = await import('../services/project-manager.js')
  checkpoint = await import('../services/scene-media-checkpoint.js')
  revealStore = await import('../services/episode-sketch-reveal.js')
  paths = await import('../services/utils.js')
  version = await import('../lib/native-scene-clip-version.js')
  const { router } = await import('../routes/scene-review.js')
  app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', router)
})
after(async () => { await cleanup() })

async function channel(name: string, reveal?: SketchRevealSetting) {
  const project = await pm.createProject({ name })
  await pm.updateConfig(project.slug, { motion_presentation: { renderer: 'sketch_draw', pen: 'none', ...(reveal ? { reveal } : {}) } } as any)
  return project.slug
}

/** A real episode folder with a Scene Plan, so the reveal resolves beside it exactly as the routes do. */
async function episode(slug: string, code: string) {
  const resolved = await paths.resolveEpisodePathsByCode(slug, code)
  await fs.mkdir(resolved.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(resolved.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [] }))
  const found = await paths.resolveEpisodePathsByCodeWithSidecar(slug, code, 'scene_plan.json')
  const image = path.join(found.episode_dir, `${code}.png`)
  await fs.writeFile(image, PNG)
  return { code, dir: found.episode_dir, image }
}

/** A sketch clip of one scene rendered under whatever reveal `slug`/`code` resolve to right now. */
async function renderedUnderCurrentReveal(slug: string, code: string, sceneId = 'scene-1') {
  resetSketchRevealPlanCache()
  const s = await checkpoint.resolveSketchDrawSettings(slug, code)
  const revealType = checkpoint.revealTypeFor(s.reveal ?? DEFAULT_SKETCH_REVEAL,
    { slug, episodeId: code, episodeDir: '', revealScenes: SCENES }, sceneId)!
  return {
    id: sceneId, scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A', visual_prompt: 'A',
    approved: true, motion_choice: 'clip' as const, clip_source_image_version: 'v1',
    clip_renderer: 'sketch_draw' as const, image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG),
    clip_scene_window_seconds: 4,
    clip_sketch: { helper_version: version.NATIVE_SCENE_CLIP_VERSION, fps: s.fps, frames: Math.round(4 * s.fps),
      width: s.width, height: s.height, pen_fingerprint: s.penFingerprint,
      hold_frames: checkpoint.sketchHoldFramesFor(s, code, sceneId, Math.round(4 * s.fps)),
      hold_fingerprint: s.holdFingerprint, reveal_type: revealType },
  }
}

/** Freshness for one scene with the episode's ordered scene ids, as the review read supplies them.
 *  The settings are NOT pre-resolved here, so an unreadable file reaches the rule's own catch. */
async function stale(slug: string, ep: { code: string; dir: string; image: string }, scene: any) {
  return checkpoint.sceneClipStaleReason(scene, {
    slug, episodeId: ep.code, episodeDir: ep.dir, imagePath: ep.image, revealScenes: SCENES,
  })
}

describe('per-episode Sketch Draw reveal', () => {
  test('the channel value is the starting default; an episode with none of its own reads it', async () => {
    const slug = await channel('Inherit', { style: 'bloom', mix: [] })
    await episode(slug, 'EP001')
    assert.deepEqual(await checkpoint.resolveEpisodeReveal(slug, 'EP001'), {
      reveal: { style: 'bloom', mix: [] }, reveal_source: 'channel', episode_reveal: null, channel_reveal: { style: 'bloom', mix: [] },
    })
    assert.deepEqual((await checkpoint.resolveSketchDrawSettings(slug, 'EP001')).reveal, { style: 'bloom', mix: [] })
  })

  test('a channel that never chose and an episode that never chose read null, and their clips stay fresh', async () => {
    const slug = await channel('Never chosen')
    const ep = await episode(slug, 'EP001')
    assert.deepEqual(await checkpoint.resolveEpisodeReveal(slug, 'EP001'),
      { reveal: null, reveal_source: 'none', episode_reveal: null, channel_reveal: null })
    const clip = await renderedUnderCurrentReveal(slug, 'EP001')
    assert.equal(await stale(slug, ep, clip), null)
  })

  test("EP2's own reveal stales only EP2; EP1 keeps the channel default and stays fresh", async () => {
    const slug = await channel('Scope')
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    const clip1 = await renderedUnderCurrentReveal(slug, 'EP001')
    const clip2 = await renderedUnderCurrentReveal(slug, 'EP002')

    await revealStore.writeEpisodeSketchReveal(slug, 'EP002', { style: 'patches', mix: [] })
    assert.equal(await stale(slug, ep1, clip1), null, 'EP1 is untouched by EP2')
    assert.equal(await stale(slug, ep2, clip2), 'stale reveal style (line → patches)')
    assert.deepEqual(await checkpoint.resolveEpisodeReveal(slug, 'EP002'),
      { reveal: { style: 'patches', mix: [] }, reveal_source: 'episode', episode_reveal: { style: 'patches', mix: [] }, channel_reveal: null })
    // The re-render records the episode's own style, and is fresh under it.
    const clip2again = await renderedUnderCurrentReveal(slug, 'EP002')
    assert.equal(clip2again.clip_sketch.reveal_type, 'patches')
    assert.equal(await stale(slug, ep2, clip2again), null)
  })

  test('changing the channel default touches only the episodes that follow it', async () => {
    const slug = await channel('Channel moves')
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    await revealStore.writeEpisodeSketchReveal(slug, 'EP002', { style: 'swipes', mix: [] })
    const clip1 = await renderedUnderCurrentReveal(slug, 'EP001')
    const clip2 = await renderedUnderCurrentReveal(slug, 'EP002')

    await pm.updateConfig(slug, { motion_presentation: { renderer: 'sketch_draw', pen: 'none', reveal: { style: 'buildup', mix: [] } } } as any)
    assert.equal(await stale(slug, ep1, clip1), 'stale reveal style (line → buildup)')
    assert.equal(await stale(slug, ep2, clip2), null, 'EP2 has its own reveal')
  })

  test('clearing the episode value returns it to the channel default, and the file is kept', async () => {
    const slug = await channel('Clear', { style: 'bloom', mix: [] })
    const ep = await episode(slug, 'EP001')
    await revealStore.writeEpisodeSketchReveal(slug, 'EP001', { style: 'line', mix: [] })
    assert.equal((await checkpoint.resolveEpisodeReveal(slug, 'EP001')).reveal_source, 'episode')
    await revealStore.writeEpisodeSketchReveal(slug, 'EP001', null)
    assert.equal(await revealStore.readEpisodeSketchReveal(slug, 'EP001'), null)
    assert.equal((await checkpoint.resolveEpisodeReveal(slug, 'EP001')).reveal_source, 'channel')
    assert.equal(JSON.parse(await fs.readFile(path.join(ep.dir, revealStore.EPISODE_SKETCH_REVEAL_FILENAME), 'utf8')).reveal, null)
  })

  test('a Mix and its pins are the episode\'s own, so two episodes on one channel draw differently', async () => {
    const slug = await channel('Mix per episode')
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    const mix: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup', 'swipes'] }
    await revealStore.writeEpisodeSketchReveal(slug, 'EP001', mix)
    await revealStore.writeEpisodeSketchReveal(slug, 'EP002', { ...mix, overrides: { 'scene-2': 'bloom' } })

    assert.equal((await checkpoint.resolveEpisodeReveal(slug, 'EP001')).reveal?.overrides, undefined)
    assert.deepEqual((await checkpoint.resolveEpisodeReveal(slug, 'EP002')).reveal?.overrides, { 'scene-2': 'bloom' })
    // The same Mix resolves per episode from that episode's own scene ids.
    assert.notDeepEqual(
      [...resolveSketchRevealPlan('EP001', SCENES, mix).values()],
      [...resolveSketchRevealPlan('EP009', SCENES, mix).values()],
    )
    const clip = await renderedUnderCurrentReveal(slug, 'EP002', 'scene-2')
    assert.equal(clip.clip_sketch.reveal_type, 'bloom', 'the pin wins for EP002')
    assert.equal(await stale(slug, ep2, clip), null)
  })

  test('AGENTS.md §4: switching episodes never carries another episode\'s reveal or pins', async () => {
    const slug = await channel('No leak')
    await episode(slug, 'EP001')
    await episode(slug, 'EP002')
    await revealStore.writeEpisodeSketchReveal(slug, 'EP001', { style: 'bloom', mix: [], overrides: { 'scene-2': 'patches' } })

    // Reading the OTHER episode answers from its own folder and nothing else.
    assert.deepEqual(await checkpoint.resolveEpisodeReveal(slug, 'EP002'),
      { reveal: null, reveal_source: 'none', episode_reveal: null, channel_reveal: null })
    assert.equal((await checkpoint.resolveSketchDrawSettings(slug, 'EP002')).reveal, null,
      'EP002 renders with no reveal, not EP001\'s bloom or its pin')
    // And a clip of EP002 recorded under that state stays fresh when EP001 changes again.
    const ep2 = await episode(slug, 'EP002')
    const clip = await renderedUnderCurrentReveal(slug, 'EP002')
    await revealStore.writeEpisodeSketchReveal(slug, 'EP001', { style: 'swipes', mix: [] })
    assert.equal(await stale(slug, ep2, clip), null)
    assert.equal((await revealStore.readEpisodeSketchReveal(slug, 'EP002')), null, 'EP001 writing never creates EP002\'s file')
  })

  test('a malformed reveal file is a loud, plain failure, never silently "line"', async () => {
    const slug = await channel('Malformed')
    const ep = await episode(slug, 'EP001')
    const clip = await renderedUnderCurrentReveal(slug, 'EP001')
    await fs.writeFile(path.join(ep.dir, revealStore.EPISODE_SKETCH_REVEAL_FILENAME), '{ not json')
    await assert.rejects(revealStore.readEpisodeSketchReveal(slug, 'EP001'), /malformed/)
    assert.match((await stale(slug, ep, clip))!,
      /^This episode's reveal setting file \(sketch_reveal\.json for EP001\) is malformed and cannot be read\. Choose its reveal style again in Motion Review to rewrite it\.$/)
    assert.equal(await fs.readFile(path.join(ep.dir, revealStore.EPISODE_SKETCH_REVEAL_FILENAME), 'utf8'), '{ not json', 'reading never rewrites the bad file')
    await fs.writeFile(path.join(ep.dir, revealStore.EPISODE_SKETCH_REVEAL_FILENAME), JSON.stringify({ reveal: { style: 'sparkle' } }))
    await assert.rejects(revealStore.readEpisodeSketchReveal(slug, 'EP001'), /not a valid reveal style/)
  })

  test('the reveal is stored only in the episode folder, never in config.json or an invented place', async () => {
    const slug = await channel('Storage')
    const ep = await episode(slug, 'EP001')
    await revealStore.writeEpisodeSketchReveal(slug, 'EP001', { style: 'patches', mix: [] })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(ep.dir, revealStore.EPISODE_SKETCH_REVEAL_FILENAME), 'utf8')).reveal,
      { style: 'patches', mix: [] })
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation, { renderer: 'sketch_draw', pen: 'none' }, 'an episode reveal never reaches config.json')
    assert.deepEqual((await fs.readdir(ep.dir)).filter(name => /^sketch_/.test(name)).sort(), [revealStore.EPISODE_SKETCH_REVEAL_FILENAME])
    const ghost = await paths.resolveEpisodePathsByCode(slug, 'EP099')
    await assert.rejects(revealStore.writeEpisodeSketchReveal(slug, 'EP099', { style: 'line', mix: [] }), /no folder yet/)
    await assert.rejects(fs.stat(ghost.episode_dir), { code: 'ENOENT' })
    await assert.rejects(revealStore.writeEpisodeSketchReveal(slug, 'EP001', { style: 'mix', mix: ['line'] }), /between 2 and 5/)
    assert.deepEqual(await revealStore.readEpisodeSketchReveal(slug, 'EP001'), { style: 'patches', mix: [] }, 'a refused write changes nothing')
  })

  test('the channel-default invalidation touches only the episodes that follow the reveal', async () => {
    const slug = await channel('Invalidation')
    await episode(slug, 'EP001')
    await episode(slug, 'EP002')
    await revealStore.writeEpisodeSketchReveal(slug, 'EP002', { style: 'bloom', mix: [] })
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    // The predicate the cache runs per episode, driven directly through the real function: a
    // channel reveal change drops the cached status of exactly the episodes with no reveal of their own.
    const dropped: string[] = []
    const original = (episodeStatusCache as any).invalidateWhere
    ;(episodeStatusCache as any).invalidateWhere = async (_s: string, affected: (code: string) => Promise<boolean>) => {
      for (const code of ['EP001', 'EP002']) if (await affected(code)) dropped.push(code)
    }
    try {
      await checkpoint.invalidateEpisodesFollowingChannelSketch(slug, { pen: false, hold: false, reveal: true })
    } finally {
      ;(episodeStatusCache as any).invalidateWhere = original
    }
    assert.deepEqual(dropped, ['EP001'], 'EP002 has its own reveal; EP001 follows the channel')
  })
})

describe('episode reveal routes', () => {
  test('GET reports the channel default and the episode reveal; PUT sets, validates and clears', async () => {
    const slug = await channel('Routes', { style: 'bloom', mix: [] })
    await episode(slug, 'EP001')
    const base = `/api/projects/${slug}/scene-review/EP001/motion-reveal`

    assert.deepEqual((await request(app).get(base).expect(200)).body,
      { reveal: { style: 'bloom', mix: [] }, reveal_source: 'channel', episode_reveal: null, channel_reveal: { style: 'bloom', mix: [] } })
    assert.deepEqual((await request(app).put(base).send({ reveal: { style: 'patches', mix: [] } }).expect(200)).body,
      { reveal: { style: 'patches', mix: [] }, reveal_source: 'episode', episode_reveal: { style: 'patches', mix: [] }, channel_reveal: { style: 'bloom', mix: [] } })
    await request(app).put(base).send({ reveal: { style: 'sparkle' } }).expect(400)
    await request(app).put(base).send({}).expect(400)
    assert.equal((await request(app).get(base).expect(200)).body.episode_reveal.style, 'patches', 'a refused PUT changes nothing')
    assert.deepEqual((await request(app).put(base).send({ reveal: null }).expect(200)).body,
      { reveal: { style: 'bloom', mix: [] }, reveal_source: 'channel', episode_reveal: null, channel_reveal: { style: 'bloom', mix: [] } })
  })

  test('an unreadable reveal file leaves the control usable: GET answers with the error, PUT overwrites it', async () => {
    const slug = await channel('Unreadable', { style: 'bloom', mix: [] })
    const ep = await episode(slug, 'EP001')
    const base = `/api/projects/${slug}/scene-review/EP001/motion-reveal`
    await fs.writeFile(path.join(ep.dir, revealStore.EPISODE_SKETCH_REVEAL_FILENAME), '{ not json')

    const broken = (await request(app).get(base).expect(200)).body
    assert.equal(broken.reveal, null, 'the effective reveal is unknown, never "not chosen"')
    assert.equal(broken.reveal_source, 'unreadable')
    assert.equal(broken.episode_reveal, null)
    assert.deepEqual(broken.channel_reveal, { style: 'bloom', mix: [] })
    assert.match(broken.error, /malformed/)

    assert.equal((await request(app).put(base).send({ reveal: { style: 'line', mix: [] } }).expect(200)).body.reveal_source, 'episode')
    assert.equal((await request(app).get(base).expect(200)).body.error, undefined)
  })

  test('an episode id that is not an episode code is refused and nothing is written outside the episode', async () => {
    const slug = await channel('Traversal')
    const ep = await episode(slug, 'EP001')
    for (const bad of ['%2E%2E', '..%2Fx', 'EP%20001', 'x']) {
      const base = `/api/projects/${slug}/scene-review/${bad}/motion-reveal`
      assert.ok([400, 404].includes((await request(app).put(base).send({ reveal: { style: 'line', mix: [] } })).status), bad)
      assert.ok([400, 404].includes((await request(app).get(base)).status), bad)
    }
    assert.equal(await revealStore.readEpisodeSketchReveal(slug, 'EP001'), null)
    await assert.rejects(revealStore.writeEpisodeSketchReveal(slug, '../x', { style: 'line', mix: [] }), /valid episode/)
    assert.deepEqual((await fs.readdir(ep.dir)).filter(name => name === revealStore.EPISODE_SKETCH_REVEAL_FILENAME), [])
  })

  test('the channel PUT still stores a reveal as the default, and never touches an episode file', async () => {
    const slug = await channel('Channel default route')
    const ep = await episode(slug, 'EP001')
    const url = `/api/projects/${slug}/motion-presentation`
    assert.deepEqual((await request(app).put(url).send({ renderer: 'sketch_draw', reveal: { style: 'swipes', mix: [] } }).expect(200)).body.reveal,
      { style: 'swipes', mix: [] })
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation?.reveal, { style: 'swipes', mix: [] })
    assert.equal(await revealStore.readEpisodeSketchReveal(slug, 'EP001'), null)
    await request(app).put(url).send({ renderer: 'sketch_draw', reveal: null }).expect(200)
    assert.equal((await pm.getConfig(slug))?.motion_presentation?.reveal, undefined)
    assert.deepEqual((await fs.readdir(ep.dir)).filter(name => /^sketch_/.test(name)), [])
  })
})
