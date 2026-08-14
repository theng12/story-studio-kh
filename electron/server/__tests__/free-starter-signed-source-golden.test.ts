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

test('every advertised Starter profile makes its complete axis vocabulary reachable within its sibling ceiling', async () => {
  for (const [formulaSlug, topicSlug, advertisedCount] of ADVERTISED_COVERAGE) {
    const formula = await sourceJson('formula', formulaSlug)
    const topic = await sourceJson('topic', topicSlug)
    assert.equal(formula.kind, 'series-formula')
    assert.equal(topic.kind, 'topic-pack')
    const niche = contentPackDocumentToNiche(formula)
    niche.activeTopicPacks = [contentPackDocumentToTopicPack(topic)]
    const profiles = topic.coverage_profiles
    assert.equal(profiles?.length, topic.subjects.length, `${topicSlug} requires one profile per subject`)
    const first = planIdeaAssignments({ niche, count: advertisedCount, seed: `free-starter-coverage-${topicSlug}` }).slice(0, advertisedCount)
    const second = planIdeaAssignments({
      niche, count: advertisedCount, seed: `free-starter-coverage-${topicSlug}-next`, usedFingerprints: first.map(assignment => assignment.fingerprint),
    }).slice(0, advertisedCount)
    assert.equal(first.length, advertisedCount, `${topicSlug} must fill its advertised coverage`)
    assert.equal(second.length, advertisedCount, `${topicSlug} must fill its second profile coverage`)
    for (const [axisId, profileKey] of [
      ['subject', 'subject'], ['episode-object', 'episode_object'], ['time-place-scope', 'time_place_scope'], ['mechanism', 'mechanism'], ['evidence-lens', 'evidence_lens'],
    ] as const) {
      const declared: string[] = axisId === 'subject'
        ? [...topic.subjects]
        : [...(topic.idea_axes?.find((axis: { id: string }) => axis.id === axisId)?.values || [])]
      const authored: string[] = axisId === 'subject'
        ? profiles!.map(profile => profile.subject)
        : profiles!.flatMap(profile => profile.tuples.map(tuple => tuple[profileKey]))
      assert.deepEqual(new Set(authored), new Set(declared), `${topicSlug} profiles must expose every declared ${axisId}`)
      assert.deepEqual(
        new Set([...first, ...second].map(assignment => assignment.dimensions[axisId])),
        new Set(declared),
        `${topicSlug} must rotate every declared ${axisId} rather than hide coverage behind subject concatenation`,
      )
    }
    const siblings = new Map<string, number>()
    for (const assignment of first) {
      const subject = assignment.dimensions.subject
      siblings.set(subject, (siblings.get(subject) || 0) + 1)
    }
    assert.ok([...siblings.values()].every(count => count <= topic.max_siblings_per_subject), `${topicSlug} must respect max_siblings_per_subject`)
  }
})

