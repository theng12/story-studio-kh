/**
 * Final-video review marks — auto-pass and manual decision interactions.
 *
 * Tests for:
 *   - clearing a mark to not_reviewed, and a clear STAYING cleared across the
 *     next list GETs (auto-pass must not re-apply it to the same bytes);
 *   - auto-passing new finals when the per-channel switch is ON;
 *   - never back-filling older finals before the auto-pass switch was enabled;
 *   - letting the owner Pass, Needs changes or clear an auto-passed final;
 *   - stale-identity clear refusals, the clear moving the mark to Story's Trash,
 *     races between a clear and an in-flight auto-pass, and a persist failure
 *     that says so instead of pretending;
 *   - ensuring auto-pass writes a note-only sidecar and performs no upload/schedule/publish.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import type { FinalReviewDecision, FinalReviewState } from '../contracts/final-review.js'

const isolated = await useTempDataDir()

const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const settings = await import('../services/app-settings.js')
const {
  finalReviewEnabled,
  finalAutoPassEnabled,
  finalReviewSidecarPath,
  finalReviewClearedPath,
  listFinalReviews,
  readFinalReview,
  writeFinalReview,
  deleteFinalReview,
} = await import('../services/final-review.js')
const { router: reviewRouter } = await import('../routes/final-review.js')

before(async () => {
  await settings.setAppSetting('library_root', process.env.STORY_STUDIO_DATA_DIR!)
})

after(async () => {
  await isolated.cleanup()
})

/** The stored decision of a read mark; `undefined` when there is no decision. */
function decisionOf(review: FinalReviewState): FinalReviewDecision | undefined {
  return review.state === 'current' || review.state === 'stale' ? review.decision : undefined
}

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
  options: { code?: string; title?: string; bytes?: number; review?: boolean; autoPass?: boolean; autoPassSinceMs?: number } = {},
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
  if (options.autoPassSinceMs !== undefined) {
    // Built as a variable: the reserved types.ts still declares final_review as
    // `{ enabled }` only, and a fresh literal would trip the excess-property check.
    const block: { enabled: boolean; auto_pass: boolean; auto_pass_enabled_at: string } = {
      enabled: options.review !== false,
      auto_pass: true,
      auto_pass_enabled_at: new Date(Date.now() - options.autoPassSinceMs).toISOString(),
    }
    await pm.updateConfig(project.slug, { final_review: block })
  } else if (options.autoPass === true) {
    const block: { enabled: boolean; auto_pass: boolean; auto_pass_enabled_at: string } = {
      enabled: options.review !== false,
      auto_pass: true,
      auto_pass_enabled_at: new Date().toISOString(),
    }
    await pm.updateConfig(project.slug, { final_review: block })
  } else if (options.review === true) {
    await pm.updateConfig(project.slug, { final_review: { enabled: true } })
  }
  return { slug: project.slug, name, code, title, finalPath, episodeDir: paths.episode_dir }
}

describe('Review finals — clearing a mark', () => {
  test('deleteFinalReview removes the sidecar and reads as not_reviewed', async () => {
    const channel = await makeChannel('Clear Mark Channel', { review: true })
    await writeFinalReview(channel.finalPath, 'approved')
    assert.deepEqual(await readFinalReview(channel.finalPath), {
      state: 'current',
      decision: 'approved',
      decided_at: (await readFinalReview(channel.finalPath) as any).decided_at,
      identity: (await readFinalReview(channel.finalPath) as any).identity,
    })

    const result = await deleteFinalReview(channel.finalPath, { slug: channel.slug })
    assert.deepEqual(result, { state: 'not_reviewed' })
    assert.deepEqual(await readFinalReview(channel.finalPath), { state: 'not_reviewed' })

    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
  })

  test('deleteFinalReview is idempotent on a final that has no mark', async () => {
    const channel = await makeChannel('No Mark Channel', { review: true })
    const result = await deleteFinalReview(channel.finalPath, { slug: channel.slug })
    assert.deepEqual(result, { state: 'not_reviewed' })
  })

  test('POST with decision "clear" reverts to not_reviewed via the HTTP route', async () => {
    const channel = await makeChannel('HTTP Clear Channel', { review: true })
    const app = express()
    app.use(express.json())
    app.use('/api', reviewRouter)
    const stat = await fs.stat(channel.finalPath)
    await writeFinalReview(channel.finalPath, 'approved')

    const res = await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({
        decision: 'clear',
        expected_size: stat.size,
        expected_mtime_ms: stat.mtimeMs,
        expected_ino: stat.ino,
      })
      .expect(200)
    assert.equal(res.body.review.state, 'not_reviewed')
    assert.deepEqual(await readFinalReview(channel.finalPath), { state: 'not_reviewed' })
  })

  test('DELETE /review/finals/:slug/:code clears the mark via the HTTP route', async () => {
    const channel = await makeChannel('HTTP Delete Channel', { review: true })
    const app = express()
    app.use(express.json())
    app.use('/api', reviewRouter)
    await writeFinalReview(channel.finalPath, 'needs_changes')

    const res = await request(app)
      .delete(`/api/review/finals/${channel.slug}/${channel.code}`)
      .expect(200)
    assert.equal(res.body.review.state, 'not_reviewed')
    assert.deepEqual(await readFinalReview(channel.finalPath), { state: 'not_reviewed' })
  })
})

