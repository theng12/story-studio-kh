import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertScenePromptsRenderable,
  clearLegacyPlannerFallbackReasons,
  inspectScenePromptIntegrity,
} from '../services/scene-prompt-integrity.js'

test('later normalized prompt copies are pending while the first stays valid', () => {
  const integrity = inspectScenePromptIntegrity([
    { id: 'one', visual_prompt: 'Moonlit forest with an old bridge.' },
    { id: 'two', visual_prompt: '  moonlit  FOREST with an old bridge.  ' },
    { id: 'three', visual_prompt: '' },
  ])

  assert.deepEqual(integrity.empty_ids, ['three'])
  assert.deepEqual(integrity.duplicate_ids, ['two'])
  assert.deepEqual(integrity.invalid_ids, ['three', 'two'])
  assert.equal(integrity.complete, false)
})

test('render validation can be scoped to selected scene ids', () => {
  const scenes = [
    { id: 'one', visual_prompt: 'Unique one' },
    { id: 'two', visual_prompt: 'Unique one' },
    { id: 'three', visual_prompt: 'Unique three' },
  ]

  assert.doesNotThrow(() => assertScenePromptsRenderable(scenes, ['one', 'three']))
  assert.throws(
    () => assertScenePromptsRenderable(scenes, ['two']),
    /1 duplicated.*All pending/,
  )
})

test('legacy planner labels are removed without touching current reasons', () => {
  const scenes = [
    { boundary_reason: 'auto-split (planner failed here)' },
    { boundary_reason: 'auto-filled placeholder' },
    { boundary_reason: 'deterministic split (cue-aligned)' },
  ]

  assert.equal(clearLegacyPlannerFallbackReasons(scenes), 2)
  assert.deepEqual(scenes, [{}, {}, { boundary_reason: 'deterministic split (cue-aligned)' }])
})
