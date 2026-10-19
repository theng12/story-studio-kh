/**
 * A settled Gateway answer this app REJECTED LOCALLY must not be replayed on the next attempt
 * (Nature EP0013, 2026-10-19).
 *
 * The chat idempotency key is derived from request content. That is what makes a lost response
 * free to retry — and it is also what made a locally-rejected answer replay forever: the same
 * step rebuilt the same request, reached the same key, and the Gateway handed back the same
 * unusable text on every attempt until the retry budget ran out (job 72570b56, auto_retry 3/3).
 * The DM0008 outline (2026-10-16) was the same loop.
 *
 * The fix is recorded on the JOB: `rejected_idempotency_keys` holds every content-derived key
 * whose settled answer this app refused, and the next attempt derives a fresh key instead of
 * submitting one of them again. A transport failure or an unknown outcome records NOTHING — those
 * have no answer to judge, and replaying their key is exactly what stops a duplicate paid call.
 *
 * ZERO paid calls: a local fetch stub serves every envelope.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import {
  callChatWithGenStudio,
  chatKeyAfterRejectedAnswer,
  chatKeySkippingRejectedAnswers,
  clearGenStudioCatalogCache,
} from '../lib/genstudio-client.js'

let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let cleanup: () => Promise<void>
const restores: Array<() => void> = []
const projects: string[] = []

const catalog = [{
  id: 'writer-alpha', display_name: 'Writer Alpha', available: true, qualification_only: false,
  context_window_tokens: 1_048_576, max_output_tokens: 65_536, controls: ['temperature', 'max_output_tokens'],
  activation_blockers: [], structured_output_mode: 'json_object', supports_structured_output: true,
}]
const overview = { paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 25, generation_submissions_per_minute: 30 }
const request = { modelId: 'writer-alpha', system: '', userMessage: 'Write something.', outputContract: { mode: 'json_object' } as const }

function envelope(fields: Record<string, unknown>) {
  return { operation: 'chat.response', model_id: 'writer-alpha', output_text: null, failure_code: null, credit_cost: 0,
    reserved_credits: 0, settled_credits: 0, released_credits: 0, ...fields }
}

/** The exact rejection Nature EP0013 hit: complete, settled, and unreadable. */
const unreadable = { id: 'job_unreadable', state: 'succeeded', output_text: '{"thumbnails": [', finish_reason: 'stop', output_retained: true }
const readable = { id: 'job_readable', state: 'succeeded', output_text: '{"ok": true}', finish_reason: 'stop', output_retained: true }

/** `byKey` answers each POST by its Idempotency-Key; GETs answer from `get`. */
function stub(
  byKey: (key: string, n: number) => Record<string, unknown>,
  get: (url: string) => Response,
) {
  const original = globalThis.fetch
  const keys: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog)
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      const key = String((init?.headers as Record<string, string>)['Idempotency-Key'])
      keys.push(key)
      const answer = byKey(key, keys.length)
      return Response.json(envelope(answer), { status: 202 })
    }
    return get(url)
  }
  return { keys, restore: () => { globalThis.fetch = original } }
}

/** Run `work` inside a real queue job context, so the job-level record is reachable. */
async function inJob(name: string, work: (job: Job) => Promise<void>): Promise<Job> {
  const project = await pm.createProject({ name })
  projects.push(project.slug)
  restores.push(jq._setExecutorForTesting('expand_chapters', async job => {
    await work(job)
    // The step that asked for the writing fails in production too; ending the job in `error` also
    // keeps the success audit out of a fixture that writes no artifacts.
    throw new Error('fixture: the writing step failed after the request')
  }))
  const row = jq.enqueuePreparedForTest({
    project_slug: project.slug, episode_id: 'EP-REJ', type: 'expand_chapters', title: name,
    params: { model: 'writer-alpha', auto_retry: false },
  })
  await waitFor(
    () => !['queued', 'running'].includes(jq.getJob(row.job_id)?.status ?? 'queued')
      && !jq._isJobWorkerActiveForTesting(row.job_id),
    { label: 'rejected-answer job settled' },
  )
  await jq._waitForJobPersistenceForTesting()
  return jq.getJob(row.job_id)!
}

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})
afterEach(async () => {
  // Park the queue first, then clear anything the fixtures left waiting — the Retry fixture
  // enqueues a second job, and letting it run would write after the temp data dir is gone.
  await jq.setQueuePaused(true)
  await jq._waitForJobPersistenceForTesting()
  for (const slug of projects) {
    for (const row of await jq.getJobs(slug)) {
      if (row.status === 'queued') await jq.forceAbandonJob(slug, row.job_id).catch(() => {})
    }
  }
  while (restores.length) restores.pop()!()
  await jq.setQueuePaused(false)
  await jq._waitForJobPersistenceForTesting()
})
after(async () => { await jq._waitForJobPersistenceForTesting(); await cleanup() })

