import { z } from 'zod'
import { MOTION_PROFILE_IDS } from '../services/motion-profiles.js'
import { RECENCY_STRATEGY_IDS } from '../services/recency-strategies.js'
import { METADATA_SECTION_IDS } from '../lib/metadata-sections.js'
import { SUBTITLE_STYLE_SCHEMA_VERSION } from '../contracts/subtitle-style.js'
import { parseSubtitleStyleDocument } from '../contracts/subtitle-style-schema.js'
import {
  FOOTAGE_MOTION_CATEGORY,
  OVERLAY_CATEGORIES,
  SCENE_EFFECT_SCHEMA_VERSION,
  SCENE_MOTION_CATEGORIES,
} from '../contracts/scene-effects.js'
import { parseSceneMotionDocument, parseSceneOverlayDocument } from '../contracts/scene-effects-schema.js'
import { BUILT_IN_METADATA_FORMULA_IDS } from '../contracts/metadata-formulas.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import {
  BUILT_IN_FOOTAGE_MOTIONS,
  BUILT_IN_OVERLAYS,
  BUILT_IN_SCENE_MOTIONS,
} from '../contracts/scene-effect-presets.js'
import { BUILT_IN_SCENE_REVEALS } from '../contracts/scene-reveal-presets.js'
import { REVEAL_FAMILIES, normalizeSceneReveal } from '../contracts/scene-reveal.js'
import type { ContentPackDocument, ContentPackItemKind, ContentPackManifest } from './types.js'
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'

export const CONTENT_PACK_FORMAT = 1 as const

const MAX_TEXT = 12_000
const MAX_LIST = 200
const QUALIFIED_ID = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SHA256 = /^[a-f0-9]{64}$/
const UNSAFE_REFERENCE = /(?:\b[a-z][a-z0-9+.-]*:\S+|(?:^|[\s(])\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)/i
const ROUTING_DIRECTIVE = /\b(?:provider_id|model_id|engine_id)\b|\bprovider\s*(?::|=)\s*[^\s]+|\bmodel\s*(?::|=)\s*[^\s]+|\b(?:use|select)\s+(?:an?\s+|the\s+)?provider\b|\broute\s+(?:via|through)\s+(?:an?\s+|the\s+)?provider\b/i
const PRIVATE_KEY_PEM = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i
// These reject values only when they use a credential/account field as an assignment,
// so ordinary editorial prose about keys, tokens, accounts, or customers remains valid.
const SENSITIVE_FIELD = '(?:api(?:[_ -]?key)|secret|(?:access[_ -]?token)|token|bearer|account(?:[_ -]?id)|customer(?:[_ -]?id))'
const SENSITIVE_ASSIGNMENT = new RegExp(`(?:^|[\\s,{;])(?:["']?${SENSITIVE_FIELD}["']?)\\s*(?:[:=]\\s*)`, 'i')
const SECRET_SHAPED_CONTEXT = new RegExp(`\\b(?:api(?:[_ -]?key)|secret|(?:access[_ -]?token)|token|bearer)\\s+is\\s+["']?(?:sk-[a-z0-9_-]{8,}|[a-z0-9._~+\\/-]{16,})`, 'i')
const AUTHORIZATION_BEARER_SECRET = /\bauthorization\s*:\s*bearer\s+(?:sk-[a-z0-9_-]{8,}|[a-z0-9._~+\/-]{16,})/i

const safeText = (max = MAX_TEXT) => z.string().min(1).max(max)
  .refine(value => !UNSAFE_REFERENCE.test(value), 'URI references are not permitted in content packs')
  .refine(value => !ROUTING_DIRECTIVE.test(value), 'provider or model routing directives are not permitted in content packs')
  .refine(value => !PRIVATE_KEY_PEM.test(value), 'private key PEM blocks are not permitted in content packs')
  .refine(value => !SENSITIVE_ASSIGNMENT.test(value) && !SECRET_SHAPED_CONTEXT.test(value) && !AUTHORIZATION_BEARER_SECRET.test(value), 'credential, token, or account assignments are not permitted in content packs')

const qualifiedId = z.string().min(3).max(160)
  .regex(QUALIFIED_ID, 'must be a lowercase qualified reverse-DNS identifier')

const exactSemver = z.string().regex(EXACT_SEMVER, 'must be an exact semantic version')

const inPackPath = z.string().min(1).max(240)
  .regex(/^(?:content|assets)\/[a-z0-9][a-z0-9._/-]*$/, 'must be a lowercase content/ or assets/ path')
  .refine(path => !path.includes('\\') && !path.startsWith('/') && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'), 'must be a relative in-pack path')

const rasterAssetPath = inPackPath.refine(path => /^assets\/.+\.(?:png|jpe?g|webp)$/.test(path), 'must reference a relative PNG, JPEG, or WebP asset')
const textList = (max: number = MAX_LIST) => z.array(safeText(1000)).min(1).max(max)
const localSlug = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be a lowercase local slug')
const boundedRange = (minimum: number, maximum: number) => z.tuple([
  z.number().int().min(minimum).max(maximum),
  z.number().int().min(minimum).max(maximum),
]).refine(([lower, upper]) => lower <= upper, 'range lower bound must not exceed upper bound')
const IdeaAxisSchema = z.object({
  id: localSlug,
  label: safeText(120),
  values: textList(300),
}).strict()
const CoverageGroupSchema = z.object({
  subjects: textList(1000),
  episode_objects: textList(300),
  time_place_scopes: textList(300),
  mechanisms: textList(300),
  evidence_lenses: textList(300),
}).strict()
const CoverageTupleSchema = z.object({
  episode_object: safeText(1000),
  time_place_scope: safeText(1000),
  mechanism: safeText(1000),
  evidence_lens: safeText(1000),
}).strict()
const CoverageProfileSchema = z.object({
  subject: safeText(1000),
  tuples: z.array(CoverageTupleSchema).min(2).max(50),
}).strict()
const VocabularySchema = z.object({
  mood: z.array(safeText(80)).max(50).optional(),
  theme: z.array(safeText(80)).max(50).optional(),
  genre: z.array(safeText(80)).max(50).optional(),
  keyword: z.array(safeText(80)).max(200).optional(),
}).strict()
const MetadataProfileSchema = z.object({
  id: localSlug,
  label: safeText(120),
  description: safeText(500),
  description_section_ids: z.array(z.enum(METADATA_SECTION_IDS)).min(1).max(20),
  title_mode: z.enum(['use_idea_title', 'paraphrase']),
  description_max_chars: z.number().int().min(200).max(5000),
  title_max_length: z.number().int().min(20).max(200),
  tag_count: z.number().int().min(1).max(50),
}).strict()

const VisualPacingProfileSchema = z.object({
  opening_duration_sec: z.number().int().min(0).max(3600),
  opening: z.object({ min_sec: z.number().int().min(1).max(300), max_sec: z.number().int().min(1).max(300) }).strict(),
  settled: z.object({ min_sec: z.number().int().min(1).max(300), max_sec: z.number().int().min(1).max(300) }).strict(),
}).strict().superRefine((profile, ctx) => {
  if (profile.opening.min_sec > profile.opening.max_sec || profile.settled.min_sec > profile.settled.max_sec) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'visual pacing bounds must be ordered' })
  }
})
const IntroDefaultsSchema = z.object({
  word_target: z.number().int().min(50).max(600).optional(),
  beats: z.array(z.union([
    safeText(300),
    z.object({ id: safeText(120), custom_text: safeText(1000).optional() }).strict(),
  ])).min(1).max(20).optional(),
  example_text: safeText(3000).optional(),
}).strict()
const ScriptStructureSchema = z.object({
  default_chapter_count: z.number().int().min(1).max(100),
  chapter_count_range: boundedRange(1, 100),
  default_length_minutes: z.number().int().min(1).max(600),
  length_minutes_range: boundedRange(1, 600),
  duration_presets: z.array(z.number().int().min(1).max(600)).min(1).max(20),
  default_words_per_minute: z.number().int().min(50).max(300),
  chapters_independent: z.boolean(),
  visual_pacing_profile: VisualPacingProfileSchema.optional(),
  motion_profile_id: z.enum(MOTION_PROFILE_IDS).optional(),
  pacing_arc: textList(100),
  additional_rules: textList(100),
}).strict()
const EpisodeScriptStructureSchema = ScriptStructureSchema.extend({
  pacing_arc: textList(100).optional(),
  additional_rules: textList(100).optional(),
}).strict()
const RecencyAvoidanceSchema = z.object({
  /** This allowlist is intentionally app-owned: packs cannot deliver executable scanning rules. */
  strategy_id: z.enum(RECENCY_STRATEGY_IDS),
  label: safeText(160),
  default_lookback: z.number().int().min(1).max(1000).optional(),
  scopes: z.array(z.enum(['script', 'titles', 'image_prompts', 'metadata'])).min(1).max(4).optional(),
}).strict()
const EpisodeProfileSchema = z.object({
  id: localSlug,
  label: safeText(120),
  description: safeText(1000),
  idea_axis_value: safeText(160),
  title_suffix: safeText(160).optional(),
  forbidden_title_suffixes: z.array(safeText(160)).max(20).optional(),
  narrator_style_id: localSlug.optional(),
  title_policy: safeText(800).optional(),
  thumbnail_policy: safeText(800).optional(),
  metadata_policy: safeText(800).optional(),
  intro_defaults: IntroDefaultsSchema.optional(),
  script_structure: EpisodeScriptStructureSchema.optional(),
  recency_avoidance: RecencyAvoidanceSchema.optional(),
  idea_system_prompt_role: safeText(MAX_TEXT).optional(),
  idea_guidance_text: safeText(MAX_TEXT).optional(),
  script_context: safeText(MAX_TEXT).optional(),
  script_system_prompt_role: safeText(MAX_TEXT).optional(),
  script_closing_hint: safeText(MAX_TEXT).optional(),
}).strict()

