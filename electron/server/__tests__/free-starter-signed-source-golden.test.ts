import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { contentPackDocumentToNiche, contentPackDocumentToThumbnailTemplate, contentPackDocumentToTopicPack } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'
import { loadLegacyNiche } from '../services/niche-loader.js'
import { loadTopicPack } from '../services/topic-pack-loader.js'
import { loadTemplate } from '../services/thumbnail-template-loader.js'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const FREE_STARTERS = resolve(ROOT, 'content-packs/free-starters')

type FormulaPair = { source: string; legacy: string; expectedName: string }
const FORMULAS: FormulaPair[] = [
  { source: 'natural-world-explained', legacy: 'animals', expectedName: 'Natural World, Explained' },
  { source: 'ancient-humans', legacy: 'ancient-humans', expectedName: 'How Did Ancient Humans…?' },
  { source: 'deep-time-documentary', legacy: 'deep-time-documentary', expectedName: 'Deep Time Documentary' },
  { source: 'economics-of', legacy: 'business-economics', expectedName: 'The Economics of…' },
  { source: 'human-behavior-explained', legacy: 'psychology', expectedName: 'Human Behavior, Explained' },
  { source: 'history-explained', legacy: 'history-narration', expectedName: 'History, Explained' },
  { source: 'pov-your-life-as', legacy: 'pov-life', expectedName: 'POV: Your Life As…' },
  { source: 'guided-mindfulness', legacy: 'mindfulness', expectedName: 'Guided Mindfulness' },
  { source: 'practical-motivation', legacy: 'motivation', expectedName: 'Practical Motivation' },
  { source: 'sleep-story', legacy: 'sleep', expectedName: 'Sleep Story' },
]

const TOPICS = [
  ['natural-world-animals', 'natural-world-animals'],
  ['ancient-humans-survival', 'ancient-humans-survival'],
  ['deep-time-earth-systems', 'deep-time-earth-systems'],
  ['economics-businesses', 'economics-businesses'],
  ['human-behavior-social-dynamics', 'human-behavior-social-dynamics'],
  ['historical-wars-treaties-world-order', 'historical-wars-treaties-world-order'],
  ['pov-historical-occupations', 'pov-historical-occupations'],
] as const

const RECIPES = [
  'curiosity-question-cartoon', 'documentary-label-tableau', 'annotated-business-board',
  'centered-hero-headline', 'portrait-block-right',
] as const

const ADVERTISED_COVERAGE = [
  ['natural-world-explained', 'natural-world-animals', 10],
  ['ancient-humans', 'ancient-humans-survival', 20],
  ['deep-time-documentary', 'deep-time-earth-systems', 30],
  ['economics-of', 'economics-businesses', 40],
  ['human-behavior-explained', 'human-behavior-social-dynamics', 10],
  ['history-explained', 'historical-wars-treaties-world-order', 25],
  ['pov-your-life-as', 'pov-historical-occupations', 25],
  ['guided-mindfulness', 'everyday-calm', 15],
  ['practical-motivation', 'habits-momentum', 15],
  ['sleep-story', 'night-journeys', 15],
] as const

async function sourceJson(kind: 'formula' | 'topic' | 'style' | 'thumbnail', slug: string) {
  const documentName = { formula: 'series-formula', topic: 'topic-pack', style: 'visual-style', thumbnail: 'thumbnail-recipe' }[kind]
  const raw = JSON.parse(await readFile(resolve(FREE_STARTERS, kind, slug, 'content', `${documentName}.json`), 'utf8'))
  return parseContentPackDocument(raw.kind, raw)
}

function normalizeId(value: string | undefined): string | undefined {
  return value?.replace(/^com\.storystudio\.(formula|topic|thumbnail)\./, '')
}

function normalizeIds(values: string[] | undefined): string[] | undefined {
  return values?.map(normalizeId).filter((value): value is string => value !== undefined)
}

const LEGACY_FORMULA_SUCCESSORS: Record<string, string> = {
  animals: 'natural-world-explained',
  'business-economics': 'economics-of',
  psychology: 'human-behavior-explained',
  'history-narration': 'history-explained',
  'pov-life': 'pov-your-life-as',
}

function successorId(value: string): string {
  return LEGACY_FORMULA_SUCCESSORS[value] || value
}

