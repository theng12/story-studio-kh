import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

function savedNormalBatchPreview(key: string, system: string, user: string) {
  return {
    method: 'POST', path: '/v1/chat/responses', model_id: 'mock-chat-v1',
    // No `response_format`: prose asks for none since 2026-09-26 (the explicit
    // `{type:'text'}` object is refused by a Studio Hub lane). These fixtures
    // are the preview the CURRENT build writes — which is what a retry matches.
    token_limits: { max_output_tokens: 2048 },
    idempotency_key: key,
    messages: [{ role: 'user', text: `${system}\n\n${user}`, length: `${system}\n\n${user}`.length, truncated: false }],
    fields: [
      { label: 'temperature', value: '0.7' },
      { label: 'system_instruction', value: 'false' },
      { label: 'output_contract', value: 'prose' },
      { label: 'structured_output_mode', value: 'request_json_schema' },
    ],
    captured_at: new Date().toISOString(),
  }
}

test('Retry resumes a proven not-created chat request with its exact key and preview', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Retry not-created chat' })
    const original = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'expand_chapters',
      episode_id: 'EP0175',
      title: 'Chapter expansion',
      params: { model: 'writer-alpha' },
    })
    const userMessage = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    const preview = {
      method: 'POST',
      path: '/v1/chat/responses',
      model_id: 'writer-alpha',
      token_limits: { max_output_tokens: 2048 },
      idempotency_key: 'story-chat-ss0175-chapters-21-23',
      messages: [{
        role: 'user',
        text: userMessage,
        length: userMessage.length,
        truncated: false,
      }],
      captured_at: new Date().toISOString(),
    }
    await jq.recordGenStudioJob(original.job_id, {
      id: 'pending:story-chat-ss0175-chapters-21-23',
      operation: 'chat.response',
      state: 'not_created',
      dispatch_state: 'pre_dispatch',
      queue_state: 'failed',
      model_id: 'writer-alpha',
      updated_at: new Date().toISOString(),
      request: preview,
    })
    await jq.mutateAuthoritativeJob(project.slug, original.job_id, job => ({
      ...job,
      status: 'error',
      finished_at: new Date().toISOString(),
      error: 'The Gateway had no record of the request',
    }))

    const retried = jq.retryTerminalJob(project.slug, original.job_id)

    assert.equal(retried.genstudio_chat_recovery, undefined)
    assert.equal(retried.genstudio_chat_recovery_key, preview.idempotency_key)
    assert.deepEqual(retried.genstudio_chat_recovery_preview, preview)
    assert.equal(retried.genstudio_chat_recovery_purpose, 'narrative-batch')
    assert.deepEqual(retried.genstudio_chat_recovery_chapters, [21, 22, 23])
    assert.equal(jq.getJob(original.job_id), null)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

test('conflicting or settled chat evidence never unlocks a not-created POST', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const userMessage = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    const preview = {
      method: 'POST', path: '/v1/chat/responses', model_id: 'writer-alpha',
      token_limits: { max_output_tokens: 2048 }, idempotency_key: 'story-chat-unsafe-evidence',
      messages: [{ role: 'user', text: userMessage, length: userMessage.length, truncated: false }], captured_at: new Date().toISOString(),
    }
    for (const [index, evidence] of [
      { id: 'accepted-chat', state: 'accepted', request: preview },
      { id: 'pending:story-chat-unsafe-evidence', state: 'not_created', reserved_credits: 1 },
    ].entries()) {
      const project = await pm.createProject({ name: `Reject unsafe chat retry evidence ${index}` })
      let original
      if (evidence.id === 'accepted-chat') {
        const now = new Date().toISOString()
        const jobId = `historic-conflict-${index}`
        await fs.writeFile(path.join(temp.dir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [{
          job_id: jobId, project_slug: project.slug, type: 'expand_chapters', episode_id: `EP${index + 1}`,
          title: 'Chapter expansion', status: 'error', created_at: now, started_at: now, finished_at: now,
          error: 'The Gateway had no record of the request', output_lines: [], params: { model: 'writer-alpha' },
          genstudio_jobs: [
            {
              id: 'pending:story-chat-unsafe-evidence', operation: 'chat.response', state: 'not_created',
              dispatch_state: 'pre_dispatch', queue_state: 'failed', model_id: 'writer-alpha', updated_at: now, request: preview,
            },
            {
              operation: 'chat.response', dispatch_state: 'dispatched', queue_state: 'failed', model_id: 'writer-alpha',
              updated_at: now, ...evidence,
            },
          ],
        }] }))
        original = (await jq.getJobs(project.slug)).find(job => job.job_id === jobId)!
        assert.equal(original.genstudio_jobs?.length, 2)
      } else {
        original = jq.enqueuePreparedForTest({
          project_slug: project.slug, type: 'expand_chapters', episode_id: `EP${index + 1}`, params: { model: 'writer-alpha' },
        })
        await jq.recordGenStudioJob(original.job_id, {
          id: 'pending:story-chat-unsafe-evidence', operation: 'chat.response', state: 'not_created',
          dispatch_state: 'pre_dispatch', queue_state: 'failed', model_id: 'writer-alpha', updated_at: new Date().toISOString(), request: preview,
        })
        await jq.recordGenStudioJob(original.job_id, {
          operation: 'chat.response', dispatch_state: 'dispatched', queue_state: 'failed', model_id: 'writer-alpha',
          updated_at: new Date().toISOString(), ...evidence,
        } as any)
        await jq.mutateAuthoritativeJob(project.slug, original.job_id, job => ({ ...job, status: 'error', finished_at: new Date().toISOString() }))
      }
      if (evidence.id === 'accepted-chat') {
        assert.throws(
          () => jq.retryTerminalJob(project.slug, original.job_id),
          /does not prove one recoverable request identity/i,
        )
        assert.equal(jq.getJob(original.job_id)?.job_id, original.job_id)
      } else {
        const retried = jq.retryTerminalJob(project.slug, original.job_id)
        assert.equal(retried.genstudio_chat_recovery, true)
        assert.equal(retried.genstudio_chat_recovery_preview, undefined)
      }
    }
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

