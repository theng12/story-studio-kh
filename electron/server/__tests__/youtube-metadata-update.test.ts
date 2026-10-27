/**
 * Changing the title/description/tags of a video ALREADY on YouTube.
 *
 * The hazard these tests exist for is `videos.update part=snippet`: it
 * REPLACES the whole snippet, so any field the caller omits is erased. Every
 * test below therefore asks two questions — did the change land, and did
 * everything else survive untouched?
 *
 * All provider traffic goes through `FakeYouTube`; an unqueued request throws
 * locally, so nothing here can reach YouTube.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let cleanup: (() => Promise<void>) | undefined
let youtube: typeof import('../lib/youtube-client.js')
let connections: typeof import('../services/youtube-connection-store.js')
let operations: typeof import('../services/youtube-operation-store.js')
let projects: typeof import('../services/project-manager.js')
let auditStore: typeof import('../services/youtube-video-audit-store.js')
let metadataUpdate: typeof import('../services/youtube-metadata-update.js')
let app: express.Express

const CHANNEL = 'UC-yt-metadata'
const OTHER_CHANNEL = 'UC-yt-metadata-other'
const TITLE = 'The Entire History of China'
const DESCRIPTION = 'A calm, unhurried journey through the long material history of China.'
const TAGS = ['history', 'sleep history', 'China history']

/** What YouTube reports before any change. The fields that must be preserved. */
function liveVideo(overrides: { title?: string, description?: string, tags?: string[] } = {}) {
  return {
    etag: '"etag-baseline"',
    snippet: {
      title: overrides.title ?? TITLE,
      description: overrides.description ?? DESCRIPTION,
      tags: overrides.tags ?? TAGS,
      categoryId: '27',
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    },
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false,
      embeddable: true,
      license: 'youtube',
      publicStatsViewable: true,
      containsSyntheticMedia: true,
    },
  }
}

function listBody(videoId: string, video: ReturnType<typeof liveVideo>) {
  return { items: [{ id: videoId, etag: video.etag, snippet: video.snippet, status: video.status }] }
}

function listPath(videoId: string): string {
  return `/youtube/v3/videos?part=snippet,status&id=${videoId}`
}

const PAYLOAD = {
  snippet_json: JSON.stringify({ title: TITLE, description: DESCRIPTION, tags: TAGS, categoryId: '27' }),
  status_json: JSON.stringify({ privacyStatus: 'public' }),
  source_sha256: 'a'.repeat(64),
}

let slug = ''
let episodeCounter = 0

async function uploadedVideo(videoId: string, channel = CHANNEL, projectSlug = slug) {
  episodeCounter += 1
  const created = await operations.createYouTubeOperation({
    project_slug: projectSlug,
    episode_code: `EP${String(1000 + episodeCounter)}`,
    channel_id: channel,
    source_revision: `source-${videoId}`,
    metadata_revision: `metadata-${videoId}`,
    origin: 'manual',
    final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: projectSlug,
    operation_id: created.operation_id,
    expected_revision: created.revision,
    channel_id: channel,
    video_id: videoId,
    accepted_at: new Date().toISOString(),
    final_payload: PAYLOAD,
  })
  return { operationId: created.operation_id, episodeCode: accepted.episode_code }
}

