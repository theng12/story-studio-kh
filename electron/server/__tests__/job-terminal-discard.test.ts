/**
 * Terminal DISCARD (owner, 2026-11-15): "discard must be terminal … it also
 * leads to gateway terminally discard the job as well."
 *
 * Four proofs:
 *   1. a stuck `running` row ends terminal with its evidence retained;
 *   2. the Gateway is actually called for a row that has a linked Gateway job,
 *      and its own answer is surfaced (including `declined`);
 *   3. a row whose linked Gateway job is already terminal settles itself, with
 *      no Discard press — and says the verdict came from the Gateway;
 *   4. a second discard changes nothing.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { router as jobsRouter } from '../routes/jobs.js'

const VERDICT_LINE = 'Story Studio reconciled this row from the Gateway\'s terminal verdict; no provider outcome was invented.'

let tempDir: string
let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let setApiKey: (name: string, value: string) => Promise<void>
let app: express.Express

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  setApiKey = (await import('../services/app-secrets-store.js')).setApiKey
  const { setGenStudioUrl } = await import('../services/app-settings.js')
  await setGenStudioUrl('https://gateway.discard.test')
  // The reconciler refuses to run without a key, so the auto-reconcile proof
  // needs one present; every Gateway call in this file is intercepted.
  await setApiKey('genstudio', 'discard-test-key')
  app = express().use(express.json()).use('/api', jobsRouter)
})

after(async () => {
  await jq._waitForJobPersistenceForTesting().catch(() => {})
  await cleanup()
})

function liveRow(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    job_id: `discard-${Math.random().toString(36).slice(2, 10)}`,
    project_slug: slug,
    type: 'chapter-only',
    episode_id: 'EP-DISCARD',
    title: 'Stuck row',
    status: 'running',
    created_at: '2026-11-15T00:00:00.000Z',
    started_at: '2026-11-15T00:00:01.000Z',
    finished_at: null,
    error: null,
    output_lines: ['the log this row already had'],
    params: {},
    genstudio_jobs: [],
    remote_cancellations: {},
    ...overrides,
  }
}

/** A row already sitting at `running` in jobs.json, for the boot-scan proofs. */
async function seed(slug: string, rows: unknown[]): Promise<void> {
  const directory = path.join(tempDir, 'projects', slug)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify({ jobs: rows }))
}

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('Timed out waiting for the row to settle')
}

test('a stuck running row ends terminal, with its evidence and log retained', async () => {
  const project = await pm.createProject({ name: 'DiscardEnds' })
  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'chapter-only', episode_id: 'EP1', title: 't', params: {},
  })
  jq._setJobRecordForTesting(job.job_id, {
    status: 'running',
    output_lines: ['the log this row already had'],
  })

  const response = await request(app)
    .post(`/api/projects/${project.slug}/jobs/${job.job_id}/discard`)
    .send({ reason: 'stuck' })
    .expect(200)

  assert.equal(response.body.ok, true)
  assert.equal(response.body.already_terminal, false)
  const row = jq.getJob(job.job_id)!
  assert.equal(row.status, 'cancelled', 'the row ENDS; it is not hidden or deleted')
  assert.equal(row.discarded?.by, 'Story Studio')
  assert.equal(row.discarded?.reason, 'stuck')
  assert.ok(row.output_lines.join('\n').includes('the log this row already had'), 'the log is retained')
  assert.ok(row.output_lines.join('\n').includes('Discarded at your request'))
  assert.equal(response.body.upstream, 'none')
  assert.match(response.body.detail, /never sent anything to the Gateway/)
})

