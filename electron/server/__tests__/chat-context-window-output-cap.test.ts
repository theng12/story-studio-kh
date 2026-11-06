/**
 * The requested output never exceeds the product's published context window,
 * on EVERY writing request.
 *
 * THE DEFECT THIS GUARDS (2026-10-30). Story sent `max_output_tokens: 64,000` to
 * `studio-hub::mlx-community/gemma-4-26B-A4B-it-qat-4bit`, a local product that
 * publishes a 32,768-token context window. Its published OUTPUT ceiling is
 * larger than its whole window, so the "within the published output limit" guard
 * passed and the request asked for more answer tokens than the product could hold
 * beside its prompt. Chapters bounded this already; research, outline and
 * metadata did not, because only the submission boundary sees the live figures.
 *
 * The rule, applied once in `prepareChatSubmission` (every path goes through it):
 * `min(published output ceiling, context_window_tokens − this prompt's tokens)`.
 * The prompt is estimated with the app's one characters÷4 prompt measure — never
 * a words→tokens conversion of the answer. A product that publishes no window is
 * exactly as it was. A product that publishes no output ceiling still sends none.
 * A prompt that leaves no room is refused before the call, with both figures.
 *
 * ZERO paid calls: every product is a hand-written catalogue fixture and every
 * completion is a hand-written envelope.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { callChatWithGenStudio } from '../lib/genstudio-client.js'
import {
  boundOutputTokensToContext,
  estimatePromptTokens,
  PROMPT_CHARS_PER_TOKEN_ESTIMATE,
} from '../services/output-token-budget.js'

function catalog(
  contextWindowTokens: number | null,
  maxOutputTokens: number | null,
  maxRequestTokens?: number,
) {
  return [{
    id: 'writer-alpha',
    display_name: 'Writer Alpha',
    available: true,
    qualification_only: false,
    context_window_tokens: contextWindowTokens,
    max_output_tokens: maxOutputTokens,
    ...(maxRequestTokens === undefined ? {} : { max_request_tokens: maxRequestTokens }),
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

function chatJob() {
  return {
    id: 'job_window_1',
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
  }
}

/** The client caches the catalogue per API key: every fixture product needs its own key. */
let keySeq = 0

interface Submission {
  maxOutputTokens: number | undefined
  submitted: boolean
}

/** Run one chat call against a fixture product and report what it ASKED for. */
async function submitted(
  request: Parameters<typeof callChatWithGenStudio>[1],
  product: {
    contextWindowTokens: number | null
    maxOutputTokens: number | null
    maxRequestTokens?: number
  },
): Promise<Submission> {
  const originalFetch = globalThis.fetch
  let maxOutputTokens: number | undefined
  let submitted = false
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) {
        return Response.json(catalog(product.contextWindowTokens, product.maxOutputTokens, product.maxRequestTokens))
      }
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      submitted = true
      const body = JSON.parse(String(init?.body))
      maxOutputTokens = body.max_output_tokens
      return Response.json(chatJob())
    }
    keySeq += 1
    await callChatWithGenStudio(`window-key-${keySeq}`, request)
  } finally {
    globalThis.fetch = originalFetch
  }
  return { maxOutputTokens, submitted }
}

function promptOf(characters: number) {
  return { system: '', userMessage: 'x'.repeat(characters) }
}

const jsonContract = { mode: 'json_object' } as const

function request(characters: number, outputBudget: 'long' | 'maximum' = 'long') {
  return {
    modelId: 'writer-alpha',
    ...promptOf(characters),
    outputBudget,
    outputContract: jsonContract,
  }
}

const promptTokensOf = (characters: number) => Math.ceil(characters / PROMPT_CHARS_PER_TOKEN_ESTIMATE)

// ── the rule's own arithmetic ──────────────────────────────────────────────

