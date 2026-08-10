/**
 * Per-workflow output-token budgets.
 *
 * THE BUG THIS GUARDS: `callChatWithGenStudio` defaulted every request that
 * did not name a number to `min(2_048, product.max_output_tokens)`. Long-form
 * workflows — research, chapters, chunked narration, scene plans — therefore
 * asked for 2,048 tokens no matter how much the selected product allowed. A
 * real production job came back with EXACTLY 2,048 completion tokens and
 * `finish_reason: "length"`; GenStudio refused to settle a truncated answer
 * and the run was wasted.
 *
 * ZERO paid calls: every product below is a hand-written catalogue fixture and
 * every completion is a hand-written envelope. Nothing here touches GenStudio.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  callChatWithGenStudio,
  GenStudioChatIncompleteError,
} from '../lib/genstudio-client.js'
import {
  resolveOutputTokenBudget,
  SHORT_FORM_OUTPUT_TOKENS,
} from '../services/output-token-budget.js'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

function catalog(maxOutputTokens: number) {
  return [{
    id: 'writer-alpha',
    display_name: 'Writer Alpha',
    available: true,
    qualification_only: false,
    context_window_tokens: 1_048_576,
    max_output_tokens: maxOutputTokens,
    controls: ['temperature', 'max_output_tokens'],
    activation_blockers: [],
    structured_output_mode: 'json_object',
    supports_structured_output: true,
  }]
}

function accountOverview() {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
  }
}

/** The client caches the product catalogue per API key, so every fixture
 *  product needs its own key or the first ceiling sticks for the whole file. */
let keySeq = 0

/** One settled `/v1/chat/responses` job. The durable route is now the default,
 *  so a fixture that still returned an OpenAI-shaped completion would be
 *  testing a rollback path rather than what ships. */
function chatJob(fields: Record<string, unknown> = {}) {
  return {
    id: 'job_budget_1',
    state: 'succeeded',
    operation: 'chat.response',
    dispatch_mode: 'asynchronous',
    model_id: 'writer-alpha',
    output_text: '{"ok":true}',
    output_retained: true,
    finish_reason: 'stop',
    failure_code: null,
    routing_status_code: null,
    credit_cost: 3,
    remaining_credits: 900,
    idempotent_replay: false,
    ...fields,
  }
}

/** Run one chat call against a fixture product and report what it ASKED for. */
async function submittedTokenLimit(
  request: Parameters<typeof callChatWithGenStudio>[1],
  productMaxOutputTokens = 65_536,
): Promise<{ maxOutputTokens: number; submissions: number }> {
  const originalFetch = globalThis.fetch
  let maxOutputTokens = -1
  let submissions = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(productMaxOutputTokens))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      submissions += 1
      maxOutputTokens = JSON.parse(String(init?.body)).max_output_tokens
      return Response.json(chatJob())
    }
    keySeq += 1
    await callChatWithGenStudio(`budget-key-${keySeq}`, request)
  } finally {
    globalThis.fetch = originalFetch
  }
  return { maxOutputTokens, submissions }
}

const baseRequest = {
  modelId: 'writer-alpha',
  system: '',
  userMessage: 'Write something.',
  outputContract: { mode: 'json_object' } as const,
}

// ── The resolver itself ──────────────────────────────────────────────────

test('an absent budget still resolves to the historical short-form default', () => {
  assert.equal(SHORT_FORM_OUTPUT_TOKENS, 2_048)
  assert.equal(resolveOutputTokenBudget(undefined, 65_536), 2_048)
  assert.equal(resolveOutputTokenBudget('short', 65_536), 2_048)
  // A product smaller than the default is still respected, exactly as the old
  // `Math.min(2_048, product.max_output_tokens)` did.
  assert.equal(resolveOutputTokenBudget(undefined, 1_024), 1_024)
})

test('every long-form tier scales with the product instead of a constant', () => {
  // Two products with different published ceilings must produce two different
  // budgets — that is the whole point of deriving rather than hardcoding.
  assert.equal(resolveOutputTokenBudget('standard', 65_536), 16_384)
  assert.equal(resolveOutputTokenBudget('long', 65_536), 32_768)
  assert.equal(resolveOutputTokenBudget('maximum', 65_536), 65_536)

  assert.equal(resolveOutputTokenBudget('standard', 32_768), 8_192)
  assert.equal(resolveOutputTokenBudget('long', 32_768), 16_384)
  assert.equal(resolveOutputTokenBudget('maximum', 32_768), 32_768)

  // Every long-form tier is strictly more room than the 2,048 that truncated.
  for (const tier of ['standard', 'long', 'maximum'] as const) {
    assert.ok(
      resolveOutputTokenBudget(tier, 65_536) > SHORT_FORM_OUTPUT_TOKENS,
      `${tier} must not resolve to the short-form default`,
    )
  }
})

