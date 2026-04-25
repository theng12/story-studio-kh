/**
 * Tests for isCompletionTokensModel — the predicate that decides which
 * token-cap field (max_tokens vs max_completion_tokens) to send to the
 * OpenAI Chat Completions API.
 *
 * The split is critical: gpt-5 and the reasoning-model families
 * (o1/o3/o4) reject max_tokens with a 400; legacy chat models still
 * accept it. Getting this wrong breaks every text + vision call for the
 * affected family.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isCompletionTokensModel } from '../providers/text/openai.js'

describe('isCompletionTokensModel', () => {
  test('gpt-5 family → uses max_completion_tokens', () => {
    assert.equal(isCompletionTokensModel('gpt-5'), true)
    assert.equal(isCompletionTokensModel('gpt-5-mini'), true)
    assert.equal(isCompletionTokensModel('gpt-5-nano'), true, 'unreleased variants forward-compat')
    assert.equal(isCompletionTokensModel('GPT-5'), true, 'case-insensitive')
  })

  test('reasoning models (o1/o3/o4-…) → uses max_completion_tokens', () => {
    assert.equal(isCompletionTokensModel('o1'), true)
    assert.equal(isCompletionTokensModel('o1-mini'), true)
    assert.equal(isCompletionTokensModel('o3'), true)
    assert.equal(isCompletionTokensModel('o3-mini'), true)
    assert.equal(isCompletionTokensModel('o4-mini'), true)
    assert.equal(isCompletionTokensModel('o5'), true, 'unreleased o-series forward-compat')
  })

  test('legacy chat models (gpt-4 family) → keep max_tokens', () => {
    assert.equal(isCompletionTokensModel('gpt-4o'), false)
    assert.equal(isCompletionTokensModel('gpt-4o-mini'), false)
    assert.equal(isCompletionTokensModel('gpt-4-turbo'), false)
    assert.equal(isCompletionTokensModel('gpt-4.1'), false)
    assert.equal(isCompletionTokensModel('gpt-4.1-mini'), false)
    assert.equal(isCompletionTokensModel('gpt-4.1-nano'), false)
    assert.equal(isCompletionTokensModel('gpt-4'), false)
    assert.equal(isCompletionTokensModel('gpt-3.5-turbo'), false)
  })

  test('non-OpenAI models → false (only OpenAI cares about this split)', () => {
    assert.equal(isCompletionTokensModel('claude-sonnet-4'), false)
    assert.equal(isCompletionTokensModel('genaipro-gpt-5'), false, 'genaipro provider, not OpenAI direct')
  })

  test('"o" prefix without trailing digit (unrelated names) → false', () => {
    // The regex requires `o` + digit, so model names that happen to start
    // with `o` but aren't reasoning models (none today, but defensive)
    // shouldn't match.
    assert.equal(isCompletionTokensModel('omni-foo'), false)
    assert.equal(isCompletionTokensModel('open-bar'), false)
  })
})
