/**
 * The stored metadata audit read (`GET .../youtube/audit`).
 *
 * Production's ledger adapter joins Story's native `metadata_updates[]`
 * receipts to its own observation history. What matters here:
 *
 *   1. The read returns the records exactly as the stores hold them — the
 *      receipt comes from the REAL update path (the same POST that writes it),
 *      not a hand-built fixture.
 *   2. It makes NO provider call: every response FakeYouTube queues is
 *      consumed by the write, so any request the read made would fail locally.
 *   3. Identity is the assigned channel. A reassigned project must not answer
 *      with the previous channel's operations or observations.
 *   4. Missing stays missing (a video with no observation is absent, not
 *      "unchanged") and stale says so (`current: false`).
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

const PAYLOAD = {
  snippet_json: JSON.stringify({ title: 'Audit read title', description: 'Audit read description.', tags: ['history'], categoryId: '24' }),
  status_json: JSON.stringify({ privacyStatus: 'public' }),
  source_sha256: 'a'.repeat(64),
}

let projectNameCounter = 0
let episodeCounter = 0
let booted: Promise<void> | undefined

/** One data root for the file, the application already connected. */
async function boot(): Promise<void> {
  booted ??= (async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    youtube = await import('../lib/youtube-client.js')
    connections = await import('../services/youtube-connection-store.js')
    operations = await import('../services/youtube-operation-store.js')
    projects = await import('../services/project-manager.js')
    auditStore = await import('../services/youtube-video-audit-store.js')
    metadataUpdate = await import('../services/youtube-metadata-update.js')
    const { router: uploadRouter } = await import('../routes/youtube-upload-center.js')
    const { router: auditRouter } = await import('../routes/youtube-audit.js')
    app = express()
    app.use(express.json())
    // The write path that produces a native receipt, and the read under test.
    app.use('/api', uploadRouter)
    app.use('/api', auditRouter)
    await connections.configureYouTubeApplication({ client_id: 'audit-read-client', client_secret: 'audit-read-secret' })
  })()
  return booted
}

/**
 * A project of its own on a channel of its own: the audit ledger is keyed by
 * project and channel, and a YouTube channel can be assigned to only one
 * project, so each test gets both fresh.
 */
async function freshProject(assigned = true): Promise<{ slug: string, channel: string }> {
  projectNameCounter += 1
  const channel = `UC-audit-read-${projectNameCounter}`
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channel, title: `Audit Read Channel ${projectNameCounter}`, granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: `audit-read-access-${projectNameCounter}`,
      refresh_token: `audit-read-refresh-${projectNameCounter}`,
      expires_at: Date.now() + 3_600_000,
    },
  })
  const project = await projects.createProject({ name: `Audit read project ${projectNameCounter}` })
  if (assigned) {
    await connections.assignProjectYouTubeChannel({
      project_slug: project.slug, channel_id: channel, expected_previous_channel_id: null,
    })
  }
  return { slug: project.slug, channel }
}

async function uploadedVideo(slug: string, channel: string, videoId: string): Promise<string> {
  episodeCounter += 1
  const created = await operations.createYouTubeOperation({
    project_slug: slug,
    episode_code: `EP${String(3000 + episodeCounter)}`,
    channel_id: channel,
    source_revision: `source-${videoId}`,
    metadata_revision: `metadata-${videoId}`,
    origin: 'manual',
    final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug,
    operation_id: created.operation_id,
    expected_revision: created.revision,
    channel_id: channel,
    video_id: videoId,
    accepted_at: new Date().toISOString(),
    final_payload: PAYLOAD,
  })
  return created.operation_id
}

function listPath(videoId: string): string {
  return `/youtube/v3/videos?part=snippet,status&id=${videoId}`
}

function listBody(videoId: string, title: string) {
  return {
    items: [{
      id: videoId,
      etag: `"etag-${videoId}"`,
      snippet: { title, description: 'Audit read description.', tags: ['history'], categoryId: '24' },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
        embeddable: true,
        license: 'youtube',
        publicStatsViewable: true,
      },
    }],
  }
}

function auditUrl(slug: string): string {
  return `/api/projects/${slug}/youtube/audit`
}

before(boot)

