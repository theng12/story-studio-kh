/**
 * Shared wire contracts — the ONE place the frontend and backend agree on
 * the shape of an API call.
 *
 * Lives inside `electron/server/contracts/` so the backend tsconfig (with
 * `rootDir: .`) compiles it alongside the rest of the server, and the
 * frontend reaches it via the `@shared` Nuxt alias set in
 * `frontend/nuxt.config.ts`.
 *
 * Imported by:
 *   - `electron/server/schemas/index.ts` — re-exports for route validation.
 *   - `frontend/composables/*` — `import type { … } from '@shared/contracts'`.
 *
 * Schemas are zod so the backend can validate at the HTTP boundary; the
 * frontend pulls the inferred TypeScript types with `import type`, which is
 * erased at compile time — the renderer bundle never ships the zod runtime.
 *
 * A shared constant frontend runtime code needs as a real VALUE (not just a
 * type) does not belong in this file — a value import can't be erased, so it
 * would pull this whole zod-schema module into the renderer bundle. Those
 * live in their own zero-dependency sibling module instead, still reachable
 * through the same `@shared` alias (e.g. `@shared/pacing` →
 * `electron/server/contracts/pacing.ts`).
 */

import { z } from 'zod'
import {
  MAX_PROJECT_LABELS,
  MAX_PROJECT_LABEL_LENGTH,
  normalizeProjectLabels,
} from './project-labels.js'
import { MAX_PROJECT_SLUG_LENGTH } from './project-slug.js'

// ── Projects ────────────────────────────────────────────────────────────────

export const CreateProjectSchema = z.object({
  // `name` stays .min(1) — a project literally can't exist without one.
  name: z.string().min(1, 'name is required').max(120),
  // 2026-10-28 — the channel folder name, chosen outright (optional). The
  // charset/unique checks live in project-manager so a refusal reads as a plain
  // sentence; this bound only stops a wildly long value at the wire.
  slug: z.string().max(MAX_PROJECT_SLUG_LENGTH).optional(),
  // The fields below are all "optional with a sensible default" — frontend
  // forms either start empty or let the user blank them out, sending '' to
  // mean "use the default." Pairing .min(1) with .optional() rejects ''
  // while .optional() alone allows undefined, so empty-string round-trips
  // hit a 400. Drop .min(1); .max() still bounds the upper end, and the
  // services that consume these fields apply their own defaults.
  template: z.string().max(60).optional(),
  episode_prefix: z.string().max(10).optional(),
  episode_digits: z.number().int().min(1).max(8).optional(),
  season_prefix: z.string().max(40).optional(),
  season_size: z.number().int().min(1).max(1000).optional(),
  // (Removed: output_root.) Episodes always live in the channel's own folder,
  // so there is no folder to choose. `.strict()` means an old client that
  // still sends the key now gets a 400 rather than having it silently
  // ignored — the honest answer, and the create form never sent it.
  portable: z.boolean().optional(),
  // Accepted only so older clients can still submit a create request. New
  // channels always start on the continuity workflow; changing format is a
  // deliberate post-creation Settings action.
  format_id: z.string().max(60).optional(),
  continuity_mode: z.enum(['character-continuity', 'independent-stills', 'explainer-stills']).optional(),
  // v1.0.79+: optional subject-domain niche (plants, animals, fungi,
  // insects, or user-custom). Orthogonal to format — niche layers
  // vocabulary, visual style, and YouTube tag hints onto whatever
  // format the project picks. Unset = no niche, format defaults
  // apply unchanged. Same length cap as niche route's id validator.
  niche_id: z.string().max(80).optional(),
  // The wizard's explicit Formula choice (owner ruling, 2026-10-25). Sending
  // nothing keeps the pre-ruling behaviour for old clients; the wizard always
  // sends one of the two so "chose generic" and "never chose" stay distinct.
  formula_choice: z.enum(['selected', 'generic']).optional(),
  topic_pack_ids: z.array(z.string().min(1).max(200)).max(24).optional(),
  // Audience-facing language. Absent keeps legacy prompts byte-identical;
  // the two-value catalogue is deliberate (extend when a third language is
  // actually needed).
  content_language: z.enum(['en', 'km']).optional(),
  // Future-only automatic introductions. Absent = OFF.
  auto_introduction_enabled: z.boolean().optional(),
}).strict()
export type CreateProjectBody = z.infer<typeof CreateProjectSchema>

export const UpdateProjectSchema = z.object({
  // Same rationale as CreateProjectSchema — drop .min(1) on the optional
  // string fields. The Settings → Project form's reactive v-model binds
  // straight to projectForm.* and a user clearing any of these sends ''.
  name: z.string().max(120).optional(),
  episode_prefix: z.string().max(10).optional(),
  episode_digits: z.number().int().min(1).max(8).optional(),
  season_size: z.number().int().min(1).max(1000).optional(),
  season_prefix: z.string().max(40).optional(),
  folder_template: z.string().optional(),
  subfolder_names: z.record(z.string(), z.string()).optional(),
  // (Removed: output_root.) See CreateProjectSchema above.
  portable: z.boolean().optional(),
  youtube_channel_url: z.string().optional(),
  // Format primitive (Phase 1): selects the base format profile this project
  // generates against. Empty string clears back to the default. The override
  // payload is intentionally permissive (any-typed) — DeepPartial<Format> is
  // structurally too rich to model in zod without duplicating the type tree;
  // format-loader.ts validates merge results, and the override editor UI
  // controls the legal field set.
  format_id: z.string().max(80).optional(),
  continuity_mode: z.enum(['character-continuity', 'independent-stills', 'explainer-stills']).optional(),
  format_overrides: z.any().optional(),
  // v1.0.270 — 'freeform' makes the format drive visuals only; idea + script
  // use neutral prompts. Empty/absent = 'format' (current behavior).
  content_mode: z.enum(['format', 'freeform']).optional(),
  // Audience-facing language. `null` is the explicit "clear back to legacy"
  // sentinel (undefined is omitted by the save path, so it cannot clear).
  content_language: z.enum(['en', 'km']).nullable().optional(),
  // Future-only automatic introductions. false turns it off deliberately.
  auto_introduction_enabled: z.boolean().optional(),
  // Level B (opt-in) external media root — a portable ${NAME} token or absolute
  // path. Empty string clears it (back to everything under the episodes folder).
  media_root: z.string().max(512).optional(),
  // The owner's own labels for a channel ("Khmer", "Sleep", "History"), so the
  // start page can search, filter and sort by what a channel is. Trimmed and
  // case-insensitively de-duplicated at the boundary (first spelling kept) by
  // the shared normaliser; `[]` clears them.
  //
  // A blank entry is DROPPED rather than refused — there is one thing an empty
  // label can mean, so repairing it silently is not a decision taken on the
  // owner's behalf. The ceilings REFUSE, because a label that is too long has
  // more than one reasonable answer (shorten it? split it? drop it?) and none
  // of them is ours to pick.
  labels: z.array(
    z.string().trim().max(
      MAX_PROJECT_LABEL_LENGTH,
      `a label can be at most ${MAX_PROJECT_LABEL_LENGTH} characters`,
    ),
  ).max(
    MAX_PROJECT_LABELS,
    `a channel can have at most ${MAX_PROJECT_LABELS} labels`,
  ).transform(normalizeProjectLabels).optional(),
  // The Facebook / Instagram / TikTok accounts this channel posts with. The ids
  // are platform identities, validated against the connection registry by the
  // social route — this schema only refuses shapes the registry can never hold.
  social_accounts: z.object({
    facebook: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    instagram: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    tiktok: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  }).optional(),
  // The platforms this channel posts to by default. `[]` is a real answer: post
  // nowhere. Absent means the owner has not chosen yet, which posts nowhere too.
  social_platforms: z.array(z.enum(['facebook', 'instagram', 'tiktok'])).max(3).optional(),
}).strict()
export type UpdateProjectBody = z.infer<typeof UpdateProjectSchema>