test('the Gateway is called for a linked Gateway job and its answer is surfaced', async () => {
  const project = await pm.createProject({ name: 'DiscardGateway' })
  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'chapter-only', episode_id: 'EP2', title: 't', params: {},
  })
  jq._setJobRecordForTesting(job.job_id, {
    status: 'running',
    genstudio_jobs: [{
      id: 'gw-linked-1', operation: 'voice.tts', state: 'running',
      updated_at: new Date().toISOString(),
    }],
  })

  const original = globalThis.fetch
  const calls: Array<{ path: string; body: unknown; auth: string | undefined }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body || '{}')),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    })
    return Response.json({
      ok: true, discarded: true, already_terminal: false, upstream: 'declined',
      detail: 'The lane says this job cannot be discarded upstream, so it was closed here only.',
      job: { id: 'gw-linked-1' },
    })
  }
  try {
    const response = await request(app)
      .post(`/api/projects/${project.slug}/jobs/${job.job_id}/discard`)
      .send({ reason: 'upstream is gone' })
      .expect(200)
    const discards = calls.filter(call => call.path.endsWith('/discard'))
    assert.deepEqual(
      discards.map(call => call.path),
      ['/admin/api/jobs/gw-linked-1/discard'],
      `exactly one Gateway discard call, got ${JSON.stringify(calls)}`,
    )
    assert.deepEqual(discards[0]!.body, { by: 'Story Studio', reason: 'upstream is gone' })
    assert.equal(discards[0]!.auth, 'Bearer discard-test-key')
    assert.equal(response.body.upstream, 'declined', "Gateway's own word, not a Story guess")
    assert.match(response.body.detail, /cannot be discarded upstream/)
    assert.equal(response.body.already_terminal, false)
    assert.equal(jq.getJob(job.job_id)!.status, 'cancelled', 'Story ends even though the Gateway declined')
  } finally {
    globalThis.fetch = original
  }
})

test('a row whose linked Gateway job is already terminal reconciles on its own', async () => {
  const slug = 'discard-reconcile'
  await seed(slug, [liveRow(slug, {
    job_id: 'discard-auto-1',
    genstudio_jobs: [{
      id: 'gw-already-terminal', operation: 'voice.tts', state: 'succeeded',
      updated_at: '2026-11-15T00:05:00.000Z',
    }],
  })])

  // The real boot scan: this row has no cancellation record, so before this
  // change it fell through to "interrupted by restart" and never reconciled.
  await jq.getJobs(slug)
  await waitFor(() => {
    const row = jq.getJob('discard-auto-1')
    return !!row && ['done', 'error', 'cancelled'].includes(row.status)
  })

  const row = jq.getJob('discard-auto-1')!
  assert.ok(['done', 'error', 'cancelled'].includes(row.status), `expected a terminal row, got ${row.status}`)
  assert.ok(
    row.output_lines.join('\n').includes(VERDICT_LINE),
    `expected the Gateway-verdict line, got: ${row.output_lines.join(' | ')}`,
  )
  assert.equal(row.genstudio_jobs?.[0]?.state, 'succeeded', 'the provider evidence is untouched')
  assert.equal(row.discarded, undefined, 'nothing was discarded — it settled itself')
})

test('a second discard changes nothing', async () => {
  const project = await pm.createProject({ name: 'DiscardTwice' })
  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'chapter-only', episode_id: 'EP3', title: 't', params: {},
  })
  jq._setJobRecordForTesting(job.job_id, { status: 'running' })

  const first = await request(app)
    .post(`/api/projects/${project.slug}/jobs/${job.job_id}/discard`)
    .send({ reason: 'stuck' })
    .expect(200)
  assert.equal(first.body.already_terminal, false)
  const snapshot = JSON.stringify(jq.getJob(job.job_id))

  const original = globalThis.fetch
  let gatewayCalls = 0
  globalThis.fetch = async () => { gatewayCalls += 1; return Response.json({ ok: true }) }
  try {
    const second = await request(app)
      .post(`/api/projects/${project.slug}/jobs/${job.job_id}/discard`)
      .send({ reason: 'again' })
      .expect(200)
    assert.equal(second.body.already_terminal, true)
    assert.equal(second.body.job.discarded?.reason, 'stuck', 'the first reason is kept')
    assert.equal(gatewayCalls, 0, 'a second discard never re-asks the Gateway')
  } finally {
    globalThis.fetch = original
  }
  await jq._waitForJobPersistenceForTesting()
  assert.equal(JSON.stringify(jq.getJob(job.job_id)), snapshot, 'the row is byte-for-byte unchanged')
})
