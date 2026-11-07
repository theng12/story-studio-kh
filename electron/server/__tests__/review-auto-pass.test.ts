/**
 * Final-video review marks — auto-pass and manual decision interactions.
 *
 * Tests for:
 *   - clearing a mark to not_reviewed;
 *   - auto-passing new finals when the per-channel switch is ON;
 *   - never back-filling older finals before the auto-pass switch was enabled;
 *   - letting the owner Pass, Needs changes or clear an auto-passed final;
 *   - ensuring auto-pass writes a note-only sidecar and performs no upload/schedule/publish.
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
  finalAutoPassEnabled,
  finalReviewSidecarPath,
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
    const pastDate = new Date(Date.now() - options.autoPassSinceMs).toISOString()
    await pm.updateConfig(project.slug, {
      final_review: {
        enabled: options.review !== false,
        auto_pass: true,
        auto_pass_enabled_at: pastDate,
      },
    })
  } else if (options.autoPass === true) {
    await pm.updateConfig(project.slug, {
      final_review: {
        enabled: options.review !== false,
        auto_pass: true,
        auto_pass_enabled_at: new Date().toISOString(),
      },
    })
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

    const result = await deleteFinalReview(channel.finalPath)
    assert.deepEqual(result, { state: 'not_reviewed' })
    assert.deepEqual(await readFinalReview(channel.finalPath), { state: 'not_reviewed' })

    await assert.rejects(() => fs.access(finalReviewSidecarPath(channel.finalPath)))
  })

  test('deleteFinalReview is idempotent on a final that has no mark', async () => {
    const channel = await makeChannel('No Mark Channel', { review: true })
    const result = await deleteFinalReview(channel.finalPath)
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
      .send({ decision: 'clear' })
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
    assert.equal(listed.finals[0].review.decision, 'auto_passed')
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
    assert.equal(listed.finals[0].review.decision, 'needs_changes')
  })

  test('owner can Pass an auto-passed final', async () => {
    const channel = await makeChannel('Pass Auto Channel', { autoPassSinceMs: 10_000 })
    // Auto-pass already ran
    let listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.decision, 'auto_passed')

    // Owner clicks Pass: decision becomes approved
    const updated = await writeFinalReview(channel.finalPath, 'approved')
    assert.equal(updated.state, 'current')
    assert.equal(updated.decision, 'approved')

    listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.decision, 'approved')
  })

  test('owner can mark Needs changes on an auto-passed final', async () => {
    const channel = await makeChannel('Needs Changes Auto Channel', { autoPassSinceMs: 10_000 })
    const updated = await writeFinalReview(channel.finalPath, 'needs_changes')
    assert.equal(updated.decision, 'needs_changes')

    const listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.decision, 'needs_changes')
  })

  test('owner can clear an auto-passed final back to not_reviewed', async () => {
    const channel = await makeChannel('Clear Auto Channel', { autoPassSinceMs: 10_000 })
    let listed = await listFinalReviews({ slug: channel.slug })
    assert.equal(listed.finals[0].review.decision, 'auto_passed')

    await deleteFinalReview(channel.finalPath)
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
    assert.equal(config?.final_review?.auto_pass, true)
    assert.ok(config?.final_review?.auto_pass_enabled_at, 'enabled_at must be stamped when turning on')
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
})
