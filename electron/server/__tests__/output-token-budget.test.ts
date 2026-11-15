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

function catalog(maxOutputTokens: number | null) {
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

/** Run one chat call against a fixture product and report what it ASKED for.
 *  `maxOutputTokens` is `undefined` when the request carried no ceiling at all,
 *  which is the shape an unpublished product must produce. */
async function submittedTokenLimit(
  request: Parameters<typeof callChatWithGenStudio>[1],
  productMaxOutputTokens: number | null = 65_536,
): Promise<{ maxOutputTokens: number | undefined; submissions: number }> {
  const originalFetch = globalThis.fetch
  let maxOutputTokens: number | undefined
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
      (resolveOutputTokenBudget(tier, 65_536) ?? 0) > SHORT_FORM_OUTPUT_TOKENS,
      `${tier} must not resolve to the short-form default`,
    )
  }
})

test('no tier can ever exceed the published product ceiling', () => {
  for (const ceiling of [1, 512, 2_048, 4_096, 8_192, 32_768, 65_536, 200_000]) {
    for (const tier of ['short', 'standard', 'long', 'maximum'] as const) {
      const resolved = resolveOutputTokenBudget(tier, ceiling)!
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

test('an UNPUBLISHED ceiling resolves to no ceiling at all, for every tier', () => {
  // Owner decision #6, 2026-09-20 — REVERSES what this file asserted before.
  //
  // It used to require a throw for `undefined`/`null`/`0`, on the reasoning
  // that no honest stand-in exists. The reasoning was right and the conclusion
  // was wrong: there IS an honest answer, and it is "no ceiling". Four shipped
  // products publish `max_output_tokens: null` (Free Models Router, grok-4.3,
  // grok-4.6, grok-build-0.1), and the owner's ruling is that they are usable
  // by OMITTING the field — "no output limit is fine" — rather than refused.
  //
  // `null` is not zero and not a default: it is the absence, carried instead of
  // flattened (AGENTS.md §6). The catalogue parser normalises an unpublished
  // figure to `0` before this function sees it, so `0` is that same absence.
  for (const unpublished of [undefined, null, 0]) {
    for (const tier of ['short', 'standard', 'long', 'maximum'] as const) {
      assert.equal(
        resolveOutputTokenBudget(tier, unpublished),
        null,
        `${tier} with an unpublished ceiling must be "no ceiling", not a number`,
      )
    }
    assert.equal(resolveOutputTokenBudget({ tier: 'workload', minimumTokens: 8_000 }, unpublished), null,
      'a caller-supplied floor cannot become a ceiling the product never published')
  }
})

test('a MALFORMED catalogue entry is still refused, never read as "not published"', () => {
  // "The product published nothing" and "I could not read what it published"
  // must not produce the same value (AGENTS.md §6). Only the three real
  // absences are allowed to mean "no ceiling"; a value that is present and
  // unreadable is a programming error and says so.
  for (const malformed of [-5, 1.5, 'many', Number.NaN]) {
    assert.throws(
      () => resolveOutputTokenBudget('maximum', malformed),
      /malformed max_output_tokens/,
      `resolved a budget from ${String(malformed)} instead of refusing`,
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

test('a product publishing NO ceiling is usable: the request omits the field and is submitted', async () => {
  // Owner decision #6, 2026-09-20. The consequence, not the string: this used
  // to reject before the network ("Story Studio cannot size this request
  // without it"), so the four shipped `max_output_tokens: null` products could
  // not be used at all. Now the call goes out and carries NO ceiling — nothing
  // is attributed to the product, and the provider decides.
  const unpublished = await submittedTokenLimit({ ...baseRequest, outputBudget: 'long' }, null)
  assert.equal(unpublished.submissions, 1, 'the product must actually be used, not refused')
  assert.equal(unpublished.maxOutputTokens, undefined,
    'the wire body must OMIT max_output_tokens rather than carry a number Story Studio chose')

  // An explicit caller number is still that caller's own ceiling, and is sent.
  const explicit = await submittedTokenLimit({ ...baseRequest, maxOutputTokens: 4_096 }, null)
  assert.equal(explicit.maxOutputTokens, 4_096,
    'an explicit allowance is not a claim about the product, so it is still submitted')
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
      // A published ceiling always produces a number, never an omission.
      assert.ok(result.maxOutputTokens !== undefined && result.maxOutputTokens <= ceiling)
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

test('a ceiling-hit answer that still says "stop" is incomplete, not done', async () => {
  // Measured live on a Studio Hub lane, 2026-09-26 (the STORY-2 acceptance
  // run): the worker stopped exactly at its own 4,096-token fallback and still
  // reported `finish_reason: "stop"`, and the chapter it produced ends
  // mid-sentence. Usage is the only signal that survived, so it has to be the
  // one that fails the job — a half-written chapter must never reach disk as a
  // finished one.
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(4_096))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      return Response.json(chatJob({
        id: 'job_ceiling_1',
        output_text: '## Chapter 02: The Fog That Eats Sound\n\nHe remembers the light is the only safe place in',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1_264, completion_tokens: 4_096, total_tokens: 5_360 },
      }))
    }
    const error = await callChatWithGenStudio('ceiling-key', { ...baseRequest, outputBudget: 'maximum' })
      .then(result => result as unknown, (err: unknown) => err)
    assert.ok(
      error instanceof GenStudioChatIncompleteError,
      `expected GenStudioChatIncompleteError, got ${error}`,
    )
    assert.equal(error.truncated, true)
    assert.equal(error.finishReason, 'stop')
    assert.match(error.message, /ceiling/i)
    assert.match(error.message, /4,?096/)
    assert.match(error.message, /finish_reason "stop"/i)
    assert.equal(error.partialText, '## Chapter 02: The Fog That Eats Sound\n\nHe remembers the light is the only safe place in')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an answer under the ceiling, and one with no usage at all, are still results', async () => {
  // The negative control: without it, "always throw" would pass the test above.
  const originalFetch = globalThis.fetch
  async function run(usage: unknown): Promise<unknown> {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(4_096))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      return Response.json(chatJob({ id: 'job_ceiling_2', finish_reason: 'stop', ...(usage === undefined ? {} : { usage }) }))
    }
    return callChatWithGenStudio('ceiling-negative-key', { ...baseRequest, outputBudget: 'maximum' })
      .then(result => result as unknown, (err: unknown) => err)
  }
  try {
    for (const [label, usage] of [
      ['under the ceiling', { prompt_tokens: 997, completion_tokens: 967, total_tokens: 1_964 }],
      ['usage not reported', undefined],
    ] as const) {
      const outcome = await run(usage)
      assert.ok(!(outcome instanceof Error), `${label} was wrongly rejected: ${outcome}`)
    }
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
    // 1.4.359 — a chapter batch asks for EVERYTHING the selected product
    // publishes, bounded only by that product's published context window. No
    // words→tokens estimate: Khmer broke it on 2026-10-25 (Komsan). See
    // chunking-budget.test.ts for the budget itself.
    ['chunked narration batches', '../lib/chunked-narration.ts', /expansionRequestOutputBudget\(\s*\n?\s*budget, expansionPromptCharacters\(params\.systemPrompt, prompt\)/],
    ['script chapter + intro', '../generators/episode.ts', /outputBudget: 'long'/],
    ['scene planner windows', '../services/scene-planner.ts', /outputBudget: 'maximum'/],
    ['metadata description', '../generators/metadata.ts', /outputBudget: 'standard'/],
    // Request the published maximum; retain the count-derived expectation separately for deadlines.
    ['idea campaign', '../generators/idea-campaign.ts', /outputBudget: \{ tier: 'maximum' \}/],
    ['idea campaign expectation', '../generators/idea-campaign.ts', /expected_output_tokens: ideaOutputTokenBudget\(count\)/],
    ['shared freeform ideas', '../services/freeform-idea-generation.ts', /outputBudget: input\.outputBudget\s*\?\? \{ tier: 'maximum' \}/],
    ['shared freeform expectation', '../services/freeform-idea-generation.ts', /expectedOutputTokens: input\.expectedOutputTokens\s*\?\? ideaOutputTokenBudget\(input\.request\.count\)/],
  ]
  for (const [label, file, pattern] of expectations) {
    assert.match(source(file), pattern, `${label} lost its output budget`)
  }
})

test('the hardcoded 16,000-token guess is gone', () => {
  // It ignored a larger product AND hard-failed the pre-network limit
  // check against a product publishing less than 16,000.
  for (const file of ['../services/scene-planner.ts']) {
    assert.doesNotMatch(source(file), /maxTokens: 16000/, `${file} still hardcodes 16,000`)
  }
})

test('no stage clamps the scene-plan budget below the model’s published allowance', () => {
  // 1.4.223 removed `Math.min(4_096, visualMaxTokens)` from the motion stage.
  // It capped the PUBLISHED allowance, and because that value also drives the
  // wire field, the batch size and the job-log arithmetic, a 16,384-token model
  // was requested and described as a 4,096-token one. Source-level, like the
  // 16,000 pin above: the cap was a literal in a long generator function, and
  // the point is that no literal may come back.
  const text = source('../generators/scene-plan.ts')
  assert.doesNotMatch(text, /Math\.min\(\s*4_?096\s*,/, 'a 4,096-token cap came back')
  assert.match(
    text,
    /const activePromptOutputBudget = savedRequestPlan\s*\?\s*savedRequestPlan\.active_output_budget\s*:\s*visualMaxTokens/,
    'the active prompt budget must be the published allowance, uncapped',
  )
})
