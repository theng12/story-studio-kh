import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import {
  assignProjectYouTubeChannel,
  authorizeProjectYouTubeAction,
  configureYouTubeApplication,
  disconnectYouTubeChannel,
  getProjectYouTubeAssignment,
  markYouTubeChannelStatus,
  readYouTubeChannelTokensForServer,
  readYouTubeConnectionRegistry,
  readYouTubeOAuthClientForServer,
  recoverYouTubeCredentialAuthority,
  saveYouTubeChannelTokens,
  unassignProjectYouTubeChannel,
  youtubeConnectionsPath,
  type YouTubeConnectionRegistryV1,
} from '../services/youtube-connection-store.js'
import { saveYouTubeChannelGrantForTest as saveYouTubeChannelGrant } from './_youtube-connection-test-helper.js'
import {
  appSecretsPath,
  contentStoreAnchorsPath,
  readAppSecrets,
  recordContentStoreKeyAnchor,
  youtubeSecretRecoveryRequired,
  writeAppSecrets,
} from '../services/app-secrets-store.js'
import { createProject } from '../services/project-manager.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function isolate() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return temp
}

async function withRegistryWriteFailure<T>(run: () => Promise<T>): Promise<T> {
  const mutableFs = fs as typeof fs & { rename: typeof fs.rename }
  const originalRename = mutableFs.rename
  mutableFs.rename = async (from, to) => {
    if (to === youtubeConnectionsPath()) {
      const error = Object.assign(new Error('injected registry write failure'), { code: 'EACCES' })
      throw error
    }
    return originalRename(from, to)
  }
  try {
    return await run()
  } finally {
    mutableFs.rename = originalRename
  }
}

const CLIENT_ID = 'youtube-client-id-test-value'
const CLIENT_SECRET = 'youtube-client-secret-connection-test-value'
const ACCESS_TOKEN = 'youtube-access-token-connection-test-value'
const REFRESH_TOKEN = 'youtube-refresh-token-connection-test-value'

