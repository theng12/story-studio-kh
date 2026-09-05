/**
 * Tests for the single-retry-on-401 wrapper around YouTube Bearer-authed
 * calls (audit finding M3).
 *
 * The bug being pinned: token refresh used to be purely proactive (60s
 * before expires_at). When clock skew or mid-session grant invalidation
 * caused Google to reject a token our local clock said was still valid,
 * the user saw an opaque 401 and had to click Reconnect even though the
 * refresh_token was still good. The fix is fetchWithAuthRetry — single
 * retry on 401 after a forced refresh, no looping.
 *
 * `listPlaylists` is the simplest path through the wrapper (one fetch per
 * page) so it's used as the integration probe; the assertions are about
 * the wrapper's retry semantics, not the playlist endpoint itself.
 *
 * Both `globalThis.fetch` and the YouTube OAuth refresh use the same
 * global fetch under the hood, so the mock routes by URL.
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

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  client = await import('../lib/youtube-client.js')
  connections = await import('../services/youtube-connection-store.js')
})

after(async () => {
  globalThis.fetch = realFetch
  await cleanup()
})

beforeEach(async () => {
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

const CHANNEL_ID = 'channel_test'
const STALE_TOKEN = 'stale-access-token'
const FRESH_TOKEN = 'fresh-access-token'
const REFRESH_TOKEN = 'refresh-token-still-valid'

async function seedAccount(): Promise<string> {
  const project = await pm.createProject({ name: 'Auth Retry Test' })
  await connections.configureYouTubeApplication({
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
  })
  // expires_at is well in the future so the proactive refresh path doesn't
  // fire — we want to exercise the *reactive* path triggered by Google's
  // 401, not the proactive expires_at - 60s branch.
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL_ID, title: 'Auth Retry Channel', granted_scopes: ['https://www.googleapis.com/auth/youtube'] },
    tokens: {
      access_token: STALE_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_at: Date.now() + 30 * 60 * 1000,
      scope: 'https://www.googleapis.com/auth/youtube',
    },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL_ID, expected_previous_channel_id: null })
  return project.slug
}

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchWithAuthRetry — reactive 401 handling', () => {
  test('rejects a registry channel that is not assigned to this project before provider I/O', async () => {
    await seedAccount()
    const other = await pm.createProject({ name: 'Unassigned Auth Test' })
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return jsonResponse(200, { items: [] })
    }) as any

    await assert.rejects(
      () => client.listPlaylists(other.slug, client.registryCredentialFor(CHANNEL_ID)),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_RECONNECT_REQUIRED'
        && /not assigned/i.test((error as Error).message),
    )
    assert.equal(fetchCalls, 0)
  })

  test('retries once on 401 with a freshly refreshed token, then succeeds', async () => {
    const slug = await seedAccount()

    let playlistCalls = 0
    let refreshCalls = 0
    const tokensSeen: string[] = []

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        refreshCalls++
        return jsonResponse(200, {
          access_token: FRESH_TOKEN,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/youtube',
        })
      }
      if (u.startsWith('https://www.googleapis.com/youtube/v3/playlists')) {
        playlistCalls++
        const auth = (init?.headers as any)?.Authorization || ''
        tokensSeen.push(String(auth))
        if (playlistCalls === 1) {
          // First call — Google rejects the (clock-skewed / mid-revoked) token.
          return jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } })
        }
        // Second call after refresh — succeed.
        return jsonResponse(200, { items: [] })
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }) as any

    const playlists = await client.listPlaylists(slug, client.registryCredentialFor(CHANNEL_ID))

    assert.deepEqual(playlists, [], 'wrapper should return the post-retry success body')
    assert.equal(playlistCalls, 2, 'YouTube endpoint must be hit exactly twice (initial + one retry)')
    assert.equal(refreshCalls, 1, 'token endpoint must be hit exactly once')
    assert.equal(tokensSeen[0], `Bearer ${STALE_TOKEN}`, 'first attempt uses the stale token')
    assert.equal(tokensSeen[1], `Bearer ${FRESH_TOKEN}`, 'retry uses the freshly refreshed token')

    // And: the refreshed bundle was persisted, so subsequent calls within
    // this session would not need to re-refresh.
    const after = await connections.readYouTubeChannelTokensForServer(CHANNEL_ID)
    assert.equal(after?.access_token, FRESH_TOKEN, 'refreshed token must be written to secrets store')
  })

  test('a second consecutive 401 surfaces to the caller without a third retry', async () => {
    const slug = await seedAccount()

    let playlistCalls = 0
    let refreshCalls = 0

    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        refreshCalls++
        return jsonResponse(200, {
          access_token: FRESH_TOKEN,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/youtube',
        })
      }
      if (u.startsWith('https://www.googleapis.com/youtube/v3/playlists')) {
        playlistCalls++
        // Google rejects both the stale and the freshly refreshed token —
        // simulates a truly invalidated grant. Without single-retry-only
        // semantics this would loop forever and burn quota.
        return jsonResponse(401, {
          error: { code: 401, message: 'Invalid Credentials' },
        })
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }) as any

    await assert.rejects(
      () => client.listPlaylists(slug, client.registryCredentialFor(CHANNEL_ID)),
      (err: any) => {
        // The 401 body must be preserved, not swallowed behind a generic
        // "reconnect required" message — the caller surfaces it to the
        // user verbatim.
        assert.match(String(err.message), /playlists\.list failed \(401\)/)
        return true
      },
    )

    assert.equal(playlistCalls, 2, 'wrapper must stop at 2 attempts; a third would risk quota burn on a revoked grant')
    assert.equal(refreshCalls, 1, 'wrapper must refresh exactly once before giving up')
  })
})
