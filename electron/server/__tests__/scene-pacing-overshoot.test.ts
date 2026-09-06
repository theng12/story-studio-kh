import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  repairOverlongScenesDeterministically,
  splitScenesDeterministically,
  subdivideWindow,
} from '../services/scene-planner.js'
import type { SrtCue } from '../lib/subtitle-builder.js'

/**
 * v1.4.82 — scene-length overshoot, measured bit-for-bit against episode DK0055.
 *
 * The deterministic cue-aligned splitter used to push a cue onto the bucket and
 * THEN test `durSoFar >= targetSec`, closing the scene at the busting cue's END.
 * Every scene therefore came out at target PLUS a whole trailing cue, and the
 * `>= maxSec` clause could never fire, because `targetSec <= maxSec` always
 * tripped one cue earlier — it was unreachable dead code. `splitLongScene`
 * already had the correct idiom: cut BEFORE the cue that would exceed.
 *
 * These cases are the diagnosed simulation, ported. They are the measured basis
 * for the boundary policy in `splitScenesDeterministically`; changing that walk
 * without re-running them re-opens the overshoot.
 */

/** Contiguous fixed-length cues, the shape a normal narrated episode has. */
function evenCues(count: number, lengthSec: number, startAt = 0): SrtCue[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    start_sec: startAt + i * lengthSec,
    end_sec: startAt + (i + 1) * lengthSec,
    text: `cue ${i + 1}`,
  }))
}

const durationsOf = (scenes: Array<{ start_sec: number; end_sec: number }>): number[] =>
  scenes.map(s => Number((s.end_sec - s.start_sec).toFixed(4)))

describe('scene-length overshoot (v1.4.82)', () => {
  test('45–60 near-still pacing yields a sane 150-minute plan and keeps the truthful final-tail exception', () => {
    const cues = evenCues(3_750, 2.4)
    const scenes = splitScenesDeterministically({ cues, min_sec: 45, max_sec: 60, target_sec: 52.5 })
    const durations = durationsOf(scenes)

    assert.equal(scenes.length, 171, '9,000 seconds at the 52.5-second target is about 171 images')
    assert.deepEqual(durations.slice(0, -1), Array.from({ length: 170 }, () => 52.8))
    assert.equal(durations.at(-1), 24, 'an indivisible final tail remains short when two in-band scenes cannot fit')
    assert.deepEqual(durations.filter(duration => duration > 60.0001), [])
    assert.equal(scenes.at(-1)!.end_sec, 9_000)
  })

  test('DK0055 band 10–30: every scene lands inside the band, none past the cap', () => {
    // 2.4s cues is DK0055's measured cadence. The old walk closed at the first
    // boundary at or past target (21.6s); 19.2s is nearer to the 20s target, so
    // the corrected walk takes that boundary instead.
    const cues = evenCues(200, 2.4)
    const scenes = splitScenesDeterministically({ cues, min_sec: 10, max_sec: 30, target_sec: 20 })

    const durations = durationsOf(scenes)
    assert.ok(durations.length > 0, 'the splitter must produce scenes')
    assert.deepEqual(
      durations.filter(d => d > 30.0001),
      [],
      'no scene may exceed the configured maximum on contiguous cues',
    )
    assert.deepEqual(
      durations.filter(d => d < 10),
      [],
      'no scene may fall under the configured minimum',
    )
    assert.equal(
      Math.max(...durations), 19.2,
      'the boundary nearest the 20s target is 19.2s (8 cues), not the 21.6s the old walk took',
    )

    // The plan must still tile the timeline exactly — no gaps, no overlaps.
    for (let i = 1; i < scenes.length; i++) {
      assert.equal(scenes[i]!.start_sec, scenes[i - 1]!.end_sec, `scene ${i + 1} must abut its predecessor`)
    }
    assert.equal(scenes[0]!.start_sec, 0)
    assert.equal(scenes.at(-1)!.end_sec, cues.at(-1)!.end_sec)
  })

  test('the maximum clause now fires: a cue that would bust the cap is cut BEFORE, not after', () => {
    // 6s cues, band 5–10 (target 7.5). The old walk saw 6s < 7.5s, took the next
    // cue, measured 12s >= 7.5s and closed there — a 12s scene under a 10s cap,
    // with the `>= maxSec` clause never consulted. The corrected walk cuts at 6s.
    const cues = evenCues(12, 6)
    const scenes = splitScenesDeterministically({ cues, min_sec: 5, max_sec: 10, target_sec: 7.5 })

    assert.deepEqual(durationsOf(scenes), Array.from({ length: 12 }, () => 6))
    assert.deepEqual(
      durationsOf(scenes).filter(d => d > 10),
      [],
      'the over-maximum scenes the old walk produced here are gone',
    )
  })

  test('a scene exceeds the maximum only when the extra length is inter-cue silence', () => {
    // A chapter gap: five cues, 70s of dead air, five more. The scene spanning
    // the gap is long in wall-clock and NORMAL in spoken content — that is not a
    // pacing failure, so the cap is measured on the spoken span.
    const cues = [...evenCues(5, 4, 0), ...evenCues(5, 4, 90)]
    const scenes = splitScenesDeterministically({ cues, min_sec: 10, max_sec: 30, target_sec: 20 })

    const overCap = scenes.filter(s => s.end_sec - s.start_sec > 30.0001)
    assert.equal(overCap.length, 1, 'exactly one scene straddles the silence')
    const gapScene = overCap[0]!
    const firstCueInside = cues.find(c => c.end_sec > gapScene.start_sec + 0.0001)!
    const spokenSpan = gapScene.end_sec - Math.max(gapScene.start_sec, firstCueInside.start_sec)
    assert.ok(
      spokenSpan <= 30.0001,
      `the silence-straddling scene holds ${spokenSpan}s of narration, inside the 30s cap`,
    )

    // Every other scene obeys the cap on wall-clock too.
    for (const scene of scenes) {
      if (scene === gapScene) continue
      assert.ok(scene.end_sec - scene.start_sec <= 30.0001)
    }
  })

  test('the tail merge never trades a short scene for an over-cap one', () => {
    // 21 cues of 5s under a 10–24s band: the natural tail is a lone 5s runt, and
    // merging it backward would make a 25s scene — over the cap. The boundary is
    // rebalanced instead, so both halves stay in band.
    const cues = evenCues(21, 5)
    const scenes = splitScenesDeterministically({ cues, min_sec: 10, max_sec: 24, target_sec: 17 })

    for (const [i, d] of durationsOf(scenes).entries()) {
      assert.ok(d <= 24.0001, `scene ${i + 1} is ${d}s, over the 24s cap`)
      assert.ok(d >= 10, `scene ${i + 1} is ${d}s, under the 10s minimum`)
    }
    assert.equal(scenes.at(-1)!.end_sec, 105, 'the timeline is still fully covered')
  })

  test('subdivideWindow cuts before the busting cue too (the identical bug)', () => {
    // The planner-failure fallback had the same append-then-test shape: it pushed
    // a cue and flushed at that cue's END once `>= maxSec`, so every placeholder
    // chunk ran one whole cue past the cap.
    const cues = evenCues(10, 4)
    const chunks = subdivideWindow(cues, 0, 40, 10)

    assert.ok(chunks.length > 1, 'the window must actually be subdivided')
    for (const chunk of chunks) {
      assert.ok(
        chunk.end_sec - chunk.start_sec <= 10.0001,
        `chunk ${chunk.start_sec}–${chunk.end_sec} runs past the 10s maximum`,
      )
    }
    assert.equal(chunks[0]!.start_sec, 0)
    assert.equal(chunks.at(-1)!.end_sec, 40)
  })
})

