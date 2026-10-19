/**
 * Idea Campaign: a saved batch whose key can never produce a usable answer.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * A batch is captured before it can be charged and collected on the next run by the key the
 * provider itself generated. Three shapes made that key spent, and every Retry re-collected it and
 * failed again, forever:
 *
 *   - the job settled `failed` with no hold left on it — an operator closing a false
 *     unknown-outcome hold (`HOLD_CLOSED`), or an ordinary provider failure (four production
 *     campaigns);
 *   - the job settled `succeeded` and Story refused the answer (unreadable JSON, a contract
 *     violation) — the retained text is replayed for that key on every attempt (Abiding Faith
 *     0073b6ef, retry of 181c588b);
 *   - the Gateway proved it never saw the key at all (HMH 1b39c51b, Minee 7849f488, History
 *     dad150e6).
 *
 * THE PROPERTY UNDER TEST
 * -----------------------
 * Any of the three releases that batch's identity (the reason is kept on the record) and the same
 * Retry asks ONCE more under a new one, sending the captured body. A held or uncertain outcome, a
 * cancellation, an unreachable Gateway and a truncated answer are not proof, and must keep
 * replaying their key.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { ideaBatchOutputContract } from '../lib/story-output-contracts.js'

const MODEL = 'mock-chat-v1'
const FORMULA = 'history-narration'
const CAMPAIGN = 'proven-failure-campaign'
const CHAT_SUBMIT_PATH = '/v1/chat/responses'
const UNUSABLE_ANSWER = 'NOT JSON AT ALL — no array here.'

function idea(title: string) {
  return {
    title,
    logline: `${title} is examined through a concrete historical turning point.`,
    themes: ['history', title],
    suggested_chapters: 8,
    suggested_length: '40 min',
    mood: 'measured',
    campaign_id: CAMPAIGN,
  }
}

function answer(titles: string[]): string {
  return JSON.stringify({ ideas: titles.map(title => idea(title)) })
}

/** Ideas the REAL duplicate filter keeps apart (see the recovery suite's own note). */
const FRESH_ANSWERS = ['The Suez Canal and the Global Clock', 'The First Weather Map'] as const

/** Jobs handed straight to the generator, drained by teardown. */
const directlyRunJobs: any[] = []
let campaignProjects = 0

function campaignJob(slug: string, params: Record<string, unknown> = {}, key = 'run'): any {
  const job: any = {
    job_id: `proven-failure-${key}`,
    project_slug: slug,
    type: 'idea_campaign',
    episode_id: 'ideas',
    title: 'Proven-failure campaign test',
    status: 'running',
    created_at: new Date().toISOString(),
    output_lines: [],
    progress: 0,
    params: {
      campaign_id: CAMPAIGN,
      count: 2,
      model: MODEL,
      series_formula_id: FORMULA,
      topic_pack_ids: [],
      genre: 'history',
      audience: 'curious adults',
      mood: 'measured',
      ...params,
    },
  }
  directlyRunJobs.push(job)
  return job
}

/** A Retry as production builds it: the ORIGINAL job's persisted params, copied forward. */
function retryJob(slug: string, previous: any, key = 'retry'): any {
  return campaignJob(slug, structuredClone(previous.params), key)
}

/** The provider job that holds a specific captured key — a POSITIVE identity match. */
function providerJobForKey(env: any, idempotencyKey: string): string {
  const jobId = env.service.submissions.find(
    (row: any) => row.operation === 'chat' && row.idempotencyKey === idempotencyKey,
  )?.jobId as string | undefined
  assert.ok(jobId, `the provider holds no chat job for captured key ${idempotencyKey}`)
  return jobId!
}

/** The idempotency key each real chat POST carried, in order. */
function chatKeys(env: any): string[] {
  return env.service.requests
    .filter((row: any) => row.method === 'POST' && row.path === CHAT_SUBMIT_PATH)
    .map((row: any) => row.idempotencyKey)
}

