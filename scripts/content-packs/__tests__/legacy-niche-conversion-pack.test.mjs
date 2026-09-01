import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { register } from 'tsx/esm/api'

const ROOT = new URL('../../../', import.meta.url)
const FORMULA_ROOT = new URL('../../../content-packs/legacy-niche-conversion/formula/', import.meta.url)

const FORMULAS = [
  {
    slug: 'counted-explainer',
    legacy: ['listicle-explainer'],
    packId: 'com.storystudio.pack.formula.counted-explainer',
    itemId: 'com.storystudio.formula.counted-explainer',
    compatibleTopics: [
      'com.storystudio.topic.economics-businesses',
      'com.storystudio.topic.natural-world-animals',
      'com.storystudio.topic.natural-world-fungi',
      'com.storystudio.topic.natural-world-insects',
      'com.storystudio.topic.natural-world-plants',
    ],
  },
  {
    slug: 'build-under-constraints',
    legacy: ['pov-hustle'],
    packId: 'com.storystudio.pack.formula.build-under-constraints',
    itemId: 'com.storystudio.formula.build-under-constraints',
    compatibleTopics: ['com.storystudio.topic.economics-businesses'],
  },
  {
    slug: 'philosophy-real-problem',
    legacy: ['philosophy'],
    packId: 'com.storystudio.pack.formula.philosophy-real-problem',
    itemId: 'com.storystudio.formula.philosophy-real-problem',
    compatibleTopics: ['com.storystudio.topic.human-behavior-social-dynamics'],
  },
  {
    slug: 'pastoral-scripture',
    legacy: ['devotional', 'preaching'],
    packId: 'com.storystudio.pack.formula.pastoral-scripture',
    itemId: 'com.storystudio.formula.pastoral-scripture',
    compatibleTopics: [
      'com.storystudio.topic.pastoral-daily-reflection',
      'com.storystudio.topic.pastoral-expository-teaching',
    ],
  },
  {
    slug: 'prayer',
    legacy: ['prayer'],
    packId: 'com.storystudio.pack.formula.prayer',
    itemId: 'com.storystudio.formula.prayer',
    compatibleTopics: [],
  },
]

