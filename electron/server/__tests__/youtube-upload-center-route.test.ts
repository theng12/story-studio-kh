import sharp from 'sharp'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import type { CommentCacheState } from '../services/youtube-project-publishing-store.js'
import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { tinyVideoWithSoundBytes as tinyVideoBytes } from './fixtures/tiny-video.js'
import { waitFor, waitForValue } from './_timing.js'
import { runFinalCheck, storeFinalCheck, finalCheckProgress, __setFinalCheckRunnerForTests } from '../lib/final-video-check.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const boot = await useTempDataDir()
const {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
} = await import('../lib/youtube-client.js')
const connections = await import('../services/youtube-connection-store.js')
const operations = await import('../services/youtube-operation-store.js')
const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const im = await import('../services/idea-manager.js')
const jobQueue = await import('../services/job-queue.js')
const appSettings = await import('../services/app-settings.js')
const sidecars = await import('../services/upload-sidecar.js')
const publishing = await import('../services/youtube-project-publishing-store.js')
const { generateYoutubeUpload } = await import('../generators/youtube-upload.js')
const uploadStore = await import('../services/upload-store.js')
const uploadPlans = await import('../services/upload-plans.js')
const { router } = await import('../routes/youtube-upload-center.js')
const { router: videoRouter } = await import('../routes/video.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)
const videoApp = express()
videoApp.use('/api', videoRouter)

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetYouTubeTransportForTests()
  // A parked final-check runner would keep its file's row saying "checking…" for the next test.
  __setFinalCheckRunnerForTests(null)
  // The Upload tests enqueue a real job, and the queue persists it in the
  // background. Tearing the data root down first made that late write land
  // outside the temp dir and print an isolation violation - noise that would
  // hide a genuine failure in the gate. Settle the writes, THEN remove the root.
  await jobQueue._waitForJobPersistenceForTesting()
  await cleanup?.()
  cleanup = undefined
})

const CHANNEL = 'UC-center'
const CLIENT_SECRET = 'center-client-secret-value'
const ACCESS = 'center-access-token-value'
const REFRESH = 'center-refresh-token-value'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==', 'base64')

async function removeQueuedTestJob(slug: string, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = jobQueue.getJob(jobId)
    if (!current || ['completed', 'failed', 'cancelled'].includes(current.status)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  jobQueue.removeTerminalJob(slug, jobId)
}

async function project(assign: boolean): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const created = await pm.createProject({ name: 'Center Project' })

  const paths = await utils.resolveEpisodePaths(created.slug, 'EP0001', '')
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'Center Title', description: 'Center description.', tags: ['x'],
  }))

  if (assign) {
    await connections.configureYouTubeApplication({ client_id: 'center-client', client_secret: CLIENT_SECRET })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Center Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'grant-access', refresh_token: 'grant-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await connections.assignProjectYouTubeChannel({
      project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
    })
  }
  return created.slug
}

test('an unassigned project gets a usable shape, not an error', async () => {
  const slug = await project(false)
  const res = await request(app).get(`/api/projects/${slug}/youtube/overview`)

  assert.equal(res.status, 200)
  assert.equal(res.body.assigned_channel, null)
  assert.equal(res.body.quota, null, 'no application means no quota to report')
  assert.equal(res.body.quota_unavailable_reason, 'no_oauth_application')
  // The page must be able to say WHY it is empty, not just that it is.
  assert.equal(typeof res.body.unavailable_reason, 'string')
  assert.deepEqual(res.body.attention, {
    processing: 0, failed: 0, rejected: 0, status_unavailable: 0, drift: 0,
  })
})

test('overview reports the assigned channel, its health, and the four quota buckets honestly', async () => {
  const slug = await project(true)
  const res = await request(app).get(`/api/projects/${slug}/youtube/overview`)

  assert.equal(res.status, 200)
  assert.equal(res.body.assigned_channel.channel_id, CHANNEL)
  assert.equal(res.body.assigned_channel.status, 'connected')
  assert.equal(res.body.unavailable_reason, null)

  assert.deepEqual(
    Object.keys(res.body.quota.buckets).sort(),
    ['analytics', 'other_endpoints', 'search', 'video_uploads'],
  )
  assert.equal(res.body.quota.buckets.video_uploads.unit, 'calls')
  assert.equal(res.body.quota.buckets.other_endpoints.unit, 'units')
  // The Data API buckets carry Google's documented limits; the Analytics one
  // carries a placeholder, and says so rather than presenting a guessed
  // `remaining` as a known figure.
  assert.equal(res.body.quota.buckets.video_uploads.limit_verified, true)
  assert.equal(res.body.quota.buckets.analytics.limit_verified, false)
  // The uncertainty is the point: calls from other installations are unknown.
  assert.equal(res.body.quota.external_usage_known, false)
  assert.equal(typeof res.body.quota.external_usage_note, 'string')
  assert.equal(typeof res.body.quota.resets_at, 'string')
})

test('attention counts come from real operation records', async () => {
  const slug = await project(true)
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'video-1', accepted_at: new Date().toISOString(),
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
  })
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: accepted.revision,
    mutate: (record) => {
      record.lifecycle = 'rejected'
      record.processing = { checked_at: new Date().toISOString(), provider_status: 'rejected', rejection_reason: 'copyright' }
    },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(res.body.attention.rejected, 1)
  assert.equal(res.body.attention.processing, 0)

  const list = await request(app).get(`/api/projects/${slug}/youtube/operations`)
  assert.equal(list.status, 200)
  assert.equal(list.body.operations.length, 1)
  assert.equal(list.body.operations[0].lifecycle, 'rejected')
  assert.equal(list.body.operations[0].processing.rejection_reason, 'copyright')
})

test('a quota ledger that cannot be read is NOT reported as an unconfigured project', async () => {
  // The ledger fails loudly on corruption on purpose. Catching that into the
  // same `null` used for "no application yet" would make a corrupt ledger look
  // exactly like a fresh install.
  const slug = await project(true)
  const registry = await connections.readYouTubeConnectionRegistry()
  const quotaDir = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'youtube', 'quota', registry.application!.application_id,
  )
  await fs.mkdir(quotaDir, { recursive: true })
  await fs.writeFile(path.join(quotaDir, 'meta.json'), '{ this is not json')

  const res = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(res.status, 200)
  assert.equal(res.body.quota, null)
  assert.equal(res.body.quota_unavailable_reason, 'ledger_unreadable', 'a broken ledger says so')
})

test('one troubled episode counts as one thing to look at, not two', async () => {
  const slug = await project(true)
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'video-both', accepted_at: new Date().toISOString(),
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
  })
  // Both still processing AND drifted — two actions, ONE episode.
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: accepted.revision,
    mutate: (record) => {
      record.lifecycle = 'processing'
      record.drift = { title: { state: 'conflict', decided_at: new Date().toISOString() } }
    },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(res.body.attention.processing, 1)
  assert.equal(res.body.attention.drift, 1)
  assert.equal(res.body.episodes_needing_attention, 1, 'one episode, however many things are wrong with it')
})

test('the operations route sends only what the screen renders', async () => {
  const slug = await project(true)
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'video-trim', accepted_at: new Date().toISOString(),
    final_payload: { snippet_json: '{"title":"x"}', status_json: '{}', source_sha256: 'a'.repeat(64) },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/operations`)
  const row = res.body.operations[0]
  assert.equal(row.video_id, 'video-trim')
  // The constructed request payload and the resumable session hash are not
  // credentials, but the browser has no use for either.
  assert.equal('final_payload' in row, false)
  assert.equal('resumable' in row, false)
  assert.equal('source_revision' in row, false)
  assert.equal('actions' in row, false)
})

test('the exact preview is deterministic and is what the upload would send', async () => {
  const slug = await project(true)
  const body = { episode_code: 'EP0001', privacy_status: 'private', mark_as_ai_generated: true }

  const first = await request(app).post(`/api/projects/${slug}/youtube/preview`).send(body)
  const second = await request(app).post(`/api/projects/${slug}/youtube/preview`).send(body)

  assert.equal(first.status, 200)
  assert.equal(first.body.package_revision, second.body.package_revision)
  assert.match(first.body.package_revision, /^[0-9a-f]{64}$/)
  assert.equal(first.body.snippet.title, 'Center Title')
  assert.equal(first.body.status.containsSyntheticMedia, true)
  assert.equal(Array.isArray(first.body.modifications), true)
  assert.equal(Array.isArray(first.body.warnings), true)
})

test('preview exposes the resolver-selected thumbnail and upload pins that filename into the job', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, `${episodeCode}_Thumb01_v1.png`), PNG)
  await fs.writeFile(path.join(paths.thumb_dir, `${episodeCode}_Thumb01_v2.png`), PNG)

  const initial = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: episodeCode, privacy_status: 'private' })
  assert.equal(initial.status, 200)
  assert.equal(initial.body.thumbnail.state, 'selected')
  assert.equal(initial.body.thumbnail.filename, `${episodeCode}_Thumb01_v2.png`)
  assert.equal(initial.body.thumbnail.options.length, 2)
  assert.match(initial.body.thumbnail.url, /video-editor\/preview-image\?path=/)

  const image = await request(videoApp).get(initial.body.thumbnail.url.replace(/^\/api/, '/api'))
  assert.equal(image.status, 200)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.deepEqual(image.body, PNG)

  const chosen = `${episodeCode}_Thumb01_v1.png`
  const reviewed = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: episodeCode, privacy_status: 'private', thumbnail_filename: chosen })
  assert.equal(reviewed.status, 200)
  assert.equal(reviewed.body.thumbnail.filename, chosen)

  const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send({
    episode_code: episodeCode,
    confirm: true,
    expected_channel_id: CHANNEL,
    expected_package_revision: reviewed.body.package_revision,
    expected_source_revision: reviewed.body.source?.revision,
    thumbnail_filename: chosen,
  })
  assert.equal(queued.status, 200)
  assert.equal(jobQueue.getJob(queued.body.job_id)?.params?.thumbnail_filename, chosen)
  const uploadOverrides = await import('../services/upload-overrides.js')
  await uploadOverrides.writeSelectedThumbnail(slug, episodeCode, title, 'youtube', `${episodeCode}_Thumb01_v2.png`)
  assert.equal(jobQueue.getJob(queued.body.job_id)?.params?.thumbnail_filename, chosen,
    'changing the saved default after queueing does not change this upload')
  await removeQueuedTestJob(slug, queued.body.job_id)
})

test('preview says none when the resolver finds no thumbnail', async () => {
  const slug = await project(true)
  const preview = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: 'EP0001', privacy_status: 'private' })
  assert.equal(preview.status, 200)
  assert.deepEqual(preview.body.thumbnail, { state: 'none', options: [] })
})

test('an explicitly reviewed empty thumbnail choice stays empty if a file appears before queueing', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const reviewed = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: episodeCode, privacy_status: 'private' })
  assert.equal(reviewed.body.thumbnail.state, 'none')

  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, `${episodeCode}_Thumb01_v1.png`), PNG)

  const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send({
    episode_code: episodeCode,
    confirm: true,
    expected_channel_id: CHANNEL,
    expected_package_revision: reviewed.body.package_revision,
    expected_source_revision: reviewed.body.source?.revision,
    thumbnail_filename: null,
  })
  assert.equal(queued.status, 200)
  assert.equal(jobQueue.getJob(queued.body.job_id)?.params?.thumbnail_filename, null)
  await removeQueuedTestJob(slug, queued.body.job_id)
})

test('upload rejects a reviewed thumbnail that disappeared instead of silently choosing another', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  const chosen = `${episodeCode}_Thumb01_v1.png`
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, chosen), PNG)
  const reviewed = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: episodeCode, privacy_status: 'private', thumbnail_filename: chosen })
  await fs.unlink(path.join(paths.thumb_dir, chosen))

  const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send({
    episode_code: episodeCode,
    confirm: true,
    expected_channel_id: CHANNEL,
    expected_package_revision: reviewed.body.package_revision,
    expected_source_revision: reviewed.body.source?.revision,
    thumbnail_filename: chosen,
  })
  assert.equal(queued.status >= 400, true)
  assert.match(queued.body.detail, /no longer available/i)
  assert.equal((await jobQueue.getJobs(slug)).some(job => job.episode_id === episodeCode && job.type === 'youtube_upload'), false)
})

test('a scheduled preview shows the privacy the request will really carry', async () => {
  const slug = await project(true)
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const res = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: 'EP0001', privacy_status: 'public', publish_at: future, mark_as_ai_generated: false })

  assert.equal(res.body.status.privacyStatus, 'private')
  assert.equal(res.body.status.publishAt, future)
  assert.equal(res.body.modifications.some((m: any) => m.field === 'privacy'), true)
})

test('no read route talks to YouTube; only the refresh route does', async () => {
  const slug = await project(true)
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  await request(app).get(`/api/projects/${slug}/youtube/overview`)
  await request(app).get(`/api/projects/${slug}/youtube/operations`)
  await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  await request(app).get(`/api/projects/${slug}/youtube/publishing-state`)
  await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: 'EP0001', privacy_status: 'private', mark_as_ai_generated: false })

  assert.equal(fake.calls.length, 0, 'ordinary page loads are cache-first and cost no quota')
})

test('the refresh route performs one bounded check and persists the outcome', async () => {
  const slug = await project(true)
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'video-refresh', accepted_at: new Date().toISOString(),
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
  })

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=video-refresh',
    body: { items: [{ id: 'video-refresh', status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'Live' } }] },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/operations/${made.operation_id}/refresh`)
  assert.equal(res.status, 200)
  assert.equal(res.body.state.lifecycle, 'ready')
  assert.equal(res.body.persisted, true)
  assert.equal(fake.calls.length, 1, 'exactly one bounded check')

  assert.equal((await operations.readYouTubeOperation(slug, made.operation_id))?.lifecycle, 'ready')
})

test('a current-channel private upload can receive a future schedule without re-uploading bytes', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-private')
  const publishAt = new Date(Date.now() + 86_400_000).toISOString()

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status&id=video-private',
    body: {
      items: [{
        id: 'video-private', etag: 'schedule-etag',
        snippet: { title: 'Private episode', description: '', tags: [], categoryId: '24' },
        status: { privacyStatus: 'private', embeddable: true, license: 'youtube', publicStatsViewable: true },
      }],
    },
  })
  fake.respond({
    method: 'PUT',
    path: '/youtube/v3/videos?part=status',
    body: { id: 'video-private', status: { privacyStatus: 'private', publishAt } },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: publishAt, confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body, {
    operation_id: operationId,
    episode_code: episodeCode,
    video_id: 'video-private',
    privacy_status: 'private',
    scheduled_at: publishAt,
  })
  assert.equal(fake.calls.length, 2, 'one ETag-protected metadata update, never videos.insert')
  assert.equal(fake.calls.some(call => call.path.includes('/upload/youtube/v3/videos')), false)
  const mutation = fake.calls[1]
  assert.equal(mutation?.headers?.['if-match'], 'schedule-etag')
  assert.deepEqual(JSON.parse(mutation!.body!), {
    id: 'video-private',
    status: {
      privacyStatus: 'private', publishAt,
      selfDeclaredMadeForKids: false, embeddable: true, license: 'youtube', publicStatsViewable: true,
    },
  })
  const record = await operations.readYouTubeOperation(slug, operationId)
  assert.equal(record?.remote_snapshot?.privacy_status, 'private')
  assert.equal(record?.remote_snapshot?.scheduled_for, publishAt)
})

test('scheduling rejects a non-private remote video before changing it', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  await acceptedOperation(slug, episodeCode, 'video-public')
  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status&id=video-public',
    body: {
      items: [{
        id: 'video-public', etag: 'public-etag',
        snippet: { title: 'Public episode', description: '', tags: [], categoryId: '24' },
        status: { privacyStatus: 'public' },
      }],
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: new Date(Date.now() + 86_400_000).toISOString(), confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 409)
  assert.match(res.body.detail, /private/i)
  assert.equal(fake.calls.length, 1, 'a public video is never changed by schedule')
})


test('scheduling rejects an impossible future calendar date before reading YouTube', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const res = await request(app).post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`).send({
    publish_at: '2030-02-31T12:00:00Z', confirm: true, expected_channel_id: CHANNEL,
  })
  assert.equal(res.status, 400)
  assert.equal(fake.calls.length, 0)
})

test('scheduling normalizes a valid offset timestamp before provider receipt and response', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  await acceptedOperation(slug, episodeCode, 'video-offset')
  const requested = '2030-05-01T09:30:00+07:00'
  const publishAt = new Date(requested).toISOString()
  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-offset', body: { items: [{
    id: 'video-offset', etag: 'offset-etag', snippet: { title: 'Offset', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private' },
  }] } })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: { id: 'video-offset', status: { privacyStatus: 'private', publishAt } } })
  __setYouTubeTransportForTests(fake.transport())
  const res = await request(app).post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`).send({
    publish_at: requested, confirm: true, expected_channel_id: CHANNEL,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.scheduled_at, publishAt)
  assert.equal(JSON.parse(fake.calls[1]!.body!).status.publishAt, publishAt)
})

test('scheduling accepts the same instant YouTube serialized differently and records the local receipt', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-instant')
  // The owner asked for 03:04:05Z. Story Studio normalizes the request to
  // 03:04:05.000Z, but YouTube echoes the SAME instant back without the
  // fractional seconds. A strict string compare would 502 after a successful
  // write; the local receipt must still be recorded.
  const requested = '2031-01-02T03:04:05Z'
  const normalized = '2031-01-02T03:04:05.000Z'

  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-instant', body: { items: [{
    id: 'video-instant', etag: 'instant-etag',
    snippet: { title: 'Instant', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private' },
  }] } })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: {
    id: 'video-instant', status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05Z' },
  } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: requested, confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.scheduled_at, normalized, 'the response carries the normalized instant')
  assert.equal(res.body.privacy_status, 'private')
  const record = await operations.readYouTubeOperation(slug, operationId)
  assert.equal(record?.remote_snapshot?.privacy_status, 'private')
  assert.equal(record?.remote_snapshot?.scheduled_for, normalized,
    'the local receipt is written even though YouTube serialized the instant without milliseconds')
})

test('scheduling refuses an instant YouTube moved and records no receipt', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-wrong-instant')
  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-wrong-instant', body: { items: [{
    id: 'video-wrong-instant', etag: 'wrong-instant-etag',
    snippet: { title: 'Wrong instant', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private' },
  }] } })
  // One hour later than requested: a genuinely different instant is still refused.
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: {
    id: 'video-wrong-instant', status: { privacyStatus: 'private', publishAt: '2031-01-02T04:04:05Z' },
  } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: '2031-01-02T03:04:05Z', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 502)
  assert.match(res.body.detail, /did not confirm the requested private schedule/i)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined,
    'a wrong instant leaves no local receipt')
})

test('scheduling refuses a malformed publish time from YouTube and records no receipt', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-bad-time')
  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-bad-time', body: { items: [{
    id: 'video-bad-time', etag: 'bad-time-etag',
    snippet: { title: 'Bad time', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private' },
  }] } })
  // An unparseable value is never treated as a match.
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: {
    id: 'video-bad-time', status: { privacyStatus: 'private', publishAt: 'not-a-real-instant' },
  } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: '2031-01-02T03:04:05Z', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 502)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined)
})

test('scheduling refuses a privacy YouTube did not confirm and records no receipt', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-wrong-privacy')
  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-wrong-privacy', body: { items: [{
    id: 'video-wrong-privacy', etag: 'wrong-privacy-etag',
    snippet: { title: 'Wrong privacy', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private' },
  }] } })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: {
    id: 'video-wrong-privacy', status: { privacyStatus: 'public', publishAt: '2031-01-02T03:04:05.000Z' },
  } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: '2031-01-02T03:04:05Z', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 502)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined)
})

test('scheduling refuses a video id YouTube did not confirm and records no receipt', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-id-check')
  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-id-check', body: { items: [{
    id: 'video-id-check', etag: 'id-check-etag',
    snippet: { title: 'Id check', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private' },
  }] } })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: {
    id: 'some-other-video', status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05.000Z' },
  } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: '2031-01-02T03:04:05Z', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 502)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined)
})

test('clearing a schedule is refused when YouTube still reports a pending publish time', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-still-scheduled')
  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-still-scheduled', body: { items: [{
    id: 'video-still-scheduled', etag: 'still-scheduled-etag',
    snippet: { title: 'Still scheduled', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05Z' },
  }] } })
  // "Set visibility" clears the schedule (publishAt: null). YouTube echoing a
  // pending publish time must refuse, so no local receipt claims "no schedule".
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: {
    id: 'video-still-scheduled', status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05Z' },
  } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/visibility`)
    .send({ privacy_status: 'private', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 502)
  assert.match(res.body.detail, /did not confirm/i)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined)
})

test('clearing a schedule succeeds when YouTube confirms no pending publish time', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-cleared')
  const fake = new FakeYouTube()
  fake.respond({ method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-cleared', body: { items: [{
    id: 'video-cleared', etag: 'cleared-etag',
    snippet: { title: 'Cleared', description: '', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private', publishAt: '2031-01-02T03:04:05Z' },
  }] } })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: {
    id: 'video-cleared', status: { privacyStatus: 'private' },
  } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/visibility`)
    .send({ privacy_status: 'private', confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.scheduled_at, null)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot?.scheduled_for, null)
})

test('scheduling refuses a channel changed after review without a provider call', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  await acceptedOperation(slug, episodeCode, 'video-reassigned')
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-schedule-new', title: 'New channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug, channel_id: 'UC-schedule-new', expected_previous_channel_id: CHANNEL,
  })
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({
      publish_at: new Date(Date.now() + 86_400_000).toISOString(),
      confirm: true,
      expected_channel_id: CHANNEL,
    })

  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_CHANNEL_CHANGED')
  assert.equal(fake.calls.length, 0)
})

test('a historical private sidecar is scheduled without creating an operation or uploading bytes', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const before = await sidecars.readSidecar(slug, episodeCode, title, 'youtube')
  await sidecars.writeSidecar(slug, episodeCode, title, { ...before!, privacy_status: 'private' })
  const publishAt = new Date(Date.now() + 86_400_000).toISOString()
  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=legacy-video-77',
    body: { items: [{
      id: 'legacy-video-77', etag: 'legacy-etag',
      snippet: { title, description: 'd', tags: [], categoryId: '24' },
      status: { privacyStatus: 'private' },
    }] },
  })
  fake.respond({
    method: 'PUT', path: '/youtube/v3/videos?part=status',
    body: { id: 'legacy-video-77', status: { privacyStatus: 'private', publishAt } },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: publishAt, confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body, {
    episode_code: episodeCode, video_id: 'legacy-video-77', privacy_status: 'private', scheduled_at: publishAt,
  })
  assert.equal((await operations.listYouTubeOperations(slug)).length, 0, 'scheduling is not a legacy migration')
  assert.equal((await sidecars.readSidecar(slug, episodeCode, title, 'youtube'))?.scheduled_for, publishAt)
  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.deepEqual(row.publication, { state: 'scheduled', visibility: 'private', scheduled_at: publishAt, last_checked_at: row.publication.last_checked_at })
  assert.equal(row.can_schedule_existing, true)
  assert.equal(fake.calls.length, 2)
})

test('a legacy video without a channel receipt is not offered the schedule action', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const sidecar = await sidecars.readSidecar(slug, episodeCode, title, 'youtube')
  await sidecars.writeSidecar(slug, episodeCode, title, { ...sidecar!, channel_id: '' })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.can_schedule_existing, false)
  assert.match(row.schedule_blocked_reason, /different YouTube channel/i)
})

