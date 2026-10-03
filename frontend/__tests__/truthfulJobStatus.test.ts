/**
 * Truthful job status (owner, 2026-10-03, Dreamlands audio job narrating 18 chapters on Breeze):
 *
 *   "4 items are ready. 10 items need another try. Credit outcome pending — Story Studio is
 *    checking the Gateway."  …beside "4 settled · 14 active" — while the job was still running.
 *
 *   "if it's waiting, it should be waiting, not failed. that's inaccurate. and make sure the status
 *    across all the other jobs is accurate too."
 *
 * Every job card on the Jobs page, whatever its type, reads ONE derivation (`summariseJobItems`) and
 * ONE set of exception lines (`describeJobExceptions`). These tests run that derivation for every
 * job type the owner produces, so a type cannot quietly drift back to calling a wait a failure.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { FREE_MAC_WAIT_REASON, isFreeFleetModelId, isFreeFleetWork } from '../../electron/server/contracts/provider-task-state.js'
import { describeJobExceptions, summariseJobItems } from '../composables/useJobEta.js'
import { customerSafeJobText, visibleJobOutputLines } from '../utils/job-presentation.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const nowMs = Date.parse('2026-10-03T10:00:00.000Z')
const soon = new Date(nowMs + 30_000).toISOString()

/** Every job type with a card (ideas → upload), with the Gateway operation it uses. */
const JOB_TYPES: Array<[type: string, operation: string]> = [
  ['idea_campaign', 'chat.response'],
  ['research_run', 'chat.response'],
  ['script-only', 'chat.response'],
  ['chapter-only', 'chat.response'],
  ['introduction-only', 'chat.response'],
  ['contextual_cues', 'chat.response'],
  ['image_prompts', 'chat.response'],
  ['thumb_images', 'image.generation'],
  ['scene_images_batch', 'image.generation'],
  ['scene_plan_run', 'chat.response'],
  ['continuity_render', 'image.generation'],
  ['audio', 'voice.tts'],
  ['subtitles_transcribe', 'audio.transcription'],
  ['music_generate', 'music.generation'],
  ['metadata', 'chat.response'],
  ['scene_clips_batch', 'video.generation'],
  ['youtube_upload', 'chat.response'],
]

/** The screenshot, after the fix: 18 items, 4 done, 4 generating, 10 waiting for a free Mac. */
function dreamlandsJob(type: string, operation: string, modelId = 'studio-hub::breeze-voice') {
  const active = [
    ...[2, 4, 7, 15].map(n => ({ label: `Chapter ${n}`, state: 'running' as const, attempt: 1, max_attempts: 39 })),
    ...[1, 3, 5, 6, 8, 9, 10, 11, 12, 13].map(n => ({
      label: `Chapter ${n}`, state: 'waiting_retry' as const, attempt: 1, max_attempts: 39,
      retry_at: soon, reason: FREE_MAC_WAIT_REASON,
    })),
  ]
  return {
    type,
    status: 'running',
    item_progress: { total: 18, completed: 4, failed: 0, concurrency: 18, active },
    genstudio_jobs: Array.from({ length: 18 }, (_, i) => ({
      id: `gw-${i}`, operation, model_id: modelId,
      queue_state: i < 4 ? 'succeeded' : 'running', updated_at: '',
      reserved_credits: 0, settled_credits: 0, released_credits: 0,
    })),
  }
}

