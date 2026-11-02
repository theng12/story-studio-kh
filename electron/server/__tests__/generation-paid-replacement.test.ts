import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { mergeGenerationReplacementAttempts, generationReplacementKey } from '../services/generation-paid-replacement.js'
import type { GenerationReplacementAttempt } from '../models/types.js'

const receipt: GenerationReplacementAttempt = {
  kind: 'writing', item_key: 'section1', original_task_id: 'old', original_idempotency_key: 'old-key',
  idempotency_key: 'replacement-key', max_credits: 10, revision: 1, state: 'committed',
}

test('replacement attempts merge by key and revision, and every item key descends from its original', () => {
  const fresh = { ...receipt, revision: 2, state: 'submitted' as const, task_id: 'accepted' }
  assert.deepEqual(mergeGenerationReplacementAttempts([fresh], [receipt]), [fresh])
  assert.match(generationReplacementKey('writing', 'original-key'), /^story-writing-replacement-[0-9a-f]{64}$/)
  assert.notEqual(generationReplacementKey('writing', 'original-key'), generationReplacementKey('audio', 'original-key'))
})

test('writing replacement enforces opt-in, fresh server support, durable budget, one attempt and Off before POST', async t => {
  const temp = await useTempDataDir()
  const queue = await import('../services/job-queue.js')
  const settings = await import('../services/app-settings.js')
  const { createProject } = await import('../services/project-manager.js')
  const { callChatWithGenStudio } = await import('../lib/genstudio-client.js')
  const project = await createProject({ name: 'Replacement integration' })
  const originalFetch = globalThis.fetch
  let scenario = 'success'
  let count = 0
  const posts: Array<{ key: string; body: any }> = []
  const byKey = new Map<string, any>()
  let liveJobId = ''
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/chat/models')) return Response.json([{
      id: 'writer-test', display_name: 'Writer test', available: true, qualification_only: false, context_window_tokens: 65536,
      max_output_tokens: 8192, controls: ['temperature', 'max_output_tokens'], activation_blockers: [],
      structured_output_mode: 'json_object', supports_structured_output: true,
    }])
    if (url.pathname.endsWith('/account/overview')) return Response.json({
      paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 25,
      generation_submissions_per_minute: 300,
    })
    if (url.pathname.includes('/by-idempotency-key/')) {
      const value = byKey.get(decodeURIComponent(url.pathname.split('/').at(-1)!))
      if (!value) return Response.json({ detail: 'not found' }, { status: 404 })
      // The Gateway takes a hold between the failed POST and the eligibility read:
      // the outcome is unknown, so the answer may still be adopted and a paid
      // replacement could pay for the same work twice.
      return Response.json(scenario === 'held-after-post' ? { ...value, recovery_required: true, recovery_state: 'unknown_outcome' } : value)
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/chat/responses')) {
      const key = new Headers(init.headers).get('Idempotency-Key')!
      const body = JSON.parse(String(init.body))
      posts.push({ key, body })
      const replacement = key.startsWith('story-writing-replacement-')
      // Story never sends a credit cap: the Gateway owns the charge.
      assert.equal((body as any).max_charge_credits, undefined)
      if (replacement) {
        const durable = await queue.loadAuthoritativeJob(project.slug, liveJobId)
        assert.equal(durable?.generation_replacement_attempts?.[0]?.idempotency_key, key, 'commit must land before physical POST')
      }
      const succeeded = replacement && scenario !== 'fails-again'
      const result = {
        id: `provider-${++count}`, state: succeeded ? 'succeeded' : 'failed', operation: 'chat.response',
        model_id: 'writer-test', dispatch_mode: 'asynchronous', output_text: succeeded ? '{"ok":true}' : null,
        output_retained: succeeded, finish_reason: succeeded ? 'stop' : null,
        failure_code: scenario === 'uncertain' ? 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' : succeeded ? null : 'LANGUAGE_PROVIDER_FAILED',
        failure_class: 'provider_transient', cancelled: false,
        reserved_credits: 10, settled_credits: succeeded ? 4 : 0, released_credits: succeeded ? 6 : 10,
        credit_cost: succeeded ? 4 : 0, remaining_credits: 100,
      }
      byKey.set(key, result)
      return Response.json(result, { status: 202 })
    }
    throw new Error(`Unexpected mock request ${init?.method || 'GET'} ${url.pathname}`)
  }
  try {
    await settings.setGenStudioUrl('http://127.0.0.1:19979')
    for (const name of ['off', 'success', 'fails-again', 'uncertain', 'disable-before-post', 'held-after-post']) {
      await t.test(name, async () => {
        scenario = name
        posts.length = 0
        byKey.clear()
        await settings.setPaidWritingReplacementSetting({ enabled: name !== 'off' })
        queue.registerExecutor('metadata', async job => {
          liveJobId = job.job_id
          await callChatWithGenStudio(`test-key-${name}`, {
            modelId: 'writer-test', system: '', userMessage: name, outputContract: { mode: 'json_object' },
            beforePost: async () => {
              if (name === 'disable-before-post' && posts.length === 1) {
                await settings.setPaidWritingReplacementSetting({ enabled: false })
              }
            },
          })
        })
        const job = queue.enqueuePreparedForTest({ project_slug: project.slug, type: 'metadata', episode_id: name, title: name, params: { auto_retry: false } })
        await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: name, timeoutMs: 10000 })
        assert.equal(posts.length, ['success', 'fails-again', 'uncertain'].includes(name) ? 2 : 1, queue.getJob(job.job_id)?.error || '')
        // Owner decision 2026-10-12: a lost writing request gets one fresh resend, never a paid replacement.
        if (name === 'uncertain') {
          assert.match(posts[1]!.key, /^story-chat-resend-/)
          assert.ok(queue.getJob(job.job_id)?.output_lines.some(line => /sent it once more as a fresh request/.test(line)))
        } else if (posts.length === 2) {
          assert.notEqual(posts[0]!.key, posts[1]!.key)
          const persisted = await queue.loadAuthoritativeJob(project.slug, job.job_id)
          assert.equal(persisted?.generation_replacement_attempts?.length, 1)
          assert.equal(persisted?.generation_replacement_attempts?.[0]?.idempotency_key, posts[1]!.key)
        }
        if (name === 'success') assert.equal(queue.getJob(job.job_id)?.status, 'done', queue.getJob(job.job_id)?.error || '')
        // A hold is an unknown outcome, not a confirmed failure: no replacement is bought.
        if (name === 'held-after-post') {
          assert.match(queue.getJob(job.job_id)?.error || '', /not a confirmed eligible failure/)
        }
      })
    }
  } finally {
    await queue._waitForJobPersistenceForTesting()
    globalThis.fetch = originalFetch
    await temp.cleanup()
  }
})

