/**
 * Title-count parsing + rewriting helpers (v1.0.70).
 *
 * Used to enforce items_per_listicle consistency between the LLM-
 * generated title and suggested_chapters, and to drive the Scripts
 * page's "Sync title to N chapters" action and the post-generation
 * auto-rewrite in generators/episode.ts.
 *
 * The mirror of these helpers lives inline in
 * frontend/pages/projects/[slug]/scripts.vue:parseLeadingCount —
 * keep both regexes in sync (or extract to a shared module if a
 * third caller appears).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseLeadingCount, rewriteLeadingCount } from '../routes/ideas.js'

describe('parseLeadingCount', () => {
  test('matches a bare leading number', () => {
    const m = parseLeadingCount('10 mysteries explained')
    assert.deepEqual(m, { value: 10, start: 0, end: 2 })
  })

  test('matches across "The N …" prefixes', () => {
    const m = parseLeadingCount('The 5 longest rivers')
    assert.equal(m?.value, 5)
    // start should point at the digit, not "The "
    assert.equal(m?.start, 4)
    assert.equal(m?.end, 5)
  })

  test('matches across "Top N …" prefixes', () => {
    const m = parseLeadingCount('Top 12 paradoxes')
    assert.equal(m?.value, 12)
    assert.equal(m?.start, 4)
  })

  test('returns null when the title has no leading number', () => {
    assert.equal(parseLeadingCount('Sleep mysteries explained'), null)
    assert.equal(parseLeadingCount(''), null)
  })

  test('returns null for word-form numbers (intentional — keep rewrite literal)', () => {
    // "Five" / "Twelve" parse paths would force the rewriter to convert
    // numerals back into words, which is brittle and locale-bound. We
    // only handle digits — wordy titles fall through and the user gets
    // no warning chip.
    assert.equal(parseLeadingCount('Five plane crashes'), null)
    assert.equal(parseLeadingCount('Twelve sleep mysteries'), null)
  })

  test('does not match a number embedded mid-title', () => {
    assert.equal(parseLeadingCount('A history of 10 paradoxes'), null)
  })

  test('rejects zero / negative-looking leads', () => {
    // The regex captures positive integers only; "0 something" would
    // be technically valid but a 0-chapter listicle isn't a thing.
    assert.equal(parseLeadingCount('0 mysteries'), null)
  })
})

describe('rewriteLeadingCount', () => {
  test('rewrites a leading number when target differs', () => {
    assert.equal(rewriteLeadingCount('7 historical cold cases', 10), '10 historical cold cases')
  })

  test('preserves "The N …" prefix shape', () => {
    assert.equal(rewriteLeadingCount('The 5 longest rivers', 7), 'The 7 longest rivers')
  })

  test('preserves "Top N …" prefix shape', () => {
    assert.equal(rewriteLeadingCount('Top 10 paradoxes explained', 12), 'Top 12 paradoxes explained')
  })

  test('returns the title unchanged when it already matches', () => {
    assert.equal(rewriteLeadingCount('10 sleep mysteries', 10), '10 sleep mysteries')
  })

  test('returns the title unchanged when it has no leading number', () => {
    assert.equal(rewriteLeadingCount('Sleep mysteries explained', 10), 'Sleep mysteries explained')
  })

  test('handles multi-digit values both directions', () => {
    assert.equal(rewriteLeadingCount('100 paradoxes', 7), '7 paradoxes')
    assert.equal(rewriteLeadingCount('7 paradoxes', 100), '100 paradoxes')
  })
})
