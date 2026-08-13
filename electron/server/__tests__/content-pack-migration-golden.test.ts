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
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { useTempDataDir } from './_helpers.js'
import type { Niche, ProjectMeta, TopicPack } from '../models/types.js'

type GoldenCatalog = {
  hidden_mechanics_history: Record<string, unknown>
  deep_time_documentary: Record<string, unknown>
  user_override_precedence: Record<string, unknown>
}

const GOLDEN_URL = new URL('./fixtures/content-packs/current-catalog-golden.json', import.meta.url)

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
  return {
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
      recommended_visual_style_id: formula.productionKit.recommendedVisualStyleId || null,
      episode_profile_ids: (formula.productionKit.episodeProfiles || []).map(profile => profile.id),
      policies_sha256: sha256(canonicalJson(formula.productionKit)),
    } : null,
    visual_profile_sha256: sha256(canonicalJson({
      visual_style_hint: formula.visualStyleHint,
      visual_style_sheet: formula.visualStyleSheet,
      thumbnail_style_sheet: formula.thumbnailStyleSheet,
      thumbnail_profile: formula.thumbnailProfile,
      default_style_keywords: formula.defaultStyleKeywords,
      negative_prompt_addendum: formula.negativePromptAddendum,
      visual_pacing_profile: scriptStructure.visualPacingProfile,
      motion_profile: scriptStructure.motionProfile,
    })),
    default_thumbnail_template_id: formula.defaultThumbnailTemplateId || null,
  }
}

async function readGolden(): Promise<GoldenCatalog> {
  return JSON.parse(await readFile(GOLDEN_URL, 'utf8')) as GoldenCatalog
}

async function loadBuiltInStyles(): Promise<Array<{
  id: string
  name: string
  data: { style_bible: string; negative_prompt: string }
}>> {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const moduleUrl = pathToFileURL(resolve(root, 'frontend/composables/useBuiltInStyles.ts')).href
  const module = await import(moduleUrl) as { BUILT_IN_STYLES: Array<{
    id: string
    name: string
    data: { style_bible: string; negative_prompt: string }
  }> }
  return module.BUILT_IN_STYLES
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
    output_root: tempData.dir,
    created_at: '2026-08-13T00:00:00.000Z',
    niche_id: nicheId,
    niche_overrides: overrides,
  }
}

test('current catalog retains stable prompt facts and selected defaults through the Content Pack migration', async () => {
  const golden = await readGolden()
  const hiddenMechanics = await nicheLoader.getEffectiveNicheFor(projectFor('hidden-mechanics-history'))
  const deepTime = await nicheLoader.getEffectiveNicheFor(projectFor('deep-time-documentary'))
  const builtInStyles = await loadBuiltInStyles()
  assert.ok(hiddenMechanics, 'Hidden Mechanics Formula must remain available')
  assert.ok(deepTime, 'Deep Time Formula must remain available')

  const archivalStyle = builtInStyles.find(style => style.id === hiddenMechanics.productionKit?.recommendedVisualStyleId)
  const archivalThumbnail = await thumbnailTemplateLoader.loadTemplate(hiddenMechanics.defaultThumbnailTemplateId || '')
  assert.ok(archivalStyle, 'Hidden Mechanics archival style must remain available')
  assert.ok(archivalThumbnail, 'Hidden Mechanics thumbnail recipe must remain available')

  const observedHiddenMechanics = {
    formula: formulaFacts(hiddenMechanics),
    default_topic_packs: (hiddenMechanics.activeTopicPacks || []).map(topicPackFacts),
    recommended_visual_style: {
      id: archivalStyle.id,
      name: archivalStyle.name,
      style_bible_sha256: sha256(archivalStyle.data.style_bible),
      negative_prompt_sha256: sha256(archivalStyle.data.negative_prompt),
    },
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
