/**
 * Batch 386, item 11 — the caller wiring for the optional scene-type Sketch Draw mode.
 *
 * The library contract is pinned in `scene-sketch-mode.test.ts`. These tests pin that the places
 * which actually render and check a clip pass the scene's own type through: the freshness rule's
 * reveal and hold resolve exactly as the render did, the final check reads the same rules, and a
 * scene with no type (or the mode off) keeps the pre-mode answer byte-for-byte.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_SKETCH_REVEAL, resetSketchRevealPlanCache, type SketchRevealSetting,
} from '../lib/sketch-reveal.js'
import { revealTypeFor, sketchHoldFramesFor } from '../services/scene-media-checkpoint.js'
import { sketchSceneBlankStarts, type SketchScenePlanEntry } from '../services/final-check-expectation.js'

const rulesOn = (rules: Record<string, unknown>, enabled = true): SketchRevealSetting =>
  ({ ...DEFAULT_SKETCH_REVEAL, scene_types: { enabled, rules } } as SketchRevealSetting)

const CONTEXT = { slug: 'channel', episodeId: 'EP001', episodeDir: '/tmp/ep', revealScenes: ['s1', 's2'] }

describe('revealTypeFor reads the scene\'s own type', () => {
  test('a scene-type rule answers for its scene, and the episode style elsewhere', () => {
    resetSketchRevealPlanCache()
    const reveal = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } })
    assert.equal(revealTypeFor(reveal, CONTEXT, 's1', 'interior'), 'colour')
    assert.equal(revealTypeFor(reveal, CONTEXT, 's2', 'landscape'), 'line')
    assert.equal(revealTypeFor(reveal, CONTEXT, 's1'), 'line', 'no kind supplied: the pre-mode answer')
  })

  test('context.sceneKinds is the same answer for a caller that has the whole episode', () => {
    resetSketchRevealPlanCache()
    const reveal = rulesOn({ interior: { reveal: { style: 'bloom', mix: [] } } })
    const context = { ...CONTEXT, sceneKinds: { s1: 'interior', s2: undefined } }
    assert.equal(revealTypeFor(reveal, context, 's1'), 'bloom')
    assert.equal(revealTypeFor(reveal, context, 's2'), 'line')
  })

  test('a pin still wins over the scene-type rule', () => {
    resetSketchRevealPlanCache()
    const reveal: SketchRevealSetting = { ...rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } }), overrides: { s1: 'rough' } }
    assert.equal(revealTypeFor(reveal, CONTEXT, 's1', 'interior'), 'rough')
  })

  test('mode off keeps the old answer whatever kind is passed', () => {
    resetSketchRevealPlanCache()
    const reveal = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } }, false)
    assert.equal(revealTypeFor(reveal, CONTEXT, 's1', 'interior'), 'line')
  })
})

describe('sketchHoldFramesFor reads the scene-type hold rule', () => {
  const settings = { hold: { mode: 'auto' } as const, fps: 30, reveal: rulesOn({ interior: { hold: { mode: 'fixed', seconds: 2 } } }) }

  test('a type rule hold wins over the episode hold', () => {
    // 10 s at 30 fps = 300 frames; auto would be 75, the rule asks for 60.
    assert.equal(sketchHoldFramesFor(settings, 'EP001', 's1', 300, 'interior'), 60)
    assert.equal(sketchHoldFramesFor(settings, 'EP001', 's1', 300, 'landscape'), 75)
    assert.equal(sketchHoldFramesFor(settings, 'EP001', 's1', 300), 75)
  })

  test('a type rule hold still fits inside the scene', () => {
    const long = { ...settings, reveal: rulesOn({ interior: { hold: { mode: 'fixed', seconds: 30 } } }) }
    assert.equal(sketchHoldFramesFor(long, 'EP001', 's1', 120, 'interior'), 60, 'half of a 4 s scene')
  })

  test('mode off keeps the episode hold whatever kind is passed', () => {
    const off = { ...settings, reveal: rulesOn({ interior: { hold: { mode: 'fixed', seconds: 2 } } }, false) }
    assert.equal(sketchHoldFramesFor(off, 'EP001', 's1', 300, 'interior'), 75)
  })
})

describe('the final check reads the same scene-type rules as the render', () => {
  const scenes: SketchScenePlanEntry[] = [
    { id: 'scene-1', start_sec: 0, end_sec: 10, subject_kind: 'interior', clip_renderer: 'sketch_draw', clip_sketch: { fps: 30, frames: 300, hold_frames: 30 } },
    { id: 'scene-2', start_sec: 10, end_sec: 20, subject_kind: 'landscape', clip_renderer: 'sketch_draw', clip_sketch: { fps: 30, frames: 300, hold_frames: 30 } },
  ]

  test('a scene-type rule labels its own scene, and an unruled type falls through', () => {
    resetSketchRevealPlanCache()
    const reveal = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } })
    const starts = sketchSceneBlankStarts({ episode_id: 'EP001', scenes, reveal, speech_end_sec: 20 })
    assert.deepEqual(starts.map(start => [start.scene_id, start.reveal]), [['scene-1', 'colour'], ['scene-2', 'line']])
  })

  test('mode off and no kinds keep the pre-mode windows', () => {
    resetSketchRevealPlanCache()
    const reveal = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } }, false)
    const starts = sketchSceneBlankStarts({ episode_id: 'EP001', scenes, reveal, speech_end_sec: 20 })
    assert.deepEqual(starts.map(start => [start.scene_id, start.reveal]), [['scene-1', 'line'], ['scene-2', 'line']])
  })
})
