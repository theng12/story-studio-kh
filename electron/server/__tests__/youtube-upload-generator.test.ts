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
import * as store from '../services/upload-store.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
} from '../services/youtube-connection-store.js'
import { listYouTubeOperations } from '../services/youtube-operation-store.js'
import { readYouTubeProjectPublishingState } from '../services/youtube-project-publishing-store.js'
import { recordYouTubeQuotaAttempt } from '../services/youtube-quota-ledger.js'
import { readYouTubeConnectionRegistry } from '../services/youtube-connection-store.js'
import { buildYouTubeMetadataPackage, resolveYouTubeUploadSettings } from '../services/youtube-metadata-package.js'
import { thumbnailFileHash } from '../services/thumbnail-scoring.js'
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
const TITLE = 'Generator Episode'
const CHANNEL = 'UC-generator'
const SESSION = 'https://upload.youtube.test/resumable/session-abc'

async function setUp(assign: boolean): Promise<{ slug: string; accountId: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Generator Project' })
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
  // The thumbnail is required (2026-10-07), so every episode here has one.
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await sharp({ create: { width: 16, height: 9, channels: 3, background: '#335577' } })
    .png().toFile(path.join(paths.thumb_dir, `${CODE}_Thumb01_v1.png`))

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

  if (assign) {
    await configureYouTubeApplication({ client_id: 'generator-client', client_secret: 'generator-secret-value' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Generator Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'generator-access', refresh_token: 'generator-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({ project_slug: slug, channel_id: CHANNEL, expected_previous_channel_id: null })
  }
  return { slug, accountId: `registry:${CHANNEL}` }
}

/** Sets one safety check's mode on this channel (1.4.300). */
const setSafety = (slug: string, id: string, mode: 'off' | 'warn' | 'block') =>
  updateConfig(slug, { safety_checks: { [id]: mode } } as any)

function fakeAcceptingUpload(videoId: string): FakeYouTube {
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    body: {},
    headers: { Location: SESSION },
  })
  fake.respond({ method: 'PUT', path: '/resumable/session-abc', body: { id: videoId } })
  fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, body: {} })
  return fake
}

/** Thumbnail calls in hand-written transports: accepted. */
function thumbnailResponse(url: string): Response | null {
  return url.includes('/thumbnails/set') ? new Response('{}', { status: 200 }) : null
}

function job(slug: string, accountId: string): any {
  return {
    job_id: `job-${Math.random().toString(16).slice(2)}`,
    project_slug: slug,
    episode_id: CODE,
    output_lines: [] as string[],
    params: { episode_id: CODE, account_id: accountId, ...(reviewedParamsBySlug.get(slug) ?? {}) },
  }
}

async function readUploadBody(body: unknown): Promise<Buffer> {
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) return Buffer.concat(chunks)
    chunks.push(Buffer.from(next.value))
  }
}

