import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  removeNonRenderableScenes,
  repairOverlongScenesDeterministically,
  repairPlanCoverageWithSubtitleCues,
} from '../services/scene-planner.js'
import type { ScenePlanEntry } from '../models/types.js'
import type { ScenePacing } from '../contracts/pacing.js'

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

  test('uses each saved pacing period at the scene start and leaves legacy repair thresholds unchanged', () => {
    const scenes: ScenePlanEntry[] = [
      { id: 'opening', scene_index: 1, start_sec: 0, end_sec: 9, transcript_segment: 'Opening', visual_prompt: 'Keep opening', image_path: '/images/opening.png', approved: true },
      { id: 'settled', scene_index: 2, start_sec: 20, end_sec: 35, transcript_segment: 'Settled', visual_prompt: 'Keep settled', image_path: '/images/settled.png', approved: true },
    ]
    const cues = [
      { index: 1, start_sec: 0, end_sec: 3, text: 'One' },
      { index: 2, start_sec: 3, end_sec: 6, text: 'Two' },
      { index: 3, start_sec: 6, end_sec: 9, text: 'Three' },
      { index: 4, start_sec: 20, end_sec: 25, text: 'Four' },
      { index: 5, start_sec: 25, end_sec: 30, text: 'Five' },
      { index: 6, start_sec: 30, end_sec: 35, text: 'Six' },
    ]
    const savedPacing: ScenePacing = {
      mode: 'variable', min_sec: 3, max_sec: 3,
      periods: [
        { start_sec: 0, end_sec: 10, min_sec: 3, max_sec: 3 },
        { start_sec: 10, end_sec: null, min_sec: 10, max_sec: 15 },
      ],
    }

    const legacy = repairOverlongScenesDeterministically({
      scenes, cues, threshold_sec: 20, min_sec: 3, max_sec: 12,
    })
    const repaired = repairOverlongScenesDeterministically({
      scenes, cues, threshold_sec: 20, min_sec: 3, max_sec: 12, pacing: savedPacing,
    })

    assert.equal(legacy.repairedCount, 0, 'plans without a pacing snapshot keep the old threshold behavior')
    assert.deepEqual(repaired.repairedIds, ['opening'])
    assert.deepEqual(repaired.scenes.map(scene => [scene.start_sec, scene.end_sec]), [
      [0, 3], [3, 6], [6, 9], [20, 35],
    ])
    assert.equal(repaired.scenes[0]?.id, 'opening')
    assert.match(repaired.scenes[1]?.id || '', /^scene_/)
    assert.match(repaired.scenes[2]?.id || '', /^scene_/)
    assert.equal(repaired.scenes.at(-1)?.image_path, '/images/settled.png')
  })

  test('coverage repair restores a skipped narrated chapter instead of creating one frozen hold', () => {
    const scenes: ScenePlanEntry[] = [
      {
        id: 'before', scene_index: 1, start_sec: 0, end_sec: 8,
        transcript_segment: 'Before', visual_prompt: 'Existing prompt',
        image_path: '/images/before.png', approved: true,
      },
      {
        id: 'after', scene_index: 2, start_sec: 48, end_sec: 56,
        transcript_segment: 'After', visual_prompt: 'After prompt',
        image_path: '/images/after.png', approved: true,
      },
    ]
    const cues = [
      { index: 1, start_sec: 0, end_sec: 8, text: 'Before' },
      { index: 2, start_sec: 8, end_sec: 16, text: 'Restored one' },
      { index: 3, start_sec: 16, end_sec: 24, text: 'Restored two' },
      { index: 4, start_sec: 24, end_sec: 32, text: 'Restored three' },
      { index: 5, start_sec: 32, end_sec: 40, text: 'Restored four' },
      { index: 6, start_sec: 40, end_sec: 48, text: 'Restored five' },
      { index: 7, start_sec: 48, end_sec: 56, text: 'After' },
    ]

    const result = repairPlanCoverageWithSubtitleCues({
      scenes,
      cues,
      audioDurationSec: 56,
      threshold_sec: 20,
      min_sec: 3,
      max_sec: 10,
    })

    assert.equal(result.coverageBefore.internalGapTotalSec, 40)
    assert.equal(result.coverageAfter.uncoveredTotalSec, 0)
    assert.equal(result.repairedLongSceneCount, 1)
    assert.equal(result.addedSceneCount, 5)
    assert.ok(result.scenes.every(scene => scene.end_sec - scene.start_sec <= 10))
    assert.equal(result.scenes[0]?.id, 'before')
    assert.equal(result.scenes[0]?.image_path, '/images/before.png')
    assert.equal(result.scenes.at(-1)?.id, 'after')
    assert.equal(result.scenes.at(-1)?.image_path, '/images/after.png')
    for (const restored of result.scenes.slice(1, -1)) {
      assert.equal(restored.visual_prompt, '')
      assert.equal(restored.image_path, undefined)
      assert.equal(restored.approved, false)
    }
    assert.ok(result.changes.some(change => /cue-aligned scene/.test(change)))
  })

  test('removes zero-duration repair artifacts and keeps their narration with the next real scene', () => {
    const result = removeNonRenderableScenes([
      {
        id: 'before', scene_index: 1, start_sec: 0, end_sec: 5,
        transcript_segment: 'Before', visual_prompt: 'Before prompt',
      },
      {
        id: 'zero-artifact', scene_index: 2, start_sec: 5, end_sec: 5,
        transcript_segment: 'A missing beat', visual_prompt: 'Unrenderable prompt',
        boundary_reason: 'deterministic repair (restored subtitle cues)',
      },
      {
        id: 'after', scene_index: 3, start_sec: 5, end_sec: 10,
        transcript_segment: 'After', visual_prompt: '',
      },
    ])

    assert.deepEqual(result.removed_ids, ['zero-artifact'])
    assert.deepEqual(result.removed_prompt_ids, ['zero-artifact'])
    assert.deepEqual(result.scenes.map(scene => scene.id), ['before', 'after'])
    assert.equal(result.scenes[1]?.transcript_segment, 'A missing beat After')
    assert.ok(result.scenes.every(scene => scene.end_sec > scene.start_sec))
    assert.deepEqual(result.scenes.map(scene => scene.scene_index), [1, 2])
  })
})

