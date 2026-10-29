/**
 * Chapter-only regeneration divides the Formula's word budget by THIS
 * episode's chapter count, not the Formula's default.
 *
 * Observed shape (Quote Shorts, 2026-10-29): a request that omits `chapters`
 * (a headless or Production API call — the UI always sends it) sized the
 * regeneration from `format.script.defaultChapterCount`. An episode whose
 * chapter count differs from the Formula default was therefore asked for a
 * chapter sized for a different episode: a 1-minute Short with 3 chapters
 * targeted its whole 120-word budget in one chapter instead of 40.
 *
 * The count the generator already resolved for this episode (`totalChapters`,
 * from the request's `chapters`, else the chapter files on disk) is the right
 * divisor. The expected number here is computed from the live effective format
 * (AGENTS.md §1 — no catalogue number is copied into the test).
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { setTestSafeStorageAvailable } from './safe-storage-test-double.js'
import type { Job } from '../models/types.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
  type MockGenStudioSubmission,
} from './fixtures/mock-genstudio-service.js'

const EPISODE_ID = 'EP001'
const TITLE = 'Episode Chapter Count Regression'
/** The episode's own count, deliberately different from the Quote Shorts Formula default. */
const EPISODE_CHAPTERS = 3
const REGENERATED = 3

const previousDataDir = process.env.STORY_STUDIO_DATA_DIR
const previousDisableListen = process.env.STORY_STUDIO_DISABLE_LISTEN
let fixtureRoot: string
let fixtureCleanup: (() => Promise<void>) | undefined
let app: any
let slug: string
let scriptDir: string
let service: MockGenStudioService
let jq: typeof import('../services/job-queue.js')
let format: Awaited<ReturnType<typeof import('../services/format-loader.js')['getEffectiveFormat']>>

/** ~50 words: above the audit's 40% of any realistic target, ending on a full stop. */
const MOCK_CHAPTER = '## Chapter 3: A grounded ending\n\n'
  + 'The lamp hums, the window keeps its quiet blue, and the evening settles into the room '
  + 'the way it always has. Nothing is decided tonight. The question stays open on the table, '
  + 'patient and unhurried, and the story lets it rest there until morning finds it again. '

