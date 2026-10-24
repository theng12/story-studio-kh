import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { auditSceneClipCompletion, assertSketchDrawClip, checkpointSceneClip, isSceneClipFresh, motionPresentationSelection, sceneClipStaleReason, sceneWindowSeconds } from '../services/scene-media-checkpoint.js'
import { NATIVE_SCENE_CLIP_VERSION } from '../lib/native-scene-clip-version.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { useTempDataDir } from './_helpers.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let dir: string
let cleanup: () => Promise<void>
before(async () => { const temp = await useTempDataDir(); dir = temp.dir; cleanup = temp.cleanup })
after(async () => { await cleanup() })

function settings(penFingerprint = sha(Buffer.from('none')), fps = 30, width = 1920, height = 1080) {
  return { fps, width, height, pen: { mode: 'none' as const }, penFingerprint,
    hold: { mode: 'auto' as const }, holdFingerprint: sha(Buffer.from('auto')) }
}

function scene(over: Record<string, unknown> = {}) {
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A',
    visual_prompt: 'A', approved: true, motion_prompt: 'slow push', motion_choice: 'clip' as const,
    clip_source_image_version: 'v1', clip_renderer: 'sketch_draw' as const,
    image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG), clip_scene_window_seconds: 4,
    // 4 s at 30 fps under auto: half the scene (60 frames), since 2.5 s would overrun it.
    clip_sketch: { helper_version: NATIVE_SCENE_CLIP_VERSION, fps: 30, frames: 120, width: 1920, height: 1080,
      pen_fingerprint: sha(Buffer.from('none')), hold_frames: 60, hold_fingerprint: sha(Buffer.from('auto')) },
    ...over,
  }
}

async function image(bytes = PNG, name = 'scene.png') {
  const file = path.join(dir, name)
  await fs.writeFile(file, bytes)
  return file
}

function context(imagePath: string, sketchSettings = settings(), slug = 'channel', episodeId = 'EP001', episodeDir = dir) {
  return { slug, episodeId, episodeDir, imagePath, sketchSettings }
}

describe('Sketch Draw freshness', () => {
  test('a fresh clip names no reason; prompt edits do not stale a sketch', async () => {
    const file = await image()
    assert.equal(await sceneClipStaleReason(scene({ motion_prompt: 'completely rewritten' }), context(file)), null)
  })

  test('image bytes, duration, fps, helper version and pen each stale it', async () => {
    const file = await image()
    assert.equal(await sceneClipStaleReason(scene(), context(file)), null)
    const changed = Buffer.concat([PNG, Buffer.from('changed')])
    await image(changed)
    assert.match((await sceneClipStaleReason(scene({ image_sha256: sha(changed) }), context(file)))!, /source image/)
    await image()
    assert.match((await sceneClipStaleReason(scene({
      end_sec: 5, clip_sketch: { ...scene().clip_sketch, frames: 150 },
    }), context(file)))!, /scene length changed \(clip 4\.0s, scene now 5\.0s\)/)
    assert.match((await sceneClipStaleReason(scene({ end_sec: 4.5 }), context(file)))!, /scene length changed/)
    // A re-sync that moves the boundary by less than one frame keeps the drawing.
    assert.equal(await sceneClipStaleReason(scene({ end_sec: 4.02 }), context(file)), null)
    assert.match((await sceneClipStaleReason(scene(), context(file, settings(sha(Buffer.from('none')), 24))))!, /frame rate/)
    assert.match((await sceneClipStaleReason(scene({ clip_sketch: { ...scene().clip_sketch, helper_version: 1 } }), context(file)))!, /renderer/)
    assert.match((await sceneClipStaleReason(scene(), context(file, settings(sha(Buffer.from('logo'))))))!, /pen/)
  })

  test('without live context it compares the two recorded stamps, and says plainly when neither can prove the source', async () => {
    assert.equal(await sceneClipStaleReason(scene()), 'Sketch Draw cannot verify its source image here. Open Motion Review and Retry.')
    assert.equal(await sceneClipStaleReason(scene({ image_sha256: sha(Buffer.from('different')) })), 'stale source image')
    assert.equal(await sceneClipStaleReason(scene({ image_sha256: undefined })), 'Sketch Draw cannot verify its source image here. Open Motion Review and Retry.')
  })

  test('with context but no stored image stamp, a missing source file is stale, never a raw exception', async () => {
    const file = path.join(dir, 'missing.png')
    const reason = await sceneClipStaleReason(scene({ image_sha256: undefined }), context(file))
    assert.equal(reason, 'stale source image')
  })

  test('provider image-to-video clips ignore scene-window shifts; only sketch fits exactly', async () => {
    const file = await image()
    const provider = scene({ clip_renderer: 'image_to_video', clip_sketch: undefined, clip_scene_window_seconds: 3 })
    assert.equal(await sceneClipStaleReason(provider, context(file)), null)
    const legacy = scene({ clip_renderer: 'image_to_video', clip_sketch: undefined, clip_scene_window_seconds: undefined })
    assert.equal(await sceneClipStaleReason(legacy), null)
  })

  test('a settings-resolution failure is a plain sentence, never an exception string', async () => {
    const reason = await sceneClipStaleReason(scene(), { slug: 'no-such-channel', episodeId: 'EP001', episodeDir: dir })
    assert.equal(reason, 'Sketch Draw settings could not be checked. Choose the pen and Video Assembly frame rate again.')
  })

  test('a fresh pending clip is not stale, so retry does not render it again', async () => {
    const file = await image()
    const clip = path.join(dir, 'pending.mp4')
    await fs.writeFile(clip, Buffer.from('clip'))
    assert.equal(await isSceneClipFresh(scene({ motion_choice: 'pending' }), clip, context(file)), true)
  })

  test('selection parsing never invents a renderer or pen', () => {
    assert.deepEqual(motionPresentationSelection(undefined), { renderer: 'image_to_video', pen: 'none' })
    assert.deepEqual(motionPresentationSelection({ renderer: 'sketch_draw', pen: 'logo' }), { renderer: 'sketch_draw', pen: 'logo' })
    assert.deepEqual(motionPresentationSelection({ renderer: 'bogus', pen: 'brand' }), { renderer: 'image_to_video', pen: 'none' })
    assert.throws(() => sceneWindowSeconds({ start_sec: 2, end_sec: 2 }), /invalid scene window/)
  })
})

