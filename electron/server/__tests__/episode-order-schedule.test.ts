/**
 * 1.4.262: publish dates follow episode order.
 *
 * The owner (2026-10-08): "I assembled 172, then 245, then 390 … now I'm going
 * one by one through 173, 174, 175, 176, and they stay behind 245 and 390."
 * Each finished episode used to take the slot after the latest claim, i.e.
 * finish order. Now the future dates of episodes not on YouTube yet are handed
 * back out in episode-code order, both on auto-schedule and on plan apply.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import type { UploadSchedule } from '../services/upload-plans.js'

const boot = await useTempDataDir()
const connections = await import('../services/youtube-connection-store.js')
const projects = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const plans = await import('../services/upload-plans.js')
const sidecars = await import('../services/upload-sidecar.js')
const { scheduleEpisodeWithActivePlan } = await import('../services/episode-autoschedule.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

const CHANNEL = 'UC-episode-order'
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

describe('episodeOrderShifts', () => {
  test('hands the same dates back out lowest code first, returning only what moved', () => {
    const shifts = plans.episodeOrderShifts({
      EP0390: '2030-01-02T12:00:00.000Z',
      EP0172: '2030-01-03T12:00:00.000Z',
      EP0245: '2030-01-01T12:00:00.000Z',
    })
    assert.deepEqual(shifts, {
      EP0172: '2030-01-01T12:00:00.000Z',
      EP0245: '2030-01-02T12:00:00.000Z',
      EP0390: '2030-01-03T12:00:00.000Z',
    })
    assert.deepEqual(plans.episodeOrderShifts({ EP0001: '2030-01-01T12:00:00.000Z', EP0002: '2030-01-02T12:00:00.000Z' }), {})
  })
})

/** Codes come out EP0001.. in creation order; the scenario names map onto them. */
async function scenario(schedule: UploadSchedule) {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const project = await projects.createProject({ name: 'Episode order' })
  await connections.configureYouTubeApplication({ client_id: 'order-client', client_secret: 'order-client-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Order Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'order-access', refresh_token: 'order-refresh', expires_at: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  const names = ['uploaded', 'late', '172', '173', '174', '175', '176', '245', '390']
  const code: Record<string, string> = {}
  const title: Record<string, string> = {}
  for (const name of names) {
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: `Episode ${name}`, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
    }], 'order-test')
    code[name] = (await ideas.acceptIdea(project.slug, idea!.id)).idea.episode_code!
    title[name] = `Episode ${name}`
  }
  const plan = await plans.upsertPlan(project.slug, {
    name: 'Every day', platform: 'youtube', account_id: `registry:${CHANNEL}`, schedule,
    defaults: { privacy_status: 'private' },
  })
  await plans.setActivePlanId(project.slug, 'youtube', `registry:${CHANNEL}`, plan.id)
  return { slug: project.slug, planId: plan.id, code, title }
}

const EVERY_DAY: UploadSchedule = {
  weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '12:00', timezone: 'UTC', start_date: '2030-01-01',
}

async function dates(slug: string, codes: string[]): Promise<string[]> {
  const map = await plans.readItemSchedule(slug)
  return codes.map(c => map[c] ?? '')
}

function ascending(values: string[]): boolean {
  return values.every((value, i) => i === 0 || Date.parse(values[i - 1]!) < Date.parse(value))
}

test('172, 245, 390 then 173–176 finishing one by one ends in episode order', async () => {
  const { slug, code } = await scenario(EVERY_DAY)
  for (const name of ['172', '245', '390', '173', '174', '175', '176']) {
    const result = await scheduleEpisodeWithActivePlan(slug, code[name]!, 'youtube')
    assert.equal(result.scheduled, true, result.reason)
  }
  const order = ['172', '173', '174', '175', '176', '245', '390'].map(n => code[n]!)
  const got = await dates(slug, order)
  assert.ok(ascending(got), `dates must follow episode order: ${JSON.stringify(got)}`)
  // Still the seven consecutive plan days the walk produced, only re-dealt.
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7].map(d => `2030-01-0${d}T12:00:00.000Z`))

  const last = await scheduleEpisodeWithActivePlan(slug, code['late']!, 'youtube')
  assert.deepEqual(last.order_shifted, order, 'a lower code finishing late shifts every later one')
  assert.equal(last.publish_at, '2030-01-01T12:00:00.000Z')
})

test('an episode already on YouTube keeps its date and is never re-dealt', async () => {
  const { slug, code, title } = await scenario(EVERY_DAY)
  // On YouTube (scheduled there) with a date later than the pool.
  await sidecars.writeSidecar(slug, code['uploaded']!, title['uploaded']!, {
    platform: 'youtube', video_id: 'yt-uploaded', account_id: `registry:${CHANNEL}`, channel_id: CHANNEL,
    uploaded_at: new Date().toISOString(), last_sync_at: '', scheduled_for: '2030-01-02T12:00:00.000Z',
    privacy_status: 'private', title: '', description: '', tags: [], thumbnail_set: false,
  } as any)
  for (const name of ['390', '245', '172']) await scheduleEpisodeWithActivePlan(slug, code[name]!, 'youtube')
  const map = await plans.readItemSchedule(slug)
  assert.equal(map[code['uploaded']!], '2030-01-02T12:00:00.000Z', 'uploaded episode untouched')
  assert.deepEqual(await dates(slug, ['172', '245', '390'].map(n => code[n]!)), [
    '2030-01-03T12:00:00.000Z', '2030-01-04T12:00:00.000Z', '2030-01-05T12:00:00.000Z',
  ])
})

test('the plan horizon is respected: no slot left means nothing moves', async () => {
  const { slug, code } = await scenario({ ...EVERY_DAY, end_date: '2030-01-02' })
  await scheduleEpisodeWithActivePlan(slug, code['245']!, 'youtube')
  await scheduleEpisodeWithActivePlan(slug, code['390']!, 'youtube')
  const before = await plans.readItemSchedule(slug)
  const result = await scheduleEpisodeWithActivePlan(slug, code['172']!, 'youtube')
  assert.equal(result.scheduled, false)
  assert.deepEqual(await plans.readItemSchedule(slug), before)
})

test('plan preview and apply give the selection and existing local dates episode order', async () => {
  const { slug, planId, code, title } = await scenario(EVERY_DAY)
  await sidecars.writeSidecar(slug, code['uploaded']!, title['uploaded']!, {
    platform: 'youtube', video_id: 'yt-uploaded', account_id: `registry:${CHANNEL}`, channel_id: CHANNEL,
    uploaded_at: new Date().toISOString(), last_sync_at: '', scheduled_for: '2030-01-05T12:00:00.000Z',
    privacy_status: 'private', title: '', description: '', tags: [], thumbnail_set: false,
  } as any)
  for (const name of ['245', '390']) await scheduleEpisodeWithActivePlan(slug, code[name]!, 'youtube')
  const body = { plan_id: planId, expected_channel_id: CHANNEL, episode_codes: [code['173']!, code['172']!] }
  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send(body)
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.order_shifted, ['172', '173', '245', '390'].map(n => code[n]!))
  const applied = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`)
    .send({ ...body, confirm: true, expected_assignments: preview.body.assignments })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  const got = await dates(slug, ['172', '173', '245', '390'].map(n => code[n]!))
  assert.ok(ascending(got), JSON.stringify(got))
  assert.equal(got[0], '2030-01-06T12:00:00.000Z', 'lowest code takes the earliest movable date')
  assert.equal((await plans.readItemSchedule(slug))[code['uploaded']!], '2030-01-05T12:00:00.000Z')
})
