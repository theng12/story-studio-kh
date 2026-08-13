/**
 * Migration safety net for the current built-in catalog.
 *
 * This deliberately records only the facts which alter a generated episode's
 * prompt or selected production defaults. It is not a snapshot of filesystem
 * locations, timestamps, preview files, or implementation objects.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { mergeNicheOverrides } from '../services/niche-loader.js'
import * as nicheLoader from '../services/niche-loader.js'
import * as thumbnailTemplateLoader from '../services/thumbnail-template-loader.js'
import type { DeepPartial, Niche, TopicPack } from '../models/types.js'

type GoldenCatalog = {
  hidden_mechanics_history: Record<string, unknown>
  deep_time_documentary: Record<string, unknown>
  user_override_precedence: Record<string, unknown>
}

const GOLDEN_URL = new URL('./fixtures/content-packs/current-catalog-golden.json', import.meta.url)

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
    idea_axes: (pack.ideaAxes || []).map(axis => ({
      id: axis.id,
      label: axis.label,
      value_count: axis.values.length,
      values_sha256: sha256(canonicalJson(axis.values)),
    })),
    prompt_context_sha256: promptHash(pack.promptContext),
  }
}

function formulaFacts(formula: Niche): Record<string, unknown> {
  return {
    id: formula.id,
    name: formula.name,
    formula_family: formula.formulaFamily,
    default_topic_pack_ids: formula.defaultTopicPackIds || [],
    compatible_topic_pack_ids: formula.compatibleTopicPackIds || [],
    idea_axes: (formula.ideaAxes || []).map(axis => ({
      id: axis.id,
      label: axis.label,
      value_count: axis.values.length,
      values_sha256: sha256(canonicalJson(axis.values)),
    })),
    idea_system_prompt_role_sha256: promptHash(formula.ideaSystemPromptRole),
    idea_guidance_text_sha256: promptHash(formula.ideaGuidanceText),
    script_context_sha256: promptHash(formula.scriptContext),
    script_system_prompt_role_sha256: promptHash(formula.scriptSystemPromptRole),
    script_closing_hint_sha256: promptHash(formula.scriptClosingHint),
    script_structure: formula.scriptStructure ? {
      default_chapter_count: formula.scriptStructure.defaultChapterCount,
      chapter_count_range: formula.scriptStructure.chapterCountRange,
      default_length_minutes: formula.scriptStructure.defaultLengthMinutes,
      length_minutes_range: formula.scriptStructure.lengthMinutesRange,
      duration_presets: formula.scriptStructure.durationPresets,
      default_words_per_minute: formula.scriptStructure.defaultWordsPerMinute,
      chapters_independent: formula.scriptStructure.chaptersIndependent,
      pacing_arc_sha256: sha256(canonicalJson(formula.scriptStructure.pacingArc || [])),
      additional_rules_sha256: sha256(canonicalJson(formula.scriptStructure.additionalRules || [])),
    } : null,
    recommended_visual_style_id: formula.productionKit?.recommendedVisualStyleId || null,
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

test('current catalog retains stable prompt facts and selected defaults through the Content Pack migration', async () => {
  const golden = await readGolden()
  const hiddenMechanics = await nicheLoader.loadNiche('hidden-mechanics-history')
  const deepTime = await nicheLoader.loadNiche('deep-time-documentary')
  const builtInStyles = await loadBuiltInStyles()
  assert.ok(hiddenMechanics, 'Hidden Mechanics Formula must remain available')
  assert.ok(deepTime, 'Deep Time Formula must remain available')

  const composedHiddenMechanics = await nicheLoader.composeNicheWithTopicPacks(hiddenMechanics)
  const archivalStyle = builtInStyles.find(style => style.id === hiddenMechanics.productionKit?.recommendedVisualStyleId)
  const archivalThumbnail = await thumbnailTemplateLoader.loadTemplate(hiddenMechanics.defaultThumbnailTemplateId || '')
  assert.ok(archivalStyle, 'Hidden Mechanics archival style must remain available')
  assert.ok(archivalThumbnail, 'Hidden Mechanics thumbnail recipe must remain available')

  const observedHiddenMechanics = {
    formula: formulaFacts(hiddenMechanics),
    default_topic_packs: (composedHiddenMechanics.activeTopicPacks || []).map(topicPackFacts),
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

  assert.deepEqual(observedHiddenMechanics, golden.hidden_mechanics_history)
  assert.deepEqual({ formula: formulaFacts(deepTime) }, golden.deep_time_documentary)
})

test('current user niche overrides retain precedence over formula defaults', async () => {
  const golden = await readGolden()
  const hiddenMechanics = await nicheLoader.loadNiche('hidden-mechanics-history')
  assert.ok(hiddenMechanics)

  const override: DeepPartial<Niche> = {
    scriptStructure: {
      defaultLengthMinutes: 41,
    },
    scriptClosingHint: 'User-selected ending: return to the evidence, name the uncertainty, and close without a teaser.',
  }
  const effective = mergeNicheOverrides(hiddenMechanics, override)
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
