/**
 * GET/PUT `/projects/:slug/youtube/channel-settings` — the authoritative,
 * assignment-pinned channel settings surface (Item 20).
 *
 * Covers the states the component must tell apart: no channel assigned
 * (honest 200), a stale or foreign account identity (409), a playlist that
 * does not belong to the assigned channel (400, config untouched), YouTube
 * itself failing (502, never folded into "no connection"), and two saves
 * racing without losing either write.
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'

// Imported once (module state is bound at import time), then every test gets
// its OWN temp data dir through isolate() below — same pattern as
// youtube-connections-route.test.ts.
const boot = await useTempDataDir()
const store = await import('../services/youtube-connection-store.js')
const pm = await import('../services/project-manager.js')
const { router } = await import('../routes/youtube-channel-settings.js')
const { _resetPlaylistCacheForTesting } = await import('../services/upload-playlists.js')
const { __setYouTubeTransportForTests, __resetYouTubeTransportForTests } = await import('../lib/youtube-client.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

const CHANNEL_ID = 'UC-route-channel-settings'
const ACCOUNT_ID = `registry:${CHANNEL_ID}`
const PLAYLISTS_PATH = '/youtube/v3/playlists?part=snippet%2Cstatus%2CcontentDetails&mine=true&maxResults=50'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  __resetYouTubeTransportForTests()
  _resetPlaylistCacheForTesting()
})

async function isolate(): Promise<void> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
}

/** A fresh install with an owner application, a connected channel, and a project assigned to it. */
async function connectedProject(): Promise<string> {
  await isolate()
  await store.configureYouTubeApplication({ client_id: 'channel-settings-route-client', client_secret: '{{SECRET_9b3xqp2m}}' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL_ID, title: 'Settings Route', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'route-settings-access',
      refresh_token: 'route-settings-refresh',
      expires_at: Date.now() + 3_600_000,
    },
  })
  const project = await pm.createProject({ name: 'ChannelSettingsRoute' })
  await store.assignProjectYouTubeChannel({
    project_slug: project.slug,
    channel_id: CHANNEL_ID,
    expected_previous_channel_id: null,
  })
  return project.slug
}

/** A fresh install with a project and NO channel assignment. */
async function unassignedProject(): Promise<string> {
  await isolate()
  const project = await pm.createProject({ name: 'ChannelSettingsNoChannel' })
  return project.slug
}

function queuePlaylists(fake: FakeYouTube = new FakeYouTube()): FakeYouTube {
  fake.respond({
    method: 'GET',
    path: PLAYLISTS_PATH,
    body: {
      items: [
        { id: 'PL_SERIES_A', snippet: { title: 'Series A', description: '' }, status: { privacyStatus: 'public' }, contentDetails: { itemCount: 4 } },
        { id: 'PL_SLEEP', snippet: { title: 'Sleep', description: '' }, status: { privacyStatus: 'private' }, contentDetails: { itemCount: 9 } },
      ],
    },
  })
  return fake
}

async function defaultPlaylistMap(slug: string): Promise<Record<string, string>> {
  const config = (await pm.getConfig(slug)) as any
  return config?.youtube_default_playlist ?? {}
}

test('GET with no assigned channel answers the honest no-account state, not an error', async () => {
  const slug = await unassignedProject()
  const res = await request(app).get(`/api/projects/${slug}/youtube/channel-settings`)
  assert.equal(res.status, 200)
  assert.equal(res.body.channel_id, null)
  assert.equal(res.body.inventory.has_connected_account, false)
  assert.equal(res.body.inventory.account_id, '')
  assert.deepEqual(res.body.inventory.playlists, [])
  assert.equal(res.body.end_screen_capabilities.remote_api_supported, false)
  assert.ok(res.body.end_screen, 'the local plan still reads back')
})

test('GET is pinned to the assigned channel and serves its playlist inventory', async () => {
  const slug = await connectedProject()
  __setYouTubeTransportForTests(queuePlaylists().transport())

  const res = await request(app).get(`/api/projects/${slug}/youtube/channel-settings`)
  assert.equal(res.status, 200)
  assert.equal(res.body.channel_id, CHANNEL_ID)
  assert.equal(res.body.inventory.account_id, ACCOUNT_ID)
  assert.equal(res.body.inventory.has_connected_account, true)
  assert.equal(res.body.inventory.count, 2)
  assert.equal(res.body.inventory.playlists[0].id, 'PL_SERIES_A')
})

test('GET rejects a stale or foreign account_id instead of honouring it', async () => {
  const slug = await connectedProject()
  __setYouTubeTransportForTests(queuePlaylists().transport())

  const res = await request(app)
    .get(`/api/projects/${slug}/youtube/channel-settings?account_id=registry:UC-someone-else`)
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_CHANNEL_MISMATCH')
})

