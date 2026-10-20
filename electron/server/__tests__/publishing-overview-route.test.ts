/**
 * The global Publishing Overview route.
 *
 * It must be a read: no body, no provider call, and a shape the page can trust.
 * The plan-less channel case is asserted here too, because the route is where
 * an empty answer has to keep meaning exactly one thing.
 *
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { afterEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const connections = await import('../services/youtube-connection-store.js')
const store = await import('../services/youtube-project-publishing-store.js')
const operations = await import('../services/youtube-operation-store.js')
const sidecars = await import('../services/upload-sidecar.js')
const jobQueue = await import('../services/job-queue.js')
const overviewService = await import('../services/publishing-overview.js')
const { router } = await import('../routes/publishing-overview.js')
// The Publish page's own list, so a parity test can ask BOTH surfaces the same
// question instead of trusting the overview's copy of the predicate.
const { router: uploadRouter } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)
app.use('/api', uploadRouter)

let tmp: { dir: string; cleanup: () => Promise<void> } | undefined
afterEach(async () => { await tmp?.cleanup(); tmp = undefined })

const CHANNEL = 'UC-pub-route'
/** A publishAt YouTube itself reported for a video it is still processing. */
const PUBLISH_AT = '2026-10-20T15:00:00Z'

/** A channel that is ASSIGNED and CONNECTED, so the confirmed half is reachable. */
async function connectedProject(name: string, prefix: string) {
  const created = await pm.createProject({ name, episode_prefix: prefix })
  await connections.configureYouTubeApplication({ client_id: 'po-route-client', client_secret: 'po-route-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Route Publishing Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'po-route-access', refresh_token: 'po-route-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created
}

/** An accepted episode with a finished, admissible final video. */
async function acceptedEpisode(slug: string, code: string, title: string): Promise<void> {
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'l', themes: ['t'], suggested_chapters: 3, suggested_length: '10 min', mood: 'm',
  }], 'test-model')
  await im.promoteToAccepted(slug, idea!.id, { episode_code: code })
  const paths = await (await import('../services/utils.js')).resolveEpisodePaths(slug, code, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(`${paths.video_dir}/${code}_final_video.mp4`, Buffer.alloc(2048, 1))
}

test('GET /api/publishing/overview reports every channel and a plan-less channel honestly', async () => {
  tmp = await useTempDataDir()
  await pm.createProject({ name: 'Route Channel', episode_prefix: 'RP' })

  const res = await request(app).get('/api/publishing/overview')

  assert.equal(res.status, 200)
  assert.equal(typeof res.body.generated_at, 'string')
  assert.equal(typeof res.body.cache_ttl_ms, 'number')
  assert.ok(Array.isArray(res.body.channels))
  assert.ok(Array.isArray(res.body.calendar))
  assert.equal(res.body.channels.length, 1)

  const channel = res.body.channels[0]
  assert.equal(channel.slug, 'route-channel')
  assert.equal(channel.plan_set, false)
  assert.equal(channel.confirmed.freshness, 'unknown')
  assert.equal(channel.confirmed.error, 'no_channel_assigned')
  assert.equal(channel.coverage.at_risk, false)
  assert.match(channel.next_action.url, /^\/projects\/route-channel\//)
})

test('an unreadable plan is reported as unreadable, and does not fail the whole route', async () => {
  tmp = await useTempDataDir()
  const created = await pm.createProject({ name: 'Route Corrupt', episode_prefix: 'RC' })
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/config.json`, '{ not json')

  const res = await request(app).get('/api/publishing/overview')

  // One channel's broken plan must not turn the fleet view into a 500.
  assert.equal(res.status, 200)
  const channel = res.body.channels[0]
  assert.equal(channel.plan_set, null)
  assert.equal(typeof channel.plan_error, 'string')
})

test('a corrupt idea store reaches the client as unknown, never a confident 0', async () => {
  tmp = await useTempDataDir()
  const created = await pm.createProject({ name: 'Route Ideas', episode_prefix: 'RI' })

  // Readable and genuinely empty: a real 0 travels as a 0.
  let res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  assert.equal(res.body.channels[0].readiness.episodes, 0)
  assert.equal(res.body.channels[0].readiness.ready_to_publish, 0)
  assert.equal(res.body.channels[0].readiness.error, undefined)

  // Unparseable: unknown, with a reason — and still a 200, not a 500.
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/ideas.json`, '{ not json')
  // The overview is cached for a minute. This corruption was written by hand,
  // so no product write path announced it; a real one would have (see
  // publishing-overview-cache.test.ts). Drop it the way that write would.
  overviewService.invalidatePublishingOverviewCache()
  res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  const channel = res.body.channels[0]
  // null, not a missing field: a dropped key would serialize the same as
  // "no answer" and the page would render a blank, which is the defect.
  assert.equal(channel.readiness.episodes, null)
  assert.equal(channel.readiness.episodes_with_code, null)
  assert.equal(channel.readiness.ready_to_publish, null)
  assert.equal(channel.readiness.in_progress, null)
  assert.equal(channel.coverage.ready_video_count, null)
  assert.equal(typeof channel.readiness.error, 'string')
  assert.deepEqual(channel.recommendations, [])
})

