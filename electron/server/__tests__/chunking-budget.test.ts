/**
 * The chunking budget tracks the SELECTED PRODUCT, not a retired constant.
 *
 * THE BUG THIS GUARDS: `CHUNK_THRESHOLD_WORDS = 9000` and
 * `STREAMING_OUTPUT_TOKEN_CAP = 16_000` were both calibrated for streaming
 * Anthropic, pre-GenStudio — the comment on the constant said so, and the
 * comment on the cap said "if we ever switch to a model with a different cap,
 * pass the actual cap to shouldChunkByBudget instead". We switched: the
 * current default product publishes `max_output_tokens: 128_000`, eight times
 * the hardcoded number. Chunking a run at 9,000 words against a 128,000-token
 * product splits work the model could write in far fewer calls, and every
 * extra call is another chance to hit GenStudio backpressure mid-run — the
 * failure that lost 15 of 18 chapters when one batch hit a rate limit.
 *
 * It is also the "no static 200K context / 32K output / 500K-character /
 * model-name-based limit anywhere in Story Studio" rule that removed the
 * Scene Plan 32,768 ceiling in v1.0.766.
 *
 * ZERO paid calls: every number here is computed locally.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  EXPANSION_BATCH_WORDS_DEFAULT,
  EXPANSION_CHAPTERS_MAX,
  chaptersPerExpansionRequest,
  chunkingOutputBudget,
  chunkingSafetyMarginTokens,
  chunkingTriggerLine,
  chunkThresholdWords,
  CHUNK_THRESHOLD_WORDS,
  defaultExpansionBatchSetting,
  expansionOutputTokenCap,
  expansionRequestOutputBudget,
  planExpansionGroups,
  shouldChunkByBudget,
  type ChunkingBudget,
  type ExpansionBatchSetting,
  type OutlineEntry,
} from '../lib/chunked-narration.js'
import { expectedOutputTokensFor, resolveOutputTokenBudget } from '../services/output-token-budget.js'

/** The current default product's published output allowance. */
const LUNA_OUTPUT_TOKENS = 128_000
/** The retired streaming-Anthropic cap the old constants were derived from. */
const LEGACY_OUTPUT_TOKENS = 16_000

function budget(
  outputTokenCap: number | null,
  productName: string | null = 'GPT-5.6 Luna',
  contextWindowTokens: number | null = null,
  maxRequestTokens: number | null = null,
): ChunkingBudget {
  return {
    outputTokenCap,
    contextWindowTokens,
    maxRequestTokens,
    thresholdWords: chunkThresholdWords(outputTokenCap),
    productId: productName ? 'gpt-5-6-luna' : null,
    productName,
  }
}

/** `chunkThresholdWords` returns null when nothing was published. Every call in
 *  the tests below passes a real published cap, so unwrap once here rather than
 *  sprinkling non-null assertions through the assertions. */
function threshold(outputTokenCap: number): number {
  const words = chunkThresholdWords(outputTokenCap)
  assert.ok(words !== null, `expected a threshold for a published cap of ${outputTokenCap}`)
  return words
}

// ── The threshold tracks the product ─────────────────────────────────────

test('the chunking threshold is derived from the product, not from a constant', () => {
  const legacy = threshold(LEGACY_OUTPUT_TOKENS)
  const luna = threshold(LUNA_OUTPUT_TOKENS)

  // Two products with different published ceilings must produce two different
  // thresholds — that is the whole point of deriving rather than hardcoding.
  assert.notEqual(legacy, luna)
  assert.ok(luna > legacy * 5, `128k should not chunk near the 16k threshold (${legacy} → ${luna})`)

  // At the legacy cap the derived number is 12,500 usable tokens ÷ the
  // tokens-per-word estimate. Pinned exactly, like the idempotency keys: the
  // estimate is an input to this figure, so changing it (1.3 → 1.6, 2026-09-26,
  // on measured evidence) must show up here as a decision rather than a drift.
  assert.equal(legacy, 7_812, `legacy threshold drifted to ${legacy}`)

  // A smaller product lowers the threshold instead of pretending it can write
  // as much as the old streaming cap could.
  assert.ok(threshold(8_192) < legacy)
  assert.ok(threshold(4_096) < threshold(8_192))

  // Monotonic in the product limit, with no ceiling of its own.
  let previous = 0
  for (const cap of [2_048, 4_096, 16_000, 32_768, 128_000, 1_000_000]) {
    const derived = threshold(cap)
    assert.ok(derived > previous, `threshold did not grow at ${cap}`)
    previous = derived
  }
})

