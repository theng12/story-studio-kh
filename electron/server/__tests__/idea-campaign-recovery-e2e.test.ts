/**
 * Idea Campaign recovery, end to end against the in-process mock GenStudio service.
 *
 * THE PROPERTY UNDER TEST
 * -----------------------
 * A request the provider ACCEPTED and answered, whose run died before it could read the answer, must
 * be COLLECTED on the next run by the key the provider itself generated — a read-only
 * by-idempotency-key GET, with NO second POST — even when the catalogue has changed or gone away.
 *
 * HOW A "PAID BUT UNRESOLVED" BATCH IS PRODUCED HERE
 * --------------------------------------------------
 * The first run is given an answer the output contract cannot parse. The provider job is created and
 * settles `succeeded` (its answer is retained and paid for), `onRequestPrepared` has already recorded
 * the provider's key on the batch record, and the run then throws — so the record is left pending with
 * a real key and a real provider job. `patchJobScenario` then lets that same retained job report a
 * usable answer, which is what the recovering run reads. No new mock hook is involved.
 *
 * This fixture is the ANSWERED case: the outcome was learned and the answer was rejected. It is not
 * the unknown-submission case, which is covered separately by the transport-loss test below: the
 * submit response is destroyed in flight and the SAME submission is re-sent under the same
 * idempotency key, so the provider replays the one job and nothing is stranded. The read-only
 * by-idempotency-key collect is proven by the collect-on-retry tests in this file.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { ideaBatchOutputContract } from '../lib/story-output-contracts.js'

const MODEL = 'mock-chat-v1'
const FORMULA = 'history-narration'
const CAMPAIGN = 'recovery-campaign'
const CHAT_SUBMIT_PATH = '/v1/chat/responses'

/** An answer the contract cannot parse, so the first run throws after the provider accepted it. */
const UNUSABLE_ANSWER = 'NOT JSON AT ALL — no array here.'

function idea(title: string, campaignId = CAMPAIGN) {
  return {
    title,
    logline: `${title} is examined through a concrete historical turning point.`,
    themes: ['history', title],
    suggested_chapters: 8,
    suggested_length: '40 min',
    mood: 'measured',
    campaign_id: campaignId,
  }
}

function answer(titles: string[]): string {
  return JSON.stringify({ ideas: titles.map(title => idea(title)) })
}

/**
 * Jobs handed straight to the generator, so teardown can leave the queue as it found it. The
 * generator's own durable checkpoints register these in the project's store; without this drain a
 * job would sit running in the module-scope queue for the rest of the file.
 */
const directlyRunJobs: any[] = []

/** Each test gets its OWN project slug: the queue loads a slug once per process (`loadedProjects`). */
let campaignProjects = 0