describe('Sketch Draw output proof', () => {
  async function makeClip(name: string, opts: { frames?: number; fps?: number; size?: string; audio?: boolean } = {}) {
    const frames = opts.frames ?? 10
    const fps = opts.fps ?? 10
    const size = opts.size ?? '64x64'
    const seconds = frames / fps
    const file = path.join(dir, name)
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=red:s=${size}:r=${fps}:d=${seconds}`,
      ...(opts.audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : []),
      '-t', String(seconds), '-frames:v', String(frames), '-r', String(fps),
      ...(opts.audio ? ['-c:a', 'aac'] : []),
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file])
    return file
  }

  test('accepts an exact frame count, CFR and silent H.264 geometry', async () => {
    const file = await makeClip('good.mp4')
    assert.equal(await assertSketchDrawClip(file, { fps: 10, frames: 10, width: 64, height: 64 }), 1)
  })

  test('rejects a wrong frame count', async () => {
    const file = await makeClip('short.mp4', { frames: 9 })
    await assert.rejects(assertSketchDrawClip(file, { fps: 10, frames: 10, width: 64, height: 64 }), /frame count|contains/)
  })

  test('rejects a wrong frame rate and wrong geometry', async () => {
    const file = await makeClip('wrong-fps.mp4')
    await assert.rejects(assertSketchDrawClip(file, { fps: 12, frames: 10, width: 64, height: 64 }), /frame|geometry|Requested/)
    await assert.rejects(assertSketchDrawClip(file, { fps: 10, frames: 10, width: 32, height: 32 }), /frame|geometry|Requested/)
  })

  test('rejects an output that carries audio', async () => {
    const file = await makeClip('with-audio.mp4', { audio: true })
    await assert.rejects(assertSketchDrawClip(file, { fps: 10, frames: 10, width: 64, height: 64 }), /silent|frame count|frame rate|geometry/)
  })

  test('the TypeScript helper version and the Swift helper version stay in step', () => {
    const swift = readFileSync(new URL('../../../native/scene-clip/main.swift', import.meta.url), 'utf8')
    assert.equal(Number(swift.match(/let HELPER_VERSION = (\d+)/)?.[1]), NATIVE_SCENE_CLIP_VERSION)
  })
})

describe('Sketch Draw activation', () => {
  async function planFixture() {
    const root = await fs.mkdtemp(path.join(dir, 'plan-'))
    const planPath = path.join(root, 'scene_plan.json')
    await fs.writeFile(planPath, JSON.stringify({ scenes: [scene()] }))
    return { root, planPath }
  }

  test('a verified candidate is renamed and its evidence is stored only after activation', async () => {
    const { root, planPath } = await planFixture()
    const file = await image()
    const candidate = path.join(root, 'candidate.mp4')
    await fs.writeFile(candidate, Buffer.from('candidate'))
    // tiny-video bytes stand in for a verified output; assertSketchDrawClip is separately pinned by the media suite.
    const { tinyVideoBytes } = await import('./fixtures/tiny-video.js')
    await fs.writeFile(candidate, tinyVideoBytes())
    const final = path.join(root, 'scene-1.mp4')
    await checkpointSceneClip(planPath, 'scene-1', final, '', undefined, true, {
      renderer: 'sketch_draw', source_image_sha256: sha(PNG), scene_window_seconds: 4,
      duration_seconds: 1, sketch: scene().clip_sketch, candidate_path: candidate,
      context: context(file),
    })
    assert.deepEqual(await fs.readFile(final), tinyVideoBytes())
    await assert.rejects(fs.readFile(candidate), /ENOENT/)
    const saved = JSON.parse(await fs.readFile(planPath, 'utf8')).scenes[0]
    assert.equal(saved.clip_renderer, 'sketch_draw')
    assert.equal(saved.clip_source_image_sha256, sha(PNG))
    assert.equal(saved.motion_choice, 'clip')
  })

  test('a plan/window/pen change during rendering refuses activation and preserves the prior clip', async () => {
    const { root, planPath } = await planFixture()
    const file = await image()
    const prior = path.join(root, 'scene-1.mp4')
    await fs.writeFile(prior, Buffer.from('prior accepted'))
    const candidate = path.join(root, 'candidate.mp4')
    await fs.writeFile(candidate, Buffer.from('new candidate'))
    await assert.rejects(
      checkpointSceneClip(planPath, 'scene-1', prior, '', undefined, true, {
        renderer: 'sketch_draw', source_image_sha256: sha(PNG), scene_window_seconds: 5,
        duration_seconds: 4, sketch: scene().clip_sketch, candidate_path: candidate,
        context: context(file),
      }),
      /changed while Sketch Draw rendered/,
    )
    assert.deepEqual(await fs.readFile(prior), Buffer.from('prior accepted'))
    assert.deepEqual(await fs.readFile(candidate), Buffer.from('new candidate'))
  })

  test('cancellation after verification leaves the previous clip untouched', async () => {
    const { root, planPath } = await planFixture()
    const file = await image()
    const prior = path.join(root, 'scene-1.mp4')
    await fs.writeFile(prior, Buffer.from('prior accepted'))
    const candidate = path.join(root, 'candidate.mp4')
    await fs.writeFile(candidate, Buffer.from('verified candidate'))
    await assert.rejects(
      checkpointSceneClip(planPath, 'scene-1', prior, '', undefined, true, {
        renderer: 'sketch_draw', source_image_sha256: sha(PNG), scene_window_seconds: 4,
        duration_seconds: 4, sketch: scene().clip_sketch, candidate_path: candidate,
        context: context(file), assertActive: () => { throw new Error('Cancelled by user') },
      }),
      /Cancelled by user/,
    )
    assert.deepEqual(await fs.readFile(prior), Buffer.from('prior accepted'))
    assert.deepEqual(await fs.readFile(candidate), Buffer.from('verified candidate'))
  })

  test('completion audit refuses a sketch with no checked evidence and names the scene', async () => {
    const { root, planPath } = await planFixture()
    const clips = path.join(root, 'clips')
    await fs.mkdir(clips)
    await fs.writeFile(path.join(clips, 'scene-1.mp4'), Buffer.from('clip'))
    const file = await image()
    const saved = JSON.parse(await fs.readFile(planPath, 'utf8'))
    saved.scenes[0].clip_renderer = 'sketch_draw'
    saved.scenes[0].clip_source_image_sha256 = sha(await fs.readFile(file))
    delete saved.scenes[0].clip_sketch
    await fs.writeFile(planPath, JSON.stringify(saved))
    const audit = await auditSceneClipCompletion(planPath, ['scene-1'], clips, {}, context(file))
    assert.deepEqual(audit.missing, [])
    assert.match(audit.invalid[0]!, /scene-1 \(stale Sketch Draw renderer\)/)
  })

  test('a fresh sketch still has to be selected before the audit calls the episode complete', async () => {
    const { root, planPath } = await planFixture()
    const clips = path.join(root, 'clips')
    await fs.mkdir(clips)
    await fs.writeFile(path.join(clips, 'scene-1.mp4'), Buffer.from('clip'))
    const file = await image()
    const saved = JSON.parse(await fs.readFile(planPath, 'utf8'))
    saved.scenes[0].clip_source_image_sha256 = sha(await fs.readFile(file))
    saved.scenes[0].motion_choice = 'pending'
    await fs.writeFile(planPath, JSON.stringify(saved))
    const audit = await auditSceneClipCompletion(planPath, ['scene-1'], clips, {}, context(file))
    assert.deepEqual(audit.invalid, ['scene-1 (clip not selected)'])

    // Motion Review's Generate leaves clips for review: selection is not required, the media still is.
    const forReview = await auditSceneClipCompletion(planPath, ['scene-1'], clips, {}, { ...context(file), requireSelected: false })
    assert.equal(forReview.invalid.some(item => /not selected/.test(item)), false)
    assert.equal(forReview.invalid.length, 1, 'the unplayable placeholder bytes still fail the media check')
  })
})