test('the bound is the window minus the prompt, and nothing is invented', () => {
  const bounded = boundOutputTokensToContext(64_000, 32_768, 400)
  assert.equal(bounded.promptTokens, 100)
  assert.equal(bounded.contextWindowTokens, 32_768)
  assert.equal(bounded.overflow, false)
  assert.equal(bounded.maxTokens, 32_668, 'the window is the tighter published figure')

  // The published ceiling is tighter than the window: it wins, unchanged.
  assert.equal(boundOutputTokensToContext(4_096, 32_768, 400).maxTokens, 4_096)
  // No ceiling requested: still no ceiling sent, even with a window published.
  assert.equal(boundOutputTokensToContext(null, 32_768, 400).maxTokens, null)
  // No published window: today's behaviour, byte for byte.
  assert.deepEqual(boundOutputTokensToContext(64_000, 0, 400), {
    maxTokens: 64_000,
    promptTokens: 100,
    contextWindowTokens: null,
    requestLimit: null,
    overflow: false,
    overflowLimit: null,
  })
  // The prompt alone leaves no room.
  const overflow = boundOutputTokensToContext(64_000, 32_768, 32_768 * PROMPT_CHARS_PER_TOKEN_ESTIMATE)
  assert.equal(overflow.overflow, true)
  assert.equal(overflow.promptTokens, 32_768)
})

// ── the wire ───────────────────────────────────────────────────────────────

test("a local product's window bounds the request, not its larger output ceiling", async () => {
  // The reported product, in the numbers that produced the defect: an output
  // ceiling larger than the whole window. 'long' resolves to 64,000 of 128,000.
  const characters = 400
  const result = await submitted(request(characters), { contextWindowTokens: 32_768, maxOutputTokens: 128_000 })
  assert.equal(result.submitted, true)
  assert.equal(result.maxOutputTokens, 32_768 - promptTokensOf(characters),
    'the answer may use the window that this prompt leaves, no more')
})

test('a prompt that does not fit is refused before the call, with both figures', async () => {
  const characters = 32_768 * PROMPT_CHARS_PER_TOKEN_ESTIMATE // exactly the whole window
  const originalFetch = globalThis.fetch
  let submittedCalls = 0
  let caught: unknown = null
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(32_768, 128_000))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      submittedCalls += 1
      return Response.json(chatJob())
    }
    keySeq += 1
    await callChatWithGenStudio(`window-key-${keySeq}`, request(characters)).catch((error: unknown) => { caught = error })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(submittedCalls, 0, 'nothing was submitted')
  assert.ok(caught instanceof Error)
  assert.match(caught.message, /32,768 tokens/, 'the prompt figure')
  assert.match(caught.message, /32,768-token context window/, 'the product figure')
  assert.match(caught.message, /No request or credit charge was made/)
})

test('a product that publishes no output ceiling still sends none', async () => {
  const result = await submitted(request(400), { contextWindowTokens: 32_768, maxOutputTokens: null })
  assert.equal(result.submitted, true)
  assert.equal(result.maxOutputTokens, undefined, 'the field is omitted, not invented')
})

test('a product that publishes no context window behaves exactly as before', async () => {
  const result = await submitted(request(400), { contextWindowTokens: null, maxOutputTokens: 65_536 })
  assert.equal(result.submitted, true)
  // 'long' of 65,536 is 32,768 — the value this workflow asked for before the rule.
  assert.equal(result.maxOutputTokens, 32_768)
})

test('a Khmer prompt is counted against the window at one token per character', async () => {
  // Characters ÷ 4 under-counts Khmer (written without spaces, several tokens per
  // character), so each non-ASCII character is a whole token. The same LENGTH in
  // English keeps the old ÷4 estimate, byte for byte.
  const characters = 100
  const khmer = await submitted({ modelId: 'writer-alpha', system: '', userMessage: 'ក'.repeat(characters), outputBudget: 'long', outputContract: jsonContract },
    { contextWindowTokens: 32_768, maxOutputTokens: 128_000 })
  const english = await submitted({ modelId: 'writer-alpha', system: '', userMessage: 'x'.repeat(characters), outputBudget: 'long', outputContract: jsonContract },
    { contextWindowTokens: 32_768, maxOutputTokens: 128_000 })
  assert.equal(khmer.maxOutputTokens, 32_768 - characters, 'every Khmer character is a token')
  assert.equal(english.maxOutputTokens, 32_768 - Math.ceil(characters / 4), 'English is unchanged')
  // The same arithmetic, measured directly.
  assert.equal(estimatePromptTokens(100, 100), 100)
  assert.equal(estimatePromptTokens(100, 0), 25)
  assert.equal(estimatePromptTokens(200, 100), 125, 'only the ASCII share is divided')
})

