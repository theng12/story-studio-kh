/**
 * Final-video review marks (owner, 2026-10-29).
 *
 * What these tests pin, and why each one matters:
 *
 *   - a mark belongs to ONE exact file: its identity carries the path, size,
 *     modified time, inode and sha256 under a version, so a rewritten or
 *     replaced final makes the old mark read STALE instead of passing for the
 *     new bytes (AGENTS.md §6 — "not reviewed" must not look like "changed");
 *   - review is OFF unless a channel turns it on: an off channel is never
 *     walked, writes no sidecar, and refuses a mark — existing production is
 *     untouched;
 *   - a torn or version-less mark reads `unreadable`, never "not reviewed";
 *   - the listing is newest first, includes a final no matter which run made
 *     it, and a channel that could not be read says so rather than reading as
 *     "no finished videos".
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const isolated = await useTempDataDir()

const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const settings = await import('../services/app-settings.js')
const {
  finalReviewEnabled,
  finalReviewSidecarPath,
  listFinalReviews,
  readFinalReview,
  writeFinalReview,
} = await import('../services/final-review.js')
const { router: reviewRouter } = await import('../routes/final-review.js')

before(async () => {
  await settings.setAppSetting('library_root', process.env.STORY_STUDIO_DATA_DIR!)
})

after(async () => {
  await isolated.cleanup()
})

interface ChannelFixture {
  slug: string
  name: string
  code: string
  title: string
  finalPath: string
  episodeDir: string
}

async function makeChannel(
  name: string,
  options: { code?: string; title?: string; bytes?: number; review?: boolean } = {},
): Promise<ChannelFixture> {
  const project = await pm.createProject({ name, episode_prefix: 'EP' })
  const projectDir = pm.getProjectDir(project.slug)!
  const code = options.code ?? 'EP0001'
  const title = options.title ?? `${name} story`
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: `idea-${name}`,
      title,
      logline: '',
      themes: [],
      suggested_chapters: 1,
      suggested_length: 'short',
      mood: 'calm',
      status: 'accepted',
      episode_code: code,
      generated_at: '2026-01-01T00:00:00.000Z',
      accepted_at: '2026-01-01T00:00:00.000Z',
      batch_id: 'test',
      model_used: 'test',
    }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const paths = await utils.resolveEpisodePaths(project.slug, code, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  const finalPath = path.join(paths.video_dir, `${code}_final_video.mp4`)
  await fs.writeFile(finalPath, Buffer.alloc(options.bytes ?? 64, 7))
  if (options.review === true) await pm.updateConfig(project.slug, { final_review: { enabled: true } })
  return { slug: project.slug, name, code, title, finalPath, episodeDir: paths.episode_dir }
}

describe('the mark is tied to one exact final', () => {
  test('records path, size, modified time, inode, sha256 and identity version', async () => {
    const channel = await makeChannel('Identity Channel', { review: true })
    const review = await writeFinalReview(channel.finalPath, 'approved')
    assert.equal(review.state, 'current')
    assert.equal(review.decision, 'approved')
    assert.equal(review.identity.version, 1)
    assert.equal(review.identity.path, channel.finalPath)
    assert.equal(review.identity.size, 64)
    assert.match(review.identity.sha256, /^sha256:[a-f0-9]{64}$/)

    const sidecar = JSON.parse(await fs.readFile(finalReviewSidecarPath(channel.finalPath), 'utf8'))
    assert.equal(sidecar.schema_version, 1)
    assert.equal(sidecar.decision, 'approved')
    assert.deepEqual(sidecar.identity, review.identity)
  })

  test('goes stale when the bytes are replaced', async () => {
    const channel = await makeChannel('Replaced Channel', { review: true })
    await writeFinalReview(channel.finalPath, 'approved')
    await fs.writeFile(channel.finalPath, Buffer.alloc(128, 9))

    const review = await readFinalReview(channel.finalPath)
    assert.equal(review.state, 'stale')
    assert.equal(review.decision, 'approved')
    assert.equal(review.recorded.size, 64)
    assert.equal(review.current?.size, 128)
  })

  test('goes stale when the modified time moves without a size change', async () => {
    const channel = await makeChannel('Touched Channel', { review: true })
    await writeFinalReview(channel.finalPath, 'needs_changes')
    const later = new Date(Date.now() + 30_000)
    await fs.utimes(channel.finalPath, later, later)

    const review = await readFinalReview(channel.finalPath)
    assert.equal(review.state, 'stale')
    assert.equal(review.decision, 'needs_changes')
    assert.equal(review.current?.size, 64)
    assert.notEqual(review.current?.mtime_ms, review.recorded.mtime_ms)
  })

  test('goes stale when a same-size, same-modified-time replacement lands (new inode)', async () => {
    const channel = await makeChannel('Same Size Channel', { review: true })
    const before = await fs.stat(channel.finalPath)
    await writeFinalReview(channel.finalPath, 'approved')
    // An atomic replacement with identical size and modified time but a new inode:
    // only the inode distinguishes it from the reviewed file.
    const temp = path.join(path.dirname(channel.finalPath), 'replacement.tmp')
    await fs.writeFile(temp, Buffer.alloc(before.size, 9))
    await fs.utimes(temp, new Date(before.mtimeMs), new Date(before.mtimeMs))
    await fs.rename(temp, channel.finalPath)
    const replaced = await fs.stat(channel.finalPath)
    assert.equal(replaced.size, before.size)
    assert.equal(Math.trunc(replaced.mtimeMs), Math.trunc(before.mtimeMs))
    assert.notEqual(replaced.ino, before.ino)

    const review = await readFinalReview(channel.finalPath)
    assert.equal(review.state, 'stale')
  })

  test('goes stale, with no "current", when the final is gone', async () => {
    const channel = await makeChannel('Missing Channel', { review: true })
    await writeFinalReview(channel.finalPath, 'approved')
    await fs.rename(channel.finalPath, `${channel.finalPath}.moved`)

    const review = await readFinalReview(channel.finalPath)
    assert.equal(review.state, 'stale')
    assert.equal(review.current, null)
  })

  test('a fresh final is "not reviewed" rather than stale or unreadable', async () => {
    const channel = await makeChannel('Fresh Channel', { review: true })
    assert.deepEqual(await readFinalReview(channel.finalPath), { state: 'not_reviewed' })
  })

  test('a torn or version-less mark reads unreadable, never "not reviewed"', async () => {
    const channel = await makeChannel('Torn Channel', { review: true })
    const sidecar = finalReviewSidecarPath(channel.finalPath)
    await fs.writeFile(sidecar, '{ not json')
    const torn = await readFinalReview(channel.finalPath)
    assert.equal(torn.state, 'unreadable')
    assert.match(torn.error, /not valid JSON/)

    await fs.writeFile(sidecar, JSON.stringify({ decision: 'approved', decided_at: 'now', identity: { version: 2 } }))
    const wrongVersion = await readFinalReview(channel.finalPath)
    assert.equal(wrongVersion.state, 'unreadable')
    assert.match(wrongVersion.error, /version-1/)
  })

  test('refuses to mark a final that is not there', async () => {
    const channel = await makeChannel('Gone Channel', { review: true })
    await fs.rename(channel.finalPath, `${channel.finalPath}.moved`)
    await assert.rejects(() => writeFinalReview(channel.finalPath, 'approved'), (error: any) => {
      assert.equal(error.statusCode, 409)
      return true
    })
  })
})

describe('review is off unless a channel turns it on', () => {
  test('an absent switch means off and the listing does not walk the channel', async () => {
    const channel = await makeChannel('Off Channel')
    const config = await pm.getConfig(channel.slug)
    assert.equal(finalReviewEnabled(config), false)

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.channels.length, 1)
    assert.equal(listed.channels[0].review_enabled, false)
    assert.equal(listed.channels[0].final_count, 0)
    assert.deepEqual(listed.finals, [])

    // Nothing was written beside the final by a read.
    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
  })

  test('a channel whose review setting could not be read says so instead of reading as off', async () => {
    const channel = await makeChannel('Corrupt Config Channel', { review: true })
    // A corrupt config.json makes the config read THROW; that must not look
    // like the owner turned review off (AGENTS.md §6).
    await fs.writeFile(path.join(pm.getProjectDir(channel.slug)!, 'config.json'), '{ not json')

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.channels.length, 1)
    assert.equal(listed.channels[0].review_enabled, false)
    assert.match(String(listed.channels[0].error || ''), /could not read this channel's review setting/i)
    assert.deepEqual(listed.finals, [])
  })

  test('turning it on lists the final; turning it off hides it and keeps the mark', async () => {
    const channel = await makeChannel('Switch Channel')
    await pm.updateConfig(channel.slug, { final_review: { enabled: true } })
    await writeFinalReview(channel.finalPath, 'approved')

    const on = await listFinalReviews({ slug: channel.slug })
    assert.equal(on.channels[0].review_enabled, true)
    assert.equal(on.finals.length, 1)
    assert.equal(on.finals[0].episode_code, channel.code)
    assert.equal(on.finals[0].review.state, 'current')

    await pm.updateConfig(channel.slug, { final_review: { enabled: false } })
    const off = await listFinalReviews({ slug: channel.slug })
    assert.equal(off.channels[0].review_enabled, false)
    assert.deepEqual(off.finals, [])
    // Turning the switch off is not a deletion — the mark is still on disk.
    assert.equal((await readFinalReview(channel.finalPath)).state, 'current')
  })
})

describe('the listing', () => {
  test('is newest first across channels and includes hand-imported finals', async () => {
    const older = await makeChannel('Older Channel', { code: 'EP0001', review: true })
    const newer = await makeChannel('Newer Channel', { code: 'EP0002', review: true, bytes: 80 })
    const olderWhen = new Date(Date.now() - 3_600_000)
    await fs.utimes(older.finalPath, olderWhen, olderWhen)

    const listed = await listFinalReviews()
    const mine = listed.finals.filter(item => item.channel_slug === older.slug || item.channel_slug === newer.slug)
    assert.deepEqual(mine.map(item => item.channel_slug), [newer.slug, older.slug])
    assert.ok(mine[0]!.stream_url.startsWith(`/api/projects/${encodeURIComponent(newer.slug)}/video-editor/final-video/${newer.code}`))
  })

  test('says which episodes could not be read instead of reporting no finals', async () => {
    const channel = await makeChannel('Broken Channel', { review: true })
    // A second accepted episode whose title would resolve outside the episode
    // folder: reading it fails, while the channel's real final still lists.
    const ideasPath = path.join(pm.getProjectDir(channel.slug)!, 'ideas.json')
    const store = JSON.parse(await fs.readFile(ideasPath, 'utf8'))
    store.ideas.push({
      ...store.ideas[0],
      id: 'idea-broken',
      title: 'Bad/Title',
      episode_code: 'EP0002',
    })
    await fs.writeFile(ideasPath, JSON.stringify(store))

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.channels[0].error, '1 episode could not be read.')
    assert.deepEqual(listed.finals.map(item => item.episode_code), [channel.code])
  })
})

describe('HTTP routes', () => {
  const app = express()
  app.use(express.json())
  app.use('/api', reviewRouter)

  test('GET refuses an unknown channel instead of answering "no finals"', async () => {
    await request(app).get('/api/review/finals?slug=not-a-channel').expect(404)
  })

  test('PUT turns review on, and POST stores a mark against the exact final', async () => {
    const channel = await makeChannel('Route Channel')

    await request(app)
      .put(`/api/review/channels/${channel.slug}`)
      .send({ enabled: true })
      .expect(200)
    assert.equal((await pm.getConfig(channel.slug))?.final_review?.enabled, true)

    const stat = await fs.stat(channel.finalPath)
    const saved = await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({ decision: 'approved', expected_size: stat.size, expected_mtime_ms: stat.mtimeMs, expected_ino: stat.ino })
      .expect(200)
    assert.equal(saved.body.review.state, 'current')
    assert.equal(saved.body.review.identity.path, channel.finalPath)

    const listed = await request(app).get(`/api/review/finals?slug=${channel.slug}`).expect(200)
    assert.equal(listed.body.finals.length, 1)
    assert.equal(listed.body.finals[0].review.decision, 'approved')
  })

  test('POST refuses a mark when the file changed after the reviewer loaded it', async () => {
    const channel = await makeChannel('Route Changed Channel', { review: true })
    const stat = await fs.stat(channel.finalPath)
    await fs.writeFile(channel.finalPath, Buffer.alloc(96, 1))

    const refused = await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({ decision: 'approved', expected_size: stat.size, expected_mtime_ms: stat.mtimeMs, expected_ino: stat.ino })
      .expect(409)
    assert.match(refused.body.detail, /changed while you were reviewing/)
    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))

    // The new file can still be reviewed — with ITS identity.
    const fresh = await fs.stat(channel.finalPath)
    await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({ decision: 'approved', expected_size: fresh.size, expected_mtime_ms: fresh.mtimeMs, expected_ino: fresh.ino })
      .expect(200)
    assert.equal((await readFinalReview(channel.finalPath)).state, 'current')
  })

  test('POST refuses a same-size rewrite whose modified time moved', async () => {
    const channel = await makeChannel('Route Same Size Channel', { review: true })
    const before = await fs.stat(channel.finalPath)
    // Rewrite in place to the SAME size, then move the modified time forward.
    await fs.writeFile(channel.finalPath, Buffer.alloc(before.size, 3))
    const later = new Date(before.mtimeMs + 60_000)
    await fs.utimes(channel.finalPath, later, later)
    const now = await fs.stat(channel.finalPath)
    assert.equal(now.size, before.size)
    assert.notEqual(Math.trunc(now.mtimeMs), Math.trunc(before.mtimeMs))

    const refused = await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      // size + inode still match the file; only the modified time is stale.
      .send({ decision: 'approved', expected_size: before.size, expected_mtime_ms: before.mtimeMs, expected_ino: now.ino })
      .expect(409)
    assert.match(refused.body.detail, /changed while you were reviewing/)
    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
  })

  test('POST refuses a replacement of the same size and modified time with a new inode', async () => {
    const channel = await makeChannel('Route Same Inode Channel', { review: true })
    const before = await fs.stat(channel.finalPath)
    // Atomic replacement: identical size and modified time, different inode.
    const temp = path.join(path.dirname(channel.finalPath), 'route-replacement.tmp')
    await fs.writeFile(temp, Buffer.alloc(before.size, 4))
    await fs.utimes(temp, new Date(before.mtimeMs), new Date(before.mtimeMs))
    await fs.rename(temp, channel.finalPath)
    const replaced = await fs.stat(channel.finalPath)
    assert.equal(replaced.size, before.size)
    assert.equal(Math.trunc(replaced.mtimeMs), Math.trunc(before.mtimeMs))
    assert.notEqual(replaced.ino, before.ino)

    const refused = await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      // size + mtime + path all match the file the reviewer loaded; only the inode differs.
      .send({ decision: 'approved', expected_size: before.size, expected_mtime_ms: before.mtimeMs, expected_ino: before.ino })
      .expect(409)
    assert.match(refused.body.detail, /changed while you were reviewing/)
    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
  })

  test('POST needs the identity the reviewer was looking at', async () => {
    const channel = await makeChannel('Route No Expectation', { review: true })
    await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({ decision: 'approved' })
      .expect(400)
  })

  test('POST is refused for an off channel and writes nothing', async () => {
    const channel = await makeChannel('Route Off Channel')
    const stat = await fs.stat(channel.finalPath)
    await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({ decision: 'approved', expected_size: stat.size, expected_mtime_ms: stat.mtimeMs, expected_ino: stat.ino })
      .expect(409)
    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
  })

  test('POST rejects an unknown decision', async () => {
    const channel = await makeChannel('Route Bad Decision', { review: true })
    await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({ decision: 'maybe' })
      .expect(400)
  })

  test('POST refuses an episode with no accepted final', async () => {
    const channel = await makeChannel('Route No Final', { review: true })
    const stat = await fs.stat(channel.finalPath)
    await fs.rm(channel.finalPath)
    await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({ decision: 'approved', expected_size: stat.size, expected_mtime_ms: stat.mtimeMs, expected_ino: stat.ino })
      .expect(404)
  })
})