const ProductionKitSchema = z.object({
  id: localSlug,
  label: safeText(120),
  description: safeText(1000),
  recommended_visual_style_id: qualifiedId.optional(),
  episode_profiles: z.array(EpisodeProfileSchema).max(20).optional(),
}).strict()
const NarratorStyleSchema = z.object({
  id: localSlug,
  label: safeText(120),
  description: safeText(1000),
}).strict()
const MetadataDescriptionSchema = z.object({
  voice_guidance: safeText(3000).optional(),
  description_shape_rules: z.array(safeText(1200)).max(60).optional(),
  closing_benediction: safeText(1200).optional(),
  cta_shape: safeText(2000).optional(),
}).strict()
export const ContentPackItemKindSchema = z.enum([
  'series-formula',
  'topic-pack',
  'visual-style',
  'thumbnail-recipe',
  // v1.2.1 — the caption engine (v1.1.0) and the effect engine (v1.2.0) were
  // both built so that a look is a DESCRIPTION the engine interprets. These
  // three kinds are the payoff: a pack ships one of those descriptions and
  // nothing else. Anything a pack could want that the engine cannot already do
  // from plain data is refused by name rather than approximated.
  'subtitle-style',
  'scene-effect',
  'overlay',
  // v1.4.232 — the reveal engine (1.4.229) made an arrival a DESCRIPTION the compiler turns into an
  // FFmpeg graph, so a reveal pack ships that description and nothing else, exactly like the three
  // above. It is the fourth of the same shape, and the reveal pool the design calls for is what it
  // is for: the six wipes the engine ships stay the free starter set.
  'reveal',
  // v1.4.57 — thumbnail lettering, on exactly the principle the three above
  // established: a look is a DESCRIPTION the engine interprets. The thumbnail
  // prompt builder already turns a lettering phrase into an instruction for
  // the image model, so a pack ships phrases and their rendered swatches and
  // nothing else. No font files: the image model draws the letters, by the
  // owner's ruling.
  'lettering-style',
  // 2026-08-27 — the YouTube description's ARCHITECTURE, on the same principle:
  // a shape is a DESCRIPTION the generator interprets. The owner's ask was
  // plain — "there's no meta data formulas that we can pick from. it's all
  // build from scratch and a lot of people can't afford to spend time figure
  // that out." A formula ships ordered sections, each with its own
  // instruction, its own header decision and its own length; plus title
  // shaping, tag guidance and tone. No prose lives in the app: every word a
  // formula contributes is a field on this document, so the owner can change
  // any of it without a release.
  'metadata-formula',
])

const baseDocument = {
  schema_version: z.literal(1),
  id: qualifiedId,
  name: safeText(160),
  description: safeText(2000),
}

