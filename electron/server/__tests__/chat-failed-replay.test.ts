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
import { callChatWithGenStudio, chatKeyAfterFailedReplay, clearGenStudioCatalogCache, lostChatResendKey } from '../lib/genstudio-client.js'

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
      // The gateway answers 202 for a job it just created and 200 for one it
      // already had — so any settled job (failed, cancelled) is an old one.
      return Response.json(envelope(answer), { status: answer.state === 'accepted' ? 202 : 200 })
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

test('a replayed cancellation is submitted again under a key derived from the cancelled job', async () => {
  // A cancelled job is terminal: it can never produce output, so a Retry that
  // re-POSTed the same content-derived key would replay the same cancellation
  // on every click and the step could never be sent again.
  const s = stub((_key, n) => n === 1
    ? { id: 'job_old_cancelled', state: 'cancelled', cancelled: true, failure_code: 'CANCELLED' }
    : { id: 'job_fresh', state: 'accepted' }, ok)
  try {
    const result = await callChatWithGenStudio('k', request)
    assert.deepEqual(JSON.parse(result.text), { ok: true })
  } finally { s.restore() }
  assert.equal(s.keys.length, 2, 'a cancelled job can never answer, so the Retry sends a fresh request')
  assert.equal(s.keys[1], chatKeyAfterFailedReplay(s.keys[0]!, 'job_old_cancelled'))
  assert.notEqual(s.keys[1], s.keys[0])
})

// The refusals. A cancelled job is only ever sent again when Story can PROVE
// the stopped attempt cost nothing: missing, charged or held evidence all keep
// the key and the single submission, because a second request could be charged
// again or could race an attempt the Gateway still holds.
test('a cancelled replay with no published settlement is not sent again', async () => {
  // The Gateway published no settlement at all: Story cannot prove the stopped
  // attempt cost nothing, so the conservative answer is to keep the key.
  const cancelled = {
    id: 'job_old_cancelled', state: 'cancelled', cancelled: true, failure_code: 'CANCELLED',
    reserved_credits: undefined, settled_credits: undefined, released_credits: undefined,
  }
  const s = stub(() => cancelled, cancelled)
  try {
    await callChatWithGenStudio('k', request).catch(() => null)
  } finally { s.restore() }
  assert.equal(s.keys.length, 1, 'no settlement proof, so no successor is minted')
})

test('a cancelled replay that already charged is not sent again', async () => {
  const cancelled = {
    id: 'job_old_cancelled', state: 'cancelled', cancelled: true, failure_code: 'CANCELLED',
    reserved_credits: 9, settled_credits: 3, released_credits: 6,
  }
  const s = stub(() => cancelled, cancelled)
  try {
    await callChatWithGenStudio('k', request).catch(() => null)
  } finally { s.restore() }
  assert.equal(s.keys.length, 1, 'a cancelled job that charged keeps one paid submission per click')
})

test('a cancelled replay the Gateway still holds is not sent again', async () => {
  const cancelled = {
    id: 'job_old_cancelled', state: 'cancelled', cancelled: true, failure_code: 'CANCELLED',
    recovery_required: true, recovery_state: 'unknown_outcome',
  }
  const s = stub(() => cancelled, cancelled)
  try {
    await callChatWithGenStudio('k', request).catch(() => null)
  } finally { s.restore() }
  assert.equal(s.keys.length, 1, 'a held job may still be adopted, so it is never sent again')
})

