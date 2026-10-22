/**
 * The Gateway's job contract must survive the chat lane.
 *
 * Gateway 0.2.195 publishes the SAME `_contract_fields` on every route —
 * `dispatch_state`, `cancellable`, `cancellation_requested`, `cancelled` and
 * `waiting` — and `POST /v1/chat/responses/{id}/cancel` settles a writing job
 * like any other. Every other modality hands the raw envelope to the shared
 * recorder (`recordGenStudioEvidence`), which already knows how to store all
 * five.
 *
 * The chat lane was the exception: it built its evidence row BY HAND
 * (`chatJobEvidence`) and listed the fields it copied, so the contract fields
 * were dropped on the floor. What that cost, provably:
 *
 *  - A writing job's saved row carried no `dispatch_state`, so the Jobs
 *    control could not tell "not dispatched yet" from "I do not know" and
 *    answered "Checking provider status" with no button — a writing job could
 *    never be cancelled.
 *  - A writing job cancelled at the Gateway carried no `cancelled` flag, so
 *    the queue filed it as an ordinary provider FAILURE instead of a
 *    cancellation.
 *
 * These tests pin both directions: the published fields arrive EXACTLY as
 * published, and a field the Gateway did not publish stays ABSENT (never
 * invented as `false`/`null`).
 *
 * ZERO paid calls: a local fetch stub serves every envelope.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, describe, test } from 'node:test'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { callChatWithGenStudio, clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { classifyJobControl } from '../services/job-control.js'

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
const restores: Array<() => void> = []
const projects: string[] = []

const catalog = [{
  id: 'writer-alpha', display_name: 'Writer Alpha', available: true, qualification_only: false,
  context_window_tokens: 1_048_576, max_output_tokens: 65_536, controls: ['temperature', 'max_output_tokens'],
  activation_blockers: [], structured_output_mode: 'json_object', supports_structured_output: true,
}]
const overview = { paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 25, generation_submissions_per_minute: 30 }
const chatRequest = { modelId: 'writer-alpha', system: '', userMessage: 'Write something.', outputContract: { mode: 'json_object' } as const }

/** The Gateway's own contract fields, exactly as `_contract_fields` publishes them. */
const CONTRACT = {
  dispatch_state: 'pre_dispatch',
  cancellable: true,
  cancelled: false,
  cancellation_requested: false,
  waiting: { reason: 'Waiting for a free Mac', next_try_at: null, since: '2026-10-22T04:00:00.000Z' },
}

function envelope(fields: Record<string, unknown>) {
  return {
    operation: 'chat.response', model_id: 'writer-alpha', output_text: null, failure_code: null, credit_cost: 0,
    reserved_credits: 0, settled_credits: 0, released_credits: 0, ...fields,
  }
}

/**
 * POST answers 202 (a brand-new job); the GET answers with the settled
 * envelope, so the row the queue saves is the one the Gateway last published.
 *
 * `job` is published on both answers; `pollJob` only on the GET, which is how
 * a job's own contract moves between the submission and the poll.
 */
function stub(job: Record<string, unknown>, pollJob: Record<string, unknown> = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog)
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    const method = (init?.method || 'GET').toUpperCase()
    if (method === 'POST') return Response.json(envelope({ id: 'job_contract', state: 'accepted', ...job }), { status: 202 })
    return Response.json(envelope({ id: 'job_contract', state: 'failed', failure_code: 'PROVIDER_FAILED', ...job, ...pollJob }), { status: 200 })
  }
  return { restore: () => { globalThis.fetch = original } }
}

async function settleJob(jobId: string): Promise<Job> {
  // The shared wait helper (`_timing.ts`), not a fixed sleep: it polls for the
  // condition on a SCHEDULED-time budget, and its wall-clock backstop still
  // bounds a stuck fixture. The budget is the old poll cap (1 200 × 50 ms),
  // so a slow machine is not failed early. The same idiom waits for a queue
  // job in `job-unreconcilable-discard.test.ts`.
  await waitFor(() => {
    const job = jq.getJob(jobId)
    return !!job && !['queued', 'running'].includes(job.status) && !jq._isJobWorkerActiveForTesting(jobId)
  }, { label: `fixture job ${jobId} to settle`, timeoutMs: 60_000 })
  await jq._waitForJobPersistenceForTesting()
  return jq.getJob(jobId)!
}

