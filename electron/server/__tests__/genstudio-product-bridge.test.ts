import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  callChatWithGenStudio,
  GENSTUDIO_CHAT_TRANSPORT_ENV,
  GenStudioApiError,
  listChatModels,
  resolveGenStudioChatTransport,
} from '../lib/genstudio-client.js'
import {
  jsonValueMatchesSchema,
  type TextOutputContract,
} from '../lib/json-output-contract.js'
import {
  CONTEXTUAL_CUES_OUTPUT_CONTRACT,
  outlineOutputContract,
  scenePromptPackOutputContract,
  thumbnailPromptsOutputContract,
  videoPromptsOutputContract,
} from '../lib/story-output-contracts.js'
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
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    controls: ['temperature', 'max_output_tokens'],
    activation_blockers: [],
    structured_output_mode: mode,
    supports_structured_output: true,
  }]
}

/** Any phrasing that promises the caller nothing was requested or charged. */
const UNCHARGED_CLAIM = /no request or credit charge|uncharged|not charged|without charge/i

/** One settled durable language job — what `/v1/chat/responses` returns. */
function chatJob(outputText: string) {
  return {
    id: 'job_product_1',
    state: 'succeeded',
    operation: 'chat.response',
    dispatch_mode: 'asynchronous',
    model_id: 'writer-alpha',
    output_text: outputText,
    output_retained: true,
    finish_reason: 'stop',
    failure_code: null,
    routing_status_code: null,
    credit_cost: 4,
    remaining_credits: 900,
    idempotent_replay: false,
  }
}

/** The rollback route's shape, for the one test that pins it. */
function completion(content: string) {
  return {
    id: 'job_product_1',
    object: 'chat.completion',
    model: 'writer-alpha',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  }
}

/** `input` on the durable route, `messages` on the rollback route — same
 *  objects, so one reader serves both. */
/**
 * The instruction text the model actually receives, wherever it travels.
 *
 * A system TURN is the `system_instruction` control. Products that do not
 * publish it never get one — the same text is folded into the single user turn
 * instead (see `prepareChatSubmission`). These tests are about WHAT the model
 * is told, not which field carried it, so read the system turns when there are
 * any and the folded user turn otherwise.
 */