describe('one derivation of item states', () => {
  test('waiting items are neither generating nor failed', () => {
    const counts = summariseJobItems(dreamlandsJob('audio', 'voice.tts').item_progress)
    assert.equal(counts.total, 18)
    assert.equal(counts.finished, 4)
    assert.equal(counts.inFlight, 4, '"generating right now" counts only items a Mac is working on')
    assert.equal(counts.waiting, 10)
    assert.equal(counts.waitingForMac, true)
    assert.equal(counts.failed, 0)
    assert.equal(counts.finished + counts.inFlight + counts.waiting + counts.failed, counts.total,
      'every item is in exactly one state, so every surface adds up to the same total')
  })

  test('a newer Gateway that keeps free work queued (`waiting`) reads the same as an old one that failed it', () => {
    const job = dreamlandsJob('audio', 'voice.tts')
    // New Gateway: Story's items are all "running"; ten of their requests say no Mac has them yet.
    job.item_progress = {
      ...job.item_progress,
      active: job.item_progress.active.map(item => ({ label: item.label, state: 'running' as const, attempt: 1, max_attempts: 4 })),
    }
    job.genstudio_jobs = job.genstudio_jobs.map((remote, i) => i >= 8
      ? { ...remote, waiting: { reason: 'every Mac is busy', next_try_at: null, since: null } }
      : remote) as typeof job.genstudio_jobs
    const counts = summariseJobItems(job.item_progress, job.genstudio_jobs)
    assert.equal(counts.inFlight, 4)
    assert.equal(counts.waiting, 10)
    assert.equal(counts.waitingForMac, true)
    assert.deepEqual(describeJobExceptions(job, nowMs).map(line => line.text),
      ['10 items are waiting for a free Mac — Story Studio will start them automatically.'])
  })

  test('a mixed backoff is "waiting to try again", not "waiting for a free Mac"', () => {
    const counts = summariseJobItems({
      total: 2, completed: 0, failed: 0, concurrency: 2,
      active: [
        { label: 'A', state: 'waiting_retry', attempt: 1, max_attempts: 4, reason: FREE_MAC_WAIT_REASON },
        { label: 'B', state: 'waiting_retry', attempt: 1, max_attempts: 4, reason: 'High demand right now' },
      ],
    })
    assert.equal(counts.waiting, 2)
    assert.equal(counts.waitingForMac, false)
  })
})

describe('every job type: a wait for a Mac is a wait', () => {
  for (const [type, operation] of JOB_TYPES) {
    test(type, () => {
      const lines = describeJobExceptions(dreamlandsJob(type, operation), nowMs).map(line => line.text)
      assert.deepEqual(lines, ['10 items are waiting for a free Mac — Story Studio will start them automatically.'])
      assert.ok(lines.every(text => !/another try|fail|credit/i.test(text)), lines.join(' | '))
    })
  }

  test('a real failure is still a failure, beside the wait, and counted once', () => {
    const job = dreamlandsJob('audio', 'voice.tts')
    job.item_progress = { ...job.item_progress, completed: 3, failed: 1 }
    assert.deepEqual(describeJobExceptions(job, nowMs).map(line => line.text), [
      '10 items are waiting for a free Mac — Story Studio will start them automatically.',
      '3 items are ready. 1 item needs another try.',
    ])
  })

  test('one waiting item reads in the singular', () => {
    const job = dreamlandsJob('thumb_images', 'image.generation')
    job.item_progress = { ...job.item_progress, active: job.item_progress.active.slice(0, 5) }
    assert.equal(describeJobExceptions(job, nowMs)[0]!.text,
      '1 item is waiting for a free Mac — Story Studio will start it automatically.')
  })
})

