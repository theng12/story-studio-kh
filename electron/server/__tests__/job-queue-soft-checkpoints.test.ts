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

// S4: render progress checkpoints share one jobs.json rewrite; normal checkpoints stay immediate.
test('soft progress checkpoints coalesce into one write; a normal checkpoint is written at once', async () => {
  const project = await pm.createProject({ name: 'Soft Checkpoints' })
  const file = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'chapter-only', episode_id: 'EP0001', title: 'soft', params: {} }) as Job
  await jq.checkpointJobState(job) // a write just happened

  jq._resetJobPersistenceCountersForTesting()
  const started = Date.now()
  for (let i = 0; i < 6; i++) {
    job.progress = i
    job.output_lines.push(`clip ${i}`)
    await jq.checkpointJobProgress(job)
  }
  assert.ok(Date.now() - started < jq.SOFT_CHECKPOINT_SPACING_MS / 2, 'a render lane is not held up by its progress checkpoints')
  await jq._waitForJobPersistenceForTesting()
  assert.equal(jq._getJobPersistenceCountersForTesting().atomic_writes, 1, 'six progress checkpoints, one rewrite')
  assert.ok(Date.now() - started >= jq.SOFT_CHECKPOINT_SPACING_MS - 100, 'the soft write waited for the spacing')
  const saved = JSON.parse(await fs.readFile(file, 'utf8')).jobs.find((row: Job) => row.job_id === job.job_id)
  assert.ok(saved.output_lines.includes('clip 5'), 'the coalesced write carries the latest state')

  // Right after that write, a normal (e.g. paid-precondition) checkpoint is not held back,
  // and it also flushes any soft checkpoint waiting behind the spacing.
  job.output_lines.push('queued behind the spacing')
  await jq.checkpointJobProgress(job)
  const urgentStart = Date.now()
  job.params.receipt = 'pending:key'
  await jq.checkpointJobState(job)
  assert.ok(Date.now() - urgentStart < jq.SOFT_CHECKPOINT_SPACING_MS / 2, 'a normal checkpoint is written immediately')
  const durable = JSON.parse(await fs.readFile(file, 'utf8')).jobs.find((row: Job) => row.job_id === job.job_id)
  assert.equal(durable.params.receipt, 'pending:key')
  assert.ok(durable.output_lines.includes('queued behind the spacing'), 'and it flushed the progress checkpoint queued before it')
})