function assertContainsEvery<T>(actual: T[] | undefined, expected: T[] | undefined, label: string) {
  for (const value of expected || []) assert.ok(actual?.some(candidate => isDeepStrictEqual(candidate, value)), `${label} must retain ${JSON.stringify(value)}`)
}

function recipePromptFacts(recipe: NonNullable<Awaited<ReturnType<typeof loadTemplate>>>['recipe']) {
  return {
    layout: recipe?.layout,
    conceptGuidance: recipe?.conceptGuidance,
    compositionRules: recipe?.compositionRules,
    requiredElements: recipe?.requiredElements,
    avoid: recipe?.avoid,
    titleMode: recipe?.titleMode,
    headlineMode: recipe?.headlineMode,
    headlineGuidance: recipe?.headlineGuidance,
    defaultTextStyle: recipe?.defaultTextStyle,
    defaultFontStyle: recipe?.defaultFontStyle,
    defaultTextPosition: recipe?.defaultTextPosition,
    headlineFormats: recipe?.headlineFormats,
    visualStyleGuidance: recipe?.visualStyleGuidance,
  }
}

function productionKitFacts(value: ReturnType<typeof contentPackDocumentToNiche>['productionKit']) {
  if (!value) return undefined
  return {
    ...value,
    recommendedVisualStyleId: value.recommendedVisualStyleId?.replace(/^(?:com\.storystudio\.style\.|builtin-)/, ''),
    episodeProfiles: value.episodeProfiles?.map(profile => Object.fromEntries(
      Object.entries(profile).filter(([, field]) => field !== undefined),
    )),
  }
}

function definedEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function assertDefinedFields(actual: Record<string, unknown>, expected: Record<string, unknown>, label: string) {
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined) assert.deepEqual(actual[field], value, `${label} must preserve ${field}`)
  }
}

