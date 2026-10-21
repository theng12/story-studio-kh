/**
 * A chapter-only retry must retain the producer direction saved with the
 * approved outline. Removing the sidecar lookup in generateChapterOnly must
 * make this test fail: the real GenStudio submission would lose the note.
 */

import { after, before, beforeEach, test } from 'node:test'
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
const TITLE = 'Producer Guidance Regression'
const SAVED_GUIDANCE = 'Do not reintroduce the rejected banking-timing claim.'

const previousDataDir = process.env.STORY_STUDIO_DATA_DIR
const previousDisableListen = process.env.STORY_STUDIO_DISABLE_LISTEN
let fixtureRoot: string
let fixtureCleanup: (() => Promise<void>) | undefined
let app: any
let slug: string
let scriptDir: string
let sidecarFile: string
let service: MockGenStudioService
let jq: typeof import('../services/job-queue.js')

function chapterOnlyOptions(params: Record<string, unknown> = {}) {
  return {
    project_slug: slug,
    type: 'chapter-only' as const,
    episode_id: EPISODE_ID,
    title: TITLE,
    params: {
      episode_id: EPISODE_ID,
      title: TITLE,
      chapter_number: 1,
      model: 'mock-chat-v1',
      chapters: 1,
      // Small on purpose: the fake chapter is one sentence, and chapter-only
      // output is now audited for length against this target (2026-10-07).
      words_per_chapter: 5,
      ...params,
    },
  }
}

async function generateQueuedChapter(params: Record<string, unknown> = {}): Promise<MockGenStudioSubmission> {
  await jq.initializeQueuePauseState()
  const wasPaused = jq.isQueuePaused()
  if (!wasPaused) await jq.setQueuePaused(true)
  let queued: Job | null = null
  try {
    queued = jq.enqueuePreparedForTest(chapterOnlyOptions(params)) as Job
    await jq._waitForJobPersistenceForTesting()
    assert.equal(jq.getJob(queued.job_id)?.status, 'queued')
    assert.equal(jq._isJobWorkerActiveForTesting(queued.job_id), false,
      'the paused queue must not start the fixture executor')
    assert.equal(service.submissions.length, 0,
      'queue admission alone must not submit a Gateway request')

    const { generateChapterOnly } = await import('../generators/episode.js')
    await generateChapterOnly(queued)

    const submissions = service.submissions.filter(item => item.operation === 'chat' && !item.replay)
    assert.equal(submissions.length, 1, 'chapter-only regeneration must submit exactly one fake Gateway chat request')
    const submission = submissions[0]!
    const authoritative = await jq.loadAuthoritativeJob(slug, queued.job_id)
    assert.deepEqual(authoritative?.params?.script_document_requests, {
      version: 1,
      requests: [{
        episode_id: EPISODE_ID,
        item: 'chapter:1',
        request_key: submission.idempotencyKey,
      }],
    }, 'the exact logical document owner must be durable before the mock provider accepts the request')
    return submission
  } finally {
    if (queued) {
      const current = jq.getJob(queued.job_id)
      if (current && !['done', 'error', 'cancelled'].includes(current.status)) {
        await jq.requestJobCancellation(slug, queued.job_id)
      }
      await jq._waitForJobPersistenceForTesting()
      const terminal = jq.getJob(queued.job_id)
      if (terminal && ['done', 'error', 'cancelled'].includes(terminal.status)) {
        assert.equal(jq.removeTerminalJob(slug, queued.job_id), true)
        await jq._waitForJobPersistenceForTesting()
      }
    }
    if (jq.isQueuePaused() !== wasPaused) await jq.setQueuePaused(wasPaused)
  }
}

before(async () => {
  // The harness owns the fixture root and its cleanup; a checkout-local fixture
  // would fall outside the sandbox and make the queue's store writes fail.
  const fixture = await useTempDataDir()
  fixtureRoot = fixture.dir
  fixtureCleanup = fixture.cleanup
  setTestSafeStorageAvailable(true)
  await fs.mkdir(path.join(fixtureRoot, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  jq = await import('../services/job-queue.js')
  const project = await request(app).post('/api/projects').send({
    name: 'Producer Guidance Regression',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(project.status, 201)
  slug = project.body.slug

  service = await startMockGenStudioService()
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)

  const { resolveEpisodePaths } = await import('../services/utils.js')
  const paths = await resolveEpisodePaths(slug, EPISODE_ID, TITLE)
  scriptDir = paths.script_dir
  sidecarFile = path.join(scriptDir, `${EPISODE_ID}_chunked-progress.json`)
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

beforeEach(async () => {
  service.reset()
  try {
    await fs.access(sidecarFile)
    const retainedSidecars = path.join(fixtureRoot, '_trash', 'test-fixtures', 'prior-sidecars')
    await fs.mkdir(retainedSidecars, { recursive: true })
    await fs.rename(sidecarFile, path.join(retainedSidecars, `${Date.now()}-${path.basename(sidecarFile)}`))
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(sidecarFile, JSON.stringify({
    schema_version: 3,
    episode_id: EPISODE_ID,
    mode: 'listicle',
    total_chapters: 1,
    outline: [{ n: 1, title: 'The actual topic', hook_line: 'Stay grounded.' }],
    outline_completed_at: '2026-08-11T00:00:00.000Z',
    outline_approved_at: '2026-08-11T00:01:00.000Z',
    outline_edited_at: null,
    generation_params: {
      model: 'mock-chat-v1',
      words_per_chapter: 200,
      manual_guidance: SAVED_GUIDANCE,
    },
    chapters_done: [],
    params_hash: 'producer-guidance-test',
    last_updated: '2026-08-11T00:01:00.000Z',
  }, null, 2))
})

test('chapter-only regeneration sends saved producer guidance when its request omits it', async () => {
  service.queueScenario('chat', {
    outputText: '## Chapter 1: The actual topic\n\nA grounded replacement chapter.',
  })
  const submission = await generateQueuedChapter()
  const prompt = JSON.stringify(submission.parsedBody)
  assert.match(prompt, /PRODUCER NOTES \(binding — follow these over any generic default/i)
  assert.match(prompt, /Do not reintroduce the rejected banking-timing claim\./)
})

test('chapter-only regeneration prioritizes saved producer guidance over a conflicting request value', async () => {
  const conflictingRequestGuidance = 'Replace the saved direction with this request value.'
  service.queueScenario('chat', {
    outputText: '## Chapter 1: The actual topic\n\nA grounded replacement chapter.',
  })
  const submission = await generateQueuedChapter({ manual_guidance: conflictingRequestGuidance })
  const prompt = JSON.stringify(submission.parsedBody)
  assert.match(prompt, /Do not reintroduce the rejected banking-timing claim\./)
  assert.doesNotMatch(prompt, /Replace the saved direction with this request value\./)
})

test('chapter-only regeneration falls back to request producer guidance for sidecars without it', async () => {
  const requestGuidance = 'Keep the constitutional crisis distinct from the later wars.'
  const sidecar = JSON.parse(await fs.readFile(sidecarFile, 'utf-8'))
  delete sidecar.generation_params.manual_guidance
  await fs.writeFile(sidecarFile, JSON.stringify(sidecar, null, 2))
  service.queueScenario('chat', {
    outputText: '## Chapter 1: The actual topic\n\nA grounded replacement chapter.',
  })
  const submission = await generateQueuedChapter({ manual_guidance: requestGuidance })
  assert.match(JSON.stringify(submission.parsedBody), /Keep the constitutional crisis distinct from the later wars\./)
})
