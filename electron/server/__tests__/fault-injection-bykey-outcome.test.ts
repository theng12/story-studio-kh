/**
 * Fault injection S1 — a Gateway restart mid-job.
 *
 * Story Studio submitted a writing request and lost the answer (the connection dropped, or the
 * Gateway restarted between the POST and the response). The Gateway owns the job either way, and
 * its by-idempotency-key reader is the only thing that can say what happened to it.
 *
 * The invariant: a by-key answer that names a SETTLED job reaches the caller as that answer, and a
 * job the Gateway still HOLDS reaches the caller carrying the Gateway's own hold — never as a bare
 * "unknown" and never as a settled failure the Gateway never wrote.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

const KEY = 'story-chat-fault-injection-bykey'
const SYSTEM = 'Write chapter narration.'
const USER = 'Write one chapter.'

async function boot(service: MockGenStudioService) {
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  return client
}

function request(extra: Record<string, unknown> = {}) {
  return {
    modelId: 'mock-chat-v1', system: SYSTEM, userMessage: USER, temperature: 0.7,
    maxOutputTokens: 2048, ...extra,
  }
}

/**
 * The Gateway already owns a job for KEY — Story's own submit was lost, which is the restart case.
 * Seeded in band: one plain failed submit creates the job, and `patchJobScenario` then makes it
 * report whatever the Gateway would report after the restart.
 */
async function seedJobFor(
  client: Awaited<ReturnType<typeof boot>>,
  service: MockGenStudioService,
): Promise<string> {
  service.queueScenario('chat', { states: ['failed'] })
  await assert.rejects(client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, request({ idempotencyKey: KEY })))
  const jobId = service.submissions.at(-1)?.jobId
  assert.ok(jobId, 'the seeding submit created a Gateway job')
  assert.equal(service.providerSubmissionCount('chat'), 1)
  return jobId
}

test('S1: a by-key answer that names a settled success is collected as the answer', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const client = await boot(service)
    const jobId = await seedJobFor(client, service)
    // The job the restart could not deliver an answer for has since succeeded.
    service.patchJobScenario(jobId, { states: ['succeeded'], outputText: 'The answer the restart could not deliver.' })

    const recovered = await client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, request({
      idempotencyKey: KEY, recoverByIdempotencyKey: true, allowedRecoveryKeys: [KEY],
    }))

    assert.equal(recovered.text, 'The answer the restart could not deliver.')
    assert.equal(service.providerSubmissionCount('chat'), 1, 'a by-key collect buys no second request')
    assert.ok(service.requests.some(entry =>
      entry.method === 'GET' && entry.path === `/v1/chat/responses/by-idempotency-key/${KEY}`),
    'the collect went through the by-key reader')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('S1: a by-key answer that names a closed hold is a definite failure with a named reason', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const client = await boot(service)
    const jobId = await seedJobFor(client, service)
    // What the Gateway publishes once an operator closes a hold it never dispatched:
    // failed / HOLD_CLOSED, recovery_required false (gateway store.py).
    service.patchJobScenario(jobId, {
      states: ['failed'], failureCode: 'HOLD_CLOSED',
      envelope: { recovery_required: false, recovery_state: null },
    })

    const error = await client.callChatWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, request({
      idempotencyKey: KEY, recoverByIdempotencyKey: true, allowedRecoveryKeys: [KEY],
    })).then(() => null, (caught: unknown) => caught as Error)

    assert.ok(error, 'a closed hold is a failure, not a success')
    assert.match(error.message, /writing/i)
    assert.doesNotMatch(error.message, /lost track/i, 'a closed hold is settled, not lost')
    assert.equal(service.providerSubmissionCount('chat'), 1, 'a by-key collect buys no second request')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('S1: a job the Gateway still holds carries its hold, and the wait loop has a settle path', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const client = await boot(service)
    const jobId = await seedJobFor(client, service)
    // A hold the Gateway has NOT closed: the answer may still be adopted.
    service.patchJobScenario(jobId, {
      states: ['failed'], failureCode: 'PROVIDER_SUBMISSION_UNCERTAIN',
      envelope: { recovery_required: true, recovery_state: 'unknown_outcome' },
    })

    const held = await client.getGenStudioJobByIdempotencyKey(
      'chat.response', service.baseUrl, MOCK_GENSTUDIO_FULL_KEY, KEY, {}, Date.now() + 5_000,
    )
    assert.equal(held.state, 'failed')
    assert.equal(client.holdsUnknownOutcome(held), true,
      'the by-key reader must carry the Gateway\'s own hold, not just its state')
    assert.equal(service.providerSubmissionCount('chat'), 1, 'reading a hold buys no second request')

    // The hold is a NAMED wait, not an unknown forever: the shared wait loop keeps polling a held
    // job for its grace window and only then lets the caller write a verdict.
    let clock = 0
    const poller = client.createGenStudioJobPoller(() => 0.5, () => clock)
    assert.equal(poller.settled(held), false, 'a held job is still running inside its grace window')
    clock += client.UNKNOWN_OUTCOME_GRACE_MS
    assert.equal(poller.settled(held), true, 'a hold that never closes still reaches a verdict')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})
