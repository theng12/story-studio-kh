/**
 * v1.0.523 — pins reconcilePlanToSubtitles (services/scene-planner.ts): re-
 * anchoring a stale plan's timings to the current subtitles by matching each
 * scene's transcript text, preserving scene ids/images.
 *
 *   - a uniformly-shifted plan (the brain-wise EP0022 case: scenes 28s ahead
 *     of the voice) snaps back onto the cue times; ids preserved.
 *   - result is contiguous (end = next start), monotonic, last scene ends at
 *     the audio/SRT end → zero coverage gap by construction.
 *   - a scene whose text isn't in the SRT is interpolated + reported.
 *   - minor wording drift still matches (>=60% of the anchor).
 *
 * Pure imports only.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { reconcilePlanToSubtitles, computePlanCoverage } from '../services/scene-planner.js'

function scene(id: string, start: number, end: number, transcript: string) {
  return { id, start_sec: start, end_sec: end, scene_index: 0, transcript_segment: transcript, visual_prompt: '', approved: true } as any
}
function cue(start: number, end: number, text: string) {
  return { index: 0, start_sec: start, end_sec: end, text } as any
}

describe('reconcilePlanToSubtitles', () => {
  // SRT: story actually plays [0, 30]. Plan below is timestamped 28s late.
  const cues = [
    cue(0, 6, 'The sun dips below the ridge and the temperature drops fast.'),
    cue(6, 12, 'You feel it in your bones as your breath starts to mist.'),
    cue(12, 20, 'A cave mouth yawns in the cliff, dark and quiet and cold.'),
    cue(20, 30, 'But something already lives there, and it remembers the way home.'),
  ]

  test('snaps a 28s-shifted plan back onto the cue times; ids + count preserved', () => {
    const plan = [
      scene('s1', 28, 34, 'The sun dips below the ridge and the temperature drops fast.'),
      scene('s2', 34, 40, 'You feel it in your bones as your breath starts to mist.'),
      scene('s3', 40, 48, 'A cave mouth yawns in the cliff, dark and quiet and cold.'),
      scene('s4', 48, 58, 'But something already lives there, and it remembers the way home.'),
    ]
    const r = reconcilePlanToSubtitles(plan, cues, 30)
    assert.equal(r.matchedCount, 4)
    assert.deepEqual(r.unmatchedIds, [])
    assert.deepEqual(r.scenes.map(s => s.id), ['s1', 's2', 's3', 's4'], 'ids preserved (images survive)')
    assert.deepEqual(r.scenes.map(s => s.start_sec), [0, 6, 12, 20], 'starts snapped to cue starts')
    assert.equal(r.scenes[3]!.end_sec, 30, 'last scene ends at the audio end')
    assert.ok(Math.abs(r.medianShiftSec + 28) < 0.01, 'reports the ~-28s shift')
  })

  test('result is contiguous, monotonic, and fully covers the audio', () => {
    const plan = [
      scene('s1', 28, 34, 'The sun dips below the ridge and the temperature drops fast.'),
      scene('s2', 40, 48, 'A cave mouth yawns in the cliff, dark and quiet and cold.'),
    ]
    const r = reconcilePlanToSubtitles(plan, cues, 30)
    for (let i = 0; i < r.scenes.length - 1; i++) {
      assert.equal(r.scenes[i]!.end_sec, r.scenes[i + 1]!.start_sec, 'end == next start (no gaps)')
      assert.ok(r.scenes[i + 1]!.start_sec >= r.scenes[i]!.start_sec, 'monotonic')
    }
    assert.equal(computePlanCoverage(r.scenes, 30).uncoveredTotalSec, 0, 'zero coverage gap after reconcile')
  })

  test('a scene whose text is absent from the SRT is interpolated and reported', () => {
    const plan = [
      scene('s1', 28, 34, 'The sun dips below the ridge and the temperature drops fast.'),
      scene('ghost', 34, 40, 'This narration does not exist anywhere in the subtitles at all.'),
      scene('s3', 40, 48, 'A cave mouth yawns in the cliff, dark and quiet and cold.'),
    ]
    const r = reconcilePlanToSubtitles(plan, cues, 30)
    assert.deepEqual(r.unmatchedIds, ['ghost'])
    // interpolated strictly between its matched neighbours (0 and 12)
    assert.ok(r.scenes[1]!.start_sec > 0 && r.scenes[1]!.start_sec < 12)
    assert.ok(r.changes.some(c => /interpolated/.test(c)))
  })

  test('minor wording drift still matches (>=60% of the anchor)', () => {
    const plan = [
      // "ridge" → "cliff", one word off out of six — still matches.
      scene('s1', 28, 34, 'The sun dips below the cliff and everything goes still.'),
    ]
    const r = reconcilePlanToSubtitles(plan, cues, 30)
    assert.equal(r.matchedCount, 1)
    assert.equal(r.scenes[0]!.start_sec, 0)
  })

  test('empty inputs are safe', () => {
    assert.equal(reconcilePlanToSubtitles([], cues, 30).scenes.length, 0)
    const noCues = reconcilePlanToSubtitles([scene('s1', 5, 9, 'anything')], [], 30)
    assert.deepEqual(noCues.unmatchedIds, ['s1'])
  })
})