test('a verified absent chat request posts its exact saved body under the same key', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    service.queueScenario('chat', { states: ['succeeded'], outputText: 'Chapter output.', dropFirstSubmitResponse: true })

    const result = await client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7,
      maxOutputTokens: 2048, idempotencyKey: key, allowUncreatedRecovery: true,
      allowedRecoveryKeys: [key],
      recoveryRequestPreview: savedNormalBatchPreview(key, system, user),
    })

    assert.equal(result.text, 'Chapter output.')
    assert.equal(service.providerSubmissionCount('chat'), 1)
    assert.equal(service.submissions[0]?.idempotencyKey, key)
    assert.deepEqual(service.submissions[0]?.parsedBody, {
      model_id: 'mock-chat-v1', input: [{ role: 'user', content: `${system}\n\n${user}` }],
      temperature: 0.7, max_output_tokens: 2048,
    })
    assert.ok(service.requests.some(request =>
      request.method === 'GET'
      && request.path === `/v1/chat/responses/by-idempotency-key/${key}`,
    ))
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a verified absent retry cannot switch Gateway URLs between lookup and POST', async () => {
  const temp = await useTempDataDir()
  const first = await startMockGenStudioService()
  const second = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const realFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(first.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    first.queueScenario('chat', { states: ['succeeded'], outputText: 'First server output.' })
    let changedUrl = false
    globalThis.fetch = async (input, init) => {
      if (!changedUrl && String(input).includes(`/by-idempotency-key/${key}`)) {
        changedUrl = true
        await settings.setGenStudioUrl(second.baseUrl)
      }
      return realFetch(input, init)
    }

    const result = await client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7,
      maxOutputTokens: 2048, idempotencyKey: key, allowUncreatedRecovery: true,
      allowedRecoveryKeys: [key], recoveryRequestPreview: savedNormalBatchPreview(key, system, user),
    })

    assert.equal(result.text, 'First server output.')
    assert.equal(changedUrl, true)
    assert.equal(first.providerSubmissionCount('chat'), 1)
    assert.equal(second.providerSubmissionCount('chat'), 0)
  } finally {
    globalThis.fetch = realFetch
    await first.close()
    await second.close()
    await temp.cleanup()
  }
})

test('a URL switch while preparing a verified retry fails before either server receives a POST', async () => {
  const temp = await useTempDataDir()
  const first = await startMockGenStudioService()
  const second = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const realFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(first.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    let changedUrl = false
    globalThis.fetch = async (input, init) => {
      if (!changedUrl && String(input).endsWith('/v1/chat/models')) {
        changedUrl = true
        await settings.setGenStudioUrl(second.baseUrl)
      }
      return realFetch(input, init)
    }

    await assert.rejects(client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7,
      maxOutputTokens: 2048, idempotencyKey: key, allowUncreatedRecovery: true,
      allowedRecoveryKeys: [key], recoveryRequestPreview: savedNormalBatchPreview(key, system, user),
    }), /did not submit fresh work/i)
    assert.equal(changedUrl, true)
    assert.equal(first.providerSubmissionCount('chat'), 0)
    assert.equal(second.providerSubmissionCount('chat'), 0)
  } finally {
    globalThis.fetch = realFetch
    await first.close()
    await second.close()
    await temp.cleanup()
  }
})

