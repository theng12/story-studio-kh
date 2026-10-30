/**
 * The counted default (2026-10-31).
 *
 * The owner: *"all channels should default to 3 videos per week randomly but
 * not back to back"*, *"let's make the time random per the new default. but
 * once done. it's saved."*, and *"i can even change it to 7 days a week or
 * even 2 times a day. so 14 videos a week. those should all be options."*
 *
 * What is pinned here:
 *   1. The default draws three days a week that are never back to back — the
 *      Sunday-then-Monday pair across a week boundary counts — and a random
 *      time of day inside the channel's window, on 5-minute marks.
 *   2. The same channel and week always give the same days and times, so a
 *      re-read or a re-render never moves a slot.
 *   3. A count of the customer's own choosing is their days and their times:
 *      7 a week, 14 a week (2 a day), 5 a week — no error, no warning.
 *   4. The weekday and monthly modes are untouched.
 *   5. A channel with nothing saved uses the default and writes nothing; an
 *      explicit `false` is the only thing that turns auto-scheduling off.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, test } from 'node:test'

import { computeSlots, episodeOrderShifts, validateUploadPlanDraft, type UploadSchedule } from '../services/upload-plans.js'
import { useTempDataDir } from './_helpers.js'

const DEFAULT: UploadSchedule = {
  weekdays: [],
  random_weekly: 3,
  random_time_window: { start: '08:00', end: '22:00' },
  time_local: '08:00',
  timezone: 'UTC',
  random_seed: 'channel-a',
  start_date: '2026-12-14', // a Monday
}

const localDate = (iso: string, tz = 'UTC'): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

const localTime = (iso: string, tz = 'UTC'): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))

/** The Monday of the week a `YYYY-MM-DD` day belongs to. */
const weekOf = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`)
  const offset = (date.getUTCDay() + 6) % 7
  return new Date(date.getTime() - offset * 86_400_000).toISOString().slice(0, 10)
}

const daysBetween = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000

const weeksOf = (slots: string[]): Map<string, string[]> => {
  const weeks = new Map<string, string[]>()
  for (const slot of slots) {
    const day = localDate(slot)
    const key = weekOf(day)
    weeks.set(key, [...(weeks.get(key) || []), day])
  }
  return weeks
}

describe('the default: three a week on random days', () => {
  test('never back to back, never two on one day, across the year end', () => {
    const slots = computeSlots(DEFAULT, 21)
    assert.equal(slots.length, 21)
    const weeks = weeksOf(slots)
    assert.equal(weeks.size, 7, 'seven weeks of three videos')
    const ordered = [...weeks.entries()]
    for (const [week, days] of ordered) {
      assert.equal(days.length, 3, `${week} holds three videos`)
      assert.equal(new Set(days).size, 3, `${week} never puts two videos on one day`)
      const sorted = [...days].sort()
      for (let index = 1; index < sorted.length; index++) {
        assert.ok(daysBetween(sorted[index - 1]!, sorted[index]!) >= 2,
          `${sorted[index - 1]} and ${sorted[index]} are not back to back`)
      }
    }
    for (let index = 1; index < ordered.length; index++) {
      const last = [...ordered[index - 1]![1]].sort().at(-1)!
      const first = [...ordered[index]![1]].sort()[0]!
      assert.ok(daysBetween(last, first) >= 2,
        `${last} and ${first} are not back to back across the week boundary`)
    }
  })

  test('the random time of day is inside the window, on a 5-minute mark', () => {
    for (const slot of computeSlots(DEFAULT, 21)) {
      const time = localTime(slot)
      assert.ok(time >= '08:00' && time <= '22:00', `${time} is inside the window`)
      assert.equal(Number(time.slice(3)) % 5, 0, `${time} is on a 5-minute mark`)
    }
  })

  test('the same channel and week always give the same days and times', () => {
    const first = computeSlots(DEFAULT, 21)
    assert.deepEqual(computeSlots(DEFAULT, 21), first, 'a re-read moves nothing')
    // A walk that starts in the middle of a week still gives that week the
    // same days and times.
    const fromMiddle = computeSlots(DEFAULT, 3, { minStartDate: new Date('2026-12-16T00:00:00Z') })
    const fromStart = first.filter(slot => localDate(slot) >= '2026-12-17')
    assert.deepEqual(fromMiddle, fromStart.slice(0, 3))
  })

  test('another channel gets its own days', () => {
    const other = computeSlots({ ...DEFAULT, random_seed: 'channel-b' }, 21)
    assert.notDeepEqual(other, computeSlots(DEFAULT, 21))
  })
})

describe('a count of the customer\'s own choosing', () => {
  test('seven a week on their own days', () => {
    const slots = computeSlots({
      weekdays: [0, 1, 2, 3, 4, 5, 6], times_local: ['09:00'], time_local: '09:00',
      timezone: 'UTC', random_weekly: 7, start_date: '2026-12-14',
    }, 14)
    assert.equal(slots.length, 14)
    assert.deepEqual(slots.map(slot => localTime(slot)), Array(14).fill('09:00'))
    assert.equal(new Set(slots.map(slot => localDate(slot))).size, 14, 'every day of the week')
  })

  test('fourteen a week is two a day, at their two times', () => {
    const schedule = {
      weekdays: [0, 1, 2, 3, 4, 5, 6], times_local: ['09:00', '20:00'], time_local: '09:00',
      timezone: 'UTC', random_weekly: 14, start_date: '2026-12-14',
    }
    const slots = computeSlots(schedule, 28)
    assert.equal(slots.length, 28)
    const byDay = new Map<string, string[]>()
    for (const slot of slots) {
      const day = localDate(slot)
      byDay.set(day, [...(byDay.get(day) || []), localTime(slot)])
    }
    assert.equal(byDay.size, 14, 'fourteen days')
    for (const [day, times] of byDay) {
      assert.deepEqual(times, ['09:00', '20:00'], `${day} has both times`)
    }
    // The same days and times without a count — the shape the editor saves.
    const withoutCount = computeSlots({ ...schedule, random_weekly: undefined }, 28)
    assert.deepEqual(withoutCount, slots)
  })

  test('five a week works', () => {
    const slots = computeSlots({
      weekdays: [1, 2, 3, 4, 5], times_local: ['18:00'], time_local: '18:00',
      timezone: 'UTC', random_weekly: 5, start_date: '2026-12-14',
    }, 10)
    assert.equal(slots.length, 10)
    assert.deepEqual(slots.map(slot => localTime(slot)), Array(10).fill('18:00'))
  })

  test('the count is only refused when the days and times cannot add up', () => {
    const draft = (schedule: unknown) => ({
      name: 'Counted', account_id: 'registry:x', defaults: { privacy_status: 'private' }, schedule,
    })
    assert.equal(validateUploadPlanDraft(draft(DEFAULT)), null)
    assert.match(validateUploadPlanDraft(draft({ ...DEFAULT, random_weekly: 5 }))!,
      /3-videos-a-week default/)
    const fourteen = { ...DEFAULT, random_weekly: 14, weekdays: [0, 1, 2, 3, 4, 5, 6], times_local: ['09:00', '20:00'] }
    assert.equal(validateUploadPlanDraft(draft(fourteen)), null)
    assert.match(validateUploadPlanDraft(draft({ ...fourteen, times_local: ['09:00'] }))!, /add up to 14/)
    assert.match(validateUploadPlanDraft(draft({ ...DEFAULT, random_weekly: 0 }))!, /whole number/)
    assert.match(validateUploadPlanDraft(draft({ ...DEFAULT, random_time_window: { start: '08:01', end: '22:00' } }))!,
      /5-minute mark/)
    assert.match(validateUploadPlanDraft(draft({ ...DEFAULT, weekdays: [1], times_local: ['09:00', '09:00'] }))!,
      /repeat a time/)
  })
})

describe('the modes that were already there', () => {
  test('the weekday and monthly modes are untouched', () => {
    assert.deepEqual(
      computeSlots({ weekdays: [1, 3, 5], time_local: '18:00', timezone: 'UTC', start_date: '2026-05-04' }, 3),
      ['2026-05-04T18:00:00.000Z', '2026-05-06T18:00:00.000Z', '2026-05-08T18:00:00.000Z'],
    )
    assert.deepEqual(
      computeSlots({ weekdays: [], monthly_day: 3, time_local: '08:00', timezone: 'UTC', start_date: '2026-05-01' }, 2),
      ['2026-05-03T08:00:00.000Z', '2026-06-03T08:00:00.000Z'],
    )
  })

  test('the episode-order reshuffle swaps saved slots instead of drawing new ones', () => {
    const slots = computeSlots(DEFAULT, 3)
    const claims = { EP0001: slots[2]!, EP0002: slots[0]!, EP0003: slots[1]! }
    const shifts = episodeOrderShifts(claims)
    assert.deepEqual(Object.values(shifts).sort(), [...slots].sort(), 'the same dates, handed out again')
    assert.equal(shifts.EP0001, slots[0], 'the lowest code takes the earliest date')
    assert.equal(shifts.EP0002, slots[1])
    assert.equal(shifts.EP0003, slots[2])
  })
})

describe('a channel on this Mac', () => {
  let cleanup: (() => Promise<void>) | undefined
  let pm: typeof import('../services/project-manager.js')
  let ideas: typeof import('../services/idea-manager.js')
  let cadence: typeof import('../services/publish-cadence.js')
  let autoschedule: typeof import('../services/episode-autoschedule.js')
  let slug = ''

  before(async () => {
    const temporary = await useTempDataDir()
    cleanup = temporary.cleanup
    pm = await import('../services/project-manager.js')
    ideas = await import('../services/idea-manager.js')
    cadence = await import('../services/publish-cadence.js')
    autoschedule = await import('../services/episode-autoschedule.js')
    slug = (await pm.createProject({ name: 'Counted Default' })).slug
  })
  after(async () => { await cleanup?.(); cleanup = undefined })

  async function acceptOne(title: string): Promise<string> {
    const [idea] = await ideas.addIdeas(slug, [{
      title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
    }], 'counted-default')
    return (await ideas.acceptIdea(slug, idea!.id)).idea.episode_code!
  }

  test('a channel with nothing saved uses the default and writes nothing', async () => {
    const before = await pm.getConfig(slug)
    const state = await cadence.readChannelSchedule(slug)
    assert.equal(state.plan, null)
    assert.equal(state.cadence, null)
    assert.equal(state.default_schedule.random_weekly, 3)
    assert.deepEqual(state.default_schedule.random_time_window, { start: '08:00', end: '22:00' })
    assert.equal(state.default_schedule.timezone, 'Asia/Phnom_Penh')
    assert.equal(state.auto_schedule_on_render, true, 'finished videos schedule themselves')
    assert.deepEqual(await pm.getConfig(slug), before, 'reading the schedule writes nothing')
  })

  test('a finished episode takes a slot from the default', async () => {
    const code = await acceptOne('Episode one')
    const result = await autoschedule.scheduleEpisodeWithActivePlan(slug, code, 'youtube')
    assert.equal(result.scheduled, true, result.reason)
    assert.ok(result.publish_at, 'the episode has a publish time')
    const time = localTime(result.publish_at!, 'Asia/Phnom_Penh')
    assert.ok(time >= '08:00' && time <= '22:00', `${time} is inside the window`)
    const config = await pm.getConfig(slug) as any
    assert.equal(config.publish_cadence, undefined, 'the default is not written to disk')
  })

  test('an explicit off is respected, and nothing else turns it off', async () => {
    assert.equal(cadence.autoScheduleEnabled({}), true)
    assert.equal(cadence.autoScheduleEnabled({ auto_schedule_on_render: true }), true)
    assert.equal(cadence.autoScheduleEnabled({ auto_schedule_on_render: false }), false)
    await pm.updateConfig(slug, { auto_schedule_on_render: false } as any)
    const state = await cadence.readChannelSchedule(slug)
    assert.equal(state.auto_schedule_on_render, false)
  })

  test('the render path reads the same switch', async () => {
    const source = await readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
    assert.match(source, /autoScheduleEnabled/)
  })

  test('a channel with its own saved plan keeps it, untouched', async () => {
    await pm.updateConfig(slug, { auto_schedule_on_render: undefined } as any)
    const saved = await cadence.saveChannelSchedule(slug, {
      schedule: { weekdays: [2, 4], time_local: '19:30', timezone: 'Asia/Phnom_Penh', interval_weeks: 1 },
    })
    assert.deepEqual(saved.cadence?.schedule.weekdays, [2, 4])
    const before = await pm.getConfig(slug)
    const state = await cadence.readChannelSchedule(slug)
    assert.deepEqual(state.cadence?.schedule.weekdays, [2, 4], 'the saved days stay')
    assert.deepEqual(await pm.getConfig(slug), before, 'reading does not rewrite the saved plan')

    const code = await acceptOne('Episode two')
    const result = await autoschedule.scheduleEpisodeWithActivePlan(slug, code, 'youtube')
    assert.equal(result.scheduled, true, result.reason)
    const day = localDate(result.publish_at!, 'Asia/Phnom_Penh')
    assert.ok([2, 4].includes(new Date(`${day}T00:00:00Z`).getUTCDay()), `${day} is one of the saved days`)
    assert.equal(localTime(result.publish_at!, 'Asia/Phnom_Penh'), '19:30', 'the saved time of day')
  })
})
