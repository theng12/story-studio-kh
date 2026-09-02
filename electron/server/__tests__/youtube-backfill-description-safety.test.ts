/**
 * The Settings YouTube backfill republishes metadata saved in upload sidecars.
 * Those sidecars deliberately retain Story Studio's private managed-block
 * markers, but YouTube rejects literal angle brackets in descriptions. These
 * route tests pin the final outbound payload while proving the saved evidence
 * is never rewritten as a side effect of publishing.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let tempDir = ''
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let store: typeof import('../services/upload-store.js')
let sidecars: typeof import('../services/upload-sidecar.js')
let utils: typeof import('../services/utils.js')

const originalFetch = globalThis.fetch
const CODE = 'EP0001'
const TITLE = 'Ancient Ships at Sea'

interface FetchCall {
  url: string
  method: string
  body: any
}

let fetchCalls: FetchCall[] = []

function youtubeListResponse(videoId: string): Response {
  return new Response(JSON.stringify({
    items: [{
      id: videoId,
      snippet: { categoryId: '22' },
      status: {
        privacyStatus: 'private',
        containsSyntheticMedia: false,
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  store = await import('../services/upload-store.js')
  sidecars = await import('../services/upload-sidecar.js')
  utils = await import('../services/utils.js')
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

beforeEach(async () => {
  fetchCalls = []
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    fetchCalls.push({ url, method, body })

    if (method === 'GET' && url.includes('/youtube/v3/videos?')) {
      const videoId = new URL(url).searchParams.get('id') || ''
      return youtubeListResponse(videoId)
    }
    if (method === 'PUT' && url.includes('/youtube/v3/videos?')) {
      return new Response(JSON.stringify({
        id: body?.id,
        snippet: body?.snippet,
        status: body?.status,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unmocked request' }), { status: 500 })
  }) as any
})

async function seedUploadedEpisode(description: string, title = TITLE): Promise<{
  slug: string
  videoId: string
  sidecarPath: string
}> {
  const project = await pm.createProject({ name: `Backfill ${Date.now()}` })
  const slug = project.slug
  const account = await store.addAccount(slug, 'youtube', {
    label: 'Test channel',
    remote_id: 'UC_backfill_test',
    remote_title: 'Test channel',
  })
  await store.writeTokens(slug, 'youtube', account.id, {
    access_token: 'fresh-access-token',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 60 * 60_000,
    scope: 'https://www.googleapis.com/auth/youtube',
  })
  await pm.updateConfig(slug, {
    category_id: 24,
    mark_as_ai_generated: true,
  } as any)

  await fs.writeFile(path.join(tempDir, 'projects', slug, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'idea_backfill',
      title: TITLE,
      logline: '',
      themes: [],
      status: 'accepted',
      episode_code: CODE,
      suggested_chapters: 5,
      suggested_length: '10',
      mood: '',
      created_at: new Date().toISOString(),
    }],
  }, null, 2))

  const videoId = 'video-backfill-test'
  await sidecars.writeSidecar(slug, CODE, TITLE, {
    platform: 'youtube',
    video_id: videoId,
    account_id: account.id,
    channel_id: 'UC_backfill_test',
    uploaded_at: '2026-09-01T00:00:00.000Z',
    last_sync_at: '2026-09-01T00:00:00.000Z',
    scheduled_for: null,
    privacy_status: 'private',
    title,
    description,
    tags: ['history', 'ships'],
    thumbnail_set: true,
  })

  const episode = await utils.resolveEpisodePaths(slug, CODE, TITLE)
  return {
    slug,
    videoId,
    sidecarPath: path.join(episode.episode_dir, 'youtube_upload.json'),
  }
}

describe('YouTube settings backfill description safety', () => {
  test('removes private markers from the outbound update without changing the saved sidecar', async () => {
    const description = [
      'Opening paragraph.',
      '',
      '<!-- youtube:chapters:start -->',
      'CHAPTERS',
      '0:00 Leaving Port',
      '2:15 Across the Open Sea',
      '<!-- youtube:chapters:end -->',
      '',
      '<!-- youtube:sources:start -->',
      'SOURCES & FURTHER READING',
      '• Maritime archive — https://example.test/source',
      '<!-- youtube:sources:end -->',
    ].join('\n')
    const seeded = await seedUploadedEpisode(description)
    const sidecarBefore = await fs.readFile(seeded.sidecarPath)

    const response = await request(app)
      .post(`/api/projects/${seeded.slug}/upload/youtube-backfill`)
      .send({})

    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.updated, 1)
    assert.equal(response.body.failed, 0)

    const update = fetchCalls.find(call => call.method === 'PUT')
    assert.ok(update, 'the backfill must send one metadata update')
    assert.equal(update.body.snippet.description, [
      'Opening paragraph.',
      '',
      'CHAPTERS',
      '0:00 Leaving Port',
      '2:15 Across the Open Sea',
      '',
      'SOURCES & FURTHER READING',
      '• Maritime archive — https://example.test/source',
    ].join('\n'))
    assert.equal(update.body.snippet.description.includes('<'), false)
    assert.equal(update.body.snippet.description.includes('>'), false)

    const sidecarAfter = await fs.readFile(seeded.sidecarPath)
    assert.deepEqual(sidecarAfter, sidecarBefore, 'publishing cleanup must not rewrite stored metadata evidence')
  })

  test('still refuses unrelated invalid metadata when private markers are present', async () => {
    const seeded = await seedUploadedEpisode([
      '<!-- youtube:chapters:start -->',
      'CHAPTERS',
      '0:00 Beginning',
      '<!-- youtube:chapters:end -->',
    ].join('\n'), '')

    const response = await request(app)
      .post(`/api/projects/${seeded.slug}/upload/youtube-backfill`)
      .send({})

    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.updated, 0)
    assert.equal(response.body.failed, 1)
    assert.match(response.body.details[0].error, /title is empty/i)
    assert.equal(fetchCalls.filter(call => call.method === 'PUT').length, 0,
      'invalid metadata must be rejected before any YouTube update')
  })
})