describe('youtube upload generator', () => {
  test('an assigned project gets a durable accepted operation and episode link', async () => {
    const { slug, accountId } = await setUp(true)
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-generated').transport())

    const running = job(slug, accountId)
    await generateYoutubeUpload(running)

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations.length, 1, 'exactly one durable operation')
    const record = operations[0]!
    assert.equal(record.lifecycle, 'accepted')
    assert.equal(record.video_id, 'video-generated')
    assert.equal(record.channel_id, CHANNEL)
    assert.equal(record.episode_code, CODE)
    // The accepted payload is the canonical package, so preview/upload
    // equality is checkable from the record alone.
    assert.equal(JSON.parse(record.final_payload!.snippet_json).title, 'A Real Episode Title')

    const state = await readYouTubeProjectPublishingState(slug)
    assert.equal(state.episode_video_links[CODE]?.video_id, 'video-generated')


    // No credential ever reaches the job log the operator reads.
    const log = running.output_lines.join('\n')
    assert.equal(log.includes(SESSION), false, 'the resumable session URL is a credential')
    assert.equal(log.includes('generator-access-token'), false)
    assert.equal(log.includes('generator-secret-value'), false)
  })

  test('hashes and uploads one pinned render when its final path is replaced mid-upload', async () => {
    const { slug, accountId } = await setUp(true)
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    const sourcePath = path.join(paths.video_dir, `${CODE}_final_video.mp4`)
    const original = await fs.readFile(sourcePath)
    const recordedRevision = await resolveSourceRevision(sourcePath)
    const replacement = path.join(paths.video_dir, 'new-final.mp4')
    await fs.writeFile(replacement, Buffer.alloc(original.length, 0x7f))
    let uploadedBytes: Buffer | undefined

    __setYouTubeTransportForTests((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const thumb = thumbnailResponse(url)
      if (thumb) return thumb
      if (init?.method === 'POST') {
        await fs.rename(replacement, sourcePath)
        return new Response('{}', { status: 200, headers: { Location: SESSION } })
      }
      assert.equal(url, SESSION)
      uploadedBytes = await readUploadBody(init?.body)
      return new Response(JSON.stringify({ id: 'pinned-render' }), { status: 200 })
    }) as typeof fetch)

    await generateYoutubeUpload(job(slug, accountId))

    assert.deepEqual(uploadedBytes, original, 'the provider receives the render that was hashed')
    const [operation] = await listYouTubeOperations(slug)
    assert.equal(operation?.source_revision, recordedRevision)
    assert.notEqual(await resolveSourceRevision(sourcePath), recordedRevision, 'the pathname now names the replacement')
  })

  test('the thumbnail is required: an explicit no-thumbnail upload is refused before any quota is spent', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'thumbnail_present', 'block')
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())
    const running = job(slug, accountId)
    running.params.thumbnail_filename = null

    await assert.rejects(generateYoutubeUpload(running), /A thumbnail is required to upload EP0001.*Nothing was uploaded/)
    assert.equal(fake.calls.length, 0, 'YouTube was never contacted')
    assert.equal((await listYouTubeOperations(slug)).length, 0)
  })

  test('an episode with no thumbnail at all is refused before any quota is spent', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'thumbnail_present', 'block')
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    await fs.rename(paths.thumb_dir, `${paths.thumb_dir}-moved`)
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)), /this episode has none/)
    assert.equal(fake.calls.length, 0)
  })

  test('a thumbnail changed under the same filename is refused before provider work or an operation', async () => {
    const { slug, accountId } = await setUp(true)
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    const reviewed = reviewedParamsBySlug.get(slug)!
    // Same name, different picture: the defect this pins is a filename-only
    // revision, which cannot tell these two apart.
    await sharp({ create: { width: 16, height: 9, channels: 3, background: '#aa3322' } })
      .png().toFile(path.join(paths.thumb_dir, `${CODE}_Thumb01_v1.png`))

    const settings = await resolveYouTubeUploadSettings(slug)
    const rebuilt = await buildYouTubeMetadataPackage({
      project_slug: slug,
      episode_code: CODE,
      privacy_status: 'private',
      mark_as_ai_generated: settings.mark_as_ai_generated,
      ...(settings.category_id !== undefined ? { category_id: settings.category_id } : {}),
      fallback_title: TITLE,
    })
    assert.notEqual(rebuilt.package_revision, reviewed.expected_package_revision,
      'the preview revision covers the picture, so confirmation sees a changed one')

    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(
      generateYoutubeUpload(job(slug, accountId)),
      /thumbnail approved for EP0001 changed after confirmation.*Preview and confirm the upload again/,
    )
    assert.equal(fake.calls.length, 0, 'YouTube was never contacted')
    assert.equal((await listYouTubeOperations(slug)).length, 0, 'no durable operation was opened')
  })

  test('the unchanged approved thumbnail still uploads, and an absent thumbnail stays valid', async () => {
    const { slug, accountId } = await setUp(true)
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    const approved = reviewedParamsBySlug.get(slug)!.approved_final_payload as Record<string, string>
    assert.equal(
      approved.thumbnail_sha256,
      await thumbnailFileHash(path.join(paths.thumb_dir, `${CODE}_Thumb01_v1.png`)),
      'the frozen payload carries the approved picture, not just its name',
    )

    const fake = fakeAcceptingUpload('video-thumb-unchanged')
    __setYouTubeTransportForTests(fake.transport())
    await generateYoutubeUpload(job(slug, accountId))
    assert.equal((await listYouTubeOperations(slug))[0]?.video_id, 'video-thumb-unchanged')

    const settings = await resolveYouTubeUploadSettings(slug)
    const absent = await buildYouTubeMetadataPackage({
      project_slug: slug,
      episode_code: CODE,
      privacy_status: 'private',
      mark_as_ai_generated: settings.mark_as_ai_generated,
      ...(settings.category_id !== undefined ? { category_id: settings.category_id } : {}),
      fallback_title: TITLE,
      thumbnail_filename: null,
    })
    assert.equal(absent.thumbnail_filename, null)
    assert.equal(absent.final_payload.thumbnail_sha256, undefined)
  })

  test('a thumbnail replaced during the video transfer is refused, keeping the accepted video', async () => {
    const { slug, accountId } = await setUp(true)
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    let thumbnailCalls = 0
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/thumbnails/set')) {
        thumbnailCalls++
        return new Response('{}', { status: 200 })
      }
      if ((init?.method || 'GET') === 'POST' && url.includes('/upload/youtube/v3/videos')) {
        return new Response('', { status: 200, headers: { Location: SESSION } })
      }
      if ((init?.method || 'GET') === 'PUT' && url === SESSION) {
        // Same name, different picture while the video bytes are in flight.
        await sharp({ create: { width: 16, height: 9, channels: 3, background: '#aa3322' } })
          .png().toFile(path.join(paths.thumb_dir, `${CODE}_Thumb01_v1.png`))
        return new Response(JSON.stringify({ id: 'video-thumb-raced' }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url}`)
    }) as typeof fetch)

    await assert.rejects(
      generateYoutubeUpload(job(slug, accountId)),
      /thumbnail approved for EP0001 changed after confirmation.*Preview and confirm the upload again/,
    )
    assert.equal(thumbnailCalls, 0, 'the unreviewed picture was never sent')
    const [record] = await listYouTubeOperations(slug)
    assert.equal(record?.video_id, 'video-thumb-raced', 'the accepted video is preserved')
    assert.equal(record?.lifecycle, 'accepted')
    const { readSidecarRaw } = await import('../services/upload-sidecar.js')
    assert.equal((await readSidecarRaw(slug, CODE, TITLE, 'youtube'))?.thumbnail_set, false)
  })

  test('a thumbnail that fails twice fails the job with the video kept, and Retry sets only the thumbnail', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'thumbnail_present', 'block')
    const fake = new FakeYouTube()
    fake.respond({
      method: 'POST',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      body: {},
      headers: { Location: SESSION },
    })
    fake.respond({ method: 'PUT', path: '/resumable/session-abc', body: { id: 'video-thumb-later' } })
    fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, status: 403, body: { error: { message: 'forbidden' } } })
    fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, status: 403, body: { error: { message: 'forbidden' } } })
    __setYouTubeTransportForTests(fake.transport())

    const first = job(slug, accountId)
    await assert.rejects(generateYoutubeUpload(first), /Uploaded as https:\/\/youtu\.be\/video-thumb-later, but the thumbnail could not be set.*Retry to set only the thumbnail/s)
    assert.equal(first.output_lines.filter((line: string) => /Thumbnail attempt \d of 2 failed/.test(line)).length, 2, 'setThumbnail was retried')
    const { readSidecarRaw } = await import('../services/upload-sidecar.js')
    const kept = await readSidecarRaw(slug, CODE, TITLE, 'youtube')
    assert.equal(kept?.video_id, 'video-thumb-later', 'the video id is kept')
    assert.equal(kept?.thumbnail_set, false)

    // Retry: no video request at all, only the thumbnail.
    const retryFake = new FakeYouTube()
    retryFake.respondMatching({ method: 'POST', match: /\/thumbnails\/set\?videoId=video-thumb-later/, body: {} })
    __setYouTubeTransportForTests(retryFake.transport())
    const retry = job(slug, accountId)
    await generateYoutubeUpload(retry)
    assert.equal(retryFake.calls.length, 1, 'exactly one request: the thumbnail')
    assert.match(retry.output_lines.join('\n'), /setting only the thumbnail; the video is not uploaded again/)
    assert.equal((await readSidecarRaw(slug, CODE, TITLE, 'youtube'))?.thumbnail_set, true)
    assert.equal((await listYouTubeOperations(slug)).length, 1, 'still one upload')
  })

  test('a failed playlist add is a visible warning in the job result, not silence', async () => {
    const { slug, accountId } = await setUp(true)
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-playlist-fails').transport())
    const running = job(slug, accountId)
    running.params.playlist_id = 'PL-missing'
    await generateYoutubeUpload(running)
    assert.equal(running.result?.playlist?.added, false)
    assert.equal(running.result?.playlist?.id, 'PL-missing')
    assert.match(String(running.result?.warnings?.[0]), /not added to playlist PL-missing/)
  })

  test('provider acceptance is checkpointed to the pinned channel across an in-flight reassignment', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'thumbnail_present', 'block')
    const secondChannel = 'UC-generator-2'
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: secondChannel, title: 'Second Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'second-access', refresh_token: 'second-refresh', expires_at: Date.now() + 3_600_000 },
    })
    let providerCalls = 0
    __setYouTubeTransportForTests((async (input, init) => {
      providerCalls++
      const url = String(input)
      const thumb = thumbnailResponse(url)
      if (thumb) return thumb
      if ((init?.method || 'GET') === 'POST' && url.includes('/upload/youtube/v3/videos')) {
        return new Response('', { status: 200, headers: { Location: SESSION } })
      }
      if ((init?.method || 'GET') === 'PUT' && url === SESSION) {
        await assignProjectYouTubeChannel({
          project_slug: slug, channel_id: secondChannel, expected_previous_channel_id: CHANNEL,
        })
        return new Response(JSON.stringify({ id: 'video-pinned-channel' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url}`)
    }) as typeof fetch)

    const originalJob = job(slug, accountId)
    // The reassignment also blocks the (required) thumbnail on the old
    // channel, so the job fails on it — with the accepted video kept.
    await assert.rejects(generateYoutubeUpload(originalJob), /Uploaded as https:\/\/youtu\.be\/video-pinned-channel, but the thumbnail could not be set/)
    const [record] = await listYouTubeOperations(slug)
    assert.equal(record?.lifecycle, 'accepted')
    assert.equal(record?.video_id, 'video-pinned-channel')
    assert.equal(record?.channel_id, CHANNEL)
    const state = await readYouTubeProjectPublishingState(slug)
    assert.equal(state.episode_video_links[CODE]?.channel_id, CHANNEL)
    assert.equal((await readYouTubeConnectionRegistry()).assignments[slug]?.channel_id, secondChannel)

    const beforeRetryCalls = providerCalls
    await assert.rejects(generateYoutubeUpload(originalJob), /Reconnect|assigned|not found/i)
    assert.equal(providerCalls, beforeRetryCalls, 'retry under the stale channel never reaches YouTube')
    assert.equal((await listYouTubeOperations(slug)).length, 1)
  })

  test('the legacy private-first upload mode records but never qualifies', async () => {
    // Regression: this was first written as "privacyStatus is private", which
    // is true of EVERY Story Studio upload — so nothing could ever qualify.
    // `private_upload` is the legacy per-platform upload MODE.
    const { slug, accountId } = await setUp(true)
    await store.setUploadMode(slug, 'youtube', 'private')
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-private-mode').transport())

    await generateYoutubeUpload(job(slug, accountId))

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations[0]?.final_action, 'private_upload')
    assert.equal(operations[0]?.lifecycle, 'accepted')
  })

  test('an unassigned project refuses before provider work or an operation record', async () => {
    const { slug, accountId } = await setUp(false)
    const fake = fakeAcceptingUpload('video-legacy')
    __setYouTubeTransportForTests(fake.transport())

    const running = job(slug, accountId)
    await assert.rejects(
      generateYoutubeUpload(running),
      /Reconnect it in Settings → YouTube|not found/,
    )

    assert.equal(await listYouTubeOperations(slug).then(o => o.length), 0, 'no durable record without an assignment')
    assert.equal(fake.calls.length, 0)
  })

  test('a queued upload without a reviewed receipt refuses before probing or provider work', async () => {
    const { slug, accountId } = await setUp(true)
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())
    const running = job(slug, accountId)
    running.params = { episode_id: CODE, account_id: accountId }

    await assert.rejects(
      generateYoutubeUpload(running),
      /predates the required review receipt.*Review and confirm/i,
    )
    assert.equal(fake.calls.length, 0)
    assert.doesNotMatch(running.output_lines.join('\n'), /Probing video with ffprobe/)
  })

  test('a rendered video changed after admission is refused before provider work', async () => {
    const { slug, accountId } = await setUp(true)
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    const sourcePath = path.join(paths.video_dir, `${CODE}_final_video.mp4`)
    const settings = await resolveYouTubeUploadSettings(slug)
    const approved = await buildYouTubeMetadataPackage({
      project_slug: slug,
      episode_code: CODE,
      privacy_status: 'private',
      mark_as_ai_generated: settings.mark_as_ai_generated,
      ...(settings.category_id !== undefined ? { category_id: settings.category_id } : {}),
      fallback_title: TITLE,
    })
    const admittedRevision = await resolveSourceRevision(sourcePath)
    await fs.appendFile(sourcePath, Buffer.from('changed-after-admission'))
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())
    const running = job(slug, accountId)
    running.params = {
      ...running.params,
      expected_channel_id: CHANNEL,
      expected_package_revision: approved.package_revision,
      approved_final_payload: approved.final_payload,
      approved_upload_mode: 'private',
      expected_source_revision: admittedRevision,
    }

    await assert.rejects(generateYoutubeUpload(running), /rendered video changed after confirmation/i)

    assert.equal(fake.calls.length, 0)
    assert.equal((await listYouTubeOperations(slug)).length, 0)
  })

  test('a frozen approval with a blank description is refused with complete live metadata, before any provider call or operation', async () => {
    const { slug, accountId } = await setUp(true)
    // Live metadata is complete (setUp); only the frozen bytes are blank.
    const frozen = reviewedParamsBySlug.get(slug)!.approved_final_payload as Record<string, string>
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())
    const running = job(slug, accountId)
    running.params.approved_final_payload = {
      ...frozen,
      snippet_json: JSON.stringify({ ...JSON.parse(frozen.snippet_json), description: '' }),
    }

    await assert.rejects(generateYoutubeUpload(running), (error: any) => {
      assert.match(error.message, new RegExp(`${CODE} has a blank description`))
      assert.match(error.message, /Review and confirm the exact video and YouTube details again/)
      return true
    })
    assert.equal(fake.calls.length, 0, 'no session or upload request was made')
    assert.equal((await listYouTubeOperations(slug)).length, 0, 'no durable operation was opened')
  })

  test('a valid frozen approval uploads its exact approved description even when live metadata is now blank', async () => {
    const { slug, accountId } = await setUp(true)
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    await fs.writeFile(paths.metadata_json, JSON.stringify({
      title: 'A Real Episode Title', description: '', tags: ['alpha', 'beta'],
    }))
    const fake = fakeAcceptingUpload('video-frozen')
    __setYouTubeTransportForTests(fake.transport())

    await generateYoutubeUpload(job(slug, accountId))

    const init = fake.calls.find(call => call.method === 'POST' && call.path.includes('uploadType=resumable'))
    const sent = typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body)
    assert.match(sent, /"description":"A real description\."/)
    const [operation] = await listYouTubeOperations(slug)
    assert.equal(operation?.lifecycle, 'accepted')
  })

  test('the operation record is opened before the upload, so an interrupted attempt leaves evidence', async () => {
    const { slug, accountId } = await setUp(true)
    const fake = new FakeYouTube()
    fake.respond({
      method: 'POST',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      body: {},
      headers: { Location: SESSION },
    })
    // The PUT is never answered: the upload fails after the record exists.
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)))

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations.length, 1, 'the attempt left a record behind')
    assert.notEqual(operations[0]!.lifecycle, 'accepted')
    assert.equal(operations[0]!.video_id, undefined)
    // Nothing was linked on a failed attempt.
    const state = await readYouTubeProjectPublishingState(slug)
    assert.equal(state.episode_video_links[CODE], undefined)
  })

  test('a corrupt operation index fails closed before any provider request', async () => {
    const { slug, accountId } = await setUp(true)
    const projectDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug)
    const operationsDir = path.join(projectDir, 'youtube', 'operations')
    await fs.mkdir(operationsDir, { recursive: true })
    await fs.writeFile(path.join(operationsDir, 'index.json'), '{broken')
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)), /operation|corrupt/i)
    assert.equal(fake.calls.length, 0)
  })

  test('a quota refusal closes its pre-session operation and a later upload can retry', async () => {
    const { slug, accountId } = await setUp(true)
    const applicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    await recordYouTubeQuotaAttempt({
      application_id: applicationId, channel_id: CHANNEL,
      bucket: 'video_uploads', operation: 'videos_insert', amount: 100,
    })
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)), /quota/i)
    assert.equal(fake.calls.length, 0)
    assert.equal((await listYouTubeOperations(slug))[0]?.lifecycle, 'failed')
  })

  test('an old queued job resumes only its exact recorded session and original init payload', async () => {
    const { slug, accountId } = await setUp(true)
    let initCount = 0
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) {
        initCount += 1
        return new Response('{}', { status: 200, headers: { Location: SESSION } })
      }
      if (url === SESSION) throw new DOMException('simulated process interruption', 'AbortError')
      throw new Error(`Unexpected request: ${init?.method} ${url}`)
    }) as typeof fetch)

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)), /cancelled|interruption/i)
    const interrupted = await listYouTubeOperations(slug)
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0]?.lifecycle, 'uploading')
    assert.ok(interrupted[0]?.resumable?.session_url_hash)
    const originalPayload = interrupted[0]!.final_payload!

    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    await fs.writeFile(paths.metadata_json, JSON.stringify({
      title: 'Changed After Interruption', description: 'new', tags: ['new'],
    }))
    let probeCount = 0
    let chunkCount = 0
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) {
        initCount += 1
        throw new Error('resume must not create a second session')
      }
      const thumb = thumbnailResponse(url)
      if (thumb) return thumb
      if (url !== SESSION) throw new Error(`Unexpected request: ${url}`)
      const headers = new Headers(init?.headers)
      if (headers.get('Content-Range')?.startsWith('bytes */')) {
        probeCount += 1
        return new Response(null, { status: 308 })
      }
      chunkCount += 1
      return new Response(JSON.stringify({ id: 'video-resumed' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    const legacyQueuedJob = job(slug, accountId)
    legacyQueuedJob.params = { episode_id: CODE, account_id: accountId }
    await generateYoutubeUpload(legacyQueuedJob)
    const completed = await listYouTubeOperations(slug)
    assert.equal(initCount, 1)
    assert.equal(probeCount, 1)
    assert.equal(chunkCount, 1)
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.operation_id, interrupted[0]?.operation_id)
    assert.equal(completed[0]?.lifecycle, 'accepted')
    assert.deepEqual(completed[0]?.final_payload, originalPayload)
    assert.equal(JSON.parse(completed[0]!.final_payload!.snippet_json).title, 'A Real Episode Title')
  })

  test('a blank description on the durable resumed operation refuses before any provider call or record mutation', async () => {
    const { slug, accountId } = await setUp(true)
    // First run: interrupted after the session opened, so a durable operation
    // with a stored final_payload and a usable resume sidecar both exist.
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) {
        return new Response('{}', { status: 200, headers: { Location: SESSION } })
      }
      if (url === SESSION) throw new DOMException('simulated process interruption', 'AbortError')
      throw new Error(`Unexpected request: ${init?.method} ${url}`)
    }) as typeof fetch)
    // First run carries the reviewed approval, exactly like the passing resume
    // fixture: only then does it open the durable record and reach the abort.
    const interrupted = job(slug, accountId)
    await assert.rejects(generateYoutubeUpload(interrupted), /cancelled|interruption/i)
    const [before] = await listYouTubeOperations(slug)
    assert.ok(before?.final_payload, 'the interruption left a stored payload')

    // Temp-fixture mutation only: blank the description on THAT record.
    const operationsDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'operations')
    let mutated = 0
    for (const name of await fs.readdir(operationsDir)) {
      if (name === 'index.json' || !name.endsWith('.json')) continue
      const file = path.join(operationsDir, name)
      const record = JSON.parse(await fs.readFile(file, 'utf-8')) as any
      if (record.episode_code !== CODE || !record.final_payload) continue
      const stored = JSON.parse(record.final_payload.snippet_json)
      await fs.writeFile(file, JSON.stringify({
        ...record,
        final_payload: { ...record.final_payload, snippet_json: JSON.stringify({ ...stored, description: '' }) },
      }))
      mutated += 1
    }
    assert.equal(mutated, 1, 'exactly one durable record was rewritten')

    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())
    const resumeAttempt = job(slug, accountId)
    resumeAttempt.params = { episode_id: CODE, account_id: accountId }

    await assert.rejects(generateYoutubeUpload(resumeAttempt), (error: any) => {
      assert.match(error.message, new RegExp(`${CODE} has a blank description`))
      assert.match(error.message, /Review and confirm the exact video and YouTube details again/)
      return true
    })
    assert.equal(fake.calls.length, 0, 'no session, session probe or upload request')
    const [after] = await listYouTubeOperations(slug)
    assert.equal(after?.revision, before!.revision, 'the durable record was not mutated')
    assert.match(after!.final_payload!.snippet_json, /"description":""/)
  })

  test('a restart repairs the sidecar-to-operation hash crash window before any byte PUT', async () => {
    const { slug, accountId } = await setUp(true)
    const operationsDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'operations')
    let initCount = 0
    let bytePuts = 0
    __setYouTubeTransportForTests((async (input) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) {
        initCount += 1
        // The operation exists and is uploading now. Prevent the atomic
        // session-hash checkpoint while leaving the credential sidecar path
        // writable, reproducing the exact crash window after init.
        await fs.chmod(operationsDir, 0o500)
        return new Response('{}', { status: 200, headers: { Location: SESSION } })
      }
      if (url === SESSION) {
        bytePuts += 1
        throw new Error('bytes must not be sent until the operation hash is durable')
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch)

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)))
    await fs.chmod(operationsDir, 0o700)
    const interrupted = await listYouTubeOperations(slug)
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0]?.lifecycle, 'uploading')
    assert.equal(interrupted[0]?.resumable, undefined)
    const originalPayload = interrupted[0]!.final_payload
    assert.equal(bytePuts, 0)

    let probes = 0
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) throw new Error('must reuse the saved session')
      const thumb = thumbnailResponse(url)
      if (thumb) return thumb
      if (url !== SESSION) throw new Error(`Unexpected request: ${url}`)
      const headers = new Headers(init?.headers)
      if (headers.get('Content-Range')?.startsWith('bytes */')) {
        probes += 1
        const repaired = (await listYouTubeOperations(slug))[0]
        assert.ok(repaired?.resumable?.session_url_hash, 'hash is durable before the provider probe')
        return new Response(null, { status: 308 })
      }
      bytePuts += 1
      return new Response(JSON.stringify({ id: 'video-recovered-window' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    await generateYoutubeUpload(job(slug, accountId))
    const completed = (await listYouTubeOperations(slug))[0]!
    assert.equal(initCount, 1)
    assert.equal(probes, 1)
    assert.equal(bytePuts, 1)
    assert.equal(completed.operation_id, interrupted[0]?.operation_id)
    assert.equal(completed.video_id, 'video-recovered-window')
    assert.deepEqual(completed.final_payload, originalPayload)
  })

})