test('a recovery-only reattach of a cancelled job never submits a successor', async () => {
  // Recovery is a read-only lookup of a saved key: it must not turn into a new
  // paid submission, and it must not mint a successor key either.
  const cancelled = { id: 'job_cancelled', state: 'cancelled', cancelled: true, failure_code: 'CANCELLED' }
  const s = stub(() => cancelled, cancelled)
  try {
    await callChatWithGenStudio('k', {
      ...request, recoverByIdempotencyKey: true, idempotencyKey: 'saved-key', allowedRecoveryKeys: ['saved-key'],
    }).catch(() => null)
  } finally { s.restore() }
  assert.deepEqual(s.keys, [], 'recovery never posts')
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

test('an uncertain-submission replay adopts the original answer without another POST', async () => {
  const s = stub(() => ({ id: 'job_uncertain', state: 'failed', failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' }), ok)
  let error: unknown
  try {
    await callChatWithGenStudio('k', request).catch(caught => { error = caught })
  } finally { s.restore() }
  assert.deepEqual(s.keys, [s.keys[0]])
  assert.equal(error, undefined)
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

// Unknown outcomes keep their identity for every model, including free ones.
const held = { id: 'job_held', state: 'failed', failure_code: 'PROVIDER_FAILED', recovery_required: true, recovery_state: 'unknown_outcome' }
for (const [label, chargeable, expectedPosts] of [
  ['free (chargeable: false)', false, 1],
  ['paid (chargeable: true)', true, 1],
  ['unpublished chargeability', undefined, 1],
] as const) {
  test(`a held replay on a ${label} model keeps its lock`, async () => {
    const models = [{ ...catalog[0], ...(chargeable === undefined ? {} : { chargeable }) }]
    clearGenStudioCatalogCache()
    const s = stub((_key, n) => n === 1 ? held : { id: 'job_fresh', state: 'accepted' },
      { ...ok, id: 'job_held' }, models)
    try {
      await callChatWithGenStudio('k', request).catch(() => null)
    } finally { s.restore() }
    assert.equal(s.keys.length, expectedPosts)
  })
}

test('a free model\'s held replay recovers under its caller-supplied key (Retry of a Pipeline step)', async () => {
  clearGenStudioCatalogCache()
  const s = stub((_key, n) => n === 1 ? held : { id: 'job_fresh', state: 'accepted' }, ok, [{ ...catalog[0], chargeable: false }])
  try {
    const result = await callChatWithGenStudio('k', { ...request, idempotencyKey: 'pipeline-checkpoint-key' })
    assert.deepEqual(JSON.parse(result.text), { ok: true })
  } finally { s.restore() }
  assert.deepEqual(s.keys, ['pipeline-checkpoint-key'])
})

// Original-key reconciliation must precede any new writing work.
/** POSTs answer by key; GETs answer by job id (or the saved-key lookup). */
function lostStub(posts: Record<string, unknown>[], byId: Record<string, Record<string, unknown>>) {
  const original = globalThis.fetch
  const keys: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json([{ ...catalog[0], chargeable: true }])
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      keys.push(String((init?.headers as Record<string, string>)['Idempotency-Key']))
      return Response.json(envelope(posts[keys.length - 1]!), { status: 202 })
    }
    const id = decodeURIComponent(url.split('/').pop()!)
    return Response.json(envelope(byId[id] ?? byId['by-key']!))
  }
  return { keys, restore: () => { globalThis.fetch = original } }
}
const lost = (id: string) => ({ id, state: 'failed', failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })

test('a paid writing request lost after submission adopts its recovered answer without another POST', async () => {
  clearGenStudioCatalogCache()
  const s = lostStub([{ id: 'job_lost', state: 'accepted' }, { id: 'job_fresh', state: 'accepted' }],
    { job_lost: lost('job_lost'), 'by-key': { ...ok, id: 'job_lost' } })
  try {
    const result = await callChatWithGenStudio('k', request)
    assert.deepEqual(JSON.parse(result.text), { ok: true })
  } finally { s.restore() }
  assert.deepEqual(s.keys, [s.keys[0]])
})

test('a saved unknown request keeps its original identity without a POST', async () => {
  clearGenStudioCatalogCache()
  const s = lostStub([{ id: 'job_fresh', state: 'accepted' }], { 'by-key': lost('job_saved'), job_fresh: ok })
  try {
    await assert.rejects(callChatWithGenStudio('k', {
      ...request, recoverByIdempotencyKey: true, idempotencyKey: 'saved-key', allowedRecoveryKeys: ['saved-key'],
    }), /lost track of this request/i)
  } finally { s.restore() }
  assert.deepEqual(s.keys, [])
})

test('recovering a saved resend that was lost too stops instead of sending a third request', async () => {
  clearGenStudioCatalogCache()
  const saved = lostChatResendKey('saved-key', 'job_saved')
  const s = lostStub([], { 'by-key': lost('job_resent') })
  let error: unknown
  try {
    await callChatWithGenStudio('k', { ...request, recoverByIdempotencyKey: true, idempotencyKey: saved, allowedRecoveryKeys: [saved] })
      .catch(caught => { error = caught })
  } finally { s.restore() }
  assert.equal(s.keys.length, 0)
  assert.match(String(error), /lost track of this request/i)
})
