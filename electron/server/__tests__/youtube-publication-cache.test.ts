/**
 * The channel-scoped publication cache: what YouTube itself reported about
 * every known video (operation, legacy, reconciled, listed), kept with its own
 * checked_at, reused by every reader, and never mixed across channels.
 *
 * Production defect (Boundless, 1.4.305): Check All Uploads asked YouTube about
 * 72 legacy uploads, YouTube said they were scheduled, and Story kept only
 * `upload_status` - so all 72 stayed "uploaded" everywhere.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'

const boot = await useTempDataDir()
const { __resetYouTubeTransportForTests, __setYouTubeTransportForTests, registryCredentialFor } = await import('../lib/youtube-client.js')
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const connections = await import('../services/youtube-connection-store.js')
const operations = await import('../services/youtube-operation-store.js')
const sidecars = await import('../services/upload-sidecar.js')
const statusSync = await import('../services/youtube-status-sync.js')
const { readYouTubeRetentionStores } = await import('../services/youtube-remote-video.js')
const { readEpisodeUploadStatus } = await import('../services/episode-upload-status.js')
const publishing = await import('../services/youtube-project-publishing-store.js')
const cacheService = await import('../services/youtube-publication-cache.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetYouTubeTransportForTests()
  statusSync._resetYouTubeStatusSyncForTests()
  await cleanup?.()
  cleanup = undefined
})

const CHANNEL = 'UC-cache-a'
const OTHER = 'UC-cache-b'
const HOUR = 60 * 60 * 1000
const VIDEOS = /^\/youtube\/v3\/videos\?part=snippet,status,processingDetails&id=/
const PLAYLIST = /^\/youtube\/v3\/playlistItems\?/
const CHANNELS = /^\/youtube\/v3\/channels\?/
const scheduleAt = (day: number) => `2026-${day < 50 ? '11' : '12'}-${String((day % 28) + 1).padStart(2, '0')}T15:00:00Z`

async function grant(channelId: string) {
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channelId, title: `Channel ${channelId}`, granted_scopes: ['youtube.upload'] },
    tokens: { access_token: `access-${channelId}`, refresh_token: `refresh-${channelId}`, expires_at: Date.now() + HOUR },
  })
}

async function setup() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await pm.createProject({ name: `Cache ${Math.random()}` })
  const slug = project.slug
  await connections.configureYouTubeApplication({ client_id: 'cache-client', client_secret: 'cache-secret-value' })
  await grant(CHANNEL)
  await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: CHANNEL, expected_previous_channel_id: null })

  async function episodes(count: number): Promise<string[]> {
    const ideas = await im.addIdeas(slug, Array.from({ length: count }, (_, i) => ({
      title: `Story ${i} ${Math.random().toString(36).slice(2, 7)}`, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    })), 'test')
    for (const idea of ideas) await im.acceptIdea(slug, idea.id, false)
    const accepted = await im.getIdeas(slug, 'accepted')
    return ideas.map(idea => String(accepted.find(row => row.id === idea.id)!.episode_code))
  }
  async function legacy(code: string, videoId: string, channelId: string | null = CHANNEL) {
    await sidecars.writeSidecar(slug, code, '', {
      platform: 'youtube', video_id: videoId, account_id: 'old', channel_id: channelId as string,
      uploaded_at: '2026-09-01T00:00:00.000Z', last_sync_at: '',
      // Local intent: what Story planned. Must never be read as YouTube's answer.
      scheduled_for: '2030-01-01T00:00:00.000Z', privacy_status: 'private',
      title: code, description: '', tags: [], thumbnail_set: true,
    })
  }
  async function readyOperation(code: string, videoId: string, scheduledFor: string, fetchedAt = '2026-10-01T01:00:00.000Z') {
    const created = await operations.createYouTubeOperation({
      project_slug: slug, episode_code: code, channel_id: CHANNEL,
      source_revision: `src-${code}`, metadata_revision: `meta-${code}`, origin: 'manual', final_action: 'manual_upload',
    })
    const accepted = await operations.acceptYouTubeOperation({
      project_slug: slug, operation_id: created.operation_id, expected_revision: created.revision,
      channel_id: CHANNEL, video_id: videoId, accepted_at: '2026-10-01T00:00:00.000Z',
      final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
    })
    await operations.updateYouTubeOperation({
      project_slug: slug, operation_id: created.operation_id, expected_revision: accepted.revision,
      mutate(record) {
        record.lifecycle = 'ready'
        record.processing = { checked_at: '2026-10-01T01:00:00.000Z', provider_status: 'processed' }
        record.remote_snapshot = {
          fetched_at: fetchedAt, title: code, description: '', tags: [],
          privacy_status: 'private', scheduled_for: scheduledFor,
        }
      },
    })
  }
  const youtubeDir = () => path.join(pm.getProjectDir(slug)!, 'youtube')
  async function rawCache() {
    return JSON.parse(await fs.readFile(path.join(youtubeDir(), 'publication-cache.json'), 'utf-8')).channels
  }
  return { slug, episodes, legacy, readyOperation, rawCache, youtubeDir, accountId: () => registryCredentialFor(CHANNEL) }
}

function scheduled(id: string, publishAt: string, channelId = CHANNEL) {
  return { id, status: { uploadStatus: 'processed', privacyStatus: 'private', publishAt }, snippet: { title: `Title ${id}`, channelId } }
}

async function publishable(slug: string) {
  const res = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(res.status, 200)
  return new Map<string, any>(res.body.episodes.map((row: any) => [row.episode_code, row]))
}

async function episodeStatus(slug: string, code: string, channelId: string) {
  const stores = await readYouTubeRetentionStores(slug)
  return readEpisodeUploadStatus(slug, code, '', stores, undefined, undefined,
    { channel_id: channelId, cache: await cacheService.readYouTubePublicationCache(slug) })
}

async function cacheView(slug: string) {
  const res = await request(app).get(`/api/projects/${slug}/youtube/publication-cache`)
  assert.equal(res.status, 200, 'the read API exists')
  return res.body
}

describe('legacy uploads keep what YouTube reported', () => {
  test('72 legacy uploads YouTube reports as scheduled read as scheduled everywhere after Check All', async () => {
    const s = await setup()
    const codes = await s.episodes(72)
    const items = codes.map((code, i) => scheduled(`legacy-${i}`, scheduleAt(i)))
    for (const [i, code] of codes.entries()) await s.legacy(code, `legacy-${i}`)
    const fake = new FakeYouTube()
    // Two batched videos.list calls (50 + 22); each answer carries every item.
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items } })
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items } })
    __setYouTubeTransportForTests(fake.transport())
    // The channel listing is already fresh, so "Check All" spends its calls on
    // the videos: this test is about the batching.
    await cacheService.recordYouTubePublicationObservations({
      project_slug: s.slug, channel_id: CHANNEL,
      listing: { attempted_at: new Date().toISOString(), outcome: 'complete', videos: items.map(item => ({ video_id: item.id })) },
    })

    const sync = await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal(sync.status, 200)
    assert.equal(sync.body.outcome, 'ok')
    assert.deepEqual(sync.body.legacy, { checked: 72, processed: 72, not_found: 0 })
    assert.equal(fake.calls.length, 2, 'batched 50 ids per call')

    const rows = await publishable(s.slug)
    for (const [i, code] of codes.entries()) {
      const publication = rows.get(code).publication
      assert.equal(publication.state, 'scheduled', `${code} is scheduled on YouTube`)
      assert.equal(publication.scheduled_at, scheduleAt(i), 'YouTube’s publishAt, not the sidecar’s planned 2030 date')
      assert.equal(publication.visibility, 'private')
      assert.ok(publication.last_checked_at)
    }
    assert.equal(sync.body.publication_cache.recorded, 72)

    const view = await cacheView(s.slug)
    assert.equal(view.channel_id, CHANNEL)
    assert.equal(view.schedules.length, 72)
    assert.ok(view.schedules.every((entry: any) => entry.source === 'legacy' && entry.checked_at && entry.stale === false))
    assert.equal(view.coverage.unchecked_videos, 0)
    assert.equal(view.coverage.checked_videos, 72)

    // Episodes / Production Board read the same observation.
    const status = await episodeStatus(s.slug, codes[3]!, CHANNEL)
    assert.equal(status.state, 'uploaded')
    assert.equal(status.scheduled_for, scheduleAt(3))
    assert.equal(status.visibility, 'private')
    assert.ok(status.checked_at)

    // Overview freshness is the oldest answer, with coverage counts beside it.
    const overview = await request(app).get(`/api/projects/${s.slug}/youtube/overview`)
    assert.equal(overview.body.publication_coverage.checked_videos, 72)
    assert.equal(overview.body.last_remote_sync_at, view.coverage.oldest_checked_at)
  })

  test('the cache survives a restart: it is on disk, and reading it asks YouTube nothing', async () => {
    const s = await setup()
    const [code] = await s.episodes(1)
    await s.legacy(code!, 'legacy-persist')
    let fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('legacy-persist', '2026-11-20T15:00:00Z')] } })
    __setYouTubeTransportForTests(fake.transport())
    assert.equal((await request(app).post(`/api/projects/${s.slug}/youtube/sync`)).status, 200)

    const onDisk = (await s.rawCache())[CHANNEL].videos['legacy-persist']
    assert.equal(onDisk.scheduled_for, '2026-11-20T15:00:00Z')
    assert.equal(onDisk.privacy_status, 'private')
    assert.ok(onDisk.checked_at)
    // Its own file: project-state.json keeps exactly the keys older builds decode.
    const state = JSON.parse(await fs.readFile(path.join(s.youtubeDir(), 'project-state.json'), 'utf-8').catch(() => '{}'))
    assert.equal('publication_cache' in state, false)

    fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const rows = await publishable(s.slug)
    assert.equal(rows.get(code!).publication.scheduled_at, '2026-11-20T15:00:00Z')
    assert.equal((await cacheView(s.slug)).schedules[0].video_id, 'legacy-persist')
    assert.equal(fake.calls.length, 0)
  })
})

describe('a schedule changed on YouTube is reflected', () => {
  test('a second Check All replaces the observed schedule; the background refreshes stale ready and legacy videos in one bounded batch', async () => {
    const s = await setup()
    const [oldCode, readyCode] = await s.episodes(2)
    await s.legacy(oldCode!, 'legacy-move')
    await s.readyOperation(readyCode!, 'ready-move', '2026-11-01T15:00:00Z')

    let fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: /id=ready-move$/, body: { items: [scheduled('ready-move', '2026-11-01T15:00:00Z')] } })
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('legacy-move', '2026-11-05T15:00:00Z')] } })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${s.slug}/youtube/sync`)

    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: /id=ready-move$/, body: { items: [scheduled('ready-move', '2026-11-01T15:00:00Z')] } })
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('legacy-move', '2026-12-24T15:00:00Z')] } })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal((await publishable(s.slug)).get(oldCode!).publication.scheduled_at, '2026-12-24T15:00:00Z')

    // A day later both observations are stale. The background pass now asks
    // about the READY operation and the legacy upload too - one call for both.
    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [
      scheduled('ready-move', '2027-01-20T15:00:00Z'), scheduled('legacy-move', '2027-01-21T15:00:00Z'),
    ] } })
    __setYouTubeTransportForTests(fake.transport())
    await statusSync.runYouTubeStatusSyncPass(Date.now() + 25 * HOUR)
    assert.equal(fake.calls.length, 1)
    assert.match(fake.calls[0]!.path, /ready-move/)
    assert.match(fake.calls[0]!.path, /legacy-move/)

    const rows = await publishable(s.slug)
    assert.equal(rows.get(readyCode!).publication.scheduled_at, '2027-01-20T15:00:00Z', 'newer cached answer beats the older operation snapshot')
    assert.equal(rows.get(oldCode!).publication.scheduled_at, '2027-01-21T15:00:00Z')
  })
})

describe('an abandoned upload is a failure, never a schedule', () => {
  test('a private video YouTube abandoned processing is not counted as confirmed-scheduled', () => {
    // Domnak DM0001-DM0003, 2026-10-19: the channel was not verified for long
    // videos. videos.list answered `uploadStatus: uploaded` with a private
    // publishAt, and every cache reader took that as a schedule - so three dead
    // videos held three four-week coverage slots.
    const abandoned = cacheService.observationFromDetails('vid-abandoned', {
      uploadStatus: 'uploaded', privacyStatus: 'private', publishAt: '2026-10-20T11:00:00Z',
      processingStatus: 'failed', processingFailureReason: 'tooLong',
    }, '2026-10-19T01:22:08.842Z', 'operation', 'DM0001')
    assert.equal(abandoned.upload_status, 'failed', 'the raw word would keep it counted as live')
    const view = cacheService.publicationCacheView(
      { episode_video_links: {} }, { [CHANNEL]: { videos: { 'vid-abandoned': abandoned } } }, [], CHANNEL,
    )
    assert.deepEqual(view.schedules, [], 'a dead video is not a confirmed schedule')
    assert.equal(view.videos.find((entry: any) => entry.video_id === 'vid-abandoned')?.upload_status, 'failed')

    // A healthy scheduled video is untouched.
    const healthy = cacheService.observationFromDetails('vid-healthy', {
      uploadStatus: 'uploaded', privacyStatus: 'private', publishAt: '2026-10-22T11:00:00Z',
      processingStatus: 'succeeded',
    }, '2026-10-19T02:03:18.410Z', 'operation', 'DM0002')
    const healthyView = cacheService.publicationCacheView(
      { episode_video_links: {} }, { [CHANNEL]: { videos: { 'vid-healthy': healthy } } }, [], CHANNEL,
    )
    assert.deepEqual(healthyView.schedules.map((entry: any) => entry.video_id), ['vid-healthy'])
    assert.equal(healthy.upload_status, 'uploaded')
  })
})

describe('channel listing coverage', () => {
  function listing(fake: FakeYouTube, ids: string[], nextPageToken?: string) {
    fake.respondMatching({ method: 'GET', match: CHANNELS, body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-cache' } } }] } })
    for (let page = 0; page < (nextPageToken ? 4 : 1); page++) {
      fake.respondMatching({ method: 'GET', match: PLAYLIST, body: {
        items: ids.map(id => ({ snippet: { title: `Listed ${id}`, publishedAt: '2026-10-01T00:00:00Z', resourceId: { videoId: id } }, status: { privacyStatus: 'private' } })),
        ...(nextPageToken ? { nextPageToken } : {}),
      } })
    }
  }

  test('failed and truncated listings keep the last complete one, and mark it partial or stale', async () => {
    const s = await setup()
    let fake = new FakeYouTube()
    listing(fake, ['listed-1', 'listed-2'])
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('listed-1', '2026-11-30T15:00:00Z')] } })
    __setYouTubeTransportForTests(fake.transport())
    const refreshed = await request(app).post(`/api/projects/${s.slug}/youtube/reconcile/remote-refresh`)
    assert.equal(refreshed.status, 200)
    let view = await cacheView(s.slug)
    assert.equal(view.coverage.listing.state, 'complete')
    assert.equal(view.coverage.listing.stale, false)
    const completeAt = view.coverage.listing.complete_at
    assert.ok(completeAt)
    assert.deepEqual(view.schedules.map((entry: any) => [entry.video_id, entry.source, entry.episode_code]),
      [['listed-1', 'channel_listing', undefined]], 'observed schedule, never linked to an episode')
    const listed2 = view.videos.find((entry: any) => entry.video_id === 'listed-2')
    assert.equal(listed2.upload_status, 'not_found')

    // A failed listing: the route fails, the last success stays.
    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: CHANNELS, status: 503, body: {} })
    __setYouTubeTransportForTests(fake.transport())
    assert.notEqual((await request(app).post(`/api/projects/${s.slug}/youtube/reconcile/remote-refresh`)).status, 200)
    view = await cacheView(s.slug)
    assert.equal(view.coverage.listing.state, 'complete')
    assert.equal(view.coverage.listing.complete_at, completeAt)
    assert.equal(view.coverage.listing.last_attempt.outcome, 'failed')
    assert.equal(view.schedules.length, 1, 'observations survive a failed listing')

    // A truncated listing: partial now, the earlier complete one is still dated.
    fake = new FakeYouTube()
    listing(fake, ['listed-3'], 'more')
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
    __setYouTubeTransportForTests(fake.transport())
    const truncated = await request(app).post(`/api/projects/${s.slug}/youtube/reconcile/remote-refresh`)
    assert.equal(truncated.body.truncated, true)
    view = await cacheView(s.slug)
    assert.equal(view.coverage.listing.state, 'partial')
    assert.equal(view.coverage.listing.complete_at, completeAt)
    assert.ok(view.coverage.listing.partial_at)
    assert.ok(view.videos.some((entry: any) => entry.video_id === 'listed-1'), 'a truncated listing does not drop what earlier listings found')
    assert.equal(view.schedules[0].scheduled_for, '2026-11-30T15:00:00Z')

    // Past the TTL the complete listing and the observation both read stale.
    const later = cacheService.publicationCacheView(await publishing.readYouTubeProjectPublishingState(s.slug),
      await cacheService.readYouTubePublicationCache(s.slug), [], CHANNEL, { now: Date.now() + 25 * HOUR })
    assert.equal(later.coverage.listing.stale, true)
    assert.equal(later.schedules[0]!.stale, true)
  })
})

describe('a channel switch never mixes caches', () => {
  test('a reassigned project sees none of the previous channel’s observations, and both caches stay separate', async () => {
    const s = await setup()
    const [code, unnamed] = await s.episodes(2)
    await s.legacy(code!, 'video-on-a')
    await s.legacy(unnamed!, 'video-unnamed', null)
    let fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [
      scheduled('video-on-a', '2026-11-11T15:00:00Z'), scheduled('video-unnamed', '2026-11-12T15:00:00Z'),
    ] } })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal((await cacheView(s.slug)).schedules.length, 2)

    await grant(OTHER)
    await connections.assignProjectYouTubeChannel({ project_slug: s.slug, channel_id: OTHER, expected_previous_channel_id: CHANNEL })
    const view = await cacheView(s.slug)
    assert.equal(view.channel_id, OTHER)
    assert.deepEqual(view.schedules, [])
    const rows = await publishable(s.slug)
    assert.notEqual(rows.get(code!).publication.state, 'scheduled')
    assert.notEqual(rows.get(unnamed!).publication.state, 'scheduled', 'a receipt naming no channel is not read from channel A’s cache')
    assert.equal((await episodeStatus(s.slug, unnamed!, OTHER)).state, 'recorded')

    // On channel B, YouTube places the unnamed video elsewhere: nothing is recorded under B.
    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('video-unnamed', '2026-11-12T15:00:00Z', CHANNEL)] } })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    const raw = await s.rawCache()
    assert.deepEqual(Object.keys(raw[OTHER]?.videos ?? {}), [])
    assert.deepEqual(Object.keys(raw[CHANNEL].videos).sort(), ['video-on-a', 'video-unnamed'], 'channel A’s cache is untouched')
  })
})

describe('quota and errors never fabricate', () => {
  test('a quota stop keeps the answered batch, leaves the rest unchecked, and a later failure keeps every success', async () => {
    const s = await setup()
    const codes = await s.episodes(60)
    for (const [i, code] of codes.entries()) await s.legacy(code, `quota-${i}`)
    const items = codes.map((_, i) => scheduled(`quota-${i}`, '2026-11-15T15:00:00Z'))
    let fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items } })
    fake.respondMatching({ method: 'GET', match: VIDEOS, status: 403, body: { error: { errors: [{ reason: 'quotaExceeded' }] } } })
    __setYouTubeTransportForTests(fake.transport())
    const sync = await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal(sync.body.outcome, 'partial')
    assert.equal(sync.body.error_code, 'quota_exhausted')
    assert.equal(sync.body.legacy.checked, 50, 'the 10 in the refused call are not counted as checked')

    let view = await cacheView(s.slug)
    assert.equal(view.coverage.checked_videos, 50)
    assert.equal(view.schedules.length, 50, 'no schedule invented for the unanswered 10')
    assert.equal(view.coverage.last_refresh.outcome, 'partial')
    assert.equal(view.coverage.last_refresh.error_code, 'quota_exhausted')
    const firstChecked = view.coverage.oldest_checked_at

    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, status: 503, body: { error: { message: 'backend' } } })
    __setYouTubeTransportForTests(fake.transport())
    const failed = await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal(failed.body.outcome, 'failed')
    view = await cacheView(s.slug)
    assert.equal(view.schedules.length, 50, 'a failed refresh keeps the last success')
    assert.equal(view.coverage.oldest_checked_at, firstChecked)
    assert.equal(view.coverage.last_refresh.outcome, 'failed')
  })

  test('the background refresh is bounded: 120 stale listed videos cost two calls, the rest wait', async () => {
    const s = await setup()
    const ids = Array.from({ length: 120 }, (_, i) => `listed-${i}`)
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: CHANNELS, body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-cache' } } }] } })
    for (let page = 0; page < 3; page++) {
      fake.respondMatching({ method: 'GET', match: PLAYLIST, body: {
        items: ids.slice(page * 50, page * 50 + 50).map(id => ({ snippet: { title: id, resourceId: { videoId: id } }, status: {} })),
        ...(page < 2 ? { nextPageToken: `p${page}` } : {}),
      } })
    }
    // The listing's own detail read is refused, so all 120 stay unchecked.
    fake.respondMatching({ method: 'GET', match: VIDEOS, status: 503, body: {} })
    __setYouTubeTransportForTests(fake.transport())
    assert.equal((await request(app).post(`/api/projects/${s.slug}/youtube/reconcile/remote-refresh`)).status, 200)
    assert.equal((await cacheView(s.slug)).coverage.unchecked_videos, 120)

    const background = new FakeYouTube()
    background.respondMatching({ method: 'GET', match: VIDEOS, body: { items: ids.map(id => scheduled(id, '2026-11-16T15:00:00Z')) } })
    background.respondMatching({ method: 'GET', match: VIDEOS, body: { items: ids.map(id => scheduled(id, '2026-11-16T15:00:00Z')) } })
    __setYouTubeTransportForTests(background.transport())
    await statusSync.runYouTubeStatusSyncPass(Date.now())
    assert.equal(background.calls.length, 2)
    const view = await cacheView(s.slug)
    assert.equal(view.coverage.checked_videos, 100)
    assert.equal(view.coverage.unchecked_videos, 20)
  })
})

describe('freshness is honest', () => {
  test('overview reports the OLDER of two answers, and counts a never-checked legacy upload as unchecked', async () => {
    const s = await setup()
    const [older, newer, legacyCode] = await s.episodes(3)
    await s.readyOperation(older!, 'op-older', '2026-11-01T15:00:00Z', '2026-10-02T00:00:00.000Z')
    await s.readyOperation(newer!, 'op-newer', '2026-11-02T15:00:00Z', '2026-10-09T00:00:00.000Z')
    let overview = await request(app).get(`/api/projects/${s.slug}/youtube/overview`)
    assert.equal(overview.body.last_remote_sync_at, '2026-10-02T00:00:00.000Z', 'the oldest answer, not the newest single one')

    await s.legacy(legacyCode!, 'legacy-never-checked')
    overview = await request(app).get(`/api/projects/${s.slug}/youtube/overview`)
    assert.equal(overview.body.publication_coverage.unchecked_videos, 1, 'one fresh operation cannot make an unchecked back catalogue look current')
    assert.equal(overview.body.publication_coverage.legacy_included, true)
    // null would read as "never checked", which is false: two videos were.
    assert.equal(overview.body.last_remote_sync_at, '2026-10-02T00:00:00.000Z')
    assert.equal((await cacheView(s.slug)).videos.find((entry: any) => entry.video_id === 'legacy-never-checked').checked_at, undefined)
  })

  test('a not_found answer never freezes freshness, and Check All asks about it again', async () => {
    const s = await setup()
    const [code] = await s.episodes(1)
    // A listed video YouTube then says is not found.
    let fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: CHANNELS, body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-cache' } } }] } })
    fake.respondMatching({ method: 'GET', match: PLAYLIST, body: { items: [{ snippet: { title: 'Gone', resourceId: { videoId: 'listed-gone' } }, status: {} }] } })
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${s.slug}/youtube/reconcile/remote-refresh`)
    const goneAt = (await cacheView(s.slug)).videos[0].checked_at
    assert.ok(goneAt)

    await waitFor(() => Date.now() > Date.parse(goneAt!), { label: 'the clock to pass the not_found answer' })
    await s.legacy(code!, 'legacy-live')
    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('legacy-live', '2026-11-25T15:00:00Z')] } })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal(fake.calls.length, 1)
    assert.match(fake.calls[0]!.path, /listed-gone/, 'the deliberate check re-asks a not-found video')

    const view = await cacheView(s.slug)
    assert.equal(view.coverage.not_found_videos, 1)
    assert.equal(view.coverage.checked_videos, 1)
    assert.equal(view.coverage.stale_videos, 0)
    const liveAt = view.videos.find((entry: any) => entry.video_id === 'legacy-live').checked_at
    assert.equal(view.coverage.oldest_checked_at, liveAt, 'not the not_found answer’s time')
    assert.notEqual(view.coverage.oldest_checked_at, goneAt)
    const overview = await request(app).get(`/api/projects/${s.slug}/youtube/overview`)
    assert.equal(overview.body.last_remote_sync_at, liveAt)
  })
})

describe('the cache file', () => {
  test('an older answer arriving after a newer one does not overwrite it', async () => {
    const s = await setup()
    const write = (checkedAt: string, publishAt: string) => cacheService.recordYouTubePublicationObservations({
      project_slug: s.slug, channel_id: CHANNEL,
      checks: [{ video_id: 'raced', source: 'legacy', checked_at: checkedAt, privacy_status: 'private', scheduled_for: publishAt }],
    })
    assert.equal(await write('2026-10-10T00:00:00.000Z', '2026-12-01T15:00:00Z'), 1)
    assert.equal(await write('2026-10-01T00:00:00.000Z', '2026-11-01T15:00:00Z'), 0, 'the older answer is not kept')
    const entry = (await s.rawCache())[CHANNEL].videos.raced
    assert.equal(entry.scheduled_for, '2026-12-01T15:00:00Z')
    assert.equal(entry.checked_at, '2026-10-10T00:00:00.000Z')
  })

  test('a corrupt cache is dropped and rebuilt; project-state.json (links, removals) is untouched', async () => {
    const s = await setup()
    const [linked, removed] = await s.episodes(2)
    await publishing.linkYouTubeEpisodeVideo({
      project_slug: s.slug, episode_code: linked!, channel_id: CHANNEL, video_id: 'linked-video',
      source: 'reconcile', decided_at: '2026-10-01T00:00:00.000Z',
    })
    await publishing.recordYouTubeVideoRemoval({ project_slug: s.slug, episode_code: removed!, channel_id: CHANNEL, video_id: 'removed-video' })
    // A removed video's old observation is never served.
    await cacheService.recordYouTubePublicationObservations({
      project_slug: s.slug, channel_id: CHANNEL,
      checks: [{ video_id: 'removed-video', source: 'legacy', episode_code: removed!, checked_at: '2026-10-02T00:00:00.000Z', privacy_status: 'private', scheduled_for: '2026-11-03T15:00:00Z' }],
    })
    assert.equal((await cacheView(s.slug)).videos.some((entry: any) => entry.video_id === 'removed-video'), false)

    const statePath = path.join(s.youtubeDir(), 'project-state.json')
    const stateBefore = await fs.readFile(statePath)
    await fs.writeFile(path.join(s.youtubeDir(), 'publication-cache.json'), '{"schema_version": 1, "channels": {"UC-cache-a": ')
    const view = await cacheView(s.slug)
    assert.deepEqual(view.videos.map((entry: any) => [entry.video_id, entry.checked_at]), [['linked-video', undefined]], 'read as empty, the link is unchecked')
    assert.equal((await request(app).get(`/api/projects/${s.slug}/youtube/publishable`)).status, 200)
    assert.ok((await fs.readFile(statePath)).equals(stateBefore), 'reading a corrupt cache leaves project-state.json byte-identical')

    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('linked-video', '2026-11-09T15:00:00Z')] } })
    __setYouTubeTransportForTests(fake.transport())
    assert.equal((await request(app).post(`/api/projects/${s.slug}/youtube/sync`)).status, 200)
    assert.equal((await s.rawCache())[CHANNEL].videos['linked-video'].scheduled_for, '2026-11-09T15:00:00Z', 'rebuilt by the next answer')

    // The sync records its attempt in project-state.json as it always has; links and removals stand.
    const state = await publishing.readYouTubeProjectPublishingState(s.slug)
    assert.equal(state.episode_video_links[linked!]?.video_id, 'linked-video')
    assert.equal(state.removed_videos?.[0]?.video_id, 'removed-video')
  })

  test('the failure classifier: a local ledger fault is not an exhausted quota', () => {
    const { classifyYouTubeSyncFailure } = cacheService
    assert.equal(classifyYouTubeSyncFailure(Object.assign(new Error('quota ledger is corrupt'), { code: 'YOUTUBE_QUOTA_LEDGER_CORRUPT' })), 'provider_error')
    assert.equal(classifyYouTubeSyncFailure(Object.assign(new Error('Unable to read the quota ledger'), { code: 'YOUTUBE_QUOTA_LEDGER_IO' })), 'provider_error')
    assert.equal(classifyYouTubeSyncFailure(Object.assign(new Error('bucket'), { code: 'YOUTUBE_QUOTA_EXHAUSTED' })), 'quota_exhausted')
    assert.equal(classifyYouTubeSyncFailure(new Error('YouTube API daily quota reached. Retry after the reset.')), 'quota_exhausted')
    assert.equal(classifyYouTubeSyncFailure(new Error('videos.list failed (500): backend')), 'provider_error')
    assert.equal(classifyYouTubeSyncFailure(new Error('fetch failed')), 'offline')
  })
})

describe('round three', () => {
  test('a reassigned project’s unnamed legacy upload settles after Check All instead of staying unchecked', async () => {
    const s = await setup()
    const [code] = await s.episodes(1)
    await s.legacy(code!, 'old-channel-video', null)
    await grant(OTHER)
    await connections.assignProjectYouTubeChannel({ project_slug: s.slug, channel_id: OTHER, expected_previous_channel_id: CHANNEL })
    assert.equal((await cacheView(s.slug)).coverage.unchecked_videos, 1, 'before any check it is unknown, so unchecked')

    let fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('old-channel-video', '2026-11-04T15:00:00Z', CHANNEL)] } })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal(fake.calls.length, 1)

    fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const second = await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
    assert.equal(second.status, 200)
    assert.equal(fake.calls.length, 0, 'YouTube placed it on the old channel: not re-asked for this one')
    const view = await cacheView(s.slug)
    assert.equal(view.coverage.unchecked_videos, 0)
    assert.equal(view.videos.some((entry: any) => entry.video_id === 'old-channel-video'), false)
  })

  test('legacyUploadsFor falls back to the channel YouTube last placed an unnamed sidecar on', async () => {
    const s = await setup()
    const [onOther, onThis] = await s.episodes(2)
    await s.legacy(onOther!, 'placed-elsewhere', null)
    await s.legacy(onThis!, 'placed-here', null)
    const check = (channel_id: string) => ({ checked_at: '2026-10-02T00:00:00.000Z', upload_status: 'processed', channel_id })
    assert.equal(await sidecars.recordSidecarYouTubeCheck(s.slug, onOther!, 'placed-elsewhere', check(OTHER)), true)
    assert.equal(await sidecars.recordSidecarYouTubeCheck(s.slug, onThis!, 'placed-here', check(CHANNEL)), true)
    assert.deepEqual([...(await cacheService.legacyUploadsFor(s.slug, CHANNEL)).keys()], ['placed-here'])
  })

  test('an IO error reading the cache fails the write instead of overwriting the cache, and the read throws too (only ENOENT is empty)', async () => {
    const s = await setup()
    const write = (videoId: string) => cacheService.recordYouTubePublicationObservations({
      project_slug: s.slug, channel_id: CHANNEL,
      checks: [{ video_id: videoId, source: 'legacy', checked_at: new Date().toISOString(), privacy_status: 'private', scheduled_for: '2026-11-08T15:00:00Z' }],
    })
    await write('kept-video')
    const file = path.join(s.youtubeDir(), 'publication-cache.json')
    await fs.chmod(file, 0o000)
    try {
      await assert.rejects(() => write('new-video'), (error: any) => error.code === 'EACCES')
      await assert.rejects(() => cacheService.readYouTubePublicationCache(s.slug), (error: any) => error.code === 'EACCES')
      const overview = await request(app).get(`/api/projects/${s.slug}/youtube/overview`)
      assert.equal(overview.status, 200, 'the overview degrades instead of failing')
    } finally {
      await fs.chmod(file, 0o600)
    }
    assert.deepEqual(Object.keys((await s.rawCache())[CHANNEL].videos), ['kept-video'], 'the earlier answers survived')
  })

  test('an unreadable cache never fails Check All: YouTube is asked and the sidecars still update', async () => {
    const s = await setup()
    const [code] = await s.episodes(1)
    await s.legacy(code!, 'io-video')
    await cacheService.recordYouTubePublicationObservations({ project_slug: s.slug, channel_id: CHANNEL, checks: [] })
    const file = path.join(s.youtubeDir(), 'publication-cache.json')
    await fs.chmod(file, 0o000)
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [scheduled('io-video', scheduleAt(1))] } })
    __setYouTubeTransportForTests(fake.transport())
    try {
      const sync = await request(app).post(`/api/projects/${s.slug}/youtube/sync`)
      assert.equal(sync.status, 200, 'the check itself does not depend on the cache')
      assert.deepEqual(sync.body.legacy, { checked: 1, processed: 1, not_found: 0 })
      assert.equal(sync.body.publication_cache.recorded, 0, 'the cache write failed and was skipped')
    } finally {
      await fs.chmod(file, 0o600)
    }
  })

  test('a cache written by a newer build is refused, never read as empty and overwritten', async () => {
    const s = await setup()
    await cacheService.recordYouTubePublicationObservations({ project_slug: s.slug, channel_id: CHANNEL, checks: [] })
    const file = path.join(s.youtubeDir(), 'publication-cache.json')
    const newer = JSON.stringify({ schema_version: 2, channels: { [CHANNEL]: { videos: { future: { shape: 'unknown' } } } } })
    await fs.writeFile(file, newer)
    await assert.rejects(() => cacheService.readYouTubePublicationCache(s.slug), /newer/)
    await assert.rejects(() => cacheService.recordYouTubePublicationObservations({
      project_slug: s.slug, channel_id: CHANNEL,
      checks: [{ video_id: 'v', source: 'legacy', checked_at: new Date().toISOString(), privacy_status: 'private' }],
    }), /newer/)
    assert.equal(await fs.readFile(file, 'utf-8'), newer, 'the newer cache is untouched')
  })

  test('overview and the read API survive a failed legacy sweep and say legacy uploads were not counted', async () => {
    const s = await setup()
    await s.readyOperation((await s.episodes(1))[0]!, 'op-only', '2026-11-01T15:00:00Z')
    // ideas.json whose `ideas` is not a list: getIdeas throws inside the sweep.
    await fs.writeFile(path.join(pm.getProjectDir(s.slug)!, 'ideas.json'), JSON.stringify({ ideas: { broken: true } }))
    const overview = await request(app).get(`/api/projects/${s.slug}/youtube/overview`)
    assert.equal(overview.status, 200)
    assert.equal(overview.body.publication_coverage.legacy_included, false)
    assert.equal(overview.body.publication_coverage.checked_videos, 1)
    const view = await cacheView(s.slug)
    assert.equal(view.coverage.legacy_included, false)
  })
})
