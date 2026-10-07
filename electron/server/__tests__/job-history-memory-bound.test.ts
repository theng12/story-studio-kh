import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
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

// S10: finished jobs that retention drops from jobs.json are dropped from memory as well.
test('terminal history dropped from disk by retention is forgotten in memory and announced as cleared', async () => {
  const project = await pm.createProject({ name: 'History Bound' })
  const cap = jq.MAX_PERSISTED_TERMINAL_HISTORY
  const old = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
  await fs.writeFile(path.join(pm.getProjectDir(project.slug)!, 'jobs.json'), JSON.stringify({
    jobs: Array.from({ length: cap }, (_, i) => ({
      job_id: `old-${i}`, project_slug: project.slug, type: 'chapter-only', episode_id: 'EP0001', title: 't',
      status: 'done', created_at: old(i), started_at: old(i), finished_at: old(i), error: null, output_lines: [], params: {},
    })),
  }))
  assert.equal((await jq.getJobs(project.slug)).length, cap)
  const cleared: string[] = []
  const onCleared = (event: { job_ids: string[] }) => cleared.push(...event.job_ids)
  jq.jobEvents.on('cleared', onCleared)
  try {
    for (let i = 0; i < 3; i++) {
      const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'chapter-only', episode_id: `EP010${i}`, title: `new ${i}`, params: {} }) as Job
      job.status = 'done'
      job.finished_at = new Date().toISOString()
      await jq.checkpointJobState(job)
    }
    await jq._waitForJobPersistenceForTesting()
    const live = await jq.getJobs(project.slug)
    assert.equal(live.length, cap, 'memory holds what disk holds, not cap + 3')
    for (const id of ['old-0', 'old-1', 'old-2']) assert.equal(jq.getJob(id), null, `${id} left memory`)
    assert.ok(jq.getJob('old-3'), 'the next-oldest survives')
    assert.deepEqual(cleared.sort(), ['old-0', 'old-1', 'old-2'])
  } finally {
    jq.jobEvents.off('cleared', onCleared)
  }
})
