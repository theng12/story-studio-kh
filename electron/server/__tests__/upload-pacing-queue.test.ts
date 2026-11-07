/**
 * Focused behaviour tests for the upload-pacing queue glue (Story 386 Item 1).
 *
 * These pin the GLUE, not the pure pacing algorithm (that lives in
 * upload-pacing.test.ts): that a job's own pacing inputs are read from the job
 * and the passed channel context, that a hold becomes the queue's durable
 * marker, and that one held channel's verdict does not leak to another.
 *
 * No Story suite is run for this file yet (lane not granted); it is written to
 * be run with `--only upload-pacing-queue` once the lead releases the lane.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Job } from '../models/types.js'
import type { UploadPacingPolicy } from '../services/upload-pacing.js'
import {
  evaluateJobPacing,
  pacingHoldReason,
  applyPacingHold,
  jobWaitingReason,
  publishAtOf,
  uploadOnOf,
  PACING_RETRY_PARAM,
  PUBLISH_DEADLINE_HOLD_PARAM,
} from '../services/upload-pacing-queue.js'
import { pacingInputsForPolicy } from '../services/youtube-pacing-inputs.js'

function job(overrides: Partial<Job> & { params?: Record<string, any> } = {}): Job {
  return {
    job_id: 'j1',
    project_slug: 'p1',
    type: 'youtube_upload',
    episode_id: 'EP01',
    title: '',
    status: 'queued',
    created_at: '2026-11-07T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: [],
    params: { expected_channel_id: 'chan-A' },
    ...overrides,
  } as Job
}

const policy: UploadPacingPolicy = {
  tier: 'gentle',
  daily_limit: 3,
  timezone: 'Asia/Phnom_Penh',
  window: { start: '10:00', end: '18:00' },
  min_spacing_minutes: 60,
}

const context = {
  policy,
  recorded_transfers: [],
  quota_exhausted: false,
  quota_reset_at: null,
}
const inputs = { now: '2026-11-07T04:00:00.000Z', channelContext: () => context }

describe('upload pacing queue glue', () => {
  test('reads upload_on and scheduled_for from the job, not from any cache', () => {
    const j = job({ params: { upload_on: '2026-11-07T06:00:00.000Z', scheduled_for: '2026-11-07T09:00:00.000Z' } })
    assert.equal(uploadOnOf(j), '2026-11-07T06:00:00.000Z')
    assert.equal(publishAtOf(j), '2026-11-07T09:00:00.000Z')
  })

  test('a future upload_on holds the job until that instant', () => {
    const j = job({ params: { expected_channel_id: 'chan-A', upload_on: '2026-11-07T06:00:00.000Z' } })
    const hold = pacingHoldReason(j, inputs)
    assert.ok(hold)
    assert.equal(hold.reason, 'waiting_for_upload_on')
    assert.equal(hold.wake_at, '2026-11-07T06:00:00.000Z')
  })

  test('a ready job yields no hold', () => {
    const j = job({ params: { expected_channel_id: 'chan-A' } })
    assert.equal(pacingHoldReason(j, inputs), null)
    assert.equal(evaluateJobPacing(j, inputs)?.eligible, true)
  })

  test('quota exhaustion holds with the ledger reset as the wake instant', () => {
    const j = job({ params: { expected_channel_id: 'chan-A' } })
    const exhausted = {
      ...context,
      quota_exhausted: true,
      quota_reset_at: '2026-11-07T08:00:00.000Z',
    }
    const hold = pacingHoldReason(j, { now: '2026-11-07T04:00:00.000Z', channelContext: () => exhausted })
    assert.equal(hold?.reason, 'quota_exhausted')
    assert.equal(hold?.wake_at, '2026-11-07T08:00:00.000Z')
  })

  test('a passed publication date holds with NO invented wake instant', () => {
    const j = job({
      params: { expected_channel_id: 'chan-A', scheduled_for: '2026-11-06T00:00:00.000Z' },
    })
    const hold = pacingHoldReason(j, inputs)
    assert.equal(hold?.reason, 'publish_deadline_conflict')
    assert.equal(hold?.wake_at, null)
  })

  test('applyPacingHold writes the queue durable marker and never touches another job', () => {
    const j = job({ params: { expected_channel_id: 'chan-A' } })
    const other = job({ job_id: 'j2', params: { expected_channel_id: 'chan-B' } })
    const at = applyPacingHold(j, { reason: 'outside_window', detail: 'x', wake_at: '2026-11-07T03:00:00.000Z' })
    assert.equal(at, '2026-11-07T03:00:00.000Z')
    assert.equal(j.params[PACING_RETRY_PARAM], '2026-11-07T03:00:00.000Z')
    assert.equal(other.params[PACING_RETRY_PARAM], undefined)
  })

  test('a publish-deadline hold marks the job so the UI can say why it stopped', () => {
    const j = job({ params: { expected_channel_id: 'chan-A' } })
    applyPacingHold(j, { reason: 'publish_deadline_conflict', detail: 'x', wake_at: null })
    assert.equal(jobWaitingReason(j, inputs), null) // no wake; the list reads the flag instead
    applyPacingHold(j, { reason: 'publish_deadline_conflict', detail: 'x', wake_at: '2026-11-07T03:00:00.000Z' })
    assert.equal(j.params[PUBLISH_DEADLINE_HOLD_PARAM], true)
  })

  test('a paused job reads a plain reason without being re-evaluated', () => {
    const j = job({ status: 'paused', params: { expected_channel_id: 'chan-A' } })
    const reason = jobWaitingReason(j, inputs)
    assert.ok(reason)
    assert.match(reason.detail, /paused/i)
  })
})

describe('pacing inputs from live jobs and the quota ledger', () => {
  test('a done job counts as a recorded transfer for its channel day', () => {
    const done = job({ status: 'done', finished_at: '2026-11-07T04:00:00.000Z' })
    const live = pacingInputsForPolicy({ jobs: [done], policy, quota: null })
    assert.equal(live.recorded_transfers.length, 1)
  })

  test('a queued job with an upload_on becomes a planned slot; without one it does not', () => {
    const withDate = job({ params: { expected_channel_id: 'chan-A', upload_on: '2026-11-08T03:00:00.000Z' } })
    const withoutDate = job({ job_id: 'j2', params: { expected_channel_id: 'chan-A' } })
    const live = pacingInputsForPolicy({ jobs: [withDate, withoutDate], policy, quota: null })
    assert.equal(live.existing_planned_slots.length, 1)
    assert.equal(live.existing_planned_slots[0].episode_code, 'EP01')
  })

  test('quota exhaustion is DERIVED from the ledger, never assumed', () => {
    assert.equal(pacingInputsForPolicy({ jobs: [], policy, quota: null }).quota_exhausted, false)
    assert.equal(pacingInputsForPolicy({
      jobs: [], policy, quota: { resets_at: 'x', video_uploads: { used: 5, limit: 100 } },
    }).quota_exhausted, false)
    assert.equal(pacingInputsForPolicy({
      jobs: [], policy, quota: { resets_at: 'x', video_uploads: { used: 100, limit: 100 } },
    }).quota_exhausted, true)
    // An unknown limit is not exhaustion (§6 — "no ceiling" is not "spent").
    assert.equal(pacingInputsForPolicy({
      jobs: [], policy, quota: { resets_at: 'x', video_uploads: { used: 100, limit: null } },
    }).quota_exhausted, false)
  })

  test('one held channel does not change another channel verdict', () => {
    const a = job({ params: { expected_channel_id: 'chan-A', upload_on: '2026-11-07T06:00:00.000Z' } })
    const b = job({ job_id: 'j2', params: { expected_channel_id: 'chan-B' } })
    const perChannel = (channel: string | null) => ({
      ...context,
      // Only chan-A is on a daily limit; chan-B is open.
      recorded_transfers: channel === 'chan-A'
        ? [{ episode_code: 'x', started_at: '2026-11-07T01:00:00.000Z', status: 'completed' }]
        : [],
    })
    const scoped = { now: '2026-11-07T04:00:00.000Z', channelContext: perChannel }
    assert.equal(evaluateJobPacing(a, scoped)?.eligible, false)
    assert.equal(evaluateJobPacing(b, scoped)?.eligible, true)
  })

  test('an unknown channel context yields no verdict (never an invented policy)', () => {
    const j = job({ params: {} })
    assert.equal(evaluateJobPacing(j, { now: '2026-11-07T04:00:00.000Z', channelContext: () => null }), null)
  })
})