test('a failed schedule update does not create a local schedule receipt', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episodeCode, 'video-put-fails')
  const publishAt = new Date(Date.now() + 86_400_000).toISOString()
  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET', path: '/youtube/v3/videos?part=snippet,status&id=video-put-fails',
    body: { items: [{
      id: 'video-put-fails', etag: 'put-fails-etag',
      snippet: { title: 'Unchanged', description: '', tags: [], categoryId: '24' },
      status: { privacyStatus: 'private' },
    }] },
  })
  fake.rejectNext({
    method: 'PUT', path: '/youtube/v3/videos?part=status', status: 500,
    body: { error: { message: 'temporary provider failure' } },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app)
    .post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/schedule`)
    .send({ publish_at: publishAt, confirm: true, expected_channel_id: CHANNEL })

  assert.equal(res.status, 500)
  assert.equal((await operations.readYouTubeOperation(slug, operationId))?.remote_snapshot, undefined)
  assert.equal(fake.calls.length, 2)
})

/** An accepted operation with a video id, ready to be synced. */
async function acceptedOperation(slug: string, episode: string, videoId: string, title?: string): Promise<string> {
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: episode, channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: videoId, accepted_at: new Date().toISOString(),
    // A real payload: an empty snippet is not publishable, so a push would be
    // refused for a reason that has nothing to do with what is under test.
    final_payload: {
      snippet_json: JSON.stringify({ title: title ?? `Local ${episode}`, description: 'Local description', tags: [], categoryId: '24' }),
      status_json: JSON.stringify({ privacyStatus: 'public' }),
      source_sha256: 'a'.repeat(64),
    },
  })
  return made.operation_id
}

test('sync refreshes the whole project in ONE batched request', async () => {
  const slug = await project(true)
  const first = await acceptedOperation(slug, 'EP0001', 'video-a')
  const second = await acceptedOperation(slug, 'EP0002', 'video-b')

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=video-a,video-b',
    body: {
      items: [
        { id: 'video-a', status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'A' } },
        { id: 'video-b', status: { uploadStatus: 'rejected', rejectionReason: 'copyright' }, snippet: { title: 'B' } },
      ],
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})
  assert.equal(res.status, 200)
  assert.equal(res.body.checked, 2)
  assert.equal(res.body.updated, 2)
  assert.equal(res.body.outcome, 'ok')
  // Fifty episodes cost one quota unit, not fifty.
  assert.equal(fake.calls.length, 1)

  assert.equal((await operations.readYouTubeOperation(slug, first))?.lifecycle, 'ready')
  assert.equal((await operations.readYouTubeOperation(slug, second))?.lifecycle, 'rejected')
})

test('a sync that never reached YouTube is recorded as offline, not as a refusal', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-a')

  // No queued response: the fake refuses locally, standing in for a request
  // that never got an answer.
  __setYouTubeTransportForTests(new FakeYouTube().transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})
  assert.equal(res.status, 200)
  assert.equal(res.body.outcome, 'failed')
  assert.equal(res.body.error_code, 'offline')
  assert.equal(res.body.checked, 0, 'nothing was learned about any video')

  // The attempt is durable even though it failed — that is the whole point.
  const overview = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(overview.body.last_sync_attempt.outcome, 'failed')
  assert.equal(overview.body.last_sync_attempt.error_code, 'offline')
  // And a failed attempt must NOT make stale data look freshly read.
  assert.equal(overview.body.last_remote_sync_at, null)
})

test('a refusal from YouTube is recorded as a provider error, not as offline', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-a')

  const fake = new FakeYouTube()
  fake.rejectNext({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=video-a',
    status: 403,
    body: { error: { message: 'forbidden' } },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})
  assert.equal(res.body.outcome, 'failed')
  assert.equal(res.body.error_code, 'provider_error', 'YouTube answered; the network was fine')
})

test('the last successful read and the last attempt are reported separately', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-a')

  const ok = new FakeYouTube()
  ok.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=video-a',
    body: { items: [{ id: 'video-a', status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'A' } }] },
  })
  __setYouTubeTransportForTests(ok.transport())
  await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})

  const afterSuccess = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  const readAt = afterSuccess.body.last_remote_sync_at
  assert.equal(typeof readAt, 'string')
  assert.equal(afterSuccess.body.last_sync_attempt.outcome, 'ok')

  // Now a failing attempt. The data is still as old as the successful read —
  // the failure must not advance it, and must not erase it either.
  __setYouTubeTransportForTests(new FakeYouTube().transport())
  await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})

  const afterFailure = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(afterFailure.body.last_remote_sync_at, readAt, 'a failed attempt does not refresh the data age')
  assert.equal(afterFailure.body.last_sync_attempt.outcome, 'failed')
})

test('a project state written before the sync field still loads', async () => {
  const slug = await project(true)
  // Reading does not create the file; a sync attempt writes one.
  __setYouTubeTransportForTests(new FakeYouTube().transport())
  await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})

  const statePath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json',
  )
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
  delete raw.remote_sync
  await fs.writeFile(statePath, JSON.stringify(raw))

  const res = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(res.status, 200, 'an older state file is valid, not corrupt')
  assert.equal(res.body.last_sync_attempt, null)
})

test('an unassigned project with old records lists nothing and says why', async () => {
  // `!assignment || match` kept every record when no channel was assigned, so
  // a project that had been unassigned still listed the previous channel's
  // videos as its own — and the non-empty list made the `no_channel_assigned`
  // state the route declares unreachable. Same shape as the Comments sweep.
  // Assigned, published, then unassigned — the only way records outlive an
  // assignment, and exactly the state the opt-out mishandled.
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-from-the-old-channel')
  await connections.unassignProjectYouTubeChannel({ project_slug: slug, expected_channel_id: CHANNEL })

  const res = await request(app).get(`/api/projects/${slug}/youtube/library`)
  assert.deepEqual(res.body.videos, [])
  assert.equal(res.body.empty_reason, 'no_channel_assigned')
})

test('an unassigned project is offered no reconcile candidates it could not act on', async () => {
  // `/reconcile/apply` already refuses without an assignment, so listing
  // candidates promised work the next click would reject.
  //
  // The operation is deliberately NOT accepted: accepting one links the
  // episode, and a linked episode is dropped before the channel filter is ever
  // reached, so an accepted record cannot exercise this guard at all.
  const slug = await project(true)
  await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await connections.unassignProjectYouTubeChannel({ project_slug: slug, expected_channel_id: CHANNEL })

  const res = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.equal(res.status, 200)
  // `local_only` is the field this analysis returns; an earlier draft asserted
  // on `res.body.episodes ?? []`, a key the route never sends, so it passed
  // with the bug still in place.
  assert.deepEqual(res.body.local_only, [])
})

test('the library says WHY it is empty rather than returning a bare empty list', async () => {
  const unassigned = await project(false)
  const noChannel = await request(app).get(`/api/projects/${unassigned}/youtube/library`)
  assert.equal(noChannel.status, 200)
  assert.deepEqual(noChannel.body.videos, [])
  assert.equal(noChannel.body.empty_reason, 'no_channel_assigned')

  const assigned = await project(true)
  const nothingUploaded = await request(app).get(`/api/projects/${assigned}/youtube/library`)
  assert.equal(nothingUploaded.body.empty_reason, 'nothing_uploaded')

  // An operation exists but YouTube never accepted a video: a third situation.
  await operations.createYouTubeOperation({
    project_slug: assigned, episode_code: 'EP0009', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  const notPublished = await request(app).get(`/api/projects/${assigned}/youtube/library`)
  assert.equal(notPublished.body.empty_reason, 'nothing_published_yet')
})

test('the library is complete and provider-free at 0, 1, 49, 50 and 51 videos', async () => {
  // 50 is the videos.list batch size, which is exactly where an accidental
  // "one request per item" or a silently truncated page would hide.
  for (const size of [0, 1, 49, 50, 51]) {
    const slug = await project(true)
    for (let i = 0; i < size; i++) {
      await acceptedOperation(slug, `EP${String(i + 1).padStart(4, '0')}`, `video-${i + 1}`)
    }

    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const res = await request(app).get(`/api/projects/${slug}/youtube/library`)

    assert.equal(res.status, 200, `size ${size}`)
    // Assert the CONTENTS, not the length: a truncated page and a short page
    // have the same count.
    const ids = res.body.videos.map((video: { video_id: string }) => video.video_id).sort()
    const expected = Array.from({ length: size }, (_, i) => `video-${i + 1}`).sort()
    assert.deepEqual(ids, expected, `size ${size}: every video is present`)
    assert.equal(res.body.total, size, `size ${size}`)
    assert.equal(res.body.empty_reason, size === 0 ? 'nothing_uploaded' : null, `size ${size}`)
    assert.equal(fake.calls.length, 0, `size ${size}: reading the library costs no quota`)

    await cleanup?.()
    cleanup = undefined
  }
})

test('each library row carries its three-way comparison', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-compare')

  const res = await request(app).get(`/api/projects/${slug}/youtube/library`)
  const row = res.body.videos[0]
  assert.equal(row.video_id, 'video-compare')
  assert.equal(Array.isArray(row.comparison.fields), true)
  // Never synced, so every field is unknown - not "in sync".
  assert.equal(row.comparison.fields.every((field: { state: string }) => field.state === 'unknown'), true)
  assert.equal(row.comparison.live_fetched_at, null)

  const one = await request(app).get(`/api/projects/${slug}/youtube/library/${operationId}`)
  assert.equal(one.status, 200)
  assert.equal(one.body.video_id, 'video-compare')

  const missing = await request(app).get(`/api/projects/${slug}/youtube/library/youtube_operation_nope`)
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'YOUTUBE_OPERATION_NOT_FOUND')
})

test('a sync keeps the snapshot it replaces, so a later YouTube edit is visible', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-drift')

  const first = new FakeYouTube()
  first.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=video-drift',
    body: { items: [{ id: 'video-drift', status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'Local EP0001' } }] },
  })
  __setYouTubeTransportForTests(first.transport())
  await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})

  const second = new FakeYouTube()
  second.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status,processingDetails&id=video-drift',
    body: { items: [{ id: 'video-drift', status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title: 'Edited In Studio' } }] },
  })
  __setYouTubeTransportForTests(second.transport())
  await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})

  const res = await request(app).get(`/api/projects/${slug}/youtube/library`)
  const title = res.body.videos[0].comparison.fields.find((field: { field: string }) => field.field === 'title')
  assert.equal(title.state, 'youtube_changed', 'the previous snapshot is what makes this detectable')
  assert.equal(title.last_synced, 'Local EP0001')
  assert.equal(title.live, 'Edited In Studio')
})

/** Sync twice so the record has both snapshots and a real disagreement. */
async function withRemoteEdit(slug: string, videoId: string, first: string, second: string): Promise<void> {
  for (const title of [first, second]) {
    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET',
      path: `/youtube/v3/videos?part=snippet,status,processingDetails&id=${videoId}`,
      body: { items: [{ id: videoId, status: { uploadStatus: 'processed', privacyStatus: 'public' }, snippet: { title } }] },
    })
    __setYouTubeTransportForTests(fake.transport())
    await request(app).post(`/api/projects/${slug}/youtube/sync`).send({})
  }
}

test('keeping YouTube is durable, survives the next sync, and stays on its own episode', async () => {
  const slug = await project(true)
  const first = await acceptedOperation(slug, 'EP0001', 'video-one')
  await acceptedOperation(slug, 'EP0002', 'video-two')
  await withRemoteEdit(slug, 'video-one', 'Local EP0001', 'Edited In Studio')

  const decided = await request(app)
    .post(`/api/projects/${slug}/youtube/library/${first}/drift`)
    .send({ field: 'title', decision: 'keep_youtube' })
  assert.equal(decided.status, 200)
  const title = decided.body.comparison.fields.find((f: { field: string }) => f.field === 'title')
  assert.equal(title.state, 'keep_youtube')
  assert.equal(typeof title.decided_at, 'string')

  // A later sync must not silently undo the owner's answer.
  await withRemoteEdit(slug, 'video-one', 'Edited In Studio', 'Edited Again')
  const after = await request(app).get(`/api/projects/${slug}/youtube/library/${first}`)
  assert.equal(
    after.body.comparison.fields.find((f: { field: string }) => f.field === 'title').state,
    'keep_youtube',
  )

  // And it belongs to this episode only.
  const other = (await request(app).get(`/api/projects/${slug}/youtube/library`)).body.videos
    .find((v: { video_id: string }) => v.video_id === 'video-two')
  assert.equal(
    other.comparison.fields.find((f: { field: string }) => f.field === 'title').state,
    'unknown',
    'one episode decision must not leak into another',
  )
})

test('review later records nothing, so undecided never looks decided', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-one')
  await withRemoteEdit(slug, 'video-one', 'Local EP0001', 'Edited In Studio')

  await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'title', decision: 'keep_youtube' })
  const reverted = await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'title', decision: 'review_later' })

  const title = reverted.body.comparison.fields.find((f: { field: string }) => f.field === 'title')
  assert.equal(title.state, 'youtube_changed', 'the conflict is visible again, not stored as an answer')
  // The date the owner looked is kept: "seen and deferred" is a different fact
  // from "never opened". What must NOT survive is the override itself.
  assert.equal(typeof title.decided_at, 'string')
})

test('a decision refuses an unknown field or an unknown verb before writing', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-one')

  const badField = await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'thumbnail_bytes', decision: 'keep_youtube' })
  assert.equal(badField.status, 400)

  const badVerb = await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'title', decision: 'delete_the_video' })
  assert.equal(badVerb.status, 400)

  const stored = await operations.readYouTubeOperation(slug, operationId)
  assert.deepEqual(stored?.drift, {}, 'a refused decision writes nothing')
})

test('a decision on a video from another channel is refused before any write', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-one')

  // Reassign the project to a different channel: the record now belongs to a
  // channel this project no longer publishes to.
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-elsewhere', title: 'Elsewhere', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'a', refresh_token: 'b', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug, channel_id: 'UC-elsewhere', expected_previous_channel_id: CHANNEL,
  })

  const res = await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'title', decision: 'keep_youtube' })
  assert.notEqual(res.status, 200)

  const stored = await operations.readYouTubeOperation(slug, operationId)
  assert.deepEqual(stored?.drift, {}, 'nothing was written for a foreign channel')
})

test('a playlist preview costs nothing and holds at 0, 1, 49, 50 and 51 videos', async () => {
  for (const size of [0, 1, 49, 50, 51]) {
    const slug = await project(true)
    const ids: string[] = []
    for (let i = 0; i < size; i++) {
      ids.push(await acceptedOperation(slug, `EP${String(i + 1).padStart(4, '0')}`, `video-${i + 1}`))
    }

    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const res = await request(app).post(`/api/projects/${slug}/youtube/playlists/preview`)
      .send({ playlist_id: 'PL-target', operation_ids: ids })

    assert.equal(res.status, 200, `size ${size}`)
    // Contents, not count: a truncated preview and a short one have the same length.
    assert.deepEqual(res.body.additions.slice().sort(), ids.slice().sort(), `size ${size}`)
    assert.equal(res.body.estimated_quota_units, size * 50, `size ${size}`)
    assert.equal(fake.calls.length, 0, `size ${size}: previewing must not touch YouTube`)

    await cleanup?.()
    cleanup = undefined
  }
})

test('the preview separates skips, missing video ids and unknown operations', async () => {
  const slug = await project(true)
  const present = await acceptedOperation(slug, 'EP0001', 'video-present')
  const fresh = await acceptedOperation(slug, 'EP0002', 'video-fresh')
  const notUploaded = (await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0003', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })).operation_id

  const existing = await operations.readYouTubeOperation(slug, present)
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: present, expected_revision: existing!.revision,
    mutate(record) {
      record.playlists['PL-target'] = {
        operation_id: present, state: 'present', updated_at: new Date().toISOString(),
      }
    },
  })

  const res = await request(app).post(`/api/projects/${slug}/youtube/playlists/preview`)
    .send({ playlist_id: 'PL-target', operation_ids: [present, fresh, notUploaded, 'youtube_operation_ghost'] })

  assert.deepEqual(res.body.additions, [fresh])
  assert.deepEqual(res.body.already_present, ['EP0001'])
  assert.deepEqual(res.body.no_video_id, ['EP0003'])
  assert.deepEqual(res.body.unknown_operation_ids, ['youtube_operation_ghost'])
  assert.equal(res.body.estimated_quota_units, 50, 'skips cost nothing because they are never sent')
})

test('playlists YouTube maintains itself are refused, not attempted', async () => {
  const slug = await project(true)
  for (const playlistId of ['WL', 'LL', 'UU12345']) {
    const res = await request(app).post(`/api/projects/${slug}/youtube/playlists/preview`)
      .send({ playlist_id: playlistId, operation_ids: [] })
    assert.equal(res.status, 400, playlistId)
    assert.equal(res.body.code, 'YOUTUBE_PLAYLIST_UNSUPPORTED', playlistId)
  }
})

test('a partly failing bulk add keeps what succeeded and receipts each item', async () => {
  const slug = await project(true)
  const first = await acceptedOperation(slug, 'EP0001', 'video-a')
  const second = await acceptedOperation(slug, 'EP0002', 'video-b')

  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/youtube/v3/playlistItems?part=snippet', body: { id: 'item-1' } })
  fake.rejectNext({ method: 'POST', path: '/youtube/v3/playlistItems?part=snippet', status: 403, body: { error: { message: 'no' } } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/playlists/apply`)
    .send({ playlist_id: 'PL-target', operation_ids: [first, second] })

  assert.equal(res.status, 200)
  assert.equal(res.body.added, 1)
  assert.equal(res.body.failed, 1)
  assert.equal(res.body.receipts.length, 2)
  // Every item gets its own receipt id, so a retry can be scoped to one video.
  assert.equal(new Set(res.body.receipts.map((r: { receipt_id: string }) => r.receipt_id)).size, 2)

  // Assert the OUTCOME on the records, not that the calls happened.
  const succeeded = await operations.readYouTubeOperation(slug, first)
  const failed = await operations.readYouTubeOperation(slug, second)
  assert.equal(succeeded?.playlists['PL-target']?.state, 'present')
  assert.equal(failed?.playlists['PL-target']?.state, 'failed')
  // The completed one is kept: a partial failure must not undo it.
  assert.equal(succeeded?.lifecycle, 'accepted', 'a playlist failure never touches the video itself')
})

test('a second apply skips what is already there instead of adding it twice', async () => {
  const slug = await project(true)
  const only = await acceptedOperation(slug, 'EP0001', 'video-a')

  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/youtube/v3/playlistItems?part=snippet', body: { id: 'item-1' } })
  __setYouTubeTransportForTests(fake.transport())
  await request(app).post(`/api/projects/${slug}/youtube/playlists/apply`)
    .send({ playlist_id: 'PL-target', operation_ids: [only] })

  const second = new FakeYouTube()
  __setYouTubeTransportForTests(second.transport())
  const res = await request(app).post(`/api/projects/${slug}/youtube/playlists/apply`)
    .send({ playlist_id: 'PL-target', operation_ids: [only] })

  assert.equal(res.body.skipped, 1)
  assert.equal(res.body.added, 0)
  assert.equal(second.calls.length, 0, 'a duplicate add is never sent')
})

test('a successful add whose bookkeeping fails is NOT reported as failed', async () => {
  // The worst shape available here: YouTube accepted the video, Story Studio
  // could not record it, and the owner is told it failed. YouTube does not
  // dedupe playlist adds, so a retry on that advice adds the video twice.
  const slug = await project(true)
  const only = await acceptedOperation(slug, 'EP0001', 'video-a')

  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/youtube/v3/playlistItems?part=snippet', body: { id: 'item-1' } })
  __setYouTubeTransportForTests(fake.transport())

  // Break only the local write, leaving the provider call untouched.
  const statePath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'operations',
  )
  const realRename = fs.rename
  ;(fs as any).rename = async (from: any, to: any) => {
    if (String(to).startsWith(statePath)) throw Object.assign(new Error('injected'), { code: 'EACCES' })
    return realRename(from, to)
  }
  let res: any
  try {
    res = await request(app).post(`/api/projects/${slug}/youtube/playlists/apply`)
      .send({ playlist_id: 'PL-target', operation_ids: [only] })
  } finally {
    ;(fs as any).rename = realRename
  }

  assert.equal(res.body.added, 1, 'the provider accepted it, so it was added')
  assert.equal(res.body.failed, 0, 'a bookkeeping problem is not a provider failure')
  assert.equal(res.body.receipts[0].state, 'present')
  // And the owner is told the record is not durable, so nobody retries blind.
  assert.equal(res.body.receipts[0].unrecorded, true)
  assert.equal(res.body.unrecorded, 1)
})

test('applying holds at 0, 1, 49, 50 and 51 videos', async () => {
  for (const size of [0, 1, 49, 50, 51]) {
    const slug = await project(true)
    const ids: string[] = []
    for (let i = 0; i < size; i++) {
      ids.push(await acceptedOperation(slug, `EP${String(i + 1).padStart(4, '0')}`, `video-${i + 1}`))
    }

    const fake = new FakeYouTube()
    for (let i = 0; i < size; i++) {
      fake.respond({ method: 'POST', path: '/youtube/v3/playlistItems?part=snippet', body: { id: `item-${i}` } })
    }
    __setYouTubeTransportForTests(fake.transport())

    const res = size === 0
      ? await request(app).post(`/api/projects/${slug}/youtube/playlists/apply`).send({ playlist_id: 'PL-target', operation_ids: [] })
      : await request(app).post(`/api/projects/${slug}/youtube/playlists/apply`).send({ playlist_id: 'PL-target', operation_ids: ids })

    if (size === 0) {
      assert.equal(res.status, 400, 'nothing selected is a refusal, not a silent no-op')
    } else {
      assert.equal(res.status, 200, `size ${size}`)
      assert.equal(res.body.added, size, `size ${size}`)
      // Outcome, not activity: every record actually holds the membership.
      for (const id of ids) {
        const stored = await operations.readYouTubeOperation(slug, id)
        assert.equal(stored?.playlists['PL-target']?.state, 'present', `size ${size}: ${id}`)
      }
    }

    await cleanup?.()
    cleanup = undefined
  }
})

test('Use Story Studio actually pushes to YouTube and clears the difference', async () => {
  // Spec section 11: this control pushes the finalized local values. Recording
  // a decision without performing it would leave the difference on screen and
  // the Overview attention count stuck forever.
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-push')
  await withRemoteEdit(slug, 'video-push', 'Local EP0001', 'Edited In Studio')

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status&id=video-push',
    body: { items: [{
      id: 'video-push', etag: 'etag-live',
      snippet: { title: 'Edited In Studio', description: 'Remote description', tags: ['remote'], categoryId: '22', defaultLanguage: 'km' },
      status: { privacyStatus: 'private', publishAt: '2026-12-01T00:00:00.000Z', selfDeclaredMadeForKids: true, embeddable: false, license: 'creativeCommon', publicStatsViewable: false },
    }] },
  })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: 'video-push' } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'title', decision: 'use_story_studio' })

  assert.equal(res.status, 200)
  assert.equal(res.body.pushed, true)
  assert.equal(fake.calls.length, 2, 'one fresh read and one protected push happened')
  const sent = fake.calls.find(call => call.method === 'PUT')!
  assert.equal(sent.headers?.['if-match'], 'etag-live')
  assert.deepEqual(JSON.parse(sent.body!), {
    id: 'video-push',
    snippet: {
      title: 'Local EP0001',
      description: 'Remote description',
      tags: ['remote'],
      categoryId: '22',
      defaultLanguage: 'km',
    },
  }, 'a title decision preserves every other fresh writable snippet field and sends no status part')

  // And the episode stops being counted as needing attention.
  const overview = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(overview.body.episodes_needing_attention, 0, 'a decision that was carried out clears the flag')
})

test('a currently reassigned operation is refused at drift route entry', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-old-channel')

  // This operation was authorized while CHANNEL was assigned. The provider
  // credential seam must check that immutable channel again after reassignment
  // rather than resolving whatever channel happens to be current later.
  await operations.assertYouTubeOperationAuthorized(slug, operationId)
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-new-channel', title: 'New Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug,
    channel_id: 'UC-new-channel',
    expected_previous_channel_id: CHANNEL,
  })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const res = await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'title', decision: 'use_story_studio' })

  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_ASSIGNMENT_CHANGED')
  assert.equal(fake.calls.length, 0, 'reassignment is refused before any YouTube request')
})

test('drift provider work keeps the channel from the authorized operation record', async () => {
  const source = await fs.readFile(new URL('../routes/youtube-upload-center.ts', import.meta.url), 'utf8')
  const driftBlock = source.slice(
    source.indexOf("router.post('/projects/:slug/youtube/library/:operation_id/drift'"),
    source.indexOf("router.post('/projects/:slug/youtube/playlists/preview'"),
  )
  assert.match(driftBlock, /const current = await assertYouTubeOperationAuthorized\(slug, req\.params\.operation_id\)/)
  assert.match(driftBlock, /registryCredentialFor\(current\.channel_id\)/)
  assert.doesNotMatch(driftBlock, /accountForCurrentChannel/)
})

test('Use Story Studio pushes only the selected status field', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-privacy')
  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status&id=video-privacy',
    body: { items: [{
      id: 'video-privacy', etag: 'etag-privacy',
      snippet: { title: 'Remote title', description: 'Remote description', tags: ['remote'], categoryId: '22' },
      status: { privacyStatus: 'private', publishAt: '2026-12-01T00:00:00.000Z', selfDeclaredMadeForKids: true, containsSyntheticMedia: true, embeddable: false, license: 'creativeCommon', publicStatsViewable: false },
    }] },
  })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=status', body: { id: 'video-privacy' } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
    .send({ field: 'privacy_status', decision: 'use_story_studio' })

  assert.equal(res.status, 200)
  const sent = fake.calls.find(call => call.method === 'PUT')!
  assert.equal(sent.path, '/youtube/v3/videos?part=status')
  assert.equal(sent.headers?.['if-match'], 'etag-privacy')
  assert.deepEqual(JSON.parse(sent.body!), {
    id: 'video-privacy',
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: true,
      containsSyntheticMedia: true,
      embeddable: false,
      license: 'creativeCommon',
      publicStatsViewable: false,
    },
  })
})

test('canonical thumbnail route requires confirmation and queues the exact operation only', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-thumbnail')
  const paths = await utils.resolveEpisodePaths(slug, 'EP0001', '')
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, 'EP0001_Thumb01_v1.png'), Buffer.from('local-test-thumbnail'))

  const refused = await request(app)
    .post(`/api/projects/${slug}/youtube/library/${operationId}/thumbnail`)
    .send({})
  assert.equal(refused.status, 400)
  assert.equal(refused.body.code, 'YOUTUBE_CONFIRMATION_REQUIRED')

  const queued = await request(app)
    .post(`/api/projects/${slug}/youtube/library/${operationId}/thumbnail`)
    .send({ confirm: true, thumbnail_filename: 'EP0001_Thumb01_v1.png' })
  assert.equal(queued.status, 201)
  assert.deepEqual(
    {
      operation_id: queued.body.operation_id,
      episode_code: queued.body.episode_code,
      video_id: queued.body.video_id,
      channel_id: queued.body.channel_id,
    },
    { operation_id: operationId, episode_code: 'EP0001', video_id: 'video-thumbnail', channel_id: CHANNEL },
  )
  const job = jobQueue.getJob(queued.body.job_id)
  assert.equal(job?.type, 'youtube_thumbnail_refresh')
  assert.deepEqual(job?.params, {
    operation_id: operationId,
    thumbnail_filename: 'EP0001_Thumb01_v1.png',
  })
})

test('the library lists only the channel this project publishes to now', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-original-channel')

  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-new-home', title: 'New Home', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'a', refresh_token: 'b', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug, channel_id: 'UC-new-home', expected_previous_channel_id: CHANNEL,
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/library`)
  assert.deepEqual(res.body.videos, [], 'the old channel-s videos are not this project-s any more')
  assert.equal(res.body.empty_reason, 'nothing_published_yet')
})

test('none of the Library routes carry a token, secret, or session URL', async () => {
  const slug = await project(true)
  const operationId = await acceptedOperation(slug, 'EP0001', 'video-secrets')

  const bodies = [
    (await request(app).get(`/api/projects/${slug}/youtube/library`)).body,
    (await request(app).get(`/api/projects/${slug}/youtube/library/${operationId}`)).body,
    (await request(app).post(`/api/projects/${slug}/youtube/playlists/preview`)
      .send({ playlist_id: 'PL-target', operation_ids: [operationId] })).body,
    (await request(app).post(`/api/projects/${slug}/youtube/library/${operationId}/drift`)
      .send({ field: 'title', decision: 'review_later' })).body,
  ]

  for (const body of bodies) {
    const payload = JSON.stringify(body)
    for (const secret of [CLIENT_SECRET, ACCESS, REFRESH, 'grant-access', 'grant-refresh']) {
      assert.equal(payload.includes(secret), false, `${secret} must not reach a Library route`)
    }
    assert.equal(payload.includes('final_payload'), false, 'the raw record is never spread')
    assert.equal(payload.includes('session_url'), false)
  }
})

/**
 * Drop an episode's link, leaving the accepted operation intact.
 *
 * This is the situation Reconcile exists for: the video is on YouTube and the
 * operation still records it, but the project's link is gone (lost, imported
 * from older history, or rolled back). Accepting an upload writes the link, so
 * it has to be removed deliberately to reach that state. The publishing store
 * protects `episode_video_links` from the generic update path on purpose, so
 * the fixture edits the file the way real data loss would.
 */
async function unlinkEpisode(slug: string, episodeCode: string): Promise<void> {
  const statePath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json',
  )
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
  delete raw.episode_video_links[episodeCode]
  await fs.writeFile(statePath, JSON.stringify(raw))
}

/** Seed the cached uploads listing without a provider call. */
async function seedRemote(slug: string, videos: Array<{ video_id: string; title?: string }>): Promise<void> {
  const publishing = await import('../services/youtube-project-publishing-store.js')
  await publishing.recordYouTubeReconcileCache({ project_slug: slug, channel_id: CHANNEL, remote_videos: videos })
}

test('applying a reconcile makes NO provider call at all', async () => {
  // Phase 6 writes are local. This is the test that keeps it that way: if a
  // provider write is ever added here, the remote-success/local-failure rule
  // starts applying and this fails first.
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-exact')
  await unlinkEpisode(slug, 'EP0001')
  await seedRemote(slug, [{ video_id: 'video-exact', title: 'Anything' }])

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const preview = await request(app).post(`/api/projects/${slug}/youtube/reconcile/preview`).send({})
  assert.equal(preview.status, 200)
  const applied = await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`).send({})
  assert.equal(applied.status, 200)

  assert.equal(fake.calls.length, 0, 'reconcile never contacts YouTube')
})

test('only exact evidence links itself; a suggestion is refused by apply', async () => {
  const slug = await project(true)
  // An operation with no accepted video: its title can only ever be a
  // suggestion, never a recorded fact.
  await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0002', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await seedRemote(slug, [{ video_id: 'video-guess', title: 'EP0002 something' }])

  const preview = await request(app).post(`/api/projects/${slug}/youtube/reconcile/preview`).send({})
  assert.equal(preview.body.counts.will_link, 0)
  assert.equal(preview.body.cannot_link[0].reason, 'needs_confirmation')

  const applied = await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`).send({})
  assert.equal(applied.body.counts.linked, 0)
  assert.equal(applied.body.refused[0].reason, 'needs_confirmation')

  const state = await publishing.readYouTubeProjectPublishingState(slug)
  assert.equal(state.episode_video_links.EP0002, undefined, 'nothing was linked')
})

test('a contested match is refused by the bulk path and named as a duplicate', async () => {
  const slug = await project(true)
  // Two episodes whose titles are identical, and one video carrying that
  // title. Two accepted operations cannot share a video id - the store
  // refuses that - so a real contest arises from matching, not from identity.
  await acceptedOperation(slug, 'EP0001', 'video-one', 'The Same Title')
  await acceptedOperation(slug, 'EP0002', 'video-two', 'The Same Title')
  await unlinkEpisode(slug, 'EP0001')
  await unlinkEpisode(slug, 'EP0002')
  await seedRemote(slug, [{ video_id: 'video-third', title: 'The Same Title' }])

  const preview = await request(app).post(`/api/projects/${slug}/youtube/reconcile/preview`).send({})
  assert.equal(preview.body.counts.will_link, 0, 'a duplicate is never bulk-resolved')
  assert.equal(
    preview.body.cannot_link.every((row: { reason: string }) => row.reason === 'possible_duplicate_needs_review'),
    true,
  )

  const applied = await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`).send({})
  assert.equal(applied.body.counts.linked, 0)
})

