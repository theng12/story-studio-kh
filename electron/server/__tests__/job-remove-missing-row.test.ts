/**
 * A row can outlive the job it names.
 *
 * The owner, 2026-11-04: "i can't clear this 8 jobs, so i hid it. and i still
 * can't clear it. it's still there. so annoying. it keep saying job not
 * found." Eight finished Video Assembly rows on Wonder in Ink, and both the
 * row's own Hide and the bulk hide answered "Job not found" and left the rows.
 *
 * The root cause is that the LIST and the mutation read two different stores:
 * the list is served by the history read, which falls back to the scope's
 * saved jobs file, while the mutation read the queue's in-memory map. A row
 * the map no longer holds is on screen and cannot be hidden or restored.
 *
 * The rule this test pins: the saved-history row hides and restores like any
 * other, and it is never deleted.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import * as jq from '../services/job-queue.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
})

after(async () => { await cleanup() })

/**
 * A finished row the queue's memory map does not hold: it exists only in the
 * scope's saved jobs file, which is where the history read finds it.
 */
async function seedSavedOnlyRow(projectSlug: string, jobId: string): Promise<void> {
  const jobsFile = path.join(pm.getProjectDir(projectSlug)!, 'jobs.json')
  const parsed = JSON.parse(await fs.readFile(jobsFile, 'utf-8').catch(() => JSON.stringify({ jobs: [] })))
  const rows = Array.isArray(parsed.jobs) ? parsed.jobs : []
  rows.push({
    job_id: jobId,
    project_slug: projectSlug,
    type: 'video_assembly',
    episode_id: 'WI0011',
    title: 'Video Assembly',
    status: 'done',
    created_at: '2026-10-25T00:00:00.000Z',
    started_at: '2026-10-25T00:00:00.000Z',
    finished_at: '2026-10-26T00:00:00.000Z',
    error: null,
    output_lines: [],
    params: {},
  })
  await fs.writeFile(jobsFile, JSON.stringify({ ...parsed, jobs: rows }))
}

function listed(body: { jobs?: Array<{ job_id: string }> }, jobId: string): boolean {
  return (body.jobs || []).some(job => job.job_id === jobId)
}

describe('hiding a row whose job is gone', () => {
  test('the row hides and restores instead of answering "Job not found"', async () => {
    const project = await pm.createProject({ name: 'Stale Row' })
    await seedSavedOnlyRow(project.slug, 'stale-row-job')

    // The history read is what puts the row on screen.
    const history = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`)
    assert.equal(history.status, 200)
    assert.equal(listed(history.body, 'stale-row-job'), true, 'the finished row is on the list')

    const hidden = await request(app).post(`/api/projects/${project.slug}/jobs/stale-row-job/hide`)
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body.ok, true)

    // The row leaves the visible list and comes back through the Hidden read.
    const afterHide = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`)
    assert.equal(listed(afterHide.body, 'stale-row-job'), false, 'the row is off the visible list')
    const hiddenRead = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1&hidden=1`)
    assert.equal(listed(hiddenRead.body, 'stale-row-job'), true, 'the Hidden read still holds the record')

    await jq._waitForJobPersistenceForTesting()
    const jobsFile = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
    const saved = JSON.parse(await fs.readFile(jobsFile, 'utf-8')) as { jobs?: Array<{ job_id: string; hidden_at?: string }> }
    const row = (saved.jobs || []).find(job => job.job_id === 'stale-row-job')
    assert.ok(row, 'the record is still saved, not deleted')
    assert.ok(row!.hidden_at, 'the saved row carries the hide')

    const restored = await request(app).post(`/api/projects/${project.slug}/jobs/stale-row-job/unhide`)
    assert.equal(restored.status, 200)
    const afterRestore = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`)
    assert.equal(listed(afterRestore.body, 'stale-row-job'), true, 'Restore puts the row back')

    await jq._waitForJobPersistenceForTesting()
    const afterFile = JSON.parse(await fs.readFile(jobsFile, 'utf-8')) as { jobs?: Array<{ job_id: string; hidden_at?: string }> }
    const restoredRow = (afterFile.jobs || []).find(job => job.job_id === 'stale-row-job')
    assert.ok(restoredRow, 'the record is still saved after Restore')
    assert.equal(restoredRow!.hidden_at, undefined, 'the hide is cleared, not left as a false')
  })

  test('a job nobody holds is still a real "not found"', async () => {
    const project = await pm.createProject({ name: 'Never Existed' })
    const hidden = await request(app).post(`/api/projects/${project.slug}/jobs/never-existed/hide`)
    assert.equal(hidden.status, 404)
    assert.equal(hidden.body.detail, 'Job not found')
  })
})
