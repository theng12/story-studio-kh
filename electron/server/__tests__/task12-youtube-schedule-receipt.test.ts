import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

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

const CHANNEL = 'UC-task12-schedule'
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  youtube.__resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

async function acceptedScheduledVideo(): Promise<{
  slug: string
  episodeCode: string
  operationId: string
}> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const project = await projects.createProject({ name: 'Task 12 schedule receipt' })
  await connections.configureYouTubeApplication({
    client_id: 'task12-client',
    client_secret: 'task12-client-secret-value',
  })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Task 12 Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'task12-access-token-value',
      refresh_token: 'task12-refresh-token-value',
      expires_at: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug,
    channel_id: CHANNEL,
    expected_previous_channel_id: null,
  })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'A durable schedule', logline: '', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'task12-test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id)
  const episodeCode = accepted.idea.episode_code!
  const created = await operations.createYouTubeOperation({
    project_slug: project.slug,
    episode_code: episodeCode,
    channel_id: CHANNEL,
    source_revision: 'source-task12',
    metadata_revision: 'metadata-task12',
    origin: 'manual',
    final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: project.slug,
    operation_id: created.operation_id,
    expected_revision: created.revision,
    channel_id: CHANNEL,
    video_id: 'video-task12-schedule',
    accepted_at: new Date().toISOString(),
    final_payload: {
      snippet_json: JSON.stringify({ title: accepted.idea.title, description: '', tags: [], categoryId: '24' }),
      status_json: JSON.stringify({ privacyStatus: 'private' }),
      source_sha256: 'a'.repeat(64),
    },
  })
  return { slug: project.slug, episodeCode, operationId: created.operation_id }
}

function queueSchedule(fake: FakeYouTube, publishAt: string): void {
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status&id=video-task12-schedule',
    body: { items: [{
      id: 'video-task12-schedule', etag: 'task12-etag',
      snippet: { title: 'A durable schedule', description: '', tags: [], categoryId: '24' },
      status: { privacyStatus: 'private' },
    }] },
  })
  fake.respond({
    method: 'PUT',
    path: '/youtube/v3/videos?part=status',
    body: { id: 'video-task12-schedule', status: { privacyStatus: 'private', publishAt } },
  })
}

test('provider schedule success is reported as unrecorded and a retry durably converges', async () => {
  // Break caught: YouTube has accepted the schedule before the operation
  // checkpoint runs. Reporting a generic failure makes the provider truth and
  // local truth indistinguishable, while giving no proven recovery path.
  const { slug, episodeCode, operationId } = await acceptedScheduledVideo()
  const publishAt = new Date(Date.now() + 86_400_000).toISOString()
  const first = new FakeYouTube()
  queueSchedule(first, publishAt)
  youtube.__setYouTubeTransportForTests(first.transport())

  const operationDir = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'operations',
  )
  const realRename = fs.rename
  ;(fs as any).rename = async (from: any, to: any) => {
    if (String(to).startsWith(operationDir)) {
      throw Object.assign(new Error('injected operation checkpoint failure'), { code: 'EACCES' })
    }
    return realRename(from, to)
  }
  let unrecorded: any
  try {
    unrecorded = await request(app)
      .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
      .send({ publish_at: publishAt, confirm: true, expected_channel_id: CHANNEL })
  } finally {
    ;(fs as any).rename = realRename
  }

  assert.equal(unrecorded.status, 503, JSON.stringify(unrecorded.body))
  assert.equal(unrecorded.body.code, 'YOUTUBE_SCHEDULE_RECEIPT_UNRECORDED')
  assert.match(unrecorded.body.detail, /YouTube accepted.*Retry this same date and time/i)
  assert.equal(unrecorded.body.scheduled_at, publishAt)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined)

  const retry = new FakeYouTube()
  queueSchedule(retry, publishAt)
  youtube.__setYouTubeTransportForTests(retry.transport())
  const recovered = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: publishAt, confirm: true, expected_channel_id: CHANNEL })

  assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
  assert.equal(recovered.body.code, undefined)
  assert.equal(
    (await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot?.scheduled_for,
    publishAt,
  )
})
