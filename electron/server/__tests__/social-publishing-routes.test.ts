import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { FakeSocial } from './fixtures/fake-social.js'
import { __resetSocialTransportForTests, __setSocialTransportForTests } from '../lib/social-publish/types.js'

// One import-time boot so module state binds to a temp data dir, then every
// test claims its own — the pattern `youtube-connections-route.test.ts` uses.
const boot = await useTempDataDir()
const store = await import('../services/social-connection-store.js')
const connect = await import('../services/social-connect.js')
const oauth = await import('../lib/social-oauth.js')
type SocialOAuthDeps = import('../lib/social-oauth.js').SocialOAuthDeps
type SocialOAuthFlowStatus = import('../lib/social-oauth.js').SocialOAuthFlowStatus
const { router } = await import('../routes/social-publishing.js')
const { createProject, updateConfig } = await import('../services/project-manager.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetSocialTransportForTests()
  oauth.__resetSocialOAuthFlowsForTests()
  connect.__resetSocialConnectsForTests()
  await cleanup?.()
  cleanup = undefined
})

const CLIENT_SECRET = 'meta-client-secret-value'
const TIKTOK_SECRET = 'tiktok-client-secret-value'

async function isolate(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return temp.dir
}

async function withApplications(): Promise<void> {
  await isolate()
  await store.configureSocialApplication({
    provider: 'meta',
    client_id: 'meta-client-id',
    client_secret: CLIENT_SECRET,
    redirect_uri: 'http://127.0.0.1:41234/callback',
  })
  await store.configureSocialApplication({
    provider: 'tiktok',
    client_id: 'tiktok-client-key',
    client_secret: TIKTOK_SECRET,
    redirect_uri: 'http://127.0.0.1:41235/callback',
  })
}

/** A provider-free OAuth seam: nothing binds a port and nothing leaves the process. */
function fakeDeps(input: {
  provider: 'meta' | 'tiktok'
  accounts?: Array<{
    platform: 'facebook' | 'instagram' | 'tiktok'
    remote_id: string
    remote_name: string
    page_id?: string
  }>
  scope?: string
  open_id?: string
  exchangeFails?: boolean
}) {
  let handler: ((request: { host: string; port: number; path: string; query: Record<string, string> }) => Promise<string>) | undefined
  const deps: SocialOAuthDeps = {
    async exchangeCode(args) {
      if (input.exchangeFails) {
        throw Object.assign(new Error('invalid_grant'), { code: 'SOCIAL_OAUTH_REJECTED' })
      }
      return {
        access_token: `${input.provider}-user-token-value`,
        refresh_token: `${input.provider}-refresh-token-value`,
        expires_at: Date.now() + 3_600_000,
        scope: input.scope ?? oauth.SOCIAL_SCOPES[input.provider].join(' '),
        ...(input.open_id ? { open_id: input.open_id } : {}),
      }
    },
    async fetchAccounts() {
      const tokens = {
        application_id: `${input.provider}:${input.provider === 'meta' ? 'meta-client-id' : 'tiktok-client-key'}`,
        access_token: `${input.provider}-user-token-value`,
        refresh_token: '',
        expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
        page_token: input.provider === 'meta' ? 'page-token-value' : undefined,
      }
      return (input.accounts ?? []).map(account => ({
        ...account,
        tokens: {
          ...tokens,
          ...(tokens.page_token ? {} : { page_token: undefined }),
        } as never,
      }))
    },
    async createCallbackServer(args) {
      // No port is bound: the test calls the flow's REAL onRequest handler
      // directly, so the state check and token exchange run exactly as they do
      // in production while nothing touches the network or a socket.
      handler = args.onRequest
      return {
        redirect_uri: `http://127.0.0.1:41234${args.path}`,
        close: async () => {},
      }
    },
    now: () => new Date(),
  }
  return { deps, callback: () => handler! }
}

