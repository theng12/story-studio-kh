/**
 * Clear is a REAL removal, and it is recoverable (owner, 2026-11-18).
 *
 * Hide keeps every record and only takes the row off the list. Clear must take
 * the row out of the list AND out of the project's saved job store, after
 * copying the full row into `cleared-jobs.json`, so Restore can put the same
 * row back. Nothing is ever deleted from disk.
 *
 * Five properties are pinned here:
 *   1. a terminal, settled row is gone from memory, jobs.json and the history
 *      read, and an entry with the measured record bytes exists in the store;
 *   2. a running/queued row (and unsettled provider evidence) is refused with
 *      a plain sentence and nothing moves;
 *   3. Restore brings back the exact job_id and evidence;
 *   4. Restore never overwrites a row a retry re-created;
 *   5. the preview count and bytes are the number the bulk clear removes;
 *   6. Hide still behaves exactly as before.
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
let clearedEvents: Array<{ project_slug: string; job_ids: string[] }> = []

function historyRow(
  jobId: string,
  projectSlug: string,
  status: string,
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

async function readJson(file: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')) } catch { return null }
}

function clearedPath(scope: string): string {
  return path.join(tempDir, 'projects', scope, 'cleared-jobs.json')
}

function jobsPath(scope: string): string {
  return path.join(tempDir, 'projects', scope, 'jobs.json')
}

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  jq.jobEvents.on('cleared', event => clearedEvents.push(event))
  const { router } = await import('../routes/jobs.js')
  app = express().use(express.json()).use('/api', router)
})

after(async () => {
  await jq._waitForJobPersistenceForTesting().catch(() => {})
  await cleanup()
})

test('a cleared terminal row leaves memory, jobs.json and history; the full row is kept', async () => {
  const project = await pm.createProject({ name: 'Clear a finished row' })
  await seed(project.slug, [historyRow('clear-done', project.slug, 'done')])
  clearedEvents = []

  const preview = await request(app).get('/api/jobs/clear-preview?status=finished').expect(200)
  const previewRow = preview.body.ids.includes('clear-done')
  assert.equal(previewRow, true, 'the row is in the finished preview')
  assert.ok(preview.body.bytes > 0, 'the preview measures the record bytes, not an estimate')

  const cleared = await request(app).post('/api/jobs/all/clear-done/clear').expect(200)
  assert.equal(cleared.body.ok, true)
  assert.equal(cleared.body.cleared.job_id, 'clear-done')
  assert.equal(cleared.body.cleared.record_bytes > 0, true)
  assert.equal(cleared.body.cleared.project_slug, project.slug)

  await jq._waitForJobPersistenceForTesting()
  assert.equal(jq.getJob('clear-done'), null, 'memory no longer holds the row')
  const stored = await readJson(jobsPath(project.slug))
  assert.deepEqual((stored?.jobs || []).map((row: any) => row.job_id), [], 'jobs.json no longer returns it')
  const listed = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`).expect(200)
  assert.deepEqual(listed.body.jobs.map((row: any) => row.job_id), [], 'the history read no longer returns it')
  assert.ok(clearedEvents.some(event => event.project_slug === project.slug && event.job_ids.includes('clear-done')),
    'the list is told the row cleared')

  const archive = await readJson(clearedPath(project.slug))
  assert.equal(archive?.cleared?.length, 1, 'the row is kept in cleared-jobs.json')
  assert.equal(archive.cleared[0].job.genstudio_jobs[0].state, 'succeeded', 'its provider evidence is kept')
  assert.deepEqual(archive.cleared[0].job.output_lines, ['log line kept for clear-done'], 'its log is kept')
  assert.equal(archive.cleared[0].record_bytes, cleared.body.cleared.record_bytes, 'the stored size is the measured size')

  const recently = await request(app).get('/api/jobs/cleared').expect(200)
  const entry = recently.body.items.find((item: any) => item.job_id === 'clear-done')
  assert.ok(entry, 'Recently cleared lists it')
  assert.equal(entry.record_bytes, archive.cleared[0].record_bytes)
})

test('a running row is refused with a plain sentence and nothing moves', async () => {
  const project = await pm.createProject({ name: 'Clear refuses running' })
  await seed(project.slug, [historyRow('clear-running', project.slug, 'done')])
  // Put the in-memory row into a lane state no fixture can reach otherwise.
  assert.equal(jq._setJobRecordForTesting('clear-running', { status: 'running', finished_at: null }), true)

  const refused = await request(app).post('/api/jobs/all/clear-running/clear').expect(409)
  assert.match(refused.body.detail, /Only finished jobs can be cleared/)
  assert.ok(jq.getJob('clear-running'), 'the running row is still there')
  assert.equal(await readJson(clearedPath(project.slug)), null, 'nothing was archived')
})

test('unsettled provider evidence is refused with a plain sentence', async () => {
  const project = await pm.createProject({ name: 'Clear refuses unsettled' })
  await seed(project.slug, [
    historyRow('clear-settling', project.slug, 'cancelled', {
      genstudio_jobs: [{
        id: 'clear-settling-provider',
        operation: 'image.generation',
        state: 'reserved',
        updated_at: '2026-09-09T00:01:00.000Z',
      }],
    }),
  ])

  const refused = await request(app).post('/api/jobs/all/clear-settling/clear').expect(409)
  assert.match(refused.body.detail, /still waiting for the Gateway to settle/)
  assert.ok(jq.getJob('clear-settling'), 'the row is still there')
  assert.equal(await readJson(clearedPath(project.slug)), null, 'nothing was archived')
})

test('Restore brings back the same job_id with its evidence intact', async () => {
  const project = await pm.createProject({ name: 'Clear and restore' })
  await seed(project.slug, [historyRow('clear-restore', project.slug, 'error')])

  const cleared = await request(app).post('/api/jobs/all/clear-restore/clear').expect(200)
  const clearedId = cleared.body.cleared.id
  assert.equal(jq.getJob('clear-restore'), null)

  const restored = await request(app).post(`/api/jobs/cleared/${clearedId}/restore`).expect(200)
  assert.equal(restored.body.ok, true)
  assert.equal(restored.body.already_present, false)
  assert.equal(restored.body.job.job_id, 'clear-restore')
  assert.equal(restored.body.job.status, 'error')
  assert.equal(restored.body.job.error, 'original failure of clear-restore', 'the error detail came back')
  assert.equal(restored.body.job.genstudio_jobs[0].state, 'failed', 'the provider evidence came back')

  await jq._waitForJobPersistenceForTesting()
  const stored = await readJson(jobsPath(project.slug))
  assert.deepEqual((stored?.jobs || []).map((row: any) => row.job_id), ['clear-restore'], 'it is durable again')
  const archive = await readJson(clearedPath(project.slug))
  assert.deepEqual(archive?.cleared || [], [], 'the cleared entry is gone')
  const listed = await request(app).get(`/api/projects/${project.slug}/jobs/history?all=1`).expect(200)
  assert.deepEqual(listed.body.jobs.map((row: any) => row.job_id), ['clear-restore'], 'it is on the list again')
})

test('Restore never overwrites a row a retry already re-created', async () => {
  const project = await pm.createProject({ name: 'Clear then re-created' })
  await seed(project.slug, [historyRow('clear-recreated', project.slug, 'done')])
  const cleared = await request(app).post('/api/jobs/all/clear-recreated/clear').expect(200)
  const clearedId = cleared.body.cleared.id

  // A retry re-created the row on disk while the cleared entry still existed.
  await fs.writeFile(jobsPath(project.slug), JSON.stringify({ jobs: [
    historyRow('clear-recreated', project.slug, 'error', {
      error: 'the retry version',
      genstudio_jobs: [{
        id: 'clear-recreated-provider',
        operation: 'image.generation',
        state: 'failed',
        updated_at: '2026-09-10T00:01:00.000Z',
      }],
    }),
  ] }))
  jq._restartProjectForTesting(project.slug)
  await jq.getJobs(project.slug)

  const restored = await request(app).post(`/api/jobs/cleared/${clearedId}/restore`).expect(200)
  assert.equal(restored.body.already_present, true)
  assert.equal(restored.body.job.error, 'the retry version', 'the live row was not overwritten')
  assert.equal(jq.getJob('clear-recreated')!.error, 'the retry version')
  assert.deepEqual((await readJson(clearedPath(project.slug)))?.cleared || [], [], 'the cleared entry is retired')
})

test('the preview count and bytes are what the bulk clear removes', async () => {
  const project = await pm.createProject({ name: 'Clear bulk agreement' })
  await seed(project.slug, [
    historyRow('bulk-done', project.slug, 'done'),
    historyRow('bulk-cancelled', project.slug, 'cancelled'),
    historyRow('bulk-failed', project.slug, 'error'),
    historyRow('bulk-still-settling', project.slug, 'cancelled', {
      genstudio_jobs: [{
        id: 'bulk-still-settling-provider',
        operation: 'image.generation',
        state: 'reserved',
        updated_at: '2026-09-09T00:01:00.000Z',
      }],
    }),
  ])

  const preview = await request(app).get('/api/jobs/clear-preview?status=finished').expect(200)
  assert.ok(preview.body.ids.includes('bulk-done'))
  assert.ok(preview.body.ids.includes('bulk-cancelled'))
  assert.ok(!preview.body.ids.includes('bulk-failed'), 'the failed row belongs to the failed subset')
  assert.ok(!preview.body.ids.includes('bulk-still-settling'), 'unsettled evidence is in neither subset')

  const mismatch = await request(app).post('/api/jobs/all/clear').send({
    status: 'finished',
    expected_count: preview.body.count + 1,
    expected_bytes: preview.body.bytes,
  }).expect(409)
  assert.match(mismatch.body.detail, /Nothing was cleared/)
  assert.ok(jq.getJob('bulk-done'), 'a mismatch moved nothing')

  const cleared = await request(app).post('/api/jobs/all/clear').send({
    status: 'finished',
    expected_count: preview.body.count,
    expected_bytes: preview.body.bytes,
  }).expect(200)
  assert.equal(cleared.body.cleared, preview.body.count, 'the number cleared is the number promised')
  assert.equal(cleared.body.bytes, preview.body.bytes, 'the bytes cleared are the bytes promised')

  await jq._waitForJobPersistenceForTesting()
  assert.equal(jq.getJob('bulk-done'), null)
  assert.equal(jq.getJob('bulk-cancelled'), null)
  assert.ok(jq.getJob('bulk-failed'), 'the failed subset is untouched')
  assert.ok(jq.getJob('bulk-still-settling'), 'the unsettled row is untouched')

  const failedPreview = await request(app).get('/api/jobs/clear-preview?status=failed').expect(200)
  assert.ok(failedPreview.body.ids.includes('bulk-failed'))
  assert.ok(!failedPreview.body.ids.includes('bulk-still-settling'))
})

test('a channel-scoped clear never touches another channel', async () => {
  const projectA = await pm.createProject({ name: 'Clear scope A' })
  const projectB = await pm.createProject({ name: 'Clear scope B' })
  await seed(projectA.slug, [historyRow('scope-a-done', projectA.slug, 'done')])
  await seed(projectB.slug, [historyRow('scope-b-done', projectB.slug, 'done')])

  const fleet = await request(app).get('/api/jobs/clear-preview?status=finished').expect(200)
  assert.ok(fleet.body.ids.includes('scope-a-done'))
  assert.ok(fleet.body.ids.includes('scope-b-done'), 'absent a project the preview is the fleet')

  const scoped = await request(app)
    .get(`/api/jobs/clear-preview?status=finished&project=${projectA.slug}`)
    .expect(200)
  assert.deepEqual(scoped.body.ids, ['scope-a-done'], 'only channel A is offered')
  assert.equal(scoped.body.count, 1)

  await request(app).get('/api/jobs/clear-preview?status=finished&project=no-such-channel').expect(404)

  const cleared = await request(app).post('/api/jobs/all/clear').send({
    status: 'finished',
    project: projectA.slug,
    expected_count: scoped.body.count,
    expected_bytes: scoped.body.bytes,
  }).expect(200)
  assert.equal(cleared.body.cleared, 1)
  await jq._waitForJobPersistenceForTesting()

  assert.equal(jq.getJob('scope-a-done'), null, 'channel A cleared its row')
  assert.ok(jq.getJob('scope-b-done'), 'channel B kept its matching row')
  const storedB = await readJson(jobsPath(projectB.slug))
  assert.deepEqual((storedB?.jobs || []).map((row: any) => row.job_id), ['scope-b-done'])
  assert.deepEqual((await readJson(clearedPath(projectB.slug)))?.cleared || [], [], 'channel B archived nothing')

  const recentlyA = await request(app).get(`/api/jobs/cleared?project=${projectA.slug}`).expect(200)
  assert.deepEqual(recentlyA.body.items.map((item: any) => item.job_id), ['scope-a-done'])
  await request(app).get('/api/jobs/cleared?project=no-such-channel').expect(404)

  // The refused numbers are re-measured inside the requested scope.
  const mismatch = await request(app).post('/api/jobs/all/clear').send({
    status: 'finished',
    project: projectB.slug,
    expected_count: scoped.body.count + 1,
    expected_bytes: scoped.body.bytes,
  }).expect(409)
  assert.match(mismatch.body.detail, /Nothing was cleared/)
  assert.ok(jq.getJob('scope-b-done'), 'the refused clear left channel B alone')
})

test('Hide still only hides: the record stays, nothing is archived', async () => {
  const project = await pm.createProject({ name: 'Hide unchanged' })
  await seed(project.slug, [historyRow('hide-still-hide', project.slug, 'error')])

  await request(app).post('/api/jobs/all/hide-still-hide/hide').expect(200)
  const record = jq.getJob('hide-still-hide')
  assert.ok(record, 'the record is still there')
  assert.ok(record!.hidden_at, 'it is marked hidden')
  assert.equal(record!.error, 'original failure of hide-still-hide', 'its evidence is untouched')
  assert.equal(await readJson(clearedPath(project.slug)), null, 'Hide never writes the cleared store')
  const recently = await request(app).get('/api/jobs/cleared').expect(200)
  assert.equal(recently.body.items.some((item: any) => item.job_id === 'hide-still-hide'), false)
})