function systemPrompt(body: Record<string, any>): string {
  const messages = (body.input ?? body.messages) as Array<{ role: string; content: string }>
  const system = messages.filter(message => message.role === 'system')
  if (system.length) return system.map(message => message.content).join('\n\n')
  return messages.filter(message => message.role === 'user').map(message => message.content).join('\n\n')
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
    assert.equal(model?.context_window_tokens, 1_048_576)
    assert.equal(model?.max_output_tokens, 65_536)
    assert.equal(resolveGenStudioModelId('chat', 'claude-sonnet-4-6'), 'claude-sonnet-4-6')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a strict-schema workflow on a strict-schema product still submits the actual schema', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init?: RequestInit }> = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('request_json_schema'))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      // Assert the endpoint, not the host: the base URL is operator-configurable, so
      // pinning a literal host couples this test to ambient app-settings state.
      assert.ok(url.endsWith('/v1/chat/responses'), `unexpected chat endpoint: ${url}`)
      const body = JSON.parse(String(init?.body))
      // ChatResponseRequest names: model_id / input / max_output_tokens — NOT
      // the OpenAI-compatible model / messages / max_completion_tokens.
      assert.equal(body.model_id, 'writer-alpha')
      assert.equal(body.model, undefined)
      assert.equal(body.messages, undefined)
      assert.equal(body.max_completion_tokens, undefined)
      assert.deepEqual(body.response_format, {
        type: 'json_schema',
        json_schema: {
          name: 'story_metadata',
          strict: true,
          schema: METADATA_CONTRACT.mode === 'json_schema' ? METADATA_CONTRACT.schema : {},
        },
      })
      assert.equal(body.max_output_tokens, 60_000)
      // The required shape is stated in words as well, so json_object products behave the same.
      assert.match(systemPrompt(body), /Required top-level keys: title, score/)
      assert.match(
        (init?.headers as Record<string, string>)['Idempotency-Key'],
        /^story-chat-[a-f0-9]{47}$/,
      )
      return Response.json(chatJob('{"title":"Quiet Forest","score":92}'))
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
    assert.equal(requests.filter(request => request.url.endsWith('/v1/chat/responses')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('advertised output-token limits still stop before spend', async () => {
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

test('a schema-only product adapts a plain JSON Object workflow instead of refusing it', async () => {
  const originalFetch = globalThis.fetch
  const sent: Array<Record<string, any>> = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('request_json_schema'))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      const body = JSON.parse(String(init?.body))
      sent.push(body)
      return Response.json(chatJob('{"any":"object"}'))
    }
    const result = await callChatWithGenStudio('mode-adapt-key', {
      modelId: 'writer-alpha',
      system: '',
      userMessage: 'Return one object.',
      outputContract: { mode: 'json_object' },
    })
    assert.deepEqual(JSON.parse(result.text), { any: 'object' })
    assert.equal(sent.length, 1)
    // No schema to request, so the JSON Object contract is honoured directly.
    assert.deepEqual(sent[0]!.response_format, { type: 'json_object' })
    assert.match(systemPrompt(sent[0]!), /exactly one JSON object/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a JSON Object product accepts a schema-carrying workflow and states the shape in instructions', async () => {
  const originalFetch = globalThis.fetch
  const sent: Array<Record<string, any>> = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('json_object'))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      // Assert the endpoint, not the host: the base URL is operator-configurable, so
      // pinning a literal host couples this test to ambient app-settings state.
      assert.ok(url.endsWith('/v1/chat/responses'), `unexpected chat endpoint: ${url}`)
      const body = JSON.parse(String(init?.body))
      sent.push(body)
      return Response.json(chatJob(JSON.stringify({
        thumbnails: [
          { title: 'First', prompt: 'A moonlit road.' },
          { title: 'Second', prompt: 'A quiet library.' },
        ],
      })))
    }
    const result = await callChatWithGenStudio('json-object-product-key', {
      modelId: 'writer-alpha',
      system: 'Write two thumbnails.',
      userMessage: 'Two thumbnails please.',
      outputContract: thumbnailPromptsOutputContract(2),
    })

    // (c) JSON Object output is requested, never provider-native strict schema.
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0]!.response_format, { type: 'json_object' })
    assert.equal(sent[0]!.model_id, 'writer-alpha')

    // (b) The required structure travels in the instructions.
    const system = systemPrompt(sent[0]!)
    assert.match(system, /Write two thumbnails\./)
    assert.match(system, /story_thumbnail_prompts/)
    assert.match(system, /Required top-level key: thumbnails/)
    assert.match(system, /title: string.*\[required\]/)
    assert.match(system, /prompt: string.*\[required\]/)
    assert.match(system, /exactly 2 items/)

    // (d) A valid response passes local validation and is returned intact.
    assert.deepEqual(JSON.parse(result.text), {
      thumbnails: [
        { title: 'First', prompt: 'A moonlit road.' },
        { title: 'Second', prompt: 'A quiet library.' },
      ],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local validation rejects bad output without ever claiming the request was uncharged', async () => {
  const originalFetch = globalThis.fetch
  try {
    // (e) Well-formed request, unparseable answer.
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('json_object'))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      return Response.json(chatJob('not json at all'))
    }
    const invalidJson = await callChatWithGenStudio('invalid-json-key', {
      modelId: 'writer-alpha',
      system: '',
      userMessage: 'Two thumbnails please.',
      outputContract: thumbnailPromptsOutputContract(2),
    }).then(() => null, (error: Error) => error)
    assert.ok(invalidJson instanceof Error)
    assert.match(invalidJson.message, /invalid JSON.*rejected locally/i)
    assert.doesNotMatch(invalidJson.message, UNCHARGED_CLAIM)

    // (f) Valid JSON of the wrong shape.
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('json_object'))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      return Response.json(chatJob('{"thumbnails":[{"title":"Only one"}]}'))
    }
    const wrongShape = await callChatWithGenStudio('wrong-shape-key', {
      modelId: 'writer-alpha',
      system: '',
      userMessage: 'Two thumbnails please.',
      outputContract: thumbnailPromptsOutputContract(2),
    }).then(() => null, (error: Error) => error)
    assert.ok(wrongShape instanceof Error)
    assert.match(wrongShape.message, /did not match the story_thumbnail_prompts response schema/i)

    // (g) Both failures happened after a completed provider request.
    assert.doesNotMatch(wrongShape.message, UNCHARGED_CLAIM)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the synchronous completions route stays reachable for rollback', async () => {
  // `/v1/chat/completions` is not deleted: one switch flips the whole app back
  // to it, and when it does, the request must still be the OpenAI-compatible
  // shape it always was — model / messages / max_completion_tokens.
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  const sent: Array<Record<string, any>> = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalog('json_object'))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      paths.push(new URL(url).pathname)
      sent.push(JSON.parse(String(init?.body)))
      return Response.json(completion('{"any":"object"}'))
    }
    const result = await callChatWithGenStudio('rollback-route-key', {
      modelId: 'writer-alpha',
      system: 'Return one object.',
      userMessage: 'Return one object.',
      maxOutputTokens: 4_096,
      outputContract: { mode: 'json_object' },
      transport: 'completions',
    })
    assert.deepEqual(JSON.parse(result.text), { any: 'object' })
    assert.deepEqual(paths, ['/v1/chat/completions'])
    assert.equal(sent[0]!.model, 'writer-alpha')
    assert.equal(sent[0]!.max_completion_tokens, 4_096)
    assert.equal(sent[0]!.stream, false)
    assert.ok(Array.isArray(sent[0]!.messages))
    // …and it never speaks the durable route's dialect by accident.
    assert.equal(sent[0]!.model_id, undefined)
    assert.equal(sent[0]!.input, undefined)
    assert.equal(sent[0]!.max_output_tokens, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the transport switch has exactly one resolution point', () => {
  // Default is the durable route; only the documented env value rolls back.
  const previous = process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
  try {
    delete process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
    assert.equal(resolveGenStudioChatTransport(), 'responses')
    process.env[GENSTUDIO_CHAT_TRANSPORT_ENV] = 'completions'
    assert.equal(resolveGenStudioChatTransport(), 'completions')
    process.env[GENSTUDIO_CHAT_TRANSPORT_ENV] = 'anything-else'
    assert.equal(resolveGenStudioChatTransport(), 'responses')
    // A per-call override still wins, so a test can pin either side.
    assert.equal(resolveGenStudioChatTransport('responses'), 'responses')
    delete process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
    assert.equal(resolveGenStudioChatTransport('completions'), 'completions')
  } finally {
    if (previous === undefined) delete process.env[GENSTUDIO_CHAT_TRANSPORT_ENV]
    else process.env[GENSTUDIO_CHAT_TRANSPORT_ENV] = previous
  }
})

