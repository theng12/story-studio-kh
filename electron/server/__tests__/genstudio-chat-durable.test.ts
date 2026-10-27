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
  GenStudioApiError,
  GenStudioChatIncompleteError,
  GenStudioChatRecoveryUnresolvedError,
  GenStudioChatTerminalFailureError,
  isGenStudioSubmissionUncertain,
  lostChatResendKey,
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

test('SUBMISSION_UNCERTAIN is resent once fresh, then stops and says so (owner 2026-10-12)', async () => {
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
    assert.match(error.message, /lost track of this request/i)
    assert.match(error.message, /Generate this step again/)
    assert.match(error.message, /did not send it again by itself/)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 2, 'an uncertain outcome gets exactly one fresh resend, never a third submission')
  assert.equal(polls, 2, 'and neither settled job is re-polled')
})

test('an uncertain historical chat submission is reconciled by idempotency key, then resent once fresh', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  const states: string[] = []
  const accepted: string[] = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts += 1
        assert.equal((init?.headers as Record<string, string>)['Idempotency-Key'],
          lostChatResendKey('historical-uncertain-key', 'job_historical_uncertain'))
        return Response.json(job({ id: 'job_resent', state: 'running' }), { status: 202 })
      }
      if (new URL(url).pathname === '/v1/chat/responses/job_resent') {
        return Response.json(job({ id: 'job_resent', state: 'failed', failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' }))
      }
      assert.equal(
        new URL(url).pathname,
        '/v1/chat/responses/by-idempotency-key/historical-uncertain-key',
      )
      return Response.json(job({
        id: 'job_historical_uncertain',
        state: 'failed',
        failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
        credit_cost: 0,
        remaining_credits: 900,
      }))
    }
    const error = await callChatWithGenStudio('durable-reconcile-key', {
      ...baseRequest,
      idempotencyKey: 'historical-uncertain-key',
      recoverByIdempotencyKey: true,
      onJobAccepted: id => { accepted.push(id) },
      onState: (state, id) => { states.push(`${state}:${id}`) },
    }).then(() => null, (reason: unknown) => reason)
    assert.ok(error instanceof GenStudioChatTerminalFailureError)
    assert.equal(error.failureCode, 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 1, 'a lost historical request gets exactly one fresh resend')
  assert.deepEqual(accepted, ['job_historical_uncertain', 'job_resent'])
  assert.equal(states[0], 'failed:job_historical_uncertain')
  assert.equal(states.at(-1), 'failed:job_resent')
})

test('an ambiguous 502 submission is reconciled by idempotency key, and a lost one is resent once', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  let lookups = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts += 1
        return Response.json({ detail: 'submission outcome uncertain' }, { status: 502 })
      }
      lookups += 1
      assert.equal(
        new URL(url).pathname,
        `/v1/chat/responses/by-idempotency-key/${lookups === 1 ? 'ambiguous-502-key'
          : lostChatResendKey('ambiguous-502-key', 'job_reconciled_after_502')}`,
      )
      return Response.json(job({
        id: 'job_reconciled_after_502',
        state: 'failed',
        failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
        credit_cost: 0,
        remaining_credits: 900,
      }))
    }
    const error = await callChatWithGenStudio('durable-ambiguous-502-key', {
      ...baseRequest,
      idempotencyKey: 'ambiguous-502-key',
    }).then(() => null, (reason: unknown) => reason)
    assert.ok(error instanceof GenStudioChatTerminalFailureError)
    assert.equal(error.failureCode, 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 2, 'the lost original gets one fresh resend, never a third POST')
  assert.equal(lookups, 2, 'each key is reconciled with one read-only lookup')
})

test('an unknown historical idempotency key stays locked and never creates fresh work', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts += 1
        throw new Error('unknown recovery must not fall through to POST')
      }
      assert.equal(
        new URL(url).pathname,
        '/v1/chat/responses/by-idempotency-key/missing-historical-key',
      )
      return Response.json({ detail: 'Not found' }, { status: 404 })
    }
    await assert.rejects(
      callChatWithGenStudio('durable-reconcile-key', {
        ...baseRequest,
        idempotencyKey: 'missing-historical-key',
        recoverByIdempotencyKey: true,
      }),
      /could not find the earlier language submission/i,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 0, 'unknown recovery must preserve its identity instead of submitting anew')
})

test('saved recovery key bypasses a later lower catalogue ceiling and never posts', async () => {
  const originalFetch = globalThis.fetch
  let modelReads = 0
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) {
        modelReads += 1
        return Response.json(catalog(1))
      }
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts += 1
        throw new Error('saved recovery must never submit a replacement')
      }
      assert.equal(new URL(url).pathname, '/v1/chat/responses/by-idempotency-key/prepared-primary-key')
      return Response.json(job({
        state: 'succeeded', output_text: '{"ok":true}', output_retained: true, finish_reason: 'stop',
      }))
    }
    const result = await callChatWithGenStudio('durable-recovery-key', {
      ...baseRequest,
      // This is deliberately above the now-published ceiling. It was valid
      // when the POST was prepared; recovery must use its saved provider key,
      // not reject that historical request against today's catalogue.
      maxOutputTokens: 8_192,
      idempotencyKey: 'prepared-primary-key',
      recoverByIdempotencyKey: true,
      allowedRecoveryKeys: ['prepared-primary-key'],
    })
    assert.deepEqual(JSON.parse(result.text), { ok: true })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(modelReads, 0, 'read-only recovery must not re-size the old POST')
  assert.equal(posts, 0, 'read-only recovery must not create a replacement')
})