function updateUrl(projectSlug = slug): string {
  return `/api/projects/${projectSlug}/youtube/videos/metadata`
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  youtube = await import('../lib/youtube-client.js')
  connections = await import('../services/youtube-connection-store.js')
  operations = await import('../services/youtube-operation-store.js')
  projects = await import('../services/project-manager.js')
  auditStore = await import('../services/youtube-video-audit-store.js')
  metadataUpdate = await import('../services/youtube-metadata-update.js')
  const { router } = await import('../routes/youtube-upload-center.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)

  const project = await projects.createProject({ name: 'YouTube metadata update' })
  slug = project.slug
  await connections.configureYouTubeApplication({ client_id: 'yt-metadata-client', client_secret: 'yt-metadata-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Metadata Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'yt-metadata-access',
      refresh_token: 'yt-metadata-refresh',
      expires_at: Date.now() + 3_600_000,
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
})

after(async () => {
  youtube.__resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

describe('a metadata update preserves everything it was not asked to change', () => {
  test('only the supplied fields move; category/language/description/tags are carried through the PUT', async () => {
    const videoId = 'vid-preserve'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: videoId, snippet: liveVideo().snippet } })
    fake.respond({
      method: 'GET', path: listPath(videoId),
      body: listBody(videoId, liveVideo({ title: `${TITLE} For Sleep` })),
    })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).post(updateUrl())
      .send({ confirm: true, operation_id: operationId, title: `${TITLE} For Sleep` })

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.applied_fields, ['title'])
    assert.equal(res.body.verified, true)

    const put = fake.calls.find(call => call.method === 'PUT')
    assert.ok(put, 'the update reached YouTube')
    assert.equal(put!.path, '/youtube/v3/videos?part=snippet')
    const sent = JSON.parse(put!.body!)
    assert.equal(sent.id, videoId)
    assert.equal(sent.snippet.title, `${TITLE} For Sleep`)
    // THE HAZARD: everything not supplied is still in the snippet.
    assert.equal(sent.snippet.description, DESCRIPTION)
    assert.deepEqual(sent.snippet.tags, TAGS)
    assert.equal(sent.snippet.categoryId, '27')
    assert.equal(sent.snippet.defaultLanguage, 'en')
    assert.equal(sent.snippet.defaultAudioLanguage, 'en')
    // The etag of the read the update was built from is the precondition.
    assert.equal(put!.headers?.['if-match'], '"etag-baseline"')
  })

  test('never sends part=status and never moves privacy, publishAt or any status field', async () => {
    const videoId = 'vid-status'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: videoId } })
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo({ description: 'New prose.' })) })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).post(updateUrl())
      .send({ confirm: true, operation_id: operationId, description: 'New prose.' })
    assert.equal(res.status, 200, JSON.stringify(res.body))

    // No UPDATE ever asked for the status part or carried a status block. The
    // READS do ask for it (that is how the status is proved unchanged).
    for (const call of fake.calls) {
      if (call.method === 'PUT') {
        assert.equal(call.path, '/youtube/v3/videos?part=snippet', 'an update must send part=snippet only')
        assert.equal('status' in JSON.parse(call.body!), false, 'the PUT must carry no status block')
      } else {
        assert.match(call.path, /part=snippet,status/, 'the read asks for the status it must leave alone')
      }
    }

    const record = await operations.readYouTubeOperation(slug, operationId)
    assert.equal(record?.remote_snapshot?.privacy_status, 'public')
    assert.equal(record?.metadata_updates?.at(-1)?.verified, true)
    const receipt = record!.metadata_updates!.at(-1)!
    assert.deepEqual(receipt.baseline_status, receipt.after_status, 'status is byte-identical before and after')
  })

  test('a second identical call makes no second update request', async () => {
    const videoId = 'vid-idempotent'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: videoId } })
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo({ title: 'New title' })) })
    // Second call: the fresh read already matches, so no PUT may be queued.
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo({ title: 'New title' })) })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const first = await request(app).post(updateUrl()).send({ confirm: true, operation_id: operationId, title: 'New title' })
    assert.equal(first.status, 200)
    assert.equal(first.body.changed, true)

    const second = await request(app).post(updateUrl()).send({ confirm: true, operation_id: operationId, title: 'New title' })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.changed, false)
    assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 1, 'exactly one provider update')
  })
})

