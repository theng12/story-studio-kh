/**
 * Proactive (pre-expiry) refresh trigger in `getValidAccessToken`
 * (electron/server/lib/youtube-client.ts:71-92).
 *
 * The complementary `youtube-client-auth-retry.test.ts` covers the *reactive*
 * 401 retry. This file covers the *proactive* 60-second buffer:
 *
 *   if (tokens.expires_at - 60_000 > now) return tokens.access_token
 *   return refreshAndPersist(slug, accountId)
 *
 * A clock skew or off-by-one in that comparison means in-flight requests
 * race the real expiry and 401 — the wrapper recovers via the reactive
 * path, but each near-expiry request takes a redundant Google round-trip.
 *
 * We exercise the boundary three times: well inside the buffer, well
 * outside, and already-expired. Mock the refresh fetch and assert it was
 * (or wasn't) called.
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
  await fs.rm(path.join(tempDir, 'youtube'), { recursive: true, force: true })
  await fs.rm(path.join(tempDir, 'app-secrets.json'), { force: true })
})

const CHANNEL_ID = 'acc_proactive'
const ACCOUNT_ID = `registry:${CHANNEL_ID}`
const STALE_TOKEN = 'stale-access-token'
const FRESH_TOKEN = 'fresh-access-token'
const REFRESH_TOKEN = 'refresh-token-still-valid'

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function seedAccount(expiresAtOffsetMs: number): Promise<string> {
  const project = await pm.createProject({ name: `Pre-expiry ${Date.now()}-${Math.random()}` })
  await connections.configureYouTubeApplication({
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
  })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL_ID, title: CHANNEL_ID, granted_scopes: ['https://www.googleapis.com/auth/youtube'] },
    tokens: {
      access_token: STALE_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_at: Date.now() + expiresAtOffsetMs,
      scope: 'https://www.googleapis.com/auth/youtube',
    },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL_ID, expected_previous_channel_id: null })
  return project.slug
}

/**
 * Install a fetch mock that counts calls to Google's token endpoint and
 * returns FRESH_TOKEN. Returns a getter for the call count + a restore fn.
 */
function installRefreshSpy(): { calls: () => number; restore: () => void } {
  let count = 0
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      count++
      return jsonResponse(200, {
        access_token: FRESH_TOKEN,
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/youtube',
      })
    }
    throw new Error(`unexpected fetch in test: ${u}`)
  }) as any
  return {
    calls: () => count,
    restore: () => { globalThis.fetch = realFetch },
  }
}

describe('getValidAccessToken — proactive 60s pre-expiry refresh', () => {
  test('expires_at within 60s buffer → refresh fires, fresh token returned', async () => {
    const slug = await seedAccount(30_000)  // expires in 30s — inside the buffer
    const spy = installRefreshSpy()
    try {
      const token = await client.getValidAccessToken(slug, ACCOUNT_ID)
      assert.equal(spy.calls(), 1, 'refresh must fire when expiry is inside the 60s window')
      assert.equal(token, FRESH_TOKEN, 'returned token must be the freshly refreshed one')
      // And the refreshed bundle was persisted.
      const after = await connections.readYouTubeChannelTokensForServer(CHANNEL_ID)
      assert.equal(after?.access_token, FRESH_TOKEN)
    } finally {
      spy.restore()
    }
  })

  test('expires_at well outside the buffer → cached token, no refresh fetch', async () => {
    const slug = await seedAccount(120_000)  // expires in 2 minutes — outside the buffer
    const spy = installRefreshSpy()
    try {
      const token = await client.getValidAccessToken(slug, ACCOUNT_ID)
      assert.equal(spy.calls(), 0, 'refresh must NOT fire when expiry is comfortably outside the buffer')
      assert.equal(token, STALE_TOKEN, 'cached token returned unchanged')
    } finally {
      spy.restore()
    }
  })

  test('already-expired token → refresh fires (negative offset still triggers)', async () => {
    const slug = await seedAccount(-5_000)  // expired 5s ago
    const spy = installRefreshSpy()
    try {
      const token = await client.getValidAccessToken(slug, ACCOUNT_ID)
      assert.equal(spy.calls(), 1, 'refresh must fire for an already-expired token')
      assert.equal(token, FRESH_TOKEN)
    } finally {
      spy.restore()
    }
  })
})
