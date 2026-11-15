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
    assert.equal(ideaOutputTokenBudget(10), 7_424)
    assert.equal(ideaOutputTokenBudget(13), 9_344)
  })

  test('scales large batches without the old 16,384 cap', () => {
    assert.equal(ideaOutputTokenBudget(100), 65_024)
    assert.equal(ideaOutputTokenBudget(10_000), 65_024)
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

    // The request asks the product's published maximum; the count-scaled number is the EXPECTED
    // answer (deadline/preflight), not the ceiling.
    assert.match(freeformHelper, /\?\? \{ tier: 'maximum' \}/)
    assert.match(freeformHelper, /expectedOutputTokens: input\.expectedOutputTokens/)
    assert.match(campaign, /outputBudget: \{ tier: 'maximum' \}/)
    assert.match(campaign, /expected_output_tokens: ideaOutputTokenBudget\(assignments\.length\)/)
  })
})
