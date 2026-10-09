/**
 * Schedule compute — pure-function tests. Verifies the weekday/interval/
 * monthly modes produce correct publishAt sequences for a range of plans.
 *
 * Deliberately runs with a fixed start_date so results are deterministic
 * regardless of when CI runs. Timezone is UTC for the same reason; a
 * separate smoke test covers a non-UTC zone.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeSlots, orderEpisodeCodes, validateUploadPlanDraft } from '../services/upload-plans.js'

describe('orderEpisodeCodes — deterministic schedule assignment', () => {
  test('sorts naturally regardless of checkbox click order', () => {
    assert.deepEqual(
      orderEpisodeCodes(['EP0012', 'EP0003', 'EP0010', 'EP0002']),
      ['EP0002', 'EP0003', 'EP0010', 'EP0012'],
    )
  })

  test('trims, removes blanks, and de-duplicates before assigning slots', () => {
    assert.deepEqual(
      orderEpisodeCodes([' EP0003 ', '', 'EP0002', 'EP0003', null, 42]),
      ['EP0002', 'EP0003'],
    )
  })
})

describe('computeSlots — weekday calendar', () => {
  test('Mon/Wed/Fri at 18:00 UTC, 6 items', () => {
    const slots = computeSlots({
      weekdays: [1, 3, 5],
      time_local: '18:00',
      timezone: 'UTC',
      start_date: '2026-05-04', // Monday
    }, 6)
    assert.equal(slots.length, 6)
    // Mon May 4, Wed May 6, Fri May 8, Mon May 11, Wed May 13, Fri May 15.
    assert.equal(slots[0], '2026-05-04T18:00:00.000Z')
    assert.equal(slots[1], '2026-05-06T18:00:00.000Z')
    assert.equal(slots[2], '2026-05-08T18:00:00.000Z')
    assert.equal(slots[3], '2026-05-11T18:00:00.000Z')
    assert.equal(slots[4], '2026-05-13T18:00:00.000Z')
    assert.equal(slots[5], '2026-05-15T18:00:00.000Z')
  })

  test('single weekday (Tue) at 09:30 UTC, 4 items', () => {
    const slots = computeSlots({
      weekdays: [2],
      time_local: '09:30',
      timezone: 'UTC',
      start_date: '2026-05-04',
    }, 4)
    assert.equal(slots.length, 4)
    assert.equal(slots[0], '2026-05-05T09:30:00.000Z')
    assert.equal(slots[1], '2026-05-12T09:30:00.000Z')
    assert.equal(slots[2], '2026-05-19T09:30:00.000Z')
    assert.equal(slots[3], '2026-05-26T09:30:00.000Z')
  })
})

describe('computeSlots — interval_weeks (bi-weekly etc)', () => {
  test('bi-weekly Friday 20:00 — interval_weeks: 2', () => {
    const slots = computeSlots({
      weekdays: [5],
      time_local: '20:00',
      timezone: 'UTC',
      interval_weeks: 2,
      start_date: '2026-05-01', // Friday
    }, 4)
    assert.equal(slots.length, 4)
    assert.equal(slots[0], '2026-05-01T20:00:00.000Z')
    assert.equal(slots[1], '2026-05-15T20:00:00.000Z')
    assert.equal(slots[2], '2026-05-29T20:00:00.000Z')
    assert.equal(slots[3], '2026-06-12T20:00:00.000Z')
  })
})

describe('computeSlots — monthly', () => {
  test('monthly on the 15th at 08:00 UTC, 3 items', () => {
    const slots = computeSlots({
      weekdays: [],
      time_local: '08:00',
      timezone: 'UTC',
      monthly_day: 15,
      start_date: '2026-05-01',
    }, 3)
    assert.equal(slots.length, 3)
    assert.equal(slots[0], '2026-05-15T08:00:00.000Z')
    assert.equal(slots[1], '2026-06-15T08:00:00.000Z')
    assert.equal(slots[2], '2026-07-15T08:00:00.000Z')
  })
})

describe('computeSlots — end_date cap', () => {
  test('Mon/Wed/Fri but end_date chops the stream', () => {
    const slots = computeSlots({
      weekdays: [1, 3, 5],
      time_local: '12:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
      end_date: '2026-05-08',
    }, 10)
    // Mon May 4, Wed May 6, Fri May 8 — 3 slots then cap.
    assert.equal(slots.length, 3)
    assert.equal(slots[2], '2026-05-08T12:00:00.000Z')
  })
})

describe('computeSlots — minStartDate (continue past existing schedule)', () => {
  test('minStartDate later than start_date advances walk to next valid weekday', () => {
    // Plan: M/W/F at 18:00 starting 2026-05-04 (Mon). Existing latest
    // scheduled video is 2026-05-15T18:00:00.000Z (Fri). New apply
    // should resume on Mon 2026-05-18 — NOT walk back to May 4.
    const slots = computeSlots({
      weekdays: [1, 3, 5],
      time_local: '18:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
    }, 3, { minStartDate: new Date('2026-05-15T18:00:00.000Z') })
    assert.equal(slots.length, 3)
    assert.equal(slots[0], '2026-05-18T18:00:00.000Z')
    assert.equal(slots[1], '2026-05-20T18:00:00.000Z')
    assert.equal(slots[2], '2026-05-22T18:00:00.000Z')
  })

  test('minStartDate at off-pattern time on a plan day still skips that whole day', () => {
    // Existing video manually scheduled at 19:00 on Fri May 15 (plan
    // is 18:00). The whole calendar day is reserved — walk resumes
    // on Mon May 18.
    const slots = computeSlots({
      weekdays: [1, 3, 5],
      time_local: '18:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
    }, 1, { minStartDate: new Date('2026-05-15T19:00:00.000Z') })
    assert.equal(slots[0], '2026-05-18T18:00:00.000Z')
  })

  test('minStartDate earlier than start_date is ignored', () => {
    // Latest claim is in the past relative to plan; plan's start_date
    // wins. Result identical to a plain compute with no minStartDate.
    const slots = computeSlots({
      weekdays: [1, 3, 5],
      time_local: '18:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
    }, 3, { minStartDate: new Date('2026-04-01T18:00:00.000Z') })
    assert.equal(slots[0], '2026-05-04T18:00:00.000Z')
    assert.equal(slots[1], '2026-05-06T18:00:00.000Z')
    assert.equal(slots[2], '2026-05-08T18:00:00.000Z')
  })

  test('no minStartDate option behaves identically to legacy call', () => {
    const slots = computeSlots({
      weekdays: [1, 3, 5],
      time_local: '18:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
    }, 3)
    assert.equal(slots[0], '2026-05-04T18:00:00.000Z')
    assert.equal(slots[1], '2026-05-06T18:00:00.000Z')
    assert.equal(slots[2], '2026-05-08T18:00:00.000Z')
  })

  test('bi-weekly rhythm preserved when resuming after a claim', () => {
    // Bi-weekly Friday plan starting 2026-05-01. Existing latest
    // claim is 2026-05-29 (the third bi-weekly slot). Next two slots
    // must stay on the original 2-week rhythm: June 12, June 26.
    // The intervalAnchor is pinned to the plan's start_date (not the
    // bumped walk start), so the cadence doesn't shift.
    const slots = computeSlots({
      weekdays: [5],
      time_local: '20:00',
      timezone: 'UTC',
      interval_weeks: 2,
      start_date: '2026-05-01',
    }, 2, { minStartDate: new Date('2026-05-29T20:00:00.000Z') })
    assert.equal(slots.length, 2)
    assert.equal(slots[0], '2026-06-12T20:00:00.000Z')
    assert.equal(slots[1], '2026-06-26T20:00:00.000Z')
  })

  test('end_date cap applies after minStartDate advance', () => {
    // Walk advanced to May 16+, plan ends May 22 — only Mon May 18,
    // Wed May 20, Fri May 22 should fit, even though we asked for 5.
    const slots = computeSlots({
      weekdays: [1, 3, 5],
      time_local: '12:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
      end_date: '2026-05-22',
    }, 5, { minStartDate: new Date('2026-05-15T12:00:00.000Z') })
    assert.equal(slots.length, 3)
    assert.equal(slots[0], '2026-05-18T12:00:00.000Z')
    assert.equal(slots[1], '2026-05-20T12:00:00.000Z')
    assert.equal(slots[2], '2026-05-22T12:00:00.000Z')
  })
})

describe('computeSlots — edge cases', () => {
  test('empty weekdays + no monthly_day = no slots', () => {
    const slots = computeSlots({
      weekdays: [],
      time_local: '10:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
    }, 5)
    assert.equal(slots.length, 0)
  })

  test('requested 0 items = empty result', () => {
    const slots = computeSlots({
      weekdays: [1],
      time_local: '10:00',
      timezone: 'UTC',
      start_date: '2026-05-04',
    }, 0)
    assert.equal(slots.length, 0)
  })
})


describe('computeSlots — future instant cutoff', () => {
  const schedule = {
    weekdays: [1, 2, 3, 4, 5, 6, 0], time_local: '21:00',
    timezone: 'Asia/Phnom_Penh', start_date: '2026-08-01',
  }
  test('retains a later-today slot even when the plan ends today', () => {
    assert.deepEqual(computeSlots({ ...schedule, end_date: '2026-09-15' }, 1, {
      notBefore: new Date('2026-09-15T03:00:00.000Z'),
    }), ['2026-09-15T14:00:00.000Z'])
  })
  test('skips elapsed slots, including an exact cutoff, without returning past dates', () => {
    assert.deepEqual(computeSlots(schedule, 2, {
      notBefore: new Date('2026-09-15T14:00:00.000Z'),
    }), ['2026-09-16T14:00:00.000Z', '2026-09-17T14:00:00.000Z'])
  })
  test('a booked calendar day remains reserved despite a later slot on that day', () => {
    assert.deepEqual(computeSlots(schedule, 1, {
      notBefore: new Date('2026-09-15T03:00:00.000Z'),
      minStartDate: new Date('2026-09-16T01:00:00.000Z'),
    }), ['2026-09-17T14:00:00.000Z'])
  })
})

/**
 * Blocked days exist for the re-lay action: a customer picks a new starting date
 * for some episodes, and the slots every other episode already holds must be
 * stepped over rather than double-booked.
 *
 * The property under test is that a blocked day is SKIPPED — not substituted,
 * not counted. The cadence and the chosen start date both survive, and the
 * caller still receives exactly as many distinct days as it asked for.
 */