async function createAssignmentProject(name: string): Promise<{ slug: string; dir: string }> {
  const project = await createProject({ name })
  return { slug: project.slug, dir: path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', project.slug) }
}

async function saveConnectedChannel(channelId: string, title = channelId): Promise<void> {
  await saveYouTubeChannelGrant({
    channel: { channel_id: channelId, title, granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: `access-token-${channelId}`,
      refresh_token: `refresh-token-${channelId}`,
      expires_at: 1_900_000_000_000,
    },
  })
}

function stored(value: unknown): string {
  return JSON.stringify(value)
}

describe('youtube-connection-store', () => {
  test('scoped recovery removes a malformed YouTube bucket and preserves public and immutable evidence', async () => {
    const temp = await isolate()
    const project = await createAssignmentProject('YouTube Scoped Secret Recovery')
    await writeAppSecrets(v3 => {
      v3.providers.genstudio = { apiKey: 'gsk_recovery_provider', userSet: true, generation: 'gen-recovery' }
    })
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-recovery', 'Recovery Channel')
    await assignProjectYouTubeChannel({
      project_slug: project.slug,
      channel_id: 'channel-recovery',
      expected_previous_channel_id: null,
    })
    await recordContentStoreKeyAnchor({
      origin: 'https://genstudio.example', account_id: 'acct', content_account_id: 'acct',
      keys: [{ key_id: 'key', public_key_base64: Buffer.alloc(32, 7).toString('base64') }],
    })
    const anchorsBefore = await fs.readFile(contentStoreAnchorsPath())
    const sidecarPath = path.join(project.dir, 'EP0001', 'upload.json')
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true })
    const sidecarBefore = Buffer.from('{"immutable":"youtube-video-id"}\n')
    await fs.writeFile(sidecarPath, sidecarBefore)
    const publicBefore = await readYouTubeConnectionRegistry()

    await fs.writeFile(appSecretsPath(), stored({
      schema_version: 3,
      providers: { genstudio: { apiKey: 'gsk_recovery_provider', userSet: true, generation: 'gen-recovery' } },
      social: { applications: { meta: { application_id: 'meta-app', client_secret: 'meta-secret-preserved' } } },
      youtube: { oauth_client: { application_id: publicBefore.application!.application_id } },
    }))
    assert.equal(await youtubeSecretRecoveryRequired(), true)

    const recovered = await recoverYouTubeCredentialAuthority()
    assert.equal(recovered.application, null)
    assert.equal(recovered.channels['channel-recovery']?.status, 'reconnect_required')
    assert.deepEqual(recovered.assignments, publicBefore.assignments)
    assert.deepEqual(recovered.assignment_history, publicBefore.assignment_history)
    assert.deepEqual(recovered.application_history, publicBefore.application_history)
    assert.equal((await readAppSecrets()).youtube, undefined)
    assert.equal((await readAppSecrets()).social?.applications?.meta?.client_secret, 'meta-secret-preserved')
    assert.deepEqual((await readAppSecrets()).providers.genstudio, {
      apiKey: 'gsk_recovery_provider', userSet: true, generation: 'gen-recovery',
    })
    assert.deepEqual(await fs.readFile(contentStoreAnchorsPath()), anchorsBefore)
    assert.deepEqual(await fs.readFile(sidecarPath), sidecarBefore)
    assert.equal(await youtubeSecretRecoveryRequired(), false)
  })



  test('scoped recovery refuses healthy, undecryptable, and provider-corrupt stores byte-for-byte', async () => {
    for (const [label, payload] of [
      ['healthy', stored({ schema_version: 3, providers: {}, youtube: {} })],
      ['undecryptable', JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'invalid-legacy-ciphertext' })],
      ['provider-corrupt', stored({ schema_version: 3, providers: { genstudio: [] }, youtube: { broken: true } })],
      ['unknown-provider', stored({ schema_version: 3, providers: { future: { apiKey: 'keep' } }, youtube: { broken: true } })],
      ['extra-provider-field', stored({ schema_version: 3, providers: { genstudio: { apiKey: 'keep', future: true } }, youtube: { broken: true } })],
      ['invalid-user-set', stored({ schema_version: 3, providers: { genstudio: { apiKey: 'keep', userSet: 'yes' } }, youtube: { broken: true } })],
      ['invalid-generation', stored({ schema_version: 3, providers: { genstudio: { apiKey: 'keep', generation: '' } }, youtube: { broken: true } })],
    ] as const) {
      await cleanup?.(); cleanup = undefined
      await isolate()
      await fs.writeFile(appSecretsPath(), payload)
      const before = await fs.readFile(appSecretsPath())
      await assert.rejects(recoverYouTubeCredentialAuthority(), /eligible|provider|invalid/i, label)
      assert.deepEqual(await fs.readFile(appSecretsPath()), before, label)
    }
  })

  test('returns the empty version-one registry when connections.json is missing', async () => {
    await isolate()
    assert.deepEqual(await readYouTubeConnectionRegistry(), {
      schema_version: 1,
      application: null,
      application_history: [],
      channels: {},
      assignments: {},
      assignment_history: [],
    })
    assert.match(youtubeConnectionsPath(), /youtube[\\/]connections\.json$/)
  })

  test('configures a public application while keeping the client secret server-only', async () => {
    await isolate()
    const application = await configureYouTubeApplication({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      google_cloud_project_id: 'cloud-project-test',
    })

    assert.match(application.application_id, /^youtube_app_[0-9a-f-]{36}$/)
    assert.equal(application.client_id, CLIENT_ID)
    assert.equal(application.google_cloud_project_id, 'cloud-project-test')
    assert.match(application.fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(application).includes(CLIENT_SECRET), false)

    const registry = await readYouTubeConnectionRegistry()
    assert.deepEqual(registry.application, application)
    const publicJson = JSON.stringify(registry)
    assert.equal(publicJson.includes(CLIENT_SECRET), false)

    const secrets = await readYouTubeOAuthClientForServer()
    assert.deepEqual(secrets, {
      application_id: application.application_id,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    const rawAppSecrets = await fs.readFile(appSecretsPath(), 'utf8')
    assert.equal(JSON.parse(rawAppSecrets).__encrypted, undefined)
    assert.equal(rawAppSecrets.includes(CLIENT_SECRET), true)
  })

  test('saves immutable channel metadata publicly and token bundles only in app secrets', async () => {
    await isolate()
    const application = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    const channel = await saveYouTubeChannelGrant({
      channel: {
        channel_id: 'channel-immutable-test',
        title: 'Test Channel',
        handle: '@test-channel',
        thumbnail_url: 'https://example.test/channel.png',
        granted_scopes: ['youtube.upload', 'youtube.readonly'],
      },
      tokens: {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_at: 1_900_000_000_000,
        scope: 'youtube.upload youtube.readonly',
      },
    })

    assert.equal(channel.channel_id, 'channel-immutable-test')
    assert.equal(channel.application_id, application.application_id)
    assert.equal(channel.status, 'connected')
    const registry = await readYouTubeConnectionRegistry()
    assert.deepEqual(registry.channels[channel.channel_id], channel)
    assert.equal(JSON.stringify(registry).includes(ACCESS_TOKEN), false)
    assert.equal(JSON.stringify(registry).includes(REFRESH_TOKEN), false)
    assert.deepEqual(await readYouTubeChannelTokensForServer(channel.channel_id), {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_at: 1_900_000_000_000,
      scope: 'youtube.upload youtube.readonly',
    })
  })

  test('refresh token writes use compare-and-swap and preserve a newer winner', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('UC-refresh-cas')
    const before = await readYouTubeChannelTokensForServer('UC-refresh-cas')
    assert.ok(before)

    assert.equal(await saveYouTubeChannelTokens({
      channel_id: 'UC-refresh-cas',
      expected_access_token: 'stale-reader-token',
      tokens: { ...before, access_token: 'losing-refresh-token' },
    }), false)
    assert.equal((await readYouTubeChannelTokensForServer('UC-refresh-cas'))?.access_token, before.access_token)

    assert.equal(await saveYouTubeChannelTokens({
      channel_id: 'UC-refresh-cas',
      expected_access_token: before.access_token,
      tokens: { ...before, access_token: 'winning-refresh-token' },
    }), true)
    assert.equal((await readYouTubeChannelTokensForServer('UC-refresh-cas'))?.access_token, 'winning-refresh-token')
  })





  test('marks existing grants reconnect_required on application replacement and preserves assignments/history', async () => {
    await isolate()
    const first = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-replaced-a', title: 'A', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'access-a-test-value', refresh_token: 'refresh-a-test-value', expires_at: 1_900_000_000_000 },
    })
    await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-replaced-b', title: 'B', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'access-b-test-value', refresh_token: 'refresh-b-test-value', expires_at: 1_900_000_000_000 },
    })

    const before = await readYouTubeConnectionRegistry()
    before.assignments = {
      project_one: { project_slug: 'project_one', channel_id: 'channel-replaced-a', assigned_at: '2026-08-31T00:00:00.000Z' },
    }
    before.assignment_history = [{
      project_slug: 'project_one',
      previous_channel_id: null,
      next_channel_id: 'channel-replaced-a',
      changed_at: '2026-08-31T00:00:00.000Z',
    }]
    await fs.writeFile(youtubeConnectionsPath(), `${JSON.stringify(before, null, 2)}\n`)

    const replacement = await configureYouTubeApplication({
      client_id: 'youtube-client-id-replacement-test-value',
      client_secret: 'youtube-client-secret-replacement-test-value',
      google_cloud_project_id: 'cloud-project-replacement',
    })
    assert.notEqual(replacement.application_id, first.application_id)
    assert.notEqual(replacement.fingerprint, first.fingerprint)

    const after = await readYouTubeConnectionRegistry()
    assert.equal(after.application?.application_id, replacement.application_id)
    assert.equal(after.application_history.length, 1)
    assert.deepEqual(after.application_history[0], {
      application_id: first.application_id,
      fingerprint: first.fingerprint,
      replaced_at: after.application_history[0]?.replaced_at,
    })
    assert.equal(after.channels['channel-replaced-a']?.status, 'reconnect_required')
    assert.equal(after.channels['channel-replaced-b']?.status, 'reconnect_required')
    assert.deepEqual(after.assignments, before.assignments)
    assert.deepEqual(after.assignment_history, before.assignment_history)
    assert.equal(JSON.stringify(after).includes('youtube-client-secret-replacement-test-value'), false)
    assert.deepEqual(await readYouTubeOAuthClientForServer(), {
      application_id: replacement.application_id,
      client_id: 'youtube-client-id-replacement-test-value',
      client_secret: 'youtube-client-secret-replacement-test-value',
    })
    assert.deepEqual((await readAppSecrets()).youtube?.channel_tokens, {})
  })

  test('same-credential application metadata update keeps connected channel tokens', async () => {
    await isolate()
    const first = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-same-app')
    const before = await readYouTubeChannelTokensForServer('channel-same-app')

    const updated = await configureYouTubeApplication({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      google_cloud_project_id: 'updated-cloud-project',
    })

    assert.equal(updated.application_id, first.application_id)
    assert.equal(updated.google_cloud_project_id, 'updated-cloud-project')
    assert.deepEqual(await readYouTubeChannelTokensForServer('channel-same-app'), before)
    assert.equal((await readYouTubeConnectionRegistry()).channels['channel-same-app']?.status, 'connected')
  })

  test('preserves old per-project secret files when replacing the app', async () => {
    const temp = await isolate()
    const oldProjectSecret = 'old-project-secret-must-remain-test-value'
    const projectDir = `${temp.dir}/projects/legacy-project`
    const secretPath = `${projectDir}/secrets.json`
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(secretPath, JSON.stringify({ upload_oauth_client: { client_secret: oldProjectSecret } }))

    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await configureYouTubeApplication({ client_id: 'youtube-client-id-second-test-value', client_secret: 'youtube-client-secret-second-test-value' })
    assert.equal(await fs.readFile(secretPath, 'utf8'), JSON.stringify({ upload_oauth_client: { client_secret: oldProjectSecret } }))
  })

  test('keeps malformed registry bytes intact and reports corruption', async () => {
    await isolate()
    const corrupt = '{"schema_version":1, bad json\n'
    await fs.mkdir(new URL('.', `file://${youtubeConnectionsPath()}`), { recursive: true }).catch(() => {})
    await fs.writeFile(youtubeConnectionsPath(), corrupt)
    await assert.rejects(readYouTubeConnectionRegistry(), /corrupt|JSON|parse/i)
    assert.equal(await fs.readFile(youtubeConnectionsPath(), 'utf8'), corrupt)
  })

  test('marks a saved channel reconnect_required without exposing token values', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-status-test', title: 'Status', granted_scopes: [] },
      tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_900_000_000_000 },
    })
    const updated = await markYouTubeChannelStatus('channel-status-test', 'reconnect_required')
    assert.equal(updated.status, 'reconnect_required')
    assert.equal(JSON.stringify(updated).includes(ACCESS_TOKEN), false)
    assert.equal(JSON.stringify(await readYouTubeConnectionRegistry()).includes(REFRESH_TOKEN), false)
  })

  test('does not return a stale channel token after replacing the configured application', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-stale-app-test', title: 'Stale', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_900_000_000_000 },
    })

    await configureYouTubeApplication({
      client_id: 'youtube-client-id-current-test-value',
      client_secret: 'youtube-client-secret-current-test-value',
    })

    assert.equal(await readYouTubeChannelTokensForServer('channel-stale-app-test'), null)
  })

  test('does not promote reconnect_required back to connected without a fresh grant', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-status-transition-test', title: 'Transition', granted_scopes: [] },
      tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_900_000_000_000 },
    })
    await configureYouTubeApplication({
      client_id: 'youtube-client-id-transition-test-value',
      client_secret: 'youtube-client-secret-transition-test-value',
    })

    await assert.rejects(
      markYouTubeChannelStatus('channel-status-transition-test', 'connected'),
      /fresh grant|reconnect_required|connected/i,
    )
    assert.equal(
      (await readYouTubeConnectionRegistry()).channels['channel-status-transition-test']?.status,
      'reconnect_required',
    )
  })

  test('restores connected status and token access only after a fresh grant under the current application', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-fresh-grant-test', title: 'Fresh', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_900_000_000_000 },
    })
    const replacement = await configureYouTubeApplication({
      client_id: 'youtube-client-id-fresh-test-value',
      client_secret: 'youtube-client-secret-fresh-test-value',
    })

    await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-fresh-grant-test', title: 'Fresh again', granted_scopes: ['youtube.upload'] },
      tokens: {
        access_token: 'youtube-access-token-fresh-test-value',
        refresh_token: 'youtube-refresh-token-fresh-test-value',
        expires_at: 1_910_000_000_000,
      },
    })
    const updated = await readYouTubeConnectionRegistry()
    assert.equal(updated.channels['channel-fresh-grant-test']?.application_id, replacement.application_id)
    assert.equal(updated.channels['channel-fresh-grant-test']?.status, 'connected')
    assert.deepEqual(await readYouTubeChannelTokensForServer('channel-fresh-grant-test'), {
      access_token: 'youtube-access-token-fresh-test-value',
      refresh_token: 'youtube-refresh-token-fresh-test-value',
      expires_at: 1_910_000_000_000,
    })
  })

  test('keeps a pending replacement transaction when the public registry write fails and recovers it on retry', async () => {
    await isolate()
    const first = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-journal-replaced')
    const replacementClientId = 'youtube-client-id-journal-replacement-test-value'
    const replacementClientSecret = 'youtube-client-secret-journal-replacement-test-value'

    await assert.rejects(
      withRegistryWriteFailure(() => configureYouTubeApplication({
        client_id: replacementClientId,
        client_secret: replacementClientSecret,
      })),
      /injected registry write failure|EACCES/i,
    )

    const pendingSecrets = await readAppSecrets()
    const pendingRegistry = pendingSecrets.youtube?.pending_registry?.registry as unknown as YouTubeConnectionRegistryV1 | undefined
    assert.equal(pendingSecrets.youtube?.pending_registry?.transaction_id !== undefined, true)
    assert.equal(pendingRegistry?.application?.client_id, replacementClientId)
    assert.deepEqual(pendingSecrets.youtube?.channel_tokens, {})
    const pendingAppSecretsBytes = await fs.readFile(appSecretsPath(), 'utf8')
    assert.equal(JSON.parse(pendingAppSecretsBytes).__encrypted, undefined)
    assert.equal(pendingAppSecretsBytes.includes(replacementClientSecret), true)
    const registryBytesAfterFailure = JSON.parse(await fs.readFile(youtubeConnectionsPath(), 'utf8'))
    assert.equal(registryBytesAfterFailure.application.application_id, first.application_id)
    assert.equal(await readYouTubeOAuthClientForServer().then((value) => value?.client_secret), replacementClientSecret)
    assert.equal((await readAppSecrets()).youtube?.pending_registry, undefined)
    assert.equal(await readYouTubeChannelTokensForServer('channel-journal-replaced'), null)
  })

  test('keeps a pending channel-grant transaction with private tokens when the public registry write fails and recovers it on retry', async () => {
    await isolate()
    const application = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    const channelId = 'channel-journal-grant-test'
    const accessToken = 'youtube-access-token-journal-test-value'
    const refreshToken = 'youtube-refresh-token-journal-test-value'

    await assert.rejects(
      withRegistryWriteFailure(() => saveYouTubeChannelGrant({
        channel: { channel_id: channelId, title: 'Journal', granted_scopes: ['youtube.upload'] },
        tokens: { access_token: accessToken, refresh_token: refreshToken, expires_at: 1_920_000_000_000 },
      })),
      /injected registry write failure|EACCES/i,
    )

    const pendingSecrets = await readAppSecrets()
    const pendingRegistry = pendingSecrets.youtube?.pending_registry?.registry as unknown as YouTubeConnectionRegistryV1 | undefined
    assert.equal(pendingSecrets.youtube?.pending_registry?.transaction_id !== undefined, true)
    assert.equal(pendingRegistry?.channels[channelId]?.application_id, application.application_id)
    assert.equal(pendingSecrets.youtube?.channel_tokens?.[channelId]?.access_token, accessToken)
    const pendingAppSecretsBytes = await fs.readFile(appSecretsPath(), 'utf8')
    assert.equal(JSON.parse(pendingAppSecretsBytes).__encrypted, undefined)
    assert.equal(pendingAppSecretsBytes.includes(accessToken), true)
    assert.equal(pendingAppSecretsBytes.includes(refreshToken), true)
    const registryBytesAfterFailure = JSON.parse(await fs.readFile(youtubeConnectionsPath(), 'utf8'))
    assert.equal(registryBytesAfterFailure.channels[channelId], undefined)

    assert.deepEqual(await readYouTubeChannelTokensForServer(channelId), {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: 1_920_000_000_000,
    })
    assert.equal((await readAppSecrets()).youtube?.pending_registry, undefined)
  })

  test('validates the complete grant before storing optional metadata or tokens', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    const channelId = 'channel-invalid-grant-test'

    await assert.rejects(
      saveYouTubeChannelGrant({
        channel: {
          channel_id: channelId,
          title: 'Invalid grant',
          handle: 42 as unknown as string,
          thumbnail_url: null as unknown as string,
          granted_scopes: ['youtube.upload', 7 as unknown as string],
        },
        tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_900_000_000_000 },
      }),
      /grant|channel|scope|string|invalid/i,
    )
    assert.equal((await readAppSecrets()).youtube?.channel_tokens?.[channelId], undefined)
    assert.equal((await readYouTubeConnectionRegistry()).channels[channelId], undefined)
  })

  test('rejects reserved channel map keys without leaving an orphan token', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })

    for (const channelId of ['__proto__', 'constructor', 'prototype']) {
      await assert.rejects(
        saveYouTubeChannelGrant({
          channel: { channel_id: channelId, title: 'Reserved', granted_scopes: [] },
          tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_900_000_000_000 },
        }),
        /reserved|channel|invalid/i,
      )
      const tokens = (await readAppSecrets()).youtube?.channel_tokens
      assert.equal(tokens ? Object.prototype.hasOwnProperty.call(tokens, channelId) : false, false)
      const channels = (await readYouTubeConnectionRegistry()).channels
      assert.equal(Object.prototype.hasOwnProperty.call(channels, channelId), false)
    }
  })

  test('rejects unsafe provider channel ids without mutating either store', async () => {
    const temp = await isolate()
    const application = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    const registryBytes = await fs.readFile(youtubeConnectionsPath())
    const secretBytes = await fs.readFile(appSecretsPath())

    for (const channelId of ['../escape', 'UC/path', 'UC\\path', 'UC\0path', '.', '..', 'UC:windows']) {
      await assert.rejects(
        saveYouTubeChannelGrant({
          expected_application_id: application.application_id,
          channel: { channel_id: channelId, title: 'Unsafe', granted_scopes: [] },
          tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_900_000_000_000 },
        }),
        /channel_id.*invalid|reserved/i,
      )
      assert.deepEqual(await fs.readFile(youtubeConnectionsPath()), registryBytes)
      assert.deepEqual(await fs.readFile(appSecretsPath()), secretBytes)
    }
    assert.equal(await fs.access(path.join(temp.dir, 'youtube-quota')).then(() => true, () => false), false)
  })

  test('rejects unsafe channels plus duplicate and dangling assignments in a stored registry', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-assignment-integrity')
    const base = await readYouTubeConnectionRegistry()

    const unsafeChannel = structuredClone(base)
    const safeChannel = unsafeChannel.channels['channel-assignment-integrity']!
    delete unsafeChannel.channels['channel-assignment-integrity']
    unsafeChannel.channels['../outside'] = { ...safeChannel, channel_id: '../outside' }
    await fs.writeFile(youtubeConnectionsPath(), JSON.stringify(unsafeChannel))
    await assert.rejects(readYouTubeConnectionRegistry(), /corrupt/i)

    const duplicate = structuredClone(base)
    duplicate.assignments = {
      project_a: { project_slug: 'project_a', channel_id: 'channel-assignment-integrity', assigned_at: '2026-09-05T00:00:00.000Z' },
      project_b: { project_slug: 'project_b', channel_id: 'channel-assignment-integrity', assigned_at: '2026-09-05T00:00:00.000Z' },
    }
    await fs.writeFile(youtubeConnectionsPath(), JSON.stringify(duplicate))
    await assert.rejects(readYouTubeConnectionRegistry(), /corrupt/i)

    const dangling = structuredClone(base)
    dangling.assignments = {
      project_a: { project_slug: 'project_a', channel_id: 'channel-missing', assigned_at: '2026-09-05T00:00:00.000Z' },
    }
    await fs.writeFile(youtubeConnectionsPath(), JSON.stringify(dangling))
    await assert.rejects(readYouTubeConnectionRegistry(), /corrupt/i)
  })

  test('distinguishes registry filesystem I/O errors from schema corruption while failing closed', async () => {
    await isolate()
    await fs.mkdir(youtubeConnectionsPath(), { recursive: true })

    await assert.rejects(readYouTubeConnectionRegistry(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR')
      assert.doesNotMatch((error as Error).message, /corrupt/i)
      return true
    })
  })

  test('labels invalid registry JSON schema as corruption', async () => {
    await isolate()
    await fs.mkdir(new URL('.', `file://${youtubeConnectionsPath()}`), { recursive: true })
    await fs.writeFile(youtubeConnectionsPath(), JSON.stringify({ schema_version: 99 }))

    await assert.rejects(readYouTubeConnectionRegistry(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'YOUTUBE_CONNECTION_REGISTRY_CORRUPT')
      assert.match((error as Error).message, /corrupt/i)
      return true
    })
  })

  test('rejects inherited and reserved channel keys before status or token lookup can mutate globals', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })

    const targets = [
      { object: Object.prototype, key: 'status' },
      { object: Object.prototype, key: 'updated_at' },
      { object: Object, key: 'status' },
      { object: Object, key: 'updated_at' },
      { object: Object.prototype.toString, key: 'status' },
      { object: Object.prototype.toString, key: 'updated_at' },
    ]
    const descriptors = targets.map(target => ({
      ...target,
      descriptor: Object.getOwnPropertyDescriptor(target.object, target.key),
    }))
    const originalToString = Object.prototype.toString

    try {
      for (const channelId of ['__proto__', 'constructor', 'prototype', 'toString']) {
        await assert.rejects(
          markYouTubeChannelStatus(channelId, 'reconnect_required'),
          /reserved|channel|invalid|not connected/i,
        )
        assert.equal(await readYouTubeChannelTokensForServer(channelId), null)
      }

      for (const target of descriptors) {
        assert.deepEqual(Object.getOwnPropertyDescriptor(target.object, target.key), target.descriptor)
      }
      assert.equal(Object.prototype.toString, originalToString)
    } finally {
      for (const target of descriptors) {
        if (target.descriptor) Object.defineProperty(target.object, target.key, target.descriptor)
        else delete (target.object as Record<string, unknown>)[target.key]
      }
    }
  })

  test('returns null for an unassigned project and makes repeated assignment idempotent', async () => {
    await isolate()
    const project = await createAssignmentProject('YouTube Assignment Idempotent')
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-assignment-idempotent')

    assert.equal(await getProjectYouTubeAssignment(project.slug), null)
    const assigned = await assignProjectYouTubeChannel({
      project_slug: project.slug,
      channel_id: 'channel-assignment-idempotent',
      expected_previous_channel_id: null,
    })
    assert.deepEqual(await getProjectYouTubeAssignment(project.slug), assigned)
    assert.deepEqual(
      await assignProjectYouTubeChannel({
        project_slug: project.slug,
        channel_id: 'channel-assignment-idempotent',
        expected_previous_channel_id: assigned.channel_id,
      }),
      assigned,
    )
    assert.equal((await readYouTubeConnectionRegistry()).assignment_history.length, 1)
  })

  test('enforces one project per channel and exact replacement/unassignment compare-and-swap', async () => {
    await isolate()
    const firstProject = await createAssignmentProject('YouTube Assignment First')
    const secondProject = await createAssignmentProject('YouTube Assignment Second')
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-assignment-first')
    await saveConnectedChannel('channel-assignment-second')

    const first = await assignProjectYouTubeChannel({
      project_slug: firstProject.slug,
      channel_id: 'channel-assignment-first',
      expected_previous_channel_id: null,
    })
    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: secondProject.slug,
        channel_id: 'channel-assignment-first',
        expected_previous_channel_id: null,
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_ALREADY_ASSIGNED',
    )
    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: firstProject.slug,
        channel_id: 'channel-assignment-second',
        expected_previous_channel_id: null,
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_ASSIGNMENT_CHANGED',
    )

    const replacement = await assignProjectYouTubeChannel({
      project_slug: firstProject.slug,
      channel_id: 'channel-assignment-second',
      expected_previous_channel_id: first.channel_id,
    })
    assert.equal(replacement.channel_id, 'channel-assignment-second')
    assert.deepEqual(
      await assignProjectYouTubeChannel({
        project_slug: secondProject.slug,
        channel_id: 'channel-assignment-first',
        expected_previous_channel_id: null,
      }),
      await getProjectYouTubeAssignment(secondProject.slug),
    )
    await assert.rejects(
      unassignProjectYouTubeChannel({
        project_slug: firstProject.slug,
        expected_channel_id: 'channel-assignment-first',
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_ASSIGNMENT_CHANGED',
    )
    await unassignProjectYouTubeChannel({
      project_slug: firstProject.slug,
      expected_channel_id: 'channel-assignment-second',
    })

    const registry = await readYouTubeConnectionRegistry()
    assert.equal(registry.assignments[firstProject.slug], undefined)
    assert.deepEqual(registry.assignment_history.map(entry => ({
      project_slug: entry.project_slug,
      previous_channel_id: entry.previous_channel_id,
      next_channel_id: entry.next_channel_id,
    })), [
      { project_slug: firstProject.slug, previous_channel_id: null, next_channel_id: 'channel-assignment-first' },
      { project_slug: firstProject.slug, previous_channel_id: 'channel-assignment-first', next_channel_id: 'channel-assignment-second' },
      { project_slug: secondProject.slug, previous_channel_id: null, next_channel_id: 'channel-assignment-first' },
      { project_slug: firstProject.slug, previous_channel_id: 'channel-assignment-second', next_channel_id: null },
    ])
  })

  test('rejects disconnected and wrong-application channels before assignment', async () => {
    await isolate()
    const project = await createAssignmentProject('YouTube Assignment Connection Guards')
    const first = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-assignment-disconnected')
    await markYouTubeChannelStatus('channel-assignment-disconnected', 'reconnect_required')
    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: project.slug,
        channel_id: 'channel-assignment-disconnected',
        expected_previous_channel_id: null,
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_NOT_CONNECTED',
    )

    const replacement = await configureYouTubeApplication({
      client_id: 'youtube-client-id-assignment-current-test-value',
      client_secret: 'youtube-client-secret-assignment-current-test-value',
    })
    const registry = await readYouTubeConnectionRegistry()
    const stale = registry.channels['channel-assignment-disconnected']
    assert.ok(stale)
    registry.channels['channel-assignment-disconnected'] = {
      ...stale,
      application_id: first.application_id,
      status: 'connected',
    }
    await fs.writeFile(youtubeConnectionsPath(), `${JSON.stringify(registry, null, 2)}\n`)
    assert.notEqual(replacement.application_id, first.application_id)
    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: project.slug,
        channel_id: 'channel-assignment-disconnected',
        expected_previous_channel_id: null,
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_NOT_CONNECTED',
    )
  })

  test('revalidates an idempotent assignment after the channel becomes disconnected', async () => {
    await isolate()
    const project = await createAssignmentProject('YouTube Assignment Idempotent Disconnect')
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-assignment-idempotent-disconnect')
    const assignment = await assignProjectYouTubeChannel({
      project_slug: project.slug,
      channel_id: 'channel-assignment-idempotent-disconnect',
      expected_previous_channel_id: null,
    })
    await markYouTubeChannelStatus('channel-assignment-idempotent-disconnect', 'reconnect_required')
    const before = await readYouTubeConnectionRegistry()

    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: project.slug,
        channel_id: assignment.channel_id,
        expected_previous_channel_id: assignment.channel_id,
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_NOT_CONNECTED',
    )
    assert.deepEqual(await readYouTubeConnectionRegistry(), before)
  })

  test('revalidates an idempotent assignment after the OAuth application becomes stale', async () => {
    await isolate()
    const project = await createAssignmentProject('YouTube Assignment Idempotent Stale App')
    const first = await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-assignment-idempotent-stale-app')
    const assignment = await assignProjectYouTubeChannel({
      project_slug: project.slug,
      channel_id: 'channel-assignment-idempotent-stale-app',
      expected_previous_channel_id: null,
    })
    await configureYouTubeApplication({
      client_id: 'youtube-client-id-idempotent-stale-app-test-value',
      client_secret: 'youtube-client-secret-idempotent-stale-app-test-value',
    })
    const before = await readYouTubeConnectionRegistry()
    assert.equal(before.channels[assignment.channel_id]?.application_id, first.application_id)
    assert.equal(before.channels[assignment.channel_id]?.status, 'reconnect_required')

    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: project.slug,
        channel_id: assignment.channel_id,
        expected_previous_channel_id: assignment.channel_id,
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_NOT_CONNECTED',
    )
    assert.deepEqual(await readYouTubeConnectionRegistry(), before)
  })

  test('rejects missing or corrupt project metadata without writing an assignment', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-assignment-project-validation')

    const missingProject = await createAssignmentProject('YouTube Assignment Missing Project')
    await fs.rm(path.join(missingProject.dir, 'project.json'))
    const beforeMissing = await fs.readFile(youtubeConnectionsPath(), 'utf8')
    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: missingProject.slug,
        channel_id: 'channel-assignment-project-validation',
        expected_previous_channel_id: null,
      }),
      /project|metadata|not found/i,
    )
    assert.equal(await fs.readFile(youtubeConnectionsPath(), 'utf8'), beforeMissing)

    const corruptProject = await createAssignmentProject('YouTube Assignment Corrupt Project')
    const corruptPath = path.join(corruptProject.dir, 'project.json')
    const corruptBytes = '{"name":"corrupt project"'
    await fs.writeFile(corruptPath, corruptBytes)
    const beforeCorrupt = await fs.readFile(youtubeConnectionsPath(), 'utf8')
    await assert.rejects(
      assignProjectYouTubeChannel({
        project_slug: corruptProject.slug,
        channel_id: 'channel-assignment-project-validation',
        expected_previous_channel_id: null,
      }),
      /corrupt|parse|metadata/i,
    )
    assert.equal(await fs.readFile(youtubeConnectionsPath(), 'utf8'), beforeCorrupt)
    assert.equal(await fs.readFile(corruptPath, 'utf8'), corruptBytes)
  })

  test('rejects unassigned, stale, wrong-channel, and foreign-video authorization before provider work', async () => {
    await isolate()
    const unassignedProject = await createAssignmentProject('YouTube Authorization Unassigned')
    const assignedProject = await createAssignmentProject('YouTube Authorization Assigned')
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-authorization-current')
    await saveConnectedChannel('channel-authorization-foreign')
    await assignProjectYouTubeChannel({
      project_slug: assignedProject.slug,
      channel_id: 'channel-authorization-current',
      expected_previous_channel_id: null,
    })

    let providerCalls = 0
    const invokeProvider = async (input: Parameters<typeof authorizeProjectYouTubeAction>[0]) => {
      const authorized = await authorizeProjectYouTubeAction(input)
      providerCalls++
      return authorized
    }

    await assert.rejects(
      invokeProvider({ project_slug: unassignedProject.slug }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_NOT_ASSIGNED',
    )
    await assert.rejects(
      invokeProvider({
        project_slug: assignedProject.slug,
        expected_channel_id: 'channel-authorization-foreign',
        video_channel_id: 'channel-authorization-current',
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_ASSIGNMENT_CHANGED',
    )
    await assert.rejects(
      invokeProvider({
        project_slug: assignedProject.slug,
        expected_channel_id: 'channel-authorization-current',
        video_channel_id: 'channel-authorization-foreign',
      }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_MISMATCH',
    )
    assert.equal(providerCalls, 0)

    const authorized = await invokeProvider({
      project_slug: assignedProject.slug,
      expected_channel_id: 'channel-authorization-current',
      video_channel_id: 'channel-authorization-current',
    })
    assert.equal(providerCalls, 1)
    assert.equal(authorized.assignment.channel_id, 'channel-authorization-current')
    assert.equal(authorized.channel.channel_id, 'channel-authorization-current')
  })

  test('records the authorization time on every grant and keeps an older record without one readable', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })

    const first = await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-health', title: 'Health', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_920_000_000_000 },
    })
    assert.equal(typeof first.last_refresh_at, 'string')
    assert.equal(first.last_refresh_at, first.updated_at)

    const second = await saveYouTubeChannelGrant({
      channel: { channel_id: 'channel-health', title: 'Health', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: 1_930_000_000_000 },
    })
    assert.equal(Date.parse(second.last_refresh_at!) >= Date.parse(first.last_refresh_at!), true)
    assert.equal(second.connected_at, first.connected_at)

    // A registry written before this field existed must stay valid, not corrupt.
    const raw = JSON.parse(await fs.readFile(youtubeConnectionsPath(), 'utf8'))
    delete raw.channels['channel-health'].last_refresh_at
    await fs.writeFile(youtubeConnectionsPath(), JSON.stringify(raw))
    const reloaded = await readYouTubeConnectionRegistry()
    assert.equal(reloaded.channels['channel-health']?.last_refresh_at, undefined)
    assert.equal(reloaded.channels['channel-health']?.status, 'connected')
  })

  test('disconnecting a channel removes its grant, its tokens, and its assignment together', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    const project = await createAssignmentProject('Disconnect Project')
    await saveConnectedChannel('channel-disconnect')
    await saveConnectedChannel('channel-kept')
    await assignProjectYouTubeChannel({
      project_slug: project.slug,
      channel_id: 'channel-disconnect',
      expected_previous_channel_id: null,
    })

    await disconnectYouTubeChannel({ channel_id: 'channel-disconnect' })

    const registry = await readYouTubeConnectionRegistry()
    assert.equal(Object.prototype.hasOwnProperty.call(registry.channels, 'channel-disconnect'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(registry.channels, 'channel-kept'), true)
    assert.equal(Object.prototype.hasOwnProperty.call(registry.assignments, project.slug), false)
    assert.deepEqual(registry.assignment_history.at(-1)?.previous_channel_id, 'channel-disconnect')
    assert.deepEqual(registry.assignment_history.at(-1)?.next_channel_id, null)

    assert.equal(await readYouTubeChannelTokensForServer('channel-disconnect'), null)
    assert.notEqual(await readYouTubeChannelTokensForServer('channel-kept'), null)
    assert.equal((await readAppSecrets()).youtube?.channel_tokens?.['channel-disconnect'], undefined)

    await assert.rejects(
      authorizeProjectYouTubeAction({ project_slug: project.slug }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_NOT_ASSIGNED',
    )
  })

  test('disconnecting an unconnected channel changes nothing', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-present')
    const before = await fs.readFile(youtubeConnectionsPath(), 'utf8')

    await assert.rejects(
      disconnectYouTubeChannel({ channel_id: 'channel-absent' }),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_CHANNEL_NOT_CONNECTED',
    )
    assert.equal(await fs.readFile(youtubeConnectionsPath(), 'utf8'), before)
    assert.notEqual(await readYouTubeChannelTokensForServer('channel-present'), null)
  })

  test('keeps a pending disconnect transaction when the public registry write fails and recovers it on retry', async () => {
    await isolate()
    await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    await saveConnectedChannel('channel-disconnect-journal')

    await assert.rejects(
      withRegistryWriteFailure(() => disconnectYouTubeChannel({ channel_id: 'channel-disconnect-journal' })),
      /injected registry write failure|EACCES/i,
    )

    const pending = (await readAppSecrets()).youtube?.pending_registry
    const pendingRegistry = pending?.registry as unknown as YouTubeConnectionRegistryV1 | undefined
    assert.equal(pending?.transaction_id !== undefined, true)
    assert.equal(Object.prototype.hasOwnProperty.call(pendingRegistry!.channels, 'channel-disconnect-journal'), false)

    // The next read rolls the journalled transaction forward.
    const recovered = await readYouTubeConnectionRegistry()
    assert.equal(Object.prototype.hasOwnProperty.call(recovered.channels, 'channel-disconnect-journal'), false)
    assert.equal((await readAppSecrets()).youtube?.pending_registry, undefined)
    assert.equal(await readYouTubeChannelTokensForServer('channel-disconnect-journal'), null)
  })
})