describe('social publishing routes', () => {
  test('the connections view never returns a secret', async () => {
    await withApplications()
    const response = await request(app).get('/api/social/connections')
    assert.equal(response.status, 200)
    const text = JSON.stringify(response.body)
    assert.doesNotMatch(text, new RegExp(CLIENT_SECRET))
    assert.doesNotMatch(text, new RegExp(TIKTOK_SECRET))
    assert.equal(response.body.applications.meta.has_client_secret, true)
    assert.equal(response.body.applications.meta.redirect_uri, 'http://127.0.0.1:41234/callback')
    assert.deepEqual(response.body.applications.meta.required_scopes, [...oauth.SOCIAL_SCOPES.meta])
  })

  test('saving an application reports how many accounts it invalidated', async () => {
    await withApplications()
    await store.saveSocialAccountGrant({
      platform: 'facebook',
      application_id: 'meta:meta-client-id',
      remote_id: 'page-1',
      remote_name: 'Page One',
      page_id: 'page-1',
      tokens: { application_id: 'meta:meta-client-id', access_token: 'a', refresh_token: '', expires_at: Date.now() + 1_000_000, page_token: 'p' },
    })
    const response = await request(app)
      .put('/api/social/connections/applications/meta')
      .send({ client_id: 'meta-client-id-2', client_secret: 'new-secret-value', redirect_uri: 'http://127.0.0.1:41234/callback' })
    assert.equal(response.status, 200)
    assert.equal(response.body.invalidated_accounts, 1)
    const registry = await store.readSocialConnectionRegistry()
    assert.equal(registry.accounts['facebook:page-1']?.status, 'reconnect_required')
  })

  test('an unknown provider or platform is refused', async () => {
    await withApplications()
    const badProvider = await request(app)
      .put('/api/social/connections/applications/mastodon')
      .send({ client_id: 'a', client_secret: 'b', redirect_uri: 'http://127.0.0.1:1/callback' })
    assert.equal(badProvider.status, 400)

    const project = await createProject({ name: 'Unknown Platform Project' })
    const badPlatform = await request(app)
      .put(`/api/projects/${project.slug}/social/settings`)
      .send({ platforms: ['linkedin'] })
    assert.equal(badPlatform.status, 400)
    assert.match(badPlatform.body.detail, /Unknown platform/)
  })

  test('a channel cannot point at an account that is not connected', async () => {
    await withApplications()
    const project = await createProject({ name: 'Unconnected Project' })
    const response = await request(app)
      .put(`/api/projects/${project.slug}/social/settings`)
      .send({ platforms: ['facebook'], accounts: { facebook: 'page-never-connected' } })
    assert.equal(response.status, 400)
    assert.match(response.body.detail, /is not connected on this Mac/)
  })

  test('saving a channel’s choices stores exactly what was sent, including an empty list', async () => {
    await withApplications()
    await store.saveSocialAccountGrant({
      platform: 'facebook',
      application_id: 'meta:meta-client-id',
      remote_id: 'page-9',
      remote_name: 'Page Nine',
      page_id: 'page-9',
      tokens: { application_id: 'meta:meta-client-id', access_token: 'a', refresh_token: '', expires_at: Date.now() + 1_000_000, page_token: 'p' },
    })
    const project = await createProject({ name: 'Choices Project' })
    const saved = await request(app)
      .put(`/api/projects/${project.slug}/social/settings`)
      .send({ platforms: ['facebook'], accounts: { facebook: 'page-9' } })
    assert.equal(saved.status, 200)
    assert.deepEqual(await store.readProjectSocialOptIn(project.slug), ['facebook'])

    // An empty list is a real answer: post nowhere. It must not be read as
    // "use the defaults".
    const cleared = await request(app)
      .put(`/api/projects/${project.slug}/social/settings`)
      .send({ platforms: [] })
    assert.equal(cleared.status, 200)
    assert.deepEqual(await store.readProjectSocialOptIn(project.slug), [])
  })

  test('publishing with no platform ticked is refused, and nothing is queued', async () => {
    await withApplications()
    const project = await createProject({ name: 'Nothing Tick Project' })
    const response = await request(app)
      .post(`/api/projects/${project.slug}/social/episodes/EP0001/publish`)
      .send({ platforms: [] })
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'SOCIAL_NOTHING_SELECTED')
  })

  test('publishing to a platform with no account is refused before a job exists', async () => {
    await withApplications()
    const project = await createProject({ name: 'Unconnected Publish Project' })
    await updateConfig(project.slug, { social_accounts: {} } as never)
    const response = await request(app)
      .post(`/api/projects/${project.slug}/social/episodes/EP0001/publish`)
      .send({ platforms: ['tiktok'] })
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'SOCIAL_ACCOUNT_NOT_CONNECTED')
    assert.deepEqual(response.body.platforms, ['tiktok'])
  })

  test('an episode’s post state reads back receipts and failures without a token', async () => {
    await withApplications()
    const project = await createProject({ name: 'State Project' })
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const paths = await resolveEpisodePaths(project.slug, 'EP0002', 'State Episode')
    await fs.mkdir(paths.episode_dir, { recursive: true })
    await fs.writeFile(path.join(paths.episode_dir, 'social_publish.json'), JSON.stringify({
      schema_version: 1,
      episode_code: 'EP0002',
      receipts: [{ platform: 'facebook', account_id: 'page-1', post_id: 'fb-1', source_revision: 'sha256:' + 'a'.repeat(64), posted_at: '2026-10-27T00:00:00.000Z' }],
      failures: { tiktok: { message: 'TikTok refused.', code: 'SOCIAL_PLATFORM_REFUSED', at: '2026-10-27T00:00:00.000Z' } },
    }))
    const response = await request(app).get(`/api/projects/${project.slug}/social/episodes/EP0002`)
    assert.equal(response.status, 200)
    assert.equal(response.body.receipts.length, 1)
    assert.equal(response.body.failures[0].platform, 'tiktok')
    assert.doesNotMatch(JSON.stringify(response.body), /token/)
  })
})