function campaignJob(slug: string, params: Record<string, unknown> = {}, key = 'run'): any {
  const job: any = {
    job_id: `recovery-${key}`,
    project_slug: slug,
    type: 'idea_campaign',
    episode_id: 'ideas',
    title: 'Recovery campaign test',
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

/**
 * A Retry as production builds it: the ORIGINAL job's persisted params, copied forward, with the job
 * identity minted fresh (routes/jobs.ts `{ ...job.params, ...minted }`). Building it from anything
 * else would prove nothing about durability.
 */
function retryJob(slug: string, previous: any, key = 'retry'): any {
  return campaignJob(slug, structuredClone(previous.params), key)
}

/**
 * The provider job that holds a specific captured key. `service.submissions` records the idempotency
 * key the client sent on each POST, so this is a POSITIVE identity match — never "the first chat job
 * of the run", which is a different job as soon as a run issues more than one batch.
 */
function providerJobForKey(env: any, idempotencyKey: string): string {
  const jobId = env.service.submissions.find(
    (row: any) => row.operation === 'chat' && row.idempotencyKey === idempotencyKey,
  )?.jobId as string | undefined
  assert.ok(jobId, `the provider holds no chat job for captured key ${idempotencyKey}`)
  return jobId!
}

/**
 * Ideas the REAL duplicate filter keeps apart. `idea()` shares one logline shape, so two titles whose
 * own words are distinct can still cross the 0.5 concept threshold — `'Alpha subject'` and
 * `'Beta subject'` do (7 shared tokens of 9). A batch that self-rejects leaves the campaign one idea
 * short, a later batch is POSTed, and the fixture's single queued scenario is already consumed.
 */
const DISTINCT_ANSWERS = ['The Suez Canal and the Global Clock', 'The First Weather Map'] as const

/**
 * The companion the repeat test pairs with `'Alpha subject'`. Six qualifying title tokens plus the
 * shared logline shape put the pair at 7/15 ≈ 0.467 concept Jaccard — below the real 0.5 `>`
 * threshold. A shorter title (the old `'The Suez Canal and the Global Clock'`) gives 7/13 ≈ 0.538,
 * so the batch self-rejects, the campaign stays short, and a second POST is issued.
 */
const REPEAT_COMPANION = 'Mapping the Monsoon Winds Across the Indian Ocean'

/**
 * Distinct subjects for the public-stop case: four qualifying title tokens each, so the pair is
 * 7/15 ≈ 0.467. (`'Held A'` has one token, which made the old pair 7/12 ≈ 0.583 and self-reject.)
 */
const STOP_SUBJECTS = ['The Berlin Airlift and the Coal Run', 'The Suez Canal and the Global Clock'] as const

/**
 * Positive control for the fixtures above. The generator filters collected answers through the REAL
 * `filterGenerated` (idea-campaign.ts:622), so a pair the filter rejects makes the campaign short and
 * triggers a second POST. Pin the positive direction explicitly — both distinct titles must survive —
 * and keep the repeat test's negative half: a stored `'Alpha subject'` must still reject its repeat.
 */
test('the distinct-title fixtures survive the real duplicate filter, and the repeat is still rejected', async () => {
  const { filterGenerated } = await import('../services/idea-similarity.js')
  const distinctPairs = [
    { label: 'DISTINCT_ANSWERS', titles: [...DISTINCT_ANSWERS] },
    { label: 'public-stop subjects', titles: [...STOP_SUBJECTS] },
    { label: 'repeat-test companion', titles: ['Alpha subject', REPEAT_COMPANION] },
  ]
  for (const fixture of distinctPairs) {
    const filtered = filterGenerated(fixture.titles.map(title => idea(title)), [])
    assert.deepEqual(filtered.kept.map(row => row.title), fixture.titles,
      `${fixture.label}: the real filter must keep both titles`)
    assert.equal(filtered.rejected.length, 0, `${fixture.label}: neither title may be rejected`)
  }

  const againstStored = filterGenerated(
    ['Alpha subject', REPEAT_COMPANION].map(title => idea(title)),
    [idea('Alpha subject')],
  )
  assert.deepEqual(againstStored.kept.map(row => row.title), [REPEAT_COMPANION],
    'the genuinely distinct companion fills the campaign\'s missing slot')
  assert.deepEqual(againstStored.rejected.map(row => row.candidate.title), ['Alpha subject'],
    'the stored repeat is still rejected by the real filter')
})

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
  const project = await pm.createProject({ name: `Recovery campaign ${++campaignProjects}`, niche_id: FORMULA })
  return {
    temp, service, pm, im, recovery, generateIdeaCampaign, project,
    /** Real HTTP POSTs to the durable chat route — replays count, so "no new POST" is exact. */
    posts: () => service.requests.filter(row => row.method === 'POST' && row.path === CHAT_SUBMIT_PATH).length,
    byKeyGets: () => service.requests.filter(row => row.method === 'GET' && row.path.includes('/by-idempotency-key/')).length,
    catalogueGets: () => service.requests.filter(row => row.method === 'GET' && row.path === '/v1/chat/models').length,
    /** The product's published limits change under the app; the cached catalogue is dropped with them. */
    async refreshCatalogue(rows: Array<Record<string, unknown>> | null) {
      service.chatModels = rows
      clearGenStudioCatalogCache()
    },
    async close() {
      // Leave the queue exactly as this test found it, through the same seams the stop test uses.
      // `getJob` is a synchronous map read and never reaches the disk, so `requestJobCancellation`
      // (which loads the slug first) is what surfaces a row the generator's own checkpoints
      // persisted; a job that never reached the store answers 404 and is already gone. Cancelling
      // and dropping the row also disarms the restart retry the load arms, because that retry reads
      // the in-memory map and finds nothing. The per-slug reset stops a later test reading or
      // skipping this one's jobs.
      //
      // Teardown must never throw: the mock server has to close even when the queue refuses a
      // control, or its LISTEN socket keeps the run from exiting.
      const jq = await import('../services/job-queue.js')
      try {
        await jq._waitForJobPersistenceForTesting()
        for (const job of directlyRunJobs.splice(0)) {
          await jq.requestJobCancellation(job.project_slug, job.job_id).catch(() => { /* never reached the store, or the type has no stop control */ })
          if (jq.getJob(job.job_id)) jq.removeTerminalJob(job.project_slug, job.job_id)
          await jq._waitForJobPersistenceForTesting()
          try {
            jq._forgetProjectPersistenceForTesting(job.project_slug)
          } catch { /* a write is still settling; each test has its own slug, so nothing crosses tests */ }
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
 * the batch record is left pending with the provider's own key. Returns that pending record.
 */
async function interruptFirstSubmission(env: any, params: Record<string, unknown> = {}) {
  env.service.queueScenario('chat', { outputText: UNUSABLE_ANSWER })
  const first = campaignJob(env.project.slug, params)
  await assert.rejects(
    () => env.generateIdeaCampaign(first),
    // The contract — not a guess — is what rejects: the answer is not valid JSON for the recorded
    // output contract. Pinned so a fixture that silently stops rejecting fails loudly.
    /invalid JSON|response schema/i,
  )
  const pending = env.recovery.pendingIdeaBatch(first.params)
  assert.ok(pending, 'the batch stays captured and unresolved')
  assert.ok(pending.idempotency_key, 'the provider key was recorded before the POST')
  assert.equal(pending.count, 2)
  // One POST: the submission is answered, the run simply cannot read the answer.
  assert.equal(env.posts(), 1, 'the provider was asked exactly once')
  return { first, pending }
}

test('an interrupted first submission is collected by its saved key on Retry, with no second POST', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const postsAfterFirst = env.posts()
    env.service.patchJobScenario(providerJobForKey(env, pending.idempotency_key), {
      outputText: answer(['The Suez Canal and the Global Clock', 'The First Weather Map']),
    })

    // R1: the retry carries the ACTUAL persisted params, as production does.
    const retry = retryJob(env.project.slug, first)
    assert.equal(env.recovery.pendingIdeaBatch(retry.params)?.idempotency_key, pending.idempotency_key)

    await env.generateIdeaCampaign(retry)

    assert.equal(env.posts(), postsAfterFirst, 'the retry must not POST again')
    assert.equal(env.byKeyGets(), 1, 'it collected through the read-only by-idempotency-key lookup')
    const stored = await env.im.getIdeas(env.project.slug)
    assert.deepEqual(stored.map(row => row.title).sort(),
      ['The First Weather Map', 'The Suez Canal and the Global Clock'])
    assert.ok(stored.every(row => row.campaign_id === CAMPAIGN))
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null, 'resolved once the answer lands')
  } finally { await env.close() }
})

test('an unavailable catalogue still collects by the saved key: zero catalogue GETs, one by-key GET, no new POST', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const postsAfterFirst = env.posts()
    env.service.patchJobScenario(providerJobForKey(env, pending.idempotency_key), {
      outputText: answer([...DISTINCT_ANSWERS]),
    })

    // The product goes away. A recovery that re-derived the request from today's catalogue would
    // refuse or re-price here; collecting must not depend on it.
    await env.refreshCatalogue([{
      id: MODEL, display_name: 'Mock Chat', description: 'unavailable', available: false,
      qualification_only: false, context_window_tokens: 128_000, max_output_tokens: 4_096,
      max_structured_items_per_request: null, controls: ['temperature', 'top_p', 'max_output_tokens'],
      activation_blockers: [], supports_structured_output: true, structured_output_mode: 'request_json_schema',
    }])
    const catalogueBefore = env.catalogueGets()

    await env.generateIdeaCampaign(retryJob(env.project.slug, first))

    assert.equal(env.posts(), postsAfterFirst, 'no new POST')
    assert.equal(env.catalogueGets(), catalogueBefore, 'the retry never read /v1/chat/models')
    assert.equal(env.byKeyGets(), 1, 'collected read-only by the saved key')
    assert.equal((await env.im.getIdeas(env.project.slug)).length, 2)
  } finally { await env.close() }
})

test('a changed catalogue still collects by the saved key', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const postsAfterFirst = env.posts()
    env.service.patchJobScenario(providerJobForKey(env, pending.idempotency_key), {
      outputText: answer([...DISTINCT_ANSWERS]),
    })

    // A different published ceiling: a rebuilt request would carry different token limits and
    // therefore a different provider key.
    await env.refreshCatalogue([{
      id: MODEL, display_name: 'Mock Chat', description: 'changed', available: true,
      qualification_only: false, context_window_tokens: 32_000, max_output_tokens: 8_192,
      max_structured_items_per_request: null, controls: ['temperature', 'top_p', 'max_output_tokens'],
      activation_blockers: [], supports_structured_output: true, structured_output_mode: 'request_json_schema',
    }])
    const catalogueBefore = env.catalogueGets()

    await env.generateIdeaCampaign(retryJob(env.project.slug, first))

    assert.equal(env.posts(), postsAfterFirst, 'no new POST under a changed ceiling')
    assert.equal(env.catalogueGets(), catalogueBefore, 'and no catalogue read before the collect')
    assert.equal((await env.im.getIdeas(env.project.slug)).length, 2)
  } finally { await env.close() }
})