test('no tier can ever exceed the published product ceiling', () => {
  for (const ceiling of [1, 512, 2_048, 4_096, 8_192, 32_768, 65_536, 200_000]) {
    for (const tier of ['short', 'standard', 'long', 'maximum'] as const) {
      const resolved = resolveOutputTokenBudget(tier, ceiling)
      assert.ok(resolved <= ceiling, `${tier}@${ceiling} resolved to ${resolved}`)
      assert.ok(resolved >= 1, `${tier}@${ceiling} resolved to ${resolved}`)
    }
  }
  // A small product clamps the floors down rather than requesting the
  // impossible — the floors are floors, not overrides.
  assert.equal(resolveOutputTokenBudget('long', 4_096), 4_096)
  assert.equal(resolveOutputTokenBudget('standard', 1_024), 1_024)
})

test('a workload floor raises the request but is still clamped to the product', () => {
  // 100 ideas need more than a typical "long" run on a small product…
  assert.equal(resolveOutputTokenBudget({ tier: 'long', minimumTokens: 16_384 }, 32_768), 16_384)
  // …and a floor above the ceiling clamps instead of tripping the guard.
  assert.equal(resolveOutputTokenBudget({ tier: 'long', minimumTokens: 99_000 }, 8_192), 8_192)
  // A floor below the tier never lowers it.
  assert.equal(resolveOutputTokenBudget({ tier: 'long', minimumTokens: 100 }, 65_536), 32_768)
})

test('a malformed catalogue entry is refused, never quietly resized to short-form', () => {
  // v1.0.786 — this used to assert the opposite: that an unpublished ceiling
  // "degrades to short-form". Degrading is what made it dangerous. A `long` or
  // `workload` caller silently squeezed into 2,048 tokens gets a chapter that
  // stops at `finish_reason: "length"` — written to disk and paid for as if
  // complete. There is no honest stand-in for a ceiling nobody published, so
  // the caller is told. AGENTS.md: fail loudly or show nothing.
  for (const bad of [undefined, null, 0, -5, 1.5, 'many', Number.NaN]) {
    assert.throws(
      () => resolveOutputTokenBudget('maximum', bad),
      /published no usable max_output_tokens/,
      `resolved a budget from ${String(bad)} instead of refusing`,
    )
  }
  // A published ceiling still resolves normally — the rule is "never invent".
  assert.equal(resolveOutputTokenBudget('short', 32_768), SHORT_FORM_OUTPUT_TOKENS)
})

// ── The wire ─────────────────────────────────────────────────────────────

test('a long-form workflow submits a product-derived limit, not 2,048', async () => {
  const long = await submittedTokenLimit({ ...baseRequest, outputBudget: 'long' })
  assert.equal(long.maxOutputTokens, 32_768)
  assert.notEqual(long.maxOutputTokens, 2_048)

  const maximum = await submittedTokenLimit({ ...baseRequest, outputBudget: 'maximum' })
  assert.equal(maximum.maxOutputTokens, 65_536)

  // The SAME tier on a different product asks for a different number.
  const smaller = await submittedTokenLimit({ ...baseRequest, outputBudget: 'long' }, 8_192)
  assert.equal(smaller.maxOutputTokens, 8_192)
})

test('short-form callers are unchanged — still exactly 2,048', async () => {
  const untouched = await submittedTokenLimit({ ...baseRequest })
  assert.equal(untouched.maxOutputTokens, 2_048)
  const explicit = await submittedTokenLimit({ ...baseRequest, outputBudget: 'short' })
  assert.equal(explicit.maxOutputTokens, 2_048)
  // And a product smaller than the default still wins.
  const tiny = await submittedTokenLimit({ ...baseRequest }, 1_024)
  assert.equal(tiny.maxOutputTokens, 1_024)
})

test('an explicit number still wins over a tier', async () => {
  const explicit = await submittedTokenLimit({
    ...baseRequest, maxOutputTokens: 4_096, outputBudget: 'maximum',
  })
  assert.equal(explicit.maxOutputTokens, 4_096)
})

test('the product ceiling is still enforced BEFORE anything is submitted', async () => {
  const originalFetch = globalThis.fetch
  let submissions = 0
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(8_192))
      submissions += 1
      throw new Error(`Unexpected request ${url}`)
    }
    await assert.rejects(
      callChatWithGenStudio('over-ceiling-key', {
        ...baseRequest,
        maxOutputTokens: 8_193,
      }),
      // The wording promises nothing was requested or charged, and the guard
      // genuinely runs before submission — so the promise stays true.
      /8,192-token limit.*No request or credit charge was made/i,
    )
    assert.equal(submissions, 0, 'the ceiling guard must run before the network')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a tier can never be the thing that trips the ceiling guard', async () => {
  // A derived budget is clamped by construction, so every tier submits — on a
  // product far BELOW every tier floor as well as one far above. (Kept to two
  // ceilings on purpose: the client's shared admission pool enforces a real
  // submissions-per-minute budget, and a test file that blows through it
  // stalls the whole suite for a minute.)
  for (const tier of ['short', 'standard', 'long', 'maximum'] as const) {
    for (const ceiling of [1_024, 65_536]) {
      const result = await submittedTokenLimit({ ...baseRequest, outputBudget: tier }, ceiling)
      assert.equal(result.submissions, 1, `${tier}@${ceiling} was refused`)
      assert.ok(result.maxOutputTokens <= ceiling)
    }
  }
})