const SeriesFormulaDocumentSchema = z.object({
  kind: z.literal('series-formula'),
  ...baseDocument,
  channel_promise: safeText(2000),
  audience: safeText(1000),
  formula_family: safeText(80).optional(),
  tagline: safeText(200).optional(),
  perspective_policy: safeText(1200).optional(),
  narrative_quality_contract: z.object({
    opening_policy: safeText(1200),
    forbidden_patterns: textList(30),
    required_habits: textList(30),
    closing_policy: safeText(1200).optional(),
  }).strict().optional(),
  opening_profile: z.object({
    id: localSlug,
    label: safeText(120),
    description: safeText(500),
  }).strict().optional(),
  intro_defaults: IntroDefaultsSchema.optional(),
  visual_style_hint: safeText(1000).optional(),
  starting_scene_seconds: boundedRange(1, 120).optional(),
  /** Default "Pause between chapters" in Audio Assembly, seconds. */
  chapter_pause_sec: z.number().min(0).max(10).optional(),
  /** Default "Pause at a paragraph break" / "after a sentence" inside a chapter, seconds. */
  paragraph_pause_sec: z.number().min(0).max(3).optional(),
  sentence_pause_sec: z.number().min(0).max(3).optional(),
  metadata_profile: MetadataProfileSchema.optional(),
  production_kit: ProductionKitSchema.optional(),
  narrative_rules: textList(60),
  title_rules: textList(60),
  script_structure: ScriptStructureSchema,
  compatible_topic_pack_ids: z.array(qualifiedId).max(MAX_LIST),
  default_topic_pack_ids: z.array(qualifiedId).max(MAX_LIST).optional(),
  example_topics: z.array(safeText(1000)).max(200).optional(),
  youtube_tags_hint: z.array(safeText(80)).max(80).optional(),
  recommended_visual_style_ids: z.array(qualifiedId).max(MAX_LIST),
  recommended_thumbnail_recipe_ids: z.array(qualifiedId).max(MAX_LIST),
  /**
   * Optional, advisory link to Metadata Formula packs for this Series Formula
   * (owner ruling, 2026-10-25). It never decides dispatch: the channel's own
   * metadata selection stays the choice, and an id that is not installed is
   * simply not offered.
   */
  recommended_metadata_formulas: z.array(qualifiedId).max(20).optional(),
  idea_axes: z.array(IdeaAxisSchema).max(20).optional(),
  vocabulary: VocabularySchema.optional(),
  audience_hint: safeText(1000).optional(),
  evidence_expectations: z.array(safeText(1200)).max(60).optional(),
  idea_system_prompt_role: safeText(MAX_TEXT).optional(),
  idea_guidance_text: safeText(MAX_TEXT).optional(),
  script_context: safeText(MAX_TEXT).optional(),
  script_system_prompt_role: safeText(MAX_TEXT).optional(),
  script_closing_hint: safeText(MAX_TEXT).optional(),
  narrator_styles: z.array(NarratorStyleSchema).max(30).optional(),
  default_narrator_style_id: localSlug.optional(),
  title_shape_rules: z.array(safeText(1000)).max(60).optional(),
  title_length_range: boundedRange(1, 200).optional(),
  logline_shape_rules: z.array(safeText(1000)).max(60).optional(),
  logline_sentence_range: boundedRange(1, 20).optional(),
  theme_shape_rules: z.array(safeText(1000)).max(60).optional(),
  theme_count_range: boundedRange(1, 20).optional(),
  structural_variety: z.enum(['free', 'vary-all', 'vary-subject-only']).optional(),
  default_thumbnail_recipe_id: qualifiedId.optional(),
  default_thumbnail_template_id: localSlug.optional(),
  metadata_title_style_hint: safeText(1000).optional(),
  metadata_title_hook_rules: z.array(safeText(1000)).max(60).optional(),
  metadata_tags_hook_rules: z.array(safeText(1000)).max(60).optional(),
  metadata_description: MetadataDescriptionSchema.optional(),
  recency_avoidance: RecencyAvoidanceSchema.optional(),
  creative_profiles: z.array(z.enum(['narrative', 'balanced', 'editorial', 'spiritual', 'abstract'])).min(1).max(5).optional(),
}).strict()

const TopicPackDocumentSchema = z.object({
  kind: z.literal('topic-pack'),
  ...baseDocument,
  compatible_formula_ids: z.array(qualifiedId).min(1).max(MAX_LIST),
  subjects: textList(1000),
  episode_objects: textList(2000),
  time_place_scopes: textList(2000),
  mechanisms: textList(2000),
  evidence_lenses: textList(2000),
  exclusions: z.array(safeText(1000)).max(1000),
  max_siblings_per_subject: z.number().int().min(1).max(20),
  prompt_context: safeText(MAX_TEXT),
  idea_axes: z.array(IdeaAxisSchema).max(20).optional(),
  coverage_groups: z.array(CoverageGroupSchema).min(1).max(1000).optional(),
  coverage_profiles: z.array(CoverageProfileSchema).min(1).max(1000).optional(),
  example_topics: z.array(safeText(1000)).max(200).optional(),
  vocabulary: VocabularySchema.optional(),
  youtube_tags_hint: z.array(safeText(80)).max(80).optional(),
  tags: z.array(safeText(80)).max(80).optional(),
  evidence_expectations: z.array(safeText(1200)).max(60).optional(),
  compatibility_rules: z.array(safeText(1200)).max(60).optional(),
}).strict()

const VisualStyleDocumentSchema = z.object({
  kind: z.literal('visual-style'),
  ...baseDocument,
  category: safeText(80),
  tags: textList(60),
  style_bible: safeText(MAX_TEXT),
  negative_prompt: safeText(MAX_TEXT),
  preview_assets: z.array(rasterAssetPath).min(1).max(12),
  compatible_formula_ids: z.array(qualifiedId).max(MAX_LIST),
}).strict()

/**
 * v1.4.277 — a user style pack: the owner's own looks, shared by every project
 * on this Mac. The style fields are the signed visual-style document's, but the
 * pack is unsigned, so it carries no preview assets, takes no
 * `com.storystudio.` id, and never enters the signed catalog or project pins.
 * Picking one copies its text into the project like any custom style.
 */
export const UserStylePackSchema = z.object({
  user_pack_format: z.literal(1),
  pack_id: qualifiedId.refine(id => !id.startsWith('com.storystudio.'), 'must not use the com.storystudio namespace'),
  name: safeText(160),
  version: exactSemver,
  description: safeText(2000).optional(),
  styles: z.array(VisualStyleDocumentSchema
    .omit({ preview_assets: true, negative_prompt: true })
    .extend({ negative_prompt: safeText(MAX_TEXT).optional() })).min(1).max(500),
}).strict().superRefine((pack, ctx) => {
  const seen = new Set<string>()
  pack.styles.forEach((style, index) => {
    if (!style.id.startsWith(`${pack.pack_id}.`)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['styles', index, 'id'], message: `must start with ${pack.pack_id}.` })
    }
    if (seen.has(style.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['styles', index, 'id'], message: 'duplicate style id' })
    seen.add(style.id)
  })
})
export type UserStylePack = z.infer<typeof UserStylePackSchema>

