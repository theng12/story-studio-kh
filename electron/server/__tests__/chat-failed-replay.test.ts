/**
 * A Retry re-POSTs the same content-derived key, and the gateway answers with
 * the OLD job for that key. When that old job already failed (settled, no hold)
 * Retry used to replay the failure forever — the owner's Research / Scene
 * Review jobs "failing in 1 s" after the gateway 0.2.97/0.2.98 pool bug.
 *
 * ZERO paid calls: a local fetch stub serves every envelope.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { callChatWithGenStudio, chatKeyAfterFailedReplay } from '../lib/genstudio-client.js'

const catalog = [{
  id: 'writer-alpha', display_name: 'Writer Alpha', available: true, qualification_only: false,
  context_window_tokens: 1_048_576, max_output_tokens: 65_536, controls: ['temperature', 'max_output_tokens'],
  activation_blockers: [], structured_output_mode: 'json_object', supports_structured_output: true,
}]
const overview = { paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 25, generation_submissions_per_minute: 30 }
const request = { modelId: 'writer-alpha', system: '', userMessage: 'Write something.', outputContract: { mode: 'json_object' } as const }

function envelope(fields: Record<string, unknown>) {
  // The gateway publishes a balanced zero settlement on every job.
  return { operation: 'chat.response', model_id: 'writer-alpha', output_text: null, failure_code: null, credit_cost: 0,
    reserved_credits: 0, settled_credits: 0, released_credits: 0, ...fields }
}

/** `byKey` answers each POST by its Idempotency-Key; GETs return `poll`. */
function stub(byKey: (key: string, n: number) => Record<string, unknown>, poll: Record<string, unknown>, models: unknown[] = catalog) {
  const original = globalThis.fetch
  const keys: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(models)
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      const key = String((init?.headers as Record<string, string>)['Idempotency-Key'])
      keys.push(key)
      const answer = byKey(key, keys.length)
      // The gateway answers a replayed key 200 and a new job 202.
      return Response.json(envelope(answer), { status: answer.state === 'failed' ? 200 : 202 })
    }
    return Response.json(envelope(poll))
  }
  return { keys, restore: () => { globalThis.fetch = original } }
}

const ok = { id: 'job_fresh', state: 'succeeded', output_text: '{"ok":true}', finish_reason: 'stop', output_retained: true }

test('a replayed settled failure is resubmitted once under a key derived from the failed job', async () => {
  const s = stub((_key, n) => n === 1
    ? { id: 'job_old_failed', state: 'failed', failure_code: 'PROVIDER_FAILED' }
    : { id: 'job_fresh', state: 'accepted' }, ok)
  try {
    const result = await callChatWithGenStudio('k', request)
    assert.deepEqual(JSON.parse(result.text), { ok: true })
  } finally { s.restore() }
  assert.equal(s.keys.length, 2)
  assert.equal(s.keys[1], chatKeyAfterFailedReplay(s.keys[0]!, 'job_old_failed'))
  assert.notEqual(s.keys[1], s.keys[0])
})

test('a replayed failure the gateway still holds (unknown outcome) is never resubmitted', async () => {
  const s = stub(() => ({ id: 'job_held', state: 'failed', failure_code: 'PROVIDER_FAILED', recovery_required: true, recovery_state: 'unknown_outcome' }),
    { ...ok, id: 'job_held' })
  try {
    await callChatWithGenStudio('k', request)
  } finally { s.restore() }
  assert.equal(s.keys.length, 1, 'a held job may still settle or charge, so no second POST')
})

test('a replayed failure that charged keeps one paid submission per click', async () => {
  const s = stub(() => ({ id: 'job_charged', state: 'failed', failure_code: 'PROVIDER_FAILED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }), ok)
  try {
    await callChatWithGenStudio('k', request).catch(() => null)
  } finally { s.restore() }
  assert.equal(s.keys.length, 1)
})

test('an uncertain-submission replay is never resubmitted', async () => {
  const s = stub(() => ({ id: 'job_uncertain', state: 'failed', failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' }), ok)
  try {
    await callChatWithGenStudio('k', request).catch(() => null)
  } finally { s.restore() }
  assert.equal(s.keys.length, 1)
})

test('a brand-new job that fails on submit (202, not a replay) is not resubmitted', async () => {
  const original = globalThis.fetch
  let posts = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog)
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    if ((init?.method || 'GET').toUpperCase() === 'POST') posts++
    return Response.json(envelope({ id: 'job_new_failed', state: 'failed', failure_code: 'PROVIDER_FAILED' }), { status: 202 })
  }
  try {
    await callChatWithGenStudio('k', request).catch(() => null)
  } finally { globalThis.fetch = original }
  assert.equal(posts, 1)
})

test('a caller-supplied key is never moved, even after a settled failure', async () => {
  const s = stub(() => ({ id: 'job_old_failed', state: 'failed', failure_code: 'PROVIDER_FAILED' }), ok)
  try {
    await callChatWithGenStudio('k', { ...request, idempotencyKey: 'exact-replay-key' }).catch(() => null)
  } finally { s.restore() }
  assert.deepEqual(s.keys, ['exact-replay-key'])
})

// Owner decision 2026-10-03: a FREE model's held failure is redone fresh; paid or unknown keeps the lock.
const held = { id: 'job_held', state: 'failed', failure_code: 'PROVIDER_FAILED', recovery_required: true, recovery_state: 'unknown_outcome' }
for (const [label, chargeable, expectedPosts] of [
  ['free (chargeable: false)', false, 2],
  ['paid (chargeable: true)', true, 1],
  ['unpublished chargeability', undefined, 1],
] as const) {
  test(`a held replay on a ${label} model ${expectedPosts === 2 ? 'is resubmitted fresh' : 'keeps its lock'}`, async () => {
    const models = [{ ...catalog[0], ...(chargeable === undefined ? {} : { chargeable }) }]
    const s = stub((_key, n) => n === 1 ? held : { id: 'job_fresh', state: 'accepted' },
      expectedPosts === 2 ? ok : { ...ok, id: 'job_held' }, models)
    try {
      await callChatWithGenStudio('k', request).catch(() => null)
    } finally { s.restore() }
    assert.equal(s.keys.length, expectedPosts)
    if (expectedPosts === 2) assert.equal(s.keys[1], chatKeyAfterFailedReplay(s.keys[0]!, 'job_held'))
  })
}

test('a free model\'s held replay is redone fresh even under a caller-supplied key (Retry of a lineup step)', async () => {
  const s = stub((_key, n) => n === 1 ? held : { id: 'job_fresh', state: 'accepted' }, ok, [{ ...catalog[0], chargeable: false }])
  try {
    const result = await callChatWithGenStudio('k', { ...request, idempotencyKey: 'lineup-checkpoint-key' })
    assert.deepEqual(JSON.parse(result.text), { ok: true })
  } finally { s.restore() }
  assert.deepEqual(s.keys, ['lineup-checkpoint-key', chatKeyAfterFailedReplay('lineup-checkpoint-key', 'job_held')])
})