// ── Truncation is never success ──────────────────────────────────────────

test('a finish_reason "length" job fails loudly and returns no partial', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(65_536))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      return Response.json(chatJob({
        id: 'job_truncated_1',
        // Valid JSON, so nothing else in the pipeline would have objected —
        // only the finish reason says this answer was cut off. The durable
        // route reports it on the JOB, not on a choice.
        output_text: '{"summary":"half a thou',
        finish_reason: 'length',
      }))
    }
    const error = await callChatWithGenStudio('truncated-key', baseRequest)
      .then(result => result as unknown, (err: unknown) => err)
    assert.ok(
      error instanceof GenStudioChatIncompleteError,
      `expected GenStudioChatIncompleteError, got ${error}`,
    )
    assert.equal(error.truncated, true)
    assert.equal(error.finishReason, 'length')
    // The user is told the answer was cut off AND what to do about it.
    assert.match(error.message, /cut off/i)
    assert.match(error.message, /larger published output limit/i)
    assert.match(error.message, /smaller|fewer/i)
    // The partial is carried for a completion audit but is NOT the result.
    assert.equal(error.partialText, '{"summary":"half a thou')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('every non-stop finish reason is rejected; genuine stops are not', async () => {
  const originalFetch = globalThis.fetch
  async function run(finishReason: unknown): Promise<unknown> {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(65_536))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      return Response.json(chatJob({ id: 'job_finish_1', finish_reason: finishReason }))
    }
    return callChatWithGenStudio('finish-key', baseRequest).then(r => r as unknown, (e: unknown) => e)
  }
  try {
    for (const bad of ['length', 'max_tokens', 'content_filter']) {
      const outcome = await run(bad)
      assert.ok(
        outcome instanceof GenStudioChatIncompleteError,
        `finish_reason "${bad}" was accepted as complete`,
      )
    }
    // Truncation-specific wording only for a real token-ceiling stop.
    assert.equal((await run('content_filter') as GenStudioChatIncompleteError).truncated, false)
    // A genuine stop — and an absent field, which GenStudio types as "stop" —
    // still returns normally.
    for (const good of ['stop', 'end_turn', undefined]) {
      const outcome = await run(good)
      assert.ok(!(outcome instanceof Error), `finish_reason "${good}" was wrongly rejected`)
      assert.deepEqual(JSON.parse((outcome as { text: string }).text), { ok: true })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── The workflows themselves ─────────────────────────────────────────────

test('every long-form workflow declares a product-derived budget', () => {
  // Source-level, because these are call-site decisions: the point is that no
  // long-form workflow silently falls back to the 2,048 short-form default.
  const expectations: Array<[string, string, RegExp]> = [
    ['research (model knowledge)', '../services/research/genstudio.ts', /outputBudget: 'long'/],
    ['research (web search)', '../services/research/genstudio-web.ts', /outputBudget: 'long'/],
    ['chunked narration outline', '../lib/chunked-narration.ts', /outputBudget: 'long'/],
    // Batches size their own reservation from the batch's word targets rather
    // than taking the product's whole ceiling — see chunking-budget.test.ts.
    ['chunked narration batches', '../lib/chunked-narration.ts', /outputBudget: batchOutputBudget\(batch, params\.wordsPerChapter\)/],
    ['script chapter + intro', '../generators/episode.ts', /outputBudget: 'long'/],
    ['audio expression markup', '../services/audio-expression.ts', /outputBudget: 'maximum'/],
    ['scene planner windows', '../services/scene-planner.ts', /outputBudget: 'maximum'/],
    ['prompt director', '../generators/prompt-director.ts', /outputBudget: 'maximum'/],
    ['format extraction', '../routes/projects.ts', /outputBudget: 'long'/],
    ['metadata description', '../generators/metadata.ts', /outputBudget: 'standard'/],
    ['idea campaign', '../generators/idea-campaign.ts', /outputBudget: \{ tier: 'long'/],
    ['ideas route', '../routes/ideas.ts', /outputBudget: \{ tier: 'long'/],
  ]
  for (const [label, file, pattern] of expectations) {
    assert.match(source(file), pattern, `${label} lost its output budget`)
  }
})

test('the two hardcoded 16,000-token guesses are gone', () => {
  // They both ignored a larger product AND hard-failed the pre-network limit
  // check against a product publishing less than 16,000.
  for (const file of ['../generators/prompt-director.ts', '../services/scene-planner.ts']) {
    assert.doesNotMatch(source(file), /maxTokens: 16000/, `${file} still hardcodes 16,000`)
  }
})