test('the bulk apply holds at 0, 1, 49, 50 and 51 episodes', async () => {
  for (const size of [0, 1, 49, 50, 51]) {
    const slug = await project(true)
    const videos: Array<{ video_id: string }> = []
    for (let i = 0; i < size; i++) {
      const code = `EP${String(i + 1).padStart(4, '0')}`
      await acceptedOperation(slug, code, `video-${i + 1}`)
      await unlinkEpisode(slug, code)
      videos.push({ video_id: `video-${i + 1}` })
    }
    await seedRemote(slug, videos)

    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const preview = await request(app).post(`/api/projects/${slug}/youtube/reconcile/preview`).send({})
    assert.equal(preview.body.counts.will_link, size, `size ${size}: preview counts every one`)

    const applied = await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`).send({})
    assert.equal(applied.body.counts.linked, size, `size ${size}`)
    assert.equal(fake.calls.length, 0, `size ${size}: still no provider call`)

    // Outcome, not activity: the links actually exist.
    const state = await publishing.readYouTubeProjectPublishingState(slug)
    for (let i = 0; i < size; i++) {
      const code = `EP${String(i + 1).padStart(4, '0')}`
      assert.equal(state.episode_video_links[code]?.video_id, `video-${i + 1}`, `size ${size}: ${code}`)
    }

    await cleanup?.()
    cleanup = undefined
  }
})

test('a reconcile decision can be undone, and its history is kept', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-exact')
  await unlinkEpisode(slug, 'EP0001')
  await seedRemote(slug, [{ video_id: 'video-exact' }])

  const applied = await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`).send({})
  const decisionId = applied.body.linked[0].decision_id
  assert.equal(typeof decisionId, 'string')

  const rolled = await request(app).post(`/api/projects/${slug}/youtube/reconcile/rollback`)
    .send({ decision_id: decisionId })
  assert.equal(rolled.status, 200)
  assert.equal(typeof rolled.body.decision.rolled_back_at, 'string')

  const state = await publishing.readYouTubeProjectPublishingState(slug)
  assert.equal(state.episode_video_links.EP0001, undefined, 'the link it created is gone')
  // The decision itself survives - history is evidence, not a to-do list.
  const history = state.reconciliation_history
  assert.equal(history.length, 1)
  assert.equal(history[0].decision_id, decisionId)
  assert.equal(typeof history[0].rolled_back_at, 'string')

  // Undoing twice is refused rather than silently repeated.
  const again = await request(app).post(`/api/projects/${slug}/youtube/reconcile/rollback`)
    .send({ decision_id: decisionId })
  assert.equal(again.status, 409)
})

test('an ignored video stops being offered, and can be brought back', async () => {
  const slug = await project(true)
  await seedRemote(slug, [{ video_id: 'video-orphan', title: 'Someone else’s upload' }])

  const before = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.deepEqual(before.body.youtube_only, ['video-orphan'])

  await request(app).post(`/api/projects/${slug}/youtube/reconcile/ignore`).send({ video_id: 'video-orphan' })
  const after = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.deepEqual(after.body.youtube_only, [], 'set aside, so no longer offered')
  // Set aside is its own fact, never "no match found".
  assert.deepEqual(after.body.ignored_video_ids, ['video-orphan'])

  await request(app).post(`/api/projects/${slug}/youtube/reconcile/ignore`)
    .send({ video_id: 'video-orphan', ignored: false })
  const restored = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.deepEqual(restored.body.youtube_only, ['video-orphan'])
  assert.deepEqual(restored.body.ignored_video_ids, [])
})

test('the reconcile inventory is cache-first and never lists via search', async () => {
  const slug = await project(true)
  await seedRemote(slug, [{ video_id: 'video-a' }])

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const res = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)

  assert.equal(res.status, 200)
  assert.equal(typeof res.body.remote_listed_at, 'string')
  assert.equal(fake.calls.length, 0, 'opening the screen costs nothing')
})

test('a state file written before the reconcile field still loads', async () => {
  const slug = await project(true)
  await seedRemote(slug, [{ video_id: 'video-a' }])

  const statePath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json',
  )
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
  delete raw.reconcile
  await fs.writeFile(statePath, JSON.stringify(raw))

  const res = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.equal(res.status, 200, 'an older state file is valid, not corrupt')
  assert.equal(res.body.remote_listed_at, null)
})

test('a previous channel-s videos are never auto-linked to the current one', async () => {
  // Reassignment rewrites the registry and nothing else, so an old channel-s
  // accepted operations survive with their video ids intact. Without a channel
  // filter those read as recorded facts and link themselves to the NEW channel.
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-old-channel')
  await unlinkEpisode(slug, 'EP0001')
  await seedRemote(slug, [{ video_id: 'video-old-channel' }])

  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-new-home', title: 'New Home', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'a', refresh_token: 'b', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug, channel_id: 'UC-new-home', expected_previous_channel_id: CHANNEL,
  })

  const inventory = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.deepEqual(inventory.body.youtube_only, [], 'the old channel cache is not rendered as the new channel')
  assert.equal(inventory.body.remote_listed_at, null, 'the new channel requires its own refresh')

  const preview = await request(app).post(`/api/projects/${slug}/youtube/reconcile/preview`).send({})
  assert.equal(preview.body.counts.will_link, 0, 'the old channel-s video is not this project-s to link')

  await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`).send({})
  const state = await publishing.readYouTubeProjectPublishingState(slug)
  assert.equal(state.episode_video_links.EP0001, undefined, 'nothing was linked across channels')
})

test('naming episode codes cannot smuggle a suggestion past the auto-link rule', async () => {
  const slug = await project(true)
  await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0002', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await seedRemote(slug, [{ video_id: 'video-guess', title: 'EP0002 something' }])

  // Asking for it by name must not change what the evidence permits.
  const applied = await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`)
    .send({ episode_codes: ['EP0002'] })
  assert.equal(applied.body.counts.linked, 0)
  assert.equal(applied.body.refused[0].reason, 'needs_confirmation')

  const state = await publishing.readYouTubeProjectPublishingState(slug)
  assert.equal(state.episode_video_links.EP0002, undefined)
})

test('undoing a superseded decision is refused, so a newer link survives', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-first')
  await unlinkEpisode(slug, 'EP0001')
  await seedRemote(slug, [{ video_id: 'video-first' }])

  const applied = await request(app).post(`/api/projects/${slug}/youtube/reconcile/apply`).send({})
  const firstDecision = applied.body.linked[0].decision_id

  // A later decision replaces that link.
  const publishing = await import('../services/youtube-project-publishing-store.js')
  const second = await publishing.recordYouTubeReconcileDecision({
    project_slug: slug, episode_code: 'EP0001',
    previous_video_id: 'video-first', next_video_id: 'video-second',
  })
  await publishing.linkYouTubeEpisodeVideo({
    project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
    video_id: 'video-second', source: 'reconcile', decided_at: second.decided_at,
  })

  // Undoing the FIRST decision would delete a link it never created.
  const rolled = await request(app).post(`/api/projects/${slug}/youtube/reconcile/rollback`)
    .send({ decision_id: firstDecision })
  assert.equal(rolled.status, 409)

  const state = await publishing.readYouTubeProjectPublishingState(slug)
  assert.equal(state.episode_video_links.EP0001?.video_id, 'video-second', 'the newer link is untouched')

  // Undoing the newer one restores the older, on its own channel.
  const undone = await request(app).post(`/api/projects/${slug}/youtube/reconcile/rollback`)
    .send({ decision_id: second.decision_id })
  assert.equal(undone.status, 200)
  const after = await publishing.readYouTubeProjectPublishingState(slug)
  assert.equal(after.episode_video_links.EP0001?.video_id, 'video-first')
  assert.equal(after.episode_video_links.EP0001?.channel_id, CHANNEL, 'never a fabricated channel')
})

test('two episodes linked to one video are reported as a conflict', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-a')
  await acceptedOperation(slug, 'EP0002', 'video-b')

  // Force the collision the way a bad import or a manual edit would.
  const statePath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json',
  )
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
  raw.episode_video_links.EP0002.video_id = 'video-a'
  await fs.writeFile(statePath, JSON.stringify(raw))

  const res = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.deepEqual(res.body.conflicts, [{ video_id: 'video-a', episode_codes: ['EP0001', 'EP0002'] }])
})

test('a push never sends description markers stored before they were stripped', async () => {
  // The fifth tell. PR #24 fixed private-marker leakage on the LEGACY upload
  // path. This is its sibling: `final_payload` is frozen at accept time, so an
  // operation accepted BEFORE that fix has the markers baked in, and pushing
  // those stored bytes would send to YouTube exactly what the legacy path was
  // just fixed to stop sending.
  const slug = await project(true)
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: 'EP0001', channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'video-stale', accepted_at: new Date().toISOString(),
    final_payload: {
      snippet_json: JSON.stringify({
        title: 'Local EP0001',
        description: '<!-- youtube:chapters:start -->\nOne\n<!-- youtube:chapters:end -->\nA <real> line.',
        tags: [], categoryId: '24',
      }),
      status_json: JSON.stringify({ privacyStatus: 'public' }),
      source_sha256: 'a'.repeat(64),
    },
  })
  await withRemoteEdit(slug, 'video-stale', 'Local EP0001', 'Edited In Studio')

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/videos?part=snippet,status&id=video-stale',
    body: { items: [{
      id: 'video-stale', etag: 'etag-stale',
      snippet: {
        title: 'Edited In Studio', description: 'Remote description', tags: ['remote'],
        categoryId: '22', defaultLanguage: 'km',
      },
      status: { privacyStatus: 'public' },
    }] },
  })
  fake.respond({ method: 'PUT', path: '/youtube/v3/videos?part=snippet', body: { id: 'video-stale' } })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/library/${made.operation_id}/drift`)
    .send({ field: 'description', decision: 'use_story_studio' })
  assert.equal(res.status, 200)

  // Assert what actually LEFT, not that a call happened.
  const sent = fake.calls.find(call => call.method === 'PUT')
  assert.equal(typeof sent?.body, 'string')
  assert.doesNotMatch(sent!.body!, /youtube:chapters/, 'private markers must never reach YouTube')
  assert.doesNotMatch(JSON.parse(sent!.body!).snippet.description, /[<>]/)
  assert.match(JSON.parse(sent!.body!).snippet.description, /One/)
})

/** Put a comment in the cache without any provider call. */
type CachedComment = CommentCacheState['comments'][number]

async function seedComments(
  slug: string,
  comments: Array<Partial<CachedComment>>,
  extra: Partial<Omit<CommentCacheState, 'receipts' | 'comments'>> = {},
  opts: { link?: boolean } = {},
): Promise<void> {
  const publishing = await import('../services/youtube-project-publishing-store.js')
  // A cached comment can only exist because this project published that video.
  // Link it on the current channel so the fixture matches reality; tests about
  // a FOREIGN video pass link:false and write their own link.
  if (opts.link !== false) {
    const videos = [...new Set(comments.map(c => String(c.video_id ?? 'v1')))]
    for (const [i, videoId] of videos.entries()) {
      await linkEpisode(slug, `EP${String(i + 1).padStart(4, '0')}`, videoId, CHANNEL)
    }
  }
  await publishing.recordYouTubeCommentCache({
    project_slug: slug,
    inbox: {
      fetched_at: new Date().toISOString(),
      partial: false, unreached_video_ids: [], comments_disabled_video_ids: [],
      // No cast. The cast is what let this fixture omit `replies` and
      // `can_reply` while the store required them - the compiler refuses the
      // next dropped field only if it is allowed to look.
      comments: comments.map(c => ({
        comment_id: 'c1', video_id: 'v1', author: 'A', text: 't',
        published_at: '2026-09-03T10:00:00.000Z', moderation_status: 'published',
        channel_replied: false, reply_count: 0, replies: [], can_reply: true, ...c,
      })),
      ...extra,
    },
  })
}

test('a never-fetched inbox is its own state, not an empty one', async () => {
  const slug = await project(true)
  const res = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(res.status, 200)
  assert.equal(res.body.never_fetched, true)
  assert.deepEqual(res.body.comments, [])
  assert.equal(res.body.fetched_at, null)
})

test('a partial sweep is reported exactly, never summarised', async () => {
  const slug = await project(true)
  // v9 and v10 are OURS - the sweep only ever visits videos linked on the
  // assigned channel, so an unreached id always has a link behind it.
  await linkEpisode(slug, 'EP0009', 'v9', CHANNEL)
  await linkEpisode(slug, 'EP0010', 'v10', CHANNEL)
  await seedComments(slug, [{ comment_id: 'c1' }], {
    partial: true, partial_reason: 'quota_exhausted', unreached_video_ids: ['v9', 'v10'],
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(res.body.partial, true)
  assert.equal(res.body.partial_reason, 'quota_exhausted')
  // The videos never reached are named, not folded into a vague warning.
  assert.deepEqual(res.body.unreached_video_ids, ['v9', 'v10'])
})

test('reading the inbox costs no quota', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(fake.calls.length, 0)
})

test('moderation is receipted, and a remote success with a local failure is unrecorded', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])

  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/youtube/v3/comments/setModerationStatus?id=c1&moderationStatus=rejected',
    body: {},
  })
  __setYouTubeTransportForTests(fake.transport())

  // Break only the local write. YouTube does not undo a moderation that
  // worked, so reporting this as `failed` would invite a repeat.
  const statePath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube')
  const realRename = fs.rename
  ;(fs as any).rename = async (from: any, to: any) => {
    if (String(to).startsWith(statePath)) throw Object.assign(new Error('injected'), { code: 'EACCES' })
    return realRename(from, to)
  }
  let res: any
  try {
    res = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
      .send({ action: 'reject', comment_ids: ['c1'] })
  } finally {
    ;(fs as any).rename = realRename
  }

  assert.equal(res.body.receipts[0].outcome, 'unrecorded')
  assert.equal(res.body.counts.failed, 0, 'the provider accepted it; this is not a provider failure')
  assert.equal(fake.calls.length, 1)
})

test('a successful moderation leaves a durable receipt', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST', path: '/youtube/v3/comments/setModerationStatus?id=c1&moderationStatus=published', body: {},
  })
  __setYouTubeTransportForTests(fake.transport())

  await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
    .send({ action: 'approve', comment_ids: ['c1'] })

  // Assert the record, not the call.
  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(stored.body.receipts.length, 1)
  assert.equal(stored.body.receipts[0].comment_id, 'c1')
  assert.equal(stored.body.receipts[0].action, 'approve')
  assert.equal(stored.body.receipts[0].outcome, 'done')
})

test('bulk moderation holds at 0, 1, 49, 50 and 51 comments', async () => {
  for (const size of [0, 1, 49, 50, 51]) {
    const slug = await project(true)
    const ids = Array.from({ length: size }, (_, i) => `c${i + 1}`)
    await seedComments(slug, ids.map(id => ({ comment_id: id })))

    const fake = new FakeYouTube()
    for (const id of ids) {
      fake.respond({
        method: 'POST', path: `/youtube/v3/comments/setModerationStatus?id=${id}&moderationStatus=rejected`, body: {},
      })
    }
    __setYouTubeTransportForTests(fake.transport())

    const preview = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate/preview`)
      .send({ action: 'reject', comment_ids: ids })
    assert.equal(preview.body.counts.will_change, size, `size ${size}`)

    const res = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
      .send({ action: 'reject', comment_ids: ids })

    if (size === 0) {
      assert.equal(res.status, 400, 'nothing selected is a refusal, not a silent no-op')
    } else {
      // Contents, not counts.
      assert.deepEqual(res.body.receipts.map((r: any) => r.comment_id), ids, `size ${size}`)
      assert.equal(res.body.counts.done, size, `size ${size}`)
    }

    await cleanup?.()
    cleanup = undefined
  }
})

test('bulk moderation can never ban', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST', path: '/youtube/v3/comments/setModerationStatus?id=c1&moderationStatus=rejected', body: {},
  })
  __setYouTubeTransportForTests(fake.transport())

  // Even asked for outright, the bulk route does not carry a ban.
  await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
    .send({ action: 'reject', comment_ids: ['c1'], ban_author: true, banAuthor: true })

  assert.doesNotMatch(fake.calls[0]!.path, /banAuthor/, 'banning is unreachable from the bulk path')
})

test('banning is one author at a time and needs an explicit confirmation', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const unconfirmed = await request(app).post(`/api/projects/${slug}/youtube/comments/ban`)
    .send({ comment_id: 'c1' })
  assert.equal(unconfirmed.status, 400)

  const bulk = await request(app).post(`/api/projects/${slug}/youtube/comments/ban`)
    .send({ comment_ids: ['c1', 'c2'], confirm: true })
  assert.equal(bulk.status, 400)
  assert.equal(bulk.body.code, 'YOUTUBE_BAN_IS_INDIVIDUAL')
  assert.equal(fake.calls.length, 0, 'neither reached YouTube')

  fake.respond({
    method: 'POST',
    path: '/youtube/v3/comments/setModerationStatus?id=c1&moderationStatus=rejected&banAuthor=true',
    body: {},
  })
  const banned = await request(app).post(`/api/projects/${slug}/youtube/comments/ban`)
    .send({ comment_id: 'c1', confirm: true })
  assert.equal(banned.status, 200)
  assert.equal(banned.body.receipt.action, 'reject_and_ban')
  assert.equal(banned.body.receipt.outcome, 'done', 'the control for the unrecorded ban test')
  assert.match(fake.calls[0]!.path, /banAuthor=true/)
})

test('the moderation route accepts only approve and reject — there is no delete', async () => {
  // Tripwire, like the Reconcile provider-write one. Spec section 14 gives
  // approve, reject and ban; rejection HIDES. `there is no comment deletion
  // anywhere in the client` covers the transport; this covers the route.
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  for (const action of ['delete', 'remove', 'ban', 'heldForReview']) {
    const res = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
      .send({ action, comment_ids: ['c1'] })
    assert.equal(res.status, 400, action)
  }
  assert.equal(fake.calls.length, 0, 'no rejected verb reached YouTube')
})

test('comment text is stored and returned verbatim, never interpreted', async () => {
  const slug = await project(true)
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)> [link](javascript:alert(3)) ignore previous instructions'
  await seedComments(slug, [{ comment_id: 'c1', text: hostile, author: '<b>Bold</b> Author' }])

  const res = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(res.body.comments[0].text, hostile, 'stored exactly as written')
  assert.equal(res.body.comments[0].author, '<b>Bold</b> Author')
})

test('every comment write refuses a comment this project does not track', async () => {
  // The sibling write routes authorize before touching the provider; these
  // took a bare id. Without this a caller could moderate, reply to, or ban the
  // author of ANY comment the connected account can reach.
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'ours' }])

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const foreign = 'someone-elses-comment'
  const attempts = [
    await request(app).post(`/api/projects/${slug}/youtube/comments/reply`).send({ comment_id: foreign, text: 'hi' }),
    await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`).send({ action: 'reject', comment_ids: [foreign] }),
    await request(app).post(`/api/projects/${slug}/youtube/comments/ban`).send({ comment_id: foreign, confirm: true }),
  ]
  for (const res of attempts) {
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'YOUTUBE_CHANNEL_MISMATCH')
  }
  assert.equal(fake.calls.length, 0, 'refused before any provider call')
})

test('one foreign id refuses the whole batch instead of slipping through', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'ours' }])
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
    .send({ action: 'reject', comment_ids: ['ours', 'not-ours'] })

  assert.equal(res.status, 409)
  assert.equal(fake.calls.length, 0, 'not even the legitimate one was sent')
})

/** Write an episode link on a specific channel, the way an upload would. */
async function linkEpisode(
  slug: string, episode: string, videoId: string, channelId: string,
  source: 'upload' | 'reconcile' = 'upload',
): Promise<void> {
  const publishing = await import('../services/youtube-project-publishing-store.js')
  await publishing.linkYouTubeEpisodeVideo({
    project_slug: slug, episode_code: episode, channel_id: channelId,
    video_id: videoId, source, decided_at: new Date().toISOString(),
  })
}

test('the inbox read returns the fields the page requires, not a subset', async () => {
  // The store persisted 8 of the 10 fields `InboxComment` declares, silently
  // dropping `replies` and `can_reply`. The page dereferences both, so the
  // first real cached comment crashed its render and left Reply disabled
  // forever. No test saw it because the page fixture invented the two fields
  // the server never sent — the contract was asserted on both sides and
  // matched on neither.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/commentThreads?part=snippet%2Creplies&videoId=v1'
      + '&maxResults=100&order=time&textFormat=plainText',
    body: {
      items: [{
        id: 't1',
        snippet: {
          videoId: 'v1', totalReplyCount: 1, canReply: true, isPublic: true,
          topLevelComment: {
            id: 'c1',
            snippet: {
              authorDisplayName: 'Viewer', textOriginal: 'Great episode',
              publishedAt: '2026-09-03T10:00:00.000Z', moderationStatus: 'published',
            },
          },
        },
        replies: {
          comments: [{
            id: 'r1',
            snippet: {
              authorDisplayName: 'Center Channel', textOriginal: 'Thank you!',
              publishedAt: '2026-09-03T11:00:00.000Z',
              authorChannelId: { value: CHANNEL },
            },
          }],
        },
      }],
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  await request(app).post(`/api/projects/${slug}/youtube/comments/refresh`).send({})

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  const comment = stored.body.comments[0]
  assert.equal(comment.can_reply, true, 'the page disables Reply without this')
  assert.deepEqual(comment.replies, [
    { comment_id: 'r1', author: 'Center Channel', text: 'Thank you!', from_channel: true },
  ], 'the page renders comment.replies.length and throws without this')
})

test('the inbox read hides comments from a channel this project left', async () => {
  // Every action on these returns 409, and Library one screen over shows
  // nothing from that channel. Listing them as this project's workload — and
  // counting them in "Needs reply" — describes work that cannot be done.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'ours', CHANNEL)
  await linkEpisode(slug, 'EP0002', 'theirs', 'UC-a-previous-channel')
  await seedComments(slug, [
    { comment_id: 'mine', video_id: 'ours' },
    { comment_id: 'theirs', video_id: 'theirs' },
  ], {}, { link: false })

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.deepEqual(stored.body.comments.map((c: any) => c.comment_id), ['mine'])

  // The preview must agree with the list it previews.
  const preview = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate/preview`)
    .send({ action: 'reject', comment_ids: ['mine', 'theirs'] })
  assert.deepEqual(preview.body.will_change, ['mine'])
  assert.deepEqual(preview.body.unknown_comment_ids, ['theirs'])
})

test('a moderation that lands moves the comment, not just the receipt', async () => {
  // Otherwise the banner says "Rejected and hidden" while the list still shows
  // it as published, still counts it, and still offers the same action.
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1', moderation_status: 'published' }])

  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST', path: '/youtube/v3/comments/setModerationStatus?id=c1&moderationStatus=rejected', body: {},
  })
  __setYouTubeTransportForTests(fake.transport())

  await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
    .send({ action: 'reject', comment_ids: ['c1'] })

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(stored.body.comments[0].moderation_status, 'rejected')
})

test('a reply that lands clears the comment from needs-reply', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1', channel_replied: false }])

  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/youtube/v3/comments?part=snippet', body: { id: 'r1', snippet: {} } })
  __setYouTubeTransportForTests(fake.transport())

  await request(app).post(`/api/projects/${slug}/youtube/comments/reply`)
    .send({ comment_id: 'c1', text: 'Thanks!' })

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(stored.body.comments[0].channel_replied, true)
})

test('a write the provider refused leaves the comment exactly as it was', async () => {
  // The control for the two tests above: only a write that LANDED may change
  // what the comment claims to be.
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1', moderation_status: 'published' }])

  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST', path: '/youtube/v3/comments/setModerationStatus?id=c1&moderationStatus=rejected',
    status: 403, body: { error: { message: 'forbidden' } },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`)
    .send({ action: 'reject', comment_ids: ['c1'] })
  assert.equal(res.body.receipts[0].outcome, 'failed')

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(stored.body.comments[0].moderation_status, 'published', 'unchanged')
})

test('the preview refuses an action the moderation route would refuse', async () => {
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])
  const res = await request(app).post(`/api/projects/${slug}/youtube/comments/moderate/preview`)
    .send({ action: 'delete', comment_ids: ['c1'] })
  assert.equal(res.status, 400, 'a preview of a plan nobody can perform is worse than none')
})

test('one video linked to two episodes is swept once, not twice', async () => {
  // Phase 6 treats two episodes on one video as a real Conflict state, so a
  // repeated video id is expected here — not a corruption to ignore.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'shared', CHANNEL)
  await linkEpisode(slug, 'EP0002', 'shared', CHANNEL)

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/commentThreads?part=snippet%2Creplies&videoId=shared'
      + '&maxResults=100&order=time&textFormat=plainText',
    body: { items: [] },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/comments/refresh`).send({})
  assert.equal(res.status, 200)
  assert.equal(fake.calls.length, 1, 'one video, one fetch, one quota charge')
})