// ── Niche primitive (subject-domain layer, orthogonal to Format) ───────────

const NicheReferenceImageSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
  path: z.string().min(1).max(2000),
  role: z.enum(['master', 'character', 'scene']),
  description: z.string().max(500).optional(),
}).strict()

const NicheVocabularySchema = z.object({
  mood: z.array(z.string().min(1).max(80)).max(50).optional(),
  theme: z.array(z.string().min(1).max(80)).max(50).optional(),
  genre: z.array(z.string().min(1).max(80)).max(50).optional(),
  keyword: z.array(z.string().min(1).max(80)).max(100).optional(),
}).strict()

const NicheThumbnailProfileSchema = z.object({
  layout: z.enum(['hero', 'annotated-collage']).optional(),
  conceptGuidance: z.string().max(3000).optional(),
  compositionRules: z.array(z.string().min(1).max(500)).max(20).optional(),
  moodKeywords: z.array(z.string().min(1).max(80)).max(20).optional(),
  avoid: z.array(z.string().min(1).max(300)).max(30).optional(),
  defaultTextStyle: z.string().min(1).max(80).optional(),
  defaultFontStyle: z.string().min(1).max(80).optional(),
}).strict()

const NicheMetadataProfileSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  descriptionSectionIds: z.array(z.string().min(1).max(80)).min(1).max(20),
  titleMode: z.enum(['use_idea_title', 'paraphrase']),
  descriptionMaxChars: z.number().int().min(200).max(5000),
  titleMaxLength: z.number().int().min(20).max(200),
  tagCount: z.number().int().min(1).max(50),
}).strict()

const IdeaAxisSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(120),
  values: z.array(z.string().min(1).max(160)).min(1).max(300),
}).strict()

const FormulaIntroDefaultsSchema = z.object({
  wordTarget: z.number().int().min(50).max(600).optional(),
  beats: z.array(z.union([
    z.string().min(1).max(300),
    z.object({ id: z.string().min(1).max(120), custom_text: z.string().min(1).max(1000).optional() }).strict(),
  ])).min(1).max(20).optional(),
  exampleText: z.string().min(1).max(3000).optional(),
}).strict()
const FormulaScriptStructureSchema = z.object({
  defaultChapterCount: z.number().int().min(1).max(100),
  chapterCountRange: z.tuple([z.number().int().min(1).max(100), z.number().int().min(1).max(100)]),
  defaultLengthMinutes: z.number().int().min(1).max(600),
  lengthMinutesRange: z.tuple([z.number().int().min(1).max(600), z.number().int().min(1).max(600)]),
  /** 1.4.369 — seconds-precision length; supersedes the minutes pair. */
  defaultLengthSeconds: z.number().int().min(1).max(3600).optional(),
  lengthSecondsRange: z.tuple([z.number().int().min(1).max(3600), z.number().int().min(1).max(3600)]).optional(),
  randomizeLength: z.boolean().optional(),
  durationPresets: z.array(z.number().int().min(1).max(600)).min(1).max(20),
  defaultWordsPerMinute: z.number().int().min(50).max(300),
  chaptersIndependent: z.boolean(),
  visualPacingProfile: z.object({
    opening_duration_sec: z.number().int().min(0).max(3600),
    opening: z.object({ min_sec: z.number().int().positive(), max_sec: z.number().int().positive() }).strict(),
    settled: z.object({ min_sec: z.number().int().positive(), max_sec: z.number().int().positive() }).strict(),
  }).strict().optional(),
  motionProfileId: z.string().min(1).max(120).optional(),
  pacingArc: z.array(z.string().min(1).max(1200)).max(100).optional(),
  additionalRules: z.array(z.string().min(1).max(1200)).max(100).optional(),
}).strict()
const FormulaRecencyAvoidanceSchema = z.object({
  strategyId: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
  extractPatterns: z.array(z.string().min(1)).min(1),
  defaultLookback: z.number().int().min(1).max(1000).optional(),
  instructionTemplate: z.string().min(1),
  scopes: z.array(z.enum(['script', 'titles', 'image_prompts', 'metadata'])).min(1).max(4).optional(),
}).strict()

const FormulaEpisodeProfileSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(800),
  ideaAxisValue: z.string().min(1).max(160),
  titleSuffix: z.string().min(1).max(160).optional(),
  forbiddenTitleSuffixes: z.array(z.string().min(1).max(160)).max(20).optional(),
  narratorStyleId: z.string().min(1).max(120).optional(),
  titlePolicy: z.string().min(1).max(800).optional(),
  thumbnailPolicy: z.string().min(1).max(800).optional(),
  metadataPolicy: z.string().min(1).max(800).optional(),
  introDefaults: FormulaIntroDefaultsSchema.optional(),
  scriptStructure: FormulaScriptStructureSchema.optional(),
  recencyAvoidance: FormulaRecencyAvoidanceSchema.optional(),
  ideaSystemPromptRole: z.string().min(1).optional(),
  ideaGuidanceText: z.string().min(1).optional(),
  scriptContext: z.string().min(1).optional(),
  scriptSystemPromptRole: z.string().min(1).optional(),
  scriptClosingHint: z.string().min(1).optional(),
}).strict()

const FormulaProductionKitSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  episodeProfiles: z.array(FormulaEpisodeProfileSchema).max(20).optional(),
}).strict()

