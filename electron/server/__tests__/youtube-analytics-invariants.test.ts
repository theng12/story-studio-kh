import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

/**
 * The analytics cache's INVARIANTS, as tests.
 *
 * Written after the fourth review, because four consecutive reviews found
 * defects at this one seam and two of them were introduced by the fixes for the
 * previous two. Every one broke a rule the ORIGINAL code kept by accident: the
 * blind overwrite kept "one read, one window" because it never merged; the
 * frozen roster kept "rows match the cache" because it never looked at links.
 *
 * A rewrite is a change too. These are the rules that were implicit, written
 * down so the seam fails a test instead of a review.
 */

const CHANNEL = 'UC-center-channel'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const store = await import('../services/youtube-project-publishing-store.js')
const logger = await import('../services/logger.js')
const connections = await import('../services/youtube-connection-store.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => { await cleanup?.(); cleanup = null })

async function project(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const created = await pm.createProject({ name: 'Invariant Project' })
  await connections.configureYouTubeApplication({ client_id: 'c', client_secret: 'sh-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Center Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'g', refresh_token: 'gr', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created.slug
}

const link = (slug: string, code: string, videoId: string, channelId = CHANNEL) =>
  store.linkYouTubeEpisodeVideo({
    project_slug: slug, episode_code: code, channel_id: channelId,
    video_id: videoId, source: 'upload', decided_at: new Date().toISOString(),
  })

type CacheState = Parameters<typeof store.recordYouTubeAnalyticsCache>[0]['analytics']
type CachedEpisode = CacheState['episodes'][number]

const ALL_METRICS = [
  'views', 'watch_minutes', 'avg_view_seconds', 'avg_view_percentage',
  'likes', 'comments', 'shares',
] as const

/** A fully measured episode — all seven metrics, as the service emits them. */
const measured = (videoId: string, value: number, at = '2026-09-03T10:00:00.000Z'): CachedEpisode => ({
  video_id: videoId,
  metrics: Object.fromEntries(ALL_METRICS.map(name => [name, { state: 'value', value, fetched_at: at }])),
})

/** An episode YouTube answered about and had nothing to say. Covered, not absent. */
const noData = (videoId: string, at = '2026-09-03T10:00:00.000Z'): CachedEpisode => ({
  video_id: videoId,
  metrics: Object.fromEntries(ALL_METRICS.map(name => [name, { state: 'no_data', fetched_at: at }])),
})

/**
 * TYPED, with no `as any`. The suite that guards this cache must be checked
 * against the cache's own type: while it was cast, an in-flight field removal
 * passed straight through it and broke four other files.
 */
const write = (slug: string, over: Partial<CacheState> = {}) => store.recordYouTubeAnalyticsCache({
  project_slug: slug,
  analytics: {
    fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
    start_date: '2026-06-05', end_date: '2026-09-03',
    partial: false, episodes: [],
    ...over,
  },
})

/** The stored cache, read back through the real decoder. */
const stored = async (slug: string): Promise<CacheState | undefined> =>
  (await store.readYouTubeProjectPublishingState(slug)).analytics

const read = (slug: string) => request(app).get(`/api/projects/${slug}/youtube/analytics`)

describe('analytics cache invariants', () => {
  test('(a) every episode in the cache was measured in the cache s window', async () => {
    // The state carries ONE window for ALL episodes. Merging a read from a
    // different period labels the survivors with a window they were never
    // measured in — and the route asks for "last 90 days ending today", so the
    // window moves every day.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await link(slug, 'EP0002', 'v2')
    await write(slug, { episodes: [measured('v1', 100)] })

    // A later read over a DIFFERENT window, measuring only v2.
    await write(slug, {
      start_date: '2026-07-15', end_date: '2026-10-13',
      episodes: [measured('v2', 200)],
    })

    // Asserted on the STORE. Through the route this would also pass, but the
    // route rebuilds rows from links and would mask a cache that still held v1.
    const cache = await stored(slug)
    assert.equal(cache?.start_date, '2026-07-15')
    assert.deepEqual(
      cache?.episodes.map(e => e.video_id), ['v2'],
      'v1 was measured in another window; keeping it would relabel it with this one',
    )
  })

  test('(b) unreached_video_ids is exactly the roster rows with no measurement', async () => {
    // "No measurement" means the cache has no entry for that video — NOT
    // "its metrics are not a number". A no_data row was measured: YouTube
    // answered and had nothing to say, which is a finding, not a gap.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await link(slug, 'EP0002', 'v2')
    await link(slug, 'EP0003', 'v3')
    await write(slug, { episodes: [measured('v1', 100), noData('v2')] })

    const res = await read(slug)
    const cache = await stored(slug)
    const cached = new Set((cache?.episodes ?? []).map(e => e.video_id))
    const withoutMeasurement = res.body.episodes
      .map((e: any) => e.video_id)
      .filter((id: string) => !cached.has(id))

    assert.deepEqual(res.body.unreached_video_ids, withoutMeasurement)
    assert.deepEqual(res.body.unreached_video_ids, ['v3'], 'only the one with no entry at all')
    // The no_data row is COVERED and must not be listed as missing.
    assert.equal(res.body.unreached_video_ids.includes('v2'), false)
  })

  test('(c) numbers fetched under another channel are never served', async () => {
    // Named for what is true. The STORE persists whatever channel_id it is
    // given — it is the reader that refuses, so "the cache never describes
    // another channel" would be a false claim about the store.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await write(slug, { channel_id: 'UC-a-previous-channel', episodes: [measured('v1', 100)] })

    const state = await store.readYouTubeProjectPublishingState(slug)
    assert.equal(state.analytics?.channel_id, 'UC-a-previous-channel', 'stored as given')
    // ...and refused at the seam that decides what may be shown.
    assert.equal(store.analyticsForChannel(state, CHANNEL), null)

    const res = await read(slug)
    assert.equal(res.body.never_fetched, true)
    assert.equal(res.body.episodes[0].metrics.views.state, 'not_fetched')
  })

  test('(d) a failed read changes the report, not the numbers', async () => {
    // TWO episodes, one measured. With only one, `unmeasured` is empty and the
    // partial_reason precedence below is never exercised — the version of this
    // test with a single episode passed against code that overwrote the cached
    // reason.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await link(slug, 'EP0002', 'v2')
    await write(slug, {
      fetched_at: '2026-09-01T10:00:00.000Z',
      episodes: [measured('v1', 1204, '2026-09-01T10:00:00.000Z')],
    })

    await write(slug, {
      fetched_at: '2026-09-03T10:00:00.000Z',
      partial: true, partial_reason: 'quota_exhausted', episodes: [],
    })

    const res = await read(slug)
    const rows = Object.fromEntries(res.body.episodes.map((e: any) => [e.episode_code, e]))
    assert.equal(rows.EP0001.metrics.views.value, 1204, 'the numbers survived')
    assert.equal(res.body.fetched_at, '2026-09-01T10:00:00.000Z', 'and so did their age')
    assert.equal(res.body.partial, true)
    assert.equal(res.body.partial_reason, 'quota_exhausted')
    // v1 has numbers on screen, so it is not "not covered". v2 never did.
    assert.deepEqual(res.body.unreached_video_ids, ['v2'])
  })

  test('(e) an unlinked video s numbers are pruned on the next analytics write', async () => {
    // An unlink-then-relink would otherwise resurface months-old numbers with
    // nothing on screen saying how old they are.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')

    // A reconcile decision creates EP0002 -> v2; rolling it back DELETES that
    // link, because the decision had no previous link to restore.
    const decision = await store.recordYouTubeReconcileDecision({
      project_slug: slug, episode_code: 'EP0002', previous_video_id: null, next_video_id: 'v2',
    })
    await store.linkYouTubeEpisodeVideo({
      project_slug: slug, episode_code: 'EP0002', channel_id: CHANNEL,
      video_id: 'v2', source: 'reconcile', decided_at: new Date().toISOString(),
    })
    await write(slug, { episodes: [measured('v1', 100), measured('v2', 200)] })
    assert.equal((await stored(slug))?.episodes.length, 2, 'both were cached to begin with')

    await store.rollbackYouTubeReconcileDecision({
      project_slug: slug, decision_id: decision.decision_id,
    })
    const unlinked = await store.readYouTubeProjectPublishingState(slug)
    assert.equal(unlinked.episode_video_links.EP0002, undefined, 'the link really is gone')

    // The next write prunes what is no longer linked.
    await write(slug, { episodes: [measured('v1', 100)] })

    const state = await store.readYouTubeProjectPublishingState(slug)
    const linkedVideos = new Set(Object.values(state.episode_video_links).map(l => l.video_id))
    for (const episode of state.analytics?.episodes ?? []) {
      assert.ok(linkedVideos.has(episode.video_id), `${episode.video_id} is cached but not linked`)
    }
    assert.equal(state.analytics?.episodes.some(e => e.video_id === 'v2'), false)
  })

  test('(f) writing the same read twice leaves the same state', async () => {
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await write(slug, { episodes: [measured('v1', 100)] })
    const once = await stored(slug)
    const onceRead = await read(slug)

    await write(slug, { episodes: [measured('v1', 100)] })
    const twice = await stored(slug)
    const twiceRead = await read(slug)

    // The STORED state, not just the rendered response: the route matches rows
    // to the cache by video id, so duplicate cache entries are invisible from
    // the outside. An earlier version of this test compared only the responses
    // and stayed green while the merge accumulated a row per write.
    assert.deepEqual(twice, once, 'the merge is idempotent')
    assert.equal(twice?.episodes.length, 1)
    assert.deepEqual(twiceRead.body, onceRead.body)
  })

  test('(h) a cache with no window is dropped, not decoded with an empty one', async () => {
    // A windowless cache was a STATE, and the merge could not reason about it:
    // with both sides undefined `sameWindow` is trivially true, so it would
    // merge with a windowed read and inherit a window it was never measured in
    // — the very defect the window guard exists to prevent, in the branch the
    // guard declared exempt. The state is deleted rather than guarded: the
    // window is required, so such a cache fails decode and takes the droppable
    // path. One refetch, and a whole class of edge goes away.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await write(slug, { episodes: [measured('v1', 100)] })

    const statePath = path.join(
      process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json')
    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
    delete raw.analytics.start_date
    await fs.writeFile(statePath, JSON.stringify(raw))

    const res = await read(slug)
    assert.equal(res.body.never_fetched, true, 'dropped, and honestly reported as unfetched')
    assert.equal(res.body.episodes[0].metrics.views.state, 'not_fetched')
    // An asymmetric window (start without end, which a looser decode permitted)
    // would otherwise produce a window made of two different reads.
    assert.equal(res.body.start_date, null)
  })

  test('(g) a cached failure reason is never overwritten by not_all_measured', async () => {
    // Every failure path stores `episodes: []`, so after one every roster row
    // is unmeasured. Letting `not_all_measured` win told an owner whose channel
    // has not granted analytics access to "fetch again to measure them" —
    // advice that cannot work, hiding the reconnect instruction that would.
    // Four of the six declared reasons became unreachable through the route.
    for (const reason of ['scope_missing', 'not_connected', 'report_truncated', 'quota_exhausted'] as const) {
      const slug = await project()
      await link(slug, 'EP0001', 'v1')
      await link(slug, 'EP0002', 'v2')
      await write(slug, { episodes: [measured('v1', 100)] })
      await write(slug, {
        partial: true, partial_reason: reason, episodes: [],
      })

      const res = await read(slug)
      assert.equal(res.body.partial_reason, reason, `${reason} must survive an unmeasured roster`)
      await cleanup?.(); cleanup = null
    }
  })

  test('(i) an unreadable cache is reported once, and again after it breaks a second time', async () => {
    // `decodeState` runs on every READ, so an unrepaired cache would log on
    // every page open and bury the one line that matters. But the suppression
    // was a one-way latch with no test: after a refetch repaired the cache, a
    // SECOND and different failure on the same project was silent forever — in
    // a process that lives for days.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await write(slug, { episodes: [measured('v1', 100)] })

    const statePath = path.join(
      process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json')
    const logDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'logs')
    const dropLines = async (): Promise<number> => {
      // `logLine` buffers: `write()` returns before the bytes land. Reading the
      // file without this makes the FIRST assertion the flaky one - it would
      // see 0 lines and fail for a reason that has nothing to do with the
      // behaviour under test.
      await logger.flushLogLines()
      let total = 0
      for (const file of await fs.readdir(logDir).catch(() => [] as string[])) {
        const text = await fs.readFile(path.join(logDir, file), 'utf8').catch(() => '')
        total += text.split('\n').filter(line => line.includes('dropped an unreadable analytics cache')).length
      }
      return total
    }

    const corrupt = async (): Promise<void> => {
      const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
      raw.analytics.episodes[0].metrics.views.state = 'not_a_state'
      await fs.writeFile(statePath, JSON.stringify(raw))
    }

    const before = await dropLines()
    await corrupt()
    await read(slug)
    const first = await dropLines()
    assert.equal(first, before + 1, 'the first unreadable cache is reported')

    // Still broken: the same project must not repeat itself on every read.
    await read(slug)
    await read(slug)
    assert.equal(await dropLines(), first, 'and is not repeated while unrepaired')

    // A successful decode re-arms the warning...
    await write(slug, { episodes: [measured('v1', 100)] })
    await read(slug)
    assert.equal(await dropLines(), first, 'a healthy read logs nothing')

    // ...so a NEW failure is heard.
    await corrupt()
    await read(slug)
    assert.equal(await dropLines(), first + 1, 'a second, later failure is reported')
  })

  test('(j) a cache written before unreached_video_ids was dropped still decodes', async () => {
    // The field is tolerated as an OPTIONAL key so pre-upgrade caches survive.
    // Nothing wrote raw state carrying it, so a future cleanup that removed it
    // from the optional list would go green while every existing installation
    // silently dropped its analytics and refetched.
    const slug = await project()
    await link(slug, 'EP0001', 'v1')
    await write(slug, { episodes: [measured('v1', 100)] })

    const statePath = path.join(
      process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json')
    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
    raw.analytics.unreached_video_ids = ['v1']
    await fs.writeFile(statePath, JSON.stringify(raw))

    const state = await store.readYouTubeProjectPublishingState(slug)
    assert.equal(state.analytics?.episodes.length, 1, 'the cache survived the legacy key')
    assert.equal((state.analytics as Record<string, unknown>).unreached_video_ids, undefined,
      'and the key is ignored rather than carried forward')

    const res = await read(slug)
    assert.equal(res.body.never_fetched, false)
    assert.equal(res.body.episodes[0].metrics.views.value, 100)
  })
})
