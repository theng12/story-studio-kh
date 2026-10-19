/**
 * Idea Campaign: a saved batch whose key the Gateway PROVED dead.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * A batch is captured before it can be charged and collected on the next run by the key the
 * provider itself generated. When that key's job settles `failed` with no hold left on it — an
 * operator closing a false unknown-outcome hold (`HOLD_CLOSED`), or an ordinary provider failure —
 * collecting it again can only answer the SAME failure. The retry re-collected it and failed again,
 * forever: four production campaigns were stuck that way.
 *
 * THE PROPERTY UNDER TEST
 * -----------------------
 * A PROVEN terminal failure on a collected key releases that batch's identity (the failure is kept
 * on the record) and the same Retry asks ONCE more under a new one, sending the captured body.
 * A held or uncertain outcome is not proven and must keep replaying its key, never re-dispatch.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

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
  const { GenStudioChatTerminalFailureError, isProvenChatFailure } = await import('../lib/genstudio-client.js')
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
    assert.equal(record?.settled_failed?.idempotency_key, savedKey, 'the dead key is kept as evidence')
    assert.equal(record?.settled_failed?.failure_code, 'HOLD_CLOSED')
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
    assert.equal(env.recovery.readIdeaBatch(retry.params)?.settled_failed?.failure_code, 'HOLD_CLOSED',
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
    assert.equal(env.recovery.readIdeaBatch(retry.params)?.settled_failed, undefined,
      'a held outcome is never marked settled-failed')
  } finally { await env.close() }
})
