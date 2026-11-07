/**
 * Integration tests for the optional closed-captions step of the YouTube
 * upload job (Story 386 Item 17).
 *
 * The service's own network behaviour is covered by
 * `youtube-caption-upload.test.ts`; these tests prove the WIRING:
 * - OFF by default: no captions call and no captions checkpoint.
 * - Captions run only AFTER the permanent video checkpoint, so an accepted
 *   video is never re-uploaded because its caption track failed.
 * - The confirmed request's choice wins; without one, this channel's stored
 *   `caption_settings` is read.
 * - A caption failure is recorded truthfully in the episode's existing upload
 *   sidecar and reported on the job, while the video upload still succeeds.
 * - A retry of an accepted video repairs captions only (list before insert, so
 *   a lost response cannot duplicate the track) and never uploads the video
 *   again.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { tinyVideoWithSoundBytes as tinyVideoBytes } from './fixtures/tiny-video.js'
import sharp from 'sharp'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
} from '../lib/youtube-client.js'
import { generateYoutubeUpload } from '../generators/youtube-upload.js'
import { createProject, updateConfig } from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { readSidecarRaw } from '../services/upload-sidecar.js'
import { listYouTubeOperations } from '../services/youtube-operation-store.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
} from '../services/youtube-connection-store.js'
import { buildYouTubeMetadataPackage, resolveYouTubeUploadSettings } from '../services/youtube-metadata-package.js'
import { resolveSourceRevision } from '../services/youtube-operation-recorder.js'

let cleanup: (() => Promise<void>) | undefined
const reviewedParamsBySlug = new Map<string, Record<string, unknown>>()

afterEach(async () => {
  __resetYouTubeTransportForTests()
  reviewedParamsBySlug.clear()
  await cleanup?.()
  cleanup = undefined
})

const CODE = 'EP0001'
const TITLE = 'Caption Integration Episode'
const CHANNEL = 'UC-caption-integration'
const SESSION = 'https://upload.youtube.test/resumable/caption-session'
const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'

const SRT_CONTENT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'First line of caption',
  '',
  '2',
  '00:00:05,000 --> 00:00:08,000',
  'Second line of caption',
  '',
].join('\n')

async function setUp(): Promise<{ slug: string; accountId: string; paths: Awaited<ReturnType<typeof resolveEpisodePaths>> }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Caption Integration Project' })
  const slug = project.slug
  const projectDir = path.join(temp.dir, 'projects', slug)

  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', episode_code: CODE, title: TITLE, status: 'accepted' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))

  const paths = await resolveEpisodePaths(slug, CODE, TITLE)
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'A Real Episode Title', description: 'A real description.', tags: ['alpha', 'beta'],
  }))
  await fs.mkdir(paths.video_dir, { recursive: true })
  const sourcePath = path.join(paths.video_dir, `${CODE}_final_video.mp4`)
  await fs.writeFile(sourcePath, tinyVideoBytes())
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await sharp({ create: { width: 16, height: 9, channels: 3, background: '#335577' } })
    .png().toFile(path.join(paths.thumb_dir, `${CODE}_Thumb01_v1.png`))
  // This episode's own stitched subtitle file — the only file the caption step
  // is allowed to read for it.
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.writeFile(path.join(paths.subtitles_dir, `${CODE}_stitched.srt`), SRT_CONTENT)

  const settings = await resolveYouTubeUploadSettings(slug)
  const approved = await buildYouTubeMetadataPackage({
    project_slug: slug,
    episode_code: CODE,
    privacy_status: 'private',
    mark_as_ai_generated: settings.mark_as_ai_generated,
    ...(settings.category_id !== undefined ? { category_id: settings.category_id } : {}),
    fallback_title: TITLE,
  })
  reviewedParamsBySlug.set(slug, {
    expected_channel_id: CHANNEL,
    expected_source_revision: await resolveSourceRevision(sourcePath),
    expected_package_revision: approved.package_revision,
    approved_final_payload: approved.final_payload,
    approved_upload_mode: 'private',
  })

  await configureYouTubeApplication({ client_id: 'caption-client', client_secret: 'caption-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Caption Channel', granted_scopes: ['youtube.upload', FORCE_SSL_SCOPE] },
    tokens: { access_token: 'caption-access', refresh_token: 'caption-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await assignProjectYouTubeChannel({ project_slug: slug, channel_id: CHANNEL, expected_previous_channel_id: null })

  return { slug, accountId: `registry:${CHANNEL}`, paths }
}

/** The video upload itself, plus every captions endpoint this job may reach. */
function fakeUploadAndCaptions(options: { listStatus?: number; insertStatus?: number } = {}): FakeYouTube {
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    body: {},
    headers: { Location: SESSION },
  })
  fake.respond({ method: 'PUT', path: '/resumable/caption-session', body: { id: 'video-caption-1' } })
  fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
  fake.respondMatching({
    method: 'GET',
    match: /\/youtube\/v3\/captions\?/,
    status: options.listStatus ?? 200,
    body: options.listStatus && options.listStatus >= 400
      ? { error: { message: 'caption listing failed' } }
      : { items: [] },
  })
  fake.respondMatching({
    method: 'POST',
    match: /\/upload\/youtube\/v3\/captions\?/,
    status: options.insertStatus ?? 200,
    body: options.insertStatus && options.insertStatus >= 400
      ? { error: { message: 'caption insert failed' } }
      : { id: 'caption-1', snippet: { language: 'en', name: 'English' } },
  })
  return fake
}

