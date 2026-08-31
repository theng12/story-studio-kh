import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'
import { recordTaskStrict } from '../services/task-manifest.js'

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

function continuityTailJob(overrides: Record<string, unknown> = {}): any {
  const outputDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'continuity-tail-proof')
  const key = 'scene-001.png'
  return {
    job_id: 'continuity-tail-proof',
    project_slug: 'tail-proof-project',
    type: 'continuity_render',
    episode_id: 'EP001',
    title: 'Continuity tail proof',
    status: 'running',
    created_at: '2026-08-31T00:00:00.000Z',
    started_at: '2026-08-31T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    output_dir: outputDir,
    item_progress: {
      total: 3,
      completed: 2,
      failed: 0,
      settling: 1,
      cancelled: 0,
      not_submitted: 0,
      concurrency: 2,
      active: [{ label: 'Scene 1', key, state: 'running', attempt: 1, max_attempts: 1 }],
    },
    params: {
      episode_id: 'EP001',
      genstudio_recovery: {
        version: 1,
        route: 'genstudio',
        assets: {
          [key]: {
            operation: 'image',
            idempotency_key: 'story-image-key-001',
            job_id: 'image-task-001',
            output_path: path.join(outputDir, key),
            input_hash: 'sha256:tail-proof',
            state: 'accepted',
            updated_at: '2026-08-31T00:00:00.000Z',
          },
        },
      },
    },
    genstudio_jobs: [{
      id: 'image-task-001',
      operation: 'image.generation',
      state: 'running',
      updated_at: '2026-08-31T00:00:00.000Z',
      request: { idempotency_key: 'story-image-key-001' },
    }],
    ...overrides,
  }
}

async function writeContinuityTailManifest(job: any, entry: Record<string, unknown> = {}): Promise<void> {
  const key = 'scene-001.png'
  await mkdir(job.output_dir, { recursive: true })
  await recordTaskStrict(job.output_dir, key, {
    provider: 'genstudio',
    task_id: 'image-task-001',
    submitted_at: '2026-08-31T00:00:00.000Z',
    input_hash: 'sha256:tail-proof',
    idempotency_key: 'story-image-key-001',
    operation: 'image',
    last_state: 'accepted',
    ...entry,
  } as any)
}

