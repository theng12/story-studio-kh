/**
 * `max_output_tokens` has three distinct catalogue states at the paid-submit
 * boundary: absent/null, a positive integer, or malformed. Only the first is
 * an honest omission. A malformed publication must stop before POST rather
 * than being normalized into either an omitted ceiling or a one-token request.
 *
 * ZERO paid calls: every catalogue, account response, and chat job is a local
 * `fetch` fixture. The real catalogue parser and chat submit path stay intact.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callChatWithGenStudio,
  clearGenStudioCatalogCache,
} from '../lib/genstudio-client.js'

type Publication =
  | { kind: 'absent' }
  | { kind: 'published', value: unknown }

let requestSequence = 0

function catalogue(publication: Publication) {
  return [{
    id: 'writer-alpha',
    display_name: 'Writer Alpha',
    available: true,
    qualification_only: false,
    context_window_tokens: 128_000,
    ...(publication.kind === 'published' ? { max_output_tokens: publication.value } : {}),
    controls: ['max_output_tokens'],
    activation_blockers: [],
    structured_output_mode: 'json_object',
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
  }
}

function completedChatJob() {
  return {
    id: 'job-token-catalogue-validation',
    state: 'succeeded',
    operation: 'chat.response',
    dispatch_mode: 'synchronous',
    model_id: 'writer-alpha',
    output_text: 'Fixture output.',
    output_retained: true,
    finish_reason: 'stop',
    failure_code: null,
    routing_status_code: null,
    credit_cost: 0,
    remaining_credits: 900,
    idempotent_replay: false,
  }
}

async function submitFromCatalogue(publication: Publication): Promise<{
  error: Error | null
  submissions: Array<Record<string, unknown>>
}> {
  const originalFetch = globalThis.fetch
  const submissions: Array<Record<string, unknown>> = []
  requestSequence += 1
  clearGenStudioCatalogCache()
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(catalogue(publication))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if (url.endsWith('/v1/chat/responses')) {
        submissions.push(JSON.parse(String(init?.body)))
        return Response.json(completedChatJob())
      }
      throw new Error(`unexpected fixture request: ${url}`)
    }

    const error = await callChatWithGenStudio(`token-catalogue-key-${requestSequence}`, {
      modelId: 'writer-alpha',
      system: '',
      userMessage: 'Return one short fixture response.',
      outputBudget: 'maximum',
      outputContract: { mode: 'prose' },
    }).then(() => null, value => value instanceof Error ? value : new Error(String(value)))
    return { error, submissions }
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
}

for (const [label, value] of [
  ['numeric string', '4096'],
  ['fraction', 4096.5],
  ['boolean', true],
  ['zero', 0],
  ['negative integer', -4096],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ['object', { private_provider_value: 'must-not-be-echoed' }],
] as const) {
  test(`malformed published max_output_tokens (${label}) fails before chat submission`, async () => {
    const { error, submissions } = await submitFromCatalogue({ kind: 'published', value })

    assert.equal(
      submissions.length,
      0,
      `malformed max_output_tokens (${label}) reached POST as ${JSON.stringify(submissions[0])}`,
    )
    assert.ok(error instanceof Error, 'the malformed catalogue must be rejected loudly')
    assert.match(error.message, /max_output_tokens/i)
    assert.match(error.message, /writer-alpha/i, 'the error must identify the affected model')
    assert.doesNotMatch(error.message, /must-not-be-echoed/, 'arbitrary wire data must not be copied into errors')
  })
}

for (const publication of [
  { kind: 'absent' } as const,
  { kind: 'published', value: null } as const,
]) {
  test(`${publication.kind === 'absent' ? 'absent' : 'null'} max_output_tokens remains a legitimate omission`, async () => {
    const { error, submissions } = await submitFromCatalogue(publication)

    assert.equal(error, null)
    assert.equal(submissions.length, 1)
    assert.equal(
      Object.hasOwn(submissions[0] ?? {}, 'max_output_tokens'),
      false,
      'an unpublished ceiling must remain absent from the paid request',
    )
  })
}

test('a positive integer max_output_tokens reaches chat submission unchanged', async () => {
  const { error, submissions } = await submitFromCatalogue({ kind: 'published', value: 4_096 })

  assert.equal(error, null)
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0]?.max_output_tokens, 4_096)
})
