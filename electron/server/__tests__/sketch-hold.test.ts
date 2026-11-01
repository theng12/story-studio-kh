/**
 * Sketch Draw closing hold options (1.4.353).
 *
 * Owner, 2026-10-24: hold each scene "as an option. a set number, a default or a range. randomized.
 * and also option to use hold at all." The setting is off / auto / fixed seconds / a randomized
 * min-max range, a channel default with an optional per-episode override (like the pen). Every
 * resolved hold is at most half the scene and at least one frame; scene length and narration never
 * change. These tests pin the pure resolution rule, the one resolver the freshness rule reads, the
 * routes, and the generator that hands the helper the exact frames and records them.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import {
  DEFAULT_SKETCH_HOLD, SKETCH_HOLD_MAX_SECONDS, parseSketchHold, resolveSketchHoldFrames, sketchDefaultHoldFrames,
  sketchHoldFingerprint, sketchHoldSelection, sketchHoldUnit, type SketchHoldSetting,
} from '../lib/sketch-hold.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let checkpoint: typeof import('../services/scene-media-checkpoint.js')
let holdStore: typeof import('../services/episode-sketch-hold.js')
let paths: typeof import('../services/utils.js')
let version: typeof import('../lib/native-scene-clip-version.js')
let native: typeof import('../lib/native-scene-clip.js')
let app: express.Express
let PNG: Buffer

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const frames = (hold: SketchHoldSetting, seconds: number, fps = 30, episodeId = 'EP001', sceneId = 'scene-1') =>
  resolveSketchHoldFrames(hold, { episodeId, sceneId, frames: Math.round(seconds * fps), fps })

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const sharp = (await import('sharp')).default
  PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 120, b: 220 } } }).png().toBuffer()
  pm = await import('../services/project-manager.js')
  checkpoint = await import('../services/scene-media-checkpoint.js')
  holdStore = await import('../services/episode-sketch-hold.js')
  paths = await import('../services/utils.js')
  version = await import('../lib/native-scene-clip-version.js')
  native = await import('../lib/native-scene-clip.js')
  const { router } = await import('../routes/scene-review.js')
  app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', router)
})
after(async () => { await cleanup() })

describe('resolving a hold to frames (pure)', () => {
  test('off is exactly one frame: the whole scene is drawing and colour, only the last frame is complete', () => {
    for (const seconds of [3, 8, 30]) assert.equal(frames({ mode: 'off' }, seconds), 1)
    // Under 3 frames the helper can only show the finished image, whatever the setting.
    assert.equal(resolveSketchHoldFrames({ mode: 'off' }, { episodeId: 'EP001', sceneId: 's', frames: 2, fps: 24 }), 2)
    assert.equal(resolveSketchHoldFrames({ mode: 'fixed', seconds: 5 }, { episodeId: 'EP001', sceneId: 's', frames: 1, fps: 24 }), 1)
  })

  test('auto follows the clip: 2.5 s, or half the scene when the scene is shorter than 5 s', () => {
    assert.equal(frames({ mode: 'auto' }, 8), 75, '8 s holds 2.5 s')
    assert.equal(frames({ mode: 'auto' }, 5), 75, 'exactly 5 s: 2.5 s is also half')
    assert.equal(frames({ mode: 'auto' }, 3), 45, '3 s holds half the scene')
    assert.equal(frames({ mode: 'auto' }, 0.5), 7, 'a half-second scene still holds at most half (15 frames: 7, not 8)')
    // An odd frame count never rounds UP past half the scene (the helper's own default would).
    assert.equal(sketchDefaultHoldFrames(147, 30), 74)
    assert.equal(frames({ mode: 'auto' }, 4.9), 73)
    // The same figure the native helper's default produces wherever that stays within half the scene.
    for (const fps of [24, 25, 30, 60]) for (const n of [48, 120, 150, 151, 240, 600]) {
      const auto = resolveSketchHoldFrames({ mode: 'auto' }, { episodeId: 'EP001', sceneId: 's', frames: n, fps })
      assert.ok(auto >= sketchDefaultHoldFrames(n, fps) - 1 && auto <= sketchDefaultHoldFrames(n, fps), `${n}f@${fps}: ${auto}`)
      assert.ok(auto <= Math.floor(n / 2), `${n}f@${fps} stays within half the scene`)
    }
  })

  test('fixed is the seconds the owner set, never more than half the scene and never under one frame', () => {
    assert.equal(frames({ mode: 'fixed', seconds: 2 }, 8), 60)
    assert.equal(frames({ mode: 'fixed', seconds: 2 }, 8, 24), 48)
    assert.equal(frames({ mode: 'fixed', seconds: 5 }, 4), 60, 'a 4 s scene holds half of itself, not 5 s')
    assert.equal(frames({ mode: 'fixed', seconds: 5 }, 3), 45)
    assert.equal(frames({ mode: 'fixed', seconds: 0.01 }, 8), 1, 'a sliver still holds one frame')
  })

  test('range is randomized per scene, repeatable for the same episode and scene, and inside the range', () => {
    const range: SketchHoldSetting = { mode: 'range', min_seconds: 1, max_seconds: 3 }
    const sceneIds = Array.from({ length: 24 }, (_, i) => `scene-${i + 1}`)
    const holds = sceneIds.map(id => frames(range, 20, 30, 'EP001', id))
    assert.deepEqual(holds, sceneIds.map(id => frames(range, 20, 30, 'EP001', id)), 're-rendering gives the same hold')
    assert.ok(holds.every(hold => hold >= 30 && hold <= 90), `inside 1-3 s: ${holds}`)
    assert.ok(new Set(holds).size > 8, `different scenes get different holds: ${holds}`)
    assert.ok(holds.some(hold => hold < 55) && holds.some(hold => hold > 65), 'both halves of the range are used')
    // The episode is part of the draw, so a different episode does not repeat the same pattern.
    const other = sceneIds.map(id => frames(range, 20, 30, 'EP002', id))
    assert.notDeepEqual(holds, other)
    // Case and padding of the episode code do not change the draw.
    assert.deepEqual(holds, sceneIds.map(id => frames(range, 20, 30, ' ep001 ', id)))
    // Only the episode and scene id decide the draw: not the scene's length, not the range's ends.
    assert.equal(sketchHoldUnit('EP001', 'scene-1'), sketchHoldUnit('EP001', 'scene-1'))
    const u = sketchHoldUnit('EP001', 'scene-7')
    assert.ok(u >= 0 && u < 1)
    assert.equal(frames({ mode: 'range', min_seconds: 2, max_seconds: 2 }, 20), 60, 'a degenerate range is that one value')
  })

  test('a range on a short scene is clamped to half of it', () => {
    const range: SketchHoldSetting = { mode: 'range', min_seconds: 3, max_seconds: 4 }
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      assert.equal(frames(range, 2, 30, 'EP001', id), 30, `scene ${id}: 2 s scene holds 1 s`)
      assert.ok(frames(range, 7, 30, 'EP001', id) >= 90 && frames(range, 7, 30, 'EP001', id) <= 105, 'a 7 s scene holds 3-3.5 s; half is 3.5 s')
    }
  })

  test('every resolved hold is a hold the native helper accepts, for every mode and scene length', () => {
    const settings: SketchHoldSetting[] = [{ mode: 'off' }, { mode: 'auto' }, { mode: 'fixed', seconds: 2.5 },
      { mode: 'fixed', seconds: 60 }, { mode: 'range', min_seconds: 0.5, max_seconds: 60 }]
    const base = { kind: 'sketch' as const, input: '/in/a.png', output: '/out/a.mp4', width: 1920, height: 1080, paper: '#ffffff', pen: { mode: 'none' as const }, reveal: 'line' as const }
    for (const hold of settings) for (const fps of [24, 25, 30, 60]) for (const n of [1, 2, 3, 4, 5, 7, 12, 40, 151, 1800]) {
      const hold_frames = resolveSketchHoldFrames(hold, { episodeId: 'EP001', sceneId: `s${n}`, frames: n, fps })
      assert.doesNotThrow(() => native.validateSketchDrawJob({ ...base, fps, frames: n, hold_frames }), `${hold.mode} ${n}f@${fps} -> ${hold_frames}`)
      if (n >= 4) assert.ok(hold_frames >= 1 && hold_frames <= Math.floor(n / 2), `${hold.mode} ${n}f@${fps}: ${hold_frames} is within half`)
    }
  })

  test('the native default and the app default are one definition', () => {
    assert.equal(native.sketchDefaultHoldFrames, sketchDefaultHoldFrames)
  })
})

describe('validating and reading the setting', () => {
  test('a valid setting is kept; nothing else rides along', () => {
    assert.deepEqual(parseSketchHold({ mode: 'off' }), { ok: true, hold: { mode: 'off' } })
    assert.deepEqual(parseSketchHold({ mode: 'auto', seconds: 9 }), { ok: true, hold: { mode: 'auto' } })
    assert.deepEqual(parseSketchHold({ mode: 'fixed', seconds: 2.5, extra: 1 }), { ok: true, hold: { mode: 'fixed', seconds: 2.5 } })
    assert.deepEqual(parseSketchHold({ mode: 'range', min_seconds: 1, max_seconds: 1 }), { ok: true, hold: { mode: 'range', min_seconds: 1, max_seconds: 1 } })
  })

  test('every malformed setting is refused with a plain sentence', () => {
    const bad: unknown[] = [null, undefined, 'auto', 5, [], {}, { mode: 'default' }, { mode: 'random' },
      { mode: 'fixed' }, { mode: 'fixed', seconds: 0 }, { mode: 'fixed', seconds: -1 }, { mode: 'fixed', seconds: '2' },
      { mode: 'fixed', seconds: NaN }, { mode: 'fixed', seconds: Infinity }, { mode: 'fixed', seconds: SKETCH_HOLD_MAX_SECONDS + 1 },
      { mode: 'range', min_seconds: 1 }, { mode: 'range', max_seconds: 2 }, { mode: 'range', min_seconds: 0, max_seconds: 2 },
      { mode: 'range', min_seconds: 3, max_seconds: 2 }, { mode: 'range', min_seconds: 1, max_seconds: 61 }]
    for (const value of bad) {
      const parsed = parseSketchHold(value)
      assert.equal(parsed.ok, false, JSON.stringify(value))
      if (!parsed.ok) assert.match(parsed.error, /^[A-Z].*\.$/)
    }
    const swapped = parseSketchHold({ mode: 'range', min_seconds: 3, max_seconds: 2 })
    assert.ok(!swapped.ok && /shortest hold cannot be longer/.test(swapped.error))
  })

  test('an absent stored hold is auto; a stored hold that does not parse is an error, never silently auto', () => {
    assert.deepEqual(sketchHoldSelection(undefined), DEFAULT_SKETCH_HOLD)
    assert.deepEqual(DEFAULT_SKETCH_HOLD, { mode: 'auto' })
    assert.deepEqual(sketchHoldSelection({ mode: 'fixed', seconds: 1.5 }), { mode: 'fixed', seconds: 1.5 })
    assert.throws(() => sketchHoldSelection({ mode: 'fixed', seconds: -3 }), /not valid/)
    assert.throws(() => sketchHoldSelection('auto'), /not valid/)
  })

  test('the fingerprint tells settings apart and ignores key order', () => {
    const distinct = [{ mode: 'off' }, { mode: 'auto' }, { mode: 'fixed', seconds: 2 }, { mode: 'fixed', seconds: 3 },
      { mode: 'range', min_seconds: 1, max_seconds: 2 }, { mode: 'range', min_seconds: 1, max_seconds: 3 }] as SketchHoldSetting[]
    assert.equal(new Set(distinct.map(sketchHoldFingerprint)).size, distinct.length)
    const parsed = parseSketchHold({ max_seconds: 3, mode: 'range', min_seconds: 1 })
    assert.ok(parsed.ok)
    if (parsed.ok) assert.equal(sketchHoldFingerprint(parsed.hold), sketchHoldFingerprint({ mode: 'range', min_seconds: 1, max_seconds: 3 }))
  })
})

async function channel(name: string, hold?: SketchHoldSetting, pen: 'none' | 'plain' | 'name' | 'logo' = 'none') {
  const project = await pm.createProject({ name })
  await pm.updateConfig(project.slug, { motion_presentation: { renderer: 'sketch_draw', pen, ...(hold ? { hold } : {}) } } as any)
  return project.slug
}

/** A real episode folder with a Scene Plan, so the hold resolves beside it exactly as the routes do. */
async function episode(slug: string, code: string) {
  const resolved = await paths.resolveEpisodePathsByCode(slug, code)
  await fs.mkdir(resolved.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(resolved.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [] }))
  const found = await paths.resolveEpisodePathsByCodeWithSidecar(slug, code, 'scene_plan.json')
  const image = path.join(found.episode_dir, `${code}.png`)
  await fs.writeFile(image, PNG)
  return { code, dir: found.episode_dir, image }
}

