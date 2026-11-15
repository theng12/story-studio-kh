/**
 * Song Pool row readiness (1.4.402): the page's "in window" chip and Free filter must include
 * draft-only blocks, and select-all must act on the rows actually shown. These are the page's own
 * helpers, so a rendered row and a draft-held row are checked through the same code the table uses.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { freeForNext, holdingLabel, inWindow, isDrawable, toggleAllShown } from '../utils/song-pool-window.js'

const basis = {
  slug: 'cello',
  windowCodes: ['CJ0001', 'CJ0027'],
  blocked: { 'pool/s9': 'CJ0027' },
  poolId: 'pool',
}

const rendered = {
  id: 's1', status: 'ready', enabled: true, duration_s: 284,
  episodes: [{ code: 'CJ0001', project_slug: 'cello', used_at: '2026-09-01T00:00:00Z' }],
}
const draftOnly = { id: 's9', status: 'ready', enabled: true, duration_s: 284, episodes: [] }
const free = { id: 's5', status: 'ready', enabled: true, duration_s: 284, episodes: [] }
const unmeasured = { id: 's6', status: 'ready', enabled: true, duration_s: 0, episodes: [] }

test('a draft-only block counts as in window and is never offered as free', () => {
  assert.equal(inWindow(draftOnly, basis), true)
  assert.equal(freeForNext(draftOnly, basis), false)
  assert.equal(holdingLabel(draftOnly, basis), 'CJ0027 (saved plan)')
})

test('a rendered use in the window names its episode and blocks the song', () => {
  assert.equal(inWindow(rendered, basis), true)
  assert.equal(freeForNext(rendered, basis), false)
  assert.equal(holdingLabel(rendered, basis), 'CJ0001')
})

test('a free drawable song is offered, and a song with no measured duration never is', () => {
  assert.equal(inWindow(free, basis), false)
  assert.equal(freeForNext(free, basis), true)
  assert.equal(isDrawable(unmeasured), false)
  assert.equal(freeForNext(unmeasured, basis), false)
})

test('select-all covers only the shown rows and leaves other selections alone', () => {
  const selected = new Set(['other'])
  const all = toggleAllShown(['a', 'b'], selected)
  assert.deepEqual([...all].sort(), ['a', 'b', 'other'])
  const cleared = toggleAllShown(['a', 'b'], all)
  assert.deepEqual([...cleared], ['other'])
  assert.deepEqual([...toggleAllShown([], new Set(['x']))], ['x'], 'no rows shown changes nothing')
})
