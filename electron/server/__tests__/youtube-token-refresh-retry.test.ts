/**
 * Token refresh: a transient Google/network failure is retried (nothing has
 * been sent to YouTube yet), and only a refused grant (`invalid_grant`,
 * `invalid_client`) says "Reconnect" — and marks the channel so its row shows
 * the Reconnect button. A refusal ~7 days after consent is remembered as the
 * Testing-status 7-day sign-in.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const realFetch = globalThis.fetch
let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let client: typeof import('../lib/youtube-client.js')
let connections: typeof import('../services/youtube-connection-store.js')

const CHANNEL_ID = 'channel_refresh'
const DAY = 24 * 60 * 60 * 1000

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  client = await import('../lib/youtube-client.js')
  connections = await import('../services/youtube-connection-store.js')
  client.__setTokenRefreshRetryDelaysForTests([1, 1])
})

after(async () => {
  globalThis.fetch = realFetch
  await cleanup()
})

beforeEach(async () => {
  await connections.disconnectYouTubeChannel({ channel_id: CHANNEL_ID }).catch(() => {})
  await fs.rm(path.join(tempDir, 'projects'), { recursive: true, force: true })
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
})

async function seed(): Promise<string> {
  const project = await pm.createProject({ name: `Refresh ${Math.random()}` })
  await connections.configureYouTubeApplication({ client_id: 'cid', client_secret: 'csecret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL_ID, title: 'Refresh Channel', granted_scopes: ['https://www.googleapis.com/auth/youtube'] },
    // Expired access token: the first API call must refresh.
    tokens: { access_token: 'old', refresh_token: 'rt', expires_at: Date.now() - 1000 },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL_ID, expected_previous_channel_id: null })
  return project.slug
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function route(token: () => Response): { refreshes: () => number } {
  let refreshes = 0
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.startsWith('https://oauth2.googleapis.com/token')) { refreshes++; return token() }
    if (u.startsWith('https://www.googleapis.com/youtube/v3/playlists')) return json(200, { items: [] })
    throw new Error(`unexpected fetch ${u}`)
  }) as any
  return { refreshes: () => refreshes }
}

describe('YouTube token refresh', () => {
  test('a transient 503 is retried and then succeeds without asking for Reconnect', async () => {
    const slug = await seed()
    let n = 0
    const calls = route(() => (++n < 3 ? json(503, { error: 'backend_error' }) : json(200, { access_token: 'fresh', expires_in: 3600 })))
    assert.deepEqual(await client.listPlaylists(slug, client.registryCredentialFor(CHANNEL_ID)), [])
    assert.equal(calls.refreshes(), 3)
    const channel = (await connections.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!
    assert.equal(channel.status, 'connected')
  })

  test('a transient failure on every attempt says "try again", never Reconnect, and leaves the channel connected', async () => {
    const slug = await seed()
    const calls = route(() => json(503, { error: 'backend_error' }))
    await assert.rejects(
      () => client.listPlaylists(slug, client.registryCredentialFor(CHANNEL_ID)),
      (error: any) => error.code === 'YOUTUBE_TOKEN_REFRESH_FAILED' && error.transient === true
        && !/reconnect/i.test(error.message),
    )
    assert.equal(calls.refreshes(), 3)
    assert.equal((await connections.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!.status, 'connected')
  })

  test('invalid_grant is not retried, says Reconnect and marks the channel reconnect_required', async () => {
    const slug = await seed()
    const calls = route(() => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))
    await assert.rejects(
      () => client.listPlaylists(slug, client.registryCredentialFor(CHANNEL_ID)),
      (error: any) => error.code === 'YOUTUBE_RECONNECT_REQUIRED' && /Reconnect/.test(error.message),
    )
    assert.equal(calls.refreshes(), 1)
    const channel = (await connections.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!
    assert.equal(channel.status, 'reconnect_required')
    assert.equal(channel.seven_day_sign_in, undefined, 'a refusal minutes after consent is not the 7-day kind')
  })

  test('another 400 (unauthorized_client) is not retried and does not say Reconnect', async () => {
    const slug = await seed()
    const calls = route(() => json(400, { error: 'unauthorized_client' }))
    await assert.rejects(
      () => client.listPlaylists(slug, client.registryCredentialFor(CHANNEL_ID)),
      (error: any) => error.code === 'YOUTUBE_TOKEN_REFRESH_FAILED' && error.transient === false
        && /unauthorized_client/.test(error.message) && !/reconnect/i.test(error.message),
    )
    assert.equal(calls.refreshes(), 1)
    assert.equal((await connections.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!.status, 'connected')
  })

  test('a refusal about 7 days after consent is remembered as the 7-day sign-in, and survives Reconnect', async () => {
    await seed()
    const authorized = Date.parse((await connections.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!.authorized_at!)
    await connections.markYouTubeChannelSignInExpired(CHANNEL_ID, authorized + 7 * DAY + 60_000)
    let channel = (await connections.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!
    assert.equal(channel.status, 'reconnect_required')
    assert.equal(channel.seven_day_sign_in, true)
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL_ID, title: 'Refresh Channel', granted_scopes: ['https://www.googleapis.com/auth/youtube'] },
      tokens: { access_token: 'new', refresh_token: 'rt2', expires_at: Date.now() + 3600_000 },
    })
    channel = (await connections.readYouTubeConnectionRegistry()).channels[CHANNEL_ID]!
    assert.equal(channel.status, 'connected')
    assert.equal(channel.seven_day_sign_in, true, 'Reconnect keeps what was learned about the app')
    assert.ok(Date.parse(channel.authorized_at!) >= authorized)
  })
})
