/**
 * The no-Formula prompt: a suggestion, a full choice, and a deliberate Generic.
 *
 * Owner ruling, 2026-10-25. The prompt is not dismissable until a choice is
 * made; it suggests a match but NEVER assigns one, and choosing Generic settles
 * it for good.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { suggestFormulaForChannel } from '../utils/formula-suggestion.js'

const banner = readFileSync(new URL('../components/NicheMissingBanner.vue', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')

test("the owner's named channels suggest the Formula he chose", () => {
  const expected: Record<string, string> = {
    'night-atlas-nature': 'com.storystudio.formula.sleep-history-compilation',
    'wonder-in-ink': 'com.storystudio.formula.counted-explainer',
    'domnak-kmouch': 'com.storystudio.formula.khmer-folk-horror',
    pronom: 'com.storystudio.formula.khmer-folk-horror',
    'night-atlas-science': 'com.storystudio.formula.calm-science-for-sleep',
    'night-atlas-mythology': 'com.storystudio.formula.mythology-for-sleep',
  }
  for (const [slug, formulaId] of Object.entries(expected)) {
    assert.equal(suggestFormulaForChannel({ slug })?.formulaId, formulaId, slug)
  }
})

test('the suggestion is advisory and has a keyword fallback for future channels', () => {
  assert.equal(suggestFormulaForChannel({ slug: 'some-new-channel' }), null)
  assert.equal(
    suggestFormulaForChannel({ slug: 'unmapped', name: 'Quiet Cosmos Explained' })?.formulaId,
    'com.storystudio.formula.calm-science-for-sleep',
  )
  // A suggestion carries its reason so the prompt can say why.
  assert.ok(suggestFormulaForChannel({ slug: 'wonder-in-ink' })?.reason.length)
})

test('the prompt is not dismissable until a choice is made', () => {
  assert.doesNotMatch(banner, /sessionStorage/)
  assert.doesNotMatch(banner, /nmb-dismiss|Dismiss for this session/)
  assert.match(banner, /props\.formulaChoice !== 'generic'/)
  assert.match(banner, /!props\.nicheId/)
})

test('the prompt never assigns a Formula on its own', () => {
  // A suggestion is only a button; nothing writes until the customer clicks.
  assert.match(banner, /@click="applyFormula\(suggestion\.formulaId\)"/)
  assert.match(banner, /@click="applySelected"/)
  assert.match(banner, /@click="chooseGeneric"/)
  assert.doesNotMatch(banner, /watch\([^)]*suggestion[\s\S]{0,200}setProjectNiche/)
  // The Generic choice is recorded as the choice, not as another bare clear.
  assert.match(banner, /setProjectNiche\(props\.slug, null, \[\], 'generic'\)/)
})

test('the dashboard passes the choice state, and Settings remains the full editor', () => {
  assert.match(dashboard, /:formula-choice="project\.formula_choice"/)
  assert.match(dashboard, /:name="project\.name"/)
  assert.match(banner, /settings#channel/)
  assert.match(banner, /Series Formula/)
  // Mobile layout kept from the banner it replaces.
  assert.match(banner, /@media \(max-width: 560px\)/)
  assert.match(banner, /grid-template-columns: 24px minmax\(0, 1fr\) auto/)
  assert.match(banner, /grid-column: 1 \/ -1/)
})
