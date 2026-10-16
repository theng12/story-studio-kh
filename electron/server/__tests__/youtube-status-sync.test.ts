/**
 * Following uploads after YouTube accepts them, "not found" vs "could not
 * check", and the duplicate guard before an episode may be uploaded again.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  registryCredentialFor,
} from '../lib/youtube-client.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetYouTubeTransportForTests()
  ;(await import('../services/youtube-status-sync.js'))._resetYouTubeStatusSyncForTests()
  await cleanup?.()
  cleanup = undefined
})

const CHANNEL = 'UC-status-sync'
const DAY = 24 * 60 * 60 * 1000
const VIDEOS = /^\/youtube\/v3\/videos\?part=snippet,status,processingDetails&id=/

async function setup() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const connections = await import('../services/youtube-connection-store.js')
  const operations = await import('../services/youtube-operation-store.js')
  const sidecars = await import('../services/upload-sidecar.js')
  const project = await pm.createProject({ name: `Status Sync ${Math.random()}` })
  const slug = project.slug
  await connections.configureYouTubeApplication({ client_id: 'sync-client', client_secret: 'sync-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Sync Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'sync-access', refresh_token: 'sync-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: CHANNEL, expected_previous_channel_id: null })

  async function episode(title: string) {
    const [idea] = await im.addIdeas(slug, [{ title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
    const accepted = await im.acceptIdea(slug, idea!.id, false)
    return String((accepted as any).episode_code || (await im.getIdeas(slug, 'accepted')).find(row => row.id === idea!.id)!.episode_code)
  }
  async function accepted(code: string, videoId: string, lifecycle?: 'ready' | 'processing') {
    const created = await operations.createYouTubeOperation({
      project_slug: slug, episode_code: code, channel_id: CHANNEL,
      source_revision: `src-${code}`, metadata_revision: `meta-${code}`, origin: 'manual', final_action: 'manual_upload',
    })
    const record = await operations.acceptYouTubeOperation({
      project_slug: slug, operation_id: created.operation_id, expected_revision: created.revision,
      channel_id: CHANNEL, video_id: videoId, accepted_at: new Date().toISOString(),
      final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
    })
    if (lifecycle) {
      await operations.updateYouTubeOperation({
        project_slug: slug, operation_id: record.operation_id, expected_revision: record.revision,
        mutate(current) { current.lifecycle = lifecycle },
      })
    }
    return record.operation_id
  }
  async function legacy(code: string, title: string, videoId: string) {
    await sidecars.writeSidecar(slug, code, title, {
      platform: 'youtube', video_id: videoId, account_id: 'old', channel_id: CHANNEL,
      uploaded_at: new Date(Date.now() - DAY).toISOString(), last_sync_at: '', scheduled_for: null,
      privacy_status: 'public', title, description: '', tags: [], thumbnail_set: true,
    })
  }
  return { slug, accountId: registryCredentialFor(CHANNEL), episode, accepted, legacy, operations, sidecars, connections }
}

function video(id: string, uploadStatus: string, title = id) {
  return { id, status: { uploadStatus, privacyStatus: 'public' }, snippet: { title, channelId: CHANNEL } }
}

describe('not found is not "could not check"', () => {
  test('an answer without the video records not_found; a failed request records nothing', async () => {
    const { mapYouTubePublicationState, isConfirmedGoneFromYouTube, syncYouTubePublicationState } = await import('../services/youtube-publication-status.js')
    const absent = mapYouTubePublicationState(null, '2026-10-07T00:00:00.000Z')
    assert.equal(absent.lifecycle, 'status_unavailable')
    assert.equal(absent.processing.provider_status, 'not_found')
    assert.equal(isConfirmedGoneFromYouTube(absent), true)
    assert.equal(isConfirmedGoneFromYouTube(mapYouTubePublicationState({ uploadStatus: 'someFutureStatus' })), false)

    const s = await setup()
    const code = await s.episode('Gone Video')
    const operationId = await s.accepted(code, 'vid-gone')
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, status: 503, body: { error: { message: 'backend' } } })
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(() => syncYouTubePublicationState({ project_slug: s.slug, operation_id: operationId, account_id: s.accountId }))
    assert.equal((await s.operations.readYouTubeOperation(s.slug, operationId))?.lifecycle, 'accepted', 'could not check: unchanged')

    const answered = new FakeYouTube()
    answered.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
    __setYouTubeTransportForTests(answered.transport())
    await syncYouTubePublicationState({ project_slug: s.slug, operation_id: operationId, account_id: s.accountId })
    const stored = await s.operations.readYouTubeOperation(s.slug, operationId)
    assert.equal(stored?.processing?.provider_status, 'not_found')
  })
})

describe('Check All Uploads', () => {
  test('moves accepted operations to ready and records legacy uploads on their sidecars', async () => {
    const s = await setup()
    const withRecord = await s.episode('Has Record')
    const oldOne = await s.episode('Old Upload')
    const deleted = await s.episode('Deleted Upload')
    const operationId = await s.accepted(withRecord, 'vid-record')
    await s.legacy(oldOne, 'Old Upload', 'vid-legacy')
    await s.legacy(deleted, 'Deleted Upload', 'vid-deleted')
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: /id=vid-record$/, body: { items: [video('vid-record', 'processed')] } })
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [video('vid-legacy', 'processed')] } })
    __setYouTubeTransportForTests(fake.transport())

    const { checkAllYouTubeUploads } = await import('../services/youtube-status-sync.js')
    const result = await checkAllYouTubeUploads({ project_slug: s.slug, account_id: s.accountId })

    assert.equal(result.outcome, 'ok')
    assert.deepEqual(result.legacy, { checked: 2, processed: 1, not_found: 1 })
    assert.equal(result.checked, 3)
    assert.equal((await s.operations.readYouTubeOperation(s.slug, operationId))?.lifecycle, 'ready')
    const old = await s.sidecars.readSidecarStrict(s.slug, oldOne, 'youtube')
    assert.equal(old?.youtube_check?.upload_status, 'processed')
    assert.equal(old?.youtube_check?.channel_id, CHANNEL)
    assert.equal(old?.title, 'Old Upload', 'every other sidecar field is kept')
    assert.equal((await s.sidecars.readSidecarStrict(s.slug, deleted, 'youtube'))?.youtube_check?.upload_status, 'not_found')
  })

  test('an answer holding none of several known videos concludes nothing (likely another Google account)', async () => {
    const s = await setup()
    for (const title of ['A one', 'B two', 'C three']) {
      const code = await s.episode(title)
      await s.legacy(code, title, `vid-${title.split(' ')[0]}`)
    }
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
    __setYouTubeTransportForTests(fake.transport())
    const { checkAllYouTubeUploads } = await import('../services/youtube-status-sync.js')
    const result = await checkAllYouTubeUploads({ project_slug: s.slug, account_id: s.accountId })
    assert.equal(result.legacy.checked, 0)
    assert.notEqual(result.outcome, 'ok')
  })
})

describe('background check', () => {
  test('asks about unfinished uploads first, then stale finished ones, and backs off after a failure', async () => {
    const s = await setup()
    await s.accepted(await s.episode('Pending'), 'vid-pending')
    await s.accepted(await s.episode('Done'), 'vid-done', 'ready')
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=vid-pending', status: 500, body: {} })
    __setYouTubeTransportForTests(fake.transport())
    const { runYouTubeStatusSyncPass } = await import('../services/youtube-status-sync.js')
    const now = Date.now()
    await runYouTubeStatusSyncPass(now)
    assert.deepEqual(fake.calls.map(call => call.path), ['/youtube/v3/videos?part=snippet,status,processingDetails&id=vid-pending'])
    await runYouTubeStatusSyncPass(now + 60_000)
    assert.equal(fake.calls.length, 1, 'backing off: no second request a minute later')

    fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=vid-pending', body: { items: [video('vid-pending', 'uploaded')] } })
    // The ready upload has never been observed, so the bounded stale refresh asks about it too.
    fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=vid-done', body: { items: [video('vid-done', 'processed')] } })
    await runYouTubeStatusSyncPass(now + 7 * 60 * 60 * 1000)
    assert.deepEqual(fake.calls.slice(1).map(call => call.path), [
      '/youtube/v3/videos?part=snippet,status,processingDetails&id=vid-pending',
      '/youtube/v3/videos?part=snippet,status,processingDetails&id=vid-done',
    ])
    const pending = (await s.operations.listYouTubeOperations(s.slug)).find(record => record.video_id === 'vid-pending')
    assert.equal(pending?.lifecycle, 'processing')
  })

  test('background check stores a multiline (and Unicode) description instead of failing the write', async () => {
    // Regression: TN0171–TN0173 logged "YouTube status not checked yet (… invalid
    // remote_snapshot.description …)" and the background check hit the same wall.
    const s = await setup()
    const operationId = await s.accepted(await s.episode('Multiline'), 'vid-multi')
    const description = 'First line.\n\nChapters\n00:00 Start\n\nដំណេកស្ងប់ 🌙'
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [{
      id: 'vid-multi',
      status: { uploadStatus: 'uploaded', privacyStatus: 'private', publishAt: '2026-12-03T15:00:00Z' },
      snippet: { title: 'Multiline', description, channelId: CHANNEL },
    }] } })
    __setYouTubeTransportForTests(fake.transport())
    const { runYouTubeStatusSyncPass } = await import('../services/youtube-status-sync.js')
    await runYouTubeStatusSyncPass(Date.now())
    const stored = await s.operations.readYouTubeOperation(s.slug, operationId)
    assert.equal(stored?.lifecycle, 'processing')
    assert.equal(stored?.remote_snapshot?.description, description)
    assert.equal(stored?.remote_snapshot?.scheduled_for, '2026-12-03T15:00:00Z')
  })

  test('skips a channel that needs Reconnect', async () => {
    const s = await setup()
    await s.accepted(await s.episode('Pending'), 'vid-pending')
    await s.connections.markYouTubeChannelStatus(CHANNEL, 'reconnect_required')
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const { runYouTubeStatusSyncPass } = await import('../services/youtube-status-sync.js')
    await runYouTubeStatusSyncPass()
    assert.equal(fake.calls.length, 0)
  })

  test('warns once, a day ahead, when a 7-day sign-in is about to lapse', async () => {
    const s = await setup()
    const authorized = Date.parse((await s.connections.readYouTubeConnectionRegistry()).channels[CHANNEL]!.authorized_at!)
    await s.connections.markYouTubeChannelSignInExpired(CHANNEL, authorized + 7 * DAY)
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Sync Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'a2', refresh_token: 'r2', expires_at: Date.now() + 3_600_000 },
    })
    const reauthorized = Date.parse((await s.connections.readYouTubeConnectionRegistry()).channels[CHANNEL]!.authorized_at!)
    const { runYouTubeStatusSyncPass, setYouTubeNoticeDispatcher } = await import('../services/youtube-status-sync.js')
    const notices: string[] = []
    setYouTubeNoticeDispatcher(notice => { notices.push(notice.title) })
    __setYouTubeTransportForTests(new FakeYouTube().transport())
    await runYouTubeStatusSyncPass(reauthorized + 5 * DAY)
    assert.equal(notices.length, 0, 'not yet within a day')
    await runYouTubeStatusSyncPass(reauthorized + 6.5 * DAY)
    await runYouTubeStatusSyncPass(reauthorized + 6.6 * DAY)
    assert.equal(notices.length, 1)
    assert.match(notices[0]!, /Sync Channel/)
  })
})

describe('duplicate guard before uploading again', () => {
  function channelUploads(fake: FakeYouTube, items: Array<{ videoId: string; title: string }>) {
    fake.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/channels\?/, body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-list' } } }] } })
    fake.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/playlistItems\?/, body: {
      items: items.map(item => ({ snippet: { title: item.title, resourceId: { videoId: item.videoId } }, status: {} })),
    } })
  }

  test('refuses while YouTube still has a known video, or another video carries the title; could-not-check refuses too', async () => {
    const s = await setup()
    const { assertSafeToUploadAgain } = await import('../services/youtube-publication-status.js')
    const input = { project_slug: s.slug, account_id: s.accountId, video_ids: ['vid-first', 'vid-second'], titles: ['The Golden Mirror'] }

    let fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [video('vid-first', 'processed')] } })
    channelUploads(fake, [])
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(() => assertSafeToUploadAgain(input), (error: any) => error.code === 'YOUTUBE_ALREADY_PUBLISHED' && /vid-first/.test(error.detail))

    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
    channelUploads(fake, [{ videoId: 'vid-twin', title: '  the golden   MIRROR ' }])
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(() => assertSafeToUploadAgain(input), (error: any) => error.code === 'YOUTUBE_ALREADY_PUBLISHED' && /vid-twin/.test(error.detail))

    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, status: 503, body: {} })
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(() => assertSafeToUploadAgain(input), (error: any) => error.code === 'YOUTUBE_STATUS_UNCHECKED')

    fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: VIDEOS, body: { items: [] } })
    channelUploads(fake, [{ videoId: 'vid-other', title: 'Another Episode' }])
    __setYouTubeTransportForTests(fake.transport())
    await assertSafeToUploadAgain(input)
  })
})
