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

    const first = await jq.requestJobCancellation(proj.slug, job.job_id)
    const second = await jq.requestJobCancellation(proj.slug, job.job_id)
    const key = 'voice.tts:tts-target-1'
    assert.equal(first.status, 'running')
    assert.equal(first.finished_at, null)
    assert.equal(first.remote_cancellations?.[key]?.status, 'queued')
    assert.deepEqual(Object.keys(second.remote_cancellations || {}), [key])

    release()
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

      const cancel = await request(app).post(`/api/projects/${project.slug}/jobs/${job.job_id}/cancel`)
      assert.equal(cancel.status, 200)
      assert.equal(cancel.body.job.status, 'cancelled')

      const remove = await request(app).delete(`/api/projects/${project.slug}/jobs/${job.job_id}`)
      assert.equal(remove.status, 200)
      assert.equal(jq.getJob(job.job_id), null)
      assert.equal(await fs.readFile(output, 'utf8'), 'generated output stays')
    } finally {
      await jq.setQueuePaused(false)
    }
  })
})