async function json(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

async function source(spec) {
  const root = new URL(`${spec.slug}/`, FORMULA_ROOT)
  const [manifest, document] = await Promise.all([
    json(new URL('pack.json', root)),
    json(new URL('content/series-formula.json', root)),
  ])
  return { manifest, document }
}

function assertContainsEvery(actual, expected, label) {
  for (const value of expected ?? []) assert.ok(actual.includes(value), `${label} must retain ${JSON.stringify(value)}`)
}

function safePastoralRule(rule) {
  return rule.replaceAll('e.g.', 'for example,').replaceAll('{Book Chapter:Verse}', '{Book, chapter and verse}')
}

test('legacy Formula sources are strict standalone leaves with exact reserved identities', async () => {
  const unregister = register()
  const { parseContentPackDocument, parseContentPackManifest } = await import(new URL('../../../electron/server/content-packs/schemas.ts', import.meta.url))
  unregister()

  for (const spec of FORMULAS) {
    const { manifest, document } = await source(spec)
    assert.doesNotThrow(() => parseContentPackDocument('series-formula', document), spec.slug)
    assert.doesNotThrow(() => parseContentPackManifest({
      ...manifest,
      key_id: 'com.storystudio.key.test',
      min_app_version: '1.4.93',
      items: [{ id: spec.itemId, kind: 'series-formula', schema_version: 1, path: 'content/series-formula.json' }],
      files: [{ path: 'content/series-formula.json', sha256: '0'.repeat(64), bytes: 1, mime: 'application/json' }],
    }), spec.slug)
    assert.equal(manifest.pack_id, spec.packId)
    assert.equal(document.id, spec.itemId)
    assert.equal(manifest.version, '1.0.0')
    assert.equal(manifest.publisher_id, 'com.storystudio')
    assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
    assert.deepEqual(manifest.dependencies, [])
    assert.equal('bundles' in manifest, false)
    assert.equal('bundle_id' in manifest, false)
    assert.equal('items' in manifest, false)
    assert.equal('files' in manifest, false)
    assert.equal('bundle_id' in document, false)
    assert.deepEqual(document.compatible_topic_pack_ids, spec.compatibleTopics)
    assert.ok(document.channel_promise)
    assert.ok(document.audience)
    assert.ok(document.perspective_policy)
    assert.ok(document.narrative_quality_contract)
    assert.ok(document.narrative_quality_contract.opening_policy)
    assert.ok(document.narrative_quality_contract.forbidden_patterns.length)
    assert.ok(document.narrative_quality_contract.required_habits.length)
    assert.ok(document.narrative_rules.length)
    assert.ok(document.title_rules.length)
    assert.ok(document.idea_axes.length)
    assert.ok(document.evidence_expectations.length)
    assert.ok(document.metadata_title_style_hint)
  }
})

test('legacy Formula documents explicitly translate the camel-case prompt contract', async () => {
  for (const spec of FORMULAS.filter(row => row.legacy.length === 1)) {
    const [{ document }, legacy] = await Promise.all([
      source(spec),
      json(new URL(`../../../electron/server/niches/${spec.legacy[0]}.json`, import.meta.url)),
    ])
    assert.equal(document.description, legacy.description)
    assert.equal(document.tagline, legacy.tagline)
    assert.deepEqual(document.example_topics, legacy.exampleTopics)
    assert.deepEqual(document.vocabulary, legacy.vocabulary)
    assert.deepEqual(document.youtube_tags_hint, legacy.youtubeTagsHint)
    assert.equal(document.audience_hint, legacy.audienceHint)
    assert.equal(document.idea_system_prompt_role, legacy.ideaSystemPromptRole)
    if (legacy.ideaGuidanceText) assert.equal(document.idea_guidance_text, legacy.ideaGuidanceText)
    assert.equal(document.script_context, legacy.scriptContext)
    assert.equal(document.script_system_prompt_role, legacy.scriptSystemPromptRole)
    assert.equal(document.script_closing_hint, legacy.scriptClosingHint)
    assert.deepEqual(document.title_shape_rules, legacy.titleShapeRules)
    assert.deepEqual(document.title_length_range, legacy.titleLengthRange)
    assert.equal(document.script_structure.default_chapter_count, legacy.scriptStructure.defaultChapterCount)
    assert.deepEqual(document.script_structure.chapter_count_range, legacy.scriptStructure.chapterCountRange)
    assert.equal(document.script_structure.default_length_minutes, legacy.scriptStructure.defaultLengthMinutes)
    assert.deepEqual(document.script_structure.length_minutes_range, legacy.scriptStructure.lengthMinutesRange)
    assert.deepEqual(document.script_structure.duration_presets, legacy.scriptStructure.durationPresets)
    assert.equal(document.script_structure.default_words_per_minute, legacy.scriptStructure.defaultWordsPerMinute)
    assert.equal(document.script_structure.chapters_independent, legacy.scriptStructure.chaptersIndependent ?? false)
    if (legacy.scriptStructure.pacingArc) assert.deepEqual(document.script_structure.pacing_arc, legacy.scriptStructure.pacingArc)
    else assert.ok(document.script_structure.pacing_arc.length)
    if (legacy.scriptStructure.additionalRules) assert.deepEqual(document.script_structure.additional_rules, legacy.scriptStructure.additionalRules)
    else assert.ok(document.script_structure.additional_rules.length)
    if (legacy.loglineShapeRules) assert.deepEqual(document.logline_shape_rules, legacy.loglineShapeRules)
    if (legacy.loglineSentenceRange) assert.deepEqual(document.logline_sentence_range, legacy.loglineSentenceRange)
    if (legacy.themeShapeRules) assert.deepEqual(document.theme_shape_rules, legacy.themeShapeRules)
    if (legacy.themeCountRange) assert.deepEqual(document.theme_count_range, legacy.themeCountRange)
    if (legacy.structuralVariety) assert.equal(document.structural_variety, legacy.structuralVariety)
    if (legacy.metadataTitleHookRules) assert.deepEqual(document.metadata_title_hook_rules, legacy.metadataTitleHookRules)
    if (legacy.metadataTagsHookRules) assert.deepEqual(document.metadata_tags_hook_rules, legacy.metadataTagsHookRules)
  }
})

test('legacy Formula Pastoral Scripture preserves devotional and preaching as distinct modes', async () => {
  const [{ document }, devotional, preaching] = await Promise.all([
    source(FORMULAS[3]),
    json(new URL('../../../electron/server/niches/devotional.json', import.meta.url)),
    json(new URL('../../../electron/server/niches/preaching.json', import.meta.url)),
  ])
  const mode = document.idea_axes.find(axis => axis.id === 'pastoral-mode')
  assert.deepEqual(mode?.values, ['daily reflection', 'expository teaching'])
  assertContainsEvery(document.example_topics, devotional.exampleTopics, 'Pastoral Scripture devotional examples')
  assertContainsEvery(document.example_topics, preaching.exampleTopics, 'Pastoral Scripture preaching examples')
  assertContainsEvery(document.title_shape_rules, devotional.titleShapeRules.map(safePastoralRule), 'Pastoral Scripture devotional titles')
  assertContainsEvery(document.title_shape_rules, preaching.titleShapeRules.map(safePastoralRule), 'Pastoral Scripture preaching titles')
  assert.match(document.script_context, new RegExp(devotional.scriptContext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(document.script_context, new RegExp(preaching.scriptContext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(new Set(document.narrator_styles.map(style => style.id)).size, devotional.narratorStyles.length + preaching.narratorStyles.length)
  assert.deepEqual(document.default_topic_pack_ids, ['com.storystudio.topic.pastoral-daily-reflection'])
})

test('legacy Formula conversion excludes retired products and Channel Kit metadata', async () => {
  const names = await Promise.all(FORMULAS.map(async spec => (await source(spec)).document.name))
  assert.equal(FORMULAS.some(spec => spec.slug === 'dark-psychology' || spec.slug === 'music-mix'), false)
  assert.equal(names.some(name => /dark psychology|music mix/i.test(name)), false)
  const registry = await json(new URL('../../../content-packs/authoring-registry.json', import.meta.url))
  const receiptRecords = registry.records.filter(record => record.receipt_ref === 'authoring:a5a6e0d46ed35304d42f57e4fbb621f4854c82ec1d0a87606d942929c2c212f2')
  assert.equal(receiptRecords.length, 17)
  assert.equal(receiptRecords.some(record => record.kind === 'channel-kit' || 'bundle_id' in record), false)
})
