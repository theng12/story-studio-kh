/**
 * Pre-upload channel eligibility (owner-approved, 2026-10-19).
 *
 * The incident: Domnak DM0001–DM0003 went up on a channel that was not verified
 * for long videos. YouTube ACCEPTED all three and then abandoned every one of
 * them as "too long", and the custom thumbnails came back as bare 403s. These
 * are the three questions that were never asked: may this channel keep a video
 * over 15 minutes, may it have custom thumbnails, and does an answer we could
 * not get read as a refusal.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { __resetYouTubeTransportForTests, __setYouTubeTransportForTests } from '../lib/youtube-client.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { createProject } from '../services/project-manager.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'
import {
  CHANNEL_ELIGIBILITY_TTL_MS,
  LONG_VIDEO_REFUSAL,
  isChannelThumbnailForbidden,
  longUploadsAllowed,
  longUploadsStatusOf,
  longVideoRefusal,
  preflightYouTubeChannel,
  readCachedChannelEligibility,
  readYouTubeChannelEligibility,
  type YouTubeChannelEligibility,
} from '../services/youtube-channel-eligibility.js'
import { setThumbnail } from '../lib/youtube-client.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const CHANNEL = 'UC-eligibility'
const CHANNELS = /^\/youtube\/v3\/channels\?/
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==', 'base64')

/** A 403 body of the shape YouTube returns for a channel that may not have custom thumbnails. */
const THUMBNAIL_FORBIDDEN_BODY = {
  error: {
    code: 403,
    message: 'The user is not allowed to upload custom thumbnails for this channel.',
    errors: [{ domain: 'youtube.thumbnail', reason: 'forbidden', message: 'The user is not allowed to upload custom thumbnails.' }],
  },
}

