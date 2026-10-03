import assert from 'node:assert/strict'
import fs, { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function source(relative: string): Promise<string> {
  return readFile(path.join(root, relative), 'utf8')
}

test('each visible fresh action retains one caller operation id until its submit resolves', async () => {
  const files = await Promise.all([
    source('frontend/pages/projects/[slug]/audio.vue'),
    source('frontend/pages/projects/[slug]/subtitles.vue'),
    source('frontend/pages/projects/[slug]/scripts.vue'),
    source('frontend/pages/projects/[slug]/introduction.vue'),
    // ChapterListPanel and OutlineReviewPanel share this one Regenerate action.
    source('frontend/composables/useChapterRegenerate.ts'),
    source('frontend/components/OutlineReviewPanel.vue'),
    source('frontend/pages/projects/[slug]/image-prompts.vue'),
    source('frontend/components/PromptReviewPanel.vue'),
    source('frontend/pages/projects/[slug]/scene-plan.vue'),
    source('frontend/pages/projects/[slug]/research.vue'),
    source('frontend/pages/projects/[slug]/contextual-cues.vue'),
    source('frontend/pages/projects/[slug]/images.vue'),
    source('frontend/pages/projects/[slug]/scene-review.vue'),
    source('frontend/pages/projects/[slug]/music.vue'),
    source('frontend/pages/projects/[slug]/pipeline.vue'),
  ])

  for (const code of files.slice(0, -1)) {
    assert.match(code, /operation_id/)
    assert.match(code, /useFreshGenerationAction\(\)/)
  }
  assert.match(files.at(-1)!, /runActionId/)
  assert.match(files.at(-1)!, /crypto\.randomUUID\(\)/)
})

test('server-owned fresh action reaches chat identity and forced Pipeline children', async () => {
  const [scriptsRoute, episode, chunked, promptRoute, scenePlan, research, cues, pipeline] = await Promise.all([
    source('electron/server/routes/scripts.ts'),
    source('electron/server/generators/episode.ts'),
    source('electron/server/lib/chunked-narration.ts'),
    source('electron/server/routes/image-prompts-edit.ts'),
    source('electron/server/generators/scene-plan.ts'),
    source('electron/server/generators/research.ts'),
    source('electron/server/generators/contextual-cues.ts'),
    source('electron/server/routes/pipeline.ts'),
  ])

  assert.match(scriptsRoute, /stampFreshGenerationAction\(body, operationId\)/)
  assert.match(episode, /freshGenerationRequestIdentity/)
  assert.match(chunked, /freshGenerationRequestIdentity/)
  assert.match(promptRoute, /requestIdentity:\s*`[^`]*\$\{operationId\}/)
  assert.match(scenePlan, /freshGenerationRequestIdentity/)
  assert.match(research, /freshGenerationRequestIdentity/)
  assert.match(cues, /freshGenerationRequestIdentity/)
  assert.match(pipeline, /else if \(force\)[\s\S]{0,500}?generation_action:\s*\{\s*id:\s*operationId,\s*kind:\s*'fresh'\s*\}/)
})

test('thumbnail prompt default preserves completed prompts while force is a fresh action', async () => {
  const page = await source('frontend/pages/projects/[slug]/image-prompts.vue')
  // Default is fill-gaps; the only overwrite is the confirmed "Replace all" action.
  assert.match(page, /fill_gaps:\s*!replaceAll/)
  assert.match(page, /force:\s*replaceAll/)
  assert.match(page, /await runGenerate\('thumbnails', true\)/)
  assert.match(page, /freshImagePromptsAction\.begin\(payload\)/)
  assert.match(page, /operation_id:\s*operationId/)
})