describe('the manual upload job never edits a video that is already published', () => {
  test('it refuses rather than PATCHing when a legacy sidecar names a video', async () => {
    // The fourth review's defect, at the layer that actually talks to YouTube.
    // With a sidecar present the generator's `shouldUpdateOnly` branch PATCHes
    // the LIVE video's title, description and tags and sends no status block at
    // all - while the owner has been told an upload started. The manual route
    // asks `remoteVideoFor` before it does anything, and this is the tripwire
    // that proves the refusal is real.
    const { slug, accountId } = await setUp(true)
    const { writeSidecar } = await import('../services/upload-sidecar.js')
    await writeSidecar(slug, CODE, TITLE, {
      platform: 'youtube', video_id: 'already-live-42', account_id: accountId,
      channel_id: CHANNEL, uploaded_at: new Date().toISOString(), last_sync_at: new Date().toISOString(),
      scheduled_for: null, privacy_status: 'public', title: TITLE, description: 'd', tags: [],
      thumbnail_set: false,
    })

    // A fake that would ACCEPT a PATCH. If the branch is reachable, the test
    // fails by succeeding - which is the point: asserting "no error" here would
    // have proved nothing.
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'PUT', match: /\/youtube\/v3\/videos/, body: { id: 'already-live-42' } })
    __setYouTubeTransportForTests(fake.transport())

    const running = job(slug, accountId)
    await assert.rejects(
      () => generateYoutubeUpload(running),
      /already on YouTube as already-live-42/,
      'the manual job refuses instead of editing a published video',
    )
    assert.equal(fake.calls.length, 0, 'and YouTube was never contacted at all')
  })
})

