/**
 * The publish-date guard (YouTube `publishAt`).
 *
 * Google's revision history: a `publishAt` in the past is NOT an error — the
 * video is published immediately, with no complaint
 * (https://developers.google.com/youtube/data/revision_history). So a date
 * that has gone does not fail loudly, it goes PUBLIC.
 *
 * Every case here is about that one fact, from four angles: the rule itself,
 * the admission that queues a job, the generator that finally spends the bytes
 * (a job can wait long enough for a safe date to become unsafe), and the read
 * back afterwards that catches what YouTube actually did.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { tinyVideoWithSoundBytes as tinyVideoBytes } from './fixtures/tiny-video.js'
import sharp from 'sharp'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
} from '../lib/youtube-client.js'
import {
  YOUTUBE_PUBLISH_LEAD_TIME_MS,
  YOUTUBE_PUBLISH_LEAD_TIME_TEXT,
  checkYouTubePublishDate,
  youTubePublishDateRefusal,
} from '../services/youtube-publish-guard.js'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const im = await import('../services/idea-manager.js')
const connections = await import('../services/youtube-connection-store.js')
const operations = await import('../services/youtube-operation-store.js')
const jobQueue = await import('../services/job-queue.js')
const plans = await import('../services/upload-plans.js')
const sidecars = await import('../services/upload-sidecar.js')
const { generateYoutubeUpload } = await import('../generators/youtube-upload.js')
const { scheduleCheckedEpisode } = await import('../services/episode-autoschedule.js')
const { router } = await import('../routes/youtube-upload-center.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

const CHANNEL = 'UC-publish-guard'
const LEAD = YOUTUBE_PUBLISH_LEAD_TIME_MS
const HOUR = 60 * 60 * 1000
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

let cleanup: (() => Promise<void>) | undefined
const heldTestJobs: Array<{ slug: string; jobId: string }> = []
afterEach(async () => {
  __resetYouTubeTransportForTests()
  for (const { slug, jobId } of heldTestJobs.splice(0)) {
    await jobQueue.requestJobCancellation(slug, jobId)
    assert.equal(jobQueue.removeTerminalJob(slug, jobId), true)
  }
  await jobQueue._waitForJobPersistenceForTesting()
  await cleanup?.()
  cleanup = undefined
})

// ── The rule ──────────────────────────────────────────────────────────────

describe('the shared publish-date rule', () => {
  const now = Date.parse('2026-11-01T12:00:00.000Z')
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString()

  test('the lead time is the named figure every caller uses', () => {
    assert.equal(LEAD, 6 * HOUR, 'the lead time is 6 hours, in one place')
  })

  test('a date outside the lead time is accepted', () => {
    assert.equal(checkYouTubePublishDate(at(LEAD), now).ok, true, 'exactly on the boundary is outside')
    assert.equal(checkYouTubePublishDate(at(LEAD + 60_000), now).ok, true)
  })

  test('a past date is refused, and named as past', () => {
    const value = at(-1)
    const verdict = checkYouTubePublishDate(value, now)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.problem, 'past')
    assert.equal(verdict.at, now - 1)
    // The message says what YouTube actually does, not what we wish it did.
    // Read from the shared refusal, the exact sentence admission returns — a
    // message restated in the test could not fail when the code drifts.
    assert.match(youTubePublishDateRefusal(value, now) || '', /publishes a video immediately/i)
  })

  test('a date inside the lead time is refused', () => {
    const value = at(LEAD - 1)
    const verdict = checkYouTubePublishDate(value, now)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.problem, 'too_soon')
    assert.match(youTubePublishDateRefusal(value, now) || '', /less than 6 hours away/)
  })

  test('a date that is not a date is a different answer from one that has passed', () => {
    // §6: "I could not work out the answer" must never share a value with
    // "the answer is none".
    const invalid = checkYouTubePublishDate('not-a-time', now)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.problem, 'invalid')
    assert.equal(invalid.at, null)
    assert.match(youTubePublishDateRefusal('not-a-time', now) || '', /not a valid date/i)
  })

  test('an impossible calendar date is refused, not silently rolled forward', () => {
    // `Date.parse('2030-04-31')` returns 1 May. Accepting that would send a
    // date the owner never chose — the hidden re-edit this product refuses.
    const impossible = checkYouTubePublishDate('2030-04-31T12:00:00.000Z', now)
    assert.equal(impossible.ok, false)
    assert.equal(impossible.problem, 'invalid', 'rolled-forward is not "a date"')
    assert.match(youTubePublishDateRefusal('2030-04-31T12:00:00.000Z', now) || '', /not a valid date/)
    // A real date on the same terms still passes the shape check, so the rule
    // is the calendar, not the format.
    assert.equal(checkYouTubePublishDate('2030-04-30T12:00:00.000Z', now + 0).problem !== 'invalid', true)
  })

  test('every refusal names the date and says how to fix it', () => {
    for (const value of [at(-HOUR), at(HOUR), 'not-a-time']) {
      assert.equal(checkYouTubePublishDate(value, now).ok, false, value)
      const message = youTubePublishDateRefusal(value, now)!
      assert.ok(message, value)
      assert.match(message, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the message names the date')
      assert.match(message, new RegExp(`Choose a date at least ${YOUTUBE_PUBLISH_LEAD_TIME_TEXT} from now`),
        'the message says how to repair it')
    }
  })

  test('a refusal names the lead time as the same figure the rule enforces', () => {
    const message = youTubePublishDateRefusal(at(HOUR), now)!
    // If someone changes the constant without changing the sentence, this
    // breaks — which is the point of deriving the words from the number.
    assert.ok(message.includes(YOUTUBE_PUBLISH_LEAD_TIME_TEXT), message)
  })
})

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A connected project with one accepted episode. */
async function connectedProject(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  // The name is the slug seed, and the job queue is keyed by slug: two tests
  // that reuse a name would find each other's queued jobs.
  const created = await pm.createProject({ name: `Publish guard ${Date.now()} ${Math.random().toString(16).slice(2)}` })
  await connections.configureYouTubeApplication({ client_id: 'guard-client', client_secret: 'generator-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Guard Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'guard-access', refresh_token: 'guard-refresh',
      expires_at: Date.now() + 3_600_000, scope: 'https://www.googleapis.com/auth/youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created.slug
}

/** An accepted episode with metadata, a rendered final and a thumbnail. */
async function acceptedEpisode(
  slug: string, code = 'EP0001', title = 'The Lighthouse at Dawn',
): Promise<{ episodeCode: string; title: string }> {
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'A keeper counts the nights.', themes: ['solitude'],
    suggested_chapters: 3, suggested_length: 'short', mood: 'calm',
  }], 'guard-test')
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
  return { episodeCode, title }
}

