/**
 * A connected YouTube channel's title, handle and thumbnail belong to YouTube:
 * the owner can rename a channel or change its picture at any time, and Story
 * Studio used to freeze whatever it saw at connect. These are the cases that
 * keep them current.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'

const boot = await useTempDataDir()
const store = await import('../services/youtube-connection-store.js')
const { createProject } = await import('../services/project-manager.js')
const { router } = await import('../routes/youtube-connections.js')
const youtube = await import('../lib/youtube-client.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

const CHANNEL_ID = 'UC_details_channel'
const CLIENT_ID = 'details-client-id'
const CLIENT_SECRET = 'details-client-secret'
const CHANNELS_CALL = /\/youtube\/v3\/channels\?/

let cleanup: (() => Promise<void>) | undefined
const realFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = realFetch
  youtube.__resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

async function isolate(): Promise<void> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
}

async function connectChannel(title: string, expiresAt = Date.now() + 3_600_000): Promise<void> {
  await store.configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  await saveYouTubeChannelGrantForTest({
    channel: {
      channel_id: CHANNEL_ID,
      title,
      handle: '@old-handle',
      thumbnail_url: 'https://img.test/old.jpg',
      granted_scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    },
    tokens: { access_token: 'details-access', refresh_token: 'details-refresh', expires_at: expiresAt },
  })
}

/** Make the channel look like it was last checked a week ago. */
async function ageChannel(): Promise<void> {
  const file = store.youtubeConnectionsPath()
  const registry = JSON.parse(await fs.readFile(file, 'utf8'))
  registry.channels[CHANNEL_ID].details_checked_at = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await fs.writeFile(file, JSON.stringify(registry, null, 2))
}

function channelDetails(title: string): Record<string, unknown> {
  return {
    items: [{
      id: CHANNEL_ID,
      snippet: {
        title,
        customUrl: '@new-handle',
        thumbnails: { default: { url: 'https://img.test/new.jpg' } },
      },
    }],
  }
}

test('a channel renamed on YouTube shows its new name, handle and thumbnail', async () => {
  await isolate()
  await connectChannel('Old Name')
  await ageChannel()

  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: CHANNELS_CALL, body: channelDetails('New Name') })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const res = await request(app).get('/api/youtube/connections')
  assert.equal(res.status, 200)
  const channel = res.body.channels.find((row: { channel_id: string }) => row.channel_id === CHANNEL_ID)
  assert.equal(channel.title, 'New Name')
  assert.equal(channel.handle, '@new-handle')
  assert.equal(channel.thumbnail_url, 'https://img.test/new.jpg')
  // The channel id is the identity: the read named that channel, not "mine".
  assert.match(fake.calls[0].path, /id=UC_details_channel/)
})

test('a failed read keeps the saved name and still lists the connections', async () => {
  await isolate()
  await connectChannel('Old Name')
  await ageChannel()

  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: CHANNELS_CALL, status: 500, body: { error: 'backend_error' } })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const res = await request(app).get('/api/youtube/connections')
  assert.equal(res.status, 200)
  const channel = res.body.channels.find((row: { channel_id: string }) => row.channel_id === CHANNEL_ID)
  assert.equal(channel.title, 'Old Name')
  assert.equal(channel.handle, '@old-handle')
  assert.equal(channel.thumbnail_url, 'https://img.test/old.jpg')
})

test('a rename never moves the project assignment', async () => {
  await isolate()
  await connectChannel('Old Name')
  const project = await createProject({ name: 'Details Assignment' })
  await request(app)
    .put(`/api/projects/${project.slug}/youtube/assignment`)
    .send({ channel_id: CHANNEL_ID, expected_previous_channel_id: null })
  await ageChannel()

  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: CHANNELS_CALL, body: channelDetails('New Name') })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const res = await request(app).get('/api/youtube/connections')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.assignments.map((row: { channel_id: string }) => row.channel_id), [CHANNEL_ID])
  const channel = res.body.channels.find((row: { channel_id: string }) => row.channel_id === CHANNEL_ID)
  assert.equal(channel.title, 'New Name')
  assert.equal(channel.assigned_project_slug, project.slug)
})

test('a channel is not re-read again within the day', async () => {
  await isolate()
  await connectChannel('Old Name')
  await ageChannel()

  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: CHANNELS_CALL, body: channelDetails('New Name') })
  fake.respondMatching({ method: 'GET', match: CHANNELS_CALL, body: channelDetails('Newer Name') })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const first = await request(app).get('/api/youtube/connections')
  assert.equal(first.status, 200)
  const second = await request(app).get('/api/youtube/connections')
  assert.equal(second.status, 200)

  assert.equal(fake.calls.length, 1, 'the second read did not ask YouTube again')
  const channel = second.body.channels.find((row: { channel_id: string }) => row.channel_id === CHANNEL_ID)
  assert.equal(channel.title, 'New Name')
})

test('a refreshed access token re-reads the channel name', async () => {
  await isolate()
  await connectChannel('Old Name', Date.now() - 1000)
  const project = await createProject({ name: 'Details Refresh' })
  await store.assignProjectYouTubeChannel({
    project_slug: project.slug,
    channel_id: CHANNEL_ID,
    expected_previous_channel_id: null,
  })

  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch

  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: CHANNELS_CALL, body: channelDetails('Refreshed Name') })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const token = await youtube.getValidAccessToken(project.slug, youtube.registryCredentialFor(CHANNEL_ID))
  assert.equal(token, 'fresh-access')
  const channel = (await store.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!
  assert.equal(channel.title, 'Refreshed Name')
})