describe('the boundaries refuse rather than guess or truncate', () => {
  test('YouTube limits are refused with a plain message and no provider call', async () => {
    const videoId = 'vid-limits'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    youtube.__setYouTubeTransportForTests(fake.transport())

    const cases: Array<{ body: Record<string, unknown>, pattern: RegExp }> = [
      { body: { title: 'x'.repeat(101) }, pattern: /at most 100 characters.*101/ },
      { body: { title: 'A <b> title' }, pattern: /cannot contain the < or > characters/ },
      { body: { description: 'x'.repeat(5001) }, pattern: /at most 5000 bytes.*5001/ },
      { body: { tags: Array.from({ length: 30 }, () => 'a tag with spaces') }, pattern: /at most 500 characters/ },
    ]
    for (const { body, pattern } of cases) {
      const res = await request(app).post(updateUrl()).send({ confirm: true, operation_id: operationId, ...body })
      assert.equal(res.status, 400, JSON.stringify(res.body))
      assert.equal(res.body.code, 'YOUTUBE_METADATA_LIMIT_EXCEEDED')
      assert.match(res.body.detail, pattern)
    }
    assert.deepEqual(fake.calls, [], 'a refused value must never reach YouTube')
  })

  test('the description limit is measured in UTF-8 BYTES, not characters', async () => {
    // Khmer is 3 bytes per character: 1,900 characters is 5,700 bytes.
    const khmer = 'ក'.repeat(1_900)
    assert.throws(
      () => metadataUpdate.assertMetadataFieldsWithinYouTubeLimits({ description: khmer }),
      /5000 bytes/,
    )
  })

  test('refuses a video id that no record maps to this channel', async () => {
    const fake = new FakeYouTube()
    youtube.__setYouTubeTransportForTests(fake.transport())
    const res = await request(app).post(updateUrl())
      .send({ confirm: true, video_id: 'vid-not-ours', title: 'Anything' })
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'YOUTUBE_VIDEO_NOT_FOUND')
    assert.deepEqual(fake.calls, [])
  })

  test('refuses when the video id names a different episode than the operation', async () => {
    const videoId = 'vid-own-record'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    youtube.__setYouTubeTransportForTests(fake.transport())
    const res = await request(app).post(updateUrl())
      .send({ confirm: true, operation_id: operationId, video_id: 'vid-someone-else', title: 'Anything' })
    assert.equal(res.status, 404)
    assert.match(res.body.detail, /not the one EP\d+ uploaded/)
    assert.deepEqual(fake.calls, [])
  })

  test('refuses a stale baseline instead of overwriting a video that moved', async () => {
    const videoId = 'vid-stale'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).post(updateUrl()).send({
      confirm: true, operation_id: operationId, title: 'Prepared title', expected_baseline_hash: 'f'.repeat(64),
    })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal(res.body.code, 'YOUTUBE_METADATA_BASELINE_STALE')
    assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 0)
  })

  test('refuses without confirmation', async () => {
    const videoId = 'vid-noconfirm'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    youtube.__setYouTubeTransportForTests(fake.transport())
    const res = await request(app).post(updateUrl())
      .send({ operation_id: operationId, title: 'Anything' })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'YOUTUBE_CONFIRMATION_REQUIRED')
    assert.deepEqual(fake.calls, [])
  })

  test('a title the junk gate rejects is refused as bad TEXT, not as a provider failure', async () => {
    const videoId = 'vid-junk'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    youtube.__setYouTubeTransportForTests(fake.transport())

    // A markdown heading out of the metadata document — the shape that
    // uploaded "# SEO-Optimized Video Titles" as a real title.
    const res = await request(app).post(updateUrl())
      .send({ confirm: true, operation_id: operationId, title: '# SEO-Optimized Video Titles' })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.equal(res.body.code, 'YOUTUBE_METADATA_JUNK')
    assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 0, 'nothing was written')
  })
})

