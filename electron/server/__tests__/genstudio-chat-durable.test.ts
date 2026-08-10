/**
 * The durable language route: `POST /v1/chat/responses` + poll.
 *
 * WHY LANGUAGE MOVED. Chat was the last modality still fire-and-hope: one
 * blocking `POST /v1/chat/completions`, and if the connection dropped after the
 * provider had taken the request there was nothing to reconnect to. Images,
 * video, TTS and transcription have all reconnected and recovered for
 * releases. Worse, a synchronous language failure arrives as
 * `{"detail": "language generation failed"}` with NO code, so Story Studio
 * could not tell `LANGUAGE_PROVIDER_FAILED` (safe to retry) from
 * `LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN` (resending risks a SECOND CHARGE).
 * `ChatJobResponse.failure_code` is what separates them.
 *
 * ZERO paid calls: every response below is a hand-written envelope served by a
 * local fetch stub. Nothing here touches GenStudio.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callChatWithGenStudio,
  GenStudioChatIncompleteError,
  GenStudioChatTerminalFailureError,
  isGenStudioSubmissionUncertain,
} from '../lib/genstudio-client.js'

function catalog(maxOutputTokens = 65_536) {
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

function job(fields: Record<string, unknown>) {
  return {
    id: 'job_durable_1',
    operation: 'chat.response',
    dispatch_mode: 'asynchronous',
    model_id: 'writer-alpha',
    output_text: null,
    output_retained: false,
    finish_reason: null,
    failure_code: null,
    routing_status_code: null,
    credit_cost: 0,
    remaining_credits: 900,
    idempotent_replay: false,
    ...fields,
  }
}

const baseRequest = {
  modelId: 'writer-alpha',
  system: '',
  userMessage: 'Write something.',
  outputContract: { mode: 'json_object' } as const,
}

/**
 * Serve one scripted job progression. The POST returns the FIRST state; each
 * subsequent GET returns the next, so the client has to actually poll to reach
 * a terminal state.
 */
function stubJobStates(states: Array<Record<string, unknown>>) {
  const originalFetch = globalThis.fetch
  const submits: Array<{ key: string; body: Record<string, unknown> }> = []
  const polls: string[] = []
  let index = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
    if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      submits.push({
        key: String((init?.headers as Record<string, string>)['Idempotency-Key']),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Response.json(job(states[0]!), { status: 202 })
    }
    polls.push(new URL(url).pathname)
    index = Math.min(index + 1, states.length - 1)
    return Response.json(job(states[index]!))
  }
  return {
    submits,
    polls,
    restore: () => { globalThis.fetch = originalFetch },
  }
}

// ── Submit, poll, settle ─────────────────────────────────────────────────

test('accepted → running → succeeded polls to a terminal state and returns output_text', async () => {
  const stub = stubJobStates([
    { state: 'accepted' },
    { state: 'running' },
    { state: 'succeeded', output_text: '{"ok":true}', output_retained: true, finish_reason: 'stop', credit_cost: 5 },
  ])
  const states: string[] = []
  const accepted: Array<[string, string]> = []
  try {
    const result = await callChatWithGenStudio('durable-happy-key', {
      ...baseRequest,
      onState: (state, jobId) => { states.push(`${state}:${jobId}`) },
      onJobAccepted: (jobId, key) => { accepted.push([jobId, key]) },
    })
    assert.deepEqual(JSON.parse(result.text), { ok: true })
    assert.equal(result.jobId, 'job_durable_1')
    assert.equal(result.modelId, 'writer-alpha')
  } finally {
    stub.restore()
  }

  // Submitted with the durable request shape and a route-legal key.
  assert.equal(stub.submits.length, 1)
  assert.equal(stub.submits[0]!.body.model_id, 'writer-alpha')
  assert.ok(Array.isArray(stub.submits[0]!.body.input))
  assert.ok(stub.submits[0]!.key.length >= 8 && stub.submits[0]!.key.length <= 128)

  // The caller learned the job id BEFORE the result existed — that is what
  // makes a crashed run reconnectable rather than repayable.
  assert.deepEqual(accepted, [['job_durable_1', stub.submits[0]!.key]])
  assert.deepEqual(stub.polls, ['/v1/chat/responses/job_durable_1', '/v1/chat/responses/job_durable_1'])
  assert.deepEqual(states, [
    'accepted:job_durable_1',
    'running:job_durable_1',
    'succeeded:job_durable_1',
  ])
})

test('a failed job is terminal and does not keep polling', async () => {
  const stub = stubJobStates([
    { state: 'running' },
    { state: 'failed', failure_code: 'LANGUAGE_PROVIDER_FAILED' },
  ])
  try {
    const error = await callChatWithGenStudio('durable-failed-key', baseRequest)
      .then(() => null, (err: unknown) => err)
    assert.ok(error instanceof GenStudioChatTerminalFailureError)
    assert.equal(error.failureCode, 'LANGUAGE_PROVIDER_FAILED')
  } finally {
    stub.restore()
  }
  // Exactly one poll reached `failed`, and the loop stopped there rather than
  // re-reading a record that can never change.
  assert.equal(stub.polls.length, 1)
  assert.equal(stub.submits.length, 1)
})

