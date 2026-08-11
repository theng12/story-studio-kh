/**
 * Tests for the cancel pipeline.
 *
 * Three things this locks in:
 *   1. `trackChild(proc)` inside an executor registers against the current
 *      job via AsyncLocalStorage, so `requestJobCancellation` can SIGTERM it.
 *   2. The final job status after a cancel is `cancelled`, not `error` —
 *      even though the executor rejects with an FFmpeg-exited-style error.
 *   3. `jobEvents` emits an `update` for the cancelled transition so the
 *      SSE stream's subscribers see the cancellation live.
 *   4. `DuplicateJobError` makes the second enqueue-in-the-same-tick throw
 *      instead of silently creating a duplicate.
 *
 * These tests use a real child process (`node -e` that sleeps) rather than
 * mocking ffmpeg — the kill mechanism is identical and this exercises the
 * actual signal-delivery path.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { router as jobsRouter } from '../routes/jobs.js'
import { registerJobCancellationAuditor } from '../services/job-cancellation-auditors.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', '')
})

after(async () => { await cleanup() })

async function waitForTerminal(jobId: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || '')) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''), `job ${jobId} did not settle`)
}

describe('requestJobCancellation()', () => {
  test('sends SIGTERM to children registered via trackChild', async () => {
    const proj = await pm.createProject({ name: 'CancelChild' })
    let reportChildTracked!: () => void
    const childTracked = new Promise<void>((resolve) => { reportChildTracked = resolve })

    // A subprocess that would otherwise run indefinitely. The executor
    // registers it with the queue and then awaits its exit.
    const childExitedWithSignal = new Promise<string | null>((resolve) => {
      jq.registerExecutor('video_assembly', async () => {
        const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
        jq.trackChild(child)
        reportChildTracked()
        await new Promise<void>((r) => {
          child.on('exit', (_code, signal) => {
            resolve(signal)
            r()
          })
        })
      })
    })

    const job = jq.enqueue({
      project_slug: proj.slug, type: 'video_assembly', episode_id: 'CANCEL_CHILD',
      title: 't', params: {},
    })

    // Wait for the exact registration checkpoint instead of assuming the
    // queue starts within 100 ms. The full suite intentionally exercises
    // many real subprocesses, so a wall-clock sleep can cancel the queued
    // job before this executor has attached its child.
    await childTracked

    const cancelled = await jq.requestJobCancellation(proj.slug, job.job_id)
    assert.equal(cancelled.status, 'cancelled')

    const signal = await Promise.race([
      childExitedWithSignal,
      new Promise<string | null>((_, rej) => setTimeout(() => rej(new Error('child did not exit in 10s')), 10_000)),
    ])
    assert.equal(signal, 'SIGTERM', `child should be killed with SIGTERM, got ${signal}`)
  })

  test('cancelled job settles with status=cancelled, not error', async () => {
    const proj = await pm.createProject({ name: 'CancelStatus' })

    // Executor spawns a child, tracks it, and waits for it. When cancel
    // SIGTERMs the child, the spawn wrapper would reject — exactly the
    // shape runFfmpeg produces on cancel. The queue must still classify
    // this terminal state as `cancelled`, not `error`.
    jq.registerExecutor('video_assembly', async () => {
      const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
      jq.trackChild(child)
      await new Promise<void>((_, reject) => {
        child.on('exit', (code, signal) => {
          if (signal === 'SIGTERM') reject(new Error('Killed by SIGTERM'))
          else reject(new Error(`child exited with code ${code}`))
        })
      })
    })

    const job = jq.enqueue({
      project_slug: proj.slug, type: 'video_assembly', episode_id: 'CANCEL_STATUS',
      title: 't', params: {},
    })
    await new Promise((r) => setTimeout(r, 100))

    await jq.requestJobCancellation(proj.slug, job.job_id)

    // Wait long enough for the child to exit + the queue runner to settle.
    await new Promise((r) => setTimeout(r, 400))

    const after = jq.getJob(job.job_id)
    assert.ok(after, 'job should still be readable')
    assert.equal(after!.status, 'cancelled',
      `expected status=cancelled, got ${after!.status} (error=${after!.error})`)
  })

  test('jobEvents emits an update with cancelled status on cancel', async () => {
    const proj = await pm.createProject({ name: 'CancelEvent' })

    // Capture every update event for this project.
    const updates: Array<{ job_id: string; status: string }> = []
    const onUpdate = (j: any) => {
      if (j.project_slug === proj.slug) updates.push({ job_id: j.job_id, status: j.status })
    }
    jq.jobEvents.on('update', onUpdate)

    try {
      jq.registerExecutor('video_assembly', async () => {
        const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
        jq.trackChild(child)
        await new Promise<void>((_, reject) => {
          child.on('exit', () => reject(new Error('Killed')))
        })
      })

      const job = jq.enqueue({
        project_slug: proj.slug, type: 'video_assembly', episode_id: 'CANCEL_EVENT',
        title: 't', params: {},
      })
      await new Promise((r) => setTimeout(r, 100))
      await jq.requestJobCancellation(proj.slug, job.job_id)
      await new Promise((r) => setTimeout(r, 300))

      const forThisJob = updates.filter(u => u.job_id === job.job_id)
      assert.ok(
        forThisJob.some(u => u.status === 'cancelled'),
        `expected a cancelled update for ${job.job_id}; got ${JSON.stringify(forThisJob)}`,
      )
    } finally {
      jq.jobEvents.off('update', onUpdate)
    }
  })
})

describe('enqueue() dedupe', () => {
  test('throws DuplicateJobError on same (project, episode, type)', async () => {
    const proj = await pm.createProject({ name: 'Dedupe' })

    // Blocking executor keeps the first job in `running` so the second
    // enqueue hits a live duplicate.
    jq.registerExecutor('script-only', async () => {
      await new Promise(() => {}) // never resolves — we don't cancel this one
    })

    jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'DEDUPE_1',
      title: 'a', params: {},
    })
    await new Promise((r) => setTimeout(r, 50))

    assert.throws(
      () => jq.enqueue({
        project_slug: proj.slug, type: 'script-only', episode_id: 'DEDUPE_1',
        title: 'b', params: {},
      }),
      (err: any) => {
        assert.equal(err.name, 'DuplicateJobError')
        assert.equal(err.status, 409, 'should carry HTTP 409 status')
        assert.equal(err.expose, true, 'should be safe to expose to client')
        assert.match(err.message, /DEDUPE_1/)
        return true
      },
    )
  })

  test('isCancelled() reflects the cancelled set', async () => {
    const proj = await pm.createProject({ name: 'IsCancelled' })

    jq.registerExecutor('video_assembly', async () => {
      await new Promise(() => {}) // block forever
    })

    const job = jq.enqueue({
      project_slug: proj.slug, type: 'video_assembly', episode_id: 'ISC_1',
      title: 't', params: {},
    })
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(jq.isCancelled(job.job_id), false)
    await jq.requestJobCancellation(proj.slug, job.job_id)
    assert.equal(jq.isCancelled(job.job_id), true)
  })
})

describe('remote cancellation checkpoints', () => {
  test('queues each eligible GenStudio target once and keeps the Story job running', async () => {
    const proj = await pm.createProject({ name: 'RemoteCancellationTargets' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')

    const job = jq.enqueue({
      project_slug: proj.slug, type: 'audio', episode_id: 'REMOTE_CANCEL', title: 'remote', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(job.job_id)?.status, 'running')
    await jq.recordGenStudioJob(job.job_id, {
      id: 'tts-target-1', operation: 'voice.tts', state: 'accepted', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.recordGenStudioJob(job.job_id, {
      id: 'tts-target-2', operation: 'voice.tts', state: 'accepted', cancellable: true,
      updated_at: new Date().toISOString(),
    })

    const [first, second] = await Promise.all([
      jq.requestJobCancellation(proj.slug, job.job_id),
      jq.requestJobCancellation(proj.slug, job.job_id),
    ])
    const keys = ['voice.tts:tts-target-1', 'voice.tts:tts-target-2']
    assert.equal(first.status, 'running')
    assert.equal(first.finished_at, null)
    assert.deepEqual(Object.keys(first.remote_cancellations || {}).sort(), keys)
    assert.deepEqual(Object.keys(second.remote_cancellations || {}).sort(), keys)
    assert.ok(keys.every(key => ['queued', 'submitting', 'requested', 'reconciling', 'unknown'].includes(first.remote_cancellations?.[key]?.status || '')))

    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(jq.getJob(job.job_id)?.status, 'running')
  })

  test('claims each remote target once and read-only terminal evidence releases a crashed submitting record', async () => {
    const project = await pm.createProject({ name: 'ClaimOnceAndReconcile' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')
    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'CLAIM_ONCE', title: 'claim once', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'claim-target', operation: 'voice.tts', state: 'accepted', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)
    const claims = await Promise.all([
      jq.claimRemoteCancellation(job.job_id, 'voice.tts', 'claim-target'),
      jq.claimRemoteCancellation(job.job_id, 'voice.tts', 'claim-target'),
    ])
    assert.deepEqual(claims.sort(), [false, true])
    assert.equal(jq.getJob(job.job_id)?.remote_cancellations?.['voice.tts:claim-target']?.status, 'submitting')
    await jq.reconcileRemoteCancellationFromProvider(job.job_id, 'voice.tts', 'claim-target', {
      state: 'succeeded', released_credits: 0,
    })
    assert.equal(jq.getJob(job.job_id)?.remote_cancellations?.['voice.tts:claim-target']?.status, 'rejected')
    release()
  })

  test('does not terminalize while an excluded accepted provider sibling still settles', async () => {
    const project = await pm.createProject({ name: 'AllProviderTargetsMustSettle' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')
    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'ALL_TARGETS', title: 'all targets', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'eligible-target', operation: 'voice.tts', state: 'accepted', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.recordGenStudioJob(job.job_id, {
      id: 'already-running-sibling', operation: 'voice.tts', state: 'running', cancellable: false,
      updated_at: new Date().toISOString(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)
    await jq.recordRemoteCancellation(job.job_id, 'voice.tts', 'eligible-target', {
      status: 'confirmed', state: 'failed', cancelled: true,
    })
    release()
    await new Promise(resolve => setTimeout(resolve, 60))
    const whileSiblingRuns = jq.getJob(job.job_id)
    assert.equal(whileSiblingRuns?.status, 'running')
    assert.equal(whileSiblingRuns?.finished_at, null)
    assert.equal(jq.hasUnsettledProviderWork(whileSiblingRuns!), true)

    await jq.recordGenStudioJob(job.job_id, {
      id: 'already-running-sibling', operation: 'voice.tts', state: 'succeeded', cancellable: false,
      updated_at: new Date().toISOString(),
    })
    await jq.recordGenStudioJob(job.job_id, {
      id: 'eligible-target', operation: 'voice.tts', state: 'failed', cancelled: true,
      updated_at: new Date().toISOString(),
    })
    assert.equal(jq.hasUnsettledProviderWork(jq.getJob(job.job_id)!), false)
    const finalDeadline = Date.now() + 2_000
    while (Date.now() < finalDeadline && jq.getJob(job.job_id)?.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const final = jq.getJob(job.job_id)!
    assert.equal(final.status, 'error')
    assert.match(final.error || '', /mixed completed and cancelled/i)
    assert.deepEqual(final.result, { provider_settled: 'mixed', repair_required: true })
  })

  test('provider settlement chooses cancelled, error, or audited repair outcomes after local work returns', async () => {
    const settle = async (episode: string, state: 'failed' | 'succeeded', cancelled = false) => {
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      jq.registerExecutor('audio', async () => await hold)
      const project = await pm.createProject({ name: `ProviderFinal-${episode}` })
      const job = jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: episode, title: episode, params: {} })
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
      await jq.recordGenStudioJob(job.job_id, {
        id: `${episode}-target`, operation: 'voice.tts', state: 'accepted', cancellable: true,
        updated_at: new Date().toISOString(),
      })
      await jq.requestJobCancellation(project.slug, job.job_id)
      release()
      await new Promise(resolve => setTimeout(resolve, 40))
      await jq.recordRemoteCancellation(job.job_id, 'voice.tts', `${episode}-target`, {
        status: cancelled ? 'confirmed' : 'rejected', state, ...(cancelled ? { cancelled: true } : {}),
      })
      await jq.recordGenStudioJob(job.job_id, {
        id: `${episode}-target`, operation: 'voice.tts', state, ...(cancelled ? { cancelled: true } : {}),
        updated_at: new Date().toISOString(),
      })
      const finalDeadline = Date.now() + 2_000
      while (Date.now() < finalDeadline && jq.getJob(job.job_id)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 20))
      return jq.getJob(job.job_id)!
    }

    registerJobCancellationAuditor('audio', async () => 'complete')
    assert.equal((await settle('ALL_CANCELLED', 'failed', true)).status, 'cancelled')
    assert.equal((await settle('PROVIDER_FAILED', 'failed')).status, 'error')
    registerJobCancellationAuditor('audio', async () => 'repair-required')
    const repair = await settle('REPAIR_REQUIRED', 'succeeded')
    assert.equal(repair.status, 'error')
    assert.match(repair.error || '', /needs repair/i)
    assert.deepEqual(repair.result, { provider_settled: 'succeeded', repair_required: true })
    registerJobCancellationAuditor('audio', async () => { throw new Error('malformed narration artifact') })
    const auditFailure = await settle('AUDIT_THREW', 'succeeded')
    assert.equal(auditFailure.status, 'error')
    assert.match(auditFailure.error || '', /needs repair/i)
    assert.equal(auditFailure.result?.repair_required, true)
    registerJobCancellationAuditor('audio', async () => 'complete')
  })

  test('simultaneous final provider updates run the auditor and terminal transition once', async () => {
    const project = await pm.createProject({ name: 'SingleProviderFinalization' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    let audits = 0
    jq.registerExecutor('audio', async () => await hold)
    jq.registerExecutor('broll_assemble', async () => {})
    registerJobCancellationAuditor('audio', async () => { audits++; return 'complete' })
    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'FINAL_ONCE', title: 'final once',
      params: { pipeline_chain: [{ type: 'broll_assemble', title: 'next local assembly', params: {} }] },
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
    for (const id of ['first', 'second']) {
      await jq.recordGenStudioJob(job.job_id, { id, operation: 'voice.tts', state: 'accepted', cancellable: true, updated_at: new Date().toISOString() })
    }
    await jq.requestJobCancellation(project.slug, job.job_id)
    release()
    await new Promise(resolve => setTimeout(resolve, 40))
    for (const id of ['first', 'second']) {
      await jq.recordRemoteCancellation(job.job_id, 'voice.tts', id, { status: 'confirmed', state: 'succeeded' })
    }
    await Promise.all(['first', 'second'].map(id => jq.recordGenStudioJob(job.job_id, {
      id, operation: 'voice.tts', state: 'succeeded', updated_at: new Date().toISOString(),
    })))
    const finalDeadline = Date.now() + 2_000
    while (Date.now() < finalDeadline && jq.getJob(job.job_id)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jq.getJob(job.job_id)?.status, 'done')
    assert.equal(audits, 1)
    assert.equal((await jq.getJobs(project.slug)).filter(candidate => candidate.type === 'broll_assemble').length, 1)
    registerJobCancellationAuditor('audio', async () => 'complete')
  })

  test('coalesces cold persisted cancellation requests before the project load finishes', async () => {
    const project = await pm.createProject({ name: 'ColdCancellationLoad' })
    const jobId = 'cold-cancellation-job'
    const key = 'voice.tts:cold-tts-target'
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{
      job_id: jobId,
      project_slug: project.slug,
      type: 'audio',
      episode_id: 'COLD_CANCEL',
      title: 'cold',
      status: 'paused',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
      remote_cancellations: {
        [key]: {
          status: 'requested', operation: 'voice.tts', provider_job_id: 'cold-tts-target',
          requested_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
    }] }, null, 2))

    const settled = await Promise.allSettled([
      jq.requestJobCancellation(project.slug, jobId),
      jq.requestJobCancellation(project.slug, jobId),
    ])
    assert.ok(settled.every(result => result.status === 'fulfilled'), JSON.stringify(settled))
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.deepEqual(Object.keys(persisted.remote_cancellations), [key])
  })

  test('keeps a returned executor running until pending remote cancellation settles', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', jobsRouter)
    const project = await pm.createProject({ name: 'PendingCancellationCannotFinish' })
    let release!: () => void
    let executorReturned!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const returned = new Promise<void>(resolve => { executorReturned = resolve })
    jq.registerExecutor('audio', async () => {
      await hold
      executorReturned()
    })
    registerJobCancellationAuditor('audio', async () => 'complete')

    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'PENDING_CANCEL', title: 'pending', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'pending-target', operation: 'voice.tts', state: 'accepted', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)

    release()
    await returned
    await new Promise(resolve => setTimeout(resolve, 30))

    const pending = jq.getJob(job.job_id)
    assert.equal(pending?.status, 'running')
    assert.equal(pending?.finished_at, null)
    assert.ok(['queued', 'submitting', 'requested', 'reconciling', 'unknown'].includes(pending?.remote_cancellations?.['voice.tts:pending-target']?.status || ''))
    const remove = await request(app).delete(`/api/projects/${project.slug}/jobs/${job.job_id}`)
    assert.equal(remove.status, 409)
    const repeated = await request(app).post(`/api/projects/${project.slug}/jobs/${job.job_id}/cancel`)
    assert.equal(repeated.status, 200)
    assert.deepEqual(Object.keys(repeated.body.job.remote_cancellations), ['voice.tts:pending-target'])
  })

  test('keeps a rejected executor running until pending remote cancellation settles', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', jobsRouter)
    const project = await pm.createProject({ name: 'PendingCancellationCannotFail' })
    let release!: () => void
    let executorRejected!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const rejected = new Promise<void>(resolve => { executorRejected = resolve })
    jq.registerExecutor('audio', async () => {
      await hold
      executorRejected()
      throw new Error('local executor failed while cancellation was pending')
    })
    registerJobCancellationAuditor('audio', async () => 'complete')

    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'PENDING_CANCEL_FAILURE', title: 'pending failure', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'pending-failure-target', operation: 'voice.tts', state: 'accepted', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)

    release()
    await rejected
    await new Promise(resolve => setTimeout(resolve, 30))

    const pending = jq.getJob(job.job_id)
    assert.equal(pending?.status, 'running')
    assert.equal(pending?.finished_at, null)
    assert.ok(['queued', 'submitting', 'requested', 'reconciling', 'unknown'].includes(pending?.remote_cancellations?.['voice.tts:pending-failure-target']?.status || ''))
    assert.match(pending?.error || '', /local executor failed while cancellation was pending/)
    assert.match(pending?.output_lines.join('\n') || '', /local executor failed while cancellation was pending/)
    const remove = await request(app).delete(`/api/projects/${project.slug}/jobs/${job.job_id}`)
    assert.equal(remove.status, 409)
    const repeated = await request(app).post(`/api/projects/${project.slug}/jobs/${job.job_id}/cancel`)
    assert.equal(repeated.status, 200)
    assert.deepEqual(Object.keys(repeated.body.job.remote_cancellations), ['voice.tts:pending-failure-target'])
  })

  test('keeps a pause race running until pending remote cancellation settles', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', jobsRouter)
    const project = await pm.createProject({ name: 'PendingCancellationCannotPause' })
    let release!: () => void
    let executorPaused!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const paused = new Promise<void>(resolve => { executorPaused = resolve })
    jq.registerExecutor('audio', async job => {
      await hold
      executorPaused()
      jq.throwIfPauseRequested(job.job_id)
    })
    registerJobCancellationAuditor('audio', async () => 'complete')

    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'PENDING_CANCEL_PAUSE', title: 'pending pause', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'pending-pause-target', operation: 'voice.tts', state: 'accepted', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)
    await jq.pauseJob(job.job_id)

    release()
    await paused
    await new Promise(resolve => setTimeout(resolve, 30))

    const pending = jq.getJob(job.job_id)
    assert.equal(pending?.status, 'running')
    assert.equal(pending?.finished_at, null)
    assert.equal(pending?.control?.action, 'return-later')
    assert.ok(['queued', 'submitting', 'requested', 'reconciling', 'unknown'].includes(pending?.remote_cancellations?.['voice.tts:pending-pause-target']?.status || ''))
    assert.match(pending?.output_lines.join('\n') || '', /pause/i)
    const remove = await request(app).delete(`/api/projects/${project.slug}/jobs/${job.job_id}`)
    assert.equal(remove.status, 409)
    const repeated = await request(app).post(`/api/projects/${project.slug}/jobs/${job.job_id}/cancel`)
    assert.equal(repeated.status, 200)
    assert.deepEqual(Object.keys(repeated.body.job.remote_cancellations), ['voice.tts:pending-pause-target'])
  })

  test('marks an ordinary completed executor done', async () => {
    const project = await pm.createProject({ name: 'OrdinaryCompletionStillDone' })
    jq.registerExecutor('broll_assemble', async () => {})
    const job = jq.enqueue({
      project_slug: project.slug, type: 'broll_assemble', episode_id: 'ORDINARY_DONE', title: 'ordinary', params: {},
    })
    await waitForTerminal(job.job_id)
    assert.equal(jq.getJob(job.job_id)?.status, 'done')
  })

  test('marks an ordinary failed executor as error', async () => {
    const project = await pm.createProject({ name: 'OrdinaryFailureStillError' })
    jq.registerExecutor('audio', async () => {
      throw new Error('ordinary executor failure')
    })
    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'ORDINARY_ERROR', title: 'ordinary failure', params: {},
    })
    await waitForTerminal(job.job_id)
    assert.equal(jq.getJob(job.job_id)?.status, 'error')
    assert.match(jq.getJob(job.job_id)?.error || '', /ordinary executor failure/)
  })

  test('marks an ordinary pause as paused', async () => {
    const project = await pm.createProject({ name: 'OrdinaryPauseStillPaused' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async job => {
      await hold
      jq.throwIfPauseRequested(job.job_id)
    })
    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'ORDINARY_PAUSE', title: 'ordinary pause', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.pauseJob(job.job_id)
    release()
    const pausedDeadline = Date.now() + 2_000
    while (Date.now() < pausedDeadline && jq.getJob(job.job_id)?.status !== 'paused') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(job.job_id)?.status, 'paused')
  })
})

describe('terminal provider-evidence guards', () => {
  test('provider success during a live executor waits for local output before auditing or releasing the lock', async () => {
    const { setApiKey } = await import('../services/app-secrets-store.js')
    await setApiKey('genstudio', 'live-success-key')
    const project = await pm.createProject({ name: 'Live provider success boundary' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    let outputCreated = false
    let audits = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const requestPath = new URL(String(input)).pathname
      if (requestPath.endsWith('/cancel')) return Response.json({ id: 'live-success-target', state: 'succeeded', cancelled: false })
      assert.equal(init?.method || 'GET', 'GET')
      return Response.json({ id: 'live-success-target', state: 'accepted', cancellable: true, cancelled: false })
    }
    jq.registerExecutor('audio', async () => {
      await hold
      outputCreated = true
    })
    registerJobCancellationAuditor('audio', async () => {
      audits++
      return outputCreated ? 'complete' : 'repair-required'
    })
    const job = jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'LIVE_SUCCESS', title: 'live success', params: {} })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
    await jq.recordGenStudioJob(job.job_id, { id: 'live-success-target', operation: 'voice.tts', state: 'accepted', cancellable: true, updated_at: new Date().toISOString() })
    try {
      await jq.requestJobCancellation(project.slug, job.job_id)
      const settledDeadline = Date.now() + 1_000
      while (Date.now() < settledDeadline && jq.getJob(job.job_id)?.genstudio_jobs?.[0]?.state !== 'succeeded') await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(jq.getJob(job.job_id)?.status, 'running')
      assert.equal(jq.isDuplicate(project.slug, 'LIVE_SUCCESS', 'audio'), true)
      assert.equal(audits, 0, 'the active executor has not checkpointed its output yet')

      release()
      const finalDeadline = Date.now() + 2_000
      while (Date.now() < finalDeadline && jq.getJob(job.job_id)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(jq.getJob(job.job_id)?.status, 'done')
      assert.equal(audits, 1)
    } finally {
      release()
      globalThis.fetch = originalFetch
      await setApiKey('genstudio', '')
      registerJobCancellationAuditor('audio', async () => 'complete')
    }
  })

  test('a live remote-cancel request begins reconciliation before its executor returns', async () => {
    const { setApiKey } = await import('../services/app-secrets-store.js')
    await setApiKey('genstudio', 'live-cancel-key')
    const project = await pm.createProject({ name: 'Live cancellation dispatch' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const requests: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const requestPath = new URL(String(input)).pathname
      requests.push(`${init?.method || 'GET'} ${requestPath}`)
      if (requestPath.endsWith('/cancel')) return Response.json({ id: 'live-cancel-target', state: 'running', cancellation_requested: true, cancelled: false })
      return Response.json({ id: 'live-cancel-target', state: 'accepted', cancellable: true, cancelled: false })
    }
    jq.registerExecutor('audio', async () => await hold)
    const job = jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'LIVE_CANCEL', title: 'live', params: {} })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
    await jq.recordGenStudioJob(job.job_id, { id: 'live-cancel-target', operation: 'voice.tts', state: 'accepted', cancellable: true, updated_at: new Date().toISOString() })
    try {
      await jq.requestJobCancellation(project.slug, job.job_id)
      const reconcileDeadline = Date.now() + 1_000
      while (Date.now() < reconcileDeadline && requests.length < 2) await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(requests, [
        'GET /v1/jobs/live-cancel-target',
        'POST /v1/jobs/live-cancel-target/cancel',
      ])
      assert.equal(jq.getJob(job.job_id)?.status, 'running')
      assert.equal(jq.isDuplicate(project.slug, 'LIVE_CANCEL', 'audio'), true)
    } finally {
      release()
      globalThis.fetch = originalFetch
      await setApiKey('genstudio', '')
    }
  })

  test('restored queued work with an accepted provider ID cannot be cancelled as unsubmitted', async () => {
    const project = await pm.createProject({ name: 'AcceptedRestartCancellation' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    registerJobCancellationAuditor('audio', async () => 'complete')
    await jq.setQueuePaused(true)
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{
      job_id: 'accepted-restart-cancel', project_slug: project.slug, type: 'audio', episode_id: 'EP0001', title: 'accepted',
      status: 'queued', created_at: new Date().toISOString(), started_at: null, finished_at: null, error: null, output_lines: [], params: {},
      genstudio_jobs: [{ id: 'accepted-tts', operation: 'voice.tts', state: 'accepted', cancellable: true, updated_at: new Date().toISOString() }],
    }] }))
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const originalFetch = globalThis.fetch
    const requests: Array<{ method: string; path: string }> = []
    globalThis.fetch = async (input, init) => {
      const requestPath = new URL(String(input)).pathname
      requests.push({ method: (init?.method || 'GET').toUpperCase(), path: requestPath })
      if (requestPath === '/v1/jobs/accepted-tts') return Response.json({ id: 'accepted-tts', state: 'accepted', cancellable: true, cancelled: false })
      if (requestPath === '/v1/jobs/accepted-tts/cancel') return Response.json({ id: 'accepted-tts', state: 'running', cancellation_requested: true, cancelled: false })
      return Response.json({ detail: 'unexpected request' }, { status: 500 })
    }
    try {
      await jq.getJobs(project.slug)
      await setApiKey('genstudio', 'restored-cancel-key')
      const controlled = await jq.requestJobCancellation(project.slug, 'accepted-restart-cancel')
      assert.equal(controlled.status, 'running')
      assert.equal(controlled.finished_at, null)
      assert.ok(controlled.remote_cancellations?.['voice.tts:accepted-tts'])
      assert.doesNotMatch(controlled.output_lines.join('\n'), /sent no provider request/i)
      const reconcileDeadline = Date.now() + 1_000
      while (Date.now() < reconcileDeadline && requests.length < 2) await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(requests, [
        { method: 'GET', path: '/v1/jobs/accepted-tts' },
        { method: 'POST', path: '/v1/jobs/accepted-tts/cancel' },
      ])
      assert.equal(jq.getJob('accepted-restart-cancel')?.status, 'running')
      assert.equal(jq.getJob('accepted-restart-cancel')?.finished_at, null)
      assert.equal(jq.isDuplicate(project.slug, 'EP0001', 'audio'), true)
    } finally {
      globalThis.fetch = originalFetch
      await setApiKey('genstudio', '')
      await jq.setQueuePaused(false)
    }
  })

  test('terminal-looking work with unsettled provider evidence cannot be removed, cleared, or retried', async () => {
    const project = await pm.createProject({ name: 'TerminalEvidenceGuard' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    await jq.setQueuePaused(true)
    const jobId = 'terminal-unsettled-evidence'
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{
      job_id: jobId, project_slug: project.slug, type: 'audio', episode_id: 'EP0001', title: 'unsafe terminal',
      status: 'error', created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString(), error: 'local error', output_lines: [], params: {},
      genstudio_jobs: [{ id: 'still-running', operation: 'voice.tts', state: 'running', updated_at: new Date().toISOString() }],
    }] }))
    try {
      await jq.getJobs(project.slug)
      assert.throws(() => jq.retryTerminalJob(project.slug, jobId), /provider evidence/i)
      assert.equal(jq.removeTerminalJob(project.slug, jobId), false)
      assert.equal(await jq.clearFinished(project.slug), 0)
      assert.equal(jq.getJob(jobId)?.status, 'error')
    } finally {
      await jq.setQueuePaused(false)
    }
  })

  for (const scenario of ['success', 'error', 'pause'] as const) {
    test(`schedules live reconciliation outside the worker lane after a ${scenario} boundary`, async () => {
      const { setApiKey } = await import('../services/app-secrets-store.js')
      const project = await pm.createProject({ name: `LiveReconcile-${scenario}` })
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      let afterBoundary = false
      let readsAfterBoundary = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (input) => {
        if (afterBoundary) readsAfterBoundary++
        return Response.json({ id: 'live-target', state: 'running', cancellable: false, cancelled: false })
      }
      jq.registerExecutor('audio', async job => {
        await hold
        if (scenario === 'error') throw new Error('local boundary error')
        if (scenario === 'pause') jq.throwIfPauseRequested(job.job_id)
      })
      const queued = jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: `EP_${scenario}`, title: scenario, params: {} })
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && jq.getJob(queued.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
      await jq.recordGenStudioJob(queued.job_id, { id: 'live-target', operation: 'voice.tts', state: 'accepted', cancellable: true, updated_at: new Date().toISOString() })
      await jq.requestJobCancellation(project.slug, queued.job_id)
      if (scenario === 'pause') await jq.pauseJob(queued.job_id)
      await setApiKey('genstudio', 'live-reconcile-key')
      afterBoundary = true
      release()
      try {
        const reconcileDeadline = Date.now() + 1_000
        while (Date.now() < reconcileDeadline && readsAfterBoundary === 0) await new Promise(resolve => setTimeout(resolve, 20))
        assert.ok(readsAfterBoundary > 0, `${scenario} boundary must start a read-only reconciliation`)
        assert.equal(jq.getJob(queued.job_id)?.status, 'running')
        assert.equal(jq.getJob(queued.job_id)?.finished_at, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  }
})

describe('job route controls', () => {
  test('DELETE removes only terminal history while POST cancels queued work', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', jobsRouter)
    const project = await pm.createProject({ name: 'TerminalRemovalOnly' })
    const wrongProject = await pm.createProject({ name: 'TerminalRemovalWrongProject' })
    const output = path.join(tempDir, 'projects', project.slug, 'output-kept.txt')
    await fs.writeFile(output, 'generated output stays')
    await jq.setQueuePaused(true)
    jq.registerExecutor('script-only', async () => {})
    const job = jq.enqueue({
      project_slug: project.slug, type: 'script-only', episode_id: 'DELETE_ONLY', title: 'terminal', params: {},
    })

    try {
      const activeDelete = await request(app).delete(`/api/projects/${project.slug}/jobs/${job.job_id}`)
      assert.equal(activeDelete.status, 409)
      assert.equal(jq.getJob(job.job_id)?.status, 'queued')

      const wrongCancel = await request(app).post(`/api/projects/${wrongProject.slug}/jobs/${job.job_id}/cancel`)
      assert.equal(wrongCancel.status, 404)
      assert.equal(jq.getJob(job.job_id)?.status, 'queued')

      const wrongDelete = await request(app).delete(`/api/projects/${wrongProject.slug}/jobs/${job.job_id}`)
      assert.equal(wrongDelete.status, 404)
      assert.equal(jq.getJob(job.job_id)?.status, 'queued')

      const cancel = await request(app).post(`/api/projects/${project.slug}/jobs/${job.job_id}/cancel`)
      assert.equal(cancel.status, 200)
      assert.equal(cancel.body.job.status, 'cancelled')

      const terminalCancel = await request(app).post(`/api/projects/${project.slug}/jobs/${job.job_id}/cancel`)
      assert.equal(terminalCancel.status, 409)
      assert.equal(terminalCancel.body.control.action, 'clear-history')
      assert.equal(typeof terminalCancel.body.detail, 'string')

      const remove = await request(app).delete(`/api/projects/${project.slug}/jobs/${job.job_id}`)
      assert.equal(remove.status, 200)
      assert.equal(jq.getJob(job.job_id), null)
      assert.equal(await fs.readFile(output, 'utf8'), 'generated output stays')
    } finally {
      await jq.setQueuePaused(false)
    }
  })

  test('universal routes use the same POST-cancel and terminal-DELETE semantics', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', jobsRouter)
    const project = await pm.createProject({ name: 'UniversalCancellationParity' })
    await jq.setQueuePaused(true)
    const job = jq.enqueue({
      project_slug: project.slug, type: 'script-only', episode_id: 'UNIVERSAL_DELETE', title: 'universal', params: {},
    })
    try {
      const cancel = await request(app).post(`/api/jobs/all/${job.job_id}/cancel`)
      assert.equal(cancel.status, 200)
      assert.equal(cancel.body.job.status, 'cancelled')
      const remove = await request(app).delete(`/api/jobs/all/${job.job_id}`)
      assert.equal(remove.status, 200)
      assert.equal(jq.getJob(job.job_id), null)
    } finally {
      await jq.setQueuePaused(false)
    }
  })

  test('refuses remote work that GenStudio no longer marks cancellable', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', jobsRouter)
    const project = await pm.createProject({ name: 'RemoteCancellationTooLate' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    const job = jq.enqueue({
      project_slug: project.slug, type: 'audio', episode_id: 'REMOTE_TOO_LATE', title: 'remote', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'already-started', operation: 'voice.tts', state: 'running', cancellable: false,
      updated_at: new Date().toISOString(),
    })
    try {
      const response = await request(app).post(`/api/projects/${project.slug}/jobs/${job.job_id}/cancel`)
      assert.equal(response.status, 409)
      assert.equal(response.body.code, 'PROVIDER_WORK_ALREADY_STARTED')
      assert.equal(response.body.control.action, 'pause-submissions')
      assert.equal(typeof response.body.detail, 'string')
    } finally {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'already-started', operation: 'voice.tts', state: 'succeeded', cancellable: false,
        updated_at: new Date().toISOString(),
      })
      release()
      await waitForTerminal(job.job_id)
    }
  })
})
