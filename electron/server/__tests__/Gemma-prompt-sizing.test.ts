/**
 * Brief G — Gemma token-level sizing of scene and motion prompt work
 * (owner 2026-11-02; G0 measurements 2026-11-02).
 *
 * Holds shut the three gaps this batch closes:
 *   1. the measured per-unit answer rates (visual / thumbnail, en / km)
 *      are what the request sizer uses — not one pessimistic 300 for all;
 *   2. `maximum` callers size against the published REQUEST limit as well
 *      as the answer and window (a long prompt near 23,000 refuses);
 *   3. image-prompts (thumbnail packs) wires the same sizing function
 *      against the writing model's live limits.
 *
 * Gemma-4 as the Gateway publishes it: 23,000 request + 8,192 answer in a
 * 32,768 window. Never inferred from the name — these are the published
 * figures the test pins.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, test } from 'node:test'
import {
  SCENE_PROMPT_MEASURED_TOKENS_PER_UNIT,
  describeSceneRequestLimits,
  resolveSceneUnitTokenRates,
  sceneRequestFits,
  packSceneRequestGroups,
} from '../services/scene-prompt-batching.js'

const GEMMA = { maxRequestTokens: 23_000, contextWindowTokens: 32_768, maxOutputTokens: 8_192 }

describe('Gemma prompt sizing: measured per-unit rates', () => {
  test('thumbnail rates are the G0 measured figures, by language', () => {
    assert.deepEqual(resolveSceneUnitTokenRates('thumbnail', 'en'), { perUnit: 2_350, singleUnit: 2_350 })
    assert.deepEqual(resolveSceneUnitTokenRates('thumbnail', 'km'), { perUnit: 1_750, singleUnit: 1_750 })
    // Rates are chosen by the REQUEST's channel language (Brief G), never
    // relabelled as the output language: a Khmer channel is sized by the 'km'
    // rate even though its image prose comes back in English. No language on
    // the request falls back to the en measured rate.
    assert.deepEqual(resolveSceneUnitTokenRates('thumbnail', null), { perUnit: 2_350, singleUnit: 2_350 })
  })

  test('visual and motion rates keep their own measured/unmeasured values', () => {
    assert.deepEqual(resolveSceneUnitTokenRates('visual', 'en'), { perUnit: 550, singleUnit: 1_550 })
    assert.deepEqual(resolveSceneUnitTokenRates('visual', 'km'), { perUnit: 400, singleUnit: 400 })
    // Motion and planner windows have no stored calls — unmeasured, labelled.
    assert.deepEqual(resolveSceneUnitTokenRates('motion', 'en'), { perUnit: 300, singleUnit: 300 })
    assert.deepEqual(resolveSceneUnitTokenRates('planner-window', 'en'), { perUnit: 300, singleUnit: 300 })
    // The owner's existing key still overrides every kind.
    assert.deepEqual(resolveSceneUnitTokenRates('thumbnail', 'en', 900), { perUnit: 900, singleUnit: 900 })
    assert.equal(SCENE_PROMPT_MEASURED_TOKENS_PER_UNIT.thumbnail.en.perUnit, 2_350)
  })
})

describe('Gemma prompt sizing: request + answer, not answer alone', () => {
  test('a thumbnail pack of 3 fits Gemma; 5 does not and must split', () => {
    // 3 × 2,350 = 7,050 answer tokens ≤ 8,192 published ceiling.
    const three = sceneRequestFits({
      promptCharacters: 12_000, // 3,000 tokens of instructions
      answerTokens: 3 * 2_350,
      limits: GEMMA,
    })
    assert.equal(three.fits, true)
    // 5 × 2,350 = 11,750 > 8,192 — refused by the ANSWER ceiling.
    const five = sceneRequestFits({
      promptCharacters: 12_000,
      answerTokens: 5 * 2_350,
      limits: GEMMA,
    })
    assert.equal(five.fits, false)
    assert.equal(five.refusedBy, 'answer')
  })

  test('a long prompt near 23,000 refuses by the REQUEST limit before any call', () => {
    // The input side is an ESTIMATE — ASCII ÷ 4 plus one token per non-ASCII
    // character; no tokenizer or count endpoint exists (output-token-budget.ts).
    // 91,996 ASCII chars ≈ 22,999 estimated tokens — fits the request ceiling…
    const near = sceneRequestFits({
      promptCharacters: 91_996,
      answerTokens: 1_550,
      limits: GEMMA,
    })
    assert.equal(near.fits, true)
    // …one more estimated token of prompt crosses it (92,004 ÷ 4 = 23,001).
    // This is the shape that failed on Gemma when only the answer side was sized.
    const over = sceneRequestFits({
      promptCharacters: 92_004,
      answerTokens: 1_550,
      limits: GEMMA,
    })
    assert.equal(over.fits, false)
    assert.equal(over.refusedBy, 'request')
    assert.equal(over.promptTokens, 23_001)
  })

  test('an unpublished limit is unknown and enforces nothing', () => {
    const open = sceneRequestFits({
      promptCharacters: 10_000_000,
      answerTokens: 500_000,
      limits: { maxRequestTokens: null, contextWindowTokens: null, maxOutputTokens: null },
    })
    assert.equal(open.fits, true)
    assert.equal(open.refusedBy, null)
    assert.equal(
      describeSceneRequestLimits({ maxRequestTokens: null, contextWindowTokens: null, maxOutputTokens: null }),
      'no published request limit, no published context window, no published answer ceiling',
    )
  })

  test('a big model gets the whole pack; the refusal names model figures', () => {
    const big = { maxRequestTokens: 500_000, contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 }
    const packed = packSceneRequestGroups({
      items: Array.from({ length: 40 }, (_, index) => index),
      maxUnitsPerGroup: 40,
      rates: resolveSceneUnitTokenRates('thumbnail', 'en'),
      limits: big,
      buildPrompt: () => ({ characters: 40_000 }),
    })
    assert.equal(packed.refused, null)
    assert.deepEqual(packed.groups.map(group => group.length), [40])
    // One unfittable unit refuses with the published figures in the message.
    const refused = packSceneRequestGroups({
      items: [1],
      maxUnitsPerGroup: 1,
      rates: resolveSceneUnitTokenRates('thumbnail', 'en'),
      limits: GEMMA,
      buildPrompt: () => ({ characters: 100_000 }), // 25,000 tokens > 23,000
    })
    assert.equal(refused.groups.length, 0)
    assert.equal(refused.refused?.refusedBy, 'request')
    assert.equal(refused.refused?.units, 0)
    assert.match(
      describeSceneRequestLimits(GEMMA),
      /23,000-token request limit, 32,768-token context window, 8,192-token answers/,
    )
  })

  test('Khmer assembly counts non-ASCII characters as whole tokens', () => {
    // 5,000 Khmer characters ≈ 5,000 tokens under the estimate — far more
    // than an ASCII ÷4 reading of the same length would claim.
    const km = sceneRequestFits({
      promptCharacters: 5_000,
      promptNonAsciiCharacters: 5_000,
      answerTokens: 1_750,
      limits: GEMMA,
    })
    assert.equal(km.promptTokens, 5_000)
    assert.equal(km.fits, true)
  })
})

describe('Gemma prompt sizing: the maximum callers are wired', () => {
  const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

  test('scene-planner sizes each window against the assembled prompt', () => {
    const planner = read('../services/scene-planner.ts')
    assert.match(planner, /sceneRequestFits\(\{/)
    assert.match(planner, /maxRequestTokens: opts\.max_request_tokens/)
    // It must not ask for a raw 'maximum' without the fit check above it.
    assert.match(planner, /outputBudget: 'maximum'/)
  })

  test('image-prompts packs thumbnail requests with the shared sizing', () => {
    const generator = read('../generators/image-prompts.ts')
    assert.match(generator, /resolveSceneUnitTokenRates\('thumbnail'/)
    assert.match(generator, /sceneRequestFits\(\{/)
    // The catalogue read uses the file's own key resolution and is NOT
    // swallowed: a transport failure must stop the run before any provider
    // request, not turn a known model's limits into an unbounded {}.
    assert.match(generator, /getApiKey\('genstudio'\)/)
    assert.match(generator, /listChatModels\(apiKey\)/)
    assert.doesNotMatch(generator, /listChatModels\(apiKey\)\.catch/)
    assert.match(generator, /describeSceneRequestLimits\(writingLimits\)/)
    // No fixed token-to-character ratio appears in the sizing path.
    assert.doesNotMatch(generator, /tokensPerScene\s*[:=]\s*\d/)
  })

  test('chunked-narration bounds expansion output through the one rule', () => {
    const narration = read('../lib/chunked-narration.ts')
    assert.match(narration, /boundOutputTokensToContext\(/)
    assert.match(narration, /budget\.maxRequestTokens/)
  })
})
