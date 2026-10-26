/**
 * A Series Formula may state the frame it makes (owner, 2026-10-27).
 *
 * A vertical Quote Shorts channel needs 9:16 end to end: scene images, the
 * Video Assembly canvas and the Pipeline's Scene Review step. Before this, only
 * a built-in `Format` carried `imagePrompts.recommendedAspect`, so a Formula —
 * which is how a channel type actually ships — could not ask for portrait at
 * all. Every surface stayed on its own 16:9 default, which is the "a limit that
 * is enforced must also be shown" shape from AGENTS §1 in reverse: the shape
 * was silently landscape and nothing said so.
 *
 * The tests pin three things:
 *   1. the Formula document carries the field and the adapter passes it on,
 *   2. the loader folds it into the ONE field the pages already read, and
 *   3. the Pipeline's Scene Review step inherits it while a preset still wins.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import { applyNicheToFormat } from '../services/format-loader.js'
import { resolveStepParams } from '../routes/pipeline.js'
import type { Format, Niche } from '../models/types.js'

const baseFormat: Format = {
  id: 'continuity-chain',
  name: 'Continuity Engine',
  description: '',
  builtin: true,
  schemaVersion: 1,
  visualSource: 'continuity-chain',
  sceneAlignment: 'sentence',
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
    defaultChapterCount: 1,
    chapterCountRange: [1, 1],
    defaultLengthMinutes: 1,
    lengthMinutesRange: [1, 1],
    narratorStyles: [],
    defaultNarratorStyleId: '',
  },
  imagePrompts: {
    purposeNote: 'p',
    visualStyleHint: 'v',
    defaultScenesTotalRange: [1, 10],
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
  },
}

/** The smallest series-formula document that survives the adapter. */
function formulaDocument(aspect?: '16:9' | '9:16' | '1:1') {
  return {
    kind: 'series-formula' as const,
    schema_version: 1 as const,
    id: 'com.storystudio.formula.quote-shorts',
    name: 'Quote Shorts',
    description: 'Vertical readings.',
    channel_promise: 'One reading, one breath.',
    audience: 'People scrolling for a moment of quiet.',
    narrative_rules: ['One idea per Short.'],
    title_rules: ['Short, plain, no hype.'],
    script_structure: {
      default_chapter_count: 1,
      chapter_count_range: [1, 1] as [number, number],
      default_length_minutes: 1,
      length_minutes_range: [1, 1] as [number, number],
      duration_presets: [1],
      default_words_per_minute: 120,
      chapters_independent: true,
      pacing_arc: [],
      additional_rules: [],
    },
    compatible_topic_pack_ids: [],
    recommended_visual_style_ids: [],
    recommended_thumbnail_recipe_ids: [],
    ...(aspect ? { aspect_ratio: aspect } : {}),
  }
}

describe('a Formula declares the frame it makes', () => {
  test('the adapter carries aspect_ratio onto the Niche', () => {
    const niche = contentPackDocumentToNiche(formulaDocument('9:16') as any)
    assert.equal(niche.aspectRatio, '9:16')
  })

  test('a Formula that states no frame leaves the format’s own shape alone', () => {
    const niche = contentPackDocumentToNiche(formulaDocument() as any)
    assert.equal(niche.aspectRatio, undefined)
    const format = applyNicheToFormat(baseFormat, niche)
    assert.equal(format.imagePrompts.recommendedAspect, '16:9', 'the built-in default stands')
  })

  test('the loader folds it into the one field every page already reads', () => {
    const niche = contentPackDocumentToNiche(formulaDocument('9:16') as any)
    const format = applyNicheToFormat(baseFormat, niche)
    // Scene Review, the Image Pool and Video Assembly all read THIS field; a
    // second aspect control would be the thing that drifts.
    assert.equal(format.imagePrompts.recommendedAspect, '9:16')
  })

  test('a square Formula reaches the same field', () => {
    const niche = contentPackDocumentToNiche(formulaDocument('1:1') as any)
    assert.equal(applyNicheToFormat(baseFormat, niche).imagePrompts.recommendedAspect, '1:1')
  })
})

describe('the Pipeline’s Scene Review step inherits the channel’s shape', () => {
  const vertical: Format = {
    ...baseFormat,
    imagePrompts: { ...baseFormat.imagePrompts, recommendedAspect: '9:16' },
  }
  const preset = (data: Record<string, unknown>) => ({ id: 'sr', name: 'Scene Review', data })

  test('a preset with no ratio inherits the Formula’s 9:16', () => {
    const params = resolveStepParams('scene_review', 'EP0001', 'T', preset({ model: 'm' }), vertical)
    assert.equal(params.aspect_ratio, '9:16')
  })

  test('a preset that names a ratio still wins', () => {
    const params = resolveStepParams(
      'scene_review', 'EP0001', 'T', preset({ model: 'm', aspect_ratio: '16:9' }), vertical,
    )
    assert.equal(params.aspect_ratio, '16:9')
  })

  test('neither a preset ratio nor a Formula shape sends no ratio at all', () => {
    // Missing is MISSING, not 16:9: the image resolver applies the shared Story
    // default against the live catalogue, exactly as it did before this change.
    const params = resolveStepParams('scene_review', 'EP0001', 'T', preset({ model: 'm' }), null)
    assert.equal('aspect_ratio' in params, false)
  })

  test('the format’s own 16:9 is still passed through, so nothing changes for it', () => {
    const params = resolveStepParams('scene_review', 'EP0001', 'T', preset({ model: 'm' }), baseFormat)
    assert.equal(params.aspect_ratio, '16:9')
  })
})
