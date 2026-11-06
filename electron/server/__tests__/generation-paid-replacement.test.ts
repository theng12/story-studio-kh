import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { mergeGenerationReplacementAttempts, generationReplacementKey } from '../services/generation-paid-replacement.js'
import type { GenerationReplacementAttempt } from '../models/types.js'

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

const receipt: GenerationReplacementAttempt = {
  kind: 'writing', item_key: 'section1', original_task_id: 'old', original_idempotency_key: 'old-key',
  idempotency_key: 'replacement-key', max_credits: 10, revision: 1, state: 'committed',
}

test('replacement attempts merge by key and revision, and every item key descends from its original', () => {
  const fresh = { ...receipt, revision: 2, state: 'submitted' as const, task_id: 'accepted' }
  assert.deepEqual(mergeGenerationReplacementAttempts([fresh], [receipt]), [fresh])
  assert.match(generationReplacementKey('writing', 'original-key'), /^story-writing-replacement-[0-9a-f]{64}$/)
  assert.notEqual(generationReplacementKey('writing', 'original-key'), generationReplacementKey('audio', 'original-key'))
  assert.notEqual(generationReplacementKey('writing', 'original-key', 1), generationReplacementKey('writing', 'original-key', 2))
  assert.match(generationReplacementKey('writing', 'original-key', 2), /^story-writing-replacement-[0-9a-f]{64}$/)
})

test('writing and audio retry settings: default OFF, count 3, bounds 1-10', async () => {
  const settings = await import('../services/app-settings.js')
  const writingDefault = await settings.getWritingRetrySetting()
  assert.equal(writingDefault.enabled, false)
  assert.equal(writingDefault.retries, 3)

  const audioDefault = await settings.getAudioRetrySetting()
  assert.equal(audioDefault.enabled, false)
  assert.equal(audioDefault.retries, 3)

  // Bounds enforcement 1-10
  await assert.rejects(() => settings.setWritingRetrySetting({ enabled: true, retries: 0 }))
  await assert.rejects(() => settings.setWritingRetrySetting({ enabled: true, retries: 11 }))
  await assert.rejects(() => settings.setAudioRetrySetting({ enabled: true, retries: 0 }))
  await assert.rejects(() => settings.setAudioRetrySetting({ enabled: true, retries: 11 }))
})