test('an unpublished product limit yields NO number, not an invented one', () => {
  // v1.0.786 — this test used to assert the opposite: that a missing limit
  // "degrades to exactly the old behaviour", i.e. to a 16,000-token constant.
  // That constant was an invented ceiling. It reached the owner's job log as
  // "using the 16,000-token fallback", which reads exactly like a figure
  // GenStudio published for the model, and an output ceiling is the one number
  // where guessing LOW truncates a chapter mid-sentence and bills for the
  // stump. AGENTS.md: no published value → fail loudly or show nothing.
  for (const missing of [undefined, null, 0, -1, 1.5, Number.NaN, 'lots' as unknown as number]) {
    assert.equal(chunkingOutputBudget(missing), null, `invented a budget for ${String(missing)}`)
    assert.equal(chunkThresholdWords(missing), null, `invented a threshold for ${String(missing)}`)
  }
  // A published cap still produces a real number — the rule is "never invent",
  // not "never compute".
  assert.equal(chunkingOutputBudget(LUNA_OUTPUT_TOKENS), LUNA_OUTPUT_TOKENS)
  // The legacy constant survives only as documentation of where the retired
  // streaming threshold came from. Nothing computes from it any more.
  assert.equal(CHUNK_THRESHOLD_WORDS, 9_000)
})

test('with no published cap the run still proceeds — chunked, and saying nothing it cannot know', () => {
  // NEVER A DEAD END. Losing the product must not stop an expansion; the very
  // next call surfaces GenStudio's own reason if the product is genuinely
  // gone. So: chunk (the safe side of an unknown, and the side that keeps
  // per-chapter resume), and keep the mode's own batch size rather than
  // deriving one from a number nobody published.
  assert.equal(
    shouldChunkByBudget({ systemPromptChars: 500, userPromptChars: 500, targetWords: 200 }),
    true,
    'an unknown budget must take the resumable path, not the one-shot path',
  )
  // And no request is shrunk from a number nobody published: the cap is
  // `null`, which means "send no ceiling at all", never a stand-in figure.
  assert.equal(expansionOutputTokenCap(budget(null, null), 4_000), null)
  assert.deepEqual(expansionRequestOutputBudget(budget(null, null), 4_000), { outputBudget: 'maximum' })
})

test('headroom stays proportional instead of being another fixed number', () => {
  // The original reasoning — tokenizer drift, JSON nesting, stop-token
  // handling — is sound; a fixed 1,500 tokens is ~9% of a 16k budget and ~1%
  // of a 128k one, so it stops being headroom exactly where output is largest.
  assert.equal(chunkingSafetyMarginTokens(LEGACY_OUTPUT_TOKENS), 1_500)
  assert.ok(chunkingSafetyMarginTokens(LUNA_OUTPUT_TOKENS) > 10_000)
  // The old value is a FLOOR, so small products keep every bit of protection.
  assert.equal(chunkingSafetyMarginTokens(4_096), 1_500)
  assert.equal(chunkingSafetyMarginTokens(1_000), 1_500)
})

// ── The run that started this ────────────────────────────────────────────

