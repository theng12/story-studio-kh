import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  checkCloudProjectQuota,
  getValidCredentialContext,
  listPlaylists,
  recordQuotaOrLog,
  setThumbnail,
  listVideoStatuses,
} from '../lib/youtube-client.js'
import { createProject } from '../services/project-manager.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
} from '../services/youtube-connection-store.js'
import { readYouTubeConnectionRegistry } from '../services/youtube-connection-store.js'
import {
  readYouTubeQuota,
  recordYouTubeQuotaAttempt,
} from '../services/youtube-quota-ledger.js'
import { uploadVideo } from '../lib/youtube-client.js'
import { listVideoCommentThreads } from '../lib/youtube-comments.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'
import fs from 'node:fs/promises'
import path from 'node:path'

let cleanup: (() => Promise<void>) | undefined
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==', 'base64')

afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

async function connectedProject(name: string, channelId: string, assign = true): Promise<{ slug: string; accountId: string }> {
  const project = await createProject({ name })
  if (assign) {
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: channelId, title: name, granted_scopes: ['youtube.upload'] },
      tokens: { access_token: `grant-${channelId}`, refresh_token: `grantr-${channelId}`, expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({
      project_slug: project.slug, channel_id: channelId, expected_previous_channel_id: null,
    })
  }
  return { slug: project.slug, accountId: `registry:${channelId}` }
}

function statusFake(videoId: string): FakeYouTube {
  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: `/youtube/v3/videos?part=status&id=${videoId}`,
    body: { items: [{ id: videoId, status: { privacyStatus: 'public' } }] },
  })
  return fake
}