test('prompt-row replay makes one provider request and concurrent different rows both survive', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => { await mock.close(); await isolated.cleanup() })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const app = (await import('../app.js')).app
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  const project = await pm.createProject({ name: 'Prompt row action fixture', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Two prompt rows', logline: '', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'calm',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  const promptPath = paths.thumb_prompts_docx.replace(/\.docx$/i, '.md')
  await fs.mkdir(path.dirname(promptPath), { recursive: true })
  await fs.writeFile(promptPath, [
    '# Thumbnail Prompts', '',
    '## Thumbnail 1: First', '', 'Original first prompt with enough detail.', '',
    '## Thumbnail 2: Second', '', 'Original second prompt with enough detail.', '',
  ].join('\n'))

  const endpoint = `/api/projects/${project.slug}/episodes/${accepted.episode_code}/image-prompts/regenerate`
  const body = (number: number, operationId: string) => ({
    kind: 'thumbnail', number, model: 'mock-chat-v1', title: idea!.title,
    current_title: number === 1 ? 'First' : 'Second',
    current_prompt: `Original ${number === 1 ? 'first' : 'second'} prompt with enough detail.`,
    operation_id: operationId,
  })

  mock.queueScenario('chat', { outputText: '{"title":"Fresh first","prompt":"Fresh first archive composition with a lantern and readable focal hierarchy."}' })
  const sameAction = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const [sameFirst, sameReplay] = await Promise.all([
    request(app).post(endpoint).send(body(1, sameAction)),
    request(app).post(endpoint).send(body(1, sameAction)),
  ])
  assert.equal(sameFirst.status, 200, JSON.stringify(sameFirst.body))
  assert.equal(sameReplay.status, 200, JSON.stringify(sameReplay.body))
  assert.equal(mock.providerSubmissionCount('chat'), 1, 'same row action replays one Gateway request')

  const completedReplay = await request(app).post(endpoint).send(body(1, sameAction))
  assert.equal(completedReplay.status, 200, JSON.stringify(completedReplay.body))
  assert.equal(completedReplay.body.reused, true)
  assert.equal(mock.providerSubmissionCount('chat'), 1, 'completed action returns its durable result')

  const mismatchedReplay = await request(app).post(endpoint).send({ ...body(1, sameAction), notes: 'Use a different subject.' })
  assert.equal(mismatchedReplay.status, 409, JSON.stringify(mismatchedReplay.body))
  assert.equal(mock.providerSubmissionCount('chat'), 1, 'changed scope cannot reuse an action id')

  mock.queueScenario('chat', { outputText: '{"title":"Latest first","prompt":"Latest first archive composition with a compass and strong focal hierarchy."}' })
  mock.queueScenario('chat', { outputText: '{"title":"Fresh second","prompt":"Fresh second archive composition with a map and strong focal hierarchy."}' })
  const [rowOne, rowTwo] = await Promise.all([
    request(app).post(endpoint).send(body(1, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')),
    request(app).post(endpoint).send(body(2, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')),
  ])
  assert.equal(rowOne.status, 200, JSON.stringify(rowOne.body))
  assert.equal(rowTwo.status, 200, JSON.stringify(rowTwo.body))
  const saved = await fs.readFile(promptPath, 'utf8')
  assert.match(saved, /Latest first archive composition/)
  assert.match(saved, /Fresh second archive composition/)

  mock.queueScenario('chat', {
    submitDelayMs: 300,
    outputText: '{"title":"Late answer","prompt":"Late provider answer that must not overwrite a newer manual prompt edit."}',
  })
  const delayed = request(app).post(endpoint).send(body(1, 'ffffffff-ffff-4fff-8fff-ffffffffffff'))
  const delayedResponse = delayed.then(response => response)
  await waitFor(() => mock.providerSubmissionCount('chat') === 4, {
    label: 'delayed prompt regeneration provider submission', timeoutMs: 5_000,
  })
  const manual = await request(app)
    .put(`${endpoint.replace('/regenerate', '/item')}?title=${encodeURIComponent(idea!.title)}`)
    .send({
      kind: 'thumbnail', number: 1, title: 'Manual edit',
      prompt: 'Manual prompt edit saved while the remote regeneration was still running.',
    })
  assert.equal(manual.status, 200, JSON.stringify(manual.body))
  const conflict = await delayedResponse
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body))
  const afterConflict = await fs.readFile(promptPath, 'utf8')
  assert.match(afterConflict, /Manual prompt edit saved while the remote regeneration was still running/)
  assert.doesNotMatch(afterConflict, /Late provider answer/)
})