/** A saved pending batch, as a prior run's durable checkpoint leaves it. */
function savedBatch(env: any, idempotencyKey: string) {
  return {
    ordinal: 1, prompt: 'captured body', count: 2, model: MODEL,
    request_identity: `${env.project.slug}:${CAMPAIGN}:ideas:1`,
    outputBudget: { tier: 'long' as const, minimumTokens: 4_096 },
    outputContract: ideaBatchOutputContract(),
    slots: [], keys: ['a', 'b'],
    idempotency_key: idempotencyKey,
  }
}

async function setup() {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await import('../providers/text/genstudio.js')
  const { generateIdeaCampaign } = await import('../generators/idea-campaign.js')
  const recovery = await import('../services/idea-campaign-recovery.js')
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
  const project = await pm.createProject({ name: `Proven failure ${++campaignProjects}`, niche_id: FORMULA })
  return {
    temp, service, pm, im, recovery, generateIdeaCampaign, project,
    posts: () => service.requests.filter((row: any) => row.method === 'POST' && row.path === CHAT_SUBMIT_PATH).length,
    byKeyGets: () => service.requests.filter((row: any) => row.method === 'GET' && row.path.includes('/by-idempotency-key/')).length,
    async close() {
      const jq = await import('../services/job-queue.js')
      try {
        await jq._waitForJobPersistenceForTesting()
        for (const job of directlyRunJobs.splice(0)) {
          await jq.requestJobCancellation(job.project_slug, job.job_id).catch(() => { /* never reached the store */ })
          if (jq.getJob(job.job_id)) jq.removeTerminalJob(job.project_slug, job.job_id)
          await jq._waitForJobPersistenceForTesting()
          try {
            jq._forgetProjectPersistenceForTesting(job.project_slug)
          } catch { /* a write is still settling; each test has its own slug */ }
        }
      } finally {
        clearGenStudioCatalogCache()
        await service.close()
        await temp.cleanup()
      }
    },
  }
}

/**
 * Run once with an unparseable answer: the provider accepts and answers, the run cannot read it, and
 * the batch record is left pending with the provider's own key — the production shape of a saved
 * pending batch.
 */
async function interruptFirstSubmission(env: any) {
  env.service.queueScenario('chat', { outputText: UNUSABLE_ANSWER })
  const first = campaignJob(env.project.slug)
  await assert.rejects(() => env.generateIdeaCampaign(first), /invalid JSON|response schema/i)
  const pending = env.recovery.pendingIdeaBatch(first.params)
  assert.ok(pending?.idempotency_key, 'the paid batch is captured with the provider key it was sent under')
  assert.equal(env.posts(), 1, 'the provider was asked exactly once')
  return { first, pending }
}

