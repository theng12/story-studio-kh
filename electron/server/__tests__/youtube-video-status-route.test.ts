/**
 * Read-only video status for videos this project has no operation record for.
 *
 * The need came from production: legacy uploads (Boundful EP62-72, Story
 * Sprout SS57-60, the channel TN160-161) went up before the operation store
 * existed, so no per-operation route can reach them and their state could only
 * be read by hand in YouTube Studio. This is the bounded, read-only way to ask.
 *
 * The five things asserted here are the five the request names: the happy path,
 * a video owned by a DIFFERENT channel (which must never read as ours), an id
 * YouTube does not return, more than 50 ids, and an unassigned project.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { __resetYouTubeTransportForTests, __setYouTubeTransportForTests } from '../lib/youtube-client.js'
import { createProject } from '../services/project-manager.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'
import { router } from '../routes/youtube-upload-center.js'

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const CHANNEL = 'UC-video-status'
const OUR_VIDEO = 'aaaaaaaaaaa'
const FOREIGN_VIDEO = 'bbbbbbbbbbb'
const MISSING_VIDEO = 'ccccccccccc'
const detailsPath = (ids: string[]) => `/youtube/v3/videos?part=snippet,status,processingDetails&id=${ids.join(',')}`

async function setup(assign: boolean): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: `Video Status ${Math.random()}` })
  if (assign) {
    await configureYouTubeApplication({ client_id: 'vs-client', client_secret: 'vs-secret' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Video Status Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'vs-access', refresh_token: 'vs-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null })
  }
  return project.slug
}

test('reports each video: ours, a foreign channel’s, and one YouTube does not return', async () => {
  const slug = await setup(true)
  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: detailsPath([OUR_VIDEO, FOREIGN_VIDEO, MISSING_VIDEO]),
    body: {
      items: [
        {
          id: OUR_VIDEO,
          snippet: { channelId: CHANNEL },
          status: { uploadStatus: 'processed', privacyStatus: 'public' },
          processingDetails: { processingStatus: 'succeeded' },
        },
        {
          id: FOREIGN_VIDEO,
          snippet: { channelId: 'UC-someone-else' },
          status: { uploadStatus: 'processed', privacyStatus: 'private' },
        },
      ],
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/video-status`)
    .send({ video_ids: [OUR_VIDEO, FOREIGN_VIDEO, MISSING_VIDEO] })

  assert.equal(res.status, 200)
  assert.equal(typeof res.body.checked_at, 'string', 'the answer says WHEN it was read')
  const [ours, foreign, missing] = res.body.videos
  assert.deepEqual(ours, {
    video_id: OUR_VIDEO,
    found: true,
    channel_id: CHANNEL,
    matches_assigned_channel: true,
    upload_status: 'processed',
    processing_status: 'succeeded',
    privacy_status: 'public',
    publish_at: null,
  })
  assert.equal(foreign.found, true)
  assert.equal(foreign.channel_id, 'UC-someone-else')
  assert.equal(foreign.matches_assigned_channel, false, 'a stranger’s video is never counted as this project’s')
  assert.deepEqual(missing, {
    video_id: MISSING_VIDEO,
    found: false,
    channel_id: null,
    matches_assigned_channel: false,
    upload_status: null,
    processing_status: null,
    privacy_status: null,
    publish_at: null,
  })
  // One batched GET, and nothing else: strictly read-only.
  assert.deepEqual(fake.calls.map(call => call.method), ['GET'])
})

test('more than 50 ids is refused before any YouTube call', async () => {
  const slug = await setup(true)
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const ids = Array.from({ length: 51 }, (_, index) => String(index).padStart(11, '0'))
  const res = await request(app).post(`/api/projects/${slug}/youtube/video-status`).send({ video_ids: ids })

  assert.equal(res.status, 400)
  assert.equal(fake.calls.length, 0, 'a refused request must not reach YouTube')
})

test('an unassigned project is refused with a 409 in plain words', async () => {
  const slug = await setup(false)

  const res = await request(app).post(`/api/projects/${slug}/youtube/video-status`).send({ video_ids: [OUR_VIDEO] })

  assert.equal(res.status, 409)
  assert.match(res.body.detail, /Assign a YouTube channel/)
})
