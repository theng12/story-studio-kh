/**
 * 2026-10-22 — a request the Gateway holds as an unknown outcome is SETTLING,
 * whatever it is.
 *
 * The Gateway item list already had a `held` bucket for such a request
 * (`jobStateBucket` → 'held'), and it applies to EVERY operation — the hold
 * is published by the Gateway, not something the card decides per operation.
 * The card's item counts recognised only the music case, so a held IMAGE read
 * two different ways on one card: the item list said "Held — outcome unknown"
 * and the card said "1 needs another try" for the same request.
 *
 * This pins the ONE rule both surfaces read, and the three things the
 * correction must not break:
 *   • the held SONG's own wording (Music Library, "Recover existing result");
 *   • the queued and waiting counts, which are read from their own fields and
 *     must not be subtracted twice;
 *   • the diagnostics of a failure that really IS a failure, which must stay
 *     on the card beside a held request.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { HELD_MUSIC_RESULT_GUIDANCE } from '../../electron/server/contracts/provider-task-state.js'
import { describeJobExceptions, summariseJobItems } from '../composables/useJobEta.js'
import { jobStateBucket } from '../utils/job-presentation.js'

const nowMs = Date.parse('2026-10-22T00:00:00.000Z')
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * A job whose ONE failure is an image request the Gateway still holds as an
 * unknown outcome. Eight images are done, one is held, one is not sent yet.
 */
function jobHoldingAnImage() {
  return {
    type: 'scene_images_batch',
    status: 'running',
    item_progress: {
      total: 10, completed: 8, failed: 1, settling: 0, cancelled: 0, not_submitted: 1,
      concurrency: 3, active: [],
    },
    genstudio_jobs: [
      { id: 'done-1', operation: 'image.generation', state: 'succeeded', queue_state: 'succeeded' },
      {
        id: 'held-1', operation: 'image.generation', state: 'failed', queue_state: 'failed',
        failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN', recovery_required: true, recovery_state: 'unknown_outcome',
      },
    ],
  } as any
}

test('a held request is settling for every operation, not only for a song', () => {
  const job = jobHoldingAnImage()
  const counts = summariseJobItems(job.item_progress, job.genstudio_jobs)
  assert.equal(counts.failed, 0, 'the card never says "needs another try" for a held request')
  assert.equal(counts.settling, 1, 'it is settling')
  assert.equal(counts.finished, 8)
  // …and the Gateway item list reads the SAME request the same way.
  assert.equal(jobStateBucket(job.genstudio_jobs[1]), 'held')
  assert.equal(jobStateBucket(job.genstudio_jobs[0]), 'settled')
})

test('a held request is moved out of "failed", never subtracted from anything twice', () => {
  const job = jobHoldingAnImage()
  const counts = summariseJobItems(job.item_progress, job.genstudio_jobs)
  // failed + settling is exactly the failed count the server published: the
  // held item was MOVED, not removed from the total.
  assert.equal(counts.failed + counts.settling, 1)
  assert.equal(counts.total, 10)
  assert.equal(counts.remaining, 1, 'total 10 − 8 done − 1 held')
  // The queued item is still queued, and nothing is waiting that was not.
  assert.equal(counts.queued, 1)
  assert.equal(counts.waiting, 0)
  assert.equal(counts.cancelled, 0)
})

test('a held request is never described as failed, retried or continued', () => {
  const job = jobHoldingAnImage()
  const text = describeJobExceptions(job, nowMs).map(line => line.text).join(' ')
  assert.doesNotMatch(text, /another try/i, 'a held request does not need another try')
  assert.doesNotMatch(text, /Retrying/i, 'a held request is not being retried')
  assert.doesNotMatch(text, /continue automatically/i, 'a held request is not continued')
})

test('a real failure beside a held request keeps its diagnostic', () => {
  const job = {
    ...jobHoldingAnImage(),
    item_progress: {
      total: 10, completed: 7, failed: 2, settling: 0, cancelled: 0, not_submitted: 1,
      concurrency: 3, active: [],
    },
    genstudio_jobs: [
      { id: 'done-1', operation: 'image.generation', state: 'succeeded', queue_state: 'succeeded' },
      {
        id: 'refused-1', operation: 'image.generation', state: 'failed', queue_state: 'failed',
        failure_code: 'IMAGE_CONTENT_REFUSED',
      },
      {
        id: 'held-1', operation: 'image.generation', state: 'failed', queue_state: 'failed',
        failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN', recovery_required: true, recovery_state: 'unknown_outcome',
      },
    ],
  } as any
  const counts = summariseJobItems(job.item_progress, job.genstudio_jobs)
  assert.equal(counts.failed, 1, 'the real failure still needs another try')
  assert.equal(counts.settling, 1, 'the held request is settling, not failing')
  // The refusal's own diagnostic is still on the card.
  assert.deepEqual(describeJobExceptions(job, nowMs).map(line => line.key), ['content-refused'])
})

test('an ordinary failure is still a failure', () => {
  const job = {
    ...jobHoldingAnImage(),
    genstudio_jobs: [
      { id: 'failed-1', operation: 'image.generation', state: 'failed', queue_state: 'failed', failure_code: 'PROVIDER_FAILED' },
    ],
  } as any
  assert.equal(summariseJobItems(job.item_progress, job.genstudio_jobs).failed, 1)
  assert.equal(summariseJobItems(job.item_progress, job.genstudio_jobs).settling, 0)
})

test('the held song keeps its own wording', () => {
  const job = {
    type: 'music_generate',
    status: 'error',
    item_progress: { total: 20, completed: 19, failed: 1, concurrency: 20, active: [] },
    genstudio_jobs: [
      { id: 'music-0', operation: 'music.generation', state: 'succeeded', queue_state: 'succeeded' },
      {
        id: 'held-song', operation: 'music.generation', state: 'failed', queue_state: 'failed',
        failure_code: 'PROVIDER_FAILED', recovery_required: true, recovery_state: 'unknown_outcome',
      },
    ],
  } as any
  const counts = summariseJobItems(job.item_progress, job.genstudio_jobs)
  assert.equal(counts.failed, 0)
  assert.equal(counts.settling, 1)
  assert.deepEqual(describeJobExceptions(job, nowMs), [{ key: 'held-music-result', text: HELD_MUSIC_RESULT_GUIDANCE }])
})

test('the card and the Gateway item list read ONE bucketing rule', () => {
  // The card's held count and the item list's held bucket must be the same
  // rule, or one request is described two ways again.
  const eta = read('../composables/useJobEta.ts')
  const presentation = read('../utils/job-presentation.ts')
  assert.match(eta, /jobStateBucket\(remote\) === 'held'/)
  assert.match(presentation, /if \(holdsUnknownProviderOutcome\(remote\)\) return 'held'/)
})
