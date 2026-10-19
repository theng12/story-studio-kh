/**
 * The expected answer length, sent to the Gateway so the Hub can size the job's deadline.
 *
 * THE DEFECT THIS GUARDS: Studio Hub held every Chat job to one flat 1,800 s. It is now computed
 * from the job — the prompt, the expected answer, that Mac's measured decode rate — because a
 * 100-prompt scene pack needs ~2,500 s of generation on the fleet's slowest measured Mac before
 * load and safety margin, and the Hub cannot tell that pack from a one-line question by reading
 * the request body.
 *
 * Two things follow, and both are asserted here:
 *
 *   1. **The expectation is not the ceiling.** `max_output_tokens` says what may be sent; sizing
 *      a deadline from it would make every job three hours long. What travels as
 *      `expected_output_tokens` is the `workload` tier's own `minimumTokens` — the number Story
 *      already computes from the work being asked for — or the scene-plan pack's own
 *      `sceneIds x tokensPerScene`.
 *   2. **Absent stays absent.** A request that states no expectation omits the field, so the Hub
 *      falls back to the p90 of the fleet's own measured answers rather than to a number Story
 *      invented.
 *
 * ZERO paid calls: every product below is a hand-written catalogue fixture and every completion
 * is a hand-written envelope. Nothing here touches the Gateway.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { callChatWithGenStudio } from '../lib/genstudio-client.js'
import {
  expectedOutputTokensFor,
  resolveOutputTokenBudget,
} from '../services/output-token-budget.js'
import { ideaOutputTokenBudget } from '../services/idea-output-budget.js'

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

function chatJob(fields: Record<string, unknown> = {}) {
  return {
    id: 'job_expect_1',
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

/** The client caches the product catalogue per API key, so every fixture product needs its own
 *  key or the first ceiling sticks for the whole file. */
let keySeq = 0

/** Run one chat call against a fixture product and report what it ASKED for.
 *  `expectedOutputTokens` is `undefined` when the request carried no expectation at all, which is
 *  the shape that lets the Hub fall back to its own measured p90. */
async function submittedExpectation(
  request: Parameters<typeof callChatWithGenStudio>[1],
  productMaxOutputTokens: number | null = 65_536,
): Promise<{ expectedOutputTokens: number | undefined; maxOutputTokens: number | undefined }> {
  const originalFetch = globalThis.fetch
  let expectedOutputTokens: number | undefined
  let maxOutputTokens: number | undefined
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(productMaxOutputTokens))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      const body = JSON.parse(String(init?.body))
      expectedOutputTokens = body.expected_output_tokens
      maxOutputTokens = body.max_output_tokens
      return Response.json(chatJob())
    }
    keySeq += 1
    await callChatWithGenStudio(`expectation-key-${keySeq}`, request)
  } finally {
    globalThis.fetch = originalFetch
  }
  return { expectedOutputTokens, maxOutputTokens }
}

const baseRequest = {
  modelId: 'writer-alpha',
  system: '',
  userMessage: 'Write something.',
  outputContract: { mode: 'json_object' } as const,
}

// ── What counts as an expectation ────────────────────────────────────────

test('the workload tier is the expectation, because it is already computed from the work', () => {
  // `ideaOutputTokenBudget(count)` and `batchOutputTokenEstimate(words)` both feed
  // `{ tier: 'workload', minimumTokens }`, so that number IS how long the answer is expected to
  // be — 100 ideas is 100 x 640 + 1,024.
  assert.equal(ideaOutputTokenBudget(100), 65_024)
  assert.equal(expectedOutputTokensFor({ tier: 'workload', minimumTokens: 65_024 }), 65_024)
})

test('a tier that is a fraction of the ceiling is not an expectation', () => {
  // These say "at most half of what the product allows", which is a claim about the product and
  // not about this answer. Sizing a deadline from one would be the three-hour-every-job defect.
  for (const tier of ['short', 'standard', 'long', 'maximum'] as const) {
    assert.equal(expectedOutputTokensFor(tier), null, tier)
  }
  assert.equal(expectedOutputTokensFor(undefined), null)
  assert.equal(expectedOutputTokensFor({ tier: 'workload' }), null)
  assert.equal(expectedOutputTokensFor({ tier: 'workload', minimumTokens: 0 }), null)
})

