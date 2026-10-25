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
  CHAT_ALLOWANCE_CEILING_SECONDS,
  chatAllowanceSeconds,
  effectiveChatTimeoutMs,
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
  // `ideaOutputTokenBudget(count)` feeds `{ tier: 'workload', minimumTokens }`, so that number IS
  // how long the answer is expected to be — 100 ideas is 100 x 640 + 1,024. Chapter expansion no
  // longer has an estimate to offer (it asks for the product's whole published cap), so it
  // deliberately does NOT declare an expectation.
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

// ── The socket bound, which must not cut a job its Gateway and Hub allow ──

test('a 30,000-token pack is given at least 68 minutes', () => {
  // The same job Studio Hub sizes: 100 scene prompts x 300 tokens, with a ~12,000-token prompt.
  // On the fleet's slowest measured Mac (12.0 tok/s decode, 60.0 tok/s prefill, 15 s load) the
  // Hub computes 4,072 s — 68 minutes — and the owner's 30-minute dial would cut it at 44%.
  const allowance = chatAllowanceSeconds(30_000, 12_000 * 4)
  assert.ok(allowance >= 68 * 60, `the pack must get >= 68 minutes, got ${allowance / 60}`)
  // The Hub computes 4,072 s for the same job; this side rounds up to a whole minute, which can
  // only leave the socket open longer.
  assert.equal(allowance, 68 * 60)
})

test("a median answer keeps the owner's 30 minutes", () => {
  // The fleet's median answer is 3,415 tokens, which needs ~285 s of decode on an M1. The dial
  // is a FLOOR, not a preference: it is never lowered because the model is expected to be quick.
  const owner = 30 * 60_000
  const allowance = chatAllowanceSeconds(3_400, 4_000)
  assert.ok(allowance < owner / 1000, 'the allowance is under the dial, so the dial stands')
  assert.equal(effectiveChatTimeoutMs(owner, allowance), owner)
})

test('the allowance raises the socket above the dial, and the dial still raises it further', () => {
  const owner = 30 * 60_000
  assert.equal(effectiveChatTimeoutMs(owner, 4_072), 4_072 * 1000)
  // An operator who set an hour keeps the hour when the allowance is two minutes.
  assert.equal(effectiveChatTimeoutMs(60 * 60_000, 120), 60 * 60_000)
  // And the longer of the two always wins, never the shorter.
  assert.equal(effectiveChatTimeoutMs(10 * 60_000, 5_000), 5_000 * 1000)
})

test('the Hub ceiling caps both, so this side never outlasts the Hub', () => {
  assert.equal(CHAT_ALLOWANCE_CEILING_SECONDS, 4 * 3600)
  assert.equal(effectiveChatTimeoutMs(240 * 60_000, 10 * 3600),
               CHAT_ALLOWANCE_CEILING_SECONDS * 1000)
  assert.equal(effectiveChatTimeoutMs(10 * 3600_000, 60), CHAT_ALLOWANCE_CEILING_SECONDS * 1000)
  // The owner's own maximum is exactly the ceiling, so no legal setting is ever cut.
  assert.equal(effectiveChatTimeoutMs(240 * 60_000, 0), CHAT_ALLOWANCE_CEILING_SECONDS * 1000)
})

test('no stated expectation adds nothing to the dial', () => {
  // Inventing an allowance from `max_output_tokens` here would be the "every job is three hours"
  // defect the expectation exists to prevent.
  for (const none of [null, 0, -1] as const) {
    assert.equal(chatAllowanceSeconds(none, 100_000), 0, String(none))
    assert.equal(effectiveChatTimeoutMs(30 * 60_000, chatAllowanceSeconds(none, 100_000)),
                 30 * 60_000)
  }
})

test('a bigger prompt is given longer, because prefill is not free', () => {
  assert.ok(chatAllowanceSeconds(3_400, 400_000) > chatAllowanceSeconds(3_400, 4_000))
})

test('the socket timeout is the owner dial or this request\'s allowance', () => {
  // The one wiring point: `submitLanguageJson` is the only place the socket is bounded, and it
  // must apply the allowance there rather than at a call site that could forget it.
  const client = source('../lib/genstudio-client.ts')
  const submit = client.split('async function submitLanguageJson')[1]!.split('\nasync function')[0]!
  assert.match(submit, /effectiveChatSubmitTimeoutMs\(chatAllowanceSeconds\)/)
  assert.ok(!/await languageSubmitTimeoutMs\(\)/.test(submit),
    'the raw dial must not bound the socket on its own any more')
  assert.match(client, /effectiveChatTimeoutMs\(await getLanguageTimeoutMs\(\), allowanceSeconds\)/)
})
