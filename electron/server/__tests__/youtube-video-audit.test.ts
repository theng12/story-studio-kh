/**
 * The read-only video audit, and the ledger that keeps it from re-reading the
 * same videos every time.
 *
 * Every `videos.list` call costs the channel's shared daily quota, so the one
 * property that matters most here is: an audit of an unchanged channel makes
 * NO provider call. The second: when Story Studio itself changes a video, the
 * audit re-reads exactly that video and nothing else.
 *
 * All provider traffic goes through `FakeYouTube`; an unqueued request throws
 * locally, so "zero calls" is provable by the absence of any request.
 */
import assert from 'node:assert/strict'
import { after, afterEach, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const CHANNEL_PREFIX = 'UC-audit-channel'
const PAYLOAD = {
  snippet_json: JSON.stringify({ title: 'Audit title', description: '', tags: [], categoryId: '24' }),
  status_json: JSON.stringify({ privacyStatus: 'public' }),
  source_sha256: 'a'.repeat(64),
}

let youtube: typeof import('../lib/youtube-client.js')
let connections: typeof import('../services/youtube-connection-store.js')
let operations: typeof import('../services/youtube-operation-store.js')
let projects: typeof import('../services/project-manager.js')
let auditStore: typeof import('../services/youtube-video-audit-store.js')
let app: express.Express
let cleanup: (() => Promise<void>) | undefined
let projectNameCounter = 0

/** The hash rule the update route compares `expected_baseline_hash` against. */
const ALGORITHM = 'sha256:utf8-json:{title,description,tags,categoryId,defaultLanguage,defaultAudioLanguage}'

function listPath(ids: string[]): string {
  return `/youtube/v3/videos?part=snippet,status&id=${ids.join(',')}`
}

function videoItem(id: string, overrides: { title?: string, description?: string, tags?: string[], privacy?: string } = {}) {
  return {
    id,
    etag: `"etag-${id}"`,
    snippet: {
      title: overrides.title ?? `Title ${id}`,
      description: overrides.description ?? `Description for ${id}.`,
      tags: overrides.tags ?? ['history', 'sleep'],
      categoryId: '27',
    },
    status: {
      privacyStatus: overrides.privacy ?? 'public',
      selfDeclaredMadeForKids: false,
      embeddable: true,
      license: 'youtube',
      publicStatsViewable: true,
    },
  }
}

/**
 * A project of its own on a channel of its own.
 *
 * ONE data root for the file, a NEW project and a NEW channel per test. The
 * audit ledger is keyed by project and channel, so this gives each test a fresh
 * ledger without switching the process-wide data root under tests that may
 * still be finishing — and a YouTube channel can only be assigned to one
 * project, which a shared channel would violate.
 */
async function freshProject(): Promise<{ slug: string, channel: string }> {
  projectNameCounter += 1
  const channel = `${CHANNEL_PREFIX}-${projectNameCounter}`
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channel, title: `Audit Channel ${projectNameCounter}`, granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: `audit-access-${projectNameCounter}`,
      refresh_token: `audit-refresh-${projectNameCounter}`,
      expires_at: Date.now() + 3_600_000,
    },
  })
  const project = await projects.createProject({ name: `Audit project ${projectNameCounter}` })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: channel, expected_previous_channel_id: null,
  })
  return { slug: project.slug, channel }
}