test('the shared predicate releases only a PROVEN failure', async () => {
  const {
    GenStudioApiError, GenStudioChatAnswerRejectedError, GenStudioChatIncompleteError,
    GenStudioChatRecoveryUnresolvedError, GenStudioChatTerminalFailureError,
    isProvenChatFailure, isProvenUncreatedChatRequest, isProvenUnusableChatAnswer,
  } = await import('../lib/genstudio-client.js')
  const settled = (fields: Record<string, unknown>) => new GenStudioChatTerminalFailureError(
    { id: 'job-1', state: 'failed', ...fields } as any,
  )

  assert.equal(isProvenChatFailure(settled({ failure_code: 'HOLD_CLOSED' })), true,
    'an operator closing the hold settles the job with no hold left')
  assert.equal(isProvenChatFailure(settled({ failure_code: 'LOCATION_NOT_READY' })), true,
    'an ordinary provider failure is proven dead too')
  assert.equal(isProvenChatFailure(settled({ failure_code: 'UNKNOWN_OUTCOME', recovery_required: true })), false,
    'a hold may still yield a result, so its key is never released')
  assert.equal(isProvenChatFailure(settled({ failure_code: 'PROVIDER_FAILED', recovery_state: 'unknown_outcome' })), false)
  assert.equal(isProvenChatFailure(settled({ failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })), false,
    'an uncertain submission may already have been taken and charged')
  assert.equal(isProvenChatFailure(settled({ failure_code: 'PROVIDER_FAILED', cancelled: true })), false)
  assert.equal(isProvenChatFailure(new Error('not a gateway failure')), false)

  const refused = new GenStudioChatAnswerRejectedError('job-1', 'key-1', new Error('invalid JSON'))
  assert.equal(isProvenUnusableChatAnswer(refused), true)
  assert.match(refused.message, /invalid JSON/, 'the refusal keeps the words every surface shows')
  assert.equal(isProvenUnusableChatAnswer(new GenStudioChatIncompleteError({ id: 'j', model_id: 'm', output_text: 'half', finish_reason: 'length' })), false,
    'truncation is not a refused answer: the same request truncates again at the same place')
  assert.equal(isProvenUnusableChatAnswer(new Error('transport failed')), false)

  const lookup = (cause: unknown) => new GenStudioChatRecoveryUnresolvedError('key-1', cause)
  assert.equal(isProvenUncreatedChatRequest(lookup(new GenStudioApiError(404, 'not found'))), true,
    'a 404 on the read-only lookup proves the Gateway never saw the key')
  assert.equal(isProvenUncreatedChatRequest(lookup(new GenStudioApiError(502, 'bad gateway'))), false,
    'an ambiguous gateway answer proves nothing')
  assert.equal(isProvenUncreatedChatRequest(lookup(new Error('ECONNREFUSED'))), false,
    'an unreachable Gateway proves nothing')
  assert.equal(isProvenUncreatedChatRequest(new GenStudioChatRecoveryUnresolvedError('key-1')), false,
    'a lookup that never ran proves nothing')
})

test('a saved batch the Gateway PROVED dead is released and asked once more as a fresh request', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const savedKey = pending.idempotency_key as string
    const postsAfterFirst = env.posts()

    // The operator closed the hold on this key: the job is settled `failed` for good, and every
    // Retry that collects it gets the same answer.
    env.service.patchJobScenario(providerJobForKey(env, savedKey), {
      states: ['failed'],
      failureCode: 'HOLD_CLOSED',
    })
    env.service.queueScenario('chat', { outputText: answer([...FRESH_ANSWERS]) })

    const retry = retryJob(env.project.slug, first)
    await env.generateIdeaCampaign(retry)

    assert.equal(env.byKeyGets(), 1, 'the saved key is collected first, read-only')
    assert.equal(env.posts(), postsAfterFirst + 1, 'exactly ONE fresh request is sent')
    const keys = chatKeys(env)
    assert.equal(keys.length, 2)
    assert.notEqual(keys[1], savedKey, 'the fresh request carries a new provider identity, not the dead key')
    assert.equal(env.service.providerSubmissionCount('chat'), 2,
      'the fresh request is a second provider job, not a replay of the dead one')

    const stored = await env.im.getIdeas(env.project.slug)
    assert.deepEqual(stored.map((row: any) => row.title).sort(), [...FRESH_ANSWERS].sort(),
      'the fresh answer lands under the campaign')
    assert.equal(retry.result.completed, 2, 'the campaign completes')
    assert.equal(retry.result.expected, 2)
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null, 'and the batch record is resolved')

    const record = env.recovery.readIdeaBatch(retry.params)
    assert.equal(record?.settled_dead?.kind, 'failed')
    assert.equal(record?.settled_dead?.idempotency_key, savedKey, 'the dead key is kept as evidence')
    assert.equal(record?.settled_dead?.failure_code, 'HOLD_CLOSED')
    assert.ok(record?.request_identity?.includes(':fresh:'), 'the identity moved, so the body no longer derives the dead key')
  } finally { await env.close() }
})

