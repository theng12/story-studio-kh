/**
 * Persist-on-load invariant for `loadPersistedJobs` (Session 09 finding #4).
 *
 * On startup, an interrupted job (status === 'running' or 'queued' on disk
 * because the previous process never got to flip it) is rewritten in memory
 * as `status: 'error'`, error: 'Interrupted by app restart' (job-queue.ts
 * lines 268-272). The bug: that mutation lives in `jobs` Map only — the
 * on-disk `jobs.json` is left untouched. So the in-memory state lies about
 * what's persisted: a second process inspecting the file sees 'running'
 * forever, and the same load path will re-apply the same interrupt
 * mutation on every restart.
 *
 * The fix landed via `persistJob(j)` inside the loop's mutation branch —
 * see job-queue.ts `loadPersistedJobs`. This test pins the contract so a
 * future regression that drops the persist call is caught immediately.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const t = await useTempDataDir({
    retain: true,
    settle: () => jq._waitForJobPersistenceForTesting(),
  })
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

describe('loadPersistedJobs — interrupt mutation must persist to disk', () => {
  test('jobs.json reflects status=error after the in-memory interrupt rewrite', async (t) => {
    const proj = await pm.createProject({ name: 'JQPersistDisk' })
    const jobsFile = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    const interruptedJob = {
      job_id: 'fake-disk-interrupt',
      project_slug: proj.slug,
      type: 'chapter-only',
      episode_id: 'EP001',
      title: 'old running job',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      output_lines: [],
      params: {},
    }
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [interruptedJob] }))

    // Trigger loadPersistedJobs via the public getJobs() entry point.
    const list = await jq.getJobs(proj.slug)
    const inMem = list.find((j) => j.job_id === 'fake-disk-interrupt')
    assert.ok(inMem, 'in-memory job present')
    assert.equal(inMem!.status, 'error', 'in-memory mutation already correct (this is the existing covered behaviour)')

    // The fix: the same mutation must be reflected in jobs.json. With
    // the persistJob(j) call inside the loop, the on-disk record now
    // matches the in-memory state.
    const onDisk = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
    const persisted = onDisk.jobs.find((j: any) => j.job_id === 'fake-disk-interrupt')
    assert.ok(persisted, 'persisted job present on disk')
    assert.equal(persisted.status, 'error', 'on-disk status must match the in-memory mutation')
    assert.equal(persisted.error, 'Interrupted by app restart')
  })
})