test('a changed normal batch never posts under a saved not-created key', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const original = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    await assert.rejects(client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: `${original}Changed after the original checkpoint.`,
      temperature: 0.7, maxOutputTokens: 2048, idempotencyKey: key, allowUncreatedRecovery: true,
      allowedRecoveryKeys: [key], recoveryRequestPreview: savedNormalBatchPreview(key, system, original),
    }), /did not submit fresh work/i)
    assert.equal(service.providerSubmissionCount('chat'), 0)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a truncated saved preview never posts under a not-created key', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    const preview = savedNormalBatchPreview(key, system, user)
    preview.messages[0]!.truncated = true
    await assert.rejects(client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7, maxOutputTokens: 2048,
      idempotencyKey: key, allowUncreatedRecovery: true, allowedRecoveryKeys: [key], recoveryRequestPreview: preview,
    }), /did not submit fresh work/i)
    assert.equal(service.providerSubmissionCount('chat'), 0)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('an already accepted key is recovered without a replacement POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    service.queueScenario('chat', { states: ['accepted', 'succeeded'], outputText: 'Recovered accepted output.' })
    await client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7, maxOutputTokens: 2048, idempotencyKey: key,
    })
    const recovered = await client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7, maxOutputTokens: 2048,
      idempotencyKey: key, allowUncreatedRecovery: true, allowedRecoveryKeys: [key],
      recoveryRequestPreview: savedNormalBatchPreview(key, system, user),
    })
    assert.equal(recovered.text, 'Recovered accepted output.')
    assert.equal(service.providerSubmissionCount('chat'), 1)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('an unavailable lookup never turns not-created recovery into a POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const realFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    globalThis.fetch = async (input, init) => String(input).includes(`/by-idempotency-key/${key}`)
      ? new Response(JSON.stringify({ detail: 'gateway unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } })
      : realFetch(input, init)
    await assert.rejects(client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7, maxOutputTokens: 2048,
      idempotencyKey: key, allowUncreatedRecovery: true, allowedRecoveryKeys: [key],
      recoveryRequestPreview: savedNormalBatchPreview(key, system, user),
    }), /did not submit fresh work/i)
    assert.equal(service.providerSubmissionCount('chat'), 0)
  } finally {
    globalThis.fetch = realFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a cancelled not-created retry never posts', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      modelId: 'mock-chat-v1', system, userMessage: user, temperature: 0.7, maxOutputTokens: 2048,
      idempotencyKey: key, allowUncreatedRecovery: true, allowedRecoveryKeys: [key], signal: controller.signal,
      recoveryRequestPreview: savedNormalBatchPreview(key, system, user),
    }))
    assert.equal(service.providerSubmissionCount('chat'), 0)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a saved Pipeline checkpoint keeps a verified absent request on the same-key POST path', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/ai-client.js')
    const policyLib = await import('../lib/pipeline-model-policy.js')
    await import('../providers/text/genstudio.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    const key = 'story-chat-ss0175-chapters-21-23'
    const system = 'Write chapter narration.'
    const user = 'Write 3 chapter(s) of an in-progress episode.\n\nSLOTS TO WRITE NOW:\n  Chapter 21: Twenty-one\n  Chapter 22: Twenty-two\n  Chapter 23: Twenty-three\n\nOutput the chapters in this exact format (and ONLY these chapters, in numeric order):\n'
    const checkpointKey = 'script:chapters:21-23'
    const fingerprint = policyLib.pipelinePolicyInputFingerprint({ system, userMsg: user, outputBudget: undefined, maxTokens: undefined, outputContract: undefined, images: undefined })
    let checkpoint: any = {
      input_fingerprint: fingerprint, candidates: ['mock-chat-v1'], candidate_index: 0,
      candidate_model: 'mock-chat-v1', status: 'in_flight', idempotency_key: key,
      updated_at: new Date().toISOString(),
    }
    service.queueScenario('chat', { states: ['succeeded'], outputText: 'Chapter output.' })
    const text = await client.callAiWithModelPolicy({
      mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1',
    }, system, user, {}, false, {
      allowUncreatedRecovery: true,
      recoveryRequestPreview: savedNormalBatchPreview(key, system, user),
      idempotencyKey: key,
      allowedRecoveryKeys: [key],
      pipelinePolicyCheckpoint: {
        read: savedKey => savedKey === checkpointKey ? checkpoint : null,
        write: async (_savedKey, next) => { checkpoint = next },
      },
      pipelinePolicyCheckpointKey: checkpointKey,
    })
    assert.equal(text, 'Chapter output.')
    assert.equal(service.providerSubmissionCount('chat'), 1)
    assert.equal(service.submissions[0]?.idempotencyKey, key)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})
