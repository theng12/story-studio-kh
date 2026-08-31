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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function waitForJobStatus(jobId: string, status: string): Promise<void> {
  if (jq.getJob(jobId)?.status === status) return Promise.resolve()
  return new Promise(resolve => {
    const onUpdate = (job: { job_id: string; status: string }) => {
      if (job.job_id !== jobId || job.status !== status) return
      jq.jobEvents.off('update', onUpdate)
      resolve()
    }
    jq.jobEvents.on('update', onUpdate)
  })
}

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

describe('queue-origin recovery invariant', () => {
  test('a persisted queue-origin pause loads into its FIFO lane with one project snapshot when the durable queue is running', async t => {
    const blockerProject = await pm.createProject({ name: 'Queue Recovery False Blocker' })
    const project = await pm.createProject({ name: 'Queue Recovery Durable False' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    jq.registerExecutor('script-only', async job => {
      if (job.episode_id === 'BLOCK') {
        blockerStarted.resolve()
        await releaseBlocker.promise
      }
    })
    await jq.setQueuePaused(false)
    jq.enqueuePreparedForTest({
      project_slug: blockerProject.slug,
      type: 'script-only',
      episode_id: 'BLOCK',
      title: 'occupy lane',
      params: {},
    })
    await blockerStarted.promise

    const held = makeJob(project.slug, 1, 'paused', {
      job_id: 'persisted-queue-hold-false',
      pause_origin: 'queue',
      pause_requested: false,
    })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [held] }, null, 2))
    const originalRename = fs.rename.bind(fs)
    let projectSnapshots = 0
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === path.resolve(jobsFile)) projectSnapshots += 1
      return originalRename(from, to)
    })

    try {
      const loaded = await jq.getJobs(project.slug)

      assert.equal(loaded.find(job => job.job_id === held.job_id)?.status, 'queued')
      assert.equal(loaded.find(job => job.job_id === held.job_id)?.pause_origin, undefined)
      const persisted = await readPersisted(jobsFile) as Job[]
      assert.equal(persisted.find(job => job.job_id === held.job_id)?.status, 'queued')
      assert.equal(projectSnapshots, 1)
      const heldDone = waitForJobStatus(held.job_id, 'done')
      releaseBlocker.resolve()
      await heldDone
    } finally {
      releaseBlocker.resolve()
    }
  })

  test('a persisted queue-origin pause stays paused while the durable global hold is true', async () => {
    const project = await pm.createProject({ name: 'Queue Recovery Durable True' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const held = makeJob(project.slug, 2, 'paused', {
      job_id: 'persisted-queue-hold-true',
      pause_origin: 'queue',
      pause_requested: false,
    })
    await jq.setQueuePaused(true)
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [held] }, null, 2))

    const loaded = await jq.getJobs(project.slug)

    assert.equal(loaded.find(job => job.job_id === held.job_id)?.status, 'paused')
    assert.equal(loaded.find(job => job.job_id === held.job_id)?.pause_origin, 'queue')
    await jq.requestJobCancellation(project.slug, held.job_id)
    await jq.setQueuePaused(false)
  })

  test('manual and originless persisted pauses survive false-state load and global Resume', async () => {
    const project = await pm.createProject({ name: 'Queue Recovery Preserves Intent' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const manual = makeJob(project.slug, 3, 'paused', {
      job_id: 'persisted-manual-hold',
      pause_origin: 'manual',
      pause_requested: false,
    })
    const originless = makeJob(project.slug, 4, 'paused', {
      job_id: 'persisted-originless-hold',
      pause_origin: undefined,
      pause_requested: false,
    })
    const stalled = makeJob(project.slug, 5, 'paused', {
      job_id: 'persisted-stall-hold',
      pause_origin: 'stall',
      pause_requested: false,
    })
    await jq.setQueuePaused(false)
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [manual, originless, stalled] }, null, 2))

    await jq.getJobs(project.slug)
    await jq.setQueuePaused(false)

    assert.equal(jq.getJob(manual.job_id)?.status, 'paused')
    assert.equal(jq.getJob(manual.job_id)?.pause_origin, 'manual')
    assert.equal(jq.getJob(originless.job_id)?.status, 'paused')
    assert.equal(jq.getJob(originless.job_id)?.pause_origin, undefined)
    assert.equal(jq.getJob(stalled.job_id)?.status, 'paused')
    assert.equal(jq.getJob(stalled.job_id)?.pause_origin, 'stall')
    await jq.requestJobCancellation(project.slug, manual.job_id)
    await jq.requestJobCancellation(project.slug, originless.job_id)
    await jq.requestJobCancellation(project.slug, stalled.job_id)
  })

  test('Resume racing an in-flight project load cannot strand a queue-origin pause', async t => {
    const project = await pm.createProject({ name: 'Queue Recovery Load Race' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const held = makeJob(project.slug, 5, 'paused', {
      job_id: 'persisted-queue-hold-race',
      pause_origin: 'queue',
      pause_requested: false,
    })
    const readStarted = deferred()
    const releaseRead = deferred()
    const executorStarted = deferred()
    const releaseExecutor = deferred()
    const originalReadFile = fs.readFile.bind(fs)
    let blocked = false
    t.mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
      if (!blocked && path.resolve(String(file)) === path.resolve(jobsFile)) {
        blocked = true
        readStarted.resolve()
        await releaseRead.promise
      }
      return originalReadFile(file, ...args as [any])
    })
    jq.registerExecutor('script-only', async job => {
      if (job.job_id !== held.job_id) return
      executorStarted.resolve()
      await releaseExecutor.promise
    })
    await jq.setQueuePaused(true)
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [held] }, null, 2))

    const loading = jq.getJobs(project.slug)
    try {
      await readStarted.promise
      await jq.setQueuePaused(false)
      releaseRead.resolve()
      await loading

      assert.equal(jq.getJob(held.job_id)?.job_id, held.job_id)
      assert.notEqual(jq.getJob(held.job_id)?.status, 'paused')
      await executorStarted.promise
      const heldDone = waitForJobStatus(held.job_id, 'done')
      releaseExecutor.resolve()
      await heldDone
    } finally {
      releaseRead.resolve()
      releaseExecutor.resolve()
    }
  })

  test('concurrent initialization callers share one durable read and both await its true result', async t => {
    const settingsFile = path.join(tempDir, 'app-settings.json')
    await fs.writeFile(settingsFile, JSON.stringify({ job_queue_paused: true }, null, 2))
    const readStarted = deferred()
    const releaseRead = deferred()
    const originalReadFile = fs.readFile.bind(fs)
    let settingsReads = 0
    t.mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
      if (path.resolve(String(file)) === path.resolve(settingsFile)) {
        settingsReads += 1
        readStarted.resolve()
        await releaseRead.promise
      }
      return originalReadFile(file, ...args as [any])
    })
    const fresh = await import(`../services/job-queue.js?queue-init=${Date.now()}`)

    const first = fresh.initializeQueuePauseState()
    await readStarted.promise
    let secondResolved = false
    const second = fresh.initializeQueuePauseState().then(() => { secondResolved = true })
    await Promise.resolve()
    const resolvedBeforeDurableRead = secondResolved
    releaseRead.resolve()
    await Promise.all([first, second])

    assert.equal(resolvedBeforeDurableRead, false)
    assert.equal(settingsReads, 1)
    assert.equal(fresh.isQueuePaused(), true)
  })
})