after(async () => {
  youtube.__resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

describe('the stored audit read', () => {
  test('returns the native receipt and the stored observation without calling YouTube', async () => {
    const { slug, channel } = await freshProject()
    const videoId = 'vidAuditRead1'
    const operationId = await uploadedVideo(slug, channel, videoId)
    // A second upload with NO observation at all: it must stay absent rather
    // than appear as "unchanged".
    await uploadedVideo(slug, channel, 'vidAuditRead2')

    const checkedAt = new Date(Date.now() - 60_000).toISOString()
    await auditStore.recordVideoAuditEntries({
      project_slug: slug,
      channel_id: channel,
      entries: [{
        video_id: videoId,
        channel_id: channel,
        checked_at: checkedAt,
        title: 'Before the write',
        description_length: 23,
        description_empty: false,
        tag_count: 1,
        snippet_sha256: 'b'.repeat(64),
        snippet_sha256_algorithm: metadataUpdate.METADATA_SNIPPET_HASH_ALGORITHM,
        privacy_status: 'public',
        publish_at: null,
        findings: [],
      }],
    })

    // Apply a real change through the real route, so the receipt in the read
    // is the one the store actually wrote. Three queued responses, all
    // consumed here — anything the read asks for afterwards fails locally.
    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, 'Before the write') })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: videoId } })
    fake.respond({ method: 'GET', path: listPath(videoId), body: listBody(videoId, 'Applied title') })
    youtube.__setYouTubeTransportForTests(fake.transport())
    const applied = await request(app)
      .post(`/api/projects/${slug}/youtube/videos/metadata`)
      .send({ confirm: true, operation_id: operationId, title: 'Applied title' })
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    const callsAfterWrite = fake.calls.length
    assert.equal(callsAfterWrite, 3)

    const res = await request(app).get(auditUrl(slug))
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(fake.calls.length, callsAfterWrite, 'the read spent no provider call')
    assert.equal(res.body.project_slug, slug)
    assert.equal(res.body.channel_id, channel)
    assert.equal(res.body.unavailable_reason, null)

    assert.equal(res.body.operations.length, 2)
    const operation = res.body.operations.find((entry: { video_id?: string }) => entry.video_id === videoId)
    assert.ok(operation, 'the accepted upload is in the read')
    assert.equal(operation.channel_id, channel)
    assert.equal(operation.project_slug, slug)
    assert.equal(operation.metadata_updates.length, 1, 'the native receipt, verbatim')
    const receipt = operation.metadata_updates[0]
    assert.equal(receipt.receipt_id, applied.body.receipt_id)
    assert.equal(receipt.video_id, videoId)
    assert.equal(receipt.verified, true)
    assert.deepEqual(receipt.applied_fields, ['title'])

    assert.equal(res.body.videos.length, 1, 'a video with no observation stays absent')
    const observation = res.body.videos[0]
    assert.equal(observation.video_id, videoId)
    assert.equal(observation.story_receipt_id, receipt.receipt_id, 'marker joins to the receipt')
    assert.equal(observation.current, false, 'the observation predates Story\'s own write')

    // Nothing that signs a request may leave through a read.
    assert.doesNotMatch(
      JSON.stringify(res.body),
      /access_token|refresh_token|client_secret|session_url|snippet_json/,
    )
  })

  test('an unassigned project reports why it is empty instead of guessing a channel', async () => {
    const { slug } = await freshProject(false)
    const res = await request(app).get(auditUrl(slug))

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.channel_id, null)
    assert.equal(res.body.unavailable_reason, 'no_channel_assigned')
    assert.deepEqual(res.body.operations, [])
    assert.deepEqual(res.body.videos, [])
  })

  test('a reassigned project does not answer with the previous channel\'s records', async () => {
    const { slug, channel } = await freshProject()
    const videoId = 'vidAuditRead3'
    await uploadedVideo(slug, channel, videoId)
    await auditStore.recordVideoAuditEntries({
      project_slug: slug,
      channel_id: channel,
      entries: [{
        video_id: videoId,
        channel_id: channel,
        checked_at: new Date().toISOString(),
        title: 'Previous channel',
        description_length: 16,
        description_empty: false,
        tag_count: 1,
        snippet_sha256: 'c'.repeat(64),
        snippet_sha256_algorithm: metadataUpdate.METADATA_SNIPPET_HASH_ALGORITHM,
        privacy_status: 'public',
        publish_at: null,
        findings: [],
      }],
    })

    projectNameCounter += 1
    const nextChannel = `UC-audit-read-next-${projectNameCounter}`
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: nextChannel, title: 'Audit Read Next Channel', granted_scopes: ['youtube.upload'] },
      tokens: {
        access_token: 'audit-read-access-next',
        refresh_token: 'audit-read-refresh-next',
        expires_at: Date.now() + 3_600_000,
      },
    })
    await connections.assignProjectYouTubeChannel({
      project_slug: slug, channel_id: nextChannel, expected_previous_channel_id: channel,
    })

    const res = await request(app).get(auditUrl(slug))
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.channel_id, nextChannel)
    assert.deepEqual(res.body.operations, [], 'the old channel\'s operation is not this project\'s answer')
    assert.deepEqual(res.body.videos, [], 'nor is its observation')
    assert.equal(res.body.unavailable_reason, 'nothing_recorded')
  })
})
