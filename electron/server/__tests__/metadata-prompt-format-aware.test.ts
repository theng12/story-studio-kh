/**
 * buildDescriptionPrompt — format-aware hashtag fallback.
 *
 * v1.0.69 made the hashtags section in the YouTube description prompt
 * pull `defaultHashtags` and `totalHashtagCount` from the project's
 * effective Format when the user-configured section config doesn't
 * pin its own values. Without this, every batch description for a
 * listicle / true-crime / educational channel was suggesting
 * "#SleepStory #BedtimeStory" as the "common ones to include".
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import type { Format } from '../models/types.js'

function makeFormat(hashtags: string[], total: number): Format {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    builtin: false,
    schemaVersion: 1,
    idea: { systemPromptRole: '', audienceDefault: '', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
    script: {
      systemPromptRole: '', additionalRules: [], pacingArc: [], closingHint: '',
      defaultChapterCount: 10, chapterCountRange: [3, 20],
      defaultLengthMinutes: 30, lengthMinutesRange: [10, 90],
      narratorStyles: [], defaultNarratorStyleId: '',
    },
    imagePrompts: {
      purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [10, 10],
      defaultThumbnails: 3, defaultStyleTag: '',
      characterReferenceMode: 'inline', recommendedAspect: '16:9',
    },
    metadata: {
      purposeNote: '', titleStyleHint: '', titleHookRules: [],
      tagsContext: '', tagsHookRules: [], broadKeywords: [],
      youtubeDescriptionStructure: {
        musicLabel: 'MUSIC',
        booksSectionLabel: '',
        supportSection: '',
        aiDisclosure: '',
        defaultHashtags: hashtags,
        totalHashtagCount: total,
      },
    },
  }
}

const sectionsWithHashtags = [
  { id: 'hashtags', label: 'Hashtags', enabled: true, config: {} },
]

describe('buildDescriptionPrompt — hashtags section', () => {
  test('listicle format injects #explained / #facts as the example hashtags', () => {
    const fmt = makeFormat(['#explained', '#facts'], 12)
    const prompt = buildDescriptionPrompt('EP0001', 'Episode title', 'context', sectionsWithHashtags, 5000, fmt)
    assert.match(prompt, /Include 12 relevant hashtags/)
    assert.match(prompt, /#explained #facts/)
    assert.doesNotMatch(prompt, /#SleepStory/, 'must not leak sleep-story hashtag into a listicle prompt')
  })

  test('true-crime format injects #TrueCrime / #ColdCase as the example hashtags', () => {
    const fmt = makeFormat(['#TrueCrime', '#ColdCase', '#TrueCrimeStory'], 15)
    const prompt = buildDescriptionPrompt('EP0001', '', 'context', sectionsWithHashtags, 5000, fmt)
    assert.match(prompt, /Include 15 relevant hashtags/)
    assert.match(prompt, /#TrueCrime #ColdCase #TrueCrimeStory/)
    assert.doesNotMatch(prompt, /#SleepStory/, 'must not leak sleep-story hashtag into a true-crime prompt')
  })

  test('omitted format (legacy callers) falls back to #SleepStory examples', () => {
    // Pre-v1.0.69 callers don't pass the format. Behaviour must stay
    // identical so existing tests / interactive flows don't change.
    const prompt = buildDescriptionPrompt('EP0001', '', 'context', sectionsWithHashtags, 5000)
    assert.match(prompt, /Include 15 relevant hashtags/)
    assert.match(prompt, /#SleepStory #BedtimeStory/)
  })

  test('user-configured cfg.defaultHashtags overrides format-supplied ones', () => {
    // If the metadata page lets the user pin their own example hashtags,
    // those take precedence — format defaults are only the fallback.
    const fmt = makeFormat(['#explained'], 12)
    const customSections = [
      {
        id: 'hashtags', label: 'Hashtags', enabled: true,
        config: { count: 8, defaultHashtags: ['#MyOwn', '#Brand'] },
      },
    ]
    const prompt = buildDescriptionPrompt('EP0001', '', 'context', customSections, 5000, fmt)
    assert.match(prompt, /Include 8 relevant hashtags/)
    assert.match(prompt, /#MyOwn #Brand/)
    assert.doesNotMatch(prompt, /#explained/)
  })

  test('format with empty hashtags array still falls back to legacy default', () => {
    // A custom format that didn't bother to fill youtubeDescriptionStructure
    // shouldn't break — we degrade to the legacy sleep-story example.
    const fmt = makeFormat([], 15)
    const prompt = buildDescriptionPrompt('EP0001', '', 'context', sectionsWithHashtags, 5000, fmt)
    assert.match(prompt, /#SleepStory #BedtimeStory/)
  })
})
