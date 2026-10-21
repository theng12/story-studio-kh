import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { type RetainedTempDataDir, useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import type { Job } from '../models/types.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let registerRetained: RetainedTempDataDir['register']
const fixtureJobs = new Map<string, string>()

function trackFixtureJob<T extends Job>(job: T): T {
  fixtureJobs.set(job.job_id, job.project_slug)
  return job
}

async function cancelFixtureJob(jobId: string, projectSlug: string): Promise<void> {
  const job = jq.getJob(jobId)
  if (!job || !['queued', 'running', 'paused'].includes(job.status)) return
  try {
    await jq.requestJobCancellation(projectSlug, jobId)
  } catch (error) {
    const latest = jq.getJob(jobId)
    if (latest && ['queued', 'running', 'paused'].includes(latest.status)) throw error
  }
}

async function settleFixtureWork(): Promise<void> {
  for (const [jobId, projectSlug] of fixtureJobs) {
    await cancelFixtureJob(jobId, projectSlug)
  }
  await waitFor(
    () => [...fixtureJobs].every(([jobId]) => !jq._isJobWorkerActiveForTesting(jobId)),
    { label: 'Video Assembly fixture workers to finish' },
  )
  await jq._waitForJobPersistenceForTesting()
}

before(async () => {
  const temp = await useTempDataDir({
    retain: true,
    settle: settleFixtureWork,
  })
  tempDir = temp.dir
  cleanup = temp.cleanup
  registerRetained = temp.register
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => {
  await cleanup()
})

async function fixtureJob(
  projectSlug: string,
  jobId: string,
  status: Job['status'],
  options: { pauseRequested?: boolean; escapePath?: boolean; malformed?: boolean } = {},
): Promise<Job> {
  const episode = jobId.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16)
  const workDir = await getWorkTempDir(projectSlug, episode)
  await registerRetained(workDir, 'work-dir')
  const checkpoint = options.malformed ? { version: 9 } : {
    version: 1,
    job_id: jobId,
    project_slug: projectSlug,
    episode_id: episode,
    work_dir: options.escapePath ? path.dirname(workDir) : workDir,
    render_fingerprint: 'd'.repeat(64),
    completed_scene_clips: [],
  }
  return trackFixtureJob({
    job_id: jobId,
    project_slug: projectSlug,
    type: 'video_assembly',
    episode_id: episode,
    title: 'Interrupted Video Assembly',
    status,
    ...(options.pauseRequested ? { pause_requested: true } : {}),
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    result: { video_assembly_checkpoint: checkpoint },
  })
}

async function persist(projectSlug: string, rows: Job[]): Promise<string> {
  const file = path.join(tempDir, 'projects', projectSlug, 'jobs.json')
  await fs.writeFile(file, JSON.stringify({ jobs: rows }))
  return file
}

describe('persisted Video Assembly restart recovery', () => {
  test('requeues the original durable job id only for a valid running checkpoint', async () => {
    const project = await pm.createProject({ name: 'Video Assembly Valid Resume' })
    const saved = await fixtureJob(project.slug, 'video-resume-same-id', 'running')
    const jobsFile = await persist(project.slug, [saved])
    const executed: string[] = []
    jq.registerExecutor('video_assembly', async job => { executed.push(job.job_id) })

    await jq.getJobs(project.slug)
    await waitFor(() => jq.getJob(saved.job_id)?.status === 'done', {
      label: 'the checkpointed Video Assembly job to finish after boot requeue',
    })

    assert.deepEqual(executed, [saved.job_id])
    assert.equal(jq.getJob(saved.job_id)?.status, 'done')
    await jq._waitForJobPersistenceForTesting()
    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
    assert.equal(durable.jobs.find((row: Job) => row.job_id === saved.job_id)?.status, 'done')
  })

  test('pause intent wins over a valid checkpoint and never auto-requeues', async () => {
    const project = await pm.createProject({ name: 'Video Assembly Paused Resume' })
    const saved = await fixtureJob(project.slug, 'video-resume-paused', 'running', { pauseRequested: true })
    await persist(project.slug, [saved])
    let executions = 0
    jq.registerExecutor('video_assembly', async () => { executions++ })

    await jq.getJobs(project.slug)

    assert.equal(executions, 0)
    assert.equal(jq.getJob(saved.job_id)?.status, 'paused')
  })

  test('owner-paused and cancelled jobs never auto-requeue valid checkpoints', async () => {
    const project = await pm.createProject({ name: 'Video Assembly Terminal Intent' })
    const paused = await fixtureJob(project.slug, 'video-owner-paused', 'paused')
    paused.pause_origin = 'manual'
    const cancelled = await fixtureJob(project.slug, 'video-owner-cancelled', 'cancelled')
    cancelled.finished_at = new Date().toISOString()
    await persist(project.slug, [paused, cancelled])
    let executions = 0
    jq.registerExecutor('video_assembly', async () => { executions++ })

    await jq.getJobs(project.slug)

    assert.equal(executions, 0)
    assert.equal(jq.getJob(paused.job_id)?.status, 'paused')
    assert.equal(jq.getJob(cancelled.job_id)?.status, 'cancelled')
  })

  test('durable remote cancellation context wins over a valid running checkpoint', async () => {
    const project = await pm.createProject({ name: 'Video Assembly Remote Cancellation' })
    const saved = await fixtureJob(project.slug, 'video-remote-cancelled', 'running')
    const now = new Date().toISOString()
    saved.remote_cancellations = {
      'video.generation:remote-video': {
        status: 'confirmed',
        operation: 'video.generation',
        provider_job_id: 'remote-video',
        requested_at: now,
        updated_at: now,
      },
    }
    await persist(project.slug, [saved])
    let executions = 0
    jq.registerExecutor('video_assembly', async () => { executions++ })

    await jq.getJobs(project.slug)

    assert.equal(executions, 0)
    assert.equal(jq.getJob(saved.job_id)?.status, 'error')
    assert.equal(jq.getJob(saved.job_id)?.error, 'Interrupted by app restart')
  })

  test('the existing free local retry keeps the scene checkpoint for attempt two', async () => {
    const project = await pm.createProject({ name: 'Video Assembly Local Retry' })
    await jq.getJobs(project.slug)
    let attempts = 0
    let checkpointSeenOnRetry: unknown
    jq.registerExecutor('video_assembly', async job => {
      attempts++
      if (attempts === 1) {
        job.result = { video_assembly_checkpoint: { durable_marker: 'keep-me' } }
        throw new Error('disposable first-attempt failure')
      }
      checkpointSeenOnRetry = job.result?.video_assembly_checkpoint
    })
    const queued = trackFixtureJob(jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'video_assembly',
      episode_id: 'LOCALRETRY',
      title: 'Video Assembly local retry checkpoint',
      params: {},
    }))

    await waitFor(() => jq.getJob(queued.job_id)?.status === 'done', {
      label: 'the Video Assembly checkpoint to survive local attempt two',
    })

    assert.equal(attempts, 2)
    assert.deepEqual(checkpointSeenOnRetry, { durable_marker: 'keep-me' })
    assert.equal(jq.getJob(queued.job_id)?.status, 'done')
  })

  test('a local stop during retry backoff prevents attempt two from starting', async () => {
    const project = await pm.createProject({ name: 'Video Assembly Stop During Retry' })
    await jq.getJobs(project.slug)
    let targetAttempts = 0
    let targetJobId = ''
    jq.registerExecutor('video_assembly', async job => {
      if (job.job_id !== targetJobId) return
      targetAttempts++
      throw new Error('enter retry backoff')
    })
    const target = trackFixtureJob(jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'video_assembly',
      episode_id: 'STOPBACKOFF',
      title: 'Video Assembly stop during retry backoff',
      params: {},
    }))
    targetJobId = target.job_id

    await waitFor(() => Boolean(jq.getJob(target.job_id)?.auto_retry?.next_retry_at), {
      label: 'the first Video Assembly attempt to enter local retry backoff',
    })
    await jq.requestJobCancellation(project.slug, target.job_id)
    const sentinel = trackFixtureJob(jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'video_assembly',
      episode_id: 'AFTERSTOP',
      title: 'Video Assembly lane release sentinel',
      params: {},
    }))
    await waitFor(() => jq.getJob(sentinel.job_id)?.status === 'done', {
      label: 'the stopped Video Assembly job to release its retry lane',
    })

    assert.equal(targetAttempts, 1)
    assert.equal(jq.getJob(target.job_id)?.status, 'cancelled')
  })

  for (const scenario of [
    { label: 'malformed', options: { malformed: true } },
    { label: 'path escape', options: { escapePath: true } },
  ]) {
    test(`${scenario.label} checkpoint keeps the existing interrupted error`, async () => {
      const project = await pm.createProject({ name: `Video Assembly ${scenario.label}` })
      const saved = await fixtureJob(project.slug, `video-resume-${scenario.label}`, 'running', scenario.options)
      await persist(project.slug, [saved])
      let executions = 0
      jq.registerExecutor('video_assembly', async () => { executions++ })

      await jq.getJobs(project.slug)

      assert.equal(executions, 0)
      assert.equal(jq.getJob(saved.job_id)?.status, 'error')
      assert.equal(jq.getJob(saved.job_id)?.error, 'Interrupted by app restart')
    })
  }
})