const ThumbnailRecipeDocumentSchema = z.object({
  kind: z.literal('thumbnail-recipe'),
  ...baseDocument,
  layout: z.enum(['hero', 'annotated-collage']),
  category: safeText(80),
  tags: textList(80),
  // model-drift-allow: Content Pack recipe geometry, not a GenStudio model capability list.
  aspect_ratio: z.enum(['16:9', '9:16', '1:1']),
  title_mode: z.literal('ai'),
  composition_guidance: safeText(5000),
  composition_rules: z.array(safeText(1200)).max(60).optional(),
  required_elements: textList(60),
  avoid_elements: textList(60),
  // `short-hook` is the engine's "two or three words" mode (models/thumbnail-headlines.ts).
  // The signed recipe schema had omitted it, so the owner-approved Illustrated History
  // recipe could not be built as a pack even though the engine already generated it.
  headline_mode: z.enum(['episode-title', 'short-hook', 'curiosity-hook']),
  headline_guidance: safeText(2000).optional(),
  default_text_style: safeText(1000),
  default_font_style: safeText(1000),
  default_text_position: z.enum(['top', 'center', 'bottom', 'bottom-left']),
  headline_formats: textList(60),
  visual_style_guidance: safeText(5000),
  preview_assets: z.array(rasterAssetPath).min(1).max(12),
  compatible_formula_ids: z.array(qualifiedId).max(MAX_LIST),
}).strict()

// ── Caption looks and scene effects (v1.2.1) ────────────────────────────────
//
// These three carry an APP-OWNED engine document verbatim rather than
// re-declaring its fields. Re-declaring forty caption fields in a second place
// is precisely how two schemas drift apart, and the engine's own validators
// (`parseSubtitleStyleDocument`, `parseSceneMotionDocument`,
// `parseSceneOverlayDocument`) are already strict in exactly the way a pack
// needs: `.strict()` objects that reject an unknown field BY NAME, so a pack
// authored against a newer engine says which key it used.
//
// The nested body therefore arrives here as an opaque object and is validated
// in the union refinement below, which is also where the engine schema version
// is gated and where the built-in namespace is protected.

const engineBody = z.record(z.unknown())

const LetteringStyleDocumentPackSchema = z.object({
  kind: z.literal('lettering-style'),
  ...baseDocument,
  /**
   * Which picker this style joins. `font` is the shape of the letters;
   * `text` is the treatment applied to them. A pack cannot invent a third —
   * the prompt builder has exactly these two slots.
   */
  axis: z.enum(['font', 'text']),
  /**
   * The phrase injected into the image prompt, verbatim. This IS the product:
   * everything else on the document exists to help somebody choose it.
   */
  phrase: safeText(600),
  /**
   * At least one rendered swatch. A lettering style without a picture is a
   * name, and a name is precisely what the owner cannot buy from:
   * "all just words i don't know ... i prefer visual."
   */
  preview_assets: z.array(rasterAssetPath).min(1).max(4),
}).strict()

/**
 * One section of a description formula.
 *
 * `id` is INTERNAL — a key for the section, never viewer-facing text. Whether
 * the reader sees a heading at all is `header.render`, and what it says is
 * `header.text`; a formula that wants an unheaded paragraph says so and the
 * generated description carries no label for it.
 */
const MetadataFormulaSectionSchema = z.object({
  id: localSlug,
  /** What this section must contain, in the formula author's own words. */
  instruction: safeText(800),
  header: z.object({
    render: z.boolean(),
    /** The exact line the reader sees. Required when `render` is true. */
    text: safeText(80).optional(),
  }).strict(),
  /** Rough length for this section's body. Omitted = the model judges it. */
  target_chars: z.number().int().min(40).max(2000).optional(),
}).strict().refine(
  section => !section.header.render || !!section.header.text,
  { path: ['header', 'text'], message: 'a section that renders a header must state the exact header text' },
)

/**
 * A metadata formula: the whole architecture of an episode's YouTube write-up.
 *
 * Distinct from `metadata_profile` on a series formula, which only picks which
 * of the app's thirteen built-in section TYPES appear. That could not express a
 * different SHAPE — only a different subset of one shape. This kind can, which
 * is what makes formulas worth selling in packs.
 *
 * A built-in formula is one of these documents too, validated by this very
 * schema, which is what keeps the eventual cutover to signed-packs-only a
 * deletion rather than a migration. Because they share one id namespace, the
 * refinement below is what stops a pack claiming a shipped formula's id.
 */
export const MetadataFormulaDocumentSchema = z.object({
  kind: z.literal('metadata-formula'),
  ...baseDocument,
  /** One line naming the shape, for the picker: what makes this one different. */
  architecture: safeText(200),
  description_plan: z.object({
    max_chars: z.number().int().min(200).max(5000),
    /** What goes between sections. The owner's choice, not an engineer's. */
    separator: z.enum(['rule', 'blank-line', 'none']),
    sections: z.array(MetadataFormulaSectionSchema).min(1).max(12).superRefine((sections, ctx) => {
      // Section ids key the generated plan, so two sections sharing one id
      // would make the formula ambiguous about which instruction produced
      // which text.
      const seen = new Set<string>()
      sections.forEach((section, index) => {
        if (seen.has(section.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: `duplicate section id "${section.id}" — every section in a formula needs its own id`,
          })
        }
        seen.add(section.id)
      })
    }),
  }).strict(),
  title_plan: z.object({
    mode: z.enum(['use_idea_title', 'paraphrase']),
    count: z.number().int().min(1).max(10),
    max_length: z.number().int().min(20).max(200),
    /** The tone/shape instruction for titles, replacing the format's default. */
    guidance: safeText(600),
  }).strict(),
  tag_plan: z.object({
    count: z.number().int().min(1).max(50),
    guidance: safeText(600),
  }).strict(),
  /** Voice rules surfaced at the top of the description prompt. */
  tone: z.object({
    constraints: z.array(safeText(200)).min(1).max(8),
  }).strict(),
}).strict()

const SubtitleStyleDocumentPackSchema = z.object({
  kind: z.literal('subtitle-style'),
  ...baseDocument,
  /** Honest note about what libass cannot render exactly. Shown in the gallery. */
  approximation: safeText(2000).optional(),
  /** A complete v2 `SubtitleStyleDocument`. No patches — a pack ships a finished look. */
  style: engineBody,
}).strict()

const SceneEffectDocumentPackSchema = z.object({
  kind: z.literal('scene-effect'),
  ...baseDocument,
  /** Which existing picker group the move joins. A pack cannot invent a group. */
  category: z.enum([...SCENE_MOTION_CATEGORIES, FOOTAGE_MOTION_CATEGORY]),
  approximation: safeText(2000).optional(),
  /** A complete `SceneMotionDocument`. `motion.source` decides which registry it joins. */
  motion: engineBody,
}).strict()

const RevealDocumentPackSchema = z.object({
  kind: z.literal('reveal'),
  ...baseDocument,
  /** Which family the arrival belongs to. A pack cannot invent one. */
  category: z.enum(REVEAL_FAMILIES),
  approximation: safeText(2000).optional(),
  /** A complete `SceneRevealDocument`. The engine's own normaliser reads it at load. */
  reveal: engineBody,
}).strict()