test('a key whose settled answer was rejected locally is never submitted again', async () => {
  clearGenStudioCatalogCache()
  const s = stub((_key, n) => n === 1 ? unreadable : readable, () => Response.json(envelope(readable)))
  let firstKey = ''
  let secondKey = ''
  let recorded: string[] | undefined
  try {
    await inJob('Rejected answer fresh key', async job => {
      // Attempt 1: the Gateway answers, this app refuses the text.
      await callChatWithGenStudio('k', request).then(
        () => { throw new Error('the unreadable answer should have been rejected') },
        () => { /* rejected locally, as in production */ },
      )
      firstKey = s.keys[0]!
      // Attempt 2 of the SAME job: the generator rebuilds the identical request.
      await callChatWithGenStudio('k', request)
      secondKey = s.keys[1]!
      // The job's own record is what makes the difference, so surface it to the assertions.
      recorded = job.rejected_idempotency_keys
    })
    assert.equal(s.keys.length, 2, 'the second attempt asked the Gateway again instead of replaying')
    assert.notEqual(secondKey, firstKey)
    assert.equal(secondKey, chatKeyAfterRejectedAnswer(firstKey))
    assert.deepEqual(recorded, [firstKey])
  } finally { s.restore() }
})

test('the rejection reaches the job log in plain words', async () => {
  clearGenStudioCatalogCache()
  const s = stub(() => unreadable, () => Response.json(envelope(unreadable)))
  try {
    const job = await inJob('Rejected answer message', async () => {
      await callChatWithGenStudio('k', request).catch(() => null)
    })
    assert.ok(
      job.output_lines.includes("The writing model's answer could not be read; asking again with a fresh request."),
      `expected the plain message, got: ${JSON.stringify(job.output_lines)}`,
    )
  } finally { s.restore() }
})

test('an ambiguous submission records nothing, so the same key is still replayed', async () => {
  clearGenStudioCatalogCache()
  const original = globalThis.fetch
  const keys: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog)
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      keys.push(String((init?.headers as Record<string, string>)['Idempotency-Key']))
      // 502 is GenStudio's documented ambiguous submission: never re-POSTed by machine.
      return new Response('{}', { status: 502 })
    }
    // The read-only lookup finds no such job.
    return new Response('{}', { status: 404 })
  }
  try {
    const job = await inJob('Transport unknown keeps key', async () => {
      await callChatWithGenStudio('k', request).catch(() => null)
      await callChatWithGenStudio('k', request).catch(() => null)
    })
    assert.equal(keys.length, 2)
    assert.equal(keys[1], keys[0], 'an unknown outcome must keep its identity, or the paid call doubles')
    assert.equal(job.rejected_idempotency_keys, undefined)
  } finally { globalThis.fetch = original }
})

test('a caller-supplied key is never moved, even after a local rejection', async () => {
  clearGenStudioCatalogCache()
  const s = stub(() => unreadable, () => Response.json(envelope(unreadable)))
  try {
    await inJob('Caller key never moved', async () => {
      await callChatWithGenStudio('k', { ...request, idempotencyKey: 'exact-replay-key' }).catch(() => null)
      await callChatWithGenStudio('k', { ...request, idempotencyKey: 'exact-replay-key' }).catch(() => null)
    })
    assert.deepEqual(s.keys, ['exact-replay-key', 'exact-replay-key'])
  } finally { s.restore() }
})

test('an explicit Retry carries the rejected keys onto its new job', async () => {
  clearGenStudioCatalogCache()
  const s = stub(() => unreadable, () => Response.json(envelope(unreadable)))
  try {
    const job = await inJob('Retry carries rejected keys', async () => {
      await callChatWithGenStudio('k', request).catch(() => null)
    })
    const rejected = job.rejected_idempotency_keys
    assert.equal(rejected?.length, 1)
    const retried = jq.retryTerminalJob(job.project_slug, job.job_id)
    assert.deepEqual(retried.rejected_idempotency_keys, rejected,
      'a Retry that starts with an empty list walks straight back into the answer already refused')
  } finally { s.restore() }
})

test('the derivation is stable, and skipping a chain never lands on a rejected key', () => {
  const k = 'story-chat-abcdef'
  assert.equal(chatKeySkippingRejectedAnswers(k, []), k)
  assert.equal(chatKeySkippingRejectedAnswers(k, undefined), k)
  assert.equal(chatKeySkippingRejectedAnswers(k, ['someone-elses-key']), k)
  const once = chatKeySkippingRejectedAnswers(k, [k])
  assert.equal(once, chatKeyAfterRejectedAnswer(k))
  // Deterministic: a restart recomputes the same successor instead of a third key.
  assert.equal(chatKeySkippingRejectedAnswers(k, [k]), once)
  // Chained: a successor that was itself rejected is stepped over.
  assert.equal(chatKeySkippingRejectedAnswers(k, [k, once]), chatKeyAfterRejectedAnswer(once))
  assert.notEqual(chatKeyAfterRejectedAnswer(once), once)
  assert.match(once, /^story-chat-[0-9a-f]{47}$/)
})
