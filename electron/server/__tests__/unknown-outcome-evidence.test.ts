/**
 * The Gateway holds a `failed` job it could not confirm (`recovery_required` / `recovery_state:
 * "unknown_outcome"`, `failure_code: UNKNOWN_OUTCOME`) for ~5 minutes in case a late result arrives.
 * Story must keep that evidence on the row it saves: it is what tells a Retry (or a replacement
 * check) that the outcome is UNKNOWN rather than a proven failure, so nothing is re-dispatched
 * while the first request may still be adopted and charged.
 *
 * Production (2026-10-19): Science EP15 story 26bde6a9 and Abiding Faith campaign 181c588b saved
 * rows with `state: "failed"` + `failure_code: "UNKNOWN_OUTCOME"` and BOTH recovery fields absent.
 * The chat lane's hand-built evidence row (`chatJobEvidence`) listed its fields by name and never
 * copied the hold across, so every reader that keys on the pair saw a plain known failure.
 *
 * ZERO paid calls: a local fetch stub serves every envelope.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import {
  UNKNOWN_OUTCOME_GRACE_MS,
  callChatWithGenStudio,
  clearGenStudioCatalogCache,
  evidenceHoldsUnknownOutcome,
} from '../lib/genstudio-client.js'

let tempDir: string
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

function envelope(fields: Record<string, unknown>) {
  return {
    operation: 'chat.response', model_id: 'writer-alpha', output_text: null, failure_code: null, credit_cost: 0,
    reserved_credits: 0, settled_credits: 0, released_credits: 0, ...fields,
  }
}

/** The Gateway's own held envelope: the code names the hold, and the pair carries it. */
const HELD = { id: 'job_held', state: 'failed', failure_code: 'UNKNOWN_OUTCOME', recovery_required: true, recovery_state: 'unknown_outcome' }
/** An ordinary, settled provider failure: no hold, nothing to preserve. */
const PLAIN = { id: 'job_plain', state: 'failed', failure_code: 'PROVIDER_FAILED' }

/** POST answers 202 (a brand-new job, never a replay); GETs answer with the same envelope. */
function stub(job: Record<string, unknown>) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(catalog)
    if (url.endsWith('/v1/account/overview')) return Response.json(overview)
    return Response.json(envelope(job), { status: (init?.method || 'GET').toUpperCase() === 'POST' ? 202 : 200 })
  }
  return { restore: () => { globalThis.fetch = original } }
}

/**
 * Wait for a fixture job to settle on real timers.
 *
 * `waitFor` budgets by `Date.now`, and the held case moves that clock past the grace window so the
 * 5-minute adoption wait does not make the suite wait five minutes.
 */