test('a failed YouTube link read is unknown through the route, with no publish recommendation', async () => {
  tmp = await useTempDataDir()
  const created = await connectedProject('Route Links', 'RL')
  await acceptedEpisode(created.slug, 'RL0001', 'Already On YouTube')
  await acceptedEpisode(created.slug, 'RL0002', 'Finished Locally')
  await store.linkYouTubeEpisodeVideo({
    project_slug: created.slug, episode_code: 'RL0001', channel_id: CHANNEL,
    video_id: 'vid-route-linked', source: 'upload', decided_at: new Date().toISOString(),
  })

  // Baseline: the linked episode is not offered; the finished unlinked one is.
  let res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  assert.equal(res.body.channels[0].readiness.on_youtube, 1)
  assert.equal(res.body.channels[0].readiness.ready_to_publish, 1)
  assert.deepEqual(res.body.channels[0].recommendations.map((r: any) => r.episode_code), ['RL0002'])

  // The link read now fails: neither the count nor the publish claim can stand.
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/youtube/project-state.json`, '{ not json')
  // Hand-written corruption, so nothing announced a write: drop the cached
  // sweep the way the deliberate refresh would.
  overviewService.invalidatePublishingOverviewCache()
  res = await request(app).get('/api/publishing/overview')
  assert.equal(res.status, 200)
  const channel = res.body.channels[0]
  assert.equal(channel.readiness.on_youtube, null)
  assert.equal(channel.readiness.ready_to_publish, null)
  assert.equal(channel.coverage.ready_video_count, null)
  assert.equal(typeof channel.readiness.error, 'string')
  assert.deepEqual(channel.recommendations, [])
  assert.equal(JSON.stringify(channel.recommendations).includes('not on YouTube yet'), false)
})

test('operation-record and legacy-sidecar evidence excludes an episode from ready counts, matching /youtube/publishable', async () => {
  tmp = await useTempDataDir()
  const created = await connectedProject('Remote Evidence', 'RE')
  await acceptedEpisode(created.slug, 'RE0001', 'Operation Only')
  await acceptedEpisode(created.slug, 'RE0002', 'Sidecar Only')
  await acceptedEpisode(created.slug, 'RE0003', 'Never Uploaded')

  // RE0001: an accepted operation record carries the video id, but the episode
  // link is deliberately absent. The two stores are written independently, so
  // the overview must not treat "no link" as "never uploaded".
  const operation = await operations.createYouTubeOperation({
    project_slug: created.slug, episode_code: 'RE0001', channel_id: CHANNEL,
    source_revision: 'src-RE0001', metadata_revision: 'meta-RE0001',
    origin: 'manual', final_action: 'manual_upload',
  })
  await operations.acceptYouTubeOperation({
    project_slug: created.slug, operation_id: operation.operation_id,
    expected_revision: operation.revision, channel_id: CHANNEL,
    video_id: 'vid-operation-only', accepted_at: '2026-10-01T00:00:00.000Z',
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'a'.repeat(64) },
  })
  // Accept writes the episode link too; drop it so the durable operation record
  // is the ONLY trace of this upload — the reported shape where the link write
  // was lost and the record survived.
  const statePath = `${pm.projectsRoot()}/${created.slug}/youtube/project-state.json`
  const state = JSON.parse(await fs.readFile(statePath, 'utf-8'))
  delete state.episode_video_links.RE0001
  await fs.writeFile(statePath, JSON.stringify(state))

  // RE0002: published before v1.5.0, so only the legacy sidecar knows it.
  await sidecars.writeSidecar(created.slug, 'RE0002', 'Sidecar Only', {
    platform: 'youtube', video_id: 'vid-sidecar-only', account_id: 'old-account',
    channel_id: CHANNEL, uploaded_at: '2026-09-01T00:00:00.000Z', last_sync_at: '',
    scheduled_for: null, privacy_status: 'private', title: 'Sidecar Only',
    description: '', tags: [], thumbnail_set: true,
  })

  const overview = await request(app).get('/api/publishing/overview')
  assert.equal(overview.status, 200)
  const channel = overview.body.channels[0]
  assert.equal(channel.readiness.ready_unknown, 0)
  assert.equal(channel.readiness.ready_to_publish, 1)
  assert.equal(channel.coverage.ready_video_count, 1)
  // on_youtube counts the SAME episodes the Publish page knows have a video —
  // an operation record and a legacy sidecar are both authoritative evidence,
  // and counting only `episode_video_links` reported 2 where 62 were known
  // (Story Sprout) or 39 where 200 were (TerraNash).
  assert.equal(channel.readiness.on_youtube, 2)
  // Only the episode with NO remote evidence anywhere may be recommended.
  assert.deepEqual(channel.recommendations.map((r: any) => r.episode_code), ['RE0003'])
  assert.equal(channel.recommendations.some((r: any) => r.episode_code === 'RE0001'), false)
  assert.equal(channel.recommendations.some((r: any) => r.episode_code === 'RE0002'), false)

  // The Publish page's own list, through its actual route: both episodes are
  // already on YouTube and neither is offered for upload.
  const publishable = await request(app).get(`/api/projects/${created.slug}/youtube/publishable`)
  assert.equal(publishable.status, 200)
  const rows: any[] = publishable.body.episodes
  const rowFor = (code: string) => rows.find((row: any) => row.episode_code === code)
  assert.equal(rowFor('RE0001').has_remote_video, true)
  assert.equal(rowFor('RE0001').remote_source, 'operation_record')
  assert.match(rowFor('RE0001').blocked_reason, /already on YouTube/)
  assert.equal(rowFor('RE0002').has_remote_video, true)
  assert.equal(rowFor('RE0002').remote_source, 'legacy_sidecar')
  assert.match(rowFor('RE0002').blocked_reason, /already on YouTube/)
  assert.equal(rowFor('RE0003').has_remote_video, false)
  assert.doesNotMatch(String(rowFor('RE0003').blocked_reason || ''), /already on YouTube/)

  // Parity: the ready recommendations are exactly the publishable rows that
  // have a finished video and no authoritative remote copy — one predicate,
  // two surfaces, so they cannot drift apart again.
  assert.deepEqual(
    rows
      .filter((row: any) => row.has_video && !row.has_remote_video)
      .map((row: any) => row.episode_code),
    channel.recommendations
      .filter((r: any) => r.kind === 'ready_to_publish')
      .map((r: any) => r.episode_code),
  )
  // …and the on_youtube total is the same episodes the Publish page shows with
  // a remote video id.
  assert.equal(rows.filter((row: any) => !!row.remote_video_id).length, channel.readiness.on_youtube)
})

test('an episode whose upload is under way counts as in_progress, never ready — matching the publishable route', async () => {
  tmp = await useTempDataDir()
  const created = await connectedProject('Upload In Flight', 'UF')
  await acceptedEpisode(created.slug, 'UF0001', 'Queued Upload')
  await acceptedEpisode(created.slug, 'UF0002', 'Uploading Now')
  await acceptedEpisode(created.slug, 'UF0003', 'Never Uploaded')

  // UF0001: a queued upload job — the Publish page's own `local.upload.state:
  // queued`. Inserted through the queue's test seam so no executor starts.
  const queued = jobQueue.enqueuePreparedForTest({
    project_slug: created.slug,
    type: 'youtube_upload',
    episode_id: 'UF0001',
    title: 'Queued Upload',
    params: { expected_channel_id: CHANNEL },
    episode_recovery_job_id: `publishing-overview-${Date.now()}`,
  })
  try {
    // UF0002: an operation record in an open, non-terminal lifecycle with no
    // video id yet — an upload under way that the queue row no longer shows.
    await operations.createYouTubeOperation({
      project_slug: created.slug, episode_code: 'UF0002', channel_id: CHANNEL,
      source_revision: 'src-UF0002', metadata_revision: 'meta-UF0002',
      origin: 'manual', final_action: 'manual_upload',
    })

    const overview = await request(app).get('/api/publishing/overview')
    assert.equal(overview.status, 200)
    const channel = overview.body.channels[0]
    // Both in-flight shapes are IN PROGRESS…
    assert.equal(channel.readiness.in_progress, 2)
    // …neither is ready, and neither has a video on YouTube yet.
    assert.equal(channel.readiness.ready_to_publish, 1)
    assert.equal(channel.readiness.ready_unknown, 0)
    assert.equal(channel.readiness.on_youtube, 0)
    assert.deepEqual(channel.recommendations.map((r: any) => r.episode_code), ['UF0003'])

    // The Publish page agrees: the queued row is queued, the in-flight
    // operation is blocked as an upload in progress, and only UF0003 is offered.
    const publishable = await request(app).get(`/api/projects/${created.slug}/youtube/publishable`)
    assert.equal(publishable.status, 200)
    const rows: any[] = publishable.body.episodes
    const rowFor = (code: string) => rows.find((row: any) => row.episode_code === code)
    assert.equal(rowFor('UF0001').local.upload.state, 'queued')
    assert.match(rowFor('UF0001').blocked_reason, /queued/i)
    assert.match(rowFor('UF0002').blocked_reason, /in progress/i)
    assert.deepEqual(
      rows
        .filter((row: any) => row.has_video && !row.has_remote_video && !['queued', 'running'].includes(row.local?.upload?.state))
        .map((row: any) => row.episode_code),
      channel.recommendations
        .filter((r: any) => r.kind === 'ready_to_publish')
        .map((r: any) => r.episode_code),
    )
  } finally {
    await jobQueue.requestJobCancellation(created.slug, queued.job_id)
    jobQueue.removeTerminalJob(created.slug, queued.job_id)
    // The queue persists in the background; let it settle before the temp data
    // root goes away, or the late write lands outside it.
    await jobQueue._waitForJobPersistenceForTesting()
  }
})