/** Body for POST /niches and PUT /niches/:id (full-document replace). */
/**
 * The episode shape of a Series Formula — the only part of a Formula the owner
 * edits by hand, and the reason this is a PATCH rather than a field on
 * `NicheSchema`.
 *
 * `NicheSchema` is `.strict()` and describes about a third of a real Formula:
 * it has no `scriptStructure`, no `narratorStyles`, no `titleShapeRules`, no
 * `pacingArc`. `PUT /niches/:id` parses a whole document through it and saves
 * `parsed.data`, so a built-in Formula cannot survive that route — it is
 * rejected for carrying keys the schema does not list, and had it been
 * accepted, everything unlisted would have been dropped from the fork. That is
 * why nothing has ever called it for a built-in.
 *
 * Widening `NicheSchema` to the full document would mean keeping two
 * descriptions of a large, growing shape in step forever, and the day they
 * drift is the day an edit quietly deletes a pacing arc. So the edit path is a
 * MERGE of a small, closed patch instead: whatever this schema does not
 * mention is not touched, by construction rather than by care.
 */
export const EpisodeShapePatchSchema = z.object({
  defaultChapterCount: z.number().int().min(1).max(100),
  chapterCountRange: z.tuple([z.number().int().min(1).max(100), z.number().int().min(1).max(100)]),
  defaultLengthMinutes: z.number().int().min(1).max(600),
  lengthMinutesRange: z.tuple([z.number().int().min(1).max(600), z.number().int().min(1).max(600)]),
  defaultWordsPerMinute: z.number().int().min(50).max(300),
  chaptersIndependent: z.boolean(),
  /** Empty string clears it, so the Formula falls back to the Format's tone. */
  metadataTitleStyleHint: z.string().max(1000),
}).strict()
  .refine(v => v.chapterCountRange[0] <= v.chapterCountRange[1],
    { message: 'The smallest chapter count must not be larger than the largest', path: ['chapterCountRange'] })
  .refine(v => v.lengthMinutesRange[0] <= v.lengthMinutesRange[1],
    { message: 'The shortest episode must not be longer than the longest', path: ['lengthMinutesRange'] })
  // A default outside its own range is the bug that produced the thing this
  // whole feature exists to fix: a shared 8-minute default sitting under a
  // 3-20 minute ceiling, so a two-hour sleep story could not even be asked for.
  .refine(v => v.defaultChapterCount >= v.chapterCountRange[0] && v.defaultChapterCount <= v.chapterCountRange[1],
    { message: 'The usual chapter count must sit inside the smallest and largest', path: ['defaultChapterCount'] })
  .refine(v => v.defaultLengthMinutes >= v.lengthMinutesRange[0] && v.defaultLengthMinutes <= v.lengthMinutesRange[1],
    { message: 'The usual length must sit inside the shortest and longest', path: ['defaultLengthMinutes'] })
export type EpisodeShapePatch = z.infer<typeof EpisodeShapePatchSchema>

export const NicheSchema = z.object({
  id: z.string()
    .min(1, 'id is required')
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id must be a slug: lowercase letters, digits, dashes, underscores'),
  name: z.string().min(1, 'name is required').max(120),
  description: z.string().min(1).max(1500),
  builtin: z.boolean().optional(),  // user-custom JSONs may omit; loader defaults false
  schemaVersion: z.literal(1),
  kind: z.literal('series-formula').optional(),
  formulaFamily: z.string().min(1).max(80).optional(),
  catalogStatus: z.enum(['active', 'legacy']).optional(),
  successorFormulaId: z.string().min(1).max(80).optional(),
  catalogName: z.string().min(1).max(120).optional(),
  perspectivePolicy: z.string().min(1).max(1200).optional(),
  narrativeQualityContract: z.object({
    openingPolicy: z.string().min(1).max(1200),
    forbiddenPatterns: z.array(z.string().min(1).max(500)).min(1).max(30),
    requiredHabits: z.array(z.string().min(1).max(500)).min(1).max(30),
    closingPolicy: z.string().min(1).max(1200).optional(),
  }).strict().optional(),
  openingProfile: z.object({
    id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
  }).strict().optional(),
  metadataProfile: NicheMetadataProfileSchema.optional(),
  productionKit: FormulaProductionKitSchema.optional(),
  tagline: z.string().max(200).optional(),
  exampleTopics: z.array(z.string().min(1).max(200)).max(200),
  defaultTopicPackIds: z.array(z.string().min(1).max(80)).max(24).optional(),
  compatibleTopicPackIds: z.array(z.string().min(1).max(80)).max(100).optional(),
  ideaAxes: z.array(IdeaAxisSchema).max(20).optional(),
  vocabulary: NicheVocabularySchema.optional(),
  visualStyleSheet: z.string().max(3000).optional(),
  thumbnailStyleSheet: z.string().max(3000).optional(),
  thumbnailProfile: NicheThumbnailProfileSchema.optional(),
  defaultStyleKeywords: z.array(z.string().min(1).max(120)).max(40).optional(),
  /** Suggestions only — never applied to a project without an explicit click. */
  recommendedVisualStyleIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  referenceImages: z.array(NicheReferenceImageSchema).max(50).optional(),
  youtubeTagsHint: z.array(z.string().min(1).max(60)).max(40).optional(),
  audienceHint: z.string().max(400).optional(),
  scriptContext: z.string().max(2000).optional(),
}).strict()
export type NicheBody = z.infer<typeof NicheSchema>

export const TopicPackSchema = z.object({
  id: z.string()
    .min(1, 'id is required')
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id must be a slug: lowercase letters, digits, dashes, underscores'),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1500),
  builtin: z.boolean().optional(),
  schemaVersion: z.literal(1),
  tagline: z.string().max(200).optional(),
  compatibleNicheIds: z.array(z.string().min(1).max(80)).max(100),
  compatibleFormulaIds: z.array(z.string().min(1).max(80)).max(100).optional(),
  subjects: z.array(z.string().min(1).max(200)).min(1).max(1000),
  ideaAxes: z.array(IdeaAxisSchema).max(20).optional(),
  exampleTopics: z.array(z.string().min(1).max(200)).max(200).optional(),
  promptContext: z.string().max(3000).optional(),
  vocabulary: NicheVocabularySchema.optional(),
  youtubeTagsHint: z.array(z.string().min(1).max(60)).max(80).optional(),
  tags: z.array(z.string().min(1).max(60)).max(80).optional(),
}).strict()
export type TopicPackBody = z.infer<typeof TopicPackSchema>

/** Body for PUT /projects/:slug/niche. `null` clears the association. */
export const SetProjectNicheSchema = z.object({
  niche_id: z.string().max(80).nullable(),
  // `'generic'` records a deliberate "Generic — no Formula" choice, which is
  // what stops the in-app prompt. A selected id records `'selected'` itself.
  formula_choice: z.enum(['selected', 'generic']).optional(),
  topic_pack_ids: z.array(z.string().min(1).max(200)).max(24).optional(),
}).strict()
export type SetProjectNicheBody = z.infer<typeof SetProjectNicheSchema>

/**
 * Shape of `GET /projects/:slug` — the project metadata the backend returns.
 * Keep in sync with `ProjectMeta` in `electron/server/models/types.ts` —
 * that module is the source of truth for the on-disk JSON shape.
 */
