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
  batchOutputBudget,
  batchOutputTokenEstimate,
  batchSizeForBudget,
  chunkingOutputBudget,
  chunkingSafetyMarginTokens,
  chunkingTriggerLine,
  chunkThresholdWords,
  CHUNK_THRESHOLD_WORDS,
  shouldChunkByBudget,
  type ChunkingBudget,
  type OutlineEntry,
} from '../lib/chunked-narration.js'
import { resolveOutputTokenBudget } from '../services/output-token-budget.js'

/** The current default product's published output allowance. */
const LUNA_OUTPUT_TOKENS = 128_000
/** The retired streaming-Anthropic cap the old constants were derived from. */
const LEGACY_OUTPUT_TOKENS = 16_000

function budget(outputTokenCap: number | null, productName: string | null = 'GPT-5.6 Luna'): ChunkingBudget {
  return {
    outputTokenCap,
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

  // At the legacy cap the derived number stays in the neighbourhood of the
  // documented 9,000, so nothing about small products silently changed.
  assert.ok(legacy >= 9_000 && legacy <= 10_000, `legacy threshold drifted to ${legacy}`)

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
  assert.equal(batchSizeForBudget('narrative', budget(null, null), 700), 3)
  assert.equal(batchSizeForBudget('listicle', budget(null, null), 700), 8)
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

test('narrative stays at 3 and listicle at 8 on every product that can hold them', () => {
  // Batch size is a coherence / rate-limit choice, not a token-cap one:
  // narrative's 3 exists to keep a smooth transition into chapter K+1. A
  // bigger product does not earn bigger batches by arithmetic alone.
  for (const cap of [LEGACY_OUTPUT_TOKENS, 32_768, LUNA_OUTPUT_TOKENS, 1_000_000]) {
    assert.equal(batchSizeForBudget('narrative', budget(cap), 700), 3, `narrative changed at ${cap}`)
    assert.equal(batchSizeForBudget('listicle', budget(cap), 700), 8, `listicle changed at ${cap}`)
  }
})

test('a product too small for the mode batch shrinks it rather than truncating', () => {
  // Asking a 4,096-token product for three 700-word chapters in one call is
  // how a batch comes back cut off mid-chapter. The budget may only ever
  // SHRINK a batch, and never below one chapter.
  assert.equal(batchSizeForBudget('listicle', budget(8_192), 700), 5)
  assert.equal(batchSizeForBudget('narrative', budget(4_096), 700), 1)
  assert.equal(batchSizeForBudget('narrative', budget(1_024), 5_000), 1)
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

// ── The batch reservation is sized from the WORK, not from the product ─────
//
// THE PROBLEM THIS SOLVES: an expansion batch declared `outputBudget:
// 'maximum'`, taking the selected product's entire published ceiling —
// 128,000 tokens — to generate roughly 8,000. GenStudio settles a language job
// on tokens actually GENERATED, so that never changed the final charge. What
// it did change is the up-front RESERVATION, which is held for the requested
// ceiling for as long as the job runs. A nearly-empty account could therefore
// be refused for a request that would have been cheap.

function entries(count: number, wordsPerChapter?: number): OutlineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    title: `Chapter ${i + 1}`,
    ...(wordsPerChapter ? { words_per_chapter: wordsPerChapter } : {}),
  }))
}

test('an 8 × 700-word batch asks for a sane figure, not the whole 128,000', () => {
  const request = batchOutputBudget(entries(8), 700)
  assert.equal(request.tier, 'workload')
  // 8 × 700 = 5,600 words × 2.5 tokens/word = 14,000, + 2,048 overhead,
  // rounded up to the 256 step.
  assert.equal(request.minimumTokens, 16_128)

  const resolved = resolveOutputTokenBudget(request, LUNA_OUTPUT_TOKENS)
  assert.equal(resolved, 16_128)
  // The point of the exercise: the reservation is a small fraction of what the
  // batch used to hold, while still being far more than it can generate.
  assert.ok(resolved < LUNA_OUTPUT_TOKENS * 0.15, `${resolved} is still most of the ceiling`)
})