const OverlayDocumentPackSchema = z.object({
  kind: z.literal('overlay'),
  ...baseDocument,
  category: z.enum(OVERLAY_CATEGORIES),
  approximation: safeText(2000).optional(),
  /** A complete `SceneOverlayDocument` of one of the seven engine overlay kinds. */
  overlay: engineBody,
}).strict()

/** Built-in ids a pack must never claim, per kind. */
const BUILT_IN_IDS: Readonly<Record<'subtitle-style' | 'scene-effect' | 'overlay' | 'lettering-style' | 'reveal', ReadonlySet<string>>> = {
  'subtitle-style': new Set(BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id)),
  'scene-effect': new Set([...BUILT_IN_SCENE_MOTIONS, ...BUILT_IN_FOOTAGE_MOTIONS].map(entry => entry.id)),
  overlay: new Set(BUILT_IN_OVERLAYS.map(entry => entry.id)),
  // The engine's own twenty presets. A reveal pack adds arrivals; it may never
  // take the name of one every project already draws from its default pool.
  reveal: new Set(BUILT_IN_SCENE_REVEALS.map(entry => entry.id)),
  // The app's own font and treatment ids. A pack may not claim one: the buyer
  // would pay for a style that silently loses to a built-in, or worse, changes
  // what every existing thumbnail prompt means.
  'lettering-style': new Set([...Object.keys(FONT_STYLES), ...Object.keys(TEXT_STYLES)]),
}

/**
 * Walk every string inside an engine document and hold it to the same content
 * rules the pack's own prose obeys.
 *
 * The engine schemas validate SHAPE — that `font_family` is a string of at most
 * 120 characters. They have no opinion about whether that string is a URL, a
 * provider routing directive or a pasted API key, because nothing inside Story
 * Studio would ever put one there. A pack is not Story Studio.
 */
function assertPackSafeStrings(body: unknown, ctx: z.RefinementCtx, at: Array<string | number>, depth = 0): void {
  if (depth > 8 || body === null || typeof body !== 'object') return
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const path = [...at, key]
    if (typeof value === 'string') {
      const problem = UNSAFE_REFERENCE.test(value) ? 'URI references are not permitted in content packs'
        : ROUTING_DIRECTIVE.test(value) ? 'provider or model routing directives are not permitted in content packs'
          : PRIVATE_KEY_PEM.test(value) ? 'private key PEM blocks are not permitted in content packs'
            : (SENSITIVE_ASSIGNMENT.test(value) || SECRET_SHAPED_CONTEXT.test(value) || AUTHORIZATION_BEARER_SECRET.test(value))
                ? 'credential, token, or account assignments are not permitted in content packs'
                : null
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: problem })
      continue
    }
    if (value && typeof value === 'object') assertPackSafeStrings(value, ctx, path, depth + 1)
  }
}

/**
 * Validate one nested engine document.
 *
 * The engine schema version is checked FIRST and returns early on a mismatch,
 * so a pack built for a newer engine gets one sentence naming the version it
 * needs instead of a wall of "unknown field" noise about fields this build has
 * simply never heard of.
 */
function refineEngineDocument(
  ctx: z.RefinementCtx,
  spec: {
    at: string
    body: unknown
    supported: number
    label: string
    parse: (input: unknown) => unknown
  },
): void {
  const declared = (spec.body as { schema_version?: unknown } | null)?.schema_version
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [spec.at, 'schema_version'],
      message: `a ${spec.label} must declare an integer schema_version; this Story Studio build implements version ${spec.supported}`,
    })
    return
  }
  if (declared !== spec.supported) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [spec.at, 'schema_version'],
      message: declared > spec.supported
        ? `this ${spec.label} needs ${spec.label} schema version ${declared}; this Story Studio build implements version ${spec.supported} — update Story Studio before installing this pack`
        : `this ${spec.label} declares retired ${spec.label} schema version ${declared}; this Story Studio build implements version ${spec.supported}`,
    })
    return
  }
  try {
    spec.parse(spec.body)
  } catch (error) {
    const issues = (error as { issues?: string[] }).issues
    for (const issue of issues?.length ? issues : [(error as Error).message]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [spec.at], message: issue })
    }
    return
  }
  assertPackSafeStrings(spec.body, ctx, [spec.at])
}