test('an 18 × ~700-word run fits a 128,000-token product but not a 16,000-token one', () => {
  const targetWords = 18 * 700 // 12,600
  const prompts = { systemPromptChars: 8_000, userPromptChars: 4_000 }

  // Before: measured against the hardcoded 16,000 cap, this run "had" to be
  // split even though the product that would write it publishes 128,000.
  assert.equal(
    shouldChunkByBudget({ ...prompts, targetWords, outputTokenCap: LEGACY_OUTPUT_TOKENS }),
    true,
    'a 16,000-token product genuinely cannot write 12,600 words in one call',
  )
  // After: the same run against the product that will actually execute it.
  assert.equal(
    shouldChunkByBudget({ ...prompts, targetWords, outputTokenCap: LUNA_OUTPUT_TOKENS }),
    false,
    'a 128,000-token product must not be told it needs chunking',
  )
  assert.ok(targetWords > threshold(LEGACY_OUTPUT_TOKENS))
  assert.ok(targetWords < threshold(LUNA_OUTPUT_TOKENS))
})

test('a genuinely huge run still chunks on the largest product', () => {
  // The point is not "never split" — it is "do not split what this model can
  // write in fewer calls". A 200,000-word run still splits on a 128k product.
  assert.equal(
    shouldChunkByBudget({
      systemPromptChars: 8_000,
      userPromptChars: 4_000,
      targetWords: 200_000,
      outputTokenCap: LUNA_OUTPUT_TOKENS,
    }),
    true,
  )
  assert.ok(200_000 > threshold(LUNA_OUTPUT_TOKENS))
})

// ── Batch behaviour once chunking IS triggered ───────────────────────────

test('with no setting, each mode keeps the exact number it always used', () => {
  // "Default = today's value" (owner, 2026-10-25). Narrative's 3 is a
  // transition-coherence choice and listicle's 8 a round-trip one; neither is
  // derived from any token figure, so no product's cap may change them.
  const none = defaultExpansionBatchSetting()
  assert.equal(none.mode, 'count')
  assert.equal(none.chapters, null, 'unset means "this mode\'s own default", not a number to invent')
  for (const mode of ['narrative', 'listicle'] as const) {
    assert.equal(chaptersPerExpansionRequest(none, mode), mode === 'listicle' ? 8 : 3)
  }
})

test('the chapter count a run asks for is the channel\'s number, clamped to a sane range', () => {
  const fixed = (chapters: number): ExpansionBatchSetting => ({ ...defaultExpansionBatchSetting(), chapters })
  assert.equal(chaptersPerExpansionRequest(fixed(1), 'narrative'), 1)
  assert.equal(chaptersPerExpansionRequest(fixed(5), 'narrative'), 5)
  assert.equal(chaptersPerExpansionRequest(fixed(5), 'listicle'), 5, 'the setting outranks the mode default')
  assert.equal(chaptersPerExpansionRequest(fixed(EXPANSION_CHAPTERS_MAX), 'listicle'), EXPANSION_CHAPTERS_MAX)
  assert.equal(chaptersPerExpansionRequest(fixed(400), 'listicle'), EXPANSION_CHAPTERS_MAX, 'a typo is clamped, not obeyed')
  assert.equal(chaptersPerExpansionRequest(fixed(0), 'narrative'), 3, '0 means "unset"')
  assert.equal(chaptersPerExpansionRequest(fixed(-2), 'narrative'), 3)
})

test('the concurrency and mode mechanics are untouched', () => {
  // Sequential-with-transition-glue for narrative, parallel-with-semaphore-4
  // for listicle: the migration changed the BUDGET, not the orchestration.
  const source = readFileSync(fileURLToPath(new URL('../lib/chunked-narration.ts', import.meta.url)), 'utf8')
  assert.match(source, /const NARRATIVE_BATCH_SIZE = 3/)
  assert.match(source, /const LISTICLE_BATCH_SIZE = 8/)
  assert.match(source, /const LISTICLE_CONCURRENCY = 4/)
})

// ── The log line an owner reads instead of the code ──────────────────────

