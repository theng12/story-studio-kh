/**
 * Contract tests for the per-job "what did we actually send to GenStudio?"
 * snapshot rendered inside the Jobs page output expander.
 *
 * The load-bearing rule is the first describe block: this data is persisted to
 * `jobs.json` and rendered in the renderer, so NO credential — the api key, an
 * `Authorization: Bearer …` header, a `gsk_…` scoped key, an `sk-ant-…` style
 * key — may survive into a stored preview, not even partially masked. The
 * builder is the only way to produce this object, so proving the builder is
 * safe proves every stored snapshot is safe.
 *
 * The rest pins the bounding rules that stop long prompts and large batches
 * from ballooning the job record.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import {
  buildGenStudioRequestPreview,
  boundGenStudioRequestPreviews,
  pendingGenStudioEntryId,
  isPendingGenStudioEntryId,
  GENSTUDIO_REQUEST_MESSAGE_LIMIT,
  GENSTUDIO_REQUEST_MAX_MESSAGES,
  GENSTUDIO_REQUEST_MAX_FIELDS,
  GENSTUDIO_REQUEST_PREVIEW_RETAINED,
} from '../lib/genstudio-request-preview.js'
import { registerSecretForRedaction } from '../lib/redact-secrets.js'
import { callChatWithGenStudio, clearGenStudioCatalogCache } from '../lib/genstudio-client.js'

/** Assembled at runtime so the literal never sits in the source tree. */
const LIVE_KEY = ['gsk', 'live', '9f2c4a7b8d1e6350aa'].join('_')
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'Zx91QwErTy77LmNoPqRs'].join('-')

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key)
      collectStrings(item, out)
    }
  }
  return out
}

function assertNoCredential(snapshot: unknown, label: string): void {
  const serialized = JSON.stringify(snapshot)
  assert.ok(!serialized.includes(LIVE_KEY), `${label}: the live api key must never be stored`)
  assert.ok(!serialized.includes(ANTHROPIC_KEY), `${label}: an sk-ant style key must never be stored`)
  assert.ok(!/\bgsk_[A-Za-z0-9._-]{8,}/i.test(serialized), `${label}: no gsk_ shaped token may survive`)
  assert.ok(!/\bsk-[A-Za-z0-9._-]{8,}/.test(serialized), `${label}: no sk- shaped token may survive`)
  assert.ok(!/Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._\-+/=]{8,}/.test(serialized),
    `${label}: no live bearer token may survive`)
  // Even a partial key is a credential leak. Any 12-character run of the key
  // is enough to prove truncation sliced one in half.
  for (const key of [LIVE_KEY, ANTHROPIC_KEY]) {
    for (let start = 0; start + 12 <= key.length; start += 1) {
      assert.ok(!serialized.includes(key.slice(start, start + 12)),
        `${label}: a partial fragment of a credential must never be stored`)
    }
  }
  for (const field of collectStrings(snapshot)) {
    assert.ok(!/^authorization$/i.test(field),
      `${label}: an Authorization field must never appear in a stored preview`)
  }
}

describe('GenStudio request preview — credential safety', () => {
  test('a key registered at runtime is scrubbed out of every captured string', () => {
    registerSecretForRedaction(LIVE_KEY)
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      modelId: `story-writer-1 ${LIVE_KEY}`,
      idempotencyKey: `story-chat-${LIVE_KEY}`,
      responseFormat: { type: 'json_object', note: LIVE_KEY },
      messages: [
        { role: 'system', content: `You are a narrator. Debug header: Authorization: Bearer ${LIVE_KEY}` },
        { role: 'user', content: `Write about magnets. api_key=${LIVE_KEY}` },
      ],
      fields: [['trace', `retry url https://api.example.com/v1?api_key=${LIVE_KEY}`]],
    })
    assertNoCredential(preview, 'runtime-registered key')
    assert.match(JSON.stringify(preview), /REDACTED/, 'redactions stay visible so the preview is still useful')
  })

  test('an unregistered key-shaped token is still masked by pattern', () => {
    const preview = buildGenStudioRequestPreview({
      path: '/v1/images/generations',
      modelId: 'flux-1',
      idempotencyKey: 'story-image-abc',
      messages: [{ role: 'prompt', content: `a lighthouse. leaked=${ANTHROPIC_KEY}` }],
      fields: [['header_echo', `Authorization: Bearer ${ANTHROPIC_KEY}`]],
    })
    assertNoCredential(preview, 'pattern-only masking')
  })

  test('a credential-named field is dropped even if a caller passes one', () => {
    // The builder's own signature has no header parameter, but the final
    // `redactSensitiveValue` pass is the backstop if that ever changes.
    const preview = buildGenStudioRequestPreview({
      path: '/v1/audio/jobs',
      idempotencyKey: 'story-tts-1',
      fields: [
        ['authorization', `Bearer ${LIVE_KEY}`],
        ['x-api-key', LIVE_KEY],
        ['voice_id', 'narrator-1'],
      ],
    })
    assertNoCredential(preview, 'credential-named fields')
    const voice = preview.fields?.find(field => field.label === 'voice_id')
    assert.equal(voice?.value, 'narrator-1', 'non-secret fields must survive intact')
  })

  test('a secret straddling the truncation boundary cannot leave a partial key', () => {
    registerSecretForRedaction(LIVE_KEY)
    // Place the key so a naive "truncate first, redact second" order would cut
    // it in half exactly at the message limit.
    const head = 'x'.repeat(GENSTUDIO_REQUEST_MESSAGE_LIMIT - 6)
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-boundary',
      messages: [{ role: 'user', content: `${head}${LIVE_KEY}${'y'.repeat(500)}` }],
    })
    assertNoCredential(preview, 'truncation boundary')
  })

  test('a full URL with credentials collapses to a bare path', () => {
    const preview = buildGenStudioRequestPreview({
      path: `https://api.genstudio.example/v1/chat/completions?api_key=${LIVE_KEY}`,
      idempotencyKey: 'story-chat-url',
    })
    assert.equal(preview.path, '/v1/chat/completions', 'query strings and hosts are never stored')
    assertNoCredential(preview, 'url normalisation')
  })
})