describe('Review finals — a deliberate clear is durable', () => {
  test('clear → list → list: auto-pass never re-applies to the same bytes', async () => {
    const channel = await makeChannel('Clear Stays Channel', { autoPassSinceMs: 10_000 })
    let listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(decisionOf(listed.finals[0].review), 'auto_passed')

    await deleteFinalReview(channel.finalPath, { slug: channel.slug })

    listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.state, 'not_reviewed')
    assert.equal(listed.channels[0].auto_pass_count, 0)

    listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.state, 'not_reviewed')
    assert.equal(listed.channels[0].auto_pass_count, 0)

    // The clear lives on disk beside the final, so a restart keeps it too.
    const cleared = JSON.parse(await fs.readFile(finalReviewClearedPath(channel.finalPath), 'utf8'))
    assert.equal(cleared.schema_version, 1)
    assert.equal(cleared.identity.path, channel.finalPath)
    assert.equal(cleared.identity.size, (await fs.stat(channel.finalPath)).size)
  })

  test('a re-rendered final is eligible for auto-pass again', async () => {
    const channel = await makeChannel('Rerender After Clear Channel', { autoPassSinceMs: 10_000 })
    await listFinalReviews({ slug: channel.slug })
    await deleteFinalReview(channel.finalPath, { slug: channel.slug })
    // New bytes at the same path: different size and modified time, so the
    // clear no longer names this file and auto-pass may apply once more.
    await fs.writeFile(channel.finalPath, Buffer.alloc(128, 9))
    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(decisionOf(listed.finals[0].review), 'auto_passed')
  })

  test('clearing with the identity of a replaced final is refused', async () => {
    const channel = await makeChannel('Stale Clear Channel', { review: true })
    const app = express()
    app.use(express.json())
    app.use('/api', reviewRouter)
    await writeFinalReview(channel.finalPath, 'approved')
    const before = await fs.stat(channel.finalPath)
    await fs.writeFile(channel.finalPath, Buffer.alloc(96, 5)) // replaced under the reviewer

    await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({
        decision: 'clear',
        expected_size: before.size,
        expected_mtime_ms: before.mtimeMs,
        expected_ino: before.ino,
      })
      .expect(409)
    // Nothing was removed: the mark on file is still there.
    await fs.access(finalReviewSidecarPath(channel.finalPath))

    const now = await fs.stat(channel.finalPath)
    const res = await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({
        decision: 'clear',
        expected_size: now.size,
        expected_mtime_ms: now.mtimeMs,
        expected_ino: now.ino,
      })
      .expect(200)
    assert.equal(res.body.review.state, 'not_reviewed')
  })

  test('clearing moves the mark to Story\'s Trash instead of deleting it', async () => {
    const channel = await makeChannel('Trash Mark Channel', { review: true })
    await writeFinalReview(channel.finalPath, 'approved')
    await deleteFinalReview(channel.finalPath, { slug: channel.slug })

    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
    const projectDir = pm.getProjectDir(channel.slug)!
    const trashed = path.join(
      path.dirname(projectDir), '_trash', channel.slug, 'review-marks',
      path.basename(finalReviewSidecarPath(channel.finalPath)),
    )
    const moved = await fs.readFile(trashed, 'utf8').catch(() => '')
    assert.match(moved, /"decision":"approved"/, 'the cleared mark must be recoverable from Trash')
  })

  test('an auto-pass write racing a clear is refused, not re-applied', async () => {
    const channel = await makeChannel('Race Clear Channel', { autoPassSinceMs: 10_000 })
    await listFinalReviews({ slug: channel.slug }) // auto-passed these bytes
    await deleteFinalReview(channel.finalPath, { slug: channel.slug })
    const now = await fs.stat(channel.finalPath)
    // An auto-pass from a list that started before the clear lands after it.
    await assert.rejects(
      () => writeFinalReview(channel.finalPath, 'auto_passed', { size: now.size, mtime_ms: now.mtimeMs, ino: now.ino }),
      (error: any) => error?.statusCode === 409,
    )
    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.state, 'not_reviewed')
  })

  test('an auto-pass that cannot save its mark says so instead of pretending', async () => {
    const channel = await makeChannel('AutoPass Fail Channel', { autoPassSinceMs: 10_000 })
    // Unreadable bytes: the identity hash cannot be taken, so the write fails.
    await fs.chmod(channel.finalPath, 0o000)
    try {
      const listed = await listFinalReviews({ slug: channel.slug })
      assert.equal(listed.finals[0].review.state, 'not_reviewed')
      assert.equal(listed.channels[0].auto_pass_count, 0)
      assert.match(listed.finals[0].auto_pass_error || '', /Could not save the auto-pass/)
    } finally {
      await fs.chmod(channel.finalPath, 0o644)
    }
  })
})