test('a corrupt-but-present record fails closed with an actionable message and sends nothing', async () => {
  const env = await setup()
  try {
    await assert.rejects(
      () => env.generateIdeaCampaign(campaignJob(env.project.slug, { idea_batch: { ordinal: 'nope' } })),
      /saved batch record that cannot be read, so nothing was sent/,
    )
    assert.equal(env.posts(), 0)
    assert.equal(env.catalogueGets(), 0)
  } finally { await env.close() }
})

test('a lost transport response is re-sent under the same key, never a second provider job, and a rejected answer still leaves a durable Retry', async () => {
  const env = await setup()
  try {
    // The provider creates the job, then the response is destroyed in transport. That is NOT an
    // unknown outcome, and it is also NOT a read-only lookup in this run: `requestJsonWithRetry`
    // re-sends the SAME submission after a transport error (same Idempotency-Key, same body — the
    // header is computed once and "reused verbatim by every network retry of this submission",
    // `lib/genstudio-client.ts:7944-7945`), up to its `NETWORK_RETRY_ATTEMPTS` (`:109`). GenStudio
    // resolves the key against the existing job record and REPLAYS that job, so the durable
    // invariant is IDENTITY, not a raw HTTP POST count: exactly ONE provider job exists and every
    // POST carries the same key. The read-only by-idempotency-key collect is the path when no retry
    // can answer, and is proven by the collect-on-retry tests in this file. What this test proves is
    // that the lost response never buys a second provider job, and that the rejection still leaves a
    // durable, collectable request.
    env.service.queueScenario('chat', { dropFirstSubmitResponse: true, outputText: UNUSABLE_ANSWER })
    const first = campaignJob(env.project.slug)
    await assert.rejects(
      () => env.generateIdeaCampaign(first),
      // A collected answer the recorded contract rejects cannot report success.
      /invalid JSON|response schema/i,
    )

    const chatPosts = env.service.requests.filter(row => row.method === 'POST' && row.path === CHAT_SUBMIT_PATH)
    assert.equal(chatPosts.length, 2, 'one lost POST, then one same-key retry')
    assert.equal(new Set(chatPosts.map(row => row.idempotencyKey)).size, 1,
      'every POST carried the same idempotency key: the retry is not a fresh submission')
    const chatSubmissions = env.service.submissions.filter(row => row.operation === 'chat')
    assert.deepEqual(chatSubmissions.map(row => row.replay), [false, true],
      'the first POST created the provider job; the retry was served as a replay of it')
    assert.equal(env.service.providerSubmissionCount('chat'), 1,
      'exactly one provider job: the lost response was never a second paid send')
    assert.equal(env.byKeyGets(), 0, 'no retry was exhausted, so no read-only lookup was needed here')
    const pending = env.recovery.pendingIdeaBatch(first.params)
    assert.ok(pending, 'the run still left its batch captured')
    assert.ok(pending.idempotency_key, 'and the key was written before the transport, so nothing is stranded')

    env.service.patchJobScenario(providerJobForKey(env, pending.idempotency_key), {
      outputText: answer([...DISTINCT_ANSWERS]),
    })
    const retry = retryJob(env.project.slug, first)
    await env.generateIdeaCampaign(retry)

    assert.equal(env.service.providerSubmissionCount('chat'), 1,
      'the Retry collected the SAME provider job; it bought no second one')
    assert.equal(env.posts(), chatPosts.length, 'the Retry POSTed nothing at all')
    assert.equal(env.byKeyGets(), 1, 'the Retry collected read-only through the saved key')
    assert.deepEqual((await env.im.getIdeas(env.project.slug)).map(row => row.title).sort(),
      ['The First Weather Map', 'The Suez Canal and the Global Clock'])
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null)
  } finally { await env.close() }
})