describe('computeSlots — blocked days (re-lay around existing bookings)', () => {
  const daily = {
    weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '12:00',
    timezone: 'UTC', start_date: '2027-06-01',
  }

  test('steps over an occupied day and keeps walking, without losing a slot', () => {
    // Break caught: treating a blocked day as "borrow the next day instead"
    // would yield only two usable dates for three episodes and drop one.
    assert.deepEqual(computeSlots(daily, 3, { blockedDays: ['2027-06-02'] }), [
      '2027-06-01T12:00:00.000Z',
      '2027-06-03T12:00:00.000Z',
      '2027-06-04T12:00:00.000Z',
    ])
  })

  test('accepts a Set as well as an array, so callers need no conversion', () => {
    assert.deepEqual(
      computeSlots(daily, 2, { blockedDays: new Set(['2027-06-01']) }),
      ['2027-06-02T12:00:00.000Z', '2027-06-03T12:00:00.000Z'],
    )
  })

  test('an unrelated blocked day changes nothing, so the option is inert unused', () => {
    assert.deepEqual(
      computeSlots(daily, 2, { blockedDays: ['2027-07-01'] }),
      computeSlots(daily, 2),
    )
  })

  test('a terminal end_date still bounds the stream, so a shortfall stays visible', () => {
    // Break caught: refilling a blocked day from beyond end_date would schedule
    // a video past the plan's own horizon instead of reporting the shortfall.
    assert.deepEqual(computeSlots(
      { ...daily, weekdays: [1], end_date: '2027-06-14' },
      3,
      { blockedDays: ['2027-06-07'] },
    ), ['2027-06-14T12:00:00.000Z'])
  })

  test('blocking is matched on the LOCAL day, not the UTC one', () => {
    // Asia/Phnom_Penh is UTC+7, so a 01:00 local slot is the PREVIOUS day in
    // UTC. Blocking '2026-09-15' must therefore skip the 15th's local slot and
    // return the 16th; keying occupancy by UTC would instead match the 16th's
    // slot and wrongly re-book the 15th the customer said was taken.
    const phnomPenh = {
      weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '01:00',
      timezone: 'Asia/Phnom_Penh', start_date: '2026-09-15',
    }
    assert.deepEqual(
      computeSlots(phnomPenh, 1, { blockedDays: ['2026-09-15'] }),
      ['2026-09-15T18:00:00.000Z'],
    )
  })
})

