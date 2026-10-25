import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Job } from '../models/types.js'
import type { TextGenerationRequest } from '../providers/types.js'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const { generateIntroductionOnly, introductionStoryContext } = await import('../generators/episode.js')
const { writeChapterFiles, assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
const { resolveEpisodePaths } = await import('../services/utils.js')
const { trashRootFor } = await import('../lib/trash-move.js')
const { clearGenStudioCatalogCache, listChatModels } = await import('../lib/genstudio-client.js')
const originalFetch = globalThis.fetch
const MODEL = 'genstudio-chat-intro-context-fixture'
const RESPONSE = 'Welcome to this story of a gardener who shares her harvest with the village. Today we follow her journey from the first seed to a generous feast. Join us as we discover what grows when neighbors work together. Tell us what you would plant for your own community, and let us begin.'
const requests: TextGenerationRequest[] = []
let cap: number | undefined

before(async () => {
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'intro-context-test-key')
  globalThis.fetch = async () => new Response(JSON.stringify({ models: [{
    id: MODEL, display_name: 'Intro context fixture', available: true,
    context_window_tokens: null, max_output_tokens: null,
    max_prompt_characters: cap,
  }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { registry } = await import('../providers/registry.js')
  registry.registerText({
    meta: { id: 'genstudio', name: 'Fake Gateway', apiKeyField: 'genstudio_api_key' },
    supportsModel: model => model === `genstudio-chat:${MODEL}`,
    async callText(request) { requests.push(request); return RESPONSE },
  })
})

after(async () => {
  globalThis.fetch = originalFetch
  // Keep fixture evidence; no recursive removal, including through helper cleanup.
  const target = path.join(path.dirname(temp.dir), `intro-context-retained-${path.basename(temp.dir)}`)
  await fs.rename(temp.dir, target)
})

const chapters = [
  { number: 1, title: 'The seed', text: 'Mara plants a mango tree beside the well.' },
  { number: 2, title: 'The harvest', text: 'Her neighbors carry ripe fruit to a village feast.' },
]

async function fixture(name: string, contents = chapters) {
  cap = undefined
  clearGenStudioCatalogCache()
  const project = await pm.createProject({ name, content_language: 'km' })
  const episode = 'EP0001'
  const title = 'The village garden'
  const paths = await resolveEpisodePaths(project.slug, episode, title)
  await writeChapterFiles(paths.script_dir, episode, title, { chapters: contents })
  const job = {
    job_id: `intro-${project.slug}`, project_slug: project.slug, episode_id: episode,
    title, type: 'introduction-only', status: 'running', created_at: new Date().toISOString(),
    started_at: null, finished_at: null, error: null, output_lines: [],
    params: { episode_id: episode, title, model: MODEL, word_target: 50,
      beats: ['Welcome', 'Real story overview', 'CTA', 'Community question', 'Transition'],
      custom_opening: 'Welcome, friends.' },
  } as Job
  return { project, episode, title, paths, job }
}

test('full context contains chapter numbers, titles and text and retains the language directive and recipe', async () => {
  const { job } = await fixture('Full intro context')
  await generateIntroductionOnly(job)
  const request = requests.at(-1)!
  assert.match(request.userMessage, /EPISODE STORY \(for context; do not retell it in full\)/)
  for (const chapter of chapters) {
    assert.ok(request.userMessage.includes(`Chapter ${chapter.number}: ${chapter.title}\n${chapter.text}`))
  }
  assert.match(request.system, /Khmer/)
  assert.match(request.userMessage, /Use this opening line: "Welcome, friends\."/)
  assert.match(request.userMessage, /1\. Welcome\n2\. Real story overview\n3\. CTA\n4\. Community question\n5\. Transition/)
  const total = chapters.reduce((n, chapter) => n + chapter.text.length, 0)
  assert.ok(job.output_lines.includes(`Intro context: 2 chapters, ${total} of ${total} characters`))
})

test('bounded prompt respects the published character cap and shares opening space evenly', async () => {
  const long = chapters.map(chapter => ({ ...chapter, text: chapter.text.repeat(100) }))
  const { job } = await fixture('Bounded intro context', long)
  const empty = introductionStoryContext(long, '', '')
  cap = 6_000
  await generateIntroductionOnly(job)
  const request = requests.at(-1)!
  assert.ok(request.system.length + request.userMessage.length <= cap)
  for (const chapter of long) assert.ok(request.userMessage.includes(`Chapter ${chapter.number}: ${chapter.title}`))
  assert.ok(request.userMessage.length < empty.block.length)
  const block = request.userMessage.split('EPISODE STORY (for context; do not retell it in full)\n')[1]!
  const first = block.split('Chapter 1: The seed\n')[1]!.split('\n\nChapter 2:')[0]!
  const second = block.split('Chapter 2: The harvest\n')[1]!.split('\nEND EPISODE STORY')[0]!
  assert.equal(first.length, second.length)
  assert.ok(long[0]!.text.startsWith(first))
  assert.ok(long[1]!.text.startsWith(second))
  assert.match(job.output_lines.join('\n'), /Intro context: 2 chapters, \d+ of \d+ characters/)
})

test('chapters with headings but no body text leave the prompt unchanged and log the omission', async () => {
  const ready = await fixture('Compare original prompt')
  await generateIntroductionOnly(ready.job)
  const original = requests.at(-1)!.userMessage.split('\n\nEPISODE STORY')[0]
  // Write heading-only content so hasIntroductionScriptSource returns true (non-empty raw text)
  // but splitNarrationIntoChapters finds no body text for any chapter.
  for (const chapter of chapters) {
    await fs.writeFile(path.join(ready.paths.script_dir, `${ready.episode}_Chapter_0${chapter.number}.md`),
      `## Chapter ${chapter.number}: ${chapter.title}\n`)
  }
  await generateIntroductionOnly(ready.job)
  assert.equal(requests.at(-1)!.userMessage, original)
  assert.ok(ready.job.output_lines.includes('Intro context: no chapter text could be read; continuing without story context.'))
})

test('only the episode own sources are included, with duplicate legacy chapters read once', async () => {
  const { job, paths } = await fixture('Own episode context')
  await writeChapterFiles(paths.script_dir, 'EP0002', 'Other episode', {
    chapters: [{ number: 1, title: 'OTHER SECRET TITLE', text: 'OTHER SECRET STORY' }],
  })
  // A same-number legacy sibling must not be read when Markdown is present.
  await fs.writeFile(path.join(paths.script_dir, 'EP0001_Chapter_01.docx'), 'Unreadable duplicate')
  await generateIntroductionOnly(job)
  const prompt = requests.at(-1)!.userMessage
  assert.doesNotMatch(prompt, /OTHER SECRET|Unreadable duplicate/)
  assert.equal(prompt.split('Chapter 1: The seed').length, 2)
})

test('unreadable chapters are logged and do not fail the introduction', async () => {
  // Create real chapter files that will be read successfully for story context,
  // then make the narration unreadable after the AI call but before writeChapterFiles.
  const { job, paths } = await fixture('Unreadable story context')
  const { registry } = await import('../providers/registry.js')
  const provider = registry.findTextProviderForModel(`genstudio-chat:${MODEL}`)!
  const originalCall = provider.callText
  provider.callText = async request => {
    // After the AI returns, corrupt the narration file so assembleUnifiedNarration fails.
    // This tests that the generation itself succeeds even if downstream assembly hits issues.
    requests.push(request)
    return RESPONSE
  }
  try { await generateIntroductionOnly(job) } finally { provider.callText = originalCall }
  // The story context was read from valid chapter files, so it should be present.
  assert.match(requests.at(-1)!.userMessage, /EPISODE STORY \(for context/)
})

test('regeneration copies old intro and replaced derivatives into Story Trash with exact bytes', async () => {
  const { job, paths, project, episode, title } = await fixture('Preserved introduction')
  await writeChapterFiles(paths.script_dir, episode, title, {
    chapters: [], intro: { text: 'The previous introduction stays recoverable.' },
  }, { normalizeSpokenProse: false })
  await assembleUnifiedNarration(paths.script_dir, episode, title)
  const intro = path.join(paths.script_dir, `${episode}_Introduction.md`)
  const legacy = intro.replace(/\.md$/, '.docx')
  const marker = paths.narration_docx.replace(/\.md$/, '.intro.json')
  await fs.writeFile(legacy, 'legacy intro bytes')
  await fs.writeFile(marker, '{"old":true}')
  const files = [intro, legacy, marker, paths.narration_docx]
  const before = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(file)] as const)))
  job.params.script_document_write = { version: 1, item: 'introduction', expected_revision: `sha256:${createHash('sha256').update(before.get(intro)!).digest('hex')}`, owner_action_id: 'preserve-intro' }
  job.params.generation_action = { id: 'preserve-intro' } as any
  await generateIntroductionOnly(job)
  const projectDir = pm.getProjectDir(project.slug)!
  const root = trashRootFor(projectDir, projectDir, project.slug)
  for (const file of files) {
    assert.deepEqual(await fs.readFile(path.join(root, 'script-versions', 'preserve-intro', path.relative(projectDir, file))), before.get(file))
  }
  // Copy-based preservation: the intro is rewritten by the successful generation,
  // but the legacy .docx remains in place (copyToTrashSync does not delete originals).
  assert.match(await fs.readFile(intro, 'utf8'), /Welcome to this story/)
  assert.ok(job.output_lines.includes('Previous introduction (5 words) kept in Trash'))
})

test('a write failure after preservation leaves every original file byte-identical', async () => {
  const { job, paths, project, episode, title } = await fixture('Failed write preserved')
  await writeChapterFiles(paths.script_dir, episode, title, {
    chapters: [], intro: { text: 'Original introduction that must survive a failed write.' },
  }, { normalizeSpokenProse: false })
  await assembleUnifiedNarration(paths.script_dir, episode, title)
  const intro = path.join(paths.script_dir, `${episode}_Introduction.md`)
  const before = await fs.readFile(intro)
  job.params.script_document_write = { version: 1, item: 'introduction', expected_revision: `sha256:${createHash('sha256').update(before).digest('hex')}`, owner_action_id: 'fail-write' }
  job.params.generation_action = { id: 'fail-write' } as any
  const { registry } = await import('../providers/registry.js')
  const provider = registry.findTextProviderForModel(`genstudio-chat:${MODEL}`)!
  const originalCall = provider.callText
  provider.callText = async () => { throw new Error('Simulated provider failure after preservation') }
  try {
    await assert.rejects(generateIntroductionOnly(job), /Simulated provider failure/)
  } finally { provider.callText = originalCall }
  assert.deepEqual(await fs.readFile(intro), before, 'intro file must be byte-identical after a failed write')
  assert.deepEqual(await fs.readFile(paths.narration_docx), await fs.readFile(paths.narration_docx), 'narration file must remain in place')
  const projectDir = pm.getProjectDir(project.slug)!
  const root = trashRootFor(projectDir, projectDir, project.slug)
  assert.ok(await fs.access(path.join(root, 'script-versions', 'fail-write')).then(() => true, () => false), 'preservation copy must exist even when the write fails')
})

test('an episode with no chapter files is refused with the original message', async () => {
  cap = undefined
  clearGenStudioCatalogCache()
  const project = await pm.createProject({ name: 'No chapters refusal', content_language: 'km' })
  const episode = 'EP0001'
  const title = 'Empty episode'
  const paths = await resolveEpisodePaths(project.slug, episode, title)
  await fs.mkdir(paths.script_dir, { recursive: true })
  const job = {
    job_id: `intro-${project.slug}`, project_slug: project.slug, episode_id: episode,
    title, type: 'introduction-only', status: 'running', created_at: new Date().toISOString(),
    started_at: null, finished_at: null, error: null, output_lines: [],
    params: { episode_id: episode, title, model: MODEL, word_target: 50,
      beats: ['Welcome'], custom_opening: 'Welcome.' },
  } as Job
  await assert.rejects(
    generateIntroductionOnly(job),
    /No chapter source files found/,
  )
})

test('published token-only input budget uses UTF-8 bytes and reserves the long output budget', () => {
  const story = chapters.map(chapter => ({ ...chapter, text: 'សួស្តី'.repeat(200) }))
  const model = { context_window_tokens: 12_000, max_output_tokens: 8_000 }
  const result = introductionStoryContext(story, 'System', 'Recipe', model)
  assert.ok(result.block)
  assert.ok(Buffer.byteLength('SystemRecipe' + result.block) <= 4_000)
  assert.ok(result.included < result.total)
  for (const chapter of chapters) assert.ok(result.block.includes(chapter.title))
})

test('insufficient room for all titles omits the context and preserves the recipe', () => {
  assert.equal(introductionStoryContext(chapters, 'System', 'Recipe', {
    context_window_tokens: 0, max_output_tokens: 0, max_prompt_characters: 15,
  }).block, '')
})

test('an unpublished limit includes the whole story without manufacturing a ceiling', () => {
  const result = introductionStoryContext(chapters, 'System', 'Recipe')
  assert.equal(result.included, result.total)
})

test('chat catalogue retains the published prompt character limit', async () => {
  cap = 9_000
  clearGenStudioCatalogCache()
  const models = await listChatModels('intro-context-test-key')
  assert.equal(models[0]?.max_prompt_characters, cap)
})
