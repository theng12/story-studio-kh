import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import type { TextGenerationRequest, TextProvider } from '../providers/types.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let generateIntroductionOnly: typeof import('../generators/episode.js')['generateIntroductionOnly']
let generateOutlineOnly: typeof import('../generators/episode.js')['generateOutlineOnly']
let generateChapterOnly: typeof import('../generators/episode.js')['generateChapterOnly']
let writeChapterFiles: typeof import('../lib/narration-assembly.js')['writeChapterFiles']
let resolveEpisodePaths: typeof import('../services/utils.js')['resolveEpisodePaths']
let saveChannelSegment: typeof import('../services/channel-segments.js')['saveChannelSegment']
const prompts: string[] = []
const requests: TextGenerationRequest[] = []

const MODEL = 'genstudio-chat-test-profiled-introduction-v1'
const FORMULA = {
  id: 'pastoral-introduction-test',
  name: 'Pastoral Introduction Test',
  description: 'Two pastoral opening modes.',
  builtin: false,
  schemaVersion: 1,
  exampleTopics: ['A passage'],
  introDefaults: { wordTarget: 70, beats: [{ id: 'welcome', custom_text: 'Parent welcome.' }] },
  narratorStyles: [
    { id: 'daily-a', label: 'Daily', description: 'Warm devotional.' },
    { id: 'teaching-a', label: 'Teaching', description: 'Clear teaching.' },
  ],
  defaultNarratorStyleId: 'daily-a',
  scriptStructure: {
    defaultChapterCount: 6, chapterCountRange: [4, 9], defaultLengthMinutes: 25,
    lengthMinutesRange: [20, 30], durationPresets: [20, 25, 30], defaultWordsPerMinute: 125,
    pacingArc: ['Open.', 'Close.'], additionalRules: ['Stay pastoral.'],
  },
  ideaSystemPromptRole: 'Parent idea role.',
  scriptSystemPromptRole: 'Parent script role.',
  productionKit: {
    id: 'pastoral-modes', label: 'Pastoral modes', description: 'Two modes.',
    episodeProfiles: [
      {
        id: 'daily', label: 'Daily reflection', description: 'Daily.', ideaAxisValue: 'daily reflection',
        narratorStyleId: 'daily-a',
        introDefaults: {
          wordTarget: 90,
          beats: [
            { id: 'scripture_reading', custom_text: 'read the passage aloud first, unhurried, before any greeting' },
            { id: 'transition', custom_text: 'hand over to the reflection gently' },
          ],
        },
      },
      {
        id: 'teaching', label: 'Expository teaching', description: 'Teaching.', ideaAxisValue: 'expository teaching',
        narratorStyleId: 'teaching-a',
        introDefaults: {
          wordTarget: 110,
          beats: [
            { id: 'scripture_reading', custom_text: 'read the passage aloud first, then let it sit for a beat' },
            { id: 'episode_roadmap', custom_text: 'say what it meant then, what it means now, and what it asks of you' },
          ],
        },
      },
    ],
  },
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  await fs.mkdir(path.join(pm.projectsRoot(), '.niches'), { recursive: true })
  await fs.writeFile(
    path.join(pm.projectsRoot(), '.niches', `${FORMULA.id}.json`),
    JSON.stringify(FORMULA),
  )
  ;({ generateChapterOnly, generateIntroductionOnly, generateOutlineOnly } = await import('../generators/episode.js'))
  ;({ writeChapterFiles } = await import('../lib/narration-assembly.js'))
  ;({ resolveEpisodePaths } = await import('../services/utils.js'))
  ;({ saveChannelSegment } = await import('../services/channel-segments.js'))
  const { registry } = await import('../providers/registry.js')
  const provider: TextProvider = {
    meta: { id: 'genstudio', name: 'Fake GenStudio', apiKeyField: 'genstudio_api_key' },
    supportsModel: model => model === `genstudio-chat:${MODEL}`,
    async callText(req: TextGenerationRequest): Promise<string> {
      requests.push(req)
      prompts.push(req.userMessage)
      if (req.outputContract) {
        return JSON.stringify([{ n: 1, title: 'Passage', synopsis: 'Explain the passage.', key_beats: ['Read it closely.'] }])
      }
      return 'A generated pastoral introduction with enough words for the fixture.'
    },
  }
  registry.registerText(provider)
})

test('outline generation resolves style auto to the accepted episode profile narrator', async () => {
  const project = await pm.createProject({ name: 'Pastoral auto narrator', niche_id: FORMULA.id })
  const [seeded] = await ideas.addIdeas(project.slug, [{
    title: 'Teaching narrator episode', logline: 'Teaching.', themes: [], suggested_chapters: 1,
    suggested_length: '25 min', mood: 'clear', idea_dimensions: { 'episode-profile': 'expository teaching' },
  }], MODEL)
  const accepted = await ideas.acceptIdea(project.slug, seeded!.id)
  const requestStart = requests.length

  await generateOutlineOnly({
    ...job(project.slug, accepted.episode_code, accepted.idea.title),
    job_id: `outline-${accepted.episode_code}`,
    type: 'outline_only',
    params: {
      episode_id: accepted.episode_code,
      title: accepted.idea.title,
      model: MODEL,
      style: 'auto',
      chapters: 1,
      words_per_chapter: 100,
      total_words: 100,
      length: 25,
    },
  } as Job)

  const outlineRequest = requests.slice(requestStart).find(request => request.outputContract)
  assert.ok(outlineRequest, 'outline provider request was captured')
  assert.match(outlineRequest.system, /Clear teaching\./)
  assert.doesNotMatch(outlineRequest.system, /Warm devotional\./)
})