describe('social oauth flow', () => {
  test('a flow with no saved application refuses with a setup message', async () => {
    await isolate()
    await assert.rejects(
      () => connect.startSocialConnect({ provider: 'meta' }),
      /Save the Meta application in Settings → Publishing/,
    )
  })

  test('a saved application must have a loopback redirect URI', async () => {
    await isolate()
    await store.configureSocialApplication({
      provider: 'meta',
      client_id: 'meta-client-id',
      client_secret: CLIENT_SECRET,
      redirect_uri: 'https://example.com/callback',
    })
    await assert.rejects(
      () => connect.startSocialConnect({ provider: 'meta' }),
      /The redirect URI must be http:\/\/127\.0\.0\.1/,
    )
  })

  test('TikTok requires the hex SHA-256 challenge, Meta the base64url one', async () => {
    // The two encodings are not interchangeable: TikTok's desktop guide says
    // hex, RFC 7636 says base64url. This pins the difference so a future
    // "cleanup" cannot unify them.
    await withApplications()
    const started = await connect.startSocialConnect({
      provider: 'tiktok',
      deps: fakeDeps({ provider: 'tiktok', accounts: [] }).deps,
    })
    const url = new URL(started.auth_url)
    const challenge = url.searchParams.get('code_challenge') || ''
    assert.match(challenge, /^[a-f0-9]{64}$/)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('client_key'), 'tiktok-client-key')

    const meta = await connect.startSocialConnect({
      provider: 'meta',
      deps: fakeDeps({ provider: 'meta', accounts: [] }).deps,
    })
    const metaUrl = new URL(meta.auth_url)
    assert.equal(metaUrl.searchParams.get('response_type'), 'code')
    assert.equal(metaUrl.searchParams.get('client_id'), 'meta-client-id')
    assert.match(metaUrl.searchParams.get('scope') || '', /pages_manage_posts/)
    oauth.__resetSocialOAuthFlowsForTests()
    connect.__resetSocialConnectsForTests()
  })

  test('a connect that yields no postable account fails in words, and saves nothing', async () => {
    await withApplications()
    // Meta answers with zero Pages: the sign-in worked but cannot post.
    const fake = fakeDeps({ provider: 'meta', accounts: [] })
    const saved = await connect.startSocialConnect({ provider: 'meta', deps: fake.deps })
    const flow = await driveCallback({ flowId: saved.flow_id, authUrl: saved.auth_url, callback: fake.callback() })
    assert.equal(flow.status, 'error')
    assert.match(flow.error || '', /gave Story Studio no account it can post to/)
    const registry = await store.readSocialConnectionRegistry()
    assert.deepEqual(registry.accounts, {})
  })

  test('a refused sign-in reports the provider’s reason, and saves nothing', async () => {
    await withApplications()
    const fake = fakeDeps({ provider: 'tiktok', accounts: [], exchangeFails: true })
    const saved = await connect.startSocialConnect({ provider: 'tiktok', deps: fake.deps })
    const flow = await driveCallback({ flowId: saved.flow_id, authUrl: saved.auth_url, callback: fake.callback() })
    assert.equal(flow.status, 'error')
    assert.match(flow.error || '', /invalid_grant/)
    const registry = await store.readSocialConnectionRegistry()
    assert.deepEqual(registry.accounts, {})
  })

  test('a mismatched state is refused', async () => {
    await withApplications()
    const fake = fakeDeps({ provider: 'meta', accounts: [] })
    const saved = await connect.startSocialConnect({ provider: 'meta', deps: fake.deps })
    const flow = await driveCallback({ flowId: saved.flow_id, authUrl: saved.auth_url, callback: fake.callback(), state: 'wrong-state' })
    assert.equal(flow.status, 'error')
    assert.equal(flow.error_code, 'SOCIAL_OAUTH_STATE_MISMATCH')
  })
})

/**
 * Deliver a callback the way the provider would: through the flow's own
 * `onRequest` handler. The state is read back from the auth URL the flow
 * returned, so nothing is guessed.
 */
async function driveCallback(input: {
  flowId: string
  authUrl: string
  callback: (request: { host: string; port: number; path: string; query: Record<string, string> }) => Promise<string>
  state?: string
}): Promise<SocialOAuthFlowStatus> {
  const url = new URL(input.authUrl)
  await input.callback({
    host: '127.0.0.1',
    port: 41234,
    path: '/callback',
    query: { code: 'auth-code-value', state: input.state ?? url.searchParams.get('state') ?? '' },
  })
  // The connect service saves asynchronously; poll the public status like the
  // Settings page does.
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await connect.readSocialConnectStatus(input.flowId)
    if (status.status !== 'pending') return status
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return await connect.readSocialConnectStatus(input.flowId)
}
