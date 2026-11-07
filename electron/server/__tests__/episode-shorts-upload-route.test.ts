/**
 * 1.4.374 — the Shorts upload, end to end.
 *
 * What this pins, beyond the decision rules in
 * `episode-shorts-upload.test.ts`:
 *
 *   - the channel's setting is saved and read back through the routes;
 *   - the API route uploads one episode's Shorts and says what happened;
 *   - a Short really goes up PRIVATE, with its own title, and YouTube is
 *     never asked to make anything public;
 *   - a failed upload is loud in the log and fails neither the Shorts nor the
 *     episode;
 *   - the automatic upload runs after the Shorts are verified, and its
 *     failure never fails the Shorts job.
 *
 * The provider is the fake transport: no request leaves the machine.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { waitForValue } from './_timing.js'

const PASSAGE_SECONDS = 20
let channelCounter = 0

/**
 * Wait until every upload job this test admitted has stopped running.
 *
 * The queue runs admitted jobs AROUND a test, not when the test asks: a job
 * left running at the end of one test runs under the NEXT test's fake
 * transport, where it consumes that test's queued responses and is recorded
 * in its `fake.calls`. The test that follows then reads a request it did not
 * make — which is how a scheduled test once read a private insert with no
 * publish date. A job with no fake transport at all would reach the real
 * network instead. So a test that admits one owes the queue a drain.
 */
async function settleUploads(slug: string): Promise<void> {
  const { getJobs } = await import('../services/job-queue.js')
  await waitForValue(async () => {
    const jobs = await getJobs(slug, { type: 'youtube_upload' })
    return jobs.every(job => ['done', 'error', 'cancelled'].includes(job.status)) ? jobs : undefined
  }, { timeoutMs: 15_000 })
}

/** Queue one accepting upload: an init that hands back a session, then the PUT. */
function acceptingUpload(fake: { respond: Function, respondMatching: Function },
  sessionUrl: string, videoId: string): void {
  fake.respond({
    method: 'POST',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    body: {},
    headers: { Location: sessionUrl },
  })
  fake.respond({ method: 'PUT', path: sessionUrl.replace(/^https?:\/\/[^/]+/, ''), body: { id: videoId } })
  fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
}

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let utils: typeof import('../services/utils.js')
let connections: typeof import('../services/youtube-connection-store.js')
let youtube: typeof import('../lib/youtube-client.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  utils = await import('../services/utils.js')
  connections = await import('../services/youtube-connection-store.js')
  youtube = await import('../lib/youtube-client.js')
})
after(async () => {
  youtube.__resetYouTubeTransportForTests()
  await cleanup?.()
})
beforeEach(() => { youtube.__resetYouTubeTransportForTests() })

/** A channel with a YouTube channel assigned and one accepted episode. */
async function project(name: string): Promise<{ slug: string, code: string, title: string, channel: string }> {
  const created = await pm.createProject({ name })
  // Upload pacing is a deliberate channel choice, so the fixture makes one: an
  // always-open window whose spread over the daily limit leaves zero spacing,
  // so a retry Short is not held behind the one that just uploaded.
  await pm.updateConfig(created.slug, {
    upload_pacing: {
      tier: 'gentle', daily_limit: 1440, timezone: 'UTC',
      window: { start: '00:00', end: '23:59' },
    },
  } as any)
  // A YouTube channel belongs to ONE project, so each test gets its own.
  const channel = `UC_shorts_${++channelCounter}`
  await connections.configureYouTubeApplication({ client_id: 'shorts-client', client_secret: 'secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channel, title: 'Shorts Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: channel, expected_previous_channel_id: null,
  })
  const title = 'The Lighthouse at Dawn'
  const [idea] = await im.addIdeas(created.slug, [{
    title, logline: 'A keeper counts the nights.', themes: ['solitude'],
    suggested_chapters: 3, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(created.slug, idea!.id)
  const code = accepted.idea.episode_code!
  const paths = await utils.resolveEpisodePaths(created.slug, code, title)
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title, description: 'A keeper counts the nights.', tags: ['lighthouse'],
  }))
  // A thumbnail is required for any upload, so every episode here has one.
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  const { default: sharp } = await import('sharp')
  await sharp({ create: { width: 16, height: 9, channels: 3, background: '#335577' } })
    .png().toFile(path.join(paths.thumb_dir, `${code}_Thumb01_v1.png`))
  return { slug: created.slug, code, title, channel }
}

/**
 * An episode with two verified Shorts on disk, the way the Shorts job leaves
 * them: a manifest of the passages and one real clip per passage.
 */
