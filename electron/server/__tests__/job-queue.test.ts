/**
 * Tests for job-queue: enqueue, duplicate detection, cancel, persistence.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import type { Job } from '../models/types.js'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let tempDir: string
let cleanup: () => Promise<void>
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function waitForJobStatus(jobId: string, status: string): Promise<void> {
  if (jq.getJob(jobId)?.status === status) return Promise.resolve()
  return new Promise(resolve => {
    const onUpdate = (job: { job_id: string; status: string }) => {
      if (job.job_id !== jobId || job.status !== status) return
      jq.jobEvents.off('update', onUpdate)
      resolve()
    }
    jq.jobEvents.on('update', onUpdate)
  })
}

async function assertSupersedingIntentWinsDuringQueueRelease(
  t: any,
  intent: 'manual-pause' | 'cancel',
): Promise<void> {
  const project = await pm.createProject({ name: `JQ Release Superseded ${intent}` })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  const type: Job['type'] = intent === 'manual-pause' ? 'broll_assemble' : 'youtube_playlist_update'
  await jq.getJobs(project.slug)
  const blockerStarted = deferred()
  const releaseBlocker = deferred()
  let heldRuns = 0
  jq.registerExecutor(type, async job => {
    if (job.episode_id === 'BLOCK') {
      blockerStarted.resolve()
      await releaseBlocker.promise
    } else if (job.episode_id === 'QUEUE-HOLD') {
      heldRuns += 1
    }
  })
  await jq.setQueuePaused(false)
  jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type,
    episode_id: 'BLOCK',
    title: 'occupy lane',
    params: {},
  })
  await blockerStarted.promise
  const held = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type,
    episode_id: 'QUEUE-HOLD',
    title: 'queue hold',
    params: {},
  })
  await jq.pauseJob(held.job_id, 'queue')

  const snapshotStarted = deferred()
  const releaseSnapshot = deferred()
  const originalRename = fs.rename.bind(fs)
  let blockReleaseSnapshot = true
  t.mock.method(fs, 'rename', async (from: any, to: any) => {
    if (blockReleaseSnapshot && path.resolve(String(to)) === path.resolve(jobsFile)) {
      blockReleaseSnapshot = false
      snapshotStarted.resolve()
      await releaseSnapshot.promise
    }
    return originalRename(from, to)
  })

  const release = jq.setQueuePaused(false)
  await snapshotStarted.promise
  const superseding = intent === 'manual-pause'
    ? jq.pauseJob(held.job_id, 'manual')
    : jq.requestJobCancellation(project.slug, held.job_id)
  if (intent === 'cancel') {
    for (let turn = 0; turn < 10 && jq.getJob(held.job_id)?.status === 'queued'; turn += 1) {
      await Promise.resolve()
    }
  }
  assert.equal(jq.getJob(held.job_id)?.status, intent === 'manual-pause' ? 'paused' : 'cancelled')
  releaseSnapshot.resolve()
  await Promise.all([release, superseding])

  const marker = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type,
    episode_id: 'MARKER',
    title: 'marker',
    params: {},
  })
  const markerDone = waitForJobStatus(marker.job_id, 'done')
  try {
    const listed = await jq.getJobs(project.slug)
    assert.equal(listed.find(job => job.job_id === marker.job_id)?.queue_position, 1)
    assert.equal(jq.getJob(held.job_id)?.status, intent === 'manual-pause' ? 'paused' : 'cancelled')
    if (intent === 'manual-pause') assert.equal(jq.getJob(held.job_id)?.pause_origin, 'manual')
  } finally {
    releaseSnapshot.resolve()
    releaseBlocker.resolve()
    await markerDone
  }
  assert.equal(heldRuns, 0)
}

// Note: unlike other test files, we avoid beforeEach cleanup because the
// job-queue service has module-level state (jobs Map, loaded projects) that
// persists across tests, and concurrent file writes can collide with rm.
// Each test uses a unique project name to stay isolated.

describe('enqueue()', () => {
  test('creates a job with generated UUID, status=queued', async () => {
    const proj = await pm.createProject({ name: 'JQ1' })
    // Register a no-op executor so the job doesn't actually run anything
    jq.registerExecutor('chapter-only', async () => {})
    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'chapter-only',
      episode_id: 'EP001',
      title: 'Test script',
      params: {},
    })
    assert.ok(job.job_id.length > 0)
    // Status might immediately become 'running' if queue was empty
    assert.ok(['queued', 'running', 'done'].includes(job.status))
    assert.equal(job.type, 'chapter-only')
    assert.equal(job.episode_id, 'EP001')
  })

  test('multiple jobs with different episode IDs coexist', async () => {
    const proj = await pm.createProject({ name: 'JQ2' })
    jq.registerExecutor('chapter-only', async () => {})
    const j1 = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP001', title: 'a', params: {},
    })
    const j2 = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP002', title: 'b', params: {},
    })
    assert.notEqual(j1.job_id, j2.job_id)
  })
})

describe('isDuplicate()', () => {
  test('returns false when no pending/running job', async () => {
    const proj = await pm.createProject({ name: 'JQDup1' })
    const dup = jq.isDuplicate(proj.slug, 'EP999', 'chapter-only')
    assert.equal(dup, false)
  })

  test('returns true for in-flight job with same key', async () => {
    const proj = await pm.createProject({ name: 'JQDup2' })
    // Executor that never completes — keeps the job in 'running'
    let release!: () => void
    const block = new Promise<void>((r) => { release = r })
    jq.registerExecutor('chapter-only', async () => await block)

    jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP001', title: 't', params: {},
    })

    // Give the queue a tick to pick up the job
    await new Promise((r) => setTimeout(r, 50))

    const dup = jq.isDuplicate(proj.slug, 'EP001', 'chapter-only')
    assert.equal(dup, true)

    // Clean up — release the blocked executor
    release()
    await new Promise((r) => setTimeout(r, 50))
  })
})

describe('Scene Review and Pipeline render ownership', () => {
  test('reuses an active legacy scene batch and preserves Pipeline continuation', async () => {
    const proj = await pm.createProject({ name: 'JQ Scene Render Join' })
    let releaseLegacy!: () => void
    const legacyBlock = new Promise<void>((resolve) => { releaseLegacy = resolve })
    let metadataRuns = 0
    jq.registerExecutor('continuity_render', async () => await legacyBlock)
    jq.registerExecutor('metadata', async () => { metadataRuns++ })

    const legacy = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'continuity_render',
      episode_id: 'EP001',
      title: 'Legacy Scene Review batch',
      params: { scene_ids: ['ep001-scene-0001'] },
    })
    await new Promise(resolve => setTimeout(resolve, 30))

    const active = jq.getActiveBulkSceneRenderJob(proj.slug, 'EP001')
    assert.equal(active?.job_id, legacy.job_id)
    assert.throws(() => jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'continuity_render',
      episode_id: 'EP001',
      title: 'Pipeline Scene Review',
      params: { independent: true },
    }), jq.DuplicateJobError)

    const joined = await jq.joinActiveBulkSceneRender({
      project_slug: proj.slug,
      episode_id: 'EP001',
      pipeline_batch_id: 'batch-scene-owner',
      pipeline_chain: [{ type: 'metadata', title: 'Continue Pipeline', params: {} }],
    })
    assert.equal(joined?.job.job_id, legacy.job_id)
    assert.equal(joined?.attached, true)
    assert.equal(joined?.conflict, false)

    releaseLegacy()
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && metadataRuns === 0) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(metadataRuns, 1, 'the adopted render should continue the Pipeline exactly once')
    const projectJobs = await jq.getJobs(proj.slug)
    assert.equal(projectJobs.filter(job => job.type === 'continuity_render').length, 1)
  })

  test('a render owned by another Pipeline cannot have its continuation replaced', async () => {
    const proj = await pm.createProject({ name: 'JQ Scene Render Conflict' })
    let release!: () => void
    const block = new Promise<void>((resolve) => { release = resolve })
    jq.registerExecutor('continuity_render', async () => await block)
    jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'continuity_render',
      episode_id: 'EP002',
      title: 'First Pipeline render',
      params: { pipeline_batch_id: 'batch-one', pipeline_chain: [] },
    })
    await new Promise(resolve => setTimeout(resolve, 30))

    const joined = await jq.joinActiveBulkSceneRender({
      project_slug: proj.slug,
      episode_id: 'EP002',
      pipeline_batch_id: 'batch-two',
      pipeline_chain: [{ type: 'metadata', params: {} }],
    })
    assert.equal(joined?.conflict, true)
    release()
  })
})

describe('getJobs() / getQueueStats()', () => {
  test('returns all jobs for a project', async () => {
    const proj = await pm.createProject({ name: 'JQList' })
    jq.registerExecutor('chapter-only', async () => {})
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP001', title: 'a', params: {} })
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP002', title: 'b', params: {} })

    // Wait for sync execution
    await new Promise((r) => setTimeout(r, 50))

    const list = await jq.getJobs(proj.slug)
    const codes = list.map((j) => j.episode_id)
    assert.ok(codes.includes('EP001'))
    assert.ok(codes.includes('EP002'))
  })

  test('tolerates persisted legacy job types with no queue lane', async () => {
    const proj = await pm.createProject({ name: 'JQLegacyType' })
    const jobsPath = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    await fs.writeFile(jobsPath, JSON.stringify({
      jobs: [{
        job_id: 'legacy01',
        project_slug: proj.slug,
        type: 'scene_review',
        episode_id: 'EP001',
        title: 'Retired scene review job',
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        error: null,
        output_lines: [],
        params: {},
      }],
    }, null, 2))

    const list = await jq.getJobs(proj.slug)
    const legacy = list.find(j => j.job_id === 'legacy01')
    assert.equal(legacy?.type, 'scene_review')
    assert.equal(legacy?.status, 'error')
    assert.equal(legacy?.error, 'Interrupted by app restart')
  })

  test('getQueueStats reports counts', async () => {
    const proj = await pm.createProject({ name: 'JQStats' })
    jq.registerExecutor('chapter-only', async () => {})
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP100', title: 'a', params: {} })
    await new Promise((r) => setTimeout(r, 50))

    const stats = jq.getQueueStats(proj.slug)
    assert.ok(typeof stats.total === 'number')
    assert.ok(stats.total >= 1)
  })
})

describe('pipeline chain handoff failures', () => {
  test('subtitle failure stays visible but still hands off to warning-capable finalizer', async () => {
    const proj = await pm.createProject({ name: 'JQ Subtitle Warning Handoff' })
    let finalizerRuns = 0
    let paidChildRuns = 0
    jq.registerExecutor('subtitles_transcribe', async () => {
      throw new Error('Chapter 03 subtitle is incomplete')
    })
    jq.registerExecutor('metadata', async () => {
      finalizerRuns++
    })
    jq.registerExecutor('thumb_images', async () => { paidChildRuns++ })
    const subtitle = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'subtitles_transcribe',
      episode_id: 'EP001',
      title: 'subtitle verification',
      params: {
        pipeline_batch_id: 'batch-subtitle-warning',
        pipeline_chain: [{
          type: 'metadata',
          title: 'YouTube Finalizer',
          params: {},
        }, { type: 'thumb_images', params: { model: 'saved-thumbnail-model' } }],
      },
    })

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && finalizerRuns === 0) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const failedSubtitle = jq.getJob(subtitle.job_id)
    assert.equal(failedSubtitle?.status, 'error')
    assert.match(failedSubtitle?.error || '', /subtitle is incomplete/)
    assert.equal(finalizerRuns, 1)
    assert.ok(
      failedSubtitle?.output_lines.some(line => /Finalizer was still queued with a warning/.test(line)),
    )
    const finalizer = (await jq.getJobs(proj.slug)).find(job => job.type === 'metadata')!
    await waitForJobStatus(finalizer.job_id, 'done')
    const recovery = await import('../services/episode-recovery.js')
    const plan = recovery.createEpisodeRecoveryPlan([failedSubtitle!])
    assert.equal(plan.continuation_dispatched, true, 'the source retains the completed handoff even after tail history is pruned')
    const verified = Object.fromEntries(recovery.EPISODE_RECOVERY_ORDER.map(step => [step, true])) as Record<import('../services/episode-recovery.js').EpisodeRecoveryStep, boolean>
    await recovery.dispatchEpisodeRecoveryStep(plan, { verified, message: 'repaired' }, await jq.getJobs(proj.slug))
    await recovery.dispatchEpisodeRecoveryStep(JSON.parse(JSON.stringify(plan)), { verified, message: 'restarted' }, await jq.getJobs(proj.slug))
    await jq._waitForJobPersistenceForTesting()
    const tails = (await jq.getJobs(proj.slug)).filter(job => job.type === 'metadata')
    assert.equal(tails.length, 1, 'warning finalizer and recovery use one durable tail handoff')
    assert.equal(finalizerRuns, 1)
    const children = (await jq.getJobs(proj.slug)).filter(job => job.type === 'thumb_images')
    assert.equal(children.length, 1)
    await waitForJobStatus(children[0].job_id, 'done')
    assert.equal(paidChildRuns, 1, 'the finalizer tail cannot repeat paid children')
    assert.equal(jq.removeTerminalJob(proj.slug, finalizer.job_id), true)
    assert.equal(jq.removeTerminalJob(proj.slug, children[0].job_id), true)
    await jq.mutateAuthoritativeJob(proj.slug, subtitle.job_id, job => ({ ...job,
      params: { ...job.params, sections: ['Chapter_03'], subtitle_recovery_plan_id: 'original-subtitle-budget' },
      result: { missing_sections: ['Chapter_03'] } }))
    const { router } = await import('../routes/video.js')
    const app = express().use(express.json()).use(router)
    const purchase = await request(app).post(`/projects/${proj.slug}/video-editor/subtitles/buy-missing/${subtitle.job_id}`).send({ additional_credit_ceiling: 3 })
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body))
    await waitForJobStatus(purchase.body.job_id, 'error')
    const purchaseJob = (await jq.loadAuthoritativeJob(proj.slug, purchase.body.job_id))!
    assert.equal(purchaseJob.params.subtitle_finalizer_job_id, finalizer.job_id, 'derived purchase carries the original immutable handoff identity')
    const restartedPlan = recovery.createEpisodeRecoveryPlan([JSON.parse(JSON.stringify(purchaseJob))])
    assert.equal(restartedPlan.continuation_job_id, finalizer.job_id)
    assert.equal(restartedPlan.continuation_dispatched, true)
    await recovery.dispatchEpisodeRecoveryStep(restartedPlan, { verified, message: 'restart' }, await jq.getJobs(proj.slug))
    await jq._waitForJobPersistenceForTesting()
    assert.equal(finalizerRuns, 1, 'a failed derived purchase cannot repeat a pruned finalizer')
    assert.equal(paidChildRuns, 1, 'nor repeat the paid child after restart')
    assert.equal((await jq.getJobs(proj.slug)).filter(job => ['metadata', 'thumb_images'].includes(job.type)).length, 0)
    jq.registerExecutor('subtitles_transcribe', async () => {})
    const derivedSuccess = jq.enqueuePreparedForTest({ project_slug: proj.slug, episode_id: 'EP001', type: 'subtitles_transcribe',
      title: 'recovered purchase', params: JSON.parse(JSON.stringify(purchaseJob.params)) })
    await waitForJobStatus(derivedSuccess.job_id, 'done')
    assert.equal(finalizerRuns, 1, 'successful derived jobs honor the same pruned handoff tombstone')
    assert.equal(paidChildRuns, 1)
  })

  test('persists a failed child job instead of reporting a false-success batch', async () => {
    const proj = await pm.createProject({ name: 'JQ Chain Handoff' })
    jq.registerExecutor('chapter-only', async () => {})
    const batchId = 'batch-handoff-test'
    jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'chapter-only',
      episode_id: 'EP001',
      title: 'chain head',
      params: {
        pipeline_batch_id: batchId,
        pipeline_chain: [{
          type: 'removed-job-type',
          title: 'missing next step',
          params: { marker: 'preserved' },
        }],
      },
    })

    const deadline = Date.now() + 2000
    let failed: any
    while (Date.now() < deadline) {
      const list = await jq.getJobs(proj.slug)
      failed = list.find(j => (j.params as any)?.pipeline_handoff_failed === true)
      if (failed) break
      await new Promise(r => setTimeout(r, 20))
    }

    assert.ok(failed, 'handoff failure should create a visible child job')
    assert.equal(failed.status, 'error')
    assert.equal(failed.type, 'removed-job-type')
    assert.equal(failed.params.pipeline_batch_id, batchId)
    assert.equal(failed.params.marker, 'preserved')
    assert.match(failed.error, /handoff failed/i)
  })
})

describe('verified completion backstop', () => {
  test('an executor cannot return incomplete output as a green Done job', async () => {
    const proj = await pm.createProject({ name: 'JQ Incomplete Result' })
    jq.registerExecutor('metadata', async (job) => {
      job.result = { complete: false, completion_error: 'Metadata incomplete: description is missing.' }
    })
    const queued = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'metadata', episode_id: 'EP001', title: 'partial', params: { auto_retry: false },
    })

    const deadline = Date.now() + 2000
    let settled = jq.getJob(queued.job_id)
    while (Date.now() < deadline && settled?.status !== 'error') {
      await new Promise(resolve => setTimeout(resolve, 20))
      settled = jq.getJob(queued.job_id)
    }
    assert.equal(settled?.status, 'error')
    assert.match(settled?.error || '', /description is missing/)
  })
})

describe('retryTerminalJob()', () => {
  test('replaces a failed job only after the exact checkpoint params are re-enqueued', async () => {
    const proj = await pm.createProject({ name: 'JQ Generic Retry' })
    jq.registerExecutor('research_run', async () => { throw new Error('first attempt failed') })
    const original = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'research_run',
      episode_id: 'EP001',
      title: 'Research checkpoint',
      params: { model: 'cloud-model', pending_ids: ['item-2'], auto_retry: false },
    })

    await waitFor(() => jq.getJob(original.job_id)?.status === 'error', {
      label: 'manual image Finish job to fail before generic retry',
    })
    assert.equal(jq.getJob(original.job_id)?.status, 'error')
    // The row reports `error` before its worker settles; Retry is refused until then (1.4.319).
    await waitFor(() => !jq._isJobWorkerActiveForTesting(original.job_id), { label: 'failed worker settles' })

    let received: Record<string, any> | undefined
    jq.registerExecutor('research_run', async job => { received = job.params })
    const retried = jq.retryTerminalJob(proj.slug, original.job_id)
    assert.notEqual(retried.job_id, original.job_id)
    assert.equal(jq.getJob(original.job_id), null)

    const retryDeadline = Date.now() + 2_000
    while (Date.now() < retryDeadline && jq.getJob(retried.job_id)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.deepEqual(received, { model: 'cloud-model', pending_ids: ['item-2'], auto_retry: false })
    assert.equal(jq.getJob(retried.job_id)?.status, 'done')
  })

  test('replays the selected Motion variant without replacing it', async () => {
    const proj = await pm.createProject({ name: 'JQ Motion Variant Retry' })
    jq.registerExecutor('scene_clips_batch', async () => { throw new Error('first attempt failed') })
    const original = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'scene_clips_batch',
      episode_id: 'EP001',
      title: 'Motion clips',
      params: { model: 'genstudio-video:live-video', duration_seconds: 8, resolution: '1080p' },
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(original.job_id)?.status !== 'error') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(original.job_id)?.status, 'error')
    // The row reports `error` before its worker settles; Retry is refused until then (1.4.319).
    await waitFor(() => !jq._isJobWorkerActiveForTesting(original.job_id), { label: 'failed worker settles' })

    let received: Record<string, unknown> | undefined
    jq.registerExecutor('scene_clips_batch', async job => { received = job.params })
    const retried = jq.retryTerminalJob(proj.slug, original.job_id)
    const retryDeadline = Date.now() + 2_000
    while (Date.now() < retryDeadline && jq.getJob(retried.job_id)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.deepEqual(received, { model: 'genstudio-video:live-video', duration_seconds: 8, resolution: '1080p' })
  })

  test('does not copy a manual image Finish authority into a generic retry', async () => {
    const proj = await pm.createProject({ name: 'JQ Manual Finish Retry Scope' })
    jq.registerExecutor('continuity_render', async () => { throw new Error('first attempt failed') })
    const original = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'continuity_render',
      episode_id: 'EP001',
      title: 'Finish missing images',
      params: {
        model: 'genstudio-image:current-model',
        manual_image_finish: { action_id: 'manual-action', replace_uncertain: true },
      },
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(original.job_id)?.status !== 'error') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(original.job_id)?.status, 'error')

    // `waitFor`, not a fixed-ms poll: the suite forbids a new `setTimeout`
    // followed by an assertion (see no-new-wallclock-sleeps), and it is right
    // to — a fixed sleep asserts that this machine schedules promptly, which
    // stops being true under load.
    await waitFor(
      () => !jq._isJobWorkerActiveForTesting(original.job_id),
      { label: 'the failed worker to settle before Retry is admitted', timeoutMs: 2_000 },
    )
    assert.equal(jq._isJobWorkerActiveForTesting(original.job_id), false,
      'the failed worker must settle before Retry is admitted')

    jq.registerExecutor('continuity_render', async () => {})
    const retried = jq.retryTerminalJob(proj.slug, original.job_id)
    assert.equal(retried.params.model, 'genstudio-image:current-model')
    assert.equal(retried.params.manual_image_finish, undefined)
  })

  test('refuses to replace a non-terminal job', async () => {
    const proj = await pm.createProject({ name: 'JQ Unsafe Retry' })
    let release!: () => void
    const block = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('research_run', async () => await block)
    const active = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'research_run',
      episode_id: 'EP002',
      title: 'Still active',
      params: {},
    })
    assert.throws(() => jq.retryTerminalJob(proj.slug, active.job_id), /Only failed or cancelled jobs/)
    release()
  })
})

describe('requestJobCancellation()', () => {
  test('rejects an unknown job ID', async () => {
    await assert.rejects(
      jq.requestJobCancellation('missing-project', 'does-not-exist'),
      (error: any) => error?.status === 404,
    )
  })

  test('cancels a queued job', async () => {
    const proj = await pm.createProject({ name: 'JQCancel' })
    // Executor that blocks forever
    let release!: () => void
    const block = new Promise<void>((r) => { release = r })
    jq.registerExecutor('chapter-only', async () => await block)

    // Fill the single-slot queue first
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP_HOLD', title: 'hold', params: {} })
    // Second job should be queued (not running)
    const second = jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP_CANCEL', title: 'c', params: {} })

    const cancelled = await jq.requestJobCancellation(proj.slug, second.job_id)
    assert.equal(cancelled.status, 'cancelled')

    // Clean up
    release()
    await new Promise((r) => setTimeout(r, 50))
  })
})

describe('late pause arbitration at the executor completion boundary', () => {
  for (const origin of ['manual', 'queue'] as const) {
    test(`preserves a late ${origin} pause after the executor declares complete output`, async () => {
      const proj = await pm.createProject({ name: `JQ Late ${origin} Pause` })
      jq.registerExecutor('continuity_render', async job => {
        await jq.pauseJob(job.job_id, origin)
        job.result = {
          complete: true,
          completion: { label: 'Scene image generation', expected: 1, completed: 1, complete: true },
        }
      })

      const job = jq.enqueuePreparedForTest({
        project_slug: proj.slug,
        type: 'continuity_render',
        episode_id: 'EP001',
        title: 'late explicit pause',
        params: {},
      })
      await waitForJobStatus(job.job_id, 'paused')

      const paused = jq.getJob(job.job_id)!
      assert.equal(paused.pause_origin, origin)
      assert.equal(paused.finished_at, null)
    })
  }

  test('finishes once when a late automatic stall hold follows a complete output audit', async () => {
    const proj = await pm.createProject({ name: 'JQ Late Stall After Complete' })
    let executions = 0
    jq.registerExecutor('continuity_render', async job => {
      executions++
      await jq.pauseJobForStall(job.job_id, 'test hold after the final image checkpointed.')
      job.result = {
        complete: true,
        completion: { label: 'Scene image generation', expected: 1, completed: 1, complete: true },
      }
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'continuity_render',
      episode_id: 'EP002',
      title: 'late automatic stall',
      params: {},
    })
    await waitFor(() => jq.getJob(job.job_id)?.status === 'done', {
      label: 'late automatic stall completion',
      timeoutMs: 2_000,
    })

    const done = jq.getJob(job.job_id)!
    assert.equal(executions, 1)
    assert.equal(done.pause_requested, false)
    assert.equal(done.pause_origin, undefined)
    assert.ok(done.finished_at)
    assert.match(done.output_lines.join('\n'), /all outputs were already verified/i)
  })

  test('keeps a contradictory completion declaration from becoming done after a stall hold', async () => {
    const proj = await pm.createProject({ name: 'JQ Late Stall Contradictory Completion' })
    jq.registerExecutor('continuity_render', async job => {
      await jq.pauseJobForStall(job.job_id, 'test hold with contradictory evidence.')
      job.result = {
        complete: true,
        completion: { label: 'Scene image generation', expected: 1, completed: 0, complete: false },
      }
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'continuity_render',
      episode_id: 'EP003',
      title: 'contradictory automatic stall',
      params: {},
    })
    await waitForJobStatus(job.job_id, 'paused')

    assert.equal(jq.getJob(job.job_id)?.pause_origin, 'stall')
  })

  test('keeps an incomplete output declaration from becoming done after a stall hold', async () => {
    const proj = await pm.createProject({ name: 'JQ Late Stall Incomplete Completion' })
    jq.registerExecutor('continuity_render', async job => {
      await jq.pauseJobForStall(job.job_id, 'test hold with incomplete output.')
      job.result = {
        complete: false,
        completion: {
          label: 'Scene image generation', expected: 1, completed: 0,
          missing: ['scene-001'], complete: false,
          error: 'Scene image generation incomplete: 0/1 required item(s) verified.',
        },
      }
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'continuity_render',
      episode_id: 'EP004',
      title: 'incomplete automatic stall',
      params: {},
    })
    await waitForJobStatus(job.job_id, 'paused')

    assert.equal(jq.getJob(job.job_id)?.pause_origin, 'stall')
    assert.equal(jq.getJob(job.job_id)?.result?.complete, false)
  })
})

describe('Persistence — interrupted jobs on restart', () => {
  test('running jobs are marked as error on fresh module load', async () => {
    const proj = await pm.createProject({ name: 'JQPersist' })
    // Write a jobs.json with a "running" job simulating an interrupt
    const jobsFile = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({
      jobs: [{
        job_id: 'fake-interrupted-job',
        project_slug: proj.slug,
        // Writing steps are picked up again at boot since R2; paid thumbnails still are not.
        type: 'thumb_images',
        episode_id: 'EP001',
        title: 'old running job',
        status: 'running',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        output_lines: [],
        params: {},
      }],
    }))

    // Fresh getJobs() will call loadPersistedJobs which marks running→error
    const list = await jq.getJobs(proj.slug)
    const target = list.find((j) => j.job_id === 'fake-interrupted-job')
    assert.ok(target, 'should have loaded the persisted job')
    assert.equal(target!.status, 'error')
    assert.equal(target!.error, 'Interrupted by app restart')
  })
})

describe('Concurrent enqueues across different job types', () => {
  test('parallel images + audio jobs all persist to jobs.json without lost entries', async () => {
    // Audit gap: images and audio run in different queue worker pools
    // (3 workers per type). Both write to the SAME jobs.json via
    // persistJob() — without the per-path withLock wrapping the
    // read-modify-write block, simultaneous completions could clobber
    // each other's persisted state. This test fires N concurrent jobs
    // across two types and asserts every one landed in jobs.json with
    // status=done.
    const proj = await pm.createProject({ name: 'JQ Concurrent' })
    jq.registerExecutor('thumb_images', async (j) => {
      // Tiny but non-trivial work so multiple jobs interleave on the
      // event loop and the persist write is genuinely racy.
      await new Promise((r) => setTimeout(r, 5))
      j.output_lines.push('done')
    })
    jq.registerExecutor('audio', async (j) => {
      await new Promise((r) => setTimeout(r, 5))
      j.output_lines.push('done')
    })

    const N = 12  // 6 images + 6 audio, exceeds the 3-worker pool per type
    const enqueued: string[] = []
    for (let i = 0; i < N / 2; i++) {
      const a = jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'thumb_images',
        episode_id: `EP${String(100 + i).padStart(3, '0')}`,
        title: `img-${i}`, params: {},
      })
      const b = jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'audio',
        episode_id: `EP${String(200 + i).padStart(3, '0')}`,
        title: `aud-${i}`, params: {},
      })
      enqueued.push(a.job_id, b.job_id)
    }

    // Each queue type is single-threaded (one worker per QueueState), so
    // 6 jobs × 5ms = ~30ms work per type. The dominating cost is the
    // jobs.json persist on every state transition (enqueue / start /
    // finish = 3 writes per job) — those serialize through withLock +
    // atomic rename, and on a slow disk each can take 30-50ms.
    //
    // This budget was 3s, and 3s stopped being safe in v1.4.73: the content-pack
    // suites grew enough to triple the whole backend run, and under that much
    // competing disk I/O twelve jobs did not all finish in time. What failed was
    // ONLY the deadline — every job was present in jobs.json, so the assertion
    // this test exists for ("race lost it") held; the statuses were simply
    // `running` and `queued` rather than `done`. A generous cap costs nothing,
    // because the loop breaks the moment the condition is met; a tight one turns
    // a correctness test into a speed test and makes the release gate lie.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const inMem = await jq.getJobs(proj.slug)
      const ours = inMem.filter(j => enqueued.includes(j.job_id))
      if (ours.length === N && ours.every(j => j.status === 'done')) break
      await new Promise((r) => setTimeout(r, 50))
    }

    // Read jobs.json directly to verify the persistence path didn't drop
    // entries — getJobs() reads from in-memory state, which doesn't catch
    // a missing-on-disk regression.
    const jobsFile = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    const raw = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
    const persistedIds = new Set(raw.jobs.map((j: any) => j.job_id))
    for (const id of enqueued) {
      assert.ok(persistedIds.has(id), `job ${id} missing from jobs.json — race lost it`)
    }
    // All settled cleanly.
    const inMemory = await jq.getJobs(proj.slug)
    const ours = inMemory.filter(j => enqueued.includes(j.job_id))
    assert.equal(ours.length, N, `expected ${N} jobs, got ${ours.length}`)
    assert.ok(ours.every(j => j.status === 'done'),
      `every job should be done; statuses: ${ours.map(j => j.status).join(',')}`)
  })
})

describe('recordAccountUsed()', () => {
  test('records one provider/account on a queued job and fires an update event', async () => {
    const proj = await pm.createProject({ name: 'JQ Account Use 1' })
    jq.registerExecutor('chapter-only', async () => {})
    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP001', title: 't', params: {},
    })
    let updates = 0
    const onUpdate = () => { updates++ }
    jq.jobEvents.on('update', onUpdate)
    try {
      jq.recordAccountUsed(job.job_id, 'openai', { id: 'acc-1', label: 'Personal' })
    } finally {
      jq.jobEvents.off('update', onUpdate)
    }
    const after = jq.getJob(job.job_id)!
    assert.deepEqual(after.accounts_used, { openai: { id: 'acc-1', label: 'Personal' } })
    assert.ok(updates >= 1, 'recording should fire at least one update event')
  })

  test('same provider overwrites with the latest resolution; other providers accumulate', async () => {
    const proj = await pm.createProject({ name: 'JQ Account Use 2' })
    jq.registerExecutor('chapter-only', async () => {})
    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'chapter-only', episode_id: 'EP001', title: 't', params: {},
    })
    jq.recordAccountUsed(job.job_id, 'openai', { id: 'acc-1', label: 'A' })
    jq.recordAccountUsed(job.job_id, 'openai', { id: 'acc-2', label: 'B' })
    jq.recordAccountUsed(job.job_id, 'anthropic', { id: 'acc-3', label: 'Claude' })
    const after = jq.getJob(job.job_id)!
    assert.deepEqual(after.accounts_used, {
      openai:    { id: 'acc-2', label: 'B' },
      anthropic: { id: 'acc-3', label: 'Claude' },
    })
  })

  test('silent no-op for an unknown job id (attribution must never throw)', async () => {
    assert.doesNotThrow(() => {
      jq.recordAccountUsed('does-not-exist', 'openai', { id: 'x', label: 'x' })
    })
  })
})

describe('cooperative pause and resume', () => {
  test('queued work pauses before submit and resumes as the same durable job', async () => {
    const proj = await pm.createProject({ name: 'JQ Pause Queued' })
    let release!: () => void
    const blocker = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('broll_normalize', async job => {
      if (job.episode_id === 'HOLD') await blocker
    })
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'broll_normalize', episode_id: 'HOLD', title: 'hold', params: {} })
    const waiting = jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'broll_normalize', episode_id: 'EP001', title: 'waiting', params: {} })
    await new Promise(resolve => setTimeout(resolve, 30))

    const paused = await jq.pauseJob(waiting.job_id)
    assert.equal(paused?.status, 'paused')
    assert.equal(jq.isDuplicate(proj.slug, 'EP001', 'broll_normalize'), true)

    const resumed = await jq.resumeJob(waiting.job_id)
    assert.equal(resumed?.job_id, waiting.job_id)
    assert.equal(resumed?.status, 'queued')
    release()

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob(waiting.job_id)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(waiting.job_id)?.status, 'done')
  })

  test('running work finishes its safe boundary, becomes paused, then resumes in place', async () => {
    const proj = await pm.createProject({ name: 'JQ Pause Running' })
    let runs = 0
    let release!: () => void
    const boundary = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async runningJob => {
      if (runningJob.episode_id !== 'EP002') return
      runs++
      if (runs === 1) await boundary
    })
    const job = jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'audio', episode_id: 'EP002', title: 'running', params: {} })
    const runningDeadline = Date.now() + 2_000
    while (Date.now() < runningDeadline && jq.getJob(job.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(job.job_id)?.status, 'running')
    const requested = await jq.pauseJob(job.job_id)
    assert.equal(requested?.pause_origin, 'manual')
    release()

    const pauseDeadline = Date.now() + 2_000
    while (Date.now() < pauseDeadline && jq.getJob(job.job_id)?.status !== 'paused') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(job.job_id)?.status, 'paused')
    assert.equal(jq.getJob(job.job_id)?.finished_at, null)

    await jq.resumeJob(job.job_id)
    const doneDeadline = Date.now() + 2_000
    while (Date.now() < doneDeadline && jq.getJob(job.job_id)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(job.job_id)?.status, 'done')
    assert.ok(runs >= 1)
  })

  test('global Resume restarts queue-held jobs without restarting manually paused jobs', async () => {
    const proj = await pm.createProject({ name: 'JQ Global Hold' })
    let release!: () => void
    let globalRuns = 0
    const boundary = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async job => {
      if (job.episode_id === 'GLOBAL') {
        globalRuns++
        if (globalRuns === 1) await boundary
      }
      if (job.episode_id === 'MANUAL') await boundary
    })
    const globallyHeld = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'audio',
      episode_id: 'GLOBAL',
      title: 'global',
      params: { provider: 'genstudio' },
    })
    const manuallyHeld = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'audio',
      episode_id: 'MANUAL',
      title: 'manual',
      params: {},
    })
    const runningDeadline = Date.now() + 2_000
    while (Date.now() < runningDeadline && jq.getJob(globallyHeld.job_id)?.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(globallyHeld.job_id)?.status, 'running')
    await jq.pauseJob(manuallyHeld.job_id)
    await jq.setQueuePaused(true)
    release()

    const pauseDeadline = Date.now() + 2_000
    while (Date.now() < pauseDeadline && jq.getJob(globallyHeld.job_id)?.status !== 'paused') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(globallyHeld.job_id)?.pause_origin, 'queue')
    assert.equal(jq.getJob(manuallyHeld.job_id)?.pause_origin, 'manual')

    await jq.setQueuePaused(false)
    const doneDeadline = Date.now() + 2_000
    while (Date.now() < doneDeadline && jq.getJob(globallyHeld.job_id)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(jq.getJob(globallyHeld.job_id)?.status, 'done')
    assert.equal(jq.getJob(manuallyHeld.job_id)?.status, 'paused')
    await jq.requestJobCancellation(proj.slug, manuallyHeld.job_id)
  })

  test('a quick global Pause then Resume releases a running queue hold only after its safe checkpoint', async () => {
    const project = await pm.createProject({ name: 'JQ Queue Toggle Checkpoint' })
    const checkpoint = deferred()
    const releaseCheckpoint = deferred()
    let runs = 0
    jq.registerExecutor('audio', async job => {
      if (job.episode_id !== 'TOGGLE') return
      runs++
      checkpoint.resolve()
      await releaseCheckpoint.promise
      jq.throwIfPauseRequested(job.job_id)
    })
    await jq.setQueuePaused(false)
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'audio',
      episode_id: 'TOGGLE',
      title: 'queue toggle checkpoint',
      params: { provider: 'genstudio' },
    })
    await checkpoint.promise

    // Do not await Pause before Resume: this is the rapid double-click that
    // formerly left a cooperative safe-point hold behind after the queue was
    // already globally resumed.
    const pause = jq.setQueuePaused(true)
    const resume = jq.setQueuePaused(false)
    await Promise.all([pause, resume])
    releaseCheckpoint.resolve()

    await waitForJobStatus(job.job_id, 'done')
    assert.equal(jq.isQueuePaused(), false)
    assert.equal(await (await import('../services/app-settings.js')).getAppSetting('job_queue_paused'), false)
    assert.equal(jq.getJob(job.job_id)?.pause_requested, false)
    assert.equal(runs, 2, 'Resume requeues only after the first run saved its pause checkpoint')
  })

  test('a manual pause during global Resume keeps a running queue hold paused', async t => {
    const project = await pm.createProject({ name: 'JQ Queue Resume Manual Supersession' })
    const settingsFile = path.join(tempDir, 'app-settings.json')
    const checkpoint = deferred()
    const releaseCheckpoint = deferred()
    const settingsWriteStarted = deferred()
    const releaseSettingsWrite = deferred()
    let runs = 0
    jq.registerExecutor('audio', async job => {
      if (job.episode_id !== 'MANUAL-WINS') return
      runs++
      checkpoint.resolve()
      await releaseCheckpoint.promise
      jq.throwIfPauseRequested(job.job_id)
    })
    await jq.setQueuePaused(false)
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'audio',
      episode_id: 'MANUAL-WINS',
      title: 'manual pause wins after global Resume',
      params: { provider: 'genstudio' },
    })
    await checkpoint.promise
    await jq.setQueuePaused(true)

    const originalRename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === path.resolve(settingsFile)) {
        settingsWriteStarted.resolve()
        await releaseSettingsWrite.promise
      }
      return originalRename(from, to)
    })
    try {
      const resume = jq.setQueuePaused(false)
      await settingsWriteStarted.promise
      await jq.pauseJob(job.job_id, 'manual')
      releaseSettingsWrite.resolve()
      await resume
    } finally {
      releaseSettingsWrite.resolve()
      t.mock.restoreAll()
    }
    releaseCheckpoint.resolve()

    await waitForJobStatus(job.job_id, 'paused')
    assert.equal(jq.getJob(job.job_id)?.pause_origin, 'manual')
    assert.equal(runs, 1, 'manual supersession must prevent queue-origin requeue')

    await jq.resumeJob(job.job_id)
    await waitForJobStatus(job.job_id, 'done')
    assert.equal(runs, 2)
  })

  test('a failed global Resume settings write keeps the running pause checkpoint and does not submit', async t => {
    const project = await pm.createProject({ name: 'JQ Queue Resume Settings Failure' })
    const settingsFile = path.join(tempDir, 'app-settings.json')
    const checkpoint = deferred()
    const releaseCheckpoint = deferred()
    let runs = 0
    jq.registerExecutor('audio', async job => {
      if (job.episode_id !== 'SETTINGS-FAIL') return
      runs++
      job.progress = 41
      job.output_lines.push('worker progress before failed queue Resume')
      checkpoint.resolve()
      await releaseCheckpoint.promise
      jq.throwIfPauseRequested(job.job_id)
    })
    await jq.setQueuePaused(false)
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'audio',
      episode_id: 'SETTINGS-FAIL',
      title: 'settings failure checkpoint',
      params: { provider: 'genstudio' },
    })
    await checkpoint.promise
    await jq.setQueuePaused(true)

    const originalRename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === path.resolve(settingsFile)) throw new Error('forced global-resume settings failure')
      return originalRename(from, to)
    })
    try {
      await assert.rejects(jq.setQueuePaused(false), /forced global-resume settings failure/)
      assert.equal(jq.isQueuePaused(), true)
      assert.equal(jq.isPauseRequested(job.job_id), true)
      assert.equal(jq.getJob(job.job_id)?.pause_requested, true)
      assert.equal(jq.getJob(job.job_id)?.pause_origin, 'queue')
      assert.equal(runs, 1)
    } finally {
      t.mock.restoreAll()
      releaseCheckpoint.resolve()
    }

    await waitForJobStatus(job.job_id, 'paused')
    assert.equal(jq.getJob(job.job_id)?.progress, 41)
    assert.match(jq.getJob(job.job_id)?.output_lines.join('\n') || '', /worker progress before failed queue Resume/)
    assert.equal(runs, 1, 'failed Resume must not admit a second run')
    await jq.setQueuePaused(false)
    await waitForJobStatus(job.job_id, 'done')
  })

  test('a failed running pause checkpoint after global Resume retains progress and does not admit new work', async t => {
    const project = await pm.createProject({ name: 'JQ Queue Resume Checkpoint Failure' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const checkpoint = deferred()
    const releaseCheckpoint = deferred()
    const failedCheckpointWrite = deferred()
    let runs = 0
    jq.registerExecutor('audio', async job => {
      if (job.episode_id !== 'CHECKPOINT-FAIL') return
      runs++
      job.progress = 53
      job.output_lines.push('worker progress before failed durable pause checkpoint')
      checkpoint.resolve()
      await releaseCheckpoint.promise
      jq.throwIfPauseRequested(job.job_id)
    })
    await jq.setQueuePaused(false)
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'audio',
      episode_id: 'CHECKPOINT-FAIL',
      title: 'failed queue pause checkpoint',
      params: { provider: 'genstudio' },
    })
    await checkpoint.promise
    await jq.setQueuePaused(true)

    const originalRename = fs.rename.bind(fs)
    let failedWrites = 0
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === path.resolve(jobsFile) && failedWrites++ === 0) {
        failedCheckpointWrite.resolve()
        throw new Error('forced running pause checkpoint persistence failure')
      }
      return originalRename(from, to)
    })
    try {
      await jq.setQueuePaused(false)
      assert.equal(jq.isQueuePaused(), false)
      assert.equal(jq.isPauseRequested(job.job_id), true)
      releaseCheckpoint.resolve()
      await failedCheckpointWrite.promise
      await new Promise(resolve => setTimeout(resolve, 0))

      assert.equal(jq.getJob(job.job_id)?.status, 'paused')
      assert.equal(jq.getJob(job.job_id)?.progress, 53)
      assert.match(jq.getJob(job.job_id)?.output_lines.join('\n') || '', /worker progress before failed durable pause checkpoint/)
      assert.equal(runs, 1, 'a failed checkpoint must not submit a replacement run')
      const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs as Job[]
      assert.equal(persisted.find(candidate => candidate.job_id === job.job_id)?.pause_requested, true)
    } finally {
      t.mock.restoreAll()
    }

    await jq.setQueuePaused(false)
    await waitForJobStatus(job.job_id, 'done')
    assert.equal(runs, 2)
  })

  test('single Resume never admits a job when its durable paused-to-queued write fails', async t => {
    const project = await pm.createProject({ name: 'JQ Single Resume Rollback' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const executed: string[] = []
    jq.registerExecutor('broll_assemble', async job => { executed.push(job.episode_id) })
    await jq.setQueuePaused(true)
    const held = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'broll_assemble',
      episode_id: 'HELD',
      title: 'held single resume',
      params: {},
    })
    await jq.pauseJob(held.job_id, 'manual')
    const originalRename = fs.rename.bind(fs)
    const originalWarn = console.warn.bind(console)
    let failedWrites = 0
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === path.resolve(jobsFile)) {
        failedWrites++
        throw new Error('forced single-resume persistence failure')
      }
      return originalRename(from, to)
    })
    t.mock.method(console, 'warn', (...args: any[]) => {
      if (args[0] === '[job-queue] failed to persist paused-job release') return
      originalWarn(...args)
    })
    try {
      await assert.rejects(
        jq.resumeJob(held.job_id),
        (error: any) => error?.status === 503 && /remains paused/i.test(error?.message || ''),
      )
      assert.equal(failedWrites, 1)
      assert.equal(jq.getJob(held.job_id)?.status, 'paused')
      assert.equal(jq.getJob(held.job_id)?.pause_origin, 'manual')
      const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs as Job[]
      assert.equal(persisted.find(job => job.job_id === held.job_id)?.status, 'paused')

      // A competing lane admission must not discover a failed single Resume
      // in pending work.  Manual intent remains paused through global Resume.
      t.mock.restoreAll()
      const marker = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'broll_assemble',
        episode_id: 'MARKER',
        title: 'resume rollback marker',
        params: {},
      })
      await jq.setQueuePaused(false)
      await waitForJobStatus(marker.job_id, 'done')
      assert.deepEqual(executed, ['MARKER'])
      assert.equal(jq.getJob(held.job_id)?.status, 'paused')
      assert.equal(jq.getJob(held.job_id)?.pause_origin, 'manual')
    } finally {
      t.mock.restoreAll()
      if (jq.getJob(held.job_id)?.status === 'paused') await jq.requestJobCancellation(project.slug, held.job_id)
    }
  })

  test('single Resume names an unavailable executor and leaves the job paused', async () => {
    const project = await pm.createProject({ name: 'JQ Single Resume Missing Executor' })
    await jq.setQueuePaused(true)
    const held = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'music_video',
      episode_id: 'NO-EXECUTOR',
      title: 'unavailable resume lane',
      params: {},
    })
    await jq.pauseJob(held.job_id, 'manual')
    try {
      await assert.rejects(
        jq.resumeJob(held.job_id),
        (error: any) => error?.status === 409 && /unavailable/i.test(error?.message || ''),
      )
      assert.equal(jq.getJob(held.job_id)?.status, 'paused')
      assert.equal(jq.getJob(held.job_id)?.pause_origin, 'manual')
    } finally {
      await jq.requestJobCancellation(project.slug, held.job_id)
      await jq.setQueuePaused(false)
    }
  })

  test('global Resume releases a loaded queue-origin pause when the queue was already running', async () => {
    const project = await pm.createProject({ name: 'JQ Idempotent Global Resume' })
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    jq.registerExecutor('broll_normalize', async job => {
      if (job.episode_id === 'BLOCK') {
        blockerStarted.resolve()
        await releaseBlocker.promise
      }
    })
    await jq.setQueuePaused(false)
    jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'broll_normalize',
      episode_id: 'BLOCK',
      title: 'occupy lane',
      params: {},
    })
    await blockerStarted.promise

    const held = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'broll_normalize',
      episode_id: 'QUEUE-HOLD',
      title: 'queue hold',
      params: {},
    })
    await jq.pauseJob(held.job_id, 'queue')

    try {
      await jq.setQueuePaused(false)

      assert.equal(jq.getJob(held.job_id)?.status, 'queued')
      assert.equal(jq.getJob(held.job_id)?.pause_origin, undefined)
      const heldDone = waitForJobStatus(held.job_id, 'done')
      releaseBlocker.resolve()
      await heldDone
    } finally {
      releaseBlocker.resolve()
    }
  })

  test('two queue-origin records retain FIFO with one project snapshot and one executor call each', async t => {
    const project = await pm.createProject({ name: 'JQ Repeated Global Resume' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    const markerDone = deferred()
    const executionOrder: string[] = []
    jq.registerExecutor('music_video', async job => {
      if (job.episode_id === 'BLOCK') {
        blockerStarted.resolve()
        await releaseBlocker.promise
      } else {
        executionOrder.push(job.episode_id)
      }
      if (job.episode_id === 'MARKER') {
        markerDone.resolve()
      }
    })
    await jq.setQueuePaused(false)
    jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'music_video',
      episode_id: 'BLOCK',
      title: 'occupy lane',
      params: {},
    })
    await blockerStarted.promise

    const firstHeld = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'music_video',
      episode_id: 'QUEUE-HOLD-1',
      title: 'first queue hold',
      params: {},
    })
    const secondHeld = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'music_video',
      episode_id: 'QUEUE-HOLD-2',
      title: 'second queue hold',
      params: {},
    })
    await jq.pauseJob(firstHeld.job_id, 'queue')
    await jq.pauseJob(secondHeld.job_id, 'queue')
    const originalRename = fs.rename.bind(fs)
    let projectSnapshots = 0
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (path.resolve(String(to)) === path.resolve(jobsFile)) projectSnapshots += 1
      return originalRename(from, to)
    })
    try {
      let lanePumps = 0
      const stopObservingPumps = jq._observeQueuePumpsForTesting(type => {
        if (type === 'music_video') lanePumps += 1
      })
      try {
        await jq.setQueuePaused(false)
      } finally {
        stopObservingPumps()
      }
      const marker = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'music_video',
        episode_id: 'MARKER',
        title: 'marker',
        params: {},
      })

      const listed = await jq.getJobs(project.slug)
      assert.equal(listed.find(job => job.job_id === firstHeld.job_id)?.queue_position, 1)
      assert.equal(listed.find(job => job.job_id === secondHeld.job_id)?.queue_position, 2)
      assert.equal(listed.find(job => job.job_id === marker.job_id)?.queue_position, 3)
      assert.equal(projectSnapshots, 1)
      assert.equal(lanePumps, 1)
      releaseBlocker.resolve()
      await markerDone.promise
      assert.deepEqual(executionOrder, ['QUEUE-HOLD-1', 'QUEUE-HOLD-2', 'MARKER'])
    } finally {
      releaseBlocker.resolve()
      await markerDone.promise
    }
  })

  test('a later manual pause wins while queue-origin release persistence is blocked', async t => {
    await assertSupersedingIntentWinsDuringQueueRelease(t, 'manual-pause')
  })

  test('a later cancellation wins while queue-origin release persistence is blocked', async t => {
    await assertSupersedingIntentWinsDuringQueueRelease(t, 'cancel')
  })

  test('a failed queue-origin release snapshot rolls every selected record back before admission', async t => {
    const project = await pm.createProject({ name: 'JQ Global Resume Rollback' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    jq.registerExecutor('video_assembly', async job => {
      if (job.episode_id === 'BLOCK') {
        blockerStarted.resolve()
        await releaseBlocker.promise
      }
    })
    await jq.setQueuePaused(false)
    jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'video_assembly',
      episode_id: 'BLOCK',
      title: 'occupy lane',
      params: {},
    })
    await blockerStarted.promise
    const firstHeld = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'video_assembly',
      episode_id: 'QUEUE-HOLD-1',
      title: 'first queue hold',
      params: {},
    })
    const secondHeld = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'video_assembly',
      episode_id: 'QUEUE-HOLD-2',
      title: 'second queue hold',
      params: {},
    })
    await jq.pauseJob(firstHeld.job_id, 'queue')
    await jq.pauseJob(secondHeld.job_id, 'queue')

    const originalRename = fs.rename.bind(fs)
    const originalWarn = console.warn.bind(console)
    let failProjectSnapshot = true
    let failedSnapshots = 0
    t.mock.method(fs, 'rename', async (from: any, to: any) => {
      if (failProjectSnapshot && path.resolve(String(to)) === path.resolve(jobsFile)) {
        failedSnapshots += 1
        throw new Error('forced paused-release persistence failure')
      }
      return originalRename(from, to)
    })
    t.mock.method(console, 'warn', (...args: any[]) => {
      if (args[0] === '[job-queue] failed to persist paused-job release') return
      originalWarn(...args)
    })
    try {
      await jq.setQueuePaused(false)

      assert.equal(failedSnapshots, 1)
      assert.equal(jq.getJob(firstHeld.job_id)?.status, 'paused')
      assert.equal(jq.getJob(firstHeld.job_id)?.pause_origin, 'queue')
      assert.equal(jq.getJob(secondHeld.job_id)?.status, 'paused')
      assert.equal(jq.getJob(secondHeld.job_id)?.pause_origin, 'queue')
      const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf-8')).jobs as Job[]
      assert.equal(persisted.find(job => job.job_id === firstHeld.job_id)?.status, 'paused')
      assert.equal(persisted.find(job => job.job_id === firstHeld.job_id)?.pause_origin, 'queue')
      assert.equal(persisted.find(job => job.job_id === secondHeld.job_id)?.status, 'paused')
      assert.equal(persisted.find(job => job.job_id === secondHeld.job_id)?.pause_origin, 'queue')
    } finally {
      failProjectSnapshot = false
      if (jq.getJob(firstHeld.job_id)?.status === 'paused') await jq.resumeJob(firstHeld.job_id)
      if (jq.getJob(secondHeld.job_id)?.status === 'paused') await jq.resumeJob(secondHeld.job_id)
      const marker = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'video_assembly',
        episode_id: 'ROLLBACK-MARKER',
        title: 'rollback cleanup marker',
        params: {},
      })
      const markerDone = waitForJobStatus(marker.job_id, 'done')
      releaseBlocker.resolve()
      await markerDone
    }
  })
})

async function waitForTerminalJob(jobId: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const terminal = ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || '')
    if (terminal && !jq._isJobWorkerActiveForTesting(jobId)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(
    ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''),
    `job ${jobId} did not reach a terminal state before test cleanup`,
  )
  assert.equal(
    jq._isJobWorkerActiveForTesting(jobId),
    false,
    `job ${jobId} reached a terminal state but its worker did not release before test cleanup`,
  )
}

// Writing jobs auto-retry since R1 (2026-10-07); these pin manual Retry identities, so they opt out.
describe('manual Gateway chat retries', () => {
  test('an unresolved outline retry carries its recorded key to read-only recovery', async () => {
    const proj = await pm.createProject({ name: 'JQ Outline Exact Replay Key' })
    jq.registerExecutor('outline_only', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'pending:outline-recorded-key',
        operation: 'chat.response',
        state: 'submitting',
        updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/chat/responses', idempotency_key: 'outline-recorded-key',
          messages: [{ role: 'user', text: 'Plan the chapter structure. Recover this exact outline.', length: 59, truncated: false }],
          captured_at: new Date().toISOString(),
        },
      })
      throw new Error('outline submit outcome was lost')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'outline_only', episode_id: 'EP001', title: 'outline', params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)

    jq.registerExecutor('outline_only', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failed.job_id)

    assert.equal(retry.genstudio_chat_recovery, true)
    assert.equal(retry.genstudio_chat_recovery_key, 'outline-recorded-key')
    assert.equal(retry.genstudio_chat_recovery_purpose, 'outline')
    assert.deepEqual(retry.genstudio_chat_recovery_keys, ['outline-recorded-key'])
    await waitForTerminalJob(retry.job_id)
  })

  test('a terminal outline retry gets a fresh identity even if a sibling chapter retry is unresolved', async () => {
    const proj = await pm.createProject({ name: 'JQ Outline Terminal Retry Scope' })
    jq.registerExecutor('outline_only', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-outline-terminal', operation: 'chat.response', state: 'failed', updated_at: new Date().toISOString(),
      })
      throw new Error('outline terminal failure')
    })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'pending:chapter-unresolved', operation: 'chat.response', state: 'submitting', updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/chat/responses', idempotency_key: 'chapter-unresolved',
          messages: [{ role: 'user', text: 'Write 1 chapter. SLOTS TO WRITE NOW:\n  Chapter 1: Existing', length: 61, truncated: false }],
          captured_at: new Date().toISOString(),
        },
      })
      throw new Error('chapter submit outcome was lost')
    })
    const unresolvedChapter = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'EP001', title: 'chapters', params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(unresolvedChapter.job_id)
    const failedOutline = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'outline_only', episode_id: 'EP001', title: 'outline', params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failedOutline.job_id)

    jq.registerExecutor('outline_only', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failedOutline.job_id)

    assert.equal(retry.genstudio_chat_recovery, undefined)
    assert.equal(retry.genstudio_chat_retry_scope, `terminal:job-outline-terminal:${failedOutline.job_id}`)
    assert.equal(jq.getJob(unresolvedChapter.job_id)?.status, 'error')
    await waitForTerminalJob(retry.job_id)
  })

  test('a pre-dispatch credit refusal retries as fresh work instead of a dead by-key lookup', async () => {
    const proj = await pm.createProject({ name: 'JQ Credit Refusal Retry' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'pending:credit-refused-key',
        operation: 'chat.response',
        state: 'failed',
        dispatch_state: 'pre_dispatch',
        queue_state: 'waiting_credits',
        updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/chat/responses', idempotency_key: 'credit-refused-key',
          messages: [{ role: 'user', text: 'Write the next chapter batch.', length: 29, truncated: false }],
          captured_at: new Date().toISOString(),
        },
      })
      throw new Error('insufficient credits')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'EP001', title: 'chapters', params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failed.job_id)

    assert.equal(retry.genstudio_chat_recovery, undefined)
    assert.equal(retry.genstudio_chat_retry_scope, `credit-refused:credit-refused-key:${failed.job_id}`)
    await waitForTerminalJob(retry.job_id)
  })

  test('an unresolved narrative repair retry carries its exact recorded slots and key', async () => {
    const proj = await pm.createProject({ name: 'JQ Narrative Repair Exact Replay' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'pending:repair-recorded-key',
        operation: 'chat.response',
        state: 'submitting',
        updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/chat/responses', idempotency_key: 'repair-recorded-key',
          messages: [{
            role: 'user',
            text: 'RECOVERY INSTRUCTION: This is one bounded repair pass.\nSLOTS TO WRITE NOW:\n  Chapter 2: Second\n  Chapter 3: Third\nOUTPUT ONLY the requested chapter blocks.',
            length: 149,
            truncated: false,
          }],
          captured_at: new Date().toISOString(),
        },
      })
      throw new Error('repair submit outcome was lost')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'EP001', title: 'chapters', params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failed.job_id)

    assert.equal(retry.genstudio_chat_recovery, true)
    assert.equal(retry.genstudio_chat_recovery_key, 'repair-recorded-key')
    assert.equal(retry.genstudio_chat_recovery_purpose, 'narrative-repair')
    assert.deepEqual(retry.genstudio_chat_recovery_chapters, [2, 3])
    assert.deepEqual(retry.genstudio_chat_recovery_keys, ['repair-recorded-key'])
    await waitForTerminalJob(retry.job_id)
  })

  test('a failed chat alongside a running chat retains the original identity', async () => {
    const proj = await pm.createProject({ name: 'JQ Mixed Terminal And Running Chat' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-terminal-mixed-running', operation: 'chat.response', state: 'failed', updated_at: new Date().toISOString(),
      })
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-still-running', operation: 'chat.response', state: 'running', updated_at: new Date().toISOString(),
      })
      throw new Error('one batch is still reconcilable')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'EP001', title: 'chapters', params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)
    assert.equal(jq.getJob(failed.job_id)?.status, 'error')

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failed.job_id)
    assert.equal(retry.genstudio_chat_retry_scope, undefined)
    assert.equal(retry.genstudio_chat_recovery, true)
    await waitForTerminalJob(retry.job_id)
  })

  test('a failed chat alongside a pending request preview retains the original identity', async () => {
    const proj = await pm.createProject({ name: 'JQ Mixed Terminal And Pending Chat' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-terminal-mixed-pending', operation: 'chat.response', state: 'failed', updated_at: new Date().toISOString(),
      })
      await jq.recordGenStudioJob(job.job_id, {
        id: 'pending:story-chat-mixed', operation: 'chat.response', state: 'submitting', updated_at: new Date().toISOString(),
      })
      throw new Error('a submission response is still unresolved')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'EP001', title: 'chapters', params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)
    assert.equal(jq.getJob(failed.job_id)?.status, 'error')

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failed.job_id)
    assert.equal(retry.genstudio_chat_retry_scope, undefined)
    await waitForTerminalJob(retry.job_id)
  })

  test('a mixed chat retry ignores replacement params and replays the historical model', async () => {
    const proj = await pm.createProject({ name: 'JQ Mixed Chat Exact Replay' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-terminal-exact-replay', operation: 'chat.response', state: 'failed', updated_at: new Date().toISOString(),
      })
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-running-exact-replay', operation: 'chat.response', state: 'running', updated_at: new Date().toISOString(),
      })
      throw new Error('one submitted batch must be reattached')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'EP001', title: 'chapters', params: { model: 'old-model', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)
    assert.equal(jq.getJob(failed.job_id)?.status, 'error')

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalChapterExpansion(
      proj.slug,
      failed.job_id,
      'EP001',
      { model: 'new-selected-model' },
    )

    assert.equal(retry.params.model, 'old-model')
    assert.equal(retry.genstudio_chat_retry_scope, undefined)
    await waitForTerminalJob(retry.job_id)
  })

  test('an unresolved chapter retry can replay its exact identity while another unresolved attempt exists', async () => {
    const proj = await pm.createProject({ name: 'JQ Multiple Unresolved Chapter Replays' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: `pending:story-chat-${job.params.model}`,
        operation: 'chat.response',
        state: 'submitting',
        updated_at: new Date().toISOString(),
      })
      throw new Error('submission evidence still needs exact replay')
    })
    const older = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'expand_chapters',
      episode_id: 'EP001',
      title: 'chapters',
      params: { model: 'older-model', auto_retry: false },
    })
    await waitForTerminalJob(older.job_id)
    const newer = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'expand_chapters',
      episode_id: 'EP001',
      title: 'chapters',
      params: { model: 'newer-model', auto_retry: false },
    })
    await waitForTerminalJob(newer.job_id)

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalChapterExpansion(
      proj.slug,
      newer.job_id,
      'EP001',
      { model: 'deepseek-v4-flash' },
    )

    assert.equal(retry.params.model, 'newer-model')
    assert.equal(retry.genstudio_chat_retry_scope, undefined)
    assert.equal(jq.getJob(older.job_id)?.status, 'error')
    await waitForTerminalJob(retry.job_id)
  })

  test('generic Jobs Retry blocks a fresh chapter identity while another unresolved attempt exists', async () => {
    const proj = await pm.createProject({ name: 'JQ Jobs Retry Shared Fresh Guard' })
    let evidenceMode: 'unresolved' | 'settled' = 'unresolved'
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, evidenceMode === 'unresolved'
        ? {
            id: 'pending:story-chat-older',
            operation: 'chat.response',
            state: 'submitting',
            updated_at: new Date().toISOString(),
          }
        : {
            id: 'job-newer-failed',
            operation: 'chat.response',
            state: 'failed',
            updated_at: new Date().toISOString(),
          })
      throw new Error('terminal fixture')
    })
    const unresolved = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'expand_chapters',
      episode_id: 'EP001',
      title: 'chapters',
      params: { model: 'older-model', auto_retry: false },
    })
    await waitForTerminalJob(unresolved.job_id)
    evidenceMode = 'settled'
    const settledFailure = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'expand_chapters',
      episode_id: 'EP001',
      title: 'chapters',
      params: { model: 'newer-model', auto_retry: false },
    })
    await waitForTerminalJob(settledFailure.job_id)

    assert.throws(
      () => jq.retryTerminalJob(proj.slug, settledFailure.job_id),
      /another terminal chapter expansion has unresolved/i,
    )
    assert.equal(jq.getJob(unresolved.job_id)?.status, 'error')
    assert.equal(jq.getJob(settledFailure.job_id)?.status, 'error')

    jq.registerExecutor('expand_chapters', async () => {})
    const exactReplay = jq.retryTerminalJob(proj.slug, unresolved.job_id)
    assert.equal(exactReplay.params.model, 'older-model')
    assert.equal(exactReplay.genstudio_chat_retry_scope, undefined)
    await waitForTerminalJob(exactReplay.job_id)
  })

  test('a terminal chapter retry can replace historical params with the current validated form', async () => {
    const proj = await pm.createProject({ name: 'JQ Terminal Chat Retry Current Params' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-terminal-current-params',
        operation: 'chat.response',
        state: 'failed',
        updated_at: new Date().toISOString(),
      })
      throw new Error('The Gateway settled the request as terminal')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'expand_chapters',
      episode_id: 'EP001',
      title: 'chapters',
      params: { model: 'old-model', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)
    assert.equal(jq.getJob(failed.job_id)?.status, 'error')

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalChapterExpansion(
      proj.slug,
      failed.job_id,
      'EP001',
      { model: 'current-live-model' },
    )

    assert.equal(retry.params.model, 'current-live-model')
    assert.equal(retry.genstudio_chat_retry_scope, `terminal:job-terminal-current-params:${failed.job_id}`)
    assert.equal(jq.getJob(failed.job_id), null)
    await waitForTerminalJob(retry.job_id)
  })

  test('a failed chapter expansion receives a new scope only when the Gateway recorded a terminal chat job', async () => {
    const proj = await pm.createProject({ name: 'JQ Terminal Chat Retry Scope' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-terminal-chat-1',
        operation: 'chat.response',
        state: 'failed',
        failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
        updated_at: new Date().toISOString(),
      })
      throw new Error('The Gateway settled the request as terminal')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'expand_chapters',
      episode_id: 'EP001',
      title: 'chapters',
      params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)
    assert.equal(jq.getJob(failed.job_id)?.status, 'error')

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failed.job_id)

    assert.equal(
      retry.genstudio_chat_retry_scope,
      `terminal:job-terminal-chat-1:${failed.job_id}`,
      'the fresh chat identity must be derived from known terminal provider evidence',
    )
    await waitForTerminalJob(retry.job_id)
  })

  test('a retry after a lost provider response keeps its original identity', async () => {
    const proj = await pm.createProject({ name: 'JQ No Chat Retry Scope' })
    jq.registerExecutor('expand_chapters', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'job-submission-not-settled',
        operation: 'chat.response',
        state: 'running',
        updated_at: new Date().toISOString(),
      })
      throw new Error('connection lost before the Gateway returned a terminal result')
    })
    const failed = jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'expand_chapters',
      episode_id: 'EP001',
      title: 'chapters',
      params: { model: 'writer-alpha', auto_retry: false },
    })
    await waitForTerminalJob(failed.job_id)
    assert.equal(jq.getJob(failed.job_id)?.status, 'error')

    jq.registerExecutor('expand_chapters', async () => {})
    const retry = jq.retryTerminalJob(proj.slug, failed.job_id)

    assert.equal(
      retry.genstudio_chat_retry_scope,
      undefined,
      'an unsettled provider request must replay its original idempotency key',
    )
    await waitForTerminalJob(retry.job_id)
  })
})
