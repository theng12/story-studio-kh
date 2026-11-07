/**
 * Chapter Background Pools — the editor as the page presents it (release 1.4.386, item 14).
 *
 * Two things are proved here:
 *   1. the editor decides nothing on its own: every rotation answer comes from the shared
 *      contract (`contracts/chapter-background-pool.ts`), it never writes a save itself, and
 *      it starts from an empty pool (OFF by default — today's behaviour);
 *   2. the contract really answers the way the editor displays it: serial is the default,
 *      one background is stable, disabled items are skipped, and the "Next" line matches
 *      the rotation the render will take.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  CHAPTER_BACKGROUND_USAGE_LABELS,
  CHAPTER_BACKGROUND_USAGE_MODES,
  decideChapterBackground,
  emptyChapterBackgroundPool,
  normaliseChapterBackgroundPool,
  normaliseCursor,
  percentagesFor,
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
    'percentagesFor',
    'poolBackgroundIds',
  ]) {
    assert.ok(source.includes(name), `the editor must use ${name} from the contract`)
  }
  // No second rotation store or ad-hoc pick inside the component.
  assert.ok(!source.includes('Math.random'), 'picks are decided by the contract, never locally')
  assert.ok(!source.includes('% items.length') && !source.includes('% length'), 'no local wrap-around logic')
  // Selection only: the host page owns the save path (no fetch of its own).
  assert.ok(!/\bfetch\s*\(|\$fetch|useFetch/.test(source), 'the editor never writes a save itself')
})

test('the editor offers serial as the default and starts OFF (empty pool)', () => {
  assert.equal(emptyChapterBackgroundPool().usage_mode, 'serial')
  assert.equal(emptyChapterBackgroundPool().items.length, 0)
  // Every mode the radios can show comes from the contract constant, never a local list.
  assert.deepEqual(CHAPTER_BACKGROUND_USAGE_MODES, ['serial', 'weighted', 'manual'])
  assert.equal(CHAPTER_BACKGROUND_USAGE_LABELS.serial, 'One after another')
  assert.ok(source.includes('USAGE_MODES'), 'the editor renders the mode radios from the contract')
  assert.ok(source.includes('USAGE_LABELS'), 'the editor labels modes with the contract\'s plain words')
  // An unknown stored mode reads back as serial, never a guess at something else.
  assert.equal(normaliseChapterBackgroundPool({ usage_mode: 'shuffle' }).usage_mode, 'serial')
  assert.equal(normaliseChapterBackgroundPool({ usage_mode: 'nothing-unknown' }).usage_mode, 'serial')
})

test('the Next line the editor shows is the rotation the render will take', () => {
  const poolValue = normaliseChapterBackgroundPool({
    items: [
      { id: 'one', name: 'One', reference: 'one.jpg', enabled: true, weight: 100 },
      { id: 'two', name: 'Two', reference: 'two.jpg', enabled: true, weight: 100 },
      { id: 'three', name: 'Three', reference: 'three.jpg', enabled: true, weight: 100 },
    ],
  })

  // No cursor yet: the first item.
  const first = decideChapterBackground(poolValue, null, () => 0)
  assert.equal(first!.item.id, 'one')

  // After 'two' (index 1), next is 'three'; the editor's serial position reads 3 of 3.
  const next = decideChapterBackground(poolValue, { last_background_id: 'two', last_index: 1 }, () => 0)
  assert.equal(next!.item.id, 'three')
  const enabled = poolBackgroundIds(poolValue)
  assert.equal(enabled.indexOf(next!.item.id) + 1, 3)
  assert.equal(enabled.length, 3)

  // A disabled item never appears in the Next line.
  const withOff = normaliseChapterBackgroundPool({
    items: [
      { id: 'one', name: 'One', reference: 'one.jpg', enabled: true, weight: 100 },
      { id: 'two', name: 'Two', reference: 'two.jpg', enabled: false, weight: 100 },
      { id: 'three', name: 'Three', reference: 'three.jpg', enabled: true, weight: 100 },
    ],
  })
  const afterOne = decideChapterBackground(withOff, { last_background_id: 'one', last_index: 0 }, () => 0)
  assert.equal(afterOne!.item.id, 'three')
  assert.ok(!poolBackgroundIds(withOff).includes('two'))

  // Weighted mode shows the contract's own percentage beside the Next line.
  const weighted = normaliseChapterBackgroundPool({
    usage_mode: 'weighted',
    items: [
      { id: 'one', name: 'One', reference: 'one.jpg', enabled: true, weight: 75 },
      { id: 'two', name: 'Two', reference: 'two.jpg', enabled: true, weight: 25 },
    ],
  })
  const pct = percentagesFor(weighted)
  assert.deepEqual(pct, [75, 25])
  const decision = decideChapterBackground(weighted, null, () => 0)!
  const at = poolBackgroundIds(weighted).indexOf(decision.item.id)
  assert.ok(pct[at]! > 0)

  // A cursor stored as a bare index still renders a sensible Next line.
  assert.deepEqual(normaliseCursor(2), { last_background_id: null, last_index: 2 })
  assert.equal(
    decideChapterBackground(poolValue, normaliseCursor(2), () => 0)!.item.id,
    'three',
  )
})
