import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { callAiWithModelPolicy, isUnchargedQuotaStop } from '../lib/ai-client.js'
import type { PipelinePolicyAttemptCheckpoint, PipelinePolicyCheckpointStore } from '../lib/pipeline-model-policy.js'
import { _setAutomaticRetryForTesting } from '../services/job-retry-policy.js'
// These tests pin manual Retry; writing jobs auto-retry after a minute since R1 (2026-10-07).
_setAutomaticRetryForTesting(false)

test('Retry of a Pipeline run redoes an uncharged failure once, on the run\'s own model', async t => {
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
  const project = await pm.createProject({ name: 'Pipeline run model fixture', episode_prefix: 'EP', episode_digits: 4 })
  await pm.updateConfig(project.slug, {
    research_presets: [{ id: 'research-1', name: 'Existing preset', data: { form: {
      research_mode: 'model-knowledge', source_model: 'preset-model', max_sources: 3,
    } } }],
    research_last_preset_research: 'research-1',
  } as any)
  const before = await pm.getConfig(project.slug)
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Runs retain their identity', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const body = {
    episode_ids: [accepted.episode_code], steps: ['research'],
    model_policies: { research: { mode: 'single', models: ['mock-chat-v1'] } },
  }
  // The request is accepted and then fails, charging nothing. Retry redoes it
  // with ONE fresh request on the same model (1.4.248 Retry rule); a charged
  // failure keeps its key instead (unit test "retains an accepted recovery key").
  mock.queueScenario('chat', { states: ['accepted', 'failed'], failureCode: 'provider_error' })
  const started = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body)
  assert.equal(started.status, 201, JSON.stringify(started.body))
  const firstId = started.body.jobs[0].job_id
  const terminal = async (id: string) => waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(id)?.status || ''), { label: 'Pipeline run settles', timeoutMs: 10_000 })
  await terminal(firstId)
  assert.equal(mock.providerSubmissionCount('chat'), 1)
  const first = jq.getJob(firstId)!
  assert.equal(first.params.generation_action, undefined)
  const attempts = Object.values(first.params.pipeline_model_checkpoints || {}) as Array<Record<string, unknown>>
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0]!.candidate_model, 'mock-chat-v1')
  assert.equal(attempts[0]!.candidate_index, 0)
  assert.equal(attempts[0]!.status, 'failed_unaccepted')
  const retried = await request(app).post(`/api/projects/${project.slug}/jobs/${firstId}/retry`)
  assert.equal(retried.status, 202, JSON.stringify(retried.body))
  assert.notEqual(retried.body.job.job_id, firstId)
  await terminal(retried.body.job.job_id)
  const fresh = mock.submissions.filter(item => item.operation === 'chat' && !item.replay)
  assert.equal(fresh.length, 2, 'exactly one fresh request for the uncharged failure')
  assert.deepEqual(fresh.map(item => item.parsedBody?.model_id), ['mock-chat-v1', 'mock-chat-v1'])
  assert.notEqual(fresh[0]!.idempotencyKey, fresh[1]!.idempotencyKey)
  const after = await pm.getConfig(project.slug)
  assert.deepEqual(after!.research_presets, before!.research_presets, 'per-run choices must not mutate saved presets')
})

test('a quota stop on the one chosen model is uncharged, and the next run makes one fresh request', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => {
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
  const policy = { mode: 'single' as const, models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' }
  mock.queueScenario('chat', {
    states: ['accepted', 'failed'],
    failureCode: 'LANGUAGE_PROVIDER_QUOTA_EXHAUSTED',
  })
  await assert.rejects(callAiWithModelPolicy(policy, 'system', 'quota retry fixture', {}, false, {
    requestIdentity: 'quota-fixture',
    pipelinePolicyCheckpoint: checkpoint,
    pipelinePolicyCheckpointKey: 'quota-fixture',
  }), isUnchargedQuotaStop)
  assert.equal(mock.providerSubmissionCount('chat'), 1)
  assert.equal(entries.get('quota-fixture')?.status, 'failed_unaccepted')

  mock.queueScenario('chat', { states: ['succeeded'], outputText: 'fresh success' })
  const result = await callAiWithModelPolicy(policy, 'system', 'quota retry fixture', {}, false, {
    requestIdentity: 'quota-fixture',
    pipelinePolicyCheckpoint: checkpoint,
    pipelinePolicyCheckpointKey: 'quota-fixture',
  })
  assert.equal(result, 'fresh success')
  const submissions = mock.submissions.filter(item => item.operation === 'chat' && !item.replay)
  assert.equal(submissions.length, 2, 'one fresh request after the uncharged quota stop')
  assert.notEqual(submissions[0]!.idempotencyKey, submissions[1]!.idempotencyKey)
})

test('a saved LLM lineup no longer changes any step\'s writing model (owner decision 2026-10-03)', async t => {
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
  const project = await pm.createProject({ name: 'Retired lineup ignored', episode_prefix: 'EP', episode_digits: 4 })
  await pm.updateConfig(project.slug, {
    research_presets: [{ id: 'research-1', name: 'Existing preset', data: { form: {
      research_mode: 'model-knowledge', source_model: 'mock-chat-v1', max_sources: 3,
    } } }],
    research_last_preset_research: 'research-1',
    llm_lineup: { enabled: true, models: ['gone-model', 'lineup-backup'], prefer_savings: false },
  } as any)
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Lineup ignored', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  mock.queueScenario('chat', { states: ['succeeded'], outputText: '{"claims":[],"summary":"own model"}' })
  const started = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send({
    episode_ids: [accepted.episode_code], steps: ['research'],
  })
  assert.equal(started.status, 201, JSON.stringify(started.body))
  const jobId = started.body.jobs[0].job_id
  await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''), { label: 'Research settles', timeoutMs: 10_000 })
  const submissions = mock.submissions.filter(item => item.operation === 'chat' && !item.replay)
  assert.deepEqual(submissions.map(item => item.parsedBody?.model_id), ['mock-chat-v1'])
  assert.equal(jq.getJob(jobId)!.params.pipeline_model_policy, undefined)
  // The saved lineup stays on disk, untouched.
  assert.deepEqual((await pm.getConfig(project.slug))?.llm_lineup?.models, ['gone-model', 'lineup-backup'])
})
