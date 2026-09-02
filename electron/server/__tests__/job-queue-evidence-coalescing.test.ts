import { after, before, describe, test } from 'node:test'
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
  jq.registerExecutor('script-only', async () => {})
  await jq.setQueuePaused(true)
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

function makeJob(projectSlug: string, index: number, status: Job['status'] = 'queued'): Job {
  const created = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  return {
    job_id: `evidence-${projectSlug}-${index}`,
    project_slug: projectSlug,
    type: 'script-only',
    episode_id: `EP${String(index).padStart(4, '0')}`,
    title: `Evidence ${index}`,
    status,
    created_at: created,
    started_at: status === 'queued' ? null : created,
    finished_at: ['done', 'error', 'cancelled'].includes(status) ? created : null,
    error: status === 'error' ? `Failure ${index}` : null,
    output_lines: [],
    params: {},
  }
}

async function readJobs(file: string): Promise<Job[]> {
  return (JSON.parse(await fs.readFile(file, 'utf8')) as { jobs: Job[] }).jobs
}

async function createQueuedJobs(projectSlug: string, count: number): Promise<Job[]> {
  const created = Array.from({ length: count }, (_, index) => jq.enqueuePreparedForTest({
    project_slug: projectSlug,
    type: 'script-only',
    episode_id: `BURST-${index}`,
    title: `Burst ${index}`,
    params: {},
  }) as Job)
  // Fence the enqueue path's intentionally asynchronous first write before a
  // test resets counters or removes its temp directory.
  await Promise.all(created.map(job => jq.checkpointJobState(job)))
  return created
}

