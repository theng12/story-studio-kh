import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import type { Job, JobType } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let app: express.Express
let sequence = 0

function pausedJob(
  projectSlug: string,
  type: JobType,
  pauseOrigin: Job['pause_origin'] = 'manual',
  overrides: Partial<Job> = {},
): Job {
  sequence += 1
  return {
    job_id: `bulk-${sequence}`,
    project_slug: projectSlug,
    type,
    episode_id: `EP-${sequence}`,
    title: `bulk fixture ${sequence}`,
    status: 'paused',
    pause_origin: pauseOrigin,
    pause_requested: false,
    created_at: '2026-08-31T00:00:00.000Z',
    started_at: '2026-08-31T00:01:00.000Z',
    finished_at: null,
    error: 'held',
    output_lines: ['existing evidence line'],
    params: {},
    ...overrides,
  }
}

async function seedJobs(projectSlug: string, records: Job[]): Promise<void> {
  const projectDir = path.join(tempDir, 'projects', projectSlug)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'jobs.json'), `${JSON.stringify({ jobs: records }, null, 2)}\n`)
  await jq.getJobs(projectSlug)
}

function aggregateOnly(body: object): void {
  assert.deepEqual(Object.keys(body).sort(), ['requested', 'resumed', 'skipped', 'skipped_reasons'].sort())
  assert.doesNotMatch(JSON.stringify(body), /bulk-\d+/)
}

