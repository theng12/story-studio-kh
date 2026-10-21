/**
 * The Jobs toolbar offers two terminal-history cleanup actions. They must use
 * the same strict Recovered marker as the display, keep active provider work,
 * and never let a project-scoped request erase another project's history.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let app: express.Express

function historyRow(
  jobId: string,
  projectSlug: string,
  status: 'done' | 'error' | 'cancelled',
  overrides: Record<string, unknown> = {},
) {
  return {
    job_id: jobId,
    project_slug: projectSlug,
    type: 'chapter-only',
    episode_id: 'EP-CLEAR',
    title: `history ${jobId}`,
    status,
    created_at: '2026-09-09T00:00:00.000Z',
    started_at: '2026-09-09T00:00:00.000Z',
    finished_at: '2026-09-09T00:01:00.000Z',
    error: status === 'error' ? 'original failure' : null,
    output_lines: [],
    params: {},
    remote_cancellations: {},
    genstudio_jobs: [{
      id: `${jobId}-provider`,
      operation: 'image.generation',
      state: status === 'error' ? 'failed' : 'succeeded',
      updated_at: '2026-09-09T00:01:00.000Z',
    }],
    ...overrides,
  }
}

async function seed(scope: string, rows: unknown[]): Promise<void> {
  const directory = path.join(tempDir, 'projects', scope)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify({ jobs: rows }))
  await jq.getJobs(scope)
}

before(async () => {
  const isolated = await useTempDataDir({
    retain: true,
    settle: () => jq._waitForJobPersistenceForTesting(),
  })
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  const { router } = await import('../routes/jobs.js')
  app = express().use(express.json()).use('/api', router)
})

after(async () => { await cleanup() })

test('history clear selectors honor recovered display, scope, app jobs, and legacy default', async () => {
  const project = await pm.createProject({ name: 'Clear selector project' })
  const other = await pm.createProject({ name: 'Clear selector other project' })
  await seed(project.slug, [
    historyRow('project-done', project.slug, 'done'),
    historyRow('project-failed', project.slug, 'error'),
    historyRow('project-recovered', project.slug, 'error', {
      type: 'subtitles_transcribe',
      params: {
        episode_recovery_id: 'subtitle-recovery-1',
        episode_recovery: {
          id: 'subtitle-recovery-1',
          completed: ['subtitle_sections', 'subtitle_stitch'],
          first_unresolved: null,
        },
      },
    }),
  ])
  await seed(other.slug, [historyRow('other-failed', other.slug, 'error')])
  await seed('_app_', [
    historyRow('app-failed', '_app_', 'error'),
    historyRow('app-cancelled', '_app_', 'cancelled'),
  ])

  await request(app).delete(`/api/projects/${project.slug}/jobs?status=unknown`).expect(400)
  assert.ok(jq.getJob('project-failed'), 'invalid selector must not mutate history')

  const failed = await request(app)
    .delete(`/api/projects/${project.slug}/jobs?status=failed`)
    .expect(200)
  assert.deepEqual(failed.body, { ok: true, cleared: 1 })
  assert.equal(jq.getJob('project-failed'), null)
  assert.ok(jq.getJob('project-recovered'), 'verified recovery belongs to finished, not failed')
  assert.ok(jq.getJob('other-failed'), 'project selector must not cross project scope')

  const appFinished = await request(app).delete('/api/jobs/app?status=finished').expect(200)
  assert.deepEqual(appFinished.body, { ok: true, cleared: 1 })
  assert.equal(jq.getJob('app-cancelled'), null)
  assert.ok(jq.getJob('app-failed'), 'finished selector must preserve failed app history')

  const allFinished = await request(app).delete('/api/jobs/all?status=finished').expect(200)
  assert.deepEqual(allFinished.body, { ok: true, cleared: 2 })
  assert.equal(jq.getJob('project-done'), null)
  assert.equal(jq.getJob('project-recovered'), null)
  assert.ok(jq.getJob('other-failed'))

  const legacy = await request(app).delete('/api/jobs/all').expect(200)
  assert.deepEqual(legacy.body, { ok: true, cleared: 2 })
  assert.equal(jq.getJob('other-failed'), null)
  assert.equal(jq.getJob('app-failed'), null)
})
