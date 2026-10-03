/**
 * Tests for the OS-notification decision layer.
 *
 * Covers:
 *   • aggregateBatch counts success / fail / cancelled correctly across a
 *     fake batch and computes elapsed from min(created_at) → max(finished_at).
 *   • isBatchComplete flips only when the last queued/running job settles.
 *   • shouldNotifyForSingleJob ignores jobs that ran shorter than the
 *     threshold, and ignores batch-tagged jobs.
 *   • formatDuration produces the expected human strings.
 *   • getNotifierSettings / setNotifierSettings round-trip through
 *     app-settings.json.
 *
 * An integration-ish path through `jobEvents` with a stub Notification
 * constructor verifies that a batch settling into done+error triggers
 * exactly one notification.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { useTempDataDir } from './_helpers.js'
import {
  aggregateBatch,
  isBatchComplete,
  shouldNotifyForSingleJob,
  formatDuration,
  formatBatchMessage,
  formatFailureMessage,
  shouldNotifyFailure,
  labelForJobType,
  getBatchId,
  getNotifierSettings,
  setNotifierSettings,
  DEFAULT_NOTIFIER_SETTINGS,
} from '../services/job-notifier.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
})

after(async () => { await cleanup() })

function mkJob(overrides: Partial<Job> & Pick<Job, 'status'>): Job {
  return {
    job_id: overrides.job_id || Math.random().toString(36).slice(2, 8),
    project_slug: 'p',
    type: overrides.type || 'chapter-only',
    episode_id: overrides.episode_id || 'EP001',
    title: overrides.title || 't',
    status: overrides.status,
    created_at: overrides.created_at || '2026-04-25T00:00:00.000Z',
    started_at: overrides.started_at ?? null,
    finished_at: overrides.finished_at ?? null,
    error: overrides.error ?? null,
    output_lines: overrides.output_lines || [],
    params: overrides.params || {},
  }
}

describe('getBatchId()', () => {
  test('returns batch id when set', () => {
    const j = mkJob({ status: 'done', params: { pipeline_batch_id: 'B1' } })
    assert.equal(getBatchId(j), 'B1')
  })
  test('returns null for non-batch jobs', () => {
    assert.equal(getBatchId(mkJob({ status: 'done' })), null)
    assert.equal(getBatchId(mkJob({ status: 'done', params: { pipeline_batch_id: '' } })), null)
  })
})

describe('aggregateBatch()', () => {
  const BATCH = 'B-TEST'
  const jobs: Job[] = [
    mkJob({ status: 'done',      job_id: '1', created_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:05:00.000Z', params: { pipeline_batch_id: BATCH } }),
    mkJob({ status: 'done',      job_id: '2', created_at: '2026-04-25T00:01:00.000Z', finished_at: '2026-04-25T00:10:00.000Z', params: { pipeline_batch_id: BATCH } }),
    mkJob({ status: 'error',     job_id: '3', created_at: '2026-04-25T00:02:00.000Z', finished_at: '2026-04-25T00:08:00.000Z', params: { pipeline_batch_id: BATCH } }),
    mkJob({ status: 'cancelled', job_id: '4', created_at: '2026-04-25T00:03:00.000Z', finished_at: '2026-04-25T00:04:00.000Z', params: { pipeline_batch_id: BATCH } }),
    // Different batch — must be ignored.
    mkJob({ status: 'done',      job_id: '5', created_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:20:00.000Z', params: { pipeline_batch_id: 'OTHER' } }),
    // Non-batch job — must be ignored.
    mkJob({ status: 'done',      job_id: '6', created_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:30:00.000Z' }),
  ]

  test('counts success / fail / cancelled across the target batch only', () => {
    const s = aggregateBatch(jobs, BATCH)
    assert.equal(s.total, 4)
    assert.equal(s.success, 2)
    assert.equal(s.fail, 1)
    assert.equal(s.cancelled, 1)
    assert.equal(s.still_active, 0)
  })

  test('elapsed = max(finished_at) - min(created_at) in ms', () => {
    const s = aggregateBatch(jobs, BATCH)
    // earliest_created = 00:00, latest_finished = 00:10 → 10 minutes
    assert.equal(s.elapsed_ms, 10 * 60 * 1000)
  })

  test('still_active > 0 when any job is queued/running', () => {
    const mixed = [
      ...jobs.slice(0, 3),
      mkJob({ status: 'running', job_id: 'x', params: { pipeline_batch_id: BATCH } }),
    ]
    const s = aggregateBatch(mixed, BATCH)
    assert.equal(s.still_active, 1)
    assert.equal(isBatchComplete(s), false)
  })

  test('isBatchComplete is true when total > 0 and nothing is still active', () => {
    const s = aggregateBatch(jobs, BATCH)
    assert.equal(isBatchComplete(s), true)
  })

  test('isBatchComplete is false for an unknown batch id (total === 0)', () => {
    const s = aggregateBatch(jobs, 'NOPE')
    assert.equal(s.total, 0)
    assert.equal(isBatchComplete(s), false)
  })
})

describe('shouldNotifyForSingleJob()', () => {
  const settings = { enabled: true, min_duration_ms: 5 * 60 * 1000 } // 5 min

  test('returns false for jobs shorter than the threshold', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T00:03:00.000Z', // 3 min
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })

  test('returns true for jobs at or above the threshold', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T00:07:00.000Z', // 7 min
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), true)
  })

  test('ignores batch-tagged jobs (those route through aggregateBatch)', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T01:00:00.000Z',
      params: { pipeline_batch_id: 'B' },
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })

  test('ignores non-terminal jobs', () => {
    const j = mkJob({
      status: 'running',
      started_at: '2026-04-25T00:00:00.000Z',
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })

  test('returns false when notifications are disabled', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T01:00:00.000Z',
    })
    assert.equal(shouldNotifyForSingleJob(j, { enabled: false, min_duration_ms: 0 }), false)
  })

  test('ignores jobs missing started_at (queued-then-cancelled)', () => {
    const j = mkJob({
      status: 'cancelled',
      started_at: null,
      finished_at: '2026-04-25T00:10:00.000Z',
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })
})

describe('formatDuration()', () => {
  test('seconds under a minute', () => assert.equal(formatDuration(45_000), '45s'))
  test('minutes+seconds under an hour', () => assert.equal(formatDuration(7 * 60_000 + 3_000), '7m 3s'))
  test('hours+minutes over an hour', () => assert.equal(formatDuration(2 * 3_600_000 + 15 * 60_000), '2h 15m'))
  test('non-positive → "0s"', () => {
    assert.equal(formatDuration(0), '0s')
    assert.equal(formatDuration(-5), '0s')
  })
})

describe('formatBatchMessage()', () => {
  test('clean batch → neutral title', () => {
    const s = { batch_id: 'B', total: 5, success: 5, fail: 0, cancelled: 0, earliest_created_at: null, latest_finished_at: null, elapsed_ms: 60_000, still_active: 0 }
    const { title, body } = formatBatchMessage(s)
    assert.equal(title, 'Pipeline finished')
    assert.match(body, /5\/5 episodes succeeded/)
  })
  test('batch with failures → "with issues" title + failure count', () => {
    const s = { batch_id: 'B', total: 10, success: 7, fail: 2, cancelled: 1, earliest_created_at: null, latest_finished_at: null, elapsed_ms: 3_600_000, still_active: 0 }
    const { title, body } = formatBatchMessage(s)
    assert.equal(title, 'Pipeline finished with issues')
    assert.match(body, /7\/10/)
    assert.match(body, /2 failed/)
    assert.match(body, /1 cancelled/)
    assert.match(body, /1h/)
  })
})

describe('getNotifierSettings() / setNotifierSettings()', () => {
  beforeEach(async () => {
    // reset to defaults between tests — setNotifierSettings persists state
    await setNotifierSettings(DEFAULT_NOTIFIER_SETTINGS)
  })

  test('defaults come back when nothing is persisted', async () => {
    const got = await getNotifierSettings()
    assert.deepEqual(got, DEFAULT_NOTIFIER_SETTINGS)
  })

  test('partial patch preserves the other field', async () => {
    const after1 = await setNotifierSettings({ min_duration_ms: 120_000 })
    assert.equal(after1.min_duration_ms, 120_000)
    assert.equal(after1.enabled, DEFAULT_NOTIFIER_SETTINGS.enabled)

    const after2 = await setNotifierSettings({ enabled: false })
    assert.equal(after2.enabled, false)
    assert.equal(after2.min_duration_ms, 120_000) // unchanged
  })

  test('rejects negative or non-numeric thresholds by keeping current', async () => {
    await setNotifierSettings({ min_duration_ms: 60_000 })
    const after = await setNotifierSettings({ min_duration_ms: -5 as any })
    assert.equal(after.min_duration_ms, 60_000)
  })
})

// Integration — a bus-level test that mirrors what main.ts does. We
// fake the Notification constructor with a counter instead of importing
// Electron (tests run under tsx, no display server).
describe('batch settling fires exactly one notification', () => {
  test('done + error across a 2-episode batch → 1 notification', () => {
    const bus = new EventEmitter()
    const seen: string[] = []
    const notifiedBatches = new Set<string>()

    // The corpus the listener sees when it queries for state. A real
    // listener calls getJobs(slug); here we hand it this list.
    let corpus: Job[] = []

    function listen(job: Job) {
      if (!['done', 'error', 'cancelled'].includes(job.status)) return
      const batchId = getBatchId(job)
      if (!batchId || notifiedBatches.has(batchId)) return
      const stats = aggregateBatch(corpus, batchId)
      if (!isBatchComplete(stats)) return
      notifiedBatches.add(batchId)
      seen.push(formatBatchMessage(stats).body)
    }

    bus.on('update', listen)

    // First job transitions: running → done. Second still running.
    corpus = [
      mkJob({ status: 'done',    job_id: 'j1', started_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:02:00.000Z', params: { pipeline_batch_id: 'B' } }),
      mkJob({ status: 'running', job_id: 'j2', started_at: '2026-04-25T00:00:00.000Z', params: { pipeline_batch_id: 'B' } }),
    ]
    bus.emit('update', corpus[0])
    assert.equal(seen.length, 0, 'should not notify while j2 still running')

    // j2 errors out → batch is now complete → one notification fires.
    corpus = [
      corpus[0],
      mkJob({ status: 'error', job_id: 'j2', started_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:06:00.000Z', error: 'boom', params: { pipeline_batch_id: 'B' } }),
    ]
    bus.emit('update', corpus[1])
    assert.equal(seen.length, 1)
    assert.match(seen[0], /1\/2 episodes succeeded/)
    assert.match(seen[0], /1 failed/)

    // A stray duplicate event for the same batch does not double-fire.
    bus.emit('update', corpus[1])
    assert.equal(seen.length, 1)
  })
})

describe('per-event toggles + failures (v1.0.367)', () => {
  const ALL_ON = { pipeline_finished: true, failures: true, long_job: true }

  test('labelForJobType maps new pipeline job types to friendly names', () => {
    assert.equal(labelForJobType('scene_plan_run'), 'Scene plan')
    assert.equal(labelForJobType('continuity_render'), 'Scene render')
    assert.equal(labelForJobType('subtitles_transcribe'), 'Subtitles')
    assert.equal(labelForJobType('unknown_type'), 'unknown_type')  // graceful fallback
  })

  test('shouldNotifyFailure: only for errors, and only when failures is on', () => {
    assert.equal(shouldNotifyFailure(mkJob({ status: 'error' }), ALL_ON), true)
    assert.equal(shouldNotifyFailure(mkJob({ status: 'error' }), { ...ALL_ON, failures: false }), false)
    assert.equal(shouldNotifyFailure(mkJob({ status: 'done' }), ALL_ON), false)
  })

  test('formatFailureMessage uses the friendly label + episode + error text', () => {
    const j = mkJob({ status: 'error', type: 'continuity_render', episode_id: 'EP0001', error: 'whisper timed out' })
    const p = formatFailureMessage(j, 'My Channel')
    assert.match(p.title, /Failed: Scene render/)
    assert.match(p.title, /My Channel/)
    assert.match(p.body, /EP0001/)
    assert.match(p.body, /whisper timed out/)
  })

  test('defaults include events (all on) + digest.quiet_when_empty=false', async () => {
    await setNotifierSettings(DEFAULT_NOTIFIER_SETTINGS)
    const s = await getNotifierSettings()
    assert.deepEqual(s.events, ALL_ON)
    assert.equal(s.digest?.quiet_when_empty, false)
  })

  test('a partial events patch merges (unset keys keep their value)', async () => {
    await setNotifierSettings(DEFAULT_NOTIFIER_SETTINGS)
    const after = await setNotifierSettings({ events: { failures: false } as any, digest: { quiet_when_empty: true } as any })
    assert.equal(after.events?.failures, false)
    assert.equal(after.events?.pipeline_finished, true)
    assert.equal(after.events?.long_job, true)
    assert.equal(after.digest?.quiet_when_empty, true)
  })
})
