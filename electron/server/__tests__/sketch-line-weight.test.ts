/**
 * The Sketch Draw line weight: thin, normal, bold.
 *
 * The weight is a SELECTION, not a number: the engine owns the widths, and this module only names
 * which of its three weights a clip is drawn with. It follows the reveal's path exactly — a
 * channel default, this episode's own value beside its pen and hold and reveal, absent meaning
 * NORMAL.
 *
 * What these prove:
 *   - NORMAL draws byte for byte as the engine drew before the weight existed: the same frames,
 *     the same hashes, for every reveal;
 *   - THIN and BOLD draw differently, and every reveal still ends on the scene IMAGE at every
 *     weight (the sketch-finish property, at the new weights);
 *   - a clip's freshness does not move because the setting is ABSENT: a receipt with no weight is
 *     a normal receipt, so choosing normal never stales it and a channel or episode that never
 *     chose a weight stales nothing;
 *   - the weight is stored per channel and per episode, is reachable by the API the way the reveal
 *     is, and never rewrites stored data.
 *
 * What these cannot catch: whether a weight LOOKS good. That is the owner's eyes on the samples in
 * `_orchestra/line-weight-374-samples/`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, describe } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'

import { NATIVE_SCENE_CLIP_VERSION, renderSketchDraw, resolveSceneClipHelperPath } from '../lib/native-scene-clip.js'
import {
  DEFAULT_SKETCH_LINE_WEIGHT, SKETCH_LINE_WEIGHTS, parseSketchLineWeight, sketchLineWeightSelection,
  type SketchLineWeight,
} from '../lib/sketch-line-weight.js'
import { sceneClipStaleReason } from '../services/scene-media-checkpoint.js'
import { useTempDataDir } from './_helpers.js'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const REVEALS = ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour'] as const

// ── The rule ─────────────────────────────────────────────────────────────────

describe('the line weight rule', () => {
  test('three weights, and an absent one is NORMAL', () => {
    assert.deepEqual([...SKETCH_LINE_WEIGHTS], ['thin', 'normal', 'bold'])
    assert.equal(DEFAULT_SKETCH_LINE_WEIGHT, 'normal')
    assert.equal(sketchLineWeightSelection(undefined), 'normal')
    assert.equal(sketchLineWeightSelection(null), 'normal')
    for (const weight of SKETCH_LINE_WEIGHTS) assert.equal(sketchLineWeightSelection(weight), weight)
  })

  test('a stored value that does not parse is an error to surface, never silently normal', () => {
    assert.deepEqual(parseSketchLineWeight('bold'), { ok: true, weight: 'bold' })
    assert.equal(parseSketchLineWeight('heavy').ok, false)
    assert.equal(parseSketchLineWeight(7).ok, false)
    assert.throws(() => sketchLineWeightSelection('heavy'), /not valid/)
  })
})

// ── Freshness: absent never stales a clip ────────────────────────────────────

let PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

let dir: string
let cleanup: () => Promise<void>
before(async () => { const temp = await useTempDataDir(); dir = temp.dir; cleanup = temp.cleanup })
after(async () => { await cleanup() })

function settings(lineWeight: SketchLineWeight = 'normal') {
  return { fps: 30, width: 1920, height: 1080, pen: { mode: 'none' as const }, penFingerprint: sha('none'),
    hold: { mode: 'auto' as const }, holdFingerprint: sha('auto'),
    reveal: null, revealFingerprint: sha('none'), lineWeight }
}

/** A clip whose receipt records NO weight — a clip drawn before the weight existed. */
function scene(over: Record<string, unknown> = {}) {
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A',
    visual_prompt: 'A', approved: true, motion_prompt: 'slow push', motion_choice: 'clip' as const,
    clip_source_image_version: 'v1', clip_renderer: 'sketch_draw' as const,
    image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG), clip_scene_window_seconds: 4,
    clip_sketch: { helper_version: NATIVE_SCENE_CLIP_VERSION, fps: 30, frames: 120, width: 1920, height: 1080,
      pen_fingerprint: sha('none'), hold_frames: 60, hold_fingerprint: sha('auto') },
    ...over,
  }
}

