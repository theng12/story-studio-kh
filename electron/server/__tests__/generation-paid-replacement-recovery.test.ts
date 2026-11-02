import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

function silentWav(): Buffer {
  const sampleRate = 8_000
  const samples = 800
  const dataLength = samples * 2
  const wav = Buffer.alloc(44 + dataLength)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataLength, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataLength, 40)
  return wav
}

function settledJob(
  id: string,
  operation: 'voice.tts' | 'chat.response',
  state: 'failed' | 'succeeded',
  failureCode: string | null = null,
): Record<string, unknown> {
  return {
    id,
    operation,
    state,
    dispatch_mode: 'asynchronous',
    model_id: operation === 'voice.tts' ? 'voice-model' : 'writer-model',
    failure_code: failureCode,
    failure_class: state === 'failed' ? 'provider_transient' : null,
    cancelled: false,
    reserved_credits: 5,
    settled_credits: state === 'succeeded' ? 3 : 0,
    released_credits: state === 'succeeded' ? 2 : 5,
    credit_cost: state === 'succeeded' ? 3 : 0,
    remaining_credits: 100,
    ...(operation === 'voice.tts'
      ? { voice_id: 'voice-one', speed: 1, audio_url: state === 'succeeded' ? `/artifacts/${id}.wav` : null }
      : { output_text: state === 'succeeded' ? '{"ok":true}' : null, output_retained: state === 'succeeded', finish_reason: state === 'succeeded' ? 'stop' : null }),
  }
}

