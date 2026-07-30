/**
 * Pipeline batch — format-aware metadata defaults.
 *
 * v1.0.69 made the batch metadata step pull description size, title
 * count, title length, and tag count from the project's effective
 * Format. Sleep-story projects keep the historical 5000 / 5 / 100 /
 * 15 numbers; listicle / educational / kids-fairytale tighten them
 * for shorter content.
 *
 * Without this, batch runs for any non-sleep-story channel would
 * silently produce sleep-story-sized metadata (5000-char descriptions,
 * 100-char title caps) regardless of the channel format.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveStepParams } from '../routes/pipeline.js'
import type { Format } from '../models/types.js'

function makeFormat(metadataDefaults: Partial<Format['metadata']>): Format {
  return {
    id: 'test-format',
    name: 'Test',
    description: '',
    builtin: false,
    schemaVersion: 1,
    idea: {
      systemPromptRole: 'r',
      audienceDefault: 'a',
      moodVocabulary: [],
      themeVocabulary: [],
      guidanceText: 'g',
    },
    script: {
      systemPromptRole: 'r',
      additionalRules: [],
      pacingArc: [],
      closingHint: '',
      defaultChapterCount: 10,
      chapterCountRange: [3, 20],
      defaultLengthMinutes: 30,
      lengthMinutesRange: [10, 90],
      narratorStyles: [],
      defaultNarratorStyleId: '',
    },
    imagePrompts: {
      purposeNote: 'p',
      visualStyleHint: 'v',
      defaultScenesTotalRange: [10, 10],
      defaultThumbnails: 3,
      defaultStyleTag: '',
      characterReferenceMode: 'inline',
      recommendedAspect: '16:9',
    },
    metadata: {
      purposeNote: 'p',
      titleStyleHint: 't',
      titleHookRules: [],
      tagsContext: 't',
      tagsHookRules: [],
      broadKeywords: [],
      youtubeDescriptionStructure: {
        musicLabel: 'MUSIC',
        booksSectionLabel: '',
        supportSection: '',
        aiDisclosure: '',
        defaultHashtags: [],
        totalHashtagCount: 12,
      },
      ...metadataDefaults,
    },
  }
}

const fakePreset = { id: 'p1', name: 'Test preset', data: { sections: [] } }

describe('resolveStepParams — metadata batch defaults', () => {
  test('uses the AI model saved in the metadata preset', () => {
    const preset = {
      id: 'p-local',
      name: 'Local metadata',
      data: { sections: [], model: 'gemma-4-e2b-it-mlx' },
    }
    const params = resolveStepParams('metadata', 'EP0001', 'My Episode', preset, null)
    assert.equal(params.model, 'gemma-4-e2b-it-mlx')
  })

  test('legacy presets without a model inject no hardcoded product id', () => {
    // resolveStepParams is sync and has no catalogue access, so it must not invent a
    // product id. The live default is resolved once per batch by the run-batch handler.
    const params = resolveStepParams('metadata', 'EP0001', 'My Episode', fakePreset, null)
    assert.equal(params.model, '')
  })

  test('listicle defaults (3500 / 5 / 70 / 12) win over hardcoded sleep-story numbers', () => {
    const listicle = makeFormat({
      defaultMaxChars: 3500,
      defaultTitleCount: 5,
      defaultTitleMaxLength: 70,
      defaultTagCount: 12,
    })
    const params = resolveStepParams('metadata', 'EP0001', 'My Episode', fakePreset, listicle)
    assert.equal(params.max_chars, 3500)
    assert.equal(params.title_count, 5)
    assert.equal(params.title_max_length, 70)
    assert.equal(params.tag_count, 12)
    assert.equal(params.title_platform_preset, 'Universal')
  })

  test('educational defaults (4500 / 5 / 80 / 15) flow through', () => {
    const educational = makeFormat({
      defaultMaxChars: 4500,
      defaultTitleCount: 5,
      defaultTitleMaxLength: 80,
      defaultTagCount: 15,
    })
    const params = resolveStepParams('metadata', 'EP0001', '', fakePreset, educational)
    assert.equal(params.max_chars, 4500)
    assert.equal(params.title_max_length, 80)
  })

  test('format without metadata defaults falls back to legacy sleep-story numbers', () => {
    // A format JSON shipped before the defaults block was added —
    // pipeline must keep working with the legacy hardcoded numbers
    // so sleep-story / older custom formats still produce correct
    // batch metadata.
    const noDefaults = makeFormat({}) // metadata defaults left undefined
    const params = resolveStepParams('metadata', 'EP0001', '', fakePreset, noDefaults)
    assert.equal(params.max_chars, 5000)
    assert.equal(params.title_count, 5)
    assert.equal(params.title_max_length, 100)
    assert.equal(params.tag_count, 15)
  })

  test('null format (e.g. project with no format_id and no built-in) falls back to legacy numbers', () => {
    const params = resolveStepParams('metadata', 'EP0001', '', fakePreset, null)
    assert.equal(params.max_chars, 5000)
    assert.equal(params.title_count, 5)
    assert.equal(params.title_max_length, 100)
    assert.equal(params.tag_count, 15)
  })

  test('preset-supplied sections still flow through alongside format defaults', () => {
    // The preset provides the description sections (hashtags, hook, …);
    // the format provides the size knobs. Both must end up on params.
    const presetWithSections = {
      id: 'p1',
      name: 'Test',
      data: {
        sections: [
          { id: 'hook', label: 'Hook', enabled: true, config: { characters: 200 } },
          { id: 'hashtags', label: 'Hashtags', enabled: true, config: {} },
        ],
      },
    }
    const fmt = makeFormat({ defaultMaxChars: 3500 })
    const params = resolveStepParams('metadata', 'EP0001', '', presetWithSections, fmt)
    assert.equal(params.max_chars, 3500)
    assert.equal(Array.isArray(params.sections), true)
    assert.equal(params.sections.length, 2)
    assert.equal(params.sections[0].id, 'hook')
  })
})
