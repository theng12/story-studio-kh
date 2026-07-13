import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { repairOverlongScenesDeterministically } from '../services/scene-planner.js'
import type { ScenePlanEntry } from '../models/types.js'

describe('deterministic long-scene repair', () => {
  test('splits only the long range and preserves unaffected scene assets', () => {
    const scenes: ScenePlanEntry[] = [
      {
        id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8,
        transcript_segment: 'Before', visual_prompt: 'Before prompt',
        image_path: '/images/a.png', approved: true,
      },
      {
        id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 48,
        transcript_segment: 'Old partial transcript', visual_prompt: 'Existing first prompt',
        image_path: '/images/b.png', approved: true,
      },
      {
        id: 'scene-c', scene_index: 3, start_sec: 48, end_sec: 56,
        transcript_segment: 'After', visual_prompt: 'After prompt',
        image_path: '/images/c.png', approved: true,
      },
    ]
    const cues = [
      { index: 1, start_sec: 8, end_sec: 16, text: 'Restored cue one' },
      { index: 2, start_sec: 16, end_sec: 24, text: 'Restored cue two' },
      { index: 3, start_sec: 24, end_sec: 32, text: 'Restored cue three' },
      { index: 4, start_sec: 32, end_sec: 40, text: 'Restored cue four' },
      { index: 5, start_sec: 40, end_sec: 48, text: 'Restored cue five' },
    ]

    const result = repairOverlongScenesDeterministically({
      scenes,
      cues,
      threshold_sec: 20,
      min_sec: 3,
      max_sec: 10,
    })

    assert.equal(result.repairedCount, 1)
    assert.equal(result.addedCount, 4)
    assert.deepEqual(result.repairedIds, ['scene-b'])
    assert.equal(result.scenes.length, 7)
    assert.deepEqual(result.scenes[0], scenes[0])
    assert.deepEqual(result.scenes.at(-1), { ...scenes[2], scene_index: 7 })

    const repaired = result.scenes.slice(1, -1)
    assert.equal(repaired[0]?.id, 'scene-b')
    assert.equal(repaired[0]?.visual_prompt, 'Existing first prompt')
    assert.equal(repaired[0]?.image_path, '/images/b.png')
    assert.equal(repaired[0]?.approved, true)
    for (const child of repaired.slice(1)) {
      assert.equal(child.visual_prompt, '')
      assert.equal(child.image_path, undefined)
      assert.equal(child.approved, false)
      assert.match(child.boundary_reason || '', /deterministic repair/)
    }
    assert.deepEqual(repaired.map(scene => [scene.start_sec, scene.end_sec]), [
      [8, 16], [16, 24], [24, 32], [32, 40], [40, 48],
    ])
  })

  test('does not invent splits when restored cues are still absent', () => {
    const scene: ScenePlanEntry = {
      id: 'scene-gap', scene_index: 1, start_sec: 0, end_sec: 120,
      transcript_segment: 'Only one cue exists', visual_prompt: 'Keep me',
    }
    const result = repairOverlongScenesDeterministically({
      scenes: [scene],
      cues: [{ index: 1, start_sec: 0, end_sec: 5, text: 'Only one cue exists' }],
    })
    assert.equal(result.repairedCount, 0)
    assert.deepEqual(result.scenes, [scene])
  })
})
