import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { callAiWithModelPolicy, isLlmLineupWaitingError } from '../lib/ai-client.js'
import type { PipelinePolicyAttemptCheckpoint, PipelinePolicyCheckpointStore } from '../lib/pipeline-model-policy.js'

test('normal Pipeline backup survives a new local Retry job without another paid submission', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    if (String(input).startsWith(mock.baseUrl) && String(input).endsWith('/v1/chat/models')) {
      const rows = await response.json() as Array<Record<string, unknown>>
      return Response.json([{ ...rows[0], id: 'unavailable-primary', available: false }, ...rows])
    }
    return response
  }
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const app = (await import('../app.js')).app
  const jq = await import('../services/job-queue.js')
  t.after(async () => {
    await jq._waitForJobPersistenceForTesting()
    globalThis.fetch = originalFetch
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
  const project = await pm.createProject({ name: 'Pipeline backup fixture', episode_prefix: 'EP', episode_digits: 4 })
  await pm.updateConfig(project.slug, {
    research_presets: [{ id: 'research-1', name: 'Existing preset', data: { form: {
      research_mode: 'model-knowledge', source_model: 'mock-chat-v1', max_sources: 3,
    } } }],
    research_last_preset_research: 'research-1',
  } as any)
  const before = await pm.getConfig(project.slug)
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Backups retain their identity', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const body = {
    episode_ids: [accepted.episode_code], steps: ['research'],
    model_policies: { research: { mode: 'backup', models: ['unavailable-primary', 'mock-chat-v1'] } },
  }
  // The backup is accepted and then fails. A Retry must recover that request,
  // not forget its candidate simply because the local job has a new id.
  mock.queueScenario('chat', { states: ['accepted', 'failed'], failureCode: 'provider_error' })
  const started = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body)
  assert.equal(started.status, 201, JSON.stringify(started.body))
  const firstId = started.body.jobs[0].job_id
  const terminal = async (id: string) => waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(id)?.status || ''), { label: 'Pipeline backup settles', timeoutMs: 10_000 })
  await terminal(firstId)
  assert.equal(mock.providerSubmissionCount('chat'), 1)
  const first = jq.getJob(firstId)!
  assert.equal(first.params.generation_action, undefined)
  const attempts = Object.values(first.params.pipeline_model_checkpoints || {}) as Array<Record<string, unknown>>
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0]!.candidate_model, 'mock-chat-v1')
  assert.equal(attempts[0]!.candidate_index, 1)
  const retried = await request(app).post(`/api/projects/${project.slug}/jobs/${firstId}/retry`)
  assert.equal(retried.status, 202, JSON.stringify(retried.body))
  assert.notEqual(retried.body.job.job_id, firstId)
  await terminal(retried.body.job.job_id)
  assert.equal(mock.providerSubmissionCount('chat'), 1, 'Retry must not submit an accepted backup again')
  const after = await pm.getConfig(project.slug)
  assert.deepEqual(after!.research_presets, before!.research_presets, 'per-run choices must not mutate saved presets')
})

