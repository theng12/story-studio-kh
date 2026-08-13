import { z } from 'zod'
import type { ContentPackDocument, ContentPackItemKind, ContentPackManifest } from './types.js'

export const CONTENT_PACK_FORMAT = 1 as const

const MAX_TEXT = 12_000
const MAX_LIST = 200
const QUALIFIED_ID = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SHA256 = /^[a-f0-9]{64}$/
const UNSAFE_REFERENCE = /(?:\b[a-z][a-z0-9+.-]*:\S+|(?:^|[\s(])\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)/i
const ROUTING_DIRECTIVE = /\b(?:provider_id|model_id|engine_id)\b|\bprovider\s*(?::|=)\s*[^\s]+|\bmodel\s*(?::|=)\s*[^\s]+|\b(?:use|select)\s+(?:an?\s+|the\s+)?provider\b|\broute\s+(?:via|through)\s+(?:an?\s+|the\s+)?provider\b/i

const safeText = (max = MAX_TEXT) => z.string().min(1).max(max)
  .refine(value => !UNSAFE_REFERENCE.test(value), 'URI references are not permitted in content packs')
  .refine(value => !ROUTING_DIRECTIVE.test(value), 'provider or model routing directives are not permitted in content packs')

const qualifiedId = z.string().min(3).max(160)
  .regex(QUALIFIED_ID, 'must be a lowercase qualified reverse-DNS identifier')

const exactSemver = z.string().regex(EXACT_SEMVER, 'must be an exact semantic version')

const inPackPath = z.string().min(1).max(240)
  .regex(/^(?:content|assets)\/[a-z0-9][a-z0-9._/-]*$/, 'must be a lowercase content/ or assets/ path')
  .refine(path => !path.includes('\\') && !path.startsWith('/') && !path.split('/').includes('..'), 'must be a relative in-pack path')

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
const VocabularySchema = z.object({
  mood: z.array(safeText(80)).max(50).optional(),
  theme: z.array(safeText(80)).max(50).optional(),
  genre: z.array(safeText(80)).max(50).optional(),
  keyword: z.array(safeText(80)).max(100).optional(),
}).strict()
const MetadataProfileSchema = z.object({
  id: localSlug,
  label: safeText(120),
  description: safeText(500),
  description_section_ids: z.array(localSlug).min(1).max(20),
  title_mode: z.enum(['use_idea_title', 'paraphrase']),
  description_max_chars: z.number().int().min(200).max(5000),
  title_max_length: z.number().int().min(20).max(200),
  tag_count: z.number().int().min(1).max(50),
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
const VisualPacingProfileSchema = z.object({
  opening_duration_sec: z.number().int().min(0).max(3600),
  opening: z.object({ min_sec: z.number().int().min(1).max(300), max_sec: z.number().int().min(1).max(300) }).strict(),
  settled: z.object({ min_sec: z.number().int().min(1).max(300), max_sec: z.number().int().min(1).max(300) }).strict(),
}).strict().superRefine((profile, ctx) => {
  if (profile.opening.min_sec > profile.opening.max_sec || profile.settled.min_sec > profile.settled.max_sec) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'visual pacing bounds must be ordered' })
  }
})
const MetadataDescriptionSchema = z.object({
  voice_guidance: safeText(3000).optional(),
  description_shape_rules: z.array(safeText(1200)).max(60).optional(),
  closing_benediction: safeText(1200).optional(),
  cta_shape: safeText(2000).optional(),
}).strict()
const RecencyAvoidanceSchema = z.object({
  /** This allowlist is intentionally app-owned: packs cannot deliver executable scanning rules. */
  strategy_id: z.enum(['scripture-references']),
  label: safeText(160),
  default_lookback: z.number().int().min(1).max(1000).optional(),
  scopes: z.array(z.enum(['script', 'titles', 'image_prompts', 'metadata'])).min(1).max(4).optional(),
}).strict()