/** The body the Publish page sends after previewing. */
async function previewedUploadBody(slug: string, episodeCode: string, publishAt?: string) {
  const preview = await request(app).post(`/api/projects/${slug}/youtube/preview`).send({
    episode_code: episodeCode, privacy_status: 'private',
    ...(publishAt ? { publish_at: publishAt } : {}),
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  return {
    episode_code: episodeCode,
    confirm: true,
    expected_channel_id: CHANNEL,
    expected_package_revision: preview.body.package_revision,
    expected_source_revision: preview.body.source?.revision,
    ...(publishAt ? { publish_at: publishAt } : {}),
  }
}

// ── Admission ─────────────────────────────────────────────────────────────

describe('admission refuses a date YouTube would publish immediately', () => {
  const cases: Array<{ name: string; offset: number | string; problem: RegExp }> = [
    { name: 'a date in the past', offset: -HOUR, problem: /in the past/i },
    { name: 'a date inside the lead time', offset: HOUR, problem: /less than 6 hours away/i },
    { name: 'a date that is not a date', offset: 'not-a-time', problem: /not a valid date/i },
  ]

  for (const { name, offset, problem } of cases) {
    test(`${name} is refused at the manual path, with nothing queued`, async () => {
      const slug = await connectedProject()
      const { episodeCode } = await acceptedEpisode(slug)
      const publishAt = typeof offset === 'number' ? new Date(Date.now() + offset).toISOString() : offset
      const fake = new FakeYouTube()
      __setYouTubeTransportForTests(fake.transport())

      const body = await previewedUploadBody(slug, episodeCode, publishAt)
      const refused = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

      assert.equal(refused.status, 400, JSON.stringify(refused.body))
      assert.equal(refused.body.code, 'YOUTUBE_PUBLISH_AT_REFUSED')
      assert.equal(refused.body.publish_at, publishAt, 'the answer names the date it refused')
      assert.match(refused.body.detail, problem)
      assert.match(refused.body.detail, /Choose a date at least 6 hours from now/)
      // Nothing was queued, and YouTube was never contacted.
      assert.equal(fake.calls.length, 0)
      assert.equal(
        (await jobQueue.getJobs(slug, { type: 'youtube_upload' })).filter(j => j.episode_id === episodeCode).length,
        0, 'a refused date never reaches the queue',
      )
    })
  }

  test('a date just outside the lead time is admitted, as it always was', async () => {
    const slug = await connectedProject()
    const { episodeCode } = await acceptedEpisode(slug)
    const publishAt = new Date(Date.now() + LEAD + 5 * 60 * 1000).toISOString()

    const body = await previewedUploadBody(slug, episodeCode, publishAt)
    const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

    assert.equal(queued.status, 200, JSON.stringify(queued.body))
    assert.equal(queued.body.privacy_status, 'private')
    await removeQueuedTestJob(slug, queued.body.job_id)
  })

  test('uploading with no date is still allowed', async () => {
    const slug = await connectedProject()
    const { episodeCode } = await acceptedEpisode(slug)

    const body = await previewedUploadBody(slug, episodeCode)
    const queued = await request(app).post(`/api/projects/${slug}/youtube/upload`).send(body)

    assert.equal(queued.status, 200, JSON.stringify(queued.body))
    await removeQueuedTestJob(slug, queued.body.job_id)
  })

  test('the automatic path is refused by the same rule, and the log line says how to fix it', async () => {
    const slug = await connectedProject()
    const { episodeCode } = await acceptedEpisode(slug)
    const { admitYouTubeUpload } = await import('../routes/youtube-upload-center.js')
    const soon = new Date(Date.now() + 60 * 1000).toISOString()

    // Exactly the call `tryAutomaticUpload` makes in `scheduled` mode.
    const admission = await admitYouTubeUpload(
      slug, { episode_code: episodeCode, publish_at: soon }, { automatic: true },
    )

    assert.equal(admission.status, 400, JSON.stringify(admission.json))
    assert.equal(admission.json.code, 'YOUTUBE_PUBLISH_AT_REFUSED')
    assert.match(admission.json.detail, /less than 6 hours away/)
    assert.match(admission.json.detail, /Choose a date at least 6 hours from now/)
    assert.equal(
      (await jobQueue.getJobs(slug, { type: 'youtube_upload' })).filter(j => j.episode_id === episodeCode).length,
      0, 'nothing was queued',
    )
  })

  test('a local date inside the lead time is replaced, never sent', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
    await pm.updateConfig(slug, { auto_schedule_require_final_check: false } as any)
    // The plan holds a slot minutes away — the slot a plan could hand out
    // before the lead time was applied to `notBefore`.
    await plans.writeItemSchedule(slug, { [episodeCode]: new Date(Date.now() + 60 * 1000).toISOString() })

    const result = await scheduleCheckedEpisode(
      slug, episodeCode, path.join(paths.video_dir, `${episodeCode}_final_video.mp4`),
    )

    // The episode is not on YouTube, so the too-soon date is replaced rather
    // than kept and sent.
    assert.equal(result.scheduled, true, JSON.stringify(result))
    const held = (await plans.readItemSchedule(slug))[episodeCode]!
    assert.ok(Date.parse(held) - Date.now() >= LEAD, `replaced slot ${held} clears the lead time`)
  })

  test('a slot the plan hands out clears the lead time, not merely the present', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
    await pm.updateConfig(slug, { auto_schedule_require_final_check: false } as any)

    const result = await scheduleCheckedEpisode(
      slug, episodeCode, path.join(paths.video_dir, `${episodeCode}_final_video.mp4`),
    )

    assert.equal(result.scheduled, true, JSON.stringify(result))
    assert.ok(
      Date.parse(result.publish_at!) - Date.now() >= LEAD,
      `slot ${result.publish_at} must clear the ${LEAD / HOUR}h lead time`,
    )
  })
})

