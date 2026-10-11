/**
 * v1.4.0 — a Scene Plan says when it is describing an older caption timeline.
 *
 * The stitched subtitle file is the INPUT Scene Plan is generated from, not
 * something produced after it. v1.4.0 made re-stitching automatic, which is safe
 * alone and dangerous in combination: a re-stitch that corrects a wrong intro
 * lead-in moves every cue, while the stored plan's scene times still follow the
 * old timing. Captions repaired, pictures still drifted, and nothing saying the
 * two disagree — the same "one episode, two answers" fault as the 1.3.4
 * incident, one layer up.
 *
 * Two asymmetries are asserted here on purpose, because both are easy to get
 * backwards:
 *
 *   - A TEXT change is not a timing change. The corrected-transcript pass
 *     rewrites words at unchanged timings, so hashing the file's bytes would
 *     declare a plan stale every time somebody fixed a spelling and push them
 *     towards an expensive repair for nothing.
 *   - An UNKNOWN timeline is not a stale one. The stitch's own fingerprint
 *     treats "no record" as "rebuild", because re-stitching is cheap and
 *     reversible. A plan is the opposite: one real episode has 124 generated
 *     images hanging off it, so claiming staleness without evidence would cost
 *     real money.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  compareTimeline,
  planNarrationShortfallSec,
  stampFromCues,
  timelineIdentity,
} from '../lib/scene-plan-timeline.js'
import type { SrtCue } from '../lib/subtitle-builder.js'

function cues(rows: Array<[number, number, string]>): SrtCue[] {
  return rows.map(([start_sec, end_sec, text], i) => ({ index: i + 1, start_sec, end_sec, text }))
}

const BASE = cues([
  [16.07, 22.0, 'In the summer of 408, the grain ships did not come.'],
  [140.0, 147.0, 'Rome had fed itself on Africa.'],
  [900.0, 907.0, 'The last distribution was recorded in a single line.'],
])

/** The same episode after a 16.07s lead-in error was corrected away. */
const SHIFTED = cues(BASE.map(c => [c.start_sec - 16.07, c.end_sec - 16.07, c.text] as [number, number, string]))

describe('the identity of a caption timeline', () => {
  test('is unchanged by rewriting the words', () => {
    // Exactly what the corrected-transcript pass does: ASR timings, script
    // words. A plan built on these timings is still perfectly valid.
    const reworded = cues(BASE.map(c => [c.start_sec, c.end_sec, `${c.text} (corrected)`] as [number, number, string]))
    assert.equal(timelineIdentity(reworded), timelineIdentity(BASE))
    assert.equal(compareTimeline(stampFromCues(BASE), stampFromCues(reworded)).stale, false)
  })

  test('changes when a cue moves, even by a few milliseconds', () => {
    const nudged = cues([[16.08, 22.0, 'a'], [140.0, 147.0, 'b'], [900.0, 907.0, 'c']])
    assert.notEqual(timelineIdentity(nudged), timelineIdentity(BASE))
  })

  test('does not depend on the order the cues arrive in', () => {
    assert.equal(timelineIdentity([...BASE].reverse()), timelineIdentity(BASE))
  })
})

describe('comparing a plan against the transcript on disk', () => {
  test('the real case: a corrected lead-in is reported as one shift, in seconds', () => {
    const drift = compareTimeline(stampFromCues(BASE), stampFromCues(SHIFTED))
    assert.equal(drift.stale, true)
    assert.equal(drift.drift_sec, -16.07)
    assert.match(drift.reason, /moved earlier by 16\.07s/)
    assert.match(drift.reason, /scene times still follow the old timing/)
  })

  test('an identical timeline is silent', () => {
    const drift = compareTimeline(stampFromCues(BASE), stampFromCues(BASE))
    assert.equal(drift.stale, false)
    assert.equal(drift.reason, '')
  })

  test('a plan with no recorded timeline is NOT called stale', () => {
    // The expensive-remedy asymmetry. Absence of proof is not proof here.
    for (const stored of [null, undefined, {} as never, { sha256: '' } as never]) {
      assert.equal(compareTimeline(stored, stampFromCues(BASE)).stale, false)
    }
  })

  test('a re-transcribe that changes the cue COUNT says so rather than inventing a shift', () => {
    const more = cues([...BASE, [950, 957, 'An extra caption.']].map(c =>
      Array.isArray(c) ? c as [number, number, string] : [c.start_sec, c.end_sec, c.text] as [number, number, string]))
    const drift = compareTimeline(stampFromCues(BASE), stampFromCues(more))
    assert.equal(drift.stale, true)
    // No number, because "the captions moved N seconds" would be false.
    assert.equal(drift.drift_sec, null)
    assert.match(drift.reason, /had 3 caption\(s\) and now has 4/)
  })

  test('a reshuffle that is not a uniform shift reports staleness without a number', () => {
    // Head unchanged, tail moved — a re-stitch with a different inter-chapter
    // gap. Real, and not describable as one offset.
    const uneven = cues([[16.07, 22.0, 'a'], [145.0, 152.0, 'b'], [930.0, 937.0, 'c']])
    const drift = compareTimeline(stampFromCues(BASE), stampFromCues(uneven))
    assert.equal(drift.stale, true)
    assert.equal(drift.drift_sec, null)
    assert.match(drift.reason, /re-stitched and its caption timings changed/)
  })

  test('sub-frame jitter is not reported as drift', () => {
    // A 10ms wobble is not something anybody should be asked to repair 124
    // images over.
    const jitter = cues(BASE.map(c => [c.start_sec + 0.01, c.end_sec + 0.01, c.text] as [number, number, string]))
    const drift = compareTimeline(stampFromCues(BASE), stampFromCues(jitter))
    // The hash differs, so it is honest about being a different timeline...
    assert.equal(drift.stale, true)
    // ...but it does not claim a shift worth acting on.
    assert.equal(drift.drift_sec, null)
  })

  test('an empty transcript is handled without throwing', () => {
    assert.doesNotThrow(() => compareTimeline(stampFromCues(BASE), stampFromCues([])))
    assert.equal(stampFromCues([]).total_cues, 0)
  })
})

describe('1.4.288 — a plan must reach the end of the current narration', () => {
  const scenes = [{ end_sec: 10 }, { end_sec: 521.5 }]
  test('a plan built from older, shorter narration is short by the difference (AF EP0136)', () => {
    assert.equal(Math.round(planNarrationShortfallSec(scenes, { duration_sec: 1505.6, lead_in_sec: 0 }) * 10) / 10, 984.1)
  })
  test('a plan that reaches the end, or one the renderer shifts by the music lead-in, is not short', () => {
    assert.equal(planNarrationShortfallSec(scenes, { duration_sec: 522, lead_in_sec: 0 }), 0.5)
    assert.equal(planNarrationShortfallSec(scenes, { duration_sec: 529.5, lead_in_sec: 8 }), 0)
  })
  test('nothing to compare against means nothing to report', () => {
    assert.equal(planNarrationShortfallSec(scenes, null), 0)
    assert.equal(planNarrationShortfallSec([], { duration_sec: 100 }), 0)
  })
})