// ── What goes on the wire ────────────────────────────────────────────────

test('a workload budget travels as expected_output_tokens, beside the ceiling', async () => {
  const { expectedOutputTokens, maxOutputTokens } = await submittedExpectation({
    ...baseRequest,
    outputBudget: { tier: 'workload', minimumTokens: 65_024 },
  })
  assert.equal(expectedOutputTokens, 65_024)
  // The ceiling is still sent, unchanged: a workload floor under the product's own ceiling IS
  // the ceiling, exactly as it was before this field existed.
  assert.equal(maxOutputTokens, 65_024)
})

test('the expectation and the ceiling are two different numbers, not one', async () => {
  // A workload floor **above** the product's published ceiling: the ceiling clamps (the product
  // will not return more than it says it will), and the expectation does not — the answer is
  // expected to be 90,000 tokens long whatever this product allows, which is what the deadline
  // has to cover. Reading one as the other is the defect this pair guards.
  const { expectedOutputTokens, maxOutputTokens } = await submittedExpectation({
    ...baseRequest,
    outputBudget: { tier: 'workload', minimumTokens: 90_000 },
  })
  assert.equal(expectedOutputTokens, 90_000)
  assert.equal(maxOutputTokens, 65_536)
  assert.notEqual(expectedOutputTokens, maxOutputTokens)
})

test('an explicit expectation wins over the budget it travels with', async () => {
  const { expectedOutputTokens } = await submittedExpectation({
    ...baseRequest,
    outputBudget: { tier: 'workload', minimumTokens: 65_024 },
    expectedOutputTokens: 4_500,
  })
  assert.equal(expectedOutputTokens, 4_500)
})

test('a request that states no expectation sends no field at all', async () => {
  // Absent is the honest spelling of "nobody said". An empty or invented number here would take
  // the Hub's own measured fallback away from it.
  for (const budget of [undefined, 'long', 'standard', 'short', 'maximum'] as const) {
    const { expectedOutputTokens } = await submittedExpectation({ ...baseRequest, outputBudget: budget })
    assert.equal(expectedOutputTokens, undefined, String(budget))
  }
})

test('the ceiling a tier resolves to is unchanged by any of this', async () => {
  for (const tier of ['long', 'standard', 'short'] as const) {
    const { maxOutputTokens, expectedOutputTokens } = await submittedExpectation(
      { ...baseRequest, outputBudget: tier })
    assert.equal(maxOutputTokens, resolveOutputTokenBudget(tier, 65_536), tier)
    assert.equal(expectedOutputTokens, undefined, tier)
  }
})

test('the expectation never reaches the idempotency digest', async () => {
  // It changes no allowance and no answer, so a retry that gains or loses the hint must replay
  // the same job instead of buying a second one.
  const digest = source('../lib/genstudio-client.ts')
    .split('export function buildGenStudioChatIdempotencyKey')[1]!
    .split('\nexport ')[0]!
  assert.ok(!digest.includes('expectedOutputTokens'),
    'the hint must not enter the idempotency key: it changes the deadline, not the request')
})

// ── The scene-prompt pack, which is the job the deadline exists for ──────

test('the scene-plan pack states its own size as the expectation', () => {
  const plan = source('../generators/scene-plan.ts')
  // The pack's expectation is the same arithmetic Story uses to size the pack itself
  // (`maxSafeScenePromptPackSize` divides by the same `tokensPerScene`), so the allowance and the
  // expectation cannot disagree about what one scene costs.
  assert.match(plan, /Math\.round\(input\.sceneIds\.length \* promptPackTuning\.tokensPerScene\)/)
  assert.match(plan, /expectedOutputTokens,\n\s*outputContract: scenePromptPackOutputContract/)
})

test('the pack tuning the expectation is built from is the one Story sizes packs with', () => {
  const batching = source('../services/scene-prompt-batching.ts')
  assert.match(batching, /tokensPerScene: 300/)
  // Both the pack size and the expectation read the same tuning object, so a project that
  // changes `scene_prompt_tokens_per_scene` moves both together.
  assert.match(batching, /maxSafeScenePromptPackSize/)
})
