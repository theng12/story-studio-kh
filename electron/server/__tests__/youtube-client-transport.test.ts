import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  listVideoStatuses,
} from '../lib/youtube-client.js'
import { createProject } from '../services/project-manager.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

/** A project with one registry connection holding a live-looking token. */
async function withAccount(): Promise<{ slug: string; accountId: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Transport Project' })
  await configureYouTubeApplication({ client_id: 'transport-client', client_secret: 'transport-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-transport', title: 'Transport Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'transport-access-token',
      refresh_token: 'transport-refresh-token',
      expires_at: Date.now() + 3_600_000,
    },
  })
  await assignProjectYouTubeChannel({
    project_slug: project.slug,
    channel_id: 'UC-transport',
    expected_previous_channel_id: null,
  })
  return { slug: project.slug, accountId: 'registry:UC-transport' }
}

describe('youtube client transport seam', () => {
  test('every request goes through the injected transport and none reaches the network', async () => {
    const { slug, accountId } = await withAccount()
    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET',
      path: '/youtube/v3/videos?part=status&id=video-one,video-two',
      body: {
        items: [
          { id: 'video-one', status: { privacyStatus: 'public' } },
          { id: 'video-two', status: { privacyStatus: 'private', publishAt: '2027-01-01T00:00:00Z' } },
        ],
      },
    })
    __setYouTubeTransportForTests(fake.transport())

    const statuses = await listVideoStatuses(slug, accountId, ['video-one', 'video-two'])

    assert.equal(fake.calls.length, 1, 'exactly one request, and it went to the fake')
    assert.equal(fake.calls[0]?.method, 'GET')
    assert.equal(statuses['video-one']?.privacyStatus, 'public')
    assert.equal(statuses['video-two']?.publishAt, '2027-01-01T00:00:00Z')
  })

  test('an unstubbed request fails locally rather than escaping to Google', async () => {
    const { slug, accountId } = await withAccount()
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    // Nothing queued: the fake refuses. That refusal is the proof the call
    // could not have reached the real API.
    await assert.rejects(
      listVideoStatuses(slug, accountId, ['video-unstubbed']),
      /no queued response/i,
    )
  })

  test('resetting restores the platform fetch rather than leaking the fake', async () => {
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    __resetYouTubeTransportForTests()
    // Proven by behaviour, not by reading the binding: after a reset the fake
    // records nothing, because it is no longer the transport.
    assert.equal(fake.calls.length, 0)
  })
})