test('GET surfaces a YouTube failure as 502, distinct from the no-account state', async () => {
  const slug = await connectedProject()
  const fake = new FakeYouTube()
  fake.rejectNext({
    method: 'GET',
    path: PLAYLISTS_PATH,
    status: 503,
    body: { error: { message: 'backend unavailable' } },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).get(`/api/projects/${slug}/youtube/channel-settings`)
  assert.equal(res.status, 502)
  assert.match(res.body.detail ?? '', /YouTube could not list playlists/)
  assert.equal(res.body.has_connected_account, undefined, 'not shaped like the no-account state')
})

test('PUT refuses a playlist that is not on the assigned channel and leaves config untouched', async () => {
  const slug = await connectedProject()
  __setYouTubeTransportForTests(queuePlaylists().transport())

  const res = await request(app)
    .put(`/api/projects/${slug}/youtube/channel-settings`)
    .send({ expected_account_id: ACCOUNT_ID, default_playlist_id: 'PL_NOT_ON_THIS_CHANNEL' })
  assert.equal(res.status, 400)
  assert.match(res.body.detail ?? '', /not a playlist on the assigned YouTube channel/)
  assert.deepEqual(await defaultPlaylistMap(slug), {}, 'no partial write')
})

test('PUT refuses a stale expected_account_id and leaves config untouched', async () => {
  const slug = await connectedProject()
  __setYouTubeTransportForTests(queuePlaylists().transport())

  const res = await request(app)
    .put(`/api/projects/${slug}/youtube/channel-settings`)
    .send({ expected_account_id: 'registry:UC-someone-else', default_playlist_id: 'PL_SERIES_A' })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_CHANNEL_MISMATCH')
  assert.deepEqual(await defaultPlaylistMap(slug), {})
})

test('PUT refuses a playlist without any channel assignment', async () => {
  const slug = await unassignedProject()
  const res = await request(app)
    .put(`/api/projects/${slug}/youtube/channel-settings`)
    .send({ expected_account_id: '', default_playlist_id: 'PL_ANY' })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_CHANNEL_NOT_ASSIGNED')
})

test('PUT saves the local end-screen plan without a channel and reads it back', async () => {
  const slug = await unassignedProject()
  const res = await request(app)
    .put(`/api/projects/${slug}/youtube/channel-settings`)
    .send({ expected_account_id: '', default_playlist_id: '', end_screen: { duration_seconds: 7 } })
  assert.equal(res.status, 200)
  assert.equal(res.body.end_screen.duration_seconds, 7)
  assert.equal(res.body.inventory.has_connected_account, false)

  const reread = await request(app).get(`/api/projects/${slug}/youtube/channel-settings`)
  assert.equal(reread.status, 200)
  assert.equal(reread.body.end_screen.duration_seconds, 7)
})

test('PUT surfaces a YouTube failure as 502 and writes nothing', async () => {
  const slug = await connectedProject()
  const fake = new FakeYouTube()
  fake.rejectNext({
    method: 'GET',
    path: PLAYLISTS_PATH,
    status: 503,
    body: { error: { message: 'backend unavailable' } },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .put(`/api/projects/${slug}/youtube/channel-settings`)
    .send({
      expected_account_id: ACCOUNT_ID,
      default_playlist_id: 'PL_SERIES_A',
      end_screen: { duration_seconds: 11 },
    })
  assert.equal(res.status, 502)
  assert.match(res.body.detail ?? '', /YouTube could not list playlists/)
  assert.deepEqual(await defaultPlaylistMap(slug), {}, 'membership could not be proven, so nothing was written')
})

test('concurrent PUTs keep each request\'s playlist and plan together', async () => {
  const slug = await connectedProject()
  const fake = queuePlaylists()
  queuePlaylists(fake)
  __setYouTubeTransportForTests(fake.transport())

  // Two whole-settings saves racing. Each writes playlist AND plan inside one
  // config lock, so the surviving pair must be one request's own pair — never
  // a mix — and neither playlist write may vanish behind the other.
  const [first, second] = await Promise.all([
    request(app)
      .put(`/api/projects/${slug}/youtube/channel-settings`)
      .send({
        expected_account_id: ACCOUNT_ID,
        default_playlist_id: 'PL_SERIES_A',
        end_screen: { duration_seconds: 7 },
      }),
    request(app)
      .put(`/api/projects/${slug}/youtube/channel-settings`)
      .send({
        expected_account_id: ACCOUNT_ID,
        default_playlist_id: 'PL_SLEEP',
        end_screen: { duration_seconds: 15 },
      }),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)

  const config = (await pm.getConfig(slug)) as any
  const playlist = config.youtube_default_playlist?.[ACCOUNT_ID]
  const duration = config.youtube_end_screen?.duration_seconds
  assert.ok(playlist === 'PL_SERIES_A' || playlist === 'PL_SLEEP', `a playlist write was lost: ${playlist}`)
  const expectedDuration = playlist === 'PL_SERIES_A' ? 7 : 15
  assert.equal(
    duration,
    expectedDuration,
    `torn write: playlist ${playlist} paired with plan ${duration} instead of ${expectedDuration}`,
  )
})