function assertSubset(actual: unknown, expected: unknown, label: string): void {
  if (Array.isArray(expected)) {
    assert.deepEqual(actual, expected, label)
    return
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${label} must be an object`)
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      assertSubset((actual as Record<string, unknown>)[key], value, `${label}.${key}`)
    }
    return
  }
  assert.equal(actual, expected, label)
}

function formulaPromptFacts(value: ReturnType<typeof contentPackDocumentToNiche>) {
  return {
    description: value.description,
    tagline: value.tagline,
    formulaFamily: value.formulaFamily,
    perspectivePolicy: value.perspectivePolicy,
    narrativeQualityContract: value.narrativeQualityContract,
    openingProfile: value.openingProfile,
    metadataProfile: value.metadataProfile,
    productionKit: productionKitFacts(value.productionKit),
    exampleTopics: value.exampleTopics,
    defaultTopicPackIds: normalizeIds(value.defaultTopicPackIds),
    compatibleTopicPackIds: normalizeIds(value.compatibleTopicPackIds),
    ideaAxes: value.ideaAxes,
    vocabulary: value.vocabulary,
    audienceHint: value.audienceHint,
    youtubeTagsHint: value.youtubeTagsHint,
    ideaSystemPromptRole: value.ideaSystemPromptRole,
    ideaGuidanceText: value.ideaGuidanceText,
    scriptContext: value.scriptContext,
    scriptSystemPromptRole: value.scriptSystemPromptRole,
    scriptClosingHint: value.scriptClosingHint,
    narratorStyles: value.narratorStyles?.map(style => ({ ...style, id: style.id.toLowerCase() })),
    defaultNarratorStyleId: value.defaultNarratorStyleId?.toLowerCase(),
    titleShapeRules: value.titleShapeRules,
    titleLengthRange: value.titleLengthRange,
    loglineShapeRules: value.loglineShapeRules,
    loglineSentenceRange: value.loglineSentenceRange,
    themeShapeRules: value.themeShapeRules,
    themeCountRange: value.themeCountRange,
    structuralVariety: value.structuralVariety,
    defaultThumbnailTemplateId: normalizeId(value.defaultThumbnailTemplateId),
    metadataTitleStyleHint: value.metadataTitleStyleHint,
    metadataTitleHookRules: value.metadataTitleHookRules,
    metadataTagsHookRules: value.metadataTagsHookRules,
    scriptStructure: value.scriptStructure,
  }
}

test('signed Formula source documents preserve every legacy prompt field representable by the Content Pack schema', async () => {
  for (const pair of FORMULAS) {
    const source = await sourceJson('formula', pair.source)
    assert.equal(source.kind, 'series-formula')
    const legacy = await loadLegacyNiche(pair.legacy)
    assert.ok(legacy, `missing legacy Formula ${pair.legacy}`)
    const signed = contentPackDocumentToNiche(source)
    assert.equal(signed.name, pair.expectedName)
    const legacyFacts = formulaPromptFacts(legacy.document)
    const signedFacts = formulaPromptFacts(signed)
    if (pair.source === 'economics-of') {
      const rationale = await readFile(resolve(FREE_STARTERS, 'MIGRATION-RATIONALE.md'), 'utf8')
      assert.match(rationale, /economics-of/)
      legacyFacts.description = signedFacts.description
    }
    for (const [field, expected] of Object.entries(legacyFacts)) {
      if (field === 'scriptStructure' && expected !== undefined) assertSubset(signedFacts.scriptStructure, expected, `${pair.source} must preserve ${field}`)
      else if (expected !== undefined) assert.deepEqual(signedFacts[field as keyof typeof signedFacts], expected, `${pair.source} must preserve ${field}`)
    }
  }
})

test('signed Topic sources preserve every legacy prompt field and exact subject corpus', async () => {
  for (const [sourceSlug, legacyId] of TOPICS) {
    const source = await sourceJson('topic', sourceSlug)
    assert.equal(source.kind, 'topic-pack')
    const legacy = await loadTopicPack(legacyId)
    assert.ok(legacy, `missing legacy Topic ${legacyId}`)
    const signed = contentPackDocumentToTopicPack(source)
    assertDefinedFields({
      description: signed.description,
      subjects: signed.subjects,
      exampleTopics: signed.exampleTopics,
      promptContext: signed.promptContext,
      vocabulary: signed.vocabulary,
      youtubeTagsHint: signed.youtubeTagsHint,
      tags: signed.tags,
    }, definedEntries({
      description: legacy.description,
      subjects: legacy.subjects,
      exampleTopics: legacy.exampleTopics,
      promptContext: legacy.promptContext,
      vocabulary: legacy.vocabulary,
      youtubeTagsHint: legacy.youtubeTagsHint,
      tags: legacy.tags,
    }), `${sourceSlug} Topic`)
    assertContainsEvery(signed.ideaAxes, legacy.ideaAxes, `${sourceSlug} idea axes`)
    assertContainsEvery(
      normalizeIds(signed.compatibleFormulaIds),
      (legacy.compatibleFormulaIds || legacy.compatibleNicheIds || []).map(successorId),
      `${sourceSlug} Formula compatibility`,
    )
  }
})

test('signed Recipe sources preserve representable legacy rendering guidance', async () => {
  for (const slug of RECIPES) {
    const source = await sourceJson('thumbnail', slug)
    assert.equal(source.kind, 'thumbnail-recipe')
    const legacy = await loadTemplate(slug)
    assert.ok(legacy, `missing legacy Recipe ${slug}`)
    const signed = contentPackDocumentToThumbnailTemplate(source, [])
    assertDefinedFields({
      description: signed.description,
      category: signed.category,
      tags: signed.tags,
      aspectRatio: signed.aspectRatio,
    }, definedEntries({
      description: legacy.description,
      category: legacy.category,
      tags: legacy.tags,
      aspectRatio: legacy.aspectRatio,
    }), `${slug} Recipe`)
    if (legacy.recipe) {
      assertDefinedFields(recipePromptFacts(signed.recipe), recipePromptFacts(legacy.recipe), `${slug} recipe`)
    } else {
      const rationale = await readFile(resolve(FREE_STARTERS, 'MIGRATION-RATIONALE.md'), 'utf8')
      assert.match(rationale, new RegExp(`\\b${slug}\\b`), `${slug} requires an explicit static-template migration rationale`)
    }
    assertContainsEvery(
      normalizeIds(signed.recommendedNicheIds),
      (legacy.recommendedNicheIds || []).map(successorId),
      `${slug} Formula compatibility`,
    )
  }
})

test('every advertised Starter count covers every declared Topic axis within its sibling ceiling', async () => {
  for (const [formulaSlug, topicSlug, advertisedCount] of ADVERTISED_COVERAGE) {
    const formula = await sourceJson('formula', formulaSlug)
    const topic = await sourceJson('topic', topicSlug)
    assert.equal(formula.kind, 'series-formula')
    assert.equal(topic.kind, 'topic-pack')
    const niche = contentPackDocumentToNiche(formula)
    niche.activeTopicPacks = [contentPackDocumentToTopicPack(topic)]
    const assignments = planIdeaAssignments({ niche, count: advertisedCount, seed: `free-starter-coverage-${topicSlug}` }).slice(0, advertisedCount)
    assert.equal(assignments.length, advertisedCount, `${topicSlug} must fill its advertised coverage`)
    for (const axisId of ['subject', 'episode-object', 'time-place-scope', 'mechanism', 'evidence-lens']) {
      const declared: string[] | undefined = axisId === 'subject'
        ? topic.subjects
        : topic.idea_axes?.find((axis: { id: string }) => axis.id === axisId)?.values
      assert.ok(declared?.length, `${topicSlug} must declare ${axisId}`)
      assert.deepEqual(
        new Set(assignments.map(assignment => assignment.dimensions[axisId])),
        new Set(declared),
        `${topicSlug} must rotate every declared ${axisId} instead of hiding coverage behind subject concatenation`,
      )
    }
    const siblings = new Map<string, number>()
    for (const assignment of assignments) {
      const subject = assignment.dimensions.subject
      siblings.set(subject, (siblings.get(subject) || 0) + 1)
    }
    assert.ok([...siblings.values()].every(count => count <= topic.max_siblings_per_subject), `${topicSlug} must respect max_siblings_per_subject`)
  }
})

test('Starter coverage groups keep each campaign tuple semantic and every reserved sibling structurally new', async () => {
  const samples = new Map<string, Record<string, Record<string, string>>>()
  for (const [formulaSlug, topicSlug, advertisedCount] of ADVERTISED_COVERAGE) {
    const formula = await sourceJson('formula', formulaSlug)
    const topic = await sourceJson('topic', topicSlug)
    assert.equal(formula.kind, 'series-formula')
    assert.equal(topic.kind, 'topic-pack')
    assert.ok(topic.coverage_groups?.length, `${topicSlug} requires authored coverage groups`)
    const groupsBySubject = new Map<string, NonNullable<typeof topic.coverage_groups>[number]>()
    for (const group of topic.coverage_groups) {
      for (const subject of group.subjects) {
        assert.equal(groupsBySubject.has(subject), false, `${topicSlug} must not assign ${subject} to two groups`)
        groupsBySubject.set(subject, group)
      }
    }
    assert.deepEqual(new Set(groupsBySubject.keys()), new Set(topic.subjects), `${topicSlug} must group every subject once`)
    const niche = contentPackDocumentToNiche(formula)
    niche.activeTopicPacks = [contentPackDocumentToTopicPack(topic)]
    const first = planIdeaAssignments({ niche, count: advertisedCount, seed: `starter-groups-${topicSlug}` }).slice(0, advertisedCount)
    const checkpoint = planIdeaAssignments({ niche, count: advertisedCount, seed: `starter-groups-${topicSlug}` }).slice(0, advertisedCount)
    assert.deepEqual(checkpoint, first, `${topicSlug} coverage must be checkpoint deterministic`)
    const firstBySubject = new Map(first.map(assignment => [assignment.dimensions.subject, assignment.dimensions]))
    for (const assignment of first) {
      const group = groupsBySubject.get(assignment.dimensions.subject)
      assert.ok(group, `${topicSlug} assignment subject must have a group`)
      assert.ok(group.episode_objects.includes(assignment.dimensions['episode-object']))
      assert.ok(group.time_place_scopes.includes(assignment.dimensions['time-place-scope']))
      assert.ok(group.mechanisms.includes(assignment.dimensions.mechanism))
      assert.ok(group.evidence_lenses.includes(assignment.dimensions['evidence-lens']))
    }
    const second = planIdeaAssignments({
      niche, count: advertisedCount, seed: `starter-groups-${topicSlug}-next`, usedFingerprints: first.map(assignment => assignment.fingerprint),
    }).slice(0, advertisedCount)
    assert.equal(second.length, advertisedCount, `${topicSlug} must fail closed rather than repeat a structural sibling`)
    for (const assignment of second) {
      const prior = firstBySubject.get(assignment.dimensions.subject)
      assert.ok(prior, `${topicSlug} second campaign must preserve subject coverage`)
      assert.notEqual(assignment.dimensions['episode-object'], prior['episode-object'], `${topicSlug} sibling must change episode object`)
      assert.notEqual(assignment.dimensions.mechanism, prior.mechanism, `${topicSlug} sibling must change mechanism`)
    }
    samples.set(topicSlug, Object.fromEntries(first.map(assignment => [assignment.dimensions.subject, assignment.dimensions])))
  }
  assert.deepEqual(Object.fromEntries(['subject', 'episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'].map(key => [
    key, samples.get('natural-world-animals')?.amphibians?.[key],
  ])), {
    subject: 'amphibians', 'episode-object': 'a predator defense', 'time-place-scope': 'a forest canopy', mechanism: 'sensory adaptation', 'evidence-lens': 'ecological survey',
  })
  assert.equal(samples.get('deep-time-earth-systems')?.['the opening of the Atlantic']?.['time-place-scope'], 'a rifting seaway')
  assert.equal(samples.get('deep-time-earth-systems')?.['the opening of the Atlantic']?.mechanism, 'rift spreading')
  assert.equal(samples.get('historical-wars-treaties-world-order')?.['the Yalta Conference']?.['time-place-scope'], 'a postwar settlement')
  assert.equal(samples.get('everyday-calm')?.['bedtime lamp ritual']?.['episode-object'], 'a desk lamp')
  assert.equal(samples.get('habits-momentum')?.["prepare tomorrow's shoes"]?.['episode-object'], 'a pair of shoes')
})

test('tool-generated preview assets have honest reproducible publisher provenance', async () => {
  const markdown = await readFile(resolve(FREE_STARTERS, 'ASSET-PROVENANCE.md'), 'utf8')
  const match = markdown.match(/<!-- free-starter-preview-provenance\n([\s\S]*?)\n-->/)
  assert.ok(match)
  const records = JSON.parse(match[1]) as Array<Record<string, unknown>>
  for (const id of ['prehistoric-discovery', 'centered-hero-headline', 'portrait-block-right', 'dreamscape-story-window']) {
    const record = records.find(candidate => candidate.id === id)
    assert.deepEqual(record?.provenance, 'publisher-created-tool-generated-original')
    assert.equal(record?.status, 'approved')
    assert.equal(record?.generation_tool, 'codex-built-in-imagegen')
    assert.equal(record?.generation_authority, 'owner-authorized-2026-08-15-content-store-launch')
    assert.match(String(record?.source_prompt), /Original 16:9/)
    assert.match(String(record?.source_path), /^\/Users\/thengmacmini\/\.codex\/generated_images\//)
    assert.match(String(record?.sha256), /^[a-f0-9]{64}$/)
  }
})

test('approved Starter shelf names and promise counts remain exact', async () => {
  const expected = [
    ['economics-of', 'The Economics of…'],
    ['history-explained', 'History, Explained'],
  ]
  for (const [slug, name] of expected) {
    const formula = await sourceJson('formula', slug)
    assert.equal(formula.kind, 'series-formula')
    assert.equal(formula.name, name)
  }
  for (const [slug, name, promise] of [
    ['a-life-as', 'A Life As…', '25 historical occupations / Role → Reality'],
    ['history-explained', 'History Explained', '25 conflicts and settlements / Event → Consequence'],
    ['calm-mind', 'Calm Mind', '15 everyday practices / Pause → Presence'],
    ['build-momentum', 'Build Momentum', '15 habit challenges / Friction → Action'],
    ['sleep-journeys', 'Sleep Journeys', '15 night journeys / Setting → Rest'],
  ]) {
    const manifest = JSON.parse(await readFile(resolve(FREE_STARTERS, 'kit', slug, 'pack.json'), 'utf8'))
    assert.equal(manifest.bundles[0]?.name, name)
    assert.equal(manifest.changelog, promise)
  }
})

test('Documentary Label Tableau declares reciprocal History Explained compatibility', async () => {
  const recipe = await sourceJson('thumbnail', 'documentary-label-tableau')
  assert.equal(recipe.kind, 'thumbnail-recipe')
  assert.ok(recipe.compatible_formula_ids.includes('com.storystudio.formula.history-explained'))
})