export interface ProjectMetaResponse {
  name: string
  slug: string
  episode_prefix: string
  episode_digits: number
  season_size: number
  season_prefix: string
  folder_template: string
  subfolder_names: Record<string, string>
  created_at: string
  /**
   * COMPUTED by `GET /projects/:slug`, not stored: the ABSOLUTE path to this
   * channel's episodes folder (`<projectDir>/episodes`).
   *
   * Declared here because the route has always returned it and the frontend
   * had to reach for it through an `as any` cast — which is how every
   * `${PROJECT}` call site ended up passing the RELATIVE `output_root` field
   * instead and silently never resolving. Undeclared response fields are how
   * the wrong one gets picked.
   */
  output_root_resolved?: string
  /** COMPUTED: whether that folder exists on disk right now. `false` is an
   *  accusation the UI must show, never repair by creating the folder. */
  output_root_exists?: boolean
  project_id?: string
  format_id?: string
  niche_id?: string
  /** 'selected' / 'generic' once the customer chose; absent = never chose. */
  formula_choice?: 'selected' | 'generic'
  topic_pack_ids?: string[]
  content_pack_versions?: Record<string, string>
  content_pack_items?: Record<string, {
    pack_id: string
    kind: 'series-formula' | 'topic-pack' | 'visual-style' | 'thumbnail-recipe'
      | 'subtitle-style' | 'scene-effect' | 'overlay'
  }>
  continuity_mode?: 'character-continuity' | 'independent-stills' | 'explainer-stills'
  /** Audience-facing language for generated text. Absent = legacy prompts. */
  content_language?: 'en' | 'km' | null
  /** Future-only automatic introductions; absent = OFF. */
  auto_introduction_enabled?: boolean
}

/** Shape of `GET /projects` — list view summary, never includes keys. */
export interface ProjectSummaryResponse {
  name: string
  slug: string
  episode_prefix: string
  created_at: string
  has_api_keys: boolean
  /** v1.0.302 — raw configured format id; the home page maps it to a label. */
  format_id?: string
}

// ── Settings ────────────────────────────────────────────────────────────────

export const UpdateApiKeysSchema = z.object({
  kie_api_key: z.string().optional(),
  fal_api_key: z.string().optional(),
  openai_api_key: z.string().optional(),
  anthropic_api_key: z.string().optional(),
  genaipro_api_key: z.string().optional(),
  elevenlabs_api_key: z.string().optional(),
  google_api_key: z.string().optional(),
}).strict()
export type UpdateApiKeysBody = z.infer<typeof UpdateApiKeysSchema>

// ── Accounts (multi-key per provider, Delivery 2) ───────────────────────────

export const AddAccountSchema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(100),
  apiKey: z.string().trim().min(1, 'API key is required'),
}).strict()
export type AddAccountBody = z.infer<typeof AddAccountSchema>

export const UpdateAccountSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  apiKey: z.string().trim().min(1).optional(),
}).strict()
export type UpdateAccountBody = z.infer<typeof UpdateAccountSchema>

export interface AccountSummaryResponse {
  id: string
  label: string
  isDefault: boolean
  /** First 4 + last 4 of the key, never the raw value. */
  keyMasked: string
}

// updateConfig passes through dozens of user-settable fields (presets,
// templates, custom_* autocomplete pools). Keep the schema permissive so
// we reject obviously-wrong shapes without maintaining a growing denylist.
export const UpdateConfigSchema = z.object({
  image_models: z.record(z.string(), z.any()).optional(),
  voice_presets: z.array(z.any()).optional(),
  contextual_cues_presets: z.array(z.object({
    data: z.object({ min_gap_sec: z.number().min(1, 'Minimum label gap must be between 1 and 600 seconds').max(600, 'Minimum label gap must be between 1 and 600 seconds').optional() }).passthrough(),
  }).passthrough()).optional(),
  style_presets: z.array(z.any()).optional(),
  active_style_preset_id: z.string().max(200).optional(),
  /**
   * 2026-10-31 — this channel's name as a saved starting point for a NEW channel
   * (owner, 2026-10-31). Empty clears the marker; the name is what the card
   * in the create screen shows. Bounded so a runaway value cannot reach disk.
   */
  channel_default_name: z.string().max(80).optional(),
  confirmation_preferences: z.record(z.string(), z.any()).optional(),
  /** 1.4.300 — per-channel Off / Warn / Block for each safety check (services/safety-checks.ts). */
  safety_checks: z.record(z.string().max(80), z.enum(['off', 'warn', 'block'])).optional(),
  auto_upload: z.enum(['off', 'private', 'scheduled']).optional(),
  shorts_per_episode: z.number().int().min(0).max(3).optional(),
  /**
   * 1.4.369 — the channel's per-episode starting length. A shape that is not
   * whole seconds, or whose bounds cross, is refused rather than stored and
   * quietly ignored by the reader (§6).
   */
  episode_length: z.object({
    mode: z.enum(['random', 'fixed']),
    min_sec: z.number().int().min(1).max(3600),
    max_sec: z.number().int().min(1).max(3600),
    fixed_sec: z.number().int().min(1).max(3600),
  }).strict().refine(v => v.max_sec >= v.min_sec, {
    message: 'the longest episode must not be shorter than the shortest',
    path: ['max_sec'],
  }).optional(),
  audio_quality: z.object({
    mode: z.enum(['off', 'flag_issues', 'check_and_repair']),
    alternate_transcription_model: z.string().trim().min(1).max(240).optional(),
  }).optional(),
  /** 1.4.364 — the free scene-image quality check (owner 2026-10-26). */
  scene_image_check: z.object({
    enabled: z.boolean().optional(),
    auto_remake: z.boolean().optional(),
    shadow_until: z.string().optional(),
    model: z.string().trim().max(240).optional(),
    /**
     * The OPT-IN stronger check (owner 2026-10-27). A sub-object because it is
     * a second, independent check with its own model and its own switches —
     * folding its fields in beside the free check's would make "which model"
     * ambiguous on the one screen that shows both.
     *
     * Only the SELECTION is stored (the catalogue id). Limits, prices,
     * capabilities and provider are read live from the catalogue on every use
     * (AGENTS.md §1).
     */
    vision: z.object({
      enabled: z.boolean().optional(),
      model: z.string().trim().max(240).optional(),
      auto_remake: z.object({
        anatomy: z.boolean().optional(),
        face: z.boolean().optional(),
        text: z.boolean().optional(),
      }).optional(),
    }).optional(),
  }).optional(),
  /**
   * 1.4.374 — thumbnail scoring (owner, 2026-11-01). The channel's switch and
   * its selection of a free, vision-capable Gateway chat product. Only the
   * SELECTION is stored: the capability, price and limits behind it are read
   * live from the catalogue on every run (AGENTS.md §1).
   */
  thumbnail_auto_pick: z.object({
    enabled: z.boolean().optional(),
    model: z.string().trim().max(240).optional(),
  }).optional(),
}).passthrough().transform((value) => {
  // Legacy Story Studio releases persisted a project-owned TTS catalog. Keep
  // accepting those payloads so old clients can save unrelated settings, but
  // never let an audio_models map become executable routing configuration.
  // GenStudio is now the sole voice catalog and TTS execution boundary.
  const current = { ...value }
  // The retired LLM lineup (2026-10-03) and its one-time migration record are
  // Story Studio's own; an older client can no longer write either. The saved
  // lineup stays on disk untouched.
  delete current.llm_lineup
  delete current.llm_lineup_migration
  delete current.audio_models
  delete current.audio_concurrency
  delete current.video_concurrency
  delete current.image_concurrency
  delete current.subtitle_concurrency
  delete current.image_launch_stagger_ms
  delete current.audio_launch_stagger_ms
  delete current.video_launch_stagger_ms
  delete current.generation_timeouts
  return current
})
export type UpdateConfigBody = z.infer<typeof UpdateConfigSchema>