describe('the weight never moves a clip on its own', () => {
  test('a clip with no recorded weight is a NORMAL clip: normal keeps it fresh, thin and bold stale it', async () => {
    const file = path.join(dir, 'scene.png')
    await fs.writeFile(file, PNG)
    const context = (weight: SketchLineWeight) => ({
      slug: 'channel', episodeId: 'EP001', episodeDir: dir, imagePath: file,
      sketchSettings: settings(weight), revealScenes: ['scene-1'],
    })
    assert.equal(await sceneClipStaleReason(scene(), context('normal')), null,
      'an absent weight is normal, so normal never stales a clip')
    assert.equal(await sceneClipStaleReason(scene(), context('thin')), 'stale line weight (normal → thin)')
    assert.equal(await sceneClipStaleReason(scene(), context('bold')), 'stale line weight (normal → bold)')
  })

  test('a clip that recorded a weight is stale only when the weight actually moves', async () => {
    const file = path.join(dir, 'scene.png')
    await fs.writeFile(file, PNG)
    const context = (weight: SketchLineWeight) => ({
      slug: 'channel', episodeId: 'EP001', episodeDir: dir, imagePath: file,
      sketchSettings: settings(weight), revealScenes: ['scene-1'],
    })
    const bold = scene({ clip_sketch: { ...scene().clip_sketch, line_weight: 'bold' } })
    assert.equal(await sceneClipStaleReason(bold, context('bold')), null)
    assert.equal(await sceneClipStaleReason(bold, context('normal')), 'stale line weight (bold → normal)')
    assert.equal(await sceneClipStaleReason(bold, context('thin')), 'stale line weight (bold → thin)')
  })

  test('a clip with no live context at all is never called stale over its weight', async () => {
    // With no context the rule cannot compare anything, and says so plainly rather than blaming a
    // setting the customer may never have chosen.
    const reason = await sceneClipStaleReason(scene())
    assert.ok(reason === null || /cannot verify|Sketch Draw settings/i.test(reason), String(reason))
  })
})

// ── Storage and routes: the reveal's path, exactly ───────────────────────────

