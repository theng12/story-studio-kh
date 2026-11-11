/**
 * `GET /projects` carries each channel's real YouTube connection state
 * (owner-approved 2026-11-08), read from the SAME central registry the
 * Connections screen uses. The badge must be honest:
 *
 *   connected         assigned, current token, channel status good
 *   needs_reconnect   assigned, but the grant/status cannot upload
 *   not_connected     a readable registry with no assignment for this project
 *   unknown           the registry could not be read — never "not connected"
 *
 * It is a separate field from `has_api_keys` (the Gateway key), and an
 * unreadable registry must not take the channel list down.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { after, before, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let store: typeof import('../services/youtube-connection-store.js')
let app: express.Express

before(async () => {
  tmp = await useTempDataDir()
  pm = await import('../services/project-manager.js')
  store = await import('../services/youtube-connection-store.js')
  const { router } = await import('../routes/projects.js')
  app = express().use(express.json()).use('/api', router)
})

after(async () => { await tmp.cleanup() })

async function rowsBySlug(): Promise<Record<string, any>> {
  const response = await request(app).get('/api/projects')
  assert.equal(response.status, 200)
  return Object.fromEntries(response.body.map((row: any) => [row.slug, row]))
}

test('assigned and healthy is connected; an unassigned project is genuinely not connected', async () => {
  const assigned = await pm.createProject({ name: 'Assigned Channel' })
  const idle = await pm.createProject({ name: 'Idle Channel' })

  await store.configureYouTubeApplication({ client_id: 'list-client', client_secret: 'list-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'channel-list', title: 'Assigned Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'access-list', refresh_token: 'refresh-list', expires_at: Date.now() + 3_600_000 },
  })
  await store.assignProjectYouTubeChannel({
    project_slug: assigned.slug, channel_id: 'channel-list', expected_previous_channel_id: null,
  })

  const rows = await rowsBySlug()
  assert.equal(rows[assigned.slug]!.youtube_connection, 'connected')
  assert.equal(rows[idle.slug]!.youtube_connection, 'not_connected')
  assert.equal(typeof rows[idle.slug]!.has_api_keys, 'boolean', 'the Gateway key field is unchanged and separate')
})

test('a channel whose grant needs reconnecting is needs_reconnect, not connected', async () => {
  await store.markYouTubeChannelStatus('channel-list', 'reconnect_required')
  const rows = await rowsBySlug()
  const slug = Object.keys(rows).find(key => rows[key]!.youtube_connection === 'needs_reconnect')
  assert.ok(slug, 'the assigned project reports a reconnect')
})

test('an unreadable registry is unknown for every row, never not connected, and the list still loads', async () => {
  await fs.writeFile(store.youtubeConnectionsPath(), '{ this is not json', 'utf8')
  const rows = await rowsBySlug()
  assert.ok(Object.keys(rows).length > 0, 'the channel list still renders')
  for (const row of Object.values(rows)) {
    assert.equal(row.youtube_connection, 'unknown')
  }
})