/**
 * One SAVED STARTING POINT, as `GET /projects/channel-defaults` returns it —
 * a channel the owner named so a NEW channel can start from it
 * (owner, 2026-10-31: *"as we can have several defaults to choose from"*).
 *
 * Every field describes the source channel as it is RIGHT NOW: the list is
 * read live from the channels, never cached, so a Formula or art style
 * changed since the channel was marked shows its current value here.
 *
 * `art_style_preview` is always an app-served URL or '' — never a file path,
 * so nothing outside this app's own routes reaches the renderer.
 */
export interface ChannelDefaultSummary {
  /** The name the owner gave this starting point. */
  name: string
  /** The channel a copy made from here would be started from. */
  source_slug: string
  /** The source channel's own name, so a card says which channel it is. */
  source_name: string
  /** The source channel's Series Formula, by the name installed on this Mac. */
  formula_name: string
  /** The source channel's art style, by name. '' when it names none. */
  art_style_name: string
  /** The art style's preview picture, when it has one. '' when it has none. */
  art_style_preview: string
}

/**
 * Shape of `GET /projects/:slug/settings/config` — the "safe" config with
 * API keys replaced by `has_*` booleans. The server strips secrets before
 * serving; never add a `*_api_key` field here.
 */
export interface SafeProjectConfigResponse {
  llm_lineup_migration?: import('../models/types.js').LlmLineupMigration
  has_genstudio_key: boolean
  /**
   * Multi-account listing keyed by provider id. Added in Delivery 2; the
   * `has_*_key` booleans above are still populated (from the default account
   * per provider) for any frontend view that hasn't migrated yet.
   */
  accounts?: Record<string, AccountSummaryResponse[]>
  audio_quality?: {
    mode: 'off' | 'flag_issues' | 'check_and_repair'
    alternate_transcription_model?: string
  }
  /**
   * 1.4.369 — the channel's per-episode starting length (Quote Shorts: draw
   * each new episode's length inside 10–60 s). Absent means "read the live
   * Formula", which is how every channel created before this setting behaves.
   */
  episode_length?: {
    mode: 'random' | 'fixed'
    min_sec: number
    max_sec: number
    fixed_sec: number
  }
  /** 1.4.364 — the free scene-image quality check's switch and shadow end date. */
  scene_image_check?: {
    enabled?: boolean
    auto_remake?: boolean
    shadow_until?: string
    model?: string
    /** The opt-in stronger check's selection and per-axis switches (owner 2026-10-27). */
    vision?: {
      enabled?: boolean
      model?: string
      auto_remake?: { anatomy?: boolean; face?: boolean; text?: boolean }
    }
  }
  /**
   * 1.4.374 — thumbnail scoring (owner, 2026-11-01): the channel's switch and
   * its selection of a free, vision-capable Gateway chat product. Only the
   * SELECTION is stored; every capability behind it is read live (§1).
   */
  thumbnail_auto_pick?: {
    enabled?: boolean
    model?: string
  }
  image_models: Record<string, any>
  voice_presets: Array<{
    name: string
    voice_id: string
    /**
     * Narrowed to the gateway on the way out (publicVoicePresets). Stored
     * presets still carry pre-v1.0.669 transport keys; the wire does not.
     */
    providers: Array<'genstudio'>
  }>
  style_presets?: Array<{
    id: string
    name: string
    description: string
    source_model?: string
    source_reference?: string
    created_at: string
    preview_filename?: string
    preview_files?: string[]
    preview_model?: string
    preview_aspect_ratio?: string
    preview_tier?: string
    preview_saved_at?: string
  }>
  /** v1.0.518 — id of the active art style (see ProjectConfig.active_style_preset_id). */
  active_style_preset_id?: string
  audio_models: Record<string, any>
  image_pricing_last_updated: string
  audio_pricing_last_updated: string
  confirmation_preferences?: Record<string, boolean>
  /**
   * v1.4.1 — per-EPISODE overlay windows, keyed by episode code then layer id.
   * An overlay's LOOK travels in presets; when it appears belongs to one
   * episode's runtime and is stored here so it can never ride along.
   */
  overlay_time_ranges?: Record<string, Record<string, { start_s: number; end_s: number | null }>>
  /** @deprecated v1.0.150 — Chatterbox provider removed; field retained so old project.json parses. */
  chatterbox_enabled?: boolean
  /** @deprecated v1.0.150 — see chatterbox_enabled. */
  chatterbox_reference_id?: string
}

// Standards accepts either { content: string } or a raw string body.
export const UpdateStandardsSchema = z.union([
  z.object({ content: z.string() }).strict(),
  z.string(),
])

// ── Jobs / generation ───────────────────────────────────────────────────────

const EpisodeId = z.string().min(1).max(40)

export const GenerateScriptOnlySchema = z.object({
  episode_id: EpisodeId,
  title: z.string().min(1).max(300),
  length: z.number().positive().optional(),
  model: z.string().min(1),
  style: z.string().optional(),
  chapters: z.number().int().positive().optional(),
  total_words: z.number().int().positive().optional(),
  words_per_chapter: z.number().int().positive().optional(),
  // Character primitive (Phase 5): optional cast list — the LLM uses
  // these names + descriptions instead of inventing characters.
  character_ids: z.array(z.string().min(1).max(120)).optional(),
  // v1.0.297 — optional free-text producer guidance injected into the outline
  // + chapter prompts (ad-hoc names, setting, names to avoid). Capped so a
  // runaway paste can't blow the prompt budget.
  manual_guidance: z.string().max(2000).optional(),
  // 1.4.359 — the channel's "Chapters per request" setting for script
  // expansion. 0 / absent = this format's own default (3 narrative, 8
  // listicle), so a caller that never sets it behaves exactly as before.
  chapters_per_request: z.number().int().min(0).max(10).optional(),
  chapter_batch_mode: z.enum(['count', 'length']).optional(),
  chapter_batch_words: z.number().int().min(0).max(100_000).optional(),
}).passthrough()
export type GenerateScriptOnlyBody = z.infer<typeof GenerateScriptOnlySchema>

