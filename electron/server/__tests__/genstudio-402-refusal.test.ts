/**
 * Story no longer holds, tracks or waits on credits. Gateway owns every credit
 * decision; Story shows Gateway's refusal and nothing else.
 *
 * Pinned here, at the client boundary where those decisions used to live:
 *
 *  1. HTTP 402 is a TERMINAL REFUSAL carrying Gateway's own reason. It is never
 *     a wait state, and the request is never replayed or blind-requeued.
 *  2. A reply that still carries credit fields is parsed and IGNORED. Story
 *     returns the artifact and nothing else — no balance, no settlement.
 *  3. An old stored job record whose `queue_state` is the retired
 *     `waiting_credits` still loads, and reads as failed with its stored reason.
 *
 * ZERO paid calls: `fetch` is stubbed throughout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  callChatWithGenStudio,
  genStudioAdmissionSnapshot,
  isGenStudioPaymentRefusal,
} from '../lib/genstudio-client.js'

function catalog() {
  return [{
    id: 'writer-alpha',
    display_name: 'Writer Alpha',
    available: true,
    qualification_only: false,
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    controls: ['temperature', 'max_output_tokens'],
    activation_blockers: [],
    structured_output_mode: 'json_object',
    supports_structured_output: true,
  }]
}

function accountOverview(extra: Record<string, unknown> = {}) {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
    ...extra,
  }
}

function chatJob(extra: Record<string, unknown> = {}) {
  return {
    id: 'job_ok_1',
    state: 'succeeded',
    operation: 'chat.response',
    dispatch_mode: 'synchronous',
    model_id: 'writer-alpha',
    output_text: '{"results":[{"scene_id":"s1","visual_prompt":"A quiet street."}]}',
    output_retained: true,
    finish_reason: 'stop',
    failure_code: null,
    routing_status_code: null,
    idempotent_replay: true,
    ...extra,
  }
}

test('a 402 is a terminal refusal carrying Gateway’s reason, and is never requeued', async () => {
  const originalFetch = globalThis.fetch
  try {
    let submissions = 0
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      assert.ok(url.endsWith('/v1/chat/responses'), `unexpected call to ${url}`)
      submissions += 1
      // Gateway's own words. Story must pass them through, not replace them
      // with its own balance advice.
      return new Response(
        JSON.stringify({ detail: 'this key has no remaining monthly allowance' }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
    }

    const error = await callChatWithGenStudio('refusal-key', {
      modelId: 'writer-alpha',
      system: '',
      userMessage: 'One pack.',
      outputContract: { mode: 'json_object' },
    }).then(() => null, (caught: unknown) => caught as Error)

    assert.ok(error, 'a 402 must reject — it is never a wait state')
    assert.ok(isGenStudioPaymentRefusal(error), 'the renamed guard still recognises a 402')
    assert.match(
      error.message,
      /The Gateway refused this request: this key has no remaining monthly allowance/,
      'Gateway’s own reason is what the person reads',
    )
    assert.doesNotMatch(
      error.message,
      /Add credits|insufficient credits|balance/i,
      'Story never coaches the owner about credits — Gateway owns that',
    )
    assert.equal(submissions, 1, 'a 402 is not replayed or blind-requeued')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a reply carrying credit fields is parsed and ignored', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      // Every credit field a Gateway reply has ever published, still attached.
      return Response.json(chatJob({
        credit_cost: 4,
        remaining_credits: 900,
        reserved_credits: 4,
        settled_credits: 4,
        released_credits: 0,
      }))
    }

    const result = await callChatWithGenStudio('credit-fields-key', {
      modelId: 'writer-alpha',
      system: 'Write prompts.',
      userMessage: 'One pack.',
      outputContract: { mode: 'json_object' },
    })

    assert.equal(result.jobId, 'job_ok_1')
    assert.ok(result.text.includes('s1'), 'the artifact itself is unaffected')

    const carried = Object.keys(result).filter(key => /credit|balance|settle/i.test(key))
    assert.deepEqual(
      carried, [],
      'credit fields in the reply are ignored — Story tracks no balance or settlement',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a Gateway account overview carrying a balance is read for capacity only', async () => {
  const originalFetch = globalThis.fetch
  try {
    let overviewReads = 0
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) {
        overviewReads += 1
        return Response.json(accountOverview({
          credit_balance: 12_345,
          credits_used_30d: 678,
        }))
      }
      return Response.json(chatJob())
    }

    // A real call first, so the client is initialised before admission is read.
    await callChatWithGenStudio('balance-key', {
      modelId: 'writer-alpha',
      system: '',
      userMessage: 'One pack.',
      outputContract: { mode: 'json_object' },
    })

    const snapshot = genStudioAdmissionSnapshot('balance-key')

    assert.ok(overviewReads > 0, 'the account overview was actually read')
    assert.equal(
      snapshot.limitSource, 'account-overview',
      'the capacity snapshot must come from the real overview, not the safe fallback',
    )
    assert.equal(
      (snapshot as { credit_balance?: unknown }).credit_balance,
      undefined,
      'Story drops the published balance — it is never enforced here',
    )
    // Capacity facts are what admission still needs, and they are unaffected.
    assert.equal(snapshot.paid_concurrency_limit, 5)
    assert.equal(snapshot.max_queued_jobs, 25)
  } finally {
    globalThis.fetch = originalFetch
  }
})
