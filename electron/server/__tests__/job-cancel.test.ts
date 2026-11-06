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
import { waitForValue } from './_timing.js'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { router as jobsRouter } from '../routes/jobs.js'
import { registerJobCancellationAuditor } from '../services/job-cancellation-auditors.js'

// An idle stand-in for ffmpeg. It runs without the test harness's NODE_OPTIONS preloads: a SIGTERM that
// lands while a preload is still starting kills it before it can write its evidence record, which fails the
// whole gate although every test passed (1.4.353 gate A). It touches no files, so it has nothing to record.
const idleChild = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, NODE_OPTIONS: '' } })

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

/**
 * Tear down without pulling the claim out from under work still in flight.
 *
 * The cancellation lane finishes its bookkeeping AFTER the request that
 * started it returns — deliberately, so a slow project cannot freeze the UI.
 * `useTempDataDir().cleanup` unsets STORY_STUDIO_DATA_DIR, so a persist that
 * lands a moment later fails the job-queue isolation guard, arrives as an
 * unhandled rejection, and fails the whole FILE. Nine to eleven per run.
 *
 * None of that is a production bug, and none of it was visible while the
 * harness passed `--test-force-exit`: the process was killed before those
 * writes could land. Removing that flag — it was silently truncating results
 * — made an existing hygiene defect visible, which is the point of removing it.
 *
 * So: let the lane settle, then delete the directory but KEEP the claim for
 * the moments of process life that remain. Each test file runs in its own
 * child process, so the claim cannot leak anywhere, and a straggling write is
 * judged against the directory it was always writing to. `cleanup` is
 * deliberately not called: unsetting the claim is the only part that hurts.
 */
after(async () => {
  for (let i = 0; i < 25; i++) await new Promise(resolve => setTimeout(resolve, 20))
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
})

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
        const child = idleChild()
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

    const job = jq.enqueuePreparedForTest({
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
      const child = idleChild()
      jq.trackChild(child)
      await new Promise<void>((_, reject) => {
        child.on('exit', (code, signal) => {
          if (signal === 'SIGTERM') reject(new Error('Killed by SIGTERM'))
          else reject(new Error(`child exited with code ${code}`))
        })
      })
    })

    const job = jq.enqueuePreparedForTest({
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
        const child = idleChild()
        jq.trackChild(child)
        await new Promise<void>((_, reject) => {
          child.on('exit', () => reject(new Error('Killed')))
        })
      })

      const job = jq.enqueuePreparedForTest({
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
    jq.registerExecutor('chapter-only', async () => {
      await new Promise(() => {}) // never resolves — we don't cancel this one
    })

    jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'chapter-only', episode_id: 'DEDUPE_1',
      title: 'a', params: {},
    })
    await new Promise((r) => setTimeout(r, 50))

    assert.throws(
      () => jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'chapter-only', episode_id: 'DEDUPE_1',
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
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    let entered = false

    jq.registerExecutor('video_assembly', async () => {
      entered = true
      await hold
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'video_assembly', episode_id: 'ISC_1',
      title: 't', params: {},
    })
    try {
      await waitForValue(
        () => entered ? true : undefined,
        { label: 'isCancelled executor entry', timeoutMs: 2_000 },
      )
      assert.equal(jq.isCancelled(job.job_id), false)
      await jq.requestJobCancellation(proj.slug, job.job_id)
      assert.equal(jq.isCancelled(job.job_id), true)
    } finally {
      release()
      await waitForValue(
        () => jq.getJob(job.job_id)?.local_execution_complete === true
          ? jq.getJob(job.job_id)
          : undefined,
        { label: 'isCancelled executor to complete its local execution', timeoutMs: 2_000 },
      )
    }
  })
})