export const ContentPackItemKindSchema = z.enum([
  'series-formula',
  'topic-pack',
  'visual-style',
  'thumbnail-recipe',
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
  metadata_profile: MetadataProfileSchema.optional(),
  production_kit: ProductionKitSchema.optional(),
  narrative_rules: textList(60),
  title_rules: textList(60),
  script_structure: z.object({
    default_chapter_count: z.number().int().min(1).max(100),
    chapter_count_range: boundedRange(1, 100),
    default_length_minutes: z.number().int().min(1).max(600),
    length_minutes_range: boundedRange(1, 600),
    duration_presets: z.array(z.number().int().min(1).max(600)).min(1).max(20),
    default_words_per_minute: z.number().int().min(50).max(300),
    chapters_independent: z.boolean(),
    visual_pacing_profile: VisualPacingProfileSchema.optional(),
    motion_profile_id: z.enum(['ambient-documentary']).optional(),
    pacing_arc: textList(100),
    additional_rules: textList(100),
  }).strict(),
  compatible_topic_pack_ids: z.array(qualifiedId).max(MAX_LIST),
  default_topic_pack_ids: z.array(qualifiedId).max(MAX_LIST).optional(),
  example_topics: z.array(safeText(1000)).max(200).optional(),
  recommended_visual_style_ids: z.array(qualifiedId).max(MAX_LIST),
  recommended_thumbnail_recipe_ids: z.array(qualifiedId).max(MAX_LIST),
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
  episode_objects: textList(1000),
  time_place_scopes: textList(1000),
  mechanisms: textList(1000),
  evidence_lenses: textList(1000),
  exclusions: z.array(safeText(1000)).max(1000),
  max_siblings_per_subject: z.number().int().min(1).max(20),
  prompt_context: safeText(MAX_TEXT),
  idea_axes: z.array(IdeaAxisSchema).max(20).optional(),
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

const ThumbnailRecipeDocumentSchema = z.object({
  kind: z.literal('thumbnail-recipe'),
  ...baseDocument,
  layout: z.enum(['hero', 'annotated-collage']),
  category: safeText(80),
  tags: textList(80),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1']),
  title_mode: z.literal('ai'),
  composition_guidance: safeText(5000),
  required_elements: textList(60),
  avoid_elements: textList(60),
  headline_mode: z.enum(['episode-title', 'curiosity-hook']),
  headline_guidance: safeText(2000),
  default_text_style: safeText(1000),
  default_font_style: safeText(1000),
  default_text_position: z.enum(['top', 'center', 'bottom']),
  headline_formats: textList(60),
  visual_style_guidance: safeText(5000),
  preview_assets: z.array(rasterAssetPath).min(1).max(12),
  compatible_formula_ids: z.array(qualifiedId).max(MAX_LIST),
}).strict()

/** Content documents are deliberately limited to Story-owned, already-supported fields. */
export const ContentPackDocumentSchema = z.discriminatedUnion('kind', [
  SeriesFormulaDocumentSchema,
  TopicPackDocumentSchema,
  VisualStyleDocumentSchema,
  ThumbnailRecipeDocumentSchema,
])

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
  key_id: qualifiedId,
  version: exactSemver,
  min_app_version: exactSemver,
  lifecycle: z.enum(['active', 'retired', 'replaced']),
  changelog: safeText(4000).optional(),
  entitlement: z.object({
    sku: qualifiedId,
    family: qualifiedId,
  }).strict(),
  dependencies: z.array(ContentPackDependencySchema).max(100).optional(),
  successor_pack_id: qualifiedId.optional(),
  items: z.array(ContentPackItemDescriptorSchema).min(1).max(100),
  bundles: z.array(ContentPackBundleSchema).max(20).default([]),
  files: z.array(ContentPackFileSchema).min(1).max(256),
}).strict().superRefine((manifest, ctx) => {
  const withinPublisher = (id: string) => id.startsWith(`${manifest.publisher_id}.`)
  const assertUnique = (values: string[], path: Array<string | number>, label: string) => {
    const seen = new Set<string>()
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message: `${label} must be unique` })
      seen.add(value)
    }
  }
  if (!withinPublisher(manifest.pack_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pack_id'], message: 'pack_id must be within the publisher namespace' })
  }
  if (!withinPublisher(manifest.key_id)) {
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
  assertUnique((manifest.dependencies ?? []).map(dependency => `${dependency.pack_id}@${dependency.version}`), ['dependencies'], 'dependency pairs')
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

export function parseContentPackManifest(input: unknown): ContentPackManifest {
  return ContentPackManifestSchema.parse(input)
}

export function parseContentPackDocument(kind: ContentPackItemKind, input: unknown): ContentPackDocument {
  const document = ContentPackDocumentSchema.parse(input)
  if (document.kind !== kind) throw new Error(`content document kind must be ${kind}`)
  return document
}
