import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  contentPackDocumentToNiche,
  contentPackDocumentToTopicPack,
  contentPackDocumentToThumbnailTemplate,
  contentPackDocumentToVisualStyle,
} from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import type { ContentPackDocument } from '../content-packs/types.js'

const FORMULA_ID = 'com.storystudio.test.formula'
const TOPIC_ID = 'com.storystudio.test.topic'
const STYLE_ID = 'com.storystudio.test.style'
const RECIPE_ID = 'com.storystudio.test.recipe'

function formulaDocument(): Extract<ContentPackDocument, { kind: 'series-formula' }> {
  const document = parseContentPackDocument('series-formula', {
    kind: 'series-formula', schema_version: 1, id: FORMULA_ID, name: 'Test Formula',
    description: 'A strict signed Formula.', channel_promise: 'Explain hidden systems.', audience: 'Curious adults.',
    formula_family: 'Evidence', tagline: 'Follow the mechanism.', perspective_policy: 'Use restrained third person.',
    narrative_quality_contract: {
      opening_policy: 'Begin with the consequence.', forbidden_patterns: ['No fake quotation.'],
      required_habits: ['Name the institution.'], closing_policy: 'Return to the evidence.',
    },
    opening_profile: { id: 'consequence-first', label: 'Consequence first', description: 'Start with the result.' },
    metadata_profile: {
      id: 'evidence-youtube', label: 'Evidence package', description: 'A factual summary.',
      description_section_ids: ['hook', 'hashtags'], title_mode: 'use_idea_title',
      description_max_chars: 3000, title_max_length: 100, tag_count: 15,
    },
    production_kit: {
      id: 'archive-kit', label: 'Archive kit', description: 'A restrained documentary system.',
      recommended_visual_style_id: STYLE_ID,
      episode_profiles: [{
        id: 'institution', label: 'Institution', description: 'A bounded institution.', idea_axis_value: 'Institution',
        title_suffix: 'Explained', forbidden_title_suffixes: ['Revealed'], narrator_style_id: 'archivist',
        title_policy: 'Name the object.', thumbnail_policy: 'Show the evidence.', metadata_policy: 'Avoid hype.',
      }],
    },
    narrative_rules: ['Stay causal.'], title_rules: ['Name the object.'],
    script_structure: {
      default_chapter_count: 4, chapter_count_range: [3, 6], default_length_minutes: 20,
      length_minutes_range: [10, 30], duration_presets: [10, 20, 30], default_words_per_minute: 125,
      chapters_independent: true, visual_pacing_profile: {
        opening_duration_sec: 120, opening: { min_sec: 4, max_sec: 8 }, settled: { min_sec: 7, max_sec: 12 },
      }, motion_profile_id: 'ambient-documentary', pacing_arc: ['Consequence', 'Mechanism'], additional_rules: ['State uncertainty.'],
    },
    compatible_topic_pack_ids: [TOPIC_ID], default_topic_pack_ids: [TOPIC_ID], example_topics: ['A tax ledger'],
    recommended_visual_style_ids: [STYLE_ID], recommended_thumbnail_recipe_ids: [RECIPE_ID],
    idea_axes: [{ id: 'episode-profile', label: 'Episode profile', values: ['Institution'] }],
    vocabulary: { mood: ['restrained'], theme: ['power'], genre: ['documentary'], keyword: ['archive'] },
    audience_hint: 'Viewers who value documented causality.', evidence_expectations: ['Name primary evidence.'],
    idea_system_prompt_role: 'Develop documentary premises.', idea_guidance_text: 'Prefer bounded systems.',
    script_context: 'Trace the mechanism.', script_system_prompt_role: 'Write a restrained documentary.',
    script_closing_hint: 'End on the evidence.', narrator_styles: [{ id: 'archivist', label: 'Archivist', description: 'Measured and exact.' }],
    default_narrator_style_id: 'archivist', title_shape_rules: ['Use a concrete noun.'], title_length_range: [20, 80],
    logline_shape_rules: ['State cause and effect.'], logline_sentence_range: [1, 2],
    theme_shape_rules: ['Use a noun phrase.'], theme_count_range: [1, 3], structural_variety: 'vary-all',
    default_thumbnail_recipe_id: RECIPE_ID, metadata_title_style_hint: 'Concrete and restrained.',
    metadata_title_hook_rules: ['Name the tension.'], metadata_tags_hook_rules: ['Prefer specific institutions.'],
    metadata_description: {
      voice_guidance: 'Write plainly.', description_shape_rules: ['Lead with evidence.'],
      closing_benediction: 'The record remains.', cta_shape: 'Invite careful discussion.',
    },
    recency_avoidance: { strategy_id: 'scripture-references', label: 'references', default_lookback: 20, scopes: ['script'] },
    creative_profiles: ['editorial'],
  })
  assert.equal(document.kind, 'series-formula')
  return document
}

