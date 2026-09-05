import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
let tempDir: string
let cleanup: () => Promise<void>
let app: any
let connections: typeof import('../services/youtube-connection-store.js')
let pm: typeof import('../services/project-manager.js')
const originalFetch = globalThis.fetch

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  connections = await import('../services/youtube-connection-store.js')
  pm = await import('../services/project-manager.js')
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

beforeEach(async () => {
  globalThis.fetch = originalFetch
  await fs.rm(pm.projectsRoot(), { recursive: true, force: true })
  await fs.mkdir(pm.projectsRoot(), { recursive: true })
  await fs.rm(path.join(tempDir, 'youtube'), { recursive: true, force: true })
  await fs.rm(path.join(tempDir, 'app-secrets.json'), { force: true })
  const { _clearYouTubeChannelAvatarCacheForTests } = await import('../lib/youtube-channel-avatar.js')
  _clearYouTubeChannelAvatarCacheForTests()
})

describe('YouTube channel avatar route', () => {
  test('serves a connected account icon from the same-origin API', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'Avatar Project' })
    const slug = created.body.slug
    await connections.configureYouTubeApplication({ client_id: 'avatar-client', client_secret: 'avatar-secret' })
    await saveYouTubeChannelGrantForTest({
      channel: {
        channel_id: 'UC-avatar', title: 'Avatar Channel', granted_scopes: ['youtube.upload'],
        thumbnail_url: 'https://yt3.ggpht.com/avatar=s88-c-k-c0x00ffffff-no-rj',
      },
      tokens: { access_token: 'avatar-access', refresh_token: 'avatar-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: 'UC-avatar', expected_previous_channel_id: null })
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    globalThis.fetch = (async () => new Response(image, {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(image.length) },
    })) as typeof fetch

    const response = await request(app)
      .get(`/api/projects/${slug}/upload/accounts/registry%3AUC-avatar/avatar`)

    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'image/jpeg')
    assert.match(response.headers['cache-control'], /max-age=3600/)
    assert.deepEqual(response.body, image)
  })

  test('does not fetch an icon for an unknown account', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'Missing Avatar' })
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      return new Response()
    }) as typeof fetch

    const response = await request(app)
      .get(`/api/projects/${created.body.slug}/upload/accounts/missing/avatar`)

    assert.equal(response.status, 404)
    assert.equal(fetched, false)
  })
})
