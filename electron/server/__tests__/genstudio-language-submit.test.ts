/**
 * A language submission must outlive the control-plane timeout, and must be
 * reattachable when it does not.
 *
 * THE INCIDENT (EP0067): nine scene-prompt packs, all nine generated correctly
 * by GenStudio, all nine settled, all nine charged — 131 credits — and not one
 * of them retrievable. Story Studio's job log said only "saved 0/40" and
 * "automatic repair was not started".
 *
 * WHY. `POST /v1/chat/responses` answers 202 and carries `Location` +
 * `Retry-After`, so it reads like a submit-then-poll route. It is not: on the
 * product-first path GenStudio executes the model INLINE on the request thread
 * (`ProductChatCompletionService.complete` → `provider.complete(...)`, job
 * record stamped `DispatchMode.SYNCHRONOUS`) and returns only when generation
 * finishes. Story Studio bound that POST to
 * `GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS` — 30 seconds — while the nine packs
 * took 33 to 86 seconds each. Every one aborted mid-generation.
 *
 * WHY IT WAS UNRECOVERABLE. The abort is a network error, so the client
 * retried the POST on the same Idempotency-Key. GenStudio answered 429
 * `capacity_reason: request_in_progress` — correctly, the job WAS running — and
 * that refusal carries no job id (`ProductChatConcurrencyError` has no field
 * for one), no `Location`, and no endpoint anywhere in the API looks a job up
 * by idempotency key. Story Studio threw, so it never recorded a job id, never
 * polled, and left the finished work stranded.
 *
 * Two things are pinned here: the submit is no longer bounded by the control
 * timeout, and `request_in_progress` is treated as the reattachment signal it
 * is rather than a failure. Replaying the SAME key cannot start a second job —
 * GenStudio resolves the key against the existing record and returns that job's
 * stored output once it succeeds — so replay recovers paid work instead of
 * buying it twice.
 *
 * ZERO paid calls: `fetch` is stubbed throughout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  callChatWithGenStudio,
  GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
  languageSubmitTimeoutMs,
} from '../lib/genstudio-client.js'
import {
  LANGUAGE_TIMEOUT_MINUTES_DEFAULT,
  LANGUAGE_TIMEOUT_MINUTES_MIN,
} from '../services/app-settings.js'

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

function accountOverview() {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
  }
}

function chatJob(outputText: string) {
  return {
    id: 'job_product_1',
    state: 'succeeded',
    operation: 'chat.response',
    dispatch_mode: 'synchronous',
    model_id: 'writer-alpha',
    output_text: outputText,
    output_retained: true,
    finish_reason: 'stop',
    failure_code: null,
    routing_status_code: null,
    credit_cost: 4,
    remaining_credits: 900,
    idempotent_replay: true,
  }
}

/** GenStudio's exact `request_in_progress` refusal — body and headers. */
function requestInProgress() {
  return new Response(
    JSON.stringify({
      detail: 'language generation is busy',
      capacity_reason: 'request_in_progress',
      retry_after_seconds: 1,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'Retry-After': '1',
        'X-GenStudio-Capacity-Reason': 'request_in_progress',
      },
    },
  )
}

test('a language submission is not bounded by the control-plane timeout', async () => {
  // The control timeout is right for a job GET or a cancel. It is wrong for a
  // POST that runs a model, and 30s is shorter than an ordinary 40-scene pack.
  assert.equal(GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, 30_000)
  assert.ok(
    await languageSubmitTimeoutMs() >= 10 * 60_000,
    'a submission that executes the model inline needs minutes, not seconds',
  )
  // The dial cannot be turned down far enough to reintroduce the incident:
  // its floor is minutes, and the pack that was lost took 86 seconds.
  assert.ok(
    LANGUAGE_TIMEOUT_MINUTES_MIN * 60_000 > GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS * 4,
    'the lowest the owner can set must still be far above a 40-scene pack',
  )
  // The owner's ruling of 2026-08-29: 30 minutes out of the box.
  assert.equal(LANGUAGE_TIMEOUT_MINUTES_DEFAULT, 30)
})

test('an in-progress submission is reattached, not abandoned', async () => {
  const originalFetch = globalThis.fetch
  const submitKeys: string[] = []
  try {
    let submissions = 0
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      assert.ok(url.endsWith('/v1/chat/responses'), `unexpected call to ${url}`)
      submitKeys.push(String(new Headers(init?.headers).get('Idempotency-Key')))
      submissions += 1
      // First POST: the socket died and the job is still running server-side.
      if (submissions === 1) return requestInProgress()
      // Second POST on the same key: GenStudio replays the settled job.
      return Response.json(chatJob('{"results":[{"scene_id":"s1","visual_prompt":"A quiet street."}]}'))
    }

    const result = await callChatWithGenStudio('reattach-key', {
      modelId: 'writer-alpha',
      system: 'Write prompts.',
      userMessage: 'One pack.',
      outputContract: { mode: 'json_object' },
    })

    assert.equal(submissions, 2, 'the submission is replayed, not given up on')
    assert.equal(submitKeys.length, 2)
    assert.equal(
      submitKeys[0], submitKeys[1],
      'the SAME idempotency key is replayed — a new key would buy a second job',
    )
    assert.deepEqual(
      JSON.parse(result.text),
      { results: [{ scene_id: 's1', visual_prompt: 'A quiet street.' }] },
      'the already-paid-for output is recovered',
    )
    assert.equal(result.jobId, 'job_product_1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a refusal that is not request_in_progress is still a failure', async () => {
  const originalFetch = globalThis.fetch
  try {
    let submissions = 0
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      submissions += 1
      return new Response(JSON.stringify({ detail: 'balance too low' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      })
    }
    await assert.rejects(
      () => callChatWithGenStudio('credit-key', {
        modelId: 'writer-alpha',
        system: '',
        userMessage: 'One pack.',
        outputContract: { mode: 'json_object' },
      }),
      /insufficient credits/i,
      'the reattachment loop must not swallow an ordinary refusal',
    )
    assert.equal(submissions, 1, 'a 402 is not replayed')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an account-locked teaser model is refused before any generation POST', async () => {
  const originalFetch = globalThis.fetch
  let submissions = 0
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) {
        return Response.json([{ ...catalog()[0], locked: true, lock_reason: 'requires_paid_account' }])
      }
      submissions += 1
      throw new Error(`unexpected paid request to ${url}`)
    }
    await assert.rejects(
      () => callChatWithGenStudio('locked-key', {
        modelId: 'writer-alpha',
        system: '',
        userMessage: 'One pack.',
        outputContract: { mode: 'json_object' },
      }),
      /isn't available right now/i,
    )
    assert.equal(submissions, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
