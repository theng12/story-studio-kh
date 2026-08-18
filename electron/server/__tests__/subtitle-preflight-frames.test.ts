/**
 * v1.4.0 — three frames of the real video, with the real captions burned in.
 *
 * *"give 3 screenshot in different parts of the video as rendered with the video
 * so we can judge the subtitle is correct before we render the video"*.
 *
 * He found EP0048's captions on a finished EP0047 video by watching the render.
 * The whole value of this feature is that the frames are EVIDENCE — so the two
 * ways they could quietly stop being evidence are what these tests guard:
 *
 *   1. A frame with no caption on it. Sampling at exactly 15/50/85% of a video
 *      lands in a pause often enough to matter, and a blank frame proves
 *      nothing while looking exactly like a working feature.
 *   2. A frame drawn from a different code path than the burn. A preview that
 *      builds its own subtitle document can agree with itself perfectly and
 *      still misrepresent the video. `subtitle-engine.test.ts` has asserted
 *      preview/burn agreement since v1.1.0; the frame path is inside that same
 *      guarantee rather than beside it.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  choosePreflightTimestamps,
  sceneImageAt,
  PREFLIGHT_PERCENTS,
} from '../lib/subtitle-preflight-frames.js'
import type { SrtCue } from '../lib/subtitle-builder.js'

/**
 * A caption every 10s, 4s long, leaving a 6s silent gap between each.
 *
 * `offset` shifts every cue so the 15/50/85% marks fall in the GAPS. That is
 * deliberate: with cues starting on the 10s boundary, 15% of a 1000s episode is
 * 150s — already inside a caption — and the snapping would never be exercised.
 */
function cuesEvery10s(count: number, offset = 0): SrtCue[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    start_sec: i * 10 + offset,
    end_sec: i * 10 + 4 + offset,
    text: `Caption ${i + 1}`,
  }))
}

describe('choosing where to sample', () => {
  test('every sample lands inside a caption, never in a gap', () => {
    const cues = cuesEvery10s(100)   // 0–1000s, captions on 40% of the timeline
    const samples = choosePreflightTimestamps(cues, 1000)
    assert.equal(samples.length, 3)
    for (const s of samples) {
      const cue = cues.find(c => c.index === s.cue_index)!
      assert.ok(
        s.time_sec >= cue.start_sec && s.time_sec <= cue.end_sec,
        `sample at ${s.time_sec}s is outside its cue (${cue.start_sec}–${cue.end_sec}s)`,
      )
      // And not ON the boundary, where a fade can read as a rendering fault.
      assert.ok(s.time_sec > cue.start_sec, 'a sample must not sit on the cue start')
      assert.ok(s.time_sec < cue.end_sec, 'a sample must not sit on the cue end')
    }
  })

  test('the exact percentage points would have landed in silence', () => {
    // Proof the snapping is doing real work rather than being decoration:
    // with this offset, 15%/50%/85% of the timeline all fall in the 6s gaps.
    const cues = cuesEvery10s(100, 5)
    for (const pct of PREFLIGHT_PERCENTS) {
      const raw = 1000 * pct
      assert.ok(
        !cues.some(c => raw >= c.start_sec && raw <= c.end_sec),
        `${raw}s was already inside a caption; this fixture does not test the snap`,
      )
    }
    // Every sample nonetheless lands on a caption.
    for (const s of choosePreflightTimestamps(cues, 1000)) {
      assert.ok(
        cues.some(c => s.time_sec >= c.start_sec && s.time_sec <= c.end_sec),
        `sample at ${s.time_sec}s is not on a caption`,
      )
    }
  })

  test('the three frames are spread through the episode, in order', () => {
    const samples = choosePreflightTimestamps(cuesEvery10s(100), 1000)
    assert.deepEqual(samples.map(s => s.index), [1, 2, 3])
    assert.ok(samples[0]!.time_sec < samples[1]!.time_sec)
    assert.ok(samples[1]!.time_sec < samples[2]!.time_sec)
    // Roughly where they were aimed — near, not exactly, the target.
    assert.ok(Math.abs(samples[0]!.time_sec - 150) < 12)
    assert.ok(Math.abs(samples[1]!.time_sec - 500) < 12)
    assert.ok(Math.abs(samples[2]!.time_sec - 850) < 12)
  })

  test('three frames never show the same caption three times', () => {
    // A very short episode: all three targets crowd onto the same few cues.
    // Printing one piece of evidence three times is not three pieces.
    const samples = choosePreflightTimestamps(cuesEvery10s(3), 30)
    assert.equal(samples.length, 3)
    assert.equal(new Set(samples.map(s => s.cue_index)).size, 3)
  })

  test('a single caption yields one frame rather than three copies of it', () => {
    const samples = choosePreflightTimestamps(cuesEvery10s(1), 10)
    assert.equal(new Set(samples.map(s => s.cue_index)).size, 1)
  })

  test('an episode with no cues produces no frames and does not throw', () => {
    assert.deepEqual(choosePreflightTimestamps([], 1000), [])
  })

  test('a nonsense duration falls back to the captions\' own span', () => {
    // A frame is only useful if it is a real moment of the episode. Rather than
    // put all three at t=0, an unusable duration defers to what there is.
    const cues = cuesEvery10s(20)
    for (const bad of [0, -5, NaN, Infinity]) {
      const samples = choosePreflightTimestamps(cues, bad as number)
      assert.equal(samples.length, 3)
      assert.equal(new Set(samples.map(s => s.cue_index)).size, 3)
      for (const s of samples) assert.ok(s.time_sec > 0)
    }
  })

  test('cues arriving out of order are still sampled in timeline order', () => {
    const shuffled = [...cuesEvery10s(30)].reverse()
    const samples = choosePreflightTimestamps(shuffled, 300)
    assert.ok(samples[0]!.time_sec < samples[2]!.time_sec)
  })

  test('each sample carries the caption text it is proving', () => {
    // The panel prints this beside the image. Without it, three near-identical
    // stills of the same scene are impossible to tell apart.
    for (const s of choosePreflightTimestamps(cuesEvery10s(50), 500)) {
      assert.match(s.cue_text, /^Caption \d+$/)
    }
  })
})

