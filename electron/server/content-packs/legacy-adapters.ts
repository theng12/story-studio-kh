import type {
  Niche,
  ThumbnailTemplate,
  TopicPack,
} from '../models/types.js'
import { resolveMotionProfile } from '../services/motion-profiles.js'
import { resolveRecencyStrategy } from '../services/recency-strategies.js'
import type { ContentPackDocument } from './types.js'

type FormulaDocument = Extract<ContentPackDocument, { kind: 'series-formula' }>
type TopicDocument = Extract<ContentPackDocument, { kind: 'topic-pack' }>
type RecipeDocument = Extract<ContentPackDocument, { kind: 'thumbnail-recipe' }>
type StyleDocument = Extract<ContentPackDocument, { kind: 'visual-style' }>

/** Kept local to the main process so the renderer never imports pack files. */
export interface ContentPackVisualStyle {
  id: string
  name: string
  builtin: true
  blurb: string
  category: 'Digital' | 'Explainer' | 'Illustration' | 'Realistic'
  tags: string[]
  data: { style_bible: string; negative_prompt: string }
  preview_image: string
}

function mapIdeaAxes(axes: FormulaDocument['idea_axes'] | TopicDocument['idea_axes']) {
  return axes?.map(axis => ({ id: axis.id, label: axis.label, values: [...axis.values] }))
}

function mapVocabulary(vocabulary: FormulaDocument['vocabulary'] | TopicDocument['vocabulary']) {
  if (!vocabulary) return undefined
  return {
    mood: vocabulary.mood ? [...vocabulary.mood] : undefined,
    theme: vocabulary.theme ? [...vocabulary.theme] : undefined,
    genre: vocabulary.genre ? [...vocabulary.genre] : undefined,
    keyword: vocabulary.keyword ? [...vocabulary.keyword] : undefined,
  }
}

/** Explicit snake_case → current Niche mapping. No unknown field is spread. */
export function contentPackDocumentToNiche(document: FormulaDocument): Niche {
  const motionProfile = document.script_structure.motion_profile_id
    ? resolveMotionProfile(document.script_structure.motion_profile_id)
    : undefined
  const recencyStrategy = document.recency_avoidance
    ? resolveRecencyStrategy(document.recency_avoidance.strategy_id)
    : undefined
  return {
    id: document.id,
    name: document.name,
    description: document.description,
    builtin: true,
    schemaVersion: 1,
    kind: 'series-formula',
    formulaFamily: document.formula_family,
    catalogStatus: 'active',
    catalogName: document.name,
    perspectivePolicy: document.perspective_policy,
    narrativeQualityContract: document.narrative_quality_contract ? {
      openingPolicy: document.narrative_quality_contract.opening_policy,
      forbiddenPatterns: [...document.narrative_quality_contract.forbidden_patterns],
      requiredHabits: [...document.narrative_quality_contract.required_habits],
      closingPolicy: document.narrative_quality_contract.closing_policy,
    } : undefined,
    openingProfile: document.opening_profile ? { ...document.opening_profile } : undefined,
    metadataProfile: document.metadata_profile ? {
      id: document.metadata_profile.id,
      label: document.metadata_profile.label,
      description: document.metadata_profile.description,
      descriptionSectionIds: [...document.metadata_profile.description_section_ids],
      titleMode: document.metadata_profile.title_mode,
      descriptionMaxChars: document.metadata_profile.description_max_chars,
      titleMaxLength: document.metadata_profile.title_max_length,
      tagCount: document.metadata_profile.tag_count,
    } : undefined,
    productionKit: document.production_kit ? {
      id: document.production_kit.id,
      label: document.production_kit.label,
      description: document.production_kit.description,
      recommendedVisualStyleId: document.production_kit.recommended_visual_style_id,
      episodeProfiles: document.production_kit.episode_profiles?.map(profile => ({
        id: profile.id,
        label: profile.label,
        description: profile.description,
        ideaAxisValue: profile.idea_axis_value,
        titleSuffix: profile.title_suffix,
        forbiddenTitleSuffixes: profile.forbidden_title_suffixes ? [...profile.forbidden_title_suffixes] : undefined,
        narratorStyleId: profile.narrator_style_id,
        titlePolicy: profile.title_policy,
        thumbnailPolicy: profile.thumbnail_policy,
        metadataPolicy: profile.metadata_policy,
      })),
    } : undefined,
    tagline: document.tagline,
    exampleTopics: [...(document.example_topics ?? [])],
    defaultTopicPackIds: document.default_topic_pack_ids ? [...document.default_topic_pack_ids] : undefined,
    compatibleTopicPackIds: [...document.compatible_topic_pack_ids],
    ideaAxes: mapIdeaAxes(document.idea_axes),
    vocabulary: mapVocabulary(document.vocabulary),
    youtubeTagsHint: undefined,
    audienceHint: document.audience_hint ?? document.audience,
    scriptContext: document.script_context,
    ideaSystemPromptRole: document.idea_system_prompt_role,
    ideaGuidanceText: document.idea_guidance_text,
    scriptSystemPromptRole: document.script_system_prompt_role,
    scriptClosingHint: document.script_closing_hint,
    metadataTitleStyleHint: document.metadata_title_style_hint,
    metadataTitleHookRules: document.metadata_title_hook_rules ? [...document.metadata_title_hook_rules] : undefined,
    metadataTagsHookRules: document.metadata_tags_hook_rules ? [...document.metadata_tags_hook_rules] : undefined,
    narratorStyles: document.narrator_styles?.map(style => ({ ...style })),
    defaultNarratorStyleId: document.default_narrator_style_id,
    titleShapeRules: document.title_shape_rules ? [...document.title_shape_rules] : undefined,
    titleLengthRange: document.title_length_range ? [...document.title_length_range] : undefined,
    loglineShapeRules: document.logline_shape_rules ? [...document.logline_shape_rules] : undefined,
    loglineSentenceRange: document.logline_sentence_range ? [...document.logline_sentence_range] : undefined,
    themeShapeRules: document.theme_shape_rules ? [...document.theme_shape_rules] : undefined,
    themeCountRange: document.theme_count_range ? [...document.theme_count_range] : undefined,
    structuralVariety: document.structural_variety,
    scriptStructure: {
      defaultChapterCount: document.script_structure.default_chapter_count,
      chapterCountRange: [...document.script_structure.chapter_count_range],
      defaultLengthMinutes: document.script_structure.default_length_minutes,
      lengthMinutesRange: [...document.script_structure.length_minutes_range],
      durationPresets: [...document.script_structure.duration_presets],
      defaultWordsPerMinute: document.script_structure.default_words_per_minute,
      chaptersIndependent: document.script_structure.chapters_independent,
      visualPacingProfile: document.script_structure.visual_pacing_profile ? {
        opening_duration_sec: document.script_structure.visual_pacing_profile.opening_duration_sec,
        opening: {
          min_sec: document.script_structure.visual_pacing_profile.opening.min_sec,
          max_sec: document.script_structure.visual_pacing_profile.opening.max_sec,
        },
        settled: {
          min_sec: document.script_structure.visual_pacing_profile.settled.min_sec,
          max_sec: document.script_structure.visual_pacing_profile.settled.max_sec,
        },
      } : undefined,
      motionProfile,
      motionProfileId: document.script_structure.motion_profile_id,
      pacingArc: [...document.script_structure.pacing_arc],
      additionalRules: [...document.script_structure.additional_rules],
    },
    metadataDescription: document.metadata_description ? {
      voiceGuidance: document.metadata_description.voice_guidance,
      descriptionShapeRules: document.metadata_description.description_shape_rules ? [...document.metadata_description.description_shape_rules] : undefined,
      closingBenediction: document.metadata_description.closing_benediction,
      ctaShape: document.metadata_description.cta_shape,
    } : undefined,
    recencyAvoidance: document.recency_avoidance && recencyStrategy ? {
      strategyId: document.recency_avoidance.strategy_id,
      label: document.recency_avoidance.label,
      extractPatterns: [...recencyStrategy.extractPatterns],
      defaultLookback: document.recency_avoidance.default_lookback,
      instructionTemplate: recencyStrategy.instructionTemplate,
      scopes: document.recency_avoidance.scopes ? [...document.recency_avoidance.scopes] : undefined,
    } : undefined,
    defaultThumbnailTemplateId: document.default_thumbnail_recipe_id,
  }
}

