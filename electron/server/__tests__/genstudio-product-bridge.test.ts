import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callChatWithGenStudio,
  GenStudioApiError,
  listChatModels,
} from '../lib/genstudio-client.js'
import {
  jsonValueMatchesSchema,
  type TextOutputContract,
} from '../lib/json-output-contract.js'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'

const METADATA_CONTRACT: TextOutputContract = {
  mode: 'json_schema',
  name: 'story_metadata',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 },
      score: { type: 'integer', minimum: 0, maximum: 100 },
    },
    required: ['title', 'score'],
    additionalProperties: false,
  },
}

function catalog(mode: 'json_object' | 'request_json_schema', id = 'writer-alpha') {
  return [{
    id,
    display_name: 'Writer Alpha',
    available: true,
    qualification_only: false,
    context_limit_tokens: 1_048_576,
    max_output_tokens: 65_536,
    controls: ['temperature', 'max_output_tokens'],
    activation_blockers: [],
    structured_output_mode: mode,
    supports_structured_output: true,
  }]
}

function accountOverview() {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
    relaxed_concurrency_limit: 1,
  }
}

test('GenStudio catalog preserves exact product ids, modes, and advertised limits', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json(catalog('request_json_schema', 'claude-sonnet-4-6'))
    const [model] = await listChatModels('product-catalog-key')
    assert.equal(model?.id, 'claude-sonnet-4-6')
    assert.equal(model?.structured_output_mode, 'request_json_schema')
    assert.equal(model?.context_limit_tokens, 1_048_576)
    assert.equal(model?.max_output_tokens, 65_536)
    assert.equal(resolveGenStudioModelId('chat', 'claude-sonnet-4-6'), 'claude-sonnet-4-6')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('strict workflows submit the actual schema through the product endpoint', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init?: RequestInit }> = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('request_json_schema'))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      assert.equal(url, 'http://127.0.0.1:8000/v1/chat/completions')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, 'writer-alpha')
      assert.deepEqual(body.response_format, {
        type: 'json_schema',
        json_schema: {
          name: 'story_metadata',
          strict: true,
          schema: METADATA_CONTRACT.mode === 'json_schema' ? METADATA_CONTRACT.schema : {},
        },
      })
      assert.equal(body.stream, false)
      assert.equal(body.max_completion_tokens, 60_000)
      assert.match(
        (init?.headers as Record<string, string>)['Idempotency-Key'],
        /^story-chat-[a-f0-9]{47}$/,
      )
      return Response.json({
        id: 'job_product_1',
        object: 'chat.completion',
        model: 'writer-alpha',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '{"title":"Quiet Forest","score":92}' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      })
    }
    const result = await callChatWithGenStudio('strict-product-key', {
      modelId: 'writer-alpha',
      system: 'Return metadata.',
      userMessage: 'Describe a quiet forest.',
      maxOutputTokens: 60_000,
      requestIdentity: 'project:episode:metadata',
      outputContract: METADATA_CONTRACT,
    })
    assert.deepEqual(JSON.parse(result.text), { title: 'Quiet Forest', score: 92 })
    assert.equal(result.modelId, 'writer-alpha')
    assert.equal(requests.filter(request => request.url.endsWith('/v1/chat/completions')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('output-mode mismatch and advertised limits stop before spend', async () => {
  const originalFetch = globalThis.fetch
  let submissions = 0
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('request_json_schema'))
      submissions++
      throw new Error(`Unexpected request ${url}`)
    }
    await assert.rejects(
      callChatWithGenStudio('mode-mismatch-key', {
        modelId: 'writer-alpha',
        system: '',
        userMessage: 'Return one object.',
        outputContract: { mode: 'json_object' },
      }),
      /requires a strict JSON schema.*No request or credit charge was made/i,
    )
    await assert.rejects(
      callChatWithGenStudio('limit-mismatch-key', {
        modelId: 'writer-alpha',
        system: '',
        userMessage: 'Write a very long response.',
        maxOutputTokens: 65_537,
        outputContract: METADATA_CONTRACT,
      }),
      /65,536-token limit.*No request or credit charge was made/i,
    )
    assert.equal(submissions, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local schema validation rejects malformed structured output', () => {
  const schema = METADATA_CONTRACT.mode === 'json_schema' ? METADATA_CONTRACT.schema : {}
  assert.equal(jsonValueMatchesSchema({ title: 'Valid', score: 50 }, schema), true)
  assert.equal(jsonValueMatchesSchema({ title: 'Missing score' }, schema), false)
  assert.equal(jsonValueMatchesSchema({ title: 'Extra', score: 50, hidden: true }, schema), false)
})

test('GenStudio errors remain distinct and actionable', () => {
  assert.match(new GenStudioApiError(401, 'bad key').message, /valid account key/i)
  assert.match(new GenStudioApiError(402, 'balance too low').message, /insufficient credits/i)
  assert.match(new GenStudioApiError(403, 'scope missing').message, /scopes and product access/i)
  assert.match(new GenStudioApiError(422, 'wrong mode').message, /selected model and its output contract/i)
  assert.match(new GenStudioApiError(429, 'busy').message, /Retry-After/i)
  assert.match(new GenStudioApiError(502, 'provider failed').message, /provider behind/i)
})