describe('GenStudio request preview — bounded size', () => {
  test('a long prompt is truncated with an explicit marker and its true length', () => {
    const prompt = 'A'.repeat(50_000)
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-long',
      messages: [{ role: 'user', content: prompt }],
    })
    const message = preview.messages?.[0]
    assert.ok(message, 'the message must be captured')
    assert.equal(message!.length, 50_000, 'the true character count is reported')
    assert.equal(message!.truncated, true)
    assert.match(message!.text, /truncated/, 'an explicit marker replaces the dropped tail')
    assert.ok(message!.text.length < GENSTUDIO_REQUEST_MESSAGE_LIMIT + 200,
      'the stored text stays close to the cap instead of holding the whole prompt')
  })

  test('a short prompt is stored verbatim and not marked truncated', () => {
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-short',
      messages: [{ role: 'system', content: 'Be concise.' }],
    })
    assert.equal(preview.messages?.[0]?.text, 'Be concise.')
    assert.equal(preview.messages?.[0]?.truncated, false)
  })

  test('a real-world ~8K system prompt now stores whole under the raised cap', () => {
    // Regression pin for the owner-reported bug: a SYSTEM message of 8,167
    // characters used to be cut down to 2,000. It must now survive intact.
    const systemPrompt = 'S'.repeat(8_167)
    const userPrompt = 'U'.repeat(3_083)
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-real-world',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    })
    const [system, user] = preview.messages!
    assert.equal(system!.truncated, false, 'the system prompt must fit under the new cap whole')
    assert.equal(system!.length, 8_167)
    assert.equal(system!.text, systemPrompt, 'no characters are dropped and no marker is appended')
    assert.equal(user!.truncated, false)
    assert.equal(user!.text, userPrompt)
  })

  test('a message exactly at the cap is not truncated; one character over it is', () => {
    const atLimit = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-at-limit',
      messages: [{ role: 'user', content: 'A'.repeat(GENSTUDIO_REQUEST_MESSAGE_LIMIT) }],
    })
    assert.equal(atLimit.messages?.[0]?.truncated, false)
    assert.equal(atLimit.messages?.[0]?.text, 'A'.repeat(GENSTUDIO_REQUEST_MESSAGE_LIMIT))

    const overLimit = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-over-limit',
      messages: [{ role: 'user', content: 'A'.repeat(GENSTUDIO_REQUEST_MESSAGE_LIMIT + 1) }],
    })
    const message = overLimit.messages?.[0]
    assert.equal(message?.truncated, true)
    assert.equal(message?.length, GENSTUDIO_REQUEST_MESSAGE_LIMIT + 1, 'the true length is always reported')
    assert.match(message!.text, /showing [\d,]+ of [\d,]+ characters/,
      'the marker states exactly how much was stored versus the true length, for the UI to render honestly')
  })

  test('message and field counts are capped', () => {
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-many',
      messages: Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: `m${index}` })),
      fields: Array.from({ length: 40 }, (_, index) => [`f${index}`, index + 1] as [string, unknown]),
    })
    assert.equal(preview.messages?.length, GENSTUDIO_REQUEST_MAX_MESSAGES)
    assert.equal(preview.fields?.length, GENSTUDIO_REQUEST_MAX_FIELDS)
  })

  test('empty and nullish fields are dropped rather than stored as blanks', () => {
    const preview = buildGenStudioRequestPreview({
      path: '/v1/images/generations',
      idempotencyKey: 'story-image-sparse',
      fields: [['seed', undefined], ['width', null], ['aspect_ratio', '16:9'], ['steps', 0]],
    })
    assert.deepEqual(preview.fields, [
      { label: 'aspect_ratio', value: '16:9' },
      { label: 'steps', value: '0' },
    ])
  })

  test('token limits keep their exact wire field names', () => {
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      idempotencyKey: 'story-chat-tokens',
      tokenLimits: { max_completion_tokens: 2_048, max_output_tokens: undefined },
    })
    assert.deepEqual(preview.token_limits, { max_completion_tokens: 2_048 })
  })

  test('only the newest previews are retained on a large batch', () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      id: `job-${index}`,
      request: { path: '/v1/images/generations', method: 'POST', captured_at: 'now' },
    }))
    const bounded = boundGenStudioRequestPreviews(entries)
    assert.equal(bounded.length, 40, 'no evidence entry is ever dropped')
    assert.equal(bounded.filter(entry => entry.request).length, GENSTUDIO_REQUEST_PREVIEW_RETAINED)
    assert.ok(bounded[39]!.request, 'the newest call keeps its preview')
    assert.ok(!bounded[0]!.request, 'the oldest call gives its preview up first')
  })

  test('a small batch keeps every preview untouched', () => {
    const entries = [{ id: 'a', request: { method: 'POST', path: '/v1/audio/jobs', captured_at: 'now' } }]
    assert.equal(boundGenStudioRequestPreviews(entries), entries)
  })
})

