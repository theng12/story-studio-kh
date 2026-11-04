import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test, mock } from 'node:test'
import { previousYouTubeThumbnail, thumbnailImageUrl } from '../services/youtube-thumbnail-state.js'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { __resetYouTubeTransportForTests, __setYouTubeTransportForTests } from '../lib/youtube-client.js'
import { generateThumbnailRefresh } from '../generators/youtube-thumbnail-refresh.js'
import { createProject } from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'
import { acceptYouTubeOperation, createYouTubeOperation, readYouTubeOperation } from '../services/youtube-operation-store.js'

let cleanup: (() => Promise<void>) | undefined
const CHANNEL = 'UC-thumbnail'
const PNG = await (await import('sharp')).default({ create: { width: 16, height: 9, channels: 3, background: '#244c5a' } }).png().toBuffer()

async function setup() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Canonical Thumbnail' })
  const projectDir = path.join(temp.dir, 'projects', project.slug)
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', episode_code: 'EP0001', title: 'Episode One', status: 'accepted' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const paths = await resolveEpisodePaths(project.slug, 'EP0001', 'Episode One')
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, 'EP0001_Thumbnail_v1.png'), PNG)

  await configureYouTubeApplication({ client_id: 'thumbnail-client', client_secret: 'thumbnail-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Thumbnail Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'thumbnail-access', refresh_token: 'thumbnail-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null })
  const payload = {
    snippet_json: JSON.stringify({ title: 'Episode One', description: '', tags: [], categoryId: '24' }),
    status_json: JSON.stringify({ privacyStatus: 'private' }),
    source_sha256: 'a'.repeat(64),
  }
  const opened = await createYouTubeOperation({
    project_slug: project.slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'source-1', metadata_revision: 'metadata-1', final_payload: payload,
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await acceptYouTubeOperation({
    project_slug: project.slug, operation_id: opened.operation_id, expected_revision: opened.revision,
    channel_id: CHANNEL, video_id: 'video-1', accepted_at: new Date().toISOString(), final_payload: payload,
  })
  return { slug: project.slug, operationId: accepted.operation_id }
}

function remoteThumbnail(privacy = 'public') {
  return { items: [{ id: 'video-1', snippet: { channelId: CHANNEL, thumbnails: { high: { url: 'https://i.ytimg.com/vi/video-1/hqdefault.jpg' } } }, status: { privacyStatus: privacy, publishAt: '2027-01-01T00:00:00Z' } }] }
}
function reads(fake: FakeYouTube, count = 2) {
  for (let i = 0; i < count; i++) fake.respondMatching({ method: 'GET', match: /\/youtube\/v3\/videos\?/, body: remoteThumbnail() })
  mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    assert.equal(String(input), 'https://i.ytimg.com/vi/video-1/hqdefault.jpg')
    assert.equal(init.redirect, 'error')
    return new Response(PNG, { status: 200 })
  })
}

