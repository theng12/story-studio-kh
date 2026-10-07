import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readQueryState, sameQuery, writeQueryState } from '../utils/route-query-state.js'

const DEFAULTS = { search: '', needsWork: true, step: null as string | null, page: 1, upload: 'all' }

test('reads each key by the type of its default and ignores junk', () => {
  assert.deepEqual(readQueryState({}, DEFAULTS), DEFAULTS)
  assert.deepEqual(
    readQueryState({ search: 'fog', needsWork: '0', step: 'audio', page: '4', upload: 'failed', other: 'x' }, DEFAULTS),
    { search: 'fog', needsWork: false, step: 'audio', page: 4, upload: 'failed' },
  )
  // Repeated keys use the first value; a bad page number falls back to the default.
  assert.equal(readQueryState({ search: ['a', 'b'] }, DEFAULTS).search, 'a')
  for (const page of ['0', '-2', 'abc', '1.5', '']) assert.equal(readQueryState({ page }, DEFAULTS).page, 1)
  assert.equal(readQueryState({ needsWork: '1' }, DEFAULTS).needsWork, true)
  assert.equal(readQueryState({ upload: '' }, DEFAULTS).upload, 'all')
})

test('writes only what differs from the defaults and keeps unrelated keys', () => {
  assert.deepEqual(writeQueryState({ repair: '1' }, DEFAULTS, DEFAULTS), { repair: '1' })
  assert.deepEqual(
    writeQueryState({ repair: '1', page: '9' }, { ...DEFAULTS, search: 'fog', needsWork: false, page: 3 }, DEFAULTS),
    { repair: '1', search: 'fog', needsWork: '0', page: '3' },
  )
  // Back to the defaults clears the keys again.
  assert.deepEqual(writeQueryState({ search: 'fog', page: '3' }, DEFAULTS, DEFAULTS), {})
})

test('round-trips through the URL', () => {
  const state = { search: 'EP03', needsWork: false, step: 'thumbnails', page: 2, upload: 'pending' }
  assert.deepEqual(readQueryState(writeQueryState({}, state, DEFAULTS), DEFAULTS), state)
})

test('sameQuery ignores key order and treats missing as missing', () => {
  assert.equal(sameQuery({ a: '1', b: '2' }, { b: '2', a: '1' }), true)
  assert.equal(sameQuery({ a: '1' }, { a: '1', b: '2' }), false)
  assert.equal(sameQuery({ a: ['1'] }, { a: '1' }), false)
})
