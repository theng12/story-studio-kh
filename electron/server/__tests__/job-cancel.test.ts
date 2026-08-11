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
    assert.ok(keys.every(key => first.remote_cancellations?.[key]?.status === 'queued'))

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
    assert.equal(jq.getJob(job.job_id)?.status, 'done')
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
    registerJobCancellationAuditor('audio', async () => { throw new Error('disk audit offline') })
    const auditFailure = await settle('AUDIT_THREW', 'succeeded')
    assert.equal(auditFailure.status, 'running')
    assert.match(auditFailure.output_lines.join('\n'), /output audit could not run/i)
    registerJobCancellationAuditor('audio', async () => 'complete')
  })

  test('simultaneous final provider updates run the auditor and terminal transition once', async () => {
    const project = await pm.createProject({ name: 'SingleProviderFinalization' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    let audits = 0
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => { audits++; return 'complete' })
    const job = jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'FINAL_ONCE', title: 'final once', params: {} })
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
    assert.equal(pending?.remote_cancellations?.['voice.tts:pending-target']?.status, 'queued')
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
    assert.equal(pending?.remote_cancellations?.['voice.tts:pending-failure-target']?.status, 'queued')
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
    assert.equal(pending?.remote_cancellations?.['voice.tts:pending-pause-target']?.status, 'queued')
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