// v1.4.73 — `title` and `model` became optional, and the recipe fields became
// vestigial.
//
// The Introduction page asks for an opening by naming an episode and nothing
// else: HOW the channel opens is a channel setting the server reads, and WHICH
// model writes it is the model already chosen for the script. A caller that
// had to supply either could supply a different one, which is precisely how a
// batch and a button ended up writing different openings.
//
// The recipe fields are still accepted so an existing integration keeps
// working; supplying one overrides the channel's own value for that one run.
// The server never invents a model — it refuses and says so.
export const GenerateIntroductionOnlySchema = z.object({
  /** Explicit one-run form snapshot; never changes channel defaults. */
  introduction_recipe: z.object({
    host_name: z.string(), word_target: z.number().int().min(50).max(600),
    custom_opening_line: z.string(), model: z.string(),
    beats: z.array(z.object({ id: z.string(), label: z.string(), enabled: z.boolean(), custom_text: z.string().optional(), choice: z.string().optional() })),
    tone: z.enum(['friendly', 'curious', 'documentary', 'calm']).optional(),
    length: z.enum(['short', 'standard', 'extended']).optional(),
    starting_style: z.string().optional(),
  }).optional(),
  episode_id: EpisodeId,
  title: z.string().max(300).optional(),
  model: z.string().optional(),
  host_name: z.string().optional(),
  word_target: z.number().int().positive().optional(),
  custom_opening: z.string().optional(),
  beats: z.array(z.string()).optional(),
  /** Set only by the Scripts page's post-outline tail. The server then
   *  requires the episode's frozen `intro_eligible` fact; manual calls omit it. */
  automatic: z.boolean().optional(),
}).passthrough()
export type GenerateIntroductionOnlyBody = z.infer<typeof GenerateIntroductionOnlySchema>

// Targeted regenerate of a single chapter. Same shape as GenerateScriptOnly
// (so the existing form's settings come along: style, length, model, etc.)
// plus a required chapter_number naming the one chapter to refresh. Other
// chapters on disk are left untouched; the unified narration_docx is
// re-assembled from all sources after the regen lands.
export const GenerateChapterOnlySchema = z.object({
  episode_id: EpisodeId,
  title: z.string().min(1).max(300),
  length: z.number().positive().optional(),
  model: z.string().min(1),
  style: z.string().optional(),
  chapters: z.number().int().positive().optional(),
  total_words: z.number().int().positive().optional(),
  words_per_chapter: z.number().int().positive().optional(),
  chapter_number: z.number().int().min(1).max(99),
}).passthrough()
export type GenerateChapterOnlyBody = z.infer<typeof GenerateChapterOnlySchema>

export const TranslateEpisodeSchema = z.object({
  target_slug: z.string().min(1, 'target_slug is required').max(120),
  model: z.string().min(1, 'model is required'),
  target_episode_id: EpisodeId.optional(),
  target_title: z.string().max(300).optional(),
  reuse_visuals: z.boolean().optional(),
  chapters: z.array(z.number().int().min(1)).optional(),
}).strict()
export type TranslateEpisodeBody = z.infer<typeof TranslateEpisodeSchema>

export const GenerateImagesSchema = z.object({
  episode_id: EpisodeId,
  /**
   * Optional, and allowed to be blank (2026-10-25).
   *
   * It was `z.string().min(1)`, so a Thumbnail Generator request that named no
   * model was refused by the schema with a field error — never with the one
   * sentence that helps: choose a model. The route now resolves the channel's
   * saved Thumbnail Generator preset (AGENTS §7) and refuses in plain words when
   * neither the request nor the preset names one, before any job row exists.
   * Nothing reaches the provider without a model: `requestedImageModelName()`
   * still refuses an empty one at the generator.
   */
  model: z.string().optional(),
  mode: z.enum(['scenes', 'thumbs']).optional(),
  // Same defensive pattern as elsewhere — '' = "use generator default
  // (typically 16:9)" rather than a 400. Empty isn't sent today by the
  // current Image Generator UI but keeping the schema tolerant means
  // future entry points (CLI / API integrations / other surfaces) can
  // omit the field cleanly.
  aspect_ratio: z.string().optional(),
  scene_number: z.number().int().nonnegative().optional(),
  thumb_number: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
  // v1.0.416 — optional extra guidance appended to the thumbnail prompt at
  // RENDER time (Thumbnail Generator tab). Lets the user nudge a render
  // ("push the subject closer, bigger title") without the prompt-reprompt
  // round-trip. Applies to thumbnails only.
  extra_details: z.string().max(2000).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
}).passthrough()
export type GenerateImagesBody = z.infer<typeof GenerateImagesSchema>

export const GenerateAudioSchema = z.object({
  episode_id: EpisodeId,
  model: z.string().min(1),
  voice: z.string().optional(),
  sections: z.string().optional(),
  speed: z.number().optional(),
  /**
   * Values for the SELECTED model's published `controls[]`, keyed by the name
   * GenStudio published. Deliberately an open record: which controls exist,
   * what they are called, and what they accept are catalogue facts, so nothing
   * here may name or bound one. The generator resolves this map against the
   * live model row before anything is sent — an unpublished name is dropped
   * and an out-of-range value is clamped there, not here.
   */
  controls: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
  /**
   * How the words should be read (owner, 2026-10-29). Accepted without a length
   * bound HERE on purpose: whether the selected model takes an instruction, and
   * how long it may be, is a fact its catalogue row publishes, so the limit is
   * applied against the live row in the generator (lib/tts-controls.ts) rather
   * than restated as a constant in this schema.
   */
  delivery_instruction: z.string().optional(),
  force: z.boolean().optional(),
  no_overwrite: z.boolean().optional(),
  /** Re-narrate from a subtitle gap: re-make the chapter's subtitles once its new narration is saved. */
  then_subtitles: z.boolean().optional(),
}).passthrough().transform((value) => {
  // Retired request/preset field. Accept old clients without breaking their
  // jobs, but discard the override before it reaches a queue or provider.
  // TTS splitting is owned exclusively by the active model inventory.
  const current = { ...value }
  delete current.max_chunk_chars
  // Removed 2026-10: expression markup and auto-pacing. Old presets may still carry them.
  delete current.use_expression
  delete current.fish_autopace
  delete current.expression_model
  return current
})
export type GenerateAudioBody = z.infer<typeof GenerateAudioSchema>

