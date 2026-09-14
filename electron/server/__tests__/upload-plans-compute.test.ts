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
import { computeSlots, orderEpisodeCodes } from '../services/upload-plans.js'

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
