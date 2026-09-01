import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import { applyFormulaEpisodeProfile } from '../services/formula-production-kit.js'
import { applyNicheToFormat, loadFormat } from '../services/format-loader.js'
import { isCompatible } from '../services/topic-pack-loader.js'
import { contentPackDocumentToTopicPack } from '../content-packs/legacy-adapters.js'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const FORMULA_ROOT = resolve(ROOT, 'content-packs/legacy-niche-conversion/formula')

const FORMULAS = [
  ['counted-explainer', 'com.storystudio.formula.counted-explainer'],
  ['build-under-constraints', 'com.storystudio.formula.build-under-constraints'],
  ['philosophy-real-problem', 'com.storystudio.formula.philosophy-real-problem'],
  ['pastoral-scripture', 'com.storystudio.formula.pastoral-scripture'],
  ['prayer', 'com.storystudio.formula.prayer'],
] as const

async function formula(slug: string) {
  const raw = JSON.parse(await readFile(resolve(FORMULA_ROOT, slug, 'content/series-formula.json'), 'utf8'))
  const document = parseContentPackDocument('series-formula', raw)
  if (document.kind !== 'series-formula') throw new Error(`${slug} is not a Formula`)
  return document
}

async function legacy(slug: string) {
  return JSON.parse(await readFile(resolve(ROOT, 'electron/server/niches', `${slug}.json`), 'utf8'))
}

async function topic(path: string) {
  const raw = JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
  const document = parseContentPackDocument('topic-pack', raw)
  if (document.kind !== 'topic-pack') throw new Error(`${path} is not a Topic Pack`)
  return contentPackDocumentToTopicPack(document)
}

test('legacy Formula adapters project every strict source into the current Niche contract', async () => {
  for (const [slug, id] of FORMULAS) {
    const document = await formula(slug)
    if (document.kind !== 'series-formula') throw new Error(`${slug} is not a Formula`)
    const niche = contentPackDocumentToNiche(document)
    assert.equal(niche.id, id)
    assert.equal(niche.kind, 'series-formula')
    assert.equal(niche.builtin, true)
    assert.equal(niche.description, document.description)
    assert.equal(niche.tagline, document.tagline)
    assert.equal(niche.audienceHint, document.audience_hint ?? document.audience)
    assert.deepEqual(niche.compatibleTopicPackIds, document.compatible_topic_pack_ids)
    assert.deepEqual(niche.defaultTopicPackIds, document.default_topic_pack_ids)
    assert.deepEqual(niche.ideaAxes, document.idea_axes)
    assert.deepEqual(niche.vocabulary, document.vocabulary)
    assert.equal(niche.scriptContext, document.script_context)
    assert.equal(niche.scriptSystemPromptRole, document.script_system_prompt_role)
    assert.deepEqual(niche.titleShapeRules, document.title_shape_rules)
    assert.deepEqual(niche.titleLengthRange, document.title_length_range)
    assert.deepEqual(niche.narrativeQualityContract, {
      openingPolicy: document.narrative_quality_contract?.opening_policy,
      forbiddenPatterns: document.narrative_quality_contract?.forbidden_patterns,
      requiredHabits: document.narrative_quality_contract?.required_habits,
      closingPolicy: document.narrative_quality_contract?.closing_policy,
    })
    assert.deepEqual(niche.scriptStructure?.chapterCountRange, document.script_structure.chapter_count_range)
    assert.deepEqual(niche.scriptStructure?.lengthMinutesRange, document.script_structure.length_minutes_range)
    assert.equal(niche.scriptStructure?.chaptersIndependent, document.script_structure.chapters_independent)
  }
})