test('a saved key the provider never saw fails closed: no POST, and the record is preserved', async () => {
  const env = await setup()
  try {
    // The durable checkpoint was reached but the POST never got there. The lookup misses, and a miss
    // is never permission to submit fresh work.
    const run = campaignJob(env.project.slug, {
      idea_batch: {
        ordinal: 1, prompt: 'captured body', count: 2, model: MODEL,
        request_identity: `${env.project.slug}:${CAMPAIGN}:ideas:1`,
        outputBudget: { tier: 'long' as const, minimumTokens: 4_096 },
        outputContract: ideaBatchOutputContract(),
        slots: [], keys: ['a', 'b'],
        idempotency_key: 'story-chat-never-submitted',
      },
    })
    await assert.rejects(
      () => env.generateIdeaCampaign(run),
      /could not find the earlier language submission for idempotency key/,
    )
    assert.equal(env.posts(), 0, 'an unresolved lookup is never permission to submit fresh work')
    assert.ok(env.byKeyGets() >= 1, 'it asked the provider, read-only, by the saved key')
    assert.equal((await env.im.getIdeas(env.project.slug)).length, 0)
    assert.equal(env.recovery.readIdeaBatch(run.params)?.idempotency_key, 'story-chat-never-submitted',
      'the record and its key are preserved for a later Retry')
  } finally { await env.close() }
})