test('a fully released lineup quota failure creates one durable replacement identity after its availability hold', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  const originalNow = Date.now
  t.after(async () => {
    Date.now = originalNow
    await mock.close()
    await isolated.cleanup()
  })
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const checkpoint: PipelinePolicyCheckpointStore = {
    read: key => entries.get(key) || null,
    write: async (key, value) => { entries.set(key, structuredClone(value)) },
  }
  const policy = {
    mode: 'single' as const,
    models: ['mock-chat-v1'],
    assigned_model: 'mock-chat-v1',
    wait_for_availability: true as const,
  }
  mock.queueScenario('chat', {
    states: ['accepted', 'failed'],
    failureCode: 'LANGUAGE_PROVIDER_QUOTA_EXHAUSTED',
  })
  await assert.rejects(callAiWithModelPolicy(policy, 'system', 'quota retry fixture', {}, false, {
    requestIdentity: 'quota-lineup-fixture',
    pipelinePolicyCheckpoint: checkpoint,
    pipelinePolicyCheckpointKey: 'quota-lineup-fixture',
  }), isLlmLineupWaitingError)
  assert.equal(mock.providerSubmissionCount('chat'), 1)
  assert.deepEqual(entries.get('quota-lineup-fixture')?.retry_epochs, [1])

  mock.queueScenario('chat', { states: ['succeeded'], outputText: 'replacement success' })
  Date.now = () => originalNow() + 61_000
  const result = await callAiWithModelPolicy(policy, 'system', 'quota retry fixture', {}, false, {
    requestIdentity: 'quota-lineup-fixture',
    pipelinePolicyCheckpoint: checkpoint,
    pipelinePolicyCheckpointKey: 'quota-lineup-fixture',
  })
  assert.equal(result, 'replacement success')
  assert.equal(mock.providerSubmissionCount('chat'), 2, 'the resumed lineup must submit its one authorized replacement')
  const submissions = mock.submissions.filter(item => item.operation === 'chat' && !item.replay)
  assert.equal(submissions.length, 2)
  assert.notEqual(submissions[0]!.idempotencyKey, submissions[1]!.idempotencyKey)
})

test('a shared lineup owns a transient quota failure even when paid writing replacement is enabled', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    if (String(input).startsWith(mock.baseUrl) && String(input).endsWith('/v1/chat/models')) {
      const rows = await response.json() as Array<Record<string, unknown>>
      return Response.json([...rows, { ...rows[0], id: 'lineup-backup' }, {
        ...rows[0], id: 'retiring-model', retires_at: '2999-01-01T00:00:00Z', replacement_model_id: 'mock-chat-v1',
      }])
    }
    return response
  }
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const app = (await import('../app.js')).app
  const jq = await import('../services/job-queue.js')
  t.after(async () => {
    await jq._waitForJobPersistenceForTesting()
    globalThis.fetch = originalFetch
    await mock.close()
    await isolated.cleanup()
  })
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(mock.baseUrl)
  await settings.setPaidWritingReplacementSetting({ enabled: true, additional_credit_ceiling: 100 })
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  const project = await pm.createProject({ name: 'Lineup owns quota fallback', episode_prefix: 'EP', episode_digits: 4 })
  await pm.updateConfig(project.slug, {
    research_presets: [{ id: 'research-1', name: 'Existing preset', data: { form: {
      research_mode: 'model-knowledge', source_model: 'mock-chat-v1', max_sources: 3,
    } } }],
    research_last_preset_research: 'research-1',
    llm_lineup: { enabled: true, models: ['retiring-model', 'lineup-backup'], prefer_savings: false },
  } as any)
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Quota ownership', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  mock.queueScenario('chat', {
    states: ['accepted', 'failed'],
    failureCode: 'LANGUAGE_PROVIDER_QUOTA_EXHAUSTED',
    envelope: { failure_class: 'provider_transient' },
  })
  mock.queueScenario('chat', { states: ['succeeded'], outputText: '{"claims":[],"summary":"backup"}' })
  const started = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send({
    episode_ids: [accepted.episode_code], steps: ['research'],
  })
  assert.equal(started.status, 201, JSON.stringify(started.body))
  const jobId = started.body.jobs[0].job_id
  await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''), { label: 'Lineup quota fallback settles', timeoutMs: 10_000 })
  const submissions = mock.submissions.filter(item => item.operation === 'chat' && !item.replay)
  assert.deepEqual(submissions.map(item => item.parsedBody?.model_id), ['mock-chat-v1', 'lineup-backup'])
  assert.deepEqual((await pm.getConfig(project.slug))?.llm_lineup?.models, ['retiring-model', 'lineup-backup'], 'fresh-job successor resolution leaves saved choices intact')
})