test('a campaign already complete closes out a proven-dead capture instead of buying a replacement', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const postsAfterFirst = env.posts()
    env.service.patchJobScenario(providerJobForKey(env, pending.idempotency_key), {
      states: ['failed'],
      failureCode: 'HOLD_CLOSED',
    })
    // The campaign filled from elsewhere while this paid request sat uncollected.
    await env.im.addIdeas(env.project.slug, [idea('Done A'), idea('Done B')], MODEL, CAMPAIGN)

    const retry = retryJob(env.project.slug, first)
    await env.generateIdeaCampaign(retry)

    assert.equal(env.posts(), postsAfterFirst, 'nothing is needed, so no replacement request is bought')
    assert.equal(retry.result.completed, 2, 'the ideas already saved under the campaign still count')
    assert.deepEqual((await env.im.getIdeas(env.project.slug)).map((row: any) => row.title).sort(),
      ['Done A', 'Done B'], 'the excess is not appended')
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null, 'the dead capture is closed out')
    assert.equal(env.recovery.readIdeaBatch(retry.params)?.settled_dead?.failure_code, 'HOLD_CLOSED',
      'with what failed kept on the record')
  } finally { await env.close() }
})

test('a held unknown outcome still replays its key and never re-dispatches', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const savedKey = pending.idempotency_key as string
    const postsAfterFirst = env.posts()

    // The Gateway holds the job as an unknown outcome: it may still produce an answer, so this is
    // NOT a proven failure and must never be replaced by a second paid request.
    env.service.patchJobScenario(providerJobForKey(env, savedKey), {
      states: ['failed'],
      failureCode: 'SITE_CAPACITY_UNAVAILABLE',
      envelope: { recovery_required: true, recovery_state: 'unknown_outcome' },
    })

    const retry = retryJob(env.project.slug, first)
    const running = env.generateIdeaCampaign(retry)
    await waitFor(() => env.byKeyGets() >= 1, { label: 'the retry to collect the held saved key' })
    assert.equal(env.posts(), postsAfterFirst, 'a held outcome is waited on, never re-dispatched')

    // The held job's answer arrives, as a gateway hold eventually may: the retry collects it.
    env.service.patchJobScenario(providerJobForKey(env, savedKey), {
      states: ['succeeded'],
      outputText: answer([...FRESH_ANSWERS]),
    })
    await running

    assert.equal(env.posts(), postsAfterFirst, 'the whole Retry sent no new request at all')
    assert.equal(env.service.providerSubmissionCount('chat'), 1, 'it collected the one job it already paid for')
    assert.deepEqual((await env.im.getIdeas(env.project.slug)).map((row: any) => row.title).sort(),
      [...FRESH_ANSWERS].sort())
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null, 'the collected batch is resolved')
    assert.equal(env.recovery.readIdeaBatch(retry.params)?.settled_dead, undefined,
      'a held outcome is never released')
  } finally { await env.close() }
})

