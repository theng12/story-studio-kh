/**
 * The blank start of a Sketch Draw scene, and the black that is NOT it.
 *
 * Owner-confirmed on MineePod EP0029 (2026-11-06): 45 black stretches were the clean canvas starts
 * of its Sketch Draw scenes, not render faults. The check may skip a dark stretch only when the
 * episode's own scene timing places a Sketch Draw scene there and the clip's own receipt says how
 * long its reveal ran. Black anywhere else — mid-scene, between scenes, or past that window — is
 * still reported, and an episode with no such scenes is judged exactly as before.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  finalCheckIssues,
  type FinalCheckExpectation,
  type FinalCheckResult,
  type FinalCheckSceneBlankStart,
} from '../lib/final-video-check.js'
import { sketchSceneBlankStarts, type SketchScenePlanEntry } from '../services/final-check-expectation.js'

type Black = { start_sec: number; end_sec: number }

function actual(black: Black[]): FinalCheckResult['actual'] {
  return {
    duration_sec: 30, video_sec: 30, audio_sec: 30, width: 0, height: 0,
    tail_lufs: null, black, silence: [],
  }
}

function expected(over: Partial<FinalCheckExpectation> = {}): FinalCheckExpectation {
  return {
    planned_sec: 0,
    tail: { sec: 0, from_end_sec: 0 },
    closing_music: false,
    width: 0,
    height: 0,
    subtitles_path: null,
    ...over,
  }
}

function blackIssues(black: Black[], windows?: FinalCheckSceneBlankStart[]) {
  return finalCheckIssues(actual(black), expected(windows ? { scene_blank_starts: windows } : {}))
    .filter(issue => issue.check === 'black')
}

const SCENE_2: FinalCheckSceneBlankStart = { scene_id: 'scene-2', start_sec: 10, end_sec: 14 }

describe('a Sketch Draw scene\'s expected blank start', () => {
  test('black that begins at the scene and ends inside its reveal window is the canvas', () => {
    assert.deepEqual(blackIssues([{ start_sec: 10, end_sec: 13 }], [SCENE_2]), [])
  })

  test('black that begins mid-scene is still a fault', () => {
    const issues = blackIssues([{ start_sec: 16, end_sec: 18.5 }], [SCENE_2])
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.verdict, /black stretch at 0:16, outside the closing tail/)
  })

  test('black that runs past the reveal window reports only the excess as unexpected', () => {
    const issues = blackIssues([{ start_sec: 10, end_sec: 20 }], [SCENE_2])
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.verdict, /runs past the 4\.0s clean Sketch Draw reveal at scene-2's start/)
    assert.match(issues[0]!.verdict, /ending 0:14/)
  })

  test('a non-Sketch episode is judged exactly as before', () => {
    const issues = blackIssues([{ start_sec: 10, end_sec: 13 }])
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.verdict, /outside the closing tail/)
  })
})

describe('the blank windows from the episode\'s actual scene timing', () => {
  const scenes: SketchScenePlanEntry[] = [
    { id: 'scene-1', start_sec: 0, end_sec: 10 },
    // 300 frames at 30 fps, half of them closing hold → a 5 s reveal window.
    { id: 'scene-2', start_sec: 10, end_sec: 20, clip_renderer: 'sketch_draw', clip_sketch: { fps: 30, frames: 300, hold_frames: 150 } },
    // No recorded hold (helper v2): nothing is invented for it.
    { id: 'scene-3', start_sec: 20, end_sec: 30, clip_renderer: 'sketch_draw', clip_sketch: { fps: 30, frames: 300 } },
  ]

  test('each scene is placed by counting back from the recorded speech end', () => {
    assert.deepEqual(sketchSceneBlankStarts({
      episode_id: 'EP0029', scenes, reveal: null, speech_end_sec: 30,
    }), [{ scene_id: 'scene-2', start_sec: 10, end_sec: 15 }])
  })

  test('an opening before the first scene cancels out', () => {
    assert.deepEqual(sketchSceneBlankStarts({
      episode_id: 'EP0029', scenes, reveal: null, speech_end_sec: 100,
    }), [{ scene_id: 'scene-2', start_sec: 80, end_sec: 85 }])
  })

  test('the reveal type comes from the clip receipt, or from the Mix over the ordered scenes', () => {
    const receipt = sketchSceneBlankStarts({ episode_id: 'EP0029', scenes, reveal: null, speech_end_sec: 30 })
    assert.equal(receipt[0]!.reveal, undefined, 'no receipt type and no setting: no label is invented')

    const mixed = sketchSceneBlankStarts({
      episode_id: 'EP0029', scenes, reveal: { style: 'mix', mix: ['line', 'bloom'] }, speech_end_sec: 30,
    })
    assert.ok(mixed[0]!.reveal === 'line' || mixed[0]!.reveal === 'bloom', `resolved ${mixed[0]!.reveal}`)
  })

  test('a scene the plan kept as a still gets no blank window', () => {
    const keptStill = scenes.map(scene => scene.id === 'scene-2' ? { ...scene, motion_choice: 'still' } : scene)
    assert.deepEqual(sketchSceneBlankStarts({
      episode_id: 'EP0029', scenes: keptStill, reveal: null, speech_end_sec: 30,
    }), [])
  })

  test('no recorded speech end means no window at all', () => {
    assert.deepEqual(sketchSceneBlankStarts({
      episode_id: 'EP0029', scenes, reveal: null, speech_end_sec: 0,
    }), [])
  })
})
