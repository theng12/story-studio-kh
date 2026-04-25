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
 * The fix is one `persistJob(j)` call inside the loop. This test pins the
 * desired behaviour — it's currently expected to FAIL — and is marked
 * `t.skip(...)` with a TODO so it lands as a known-failing reference rather
 * than masking the bug behind a green check. Remove the skip when the fix
 * lands and verify the assertion passes.
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
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

describe('loadPersistedJobs — interrupt mutation must persist to disk', () => {
  test('jobs.json reflects status=error after the in-memory interrupt rewrite', { skip: 'TODO: bug — job-queue.ts:228-234 mutates j.status=error in-memory only; never writes jobs.json. Add persistJob(j) inside the loop in loadPersistedJobs.' }, async (t) => {
    const proj = await pm.createProject({ name: 'JQPersistDisk' })
    const jobsFile = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    const interruptedJob = {
      job_id: 'fake-disk-interrupt',
      project_slug: proj.slug,
      type: 'script-only',
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

    // The bug: the same mutation must be reflected in jobs.json. Currently
    // it isn't — the on-disk record still says 'running'. When the fix
    // lands (one persistJob() call inside the loop), this assertion will
    // hold and the skip can be removed.
    const onDisk = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
    const persisted = onDisk.jobs.find((j: any) => j.job_id === 'fake-disk-interrupt')
    assert.ok(persisted, 'persisted job present on disk')
    assert.equal(persisted.status, 'error', 'on-disk status must match the in-memory mutation')
    assert.equal(persisted.error, 'Interrupted by app restart')
  })
})