describe('the weight is stored per channel and per episode', () => {
  let pm: typeof import('../services/project-manager.js')
  let checkpoint: typeof import('../services/scene-media-checkpoint.js')
  let weightStore: typeof import('../services/episode-sketch-line-weight.js')
  let paths: typeof import('../services/utils.js')
  let app: express.Express

  before(async () => {
    pm = await import('../services/project-manager.js')
    checkpoint = await import('../services/scene-media-checkpoint.js')
    weightStore = await import('../services/episode-sketch-line-weight.js')
    paths = await import('../services/utils.js')
    const { router } = await import('../routes/scene-review.js')
    app = express()
    app.use(express.json({ limit: '10mb' }))
    app.use('/api', router)
  })

  async function channel(name: string, lineWeight?: SketchLineWeight) {
    const project = await pm.createProject({ name })
    await pm.updateConfig(project.slug, {
      motion_presentation: { renderer: 'sketch_draw', pen: 'none', ...(lineWeight ? { line_weight: lineWeight } : {}) },
    } as any)
    return project.slug
  }

  async function episode(slug: string, code: string) {
    const resolved = await paths.resolveEpisodePathsByCode(slug, code)
    await fs.mkdir(resolved.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(resolved.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [] }))
    const found = await paths.resolveEpisodePathsByCodeWithSidecar(slug, code, 'scene_plan.json')
    return { code, dir: found.episode_dir }
  }

  test('a channel that never chose one reads NORMAL, and its clips stay fresh', async () => {
    const slug = await channel('Never chosen')
    await episode(slug, 'EP001')
    assert.deepEqual(await checkpoint.resolveEpisodeLineWeight(slug, 'EP001'), {
      line_weight: 'normal', line_weight_source: 'channel', episode_line_weight: null, channel_line_weight: 'normal',
    })
    assert.equal((await checkpoint.resolveSketchDrawSettings(slug, 'EP001')).lineWeight, 'normal')
  })

  test("EP2's own weight touches only EP2; EP1 keeps the channel default", async () => {
    const slug = await channel('Scope', 'thin')
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    await weightStore.writeEpisodeSketchLineWeight(slug, 'EP002', 'bold')
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP001')).line_weight, 'thin')
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP001')).line_weight_source, 'channel')
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP002')).line_weight, 'bold')
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP002')).line_weight_source, 'episode')
    assert.equal((await checkpoint.resolveSketchDrawSettings(slug, 'EP002')).lineWeight, 'bold')
    // EP1's own file was never created.
    assert.deepEqual((await fs.readdir(ep1.dir)).filter(name => /^sketch_line/.test(name)), [])
    assert.deepEqual((await fs.readdir(ep2.dir)).filter(name => /^sketch_line/.test(name)),
      [weightStore.EPISODE_SKETCH_LINE_WEIGHT_FILENAME])
  })

  test('clearing the episode value returns it to the channel default, and the file is kept', async () => {
    const slug = await channel('Clear', 'thin')
    await episode(slug, 'EP001')
    await weightStore.writeEpisodeSketchLineWeight(slug, 'EP001', 'bold')
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP001')).line_weight_source, 'episode')
    await weightStore.writeEpisodeSketchLineWeight(slug, 'EP001', null)
    assert.equal(await weightStore.readEpisodeSketchLineWeight(slug, 'EP001'), null)
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP001')).line_weight_source, 'channel')
    const stored = JSON.parse(await fs.readFile(path.join((await episode(slug, 'EP001')).dir,
      weightStore.EPISODE_SKETCH_LINE_WEIGHT_FILENAME), 'utf8'))
    assert.equal(stored.weight, null)
  })

  test('a malformed weight file is a loud, plain failure and is never rewritten by reading it', async () => {
    const slug = await channel('Malformed')
    const ep = await episode(slug, 'EP001')
    const file = path.join(ep.dir, weightStore.EPISODE_SKETCH_LINE_WEIGHT_FILENAME)
    await fs.writeFile(file, '{ not json')
    await assert.rejects(weightStore.readEpisodeSketchLineWeight(slug, 'EP001'), /malformed/)
    assert.equal(await fs.readFile(file, 'utf8'), '{ not json', 'reading never rewrites the bad file')
    await fs.writeFile(file, JSON.stringify({ weight: 'heavy' }))
    await assert.rejects(weightStore.readEpisodeSketchLineWeight(slug, 'EP001'), /not a valid line weight/)
  })

  test('a refused write changes nothing, and an episode folder is never created for a weight', async () => {
    const slug = await channel('Storage')
    await episode(slug, 'EP001')
    await weightStore.writeEpisodeSketchLineWeight(slug, 'EP001', 'thin')
    await assert.rejects(weightStore.writeEpisodeSketchLineWeight(slug, 'EP001', 'heavy'), /Choose a line weight/)
    assert.equal(await weightStore.readEpisodeSketchLineWeight(slug, 'EP001'), 'thin')
    await assert.rejects(weightStore.writeEpisodeSketchLineWeight(slug, 'EP099', 'thin'), /no folder yet/)
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation, { renderer: 'sketch_draw', pen: 'none' },
      'an episode weight never reaches config.json')
  })

  test('the channel-default invalidation touches only the episodes that follow the weight', async () => {
    const slug = await channel('Invalidation')
    await episode(slug, 'EP001')
    await episode(slug, 'EP002')
    await weightStore.writeEpisodeSketchLineWeight(slug, 'EP002', 'bold')
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    // The predicate the cache runs per episode, driven directly through the real function.
    const dropped: string[] = []
    const original = (episodeStatusCache as any).invalidateWhere
    ;(episodeStatusCache as any).invalidateWhere = async (_s: string, affected: (code: string) => Promise<boolean>) => {
      for (const code of ['EP001', 'EP002']) if (await affected(code)) dropped.push(code)
    }
    try {
      await checkpoint.invalidateEpisodesFollowingChannelSketch(slug, { pen: false, hold: false, line_weight: true })
    } finally {
      ;(episodeStatusCache as any).invalidateWhere = original
    }
    assert.deepEqual(dropped, ['EP001'], 'EP002 has its own weight; EP001 follows the channel')
  })

  test('a channel save that does not MOVE the weight invalidates nothing', async () => {
    // Absent and NORMAL are the same weight: saving "normal" over an absent one moves nothing.
    const slug = await channel('No move')
    await episode(slug, 'EP001')
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    const dropped: string[] = []
    const original = (episodeStatusCache as any).invalidateWhere
    ;(episodeStatusCache as any).invalidateWhere = async (_s: string, affected: (code: string) => Promise<boolean>) => {
      for (const code of ['EP001']) if (await affected(code)) dropped.push(code)
    }
    try {
      await checkpoint.invalidateEpisodesFollowingChannelSketch(slug, { pen: false, hold: false, line_weight: false })
    } finally {
      ;(episodeStatusCache as any).invalidateWhere = original
    }
    assert.deepEqual(dropped, [], 'a save that moves nothing drops nothing')
  })

  /** A sketch clip of one scene rendered under whatever weight `slug`/`code` resolve to right now. */
  async function renderedNow(slug: string, code: string) {
    const s = await checkpoint.resolveSketchDrawSettings(slug, code)
    const frames = Math.round(4 * s.fps)
    return {
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A', visual_prompt: 'A',
      approved: true, motion_choice: 'clip' as const, clip_source_image_version: 'v1',
      clip_renderer: 'sketch_draw' as const, image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG),
      clip_scene_window_seconds: 4,
      clip_sketch: { helper_version: NATIVE_SCENE_CLIP_VERSION, fps: s.fps, frames, width: s.width, height: s.height,
        pen_fingerprint: s.penFingerprint, hold_frames: checkpoint.sketchHoldFramesFor(s, code, 'scene-1', frames),
        hold_fingerprint: s.holdFingerprint, line_weight: s.lineWeight },
    }
  }
  const reason = (slug: string, ep: { code: string; dir: string }, scene: Awaited<ReturnType<typeof renderedNow>>) =>
    checkpoint.sceneClipStaleReason(scene, { slug, episodeId: ep.code, episodeDir: ep.dir })
  /** Put this clip's receipt into the episode's Scene Plan — the evidence a channel-save pin reads. */
  const planWithClip = async (slug: string, ep: { code: string; dir: string }, clip: unknown) =>
    fs.writeFile(await paths.resolveScenePlanPath(slug, ep.code, ep.dir), JSON.stringify({ scenes: [clip] }))

  test('a channel weight change pins a clipped episode to the weight its clips were drawn with; a clip-less one follows the new default', async () => {
    const slug = await channel('Channel pins') // never chose one: normal
    const ep1 = await episode(slug, 'EP001') // has a Sketch Draw clip
    const ep2 = await episode(slug, 'EP002') // its own weight
    const ep3 = await episode(slug, 'EP003') // no clips at all
    await weightStore.writeEpisodeSketchLineWeight(slug, 'EP002', 'bold')
    const clip1 = await renderedNow(slug, 'EP001')
    const clip2 = await renderedNow(slug, 'EP002')
    await planWithClip(slug, ep1, clip1)

    await request(app).put(`/api/projects/${slug}/motion-presentation`)
      .send({ renderer: 'sketch_draw', line_weight: 'thin' }).expect(200)

    // EP1 keeps the weight its clip was drawn with: fresh now, and a re-render uses that weight.
    assert.equal(await weightStore.readEpisodeSketchLineWeight(slug, 'EP001'), 'normal')
    assert.equal(await reason(slug, ep1, clip1), null, 'the pinned weight keeps EP1\'s clip fresh')
    assert.equal((await checkpoint.resolveSketchDrawSettings(slug, 'EP001')).lineWeight, 'normal')
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP001')).line_weight_source, 'episode',
      'a redo of EP1 draws with the pinned weight, not the new channel default')
    // EP3 has no clips, so it follows the new default.
    assert.equal(await weightStore.readEpisodeSketchLineWeight(slug, 'EP003'), null)
    assert.equal((await checkpoint.resolveEpisodeLineWeight(slug, 'EP003')).line_weight, 'thin')
    // EP2's own weight is never overwritten.
    assert.equal(await weightStore.readEpisodeSketchLineWeight(slug, 'EP002'), 'bold')
    assert.equal(await reason(slug, ep2, clip2), null)
  })

  test('a channel save is refused, naming the episode, when its scene plan cannot be read', async () => {
    const slug = await channel('Unreadable plan')
    const ep = await episode(slug, 'EP001')
    await fs.writeFile(await paths.resolveScenePlanPath(slug, 'EP001', ep.dir), '{ not json')
    const refused = await request(app).put(`/api/projects/${slug}/motion-presentation`)
      .send({ renderer: 'sketch_draw', line_weight: 'thin' }).expect(409)
    assert.match(refused.body.detail, /EP001/)
    assert.equal((await pm.getConfig(slug))?.motion_presentation?.line_weight, undefined, 'a refused save changes nothing')
    assert.equal(await weightStore.readEpisodeSketchLineWeight(slug, 'EP001'), null, 'and no pin was written')
  })

  test('the channel default rides in the presentation: set, kept by the renderer and pen saves, validated', async () => {
    // The renderer and the pen controls never send a weight, and neither drops it.
    const slug = await channel('Presentation')
    const url = `/api/projects/${slug}/motion-presentation`
    assert.equal((await request(app).put(url).send({ renderer: 'sketch_draw', line_weight: 'bold' }).expect(200)).body.line_weight, 'bold')
    await request(app).put(url).send({ renderer: 'image_to_video' }).expect(200)
    assert.equal((await request(app).get(url).expect(200)).body.line_weight, 'bold', 'the renderer save keeps the weight')
    await request(app).put(url).send({ renderer: 'sketch_draw', pen: 'plain' }).expect(200)
    assert.equal((await request(app).get(url).expect(200)).body.line_weight, 'bold', 'the pen save keeps the weight')
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation?.line_weight, 'bold')
  })

  test('the generator hands the helper the weight and records it on the receipt', async () => {
    // The whole chain, driven through the real generator: the channel's weight reaches the helper
    // job, and the receipt records the weight the clip was actually drawn with.
    const [{ generateSketchDrawSceneClip }, { runFfmpeg }] = await Promise.all([
      import('../generators/scene-clip.js'), import('../lib/ffmpeg-utils.js'),
    ])
    const slug = await channel('Generator')
    const ep = await episode(slug, 'EP001')
    const resolved = await paths.resolveEpisodePathsByCode(slug, 'EP001')
    const planPath = await paths.resolveScenePlanPath(slug, 'EP001', ep.dir)
    const sceneImages = path.join(ep.dir, 'scene_images')
    await fs.mkdir(sceneImages, { recursive: true })
    await fs.writeFile(path.join(sceneImages, 'scene-1.png'), PNG)
    await fs.writeFile(planPath, JSON.stringify({ scenes: [{
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 2, transcript_segment: 'A', visual_prompt: 'A', approved: true,
    }] }))

    const seen: any[] = []
    const render = async (job: any) => {
      seen.push({ line_weight: job.line_weight, reveal: job.reveal, mask: job.mask })
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=white:s=${job.width}x${job.height}:r=${job.fps}:d=${job.frames / job.fps}`,
        '-frames:v', String(job.frames), '-r', String(job.fps), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', job.output])
    }
    let n = 0
    const run = async () => {
      const job: any = { job_id: `job-weight-${++n}`, project_slug: slug, episode_id: 'EP001', type: 'scene_clip_generate',
        params: { renderer: 'sketch_draw', episode_id: 'EP001', scene_id: 'scene-1' }, output_lines: [], progress: 0 }
      await generateSketchDrawSceneClip(job, render as any)
      return JSON.parse(await fs.readFile(planPath, 'utf8')).scenes[0]
    }

    // The channel never chose a weight: the job asks for NORMAL, and the receipt records it.
    const first = await run()
    assert.equal(seen[0]!.line_weight, 'normal')
    assert.equal(first.clip_sketch.line_weight, 'normal')

    // The episode's own weight reaches the helper and the receipt.
    await weightStore.writeEpisodeSketchLineWeight(slug, 'EP001', 'bold')
    const second = await run()
    assert.equal(seen[1]!.line_weight, 'bold')
    assert.equal(second.clip_sketch.line_weight, 'bold')

    // Both depth-aware reveals receive only this scene's usable analysis map.
    const { SCENE_ANALYSIS_DIR, SCENE_ANALYSIS_SCHEMA } = await import('../services/scene-analysis.js')
    const { writeEpisodeSketchReveal } = await import('../services/episode-sketch-reveal.js')
    const analysis = path.join(ep.dir, SCENE_ANALYSIS_DIR)
    await fs.mkdir(analysis, { recursive: true })
    const mask = path.join(analysis, 'scene-1.depth.png')
    await fs.writeFile(mask, PNG)
    await fs.writeFile(path.join(analysis, 'scene-1.json'), JSON.stringify({
      schema: SCENE_ANALYSIS_SCHEMA, scene_id: 'scene-1', image_sha256: sha(PNG), analysed_at: '2026-10-29T00:00:00.000Z',
      models: {}, depth: { file: 'scene-1.depth.png', w: 8, h: 8, p5: 0, p50: 0.5, p95: 1, range: 1, usable: true },
      subject: null, points: [], caption: '', segments: {}, regions: {},
    }))
    for (const reveal of ['colour', 'backtofront'] as const) {
      await writeEpisodeSketchReveal(slug, 'EP001', { style: reveal, mix: [] })
      const receipt = await run()
      assert.equal(seen.at(-1)!.reveal, reveal)
      assert.equal(seen.at(-1)!.mask, mask)
      assert.equal(receipt.clip_sketch.reveal_type, reveal)
    }
    await writeEpisodeSketchReveal(slug, 'EP001', { style: 'shadows', mix: [] })
    await run()
    assert.equal(seen.at(-1)!.mask, undefined, 'other reveals do not consume a depth map')

    // The helper's own validation accepts every job the generator built.
    const { validateSketchDrawJob } = await import('../lib/native-scene-clip.js')
    for (const item of seen) {
      assert.doesNotThrow(() => validateSketchDrawJob({ kind: 'sketch', input: '/in/a.png', output: '/out/a.mp4',
        width: 1920, height: 1080, fps: 30, frames: 60, paper: '#ffffff', pen: { mode: 'none' }, ...item }))
    }
    assert.ok(resolved)
  })

  test('GET reports the channel default and the episode weight; PUT sets, validates and clears', async () => {
    const slug = await channel('Routes', 'thin')
    await episode(slug, 'EP001')
    const base = `/api/projects/${slug}/scene-review/EP001/motion-line-weight`
    assert.deepEqual((await request(app).get(base).expect(200)).body, {
      line_weight: 'thin', line_weight_source: 'channel', episode_line_weight: null, channel_line_weight: 'thin',
    })
    assert.deepEqual((await request(app).put(base).send({ line_weight: 'bold' }).expect(200)).body, {
      line_weight: 'bold', line_weight_source: 'episode', episode_line_weight: 'bold', channel_line_weight: 'thin',
    })
    await request(app).put(base).send({ line_weight: 'heavy' }).expect(400)
    await request(app).put(base).send({}).expect(400)
    assert.equal((await request(app).get(base).expect(200)).body.episode_line_weight, 'bold', 'a refused PUT changes nothing')
    assert.deepEqual((await request(app).put(base).send({ line_weight: null }).expect(200)).body, {
      line_weight: 'thin', line_weight_source: 'channel', episode_line_weight: null, channel_line_weight: 'thin',
    })
  })

  test('an unreadable weight file leaves the control usable: GET answers with the error, PUT overwrites it', async () => {
    const slug = await channel('Unreadable', 'thin')
    const ep = await episode(slug, 'EP001')
    await fs.writeFile(path.join(ep.dir, weightStore.EPISODE_SKETCH_LINE_WEIGHT_FILENAME), '{ not json')
    const base = `/api/projects/${slug}/scene-review/EP001/motion-line-weight`
    const broken = (await request(app).get(base).expect(200)).body
    assert.equal(broken.line_weight, null, 'the effective weight is unknown, never "normal"')
    assert.equal(broken.line_weight_source, 'unreadable')
    assert.equal(broken.channel_line_weight, 'thin')
    assert.match(broken.error, /malformed/)
    assert.equal((await request(app).put(base).send({ line_weight: 'normal' }).expect(200)).body.line_weight_source, 'episode')
    assert.equal((await request(app).get(base).expect(200)).body.error, undefined)
  })

  test('the channel PUT stores a weight as the default and never touches an episode file', async () => {
    const slug = await channel('Channel default route')
    const ep = await episode(slug, 'EP001')
    const url = `/api/projects/${slug}/motion-presentation`
    assert.equal((await request(app).put(url).send({ renderer: 'sketch_draw', line_weight: 'bold' }).expect(200)).body.line_weight, 'bold')
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation?.line_weight, 'bold')
    assert.equal(await weightStore.readEpisodeSketchLineWeight(slug, 'EP001'), null)
    await request(app).put(url).send({ renderer: 'sketch_draw', line_weight: 'heavy' }).expect(400)
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation?.line_weight, 'bold', 'a refused PUT changes nothing')
    assert.deepEqual((await fs.readdir(ep.dir)).filter(name => /^sketch_line/.test(name)), [])
  })
})

// ── The engine: normal is the old drawing, and every weight ends on the image ──

const helper = process.platform === 'darwin' && process.arch === 'arm64' ? resolveSceneClipHelperPath() : null
const FF = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null
const realTest = helper && FF ? test : test.skip

const W = 640, H = 360, FPS = 12, FRAMES = 12, HOLD = 3
const SOURCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="220" fill="#7fa8c8"/>
  <rect y="220" width="${W}" height="140" fill="#8a6a45"/>
  <ellipse cx="320" cy="120" rx="70" ry="85" fill="#e8c39a"/>
  <rect x="255" y="190" width="130" height="150" fill="#3a5a8a"/>
  <circle cx="95" cy="70" r="42" fill="#f0d060"/>
  <rect x="500" y="250" width="100" height="80" fill="#2f4a2f"/>
</svg>`

let work: string
let sourcePath: string
before(async () => {
  if (!helper || !FF) return
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'sketch-line-weight-'))
  sourcePath = path.join(work, 'source.png')
  await sharp(Buffer.from(SOURCE_SVG)).png().toFile(sourcePath)
})
after(async () => { if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined) })