test('legacy Formula compatibility uses qualified authored or atomically reserved Topic identities', async () => {
  const registry = JSON.parse(await readFile(resolve(ROOT, 'content-packs/authoring-registry.json'), 'utf8'))
  const usableTopics = new Set(registry.records
    .filter((record: { kind: string; status: string }) => record.kind === 'topic-pack' && ['authored', 'reserved'].includes(record.status))
    .map((record: { item_id: string }) => record.item_id))
  for (const [slug] of FORMULAS) {
    const document = await formula(slug)
    if (document.kind !== 'series-formula') throw new Error(`${slug} is not a Formula`)
    for (const topicId of document.compatible_topic_pack_ids) {
      assert.match(topicId, /^com\.storystudio\.topic\./)
      assert.ok(usableTopics.has(topicId), `${slug} must not invent Topic identity ${topicId}`)
    }
  }
  assert.deepEqual((await formula('counted-explainer')).compatible_topic_pack_ids.slice(-3), [
    'com.storystudio.topic.natural-world-fungi',
    'com.storystudio.topic.natural-world-insects',
    'com.storystudio.topic.natural-world-plants',
  ])
  assert.deepEqual((await formula('pastoral-scripture')).compatible_topic_pack_ids, [
    'com.storystudio.topic.pastoral-daily-reflection',
    'com.storystudio.topic.pastoral-expository-teaching',
  ])
})

test('Formula compatibility never claims a non-reciprocal existing Topic through the real runtime check', async () => {
  const [counted, build, philosophy, economics, animals, socialDynamics] = await Promise.all([
    formula('counted-explainer'),
    formula('build-under-constraints'),
    formula('philosophy-real-problem'),
    topic('content-packs/free-starters/topic/economics-businesses/content/topic-pack.json'),
    topic('content-packs/free-starters/topic/natural-world-animals/content/topic-pack.json'),
    topic('content-packs/free-starters/topic/human-behavior-social-dynamics/content/topic-pack.json'),
  ])
  assert.equal(isCompatible(economics, counted.id), false)
  assert.equal(isCompatible(animals, counted.id), false)
  assert.equal(isCompatible(economics, build.id), false)
  assert.equal(isCompatible(socialDynamics, philosophy.id), false)
  assert.deepEqual(counted.compatible_topic_pack_ids, [
    'com.storystudio.topic.natural-world-fungi',
    'com.storystudio.topic.natural-world-insects',
    'com.storystudio.topic.natural-world-plants',
  ])
  assert.deepEqual(build.compatible_topic_pack_ids, [])
  assert.equal(build.default_topic_pack_ids, undefined)
  assert.deepEqual(philosophy.compatible_topic_pack_ids, [])
  assert.equal(philosophy.default_topic_pack_ids, undefined)
})

