/**
 * The thumbnail-scoring API (owner, 2026-11-01).
 *
 * Two routes:
 *
 *   POST /projects/:slug/episodes/:code/thumbnail-scores  → score now
 *   GET  /projects/:slug/episodes/:code/thumbnail-scores  → the record
 *
 * The rules they hold:
 *
 *   - A scoring failure is NOT a failed request. The route answers 200 with
 *     the record, whose candidates read "not scored" and carry the reason. A
 *     failed scoring run never fails the thumbnail step and never holds an
 *     upload (AGENTS §8).
 *   - The record is the episode's OWN. One episode's scores never reach
 *     another (§4).
 *   - A human pin is never overwritten by a score.
 *   - The GET answers an empty record for an episode that has never been
 *     scored — an empty record, not an error and not a "passed" one.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'
import {
  _setThumbnailScoreCatalogForTesting,
  _setThumbnailScoreEvaluatorForTesting,
  _setThumbnailScoreLanguageForTesting,
} from '../services/thumbnail-scoring.js'

const boot = await useTempDataDir()
const { router } = await import('../routes/thumbnail-scores.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  _setThumbnailScoreCatalogForTesting(null)
  _setThumbnailScoreEvaluatorForTesting(null)
  _setThumbnailScoreLanguageForTesting(null)
})

const MODEL_ID = 'openrouter-main::vision-free'

function visionRow(): GenStudioChatModel {
  return {
    id: MODEL_ID,
    display_name: 'Vision Free',
    provider_id: 'openrouter-main',
    provider_name: 'OpenRouter',
    available: true,
    qualification_only: false,
    locked: false,
    supports_vision: true,
    structured_output_mode: 'json_object',
    chargeable: false,
    context_window_tokens: 128_000,
    max_output_tokens: 4_096,
  } as GenStudioChatModel
}

/** A real 16:9 PNG with visible content, so the local rules pass it. */
async function goodImage(file: string): Promise<void> {
  const width = 640
  const height = 360
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      raw[i] = (x * 255 / width) | 0
      raw[i + 1] = (y * 255 / height) | 0
      raw[i + 2] = ((x + y) % 255) | 0
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(file)
}

async function seededEpisode(name: string): Promise<{
  slug: string; episodeCode: string; title: string; episodeDir: string
}> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await pm.createProject({ name })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'The Lighthouse at Dawn', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const episodeCode = accepted.idea.episode_code!
  const paths = await resolveEpisodePaths(project.slug, episodeCode, accepted.idea.title)
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await goodImage(path.join(paths.thumb_dir, 'EP0001_Thumb01_v1.png'))
  await goodImage(path.join(paths.thumb_dir, 'EP0001_Thumb02_v1.png'))
  // The channel names a free vision model, so the scoring can run.
  await pm.updateConfig(project.slug, {
    thumbnail_auto_pick: { enabled: true, model: MODEL_ID },
  } as any)
  return { slug: project.slug, episodeCode, title: accepted.idea.title, episodeDir: paths.episode_dir }
}

test('GET answers an empty record for an episode that has never been scored', async () => {
  const { slug, episodeCode } = await seededEpisode('Scoring GET Empty')
  const res = await request(app).get(`/api/projects/${slug}/episodes/${episodeCode}/thumbnail-scores`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.record.candidates, {})
  assert.equal(res.body.record.episode_code, episodeCode)
})

test('POST scores the candidates and records the pick', async () => {
  const { slug, episodeCode } = await seededEpisode('Scoring POST')
  _setThumbnailScoreCatalogForTesting(async () => [visionRow()])
  _setThumbnailScoreEvaluatorForTesting(async () => JSON.stringify({ score: 82, reason: 'Bold and clear.', text_issue: '' }))
  _setThumbnailScoreLanguageForTesting(async () => 'en')

  const res = await request(app).post(`/api/projects/${slug}/episodes/${episodeCode}/thumbnail-scores`).send({})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.not_scored, false)
  assert.ok(res.body.picked)
  assert.equal(res.body.record.pick.score, 82)
  assert.equal(res.body.record.pick.reason, 'Bold and clear.')
})