describe('GenStudio request preview — pending evidence id', () => {
  test('the pending id is deterministic and recognisable', () => {
    const id = pendingGenStudioEntryId('story-tts-abc')
    assert.equal(id, pendingGenStudioEntryId('story-tts-abc'))
    assert.ok(isPendingGenStudioEntryId(id))
    assert.ok(!isPendingGenStudioEntryId('gs_job_1234'))
  })
})

describe('job-queue adopts the pre-submit preview', () => {
  let cleanup: () => Promise<void>
  let pm: typeof import('../services/project-manager.js')
  let jq: typeof import('../services/job-queue.js')

  before(async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    pm = await import('../services/project-manager.js')
    jq = await import('../services/job-queue.js')
  })
  after(async () => {
    await jq._waitForJobPersistenceForTesting()
    await cleanup()
  })

  test('the real GenStudio id takes over the pending entry and keeps its preview', async () => {
    const project = await pm.createProject({ name: 'GenStudio Request Preview' })
    const preview = buildGenStudioRequestPreview({
      path: '/v1/chat/completions',
      modelId: 'story-writer-1',
      idempotencyKey: 'story-chat-adopt',
      messages: [{ role: 'user', content: 'Write about magnets.' }],
    })

    let recorded: string | null = null
    jq.registerExecutor('script-only', async (job) => {
      recorded = job.job_id
      // 1. Captured before submission — the id does not exist yet.
      await jq.recordGenStudioJob(job.job_id, {
        id: pendingGenStudioEntryId('story-chat-adopt'),
        operation: 'chat.response',
        state: 'submitting',
        queue_state: 'submitting',
        updated_at: new Date().toISOString(),
        request: preview,
      })
      // 2. GenStudio accepted the request and handed back the real id.
      await jq.recordGenStudioJob(job.job_id, {
        id: 'gs_chat_777',
        operation: 'chat.response',
        state: 'succeeded',
        updated_at: new Date().toISOString(),
        request: preview,
      })
      // 3. A later state poll carries no preview and must not erase it.
      await jq.recordGenStudioJob(job.job_id, {
        id: 'gs_chat_777',
        operation: 'chat.response',
        state: 'succeeded',
        credit_cost: 3,
        updated_at: new Date().toISOString(),
      })
    })

    const enqueued = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'script-only',
      episode_id: 'EP0001',
    })
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && jq.getJob(enqueued.job_id)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(recorded, enqueued.job_id, 'the executor must have run')

    const entries = jq.getJob(enqueued.job_id)?.genstudio_jobs || []
    assert.equal(entries.length, 1, 'the pending entry is adopted, never duplicated')
    assert.equal(entries[0]!.id, 'gs_chat_777')
    assert.equal(entries[0]!.credit_cost, 3, 'later polls still merge normally')
    assert.equal(entries[0]!.request?.messages?.[0]?.text, 'Write about magnets.',
      'a poll without a preview must not erase the captured request')
  })

  test('a 402 makes the saved request a terminal pre-dispatch credit refusal', async () => {
    const project = await pm.createProject({ name: 'GenStudio Credit Refusal' })
    const originalFetch = globalThis.fetch
    clearGenStudioCatalogCache()
    let posts = 0
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input)
        if (url.endsWith('/v1/chat/models')) {
          return Response.json([{
            id: 'credit-writer', display_name: 'Credit Writer', available: true,
            qualification_only: false, context_window_tokens: 65_536,
            max_output_tokens: 8_192, controls: ['max_output_tokens'],
            activation_blockers: [], structured_output_mode: 'json_object',
            supports_structured_output: true,
          }])
        }
        if (url.endsWith('/v1/account/overview')) {
          return Response.json({
            credit_balance: 76, paid_concurrency_limit: 1, paid_active_jobs: 0,
            paid_queued_jobs: 0, max_queued_jobs: 25,
            generation_submissions_per_minute: 30,
          })
        }
        assert.equal((init?.method || 'GET').toUpperCase(), 'POST')
        posts += 1
        return Response.json({ detail: 'Insufficient credits' }, { status: 402 })
      }
      jq.registerExecutor('script-only', async job => {
        await callChatWithGenStudio('credit-preview-key', {
          modelId: 'credit-writer', system: '', userMessage: 'Write the episode.',
          outputContract: { mode: 'json_object' },
          idempotencyKey: 'story-chat-credit-preview',
        })
      })
      const enqueued = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'script-only',
        episode_id: 'EP0001',
      })
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline && jq.getJob(enqueued.job_id)?.status !== 'error') {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      const job = jq.getJob(enqueued.job_id)
      assert.equal(job?.status, 'error')
      assert.equal(posts, 1, 'a credit refusal is never re-POSTed')
      assert.equal(job?.genstudio_jobs?.length, 1)
      assert.deepEqual(job?.genstudio_jobs?.[0], {
        id: pendingGenStudioEntryId('story-chat-credit-preview'),
        operation: 'chat.response',
        state: 'failed',
        dispatch_state: 'pre_dispatch',
        model_id: 'credit-writer',
        queue_state: 'waiting_credits',
        failure_code: null,
        updated_at: job?.genstudio_jobs?.[0]?.updated_at,
        request: job?.genstudio_jobs?.[0]?.request,
      })
      assert.equal(job?.genstudio_jobs?.[0]?.request?.idempotency_key, 'story-chat-credit-preview')
      assert.equal(job?.genstudio_jobs?.[0]?.reserved_credits, undefined)
      assert.equal(job?.genstudio_jobs?.[0]?.settled_credits, undefined)
      assert.equal(job?.genstudio_jobs?.[0]?.released_credits, undefined)
    } finally {
      globalThis.fetch = originalFetch
      clearGenStudioCatalogCache()
    }
  })

  test('a failed durable preview write prevents the paid POST', async () => {
    const project = await pm.createProject({ name: 'GenStudio Preview Persistence Failure' })
    const originalFetch = globalThis.fetch
    clearGenStudioCatalogCache()
    let posts = 0
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input)
        if (url.endsWith('/v1/chat/models')) {
          return Response.json([{
            id: 'durable-preview-writer', display_name: 'Durable Preview Writer', available: true,
            qualification_only: false, context_window_tokens: 65_536, max_output_tokens: 8_192,
            controls: ['max_output_tokens'], activation_blockers: [], structured_output_mode: 'json_object',
            supports_structured_output: true,
          }])
        }
        if (url.endsWith('/v1/account/overview')) {
          return Response.json({
            credit_balance: 76, paid_concurrency_limit: 1, paid_active_jobs: 0,
            paid_queued_jobs: 0, max_queued_jobs: 25, generation_submissions_per_minute: 30,
          })
        }
        if ((init?.method || 'GET').toUpperCase() === 'POST') posts += 1
        return Response.json({ id: 'must-not-exist' })
      }
      jq.registerExecutor('script-only', async job => {
        const restore = jq._setJobFileLockProbeForTesting(operation => {
          if (operation === 'persist') throw new Error('injected preview persistence failure')
        })
        try {
          await callChatWithGenStudio('preview-persistence-key', {
            modelId: 'durable-preview-writer', system: '', userMessage: 'Write the episode.',
            outputContract: { mode: 'json_object' },
            idempotencyKey: `story-chat-preview-failure-${job.job_id}`,
          })
        } finally {
          restore()
        }
      })

      const enqueued = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'script-only',
        episode_id: 'EP0002',
      })
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline && jq.getJob(enqueued.job_id)?.status !== 'error') {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      assert.equal(jq.getJob(enqueued.job_id)?.status, 'error')
      assert.equal(posts, 0, 'the generation POST requires a durable request preview')
    } finally {
      globalThis.fetch = originalFetch
      clearGenStudioCatalogCache()
    }
  })
})