after(async () => cleanup())

function job(slug: string, episodeCode: string, title: string): Job {
  return {
    job_id: `intro-${episodeCode}`,
    project_slug: slug,
    episode_id: episodeCode,
    title,
    type: 'introduction-only',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: [],
    params: { episode_id: episodeCode, title, model: MODEL },
  }
}

test('Introduction generation uses each accepted pastoral profile and preserves a channel recipe override', async () => {
  const project = await pm.createProject({ name: 'Pastoral intros', niche_id: FORMULA.id })
  const seeded = await ideas.addIdeas(project.slug, [
    {
      title: 'Daily episode', logline: 'Daily.', themes: [], suggested_chapters: 6,
      suggested_length: '25 min', mood: 'warm', idea_dimensions: { 'episode-profile': 'daily reflection' },
    },
    {
      title: 'Teaching episode', logline: 'Teaching.', themes: [], suggested_chapters: 6,
      suggested_length: '25 min', mood: 'clear', idea_dimensions: { 'episode-profile': 'expository teaching' },
    },
  ], MODEL)
  const daily = await ideas.acceptIdea(project.slug, seeded[0]!.id)
  const teaching = await ideas.acceptIdea(project.slug, seeded[1]!.id)

  for (const accepted of [daily, teaching]) {
    const paths = await resolveEpisodePaths(project.slug, accepted.episode_code, accepted.idea.title)
    await writeChapterFiles(paths.script_dir, accepted.episode_code, accepted.idea.title, {
      chapters: [{ number: 1, title: 'Passage', text: 'A chapter already exists.' }],
    })
    await generateIntroductionOnly(job(project.slug, accepted.episode_code, accepted.idea.title))
  }

  const introductionPrompts = prompts.filter(prompt => prompt.includes('Target introduction length:'))
  assert.match(introductionPrompts[0]!, /Target introduction length: 90 words/)
  assert.match(introductionPrompts[0]!, /read the passage aloud first, unhurried, before any greeting/)
  assert.doesNotMatch(introductionPrompts[0]!, /what it meant then/)
  assert.match(introductionPrompts[1]!, /Target introduction length: 110 words/)
  assert.match(introductionPrompts[1]!, /what it meant then, what it means now, and what it asks of you/)
  assert.doesNotMatch(introductionPrompts[1]!, /before any greeting/)

  await saveChannelSegment(project.slug, 'introduction', {
    recipe: {
      word_target: 77,
      beats: [{ id: 'welcome', label: 'Welcome & host intro', enabled: true, custom_text: 'use the channel owner wording' }],
    } as never,
  })
  await generateIntroductionOnly(job(project.slug, daily.episode_code, daily.idea.title))
  const overridePrompt = prompts.filter(prompt => prompt.includes('Target introduction length:')).at(-1)!
  assert.match(overridePrompt, /Target introduction length: 77 words/)
  assert.match(overridePrompt, /use the channel owner wording/)
  assert.doesNotMatch(overridePrompt, /before any greeting/)
})

test('chapter regeneration and Introduction resolve profile Auto while preserving an explicit owner narrator', async () => {
  const project = await pm.createProject({ name: 'Pastoral narrator consumers', niche_id: FORMULA.id })
  const [seeded] = await ideas.addIdeas(project.slug, [{
    title: 'Teaching consumer episode', logline: 'Teaching.', themes: [], suggested_chapters: 1,
    suggested_length: '25 min', mood: 'clear', idea_dimensions: { 'episode-profile': 'expository teaching' },
  }], MODEL)
  const accepted = await ideas.acceptIdea(project.slug, seeded!.id)
  const paths = await resolveEpisodePaths(project.slug, accepted.episode_code, accepted.idea.title)
  await writeChapterFiles(paths.script_dir, accepted.episode_code, accepted.idea.title, {
    chapters: [{ number: 1, title: 'Passage', text: 'A chapter already exists.' }],
  })

  const chapterRequestStart = requests.length
  for (const style of ['auto', 'daily-a']) {
    await generateChapterOnly({
      ...job(project.slug, accepted.episode_code, accepted.idea.title),
      job_id: `chapter-${style}-${accepted.episode_code}`,
      type: 'chapter-only',
      params: {
        episode_id: accepted.episode_code, title: accepted.idea.title, model: MODEL,
        style, chapter_number: 1, chapters: 1, words_per_chapter: 100,
      },
    } as Job)
  }
  const chapterPrompts = requests.slice(chapterRequestStart)
    .map(request => request.userMessage)
    .filter(prompt => prompt.startsWith('Regenerate ONLY'))
  assert.match(chapterPrompts[0]!, /Narrator style: Style teaching-a — Clear teaching\./)
  assert.doesNotMatch(chapterPrompts[0]!, /Narrator style: Style auto/)
  assert.match(chapterPrompts[1]!, /Narrator style: Style daily-a — Warm devotional\./)

  const introductionRequestStart = requests.length
  for (const style of ['auto', 'daily-a']) {
    await generateIntroductionOnly({
      ...job(project.slug, accepted.episode_code, accepted.idea.title),
      job_id: `intro-${style}-${accepted.episode_code}`,
      params: { episode_id: accepted.episode_code, title: accepted.idea.title, model: MODEL, style },
    })
  }
  const introductionPrompts = requests.slice(introductionRequestStart)
    .map(request => request.userMessage)
    .filter(prompt => prompt.includes('Target introduction length:'))
  assert.match(introductionPrompts[0]!, /Narrator style: teaching-a/)
  assert.doesNotMatch(introductionPrompts[0]!, /Narrator style: auto/)
  assert.match(introductionPrompts[1]!, /Narrator style: daily-a/)
})