async function withShorts(ready: { slug: string, code: string, title: string }): Promise<string> {
  const paths = await utils.resolveEpisodePaths(ready.slug, ready.code, ready.title)
  const dir = path.join(paths.episode_dir, 'shorts')
  await fs.mkdir(dir, { recursive: true })
  const moments = [
    { start: 0, end: PASSAGE_SECONDS, title: 'The first watch', reason: 'A complete idea' },
    { start: 40, end: 40 + PASSAGE_SECONDS, title: 'The second watch', reason: 'Another idea' },
  ]
  await fs.writeFile(path.join(dir, 'shorts.json'), JSON.stringify({ shorts: moments }))
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  for (const index of moments.keys()) {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=blue:s=1080x1920:r=10:d=${PASSAGE_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${PASSAGE_SECONDS}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
      path.join(dir, `${ready.code}-short-${index + 1}.mp4`),
    ])
  }
  return dir
}

/**
 * The episode's final video, with the Final Check a Short is cut from.
 *
 * A Short inherits the episode's check — the same verdict the cut was made
 * from — so the episode needs one.
 */
async function withFinalVideo(ready: { slug: string, code: string, title: string }): Promise<string> {
  const paths = await utils.resolveEpisodePaths(ready.slug, ready.code, ready.title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  const file = path.join(paths.video_dir, `${ready.code}_final_video.mp4`)
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file,
  ])
  // A verdict stored the way a check stores it: bound to these exact bytes.
  const { finalCheckPath } = await import('../lib/final-video-check.js')
  const stat = await fs.stat(file)
  await fs.writeFile(finalCheckPath(file), JSON.stringify({
    checked_at: new Date().toISOString(),
    file: { size: stat.size, mtime_ms: stat.mtimeMs },
    expected: {
      planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
      width: 320, height: 180, subtitles_path: null,
    },
    actual: {
      duration_sec: 2, video_sec: 2, audio_sec: 2, width: 320, height: 180,
      tail_lufs: null, black: [], silence: [],
    },
    passed: true, issues: [],
  }, null, 2))
  return file
}

describe('the channel setting is saved and read back', () => {
  test('the publishing schedule route saves the Shorts switch and its spacing', async () => {
    const ready = await project('Shorts settings')
    const saved = await request(app)
      .put(`/api/projects/${ready.slug}/publishing-schedule`)
      .send({ shorts_auto_upload: 'scheduled', shorts_upload_spacing_days: 3 })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.shorts_auto_upload, 'scheduled')
    assert.equal(saved.body.shorts_upload_spacing_days, 3)
    assert.equal((await pm.getConfig(ready.slug) as any).shorts_auto_upload, 'scheduled')
  })

  test('a spacing outside 1–30 is refused and nothing is written', async () => {
    const ready = await project('Shorts spacing refused')
    const bad = await request(app)
      .put(`/api/projects/${ready.slug}/publishing-schedule`)
      .send({ shorts_upload_spacing_days: 31 })
    assert.equal(bad.status, 400)
    assert.match(bad.body.detail, /1 to 30/)
    assert.equal((await pm.getConfig(ready.slug) as any).shorts_upload_spacing_days, undefined)
  })

  test('an unknown switch value is refused', async () => {
    const ready = await project('Shorts mode refused')
    const bad = await request(app)
      .put(`/api/projects/${ready.slug}/publishing-schedule`)
      .send({ shorts_auto_upload: 'public' })
    assert.equal(bad.status, 400)
    assert.equal((await pm.getConfig(ready.slug) as any).shorts_auto_upload, undefined)
  })

  test('the settings config route accepts the same keys', async () => {
    const ready = await project('Shorts via settings config')
    const saved = await request(app)
      .put(`/api/projects/${ready.slug}/settings/config`)
      .send({ shorts_auto_upload: 'private', shorts_upload_spacing_days: 2 })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal((await pm.getConfig(ready.slug) as any).shorts_auto_upload, 'private')
    const read = await request(app).get(`/api/projects/${ready.slug}/settings/config`)
    assert.equal(read.body.shorts_auto_upload, 'private')
    assert.equal(read.body.shorts_upload_spacing_days, 2)
  })

  test('a Short title is cleaned by the same rules as the episode title', async () => {
    // The Short's title is written by the model when the passages were chosen
    // (validateShortMoments). It is MODEL text, so the editorial strips that
    // remove document furniture must apply to it — otherwise a title like this
    // one would trip the publishable-metadata gate and the Short could never
    // upload.
    const ready = await project('Shorts title cleanup')
    const { buildYouTubeMetadataPackage } = await import('../services/youtube-metadata-package.js')
    const { assertPublishableMetadata } = await import('../lib/metadata-scaffold.js')
    const built = await buildYouTubeMetadataPackage({
      project_slug: ready.slug,
      episode_code: ready.code,
      privacy_status: 'private',
      mark_as_ai_generated: false,
      title_override: '## The **first** watch',
    })
    assert.notEqual(built.snippet.title, '## The **first** watch', 'the furniture is removed')
    assert.ok(!built.snippet.title.includes('**'), built.snippet.title)
    // The gate the upload runs just before the API must accept it.
    assert.doesNotThrow(() => assertPublishableMetadata(built.snippet))
    // And the parent's description came along — the Short keeps it.
    assert.equal(built.snippet.description, 'A keeper counts the nights.')
  })
})