test('a saved batch whose collected answer Story refuses is released and asked once more', async () => {
  const env = await setup()
  try {
    // The provider ANSWERED this batch and its text is retained; this app cannot read it. The run
    // that saved the batch never got as far as reading that answer (its process died first), so
    // nothing was ever recorded as a rejected key — and a caller-supplied key is never recorded
    // anyway, which is why the client's own rejected-key mechanism cannot break this loop
    // (Abiding Faith 0073b6ef, retry of 181c588b).
    const { first, pending } = await interruptFirstSubmission(env)
    const savedKey = pending.idempotency_key as string
    const postsAfterFirst = env.posts()
    env.service.queueScenario('chat', { outputText: answer([...FRESH_ANSWERS]) })

    const retry = retryJob(env.project.slug, first)
    assert.equal(retry.rejected_idempotency_keys, undefined, 'no rejected key was ever recorded')
    await env.generateIdeaCampaign(retry)

    assert.equal(env.byKeyGets(), 1, 'the saved key is collected first, read-only')
    assert.equal(env.posts(), postsAfterFirst + 1, 'exactly ONE fresh request is sent')
    assert.notEqual(chatKeys(env)[1], savedKey, 'the fresh request carries a new provider identity')
    assert.equal(env.service.providerSubmissionCount('chat'), 2,
      'the fresh request is a second provider job, not a replay of the refused answer')

    const record = env.recovery.readIdeaBatch(retry.params)
    assert.equal(record?.settled_dead?.kind, 'unusable')
    assert.equal(record?.settled_dead?.idempotency_key, savedKey, 'the refused key is kept as evidence')
    assert.equal(record?.settled_dead?.provider_job_id, providerJobForKey(env, savedKey),
      'and the job holding the refused answer')
    assert.match(String(record?.settled_dead?.reason), /invalid JSON/i, 'with what was wrong with it')
    assert.ok(record?.request_identity?.includes(':fresh:'), 'the identity moved')

    assert.equal(retry.result.completed, 2, 'the campaign completes')
    assert.deepEqual((await env.im.getIdeas(env.project.slug)).map((row: any) => row.title).sort(),
      [...FRESH_ANSWERS].sort())
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null, 'and the batch record is resolved')
  } finally { await env.close() }
})

test('a saved key the Gateway proved it never received is released and asked once more', async () => {
  const env = await setup()
  try {
    // The durable checkpoint was reached but the POST never got there, so the read-only lookup
    // answers 404 — the Gateway PROVING it has no such job (HMH 1b39c51b, Minee 7849f488, History
    // dad150e6). That is not the same as "the lookup failed": see the unreachable-Gateway test.
    const run = campaignJob(env.project.slug, { idea_batch: savedBatch(env, 'story-chat-never-submitted') })
    env.service.queueScenario('chat', { outputText: answer([...FRESH_ANSWERS]) })

    await env.generateIdeaCampaign(run)

    assert.equal(env.byKeyGets(), 1, 'the lookup is read-only')
    assert.equal(env.posts(), 1, 'exactly one fresh request')
    assert.notEqual(chatKeys(env)[0], 'story-chat-never-submitted', 'under a new identity')

    const record = env.recovery.readIdeaBatch(run.params)
    assert.equal(record?.settled_dead?.kind, 'uncreated')
    assert.equal(record?.settled_dead?.idempotency_key, 'story-chat-never-submitted')
    assert.equal(record?.settled_dead?.provider_job_id, undefined, 'there is no provider job to name')
    assert.ok(record?.request_identity?.includes(':fresh:'), 'the identity moved')

    assert.equal(run.result.completed, 2, 'the campaign completes')
    assert.deepEqual((await env.im.getIdeas(env.project.slug)).map((row: any) => row.title).sort(),
      [...FRESH_ANSWERS].sort())
  } finally { await env.close() }
})

test('an unreachable Gateway proves nothing: the saved key is kept and nothing fresh is sent', async () => {
  const env = await setup()
  try {
    const settings = await import('../services/app-settings.js')
    const run = campaignJob(env.project.slug, { idea_batch: savedBatch(env, 'story-chat-never-submitted') })
    // The lookup cannot reach the Gateway at all. A transport failure is NOT an absence proof: the
    // key may well exist on the Gateway, so a fresh request here could pay for it twice.
    await settings.setGenStudioUrl('http://127.0.0.1:1')

    await assert.rejects(
      () => env.generateIdeaCampaign(run),
      /could not find the earlier language submission/,
    )

    assert.equal(env.posts(), 0, 'no fresh request is sent on unproven evidence')
    assert.equal(env.recovery.readIdeaBatch(run.params)?.idempotency_key, 'story-chat-never-submitted',
      'the saved key is preserved for a later Retry')
    assert.equal(env.recovery.readIdeaBatch(run.params)?.settled_dead, undefined,
      'and nothing is recorded as dead')
  } finally { await env.close() }
})
