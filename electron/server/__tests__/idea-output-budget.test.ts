import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ideaOutputTokenBudget } from '../services/idea-output-budget.js'

describe('idea output token budget', () => {
  test('raises small structured requests above the generic chat default', () => {
    assert.equal(ideaOutputTokenBudget(1), 4_096)
    assert.equal(ideaOutputTokenBudget(4), 4_096)
    assert.equal(ideaOutputTokenBudget(Number.NaN), 4_096)
  })

  test('scales regular and campaign batches by expected JSON object count', () => {
    assert.equal(ideaOutputTokenBudget(10), 7_168)
    assert.equal(ideaOutputTokenBudget(13), 9_216)
  })

  test('keeps unusually large requests below the Gateway model ceiling', () => {
    assert.equal(ideaOutputTokenBudget(100), 16_384)
    assert.equal(ideaOutputTokenBudget(10_000), 16_384)
  })

  test('wires the bounded budget into the shared freeform helper and campaign calls', () => {
    const freeformHelper = readFileSync(
      fileURLToPath(new URL('../services/freeform-idea-generation.ts', import.meta.url)),
      'utf8',
    )
    const campaign = readFileSync(
      fileURLToPath(new URL('../generators/idea-campaign.ts', import.meta.url)),
      'utf8',
    )

    // The count-scaled number is now a FLOOR inside a product-derived budget,
    // so it can never exceed the selected product's published output limit.
    assert.match(freeformHelper, /outputBudget: \{ tier: 'long', minimumTokens: ideaOutputTokenBudget\(input\.request\.count\) \}/)
    assert.match(campaign, /outputBudget: \{ tier: 'long', minimumTokens: ideaOutputTokenBudget\(assignments\.length\) \}/)
  })
})