async function proveTail(job: any): Promise<any> {
  const prove = (jq as any).proveContinuitySettlingTail
  assert.equal(typeof prove, 'function', 'the exact Continuity tail proof must be exported for its durable fixture')
  return prove(job)
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

describe('Continuity settling-tail proof', () => {
  test('binds each canonical active filename to one accepted nonterminal provider task', async () => {
    const job = continuityTailJob()
    await writeContinuityTailManifest(job)

    const proof = await proveTail(job)

    assert.deepEqual(proof, {
      job_id: job.job_id,
      settling: 1,
      concurrency: 2,
      active_asset_keys: ['scene-001.png'],
      provider_task_ids: ['image-task-001'],
    })
  })

  test('accepts one checkpoint-only id and one manifest-only id without guessing either', async () => {
    const checkpointOnly = continuityTailJob()
    checkpointOnly.params.genstudio_recovery.assets['scene-001.png'].job_id = 'image-task-001'
    await writeContinuityTailManifest(checkpointOnly, { task_id: '' })
    assert.equal((await proveTail(checkpointOnly))?.provider_task_ids[0], 'image-task-001')

    const manifestOnly = continuityTailJob()
    delete manifestOnly.params.genstudio_recovery.assets['scene-001.png'].job_id
    await writeContinuityTailManifest(manifestOnly)
    assert.equal((await proveTail(manifestOnly))?.provider_task_ids[0], 'image-task-001')
  })

  test('fails closed before capacity refresh for malformed progress or an unbound active key', async () => {
    const cases: Array<[string, (job: any) => void]> = [
      ['missing settling', job => { delete job.item_progress.settling }],
      ['fractional total', job => { job.item_progress.total = 3.5 }],
      ['negative failed', job => { job.item_progress.failed = -1 }],
      ['active count mismatch', job => { job.item_progress.active = [] }],
      ['arithmetic mismatch', job => { job.item_progress.completed = 1 }],
      ['unsubmitted scene', job => { job.item_progress.not_submitted = 1; job.item_progress.total = 4 }],
      ['waiting retry', job => { job.item_progress.active[0].state = 'waiting_retry' }],
      ['full wave', job => { job.item_progress.concurrency = 1 }],
      ['legacy scene-number key', job => { job.item_progress.active[0].key = 'scene-1' }],
      ['duplicate active key', job => {
        job.item_progress.total = 4
        job.item_progress.completed = 2
        job.item_progress.settling = 2
        job.item_progress.concurrency = 3
        job.item_progress.active.push({ ...job.item_progress.active[0] })
      }],
    ]
    for (const [name, mutate] of cases) {
      const job = continuityTailJob()
      await writeContinuityTailManifest(job)
      mutate(job)
      assert.equal(await proveTail(job), null, name)
    }
  })

  test('rejects every contradictory checkpoint, manifest, and provider binding', async () => {
    const cases: Array<[string, (job: any, manifest: Record<string, unknown>) => void]> = [
      ['missing recovery', job => { delete job.params.genstudio_recovery }],
      ['wrong recovery version', job => { job.params.genstudio_recovery.version = 2 }],
      ['wrong recovery route', job => { job.params.genstudio_recovery.route = 'other' }],
      ['missing active asset', job => { delete job.params.genstudio_recovery.assets['scene-001.png'] }],
      ['wrong checkpoint operation', job => { job.params.genstudio_recovery.assets['scene-001.png'].operation = 'video' }],
      ['pending checkpoint id', job => { job.params.genstudio_recovery.assets['scene-001.png'].job_id = 'pending:story-image-key-001' }],
      ['checkpoint manifest task disagreement', job => { job.params.genstudio_recovery.assets['scene-001.png'].job_id = 'image-task-other' }],
      ['checkpoint manifest key disagreement', job => { job.params.genstudio_recovery.assets['scene-001.png'].idempotency_key = 'story-other' }],
      ['wrong checkpoint output', job => { job.params.genstudio_recovery.assets['scene-001.png'].output_path = path.join(job.output_dir, 'scene-002.png') }],
      ['checkpoint manifest input-hash disagreement', job => { job.params.genstudio_recovery.assets['scene-001.png'].input_hash = 'sha256:other' }],
      ['blank task ids', (job, manifest) => {
        delete job.params.genstudio_recovery.assets['scene-001.png'].job_id
        manifest.task_id = ''
      }],
      ['wrong manifest operation', (_job, manifest) => { manifest.operation = 'video' }],
      ['blank manifest idempotency key', (_job, manifest) => { manifest.idempotency_key = '' }],
      ['missing provider evidence', job => { job.genstudio_jobs = [] }],
      ['duplicate provider evidence', job => { job.genstudio_jobs.push({ ...job.genstudio_jobs[0] }) }],
      ['wrong provider operation', job => { job.genstudio_jobs[0].operation = 'video.generation' }],
      ['terminal provider evidence', job => { job.genstudio_jobs[0].state = 'succeeded' }],
      ['cancelled provider evidence', job => { job.genstudio_jobs[0].cancelled = true }],
      ['provider idempotency mismatch', job => { job.genstudio_jobs[0].request.idempotency_key = 'story-other' }],
      ['not-created provider state', job => { job.genstudio_jobs[0].state = 'not_created' }],
      ['unknown provider state', job => { job.genstudio_jobs[0].state = 'something-new' }],
      ['blank provider state', job => { job.genstudio_jobs[0].state = '' }],
    ]
    for (const [name, mutate] of cases) {
      const job = continuityTailJob()
      const manifest: Record<string, unknown> = {}
      mutate(job, manifest)
      await writeContinuityTailManifest(job, manifest)
      assert.equal(await proveTail(job), null, name)
    }
  })

  test('keeps the exact checkpoint and manifest binding valid when bounded provider previews are absent', async () => {
    const job = continuityTailJob()
    await writeContinuityTailManifest(job)
    delete job.genstudio_jobs[0].request
    for (let index = 0; index < 9; index++) {
      job.genstudio_jobs.push({
        id: `old-image-${index}`,
        operation: 'image.generation',
        state: 'succeeded',
        updated_at: '2026-08-31T00:00:00.000Z',
      })
    }
    assert.equal((await proveTail(job))?.provider_task_ids[0], 'image-task-001')
  })

  test('rejects a count-perfect final wave when one active asset is unmapped or shares a provider task', async () => {
    const addSecondActive = (job: any) => {
      job.item_progress.total = 4
      job.item_progress.completed = 2
      job.item_progress.settling = 2
      job.item_progress.concurrency = 3
      job.item_progress.active.push({
        label: 'Scene 2', key: 'scene-002.png', state: 'running', attempt: 1, max_attempts: 1,
      })
    }

    const unmapped = continuityTailJob()
    addSecondActive(unmapped)
    await writeContinuityTailManifest(unmapped)
    assert.equal(await proveTail(unmapped), null, 'counts never substitute for a direct active-key binding')

    const duplicateProvider = continuityTailJob()
    addSecondActive(duplicateProvider)
    duplicateProvider.params.genstudio_recovery.assets['scene-002.png'] = {
      ...duplicateProvider.params.genstudio_recovery.assets['scene-001.png'],
      output_path: path.join(duplicateProvider.output_dir, 'scene-002.png'),
    }
    await writeContinuityTailManifest(duplicateProvider)
    await recordTaskStrict(duplicateProvider.output_dir, 'scene-002.png', {
      provider: 'genstudio', task_id: 'image-task-001', submitted_at: '2026-08-31T00:00:00.000Z',
      input_hash: 'sha256:tail-proof', idempotency_key: 'story-image-key-001', operation: 'image', last_state: 'accepted',
    })
    assert.equal(await proveTail(duplicateProvider), null, 'two active assets cannot share one provider task')
  })
})