test('strict Formula adapters preserve legacy opening, visual, thumbnail, recency, and prompt behavior', async () => {
  const base = await loadFormat('continuity-chain')
  assert.ok(base)
  for (const [formulaSlug, legacySlug] of [
    ['counted-explainer', 'listicle-explainer'],
    ['build-under-constraints', 'pov-hustle'],
    ['philosophy-real-problem', 'philosophy'],
    ['prayer', 'prayer'],
  ] as const) {
    const [document, legacyNiche] = await Promise.all([formula(formulaSlug), legacy(legacySlug)])
    if (document.kind !== 'series-formula') throw new Error(`${formulaSlug} is not a Formula`)
    const niche = contentPackDocumentToNiche(document)
    const effective = applyNicheToFormat(base, niche)
    assert.deepEqual(niche.introDefaults, legacyNiche.introDefaults, `${formulaSlug} opening recipe`)
    assert.equal(niche.visualStyleHint, legacyNiche.visualStyleHint, `${formulaSlug} visual hint`)
    assert.equal(niche.defaultThumbnailTemplateId, legacyNiche.defaultThumbnailTemplateId, `${formulaSlug} thumbnail default`)
    assert.equal(niche.recencyAvoidance?.label, legacyNiche.recencyAvoidance?.label, `${formulaSlug} recency label`)
    assert.deepEqual(niche.recencyAvoidance?.extractPatterns, legacyNiche.recencyAvoidance?.extractPatterns, `${formulaSlug} recency extraction`)
    assert.equal(niche.recencyAvoidance?.defaultLookback, legacyNiche.recencyAvoidance?.defaultLookback, `${formulaSlug} recency lookback`)
    assert.equal(niche.recencyAvoidance?.instructionTemplate, legacyNiche.recencyAvoidance?.instructionTemplate, `${formulaSlug} recency prompt`)
    assert.deepEqual(niche.recencyAvoidance?.scopes, legacyNiche.recencyAvoidance?.scopes, `${formulaSlug} recency scopes`)
    assert.equal(effective.idea.systemPromptRole, legacyNiche.ideaSystemPromptRole, `${formulaSlug} idea role`)
    assert.equal(effective.script.systemPromptRole, legacyNiche.scriptSystemPromptRole, `${formulaSlug} script role`)
    assert.equal(effective.script.closingHint, legacyNiche.scriptClosingHint, `${formulaSlug} closing prompt`)
    assert.deepEqual(effective.script.introDefaults, legacyNiche.introDefaults, `${formulaSlug} effective opening`)
    assert.equal(effective.imagePrompts.visualStyleHint, legacyNiche.visualStyleHint || base.imagePrompts.visualStyleHint)
    assert.equal(effective.script.defaultWordsPerMinute, legacyNiche.scriptStructure.defaultWordsPerMinute)
    assert.equal(effective.script.defaultNarratorStyleId, legacyNiche.defaultNarratorStyleId.toLowerCase())
    assert.equal(
      effective.script.narratorStyles.find(style => style.id === effective.script.defaultNarratorStyleId)?.description,
      legacyNiche.narratorStyles.find((style: { id: string }) => style.id === legacyNiche.defaultNarratorStyleId)?.description,
      `${formulaSlug} default narrator behavior`,
    )
    assert.deepEqual(niche.recommendedVisualStyleIds, document.recommended_visual_style_ids.length
      ? document.recommended_visual_style_ids
      : undefined)
    assert.equal((niche as any).activeStylePresetId, undefined)
  }
})

