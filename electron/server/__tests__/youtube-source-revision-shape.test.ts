/**
 * The confirmation is about the VIDEO, and a value that is not the video's revision is refused by
 * name — at admission and on retry.
 *
 * A preview answers with two similarly named values: the package's `source_sha256` (a hash of
 * title/description/tags, bare 64-hex) and `source.revision` (the rendered file, `sha256:` + 64 hex).
 * Production's own script sent the former where the latter belongs on 2026-11-21; the route trimmed and
 * accepted it, queued the upload, and the job then failed hours later with "the rendered video changed"
 * while the video sat untouched. These tests are the check that makes that impossible: refused at the
 * door, refused on retry, and the refusal names the field.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

const boot = await useTempDataDir()
const connections = await import('../services/youtube-connection-store.js')
const projects = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const utils = await import('../services/utils.js')
const jq = await import('../services/job-queue.js')
const { router: uploadCenterRouter } = await import('../routes/youtube-upload-center.js')
const { router: jobsRouter } = await import('../routes/jobs.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', uploadCenterRouter)
app.use('/api', jobsRouter)

const CHANNEL = 'UC-shape-check'
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await jq.setQueuePaused(false)
  // The queue writes its row asynchronously; draining before the data dir goes closes the window where
  // a later write landed in a temp root that no longer belonged to this test.
  await jq._waitForJobPersistenceForTesting()
  await cleanup?.()
  cleanup = undefined
})

async function scenario(): Promise<{ slug: string; code: string; title: string; videoPath: string }> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const project = await projects.createProject({ name: 'Revision shape' })
  await connections.configureYouTubeApplication({
    client_id: 'shape-check-client', client_secret: 'task12-plan-client-secret',
  })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Shape Check Channel', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'task12-plan-access', refresh_token: 'task12-plan-refresh',
      expires_at: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })

  const title = 'A finished episode'
  const [idea] = await ideas.addIdeas(project.slug, [{
    title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'shape-test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id)
  const code = accepted.idea.episode_code!
  const paths = await utils.resolveEpisodePaths(project.slug, code, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  const videoPath = path.join(paths.video_dir, `${code}_final_video.mp4`)
  await fs.writeFile(videoPath, Buffer.alloc(2048, 7))
  // A passed final check bound to THIS file, so the route's own gate does not answer first.
  const stat = await fs.stat(videoPath)
  await fs.writeFile(`${videoPath}.finalcheck.json`, JSON.stringify({
    passed: true, issues: [], file: { size: stat.size, mtime_ms: stat.mtimeMs },
  }))
  return { slug: project.slug, code, title, videoPath }
}

const BARE_METADATA_HASH = 'a'.repeat(64)

test('an admission carrying a bare 64-hex value is refused by name, and nothing is queued', async () => {
  const { slug, code } = await scenario()
  const response = await request(app)
    .post(`/api/projects/${slug}/youtube/upload`)
    .send({
      episode_code: code,
      confirm: true,
      expected_channel_id: CHANNEL,
      expected_package_revision: 'not-checked-before-the-shape',
      expected_source_revision: BARE_METADATA_HASH,
      privacy_status: 'private',
    })

  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.equal(response.body.code, 'YOUTUBE_SOURCE_REVISION_INVALID')
  assert.match(String(response.body.detail), /expected_source_revision/)
  assert.match(String(response.body.detail), /sha256:/)
  assert.match(String(response.body.detail), /metadata hash/)

  const uploads = await jq.getJobs(slug, { type: 'youtube_upload' })
  assert.equal(uploads.length, 0, 'a refused admission queues nothing')
})

test('a preview-shaped value is accepted by the shape check and reaches the next gate', async () => {
  const { slug, code } = await scenario()
  const response = await request(app)
    .post(`/api/projects/${slug}/youtube/upload`)
    .send({
      episode_code: code,
      confirm: true,
      expected_channel_id: CHANNEL,
      // A correct-shaped revision with a stale package revision: the next gate answers, which proves
      // the shape check let it through rather than blocking everything.
      expected_package_revision: 'stale-on-purpose',
      expected_source_revision: `sha256:${'b'.repeat(64)}`,
      privacy_status: 'private',
    })

  assert.notEqual(response.status, 400, JSON.stringify(response.body))
  assert.notEqual(response.body.code, 'YOUTUBE_SOURCE_REVISION_INVALID', JSON.stringify(response.body))
})

test('a retry of an upload saved with the metadata hash is refused, not carried forward', async () => {
  const { slug, code } = await scenario()
  await jq.setQueuePaused(true)
  const job = jq.enqueuePreparedForTest({
    project_slug: slug,
    type: 'youtube_upload',
    episode_id: code,
    title: 'queued with the wrong value',
    params: {
      episode_id: code,
      expected_channel_id: CHANNEL,
      expected_package_revision: 'package',
      expected_source_revision: BARE_METADATA_HASH,
      approved_final_payload: {},
      approved_upload_mode: 'private',
    },
  })
  const response = await request(app)
    .post(`/api/projects/${slug}/jobs/${job.job_id}/retry`)
    .send({})

  assert.equal(response.status, 409, JSON.stringify(response.body))
  assert.match(String(response.body.detail ?? response.body.error ?? ''), /sha256:/)
  assert.match(String(response.body.detail ?? response.body.error ?? ''), /not the rendered video/)
})
