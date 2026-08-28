import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor, waitForValue } from './_timing.js'

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
})

after(async () => { await cleanup() })

function makeJob(
  projectSlug: string,
  index: number,
  status: Job['status'],
  overrides: Partial<Job> = {},
): Job {
  const created = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  return {
    job_id: `persist-${projectSlug}-${index}`,
    project_slug: projectSlug,
    type: 'script-only',
    episode_id: `EP${String(index).padStart(4, '0')}`,
    title: `Persisted job ${index}`,
    status,
    created_at: created,
    started_at: status === 'queued' ? null : created,
    finished_at: ['done', 'error', 'cancelled'].includes(status) ? created : null,
    error: status === 'error' ? `Failure ${index}` : null,
    output_lines: [],
    params: {},
    ...overrides,
  }
}

async function readPersisted(file: string): Promise<any[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'))
    return Array.isArray(parsed.jobs) ? parsed.jobs : []
  } catch {
    return []
  }
}

/**
 * Wait until at least `expected` jobs have been flushed to disk.
 *
 * The old hardcoded `Date.now() + 10_000` ceiling was measured giving up at
 * 10,442ms and 10,621ms under concurrent suites. It never observed a wrong
 * value — it ran out of wall clock while this process was descheduled.
 * `waitForValue` spends a budget of scheduled time instead, so the same
 * assertion survives a loaded machine while still failing promptly on an idle
 * one if persistence is genuinely broken.
 */
function waitForPersistedCount(file: string, expected: number): Promise<any[]> {
  return waitForValue(
    async () => {
      const records = await readPersisted(file)
      return records.length >= expected ? records : false
    },
    {
      label: `at least ${expected} persisted jobs in ${path.basename(file)}`,
      // The original ceiling, reinterpreted: 10s of SCHEDULED time rather
      // than 10s of wall clock. Strictly more generous than before.
      timeoutMs: 10_000,
    },
  )
}

