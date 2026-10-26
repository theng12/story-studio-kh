import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { FakeSocial } from './fixtures/fake-social.js'
import { __resetSocialTransportForTests, __setSocialTransportForTests } from '../lib/social-publish/types.js'
import {
  facebookSpecViolation,
  instagramSpecViolation,
  publishFacebookVideo,
  publishInstagramReel,
} from '../lib/social-publish/meta.js'
import { planChunks, publishTikTokVideo, tiktokSpecViolation } from '../lib/social-publish/tiktok.js'
import type { SocialPostInput } from '../lib/social-publish/types.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetSocialTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const MB = 1024 * 1024

async function tempFile(bytes: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'social-adapter-'))
  cleanup = async () => { await fs.rm(dir, { recursive: true, force: true }) }
  const file = path.join(dir, 'video.mp4')
  await fs.writeFile(file, Buffer.alloc(bytes, 7))
  return file
}

function input(filePath: string, overrides: Partial<SocialPostInput> = {}): SocialPostInput {
  return {
    filePath,
    title: 'A title',
    caption: 'A caption #one',
    durationSec: 30,
    width: 1080,
    height: 1920,
    sizeBytes: 1000,
    credentials: {
      remoteId: 'ig-1',
      accessToken: 'user-token',
      pageToken: 'page-token',
      pageId: 'page-1',
      appId: 'app-1',
    },
    log: () => {},
    ...overrides,
  }
}

describe('platform specs', () => {
  test('Instagram refuses landscape, oversize and too-short before any request', () => {
    assert.match(instagramSpecViolation({ durationSec: 30, width: 1920, height: 1080, sizeBytes: 1000 }) || '', /vertical \(9:16\)/)
    assert.match(instagramSpecViolation({ durationSec: 30, width: 1080, height: 1920, sizeBytes: 301 * MB }) || '', /at most 300 MB/)
    assert.match(instagramSpecViolation({ durationSec: 1, width: 1080, height: 1920, sizeBytes: 1000 }) || '', /between 3 seconds/)
    assert.equal(instagramSpecViolation({ durationSec: 30, width: 1080, height: 1920, sizeBytes: 1000 }), null)
  })

  test('Facebook publishes no duration or size ceiling, so none is invented', () => {
    assert.equal(facebookSpecViolation({ durationSec: 3600, width: 1920, height: 1080, sizeBytes: 900 * MB }), null)
    assert.match(facebookSpecViolation({ durationSec: 0, width: 1920, height: 1080, sizeBytes: 1000 }) || '', /no duration/)
  })

  test('TikTok refuses landscape, out-of-range dimensions and oversize', () => {
    assert.match(tiktokSpecViolation({ durationSec: 30, width: 1920, height: 1080, sizeBytes: 1000 }) || '', /vertical/)
    assert.match(tiktokSpecViolation({ durationSec: 30, width: 100, height: 1920, sizeBytes: 1000 }) || '', /between 360 and 4096/)
    assert.match(tiktokSpecViolation({ durationSec: 30, width: 1080, height: 1920, sizeBytes: 5 * 1024 * MB }) || '', /at most 4 GB/)
    assert.equal(tiktokSpecViolation({ durationSec: 30, width: 1080, height: 1920, sizeBytes: 1000 }), null)
  })
})

describe('TikTok chunk plan', () => {
  test('a file under 5 MB is one chunk of exactly its size', () => {
    assert.deepEqual(planChunks(3 * MB), { chunkSize: 3 * MB, totalChunks: 1 })
  })

  test('a file over 64 MB is split so every chunk but the last is within 64 MB', () => {
    const size = 300 * MB
    const { chunkSize, totalChunks } = planChunks(size)
    assert.ok(chunkSize >= 5 * MB && chunkSize <= 64 * MB, `chunkSize ${chunkSize}`)
    assert.ok(totalChunks > 1 && totalChunks <= 1000)
    const lastChunk = size - chunkSize * (totalChunks - 1)
    assert.ok(lastChunk <= 128 * MB, `last chunk ${lastChunk}`)
    assert.ok(lastChunk > 0)
  })

  test('a 4 GB file still lands inside TikTok’s 1000-chunk ceiling', () => {
    const size = 4 * 1024 * MB
    const { chunkSize, totalChunks } = planChunks(size)
    assert.ok(totalChunks <= 1000, `chunks ${totalChunks}`)
    assert.ok(chunkSize <= 64 * MB)
    assert.ok(size - chunkSize * (totalChunks - 1) <= 128 * MB)
  })
})