describe('no credit talk for free work', () => {
  test('free fleet work never says "Credit outcome pending"', () => {
    for (const [type, operation] of JOB_TYPES) {
      const job = dreamlandsJob(type, operation)
      job.item_progress = { ...job.item_progress, active: job.item_progress.active.slice(0, 4) }
      assert.deepEqual(describeJobExceptions(job, nowMs), [], type)
    }
  })

  test('paid work keeps its honest one-liner', () => {
    const job = dreamlandsJob('thumb_images', 'image.generation', 'genstudio::paid-image')
    job.genstudio_jobs = job.genstudio_jobs.map(remote => {
      const { settled_credits: _s, released_credits: _r, ...rest } = remote
      return rest
    }) as typeof job.genstudio_jobs
    job.item_progress = { ...job.item_progress, active: job.item_progress.active.slice(0, 4) }
    assert.deepEqual(describeJobExceptions(job, nowMs).map(line => line.text),
      ['Credit outcome pending — Story Studio is checking the Gateway.'])
  })

  test('free means the Gateway\'s fleet namespace, on every request of the job', () => {
    assert.equal(isFreeFleetModelId('studio-hub::breeze-voice'), true)
    assert.equal(isFreeFleetModelId('studio-hub-local::breeze-voice'), true)
    assert.equal(isFreeFleetModelId('pool::gemini-free-all'), false, 'chat pools are judged by chargeable, not here')
    assert.equal(isFreeFleetModelId('fal::flux-pro'), false)
    assert.equal(isFreeFleetWork([]), false, 'no requests is not proof of anything')
    assert.equal(isFreeFleetWork([{ model_id: 'studio-hub::a' }, { model_id: 'fal::b' }]), false)
  })

  test('the Jobs page hides the money block, the Gateway panel credits and the settlement hint for free work', () => {
    const page = read('../pages/projects/[slug]/jobs.vue')
    const ledger = read('../components/GenStudioBatchLedger.vue')
    assert.equal((page.match(/v-if="job\.genstudio_jobs\?\.length && !isFreeFleetWork\(job\.genstudio_jobs\)"/g) || []).length, 2)
    assert.match(ledger, /<template v-if="!free">/)
    assert.match(ledger, /<GenStudioCreditSettlementHint v-if="!free"/)
  })
})

describe('the Gateway panel and the card count the same items', () => {
  test('the panel header reads the shared item counts', () => {
    const page = read('../pages/projects/[slug]/jobs.vue')
    const ledger = read('../components/GenStudioBatchLedger.vue')
    assert.equal((page.match(/:items="job\.item_progress \? jobCounts\(job\) : null"/g) || []).length, 2)
    assert.match(ledger, /items\.waitingForMac \? 'waiting for a free Mac' : 'waiting to try again'/)
    // A failed Gateway request whose item is being tried again is not a failed item.
    assert.match(ledger, /v-if="exceptionJobs\.length && \(!items \|\| items\.failed\)"/)
  })

  test('the stat row and Technical details show the waiting count', () => {
    const page = read('../pages/projects/[slug]/jobs.vue')
    assert.match(page, /jobCounts\(job\)\.waitingForMac \? 'waiting for a free Mac' : 'waiting to try again'/)
    assert.ok((page.match(/jobCounts\(job\)\.waiting \}\}/g) || []).length >= 2, 'both drawers')
  })
})

describe('log lines a person can read', () => {
  test('"Gateway task: Chapter 11 -> <id>" lines are not shown', () => {
    const lines = visibleJobOutputLines([
      'Chapter 11 sent to the Gateway.',
      '  Gateway task: Chapter 11 -> 1f3a9c2e-5b7d-4e1f-9a2b-3c4d5e6f7a8b',
      '  Gateway request: Chapter 11 -> story-tts-abcdef123456',
      'Gateway task: scene-3 -> abc',
      '  Chapter 11: the Mac didn\'t answer in time — will try another Mac in 30s.',
    ])
    assert.deepEqual(lines, [
      'Chapter 11 sent to the Gateway.',
      '  Chapter 11: the Mac didn\'t answer in time — will try another Mac in 30s.',
    ])
  })

  test('"0 credits released" is dropped; a real release is kept word for word', () => {
    assert.equal(
      customerSafeJobText('Failed: Gateway generation failed (SITE_CAPACITY_UNAVAILABLE). GenStudio reports 0 credits released. No fallback route was attempted.'),
      'Failed: Gateway generation failed (SITE_CAPACITY_UNAVAILABLE). No fallback route was attempted.',
    )
    assert.match(customerSafeJobText('GenStudio reports 13 credits released.'), /GenStudio reports 13 credits released\./)
  })
})
