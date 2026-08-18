/**
 * v1.4.1 — version strings order by their numbers, not their characters.
 *
 * `'1.0.9' < '1.0.10'` is FALSE. String comparison reads characters, so it puts
 * `1.0.10` before `1.0.2` and calls `1.0.9` the newest release a pack ever
 * shipped. Five Content Pack display sorts used `localeCompare` or a bare
 * `.sort()` and were correct only while no pack reached a double-digit patch.
 *
 * Found while auditing the app's own version handling after Story Studio was
 * fixed at `1.4.x` forever — only the third digit moves now, so it passes 1.4.9
 * within days. The app's own comparisons were already safe; these were the real
 * instance of the mistake, in a neighbouring version space.
 *
 * The failing case is pinned FIRST and explicitly, because a test that only
 * checks single digits passes just as happily against the broken comparator.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { compareVersionStrings, compareVersionStringsDescending } from '../content-packs/version-order.js'

describe('ordering version strings', () => {
  test('the case string comparison gets wrong', () => {
    // Every one of these is ordered CORRECTLY by this comparator and
    // INCORRECTLY by `localeCompare` / the default sort.
    assert.ok(compareVersionStrings('1.0.9', '1.0.10') < 0, '1.0.9 must precede 1.0.10')
    assert.ok(compareVersionStrings('1.4.9', '1.4.100') < 0)
    assert.ok(compareVersionStrings('1.0.2', '1.0.10') < 0, '1.0.2 must precede 1.0.10')
    // And proof the naive version really does disagree, so this test cannot
    // quietly stop testing anything if the implementation is swapped back.
    assert.ok('1.0.9'.localeCompare('1.0.10') > 0, 'string compare should be wrong here')
  })

  test('sorts a realistic version history correctly', () => {
    const sorted = ['1.0.10', '1.0.2', '1.0.9', '1.1.0', '1.0.100'].sort(compareVersionStrings)
    assert.deepEqual(sorted, ['1.0.2', '1.0.9', '1.0.10', '1.0.100', '1.1.0'])
  })

  test('newest-first is the exact mirror', () => {
    const sorted = ['1.0.2', '1.0.10', '1.0.9'].sort(compareVersionStringsDescending)
    assert.deepEqual(sorted, ['1.0.10', '1.0.9', '1.0.2'])
  })

  test('every segment counts, not just the last', () => {
    assert.ok(compareVersionStrings('1.9.0', '1.10.0') < 0)
    assert.ok(compareVersionStrings('2.0.0', '10.0.0') < 0)
    assert.equal(compareVersionStrings('1.4.1', '1.4.1'), 0)
  })

  test('a missing segment is zero, not an arbitrary order', () => {
    assert.equal(compareVersionStrings('1.4', '1.4.0'), 0)
    assert.ok(compareVersionStrings('1.4', '1.4.1') < 0)
  })

  test('never throws on anything it cannot read', () => {
    // These are display paths building an API response. The strict comparator in
    // the installer SHOULD throw on an unparseable version — a compatibility
    // gate must refuse what it cannot read. Here, a corrupt key on disk turning
    // a mis-ordered list into a 500 would be strictly worse than mis-ordering.
    for (const bad of ['', 'abc', '1.x.3', null, undefined, {}, '1..2']) {
      assert.doesNotThrow(() => compareVersionStrings(bad as never, '1.0.0'))
      assert.doesNotThrow(() => compareVersionStrings('1.0.0', bad as never))
    }
    // And it stays a stable ordering rather than collapsing everything to 0.
    assert.equal(compareVersionStrings('1.x.3', '1.x.3'), 0)
    assert.ok(compareVersionStrings('1.0.0', 'abc') !== 0)
  })

  test('a huge patch number is still ordered by value', () => {
    // He intends to count up indefinitely; 1.4.889 is his own example.
    assert.ok(compareVersionStrings('1.4.889', '1.4.1000') < 0)
    assert.ok(compareVersionStrings('1.4.99', '1.4.889') < 0)
  })
})
