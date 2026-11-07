/**
 * Unit tests for upload pacing wire contract, scheduling, and eligibility (Story 386 Item 1).
 *
 * Verifies:
 * - Starting tiers (Gentle 3, Regular 6, Bulk 12) as editable starting counts (no auto-promotion).
 * - Window hours MUST be an explicit channel choice: missing window returns honest unconfigured reason.
 *   No 08:00–22:00 or 180-minute defaults are invented.
 * - Timezone math & channel-local pacing day distinct from real API quota reset (PT).
 * - Data-driven recorded transfers (including today's WI0001–3 without hardcoding).
 * - No catchup burst after offline / sleep / quota wait: slots are >= now and spaced.
 * - Conflict detection: upload_on + lead_time > publish_at emits loud conflict details.
 * - Configurable weekdays, spacing, limits, and windows.
 * - Loud failures on invalid dates, timezones, and windows.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  UPLOAD_PACING_TIERS,
  UPLOAD_PACING_TIER_DEFAULTS,
  UPLOAD_PACING_TIER_LABELS,
  DEFAULT_PUBLISH_LEAD_TIME_MS,
  validateUploadTimeWindow,
  validateUploadPacingPolicy,
  isValidIanaTimezone,
  hhmmToMinutes,
  minutesToHhmm,
  windowDurationMinutes,
  type UploadPacingPolicy,
  type RecordedTransfer,
  type PacingQueueItem,
} from '../contracts/upload-pacing.js'
import {
  getChannelDayKey,
  getQuotaDayKey,
  countChannelDayTransfers,
  isInsideWindow,
  isAllowedWeekday,
  findNextAllowedWindowStart,
  calculatePacedUploadSlots,
  checkUploadEligibility,
  dateAtTzLocal,
  parseDateInTz,
  isoAtTz,
} from '../services/upload-pacing.js'

describe('Upload pacing tiers and contract defaults', () => {
  test('starting tiers have the approved starting counts and are editable', () => {
    assert.deepEqual(UPLOAD_PACING_TIERS, ['gentle', 'regular', 'bulk', 'custom'])
    assert.equal(UPLOAD_PACING_TIER_DEFAULTS.gentle.daily_limit, 3)
    assert.equal(UPLOAD_PACING_TIER_DEFAULTS.regular.daily_limit, 6)
    assert.equal(UPLOAD_PACING_TIER_DEFAULTS.bulk.daily_limit, 12)

    // Gentle can be edited to 2 or 4 without changing tier identity
    const editedGentle: UploadPacingPolicy = {
      tier: 'gentle',
      daily_limit: 4,
      timezone: 'Asia/Phnom_Penh',
      window: { start: '10:00', end: '18:00' },
    }
    const validated = validateUploadPacingPolicy(editedGentle)
    assert.equal(validated.ok, true)
    if (validated.ok) {
      assert.equal(validated.policy.daily_limit, 4)
      assert.equal(validated.policy.tier, 'gentle')
    }
  })

  test('tier labels describe operating rules, not YouTube limits', () => {
    assert.equal(UPLOAD_PACING_TIER_LABELS.gentle, 'Gentle (up to 3/day)')
    assert.equal(UPLOAD_PACING_TIER_LABELS.regular, 'Regular (up to 6/day)')
    assert.equal(UPLOAD_PACING_TIER_LABELS.bulk, 'Bulk (up to 12/day)')
    assert.equal(UPLOAD_PACING_TIER_LABELS.custom, 'Custom')
  })

  test('publish lead time defaults to 6 hours', () => {
    assert.equal(DEFAULT_PUBLISH_LEAD_TIME_MS, 6 * 60 * 60 * 1000)
  })
})

describe('Explicit window requirement and validation', () => {
  test('missing window fails with honest configuration reason, does NOT invent defaults', () => {
    const missingUndefined = validateUploadTimeWindow(undefined)
    assert.equal(missingUndefined.ok, false)
    if (!missingUndefined.ok) {
      assert.equal(missingUndefined.reason, 'missing_window')
      assert.match(missingUndefined.message, /window hours must be chosen explicitly/i)
      assert.doesNotMatch(missingUndefined.message, /08:00/i)
    }

    const missingNull = validateUploadTimeWindow(null)
    assert.equal(missingNull.ok, false)
    if (!missingNull.ok) {
      assert.equal(missingNull.reason, 'missing_window')
    }

    const policyMissingWindow = {
      tier: 'gentle',
      daily_limit: 3,
      timezone: 'Asia/Phnom_Penh',
    }
    const policyResult = validateUploadPacingPolicy(policyMissingWindow)
    assert.equal(policyResult.ok, false)
    if (!policyResult.ok) {
      assert.equal(policyResult.reason, 'missing_window')
    }
  })

  test('invalid window formats fail loudly', () => {
    const backwards = validateUploadTimeWindow({ start: '18:00', end: '10:00' })
    assert.equal(backwards.ok, false)
    if (!backwards.ok) {
      assert.equal(backwards.reason, 'start_after_end')
    }

    const equalTimes = validateUploadTimeWindow({ start: '10:00', end: '10:00' })
    assert.equal(equalTimes.ok, false)
    if (!equalTimes.ok) {
      assert.equal(equalTimes.reason, 'start_after_end')
    }

    const gibberish = validateUploadTimeWindow({ start: 'morning', end: 'evening' })
    assert.equal(gibberish.ok, false)
    if (!gibberish.ok) {
      assert.equal(gibberish.reason, 'invalid_format')
    }
  })

  test('valid window parses and calculates duration in minutes', () => {
    const valid = validateUploadTimeWindow({ start: '09:30', end: '17:45' })
    assert.equal(valid.ok, true)
    if (valid.ok) {
      assert.equal(valid.window.start, '09:30')
      assert.equal(valid.window.end, '17:45')
      assert.equal(windowDurationMinutes(valid.window), 495)
    }
  })

  test('minute conversion helpers', () => {
    assert.equal(hhmmToMinutes('00:00'), 0)
    assert.equal(hhmmToMinutes('12:30'), 750)
    assert.equal(hhmmToMinutes('23:59'), 1439)
    assert.equal(hhmmToMinutes('24:00'), null)
    assert.equal(hhmmToMinutes('bad'), null)

    assert.equal(minutesToHhmm(0), '00:00')
    assert.equal(minutesToHhmm(750), '12:30')
    assert.equal(minutesToHhmm(1439), '23:59')
  })
})

describe('Timezone handling and channel-local day vs API quota day', () => {
  test('channel-local day in Phnom Penh is distinct from API quota day in Los Angeles', () => {
    // 2026-11-07T03:00:00Z:
    // Phnom Penh (+07:00) is 10:00 AM on Nov 7 -> 2026-11-07
    // Los Angeles (-08:00 PST) is 19:00 (7 PM) on Nov 6 -> 2026-11-06
    const instant = '2026-11-07T03:00:00.000Z'
    const channelDay = getChannelDayKey(instant, 'Asia/Phnom_Penh')
    const quotaDay = getQuotaDayKey(instant, 'America/Los_Angeles')

    assert.equal(channelDay, '2026-11-07')
    assert.equal(quotaDay, '2026-11-06')
    assert.notEqual(channelDay, quotaDay)
  })

  test('invalid timezone fails loudly', () => {
    assert.equal(isValidIanaTimezone('Asia/Phnom_Penh'), true)
    assert.equal(isValidIanaTimezone('America/New_York'), true)
    assert.equal(isValidIanaTimezone('UTC'), true)
    assert.equal(isValidIanaTimezone('Invalid/Not_A_Real_Tz'), false)

    assert.throws(() => {
      getChannelDayKey(Date.now(), 'Invalid/Not_A_Real_Tz')
    }, /Invalid IANA timezone/i)
  })

  test('DST transitions resolve wall-clock time accurately', () => {
    // America/New_York DST change in Nov 2026: Nov 1, 2026 2:00 AM falls back to 1:00 AM
    // Nov 2, 2026 14:00 in America/New_York (EST, UTC-5): 19:00:00Z
    const estDate = dateAtTzLocal(2026, 11, 2, 14, 0, 'America/New_York')
    assert.equal(estDate.toISOString(), '2026-11-02T19:00:00.000Z')

    // June 1, 2026 14:00 in America/New_York (EDT, UTC-4): 18:00:00Z
    const edtDate = dateAtTzLocal(2026, 6, 1, 14, 0, 'America/New_York')
    assert.equal(edtDate.toISOString(), '2026-06-01T18:00:00.000Z')
  })
})

describe('Data-driven transfers and daily allowance accounting (Wonder in Ink migration case)', () => {
  const policy: UploadPacingPolicy = {
    tier: 'gentle',
    daily_limit: 3,
    timezone: 'Asia/Phnom_Penh',
    window: { start: '10:00', end: '18:00' },
  }

  test('accepts recorded transfers via data and accounts against daily limit', () => {
    // 3 recorded transfers today in Phnom Penh (UTC+7)
    // 10:30 local = 03:30Z, 12:00 local = 05:00Z, 14:00 local = 07:00Z
    const recorded: RecordedTransfer[] = [
      { episode_code: 'WI0001', started_at: '2026-11-07T03:30:00.000Z', status: 'completed' },
      { episode_code: 'WI0002', started_at: '2026-11-07T05:00:00.000Z', status: 'completed' },
      { episode_code: 'WI0003', started_at: '2026-11-07T07:00:00.000Z', status: 'completed' },
    ]

    const countToday = countChannelDayTransfers(recorded, '2026-11-07', 'Asia/Phnom_Penh')
    assert.equal(countToday, 3)

    // Failed or aborted transfers do not count
    const withFailed: RecordedTransfer[] = [
      ...recorded,
      { episode_code: 'FAILED01', started_at: '2026-11-07T08:00:00.000Z', status: 'failed' },
      { episode_code: 'ABORT01', started_at: '2026-11-07T08:30:00.000Z', status: 'aborted' },
    ]
    assert.equal(countChannelDayTransfers(withFailed, '2026-11-07', 'Asia/Phnom_Penh'), 3)
  })

  test('when daily limit is exhausted today, held items receive future slots starting tomorrow', () => {
    // Now is 15:00 local time on Nov 7 in Phnom Penh (08:00:00Z)
    const now = '2026-11-07T08:00:00.000Z'
    const recordedToday: RecordedTransfer[] = [
      { episode_code: 'WI0001', started_at: '2026-11-07T03:30:00.000Z', status: 'completed' },
      { episode_code: 'WI0002', started_at: '2026-11-07T05:00:00.000Z', status: 'completed' },
      { episode_code: 'WI0003', started_at: '2026-11-07T07:00:00.000Z', status: 'completed' },
    ]

    // 6 held items needing paced slots
    const heldItems: PacingQueueItem[] = [
      { episode_code: 'WI0004' },
      { episode_code: 'WI0005' },
      { episode_code: 'WI0007' },
      { episode_code: 'WI0008' },
      { episode_code: 'WI0009' },
      { episode_code: 'WI0010' },
    ]

    const result = calculatePacedUploadSlots(heldItems, policy, {
      now,
      recorded_transfers: recordedToday,
    })

    assert.equal(result.ok, true)
    assert.equal(result.slots.length, 6)

    // ZERO items scheduled for 2026-11-07 because today's Gentle limit of 3 is full
    const slotsToday = result.slots.filter(s => s.channel_day_key === '2026-11-07')
    assert.equal(slotsToday.length, 0)

    // Exactly 3 items scheduled for 2026-11-08 (Gentle limit)
    const slotsTomorrow = result.slots.filter(s => s.channel_day_key === '2026-11-08')
    assert.equal(slotsTomorrow.length, 3)
    assert.deepEqual(slotsTomorrow.map(s => s.episode_code), ['WI0004', 'WI0005', 'WI0007'])

    // First slot tomorrow starts at window start (10:00 local Phnom Penh = 03:00Z)
    assert.equal(slotsTomorrow[0]!.upload_on, '2026-11-08T03:00:00.000Z')

    // Remaining 3 items scheduled for 2026-11-09
    const slotsDayAfter = result.slots.filter(s => s.channel_day_key === '2026-11-09')
    assert.equal(slotsDayAfter.length, 3)
    assert.deepEqual(slotsDayAfter.map(s => s.episode_code), ['WI0008', 'WI0009', 'WI0010'])
    assert.equal(slotsDayAfter[0]!.upload_on, '2026-11-09T03:00:00.000Z')
  })
})

describe('No catchup burst after offline / sleep / quota wait', () => {
  const policy: UploadPacingPolicy = {
    tier: 'gentle',
    daily_limit: 3,
    timezone: 'Asia/Phnom_Penh',
    window: { start: '10:00', end: '18:00' },
    min_spacing_minutes: 60,
  }

  test('app waking up mid-day does NOT fire missed past slots; starts at current time', () => {
    // Window is 10:00 to 18:00. App wakes up at 14:30 local time (07:30Z).
    // 0 uploads have happened today.
    const wakeUpNow = '2026-11-07T07:30:00.000Z'
    const items: PacingQueueItem[] = [
      { episode_code: 'EP01' },
      { episode_code: 'EP02' },
      { episode_code: 'EP03' },
    ]

    const result = calculatePacedUploadSlots(items, policy, {
      now: wakeUpNow,
      recorded_transfers: [],
    })

    assert.equal(result.ok, true)
    assert.equal(result.slots.length, 3)

    // Slot 1 must be at or after wakeUpNow (14:30 local), NOT in the past (10:00)
    const slot1Ms = Date.parse(result.slots[0]!.upload_on)
    assert.ok(slot1Ms >= Date.parse(wakeUpNow), 'Slot 1 must not be in the past')
    assert.equal(result.slots[0]!.upload_on, wakeUpNow)

    // Slot 2 must be spaced at least 60 minutes after Slot 1 (15:30 local = 08:30Z or spread)
    const slot2Ms = Date.parse(result.slots[1]!.upload_on)
    assert.ok(slot2Ms >= slot1Ms + 60 * 60_000, 'Slot 2 must respect spacing from Slot 1')

    // If Slot 3 fits before 18:00 (11:00Z), it stays today; if not, it moves to tomorrow
    const slot3Ms = Date.parse(result.slots[2]!.upload_on)
    assert.ok(slot3Ms >= slot2Ms + 60 * 60_000, 'Slot 3 must respect spacing from Slot 2')
  })

  test('app waking up after window end pushes all uploads to next day without burst', () => {
    // Window ends at 18:00. App wakes up at 19:30 local time (12:30Z).
    const afterWindowNow = '2026-11-07T12:30:00.000Z'
    const items: PacingQueueItem[] = [{ episode_code: 'EP01' }, { episode_code: 'EP02' }]

    const result = calculatePacedUploadSlots(items, policy, {
      now: afterWindowNow,
      recorded_transfers: [],
    })

    assert.equal(result.ok, true)
    assert.equal(result.slots.length, 2)
    // Both must be scheduled for tomorrow Nov 8 starting at window start (10:00 local = 03:00Z)
    assert.equal(result.slots[0]!.channel_day_key, '2026-11-08')
    assert.equal(result.slots[0]!.upload_on, '2026-11-08T03:00:00.000Z')
    assert.equal(result.slots[1]!.channel_day_key, '2026-11-08')
  })
})

describe('Conflict detection: upload_on vs publish_at and publish lead time', () => {
  const policy: UploadPacingPolicy = {
    tier: 'gentle',
    daily_limit: 3,
    timezone: 'Asia/Phnom_Penh',
    window: { start: '10:00', end: '18:00' },
  }

  test('flags conflict when upload slot cannot meet 6-hour publish lead time', () => {
    // Upload slot will be today at 10:00 local (03:00Z).
    // Publish date is set to today at 13:00 local (06:00Z) — only 3 hours after upload!
    const now = '2026-11-07T02:00:00.000Z'
    const items: PacingQueueItem[] = [
      {
        episode_code: 'CONFLICT_EP',
        publish_at: '2026-11-07T06:00:00.000Z',
      },
    ]

    const result = calculatePacedUploadSlots(items, policy, { now })
    assert.equal(result.ok, true)
    assert.equal(result.slots.length, 1)
    assert.equal(result.conflicts.length, 1)

    const conflict = result.conflicts[0]!
    assert.equal(conflict.episode_code, 'CONFLICT_EP')
    assert.equal(conflict.reason, 'cannot_meet_publish_deadline')
    assert.equal(conflict.required_lead_ms, 6 * 60 * 60 * 1000)
    assert.equal(conflict.actual_gap_ms, 3 * 60 * 60 * 1000)
    assert.match(conflict.detail, /leaves only 180 minutes before publish date/i)
  })

  test('flags conflict when publish_at is already in the past', () => {
    const now = '2026-11-07T02:00:00.000Z'
    const items: PacingQueueItem[] = [
      {
        episode_code: 'PAST_EP',
        publish_at: '2026-11-06T12:00:00.000Z',
      },
    ]

    const result = calculatePacedUploadSlots(items, policy, { now })
    assert.equal(result.ok, true)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0]!.reason, 'publish_at_in_past')
  })

  test('produces NO conflict when publish_at comfortably exceeds 6-hour lead time', () => {
    // Upload slot at 2026-11-07T03:00:00Z. Publish date 2 days later: 2026-11-09T03:00:00Z (48h gap).
    const now = '2026-11-07T02:00:00.000Z'
    const items: PacingQueueItem[] = [
      {
        episode_code: 'SAFE_EP',
        publish_at: '2026-11-09T03:00:00.000Z',
      },
    ]

    const result = calculatePacedUploadSlots(items, policy, { now })
    assert.equal(result.ok, true)
    assert.equal(result.slots.length, 1)
    assert.equal(result.conflicts.length, 0)
  })
})

describe('Configurable weekdays and spacing', () => {
  test('respects restricted weekdays and advances across gaps', () => {
    // Only Monday (1), Wednesday (3), Friday (5) allowed
    const mwfPolicy: UploadPacingPolicy = {
      tier: 'regular',
      daily_limit: 6,
      timezone: 'Asia/Phnom_Penh',
      window: { start: '10:00', end: '18:00' },
      weekdays: [1, 3, 5],
    }

    // 2026-11-07 is a Saturday (day 6). Next allowed day is Monday 2026-11-09.
    const nowSaturday = '2026-11-07T03:00:00.000Z'
    assert.equal(isAllowedWeekday(nowSaturday, mwfPolicy.weekdays, mwfPolicy.timezone), false)

    const items: PacingQueueItem[] = [{ episode_code: 'EP01' }]
    const result = calculatePacedUploadSlots(items, mwfPolicy, { now: nowSaturday })

    assert.equal(result.ok, true)
    assert.equal(result.slots.length, 1)
    assert.equal(result.slots[0]!.channel_day_key, '2026-11-09')
    assert.equal(result.slots[0]!.upload_on, '2026-11-09T03:00:00.000Z')
  })
})

describe('Upload eligibility verdict evaluation (checkUploadEligibility)', () => {
  const policy: UploadPacingPolicy = {
    tier: 'gentle',
    daily_limit: 3,
    timezone: 'Asia/Phnom_Penh',
    window: { start: '10:00', end: '18:00' },
    min_spacing_minutes: 60,
  }

  test('returns ready when all constraints pass', () => {
    // Inside window (11:00 local = 04:00Z), 0 uploads today, no active holds
    const now = '2026-11-07T04:00:00.000Z'
    const verdict = checkUploadEligibility({ episode_code: 'EP01' }, policy, { now })

    assert.equal(verdict.eligible, true)
    assert.equal(verdict.reason, 'ready')
    assert.equal(verdict.uploads_today, 0)
    assert.equal(verdict.remaining_today, 3)
    assert.equal(verdict.channel_day_key, '2026-11-07')
  })

  test('returns daily_limit_reached when channel day is full', () => {
    const now = '2026-11-07T04:00:00.000Z'
    const transfers: RecordedTransfer[] = [
      { episode_code: 'T1', started_at: '2026-11-07T03:00:00.000Z', status: 'completed' },
      { episode_code: 'T2', started_at: '2026-11-07T03:30:00.000Z', status: 'completed' },
      { episode_code: 'T3', started_at: '2026-11-07T03:50:00.000Z', status: 'completed' },
    ]
    const verdict = checkUploadEligibility({ episode_code: 'EP01' }, policy, {
      now,
      recorded_transfers: transfers,
    })

    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reason, 'daily_limit_reached')
    assert.equal(verdict.uploads_today, 3)
    assert.equal(verdict.remaining_today, 0)
    assert.match(verdict.earliest_start || '', /2026-11-08T03:00:00/i)
  })

  test('returns outside_window when called before or after window hours', () => {
    // 08:00 local time (01:00Z) is before window start (10:00 local = 03:00Z)
    const earlyNow = '2026-11-07T01:00:00.000Z'
    const verdict = checkUploadEligibility({ episode_code: 'EP01' }, policy, { now: earlyNow })

    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reason, 'outside_window')
    assert.equal(verdict.earliest_start, '2026-11-07T03:00:00.000Z')
  })

  test('returns spacing_hold when transfer completed recently within min_spacing_minutes', () => {
    // Transfer completed 15 minutes ago at 11:00 local (04:00Z); now is 11:15 (04:15Z)
    // 60 minute spacing requires waiting until 12:00 local (05:00Z)
    const now = '2026-11-07T04:15:00.000Z'
    const transfers: RecordedTransfer[] = [
      { episode_code: 'T1', started_at: '2026-11-07T04:00:00.000Z', status: 'completed' },
    ]
    const verdict = checkUploadEligibility({ episode_code: 'EP01' }, policy, {
      now,
      recorded_transfers: transfers,
    })

    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reason, 'spacing_hold')
    assert.equal(verdict.earliest_start, '2026-11-07T05:00:00.000Z')
  })

  test('returns waiting_for_upload_on when planned time is in future', () => {
    const now = '2026-11-07T04:00:00.000Z'
    const verdict = checkUploadEligibility(
      { episode_code: 'EP01', earliest_upload_on: '2026-11-07T06:00:00.000Z' },
      policy,
      { now },
    )

    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reason, 'waiting_for_upload_on')
    assert.equal(verdict.earliest_start, '2026-11-07T06:00:00.000Z')
  })

  test('returns quota_exhausted when YouTube API quota is exhausted', () => {
    const now = '2026-11-07T04:00:00.000Z'
    const resetTime = '2026-11-07T08:00:00.000Z'
    const verdict = checkUploadEligibility(
      { episode_code: 'EP01' },
      policy,
      { now, quota_exhausted: true, quota_reset_at: resetTime },
    )

    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reason, 'quota_exhausted')
    assert.equal(verdict.earliest_start, resetTime)
  })

  test('returns unconfigured_pacing when window is missing', () => {
    const brokenPolicy = { tier: 'gentle', daily_limit: 3, timezone: 'Asia/Phnom_Penh' } as unknown as UploadPacingPolicy
    const verdict = checkUploadEligibility({ episode_code: 'EP01' }, brokenPolicy)

    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reason, 'unconfigured_pacing')
    assert.match(verdict.detail, /window hours must be chosen explicitly/i)
  })
})
