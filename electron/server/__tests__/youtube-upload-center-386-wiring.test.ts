/**
 * Story 386 wiring between the Publish page and the upload queue.
 *
 * The page already sends `earliest_upload_on` and `params.captions`; admission
 * used to ignore both. These tests pin the three promises that closes:
 *   - the earliest transfer start is validated and stored under the one job
 *     param the pacing pump reads (`upload_on`), legacy `upload_on` included;
 *   - an explicit caption choice is stored as chosen, and OFF stays OFF;
 *   - the overview's `upload_queue` is projected from the SAME jobs the
 *     dispatcher runs, with the pacing service's real wait/next-eligible
 *     values — never a second scheduler or an invented quota.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { tinyVideoWithSoundBytes as tinyVideoBytes } from './fixtures/tiny-video.js'
import { __resetYouTubeTransportForTests, __setYouTubeTransportForTests } from '../lib/youtube-client.js'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const im = await import('../services/idea-manager.js')
const connections = await import('../services/youtube-connection-store.js')
const jobQueue = await import('../services/job-queue.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

const CHANNEL = 'UC-386-wiring'
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetYouTubeTransportForTests()
  // A queue held for one test must never leak into the next one.
  await jobQueue.setQueuePaused(false).catch(() => {})
  await jobQueue._waitForJobPersistenceForTesting()
  await cleanup?.()
  cleanup = undefined
})

async function connectedProject(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const created = await pm.createProject({ name: `386 wiring ${Date.now()} ${Math.random().toString(16).slice(2)}` })
  await connections.configureYouTubeApplication({ client_id: 'wiring-client', client_secret: 'generator-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Wiring Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'wiring-access', refresh_token: 'wiring-refresh',
      expires_at: Date.now() + 3_600_000, scope: 'https://www.googleapis.com/auth/youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created.slug
}

async function acceptedEpisode(slug: string): Promise<string> {
  const title = 'The Lighthouse at Dawn'
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'A keeper counts the nights.', themes: ['solitude'],
    suggested_chapters: 3, suggested_length: 'short', mood: 'calm',
  }], 'wiring-test')
  const accepted = await im.acceptIdea(slug, idea!.id)
  const episodeCode = accepted.idea.episode_code!
  const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title, description: 'A keeper counts the nights.', tags: ['x'],
  }))
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(path.join(paths.video_dir, `${episodeCode}_final_video.mp4`), tinyVideoBytes())
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await sharp({ create: { width: 16, height: 9, channels: 3, background: '#335577' } })
    .png().toFile(path.join(paths.thumb_dir, `${episodeCode}_Thumb01_v1.png`))
  return episodeCode
}

/** The body the Publish page sends after previewing, plus the fields under test. */
async function uploadBody(slug: string, episodeCode: string, extra: Record<string, unknown> = {}) {
  const preview = await request(app).post(`/api/projects/${slug}/youtube/preview`).send({
    episode_code: episodeCode, privacy_status: 'private',
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  return {
    episode_code: episodeCode,
    confirm: true,
    expected_channel_id: CHANNEL,
    expected_package_revision: preview.body.package_revision,
    expected_source_revision: preview.body.source?.revision,
    ...extra,
  }
}

async function removeQueuedTestJob(slug: string, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = jobQueue.getJob(jobId)
    if (!current || ['done', 'error', 'cancelled'].includes(current.status)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  jobQueue.removeTerminalJob(slug, jobId)
}

async function queuedUpload(slug: string, episodeCode: string) {
  const jobs = await jobQueue.getJobs(slug, { type: 'youtube_upload' })
  return jobs.find(job => job.episode_id === episodeCode)
}

describe('admission carries "upload on" and captions into the queued job', () => {
  test('an unparseable earliest_upload_on is refused, with nothing queued', async () => {
    const slug = await connectedProject()
    const episodeCode = await acceptedEpisode(slug)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const body = await uploadBody(slug, episodeCode, { earliest_upload_on: 'not-a-time' })
    const refused = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

    assert.equal(refused.status, 400, JSON.stringify(refused.body))
    assert.equal(refused.body.code, 'YOUTUBE_UPLOAD_ON_REFUSED')
    assert.equal(refused.body.upload_on, 'not-a-time', 'the answer names the date it refused')
    assert.match(refused.body.detail, /not a valid date/i)
    assert.equal(await queuedUpload(slug, episodeCode), undefined, 'a refused date never reaches the queue')
    assert.equal(fake.calls.length, 0)
  })

  test('earliest_upload_on and legacy upload_on both land in params.upload_on as ISO', async () => {
    for (const field of ['earliest_upload_on', 'upload_on']) {
      const slug = await connectedProject()
      const episodeCode = await acceptedEpisode(slug)
      const fake = new FakeYouTube()
      __setYouTubeTransportForTests(fake.transport())
      const requested = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()

      const body = await uploadBody(slug, episodeCode, { [field]: requested })
      const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

      assert.equal(queued.status, 200, `${field}: ${JSON.stringify(queued.body)}`)
      const job = await queuedUpload(slug, episodeCode)
      assert.equal(job?.params?.upload_on, requested, `${field} is stored where the pacing pump reads it`)
      await removeQueuedTestJob(slug, queued.body.job_id)
      await cleanup?.()
      cleanup = undefined
    }
  })

  test('explicit captions are forwarded, and a missing switch stays OFF', async () => {
    const slug = await connectedProject()
    const episodeCode = await acceptedEpisode(slug)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const body = await uploadBody(slug, episodeCode, {
      params: { captions: { language: 'km', track_name: 'Khmer', enabled: true } },
    })
    const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

    assert.equal(queued.status, 200, JSON.stringify(queued.body))
    const job = await queuedUpload(slug, episodeCode)
    assert.equal(job?.params?.captions?.enabled, true)
    assert.equal(job?.params?.captions?.language, 'km')
    assert.equal(job?.params?.captions?.track_name, 'Khmer')
    await removeQueuedTestJob(slug, queued.body.job_id)
  })

  test('captions without enabled are stored OFF, never enabled by omission', async () => {
    const slug = await connectedProject()
    const episodeCode = await acceptedEpisode(slug)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const body = await uploadBody(slug, episodeCode, { params: { captions: { language: 'km' } } })
    const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

    assert.equal(queued.status, 200, JSON.stringify(queued.body))
    const job = await queuedUpload(slug, episodeCode)
    assert.equal(job?.params?.captions?.enabled, false)
    assert.equal(job?.params?.captions?.language, 'km')
    await removeQueuedTestJob(slug, queued.body.job_id)
  })
})

describe('the overview projects the real upload queue', () => {
  const pacing = {
    tier: 'regular', daily_limit: 6, timezone: 'UTC',
    window: { start: '00:00', end: '23:59' },
  }

  test('a waiting job carries the pacing service\'s reason and next eligible instant', async () => {
    const slug = await connectedProject()
    const episodeCode = await acceptedEpisode(slug)
    await pm.updateConfig(slug, { upload_pacing: pacing } as any)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    const uploadOn = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()

    const body = await uploadBody(slug, episodeCode, { earliest_upload_on: uploadOn })
    const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
    assert.equal(queued.status, 200, JSON.stringify(queued.body))

    const overview = await request(app).get(`/api/projects/${slug}/youtube/overview`)
    assert.equal(overview.status, 200, JSON.stringify(overview.body))
    assert.ok(Array.isArray(overview.body.upload_queue), 'the projection is a list, never an absent field')
    const row = overview.body.upload_queue.find((entry: any) => entry.episode_code === episodeCode)
    assert.ok(row, 'the queued job appears in the projection')
    assert.equal(row.job_id, queued.body.job_id)
    assert.equal(row.upload_at, uploadOn)
    assert.equal(row.wait_reason, 'waiting_for_upload_on')
    assert.equal(row.next_eligible_at, uploadOn, 'the wake instant is the pacing service\'s, not a guess')
    assert.equal(row.is_paused, false)
    assert.equal(row.can_remove, true)
    assert.equal(row.can_reorder, true)
    await removeQueuedTestJob(slug, queued.body.job_id)
  })

  test('a paused job says it is paused, never quota_exhausted', async () => {
    const slug = await connectedProject()
    const episodeCode = await acceptedEpisode(slug)
    await pm.updateConfig(slug, { upload_pacing: pacing } as any)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    const body = await uploadBody(slug, episodeCode, {
      earliest_upload_on: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    })
    const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
    assert.equal(queued.status, 200, JSON.stringify(queued.body))
    await jobQueue.pauseJob(queued.body.job_id)

    const overview = await request(app).get(`/api/projects/${slug}/youtube/overview`)
    const row = overview.body.upload_queue.find((entry: any) => entry.episode_code === episodeCode)
    assert.equal(row.is_paused, true)
    assert.equal(row.wait_reason, null, 'the shared wait reasons have no paused code to borrow')
    assert.match(row.wait_detail, /Paused/)
    assert.equal(row.next_eligible_at, null, 'a paused row has no wake instant')
    await removeQueuedTestJob(slug, queued.body.job_id)
  })

  test('a channel with no pacing policy says so instead of inventing a wait time', async () => {
    const slug = await connectedProject()
    const episodeCode = await acceptedEpisode(slug)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())
    // No policy means no pacing hold, so an unpaused queue would start this
    // upload at once. Hold the queue to observe the row while it is queued.
    await jobQueue.setQueuePaused(true)

    try {
      const body = await uploadBody(slug, episodeCode, {
        earliest_upload_on: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)
      assert.equal(queued.status, 200, JSON.stringify(queued.body))

      const overview = await request(app).get(`/api/projects/${slug}/youtube/overview`)
      const row = overview.body.upload_queue.find((entry: any) => entry.episode_code === episodeCode)
      assert.ok(row, 'the queued job appears while the queue is held')
      assert.equal(row.wait_reason, 'unconfigured_pacing')
      assert.equal(row.next_eligible_at, null, 'no policy means no invented wake instant')
      await removeQueuedTestJob(slug, queued.body.job_id)
    } finally {
      await jobQueue.setQueuePaused(false)
    }
  })

  test('nothing queued is an empty list, not a missing answer', async () => {
    const slug = await connectedProject()
    const overview = await request(app).get(`/api/projects/${slug}/youtube/overview`)
    assert.equal(overview.status, 200)
    assert.deepEqual(overview.body.upload_queue, [])
  })
})