function waitForStatus(jobId: string, status: Job['status']): Promise<void> {
  if (jq.getJob(jobId)?.status === status) return Promise.resolve()
  return new Promise(resolve => {
    const onUpdate = (job: Job) => {
      if (job.job_id !== jobId || job.status !== status) return
      jq.jobEvents.off('update', onUpdate)
      resolve()
    }
    jq.jobEvents.on('update', onUpdate)
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  const { router } = await import('../routes/jobs.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)

  jq.registerExecutor('script-only', async () => {})
  jq.registerExecutor('audio', async () => {})
  await jq.setQueuePaused(true)
})

after(async () => { await cleanup() })

describe('scoped bulk paused-job Resume routes', () => {
  test('project route validates exact input before mutation and cannot cross its slug', async () => {
    const project = await pm.createProject({ name: 'Bulk Project Scope A' })
    const other = await pm.createProject({ name: 'Bulk Project Scope B' })
    const target = pausedJob(project.slug, 'script-only', 'manual')
    const outside = pausedJob(other.slug, 'script-only', 'stall')
    await seedJobs(project.slug, [target])
    await seedJobs(other.slug, [outside])

    await request(app)
      .post(`/api/projects/${project.slug}/jobs/resume-paused`)
      .send({ type: 'not-a-job-type' })
      .expect(400)
    await request(app)
      .post(`/api/projects/${project.slug}/jobs/resume-paused`)
      .send({ job_ids: [outside.job_id] })
      .expect(400)
    await request(app)
      .post('/api/projects/unknown-project/jobs/resume-paused')
      .send({})
      .expect(404)
    assert.equal(jq.getJob(target.job_id)?.status, 'paused')
    assert.equal(jq.getJob(outside.job_id)?.status, 'paused')

    const response = await request(app)
      .post(`/api/projects/${project.slug}/jobs/resume-paused`)
      .send({ type: 'script-only' })
      .expect(202)
    assert.deepEqual(response.body, { requested: 1, resumed: 1, skipped: 0 })
    assert.equal(jq.getJob(target.job_id)?.status, 'queued')
    assert.equal(jq.getJob(outside.job_id)?.status, 'paused')

    await request(app)
      .post(`/api/projects/${other.slug}/jobs/resume-paused`)
      .send({})
      .expect(202)
  })

  test('universal route supports concrete, _app_, type, and all-project server-owned scopes', async () => {
    const first = await pm.createProject({ name: 'Bulk Universal A' })
    const second = await pm.createProject({ name: 'Bulk Universal B' })
    const firstScript = pausedJob(first.slug, 'script-only', 'manual')
    const firstAudio = pausedJob(first.slug, 'audio', 'queue')
    const secondScript = pausedJob(second.slug, 'script-only', 'manual', { pause_origin: undefined })
    const appJob = pausedJob('_app_', 'audio', 'stall')
    await seedJobs(first.slug, [firstScript, firstAudio])
    await seedJobs(second.slug, [secondScript])
    await seedJobs('_app_', [appJob])

    await request(app)
      .post('/api/jobs/all/resume-paused')
      .send({ project_slug: 'missing-project' })
      .expect(404)
    await request(app)
      .post('/api/jobs/all/resume-paused')
      .send({ project_slug: 7 })
      .expect(400)
    await request(app)
      .post('/api/jobs/all/resume-paused')
      .send({ type: ['audio'] })
      .expect(400)
    assert.equal(jq.getJob(firstAudio.job_id)?.status, 'paused')

    const concrete = await request(app)
      .post('/api/jobs/all/resume-paused')
      .send({ project_slug: first.slug, type: 'audio' })
      .expect(202)
    assert.deepEqual(concrete.body, { requested: 1, resumed: 1, skipped: 0 })
    assert.equal(jq.getJob(firstScript.job_id)?.status, 'paused')
    assert.equal(jq.getJob(firstAudio.job_id)?.status, 'queued')

    const appScoped = await request(app)
      .post('/api/jobs/all/resume-paused')
      .send({ project_slug: '_app_' })
      .expect(202)
    assert.deepEqual(appScoped.body, { requested: 1, resumed: 1, skipped: 0 })
    assert.equal(jq.getJob(appJob.job_id)?.status, 'queued')

    const allProjects = await request(app)
      .post('/api/jobs/all/resume-paused')
      .send({})
      .expect(202)
    assert.deepEqual(allProjects.body, { requested: 2, resumed: 2, skipped: 0 })
    assert.equal(jq.getJob(firstScript.job_id)?.status, 'queued')
    assert.equal(jq.getJob(secondScript.job_id)?.status, 'queued')
  })
})

describe('queue-level scoped paused-job Resume', () => {
  test('preserves identity/evidence, batches writes and pumps, rolls back one failed project, and redacts aggregates', async (t) => {
    const successful = await pm.createProject({ name: 'Bulk Atomic Success' })
    const failed = await pm.createProject({ name: 'Bulk Atomic Failure' })
    const noExecutor = await pm.createProject({ name: 'Bulk No Executor' })
    const identity = pausedJob(successful.slug, 'script-only', 'manual', {
      params: { output_path: '/isolated/output', task_manifest: { scene: 'scene-07', task_id: 'provider-task-7' } },
      output_dir: '/isolated/output',
      content_pack_provenance: [{
        pack_id: 'pack.example',
        version: '1.0.0',
        archive_sha256: 'abc',
        item_ids: ['style.example'],
      }],
      genstudio_jobs: [{
        id: 'provider-task-7',
        operation: 'image.generation',
        state: 'succeeded',
        settled_credits: 4,
        updated_at: '2026-08-31T00:02:00.000Z',
      }],
    })
    const sameLane = pausedJob(successful.slug, 'script-only', 'queue')
    const otherLane = pausedJob(successful.slug, 'audio', 'stall')
    const terminal = pausedJob(successful.slug, 'script-only', 'manual', { status: 'done' })
    const alreadyQueued = pausedJob(successful.slug, 'audio', 'manual', { status: 'queued', pause_origin: undefined })
    const failedA = pausedJob(failed.slug, 'script-only', 'manual')
    const failedB = pausedJob(failed.slug, 'audio', 'stall')
    const missingExecutor = pausedJob(noExecutor.slug, 'music_video', 'manual')
    const retiredType = pausedJob(noExecutor.slug, 'retired_job_type' as JobType, 'manual')
    await seedJobs(successful.slug, [identity, sameLane, otherLane, terminal, alreadyQueued])
    await seedJobs(failed.slug, [failedA, failedB])
    await seedJobs(noExecutor.slug, [missingExecutor, retiredType])

    const identityBefore = jq.getJob(identity.job_id)!
    const preservedBefore = structuredClone({
      job_id: identityBefore.job_id,
      params: identityBefore.params,
      output_dir: identityBefore.output_dir,
      content_pack_provenance: identityBefore.content_pack_provenance,
      genstudio_jobs: identityBefore.genstudio_jobs,
    })
    const successfulPath = path.join(tempDir, 'projects', successful.slug, 'jobs.json')
    const failedPath = path.join(tempDir, 'projects', failed.slug, 'jobs.json')
    const writes = new Map<string, number>()
    const originalRename = fs.rename.bind(fs)
    t.mock.method(console, 'warn', () => {})
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      const target = path.resolve(String(to))
      if (target === path.resolve(successfulPath) || target === path.resolve(failedPath)) {
        writes.set(target, (writes.get(target) || 0) + 1)
      }
      if (target === path.resolve(failedPath)) throw new Error('forced project snapshot failure')
      return originalRename(from, to)
    })
    const pumps: JobType[] = []
    const stopObservingPumps = jq._observeQueuePumpsForTesting(type => pumps.push(type))
    t.after(stopObservingPumps)
    const updates: string[] = []
    const onUpdate = (job: Job) => updates.push(job.job_id)
    jq.jobEvents.on('update', onUpdate)
    t.after(() => jq.jobEvents.off('update', onUpdate))

    const result = await jq.resumePausedJobs({
      projectSlugs: [successful.slug, failed.slug, noExecutor.slug],
    })

    assert.deepEqual(result, {
      requested: 7,
      resumed: 3,
      skipped: 4,
      skipped_reasons: [
        { reason: 'no-executor', count: 2 },
        { reason: 'persistence-failed', count: 2 },
      ],
    })
    aggregateOnly(result)
    assert.equal(writes.get(path.resolve(successfulPath)), 1)
    assert.equal(writes.get(path.resolve(failedPath)), 1)
    assert.deepEqual(pumps.sort(), ['audio', 'script-only'])

    assert.equal(jq.getJob(identity.job_id)?.status, 'queued')
    assert.equal(jq.getJob(sameLane.job_id)?.status, 'queued')
    assert.equal(jq.getJob(otherLane.job_id)?.status, 'queued')
    assert.equal(jq.getJob(terminal.job_id)?.status, 'done')
    assert.equal(jq.getJob(alreadyQueued.job_id)?.status, 'queued')
    assert.equal(jq.getJob(failedA.job_id)?.status, 'paused')
    assert.equal(jq.getJob(failedB.job_id)?.status, 'paused')
    assert.equal(jq.getJob(missingExecutor.job_id)?.status, 'paused')
    assert.equal(jq.getJob(retiredType.job_id)?.status, 'paused')
    assert.deepEqual(updates.sort(), [identity.job_id, sameLane.job_id, otherLane.job_id].sort())

    const identityAfter = jq.getJob(identity.job_id)!
    assert.deepEqual({
      job_id: identityAfter.job_id,
      params: identityAfter.params,
      output_dir: identityAfter.output_dir,
      content_pack_provenance: identityAfter.content_pack_provenance,
      genstudio_jobs: identityAfter.genstudio_jobs,
    }, preservedBefore)

    const persistedFailure = JSON.parse(await fs.readFile(failedPath, 'utf8')) as { jobs: Job[] }
    assert.deepEqual(
      persistedFailure.jobs.filter(job => [failedA.job_id, failedB.job_id].includes(job.job_id)).map(job => [job.job_id, job.status, job.pause_origin]),
      [[failedA.job_id, 'paused', 'manual'], [failedB.job_id, 'paused', 'stall']],
    )
  })

  test('exact type selection ignores a running lane owner and concurrent invocation executes the resumed record once', async (t) => {
    await jq.setQueuePaused(false)
    const project = await pm.createProject({ name: 'Bulk Double Invocation' })
    const selected = pausedJob(project.slug, 'broll_assemble', 'manual')
    const otherType = pausedJob(project.slug, 'audio', 'manual')
    await seedJobs(project.slug, [selected, otherType])
    let releaseBlocker!: () => void
    const blocker = new Promise<void>(resolve => { releaseBlocker = resolve })
    let blockerStarted!: () => void
    const started = new Promise<void>(resolve => { blockerStarted = resolve })
    const executions: string[] = []
    jq.registerExecutor('broll_assemble', async job => {
      executions.push(job.job_id)
      if (job.episode_id === 'BLOCK') {
        blockerStarted()
        await blocker
      }
    })
    const running = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'broll_assemble',
      episode_id: 'BLOCK',
      title: 'occupy exact lane',
      params: {},
    })
    await started
    const projectPath = path.resolve(path.join(tempDir, 'projects', project.slug, 'jobs.json'))
    let writes = 0
    const originalRename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === projectPath) writes += 1
      return originalRename(from, to)
    })
    const pumps: JobType[] = []
    const stopObservingPumps = jq._observeQueuePumpsForTesting(type => {
      if (type === 'broll_assemble') pumps.push(type)
    })
    t.after(stopObservingPumps)

    const results = await Promise.all([
      jq.resumePausedJobs({ projectSlugs: [project.slug], type: 'broll_assemble' }),
      jq.resumePausedJobs({ projectSlugs: [project.slug], type: 'broll_assemble' }),
    ])

    assert.equal(results.reduce((total, result) => total + result.requested, 0), 1)
    assert.equal(results.reduce((total, result) => total + result.resumed, 0), 1)
    assert.equal(writes, 1)
    assert.deepEqual(pumps, ['broll_assemble'])
    assert.equal(jq.getJob(selected.job_id)?.status, 'queued')
    assert.equal(jq.getJob(otherType.job_id)?.status, 'paused')
    assert.equal(jq.getJob(running.job_id)?.status, 'running')

    const selectedDone = waitForStatus(selected.job_id, 'done')
    releaseBlocker()
    await selectedDone
    assert.deepEqual(executions, [running.job_id, selected.job_id])
    await jq.setQueuePaused(true)
  })
})

