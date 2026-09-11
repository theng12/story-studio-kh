/**
 * v1.4.32 — "Retry all".
 *
 * The thing this button must never do is the thing its ancestor did: resubmit
 * work a provider may already have finished and billed. v1.0.114 removed the
 * combined "Repair & Retry all" for exactly that, after real duplicate TTS
 * charges. So the first assertions here are about what is NOT retried.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  describeRetryAllTriage,
  normaliseRepairResult,
  triageFailedJobsForRetryAll,
  type RepairRecord,
} from '../utils/repair-triage.js'

const job = (job_id: string, type: string) => ({ job_id, type })
const REPAIRABLE = new Set(['audio', 'images', 'scene_images', 'thumb_images'])
const canBeRepaired = (j: { type: string }) => REPAIRABLE.has(j.type)
const measured = (recovered: number, stillMissing: number, totalExpected: number): RepairRecord =>
  ({ outcome: 'measured', result: { recovered, stillMissing, totalExpected } })

test('a repairable job that was never repaired is NOT retried', () => {
  const t = triageFailedJobsForRetryAll([job('a', 'audio')], canBeRepaired, () => undefined)
  assert.deepEqual(t.retry, [])
  assert.equal(t.blocked.length, 1)
  assert.equal(t.blocked[0]!.reason, 'never_repaired')
})

test('a repairable job whose repair FAILED is NOT retried', () => {
  // The precise v1.0.114 shape: repair half fails, retry half fires anyway.
  const t = triageFailedJobsForRetryAll(
    [job('a', 'images')], canBeRepaired, () => ({ outcome: 'failed' }),
  )
  assert.deepEqual(t.retry, [])
  assert.equal(t.blocked[0]!.reason, 'repair_failed')
})

test('a repair that reported nothing usable is NOT retried', () => {
  const t = triageFailedJobsForRetryAll(
    [job('a', 'audio')], canBeRepaired, () => ({ outcome: 'inconclusive' }),
  )
  assert.deepEqual(t.retry, [])
  assert.equal(t.blocked[0]!.reason, 'repair_inconclusive')
})

test('a repaired job with nothing missing is NOT retried — that would buy a duplicate', () => {
  const t = triageFailedJobsForRetryAll(
    [job('a', 'audio')], canBeRepaired, () => measured(4, 0, 4),
  )
  assert.deepEqual(t.retry, [])
  assert.equal(t.alreadyComplete.length, 1)
  assert.deepEqual(t.blocked, [])
})

test('a repaired job with a PROVEN gap IS retried', () => {
  const t = triageFailedJobsForRetryAll(
    [job('a', 'audio')], canBeRepaired, () => measured(3, 2, 5),
  )
  assert.deepEqual(t.retry.map(j => j.job_id), ['a'])
  assert.deepEqual(t.blocked, [])
})

test('a type with no repair path at all IS retried without one', () => {
  // 32 of 36 job types, subtitles among them. A blanket "repair first" gate
  // would have blocked precisely the jobs he was trying to clear.
  const t = triageFailedJobsForRetryAll(
    [job('a', 'subtitles_transcribe'), job('b', 'script-only')],
    canBeRepaired,
    () => undefined,
  )
  assert.deepEqual(t.retry.map(j => j.job_id), ['a', 'b'])
  assert.deepEqual(t.blocked, [])
})

test('a mixed batch splits into three piles and loses nobody', () => {
  const records: Record<string, RepairRecord | undefined> = {
    a: measured(1, 3, 4),      // proven gap
    b: measured(4, 0, 4),      // complete
    c: undefined,              // never repaired
    d: { outcome: 'failed' },
  }
  const jobs = [
    job('a', 'audio'), job('b', 'images'), job('c', 'scene_images'),
    job('d', 'thumb_images'), job('e', 'subtitles_transcribe'),
  ]
  const t = triageFailedJobsForRetryAll(jobs, canBeRepaired, id => records[id])
  assert.deepEqual(t.retry.map(j => j.job_id), ['a', 'e'])
  assert.deepEqual(t.alreadyComplete.map(j => j.job_id), ['b'])
  assert.deepEqual(t.blocked.map(b => b.job.job_id), ['c', 'd'])
  assert.equal(
    t.retry.length + t.alreadyComplete.length + t.blocked.length, jobs.length,
    'every failed job must land in exactly one pile',
  )
})

test('the image reconciler\'s counts are read, not dropped', () => {
  // images-repair returns ImageReconcileResult, which has no `still_missing`.
  // The Jobs page read only that field, so for all three image job types it
  // found undefined and showed a bare "✓ repaired" — throwing away the one
  // number that says whether a retry is needed.
  const imageRepair = {
    recovered: 2, skipped_ok: 1, needs_fresh_generation: 3,
    unrecoverable: 1, total_expected: 7,
  }
  assert.deepEqual(normaliseRepairResult(imageRepair), {
    recovered: 2, stillMissing: 4, totalExpected: 7,
  })
})

test('the audio reconciler\'s counts are read the same way', () => {
  assert.deepEqual(
    normaliseRepairResult({ recovered: 3, still_missing: 2, total_expected: 5 }),
    { recovered: 3, stillMissing: 2, totalExpected: 5 },
  )
})

test('an image repair that recovered everything reports no gap', () => {
  assert.deepEqual(
    normaliseRepairResult({
      recovered: 5, skipped_ok: 0, needs_fresh_generation: 0,
      unrecoverable: 0, total_expected: 5,
    }),
    { recovered: 5, stillMissing: 0, totalExpected: 5 },
  )
})

test('a payload that proves nothing returns null, and null never becomes a retry', () => {
  for (const bad of [null, undefined, {}, 'ok', { recovered: 2 }, { total_expected: 5 }]) {
    assert.equal(normaliseRepairResult(bad), null, JSON.stringify(bad))
  }
  // and the only field present being an unknown one is still null
  assert.equal(normaliseRepairResult({ recovered: 1, total_expected: 4, mystery: 3 }), null)
})

test('the summary names what is being left alone and why', () => {
  const t = triageFailedJobsForRetryAll(
    [job('a', 'audio'), job('b', 'images'), job('c', 'subtitles_transcribe')],
    canBeRepaired,
    id => (id === 'a' ? measured(1, 1, 2) : undefined),
  )
  const text = describeRetryAllTriage(t)
  assert.match(text, /Retrying 2 job\(s\)/)
  assert.match(text, /Left alone: 1/)
  assert.match(text, /never repaired/)
  assert.match(text, /pay a second time/)
  assert.match(text, /Repair all/)

  const repairCouldNotFinish = describeRetryAllTriage({
    retry: [],
    alreadyComplete: [],
    blocked: [{ job: job('repair-did-not-finish', 'audio'), reason: 'repair_failed' }],
  })
  assert.match(repairCouldNotFinish, /whose repair could not finish/)
  assert.doesNotMatch(repairCouldNotFinish, /whose repair failed/)
})

test('an empty triage says so rather than claiming to have done something', () => {
  assert.equal(
    describeRetryAllTriage({ retry: [], alreadyComplete: [], blocked: [] }),
    'No jobs need another try.',
  )
})

test('Retry all is wired into the Jobs page and goes through retryJob', () => {
  // Guards the two properties the owner asked for by name: it must be a
  // separate button he presses himself (never chained onto Repair), and the
  // retries must go through the job queue rather than a parallel path that
  // would not respect its limits — a Retry-all that fired 13 episodes at once
  // would recreate the flood of 2026-08-22.
  const page = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
    'utf8',
  )
  assert.match(page, /triageFailedJobsForRetryAll/, 'the page must use the triage, not its own rule')
  assert.match(page, /async function retryAllFailed/)
  // The retry fan-out must call retryJob, which owns the per-type dispatch
  // (including the three types that re-queue through the queue's own /retry
  // to preserve their durable params).
  const retryAllStart = page.indexOf('async function retryAllFailed')
  const retryAllEnd = page.indexOf('\n}\n\n// The aggregator handles', retryAllStart)
  assert.ok(retryAllEnd > retryAllStart, 'Retry all must remain a bounded function before batch summary state')
  const retryAll = page.slice(retryAllStart, retryAllEnd + 2)
  assert.match(retryAll, /await retryJob\(/)
  // Repair-all must not call the retry.
  const repairAll = page.slice(page.indexOf('async function repairAllFailed'))
    .slice(0, repairAllLength(page))
  assert.doesNotMatch(repairAll, /retryJob\(/, 'Repair all must never chain into a retry — that is the v1.0.114 bug')
})

function repairAllLength(page: string): number {
  const start = page.indexOf('async function repairAllFailed')
  const next = page.indexOf('\n// ', start)
  return next > start ? next - start : 2000
}
