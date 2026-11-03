/**
 * A row can outlive the job it names.
 *
 * The owner, 2026-11-04: "i can't clear this 8 jobs, so i hid it. and i still
 * can't clear it. it's still there. so annoying. it keep saying job not
 * found." Eight finished Video Assembly rows on Wonder in Ink, and both the
 * row's own "Remove From List" and the bulk "Remove Finished From List (8)"
 * answered "Job not found" and left the rows.
 *
 * The root cause is that the LIST and the REMOVAL read two different stores:
 * the list is served by the history read, which falls back to the scope's
 * saved jobs file, while the removal read the queue's in-memory map. A row
 * the map no longer holds is on screen and cannot be removed.
 *
 * The rule this test pins: when the job is gone, the row goes anyway. The
 * customer's goal — that row off the list — is what the removal is for.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

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

describe('removing a row whose job is gone', () => {
  test('the row comes off the list instead of answering "Job not found"', async () => {
    const project = await pm.createProject({ name: 'Stale Row' })
    await seedSavedOnlyRow(project.slug, 'stale-row-job')

    // The history read is what puts the row on screen.
    const history = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`)
    assert.equal(history.status, 200)
    assert.ok(
      (history.body.jobs || []).some((job: { job_id: string }) => job.job_id === 'stale-row-job'),
      'the finished row is on the list',
    )

    // The removal answers with the row gone, not with a refusal.
    const removed = await request(app).delete(`/api/projects/${project.slug}/jobs/stale-row-job`)
    assert.equal(removed.status, 200)
    assert.equal(removed.body.ok, true)

    // And it is gone: not on the list, and not in the scope's saved history.
    const after = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`)
    assert.equal(after.status, 200)
    assert.equal(
      (after.body.jobs || []).some((job: { job_id: string }) => job.job_id === 'stale-row-job'),
      false,
      'the leftover row is off the list',
    )
    const jobsFile = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
    const saved = JSON.parse(await fs.readFile(jobsFile, 'utf-8')) as { jobs?: Array<{ job_id: string }> }
    assert.equal(
      (saved.jobs || []).some(job => job.job_id === 'stale-row-job'),
      false,
      'the saved history no longer holds the row',
    )
  })

  test('a job nobody holds is still a real "not found"', async () => {
    const project = await pm.createProject({ name: 'Never Existed' })
    const removed = await request(app).delete(`/api/projects/${project.slug}/jobs/never-existed`)
    assert.equal(removed.status, 404)
    assert.equal(removed.body.detail, 'Job not found')
  })
})