afterEach(async () => {
  mock.restoreAll()
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

test('thumbnail backup URLs reject arbitrary hosts, credentials, redirects and non-HTTPS origins', () => {
  for (const url of ['http://i.ytimg.com/a.jpg', 'https://localhost/a.jpg', 'https://i.ytimg.com.evil.test/a.jpg', 'https://user@i.ytimg.com/a.jpg', 'https://i.ytimg.com:8443/a.jpg']) {
    assert.throws(() => thumbnailImageUrl(url))
  }
  assert.equal(thumbnailImageUrl('https://i.ytimg.com/vi/video-1/hqdefault.jpg'), 'https://i.ytimg.com/vi/video-1/hqdefault.jpg')
})

test('a canonical operation with no legacy sidecar can update its thumbnail', async () => {
  const { slug, operationId } = await setup()
  const fake = new FakeYouTube()
  reads(fake)
  fake.respond({ method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-1', body: { items: [] } })
  __setYouTubeTransportForTests(fake.transport())
  const job = {
    job_id: 'thumb-job', project_slug: slug, episode_id: 'EP0001', output_lines: [],
    params: { operation_id: operationId },
  } as any
  await generateThumbnailRefresh(job)
  const saved = await readYouTubeOperation(slug, operationId)
  assert.equal(fake.calls.length, 3)
  assert.equal(fake.calls.filter(call => call.method !== 'GET').length, 1)
  assert.ok(fake.calls.find(call => call.path.includes('/thumbnails/set')))
  assert.ok(await previousYouTubeThumbnail(saved!))
  assert.equal(saved?.actions.at(-1)?.action, 'thumbnail_update')
  assert.equal(saved?.actions.at(-1)?.state, 'succeeded')
  assert.equal(job.progress, 100)
})

test('a provider success is checkpointed to the pinned operation across reassignment', async () => {
  const { slug, operationId } = await setup()
  const fake = new FakeYouTube()
  reads(fake)
  fake.respond({ method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-1', body: { items: [] } })
  __setYouTubeTransportForTests(fake.transport())

  // Reassignment after the provider accepts must not discard or relabel the
  // exact old-channel receipt.
  const connections = await import('../services/youtube-connection-store.js')
  // Use the transport callback itself to race the assignment exactly after the
  // remote response is selected but before the operation receipt is appended.
  __setYouTubeTransportForTests((async (input) => {
    const url = String(input)
    if (url.includes('/youtube/v3/videos?')) return new Response(JSON.stringify(remoteThumbnail()), { status: 200 })
    if (!url.includes('/thumbnails/set')) throw new Error(`Unexpected request: ${url}`)
    await connections.unassignProjectYouTubeChannel({ project_slug: slug, expected_channel_id: CHANNEL })
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
  const job = { job_id: 'thumb-uncertain', project_slug: slug, episode_id: 'EP0001', output_lines: [], params: { operation_id: operationId } } as any
  await assert.rejects(generateThumbnailRefresh(job), /accepted the thumbnail/)
  const saved = await readYouTubeOperation(slug, operationId)
  assert.equal(saved?.channel_id, CHANNEL)
  assert.equal(saved?.actions.at(-1)?.state, 'uncertain')
  assert.equal(saved?.actions.at(-1)?.error_code, 'accepted_readback_or_record_unavailable')
})

test('an accepted replacement with failed readback cannot be sent again', async () => {
  const { slug, operationId } = await setup()
  const fake = new FakeYouTube()
  reads(fake, 1)
  fake.respond({ method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-1', body: {} })
  __setYouTubeTransportForTests(fake.transport())
  const job = { job_id: 'readback-failed', project_slug: slug, episode_id: 'EP0001', output_lines: [], params: { operation_id: operationId } } as any
  await assert.rejects(generateThumbnailRefresh(job), /accepted the thumbnail/)
  assert.notEqual(job.progress, 100)
  await assert.rejects(generateThumbnailRefresh(job), /previous thumbnail update may have reached/)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
  assert.ok(await previousYouTubeThumbnail((await readYouTubeOperation(slug, operationId))!))
})

test('retained remote image restores through the same operation without changing metadata', async () => {
  const { slug, operationId } = await setup()
  const fake = new FakeYouTube()
  reads(fake, 4)
  for (let i = 0; i < 2; i++) fake.respond({ method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-1', body: {} })
  __setYouTubeTransportForTests(fake.transport())
  const original = await readYouTubeOperation(slug, operationId)
  const job = { job_id: 'restore', project_slug: slug, episode_id: 'EP0001', output_lines: [], params: { operation_id: operationId, thumbnail_filename: 'EP0001_Thumbnail_v1.png' } } as any
  await generateThumbnailRefresh(job)
  const previous = await previousYouTubeThumbnail((await readYouTubeOperation(slug, operationId))!)
  assert.ok(previous)
  job.params.thumbnail_filename = previous.filename
  await generateThumbnailRefresh(job)
  const saved = await readYouTubeOperation(slug, operationId)
  assert.deepEqual(saved?.final_payload, original?.final_payload)
  assert.equal(saved?.video_id, original?.video_id)
  assert.equal(saved?.channel_id, original?.channel_id)
  assert.equal(fake.calls.filter(call => call.method !== 'GET').length, 2)
  assert.ok(fake.calls.every(call => call.method === 'GET' || call.path.startsWith('/upload/youtube/v3/thumbnails/set')))
})