/**
 * Run `work` inside a real queue job, so the job-level evidence record is
 * reachable. The job type is one with no completion auditor and no chat
 * resume, so this test measures the chat lane and nothing else.
 */
async function inJob(name: string, work: (job: Job) => Promise<void>): Promise<Job> {
  const project = await pm.createProject({ name })
  projects.push(project.slug)
  restores.push(jq._setExecutorForTesting('audio_merge', async job => {
    await work(job)
    throw new Error('fixture: the writing step failed after the request')
  }))
  const row = jq.enqueuePreparedForTest({
    project_slug: project.slug, episode_id: 'EP-CONTRACT', type: 'audio_merge', title: name,
    params: { model: 'writer-alpha', auto_retry: false },
  })
  return settleJob(row.job_id)
}

function chatEntryOf(job: Job): NonNullable<Job['genstudio_jobs']>[number] {
  const entry = (job.genstudio_jobs || []).find(item => item.operation === 'chat.response')
  assert.ok(entry, `expected a chat.response row, got ${JSON.stringify(job.genstudio_jobs)}`)
  return entry
}

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

afterEach(async () => {
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

test('the chat lane saves the contract fields the Gateway published', async () => {
  clearGenStudioCatalogCache()
  const s = stub(CONTRACT)
  try {
    const job = await inJob('Chat contract fields', async () => {
      await callChatWithGenStudio('k', chatRequest).catch(() => null)
    })
    const entry = chatEntryOf(job)
    assert.equal(entry.dispatch_state, 'pre_dispatch', 'the dispatch state crosses into the saved row')
    assert.equal(entry.cancellable, true, 'the Gateway\'s own cancellable answer crosses into the saved row')
    assert.equal(entry.cancelled, false)
    assert.equal(entry.cancellation_requested, false)
    assert.equal(entry.waiting?.reason, 'Waiting for a free Mac', 'the waiting reason crosses into the saved row')
  } finally { s.restore() }
})

test('a field the Gateway did not publish stays absent — never invented as false', async () => {
  clearGenStudioCatalogCache()
  const s = stub({})
  try {
    const job = await inJob('Chat contract absent', async () => {
      await callChatWithGenStudio('k', chatRequest).catch(() => null)
    })
    const entry = chatEntryOf(job)
    for (const field of ['dispatch_state', 'cancellable', 'cancelled', 'cancellation_requested']) {
      assert.equal(Object.hasOwn(entry, field), false, `${field} must not be invented`)
    }
    assert.equal(entry.waiting, null, 'no waiting reason was published, so none is stored')
  } finally { s.restore() }
})

test('a job the Gateway cancelled is terminal, and the saved row says cancelled', async () => {
  clearGenStudioCatalogCache()
  // The Gateway settles a cancelled job as `state: "cancelled"` with
  // `cancelled: true` beside it (`_job_envelope`, Gateway 0.2.195). A settled
  // job is no longer cancellable, so the contract answers that as well.
  const s = stub(CONTRACT, { state: 'cancelled', cancelled: true, cancellable: false, failure_code: 'CANCELLED' })
  let caught: unknown = null
  try {
    const job = await inJob('Chat cancelled', async () => {
      caught = await callChatWithGenStudio('k', chatRequest).catch((error: unknown) => error)
    })
    const entry = chatEntryOf(job)
    assert.equal(entry.cancelled, true, 'the Gateway\'s cancellation crosses into the saved row')
    assert.equal(entry.state, 'failed', 'a cancelled job is settled, not running')
    assert.equal(entry.failure_code, 'CANCELLED')
  } finally { s.restore() }
  assert.ok(caught, 'the writing request ended')
  assert.match(String((caught as Error).message), /This writing request was cancelled/)
})

test('a contract that moves while the job is still running is recorded, not swallowed', async () => {
  clearGenStudioCatalogCache()
  // The defect this pins: the state stays `running` across the whole dispatch
  // handover, so a poll guard that watched only the state kept the FIRST
  // contract forever — the saved row still claimed a cancel was honoured after
  // the Mac had taken the work.
  const original = globalThis.fetch
  let gets = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog)
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      return Response.json(envelope({ id: 'job_contract', state: 'accepted', ...CONTRACT }), { status: 202 })
    }
    gets++
    if (gets === 1) {
      // Running, still waiting for a Mac: a cancel would be honoured right now.
      return Response.json(envelope({ id: 'job_contract', state: 'running', ...CONTRACT }), { status: 200 })
    }
    if (gets === 2) {
      // A Mac took it. The state is STILL `running` — only the contract moved.
      return Response.json(envelope({
        id: 'job_contract', state: 'running', dispatch_state: 'dispatched',
        cancellable: false, cancellation_requested: false, waiting: null,
      }), { status: 200 })
    }
    return Response.json(envelope({
      id: 'job_contract', state: 'succeeded', output_text: '{"ok":true}',
      finish_reason: 'stop', output_retained: true,
    }), { status: 200 })
  }
  try {
    const job = await inJob('Chat contract moves', async () => {
      await callChatWithGenStudio('k', chatRequest).catch(() => null)
    })
    const entry = chatEntryOf(job)
    assert.equal(entry.state, 'succeeded', 'the writing request finished')
    assert.equal(entry.dispatch_state, 'dispatched', 'the live contract change is recorded')
    assert.equal(entry.cancellable, false, 'the row does not keep the stale pre-dispatch answer')
  } finally { globalThis.fetch = original }
})

