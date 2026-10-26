import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { FakeSocial } from './fixtures/fake-social.js'
import { __resetSocialTransportForTests, __setSocialTransportForTests } from '../lib/social-publish/types.js'
import { generateSocialPublish } from '../generators/social-publish.js'
import { createProject, updateConfig } from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import {
  configureSocialApplication,
  saveSocialAccountGrant,
  readProjectSocialOptIn,
} from '../services/social-connection-store.js'
import { readSocialSidecar } from '../services/social-publish-sidecar.js'
import type { Job } from '../models/types.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'

const execFileAsync = promisify(execFile)

/**
 * A five-second 1080x1920 H.264 clip with a tone: the smallest file that every
 * one of the three platforms accepts on paper, so a test that refuses it is
 * testing the code and not the fixture.
 */
async function writeVerticalVideo(target: string, size = '1080x1920'): Promise<void> {
  const ffmpeg = await getFFmpegPath()
  await execFileAsync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=24:d=5`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    target,
  ], { timeout: 120_000 })
}

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetSocialTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const CODE = 'EP0001'
const TITLE = 'Social Episode'
const META_APP_ID = 'meta:meta-client-id'
const PAGE_ID = 'page-123'
const IG_ID = 'ig-456'
const TIKTOK_OPEN_ID = 'tiktok-open-id-1'

async function setUp(): Promise<{ slug: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Social Project' })
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
    title: 'A Social Episode Title',
    description: 'A social description.',
    tags: ['alpha', 'beta'],
  }))
  await fs.mkdir(paths.video_dir, { recursive: true })
  // A real 9:16 vertical render, so the platform specs are the only thing that
  // can refuse it. Generated with the bundled ffmpeg, the same binary the app
  // probes with — a hand-written header would not survive ffprobe.
  await writeVerticalVideo(path.join(paths.video_dir, `${CODE}_final_video.mp4`))

  await configureSocialApplication({
    provider: 'meta',
    client_id: 'meta-client-id',
    client_secret: 'meta-client-secret-value',
    redirect_uri: 'http://127.0.0.1:41234/callback',
  })
  await configureSocialApplication({
    provider: 'tiktok',
    client_id: 'tiktok-client-key',
    client_secret: 'tiktok-client-secret-value',
    redirect_uri: 'http://127.0.0.1:41235/callback',
  })

  const metaTokens = {
    application_id: META_APP_ID,
    access_token: 'meta-user-token-value',
    refresh_token: '',
    expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
    page_token: 'page-token-value',
  }
  await saveSocialAccountGrant({
    platform: 'facebook',
    application_id: META_APP_ID,
    remote_id: PAGE_ID,
    remote_name: 'Test Page',
    page_id: PAGE_ID,
    tokens: metaTokens,
  })
  await saveSocialAccountGrant({
    platform: 'instagram',
    application_id: META_APP_ID,
    remote_id: IG_ID,
    remote_name: '@testpage',
    page_id: PAGE_ID,
    tokens: { ...metaTokens },
  })
  await saveSocialAccountGrant({
    platform: 'tiktok',
    application_id: 'tiktok:tiktok-client-key',
    remote_id: TIKTOK_OPEN_ID,
    remote_name: TIKTOK_OPEN_ID,
    tokens: {
      application_id: 'tiktok:tiktok-client-key',
      access_token: 'tiktok-access-token-value',
      refresh_token: 'tiktok-refresh-token-value',
      expires_at: Date.now() + 24 * 60 * 60 * 1000,
    },
  })

  await updateConfig(slug, {
    social_accounts: { facebook: PAGE_ID, instagram: IG_ID, tiktok: TIKTOK_OPEN_ID },
  } as never)

  return { slug }
}

function jobFor(slug: string, platforms: string[], captions?: Record<string, unknown>): Job {
  return {
    job_id: 'job-social-1',
    project_slug: slug,
    type: 'social_publish',
    episode_id: CODE,
    title: '',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: { episode_id: CODE, platforms, ...(captions ? { captions } : {}) },
  } as unknown as Job
}

/** Facebook's three-call publish, accepted. */
function acceptFacebook(fake: FakeSocial, videoId = 'fb-video-1'): void {
  fake.respond({ method: 'POST', url: '/uploads', body: { id: 'upload:session-1' } })
  fake.respond({ method: 'POST', url: '/upload:session-1', body: { h: 'file-handle-1' } })
  fake.respond({ method: 'POST', url: `/${PAGE_ID}/videos`, body: { id: videoId } })
}

describe('social publishing job', () => {
  test('posts to Facebook, records the platform post id, and proves completion', async () => {
    const { slug } = await setUp()
    const fake = new FakeSocial()
    acceptFacebook(fake)
    __setSocialTransportForTests(fake.transport)

    const job = jobFor(slug, ['facebook'])
    await generateSocialPublish(job)

    assert.equal(job.result?.complete, true)
    const sidecar = await readSocialSidecar(slug, CODE)
    assert.equal(sidecar.receipts.length, 1)
    assert.equal(sidecar.receipts[0]!.platform, 'facebook')
    assert.equal(sidecar.receipts[0]!.post_id, 'fb-video-1')
    assert.match(sidecar.receipts[0]!.source_revision, /^sha256:[a-f0-9]{64}$/)
    // The bytes went as the Page token, never the user token.
    const upload = fake.callsTo('/upload:session-1')[0]!
    assert.equal(upload.headers?.authorization, 'OAuth page-token-value')
  })

  test('a retry after a partial failure posts only the missing platform and never double-posts', async () => {
    const { slug } = await setUp()
    const first = new FakeSocial()
    acceptFacebook(first, 'fb-video-1')
    // Instagram is refused by Meta on this run.
    first.respond({ method: 'POST', url: `/${IG_ID}/media`, status: 500, body: { error: { message: 'Meta is having a bad day.', code: 1 } } })
    __setSocialTransportForTests(first.transport)

    const failing = jobFor(slug, ['facebook', 'instagram'])
    await assert.rejects(() => generateSocialPublish(failing), /Posting EP0001 incomplete: 1\/2/)
    const afterFailure = await readSocialSidecar(slug, CODE)
    assert.equal(afterFailure.receipts.length, 1)
    assert.equal(afterFailure.receipts[0]!.platform, 'facebook')
    // The failure is recorded BESIDE the receipt, not instead of it.
    assert.equal(afterFailure.failures?.instagram?.code, 'SOCIAL_PLATFORM_REFUSED')

    const second = new FakeSocial()
    // No Facebook responses are queued: if the retry posts to Facebook again,
    // FakeSocial throws and this test fails.
    second.respond({ method: 'POST', url: `/${IG_ID}/media`, body: { id: 'container-1' } })
    second.respond({ method: 'POST', url: '/ig-api-upload/v26.0/container-1', body: { success: true } })
    second.respond({ method: 'GET', url: '/container-1?fields=status_code', body: { status_code: 'FINISHED' } })
    second.respond({ method: 'POST', url: `/${IG_ID}/media_publish`, body: { id: 'ig-media-1' } })
    __setSocialTransportForTests(second.transport)

    const retry = jobFor(slug, ['facebook', 'instagram'])
    await generateSocialPublish(retry)

    assert.equal(second.callsTo(`/${PAGE_ID}/videos`).length, 0)
    const afterRetry = await readSocialSidecar(slug, CODE)
    assert.equal(afterRetry.receipts.length, 2)
    assert.deepEqual(afterRetry.receipts.map(entry => entry.post_id).sort(), ['fb-video-1', 'ig-media-1'])
    assert.equal(afterRetry.failures, undefined)
    assert.match(retry.output_lines.join('\n'), /already posted from this exact file \(fb-video-1\)/)
  })

  test('a ticked platform with no connected account is refused before anything is sent', async () => {
    const { slug } = await setUp()
    await updateConfig(slug, { social_accounts: { facebook: PAGE_ID } } as never)
    const fake = new FakeSocial()
    __setSocialTransportForTests(fake.transport)

    await assert.rejects(
      () => generateSocialPublish(jobFor(slug, ['facebook', 'tiktok'])),
      /Connect an account for tiktok in Settings → Publishing/,
    )
    assert.equal(fake.calls.length, 0)
  })

  test('no ticked platform posts nothing, and says so', async () => {
    const { slug } = await setUp()
    const fake = new FakeSocial()
    __setSocialTransportForTests(fake.transport)

    await assert.rejects(
      () => generateSocialPublish(jobFor(slug, [])),
      /No platform was ticked/,
    )
    assert.equal(fake.calls.length, 0)
    const sidecar = await readSocialSidecar(slug, CODE)
    assert.equal(sidecar.receipts.length, 0)
  })

  test('a video Instagram cannot take is refused with the reason, and Facebook still posts', async () => {
    const { slug } = await setUp()
    // Replace the vertical render with a 16:9 one: a valid Facebook post, an
    // invalid Reel. This is the exact mistake the spec check exists to catch.
    const landscapePaths = await resolveEpisodePaths(slug, CODE, TITLE)
    await writeVerticalVideo(path.join(landscapePaths.video_dir, `${CODE}_final_video.mp4`), '1920x1080')
    const fake = new FakeSocial()
    acceptFacebook(fake, 'fb-video-2')
    __setSocialTransportForTests(fake.transport)

    const job = jobFor(slug, ['facebook', 'instagram'])
    await assert.rejects(() => generateSocialPublish(job), /Posting EP0001 incomplete: 1\/2/)
    const text = job.output_lines.join('\n')
    assert.match(text, /Instagram Reels are vertical \(9:16\)/)
    // Nothing was sent to Instagram: the refusal happens before any request.
    assert.equal(fake.callsTo(`/${IG_ID}/media`).length, 0)
  })

  test('an expired TikTok sign-in is a clear reconnect message, not a retry', async () => {
    const { slug } = await setUp()
    const fake = new FakeSocial()
    // TikTok rejects the refresh, so the credential cannot be renewed.
    fake.respond({ method: 'POST', url: '/v2/oauth/token/', status: 401, body: { error: 'invalid_grant', error_description: 'refresh token expired' } })
    __setSocialTransportForTests(fake.transport)

    // Expire the access token so the resolver must refresh.
    const { saveSocialAccountGrant: save } = await import('../services/social-connection-store.js')
    await save({
      platform: 'tiktok',
      application_id: 'tiktok:tiktok-client-key',
      remote_id: TIKTOK_OPEN_ID,
      remote_name: TIKTOK_OPEN_ID,
      tokens: {
        application_id: 'tiktok:tiktok-client-key',
        access_token: 'tiktok-access-token-value',
        refresh_token: 'tiktok-refresh-token-value',
        expires_at: Date.now() - 1000,
      },
    })

    const job = jobFor(slug, ['tiktok'])
    await assert.rejects(() => generateSocialPublish(job), /Reconnect tiktok-open-id-1 in Settings → Publishing/)
    const sidecar = await readSocialSidecar(slug, CODE)
    assert.equal(sidecar.receipts.length, 0)
    assert.equal(sidecar.failures?.tiktok?.code, 'SOCIAL_RECONNECT_REQUIRED')
  })

  test('a platform that returns no post id is a failure, never a success', async () => {
    const { slug } = await setUp()
    const fake = new FakeSocial()
    fake.respond({ method: 'POST', url: '/uploads', body: { id: 'upload:session-1' } })
    fake.respond({ method: 'POST', url: '/upload:session-1', body: { h: 'file-handle-1' } })
    // Accepted, but no id: the platform gave no proof.
    fake.respond({ method: 'POST', url: `/${PAGE_ID}/videos`, body: {} })
    __setSocialTransportForTests(fake.transport)

    const job = jobFor(slug, ['facebook'])
    await assert.rejects(() => generateSocialPublish(job), /returned no video id/)
    const sidecar = await readSocialSidecar(slug, CODE)
    assert.equal(sidecar.receipts.length, 0)
  })

  test('the channel opt-in list is a default only; the job posts what it was told', async () => {
    const { slug } = await setUp()
    await updateConfig(slug, { social_platforms: ['tiktok'] } as never)
    assert.deepEqual(await readProjectSocialOptIn(slug), ['tiktok'])

    const fake = new FakeSocial()
    acceptFacebook(fake, 'fb-video-3')
    __setSocialTransportForTests(fake.transport)
    // The job was told Facebook. The channel's saved default says TikTok.
    // Nothing TikTok-shaped is queued, so posting to TikTok would throw.
    const job = jobFor(slug, ['facebook'])
    await generateSocialPublish(job)
    assert.equal((await readSocialSidecar(slug, CODE)).receipts[0]!.platform, 'facebook')
  })
})
