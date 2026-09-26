import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { resolveContextualCueBatchSize } from '../services/contextual-cues.js'

/**
 * The item limit is a PUBLISHED figure or nothing at all (owner ruling,
 * 2026-09-26). Before this, an unpublished `max_structured_items_per_request`
 * — what every row publishes today — made the contextual-cue generator refuse
 * outright, i.e. an absent number acting as a limit of zero.
 */
test('an unpublished item limit never invents a cap: the policy batch size stands', () => {
  assert.equal(resolveContextualCueBatchSize(null, 12), 12)
  assert.equal(resolveContextualCueBatchSize(undefined, 12), 12)
  // No saved policy either: the module's own default, not a number pulled from
  // the absent published field.
  assert.equal(resolveContextualCueBatchSize(null), resolveContextualCueBatchSize(undefined))
  assert.ok(resolveContextualCueBatchSize(null) >= 1)
})

test('a published item limit still bounds the batch, downward only', () => {
  assert.equal(resolveContextualCueBatchSize(4, 12), 4)
  assert.equal(resolveContextualCueBatchSize(250, 12), 12)
  // Zero and negatives are "not usable", never "no items allowed".
  assert.equal(resolveContextualCueBatchSize(0, 12), 12)
  assert.equal(resolveContextualCueBatchSize(-5, 12), 12)
})

test('the generator refuses only on a PUBLISHED limit, and names the number', () => {
  // Source-level, because the assert is module-private and the failure shape is
  // what matters: `null` must not reach the throw, and the message must never
  // read "published unpublished" again.
  const source = readFileSync(new URL('../generators/contextual-cues.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /structuredItemLimit\s*\?\?\s*'unpublished'/,
    'the garbled "published unpublished item limit" message came back',
  )
  assert.match(
    source,
    /if \(structuredItemLimit === null\) return/,
    'an unpublished item limit must not reach the refusal',
  )
})
