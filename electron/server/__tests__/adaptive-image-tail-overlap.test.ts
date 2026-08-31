import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const queueSource = () => readFile(path.join(SERVER, 'services/job-queue.ts'), 'utf8')

let cleanup: (() => Promise<void>) | undefined
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const isolated = await useTempDataDir()
  cleanup = isolated.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => {
  jq.setImageEpisodeConcurrency(2)
  await cleanup?.()
})

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForPersistedTerminal(
  jobsFile: string,
  jobIds: string[],
  label: string,
): Promise<void> {
  // The queue's terminal status is persisted asynchronously. Poll the durable
  // file until every fixture is terminal, so cleanup observes the write
  // instead of relying on a wall-clock delay.
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      const rows = JSON.parse(await readFile(jobsFile, 'utf8')).jobs as Array<{ job_id: string; status: string }>
      if (jobIds.every(id => rows.some(row => row.job_id === id && ['done', 'error', 'cancelled'].includes(row.status)))) return
    } catch { /* the first atomic write may not exist yet */ }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('image episode admission fairness', () => {
  test('alternates continuity and pool opportunities while preserving each FIFO', async () => {
    const project = await pm.createProject({ name: 'Adaptive image fairness' })
    const jobsFile = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', project.slug, 'jobs.json')
    const jobs: Array<{ job_id: string; episode_id: string }> = []
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const active = new Set<string>()
    let peakActive = 0

    const executor = async (job: { episode_id: string }) => {
      started.push(job.episode_id)
      active.add(job.episode_id)
      peakActive = Math.max(peakActive, active.size)
      await new Promise<void>(resolve => releases.set(job.episode_id, resolve))
      active.delete(job.episode_id)
    }

    jq.registerExecutor('continuity_render', executor)
    jq.registerExecutor('image_pool_generate', executor)
    jq.setImageEpisodeConcurrency(2)

    // Pool p2 is queued before continuity c2. A fixed type iteration would
    // let the pool consume both available opportunities after c1 finishes.
    for (const [type, episode_id] of [
      ['continuity_render', 'continuity:c1'],
      ['image_pool_generate', 'pool:p1'],
      ['image_pool_generate', 'pool:p2'],
      ['continuity_render', 'continuity:c2'],
      ['continuity_render', 'continuity:c3'],
      ['image_pool_generate', 'pool:p3'],
    ] as const) {
      const queued = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type,
        episode_id,
        title: episode_id,
        params: {},
      })
      jobs.push({ job_id: queued.job_id, episode_id })
    }

    const release = async (episode_id: string) => {
      await waitFor(() => releases.has(episode_id), `${episode_id} to enter its executor`)
      releases.get(episode_id)!()
    }
    try {
      await waitFor(() => active.size === 2, 'the base image group to fill')
      assert.equal(peakActive, 2)
      assert.deepEqual(started.slice(0, 2), ['continuity:c1', 'pool:p1'])

      await release('continuity:c1')
      await release('pool:p1')
      await waitFor(() => started.length >= 4, 'the second pair to start')

      assert.deepEqual(started.slice(0, 4), [
        'continuity:c1',
        'pool:p1',
        'continuity:c2',
        'pool:p2',
      ])

      await release('continuity:c2')
      await release('pool:p2')
      await waitFor(() => started.includes('continuity:c3') && started.includes('pool:p3'), 'the final FIFO pair to start')
      assert.deepEqual(started.filter(id => id.startsWith('continuity:')), ['continuity:c1', 'continuity:c2', 'continuity:c3'])
      assert.deepEqual(started.filter(id => id.startsWith('pool:')), ['pool:p1', 'pool:p2', 'pool:p3'])
      await release('continuity:c3')
      await release('pool:p3')
      await waitFor(() => active.size === 0, 'all image jobs to settle')
    } finally {
      const released = new Set<string>()
      await waitFor(() => {
        for (const episode_id of jobs.map(row => row.episode_id)) {
          if (releases.has(episode_id) && !released.has(episode_id)) {
            released.add(episode_id)
            releases.get(episode_id)!()
          }
        }
        return jobs.every(row => ['done', 'error', 'cancelled'].includes(jq.getJob(row.job_id)?.status || ''))
      }, 'all fairness executors to settle').catch(() => {})
      await waitForPersistedTerminal(jobsFile, jobs.map(row => row.job_id), 'all fairness jobs to persist')
    }
  })

  test('already-started jobs precede fresh jobs without changing either FIFO', async () => {
    const project = await pm.createProject({ name: 'Adaptive image recovery FIFO' })
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const active = new Set<string>()
    const executor = async (job: { episode_id: string }) => {
      started.push(job.episode_id)
      active.add(job.episode_id)
      await new Promise<void>(resolve => releases.set(job.episode_id, resolve))
      active.delete(job.episode_id)
    }
    jq.registerExecutor('continuity_render', executor)
    jq.registerExecutor('image_pool_generate', executor)
    jq.setImageEpisodeConcurrency(1)

    const hold = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'image_pool_generate',
      episode_id: 'pool:hold',
      title: 'pool:hold',
      params: {},
    })
    assert.equal(hold.status, 'running')
    const fresh = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: 'continuity:fresh-1',
      title: 'continuity:fresh-1',
      params: {},
    })
    const recovery = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: 'continuity:recovery-1',
      title: 'continuity:recovery-1',
      params: {},
      // Test-only fixture marker; the live job remains queued behind hold.
      started_at: '2026-08-31T00:00:00.000Z',
    } as any)
    const fresh2 = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: 'continuity:fresh-2',
      title: 'continuity:fresh-2',
      params: {},
    })
    const recovery2 = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: 'continuity:recovery-2',
      title: 'continuity:recovery-2',
      params: {},
      started_at: '2026-08-31T00:01:00.000Z',
    } as any)
    assert.equal(fresh.status, 'queued')
    assert.equal(recovery.status, 'queued')
    assert.equal(fresh2.status, 'queued')
    assert.equal(recovery2.status, 'queued')

    await waitFor(() => releases.has('pool:hold'), 'the holding pool job to start')
    releases.get('pool:hold')!()
    await waitFor(() => started.includes('continuity:recovery-1'), 'the recovery job to start first')
    assert.deepEqual(started.slice(0, 2), ['pool:hold', 'continuity:recovery-1'])
    releases.get('continuity:recovery-1')!()
    await waitFor(() => started.includes('continuity:recovery-2'), 'the second recovery job to start')
    releases.get('continuity:recovery-2')!()
    await waitFor(() => started.includes('continuity:fresh-1'), 'the first fresh job to start')
    releases.get('continuity:fresh-1')!()
    await waitFor(() => started.includes('continuity:fresh-2'), 'the second fresh job to start')
    releases.get('continuity:fresh-2')!()
    await waitFor(() => started.length === 5, 'all recovery FIFO fixtures to settle')
    assert.deepEqual(started.slice(1), [
      'continuity:recovery-1',
      'continuity:recovery-2',
      'continuity:fresh-1',
      'continuity:fresh-2',
    ])
    await waitFor(() => active.size === 0, 'all recovery FIFO executors to settle')
    await waitFor(() => [hold, fresh, recovery, fresh2, recovery2].every(row => {
      const status = jq.getJob(row.job_id)?.status
      return status === 'done' || status === 'error' || status === 'cancelled'
    }), 'all recovery FIFO jobs to persist their terminal status')
    await waitForPersistedTerminal(
      path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', project.slug, 'jobs.json'),
      [hold, fresh, recovery, fresh2, recovery2].map(row => row.job_id),
      'all recovery FIFO jobs to persist',
    )
  })

  test('a queued image recovery timestamp survives repeated boot before fresh work', async () => {
    const project = await pm.createProject({ name: 'Adaptive image repeated boot' })
    const jobsFile = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', project.slug, 'jobs.json')
    const recoveryId = 'persisted-recovery'
    const freshId = 'persisted-fresh'
    await (await import('node:fs/promises')).writeFile(jobsFile, JSON.stringify({ jobs: [
      {
        job_id: freshId,
        project_slug: project.slug,
        type: 'continuity_render',
        episode_id: 'continuity:persisted-fresh',
        title: 'persisted fresh',
        status: 'queued',
        created_at: '2026-08-31T00:01:00.000Z',
        started_at: null,
        finished_at: null,
        error: null,
        output_lines: [],
        params: {},
      },
      {
        job_id: recoveryId,
        project_slug: project.slug,
        type: 'continuity_render',
        episode_id: 'continuity:persisted-recovery',
        title: 'persisted recovery',
        status: 'queued',
        created_at: '2026-08-31T00:00:00.000Z',
        started_at: '2026-08-31T00:00:00.000Z',
        finished_at: null,
        error: null,
        output_lines: [],
        params: {},
      },
    ] }))

    const queueUrl = new URL('../services/job-queue.js', import.meta.url).href
    const firstBoot = await import(`${queueUrl}?repeat-boot=1`)
    await firstBoot.setQueuePaused(true)
    firstBoot.setImageEpisodeConcurrency(1)
    firstBoot.registerExecutor('continuity_render', async () => {})
    await firstBoot.getJobs(project.slug)

    // A second queue module represents a fresh process loading the same
    // persisted records. Keep its lane paused until the file has been read.
    const secondBoot = await import(`${queueUrl}?repeat-boot=2`)
    secondBoot.setImageEpisodeConcurrency(1)
    const started: string[] = []
    let release!: () => void
    secondBoot.registerExecutor('continuity_render', async (job: { episode_id: string }) => {
      started.push(job.episode_id)
      await new Promise<void>(resolve => { release = resolve })
    })
    await secondBoot.getJobs(project.slug)
    await secondBoot.setQueuePaused(false)
    await waitFor(() => started.length === 1, 'the persisted recovery job to start')
    assert.deepEqual(started, ['continuity:persisted-recovery'])
    release()
    await waitFor(() => started.length === 2, 'the fresh persisted job to start second')
    assert.deepEqual(started, ['continuity:persisted-recovery', 'continuity:persisted-fresh'])
    release()
    await waitForPersistedTerminal(jobsFile, [recoveryId, freshId], 'repeated-boot jobs to persist')
  })

  test('image admission contains no size or duration priority terms', async () => {
    const body = await queueSource()
    const start = body.indexOf('function nextImageGroupJob')
    const end = body.indexOf('function releaseSlot', start)
    assert.ok(start >= 0, 'the shared image pump must be present')
    const admission = body.slice(start, end)
    for (const term of ['remaining', 'estimated', 'duration', 'sceneCount', 'percentage', 'SRTF', 'shortest']) {
      assert.doesNotMatch(admission, new RegExp(`\\b${term}\\b`, 'i'), `image admission must not rank by ${term}`)
    }
    assert.doesNotMatch(admission, /\.sort\s*\(/, 'image admission must not sort jobs')
  })
})
