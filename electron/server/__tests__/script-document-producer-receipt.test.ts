import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { waitFor } from './_timing.js'
import { withLock } from '../lib/atomic-store.js'

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let service: MockGenStudioService
let jq: typeof import('../services/job-queue.js')
let projectSlug = ''
let episodeId = ''

before(async () => {
  isolated = await useTempDataDir()
  service = await startMockGenStudioService()
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  jq = await import('../services/job-queue.js')
  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  await jq.setQueuePaused(true)
  const project = await pm.createProject({ name: 'Script document producer receipt' })
  projectSlug = project.slug
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Producer receipt fixture', logline: '', themes: [], suggested_chapters: 4,
    suggested_length: 'short', mood: 'calm',
  }], 'mock-chat-v1')
  episodeId = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await service.close()
  await isolated.cleanup()
})

function queuedChapter(chapter: number) {
  return jq.enqueuePreparedForTest({
    project_slug: projectSlug,
    type: 'chapter-only',
    episode_id: episodeId,
    title: 'Producer receipt fixture',
    params: {
      episode_id: episodeId,
      title: 'Producer receipt fixture',
      chapter_number: chapter,
      chapters: 4,
      model: 'mock-chat-v1',
      words_per_chapter: 8,
      auto_retry: false,
    },
  })
}

async function finishFixtureJob(jobId: string): Promise<void> {
  await jq.mutateAuthoritativeJob(projectSlug, jobId, current => {
    current.status = 'done'
    current.finished_at = new Date().toISOString()
    return current
  })
}

test('the actual chapter producer persists item and episode ownership before its provider POST', async t => {
  const source = queuedChapter(2)
  t.after(() => finishFixtureJob(source.job_id))
  service.queueScenario('chat', {
    states: ['accepted', 'succeeded'],
    outputText: '## Chapter 2: Exact receipt\n\nOne two three four five six seven eight nine ten eleven twelve.',
  })
  await import('../providers/text/genstudio.js')
  const { generateChapterOnly } = await import('../generators/episode.js')
  await generateChapterOnly(structuredClone(jq.getJob(source.job_id)!))
  const durable = jq.getJob(source.job_id)!
  assert.equal(service.providerSubmissionCount('chat'), 1)
  assert.equal(durable.params.script_document_requests.version, 1)
  assert.equal(durable.params.script_document_requests.requests.length, 1)
  assert.deepEqual(
    durable.params.script_document_requests.requests[0],
    {
      episode_id: episodeId,
      item: 'chapter:2',
      request_key: service.submissions.at(-1)!.idempotencyKey,
    },
  )
})

test('the actual outline producer persists its logical item receipt before provider submission', async t => {
  const source = jq.enqueuePreparedForTest({
    project_slug: projectSlug,
    type: 'outline_only',
    episode_id: episodeId,
    title: 'Producer receipt fixture',
    params: {
      episode_id: episodeId,
      title: 'Producer receipt fixture',
      chapters: 4,
      model: 'mock-chat-v1',
      style: 'auto',
      words_per_chapter: 100,
      total_words: 400,
      length: 4,
    },
  })
  t.after(() => finishFixtureJob(source.job_id))
  service.queueScenario('chat', {
    states: ['accepted', 'succeeded'],
    outputText: JSON.stringify({ chapters: Array.from({ length: 4 }, (_, index) => ({
      n: index + 1,
      title: `Receipt topic ${index + 1}`,
      synopsis: `The exact topic for chapter ${index + 1}.`,
      key_beats: ['One', 'Two'],
    })) }),
  })
  const before = service.providerSubmissionCount('chat')
  const { generateOutlineOnly } = await import('../generators/episode.js')
  await generateOutlineOnly(structuredClone(jq.getJob(source.job_id)!))
  const durable = jq.getJob(source.job_id)!
  assert.equal(service.providerSubmissionCount('chat'), before + 1)
  assert.deepEqual(durable.params.script_document_requests.requests, [{
    episode_id: episodeId,
    item: 'outline',
    request_key: service.submissions.at(-1)!.idempotencyKey,
  }])
})

