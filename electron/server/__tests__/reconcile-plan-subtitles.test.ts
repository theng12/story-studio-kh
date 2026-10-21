/**
 * v1.0.523 — pins reconcilePlanToSubtitles (services/scene-planner.ts): re-
 * anchoring a stale plan's timings to the current subtitles by matching each
 * scene's transcript text, preserving scene ids/images.
 *
 *   - a uniformly-shifted plan (the real EP0022 case: scenes 28s ahead
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

import { reconcilePlanToSubtitles, removeNonRenderableScenes, computePlanCoverage } from '../services/scene-planner.js'
import { unrenderableSceneProblem, MIN_RENDERABLE_SCENE_SEC } from '../lib/scene-plan-timeline.js'

function scene(id: string, start: number, end: number, transcript: string) {
  return { id, start_sec: start, end_sec: end, scene_index: 0, transcript_segment: transcript, visual_prompt: '', approved: true } as any
}
function cue(start: number, end: number, text: string) {
  return { index: 0, start_sec: start, end_sec: end, text } as any
}

describe('unrenderableSceneProblem', () => {
  /** Contiguous rows from a list of durations. */
  function rows(durations: number[]): Array<{ start_sec: number; end_sec: number }> {
    let cursor = 0
    return durations.map(duration => {
      const row = { start_sec: cursor, end_sec: cursor + duration }
      cursor += duration
      return row
    })
  }

  test('refuses the HMH0001 sparse-reconcile shape: one long hold, 855 sub-frame rows', () => {
    // Measured from HMH0001 (2026-10-21): 34 normal rows, one 2196.28s hold,
    // nine 38.4s interpolated rows, then 855 rows ~11ms each — plan total
    // 2823.9s, so every coverage check passed.
    const scenes = rows([
      ...Array.from({ length: 34 }, () => 4),
      2196.28,
      ...Array.from({ length: 9 }, () => 38.4),
      ...Array.from({ length: 855 }, () => 0.011),
    ])
    assert.equal(scenes.length, 899)
    const problem = unrenderableSceneProblem(scenes)
    assert.ok(problem, 'the mostly-sub-frame plan is refused')
    assert.match(problem!, /855 of 899 scene\(s\) are below the 0\.5s window/)
  })

  test('accepts a plan whose rows are real pacing windows', () => {
    const scenes = rows(Array.from({ length: 899 }, (_, i) => 2 + (i % 3)))
    assert.equal(unrenderableSceneProblem(scenes), null)
  })

  test('allows one short FINAL row but refuses a short row anywhere else', () => {
    const finalSliver = rows([3, 3, 3, 3, MIN_RENDERABLE_SCENE_SEC / 2])
    assert.equal(unrenderableSceneProblem(finalSliver), null, 'the episode\'s residual last sliver is allowed')
    const midPlan = rows([3, MIN_RENDERABLE_SCENE_SEC / 2, 3, 3])
    assert.ok(unrenderableSceneProblem(midPlan), 'a short row in the middle is not a timing')
  })

  test('a zero, negative or non-finite FINAL duration is not the residual sliver', () => {
    const head = rows([3, 3, 3])          // 0→3, 3→6, 6→9
    const tail = (end: number) => [...head, { start_sec: 9, end_sec: end }]
    assert.ok(unrenderableSceneProblem(tail(9)), 'a zero-length final row is reported')
    assert.ok(unrenderableSceneProblem(tail(8.7)), 'a negative final duration is reported')
    assert.ok(unrenderableSceneProblem(tail(NaN)), 'a non-finite final duration is reported')
    assert.ok(unrenderableSceneProblem(tail(Infinity)), 'an infinite final duration is reported')
  })
})

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
    assert.equal(r.unsafe_reason, null, 'a real re-anchor is not flagged')
  })

  // HMH0001 (2026-10-21): a false anchor six common words long can jump far ahead in the cue
  // stream, and the unmatched run after it is then interpolated into whatever time is left. When
  // that leaves rows below the window the renderer plays, the pure boundary must say so — the
  // plan's total still reaches the narration either way.
  test('a sparse anchor set that cannot be interpolated into renderable rows reports unsafe_reason', () => {
    const cues = [
      cue(0, 8, 'alpha bravo charlie delta echo foxtrot golf'),
      cue(8, 14, 'hotel india juliet kilo lima mike november'),
      cue(14, 20, 'oscar papa quebec romeo sierra tango uniform'),
      cue(20, 30, 'victor whiskey xray yankee zulu anchor omega'),
    ]
    const plan = [
      scene('s1', 0, 2, 'alpha bravo charlie delta echo foxtrot golf'),
      // A false jump: this scene anchors at 20s, leaving 40 scenes to fit in the last 10s.
      scene('s2', 2, 4, 'victor whiskey xray yankee zulu anchor omega'),
      ...Array.from({ length: 40 }, (_, i) =>
        scene(`ghost-${i}`, 4 + i * 0.1, 4 + (i + 1) * 0.1, `unrelated words row ${i} nothing here to match`)),
    ]
    const r = reconcilePlanToSubtitles(plan, cues, 30)
    assert.ok(r.unsafe_reason, 'the interpolation cannot be a timeline')
    assert.match(r.unsafe_reason!, /are below the 0\.5s window the renderer plays/)
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

  test('scene 1 is never moved later: it holds over the opening (1.4.296, Brain Wise EP0044)', () => {
    const opening = [cue(3.7, 6, 'The sun dips below the ridge and the temperature drops fast.'), ...cues.slice(1)]
    const r = reconcilePlanToSubtitles([
      scene('s1', 0, 6, 'The sun dips below the ridge and the temperature drops fast.'),
      scene('s2', 6, 12, 'You feel it in your bones as your breath starts to mist.'),
    ], opening, 30)
    assert.equal(r.scenes[0]!.start_sec, 0)
    assert.equal(r.scenes[1]!.start_sec, 6)
  })

  // Every word in a cue carries that CUE's window, so two scenes whose anchors land
  // in the same cue both anchor to its start. Left tied they collapsed onto one
  // instant; the derived end then made the earlier one zero-length, and the
  // `removeNonRenderableScenes` cleanup that the reconcile route runs next DELETED
  // it — with its saved prompt, its approved image and its approval. Measured on
  // HMH0001 (2026-10-19): 39 rows removed, 19 of them approved with an image, on a
  // route whose contract is "preserves every scene id, image, and prompt".
  test('two scenes anchored inside the SAME cue keep a real window each (HMH0001)', () => {
    const oneCue = [
      cue(0, 10, 'The sun dips below the ridge and the temperature drops fast.'),
      cue(10, 20, 'You feel it in your bones as your breath starts to mist.'),
    ]
    const plan = [
      scene('s1', 0, 4, 'The sun dips below the ridge'),
      scene('s2', 4, 8, 'and the temperature drops fast'),
      scene('s3', 8, 12, 'You feel it in your bones'),
    ]
    // Both s1 and s2 anchor to cue 1's start (0): their words share one cue window.
    const r = reconcilePlanToSubtitles(plan, oneCue, 20)
    assert.deepEqual(r.scenes.map(s => s.start_sec), [0, 5, 10], 'the tie is spread, not collapsed')

    const cleanup = removeNonRenderableScenes(r.scenes)
    assert.deepEqual(cleanup.removed_ids, [], 'no scene is deleted for its approved image')
    assert.deepEqual(cleanup.scenes.map(s => s.id), ['s1', 's2', 's3'])
    assert.ok(cleanup.scenes.every(s => s.end_sec > s.start_sec), 'every scene keeps a positive window')
    assert.deepEqual(cleanup.scenes.map(s => s.approved), [true, true, true], 'approvals survive')
    assert.equal(computePlanCoverage(cleanup.scenes, 20).uncoveredTotalSec, 0, 'still gap-free')
  })
})