describe('the API route uploads one episode’s Shorts', () => {
  test('off means nothing is uploaded, and the answer says so', async () => {
    const ready = await project('Shorts off')
    await withShorts(ready)
    const fake = new FakeYouTube()
    youtube.__setYouTubeTransportForTests(fake.transport())
    const res = await request(app).post(`/api/projects/${ready.slug}/episodes/${ready.code}/shorts/upload`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.uploaded, 0)
    assert.match(res.body.reason, /off/i)
    assert.equal(fake.calls.length, 0, 'nothing was sent to YouTube')
  })

  test('a refused Short is reported with its reason, and nothing is sent', async () => {
    const ready = await project('Shorts refused')
    const dir = await withShorts(ready)
    // A Short that failed verification is never uploaded.
    await fs.writeFile(path.join(dir, `${ready.code}-short-2.mp4`), 'not a video')
    await pm.updateConfig(ready.slug, { shorts_auto_upload: 'private' } as any)
    const fake = new FakeYouTube()
    youtube.__setYouTubeTransportForTests(fake.transport())
    const res = await request(app).post(`/api/projects/${ready.slug}/episodes/${ready.code}/shorts/upload`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.uploaded, 0)
    assert.equal(res.body.upload_failed, true)
    assert.ok(res.body.lines.some((line: string) => /verification/i.test(line)), res.body.lines.join('\n'))
  })
})