async function render(name: string, reveal: string, lineWeight?: SketchLineWeight, quality?: number): Promise<string> {
  const output = path.join(work, `${name}.mp4`)
  await renderSketchDraw({ kind: 'sketch', input: sourcePath, output, width: W, height: H, fps: FPS,
    frames: FRAMES, hold_frames: HOLD, paper: '#ffffff', pen: { mode: 'none' }, reveal: reveal as any,
    ...(lineWeight ? { line_weight: lineWeight } : {}),
    ...(quality !== undefined ? { quality } : {}) })
  return output
}

function frameDigests(file: string): string[] {
  const out = spawnSync(FF!, ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout
  return out.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').pop()!.trim())
}

function decoded(file: string, frame: number): Buffer {
  const out = spawnSync(FF!, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 })
  assert.equal(out.status, 0, String(out.stderr))
  return out.stdout
}

function difference(a: Buffer, b: Buffer): { mean: number; p99: number } {
  assert.equal(a.length, b.length)
  const hist = new Uint32Array(256)
  let sum = 0
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]! - b[i]!); hist[d] = hist[d]! + 1; sum += d }
  const want = Math.floor(a.length * 0.99)
  let seen = 0, p99 = 255
  for (let d = 0; d < 256; d++) { seen += hist[d]!; if (seen > want) { p99 = d; break } }
  return { mean: sum / a.length, p99 }
}

