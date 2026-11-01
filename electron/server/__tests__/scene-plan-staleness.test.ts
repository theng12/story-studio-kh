/**
 * v1.4.374 — a re-plan must not let a picture or clip drawn for different
 * narration count as done.
 *
 * EP0006, 2026-11-01: a forced re-plan went from 36 to 68 scenes. Scene ids
 * restart at scene-0001, so ids 0001–0036 still had the old plan's pictures on
 * disk. The next image batch reported "32/32 target scene(s) verified; 36
 * skipped" and kept them. The verdict must come from the plan's own facts — the
 * prompt a picture was rendered from — never from the id.
 *
 * These tests pin the rule and the carry-over that feeds it, plus the two
 * places that consume it (the image batch and clip freshness).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { carrySceneMediaForward, countReplanPictures, sceneImageStaleReason } from '../services/scene-plan-staleness.js'
import { selectSceneImageBatch } from '../services/scene-image-batch-selection.js'

useTempDataDir()

const picture = (id: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  id,
  scene_index: Number(id.slice(-4)),
  start_sec: 0,
  end_sec: 5,
  duration_sec: 5,
  visual_prompt: prompt,
  image_path: `/images/${id}.png`,
  image_version: 'v1',
  image_sha256: 'abc',
  rendered_prompt: prompt,
  approved: true,
  ...extra,
} as any)

const replacement = (id: string, prompt: string) => ({
  id,
  scene_index: Number(id.slice(-4)),
  start_sec: 0,
  end_sec: 5,
  duration_sec: 5,
  visual_prompt: prompt,
} as any)

const plan = (scenes: any[]) => ({ schema_version: 1, generated_at: '2026-11-01T00:00:00.000Z', scenes } as any)

test('re-plan that changes a prompt makes the old picture stale and it re-enters the batch', () => {
  const onDisk = plan([picture('ep-scene-0001', 'a fox in a snowy wood')])
  const incoming = plan([replacement('ep-scene-0001', 'a wolf on a burning moor')])

  assert.equal(carrySceneMediaForward(incoming, onDisk), 1)
  const scene = incoming.scenes[0]!

  // The picture is still on disk, and its record says which prompt it shows.
  assert.equal(scene.image_path, '/images/ep-scene-0001.png')
  assert.equal(scene.rendered_prompt, 'a fox in a snowy wood')
  // …and that record is not this scene's prompt any more.
  assert.match(sceneImageStaleReason(scene) || '', /outdated prompt/)

  // The batch must therefore draw it, not skip it.
  const batch = selectSceneImageBatch(incoming.scenes, { hasRenderedImage: () => false })
  assert.deepEqual(batch.map(item => item.id), ['ep-scene-0001'])
})

test('re-plan that keeps a prompt keeps the picture, its stamp and its approval', () => {
  const onDisk = plan([picture('ep-scene-0001', 'a fox in a snowy wood')])
  const incoming = plan([replacement('ep-scene-0001', 'a fox in a snowy wood')])

  assert.equal(carrySceneMediaForward(incoming, onDisk), 1)
  const scene = incoming.scenes[0]!

  assert.equal(sceneImageStaleReason(scene), null)
  assert.equal(scene.approved, true)
  assert.equal(scene.image_version, 'v1')
  assert.deepEqual(countReplanPictures(incoming), { kept: 1, redraw: 0 })
})

test('a re-plan that adds scenes carries only the ids it kept, and drops none', () => {
  const onDisk = plan([
    picture('ep-scene-0001', 'one'),
    picture('ep-scene-0002', 'two'),
  ])
  const incoming = plan([
    replacement('ep-scene-0001', 'one'),
    replacement('ep-scene-0002', 'two changed'),
    replacement('ep-scene-0003', 'brand new'),
    replacement('ep-scene-0004', 'also new'),
  ])

  assert.equal(carrySceneMediaForward(incoming, onDisk), 2)
  assert.deepEqual(countReplanPictures(incoming), { kept: 1, redraw: 1 })
  // A scene the new plan added has nothing carried and is simply unrendered.
  assert.equal(incoming.scenes[2]!.image_path, undefined)
  assert.equal(sceneImageStaleReason(incoming.scenes[2]!), null)
})

test('a re-plan that keeps fewer scenes carries only the scenes the new plan has', () => {
  const onDisk = plan([
    picture('ep-scene-0001', 'one'),
    picture('ep-scene-0002', 'two'),
    picture('ep-scene-0003', 'three'),
  ])
  const incoming = plan([replacement('ep-scene-0001', 'one')])

  assert.equal(carrySceneMediaForward(incoming, onDisk), 1)
  assert.equal(incoming.scenes.length, 1)
  assert.equal(sceneImageStaleReason(incoming.scenes[0]!), null)
  // The dropped scenes' files are left exactly where they are — a re-plan never
  // deletes a rendered asset.
  assert.equal(incoming.scenes[0]!.image_path, '/images/ep-scene-0001.png')
})

test('a picture rendered before rendered_prompt existed stays accepted when no re-plan touched it', () => {
  const legacy = { ...picture('ep-scene-0001', 'a fox'), rendered_prompt: undefined } as any
  assert.equal(sceneImageStaleReason(legacy), null)
  assert.deepEqual(countReplanPictures(plan([legacy])), { kept: 1, redraw: 0 })
})

test('a legacy picture gets a truthful record across a re-plan: kept when the prompt matches, stale when it changed', () => {
  const legacy = { ...picture('ep-scene-0001', 'a fox'), rendered_prompt: undefined } as any
  const same = plan([replacement('ep-scene-0001', 'a fox')])
  carrySceneMediaForward(same, plan([legacy]))
  assert.equal(same.scenes[0]!.rendered_prompt, 'a fox')
  assert.equal(sceneImageStaleReason(same.scenes[0]!), null)

  const changed = plan([replacement('ep-scene-0001', 'a wolf')])
  carrySceneMediaForward(changed, plan([legacy]))
  assert.match(sceneImageStaleReason(changed.scenes[0]!) || '', /outdated prompt/)
})

test('an already-stale picture is not healed by a re-plan that keeps its stale prompt', () => {
  // The owner edited the prompt, so the picture was already stale; the re-plan
  // keeps that edited prompt. It must stay stale.
  const onDisk = plan([picture('ep-scene-0001', 'an old wording', { rendered_prompt: 'an even older wording' })])
  const incoming = plan([replacement('ep-scene-0001', 'an old wording')])
  carrySceneMediaForward(incoming, onDisk)

  assert.equal(incoming.scenes[0]!.rendered_prompt, 'an even older wording')
  assert.match(sceneImageStaleReason(incoming.scenes[0]!) || '', /outdated prompt/)
})

test('a clip whose picture went stale is stale too, and a T2V clip is not', async () => {
  const { sceneClipStaleReason } = await import('../services/scene-media-checkpoint.js')

  const i2v = {
    ...picture('ep-scene-0001', 'new narration'),
    rendered_prompt: 'old narration',
    motion_choice: 'i2v',
    clip_path: '/clips/ep-scene-0001.mp4',
    clip_renderer: 'image_to_video',
    clip_source_image_version: 'v1',
  } as any
  assert.equal(await sceneClipStaleReason(i2v), 'stale source image')

  // Sketch Draw animates the same picture, so it goes with it.
  const sketch = { ...i2v, clip_renderer: 'sketch_draw', clip_sketch: true } as any
  assert.equal(await sceneClipStaleReason(sketch), 'stale source image')

  // Text-to-video is drawn from the video prompt alone; a stale still is not
  // evidence about the clip.
  const t2v = {
    ...i2v,
    visual_lane: 'text_to_video',
    clip_renderer: 'text_to_video',
    video_prompt: 'camera pushes in',
    rendered_video_prompt: 'camera pushes in',
  } as any
  assert.equal(await sceneClipStaleReason(t2v), null)
})

test('a forced redraw still takes every scene, stale or not', () => {
  const scenes = [picture('ep-scene-0001', 'a fox'), picture('ep-scene-0002', 'a wolf')]
  const batch = selectSceneImageBatch(scenes, { force: true, hasRenderedImage: () => true })
  assert.deepEqual(batch.map(item => item.id), ['ep-scene-0001', 'ep-scene-0002'])
})