test('a partially read video survives the round trip to the page', async () => {
  // The middle of the boundary, which is where `replies` and `can_reply` died:
  // asserting the field on the sweep AND on a page fixture tests it twice
  // against nothing. This runs it through store and route, the only place the
  // drop was observable.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'busy', CHANNEL)

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/commentThreads?part=snippet%2Creplies&videoId=busy'
      + '&maxResults=100&order=time&textFormat=plainText',
    body: {
      nextPageToken: 'more-please',
      items: Array.from({ length: 100 }, (_, i) => ({
        id: `t${i}`,
        snippet: {
          videoId: 'busy', totalReplyCount: 0, canReply: true, isPublic: true,
          topLevelComment: {
            id: `c${i}`,
            snippet: {
              authorDisplayName: 'Viewer', textOriginal: 'Hi',
              publishedAt: '2026-09-03T10:00:00.000Z', moderationStatus: 'published',
            },
          },
        },
      })),
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  const refreshed = await request(app).post(`/api/projects/${slug}/youtube/comments/refresh`).send({})
  assert.deepEqual(refreshed.body.partially_read_video_ids, ['busy'])

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.deepEqual(stored.body.partially_read_video_ids, ['busy'], 'survived store and route')
  assert.deepEqual(stored.body.unreached_video_ids, [], 'it was read, not skipped')
  assert.equal(stored.body.partial, true)
})

test('a posted reply is visible in the thread without another fetch', async () => {
  // Otherwise the banner says "Reply posted" and the thread looks unchanged
  // until the operator spends quota re-sweeping the whole channel.
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1', reply_count: 0, replies: [] }])

  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/youtube/v3/comments?part=snippet',
    body: {
      id: 'c1.r1',
      snippet: {
        authorDisplayName: 'Center Channel', textOriginal: 'Thanks!',
        publishedAt: '2026-09-03T12:00:00.000Z',
      },
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  await request(app).post(`/api/projects/${slug}/youtube/comments/reply`)
    .send({ comment_id: 'c1', text: 'Thanks!' })

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  const comment = stored.body.comments[0]
  assert.equal(comment.reply_count, 1)
  assert.deepEqual(comment.replies, [
    { comment_id: 'c1.r1', author: 'Center Channel', text: 'Thanks!', from_channel: true },
  ])
})

test('the inbox read hides a former channel s videos from every list, not just the comments', async () => {
  // An empty list beside "Never opened: <old channel's ids>" and "comments are
  // turned off on 1 video" described a channel this project left as its own
  // unfinished work.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'ours', CHANNEL)
  await seedComments(slug, [{ comment_id: 'mine', video_id: 'ours' }], {
    partial: true,
    unreached_video_ids: ['theirs'],
    partially_read_video_ids: ['theirs'],
    comments_disabled_video_ids: ['theirs'],
  }, { link: false })

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.deepEqual(stored.body.unreached_video_ids, [])
  assert.deepEqual(stored.body.partially_read_video_ids, [])
  assert.deepEqual(stored.body.comments_disabled_video_ids, [])
  assert.deepEqual(stored.body.comments.map((c: any) => c.comment_id), ['mine'])
  assert.equal(stored.body.receipts.length, 0, 'receipts are history, not workload')
})

test('no comment route performs a write without an explicit per-request decision', async () => {
  // Backend half of the plan-mandated tripwire; the page has the other half.
  // Reading the inbox, and previewing, must never reach the provider.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  await seedComments(slug, [{ comment_id: 'c1', video_id: 'v1' }], {}, { link: false })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  await request(app).get(`/api/projects/${slug}/youtube/comments`)
  await request(app).post(`/api/projects/${slug}/youtube/comments/moderate/preview`)
    .send({ action: 'reject', comment_ids: ['c1'] })

  assert.equal(fake.calls.length, 0, 'reads and previews never contact YouTube')

  const source = await fs.readFile(
    path.join(import.meta.dirname, '..', 'routes', 'youtube-upload-center.ts'), 'utf8')
  const comments = source.slice(source.indexOf("/youtube/comments"))
  assert.doesNotMatch(comments, /setInterval|setTimeout|cron|auto_moderate|autoReply/i,
    'the moment an automatic comment path appears, this fails')
})

test('a connected but unassigned project refuses the sweep instead of reading everything', async () => {
  // The channel filter is what scopes the sweep, so with no channel to filter
  // BY, an unassigned project would have swept every linked video on every
  // channel the account can reach. Same refusal the sibling routes give.
  const slug = await project(false)
  await linkEpisode(slug, 'EP0001', 'video-from-a-previous-channel', 'UC-somewhere-else')

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/comments/refresh`).send({})
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_CHANNEL_NOT_ASSIGNED')
  assert.equal(fake.calls.length, 0, 'nothing was read')
})

test('the comment sweep reads only the channel this project publishes to now', async () => {
  // Reassignment leaves the previous channel's links in place, and
  // commentThreads.list needs no ownership — so an unscoped sweep would pull a
  // stranger's comments into this project's cache under this account.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'video-ours', CHANNEL)
  await linkEpisode(slug, 'EP0002', 'video-theirs', 'UC-a-previous-channel')

  const fake = new FakeYouTube()
  fake.respond({
    method: 'GET',
    path: '/youtube/v3/commentThreads?part=snippet%2Creplies&videoId=video-ours'
      + '&maxResults=100&order=time&textFormat=plainText',
    body: { items: [] },
  })
  __setYouTubeTransportForTests(fake.transport())

  const res = await request(app).post(`/api/projects/${slug}/youtube/comments/refresh`).send({})
  assert.equal(res.status, 200)

  // Exactly one request, and it was for OUR video. The other video was never
  // asked about — the fake would have thrown on an unqueued path.
  assert.equal(fake.calls.length, 1)
  assert.match(fake.calls[0]!.path, /videoId=video-ours/)
})

test('a tracked comment whose video belongs to a channel this project left is refused', async () => {
  // Membership in the cache is not identity. A cache written before the sweep
  // was scoped can still hold a former channel's comments.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0002', 'video-theirs', 'UC-a-previous-channel')
  await seedComments(slug, [{ comment_id: 'foreign', video_id: 'video-theirs' }], {}, { link: false })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  for (const res of [
    await request(app).post(`/api/projects/${slug}/youtube/comments/reply`).send({ comment_id: 'foreign', text: 'hi' }),
    await request(app).post(`/api/projects/${slug}/youtube/comments/moderate`).send({ action: 'reject', comment_ids: ['foreign'] }),
    await request(app).post(`/api/projects/${slug}/youtube/comments/ban`).send({ comment_id: 'foreign', confirm: true }),
  ]) {
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'YOUTUBE_CHANNEL_MISMATCH')
  }
  assert.equal(fake.calls.length, 0, 'nothing was posted to a stranger-s video')
})

test('a posted reply leaves a durable receipt and sends the text unchanged', async () => {
  // The positive control for the two `unrecorded` tests below: without it,
  // a route that ALWAYS said `unrecorded` would pass them both.
  const slug = await project(true)
  await seedComments(slug, [{ comment_id: 'c1' }])

  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/youtube/v3/comments?part=snippet', body: { id: 'r1', snippet: {} } })
  __setYouTubeTransportForTests(fake.transport())

  const text = 'Thanks for watching — <b>really</b> appreciate it! 🙏'
  const res = await request(app).post(`/api/projects/${slug}/youtube/comments/reply`)
    .send({ comment_id: 'c1', text })
  assert.equal(res.status, 200)
  assert.equal(res.body.receipt.outcome, 'done')

  const stored = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(stored.body.receipts.length, 1)
  assert.equal(stored.body.receipts[0].action, 'reply')
  assert.equal(stored.body.receipts[0].outcome, 'done')

  // Assert what LEFT: the operator's words reach YouTube verbatim, under the
  // comment they chose — not re-escaped, not truncated, not re-targeted.
  const sent = JSON.parse(fake.calls[0]!.body!)
  assert.equal(sent.snippet.textOriginal, text)
  assert.equal(sent.snippet.parentId, 'c1')
})

test('a reply whose local record fails is unrecorded, not failed', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  await seedComments(slug, [{ comment_id: 'c1', video_id: 'v1' }])

  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: '/youtube/v3/comments?part=snippet', body: { id: 'r1', snippet: {} } })
  __setYouTubeTransportForTests(fake.transport())

  const statePath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube')
  const realRename = fs.rename
  ;(fs as any).rename = async (from: any, to: any) => {
    if (String(to).startsWith(statePath)) throw Object.assign(new Error('injected'), { code: 'EACCES' })
    return realRename(from, to)
  }
  let res: any
  try {
    res = await request(app).post(`/api/projects/${slug}/youtube/comments/reply`)
      .send({ comment_id: 'c1', text: 'Thanks!' })
  } finally {
    ;(fs as any).rename = realRename
  }

  // The reply IS on YouTube. Calling it failed would invite a duplicate post.
  assert.equal(res.body.receipt.outcome, 'unrecorded')
  assert.equal(fake.calls.length, 1)
})

test('a ban whose local record fails is unrecorded, not failed', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  await seedComments(slug, [{ comment_id: 'c1', video_id: 'v1' }])

  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/youtube/v3/comments/setModerationStatus?id=c1&moderationStatus=rejected&banAuthor=true',
    body: {},
  })
  __setYouTubeTransportForTests(fake.transport())

  const statePath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube')
  const realRename = fs.rename
  ;(fs as any).rename = async (from: any, to: any) => {
    if (String(to).startsWith(statePath)) throw Object.assign(new Error('injected'), { code: 'EACCES' })
    return realRename(from, to)
  }
  let res: any
  try {
    res = await request(app).post(`/api/projects/${slug}/youtube/comments/ban`)
      .send({ comment_id: 'c1', confirm: true })
  } finally {
    ;(fs as any).rename = realRename
  }

  // A ban cannot be undone from here. "failed" would be the worst thing to say.
  assert.equal(res.body.receipt.outcome, 'unrecorded')
  assert.equal(fake.calls.length, 1)
})

test('no response carries a token, secret, or session URL', async () => {
  const slug = await project(true)
  const bodies: string[] = []
  for (const res of [
    await request(app).get(`/api/projects/${slug}/youtube/overview`),
    await request(app).get(`/api/projects/${slug}/youtube/operations`),
    await request(app).get(`/api/projects/${slug}/youtube/publishing-state`),
    await request(app).post(`/api/projects/${slug}/youtube/preview`)
      .send({ episode_code: 'EP0001', privacy_status: 'private', mark_as_ai_generated: false }),
  ]) bodies.push(JSON.stringify(res.body))

  for (const payload of bodies) {
    for (const secret of [CLIENT_SECRET, ACCESS, REFRESH, 'grant-access', 'grant-refresh']) {
      assert.equal(payload.includes(secret), false, `${secret} must not reach the Upload Center routes`)
    }
  }
})

const METRIC_STATES = new Set(['value', 'not_fetched', 'not_available', 'no_data'])

/**
 * Walk a response and find every numeric leaf that is NOT inside a MetricValue.
 *
 * This is the round-trip assertion for the analytics store/page pair: not "the
 * service produced states" plus "the page rendered states", which is the shape
 * that let `replies` and `can_reply` die in the middle, but "a number reached
 * the page still carrying its state".
 */
function bareNumberPaths(value: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => bareNumberPaths(entry, `${path}[${i}]`, out))
    return out
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // A MetricValue is allowed to hold a bare `value` — that IS the number, and
    // it arrives with `state` and `fetched_at` beside it. But the exemption is
    // granted only to a genuine MetricValue, not to anything carrying a string
    // called `state`: the loose version let any number hide inside an object
    // that happened to have one.
    const looksLikeMetric = METRIC_STATES.has(String(record.state))
      && (record.state !== 'value' || typeof record.value === 'number')
    if (looksLikeMetric) {
      // The `value` key is sanctioned ONLY on a `value` state. On any other
      // state a number there is exactly the smuggling this walk exists to
      // catch — a `no_data` carrying a figure is a contradiction, not an
      // exemption.
      for (const [key, entry] of Object.entries(record)) {
        if (key === 'value' && record.state === 'value') continue
        bareNumberPaths(entry, `${path}.${key}`, out)
      }
      return out
    }
    for (const [key, entry] of Object.entries(record)) {
      bareNumberPaths(entry, `${path}.${key}`, out)
    }
    return out
  }
  if (typeof value === 'number') out.push(path)
  return out
}

test('every number that leaves the analytics route carries its state', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const analytics = await import('../services/youtube-analytics-cache.js')
  const store = await import('../services/youtube-project-publishing-store.js')

  // The project's REAL account, granted the analytics scope — the service now
  // refuses before the report without it, which is its own state.
  await saveYouTubeChannelGrantForTest({
    channel: {
      channel_id: CHANNEL,
      title: 'Center Channel',
      granted_scopes: ['youtube.upload', 'https://www.googleapis.com/auth/yt-analytics.readonly'],
    },
    tokens: {
      access_token: ACCESS, refresh_token: REFRESH, expires_at: Date.now() + 3_600_000,
      scope: 'youtube.upload https://www.googleapis.com/auth/yt-analytics.readonly',
    },
  })
  const accountId = `registry:${CHANNEL}`
  const applicationId = (await connections.readYouTubeConnectionRegistry()).application!.application_id

  const produced = await analytics.fetchProjectAnalytics({
    project_slug: slug, account_id: accountId, application_id: applicationId, channel_id: CHANNEL,
    video_ids: ['v1'],
    // YouTube's real report shape: parallel columnHeaders and positional rows.
    fetchReport: (async () => ({
      columnHeaders: [
        { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
        { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
        { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
      ],
      rows: [['v1', 0, 12, 30, 40, 1, 2, 3]],
    })) as any,
  })
  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: produced.fetched_at, channel_id: produced.channel_id,
      start_date: produced.start_date, end_date: produced.end_date,
      partial: produced.partial,
      episodes: produced.episodes,
    },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(res.status, 200)
  assert.equal(res.body.episodes.length, 1)

  // The state survived produce -> store -> route. Asserting it on each side
  // separately is the topology that tests twice against nothing.
  assert.equal(res.body.episodes[0].metrics.views.state, 'value')
  assert.equal(res.body.episodes[0].metrics.views.value, 0, 'a real zero survived as a value')
  assert.equal(typeof res.body.episodes[0].metrics.views.fetched_at, 'string')
  assert.equal(res.body.start_date, produced.start_date, 'the window reached the page')
  assert.deepEqual(bareNumberPaths(res.body), [], 'a number escaped without its state')
})

test('never fetched is its own state, and a real zero is not it', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(res.body.never_fetched, true)
  assert.equal(res.body.fetched_at, null)
  assert.equal(res.body.episodes[0].metrics.views.state, 'not_fetched')
  assert.deepEqual(bareNumberPaths(res.body), [])
})

test('an unassigned project is refused analytics and told which empty state it is in', async () => {
  const slug = await project(true)
  await acceptedOperation(slug, 'EP0001', 'video-from-the-old-channel')
  await connections.unassignProjectYouTubeChannel({ project_slug: slug, expected_channel_id: CHANNEL })

  const read = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.episodes, [])
  assert.equal(read.body.empty_reason, 'no_channel_assigned')

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const refresh = await request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send({})
  assert.equal(refresh.status, 409)
  assert.equal(refresh.body.code, 'YOUTUBE_CHANNEL_NOT_ASSIGNED')
  assert.equal(fake.calls.length, 0)
})

test('analytics cached under another channel are not served as this one s', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const store = await import('../services/youtube-project-publishing-store.js')
  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: '2026-09-03T10:00:00.000Z',
      channel_id: 'UC-a-previous-channel',
      start_date: '2026-06-05',
      end_date: '2026-09-03',
      partial: false,
      episodes: [{ video_id: 'v-theirs', metrics: {} }],
    },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  // A miss reads as never-fetched, never as the previous channel's numbers.
  assert.equal(res.body.never_fetched, true)
  assert.equal(res.body.episodes.some((e: any) => e.video_id === 'v-theirs'), false)
})

test('reading analytics costs no quota and makes no provider call', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(fake.calls.length, 0, 'cache-first means opening this is free')
})

test('no monetary metric is ever returned, on a response that actually has numbers', async () => {
  // The earlier version of this ran on a never-fetched response, where every
  // metric is an empty state — it could not have found a monetary figure even
  // if one existed. This one asserts against a REAL measured payload.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const store = await import('../services/youtube-project-publishing-store.js')
  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
      start_date: '2026-06-05', end_date: '2026-09-03',
      partial: false,
      episodes: [{
        video_id: 'v1',
        metrics: { views: { state: 'value', value: 1204, fetched_at: '2026-09-03T10:00:00.000Z' } },
      }],
    },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(res.body.episodes[0].metrics.views.value, 1204, 'the payload really carries numbers')
  // Spec section 15: no monetary figures, and no invented composite score. Also
  // no card-click "CTR", which the legacy page mislabels — removed, not renamed.
  assert.doesNotMatch(JSON.stringify(res.body), /revenue|rpm|cpm|earnings|ctr/i)
})

test('the analytics page reads no field the route does not send', async () => {
  // The tell-7b round trip across the Electron/Nuxt boundary. The page's own
  // tests use a fixture, and a fixture can invent fields — that is exactly how
  // `replies` and `can_reply` were lost. This reads the REAL page source and
  // checks every field it touches against a REAL route response.
  const pageSource = await fs.readFile(
    path.join(import.meta.dirname, '..', '..', '..', 'frontend', 'pages', 'projects',
      '[slug]', 'upload', 'analytics.vue'),
    'utf8')

  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(res.status, 200)

  const referenced = new Set<string>()
  for (const match of pageSource.matchAll(/\bdata(?:\.value)?\.(\w+)/g)) referenced.add(match[1]!)
  // Destructured reads are the same contract: `const { start_date } = data.value`
  // touches the field just as surely as `data.value.start_date`, and the
  // property-access regex alone could not see them.
  for (const match of pageSource.matchAll(/const\s*\{([^}]*)\}\s*=\s*data(?:\.value)?\b/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part.split(':')[0]!.trim()
      if (name) referenced.add(name)
    }
  }
  // `value` is the ref unwrap, not a response field.
  referenced.delete('value')
  assert.ok(referenced.size >= 5, 'the scan found nothing — the regex has drifted from the page')

  for (const field of referenced) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(res.body, field),
      `analytics.vue reads "${field}", which the route never sends`,
    )
  }

  // Same check one level down, DERIVED rather than hand-listed. The hand list
  // omitted `episode_code` — the field that had just become the row identity —
  // which is the failure mode of every list maintained by hand.
  const episode = res.body.episodes[0]
  const episodeFields = new Set(
    [...pageSource.matchAll(/\bepisode\.(\w+)/g)].map(match => match[1]!),
  )
  assert.ok(episodeFields.size >= 3, 'the episode-field scan found almost nothing')
  for (const field of episodeFields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(episode, field),
      `analytics.vue reads episode.${field}, which the route never sends`,
    )
  }
  // And the metric ids the page lists must all exist on a real metric object.
  const labelBlock = pageSource.slice(pageSource.indexOf('const METRIC_LABELS'))
  for (const match of labelBlock.slice(0, labelBlock.indexOf(']')).matchAll(/id: '(\w+)'/g)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(episode.metrics, match[1]!),
      `analytics.vue renders metric "${match[1]}", which the route never sends`,
    )
  }
})

test('a connected account that signs in elsewhere is refused by every provider route', async () => {
  // `getDefaultAccountId` answers "which account is this project's default",
  // not "which account speaks for the assigned channel". Reconnecting a
  // DIFFERENT channel replaces the account while the Phase-2 assignment still
  // names the old one, and every downstream check compares RECORD channel ids
  // against that assignment while the request travels on the new account's
  // token. For analytics it is worst: `ids=channel==MINE` resolves to whoever
  // the token belongs to, and the answer was stamped with the assigned
  // channel's id and cached under it.
  //
  // (`addAccount` enforces one account per project, so the two-accounts-at-once
  // version of this is unreachable. The reachable path is a channel SWAP, which
  // is what this drives.)
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  // While the account still matches the assignment, the guard picks it and
  // gets out of the way — it selects the right account, it does not just block.
  const ok = await request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send({})
  assert.equal(ok.status, 200, 'the assigned channel has a valid account; use it')

  // Now reconnect a different channel. The assignment still says CHANNEL.
  const swapped = await uploadStore.addAccount(slug, 'youtube', {
    label: 'Other', remote_id: 'UC-someone-elses-channel', remote_title: 'Other Channel',
  })
  await uploadStore.writeTokens(slug, 'youtube', swapped.id, {
    access_token: ACCESS, refresh_token: REFRESH, expires_at: Date.now() + 3_600_000,
  })
  await uploadStore.setDefaultAccountId(slug, 'youtube', swapped.id)

  // The REGISTRY still holds a valid grant for the assigned channel, and that
  // is now the credential every route uses — so swapping the legacy account no
  // longer breaks anything. That IS the migration: the legacy list stopped
  // being the source of truth.
  const stillWorks = await request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send({})
  assert.notEqual(stillWorks.status, 409, 'the registry grant carries the request')

  // Now remove the registry grant too: no credential anywhere signs in to the
  // assigned channel.
  await connections.disconnectYouTubeChannel({ channel_id: CHANNEL })
  const config = await pm.getConfig(slug) as any
  await pm.updateConfig(slug, {
    upload_accounts: { youtube: (config.upload_accounts?.youtube ?? []).filter((a: any) => a.remote_id === CHANNEL) },
  } as any)

  const before = fake.calls.length
  for (const call of [
    () => request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send({}),
    () => request(app).post(`/api/projects/${slug}/youtube/comments/refresh`).send({}),
    () => request(app).post(`/api/projects/${slug}/youtube/reconcile/remote-refresh`).send({}),
    () => request(app).post(`/api/projects/${slug}/youtube/sync`).send({}),
  ]) {
    const res = await call()
    assert.equal(res.status, 409, 'refused before any provider call')
  }
  assert.equal(fake.calls.length, before, 'nothing reached YouTube on the wrong credential')
})

/** Seed a measured analytics cache for the given video ids. */
async function seedAnalytics(slug: string, videoIds: string[], channelId = CHANNEL): Promise<void> {
  const store = await import('../services/youtube-project-publishing-store.js')
  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: '2026-09-03T10:00:00.000Z', channel_id: channelId,
      start_date: '2026-06-05', end_date: '2026-09-03',
      partial: false,
      episodes: videoIds.map(videoId => ({
        video_id: videoId,
        metrics: { views: { state: 'value', value: 1204, fetched_at: '2026-09-03T10:00:00.000Z' } },
      })),
    },
  })
}

test('an episode published since the last fetch appears, as not fetched', async () => {
  // The cached branch returned the roster FROZEN at fetch time while the
  // never-fetched branch derived its list from the live links. An episode
  // published afterwards was simply absent — with partial false, unreached
  // empty and never_fetched false, so nothing on screen said anything was
  // missing. Two branches of one response shape must derive each list from the
  // same source of truth.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  await seedAnalytics(slug, ['v1'])

  // Published after the fetch.
  await linkEpisode(slug, 'EP0002', 'v2', CHANNEL)

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.deepEqual(res.body.episodes.map((e: any) => e.video_id).sort(), ['v1', 'v2'])
  const fresh = res.body.episodes.find((e: any) => e.video_id === 'v2')
  assert.equal(fresh.metrics.views.state, 'not_fetched', 'unmeasured, not zero and not absent')
  const measured = res.body.episodes.find((e: any) => e.video_id === 'v1')
  assert.equal(measured.metrics.views.state, 'value')
})

test('a rolled-back link leaves no ghost, and its numbers go with it', async () => {
  // Rollback DELETES a link (store: `delete next.episode_video_links[...]`).
  // Against a roster frozen at fetch time the episode kept appearing with its
  // old figures — a video this project no longer claims, presented as its own.
  const slug = await project(true)
  const store = await import('../services/youtube-project-publishing-store.js')
  await linkEpisode(slug, 'EP0001', 'v-kept', CHANNEL)
  const decision = await store.recordYouTubeReconcileDecision({
    project_slug: slug, episode_code: 'EP0002', previous_video_id: null, next_video_id: 'v-undone',
  })
  await linkEpisode(slug, 'EP0002', 'v-undone', CHANNEL)
  await seedAnalytics(slug, ['v-kept', 'v-undone'])

  // Both are measured and on screen...
  const before = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.deepEqual(before.body.episodes.map((e: any) => e.video_id).sort(), ['v-kept', 'v-undone'])

  await store.rollbackYouTubeReconcileDecision({ project_slug: slug, decision_id: decision.decision_id })

  const after = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.deepEqual(after.body.episodes.map((e: any) => e.video_id), ['v-kept'])
  assert.equal(
    after.body.episodes.some((e: any) => e.video_id === 'v-undone'), false,
    'the link is gone, so its numbers are too',
  )
  // And the one that survived keeps its measurement.
  assert.equal(after.body.episodes[0].metrics.views.state, 'value')
})

test('the not-covered list is derived from the roster, row by row', async () => {
  // The cache once recorded what the last ATTEMPT missed, and the route echoed
  // it — printing "not covered" over rows full of numbers, because after a
  // merge the two mean different things. The field is now gone from the stored
  // shape entirely, so there is no list left to ignore: what this proves is the
  // DERIVATION — a measured row is never listed, an unmeasured one always is.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  await linkEpisode(slug, 'EP0002', 'v2', CHANNEL)
  const store = await import('../services/youtube-project-publishing-store.js')
  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
      start_date: '2026-06-05', end_date: '2026-09-03',
      partial: true, partial_reason: 'report_truncated',
      episodes: [{
        video_id: 'v1',
        metrics: { views: { state: 'value', value: 12, fetched_at: '2026-09-03T10:00:00.000Z' } },
      }],
    },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.deepEqual(
    res.body.unreached_video_ids, ['v2'],
    'only the roster row with no numbers — not the stored attempt list',
  )
  assert.equal(res.body.episodes.find((e: any) => e.video_id === 'v1').metrics.views.value, 12)
})

test('a failed fetch never erases the measurements it could not refresh', async () => {
  // The store wrote `next.analytics = input.analytics` — a blind overwrite —
  // while every failure path returns `episodes: []`. One Fetch that hit quota
  // replaced ninety days of measurements with nothing, under a banner reading
  // "what you see below was fetched before the allowance ran out". There was
  // nothing below. The scope path reaches it without a single provider call.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const store = await import('../services/youtube-project-publishing-store.js')

  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: '2026-09-01T10:00:00.000Z', channel_id: CHANNEL,
      start_date: '2026-06-05', end_date: '2026-09-01',
      partial: false,
      episodes: [{
        video_id: 'v1',
        metrics: { views: { state: 'value', value: 1204, fetched_at: '2026-09-01T10:00:00.000Z' } },
      }],
    },
  })

  // A read that measured nothing at all.
  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
      start_date: '2026-06-05', end_date: '2026-09-03',
      partial: true, partial_reason: 'quota_exhausted', episodes: [],
    },
  })

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  const views = res.body.episodes[0].metrics.views
  assert.equal(views.state, 'value', 'the measurement survived the failed read')
  assert.equal(views.value, 1204)
  assert.equal(views.fetched_at, '2026-09-01T10:00:00.000Z', 'and kept its own age')
  // The ATTEMPT is what just happened, so the banner reports the new failure...
  assert.equal(res.body.partial, true)
  assert.equal(res.body.partial_reason, 'quota_exhausted')
  // ...while the timestamp still describes the MEASUREMENTS, which are older.
  assert.equal(res.body.fetched_at, '2026-09-01T10:00:00.000Z')
})

test('a reconcile swap does not put each episode s numbers under the other s code', async () => {
  // The roster fix corrected which numbers appear and left the CODE stale: the
  // cached row was returned verbatim, `title` included, and the cache stores
  // the code as it was at fetch time. Both rows were then wrong, in a way that
  // reads as correct.
  const slug = await project(true)
  const store = await import('../services/youtube-project-publishing-store.js')
  await linkEpisode(slug, 'EP0001', 'vA', CHANNEL)
  await linkEpisode(slug, 'EP0002', 'vB', CHANNEL)
  await store.recordYouTubeAnalyticsCache({
    project_slug: slug,
    analytics: {
      fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
      start_date: '2026-06-05', end_date: '2026-09-03',
      partial: false,
      episodes: [
        { video_id: 'vA', metrics: { views: { state: 'value', value: 100, fetched_at: '2026-09-03T10:00:00.000Z' } } },
        { video_id: 'vB', metrics: { views: { state: 'value', value: 900, fetched_at: '2026-09-03T10:00:00.000Z' } } },
      ],
    },
  })

  // Swap them: EP0001 now points at vB, EP0002 at vA.
  // The decision AUTHORISES the replace; `linkYouTubeEpisodeVideo` performs it.
  await store.recordYouTubeReconcileDecision({
    project_slug: slug, episode_code: 'EP0001', previous_video_id: 'vA', next_video_id: 'vB',
  })
  // Replacing an immutable link is allowed only for a reconcile decision.
  await linkEpisode(slug, 'EP0001', 'vB', CHANNEL, 'reconcile')

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  const rows = Object.fromEntries(res.body.episodes.map((e: any) => [e.episode_code, e]))
  // Each row is labelled by the LIVE link, and carries that video's numbers.
  assert.equal(rows.EP0001.video_id, 'vB')
  assert.equal(rows.EP0001.metrics.views.value, 900, 'EP0001 now shows vB s numbers, because it IS vB')
  assert.equal(rows.EP0001.episode_code, 'EP0001', 'labelled from the live link, not the cache')
})

test('two episodes on one video are two distinct rows', async () => {
  // A modelled state — Phase 6 calls it "Conflict" — not a duplicate to
  // collapse. The rows must be separable, or the page renders one and the
  // owner cannot see the conflict at all.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'shared', CHANNEL)
  await linkEpisode(slug, 'EP0002', 'shared', CHANNEL)

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(res.body.episodes.length, 2)
  assert.deepEqual(res.body.episodes.map((e: any) => e.episode_code).sort(), ['EP0001', 'EP0002'])
  // Each carries its own identity, so the page can key on something unique.
  assert.equal(new Set(res.body.episodes.map((e: any) => e.episode_code)).size, 2)
})

test('an episode published since the last fetch makes the report partial and names itself', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  await seedAnalytics(slug, ['v1'])
  await linkEpisode(slug, 'EP0002', 'v2', CHANNEL)

  const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  // Saying "this is everything" while a row reads Not fetched is the same
  // contradiction the four states exist to prevent, at the list level.
  assert.equal(res.body.partial, true)
  assert.equal(res.body.partial_reason, 'not_all_measured')
  assert.deepEqual(res.body.unreached_video_ids, ['v2'])
})

test('the refresh answers in the same shape the read does', async () => {
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  const refreshed = await request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send({})
  const read = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(refreshed.status, 200)
  // Same builder, so the page cannot see one shape after a fetch and another
  // on reload.
  assert.deepEqual(
    Object.keys(refreshed.body).filter(k => k !== 'fetched').sort(),
    Object.keys(read.body).sort(),
  )
})

test('a corrupt analytics cache is dropped, not fatal to the whole project', async () => {
  // Every other field in this state is a durable record; analytics is a
  // derived copy that can be rebuilt by asking YouTube again. Failing the
  // whole decode would 500 Library, Reconcile and Comments on a project whose
  // only damaged field is the rebuildable one — and Fetch could not repair it,
  // because Fetch reads the state before it writes.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  await seedAnalytics(slug, ['v1'])

  const statePath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'project-state.json')
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
  raw.analytics.episodes[0].metrics.views.state = 'a_state_that_does_not_exist'
  await fs.writeFile(statePath, JSON.stringify(raw))

  const analytics = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(analytics.status, 200)
  assert.equal(analytics.body.never_fetched, true, 'dropped, and honestly reported as unfetched')
  // ...and the surfaces that share this file still work.
  const library = await request(app).get(`/api/projects/${slug}/youtube/library`)
  assert.equal(library.status, 200)
})

test('a cached failure reason is never replaced by "fetch again to measure them"', async () => {
  // Every failure path stores `episodes: []`, so every roster row is then
  // unmeasured. Letting `not_all_measured` outrank the cached reason told an
  // owner whose channel has not granted analytics access to fetch again —
  // which cannot work, and hides the reconnect instruction that would.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)
  const store = await import('../services/youtube-project-publishing-store.js')

  for (const reason of ['scope_missing', 'not_connected', 'report_truncated', 'quota_exhausted'] as const) {
    await store.recordYouTubeAnalyticsCache({
      project_slug: slug,
      analytics: {
        fetched_at: '2026-09-03T10:00:00.000Z', channel_id: CHANNEL,
        start_date: '2026-06-05', end_date: '2026-09-03',
        partial: true, partial_reason: reason, episodes: [],
      },
    })
    const res = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
    assert.equal(res.body.partial_reason, reason, `${reason} must survive an unmeasured roster`)
  }
})

test('a channel listing that stopped early says so, instead of implying the rest do not exist', async () => {
  // `listRecentUploads` pages to a fixed budget and returns silently. Reconcile
  // then reports every unlisted episode as "In Story Studio only" — which reads
  // as "YouTube does not have this", a false statement about the owner's own
  // back catalogue. Tell 1b: a collection returned at its maximum size is a
  // truncation signal, never a complete answer.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)

  const fake = new FakeYouTube()
  // The uploads playlist id, then four full pages each still offering another.
  fake.respondMatching({
    method: 'GET', match: /channels\?/,
    body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-center' } } }] },
  })
  for (let page = 0; page < 4; page++) {
    fake.respondMatching({
      method: 'GET', match: /playlistItems\?/,
      body: {
        nextPageToken: `page-${page + 1}`,
        items: Array.from({ length: 50 }, (_, i) => ({
          snippet: { resourceId: { videoId: `p${page}v${i}` }, title: `T${page}${i}`, publishedAt: '2026-09-01T00:00:00Z' },
          status: { privacyStatus: 'public' },
        })),
      },
    })
  }
  __setYouTubeTransportForTests(fake.transport())

  const refreshed = await request(app)
    .post(`/api/projects/${slug}/youtube/reconcile/remote-refresh`).send({})
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.listed, 200)
  assert.equal(refreshed.body.truncated, true, 'the budget ran out with more to come')

  const read = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.equal(read.body.remote_listing_truncated, true, 'and the reader is told')
})

test('a listing that reached the end of the channel is not reported as truncated', async () => {
  // The control: without it, "truncated" could be returned always and the test
  // above would pass while warning about every complete listing.
  const slug = await project(true)
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)

  const fake = new FakeYouTube()
  fake.respondMatching({
    method: 'GET', match: /channels\?/,
    body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-center' } } }] },
  })
  fake.respondMatching({
    method: 'GET', match: /playlistItems\?/,
    body: {
      items: [{
        snippet: { resourceId: { videoId: 'v1' }, title: 'One', publishedAt: '2026-09-01T00:00:00Z' },
        status: { privacyStatus: 'public' },
      }],
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  const refreshed = await request(app)
    .post(`/api/projects/${slug}/youtube/reconcile/remote-refresh`).send({})
  assert.equal(refreshed.body.truncated, false)

  const read = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.equal(read.body.remote_listing_truncated, false)
})

/** A project connected ONLY through the redesigned flow: no upload_accounts entry at all. */
async function registryOnlyProject(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const created = await pm.createProject({ name: 'Registry Only' })
  const paths = await utils.resolveEpisodePaths(created.slug, 'EP0001', '')
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'T', description: 'D.', tags: ['x'],
  }))
  await connections.configureYouTubeApplication({ client_id: 'center-client', client_secret: CLIENT_SECRET })
  await saveYouTubeChannelGrantForTest({
    channel: {
      channel_id: CHANNEL, title: 'Center Channel',
      granted_scopes: ['youtube.upload', 'yt-analytics.readonly'],
    },
    // A real connect returns the granted scopes on the token bundle, and the
    // analytics pre-check reads them. Omitting it made this fixture describe a
    // connection the redesigned flow does not produce.
    tokens: {
      access_token: ACCESS, refresh_token: REFRESH, expires_at: Date.now() + 3_600_000,
      // BOTH scopes, matching `granted_scopes` above. The upload scope was
      // missing here while the grant claimed it, so this fixture described a
      // connection the redesigned flow cannot produce - a token that may not
      // upload, on a channel recorded as able to.
      scope: 'https://www.googleapis.com/auth/youtube.upload'
        + ' https://www.googleapis.com/auth/yt-analytics.readonly',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created.slug
}

test('a project connected only through the redesigned flow is served by every provider route', async () => {
  // THE migration gate, and it now asserts OUTCOMES.
  //
  // Its first version checked `status !== 409 && < 500` for ten routes —
  // activity, not outcome — so the analytics refresh could answer 200 with
  // `partial_reason: 'not_connected'` and pass. And it linked no episodes, so
  // the refresh returned early before ever reaching the token lookup: the
  // defect was UNREACHED, not merely unasserted. Both halves of tell 9 in one
  // test.
  const slug = await registryOnlyProject()
  const accounts = await uploadStore.listAccounts(slug, 'youtube')
  assert.deepEqual(accounts, [], 'no legacy account exists — that is the point')
  await linkEpisode(slug, 'EP0001', 'v1', CHANNEL)

  const fake = new FakeYouTube()
  fake.respondMatching({
    method: 'GET',
    match: /^\/v2\/reports\?/,
    body: {
      columnHeaders: [
        { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
        { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
        { name: 'likes' }, { name: 'comments' }, { name: 'shares' },
      ],
      rows: [['v1', 1204, 12, 30, 40, 1, 2, 3]],
    },
  })
  __setYouTubeTransportForTests(fake.transport())

  // The refresh must MEASURE, not merely respond.
  const refreshed = await request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send({})
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.partial_reason, null, 'a connected channel is not "not_connected"')
  const measured = refreshed.body.episodes.find((e: any) => e.video_id === 'v1')
  assert.equal(measured.metrics.views.state, 'value')
  assert.equal(measured.metrics.views.value, 1204)

  // The reads answer with this project's real shape.
  const overview = await request(app).get(`/api/projects/${slug}/youtube/overview`)
  assert.equal(overview.body.assigned_channel.channel_id, CHANNEL)

  const analytics = await request(app).get(`/api/projects/${slug}/youtube/analytics`)
  assert.equal(analytics.body.never_fetched, false)
  assert.equal(analytics.body.episodes[0].metrics.views.value, 1204)

  const comments = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(comments.body.channel_assigned, true, 'the channel IS assigned')

  const library = await request(app).get(`/api/projects/${slug}/youtube/library`)
  assert.notEqual(library.body.empty_reason, 'no_channel_assigned')

  const reconcile = await request(app).get(`/api/projects/${slug}/youtube/reconcile`)
  assert.equal(reconcile.status, 200)

  // And the writes reach the provider on the registry credential rather than
  // refusing for want of a legacy account.
  for (const call of [
    () => request(app).post(`/api/projects/${slug}/youtube/comments/refresh`).send({}),
    () => request(app).post(`/api/projects/${slug}/youtube/sync`).send({}),
    () => request(app).post(`/api/projects/${slug}/youtube/reconcile/preview`).send({}),
    () => request(app).post(`/api/projects/${slug}/youtube/playlists/preview`).send({ playlist_id: 'PL1', operation_ids: [] }),
  ]) {
    const res = await call()
    assert.notEqual(res.status, 409, `refused: ${JSON.stringify(res.body).slice(0, 120)}`)
    assert.ok(res.status < 500, `server error: ${res.status}`)
  }
  __resetYouTubeTransportForTests()
})

test('a project with only the legacy account still works', async () => {
  // The fallback. Records that predate the migration must keep working until
  // the legacy connect flow is deleted.
  const slug = await project(true)
  await connections.disconnectYouTubeChannel({ channel_id: CHANNEL })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const res = await request(app).get(`/api/projects/${slug}/youtube/comments`)
  assert.equal(res.status, 200)
})

test('when both exist and disagree, the registry decides', async () => {
  // The legacy list is a cache of a flow that is going away; the registry is
  // the grant. A disagreement resolves to the registry, and the credential the
  // request travels on says which one answered.
  const slug = await project(true)
  const stranger = await uploadStore.addAccount(slug, 'youtube', {
    label: 'Other', remote_id: 'UC-someone-elses-channel', remote_title: 'Other',
  })
  await uploadStore.writeTokens(slug, 'youtube', stranger.id, {
    access_token: ACCESS, refresh_token: REFRESH, expires_at: Date.now() + 3_600_000,
  })
  await uploadStore.setDefaultAccountId(slug, 'youtube', stranger.id)

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  // The registry still grants CHANNEL, which is the assignment, so this works
  // even though the only legacy account signs in somewhere else.
  const res = await request(app).post(`/api/projects/${slug}/youtube/analytics/refresh`).send({})
  assert.notEqual(res.status, 409)
})

// ---------------------------------------------------------------------------
// Task 3 — Publish → Upload
// ---------------------------------------------------------------------------

/**
 * Accept a real idea, so the episode has the title production assigns it.
 *
 * The title is the point. Path resolution substitutes it into the folder name,
 * and the first version of this fixture wrote the episode's files at the SAME
 * empty-title path the route asked for - so the two agreed with each other and
 * disagreed with reality. Every upload returned "no rendered video" while the
 * gate stayed green (tell 7: a fixture shaped to the code under test rather
 * than to the contract).
 *
 * Everything here goes through PRODUCTION code: `acceptIdea` assigns the
 * episode code, and the files land at whatever the production resolver returns
 * for that code AND title.
 */
async function acceptedEpisode(slug: string): Promise<{ episodeCode: string, title: string }> {
  const title = 'The Lighthouse at Dawn'
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'A keeper counts the nights.', themes: ['solitude'],
    suggested_chapters: 3, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(slug, idea!.id)
  const episodeCode = accepted.idea.episode_code!

  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title, description: 'A keeper counts the nights.', tags: ['x'],
  }))
  return { episodeCode, title }
}

/** An accepted episode that has been rendered, connected through the redesigned flow. */
async function uploadReadyProject(): Promise<{ slug: string, episodeCode: string, title: string }> {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await acceptedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(path.join(paths.video_dir, `${episodeCode}_final_video.mp4`), 'video-bytes')
  return { slug, episodeCode, title }
}

async function confirmedUploadBody(slug: string, episodeCode: string) {
  const preview = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: episodeCode, privacy_status: 'private' })
  assert.equal(preview.status, 200)
  return {
    episode_code: episodeCode,
    confirm: true,
    expected_channel_id: CHANNEL,
    expected_package_revision: preview.body.package_revision,
    expected_source_revision: preview.body.source?.revision,
  }
}

test('publishable projects local render, upload, publication, and plan facts without provider work', async () => {
  // Break caught: collapsing a local schedule into "scheduled on YouTube", or
  // omitting the playable render URL, makes two visibly different episode
  // states indistinguishable in the all-episode listing.
  const slug = await registryOnlyProject()
  const rendered = await acceptedEpisode(slug)
  const missing = await acceptedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, rendered.episodeCode, rendered.title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(path.join(paths.video_dir, `${rendered.episodeCode}_final_video.mp4`), tinyVideoBytes())

  const scheduledAt = '2026-09-21T11:00:00.000Z'
  const accountId = `registry:${CHANNEL}`
  const plan = await uploadPlans.upsertPlan(slug, {
    name: 'Center schedule', platform: 'youtube', account_id: accountId,
    schedule: { weekdays: [1], time_local: '18:00', timezone: 'Asia/Phnom_Penh' },
    defaults: { privacy_status: 'private' },
  })
  await uploadPlans.setActivePlanId(slug, 'youtube', accountId, plan.id)
  await uploadPlans.writeItemSchedule(slug, { [rendered.episodeCode]: scheduledAt })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)

  assert.equal(listed.status, 200)
  const ready = listed.body.episodes.find((row: any) => row.episode_code === rendered.episodeCode)
  assert.deepEqual(ready.local.upload, { state: 'none' })
  assert.equal(ready.local.render.state, 'ready')
  assert.match(ready.local.render.video_url, new RegExp(`^/api/projects/${slug}/video-editor/preview-media\\?path=`))
  assert.deepEqual(ready.publication, { state: 'unpublished' },
    'a local plan is not remote publication evidence')
  assert.deepEqual(ready.plan, { scheduled_at: scheduledAt, timezone: 'Asia/Phnom_Penh' })

  const absent = listed.body.episodes.find((row: any) => row.episode_code === missing.episodeCode)
  assert.deepEqual(absent.local.render, { state: 'missing' })
  assert.deepEqual(absent.local.upload, { state: 'none' })
  assert.deepEqual(absent.publication, { state: 'unpublished' })
  assert.deepEqual(absent.plan, { timezone: 'Asia/Phnom_Penh' })
  assert.equal(fake.calls.length, 0, 'listing local facts costs no YouTube quota')

  const video = await request(videoApp)
    .get(ready.local.render.video_url)
    .set('Range', 'bytes=0-3')
  assert.equal(video.status, 206)
  assert.equal(video.headers['content-type'], 'video/mp4')
  assert.equal(video.headers['accept-ranges'], 'bytes')
  assert.equal(fake.calls.length, 0, 'streaming a local render also costs no YouTube quota')
})

test('a local plan claim remains reserved when a private operation has no remote schedule yet', async () => {
  const slug = await registryOnlyProject()
  const episode = await acceptedEpisode(slug)
  const operationId = await acceptedOperation(slug, episode.episodeCode, 'video-plan-private')
  const accepted = await operations.readYouTubeOperation(slug, operationId)
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: operationId, expected_revision: accepted!.revision,
    mutate(record) {
      record.remote_snapshot = {
        fetched_at: new Date().toISOString(), title: episode.title, description: '', tags: [],
        privacy_status: 'private', scheduled_for: null,
      }
    },
  })
  const plannedAt = new Date(Date.now() + 86_400_000).toISOString()
  await uploadPlans.writeItemSchedule(slug, { [episode.episodeCode]: plannedAt })
  assert.equal((await uploadPlans.readItemSchedule(slug))[episode.episodeCode], plannedAt)
})

test('Upload Center plan assigns only missing rows and refuses a stale preview without provider work', async () => {
  const slug = await registryOnlyProject()
  const first = await acceptedEpisode(slug)
  const second = await acceptedEpisode(slug)
  const later = await acceptedEpisode(slug)
  const accountId = `registry:${CHANNEL}`
  const plan = await uploadPlans.upsertPlan(slug, {
    name: 'Only missing', platform: 'youtube', account_id: accountId,
    schedule: {
      weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '12:00', timezone: 'UTC',
      start_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    },
    defaults: { privacy_status: 'private' },
  })
  await uploadPlans.setActivePlanId(slug, 'youtube', accountId, plan.id)
  const firstClaim = new Date(Date.now() + 86_400_000).toISOString()
  await uploadPlans.writeItemSchedule(slug, { [first.episodeCode]: firstClaim })

  const wrongChannel = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send({
    plan_id: plan.id, expected_channel_id: 'UC-stale', episode_codes: [second.episodeCode],
  })
  assert.equal(wrongChannel.status, 409)
  assert.equal(wrongChannel.body.code, 'YOUTUBE_ASSIGNMENT_CHANGED')

  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL,
    episode_codes: [second.episodeCode, first.episodeCode],
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.ordered_episode_codes, [first.episodeCode, second.episodeCode])
  assert.deepEqual(preview.body.skipped_existing, [first.episodeCode])
  assert.equal(preview.body.assignments.length, 1)
  assert.equal(preview.body.assignments[0].episode_code, second.episodeCode)

  // A separate future claim arrives after review. Apply must recompute and
  // refuse the old map rather than silently giving the same slot to two rows.
  const laterClaim = new Date(Date.now() + 7 * 86_400_000).toISOString()
  await uploadPlans.writeItemSchedule(slug, {
    [first.episodeCode]: firstClaim,
    [later.episodeCode]: laterClaim,
  })
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const stale = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL,
    episode_codes: [second.episodeCode, first.episodeCode],
    confirm: true, expected_assignments: preview.body.assignments,
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'YOUTUBE_PLAN_PREVIEW_STALE')
  assert.equal(fake.calls.length, 0, 'local plan claims never change YouTube remotely')

  const saved = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL,
    episode_codes: [second.episodeCode, first.episodeCode],
    confirm: true, expected_assignments: stale.body.assignments,
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const schedule = await uploadPlans.readItemSchedule(slug)
  assert.equal(schedule[first.episodeCode], firstClaim)
  // 1.4.262: dates follow episode order. `second` is the lower code, so it
  // takes the later claim's date and `later` moves to the new plan slot.
  assert.equal(schedule[second.episodeCode], laterClaim)
  assert.deepEqual(saved.body.order_shifted, [second.episodeCode, later.episodeCode])
  const movedLater = saved.body.assignments.find((entry: any) => entry.episode_code === later.episodeCode)
  assert.equal(movedLater.previous_publish_at, laterClaim)
  assert.equal(schedule[later.episodeCode], movedLater.publishAt)
  assert.ok(Date.parse(schedule[later.episodeCode]!) > Date.parse(laterClaim))
  assert.equal(fake.calls.length, 0)
})

test('Upload Center plan replaces overdue local claims and keeps future local claims in episode order', async () => {
  const slug = await registryOnlyProject()
  const overdue = await acceptedEpisode(slug)
  const missing = await acceptedEpisode(slug)
  const future = await acceptedEpisode(slug)
  const later = await acceptedEpisode(slug)
  const legacy = await acceptedEpisode(slug)
  const accountId = `registry:${CHANNEL}`
  const plan = await uploadPlans.upsertPlan(slug, {
    name: 'Resume overdue', platform: 'youtube', account_id: accountId,
    schedule: {
      weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '12:00', timezone: 'UTC',
      start_date: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
    },
    defaults: { privacy_status: 'private' },
  })
  await uploadPlans.setActivePlanId(slug, 'youtube', accountId, plan.id)
  const overdueClaim = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const futureClaim = new Date(Date.now() + 7 * 86_400_000).toISOString()
  await uploadPlans.writeItemSchedule(slug, {
    [overdue.episodeCode]: overdueClaim,
    [future.episodeCode]: futureClaim,
  })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL,
    episode_codes: [overdue.episodeCode, missing.episodeCode, future.episodeCode],
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.skipped_existing, [future.episodeCode])
  // `future` keeps no fixed date: dates follow episode order, so it shifts
  // behind the two lower-numbered episodes being planned.
  assert.deepEqual(new Set(preview.body.assignments.map((entry: any) => entry.episode_code)),
    new Set([overdue.episodeCode, missing.episodeCode, future.episodeCode]))
  assert.ok(preview.body.assignments.every((entry: any) => Date.parse(entry.publishAt) > Date.now()))
  assert.equal(preview.body.latest_existing_claim, futureClaim)

  // The old local claim changes after review while remaining overdue. The
  // assignment timestamp fence must reject the old preview even if its slot
  // would otherwise be identical.
  const changedPastClaim = new Date(Date.now() - 86_400_000).toISOString()
  await uploadPlans.writeItemSchedule(slug, {
    [overdue.episodeCode]: changedPastClaim,
    [future.episodeCode]: futureClaim,
  })
  const changedPast = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL,
    episode_codes: [overdue.episodeCode, missing.episodeCode, future.episodeCode],
    confirm: true, expected_assignments: preview.body.assignments,
  })
  assert.equal(changedPast.status, 409)
  assert.equal(changedPast.body.code, 'YOUTUBE_PLAN_PREVIEW_STALE')
  assert.equal(changedPast.body.assignments.find((entry: any) => entry.episode_code === overdue.episodeCode).previous_publish_at, changedPastClaim)
  assert.equal((await uploadPlans.readItemSchedule(slug))[overdue.episodeCode], changedPastClaim)
  assert.equal(fake.calls.length, 0)

  // A new claim after review changes the allocator's next slot. Apply must
  // reject the old assignment map and leave the overdue claim untouched.
  const laterClaim = new Date(Date.now() + 10 * 86_400_000).toISOString()
  await uploadPlans.writeItemSchedule(slug, {
    [overdue.episodeCode]: changedPastClaim,
    [future.episodeCode]: futureClaim,
    [later.episodeCode]: laterClaim,
  })
  const stale = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL,
    episode_codes: [overdue.episodeCode, missing.episodeCode, future.episodeCode],
    confirm: true, expected_assignments: preview.body.assignments,
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'YOUTUBE_PLAN_PREVIEW_STALE')
  assert.equal((await uploadPlans.readItemSchedule(slug))[overdue.episodeCode], changedPastClaim)
  assert.equal(fake.calls.length, 0)

  const saved = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL,
    episode_codes: [overdue.episodeCode, missing.episodeCode, future.episodeCode],
    confirm: true, expected_assignments: stale.body.assignments,
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const schedule = await uploadPlans.readItemSchedule(slug)
  assert.equal(schedule[overdue.episodeCode], saved.body.assignments.find((entry: any) => entry.episode_code === overdue.episodeCode).publishAt)
  assert.equal(schedule[missing.episodeCode], saved.body.assignments.find((entry: any) => entry.episode_code === missing.episodeCode).publishAt)
  assert.equal(schedule[overdue.episodeCode], futureClaim)
  assert.equal(schedule[missing.episodeCode], laterClaim)
  const inOrder = [overdue, missing, future, later].map(episode => Date.parse(schedule[episode.episodeCode]!))
  assert.ok(inOrder.every((at, index) => index === 0 || inOrder[index - 1]! < at), JSON.stringify(schedule))
  await pm.updateConfig(slug, { [uploadPlans.LEGACY_SCHEDULE_FIELD]: { [legacy.episodeCode]: overdueClaim } } as any)
  const legacyPreview = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL, episode_codes: [legacy.episodeCode],
  })
  const legacySaved = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`).send({
    plan_id: plan.id, expected_channel_id: CHANNEL, episode_codes: [legacy.episodeCode],
    confirm: true, expected_assignments: legacyPreview.body.assignments,
  })
  assert.equal(legacySaved.status, 200, JSON.stringify(legacySaved.body))
  assert.ok(Date.parse((await uploadPlans.readItemSchedule(slug))[legacy.episodeCode]) > Date.now())
  assert.equal(fake.calls.length, 0, 'local plan claims never change YouTube remotely')
})

test('Upload Center plan protects queued and remotely known targets, including missing claims', async () => {
  const slug = await registryOnlyProject()
  const movable = await acceptedEpisode(slug)
  const queued = await acceptedEpisode(slug)
  const remoteMissing = await acceptedEpisode(slug)
  const remoteOverdue = await acceptedEpisode(slug)
  const remoteMissingOperationId = await acceptedOperation(slug, remoteMissing.episodeCode, 'video-plan-private-missing')
  const remoteMissingOperation = await operations.readYouTubeOperation(slug, remoteMissingOperationId)
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: remoteMissingOperationId, expected_revision: remoteMissingOperation!.revision,
    mutate(record) {
      record.remote_snapshot = {
        fetched_at: new Date().toISOString(), title: remoteMissing.title, description: '', tags: [],
        privacy_status: 'private', scheduled_for: null,
      }
    },
  })
  const remoteOverdueOperationId = await acceptedOperation(slug, remoteOverdue.episodeCode, 'video-plan-overdue')
  const remoteOverdueOperation = await operations.readYouTubeOperation(slug, remoteOverdueOperationId)
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: remoteOverdueOperationId, expected_revision: remoteOverdueOperation!.revision,
    mutate(record) {
      record.remote_snapshot = {
        fetched_at: new Date().toISOString(), title: remoteOverdue.title, description: '', tags: [],
        privacy_status: 'private', scheduled_for: null,
      }
    },
  })
  const accountId = `registry:${CHANNEL}`
  const plan = await uploadPlans.upsertPlan(slug, {
    name: 'Protect active uploads', platform: 'youtube', account_id: accountId,
    schedule: {
      weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '12:00', timezone: 'UTC',
      start_date: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
    },
    defaults: { privacy_status: 'private' },
  })
  await uploadPlans.setActivePlanId(slug, 'youtube', accountId, plan.id)
  const movableClaim = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const remoteOverdueClaim = new Date(Date.now() - 3 * 86_400_000).toISOString()
  await uploadPlans.writeItemSchedule(slug, {
    [movable.episodeCode]: movableClaim,
    [remoteOverdue.episodeCode]: remoteOverdueClaim,
  })
  const queuedJob = jobQueue.enqueuePreparedForTest({
    project_slug: slug, type: 'youtube_upload', episode_id: queued.episodeCode,
    title: queued.title, params: { expected_channel_id: CHANNEL },
    episode_recovery_job_id: `upload-center-plan-${Date.now()}`,
  })

  try {
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send({
      plan_id: plan.id, expected_channel_id: CHANNEL,
      episode_codes: [movable.episodeCode, queued.episodeCode, remoteMissing.episodeCode, remoteOverdue.episodeCode],
    })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.deepEqual(preview.body.assignments.map((entry: any) => entry.episode_code), [movable.episodeCode, remoteMissing.episodeCode])
    assert.deepEqual(preview.body.skipped_existing, [remoteOverdue.episodeCode])
    assert.equal((await uploadPlans.readItemSchedule(slug))[movable.episodeCode], movableClaim)
    assert.equal(fake.calls.length, 0, 'protection checks are local-only')

    const remoteCurrent = await operations.readYouTubeOperation(slug, remoteOverdueOperationId)
    await operations.updateYouTubeOperation({
      project_slug: slug, operation_id: remoteOverdueOperationId, expected_revision: remoteCurrent!.revision,
      mutate(record) { record.remote_snapshot!.privacy_status = 'unlisted' },
    })
    const unlistedPreview = await request(app).post(`/api/projects/${slug}/youtube/plan/preview`).send({
      plan_id: plan.id, expected_channel_id: CHANNEL, episode_codes: [remoteOverdue.episodeCode],
    })
    assert.equal(unlistedPreview.status, 200)
    assert.deepEqual(unlistedPreview.body.assignments, [], 'an unlisted receipt cannot hide an old sidecar date and make it movable')
    assert.equal((await sidecars.readSidecarStrict(slug, remoteOverdue.episodeCode, 'youtube'))?.scheduled_for, remoteOverdueClaim)
    // Restore the private receipt for the active-upload freshness check below.
    const unlisted = await operations.readYouTubeOperation(slug, remoteOverdueOperationId)
    await operations.updateYouTubeOperation({
      project_slug: slug, operation_id: remoteOverdueOperationId, expected_revision: unlisted!.revision,
      mutate(record) { record.remote_snapshot!.privacy_status = 'private' },
    })

    const remoteMissingJob = jobQueue.enqueuePreparedForTest({
      project_slug: slug, type: 'youtube_upload', episode_id: remoteMissing.episodeCode,
      title: remoteMissing.title, params: { expected_channel_id: CHANNEL },
      episode_recovery_job_id: `upload-center-plan-active-${Date.now()}`,
    })
    try {
      const stale = await request(app).post(`/api/projects/${slug}/youtube/plan/apply`).send({
        plan_id: plan.id, expected_channel_id: CHANNEL,
        episode_codes: [movable.episodeCode, queued.episodeCode, remoteMissing.episodeCode, remoteOverdue.episodeCode],
        confirm: true, expected_assignments: preview.body.assignments,
      })
      assert.equal(stale.status, 409)
      assert.equal(stale.body.code, 'YOUTUBE_PLAN_PREVIEW_STALE')
      const unchanged = await uploadPlans.readItemSchedule(slug)
      assert.equal(unchanged[movable.episodeCode], movableClaim)
      assert.equal(unchanged[remoteOverdue.episodeCode], remoteOverdueClaim)
      assert.equal(unchanged[remoteMissing.episodeCode], undefined)
      assert.equal(fake.calls.length, 0)
    } finally {
      await jobQueue.requestJobCancellation(slug, remoteMissingJob.job_id)
      jobQueue.removeTerminalJob(slug, remoteMissingJob.job_id)
    }
  } finally {
    await jobQueue.requestJobCancellation(slug, queuedJob.job_id)
    jobQueue.removeTerminalJob(slug, queuedJob.job_id)
  }
})