describe('Facebook adapter', () => {
  test('opens a session, sends the Page token, and returns the video id', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/uploads', body: { id: 'upload:abc' } })
    fake.respond({ method: 'POST', url: '/upload:abc', body: { h: 'handle-1' } })
    fake.respond({ method: 'POST', url: '/page-1/videos', body: { id: 'video-42' } })
    __setSocialTransportForTests(fake.transport)

    const output = await publishFacebookVideo(input(file))
    assert.equal(output.post_id, 'video-42')
    assert.match(output.permalink || '', /watch\/\?v=video-42/)
    // The publish body carries the title and description the owner approved.
    const publishCall = fake.callsTo('/page-1/videos')[0]!
    assert.match(publishCall.body || '', /fbuploader_video_file_chunk=handle-1/)
    assert.match(publishCall.body || '', /title=A\+title/)
  })

  test('a 190 from Meta is a reconnect, not a retry', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/uploads', status: 400, body: { error: { message: 'Invalid OAuth access token', code: 190 } } })
    __setSocialTransportForTests(fake.transport)

    await assert.rejects(
      () => publishFacebookVideo(input(file)),
      (error: Error & { code?: string }) => error.code === 'SOCIAL_RECONNECT_REQUIRED' && /Reconnect this account/.test(error.message),
    )
  })

  test('a file that changed under the upload is refused rather than posting half a video', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/uploads', body: { id: 'upload:abc' } })
    __setSocialTransportForTests(fake.transport)
    await assert.rejects(
      () => publishFacebookVideo(input(file, { sizeBytes: 999 })),
      /The video changed while it was being posted/,
    )
  })
})

describe('Instagram adapter', () => {
  test('creates a resumable container, polls until FINISHED, then publishes', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/ig-1/media', body: { id: 'container-9' } })
    fake.respond({ method: 'POST', url: '/ig-api-upload/v26.0/container-9', body: { success: true } })
    fake.respond({ method: 'GET', url: '/container-9?fields=status_code', body: { status_code: 'IN_PROGRESS' } })
    fake.respond({ method: 'GET', url: '/container-9?fields=status_code', body: { status_code: 'FINISHED' } })
    fake.respond({ method: 'POST', url: '/ig-1/media_publish', body: { id: 'media-77' } })
    __setSocialTransportForTests(fake.transport)

    const output = await publishInstagramReel(input(file))
    assert.equal(output.post_id, 'media-77')
    const create = fake.callsTo('/ig-1/media')[0]!
    assert.match(create.body || '', /media_type=REELS/)
    assert.match(create.body || '', /upload_type=resumable/)
  })

  test('an ERROR container is a failure with the status named', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/ig-1/media', body: { id: 'container-9' } })
    fake.respond({ method: 'POST', url: '/ig-api-upload/v26.0/container-9', body: { success: true } })
    fake.respond({ method: 'GET', url: '/container-9?fields=status_code', body: { status_code: 'ERROR' } })
    __setSocialTransportForTests(fake.transport)

    await assert.rejects(() => publishInstagramReel(input(file)), /status ERROR/)
    // Nothing was published.
    assert.equal(fake.callsTo('/media_publish').length, 0)
  })
})

