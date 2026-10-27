/**
 * Video expansion (owner, 2026-10-26): a scene names its own lane, Scene Plan respects the planned
 * model's live clip length, and a text-to-video scene writes a video prompt rather than borrowing
 * an image prompt.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScenePlanEntry } from '../models/types.js'
import { checkScenesAgainstModelBounds, generateVideoPromptOnly } from '../services/scene-planner.js'

function scene(patch: Partial<ScenePlanEntry>): ScenePlanEntry {
  return {
    id: 's1', scene_index: 1, start_sec: 0, end_sec: 5, transcript_segment: 'A lantern drifts.',
    visual_prompt: 'A lantern drifting down a river at dusk.', ...patch,
  } as ScenePlanEntry
}

test('a scene inside the model clip range is never flagged', () => {
  const result = checkScenesAgainstModelBounds([scene({ end_sec: 5, visual_lane: 'text_to_video' })], {
    min_clip_seconds: 2, max_clip_seconds: 10,
  })
  assert.deepEqual(result.misfits, [])
  assert.equal(result.allFit, true)
})

test('a scene shorter than the model minimum is flagged as an underflow, naming the range', () => {
  const result = checkScenesAgainstModelBounds([scene({ end_sec: 1.5, visual_lane: 'image_to_video' })], {
    min_clip_seconds: 4, max_clip_seconds: 30,
  })
  assert.equal(result.allFit, false)
  assert.equal(result.misfits.length, 1)
  const misfit = result.misfits[0]!
  assert.equal(misfit.underflow, true)
  assert.equal(misfit.overflow, false)
  assert.equal(misfit.min_seconds, 4)
  assert.equal(misfit.max_seconds, 30)
})

test('a scene longer than the model maximum is flagged and carries a fill strategy', () => {
  const result = checkScenesAgainstModelBounds([scene({ end_sec: 12, visual_lane: 'text_to_video' })], {
    min_clip_seconds: 2, max_clip_seconds: 10,
  })
  assert.equal(result.misfits.length, 1)
  assert.equal(result.misfits[0]!.overflow, true)
  assert.equal(result.misfits[0]!.fill_mode, 'hold')
})

test('a still scene is not measured against a video model at all', () => {
  const result = checkScenesAgainstModelBounds([
    scene({ id: 'a', end_sec: 90, visual_lane: 'still' }),
    scene({ id: 'b', end_sec: 90, motion_choice: 'still' }),
  ], { min_clip_seconds: 2, max_clip_seconds: 10 })
  assert.deepEqual(result.misfits, [])
})

test('the video prompt is built from the narration and the channel style, and cleaned', async () => {
  let seenSystem = ''
  let seenUser = ''
  const prompt = await generateVideoPromptOnly({
    transcript_segment: 'The lantern slips under the bridge.',
    visual_prompt: 'A paper lantern on black water.',
    model: 'test-model',
    style_prompt: 'ink-wash painting',
    apiKeys: {},
    callAi: (async (_model: string, system: string, user: string) => {
      seenSystem = system
      seenUser = user
      return '```\nVideo prompt: A slow low dolly follows a paper lantern under a stone bridge, ink-wash style.```'
    }) as any,
  })
  assert.equal(prompt, 'A slow low dolly follows a paper lantern under a stone bridge, ink-wash style.')
  assert.match(seenSystem, /text-to-video/i)
  assert.match(seenSystem, /ink-wash painting/)
  assert.match(seenUser, /lantern slips under the bridge/i)
  assert.match(seenUser, /paper lantern on black water/i)
})

test('an empty model answer stays empty so the caller can report the miss', async () => {
  const prompt = await generateVideoPromptOnly({
    transcript_segment: 'x', model: 'test-model', apiKeys: {},
    callAi: (async () => '   ') as any,
  })
  assert.equal(prompt, '')
})