test('Starter profiles keep each campaign tuple authored, atomic, deterministic, and structurally new on reservation', async () => {
  const samples = new Map<string, Record<string, Record<string, string>>>()
  const reservedSamples = new Map<string, Record<string, Record<string, string>>>()
  for (const [formulaSlug, topicSlug, advertisedCount] of ADVERTISED_COVERAGE) {
    const formula = await sourceJson('formula', formulaSlug)
    const topic = await sourceJson('topic', topicSlug)
    assert.equal(formula.kind, 'series-formula')
    assert.equal(topic.kind, 'topic-pack')
    assert.equal(topic.coverage_groups, undefined, `${topicSlug} must not use cross-subject coverage groups`)
    assert.equal(topic.coverage_profiles?.length, topic.subjects.length, `${topicSlug} requires one authored profile per subject`)
    const profilesBySubject = new Map(topic.coverage_profiles!.map(profile => [profile.subject, profile]))
    const placeholder = /\b(?:generic|placeholder|topic-specific|subject-specific)\b|\b(?:a|an) (?:field|survival|geological|operating|case|historical|work) record (?:of|for|on)\b|\b(?:a )?second (?:ecological|survival|Earth|operating|social|historical|working|attention|practical|gentle) (?:pressure|strategy|process|constraint|condition|practice|rhythm) (?:on|for|affecting|in|shaping)\b/i
    for (const value of [
      ...topic.episode_objects, ...topic.mechanisms,
      ...topic.coverage_profiles!.flatMap(profile => profile.tuples.flatMap(tuple => [tuple.episode_object, tuple.mechanism])),
    ]) assert.doesNotMatch(value, placeholder, `${topicSlug} must use a real authored object or mechanism rather than a subject-echo placeholder`)
    const tupleKey = (tuple: { episode_object: string, time_place_scope: string, mechanism: string, evidence_lens: string }) =>
      [tuple.episode_object, tuple.time_place_scope, tuple.mechanism, tuple.evidence_lens].join('|')
    for (const profile of topic.coverage_profiles!) {
      const alternate = profile.tuples[1]!
      for (const other of topic.coverage_profiles!) {
        if (other.subject === profile.subject) continue
        assert.ok(!other.tuples.some(tuple => tupleKey(tuple) === tupleKey(alternate)),
          `${topicSlug} ${profile.subject} profile alternative must be authored for that subject, not copied from ${other.subject}`)
      }
    }
    const niche = contentPackDocumentToNiche(formula)
    niche.activeTopicPacks = [contentPackDocumentToTopicPack(topic)]
    const first = planIdeaAssignments({ niche, count: advertisedCount, seed: `starter-profiles-${topicSlug}` }).slice(0, advertisedCount)
    const checkpoint = planIdeaAssignments({ niche, count: advertisedCount, seed: `starter-profiles-${topicSlug}` }).slice(0, advertisedCount)
    assert.deepEqual(checkpoint, first, `${topicSlug} coverage must be checkpoint deterministic`)
    const firstBySubject = new Map(first.map(assignment => [assignment.dimensions.subject, assignment.dimensions]))
    for (const assignment of first) {
      const profile = profilesBySubject.get(assignment.dimensions.subject)
      assert.ok(profile, `${topicSlug} assignment subject must have a profile`)
      assert.ok(profile.tuples.some(tuple =>
        tuple.episode_object === assignment.dimensions['episode-object']
        && tuple.time_place_scope === assignment.dimensions['time-place-scope']
        && tuple.mechanism === assignment.dimensions.mechanism
        && tuple.evidence_lens === assignment.dimensions['evidence-lens'],
      ), `${topicSlug} must select an authored whole tuple, not independently zipped axis values`)
    }
    const second = planIdeaAssignments({
      niche, count: advertisedCount, seed: `starter-profiles-${topicSlug}-next`, usedFingerprints: first.map(assignment => assignment.fingerprint),
    }).slice(0, advertisedCount)
    assert.equal(second.length, advertisedCount, `${topicSlug} must fail closed rather than repeat a structural sibling`)
    for (const assignment of second) {
      const prior = firstBySubject.get(assignment.dimensions.subject)
      assert.ok(prior, `${topicSlug} second campaign must preserve subject coverage`)
      assert.notEqual(assignment.dimensions['episode-object'], prior['episode-object'], `${topicSlug} sibling must change episode object`)
      assert.notEqual(assignment.dimensions.mechanism, prior.mechanism, `${topicSlug} sibling must change mechanism`)
    }
    samples.set(topicSlug, Object.fromEntries(first.map(assignment => [assignment.dimensions.subject, assignment.dimensions])))
    reservedSamples.set(topicSlug, Object.fromEntries(second.map(assignment => [assignment.dimensions.subject, assignment.dimensions])))
  }
  assert.equal(samples.get('natural-world-animals')?.amphibians?.['time-place-scope'], 'a forest canopy')
  assert.equal(samples.get('natural-world-animals')?.amphibians?.mechanism, 'sensory adaptation')
  assert.equal(samples.get('deep-time-earth-systems')?.['the birth of the Moon']?.['time-place-scope'], 'a Hadean impact landscape')
  assert.equal(samples.get('deep-time-earth-systems')?.['the birth of the Moon']?.mechanism, 'giant impact')
  assert.equal(samples.get('deep-time-earth-systems')?.["Earth's magnetic field"]?.mechanism, 'core dynamo')
  assert.equal(samples.get('deep-time-earth-systems')?.['the opening of the Atlantic']?.['time-place-scope'], 'the Triassic Newark basin')
  assert.equal(samples.get('deep-time-earth-systems')?.['the opening of the Atlantic']?.mechanism, 'continental extension')
  assert.equal(samples.get('historical-wars-treaties-world-order')?.['the Yalta Conference']?.['time-place-scope'], 'Crimea during the wartime conference of February 1945')
  assert.equal(samples.get('historical-wars-treaties-world-order')?.['the Napoleonic Wars']?.['episode-object'], 'a conscription register')
  assert.equal(samples.get('everyday-calm')?.['bedtime lamp ritual']?.['episode-object'], 'a desk lamp')
  assert.deepEqual(Object.fromEntries(['episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'].map(key => [
    key, samples.get('everyday-calm')?.['rain at the window']?.[key],
  ])), {
    'episode-object': 'a window', 'time-place-scope': 'the hour before bed', mechanism: 'sensory anchoring', 'evidence-lens': 'sensory specificity',
  })
  assert.deepEqual(Object.fromEntries(['episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'].map(key => [
    key, reservedSamples.get('everyday-calm')?.['rain at the window']?.[key],
  ])), {
    'episode-object': 'a raindrop on the pane', 'time-place-scope': 'a rainy afternoon indoors', mechanism: 'sound-pattern noticing', 'evidence-lens': 'sensory specificity',
  })
  assert.deepEqual(Object.fromEntries(['episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'].map(key => [
    key, reservedSamples.get('deep-time-earth-systems')?.['the opening of the Atlantic']?.[key],
  ])), {
    'episode-object': 'a fossil shoreline', 'time-place-scope': 'a rifting seaway', mechanism: 'ocean circulation', 'evidence-lens': 'fossil record',
  })
  assert.equal(reservedSamples.get('historical-wars-treaties-world-order')?.["the Seven Years' War"]?.['episode-object'], 'a supply route')
  assert.equal(reservedSamples.get('natural-world-animals')?.migration?.mechanism, 'fuel replenishment')
  assert.equal(reservedSamples.get('night-journeys')?.["lantern keeper's evening round"]?.['episode-object'], 'a wick trimmer')
  assert.equal(samples.get('habits-momentum')?.["prepare tomorrow's shoes"]?.['episode-object'], 'a pair of shoes')
  assert.equal(samples.get('night-journeys')?.["bakery's early dough"]?.['episode-object'], 'a loaf of dough')
  assert.equal(samples.get('night-journeys')?.['teashop closing ritual']?.['episode-object'], 'a tea cup')
  assert.equal(samples.get('pov-historical-occupations')?.['professional mourner']?.['episode-object'], 'a mourning garment')
  assert.equal(samples.get('deep-time-earth-systems')?.['the Great Unconformity']?.mechanism, 'continental erosion')
  assert.equal(samples.get('deep-time-earth-systems')?.['ice-age cycles']?.['time-place-scope'], 'a Pleistocene seafloor')
  assert.equal(samples.get('deep-time-earth-systems')?.['the first rain']?.mechanism, 'early hydrologic cycling')
  assert.equal(samples.get('deep-time-earth-systems')?.['the changing Sun']?.mechanism, 'climate compensation under a faint young Sun')
  assert.equal(samples.get('deep-time-earth-systems')?.supercontinents?.mechanism, 'continental assembly')
  assert.equal(reservedSamples.get('ancient-humans-survival')?.['finding safe drinking water']?.['episode-object'], 'a seep well dug beside a dry riverbed')
  assert.equal(reservedSamples.get('ancient-humans-survival')?.['protecting fire']?.mechanism, 'ember insulation')
  assert.equal(samples.get('pov-historical-occupations')?.['lighthouse keeper']?.['episode-object'], 'a Fresnel lens')
  assert.equal(samples.get('ancient-humans-survival')?.['crossing dangerous rivers']?.['episode-object'], 'a braided-fiber safety line')
  assert.equal(samples.get('ancient-humans-survival')?.['coping with parasites']?.mechanism, 'mechanical delousing')
  assert.equal(samples.get('human-behavior-social-dynamics')?.boundaries?.['evidence-lens'], 'conversation sequence coding')
  assert.equal(samples.get('human-behavior-social-dynamics')?.manipulation?.['episode-object'], 'contradictory written promises')
  assert.equal(samples.get('everyday-calm')?.['waiting room chair']?.['time-place-scope'], 'a quiet waiting room')
  assert.equal(samples.get('everyday-calm')?.['after-screen pause']?.['episode-object'], 'a powered-down screen')
  assert.equal(samples.get('habits-momentum')?.['repeatable breakfast']?.['episode-object'], 'a prepared breakfast bowl')
  assert.equal(samples.get('habits-momentum')?.['single-task timer']?.mechanism, 'task-boundary protection')
  assert.equal(samples.get('night-journeys')?.['quiet ferry crossing']?.['episode-object'], 'a paper ferry ticket')
  assert.equal(samples.get('night-journeys')?.['orchard basket sorting']?.['episode-object'], 'an orchard basket')
  assert.equal(samples.get('night-journeys')?.['lighthouse window cleaning']?.['episode-object'], 'a lighthouse window pane')
  assert.equal(samples.get('night-journeys')?.['observatory blanket folding']?.['time-place-scope'], 'an observatory dome before dawn')
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
