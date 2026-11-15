/**
 * Scene worlds are editable in the UI, so the save must MERGE (1.4.403, owner rule 2026-11-15:
 * every list is practical and editable). Patching one world must never wipe the rest — the
 * regression this file exists for.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { MusicFormatPatchSchema, mergeMusicWorlds } from '../contracts/song-formula.js'

const world = (id: string, name: string) => ({
  id, name, register: 'Noir', sight: `${name} at night`,
  scenes: [`${name} scene`], music: [`${name} music`],
})

const CURRENT = [world('a', 'Rain alley'), world('b', 'Empty ballroom'), world('c', 'Harbour fog')]

test('patching one world keeps every other world exactly as it was', () => {
  const merged = mergeMusicWorlds(CURRENT, [{ id: 'a', sight: 'A wet alley under one lamp' }])
  assert.equal(merged.length, 3)
  assert.equal(merged[0]!.sight, 'A wet alley under one lamp')
  assert.equal(merged[0]!.name, 'Rain alley', 'unmentioned fields of the edited world survive')
  assert.deepEqual(merged.slice(1), CURRENT.slice(1), 'the other worlds are untouched')
})

test('adding a world appends it with an id derived from its name', () => {
  const merged = mergeMusicWorlds(CURRENT, [{ name: 'Smoke lounge', register: 'Noir', sight: 'Low light', scenes: ['A booth'], music: ['A brushed snare'] }])
  assert.equal(merged.length, 4)
  assert.equal(merged[3]!.id, 'smoke-lounge')
  assert.deepEqual(merged.slice(0, 3), CURRENT)
})

test('removing a world deletes only that world', () => {
  const merged = mergeMusicWorlds(CURRENT, [], ['b'])
  assert.deepEqual(merged.map(w => w.id), ['a', 'c'])
})

test('an unknown id, a duplicate name and a nameless new world are refused', () => {
  assert.throws(() => mergeMusicWorlds(CURRENT, [{ id: 'missing', sight: 'x' }]), /was not found/)
  assert.throws(() => mergeMusicWorlds(CURRENT, [], ['missing']), /was not found/)
  assert.throws(() => mergeMusicWorlds(CURRENT, [{ name: 'Rain alley' }]), /already exists/)
  assert.throws(() => mergeMusicWorlds(CURRENT, [{ sight: 'x' }]), /needs a name/)
})

test('the patch schema accepts worlds and removals, and still refuses an empty body', () => {
  assert.equal(MusicFormatPatchSchema.safeParse({ worlds: [{ id: 'a', name: 'Rain alley' }] }).success, true)
  assert.equal(MusicFormatPatchSchema.safeParse({ worlds_remove: ['a'] }).success, true)
  assert.equal(MusicFormatPatchSchema.safeParse({}).success, false)
})

test('an id that is both edited and removed is refused, never silently dropped', () => {
  assert.throws(
    () => mergeMusicWorlds(CURRENT, [{ id: 'a', sight: 'new' }], ['a']),
    /both edited and removed/,
  )
})

test('renaming an existing world edits it in place: same id, same position, no new world', () => {
  const merged = mergeMusicWorlds(CURRENT, [{ id: 'b', name: 'Empty ballroom at dawn' }])
  assert.equal(merged.length, 3)
  assert.equal(merged[1]!.id, 'b')
  assert.equal(merged[1]!.name, 'Empty ballroom at dawn')
  assert.deepEqual(merged.map(w => w.id), ['a', 'b', 'c'])
})