describe('remote cancellation checkpoints', () => {
  test('queues each eligible Gateway target once and keeps the Story job running', async () => {
    const proj = await pm.createProject({ name: 'RemoteCancellationTargets' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')

    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'audio', episode_id: 'REMOTE_CANCEL', title: 'remote', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(job.job_id)?.status, 'running')
    await jq.recordGenStudioJob(job.job_id, {
      id: 'tts-target-1', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.recordGenStudioJob(job.job_id, {
      id: 'tts-target-2', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
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

  test('a remote cancel of running narration tells the executor to stop launching more work', async () => {
    const proj = await pm.createProject({ name: 'RemoteCancelStopsExecutor' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')
    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'audio', episode_id: 'REMOTE_STOPS', title: 'remote', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'tts-running-1', operation: 'voice.tts', state: 'running', dispatch_state: 'dispatched', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    assert.equal(jq.isCancelled(job.job_id), false)
    const requested = await jq.requestJobCancellation(proj.slug, job.job_id)
    assert.equal(requested.status, 'running', 'the Story job waits for the Gateway to confirm')
    assert.equal(jq.isCancelled(job.job_id), true, 'but its generator must not submit the next chunk')
    release()
  })

  test('claims each remote target once and read-only terminal evidence releases a crashed submitting record', async () => {
    const project = await pm.createProject({ name: 'ClaimOnceAndReconcile' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'CLAIM_ONCE', title: 'claim once', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'claim-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
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
      state: 'succeeded',
    })
    assert.equal(jq.getJob(job.job_id)?.remote_cancellations?.['voice.tts:claim-target']?.status, 'rejected')
    release()
  })

  test('persists Gateway dispatch and settlement evidence from a settled cancellation update', async () => {
    const project = await pm.createProject({ name: 'CancellationSettlementEvidence' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'SETTLEMENT', title: 'settlement', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'settlement-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)
    await jq.reconcileRemoteCancellationFromProvider(job.job_id, 'voice.tts', 'settlement-target', {
      state: 'failed',
      dispatch_state: 'pre_dispatch',
      // Gateway may still publish settlement alongside the outcome; Story's cancellation
      // evidence no longer stores any of it.
      reserved_credits: 13,
      settled_credits: 0,
      released_credits: 13,
      cancelled: true,
    } as any)
    const evidence = jq.getJob(job.job_id)?.remote_cancellations?.['voice.tts:settlement-target']
    release()
    assert.deepEqual(
      {
        status: evidence?.status,
        dispatch_state: evidence?.dispatch_state,
        cancelled: evidence?.cancelled,
        reserved_credits: evidence?.reserved_credits,
        settled_credits: evidence?.settled_credits,
        released_credits: evidence?.released_credits,
      },
      {
        status: 'confirmed',
        dispatch_state: 'pre_dispatch',
        cancelled: true,
        reserved_credits: undefined,
        settled_credits: undefined,
        released_credits: undefined,
      },
    )
    for (const field of ['reserved_credits', 'settled_credits', 'released_credits'] as const) {
      assert.equal(field in (evidence ?? {}), false, `${field} must be omitted, not stored as a figure`)
    }
  })

  for (const scenario of [
    { type: 'audio', repairable: true },
    { type: 'research_run', repairable: false },
  ] as const) {
    test(`does not terminalize while an excluded accepted provider sibling still settles (${scenario.type})`, async () => {
      const project = await pm.createProject({ name: `AllProviderTargetsMustSettle ${scenario.type}` })
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      jq.registerExecutor(scenario.type, async () => await hold)
      registerJobCancellationAuditor(scenario.type, async () => 'complete')
      const job = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: scenario.type, episode_id: 'ALL_TARGETS', title: 'all targets', params: {},
      })
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await jq.recordGenStudioJob(job.job_id, {
        id: 'eligible-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
        updated_at: new Date().toISOString(),
      })
      await jq.recordGenStudioJob(job.job_id, {
        id: 'already-running-sibling', operation: 'voice.tts', state: 'running', dispatch_state: 'dispatched', cancellable: false,
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
      if (scenario.repairable) {
        assert.match(final.error || '', /Repair missing output before Retry/)
        assert.deepEqual(final.result, { provider_settled: 'mixed', repair_required: true })
      } else {
        // Research has no Repair action on the Jobs page, so the row must not promise one.
        assert.doesNotMatch(final.error || '', /Repair missing output before Retry/)
        assert.match(final.error || '', /This step has no Repair action, so Retry runs it again/)
        assert.deepEqual(final.result, { provider_settled: 'mixed' })
      }
    })
  }

  test('provider settlement chooses cancelled, error, or audited repair outcomes after local work returns', async () => {
    const settle = async (episode: string, state: 'failed' | 'succeeded', cancelled = false) => {
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      jq.registerExecutor('audio', async () => await hold)
      const project = await pm.createProject({ name: `ProviderFinal-${episode}` })
      const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: episode, title: episode, params: {} })
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
      await jq.recordGenStudioJob(job.job_id, {
        id: `${episode}-target`, operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
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
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'FINAL_ONCE', title: 'final once',
      params: { pipeline_chain: [{ type: 'broll_assemble', title: 'next local assembly', params: {} }] },
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
    for (const id of ['first', 'second']) {
      await jq.recordGenStudioJob(job.job_id, { id, operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, updated_at: new Date().toISOString() })
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
    // The parent's terminal status becomes visible in memory before the durable
    // pipeline handoff dispatches the child. Waiting for `status !== 'running'`
    // can therefore race the child's creation; wait for the child itself to
    // appear and finish, which is what this assertion actually pins.
    await waitForValue(
      async () => {
        const rows = await jq.getJobs(project.slug)
        const child = rows.find(candidate => candidate.type === 'broll_assemble')
        return child && child.status === 'done' ? child : undefined
      },
      { label: 'the chained broll_assemble child to finish', timeoutMs: 2_000 },
    )
    assert.equal(jq.getJob(job.job_id)?.status, 'done')
    assert.equal(audits, 1)
    assert.equal((await jq.getJobs(project.slug)).filter(candidate => candidate.type === 'broll_assemble').length, 1)
    registerJobCancellationAuditor('audio', async () => 'complete')
  })

  test('a locally-completed job whose executor declared nothing is failed when its auditor finds output missing', async () => {
    // Group 1.1a. The success path called only `assertJobDidNotDeclareIncomplete`,
    // which fires solely when the executor itself set `result.complete === false`.
    // An executor that audits nothing passed untouched, so a job could report
    // `done` over missing output and turn a Production Board cell green.
    //
    // This is the LOCAL completion path — no provider work, so the settlement
    // path (which audits, and which `simultaneous final provider updates…` pins
    // to exactly once) never runs for it. Re-reading the artifacts is the only
    // thing that can catch it.
    const project = await pm.createProject({ name: 'LocalCompletionAudit' })
    jq.registerExecutor('audio', async () => { /* returns normally, declares nothing */ })
    registerJobCancellationAuditor('audio', async () => 'repair-required')
    try {
      const job = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'audio', episode_id: 'LOCAL_AUDIT', title: 'local audit', params: {},
      })
      // `waitForValue`, not a fixed-ms poll: the suite forbids a new
      // `setTimeout` followed by an assertion (see no-new-wallclock-sleeps), and
      // it is right to — a fixed sleep asserts that this machine schedules
      // promptly, which stops being true under load.
      const settled = await waitForValue(
        () => {
          const current = jq.getJob(job.job_id)
          return current && current.status !== 'running' ? current : undefined
        },
        { label: 'the locally-completed job to settle', timeoutMs: 2_000 },
      )
      assert.notEqual(settled.status, 'done',
        'a job whose own auditor finds the output missing must not be reported as done')
      assert.equal(settled.status, 'error')
    } finally {
      registerJobCancellationAuditor('audio', async () => 'complete')
    }
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

    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'PENDING_CANCEL', title: 'pending', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'pending-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
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

    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'PENDING_CANCEL_FAILURE', title: 'pending failure', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'pending-failure-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
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

    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'PENDING_CANCEL_PAUSE', title: 'pending pause', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'pending-pause-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)
    await jq.pauseJob(job.job_id)

    release()
    await paused
    await new Promise(resolve => setTimeout(resolve, 30))

    const pending = jq.getJob(job.job_id)
    const publicPending = jq.getPublicJob(job.job_id)
    assert.equal(pending?.status, 'running')
    assert.equal(pending?.finished_at, null)
    assert.equal(publicPending?.control?.action, 'return-later')
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
    const job = jq.enqueuePreparedForTest({
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
    const job = jq.enqueuePreparedForTest({
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
    const job = jq.enqueuePreparedForTest({
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

  test('scene image Pause stops the next item without requesting provider cancellation', async () => {
    const project = await pm.createProject({ name: 'SceneImageCooperativePause' })
    let release!: () => void
    let firstStarted!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { firstStarted = resolve })
    let submitted = 0
    jq.registerExecutor('continuity_render', async job => {
      submitted++
      firstStarted()
      await hold
      jq.throwIfPauseRequested(job.job_id)
      submitted++
    })
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'continuity_render', episode_id: 'PAUSE_IMAGES', title: 'pause images', params: {},
    })
    await started
    const pausedRequest = await jq.pauseJob(job.job_id)
    assert.equal(pausedRequest?.pause_requested, true)
    assert.deepEqual(pausedRequest?.remote_cancellations || {}, {})
    release()
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'paused') await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jq.getJob(job.job_id)?.status, 'paused')
    assert.equal(submitted, 1)
    assert.equal(jq.isDuplicate(project.slug, 'PAUSE_IMAGES', 'continuity_render'), true)
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
      return Response.json({ id: 'live-success-target', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false })
    }
    jq.registerExecutor('audio', async () => {
      await hold
      outputCreated = true
    })
    registerJobCancellationAuditor('audio', async () => {
      audits++
      return outputCreated ? 'complete' : 'repair-required'
    })
    const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: 'LIVE_SUCCESS', title: 'live success', params: {} })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
    await jq.recordGenStudioJob(job.job_id, { id: 'live-success-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, updated_at: new Date().toISOString() })
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
      return Response.json({ id: 'live-cancel-target', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false })
    }
    jq.registerExecutor('audio', async () => await hold)
    const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: 'LIVE_CANCEL', title: 'live', params: {} })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
    await jq.recordGenStudioJob(job.job_id, { id: 'live-cancel-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, updated_at: new Date().toISOString() })
    try {
      await jq.requestJobCancellation(project.slug, job.job_id)
      const reconcileDeadline = Date.now() + 1_000
      const ownRequests = () => requests.filter(entry => entry.includes('/live-cancel-target'))
      while (Date.now() < reconcileDeadline && ownRequests().length < 2) await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(ownRequests(), [
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
      genstudio_jobs: [{ id: 'accepted-tts', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, updated_at: new Date().toISOString() }],
    }] }))
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const originalFetch = globalThis.fetch
    const requests: Array<{ method: string; path: string }> = []
    globalThis.fetch = async (input, init) => {
      const requestPath = new URL(String(input)).pathname
      requests.push({ method: (init?.method || 'GET').toUpperCase(), path: requestPath })
      if (requestPath === '/v1/jobs/accepted-tts') return Response.json({ id: 'accepted-tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false })
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
      const ownRequests = () => requests.filter(entry => entry.path.includes('/accepted-tts'))
      while (Date.now() < reconcileDeadline && ownRequests().length < 2) await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(ownRequests(), [
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
      const queued = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: `EP_${scenario}`, title: scenario, params: {} })
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && jq.getJob(queued.job_id)?.status !== 'running') await new Promise(resolve => setTimeout(resolve, 20))
      await jq.recordGenStudioJob(queued.job_id, { id: 'live-target', operation: 'voice.tts', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, updated_at: new Date().toISOString() })
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
    jq.registerExecutor('chapter-only', async () => {})
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'chapter-only', episode_id: 'DELETE_ONLY', title: 'terminal', params: {},
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
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'chapter-only', episode_id: 'UNIVERSAL_DELETE', title: 'universal', params: {},
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

  test('refuses remote work that Gateway no longer marks cancellable', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', jobsRouter)
    const project = await pm.createProject({ name: 'RemoteCancellationTooLate' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'REMOTE_TOO_LATE', title: 'remote', params: {},
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await jq.recordGenStudioJob(job.job_id, {
      id: 'already-started', operation: 'voice.tts', state: 'running', dispatch_state: 'dispatched', cancellable: false,
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

describe('cancelled history cleanup waits for a live worker to return', () => {
  const labels = {
    remove: 'local stop + remove',
    clear: 'local stop + clear',
    retry: 'local stop + retry',
    'abandon-remove': 'force abandon + remove',
  } as const

  for (const outcome of ['return', 'throw', 'paid-wait'] as const) {
    for (const retirement of ['remove', 'clear', 'retry', 'abandon-remove'] as const) {
      test(`keeps the cancellation flag through a ${outcome} worker for ${labels[retirement]}`, async () => {
      const project = await pm.createProject({ name: `HeldCancellation-${outcome}-${retirement}` })
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      let originalEntered = false
      let originalId = ''
      let followOnWork = 0
      let nonOriginalRuns = 0
      let checkpointFlag: boolean | undefined
      let flagWhileHeld: boolean | undefined
      let replacement: ReturnType<typeof jq.retryTerminalJob> | undefined

      jq.registerExecutor('video_assembly', async job => {
        if (job.job_id !== originalId) {
          nonOriginalRuns++
          return
        }
        originalEntered = true
        await hold
        checkpointFlag = jq.isCancelled(job.job_id)
        if (!checkpointFlag) followOnWork++
        if (outcome === 'throw') throw new Error('late cancelled worker')
        if (outcome === 'paid-wait') return { kind: 'paid-image-wait' }
      })

      await jq.setQueuePaused(true)
      const original = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'video_assembly',
        episode_id: `HELD_${retirement}`,
        title: retirement,
        params: {},
      })
      originalId = original.job_id

      try {
        await jq.setQueuePaused(false)
        await waitForValue(
          () => originalEntered ? true : undefined,
          { label: `the ${retirement} original executor to enter`, timeoutMs: 2_000 },
        )
        await jq.setQueuePaused(true)

        if (retirement === 'abandon-remove') {
          await jq.forceAbandonJob(project.slug, original.job_id)
        } else {
          await jq.requestJobCancellation(project.slug, original.job_id)
        }

        if (retirement === 'remove' || retirement === 'abandon-remove') {
          assert.equal(jq.removeTerminalJob(project.slug, original.job_id), true)
        } else if (retirement === 'clear') {
          assert.equal(await jq.clearFinished(project.slug), 1)
        } else {
          assert.throws(
            () => jq.retryTerminalJob(project.slug, original.job_id),
            (error: any) => {
              assert.equal(error.status, 409)
              assert.match(error.message, /still finishing locally|worker|stopping/i)
              return true
            },
            'Retry must be refused while the cancelled worker is still settling',
          )
        }
        flagWhileHeld = jq.isCancelled(original.job_id)

        const marker = jq.enqueuePreparedForTest({
          project_slug: project.slug,
          type: 'video_assembly',
          episode_id: `HELD_MARKER_${retirement}`,
          title: 'marker',
          params: {},
        })

        release()
        await waitForValue(
          () => !jq._isJobWorkerActiveForTesting(original.job_id) ? true : undefined,
          { label: `the ${retirement} original worker to settle`, timeoutMs: 2_000 },
        )
        if (retirement === 'retry') {
          replacement = jq.retryTerminalJob(project.slug, original.job_id)
        }
        await jq.setQueuePaused(false)
        await waitForValue(
          () => jq.getJob(marker.job_id)?.status === 'done' ? jq.getJob(marker.job_id) : undefined,
          { label: `the ${retirement} marker to finish`, timeoutMs: 2_000 },
        )
        if (replacement) {
          await waitForValue(
            () => jq.getJob(replacement!.job_id)?.status === 'done' ? jq.getJob(replacement!.job_id) : undefined,
            { label: `the ${retirement} retry replacement to finish`, timeoutMs: 2_000 },
          )
        }

        assert.equal(flagWhileHeld, true, 'retiring history must not clear a live worker\'s flag')
        assert.equal(checkpointFlag, true, 'the worker must still observe cancellation at its checkpoint')
        assert.equal(followOnWork, 0, 'cancelled work must not continue after its held executor resumes')
        assert.equal(nonOriginalRuns, replacement ? 2 : 1,
          'only the replacement and marker may run after the original worker leaves')
        assert.equal(jq.getJob(original.job_id), null, 'the retired original row must not reappear')
        assert.equal(jq.isCancelled(original.job_id), false, 'the retired original flag is cleared after worker exit')
        if (replacement) {
          assert.equal(jq.isCancelled(replacement.job_id), false, 'Retry replacement must be uncancelled')
        }
        await jq._waitForJobPersistenceForTesting()
        const disk = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'jobs.json'), 'utf8'))
        assert.equal(
          disk.jobs.some((candidate: { job_id: string }) => candidate.job_id === original.job_id),
          false,
          'the retired original row must stay absent from jobs.json',
        )
      } finally {
        release()
        await jq.setQueuePaused(false)
      }
      })
    }
  }
})

test('rejects deterministic episode-recovery ID reuse until the retired worker exits', async () => {
  const project = await pm.createProject({ name: 'RecoveryIdReuseWhileActive' })
  const originalId = 'recovery-held-worker'
  const originalOptions = {
    project_slug: project.slug,
    episode_id: 'RECOVERYHELD1',
    type: 'video_assembly' as const,
    params: { episode_recovery_id: 'recovery-held-plan' },
  }
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let originalEntered = false
  let originalRuns = 0
  let reusedUncancelled = false
  let markerRuns = 0

  jq.registerExecutor('video_assembly', async job => {
    if (job.job_id === originalId) {
      originalRuns++
      if (originalRuns === 1) {
        originalEntered = true
        await hold
        assert.equal(jq.isCancelled(job.job_id), true, 'the retired worker remains cancelled while held')
        return
      }
      reusedUncancelled = !jq.isCancelled(job.job_id)
      return
    }
    markerRuns++
  })

  await jq.setQueuePaused(true)
  try {
    const original = await jq.enqueueEpisodeRecoveryOnce(originalId, originalOptions)
    await jq.setQueuePaused(false)
    await waitForValue(
      () => originalEntered ? true : undefined,
      { label: 'the deterministic recovery worker to enter', timeoutMs: 2_000 },
    )
    await jq.setQueuePaused(true)

    await jq.requestJobCancellation(project.slug, original.job_id)
    assert.equal(jq.removeTerminalJob(project.slug, original.job_id), true)
    assert.equal(jq.getJob(originalId), null)
    assert.equal(jq.isCancelled(originalId), true)
    await assert.rejects(
      () => jq.enqueueEpisodeRecoveryOnce(originalId, originalOptions),
      (error: any) => {
        assert.equal(error.status, 409)
        assert.match(error.message, /still finishing locally|worker|stopping/i)
        return true
      },
    )
    assert.equal(jq.getJob(originalId), null)
    assert.equal(jq.isCancelled(originalId), true)

    const markerId = 'recovery-held-marker'
    const marker = await jq.enqueueEpisodeRecoveryOnce(markerId, {
      ...originalOptions,
      episode_id: 'RECOVERYHELDMARKER1',
      params: { episode_recovery_id: 'recovery-held-marker-plan' },
    })
    release()
    await jq.setQueuePaused(false)
    await waitForValue(
      () => jq.getJob(marker.job_id)?.status === 'done' ? jq.getJob(marker.job_id) : undefined,
      { label: 'the different-ID recovery marker to finish', timeoutMs: 2_000 },
    )
    assert.equal(markerRuns, 1)

    const reused = await jq.enqueueEpisodeRecoveryOnce(originalId, originalOptions)
    await waitForValue(
      () => jq.getJob(reused.job_id)?.status === 'done' ? jq.getJob(reused.job_id) : undefined,
      { label: 'the reused recovery ID to finish', timeoutMs: 2_000 },
    )
    assert.equal(reused.job_id, originalId)
    assert.equal(reusedUncancelled, true)
    assert.equal(jq.isCancelled(originalId), false)
  } finally {
    release()
    await jq.setQueuePaused(false)
  }
})

test('Finish missing images cannot clear an active worker cancellation flag', async () => {
  const project = await pm.createProject({ name: 'FinishMissingImagesActiveWorker' })
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let entered = false
  let releasedJobId: string | undefined
  let stopObserving: (() => void) | undefined

  jq.registerExecutor('continuity_render', async () => {
    entered = true
    await hold
  })

  await jq.setQueuePaused(true)
  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'continuity_render',
    episode_id: 'FINISH_MISSING_ACTIVE',
    title: 'active finish missing images',
    params: { model: 'mock-image' },
  })

  try {
    await jq.setQueuePaused(false)
    await waitForValue(
      () => entered ? true : undefined,
      { label: 'the active Finish missing images worker to enter', timeoutMs: 2_000 },
    )
    await jq.setQueuePaused(true)
    await jq.forceAbandonJob(project.slug, job.job_id)
    assert.equal(jq.isCancelled(job.job_id), true)

    await assert.rejects(
      () => jq.finishMissingImagesInPlace(project.slug, job.job_id),
      (error: any) => {
        assert.equal(error.status, 409)
        assert.match(error.message, /worker|active|stopping/i)
        return true
      },
    )
    assert.equal(jq.getJob(job.job_id)?.status, 'cancelled')
    assert.equal(jq.getJob(job.job_id)?.params.jobs_finish_missing_images, undefined)
    assert.equal(jq.isCancelled(job.job_id), true)

    stopObserving = jq._observeQueuePumpsForTesting((type, releasedJobIdForType) => {
      if (type === 'continuity_render' && releasedJobIdForType === job.job_id) {
        releasedJobId = releasedJobIdForType
      }
    })
    release()
    await waitForValue(
      () => releasedJobId === job.job_id ? releasedJobId : undefined,
      { label: 'the abandoned continuity worker to release its lane', timeoutMs: 2_000 },
    )

    const queued = await jq.finishMissingImagesInPlace(project.slug, job.job_id)
    assert.equal(queued.reused, false)
    assert.equal(queued.job.job_id, job.job_id)
    assert.equal(queued.job.status, 'queued')
    assert.equal(jq.isCancelled(job.job_id), false)

    await jq.forceAbandonJob(project.slug, job.job_id)
  } finally {
    release()
    stopObserving?.()
    await jq.setQueuePaused(false)
  }
})

/**
 * The `cancelled` set used to grow for the life of the process: three paths
 * added to it, and exactly one removed from it (the "Finish missing images"
 * re-queue). A one-line "delete it when the status is cancelled" would be
 * WRONG — the flag is what stops an in-flight executor and what stops the queue
 * re-pumping the job — so rows with no active worker may retire immediately,
 * while an active worker retains the flag until it returns.
 */
describe('the cancelled flag is forgotten exactly when its job is', () => {
  test('a live cancelled row keeps its flag; removing, clearing, or retrying it forgets the flag', async () => {
    const project = await pm.createProject({ name: 'CancelledFlagLifecycle' })
    await jq.setQueuePaused(true)
    try {
      // (1) THE CONTROL. While the row exists the flag MUST stay.
      const kept = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'chapter-only', episode_id: 'FLAG_KEPT', title: 'kept', params: {},
      })
      await jq.requestJobCancellation(project.slug, kept.job_id)
      assert.equal(jq.getJob(kept.job_id)?.status, 'cancelled')
      assert.equal(jq.isCancelled(kept.job_id), true,
        'a cancelled row that still exists must keep its flag — it is what stops the executor and the re-queue')

      // (2) DELETE retires the row, so the id can never be consulted again.
      assert.equal(jq.removeTerminalJob(project.slug, kept.job_id), true)
      assert.equal(jq.getJob(kept.job_id), null)
      assert.equal(jq.isCancelled(kept.job_id), false, 'a removed row must not leave its id behind')

      // (3) Clearing finished history retires every row it clears.
      const cleared = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'chapter-only', episode_id: 'FLAG_CLEARED', title: 'cleared', params: {},
      })
      await jq.requestJobCancellation(project.slug, cleared.job_id)
      assert.equal(jq.isCancelled(cleared.job_id), true)
      assert.equal(await jq.clearFinished(project.slug), 1)
      assert.equal(jq.isCancelled(cleared.job_id), false, 'cleared history must not leave its ids behind')

      // (4) Retry replaces the row under a NEW id. The retired id is forgotten,
      // and the replacement — which was never cancelled — runs.
      const retried = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'chapter-only', episode_id: 'FLAG_RETRIED', title: 'retried', params: {},
      })
      await jq.requestJobCancellation(project.slug, retried.job_id)
      assert.equal(jq.isCancelled(retried.job_id), true)
      const replacement = jq.retryTerminalJob(project.slug, retried.job_id)
      assert.notEqual(replacement.job_id, retried.job_id)
      assert.equal(jq.isCancelled(retried.job_id), false, 'the retired id must not linger')
      assert.equal(jq.isCancelled(replacement.job_id), false, 'the replacement was never cancelled, so Retry runs it')
    } finally {
      await jq.setQueuePaused(false)
    }
  })
})
