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
}).strict()
export type UpdateProjectBody = z.infer<typeof UpdateProjectSchema>

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
}

/** Shape of `GET /projects` — list view summary, never includes keys. */
export interface ProjectSummaryResponse {
  name: string
  slug: string
  episode_prefix: string
  created_at: string
  has_api_keys: boolean
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
  voice_presets: Array<{ name: string; voice_id: string }>
  audio_models: Record<string, any>
  video_models?: Record<string, any>
  /** Unified catalog — mirror of the three typed dicts plus any custom entries. */
  models?: Array<{
    id: string
    provider: string
    type: 'image' | 'audio' | 'video' | 'text'
    label: string
    capabilities?: string[]
    is_custom?: boolean
    params: Record<string, any>
  }>
  image_pricing_last_updated: string
  audio_pricing_last_updated: string
  video_pricing_last_updated?: string
  confirmation_preferences?: Record<string, boolean>
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
  // Pattern primitive (Phase 4b): optional per-episode template that
  // composes on top of the project's Format. {pattern_subject} is the
  // {X} value the pattern's titleTemplate substitutes ('London' for
  // 'The entire history of London explained').
  // Empty string = "no pattern (use format defaults)" — the dropdown's
  // first option. Treat it the same as omitting the field entirely; the
  // generator's truthiness check (`if (req.pattern_id) …`) already
  // handles both.
  pattern_id: z.string().max(120).optional(),
  pattern_subject: z.string().max(300).optional(),
  // Character primitive (Phase 5): optional cast list — the LLM uses
  // these names + descriptions instead of inventing characters.
  character_ids: z.array(z.string().min(1).max(120)).optional(),
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
  mode: z.enum(['all', 'scenes', 'thumbs']).optional(),
  // Same defensive pattern as elsewhere — '' = "use generator default
  // (typically 16:9)" rather than a 400. Empty isn't sent today by the
  // current Image Generator UI but keeping the schema tolerant means
  // future entry points (CLI / API integrations / other surfaces) can
  // omit the field cleanly.
  aspect_ratio: z.string().optional(),
  scene_number: z.number().int().nonnegative().optional(),
  thumb_number: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
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
}).passthrough()
export type GenerateAudioBody = z.infer<typeof GenerateAudioSchema>

/** Response from `POST /projects/:slug/generate/{script,images,audio}`. */
export interface JobEnqueuedResponse {
  job_id: string
  project_slug: string
  type: string
  episode_id: string
  title: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  output_lines: string[]
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