// v1.4.268 — schedule phases. Night Atlas History: Mon/Thu until the end of
// 2026, then Mon/Wed/Fri from 1 Jan 2027, Asia/Phnom_Penh (UTC+7, no DST).
describe('computeSlots — phases', () => {
  const HISTORY = {
    weekdays: [1, 4], time_local: '20:00', timezone: 'Asia/Phnom_Penh',
    start_date: '2026-12-21', end_date: '2026-12-31',
    phases: [{ start_date: '2027-01-01', weekdays: [1, 3, 5], time_local: '20:30' }],
  }

  test('slots cross the phase boundary with each phase\'s days and time', () => {
    assert.deepEqual(computeSlots(HISTORY, 8), [
      '2026-12-21T13:00:00.000Z', // Mon 20:00
      '2026-12-24T13:00:00.000Z', // Thu
      '2026-12-28T13:00:00.000Z', // Mon
      '2026-12-31T13:00:00.000Z', // Thu — last day of the first phase
      '2027-01-01T13:30:00.000Z', // Fri 20:30 — the later phase
      '2027-01-04T13:30:00.000Z', // Mon
      '2027-01-06T13:30:00.000Z', // Wed
      '2027-01-08T13:30:00.000Z', // Fri
    ])
  })

  test('the first phase\'s end_date is not the horizon; the last phase\'s is', () => {
    const open = computeSlots(HISTORY, 200)
    assert.equal(open.length > 60, true, 'an open-ended last phase keeps producing slots')
    const capped = computeSlots({ ...HISTORY, phases: [{ ...HISTORY.phases[0]!, end_date: '2027-01-06' }] }, 50)
    assert.equal(capped.length, 7)
    assert.equal(capped.at(-1), '2027-01-06T13:30:00.000Z')
  })

  test('a gap between phases produces no slots', () => {
    const slots = computeSlots({ ...HISTORY, end_date: '2026-12-24' }, 4)
    assert.deepEqual(slots.slice(0, 3), ['2026-12-21T13:00:00.000Z', '2026-12-24T13:00:00.000Z', '2027-01-01T13:30:00.000Z'])
  })

  test('a walk that starts inside a later phase uses that phase (Edit Planned Dates, resume)', () => {
    // Edit Planned Dates overrides start_date; a resume uses minStartDate.
    assert.deepEqual(computeSlots({ ...HISTORY, start_date: '2027-01-05' }, 2), ['2027-01-06T13:30:00.000Z', '2027-01-08T13:30:00.000Z'])
    assert.deepEqual(
      computeSlots(HISTORY, 2, { minStartDate: new Date('2026-12-31T13:00:00.000Z'), blockedDays: ['2027-01-04'] }),
      ['2027-01-01T13:30:00.000Z', '2027-01-06T13:30:00.000Z'],
    )
  })

  test('a single-pattern plan is unchanged with phases absent or empty', () => {
    const legacy = { weekdays: [1, 4], time_local: '20:00', timezone: 'Asia/Phnom_Penh', start_date: '2026-12-21', end_date: '2027-01-31', interval_weeks: 2 }
    const expected = computeSlots(legacy, 20)
    assert.equal(expected.length, 6)
    assert.deepEqual(computeSlots({ ...legacy, phases: [] }, 20), expected)
    assert.equal(validateUploadPlanDraft({ name: 'x', account_id: 'a', schedule: legacy, defaults: { privacy_status: 'private' } }), null)
  })

  test('the save boundary refuses phases out of order or without days', () => {
    const draft = (phases: unknown) => ({ name: 'x', account_id: 'a', schedule: { ...HISTORY, phases }, defaults: { privacy_status: 'private' } })
    assert.equal(validateUploadPlanDraft(draft(HISTORY.phases)), null)
    assert.match(validateUploadPlanDraft(draft([{ ...HISTORY.phases[0], start_date: '2026-12-01' }]))!, /after the previous phase/)
    assert.match(validateUploadPlanDraft(draft([{ ...HISTORY.phases[0], weekdays: [] }]))!, /weekdays/)
    assert.match(validateUploadPlanDraft(draft([{ ...HISTORY.phases[0], end_date: '2026-12-31' }]))!, /end_date/)
    assert.match(validateUploadPlanDraft(draft({}))!, /must be an array/)
  })
})
