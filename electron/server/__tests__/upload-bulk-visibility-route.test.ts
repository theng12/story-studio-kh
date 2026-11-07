import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

// Set visibility (Public / Unlisted / Private) for one uploaded video — the
// route the Publish page's bulk "Set visibility" calls once per row. Every
// YouTube answer is queued on a fake transport; nothing reaches the network.

const boot = await useTempDataDir()
const youtube = await import('../lib/youtube-client.js')
const connections = await import('../services/youtube-connection-store.js')
const operations = await import('../services/youtube-operation-store.js')
const projects = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

const CHANNEL = 'UC-bulk-visibility'
const VIDEO = 'video-bulk-visibility'
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  youtube.__resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

async function uploadedVideo(): Promise<{ slug: string; episodeCode: string; operationId: string }> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const project = await projects.createProject({ name: 'Bulk visibility' })
  await connections.configureYouTubeApplication({ client_id: 'bulk-client', client_secret: 'bulk-client-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Bulk Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'bulk-access-token-value',
      refresh_token: 'bulk-refresh-token-value',
      expires_at: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'A bulk visibility story', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'bulk-test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id)
  const episodeCode = accepted.idea.episode_code!
  const created = await operations.createYouTubeOperation({
    project_slug: project.slug, episode_code: episodeCode, channel_id: CHANNEL,
    source_revision: 'source-bulk', metadata_revision: 'metadata-bulk', origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: project.slug, operation_id: created.operation_id, expected_revision: created.revision,
    channel_id: CHANNEL, video_id: VIDEO, accepted_at: new Date().toISOString(),
    final_payload: {
      snippet_json: JSON.stringify({ title: accepted.idea.title, description: '', tags: [], categoryId: '24' }),
      status_json: JSON.stringify({ privacyStatus: 'private' }),
      source_sha256: 'a'.repeat(64),
    },
  })
  return { slug: project.slug, episodeCode, operationId: created.operation_id }
}

function queueVisibility(fake: FakeYouTube, live: Record<string, unknown>, answer: Record<string, unknown>): void {
  fake.respond({
    method: 'GET',
    path: `/youtube/v3/videos?part=snippet,status&id=${VIDEO}`,
    body: { items: [{
      id: VIDEO, etag: 'bulk-etag',
      snippet: { title: 'A bulk visibility story', description: '', tags: [], categoryId: '24' },
      status: live,
    }] },
  })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: { id: VIDEO, status: answer } })
}

test('refuses without confirmation, a channel, or a real visibility — and sends nothing to YouTube', async () => {
  const { slug, episodeCode } = await uploadedVideo()
  const fake = new FakeYouTube()
  youtube.__setYouTubeTransportForTests(fake.transport())
  const url = `/api/projects/${slug}/youtube/episodes/${episodeCode}/visibility`

  const unconfirmed = await request(app).post(url).send({ privacy_status: 'public', expected_channel_id: CHANNEL })
  assert.equal(unconfirmed.status, 400)
  assert.equal(unconfirmed.body.code, 'YOUTUBE_CONFIRMATION_REQUIRED')

  const noChannel = await request(app).post(url).send({ privacy_status: 'public', confirm: true })
  assert.equal(noChannel.status, 400)

  const bogus = await request(app).post(url).send({ privacy_status: 'friends-only', confirm: true, expected_channel_id: CHANNEL })
  assert.equal(bogus.status, 400)
  assert.match(bogus.body.detail, /Public, Unlisted or Private/)

  const otherChannel = await request(app).post(url).send({ privacy_status: 'public', confirm: true, expected_channel_id: 'UC-someone-else' })
  assert.equal(otherChannel.status, 409)
  assert.equal(otherChannel.body.code, 'YOUTUBE_CHANNEL_CHANGED')

  assert.deepEqual(fake.calls, [], 'no refused request reached YouTube')
})

test('making a scheduled video public clears its publish time and records what YouTube confirmed', async () => {
  const { slug, episodeCode, operationId } = await uploadedVideo()
  const fake = new FakeYouTube()
  queueVisibility(fake,
    { privacyStatus: 'private', publishAt: new Date(Date.now() + 86_400_000).toISOString() },
    { privacyStatus: 'public' })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/visibility`)
    .send({ privacy_status: 'public', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.privacy_status, 'public')
  assert.equal(res.body.scheduled_at, null)
  const sent = JSON.parse(fake.calls.find(call => call.method === 'PUT')!.body!)
  assert.equal(sent.status.privacyStatus, 'public')
  assert.equal('publishAt' in sent.status, false, 'a pending schedule would still flip the video later')
  const snapshot = (await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot
  assert.equal(snapshot?.privacy_status, 'public')
  assert.equal(snapshot?.scheduled_for, null)
})

test('a YouTube answer that does not match the request is not recorded as done', async () => {
  const { slug, episodeCode, operationId } = await uploadedVideo()
  const fake = new FakeYouTube()
  queueVisibility(fake, { privacyStatus: 'private' }, { privacyStatus: 'private' })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/visibility`)
    .send({ privacy_status: 'unlisted', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 502)
  assert.match(res.body.detail, /did not confirm .* as unlisted/)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined)
})

test('unscheduling omits publishAt from the updated status part and records provider-confirmed removal', async () => {
  const { slug, episodeCode, operationId } = await uploadedVideo()
  const scheduledTime = new Date(Date.now() + 86_400_000).toISOString()
  const fake = new FakeYouTube()
  queueVisibility(fake,
    { privacyStatus: 'private', publishAt: scheduledTime },
    { privacyStatus: 'private', publishAt: null })
  youtube.__setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/visibility`)
    .send({ privacy_status: 'private', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.scheduled_at, null)

  const putCall = fake.calls.find(call => call.method === 'PUT')
  assert.ok(putCall, 'expected a PUT request to YouTube')
  const sent = JSON.parse(putCall.body!)
  assert.equal(sent.status.privacyStatus, 'private')
  // https://developers.google.com/youtube/v3/docs/videos/update: omitted properties in an updated part are deleted.
  assert.equal(Object.hasOwn(sent.status, 'publishAt'), false)
  // This fixture checks the documented request contract, not the cause of EP0039's original 502.

  const snapshot = (await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot
  assert.equal(snapshot?.privacy_status, 'private')
  assert.equal(snapshot?.scheduled_for, null)
})
