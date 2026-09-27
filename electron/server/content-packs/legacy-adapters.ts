import type {
  Niche,
  ThumbnailTemplate,
  TopicPack,
} from '../models/types.js'
import type { ContentOrigin } from '../contracts/content-origin.js'
import { parseSubtitleStyleDocument } from '../contracts/subtitle-style-schema.js'
import { parseSceneMotionDocument, parseSceneOverlayDocument } from '../contracts/scene-effects-schema.js'
import type { BuiltInSubtitlePreset } from '../contracts/subtitle-presets.js'
import type { BuiltInMotion, BuiltInOverlay } from '../contracts/scene-effect-presets.js'
import type { BuiltInReveal } from '../contracts/scene-reveal-presets.js'
import { normalizeSceneReveal } from '../contracts/scene-reveal.js'
import type { MotionCategory, OverlayCategory } from '../contracts/scene-effects.js'
import { resolveMotionProfile } from '../services/motion-profiles.js'
import { resolveRecencyStrategy } from '../services/recency-strategies.js'
import type { ContentPackDocument } from './types.js'

type FormulaDocument = Extract<ContentPackDocument, { kind: 'series-formula' }>
type TopicDocument = Extract<ContentPackDocument, { kind: 'topic-pack' }>
type RecipeDocument = Extract<ContentPackDocument, { kind: 'thumbnail-recipe' }>
type StyleDocument = Extract<ContentPackDocument, { kind: 'visual-style' }>
type SubtitleStyleDocumentPack = Extract<ContentPackDocument, { kind: 'subtitle-style' }>
type SceneEffectDocumentPack = Extract<ContentPackDocument, { kind: 'scene-effect' }>
type OverlayDocumentPack = Extract<ContentPackDocument, { kind: 'overlay' }>
type RevealDocumentPack = Extract<ContentPackDocument, { kind: 'reveal' }>

/** A caption look from a pack, in the exact shape the built-in gallery uses. */
export type PackSubtitlePreset = BuiltInSubtitlePreset & { origin: ContentOrigin }
export type PackSceneMotion = BuiltInMotion & { origin: ContentOrigin }
export type PackSceneOverlay = BuiltInOverlay & { origin: ContentOrigin }
/** A reveal from a pack, in the exact shape the built-in library uses. */
export type PackSceneReveal = BuiltInReveal & { origin: ContentOrigin }

