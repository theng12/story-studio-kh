import { z } from 'zod'
import type { ContentPackDocument, ContentPackItemKind, ContentPackManifest } from './types.js'

export const CONTENT_PACK_FORMAT = 1 as const

const MAX_TEXT = 12_000
const MAX_LIST = 200
const QUALIFIED_ID = /^(?:[a-z][a-z0-9-]*)(?:\.[a-z][a-z0-9-]*)+$/
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SHA256 = /^[a-f0-9]{64}$/
const URL = /(?:https?:\/\/|www\.)/i

const safeText = (max = MAX_TEXT) => z.string().min(1).max(max)
  .refine(value => !URL.test(value), 'URLs are not permitted in content packs')

const qualifiedId = z.string().min(3).max(160)
  .regex(QUALIFIED_ID, 'must be a lowercase qualified reverse-DNS identifier')

const exactSemver = z.string().regex(EXACT_SEMVER, 'must be an exact semantic version')

const inPackPath = z.string().min(1).max(240)
  .regex(/^(?:content|assets)\/[a-z0-9][a-z0-9._/-]*$/, 'must be a lowercase content/ or assets/ path')
  .refine(path => !path.includes('\\') && !path.startsWith('/') && !path.split('/').includes('..'), 'must be a relative in-pack path')

const rasterAssetPath = inPackPath.refine(path => /^assets\/.+\.(?:png|jpe?g|webp)$/.test(path), 'must reference a relative PNG, JPEG, or WebP asset')
const textList = (max: number = MAX_LIST) => z.array(safeText(1000)).min(1).max(max)

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
  narrative_rules: textList(60),
  title_rules: textList(60),
  script_structure: textList(60),
  compatible_topic_pack_ids: z.array(qualifiedId).max(MAX_LIST),
  recommended_visual_style_ids: z.array(qualifiedId).max(MAX_LIST),
  recommended_thumbnail_recipe_ids: z.array(qualifiedId).max(MAX_LIST),
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
  composition_guidance: safeText(5000),
  required_elements: textList(60),
  avoid_elements: textList(60),
  headline_mode: z.enum(['title', 'custom', 'none']),
  headline_rules: textList(60),
  text_style: safeText(1000),
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
export const ContentPackBundleSchema = z.object({
  id: qualifiedId,
  kind: z.literal('channel-kit'),
  name: safeText(160),
  component_ids: z.array(qualifiedId).min(1).max(100),
}).strict()

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
  if (!withinPublisher(manifest.pack_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pack_id'], message: 'pack_id must be within the publisher namespace' })
  }
  if (!withinPublisher(manifest.key_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key_id'], message: 'key_id must be within the publisher namespace' })
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