test('publishable maps cached remote lifecycle and visibility without promoting private uploads', async () => {
  // Break caught: treating every accepted upload as published erases the
  // private/unlisted, processing, scheduled, failed, and rejected states the
  // listing exists to distinguish.
  const slug = await registryOnlyProject()
  const checkedAt = '2026-09-08T12:00:00.000Z'
  const scheduledAt = '2026-09-22T12:00:00.000Z'
  const publishedAt = '2026-09-07T12:00:00.000Z'
  const rows = [
    { kind: 'published', privacy: 'public', lifecycle: 'ready', video: 'video-public', scheduled: scheduledAt },
    { kind: 'uploaded', privacy: 'unlisted', lifecycle: 'ready', video: 'video-unlisted' },
    { kind: 'scheduled', privacy: 'private', lifecycle: 'ready', video: 'video-scheduled', scheduled: scheduledAt },
    { kind: 'processing', privacy: 'private', lifecycle: 'processing', video: 'video-processing' },
    { kind: 'failed', privacy: 'private', lifecycle: 'failed', video: 'video-failed', reason: 'codec' },
    { kind: 'rejected', privacy: 'private', lifecycle: 'rejected', video: 'video-rejected', reason: 'copyright' },
  ] as const

  const byKind = new Map<string, string>()
  for (const expected of rows) {
    const episode = await acceptedEpisode(slug)
    byKind.set(expected.kind, episode.episodeCode)
    const made = await operations.createYouTubeOperation({
      project_slug: slug, episode_code: episode.episodeCode, channel_id: CHANNEL,
      source_revision: `src-${expected.kind}`, metadata_revision: `meta-${expected.kind}`,
      origin: 'manual', final_action: 'manual_upload',
    })
    const accepted = await operations.acceptYouTubeOperation({
      project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
      channel_id: CHANNEL, video_id: expected.video, accepted_at: checkedAt,
      final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
    })
    await operations.updateYouTubeOperation({
      project_slug: slug, operation_id: made.operation_id, expected_revision: accepted.revision,
      mutate(record) {
        record.lifecycle = expected.lifecycle
        record.processing = {
          checked_at: checkedAt,
          ...(expected.kind === 'failed' ? { failure_reason: expected.reason } : {}),
          ...(expected.kind === 'rejected' ? { rejection_reason: expected.reason } : {}),
        }
        record.remote_snapshot = {
          fetched_at: checkedAt, title: expected.kind, description: '', tags: [],
          privacy_status: expected.privacy,
          scheduled_for: 'scheduled' in expected ? expected.scheduled : null,
        }
      },
    })
  }
  await publishing.recordYouTubeReconcileCache({
    project_slug: slug, channel_id: CHANNEL, fetched_at: checkedAt,
    remote_videos: [{ video_id: 'video-public', title: 'published', published_at: publishedAt }],
  })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(listed.status, 200)
  const publication = (kind: string) => listed.body.episodes
    .find((row: any) => row.episode_code === byKind.get(kind)).publication

  assert.deepEqual(publication('published'), {
    state: 'published', visibility: 'public', published_at: publishedAt, last_checked_at: checkedAt,
  })
  assert.deepEqual(publication('uploaded'), {
    state: 'uploaded', visibility: 'unlisted', last_checked_at: checkedAt,
  })
  assert.deepEqual(publication('scheduled'), {
    state: 'scheduled', visibility: 'private', scheduled_at: scheduledAt, last_checked_at: checkedAt,
  })
  assert.deepEqual(publication('processing'), {
    state: 'processing', visibility: 'private', last_checked_at: checkedAt,
  })
  assert.deepEqual(publication('failed'), {
    state: 'failed', visibility: 'private', last_checked_at: checkedAt, reason: 'codec',
  })
  assert.deepEqual(publication('rejected'), {
    state: 'rejected', visibility: 'private', last_checked_at: checkedAt, reason: 'copyright',
  })
  for (const kind of byKind.keys()) {
    assert.deepEqual(
      listed.body.episodes.find((row: any) => row.episode_code === byKind.get(kind)).local.upload,
      { state: 'succeeded' },
      `provider acceptance proves the local ${kind} upload finished`,
    )
  }
  assert.equal(fake.calls.length, 0, 'cached publication projection makes no provider request')
})

