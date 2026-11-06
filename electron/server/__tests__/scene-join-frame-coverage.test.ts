/**
 * MineePod EP0018 — job b2fbc929 (installed 1.4.383).
 *
 * The final Video job joined 104 scene clips and then refused the encode:
 *   "The joined scene video is 2268.1s but this render needs 2268.4s"
 * The receipt's intermediate was 68043 frames at 30fps (2268.100s) against a
 * 2268.380s render target. Each scene clip encodes `round(duration × fps)`
 * frames, but the plan summed the float durations: the body rendered 67302
 * frames where the plan assumed 67305.4, the tail then shrank by the same
 * rounding loss, and the picture ended 8.4 frames (0.28s) early — past the
 * strict 0.25s picture slack.
 *
 * The fix is not in the guard: every scene duration is normalised to an exact
 * frame count (the last scene absorbs the remainder), and the tail is rounded
 * up to the next frame boundary, so the planner sum, the rendered clips and the
 * tail all describe the same frames. These tests pin the receipt, that
 * integration, and the first fix attempt that only extended the last clip.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPictureLength } from '../lib/final-duration-guard.js'
import {
  buildScenePlayOrder,
  frameExactSceneDurations,
  frameExactTailDuration,
} from '../generators/video.js'

const FPS = 30
const JOINED_FRAMES = 68043
const NEEDED_SEC = 2268.38
const HOLD_FRAMES = 750 // the 25s hold-last-scene tail, rendered whole

// body checkpoint `completed_scene_clips[].render_duration_sec`, in plan order
const EP0018_SCENE_SECONDS = [
  11.534, 11.44, 7.96, 9.02, 9.2, 7.24, 7.38, 10, 9.2, 9.8, 9.3, 9.32, 7.08, 11.08, 8.6, 9, 8.34,
  6.18, 12.66, 9.378, 14.04, 18.78, 16.78, 15.48, 16.6, 15.82, 19.18, 15.38, 15.38, 16.28, 13.1,
  26.152, 25.58, 23.86, 23.9, 23.58, 28.72, 24.08, 28.66, 27.475, 29.16, 31.72, 31.84, 25.32,
  25.6, 24.94, 23.58, 25.207, 23.14, 26, 24.22, 27.18, 27.58, 23.72, 25.62, 23.306, 27.18, 27.32,
  22.92, 27.44, 26.24, 23.04, 26.466, 24.46, 28.64, 27.1, 24.3, 29.74, 27.48, 23.16, 24.98,
  28.84, 28.18, 22.711, 26.5, 23.88, 27.52, 29.24, 29.98, 26.78, 26.12, 28.34, 21.937, 28.28,
  22.18, 24.22, 26.76, 28.04, 22.82, 23.92, 23.34, 27.34, 21.704, 25.64, 24.64, 27.64, 23.66,
  22.56, 28.88, 24.48, 27.54, 27.88, 26.46, 14.23,
]

const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0)
const encodedFrames = (durations: number[]) => total(durations.map(duration => Math.round(duration * FPS)))

/** The shipped planner's plan-strict contract: it copies each duration verbatim. */
const plan = (durations: number[]) => buildScenePlayOrder({
  availableClips: durations.map((_, index) => `scene_${index}.mp4`),
  availableDurations: durations,
  sceneDuration: 10,
  sceneFillDuration: total(durations),
  durationPerCycle: total(durations),
  shuffle: false,
  planStrict: true,
})

test('MineePod EP0018: float scene durations put the join 0.28s short', () => {
  assert.equal(EP0018_SCENE_SECONDS.length, 104)
  assert.equal(encodedFrames(EP0018_SCENE_SECONDS) + HOLD_FRAMES, JOINED_FRAMES)
  assert.equal(JOINED_FRAMES / FPS, 2268.1)
  // The shape the guard refused — and it must keep refusing it: this is a real shortfall.
  assert.deepEqual(checkPictureLength(JOINED_FRAMES / FPS, NEEDED_SEC), {
    state: 'short',
    shortBySec: NEEDED_SEC - JOINED_FRAMES / FPS,
  })
})

