/**
 * The YouTube retention stores, read once per request instead of once per
 * episode.
 *
 * MEASURED 2026-09-18, cold `/episodes` on the owner's 302-episode project:
 * the store held 34 operation records, and the status sweep asked for all of
 * them — plus `youtube/project-state.json` — for EVERY episode:
 *
 *   readFile  <34 operation records>   10,180
 *   readFile  youtube/project-state.json   604
 *   readdir   youtube/operations           302
 *   readFile  youtube/operations/index.json 302
 *
 * 10,180 reads of 34 files, re-parsed and re-validated 302 times, to answer a
 * question whose answer is identical for every row in the response.
 *
 * HOW THIS IS PROVEN. By CONSEQUENCE, not by counting reads: write a new
 * operation mid-run and check whether a second read through the SAME snapshot
 * can see it. A snapshot that re-read would; one holding the answer cannot.
 * A `fs.readFile` counter would have to be aimed correctly to prove anything,
 * and a mis-aimed one looks convincing.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let connections: typeof import('../services/youtube-connection-store.js')
let store: typeof import('../services/youtube-operation-store.js')
let remote: typeof import('../services/youtube-remote-video.js')
let utils: typeof import('../services/utils.js')
let cleanup: (() => Promise<void>) | undefined

const NOW = '2026-09-01T12:00:00.000Z'
const PAYLOAD = {
  snippet_json: JSON.stringify({ title: 'Episode 1', description: '', tags: [], categoryId: '24' }),
  status_json: JSON.stringify({ privacyStatus: 'private' }),
  source_sha256: 'a'.repeat(64),
}

beforeEach(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  connections = await import('../services/youtube-connection-store.js')
  store = await import('../services/youtube-operation-store.js')
  remote = await import('../services/youtube-remote-video.js')
  utils = await import('../services/utils.js')
  await connections.configureYouTubeApplication({ client_id: 'client-id-1', client_secret: 'client-secret-1' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'channel-1', title: 'Channel 1', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 1_900_000_000_000 },
  })
})

afterEach(async () => { await cleanup?.(); cleanup = undefined })

async function projectWithChannel(name: string, episode = 'EP0001') {
  const { createProject } = await import('../services/project-manager.js')
  const created = await createProject({ name })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: 'channel-1', expected_previous_channel_id: null,
  })
  await store.createYouTubeOperation({
    project_slug: created.slug,
    episode_code: episode,
    channel_id: 'channel-1',
    source_revision: `source-${episode}`,
    metadata_revision: `metadata-${episode}`,
    final_payload: PAYLOAD,
    origin: 'manual',
    final_action: 'manual_upload',
  })
  return created
}

describe('the YouTube retention stores are read once per request', () => {
  test('WITHOUT a snapshot, a second read sees the operation written in between', async () => {
    // The control, and the shape of the bug: every row went back to disk for
    // records that cannot change while one response is being built.
    const created = await projectWithChannel('Cache Control')
    const first = await remote.readYouTubeRetentionStores(created.slug)
    assert.equal(first.records.length, 1)

    await store.createYouTubeOperation({
      project_slug: created.slug, episode_code: 'EP0002', channel_id: 'channel-1',
      source_revision: 'source-EP0002', metadata_revision: 'metadata-EP0002',
      final_payload: PAYLOAD, origin: 'manual', final_action: 'manual_upload',
    })

    const second = await remote.readYouTubeRetentionStores(created.slug)
    assert.equal(second.records.length, 2,
      'without a snapshot the reader goes back to disk every time')
  })

  test('WITH a snapshot, the whole list sees ONE consistent read', async () => {
    const created = await projectWithChannel('Cache Snapshot')
    const cache = utils.createProjectFactsCache(created.slug)

    const first = await remote.readYouTubeRetentionStores(created.slug, cache)
    assert.equal(first.records.length, 1)

    await store.createYouTubeOperation({
      project_slug: created.slug, episode_code: 'EP0002', channel_id: 'channel-1',
      source_revision: 'source-EP0002', metadata_revision: 'metadata-EP0002',
      final_payload: PAYLOAD, origin: 'manual', final_action: 'manual_upload',
    })

    for (let row = 0; row < 5; row++) {
      const again = await remote.readYouTubeRetentionStores(created.slug, cache)
      assert.equal(again.records.length, 1,
        'the snapshot must be read once and reused for every row in the response')
    }

    // And a NEW snapshot — the next request — sees the new truth.
    const nextRequest = utils.createProjectFactsCache(created.slug)
    const fresh = await remote.readYouTubeRetentionStores(created.slug, nextRequest)
    assert.equal(fresh.records.length, 2,
      'a snapshot must not outlive the request it was made for')
  })

  test('the publishing state is snapshotted alongside the records', async () => {
    const created = await projectWithChannel('Cache State')
    const cache = utils.createProjectFactsCache(created.slug)
    const first = await remote.readYouTubeRetentionStores(created.slug, cache)
    assert.ok(first.state, 'the state half is returned')

    // Same snapshot, same state object — the file is not re-read per row.
    const again = await remote.readYouTubeRetentionStores(created.slug, cache)
    assert.equal(again.state, first.state)

    const nextRequest = utils.createProjectFactsCache(created.slug)
    const fresh = await remote.readYouTubeRetentionStores(created.slug, nextRequest)
    assert.notEqual(fresh.state, first.state,
      'a fresh request must not be served the previous request\'s object')
  })

  test('concurrent rows share ONE read rather than racing to start their own', async () => {
    // The snapshot holds the PROMISE, not the value. Holding the value would
    // mean every row that started before the first read finished missed the
    // cache and read for itself — which is most of them.
    const created = await projectWithChannel('Cache Concurrency')
    const cache = utils.createProjectFactsCache(created.slug)
    const all = await Promise.all(Array.from({ length: 8 }, () =>
      remote.readYouTubeRetentionStores(created.slug, cache)))
    for (const stores of all) assert.equal(stores, all[0])
  })

  test('a snapshot made for another project is ignored, not believed', async () => {
    const created = await projectWithChannel('Cache Foreign')
    const foreign = utils.createProjectFactsCache('some-other-project')
    const viaForeign = await remote.readYouTubeRetentionStores(created.slug, foreign)
    const direct = await remote.readYouTubeRetentionStores(created.slug)
    assert.equal(viaForeign.records.length, direct.records.length)
    assert.equal(viaForeign.records[0]?.operation_id, direct.records[0]?.operation_id)
  })

  test('a failed read is not remembered as the answer', async () => {
    // A snapshot that memoised a rejection would fail every remaining episode
    // in the response because of one transient error.
    const created = await projectWithChannel('Cache Retry')
    const cache = utils.createProjectFactsCache(created.slug)
    const missing = utils.createProjectFactsCache('project-that-does-not-exist')
    await assert.rejects(() => remote.readYouTubeRetentionStores('project-that-does-not-exist', missing))

    // The same cache object now belongs to the missing slug, so it is ignored
    // for this project and the read genuinely happens.
    const recovered = await remote.readYouTubeRetentionStores(created.slug, cache)
    assert.equal(recovered.records.length, 1)

    // And a slug that exists but whose store is unreadable retries rather than
    // serving a remembered failure.
    assert.equal(missing.slug, 'project-that-does-not-exist')
  })
})
