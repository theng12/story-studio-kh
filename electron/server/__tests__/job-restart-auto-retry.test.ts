/**
 * A job a restart could not resume ends "Interrupted by app restart". Free local/fleet work is then
 * retried once by itself after a short post-boot delay, through the owner's Retry path (DK0116 and
 * DK0080 final videos sat failed 11-16 Oct waiting for a click). Paid work, unsettled provider
 * evidence, cancellations, a paused queue and an exhausted retry budget keep it manual.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { sleep, waitFor } from './_timing.js'
import type { Job, JobType } from '../models/types.js'

const LINE = /Retried automatically after the app restarted \(attempt 2 of 3\)\./

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
const ran: Array<{ type: string; episode: string; params: Record<string, any> }> = []

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  jq._setRestartRetryDelayForTesting(50)
  for (const type of ['video_assembly', 'thumb_images'] as const) {
    jq.registerExecutor(type, async job => { ran.push({ type, episode: job.episode_id, params: job.params }) })
  }
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

function runningJob(projectSlug: string, episode: string, type: JobType = 'video_assembly', extra: Partial<Job> = {}): Job {
  const now = new Date().toISOString()
  return {
    job_id: `interrupted-${episode}`,
    project_slug: projectSlug,
    type,
    episode_id: episode,
    title: `Final video ${episode}`,
    status: 'running',
    created_at: now,
    started_at: now,
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    ...extra,
  }
}

async function boot(projectSlug: string, rows: Job[]): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'projects', projectSlug, 'jobs.json'), JSON.stringify({ jobs: rows }))
  await jq.getJobs(projectSlug)
}

const retriedJob = (projectSlug: string, episode: string) => jq.getJobs(projectSlug)
  .then(rows => rows.find(row => row.episode_id === episode && row.job_id !== `interrupted-${episode}`))

describe('automatic retry of jobs a restart interrupted', () => {
  test('an eligible interrupted final video is retried once after the delay, with a log line', async () => {
    const project = await pm.createProject({ name: 'Restart Retry Eligible' })
    // CONTROL is armed last in the same boot scan with the same delay: once it has been retried,
    // every retry timer armed before it has fired, so the exactly-once assertion below needs no
    // fixed wall-clock window. Same idiom as the ineligible-jobs test below.
    await boot(project.slug, [runningJob(project.slug, 'DK0116'), runningJob(project.slug, 'CONTROL')])
    assert.equal(jq.getJob('interrupted-DK0116')?.error, 'Interrupted by app restart')
    assert.equal(ran.length, 0, 'nothing runs synchronously inside the boot scan')

    await waitFor(async () => (await retriedJob(project.slug, 'DK0116'))?.status === 'done', {
      label: 'the interrupted final video to be retried and finish',
    })
    const retried = (await retriedJob(project.slug, 'DK0116'))!
    assert.equal(jq.getJob('interrupted-DK0116'), null, 'the failed row is replaced, as a manual Retry does')
    assert.match(retried.output_lines.join('\n'), LINE)
    assert.equal(retried.params.restart_retry_attempt, 2)
    await waitFor(async () => (await retriedJob(project.slug, 'CONTROL'))?.status === 'done', {
      label: 'the later control job to be retried, so every earlier retry timer has fired',
    })
    assert.equal(ran.filter(run => run.episode === 'DK0116').length, 1, 'retried exactly once')
  })

  test('paid, unsettled, cancelled and exhausted interrupted jobs stay failed for a manual Retry', async () => {
    const project = await pm.createProject({ name: 'Restart Retry Ineligible' })
    const now = new Date().toISOString()
    // The queue is held while the evidence below is written: a held retry re-arms instead of running,
    // so the evidence is provably in place before any retry can fire. Relying on the write landing
    // inside the retry delay made this test fail about two runs in five.
    await jq.setQueuePaused(true)
    try {
      await boot(project.slug, [
        runningJob(project.slug, 'PAID', 'thumb_images', { params: { model: 'gpt-image-2' } }),
        runningJob(project.slug, 'UNSETTLED'),
        runningJob(project.slug, 'CANCELLED', 'video_assembly', { remote_cancellations: {
          'video.generation:remote': { status: 'confirmed', operation: 'video.generation', provider_job_id: 'remote', requested_at: now, updated_at: now },
        } as Job['remote_cancellations'] }),
        runningJob(project.slug, 'EXHAUSTED', 'video_assembly', { params: { restart_retry_attempt: 3 } }),
        // Scheduled last with the same delay: once it is retried, every timer above has fired.
        runningJob(project.slug, 'CONTROL'),
      ])
      // Evidence that appears before the retry fires is checked when it fires.
      await jq.mutateAuthoritativeJob(project.slug, 'interrupted-UNSETTLED', current => ({ ...current,
        genstudio_jobs: [{ id: 'gs-1', operation: 'video.generation', state: 'accepted', updated_at: now }] }))
    } finally {
      await jq.setQueuePaused(false)
    }

    await waitFor(async () => (await retriedJob(project.slug, 'CONTROL'))?.status === 'done', {
      label: 'the control job to be retried',
    })
    await jq._waitForJobPersistenceForTesting()
    for (const episode of ['PAID', 'UNSETTLED', 'CANCELLED', 'EXHAUSTED']) {
      const row = jq.getJob(`interrupted-${episode}`)
      assert.equal(row?.status, 'error', `${episode} stays failed`)
      assert.equal(row?.error, 'Interrupted by app restart')
      assert.equal(await retriedJob(project.slug, episode), undefined, `${episode} was not retried`)
    }
  })

  test('a paused queue holds the retry until Resume', async () => {
    const project = await pm.createProject({ name: 'Restart Retry Paused' })
    await jq.setQueuePaused(true)
    // The retry delay is dropped to 0 so the retry timer is provably DUE while the queue is paused:
    // it is armed during the load and expires in the same event-loop turn as the yield below, so the
    // hold is asserted after a real retry attempt rather than after a fixed wall-clock guess. The
    // delay is restored before the assertions so the paused re-arm cannot spin.
    jq._setRestartRetryDelayForTesting(0)
    try {
      await boot(project.slug, [runningJob(project.slug, 'PAUSED')])
      await sleep(0)
      jq._setRestartRetryDelayForTesting(50)
      assert.equal(jq.getJob('interrupted-PAUSED')?.status, 'error')
      assert.equal(await retriedJob(project.slug, 'PAUSED'), undefined, 'not retried while the queue is paused')
    } finally {
      jq._setRestartRetryDelayForTesting(50)
      await jq.setQueuePaused(false)
    }
    await waitFor(async () => (await retriedJob(project.slug, 'PAUSED'))?.status === 'done', {
      label: 'the held job to be retried after Resume',
    })
  })
})