test('the Gateway\'s published failure reason and class reach the saved row', async () => {
  clearGenStudioCatalogCache()
  const s = stub({}, { failure_code: 'PROVIDER_FAILED', failure_reason: 'The provider refused this prompt.', failure_class: 'provider_error' })
  let caught: unknown = null
  try {
    const job = await inJob('Chat failure words', async () => {
      caught = await callChatWithGenStudio('k', chatRequest).catch((error: unknown) => error)
    })
    const entry = chatEntryOf(job)
    assert.equal(entry.failure_reason, 'The provider refused this prompt.', 'the published reason is kept as published')
    assert.equal(entry.failure_class, 'provider_error', 'the published classification is kept as published')
  } finally { s.restore() }
  assert.match(String((caught as Error).message), /The provider refused this prompt\./)
})

describe('what the dropped fields cost the Jobs control', () => {
  const capabilities = { remoteCancellationAudited: true }

  function writingJob(entry: Record<string, unknown>) {
    return {
      status: 'running',
      type: 'expand_chapters',
      params: {},
      genstudio_jobs: [{
        id: 'gw-writing', operation: 'chat.response', state: 'accepted',
        updated_at: '2026-10-22T04:00:00.000Z', ...entry,
      }],
    } as unknown as Parameters<typeof classifyJobControl>[0]
  }

  test('a published pre-dispatch contract names a cancel target', () => {
    const control = classifyJobControl(writingJob(CONTRACT), capabilities)
    assert.equal(control.action, 'request-remote-cancel', 'the Gateway said a cancel is honoured now')
    assert.equal(control.enabled, true)
    assert.deepEqual(control.targets, [{ operation: 'chat.response', provider_job_id: 'gw-writing' }])
  })

  test('without the contract fields the same row can only be waited on', () => {
    // This is the defect, pinned: the same job, with the fields the Gateway
    // published simply not reaching the row, has no cancel target at all.
    // The production jobs of 2026-10-22 sat exactly here — their saved rows
    // carried no dispatch state, so the card said "Checking provider status"
    // while nothing was being checked, and Cancel answered 409.
    const control = classifyJobControl(writingJob({}), capabilities)
    assert.equal(control.action, 'return-later')
    assert.equal(control.enabled, false)
    assert.equal(control.label, 'Waiting for Gateway status',
      'the card must not name a check that is not running')
    assert.doesNotMatch(control.reason, /Checking/)
    assert.equal(control.targets, undefined)
  })

  test('a dispatched request the Gateway will not cancel says exactly that', () => {
    // The Gateway publishes `cancellable: false` for a chat job that is
    // already running (a chat job has no batch to cancel). Story follows the
    // Gateway's own answer instead of calling the state unknown.
    const control = classifyJobControl(writingJob({ dispatch_state: 'dispatched', cancellable: false }), capabilities)
    assert.equal(control.action, 'pause-submissions')
    assert.equal(control.code, 'PROVIDER_WORK_ALREADY_STARTED')
    assert.doesNotMatch(control.reason, /Checking/)
  })
})