/** Put this clip's receipt into the episode's Scene Plan — the evidence a channel-save pin reads. */
async function planWithClip(slug: string, ep: { code: string; dir: string }, clip: unknown) {
  await fs.writeFile(await paths.resolveScenePlanPath(slug, ep.code, ep.dir), JSON.stringify({ scenes: [clip] }))
}

type Ep = Awaited<ReturnType<typeof episode>>

/** A sketch clip of `seconds` rendered under whatever hold `slug`/`code` resolve to right now. */
async function renderedNow(slug: string, code: string, seconds: number, id = 'scene-1') {
  const s = await checkpoint.resolveSketchDrawSettings(slug, code)
  const n = Math.round(seconds * s.fps)
  return {
    id, scene_index: 1, start_sec: 0, end_sec: seconds, transcript_segment: 'A', visual_prompt: 'A',
    approved: true, motion_choice: 'clip' as const, clip_source_image_version: 'v1',
    clip_renderer: 'sketch_draw' as const, image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG),
    clip_scene_window_seconds: seconds,
    clip_sketch: { helper_version: version.NATIVE_SCENE_CLIP_VERSION, fps: s.fps, frames: n, width: s.width, height: s.height,
      pen_fingerprint: s.penFingerprint, hold_frames: checkpoint.sketchHoldFramesFor(s, code, id, n), hold_fingerprint: s.holdFingerprint } as
      NonNullable<import('../models/types.js').ScenePlanEntry['clip_sketch']>,
  }
}