test('a transport failure during recovery stays unresolved and never creates fresh work', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  let lookups = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts++
        throw new Error('recovery must not replace a transport-uncertain request')
      }
      lookups++
      throw new TypeError('network connection was reset')
    }
    const error = await callChatWithGenStudio('durable-transport-recovery-key', {
      ...baseRequest,
      idempotencyKey: 'transport-uncertain-key',
      recoverByIdempotencyKey: true,
    }).then(() => null, (reason: unknown) => reason)
    assert.ok(error instanceof GenStudioChatRecoveryUnresolvedError)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(posts, 0)
  assert.equal(lookups, 4, 'transport lookup is retried but never converted into a replacement POST')
})

for (const [status, detail] of [
  [400, 'Request is invalid'],
  [401, 'API key is invalid'],
  [402, 'Insufficient credits'],
  [403, 'Missing chat:generate scope'],
  [405, 'Method is not allowed'],
  [409, 'Request conflicts with the current state'],
  [422, 'model_id is invalid'],
  [429, 'Account capacity is full'],
  [500, 'Language provider failed'],
  [503, 'Language product is temporarily unavailable'],
] as const) {
  test(`a definitive ${status} recovery lookup stays actionable instead of becoming unresolved`, async () => {
    const originalFetch = globalThis.fetch
    let posts = 0
    let lookups = 0
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input)
        if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
        if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
        if ((init?.method || 'GET').toUpperCase() === 'POST') {
          posts++
          throw new Error('recovery must never create replacement work')
        }
        lookups++
        return Response.json({ detail }, { status, headers: { 'Retry-After': '0' } })
      }
      const error = await callChatWithGenStudio('durable-actionable-recovery-key', {
        ...baseRequest,
        idempotencyKey: `actionable-recovery-${status}`,
        recoverByIdempotencyKey: true,
      }).then(() => null, (reason: unknown) => reason)
      assert.ok(error instanceof GenStudioApiError)
      assert.equal(error.status, status)
      assert.equal(error instanceof GenStudioChatRecoveryUnresolvedError, false)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(posts, 0)
    assert.equal(lookups, 1, 'a definitive recovery response is not retried or resubmitted')
  })
}

test('a definitive credit refusal stays actionable and does not probe by idempotency key', async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      paths.push(new URL(url).pathname)
      assert.equal((init?.method || 'GET').toUpperCase(), 'POST')
      return Response.json({ detail: 'Insufficient credits' }, { status: 402 })
    }
    await assert.rejects(
      callChatWithGenStudio('durable-credit-key', {
        ...baseRequest,
        idempotencyKey: 'definitive-credit-refusal',
      }),
      /Insufficient credits/i,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(paths.length >= 1)
  assert.ok(paths.every(path => path === '/v1/chat/responses'))
})

test('a release-disabled response stays actionable and does not probe by idempotency key', async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      paths.push(new URL(url).pathname)
      assert.equal((init?.method || 'GET').toUpperCase(), 'POST')
      return Response.json({ detail: 'Language generation is unavailable during this release' }, { status: 503 })
    }
    await assert.rejects(
      callChatWithGenStudio('durable-release-key', {
        ...baseRequest,
        idempotencyKey: 'release-disabled-refusal',
      }),
      /unavailable during this release/i,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(paths.length >= 1)
  assert.ok(paths.every(path => path === '/v1/chat/responses'))
})

test('cancelling a recovery lookup remains cancelled instead of becoming unresolved', async () => {
  const originalFetch = globalThis.fetch
  let cancelled = false
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      assert.match(new URL(url).pathname, /\/by-idempotency-key\/cancelled-recovery-key$/)
      cancelled = true
      throw new Error('Cancelled by user')
    }
    await assert.rejects(
      callChatWithGenStudio('durable-cancelled-recovery-key', {
        ...baseRequest,
        idempotencyKey: 'cancelled-recovery-key',
        recoverByIdempotencyKey: true,
        isCancelled: () => cancelled,
      }),
      /Cancelled by user/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
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

test('the durable incomplete failure preserves partial text for bounded chapter repair', async () => {
  const partial = '{"chapters":[{"n":1,"title":"Finished"}]}'
  const stub = stubJobStates([{
    state: 'failed',
    output_text: partial,
    output_retained: true,
    finish_reason: 'length',
    failure_code: 'LANGUAGE_PROVIDER_INCOMPLETE',
  }])
  try {
    const error = await callChatWithGenStudio('durable-incomplete-code-key', baseRequest)
      .then(result => result as unknown, (err: unknown) => err)
    assert.ok(error instanceof GenStudioChatIncompleteError)
    assert.equal(error.partialText, partial)
    assert.equal(error.finishReason, 'length')
    assert.equal(error.truncated, true)
    assert.match(error.message, /cut off/i)
  } finally {
    stub.restore()
  }
})

test('an empty durable language response stays an explicit manual retry', async () => {
  const stub = stubJobStates([{
    state: 'succeeded',
    output_text: null,
    output_retained: true,
    finish_reason: 'stop',
  }])
  try {
    const error = await callChatWithGenStudio('durable-empty-output-key', baseRequest)
      .then(result => result as unknown, (err: unknown) => err)
    assert.ok(error instanceof Error)
    assert.match(error.message, /did not automatically resubmit/i)
    assert.match(error.message, /Retry/i)
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
      // A picture that is not a data URI, and one that carries no digest, are
      // caller bugs: both are refused before the catalogue is even read.
      ['image without a data URI', { ...baseRequest, inputImage: { dataUri: 'a', sha256: 'a'.repeat(64) } }],
      ['image without a digest', { ...baseRequest, inputImage: { dataUri: 'data:image/jpeg;base64,AAAA', sha256: 'x' } }],
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
      /isn't available right now.*Nothing was sent or charged/i,
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