before(async () => {
  const fixture = await useTempDataDir()
  fixtureRoot = fixture.dir
  fixtureCleanup = fixture.cleanup
  setTestSafeStorageAvailable(true)
  await fs.mkdir(path.join(fixtureRoot, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  jq = await import('../services/job-queue.js')
  // A Quote Shorts channel: the Formula publishes 1 minute, 120 wpm and ONE chapter by default.
  const project = await request(app).post('/api/projects').send({
    name: 'Episode Chapter Count Regression',
    niche_id: 'quote-shorts',
    formula_choice: 'selected',
    content_language: 'en',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(project.status, 201, JSON.stringify(project.body))
  slug = project.body.slug

  service = await startMockGenStudioService()
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)

  const { resolveEpisodePaths } = await import('../services/utils.js')
  const paths = await resolveEpisodePaths(slug, EPISODE_ID, TITLE)
  scriptDir = paths.script_dir
  await fs.mkdir(scriptDir, { recursive: true })
  const { chapterFilePath } = await import('../lib/narration-assembly.js')
  for (let n = 1; n <= EPISODE_CHAPTERS; n++) {
    await fs.writeFile(chapterFilePath(scriptDir, EPISODE_ID, n),
      `## Chapter ${n}: Prior chapter ${n}\n\nA body that already exists and stays as it is.\n`)
  }

  const { getEffectiveFormat } = await import('../services/format-loader.js')
  format = await getEffectiveFormat(slug, { episodeId: EPISODE_ID })
})

after(async () => {
  try {
    await service.close()
  } finally {
    await fixtureCleanup?.()
    if (previousDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
    else process.env.STORY_STUDIO_DATA_DIR = previousDataDir
    if (previousDisableListen === undefined) delete process.env.STORY_STUDIO_DISABLE_LISTEN
    else process.env.STORY_STUDIO_DISABLE_LISTEN = previousDisableListen
    setTestSafeStorageAvailable(true)
  }
})

test('a chapter-only request without `chapters` sizes the chapter by the episode\'s own count', async () => {
  // The formula's published numbers, read live; nothing is hardcoded here.
  // 1.4.369: Quote Shorts publishes its length in seconds (45 s). The generator
  // reads seconds first, so the expectation must too (AGENTS §1).
  const lengthSeconds = (format.script as { defaultLengthSeconds?: number }).defaultLengthSeconds
  const minutes = typeof lengthSeconds === 'number' && lengthSeconds > 0
    ? lengthSeconds / 60
    : format.script.defaultLengthMinutes
  const wordsPerMinute = format.script.defaultWordsPerMinute
  assert.ok(typeof wordsPerMinute === 'number' && wordsPerMinute > 0,
    'the Formula publishes a narration pace; without one the generator keeps its neutral default')
  const formulaChapters = format.script.defaultChapterCount
  const ownCount = Math.max(1, Math.round(minutes * wordsPerMinute / EPISODE_CHAPTERS))
  const formulaCount = Math.max(1, Math.round(minutes * wordsPerMinute / formulaChapters))
  assert.notEqual(formulaChapters, EPISODE_CHAPTERS,
    'the fixture is only meaningful while the episode count differs from the Formula default')
  assert.notEqual(ownCount, formulaCount, 'the two divisors must give different targets')

  service.queueScenario('chat', { outputText: MOCK_CHAPTER })
  await jq.initializeQueuePauseState()
  const wasPaused = jq.isQueuePaused()
  if (!wasPaused) await jq.setQueuePaused(true)
  let queued: Job | null = null
  let submission: MockGenStudioSubmission
  try {
    queued = jq.enqueuePreparedForTest({
      project_slug: slug,
      type: 'chapter-only',
      episode_id: EPISODE_ID,
      title: TITLE,
      params: {
        episode_id: EPISODE_ID,
        title: TITLE,
        chapter_number: REGENERATED,
        model: 'mock-chat-v1',
        // Deliberately NO `chapters`, NO `words_per_chapter` and NO `length`:
        // this is the headless/API request shape the defect was seen in.
      },
    }) as Job
    await jq._waitForJobPersistenceForTesting()

    const { generateChapterOnly } = await import('../generators/episode.js')
    await generateChapterOnly(queued)

    const submissions = service.submissions.filter(item => item.operation === 'chat' && !item.replay)
    assert.equal(submissions.length, 1, 'chapter-only regeneration must submit exactly one fake Gateway chat request')
    submission = submissions[0]!
  } finally {
    if (queued) {
      const current = jq.getJob(queued.job_id)
      if (current && !['done', 'error', 'cancelled'].includes(current.status)) {
        await jq.requestJobCancellation(slug, queued.job_id)
      }
      await jq._waitForJobPersistenceForTesting()
      const terminal = jq.getJob(queued.job_id)
      if (terminal && ['done', 'error', 'cancelled'].includes(terminal.status)) {
        jq.removeTerminalJob(slug, queued.job_id)
        await jq._waitForJobPersistenceForTesting()
      }
    }
    if (jq.isQueuePaused() !== wasPaused) await jq.setQueuePaused(wasPaused)
  }

  const prompt = JSON.stringify(submission.parsedBody)
  const plural = (format.script.sectionLabel?.plural || 'Chapters').toLowerCase()
  const singular = (format.script.sectionLabel?.singular || 'Chapter').toLowerCase()
  assert.match(prompt, new RegExp(`Total ${plural} in this episode: ${EPISODE_CHAPTERS}`),
    'the episode\'s own count is what the prompt already told the model')
  assert.match(prompt, new RegExp(`Target word count for this ${singular}: ~${ownCount} words`),
    `${minutes} min × ${wordsPerMinute} wpm ÷ this episode's ${EPISODE_CHAPTERS} chapters = ${ownCount} words`)
  assert.doesNotMatch(prompt, new RegExp(`~${formulaCount} words`),
    `the Formula's default ${formulaChapters}-chapter divisor must not size another episode's chapter`)
  assert.doesNotMatch(prompt, /~550 words/, 'the neutral long-form default must not leak in')
})