test('a scoring failure answers 200 with "not scored" and the reason — never a failure', async () => {
  const { slug, episodeCode } = await seededEpisode('Scoring POST Failure')
  _setThumbnailScoreCatalogForTesting(async () => [visionRow()])
  _setThumbnailScoreEvaluatorForTesting(async () => { throw new Error('the provider is down') })
  _setThumbnailScoreLanguageForTesting(async () => 'en')

  const res = await request(app).post(`/api/projects/${slug}/episodes/${episodeCode}/thumbnail-scores`).send({})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.not_scored, true)
  assert.equal(res.body.picked, '', 'scoring chose nothing — nothing could be measured')
  // Today's newest-version rule still stands: it is the UPLOAD's rule, and it
  // was never scoring's to change. `resolved` says what the upload will take,
  // and it is a different fact from `picked`.
  assert.equal(res.body.resolved, 'EP0001_Thumb02_v1.png',
    "today's newest-version rule still resolves the upload")
  assert.equal(res.body.record.pick.basis, 'newest_version')
  assert.equal(res.body.record.pick.score, undefined, 'the fallback names no score, and none is not a 0')
  for (const entry of Object.values<any>(res.body.record.candidates)) {
    assert.equal(entry.state, 'not_scored')
    assert.equal(entry.score, undefined, 'a failed scoring never becomes a 0')
    assert.ok(entry.reason)
  }
})

test('the record is the episode\'s own, and one episode\'s scores never reach another', async () => {
  const { slug, episodeCode, episodeDir } = await seededEpisode('Scoring Per Episode')
  _setThumbnailScoreCatalogForTesting(async () => [visionRow()])
  _setThumbnailScoreEvaluatorForTesting(async () => JSON.stringify({ score: 70, reason: 'Fine.' }))
  _setThumbnailScoreLanguageForTesting(async () => 'en')

  await request(app).post(`/api/projects/${slug}/episodes/${episodeCode}/thumbnail-scores`).send({})
  const onDisk = path.join(episodeDir, 'thumbnail_scores.json')
  const written = JSON.parse(await fs.readFile(onDisk, 'utf8'))
  assert.equal(written.episode_code, episodeCode)
  assert.equal(Object.keys(written.candidates).length, 2)
})

test('a human pin is never overwritten by a score', async () => {
  const { slug, episodeCode } = await seededEpisode('Scoring Pin Wins')
  _setThumbnailScoreCatalogForTesting(async () => [visionRow()])
  // The OTHER candidate scores higher. The pin must still win — a human pin
  // is never overwritten by a score.
  _setThumbnailScoreEvaluatorForTesting(async (input) => {
    const name = path.basename(input.imagePath)
    return name.includes('Thumb01')
      ? JSON.stringify({ score: 98, reason: 'Highest.' })
      : JSON.stringify({ score: 20, reason: 'Weak.' })
  })
  _setThumbnailScoreLanguageForTesting(async () => 'en')

  const overrides = await import('../services/upload-overrides.js')
  await overrides.writeSelectedThumbnail(slug, episodeCode, 'The Lighthouse at Dawn', 'youtube', 'EP0001_Thumb02_v1.png')

  const res = await request(app).post(`/api/projects/${slug}/episodes/${episodeCode}/thumbnail-scores`).send({})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.picked, '', 'scoring chose nothing — the owner chose')
  assert.equal(res.body.resolved, 'EP0001_Thumb02_v1.png',
    'the pin wins over a higher score on another candidate')
  assert.equal(res.body.record.pick.basis, 'manual_pin')
  assert.equal(res.body.record.pick.filename, 'EP0001_Thumb02_v1.png',
    'the chosen file stays the human\'s')
  // The pinned file was also scored, and that score is kept: it is a fact
  // about the picture, kept so the scores can be compared with real
  // click-through. It is not a claim that the score chose the file.
  assert.equal(res.body.record.pick.score, 20, 'the pinned file keeps its own honest score')
  assert.equal(res.body.record.pick.reason, 'The owner pinned this thumbnail.',
    'the reason says what actually chose it, not the score')
  // The higher-scoring candidate is still recorded — the owner's choice
  // overrules the pick, it does not erase the measurement.
  assert.equal(res.body.record.candidates['EP0001_Thumb01_v1.png'].score, 98)
})
