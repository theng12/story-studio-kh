/**
 * Idea batch sizing by audience language (1.4.402 production, Khmer campaign f5dda933).
 *
 * The English workload estimate stays byte-for-byte. Khmer has NO measured answer cost in this
 * build and the Gateway catalogue publishes none, so the batch keeps the English estimate and says
 * so in a visible note — no invented multiplier. A real measurement, when supplied, only ever
 * shrinks the batch, and a ceiling that cannot hold one measured idea reports `cannot_fit_one_idea`
 * instead of asking for an answer that would truncate.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ideaBatchForPublishedCeiling,
  ideaOutputTokenBudget,
  ideaOutputTokenBudgetFor,
} from '../services/idea-output-budget.js'
import { resolveOutputTokenBudget } from '../services/output-token-budget.js'

test('English keeps the existing count and wire budget at 4,096 and 8,192', () => {
  const small = ideaBatchForPublishedCeiling(4_096, 100, { code: 'en' })
  assert.equal(small.source, 'published_ceiling')
  assert.equal(small.batch, 4)
  assert.equal(small.budget, 4_096, 'the 4,096 floor still stands')
  assert.equal(small.budget, resolveOutputTokenBudget({ tier: 'workload', minimumTokens: ideaOutputTokenBudget(4) }, 4_096))
  assert.equal(small.language_basis.measured, false)
  assert.equal(small.language_basis.note, '')

  const large = ideaBatchForPublishedCeiling(8_192, 100, { code: 'en' })
  assert.equal(large.batch, 11)
  assert.equal(large.budget, 8_064)
})

test('Khmer without a measurement keeps the English estimate and says so visibly', () => {
  const sizing = ideaBatchForPublishedCeiling(8_192, 100, { code: 'km' })
  assert.equal(sizing.batch, 11, 'no invented reduction')
  assert.equal(sizing.budget, 8_064)
  assert.equal(sizing.language_basis.code, 'km')
  assert.equal(sizing.language_basis.measured, false)
  assert.match(sizing.language_basis.note, /no measured answer cost/)
})

test('a measured Khmer answer cost shrinks the batch, never below one silent truncation', () => {
  const sizing = ideaBatchForPublishedCeiling(8_192, 100, { code: 'km', measuredTokensPerIdea: 1_200 })
  assert.equal(sizing.batch, 5, '7,168 usable tokens ÷ 1,200')
  assert.equal(sizing.budget, 7_024)
  assert.equal(sizing.budget, resolveOutputTokenBudget(
    { tier: 'workload', minimumTokens: ideaOutputTokenBudgetFor(5, 1_200) }, 8_192,
  ), 'the preview carries exactly this max_completion_tokens')
  assert.equal(sizing.language_basis.measured, true)
  assert.match(sizing.language_basis.note, /measured 1200-token answer/)
})

test('a ceiling that cannot hold one measured idea refuses instead of truncating', () => {
  const sizing = ideaBatchForPublishedCeiling(4_096, 100, { code: 'km', measuredTokensPerIdea: 4_000 })
  assert.equal(sizing.source, 'cannot_fit_one_idea')
  assert.equal(sizing.batch, null)
  assert.equal(sizing.budget, 4_096, 'the published ceiling, not a guessed allowance')
})

test('an unknown language is named and keeps the safe English estimate', () => {
  const sizing = ideaBatchForPublishedCeiling(8_192, 100, { code: 'fr' })
  assert.equal(sizing.batch, 11)
  assert.equal(sizing.language_basis.code, null)
  assert.match(sizing.language_basis.note, /Unknown content language "fr"/)
})

test('language changes the allowance, never the model eligibility path', () => {
  // The helper takes a published ceiling and a count; it has no model argument to filter on.
  const en = ideaBatchForPublishedCeiling(8_192, 100, { code: 'en' })
  const km = ideaBatchForPublishedCeiling(8_192, 100, { code: 'km' })
  assert.equal(en.batch, km.batch, 'same ceiling, same count while no measurement exists')
  assert.equal(en.budget, km.budget)
  assert.equal(ideaBatchForPublishedCeiling(8_192, 100).batch, en.batch, 'no language is the English path')
})