/** Content documents are deliberately limited to Story-owned, already-supported fields. */
export const ContentPackDocumentSchema = z.discriminatedUnion('kind', [
  SeriesFormulaDocumentSchema,
  TopicPackDocumentSchema,
  VisualStyleDocumentSchema,
  ThumbnailRecipeDocumentSchema,
  SubtitleStyleDocumentPackSchema,
  SceneEffectDocumentPackSchema,
  OverlayDocumentPackSchema,
  RevealDocumentPackSchema,
  LetteringStyleDocumentPackSchema,
  MetadataFormulaDocumentSchema,
]).superRefine((document, ctx) => {
  if (document.kind === 'metadata-formula') {
    // A built-in formula and a bought one are the same kind of document in the
    // same id namespace, so a pack could otherwise claim a shipped formula's id
    // and silently win a lookup. It is refused here instead, exactly as the
    // engine kinds refuse it.
    if ((BUILT_IN_METADATA_FORMULA_IDS as readonly string[]).includes(document.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id collides with the built-in metadata formula "${document.id}" — a Content Pack adds to the library and may never replace or shadow a built-in`,
      })
    }
    return
  }
  if (document.kind === 'subtitle-style' || document.kind === 'scene-effect'
    || document.kind === 'overlay' || document.kind === 'lettering-style'
    || document.kind === 'reveal') {
    // A pack ADDS to the library. It never replaces a built-in, and it never
    // shadows one silently: the free starter sets keep working with any pack
    // installed, and a pack claiming a built-in id is refused here rather than
    // quietly winning a lookup somewhere downstream.
    if (BUILT_IN_IDS[document.kind].has(document.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id collides with the built-in ${document.kind} "${document.id}" — a Content Pack adds to the library and may never replace or shadow a built-in`,
      })
    }
    // A lettering style carries no engine body — its phrase IS the payload,
    // already bounded by the schema above. The id guard it shares with the
    // three engine kinds is the only rule that applies to it.
    if (document.kind === 'lettering-style') return
    if (document.kind === 'subtitle-style') {
      refineEngineDocument(ctx, {
        at: 'style',
        body: document.style,
        supported: SUBTITLE_STYLE_SCHEMA_VERSION,
        label: 'subtitle style',
        parse: parseSubtitleStyleDocument,
      })
      return
    }
    if (document.kind === 'reveal') {
      // The reveal engine has no Zod schema of its own: its reader is
      // `normalizeSceneReveal`, which is what the compiler and the planner call, and a pack
      // document goes through exactly that. Validating it here with a second schema would be a
      // rule free to disagree with the one that actually renders — so the check is the reader
      // itself, plus the family agreement the adapter also enforces.
      const reveal = normalizeSceneReveal(document.reveal)
      if (reveal.family !== document.category) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['category'],
          message: `category "${document.category}" must be the family the reveal document itself states ("${reveal.family}")`,
        })
      }
      return
    }
    if (document.kind === 'scene-effect') {
      refineEngineDocument(ctx, {
        at: 'motion',
        body: document.motion,
        supported: SCENE_EFFECT_SCHEMA_VERSION,
        label: 'scene effect',
        parse: parseSceneMotionDocument,
      })
      // The two engines are separate pipelines with separate picker groups, so
      // a footage move filed under `zoom` would appear beside the still moves
      // and render on the wrong one.
      const isFootage = (document.motion as { source?: unknown }).source === FOOTAGE_MOTION_CATEGORY
      if (isFootage !== (document.category === FOOTAGE_MOTION_CATEGORY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['category'],
          message: `category "${FOOTAGE_MOTION_CATEGORY}" and motion.source "${FOOTAGE_MOTION_CATEGORY}" must be used together`,
        })
      }
      return
    }
    refineEngineDocument(ctx, {
      at: 'overlay',
      body: document.overlay,
      supported: SCENE_EFFECT_SCHEMA_VERSION,
      label: 'scene overlay',
      parse: parseSceneOverlayDocument,
    })
    // A corner logo names a file on the customer's own machine. A pack cannot
    // know that path, and a pack that supplies one is either guessing or
    // pointing the compiler at a file it was never meant to read.
    if ((document.overlay as { kind?: unknown; image_path?: unknown }).kind === 'corner-logo'
      && (document.overlay as { image_path?: unknown }).image_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overlay', 'image_path'],
        message: 'a Content Pack must not supply overlay.image_path — the corner mark is a file on the customer\'s machine, so ship the overlay with an empty image_path and let them choose it',
      })
    }
    return
  }
  if (document.kind === 'topic-pack') {
    const groups = document.coverage_groups
    const profiles = document.coverage_profiles
    if (profiles) {
      const memberships = new Map(document.subjects.map(subject => [subject, 0]))
      const declared = {
        episode_object: new Set(document.episode_objects), time_place_scope: new Set(document.time_place_scopes),
        mechanism: new Set(document.mechanisms), evidence_lens: new Set(document.evidence_lenses),
      }
      for (const [profileIndex, profile] of profiles.entries()) {
        if (!memberships.has(profile.subject)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_profiles', profileIndex, 'subject'], message: 'coverage profile subject must be declared by the Topic Pack' })
        } else {
          memberships.set(profile.subject, (memberships.get(profile.subject) || 0) + 1)
        }
        const objects = new Set<string>()
        const mechanisms = new Set<string>()
        for (const [tupleIndex, tuple] of profile.tuples.entries()) {
          for (const key of ['episode_object', 'time_place_scope', 'mechanism', 'evidence_lens'] as const) {
            if (!declared[key].has(tuple[key])) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_profiles', profileIndex, 'tuples', tupleIndex, key], message: `coverage profile ${key} must be declared by the Topic Pack` })
            }
          }
          objects.add(tuple.episode_object)
          mechanisms.add(tuple.mechanism)
        }
        if (objects.size !== profile.tuples.length || mechanisms.size !== profile.tuples.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_profiles', profileIndex, 'tuples'], message: 'coverage profile tuples must each change episode object and mechanism' })
        }
      }
      for (const [subject, count] of memberships) {
        if (count !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_profiles'], message: `subject ${subject} must have exactly one coverage profile` })
      }
    }
    if (!groups) return
    const declared = {
      episode_objects: new Set(document.episode_objects),
      time_place_scopes: new Set(document.time_place_scopes),
      mechanisms: new Set(document.mechanisms),
      evidence_lenses: new Set(document.evidence_lenses),
    }
    const memberships = new Map(document.subjects.map(subject => [subject, 0]))
    for (const [groupIndex, group] of groups.entries()) {
      const tupleLength = group.episode_objects.length
      for (const key of ['time_place_scopes', 'mechanisms', 'evidence_lenses'] as const) {
        if (group[key].length !== tupleLength || tupleLength < 2) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_groups', groupIndex, key], message: 'coverage group tuple lanes must have the same length and at least two entries' })
        }
      }
      for (const key of ['episode_objects', 'mechanisms'] as const) {
        if (new Set(group[key]).size !== tupleLength) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_groups', groupIndex, key], message: 'coverage group episode objects and mechanisms must make every tuple structurally distinct' })
        }
      }
      for (const [subjectIndex, subject] of group.subjects.entries()) {
        if (!memberships.has(subject)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_groups', groupIndex, 'subjects', subjectIndex], message: 'coverage group subject must be declared by the Topic Pack' })
          continue
        }
        memberships.set(subject, (memberships.get(subject) || 0) + 1)
      }
      for (const key of ['episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses'] as const) {
        for (const [valueIndex, value] of group[key].entries()) {
          if (!declared[key].has(value)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_groups', groupIndex, key, valueIndex], message: `coverage group ${key} must be declared by the Topic Pack` })
          }
        }
      }
    }
    for (const [subject, count] of memberships) {
      if (count !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_groups'], message: `subject ${subject} must belong to exactly one usable coverage group` })
      }
    }
    return
  }
  if (document.kind !== 'series-formula') return
  const { script_structure: structure } = document
  const [minChapters, maxChapters] = structure.chapter_count_range
  const [minLength, maxLength] = structure.length_minutes_range
  if (structure.default_chapter_count < minChapters || structure.default_chapter_count > maxChapters) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['script_structure', 'default_chapter_count'], message: 'default chapter count must be within the chapter count range' })
  }
  if (structure.default_length_minutes < minLength || structure.default_length_minutes > maxLength) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['script_structure', 'default_length_minutes'], message: 'default length minutes must be within the length range' })
  }
  if (!structure.duration_presets.includes(structure.default_length_minutes) || structure.duration_presets.some(duration => duration < minLength || duration > maxLength)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['script_structure', 'duration_presets'], message: 'duration presets must include the default and remain within the length range' })
  }
  const compatibleTopicPacks = new Set(document.compatible_topic_pack_ids)
  for (const [index, topicPackId] of (document.default_topic_pack_ids ?? []).entries()) {
    if (!compatibleTopicPacks.has(topicPackId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['default_topic_pack_ids', index], message: 'default Topic Pack must be compatible with the Formula' })
    }
  }
  const narratorStyleIds = new Set((document.narrator_styles ?? []).map(style => style.id))
  const assertUnique = (values: string[], path: Array<string | number>, label: string) => {
    const seen = new Set<string>()
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message: `${label} must be unique` })
      seen.add(value)
    }
  }
  const ideaAxes = document.idea_axes ?? []
  assertUnique(ideaAxes.map(axis => axis.id), ['idea_axes'], 'idea axis IDs')
  for (const [index, axis] of ideaAxes.entries()) {
    assertUnique(axis.values, ['idea_axes', index, 'values'], 'idea axis values')
  }
  assertUnique((document.narrator_styles ?? []).map(style => style.id), ['narrator_styles'], 'narrator style IDs')
  if (document.default_narrator_style_id && !narratorStyleIds.has(document.default_narrator_style_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['default_narrator_style_id'], message: 'default narrator style must be declared by the Formula' })
  }
  const episodeProfiles = document.production_kit?.episode_profiles ?? []
  assertUnique(episodeProfiles.map(profile => profile.id), ['production_kit', 'episode_profiles'], 'episode profile IDs')
  assertUnique(episodeProfiles.map(profile => profile.idea_axis_value), ['production_kit', 'episode_profiles'], 'episode profile idea axis values')
  for (const [index, profile] of episodeProfiles.entries()) {
    if (profile.narrator_style_id && !narratorStyleIds.has(profile.narrator_style_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['production_kit', 'episode_profiles', index, 'narrator_style_id'], message: 'episode profile narrator style must be declared by the Formula' })
    }
    const profileStructure = profile.script_structure
    if (profileStructure) {
      const [profileMinChapters, profileMaxChapters] = profileStructure.chapter_count_range
      const [profileMinLength, profileMaxLength] = profileStructure.length_minutes_range
      const basePath: Array<string | number> = ['production_kit', 'episode_profiles', index, 'script_structure']
      if (profileStructure.default_chapter_count < profileMinChapters || profileStructure.default_chapter_count > profileMaxChapters) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...basePath, 'default_chapter_count'], message: 'episode profile default chapter count must be within its range' })
      }
      if (profileStructure.default_length_minutes < profileMinLength || profileStructure.default_length_minutes > profileMaxLength) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...basePath, 'default_length_minutes'], message: 'episode profile default length must be within its range' })
      }
      if (!profileStructure.duration_presets.includes(profileStructure.default_length_minutes)
        || profileStructure.duration_presets.some(duration => duration < profileMinLength || duration > profileMaxLength)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...basePath, 'duration_presets'], message: 'episode profile duration presets must include the default and remain within its range' })
      }
    }
  }
  if (episodeProfiles.length > 0) {
    const profileAxes = ideaAxes.filter(axis => axis.id === 'episode-profile')
    if (profileAxes.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idea_axes'], message: 'production episode profiles require exactly one episode-profile idea axis' })
    } else {
      const profileAxisValues = profileAxes[0].values
      for (const [index, profile] of episodeProfiles.entries()) {
        if (!profileAxisValues.includes(profile.idea_axis_value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['production_kit', 'episode_profiles', index, 'idea_axis_value'], message: 'episode profile idea axis value must be declared exactly once by the episode-profile axis' })
        }
      }
    }
  }
  if (document.default_thumbnail_recipe_id && !document.recommended_thumbnail_recipe_ids.includes(document.default_thumbnail_recipe_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['default_thumbnail_recipe_id'], message: 'default thumbnail recipe must be among the Formula recommendations' })
  }
  if (document.production_kit?.recommended_visual_style_id && !document.recommended_visual_style_ids.includes(document.production_kit.recommended_visual_style_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['production_kit', 'recommended_visual_style_id'], message: 'production kit visual style must be among the Formula recommendations' })
  }
})

