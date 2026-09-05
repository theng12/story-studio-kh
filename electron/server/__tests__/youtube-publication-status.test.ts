import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  registryCredentialFor,
} from '../lib/youtube-client.js'
import {
  mapYouTubePublicationState,
  syncProjectYouTubePublicationStates,
  syncYouTubePublicationState,
} from '../services/youtube-publication-status.js'
import { createProject } from '../services/project-manager.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
} from '../services/youtube-connection-store.js'
import {
  acceptYouTubeOperation,
  createYouTubeOperation,
  listYouTubeOperations,
  readYouTubeOperation,
} from '../services/youtube-operation-store.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const CHANNEL = 'UC-publication'
const VIDEO = 'video-published'
const CHECKED = '2026-09-02T12:00:00.000Z'

describe('mapping YouTube publication state', () => {
  test('maps every outcome YouTube reports', () => {
    assert.equal(mapYouTubePublicationState({ uploadStatus: 'uploaded' }, CHECKED).lifecycle, 'processing')
    assert.equal(mapYouTubePublicationState({ uploadStatus: 'processed' }, CHECKED).lifecycle, 'ready')

    const failed = mapYouTubePublicationState({ uploadStatus: 'failed', failureReason: 'codec' }, CHECKED)
    assert.equal(failed.lifecycle, 'failed')
    assert.equal(failed.processing.failure_reason, 'codec')

    const rejected = mapYouTubePublicationState({ uploadStatus: 'rejected', rejectionReason: 'copyright' }, CHECKED)
    assert.equal(rejected.lifecycle, 'rejected')
    assert.equal(rejected.processing.rejection_reason, 'copyright')
  })

  test('a video that did not come back is unavailable, not any known state', () => {
    const absent = mapYouTubePublicationState(null, CHECKED)
    assert.equal(absent.lifecycle, 'status_unavailable')
    assert.equal(absent.snapshot, undefined, 'no snapshot can be claimed for a video we did not see')
    assert.equal(absent.processing.checked_at, CHECKED)
  })

  test('an unrecognised status is reported as unknown, never guessed as ready or failed', () => {
    const odd = mapYouTubePublicationState({ uploadStatus: 'someFutureStatus' }, CHECKED)
    assert.equal(odd.lifecycle, 'status_unavailable')
    // The raw word is kept so a human can see what YouTube actually said.
    assert.equal(odd.processing.provider_status, 'someFutureStatus')
  })

  test('a status block without a privacy field yields no snapshot, not a fabricated one', () => {
    // YouTube omits fields — a rejected video's status often carries only the
    // rejection. Defaulting privacy to '' invented a setting nobody reported,
    // the operation store refused the record as invalid, and the whole update
    // was dropped: the rejection itself never got written.
    const mapped = mapYouTubePublicationState(
      { uploadStatus: 'rejected', rejectionReason: 'copyright' }, CHECKED,
    )
    assert.equal(mapped.lifecycle, 'rejected')
    assert.equal(mapped.processing.rejection_reason, 'copyright')
    assert.equal(mapped.snapshot, undefined, 'no privacy reported means no snapshot to claim')
  })

  test('captures the live snapshot for later drift comparison', () => {
    const mapped = mapYouTubePublicationState({
      uploadStatus: 'processed',
      title: 'Live Title', description: 'Live description', tags: ['a', 'b'],
      privacyStatus: 'public', publishAt: null, thumbnailEtag: 'https://i.ytimg.test/x.jpg',
    }, CHECKED)
    assert.deepEqual(mapped.snapshot, {
      fetched_at: CHECKED,
      title: 'Live Title',
      description: 'Live description',
      tags: ['a', 'b'],
      privacy_status: 'public',
      scheduled_for: null,
      thumbnail_etag: 'https://i.ytimg.test/x.jpg',
    })
  })
})