let episodeCounter = 0
async function uploadedVideo(slug: string, channel: string, videoId: string): Promise<string> {
  episodeCounter += 1
  const created = await operations.createYouTubeOperation({
    project_slug: slug,
    episode_code: `EP${String(2000 + episodeCounter)}`,
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

function auditUrl(slug: string, query = ''): string {
  return `/api/projects/${slug}/youtube/videos/snippets${query}`
}

let booted: Promise<void> | undefined
/** One data root for the file, with the application and channel already connected. */
async function boot(): Promise<void> {
  booted ??= (async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    youtube = await import('../lib/youtube-client.js')
    connections = await import('../services/youtube-connection-store.js')
    operations = await import('../services/youtube-operation-store.js')
    projects = await import('../services/project-manager.js')
    auditStore = await import('../services/youtube-video-audit-store.js')
    const { router } = await import('../routes/youtube-upload-center.js')
    app = express()
    app.use(express.json())
    app.use('/api', router)
    await connections.configureYouTubeApplication({ client_id: 'audit-client', client_secret: 'audit-secret' })
  })()
  return booted
}

afterEach(() => {
  youtube?.__resetYouTubeTransportForTests()
})

after(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe('the read-only video audit', () => {
  test('reads what Story knows, reports findings and quota, and records every observation', async () => {
    await boot()
    const { slug, channel } = await freshProject()
    await uploadedVideo(slug, channel, 'vid-audit-a')
    await uploadedVideo(slug, channel, 'vid-audit-b')

    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET', path: listPath(['vid-audit-a', 'vid-audit-b']),
      body: {
        items: [
          videoItem('vid-audit-a'),
          // A video with everything wrong that an audit must catch.
          videoItem('vid-audit-b', { title: 'x'.repeat(101) + '<', description: '', tags: [] }),
        ],
      },
    })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).get(auditUrl(slug))
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.known_ids, 2)
    assert.equal(res.body.read_now, 2)
    assert.equal(res.body.skipped_cached, 0)
    assert.equal(res.body.quota_units, 1, 'two ids are one videos.list call')
    assert.equal(fake.calls.length, 1)

    const byId = Object.fromEntries(res.body.videos.map((video: any) => [video.video_id, video]))
    assert.equal(byId['vid-audit-a'].title, 'Title vid-audit-a')
    assert.equal(byId['vid-audit-a'].description_length, `Description for vid-audit-a.`.length)
    assert.equal(byId['vid-audit-a'].tag_count, 2)
    assert.equal(byId['vid-audit-a'].privacy_status, 'public')
    assert.equal(byId['vid-audit-a'].publish_at, null)
    assert.equal(byId['vid-audit-a'].snippet_sha256.length, 64)
    assert.deepEqual(byId['vid-audit-a'].findings, [])

    assert.ok(byId['vid-audit-b'].findings.includes('empty_description'))
    assert.ok(byId['vid-audit-b'].findings.includes('no_tags'))
    assert.ok(byId['vid-audit-b'].findings.includes('title_over_limit'))
    assert.ok(byId['vid-audit-b'].findings.includes('title_has_angle_brackets'))

    // The ledger is per channel and replace-by-id.
    const stored = await auditStore.readChannelVideoAudit(slug, channel)
    assert.deepEqual(Object.keys(stored).sort(), ['vid-audit-a', 'vid-audit-b'])
    assert.equal(stored['vid-audit-a']!.channel_id, channel)
  })

  test('a second audit of an unchanged channel makes ZERO provider calls', async () => {
    await boot()
    const { slug, channel } = await freshProject()
    await uploadedVideo(slug, channel, 'vid-cache-a')
    await uploadedVideo(slug, channel, 'vid-cache-b')

    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET', path: listPath(['vid-cache-a', 'vid-cache-b']),
      body: { items: [videoItem('vid-cache-a'), videoItem('vid-cache-b')] },
    })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const first = await request(app).get(auditUrl(slug))
    assert.equal(first.status, 200)
    assert.equal(fake.calls.length, 1)

    const second = await request(app).get(auditUrl(slug))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.read_now, 0)
    assert.equal(second.body.skipped_cached, 2)
    assert.equal(second.body.quota_units, 0)
    assert.equal(fake.calls.length, 1, 'the cached audit reached YouTube again')
    // The cached evidence is still returned.
    assert.equal(second.body.videos.length, 2)
  })

  test('force=1 re-reads every known video', async () => {
    await boot()
    const { slug, channel } = await freshProject()
    await uploadedVideo(slug, channel, 'vid-force-a')
    await uploadedVideo(slug, channel, 'vid-force-b')

    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(['vid-force-a', 'vid-force-b']), body: { items: [videoItem('vid-force-a'), videoItem('vid-force-b')] } })
    fake.respond({ method: 'GET', path: listPath(['vid-force-a', 'vid-force-b']), body: { items: [videoItem('vid-force-a'), videoItem('vid-force-b')] } })
    youtube.__setYouTubeTransportForTests(fake.transport())

    await request(app).get(auditUrl(slug))
    assert.equal(fake.calls.length, 1)
    const forced = await request(app).get(auditUrl(slug, '?force=1'))
    assert.equal(forced.status, 200, JSON.stringify(forced.body))
    assert.equal(forced.body.read_now, 2)
    assert.equal(forced.body.skipped_cached, 0)
    assert.equal(fake.calls.length, 2)
  })

  test("a Story Studio metadata write invalidates exactly that video's record", async () => {
    await boot()
    const { slug, channel } = await freshProject()
    const operationId = await uploadedVideo(slug, channel, 'vid-invalidate-a')
    await uploadedVideo(slug, channel, 'vid-invalidate-b')

    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET', path: listPath(['vid-invalidate-a', 'vid-invalidate-b']),
      body: { items: [videoItem('vid-invalidate-a'), videoItem('vid-invalidate-b')] },
    })
    youtube.__setYouTubeTransportForTests(fake.transport())
    const audited = await request(app).get(auditUrl(slug))
    assert.equal(audited.status, 200)
    assert.equal(fake.calls.length, 1)

    // Story Studio now changes vid-invalidate-a's title through the real route.
    fake.respond({ method: 'GET', path: listPath(['vid-invalidate-a']), body: { items: [videoItem('vid-invalidate-a')] } })
    fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: 'vid-invalidate-a' } })
    fake.respond({
      method: 'GET', path: listPath(['vid-invalidate-a']),
      body: { items: [videoItem('vid-invalidate-a', { title: 'Edited on YouTube' })] },
    })
    const updated = await request(app)
      .post(`/api/projects/${slug}/youtube/videos/metadata`)
      .send({ confirm: true, operation_id: operationId, title: 'Edited on YouTube' })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))

    // The next audit re-reads ONLY the video Story wrote to.
    fake.respond({ method: 'GET', path: listPath(['vid-invalidate-a']), body: { items: [videoItem('vid-invalidate-a', { title: 'Edited on YouTube' })] } })
    const before = fake.calls.length
    const afterUpdate = await request(app).get(auditUrl(slug))
    assert.equal(afterUpdate.status, 200, JSON.stringify(afterUpdate.body))
    assert.equal(afterUpdate.body.read_now, 1)
    assert.equal(afterUpdate.body.skipped_cached, 1)
    const reads = fake.calls.slice(before)
    assert.equal(reads.length, 1)
    assert.equal(reads[0]!.path, listPath(['vid-invalidate-a']), 'only the written video is re-read')
    const byId = Object.fromEntries(afterUpdate.body.videos.map((video: any) => [video.video_id, video]))
    assert.equal(byId['vid-invalidate-a'].title, 'Edited on YouTube')
    // The re-read keeps Story's write marker, joined to the receipt the operations list now returns.
    const receiptId = byId['vid-invalidate-a'].story_receipt_id
    assert.ok(receiptId, 'the marker survives the re-read')
    assert.ok(byId['vid-invalidate-a'].story_written_at)
    const operations = await request(app).get(`/api/projects/${slug}/youtube/operations`)
    assert.equal(operations.status, 200)
    const op = operations.body.operations.find((row: any) => row.operation_id === operationId)
    assert.equal(op.metadata_updates.at(-1).receipt_id, receiptId)
    assert.equal(op.metadata_updates.at(-1).video_id, 'vid-invalidate-a')
  })

  test('include_uploads also audits videos with no Story record, and reports the extra listing', async () => {
    await boot()
    const { slug, channel } = await freshProject()
    await uploadedVideo(slug, channel, 'vid-known')

    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET', path: '/youtube/v3/channels?part=contentDetails&mine=true',
      body: { items: [{ id: channel, contentDetails: { relatedPlaylists: { uploads: 'UU-audit' } } }] },
    })
    fake.respond({
      method: 'GET',
      path: '/youtube/v3/playlistItems?part=snippet%2Cstatus&playlistId=UU-audit&maxResults=50',
      body: { items: [{ snippet: { resourceId: { videoId: 'vid-extra' }, title: 'Extra', publishedAt: '2026-01-01T00:00:00Z' } }] },
    })
    // Both ids in one videos.list call.
    fake.respond({ method: 'GET', path: listPath(['vid-known', 'vid-extra']), body: { items: [videoItem('vid-known'), videoItem('vid-extra')] } })
    youtube.__setYouTubeTransportForTests(fake.transport())

    const res = await request(app).get(auditUrl(slug, '?include_uploads=1'))
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.known_ids, 2, 'the uploads listing adds a video Story does not know')
    assert.equal(res.body.uploads_listing.used, true)
    assert.equal(res.body.uploads_listing.videos, 1)
    assert.equal(res.body.uploads_listing.truncated, false)
    assert.equal(res.body.uploads_listing.quota_units, 2, 'channels.list plus one playlistItems page')
    assert.equal(res.body.total_quota_units, 3, 'one videos.list call plus the uploads listing')
    assert.equal(res.body.videos.length, 2)
  })
})

