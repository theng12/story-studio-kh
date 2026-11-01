/**
 * Cancelling a RUNNING job stops it, and never queues another attempt.
 *
 * Production, 2026-11-01: `POST /jobs/all/7fe81a60/cancel` on a running
 * `continuity_render` answered `ok`, but the row went on saying "Auto-retrying
 * in 60s" — only `/abandon` stopped it. The cancel wrote the provider
 * cancellation intent and left the job `running`, so the automatic-retry
 * promise stayed standing and the retry loop was free to fire again.
 *
 * The provider settlement rules are unchanged: a task the Gateway can still
 * stop is asked to stop, and the job waits for the Gateway's own answer before
 * it settles. What changed is that the owner asking for this job to stop is
 * final — no automatic attempt follows, on any cancel path.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { sleep, waitFor } from './_timing.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { registerAllExecutors } from '../boot/executors.js'

/**
 * The Gateway as 0.2.92 publishes it: the task is `dispatched` and
 * `cancellable: true`, the cancel POST is honoured, and the task reads
 * `cancelled` from then on.
 */
class FakeGateway {
  private server = http.createServer((req, res) => this.handle(req, res))
  baseUrl = ''
  cancelPosts: string[] = []
  /** The control-plane resource each operation is published under. */
  private n = 0

  async start(): Promise<this> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('did not bind a port')
    this.baseUrl = `http://127.0.0.1:${address.port}`
    return this
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    this.server.closeAllConnections?.()
    this.server.close()
    await once(this.server, 'close')
  }

  reset(): void {
    this.cancelPosts = []
    this.n = 0
  }

  private envelope(id: string, cancelled: boolean): Record<string, unknown> {
    const state = cancelled ? 'cancelled' : 'running'
    return {
      id,
      state,
      model_id: 'fake-model',
      dispatch_state: 'dispatched',
      cancellable: !cancelled,
      cancellation_requested: cancelled,
      cancelled,
      waiting: null,
      poll_after_ms: 50,
      ...(cancelled ? { failure_code: 'CANCELLED', failure_class: 'cancelled', failure_reason: 'The job was cancelled.' } : {}),
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', 'http://fake')
    const send = (status: number, body: unknown): void => {
      const payload = Buffer.from(JSON.stringify(body))
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) })
      res.end(payload)
    }
    const drain = (): Promise<void> => new Promise(resolve => { req.on('data', () => {}); req.on('end', () => resolve()) })
    void (async () => {
      await drain()
      const method = req.method || 'GET'
      const match = url.pathname.match(/^\/v1\/(?:images|jobs)\/([^/]+?)(\/cancel)?$/)
      if (!match) return send(404, { detail: 'not found', code: 'JOB_NOT_FOUND' })
      const id = match[1]!
      if (method === 'POST' && match[2]) {
        this.cancelPosts.push(id)
        return send(200, this.envelope(id, true))
      }
      if (method === 'GET') return send(200, this.envelope(id, this.cancelPosts.includes(id)))
      send(404, { detail: 'not found', code: 'JOB_NOT_FOUND' })
    })()
  }
}

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let gateway: FakeGateway

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  gateway = await new FakeGateway().start()
  await setGenStudioUrl(gateway.baseUrl)
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'gsk_test_key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  registerAllExecutors({ loadSettings: false })
})

after(async () => {
  await gateway.close()
  await sleep(300)
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  await cleanup()
})

async function until(check: () => boolean, label: string, timeoutMs = 9_000): Promise<void> {
  await waitFor(check, { label, timeoutMs })
}

/** One provider task the Gateway still holds and can still stop. */
async function recordCancellableTask(jobId: string, id: string): Promise<void> {
  await jq.recordGenStudioJob(jobId, {
    id, operation: 'image.generation', state: 'running', dispatch_state: 'dispatched',
    cancellable: true, updated_at: new Date().toISOString(),
  })
}