test('generation replacement recovery reuses receipts, stays off-safe, and keeps item scopes distinct', async t => {
  const temp = await useTempDataDir()
  const originalFetch = globalThis.fetch
  const queue = await import('../services/job-queue.js')
  const settings = await import('../services/app-settings.js')
  const projectManager = await import('../services/project-manager.js')
  const client = await import('../lib/genstudio-client.js')
  const project = await projectManager.createProject({ name: 'Generation replacement recovery' })
  const baseUrl = 'http://127.0.0.1:19981'
  const remoteByKey = new Map<string, Record<string, unknown>>()
  const posts: Array<{ operation: 'audio' | 'chat'; key: string; body: Record<string, unknown> }> = []
  const originalAudioKey = 'audio-original-key'
  const manualAudioKey = 'audio-manual-new-key'
  const uncertainAudioKey = 'audio-uncertain-key'
  const originalChatKey = 'chat-original-key'
  const searchedChatKey = 'chat-web-search-key'
  const connectionAudioKey = 'audio-connection-original-key'
  const collisionChatKey = 'chat-collision-auto-original'
  const manualCollisionOriginalKey = 'chat-collision-manual-original'
  const manualCollisionReplacementKey = 'chat-collision-manual-replacement'

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method || 'GET').toUpperCase()
    if (url.pathname === '/v1/account/overview') {
      return Response.json({
        paid_concurrency_limit: 5,
        paid_active_jobs: 0,
        paid_queued_jobs: 0,
        max_queued_jobs: 25,
        generation_submissions_per_minute: 300,
        max_charge_credits_supported_operations: ['voice.tts', 'chat.response'],
      })
    }
    if (url.pathname === '/v1/chat/models') {
      return Response.json([{
        id: 'writer-model', display_name: 'Writer', available: true, qualification_only: false,
        context_window_tokens: 65_536, max_output_tokens: 8_192,
        controls: ['system_instruction', 'temperature', 'max_output_tokens'], activation_blockers: [],
        structured_output_mode: 'json_object', supports_structured_output: true,
      }])
    }
    if (url.pathname === '/v1/tts/quotes') {
      return Response.json({ model_id: 'voice-model', voice_id: 'voice-one', maximum_credits: 5 })
    }
    if (url.pathname.startsWith('/v1/jobs/by-idempotency-key/')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-1)!)
      return remoteByKey.has(key)
        ? Response.json(remoteByKey.get(key))
        : Response.json({ detail: 'not found' }, { status: 404 })
    }
    if (url.pathname.startsWith('/v1/chat/responses/by-idempotency-key/')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-1)!)
      return remoteByKey.has(key)
        ? Response.json(remoteByKey.get(key))
        : Response.json({ detail: 'not found' }, { status: 404 })
    }
    if (url.pathname.startsWith('/v1/jobs/') && !url.pathname.endsWith('/cancel')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
      const job = [...remoteByKey.values()].find(candidate => candidate.id === id)
      return job ? Response.json(job) : Response.json({ detail: 'not found' }, { status: 404 })
    }
    if (url.pathname.startsWith('/v1/chat/responses/') && method === 'GET') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
      const job = [...remoteByKey.values()].find(candidate => candidate.id === id)
      return job ? Response.json(job) : Response.json({ detail: 'not found' }, { status: 404 })
    }
    if (url.pathname.startsWith('/artifacts/')) {
      return new Response(silentWav(), { headers: { 'Content-Type': 'audio/wav' } })
    }
    if (method === 'POST' && url.pathname === '/v1/audio/jobs') {
      const key = new Headers(init?.headers).get('Idempotency-Key') || ''
      const body = JSON.parse(String(init?.body))
      posts.push({ operation: 'audio', key, body })
      const replacement = key.startsWith('story-audio-replacement-')
      const uncertain = key === uncertainAudioKey
      const job = settledJob(
        `tts-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`,
        'voice.tts',
        replacement ? 'succeeded' : 'failed',
        uncertain ? 'CLOUD_SUBMISSION_UNCERTAIN' : replacement ? null : 'CLOUD_PROVIDER_FAILED',
      )
      remoteByKey.set(key, job)
      return Response.json(job, { status: 202 })
    }
    if (method === 'POST' && url.pathname === '/v1/chat/responses') {
      const key = new Headers(init?.headers).get('Idempotency-Key') || ''
      const body = JSON.parse(String(init?.body))
      posts.push({ operation: 'chat', key, body })
      const failedOriginal = key === originalChatKey || key === collisionChatKey
      const job = settledJob(
        `chat-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`,
        'chat.response',
        failedOriginal ? 'failed' : 'succeeded',
        failedOriginal ? 'LANGUAGE_PROVIDER_FAILED' : null,
      )
      remoteByKey.set(key, job)
      return Response.json(job, { status: 202 })
    }
    throw new Error(`Unexpected mock request ${method} ${url.pathname}`)
  }

  try {
    await settings.setGenStudioUrl(baseUrl)
    client.clearGenStudioCatalogCache()

    await t.test('a submitted audio receipt overrides a stale manual key and recovers while the setting is Off', async () => {
      const outPath = path.join(temp.dir, 'chapter-one.mp3')
      const request = {
        text: 'A replacement chapter whose request bytes stay fixed.',
        voiceId: 'voice-one',
        modelId: 'voice-model',
        maxInputCharacters: 5_000,
        speed: 1,
      }
      await settings.setAudioRetrySetting({ enabled: true, retries: 1 })
      queue.registerExecutor('metadata', async job => {
        await client.generateTtsToFile('test-key', outPath, { ...request, idempotencyKey: originalAudioKey })
        await queue.mutateAuthoritativeJob(project.slug, job.job_id, current => {
          current.generation_replacement_attempts = (current.generation_replacement_attempts || []).map(attempt => (
            attempt.kind === 'audio' ? { ...attempt, state: 'submitted', revision: attempt.revision + 1 } : attempt
          ))
          return current
        })
        // Reconstruct the durable state left by a process loss after provider
        // acceptance: the receipt survived, while the local artifact did not
        // and the caller rebuilt a fresh/manual key from its stale checkpoint.
        await fs.rm(outPath, { force: true })
        await settings.setAudioRetrySetting({ enabled: false })
        await client.generateTtsToFile('test-key', outPath, { ...request, idempotencyKey: manualAudioKey })
      })
      const job = queue.enqueuePreparedForTest({ project_slug: project.slug, type: 'metadata', episode_id: 'audio-recovery', title: 'audio recovery', params: {} })
      await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio receipt recovery', timeoutMs: 10_000 })
      assert.equal(queue.getJob(job.job_id)?.status, 'done', queue.getJob(job.job_id)?.error || '')
      assert.ok((await fs.stat(outPath)).size > 0)
      const audioPosts = posts.filter(entry => entry.operation === 'audio')
      assert.equal(audioPosts.length, 2)
      assert.equal(audioPosts[0]?.key, originalAudioKey)
      assert.match(audioPosts[1]?.key || '', /^story-audio-replacement-/)
      assert.equal(audioPosts.some(entry => entry.key === manualAudioKey), false)
    })

    await t.test('an uncertain audio submission never creates an automatic replacement POST', async () => {
      const before = posts.filter(entry => entry.operation === 'audio').length
      await settings.setAudioRetrySetting({ enabled: true, retries: 1 })
      let caught: unknown
      queue.registerExecutor('metadata', async () => {
        caught = await client.generateTtsToFile('test-key', path.join(temp.dir, 'uncertain.mp3'), {
          text: 'The provider may already own this request.', voiceId: 'voice-one', modelId: 'voice-model',
          maxInputCharacters: 5_000, speed: 1, idempotencyKey: uncertainAudioKey,
        }).then(() => null, error => error)
      })
      const job = queue.enqueuePreparedForTest({ project_slug: project.slug, type: 'metadata', episode_id: 'audio-uncertain', title: 'audio uncertain', params: {} })
      await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'uncertain audio', timeoutMs: 10_000 })
      assert.ok(caught instanceof client.GenStudioTtsTerminalFailureError)
      assert.equal(caught.failureCode, 'CLOUD_SUBMISSION_UNCERTAIN')
      const added = posts.filter(entry => entry.operation === 'audio').slice(before)
      assert.deepEqual(added.map(entry => entry.key), [uncertainAudioKey])
    })

    await t.test('a committed receipt refuses a changed Gateway origin or credential before any POST', async () => {
      const before = posts.filter(entry => entry.operation === 'audio').length
      const outPath = path.join(temp.dir, 'connection-bound.mp3')
      const request = {
        text: 'A connection-bound replacement request.', voiceId: 'voice-one', modelId: 'voice-model',
        maxInputCharacters: 5_000, speed: 1, idempotencyKey: connectionAudioKey,
      }
      const errors: unknown[] = []
      await settings.setAudioRetrySetting({ enabled: true, retries: 1 })
      queue.registerExecutor('metadata', async job => {
        await client.generateTtsToFile('test-key', outPath, request)
        await queue.mutateAuthoritativeJob(project.slug, job.job_id, current => {
          current.generation_replacement_attempts = (current.generation_replacement_attempts || []).map(attempt => {
            if (attempt.kind !== 'audio') return attempt
            const { task_id: _taskId, ...committed } = attempt
            return { ...committed, state: 'committed', revision: attempt.revision + 1 }
          })
          return current
        })
        await fs.rm(outPath, { force: true })

        await settings.setGenStudioUrl('http://127.0.0.1:19982')
        errors.push(await client.generateTtsToFile('test-key', outPath, {
          ...request, idempotencyKey: 'connection-stale-origin-key',
        }).then(() => null, error => error))

        await settings.setGenStudioUrl(baseUrl)
        errors.push(await client.generateTtsToFile('different-account-key', outPath, {
          ...request, idempotencyKey: 'connection-stale-account-key',
        }).then(() => null, error => error))
      })
      const job = queue.enqueuePreparedForTest({ project_slug: project.slug, type: 'metadata', episode_id: 'connection-bound-recovery', title: 'connection bound recovery', params: {} })
      await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'connection-bound recovery', timeoutMs: 10_000 })
      assert.equal(queue.getJob(job.job_id)?.status, 'done', queue.getJob(job.job_id)?.error || '')
      assert.equal(errors.length, 2)
      for (const error of errors) assert.match(String((error as Error)?.message), /connection changed/i)
      assert.equal(posts.filter(entry => entry.operation === 'audio').length - before, 2)
      assert.equal(posts.some(entry => entry.key === 'connection-stale-origin-key' || entry.key === 'connection-stale-account-key'), false)
    })

    await t.test('an explicit manual key wins over an automatic receipt for the same chat body', async () => {
      const before = posts.filter(entry => entry.operation === 'chat').length
      await settings.setWritingRetrySetting({ enabled: true, retries: 1 })
      queue.registerExecutor('metadata', async job => {
        const request = {
          modelId: 'writer-model', system: 'Return JSON.', userMessage: 'Write one collision-test item.',
          outputContract: { mode: 'json_object' as const },
        }
        await client.callChatWithGenStudio('test-key', { ...request, idempotencyKey: collisionChatKey })
        await queue.mutateAuthoritativeJob(project.slug, job.job_id, current => {
          current.params = {
            ...current.params,
            jobs_replace_failed_items: { version: 1, request_id: 'manual-collision', source_job_id: job.job_id, item_count: 1 },
          }
          current.manual_failed_item_replacement = {
            source_job_id: job.job_id,
            requests: [{
              original_task_id: 'chat-collision-manual-failure',
              original_idempotency_key: manualCollisionOriginalKey,
              replacement_idempotency_key: manualCollisionReplacementKey,
            }],
          }
          return current
        })
        await client.callChatWithGenStudio('test-key', { ...request, idempotencyKey: manualCollisionOriginalKey })
      })
      const job = queue.enqueuePreparedForTest({ project_slug: project.slug, type: 'metadata', episode_id: 'manual-key-precedence', title: 'manual key precedence', params: {} })
      await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'manual key precedence', timeoutMs: 10_000 })
      assert.equal(queue.getJob(job.job_id)?.status, 'done', queue.getJob(job.job_id)?.error || '')
      const added = posts.filter(entry => entry.operation === 'chat').slice(before)
      assert.equal(added.length, 3)
      assert.equal(added[0]?.key, collisionChatKey)
      assert.match(added[1]?.key || '', /^story-writing-replacement-/)
      assert.equal(added[2]?.key, manualCollisionReplacementKey)
      assert.equal(added.some(entry => entry.key === manualCollisionOriginalKey), false)
    })

    await t.test('web search is part of a writing item identity', async () => {
      const before = posts.filter(entry => entry.operation === 'chat').length
      await settings.setWritingRetrySetting({ enabled: true, retries: 1 })
      queue.registerExecutor('metadata', async () => {
        const common = {
          modelId: 'writer-model', system: 'Return JSON.', userMessage: 'Write the same bounded item.',
          outputContract: { mode: 'json_object' as const },
        }
        await client.callChatWithGenStudio('test-key', { ...common, idempotencyKey: originalChatKey })
        await client.callChatWithGenStudio('test-key', {
          ...common,
          idempotencyKey: searchedChatKey,
          webSearch: { enabled: true, max_searches: 1, allowed_domains: [], blocked_domains: [] },
        })
      })
      const job = queue.enqueuePreparedForTest({ project_slug: project.slug, type: 'metadata', episode_id: 'writing-search-scope', title: 'writing search scope', params: {} })
      await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'writing web-search identity', timeoutMs: 10_000 })
      assert.equal(queue.getJob(job.job_id)?.status, 'done', queue.getJob(job.job_id)?.error || '')
      const chatPosts = posts.filter(entry => entry.operation === 'chat').slice(before)
      assert.equal(chatPosts.length, 3)
      assert.equal(chatPosts[0]?.key, originalChatKey)
      assert.match(chatPosts[1]?.key || '', /^story-writing-replacement-/)
      assert.equal(chatPosts[2]?.key, searchedChatKey)
      assert.deepEqual(chatPosts[2]?.body.web_search, { enabled: true, max_searches: 1, allowed_domains: [], blocked_domains: [] })
    })
  } finally {
    await queue._waitForJobPersistenceForTesting()
    globalThis.fetch = originalFetch
    client.clearGenStudioCatalogCache()
    await temp.cleanup()
  }
})
