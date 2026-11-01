/**
 * "Remove From List" used to DELETE the job record: the error details, the log
 * and Retry/Recover went with it, permanently. The owner's rule (2026-11-02) is
 * that nothing is deleted for good, so the action is now a HIDE — the record,
 * its evidence and its controls stay exactly as they were, a "Hidden" filter
 * reads them back, and Restore puts the row on the list.
 *
 * Absent `hidden_at` means visible, so every job saved before this shipped
 * loads unchanged (AGENTS.md §6: "not hidden" and "could not tell" must never
 * collapse into the same value).
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
    episode_id: 'EP-HIDE',
    title: `history ${jobId}`,
    status,
    created_at: '2026-09-09T00:00:00.000Z',
    started_at: '2026-09-09T00:00:00.000Z',
    finished_at: '2026-09-09T00:01:00.000Z',
    error: status === 'error' ? `original failure of ${jobId}` : null,
    output_lines: [`log line kept for ${jobId}`],
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

function visibleIds(body: { jobs: Array<{ job_id: string }> }): string[] {
  return body.jobs.map(job => job.job_id).sort()
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

test('the delete routes are gone: a terminal job has no DELETE any more', async () => {
  const project = await pm.createProject({ name: 'Hide: no delete' })
  await seed(project.slug, [historyRow('no-delete-done', project.slug, 'done')])

  await request(app).delete(`/api/jobs/all/no-delete-done`).expect(404)
  await request(app).delete(`/api/jobs/all`).expect(404)
  await request(app).delete(`/api/jobs/app`).expect(404)
  await request(app).delete(`/api/projects/${project.slug}/jobs/no-delete-done`).expect(404)
  await request(app).delete(`/api/projects/${project.slug}/jobs`).expect(404)

  assert.ok(jq.getJob('no-delete-done'), 'nothing deleted the record')
  const listed = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`).expect(200)
  assert.deepEqual(visibleIds(listed.body), ['no-delete-done'])
})

test('hide takes the row off the list and keeps every piece of evidence on it', async () => {
  const project = await pm.createProject({ name: 'Hide keeps evidence' })
  await seed(project.slug, [
    historyRow('keep-done', project.slug, 'done'),
    historyRow('keep-failed', project.slug, 'error'),
  ])

  const hidden = await request(app)
    .post(`/api/projects/${project.slug}/jobs/keep-failed/hide`)
    .expect(200)
  assert.equal(hidden.body.ok, true)

  const record = jq.getJob('keep-failed')
  assert.ok(record, 'the record is still there')
  assert.equal(record!.status, 'error')
  assert.equal(record!.error, 'original failure of keep-failed', 'the error detail survives')
  assert.deepEqual(record!.output_lines, ['log line kept for keep-failed'], 'the log survives')
  assert.ok(record!.hidden_at, 'the row is marked hidden')

  const listed = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`).expect(200)
  assert.deepEqual(visibleIds(listed.body), ['keep-done'], 'the hidden row is off the list')

  const hiddenRead = await request(app)
    .get(`/api/projects/${project.slug}/jobs/history?all=1&hidden=1`)
    .expect(200)
  assert.deepEqual(visibleIds(hiddenRead.body), ['keep-failed'], 'the Hidden filter reads it back')
})

test('restore brings the row back with its Retry/Recover and its error detail', async () => {
  const project = await pm.createProject({ name: 'Restore brings it back' })
  await seed(project.slug, [historyRow('restore-me', project.slug, 'error')])

  await request(app).post(`/api/projects/${project.slug}/jobs/restore-me/hide`).expect(200)
  const restored = await request(app).post(`/api/projects/${project.slug}/jobs/restore-me/unhide`).expect(200)
  assert.equal(restored.body.ok, true)

  const record = jq.getJob('restore-me')
  assert.ok(record)
  assert.equal(record!.hidden_at, undefined, 'the mark is cleared, not left as a false')
  assert.equal(record!.error, 'original failure of restore-me')

  const listed = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`).expect(200)
  assert.deepEqual(visibleIds(listed.body), ['restore-me'])
  const stillHidden = await request(app)
    .get(`/api/projects/${project.slug}/jobs/history?all=1&hidden=1`)
    .expect(200)
  assert.deepEqual(visibleIds(stillHidden.body), [], 'it is no longer a hidden row')
})

test('a hidden row is in no badge, and the Hidden count is its own honest number', async () => {
  const project = await pm.createProject({ name: 'Hidden excluded from badges' })
  await seed(project.slug, [
    historyRow('badge-done', project.slug, 'done'),
    historyRow('badge-failed', project.slug, 'error'),
    historyRow('badge-hidden-failed', project.slug, 'error'),
  ])
  await request(app).post(`/api/projects/${project.slug}/jobs/badge-hidden-failed/hide`).expect(200)

  const page = await request(app)
    .get(`/api/projects/${project.slug}/jobs/history?all=1&facets=1`)
    .expect(200)
  const facets = page.body.facets
  assert.equal(facets.stats.error, 1, 'the hidden failure is not in the header error count')
  assert.equal(facets.stats.total, 2, 'nor in the total')
  assert.equal(facets.status.error, 1, 'nor in the status chip')
  assert.equal(facets.clearable.failed, 1, 'nor in the bulk "Hide Failed" count')
  assert.equal(facets.hidden, 1, 'AGENTS §6: the hidden row is counted where it belongs, not swallowed')

  // The queue badges the layout reads agree with the history facets.
  const list = await request(app).get(`/api/projects/${project.slug}/jobs`).expect(200)
  assert.equal(list.body.stats.error, 1)
  assert.equal(list.body.stats.done, 1)
  assert.equal(list.body.stats.total, 2)
  assert.equal(jq.getQueueStats(project.slug).error, 1)
})

test('Retry is refused while hidden and no longer refused once restored', async () => {
  const project = await pm.createProject({ name: 'Retry refused while hidden' })
  await seed(project.slug, [historyRow('retry-while-hidden', project.slug, 'error')])

  await request(app).post(`/api/jobs/all/retry-while-hidden/hide`).expect(200)

  const refused = await request(app).post(`/api/jobs/all/retry-while-hidden/retry`).send({}).expect(409)
  assert.match(refused.body.detail, /Restore it first, then Retry/)
  assert.equal(jq.getJob('retry-while-hidden')!.status, 'error', 'the refused retry left the row alone')

  await request(app).post(`/api/jobs/all/retry-while-hidden/unhide`).expect(200)
  const admitted = await request(app).post(`/api/jobs/all/retry-while-hidden/retry`).send({})
  assert.notEqual(admitted.status, 409, `unexpected: ${admitted.status} ${JSON.stringify(admitted.body)}`)
  assert.ok(
    !/Restore it first/.test(admitted.body?.detail || ''),
    'once restored, the hidden-row refusal is gone',
  )
})

test('a record saved before hiding shipped loads as visible', async () => {
  const project = await pm.createProject({ name: 'Old record has no field' })
  await seed(project.slug, [historyRow('pre-hide-row', project.slug, 'error')])

  const stored = jq.getJob('pre-hide-row')
  assert.ok(stored)
  assert.equal(stored!.hidden_at, undefined, 'an old job carries no hidden_at at all')

  const listed = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`).expect(200)
  assert.deepEqual(visibleIds(listed.body), ['pre-hide-row'], 'absent hidden_at means visible')

  const facets = (await request(app)
    .get(`/api/projects/${project.slug}/jobs/history?all=1&facets=1`)
    .expect(200)).body.facets
  assert.equal(facets.hidden, 0, 'a real zero, not "unknown"')
  assert.equal(facets.stats.error, 1)
})

test('the bulk selector honors recovered and scope splits and hides instead of deleting', async () => {
  const project = await pm.createProject({ name: 'Hide selector project' })
  const other = await pm.createProject({ name: 'Hide selector other project' })
  await seed(project.slug, [
    historyRow('sel-done', project.slug, 'done'),
    historyRow('sel-failed', project.slug, 'error'),
    historyRow('sel-recovered', project.slug, 'error', {
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
  await seed(other.slug, [historyRow('sel-other-failed', other.slug, 'error')])

  await request(app).post(`/api/projects/${project.slug}/jobs/hide?status=unknown`).expect(400)
  assert.ok(jq.getJob('sel-failed'), 'an invalid selector must not mutate anything')

  const failed = await request(app)
    .post(`/api/projects/${project.slug}/jobs/hide?status=failed`)
    .expect(200)
  assert.deepEqual(failed.body, { ok: true, hidden: 1 })
  assert.equal(jq.getJob('sel-failed')!.hidden_at !== undefined, true, 'hidden, not deleted')
  assert.ok(jq.getJob('sel-recovered'), 'verified recovery belongs to finished, not failed')
  assert.ok(jq.getJob('sel-other-failed'), 'a project selector must not cross project scope')

  // The fleet selector spans every scope in the store, including rows earlier
  // tests left behind, so this asserts the rows it is about, not an exact total.
  const allFinished = await request(app).post('/api/jobs/all/hide?status=finished').expect(200)
  assert.equal(allFinished.body.ok, true)
  assert.ok(allFinished.body.hidden >= 2)
  assert.ok(jq.getJob('sel-done')!.hidden_at)
  assert.ok(jq.getJob('sel-recovered')!.hidden_at)
  assert.ok(!jq.getJob('sel-other-failed')!.hidden_at)

  // The legacy no-selector call hides what is left — still hiding, never deleting.
  const legacy = await request(app).post('/api/jobs/all/hide').expect(200)
  assert.equal(legacy.body.ok, true)
  assert.ok(legacy.body.hidden >= 1)
  assert.ok(jq.getJob('sel-other-failed')!.hidden_at)
})

test('a row already hidden is not counted a second time by a bulk hide', async () => {
  const project = await pm.createProject({ name: 'Bulk hide skips the already hidden' })
  await seed(project.slug, [
    historyRow('already-hidden', project.slug, 'error'),
    historyRow('still-visible', project.slug, 'error'),
  ])
  await request(app).post(`/api/projects/${project.slug}/jobs/already-hidden/hide`).expect(200)

  const again = await request(app)
    .post(`/api/projects/${project.slug}/jobs/hide?status=failed`)
    .expect(200)
  assert.deepEqual(again.body, { ok: true, hidden: 1 }, 'only the visible row is counted')

  const hiddenRead = await request(app)
    .get(`/api/projects/${project.slug}/jobs/history?all=1&hidden=1`)
    .expect(200)
  assert.deepEqual(visibleIds(hiddenRead.body), ['already-hidden', 'still-visible'])
})