export interface JobControlResponse {
  action: 'cancel-before-submit' | 'stop-local' | 'request-remote-cancel' | 'pause-submissions' | 'return-later' | 'clear-history' | 'recheck-provider-status' | 'force-abandon' | 'none'
  enabled: boolean
  label: string
  reason: string
  code: 'READY' | 'PROVIDER_WORK_ALREADY_STARTED' | 'CANCELLATION_STATUS_UNKNOWN' | 'REMOTE_CANCELLATION_NOT_SUPPORTED' | 'JOB_NOT_AT_SAFE_LOCAL_STOP' | 'PROVIDER_STATUS_UNREACHABLE' | 'OWNER_OVERRIDE'
  financial_effect: 'no-provider-request' | 'local-only' | 'remote-result-required' | 'provider-work-may-settle' | 'history-only' | 'none'
  targets?: Array<{
    operation: 'voice.tts' | 'audio.transcription' | 'image.generation' | 'video.generation' | 'chat.response' | 'music.generation'
    provider_job_id: string
  }>
}

export interface JobRemoteCancellationResponse {
  /** `absent` (v1.2.8): GenStudio answered and has no such task — terminal,
   *  and distinct from `unknown`, which is "no answer was obtained". */
  status: 'queued' | 'submitting' | 'requested' | 'reconciling' | 'confirmed' | 'rejected' | 'unknown' | 'absent'
  operation: 'voice.tts' | 'audio.transcription' | 'image.generation' | 'video.generation' | 'chat.response' | 'music.generation'
  provider_job_id: string
  requested_at: string
  updated_at: string
  http_status?: number
  state?: string
  dispatch_state?: 'pre_dispatch' | 'dispatched'
  cancellable?: boolean
  cancelled?: boolean
  cancellation_requested?: boolean
  cancellation_note?: string | null
  failure_code?: string | null
  reserved_credits?: number
  settled_credits?: number
  released_credits?: number
  /**
   * The owner's cancel was asked for every provider task that was still unsettled at that moment
   * (none was left to finish on its own). Provider tasks that had already succeeded before it are
   * finished work the owner keeps, so `succeeded + cancelled` still ends the job `cancelled`.
   */
  covers_outstanding?: boolean
  reconciliation_error?: string
}

/** Response from `POST /projects/:slug/generate/{script,images,audio}`. */
export interface JobEnqueuedResponse {
  job_id: string
  project_slug: string
  type: string
  episode_id: string
  title: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  pause_requested?: boolean
  controls?: JobControlResponse[]
  pause_origin?: 'manual' | 'queue' | 'stall'
  /** Resume was pressed while a pause was still taking effect; the job continues on its own. */
  resume_after_pause?: boolean
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  output_lines: string[]
  content_pack_provenance?: Array<{
    pack_id: string
    version: string
    archive_sha256: string
    item_ids: string[]
  }>
  /** Bounded automatic retry state. `eligible` is true only for work proven
   * to stay on this Mac. */
  auto_retry?: {
    eligible: boolean
    reason: string
    attempt: number
    max_attempts: number
    next_retry_at?: string
    exhausted?: boolean
  }
  /** Server-owned optional paid image recovery authorisation. */
  paid_image_replacement?: {
    enabled: boolean
    wait_minutes: 30
    max_replacements_per_asset: 1
    additional_credit_ceiling: number | null
    snapshotted_at: string
  }
  /** Latest bounded paid-image replacement state, redacted for renderer use. */
  paid_image_replacement_attempt?: {
    state: 'waiting' | 'committed' | 'submitted' | 'succeeded' | 'failed' | 'blocked'
    eligible_at: string
    replacement_committed_at?: string
    quoted_credits?: number
    price_version?: string
    /** Stable customer-safe category; never raw provider or durable evidence. */
    reason?: 'automatic_replacement_unavailable'
    actual_settled_credits?: number
  }
  /** Structured terminal outcome for audit-style jobs such as image repair. */
  result?: Record<string, any>
  params: Record<string, any>
  /** Fresh server classification; never persisted as a stale job field. */
  control?: JobControlResponse
  /** Server-issued replacement identity for an explicit terminal chat Retry. */
  genstudio_chat_retry_scope?: string
  /** A pending chat Retry may only reconcile its existing provider request. */
  genstudio_chat_recovery?: true
  queue_position?: number
  /**
   * Which provider accounts served this job. Keyed by providerId. The
   * resolver populates this live via the SSE `update` stream, so Jobs-page
   * cards can show attribution without a refetch. See `Job.accounts_used`
   * on the server for the canonical shape.
   */
  accounts_used?: Record<string, { id: string; label: string }>
  /**
   * Live streams (`/jobs/stream`, `/jobs/all/stream`, `/jobs/app/stream`) omit `genstudio_jobs`,
   * `params.genstudio_recovery` and `params.scenes`; a page that needs them reads the per-job GET
   * (`useJobDetails`). In their place a streamed job carries these summaries.
   */
  genstudio_jobs_count?: number
  /** The distinct `operation`s among all entries. */
  genstudio_jobs_operations?: string[]
  /** Entries not yet succeeded or failed, without `request`. */
  genstudio_jobs_active?: NonNullable<JobEnqueuedResponse['genstudio_jobs']>
  genstudio_jobs_updated_at?: string
  /** Paid work whose published settlement is not yet complete and balanced. */
  genstudio_settlement_open?: boolean
  genstudio_jobs?: Array<{
    id: string
    request_key?: string
    operation: 'voice.tts' | 'audio.transcription' | 'image.generation' | 'chat.response' | 'music.generation' | 'video.generation'
    state: string
    dispatch_state?: 'pre_dispatch' | 'dispatched'
    model_id?: string
    credit_cost?: number
    /** Provider-stated USD cost of the finished job. Absent means "not stated", never $0. */
    cost_usd?: number
    cost_source?: 'provider'
    remaining_credits?: number
    reserved_credits?: number
    settled_credits?: number
    returned_credits?: number
    price_version?: string | null
    failure_code?: string | null
    failure_class?: string | null
    failure_reason?: string | null
    cancellable?: boolean | null
    cancelled?: boolean | null
    cancellation_requested?: boolean | null
    cancellation_note?: string | null
    released_credits?: number | null
    /** The gateway holds this failed job for adoption (`unknown_outcome`); a result may still arrive. */
    recovery_required?: boolean | null
    recovery_state?: string | null
    /** Running at the gateway but queued or deferred at a Mac. Null once a Mac is rendering. */
    waiting?: { reason: string | null; next_try_at: string | null; since: string | null } | null
    routing_status_code?: string | null
    retry_after_seconds?: number | null
    retry_at?: string | null
    last_provider_progress_at?: string | null
    stall_recovery_at?: string | null
    status_detail?: string | null
    failure_detail?: string | null
    queue_position?: number | null
    queue_eta_seconds?: number | null
    queue_reason?: 'provider_pace' | null
    location?: string
    queue_state?: 'waiting_local' | 'submitting' | 'accepted' | 'waiting_account_capacity'
      | 'running' | 'completing' | 'succeeded' | 'failed' | 'not_created' | 'waiting_credits' | 'cancelled'
    updated_at: string
    /**
     * Redacted preview of the request Story Studio submitted for this call —
     * the Jobs page renders it inside the per-job output expander so a user
     * can read the endpoint, the resolved product, the response_format, the
     * token limits and the actual prompt text behind a failure.
     *
     * Structurally mirrors `GenStudioRequestPreview` in
     * `electron/server/lib/genstudio-request-preview.ts`, which is the ONLY
     * builder for it and which guarantees (a) no credential of any kind can
     * appear here and (b) prompts are truncated with an explicit marker.
     * Declared inline rather than imported so the renderer's type graph never
     * reaches into a Node-only server module.
     */
    request?: {
      method: string
      path: string
      model_id?: string
      response_format?: string
      token_limits?: Record<string, number>
      idempotency_key?: string
      messages?: Array<{ role: string; text: string; length: number; truncated: boolean }>
      fields?: Array<{ label: string; value: string }>
      captured_at: string
    }
  }>
  /** Per-provider-task cancellation evidence keyed by `${operation}:${provider_job_id}`. */
  remote_cancellations?: Record<string, JobRemoteCancellationResponse>
  reconciliation_error?: string
  /** v1.2.6 — outcome of the last provider re-check for a finished job whose
   *  stored evidence was still non-terminal. See `Job.history_evidence_check`. */
  history_evidence_check?: {
    state: 'checking' | 'unreachable' | 'unsettled'
    at: string
    detail?: string
  }
  /** Music tasks the Gateway finished whose songs are not in the library yet. See `Job.music_results_awaiting_import`. */
  music_results_awaiting_import?: string[]
  /** A failed job whose files were all made later — kept as history, no longer needs attention. */
  resolved?: { at: string; reason: string }
  /** This step did not run because the channel's own settings switch it off (AGENTS.md §8). Reads `skipped`. */
  skipped?: { at: string; reason: string }
  /** v1.2.8 — the owner stopped tracking this job without provider confirmation. */
  force_abandoned?: {
    at: string
    unsettled: string[]
  }
  /**
   * Directory containing the job's primary output (audio dir, image dir,
   * video dir, …). Set by each generator on success. Drives the Jobs
   * page's "Open in Finder" button so users can jump to their results
   * without parsing the output_lines log. Optional for backwards-compat:
   * jobs persisted before this field shipped won't have it; the frontend
   * falls back to extracting a path from output_lines for those.
   */
  output_dir?: string
  /** Percentage 0-100 — set by generators that report progress (uploads,
   *  long-running encodes). UI renders a progress bar when present. */
  progress?: number
  /**
   * Live per-item state for list-shaped jobs (audio sections today). Streams
   * on the same SSE `update` events as `progress`, so a card can name the item
   * in flight, show `completed / total`, and say when an item is sitting out a
   * provider rate-limit wait instead of leaving a spinner to imply a hang.
   *
   * Structurally mirrors `JobItemProgress` in `electron/server/models/types.ts`
   * — declared inline for the same reason `genstudio_jobs[].request` is, so the
   * renderer's type graph never reaches into a Node-only server module.
   */
  item_progress?: {
    total: number
    completed: number
    failed: number
    settling?: number
    cancelled?: number
    not_submitted?: number
    concurrency: number
    active: Array<{
      label: string
      key?: string
      state: 'running' | 'waiting_retry'
      attempt: number
      max_attempts: number
      retry_at?: string
      reason?: string
    }>
  }
  /** Live bytes-transferred metric for jobs that move data (YouTube
   *  uploads, asset downloads). All four fields are optional and additive —
   *  pre-existing rehydrated jobs from before they shipped won't have them,
   *  and jobs that don't transfer anything leave them undefined. */
  bytes_done?: number
  bytes_total?: number
  speed_bps?: number
  eta_seconds?: number
  /**
   * History rows (`GET /jobs/all/history`, `GET /projects/:slug/jobs/history`)
   * carry these instead of `output_lines`, which no collapsed card shows and
   * which dominated the payload of a whole-fleet read. See
   * `contracts/jobs-history.ts` for the one implementation of each.
   */
  summary_line?: string | null
  progress_counter?: string | null
  output_line_count?: number
}

