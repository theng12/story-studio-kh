import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  costTierLabel,
  isCompleteTierCatalog,
  tierForKeyboard,
  tierForOpening,
  visibleTierOptions,
} from '../utils/genstudio-cost-tier.js'

const complete = [
  { id: 'fast', costTier: 'economy' as const },
  { id: 'steady', costTier: 'balanced' as const },
  { id: 'flagship', costTier: 'premium' as const },
]

describe('GenStudio cost-tier policy', () => {
  test('enables tier mode only for a fully classified non-empty catalog', () => {
    // Catches a regression that renders tier tabs while a row has no published tier.
    assert.equal(isCompleteTierCatalog(complete), true)
    assert.equal(isCompleteTierCatalog([...complete, { id: 'unknown' }]), false)
    assert.equal(isCompleteTierCatalog([...complete, { id: 'invalid', costTier: 'free' }]), false)
    assert.equal(isCompleteTierCatalog([]), false)
  })

  test('opens the selected published tier or economy for new and unknown selections', () => {
    // Catches opening every menu on a saved premium/balanced model in Economy.
    assert.equal(tierForOpening('', complete), 'economy')
    assert.equal(tierForOpening('missing', complete), 'economy')
    assert.equal(tierForOpening('steady', complete), 'balanced')
    assert.equal(tierForOpening('flagship', complete), 'premium')
  })

  test('shows only the active tier without a query and preserves source order', () => {
    // Catches an empty search leaking models from other tiers or re-sorting the catalogue.
    const options = [complete[2], complete[0], complete[1]]
    assert.deepEqual(visibleTierOptions(options, 'economy', false).map(option => option.id), ['fast'])
  })

  test('searches every tier while retaining the tier published on each result', () => {
    // Catches search filtering to the selected tab or showing every result with
    // the active tab's label instead of the tier published on that result.
    const results = visibleTierOptions(complete, 'economy', true)
    assert.deepEqual(results.map(option => option.id), ['fast', 'steady', 'flagship'])
    assert.deepEqual(results.map(option => costTierLabel(option.costTier)), ['Economy', 'Balanced', 'Premium'])
  })

  test('keeps incomplete catalogues unfiltered even without a query', () => {
    // Catches hiding models when GenStudio has not classified every row yet.
    const incomplete = [...complete, { id: 'unknown' }]
    assert.deepEqual(visibleTierOptions(incomplete, 'premium', false).map(option => option.id), [
      'fast', 'steady', 'flagship', 'unknown',
    ])
  })

  test('uses the same Home/End target for selection and roving focus', () => {
    // ModelMenu gives this returned target to both its active selection and
    // focused button. Catches Home/End deriving the next arrow from the old tab.
    assert.equal(tierForKeyboard('premium', 'Home'), 'economy')
    assert.equal(tierForKeyboard('economy', 'ArrowLeft'), 'premium')
    assert.equal(tierForKeyboard('economy', 'End'), 'premium')
    assert.equal(tierForKeyboard('premium', 'ArrowRight'), 'economy')
  })
})
