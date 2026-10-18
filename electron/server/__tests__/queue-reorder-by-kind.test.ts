import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, afterEach, before, test } from 'node:test'
import type { Job, JobType } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let cleanup: () => Promise<void>
let wasPaused = false
const projects: string[] = []

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  wasPaused = jq.isQueuePaused()
})
afterEach(async () => {
  // Leave no queued fixture behind for the next test's lane positions.
  for (const slug of projects) {
    for (const row of await jq.getJobs(slug)) {
      if (row.status === 'queued') await jq.forceAbandonJob(slug, row.job_id).catch(() => {})
    }
  }
  await jq._waitForJobPersistenceForTesting()
  if (!wasPaused && jq.isQueuePaused()) await jq.setQueuePaused(false)
})
after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

function enqueue(slug: string, episode: string, type: JobType): Job {
  return jq.enqueuePreparedForTest({ project_slug: slug, episode_id: episode, type, params: { fixture: true } })
}

async function laneOrder(slug: string, type: JobType): Promise<string[]> {
  const rows = await jq.getJobs(slug, { type })
  return rows
    .filter(row => row.status === 'queued')
    .sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0))
    .map(row => row.job_id)
}

test('a queued job moves only inside its own kind and the order survives a restart', async () => {
  const project = await pm.createProject({ name: 'Queue reorder by kind' })
  projects.push(project.slug)
  await jq.setQueuePaused(true)

  const a = enqueue(project.slug, 'EP-A', 'video_assembly')
  const b = enqueue(project.slug, 'EP-B', 'video_assembly')
  const c = enqueue(project.slug, 'EP-C', 'video_assembly')
  const other = enqueue(project.slug, 'EP-D', 'broll_assemble')

  assert.deepEqual(await laneOrder(project.slug, 'video_assembly'), [a.job_id, b.job_id, c.job_id])

  // Top moves within the job's own lane only.
  const moved = await jq.moveQueuedJob(project.slug, c.job_id, 'top')
  assert.ok(moved)
  assert.deepEqual(await laneOrder(project.slug, 'video_assembly'), [c.job_id, a.job_id, b.job_id])

  // A move in one lane cannot touch another kind's lane, so the other job
  // keeps position 1 of its own queue.
  assert.ok(await jq.moveQueuedJob(project.slug, other.job_id, 'up'))
  assert.deepEqual(await laneOrder(project.slug, 'video_assembly'), [c.job_id, a.job_id, b.job_id])
  const otherRow = (await jq.getJobs(project.slug, { type: 'broll_assemble' })).find(row => row.job_id === other.job_id)
  assert.equal(otherRow?.queue_position, 1)

  // Up moves one place at a time.
  assert.ok(await jq.moveQueuedJob(project.slug, a.job_id, 'up'))
  assert.deepEqual(await laneOrder(project.slug, 'video_assembly'), [a.job_id, c.job_id, b.job_id])
  assert.ok(await jq.moveQueuedJob(project.slug, a.job_id, 'down'))
  assert.deepEqual(await laneOrder(project.slug, 'video_assembly'), [c.job_id, a.job_id, b.job_id])

  // A paused (non-queued) row and a foreign project row are refused.
  assert.ok(await jq.pauseJob(b.job_id))
  assert.equal(await jq.moveQueuedJob(project.slug, b.job_id, 'up'), null)
  assert.equal(await jq.moveQueuedJob('some-other-project', c.job_id, 'up'), null)

  await jq._waitForJobPersistenceForTesting()
  const file = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
  const disk = JSON.parse(await fs.readFile(file, 'utf8')) as { jobs: Job[] }
  const rank = (jobId: string) => disk.jobs.find(row => row.job_id === jobId)?.queue_rank
  assert.equal(rank(c.job_id), 0)
  assert.equal(rank(a.job_id), 1)

  // A fresh module instance is what a restart sees: it must restore the saved
  // order, not insertion order.
  const restarted = await import(`${pathToFileURL(path.resolve('server/services/job-queue.ts')).href}?queue-reorder-restart`)
  // A lane re-queues its persisted work only when an executor owns it; the
  // queue itself stays paused, so this fixture never runs.
  restarted._setExecutorForTesting('video_assembly', async () => {})
  await restarted.setQueuePaused(true)
  const restartedRows = await restarted.getJobs(project.slug, { type: 'video_assembly' })
  const restartedOrder = restartedRows
    .filter((row: Job) => row.status === 'queued')
    .sort((x: Job, y: Job) => (x.queue_position || 0) - (y.queue_position || 0))
    .map((row: Job) => row.job_id)
  assert.deepEqual(restartedOrder, [c.job_id, a.job_id])
})