test('a model switch recomputes the bound from the newly selected product', async () => {
  const characters = 400
  const small = await submitted(request(characters), { contextWindowTokens: 32_768, maxOutputTokens: 128_000 })
  const large = await submitted(request(characters), { contextWindowTokens: 131_072, maxOutputTokens: 128_000 })
  assert.equal(small.maxOutputTokens, 32_768 - promptTokensOf(characters))
  assert.equal(large.maxOutputTokens, 64_000, 'the published 64,000 ceiling, now inside the window')
  assert.notEqual(small.maxOutputTokens, large.maxOutputTokens)
})

// ── the Gateway's published request ceiling (`max_request_tokens`) ────────
//
// Per model and per pool (the smallest of the enabled members'). It is the
// INPUT-side admission line: it never lowers the answer, and an absent value
// enforces nothing. The fleet's caller → published cap → 128,000 chain keeps
// its last link downstream; Story never substitutes 4,096 (or any number).

test('gemma-4: a fitting prompt keeps its 8,192-token answer and a prompt past 23,000 is refused', async () => {
  const gemma = { contextWindowTokens: 32_768, maxOutputTokens: 8_192, maxRequestTokens: 23_000 }
  const fits = await submitted(request(400, 'maximum'), gemma)
  assert.equal(fits.submitted, true)
  assert.equal(fits.maxOutputTokens, 8_192, 'the request ceiling never lowers the answer')

  // Exactly at the request ceiling: 23,000 ASCII characters ÷ 4 = 23,000 tokens.
  const atCap = await submitted(request(92_000, 'maximum'), gemma)
  assert.equal(atCap.submitted, true, 'a prompt at the line still fits')
  assert.equal(atCap.maxOutputTokens, 8_192)

  // One token past it: refused before anything is sent, with both figures.
  const characters = 92_004
  const originalFetch = globalThis.fetch
  let submittedCalls = 0
  let caught: unknown = null
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(32_768, 8_192, 23_000))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      submittedCalls += 1
      return Response.json(chatJob())
    }
    keySeq += 1
    await callChatWithGenStudio(`window-key-${keySeq}`, request(characters, 'maximum'))
      .catch((error: unknown) => { caught = error })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(submittedCalls, 0, 'nothing was submitted')
  assert.ok(caught instanceof Error)
  assert.match(caught.message, /23,001 tokens/, 'the prompt figure')
  assert.match(caught.message, /23,000-token request limit/, 'the published figure')
  assert.match(caught.message, /No request or credit charge was made/)
})

test('absent output and request caps stay unknown — no 4,096 and no substituted 128,000', async () => {
  // Gateway 227's story-llm pool publishes a 1,050,000-token window and no
  // output or request ceiling. The field is omitted; the Hub's own 128,000
  // fallback is the last link of the chain, never a number Story sends.
  const result = await submitted(
    request(400, 'maximum'),
    { contextWindowTokens: 1_050_000, maxOutputTokens: null },
  )
  assert.equal(result.submitted, true)
  assert.equal(result.maxOutputTokens, undefined, 'the ceiling is omitted, not invented')
  assert.notEqual(result.maxOutputTokens, 4_096)
  assert.notEqual(result.maxOutputTokens, 128_000)

  const bounded = boundOutputTokensToContext(128_000, 1_050_000, 400)
  assert.equal(bounded.requestLimit, null, 'no request ceiling was published, so none is enforced')
  assert.equal(bounded.maxTokens, 128_000, 'a large published window never shrinks the caller\'s allowance')
})

test('an explicit caller allowance wins below the published caps', async () => {
  const originalFetch = globalThis.fetch
  let requested: number | undefined
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog(32_768, 8_192, 23_000))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      requested = JSON.parse(String(init?.body)).max_output_tokens
      return Response.json(chatJob())
    }
    keySeq += 1
    await callChatWithGenStudio(`window-key-${keySeq}`, {
      ...request(400, 'maximum'),
      maxOutputTokens: 4_096,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requested, 4_096, 'the caller\'s number is not replaced by the tier')
})