describe('bulk Resume concurrency ownership', () => {
  test('overlapping all-project and project scopes transition one row once', async (t) => {
    await jq.setQueuePaused(false)
    const firstProject = await pm.createProject({ name: 'Bulk Overlap First' })
    const overlappingProject = await pm.createProject({ name: 'Bulk Overlap Second' })
    const firstJob = pausedJob(firstProject.slug, 'audio', 'manual')
    const overlappingJob = pausedJob(overlappingProject.slug, 'broll_assemble', 'manual')
    await seedJobs(firstProject.slug, [firstJob])
    await seedJobs(overlappingProject.slug, [overlappingJob])

    const releaseExecutor = deferred()
    const executorStarted = deferred()
    const executions: string[] = []
    jq.registerExecutor('broll_assemble', async job => {
      executions.push(job.job_id)
      if (job.job_id === overlappingJob.job_id && executions.filter(id => id === job.job_id).length === 1) {
        executorStarted.resolve()
        await releaseExecutor.promise
      }
    })

    const firstPath = path.resolve(path.join(tempDir, 'projects', firstProject.slug, 'jobs.json'))
    const overlappingPath = path.resolve(path.join(tempDir, 'projects', overlappingProject.slug, 'jobs.json'))
    const firstWriteStarted = deferred()
    const releaseFirstWrite = deferred()
    let blockedFirstWrite = false
    let overlappingResumeWrites = 0
    const originalRename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      const target = path.resolve(String(to))
      if (target === firstPath && !blockedFirstWrite) {
        blockedFirstWrite = true
        firstWriteStarted.resolve()
        await releaseFirstWrite.promise
      }
      if (target === overlappingPath) {
        const persisted = JSON.parse(await fs.readFile(String(from), 'utf8')) as { jobs?: Job[] }
        const row = persisted.jobs?.find(job => job.job_id === overlappingJob.job_id)
        if (row?.status === 'queued' && row.output_lines.filter(line => line.startsWith('Resume requested')).length) {
          overlappingResumeWrites += 1
        }
      }
      return originalRename(from, to)
    })

    const pumps: JobType[] = []
    const stopObservingPumps = jq._observeQueuePumpsForTesting(type => {
      if (type === 'broll_assemble') pumps.push(type)
    })
    t.after(stopObservingPumps)
    const queuedUpdates: string[] = []
    const onUpdate = (job: Job) => {
      if (job.job_id === overlappingJob.job_id && job.status === 'queued') queuedUpdates.push(job.job_id)
    }
    jq.jobEvents.on('update', onUpdate)
    t.after(() => jq.jobEvents.off('update', onUpdate))

    const allProjectsResume = jq.resumePausedJobs({
      projectSlugs: [firstProject.slug, overlappingProject.slug],
    })
    await firstWriteStarted.promise
    const overlappingResume = await jq.resumePausedJobs({ projectSlugs: [overlappingProject.slug] })
    releaseFirstWrite.resolve()
    const firstResult = await allProjectsResume
    await executorStarted.promise

    assert.deepEqual(overlappingResume, { requested: 0, resumed: 0, skipped: 0 })
    assert.deepEqual(firstResult, { requested: 2, resumed: 2, skipped: 0 })
    assert.equal(overlappingResumeWrites, 1)
    assert.equal(jq.getJob(overlappingJob.job_id)?.output_lines.filter(line => line.startsWith('Resume requested')).length, 1)
    assert.deepEqual(queuedUpdates, [overlappingJob.job_id])
    assert.deepEqual(pumps, ['broll_assemble'])

    const marker = jq.enqueuePreparedForTest({
      project_slug: overlappingProject.slug,
      type: 'broll_assemble',
      episode_id: 'OVERLAP-MARKER',
      title: 'overlap drain marker',
      params: {},
    })
    const markerDone = waitForStatus(marker.job_id, 'done')
    releaseExecutor.resolve()
    await markerDone
    assert.equal(executions.filter(id => id === overlappingJob.job_id).length, 1)
    await jq.setQueuePaused(true)
  })

  async function assertFailedWritePreservesLaterIntent(
    t: any,
    intent: 'manual-pause' | 'cancel',
  ): Promise<void> {
    await jq.setQueuePaused(true)
    const project = await pm.createProject({ name: `Bulk Failed Write ${intent}` })
    const type: JobType = intent === 'manual-pause' ? 'broll_assemble' : 'youtube_playlist_update'
    jq.registerExecutor(type, async () => {})
    const selected = pausedJob(project.slug, type, 'stall')
    await seedJobs(project.slug, [selected])
    const projectPath = path.resolve(path.join(tempDir, 'projects', project.slug, 'jobs.json'))
    const writeStarted = deferred()
    const releaseFailedWrite = deferred()
    let failedBulkWrite = false
    const originalRename = fs.rename.bind(fs)
    t.mock.method(console, 'warn', () => {})
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === projectPath && !failedBulkWrite) {
        failedBulkWrite = true
        writeStarted.resolve()
        await releaseFailedWrite.promise
        throw new Error('forced bulk snapshot failure')
      }
      return originalRename(from, to)
    })

    const bulkResume = jq.resumePausedJobs({ projectSlugs: [project.slug] })
    await writeStarted.promise
    const laterIntent = intent === 'manual-pause'
      ? jq.pauseJob(selected.job_id, 'manual')
      : jq.requestJobCancellation(project.slug, selected.job_id)
    for (let turn = 0; turn < 10 && jq.getJob(selected.job_id)?.status === 'queued'; turn += 1) {
      await Promise.resolve()
    }
    assert.equal(jq.getJob(selected.job_id)?.status, intent === 'manual-pause' ? 'paused' : 'cancelled')
    releaseFailedWrite.resolve()
    const [result, controlled] = await Promise.all([bulkResume, laterIntent])

    assert.deepEqual(result, {
      requested: 1,
      resumed: 0,
      skipped: 1,
      skipped_reasons: [{ reason: 'persistence-failed', count: 1 }],
    })
    assert.equal(controlled?.status, intent === 'manual-pause' ? 'paused' : 'cancelled')
    assert.equal(jq.getJob(selected.job_id)?.status, intent === 'manual-pause' ? 'paused' : 'cancelled')
    if (intent === 'manual-pause') {
      assert.equal(jq.getJob(selected.job_id)?.pause_origin, 'manual')
      assert.match(jq.getJob(selected.job_id)?.output_lines.at(-1) || '', /Paused before submission/)
    }
    const persisted = JSON.parse(await fs.readFile(projectPath, 'utf8')) as { jobs: Job[] }
    const durable = persisted.jobs.find(job => job.job_id === selected.job_id)
    assert.equal(durable?.status, intent === 'manual-pause' ? 'paused' : 'cancelled')
    if (intent === 'manual-pause') assert.equal(durable?.pause_origin, 'manual')
  }

  test('failed bulk persistence preserves a later manual pause in memory and on disk', async (t) => {
    await assertFailedWritePreservesLaterIntent(t, 'manual-pause')
  })

  test('failed bulk persistence preserves a later cancellation in memory and on disk', async (t) => {
    await assertFailedWritePreservesLaterIntent(t, 'cancel')
  })
})
