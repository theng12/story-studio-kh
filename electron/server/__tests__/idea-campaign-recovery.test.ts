/**
 * Idea Campaign recovery: a batch is captured before it can be charged, replayed from its own body
 * on a retry, and appended at most once.
 *
 * The provider derives its idempotency key from the request BODY, so a retry can only collect its
 * own answer by sending the same body again — a rebuilt body carries a new key and buys a second
 * job. These tests pin the capture, the replay wiring, and the append idempotency.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let im: typeof import('../services/idea-manager.js')
let pm: typeof import('../services/project-manager.js')
let recovery: typeof import('../services/idea-campaign-recovery.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'idea-recovery'
const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

function idea(title: string) {
  return {
    title, logline: `${title} — a concrete historical turning point.`, themes: [title],
    suggested_chapters: 8, suggested_length: '40 min', mood: 'calm',
  }
}

before(async () => {
  tmp = await useTempDataDir()
  im = await import('../services/idea-manager.js')
  pm = await import('../services/project-manager.js')
  recovery = await import('../services/idea-campaign-recovery.js')
})

beforeEach(async () => {
  await tmp.cleanup()
  tmp = await useTempDataDir()
  const dir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ slug: SLUG, name: 'Idea Recovery' }))
  await fs.writeFile(path.join(dir, 'ideas.json'), JSON.stringify({ ideas: [], next_episode_number: 1, recycled_numbers: [] }))
})

after(async () => { await tmp.cleanup() })

describe('the durable batch record', () => {
  const record = {
    ordinal: 2, count: 7, model: 'mock-chat-v1', prompt: 'exact body', keys: ['EP0001', 'EP0002'],
    request_identity: 'slug:campaign:ideas:2',
    outputBudget: { tier: 'long' as const, minimumTokens: 7_168 },
    outputContract: { mode: 'json_object' as const, schema: { type: 'object' } },
    idempotency_key: 'story-chat-abc',
  }

  test('round-trips through the job params and advances the ordinal', () => {
    const job: any = { params: {} }
    recovery.writeIdeaBatch(job, { ...record })
    assert.deepEqual(recovery.readIdeaBatch(job.params), record)
    assert.equal(recovery.nextIdeaBatchOrdinal(job.params), 3, 'the next batch is the next ordinal')
    assert.equal(recovery.nextIdeaBatchOrdinal({}), 1, 'a fresh campaign starts at 1')
  })

  test('a captured-but-unresolved batch is pending; a resolved one is not', () => {
    const job: any = { params: {} }
    recovery.writeIdeaBatch(job, { ...record })
    assert.equal(recovery.pendingIdeaBatch(job.params)?.ordinal, 2)
    recovery.writeIdeaBatch(job, { ...record, idea_ids: ['idea-1'] })
    assert.equal(recovery.pendingIdeaBatch(job.params), null, 'appended ideas resolve the batch')
    recovery.writeIdeaBatch(job, { ...record, resolved: true })
    assert.equal(recovery.pendingIdeaBatch(job.params), null, 'an answered batch with no usable idea is resolved too')
  })

  test('a malformed record is treated as absent rather than trusted', () => {
    // A record that is PRESENT but unreadable is `malformed`, never silently absent — the caller
    // fails closed on it rather than minting a fresh paid request.
    for (const bad of [{}, { ordinal: 0 }, { ...record, count: 0 }, { ...record, keys: 'x' },
      { ...record, request_identity: '' }, { ...record, outputContract: 'x' }]) {
      assert.equal(recovery.ideaBatchRecordState({ idea_batch: bad }).state, 'malformed', JSON.stringify(bad))
    }
    assert.equal(recovery.ideaBatchRecordState({}).state, 'absent', 'no record at all is absent')
    assert.equal(recovery.ideaBatchRecordState({ idea_batch: null }).state, 'absent')
  })

  test('the append identity is namespaced by campaign, so campaigns cannot collide', () => {
    assert.equal(recovery.ideaBatchAppendKey('campaign-a', 1), 'campaign-a:batch:1')
    assert.notEqual(recovery.ideaBatchAppendKey('campaign-a', 1), recovery.ideaBatchAppendKey('campaign-b', 1))
    assert.notEqual(recovery.ideaBatchAppendKey('campaign-a', 1), recovery.ideaBatchAppendKey('campaign-a', 2))
  })
})

describe('the append happens at most once', () => {
  test('a retry after the ideas were written returns them instead of appending again', async () => {
    const key = recovery.ideaBatchAppendKey('campaign-x', 1)
    const first = await im.addIdeas(SLUG, [idea('Alpha'), idea('Beta')], 'mock-chat-v1', key)
    assert.equal(first.length, 2)

    // The crash window: the append landed, the caller's checkpoint did not. A retry re-runs the same
    // append under the same durable identity.
    const second = await im.addIdeas(SLUG, [idea('Alpha'), idea('Beta')], 'mock-chat-v1', key)
    assert.deepEqual(second.map(item => item.id), first.map(item => item.id), 'the same stored ideas come back')

    const stored = await im.getIdeas(SLUG, 'new')
    assert.equal(stored.length, 2, 'the project still holds exactly one copy')
  })

  test('a partial append under one identity keeps the stored items and adds only the remainder', async () => {
    const key = recovery.ideaBatchAppendKey('campaign-partial', 1)
    // Only part of the batch landed under this identity (the caller died before the rest).
    const first = await im.addIdeas(SLUG, [idea('Alpha')], 'mock-chat-v1', key)
    assert.deepEqual(first.map(item => item.title), ['Alpha'])

    // The retry re-sends the WHOLE batch. The remainder must be appended, not dropped, and the
    // already-stored item must not be doubled.
    const second = await im.addIdeas(SLUG, [idea('Alpha'), idea('Beta')], 'mock-chat-v1', key)
    assert.deepEqual(second.map(item => item.title), ['Alpha', 'Beta'], 'the caller gets the complete set')
    assert.equal(second[0]?.id, first[0]?.id, 'the stored item keeps its own row')
    assert.deepEqual((await im.getIdeas(SLUG, 'new')).map(item => item.title), ['Alpha', 'Beta'],
      'exactly once, in the order they first appeared')

    // A third identical send is a no-op: the identity is complete.
    const third = await im.addIdeas(SLUG, [idea('Alpha'), idea('Beta')], 'mock-chat-v1', key)
    assert.deepEqual(third.map(item => item.title), ['Alpha', 'Beta'])
    assert.equal((await im.getIdeas(SLUG, 'new')).length, 2)
  })

  test('a different batch identity still appends, and no identity keeps the old append-only behaviour', async () => {
    await im.addIdeas(SLUG, [idea('Gamma')], 'mock-chat-v1', recovery.ideaBatchAppendKey('campaign-x', 1))
    await im.addIdeas(SLUG, [idea('Delta')], 'mock-chat-v1', recovery.ideaBatchAppendKey('campaign-x', 2))
    await im.addIdeas(SLUG, [idea('Epsilon')], 'mock-chat-v1')
    assert.equal((await im.getIdeas(SLUG, 'new')).length, 3)
  })
})

describe('the generator replays its captured body', () => {
  const campaign = source('../generators/idea-campaign.ts')

  test('a pending batch is collected from its captured prompt, not rebuilt', () => {
    // The record is read through `ideaBatchRecordState`, which distinguishes a pending batch from a
    // malformed one; only the pending case replays.
    assert.match(campaign, /let replayBatch = batchState\.state === 'pending' \? batchState\.record : null/)
    assert.match(campaign, /const prompt = replayBatch \? replayBatch\.prompt :/)
    assert.match(campaign, /let prompt = replayBatch\?\.prompt \?\?/)
    assert.match(campaign, /const count = replayBatch \? replayBatch\.count : await ideaBatchForModel\(needed\)/)
    // Merged-only decision (present in neither lane): on a replay the loop guard is sized from the
    // captured count, never a live catalogue read — required so a keyed capture for an
    // already-complete campaign (remaining === 0) is still collected instead of dividing by zero.
    assert.match(campaign, /const firstBatch = replayBatch \? replayBatch\.count : await ideaBatchForModel\(remaining\)/)
  })

  test('the provider key is the one it generated, recorded before dispatch, and replayed read-only', () => {
    assert.match(campaign, /onRequestPrepared: async key => \{ batchRecord!\.idempotency_key = key/)
    assert.match(campaign, /onJobAccepted: async providerJobId => \{ batchRecord!\.provider_job_id = providerJobId/)
    assert.match(campaign, /recoverByIdempotencyKey: true, allowedRecoveryKeys: \[replayBatch\.idempotency_key\]/)
    // Persisted BEFORE the call on both paths, plus the resolution write afterwards.
    assert.equal((campaign.match(/writeIdeaBatch\(job, batchRecord\)\n\s*await jq\.checkpointJobState\(job\)/g) || []).length, 3)
  })

  test('nothing is appended after a cancellation that arrived while the provider answered', () => {
    assert.match(campaign, /A cancellation that arrived while the provider was answering stops HERE/)
    assert.match(campaign, /if \(jq\.isCancelled\(job\.job_id\)\) throw new Error\('Idea Campaign cancelled'\)\n\s+let appended/)
  })

  test('a held lookup waits on the job instead of falling through to a fresh submit', () => {
    // A gateway hold (`recovery_required` / `unknown_outcome`) is NOT a settled outcome, so the
    // read-only lookup must keep waiting on the job it already paid for. An end-to-end test of this
    // would cost the poller's whole `UNKNOWN_OUTCOME_GRACE_MS` (5 minutes) — see
    // `createGenStudioJobPoller.settled` — so the wiring is pinned here and the bounded cases
    // (a missing key, a lost submit response) are the E2E ones.
    const client = source('../lib/genstudio-client.ts')
    assert.match(client, /if \(initial\.state === 'failed' && !holdsUnknownOutcome\(initial\)\)/)
    assert.match(client, /const completed = initial\.state === 'succeeded'\s*\n\s*\? initial\s*\n\s*: await waitForChatJob\(/)
    assert.doesNotMatch(client, /holdsUnknownOutcome\(initial\)\)\s*\{[^}]*submitLanguageJson/)
  })

  test('an answered batch is marked resolved and never replayed', () => {
    assert.match(campaign, /batchRecord\.resolved = true/)
    assert.match(campaign, /replayBatch = null/)
    // Provenance names the WHOLE set under the batch identity; only the COUNTING is narrowed to this
    // call's remainder. A batch partly appended by an earlier run must still be named in full.
    assert.match(campaign, /if \(storedUnderBatch\.length\) batchRecord\.idea_ids = storedUnderBatch\.map\(idea => idea\.id\)/)
    assert.doesNotMatch(campaign, /if \(appended\.length\) batchRecord\.idea_ids/)
  })

  test('the append is keyed by the durable batch identity, not the campaign label', () => {
    assert.match(campaign, /ideaBatchAppendKey\(request\.campaign_id, ordinal\)/)
    assert.doesNotMatch(campaign, /im\.addIdeas\(\s*job\.project_slug,\s*kept,\s*request\.model,\s*request\.campaign_id,/)
  })

  test('a replay dispatches the captured model and budget, never today\'s', () => {
    // The model and the output-token budget are both part of the request BODY the provider hashes
    // into its key, and the record captures them precisely so a replay sends the body that was
    // bound. A channel whose preset model or published ceiling changed between runs would otherwise
    // replay new ones while claiming the old key. Pinned at source level: the E2E fixture varies the
    // catalogue, not the job's model.
    assert.match(campaign, /const requestForBatch = \{ \.\.\.request, count, \.\.\.\(replayBatch \? \{ model: replayBatch\.model \} : \{\}\) \}/)
    assert.match(campaign, /outputBudget: batchRecord\.outputBudget/)
    assert.match(campaign, /callAiWithRetry\(batchRecord\.model, '', prompt, apiKeys, false, context\)/)
    // The ideas are filed under the model that actually produced them.
    assert.match(campaign, /batchRecord!\.model,\s*\n\s*ideaBatchAppendKey\(request\.campaign_id, ordinal\),/)
  })
})
