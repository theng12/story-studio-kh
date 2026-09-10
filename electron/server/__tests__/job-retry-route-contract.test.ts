/** Jobs Retry keeps saved work identities and adds only the thumbnail gap-fill repair intent. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import type { Job, JobType } from '../models/types.js'

async function waitForTerminal(
  jq: typeof import('../services/job-queue.js'),
  jobId: string,
  label: string,
): Promise<void> {
  await waitFor(() => {
    const status = jq.getJob(jobId)?.status
    return status === 'error' || status === 'cancelled' || status === 'done'
  }, { label, timeoutMs: 2_000 })
}

void test('Jobs Retry preserves saved fresh actions, adds thumbnail fill-gaps, and never removes an unsettled original', async () => {
  const temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Jobs Retry route contract' })

    const queuedParams: Array<{ type: JobType; params: Record<string, unknown>; universal?: boolean }> = [
      {
        type: 'metadata',
        params: {
          episode_id: 'EP0001', model: 'saved-metadata-model', force: true,
          sections: [{ id: 'description' }],
          generation_action: { id: '11111111-1111-4111-8111-111111111111', kind: 'fresh' },
          generation_action_fingerprint: 'metadata-action-fingerprint',
        },
      },
      {
        type: 'image_prompts',
        universal: true,
        params: {
          episode_id: 'EP0002', model: 'saved-thumbnail-model', thumb_count: 5,
          generation_action: { id: '22222222-2222-4222-8222-222222222222', kind: 'fresh' },
          generation_action_fingerprint: 'thumbnail-action-fingerprint',
        },
      },
    ]

    for (const { type, params, universal } of queuedParams) {
      jq.registerExecutor(type, async () => { throw new Error(`first ${type} attempt failed`) })
      const original = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type,
        episode_id: String(params.episode_id),
        title: `Failed ${type}`,
        params,
      })
      await waitForTerminal(jq, original.job_id, `${type} original failure`)
      assert.equal(jq.getJob(original.job_id)?.status, 'error')

      let retriedParams: Record<string, unknown> | undefined
      jq.registerExecutor(type, async job => { retriedParams = structuredClone(job.params) })
      const retryPath = universal
        ? `/api/jobs/all/${original.job_id}/retry`
        : `/api/projects/${project.slug}/jobs/${original.job_id}/retry`
      const retry = await request(app).post(retryPath).send({})
      assert.equal(retry.status, 202, JSON.stringify(retry.body))
      assert.notEqual(retry.body.job.job_id, original.job_id)
      assert.equal(jq.getJob(original.job_id), null, 'only an admitted retry may replace its terminal original')
      await waitForTerminal(jq, retry.body.job.job_id, `${type} retry`)

      const expected = type === 'image_prompts' ? { ...params, fill_gaps: true } : params
      assert.deepEqual(retriedParams, expected, `${type} retry keeps its durable action and exact saved parameters`)
    }

    jq.registerExecutor('image_prompts', async () => { throw new Error('retired scene-prompt job failed') })
    const retiredScenePrompts = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'image_prompts',
      episode_id: 'EP0003',
      title: 'Retired scene prompts',
      params: { episode_id: 'EP0003', mode: 'scenes', model: 'saved-scene-prompt-model' },
    })
    await waitForTerminal(jq, retiredScenePrompts.job_id, 'retired scene prompts original failure')
    const retiredRetry = await request(app).post(`/api/projects/${project.slug}/jobs/${retiredScenePrompts.job_id}/retry`).send({})
    assert.equal(retiredRetry.status, 409, JSON.stringify(retiredRetry.body))
    assert.match(retiredRetry.body.detail, /Scene Plan/)
    assert.equal(jq.getJob(retiredScenePrompts.job_id)?.job_id, retiredScenePrompts.job_id, 'a retired scene-prompt retry retains its terminal history')

    for (const [label, params] of [
      ['without a mode', { episode_id: 'EP0004', model: 'saved-thumbnail-model' }],
      ['with thumbnail mode', { episode_id: 'EP0005', mode: 'thumbs', model: 'saved-thumbnail-model' }],
    ] as const) {
      const legacyProject = await pm.createProject({ name: `Jobs Retry legacy thumbnails ${label}` })
      const legacyImages: Job = {
        job_id: `legacy-images-${params.episode_id}`,
        project_slug: legacyProject.slug,
        type: 'images' as JobType,
        episode_id: params.episode_id,
        title: `Legacy thumbnails ${label}`,
        status: 'error',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: 'Original thumbnail run failed.',
        output_lines: [],
        params,
      }
      await fs.writeFile(
        path.join(temp.dir, 'projects', legacyProject.slug, 'jobs.json'),
        JSON.stringify({ jobs: [legacyImages] }),
      )
      await jq.getJobs(legacyProject.slug)
      let migratedParams: Record<string, unknown> | undefined
      jq.registerExecutor('thumb_images', async job => { migratedParams = structuredClone(job.params) })
      const migrated = await request(app).post(`/api/projects/${legacyProject.slug}/jobs/${legacyImages.job_id}/retry`).send({})
      assert.equal(migrated.status, 202, JSON.stringify(migrated.body))
      assert.equal(migrated.body.job.type, 'thumb_images')
      assert.notEqual(migrated.body.job.job_id, legacyImages.job_id)
      assert.equal(jq.getJob(legacyImages.job_id), null, 'only the admitted thumbnail replacement clears legacy history')
      await waitForTerminal(jq, migrated.body.job.job_id, `legacy images retry ${label}`)
      assert.deepEqual(migratedParams, params, `legacy thumbnail retry ${label} keeps its exact saved parameters`)
    }

    const legacySceneProject = await pm.createProject({ name: 'Jobs Retry legacy scenes remain blocked' })
    const legacyScenes: Job = {
      job_id: 'legacy-images-scenes', project_slug: legacySceneProject.slug,
      type: 'images' as JobType, episode_id: 'EP0006', title: 'Retired scene images',
      status: 'error', created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(), error: 'Original scene run failed.', output_lines: [],
      params: { episode_id: 'EP0006', mode: 'scenes', model: 'saved-scene-model' },
    }
    await fs.writeFile(
      path.join(temp.dir, 'projects', legacySceneProject.slug, 'jobs.json'),
      JSON.stringify({ jobs: [legacyScenes] }),
    )
    await jq.getJobs(legacySceneProject.slug)
    const blockedLegacyScenes = await request(app).post(`/api/projects/${legacySceneProject.slug}/jobs/${legacyScenes.job_id}/retry`).send({})
    assert.equal(blockedLegacyScenes.status, 409, JSON.stringify(blockedLegacyScenes.body))
    assert.match(blockedLegacyScenes.body.detail, /Scene Review/)
    assert.equal(jq.getJob(legacyScenes.job_id)?.job_id, legacyScenes.job_id, 'a retired scene-image retry keeps its terminal history')

    const unsettledProject = await pm.createProject({ name: 'Jobs Retry keeps unsettled evidence' })
    const unsettled: Job = {
      job_id: 'unsettled-thumbnail-retry',
      project_slug: unsettledProject.slug,
      type: 'image_prompts',
      episode_id: 'EP0003',
      title: 'Unsettled thumbnail prompts',
      status: 'error',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: 'Local request lost after submission.',
      output_lines: [],
      params: { episode_id: 'EP0003', model: 'saved-thumbnail-model' },
      genstudio_jobs: [{
        id: 'pending:thumbnail-retry-key', operation: 'image.generation', state: 'submitting',
        queue_state: 'submitting', updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/images', captured_at: new Date().toISOString(),
          idempotency_key: 'thumbnail-retry-key',
        },
      }],
      remote_cancellations: {},
    }
    await fs.writeFile(
      path.join(temp.dir, 'projects', unsettledProject.slug, 'jobs.json'),
      JSON.stringify({ jobs: [unsettled] }),
    )
    await jq.getJobs(unsettledProject.slug)
    const rejected = await request(app).post(`/api/projects/${unsettledProject.slug}/jobs/${unsettled.job_id}/retry`).send({})
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body))
    assert.equal(jq.getJob(unsettled.job_id)?.job_id, unsettled.job_id, 'a refused retry retains its evidence-bearing original row')
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})
