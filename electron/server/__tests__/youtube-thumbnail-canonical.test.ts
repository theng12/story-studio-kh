import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==', 'base64')

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

afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

test('a canonical operation with no legacy sidecar can update its thumbnail', async () => {
  const { slug, operationId } = await setup()
  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-1', body: { items: [] } })
  __setYouTubeTransportForTests(fake.transport())
  const job = {
    job_id: 'thumb-job', project_slug: slug, episode_id: 'EP0001', output_lines: [],
    params: { operation_id: operationId },
  } as any
  await generateThumbnailRefresh(job)
  const saved = await readYouTubeOperation(slug, operationId)
  assert.equal(fake.calls.length, 1)
  assert.equal(saved?.actions.at(-1)?.action, 'thumbnail_update')
  assert.equal(saved?.actions.at(-1)?.state, 'succeeded')
  assert.equal(job.progress, 100)
})

test('a provider success is checkpointed to the pinned operation across reassignment', async () => {
  const { slug, operationId } = await setup()
  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-1', body: { items: [] } })
  __setYouTubeTransportForTests(fake.transport())

  // Reassignment after the provider accepts must not discard or relabel the
  // exact old-channel receipt.
  const connections = await import('../services/youtube-connection-store.js')
  // Use the transport callback itself to race the assignment exactly after the
  // remote response is selected but before the operation receipt is appended.
  __setYouTubeTransportForTests((async (input) => {
    const url = String(input)
    if (!url.includes('/thumbnails/set')) throw new Error(`Unexpected request: ${url}`)
    await connections.unassignProjectYouTubeChannel({ project_slug: slug, expected_channel_id: CHANNEL })
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
  const job = { job_id: 'thumb-uncertain', project_slug: slug, episode_id: 'EP0001', output_lines: [], params: { operation_id: operationId } } as any
  await generateThumbnailRefresh(job)
  const saved = await readYouTubeOperation(slug, operationId)
  assert.equal(saved?.channel_id, CHANNEL)
  assert.equal(saved?.actions.at(-1)?.state, 'succeeded')
})