async function removeQueuedTestJob(slug: string, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = jobQueue.getJob(jobId)
    if (!current || ['done', 'error', 'cancelled'].includes(current.status)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  jobQueue.removeTerminalJob(slug, jobId)
}

// ── The generator, after the queue ────────────────────────────────────────

describe('the generator re-checks the date it is about to send', () => {
  /**
   * A job admitted with a date that was fine then. Running it now, with the
   * date inside the lead time, is exactly what a queue wait produces — and
   * admission would have approved it. The generator is the last place that
   * can still stop the upload.
   */
  async function queuedJobWithDate(offsetMs: number): Promise<any> {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const publishAt = new Date(Date.now() + offsetMs).toISOString()
    const built = await buildPackage(slug, episodeCode, title, publishAt)
    const sourcePath = path.join(
      (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
      `${episodeCode}_final_video.mp4`,
    )
    // A recovery fixture is registered without pumping, so the generator's
    // hold must update a real queued row rather than silently no-op.
    const job = jobQueue.enqueuePreparedForTest({
      project_slug: slug,
      type: 'youtube_upload',
      episode_id: episodeCode,
      episode_recovery_job_id: `job-${Math.random().toString(16).slice(2)}`,
      params: {
        episode_id: episodeCode,
        account_id: `registry:${CHANNEL}`,
        expected_channel_id: CHANNEL,
        expected_source_revision: await sourceRevisionOf(sourcePath),
        expected_package_revision: built.package_revision,
        approved_final_payload: built.final_payload,
        approved_upload_mode: 'apply-plan',
        scheduled_for: publishAt,
      },
    })
    heldTestJobs.push({ slug, jobId: job.job_id })
    return { slug, job }
  }

  function assertHeld(jobId: string, reason: RegExp): void {
    const held = jobQueue.getJob(jobId)!
    assert.equal(held.status, 'queued')
    assert.match(held.error || '', reason)
    assert.match(held.error || '', /upload is held.*choose a new future publication date/i)
    assert.equal(held.params.quota_retry_at, undefined, 'no publication date is invented')
  }

  test('a date that waited past the lead time is refused before any bytes are sent', async () => {
    const { slug, job } = await queuedJobWithDate(HOUR)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    await generateYoutubeUpload(job)
    assertHeld(job.job_id, /less than 6 hours away/)
    // Not one provider call, and no durable operation record that would read
    // as an upload in flight and block the retry.
    assert.equal(fake.calls.length, 0, 'the provider was never contacted')
    assert.equal((await operations.listYouTubeOperations(slug)).length, 0,
      'a refused date leaves nothing behind that looks like an upload')
  })

  test('a date that passed entirely is refused too', async () => {
    const { slug, job } = await queuedJobWithDate(-HOUR)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    await generateYoutubeUpload(job)
    assertHeld(job.job_id, /publishes a video immediately/)
    assert.equal(fake.calls.length, 0)
    assert.equal((await operations.listYouTubeOperations(slug)).length, 0)
  })

  test('a retry re-checks; it does not inherit the first run\'s verdict', async () => {
    const { slug, job } = await queuedJobWithDate(60 * 1000)
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    await generateYoutubeUpload(job)
    assertHeld(job.job_id, /less than 6 hours away/)
    const firstHoldLines = jobQueue.getJob(job.job_id)!.output_lines.length
    // Re-entering the same job must make and record the hold decision again.
    await generateYoutubeUpload({ ...job, output_lines: [] as string[] })
    assertHeld(job.job_id, /less than 6 hours away/)
    assert.ok(jobQueue.getJob(job.job_id)!.output_lines.length > firstHoldLines)
    assert.equal(fake.calls.length, 0)
    assert.equal((await operations.listYouTubeOperations(slug)).length, 0)
  })

  test('a job with no approved package is refused before it can spend anything', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const publishAt = new Date(Date.now() + 60 * 1000).toISOString()
    const sourcePath = path.join(
      (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
      `${episodeCode}_final_video.mp4`,
    )
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    // No expected_package_revision and no approved_final_payload. What refuses
    // this today is the review-receipt guard that runs first — the legacy
    // branch below it cannot be reached, because a job that passes that guard
    // is by construction a job WITH a package. The publish-date check is
    // placed after BOTH branches resolve their date, so a legacy package is
    // held to the same rule if that ever changes.
    const job: any = {
      job_id: `job-${Math.random().toString(16).slice(2)}`,
      project_slug: slug,
      episode_id: episodeCode,
      output_lines: [] as string[],
      result: {} as Record<string, unknown>,
      params: {
        episode_id: episodeCode,
        account_id: `registry:${CHANNEL}`,
        expected_channel_id: CHANNEL,
        expected_source_revision: await sourceRevisionOf(sourcePath),
        approved_upload_mode: 'apply-plan',
        scheduled_for: publishAt,
      },
    }

    await assert.rejects(() => generateYoutubeUpload(job), /nothing was uploaded/i)
    assert.equal(fake.calls.length, 0, 'no provider call')
    assert.equal((await operations.listYouTubeOperations(slug)).length, 0,
      'no durable record that would read as an upload in flight')
  })

  test('an upload with no date is unaffected by the guard', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const built = await buildPackage(slug, episodeCode, title, undefined)
    const fake = fakeAcceptingUpload('video-no-date')
    __setYouTubeTransportForTests(fake.transport())

    const job: any = {
      job_id: `job-${Math.random().toString(16).slice(2)}`,
      project_slug: slug,
      episode_id: episodeCode,
      output_lines: [] as string[],
      result: {} as Record<string, unknown>,
      params: {
        episode_id: episodeCode,
        account_id: `registry:${CHANNEL}`,
        expected_channel_id: CHANNEL,
        expected_source_revision: await sourceRevisionOf(
          path.join((await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
            `${episodeCode}_final_video.mp4`),
        ),
        expected_package_revision: built.package_revision,
        approved_final_payload: built.final_payload,
        approved_upload_mode: 'private',
      },
    }

    await generateYoutubeUpload(job)
    assert.equal((await operations.listYouTubeOperations(slug))[0]?.video_id, 'video-no-date')
  })
})

// ── The read back ─────────────────────────────────────────────────────────

describe('what YouTube actually holds is read back and reported', () => {
  test('a scheduled upload that came back public is reported loudly and never repaired', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const publishAt = new Date(Date.now() + LEAD + HOUR).toISOString()
    const built = await buildPackage(slug, episodeCode, title, publishAt)
    const videoId = 'video-went-public'

    const fake = fakeAcceptingUpload(videoId)
    // The upload succeeded and YouTube says the video is PUBLIC with no
    // schedule — the video is live right now, on a date the owner never chose.
    fake.respond({
      method: 'GET',
      path: `/youtube/v3/videos?part=snippet,status,processingDetails&id=${videoId}`,
      body: {
        items: [{
          id: videoId,
          snippet: { title: 'The Lighthouse at Dawn', description: '', tags: ['x'], categoryId: '24' },
          status: { uploadStatus: 'processed', privacyStatus: 'public' },
        }],
      },
    })
    __setYouTubeTransportForTests(fake.transport())

    const job = await uploadJob(slug, episodeCode, title, built, publishAt)
    await generateYoutubeUpload(job)

    // The video is kept, and the mismatch is loud and recorded.
    assert.equal((await operations.listYouTubeOperations(slug))[0]?.video_id, videoId,
      'the upload is never undone')
    const readback = job.result.schedule_readback as any
    assert.ok(readback, 'the mismatch is in the job result, not only in the log')
    assert.equal(readback.video_id, videoId)
    assert.equal(readback.sent_privacy_status, 'private')
    assert.equal(readback.sent_publish_at, publishAt)
    assert.equal(readback.youtube_privacy_status, 'public')
    assert.ok(readback.problems.some((p: string) => /YouTube has it as public, but private was sent/.test(p)),
      JSON.stringify(readback.problems))
    assert.ok(readback.problems.some((p: string) => /YouTube's publish date is none/.test(p)),
      JSON.stringify(readback.problems))
    assert.ok(
      (job.result.warnings as string[]).some(w => /did not keep the schedule this upload sent/.test(w)),
      'the warning is also in the job result warnings',
    )
    assert.ok(
      job.output_lines.some((line: string) => line.startsWith('⚠') && /did not keep the schedule/.test(line)),
      'the warning is loud in the job log',
    )
    // And nothing was written back: reporting, never repairing.
    const mutations = fake.calls.filter(call => call.method !== 'GET')
    assert.equal(mutations.filter(call => call.path.startsWith('/youtube/v3/videos?part=status')).length, 0,
      'the video\'s visibility is never changed by Story Studio')
  })

  test('a publish date YouTube moved is reported', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const publishAt = new Date(Date.now() + LEAD + HOUR).toISOString()
    const movedTo = new Date(Date.now() + 3 * 24 * HOUR).toISOString()
    const built = await buildPackage(slug, episodeCode, title, publishAt)
    const videoId = 'video-date-moved'

    const fake = fakeAcceptingUpload(videoId)
    fake.respond({
      method: 'GET',
      path: `/youtube/v3/videos?part=snippet,status,processingDetails&id=${videoId}`,
      body: {
        items: [{
          id: videoId,
          snippet: { title: 'The Lighthouse at Dawn', description: '', tags: ['x'], categoryId: '24' },
          status: { uploadStatus: 'processed', privacyStatus: 'private', publishAt: movedTo },
        }],
      },
    })
    __setYouTubeTransportForTests(fake.transport())

    const job = await uploadJob(slug, episodeCode, title, built, publishAt)
    await generateYoutubeUpload(job)

    const readback = job.result.schedule_readback as any
    assert.ok(readback, JSON.stringify(job.result))
    assert.equal(readback.youtube_privacy_status, 'private', 'the privacy still matches')
    assert.equal(readback.youtube_publish_at, movedTo)
    assert.deepEqual(readback.problems, [
      `YouTube's publish date is ${movedTo}, but ${publishAt} was sent`,
    ])
  })

  test('a read-back that agrees says nothing and records nothing', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const publishAt = new Date(Date.now() + LEAD + HOUR).toISOString()
    const built = await buildPackage(slug, episodeCode, title, publishAt)
    const videoId = 'video-keeps-its-date'

    const fake = fakeAcceptingUpload(videoId)
    fake.respond({
      method: 'GET',
      path: `/youtube/v3/videos?part=snippet,status,processingDetails&id=${videoId}`,
      body: {
        items: [{
          id: videoId,
          snippet: { title: 'The Lighthouse at Dawn', description: '', tags: ['x'], categoryId: '24' },
          // YouTube serializes without the fractional seconds Story Studio
          // sent. The same instant is not a mismatch.
          status: { uploadStatus: 'processed', privacyStatus: 'private', publishAt: publishAt.replace('.000Z', 'Z') },
        }],
      },
    })
    __setYouTubeTransportForTests(fake.transport())

    const job = await uploadJob(slug, episodeCode, title, built, publishAt)
    await generateYoutubeUpload(job)

    assert.equal(job.result.schedule_readback, undefined, 'an agreement is not a report')
    assert.equal((job.result.warnings as string[] | undefined) || undefined, (job.result.warnings as string[] | undefined) || undefined)
    assert.equal((job.result.warnings?.length ?? 0), 0)
  })

  test('a read that fails leaves the upload alone and says it was not checked', async () => {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const publishAt = new Date(Date.now() + LEAD + HOUR).toISOString()
    const built = await buildPackage(slug, episodeCode, title, publishAt)
    const videoId = 'video-status-unreadable'

    const fake = fakeAcceptingUpload(videoId)
    fake.rejectNext({
      method: 'GET',
      path: `/youtube/v3/videos?part=snippet,status,processingDetails&id=${videoId}`,
      status: 500,
      body: { error: { message: 'status is unreadable' } },
    })
    __setYouTubeTransportForTests(fake.transport())

    const job = await uploadJob(slug, episodeCode, title, built, publishAt)
    await generateYoutubeUpload(job)

    assert.equal((await operations.listYouTubeOperations(slug))[0]?.video_id, videoId, 'the upload stands')
    assert.equal(job.result.schedule_readback, undefined)
    assert.ok(job.output_lines.some((line: string) => /YouTube status not checked yet/.test(line)),
      'the unread status is named, never reported as a pass')
  })
})