function topicDocument(): Extract<ContentPackDocument, { kind: 'topic-pack' }> {
  const document = parseContentPackDocument('topic-pack', {
    kind: 'topic-pack', schema_version: 1, id: TOPIC_ID, name: 'Institutions', description: 'Bounded institutional subjects.',
    compatible_formula_ids: [FORMULA_ID], subjects: ['Tax office'], episode_objects: ['Ledger'],
    time_place_scopes: ['Europe, 1800s'], mechanisms: ['Extraction'], evidence_lenses: ['Account books'],
    exclusions: ['Unbounded biography'], max_siblings_per_subject: 4, prompt_context: 'Treat the institution as the episode object.',
    idea_axes: [{ id: 'mechanism', label: 'Mechanism', values: ['Extraction'] }], example_topics: ['The ledger that governed a province'],
    vocabulary: { keyword: ['ledger'] }, youtube_tags_hint: ['history'], tags: ['institutions'],
    evidence_expectations: ['Use a bounded source.'], compatibility_rules: ['Pair only with causal Formulas.'],
  })
  assert.equal(document.kind, 'topic-pack')
  return document
}

function recipeDocument(): Extract<ContentPackDocument, { kind: 'thumbnail-recipe' }> {
  const document = parseContentPackDocument('thumbnail-recipe', {
    kind: 'thumbnail-recipe', schema_version: 1, id: RECIPE_ID, name: 'Evidence Desk', description: 'A restrained evidence composition.',
    layout: 'hero', category: 'Documentary', tags: ['archive', 'evidence'], aspect_ratio: '16:9', title_mode: 'ai',
    composition_guidance: 'Place one primary document centrally.', required_elements: ['One document'], avoid_elements: ['Collage clutter'],
    headline_mode: 'curiosity-hook', headline_guidance: 'Use three concrete words.', default_text_style: 'Warm ivory.',
    default_font_style: 'Condensed serif.', default_text_position: 'top', headline_formats: ['THE HIDDEN LEDGER'],
    visual_style_guidance: 'Restrained archival realism.', preview_assets: ['assets/recipe.png'], compatible_formula_ids: [FORMULA_ID],
  })
  assert.equal(document.kind, 'thumbnail-recipe')
  return document
}

function styleDocument(): Extract<ContentPackDocument, { kind: 'visual-style' }> {
  const document = parseContentPackDocument('visual-style', {
    kind: 'visual-style', schema_version: 1, id: STYLE_ID, name: 'Archive Desk', description: 'Muted documentary evidence.',
    category: 'Realistic', tags: ['archive', 'documentary'], style_bible: 'Muted archival documentary reconstruction.',
    negative_prompt: 'No modern objects.', preview_assets: ['assets/style.png'], compatible_formula_ids: [FORMULA_ID],
  })
  assert.equal(document.kind, 'visual-style')
  return document
}

