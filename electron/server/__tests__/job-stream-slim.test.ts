/**
 * The live job streams carry a slim job: the Gateway evidence list, the recovery map and the scene
 * list stay on the per-job GET. A running job is re-sent only when what the stream carries changed.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})
after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

const AT = '2026-10-06T12:00:00.000Z'

/** A finished 300-scene review shaped like a real record (≈400 KB on disk). */
function sceneReview(projectSlug: string): Job {
  const scenes = Array.from({ length: 300 }, (_, i) => i + 1)
  return {
    job_id: 'review-300', project_slug: projectSlug, type: 'continuity_render', episode_id: 'EP0002', title: 'Scene Review',
    status: 'done', created_at: AT, started_at: AT, finished_at: AT, error: null,
    output_lines: Array.from({ length: 20 }, (_, i) => `Scene ${i + 1} ready.`),
    params: {
      model: 'studio-hub::flux',
      scenes: scenes.map(n => ({ scene: n, prompt: `A quiet glasshouse at midnight, scene ${n}, soft blue light`, duration: 7.5 })),
      genstudio_recovery: { version: 1, route: 'genstudio', assets: Object.fromEntries(scenes.map(n => [`ep0002-scene-${n}.png`, {
        operation: 'image', idempotency_key: `story-image-${'a'.repeat(40)}${n}`, job_id: `task-${n}`,
        output_path: `/Volumes/Projects/Show/episodes/Season 001/EP0002/EP0002 - 05 Scene Images/ep0002-scene-${n}.png`,
        input_hash: 'sha256:052dd8bb9d83443e', state: 'succeeded', updated_at: AT,
      }])) },
    },
    genstudio_jobs: scenes.map(n => ({
      id: `task-${n}`, operation: 'image.generation', state: n === 300 ? 'running' : 'succeeded', model_id: 'studio-hub::flux',
      queue_state: n === 300 ? 'running' : 'succeeded', updated_at: n === 300 ? '2026-10-06T12:00:09.000Z' : AT,
      request_key: `story-image-${'b'.repeat(40)}${n}`, dispatch_state: 'dispatched', reserved_credits: 0, settled_credits: 0,
      released_credits: 0, returned_credits: 0, failure_code: null, waiting: null, queue_position: null,
      request: { method: 'POST', path: '/v1/images/generations', idempotency_key: `k-${n}`, captured_at: AT },
    })) as any,
  }
}

