/**
 * Tests for job-queue: enqueue, duplicate detection, cancel, persistence.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

// Note: unlike other test files, we avoid beforeEach cleanup because the
// job-queue service has module-level state (jobs Map, loaded projects) that
// persists across tests, and concurrent file writes can collide with rm.
// Each test uses a unique project name to stay isolated.

describe('enqueue()', () => {
  test('creates a job with generated UUID, status=queued', async () => {
    const proj = await pm.createProject({ name: 'JQ1' })
    // Register a no-op executor so the job doesn't actually run anything
    jq.registerExecutor('script-only', async () => {})
    const job = jq.enqueue({
      project_slug: proj.slug,
      type: 'script-only',
      episode_id: 'EP001',
      title: 'Test script',
      params: {},
    })
    assert.ok(job.job_id.length > 0)
    // Status might immediately become 'running' if queue was empty
    assert.ok(['queued', 'running', 'done'].includes(job.status))
    assert.equal(job.type, 'script-only')
    assert.equal(job.episode_id, 'EP001')
  })

  test('multiple jobs with different episode IDs coexist', async () => {
    const proj = await pm.createProject({ name: 'JQ2' })
    jq.registerExecutor('script-only', async () => {})
    const j1 = jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'EP001', title: 'a', params: {},
    })
    const j2 = jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'EP002', title: 'b', params: {},
    })
    assert.notEqual(j1.job_id, j2.job_id)
  })
})

describe('isDuplicate()', () => {
  test('returns false when no pending/running job', async () => {
    const proj = await pm.createProject({ name: 'JQDup1' })
    const dup = jq.isDuplicate(proj.slug, 'EP999', 'script-only')
    assert.equal(dup, false)
  })

  test('returns true for in-flight job with same key', async () => {
    const proj = await pm.createProject({ name: 'JQDup2' })
    // Executor that never completes — keeps the job in 'running'
    let release!: () => void
    const block = new Promise<void>((r) => { release = r })
    jq.registerExecutor('script-only', async () => await block)

    jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'EP001', title: 't', params: {},
    })

    // Give the queue a tick to pick up the job
    await new Promise((r) => setTimeout(r, 50))

    const dup = jq.isDuplicate(proj.slug, 'EP001', 'script-only')
    assert.equal(dup, true)

    // Clean up — release the blocked executor
    release()
    await new Promise((r) => setTimeout(r, 50))
  })
})

describe('getJobs() / getQueueStats()', () => {
  test('returns all jobs for a project', async () => {
    const proj = await pm.createProject({ name: 'JQList' })
    jq.registerExecutor('script-only', async () => {})
    jq.enqueue({ project_slug: proj.slug, type: 'script-only', episode_id: 'EP001', title: 'a', params: {} })
    jq.enqueue({ project_slug: proj.slug, type: 'script-only', episode_id: 'EP002', title: 'b', params: {} })

    // Wait for sync execution
    await new Promise((r) => setTimeout(r, 50))

    const list = await jq.getJobs(proj.slug)
    const codes = list.map((j) => j.episode_id)
    assert.ok(codes.includes('EP001'))
    assert.ok(codes.includes('EP002'))
  })

  test('tolerates persisted legacy job types with no queue lane', async () => {
    const proj = await pm.createProject({ name: 'JQLegacyType' })
    const jobsPath = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    await fs.writeFile(jobsPath, JSON.stringify({
      jobs: [{
        job_id: 'legacy01',
        project_slug: proj.slug,
        type: 'scene_review',
        episode_id: 'EP001',
        title: 'Retired scene review job',
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        error: null,
        output_lines: [],
        params: {},
      }],
    }, null, 2))

    const list = await jq.getJobs(proj.slug)
    const legacy = list.find(j => j.job_id === 'legacy01')
    assert.equal(legacy?.type, 'scene_review')
    assert.equal(legacy?.status, 'error')
    assert.equal(legacy?.error, 'Interrupted by app restart')
  })

  test('getQueueStats reports counts', async () => {
    const proj = await pm.createProject({ name: 'JQStats' })
    jq.registerExecutor('script-only', async () => {})
    jq.enqueue({ project_slug: proj.slug, type: 'script-only', episode_id: 'EP100', title: 'a', params: {} })
    await new Promise((r) => setTimeout(r, 50))

    const stats = jq.getQueueStats(proj.slug)
    assert.ok(typeof stats.total === 'number')
    assert.ok(stats.total >= 1)
  })
})

describe('pipeline chain handoff failures', () => {
  test('persists a failed child job instead of reporting a false-success batch', async () => {
    const proj = await pm.createProject({ name: 'JQ Chain Handoff' })
    jq.registerExecutor('script-only', async () => {})
    const batchId = 'batch-handoff-test'
    jq.enqueue({
      project_slug: proj.slug,
      type: 'script-only',
      episode_id: 'EP001',
      title: 'chain head',
      params: {
        pipeline_batch_id: batchId,
        pipeline_chain: [{
          type: 'removed-job-type',
          title: 'missing next step',
          params: { marker: 'preserved' },
        }],
      },
    })

    const deadline = Date.now() + 2000
    let failed: any
    while (Date.now() < deadline) {
      const list = await jq.getJobs(proj.slug)
      failed = list.find(j => (j.params as any)?.pipeline_handoff_failed === true)
      if (failed) break
      await new Promise(r => setTimeout(r, 20))
    }

    assert.ok(failed, 'handoff failure should create a visible child job')
    assert.equal(failed.status, 'error')
    assert.equal(failed.type, 'removed-job-type')
    assert.equal(failed.params.pipeline_batch_id, batchId)
    assert.equal(failed.params.marker, 'preserved')
    assert.match(failed.error, /handoff failed/i)
  })
})

describe('cancelJob()', () => {
  test('returns false for unknown job ID', () => {
    const ok = jq.cancelJob('does-not-exist')
    assert.equal(ok, false)
  })

  test('cancels a queued job', async () => {
    const proj = await pm.createProject({ name: 'JQCancel' })
    // Executor that blocks forever
    let release!: () => void
    const block = new Promise<void>((r) => { release = r })
    jq.registerExecutor('script-only', async () => await block)

    // Fill the single-slot queue first
    jq.enqueue({ project_slug: proj.slug, type: 'script-only', episode_id: 'EP_HOLD', title: 'hold', params: {} })
    // Second job should be queued (not running)
    const second = jq.enqueue({ project_slug: proj.slug, type: 'script-only', episode_id: 'EP_CANCEL', title: 'c', params: {} })

    const ok = jq.cancelJob(second.job_id)
    assert.equal(ok, true)

    // Clean up
    release()
    await new Promise((r) => setTimeout(r, 50))
  })
})

describe('Persistence — interrupted jobs on restart', () => {
  test('running jobs are marked as error on fresh module load', async () => {
    const proj = await pm.createProject({ name: 'JQPersist' })
    // Write a jobs.json with a "running" job simulating an interrupt
    const jobsFile = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({
      jobs: [{
        job_id: 'fake-interrupted-job',
        project_slug: proj.slug,
        type: 'script-only',
        episode_id: 'EP001',
        title: 'old running job',
        status: 'running',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        output_lines: [],
        params: {},
      }],
    }))

    // Fresh getJobs() will call loadPersistedJobs which marks running→error
    const list = await jq.getJobs(proj.slug)
    const target = list.find((j) => j.job_id === 'fake-interrupted-job')
    assert.ok(target, 'should have loaded the persisted job')
    assert.equal(target!.status, 'error')
    assert.equal(target!.error, 'Interrupted by app restart')
  })
})

describe('Concurrent enqueues across different job types', () => {
  test('parallel images + audio jobs all persist to jobs.json without lost entries', async () => {
    // Audit gap: images and audio run in different queue worker pools
    // (3 workers per type). Both write to the SAME jobs.json via
    // persistJob() — without the per-path withLock wrapping the
    // read-modify-write block, simultaneous completions could clobber
    // each other's persisted state. This test fires N concurrent jobs
    // across two types and asserts every one landed in jobs.json with
    // status=done.
    const proj = await pm.createProject({ name: 'JQ Concurrent' })
    jq.registerExecutor('images', async (j) => {
      // Tiny but non-trivial work so multiple jobs interleave on the
      // event loop and the persist write is genuinely racy.
      await new Promise((r) => setTimeout(r, 5))
      j.output_lines.push('done')
    })
    jq.registerExecutor('audio', async (j) => {
      await new Promise((r) => setTimeout(r, 5))
      j.output_lines.push('done')
    })

    const N = 12  // 6 images + 6 audio, exceeds the 3-worker pool per type
    const enqueued: string[] = []
    for (let i = 0; i < N / 2; i++) {
      const a = jq.enqueue({
        project_slug: proj.slug, type: 'images',
        episode_id: `EP${String(100 + i).padStart(3, '0')}`,
        title: `img-${i}`, params: {},
      })
      const b = jq.enqueue({
        project_slug: proj.slug, type: 'audio',
        episode_id: `EP${String(200 + i).padStart(3, '0')}`,
        title: `aud-${i}`, params: {},
      })
      enqueued.push(a.job_id, b.job_id)
    }

    // Each queue type is single-threaded (one worker per QueueState), so
    // 6 jobs × 5ms = ~30ms work per type. The dominating cost is the
    // jobs.json persist on every state transition (enqueue / start /
    // finish = 3 writes per job) — those serialize through withLock +
    // atomic rename, and on a slow disk each can take 30-50ms. 3s is a
    // safe upper bound for 12 jobs × 3 transitions in the worst case.
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const inMem = await jq.getJobs(proj.slug)
      const ours = inMem.filter(j => enqueued.includes(j.job_id))
      if (ours.length === N && ours.every(j => j.status === 'done')) break
      await new Promise((r) => setTimeout(r, 50))
    }

    // Read jobs.json directly to verify the persistence path didn't drop
    // entries — getJobs() reads from in-memory state, which doesn't catch
    // a missing-on-disk regression.
    const jobsFile = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    const raw = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
    const persistedIds = new Set(raw.jobs.map((j: any) => j.job_id))
    for (const id of enqueued) {
      assert.ok(persistedIds.has(id), `job ${id} missing from jobs.json — race lost it`)
    }
    // All settled cleanly.
    const inMemory = await jq.getJobs(proj.slug)
    const ours = inMemory.filter(j => enqueued.includes(j.job_id))
    assert.equal(ours.length, N, `expected ${N} jobs, got ${ours.length}`)
    assert.ok(ours.every(j => j.status === 'done'),
      `every job should be done; statuses: ${ours.map(j => j.status).join(',')}`)
  })
})

describe('recordAccountUsed()', () => {
  test('records one provider/account on a queued job and fires an update event', async () => {
    const proj = await pm.createProject({ name: 'JQ Account Use 1' })
    jq.registerExecutor('script-only', async () => {})
    const job = jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'EP001', title: 't', params: {},
    })
    let updates = 0
    const onUpdate = () => { updates++ }
    jq.jobEvents.on('update', onUpdate)
    try {
      jq.recordAccountUsed(job.job_id, 'openai', { id: 'acc-1', label: 'Personal' })
    } finally {
      jq.jobEvents.off('update', onUpdate)
    }
    const after = jq.getJob(job.job_id)!
    assert.deepEqual(after.accounts_used, { openai: { id: 'acc-1', label: 'Personal' } })
    assert.ok(updates >= 1, 'recording should fire at least one update event')
  })

  test('same provider overwrites with the latest resolution; other providers accumulate', async () => {
    const proj = await pm.createProject({ name: 'JQ Account Use 2' })
    jq.registerExecutor('script-only', async () => {})
    const job = jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'EP001', title: 't', params: {},
    })
    jq.recordAccountUsed(job.job_id, 'openai', { id: 'acc-1', label: 'A' })
    jq.recordAccountUsed(job.job_id, 'openai', { id: 'acc-2', label: 'B' })
    jq.recordAccountUsed(job.job_id, 'anthropic', { id: 'acc-3', label: 'Claude' })
    const after = jq.getJob(job.job_id)!
    assert.deepEqual(after.accounts_used, {
      openai:    { id: 'acc-2', label: 'B' },
      anthropic: { id: 'acc-3', label: 'Claude' },
    })
  })

  test('silent no-op for an unknown job id (attribution must never throw)', async () => {
    assert.doesNotThrow(() => {
      jq.recordAccountUsed('does-not-exist', 'openai', { id: 'x', label: 'x' })
    })
  })
})
