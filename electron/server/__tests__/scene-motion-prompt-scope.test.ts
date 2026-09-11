import { test } from 'node:test'
import assert from 'node:assert/strict'
import { motionPromptSceneIds, motionSceneIdsForNewRequest } from '../services/scene-motion-prompt-scope.js'
const scenes = [
  { id: 'a', start_sec: 0, end_sec: 5, visual_prompt: 'A' },
  { id: 'b', start_sec: 5, end_sec: 10, visual_prompt: 'B', motion_prompt: 'Already saved' },
  { id: 'c', start_sec: 10, end_sec: 15, visual_prompt: 'C' },
  { id: 'd', start_sec: 15, end_sec: 20, visual_prompt: 'D', motion_choice: 'still' as const },
]
test('new motion prompt batches use explicit scope and exclude completed or deliberate still scenes', () => {
  assert.deepEqual(motionPromptSceneIds(scenes, { mode: 'opening', end_sec: 12 }), ['a'])
  assert.deepEqual(motionPromptSceneIds(scenes, { mode: 'all' }), ['a', 'c'])
  assert.deepEqual(motionPromptSceneIds(scenes, { mode: 'off' }), [])
  assert.deepEqual(motionPromptSceneIds(scenes, { mode: 'all' }, undefined, 1), ['a'])
})
test('saved request selection survives scope edits and retries never fill the next unrequested scene', () => {
  assert.deepEqual(motionPromptSceneIds(scenes, { mode: 'off' }, ['c']), ['c'])
  assert.deepEqual(motionPromptSceneIds([{ ...scenes[2]!, motion_choice: 'still' }], { mode: 'all' }, ['c']), [])
  assert.deepEqual(motionPromptSceneIds(scenes, { mode: 'all' }, ['b']), [])
  assert.deepEqual(motionPromptSceneIds(scenes, { mode: 'all' }, []), [])
  assert.throws(() => motionPromptSceneIds(scenes, { mode: 'all' }, ['removed']), /removed/)
})
test('legacy formula still hints do not override deliberate episode scope', () => {
  assert.deepEqual(motionPromptSceneIds([{ ...scenes[0]!, motion_mode: 'still' }], { mode: 'all' }), ['a'])
})
test('new scope snapshots exclude deliberate still choices without changing resolved order', () => {
  assert.deepEqual(motionSceneIdsForNewRequest(scenes, ['d', 'c', 'a']), ['c', 'a'])
})
