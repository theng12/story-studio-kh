import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { Niche } from '../models/types.js'
import {
  applyFormulaEpisodeProfile,
  applyFormulaEpisodeProfileTitle,
  resolveFormulaEpisodeDimensions,
  resolveFormulaEpisodeProfile,
} from '../services/formula-production-kit.js'
import * as ideas from '../services/idea-manager.js'
import * as projects from '../services/project-manager.js'
import { selectAutomaticNarratorStyle } from '../generators/episode.js'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
after(async () => temp.cleanup())

const formula = {
  id: 'test-formula',
  name: 'Test Formula',
  description: 'test',
  builtin: true,
  schemaVersion: 1,
  exampleTopics: [],
  introDefaults: {
    wordTarget: 160,
    beats: ['parent-hook', { id: 'parent-context', custom_text: 'Keep the parent wording.' }],
    exampleText: 'Parent opening example.',
  },
  scriptStructure: {
    defaultChapterCount: 8,
    chapterCountRange: [6, 10],
    defaultLengthMinutes: 30,
    lengthMinutesRange: [20, 40],
    durationPresets: [20, 30, 40],
    defaultWordsPerMinute: 140,
    chaptersIndependent: false,
    visualPacingProfile: {
      opening_duration_sec: 30,
      opening: { min_sec: 3, max_sec: 5 },
      settled: { min_sec: 8, max_sec: 12 },
    },
    motionProfile: {
      id: 'parent-motion', label: 'Parent motion', description: 'Parent motion mix.',
      opening_duration_sec: 30,
      opening: { still: 0.2, gentle: 0.7, limited: 0.1 },
      settled: { still: 0.7, gentle: 0.3, limited: 0 },
    },
    motionProfileId: 'parent-motion',
    pacingArc: ['Parent opening', 'Parent close'],
    additionalRules: ['Preserve the parent rule.'],
  },
  recencyAvoidance: {
    strategyId: 'scripture-references', label: 'Parent references', extractPatterns: ['Parent \\d+'],
    instructionTemplate: 'Parent avoids {items}.', defaultLookback: 12, scopes: ['script'],
  },
  productionKit: {
    id: 'test-kit',
    label: 'Test kit',
    description: 'test',
    episodeProfiles: [
      {
        id: 'rest',
        label: 'Rest',
        description: 'rest',
        ideaAxisValue: 'rest',
        titleSuffix: ' | Documentary for Sleep',
        narratorStyleId: 'rest-narrator',
        introDefaults: { wordTarget: 80 },
        scriptStructure: { defaultLengthMinutes: 45, defaultWordsPerMinute: 115 },
        recencyAvoidance: {
          strategyId: 'scripture-references', label: 'references', extractPatterns: ['Psalm \\d+'],
          instructionTemplate: 'Avoid {items}.', defaultLookback: 20, scopes: ['script'],
        },
        ideaSystemPromptRole: 'Rest ideas.',
        scriptSystemPromptRole: 'Rest scripts.',
      },
      {
        id: 'immersive',
        label: 'Immersive',
        description: 'immersive',
        ideaAxisValue: 'immersive',
        forbiddenTitleSuffixes: [' | Documentary for Sleep', 'Documentary for Sleep'],
      },
    ],
  },
} satisfies Niche

test('Formula production kit resolves a durable Idea Campaign profile', () => {
  assert.equal(
    resolveFormulaEpisodeProfile(formula, { 'episode-profile': 'rest' })?.id,
    'rest',
  )
  assert.equal(resolveFormulaEpisodeProfile(formula, {})?.id, undefined)
})

test('Formula production kit applies only the selected profile runtime fields', () => {
  const profiled = applyFormulaEpisodeProfile(formula, { 'episode-profile': 'rest' })
  assert.deepEqual(profiled.introDefaults, {
    wordTarget: 80,
    beats: ['parent-hook', { id: 'parent-context', custom_text: 'Keep the parent wording.' }],
    exampleText: 'Parent opening example.',
  })
  assert.equal(profiled.scriptStructure?.defaultChapterCount, 8)
  assert.deepEqual(profiled.scriptStructure?.chapterCountRange, [6, 10])
  assert.equal(profiled.scriptStructure?.defaultLengthMinutes, 45)
  assert.equal(profiled.scriptStructure?.defaultWordsPerMinute, 115)
  assert.deepEqual(profiled.scriptStructure?.lengthMinutesRange, [20, 40])
  assert.deepEqual(profiled.scriptStructure?.durationPresets, [20, 30, 40])
  assert.deepEqual(profiled.scriptStructure?.pacingArc, ['Parent opening', 'Parent close'])
  assert.deepEqual(profiled.scriptStructure?.additionalRules, ['Preserve the parent rule.'])
  assert.equal(profiled.defaultNarratorStyleId, 'rest-narrator')
  assert.equal(profiled.recencyAvoidance?.defaultLookback, 20)
  assert.equal(profiled.ideaSystemPromptRole, 'Rest ideas.')
  assert.equal(profiled.scriptSystemPromptRole, 'Rest scripts.')
  assert.equal(applyFormulaEpisodeProfile(formula, {}), formula)
})