describe('a Short really goes up private, under its own title', () => {
  test('the upload is private, titled after the Short, and never made public', async () => {
    const ready = await project('Shorts private upload')
    const dir = await withShorts(ready)
    await withFinalVideo(ready)
    await pm.updateConfig(ready.slug, { shorts_auto_upload: 'private' } as any)

    const fake = new FakeYouTube()
    fake.respond({
      method: 'POST',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      body: {},
      headers: { Location: 'https://fake.youtube.test/resumable/short-session' },
    })
    fake.respond({ method: 'PUT', path: '/resumable/short-session', body: { id: 'short-video-1' } })
    fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
    youtube.__setYouTubeTransportForTests(fake.transport())

    // Admit and run ONE Short, exactly as the automatic path does.
    const { admitYouTubeUpload } = await import('../routes/youtube-upload-center.js')
    const admission = await admitYouTubeUpload(ready.slug, {
      episode_code: ready.code,
      privacy_status: 'private',
      short_source: { id: `${ready.code}-S1`, file: `${ready.code}-short-1.mp4`, title: 'The first watch' },
    }, { automatic: true })
    assert.equal(admission.status, 200, JSON.stringify(admission.json))

    // The queue runs the admitted job; wait for it to settle.
    const { getJobs } = await import('../services/job-queue.js')
    await waitForValue(async () => {
      const jobs = await getJobs(ready.slug, { type: 'youtube_upload' })
      return jobs.find(entry => entry.episode_id === `${ready.code}-S1`
        && (entry.status === 'done' || entry.status === 'error')) || undefined
    })

    // The insert body is the proof: the Short's own title, and PRIVATE.
    const init = fake.calls.find(call => call.method === 'POST' && call.path.includes('uploadType=resumable'))
    assert.ok(init, 'the upload was started')
    const sent = JSON.parse(init!.body || '{}')
    assert.equal(sent.snippet.title, 'The first watch', 'the Short goes up under its own title')
    assert.equal(sent.status.privacyStatus, 'private', 'a Short is never uploaded public')
    assert.equal(sent.status.publishAt, undefined, 'a private Short has no publish date')

    // Nothing anywhere in the exchange asked to make a video public.
    for (const call of fake.calls) {
      if (!call.body) continue
      assert.doesNotMatch(call.body, /"privacyStatus"\s*:\s*"public"/, call.path)
    }

    // The Short's own record was written, and the episode's was not touched.
    const shortsDir = path.join(dir)
    const shortSidecar = path.join(shortsDir, `${ready.code}-S1_upload.json`)
    const written = JSON.parse(await fs.readFile(shortSidecar, 'utf8'))
    assert.equal(written.video_id, 'short-video-1')
    assert.equal(written.privacy_status, 'private')

    // The per-Short state records `uploaded` WITH the video id — written by
    // the job that actually sent the file, not by the admission that only
    // queued it. Recording it earlier would mark a Short gone up while its
    // upload was still running, and a retry would then skip it.
    const { readShortsUploadState } = await import('../services/shorts-upload.js')
    const state = await readShortsUploadState(shortsDir)
    assert.equal(state.shorts[`${ready.code}-short-1.mp4`]?.state, 'uploaded')
    assert.equal(state.shorts[`${ready.code}-short-1.mp4`]?.video_id, 'short-video-1')

    // …so a retry of the same episode finishes only what is missing: the
    // uploaded Short is never sent again, the one that never went up is.
    const { uploadShortsForEpisode } = await import('../services/shorts-uploader.js')
    acceptingUpload(fake, 'https://fake.youtube.test/resumable/short-session-2', 'short-video-2')
    const retry = await uploadShortsForEpisode(ready.slug, ready.code)
    assert.equal(
      retry.outcomes.some(outcome => outcome.file === `${ready.code}-short-1.mp4`),
      false,
      'the uploaded Short is not uploaded again',
    )
    assert.ok(retry.lines.some(line => /already on YouTube/.test(line)), retry.lines.join('\n'))
    // The retry admitted a job for the missing Short. Drain it HERE, under this
    // test's fake — otherwise it runs under the next test's.
    await settleUploads(ready.slug)
    const episodeSidecar = path.join(
      (await utils.resolveEpisodePaths(ready.slug, ready.code, ready.title)).episode_dir,
      'youtube_upload.json',
    )
    assert.equal(await fs.stat(episodeSidecar).then(() => true, () => false), false,
      'a Short does not overwrite the episode upload record')
  })

  test('a Short asked for as public still goes up private', async () => {
    // The rule is about the artefact, not the request: nothing can ask for a
    // public Short, so the only way one becomes public is YouTube flipping it
    // on the date the owner chose.
    const ready = await project('Shorts never public')
    await withShorts(ready)
    await withFinalVideo(ready)

    // A fake transport BEFORE the admission: the job this test enqueues must
    // never reach the real network, and must not outlive the test.
    const fake = new FakeYouTube()
    acceptingUpload(fake, 'https://fake.youtube.test/resumable/never-public', 'short-video-never-public')
    youtube.__setYouTubeTransportForTests(fake.transport())

    const { admitYouTubeUpload } = await import('../routes/youtube-upload-center.js')
    const admission = await admitYouTubeUpload(ready.slug, {
      episode_code: ready.code,
      privacy_status: 'public',
      short_source: { id: `${ready.code}-S1`, file: `${ready.code}-short-1.mp4`, title: 'The first watch' },
    }, { automatic: true })
    assert.equal(admission.status, 200, JSON.stringify(admission.json))
    assert.equal(admission.json.privacy_status, 'private')

    // …and the job that will do the upload was admitted with private too.
    const { getJobs } = await import('../services/job-queue.js')
    const queued = (await getJobs(ready.slug, { type: 'youtube_upload' }))
      .find(job => job.episode_id === `${ready.code}-S1`)
    assert.ok(queued, 'the admission queued the Short upload')
    assert.equal(queued!.params.privacy_status, 'private')
    assert.equal(queued!.params.scheduled_for, undefined, 'no publish date was invented')

    // The admitted payload is one thing; what actually LEFT is the proof.
    await settleUploads(ready.slug)
    const init = fake.calls.find(call => call.method === 'POST' && call.path.includes('uploadType=resumable'))
    assert.ok(init, 'the upload was started')
    const sent = JSON.parse(init!.body || '{}')
    assert.equal(sent.status.privacyStatus, 'private', 'a public request still sends private')
    assert.equal(sent.status.publishAt, undefined, 'no date was invented for an undated Short')
  })

  test('scheduled uploads the Short private with the publish date YouTube will use', async () => {
    const ready = await project('Shorts scheduled upload')
    await withShorts(ready)
    await withFinalVideo(ready)
    const parentDate = new Date(Date.now() + 2 * 86_400_000).toISOString()
    // The episode's own publish date, which the Short's dates are measured from.
    const { setScheduledFor } = await import('../services/upload-sidecar.js')
    await setScheduledFor(ready.slug, ready.code, ready.title, 'youtube', parentDate)
    await pm.updateConfig(ready.slug, { shorts_auto_upload: 'scheduled', shorts_upload_spacing_days: 1 } as any)

    const fake = new FakeYouTube()
    // Two Shorts, so two of everything.
    for (let index = 0; index < 2; index += 1) {
      fake.respond({
        method: 'POST',
        path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        body: {},
        headers: { Location: 'https://fake.youtube.test/resumable/short-scheduled' },
      })
      fake.respond({ method: 'PUT', path: '/resumable/short-scheduled', body: { id: `short-video-scheduled-${index}` } })
      fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
    }
    youtube.__setYouTubeTransportForTests(fake.transport())

    const { uploadShortsForEpisode } = await import('../services/shorts-uploader.js')
    const report = await uploadShortsForEpisode(ready.slug, ready.code)
    assert.equal(report.uploaded, 2, report.lines.join('\n'))

    // The admission queues the uploads; the queue runs them. Drain both HERE,
    // under this test's fake — otherwise they run under the next test's.
    await settleUploads(ready.slug)

    // The inserts are the proof: exactly the two Shorts this test admitted,
    // each PRIVATE, each carrying a publish date in the future, and never a
    // visibility change. Asserted over ALL of them rather than the first —
    // an insert from a job this test did not admit must fail the test
    // loudly instead of quietly answering it.
    const inits = fake.calls.filter(call => call.method === 'POST' && call.path.includes('uploadType=resumable'))
    assert.equal(inits.length, 2, `expected exactly the two Shorts of this episode; got ${inits.length}`)
    for (const init of inits) {
      const sent = JSON.parse(init.body || '{}')
      assert.equal(sent.status.privacyStatus, 'private', 'a scheduled Short is still uploaded private')
      assert.ok(sent.status.publishAt, 'the Short carries a publish date')
      assert.ok(Date.parse(sent.status.publishAt) > Date.now(), 'the publish date is in the future')
      assert.doesNotMatch(init.body || '', /"privacyStatus"\s*:\s*"public"/, init.path)
    }
    // …and the report the Shorts job logs agrees with what was sent.
    assert.equal(report.outcomes.length, 2)
    for (const outcome of report.outcomes) assert.ok(outcome.publish_at, `${outcome.file} was admitted with a date`)
  })
})