test('the collected answer passes the real duplicate filter against stored history', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const postsAfterFirst = env.posts()
    env.service.patchJobScenario(providerJobForKey(env, pending.idempotency_key), {
      // "Alpha subject" is the stored repeat the filter must reject; the companion is genuinely
      // distinct from it (7/15 ≈ 0.467), so the batch still fills the one idea the campaign is short of.
      outputText: answer(['Alpha subject', REPEAT_COMPANION]),
    })
    // The campaign filled one slot elsewhere while this batch was in flight.
    await env.im.addIdeas(env.project.slug, [idea('Alpha subject')], MODEL, CAMPAIGN)

    const retry = retryJob(env.project.slug, first)
    await env.generateIdeaCampaign(retry)

    const stored = await env.im.getIdeas(env.project.slug)
    assert.deepEqual(stored.map(row => row.title).sort(), ['Alpha subject', REPEAT_COMPANION].sort(),
      'the repeat of "Alpha subject" was rejected by the real duplicate filter, and the new one saved')
    assert.equal(stored.filter(row => row.title === 'Alpha subject').length, 1)
    assert.equal(env.posts(), postsAfterFirst, 'still no second POST')

    // What follows proves the DURABLE IDENTITY, not the append guard: the answer is identical to what
    // is already stored, so the duplicate filter empties `kept` and `addIdeas` is never reached. The
    // atomic-append guard itself is exercised at record level, in
    // idea-campaign-recovery.test.ts ("a partial append under one identity…").
    const replayed = retryJob(env.project.slug, first, 'after-crash')
    assert.equal(env.recovery.ideaBatchRecordState(replayed.params).state, 'pending')
    assert.equal(env.recovery.readIdeaBatch(replayed.params)?.idempotency_key, pending.idempotency_key)
    await env.generateIdeaCampaign(replayed)

    const after = await env.im.getIdeas(env.project.slug)
    assert.equal(after.length, 2, 'the batch identity left exactly one copy of each idea')
    assert.equal(env.posts(), postsAfterFirst, 'and the replay still POSTed nothing')
    assert.equal(env.recovery.pendingIdeaBatch(replayed.params), null, 'the replay resolved the record')
  } finally { await env.close() }
})