// ── The two plan bugs ─────────────────────────────────────────────────────

describe('the local plan stops claiming dates YouTube does not hold', () => {
  async function scheduledEpisode(opts: { onYouTube?: 'private-no-date'; autoUpload?: 'private' | 'scheduled' }) {
    const slug = await connectedProject()
    const { episodeCode, title } = await acceptedEpisode(slug)
    const paths = await utils.resolveEpisodePaths(slug, episodeCode, title)
    const videoPath = path.join(paths.video_dir, `${episodeCode}_final_video.mp4`)
    await pm.updateConfig(slug, {
      auto_schedule_require_final_check: false,
      ...(opts.autoUpload ? { auto_upload: opts.autoUpload } as any : {}),
    } as any)
    // The automatic path admits nothing without a stored pass, so the fixture
    // earns one the same way a rendered episode does.
    await storePassingFinalCheck(videoPath)
    if (opts.onYouTube === 'private-no-date') {
      // Uploaded already, as private, with no publish date on YouTube.
      const made = await operations.createYouTubeOperation({
        project_slug: slug, episode_code: episodeCode, channel_id: CHANNEL,
        source_revision: 'src', metadata_revision: 'meta',
        origin: 'manual', final_action: 'manual_upload',
      })
      await operations.acceptYouTubeOperation({
        project_slug: slug, operation_id: made.operation_id, expected_revision: made.revision,
        channel_id: CHANNEL, video_id: 'video-already-there',
        accepted_at: new Date().toISOString(),
        final_payload: {
          snippet_json: '{}',
          status_json: JSON.stringify({ privacyStatus: 'private' }),
          source_sha256: 'e'.repeat(64),
        },
      })
    }
    return { slug, episodeCode, videoPath }
  }

  test('an episode already on YouTube gets no new local date (bug a)', async () => {
    const { slug, episodeCode, videoPath } = await scheduledEpisode({ onYouTube: 'private-no-date' })

    const result = await scheduleCheckedEpisode(slug, episodeCode, videoPath)

    // It is on YouTube and has no date there. Planning one locally would be a
    // date YouTube was never given — the plan claiming something the video
    // will never do.
    assert.equal(result.scheduled, false, JSON.stringify(result))
    assert.equal(result.publish_at, undefined)
    assert.match(result.reason || '', /already on YouTube with no publish date/)
    assert.equal((await plans.readItemSchedule(slug))[episodeCode], undefined)
  })

  test('a project with no channel still gets a date (bug a, the other half)', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const created = await pm.createProject({ name: 'No channel' })
    const { episodeCode, title } = await acceptedEpisode(created.slug)
    const paths = await utils.resolveEpisodePaths(created.slug, episodeCode, title)
    await pm.updateConfig(created.slug, { auto_schedule_require_final_check: false } as any)

    const result = await scheduleCheckedEpisode(
      created.slug, episodeCode, path.join(paths.video_dir, `${episodeCode}_final_video.mp4`),
    )

    // Nobody can be asked whether it is on YouTube, so scheduling carries on
    // exactly as it did before — refusing here would stop every episode of
    // every project that has not connected a channel.
    assert.equal(result.scheduled, true, JSON.stringify(result))
    assert.ok(result.publish_at)
  })

  test('auto_upload: private drops the plan date the upload never carried (bug b)', async () => {
    const { slug, episodeCode, videoPath } = await scheduledEpisode({ autoUpload: 'private' })

    const result = await scheduleCheckedEpisode(slug, episodeCode, videoPath)

    // The upload was queued, and it carries NO date — private-first mode.
    const jobs = (await jobQueue.getJobs(slug, { type: 'youtube_upload' }))
      .filter(job => job.episode_id === episodeCode)
    assert.equal(jobs.length, 1, 'the upload is still queued')
    assert.equal(jobs[0]!.params?.scheduled_for, undefined, 'private mode sends no date')
    assert.equal(result.auto_upload_log, 'Automatic YouTube upload queued.')

    // But the plan must not go on claiming the date YouTube never received.
    assert.equal((await plans.readItemSchedule(slug))[episodeCode], undefined,
      'the plan holds no date the upload did not carry')
    assert.equal(result.scheduled, false, JSON.stringify(result))
    assert.equal(result.publish_at, undefined)
    assert.match(result.reason || '', /uploads privately with no publish date/)
  })

  test('auto_upload: scheduled keeps the date, because YouTube was given it', async () => {
    const { slug, episodeCode, videoPath } = await scheduledEpisode({ autoUpload: 'scheduled' })

    const result = await scheduleCheckedEpisode(slug, episodeCode, videoPath)

    const jobs = (await jobQueue.getJobs(slug, { type: 'youtube_upload' }))
      .filter(job => job.episode_id === episodeCode)
    assert.equal(jobs.length, 1, 'one upload for this episode')
    assert.equal(jobs[0]!.params?.scheduled_for, result.publish_at, 'the date reached the job')
    assert.equal(result.scheduled, true, JSON.stringify(result))
    assert.ok((await plans.readItemSchedule(slug))[episodeCode], 'the plan keeps the date YouTube holds')
  })

  test('private mode drops a date the episode was ALREADY holding (bug b, the other branch)', async () => {
    const { slug, episodeCode, videoPath } = await scheduledEpisode({ autoUpload: 'private' })
    // The plan already holds a date from an earlier schedule — the branch
    // that keeps it and asks again, rather than writing a new one.
    const held = new Date(Date.now() + 2 * 24 * HOUR).toISOString()
    await plans.writeItemSchedule(slug, { [episodeCode]: held })
    assert.equal((await plans.readItemSchedule(slug))[episodeCode], held, 'the fixture really holds a date')

    const result = await scheduleCheckedEpisode(slug, episodeCode, videoPath)

    const jobs = (await jobQueue.getJobs(slug, { type: 'youtube_upload' }))
      .filter(job => job.episode_id === episodeCode)
    assert.equal(jobs.length, 1, 'the upload was still queued')
    assert.equal(jobs[0]!.params?.scheduled_for, undefined, 'private mode sends no date')
    // The old date is dropped from BOTH the plan and the result: a plan that
    // reports a date YouTube was never given is a promise nothing will keep.
    assert.equal((await plans.readItemSchedule(slug))[episodeCode], undefined,
      'the plan stops claiming the date the upload never carried')
    assert.equal(result.publish_at, undefined)
    assert.match(result.reason || '', /uploads privately with no publish date/)
  })

  test('a refused private upload keeps the plan date — nothing was sent', async () => {
    const { slug, episodeCode, videoPath } = await scheduledEpisode({ autoUpload: 'private' })
    // Exhaust the upload allowance, so admission refuses.
    const registry = await connections.readYouTubeConnectionRegistry()
    const ledger = await import('../services/youtube-quota-ledger.js')
    for (let i = 0; i < 20; i++) {
      await ledger.recordYouTubeQuotaAttempt({
        application_id: registry.application!.application_id,
        channel_id: CHANNEL, bucket: 'video_uploads', operation: 'videos.insert', amount: 100,
      })
    }

    const result = await scheduleCheckedEpisode(slug, episodeCode, videoPath)

    assert.match(result.auto_upload_log || '', /skipped/)
    // Nothing reached YouTube, so the plan is still just a plan and stays.
    assert.ok((await plans.readItemSchedule(slug))[episodeCode],
      'a date is dropped only when the upload carrying no date was actually admitted')
    assert.equal(
      (await jobQueue.getJobs(slug, { type: 'youtube_upload' })).filter(j => j.episode_id === episodeCode).length,
      0, 'a refused admission queues nothing',
    )
  })
})

