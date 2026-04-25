/**
 * Reconcile matcher — pure-function tests over the dice coefficient +
 * episode-code extraction. Guards against regressions in the fuzzy
 * scoring that would silently mis-link episodes.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTitle, diceCoefficient } from '../services/upload-reconciler.js'

describe('normalizeTitle', () => {
  test('strips episode codes', () => {
    assert.equal(normalizeTitle('TN0012 - Dreamy Selkie'), 'dreamy selkie')
    assert.equal(normalizeTitle('EP0005: Coastal Whispers'), 'coastal whispers')
  })
  test('removes sleep-story channel fluff', () => {
    assert.equal(
      normalizeTitle('Coastal Whispers | Sleep Story for Relaxation'),
      'coastal whispers',
    )
  })
  test('lowercases + collapses whitespace', () => {
    assert.equal(normalizeTitle('  HELLO   World  '), 'hello world')
  })
})

describe('diceCoefficient', () => {
  test('identical strings = 1.0', () => {
    assert.equal(diceCoefficient('hello', 'hello'), 1)
  })
  test('no overlap = 0', () => {
    assert.equal(diceCoefficient('abcd', 'wxyz'), 0)
  })
  test('partial overlap', () => {
    // "coastal whispers" vs "coastal dreams whispers" should be high.
    const s = diceCoefficient('coastal whispers', 'coastal dreams whispers')
    assert.ok(s > 0.5, `expected >0.5, got ${s}`)
    assert.ok(s < 1, 'expected <1 since strings differ')
  })
  test('empty input = 0', () => {
    assert.equal(diceCoefficient('', 'anything'), 0)
    assert.equal(diceCoefficient('anything', ''), 0)
  })
  test('single-character input: identical returns 1 (short-circuit), differing returns 0', () => {
    // Identical-string short-circuit fires before the bigram check.
    assert.equal(diceCoefficient('a', 'a'), 1)
    // Different single chars have no bigrams to match on.
    assert.equal(diceCoefficient('a', 'b'), 0)
  })
})

describe('fuzzy regression: sleep-story titles rank correctly', () => {
  test('two episodes with similar theme still rank by bigram overlap', () => {
    const a = normalizeTitle('The Tidal Sojourn of the Selkie Weaver')
    const b = normalizeTitle('The Tidal Sojourn')
    const c = normalizeTitle('The Beekeeper Celestial Dance')
    // a↔b should beat a↔c.
    assert.ok(diceCoefficient(a, b) > diceCoefficient(a, c),
      'identical prefix should outrank unrelated episode')
  })
})
