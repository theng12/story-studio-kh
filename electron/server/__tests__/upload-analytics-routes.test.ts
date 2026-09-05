/**
 * Route-level tests for /api/projects/:slug/upload/analytics.
 *
 * Covers the cheap branches that don't need a real YouTube call:
 *   - 404 when project missing
 *   - 400 when no account connected
 *   - 404 when account exists but tokens are missing
 *   - 403 reauth_required when tokens lack the analytics scope
 *   - 200 happy path with stubbed fetch responses
 *
 * The full client-layer parsing is exercised by youtube-analytics.test.ts.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
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
let appSecrets: typeof import('../services/app-secrets-store.js')

const fetchQueue: Array<{ status: number; body: any }> = []
const originalFetch = globalThis.fetch

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  appSecrets = await import('../services/app-secrets-store.js')

  // Stub global fetch — only the happy-path test uses it.
  globalThis.fetch = (async (input: any) => {
    const next = fetchQueue.shift()
    if (!next) {
      return new Response(JSON.stringify({ error: 'unmocked' }), { status: 500 })
    }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } })
  }) as any
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

describe('Upload Analytics route', () => {
  beforeEach(async () => {
    fetchQueue.length = 0
    // Clean state between cases — don't leak project entries
    const root = pm.projectsRoot()
    try { await fs.rm(root, { recursive: true, force: true }) } catch {}
    await fs.mkdir(root, { recursive: true })
    await fs.rm(path.join(tempDir, 'youtube'), { recursive: true, force: true })
    await fs.rm(path.join(tempDir, 'app-secrets.json'), { force: true })
    const { _clearAnalyticsCache } = await import('../lib/youtube-analytics.js')
    _clearAnalyticsCache()
  })

  async function connect(slug: string, channelId: string, scope: string, keepTokens = true): Promise<void> {
    await connections.configureYouTubeApplication({ client_id: 'analytics-route-client', client_secret: 'analytics-route-secret' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: channelId, title: channelId, granted_scopes: scope.split(' ') },
      tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600_000, scope },
    })
    await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: channelId, expected_previous_channel_id: null })
    if (!keepTokens) await appSecrets.writeAppSecrets(state => { delete state.youtube?.channel_tokens?.[channelId] })
  }

  test('404 when project does not exist', async () => {
    const res = await request(app).get('/api/projects/no-such-slug/upload/analytics')
    assert.equal(res.status, 404)
  })

  test('400 when project exists but no account connected', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'A1' })
    const slug = created.body.slug
    const res = await request(app).get(`/api/projects/${slug}/upload/analytics`)
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /No YouTube channel is assigned/)
  })

  test('404 when account exists but tokens are missing', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'A2' })
    const slug = created.body.slug
    await connect(slug, 'phantom-account', 'https://www.googleapis.com/auth/youtube.upload', false)
    const res = await request(app).get(`/api/projects/${slug}/upload/analytics`)
    assert.equal(res.status, 404)
    assert.match(res.body.detail, /No tokens for this account/)
  })

  test('403 with reauth_required when tokens lack analytics scope', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'A3' })
    const slug = created.body.slug
    await connect(slug, 'no-analytics-scope', 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube')
    const res = await request(app).get(`/api/projects/${slug}/upload/analytics`)
    assert.equal(res.status, 403)
    assert.equal(res.body.reauth_required, true)
  })

  test('200 happy path with analytics scope + stubbed fetch', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'A4' })
    const slug = created.body.slug
    await connect(slug, 'good-account', 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/yt-analytics.readonly')

    // Queue: per-video report, videos.list metadata, channel totals
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [
          { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
        ],
        rows: [['vid-route', 250, 100, 24, 40, 10, 1, 0]],
      },
    })
    fetchQueue.push({
      status: 200,
      body: { items: [{ id: 'vid-route', snippet: { title: 'Route Test', publishedAt: '2026-04-15T00:00:00Z' } }] },
    })
    fetchQueue.push({
      status: 200,
      body: { columnHeaders: [{ name: 'views' }, { name: 'estimatedMinutesWatched' }, { name: 'averageViewPercentage' }], rows: [[250, 100, 40]] },
    })

    const res = await request(app).get(`/api/projects/${slug}/upload/analytics?start_date=2026-04-01&end_date=2026-05-01`)
    assert.equal(res.status, 200)
    assert.equal(res.body.rows.length, 1)
    assert.equal(res.body.rows[0].video_id, 'vid-route')
    assert.equal(res.body.rows[0].title, 'Route Test')
    assert.equal(res.body.totals.views, 250)
  })

  test('subsequent call hits cache (no extra fetches)', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'A5' })
    const slug = created.body.slug
    await connect(slug, 'good-account', 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/yt-analytics.readonly')
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' }],
        rows: [['vid-cache', 1, 0, 0, 0, 0, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[1]] } })

    const first = await request(app).get(`/api/projects/${slug}/upload/analytics?start_date=2026-04-10&end_date=2026-04-20`)
    assert.equal(first.status, 200)
    const second = await request(app).get(`/api/projects/${slug}/upload/analytics?start_date=2026-04-10&end_date=2026-04-20`)
    assert.equal(second.status, 200)
    assert.equal(fetchQueue.length, 0, 'cache hit — no extra fetches')
  })
})