function job(slug: string, accountId: string, captions?: unknown): any {
  return {
    job_id: `job-${Math.random().toString(16).slice(2)}`,
    project_slug: slug,
    episode_id: CODE,
    output_lines: [] as string[],
    params: {
      episode_id: CODE,
      account_id: accountId,
      ...(captions !== undefined ? { captions } : {}),
      ...(reviewedParamsBySlug.get(slug) ?? {}),
    },
  }
}

const enabledCaptions = {
  enabled: true,
  language: 'en',
  track_name: 'English',
  is_draft: false,
  dedupe_mode: 'skip_if_exists',
  preferred_source: 'auto',
}

function captionCalls(fake: FakeYouTube): string[] {
  return fake.calls
    .filter(call => call.path.includes('/captions'))
    .map(call => `${call.method} ${call.path}`)
}

function videoInitCalls(fake: FakeYouTube): number {
  return fake.calls.filter(call => call.method === 'POST' && call.path.includes('/upload/youtube/v3/videos')).length
}

describe('youtube upload — optional captions', () => {
  test('uploads this episode’s own subtitle track after the video is accepted and records it in the sidecar', async () => {
    const { slug, accountId } = await setUp()
    const fake = fakeUploadAndCaptions()
    __setYouTubeTransportForTests(fake.transport())

    const running = job(slug, accountId, enabledCaptions)
    await generateYoutubeUpload(running)

    const calls = captionCalls(fake)
    assert.equal(calls.filter(call => call.startsWith('GET ')).length, 1, 'existing tracks are listed before insert')
    assert.equal(calls.filter(call => call.startsWith('POST ')).length, 1, 'one caption track inserted')
    assert.equal(videoInitCalls(fake), 1, 'the video is uploaded exactly once')

    const sidecar = await readSidecarRaw(slug, CODE, TITLE, 'youtube') as any
    assert.equal(sidecar?.video_id, 'video-caption-1')
    assert.equal(sidecar?.caption_upload?.status, 'uploaded')
    assert.equal(sidecar?.caption_upload?.caption_id, 'caption-1')
    assert.equal(sidecar?.caption_upload?.language, 'en')
    assert.ok(sidecar?.caption_upload?.uploaded_at, 'an uploaded track records when it was accepted')
    assert.equal((running.result as any)?.captions?.status, 'uploaded')

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations.length, 1)
    assert.equal(operations[0]!.video_id, 'video-caption-1')
  })

  test('is OFF by default: no captions call and no captions checkpoint', async () => {
    const { slug, accountId } = await setUp()
    const fake = fakeUploadAndCaptions()
    __setYouTubeTransportForTests(fake.transport())

    await generateYoutubeUpload(job(slug, accountId))

    assert.deepEqual(captionCalls(fake), [], 'no captions endpoint is touched while the setting is off')
    const sidecar = await readSidecarRaw(slug, CODE, TITLE, 'youtube') as any
    assert.equal(sidecar?.video_id, 'video-caption-1')
    assert.equal(sidecar?.caption_upload, undefined)
  })

  test('reads this channel’s stored caption_settings when the request carries no choice', async () => {
    const { slug, accountId } = await setUp()
    await updateConfig(slug, { caption_settings: enabledCaptions } as any)
    const fake = fakeUploadAndCaptions()
    __setYouTubeTransportForTests(fake.transport())

    await generateYoutubeUpload(job(slug, accountId))

    assert.equal(captionCalls(fake).length, 2, 'list then insert')
    assert.equal((await readSidecarRaw(slug, CODE, TITLE, 'youtube') as any)?.caption_upload?.status, 'uploaded')
  })

  test('the confirmed request’s choice wins over the stored setting', async () => {
    const { slug, accountId } = await setUp()
    await updateConfig(slug, { caption_settings: enabledCaptions } as any)
    const fake = fakeUploadAndCaptions()
    __setYouTubeTransportForTests(fake.transport())

    await generateYoutubeUpload(job(slug, accountId, { ...enabledCaptions, enabled: false }))

    assert.deepEqual(captionCalls(fake), [], 'the upload’s own OFF choice is respected')
    assert.equal((await readSidecarRaw(slug, CODE, TITLE, 'youtube') as any)?.caption_upload, undefined)
  })

  test('a caption failure preserves the accepted video and is recorded truthfully', async () => {
    const { slug, accountId } = await setUp()
    const fake = fakeUploadAndCaptions({ listStatus: 500 })
    __setYouTubeTransportForTests(fake.transport())

    const running = job(slug, accountId, enabledCaptions)
    await generateYoutubeUpload(running)

    assert.equal(videoInitCalls(fake), 1)
    const sidecar = await readSidecarRaw(slug, CODE, TITLE, 'youtube') as any
    assert.equal(sidecar?.video_id, 'video-caption-1', 'the accepted video identity is kept')
    assert.equal(sidecar?.thumbnail_set, true, 'the required thumbnail still ran')
    assert.equal(sidecar?.caption_upload?.status, 'failed')
    assert.ok(sidecar?.caption_upload?.error, 'the honest reason is recorded')
    assert.equal((running.result as any)?.captions?.status, 'failed')
    assert.ok(((running.result as any)?.warnings || []).some((line: string) => line.includes('Closed captions were not uploaded')))

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations[0]!.video_id, 'video-caption-1')
    assert.equal(operations[0]!.lifecycle, 'accepted')
  })

  test('a retry repairs captions only, listing before insert and never uploading the video again', async () => {
    const { slug, accountId } = await setUp()
    const first = fakeUploadAndCaptions({ listStatus: 500 })
    __setYouTubeTransportForTests(first.transport())
    await generateYoutubeUpload(job(slug, accountId, enabledCaptions))
    assert.equal((await readSidecarRaw(slug, CODE, TITLE, 'youtube') as any)?.caption_upload?.status, 'failed')

    // The retry reaches the already-accepted video and repairs only captions.
    const retry = fakeUploadAndCaptions()
    __setYouTubeTransportForTests(retry.transport())
    const running = job(slug, accountId, enabledCaptions)
    await generateYoutubeUpload(running)

    assert.equal(videoInitCalls(retry), 0, 'the video is not uploaded again')
    const calls = captionCalls(retry)
    assert.equal(calls.filter(call => call.startsWith('GET ')).length, 1, 'existing tracks are reconciled before insert')
    assert.equal(calls.filter(call => call.startsWith('POST ')).length, 1)
    const sidecar = await readSidecarRaw(slug, CODE, TITLE, 'youtube') as any
    assert.equal(sidecar?.caption_upload?.status, 'uploaded')
    assert.equal(sidecar?.caption_upload?.caption_id, 'caption-1')
    assert.equal(videoInitCalls(first) + videoInitCalls(retry), 1, 'exactly one video upload across both runs')
  })
})
