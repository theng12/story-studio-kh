import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')
let store: typeof import('../services/youtube-project-publishing-store.js')
let tempDir = ''
let cleanup: (() => Promise<void>) | undefined

const NOW = '2026-09-01T12:00:00.000Z'

beforeEach(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  store = await import('../services/youtube-project-publishing-store.js')
})

afterEach(async () => { await cleanup?.(); cleanup = undefined })

async function project() {
  const created = await pm.createProject({ name: 'YouTube Publishing State' })
  await connections.configureYouTubeApplication({ client_id: 'client-id-1', client_secret: 'client-secret-1' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'channel-1', title: 'Channel 1', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 1_900_000_000_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: 'channel-1', expected_previous_channel_id: null,
  })
  return created
}

function statePath(slug: string) {
  return path.join(tempDir, 'projects', slug, 'youtube', 'project-state.json')
}

async function editProjectMetadata(slug: string, edit: (metadata: Record<string, any>) => void) {
  const file = path.join(tempDir, 'projects', slug, 'project.json')
  const metadata = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>
  edit(metadata)
  await fs.writeFile(file, JSON.stringify(metadata, null, 2))
}

describe('YouTube project publishing state', () => {
  test('starts with only the shipped publishing authorities', async () => {
    const created = await project()
    assert.deepEqual(await store.readYouTubeProjectPublishingState(created.slug), {
      schema_version: 1,
      revision: 0,
      project_slug: created.slug,
      episode_video_links: {},
      reconciliation_history: [],
    })
    await assert.rejects(() => fs.access(statePath(created.slug)))
  })

  test('accepts stored projects from before optional subfolder keys were introduced', async () => {
    const created = await project()
    await editProjectMetadata(created.slug, metadata => {
      delete metadata.subfolder_names.video_assets
      delete metadata.subfolder_names.subtitles
    })

    assert.deepEqual(await store.readYouTubeProjectPublishingState(created.slug), {
      schema_version: 1,
      revision: 0,
      project_slug: created.slug,
      episode_video_links: {},
      reconciliation_history: [],
    })
  })

  test('still refuses unknown and unsafe stored subfolder names', async () => {
    const created = await project()
    await editProjectMetadata(created.slug, metadata => {
      metadata.subfolder_names.future = '{code} - Future'
    })
    await assert.rejects(() => store.readYouTubeProjectPublishingState(created.slug),
      (error: unknown) => (error as { code?: string }).code === 'JSON_CORRUPT')

    await editProjectMetadata(created.slug, metadata => {
      delete metadata.subfolder_names.future
      metadata.subfolder_names.video_assets = '../outside'
    })
    await assert.rejects(() => store.readYouTubeProjectPublishingState(created.slug),
      (error: unknown) => (error as { code?: string }).code === 'JSON_CORRUPT')

    await editProjectMetadata(created.slug, metadata => {
      metadata.subfolder_names.video_assets = '{code} - 11 Video Assets'
      delete metadata.subfolder_names.video
    })
    await assert.rejects(() => store.readYouTubeProjectPublishingState(created.slug),
      (error: unknown) => (error as { code?: string }).code === 'JSON_CORRUPT')
  })

  test('keeps an uploaded identity immutable and records explicit reconciliation history', async () => {
    const created = await project()
    const uploaded = await store.linkYouTubeEpisodeVideo({
      project_slug: created.slug, episode_code: 'EP0001', channel_id: 'channel-1',
      video_id: 'video-1', source: 'upload', decided_at: NOW,
    })
    assert.equal(uploaded.episode_video_links.EP0001?.video_id, 'video-1')
    await assert.rejects(() => store.linkYouTubeEpisodeVideo({
      project_slug: created.slug, episode_code: 'EP0001', channel_id: 'channel-1',
      video_id: 'video-2', source: 'upload', decided_at: NOW,
    }), (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_VIDEO_ID_CONFLICT')

    const decision = await store.recordYouTubeReconcileDecision({
      project_slug: created.slug, episode_code: 'EP0001',
      previous_video_id: 'video-1', next_video_id: 'video-2',
    })
    await store.linkYouTubeEpisodeVideo({
      project_slug: created.slug, episode_code: 'EP0001', channel_id: 'channel-1',
      video_id: 'video-2', source: 'reconcile', decided_at: decision.decided_at,
    })
    assert.equal((await store.readYouTubeProjectPublishingState(created.slug)).episode_video_links.EP0001?.video_id, 'video-2')

    const rolledBack = await store.rollbackYouTubeReconcileDecision({
      project_slug: created.slug, decision_id: decision.decision_id,
    })
    assert.equal(rolledBack?.rolled_back_at !== undefined, true)
    assert.equal((await store.readYouTubeProjectPublishingState(created.slug)).episode_video_links.EP0001?.video_id, 'video-1')
  })

  test('preserves corrupt bytes instead of replacing the store', async () => {
    const created = await project()
    const file = statePath(created.slug)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const bytes = Buffer.from('{"schema_version":1,"broken":')
    await fs.writeFile(file, bytes)
    await assert.rejects(() => store.linkYouTubeEpisodeVideo({
      project_slug: created.slug, episode_code: 'EP0001', channel_id: 'channel-1',
      video_id: 'video-1', source: 'upload', decided_at: NOW,
    }), (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_PROJECT_STATE_CORRUPT')
    assert.deepEqual(await fs.readFile(file), bytes)
  })

  test('pins reconcile cache to the channel that was actually queried', async () => {
    const created = await project()
    await store.recordYouTubeReconcileCache({
      project_slug: created.slug,
      channel_id: 'channel-1',
      fetched_at: NOW,
      remote_videos: [{ video_id: 'video-1', title: 'Episode 1', published_at: NOW }],
      truncated: false,
    })
    assert.equal((await store.readYouTubeProjectPublishingState(created.slug)).reconcile?.channel_id, 'channel-1')
  })
})