/** A Channel Kit is a commercial bundle of documents, never a fifth document schema. */
const ContentPackComponentReferenceSchema = z.object({
  pack_id: qualifiedId,
  version: exactSemver,
  item_id: qualifiedId,
  kind: ContentPackItemKindSchema,
}).strict()

export const ContentPackBundleSchema = z.object({
  id: qualifiedId,
  kind: z.literal('channel-kit'),
  name: safeText(160),
  components: z.array(ContentPackComponentReferenceSchema).min(2).max(100),
}).strict().superRefine((bundle, ctx) => {
  const kinds = new Set(bundle.components.map(component => component.kind))
  if (!kinds.has('series-formula')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: 'Channel Kit requires exactly one Formula component' })
  }
  if (bundle.components.filter(component => component.kind === 'series-formula').length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: 'Channel Kit requires exactly one Formula component' })
  }
  if (!kinds.has('topic-pack')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: 'Channel Kit requires at least one Topic Pack component' })
  }
  const seen = new Set<string>()
  const seenItemIds = new Set<string>()
  for (const [index, component] of bundle.components.entries()) {
    const identity = `${component.pack_id}@${component.version}:${component.item_id}`
    if (seen.has(identity)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', index], message: 'Channel Kit component references must be unique' })
    }
    seen.add(identity)
    if (seenItemIds.has(component.item_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', index, 'item_id'], message: 'Channel Kit item IDs must be unique' })
    }
    seenItemIds.add(component.item_id)
  }
})

const ContentPackFileSchema = z.object({
  path: inPackPath,
  sha256: z.string().regex(SHA256, 'must be a lowercase SHA-256 digest'),
  bytes: z.number().int().min(1).max(15 * 1024 * 1024),
  mime: z.enum(['application/json', 'image/png', 'image/jpeg', 'image/webp']),
}).strict().superRefine((file, ctx) => {
  const isJson = /^content\/.+\.json$/.test(file.path) && file.mime === 'application/json'
  const isRaster = /^assets\/.+\.(?:png|jpe?g|webp)$/.test(file.path)
    && ((file.path.endsWith('.png') && file.mime === 'image/png')
      || ((file.path.endsWith('.jpg') || file.path.endsWith('.jpeg')) && file.mime === 'image/jpeg')
      || (file.path.endsWith('.webp') && file.mime === 'image/webp'))
  if (!isJson && !isRaster) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'file MIME type and extension are not permitted' })
  }
})

const ContentPackItemDescriptorSchema = z.object({
  id: qualifiedId,
  kind: ContentPackItemKindSchema,
  schema_version: z.literal(1),
  path: inPackPath.refine(path => /^content\/.+\.json$/.test(path), 'content document paths must be JSON'),
}).strict()

const ContentPackDependencySchema = z.object({
  pack_id: qualifiedId,
  version: exactSemver,
}).strict()