test('generation replacement: configurable retries with count 2, payload stability, bounds, hold/cancel refusal, and restart recovery for writing and audio', async t => {
  const temp = await useTempDataDir()
  const queue = await import('../services/job-queue.js')
  const settings = await import('../services/app-settings.js')
  const { createProject } = await import('../services/project-manager.js')
  const { callChatWithGenStudio, generateTtsToFile, clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  const project = await createProject({ name: 'Generation retry integration' })
  const originalFetch = globalThis.fetch
  let scenario = 'success'
  let postCount = 0
  const posts: Array<{ key: string; body: any }> = []
  const byKey = new Map<string, any>()
  const outPath = `${temp.dir}/audio-test.mp3`

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method || 'GET').toUpperCase()
    const pathname = url.pathname

    if (method === 'GET') {
      if (pathname.endsWith('/chat/models')) return Response.json([{
        id: 'writer-test', display_name: 'Writer test', available: true, qualification_only: false, context_window_tokens: 65536,
        max_output_tokens: 8192, controls: ['temperature', 'max_output_tokens'], activation_blockers: [],
        structured_output_mode: 'json_object', supports_structured_output: true,
      }])
      if (pathname.endsWith('/tts/quotes')) return Response.json({
        model_id: 'voice-test', voice_id: 'voice-1', maximum_credits: 5,
      })
      if (pathname.endsWith('/account/overview')) return Response.json({
        paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 25,
        generation_submissions_per_minute: 300,
        max_charge_credits_supported_operations: ['voice.tts', 'chat.response'],
      })
      if (pathname.startsWith('/artifacts/')) {
        return new Response(silentWav(), { headers: { 'Content-Type': 'audio/wav' } })
      }
      if (pathname.includes('/by-idempotency-key/')) {
        const key = decodeURIComponent(pathname.split('/').at(-1)!)
        const value = byKey.get(key)
        if (!value) return Response.json({ detail: 'not found' }, { status: 404 })
        if (scenario === 'held-after-post' && (key.startsWith('test-key-') || key.startsWith('test-audio-'))) {
          return Response.json({ ...value, recovery_required: true, recovery_state: 'unknown_outcome' })
        }
        if (scenario === 'held-during-retry' && (key.startsWith('story-writing-replacement-') || key.startsWith('story-audio-replacement-'))) {
          return Response.json({ ...value, recovery_required: true, recovery_state: 'unknown_outcome' })
        }
        return Response.json(value)
      }
      if ((pathname.includes('/chat/responses/') || pathname.includes('/audio/jobs/') || pathname.includes('/jobs/')) && !pathname.endsWith('/cancel')) {
        const id = decodeURIComponent(pathname.split('/').at(-1)!)
        const matching = [...byKey.entries()].find(([_, item]) => item.id === id)
        if (!matching) return Response.json({ detail: 'not found' }, { status: 404 })
        const [key, value] = matching
        if (scenario === 'held-after-post' && (key.startsWith('test-key-') || key.startsWith('test-audio-'))) {
          return Response.json({ ...value, recovery_required: true, recovery_state: 'unknown_outcome' })
        }
        return Response.json(value)
      }
    }

    if (method === 'POST' && pathname.endsWith('/chat/responses')) {
      const key = new Headers(init?.headers).get('Idempotency-Key')!
      const body = JSON.parse(String(init?.body))
      posts.push({ key, body })
      postCount++

      const isRetry = key.startsWith('story-writing-replacement-')
      let succeeded = false
      let cancelled = false
      let held = false

      if (scenario === 'count2-success') {
        // Original (postCount 1) fails, Retry 1 (postCount 2) fails, Retry 2 (postCount 3) succeeds
        succeeded = postCount >= 3
      } else if (scenario === 'cancelled-during-retry') {
        cancelled = isRetry
      } else if (scenario === 'success') {
        succeeded = isRetry
      }

      const result = {
        id: `provider-${postCount}`,
        state: succeeded ? 'succeeded' : 'failed',
        operation: 'chat.response',
        model_id: 'writer-test',
        dispatch_mode: 'asynchronous',
        output_text: succeeded ? '{"ok":true}' : null,
        output_retained: succeeded,
        finish_reason: succeeded ? 'stop' : null,
        failure_code: scenario === 'uncertain' ? 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' : succeeded ? null : 'LANGUAGE_PROVIDER_FAILED',
        failure_class: 'provider_transient',
        cancelled,
        recovery_required: held,
        recovery_state: held ? 'unknown_outcome' : null,
        reserved_credits: 10, settled_credits: succeeded ? 4 : 0, released_credits: succeeded ? 6 : 10,
        credit_cost: succeeded ? 4 : 0, remaining_credits: 100,
      }
      byKey.set(key, result)
      return Response.json(result, { status: 202 })
    }

    if (method === 'POST' && pathname.endsWith('/audio/jobs')) {
      const key = new Headers(init?.headers).get('Idempotency-Key')!
      const body = JSON.parse(String(init?.body))
      posts.push({ key, body })
      postCount++

      const isRetry = key.startsWith('story-audio-replacement-')
      let succeeded = false
      let cancelled = false
      let held = false

      if (scenario === 'count2-success') {
        // Original (postCount 1) fails, Retry 1 (postCount 2) fails, Retry 2 (postCount 3) succeeds
        succeeded = postCount >= 3
      } else if (scenario === 'cancelled-during-retry') {
        cancelled = isRetry
      }

      const result = {
        id: `provider-audio-${postCount}`,
        state: succeeded ? 'succeeded' : 'failed',
        operation: 'voice.tts',
        model_id: 'voice-test',
        voice_id: 'voice-1',
        audio_url: succeeded ? `/artifacts/provider-audio-${postCount}.wav` : null,
        failure_code: succeeded ? null : 'CLOUD_PROVIDER_FAILED',
        failure_class: 'provider_transient',
        cancelled,
        recovery_required: held,
        recovery_state: held ? 'unknown_outcome' : null,
      }
      byKey.set(key, result)
      return Response.json(result, { status: 202 })
    }

    throw new Error(`Unexpected mock request ${method} ${pathname}`)
  }

  try {
    await settings.setGenStudioUrl('http://127.0.0.1:19979')
    clearGenStudioCatalogCache()

    await t.test('writing retry: configurable retries with count 2, payload stability, bounds, hold/cancel refusal, and restart recovery', async t => {
      await t.test('off: zero extra POSTs made, legacy paid flag ignored', async () => {
        scenario = 'off'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setWritingRetrySetting({ enabled: false, retries: 3 })
        queue.registerExecutor('metadata', async () => {
          await callChatWithGenStudio('test-api-key', {
            idempotencyKey: 'test-key-off',
            modelId: 'writer-test', system: '', userMessage: 'test off', outputContract: { mode: 'prose' },
          })
        })
        // Intentionally set legacy paid switch on job params to verify it is ignored
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'off', title: 'off',
          params: { auto_retry: false, paid_writing_replacement: { enabled: true } },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'off', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        assert.equal(posts.length, 1, 'disabled setting produces exactly 0 extra POSTs')
      })

      await t.test('count 2: exactly 2 extra POSTs, same model, stable payload, note lines', async () => {
        scenario = 'count2-success'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setWritingRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await callChatWithGenStudio('test-api-key', {
            idempotencyKey: 'test-key-count2',
            modelId: 'writer-test', system: '', userMessage: 'count2 payload', outputContract: { mode: 'prose' },
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'count2', title: 'count2',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'count2-success', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'done', queue.getJob(job.job_id)?.error || '')
        // Original (1) + Retry 1 (2) + Retry 2 (3) = 3 total POSTs (exactly 2 extra)
        assert.equal(posts.length, 3, 'count 2 produces exactly 2 extra physical POSTs')

        // All POSTs must share same model and stable payload
        for (const post of posts) {
          assert.equal(post.body.model_id, 'writer-test')
          assert.deepEqual(post.body.input, [{ role: 'user', content: 'count2 payload' }])
        }

        // Check keys: original != retry1, retry1 != retry2
        assert.equal(posts[0]!.key, 'test-key-count2')
        assert.match(posts[1]!.key, /^story-writing-replacement-/)
        assert.match(posts[2]!.key, /^story-writing-replacement-/)
        assert.notEqual(posts[1]!.key, posts[2]!.key)

        const persisted = await queue.loadAuthoritativeJob(project.slug, job.job_id)
        assert.equal(persisted?.generation_replacement_attempts?.length, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[0]?.ordinal, 1)
        assert.equal(persisted?.generation_replacement_attempts?.[0]?.state, 'failed')
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.ordinal, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.state, 'succeeded')

        // Plain job note format checked
        assert.ok(persisted?.output_lines.some(line => line.includes('retry 1 of 2') || line.includes('retry 2 of 2')))
      })

      await t.test('stop after configured bound: count 2 exhausts and stops', async () => {
        scenario = 'fails-again'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setWritingRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await callChatWithGenStudio('test-api-key', {
            idempotencyKey: 'test-key-exhaust',
            modelId: 'writer-test', system: '', userMessage: 'exhaust', outputContract: { mode: 'prose' },
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'exhaust', title: 'exhaust',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'exhaust', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        // Original + Retry 1 + Retry 2 = 3 posts total, stops after configured bound (2)
        assert.equal(posts.length, 3, 'stops after exactly 2 retries')
        const persisted = await queue.loadAuthoritativeJob(project.slug, job.job_id)
        assert.equal(persisted?.generation_replacement_attempts?.length, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[0]?.state, 'failed')
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.state, 'failed')
        assert.match(queue.getJob(job.job_id)?.error || '', /did not complete after 2 attempts/)
      })

      await t.test('held outcome on original: no retry attempt', async () => {
        scenario = 'held-after-post'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setWritingRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await callChatWithGenStudio('test-api-key', {
            idempotencyKey: 'test-key-held',
            modelId: 'writer-test', system: '', userMessage: 'held', outputContract: { mode: 'prose' },
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'held', title: 'held',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'held', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        assert.equal(posts.length, 1, 'held outcome refuses fresh retry')
        assert.match(queue.getJob(job.job_id)?.error || '', /not a confirmed eligible failure/)
      })

      await t.test('held outcome during retry: terminates loop with no further retry', async () => {
        scenario = 'held-during-retry'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setWritingRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await callChatWithGenStudio('test-api-key', {
            idempotencyKey: 'test-key-held-retry',
            modelId: 'writer-test', system: '', userMessage: 'held-retry', outputContract: { mode: 'prose' },
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'held-retry', title: 'held-retry',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'held-retry', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        // Original (1) + Retry 1 (2) -> held, stops! No Retry 2
        assert.equal(posts.length, 2, 'held retry terminates loop immediately')
        assert.match(queue.getJob(job.job_id)?.error || '', /holds unknown outcome/)
      })

      await t.test('cancelled during retry: terminates loop with no fresh retry', async () => {
        scenario = 'cancelled-during-retry'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setWritingRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await callChatWithGenStudio('test-api-key', {
            idempotencyKey: 'test-key-cancel-retry',
            modelId: 'writer-test', system: '', userMessage: 'cancel-retry', outputContract: { mode: 'prose' },
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'cancel-retry', title: 'cancel-retry',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'cancel-retry', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        // Original (1) + Retry 1 (2) -> cancelled, stops! No Retry 2
        assert.equal(posts.length, 2, 'cancelled retry terminates loop immediately')
        assert.match(queue.getJob(job.job_id)?.error || '', /cancelled/)
      })

      await t.test('saved key/ordinal recovery on restart does not reset to 1', async () => {
        scenario = 'fails-again'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setWritingRetrySetting({ enabled: true, retries: 2 })

        const origKey = 'test-key-restart'
        const retry1Key = generationReplacementKey('writing', origKey, 1)

        const rerun = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'restart-run', title: 'restart run',
          params: { auto_retry: false },
        })
        await queue.mutateAuthoritativeJob(project.slug, rerun.job_id, current => {
          current.generation_replacement_attempts = [{
            kind: 'writing',
            item_key: 'restart-item',
            original_idempotency_key: origKey,
            original_task_id: 'orig-task',
            idempotency_key: retry1Key,
            state: 'failed',
            revision: 2,
            ordinal: 1,
          }]
          return current
        })

        queue.registerExecutor('metadata', async () => {
          await callChatWithGenStudio('test-api-key', {
            idempotencyKey: origKey,
            modelId: 'writer-test', system: '', userMessage: 'restart check', outputContract: { mode: 'prose' },
          })
        })

        await waitFor(() => ['done', 'error'].includes(queue.getJob(rerun.job_id)?.status || ''), { label: 'restart-recovery', timeoutMs: 10000 })
        // Original fails (1), then it executes ordinal 2 (2). Bound is 2, so it stops! Total 2 POSTs (1 orig + 1 retry)
        assert.equal(posts.length, 2, 'resumed at ordinal 2 and stopped at bound 2')
        // Restart recovery from an attempt WITHOUT max_credits (field retired): the
        // original idempotency key is re-POSTed exactly as recorded and the only extra
        // POST is ordinal 2 of the SAME chain — identity kept, no second chain.
        assert.equal(posts[0]!.key, origKey, 'restart re-POSTs the recorded original key, unmoved')
        assert.equal(posts[1]!.key, generationReplacementKey('writing', origKey, 2), 'next POST is ordinal 2 of the same chain, not a fresh chain')
        const persisted = await queue.loadAuthoritativeJob(project.slug, rerun.job_id)
        assert.equal(persisted?.generation_replacement_attempts?.length, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.ordinal, 2)
        assert.equal('max_credits' in (persisted?.generation_replacement_attempts?.[1] ?? {}), false, 'new attempts never carry the retired field')
      })
    })

    // Drain writing persistence before starting audio
    await queue._waitForJobPersistenceForTesting()
    await queue.drainJobPersistenceForShutdown(5000).catch(() => false)
    await queue._waitForJobPersistenceForTesting()

    await t.test('audio retry: configurable retries with count 2, payload stability, bounds, hold/cancel refusal, and restart recovery', async t => {
      await t.test('off: zero extra POSTs made, legacy paid flag ignored', async () => {
        scenario = 'off'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setAudioRetrySetting({ enabled: false, retries: 3 })
        queue.registerExecutor('metadata', async () => {
          await generateTtsToFile('test-api-key', outPath, {
            idempotencyKey: 'test-audio-off',
            text: 'Audio off script', voiceId: 'voice-1', modelId: 'voice-test',
            maxInputCharacters: 5000, speed: 1,
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'audio-off', title: 'audio off',
          params: { auto_retry: false, paid_audio_replacement: { enabled: true } },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio-off', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        assert.equal(posts.length, 1, 'disabled setting produces exactly 0 extra POSTs')
      })

      await t.test('count 2: exactly 2 extra POSTs, same model, stable payload, note lines', async () => {
        scenario = 'count2-success'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await fs.rm(outPath, { force: true })
        await settings.setAudioRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await generateTtsToFile('test-api-key', outPath, {
            idempotencyKey: 'test-audio-count2',
            text: 'Audio count2 script', voiceId: 'voice-1', modelId: 'voice-test',
            maxInputCharacters: 5000, speed: 1,
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'audio-count2', title: 'audio count2',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio count2-success', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'done', queue.getJob(job.job_id)?.error || '')
        // Original (1) + Retry 1 (2) + Retry 2 (3) = 3 total POSTs (exactly 2 extra)
        assert.equal(posts.length, 3, 'count 2 produces exactly 2 extra physical POSTs')

        // Stable payload verification
        for (const post of posts) {
          assert.equal(post.body.model_id, 'voice-test')
          assert.equal(post.body.voice_id, 'voice-1')
          assert.equal(post.body.text, 'Audio count2 script')
        }

        assert.equal(posts[0]!.key, 'test-audio-count2')
        assert.match(posts[1]!.key, /^story-audio-replacement-/)
        assert.match(posts[2]!.key, /^story-audio-replacement-/)
        assert.notEqual(posts[1]!.key, posts[2]!.key)

        const persisted = await queue.loadAuthoritativeJob(project.slug, job.job_id)
        assert.equal(persisted?.generation_replacement_attempts?.length, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[0]?.ordinal, 1)
        assert.equal(persisted?.generation_replacement_attempts?.[0]?.state, 'failed')
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.ordinal, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.state, 'succeeded')

        assert.ok(queue.getJob(job.job_id)?.output_lines.some(line => line.includes('retry 1 of 2') || line.includes('retry 2 of 2')))
        assert.ok((await fs.stat(outPath)).size > 0, 'audio file produced on retry 2')
      })

      await t.test('stop after configured bound: count 2 exhausts and stops', async () => {
        scenario = 'fails-again'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setAudioRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await generateTtsToFile('test-api-key', outPath, {
            idempotencyKey: 'test-audio-exhaust',
            text: 'Audio exhaust script', voiceId: 'voice-1', modelId: 'voice-test',
            maxInputCharacters: 5000, speed: 1,
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'audio-exhaust', title: 'audio exhaust',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio exhaust', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        assert.equal(posts.length, 3, 'stops after exactly 2 retries')
        const persisted = await queue.loadAuthoritativeJob(project.slug, job.job_id)
        assert.equal(persisted?.generation_replacement_attempts?.length, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[0]?.state, 'failed')
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.state, 'failed')
        assert.match(queue.getJob(job.job_id)?.error || '', /did not complete after 2 attempts/)
      })

      await t.test('held outcome on original: no audio retry attempt', async () => {
        scenario = 'held-after-post'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setAudioRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await generateTtsToFile('test-api-key', outPath, {
            idempotencyKey: 'test-audio-held',
            text: 'Audio held script', voiceId: 'voice-1', modelId: 'voice-test',
            maxInputCharacters: 5000, speed: 1,
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'audio-held', title: 'audio held',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio held', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        assert.equal(posts.length, 1, 'held outcome refuses fresh retry')
        assert.match(queue.getJob(job.job_id)?.error || '', /not a confirmed eligible failure/)
      })

      await t.test('held outcome during retry: terminates loop with no further retry', async () => {
        scenario = 'held-during-retry'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setAudioRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await generateTtsToFile('test-api-key', outPath, {
            idempotencyKey: 'test-audio-held-retry',
            text: 'Audio held retry script', voiceId: 'voice-1', modelId: 'voice-test',
            maxInputCharacters: 5000, speed: 1,
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'audio-held-retry', title: 'audio held retry',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio held retry', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        assert.equal(posts.length, 2, 'held retry terminates loop immediately')
        assert.match(queue.getJob(job.job_id)?.error || '', /holds unknown outcome/)
      })

      await t.test('cancelled during retry: terminates loop with no fresh retry', async () => {
        scenario = 'cancelled-during-retry'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setAudioRetrySetting({ enabled: true, retries: 2 })
        queue.registerExecutor('metadata', async () => {
          await generateTtsToFile('test-api-key', outPath, {
            idempotencyKey: 'test-audio-cancel-retry',
            text: 'Audio cancel retry script', voiceId: 'voice-1', modelId: 'voice-test',
            maxInputCharacters: 5000, speed: 1,
          })
        })
        const job = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'audio-cancel-retry', title: 'audio cancel retry',
          params: { auto_retry: false },
        })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio cancel retry', timeoutMs: 10000 })
        assert.equal(queue.getJob(job.job_id)?.status, 'error')
        assert.equal(posts.length, 2, 'cancelled retry terminates loop immediately')
        assert.match(queue.getJob(job.job_id)?.error || '', /cancelled/)
      })

      await t.test('saved key/ordinal recovery on restart does not reset to 1', async () => {
        scenario = 'fails-again'
        posts.length = 0
        postCount = 0
        byKey.clear()
        await settings.setAudioRetrySetting({ enabled: true, retries: 2 })

        const origKey = 'test-audio-restart'
        const retry1Key = generationReplacementKey('audio', origKey, 1)

        const rerun = queue.enqueuePreparedForTest({
          project_slug: project.slug, type: 'metadata', episode_id: 'audio-restart-run', title: 'audio restart run',
          params: { auto_retry: false },
        })
        await queue.mutateAuthoritativeJob(project.slug, rerun.job_id, current => {
          current.generation_replacement_attempts = [{
            kind: 'audio',
            item_key: 'restart-audio-item',
            original_idempotency_key: origKey,
            original_task_id: 'orig-audio-task',
            idempotency_key: retry1Key,
            max_credits: 0,
            state: 'failed',
            revision: 2,
            ordinal: 1,
          }]
          return current
        })

        queue.registerExecutor('metadata', async () => {
          await generateTtsToFile('test-api-key', outPath, {
            idempotencyKey: origKey,
            text: 'Audio restart check', voiceId: 'voice-1', modelId: 'voice-test',
            maxInputCharacters: 5000, speed: 1,
          })
        })

        await waitFor(() => ['done', 'error'].includes(queue.getJob(rerun.job_id)?.status || ''), { label: 'audio restart-recovery', timeoutMs: 10000 })
        assert.equal(posts.length, 2, 'resumed at ordinal 2 and stopped at bound 2')
        assert.equal(posts[1]!.key, generationReplacementKey('audio', origKey, 2))
        const persisted = await queue.loadAuthoritativeJob(project.slug, rerun.job_id)
        assert.equal(persisted?.generation_replacement_attempts?.length, 2)
        assert.equal(persisted?.generation_replacement_attempts?.[1]?.ordinal, 2)
      })
    })
  } finally {
    await queue._waitForJobPersistenceForTesting()
    await queue.drainJobPersistenceForShutdown(5000).catch(() => false)
    await queue._waitForJobPersistenceForTesting()
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
    await temp.cleanup()
  }
})