test('a crash-retry that re-collects an already-appended batch counts only what it added', async () => {
  const env = await setup()
  try {
    // Run 1: three ideas are asked for and the provider answers with something the contract cannot
    // read, so the run throws and the batch is left captured with the key it was sent under.
    // `avoid_repeated_ideas: false` is what makes this reach the append at all: with the filter on,
    // every collected idea is a repeat of the row already stored and `kept` is empty.
    env.service.queueScenario('chat', { outputText: UNUSABLE_ANSWER })
    const first = campaignJob(env.project.slug, { count: 3, avoid_repeated_ideas: false })
    await assert.rejects(() => env.generateIdeaCampaign(first))
    const pending = env.recovery.pendingIdeaBatch(first.params)
    assert.ok(pending?.idempotency_key, 'the paid batch is captured with its key')
    assert.equal(pending!.count, 3)
    assert.equal(env.posts(), 1)

    // The crash window: this batch's append already landed under its own durable identity, and the
    // run died before the record could be resolved. Those rows are already part of the campaign.
    await env.im.addIdeas(env.project.slug, [idea('Alpha subject'), idea('Beta subject')], MODEL,
      env.recovery.ideaBatchAppendKey(CAMPAIGN, pending!.ordinal))

    // The provider now answers the same batch. The retry must collect it, count only anything NEW,
    // and then still make the one idea the campaign is short of instead of declaring 4 of 3.
    env.service.patchJobScenario(providerJobForKey(env, pending!.idempotency_key), {
      outputText: answer(['Alpha subject', 'Beta subject']),
    })
    env.service.queueScenario('chat', { outputText: answer(['Gamma subject']) })

    const retry = retryJob(env.project.slug, first)
    await env.generateIdeaCampaign(retry)

    assert.equal(env.byKeyGets(), 1, 'the captured batch is collected read-only by its saved key')
    assert.equal(env.posts(), 2, 'one POST for the paid batch, one for the idea still needed')
    assert.deepEqual((await env.im.getIdeas(env.project.slug)).map(row => row.title).sort(),
      ['Alpha subject', 'Beta subject', 'Gamma subject'], 'no row is stored twice')
    assert.equal(retry.result.completed, 3, 'the campaign completes at exactly the wanted count')
    assert.equal(retry.result.expected, 3)
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null, 'and the replayed record is resolved')
  } finally { await env.close() }
})

test('a partially persisted batch keeps its identity across a reread', async () => {
  const env = await setup()
  try {
    const record = {
      ordinal: 3, prompt: 'captured body', count: 2, model: MODEL,
      request_identity: `${env.project.slug}:${CAMPAIGN}:ideas:3`,
      outputBudget: { tier: 'long' as const, minimumTokens: 4_096 },
      outputContract: ideaBatchOutputContract(),
      slots: [], keys: ['a', 'b'],
    }
    const run = campaignJob(env.project.slug, { idea_batch: record })
    env.recovery.writeIdeaBatch(run, record)
    assert.equal((run.params as any).idea_batch, record, 'written into the job params themselves')

    // What a restart reads: the job's params as they come back off disk.
    const reread = JSON.parse(JSON.stringify(run.params))
    const state = env.recovery.ideaBatchRecordState(reread)
    assert.equal(state.state, 'pending')
    assert.deepEqual(state.record?.request_identity, record.request_identity)
    assert.deepEqual(state.record?.outputContract, record.outputContract)
    assert.deepEqual(state.record?.keys, ['a', 'b'])
    assert.equal(env.recovery.nextIdeaBatchOrdinal(reread), 4, 'the ordinal survives the reread')
    assert.equal(env.recovery.ideaBatchAppendKey(CAMPAIGN, 3), `${CAMPAIGN}:batch:3`)
  } finally { await env.close() }
})

