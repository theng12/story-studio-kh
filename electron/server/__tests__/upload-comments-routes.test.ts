/**
 * Route-level tests for /api/projects/:slug/upload/comments* endpoints.
 *
 * Cheap-branch coverage:
 *   - GET comments: 400 missing video_id / 200 with stubbed fetch
 *   - POST draft: 400 missing fields, 200 happy path with stubbed callAi
 *     via fetch interception (the ai-client provider for the picked
 *     model resolves the access token from secrets and calls fetch)
 *   - POST reply: 400 missing fields / 200 happy path
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')

const fetchQueue: Array<{ status: number; body: any; assertUrl?: (u: string) => void; assertBody?: (b: any) => void }> = []
const originalFetch = globalThis.fetch

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.toString()
    const next = fetchQueue.shift()
    if (!next) return new Response(JSON.stringify({ error: 'unmocked' }), { status: 500 })
    next.assertUrl?.(url)
    if (next.assertBody && init?.body) next.assertBody(JSON.parse(init.body))
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } })
  }) as any
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

beforeEach(async () => {
  fetchQueue.length = 0
  try { await fs.rm(pm.projectsRoot(), { recursive: true, force: true }) } catch {}
  await fs.mkdir(pm.projectsRoot(), { recursive: true })
  await fs.rm(path.join(tempDir, 'youtube'), { recursive: true, force: true })
  await fs.rm(path.join(tempDir, 'app-secrets.json'), { force: true })
})

async function seedProjectWithAccount(name: string): Promise<string> {
  const created = await request(app).post('/api/projects').send({ name })
  const slug = created.body.slug
  const scope = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube'
  await connections.configureYouTubeApplication({ client_id: 'comments-route-client', client_secret: 'comments-route-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'acct-1', title: 'Comments', granted_scopes: scope.split(' ') },
    tokens: { access_token: 'fake', refresh_token: 'r', expires_at: Date.now() + 3_600_000, scope },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: 'acct-1', expected_previous_channel_id: null })
  return slug
}

describe('GET /upload/comments', () => {
  test('rejects a caller-supplied channel that is not this project assignment before provider I/O', async () => {
    const slug = await seedProjectWithAccount('CR0')
    const res = await request(app)
      .get(`/api/projects/${slug}/upload/comments?video_id=v-1&account_id=registry%3Aforeign-channel`)
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /No YouTube account connected/)
    assert.equal(fetchQueue.length, 0)
  })

  test('400 when video_id missing', async () => {
    const slug = await seedProjectWithAccount('CR1')
    const res = await request(app).get(`/api/projects/${slug}/upload/comments`)
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /video_id/)
  })

  test('200 happy path returns normalized threads', async () => {
    const slug = await seedProjectWithAccount('CR2')
    fetchQueue.push({
      status: 200,
      body: {
        items: [{
          id: 't-1',
          snippet: {
            videoId: 'v-1', totalReplyCount: 0, canReply: true, isPublic: true,
            topLevelComment: { id: 'c-top-1', snippet: { authorDisplayName: 'Alice', textOriginal: 'great', likeCount: 5, publishedAt: '', updatedAt: '' } },
          },
        }],
      },
    })
    const res = await request(app).get(`/api/projects/${slug}/upload/comments?video_id=v-1`)
    assert.equal(res.status, 200)
    assert.equal(res.body.threads.length, 1)
    assert.equal(res.body.threads[0].top_comment.author, 'Alice')
  })
})

describe('POST /upload/comments/reply', () => {
  test('400 when parent_comment_id missing', async () => {
    const slug = await seedProjectWithAccount('CR3')
    const res = await request(app).post(`/api/projects/${slug}/upload/comments/reply`).send({ text: 'hi' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /parent_comment_id/)
  })

  test('400 when text empty', async () => {
    const slug = await seedProjectWithAccount('CR4')
    const res = await request(app).post(`/api/projects/${slug}/upload/comments/reply`).send({ parent_comment_id: 'c-1', text: '   ' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /text is required/)
  })

  test('200 happy path posts the reply and returns normalized comment', async () => {
    const slug = await seedProjectWithAccount('CR5')
    fetchQueue.push({
      status: 200,
      assertUrl: (u) => assert.match(u, /\/comments\?/),
      assertBody: (body) => {
        assert.equal(body.snippet.parentId, 'c-top-1')
        assert.equal(body.snippet.textOriginal, 'Thanks Alice!')
      },
      body: {
        id: 'c-new-1',
        snippet: { authorDisplayName: 'Channel', textOriginal: 'Thanks Alice!', likeCount: 0, publishedAt: '', updatedAt: '' },
      },
    })
    const res = await request(app).post(`/api/projects/${slug}/upload/comments/reply`).send({
      parent_comment_id: 'c-top-1',
      text: 'Thanks Alice!',
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.reply.id, 'c-new-1')
    assert.equal(res.body.reply.text, 'Thanks Alice!')
  })
})

describe('POST /upload/comments/draft', () => {
  test('400 when comment_text missing', async () => {
    const slug = await seedProjectWithAccount('CR6')
    const res = await request(app).post(`/api/projects/${slug}/upload/comments/draft`).send({ model: 'claude-sonnet-4-6' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /comment_text/)
  })

  test('400 when model missing', async () => {
    const slug = await seedProjectWithAccount('CR7')
    const res = await request(app).post(`/api/projects/${slug}/upload/comments/draft`).send({ comment_text: 'lovely!' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /model/)
  })
})
