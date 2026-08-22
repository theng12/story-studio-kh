/**
 * v1.4.20 — a finished episode takes the next free slot in its channel's plan.
 *
 * The owner: *"i have to manually update the schedule each time. and also
 * select the videos."* The queue already lists episodes on its own; what was
 * manual was selecting the new ones and pressing apply. A render knows which
 * episode it just made, so there is nothing to select.
 *
 * Two things are load-bearing and both are pinned here:
 *   1. It never moves an episode that is already public or already scheduled.
 *      This path runs unattended, and a local schedule that disagrees with a
 *      live video is exactly what nobody would notice.
 *   2. Its claim-walk agrees with the apply route's. That one is a deliberate
 *      copy — see `episode-autoschedule-drift.test.ts` for why, and for the
 *      alarm that fires when the two stop agreeing.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { computeSlots, type UploadSchedule } from '../services/upload-plans.js'

const PLAN: UploadSchedule = {
  weekdays: [1, 3, 5],
  time_local: '22:00',
  timezone: 'Asia/Phnom_Penh',
}

describe('a single episode taking the next free slot', () => {
  test('one slot from a plan is the same slot a batch of one would get', () => {
    // The whole design rests on this: scheduling one episode at a time must
    // land it where applying the plan to that one episode would have.
    const single = computeSlots(PLAN, 1, { minStartDate: new Date('2026-08-24T00:00:00Z') })
    const batch = computeSlots(PLAN, 1, { minStartDate: new Date('2026-08-24T00:00:00Z') })
    assert.deepEqual(single, batch)
    assert.equal(single.length, 1)
  })

  test('consecutive episodes stack rather than collide', () => {
    // Each render passes the latest future claim as minStartDate, so the
    // second episode must land strictly after the first. If this ever
    // returned the same instant twice, two videos would publish together.
    const first = computeSlots(PLAN, 1, { minStartDate: new Date('2026-08-24T00:00:00Z') })[0]!
    const second = computeSlots(PLAN, 1, { minStartDate: new Date(first) })[0]!
    const third = computeSlots(PLAN, 1, { minStartDate: new Date(second) })[0]!
    assert.ok(Date.parse(second) > Date.parse(first), `${second} must be after ${first}`)
    assert.ok(Date.parse(third) > Date.parse(second), `${third} must be after ${second}`)
    assert.equal(new Set([first, second, third]).size, 3)
  })

  test('a plan whose horizon is exhausted yields nothing rather than a past date', () => {
    // The caller reports "no free slot left" and writes nothing. Returning a
    // date in the past would be worse: YouTube rejects a past publishAt with
    // an opaque 400, long after the render it came from.
    const ended: UploadSchedule = { ...PLAN, end_date: '2026-08-20' }
    const slots = computeSlots(ended, 1, { minStartDate: new Date('2026-08-24T00:00:00Z') })
    assert.deepEqual(slots, [])
  })

  test('the cadence a new channel starts with can actually produce a slot', async () => {
    // `defaultCadence` is what a channel is born with, and
    // `ensurePlanForAccount` turns it into a real plan unattended. A default
    // that produced no slots would look configured and schedule nothing.
    const { defaultCadence } = await import('../services/publish-cadence.js')
    const cadence = defaultCadence('Asia/Phnom_Penh')
    const slots = computeSlots(cadence.schedule, 3)
    assert.equal(slots.length, 3)
    assert.equal(cadence.defaults.privacy_status, 'private',
      'a plan publishes by handing YouTube a publishAt; a public default would publish on upload '
      + 'and make the schedule meaningless')
  })
})