/** Response from `GET /projects/:slug/jobs`. */
export interface JobListResponse {
  jobs: JobEnqueuedResponse[]
  stats: {
    running: number
    queued: number
    paused: number
    done: number
    error: number
    total: number
  }
}

/**
 * The counts the Jobs page needs about the rows it is NOT currently showing.
 * Every one of them used to be a `.filter()` over the whole fleet in memory;
 * they are cheap server-side because none of them serializes a job.
 */
export interface JobHistoryFacets {
  /** The scope's own statuses, with no filter applied — the page's header metrics. */
  stats: {
    running: number
    queued: number
    paused: number
    done: number
    error: number
    recovered: number
    cancelled: number
    /** Steps that did not run because the channel's own settings switch them off (AGENTS.md §8). */
    skipped: number
    total: number
  }
  /** Active rows per job type — the type tabs' "(N active)". */
  active_by_type: Record<string, number>
  /** Display-status counts under the current type/search/batch filter — the status chips. */
  status: Record<string, number>
  /** Terminal rows whose own controls offer "Remove From List". */
  clearable: { finished: number; failed: number }
}

/** Response from the paged history endpoints. */
export interface JobHistoryResponse {
  /** The page, newest finished first. Empty when `ids` was requested instead. */
  jobs: JobEnqueuedResponse[]
  /** Matching ids only, in the same order — the cheap selector bulk actions take. */
  ids?: string[]
  /** How many rows match the filter, not how many are on this page. */
  total: number
  /** Pass back as `cursor` for the next page. Null on the last page. */
  next_cursor: string | null
  facets?: JobHistoryFacets
}

// ── Job stream (SSE) ────────────────────────────────────────────────────────
// `GET /projects/:slug/jobs/stream` is a Server-Sent Events endpoint that
// emits one of these envelopes on every queue state transition. The event
// `type` on the SSE frame matches the union discriminator below.
//
// Event order on a fresh subscription:
//   1. exactly one `snapshot` carrying the current full list + stats
//   2. zero or more `update`s (one per job state transition)
//   3. zero or more `cleared`s (each follows a bulk clear-finished or a
//      single delete of a terminal job)

/** Initial state dump sent immediately on subscribe. */
export interface JobStreamSnapshot {
  type: 'snapshot'
  data: JobListResponse
}

/** A single job's state changed (queued → running → done/error/cancelled). */
export interface JobStreamUpdate {
  type: 'update'
  data: JobEnqueuedResponse
}

/** One or more finished jobs were removed. Client should refetch full list
 *  or prune local `done`/`error`/`cancelled` entries. */
export interface JobStreamCleared {
  type: 'cleared'
}

export type JobStreamEvent = JobStreamSnapshot | JobStreamUpdate | JobStreamCleared
export type { YouTubeEpisodeUploadStatus } from './youtube-upload-center.js'
export * from './episode-cost.js'
