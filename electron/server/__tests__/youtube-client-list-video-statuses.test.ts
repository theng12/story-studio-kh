/**
 * Tests for `listVideoStatuses` — the bulk videos.list helper used by the
 * queue's "Sync from YouTube" flow to detect drift between local sidecars
 * and YouTube's actual privacy/schedule state.
 *
 * Stubs `globalThis.fetch` so the real network never gets touched. The
 * assertions cover:
 *   - empty input returns an empty map without burning a fetch
 *   - status.privacyStatus is normalized (unknown values fall back to 'private')
 *   - status.publishAt is surfaced verbatim when present, null when absent
 *   - >50 ids triggers multiple fetches (YouTube caps the id list at 50)
 *   - videos missing from the response are absent from the map (so callers
 *     can treat that as "couldn't sync this row, skip")
 *   - duplicate / empty ids are deduped before the fetch
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
let connections: typeof import('../services/youtube-connection-store.js')
let client: typeof import('../lib/youtube-client.js')

const CHANNEL_ID = 'UC_test_lvs'
const ACCOUNT_ID = `registry:${CHANNEL_ID}`
const ACCESS_TOKEN = 'fresh-access-token'
const REFRESH_TOKEN = 'refresh-token'

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  client = await import('../lib/youtube-client.js')
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

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function seedAccount(): Promise<string> {
  const project = await pm.createProject({ name: 'List Video Statuses Test' })
  await connections.configureYouTubeApplication({
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
  })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL_ID, title: 'Test', granted_scopes: ['https://www.googleapis.com/auth/youtube'] },
    tokens: {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_at: Date.now() + 60 * 60_000,
      scope: 'https://www.googleapis.com/auth/youtube',
    },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL_ID, expected_previous_channel_id: null })
  return project.slug
}

describe('listVideoStatuses', () => {
  test('empty input returns empty map without calling fetch', async () => {
    const slug = await seedAccount()
    let calls = 0
    globalThis.fetch = (async () => { calls++; return jsonResponse(200, { items: [] }) }) as any

    const r = await client.listVideoStatuses(slug, ACCOUNT_ID, [])
    assert.deepEqual(r, {})
    assert.equal(calls, 0, 'no network call for empty input')
  })

  test('parses privacyStatus and publishAt from a single batch', async () => {
    const slug = await seedAccount()
    const futureIso = new Date(Date.now() + 24 * 3600_000).toISOString()
    let lastUrl = ''

    globalThis.fetch = (async (url: string | URL) => {
      lastUrl = String(url)
      return jsonResponse(200, {
        items: [
          { id: 'vid_pub', status: { privacyStatus: 'public' } },
          { id: 'vid_priv', status: { privacyStatus: 'private' } },
          { id: 'vid_sched', status: { privacyStatus: 'private', publishAt: futureIso } },
          { id: 'vid_unl', status: { privacyStatus: 'unlisted' } },
        ],
      })
    }) as any

    const r = await client.listVideoStatuses(slug, ACCOUNT_ID, ['vid_pub', 'vid_priv', 'vid_sched', 'vid_unl'])

    assert.equal(r.vid_pub.privacyStatus, 'public')
    assert.equal(r.vid_pub.publishAt, null, 'public videos have no publishAt')
    assert.equal(r.vid_priv.privacyStatus, 'private')
    assert.equal(r.vid_priv.publishAt, null)
    assert.equal(r.vid_sched.privacyStatus, 'private')
    assert.equal(r.vid_sched.publishAt, futureIso, 'scheduled time surfaces verbatim')
    assert.equal(r.vid_unl.privacyStatus, 'unlisted')

    assert.match(lastUrl, /\/youtube\/v3\/videos\?part=status/)
    // Each id is URL-encoded individually but joined with literal commas
    // (commas are reserved-but-allowed characters in the URL query).
    assert.match(lastUrl, /id=vid_pub,vid_priv,vid_sched,vid_unl/)
  })

  test('unknown privacyStatus values default to private', async () => {
    const slug = await seedAccount()
    globalThis.fetch = (async () => jsonResponse(200, {
      items: [
        { id: 'vid_x', status: { privacyStatus: 'mystery' } },
        { id: 'vid_y', status: {} },
        { id: 'vid_z' },
      ],
    })) as any

    const r = await client.listVideoStatuses(slug, ACCOUNT_ID, ['vid_x', 'vid_y', 'vid_z'])
    assert.equal(r.vid_x.privacyStatus, 'private')
    assert.equal(r.vid_y.privacyStatus, 'private')
    assert.equal(r.vid_z.privacyStatus, 'private')
  })

  test('ids missing from the response are absent from the returned map', async () => {
    // Real-world case: a video was deleted on YouTube but its sidecar still
    // references the old videoId. videos.list returns only what exists, so
    // the missing id never appears in `items`.
    const slug = await seedAccount()
    globalThis.fetch = (async () => jsonResponse(200, {
      items: [{ id: 'vid_alive', status: { privacyStatus: 'public' } }],
    })) as any

    const r = await client.listVideoStatuses(slug, ACCOUNT_ID, ['vid_alive', 'vid_deleted'])
    assert.ok('vid_alive' in r)
    assert.ok(!('vid_deleted' in r), 'deleted videoId should not appear in the map')
  })

  test('input larger than 50 splits into multiple batches', async () => {
    const slug = await seedAccount()
    const ids: string[] = []
    for (let i = 0; i < 75; i++) ids.push(`vid_${String(i).padStart(3, '0')}`)

    let batchCount = 0
    const seenIds: string[][] = []
    globalThis.fetch = (async (url: string | URL) => {
      batchCount++
      const u = new URL(String(url))
      const idsParam = u.searchParams.get('id') || ''
      const batch = idsParam.split(',').filter(Boolean)
      seenIds.push(batch)
      return jsonResponse(200, {
        items: batch.map(id => ({ id, status: { privacyStatus: 'public' } })),
      })
    }) as any

    const r = await client.listVideoStatuses(slug, ACCOUNT_ID, ids)

    assert.equal(batchCount, 2, '75 ids → 50 + 25 = two batches')
    assert.equal(seenIds[0].length, 50, 'first batch holds 50')
    assert.equal(seenIds[1].length, 25, 'second batch holds 25')
    assert.equal(Object.keys(r).length, 75, 'every id resolved')
  })

  test('public videos coerce publishAt to null even if YouTube echoes a value', async () => {
    // Belt-and-suspenders: YouTube's `videos.list?part=status` is documented
    // to omit `publishAt` once a video goes public, but in practice we've
    // seen sidecars stay scheduled-looking after auto-publish. The helper
    // forces publishAt=null whenever privacyStatus !== 'private', so the
    // queue's drift detector sees the schedule clear and rewrites the
    // sidecar — fixing the "shows as scheduled but already public" bug.
    const slug = await seedAccount()
    const stalePast = '2025-01-15T18:00:00Z'
    globalThis.fetch = (async () => jsonResponse(200, {
      items: [
        { id: 'vid_pub_with_stale', status: { privacyStatus: 'public', publishAt: stalePast } },
        { id: 'vid_unl_with_stale', status: { privacyStatus: 'unlisted', publishAt: stalePast } },
      ],
    })) as any

    const r = await client.listVideoStatuses(slug, ACCOUNT_ID, ['vid_pub_with_stale', 'vid_unl_with_stale'])

    assert.equal(r.vid_pub_with_stale.privacyStatus, 'public')
    assert.equal(r.vid_pub_with_stale.publishAt, null, 'publishAt must be null on public — drift detector relies on this')
    assert.equal(r.vid_unl_with_stale.privacyStatus, 'unlisted')
    assert.equal(r.vid_unl_with_stale.publishAt, null, 'publishAt must be null on unlisted too')
  })

  test('duplicate and empty ids are deduped before the fetch', async () => {
    const slug = await seedAccount()
    let lastUrl = ''
    globalThis.fetch = (async (url: string | URL) => {
      lastUrl = String(url)
      return jsonResponse(200, { items: [{ id: 'vid_a', status: { privacyStatus: 'public' } }] })
    }) as any

    await client.listVideoStatuses(slug, ACCOUNT_ID, ['vid_a', 'vid_a', '', 'vid_a'])

    const u = new URL(lastUrl)
    const idsParam = u.searchParams.get('id') || ''
    assert.equal(idsParam, 'vid_a', 'dups + empties collapse to a single id')
  })
})
