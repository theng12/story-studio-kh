import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeMotionScope, resolveMotionScope } from '../contracts/motion-scope.js'

const scenes = [
  { id: 'a', start_sec: 0, end_sec: 8 },
  { id: 'b', start_sec: 8, end_sec: 16 },
  { id: 'c', start_sec: 16, end_sec: 24 },
]

test('missing/off scope never includes scenes; all preserves plan order', () => {
  assert.deepEqual(normalizeMotionScope(undefined), { mode: 'off' })
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'off' }), { scene_ids: [], crossing_scene_ids: [] })
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'all' }).scene_ids, ['a', 'b', 'c'])
})

test('opening includes complete scenes only and explicitly reports a crossing scene', () => {
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'opening', end_sec: 16 }), { scene_ids: ['a', 'b'], crossing_scene_ids: [] })
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'opening', end_sec: 12 }), { scene_ids: ['a'], crossing_scene_ids: ['b'] })
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'opening', end_sec: 100 }).scene_ids, ['a', 'b', 'c'])
})

test('selected scope uses stable IDs and does not broaden after a scene disappears', () => {
  const selected = { mode: 'selected', scene_ids: ['c', 'a', 'c'] }
  assert.deepEqual(resolveMotionScope(scenes, selected).scene_ids, ['a', 'c'])
  assert.throws(() => resolveMotionScope(scenes.slice(0, 2), selected), /c.*no longer|no longer.*c/)
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'selected', scene_ids: [] }).scene_ids, [])
})

test('malformed scope cannot silently become all or off', () => {
  for (const invalid of [
    { mode: 'unknown' }, { mode: 'opening', end_sec: 0 },
    { mode: 'opening', end_sec: Infinity }, { mode: 'opening', end_sec: '12' },
    { mode: 'selected' }, { mode: 'selected', scene_ids: [''] },
  ]) assert.throws(() => normalizeMotionScope(invalid), /motion|Motion/)
})

test('invalid or duplicate scene timing cannot be used to decide paid scope', () => {
  assert.throws(() => resolveMotionScope([{ id: 'bad', start_sec: 8, end_sec: 4 }], { mode: 'opening', end_sec: 12 }), /timing/)
  assert.throws(() => resolveMotionScope([...scenes, scenes[0]!], { mode: 'all' }), /duplicate/i)
})
