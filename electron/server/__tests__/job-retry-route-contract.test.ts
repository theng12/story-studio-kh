/**
 * Jobs Retry keeps saved work identities, adds the thumbnail gap-fill repair
 * intent, and mints a fresh language action for a metadata retry that has none —
 * otherwise the retry re-asks with the same deterministic identity and the
 * provider replays the very answer the finalizer audit already rejected.
 */
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
    return (status === 'error' || status === 'cancelled' || status === 'done')
      && !jq._isJobWorkerActiveForTesting(jobId)
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
          episode_id: 'EP0001', model: 'saved-metadata-model', force: true, auto_retry: false,
          sections: [{ id: 'description' }],
          generation_action: { id: '11111111-1111-4111-8111-111111111111', kind: 'fresh' },
          generation_action_fingerprint: 'metadata-action-fingerprint',
        },
      },
      {
        type: 'image_prompts',
        universal: true,
        params: {
          episode_id: 'EP0002', model: 'saved-thumbnail-model', thumb_count: 5, auto_retry: false,
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
      params: { episode_id: 'EP0003', mode: 'scenes', model: 'saved-scene-prompt-model', auto_retry: false },
    })
    await waitForTerminal(jq, retiredScenePrompts.job_id, 'retired scene prompts original failure')
    const retiredRetry = await request(app).post(`/api/projects/${project.slug}/jobs/${retiredScenePrompts.job_id}/retry`).send({})
    assert.equal(retiredRetry.status, 409, JSON.stringify(retiredRetry.body))
    assert.match(retiredRetry.body.detail, /Scene Plan/)
    assert.equal(jq.getJob(retiredScenePrompts.job_id)?.job_id, retiredScenePrompts.job_id, 'a retired scene-prompt retry retains its terminal history')

    // A metadata job from the Pipeline/bare route carries no saved action. Retrying
    // it must ask the provider for a NEW answer; with the deterministic identity it
    // would replay the short answer the audit rejected (NEW-14).
    const bareProject = await pm.createProject({ name: 'Jobs Retry metadata without a saved action' })
    jq.registerExecutor('metadata', async () => { throw new Error('first bare metadata attempt failed') })
    const bare = jq.enqueuePreparedForTest({
      project_slug: bareProject.slug,
      type: 'metadata',
      episode_id: 'EP0007',
      title: 'Bare metadata failure',
      params: { episode_id: 'EP0007', title: 'Bare metadata', model: 'saved-metadata-model', force: true, auto_retry: false },
    })
    await waitForTerminal(jq, bare.job_id, 'bare metadata original failure')
    let bareRetryParams: Record<string, any> | undefined
    jq.registerExecutor('metadata', async job => { bareRetryParams = structuredClone(job.params) })
    const bareRetry = await request(app).post(`/api/projects/${bareProject.slug}/jobs/${bare.job_id}/retry`).send({})
    assert.equal(bareRetry.status, 202, JSON.stringify(bareRetry.body))
    await waitForTerminal(jq, bareRetry.body.job.job_id, 'bare metadata retry')
    assert.ok(bareRetryParams, 'the retried metadata job ran')
    assert.equal(bareRetryParams!.generation_action?.kind, 'fresh', 'a retry without a saved action mints one')
    assert.match(String(bareRetryParams!.generation_action?.id), /^[0-9a-f-]{36}$/i)
    assert.ok(String(bareRetryParams!.generation_action_fingerprint || '').length >= 32, 'the minted action carries a fingerprint')
    assert.equal(bareRetryParams!.generation_action?.origin, 'retry', 'a minted action records that a retry made it')
    assert.deepEqual(
      Object.fromEntries(Object.entries(bareRetryParams!).filter(([key]) => !key.startsWith('generation_action'))),
      { episode_id: 'EP0007', title: 'Bare metadata', model: 'saved-metadata-model', force: true, auto_retry: false },
      'a minted action changes nothing else about the saved request',
    )

    // Retrying the retry must mint again. Preserving the first mint would replay
    // the same answer and leave the customer in the loop the message promises to
    // break (this was caught live before the marker existed).
    jq.registerExecutor('metadata', async () => { throw new Error('retried metadata failed again') })
    const secondOriginal = jq.enqueuePreparedForTest({
      project_slug: bareProject.slug,
      type: 'metadata',
      episode_id: 'EP0007',
      title: 'Bare metadata failure again',
      params: bareRetryParams!,
    })
    await waitForTerminal(jq, secondOriginal.job_id, 'second bare metadata failure')
    let secondRetryParams: Record<string, any> | undefined
    jq.registerExecutor('metadata', async job => { secondRetryParams = structuredClone(job.params) })
    const secondRetry = await request(app).post(`/api/projects/${bareProject.slug}/jobs/${secondOriginal.job_id}/retry`).send({})
    assert.equal(secondRetry.status, 202, JSON.stringify(secondRetry.body))
    await waitForTerminal(jq, secondRetry.body.job.job_id, 'second bare metadata retry')
    assert.ok(secondRetryParams, 'the second retried metadata job ran')
    assert.notEqual(
      secondRetryParams!.generation_action?.id,
      bareRetryParams!.generation_action?.id,
      'each retry of a bare metadata job asks the provider afresh',
    )

    // A retry whose earlier chat answer the Gateway already holds must collect it by the saved key,
    // not mint a new action (live EP0113: the first answer succeeded, Retry paid again). Only a
    // confirmed failure / never-created request asks afresh; a page-set action is untouched.
    const evidenceCases: Array<{ label: string; entry: Record<string, unknown>; rejected?: true; reuses: boolean }> = [
      { label: 'succeeded', entry: { state: 'succeeded' }, reuses: true },
      { label: 'succeeded but rejected by Story', entry: { state: 'succeeded' }, rejected: true, reuses: false },
      { label: 'failed', entry: { state: 'failed', failure_code: 'PROVIDER_ERROR' }, reuses: false },
      { label: 'not created', entry: { state: 'not_created', dispatch_state: 'pre_dispatch' }, reuses: false },
    ]
    for (const { label, entry, rejected, reuses } of evidenceCases) {
      const evidenceProject = await pm.createProject({ name: `Jobs Retry metadata evidence ${label}` })
      const savedParams = {
        episode_id: 'EP0113', title: 'Evidence', model: 'saved-metadata-model', force: true, auto_retry: false,
        generation_action: { id: '33333333-3333-4333-8333-333333333333', kind: 'fresh', origin: 'retry' },
        generation_action_fingerprint: 'f'.repeat(64),
      }
      jq.registerExecutor('metadata', async job => {
        await jq.recordGenStudioJob(job.job_id, {
          id: `chat-${label}`, operation: 'chat.response', model_id: 'm', updated_at: new Date().toISOString(),
          request: { method: 'POST', path: '/v1/chat/responses', idempotency_key: 'story-chat-saved-key', captured_at: new Date().toISOString() },
          ...entry,
        } as any)
        if (rejected) job.result = { ...(job.result || {}), chat_answer_rejected: true }
        throw new Error('metadata finished without usable fields')
      })
      const failed = jq.enqueuePreparedForTest({
        project_slug: evidenceProject.slug, type: 'metadata', episode_id: 'EP0113', title: `Evidence ${label}`, params: structuredClone(savedParams),
      })
      await waitForTerminal(jq, failed.job_id, `${label} evidence original failure`)
      let ranParams: Record<string, any> | undefined
      jq.registerExecutor('metadata', async job => { ranParams = structuredClone(job.params) })
      const retry = await request(app).post(`/api/projects/${evidenceProject.slug}/jobs/${failed.job_id}/retry`).send({})
      assert.equal(retry.status, 202, JSON.stringify(retry.body))
      await waitForTerminal(jq, retry.body.job.job_id, `${label} evidence retry`)
      assert.ok(ranParams, `${label}: the retried metadata job ran`)
      if (reuses) {
        assert.deepEqual(ranParams!.generation_action, savedParams.generation_action, `${label}: the saved action (and so its key) is reused`)
        assert.equal(ranParams!.generation_action_fingerprint, savedParams.generation_action_fingerprint)
      } else {
        assert.notEqual(ranParams!.generation_action?.id, savedParams.generation_action.id, `${label}: a fresh action is minted`)
      }
    }

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
      const { generation_action, generation_action_fingerprint, ...migratedSaved } = migratedParams as Record<string, any>
      assert.deepEqual(migratedSaved, params, `legacy thumbnail retry ${label} keeps its exact saved parameters`)
      assert.equal(generation_action?.kind, 'fresh', 'an image Retry mints a fresh generation action')
      assert.match(String(generation_action?.id), /^[0-9a-f-]{36}$/i,
        'the new action owns a provider key that cannot replay the failed Gateway job')
      assert.ok(String(generation_action_fingerprint || '').length >= 32)
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
      params: { episode_id: 'EP0003', model: 'saved-thumbnail-model', auto_retry: false },
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
