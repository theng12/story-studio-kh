import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { __setYouTubeTransportForTests, __resetYouTubeTransportForTests } from '../lib/youtube-client.js'
import {
  ANALYTICS_METRICS,
  fetchProjectAnalytics,
  type FetchReport,
} from '../services/youtube-analytics-cache.js'
import { isoDurationSeconds } from '../lib/youtube-analytics.js'

import { ANALYTICS_SCOPE } from '../lib/youtube-oauth.js'

const CHANNEL = 'UC-center-channel'
const APPLICATION = 'center-client'
const AT = '2026-09-03T10:00:00.000Z'

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => { await cleanup?.(); cleanup = null })

/**
 * A real project with a real connected account and real tokens.
 *
 * Needed because these tests now drive the PRODUCTION path — `runReport` goes
 * through `fetchWithAuthRetry`, which resolves tokens for the account. The
 * previous version injected a seam above all of that, which is precisely how a
 * state unreachable in production came to be certified as working.
 */
let currentSlug = ''
let currentAccountId = ''
let currentApplicationId = ''
async function temp(): Promise<void> {
  const dir = await useTempDataDir()
  cleanup = dir.cleanup
  const pm = await import('../services/project-manager.js')
  const connections = await import('../services/youtube-connection-store.js')
  const created = await pm.createProject({ name: 'Analytics Project' })
  const application = await connections.configureYouTubeApplication({ client_id: APPLICATION, client_secret: 'analytics-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Analytics Channel', granted_scopes: [ANALYTICS_SCOPE] },
    tokens: {
    access_token: 'analytics-access', refresh_token: 'analytics-refresh',
    expires_at: Date.now() + 3_600_000,
    // The grant a real analytics-capable connection carries. Without it the
    // service refuses before the report, which is its own state.
    scope: ANALYTICS_SCOPE,
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  currentSlug = created.slug
  currentAccountId = `registry:${CHANNEL}`
  currentApplicationId = application.application_id
}

/**
 * YouTube's real reports shape: parallel `columnHeaders` and positional `rows`.
 *
 * Built as the API sends it and fed through the production `runReport` +
 * `asKeyed`, not as a convenient keyed object. The previous version of this
 * fixture was a hand-built record that `delete`d a key the real producer could
 * never omit — tell 7 verbatim, and it certified a state unreachable in
 * production as if it worked.
 */
const ALL_COLUMNS = [
  'video', 'views', 'estimatedMinutesWatched', 'averageViewDuration',
  'averageViewPercentage', 'likes', 'comments', 'shares',
]

function reportBody(videoIds: string[], opts: { columns?: string[], values?: Record<string, number> } = {}) {
  const columns = opts.columns ?? ALL_COLUMNS
  return {
    columnHeaders: columns.map(name => ({ name })),
    rows: videoIds.map(id => columns.map(name => (name === 'video' ? id : (opts.values?.[name] ?? 0)))),
  }
}

const REPORT_PATH = /^\/v2\/reports\?/

/** Queue one raw analytics report, matched however the service builds its URL. */
function queueReport(fake: FakeYouTube, body: unknown): void {
  fake.respondMatching({ method: 'GET', match: REPORT_PATH, body })
}

/**
 * Queue a FULL read: the main report, the two optional reports (subscribers;
 * impressions + click-through rate) and one `videos.list` batch, in the order
 * the service asks for them.
 */
const VIDEOS_PATH = /^\/youtube\/v3\/videos\?/
function queueFullRead(fake: FakeYouTube, videoIds: string[], opts: {
  values?: Record<string, number>, impressions?: { status: number, body: unknown },
  items?: unknown[], videosStatus?: number,
} = {}): void {
  queueReport(fake, reportBody(videoIds, { values: opts.values }))
  queueReport(fake, reportBody(videoIds, { columns: ['video', 'views', 'subscribersGained'], values: opts.values }))
  fake.respondMatching({
    method: 'GET', match: REPORT_PATH,
    status: opts.impressions?.status ?? 200,
    body: opts.impressions?.body ?? reportBody(videoIds, {
      columns: ['video', 'views', 'videoThumbnailImpressions', 'videoThumbnailImpressionsClickRate'], values: opts.values,
    }),
  })
  fake.respondMatching({
    method: 'GET', match: VIDEOS_PATH, status: opts.videosStatus ?? 200,
    body: { items: opts.items ?? videoIds.map(id => ({ id, snippet: { publishedAt: '2026-04-15T00:00:00Z' }, contentDetails: { duration: 'PT1H2M3S' } })) },
  })
}

/** The injected seam, for the few cases that need a thrown error. */
const failingReport = (error: unknown): FetchReport =>
  (async () => { throw error }) as FetchReport

/** Built AFTER `temp()` so it names the project and account that exist. */
const args = () => ({
  project_slug: currentSlug, account_id: currentAccountId,
  application_id: currentApplicationId, channel_id: CHANNEL,
})

describe('analytics fetch and cache', () => {
  test('a real zero is a value; a video YouTube has no row for is no_data', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueFullRead(fake, ['v1'])
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1', 'missing'] })

    const measured = result.episodes.find(e => e.video_id === 'v1')!
    assert.equal(measured.metrics.views.state, 'value')
    assert.equal(measured.metrics.views.state === 'value' && measured.metrics.views.value, 0)

    // The whole point of the phase: an absent row must not become 0.
    const absent = result.episodes.find(e => e.video_id === 'missing')!
    for (const metric of ANALYTICS_METRICS) {
      assert.equal(absent.metrics[metric].state, 'no_data', metric)
    }
    __resetYouTubeTransportForTests()
  })

  test('a metric YouTube omits from the report is not_available, never zero', async () => {
    // Driven through the REAL report parser with a column genuinely missing —
    // which is how YouTube actually withholds a metric. The old fixture
    // `delete`d a key from a hand-built object, a shape the producer could
    // never emit, and the coercion in `getEpisodeAnalytics` meant this state
    // was unreachable in production while the test passed.
    await temp()
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(['v1'], {
      columns: ALL_COLUMNS.filter(c => c !== 'averageViewPercentage'),
      values: { views: 120, estimatedMinutesWatched: 40 },
    }))
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })
    const metric = result.episodes[0]!.metrics.avg_view_percentage
    assert.equal(metric.state, 'not_available')
    assert.equal(metric.state === 'not_available' && metric.reason.length > 0, true)
    // Its neighbours ARE present, and it is still not derived from them.
    assert.equal(result.episodes[0]!.metrics.views.state, 'value')
    assert.equal(result.episodes[0]!.metrics.watch_minutes.state, 'value')
    __resetYouTubeTransportForTests()
  })

  test('the window travels with the numbers', async () => {
    // "1,204 views" means 1,204 IN A WINDOW. Without it on screen the figure
    // reads as lifetime, and a quiet quarter on an old video reads as no_data
    // about the video rather than about the window.
    await temp()
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(['v1']))
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({
      ...args(), video_ids: ['v1'], start_date: '2026-06-05', end_date: '2026-09-03',
    })
    assert.equal(result.start_date, '2026-06-05')
    assert.equal(result.end_date, '2026-09-03')
    assert.match(fake.calls[0]!.path, /startDate=2026-06-05/)
    assert.match(fake.calls[0]!.path, /endDate=2026-09-03/)
    __resetYouTubeTransportForTests()
  })

  test('a default window is a real window, not an absent one', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(['v1']))
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })
    assert.match(result.start_date, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(result.end_date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(result.start_date < result.end_date, 'the window has a direction')
    __resetYouTubeTransportForTests()
  })

  test('a failed fetch claims nothing rather than showing an empty channel', async () => {
    await temp()
    const result = await fetchProjectAnalytics({
      ...args(), video_ids: ['v1', 'v2'], fetchReport: failingReport(new Error('provider down')),
    })

    assert.equal(result.partial, true)
    // The reason literal is what distinguishes this from every other failure
    // path — without it this test and the scope_missing one assert the same
    // two facts.
    assert.equal(result.partial_reason, 'provider_error')
    assert.notEqual(result.partial_reason, 'scope_missing')
    // The fetch no longer names the videos: the page derives "not covered"
    // from the live roster, so an empty `episodes` IS the statement that
    // nothing was measured.
    assert.deepEqual(result.episodes, [], 'nothing was read, so nothing is claimed')
    // Even a total failure states which window it failed to read.
    assert.match(result.start_date, /^\d{4}-\d{2}-\d{2}$/)
  })

  test('an exhausted allowance is its own reason, not a provider error', async () => {
    await temp()
    const result = await fetchProjectAnalytics({
      ...args(), video_ids: ['v1'],
      fetchReport: failingReport(Object.assign(new Error('quota'), { code: 'YOUTUBE_QUOTA_EXHAUSTED' })),
    })
    assert.equal(result.partial_reason, 'quota_exhausted')
  })

  test('the numbers carry the channel they were fetched under', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(['v1']))
    __setYouTubeTransportForTests(fake.transport())
    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })
    assert.equal(result.channel_id, CHANNEL)
    __resetYouTubeTransportForTests()
  })

  test('one video linked twice is fetched and listed once', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(['v1']))
    __setYouTubeTransportForTests(fake.transport())
    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1', 'v1'] })
    assert.equal(result.episodes.length, 1)
    assert.equal(fake.calls.length, 1)
    __resetYouTubeTransportForTests()
  })

  test('the analytics report charges the one Cloud-project ledger, once per call', async () => {
    await temp()
    const ledger = await import('../services/youtube-quota-ledger.js')
    const fake = new FakeYouTube()
    queueFullRead(fake, ['v1'])
    __setYouTubeTransportForTests(fake.transport())
    await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })

    // Assert the recorded OUTCOME, not that a writer ran. Three reports (main,
    // subscribers, impressions) are three analytics charges; the one
    // `videos.list` batch is charged to the Data API, not to analytics.
    const snapshot = await ledger.readYouTubeQuota(currentApplicationId)
    assert.equal(snapshot.buckets.analytics.used, 3, 'three reports, three charges')
    assert.equal(snapshot.buckets.analytics.by_channel[CHANNEL], 3)
    assert.equal(snapshot.buckets.other_endpoints.used, 1, 'the facts batch is charged to its own bucket')
    assert.equal(fake.calls.length, 4, 'and exactly four provider calls were made')
    __resetYouTubeTransportForTests()
  })

  test('a truncated report is partial, not a page full of no_data', async () => {
    // The report caps at 200 rows. A project with more linked videos than that
    // would otherwise have the leftovers marked "YouTube had nothing to say" —
    // a finding about their work, from a call that simply ran out of room.
    await temp()
    const covered = Array.from({ length: 200 }, (_, i) => `v${i}`)
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(covered))
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({
      ...args(), video_ids: [...covered, 'past-the-cap'],
    })
    assert.equal(result.partial, true)
    assert.equal(result.partial_reason, 'report_truncated')
    // The over-cap video is simply absent from the measurements, which is what
    // makes the route report it as uncovered.
    assert.equal(result.episodes.some(e => e.video_id === 'past-the-cap'), false)
    assert.equal(result.episodes.length, 200)
    __resetYouTubeTransportForTests()
  })

  test('a short report means the blanks really are no_data', async () => {
    // The control: without it, "partial" could be returned always and the test
    // above would pass while telling the owner nothing is ever known.
    await temp()
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(['v1']))
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1', 'quiet'] })
    assert.equal(result.partial, false)
    assert.equal(result.partial_reason, undefined)
    assert.equal(result.episodes.find(e => e.video_id === 'quiet')!.metrics.views.state, 'no_data')
    __resetYouTubeTransportForTests()
  })

  test('exactly one row short of the cap is a complete answer', async () => {
    // Tell 1b's boundary, asserted rather than assumed.
    await temp()
    const covered = Array.from({ length: 199 }, (_, i) => `v${i}`)
    const fake = new FakeYouTube()
    queueReport(fake, reportBody(covered))
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: [...covered, 'quiet'] })
    assert.equal(result.partial, false, '199 rows is not a truncation signal')
    assert.equal(result.episodes.find(e => e.video_id === 'quiet')!.metrics.views.state, 'no_data')
    __resetYouTubeTransportForTests()
  })

  test('every metric holds at 0, 1, 49, 50 and 51 episodes', async () => {
    for (const size of [0, 1, 49, 50, 51]) {
      await temp()
      const ids = Array.from({ length: size }, (_, i) => `v${i}`)
      const fake = new FakeYouTube()
      queueReport(fake, reportBody(ids))
      __setYouTubeTransportForTests(fake.transport())
      const result = await fetchProjectAnalytics({ ...args(), video_ids: ids })
      assert.equal(result.episodes.length, size, `size ${size}`)
      assert.deepEqual(result.episodes.map(e => e.video_id), ids, `size ${size} contents`)
      __resetYouTubeTransportForTests()
      await cleanup?.(); cleanup = null
    }
  })
})