describe('status-aware durable job retention', () => {
  test('restart preserves an intentional scene-image pause and its episode-wide owner lock', async () => {
    const project = await pm.createProject({ name: 'Restarted Paused Scene Images' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const paused = makeJob(project.slug, 777, 'paused', {
      job_id: 'paused-scene-images',
      type: 'continuity_render',
      episode_id: 'EP-PAUSED',
      pause_requested: true,
      pause_origin: 'manual',
      genstudio_jobs: [{
        id: 'image-running', operation: 'image.generation', state: 'running', dispatch_state: 'dispatched', cancellable: false,
        request: { method: 'POST', path: '/v1/images/generations', idempotency_key: 'story-paused-image', captured_at: '2026-08-12T00:00:00.000Z' },
        updated_at: '2026-08-12T00:00:00.000Z',
      }],
    })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [paused] }, null, 2))

    const restored = (await jq.getJobs(project.slug)).find(job => job.job_id === paused.job_id)
    assert.equal(restored?.status, 'paused')
    assert.equal(restored?.pause_origin, 'manual')
    assert.equal(jq.isDuplicate(project.slug, 'EP-PAUSED', 'continuity_render'), true)
    assert.equal(jq.getActiveBulkSceneRenderJob(project.slug, 'EP-PAUSED')?.job_id, paused.job_id)
  })

  test('more than 100 queued jobs persist without changing deduplication', async () => {
    const project = await pm.createProject({ name: 'Large Durable Queue' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    await jq.setQueuePaused(true)
    jq.registerExecutor('script-only', async () => {})

    const queued = Array.from({ length: 125 }, (_, index) => jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'script-only',
      episode_id: `EP${String(index).padStart(4, '0')}`,
      title: `Queued ${index}`,
      params: { logical_index: index },
    }))
    const persisted = await waitForPersistedCount(jobsFile, queued.length)

    assert.equal(persisted.length, 125)
    assert.deepEqual(persisted.map(job => job.job_id), queued.map(job => job.job_id))
    assert.equal(jq.isDuplicate(project.slug, 'EP0000', 'script-only'), true)

    await Promise.all(queued.map(job => jq.requestJobCancellation(project.slug, job.job_id)))
    await jq.setQueuePaused(false)
  })

  test('restart restoration preserves every queued job and FIFO queue positions', async () => {
    const project = await pm.createProject({ name: 'Large Restart Queue' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const queued = Array.from({ length: 130 }, (_, index) => makeJob(project.slug, index, 'queued'))
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: queued }, null, 2))
    await jq.setQueuePaused(true)
    jq.registerExecutor('script-only', async () => {})

    const restored = await jq.getJobs(project.slug)
    const restoredQueued = restored
      .filter(job => job.status === 'queued')
      .sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0))

    assert.equal(restoredQueued.length, 130)
    assert.deepEqual(restoredQueued.map(job => job.job_id), queued.map(job => job.job_id))
    assert.deepEqual(restoredQueued.map(job => job.queue_position), Array.from({ length: 130 }, (_, i) => i + 1))

    await Promise.all(restoredQueued.map(job => jq.requestJobCancellation(project.slug, job.job_id)))
    await jq.setQueuePaused(false)
  })

  test('mixed live and terminal records preserve every live job and trim terminal history', async () => {
    const project = await pm.createProject({ name: 'Mixed Queue Retention' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const liveStatuses: Job['status'][] = ['queued', 'running', 'paused']
    const live = Array.from({ length: 180 }, (_, index) => makeJob(
      project.slug,
      index,
      liveStatuses[index % liveStatuses.length],
    ))
    const terminal = Array.from(
      { length: jq.MAX_PERSISTED_TERMINAL_HISTORY + 40 },
      (_, index) => makeJob(project.slug, 1_000 + index, index % 2 === 0 ? 'done' : 'error'),
    )
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [...live, ...terminal] }, null, 2))

    const trigger = makeJob(project.slug, 9_999, 'cancelled')
    await jq.checkpointJobState(trigger)
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf-8')).jobs as Job[]
    const persistedLive = persisted.filter(job => !['done', 'error', 'cancelled'].includes(job.status))
    const persistedTerminal = persisted.filter(job => ['done', 'error', 'cancelled'].includes(job.status))

    assert.equal(persistedLive.length, live.length)
    assert.deepEqual(persistedLive.map(job => job.job_id), live.map(job => job.job_id))
    assert.equal(persistedTerminal.length, jq.MAX_PERSISTED_TERMINAL_HISTORY)
    assert.ok(persistedTerminal.some(job => job.job_id === trigger.job_id))
    assert.ok(!persistedTerminal.some(job => job.job_id === terminal[0].job_id))
    assert.ok(persistedTerminal.some(job => job.job_id === terminal.at(-1)!.job_id))
  })

  test('terminal retention prefers finished_at and falls back to created_at', () => {
    const projectSlug = 'terminal-order'
    const oldest = makeJob(projectSlug, 1, 'done', {
      job_id: 'oldest',
      created_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:00:01.000Z',
    })
    const fallback = makeJob(projectSlug, 2, 'error', {
      job_id: 'fallback',
      created_at: '2026-03-01T00:00:00.000Z',
      finished_at: null,
    })
    const newest = makeJob(projectSlug, 3, 'cancelled', {
      job_id: 'newest',
      created_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-04-01T00:00:00.000Z',
    })
    const filler = Array.from(
      { length: jq.MAX_PERSISTED_TERMINAL_HISTORY - 1 },
      (_, index) => makeJob(projectSlug, 100 + index, 'done'),
    )

    const retained = jq.retainJobsForPersistence([oldest, ...filler, fallback, newest])
    const ids = new Set(retained.map(job => job.job_id))
    assert.equal(retained.length, jq.MAX_PERSISTED_TERMINAL_HISTORY)
    assert.equal(ids.has('oldest'), false)
    assert.equal(ids.has('fallback'), true)
    assert.equal(ids.has('newest'), true)
  })

  test('concurrent persistence does not lose queued jobs', async () => {
    const project = await pm.createProject({ name: 'Concurrent Queue Persistence' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const queued = Array.from({ length: 140 }, (_, index) => makeJob(project.slug, index, 'queued'))

    await Promise.all(queued.map(job => jq.checkpointJobState(job)))
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf-8')).jobs as Job[]

    assert.equal(persisted.length, queued.length)
    assert.deepEqual(new Set(persisted.map(job => job.job_id)), new Set(queued.map(job => job.job_id)))
  })

  test('clearing terminal history snapshots every live queued job', async () => {
    const project = await pm.createProject({ name: 'Clear History Keeps Queue' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    jq.registerExecutor('metadata', async () => {})
    const terminal = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'metadata',
      episode_id: 'EP-DONE',
      title: 'Terminal history',
      params: {},
    })
    // Wait for ANY terminal status, then assert below that it was `done` —
    // an `error` here must still fail, so the wait must not be "until done".
    await waitFor(
      () => ['done', 'error', 'cancelled'].includes(jq.getJob(terminal.job_id)?.status ?? ''),
      { label: 'the seeded metadata job to reach a terminal status', timeoutMs: 2_000 },
    )
    assert.equal(jq.getJob(terminal.job_id)?.status, 'done')

    await jq.setQueuePaused(true)
    jq.registerExecutor('script-only', async () => {})
    const queued = Array.from({ length: 120 }, (_, index) => jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'script-only',
      episode_id: `EP-CLEAR-${index}`,
      title: `Live after clear ${index}`,
      params: {},
    }))
    await waitForPersistedCount(jobsFile, queued.length + 1)
    assert.equal(await jq.clearFinished(project.slug), 1)

    let persisted: Job[] = []
    await waitFor(async () => {
      persisted = await readPersisted(jobsFile) as Job[]
      return !persisted.some(job => job.job_id === terminal.job_id)
    }, { label: 'the cleared terminal job to disappear from jobs.json', timeoutMs: 5_000 })
    assert.equal(persisted.some(job => job.job_id === terminal.job_id), false)
    assert.deepEqual(persisted.map(job => job.job_id), queued.map(job => job.job_id))

    await Promise.all(queued.map(job => jq.requestJobCancellation(project.slug, job.job_id)))
    await jq.setQueuePaused(false)
  })

  test('checkpointed GenStudio work is never displaced by terminal history', async () => {
    const project = await pm.createProject({ name: 'GenStudio Checkpoint Retention' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const checkpointed = makeJob(project.slug, 1, 'running', {
      job_id: 'checkpointed-genstudio',
      type: 'audio',
      params: {
        genstudio_recovery: {
          version: 1,
          route: 'genstudio',
          assets: {
            narration: {
              operation: 'tts',
              idempotency_key: 'story-tts-retention',
              job_id: 'genstudio-job-retention',
              state: 'running',
            },
          },
        },
      },
    })
    const terminal = Array.from(
      { length: jq.MAX_PERSISTED_TERMINAL_HISTORY + 100 },
      (_, index) => makeJob(project.slug, 1_000 + index, 'done'),
    )
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [checkpointed, ...terminal] }, null, 2))

    await jq.checkpointJobState(makeJob(project.slug, 9_999, 'done'))
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf-8')).jobs as Job[]

    assert.ok(persisted.some(job => job.job_id === checkpointed.job_id))
    assert.equal(
      persisted.filter(job => ['done', 'error', 'cancelled'].includes(job.status)).length,
      jq.MAX_PERSISTED_TERMINAL_HISTORY,
    )
  })
})