async function settleJob(jobId: string): Promise<Job> {
  for (let i = 0; i < 1_200; i++) {
    const job = jq.getJob(jobId)
    if (job && !['queued', 'running'].includes(job.status) && !jq._isJobWorkerActiveForTesting(jobId)) {
      await jq._waitForJobPersistenceForTesting()
      return jq.getJob(jobId)!
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('fixture job did not settle')
}

/** Run `work` inside a real queue job, so the job-level evidence record is reachable. */
async function inJob(name: string, work: (job: Job) => Promise<void>): Promise<Job> {
  const project = await pm.createProject({ name })
  projects.push(project.slug)
  restores.push(jq._setExecutorForTesting('expand_chapters', async job => {
    await work(job)
    throw new Error('fixture: the writing step failed after the request')
  }))
  const row = jq.enqueuePreparedForTest({
    project_slug: project.slug, episode_id: 'EP-HOLD', type: 'expand_chapters', title: name,
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
  tempDir = t.dir
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

test('a held chat envelope keeps recovery_required/recovery_state on the saved row', async () => {
  clearGenStudioCatalogCache()
  const s = stub(HELD)
  const realNow = Date.now
  // A held failure is not final inside its 5-minute grace window, so the wrapper keeps polling.
  // Move the clock on a step at a time (never once: the window is measured from when the hold was
  // first seen) so the wrapper gives up promptly instead of making this suite wait five minutes.
  let skew = 0
  const clock = setInterval(() => { skew += UNKNOWN_OUTCOME_GRACE_MS + 1_000 }, 5)
  Date.now = () => realNow() + skew
  try {
    const job = await inJob('Held chat evidence', async () => {
      await callChatWithGenStudio('k', chatRequest).catch(() => null)
      // The wait is over: put the real clock back before the queue settles the fixture job.
      clearInterval(clock)
      Date.now = realNow
    })
    const entry = chatEntryOf(job)
    assert.equal(entry.failure_code, 'UNKNOWN_OUTCOME')
    assert.equal(entry.recovery_required, true, 'the gateway hold crosses into the saved row')
    assert.equal(entry.recovery_state, 'unknown_outcome')
    assert.equal(evidenceHoldsUnknownOutcome(entry), true,
      'the reader a Retry and a replacement check use must see the unknown outcome, not a proven failure')
  } finally {
    clearInterval(clock)
    Date.now = realNow
    s.restore()
  }
})

test('a plain provider failure gains no hold fields (absent stays absent)', async () => {
  clearGenStudioCatalogCache()
  const s = stub(PLAIN)
  try {
    const job = await inJob('Plain failure evidence', async () => {
      await callChatWithGenStudio('k', chatRequest).catch(() => null)
    })
    const entry = chatEntryOf(job)
    assert.equal(entry.failure_code, 'PROVIDER_FAILED')
    assert.equal(Object.hasOwn(entry, 'recovery_required'), false, 'no recovery value is invented')
    assert.equal(Object.hasOwn(entry, 'recovery_state'), false)
    assert.equal(evidenceHoldsUnknownOutcome(entry), false)
  } finally { s.restore() }
})

/** A finalizer job whose one chat request failed; `generation_action` is what a Retry mints afresh. */
function finalizerJob(slug: string, jobId: string, chatEntry: Record<string, unknown>): Job {
  return {
    job_id: jobId,
    project_slug: slug,
    type: 'metadata',
    episode_id: 'EP0113',
    title: 'YouTube Finalizer',
    status: 'error',
    error: 'The writing service lost track of this request after it was sent.',
    created_at: '2026-10-19T06:49:50.000Z',
    started_at: '2026-10-19T06:49:55.000Z',
    finished_at: '2026-10-19T06:51:32.000Z',
    local_execution_complete: true,
    output_lines: [],
    params: {},
    remote_cancellations: {},
    genstudio_jobs: [{
      request: {
        method: 'POST', path: '/v1/chat/responses', captured_at: '2026-10-19T06:49:57.000Z',
        idempotency_key: 'story-chat-0f6d2c1b9a8e7d6c5b4a39281706f5e4d3c2b1a0918273',
      },
      updated_at: '2026-10-19T06:51:32.000Z',
      ...chatEntry,
    }],
  } as unknown as Job
}

async function retryJob(slug: string, job: Job) {
  await fs.mkdir(path.join(tempDir, 'projects', slug), { recursive: true })
  await fs.writeFile(path.join(tempDir, 'projects', slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
  await jq.getJobs(slug)
  const res = await request(app).post(`/api/projects/${slug}/jobs/${job.job_id}/retry`).send({})
  assert.equal(res.status, 202, JSON.stringify(res.body))
  return res.body.job as Job
}

test('a Retry of an unknown-outcome row keeps its saved request identity instead of asking afresh', async () => {
  await jq.setQueuePaused(true)
  const project = await pm.createProject({ name: 'Held retry identity' })
  projects.push(project.slug)
  const retried = await retryJob(project.slug, finalizerJob(project.slug, 'held-retry', {
    id: 'gw-held', operation: 'chat.response', state: 'failed', failure_code: 'UNKNOWN_OUTCOME',
    recovery_required: true, recovery_state: 'unknown_outcome',
  }))
  // Keeping the saved params keeps the content-derived key, so the Gateway replays the request it
  // already has (a read-only collect) rather than the app minting a second paid submission.
  assert.equal(retried.params?.generation_action, undefined,
    'an unknown outcome is not a proven failure: Retry must not mint a fresh request identity')
})

test('a Retry of an ordinary failure still asks for a new answer', async () => {
  await jq.setQueuePaused(true)
  const project = await pm.createProject({ name: 'Plain retry identity' })
  projects.push(project.slug)
  const retried = await retryJob(project.slug, finalizerJob(project.slug, 'plain-retry', {
    id: 'gw-plain', operation: 'chat.response', state: 'failed', failure_code: 'PROVIDER_FAILED',
  }))
  assert.equal((retried.params?.generation_action as { origin?: string } | undefined)?.origin, 'retry',
    'a settled failure keeps the existing behaviour: a fresh request identity')
})
