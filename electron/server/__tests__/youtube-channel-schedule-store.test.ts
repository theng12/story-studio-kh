import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let store: typeof import('../services/youtube-channel-schedule-store.js')
let classification: typeof import('../services/channel-date-classification.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  store = await import('../services/youtube-channel-schedule-store.js')
  classification = await import('../services/channel-date-classification.js')
  pm = await import('../services/project-manager.js')
})
after(async () => { await cleanup() })

const READ_AT = '2026-11-19T10:00:00.000Z'

const OLD_NOW = Date.parse(READ_AT) + 3 * 24 * 60 * 60 * 1000

test('far-future YouTube slots are scheduled, with the video and its read time', () => {
  const record = store.buildYouTubeScheduleRecord({
    channel_id: 'UCboundless', read_at: READ_AT, now: OLD_NOW,
    videos: {
      v1: { privacyStatus: 'private', publishAt: '2027-12-20T10:00:00.000Z' },
      v2: { privacyStatus: 'private', publishAt: '2027-11-05T10:00:00.000Z' },
      v3: { privacyStatus: 'public', publishAt: null },
    },
    titles: { v1: 'EP0100' },
  })
  assert.equal(record.state, 'scheduled')
  assert.equal(record.scheduled_count, 2)
  assert.equal(record.next_slot_at, '2027-11-05T10:00:00.000Z')
  assert.equal(record.scheduled_dates?.find(slot => slot.video_id === 'v1')?.title, 'EP0100')
  assert.equal(record.scheduled_dates?.[0]?.read_at, READ_AT)
  assert.equal(record.freshness, 'stale')
})

test('the four states are distinct and unknown never reads as zero', () => {
  const never = store.buildYouTubeScheduleRecord({ channel_id: 'UCx', read_at: READ_AT, now: Date.parse(READ_AT), failure: null })
  assert.equal(never.state, 'unconfigured')
  assert.equal(never.scheduled_count, 0)
  const failed = store.buildYouTubeScheduleRecord({ channel_id: 'UCx', read_at: READ_AT, now: OLD_NOW, failure: 'YouTube could not be reached.' })
  assert.equal(failed.state, 'read_failed')
  assert.equal(failed.scheduled_count, null)
  assert.equal(failed.error, 'YouTube could not be reached.')
  assert.equal(failed.freshness, 'stale')
  const record: import('../services/youtube-channel-schedule-store.js').YouTubeChannelSchedule = {
    read_at: null, channel_id: null, state: 'no_data', scheduled_count: null,
    next_slot_at: null, error: 'Story Studio has not read this channel’s YouTube schedule yet.',
  }
  assert.equal(record.state, 'no_data')
  assert.equal(record.scheduled_count, null)
})

test('a missing upload_pacing key stays missing and never becomes a blocking verdict', async () => {
  const project = await pm.createProject({ name: 'NoPacingKey' })
  const before = (await pm.getConfig(project.slug))!
  assert.equal(Object.hasOwn(before, 'upload_pacing'), false)
  const record = store.buildYouTubeScheduleRecord({
    channel_id: 'UCnopacing', read_at: READ_AT, now: Date.parse(READ_AT),
    videos: { v9: { privacyStatus: 'private', publishAt: '2027-06-01T10:00:00.000Z' } },
  })
  await store.writeYouTubeChannelSchedule(project.slug, record)
  const read = await store.readYouTubeChannelSchedule(project.slug, 'UCnopacing')
  assert.equal(read.state, 'scheduled')
  assert.equal(read.scheduled_count, 1)
  const after = (await pm.getConfig(project.slug))!
  assert.equal(Object.hasOwn(after, 'upload_pacing'), false)
  assert.equal(JSON.stringify(after), JSON.stringify(before))
})

test('a saved answer for another channel reads back as no_data', async () => {
  const project = await pm.createProject({ name: 'ChannelMismatch' })
  await store.writeYouTubeChannelSchedule(project.slug, {
    read_at: READ_AT, channel_id: 'UCold', state: 'unconfigured',
    scheduled_count: 0, next_slot_at: null,
  })
  const read = await store.readYouTubeChannelSchedule(project.slug, 'UCnew')
  assert.equal(read.state, 'no_data')
  assert.equal(read.scheduled_count, null)
  assert.match(read.error || '', /different YouTube channel/)
})

test('an unassigned channel classifies December as unknown, never free', async () => {
  const project = await pm.createProject({ name: 'UnassignedDecember' })
  const result = await classification.classifyChannelDates(project.slug, '2026-12-01', '2026-12-07')
  assert.equal(result.channel_id, null)
  assert.ok(result.days.every(day => day.state === 'unknown'))
  assert.match(result.days[0]!.reason || '', /no YouTube channel assigned/)
  assert.equal(result.days[0]!.weekday, 'Tuesday')
  assert.ok(result.days.some(day => day.weekday === 'Sunday'), 'weekday names, not numbers')
})