const reason = (slug: string, ep: Ep, scene: Awaited<ReturnType<typeof renderedNow>>) =>
  checkpoint.sceneClipStaleReason(scene, { slug, episodeId: ep.code, episodeDir: ep.dir, imagePath: ep.image })

const setChannel = (slug: string, hold: SketchHoldSetting | undefined, pen: 'none' | 'plain' | 'name' | 'logo' = 'none') =>
  pm.updateConfig(slug, { motion_presentation: { renderer: 'sketch_draw', pen, ...(hold ? { hold } : {}) } } as any)

describe('the hold in settings and freshness', () => {
  test('a channel with no saved hold renders under auto, and the settings carry the hold and its fingerprint', async () => {
    const slug = await channel('Auto default')
    await episode(slug, 'EP001')
    const settings = await checkpoint.resolveSketchDrawSettings(slug, 'EP001')
    assert.deepEqual(settings.hold, { mode: 'auto' })
    assert.equal(settings.holdFingerprint, sha('{"mode":"auto"}'))
    assert.deepEqual(await checkpoint.resolveEpisodeHold(slug, 'EP001'),
      { hold: { mode: 'auto' }, hold_source: 'channel', episode_hold: null, channel_hold: { mode: 'auto' } })
    assert.equal(checkpoint.sketchHoldFramesFor(settings, 'EP001', 'scene-1', 240), 75)
    // The pen fingerprint is untouched by the hold, so a pen-only clip identity cannot move with it.
    const other = await channel('Auto default pen check', { mode: 'fixed', seconds: 3 })
    await episode(other, 'EP001')
    assert.equal((await checkpoint.resolveSketchDrawSettings(other, 'EP001')).penFingerprint, settings.penFingerprint)
  })

  test('changing the hold stales only the clips whose resolved hold actually moves', async () => {
    const slug = await channel('Only affected')
    const ep = await episode(slug, 'EP001')
    const short = await renderedNow(slug, 'EP001', 2, 'short')
    const long = await renderedNow(slug, 'EP001', 8, 'long')
    assert.equal(short.clip_sketch.hold_frames, 30, '2 s under auto holds half')
    assert.equal(long.clip_sketch.hold_frames, 75, '8 s under auto holds 2.5 s')
    assert.equal(await reason(slug, ep, short), null)
    assert.equal(await reason(slug, ep, long), null)

    // A fixed 2.5 s is what auto already did for the long scene, and the short one is still clamped to half.
    await setChannel(slug, { mode: 'fixed', seconds: 2.5 })
    assert.equal(await reason(slug, ep, short), null)
    assert.equal(await reason(slug, ep, long), null)

    // 1 s moves the long scene's hold (75 -> 30) and leaves the short one (clamped to 30 either way).
    await setChannel(slug, { mode: 'fixed', seconds: 1 })
    assert.equal(await reason(slug, ep, short), null, 'its hold is still 30 frames')
    assert.equal(await reason(slug, ep, long), 'stale closing hold')

    // Off is one frame for everybody, so both go stale; back to auto, both are fresh again.
    await setChannel(slug, { mode: 'off' })
    assert.equal(await reason(slug, ep, short), 'stale closing hold')
    assert.equal(await reason(slug, ep, long), 'stale closing hold')
    await setChannel(slug, undefined)
    assert.equal(await reason(slug, ep, short), null)
    assert.equal(await reason(slug, ep, long), null)
  })

  test('a range stays fresh while its draw is unchanged and stales a scene only when its draw moves', async () => {
    const slug = await channel('Range stable', { mode: 'range', min_seconds: 1, max_seconds: 3 })
    const ep = await episode(slug, 'EP001')
    const scenes = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(id => renderedNow(slug, 'EP001', 12, id)))
    for (const scene of scenes) assert.equal(await reason(slug, ep, scene), null, 're-rendering would give the same hold')
    // Same range written again (the fingerprint is the same): nothing moves.
    await setChannel(slug, { mode: 'range', min_seconds: 1, max_seconds: 3 })
    for (const scene of scenes) assert.equal(await reason(slug, ep, scene), null)
    // A different range moves most draws; the scene whose frames happen to match stays fresh.
    await setChannel(slug, { mode: 'range', min_seconds: 4, max_seconds: 5 })
    const stale = await Promise.all(scenes.map(scene => reason(slug, ep, scene)))
    assert.ok(stale.every(r => r === 'stale closing hold' || r === null))
    assert.ok(stale.filter(r => r === 'stale closing hold').length >= 4)
  })

  test('version-2 clips (old 15% hold) stay fresh under every hold setting until they are regenerated', async () => {
    assert.deepEqual([...version.SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS], [2, 3, 4, 5, 6, 7, 8])
    const slug = await channel('Legacy v2')
    const ep = await episode(slug, 'EP001')
    const legacy = await renderedNow(slug, 'EP001', 8)
    const { hold_frames: _frames, hold_fingerprint: _fingerprint, ...v2 } = legacy.clip_sketch
    const old = { ...legacy, clip_sketch: { ...v2, helper_version: 2 } } as typeof legacy
    for (const hold of [undefined, { mode: 'off' }, { mode: 'fixed', seconds: 1 }, { mode: 'range', min_seconds: 1, max_seconds: 2 }] as Array<SketchHoldSetting | undefined>) {
      await setChannel(slug, hold)
      assert.equal(await reason(slug, ep, old), null, hold ? hold.mode : 'default')
    }
    // A v3 clip that recorded no hold is not a legacy clip: it is unproven, so it is regenerated.
    const noHold = { ...legacy, clip_sketch: { ...v2, helper_version: 3 } } as typeof legacy
    assert.equal(await reason(slug, ep, noHold), 'stale closing hold')
    // Versions outside the compatible list are still a stale renderer.
    assert.match((await reason(slug, ep, { ...legacy, clip_sketch: { ...legacy.clip_sketch, helper_version: 1 } }))!, /renderer/)
    // Helper 8 is the current version and IS compatible; a version this
    // build does not know is the stale renderer.
    assert.match((await reason(slug, ep, { ...legacy, clip_sketch: { ...legacy.clip_sketch, helper_version: 9 } }))!, /renderer/)
  })

  test("an episode's own hold overrides the channel default, and each stales only itself", async () => {
    const slug = await channel('Override', { mode: 'fixed', seconds: 2 })
    const ep1 = await episode(slug, 'EP001')
    const ep2 = await episode(slug, 'EP002')
    await holdStore.writeEpisodeSketchHold(slug, 'EP002', { mode: 'off' })
    assert.deepEqual(await checkpoint.resolveEpisodeHold(slug, 'EP002'),
      { hold: { mode: 'off' }, hold_source: 'episode', episode_hold: { mode: 'off' }, channel_hold: { mode: 'fixed', seconds: 2 } })
    const clip1 = await renderedNow(slug, 'EP001', 10)
    const clip2 = await renderedNow(slug, 'EP002', 10)
    assert.equal(clip1.clip_sketch.hold_frames, 60)
    assert.equal(clip2.clip_sketch.hold_frames, 1)
    assert.notEqual(clip1.clip_sketch.hold_fingerprint, clip2.clip_sketch.hold_fingerprint)
    assert.equal(await reason(slug, ep1, clip1), null)
    assert.equal(await reason(slug, ep2, clip2), null)

    // Changing EP2 never touches EP1.
    await holdStore.writeEpisodeSketchHold(slug, 'EP002', { mode: 'fixed', seconds: 4 })
    assert.equal(await reason(slug, ep1, clip1), null)
    assert.equal(await reason(slug, ep2, clip2), 'stale closing hold')
    // Clearing it returns EP2 to the channel default, and the file stays (saying "follow the channel").
    await holdStore.writeEpisodeSketchHold(slug, 'EP002', null)
    assert.equal(await holdStore.readEpisodeSketchHold(slug, 'EP002'), null)
    assert.equal(JSON.parse(await fs.readFile(path.join(ep2.dir, holdStore.EPISODE_SKETCH_HOLD_FILENAME), 'utf8')).hold, null)
    assert.equal(await reason(slug, ep2, clip2), 'stale closing hold', 'EP2 now holds 2 s, not the 1 frame it was rendered with')
    // Changing the channel default through the route pins the episodes that follow it AND have
    // clips, so EP1 keeps the hold its clip was drawn with; EP2's own hold is untouched.
    const clip2again = await renderedNow(slug, 'EP002', 10)
    await holdStore.writeEpisodeSketchHold(slug, 'EP002', { mode: 'fixed', seconds: 4 })
    const clip2own = await renderedNow(slug, 'EP002', 10)
    await planWithClip(slug, ep1, clip1)
    await request(app).put(`/api/projects/${slug}/motion-presentation`)
      .send({ renderer: 'sketch_draw', pen: 'none', hold: { mode: 'fixed', seconds: 1 } }).expect(200)
    assert.deepEqual(await holdStore.readEpisodeSketchHold(slug, 'EP001'), { mode: 'fixed', seconds: 2 },
      'EP1 is pinned to the hold its clip was drawn with')
    assert.equal(await reason(slug, ep1, clip1), null, 'the pinned hold keeps EP1\'s clip fresh')
    assert.deepEqual((await checkpoint.resolveSketchDrawSettings(slug, 'EP001')).hold, { mode: 'fixed', seconds: 2 },
      'a redo of EP1 draws with the pinned hold, not the new channel default')
    assert.equal(await reason(slug, ep2, clip2own), null, 'EP2 has its own hold')
    assert.equal(clip2again.clip_sketch.hold_frames, 60)
  })

  test('a channel hold change pins a clipped episode to the hold its clips were drawn with; a clip-less one follows the new default', async () => {
    const slug = await channel('Channel pins', { mode: 'fixed', seconds: 2 })
    const ep1 = await episode(slug, 'EP001') // has a Sketch Draw clip
    const ep2 = await episode(slug, 'EP002') // its own hold
    const ep3 = await episode(slug, 'EP003') // no clips at all
    await holdStore.writeEpisodeSketchHold(slug, 'EP002', { mode: 'off' })
    const clip1 = await renderedNow(slug, 'EP001', 10)
    const clip2 = await renderedNow(slug, 'EP002', 10)
    await planWithClip(slug, ep1, clip1)

    await request(app).put(`/api/projects/${slug}/motion-presentation`)
      .send({ renderer: 'sketch_draw', pen: 'none', hold: { mode: 'fixed', seconds: 1 } }).expect(200)

    // EP1 keeps the hold its clip was drawn with: fresh now, and a re-render uses that same hold.
    assert.deepEqual(await holdStore.readEpisodeSketchHold(slug, 'EP001'), { mode: 'fixed', seconds: 2 })
    assert.equal(await reason(slug, ep1, clip1), null, 'the pinned hold keeps EP1\'s clip fresh')
    assert.deepEqual((await checkpoint.resolveSketchDrawSettings(slug, 'EP001')).hold, { mode: 'fixed', seconds: 2 })
    assert.equal((await checkpoint.resolveSketchDrawSettings(slug, 'EP001')).holdFingerprint, clip1.clip_sketch.hold_fingerprint,
      'a redo of EP1 draws with the pinned hold, not the new channel default')
    // EP3 has no clips, so it follows the new default.
    assert.equal(await holdStore.readEpisodeSketchHold(slug, 'EP003'), null)
    assert.deepEqual((await checkpoint.resolveEpisodeHold(slug, 'EP003')).hold, { mode: 'fixed', seconds: 1 })
    // EP2's own hold is never overwritten.
    assert.deepEqual(await holdStore.readEpisodeSketchHold(slug, 'EP002'), { mode: 'off' })
    assert.equal(await reason(slug, ep2, clip2), null)
  })

  test('a channel save is refused, naming the episode, when its scene plan cannot be read', async () => {
    const slug = await channel('Unreadable plan', { mode: 'fixed', seconds: 2 })
    const ep = await episode(slug, 'EP001')
    await fs.writeFile(await paths.resolveScenePlanPath(slug, 'EP001', ep.dir), '{ not json')
    const refused = await request(app).put(`/api/projects/${slug}/motion-presentation`)
      .send({ renderer: 'sketch_draw', pen: 'none', hold: { mode: 'fixed', seconds: 1 } }).expect(409)
    assert.match(refused.body.detail, /EP001/)
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation?.hold, { mode: 'fixed', seconds: 2 },
      'a refused save changes nothing')
    assert.equal(await holdStore.readEpisodeSketchHold(slug, 'EP001'), null, 'and no pin was written')
  })

  test('the hold is stored only in the episode folder and the channel default, never in a preset or an invented place', async () => {
    const slug = await channel('Storage')
    const ep = await episode(slug, 'EP001')
    await holdStore.writeEpisodeSketchHold(slug, 'EP001', { mode: 'fixed', seconds: 3 })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(ep.dir, holdStore.EPISODE_SKETCH_HOLD_FILENAME), 'utf8')).hold, { mode: 'fixed', seconds: 3 })
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation, { renderer: 'sketch_draw', pen: 'none' }, 'an episode hold never reaches config.json')
    assert.deepEqual((await fs.readdir(ep.dir)).filter(name => /^sketch_/.test(name)).sort(), [holdStore.EPISODE_SKETCH_HOLD_FILENAME])
    const ghost = await paths.resolveEpisodePathsByCode(slug, 'EP099')
    await assert.rejects(holdStore.writeEpisodeSketchHold(slug, 'EP099', { mode: 'auto' }), /no folder yet/)
    await assert.rejects(fs.stat(ghost.episode_dir), { code: 'ENOENT' })
    await assert.rejects(holdStore.writeEpisodeSketchHold(slug, 'EP001', { mode: 'fixed', seconds: -1 }), /seconds/)
    assert.deepEqual(await holdStore.readEpisodeSketchHold(slug, 'EP001'), { mode: 'fixed', seconds: 3 }, 'a refused write changes nothing')
  })

  test('a malformed hold file is a loud, plain failure, never silently auto', async () => {
    const slug = await channel('Malformed')
    const ep = await episode(slug, 'EP001')
    const clip = await renderedNow(slug, 'EP001', 8)
    const file = path.join(ep.dir, holdStore.EPISODE_SKETCH_HOLD_FILENAME)
    await fs.writeFile(file, '{ not json')
    await assert.rejects(holdStore.readEpisodeSketchHold(slug, 'EP001'), /malformed/)
    // Motion Review says which file is unreadable and what to do, not the generic "settings could not be checked".
    assert.match((await reason(slug, ep, clip))!, /^This episode's closing hold setting file \(sketch_hold\.json for EP001\) is malformed and cannot be read\. Choose its closing hold again in Motion Review to rewrite it\.$/)
    assert.equal(await fs.readFile(file, 'utf8'), '{ not json', 'reading never rewrites the bad file')
    await fs.writeFile(file, JSON.stringify({ hold: { mode: 'fixed', seconds: 'long' } }))
    assert.match((await reason(slug, ep, clip))!, /sketch_hold\.json for EP001\) holds something that is not a valid hold\. Choose its closing hold again/)
    await assert.rejects(holdStore.readEpisodeSketchHold(slug, 'EP001'), /not a valid hold/)
    await fs.writeFile(file, JSON.stringify({ hold: { mode: 'sometimes' } }))
    await assert.rejects(holdStore.readEpisodeSketchHold(slug, 'EP001'), /not a valid hold/)
  })
})