test('a profile that omits runtime blocks receives isolated clones of every retained parent block', () => {
  const profiled = applyFormulaEpisodeProfile(formula, { 'episode-profile': 'immersive' })
  assert.notEqual(profiled.introDefaults, formula.introDefaults)
  assert.notEqual(profiled.introDefaults?.beats, formula.introDefaults.beats)
  assert.notEqual(profiled.scriptStructure, formula.scriptStructure)
  assert.notEqual(profiled.scriptStructure?.pacingArc, formula.scriptStructure.pacingArc)
  assert.notEqual(profiled.scriptStructure?.additionalRules, formula.scriptStructure.additionalRules)
  assert.notEqual(profiled.scriptStructure?.visualPacingProfile, formula.scriptStructure.visualPacingProfile)
  assert.notEqual(profiled.scriptStructure?.visualPacingProfile?.opening, formula.scriptStructure.visualPacingProfile.opening)
  assert.notEqual(profiled.scriptStructure?.motionProfile, formula.scriptStructure.motionProfile)
  assert.notEqual(profiled.scriptStructure?.motionProfile?.settled, formula.scriptStructure.motionProfile.settled)
  assert.notEqual(profiled.recencyAvoidance, formula.recencyAvoidance)
  assert.notEqual(profiled.recencyAvoidance?.extractPatterns, formula.recencyAvoidance.extractPatterns)
  assert.notEqual(profiled.recencyAvoidance?.scopes, formula.recencyAvoidance.scopes)

  ;(profiled.introDefaults!.beats![1] as { custom_text?: string }).custom_text = 'Changed.'
  profiled.scriptStructure!.pacingArc!.push('Changed pace.')
  profiled.scriptStructure!.additionalRules!.push('Changed rule.')
  profiled.scriptStructure!.visualPacingProfile!.opening.min_sec = 99
  profiled.scriptStructure!.motionProfile!.settled.still = 0
  profiled.recencyAvoidance!.extractPatterns.push('Changed')
  profiled.recencyAvoidance!.scopes!.push('metadata')

  assert.equal((formula.introDefaults.beats![1] as { custom_text?: string }).custom_text, 'Keep the parent wording.')
  assert.deepEqual(formula.scriptStructure.pacingArc, ['Parent opening', 'Parent close'])
  assert.deepEqual(formula.scriptStructure.additionalRules, ['Preserve the parent rule.'])
  assert.equal(formula.scriptStructure.visualPacingProfile.opening.min_sec, 3)
  assert.equal(formula.scriptStructure.motionProfile.settled.still, 0.7)
  assert.deepEqual(formula.recencyAvoidance.extractPatterns, ['Parent \\d+'])
  assert.deepEqual(formula.recencyAvoidance.scopes, ['script'])
})

test('accepted episode code resolves its durable profile dimensions from ideas.json', async () => {
  const project = await projects.createProject({ name: `Formula profile ${Date.now()}`, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Profiled episode', logline: 'A durable profile.', themes: [], suggested_chapters: 4,
    suggested_length: '20 min', mood: 'calm', idea_dimensions: { 'episode-profile': 'rest' },
  }], 'test-model')
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  assert.deepEqual(
    await resolveFormulaEpisodeDimensions(project.slug, accepted.idea.episode_code || undefined),
    { 'episode-profile': 'rest' },
  )
})

test('Formula production kit enforces profile title boundaries idempotently', () => {
  assert.equal(
    applyFormulaEpisodeProfileTitle('When Oceans Froze', formula, { 'episode-profile': 'rest' }),
    'When Oceans Froze | Documentary for Sleep',
  )
  assert.equal(
    applyFormulaEpisodeProfileTitle(
      'When Oceans Froze | Documentary for Sleep',
      formula,
      { 'episode-profile': 'rest' },
    ),
    'When Oceans Froze | Documentary for Sleep',
  )
  assert.equal(
    applyFormulaEpisodeProfileTitle(
      'When Oceans Froze | Documentary for Sleep',
      formula,
      { 'episode-profile': 'immersive' },
    ),
    'When Oceans Froze',
  )
})

test('direct Auto narration honors the profiled Formula default before rotation', () => {
  const format = {
    script: {
      defaultNarratorStyleId: 'preaching-a',
      narratorStyles: [
        { id: 'devotional-a', label: 'Devotional', description: 'Warm reflection.' },
        { id: 'preaching-a', label: 'Preaching', description: 'Expository teaching.' },
      ],
    },
  } as any
  assert.equal(selectAutomaticNarratorStyle(format, 'EP0042', 'preaching-a'), 'preaching-a')
  assert.equal(selectAutomaticNarratorStyle(format, 'EP0042'), 'devotional-a')
})
