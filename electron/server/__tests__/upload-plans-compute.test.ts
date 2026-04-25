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
import { computeSlots } from '../services/upload-plans.js'

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
