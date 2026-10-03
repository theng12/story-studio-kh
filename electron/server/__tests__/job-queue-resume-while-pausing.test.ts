/**
 * Resume pressed while a Pause is still taking effect (accepted provider work
 * finishing). Found in the Dreamlands durability run 2026-10-03: the job kept
 * offering "Pause new work", and Resume answered "Only paused jobs can be
 * resumed." until every in-flight narration piece had finished — minutes with
 * no way to change one's mind.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let jc: typeof import('../services/job-control.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  jc = await import('../services/job-control.js')
})

after(async () => { await cleanup() })

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && !check()) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(check(), label)
}

function pauseControl(jobId: string) {
  const job = jq.getJob(jobId)!
  return jc.classifyJobControls(job, { remoteCancellationAudited: false })
    .find(control => control.action === 'pause-submissions')
}

describe('Resume while a pause is taking effect', { concurrency: 1 }, () => {
  test('is accepted, shows the pausing state, and continues on its own at the checkpoint', async () => {
    const proj = await pm.createProject({ name: 'JQ Resume While Pausing' })
    let runs = 0
    let release!: () => void
    const inFlight = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async running => {
      if (running.episode_id !== 'EP010') return
      runs++
      if (runs === 1) await inFlight
    })
    const job = jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'audio', episode_id: 'EP010', title: 'pausing', params: {} })
    await until(() => runs === 1, 'executor should be mid-flight')

    await jq.pauseJob(job.job_id)
    assert.equal(jq.getJob(job.job_id)?.pause_requested, true)
    const pausing = pauseControl(job.job_id)
    assert.equal(pausing?.enabled, false, 'a pause already taking effect is not offered again')
    assert.equal(pausing?.label, 'Pausing…')

    // A repeated Pause is idempotent, not a 409.
    assert.ok(await jq.pauseJob(job.job_id))

    const resumed = await jq.resumeJob(job.job_id)
    assert.ok(resumed, 'Resume must be accepted while the pause is taking effect')
    assert.equal(jq.getJob(job.job_id)?.resume_after_pause, true)
    assert.equal(jq.getJob(job.job_id)?.status, 'running', 'in-flight work is not disturbed')
    assert.equal(pauseControl(job.job_id)?.label, 'Resuming after pause')

    release()
    await until(() => jq.getJob(job.job_id)?.status === 'done', 'job should continue and finish without another Resume')
    assert.equal(runs, 2, 'the checkpoint is reached, then the job runs again for what is still missing')
    assert.equal(jq.getJob(job.job_id)?.resume_after_pause, false)
  })

  test('Pause pressed again after Resume keeps the job paused at the checkpoint', async () => {
    const proj = await pm.createProject({ name: 'JQ Pause Resume Pause' })
    let runs = 0
    let release!: () => void
    const inFlight = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async running => {
      if (running.episode_id !== 'EP011') return
      runs++
      if (runs === 1) await inFlight
    })
    const job = jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'audio', episode_id: 'EP011', title: 'flip-flop', params: {} })
    await until(() => runs === 1, 'executor should be mid-flight')

    await jq.pauseJob(job.job_id)
    await jq.resumeJob(job.job_id)
    await jq.pauseJob(job.job_id)
    assert.equal(jq.getJob(job.job_id)?.resume_after_pause, false)

    release()
    await until(() => jq.getJob(job.job_id)?.status === 'paused', 'job should stop at its checkpoint')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(jq.getJob(job.job_id)?.status, 'paused')
    assert.equal(runs, 1)

    await jq.resumeJob(job.job_id)
    await until(() => jq.getJob(job.job_id)?.status === 'done', 'ordinary Resume still works')
  })
})