// ── Held opening survives the long-scene split (DK0032) ──────────────────
// Holding scene 1 over an unplanned Introduction deliberately creates one very
// long scene. The long-scene repair that runs immediately after would shred it
// back into cue-aligned scenes with no images — silently undoing the choice and
// re-blocking the render on the images it just created. It must not.
describe('cue-aware coverage repair: held opening', () => {
  const introSkipped: ScenePlanEntry[] = [
    {
      id: 'scene-a', scene_index: 1, start_sec: 240, end_sec: 250,
      transcript_segment: 'Chapter one opens', visual_prompt: 'A prompt',
      image_path: '/images/a.png', approved: true,
    },
    {
      id: 'scene-b', scene_index: 2, start_sec: 250, end_sec: 260,
      transcript_segment: 'And continues', visual_prompt: 'Another prompt',
      image_path: '/images/b.png', approved: true,
    },
  ]
  // Cues exist across the whole 260s, opening included — so the splitter has
  // everything it needs to shred the held scene if it is not exempted.
  const cues = Array.from({ length: 26 }, (_, i) => ({
    index: i + 1, start_sec: i * 10, end_sec: (i + 1) * 10, text: `Cue ${i + 1}`,
  }))

  test('hold_head_scene covers the opening without inventing imageless scenes', () => {
    const result = repairPlanCoverageWithSubtitleCues({
      scenes: introSkipped,
      cues,
      audioDurationSec: 260,
      threshold_sec: 20,
      min_sec: 3,
      max_sec: 10,
      hold_head_scene: true,
    })

    assert.equal(result.coverageAfter.headGapSec, 0, 'the opening is covered')
    assert.equal(result.coverageAfter.uncoveredTotalSec, 0)
    assert.equal(result.addedSceneCount, 0, 'no new scenes, so no new images are owed')
    assert.deepEqual(result.scenes.map(s => s.id), ['scene-a', 'scene-b'])
    assert.equal(result.scenes[0]!.start_sec, 0)
    assert.equal(result.scenes[0]!.image_path, '/images/a.png', 'the held scene keeps its image')
    assert.equal(result.scenes[0]!.approved, true, 'and its approval')
  })

  test('without the opt-in the opening is left alone and reported', () => {
    const result = repairPlanCoverageWithSubtitleCues({
      scenes: introSkipped,
      cues,
      audioDurationSec: 260,
      threshold_sec: 20,
      min_sec: 3,
      max_sec: 10,
    })

    assert.equal(result.coverageAfter.headGapSec, 240, 'still uncovered — this is the caller\'s call')
    assert.equal(result.scenes[0]!.start_sec, 240)
  })
})