describe('a fresh upload carries nothing forward from a previous video', () => {
  test('re-uploading after an explicit manual removal does not re-tombstone the new video', async () => {
    // `existing` used to be null on this path, so the spread was dead. Removing
    // the update branch made it LIVE — and the new sidecar inherited the old
    // video's `deleted_at`, so the manual-removal path produced a video that was born
    // tombstoned: invisible to `remoteVideoFor` and immediately re-uploadable.
    const { slug, accountId } = await setUp(true)
    const { writeSidecar, readSidecarRaw } = await import('../services/upload-sidecar.js')
    await writeSidecar(slug, CODE, TITLE, {
      platform: 'youtube', video_id: 'taken-down-1', account_id: accountId,
      channel_id: CHANNEL, uploaded_at: '2026-01-01T00:00:00.000Z',
      last_sync_at: '2026-01-01T00:00:00.000Z', scheduled_for: null,
      privacy_status: 'public', title: TITLE, description: 'old description',
      tags: ['old'], thumbnail_set: true, deleted_at: '2026-02-01T00:00:00.000Z',
      deleted_reason: 'manual',
    })

    __setYouTubeTransportForTests(fakeAcceptingUpload('video-after-removal').transport())
    await generateYoutubeUpload(job(slug, accountId))

    const after = await readSidecarRaw(slug, CODE, TITLE, 'youtube')
    assert.equal(after!.video_id, 'video-after-removal')
    assert.equal(after!.deleted_at, undefined, 'the new video is not born tombstoned')
    assert.equal(after!.deleted_reason, undefined)
    assert.equal(after!.thumbnail_sync?.video_id, 'video-after-removal', 'the thumbnail state is THIS video\'s, not the old one\'s')
    assert.notEqual(after!.uploaded_at, '2026-01-01T00:00:00.000Z', 'uploaded_at is this upload')

    // The outcome that matters: the new video is visible as published.
    const { remoteVideoFor } = await import('../services/youtube-remote-video.js')
    const seen = await remoteVideoFor(slug, CODE, TITLE, CHANNEL)
    assert.equal(seen?.video_id, 'video-after-removal')
  })

  test('an automatic sync_404 tombstone still refuses a new upload', async () => {
    const { slug, accountId } = await setUp(true)
    const { writeSidecar } = await import('../services/upload-sidecar.js')
    await writeSidecar(slug, CODE, TITLE, {
      platform: 'youtube', video_id: 'missing-for-token', account_id: accountId,
      channel_id: CHANNEL, uploaded_at: '2026-01-01T00:00:00.000Z',
      last_sync_at: '2026-02-01T00:00:00.000Z', scheduled_for: null,
      privacy_status: 'private', title: TITLE, description: '', tags: [], thumbnail_set: false,
      deleted_at: '2026-02-02T00:00:00.000Z', deleted_reason: 'sync_404',
    })
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(() => generateYoutubeUpload(job(slug, accountId)), /already on YouTube as missing-for-token/)
    assert.equal(fake.calls.length, 0, 'an automatic missing response is not removal authorization')
  })

  test('uploading to a different channel refuses rather than erasing the old link', async () => {
    // One sidecar per episode. Uploading to a second channel would overwrite
    // the only local record of the video on the first — the guard the deleted
    // update branch carried, restored for the upload path.
    const { slug, accountId } = await setUp(true)
    const { writeSidecar } = await import('../services/upload-sidecar.js')
    await writeSidecar(slug, CODE, TITLE, {
      platform: 'youtube', video_id: 'on-old-channel', account_id: accountId,
      channel_id: 'UC-a-different-channel', uploaded_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(), scheduled_for: null,
      privacy_status: 'public', title: TITLE, description: 'd', tags: [], thumbnail_set: false,
    })

    const fake = fakeAcceptingUpload('should-never-happen')
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(
      () => generateYoutubeUpload(job(slug, accountId)),
      /was uploaded to channel UC-a-different-channel as on-old-channel/,
    )
    assert.equal(fake.calls.length, 0, 'YouTube was never contacted')
  })

  // 1.4.300 safety checks: each one stops on Block (above) and carries on when its channel says Off/Warn.
  test('thumbnail present Off/Warn: an episode with no thumbnail uploads without one and says so', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'thumbnail_present', 'warn')
    const fake = fakeAcceptingUpload('video-no-thumb')
    __setYouTubeTransportForTests(fake.transport())
    const running = job(slug, accountId)
    running.params.thumbnail_filename = null

    await generateYoutubeUpload(running)
    assert.equal((await listYouTubeOperations(slug))[0]?.video_id, 'video-no-thumb')
    assert.ok(!fake.calls.some(call => /thumbnails\/set/.test(call.path)), 'no thumbnail request')
    assert.equal(running.result?.safety_warnings?.[0]?.check, 'thumbnail_present')
    assert.match(running.output_lines.join('\n'), /Uploading without a thumbnail/)
  })

  test('thumbnail present Off: a thumbnail YouTube refuses leaves the upload done with its frame grab', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'thumbnail_present', 'off')
    const fake = new FakeYouTube()
    fake.respond({ method: 'POST', path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', body: {}, headers: { Location: SESSION } })
    fake.respond({ method: 'PUT', path: '/resumable/session-abc', body: { id: 'video-thumb-refused' } })
    fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, status: 403, body: { error: { message: 'forbidden' } } })
    fake.respondMatching({ method: 'POST', match: /\/thumbnails\/set/, status: 403, body: { error: { message: 'forbidden' } } })
    __setYouTubeTransportForTests(fake.transport())
    const running = job(slug, accountId)

    await generateYoutubeUpload(running)
    assert.match(running.output_lines.join('\n'), /keeps YouTube's frame grab.*set to Off/)
    assert.equal(running.result?.safety_warnings, undefined, 'Off writes the log only')
  })

  test('right channel Off: a channel changed after confirmation uploads to the channel assigned now', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'right_channel', 'off')
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-current-channel').transport())
    const running = job(slug, accountId)
    running.params.expected_channel_id = 'UC-confirmed-before'

    await generateYoutubeUpload(running)
    const [record] = await listYouTubeOperations(slug)
    assert.equal(record?.video_id, 'video-current-channel')
    assert.equal(record?.channel_id, CHANNEL)
    assert.match(running.output_lines.join('\n'), /channel changed after confirmation; uploading to the channel assigned now/)
  })

  test('reviewed and unchanged Warn: a render changed after confirmation uploads as it is now, with a warning', async () => {
    const { slug, accountId } = await setUp(true)
    await setSafety(slug, 'reviewed_unchanged', 'warn')
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    await fs.appendFile(path.join(paths.video_dir, `${CODE}_final_video.mp4`), Buffer.from('changed-after-admission'))
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-changed-render').transport())
    const running = job(slug, accountId)

    await generateYoutubeUpload(running)
    assert.equal((await listYouTubeOperations(slug))[0]?.video_id, 'video-changed-render')
    assert.equal(running.result?.safety_warnings?.[0]?.check, 'reviewed_unchanged')
  })

  test('checks the Upload Center let through are logged on the job', async () => {
    const { slug, accountId } = await setUp(true)
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-passed-checks').transport())
    await setSafety(slug, 'episode_number_claim', 'warn')
    const running = job(slug, accountId)
    running.params.safety_warnings = [{ check: 'episode_number_claim', message: 'EP0001 is on this channel from another project.' }]

    await generateYoutubeUpload(running)
    assert.equal(running.result?.safety_warnings?.[0]?.check, 'episode_number_claim')
  })
})