describe('Content Pack legacy adapters', () => {
  test('maps every supported Formula field explicitly into the current Niche shape', () => {
    const niche = contentPackDocumentToNiche(formulaDocument())
    assert.equal(niche.id, FORMULA_ID)
    assert.equal(niche.builtin, true)
    assert.equal(niche.schemaVersion, 1)
    assert.deepEqual(niche.compatibleTopicPackIds, [TOPIC_ID])
    assert.equal(niche.scriptStructure?.defaultChapterCount, 4)
    assert.equal(niche.scriptStructure?.motionProfileId, 'ambient-documentary')
    assert.equal(niche.scriptStructure?.motionProfile?.id, 'ambient-documentary')
    assert.equal(niche.recencyAvoidance?.strategyId, 'scripture-references')
    assert.ok(niche.recencyAvoidance?.extractPatterns.length)
    assert.deepEqual(niche.productionKit?.episodeProfiles?.[0], {
      id: 'institution', label: 'Institution', description: 'A bounded institution.', ideaAxisValue: 'Institution',
      titleSuffix: 'Explained', forbiddenTitleSuffixes: ['Revealed'], narratorStyleId: 'archivist',
      titlePolicy: 'Name the object.', thumbnailPolicy: 'Show the evidence.', metadataPolicy: 'Avoid hype.',
    })
    assert.equal('provider' in niche, false)
    assert.equal('model' in niche, false)
  })

  test('maps Topic Pack planning fields without pretending unsupported fields are current behavior', () => {
    const topic = contentPackDocumentToTopicPack(topicDocument())
    assert.deepEqual(topic.compatibleFormulaIds, [FORMULA_ID])
    assert.deepEqual(topic.compatibleNicheIds, [FORMULA_ID])
    assert.deepEqual(topic.subjects, ['Tax office'])
    assert.equal(topic.promptContext, 'Treat the institution as the episode object.')
    assert.equal('episodeObjects' in topic, false)
    assert.equal('provider' in topic, false)
  })

  test('maps a signed recipe into the existing AI thumbnail-template contract', () => {
    const recipe = contentPackDocumentToThumbnailTemplate(recipeDocument(), ['/api/content-packs/com.storystudio.test.pack/1.0.0/assets/abc'])
    assert.equal(recipe.builtin, true)
    assert.equal(recipe.aspectRatio, '16:9')
    assert.deepEqual(recipe.previewImages, ['/api/content-packs/com.storystudio.test.pack/1.0.0/assets/abc'])
    assert.deepEqual(recipe.recipe, {
      layout: 'hero', conceptGuidance: 'Place one primary document centrally.', compositionRules: undefined,
      requiredElements: ['One document'], avoid: ['Collage clutter'], titleMode: 'ai', headlineMode: 'curiosity-hook',
      headlineGuidance: 'Use three concrete words.', defaultTextStyle: 'Warm ivory.', defaultFontStyle: 'Condensed serif.',
      defaultTextPosition: 'top', headlineFormats: ['THE HIDDEN LEDGER'], visualStyleGuidance: 'Restrained archival realism.',
    })
    assert.equal('provider' in recipe, false)
  })

  test('maps a visual style to the renderer-safe frontend shape only', () => {
    const style = contentPackDocumentToVisualStyle(styleDocument(), '/api/content-packs/com.storystudio.test.pack/1.0.0/assets/abc')
    assert.deepEqual(style, {
      id: STYLE_ID, name: 'Archive Desk', builtin: true, blurb: 'Muted documentary evidence.', category: 'Realistic',
      tags: ['archive', 'documentary'], data: { style_bible: 'Muted archival documentary reconstruction.', negative_prompt: 'No modern objects.' },
      preview_image: '/api/content-packs/com.storystudio.test.pack/1.0.0/assets/abc',
    })
    assert.doesNotMatch(JSON.stringify(style), /(?:\/Users\/|file:|provider|model)/i)
  })
})
