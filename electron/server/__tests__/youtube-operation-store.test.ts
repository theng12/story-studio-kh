import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')
let store: typeof import('../services/youtube-operation-store.js')
let cleanup: (() => Promise<void>) | undefined

const NOW = '2026-09-01T12:00:00.000Z'
const PAYLOAD = {
  snippet_json: JSON.stringify({ title: 'Episode 1', description: '', tags: [], categoryId: '24' }),
  status_json: JSON.stringify({ privacyStatus: 'private' }),
  source_sha256: 'a'.repeat(64),
}

beforeEach(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  store = await import('../services/youtube-operation-store.js')
  await connections.configureYouTubeApplication({ client_id: 'client-id-1', client_secret: 'client-secret-1' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'channel-1', title: 'Channel 1', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 1_900_000_000_000 },
  })
})

afterEach(async () => { await cleanup?.(); cleanup = undefined })

async function project(name: string) {
  const created = await pm.createProject({ name })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: 'channel-1', expected_previous_channel_id: null,
  })
  return created
}

function input(slug: string, episode = 'EP0001') {
  return {
    project_slug: slug,
    episode_code: episode,
    channel_id: 'channel-1',
    source_revision: `source-${episode}`,
    metadata_revision: `metadata-${episode}`,
    final_payload: PAYLOAD,
    origin: 'manual' as const,
    final_action: 'manual_upload' as const,
  }
}

async function accept(slug: string, operationId: string, videoId = 'video-1', revision = 1) {
  return store.acceptYouTubeOperation({
    project_slug: slug, operation_id: operationId, expected_revision: revision,
    channel_id: 'channel-1', video_id: videoId, accepted_at: NOW, final_payload: PAYLOAD,
  })
}

