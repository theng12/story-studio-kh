/**
 * Health must answer from memory while the filesystem does not.
 *
 * Re-measured Production shape (angkor, 2026-11-18): disk-touching routes
 * hung while the pure in-memory job read kept answering — that the disk was
 * the shared cause is a hypothesis only. What is pinned here: with
 * `fs.readFile` never settling, `GET /api/health` still answers within 2 s
 * with `{status, version, boot_complete, waiting}` (the version resolved once
 * at boot), and a per-project job read answers too. The stall is injected;
 * no production fault is added.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import fsp from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const JOB_ID = 'stall-immune-job'
const SLUG = 'stall-immune'

let cleanup: () => Promise<void>
let app: any
let packageVersion: string

before(async () => {
  const isolated = await useTempDataDir()
  cleanup = isolated.cleanup
  const tempDir = isolated.dir

  // Seed one job into memory while fs is still healthy.
  const seedDir = path.join(tempDir, 'projects', SLUG)
  await fs.mkdir(seedDir, { recursive: true })
  await fs.writeFile(path.join(seedDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      job_id: JOB_ID,
      project_slug: SLUG,
      type: 'chapter-only',
      episode_id: 'EP0001',
      title: 'stalled fs probe',
      status: 'done',
      created_at: '2026-11-18T00:00:00.000Z',
      finished_at: '2026-11-18T00:01:00.000Z',
      error: null,
      output_lines: [],
      params: {},
    }],
  }))
  const jq = await import('../services/job-queue.js')
  await jq.getJobs(SLUG)

  packageVersion = JSON.parse(
    await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  ).version

  const appModule = await import('../app.js')
  app = appModule.app
  // The version is resolved once at boot — wait for it BEFORE the stall.
  await appModule.healthVersionReady
})

after(async () => { await cleanup() })

test('health and a per-project job read answer while fs.readFile never settles', async () => {
  const realReadFile = (fsp as { readFile: (...args: any[]) => Promise<string> }).readFile
  ;(fsp as { readFile: unknown }).readFile = () => new Promise(() => { /* never settles */ })
  try {
    const health = await request(app).get('/api/health').timeout({ response: 2_000, deadline: 2_000 })
    assert.equal(health.status, 200)
    assert.equal(health.body.status, 'ok')
    assert.equal(health.body.version, packageVersion, 'the boot-resolved version, not a fresh read')
    assert.equal(typeof health.body.boot_complete, 'boolean')
    assert.ok(Array.isArray(health.body.waiting))
    // A paused queue takes no work, and health is where a person or an agent looks first.
    // (The paused branch itself is pinned in queue-pause-ownership.test.ts — this test has
    // fs.readFile stalled, so it must not write settings.)
    assert.equal(health.body.queue.paused, false)

    const job = await request(app)
      .get(`/api/projects/${SLUG}/jobs/${JOB_ID}`)
      .timeout({ response: 2_000, deadline: 2_000 })
    assert.equal(job.status, 200)
    assert.equal(job.body.job_id, JOB_ID, 'the in-memory row answers while fs is stalled')
  } finally {
    ;(fsp as { readFile: unknown }).readFile = realReadFile
  }
})