describe('closing hold routes', () => {
  const url = (slug: string, code = 'EP001') => `/api/projects/${slug}/scene-review/${code}/motion-hold`

  test('GET reports the channel default and the episode hold; PUT sets, validates and clears', async () => {
    const slug = await channel('Routes', { mode: 'fixed', seconds: 2 })
    await episode(slug, 'EP001')
    const base = url(slug)
    const channelOnly = { hold: { mode: 'fixed', seconds: 2 }, hold_source: 'channel', episode_hold: null, channel_hold: { mode: 'fixed', seconds: 2 } }
    assert.deepEqual((await request(app).get(base).expect(200)).body, channelOnly)

    const range = { mode: 'range', min_seconds: 1, max_seconds: 3 }
    assert.deepEqual((await request(app).put(base).send({ hold: range }).expect(200)).body,
      { hold: range, hold_source: 'episode', episode_hold: range, channel_hold: { mode: 'fixed', seconds: 2 } })
    assert.deepEqual((await request(app).get(base).expect(200)).body.episode_hold, range)

    // A refused PUT says why and changes nothing.
    for (const bad of [{}, { hold: undefined }, { hold: 'auto' }, { hold: { mode: 'fixed', seconds: -1 } }, { hold: { mode: 'fixed' } },
      { hold: { mode: 'range', min_seconds: 4, max_seconds: 2 } }, { hold: { mode: 'sometimes' } }, { hold: { mode: 'fixed', seconds: 61 } }]) {
      const refused = await request(app).put(base).send(bad).expect(400)
      assert.equal(typeof refused.body.detail, 'string', JSON.stringify(bad))
      assert.deepEqual((await request(app).get(base).expect(200)).body.episode_hold, range, 'nothing was stored')
    }
    assert.deepEqual((await request(app).put(base).send({ hold: null }).expect(200)).body, channelOnly)
    await request(app).put(base).send({ hold: { mode: 'off' } }).expect(200)
    assert.equal((await request(app).get(base).expect(200)).body.hold_source, 'episode')
  })

  test('an episode with no folder yet is refused and nothing is created', async () => {
    const slug = await channel('No folder')
    const refused = await request(app).put(url(slug, 'EP077')).send({ hold: { mode: 'off' } }).expect(409)
    assert.match(refused.body.detail, /no folder yet/)
    await assert.rejects(fs.stat((await paths.resolveEpisodePathsByCode(slug, 'EP077')).episode_dir), { code: 'ENOENT' })
  })

  test('an unreadable hold file leaves the control usable: GET answers with the error, PUT overwrites the bad file', async () => {
    const slug = await channel('Unreadable', { mode: 'off' })
    const ep = await episode(slug, 'EP001')
    await fs.writeFile(path.join(ep.dir, holdStore.EPISODE_SKETCH_HOLD_FILENAME), '{ not json')
    const broken = (await request(app).get(url(slug)).expect(200)).body
    assert.equal(broken.hold, null, 'the effective hold is unknown, never "auto"')
    assert.equal(broken.hold_source, 'unreadable')
    assert.equal(broken.episode_hold, null)
    assert.deepEqual(broken.channel_hold, { mode: 'off' })
    assert.match(broken.error, /closing hold setting file \(sketch_hold\.json for EP001\) is malformed.*Choose its closing hold again in Motion Review to rewrite it/)
    assert.equal(await fs.readFile(path.join(ep.dir, holdStore.EPISODE_SKETCH_HOLD_FILENAME), 'utf8'), '{ not json', 'GET leaves the bad file alone')
    assert.equal((await request(app).put(url(slug)).send({ hold: { mode: 'auto' } }).expect(200)).body.hold_source, 'episode')
    assert.equal((await request(app).get(url(slug)).expect(200)).body.error, undefined)
    await fs.writeFile(path.join(ep.dir, holdStore.EPISODE_SKETCH_HOLD_FILENAME), '{ not json')
    assert.equal((await request(app).put(url(slug)).send({ hold: null }).expect(200)).body.hold_source, 'channel')
  })

  test('an episode id that is not an episode code is refused and nothing is written outside the episode', async () => {
    const slug = await channel('Traversal')
    const ep = await episode(slug, 'EP001')
    for (const bad of ['%2E%2E', '..%2Fx', '..%2F..%2Fx', 'EP001%2F..', 'EP%20001', 'x']) {
      assert.ok([400, 404].includes((await request(app).put(url(slug, bad)).send({ hold: { mode: 'off' } })).status), bad)
      assert.ok([400, 404].includes((await request(app).get(url(slug, bad))).status), bad)
    }
    await assert.rejects(holdStore.writeEpisodeSketchHold(slug, '../x', { mode: 'off' }), /valid episode/)
    await assert.rejects(holdStore.readEpisodeSketchHold(slug, '..'), /valid episode/)
    assert.deepEqual((await fs.readdir(ep.dir)).filter(name => name === holdStore.EPISODE_SKETCH_HOLD_FILENAME), [])
  })

  test('the channel default rides in the presentation: set, kept by the renderer and pen saves, validated', async () => {
    const slug = await channel('Channel default', undefined, 'plain')
    const presentation = `/api/projects/${slug}/motion-presentation`
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.hold, { mode: 'auto' }, 'a new channel starts on auto')

    const fixed = { mode: 'fixed', seconds: 2 }
    assert.deepEqual((await request(app).put(presentation).send({ renderer: 'sketch_draw', hold: fixed }).expect(200)).body,
      { renderer: 'sketch_draw', pen: 'plain', hold: fixed, reveal: null, line_weight: 'normal' }, 'setting the hold keeps the pen')
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation, { renderer: 'sketch_draw', pen: 'plain', hold: fixed })
    assert.equal((await request(app).get(presentation).expect(200)).body.reveal, null, 'a new channel has chosen no reveal style')

    // The renderer control and the pen control never send a hold, and neither drops it.
    await request(app).put(presentation).send({ renderer: 'image_to_video' }).expect(200)
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.hold, fixed)
    await request(app).put(presentation).send({ renderer: 'sketch_draw', pen: 'name' }).expect(200)
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.hold, fixed)
    assert.equal((await request(app).get(presentation).expect(200)).body.pen, 'name')

    const refused = await request(app).put(presentation).send({ renderer: 'sketch_draw', hold: { mode: 'fixed', seconds: 0 } }).expect(400)
    assert.equal(typeof refused.body.detail, 'string')
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.hold, fixed, 'a refused PUT changes nothing')
    await request(app).put(presentation).send({ renderer: 'sketch_draw', hold: { mode: 'off' } }).expect(200)
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.hold, { mode: 'off' })

    // The reveal style rides in the same object, and null is a real value: it means the channel has
    // never chosen, which is what keeps clips rendered before the control existed fresh.
    const mix = { style: 'mix', mix: ['line', 'buildup', 'swipes'] }
    // The renderer is required on every save, exactly as the pen and hold controls already send it.
    assert.deepEqual((await request(app).put(presentation).send({ renderer: 'sketch_draw', reveal: mix }).expect(200)).body.reveal, mix)
    assert.deepEqual((await pm.getConfig(slug))?.motion_presentation?.reveal, mix)
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.hold, { mode: 'off' }, 'setting the reveal keeps the hold')
    // Neither the renderer nor the pen control sends a reveal, and neither drops it.
    await request(app).put(presentation).send({ renderer: 'image_to_video' }).expect(200)
    await request(app).put(presentation).send({ renderer: 'sketch_draw', pen: 'plain' }).expect(200)
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.reveal, mix)
    for (const bad of [{ style: 'sparkle' }, { style: 'mix', mix: ['line'] }, 'line', 3]) {
      assert.equal((await request(app).put(presentation).send({ renderer: 'sketch_draw', reveal: bad })).status, 400, JSON.stringify(bad))
    }
    assert.deepEqual((await request(app).get(presentation).expect(200)).body.reveal, mix, 'a refused PUT changes nothing')
    assert.equal((await request(app).put(presentation).send({ renderer: 'sketch_draw', reveal: null }).expect(200)).body.reveal, null)
    assert.equal((await request(app).get(presentation).expect(200)).body.reveal, null)
    assert.equal((await pm.getConfig(slug))?.motion_presentation?.reveal, undefined)
  })
})