describe('YouTube operation store', () => {
  test('records the manual operation before provider work and checkpoints one immutable accepted identity', async () => {
    const created = await project('Operation Project')
    const opened = await store.createYouTubeOperation(input(created.slug))
    assert.equal(opened.revision, 1)
    assert.equal(opened.lifecycle, 'preparing')
    assert.equal(opened.actions[0]?.action, 'manual_upload')
    assert.deepEqual(opened.final_payload, PAYLOAD)

    const accepted = await accept(created.slug, opened.operation_id)
    assert.equal(accepted.video_id, 'video-1')
    assert.equal(accepted.lifecycle, 'accepted')
    assert.deepEqual(accepted.final_payload, PAYLOAD)
    assert.equal((await store.listYouTubeOperations(created.slug)).length, 1)

    const replay = await accept(created.slug, opened.operation_id, 'video-1', accepted.revision)
    assert.equal(replay.revision, accepted.revision)
    await assert.rejects(() => accept(created.slug, opened.operation_id, 'video-2', accepted.revision),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_VIDEO_ID_CONFLICT')
  })

  test('compare-and-swap protects identity, original request payload, and action history', async () => {
    const created = await project('CAS Project')
    const opened = await store.createYouTubeOperation(input(created.slug))
    const uploading = await store.updateYouTubeOperation({
      project_slug: created.slug, operation_id: opened.operation_id, expected_revision: opened.revision,
      mutate(record) { record.lifecycle = 'uploading' },
    })
    await assert.rejects(() => store.updateYouTubeOperation({
      project_slug: created.slug, operation_id: opened.operation_id, expected_revision: opened.revision,
      mutate(record) { record.episode_code = 'EP9999' },
    }), (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_RECORD_REVISION_CONFLICT')
    await assert.rejects(() => store.updateYouTubeOperation({
      project_slug: created.slug, operation_id: opened.operation_id, expected_revision: uploading.revision,
      mutate(record) { record.final_payload = { ...PAYLOAD, source_sha256: 'b'.repeat(64) } },
    }), (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_RECORD_REVISION_CONFLICT')
  })

  test('video claims stop two operations from claiming the same channel video', async () => {
    const created = await project('Claim Project')
    const first = await store.createYouTubeOperation(input(created.slug))
    const second = await store.createYouTubeOperation(input(created.slug, 'EP0002'))
    await accept(created.slug, first.operation_id, 'shared-video')
    await assert.rejects(() => accept(created.slug, second.operation_id, 'shared-video'),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_VIDEO_ID_CONFLICT')
  })

  test('malformed persisted records fail closed and remain byte-identical', async () => {
    const created = await project('Corrupt Project')
    const opened = await store.createYouTubeOperation(input(created.slug))
    const projectDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', created.slug)
    const recordPath = path.join(projectDir, 'youtube', 'operations', `${opened.operation_id}.json`)
    const bytes = Buffer.from('{"schema_version":1,"broken":')
    await fs.writeFile(recordPath, bytes)
    await assert.rejects(() => store.listYouTubeOperations(created.slug),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_OPERATION_RECORD_CORRUPT')
    assert.deepEqual(await fs.readFile(recordPath), bytes)
  })

  test('corruption in another project cannot block local reads or pinned provider receipts', async () => {
    const healthy = await project('Healthy Project')
    const opened = await store.createYouTubeOperation(input(healthy.slug))
    const accepted = await accept(healthy.slug, opened.operation_id)

    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: 'channel-2', title: 'Channel 2', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'access-2', refresh_token: 'refresh-2', expires_at: 1_900_000_000_000 },
    })
    const broken = await pm.createProject({ name: 'Broken Project' })
    await connections.assignProjectYouTubeChannel({
      project_slug: broken.slug, channel_id: 'channel-2', expected_previous_channel_id: null,
    })
    const brokenOperation = await store.createYouTubeOperation({
      ...input(broken.slug), channel_id: 'channel-2', episode_code: 'EP0002',
    })
    const brokenPath = path.join(
      process.env.STORY_STUDIO_DATA_DIR!, 'projects', broken.slug, 'youtube', 'operations',
      `${brokenOperation.operation_id}.json`,
    )
    await fs.writeFile(brokenPath, '{"schema_version":1,"broken":')

    assert.equal((await store.readYouTubeOperation(healthy.slug, accepted.operation_id))?.video_id, 'video-1')
    assert.equal((await store.listYouTubeOperations(healthy.slug)).length, 1)
    const updated = await store.updatePinnedYouTubeOperation({
      project_slug: healthy.slug,
      operation_id: accepted.operation_id,
      expected_revision: accepted.revision,
      expected_channel_id: accepted.channel_id,
      mutate(record) {
        record.drift.title = { state: 'keep_youtube', decided_at: NOW }
      },
    })
    assert.equal(updated.drift.title?.state, 'keep_youtube')

    const second = await store.createYouTubeOperation(input(healthy.slug, 'EP0003'))
    assert.equal((await accept(healthy.slug, second.operation_id, 'video-2')).video_id, 'video-2')

    const third = await store.createYouTubeOperation(input(healthy.slug, 'EP0004'))
    const claimsPath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'youtube', 'video-claims.json')
    const claimsBytes = Buffer.from('{"schema_version":1,"claims":[')
    await fs.writeFile(claimsPath, claimsBytes)
    await assert.rejects(() => accept(healthy.slug, third.operation_id, 'video-3'),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_OPERATION_RECORD_CORRUPT')
    assert.deepEqual(await fs.readFile(claimsPath), claimsBytes)
  })

  test('a channel reassignment refuses operation mutation', async () => {
    const created = await project('Channel Guard')
    const opened = await store.createYouTubeOperation(input(created.slug))
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: 'channel-2', title: 'Channel 2', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'access-2', refresh_token: 'refresh-2', expires_at: 1_900_000_000_000 },
    })
    await connections.assignProjectYouTubeChannel({
      project_slug: created.slug, channel_id: 'channel-2', expected_previous_channel_id: 'channel-1',
    })
    await assert.rejects(() => store.updateYouTubeOperation({
      project_slug: created.slug, operation_id: opened.operation_id, expected_revision: opened.revision,
      mutate(record) { record.lifecycle = 'uploading' },
    }), (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_ASSIGNMENT_CHANGED')
  })
})