describe('TikTok adapter', () => {
  test('queries creator info first, uploads in chunks, and waits for PUBLISH_COMPLETE', async () => {
    // 11 MB at TikTok's 5 MB minimum is floor(11/5) = 2 chunks, the second
    // absorbing the 1 MB remainder.
    const size = 11 * MB
    const file = await tempFile(size)
    const fake = new FakeSocial()
    fake.respond({
      method: 'POST',
      url: '/post/publish/creator_info/query/',
      body: { data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 300 } },
    })
    fake.respond({
      method: 'POST',
      url: '/post/publish/video/init/',
      body: { data: { publish_id: 'v_pub_file~1', upload_url: 'https://upload.tiktok.test/video?upload_id=1' } },
    })
    fake.respondMany({ method: 'PUT', url: 'https://upload.tiktok.test/video', status: 206, body: {} }, 2)
    fake.respond({ method: 'POST', url: '/post/publish/status/fetch/', body: { data: { status: 'PROCESSING_UPLOAD' } } })
    fake.respond({ method: 'POST', url: '/post/publish/status/fetch/', body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [12345] } } })
    __setSocialTransportForTests(fake.transport)

    const output = await publishTikTokVideo(input(file, { sizeBytes: size }))
    assert.equal(output.post_id, '12345')

    const init = fake.callsTo('/post/publish/video/init/')[0]!
    const body = JSON.parse(init.body || '{}')
    assert.equal(body.source_info.source, 'FILE_UPLOAD')
    assert.equal(body.source_info.video_size, size)
    assert.equal(body.source_info.total_chunk_count, 2)
    assert.equal(body.post_info.privacy_level, 'PUBLIC_TO_EVERYONE')
    // The creator-info call comes first: the privacy level is its answer, not a constant.
    assert.ok(fake.calls[0]!.url.includes('/creator_info/query/'))
    // Chunk ranges are zero-based and inclusive, and cover the file exactly.
    const puts = fake.callsTo('upload.tiktok.test')
    assert.equal(puts.length, 2)
    assert.equal(puts[0]!.headers?.['content-range'], `bytes 0-${5 * MB - 1}/${size}`)
    assert.equal(puts[1]!.headers?.['content-range'], `bytes ${5 * MB}-${size - 1}/${size}`)
    // The two ranges cover the whole file: a clamped last chunk would leave
    // bytes unsent and TikTok would still call it complete.
    assert.equal(puts[0]!.headers?.['content-length'], String(5 * MB))
    assert.equal(puts[1]!.headers?.['content-length'], String(6 * MB))
  })

  test('a FAILED status names TikTok’s reason and publishes nothing', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/creator_info/query/', body: { data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 300 } } })
    fake.respond({ method: 'POST', url: '/video/init/', body: { data: { publish_id: 'v1', upload_url: 'https://upload.tiktok.test/video?upload_id=1' } } })
    fake.respond({ method: 'PUT', url: 'upload.tiktok.test', status: 201, body: {} })
    fake.respond({ method: 'POST', url: '/status/fetch/', body: { data: { status: 'FAILED', fail_reason: 'video_resolution_check_failed' } } })
    __setSocialTransportForTests(fake.transport)

    await assert.rejects(() => publishTikTokVideo(input(file)), /rejected the picture size/)
  })

  test('a creator whose longest video is shorter than ours is refused before init', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/creator_info/query/', body: { data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 60 } } })
    __setSocialTransportForTests(fake.transport)

    await assert.rejects(() => publishTikTokVideo(input(file, { durationSec: 900 })), /up to 1 minutes/)
    assert.equal(fake.callsTo('/video/init/').length, 0)
  })

  test('an unaudited client is told its post will be private, not silently published', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/creator_info/query/', body: { data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 300 } } })
    fake.respond({ method: 'POST', url: '/video/init/', body: { data: { publish_id: 'v1', upload_url: 'https://upload.tiktok.test/video?upload_id=1' } } })
    fake.respond({ method: 'PUT', url: 'upload.tiktok.test', status: 201, body: {} })
    fake.respond({ method: 'POST', url: '/status/fetch/', body: { data: { status: 'PUBLISH_COMPLETE', publically_available_post_id: [9] } } })
    __setSocialTransportForTests(fake.transport)

    const lines: string[] = []
    await publishTikTokVideo(input(file, { log: line => lines.push(line) }))
    assert.match(lines.join('\n'), /only allows private posts/)
    const init = JSON.parse(fake.callsTo('/video/init/')[0]!.body || '{}')
    assert.equal(init.post_info.privacy_level, 'SELF_ONLY')
  })

  test('a 401 from TikTok is a reconnect, not a retry', async () => {
    const file = await tempFile(1000)
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/creator_info/query/', status: 401, body: {} })
    __setSocialTransportForTests(fake.transport)
    await assert.rejects(
      () => publishTikTokVideo(input(file)),
      (error: Error & { code?: string }) => error.code === 'SOCIAL_RECONNECT_REQUIRED',
    )
  })
})
