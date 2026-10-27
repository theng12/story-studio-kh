/**
 * Image input on the chat lane — the transport half of the opt-in stronger
 * scene-image check (owner 2026-10-27).
 *
 * The Gateway's chat path forwards OpenAI-style content parts (`text` +
 * `image_url`) to OpenRouter and Google and has NO image-asset field at all.
 * So the picture rides inside `messages`, and the idempotency key hashes the
 * image's SHA-256 rather than a megabyte of base64.
 *
 * ZERO paid calls: every response below is a hand-written envelope served by a
 * local fetch stub. Nothing here touches a Gateway.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  _setGenStudioPollLadderForTesting,
  buildGenStudioChatIdempotencyKey,
  callChatWithGenStudio,
  chatImageEligibility,
  chatProductAcceptsImages,
} from '../lib/genstudio-client.js'

function catalog(over: Record<string, unknown> = {}) {
  return [{
    id: 'vision-free',
    display_name: 'Vision Free',
    provider_id: 'openrouter-main',
    provider_name: 'OpenRouter',
    available: true,
    qualification_only: false,
    context_window_tokens: 128_000,
    max_output_tokens: 4_096,
    controls: ['temperature', 'max_output_tokens', 'system_instruction'],
    activation_blockers: [],
    structured_output_mode: 'json_object',
    supports_structured_output: true,
    supports_vision: true,
    ...over,
  }]
}

function accountOverview() {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
  }
}

function job(fields: Record<string, unknown>) {
  return {
    id: 'job_image_1',
    operation: 'chat.response',
    dispatch_mode: 'asynchronous',
    model_id: 'vision-free',
    output_text: null,
    output_retained: false,
    finish_reason: null,
    failure_code: null,
    routing_status_code: null,
    credit_cost: 0,
    remaining_credits: 900,
    idempotent_replay: false,
    ...fields,
  }
}

/** One scripted accepted→succeeded progression, capturing what was submitted. */
function stubGateway(rows: unknown[]) {
  const originalFetch = globalThis.fetch
  const submits: Array<{ key: string; body: Record<string, any> }> = []
  let polls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) return Response.json(rows)
    if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      submits.push({
        key: String((init?.headers as Record<string, string>)['Idempotency-Key']),
        body: JSON.parse(String(init?.body)) as Record<string, any>,
      })
      return Response.json(job({ state: 'accepted', output_text: null }), { status: 202 })
    }
    polls += 1
    return Response.json(job({
      state: 'succeeded',
      output_text: '{"anatomy":{"verdict":"pass","findings":[]}}',
      output_retained: true,
      finish_reason: 'stop',
      credit_cost: 0,
    }))
  }
  return { submits, polls: () => polls, restore: () => { globalThis.fetch = originalFetch } }
}

const JPEG = Buffer.from('not really a jpeg, but the transport never decodes it')
const DATA_URI = `data:image/jpeg;base64,${JPEG.toString('base64')}`
const SHA = createHash('sha256').update(JPEG).digest('hex')

const imageRequest = {
  modelId: 'vision-free',
  system: 'You are an inspector.',
  userMessage: 'Judge this picture.',
  temperature: 0,
  outputContract: { mode: 'json_object' } as const,
  inputImage: { dataUri: DATA_URI, sha256: SHA },
}

test('a picture rides as OpenAI-style content parts, never as an asset id', async (t) => {
  _setGenStudioPollLadderForTesting([0])
  const stub = stubGateway(catalog())
  t.after(() => { stub.restore(); _setGenStudioPollLadderForTesting(null) })

  const result = await callChatWithGenStudio('test-key', imageRequest)
  assert.equal(result.text, '{"anatomy":{"verdict":"pass","findings":[]}}')
  assert.equal(stub.submits.length, 1, 'one submission')

  const body = stub.submits[0]!.body
  assert.equal(body.model_id, 'vision-free')
  // No invented field may appear anywhere on the wire.
  assert.equal('input_image' in body, false, 'the Gateway has no image-asset field')
  assert.equal(Array.isArray(body.input), true)
  const user = body.input[body.input.length - 1]
  assert.equal(user.role, 'user')
  assert.equal(Array.isArray(user.content), true, 'the user turn is content parts')
  const textPart = user.content.find((part: any) => part.type === 'text')
  const imagePart = user.content.find((part: any) => part.type === 'image_url')
  assert.equal(textPart.text, 'Judge this picture.')
  assert.equal(imagePart.image_url.url, DATA_URI, 'the bytes ARE the data URI')
  assert.equal(body.response_format.type, 'json_object', 'json_object where the row publishes it')
  assert.equal(body.temperature, 0)
})