/** Kept local to the main process so the renderer never imports pack files. */
export interface ContentPackVisualStyle {
  id: string
  name: string
  builtin: true
  blurb: string
  category: string
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

function mapIntroDefaults(intro: FormulaDocument['intro_defaults']) {
  if (!intro) return undefined
  return {
    ...(intro.word_target !== undefined ? { wordTarget: intro.word_target } : {}),
    ...(intro.beats ? { beats: intro.beats.map(beat => typeof beat === 'string' ? beat : { ...beat }) } : {}),
    ...(intro.example_text !== undefined ? { exampleText: intro.example_text } : {}),
  }
}

type FormulaEpisodeProfileDocument = NonNullable<NonNullable<FormulaDocument['production_kit']>['episode_profiles']>[number]
type FormulaEpisodeScriptStructureDocument = NonNullable<FormulaEpisodeProfileDocument['script_structure']>

function mapScriptStructure(
  structure: FormulaDocument['script_structure'] | FormulaEpisodeScriptStructureDocument,
  resolveProfile = true,
) {
  const motionProfile = structure.motion_profile_id
    ? resolveMotionProfile(structure.motion_profile_id)
    : undefined
  return {
    defaultChapterCount: structure.default_chapter_count,
    chapterCountRange: [...structure.chapter_count_range] as [number, number],
    defaultLengthMinutes: structure.default_length_minutes,
    lengthMinutesRange: [...structure.length_minutes_range] as [number, number],
    durationPresets: [...structure.duration_presets],
    defaultWordsPerMinute: structure.default_words_per_minute,
    chaptersIndependent: structure.chapters_independent,
    visualPacingProfile: structure.visual_pacing_profile ? {
      opening_duration_sec: structure.visual_pacing_profile.opening_duration_sec,
      opening: { ...structure.visual_pacing_profile.opening },
      settled: { ...structure.visual_pacing_profile.settled },
    } : undefined,
    ...(resolveProfile && motionProfile ? { motionProfile } : {}),
    motionProfileId: structure.motion_profile_id,
    ...(structure.pacing_arc ? { pacingArc: [...structure.pacing_arc] } : {}),
    ...(structure.additional_rules ? { additionalRules: [...structure.additional_rules] } : {}),
  }
}

function mapRecencyAvoidance(recency: FormulaDocument['recency_avoidance']) {
  if (!recency) return undefined
  const strategy = resolveRecencyStrategy(recency.strategy_id)
  return {
    strategyId: recency.strategy_id,
    label: recency.label,
    extractPatterns: [...strategy.extractPatterns],
    defaultLookback: recency.default_lookback,
    instructionTemplate: strategy.instructionTemplate,
    scopes: recency.scopes ? [...recency.scopes] : undefined,
  }
}

/** Explicit snake_case → current Niche mapping. No unknown field is spread. */
export function contentPackDocumentToNiche(document: FormulaDocument): Niche {
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
    introDefaults: mapIntroDefaults(document.intro_defaults),
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
        introDefaults: mapIntroDefaults(profile.intro_defaults),
        scriptStructure: profile.script_structure ? mapScriptStructure(profile.script_structure, false) : undefined,
        recencyAvoidance: mapRecencyAvoidance(profile.recency_avoidance),
        ideaSystemPromptRole: profile.idea_system_prompt_role,
        ideaGuidanceText: profile.idea_guidance_text,
        scriptContext: profile.script_context,
        scriptSystemPromptRole: profile.script_system_prompt_role,
        scriptClosingHint: profile.script_closing_hint,
      })),
    } : undefined,
    tagline: document.tagline,
    // The pack has always declared which visual styles it recommends; until
    // now the app threw the list away and a hardcoded `builtin-` id inside the
    // production kit stood in for it. Carried through as a SUGGESTION the
    // customer can accept in Settings — nothing here writes to a project.
    recommendedVisualStyleIds: document.recommended_visual_style_ids?.length
      ? [...document.recommended_visual_style_ids]
      : undefined,
    exampleTopics: [...(document.example_topics ?? [])],
    defaultTopicPackIds: document.default_topic_pack_ids ? [...document.default_topic_pack_ids] : undefined,
    compatibleTopicPackIds: [...document.compatible_topic_pack_ids],
    ideaAxes: mapIdeaAxes(document.idea_axes),
    vocabulary: mapVocabulary(document.vocabulary),
    youtubeTagsHint: document.youtube_tags_hint ? [...document.youtube_tags_hint] : undefined,
    audienceHint: document.audience_hint ?? document.audience,
    scriptContext: document.script_context,
    ideaSystemPromptRole: document.idea_system_prompt_role,
    ideaGuidanceText: document.idea_guidance_text,
    scriptSystemPromptRole: document.script_system_prompt_role,
    scriptClosingHint: document.script_closing_hint,
    metadataTitleStyleHint: document.metadata_title_style_hint,
    metadataTitleHookRules: document.metadata_title_hook_rules ? [...document.metadata_title_hook_rules] : undefined,
    metadataTagsHookRules: document.metadata_tags_hook_rules ? [...document.metadata_tags_hook_rules] : undefined,
    visualStyleHint: document.visual_style_hint,
    narratorStyles: document.narrator_styles?.map(style => ({ ...style })),
    defaultNarratorStyleId: document.default_narrator_style_id,
    titleShapeRules: document.title_shape_rules ? [...document.title_shape_rules] : undefined,
    titleLengthRange: document.title_length_range ? [...document.title_length_range] : undefined,
    loglineShapeRules: document.logline_shape_rules ? [...document.logline_shape_rules] : undefined,
    loglineSentenceRange: document.logline_sentence_range ? [...document.logline_sentence_range] : undefined,
    themeShapeRules: document.theme_shape_rules ? [...document.theme_shape_rules] : undefined,
    themeCountRange: document.theme_count_range ? [...document.theme_count_range] : undefined,
    structuralVariety: document.structural_variety,
    scriptStructure: mapScriptStructure(document.script_structure),
    metadataDescription: document.metadata_description ? {
      voiceGuidance: document.metadata_description.voice_guidance,
      descriptionShapeRules: document.metadata_description.description_shape_rules ? [...document.metadata_description.description_shape_rules] : undefined,
      closingBenediction: document.metadata_description.closing_benediction,
      ctaShape: document.metadata_description.cta_shape,
    } : undefined,
    recencyAvoidance: mapRecencyAvoidance(document.recency_avoidance),
    defaultThumbnailTemplateId: document.default_thumbnail_template_id ?? document.default_thumbnail_recipe_id,
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
    maxSiblingsPerSubject: document.max_siblings_per_subject,
    ideaAxes: mapIdeaAxes(document.idea_axes),
    episodeObjects: [...document.episode_objects],
    timePlaceScopes: [...document.time_place_scopes],
    mechanisms: [...document.mechanisms],
    evidenceLenses: [...document.evidence_lenses],
    exclusions: [...document.exclusions],
    coverageGroups: document.coverage_groups?.map(group => ({
      subjects: [...group.subjects],
      episodeObjects: [...group.episode_objects],
      timePlaceScopes: [...group.time_place_scopes],
      mechanisms: [...group.mechanisms],
      evidenceLenses: [...group.evidence_lenses],
    })),
    coverageProfiles: document.coverage_profiles?.map(profile => ({
      subject: profile.subject,
      tuples: profile.tuples.map(tuple => ({
        episodeObject: tuple.episode_object, timePlaceScope: tuple.time_place_scope,
        mechanism: tuple.mechanism, evidenceLens: tuple.evidence_lens,
      })),
    })),
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
      compositionRules: document.composition_rules ? [...document.composition_rules] : undefined,
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