test('an absent or unrecognized structured-output mode is read as json_object', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json([
      { ...catalog('json_object')[0], structured_output_mode: undefined },
      { ...catalog('json_object')[0], id: 'writer-beta', structured_output_mode: 'sorcery' },
    ])
    const models = await listChatModels('default-mode-key')
    assert.equal(models[0]?.structured_output_mode, 'json_object')
    assert.equal(models[1]?.structured_output_mode, 'json_object')
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

test('story workflow schemas accept complete output and reject partial output', () => {
  const schemas = [
    {
      contract: thumbnailPromptsOutputContract(2),
      valid: {
        thumbnails: [
          { title: 'First', prompt: 'A moonlit road.' },
          { title: 'Second', prompt: 'A quiet library.' },
        ],
      },
      partial: { thumbnails: [{ title: 'First', prompt: 'A moonlit road.' }] },
    },
    {
      contract: videoPromptsOutputContract(2),
      valid: {
        scenes: [
          { number: 1, title: 'First', prompt: 'Slow dolly toward a moonlit road.' },
          { number: 2, title: 'Second', prompt: 'Static shot inside a quiet library.' },
        ],
      },
      partial: {
        scenes: [{ number: 1, title: 'First', prompt: 'Slow dolly toward a moonlit road.' }],
      },
    },
    {
      contract: scenePromptPackOutputContract(['scene-1', 'scene-2'], 'visual'),
      valid: {
        results: [
          { scene_id: 'scene-1', visual_prompt: 'A wide establishing shot.' },
          { scene_id: 'scene-2', visual_prompt: 'A close-up of a sealed letter.' },
        ],
      },
      partial: {
        results: [{ scene_id: 'scene-1', visual_prompt: 'A wide establishing shot.' }],
      },
    },
    {
      contract: CONTEXTUAL_CUES_OUTPUT_CONTRACT,
      valid: {
        cues: [{
          scene_id: 'scene-1',
          title: 'Phnom Penh, 1963',
          kind: 'location_date',
          template: 'documentary-label',
          anchor_offset_sec: 0.2,
        }],
      },
      partial: { cues: [{ scene_id: 'scene-1' }] },
    },
    {
      contract: outlineOutputContract(2),
      valid: {
        chapters: [
          { n: 1, title: 'Arrival' },
          { n: 2, title: 'Discovery' },
        ],
      },
      partial: { chapters: [{ n: 1, title: 'Arrival' }] },
    },
  ]

  for (const { contract, valid, partial } of schemas) {
    // Story workflows ask for a JSON object and keep the schema for local validation.
    assert.equal(contract.mode, 'json_object')
    if (contract.mode !== 'json_object') continue
    assert.ok(contract.name)
    assert.ok(contract.schema, 'the workflow schema must be retained for local validation')
    assert.equal(jsonValueMatchesSchema(valid, contract.schema!), true)
    assert.equal(jsonValueMatchesSchema(partial, contract.schema!), false)
  }
})

test('GenStudio errors remain distinct and actionable', () => {
  assert.match(new GenStudioApiError(401, 'bad key').message, /valid account key/i)
  assert.match(new GenStudioApiError(402, 'balance too low').message, /insufficient credits/i)
  assert.match(new GenStudioApiError(403, 'scope missing').message, /scopes and product access/i)
  assert.match(new GenStudioApiError(422, 'wrong mode').message, /selected model and its output contract/i)
  assert.match(new GenStudioApiError(429, 'busy').message, /Retry-After/i)
  assert.match(new GenStudioApiError(502, 'provider failed').message, /provider behind/i)
})

test('story generation contains no hidden language-product fallback', () => {
  const videoPromptRoute = readFileSync(
    new URL('../routes/ai-video.ts', import.meta.url),
    'utf8',
  )
  const episodeGenerator = readFileSync(
    new URL('../generators/episode.ts', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(videoPromptRoute, /model\s*\|\|\s*['"]genstudio-chat:/)
  assert.doesNotMatch(episodeGenerator, /style\s*===\s*['"]custom['"]\s*\?\s*['"]deepseek/)
})