describe('the audit ledger', () => {
  test('uses replace-by-id, and a Story write marks the observation stale', async () => {
    await boot()
    const { slug, channel } = await freshProject()
    const checkedAt = '2026-10-27T10:00:00.000Z'
    const entry = {
      video_id: 'vid-ledger', channel_id: channel, checked_at: checkedAt, title: 'First title',
      description_length: 10, description_empty: false, tag_count: 2, snippet_sha256: 'a'.repeat(64),
      snippet_sha256_algorithm: ALGORITHM,
      privacy_status: 'public', publish_at: null, findings: [],
    } as import('../services/youtube-video-audit-store.js').VideoAuditEntry

    await auditStore.recordVideoAuditEntries({ project_slug: slug, channel_id: channel, entries: [entry] })
    assert.equal((await auditStore.readChannelVideoAudit(slug, channel))['vid-ledger']?.title, 'First title')

    await auditStore.recordVideoAuditEntries({
      project_slug: slug, channel_id: channel,
      entries: [{ ...entry, checked_at: '2026-10-27T11:00:00.000Z', title: 'Second title' }],
    })
    const replaced = await auditStore.readChannelVideoAudit(slug, channel)
    assert.equal(Object.keys(replaced).length, 1, 'one entry per id, not an appended history')
    assert.equal(replaced['vid-ledger']?.title, 'Second title')
    assert.equal(auditStore.videoAuditEntryIsCurrent(replaced['vid-ledger'], ALGORITHM), true)

    // A Story write AFTER the observation makes it stale, so the next audit re-reads it.
    await auditStore.noteStoryMetadataWrite({
      project_slug: slug, channel_id: channel, video_id: 'vid-ledger', at: '2026-10-27T12:00:00.000Z',
      receipt_id: 'receipt_ledger',
    })
    const stale = await auditStore.readChannelVideoAudit(slug, channel)
    assert.equal(auditStore.videoAuditEntryIsCurrent(stale['vid-ledger'], ALGORITHM), false)
    assert.equal(stale['vid-ledger']?.title, 'Second title', 'the observation is kept as history, not deleted')
    // The marker carries the receipt it came from, so a reader can join it to
    // the operation record's evidence of that write.
    assert.equal(stale['vid-ledger']?.story_written_at, '2026-10-27T12:00:00.000Z')
    assert.equal(stale['vid-ledger']?.story_receipt_id, 'receipt_ledger')

    // An observation taken at the same instant or later is current again.
    await auditStore.recordVideoAuditEntries({
      project_slug: slug, channel_id: channel,
      entries: [{ ...entry, checked_at: '2026-10-27T12:00:00.000Z' }],
    })
    const current = await auditStore.readChannelVideoAudit(slug, channel)
    assert.equal(auditStore.videoAuditEntryIsCurrent(current['vid-ledger'], ALGORITHM), true)
    // The re-read replaced the observation but kept Story's write marker and its receipt.
    assert.equal(current['vid-ledger']?.story_written_at, '2026-10-27T12:00:00.000Z')
    assert.equal(current['vid-ledger']?.story_receipt_id, 'receipt_ledger')
  })

  test('an observation hashed by an OLDER rule is re-read, not handed out as current', async () => {
    await boot()
    const { slug, channel } = await freshProject()
    await uploadedVideo(slug, channel, 'vid-old-hash')

    const fake = new FakeYouTube()
    fake.respond({ method: 'GET', path: listPath(['vid-old-hash']), body: { items: [videoItem('vid-old-hash')] } })
    youtube.__setYouTubeTransportForTests(fake.transport())
    const first = await request(app).get(auditUrl(slug))
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.read_now, 1)

    // Rewrite the entry the way a pre-1.4.365 install would have left it: a
    // hash with no algorithm label, over title+description+tags only.
    const stored = (await auditStore.readChannelVideoAudit(slug, channel))['vid-old-hash']!
    const legacy = { ...stored }
    delete (legacy as { snippet_sha256_algorithm?: string }).snippet_sha256_algorithm
    await auditStore.recordVideoAuditEntries({ project_slug: slug, channel_id: channel, entries: [legacy] })

    // Cached-but-mislabeled would 409 the update route forever, so the audit
    // re-reads exactly this video once and labels the new hash.
    fake.respond({ method: 'GET', path: listPath(['vid-old-hash']), body: { items: [videoItem('vid-old-hash')] } })
    const second = await request(app).get(auditUrl(slug))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.read_now, 1, 'the stale-rule entry was re-read')
    const refreshed = (await auditStore.readChannelVideoAudit(slug, channel))['vid-old-hash']!
    assert.equal(refreshed.snippet_sha256_algorithm, ALGORITHM)
  })

  test('an empty ledger is never shared between projects', async () => {
    await boot()
    const first = await freshProject()
    const second = await freshProject()
    const entry = {
      video_id: 'vid-isolated', channel_id: first.channel, checked_at: '2026-10-27T10:00:00.000Z',
      title: 'Only in the first project', description_length: 0, description_empty: true, tag_count: 0,
      snippet_sha256: 'a'.repeat(64), privacy_status: 'public', publish_at: null,
      findings: ['empty_description'],
    } as import('../services/youtube-video-audit-store.js').VideoAuditEntry
    await auditStore.recordVideoAuditEntries({ project_slug: first.slug, channel_id: first.channel, entries: [entry] })

    // The second project had no ledger file at all. A shared empty object would
    // have carried the first project's channel into it.
    const secondLedger = await auditStore.readVideoAuditLedger(second.slug)
    assert.deepEqual(secondLedger.channels, {})
  })

  test('a corrupt ledger document reads as empty rather than failing an audit', async () => {
    await boot()
    const { slug, channel } = await freshProject()
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const projectsModule = await import('../services/project-manager.js')
    const dir = projectsModule.getProjectDir(slug)!
    const ledgerFile = path.join(dir, 'youtube', 'video-audit.json')
    await fs.mkdir(path.dirname(ledgerFile), { recursive: true })
    await fs.writeFile(ledgerFile, '{ not json', 'utf-8')

    // The parser says "unreadable" (null), and the store turns that into an
    // empty ledger — a rebuildable cache must cause re-reads, never a failure.
    assert.equal(auditStore.parseVideoAuditLedgerText('{ not json'), null)
    assert.equal(auditStore.parseVideoAuditLedgerText('{"schema_version":2,"channels":{}}'), null)
    const ledger = await auditStore.readVideoAuditLedger(slug)
    assert.equal(ledger.channels[channel], undefined)

    // A VALID empty ledger is not "unreadable" — different answers.
    assert.deepEqual(auditStore.parseVideoAuditLedgerText('{"schema_version":1,"channels":{}}'), { schema_version: 1, channels: {} })
  })
})