describe('which picture is behind the caption', () => {
  const scenes = [
    { image_path: '/s1.png', duration: 10 },
    { image_path: '/s2.png', duration: 10 },
    { image_path: '/s3.png', duration: 10 },
  ]

  test('the scene timeline starts after the branded opening', () => {
    // Scenes begin at the reserved opening, while captions answer to the
    // narration, which plays from t=0. Conflating the two is exactly the
    // mistake `video.ts` documents at the burn step.
    assert.equal(sceneImageAt(scenes, 12, 10)?.image_path, '/s1.png')
    assert.equal(sceneImageAt(scenes, 22, 10)?.image_path, '/s2.png')
    assert.equal(sceneImageAt(scenes, 32, 10)?.image_path, '/s3.png')
  })

  test('with no opening, scenes start immediately', () => {
    assert.equal(sceneImageAt(scenes, 0, 0)?.image_path, '/s1.png')
    assert.equal(sceneImageAt(scenes, 15, 0)?.image_path, '/s2.png')
  })

  test('a frame inside the opening has no scene, and says so', () => {
    // Black is the honest backdrop there. Reaching for scene 1 would show a
    // picture that is not on screen at that moment.
    assert.equal(sceneImageAt(scenes, 4, 10), null)
  })

  test('a frame past the last scene holds on the last scene', () => {
    const past = sceneImageAt(scenes, 999, 10)
    assert.equal(past?.image_path, '/s3.png')
    assert.equal(past?.scene_number, 3)
  })

  test('an episode with no scenes yields no picture rather than throwing', () => {
    assert.equal(sceneImageAt([], 12, 10), null)
  })

  test('scene numbers are 1-based, matching what Scene Plan shows', () => {
    assert.equal(sceneImageAt(scenes, 12, 10)?.scene_number, 1)
    assert.equal(sceneImageAt(scenes, 25, 10)?.scene_number, 2)
  })
})
