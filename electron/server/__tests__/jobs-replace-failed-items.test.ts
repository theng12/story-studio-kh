import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

async function bootApp(): Promise<typeof import('../app.js').app> {
  const app = (await import('../app.js')).app
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot before failed-item replacement fixtures' })
  return app
}

const settledFailure = (id: string, operation: 'voice.tts' | 'chat.response', failureCode: string) => ({
  id,
  operation,
  state: 'failed',
  dispatch_state: 'dispatched' as const,
  failure_code: failureCode,
  failure_class: 'provider_transient',
  reserved_credits: 8,
  settled_credits: 3,
  released_credits: 5,
  updated_at: '2026-09-11T00:00:00.000Z',
})

test('Jobs Replace failed items queues only confirmed failed audio sections and writing requests', async t => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const app = await bootApp()
  const live = new Map<string, Record<string, unknown>>()
  const provider = http.createServer((req, res) => {
    const match = req.url?.match(/^\/v1\/(?:jobs|chat\/responses)\/by-idempotency-key\/([^/?]+)$/)
    const item = match ? live.get(decodeURIComponent(match[1]!)) : undefined
    res.writeHead(item ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(item || { detail: 'not found' }))
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const address = provider.address()
  assert.ok(address && typeof address === 'object')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  await settings.setGenStudioUrl(`http://127.0.0.1:${address.port}`)
  await secrets.setApiKey('genstudio', 'gsk_failed_item_replacement_test')
  const wasPaused = jq.isQueuePaused()
  const fixtureJobs: Array<{ projectSlug: string; jobId: string }> = []
  await jq.setQueuePaused(true)
  try {
    await t.test('audio keeps successful sections and removes overwrite authority', async () => {
      const project = await pm.createProject({ name: 'Jobs audio failed-item replacement' })
      const original = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'audio',
        episode_id: 'EP001',
        title: 'Audio all',
        params: {
          episode_id: 'EP001', model: 'tts-live', voice: 'voice-live', sections: 'all',
          force: true, no_overwrite: true, generation_action: { id: 'old', kind: 'fresh' },
          genstudio_recovery: {
            version: 1, route: 'genstudio', assets: {
              'EP001_Chapter_01.mp3': { operation: 'tts', idempotency_key: 'story-a', job_id: 'tts-failed', state: 'failed', updated_at: '2026-09-11T00:00:00.000Z' },
              'EP001_Chapter_02.mp3': { operation: 'tts', idempotency_key: 'story-b', job_id: 'tts-succeeded', state: 'succeeded', updated_at: '2026-09-11T00:00:00.000Z' },
            },
          },
        },
      })
      fixtureJobs.push({ projectSlug: project.slug, jobId: original.job_id })
      await jq.forceAbandonJob(project.slug, original.job_id)
      await jq.mutateAuthoritativeJob(project.slug, original.job_id, job => ({
        ...job,
        status: 'error',
        force_abandoned: undefined,
        finished_at: new Date().toISOString(),
        error: 'one section failed',
        genstudio_jobs: [
          settledFailure('tts-failed', 'voice.tts', 'SITE_PLACEMENT_EXHAUSTED'),
          { id: 'tts-succeeded', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-09-11T00:01:00.000Z' },
        ],
      }))
      live.set('story-a', settledFailure('tts-failed', 'voice.tts', 'SITE_PLACEMENT_EXHAUSTED'))

      const response = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${original.job_id}/replace-failed-items`)
        .send({})
      assert.equal(response.status, 202, JSON.stringify(response.body))
      assert.equal(response.body.job.type, 'audio')
      assert.notEqual(response.body.job.job_id, original.job_id)
      assert.equal(response.body.job.params.sections, 'Chapter_01')
      assert.equal(response.body.job.params.force, undefined)
      assert.equal(response.body.job.params.no_overwrite, undefined)
      assert.equal(response.body.job.params.generation_action, undefined)
      assert.equal(response.body.job.params.jobs_replace_failed_items.item_count, 1)
      assert.equal(response.body.job.status, 'queued')
      fixtureJobs.push({ projectSlug: project.slug, jobId: response.body.job.job_id })
    })

    await t.test('chapter expansion narrows the retry to the failed request slots', async () => {
      const project = await pm.createProject({ name: 'Jobs writing failed-item replacement' })
      const original = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'expand_chapters',
        episode_id: 'EP002',
        title: 'Expand chapters',
        params: { episode_id: 'EP002', title: 'Episode', model: 'chat-live', auto_approve: true },
      })
      fixtureJobs.push({ projectSlug: project.slug, jobId: original.job_id })
      await jq.forceAbandonJob(project.slug, original.job_id)
      const failed = {
        ...settledFailure('chat-failed', 'chat.response', 'LANGUAGE_PROVIDER_FAILED'),
        request: {
          method: 'POST', path: '/v1/chat/responses', idempotency_key: 'story-chat-failed', captured_at: '2026-09-11T00:00:00.000Z',
          messages: [{
            role: 'user', truncated: false, length: 110,
            text: 'Write 2 chapter(s) of an in-progress episode.\nSLOTS TO WRITE NOW:\nChapter 3: Three\nChapter 4: Four\nOUTPUT FORMAT:',
          }],
        },
      }
      await jq.mutateAuthoritativeJob(project.slug, original.job_id, job => ({
        ...job,
        status: 'error',
        force_abandoned: undefined,
        finished_at: new Date().toISOString(),
        error: 'one writing request failed',
        genstudio_jobs: [
          { id: 'chat-ok', operation: 'chat.response', state: 'succeeded', updated_at: '2026-09-11T00:00:30.000Z' },
          failed,
        ],
      }))
      live.set('story-chat-failed', failed)

      const response = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${original.job_id}/replace-failed-items`)
        .send({})
      assert.equal(response.status, 202, JSON.stringify(response.body))
      assert.equal(response.body.job.type, 'expand_chapters')
      assert.deepEqual(response.body.job.params.chapters_to_expand, [3, 4])
      assert.equal(response.body.job.params.jobs_replace_failed_items.item_count, 1)
      assert.equal(response.body.job.status, 'queued')
      fixtureJobs.push({ projectSlug: project.slug, jobId: response.body.job.job_id })
    })

    await t.test('other durable writing jobs keep their saved scope and receive a fresh chat identity', async () => {
      const project = await pm.createProject({ name: 'Jobs metadata failed-item replacement' })
      const original = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'metadata',
        episode_id: 'EP003',
        title: 'Metadata',
        params: { episode_id: 'EP003', model: 'chat-live', title: 'Saved episode title' },
      })
      fixtureJobs.push({ projectSlug: project.slug, jobId: original.job_id })
      await jq.forceAbandonJob(project.slug, original.job_id)
      const failed = {
        ...settledFailure('metadata-failed', 'chat.response', 'LANGUAGE_PROVIDER_FAILED'),
        request_key: 'story-metadata-failed',
      }
      await jq.mutateAuthoritativeJob(project.slug, original.job_id, job => ({
        ...job, status: 'error', force_abandoned: undefined, finished_at: new Date().toISOString(), error: 'metadata request failed',
        genstudio_jobs: [failed],
      }))
      live.set('story-metadata-failed', failed)

      const response = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${original.job_id}/replace-failed-items`)
        .send({})
      assert.equal(response.status, 202, JSON.stringify(response.body))
      assert.equal(response.body.job.type, 'metadata')
      assert.equal(response.body.job.params.title, 'Saved episode title')
      assert.equal(response.body.job.manual_failed_item_replacement, undefined)
      fixtureJobs.push({ projectSlug: project.slug, jobId: response.body.job.job_id })
      const privateJob = jq.getJob(response.body.job.job_id)
      assert.equal(privateJob?.manual_failed_item_replacement?.requests[0]?.original_idempotency_key, 'story-metadata-failed')
      const replacementKey = privateJob?.manual_failed_item_replacement?.requests[0]?.replacement_idempotency_key || ''
      assert.match(replacementKey, /^story-manual-/)

      const { manualFailedItemChatRequestKey } = await import('../lib/genstudio-client.js')
      assert.equal(manualFailedItemChatRequestKey(privateJob, 'story-metadata-failed'), replacementKey)
      assert.throws(
        () => manualFailedItemChatRequestKey(privateJob, 'story-unrecorded-request'),
        /scope no longer matches.*No provider work was submitted/i,
      )
      assert.equal(manualFailedItemChatRequestKey({
        ...privateJob!,
        genstudio_jobs: [{
          id: 'metadata-succeeded', operation: 'chat.response', state: 'succeeded', request_key: 'story-metadata-ok',
          updated_at: '2026-09-11T00:01:00.000Z',
        }],
      }, 'story-metadata-ok'), 'story-metadata-ok')
      assert.equal(manualFailedItemChatRequestKey({
        ...privateJob!,
        generation_replacement_attempts: [{
          kind: 'writing', item_key: 'metadata', original_task_id: 'metadata-failed',
          original_idempotency_key: 'story-metadata-failed', idempotency_key: 'story-automatic-replacement',
          max_credits: 8, state: 'submitted', revision: 2,
        }],
      }, 'story-metadata-failed'), 'story-metadata-failed')

      const duplicate = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${original.job_id}/replace-failed-items`)
        .send({})
      assert.equal(duplicate.status, 202)
      assert.equal(duplicate.body.job.job_id, response.body.job.job_id, 'same source click reuses its replacement child')

      await jq.forceAbandonJob(project.slug, response.body.job.job_id)
      const uncertainReplacement = {
        ...settledFailure('metadata-replacement-failed', 'chat.response', 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN'),
        request_key: replacementKey,
      }
      await jq.mutateAuthoritativeJob(project.slug, response.body.job.job_id, job => ({
        ...job,
        status: 'error',
        force_abandoned: undefined,
        finished_at: new Date().toISOString(),
        error: 'replacement response was interrupted',
        genstudio_jobs: [uncertainReplacement],
      }))
      const exactRetry = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${response.body.job.job_id}/retry`)
        .send({})
      assert.equal(exactRetry.status, 202, JSON.stringify(exactRetry.body))
      fixtureJobs.push({ projectSlug: project.slug, jobId: exactRetry.body.job.job_id })
      const privateRetry = jq.getJob(exactRetry.body.job.job_id)
      assert.equal(privateRetry?.manual_failed_item_replacement?.requests[0]?.replacement_idempotency_key, replacementKey)
      assert.ok(privateRetry?.genstudio_jobs?.some(entry => entry.request_key === replacementKey))

      await jq.forceAbandonJob(project.slug, exactRetry.body.job.job_id)
      const failedReplacement = {
        ...settledFailure('metadata-replacement-failed', 'chat.response', 'LANGUAGE_PROVIDER_INCOMPLETE'),
        request_key: replacementKey,
      }
      live.set(replacementKey, failedReplacement)
      await jq.mutateAuthoritativeJob(project.slug, exactRetry.body.job.job_id, job => ({
        ...job,
        status: 'error',
        force_abandoned: undefined,
        finished_at: new Date().toISOString(),
        error: 'replacement returned incomplete output',
        genstudio_jobs: [failedReplacement],
      }))
      const deliberateFollowUp = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${exactRetry.body.job.job_id}/replace-failed-items`)
        .send({})
      assert.equal(deliberateFollowUp.status, 202, JSON.stringify(deliberateFollowUp.body))
      assert.notEqual(deliberateFollowUp.body.job.job_id, exactRetry.body.job.job_id)
      assert.equal(deliberateFollowUp.body.job.params.jobs_replace_failed_items.source_job_id, exactRetry.body.job.job_id)
      fixtureJobs.push({ projectSlug: project.slug, jobId: deliberateFollowUp.body.job.job_id })
      const privateFollowUp = jq.getJob(deliberateFollowUp.body.job.job_id)
      assert.equal(privateFollowUp?.manual_failed_item_replacement?.requests[0]?.prepared_idempotency_key, 'story-metadata-failed')
      assert.equal(
        manualFailedItemChatRequestKey(privateFollowUp, 'story-metadata-failed'),
        privateFollowUp?.manual_failed_item_replacement?.requests[0]?.replacement_idempotency_key,
      )
    })

    await t.test('uncertain, cancelled, malformed, credit and unresolved work stays blocked', async () => {
      const project = await pm.createProject({ name: 'Jobs failed-item replacement exclusions' })
      const cases = [
        ['uncertain', settledFailure('uncertain', 'voice.tts', 'CLOUD_SUBMISSION_UNCERTAIN')],
        ['cancelled', { ...settledFailure('cancelled', 'voice.tts', 'SITE_PLACEMENT_EXHAUSTED'), cancelled: true }],
        ['malformed', settledFailure('malformed', 'voice.tts', 'MALFORMED_REQUEST')],
        ['credit', { ...settledFailure('credit', 'voice.tts', 'INSUFFICIENT_CREDITS'), dispatch_state: 'pre_dispatch' as const }],
        ['unresolved', { id: 'pending:story-pending', operation: 'voice.tts' as const, state: 'submitting', updated_at: '2026-09-11T00:00:00.000Z' }],
      ] as const
      for (const [name, evidence] of cases) {
        if (!evidence.id.startsWith('pending:')) live.set(`story-${name}`, evidence)
        const job = jq.enqueuePreparedForTest({
          project_slug: project.slug,
          type: 'audio',
          episode_id: `EP-${name}`,
          title: name,
          params: {
            model: 'tts-live', voice: 'voice-live', sections: 'all',
            genstudio_recovery: { version: 1, route: 'genstudio', assets: {
              [`EP-${name}_Chapter_01.mp3`]: { operation: 'tts', idempotency_key: `story-${name}`, job_id: evidence.id.startsWith('pending:') ? undefined : evidence.id, state: evidence.state, updated_at: '2026-09-11T00:00:00.000Z' },
            } },
          },
        })
        fixtureJobs.push({ projectSlug: project.slug, jobId: job.job_id })
        await jq.forceAbandonJob(project.slug, job.job_id)
        await jq.mutateAuthoritativeJob(project.slug, job.job_id, current => ({
          ...current, status: 'error', force_abandoned: undefined, finished_at: new Date().toISOString(), error: name,
          genstudio_jobs: [evidence],
        }))
        const response = await request(app)
          .post(`/api/projects/${project.slug}/jobs/${job.job_id}/replace-failed-items`)
          .send({})
        assert.equal(response.status, 409, `${name}: ${JSON.stringify(response.body)}`)
        assert.equal(jq.getJob(job.job_id)?.status, 'error')
      }
    })

    await t.test('the browser cannot choose replacement scope', async () => {
      const project = await pm.createProject({ name: 'Jobs failed-item replacement body' })
      const response = await request(app)
        .post(`/api/projects/${project.slug}/jobs/unknown/replace-failed-items`)
        .send({ sections: ['Chapter_99'] })
      assert.equal(response.status, 400)
      assert.match(response.body.detail, /empty object|saved job/i)
    })
  } finally {
    for (const fixture of fixtureJobs) {
      if (jq.getJob(fixture.jobId)) await jq.forceAbandonJob(fixture.projectSlug, fixture.jobId)
    }
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    provider.close()
    await once(provider, 'close')
    await temp.cleanup()
  }
})