test('the estimate is generous — under-requesting is what actually hurts', () => {
  // An 8 × 700 batch produces ~5,600 words. At the measured 1.3 output tokens
  // per English word that is ~7,280 tokens; the request is more than double
  // it, because a truncated batch is a half-written chapter plus a repair
  // request, and an over-sized reservation costs nothing but headroom.
  const generated = Math.ceil(8 * 700 * 1.3)
  const requested = batchOutputTokenEstimate(Array(8).fill(700))
  assert.ok(requested > generated * 2, `${requested} leaves too little room over ${generated}`)
})

test('a product with a small ceiling clamps the request instead of over-asking', () => {
  const request = batchOutputBudget(entries(8), 700)
  // The pre-network guard in genstudio-client.ts must stay a backstop, never
  // the thing that catches an over-sized request.
  assert.equal(resolveOutputTokenBudget(request, 8_000), 8_000)
  assert.equal(resolveOutputTokenBudget(request, 4_096), 4_096)
  for (const ceiling of [1_024, 4_096, 8_000, 32_768, LUNA_OUTPUT_TOKENS]) {
    assert.ok(
      resolveOutputTokenBudget(request, ceiling) <= ceiling,
      `a ${ceiling}-token product was asked for more than it publishes`,
    )
  }
})

test('under-requesting is impossible by construction', () => {
  // 1. A tiny batch never drops below the long-form floor.
  assert.equal(batchOutputTokenEstimate([50]), 8_192)
  assert.equal(batchOutputTokenEstimate([]), 8_192)

  // 2. Rounding only ever adds headroom.
  for (const words of [1, 99, 701, 1_234, 9_999]) {
    const raw = Math.ceil(words * 2.5) + 2_048
    assert.ok(
      batchOutputTokenEstimate([words]) >= raw,
      `rounding took tokens away for ${words} words`,
    )
  }

  // 3. The estimate rises with the work, monotonically.
  let previous = 0
  for (const count of [1, 2, 3, 5, 8, 12, 20]) {
    const value = batchOutputTokenEstimate(Array(count).fill(700))
    assert.ok(value >= previous, `${count} chapters asked for less than ${count - 1}`)
    previous = value
  }

  // 4. A `workload` request that somehow arrives WITHOUT a number degrades
  //    upwards to the whole ceiling, never down to a small default.
  assert.equal(resolveOutputTokenBudget({ tier: 'workload' }, LUNA_OUTPUT_TOKENS), LUNA_OUTPUT_TOKENS)
})

test('a longer chapter is budgeted for the chapter it actually holds', () => {
  // words_per_chapter overrides set in outline review must not be averaged
  // away — a 2,000-word chapter in a batch of 700s needs its own room.
  const uniform = batchOutputTokenEstimate([700, 700, 700])
  const mixed = batchOutputTokenEstimate([700, 2_000, 700])
  assert.ok(mixed > uniform, 'a per-chapter override was ignored')
  const withOverride: OutlineEntry[] = [
    { n: 1, title: 'One' },
    { n: 2, title: 'Two', words_per_chapter: 2_000 },
    { n: 3, title: 'Three' },
  ]
  assert.equal(batchOutputBudget(withOverride, 700).minimumTokens, mixed)
  // The batch falls back to the run-wide target when no override is set.
  assert.equal(batchOutputBudget(entries(3), 700).minimumTokens, uniform)
})

test('the estimate is never turned into a word or character ceiling', () => {
  // Khmer and mixed-script narration break any fixed ratio, which is exactly
  // why the 500,000-character cap was removed. This number sizes a REQUEST.
  const chunked = readFileSync(fileURLToPath(new URL('../lib/chunked-narration.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(chunked, /maxCharacters|max_characters|characterCap/)
  assert.match(chunked, /never a hard limit on\n\/\/ output/)
  // And the batches no longer take the whole ceiling.
  assert.doesNotMatch(chunked, /outputBudget: 'maximum' as const/)
})