test('the actual introduction producer persists its item receipt while retaining the episode owner', async t => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { writeChapterFiles } = await import('../lib/narration-assembly.js')
  const paths = await resolveEpisodePaths(projectSlug, episodeId, 'Producer receipt fixture')
  await writeChapterFiles(paths.script_dir, episodeId, 'Producer receipt fixture', {
    chapters: [{ number: 1, title: 'Existing', text: 'Existing chapter context remains available.' }],
  })
  const source = jq.enqueuePreparedForTest({
    project_slug: projectSlug,
    type: 'introduction-only',
    episode_id: episodeId,
    title: 'Producer receipt fixture',
    params: { episode_id: episodeId, title: 'Producer receipt fixture', model: 'mock-chat-v1' },
  })
  t.after(() => finishFixtureJob(source.job_id))
  service.queueScenario('chat', {
    states: ['accepted', 'succeeded'],
    outputText: `${Array.from({ length: 300 }, (_, index) => `opening${index + 1}`).join(' ')}.`,
  })
  const before = service.providerSubmissionCount('chat')
  const { generateIntroductionOnly } = await import('../generators/episode.js')
  await generateIntroductionOnly(structuredClone(jq.getJob(source.job_id)!))
  const durable = jq.getJob(source.job_id)!
  assert.equal(service.providerSubmissionCount('chat'), before + 1)
  assert.deepEqual(durable.params.script_document_requests.requests, [{
    episode_id: episodeId,
    item: 'introduction',
    request_key: service.submissions.at(-1)!.idempotencyKey,
  }])
})

test('authoritative episode or chapter drift blocks the actual producer before another provider POST', async () => {
  const source = queuedChapter(3)
  const executorCopy = structuredClone(jq.getJob(source.job_id)!)
  await jq.mutateAuthoritativeJob(projectSlug, source.job_id, current => {
    current.params.chapter_number = 4
    return current
  })
  const before = service.providerSubmissionCount('chat')
  const { generateChapterOnly } = await import('../generators/episode.js')
  await assert.rejects(generateChapterOnly(executorCopy), /no longer owns the prepared episode and logical item/)
  assert.equal(service.providerSubmissionCount('chat'), before)
  assert.equal(jq.getJob(source.job_id)?.params.script_document_requests, undefined)
  await finishFixtureJob(source.job_id)
})

test('ordinary chapter provider work finishes outside the shared narration promotion lock', async t => {
  const chapter = 4
  const source = queuedChapter(chapter)
  t.after(() => finishFixtureJob(source.job_id))
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { chapterFilePath, writeChapterFiles } = await import('../lib/narration-assembly.js')
  const paths = await resolveEpisodePaths(projectSlug, episodeId, 'Producer receipt fixture')
  const target = chapterFilePath(paths.script_dir, episodeId, chapter)
  await writeChapterFiles(paths.script_dir, episodeId, 'Producer receipt fixture', {
    chapters: [{ number: chapter, title: 'Old', text: 'Old chapter bytes stay active until promotion owns the document lock.' }],
  })
  const oldBytes = await fs.readFile(target)

  service.queueScenario('chat', {
    states: ['accepted', 'succeeded'],
    outputText: '## Chapter 4: New\n\nOne two three four five six seven eight nine ten eleven twelve.',
  })
  const submit = service.pauseNextSubmitResponse()
  const { generateChapterOnly } = await import('../generators/episode.js')
  let settled = false
  const executorJob = structuredClone(jq.getJob(source.job_id)!)
  const run = generateChapterOnly(executorJob)
    .finally(() => { settled = true })
  await submit.started

  let releaseLock!: () => void
  let markLockAcquired!: () => void
  const lockAcquired = new Promise<void>(resolve => { markLockAcquired = resolve })
  const hold = withLock(paths.narration_docx, async () => {
    markLockAcquired()
    await new Promise<void>(resolve => { releaseLock = resolve })
  })
  await lockAcquired
  try {
    const providerJobId = service.submissions.at(-1)!.jobId
    submit.release()
    await waitFor(() => service.pollCount(providerJobId) >= 1, {
      label: 'ordinary chapter provider result before promotion',
    })
    assert.deepEqual(await fs.readFile(target), oldBytes)
    assert.equal(settled, false, 'promotion and assembly wait for the shared narration lock')
  } finally {
    releaseLock()
    await hold
  }
  await run
  assert.match(await fs.readFile(target, 'utf8'), /New/)
})

test('the chapter-list legacy migration joins the canonical narration writer lock', () => {
  const source = readFileSync(fileURLToPath(new URL('../routes/scripts.ts', import.meta.url)), 'utf8')
  const route = source.slice(source.indexOf("router.get('/projects/:slug/episodes/:episodeId/chapter-list'"))
  assert.match(route, /await withLock\(paths\.narration_docx, \(\) =>\s*ensureChapterFilesMigrated\(/)
})
