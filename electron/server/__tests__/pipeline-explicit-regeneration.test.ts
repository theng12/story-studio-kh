import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { _setAutomaticRetryForTesting } from '../services/job-retry-policy.js'
// These tests pin manual Retry; writing jobs auto-retry after a minute since R1 (2026-10-07).
_setAutomaticRetryForTesting(false)

test('forced Pipeline chat work replays one action, survives Jobs Retry, and a new click is fresh', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const app = (await import('../app.js')).app
  const jq = await import('../services/job-queue.js')
  t.after(async () => {
    await jq._waitForJobPersistenceForTesting()
    await mock.close()
    await isolated.cleanup()
  })
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  const project = await pm.createProject({ name: 'Forced Pipeline action fixture', episode_prefix: 'EP', episode_digits: 4 })
  await pm.updateConfig(project.slug, {
    research_presets: [{ id: 'research-1', name: 'Mock research', data: { form: {
      research_mode: 'model-knowledge', source_model: 'mock-chat-v1', max_sources: 3,
    } } }],
    research_last_preset_research: 'research-1',
  } as any)
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Durable action identity', logline: '', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'calm',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)

  // The queue refuses Retry/enqueue while the previous executor is still unwinding
  // (job-queue.ts assertNoSettlingWorker): a terminal row is not yet an admission window. Wait for
  // the owned worker slot too, exactly as job-retry-route-contract's waitForTerminal does.
  const terminal = async (jobId: string, label: string) => waitFor(() => {
    const status = jq.getJob(jobId)?.status
    return (status === 'done' || status === 'error' || status === 'cancelled')
      && !jq._isJobWorkerActiveForTesting(jobId)
  }, { label, timeoutMs: 10_000 })
  const body = (operationId: string) => ({
    episode_ids: [accepted.episode_code], steps: ['research'], force: true, operation_id: operationId,
  })

  const firstAction = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  mock.queueScenario('chat', { states: ['accepted', 'failed'], failureCode: 'provider_error' })
  await jq.setQueuePaused(true)
  const [first, replay] = await Promise.all([
    request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body(firstAction)),
    request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body(firstAction)),
  ])
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(replay.status, 201, JSON.stringify(replay.body))
  const firstJobId = first.body.jobs[0]?.job_id || replay.body.jobs[0]?.job_id || first.body.reused_jobs[0]?.job_id || replay.body.reused_jobs[0]?.job_id
  assert.ok(firstJobId)
  assert.equal(new Set([first.body.enqueued, replay.body.enqueued]).has(1), true)
  assert.deepEqual(jq.getJob(firstJobId)?.params.generation_action, { id: firstAction, kind: 'fresh' })
  await jq.setQueuePaused(false)
  await terminal(firstJobId, 'first forced Pipeline action')
  assert.equal(mock.providerSubmissionCount('chat'), 1)

  const retried = await request(app).post(`/api/projects/${project.slug}/jobs/${firstJobId}/retry`)
  assert.equal(retried.status, 202, JSON.stringify(retried.body))
  await terminal(retried.body.job.job_id, 'forced Pipeline Jobs Retry')
  // Owner 2026-10-03: the action's first request failed and GenStudio released
  // every credit, so rejoining it would only replay the failure. Retry submits
  // once more under a key derived from that failed job (a charged failure
  // would still rejoin — see chat-failed-replay.test.ts).
  assert.equal(mock.providerSubmissionCount('chat'), 2, 'Jobs Retry of a free failure submits exactly one fresh request')

  mock.queueScenario('chat', { states: ['accepted', 'failed'], failureCode: 'provider_error' })
  const second = await request(app)
    .post(`/api/projects/${project.slug}/pipeline/run-batch`)
    .send(body('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
  assert.equal(second.status, 201, JSON.stringify(second.body))
  await terminal(second.body.jobs[0].job_id, 'second forced Pipeline action')
  assert.equal(mock.providerSubmissionCount('chat'), 3, 'a new click must submit a fresh provider request')

  await jq.setQueuePaused(true)
  const recovery = await request(app)
    .post(`/api/projects/${project.slug}/pipeline/run-batch`)
    .send({ episode_ids: [accepted.episode_code], steps: ['research'] })
  assert.equal(recovery.status, 201, JSON.stringify(recovery.body))
  const recoveryJob = jq.getJob(recovery.body.jobs[0].job_id)
  assert.equal(recoveryJob?.params.generation_action, undefined, 'ordinary recovery must not inherit fresh authority')
  await jq.setQueuePaused(false)
  await terminal(recovery.body.jobs[0].job_id, 'ordinary Pipeline recovery')
  await waitFor(() => !jq.isDuplicate(project.slug, accepted.episode_code, 'research_run'), {
    label: 'ordinary Pipeline recovery leaves the active queue', timeoutMs: 10_000,
  })
})