describe('project-owned durable job evidence', () => {
  test('one upsert preserves 180 lazily-unloaded jobs and only an explicit clear deletes history', async () => {
    const project = await pm.createProject({ name: 'Lazy Durable Baseline' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const live = Array.from({ length: 180 }, (_, index) => makeJob(project.slug, index))
    live[0]!.genstudio_jobs = [{
      id: 'accepted-provider-id', operation: 'image.generation', state: 'running',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]
    live[1]!.genstudio_jobs = [{
      id: 'pending:uncertain-key', operation: 'image.generation', state: 'submitting',
      request: {
        method: 'POST', path: '/v1/images/generations', idempotency_key: 'uncertain-key',
        captured_at: '2026-01-01T00:00:00.000Z',
      },
      updated_at: '2026-01-01T00:00:00.000Z',
    }]
    const terminal = makeJob(project.slug, 999, 'done')
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [...live, terminal] }))

    const trigger = makeJob(project.slug, 1_000, 'queued')
    await jq.checkpointJobState(trigger)

    const afterUpsert = await readJobs(jobsFile)
    assert.equal(afterUpsert.length, 182)
    assert.deepEqual(afterUpsert.slice(0, 180).map(job => job.job_id), live.map(job => job.job_id))
    assert.equal(afterUpsert[0]!.genstudio_jobs?.[0]?.id, 'accepted-provider-id')
    assert.equal(afterUpsert[1]!.genstudio_jobs?.[0]?.request?.idempotency_key, 'uncertain-key')
    assert.ok(afterUpsert.some(job => job.job_id === terminal.job_id), 'an upsert cannot imply deletion')

    await jq.getJobs(project.slug)
    assert.equal(await jq.clearFinished(project.slug), 1)
    await jq.checkpointJobState(trigger)

    const afterDelete = await readJobs(jobsFile)
    assert.equal(afterDelete.some(job => job.job_id === terminal.job_id), false)
    assert.equal(afterDelete.length, 181)
    assert.ok(afterDelete.some(job => job.job_id === trigger.job_id))
  })

  test('500 evidence waiters resolve only after their exact identities are durable with bounded writes', async () => {
    assert.equal(typeof jq._resetJobPersistenceCountersForTesting, 'function', 'persistence counters must exist')
    const project = await pm.createProject({ name: 'Coalesced Evidence Burst' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const jobs = await createQueuedJobs(project.slug, 4)
    jq._resetJobPersistenceCountersForTesting()

    const calls = Array.from({ length: 500 }, (_, index) => jq.recordGenStudioJob(
      jobs[index % jobs.length]!.job_id,
      {
        id: `child-${index}`,
        operation: 'image.generation',
        state: 'running',
        updated_at: new Date(index).toISOString(),
      },
    ))
    await Promise.all(calls)

    const persisted = await readJobs(jobsFile)
    const ids = new Set(persisted.flatMap(job => job.genstudio_jobs || []).map(entry => entry.id))
    assert.equal(ids.size, 500)
    const counters = jq._getJobPersistenceCountersForTesting()
    assert.ok(counters.atomic_writes <= 3, `expected at most 3 coalesced writes, received ${counters.atomic_writes}`)
    assert.equal(counters.project_snapshot_reads, 0, 'the already-owned baseline is not reparsed')
  })

  test('mutations arriving during a write share the final durable snapshot and do not resolve early', async () => {
    assert.equal(typeof jq._setJobFileLockProbeForTesting, 'function', 'lock probe must exist')
    const project = await pm.createProject({ name: 'In Flight Evidence' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const [first, second] = await createQueuedJobs(project.slug, 2)
    let enterWrite!: () => void
    let releaseWrite!: () => void
    const entered = new Promise<void>(resolve => { enterWrite = resolve })
    const released = new Promise<void>(resolve => { releaseWrite = resolve })
    let blocked = false
    const restore = jq._setJobFileLockProbeForTesting(async operation => {
      if (operation !== 'persist' || blocked) return
      blocked = true
      enterWrite()
      await released
    })
    let firstResolved = false
    let secondResolved = false
    try {
      const firstWrite = jq.recordGenStudioJob(first!.job_id, {
        id: 'accepted-first', operation: 'image.generation', state: 'running', updated_at: '2026-01-01T00:00:00.000Z',
      }).then(() => { firstResolved = true })
      await entered
      const secondWrite = jq.recordGenStudioJob(second!.job_id, {
        id: 'uncertain-second', operation: 'image.generation', state: 'submitting', updated_at: '2026-01-01T00:00:01.000Z',
      }).then(() => { secondResolved = true })
      await Promise.resolve()
      assert.equal(firstResolved, false)
      assert.equal(secondResolved, false)
      releaseWrite()
      await Promise.all([firstWrite, secondWrite])
    } finally {
      restore()
      releaseWrite!()
    }

    const persisted = await readJobs(jobsFile)
    assert.equal(persisted.find(job => job.job_id === first!.job_id)?.genstudio_jobs?.[0]?.id, 'accepted-first')
    assert.equal(persisted.find(job => job.job_id === second!.job_id)?.genstudio_jobs?.[0]?.id, 'uncertain-second')
  })

  test('concurrent authoritative transforms compose instead of overwriting each other', async () => {
    const project = await pm.createProject({ name: 'Concurrent Authoritative Transforms' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const [job] = await createQueuedJobs(project.slug, 1)
    assert.ok(job)
    let providerMutations = 0
    let cancellationMutations = 0

    const [providerResult, cancellationResult] = await Promise.all([
      jq.mutateAuthoritativeJob(project.slug, job.job_id, current => {
        providerMutations++
        return {
          ...current,
          genstudio_jobs: [{
          id: 'provider-transform', operation: 'image.generation', state: 'running',
          updated_at: '2026-01-01T00:00:00.000Z',
          }],
        }
      }),
      jq.mutateAuthoritativeJob(project.slug, job.job_id, current => {
        cancellationMutations++
        return {
          ...current,
          remote_cancellations: {
            'image.generation:provider-transform': {
              status: 'requested', operation: 'image.generation', provider_job_id: 'provider-transform',
              requested_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:01.000Z',
            },
          },
        }
      }),
    ])

    assert.ok(providerResult)
    assert.ok(cancellationResult)
    assert.equal(providerMutations, 1)
    assert.equal(cancellationMutations, 1)
    const persisted = (await readJobs(jobsFile)).find(candidate => candidate.job_id === job.job_id)
    assert.equal(persisted?.genstudio_jobs?.[0]?.id, 'provider-transform')
    assert.equal(persisted?.remote_cancellations?.['image.generation:provider-transform']?.status, 'requested')
    const live = jq.getJob(job.job_id)
    assert.equal(live?.genstudio_jobs?.[0]?.id, 'provider-transform')
    assert.equal(live?.remote_cancellations?.['image.generation:provider-transform']?.status, 'requested')
  })

  test('a blocked ordinary checkpoint cannot erase concurrent authoritative cancellation evidence', async () => {
    const project = await pm.createProject({ name: 'Mixed Durable Mutation Race' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const [job] = await createQueuedJobs(project.slug, 1)
    assert.ok(job)
    let releaseWrite!: () => void
    let enteredWrite!: () => void
    const released = new Promise<void>(resolve => { releaseWrite = resolve })
    const entered = new Promise<void>(resolve => { enteredWrite = resolve })
    let blocked = false
    const restore = jq._setJobFileLockProbeForTesting(async operation => {
      if (operation !== 'persist' || blocked) return
      blocked = true
      enteredWrite()
      await released
    })
    try {
      const cancellationWrite = jq.mutateAuthoritativeJob(project.slug, job.job_id, current => ({
        ...current,
        remote_cancellations: {
          ...(current.remote_cancellations || {}),
          'image.generation:accepted-mixed-race': {
            status: 'requested', operation: 'image.generation', provider_job_id: 'accepted-mixed-race',
            requested_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:01.000Z',
          },
        },
      }))
      await entered
      const providerWrite = jq.recordGenStudioJob(job.job_id, {
        id: 'accepted-mixed-race', operation: 'image.generation', state: 'running',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
      releaseWrite()
      await Promise.all([providerWrite, cancellationWrite])
    } finally {
      restore()
      releaseWrite!()
    }

    const reloaded = (await readJobs(jobsFile)).find(candidate => candidate.job_id === job.job_id)
    assert.equal(reloaded?.genstudio_jobs?.some(entry => entry.id === 'accepted-mixed-race'), true)
    assert.equal(
      reloaded?.remote_cancellations?.['image.generation:accepted-mixed-race']?.status,
      'requested',
    )
  })

  test('bounded shutdown drain waits for a blocked writer and reports timeout explicitly', async () => {
    const project = await pm.createProject({ name: 'Shutdown Persistence Drain' })
    const [job] = await createQueuedJobs(project.slug, 1)
    assert.ok(job)
    let releaseWrite!: () => void
    let enteredWrite!: () => void
    const released = new Promise<void>(resolve => { releaseWrite = resolve })
    const entered = new Promise<void>(resolve => { enteredWrite = resolve })
    let blocked = false
    const restore = jq._setJobFileLockProbeForTesting(async operation => {
      if (operation !== 'persist' || blocked) return
      blocked = true
      enteredWrite()
      await released
    })
    try {
      const write = jq.recordGenStudioJob(job.job_id, {
        id: 'shutdown-drain', operation: 'image.generation', state: 'running',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
      await entered
      assert.equal(await jq.drainJobPersistenceForShutdown(5), false)
      let drained = false
      const drain = jq.drainJobPersistenceForShutdown(1_000).then(result => {
        drained = result
        return result
      })
      await Promise.resolve()
      assert.equal(drained, false)
      releaseWrite()
      assert.equal(await drain, true)
      await write
    } finally {
      restore()
      releaseWrite!()
    }
  })

  test('a failed writer rejects its waiter and the next mutation drains the retained latest state', async () => {
    const project = await pm.createProject({ name: 'Failed Evidence Drain' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const [first, second] = await createQueuedJobs(project.slug, 2)
    let thrown = false
    const restore = jq._setJobFileLockProbeForTesting(operation => {
      if (operation === 'persist' && !thrown) {
        thrown = true
        throw new Error('injected durable write failure')
      }
    })
    await assert.rejects(
      jq.recordGenStudioJob(first!.job_id, {
        id: 'failed-drain-first', operation: 'image.generation', state: 'running', updated_at: '2026-01-01T00:00:00.000Z',
      }),
      /injected durable write failure/,
    )
    restore()

    await jq.recordGenStudioJob(second!.job_id, {
      id: 'recovery-drain-second', operation: 'image.generation', state: 'running', updated_at: '2026-01-01T00:00:01.000Z',
    })

    const persisted = await readJobs(jobsFile)
    assert.equal(persisted.find(job => job.job_id === first!.job_id)?.genstudio_jobs?.[0]?.id, 'failed-drain-first')
    assert.equal(persisted.find(job => job.job_id === second!.job_id)?.genstudio_jobs?.[0]?.id, 'recovery-drain-second')
  })

  test('nonterminal evidence does no public serialization when no renderer is listening', async () => {
    const project = await pm.createProject({ name: 'No Renderer Listener' })
    const [job] = await createQueuedJobs(project.slug, 1)
    assert.equal(jq.jobEvents.listenerCount('update'), 0)
    jq._resetJobPersistenceCountersForTesting()

    await jq.recordGenStudioJob(job!.job_id, {
      id: 'no-listener-evidence', operation: 'image.generation', state: 'running', updated_at: '2026-01-01T00:00:00.000Z',
    })

    assert.equal(jq._getJobPersistenceCountersForTesting().public_serializations, 0)
  })
})