describe('Review finals — auto-pass behavior', () => {
  test('finalAutoPassEnabled reads true only when both review and auto_pass are on', async () => {
    const offChannel = await makeChannel('AutoOff Channel')
    const onlyReview = await makeChannel('OnlyReview Channel', { review: true })
    const bothOn = await makeChannel('BothOn Channel', { review: true, autoPass: true })

    assert.equal(finalAutoPassEnabled(await pm.getConfig(offChannel.slug)), false)
    assert.equal(finalAutoPassEnabled(await pm.getConfig(onlyReview.slug)), false)
    assert.equal(finalAutoPassEnabled(await pm.getConfig(bothOn.slug)), true)
  })

  test('auto-pass marks new finals as auto_passed without changing anything else', async () => {
    // Auto-pass was turned ON 10 seconds ago; final was written just now (mtime > auto_pass_since).
    const channel = await makeChannel('AutoPass New Channel', { autoPassSinceMs: 10_000 })

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.channels[0].auto_pass_enabled, true)
    assert.equal(listed.finals[0].review.state, 'current')
    assert.equal(decisionOf(listed.finals[0].review), 'auto_passed')
    assert.ok((listed.finals[0].review as any).decided_at, 'decided_at must be recorded with its time')
    assert.equal(listed.channels[0].auto_pass_count, 1)

    const sidecar = JSON.parse(await fs.readFile(finalReviewSidecarPath(channel.finalPath), 'utf8'))
    assert.equal(sidecar.decision, 'auto_passed')
    assert.equal(sidecar.schema_version, 1)

    // Auto-pass is note-only: no upload, no schedule, no publish, no pipeline read.
    // No sidecar upload/schedule/publish fields should exist.
    assert.equal(sidecar.upload, undefined)
    assert.equal(sidecar.publish_at, undefined)
  })

  test('finals that existed before the auto-pass switch was turned on are NOT back-filled', async () => {
    // auto-pass was enabled 2 hours ago; final file was written 2 hours ago (mtime < auto_pass_since).
    const channel = await makeChannel('Old Final Channel', { autoPassSinceMs: 7_200_000 })
    // Backdate the final file's mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 7_200_000)
    await fs.utimes(channel.finalPath, twoHoursAgo, twoHoursAgo)

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.state, 'not_reviewed')
    assert.equal(listed.channels[0].auto_pass_count, 0)

    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
  })

  test('a final with an existing manual decision is never overwritten by auto-pass', async () => {
    const channel = await makeChannel('Manual Decision Channel', { autoPassSinceMs: 10_000 })
    await writeFinalReview(channel.finalPath, 'needs_changes')

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.state, 'current')
    assert.equal(decisionOf(listed.finals[0].review), 'needs_changes')
  })

  test('owner can Pass an auto-passed final', async () => {
    const channel = await makeChannel('Pass Auto Channel', { autoPassSinceMs: 10_000 })
    // Auto-pass already ran
    let listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(decisionOf(listed.finals[0].review), 'auto_passed')

    // Owner clicks Pass: decision becomes approved
    const updated = await writeFinalReview(channel.finalPath, 'approved')
    assert.equal(updated.state, 'current')
    assert.equal(decisionOf(updated), 'approved')

    listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(decisionOf(listed.finals[0].review), 'approved')
  })

  test('owner can mark Needs changes on an auto-passed final', async () => {
    const channel = await makeChannel('Needs Changes Auto Channel', { autoPassSinceMs: 10_000 })
    const updated = await writeFinalReview(channel.finalPath, 'needs_changes')
    assert.equal(decisionOf(updated), 'needs_changes')

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(decisionOf(listed.finals[0].review), 'needs_changes')
  })

  test('owner can clear an auto-passed final back to not_reviewed', async () => {
    const channel = await makeChannel('Clear Auto Channel', { autoPassSinceMs: 10_000 })
    let listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(decisionOf(listed.finals[0].review), 'auto_passed')

    await deleteFinalReview(channel.finalPath, { slug: channel.slug })
    listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.state, 'not_reviewed')
  })

  test('HTTP PUT /review/channels/:slug with auto_pass true updates the config', async () => {
    const channel = await makeChannel('HTTP AutoPass Channel', { review: true })
    const app = express()
    app.use(express.json())
    app.use('/api', reviewRouter)

    const res = await request(app)
      .put(`/api/review/channels/${channel.slug}`)
      .send({ auto_pass: true })
      .expect(200)
    assert.equal(res.body.auto_pass_enabled, true)
    assert.equal(res.body.review_enabled, true)

    const config = await pm.getConfig(channel.slug)
    const saved = (config?.final_review ?? {}) as { auto_pass?: boolean; auto_pass_enabled_at?: string }
    assert.equal(saved.auto_pass, true)
    assert.ok(saved.auto_pass_enabled_at, 'enabled_at must be stamped when turning on')
  })

  test('HTTP POST with decision auto_passed is accepted as a manual auto-pass', async () => {
    const channel = await makeChannel('Manual AutoPass HTTP Channel', { review: true })
    const app = express()
    app.use(express.json())
    app.use('/api', reviewRouter)
    const stat = await fs.stat(channel.finalPath)

    const res = await request(app)
      .post(`/api/review/finals/${channel.slug}/${channel.code}`)
      .send({
        decision: 'auto_passed',
        expected_size: stat.size,
        expected_mtime_ms: stat.mtimeMs,
        expected_ino: stat.ino,
      })
      .expect(200)
    assert.equal(res.body.review.decision, 'auto_passed')
  })

  test('auto-pass is note-only: no queue, generator, upload or schedule step reads the mark', async () => {
    // Brief H: the mark authorises nothing. Pin the execution paths: none of
    // them may mention auto_passed or import the review service at all.
    const server = new URL('..', import.meta.url) // electron/server/
    const executionPaths = [
      'services/job-queue.ts',
      'generators/video.ts',
      'generators/youtube-upload.ts',
      'routes/youtube-upload-center.ts',
      'services/publish-cadence.ts',
    ]
    for (const rel of executionPaths) {
      const src = await fs.readFile(new URL(rel, server), 'utf8')
      assert.ok(!src.includes('auto_passed'), `${rel} must not read an auto-pass mark`)
      assert.ok(!src.includes('final-review'), `${rel} must not import the review service`)
    }
    // The review service itself imports nothing that uploads or publishes.
    const reviewSrc = await fs.readFile(new URL('services/final-review.ts', server), 'utf8')
    for (const line of reviewSrc.match(/^import .*$/gm) || []) {
      assert.ok(
        !/youtube-upload|publish-cadence|upload-center/.test(line),
        `review service must not import an upload/publish module: ${line}`,
      )
    }
  })
})