test('the planner sum, the rendered scene frames and the tail agree after the fix', () => {
  const fixed = frameExactSceneDurations(EP0018_SCENE_SECONDS, FPS)

  // buildConcatList reads sum(clip.duration) to place the tail. That sum must be the body the
  // clips encode — the first fix attempt left the other float durations here and did not.
  const sceneEndTime = total(plan(fixed).scenePlayOrder.map(clip => clip.duration))
  const bodyFrames = encodedFrames(fixed)
  assert.ok(Math.abs(sceneEndTime - bodyFrames / FPS) < 1e-9, `${sceneEndTime}s planner sum vs ${bodyFrames}f body`)
  assert.equal(bodyFrames, Math.ceil(total(EP0018_SCENE_SECONDS) * FPS - 1e-9), 'body covers the narration end')

  const postDuration = frameExactTailDuration(NEEDED_SEC, sceneEndTime, FPS)
  const joinedFrames = bodyFrames + Math.round(postDuration * FPS)
  assert.equal(joinedFrames, 68052)
  assert.ok(joinedFrames / FPS >= NEEDED_SEC, 'body + tail reach the planned target')
  assert.deepEqual(checkPictureLength(joinedFrames / FPS, NEEDED_SEC), { state: 'ok' })
})

test('extending only the last clip reproduces 68043 — every duration must be frame-exact', () => {
  // The first repair kept the other 103 float durations and only lengthened the last clip. The
  // planner then summed 2243.683333s while the clips rendered 2243.4s, the derived tail lost the
  // same 0.28s, and the join landed back on 68043 frames.
  const frames = EP0018_SCENE_SECONDS.map(duration => Math.round(duration * FPS))
  frames[frames.length - 1]! += Math.ceil(total(EP0018_SCENE_SECONDS) * FPS - 1e-9) - total(frames)
  const lastOnly = [...EP0018_SCENE_SECONDS]
  lastOnly[lastOnly.length - 1] = frames[frames.length - 1]! / FPS

  const naiveEnd = total(plan(lastOnly).scenePlayOrder.map(clip => clip.duration))
  assert.ok(Math.abs(naiveEnd - 2243.683333333334) < 1e-9)
  assert.ok(naiveEnd - encodedFrames(lastOnly) / FPS > 0.25, 'planner claims a body the clips cannot render')

  const postDuration = frameExactTailDuration(NEEDED_SEC, naiveEnd, FPS)
  const joinedFrames = encodedFrames(lastOnly) + Math.round(postDuration * FPS)
  assert.equal(joinedFrames, JOINED_FRAMES)
  assert.equal(checkPictureLength(joinedFrames / FPS, NEEDED_SEC).state, 'short')
})

test('frameExactSceneDurations: a frame-exact plan is returned unchanged', () => {
  const durations = [10, 5.5, 2.4] // 300 + 165 + 72 frames at 30fps
  assert.deepEqual(frameExactSceneDurations(durations, FPS), durations)
})

test('frameExactTailDuration: rounds up to the frame boundary that reaches the target', () => {
  assert.equal(frameExactTailDuration(2268.38, 2243.4, FPS), 25)
  assert.equal(frameExactTailDuration(10.04, 10, FPS), 2 / FPS, '1.2 frames of tail need 2')
  assert.equal(frameExactTailDuration(10.01, 10, FPS), 0, 'a sub-frame remainder stays zero, as before')
  assert.equal(frameExactTailDuration(10, 10, FPS), 0, 'no tail when the body already ends on target')
  assert.equal(frameExactTailDuration(10, 11, FPS), 0, 'never a negative tail')
})

test('frame helpers: an unusable frame rate leaves the plan untouched', () => {
  for (const fps of [0, -30, NaN, Infinity]) {
    assert.deepEqual(frameExactSceneDurations([1, 2], fps), [1, 2], String(fps))
    assert.equal(frameExactTailDuration(10, 5, fps), 0, String(fps))
  }
})
