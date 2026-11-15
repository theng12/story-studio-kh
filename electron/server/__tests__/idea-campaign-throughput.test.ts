/**
 * Idea Campaign throughput.
 *
 * Owner rule (2026-10-18): abolish the fixed calls of ten. One request takes every remaining idea,
 * up to the 100-idea batch cap, whenever the selected product's published output ceiling permits;
 * a smaller ceiling takes exactly what it holds and the campaign comes back for the rest. Nothing
 * here is executed against a provider — every check is a pure-function assertion or a source pin.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  IDEA_BATCH_CAP,
  IDEA_BATCH_SCHEMA_HEADROOM_TOKENS,
  ideaBatchForPublishedCeiling,
  ideaOutputTokenBudget,
} from '../services/idea-output-budget.js'
import { resolveOutputTokenBudget } from '../services/output-token-budget.js'
import { COVERED_GROUPS, mergeCovered, renderCoveredBlock, type CoveredMap } from '../services/covered-topics.js'

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

function mapWith(subjects: number, others = 0): CoveredMap {
  return {
    schema: 1, formula_id: 'f', helper_model: 'm', built_at: '2026-01-01T00:00:00.000Z',
    covered_idea_ids: [],
    entries: {
      subjects: Array.from({ length: subjects }, (_, i) => ({ name: `subject ${i}`, count: subjects - i })),
      people: Array.from({ length: others }, (_, i) => ({ name: `person ${i}`, count: 1 })),
      places: [], eras: [], angles: [],
    },
  }
}

describe('capability-aware idea batch', () => {
  test('a 65,536-token ceiling takes all 100 remaining ideas in one request', () => {
    // count = floor((65,536 − 1,024) / 640) = 100; wire need = 100 × 640 + 1,024 = 65,024 ≤ 65,536.
    const sizing = ideaBatchForPublishedCeiling(65_536, 1_000)
    assert.equal(sizing.source, 'published_ceiling')
    assert.equal(sizing.batch, 100)
    assert.equal(sizing.budget, 65_024, 'the wire number is the batch’s own need, not half the ceiling')
  })

  test('smaller published ceilings take exactly what they hold', () => {
    // count = floor((ceiling − 1,024) / 640); the wire number is count × 640 + 1,024, clamped to the
    // ceiling by the resolver and raised to the historical floor only for a tiny request.
    const table: Array<[ceiling: number, batch: number, budget: number]> = [
      [32_768, 49, 32_384],
      [16_384, 24, 16_384],
      [8_192, 11, 8_064],
      [4_096, 4, 4_096], // the 4,096 floor raises this batch's 3,584 need to the whole ceiling
      [2_048, 1, 2_048], // ditto: 1,664 needed, the floor asks 4,096 and the resolver clamps to 2,048
    ]
    for (const [ceiling, batch, budget] of table) {
      const sizing = ideaBatchForPublishedCeiling(ceiling, 1_000)
      assert.equal(sizing.source, 'published_ceiling', `ceiling ${ceiling}`)
      assert.equal(sizing.batch, batch, `ceiling ${ceiling}`)
      assert.equal(sizing.budget, budget, `ceiling ${ceiling}`)
    }
  })

  test('the reported budget is the number the real request carries, and it supports the chosen count', () => {
    // The exact outputBudget both idea call paths pass for `batch` ideas, resolved by the same
    // resolver the request itself uses.
    for (const ceiling of [65_536, 32_768, 16_384, 8_192, 4_096, 2_048]) {
      const sizing = ideaBatchForPublishedCeiling(ceiling, 1_000)
      if (sizing.source !== 'published_ceiling') assert.fail(`ceiling ${ceiling}: got ${sizing.source}`)
      assert.equal(
        sizing.budget,
        resolveOutputTokenBudget({ tier: 'workload', minimumTokens: ideaOutputTokenBudget(sizing.batch) }, ceiling),
        `ceiling ${ceiling}: the reported budget is the resolved on-wire number`,
      )
      assert.ok(sizing.budget <= ceiling, `ceiling ${ceiling}: never above what the product publishes`)
      assert.ok(
        sizing.budget >= sizing.batch * 640 + IDEA_BATCH_SCHEMA_HEADROOM_TOKENS,
        `ceiling ${ceiling}: the wire allowance covers the count it was sized for`,
      )
    }
  })

  test('the batch never exceeds the 100-idea cap or what the campaign still needs', () => {
    assert.equal(ideaBatchForPublishedCeiling(65_536, 1_000).batch, 100, 'capped at 100')
    assert.equal(ideaBatchForPublishedCeiling(131_072, 1_000).batch, 100, 'a ceiling that holds 200 still sends at most 100')
    assert.equal(ideaBatchForPublishedCeiling(65_536, 3).batch, 3)
    assert.equal(ideaBatchForPublishedCeiling(65_536, 1).batch, 1)
    assert.equal(IDEA_BATCH_CAP, 100, 'the cap stays 100 — never 500')
  })

  test('zero remaining asks for zero — nothing is invented to send', () => {
    for (const ceiling of [65_536, 1_024, 0, null, undefined]) {
      const sizing = ideaBatchForPublishedCeiling(ceiling, 0)
      assert.equal(sizing.source, 'no_work_remaining', `ceiling ${String(ceiling)}`)
      assert.equal(sizing.batch, 0, `ceiling ${String(ceiling)}`)
      assert.equal(sizing.budget, null, `ceiling ${String(ceiling)}`)
    }
  })

  test('an unpublished ceiling attempts all remaining up to the cap with the wire field omitted', () => {
    // `null`, `undefined` and the catalogue's normalised `0` all mean "no published ceiling": the
    // resolver answers null, the client omits the token field, and the provider decides. No fixed
    // fallback batch replaces it.
    for (const absent of [0, null, undefined]) {
      const sizing = ideaBatchForPublishedCeiling(absent, 1_000)
      assert.equal(sizing.source, 'no_published_ceiling', `absent: ${String(absent)}`)
      assert.equal(sizing.batch, 100, `absent: ${String(absent)}: every remaining idea, up to the cap`)
      assert.equal(sizing.budget, null, `absent: ${String(absent)}`)
    }
    assert.equal(ideaBatchForPublishedCeiling(0, 4).batch, 4, 'still bounded by what is needed')
  })

  test('a present-but-malformed published figure fails loudly instead of reading as absence', () => {
    for (const malformed of [-1, 1.5, '4096', Number.NaN, Number.POSITIVE_INFINITY, true]) {
      assert.throws(
        () => ideaBatchForPublishedCeiling(malformed, 10),
        /malformed max_output_tokens/,
        `malformed: ${String(malformed)}`,
      )
    }
  })

  test('a ceiling too small for one complete idea is refused, not clamped into an impossible budget', () => {
    // 1,024 − 1,024 headroom leaves nothing for an object: a refusal with its numbers, not a batch of 1.
    const sizing = ideaBatchForPublishedCeiling(1_024, 10)
    if (sizing.source !== 'cannot_fit_one_idea') assert.fail(`expected a refusal, got ${sizing.source}`)
    assert.equal(sizing.batch, null)
    assert.equal(sizing.ceiling, 1_024)
    assert.equal(sizing.budget, 1_024, 'the wire number the request would carry is the whole ceiling')
  })

  test('one idea still fits at the smallest ceiling that can hold it', () => {
    assert.equal(ideaBatchForPublishedCeiling(1_664, 10).batch, 1, '1,024 headroom + one 640-token idea')
    assert.equal(ideaBatchForPublishedCeiling(2_048, 10).batch, 1)
  })

  test('the workload floor is the actual count’s need plus schema headroom, with no 16,384 cap', () => {
    assert.equal(ideaOutputTokenBudget(1), 4_096, 'the historical floor still raises a tiny request')
    assert.equal(ideaOutputTokenBudget(4), 4_096)
    assert.equal(ideaOutputTokenBudget(Number.NaN), 4_096)
    assert.equal(ideaOutputTokenBudget(10), 7_424, '10 × 640 + 1,024')
    assert.equal(ideaOutputTokenBudget(25), 17_024, 'the old 16,384 cap would have cut this')
    assert.equal(ideaOutputTokenBudget(26), 17_664, 'no count above 25 is cut down any more')
    assert.equal(ideaOutputTokenBudget(100), 65_024)
    assert.equal(ideaOutputTokenBudget(10_000), 65_024, 'the 100-idea cap still bounds the floor')
  })
})

describe('the campaign reads the capability live and fails loudly when it cannot resolve it', () => {
  const campaign = source('../generators/idea-campaign.ts')
  const freeform = source('../services/freeform-idea-generation.ts')
  const budgetModule = source('../services/idea-output-budget.ts')

  test('the count comes from the resolved live product, not a constant', () => {
    assert.match(campaign, /resolveLivePipelineModel\(request\.model, apiKey \? await listChatModels\(apiKey\) : \[\]\)\.max_output_tokens/)
    assert.match(campaign, /await ideaBatchForModel\(needed\)/)
    assert.doesNotMatch(campaign, /const batchSize = 10/)
    assert.doesNotMatch(campaign, /IDEA_BATCH_WORKLOAD_FALLBACK/)
    assert.doesNotMatch(campaign, /published = 0/, 'a failed catalogue read is never read as an absent ceiling')
  })

  test('the budget module imports the shared resolver it sizes with', () => {
    assert.match(budgetModule, /import \{ resolveOutputTokenBudget \} from '\.\/output-token-budget\.js'/)
    assert.doesNotMatch(budgetModule, /MAX_IDEA_FLOOR_TOKENS|IDEA_BATCH_WORKLOAD_FALLBACK/)
  })

  test('both actual call sites ask the published maximum and expect the count-sized floor', () => {
    assert.match(campaign, /outputBudget: \{ tier: 'maximum' \}/)
    assert.match(campaign, /expected_output_tokens: ideaOutputTokenBudget\(assignments\.length\)/)
    assert.match(campaign, /expected_output_tokens: ideaOutputTokenBudget\(count\)/)
    assert.match(freeform, /\?\? \{ tier: 'maximum' \}/)
    assert.match(freeform, /expectedOutputTokens: input\.expectedOutputTokens/)
  })

  test('a ceiling that cannot hold one idea raises an actionable failure naming the numbers', () => {
    assert.match(campaign, /does not fit in the \$\{sizing\.budget\} tokens that ceiling leaves for the answer/)
    assert.match(campaign, /Choose a product with a larger output limit in Settings, then press Retry\./)
  })

  test('the loop allowance is never smaller than the allowance the fixed ten had', () => {
    assert.match(campaign, /Math\.max\(4, Math\.ceil\(remaining \/ Math\.min\(firstBatch, 10\)\) \* 4\)/)
  })
})

describe('bounded covered-map helper prompt', () => {
  const covered = source('../services/covered-topics.ts')

  test('the helper is shown a capped view, so its prompt cannot grow with the whole history', () => {
    assert.match(covered, /CURRENT MAP: \$\{JSON\.stringify\(helperMapView\(map\)\)\}/)
    assert.match(covered, /for \(const group of COVERED_GROUPS\) view\[group\] = entries\[group\]\.slice\(0, OTHER_GROUP_CAP\)/)
  })

  test('the cap is a VIEW ceiling: the stored map keeps every entry and merges by name', () => {
    const stored = mapWith(120).entries
    const merged = mergeCovered(stored, { subjects: [{ name: 'subject 3', count: 2 }, { name: 'brand new', count: 1 }] })
    assert.equal(merged.subjects.length, 121, 'nothing stored is dropped by merging')
    assert.equal(merged.subjects.find(entry => entry.name === 'subject 3')!.count, 119, 'an existing name merges, counts add')
  })

  test('the deliberate rule that the IDEA prompt never drops a subject is preserved', () => {
    const block = renderCoveredBlock(mapWith(120), 'freeform')
    assert.match(block, /subject 0/)
    assert.match(block, /subject 119/, 'the idea prompt still shows every covered subject')
    assert.equal(renderCoveredBlock(null, 'freeform'), '', 'switched off leaves the prompt byte-identical')
  })

  test('every group is capped in the helper view, not only the non-subject ones', () => {
    assert.match(covered, /function helperMapView/)
    assert.match(covered, /const view = emptyEntries\(\)/)
    for (const group of COVERED_GROUPS) assert.ok(group, group)
  })
})