test('a 300-scene review streams in a few KB; the per-job GET keeps every field', async () => {
  const project = await pm.createProject({ name: 'Slim Stream' })
  const job = sceneReview(project.slug)
  await jq.writeAuthoritativeJob(job)
  const full = (await jq.getJobs(project.slug)).find(row => row.job_id === job.job_id)!
  const slim = (await jq.getJobs(project.slug, { view: 'stream' })).find(row => row.job_id === job.job_id) as any
  const fullBytes = JSON.stringify(full).length
  const slimBytes = JSON.stringify(slim).length
  assert.ok(fullBytes > 150_000, `fixture is a realistic large record (${fullBytes} bytes)`)
  assert.ok(slimBytes < 4_096, `the streamed record is ${slimBytes} bytes`)
  assert.equal(slim.genstudio_jobs, undefined)
  assert.equal(slim.params.genstudio_recovery, undefined)
  assert.equal(slim.params.scenes, undefined)
  assert.equal(slim.params.model, 'studio-hub::flux', 'the rest of params stays')
  assert.equal(slim.genstudio_jobs_count, 300)
  assert.deepEqual(slim.genstudio_jobs_operations, ['image.generation'])
  assert.deepEqual(slim.genstudio_jobs_active.map((entry: any) => entry.id), ['task-300'], 'only the unsettled entry')
  assert.equal(slim.genstudio_jobs_active[0].request, undefined, 'without its request preview')
  assert.equal(slim.genstudio_jobs_updated_at, '2026-10-06T12:00:09.000Z')
  assert.equal(slim.genstudio_settlement_open, false, 'free fleet work has no settlement to wait for')
  assert.deepEqual(slim.controls, full.controls, 'controls are still classified from the full record')

  const { router } = await import('../routes/jobs.js')
  const response = await request(express().use(router)).get(`/projects/${project.slug}/jobs/${job.job_id}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.genstudio_jobs.length, 300, 'the Jobs page detail read stays full')
  assert.equal(Object.keys(response.body.params.genstudio_recovery.assets).length, 300)
  assert.equal(response.body.params.scenes.length, 300)
})

test('terminal evidence is closed regardless of retired settlement fields', async () => {
  const project = await pm.createProject({ name: 'Open Settlement' })
  const job = { ...sceneReview(project.slug), job_id: 'paid-open' }
  job.genstudio_jobs = [
    { id: 'p1', operation: 'image.generation', state: 'succeeded', model_id: 'paid-model', reserved_credits: 4, settled_credits: 4, released_credits: 0, updated_at: AT },
    { id: 'p2', operation: 'image.generation', state: 'succeeded', model_id: 'paid-model', reserved_credits: 4, settled_credits: 3, updated_at: AT },
  ] as any
  await jq.writeAuthoritativeJob(job)
  const slim = (await jq.getJobs(project.slug, { view: 'stream' })).find(row => row.job_id === job.job_id) as any
  assert.equal(slim.genstudio_settlement_open, false)
  assert.deepEqual(slim.genstudio_jobs_active, [])
  await jq.recordGenStudioJob(job.job_id, {
    id: 'p3', operation: 'image.generation', state: 'running', model_id: 'paid-model', updated_at: AT,
  })
  const running = (await jq.getJobs(project.slug, { view: 'stream' })).find(row => row.job_id === job.job_id) as any
  assert.equal(running.genstudio_settlement_open, true)
  assert.deepEqual(running.genstudio_jobs_active.map((entry: any) => entry.id), ['p3'])
})

test('a running job is re-sent only when what the stream carries changed', async () => {
  const project = await pm.createProject({ name: 'Stream Dedupe' })
  const events: any[] = []
  const onUpdate = (row: any) => { if (row.project_slug === project.slug) events.push(row) }
  jq.jobEvents.on('update', onUpdate)
  let release!: () => void
  const finished = new Promise<void>(resolve => { release = resolve })
  const counted: number[] = []
  const executed = new Promise<void>(resolve => {
    jq.registerExecutor('scene_image_generate', async () => {
      const id = jq.currentJobId()!
      const evidence = { id: 'task-1', operation: 'image.generation', state: 'running', updated_at: AT } as any
      jq._flushDirtyJobStreamsForTesting()
      const start = events.length
      await jq.recordGenStudioJob(id, evidence)
      jq._flushDirtyJobStreamsForTesting()
      counted.push(events.length - start)
      await jq.recordGenStudioJob(id, { ...evidence })
      jq._flushDirtyJobStreamsForTesting()
      await jq.recordGenStudioJob(id, { ...evidence })
      jq._flushDirtyJobStreamsForTesting()
      counted.push(events.length - start)
      await jq.recordGenStudioJob(id, { ...evidence, state: 'succeeded', updated_at: '2026-10-06T12:00:05.000Z' })
      jq._flushDirtyJobStreamsForTesting()
      counted.push(events.length - start)
      resolve()
      await finished
    })
  })
  const wasPaused = jq.isQueuePaused()
  if (wasPaused) await jq.setQueuePaused(false)
  try {
    await jq.enqueue({ project_slug: project.slug, type: 'scene_image_generate', episode_id: 'EP0001', title: 'dedupe' })
    await executed
    assert.deepEqual(counted, [1, 1, 2], 'new evidence is sent once, identical records are not, a state change is')
    assert.equal(events.at(-1).genstudio_jobs, undefined, 'stream events carry the slim view')
    assert.equal(events.at(-1).genstudio_jobs_count, 1)
  } finally {
    release()
    jq.jobEvents.off('update', onUpdate)
    if (wasPaused) await jq.setQueuePaused(true)
  }
})
