/**
 * Writing jobs.json must not re-redact every job it already holds.
 *
 * Each write rebuilt its snapshot with `safeJob` (structuredClone + a deep secret scan) over the WHOLE
 * project baseline — up to 750 history jobs — although every entry the queue itself stored is already
 * a redacted copy. Measured on 800 synthetic jobs: 0.6 s (100 log lines each) to 2.5 s (400 lines) of
 * main-process CPU per write, and a busy batch writes many times a second.
 *
 * Counts `safe_job_calls` rather than time so a loaded machine cannot flake it.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  jq.registerExecutor('chapter-only', async () => {})
  await jq.setQueuePaused(true)
})
after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

test('a write after 40 jobs are held costs a handful of redactions, not 40 per write', async () => {
  const project = await pm.createProject({ name: 'Persist Cost' })
  const created = Array.from({ length: 40 }, (_, index) => jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'chapter-only', episode_id: `COST-${index}`, title: `Cost ${index}`, params: {},
  }) as Job)
  await Promise.all(created.map(job => jq.checkpointJobState(job)))
  await jq._waitForJobPersistenceForTesting()

  jq._resetJobPersistenceCountersForTesting()
  const WRITES = 8
  for (let i = 0; i < WRITES; i++) {
    await jq.recordGenStudioJob(created[i]!.job_id, {
      id: `child-${i}`, operation: 'image.generation', state: 'running', updated_at: new Date(1000 + i).toISOString(),
    })
  }
  const counters = jq._getJobPersistenceCountersForTesting()
  // Each write redacts the job it changed (twice: the incoming copy and the stored copy). It used to
  // redact all 40 held jobs as well, ~(40 + 2) per write.
  assert.ok(counters.atomic_writes >= WRITES, `expected a write per change, saw ${counters.atomic_writes}`)
  assert.ok(counters.safe_job_calls <= WRITES * 2 + 40, `${counters.safe_job_calls} redactions for ${WRITES} writes of 40 jobs`)

  // And nothing was lost: every change, and every untouched job, is in the file.
  const persisted = (JSON.parse(await fs.readFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), 'utf8')) as { jobs: Job[] }).jobs
  assert.equal(persisted.length, 40)
  const children = persisted.flatMap(job => job.genstudio_jobs || []).map(entry => entry.id).sort()
  assert.deepEqual(children, Array.from({ length: WRITES }, (_, i) => `child-${i}`).sort())
})

test('a secret in a held job is still redacted on disk after later writes', async () => {
  const project = await pm.createProject({ name: 'Persist Redaction' })
  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'chapter-only', episode_id: 'SECRET-1', title: 'Secret', params: { api_key: 'sk-abcdefghijklmnop', note: 'Bearer abcdefghijklmnopqrstuv' },
  }) as Job
  await jq.checkpointJobState(job)
  const other = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'chapter-only', episode_id: 'SECRET-2', title: 'Other', params: {} }) as Job
  await jq.checkpointJobState(other)
  await jq.recordGenStudioJob(other.job_id, { id: 'child', operation: 'image.generation', state: 'running', updated_at: new Date().toISOString() })
  await jq._waitForJobPersistenceForTesting()
  const raw = await fs.readFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), 'utf8')
  assert.ok(!raw.includes('sk-abcdefghijklmnop'), 'the key never reaches disk')
  assert.ok(!raw.includes('abcdefghijklmnopqrstuv'), 'the bearer token never reaches disk')
})

test('a finished job keeps only its last 500 log lines on disk', async () => {
  const project = await pm.createProject({ name: 'Log Cap' })
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i}`)
  const base = (id: string, status: Job['status']): Job => ({
    job_id: id, project_slug: project.slug, type: 'chapter-only', episode_id: 'EP0001', title: id, status,
    created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    finished_at: status === 'done' ? new Date().toISOString() : null, error: null, output_lines: [...lines], params: {},
  })
  await jq.checkpointJobState(base('log-done', 'done'))
  await jq.checkpointJobState(base('log-error', 'error'))
  await jq._waitForJobPersistenceForTesting()
  const persisted = (JSON.parse(await fs.readFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), 'utf8')) as { jobs: Job[] }).jobs
  for (const id of ['log-done', 'log-error']) {
    const job = persisted.find(candidate => candidate.job_id === id)!
    // The cap keeps the last 499 lines and says so on the first retained line, so a log that was
    // shortened is never mistaken for a log that was always that short (owner 2026-11-19).
    assert.equal(job.output_lines.length, jq.MAX_FINISHED_JOB_OUTPUT_LINES)
    assert.equal(job.output_lines[0], '(showing the last 499 of 1200 log lines)')
    assert.equal(job.output_lines[1], 'line 701')
    assert.equal(job.output_lines.at(-1), 'line 1199')
  }
})
