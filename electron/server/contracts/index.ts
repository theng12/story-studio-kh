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
  // v1.0.68+: per-channel format chosen at project-creation time.
  // The Create Project wizard surfaces a card grid of all built-in
  // formats (sleep-story, listicle, documentary, …); leaving this
  // unset preserves the legacy default ('sleep-story') applied by
  // project-manager when no format_id is supplied. Bounded to 60
  // chars — built-in ids are short and user-custom format ids
  // sanitise the same way through format-loader.
  format_id: z.string().max(60).optional(),
  // v1.0.79+: optional subject-domain niche (plants, animals, fungi,
  // insects, or user-custom). Orthogonal to format — niche layers
  // vocabulary, visual style, and YouTube tag hints onto whatever
  // format the project picks. Unset = no niche, format defaults
  // apply unchanged. Same length cap as niche route's id validator.
  niche_id: z.string().max(80).optional(),
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
  format_overrides: z.any().optional(),
  // v1.0.270 — 'freeform' makes the format drive visuals only; idea + script
  // use neutral prompts. Empty/absent = 'format' (current behavior).
  content_mode: z.enum(['format', 'freeform']).optional(),
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
  tagline: z.string().max(200).optional(),
  exampleTopics: z.array(z.string().min(1).max(200)).max(200),
  vocabulary: NicheVocabularySchema.optional(),
  visualStyleSheet: z.string().max(3000).optional(),
  thumbnailStyleSheet: z.string().max(3000).optional(),
  defaultStyleKeywords: z.array(z.string().min(1).max(120)).max(40).optional(),
  negativePromptAddendum: z.string().max(1500).optional(),
  referenceImages: z.array(NicheReferenceImageSchema).max(50).optional(),
  youtubeTagsHint: z.array(z.string().min(1).max(60)).max(40).optional(),
  audienceHint: z.string().max(400).optional(),
  scriptContext: z.string().max(2000).optional(),
}).strict()
export type NicheBody = z.infer<typeof NicheSchema>

/** Body for PUT /projects/:slug/niche. `null` clears the association. */
export const SetProjectNicheSchema = z.object({
  niche_id: z.string().max(80).nullable(),
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
  audio_models: z.record(z.string(), z.any()).optional(),
  video_models: z.record(z.string(), z.any()).optional(),
  confirmation_preferences: z.record(z.string(), z.any()).optional(),
}).passthrough()
export type UpdateConfigBody = z.infer<typeof UpdateConfigSchema>

/**
 * Shape of `GET /projects/:slug/settings/config` — the "safe" config with
 * API keys replaced by `has_*` booleans. The server strips secrets before
 * serving; never add a `*_api_key` field here.
 */
export interface SafeProjectConfigResponse {
  has_kie_key: boolean
  has_fal_key: boolean
  has_openai_key: boolean
  has_anthropic_key: boolean
  has_genaipro_key?: boolean
  has_elevenlabs_key?: boolean
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
    providers: Array<'elevenlabs' | 'fal' | 'genaipro' | 'kie' | 'fishaudio' | 'genstudio'>
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

export const EstimateCostSchema = z.object({
  type: z.string().min(1),
  params: z.record(z.string(), z.any()).optional(),
}).strict()

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
  image_steps: z.number().int().min(1).max(100).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
}).passthrough()
export type GenerateImagesBody = z.infer<typeof GenerateImagesSchema>

export const GenerateAudioSchema = z.object({
  episode_id: EpisodeId,
  model: z.string().min(1),
  voice: z.string().optional(),
  sections: z.string().optional(),
  speed: z.number().optional(),
  stability: z.number().optional(),
  similarity: z.number().optional(),
  force: z.boolean().optional(),
  no_overwrite: z.boolean().optional(),
  /**
   * Fish Audio S2-Pro only: when true, the generator swaps each section's text
   * for its saved "expressive script" (inline [tag] markup) before chunking.
   * Ignored by every other provider/model.
   */
  use_expression: z.boolean().optional(),
  /** Fish Audio only: 0–1 expressiveness (temperature). Higher = less monotone. */
  fish_temperature: z.number().min(0).max(1).optional(),
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
   * to stay on this Mac or the local Studio Hub fleet. */
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
  queue_position?: number
  /**
   * Which provider accounts served this job. Keyed by providerId. The
   * resolver populates this live via the SSE `update` stream, so Jobs-page
   * cards can show attribution without a refetch. See `Job.accounts_used`
   * on the server for the canonical shape.
   */
  accounts_used?: Record<string, { id: string; label: string }>
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