describe('cloud-project quota charging', () => {
  test('two projects on one application aggregate into a single ledger', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client', client_secret: 'quota-secret-value' })

    const first = await connectedProject('Quota One', 'UC-quota-one')
    const second = await connectedProject('Quota Two', 'UC-quota-two')

    __setYouTubeTransportForTests(statusFake('video-a').transport())
    await listVideoStatuses(first.slug, first.accountId, ['video-a'])
    __setYouTubeTransportForTests(statusFake('video-b').transport())
    await listVideoStatuses(second.slug, second.accountId, ['video-b'])

    const registry = await readYouTubeConnectionRegistry()
    const snapshot = await readYouTubeQuota(registry.application!.application_id)

    // videos.list costs 1 unit and belongs to the catch-all bucket.
    assert.equal(snapshot.buckets.other_endpoints.used, 2)
    assert.equal(snapshot.buckets.video_uploads.used, 0)
    // Per-channel activity is a derived breakdown of the one Cloud-project total.
    assert.equal(snapshot.buckets.other_endpoints.by_channel['UC-quota-one'], 1)
    assert.equal(snapshot.buckets.other_endpoints.by_channel['UC-quota-two'], 1)
    assert.equal(snapshot.external_usage_known, false)
  })

  test('an in-flight response is charged to the channel pinned before reassignment', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client', client_secret: 'quota-secret-value' })
    const project = await connectedProject('Quota Pinned', 'UC-quota-before')
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: 'UC-quota-after', title: 'After', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'after-access', refresh_token: 'after-refresh', expires_at: Date.now() + 3_600_000 },
    })
    __setYouTubeTransportForTests((async () => {
      await assignProjectYouTubeChannel({
        project_slug: project.slug,
        channel_id: 'UC-quota-after',
        expected_previous_channel_id: 'UC-quota-before',
      })
      return new Response(JSON.stringify({
        items: [{ id: 'video-pinned', status: { privacyStatus: 'public' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    await listVideoStatuses(project.slug, project.accountId, ['video-pinned'])
    const applicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    const snapshot = await readYouTubeQuota(applicationId)
    assert.equal(snapshot.buckets.other_endpoints.by_channel['UC-quota-before'], 1)
    assert.equal(snapshot.buckets.other_endpoints.by_channel['UC-quota-after'] ?? 0, 0)
  })

  test('an in-flight response is charged to the OAuth application pinned before replacement', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client-before', client_secret: 'quota-secret-before' })
    const project = await connectedProject('Quota App Pinned', 'UC-quota-app')
    const beforeApplicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    __setYouTubeTransportForTests((async () => {
      await configureYouTubeApplication({ client_id: 'quota-client-after', client_secret: 'quota-secret-after' })
      return new Response(JSON.stringify({
        items: [{ id: 'video-app-pinned', status: { privacyStatus: 'public' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    await listVideoStatuses(project.slug, project.accountId, ['video-app-pinned'])
    const afterApplicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    const before = await readYouTubeQuota(beforeApplicationId)
    const after = await readYouTubeQuota(afterApplicationId)
    assert.equal(before.buckets.other_endpoints.by_channel['UC-quota-app'], 1)
    assert.equal(after.buckets.other_endpoints.used, 0)
  })

  test('quota admission keeps the immutable credential application after replacement', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client-before', client_secret: 'quota-secret-before' })
    const project = await connectedProject('Quota Context Pinned', 'UC-quota-context')
    const context = await getValidCredentialContext(project.slug, project.accountId)
    const beforeApplicationId = context.application_id

    await configureYouTubeApplication({ client_id: 'quota-client-after', client_secret: 'quota-secret-after' })
    const afterApplicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    const permit = await checkCloudProjectQuota(context, 'videos_list')
    await recordQuotaOrLog(permit)

    assert.equal(permit.application_id, beforeApplicationId)
    assert.equal(permit.channel_id, 'UC-quota-context')
    assert.equal((await readYouTubeQuota(beforeApplicationId)).buckets.other_endpoints.used, 1)
    assert.equal((await readYouTubeQuota(afterApplicationId)).buckets.other_endpoints.used, 0)
  })

  test('playlist pages and transient thumbnail attempts are each charged once', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client', client_secret: 'quota-secret-value' })
    const project = await connectedProject('Quota Attempts', 'UC-quota-attempts')
    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET', path: '/youtube/v3/playlists?part=snippet%2Cstatus%2CcontentDetails&mine=true&maxResults=50',
      body: { items: [], nextPageToken: 'next' },
    })
    fake.respond({
      method: 'GET', path: '/youtube/v3/playlists?part=snippet%2Cstatus%2CcontentDetails&mine=true&maxResults=50&pageToken=next',
      body: { items: [] },
    })
    const image = path.join(temp.dir, 'attempt.png')
    await fs.writeFile(image, PNG)
    fake.rejectNext({
      method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-attempt', status: 409,
      body: { error: { message: 'still processing' } },
    })
    fake.respond({
      method: 'POST', path: '/upload/youtube/v3/thumbnails/set?videoId=video-attempt', body: {},
    })
    __setYouTubeTransportForTests(fake.transport())

    await listPlaylists(project.slug, project.accountId)
    await setThumbnail({ slug: project.slug, accountId: project.accountId, filePath: image, videoId: 'video-attempt' })

    const applicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    const snapshot = await readYouTubeQuota(applicationId)
    assert.equal(fake.calls.length, 4, 'two playlist pages plus two thumbnail attempts')
    assert.equal(snapshot.buckets.other_endpoints.used, 102, '2 playlist units + 2 × 50 thumbnail units')
  })

  test('an upload costs ONE call in the upload bucket, not its unit price', async () => {
    // The buckets do not share a unit (spec section 6): video_uploads counts
    // CALLS with a 100/day ceiling, other_endpoints counts UNITS with 10,000.
    // Charging videos.insert's 1,600 units into the 100-call bucket exhausted
    // it on the very first upload.
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client', client_secret: 'quota-secret-value' })
    const project = await connectedProject('Quota Units', 'UC-quota-units')

    const source = path.join(temp.dir, 'units-source.mp4')
    await fs.writeFile(source, tinyVideoBytes())

    const fake = new FakeYouTube()
    fake.respond({
      method: 'POST',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      body: {},
      headers: { Location: 'https://upload.youtube.test/resumable/units' },
    })
    fake.respond({ method: 'PUT', path: '/resumable/units', body: { id: 'video-units' } })
    __setYouTubeTransportForTests(fake.transport())

    await uploadVideo({
      slug: project.slug, accountId: project.accountId, filePath: source,
      snippet: { title: 'T' }, status: { privacyStatus: 'private' },
    } as any)

    const registry = await readYouTubeConnectionRegistry()
    const snapshot = await readYouTubeQuota(registry.application!.application_id)
    assert.equal(snapshot.buckets.video_uploads.used, 1, 'one upload is one call')
    assert.equal(snapshot.buckets.video_uploads.unit, 'calls')
    assert.equal(snapshot.buckets.video_uploads.remaining, 99)
  })

  test('an exhausted upload bucket refuses the insert before any request is made', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client', client_secret: 'quota-secret-value' })
    const project = await connectedProject('Quota Exhausted', 'UC-quota-exhausted')

    const registry = await readYouTubeConnectionRegistry()
    const applicationId = registry.application!.application_id
    await recordYouTubeQuotaAttempt({
      application_id: applicationId, channel_id: 'UC-quota-exhausted',
      bucket: 'video_uploads', operation: 'videos_insert', amount: 100,
    })

    // A REAL file, so the refusal proven here is the quota one and not a
    // missing-file error arriving first.
    const source = path.join(temp.dir, 'quota-source.mp4')
    await fs.writeFile(source, tinyVideoBytes())

    // Charging without enforcing would let this through and spend real quota.
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(
      uploadVideo({
        slug: project.slug, accountId: project.accountId, filePath: source,
        snippet: { title: 'T' }, status: { privacyStatus: 'private' },
      } as any),
      /quota/i,
    )
    assert.equal(fake.calls.length, 0, 'the refusal happens before any provider request')
  })

  test('a project with no assigned channel is refused before provider work or quota charge', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client', client_secret: 'quota-secret-value' })
    const unassigned = await connectedProject('Quota Unassigned', 'UC-quota-unassigned', false)

    const fake = statusFake('video-c')
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(
      listVideoStatuses(unassigned.slug, unassigned.accountId, ['video-c']),
      /not assigned|reconnect/i,
    )

    const registry = await readYouTubeConnectionRegistry()
    const snapshot = await readYouTubeQuota(registry.application!.application_id)
    assert.equal(snapshot.buckets.other_endpoints.used, 0)
    assert.equal(fake.calls.length, 0)
  })


  test('comments share the one application allowance across projects', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await configureYouTubeApplication({ client_id: 'quota-client', client_secret: 'quota-secret-value' })
    await connectedProject('Comments One', 'UC-comments-one')
    const second = await connectedProject('Comments Two', 'UC-comments-two')
    const applicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    await recordYouTubeQuotaAttempt({
      application_id: applicationId,
      channel_id: 'UC-comments-one',
      bucket: 'other_endpoints',
      operation: 'commentThreads.list',
      amount: 10_000,
    })
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(
      listVideoCommentThreads(second.slug, second.accountId, 'video-comments'),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_QUOTA_EXHAUSTED',
    )
    assert.equal(fake.calls.length, 0, 'the shared app bucket refuses before comment transport')
  })

  test('without an owner application the registry-only request is refused before provider work', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const disconnected = await connectedProject('Quota Disconnected', 'UC-quota-disconnected', false)

    const fake = statusFake('video-d')
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(
      listVideoStatuses(disconnected.slug, disconnected.accountId, ['video-d']),
      /not assigned|reconnect/i,
    )
    assert.equal(fake.calls.length, 0)
  })
})