describe('a grant without the analytics scope', () => {
  test('is its own state, not an allowance problem and not an empty channel', async () => {
    // `scope_missing` was DECLARED in the type from the first commit and
    // produced by nothing — a state that reads as available and never fires
    // (tell 4). The legacy /upload route has checked this since before the
    // redesign; the new service had the string and not the check.
    await temp()
    const connections = await import('../services/youtube-connection-store.js')
    await connections.saveYouTubeChannelTokens({
      channel_id: CHANNEL,
      expected_access_token: 'analytics-access',
      tokens: {
      access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
      },
    })

    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })

    assert.equal(result.partial, true)
    assert.equal(result.partial_reason, 'scope_missing')
    assert.deepEqual(result.episodes, [], 'nothing measured, so nothing claimed')
    assert.equal(fake.calls.length, 0, 'refused before spending a request')
    __resetYouTubeTransportForTests()
  })

  test('a bare 403 is not read as an exhausted allowance', async () => {
    // YouTube returns 403 for insufficientPermissions as readily as for
    // quotaExceeded. Calling the first "today's allowance ran out" tells the
    // owner to wait for a reset that will never fix it.
    await temp()
    const permission = await fetchProjectAnalytics({
      ...args(), video_ids: ['v1'],
      fetchReport: failingReport(Object.assign(
        new Error('YouTube Analytics API error (403): insufficientPermissions'),
        { statusCode: 403 },
      )),
    })
    assert.equal(permission.partial_reason, 'provider_error')

    // ...while a 403 that SAYS it is about quota still reads as quota.
    const quota = await fetchProjectAnalytics({
      ...args(), video_ids: ['v1'],
      fetchReport: failingReport(Object.assign(
        new Error('YouTube Analytics API error (403): quotaExceeded'),
        { statusCode: 403 },
      )),
    })
    assert.equal(quota.partial_reason, 'quota_exhausted')
  })

  test('a metric cell YouTube returns as null is not_available, not zero', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueReport(fake, {
      columnHeaders: ALL_COLUMNS.map(name => ({ name })),
      rows: [['v1', 12, null, 30, 40, 1, 2, 3]],
    })
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })
    assert.equal(result.episodes[0]!.metrics.watch_minutes.state, 'not_available')
    assert.equal(result.episodes[0]!.metrics.views.state, 'value')
    __resetYouTubeTransportForTests()
  })

  test('a project with nothing published spends no allowance finding out', async () => {
    await temp()
    const ledger = await import('../services/youtube-quota-ledger.js')
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: [] })
    assert.equal(result.partial, false)
    assert.deepEqual(result.episodes, [])
    assert.equal(fake.calls.length, 0)
    assert.equal((await ledger.readYouTubeQuota(currentApplicationId)).buckets.analytics.used, 0)
    __resetYouTubeTransportForTests()
  })
})