// ── Caption looks and scene effects (v1.2.1) ────────────────────────────────
//
// Each of these produces exactly the record the built-in registry produces, so
// a pack entry and a shipped entry are interchangeable in the picker, the
// preview endpoint and the compiler. The one difference is `origin`, and it is
// deliberately not optional: an entry that cannot say where it came from is an
// entry the customer cannot reason about when a pack is uninstalled.
//
// The engine document is re-parsed through its own STRICT validator rather than
// trusted from the manifest. It was already validated at install time, so this
// is not defence against a bad pack — it is how the clamped, canonicalised
// document (hex casing, paired anchors, rounded step counts) is obtained, which
// is the same object shape `defaultSubtitleStyle()` and `mergeSceneOverlay()`
// hand the renderer.

/** Explicit signed subtitle-style → built-in-compatible caption preset. */
export function contentPackDocumentToSubtitlePreset(
  document: SubtitleStyleDocumentPack,
  origin: ContentOrigin,
): PackSubtitlePreset {
  const style = parseSubtitleStyleDocument(document.style)
  return {
    id: document.id,
    name: document.name,
    description: document.description,
    ...(document.approximation ? { approximation: document.approximation } : {}),
    wordLevel: style.word.mode !== 'off',
    style,
    origin,
  }
}

/** Explicit signed scene-effect → built-in-compatible camera move. */
export function contentPackDocumentToSceneMotion(
  document: SceneEffectDocumentPack,
  origin: ContentOrigin,
): PackSceneMotion {
  return {
    id: document.id,
    name: document.name,
    category: document.category as MotionCategory,
    description: document.description,
    ...(document.approximation ? { approximation: document.approximation } : {}),
    // A pack has no legacy v1.0 parameters to honour — those bindings exist so
    // projects authored before the declarative registry keep rendering, and no
    // project predates a pack that did not exist yet.
    legacy_binding: 'none',
    document: parseSceneMotionDocument(document.motion),
    origin,
  }
}

/** Explicit signed overlay → built-in-compatible composited effect. */
export function contentPackDocumentToSceneOverlay(
  document: OverlayDocumentPack,
  origin: ContentOrigin,
): PackSceneOverlay {
  return {
    id: document.id,
    name: document.name,
    category: document.category as OverlayCategory,
    description: document.description,
    ...(document.approximation ? { approximation: document.approximation } : {}),
    document: parseSceneOverlayDocument(document.overlay),
    origin,
  }
}

/**
 * A reveal pack document → the exact shape the built-in reveal library uses.
 *
 * `normalizeSceneReveal` is the engine's own reader, so a pack's document goes through the same
 * defaults, clamps and unknown-field rejection every built-in did. The pack's `category` must agree
 * with the document's own `family` — `schemas.ts` ties them, and the engine reads the family — so a
 * disagreement is refused here rather than rendered as something the buyer did not choose.
 */
export function contentPackDocumentToSceneReveal(
  document: RevealDocumentPack,
  origin: ContentOrigin,
): PackSceneReveal {
  const reveal = normalizeSceneReveal(document.reveal)
  if (reveal.family !== document.category) {
    throw new Error(
      `reveal category "${document.category}" does not match the document's own family `
      + `"${reveal.family}"; a pack's category must be the family it ships`,
    )
  }
  return {
    id: document.id,
    name: document.name,
    family: reveal.family,
    description: document.description,
    ...(document.approximation ? { approximation: document.approximation } : {}),
    document: reveal,
    origin,
  }
}

/** Explicit signed visual-style → renderer-safe catalog mapping. */
export function contentPackDocumentToVisualStyle(document: StyleDocument, previewImage: string): ContentPackVisualStyle {
  return {
    id: document.id,
    name: document.name,
    builtin: true,
    blurb: document.description,
    category: document.category,
    tags: [...document.tags],
    data: { style_bible: document.style_bible, negative_prompt: document.negative_prompt },
    preview_image: previewImage,
  }
}