describe('failures leave honest evidence', () => {
  test('a provider write failure changes nothing local', async () => {
    const videoId = 'vid-provider-fail'
    const { operationId } = await uploadedVideo(videoId)
    // Seed a snapshot so "unchanged" is observable.
    const before = await operations.readYouTubeOperation(slug, operationId)
    await operations.updateYouTubeOperation({
      project_slug: slug, operation_id: operationId, expected_revision: before!.revision,
      mutate(record) {
        record.remote_snapshot = {
          fetched_at: '2026-10-01T00:00:00.000Z', title: TITLE, description: DESCRIPTION, tags: TAGS,
          privacy_status: 'public', scheduled_for: null,
        }
      },
    })
    const seeded = await operations.readYouTubeOperation(slug, operationId)

    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', status: 500, body: { error: { message: 'backend error' } } })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).post(updateUrl())
      .send({ confirm: true, operation_id: operationId, title: 'Never applied' })
    assert.equal(res.status, 502, JSON.stringify(res.body))
    assert.equal(res.body.code, 'YOUTUBE_METADATA_UPDATE_FAILED')

    const after = await operations.readYouTubeOperation(slug, operationId)
    assert.equal(after?.metadata_updates, undefined, 'no receipt claims a change')
    assert.deepEqual(after?.remote_snapshot, seeded?.remote_snapshot, 'the local record is exactly what it was')
  })

  test('a read-back that does not match is reported loudly and recorded as unverified', async () => {
    const videoId = 'vid-verify-fail'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: videoId } })
    // YouTube silently kept a different title.
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo({ title: 'Something YouTube insisted on' })) })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).post(updateUrl())
      .send({ confirm: true, operation_id: operationId, title: 'What we asked for' })
    assert.equal(res.status, 502, JSON.stringify(res.body))
    assert.equal(res.body.code, 'YOUTUBE_METADATA_VERIFICATION_FAILED')
    assert.match(res.body.detail, /YouTube accepted the change/)

    const record = await operations.readYouTubeOperation(slug, operationId)
    const receipt = record?.metadata_updates?.at(-1)
    assert.ok(receipt, 'the observed result is kept even when it does not match')
    assert.equal(receipt!.verified, false)
    assert.ok((receipt!.mismatches ?? []).some(mismatch => /title/.test(mismatch)))
  })
})

describe('the receipt is append-only', () => {
  test('the store refuses rewriting or removing an earlier metadata receipt', async () => {
    const videoId = 'vid-append-only'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: videoId } })
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo({ title: 'Applied' })) })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).post(updateUrl()).send({ confirm: true, operation_id: operationId, title: 'Applied' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const recorded = await operations.readYouTubeOperation(slug, operationId)
    assert.equal(recorded?.metadata_updates?.length, 1)

    await assert.rejects(
      () => operations.updateYouTubeOperation({
        project_slug: slug, operation_id: operationId, expected_revision: recorded!.revision,
        mutate(record) { record.metadata_updates = [] },
      }),
      /append-only|immutable/i,
    )
  })
})

describe('the local record follows the applied change', () => {
  test('the applied title is the local intent afterwards, so Library does not report our own write as drift', async () => {
    const videoId = 'vid-comparison'
    const { operationId } = await uploadedVideo(videoId)
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo()) })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: videoId } })
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, liveVideo({ title: `${TITLE} For Sleep` })) })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).post(updateUrl())
      .send({ confirm: true, operation_id: operationId, title: `${TITLE} For Sleep` })
    assert.equal(res.status, 200, JSON.stringify(res.body))

    const record = await operations.readYouTubeOperation(slug, operationId)
    // The live snapshot now holds what YouTube returned.
    assert.equal(record?.remote_snapshot?.title, `${TITLE} For Sleep`)
    assert.equal(record?.previous_remote_snapshot?.title, TITLE, 'the baseline is kept as the before')

    const { compareYouTubeVideo } = await import('../services/youtube-metadata-comparison.js')
    const comparison = compareYouTubeVideo(record!)
    const title = comparison.fields.find(field => field.field === 'title')!
    assert.equal(title.state, 'in_sync', `expected in_sync, got ${title.state} (${JSON.stringify(title)})`)
    // The immutable upload payload is untouched: what was SENT at accept time
    // is evidence and must never be rewritten by a later edit.
    assert.match(record!.final_payload!.snippet_json, new RegExp(`"title":${JSON.stringify(TITLE)}`))
  })
})

describe('the shared snippet hash', () => {
  test('is stable for the same values and changes when a preserved field changes', () => {
    const a = metadataUpdate.metadataSnippetSnapshot({
      etag: 'e', title: 'T', description: 'D', tags: ['a'], categoryId: '27',
      privacyStatus: 'public', publishAt: null, defaultLanguage: 'en', defaultAudioLanguage: 'en',
      selfDeclaredMadeForKids: false, embeddable: true, license: 'youtube', publicStatsViewable: true,
    } as any)
    assert.equal(metadataUpdate.metadataSnippetHash(a), metadataUpdate.metadataSnippetHash({ ...a }))
    assert.notEqual(
      metadataUpdate.metadataSnippetHash(a),
      metadataUpdate.metadataSnippetHash({ ...a, categoryId: '22' }),
      'preserved fields are part of the identity the caller prepares against',
    )
  })
})