test('a lost submit response reattaches via the persisted key and submits once', async () => {
  // The first POST never answers (a dropped socket). The key is derived from
  // the request CONTENT, so the retry carries the identical `Idempotency-Key`
  // and GenStudio replays the running job instead of starting a second one.
  const originalFetch = globalThis.fetch
  const keys: string[] = []
  const providerJobs = new Set<string>()
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'POST') {
        const key = String((init?.headers as Record<string, string>)['Idempotency-Key'])
        keys.push(key)
        posts += 1
        // One provider job per DISTINCT key — a second key would be a second
        // charge, which is exactly what this test exists to catch.
        providerJobs.add(key)
        if (posts === 1) throw new TypeError('fetch failed')
        return Response.json(job({ state: 'running', idempotent_replay: true }), { status: 202 })
      }
      return Response.json(job({
        state: 'succeeded', output_text: '{"ok":true}', finish_reason: 'stop',
      }))
    }
    const result = await callChatWithGenStudio('durable-lost-key', baseRequest)
    assert.deepEqual(JSON.parse(result.text), { ok: true })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 2, 'the lost submission must be retried')
  assert.equal(new Set(keys).size, 1, 'both POSTs must carry the same idempotency key')
  assert.equal(providerJobs.size, 1, 'exactly ONE provider submission may exist')
})

// ── failure_code branching ───────────────────────────────────────────────

test('SUBMISSION_UNCERTAIN is never auto-resubmitted and says to check the account', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  let polls = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts += 1
        return Response.json(job({ state: 'running' }), { status: 202 })
      }
      polls += 1
      return Response.json(job({
        state: 'failed', failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
      }))
    }
    const error = await callChatWithGenStudio('durable-uncertain-key', baseRequest)
      .then(() => null, (err: unknown) => err)
    assert.ok(error instanceof GenStudioChatTerminalFailureError)
    assert.equal(isGenStudioSubmissionUncertain(error), true)
    assert.match(error.message, /could not confirm/i)
    assert.match(error.message, /Check the run in your\s+GenStudio account before resubmitting/i)
    assert.match(error.message, /did NOT retry it automatically/)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 1, 'an uncertain outcome must never produce a second submission')
  assert.equal(polls, 1, 'and must not be re-polled after it settles')
})

test('a non-stop finish_reason rejects instead of returning partial text', async () => {
  const stub = stubJobStates([
    { state: 'running' },
    {
      state: 'succeeded',
      // Valid JSON — only the finish reason says this was cut short.
      output_text: '{"summary":"half a thou',
      finish_reason: 'length',
    },
  ])
  try {
    const error = await callChatWithGenStudio('durable-truncated-key', baseRequest)
      .then(result => result as unknown, (err: unknown) => err)
    assert.ok(error instanceof GenStudioChatIncompleteError)
    assert.equal(error.truncated, true)
    assert.equal(error.finishReason, 'length')
    assert.match(error.message, /cut off/i)
    // The partial is carried for a caller's own completion audit (chunked
    // narration preserves the units that DID finish) but is never the result.
    assert.equal(error.partialText, '{"summary":"half a thou')
  } finally {
    stub.restore()
  }
})

// ── The pre-network guards ───────────────────────────────────────────────

test('every "no request or credit charge was made" guard runs before any fetch', async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  try {
    globalThis.fetch = async () => {
      fetches += 1
      throw new Error('the guard must fire before the network')
    }
    // These three are decided from the request alone.
    for (const [label, request] of [
      ['empty model', { ...baseRequest, modelId: '  ' }],
      ['empty input', { ...baseRequest, userMessage: '   ' }],
      ['image input', { ...baseRequest, inputImage: { assetId: 'a', detail: 'auto' as const } }],
    ] as const) {
      await assert.rejects(callChatWithGenStudio('guard-key', request), /./, label)
    }
    assert.equal(fetches, 0, 'request-only guards must not touch the network at all')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('catalogue-dependent guards read the catalogue but submit nothing', async () => {
  const originalFetch = globalThis.fetch
  let submits = 0
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) {
        return Response.json([
          ...catalog(8_192),
          { ...catalog()[0], id: 'retired-alpha', available: false },
        ])
      }
      submits += 1
      throw new Error(`unexpected submission to ${url}`)
    }
    await assert.rejects(
      callChatWithGenStudio('guard-catalog-key', { ...baseRequest, modelId: 'retired-alpha' }),
      /is not available.*No request or credit charge was made/i,
    )
    await assert.rejects(
      callChatWithGenStudio('guard-catalog-key', { ...baseRequest, maxOutputTokens: 8_193 }),
      /8,192-token limit.*No request or credit charge was made/i,
    )
    assert.equal(submits, 0, 'nothing may be submitted once a guard has refused')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── Latency and cancellation ─────────────────────────────────────────────

test('cancelling stops the poll loop without submitting anything else', async () => {
  const originalFetch = globalThis.fetch
  let cancelled = false
  let posts = 0
  let polls = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts += 1
        return Response.json(job({ state: 'accepted' }), { status: 202 })
      }
      polls += 1
      return Response.json(job({ state: 'running' }))
    }
    const queueStates: string[] = []
    await assert.rejects(
      callChatWithGenStudio('durable-cancel-key', {
        ...baseRequest,
        isCancelled: () => cancelled,
        onQueueState: state => { queueStates.push(state) },
        // Cancel the moment the job is durably accepted — the job stays
        // GenStudio-owned and reconnectable by id; only local polling stops.
        onJobAccepted: () => { cancelled = true },
      }),
      /Cancelled by user/,
    )
    assert.ok(queueStates.includes('cancelled'))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 1, 'cancelling must never submit a replacement job')
  assert.equal(polls, 0, 'cancellation is checked before the next poll')
})

test('an already-aborted signal never reaches the network', async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      fetches += 1
      return Response.json(job({ state: 'running' }), { status: 202 })
    }
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      callChatWithGenStudio('durable-abort-key', { ...baseRequest, signal: controller.signal }),
      /Cancelled by user/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(fetches, 0)
})
