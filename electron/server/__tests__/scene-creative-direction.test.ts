import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  assignCreativeStrategies,
  buildCreativeDirectionPrompt,
  normalizeCreativeDirection,
} from '../services/scene-creative-direction.js'
import type { ScenePlanEntry } from '../models/types.js'

function makeScenes(count: number): ScenePlanEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `scene-${index + 1}`,
    scene_index: index + 1,
    start_sec: index * 6,
    end_sec: (index + 1) * 6,
    transcript_segment: [
      'A person feels the pressure of a difficult choice.',
      'A quiet path leads through rain at dawn.',
      'The system promises success but erodes trust.',
      'A small object becomes a symbol of hope.',
    ][index % 4]!,
    visual_prompt: '',
  }))
}

describe('scene creative direction', () => {
  test('uses the compatibility-safe narrative default for missing settings', () => {
    const direction = normalizeCreativeDirection()
    assert.equal(direction.profile, 'narrative')
    assert.equal(direction.intensity, 2)
    assert.deepEqual(direction.strategies, [
      'literal-narrative',
      'editorial-metaphor',
      'symbolic',
      'poetic-environment',
    ])
  })

  test('assigns stable and varied strategies without an extra model call', () => {
    const first = makeScenes(16)
    const second = makeScenes(16)
    assignCreativeStrategies(first, { profile: 'editorial', intensity: 3 }, 'project:EP001')
    assignCreativeStrategies(second, { profile: 'editorial', intensity: 3 }, 'project:EP001')

    assert.deepEqual(
      first.map(scene => scene.creative_strategy),
      second.map(scene => scene.creative_strategy),
      'same episode seed should make retries deterministic',
    )
    assert.ok(
      new Set(first.map(scene => scene.creative_strategy)).size >= 3,
      'editorial direction should spread its visual strategies across an episode',
    )
    for (let index = 1; index < first.length; index++) {
      assert.notEqual(first[index]?.creative_strategy, first[index - 1]?.creative_strategy, 'adjacent scenes should not repeat a strategy')
    }
  })

  test('keeps an existing valid strategy during prompt-only repair', () => {
    const scenes = makeScenes(2)
    scenes[0]!.creative_strategy = 'symbolic'
    assignCreativeStrategies(scenes, { profile: 'editorial', intensity: 2 }, 'project:EP001', true)
    assert.equal(scenes[0]?.creative_strategy, 'symbolic')
    assert.ok(scenes[1]?.creative_strategy)
  })

  test('passes profile intent, motifs, and cliche avoidance into the existing prompt call', () => {
    const prompt = buildCreativeDirectionPrompt({
      profile: 'spiritual',
      intensity: 3,
      recurring_motifs: 'lanterns and open windows',
      avoid_cliches: 'floating text and stock prayer poses',
    })
    assert.match(prompt, /Spiritual, intensity 3\/4/)
    assert.match(prompt, /lanterns and open windows/)
    assert.match(prompt, /stock prayer poses/)
    assert.match(prompt, /Do not merely turn every mentioned noun into a literal inventory/)
  })
})
