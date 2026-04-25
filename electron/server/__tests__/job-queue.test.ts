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