describe('persisting YouTube publication state', () => {
  async function createAccepted(slug: string, channelId: string, episode: string, video: string): Promise<string> {
    const created = await createYouTubeOperation({
      project_slug: slug, episode_code: episode, channel_id: channelId,
      source_revision: `src-${episode}`, metadata_revision: `meta-${episode}`,
      origin: 'manual', final_action: 'manual_upload',
    })
    const accepted = await acceptYouTubeOperation({
      project_slug: slug, operation_id: created.operation_id, expected_revision: created.revision,
      channel_id: channelId, video_id: video, accepted_at: new Date().toISOString(),
      final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
    })
    return accepted.operation_id
  }

  async function acceptedOperation(): Promise<{ slug: string; accountId: string; operationId: string }> {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const project = await createProject({ name: 'Publication Project' })
    const slug = project.slug

    await configureYouTubeApplication({ client_id: 'pub-client', client_secret: 'pub-secret-value' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Pub Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'pub-access', refresh_token: 'pub-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({ project_slug: slug, channel_id: CHANNEL, expected_previous_channel_id: null })

    const created = await createYouTubeOperation({
      project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
      source_revision: 'src', metadata_revision: 'meta',
      origin: 'manual', final_action: 'manual_upload',
    })
    await acceptYouTubeOperation({
      project_slug: slug, operation_id: created.operation_id, expected_revision: created.revision,
      channel_id: CHANNEL, video_id: VIDEO, accepted_at: new Date().toISOString(),
      final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
    })
    return { slug, accountId: registryCredentialFor(CHANNEL), operationId: created.operation_id }
  }

  function respondWith(body: unknown): FakeYouTube {
    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET',
      path: `/youtube/v3/videos?part=snippet,status,processingDetails&id=${VIDEO}`,
      body,
    })
    return fake
  }

  test('a terminal answer is persisted onto the operation', async () => {
    const { slug, accountId, operationId } = await acceptedOperation()
    __setYouTubeTransportForTests(respondWith({
      items: [{
        id: VIDEO,
        status: { uploadStatus: 'rejected', rejectionReason: 'copyright', privacyStatus: 'private' },
        snippet: { title: 'T', description: 'D', tags: [] },
      }],
    }).transport())

    const result = await syncYouTubePublicationState({ project_slug: slug, operation_id: operationId, account_id: accountId })
    assert.equal(result.persisted, true)
    assert.equal(result.state.lifecycle, 'rejected')

    const stored = await readYouTubeOperation(slug, operationId)
    assert.equal(stored?.lifecycle, 'rejected')
    assert.equal(stored?.processing?.rejection_reason, 'copyright')
    assert.equal(stored?.remote_snapshot?.title, 'T')
  })

  test('a missing video never overwrites an answer YouTube already gave', async () => {
    const { slug, accountId, operationId } = await acceptedOperation()
    __setYouTubeTransportForTests(respondWith({
      items: [{ id: VIDEO, status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'T' } }],
    }).transport())
    await syncYouTubePublicationState({ project_slug: slug, operation_id: operationId, account_id: accountId })
    assert.equal((await readYouTubeOperation(slug, operationId))?.lifecycle, 'ready')

    // Now YouTube stops returning it at all.
    __setYouTubeTransportForTests(respondWith({ items: [] }).transport())
    const second = await syncYouTubePublicationState({ project_slug: slug, operation_id: operationId, account_id: accountId })

    assert.equal(second.state.lifecycle, 'status_unavailable')
    assert.equal(second.persisted, false, 'an absence is not evidence that a known outcome changed')
    assert.equal((await readYouTubeOperation(slug, operationId))?.lifecycle, 'ready')
  })

  test('processing does progress to ready', async () => {
    const { slug, accountId, operationId } = await acceptedOperation()
    __setYouTubeTransportForTests(respondWith({
      items: [{ id: VIDEO, status: { uploadStatus: 'uploaded', privacyStatus: 'private' }, snippet: { title: 'T' } }],
    }).transport())
    await syncYouTubePublicationState({ project_slug: slug, operation_id: operationId, account_id: accountId })
    assert.equal((await readYouTubeOperation(slug, operationId))?.lifecycle, 'processing')

    __setYouTubeTransportForTests(respondWith({
      items: [{ id: VIDEO, status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'T' } }],
    }).transport())
    await syncYouTubePublicationState({ project_slug: slug, operation_id: operationId, account_id: accountId })
    assert.equal((await readYouTubeOperation(slug, operationId))?.lifecycle, 'ready')
  })

  test('an unavailable first observation can later progress to ready', async () => {
    const { slug, accountId, operationId } = await acceptedOperation()
    __setYouTubeTransportForTests(respondWith({ items: [] }).transport())
    await syncYouTubePublicationState({ project_slug: slug, operation_id: operationId, account_id: accountId })
    assert.equal((await readYouTubeOperation(slug, operationId))?.lifecycle, 'status_unavailable')

    __setYouTubeTransportForTests(respondWith({
      items: [{ id: VIDEO, status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'T' } }],
    }).transport())
    await syncYouTubePublicationState({ project_slug: slug, operation_id: operationId, account_id: accountId })
    assert.equal((await readYouTubeOperation(slug, operationId))?.lifecycle, 'ready')
  })

  test('whole-project sync covers more than fifty videos in bounded provider batches', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const project = await createProject({ name: 'Publication Large Project' })
    await configureYouTubeApplication({ client_id: 'pub-client', client_secret: 'pub-secret-value' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Pub Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'pub-access', refresh_token: 'pub-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null })
    const ids: string[] = []
    for (let index = 0; index < 51; index++) {
      const videoId = `video-${String(index + 1).padStart(2, '0')}`
      ids.push(videoId)
      await createAccepted(project.slug, CHANNEL, `EP${String(index + 1).padStart(4, '0')}`, videoId)
    }
    const fake = new FakeYouTube()
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50)
      fake.respond({
        method: 'GET',
        path: `/youtube/v3/videos?part=snippet,status,processingDetails&id=${batch.join(',')}`,
        body: { items: batch.map(id => ({ id, status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: id } })) },
      })
    }
    __setYouTubeTransportForTests(fake.transport())

    const result = await syncProjectYouTubePublicationStates({
      project_slug: project.slug, account_id: registryCredentialFor(CHANNEL),
    })
    assert.deepEqual({ checked: result.checked, updated: result.updated, outcome: result.outcome }, {
      checked: 51, updated: 51, outcome: 'ok',
    })
    assert.equal(fake.calls.length, 2)
  })

  test('whole-project sync requests only the channel pinned at query start', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const project = await createProject({ name: 'Publication Reassigned Project' })
    const oldChannel = 'UC-publication-old'
    const newChannel = 'UC-publication-new'
    await configureYouTubeApplication({ client_id: 'pub-client', client_secret: 'pub-secret-value' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: oldChannel, title: 'Old', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: oldChannel, expected_previous_channel_id: null })
    const oldOperation = await createAccepted(project.slug, oldChannel, 'EP0001', 'video-old')
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: newChannel, title: 'New', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: newChannel, expected_previous_channel_id: oldChannel })
    const newOperation = await createAccepted(project.slug, newChannel, 'EP0002', 'video-new')
    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET', path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=video-new',
      body: { items: [{ id: 'video-new', status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'New' } }] },
    })
    __setYouTubeTransportForTests(fake.transport())

    const result = await syncProjectYouTubePublicationStates({
      project_slug: project.slug, account_id: registryCredentialFor(newChannel),
    })
    assert.equal(result.channel_id, newChannel)
    assert.equal(fake.calls[0]?.path.includes('video-old'), false)
    const records = await listYouTubeOperations(project.slug)
    assert.equal(records.find(record => record.operation_id === oldOperation)?.lifecycle, 'accepted')
    assert.equal(records.find(record => record.operation_id === newOperation)?.lifecycle, 'ready')
  })

  test('whole-project sync checkpoints the pinned channel when assignment changes during the provider read', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const project = await createProject({ name: 'Publication In-flight Reassignment' })
    const queriedChannel = 'UC-publication-query'
    const laterChannel = 'UC-publication-later'
    await configureYouTubeApplication({ client_id: 'pub-client', client_secret: 'pub-secret-value' })
    for (const channelId of [queriedChannel, laterChannel]) {
      await saveYouTubeChannelGrantForTest({
        channel: { channel_id: channelId, title: channelId, granted_scopes: ['youtube.upload'] },
        tokens: { access_token: `${channelId}-access`, refresh_token: `${channelId}-refresh`, expires_at: Date.now() + 3_600_000 },
      })
    }
    await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: queriedChannel, expected_previous_channel_id: null })
    const operationId = await createAccepted(project.slug, queriedChannel, 'EP0001', 'video-query')
    let calls = 0
    __setYouTubeTransportForTests((async (input) => {
      calls++
      assert.match(String(input), /id=video-query/)
      await assignProjectYouTubeChannel({
        project_slug: project.slug,
        channel_id: laterChannel,
        expected_previous_channel_id: queriedChannel,
      })
      return new Response(JSON.stringify({
        items: [{
          id: 'video-query',
          status: { uploadStatus: 'processed', privacyStatus: 'public' },
          snippet: { title: 'Pinned result' },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    const result = await syncProjectYouTubePublicationStates({
      project_slug: project.slug,
      account_id: registryCredentialFor(queriedChannel),
    })
    const stored = await readYouTubeOperation(project.slug, operationId)
    assert.equal(calls, 1)
    assert.deepEqual({ channel_id: result.channel_id, updated: result.updated, outcome: result.outcome }, {
      channel_id: queriedChannel, updated: 1, outcome: 'ok',
    })
    assert.equal(stored?.channel_id, queriedChannel)
    assert.equal(stored?.lifecycle, 'ready')
  })
})
