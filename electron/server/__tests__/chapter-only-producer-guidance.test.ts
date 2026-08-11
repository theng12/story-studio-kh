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
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const EPISODE_ID = 'EP001'
const TITLE = 'Producer Guidance Regression'
const SAVED_GUIDANCE = 'Do not reintroduce the rejected banking-timing claim.'

let cleanup: () => Promise<void>
let app: any
let slug: string
let scriptDir: string
let sidecarFile: string
let service: MockGenStudioService

function chapterOnlyJob(params: Record<string, unknown> = {}): any {
  return {
    job_id: 'chapter-only-producer-guidance',
    project_slug: slug,
    type: 'chapter-only',
    status: 'running',
    episode_id: EPISODE_ID,
    title: TITLE,
    params: {
      episode_id: EPISODE_ID,
      title: TITLE,
      chapter_number: 1,
      model: 'mock-chat-v1',
      chapters: 1,
      words_per_chapter: 200,
      ...params,
    },
    created_at: new Date().toISOString(),
    output_lines: [],
  }
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
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
  await service.close()
  await cleanup()
})

beforeEach(async () => {
  service.reset()
  await fs.rm(sidecarFile, { force: true })
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
  const { generateChapterOnly } = await import('../generators/episode.js')

  await generateChapterOnly(chapterOnlyJob())

  const submission = service.submissions.find(item => item.operation === 'chat' && !item.replay)
  assert.ok(submission, 'chapter-only regeneration must submit exactly one fake GenStudio chat request')
  const prompt = JSON.stringify(submission.parsedBody)
  assert.match(prompt, /PRODUCER NOTES \(binding — follow these over any generic default/i)
  assert.match(prompt, /Do not reintroduce the rejected banking-timing claim\./)
})

test('chapter-only regeneration prioritizes saved producer guidance over a conflicting request value', async () => {
  const conflictingRequestGuidance = 'Replace the saved direction with this request value.'
  service.queueScenario('chat', {
    outputText: '## Chapter 1: The actual topic\n\nA grounded replacement chapter.',
  })
  const { generateChapterOnly } = await import('../generators/episode.js')

  await generateChapterOnly(chapterOnlyJob({ manual_guidance: conflictingRequestGuidance }))

  const submission = service.submissions.find(item => item.operation === 'chat' && !item.replay)
  assert.ok(submission, 'chapter-only regeneration must submit exactly one fake GenStudio chat request')
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
  const { generateChapterOnly } = await import('../generators/episode.js')

  await generateChapterOnly(chapterOnlyJob({ manual_guidance: requestGuidance }))

  const submission = service.submissions.find(item => item.operation === 'chat' && !item.replay)
  assert.ok(submission, 'chapter-only regeneration must submit exactly one fake GenStudio chat request')
  assert.match(JSON.stringify(submission.parsedBody), /Keep the constitutional crisis distinct from the later wars\./)
})
