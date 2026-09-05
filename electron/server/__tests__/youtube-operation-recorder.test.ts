import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import {
  beginYouTubeOperation,
  completeYouTubeOperation,
  markYouTubeOperationUploading,
  resolveSourceRevision,
} from '../services/youtube-operation-recorder.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
} from '../services/youtube-connection-store.js'
import { readYouTubeOperation } from '../services/youtube-operation-store.js'
import { readYouTubeProjectPublishingState } from '../services/youtube-project-publishing-store.js'
import { createProject } from '../services/project-manager.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const PACKAGE = {
  source_sha256: 'a'.repeat(64),
  final_payload: {
    snippet_json: JSON.stringify({ title: 'T', description: 'D', tags: [], categoryId: '24' }),
    status_json: JSON.stringify({ privacyStatus: 'private', containsSyntheticMedia: true }),
    source_sha256: 'a'.repeat(64),
  },
} as any

const CHANNEL = 'UC-recorder'

async function project(assign: boolean): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const created = await createProject({ name: 'Recorder Project' })
  if (assign) {
    await configureYouTubeApplication({ client_id: 'recorder-client', client_secret: 'recorder-secret-value' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Recorder Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'recorder-access', refresh_token: 'recorder-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({
      project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
    })
  }
  return created.slug
}

describe('youtube operation recorder', () => {
  test('an unassigned project refuses before opening an operation', async () => {
    const slug = await project(false)
    await assert.rejects(() => beginYouTubeOperation({
      project_slug: slug, episode_code: 'EP0001', source_revision: 'rev-1',
      metadata_package: PACKAGE, final_action: 'manual_upload', provider_channel_id: CHANNEL,
    }), /Configure a YouTube OAuth application|not assigned/i)
  })

  test('refuses to record when the upload account is not the assigned channel', async () => {
    // The upload authenticates as a legacy per-project account while the
    // assignment comes from the Phase 2 registry. If they disagree, recording
    // under the ASSIGNED channel would durably claim the video went somewhere
    // it did not — and poison the episode link built on it. Refuse to record;
    // do not silently attribute it.
    const slug = await project(true)
    await assert.rejects(() => beginYouTubeOperation({
      project_slug: slug, episode_code: 'EP0010', source_revision: 'rev-x',
      metadata_package: PACKAGE, final_action: 'manual_upload',
      provider_channel_id: 'UC-some-other-channel',
    }), /channel/i)
  })

  test('a manual upload records, accepts, and links in that order', async () => {
    const slug = await project(true)
    const handle = await beginYouTubeOperation({
      project_slug: slug, episode_code: 'EP0001', source_revision: 'rev-1',
      metadata_package: PACKAGE, final_action: 'manual_upload', provider_channel_id: CHANNEL,
    })
    const created = await readYouTubeOperation(slug, handle.operation_id)
    assert.equal(created?.lifecycle, 'preparing')
    assert.equal(created?.channel_id, CHANNEL)
    assert.equal(created?.final_action, 'manual_upload')
    assert.equal(created?.metadata_revision, PACKAGE.source_sha256)

    await markYouTubeOperationUploading({
      project_slug: slug, handle, session_url_hash: 'session-hash-value', source_bytes: 4096, last_confirmed_offset: 2048,
    })
    const uploading = await readYouTubeOperation(slug, handle.operation_id)
    assert.equal(uploading?.lifecycle, 'uploading')
    assert.equal(uploading?.resumable?.session_url_hash, 'session-hash-value')

    await completeYouTubeOperation({
      project_slug: slug, episode_code: 'EP0001', handle, video_id: 'video-accepted', metadata_package: PACKAGE,
    })

    const accepted = await readYouTubeOperation(slug, handle.operation_id)
    assert.equal(accepted?.lifecycle, 'accepted')
    assert.equal(accepted?.video_id, 'video-accepted')
    assert.deepEqual(accepted?.final_payload, PACKAGE.final_payload)

    const state = await readYouTubeProjectPublishingState(slug)
    assert.equal(state.episode_video_links['EP0001']?.video_id, 'video-accepted')

  })

  test('the private mode records its distinct action', async () => {
    const slug = await project(true)
    const handle = await beginYouTubeOperation({
      project_slug: slug, episode_code: 'EP0002', source_revision: 'rev-2',
      metadata_package: PACKAGE, final_action: 'private_upload', provider_channel_id: CHANNEL,
    })
    const created = await readYouTubeOperation(slug, handle.operation_id)
    assert.equal(created?.final_action, 'private_upload')

    await completeYouTubeOperation({
      project_slug: slug, episode_code: 'EP0002', handle, video_id: 'video-private', metadata_package: PACKAGE,
    })
  })

  test('completing twice keeps one accepted identity and does not re-accept a different video', async () => {
    const slug = await project(true)
    const handle = await beginYouTubeOperation({
      project_slug: slug, episode_code: 'EP0003', source_revision: 'rev-3',
      metadata_package: PACKAGE, final_action: 'manual_upload', provider_channel_id: CHANNEL,
    })
    await completeYouTubeOperation({
      project_slug: slug, episode_code: 'EP0003', handle, video_id: 'video-once', metadata_package: PACKAGE,
    })
    // A replay of the same accepted identity is recovery, not a second upload.
    await completeYouTubeOperation({
      project_slug: slug, episode_code: 'EP0003', handle, video_id: 'video-once', metadata_package: PACKAGE,
    })
    assert.equal((await readYouTubeOperation(slug, handle.operation_id))?.video_id, 'video-once')

    // A DIFFERENT video against the same accepted operation is a conflict.
    await assert.rejects(
      completeYouTubeOperation({
        project_slug: slug, episode_code: 'EP0003', handle, video_id: 'video-different', metadata_package: PACKAGE,
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_VIDEO_ID_CONFLICT',
    )
  })

  test('the source revision changes when the rendered file changes', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const file = path.join(temp.dir, 'final.mp4')
    await fs.writeFile(file, 'a'.repeat(100))
    const first = await resolveSourceRevision(file)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(await resolveSourceRevision(file), first)

    await fs.writeFile(file, 'b'.repeat(250))
    assert.notEqual(await resolveSourceRevision(file), first)
  })
})