describe('cancelling a running job', () => {
  test('stops it, keeps the provider settlement rules, and never queues another attempt', async () => {
    gateway.reset()
    const project = await pm.createProject({ name: 'CancelRunning' })

    let executorRuns = 0
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('continuity_render', async () => {
      executorRuns++
      await hold
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'continuity_render', episode_id: 'EP001', title: 'render',
      params: { model: 'studio-hub::image/free-model' },
    })
    await until(() => jq.getJob(job.job_id)?.status === 'running', 'the job to start')
    await recordCancellableTask(job.job_id, 'img-1')

    const requested = await jq.requestJobCancellation(project.slug, job.job_id)
    assert.equal(requested.status, 'running', 'the Story job waits for the Gateway to confirm')

    // The card must not promise another automatic attempt.
    const live = jq.getJob(job.job_id)!
    assert.equal(live.auto_retry?.eligible, false, 'a cancelled job does not auto-retry')
    assert.equal(live.auto_retry?.next_retry_at, undefined, 'and promises no next attempt')

    await until(() => gateway.cancelPosts.length > 0, 'the cancel to reach the Gateway')
    await until(() => Object.values(jq.getJob(job.job_id)?.remote_cancellations || {})[0]?.status === 'confirmed',
      'the Gateway to confirm the cancellation')

    release()
    await until(() => ['cancelled', 'error', 'done'].includes(jq.getJob(job.job_id)?.status || ''), 'the job to settle')

    const final = jq.getJob(job.job_id)!
    assert.equal(final.status, 'cancelled', `ended ${final.status}: ${final.error ?? ''}`)
    assert.equal(final.error, null)
    assert.equal(gateway.cancelPosts.length, 1, 'exactly one cancel request')
    assert.equal(final.auto_retry?.eligible, false, 'it still promises no automatic attempt')

    await sleep(300)
    assert.equal(executorRuns, 1, 'the cancelled job never ran a second time')
  })

  test('the retry backoff is interrupted, so no attempt runs after the cancel', async () => {
    gateway.reset()
    const { _setJobAutoRetryDelaysForTesting } = await import('../services/job-retry-policy.js')
    // Compress the SCHEDULE only, never the policy: the assertion is about
    // WHAT happens after the cancel, not about how long the wait was.
    _setJobAutoRetryDelaysForTesting(5_000)
    const project = await pm.createProject({ name: 'CancelDuringRetry' })

    let executorRuns = 0
    jq.registerExecutor('continuity_render', async () => {
      executorRuns++
      // A free-fleet render is eligible for automatic retry, so the first
      // attempt schedules one.
      if (executorRuns === 1) throw new Error('the Gateway was busy')
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'continuity_render', episode_id: 'EP002', title: 'render',
      params: { model: 'studio-hub::image/free-model' },
    })
    await until(() => jq.getJob(job.job_id)?.status === 'running', 'the job to start')
    await until(() => Boolean(jq.getJob(job.job_id)?.auto_retry?.next_retry_at), 'the automatic retry to be scheduled')
    await recordCancellableTask(job.job_id, 'img-2')

    // The owner cancels while the job waits for its next attempt.
    await jq.requestJobCancellation(project.slug, job.job_id)

    const cancelled = jq.getJob(job.job_id)!
    assert.equal(cancelled.auto_retry?.eligible, false, 'no automatic attempt is promised')
    assert.equal(cancelled.auto_retry?.next_retry_at, undefined, 'and no next attempt is scheduled')
    assert.equal(cancelled.output_lines.some(line => /withdrawn/.test(line)), true, 'the log says the attempt was withdrawn')
    assert.equal(/Auto-retrying/.test(cancelled.output_lines.slice(-1)[0]!), false, 'the log does not end on a retry promise')

    // The backoff is interrupted rather than carried out.
    await sleep(1_000)
    assert.equal(executorRuns, 1, 'the cancelled job never ran again')
    assert.equal(jq.getJob(job.job_id)?.auto_retry?.next_retry_at, undefined, 'and no attempt is scheduled after the cancel')
    _setJobAutoRetryDelaysForTesting(null)
  })

  test('a cancel before submission also withdraws the automatic retry promise', async () => {
    const project = await pm.createProject({ name: 'CancelQueued' })
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    try {
      const job = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: 'EP003', title: 'render',
        params: { model: 'studio-hub::image/free-model' },
      })
      const requested = await jq.requestJobCancellation(project.slug, job.job_id)
      assert.equal(requested.status, 'cancelled')
      assert.equal(requested.auto_retry?.eligible, false, 'a cancelled job does not auto-retry')
    } finally {
      if (!wasPaused) await jq.setQueuePaused(false)
    }
  })
})