test('the chunked log states the total, the budget, and whose limit it is', () => {
  const line = chunkingTriggerLine(
    { totalChapters: 18, wordsPerChapter: 700, model: 'genstudio-chat:gpt-5-6-luna' },
    budget(LUNA_OUTPUT_TOKENS),
  )
  // The computed total…
  assert.match(line, /18 × ~700 words ≈ 12,600 words/)
  // …the derived budget it was measured against…
  assert.match(line, /within the ~[\d,]+-word single-call budget/)
  // …and which product published that limit.
  assert.match(line, /GPT-5\.6 Luna \(128,000 output tokens\)/)

  const small = chunkingTriggerLine(
    { totalChapters: 18, wordsPerChapter: 700, model: 'genstudio-chat:tiny' },
    budget(LEGACY_OUTPUT_TOKENS, 'Tiny Writer'),
  )
  assert.match(small, /over the ~[\d,]+-word single-call budget/)
  assert.match(small, /Tiny Writer \(16,000 output tokens\)/)

  // An unreadable catalogue says so rather than naming a product — or a
  // number — it invented. The old line ended "using the 16,000-token
  // fallback", which an owner reads as the model's own published ceiling.
  const unknown = chunkingTriggerLine(
    { totalChapters: 4, wordsPerChapter: 500, model: 'genstudio-chat:mystery' },
    budget(null, null),
  )
  assert.match(unknown, /no published output limit for "genstudio-chat:mystery"/)
  assert.match(unknown, /states no budget of its own/)
  assert.doesNotMatch(unknown, /16,000/, 'the retired fallback must not reappear in the log')
  assert.doesNotMatch(unknown, /\bfallback\b/i)
  // No word threshold is claimed either, since none could be derived.
  assert.match(unknown, /measured against no single-call budget/)
})

// ── One expansion request asks for the model's own published cap ───────────
//
// THE PRODUCTION DEFECT THIS GUARDS (2026-10-25, Komsan, Khmer). Expansion
// used to size its request with a words→tokens ESTIMATE — 2.5 tokens per word,
// +2,048 overhead, floored at 8,192 — so a 2-chapter Khmer batch asked for
// exactly 8,192 tokens even though the selected product publishes 128,000. The
// provider stopped at 8,192 with `finish_reason: max_tokens`, and jobs
// 38ca3df6 / 862fed60 / b2bc6196 / ec973e7a came back with zero chapters.
//
// Khmer is written without spaces between words, so a "word" is a whole clause
// and tokenises several times heavier than an English one. No words→tokens
// ratio can be safe for every script, which is why AGENTS.md §1 forbids turning
// a token budget into a word limit with one. The request now asks for
// everything the product publishes, bounded only by the same product's own
// published context window.

function entries(count: number, wordsPerChapter?: number): OutlineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    title: `Chapter ${i + 1}`,
    ...(wordsPerChapter ? { words_per_chapter: wordsPerChapter } : {}),
  }))
}

/** A Khmer 2-chapter batch, as Komsan ran it: ~600-word chapters, ~14k
 *  characters of prompt (the outline and the style rules are long). */
const KHMER_BATCH_PROMPT_CHARACTERS = 14_000

test('a Khmer multi-chapter request asks for the model\'s whole published cap', () => {
  const request = expansionRequestOutputBudget(budget(LUNA_OUTPUT_TOKENS), KHMER_BATCH_PROMPT_CHARACTERS)
  assert.equal(request.outputBudget, 'maximum')
  assert.equal(request.maxTokens, LUNA_OUTPUT_TOKENS)

  // The exact failure: the old arithmetic asked for 8,192 (the floor) for
  // chapters that needed far more. If someone restores a ratio or a floor,
  // this is the assertion that fails.
  assert.ok(request.maxTokens! > 8_192, 'the request went back to a ratio-sized stump')
  assert.notEqual(request.maxTokens, 14_080, 'the 2.5-tokens-per-word figure is back')
})

test('a SINGLE Khmer chapter is not capped at 8,192 either', () => {
  // Job 0857b744 (2026-10-25) truncated Chapter 7 of KOM0003 at 8,192 — the
  // single-chapter repair path had its own fixed ceiling, so it inherited the
  // same defect. One chapter may need more than 8,192 Khmer tokens.
  const oneChapter = expansionOutputTokenCap(budget(LUNA_OUTPUT_TOKENS), KHMER_BATCH_PROMPT_CHARACTERS)
  assert.equal(oneChapter, LUNA_OUTPUT_TOKENS)
  assert.ok(oneChapter! > 8_192)
})

