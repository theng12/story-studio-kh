import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Niche } from '../models/types.js'
import {
  applyFormulaEpisodeProfileTitle,
  resolveFormulaEpisodeProfile,
} from '../services/formula-production-kit.js'

const formula = {
  id: 'test-formula',
  name: 'Test Formula',
  description: 'test',
  builtin: true,
  schemaVersion: 1,
  exampleTopics: [],
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