test('a publishAt YouTube accepted counts as scheduled while the video is still processing — both surfaces', async () => {
  tmp = await useTempDataDir()
  const created = await connectedProject('Still Processing', 'SP')
  await acceptedEpisode(created.slug, 'SP0001', 'Still Processing')

  // A fresh upload YouTube has accepted but not finished processing: the
  // operation is in `processing`, and its remote snapshot carries the private
  // publishAt YouTube itself reported (Origin Field EP0001, 2026-10-18).
  const operation = await operations.createYouTubeOperation({
    project_slug: created.slug, episode_code: 'SP0001', channel_id: CHANNEL,
    source_revision: 'src-SP0001', metadata_revision: 'meta-SP0001',
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: created.slug, operation_id: operation.operation_id,
    expected_revision: operation.revision, channel_id: CHANNEL,
    video_id: 'vid-still-processing', accepted_at: '2026-10-18T14:45:29.003Z',
    final_payload: { snippet_json: '{}', status_json: '{}', source_sha256: 'b'.repeat(64) },
  })
  await operations.updateYouTubeOperation({
    project_slug: created.slug, operation_id: operation.operation_id,
    expected_revision: accepted.revision,
    mutate(record) {
      record.lifecycle = 'processing'
      record.processing = { checked_at: '2026-10-18T14:45:29.248Z', provider_status: 'uploaded' }
      record.remote_snapshot = {
        fetched_at: '2026-10-18T14:45:29.248Z', title: 'Still Processing', description: '', tags: [],
        privacy_status: 'private', scheduled_for: PUBLISH_AT,
      }
    },
  })

  // The Upload Center keeps the processing state AND the date YouTube accepted.
  const publishable = await request(app).get(`/api/projects/${created.slug}/youtube/publishable`)
  assert.equal(publishable.status, 200)
  const row = publishable.body.episodes.find((entry: any) => entry.episode_code === 'SP0001')
  assert.equal(row.publication.state, 'processing')
  assert.equal(row.publication.visibility, 'private')
  assert.equal(row.publication.scheduled_at, PUBLISH_AT)
  // The date is YouTube's own answer, not a local plan: same field either way.
  assert.equal(row.plan.scheduled_at, PUBLISH_AT)

  // The Overview counts the same video as confirmed-scheduled for that date.
  const overview = await request(app).get('/api/publishing/overview')
  assert.equal(overview.status, 200)
  const channel = overview.body.channels[0]
  assert.equal(channel.confirmed.count, 1)
  assert.equal(channel.confirmed.schedules[0].video_id, 'vid-still-processing')
  assert.equal(channel.confirmed.schedules[0].scheduled_for, PUBLISH_AT)
})