/** Explicit snake_case → current TopicPack mapping. Planner-only fields stay in registry metadata. */
export function contentPackDocumentToTopicPack(document: TopicDocument): TopicPack {
  return {
    id: document.id,
    name: document.name,
    description: document.description,
    builtin: true,
    schemaVersion: 1,
    compatibleNicheIds: [...document.compatible_formula_ids],
    compatibleFormulaIds: [...document.compatible_formula_ids],
    subjects: [...document.subjects],
    ideaAxes: mapIdeaAxes(document.idea_axes),
    exampleTopics: document.example_topics ? [...document.example_topics] : undefined,
    promptContext: document.prompt_context,
    vocabulary: mapVocabulary(document.vocabulary),
    youtubeTagsHint: document.youtube_tags_hint ? [...document.youtube_tags_hint] : undefined,
    tags: document.tags ? [...document.tags] : undefined,
  }
}

/** Explicit signed recipe → current AI ThumbnailTemplate mapping. */
export function contentPackDocumentToThumbnailTemplate(document: RecipeDocument, previewImages: readonly string[]): ThumbnailTemplate {
  return {
    id: document.id,
    name: document.name,
    description: document.description,
    builtin: true,
    schemaVersion: 1,
    recommendedNicheIds: [...document.compatible_formula_ids],
    category: document.category,
    tags: [...document.tags],
    previewImages: [...previewImages],
    aspectRatio: document.aspect_ratio,
    recipe: {
      layout: document.layout,
      conceptGuidance: document.composition_guidance,
      compositionRules: undefined,
      requiredElements: [...document.required_elements],
      avoid: [...document.avoid_elements],
      titleMode: document.title_mode,
      headlineMode: document.headline_mode,
      headlineGuidance: document.headline_guidance,
      defaultTextStyle: document.default_text_style,
      defaultFontStyle: document.default_font_style,
      defaultTextPosition: document.default_text_position,
      headlineFormats: [...document.headline_formats],
      visualStyleGuidance: document.visual_style_guidance,
    },
  }
}

function visualStyleCategory(category: string): ContentPackVisualStyle['category'] {
  if (category === 'Digital' || category === 'Explainer' || category === 'Illustration' || category === 'Realistic') return category
  throw new Error(`Unsupported visual style category: ${category}`)
}

/** Explicit signed visual-style → renderer-safe BuiltInStyle-compatible mapping. */
export function contentPackDocumentToVisualStyle(document: StyleDocument, previewImage: string): ContentPackVisualStyle {
  return {
    id: document.id,
    name: document.name,
    builtin: true,
    blurb: document.description,
    category: visualStyleCategory(document.category),
    tags: [...document.tags],
    data: { style_bible: document.style_bible, negative_prompt: document.negative_prompt },
    preview_image: previewImage,
  }
}