test('the idempotency key hashes the image digest, never the base64', () => {
  const otherBase64 = `data:image/jpeg;base64,${Buffer.from('different bytes, same stated digest').toString('base64')}`
  const sameDigest = buildGenStudioChatIdempotencyKey({
    ...imageRequest,
    inputImage: { dataUri: otherBase64, sha256: SHA },
  })
  assert.equal(sameDigest, buildGenStudioChatIdempotencyKey(imageRequest),
    'the same picture digest must replay, whatever the encoding looked like')

  const otherDigest = buildGenStudioChatIdempotencyKey({
    ...imageRequest,
    inputImage: { dataUri: DATA_URI, sha256: 'b'.repeat(64) },
  })
  assert.notEqual(otherDigest, buildGenStudioChatIdempotencyKey(imageRequest),
    'a different picture is a different request')

  // The text-only key is unchanged by all of this: a caller with no picture
  // hashes exactly what it always did.
  const textOnly = { modelId: 'vision-free', system: 's', userMessage: 'u', outputContract: { mode: 'json_object' } as const }
  assert.equal(buildGenStudioChatIdempotencyKey({ ...textOnly }), buildGenStudioChatIdempotencyKey({ ...textOnly, inputImage: undefined }))
})

test('a model that publishes no image input is refused before anything is submitted', async (t) => {
  _setGenStudioPollLadderForTesting([0])
  const stub = stubGateway(catalog({ supports_vision: false }))
  t.after(() => { stub.restore(); _setGenStudioPollLadderForTesting(null) })

  await assert.rejects(
    callChatWithGenStudio('test-key', imageRequest),
    /does not publish image input support.*No request or credit charge was made/s,
  )
  assert.equal(stub.submits.length, 0, 'nothing was submitted and nothing could be charged')
})

test('an Anthropic-provider row is refused for images, from the published provider kind', async (t) => {
  _setGenStudioPollLadderForTesting([0])
  const stub = stubGateway(catalog({ provider_id: 'anthropic-direct', display_name: 'Claude Something' }))
  t.after(() => { stub.restore(); _setGenStudioPollLadderForTesting(null) })

  await assert.rejects(
    callChatWithGenStudio('test-key', imageRequest),
    /Claude Something.*cannot convert image input yet/,
  )
  assert.equal(stub.submits.length, 0)
})

test('eligibility is decided only by published capability and provider kind', () => {
  assert.equal(chatProductAcceptsImages({ supports_vision: true, provider_id: 'openrouter-main', display_name: 'A' }), true)
  assert.equal(chatProductAcceptsImages({ supports_vision: true, provider_id: 'google-ai', display_name: 'B' }), true,
    'a provider kind with no known image limitation is eligible — never excluded by name')
  assert.equal(chatProductAcceptsImages({ supports_vision: false, provider_id: 'openrouter-main', display_name: 'C' }), false)
  assert.equal(chatProductAcceptsImages({ supports_vision: true, provider_id: 'anthropic-direct', display_name: 'D' }), false)
  // No published provider kind is NOT a refusal: absence is not evidence (§6),
  // and the menu says the kind is unknown rather than guessing.
  assert.equal(chatProductAcceptsImages({ supports_vision: true, display_name: 'E' }), true)
  assert.equal(chatImageEligibility({ supports_vision: false, display_name: 'F' }).eligible, false)
})

test('a prose-only row gets no response_format and still carries the picture', async (t) => {
  _setGenStudioPollLadderForTesting([0])
  const stub = stubGateway(catalog({ structured_output_mode: 'none', max_output_tokens: 0 }))
  t.after(() => { stub.restore(); _setGenStudioPollLadderForTesting(null) })

  await callChatWithGenStudio('test-key', { ...imageRequest, outputContract: { mode: 'prose' } })
  const body = stub.submits[0]!.body
  assert.equal('response_format' in body, false, 'nothing the row never advertised is sent')
  assert.equal(Array.isArray(body.input[body.input.length - 1].content), true)
})