test('no expansion request is ever sized from words', () => {
  // 8 × 600 words and 1 × 600 words must ask for the SAME number: the cap comes
  // from the product, not from the work.
  const many = expansionOutputTokenCap(budget(LUNA_OUTPUT_TOKENS), KHMER_BATCH_PROMPT_CHARACTERS)
  const few = expansionOutputTokenCap(budget(LUNA_OUTPUT_TOKENS), KHMER_BATCH_PROMPT_CHARACTERS)
  assert.equal(many, few)
  // And the constants the old estimate was built from are gone, not deprecated.
  const source = readFileSync(fileURLToPath(new URL('../lib/chunked-narration.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /BUDGET_TOKENS_PER_WORD/)
  assert.doesNotMatch(source, /BUDGET_OVERHEAD_TOKENS/)
  assert.doesNotMatch(source, /BUDGET_FLOOR_TOKENS/)
  assert.doesNotMatch(source, /SINGLE_CHAPTER_REPAIR_OUTPUT_TOKENS/)
  // Neither the request nor the group size is computed from a words→tokens
  // figure any more (this also pins that `batchSizeForBudget`, which divided
  // the cap by `words × 1.6`, is not back).
  assert.doesNotMatch(source, /wordsPerChapter \* OUTPUT_TOKENS_PER_WORD/)
  assert.doesNotMatch(source, /words \* BUDGET/)
})

test('the product\'s published context window is the only thing that may lower it', () => {
  // output ≤ min(max_output_tokens, context_window − prompt tokens), using
  // published figures only. 4,000 characters of prompt ≈ 1,000 tokens.
  assert.equal(
    expansionOutputTokenCap(budget(LUNA_OUTPUT_TOKENS, 'Local Writer', 32_768), 4_000),
    32_768 - 1_000,
  )
  // A published window larger than the output cap changes nothing.
  assert.equal(
    expansionOutputTokenCap(budget(LUNA_OUTPUT_TOKENS, 'Local Writer', 200_000), 4_000),
    LUNA_OUTPUT_TOKENS,
  )
  // No published window = nothing to subtract, so the cap stands.
  assert.equal(expansionOutputTokenCap(budget(LUNA_OUTPUT_TOKENS), 4_000), LUNA_OUTPUT_TOKENS)
})

test('a prompt that cannot fit the published window fails loudly instead of asking for one token', () => {
  const tiny = budget(LUNA_OUTPUT_TOKENS, 'Tiny Window', 2_000)
  assert.throws(
    () => expansionOutputTokenCap(tiny, 40_000),
    /leaves no room inside Tiny Window's published 2,000-token context window/,
  )
  assert.throws(() => expansionOutputTokenCap(tiny, 40_000), /Nothing was requested/)
})

test('the Gateway\'s published request ceiling refuses an oversized prompt, alone', () => {
  // gemma-4's curated figures: 8,192-token answer, 23,000-token request,
  // 32,768-token window. 92,000 ASCII characters ≈ 23,000 tokens.
  const gemma = budget(8_192, 'Gemma 4', 32_768, 23_000)
  assert.equal(expansionOutputTokenCap(gemma, 80_000), 8_192, 'a prompt inside the request line leaves the answer alone')
  assert.throws(
    () => expansionOutputTokenCap(gemma, 92_004),
    /about 23,001 tokens, and Gemma 4 publishes a 23,000-token request limit/,
  )
  assert.throws(() => expansionOutputTokenCap(gemma, 92_004), /Nothing was requested/)
  // Unpublished request ceiling: nothing is enforced, and no number is invented.
  assert.equal(expansionOutputTokenCap(budget(8_192, 'Gemma 4', 32_768, null), 92_004), 8_192)
})

test('the expansion request states a ceiling, never an expected answer length', () => {
  // `workload`'s `minimumTokens` is also what Studio Hub sizes a job deadline
  // from: putting the whole 128,000-token ceiling there would make every
  // chapter batch a four-hour job. `maximum` says only what MAY be sent.
  const request = expansionRequestOutputBudget(budget(LUNA_OUTPUT_TOKENS), KHMER_BATCH_PROMPT_CHARACTERS)
  assert.equal(expectedOutputTokensFor(request.outputBudget), null)
  // Still a real ceiling: it resolves to a number the product publishes.
  assert.equal(resolveOutputTokenBudget(request.outputBudget, LUNA_OUTPUT_TOKENS), LUNA_OUTPUT_TOKENS)
})

// ── Chapters per request: the owner's two grouping modes ──────────────────

test('fixed mode groups by the channel\'s number, consecutively', () => {
  const setting: ExpansionBatchSetting = { ...defaultExpansionBatchSetting(), chapters: 2 }
  const groups = planExpansionGroups(entries(5), setting, 600, 'narrative')
  assert.deepEqual(groups.map(g => g.map(e => e.n)), [[1, 2], [3, 4], [5]])
  const fives = planExpansionGroups(entries(11), { ...setting, chapters: 5 }, 600, 'narrative')
  assert.deepEqual(fives.map(g => g.map(e => e.n)), [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11]])
})

test('by-length mode groups consecutive chapters up to the word budget', () => {
  // 600-word chapters, a 1,800-word budget → three of them ride together.
  const setting: ExpansionBatchSetting = { mode: 'length', chapters: null, words: 1_800 }
  const groups = planExpansionGroups(entries(7), setting, 600, 'narrative')
  assert.deepEqual(groups.map(g => g.map(e => e.n)), [[1, 2, 3], [4, 5, 6], [7]])
})

test('a chapter longer than the whole budget goes alone', () => {
  const setting: ExpansionBatchSetting = { mode: 'length', chapters: null, words: 1_800 }
  const outline: OutlineEntry[] = [
    { n: 1, title: 'One' },
    { n: 2, title: 'Two', words_per_chapter: 2_500 },
    { n: 3, title: 'Three' },
  ]
  const groups = planExpansionGroups(outline, setting, 600, 'narrative')
  // Chapter 2 is past the budget on its own, so it neither shares a request nor
  // drags chapter 1 or 3 over the budget with it. A chapter is never split.
  assert.deepEqual(groups.map(g => g.map(e => e.n)), [[1], [2], [3]])
})

test('by-length mode uses each chapter\'s own target, not the run-wide average', () => {
  const setting: ExpansionBatchSetting = { mode: 'length', chapters: null, words: 1_000 }
  const outline: OutlineEntry[] = [
    { n: 1, title: 'One', words_per_chapter: 700 },
    { n: 2, title: 'Two', words_per_chapter: 700 },
    { n: 3, title: 'Three', words_per_chapter: 150 },
  ]
  const groups = planExpansionGroups(outline, setting, 600, 'narrative')
  // 700 + 700 > 1,000, so chapter 2 starts a new request; 150 still fits after it.
  assert.deepEqual(groups.map(g => g.map(e => e.n)), [[1], [2, 3]])
})

test('the two modes and their defaults are the owner\'s reusable setting', () => {
  assert.equal(EXPANSION_BATCH_WORDS_DEFAULT, 1_800)
  const setting = defaultExpansionBatchSetting()
  assert.equal(setting.mode, 'count', 'the default grouping is a chapter count')
  assert.equal(setting.words, EXPANSION_BATCH_WORDS_DEFAULT)
  // Both modes cover every pending chapter exactly once, in outline order.
  for (const candidate of [setting, { mode: 'length' as const, chapters: null, words: 900 }]) {
    const groups = planExpansionGroups(entries(9), candidate, 600, 'narrative')
    assert.deepEqual(groups.flat().map(e => e.n), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  }
})
