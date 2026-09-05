/**
 * Tests for the YouTube Analytics client (lib/youtube-analytics.ts).
 *
 * Coverage focuses on the behaviours we can exercise without a real
 * YouTube account:
 *   - response parsing (column-headers + rows → AnalyticsResult)
 *   - column ordering doesn't matter (we map by name, not index)
 *   - missing optional metrics (cardImpressions / cardClickRate) handled
 *   - in-memory cache returns fresh result, force: true bypasses cache
 *   - cache key includes date range (different ranges → distinct entries)
 *
 * The auth + API HTTP path is exercised end-to-end in the routes test
 * (which mocks fetch). We don't repeat that here.
 *
 * Strategy: stub `globalThis.fetch` so runReport() inside the module
 * receives our pre-baked Analytics responses. We don't touch the real
 * YouTube API.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
let mod: typeof import('../lib/youtube-analytics.js')
let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

// Stub a chain of fetch responses. Each call to fetch() returns the next
// queued payload. Test asserts that the queue is fully consumed.
const fetchQueue: Array<{ status: number; body: any; assertUrl?: (url: string) => void }> = []
const originalFetch = globalThis.fetch

function mockFetch(): typeof fetch {
  return (async (input: any, _init?: any) => {
    const url = typeof input === 'string' ? input : input.toString()
    const next = fetchQueue.shift()
    if (!next) throw new Error(`unexpected fetch call: ${url}`)
    next.assertUrl?.(url)
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
}

describe('youtube-analytics', () => {
  before(async () => {
    tmp = await useTempDataDir()
    mod = await import('../lib/youtube-analytics.js')
    pm = await import('../services/project-manager.js')
    // Seed a project so getValidAccessToken can resolve a slug.
    await pm.createProject({ name: 'Analytics Test', episode_prefix: 'AT' } as any)
    // Seed minimal upload tokens so getValidAccessToken returns immediately
    // without hitting the OAuth refresh endpoint. We seed every account id
    // referenced by individual cases so tests don't fail with a "no tokens"
    // error before they get a chance to assert on cache behaviour.
    connections = await import('../services/youtube-connection-store.js')
    await connections.configureYouTubeApplication({ client_id: 'analytics-client', client_secret: 'analytics-secret' })
    const tokenBundle = {
      access_token: 'fake-access-token',
      refresh_token: 'fake-refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/yt-analytics.readonly',
    }
    for (const channelId of ['acct-1', 'acct-disk', 'acct-shared']) {
      await saveYouTubeChannelGrantForTest({
        channel: { channel_id: channelId, title: channelId, granted_scopes: tokenBundle.scope.split(' ') },
        tokens: tokenBundle,
      })
    }
    await connections.assignProjectYouTubeChannel({
      project_slug: 'analytics-test', channel_id: 'acct-1', expected_previous_channel_id: null,
    })
    globalThis.fetch = mockFetch()
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await tmp.cleanup()
  })

  beforeEach(async () => {
    mod._clearAnalyticsCache()
    await mod._clearDiskAnalyticsCache()
    fetchQueue.length = 0
    await assignChannel('acct-1')
  })

  async function assignChannel(channelId: string): Promise<void> {
    const current = await connections.getProjectYouTubeAssignment('analytics-test')
    await connections.assignProjectYouTubeChannel({
      project_slug: 'analytics-test', channel_id: channelId,
      expected_previous_channel_id: current?.channel_id ?? null,
    })
  }

  test('parses video rows + enriches with title/publishedAt', async () => {
    // 1. Per-video report
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [
          { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
          { name: 'cardImpressions' }, { name: 'cardClickRate' },
        ],
        rows: [
          ['vid-A', 1000, 500, 30, 60, 50, 5, 2, 200, 4.5],
          ['vid-B', 800, 300, 25, 50, 30, 3, 1, 120, 3.0],
        ],
      },
      assertUrl: (url) => {
        assert.match(url, /youtubeanalytics\.googleapis\.com\/v2\/reports/)
        assert.match(url, /dimensions=video/)
        assert.match(url, /sort=-views/)
      },
    })
    // 2. videos.list metadata enrichment
    fetchQueue.push({
      status: 200,
      body: {
        items: [
          { id: 'vid-A', snippet: { title: 'Hit Episode', publishedAt: '2026-01-01T00:00:00Z' } },
          { id: 'vid-B', snippet: { title: 'Other Episode', publishedAt: '2026-02-01T00:00:00Z' } },
        ],
      },
    })
    // 3. Channel totals
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [
          { name: 'views' }, { name: 'estimatedMinutesWatched' }, { name: 'averageViewPercentage' },
        ],
        rows: [[1800, 800, 55]],
      },
    })

    const result = await mod.getEpisodeAnalytics('analytics-test', 'registry:acct-1')
    assert.equal(result.rows.length, 2)
    assert.equal(result.rows[0]!.video_id, 'vid-A')
    assert.equal(result.rows[0]!.title, 'Hit Episode')
    assert.equal(result.rows[0]!.views, 1000)
    assert.equal(result.rows[0]!.watch_minutes, 500)
    assert.equal(result.rows[0]!.avg_view_seconds, 30)
    assert.equal(result.rows[0]!.avg_view_percentage, 60)
    assert.equal(result.rows[0]!.ctr_percentage, 4.5)
    assert.equal(result.rows[0]!.impressions, 200)
    assert.equal(result.totals?.views, 1800)
    assert.equal(fetchQueue.length, 0, 'all queued fetches consumed')
  })

  test('column-order independence: columns reordered → values still mapped correctly', async () => {
    fetchQueue.push({
      status: 200,
      body: {
        // Reordered: views first, then video — opposite of typical
        columnHeaders: [
          { name: 'views' }, { name: 'video' },
          { name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' },
          { name: 'averageViewPercentage' }, { name: 'likes' },
          { name: 'comments' }, { name: 'shares' },
          { name: 'cardImpressions' }, { name: 'cardClickRate' },
        ],
        rows: [[42, 'reordered-vid', 10, 5, 25, 1, 0, 0, 50, 2.0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })  // videos.list returns nothing
    fetchQueue.push({ status: 500, body: 'fail' })  // totals call fails — non-fatal

    const result = await mod.getEpisodeAnalytics('analytics-test', 'registry:acct-1')
    assert.equal(result.rows[0]!.video_id, 'reordered-vid')
    assert.equal(result.rows[0]!.views, 42)
    assert.equal(result.totals, undefined, 'totals fail is non-fatal')
  })

  test('missing optional ctr/impressions metrics → undefined fields', async () => {
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [
          { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
          // No cardImpressions / cardClickRate columns
        ],
        rows: [['vid-X', 100, 50, 20, 40, 5, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[100]] } })

    const result = await mod.getEpisodeAnalytics('analytics-test', 'registry:acct-1')
    assert.equal(result.rows[0]!.ctr_percentage, undefined)
    assert.equal(result.rows[0]!.impressions, undefined)
    assert.equal(result.rows[0]!.views, 100)
  })

  test('throws AnalyticsApiError with statusCode on 4xx', async () => {
    fetchQueue.push({ status: 403, body: { error: { message: 'Insufficient Permission' } } })

    await assert.rejects(
      () => mod.getEpisodeAnalytics('analytics-test', 'registry:acct-1'),
      (err: any) => {
        assert.equal(err.statusCode, 403)
        assert.match(err.message, /YouTube Analytics API error \(403\)/)
        return true
      },
    )
  })

  test('cache: second call within TTL returns same result without fetching', async () => {
    // Seed three responses for first call
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [
          { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
        ],
        rows: [['vid-cached', 50, 20, 15, 30, 1, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[50]] } })

    const first = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-1', { startDate: '2026-04-01', endDate: '2026-05-01' })
    const second = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-1', { startDate: '2026-04-01', endDate: '2026-05-01' })
    assert.equal(first.rows[0]!.video_id, 'vid-cached')
    assert.equal(second.rows[0]!.video_id, 'vid-cached')
    assert.equal(fetchQueue.length, 0, 'no extra fetches issued — cache hit')
  })

  test('cache: force: true bypasses cache and re-fetches', async () => {
    // First call populates cache with one set of fixtures
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [
          { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
        ],
        rows: [['vid-original', 10, 5, 1, 10, 0, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[10]] } })
    await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-1', { startDate: '2026-04-01', endDate: '2026-05-01' })

    // Second (forced) call gets a different fixture set
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [
          { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
        ],
        rows: [['vid-refreshed', 999, 500, 20, 50, 0, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[999]] } })
    const refreshed = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-1', { startDate: '2026-04-01', endDate: '2026-05-01', force: true })
    assert.equal(refreshed.rows[0]!.video_id, 'vid-refreshed')
    assert.equal(fetchQueue.length, 0)
  })

  test('disk cache: fresh result is read after memory cache is wiped', async () => {
    await assignChannel('acct-disk')
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' }],
        rows: [['vid-disk', 77, 30, 10, 35, 0, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[77]] } })

    // First call writes both memory + disk
    const opts = { startDate: '2026-04-01', endDate: '2026-04-15' }
    const first = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-disk', opts)
    assert.equal(first.rows[0]!.video_id, 'vid-disk')

    // Wipe the in-memory cache only, simulating an Electron restart.
    mod._clearAnalyticsCache()

    // Disk hit — no fresh fetches issued.
    const second = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-disk', opts)
    assert.equal(second.rows[0]!.video_id, 'vid-disk', 'disk cache served the second call')
    assert.equal(fetchQueue.length, 0, 'no extra fetches — disk hit avoided the network')
  })

  test('disk cache: distinct date ranges share a file but key independently', async () => {
    await assignChannel('acct-shared')
    // Two different ranges for the same (slug, accountId). Both should
    // land in the same JSON file under different keys.
    for (const date of ['2026-01-15', '2026-02-15']) {
      fetchQueue.push({
        status: 200,
        body: {
          columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
            { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
            { name: 'likes' }, { name: 'comments' }, { name: 'shares' }],
          rows: [[`vid-${date}`, 1, 0, 0, 0, 0, 0, 0]],
        },
      })
      fetchQueue.push({ status: 200, body: { items: [] } })
      fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[1]] } })
    }
    await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-shared', { startDate: '2026-01-01', endDate: '2026-01-31' })
    await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-shared', { startDate: '2026-02-01', endDate: '2026-02-28' })

    // Wipe memory and re-read both — both should hit disk.
    mod._clearAnalyticsCache()
    const a = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-shared', { startDate: '2026-01-01', endDate: '2026-01-31' })
    const b = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-shared', { startDate: '2026-02-01', endDate: '2026-02-28' })
    assert.equal(a.rows[0]!.video_id, 'vid-2026-01-15')
    assert.equal(b.rows[0]!.video_id, 'vid-2026-02-15')
    assert.equal(fetchQueue.length, 0, 'both reads served from disk')
  })

  test('cache key: distinct date ranges cache independently', async () => {
    // Range A
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' }],
        rows: [['vid-A-range', 1, 0, 0, 0, 0, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[1]] } })

    // Range B
    fetchQueue.push({
      status: 200,
      body: {
        columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
          { name: 'likes' }, { name: 'comments' }, { name: 'shares' }],
        rows: [['vid-B-range', 2, 0, 0, 0, 0, 0, 0]],
      },
    })
    fetchQueue.push({ status: 200, body: { items: [] } })
    fetchQueue.push({ status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[2]] } })

    const a = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-1', { startDate: '2026-01-01', endDate: '2026-02-01' })
    const b = await mod.getEpisodeAnalyticsCached('analytics-test', 'registry:acct-1', { startDate: '2026-03-01', endDate: '2026-04-01' })
    assert.equal(a.rows[0]!.video_id, 'vid-A-range')
    assert.equal(b.rows[0]!.video_id, 'vid-B-range')
    assert.equal(fetchQueue.length, 0)
  })
})