export const ContentPackManifestSchema = z.object({
  pack_format: z.literal(CONTENT_PACK_FORMAT),
  pack_id: qualifiedId,
  publisher_id: qualifiedId,
  key_id: qualifiedId.optional(),
  version: exactSemver,
  min_app_version: exactSemver,
  lifecycle: z.enum(['active', 'retired', 'replaced']),
  /** Store delivery is receipt-attested; local and recovery packs omit this. */
  // model-drift-allow: Frozen Content Store receipt profile is the persisted delivery manifest schema tag.
  delivery_profile: z.literal('genstudio-store-receipt-v1').optional(),
  changelog: safeText(4000).optional(),
  entitlement: z.object({
    sku: qualifiedId,
    family: qualifiedId,
  }).strict(),
  dependencies: z.array(ContentPackDependencySchema).max(100).optional(),
  successor_pack_id: qualifiedId.optional(),
  items: z.array(ContentPackItemDescriptorSchema).max(100),
  bundles: z.array(ContentPackBundleSchema).max(20).default([]),
  files: z.array(ContentPackFileSchema).max(256),
}).strict().superRefine((manifest, ctx) => {
  const withinPublisher = (id: string) => id.startsWith(`${manifest.publisher_id}.`)
  const assertUnique = (values: string[], path: Array<string | number>, label: string) => {
    const seen = new Set<string>()
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message: `${label} must be unique` })
      seen.add(value)
    }
  }
  const bundleOnly = isBundleOnlyCoordinationManifest(manifest)
  if (!bundleOnly) {
    if (manifest.items.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'normal content packs require at least one item' })
    }
    if (manifest.files.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'normal content packs require at least one file' })
    }
  } else {
    if (manifest.bundles.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundles'], message: 'bundle-only coordination packs require exactly one Channel Kit bundle' })
    }
    const components = manifest.bundles[0]?.components ?? []
    const count = (kind: ContentPackItemKind) => components.filter(component => component.kind === kind).length
    if (count('series-formula') !== 1 || count('topic-pack') < 1 || count('visual-style') < 1 || count('thumbnail-recipe') !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundles', 0, 'components'], message: 'bundle-only coordination packs require exactly one Formula, at least one Topic Pack, one or more Styles, and exactly one Recipe component' })
    }
    const dependencies = manifest.dependencies ?? []
    if (dependencies.length !== components.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dependencies'], message: 'bundle-only coordination packs require one ordered dependency per component' })
    } else {
      for (const [index, component] of components.entries()) {
        const dependency = dependencies[index]
        if (dependency?.pack_id !== component.pack_id || dependency.version !== component.version) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dependencies', index], message: 'bundle-only dependency order must equal the component owner sequence' })
        }
      }
    }
    for (const [index, component] of components.entries()) {
      if (component.pack_id === manifest.pack_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundles', 0, 'components', index], message: 'bundle-only coordination components must be external' })
      }
    }
    for (const [index, dependency] of (manifest.dependencies ?? []).entries()) {
      if (!components.some(component => component.pack_id === dependency.pack_id && component.version === dependency.version)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dependencies', index], message: 'bundle-only coordination dependencies must be used by an exact component reference' })
      }
    }
  }
  if (!withinPublisher(manifest.pack_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pack_id'], message: 'pack_id must be within the publisher namespace' })
  }
  if (manifest.delivery_profile && manifest.key_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key_id'], message: 'delivery-attested manifests must not declare a publisher key ID' })
  } else if (!manifest.delivery_profile && !manifest.key_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key_id'], message: 'local and recovery manifests require a publisher key ID' })
  } else if (manifest.key_id && !withinPublisher(manifest.key_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key_id'], message: 'key_id must be within the publisher namespace' })
  }
  if (!withinPublisher(manifest.entitlement.sku)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entitlement', 'sku'], message: 'entitlement SKU must be within the publisher namespace' })
  }
  if (!withinPublisher(manifest.entitlement.family)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entitlement', 'family'], message: 'entitlement family must be within the publisher namespace' })
  }
  if (manifest.lifecycle === 'replaced' && !manifest.successor_pack_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['successor_pack_id'], message: 'replaced packs require a successor pack ID' })
  }
  if (manifest.lifecycle !== 'replaced' && manifest.successor_pack_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['successor_pack_id'], message: 'only replaced packs may declare a successor pack ID' })
  }
  if (manifest.successor_pack_id) {
    if (!withinPublisher(manifest.successor_pack_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['successor_pack_id'], message: 'successor pack ID must be within the publisher namespace' })
    }
    if (manifest.successor_pack_id === manifest.pack_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['successor_pack_id'], message: 'successor pack ID must not reference the pack itself' })
    }
  }
  assertUnique(manifest.items.map(item => item.id), ['items'], 'item IDs')
  assertUnique(manifest.items.map(item => item.path), ['items'], 'item paths')
  assertUnique(manifest.files.map(file => file.path), ['files'], 'file paths')
  assertUnique(manifest.bundles.map(bundle => bundle.id), ['bundles'], 'bundle IDs')
  assertUnique((manifest.dependencies ?? []).map(dependency => dependency.pack_id), ['dependencies'], 'dependency pack IDs (one version per pack)')
  for (const [index, dependency] of (manifest.dependencies ?? []).entries()) {
    if (dependency.pack_id === manifest.pack_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dependencies', index, 'pack_id'], message: 'pack must not depend on itself' })
    }
  }
  for (const [index, item] of manifest.items.entries()) {
    if (!withinPublisher(item.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'id'], message: 'item ID must be within the publisher namespace' })
    }
    const matchingFile = manifest.files.find(file => file.path === item.path)
    if (!matchingFile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'path'], message: 'item path must name a declared file' })
    } else if (matchingFile.mime !== 'application/json') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'path'], message: 'item path must name a declared JSON file' })
    }
  }
  for (const [index, bundle] of manifest.bundles.entries()) {
    if (!withinPublisher(bundle.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundles', index, 'id'], message: 'bundle ID must be within the publisher namespace' })
    }
    for (const [componentIndex, component] of bundle.components.entries()) {
      if (component.pack_id === manifest.pack_id) {
        if (component.version !== manifest.version) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundles', index, 'components', componentIndex, 'version'], message: 'same-pack component must use the exact current pack version' })
          continue
        }
        const declaration = manifest.items.find(item => item.id === component.item_id && item.kind === component.kind)
        if (!declaration) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundles', index, 'components', componentIndex], message: 'same-pack component reference must name a declared document' })
        }
      } else if (!(manifest.dependencies ?? []).some(dependency => dependency.pack_id === component.pack_id && dependency.version === component.version)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundles', index, 'components', componentIndex], message: 'external component reference must have an exact manifest dependency' })
      }
    }
  }
})

export function isBundleOnlyCoordinationManifest(manifest: ContentPackManifest): boolean {
  return manifest.items.length === 0 && manifest.files.length === 0
}

export function parseContentPackManifest(input: unknown): ContentPackManifest {
  return ContentPackManifestSchema.parse(input)
}

export function parseContentPackDocument(kind: ContentPackItemKind, input: unknown): ContentPackDocument {
  const document = ContentPackDocumentSchema.parse(input)
  if (document.kind !== kind) throw new Error(`content document kind must be ${kind}`)
  return document
}