describe('the channel default and cached episode status', () => {
  // config.json is not a watcher event, so a list read serves a watcher-trusted row without re-statting it:
  // changing a channel default has to drop the rows of the episodes that follow it.
  test('changing the channel default hold or pen drops the cached status of the episodes that follow it, and only those', async () => {
    const [{ episodeStatusCache }, watcher, im] = await Promise.all([
      import('../services/episode-status-cache.js'), import('../services/episode-folder-watcher.js'), import('../services/idea-manager.js')])
    const slug = await channel('Cached status', { mode: 'fixed', seconds: 2 })
    const codes: string[] = []
    for (const title of ['Follows both', 'Own hold', 'Own pen']) {
      const [idea] = await im.addIdeas(slug, [{ title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test-model')
      const code = (await im.acceptIdea(slug, idea!.id, false)).episode_code
      await episode(slug, code)
      codes.push(code)
    }
    const [follows, ownHold, ownPen] = codes as [string, string, string]
    await holdStore.writeEpisodeSketchHold(slug, ownHold, { mode: 'off' })
    await (await import('../services/episode-sketch-pen.js')).writeEpisodeSketchPen(slug, ownPen, 'name')

    const readAll = () => Promise.all(codes.map(code => episodeStatusCache.getForList(slug, code)))
    // The watcher settles on the fixture writes: it vouches for the project and two reads serve the same rows.
    await waitFor(async () => {
      const [a, b] = [await readAll(), await readAll()]
      return watcher.watcherTrustedSince(slug) !== null && a.every((row, i) => row === b[i])
    }, { label: 'the folder watcher to vouch for the fixture episodes' })
    assert.notEqual(watcher.watcherTrustedSince(slug), null, 'the rows are served on the watcher\'s word, which is the path under test')
    const dropped = async (change: Record<string, unknown>) => {
      const before = await readAll()
      assert.deepEqual(await readAll(), before, 'warm rows are served as they are')
      await request(app).put(`/api/projects/${slug}/motion-presentation`).send({ renderer: 'sketch_draw', ...change }).expect(200)
      const after = await readAll()
      return codes.filter((_, i) => after[i] !== before[i])
    }

    assert.deepEqual(await dropped({ hold: { mode: 'fixed', seconds: 3 } }), [follows, ownPen], 'the episode with its own hold keeps its row')
    assert.deepEqual(await dropped({ pen: 'plain' }), [follows, ownHold], 'the episode with its own pen keeps its row')
    assert.deepEqual(await dropped({ pen: 'plain', hold: { mode: 'fixed', seconds: 3 } }), [], 'a save that moves nothing drops nothing')
    assert.deepEqual(await dropped({ renderer: 'image_to_video' }), [], 'neither does a renderer-only save')
  })
})

describe('the generator', () => {
  test('hands the helper the exact resolved frames and records them (and their fingerprint) in the receipt', async () => {
    const [{ generateSketchDrawSceneClip }, { runFfmpeg }] = await Promise.all([
      import('../generators/scene-clip.js'), import('../lib/ffmpeg-utils.js'),
    ])
    const slug = await channel('Generator')
    const ep = await episode(slug, 'EP001')
    const planPath = await paths.resolveScenePlanPath(slug, 'EP001', ep.dir)
    const sceneImages = path.join(ep.dir, 'scene_images')
    await fs.mkdir(sceneImages, { recursive: true })
    await fs.writeFile(path.join(sceneImages, 'scene-1.png'), PNG)
    await fs.writeFile(planPath, JSON.stringify({ scenes: [{
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 2, transcript_segment: 'A', visual_prompt: 'A', approved: true,
    }] }))

    const seen: Array<{ frames: number; fps: number; hold_frames?: number }> = []
    const render = async (job: any) => {
      seen.push({ frames: job.frames, fps: job.fps, hold_frames: job.hold_frames })
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=white:s=${job.width}x${job.height}:r=${job.fps}:d=${job.frames / job.fps}`,
        '-frames:v', String(job.frames), '-r', String(job.fps), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', job.output])
    }
    let n = 0
    const run = async () => {
      const job: any = { job_id: `job-hold-${++n}`, project_slug: slug, episode_id: 'EP001', type: 'scene_clip_generate',
        params: { renderer: 'sketch_draw', episode_id: 'EP001', scene_id: 'scene-1' }, output_lines: [], progress: 0 }
      await generateSketchDrawSceneClip(job, render as any)
      return { job, scene: JSON.parse(await fs.readFile(planPath, 'utf8')).scenes[0] }
    }

    // Channel default (auto): a 2 s scene at the saved frame rate holds half of itself.
    const first = await run()
    assert.equal(seen[0]!.hold_frames, Math.floor(seen[0]!.frames / 2))
    assert.equal(first.scene.clip_sketch.hold_frames, seen[0]!.hold_frames)
    assert.equal(first.scene.clip_sketch.hold_fingerprint, sha('{"mode":"auto"}'))
    assert.equal(first.scene.clip_sketch.helper_version, version.NATIVE_SCENE_CLIP_VERSION)
    assert.match(first.job.output_lines.join('\n'), /closing hold \d+ frames \(1\.0s\)/)
    assert.equal(await reason(slug, ep, { ...first.scene, image_sha256: undefined }), null)

    // The episode's own range: the frames are the resolver's for this episode and scene, nothing else.
    const range = { mode: 'range', min_seconds: 0.2, max_seconds: 0.8 } as const
    await holdStore.writeEpisodeSketchHold(slug, 'EP001', range)
    assert.equal(await reason(slug, ep, { ...first.scene, image_sha256: undefined }), 'stale closing hold', 'the earlier clip is stale under the new hold')
    const second = await run()
    const expected = resolveSketchHoldFrames(range, { episodeId: 'EP001', sceneId: 'scene-1', frames: seen[1]!.frames, fps: seen[1]!.fps })
    assert.equal(seen[1]!.hold_frames, expected)
    assert.ok(expected >= Math.round(0.2 * seen[1]!.fps) && expected <= Math.round(0.8 * seen[1]!.fps))
    assert.equal(second.scene.clip_sketch.hold_frames, expected)
    assert.equal(second.scene.clip_sketch.hold_fingerprint, sketchHoldFingerprint(range))
    assert.equal(await reason(slug, ep, { ...second.scene, image_sha256: undefined }), null, 'and the new clip is fresh')

    // Off: one frame.
    await holdStore.writeEpisodeSketchHold(slug, 'EP001', { mode: 'off' })
    await run()
    assert.equal(seen[2]!.hold_frames, 1)
    // The helper's own validation accepts every job the generator built.
    for (const item of seen) assert.doesNotThrow(() => native.validateSketchDrawJob({ kind: 'sketch', input: '/in/a.png', output: '/out/a.mp4',
      width: 1920, height: 1080, paper: '#ffffff', pen: { mode: 'none' }, reveal: 'line', ...item }))
  })
})
