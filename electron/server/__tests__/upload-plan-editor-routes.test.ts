/**
 * Contract tests for creating and editing upload plans.
 *
 * These requests save local project configuration only. They do not enqueue
 * uploads or make YouTube API calls.
 */

import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')
let plans: typeof import('../services/upload-plans.js')
let slug = ''

const ACCOUNT_ID = 'registry:UC_plan_editor'

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Evening cadence',
    platform: 'youtube',
    account_id: ACCOUNT_ID,
    schedule: {
      weekdays: [1, 3, 5],
      time_local: '22:00',
      timezone: 'Asia/Phnom_Penh',
      interval_weeks: 1,
      start_date: '2026-09-08',
      end_date: '2026-12-31',
    },
    defaults: { privacy_status: 'private', made_for_kids: false },
    ...overrides,
  }
}

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  plans = await import('../services/upload-plans.js')

  const project = await pm.createProject({ name: 'Plan Editor Routes' })
  slug = project.slug
  await connections.configureYouTubeApplication({ client_id: 'plan-editor-client', client_secret: 'plan-editor-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC_plan_editor', title: 'plan-editor-channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'plan-editor-access', refresh_token: 'plan-editor-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: 'UC_plan_editor', expected_previous_channel_id: null })
})

after(async () => { await cleanup?.() })

beforeEach(async () => {
  await pm.updateConfig(slug, { upload_plans: [], upload_plan_active: {} } as any)
})

describe('upload plan save contract', () => {
  test('accepts a complete valid schedule and stores it locally', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans`)
      .send(validBody())

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.plan.name, 'Evening cadence')
    assert.equal(res.body.plan.account_id, ACCOUNT_ID)
    assert.deepEqual(res.body.plan.schedule, validBody().schedule)
    assert.deepEqual(await plans.listPlans(slug), [res.body.plan])
  })

  test('accepts monthly mode when weekdays are empty', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans`)
      .send(validBody({ schedule: { ...validBody().schedule as object, weekdays: [], monthly_day: 31 } }))

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.plan.schedule.monthly_day, 31)
  })

  test('rejects malformed schedule values before writing project config', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['a whitespace-only name', { name: '   ' }],
      ['an invalid IANA timezone', { schedule: { ...validBody().schedule as object, timezone: 'Mars/Olympus' } }],
      ['an out-of-range local time', { schedule: { ...validBody().schedule as object, time_local: '24:00' } }],
      ['a non-integer weekday outside 0..6', { schedule: { ...validBody().schedule as object, weekdays: [1.5] } }],
      ['a weekday outside 0..6', { schedule: { ...validBody().schedule as object, weekdays: [7] } }],
      ['a monthly day outside 1..31', { schedule: { ...validBody().schedule as object, weekdays: [], monthly_day: 32 } }],
      ['a schedule with neither weekdays nor monthly mode', { schedule: { ...validBody().schedule as object, weekdays: [], monthly_day: undefined } }],
      ['a non-integer interval', { schedule: { ...validBody().schedule as object, interval_weeks: 1.5 } }],
      ['an interval below 1', { schedule: { ...validBody().schedule as object, interval_weeks: 0 } }],
      ['an invalid calendar date', { schedule: { ...validBody().schedule as object, start_date: '2026-02-30' } }],
      ['an end date before its start date', { schedule: { ...validBody().schedule as object, start_date: '2026-10-01', end_date: '2026-09-30' } }],
    ]

    for (const [label, overrides] of cases) {
      const res = await request(app)
        .post(`/api/projects/${slug}/upload/plans`)
        .send(validBody(overrides))
      assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`)
    }

    assert.deepEqual(await plans.listPlans(slug), [], 'invalid drafts were persisted')
  })

  test('requires the currently assigned YouTube account for a new plan', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans`)
      .send(validBody({ account_id: 'registry:UC_someone_else' }))

    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.deepEqual(await plans.listPlans(slug), [])
  })

  test('does not permit an existing plan to be retargeted to another account', async () => {
    const created = await request(app)
      .post(`/api/projects/${slug}/upload/plans`)
      .send(validBody())
    assert.equal(created.status, 200, JSON.stringify(created.body))

    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans`)
      .send(validBody({ id: created.body.plan.id, account_id: 'registry:UC_someone_else' }))

    assert.equal(res.status, 409, JSON.stringify(res.body))
    const saved = await plans.getPlan(slug, created.body.plan.id)
    assert.equal(saved?.account_id, ACCOUNT_ID)
  })

  test('returns 404 when an edit names a plan that does not exist', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans`)
      .send(validBody({ id: 'plan_missing' }))

    assert.equal(res.status, 404, JSON.stringify(res.body))
  })

  test('rejects editing or activation after assignment moves to another YouTube channel', async () => {
    const created = await request(app)
      .post(`/api/projects/${slug}/upload/plans`)
      .send(validBody())
    assert.equal(created.status, 200, JSON.stringify(created.body))

    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: 'UC_plan_editor_other', title: 'other-channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'other-access', refresh_token: 'other-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await connections.assignProjectYouTubeChannel({
      project_slug: slug,
      channel_id: 'UC_plan_editor_other',
      expected_previous_channel_id: 'UC_plan_editor',
    })

    try {
      const edit = await request(app)
        .post(`/api/projects/${slug}/upload/plans`)
        .send(validBody({ id: created.body.plan.id, name: 'Should remain unchanged' }))
      assert.equal(edit.status, 409, JSON.stringify(edit.body))

      const res = await request(app)
        .put(`/api/projects/${slug}/upload/plans/${created.body.plan.id}/active`)
      assert.equal(res.status, 409, JSON.stringify(res.body))
      const config = await pm.getConfig(slug) as any
      assert.deepEqual(config.upload_plan_active || {}, {})
      const saved = await plans.getPlan(slug, created.body.plan.id)
      assert.equal(saved?.name, 'Evening cadence')
    } finally {
      await connections.assignProjectYouTubeChannel({
        project_slug: slug,
        channel_id: 'UC_plan_editor',
        expected_previous_channel_id: 'UC_plan_editor_other',
      })
    }
  })
})
