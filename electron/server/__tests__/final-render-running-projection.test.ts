/**
 * A final-render row with no work running must never be counted as running (AGENTS.md §6/§8):
 * not by the server projection, not by the display status the Jobs page filters on, and not by
 * the quiet checks the prompt updater reads. An unknown remote render stays protected.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { before, test } from 'node:test'

import { jobDisplayStatus } from '../contracts/jobs-history.js'

let dataRoot = ''
let queue: typeof import('../services/job-queue.js')

const COMMITTED_AT = '2026-10-15T02:00:00.000Z'
const GATEWAY_JOB_ID = '66666666-6666-4666-8666-666666666666'
const hex = (character: string) => character.repeat(64)

/** The exact V3 shape `parseFinalRenderRemoteWaitReceipt` accepts. */
function receipt(jobId: string, phase: 'acknowledged' | 'remote_wait') {
  return {
    version: 3 as const, phase, revision: 2, job_id: jobId,
    intent_id: `render_${'4'.repeat(32)}`,
    story_instance_id: '33333333-3333-4333-8333-333333333333',
    story_attempt: 1,
    gateway_attempt_key: '55555555-5555-4555-8555-555555555555',
    packet_sha256: hex('1'), staging_manifest_sha256: hex('2'),
    submission_scope_sha256: hex('3'), destination_fence_sha256: hex('4'),
    source_generation_fence_sha256: hex('5'),
    committed_at: COMMITTED_AT, cancel_requested_at: null,
    request_body_sha256: hex('6'), request_body_bytes: 42,
    gateway_job_id: GATEWAY_JOB_ID,
    transport_revision_sha256: hex('7'),
  }
}

function row(slug: string, id: string, phase: 'acknowledged' | 'remote_wait') {
  return {
    job_id: id, project_slug: slug, type: 'video_assembly', episode_id: 'EP1', title: id,
    status: 'running', created_at: COMMITTED_AT, started_at: COMMITTED_AT, finished_at: null,
    error: null, output_lines: [], params: {},
    final_render_remote_wait: receipt(id, phase),
  }
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the data root is isolated')
  dataRoot = await fs.mkdtemp(path.join(harnessRoot, 'final-render-running-projection-'))
  process.env.STORY_STUDIO_DATA_DIR = dataRoot
  await fs.mkdir(path.join(dataRoot, 'projects'), { recursive: true })
  queue = await import('../services/job-queue.js')
})

test('the shared display status never calls an idle row running', () => {
  assert.equal(jobDisplayStatus({ job_id: 'a', status: 'running', counts_as_running: false }), 'parked')
  assert.equal(jobDisplayStatus({ job_id: 'b', status: 'running', counts_as_running: true }), 'running')
  // A row from a source that does not compute the field keeps its honest raw status.
  assert.equal(jobDisplayStatus({ job_id: 'c', status: 'running' }), 'running')
})

test('an acknowledged hold drains; an unknown remote render stays protected', async () => {
  const slug = `projection-${process.pid}`
  const projectDir = path.join(dataRoot, 'projects', slug)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({
    jobs: [row(slug, 'acknowledged-hold', 'acknowledged'), row(slug, 'unknown-remote', 'remote_wait')],
  }))

  const loaded = await queue.getJobs(slug)
  assert.equal(loaded.length, 2, 'both rows are still on the list')
  // No private snapshot exists, so the boot fence keeps each row recovery-held.
  assert.equal(queue._hasFinalRenderRecoveryHoldForTesting('acknowledged-hold'), true)
  assert.equal(queue._hasFinalRenderRecoveryHoldForTesting('unknown-remote'), true)

  const acknowledged = queue.getPublicJob('acknowledged-hold')
  const unknown = queue.getPublicJob('unknown-remote')
  assert.equal(acknowledged?.counts_as_running, false, 'an acknowledged row is not executing')
  assert.equal(unknown?.counts_as_running, true, 'an unknown remote render is still active work')
  assert.equal(jobDisplayStatus(acknowledged!), 'parked')
  assert.equal(jobDisplayStatus(unknown!), 'running')

  assert.equal(queue.getQueueStats(slug).running, 1, 'only the unknown remote row counts')
  assert.equal((await queue.countJobs(slug)).running, 1)

  // The prompt updater waits for work a restart would not continue. The acknowledged row has
  // none; the unknown remote render must still hold it back.
  const blockers = (await queue.runningJobsThatWouldNotResume()).map(job => job.job_id)
  assert.equal(blockers.includes('acknowledged-hold'), false)
  assert.equal(blockers.includes('unknown-remote'), true)

  // Full/stream summaries receive public rows with private receipts removed. They must use the
  // server's projection, not try to classify those rows again from evidence no longer on the wire.
  const { default: express } = await import('express')
  const { router } = await import('../routes/jobs.js')
  const app = express()
  app.use(router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    for (const view of ['full', 'stream', 'active']) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/jobs/all?view=${view}`, {
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(response.status, 200)
      const body = await response.json() as { jobs: Array<{ job_id: string; counts_as_running?: boolean }>; stats: { running: number } }
      assert.equal(body.stats.running, 1, `${view} snapshot excludes the acknowledged row`)
      assert.equal(body.jobs.find(job => job.job_id === 'acknowledged-hold')?.counts_as_running, false)
      assert.equal(body.jobs.find(job => job.job_id === 'unknown-remote')?.counts_as_running, true)
    }
    const historyResponse = await fetch(`http://127.0.0.1:${address.port}/jobs/all/history?status=running`, {
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(historyResponse.status, 200)
    const history = await historyResponse.json() as { jobs: Array<{ job_id: string }> }
    assert.deepEqual(history.jobs.map(job => job.job_id), ['unknown-remote'], 'raw history filters match public execution status')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