test('a video YouTube stops returning keeps its last confirmed publication, marked unverified', async () => {
  // Break caught: DM0001 (2026-10-19). The check after the thumbnail 403 wrote
  // `not_found`, whose observation carries no privacy and no schedule, and the
  // projection read the newest observation only — so a video YouTube had
  // CONFIRMED as private and scheduled for a date rendered as visibility null
  // and scheduled_at null, exactly like "nothing is scheduled" (AGENTS.md §6).
  const slug = await registryOnlyProject()
  const confirmedAt = '2026-10-19T01:14:45.449Z'
  const goneAt = '2026-10-19T01:22:08.842Z'
  const publishAt = '2026-10-20T11:00:00.000Z'
  const episode = await acceptedEpisode(slug)
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: episode.episodeCode, channel_id: CHANNEL,
    source_revision: 'src-gone', metadata_revision: 'meta-gone',
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'video-gone', accepted_at: confirmedAt,
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'c'.repeat(64) },
  })
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: accepted.revision,
    mutate(record) {
      record.lifecycle = 'status_unavailable'
      record.processing = { checked_at: goneAt, provider_status: 'not_found' }
      record.remote_snapshot = {
        fetched_at: confirmedAt, title: episode.title, description: '', tags: [],
        privacy_status: 'private', scheduled_for: publishAt,
      }
    },
  })
  // The channel's cache now holds that empty answer: no privacy, no schedule.
  const cache = await import('../services/youtube-publication-cache.js')
  await cache.recordYouTubePublicationObservations({
    project_slug: slug, channel_id: CHANNEL,
    checks: [cache.observationFromDetails('video-gone', null, goneAt, 'operation', episode.episodeCode)],
  })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episode.episodeCode)
  assert.equal(row.publication.state, 'unknown', 'an answer without the video is not a publication state')
  assert.equal(row.publication.visibility, 'private', 'the confirmed privacy is kept, not blanked')
  assert.equal(row.publication.scheduled_at, publishAt, 'the confirmed schedule is kept, not blanked')
  assert.equal(row.publication.unverified_since, goneAt, 'the marker says when the answer went missing')
  assert.equal(row.publication.last_checked_at, goneAt)
})

test('publishable pairs publication with the newest successful attempt, not an older failure', async () => {
  // Break caught: operation indexes preserve insertion order, so `.find()`
  // paired the first failed attempt with the later accepted remote video.
  const slug = await registryOnlyProject()
  const episode = await acceptedEpisode(slug)
  const old = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: episode.episodeCode, channel_id: CHANNEL,
    source_revision: 'old-source', metadata_revision: 'old-meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: old.operation_id, expected_revision: old.revision,
    mutate(record) {
      record.lifecycle = 'failed'
      record.processing = { checked_at: '2026-09-01T00:00:00.000Z', failure_reason: 'connection' }
    },
  })
  const recent = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: episode.episodeCode, channel_id: CHANNEL,
    source_revision: 'new-source', metadata_revision: 'new-meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: recent.operation_id, expected_revision: recent.revision,
    channel_id: CHANNEL, video_id: 'video-new', accepted_at: '2026-09-08T00:00:00.000Z',
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'b'.repeat(64) },
  })
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: recent.operation_id, expected_revision: accepted.revision,
    mutate(record) {
      record.lifecycle = 'ready'
      record.processing = { checked_at: '2026-09-08T01:00:00.000Z', provider_status: 'processed' }
      record.remote_snapshot = {
        fetched_at: '2026-09-08T01:00:00.000Z', title: episode.title,
        description: '', tags: [], privacy_status: 'public', scheduled_for: null,
      }
    },
  })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episode.episodeCode)
  assert.equal(row.operation.operation_id, recent.operation_id)
  assert.equal(row.operation.video_id, 'video-new')
  assert.deepEqual(row.local.upload, { state: 'succeeded' })
  assert.deepEqual(row.publication, {
    state: 'published', visibility: 'public', last_checked_at: '2026-09-08T01:00:00.000Z',
  })
})

test('publishable preserves local render facts and blocks writes when the operation store is unreadable', async () => {
  // Break caught: catching a corrupt top-level remote store as an empty list
  // would label the episode unpublished and make a duplicate upload available.
  const slug = await registryOnlyProject()
  const episode = await acceptedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, episode.episodeCode, episode.title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(path.join(paths.video_dir, `${episode.episodeCode}_final_video.mp4`), tinyVideoBytes())
  const projectDir = pm.getProjectDir(slug)!
  await fs.mkdir(path.join(projectDir, 'youtube', 'operations'), { recursive: true })
  await fs.writeFile(path.join(projectDir, 'youtube', 'operations', 'index.json'), '{')

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(listed.status, 200, 'a broken remote store does not erase the local listing')
  const row = listed.body.episodes[0]
  assert.equal(row.local.render.state, 'ready')
  assert.deepEqual(row.local.upload, {
    state: 'unknown', reason: 'Story Studio cannot read the local upload records.',
  })
  assert.deepEqual(row.publication, {
    state: 'unknown', reason: 'Story Studio cannot read the local YouTube records.',
  })
  assert.match(row.blocked_reason, /cannot read the local YouTube records/)
  assert.equal('has_remote_video' in row, false, 'unknown is not guessed as absent')
})

test('Upload refuses without an explicit confirmation', async () => {
  // The two ways to get this wrong — wrong episode, wrong channel — are both
  // undoable only by deleting a public video. The confirm is the control.
  const { slug, episodeCode } = await uploadReadyProject()
  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'YOUTUBE_CONFIRMATION_REQUIRED')
})

test('Upload refuses an episode with no rendered video, before queueing anything', async () => {
  const slug = await registryOnlyProject()
  // Accepted and titled, deliberately never rendered.
  const { episodeCode } = await acceptedEpisode(slug)
  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_NO_RENDERED_VIDEO')
  assert.equal(res.body.job_id, undefined, 'nothing was queued')
})

test('Upload on a registry-only project queues the job on the registry credential', async () => {
  // The end-to-end shape blocker 1 was about: v1.5.0 as first cut had no way to
  // start an upload at all — three executors registered for job types nothing
  // enqueued.
  const { slug, episodeCode } = await uploadReadyProject()
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const body = await confirmedUploadBody(slug, episodeCode)

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send(body)
  assert.equal(res.status, 200)
  assert.equal(res.body.episode_code, episodeCode)
  assert.equal(res.body.channel_id, CHANNEL, 'queued against the ASSIGNED channel')
  assert.ok(res.body.job_id, 'a job exists')

  // The job carries the REGISTRY credential, not a legacy account id — a
  // registry-only project has none, and passing an empty one was blocker 2.
  const jobs = await import('../services/job-queue.js')
  const job = jobs.getJob(res.body.job_id)
  assert.equal(job?.type, 'youtube_upload')
  assert.match(String(job?.params?.account_id), /^registry:/)
  assert.equal(job?.params?.expected_channel_id, CHANNEL)
  assert.equal(job?.params?.expected_package_revision, body.expected_package_revision)
  assert.equal(job?.params?.approved_upload_mode, 'apply-plan')
  assert.equal(job?.params?.approved_final_payload?.snippet_json, JSON.stringify({
    title: 'The Lighthouse at Dawn', description: 'A keeper counts the nights.', tags: ['x'], categoryId: '24',
  }))
  __resetYouTubeTransportForTests()
})

test('a confirmed publish_at overrides private mode for that exact upload', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  await uploadStore.setUploadMode(slug, 'youtube', 'private')
  const publishAt = new Date(Date.now() + 86_400_000).toISOString()
  const preview = await request(app).post(`/api/projects/${slug}/youtube/preview`).send({
    episode_code: episodeCode, privacy_status: 'public', publish_at: publishAt,
  })
  assert.equal(preview.status, 200)
  const started = await request(app).post(`/api/projects/${slug}/youtube/upload`).send({
    episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL,
    privacy_status: 'public', publish_at: publishAt,
    expected_package_revision: preview.body.package_revision,
    expected_source_revision: preview.body.source?.revision,
  })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  const job = jobQueue.getJob(started.body.job_id)
  assert.equal(job?.params?.approved_upload_mode, 'apply-plan')
  assert.equal(job?.params?.scheduled_for, publishAt)
  await removeQueuedTestJob(slug, started.body.job_id)
})

test('publishable keeps queued and paused local uploads distinct from remote publication', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  const queued = jobQueue.enqueuePreparedForTest({
    project_slug: slug,
    type: 'youtube_upload',
    episode_id: episodeCode,
    title: 'Projection fixture',
    params: { expected_channel_id: CHANNEL },
    // This test-only recovery seam inserts a queued job without starting the
    // unregistered upload executor or changing the process-wide queue setting.
    episode_recovery_job_id: `upload-center-${Date.now()}`,
  })
  try {
    const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
    const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
    assert.deepEqual(row.local.upload, { state: 'queued', job_id: queued.job_id })
    assert.deepEqual(row.publication, { state: 'unpublished' })
    assert.match(row.blocked_reason, /queued/i, 'the listing does not offer a duplicate upload')

    await jobQueue.pauseJob(queued.job_id)
    const paused = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
    const pausedRow = paused.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
    assert.deepEqual(pausedRow.local.upload, {
      state: 'queued', job_id: queued.job_id, reason: 'Upload job is paused.',
    })
    assert.deepEqual(pausedRow.publication, { state: 'unpublished' })
  } finally {
    await jobQueue.requestJobCancellation(slug, queued.job_id)
    jobQueue.removeTerminalJob(slug, queued.job_id)
  }
})

test('Upload refuses a channel changed after preview with zero enqueue or provider work', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  const body = await confirmedUploadBody(slug, episodeCode)
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-after-preview', title: 'After Preview', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'after-access', refresh_token: 'after-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug,
    channel_id: 'UC-after-preview',
    expected_previous_channel_id: CHANNEL,
  })
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const before = (await jobQueue.getJobs(slug)).length

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_CHANNEL_CHANGED')
  assert.equal((await jobQueue.getJobs(slug)).length, before)
  assert.equal(fake.calls.length, 0)
})

test('Upload refuses metadata changed after preview with zero enqueue or provider work', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const body = await confirmedUploadBody(slug, episodeCode)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'Changed after preview', description: 'A keeper counts the nights.', tags: ['x'],
  }))
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const before = (await jobQueue.getJobs(slug)).length

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_PREVIEW_STALE')
  assert.equal((await jobQueue.getJobs(slug)).length, before)
  assert.equal(fake.calls.length, 0)
})

test('a second Upload for an in-flight episode is refused and names the first', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  await operations.createYouTubeOperation({
    project_slug: slug, episode_code: episodeCode, channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_UPLOAD_ALREADY_IN_FLIGHT')
  assert.ok(res.body.operation_id, 'the existing operation is NAMED, not merely refused')
})

test('Upload is refused before enqueue when the daily allowance is spent', async () => {
  // A job queued against an exhausted allowance fails later, somewhere the
  // owner is not looking.
  const { slug, episodeCode } = await uploadReadyProject()
  const ledger = await import('../services/youtube-quota-ledger.js')
  const registry = await connections.readYouTubeConnectionRegistry()
  const appId = registry.application!.application_id
  await ledger.recordYouTubeQuotaAttempt({
    application_id: appId, channel_id: CHANNEL, bucket: 'video_uploads',
    operation: 'videos.insert', amount: 100,
  })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const body = await confirmedUploadBody(slug, episodeCode)
  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send(body)
  assert.equal(res.status, 429)
  assert.equal(res.body.code, 'YOUTUBE_QUOTA_EXHAUSTED')
  assert.equal(res.body.job_id, undefined, 'nothing was queued')
  assert.equal(fake.calls.length, 0, 'and nothing reached YouTube')
  __resetYouTubeTransportForTests()
})

test('a corrupt connection registry refuses the upload instead of skipping the check', async () => {
  // The quota preflight used to open with `.catch(() => null)` on the registry
  // read, so an unreadable connections.json was indistinguishable from "no
  // OAuth application yet" - and the no-application branch returns "carry on".
  // A corrupt file therefore let EVERY upload through with no ceiling checked.
  const { slug, episodeCode } = await uploadReadyProject()
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  await fs.writeFile(connections.youtubeConnectionsPath(), '{ this is not json')

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 503)
  assert.equal(res.body.code, 'YOUTUBE_LEDGER_UNREADABLE')
  assert.equal(res.body.job_id, undefined, 'nothing was queued')
  assert.match(res.body.detail, /Nothing was uploaded/)
})

test('the manual upload path never reaches the scheduled boundary', async () => {
  // Tripwire. `executeScheduledYouTubeUpload` stays uncalled and default-off
  // across the whole feature; the moment the manual route reaches it, this
  // fails.
  const source = await fs.readFile(
    path.join(import.meta.dirname, '..', 'routes', 'youtube-upload-center.ts'), 'utf8')
  const route = source.slice(source.indexOf("router.post('/projects/:slug/youtube/upload'"))
  const body = route.slice(0, route.indexOf('\nrouter.'))
  assert.doesNotMatch(body, /executeScheduledYouTubeUpload|scheduled_upload|claimed_slot/)
  assert.match(body, /enqueueOrRun/, 'it queues a manual job and nothing else')
})


// ── The whole path, from a fresh project to a video on the fake ──────────────
//
// Every guard on this feature was correct and every test was green while the
// product could not upload at all: the page listed upload RECORDS, which only
// exist after an upload, so a project that had never uploaded had no row, no
// Preview and no Upload. The route was unreachable rather than broken, and no
// test asked whether anything reached it.
//
// So this one starts where an owner starts - a project with nothing in it - and
// only uses production code to get from there to a video id. Its page-level
// twin lives in frontend/__tests__/uploadCenterPublish.test.ts ("an episode
// that has never been uploaded is offered, previewed and uploaded"); the two
// lanes cannot share a process, so they share a fixture SHAPE instead: an
// accepted, rendered, never-uploaded episode.
test('a fresh project can be listed, previewed, uploaded, and ends up with a video id', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await acceptedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(path.join(paths.video_dir, `${episodeCode}_final_video.mp4`), tinyVideoBytes())
  // A thumbnail is required to upload (2026-10-07).
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await sharp({ create: { width: 16, height: 9, channels: 3, background: '#224466' } })
    .png().toFile(path.join(paths.thumb_dir, `${episodeCode}_Thumb01_v1.png`))

  // This owner has turned the AI disclosure OFF, through the one control that
  // actually writes it: the app-level default in Settings. It is the setting
  // the Publish page used to ignore - it hardcoded `mark_as_ai_generated: true`
  // into the preview request, so the "exact payload" panel said he had
  // disclosed while the generator resolved his real setting and sent the
  // opposite. Disclosure is a statement to YouTube, not a display preference.
  await appSettings.setYoutubeDefaults({ default_mark_as_ai_generated: false })

  // 1. The page's row source offers it, with no upload record yet.
  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(listed.status, 200)
  const offered = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.ok(offered, 'a rendered, accepted episode is offered before it has ever been uploaded')
  assert.equal(offered.has_video, true)
  assert.equal(offered.title, title)
  assert.equal(offered.operation, undefined, 'nothing has been uploaded yet')

  // 2. The preview shows the project's real setting.
  const approvedPublishAt = new Date(Date.now() + 86_400_000).toISOString()
  const preview = await request(app).post(`/api/projects/${slug}/youtube/preview`)
    .send({ episode_code: episodeCode, privacy_status: 'public', publish_at: approvedPublishAt })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.status.containsSyntheticMedia, false,
    'the payload shown is the project\'s disclosure setting, not the caller\'s')
  assert.equal(preview.body.snippet.title, title, 'and the title production gave the episode')

  // 3. Upload.
  const SESSION = 'https://upload.youtube.test/resumable/e2e-session'
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    body: {},
    headers: { Location: SESSION },
  })
  fake.respond({ method: 'PUT', path: '/resumable/e2e-session', body: { id: 'video-e2e' } })
  fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
  __setYouTubeTransportForTests(fake.transport())

  const started = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({
      episode_code: episodeCode,
      confirm: true,
      expected_channel_id: CHANNEL,
      expected_package_revision: preview.body.package_revision,
      expected_source_revision: preview.body.source?.revision,
      privacy_status: 'public',
      publish_at: approvedPublishAt,
    })
  assert.equal(started.status, 200)
  assert.ok(started.body.job_id, 'a job was queued')

  // Once admitted, the server-owned package is immutable. A later metadata
  // edit applies to a future preview; it cannot silently repoint this upload.
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'Edited after queue', description: 'Different later metadata.', tags: ['later'],
  }))
  // The admission also pins the workflow mode that explains the operation
  // action. A later setting applies to the next upload, never this one.
  await uploadStore.setUploadMode(slug, 'youtube', 'private')

  // 4. Run the job the route queued - its OWN params, not invented ones.
  const queued = jobQueue.getJob(started.body.job_id)
  assert.ok(queued, 'the queued job is readable')
  const running: any = {
    job_id: queued!.job_id, project_slug: slug, episode_id: episodeCode,
    output_lines: [], params: queued!.params,
  }
  await generateYoutubeUpload(running)

  // 5. The outcome: a durable accepted operation with the video id.
  const records = await operations.listYouTubeOperations(slug)
  const record = records.find(entry => entry.episode_code === episodeCode)
  assert.ok(record, 'the upload left a durable record')
  assert.equal(record!.lifecycle, 'accepted')
  assert.equal(record!.video_id, 'video-e2e')
  assert.equal(record!.final_action, 'manual_upload', 'the accepted schedule determines the recorded action')
  assert.equal(JSON.parse(record!.final_payload!.status_json).publishAt, approvedPublishAt)

  // 6. And what YouTube was actually SENT matches what the owner was shown.
  // Asserting only the preview would pass on a page that showed one thing and
  // sent another - which is exactly the defect this test exists for.
  const upload = fake.calls.find(call => /\/upload\/youtube\/v3\/videos/.test(call.path))
  assert.ok(upload?.body, 'the fake received an upload')
  assert.equal(JSON.parse(upload!.body!).status.containsSyntheticMedia, false,
    'the disclosure flag sent to YouTube is the one the owner set and the one he was shown')
  assert.equal(JSON.parse(upload!.body!).snippet.title, preview.body.snippet.title,
    'metadata edited after enqueue cannot change the accepted upload')
  assert.equal(JSON.parse(upload!.body!).status.publishAt, approvedPublishAt,
    'upload mode edited after enqueue cannot remove the accepted schedule')
  const sidecar = await sidecars.readSidecar(slug, episodeCode, title, 'youtube')
  assert.equal(sidecar?.scheduled_for, approvedPublishAt,
    'the permanent receipt records the same schedule YouTube received')

  // 7. The episode now has a durable remote identity, so the page will not offer it again.
  const after = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = after.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.operation?.video_id, 'video-e2e')
})


// ── The legacy sidecar: the store the route could not see ────────────────────
//
// Tell 13. Every episode the owner published through the OLD page left a
// sidecar and no operation record. The route's refusal and the page both read
// only records, while the upload GENERATOR branches on the sidecar - so all
// three agreed the episode had never been uploaded, and the job would then
// quietly PATCH the live public video instead of uploading, after the owner had
// confirmed an upload and been told one had started.

/** An episode published by the old page: a sidecar with a video id, no record. */
async function legacyPublishedEpisode(slug: string): Promise<{ episodeCode: string, title: string }> {
  const { episodeCode, title } = await acceptedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(path.join(paths.video_dir, `${episodeCode}_final_video.mp4`), tinyVideoBytes())
  await sidecars.writeSidecar(slug, episodeCode, title, {
    platform: 'youtube', video_id: 'legacy-video-77', account_id: 'legacy-account',
    channel_id: CHANNEL, uploaded_at: new Date().toISOString(), last_sync_at: new Date().toISOString(),
    scheduled_for: null, privacy_status: 'public', title, description: 'd', tags: [],
    thumbnail_set: false,
  })
  return { episodeCode, title }
}

test('an episode uploaded by the old page reads as uploaded, and is not offered for upload', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const legacy = await sidecars.readSidecarRaw(slug, episodeCode, title, 'youtube')
  await sidecars.writeSidecar(slug, episodeCode, title, {
    ...legacy!, scheduled_for: '2026-09-22T12:00:00.000Z',
  })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.ok(row, 'it is still listed - the owner must be able to see it')
  assert.equal(row.has_remote_video, true, 'and it is known to be on YouTube')
  assert.equal(row.remote_video_id, 'legacy-video-77')
  assert.equal(row.remote_source, 'legacy_sidecar', 'the row says WHICH store knew')
  assert.equal(row.operation, undefined, 'there is no operation record - that is the whole point')
  assert.deepEqual(row.local.upload, { state: 'succeeded' },
    'a durable remote identity never reads as "Not uploaded"')
  assert.deepEqual(row.publication, { state: 'uploaded' },
    'the legacy receipt proves an upload, not current visibility or a publication date')
  assert.equal(row.plan.scheduled_at, '2026-09-22T12:00:00.000Z',
    'the same unconfirmed sidecar date remains visible as local plan evidence')
})

test('uploading an episode the old page already published is refused, naming the video', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await legacyPublishedEpisode(slug)

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_ALREADY_PUBLISHED', 'published, not in flight')
  assert.equal(res.body.video_id, 'legacy-video-77')
  assert.equal(res.body.remote_source, 'legacy_sidecar')
  assert.match(res.body.detail, /already on YouTube as legacy-video-77/)
  assert.equal(res.body.job_id, undefined, 'and nothing was queued')
})

test('a YouTube-failed upload is superseded: one replacement is accepted, the next is refused', async () => {
  // Domnak DM0001-DM0003, 2026-10-19. YouTube accepted each upload and then
  // abandoned processing it (the channel was not verified for long videos).
  // The accepted record AND the sidecar the job wrote beside it otherwise
  // refused every re-upload for good - "already on YouTube" for a video that
  // never became one. A healthy video must keep refusing exactly as before.
  const slug = await registryOnlyProject()
  const { episodeCode } = await legacyPublishedEpisode(slug)
  const dead = 'legacy-video-77'
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: episodeCode, channel_id: CHANNEL,
    source_revision: 'src-dead', metadata_revision: 'meta-dead',
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: dead, accepted_at: '2026-10-19T01:14:45.449Z',
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'd'.repeat(64) },
  })
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: accepted.revision,
    mutate(record) {
      record.lifecycle = 'failed'
      record.processing = {
        checked_at: '2026-10-19T01:22:08.842Z', provider_status: 'failed',
        failure_reason: 'YouTube abandoned processing: video too long for this channel. Verify the channel for long videos, then re-upload.',
      }
    },
  })

  // The row says WHY, and neither the video nor the upload counts as live.
  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.publication.state, 'failed')
  assert.match(row.publication.reason, /video too long for this channel/)
  assert.equal(row.local.upload.state, 'failed', 'the remote verdict outranks the job error')
  assert.equal(row.has_remote_video, false, 'a failed upload is not a video this episode has')

  const body = await confirmedUploadBody(slug, episodeCode)
  const started = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  try {
    assert.equal(started.status, 200, 'the dead upload does not block the one replacement')
    assert.ok(started.body.job_id)

    // Once the replacement has its OWN video id, the guard refuses the next one.
    const replacement = await operations.createYouTubeOperation({
      project_slug: slug, episode_code: episodeCode, channel_id: CHANNEL,
      source_revision: 'src-new', metadata_revision: 'meta-new',
      origin: 'manual', final_action: 'manual_upload',
    })
    await operations.acceptYouTubeOperation({
      project_slug: slug, operation_id: replacement.operation_id, expected_revision: replacement.revision,
      channel_id: CHANNEL, video_id: 'video-replacement', accepted_at: new Date().toISOString(),
      final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'e'.repeat(64) },
    })
    const again = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'YOUTUBE_ALREADY_PUBLISHED')
    assert.equal(again.body.video_id, 'video-replacement', 'the LIVE video is the one that answers')
  } finally {
    await jobQueue.requestJobCancellation(slug, started.body.job_id).catch(() => {})
    jobQueue.removeTerminalJob(slug, started.body.job_id)
  }
})

test('when both stores know the episode, the operation record is the one that answers', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  // A newer upload through the redesigned path left a record naming a
  // DIFFERENT video. The record is ours and carries a channel; the sidecar
  // predates channel identity. The record wins, and the reason is visible.
  const made = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: episodeCode, channel_id: CHANNEL,
    source_revision: 'src', metadata_revision: 'meta',
    origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
    channel_id: CHANNEL, video_id: 'record-video-99', accepted_at: new Date().toISOString(),
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'b'.repeat(64) },
  })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.remote_video_id, 'record-video-99', 'the record decides')
  assert.equal(row.remote_source, 'operation_record')
  assert.equal(title, row.title)
})

test('every accepted episode is listed, newest first, with no cap', async () => {
  // A 50-cap shipped here for one round. The legacy page that listed everything
  // is gone and there is no offset, so on the owner's 854-episode project every
  // episode below the newest fifty became permanently unpublishable - including
  // EP0061, which his own release notes tell him to repair.
  const slug = await registryOnlyProject()
  for (let i = 0; i < 60; i++) {
    const [idea] = await im.addIdeas(slug, [{
      title: `Episode ${i}`, logline: '', themes: [], suggested_chapters: 3,
      suggested_length: 'short', mood: '',
    }], 'test-model')
    await im.acceptIdea(slug, idea!.id)
  }

  const res = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(res.status, 200)
  assert.equal(res.body.episodes.length, 60, 'all of them, not a page of them')
  assert.equal(res.body.total, 60)
  assert.equal(res.body.truncated, undefined, 'there is no truncation to report')

  // Numeric ordering: a string sort puts EP0009 above EP0010 and EP0060.
  assert.equal(res.body.episodes[0].episode_code, 'EP0060')
  assert.equal(res.body.episodes[59].episode_code, 'EP0001')
  const oldest = res.body.episodes.find((entry: any) => entry.episode_code === 'EP0003')
  assert.ok(oldest, 'an early episode is still reachable')
})

test('a renamed episode folder is still recognised as published', async () => {
  // The sidecar used to be resolved from the CURRENT title, so renaming an
  // episode pointed the read at a folder that does not exist: "never uploaded"
  // for a video that is live, and the page, the route and the job all agreed.
  // The next click would have put a SECOND copy on YouTube.
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)

  // Rename the idea the way the app does. The folder keeps its old name on
  // disk; only the title in ideas.json moves.
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(entry => entry.episode_code === episodeCode)!
  await im.updateIdea(slug, idea.id, { title: `${title} (Director's Cut)` })

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409, 'still refused after the rename')
  assert.equal(res.body.video_id, 'legacy-video-77')
})