describe('the automatic upload after the Shorts are verified', () => {
  test('a failed upload is loud, and fails neither the Shorts nor the episode', async () => {
    const ready = await project('Shorts automatic failure')
    await withShorts(ready)
    await pm.updateConfig(ready.slug, { shorts_auto_upload: 'private' } as any)

    // This episode's final has no Final Check of its own, and a Short is cut
    // from that final — so the admission refuses the upload before anything
    // is sent, and says so in the Shorts job's log. The refusal, not the
    // network, is what fails here; what the test pins is that a refused
    // upload is loud and reaches neither the Shorts nor the episode.
    const fake = new FakeYouTube()
    fake.respond({
      method: 'POST',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      status: 400,
      body: { error: { code: 400, message: 'the provider said no' } },
    })
    youtube.__setYouTubeTransportForTests(fake.transport())

    // The step that runs after the Shorts are verified — the one whose
    // failure must not reach the episode.
    const { uploadShortsAfterVerification } = await import('../services/episode-shorts.js')
    const job: any = {
      job_id: 'shorts-job', project_slug: ready.slug, episode_id: ready.code,
      type: 'episode_shorts', title: 'Episode Shorts', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, error: null, output_lines: [], progress: 0,
      params: { count: 2 },
    }
    await uploadShortsAfterVerification(job, ready.slug, ready.code)
    assert.equal(job.error, null, 'the Shorts job did not fail')
    assert.ok(
      job.output_lines.some((line: string) => /not uploaded/i.test(line)),
      job.output_lines.join('\n'),
    )
    assert.equal(job.result.shorts_upload.upload_failed, true)
    // The clips are exactly where they were.
    const dir = path.join((await utils.resolveEpisodePaths(ready.slug, ready.code, ready.title)).episode_dir, 'shorts')
    for (const index of [1, 2]) {
      assert.ok((await fs.stat(path.join(dir, `${ready.code}-short-${index}.mp4`))).isFile())
    }
  })
})
