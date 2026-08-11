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

// ── Projects ────────────────────────────────────────────────────────────────

export const CreateProjectSchema = z.object({
  // `name` stays .min(1) — a project literally can't exist without one.
  name: z.string().min(1, 'name is required').max(120),
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
  output_root: z.string().optional(),
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
  topic_pack_ids: z.array(z.string().min(1).max(80)).max(24).optional(),
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
  output_root: z.string().optional(),
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
  // v1.0.760 — per-project Research gate. When true, an episode is not
  // complete until its research sidecar exists AND has been verified.
  // Absent on the wire = leave the stored value alone (updateProject drops
  // undefined keys); absent in project.json = legacy project, resolved OFF.
  research_required: z.boolean().optional(),
  // Level B (opt-in) external media root — a portable ${NAME} token or absolute
  // path. Empty string clears it (back to everything under output_root).
  media_root: z.string().max(512).optional(),
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
}).strict()

const FormulaProductionKitSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  recommendedVisualStyleId: z.string().min(1).max(120).optional(),
  episodeProfiles: z.array(FormulaEpisodeProfileSchema).max(20).optional(),
}).strict()

/** Body for POST /niches and PUT /niches/:id (full-document replace). */
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
  negativePromptAddendum: z.string().max(1500).optional(),
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
  topic_pack_ids: z.array(z.string().min(1).max(80)).max(24).optional(),
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
  output_root: string
  created_at: string
  project_id?: string
  format_id?: string
  niche_id?: string
  topic_pack_ids?: string[]
  continuity_mode?: 'character-continuity' | 'independent-stills' | 'explainer-stills'
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
  style_presets: z.array(z.any()).optional(),
  active_style_preset_id: z.string().max(200).optional(),
  formula_applied_style_id: z.string().max(200).optional(),
  video_models: z.record(z.string(), z.any()).optional(),
  confirmation_preferences: z.record(z.string(), z.any()).optional(),
}).passthrough().transform((value) => {
  // Legacy Story Studio releases persisted a project-owned TTS catalog. Keep
  // accepting those payloads so old clients can save unrelated settings, but
  // never let an audio_models map become executable routing configuration.
  // GenStudio is now the sole voice catalog and TTS execution boundary.
  const current = { ...value }
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
 * Shape of `GET /projects/:slug/settings/config` — the "safe" config with
 * API keys replaced by `has_*` booleans. The server strips secrets before
 * serving; never add a `*_api_key` field here.
 */
export interface SafeProjectConfigResponse {
  has_genstudio_key: boolean
  /**
   * Multi-account listing keyed by provider id. Added in Delivery 2; the
   * `has_*_key` booleans above are still populated (from the default account
   * per provider) for any frontend view that hasn't migrated yet.
   */
  accounts?: Record<string, AccountSummaryResponse[]>
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
  video_models?: Record<string, any>
  image_pricing_last_updated: string
  audio_pricing_last_updated: string
  video_pricing_last_updated?: string
  confirmation_preferences?: Record<string, boolean>
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

export const GenerateScriptSchema = z.object({
  episode_id: EpisodeId,
  title: z.string().min(1).max(300),
  length: z.number().positive().optional(),
  model: z.string().min(1),
  style: z.string().optional(),
  chapters: z.number().int().positive().optional(),
  total_words: z.number().int().positive().optional(),
  words_per_chapter: z.number().int().positive().optional(),
  generate_image_prompts: z.boolean().optional(),
  generate_youtube_desc: z.boolean().optional(),
}).passthrough()
export type GenerateScriptBody = z.infer<typeof GenerateScriptSchema>

export const GenerateScriptOnlySchema = z.object({
  episode_id: EpisodeId,
  title: z.string().min(1).max(300),
  length: z.number().positive().optional(),
  model: z.string().min(1),
  style: z.string().optional(),
  chapters: z.number().int().positive().optional(),
  total_words: z.number().int().positive().optional(),
  words_per_chapter: z.number().int().positive().optional(),
  generate_image_prompts: z.boolean().optional(),
  // Character primitive (Phase 5): optional cast list — the LLM uses
  // these names + descriptions instead of inventing characters.
  character_ids: z.array(z.string().min(1).max(120)).optional(),
  // v1.0.297 — optional free-text producer guidance injected into the outline
  // + chapter prompts (ad-hoc names, setting, names to avoid). Capped so a
  // runaway paste can't blow the prompt budget.
  manual_guidance: z.string().max(2000).optional(),
}).passthrough()
export type GenerateScriptOnlyBody = z.infer<typeof GenerateScriptOnlySchema>

export const GenerateIntroductionOnlySchema = z.object({
  episode_id: EpisodeId,
  title: z.string().min(1).max(300),
  model: z.string().min(1),
  host_name: z.string().optional(),
  word_target: z.number().int().positive().optional(),
  custom_opening: z.string().optional(),
  beats: z.array(z.string()).optional(),
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

export const GenerateImagesSchema = z.object({
  episode_id: EpisodeId,
  model: z.string().min(1),
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
  force: z.boolean().optional(),
  no_overwrite: z.boolean().optional(),
  /**
   * Fish Audio S2-Pro only: when true, the generator swaps each section's text
   * for its saved "expressive script" (inline [tag] markup) before chunking.
   * Ignored by every other provider/model.
   */
  use_expression: z.boolean().optional(),
  /** Fish Audio S2-Pro only: insert [short pause]/[long pause] tags at sentence
   *  + paragraph boundaries so plain narration stops rushing through periods. */
  fish_autopace: z.boolean().optional(),
}).passthrough().transform((value) => {
  // Retired request/preset field. Accept old clients without breaking their
  // jobs, but discard the override before it reaches a queue or provider.
  // TTS splitting is owned exclusively by the active model inventory.
  const current = { ...value }
  delete current.max_chunk_chars
  return current
})
export type GenerateAudioBody = z.infer<typeof GenerateAudioSchema>

/** Response from `POST /projects/:slug/generate/{script,images,audio}`. */
export interface JobEnqueuedResponse {
  job_id: string
  project_slug: string
  type: string
  episode_id: string
  title: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  pause_requested?: boolean
  pause_origin?: 'manual' | 'queue'
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  output_lines: string[]
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
  /** Structured terminal outcome for audit-style jobs such as image repair. */
  result?: Record<string, any>
  params: Record<string, any>
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
  genstudio_jobs?: Array<{
    id: string
    operation: 'voice.tts' | 'audio.transcription' | 'image.generation' | 'chat.response' | 'video.generation'
    state: string
    model_id?: string
    credit_cost?: number
    remaining_credits?: number
    reserved_credits?: number
    settled_credits?: number
    returned_credits?: number
    price_version?: string | null
    failure_code?: string | null
    cancellable?: boolean | null
    cancelled?: boolean | null
    cancellation_requested?: boolean | null
    cancellation_note?: string | null
    released_credits?: number | null
    routing_status_code?: string | null
    location?: string
    queue_state?: 'waiting_local' | 'submitting' | 'accepted' | 'waiting_account_capacity'
      | 'running' | 'completing' | 'succeeded' | 'failed' | 'waiting_credits' | 'cancelled'
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