async function setup() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: `Eligibility ${Math.random()}` })
  await configureYouTubeApplication({ client_id: 'eligibility-client', client_secret: 'eligibility-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Eligibility Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'eligibility-access', refresh_token: 'eligibility-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await assignProjectYouTubeChannel({ project_slug: project.slug, channel_id: CHANNEL, expected_previous_channel_id: null })
  return { slug: project.slug, accountId: `registry:${CHANNEL}`, dir: temp.dir }
}

function channelStatus(longUploadsStatus: string): { body: unknown } {
  return { body: { items: [{ id: CHANNEL, status: { longUploadsStatus } }] } }
}

function eligibility(long_uploads: YouTubeChannelEligibility['long_uploads']): YouTubeChannelEligibility {
  return { channel_id: CHANNEL, long_uploads, thumbnails: 'yes', checked_at: '2026-10-19T00:00:00.000Z', fresh: true }
}

/** A real file of `durationSec` seconds, so the pre-upload gate sees a real length. */
async function video(dir: string, durationSec: number): Promise<string> {
  const file = path.join(dir, `final-${durationSec}.mp4`)
  await runFfmpeg([
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=32x32:r=1:d=${durationSec}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
    '-t', String(durationSec), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', file,
  ])
  return file
}

describe('YouTube’s own words', () => {
  test('only `allowed` permits a long upload; eligible and unspecified are not permission', () => {
    assert.equal(longUploadsStatusOf('allowed'), 'allowed')
    assert.equal(longUploadsStatusOf('eligible'), 'eligible')
    assert.equal(longUploadsStatusOf('disallowed'), 'disallowed')
    assert.equal(longUploadsStatusOf('longUploadsUnspecified'), 'unspecified')
    assert.equal(longUploadsStatusOf(undefined), 'unknown')
    assert.equal(longUploadsStatusOf('someFutureWord'), 'unknown')

    assert.equal(longUploadsAllowed('allowed'), true)
    for (const status of ['eligible', 'disallowed', 'unspecified', 'unknown'] as const) {
      assert.equal(longUploadsAllowed(status), false, `${status} is not permission`)
    }
  })

  test('the refusal needs BOTH a long video and a channel that may not keep one', () => {
    const LONG = 16 * 60
    const SHORT = 14 * 60
    assert.equal(longVideoRefusal(eligibility('allowed'), LONG), null, 'a verified channel keeps a long video')
    assert.equal(longVideoRefusal(eligibility('disallowed'), SHORT), null, 'a short video is fine anywhere')
    assert.equal(longVideoRefusal(eligibility('disallowed'), LONG), LONG_VIDEO_REFUSAL)
    assert.equal(longVideoRefusal(eligibility('eligible'), LONG), LONG_VIDEO_REFUSAL)
    assert.equal(longVideoRefusal(eligibility('unspecified'), LONG), LONG_VIDEO_REFUSAL)
    // "We could not ask" is NOT "the answer is no": a network blip must not
    // block a real upload (AGENTS.md §6).
    assert.equal(longVideoRefusal(eligibility('unknown'), LONG), null)
  })

  test('the thumbnail prohibition is read from the 403, never from a quota 403 or another status', () => {
    assert.equal(isChannelThumbnailForbidden(403, JSON.stringify(THUMBNAIL_FORBIDDEN_BODY)), true)
    assert.equal(isChannelThumbnailForbidden(403, JSON.stringify({
      error: { code: 403, message: 'Quota exceeded', errors: [{ reason: 'quotaExceeded' }] },
    })), false, 'a spent allowance is not an unverified channel')
    assert.equal(isChannelThumbnailForbidden(403, JSON.stringify({
      error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden', message: 'no' }] },
    })), false, 'an unrelated 403 is not evidence about thumbnails')
    assert.equal(isChannelThumbnailForbidden(500, JSON.stringify(THUMBNAIL_FORBIDDEN_BODY)), false)
    assert.equal(isChannelThumbnailForbidden(403, 'not json'), false)
  })
})

describe('reading the channel status', () => {
  test('records allowed and disallowed, caches for six hours, and re-asks on refresh', async () => {
    const s = await setup()
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: CHANNELS, ...channelStatus('disallowed') })
    __setYouTubeTransportForTests(fake.transport())

    const first = await readYouTubeChannelEligibility({ project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL })
    assert.equal(first.long_uploads, 'disallowed')
    assert.equal(first.fresh, true)
    assert.ok(first.checked_at)
    assert.equal(fake.calls.length, 1)

    // Cache-first: an ordinary read costs no quota.
    const cached = await readYouTubeChannelEligibility({ project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL })
    assert.equal(cached.long_uploads, 'disallowed')
    assert.equal(cached.fresh, false)
    assert.equal(fake.calls.length, 1, 'the cached answer was reused')

    fake.respondMatching({ method: 'GET', match: CHANNELS, ...channelStatus('allowed') })
    const refreshed = await readYouTubeChannelEligibility({
      project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL, refresh: true,
    })
    assert.equal(refreshed.long_uploads, 'allowed')
    assert.equal(refreshed.fresh, true)
    assert.equal(fake.calls.length, 2, 'refresh asks YouTube again')

    // And a stale entry is re-asked without being told to.
    fake.respondMatching({ method: 'GET', match: CHANNELS, ...channelStatus('disallowed') })
    const later = await readYouTubeChannelEligibility({
      project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL,
      now: Date.now() + CHANNEL_ELIGIBILITY_TTL_MS + 1,
    })
    assert.equal(later.long_uploads, 'disallowed')
    assert.equal(later.fresh, true)
    assert.equal(fake.calls.length, 3)
  })

  test('a status that cannot be read is unknown, never a refusal', async () => {
    const s = await setup()
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: CHANNELS, status: 503, body: { error: { message: 'backend' } } })
    __setYouTubeTransportForTests(fake.transport())

    const answer = await readYouTubeChannelEligibility({ project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL })
    assert.equal(answer.long_uploads, 'unknown')
    assert.equal(answer.checked_at, null, 'nothing was answered, so nothing is claimed')
    assert.equal(longVideoRefusal(answer, 60 * 60), null, 'and it never refuses')
    assert.equal(await readCachedChannelEligibility(s.slug, CHANNEL), null, 'and nothing was cached')
  })

  test('a channel that has never been asked reads as nothing, not as a verdict', async () => {
    const s = await setup()
    assert.equal(await readCachedChannelEligibility(s.slug, CHANNEL), null)
  })
})

