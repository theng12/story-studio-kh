import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { createProject } from '../services/project-manager.js'
import * as legacy from '../services/upload-store.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
  markYouTubeChannelStatus,
} from '../services/youtube-connection-store.js'
import { saveYouTubeChannelGrantForTest as saveYouTubeChannelGrant } from './_youtube-connection-test-helper.js'
import {
  describeYouTubeCredential,
  resolveYouTubeAccountId,
  resolveYouTubeAccountIdForChannel,
  resolveYouTubeCredential,
} from '../services/youtube-credential.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function isolate(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return (await createProject({ name: 'Registry Credential' })).slug
}

describe('YouTube credential resolution', () => {
  test('ignores legacy OAuth records and requires a current registry assignment', async () => {
    const slug = await isolate()
    await legacy.writeOAuthClient(slug, 'youtube', { client_id: 'legacy-client', client_secret: 'legacy-secret' })
    const old = await legacy.addAccount(slug, 'youtube', {
      label: 'Old Channel', remote_id: 'UC-old', remote_title: 'Old Channel',
    })
    await legacy.writeTokens(slug, 'youtube', old.id, {
      access_token: 'legacy-access', refresh_token: 'legacy-refresh', expires_at: Date.now() + 60_000,
    })
    await legacy.setDefaultAccountId(slug, 'youtube', old.id)

    assert.equal(await resolveYouTubeCredential(slug), null)
    assert.equal(await resolveYouTubeAccountId(slug), '')
  })

  test('returns only the assigned healthy registry credential and rejects stale requested ids', async () => {
    const slug = await isolate()
    await configureYouTubeApplication({ client_id: 'registry-client', client_secret: 'registry-secret' })
    await saveYouTubeChannelGrant({
      channel: { channel_id: 'UC-current', title: 'Current Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'current-access', refresh_token: 'current-refresh', expires_at: Date.now() + 60_000 },
    })
    assert.equal(await resolveYouTubeCredential(slug), null)

    await assignProjectYouTubeChannel({ project_slug: slug, channel_id: 'UC-current', expected_previous_channel_id: null })
    assert.deepEqual(await resolveYouTubeCredential(slug), {
      accountId: 'registry:UC-current', channelId: 'UC-current', source: 'registry',
    })
    assert.equal(await resolveYouTubeAccountId(slug, 'legacy-account-id'), '')
    assert.equal(await resolveYouTubeAccountIdForChannel(slug, 'UC-current'), 'registry:UC-current')
    assert.equal(await resolveYouTubeAccountIdForChannel(slug, 'UC-other'), '')
    assert.deepEqual(await describeYouTubeCredential(slug, 'registry:UC-current'), {
      remote_id: 'UC-current', remote_title: 'Current Channel',
    })

    const otherSlug = (await createProject({ name: 'Other Registry Project' })).slug
    assert.equal(await describeYouTubeCredential(otherSlug, 'registry:UC-current'), null)

    await markYouTubeChannelStatus('UC-current', 'reconnect_required')
    assert.equal(await resolveYouTubeCredential(slug), null)
  })
})
