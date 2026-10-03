/**
 * v1.4.249 — ONE publishing schedule, shown and edited in two places.
 *
 * The owner: *"publishing cadence: it saves here but doesn't show me the
 * plan's name so I have to do the same save again inside the Upload Center.
 * feels like a duplicate action."*
 *
 * Pins: Settings (`/publishing-schedule`) edits the channel's ACTIVE upload
 * plan in place; the Upload Center's plan save updates what Settings shows;
 * old channels migrate to exactly one active plan with no duplicates.
 * Local config only — no YouTube calls.
 */

import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')
let slug = ''
let unassignedSlug = ''
const ACCOUNT = 'registry:UC_one_schedule'
const weekly = (weekdays: number[], time_local = '18:00') => ({ weekdays, time_local, timezone: 'Asia/Phnom_Penh', interval_weeks: 1 })

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  slug = (await pm.createProject({ name: 'One Schedule' })).slug
  unassignedSlug = (await pm.createProject({ name: 'Not Connected Yet' })).slug
  await connections.configureYouTubeApplication({ client_id: 'one-client', client_secret: 'one-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC_one_schedule', title: 'Night Tales', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: 'UC_one_schedule', expected_previous_channel_id: null })
})
after(async () => { await cleanup?.() })
beforeEach(async () => {
  await pm.updateConfig(slug, { upload_plans: [], upload_plan_active: {}, publish_cadence: undefined } as any)
})

const plansOf = async (s: string) => ((await pm.getConfig(s)) as any).upload_plans || []

describe('channel with a YouTube channel assigned', () => {
  test('migration: an old cadence with no plan becomes ONE active plan, named after the channel', async () => {
    await pm.updateConfig(slug, { publish_cadence: { schedule: weekly([1, 3, 5]), defaults: { privacy_status: 'private' } } } as any)
    const first = await request(app).get(`/api/projects/${slug}/publishing-schedule`)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.channel.title, 'Night Tales')
    assert.equal(first.body.plan.name, 'Night Tales schedule')
    assert.deepEqual(first.body.plan.schedule.weekdays, [1, 3, 5])
    // Reading again must not make a second copy.
    await request(app).get(`/api/projects/${slug}/publishing-schedule`)
    assert.equal((await plansOf(slug)).length, 1)
  })

  test('migration: saved plans that were never activated are activated, not duplicated', async () => {
    await pm.updateConfig(slug, {
      publish_cadence: { schedule: weekly([0]), defaults: { privacy_status: 'private' } },
      upload_plans: [
        { id: 'plan_old', name: 'Old', platform: 'youtube', account_id: ACCOUNT, schedule: weekly([2]), defaults: { privacy_status: 'private' }, created_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'plan_new', name: 'Newer', platform: 'youtube', account_id: ACCOUNT, schedule: weekly([4]), defaults: { privacy_status: 'private' }, created_at: '2026-02-01', updated_at: '2026-02-01T00:00:00Z' },
      ],
      upload_plan_active: { [`youtube:${ACCOUNT}`]: 'plan_gone' },
    } as any)
    const res = await request(app).get(`/api/projects/${slug}/publishing-schedule`)
    assert.equal(res.body.plan.id, 'plan_new')
    assert.equal(res.body.plans.length, 2)
    assert.equal((await plansOf(slug)).length, 2, 'no plan is created from the cadence when plans exist')
  })

  test('saving in Settings edits the active plan in place and the Upload Center sees it', async () => {
    await request(app).put(`/api/projects/${slug}/publishing-schedule`).send({ schedule: weekly([1, 4], '19:30'), name: 'Evenings' })
    const saved = await request(app).put(`/api/projects/${slug}/publishing-schedule`).send({ schedule: weekly([2, 5], '20:00') })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.plan.name, 'Evenings', 'the name survives a schedule-only save')
    assert.deepEqual(saved.body.plan.schedule.weekdays, [2, 5])
    const listed = await request(app).get(`/api/projects/${slug}/upload/plans`)
    assert.equal(listed.body.plans.length, 1, 'one plan, edited in place')
    assert.equal(listed.body.active[`youtube:${ACCOUNT}`], saved.body.plan.id)
    assert.equal(listed.body.plans[0].schedule.time_local, '20:00')
    // The cadence (seed) follows the plan.
    assert.deepEqual(saved.body.cadence.schedule.weekdays, [2, 5])
  })

  test('saving the active plan in the Upload Center updates what Settings shows', async () => {
    const created = await request(app).put(`/api/projects/${slug}/publishing-schedule`).send({ schedule: weekly([1]) })
    const plan = created.body.plan
    const edit = await request(app).post(`/api/projects/${slug}/upload/plans`).send({ ...plan, schedule: weekly([3, 6], '07:15') })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    const settings = await request(app).get(`/api/projects/${slug}/publishing-schedule`)
    assert.deepEqual(settings.body.plan.schedule.weekdays, [3, 6])
    assert.deepEqual(settings.body.cadence.schedule.weekdays, [3, 6])
    assert.equal(settings.body.cadence.schedule.time_local, '07:15')
  })

  test('saving a plan that is NOT active leaves the shown schedule alone', async () => {
    const created = await request(app).put(`/api/projects/${slug}/publishing-schedule`).send({ schedule: weekly([1]) })
    const other = await request(app).post(`/api/projects/${slug}/upload/plans`).send({
      name: 'Spare', platform: 'youtube', account_id: ACCOUNT, schedule: weekly([0], '06:00'), defaults: { privacy_status: 'private' },
    })
    assert.equal(other.status, 200)
    const settings = await request(app).get(`/api/projects/${slug}/publishing-schedule`)
    assert.equal(settings.body.plan.id, created.body.plan.id)
    assert.deepEqual(settings.body.cadence.schedule.weekdays, [1])
    // Making it active switches what Settings shows, and the seed follows.
    await request(app).put(`/api/projects/${slug}/upload/plans/${other.body.plan.id}/active`).send({})
    const after = await request(app).get(`/api/projects/${slug}/publishing-schedule`)
    assert.equal(after.body.plan.name, 'Spare')
    assert.deepEqual(after.body.cadence.schedule.weekdays, [0])
  })

  test('an invalid schedule is refused with a plain 400 and changes nothing', async () => {
    const res = await request(app).put(`/api/projects/${slug}/publishing-schedule`).send({ schedule: { weekdays: [], time_local: '18:00', timezone: 'Asia/Phnom_Penh' } })
    assert.equal(res.status, 400)
    assert.equal((await plansOf(slug)).length, 0)
  })
})

describe('channel with no YouTube channel yet', () => {
  test('the schedule is stored as the cadence and no plan is made', async () => {
    const res = await request(app).put(`/api/projects/${unassignedSlug}/publishing-schedule`).send({ schedule: weekly([2, 4]), auto_schedule_on_render: true })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.channel, null)
    assert.equal(res.body.plan, null)
    assert.deepEqual(res.body.cadence.schedule.weekdays, [2, 4])
    assert.equal(res.body.auto_schedule_on_render, true)
    assert.equal((await plansOf(unassignedSlug)).length, 0)
  })
})