realTest('NORMAL draws byte for byte as the engine drew before the weight existed', async () => {
  // The whole point of the default: a channel that never chose a weight keeps the look it has.
  // These goldens are rendered at quality 1.0. At the app's own quality (0.7) the H.264 encoder
  // is not bit-exact when other encoders are running at the same time, so a frame-hash comparison
  // there is a flake waiting to happen; at 1.0 the same render is bit-exact every time. That is a
  // property of the encoder, not of the drawing.
  for (const reveal of REVEALS) {
    const absent = await render(`weight-absent-${reveal}`, reveal, undefined, 1)
    const normal = await render(`weight-normal-${reveal}`, reveal, 'normal', 1)
    assert.deepEqual(frameDigests(normal), frameDigests(absent), `${reveal}: normal is the absent-weight drawing`)
  }
})

realTest('THIN and BOLD draw differently from NORMAL, at every reveal', async () => {
  for (const reveal of REVEALS) {
    const normal = await render(`weight-diff-normal-${reveal}`, reveal, 'normal', 1)
    const thin = await render(`weight-diff-thin-${reveal}`, reveal, 'thin', 1)
    const bold = await render(`weight-diff-bold-${reveal}`, reveal, 'bold', 1)
    assert.notDeepEqual(frameDigests(thin), frameDigests(normal), `${reveal}: thin draws differently`)
    assert.notDeepEqual(frameDigests(bold), frameDigests(normal), `${reveal}: bold draws differently`)
    // The ink is really there at every weight: the drawing is not the picture.
    const source = await sharp(sourcePath).removeAlpha().raw().toBuffer()
    for (const [name, file] of [['thin', thin], ['bold', bold]] as const) {
      const early = difference(decoded(file, Math.floor(FRAMES / 3)), source)
      assert.ok(early.mean > 4, `${reveal} ${name}: an early frame is the drawing (mean ${early.mean.toFixed(2)})`)
    }
  }
})

realTest('every reveal still ends on the scene image, at every weight', async () => {
  const source = await sharp(sourcePath).removeAlpha().raw().toBuffer()
  for (const reveal of REVEALS) {
    for (const weight of ['thin', 'normal', 'bold'] as const) {
      const file = await render(`weight-end-${reveal}-${weight}`, reveal, weight)
      for (let frame = FRAMES - HOLD; frame < FRAMES; frame++) {
        const { mean, p99 } = difference(decoded(file, frame), source)
        assert.ok(mean < 4 && p99 <= 20,
          `${reveal} ${weight}: frame ${frame} must be the source picture (mean ${mean.toFixed(2)}, p99 ${p99})`)
      }
    }
  }
})