/** YouTube confirms the episode's videos are gone and nothing on the channel shares the title. */
function youtubeConfirmsGone(): FakeYouTube {
  const fake = new FakeYouTube()
  fake.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/videos\?/, body: { items: [] } })
  fake.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/channels\?/, body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-test' } } }] } })
  fake.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/playlistItems\?/, body: { items: [] } })
  __setYouTubeTransportForTests(fake.transport())
  return fake
}

test('an automatic missing-video tombstone still requires explicit removal before reupload', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const current = await sidecars.readSidecarRaw(slug, episodeCode, title, 'youtube')
  await sidecars.writeSidecar(slug, episodeCode, title, {
    ...current!, deleted_at: new Date().toISOString(), deleted_reason: 'sync_404',
  })
  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.has_remote_video, true, 'a missing response does not prove deletion')
  const refused = await request(app).post(`/api/projects/${slug}/youtube/upload`).send({
    episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL,
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'YOUTUBE_ALREADY_PUBLISHED')
  youtubeConfirmsGone()
  const removed = await request(app).post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/forget-upload`).send({
    confirm: true, expected_channel_id: CHANNEL, expected_video_id: current!.video_id,
  })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  const after = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(after.body.episodes.find((entry: any) => entry.episode_code === episodeCode).has_remote_video, false)
})


test('an episode linked in Reconcile is not offered for a second upload', async () => {
  // The SECOND tell-13 store. `/reconcile/apply` writes `episode_video_links`
  // with source 'reconcile' and creates neither an operation record nor a
  // sidecar, so an owner who linked a channel video to an episode was then told
  // by Publish that it had never been uploaded.
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  await publishing.linkYouTubeEpisodeVideo({
    project_slug: slug, episode_code: episodeCode, channel_id: CHANNEL,
    video_id: 'reconciled-video-5', source: 'reconcile', decided_at: new Date().toISOString(),
  })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.has_remote_video, true)
  assert.equal(row.remote_video_id, 'reconciled-video-5')
  assert.equal(row.remote_source, 'reconcile_link')
  assert.deepEqual(row.local.upload, { state: 'succeeded' })
  assert.deepEqual(row.publication, { state: 'uploaded' })

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
  assert.equal(res.body.remote_source, 'reconcile_link')
})


test('an unreadable sidecar refuses the upload instead of reading as never-uploaded', async () => {
  // The "propagation fix" of the previous round did not exist: the outer
  // `.catch(() => null)` was deleted while `readSidecarAtPath` swallowed the
  // same failures underneath. A truncated or corrupt sidecar still read as
  // "never uploaded", which on this path means "go ahead and upload" — a second
  // public video of an episode that is already published.
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.writeFile(path.join(paths.episode_dir, 'youtube_upload.json'), '{')

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_OPERATION_RECORD_CORRUPT')
  assert.match(res.body.detail, /Nothing was uploaded/)
  assert.equal(res.body.job_id, undefined)
})

test('a sidecar that cannot name its channel still refuses the upload', async () => {
  // `channel_id` is required by the TYPE and never validated on disk — the
  // history importer has a `missing_channel_id` escalation for exactly this.
  // Comparing `=== channelId` read such a sidecar as "another channel's", i.e.
  // uploadable. When the record cannot say, refuse: a wrongly-refused upload is
  // a message, a wrongly-allowed one is a video nobody can un-publish.
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  const file = path.join(paths.episode_dir, 'youtube_upload.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf-8'))
  delete raw.channel_id
  await fs.writeFile(file, JSON.stringify(raw))

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
  assert.equal(res.body.video_id, 'legacy-video-77')
})


test('the publishable sweep reads the publishing state a CONSTANT number of times', async () => {
  // The read-count tripwire that replaces the deleted wall-clock budget test.
  //
  // The budget version could not fail: 20,000 ms against a 342 ms baseline, and
  // it measured 4,997 ms on a reviewer's machine without going red. A stopwatch
  // on a shared machine either flakes or proves nothing.
  //
  // I previously recorded that a call-count spy "could not be written" because
  // the route binds its import statically. That was wrong about the mechanism:
  // the thing to wrap is `fs.readFile`, not the module export — the same trick
  // `__tests__/fixtures/scene-render-status-process.ts:19` already uses. Zero
  // production surface, and it asserts the actual invariant the hoist created:
  // the state is read under a lock, so reading it per episode serialises the
  // whole sweep.
  const slug = await registryOnlyProject()
  for (let i = 0; i < 200; i++) {
    const [idea] = await im.addIdeas(slug, [{
      title: `Episode ${i}`, logline: '', themes: [], suggested_chapters: 3,
      suggested_length: 'short', mood: '',
    }], 'test-model')
    await im.acceptIdea(slug, idea!.id)
  }

  // The ORIGINAL function object, not a bound copy: restoring a bound wrapper
  // would leave `fs.readFile` permanently replaced for the rest of the suite.
  const originalReadFile = fs.readFile
  let stateReads = 0
  const sweep = async (): Promise<any> => {
    stateReads = 0
    ;(fs as any).readFile = async (file: any, ...rest: any[]) => {
      // Scoped to THIS project's state file. Counting every `project-state.json`
      // on the machine would fold in other projects' reads and hide a per-row
      // read behind noise.
      const path = String(file)
      if (path.includes(slug) && path.endsWith('project-state.json')) stateReads += 1
      return (originalReadFile as any).call(fs, file, ...rest)
    }
    try {
      return await request(app).get(`/api/projects/${slug}/youtube/publishable`)
    } finally {
      ;(fs as any).readFile = originalReadFile
    }
  }

  // The store reads its own file a small, CONSTANT number of times per request
  // (transaction recovery, then the read). The invariant that matters is not
  // "exactly one" — it is that the count does not grow with the episode count,
  // which is what reading it inside the loop did.
  const small = await sweep()
  const readsFor200 = stateReads
  assert.equal(small.status, 200)
  // Tell 9: a counter that never counts would satisfy the equality below
  // without the wrap ever intercepting anything.
  assert.ok(readsFor200 > 0, 'the fs.readFile wrap actually intercepted the state read')

  for (let i = 200; i < 400; i++) {
    const [idea] = await im.addIdeas(slug, [{
      title: `Episode ${i}`, logline: '', themes: [], suggested_chapters: 3,
      suggested_length: 'short', mood: '',
    }], 'test-model')
    await im.acceptIdea(slug, idea!.id)
  }
  const res = await sweep()

  assert.equal(res.status, 200)
  assert.equal(res.body.episodes.length, 400, 'all of them, uncapped')
  assert.equal(res.body.total, 400)
  assert.equal(res.body.episodes[0].episode_code, 'EP0400', 'newest first, numerically')
  const readsFor400 = stateReads
  assert.equal(readsFor400, readsFor200,
    `the publishing state was read ${readsFor400} times for 400 episodes and ${readsFor200} for 200 — it scales with the list`)
})

test('a tombstoned sidecar on THIS channel is uploadable again', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const current = await sidecars.readSidecarRaw(slug, episodeCode, title, 'youtube')
  await sidecars.writeSidecar(slug, episodeCode, title, {
    ...current!, deleted_at: new Date().toISOString(), deleted_reason: 'manual',
  })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((e: any) => e.episode_code === episodeCode)
  assert.equal(row.has_remote_video, false, 'the video is gone, so the episode is free again')
  assert.equal(row.blocked_reason, undefined)
})

test('a tombstoned sidecar that cannot say which channel it was on still refuses', async () => {
  // `channel_id` is required by the type and never validated on disk. The live
  // case already refused when it is missing; the tombstoned case was taking the
  // "same channel, so uploadable" branch instead, because `!sidecar.channel_id`
  // counted as same-channel. A record that cannot say where its video lived
  // cannot say the video is gone from HERE either.
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const current = await sidecars.readSidecarRaw(slug, episodeCode, title, 'youtube')
  const stripped: any = { ...current!, deleted_at: new Date().toISOString(), deleted_reason: 'takedown' }
  delete stripped.channel_id
  await sidecars.writeSidecar(slug, episodeCode, title, stripped)

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((e: any) => e.episode_code === episodeCode)
  assert.equal(row.has_remote_video, true, 'cannot say means refuse, for tombstones too')

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
})

test('a tombstoned sidecar on ANOTHER channel still refuses', async () => {
  // The case the deleted update-branch guard covered and the first version of
  // the tombstone fix lost: the video is gone from the OTHER channel, but the
  // record of it is the only one there is, and uploading here overwrites it.
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const current = await sidecars.readSidecarRaw(slug, episodeCode, title, 'youtube')
  await sidecars.writeSidecar(slug, episodeCode, title, {
    ...current!, channel_id: 'UC-somewhere-else',
    deleted_at: new Date().toISOString(), deleted_reason: 'takedown',
  })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((e: any) => e.episode_code === episodeCode)
  assert.equal(row.has_remote_video, true)
  assert.match(row.blocked_reason, /UC-somewhere-else/)
  assert.deepEqual(row.publication, {
    state: 'uploaded', reason: 'This upload belongs to channel UC-somewhere-else.',
  },
    'a historical upload elsewhere is never presented as published or scheduled on this channel')

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409)
})

test('one unreadable episode refuses its own row and leaves the rest of the page standing', async () => {
  // A1, created by round 6: `remoteVideoFor` throws on a corrupt sidecar, and
  // inside `Promise.all` an uncaught throw rejects the WHOLE sweep — so one bad
  // youtube_upload.json replaced the entire Publish page with a load error for
  // all 854 episodes. A listing endpoint degrades per row, never collectively.
  const slug = await registryOnlyProject()
  const good = await acceptedEpisode(slug)
  const bad = await legacyPublishedEpisode(slug)
  const paths = await utils.resolveEpisodePaths(slug, bad.episodeCode, bad.title)
  await fs.writeFile(path.join(paths.episode_dir, 'youtube_upload.json'), '{')

  const res = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(res.status, 200, 'the page still loads')
  assert.equal(res.body.episodes.length, 2, 'both episodes are listed')

  const healthy = res.body.episodes.find((e: any) => e.episode_code === good.episodeCode)
  assert.equal(healthy.blocked_reason, `${good.episodeCode} has no rendered video yet.`,
    'the healthy row is unaffected by its neighbour')

  const broken = res.body.episodes.find((e: any) => e.episode_code === bad.episodeCode)
  assert.match(broken.blocked_reason, /cannot read its upload record/,
    'the unreadable row refuses, and says why')
})

test('an episode whose sidecar names another channel is refused, not offered', async () => {
  // Tell 13, fourth instance: the predicate returned null here (page and route
  // said "publishable") while the JOB refused — one question, two answers,
  // discovered only after the owner pressed Upload.
  const slug = await registryOnlyProject()
  const { episodeCode, title } = await legacyPublishedEpisode(slug)
  const current = await sidecars.readSidecarRaw(slug, episodeCode, title, 'youtube')
  await sidecars.writeSidecar(slug, episodeCode, title, { ...current!, channel_id: 'UC-somewhere-else' })

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((e: any) => e.episode_code === episodeCode)
  assert.equal(row.has_remote_video, true, 'the page knows it is published elsewhere')
  assert.match(row.blocked_reason, /UC-somewhere-else/)

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: episodeCode, confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409, 'and the route refuses for the same reason')
  assert.match(res.body.detail, /would overwrite the only local record/)
})

test('episode codes sort by their trailing number, and total counts every episode', async () => {
  const slug = await registryOnlyProject()
  for (const title of ['A', 'B', 'C']) {
    const [idea] = await im.addIdeas(slug, [{
      title, logline: '', themes: [], suggested_chapters: 3, suggested_length: 'short', mood: '',
    }], 'test-model')
    await im.acceptIdea(slug, idea!.id)
  }
  const res = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  // A string sort puts EP0003 before EP0002; the numeric one does not.
  assert.deepEqual(res.body.episodes.map((e: any) => e.episode_code), ['EP0003', 'EP0002', 'EP0001'])
  assert.equal(res.body.total, 3, 'total is the whole set, not the rendered page')
})


test('upload preview pins rendered bytes: a revision that no longer matches is refused by the job, not by a second read in the POST', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  // A real, probeable render and a thumbnail, so the only thing that can
  // refuse this upload is the source-revision check itself.
  await fs.writeFile(path.join(paths.video_dir, `${episodeCode}_final_video.mp4`), tinyVideoBytes())
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, `${episodeCode}_Thumb01_v1.png`), PNG)
  const reviewed = await confirmedUploadBody(slug, episodeCode)
  assert.match(reviewed.expected_source_revision, /^sha256:[a-f0-9]{64}$/)
  // The render changed after the review (an earlier file was reviewed): the
  // owner's confirmation names bytes that are no longer on disk.
  const body = { ...reviewed, expected_source_revision: `sha256:${'0'.repeat(64)}` }
  const jobsBefore = (await jobQueue.getJobs(slug)).length
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())

  // The POST admits the job carrying the revision the OWNER reviewed. It does
  // not read the render: that read was a whole-file SHA-256 on the request
  // path — 115.6 s on the Mac mini (2026-10-18, PR0011) for a 96-minute final
  // whose bytes were not in the page cache, past the caller's 120 s timeout.
  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.ok(res.body.job_id, 'a job was queued')
  assert.equal((await jobQueue.getJobs(slug)).length, jobsBefore + 1, 'exactly one job')
  const queued = jobQueue.getJob(res.body.job_id)
  assert.equal(queued?.params?.expected_source_revision, body.expected_source_revision,
    'the reviewed revision travels to the job unchanged')

  // The generator asks the same question on the bytes it would send, and
  // refuses before any operation record or provider call. This is the guard
  // the request path used to duplicate.
  const running: any = {
    job_id: queued!.job_id, project_slug: slug, episode_id: episodeCode,
    output_lines: [], params: queued!.params,
  }
  await assert.rejects(() => generateYoutubeUpload(running), /changed after confirmation/)
  assert.equal(fake.calls.length, 0, 'nothing was sent to YouTube')
  assert.deepEqual(await operations.listYouTubeOperations(slug), [],
    'no durable operation intent was written for bytes the owner never reviewed')
  await removeQueuedTestJob(slug, res.body.job_id)
})

test('the upload POST never opens the rendered bytes', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const body = await confirmedUploadBody(slug, episodeCode)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  const filename = path.join(paths.video_dir, `${episodeCode}_final_video.mp4`)
  // Unreadable, still a non-empty file: the request path may stat it and must
  // not read it. Before this fix the route SHA-256'd the whole render here —
  // on a real episode a 2-4 GB read on the request thread, competing with the
  // upload's own reads of the same file — and this POST answered 500.
  await fs.chmod(filename, 0o000)
  try {
    const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(res.body.job_id, 'a job was queued without reading the render')
    assert.equal(jobQueue.getJob(res.body.job_id)?.params?.expected_source_revision, body.expected_source_revision)
    await removeQueuedTestJob(slug, res.body.job_id)
  } finally {
    await fs.chmod(filename, 0o600)
  }
})

test('the upload POST answers while the upload itself is still in progress', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  // A real, probeable render and a thumbnail: this test runs the job as well
  // as the route, so the upload must be admissible all the way to the provider.
  await fs.writeFile(path.join(paths.video_dir, `${episodeCode}_final_video.mp4`), tinyVideoBytes())
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, `${episodeCode}_Thumb01_v1.png`), PNG)
  const body = await confirmedUploadBody(slug, episodeCode)

  const SESSION = 'https://upload.youtube.test/resumable/slow-session'
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    body: {},
    headers: { Location: SESSION },
  })
  fake.respond({ method: 'PUT', path: '/resumable/slow-session', body: { id: 'video-slow' } })
  fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
  // The slow provider: every PUT of video bytes waits on this gate, so the
  // upload is genuinely still in progress while the assertions below run.
  let releaseUpload!: () => void
  const uploadHeld = new Promise<void>(resolve => { releaseUpload = resolve })
  const inner = fake.transport()
  __setYouTubeTransportForTests(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/resumable/')) await uploadHeld
    return inner(input, init)
  })

  const jobsBefore = (await jobQueue.getJobs(slug)).length
  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const jobId = res.body.job_id
  assert.ok(jobId, 'the POST answered with a job while nothing had been uploaded')
  assert.equal((await jobQueue.getJobs(slug)).length, jobsBefore + 1, 'the POST queued exactly one job')

  // Run the job the route queued — its OWN params, not invented ones (this
  // lane's executor is registered by the app's boot, not by this harness).
  const queued = jobQueue.getJob(jobId)
  assert.ok(queued, 'the queued job is readable')
  const running: any = {
    job_id: queued!.job_id, project_slug: slug, episode_id: episodeCode,
    output_lines: [], params: queued!.params,
  }
  let finished = false
  const upload = generateYoutubeUpload(running).finally(() => { finished = true })
  // The provider holds the video bytes, so the upload is genuinely still in
  // progress while the POST's answer is already in hand.
  await waitFor(
    () => fake.calls.some(call => call.method === 'POST' && call.path.includes('uploadType=resumable')),
    { label: 'the upload to reach the provider' },
  )
  assert.equal(finished, false, 'the upload is still in progress')
  assert.equal(res.body.job_id, jobId, 'the POST had already answered, with this job')
  assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 0,
    'no video bytes have been sent: the POST did not wait for the transfer')

  releaseUpload()
  await upload
  assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 1, 'the bytes were sent once')
  assert.equal((await jobQueue.getJobs(slug)).length, jobsBefore + 1,
    'still exactly one job: the in-flight upload never spawned a duplicate')
  await removeQueuedTestJob(slug, jobId)
})

test('upload requires the rendered file revision from explicit review', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  const body = await confirmedUploadBody(slug, episodeCode)
  const jobsBefore = (await jobQueue.getJobs(slug)).length
  const { expected_source_revision: _reviewedSource, ...withoutSource } = body
  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(withoutSource)
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'YOUTUBE_CONFIRMATION_REQUIRED')
  assert.equal((await jobQueue.getJobs(slug)).length, jobsBefore)
})

test('confirmed deleted-video association permits a new upload and preserves the old receipt', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const id = await acceptedOperation(slug, episodeCode, 'deleted-video')
  const accepted = await operations.readYouTubeOperation(slug, id)
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: id, expected_revision: accepted!.revision,
    mutate: record => { record.lifecycle = 'ready' },
  })
  await sidecars.writeSidecar(slug, episodeCode, title, {
    platform: 'youtube', video_id: 'deleted-video', channel_id: CHANNEL,
    account_id: `registry:${CHANNEL}`, uploaded_at: new Date().toISOString(),
    last_sync_at: new Date().toISOString(), scheduled_for: '2099-11-03T11:00:00.000Z',
    privacy_status: 'private', title, description: '', tags: [], thumbnail_set: false,
  })
  const fake = youtubeConfirmsGone()
  const endpoint = `/api/projects/${slug}/youtube/episodes/${episodeCode}/forget-upload`
  assert.equal((await request(app).post(endpoint).send({
    expected_channel_id: CHANNEL, expected_video_id: 'deleted-video',
  })).status, 400)
  assert.equal((await request(app).post(endpoint).send({
    confirm: true, expected_channel_id: CHANNEL, expected_video_id: 'different-video',
  })).status, 409)
  const removed = await request(app).post(endpoint).send({
    confirm: true, expected_channel_id: CHANNEL, expected_video_id: 'deleted-video',
  })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  const list = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = list.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.has_remote_video, false)
  assert.equal(row.publication.state, 'unpublished')
  assert.equal(row.plan.scheduled_at, '2099-11-03T11:00:00.000Z', 'retain the episode plan for a new explicit review, never claim remote scheduling')
  assert.ok(['none', 'failed'].includes(row.local.upload.state), 'historical completed jobs must not block a replacement')
  assert.equal((await operations.readYouTubeOperation(slug, id))?.video_id, 'deleted-video')
  assert.equal((await publishing.readYouTubeProjectPublishingState(slug)).removed_videos?.[0]?.video_id, 'deleted-video')
  // New provider acceptance can replace the active link, while history stays.
  await acceptedOperation(slug, episodeCode, 'replacement-video')
  const refreshed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  assert.equal(refreshed.body.episodes.find((entry: any) => entry.episode_code === episodeCode).remote_video_id, 'replacement-video')
  assert.ok(fake.calls.length > 0 && fake.calls.every(call => call.method === 'GET'),
    'association removal only READS YouTube (to confirm the video is gone), never changes it')
})

test('forget-upload refuses while YouTube still has the video, and when YouTube cannot be checked', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  const id = await acceptedOperation(slug, episodeCode, 'still-there')
  const accepted = await operations.readYouTubeOperation(slug, id)
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: id, expected_revision: accepted!.revision,
    mutate: record => { record.lifecycle = 'status_unavailable'; record.processing = { checked_at: new Date().toISOString() } },
  })
  const endpoint = `/api/projects/${slug}/youtube/episodes/${episodeCode}/forget-upload`
  const body = { confirm: true, expected_channel_id: CHANNEL, expected_video_id: 'still-there' }
  const live = new FakeYouTube()
  live.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/videos\?/, body: { items: [{ id: 'still-there', status: { uploadStatus: 'processed' }, snippet: {} }] } })
  live.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/channels\?/, body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-test' } } }] } })
  live.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/playlistItems\?/, body: { items: [] } })
  __setYouTubeTransportForTests(live.transport())
  const refused = await request(app).post(endpoint).send(body)
  assert.equal(refused.status, 409)
  assert.match(refused.body.detail, /still has video still-there/)
  const offline = new FakeYouTube()
  offline.respondMatching({ method: 'GET', match: /^\/youtube\/v3\/videos\?/, status: 503, body: {} })
  __setYouTubeTransportForTests(offline.transport())
  const unchecked = await request(app).post(endpoint).send(body)
  assert.equal(unchecked.status, 409)
  assert.equal(unchecked.body.code, 'YOUTUBE_STATUS_UNCHECKED')
  assert.equal((await publishing.readYouTubeProjectPublishingState(slug)).removed_videos, undefined)
})

test('deleted-video association refusal preserves an upload that is still processing', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  await acceptedOperation(slug, episodeCode, 'processing-video')
  const res = await request(app).post(`/api/projects/${slug}/youtube/episodes/${episodeCode}/forget-upload`).send({
    confirm: true, expected_channel_id: CHANNEL, expected_video_id: 'processing-video',
  })
  assert.equal(res.status, 409)
  assert.match(res.body.detail, /not finished/)
  assert.equal((await publishing.readYouTubeProjectPublishingState(slug)).removed_videos, undefined)
})

// ---------------------------------------------------------------------------
// Re-laying planned dates
//
// `previewUploadCenterPlan` deliberately refuses to move an episode that holds a
// FUTURE local claim (it reports the code in `skipped_existing`), and the publish
// page's `canPlanEpisode` refuses the same rows. That is correct for "plan what
// is unscheduled" and left the opposite intent unreachable: an episode given a
// date it should not have kept — because a failed render let the episode behind
// it take the slot — could not be re-dated from ANY surface. These tests pin the
// action that closes that gap, and the two boundaries it must not cross.
// ---------------------------------------------------------------------------

/** An active all-days UTC plan, so a re-lay from a known date is deterministic. */
async function relayoutPlan(slug: string): Promise<{ id: string, accountId: string }> {
  const accountId = `registry:${CHANNEL}`
  const plan = await uploadPlans.upsertPlan(slug, {
    name: 'Re-lay', platform: 'youtube', account_id: accountId,
    schedule: { weekdays: [0, 1, 2, 3, 4, 5, 6], time_local: '12:00', timezone: 'UTC' },
    defaults: { privacy_status: 'private' },
  })
  await uploadPlans.setActivePlanId(slug, 'youtube', accountId, plan.id)
  return { id: plan.id, accountId }
}

test('re-lay re-dates already-planned episodes from a chosen start date, locally only', async () => {
  // Break caught: routing this through the existing plan flow returns
  // `skipped_existing` for both episodes and assigns nothing, so the customer
  // sees a successful-looking action that changed no dates at all.
  const slug = await registryOnlyProject()
  const first = await acceptedEpisode(slug)
  const second = await acceptedEpisode(slug)
  const { id: planId } = await relayoutPlan(slug)

  // Both already hold FUTURE claims — precisely what the plan flow treats as
  // untouchable, and the state the customer could not correct.
  const staleFirst = '2027-05-03T12:00:00.000Z'
  const staleSecond = '2027-05-04T12:00:00.000Z'
  await uploadPlans.writeItemSchedule(slug, {
    [first.episodeCode]: staleFirst,
    [second.episodeCode]: staleSecond,
  })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const body = {
    plan_id: planId, expected_channel_id: CHANNEL,
    // Deliberately reversed: click order must never decide who gets the first slot.
    episode_codes: [second.episodeCode, first.episodeCode],
    start_date: '2027-06-01',
  }
  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/preview`).send(body)
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.ordered_episode_codes, [first.episodeCode, second.episodeCode])
  assert.deepEqual(preview.body.assignments, [
    { episode_code: first.episodeCode, publishAt: '2027-06-01T12:00:00.000Z', previous_publish_at: staleFirst },
    { episode_code: second.episodeCode, publishAt: '2027-06-02T12:00:00.000Z', previous_publish_at: staleSecond },
  ], 'each row must carry what it is changing FROM, or the customer cannot tell what moved')
  assert.deepEqual(preview.body.skipped, [])
  assert.deepEqual(preview.body.occupied_days, [], 'the episodes being moved do not occupy their own slots')

  const saved = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/apply`)
    .send({ ...body, confirm: true, expected_assignments: preview.body.assignments })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const schedule = await uploadPlans.readItemSchedule(slug)
  assert.equal(schedule[first.episodeCode], '2027-06-01T12:00:00.000Z')
  assert.equal(schedule[second.episodeCode], '2027-06-02T12:00:00.000Z')
  assert.equal(fake.calls.length, 0, 're-dating planned episodes is local-only and costs no YouTube quota')
})

test('re-lay steps over a day another episode already holds and names that day', async () => {
  // Break caught: assigning the cadence blindly double-books the held day, and
  // the customer only discovers it when two videos publish at once.
  const slug = await registryOnlyProject()
  const moved = await acceptedEpisode(slug)
  const alsoMoved = await acceptedEpisode(slug)
  const holder = await acceptedEpisode(slug)
  const { id: planId } = await relayoutPlan(slug)

  const heldDay = '2027-06-02T12:00:00.000Z'
  await uploadPlans.writeItemSchedule(slug, { [holder.episodeCode]: heldDay })

  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/preview`).send({
    plan_id: planId, expected_channel_id: CHANNEL,
    episode_codes: [moved.episodeCode, alsoMoved.episodeCode],
    start_date: '2027-06-01',
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.occupied_days, ['2027-06-02'],
    'the preview must name the day it stepped over, not just work around it silently')
  assert.deepEqual(preview.body.assignments.map((a: any) => a.publishAt), [
    '2027-06-01T12:00:00.000Z',
    '2027-06-03T12:00:00.000Z',
  ], 'the blocked day is skipped, never handed to two episodes')

  const saved = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/apply`)
    .send({
      plan_id: planId, expected_channel_id: CHANNEL,
      episode_codes: [moved.episodeCode, alsoMoved.episodeCode],
      start_date: '2027-06-01',
      confirm: true, expected_assignments: preview.body.assignments,
    })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const schedule = await uploadPlans.readItemSchedule(slug)
  assert.equal(schedule[holder.episodeCode], heldDay, 'an unselected episode keeps the slot it holds')
  assert.equal(schedule[moved.episodeCode], '2027-06-01T12:00:00.000Z')
  assert.equal(schedule[alsoMoved.episodeCode], '2027-06-03T12:00:00.000Z')
})

test('re-lay reports an episode already on YouTube instead of re-dating it', async () => {
  // Break caught: writing a new local date over a video that already exists on
  // the channel makes the row and YouTube disagree, and the local date is the
  // one that loses — the customer would be told a publish time that is not real.
  const slug = await registryOnlyProject()
  const localOnly = await acceptedEpisode(slug)
  const onYouTube = await acceptedEpisode(slug)
  await acceptedOperation(slug, onYouTube.episodeCode, 'existing-video')
  const { id: planId } = await relayoutPlan(slug)

  const realDate = '2027-05-03T12:00:00.000Z'
  await uploadPlans.writeItemSchedule(slug, { [onYouTube.episodeCode]: realDate })

  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/preview`).send({
    plan_id: planId, expected_channel_id: CHANNEL,
    episode_codes: [localOnly.episodeCode, onYouTube.episodeCode],
    start_date: '2027-06-01',
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.assignments.map((a: any) => a.episode_code), [localOnly.episodeCode])
  assert.deepEqual(preview.body.skipped.map((s: any) => s.episode_code), [onYouTube.episodeCode])
  assert.match(preview.body.skipped[0].reason, /already exists on YouTube/)

  const saved = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/apply`)
    .send({
      plan_id: planId, expected_channel_id: CHANNEL,
      episode_codes: [localOnly.episodeCode, onYouTube.episodeCode],
      start_date: '2027-06-01',
      confirm: true, expected_assignments: preview.body.assignments,
    })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const schedule = await uploadPlans.readItemSchedule(slug)
  assert.equal(schedule[onYouTube.episodeCode], realDate, 'the YouTube video keeps the date its own schedule owns')
  assert.equal(schedule[localOnly.episodeCode], '2027-06-01T12:00:00.000Z')
  assert.equal(fake.calls.length, 0, 'a skipped remote video is never written to YouTube by this action')
})

test('re-lay refuses a preview whose dates changed after review', async () => {
  // Break caught: applying stale assignments silently moves an episode onto a
  // day a different episode claimed between preview and save.
  const slug = await registryOnlyProject()
  const first = await acceptedEpisode(slug)
  const second = await acceptedEpisode(slug)
  const newcomer = await acceptedEpisode(slug)
  const { id: planId } = await relayoutPlan(slug)

  await uploadPlans.writeItemSchedule(slug, {
    [first.episodeCode]: '2027-05-03T12:00:00.000Z',
    [second.episodeCode]: '2027-05-04T12:00:00.000Z',
  })
  const request1 = {
    plan_id: planId, expected_channel_id: CHANNEL,
    episode_codes: [first.episodeCode, second.episodeCode],
    start_date: '2027-06-01',
  }
  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/preview`).send(request1)
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.assignments[0].publishAt, '2027-06-01T12:00:00.000Z')

  // Someone else takes the slot the preview handed to `first`.
  await uploadPlans.writeItemSchedule(slug, {
    [first.episodeCode]: '2027-05-03T12:00:00.000Z',
    [second.episodeCode]: '2027-05-04T12:00:00.000Z',
    [newcomer.episodeCode]: '2027-06-01T12:00:00.000Z',
  })
  const fake = new FakeYouTube()
  __setYouTubeTransportForTests(fake.transport())
  const stale = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/apply`)
    .send({ ...request1, confirm: true, expected_assignments: preview.body.assignments })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'YOUTUBE_PLAN_PREVIEW_STALE')
  assert.deepEqual(stale.body.occupied_days, ['2027-06-01'], 'the refreshed preview shows the newly held day')

  const schedule = await uploadPlans.readItemSchedule(slug)
  assert.equal(schedule[first.episodeCode], '2027-05-03T12:00:00.000Z', 'a refused save changes nothing')
  assert.equal(fake.calls.length, 0)
})

test('re-lay saves an empty result rather than inventing dates when nothing is movable', async () => {
  // Break caught: falling through to the shortfall check with zero movable
  // episodes would throw "cannot fit 0 videos", turning a no-op into an error.
  const slug = await registryOnlyProject()
  const onYouTube = await acceptedEpisode(slug)
  await acceptedOperation(slug, onYouTube.episodeCode, 'existing-video')
  const { id: planId } = await relayoutPlan(slug)

  const preview = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/preview`).send({
    plan_id: planId, expected_channel_id: CHANNEL,
    episode_codes: [onYouTube.episodeCode],
    start_date: '2027-06-01',
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.assignments, [])
  assert.equal(preview.body.skipped.length, 1)

  const saved = await request(app).post(`/api/projects/${slug}/youtube/plan/relayout/apply`)
    .send({
      plan_id: planId, expected_channel_id: CHANNEL,
      episode_codes: [onYouTube.episodeCode],
      start_date: '2027-06-01',
      confirm: true, expected_assignments: [],
    })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual(saved.body.assignments, [])
})

