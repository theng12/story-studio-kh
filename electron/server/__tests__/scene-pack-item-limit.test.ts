/**
 * STORY-10 — the 30-scene pack, and the second half of the v1.4.224 fix.
 *
 * WHAT HAPPENED. The owner raised Studio Hub's output ceiling (4,096 → 16,384) so
 * that a 30-chapter episode could be planned in ONE request instead of thirty round
 * trips. At 16,384 Story Studio's own derived maximum is 40 scenes, so the ceiling
 * was never the binding constraint. What refused was this file.
 *
 * Two consumers read `max_structured_items_per_request`, and until now they disagreed
 * about what an unpublished value means:
 *
 *   - `contextual-cues.ts` — an absent number is no bound; the batch goes out and the
 *     provider answers. Fixed in v1.4.224 (`2e6a55ae`).
 *   - `scene-plan.ts` — an absent number was treated as a limit of ZERO, so a pack
 *     refused before a single request. `null` failed `typeof !== 'number'`.
 *
 * Every row publishes `null` today, including the local lane the owner runs, so the
 * refusal was the common case rather than an edge one — and its message read
 * "above its published **unpublished** item limit". The owner's ruling of 2026-09-26
 * settles which half was wrong: *we follow what a model publishes and invent no
 * ceiling of our own.*
 *
 * This is the half the 30-scene pack actually runs through, which is why the ceiling
 * raise alone did not open it.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { assertScenePromptPackCapability } from '../generators/scene-plan.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'

const model = (over: Partial<GenStudioChatModel>): GenStudioChatModel => ({
  id: 'genstudio-chat-test-v1',
  display_name: 'Test Model',
  supports_structured_output: true,
  structured_output_mode: 'json_object',
  ...over,
} as GenStudioChatModel)

describe('an unpublished item limit never invents a cap', () => {
  test('null does not refuse a 30-scene pack — this is the regression', () => {
    assert.doesNotThrow(() => assertScenePromptPackCapability(
      model({ max_structured_items_per_request: null }), undefined, 30,
    ))
  })

  test('undefined behaves the same as null', () => {
    assert.doesNotThrow(() => assertScenePromptPackCapability(
      model({ max_structured_items_per_request: undefined as unknown as null }), undefined, 30,
    ))
  })

  test('zero and negatives are "not usable", never "no items allowed"', () => {
    // A published 0 is a claim, but it is not a claim that nothing fits. Treating
    // it as a bound would reintroduce the limit-of-zero through the back door.
    for (const value of [0, -5]) {
      assert.doesNotThrow(() => assertScenePromptPackCapability(
        model({ max_structured_items_per_request: value }), undefined, 30,
      ), `a published ${value} must not refuse the pack`)
    }
  })

  test('an unpublished limit never produces the garbled "published unpublished" refusal', () => {
    // The sentence v1.4.224 removed from Contextual Cues was still reachable from
    // here: `null` threw, and the template's `?? 'unpublished'` fallback supplied
    // the second half of "above its published unpublished item limit".
    //
    // The correct outcome is that nothing is refused at all, so there is no
    // message to garble — the assertion below is the belt to that braces, and it
    // is what fails if the refusal ever comes back in a garbled form.
    try {
      assertScenePromptPackCapability(
        model({ max_structured_items_per_request: null }), undefined, 30,
      )
    } catch (error) {
      assert.doesNotMatch((error as Error).message, /published unpublished/,
        'the garbled "published unpublished item limit" message came back')
      throw error
    }
  })

  test('a refusal about a PUBLISHED limit names the number and never says "unpublished"', () => {
    try {
      assertScenePromptPackCapability(model({ max_structured_items_per_request: 4 }), undefined, 30)
      assert.fail('expected a refusal')
    } catch (error) {
      const message = (error as Error).message
      assert.match(message, /\b4\b/, 'the refusal must name the published limit')
      assert.doesNotMatch(message, /unpublished/,
        'a refusal that has a real number must not also call it unpublished')
    }
  })
})

describe('a PUBLISHED item limit still bounds the pack, downward only', () => {
  test('a limit at or above the pack is not a refusal', () => {
    assert.doesNotThrow(() => assertScenePromptPackCapability(
      model({ max_structured_items_per_request: 30 }), undefined, 30,
    ))
    assert.doesNotThrow(() => assertScenePromptPackCapability(
      model({ max_structured_items_per_request: 250 }), undefined, 30,
    ))
  })

  test('a limit below the pack refuses, and names the number', () => {
    assert.throws(
      () => assertScenePromptPackCapability(model({ max_structured_items_per_request: 12 }), undefined, 30),
      (error: Error) => {
        assert.match(error.message, /30/)
        assert.match(error.message, /12/, 'a refusal must name the published limit, not just the pack size')
        return true
      },
    )
  })
})

describe('the guarantees that existed before are still enforced', () => {
  test('a model that cannot hold a JSON contract is still refused first', () => {
    assert.throws(
      () => assertScenePromptPackCapability(model({
        structured_output_mode: 'none',
        max_structured_items_per_request: null,
      }), undefined, 30),
      /cannot be held to a JSON contract/,
    )
  })

  test('the token budget still refuses, so softening the item gate removed no bound', () => {
    // The item limit was never the only ceiling: the pack must still fit the
    // model's published output tokens. This is what makes the fix safe.
    assert.throws(
      () => assertScenePromptPackCapability(model({
        max_structured_items_per_request: null,
        max_output_tokens: 4096,
      }), 12000, 30),
      /above its published 4,096 limit/,
    )
  })

  test('a pack inside the token budget passes when nothing else is published', () => {
    assert.doesNotThrow(() => assertScenePromptPackCapability(model({
      max_structured_items_per_request: null,
      max_output_tokens: 16384,
    }), 12000, 30))
  })
})
