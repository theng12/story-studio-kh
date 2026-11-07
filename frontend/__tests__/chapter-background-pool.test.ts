/**
 * Chapter Background Pools — the editor as the page presents it (release
 * 1.4.386, item 14; serial only, the rotation that was asked for).
 *
 * Proved here:
 *   1. the editor decides nothing on its own: every rotation answer comes from
 *      the shared contract, it never writes a save itself, and it starts from
 *      an empty pool (today's behaviour). It offers NO rotation mode options —
 *      serial is the feature, not a choice;
 *   2. the contract answers the way the editor displays it: the "Next" line
 *      matches the serial pick the render would record.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  decideChapterBackground,
  emptyChapterBackgroundPool,
  normaliseChapterBackgroundPool,
  normaliseCursor,
  poolBackgroundIds,
} from '../../electron/server/contracts/chapter-background-pool.js'

const componentUrl = new URL('../components/ChapterBackgroundPoolEditor.vue', import.meta.url)
const source = readFileSync(fileURLToPath(componentUrl), 'utf8')

test('the editor defers every rotation answer to the shared contract', () => {
  assert.match(source, /contracts\/chapter-background-pool\.js/)
  for (const name of [
    'decideChapterBackground',
    'normaliseChapterBackgroundPool',
    'normaliseCursor',
    'poolBackgroundIds',
  ]) {
    assert.ok(source.includes(name), `the editor must use ${name} from the contract`)
  }
  // No second rotation store or ad-hoc pick inside the component.
  assert.ok(!source.includes('Math.random'), 'picks are decided by the contract, never locally')
  assert.ok(!source.includes('% items.length') && !source.includes('% length'), 'no local wrap-around logic')
  // Selection only: the host page owns the save path (no fetch of its own).
  assert.ok(!/\bfetch\s*\(|\$fetch|useFetch/.test(source), 'the editor never writes a save itself')
  // Serial is the feature, not an option: no rotation-mode chooser is offered.
  assert.ok(!source.includes('usage_mode'), 'no unasked rotation-mode UI')
  assert.ok(!source.includes('weight'), 'no unasked weighting UI')
})

test('the editor starts OFF: an empty pool is today\'s behaviour', () => {
  assert.deepEqual(emptyChapterBackgroundPool(), { items: [] })
  assert.deepEqual(poolBackgroundIds(emptyChapterBackgroundPool()), [])
  // Absent, null and malformed stored pools all read back empty — nothing invented.
  assert.deepEqual(normaliseChapterBackgroundPool(null), { items: [] })
  assert.deepEqual(normaliseChapterBackgroundPool({ usage_mode: 'weighted' }), { items: [] })
  assert.equal(decideChapterBackground(emptyChapterBackgroundPool(), null), null)
})

test('the Next line the editor shows is the serial pick the render records', () => {
  const poolValue = normaliseChapterBackgroundPool({
    items: [
      { id: 'one', name: 'One', reference: 'one.jpg', enabled: true },
      { id: 'two', name: 'Two', reference: 'two.jpg', enabled: true },
      { id: 'three', name: 'Three', reference: 'three.jpg', enabled: true },
    ],
  })

  // No cursor yet: position 1 of 3.
  const first = decideChapterBackground(poolValue, null)
  assert.equal(first!.item.id, 'one')
  assert.equal(first!.index + 1, 1)
  assert.equal(poolBackgroundIds(poolValue).length, 3)

  // After 'two' (index 1): next is 'three' — position 3 of 3.
  const next = decideChapterBackground(poolValue, normaliseCursor({ last_background_id: 'two', last_index: 1 }))
  assert.equal(next!.item.id, 'three')
  assert.equal(next!.index + 1, 3)

  // A disabled item never appears in the Next line.
  const withOff = normaliseChapterBackgroundPool({
    items: [
      { id: 'one', name: 'One', reference: 'one.jpg', enabled: true },
      { id: 'two', name: 'Two', reference: 'two.jpg', enabled: false },
      { id: 'three', name: 'Three', reference: 'three.jpg', enabled: true },
    ],
  })
  const afterOne = decideChapterBackground(withOff, normaliseCursor({ last_background_id: 'one', last_index: 0 }))
  assert.equal(afterOne!.item.id, 'three')
  assert.ok(!poolBackgroundIds(withOff).includes('two'))

  // A cursor stored as a bare index still renders a sensible Next line.
  assert.deepEqual(normaliseCursor(2), { last_background_id: null, last_index: 2 })
  assert.equal(decideChapterBackground(poolValue, normaliseCursor(2))!.item.id, 'three')
})