describe('the analytics cache is scoped to the channel it describes', () => {
  test('a cache from another channel is a miss, not a hit', async () => {
    await temp()
    const pm = await import('../services/project-manager.js')
    const store = await import('../services/youtube-project-publishing-store.js')
    const created = await pm.createProject({ name: 'Analytics Project' })
    // The video must be LINKED for its measurement to persist: the store prunes
    // cached episodes whose video this project no longer publishes, so a
    // fixture that skipped the link now writes an empty cache and this test
    // would assert channel scoping against nothing.
    await store.linkYouTubeEpisodeVideo({
      project_slug: created.slug, episode_code: 'EP0001', channel_id: 'UC-a-previous-channel',
      video_id: 'v1', source: 'upload', decided_at: new Date().toISOString(),
    })

    await store.recordYouTubeAnalyticsCache({
      project_slug: created.slug,
      analytics: {
        fetched_at: AT,
        channel_id: 'UC-a-previous-channel',
        start_date: '2026-06-05',
        end_date: '2026-09-03',
        partial: false,
        episodes: [{ video_id: 'v1', metrics: {} }],
      },
    })

    const state = await store.readYouTubeProjectPublishingState(created.slug)
    // Same project, different channel: the stored numbers describe work this
    // project no longer publishes. Serving them would state a falsehood.
    assert.equal(store.analyticsForChannel(state, CHANNEL), null)
    // ...and the channel it WAS fetched under still resolves.
    assert.equal(store.analyticsForChannel(state, 'UC-a-previous-channel')?.episodes.length, 1)
    // No channel assigned is also a miss, never "show whatever we have".
    assert.equal(store.analyticsForChannel(state, null), null)
  })

  test('a state file written before analytics existed still decodes', async () => {
    await temp()
    const pm = await import('../services/project-manager.js')
    const store = await import('../services/youtube-project-publishing-store.js')
    const created = await pm.createProject({ name: 'Analytics Project' })

    const state = await store.readYouTubeProjectPublishingState(created.slug)
    assert.equal(state.analytics, undefined, 'absent, not invalid')
    assert.equal(store.analyticsForChannel(state, CHANNEL), null)
  })
})

