import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let store: typeof import('../services/upload-store.js')
let pm: typeof import('../services/project-manager.js')
const originalFetch = globalThis.fetch

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  store = await import('../services/upload-store.js')
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
  const { _clearYouTubeChannelAvatarCacheForTests } = await import('../lib/youtube-channel-avatar.js')
  _clearYouTubeChannelAvatarCacheForTests()
})

describe('YouTube channel avatar route', () => {
  test('serves a connected account icon from the same-origin API', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'Avatar Project' })
    const slug = created.body.slug
    const account = await store.addAccount(slug, 'youtube', {
      label: 'Avatar Channel',
      remote_id: 'UC-avatar',
      remote_title: 'Avatar Channel',
      thumbnail_url: 'https://yt3.ggpht.com/avatar=s88-c-k-c0x00ffffff-no-rj',
    })
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    globalThis.fetch = (async () => new Response(image, {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(image.length) },
    })) as typeof fetch

    const response = await request(app)
      .get(`/api/projects/${slug}/upload/accounts/${account.id}/avatar`)

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
