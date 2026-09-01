import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: any
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')

const PROFILE_FORMULA = {
  id: 'route-profile-formula',
  name: 'Route Profile Formula',
  description: 'A test Formula with two operational modes.',
  builtin: false,
  schemaVersion: 1,
  exampleTopics: ['A passage'],
  narratorStyles: [
    { id: 'daily-voice', label: 'Daily voice', description: 'Warm and concise.' },
    { id: 'teaching-voice', label: 'Teaching voice', description: 'Patient and explanatory.' },
  ],
  defaultNarratorStyleId: 'daily-voice',
  introDefaults: { wordTarget: 70, beats: ['welcome'], exampleText: 'Parent example.' },
  scriptStructure: {
    defaultChapterCount: 5,
    chapterCountRange: [4, 8],
    defaultLengthMinutes: 20,
    lengthMinutesRange: [15, 35],
    durationPresets: [15, 20, 35],
    defaultWordsPerMinute: 130,
    pacingArc: ['Parent pace.'],
    additionalRules: ['Parent rule.'],
  },
  productionKit: {
    id: 'route-profile-kit',
    label: 'Route profiles',
    description: 'Two profiles.',
    episodeProfiles: [
      {
        id: 'daily', label: 'Daily', description: 'Daily.', ideaAxisValue: 'daily reflection',
        narratorStyleId: 'daily-voice', introDefaults: { wordTarget: 90 },
        scriptStructure: {
          defaultChapterCount: 6, chapterCountRange: [4, 9], defaultLengthMinutes: 25,
          lengthMinutesRange: [20, 30], durationPresets: [20, 25, 30], defaultWordsPerMinute: 125,
        },
      },
      {
        id: 'teaching', label: 'Teaching', description: 'Teaching.', ideaAxisValue: 'expository teaching',
        narratorStyleId: 'teaching-voice', introDefaults: { wordTarget: 110 },
        scriptStructure: {
          defaultChapterCount: 8, chapterCountRange: [6, 10], defaultLengthMinutes: 40,
          lengthMinutesRange: [35, 50], durationPresets: [35, 40, 50], defaultWordsPerMinute: 145,
        },
      },
    ],
  },
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  await fs.mkdir(path.join(pm.projectsRoot(), '.niches'), { recursive: true })
  await fs.writeFile(
    path.join(pm.projectsRoot(), '.niches', `${PROFILE_FORMULA.id}.json`),
    JSON.stringify(PROFILE_FORMULA),
  )
  app = (await import('../app.js')).app
})

after(async () => cleanup())

test('effective-format route resolves structure from the requested accepted episode code', async () => {
  const project = await pm.createProject({ name: 'Profile route', niche_id: PROFILE_FORMULA.id })
  const seeded = await ideas.addIdeas(project.slug, [
    {
      title: 'Daily', logline: 'Daily.', themes: [], suggested_chapters: 6,
      suggested_length: '25 min', mood: 'warm', idea_dimensions: { 'episode-profile': 'daily reflection' },
    },
    {
      title: 'Teaching', logline: 'Teaching.', themes: [], suggested_chapters: 8,
      suggested_length: '40 min', mood: 'clear', idea_dimensions: { 'episode-profile': 'expository teaching' },
    },
  ], 'test-model')
  const daily = await ideas.acceptIdea(project.slug, seeded[0]!.id)
  const teaching = await ideas.acceptIdea(project.slug, seeded[1]!.id)

  const dailyResponse = await request(app)
    .get(`/api/projects/${project.slug}/effective-format`)
    .query({ episode_id: daily.episode_code })
  assert.equal(dailyResponse.status, 200)
  assert.equal(dailyResponse.body.script.defaultLengthMinutes, 25)
  assert.equal(dailyResponse.body.script.defaultWordsPerMinute, 125)
  assert.deepEqual(dailyResponse.body.script.durationPresets, [20, 25, 30])
  assert.equal(dailyResponse.body.script.defaultNarratorStyleId, 'daily-voice')

  const teachingResponse = await request(app)
    .get(`/api/projects/${project.slug}/effective-format`)
    .query({ episode_id: teaching.episode_code })
  assert.equal(teachingResponse.status, 200)
  assert.equal(teachingResponse.body.script.defaultLengthMinutes, 40)
  assert.equal(teachingResponse.body.script.defaultWordsPerMinute, 145)
  assert.deepEqual(teachingResponse.body.script.durationPresets, [35, 40, 50])
  assert.equal(teachingResponse.body.script.defaultNarratorStyleId, 'teaching-voice')

  const otherProject = await pm.createProject({
    name: 'Other profile route', niche_id: PROFILE_FORMULA.id, episode_prefix: 'OTHER',
  })
  const [otherSeeded] = await ideas.addIdeas(otherProject.slug, [{
    title: 'Other episode', logline: 'Other.', themes: [], suggested_chapters: 6,
    suggested_length: '25 min', mood: 'warm', idea_dimensions: { 'episode-profile': 'daily reflection' },
  }], 'test-model')
  const otherEpisode = await ideas.acceptIdea(otherProject.slug, otherSeeded!.id)
  const crossProjectResponse = await request(app)
    .get(`/api/projects/${project.slug}/effective-format`)
    .query({ episode_id: otherEpisode.episode_code })
  assert.equal(crossProjectResponse.status, 404)
  assert.match(crossProjectResponse.body.detail, /accepted episode/i)
})