describe('the analytics table: extra metrics and video facts (YouTube mocked)', () => {
  test('subscribers, impressions and click-through rate are read in their own reports', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueFullRead(fake, ['v1'], { values: {
      views: 900, subscribersGained: 7, videoThumbnailImpressions: 12000, videoThumbnailImpressionsClickRate: 4.2,
    } })
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })
    const metrics = result.episodes[0]!.metrics
    assert.deepEqual(
      ['views', 'subscribers_gained', 'impressions', 'click_through_rate'].map(name => {
        const m = metrics[name as keyof typeof metrics]
        return m.state === 'value' ? m.value : m.state
      }),
      [900, 7, 12000, 4.2],
    )
    // Asked separately, so a refusal of one cannot take the main figures down.
    const reports = fake.calls.filter(call => REPORT_PATH.test(call.path)).map(call => decodeURIComponent(call.path))
    assert.equal(reports.length, 3)
    assert.match(reports[1]!, /metrics=views,subscribersGained&/)
    assert.match(reports[2]!, /metrics=views,videoThumbnailImpressions,videoThumbnailImpressionsClickRate&/)
    __resetYouTubeTransportForTests()
  })

  test('a refused impressions report marks only those metrics not available', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueFullRead(fake, ['v1'], {
      values: { views: 900, subscribersGained: 7 },
      impressions: { status: 400, body: { error: { message: 'Unknown identifier (videoThumbnailImpressions)' } } },
    })
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })
    const metrics = result.episodes[0]!.metrics
    for (const name of ['impressions', 'click_through_rate'] as const) {
      const m = metrics[name]
      assert.equal(m.state, 'not_available', name)
      assert.equal(m.state === 'not_available' && m.reason, 'YouTube did not provide impressions for this channel.')
    }
    // The main figures and the other optional report are untouched.
    assert.equal(metrics.views.state === 'value' && metrics.views.value, 900)
    assert.equal(metrics.subscribers_gained.state === 'value' && metrics.subscribers_gained.value, 7)
    assert.equal(result.partial, false, 'a refused optional metric is not a partial read')
    __resetYouTubeTransportForTests()
  })

  test('published date and length are parsed from videos.list', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueFullRead(fake, ['v1', 'gone'], {
      items: [{ id: 'v1', snippet: { publishedAt: '2026-04-15T00:00:00Z' }, contentDetails: { duration: 'PT1H2M3S' } }],
    })
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1', 'gone'] })
    const v1 = result.episodes.find(e => e.video_id === 'v1')!.facts
    assert.equal(v1.length.state === 'value' && v1.length.value, 3723)
    assert.equal(v1.published.state === 'value' && v1.published.value, Date.parse('2026-04-15T00:00:00Z'))
    const videosCall = fake.calls.find(call => VIDEOS_PATH.test(call.path))!
    assert.match(decodeURIComponent(videosCall.path), /part=snippet,contentDetails/)
    // A video YouTube did not return has no facts - "not available", not blank.
    const gone = result.episodes.find(e => e.video_id === 'gone')!.facts
    assert.equal(gone.length.state, 'not_available')
    assert.equal(gone.published.state, 'not_available')
    __resetYouTubeTransportForTests()
  })

  test('a failed videos.list leaves the facts not available and the metrics intact', async () => {
    await temp()
    const fake = new FakeYouTube()
    queueFullRead(fake, ['v1'], { values: { views: 5 }, videosStatus: 500 })
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ['v1'] })
    const episode = result.episodes[0]!
    assert.equal(episode.facts.length.state, 'not_available')
    assert.equal(episode.facts.published.state === 'not_available' && episode.facts.published.reason.length > 0, true)
    assert.equal(episode.metrics.views.state === 'value' && episode.metrics.views.value, 5)
    __resetYouTubeTransportForTests()
  })

  test('videos.list is asked in batches of 50', async () => {
    await temp()
    const ids = Array.from({ length: 51 }, (_, i) => `v${i}`)
    const fake = new FakeYouTube()
    queueFullRead(fake, ids)
    // The second batch.
    fake.respondMatching({ method: 'GET', match: VIDEOS_PATH, body: { items: [] } })
    __setYouTubeTransportForTests(fake.transport())

    const result = await fetchProjectAnalytics({ ...args(), video_ids: ids })
    assert.equal(fake.calls.filter(call => VIDEOS_PATH.test(call.path)).length, 2)
    assert.equal(result.episodes.find(e => e.video_id === 'v0')!.facts.length.state, 'value')
    __resetYouTubeTransportForTests()
  })

  test('ISO-8601 durations parse to seconds; no length is not zero', () => {
    assert.equal(isoDurationSeconds('PT1H2M3S'), 3723)
    assert.equal(isoDurationSeconds('PT45S'), 45)
    assert.equal(isoDurationSeconds('P1DT1S'), 86401)
    // "P0D" is what YouTube sends for a live or upcoming stream.
    assert.equal(isoDurationSeconds('P0D'), null)
    assert.equal(isoDurationSeconds('soon'), null)
  })
})