test('the batch record survives the job store itself and comes back off disk', async () => {
  const env = await setup()
  const jq = await import('../services/job-queue.js')
  const fs = await import('node:fs')
  const nodePath = await import('node:path')
  const wasPaused = jq.isQueuePaused()
  let jobId = ''
  try {
    await jq.setQueuePaused(true)
    const queued = jq.enqueuePreparedForTest({
      project_slug: env.project.slug,
      type: 'idea_campaign',
      episode_id: 'ideas',
      title: 'Durable batch record',
      params: { campaign_id: CAMPAIGN, count: 2, model: MODEL },
    })
    jobId = queued.job_id
    const record = {
      ordinal: 2, prompt: 'captured body', count: 2, model: MODEL,
      request_identity: `${env.project.slug}:${CAMPAIGN}:ideas:2`,
      outputBudget: { tier: 'long' as const, minimumTokens: 4_096 },
      outputContract: ideaBatchOutputContract(),
      slots: [], keys: ['a', 'b'],
      idempotency_key: 'story-chat-already-prepared',
    }
    // Exactly what the generator does at the pre-POST checkpoint: write the record into the job's
    // own params, then persist that job. If this dropped the field, a restart could not collect.
    await jq.mutateAuthoritativeJob(env.project.slug, jobId, live => {
      env.recovery.writeIdeaBatch(live, record)
      return live
    })
    await jq._waitForJobPersistenceForTesting()

    const dir = env.pm.getProjectDir(env.project.slug)
    assert.ok(dir, 'the project has a job store directory')
    const onDisk = JSON.parse(fs.readFileSync(nodePath.join(dir!, 'jobs.json'), 'utf8'))
    const persisted = (onDisk.jobs as any[]).find(row => row.job_id === jobId)
    assert.ok(persisted, 'the job is in the persisted store')

    const reread = persisted.params
    assert.equal(env.recovery.ideaBatchRecordState(reread).state, 'pending')
    assert.equal(env.recovery.readIdeaBatch(reread)?.idempotency_key, 'story-chat-already-prepared')
    assert.equal(env.recovery.readIdeaBatch(reread)?.request_identity, record.request_identity)
    assert.equal(env.recovery.nextIdeaBatchOrdinal(reread), 3, 'the ordinal survives the restart')
  } finally {
    if (jobId) {
      const live = jq.getJob(jobId)
      if (live && ['queued', 'paused', 'running'].includes(live.status)) {
        await jq.requestJobCancellation(env.project.slug, jobId)
      }
      if (jq.getJob(jobId)) jq.removeTerminalJob(env.project.slug, jobId)
    }
    await jq.setQueuePaused(wasPaused)
    await env.close()
  }
})

test('a campaign already complete resolves a KEYLESS capture without posting', async () => {
  const env = await setup()
  try {
    await env.im.addIdeas(env.project.slug, [idea('Done A'), idea('Done B')], MODEL, CAMPAIGN)
    const run = campaignJob(env.project.slug, {
      idea_batch: {
        ordinal: 1, prompt: 'captured', count: 2, model: MODEL,
        request_identity: `${env.project.slug}:${CAMPAIGN}:ideas:1`,
        outputBudget: { tier: 'long' as const, minimumTokens: 4_096 },
        outputContract: ideaBatchOutputContract(),
        slots: [], keys: ['a', 'b'],
      },
    })
    await env.generateIdeaCampaign(run)
    assert.equal(env.posts(), 0, 'a complete campaign never posts again')
    assert.equal(env.byKeyGets(), 0, 'and a keyless capture never reached the provider, so nothing is looked up')
    assert.equal(env.recovery.pendingIdeaBatch(run.params), null, 'the keyless record was resolved')
  } finally { await env.close() }
})

test('a campaign already complete COLLECTS a keyed capture and appends nothing beyond the wanted count', async () => {
  const env = await setup()
  try {
    const { first, pending } = await interruptFirstSubmission(env)
    const postsAfterFirst = env.posts()
    env.service.patchJobScenario(providerJobForKey(env, pending.idempotency_key), {
      outputText: answer(['Excess one', 'Excess two']),
    })
    // The campaign completed from elsewhere while this paid request was uncollected.
    await env.im.addIdeas(env.project.slug, [idea('Done A'), idea('Done B')], MODEL, CAMPAIGN)

    const retry = retryJob(env.project.slug, first)
    await env.generateIdeaCampaign(retry)

    assert.equal(env.posts(), postsAfterFirst, 'the keyed capture is collected, never re-POSTed')
    assert.equal(env.byKeyGets(), 1)
    assert.deepEqual((await env.im.getIdeas(env.project.slug)).map(row => row.title).sort(),
      ['Done A', 'Done B'], 'the excess is dropped, not appended')
    assert.equal(env.recovery.pendingIdeaBatch(retry.params), null, 'and the paid batch is resolved')
  } finally { await env.close() }
})

