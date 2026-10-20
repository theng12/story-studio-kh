/**
 * Fault injection S2 — a network drop between Story and the Gateway, mid-submit and mid-poll.
 *
 * Zero paid calls: every response below is a hand-written envelope served by a local fetch stub.
 *
 * The invariant: a dropped connection never buys a second provider submission. The submission is
 * already paid for once the Gateway has accepted it, so the only safe move is to keep the identity
 * and reattach to the job — and the call must still end KNOWN.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { callChatWithGenStudio } from '../lib/genstudio-client.js'

function catalog() {
  return [{
    id: 'writer-alpha', display_name: 'Writer Alpha', available: true, qualification_only: false,
    context_window_tokens: 1_048_576, max_output_tokens: 65_536,
    controls: ['temperature', 'max_output_tokens'], activation_blockers: [],
    structured_output_mode: 'json_object', supports_structured_output: true,
  }]
}

function accountOverview() {
  return {
    paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0,
    max_queued_jobs: 25, generation_submissions_per_minute: 30,
  }
}

function job(fields: Record<string, unknown>) {
  return {
    id: 'job_drop_1', operation: 'chat.response', dispatch_mode: 'asynchronous',
    model_id: 'writer-alpha', output_text: null, output_retained: false, finish_reason: null,
    failure_code: null, routing_status_code: null, credit_cost: 0, remaining_credits: 900,
    idempotent_replay: false, ...fields,
  }
}

const baseRequest = {
  modelId: 'writer-alpha', system: '', userMessage: 'Write something.',
  outputContract: { mode: 'json_object' } as const,
}

/**
 * Serve one accepted job and count every distinct submission identity. `dropPolls` connections to
 * the poll GET are destroyed before the job is allowed to answer, so the client has to reattach
 * rather than resubmit.
 */
function stubAcceptedJobWithDroppedPolls(dropPolls: number) {
  const originalFetch = globalThis.fetch
  const providerKeys = new Set<string>()
  const pollPaths: string[] = []
  let posts = 0
  let remainingDrops = dropPolls
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
    if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      posts += 1
      providerKeys.add(String((init?.headers as Record<string, string>)['Idempotency-Key']))
      return Response.json(job({ state: 'running' }), { status: 202 })
    }
    pollPaths.push(new URL(url).pathname)
    if (remainingDrops-- > 0) throw new TypeError('fetch failed')
    return Response.json(job({ state: 'succeeded', output_text: '{"ok":true}', output_retained: true, finish_reason: 'stop' }))
  }
  return {
    providerKeys, pollPaths,
    posts: () => posts,
    restore: () => { globalThis.fetch = originalFetch },
  }
}

test('S2: one poll lost to a dropped connection is reattached, not resubmitted', async () => {
  const stub = stubAcceptedJobWithDroppedPolls(1)
  try {
    const result = await callChatWithGenStudio('mid-poll-drop-key', baseRequest)
    assert.deepEqual(JSON.parse(result.text), { ok: true })
    assert.equal(result.jobId, 'job_drop_1')
  } finally {
    stub.restore()
  }
  assert.equal(stub.posts(), 1, 'an accepted submission is never re-sent')
  assert.equal(stub.providerKeys.size, 1, 'exactly one provider submission identity may exist')
  assert.ok(stub.pollPaths.length >= 2, 'the lost poll was retried against the same job')
  assert.ok(stub.pollPaths.every(path => path === '/v1/chat/responses/job_drop_1'),
    'every reattach named the job the Gateway already accepted')
})

test('S2: a poll that never answers ends the call known, still without a second submission', async () => {
  // The Gateway is up but will not answer the job read (503, no retry hint) — the same fault a
  // dropped socket produces from the client's side, without the multi-second backoff a destroyed
  // connection costs.
  const originalFetch = globalThis.fetch
  const providerKeys = new Set<string>()
  let posts = 0
  let error: Error | null = null
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        posts += 1
        providerKeys.add(String((init?.headers as Record<string, string>)['Idempotency-Key']))
        return Response.json(job({ state: 'running' }), { status: 202 })
      }
      return Response.json({ detail: 'gateway restarting' }, { status: 503, headers: { 'retry-after': '0' } })
    }
    error = await callChatWithGenStudio('mid-poll-dead-key', baseRequest)
      .then(() => null, (caught: unknown) => caught as Error)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(error, 'a job that can never be read back must still end the call')
  assert.ok(error.message.trim().length > 0, 'the failure carries a reason, not a bare unknown')
  assert.equal(posts, 1, 'no amount of failed polling may buy a second submission')
  assert.equal(providerKeys.size, 1)
})