// ── Fixtures for the generator ────────────────────────────────────────────

const SESSION = 'https://upload.youtube.test/resumable/session-guard'

async function sourceRevisionOf(filePath: string): Promise<string> {
  const { resolveYouTubeSourceRevision } = await import('../services/youtube-source-video.js')
  return resolveYouTubeSourceRevision(filePath)
}

/** The package the owner would have reviewed, with the date under test. */
async function buildPackage(slug: string, episodeCode: string, title: string, publishAt?: string) {
  const { buildYouTubeMetadataPackage, resolveYouTubeUploadSettings } =
    await import('../services/youtube-metadata-package.js')
  const settings = await resolveYouTubeUploadSettings(slug)
  return buildYouTubeMetadataPackage({
    project_slug: slug,
    episode_code: episodeCode,
    privacy_status: 'private',
    ...(publishAt ? { publish_at: publishAt } : {}),
    mark_as_ai_generated: settings.mark_as_ai_generated,
    ...(settings.category_id !== undefined ? { category_id: settings.category_id } : {}),
    fallback_title: title,
  })
}

/** The job the queue would run: a reviewed upload, with the real source revision. */
async function uploadJob(slug: string, episodeCode: string, title: string, built: any, publishAt?: string): Promise<any> {
  const sourcePath = path.join(
    (await utils.resolveEpisodePaths(slug, episodeCode, title)).video_dir,
    `${episodeCode}_final_video.mp4`,
  )
  return {
    job_id: `job-${Math.random().toString(16).slice(2)}`,
    project_slug: slug,
    episode_id: episodeCode,
    output_lines: [] as string[],
    result: {} as Record<string, any>,
    params: {
      episode_id: episodeCode,
      account_id: `registry:${CHANNEL}`,
      expected_channel_id: CHANNEL,
      expected_source_revision: await sourceRevisionOf(sourcePath),
      expected_package_revision: built.package_revision,
      approved_final_payload: built.final_payload,
      approved_upload_mode: 'apply-plan',
      ...(publishAt ? { scheduled_for: publishAt } : {}),
    },
  }
}

/**
 * A stored pass on the rendered file. The automatic admission path admits
 * nothing without one, so a fixture that exercises it has to earn a pass the
 * same way a real render does.
 */
async function storePassingFinalCheck(videoPath: string): Promise<void> {
  const { runFinalCheck, storeFinalCheck } = await import('../lib/final-video-check.js')
  const passed = await runFinalCheck(videoPath, {
    planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 0, height: 0, subtitles_path: null,
  } as any)
  await storeFinalCheck(videoPath, passed)
}

function fakeAcceptingUpload(videoId: string): FakeYouTube {
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    body: {},
    headers: { Location: SESSION },
  })
  fake.respond({ method: 'PUT', path: '/resumable/session-guard', body: { id: videoId } })
  fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
  return fake
}