describe('the pre-upload gate', () => {
  test('refuses a long video on an unverified channel, allows a short one, and allows a verified channel', async () => {
    const s = await setup()
    const long = await video(s.dir, 16 * 60)
    const short = await video(s.dir, 60)

    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'GET', match: CHANNELS, ...channelStatus('disallowed') })
    __setYouTubeTransportForTests(fake.transport())

    const refused = await preflightYouTubeChannel({
      project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL, file_path: long,
    })
    assert.equal(refused.refusal, LONG_VIDEO_REFUSAL)
    assert.equal(refused.eligibility?.long_uploads, 'disallowed')

    // A short video never even asks: the length is asked first, so an ordinary
    // upload spends no quota on this question.
    const callsBefore = fake.calls.length
    const allowed = await preflightYouTubeChannel({
      project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL, file_path: short,
    })
    assert.equal(allowed.refusal, null)
    assert.equal(allowed.eligibility, null)
    assert.equal(fake.calls.length, callsBefore, 'a short video asked YouTube nothing')
  })

  test('a verified channel keeps its long video', async () => {
    const s = await setup()
    const long = await video(s.dir, 16 * 60)

    const verified = new FakeYouTube()
    verified.respondMatching({ method: 'GET', match: CHANNELS, ...channelStatus('allowed') })
    __setYouTubeTransportForTests(verified.transport())
    const ok = await preflightYouTubeChannel({
      project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL, file_path: long,
    })
    assert.equal(ok.refusal, null)
    assert.equal(ok.eligibility?.long_uploads, 'allowed')
  })

  test('a long video on a channel whose status cannot be read is not refused', async () => {
    const s = await setup()
    const long = await video(s.dir, 16 * 60)

    const broken = new FakeYouTube()
    broken.respondMatching({ method: 'GET', match: CHANNELS, status: 503, body: {} })
    __setYouTubeTransportForTests(broken.transport())
    const unknown = await preflightYouTubeChannel({
      project_slug: s.slug, account_id: s.accountId, channel_id: CHANNEL, file_path: long,
    })
    assert.equal(unknown.eligibility?.long_uploads, 'unknown')
    assert.equal(unknown.refusal, null, 'a channel we could not ask about never blocks an upload')
  })
})

describe('custom thumbnails on a channel that may not have them', () => {
  test('the 403 is reported in plain words and recorded as the evidence', async () => {
    const s = await setup()
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'POST', match: /^\/upload\/youtube\/v3\/thumbnails\/set\?/, status: 403, body: THUMBNAIL_FORBIDDEN_BODY })
    __setYouTubeTransportForTests(fake.transport())
    const image = path.join(s.dir, 'thumb.png')
    await (await import('node:fs/promises')).writeFile(image, PNG)

    await assert.rejects(
      () => setThumbnail({ slug: s.slug, accountId: s.accountId, videoId: 'vid-thumb', filePath: image }),
      (error: any) => {
        assert.equal(error.code, 'YOUTUBE_CHANNEL_THUMBNAILS_FORBIDDEN')
        // Never the raw provider 403: the owner is told what happened and why.
        assert.equal(error.message, 'This channel isn\'t verified for custom thumbnails, so the thumbnail was skipped.')
        assert.doesNotMatch(error.message, /403|forbidden/i)
        return true
      },
    )

    // And that answer is now the channel's recorded status, so the Upload
    // Center can say so before the next upload.
    const recorded = await readCachedChannelEligibility(s.slug, CHANNEL)
    assert.equal(recorded?.thumbnails, 'no')
  })

  test('a quota 403 is still a thumbnail failure, not a channel verdict', async () => {
    const s = await setup()
    const fake = new FakeYouTube()
    fake.respondMatching({
      method: 'POST', match: /^\/upload\/youtube\/v3\/thumbnails\/set\?/, status: 403,
      body: { error: { code: 403, message: 'Quota exceeded', errors: [{ reason: 'quotaExceeded' }] } },
    })
    __setYouTubeTransportForTests(fake.transport())
    const image = path.join(s.dir, 'thumb2.png')
    await (await import('node:fs/promises')).writeFile(image, PNG)

    await assert.rejects(
      () => setThumbnail({ slug: s.slug, accountId: s.accountId, videoId: 'vid-quota', filePath: image }),
      (error: any) => {
        assert.notEqual(error.code, 'YOUTUBE_CHANNEL_THUMBNAILS_FORBIDDEN')
        assert.match(error.message, /quota/i)
        return true
      },
    )
    assert.equal(await readCachedChannelEligibility(s.slug, CHANNEL), null)
  })
})