test('a public stop while the provider is answering appends nothing and leaves the paid batch collectable', async () => {
  const env = await setup()
  const jq = await import('../services/job-queue.js')
  const wasPaused = jq.isQueuePaused()
  let jobId = ''
  const restore = jq._setExecutorForTesting('idea_campaign', job => env.generateIdeaCampaign(job))
  try {
    await jq.setQueuePaused(false)
    // The provider accepts the request and holds its answer open long enough for a real stop.
    // Distinct subjects keep the batch sufficient, so this exercises ONE paid request — a
    // self-rejecting pair would drive the queue's own auto-retry ladder for six minutes.
    env.service.queueScenario('chat', { outputText: answer([...STOP_SUBJECTS]), submitDelayMs: 3_000 })
    const queued = jq.enqueuePreparedForTest({
      project_slug: env.project.slug,
      type: 'idea_campaign',
      episode_id: 'ideas',
      title: 'Stopped recovery campaign',
      params: {
        campaign_id: CAMPAIGN, count: 2, model: MODEL,
        series_formula_id: FORMULA, topic_pack_ids: [],
        genre: 'history', audience: 'curious adults', mood: 'measured',
      },
    })
    jobId = queued.job_id
    await waitFor(() => env.service.requests.some(row => row.method === 'POST' && row.path === CHAT_SUBMIT_PATH), {
      label: 'the campaign request to reach the provider',
    })

    // A submitting campaign has a local batch loop that can stop even though the chat request it
    // already sent cannot be addressed as a remote-cancel target. The offered control must be that
    // local Stop, and its copy must not pretend the paid request was stopped upstream.
    const offered = jq.getPublicJob(jobId)!
    assert.equal(offered.control?.action, 'stop-local', 'a submitting campaign offers the local Stop')
    assert.equal(offered.control?.enabled, true)
    assert.equal(offered.control?.financial_effect, 'provider-work-may-settle',
      'the copy admits the request already sent may still settle')
    const stopped = await jq.requestJobCancellation(env.project.slug, jobId)
    assert.equal(stopped.status, 'cancelled')
    // The worker's own lifecycle is the deterministic barrier (its active id is cleared in runJob's
    // finally), so this observes it finishing — nothing sleeps for a fixed period.
    await waitFor(() => !jq._isJobWorkerActiveForTesting(jobId), { label: 'the campaign worker to finish' })

    const live = jq.getJob(jobId)!
    const pending = env.recovery.pendingIdeaBatch(live.params)
    assert.ok(pending, 'the stopped run left its batch captured')
    assert.ok(pending.idempotency_key, 'with the provider key it had already sent under')
    assert.equal((await env.im.getIdeas(env.project.slug)).length, 0, 'a stop appends nothing')
    assert.ok(live.output_lines.some(line => line.includes('may still finish and be charged')),
      'the log tells the owner the request already sent may still settle')
    // The batch's outcome stays recoverable read-only, by the key it was sent under — never a new POST.
    const postsAfterStop = env.posts()
    await jq.recheckJobProviderStatus(env.project.slug, jobId)
    assert.equal(env.posts(), postsAfterStop, 'recovery reads the saved key and never re-POSTs')
    assert.ok(env.byKeyGets() >= 1, 'the provider was asked by idempotency key')
  } finally {
    // Teardown must always reach restore() and env.close(). This guard only cancels a row that an
    // earlier assertion left running; a job already stopped above is skipped by the status check.
    try {
      if (jobId) {
        await waitFor(() => !jq._isJobWorkerActiveForTesting(jobId), { label: 'the campaign worker to join before teardown' })
          .catch(() => { /* nothing to join if the worker never started */ })
        const live = jq.getJob(jobId)
        if (live && ['queued', 'paused', 'running'].includes(live.status)) {
          await jq.requestJobCancellation(env.project.slug, jobId)
            .catch(() => { /* the row is terminal or already stopped; removal below handles it */ })
        }
        if (jq.getJob(jobId)) jq.removeTerminalJob(env.project.slug, jobId)
      }
    } finally {
      try {
        await jq.setQueuePaused(wasPaused)
      } finally {
        restore()
        await env.close()
      }
    }
  }
})