describe('long-scene repair convergence (v1.4.82)', () => {
  test('repair converges: a second pass finds nothing left to do', () => {
    // Before the splitter fix the repair re-split with the SAME buggy walk, so it
    // could report "0 repaired" while the plan still held over-cap scenes.
    const cues = evenCues(20, 2.4)
    const scenes = [{
      id: 'scene-long',
      scene_index: 1,
      start_sec: 0,
      end_sec: 48,
      transcript_segment: 'one long hold',
      visual_prompt: 'an existing prompt',
      image_path: '/images/long.png',
    }]

    const first = repairOverlongScenesDeterministically({
      scenes, cues, threshold_sec: 20, min_sec: 10, max_sec: 20,
    })
    assert.equal(first.repairedCount, 1)
    assert.equal(first.unsplittableCount, 0)
    for (const scene of first.scenes) {
      assert.ok(scene.end_sec - scene.start_sec <= 20.0001, 'the repair must respect the cap it was given')
    }
    // The first part keeps the original id and its generated image.
    assert.equal(first.scenes[0]!.id, 'scene-long')
    assert.equal(first.scenes[0]!.image_path, '/images/long.png')

    const second = repairOverlongScenesDeterministically({
      scenes: first.scenes, cues, threshold_sec: 20, min_sec: 10, max_sec: 20,
    })
    assert.equal(second.repairedCount, 0, 'the repair converged — nothing left over the cap')
    assert.equal(second.unsplittableCount, 0, 'and nothing was left stuck either')
    assert.equal(second.scenes.length, first.scenes.length)
  })

  test('reports honestly when an over-cap scene cannot be split further', () => {
    // One indivisible cue, and a silent stretch with no cues at all. Neither can
    // be divided; answering "no scenes exceed the cap" sent people off to
    // re-stitch subtitles that were already correct.
    const result = repairOverlongScenesDeterministically({
      scenes: [
        {
          id: 'scene-one-cue', scene_index: 1, start_sec: 0, end_sec: 40,
          transcript_segment: 'Thunderclap', visual_prompt: 'a prompt',
        },
        {
          id: 'scene-silent', scene_index: 2, start_sec: 40, end_sec: 100,
          transcript_segment: '', visual_prompt: 'another prompt',
        },
      ],
      cues: [{ index: 1, start_sec: 0, end_sec: 40, text: 'Thunderclap' }],
      threshold_sec: 20,
      min_sec: 10,
      max_sec: 20,
    })

    assert.equal(result.repairedCount, 0)
    assert.equal(result.unsplittableCount, 2, 'both over-cap scenes are reported as unsplittable, not as absent')
    assert.equal(result.scenes.length, 2, 'and neither scene was disturbed')
  })

  test('reports nothing at all when no scene exceeds the cap', () => {
    const result = repairOverlongScenesDeterministically({
      scenes: [{
        id: 'scene-fine', scene_index: 1, start_sec: 0, end_sec: 12,
        transcript_segment: 'short enough', visual_prompt: 'a prompt',
      }],
      cues: evenCues(5, 2.4),
      threshold_sec: 20,
      min_sec: 10,
      max_sec: 20,
    })
    assert.equal(result.repairedCount, 0)
    assert.equal(result.unsplittableCount, 0, 'this is the case that earns the "nothing exceeds the cap" message')
  })
})
