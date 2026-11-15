/**
 * A NEW idea batch asks for the product's published maximum output allowance while its EXPECTED
 * answer stays the count's own workload floor (1.4.402, job286aa756: 10,623 completion tokens of
 * which 8,602 were reasoning left only 2,021 for the answer, because the expected figure was also
 * the cap).
 *
 * These are the pure numbers the request is built from: the ceiling resolver, the expectation, the
 * context bound, and the replay rule for a batch captured before this change.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boundOutputTokensToContext,
  expectedOutputTokensFor,
  resolveOutputTokenBudget,
} from '../services/output-token-budget.js'
import { ideaOutputTokenBudget } from '../services/idea-output-budget.js'

const PUBLISHED = 16_384
const OLD_CAP = 10_624

test('a new batch asks for the published maximum, not its expected answer', () => {
  const budget = { tier: 'maximum' as const }
  const expected = ideaOutputTokenBudget(15)
  assert.equal(expected, OLD_CAP, 'the count-derived expectation is unchanged')
  assert.equal(resolveOutputTokenBudget(budget, PUBLISHED), PUBLISHED, 'the ceiling is the published allowance')
  assert.equal(expectedOutputTokensFor(budget), null, 'the maximum tier states no expectation')
  assert.ok(PUBLISHED - expected > 0, 'room exists above the expected answer')
})

test('the expectation still sizes the deadline from the workload floor', () => {
  assert.equal(expectedOutputTokensFor({ tier: 'workload', minimumTokens: OLD_CAP }), OLD_CAP)
  assert.equal(resolveOutputTokenBudget({ tier: 'workload', minimumTokens: OLD_CAP }, PUBLISHED), OLD_CAP)
})

test('a published allowance at or below the old cap cannot be raised — the boundary is reported', () => {
  assert.equal(resolveOutputTokenBudget({ tier: 'maximum' }, OLD_CAP), OLD_CAP)
  assert.equal(resolveOutputTokenBudget({ tier: 'maximum' }, 4_096), 4_096)
})

test('an absent ceiling omits the field, and a malformed one is never invented', () => {
  assert.equal(resolveOutputTokenBudget({ tier: 'maximum' }, null), null)
  assert.equal(resolveOutputTokenBudget({ tier: 'maximum' }, 0), null)
  assert.throws(() => resolveOutputTokenBudget({ tier: 'maximum' }, 'many'))
})

test('the context and request bounds still apply to the published maximum', () => {
  const bounded = boundOutputTokensToContext(PUBLISHED, 20_000, 4_000, 0)
  assert.equal(bounded.overflow, false)
  assert.equal(bounded.maxTokens, PUBLISHED, 'the published maximum fits beside the prompt')
  const tooLong = boundOutputTokensToContext(PUBLISHED, 20_000, 4_000, 0, 900)
  assert.equal(tooLong.overflow, true)
  assert.equal(tooLong.overflowLimit, 'request')
})

test('a captured pre-change batch replays its original 10,624 cap and body', () => {
  const captured = { outputBudget: { tier: 'workload' as const, minimumTokens: OLD_CAP }, expected_output_tokens: undefined }
  assert.equal(resolveOutputTokenBudget(captured.outputBudget, PUBLISHED), OLD_CAP)
  assert.equal(expectedOutputTokensFor(captured.outputBudget), OLD_CAP, 'the captured body already carried this expectation')
  assert.equal(captured.expected_output_tokens, undefined, 'no new field is added to a captured record')
})

test('a captured post-change batch replays its maximum budget and expected answer', () => {
  const captured = { outputBudget: { tier: 'maximum' as const }, expected_output_tokens: OLD_CAP }
  assert.equal(resolveOutputTokenBudget(captured.outputBudget, PUBLISHED), PUBLISHED)
  assert.equal(captured.expected_output_tokens, OLD_CAP)
})

test('the budget carries no language input, so Khmer and English keep the same model eligibility', () => {
  // The helpers take a ceiling and a count only; nothing here can filter or choose a model.
  assert.equal(resolveOutputTokenBudget({ tier: 'maximum' }, PUBLISHED), PUBLISHED)
  assert.equal(ideaOutputTokenBudget(15), OLD_CAP)
})
