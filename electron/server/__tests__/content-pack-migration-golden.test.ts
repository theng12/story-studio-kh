/**
 * Migration safety net for the current built-in catalog.
 *
 * This deliberately records only the facts which alter a generated episode's
 * prompt or selected production defaults. It is not a snapshot of filesystem
 * locations, timestamps, preview files, or implementation objects.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { useTempDataDir } from './_helpers.js'
import type { Niche, ProjectMeta, TopicPack } from '../models/types.js'

type GoldenCatalog = {
  hidden_mechanics_history: Record<string, unknown>
  deep_time_documentary: Record<string, unknown>
  free_starter_source_catalog: Record<string, unknown>
  user_override_precedence: Record<string, unknown>
}

const GOLDEN_URL = new URL('./fixtures/content-packs/current-catalog-golden.json', import.meta.url)

const FREE_STARTER_FORMULA_IDS = [
  'animals',
  'ancient-humans',
  'deep-time-documentary',
  'business-economics',
  'psychology',
  'history-narration',
  'pov-life',
  'mindfulness',
  'motivation',
  'sleep',
]
const FREE_STARTER_TOPIC_PACK_IDS = [
  'natural-world-animals',
  'ancient-humans-survival',
  'deep-time-earth-systems',
  'economics-businesses',
  'human-behavior-social-dynamics',
  'historical-wars-treaties-world-order',
  'pov-historical-occupations',
]
const FREE_STARTER_STYLE_DIRECTORIES = [
  'waxy-outline-cartoon',
  'prehistoric-stick-cartoon-v1.0.1',
  'paleo-documentary-tableau',
  'hand-drawn-editorial-diagram',
  'minimal-stick-figure-explainer-v1.0.1',
  'sepia-ink-wash',
  'cinematic-photoreal',
  'watercolor-storybook',
  'flat-vector-explainer',
]
const FREE_STARTER_RECIPE_IDS = [
  'curiosity-question-cartoon',
  'documentary-label-tableau',
  'annotated-business-board',
  'centered-hero-headline',
  'portrait-block-right',
]

let tempData: Awaited<ReturnType<typeof useTempDataDir>>
let nicheLoader: typeof import('../services/niche-loader.js')
let topicPackLoader: typeof import('../services/topic-pack-loader.js')
let thumbnailTemplateLoader: typeof import('../services/thumbnail-template-loader.js')

before(async () => {
  tempData = await useTempDataDir()
  nicheLoader = await import('../services/niche-loader.js')
  topicPackLoader = await import('../services/topic-pack-loader.js')
  thumbnailTemplateLoader = await import('../services/thumbnail-template-loader.js')
})

after(async () => {
  await tempData.cleanup()
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function promptHash(value: string | undefined): string | null {
  return value === undefined ? null : sha256(value)
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefined(entry)]))
  }
  return value
}

function topicPackFacts(pack: TopicPack): Record<string, unknown> {
  return {
    id: pack.id,
    name: pack.name,
    compatible_formula_ids: pack.compatibleFormulaIds || pack.compatibleNicheIds,
    subject_count: pack.subjects.length,
    subjects_sha256: sha256(canonicalJson(pack.subjects)),
    idea_axis_ids: (pack.ideaAxes || []).map(axis => ({
      id: axis.id,
      label: axis.label,
    })),
    idea_axes_sha256: sha256(canonicalJson(pack.ideaAxes || [])),
    prompt_context_sha256: promptHash(pack.promptContext),
  }
}

function formulaFacts(formula: Niche): Record<string, unknown> {
  const scriptStructure = formula.scriptStructure || {}
  return withoutUndefined({
    id: formula.id,
    name: formula.name,
    formula_family: formula.formulaFamily,
    default_topic_pack_ids: formula.defaultTopicPackIds || [],
    compatible_topic_pack_ids: formula.compatibleTopicPackIds || [],
    active_topic_pack_ids: (formula.activeTopicPacks || []).map(pack => pack.id),
    effective_prompt_fields_sha256: sha256(canonicalJson({
      idea_system_prompt_role: formula.ideaSystemPromptRole,
      idea_guidance_text: formula.ideaGuidanceText,
      script_context: formula.scriptContext,
      script_system_prompt_role: formula.scriptSystemPromptRole,
    })),
    ideation_profile_sha256: sha256(canonicalJson({
      description: formula.description,
      tagline: formula.tagline,
      examples: formula.exampleTopics,
      vocabulary: formula.vocabulary,
      audience: formula.audienceHint,
      axes: formula.ideaAxes,
      title_shape_rules: formula.titleShapeRules,
      title_length_range: formula.titleLengthRange,
      logline_shape_rules: formula.loglineShapeRules,
      logline_sentence_range: formula.loglineSentenceRange,
      theme_shape_rules: formula.themeShapeRules,
      theme_count_range: formula.themeCountRange,
      structural_variety: formula.structuralVariety,
    })),
    script_shape: {
      default_chapter_count: scriptStructure.defaultChapterCount,
      chapter_count_range: scriptStructure.chapterCountRange,
      default_length_minutes: scriptStructure.defaultLengthMinutes,
      length_minutes_range: scriptStructure.lengthMinutesRange,
      duration_presets: scriptStructure.durationPresets,
      default_words_per_minute: scriptStructure.defaultWordsPerMinute,
      chapters_independent: scriptStructure.chaptersIndependent,
    },
    narration_profile_sha256: sha256(canonicalJson({
      script_closing_hint: formula.scriptClosingHint,
      narrator_styles: formula.narratorStyles,
      default_narrator_style_id: formula.defaultNarratorStyleId,
      perspective_policy: formula.perspectivePolicy,
      narrative_quality_contract: formula.narrativeQualityContract,
      script_structure: scriptStructure,
    })),
    default_narrator_style_id: formula.defaultNarratorStyleId || null,
    metadata_profile_sha256: sha256(canonicalJson({
      metadata_profile: formula.metadataProfile,
      youtube_tags_hint: formula.youtubeTagsHint,
      metadata_title_style_hint: formula.metadataTitleStyleHint,
      metadata_title_hook_rules: formula.metadataTitleHookRules,
      metadata_tags_hook_rules: formula.metadataTagsHookRules,
    })),
    production_kit: formula.productionKit ? {
      id: formula.productionKit.id,
      label: formula.productionKit.label,
      recommended_visual_style_ids: formula.recommendedVisualStyleIds || null,
      episode_profile_ids: (formula.productionKit.episodeProfiles || []).map(profile => profile.id),
      policies_sha256: sha256(canonicalJson(formula.productionKit)),
    } : null,
    visual_profile_sha256: sha256(canonicalJson({
      visual_style_hint: formula.visualStyleHint,
      visual_style_sheet: formula.visualStyleSheet,
      thumbnail_style_sheet: formula.thumbnailStyleSheet,
      thumbnail_profile: formula.thumbnailProfile,
      default_style_keywords: formula.defaultStyleKeywords,
      visual_pacing_profile: scriptStructure.visualPacingProfile,
      motion_profile: scriptStructure.motionProfile,
    })),
    default_thumbnail_template_id: formula.defaultThumbnailTemplateId || null,
  }) as Record<string, unknown>
}

function visualStyleFacts(style: { id: string; name: string; data: { style_bible: string; negative_prompt: string } }): Record<string, unknown> {
  return withoutUndefined({
    id: style.id,
    name: style.name,
    style_bible_sha256: sha256(style.data.style_bible),
    negative_prompt_sha256: sha256(style.data.negative_prompt),
  }) as Record<string, unknown>
}

function thumbnailRecipeBehavior(template: NonNullable<Awaited<ReturnType<typeof thumbnailTemplateLoader.loadTemplate>>>): Record<string, unknown> {
  const behavior = { ...template } as Record<string, unknown>
  for (const metadataField of [
    'id',
    'name',
    'description',
    'tagline',
    'builtin',
    'schemaVersion',
    'category',
    'tags',
    'recommendedNicheIds',
    'previewImages',
  ]) delete behavior[metadataField]
  return behavior
}

function thumbnailRecipeFacts(template: NonNullable<Awaited<ReturnType<typeof thumbnailTemplateLoader.loadTemplate>>>): Record<string, unknown> {
  return withoutUndefined({
    id: template.id,
    name: template.name,
    title_mode: template.recipe?.titleMode,
    layout: template.recipe?.layout,
    recipe_behavior_sha256: sha256(canonicalJson(thumbnailRecipeBehavior(template))),
  }) as Record<string, unknown>
}

async function readGolden(): Promise<GoldenCatalog> {
  return JSON.parse(await readFile(GOLDEN_URL, 'utf8')) as GoldenCatalog
}

async function loadFreeStarterStyles(): Promise<Array<{
  id: string
  name: string
  data: { style_bible: string; negative_prompt: string }
}>> {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  return Promise.all(FREE_STARTER_STYLE_DIRECTORIES.map(async directory => {
    const source = JSON.parse(await readFile(
      join(root, 'content-packs', 'free-starters', 'style', directory, 'content', 'visual-style.json'),
      'utf8',
    )) as { id: string; name: string; style_bible: string; negative_prompt: string }
    return {
      id: source.id,
      name: source.name,
      data: { style_bible: source.style_bible, negative_prompt: source.negative_prompt },
    }
  }))
}

function projectFor(
  nicheId: string,
  overrides?: ProjectMeta['niche_overrides'],
): ProjectMeta {
  return {
    name: 'Content Pack Golden',
    slug: `content-pack-golden-${nicheId}`,
    episode_prefix: 'CPG',
    episode_digits: 4,
    season_size: 12,
    season_prefix: 'S',
    folder_template: '{code} - {title}',
    subfolder_names: {} as ProjectMeta['subfolder_names'],
    created_at: '2026-08-13T00:00:00.000Z',
    niche_id: nicheId,
    niche_overrides: overrides,
  }
}

test('current catalog retains stable prompt facts and selected defaults through the Content Pack migration', async () => {
  const golden = await readGolden()
  const hiddenMechanics = await nicheLoader.getEffectiveNicheFor(projectFor('hidden-mechanics-history'))
  const deepTime = await nicheLoader.getEffectiveNicheFor(projectFor('deep-time-documentary'))
  assert.ok(hiddenMechanics, 'Hidden Mechanics Formula must remain available')
  assert.ok(deepTime, 'Deep Time Formula must remain available')

  const archivalThumbnail = await thumbnailTemplateLoader.loadTemplate(hiddenMechanics.defaultThumbnailTemplateId || '')
  assert.ok(archivalThumbnail, 'Hidden Mechanics thumbnail recipe must remain available')
  // No `recommended_visual_style` block: a Formula does not select a look, so
  // there is no style fact for the catalog to freeze here. The style library
  // is frozen on its own in the Starter Kit test below.
  const observedHiddenMechanics = {
    formula: formulaFacts(hiddenMechanics),
    default_topic_packs: (hiddenMechanics.activeTopicPacks || []).map(topicPackFacts),
    default_thumbnail_recipe: {
      id: archivalThumbnail.id,
      name: archivalThumbnail.name,
      title_mode: archivalThumbnail.recipe?.titleMode,
      layout: archivalThumbnail.recipe?.layout,
      recipe_sha256: sha256(canonicalJson(archivalThumbnail.recipe)),
    },
  }

  const observedDeepTime = {
    formula: formulaFacts(deepTime),
    default_topic_packs: (deepTime.activeTopicPacks || []).map(topicPackFacts),
  }
  assert.deepEqual(observedHiddenMechanics, golden.hidden_mechanics_history)
  assert.deepEqual(observedDeepTime, golden.deep_time_documentary)
})

test('free Starter Kit source components retain effective prompt, style, and recipe facts', async () => {
  const golden = await readGolden()
  const styles = await loadFreeStarterStyles()
  const formulas = await Promise.all(FREE_STARTER_FORMULA_IDS.map(id => nicheLoader.getEffectiveNicheFor(projectFor(id))))
  const topics = await Promise.all(FREE_STARTER_TOPIC_PACK_IDS.map(id => topicPackLoader.loadTopicPack(id)))
  const recipes = await Promise.all(FREE_STARTER_RECIPE_IDS.map(id => thumbnailTemplateLoader.loadTemplate(id)))

  assert.ok(formulas.every(Boolean), 'every approved Starter Kit Formula must retain an effective legacy source')
  assert.ok(topics.every(Boolean), 'every migrated Starter Kit Topic Pack must retain its legacy source')
  assert.ok(recipes.every(Boolean), 'every migrated Starter Kit Thumbnail Recipe must retain its legacy source')
  assert.equal(styles.length, FREE_STARTER_STYLE_DIRECTORIES.length, 'every approved Starter Kit Style must retain its signed source')

  const observed = {
    formulas: formulas.map(formula => formulaFacts(formula!)),
    topics: topics.map(topic => topicPackFacts(topic!)),
    styles: styles.map(visualStyleFacts),
    recipes: recipes.map(recipe => thumbnailRecipeFacts(recipe!)),
    blocked_recipe_sources: ['prehistoric-discovery', 'dreamscape-story-window'],
  }
  assert.deepEqual(observed, golden.free_starter_source_catalog)
})

test('static thumbnail layout behavior is golden-protected against top-level rendering changes', async () => {
  const template = await thumbnailTemplateLoader.loadTemplate('centered-hero-headline')
  const portrait = await thumbnailTemplateLoader.loadTemplate('portrait-block-right')
  assert.ok(template)
  assert.ok(portrait)
  const facts = thumbnailRecipeFacts(template)
  assert.equal(facts.recipe_behavior_sha256, '5a5685f7c16765caeda6ed8681ee5230f121063f04c362bb0c66ccec77b37c65')
  assert.deepEqual(template.canvas, { width: 1920, height: 1080 })
  assert.deepEqual(template.backgroundDimGradient, {
    side: 'full', coverage: 1, color: '#000000', strength: 0.5,
  })
  assert.equal(template.textZones?.[0]?.fontSize, 168)

  assert.equal(
    thumbnailRecipeFacts(portrait).recipe_behavior_sha256,
    'a740bfc57153173bbc23bfbcf4b3d315e17aadf9d5c17131c9a9a5191d389115',
  )
  assert.deepEqual(portrait.canvas, { width: 1920, height: 1080 })
  assert.deepEqual(portrait.backgroundDimGradient, {
    side: 'right', coverage: 0.6, color: '#000000', strength: 0.72,
  })
  assert.equal(portrait.textZones?.[0]?.fontSize, 132)

  const changed = structuredClone(template)
  assert.ok(changed.canvas)
  changed.canvas = { ...changed.canvas, width: changed.canvas.width + 1 }
  assert.notEqual(
    facts.recipe_behavior_sha256,
    thumbnailRecipeFacts(changed).recipe_behavior_sha256,
    'changing a top-level canvas field must change the frozen rendering behavior',
  )
})

test('current user niche overrides retain precedence over formula defaults', async () => {
  const golden = await readGolden()
  const hiddenMechanics = await nicheLoader.getEffectiveNicheFor(projectFor('hidden-mechanics-history'))
  assert.ok(hiddenMechanics)

  const override: ProjectMeta['niche_overrides'] = {
    scriptStructure: {
      defaultLengthMinutes: 41,
    },
    scriptClosingHint: 'User-selected ending: return to the evidence, name the uncertainty, and close without a teaser.',
  }
  const effective = await nicheLoader.getEffectiveNicheFor(projectFor('hidden-mechanics-history', override))
  assert.ok(effective)
  const observed = {
    formula_id: effective.id,
    base_default_length_minutes: hiddenMechanics.scriptStructure?.defaultLengthMinutes,
    effective_default_length_minutes: effective.scriptStructure?.defaultLengthMinutes,
    preserved_chapter_count: effective.scriptStructure?.defaultChapterCount,
    base_script_closing_hint_sha256: promptHash(hiddenMechanics.scriptClosingHint),
    effective_script_closing_hint_sha256: promptHash(effective.scriptClosingHint),
  }

  assert.deepEqual(observed, golden.user_override_precedence)
})

test('legacy Hidden Mechanics IDs remain independently resolvable before an explicit component migration', async () => {
  const [formula, topic, recipe] = await Promise.all([
    nicheLoader.loadNiche('hidden-mechanics-history'),
    topicPackLoader.loadTopicPack('historical-states-revolutions-collapse'),
    thumbnailTemplateLoader.loadTemplate('archival-map-investigation'),
  ])
  assert.equal(formula?.id, 'hidden-mechanics-history')
  assert.equal(topic?.id, 'historical-states-revolutions-collapse')
  assert.equal(recipe?.id, 'archival-map-investigation')
})

test('a centered headline legacy user template stays a 94px project override', async () => {
  const customId = 'centered-hero-headline-custom'
  const source = JSON.parse(await readFile(join(thumbnailTemplateLoader.BUILTIN_TEMPLATES_DIR, 'centered-hero-headline.json'), 'utf8'))
  const userDir = thumbnailTemplateLoader._userTemplatesDir()
  const userPath = join(userDir, `${customId}.json`)
  source.id = customId
  source.builtin = false
  source.textZones[0].fontSize = 94

  await mkdir(userDir, { recursive: true })
  await writeFile(userPath, JSON.stringify(source))
  thumbnailTemplateLoader._clearTemplateCaches()
  try {
    const custom = await thumbnailTemplateLoader.loadTemplate(customId)
    assert.equal(custom?.id, customId)
    assert.equal(custom?.textZones?.[0]?.fontSize, 94)

    const niche = await nicheLoader.getEffectiveNicheFor(projectFor('animals'))
    assert.ok(niche)
    assert.equal(niche.defaultThumbnailTemplateId, 'curiosity-question-cartoon')
    const nicheDefault = await thumbnailTemplateLoader.getEffectiveTemplateFor(
      projectFor('animals'),
      niche,
    )
    assert.equal(nicheDefault?.id, 'curiosity-question-cartoon')
    const effective = await thumbnailTemplateLoader.getEffectiveTemplateFor(
      projectFor('animals'),
      niche,
      { thumbnail_template_id: customId },
    )
    assert.equal(effective?.id, customId)
    assert.equal(effective?.textZones?.[0]?.fontSize, 94)
  } finally {
    await rm(userPath, { force: true })
    thumbnailTemplateLoader._clearTemplateCaches()
  }
})

test('isolated golden catalog baseline is not taken from user shadow entries', async () => {
  const golden = await readGolden()
  const builtinNichePath = join(nicheLoader.BUILTIN_NICHES_DIR, 'hidden-mechanics-history.json')
  const builtinPackPath = join(topicPackLoader.BUILTIN_TOPIC_PACKS_DIR, 'historical-states-revolutions-collapse.json')
  const builtinTemplatePath = join(thumbnailTemplateLoader.BUILTIN_TEMPLATES_DIR, 'archival-map-investigation.json')
  const userNicheDir = nicheLoader._userNichesDir()
  const userPackDir = dirname(topicPackLoader.topicPackFilePath('probe'))
  const userTemplateDir = thumbnailTemplateLoader._userTemplatesDir()
  const userNichePath = join(userNicheDir, 'hidden-mechanics-history.json')
  const userPackPath = join(userPackDir, 'historical-states-revolutions-collapse.json')
  const userTemplatePath = join(userTemplateDir, 'archival-map-investigation.json')

  const customNiche = JSON.parse(await readFile(builtinNichePath, 'utf8'))
  customNiche.scriptSystemPromptRole = 'TEMP USER SHADOW MUST NOT DEFINE THE BUILT-IN GOLDEN BASELINE.'
  const customPack = JSON.parse(await readFile(builtinPackPath, 'utf8'))
  customPack.promptContext = 'TEMP USER TOPIC PACK SHADOW MUST NOT DEFINE THE BUILT-IN GOLDEN BASELINE.'
  const customTemplate = JSON.parse(await readFile(builtinTemplatePath, 'utf8'))
  customTemplate.name = 'Temp user archival recipe shadow'

  await Promise.all([mkdir(userNicheDir, { recursive: true }), mkdir(userPackDir, { recursive: true }), mkdir(userTemplateDir, { recursive: true })])
  await Promise.all([
    writeFile(userNichePath, JSON.stringify(customNiche)),
    writeFile(userPackPath, JSON.stringify(customPack)),
    writeFile(userTemplatePath, JSON.stringify(customTemplate)),
  ])
  nicheLoader._clearNicheCaches()
  topicPackLoader.invalidateTopicPackCache()
  thumbnailTemplateLoader._clearTemplateCaches()

  const shadowed = await nicheLoader.getEffectiveNicheFor(projectFor('hidden-mechanics-history'))
  const shadowedTemplate = await thumbnailTemplateLoader.loadTemplate('archival-map-investigation')
  assert.match(shadowed?.scriptSystemPromptRole || '', /TEMP USER SHADOW/)
  assert.match(shadowed?.scriptSystemPromptRole || '', /TEMP USER TOPIC PACK SHADOW/)
  assert.equal(shadowedTemplate?.name, 'Temp user archival recipe shadow')

  await Promise.all([rm(userNichePath), rm(userPackPath), rm(userTemplatePath)])
  nicheLoader._clearNicheCaches()
  topicPackLoader.invalidateTopicPackCache()
  thumbnailTemplateLoader._clearTemplateCaches()

  const restored = await nicheLoader.getEffectiveNicheFor(projectFor('hidden-mechanics-history'))
  assert.ok(restored)
  assert.deepEqual(formulaFacts(restored), (golden.hidden_mechanics_history as { formula: unknown }).formula)
  assert.deepEqual(
    (restored.activeTopicPacks || []).map(topicPackFacts),
    (golden.hidden_mechanics_history as { default_topic_packs: unknown }).default_topic_packs,
  )
})
