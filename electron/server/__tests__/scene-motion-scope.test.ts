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

// ── Video share (owner, 2026-10-26): a share of RUNNING TIME, filled by a formula ──────────────
test('share scope clamps to 10-100% and defaults its formula', () => {
  assert.deepEqual(normalizeMotionScope({ mode: 'share' }), { mode: 'share', share_percent: 25, formula: 'opening_hook' })
  assert.deepEqual(normalizeMotionScope({ mode: 'share', share_percent: 3 }), { mode: 'share', share_percent: 10, formula: 'opening_hook' })
  assert.deepEqual(normalizeMotionScope({ mode: 'share', share_percent: 400, formula: 'spread' }), { mode: 'share', share_percent: 100, formula: 'spread' })
  assert.deepEqual(normalizeMotionScope({ mode: 'share', share_percent: 50, formula: 'bogus' }), { mode: 'share', share_percent: 50, formula: 'opening_hook' })
})

test('opening_hook fills the target from the start and names the crossing scene', () => {
  // 24s total; 50% = 12s → a (8s) plus b (8s) crosses the target.
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'share', share_percent: 50, formula: 'opening_hook' }), { scene_ids: ['a'], crossing_scene_ids: ['b'] })
  // 100% = every second → every scene.
  assert.deepEqual(resolveMotionScope(scenes, { mode: 'share', share_percent: 100 }).scene_ids, ['a', 'b', 'c'])
})

test('key_moments picks flagged scenes first, then tops the budget up from the start', () => {
  const flagged = [
    { id: 'a', start_sec: 0, end_sec: 8, key_moment: false },
    { id: 'b', start_sec: 8, end_sec: 16, key_moment: true },
    { id: 'c', start_sec: 16, end_sec: 24, key_moment: false },
  ]
  // 33% of 24s = 8s → only the key moment is needed, and it is the one selected.
  assert.deepEqual(resolveMotionScope(flagged, { mode: 'share', share_percent: 33, formula: 'key_moments' }).scene_ids, ['b'])
  // 100% → every scene, still in plan order.
  assert.deepEqual(resolveMotionScope(flagged, { mode: 'share', share_percent: 100, formula: 'key_moments' }).scene_ids, ['a', 'b', 'c'])
})

test('spread samples the episode instead of clustering at the start', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, start_sec: i * 6, end_sec: (i + 1) * 6 }))
  const picked = resolveMotionScope(many, { mode: 'share', share_percent: 30, formula: 'spread' }).scene_ids
  assert.equal(picked.length, 3)
  assert.ok(!picked.every(id => ['s0', 's1', 's2'].includes(id)), 'spread must not be the first three')
  assert.equal(picked[0], 's0')
})

test('an empty plan produces no share selection rather than an error', () => {
  assert.deepEqual(resolveMotionScope([], { mode: 'share', share_percent: 50 }), { scene_ids: [], crossing_scene_ids: [] })
})
