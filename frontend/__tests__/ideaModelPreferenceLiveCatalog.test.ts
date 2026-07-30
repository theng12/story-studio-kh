/**
 * Regression coverage for the live-catalog integration point added to
 * `resolveInitialIdeaModel` (frontend/utils/idea-model-preference.ts).
 *
 * The pre-existing hardcoded `POLLUTED_LEGACY_DEFAULTS = new Set(['gpt-4o'])`
 * baked a single external product id into app logic as a staleness check.
 * `isModelStillLive` lets any caller that can reach GenStudio's live model
 * catalog decide staleness from catalog truth instead — these tests pin
 * that when it's supplied, it is the ONLY authority consulted (the
 * hardcoded fallback set is bypassed entirely), while every previously
 * pinned no-predicate behavior in ideaModelPreference.test.ts is untouched.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveInitialIdeaModel } from '../utils/idea-model-preference.js'

describe('resolveInitialIdeaModel — isModelStillLive catalog integration', () => {
  test('a legacy id present in the live catalog is restored, even if it is the historically-polluted default', () => {
    const liveCatalogIds = new Set(['gpt-4o', 'genstudio-chat-current-v1'])
    assert.equal(
      resolveInitialIdeaModel({
        legacyProjectModel: 'gpt-4o',
        isModelStillLive: id => liveCatalogIds.has(id),
      }),
      'gpt-4o',
      'the live catalog is authoritative — it is not screened by the hardcoded literal when a predicate is supplied',
    )
  })

  test('a legacy id absent from the live catalog is rejected, regardless of the hardcoded fallback list', () => {
    const liveCatalogIds = new Set(['genstudio-chat-current-v1'])
    assert.equal(
      resolveInitialIdeaModel({
        legacyProjectModel: 'lmstudio:gemma-4-e2b-it-mlx', // not in the hardcoded deny-list
        isModelStillLive: id => liveCatalogIds.has(id),
      }),
      '',
      'catalog absence must reject a legacy id even when it was never in the hardcoded set',
    )
  })

  test('remembered and historical values still win over any legacy screening', () => {
    const liveCatalogIds = new Set<string>()
    assert.equal(
      resolveInitialIdeaModel({
        rememberedModel: 'chatstudio:provider:deepseek-v4-flash',
        legacyProjectModel: 'gpt-4o',
        isModelStillLive: id => liveCatalogIds.has(id),
      }),
      'chatstudio:provider:deepseek-v4-flash',
    )
  })

  test('without a predicate, behavior is unchanged from the pre-existing hardcoded fallback (back-compat)', () => {
    assert.equal(resolveInitialIdeaModel({ legacyProjectModel: 'gpt-4o' }), '')
    assert.equal(
      resolveInitialIdeaModel({ legacyProjectModel: 'lmstudio:gemma-4-e2b-it-mlx' }),
      'lmstudio:gemma-4-e2b-it-mlx',
    )
  })
})