test('Pastoral Scripture profiles reproduce both legacy modes through strict document, adapter, resolution, and format runtime', async () => {
  const [document, devotional, preaching, base] = await Promise.all([
    formula('pastoral-scripture'),
    legacy('devotional'),
    legacy('preaching'),
    loadFormat('continuity-chain'),
  ])
  assert.ok(base)
  if (document.kind !== 'series-formula') throw new Error('Pastoral Scripture is not a Formula')
  const niche = contentPackDocumentToNiche(document)
  for (const [axisValue, expected, narratorId] of [
    ['daily reflection', devotional, 'devotional-a'],
    ['expository teaching', preaching, 'preaching-a'],
  ] as const) {
    const profiled = applyFormulaEpisodeProfile(niche, { 'episode-profile': axisValue })
    const effective = applyNicheToFormat(base, niche, { 'episode-profile': axisValue })
    assert.deepEqual(profiled.introDefaults, expected.introDefaults, `${axisValue} opening`)
    assert.equal(profiled.scriptStructure?.defaultChapterCount, expected.scriptStructure.defaultChapterCount, `${axisValue} chapter default`)
    assert.deepEqual(profiled.scriptStructure?.chapterCountRange, expected.scriptStructure.chapterCountRange, `${axisValue} chapter range`)
    assert.equal(profiled.scriptStructure?.defaultLengthMinutes, expected.scriptStructure.defaultLengthMinutes, `${axisValue} length default`)
    assert.deepEqual(profiled.scriptStructure?.lengthMinutesRange, expected.scriptStructure.lengthMinutesRange, `${axisValue} length range`)
    assert.deepEqual(profiled.scriptStructure?.durationPresets, expected.scriptStructure.durationPresets, `${axisValue} length presets`)
    assert.equal(profiled.scriptStructure?.defaultWordsPerMinute, expected.scriptStructure.defaultWordsPerMinute, `${axisValue} WPM`)
    assert.equal(profiled.scriptStructure?.chaptersIndependent, expected.scriptStructure.chaptersIndependent ?? false, `${axisValue} chapter independence`)
    assert.equal(profiled.defaultNarratorStyleId, narratorId, `${axisValue} narrator default`)
    assert.equal(profiled.recencyAvoidance?.label, expected.recencyAvoidance.label, `${axisValue} recency label`)
    assert.deepEqual(profiled.recencyAvoidance?.extractPatterns, expected.recencyAvoidance.extractPatterns, `${axisValue} recency extraction`)
    assert.equal(profiled.recencyAvoidance?.defaultLookback, expected.recencyAvoidance.defaultLookback, `${axisValue} recency lookback`)
    assert.equal(profiled.recencyAvoidance?.instructionTemplate, expected.recencyAvoidance.instructionTemplate, `${axisValue} recency prompt`)
    assert.deepEqual(profiled.recencyAvoidance?.scopes, expected.recencyAvoidance.scopes, `${axisValue} recency scopes`)
    assert.equal(profiled.ideaSystemPromptRole, expected.ideaSystemPromptRole, `${axisValue} idea prompt`)
    assert.equal(profiled.scriptSystemPromptRole, expected.scriptSystemPromptRole, `${axisValue} script prompt`)
    assert.equal(profiled.scriptContext, expected.scriptContext, `${axisValue} context`)
    assert.equal(profiled.scriptClosingHint, expected.scriptClosingHint, `${axisValue} closing`)
    assert.equal(effective.script.defaultWordsPerMinute, expected.scriptStructure.defaultWordsPerMinute)
    assert.equal(effective.script.defaultLengthMinutes, expected.scriptStructure.defaultLengthMinutes)
    assert.deepEqual(effective.script.lengthMinutesRange, expected.scriptStructure.lengthMinutesRange)
    assert.deepEqual(effective.script.pacingArc, expected.scriptStructure.pacingArc ?? base.script.pacingArc)
    assert.deepEqual(effective.script.introDefaults, expected.introDefaults)
    assert.equal(effective.script.defaultNarratorStyleId, narratorId)
    assert.equal(effective.idea.systemPromptRole, expected.ideaSystemPromptRole)
    assert.equal(effective.script.systemPromptRole, expected.scriptSystemPromptRole)
  }
})

test('episode-profile identity is forwarded by every script and recency prompt consumer', async () => {
  const [episode, metadata, imagePrompts, scriptRoutes] = await Promise.all([
    readFile(resolve(ROOT, 'electron/server/generators/episode.ts'), 'utf8'),
    readFile(resolve(ROOT, 'electron/server/generators/metadata.ts'), 'utf8'),
    readFile(resolve(ROOT, 'electron/server/generators/image-prompts.ts'), 'utf8'),
    readFile(resolve(ROOT, 'electron/server/routes/scripts.ts'), 'utf8'),
  ])
  assert.equal((episode.match(/getEffectiveFormat\(project_slug, \{ episodeId: episode_id \}\)/g) || []).length, 4,
    'script, chapter, introduction, and chunked expansion must resolve the accepted episode profile')
  assert.equal((episode.match(/applyRecencyToFormat\(format, project_slug, episode_id\)/g) || []).length, 4,
    'all four script paths must use the same episode-scoped recency profile')
  assert.match(metadata, /prependAvoidanceToPrompt\([\s\S]*?project_slug,[\s\S]*?'metadata',[\s\S]*?episode_id,[\s\S]*?\)/)
  assert.match(metadata, /prependAvoidanceToPrompt\(project_slug, 'titles', titlePrompt, episode_id\)/)
  assert.match(imagePrompts, /prependAvoidanceToPrompt\(projectSlug, 'image_prompts', prompt, episodeId\)/)
  assert.equal((scriptRoutes.match(/buildDescriptionPrompt\(episode_id[\s\S]*?episode_id,\n\s*\)/g) || []).length >= 2, true,
    'both direct metadata routes must pass episode identity to recency resolution')
  assert.match(scriptRoutes, /prependAvoidanceToPrompt\(slug, 'titles', titlePrompt, episode_id\)/)
})