// ── owner decision #7: duplicate episode code across projects ─────────────
//
// `video-claims.json` is the only cross-project record, and a channel can move
// from one project to another (assignments are exclusive at any moment, so this
// is the reachable route to the collision). The owner asked for a warning the
// customer can click through — never a 409 refusal, because two series may
// legitimately share one channel and both have an "Episode 1".

async function writeForeignClaim(episodeCode: string): Promise<void> {
  const claimsPath = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'youtube', 'video-claims.json')
  await fs.mkdir(path.dirname(claimsPath), { recursive: true })
  await fs.writeFile(claimsPath, JSON.stringify({
    schema_version: 2,
    claims: [{
      channel_id: CHANNEL, video_id: 'foreign-video', project_slug: 'another-series',
      operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', episode_code: episodeCode,
    }],
  }))
}

test('another project\'s episode code on this channel warns confirmably, and the click-through releases it', async () => {
  const slug = await project(true)
  await writeForeignClaim('EP0001')
  const body = { episode_code: 'EP0001', confirm: true, expected_channel_id: CHANNEL }

  const warned = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(warned.status, 409, JSON.stringify(warned.body))
  assert.equal(warned.body.code, 'YOUTUBE_EPISODE_CODE_CLAIMED_ELSEWHERE')
  assert.equal(warned.body.confirmable, true,
    'the owner asked for a warning that can be clicked through — a plain refusal is the defect, not the fix')
  assert.equal(warned.body.foreign_project_slug, 'another-series')
  assert.match(String(warned.body.detail), /another-series/)

  // Clicked through: the SAME request now passes this gate and stops at the next
  // one (this fixture has metadata but no rendered video). Asserting the NEXT
  // refusal — not merely "not this one" — proves the acknowledgement released
  // the warning rather than the warning having been skipped.
  const passed = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ ...body, acknowledge_foreign_episode: true })
  assert.equal(passed.status, 409, JSON.stringify(passed.body))
  assert.equal(passed.body.code, 'YOUTUBE_NO_RENDERED_VIDEO')
})

test('a different episode code on the same channel is not warned about', async () => {
  const slug = await project(true)
  await writeForeignClaim('EP0001')
  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ episode_code: 'EP0002', confirm: true, expected_channel_id: CHANNEL })
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'YOUTUBE_NO_RENDERED_VIDEO',
    'another series using a different episode number is exactly the legitimate case')
})

// ── 1.4.300 safety checks on the Upload route: Block refuses as above; Off/Warn let the upload go ──

const setSafety = (slug: string, id: string, mode: 'off' | 'warn' | 'block') =>
  pm.updateConfig(slug, { safety_checks: { [id]: mode } } as any)

test('episode number claim Off uploads without asking; Block refuses even when confirmed', async () => {
  const slug = await project(true)
  await writeForeignClaim('EP0001')
  const body = { episode_code: 'EP0001', confirm: true, expected_channel_id: CHANNEL }

  await setSafety(slug, 'episode_number_claim', 'off')
  const off = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(off.body.code, 'YOUTUBE_NO_RENDERED_VIDEO', 'Off: no question, straight on to the next gate')

  await setSafety(slug, 'episode_number_claim', 'block')
  const blocked = await request(app).post(`/api/projects/${slug}/youtube/upload`).send({ ...body, acknowledge_foreign_episode: true })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'YOUTUBE_EPISODE_CODE_CLAIMED_ELSEWHERE_BLOCKED')
  assert.equal(blocked.body.confirmable, false)
})

test('right channel Warn: a channel changed after preview uploads to the channel assigned now, logged on the job', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  const body = await confirmedUploadBody(slug, episodeCode)
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-after-preview', title: 'After Preview', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'after-access', refresh_token: 'after-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({ project_slug: slug, channel_id: 'UC-after-preview', expected_previous_channel_id: CHANNEL })
  await setSafety(slug, 'right_channel', 'warn')

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.channel_id, 'UC-after-preview')
  const queued = jobQueue.getJob(res.body.job_id)
  assert.equal(queued?.params?.expected_channel_id, 'UC-after-preview')
  assert.equal(queued?.params?.safety_warnings?.[0]?.check, 'right_channel')
  await removeQueuedTestJob(slug, res.body.job_id)
})

test('reviewed and unchanged Off: details changed after preview upload as they are now', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const body = await confirmedUploadBody(slug, episodeCode)
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'Changed after preview', description: 'A keeper counts the nights.', tags: ['x'],
  }))
  await setSafety(slug, 'reviewed_unchanged', 'off')

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const queued = jobQueue.getJob(res.body.job_id)
  assert.equal(JSON.parse(queued?.params?.approved_final_payload?.snippet_json).title, 'Changed after preview')
  assert.equal(queued?.params?.privacy_status, 'private', 'the privacy is still the one chosen')
  await removeQueuedTestJob(slug, res.body.job_id)
})

// ── The final check gate (2026-10-19, lib/final-video-check.ts) ──────────────────────────────────
//
// The finished file is measured at the end of Video Assembly and the verdict is stored beside it.
// These two tests are the upload side: the refusal, the owner's click-through, staleness, and the
// channel's own Off / Block setting.

test('a finished video that failed its final check cannot be uploaded until the owner says so', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  // `uploadReadyProject` writes a placeholder; the check really probes the file, so put a real one
  // there before the preview hashes it.
  await fs.writeFile(videoPath, tinyVideoBytes())
  const body = await confirmedUploadBody(slug, episodeCode)

  // A verdict from Video Assembly that the plan was missed by a minute. The check itself is fine —
  // this is the same measurement the render runs, on the file the upload would send.
  const failed = await runFinalCheck(videoPath, {
    planned_sec: 60, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null,
  })
  assert.equal(failed.passed, false, 'a one-second file cannot be a sixty-second plan')
  await storeFinalCheck(videoPath, failed)

  const refused = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'YOUTUBE_FINAL_CHECK_FAILED')
  assert.equal(refused.body.confirmable, true)
  assert.match(refused.body.detail, /add up to 60\.0s/)
  assert.equal(refused.body.job_id, undefined, 'nothing is queued before the question is answered')
  assert.equal(refused.body.final_check.passed, false)

  // "Upload anyway" resends the SAME body with the acknowledgement, and the job records the answer.
  const clickedThrough = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ ...body, acknowledge_final_check: true })
  assert.equal(clickedThrough.status, 200, JSON.stringify(clickedThrough.body))
  const queued = jobQueue.getJob(clickedThrough.body.job_id)
  assert.equal(queued?.params?.safety_warnings?.[0]?.check, 'final_check')
  await removeQueuedTestJob(slug, clickedThrough.body.job_id)

  // A passing verdict, bound to these bytes, needs no acknowledgement at all.
  const passed = await runFinalCheck(videoPath, {
    planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null,
  })
  assert.equal(passed.passed, true, JSON.stringify(passed.issues))
  await storeFinalCheck(videoPath, passed)
  const allowed = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
  await removeQueuedTestJob(slug, allowed.body.job_id)

  // A re-render replaces the file, so that verdict no longer describes it and the question returns.
  await fs.appendFile(videoPath, Buffer.alloc(8))
  const stale = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'YOUTUBE_FINAL_CHECK_FAILED')
  assert.match(stale.body.detail, /changed since its final check/)
})

/** A project with a real finished video and a failed verdict stored beside it. */
async function uploadReadyProjectWithFailedCheck(): Promise<{
  slug: string, episodeCode: string, videoPath: string, body: Record<string, unknown>, checkedAt: string
}> {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  await fs.writeFile(videoPath, tinyVideoBytes())
  const body = await confirmedUploadBody(slug, episodeCode)
  const failed = await runFinalCheck(videoPath, {
    planned_sec: 60, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null,
  })
  assert.equal(failed.passed, false, 'a one-second file cannot be a sixty-second plan')
  await storeFinalCheck(videoPath, failed)
  return { slug, episodeCode, videoPath, body, checkedAt: failed.checked_at }
}

test('the row says which check it is showing, and an answer about that check uploads', async () => {
  const { slug, episodeCode, videoPath, body, checkedAt } = await uploadReadyProjectWithFailedCheck()

  const refused = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(refused.status, 409)
  const identity = refused.body.final_check.identity
  assert.equal(identity.checked_at, checkedAt)
  assert.equal(identity.file_size, (await fs.stat(videoPath)).size)
  assert.equal(identity.file_mtime_ms, (await fs.stat(videoPath)).mtimeMs)

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.deepEqual(row.final_check.identity, identity, 'the row shows the check the answer is about')

  const answered = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ ...body, acknowledge_final_check: true, final_check_checked_at: identity.checked_at })
  assert.equal(answered.status, 200, JSON.stringify(answered.body))
  await removeQueuedTestJob(slug, answered.body.job_id)
})

test('an answer about a check the file has outlived is refused; one naming no check is admitted as before', async () => {
  const { slug, videoPath, body, checkedAt } = await uploadReadyProjectWithFailedCheck()
  // The re-render replaces the file after the owner looked at the verdict.
  await fs.appendFile(videoPath, Buffer.alloc(8))

  const answered = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ ...body, acknowledge_final_check: true, final_check_checked_at: checkedAt })
  assert.equal(answered.status, 409)
  assert.equal(answered.body.code, 'YOUTUBE_FINAL_CHECK_CHANGED')
  assert.equal(answered.body.confirmable, false, 're-answering the same stale check would fail again')
  assert.equal(answered.body.job_id, undefined, 'nothing is queued on a refusal')
  assert.match(answered.body.detail, /checked again, or the file was rewritten/)

  // No identity named: exactly the answer this route has always taken.
  const unnamed = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ ...body, acknowledge_final_check: true })
  assert.equal(unnamed.status, 200, JSON.stringify(unnamed.body))
  await removeQueuedTestJob(slug, unnamed.body.job_id)
})

test('an answer about a verdict that a newer check replaced is refused too', async () => {
  const { slug, videoPath, body, checkedAt } = await uploadReadyProjectWithFailedCheck()
  // The check runs again over the same bytes: the file has not moved, the verdict has.
  const again = await runFinalCheck(videoPath, {
    planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null,
  })
  await storeFinalCheck(videoPath, again)
  assert.notEqual(again.checked_at, checkedAt, 'a second check is a different check')

  const answered = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ ...body, acknowledge_final_check: true, final_check_checked_at: checkedAt })
  assert.equal(answered.status, 409)
  assert.equal(answered.body.code, 'YOUTUBE_FINAL_CHECK_CHANGED')
})

test('a finished video with no verdict is not refused: the row says so and the check can be run on demand', async () => {
  const { slug, episodeCode } = await uploadReadyProject()
  const body = await confirmedUploadBody(slug, episodeCode)

  const res = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(res.status, 200, 'an unchecked file is not a fault; refusing here would block real work')
  await removeQueuedTestJob(slug, res.body.job_id)

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.final_check.summary, 'Final check: not run yet')
  assert.equal(row.final_check.checked, false)
  assert.equal(row.final_check.identity, null, 'no verdict, nothing to answer about')
})

test('final check Off uploads without asking; Block refuses even when the owner confirms', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  await fs.writeFile(videoPath, tinyVideoBytes())
  const body = await confirmedUploadBody(slug, episodeCode)
  const failed = await runFinalCheck(videoPath, {
    planned_sec: 60, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null,
  })
  await storeFinalCheck(videoPath, failed)

  await setSafety(slug, 'final_check', 'off')
  const off = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
  assert.equal(off.status, 200, 'Off: no question, straight on to the upload')
  await removeQueuedTestJob(slug, off.body.job_id)

  await setSafety(slug, 'final_check', 'block')
  const blocked = await request(app).post(`/api/projects/${slug}/youtube/upload`)
    .send({ ...body, acknowledge_final_check: true })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'YOUTUBE_FINAL_CHECK_FAILED')
  assert.equal(blocked.body.confirmable, false, 'Block offers no click-through')
})

test('the final check runs on demand and stores its verdict beside the finished video', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  await fs.writeFile(videoPath, tinyVideoBytes())

  const res = await request(app).post(`/api/projects/${slug}/youtube/final-check`)
    .send({ episode_code: episodeCode })
  assert.equal(res.status, 202, JSON.stringify(res.body))
  assert.equal(res.body.started, true)
  assert.equal(res.body.running, true)
  assert.equal(res.body.summary, 'Final check: checking…')

  // The verdict lands in the sidecar when the check finishes, and the row reads it back.
  const stored = await waitForValue(() => storedVerdict(videoPath), { label: 'the final-check sidecar' })
  assert.equal(stored.passed, true)
  assert.equal(stored.file.size, (await fs.stat(videoPath)).size)

  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.final_check.summary, 'Final check: passed')
  assert.equal(row.final_check.passed, true)
  assert.equal(row.final_check.running, false)
  assert.deepEqual(row.final_check.issues, [])
})

test('the stored final check is readable in full without starting another check', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  await fs.writeFile(videoPath, tinyVideoBytes())

  // Nothing measured yet: the read says which kind of "none" this is, and starts nothing. The
  // progress entry is the proof — `startFinalCheck` writes its marker before any decode does.
  const none = await request(app).get(`/api/projects/${slug}/youtube/final-check?episode_code=${episodeCode}`)
  assert.equal(none.status, 404)
  assert.equal(none.body.code, 'YOUTUBE_NO_FINAL_CHECK')
  assert.equal(none.body.detail, 'Final check: not run yet')
  assert.deepEqual(finalCheckProgress(videoPath), { running: false, error: null, interrupted: false },
    'reading the result must not start a check')

  // A real check, measured and stored the way Video Assembly stores one.
  const verdict = await runFinalCheck(videoPath, {
    planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null, speech_end_sec: 0,
  })
  await storeFinalCheck(videoPath, verdict)

  const read = await request(app).get(`/api/projects/${slug}/youtube/final-check?episode_code=${episodeCode}`)
  assert.equal(read.status, 200, JSON.stringify(read.body))
  assert.equal(read.body.episode_code, episodeCode)
  assert.equal(read.body.running, false)
  assert.equal(read.body.stale, false)
  assert.equal(read.body.identity.checked_at, verdict.checked_at)
  assert.equal(read.body.identity.file_size, verdict.file.size)
  // The whole sidecar, not the row's reduced projection: what the render was asked to produce
  // (expected), what the file actually measured (actual), and the issues in their own words.
  assert.deepEqual(read.body.result, await storedVerdict(videoPath))
  assert.deepEqual(read.body.result.expected, verdict.expected)
  assert.ok(read.body.result.actual, 'the measured values are the point of this route')
  assert.equal(read.body.result.actual.duration_sec, verdict.actual.duration_sec)
  // Still nothing measuring it: a read is a read.
  assert.equal(finalCheckProgress(videoPath).running, false)

  const noEpisode = await request(app).get(`/api/projects/${slug}/youtube/final-check`)
  assert.equal(noEpisode.status, 400)
})

test('the final check reads the speech end from the episode Scene Plan when the file carries no plan', async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  const videoPath = path.join(paths.video_dir, `${episodeCode}_final_video.mp4`)
  await fs.writeFile(videoPath, tinyVideoBytes())
  // A final rendered before the final-check sidecar existed has no plan of its own, and the
  // episode's Scene Plan is the only thing that knows where its narration stopped (EP0006's own
  // numbers: merged narration 9143.984 s, last stitched cue 9143.941 s).
  await fs.writeFile(path.join(paths.episode_dir, 'scene_plan.json'), JSON.stringify({
    source_merged_audio: { duration_sec: 9143.984 },
    source_timeline: { last_cue_end_sec: 9143.941 },
    total_duration_sec: 9143.983605,
  }))

  const res = await request(app).post(`/api/projects/${slug}/youtube/final-check`)
    .send({ episode_code: episodeCode })
  assert.equal(res.status, 202, JSON.stringify(res.body))

  const stored = await waitForValue(() => storedVerdict(videoPath), { label: 'the final-check sidecar' })
  assert.equal(stored.expected.speech_end_sec, 9143.984, 'the verdict measures against it on every re-check')
})

/**
 * A stored verdict is evidence about the bytes it measured and about no others.
 *
 * File A's verdict carries A's own tail length and A's own intro. Once B has replaced A at the same
 * path, `readStoredFinalCheck` still returns it and reports it `stale` — it is the only thing that
 * knows the file it measured is gone. Spreading it into this check's expectation measured B against
 * A's plan, and its echoed `frozen_at` skipped the fresh resolution that would have answered for B
 * (2026-10-20).
 */
const A_VERDICT_INTRO = '/assets/story-sprout-intro.mp4'
const A_VERDICT_FROZEN_AT = '2026-01-01T00:00:00.000Z'

/** File A's own plan-less verdict: a check that measured A's 6015 s tail and A's branded intro. */
async function storeShapeBearingVerdict(videoPath: string): Promise<void> {
  await fs.writeFile(`${videoPath}.finalcheck.json`, JSON.stringify(await fakeVerdict(videoPath, {
    planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null,
    after_narration_sec: 6015,
    intro: { asset: A_VERDICT_INTRO, window: { start_sec: 0, end_sec: 9.6 }, black: [] },
    frozen_at: A_VERDICT_FROZEN_AT,
  })))
}

/** Start the on-demand check and hand back the expectation it was asked to measure against. */
async function measuredExpectation(slug: string, episodeCode: string): Promise<any> {
  let measured: any = null
  __setFinalCheckRunnerForTests(async (file, expected) => { measured = expected; return fakeVerdict(file, expected) })
  const res = await request(app).post(`/api/projects/${slug}/youtube/final-check`)
    .send({ episode_code: episodeCode })
  assert.equal(res.status, 202, JSON.stringify(res.body))
  await waitFor(() => measured !== null, { label: 'the final check to start measuring' })
  return measured
}

test("the on-demand check never measures a rewritten final against the verdict it has outlived", async () => {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  await fs.writeFile(videoPath, tinyVideoBytes())
  await storeShapeBearingVerdict(videoPath)

  // File B replaces A at the same path, and no fresh verdict replaces A's — the render whose own
  // check could not run, or an import over the canonical final.
  await fs.appendFile(videoPath, Buffer.alloc(8))

  const measured = await measuredExpectation(slug, episodeCode)

  assert.notEqual(measured.after_narration_sec, 6015, "file A's tail is not certified for B")
  assert.notEqual(measured.intro?.asset, A_VERDICT_INTRO, "file A's intro is not certified for B")
  assert.notEqual(measured.frozen_at, A_VERDICT_FROZEN_AT, "nor is A's freeze stamp")
})

test('a verdict that still describes the file is still the plan the on-demand check measures against', async () => {
  // The other half of the rule: the stale test must not become a blanket waiver for old finals.
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  await fs.writeFile(videoPath, tinyVideoBytes())
  await storeShapeBearingVerdict(videoPath)

  const measured = await measuredExpectation(slug, episodeCode)

  assert.equal(measured.after_narration_sec, 6015, "the verdict's own recorded tail")
  assert.equal(measured.intro?.asset, A_VERDICT_INTRO)
  assert.equal(measured.frozen_at, A_VERDICT_FROZEN_AT)
})

/** The verdict beside a file, or null when the check has not written one yet. */
async function storedVerdict(videoPath: string): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(`${videoPath}.finalcheck.json`, 'utf-8'))
  } catch {
    return null
  }
}

/** A verdict shaped like the real one, so a test can finish a check without decoding a video. */
async function fakeVerdict(videoPath: string, expected: any, passed = true): Promise<any> {
  const stat = await fs.stat(videoPath)
  return {
    checked_at: new Date().toISOString(),
    file: { size: stat.size, mtime_ms: stat.mtimeMs },
    expected,
    actual: {
      duration_sec: 8, video_sec: 8, audio_sec: 8, width: 320, height: 180,
      tail_lufs: null, black: [], silence: [],
    },
    passed,
    issues: passed ? [] : [{ check: 'silence', verdict: 'there is a 5.0s silence at 1:00, inside the speech' }],
  }
}

/** A real finished video and the path the route will resolve for it. */
async function readyVideo(): Promise<{ slug: string, episodeCode: string, videoPath: string }> {
  const { slug, episodeCode, title } = await uploadReadyProject()
  const videoPath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  await fs.writeFile(videoPath, tinyVideoBytes())
  return { slug, episodeCode, videoPath }
}

/**
 * A POST that must answer without waiting for the check it starts.
 *
 * `waitFor` rather than `await request(...)`: run inline — which is how this route shipped — the
 * request does not fail, it simply never answers until the decode is done, so the assertion has to
 * be "the answer arrived while the check is still parked" and the failure has to be a named
 * timeout rather than a suite that hangs.
 */
async function postFinalCheck(slug: string, episodeCode: string): Promise<any> {
  let answered: any = null
  void request(app).post(`/api/projects/${slug}/youtube/final-check`)
    .send({ episode_code: episodeCode })
    .then(response => { answered = response })
  await waitFor(() => answered !== null, {
    label: 'the final-check POST to answer without waiting for the check it starts',
  })
  return answered
}

test('a final check that outlives the request still finishes and stores its verdict', async () => {
  const { slug, episodeCode, videoPath } = await readyVideo()

  // The measurement is parked, so the request cannot be waiting for it. Run inline — which is how
  // this route shipped — the POST stayed open for the whole decode (5–8 minutes on a 2–2.5 h final)
  // and any restart, app update or dropped socket in between threw the measurement away
  // (Night Atlas Mythology EP0008, 2026-10-19: the 1.4.331 install quit the app 8m23s in, and the
  // row still reads `checked: false, identity: null`).
  let release!: () => void
  const parked = new Promise<void>(resolve => { release = resolve })
  let measured = 0
  __setFinalCheckRunnerForTests(async (file: string, expected: any) => {
    measured += 1
    await parked
    return fakeVerdict(file, expected)
  })

  const res = await postFinalCheck(slug, episodeCode)
  assert.equal(res.status, 202, JSON.stringify(res.body))
  assert.equal(res.body.started, true)
  assert.equal(res.body.running, true)
  assert.equal(res.body.passed, undefined, 'the answer carries no verdict — there is not one yet')
  assert.equal(measured, 1, 'the check is running')

  // The row the page already loads is where the progress and the result are read.
  const during = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const duringRow = during.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(duringRow.final_check.running, true)
  assert.equal(duringRow.final_check.checked, false)
  assert.equal(duringRow.final_check.summary, 'Final check: checking…')

  release()
  await waitFor(async () => (await storedVerdict(videoPath)) !== null, { label: 'the parked check to store its verdict' })

  const after = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const afterRow = after.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(afterRow.final_check.running, false)
  assert.equal(afterRow.final_check.checked, true)
  assert.equal(afterRow.final_check.summary, 'Final check: passed')
  assert.ok(afterRow.final_check.identity?.checked_at, 'the verdict is bound to the file it measured')
})

test('a second request for a file already being measured joins it instead of decoding it twice', async () => {
  const { slug, episodeCode, videoPath } = await readyVideo()

  let release!: () => void
  const parked = new Promise<void>(resolve => { release = resolve })
  let measured = 0
  __setFinalCheckRunnerForTests(async (file: string, expected: any) => {
    measured += 1
    await parked
    return fakeVerdict(file, expected)
  })

  const first = await postFinalCheck(slug, episodeCode)
  assert.equal(first.body.started, true)

  const second = await postFinalCheck(slug, episodeCode)
  assert.equal(second.status, 202)
  assert.equal(second.body.started, false, 'the second request joined the run in progress')
  assert.equal(second.body.running, true)
  assert.equal(measured, 1, 'one decode of the same bytes, not two')

  release()
  await waitFor(async () => (await storedVerdict(videoPath)) !== null, { label: 'the joined check to store its verdict' })
})

test('a check that could not run says so on the row instead of reading "not run yet"', async () => {
  const { slug, episodeCode, videoPath } = await readyVideo()
  __setFinalCheckRunnerForTests(async () => { throw new Error('FFmpeg exited with code 1') })

  const res = await request(app).post(`/api/projects/${slug}/youtube/final-check`)
    .send({ episode_code: episodeCode })
  assert.equal(res.status, 202, JSON.stringify(res.body))

  await waitFor(() => finalCheckProgress(videoPath).error !== null, { label: 'the failed check to record why' })
  const listed = await request(app).get(`/api/projects/${slug}/youtube/publishable`)
  const row = listed.body.episodes.find((entry: any) => entry.episode_code === episodeCode)
  assert.equal(row.final_check.running, false)
  assert.equal(row.final_check.checked, false)
  assert.match(row.final_check.summary, /could not run — FFmpeg exited with code 1/)
})

test('the final check refuses an episode with no rendered video instead of inventing a verdict', async () => {
  const slug = await registryOnlyProject()
  const { episodeCode } = await acceptedEpisode(slug)
  const res = await request(app).post(`/api/projects/${slug}/youtube/final-check`)
    .send({ episode_code: episodeCode })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'YOUTUBE_NO_RENDERED_VIDEO')
})