test('audio replacement: a failed request gets exactly one replacement and a second failure of the same item gets none', async () => {
  const temp = await useTempDataDir()
  const queue = await import('../services/job-queue.js')
  const settings = await import('../services/app-settings.js')
  const { createProject } = await import('../services/project-manager.js')
  const client = await import('../lib/genstudio-client.js')
  const project = await createProject({ name: 'Audio replacement one-attempt' })
  const originalFetch = globalThis.fetch
  const posts: Array<{ key: string; body: any }> = []
  const byKey = new Map<string, any>()
  let count = 0
  const outPath = `${temp.dir}/audio-one-attempt.mp3`

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/tts/quotes')) return Response.json({
      model_id: 'voice-test', voice_id: 'voice-1', maximum_credits: 5,
    })
    if (url.pathname.includes('/by-idempotency-key/')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-1)!)
      const value = byKey.get(key)
      return value ? Response.json(value) : Response.json({ detail: 'not found' }, { status: 404 })
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/audio/jobs')) {
      const key = new Headers(init.headers).get('Idempotency-Key')!
      const body = JSON.parse(String(init.body))
      posts.push({ key, body })
      // Both the original and replacement fail to prove a second failure gets none.
      const result = {
        id: `provider-audio-${++count}`, state: 'failed', operation: 'voice.tts',
        model_id: 'voice-test', failure_code: 'CLOUD_PROVIDER_FAILED',
        failure_class: 'provider_transient', cancelled: false,
      }
      byKey.set(key, result)
      return Response.json(result, { status: 202 })
    }
    throw new Error(`Unexpected mock request ${init?.method || 'GET'} ${url.pathname}`)
  }

  try {
    await settings.setGenStudioUrl('http://127.0.0.1:19978')
    await settings.setPaidAudioReplacementSetting({ enabled: true })
    queue.registerExecutor('metadata', async () => {
      await client.generateTtsToFile('test-audio-key', outPath, {
        text: 'Audio test script', voiceId: 'voice-1', modelId: 'voice-test',
        maxInputCharacters: 5000, speed: 1,
      })
    })
    const job = queue.enqueuePreparedForTest({ project_slug: project.slug, type: 'metadata', episode_id: 'audio-one', title: 'audio one', params: { auto_retry: false } })
    await waitFor(() => ['done', 'error'].includes(queue.getJob(job.job_id)?.status || ''), { label: 'audio one replacement', timeoutMs: 10000 })
    // Original failed -> exactly one replacement POST -> second failure -> no further replacement (exactly 2 posts)
    assert.equal(posts.length, 2, 'failed request gets exactly one replacement and second failure gets none')
    assert.match(posts[1]!.key, /^story-audio-replacement-/)
    const persisted = await queue.loadAuthoritativeJob(project.slug, job.job_id)
    assert.equal(persisted?.generation_replacement_attempts?.length, 1)
    assert.equal(persisted?.generation_replacement_attempts?.[0]?.state, 'failed')
  } finally {
    await queue._waitForJobPersistenceForTesting()
    globalThis.fetch = originalFetch
    await temp.cleanup()
  }
})

