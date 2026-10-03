import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { __setYouTubeTransportForTests, __resetYouTubeTransportForTests } from '../lib/youtube-client.js'
import { ANALYTICS_SCOPE } from '../lib/youtube-oauth.js'

/**
 * The Analytics table's route contract: the period the owner picks, the live
 * episode title, and caches written before the table's extra columns existed.
 * YouTube is the provider-free FakeYouTube throughout; nothing reaches a network.
 */

const CHANNEL = 'UC-table-channel'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const store = await import('../services/youtube-project-publishing-store.js')
const connections = await import('../services/youtube-connection-store.js')
const ideas = await import('../services/idea-manager.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.(); cleanup = null
})

async function project(scope = ANALYTICS_SCOPE): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const created = await pm.createProject({ name: 'Table Project' })
  await connections.configureYouTubeApplication({ client_id: 'c', client_secret: 'table-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Table Channel', granted_scopes: [scope] },
    tokens: { access_token: 'g', refresh_token: 'gr', expires_at: Date.now() + 3_600_000, scope },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created.slug
}

const link = (slug: string, code: string, videoId: string) =>
  store.linkYouTubeEpisodeVideo({
    project_slug: slug, episode_code: code, channel_id: CHANNEL,
    video_id: videoId, source: 'upload', decided_at: new Date().toISOString(),
  })

const refresh = (slug: string, body: unknown) =>
  request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send(body as object)

const REPORT_PATH = /^\/v2\/reports\?/
const MAIN_COLUMNS = ['video', 'views', 'estimatedMinutesWatched', 'averageViewDuration',
  'averageViewPercentage', 'likes', 'comments', 'shares']

describe('the analytics period', () => {
  test('a bad, reversed or future period is refused with a plain sentence and no provider call', async () => {
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const cases: Array<[unknown, RegExp]> = [
      [{ start_date: '2026-02-30', end_date: '2026-03-01' }, /real start date and end date/],
      [{ start_date: 'yesterday', end_date: '2026-03-01' }, /real start date and end date/],
      [{ start_date: '2026-03-01' }, /real start date and end date/],
      [{ start_date: '2026-03-02', end_date: '2026-03-01' }, /start date must be on or before the end date/],
      [{ start_date: '2026-03-01', end_date: '2999-01-01' }, /cannot be in the future/],
    ]
    for (const [body, sentence] of cases) {
      const res = await refresh(slug, body)
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.match(res.body.detail, sentence)
    }
    assert.equal(fake.calls.length, 0, 'refused before contacting YouTube')
  })

  test('a chosen period is fetched, stored, and returned as the window', async () => {
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    const fake = new FakeYouTube()
    fake.respondMatching({
      method: 'GET', match: REPORT_PATH,
      body: { columnHeaders: MAIN_COLUMNS.map(name => ({ name })), rows: [['v1', 321, 10, 30, 40, 1, 2, 3]] },
    })
    // The optional reports and videos.list are left unqueued: each fails
    // locally, which is exactly the refusal path, and the main figures stand.
    __setYouTubeTransportForTests(fake.transport())

    const res = await refresh(slug, { start_date: '2026-01-01', end_date: '2026-01-31' })
    assert.equal(res.status, 200)
    assert.match(fake.calls[0]!.path, /startDate=2026-01-01&endDate=2026-01-31/)
    assert.equal(res.body.start_date, '2026-01-01')
    assert.equal(res.body.end_date, '2026-01-31')

    const read = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
    assert.equal(read.body.start_date, '2026-01-01', 'the window was persisted')
    const row = read.body.episodes[0]
    assert.equal(row.metrics.views.value, 321)
    assert.equal(row.metrics.impressions.state, 'not_available')
    assert.equal(row.facts.length.state, 'not_available')
  })
})

describe('the analytics read for the table', () => {
  test('each row carries the live accepted-idea title', async () => {
    const slug = await project()
    const [idea] = await ideas.addIdeas(slug, [{
      title: 'The Lantern Keeper', logline: 'x', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    const code = (await ideas.acceptIdea(slug, idea!.id, false)).episode_code
    await link(slug, code, 'v1')
    await link(slug, 'EP9999', 'v2')

    const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
    const rows = Object.fromEntries(res.body.episodes.map((e: any) => [e.episode_code, e]))
    assert.equal(rows[code].title, 'The Lantern Keeper')
    assert.equal(rows.EP9999.title, '', 'no accepted idea, no invented title')
  })

  test('a cache written before the table columns existed still decodes, and the new ones read as not fetched', async () => {
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await store.recordYouTubeAnalyticsCache({
      project_slug: slug,
      analytics: {
        fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
        start_date: '2026-06-05', end_date: '2026-09-03', partial: false,
        episodes: [{ video_id: 'v1', metrics: { views: { state: 'value', value: 1204, fetched_at: '2026-09-03T10:00:00.000Z' } } }],
      },
    })
    // Exactly as an older build wrote it: no `facts`, none of the new metrics.
    const statePath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json')
    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
    assert.equal(raw.analytics.episodes[0].facts, undefined)

    const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
    assert.equal(res.body.never_fetched, false, 'the old cache survived')
    const row = res.body.episodes[0]
    assert.equal(row.metrics.views.value, 1204)
    for (const name of ['subscribers_gained', 'impressions', 'click_through_rate']) {
      assert.equal(row.metrics[name].state, 'not_fetched', name)
    }
    assert.equal(row.facts.published.state, 'not_fetched')
    assert.equal(row.facts.length.state, 'not_fetched')
  })

  test('a fact with an unknown state is corruption, and the cache is dropped', async () => {
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await store.recordYouTubeAnalyticsCache({
      project_slug: slug,
      analytics: {
        fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
        start_date: '2026-06-05', end_date: '2026-09-03', partial: false,
        episodes: [{
          video_id: 'v1', metrics: {},
          facts: { length: { state: 'value', value: 3723, fetched_at: '2026-09-03T10:00:00.000Z' } },
        }],
      },
    })
    const ok = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
    assert.equal(ok.body.episodes[0].facts.length.value, 3723, 'a valid fact round-trips')

    const statePath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json')
    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
    raw.analytics.episodes[0].facts.length.state = 'probably'
    await fs.writeFile(statePath, JSON.stringify(raw))
    const dropped = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
    assert.equal(dropped.body.never_fetched, true)
  })

  test('a grant without analytics access is scope_missing, with no provider call', async () => {
    const slug = await project('https://www.googleapis.com/auth/youtube.upload')
    await link(slug, 'EP0001', 'v1')
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const res = await refresh(slug, { start_date: '2026-01-01', end_date: '2026-01-31' })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial_reason, 'scope_missing')
    assert.equal(res.body.episodes[0].metrics.views.state, 'not_fetched', 'unmeasured, never zero')
    assert.equal(res.body.episodes[0].facts.published.state, 'not_fetched')
    assert.equal(fake.calls.length, 0)
  })
})
