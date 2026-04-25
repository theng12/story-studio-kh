/**
 * All TypeScript interfaces — ported from Python Pydantic models.
 */

// ── Project ─────────────────────────────────────────────────────────────────

export interface SubfolderNames {
  script: string
  metadata: string
  scene_prompts: string
  thumb_prompts: string
  images: string
  thumbnails: string
  audio: string
  merged_audio: string
  // New in the 07→08→09→10 pipeline contract — previously the subtitles
  // generator hardcoded `{code} - 09 Subtitles`, colliding with the video
  // folder. The key is optional in stored project.json files (older projects
  // won't carry it) so readers must tolerate `undefined`.
  subtitles: string
  video: string
}

/** Linkage metadata: which generator produces which folder */
export const SUBFOLDER_LINKAGE: Record<keyof SubfolderNames, { label: string; generator: string; order: number }> = {
  script:        { label: 'Script',               generator: 'Script Generator',          order: 1 },
  metadata:      { label: 'Metadata',             generator: 'Metadata Generator',        order: 2 },
  scene_prompts: { label: 'Scene Prompts',        generator: 'Image Prompts Generator',   order: 3 },
  thumb_prompts: { label: 'Thumbnail Prompts',    generator: 'Image Prompts Generator',   order: 4 },
  images:        { label: 'Scene Images',         generator: 'Image Generator (Scenes)',  order: 5 },
  thumbnails:    { label: 'Thumbnail Images',     generator: 'Image Generator (Thumbs)',  order: 6 },
  audio:         { label: 'Audio Assets',         generator: 'Audio Generator (TTS)',     order: 7 },
  merged_audio:  { label: 'Audio Merge Output',   generator: 'Audio Assembly',            order: 8 },
  subtitles:     { label: 'Subtitles Output',     generator: 'Video Assembly (Subtitles)', order: 9 },
  video:         { label: 'Video Assembly Output', generator: 'Video Assembly',           order: 10 },
}

export const DEFAULT_SUBFOLDER_NAMES: SubfolderNames = {
  script:        '{code} - 01 Script',
  metadata:      '{code} - 02 Metadata',
  scene_prompts: '{code} - 03 Scene Prompts',
  thumb_prompts: '{code} - 04 Thumbnail Prompts',
  images:        '{code} - 05 Scene Images',
  thumbnails:    '{code} - 06 Thumbnail Images',
  audio:         '{code} - 07 Audio Assets',
  merged_audio:  '{code} - 08 Audio Merge Output',
  subtitles:     '{code} - 09 Subtitles Output',
  video:         '{code} - 10 Video Assembly Output',
}

export interface ProjectMeta {
  name: string
  slug: string
  /**
   * Stable UUID that identifies this project across machines. Generated
   * the first time the project is saved after Stage 2 lands; pre-existing
   * projects get a UUID backfilled on their next save. The slug is
   * user-facing and can collide after cross-machine sync — this id is
   * what lets us reconcile "is this the same project we already have?"
   */
  project_id?: string
  /**
   * User intent flag set at creation time. `true` means the user picked
   * "multi-machine" and wants the project folder in a cloud-sync location.
   * `false` means "local only". Drives UX affordances (home-page badge,
   * "Enable cloud sync" button in settings) but does NOT gate manifest
   * writes — Stage 2's `syncManifest` writes a manifest whenever the
   * output_root is absolute regardless of this flag, so switching from
   * local to portable later is always a free upgrade.
   */
  portable?: boolean
  episode_prefix: string
  episode_digits: number
  season_size: number
  season_prefix: string
  folder_template: string
  subfolder_names: SubfolderNames
  output_root: string
  created_at: string
  youtube_channel_url?: string
}

/**
 * Portable manifest (schema v2). Written as `.story-studio-project.json` at
 * the root of a project's `output_root` whenever project metadata changes.
 * Travels with the folder when the user syncs via iCloud / Google Drive /
 * OneDrive.
 *
 * Schema v2 is intentionally small — just enough structure for another
 * machine to recognise the folder and line up episode codes with folder
 * names. Presets, production standards, YouTube templates, voice presets,
 * and "required named roots" are NOT carried across machines anymore:
 * setting those up is a one-time per-machine step. This keeps the manifest
 * ≤1 KB and removes the "which machine's presets win?" coordination problem.
 *
 * Back-compat: `readManifest` still accepts v1 manifests (with preset bag)
 * and discards the extra payload silently on read. On next write the file
 * is upgraded in place.
 */
export interface PortableManifest {
  schema_version: 2
  project_id: string
  slug: string
  name: string
  episode_prefix: string
  episode_digits: number
  season_size: number
  season_prefix: string
  folder_template: string
  subfolder_names: SubfolderNames
  /** Informational — surfaces "last edited on <machine> at <time>" UX. */
  last_edited: { machine_label: string; at: string }
}

/**
 * Per-machine pointer kept in `{userData}/projects/{slug}/pointer.json`.
 * Added in Stage 2 alongside the legacy `project.json` for back-compat.
 * Stage 4 (`makePortable`) will eventually trim `project.json` down to
 * just this pointer, with the manifest as the source of truth.
 */
export interface Pointer {
  project_id: string
  output_root: string
  last_seen_manifest_mtime?: number
}

export interface CreateProjectRequest {
  name: string
  template?: string
  episode_prefix?: string
  episode_digits?: number
  season_prefix?: string
  season_size?: number
  output_root?: string
  /** User's explicit multi-machine vs local choice. Defaults to false. */
  portable?: boolean
}

export interface UpdateProjectRequest {
  name?: string
  episode_prefix?: string
  episode_digits?: number
  season_size?: number
  season_prefix?: string
  folder_template?: string
  subfolder_names?: SubfolderNames
  output_root?: string
  portable?: boolean
  youtube_channel_url?: string
}

export interface ProjectSummary {
  name: string
  slug: string
  episode_prefix: string
  created_at: string
  has_api_keys: boolean
  portable?: boolean
  /**
   * Absolute path to where episode assets live. Resolved from
   * `project.json.output_root` (relative paths are resolved against the
   * project's userData dir). Always present — used by the home page to
   * both show the location and decide whether to flag the project as
   * needing relocation.
   */
  output_root?: string
  /**
   * Whether `output_root` exists on disk right now. When `false` — e.g.
   * the user moved the synced folder on another machine and opened this
   * one before manually relocating — the home page surfaces a
   * "Relocate…" affordance so generation doesn't fail silently later.
   */
  output_root_exists?: boolean
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface ImageModelConfig {
  label: string
  credits_per_image: number
  endpoint: string
  poll: string
  type: string // 'jobs' | 'flux' | '4o' | 'gpt-image'
  api_model: string
  /**
   * Canonical provider id serving this model. Optional for backward compat —
   * every legacy image model targeted kie.ai, so readers treat absence as
   * `'kie'` (see `toUnified` in models/unified.ts).
   */
  provider?: string
  /**
   * Set on user-added entries via the Settings → Models tab. Survives the
   * legacy-dict round-trip so the UI can show a "Custom" badge and allow
   * deletion of only user entries, not built-in ones.
   */
  is_custom?: boolean
}

// ── Unified model catalog ───────────────────────────────────────────────────
// A provider-scoped view of every model the project can use, collapsing the
// three typed dicts (image/audio/video) into one list. For Delivery 1 this is
// a read projection computed from the legacy dicts; the legacy dicts remain
// the on-disk source of truth so existing generators keep working unchanged.

export type ModelType = 'image' | 'audio' | 'video' | 'text'

export interface UnifiedModel {
  id: string
  /** Canonical provider id (e.g. 'kie', 'fal', 'elevenlabs', 'openai'). */
  provider: string
  type: ModelType
  label: string
  /** Free-form tags, e.g. ['text-to-video','image-to-video']. */
  capabilities?: string[]
  /** True when added by the user via Settings UI (Delivery 4). */
  is_custom?: boolean
  /** Type-specific fields: credits_per_image, cost_per_1k_chars, modes, provider_params, etc. */
  params: Record<string, any>
}

export interface AudioModelConfig {
  label: string
  cost_per_1k_chars: number
  /**
   * Which provider to route this model to. Optional for backward compat —
   * if missing, the audio generator falls back to prefix-based detection
   * (`genaipro-*` → genaipro, `eleven_*` → elevenlabs, else fal).
   */
  provider?: 'fal' | 'genaipro' | 'elevenlabs'
  /** Set on user-added entries. See `ImageModelConfig.is_custom` for rationale. */
  is_custom?: boolean
}

export interface VideoModelConfig {
  label: string
  credits_per_video: number
  provider: string  // 'genaipro-veo' etc.
  /** Modes this model supports: 'text', 'frames' (image-to-video), 'ingredients' */
  modes: Array<'text' | 'frames' | 'ingredients'>
  /** Max duration in seconds, if known */
  max_duration?: number
  /** Set on user-added entries. See `ImageModelConfig.is_custom` for rationale. */
  is_custom?: boolean
}

export interface VoicePreset {
  name: string
  voice_id: string
}

export interface ConfirmationPreferences {
  script?: boolean
  scene_prompts?: boolean
  thumb_prompts?: boolean
  scene_images?: boolean
  thumb_images?: boolean
  audio?: boolean
  video?: boolean
  metadata?: boolean
}

export interface ProjectConfig {
  kie_api_key: string
  fal_api_key: string
  openai_api_key: string
  anthropic_api_key: string
  genaipro_api_key?: string
  elevenlabs_api_key?: string
  google_api_key?: string
  image_models: Record<string, ImageModelConfig>
  image_pricing_last_updated: string
  voice_presets: VoicePreset[]
  /** Per-project list of favourited voice_ids, pinned to the top of the picker. */
  voice_favourites?: string[]
  audio_models: Record<string, AudioModelConfig>
  audio_pricing_last_updated: string
  video_models?: Record<string, VideoModelConfig>
  video_pricing_last_updated?: string
  /**
   * Per-provider concurrency: how many in-flight TTS / video-gen requests
   * inside one job. Clamped in the generator; unset = safe default (3 for
   * audio, 2 for video). ElevenLabs tiers: Free 2 / Starter 3 / Creator 5
   * / Pro 10 / Scale 15. fal.ai: scales 2→40 with account credits.
   */
  audio_concurrency?: number
  video_concurrency?: number
  /** Already-existing knob; kept here for symmetry + surfacing in the UI. */
  image_concurrency?: number
  /**
   * Unified model catalog — projection over image_models/audio_models/video_models.
   * Delivery 1: computed in-memory per read; absent on disk. Delivery 4 starts
   * writing user-added custom entries here.
   */
  models?: UnifiedModel[]
  confirmation_preferences?: ConfirmationPreferences
}

export interface SafeProjectConfig {
  has_kie_key: boolean
  has_fal_key: boolean
  has_openai_key: boolean
  has_anthropic_key: boolean
  has_genaipro_key?: boolean
  has_elevenlabs_key?: boolean
  has_google_key?: boolean
  image_models: Record<string, ImageModelConfig>
  image_pricing_last_updated: string
  voice_presets: VoicePreset[]
  voice_favourites?: string[]
  audio_models: Record<string, AudioModelConfig>
  audio_pricing_last_updated: string
  video_models?: Record<string, VideoModelConfig>
  video_pricing_last_updated?: string
  audio_concurrency?: number
  video_concurrency?: number
  image_concurrency?: number
  /** Unified model catalog (same content as `ProjectConfig.models`). */
  models?: UnifiedModel[]
  confirmation_preferences?: ConfirmationPreferences
}

export interface UpdateApiKeysRequest {
  kie_api_key?: string
  fal_api_key?: string
  openai_api_key?: string
  anthropic_api_key?: string
  genaipro_api_key?: string
  elevenlabs_api_key?: string
  google_api_key?: string
}

export interface UpdateConfigRequest {
  image_models?: Record<string, ImageModelConfig>
  voice_presets?: VoicePreset[]
  voice_favourites?: string[]
  audio_models?: Record<string, AudioModelConfig>
  video_models?: Record<string, VideoModelConfig>
  audio_concurrency?: number
  video_concurrency?: number
  image_concurrency?: number
  confirmation_preferences?: ConfirmationPreferences
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type JobType = 'script-only' | 'introduction-only' | 'chapter-only' | 'image_prompts' | 'images' | 'scene_images' | 'thumb_images' | 'images_repair' | 'audio' | 'audio_merge' | 'metadata' | 'video' | 'video_repair' | 'video_assembly' | 'subtitles_transcribe' | 'youtube_upload'
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * Snapshot of an account as it was at resolution time. Labels are captured
 * up-front so later renames don't retroactively change what the job card shows.
 */
export interface AccountUsage {
  id: string
  label: string
}

export interface Job {
  job_id: string
  project_slug: string
  type: JobType
  episode_id: string
  title: string
  status: JobStatus
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  output_lines: string[]
  progress?: number
  params: Record<string, any>
  queue_position?: number
  /**
   * Which account served each provider the job called. Keyed by canonical
   * providerId (`openai`, `fal`, …). Populated by the resolver whenever
   * `ResolveContext.jobId` is passed — see registry.ts `resolveApiKeyForProviderId`.
   * Same provider on repeat calls overwrites with the latest resolution.
   */
  accounts_used?: Record<string, AccountUsage>
  /**
   * Directory containing the job's primary output. Set by each generator
   * once it knows where its files landed (audio dir, image dir, video
   * dir, …). Used by the Jobs page's "Open in Finder" button to reveal
   * the result without the user having to grep through `output_lines`.
   * Optional for backwards-compat — pre-existing jobs in jobs.json from
   * before this field shipped won't have it; the frontend falls back to
   * parsing output_lines for those.
   */
  output_dir?: string
}

export interface JobStats {
  running: number
  queued: number
  done: number
  error: number
  total: number
}

// ── Generation Requests ─────────────────────────────────────────────────────

export interface GenerateIdeasRequest {
  genre: string
  theme?: string
  audience: string
  mood: string
  keywords?: string[]
  count: number
  model: string
}

export interface StoryIdea {
  title: string
  logline: string
  themes: string[]
  suggested_chapters: number
  suggested_length: string
  mood: string
}

export interface GenerateScriptRequest {
  episode_id: string
  title: string
  length: number
  model: string
  style: string
  chapters: number
  total_words?: number
  words_per_chapter?: number
  generate_image_prompts: boolean
  generate_youtube_desc: boolean
}

export interface GenerateImagesRequest {
  episode_id: string
  model: string
  mode: string // 'all' | 'scenes' | 'thumbs'
  aspect_ratio: string
  scene_number?: number
  thumb_number?: number
  force: boolean
}

export interface GenerateAudioRequest {
  episode_id: string
  model: string
  voice?: string
  sections: string
  speed: number
  stability: number
  similarity: number
  force: boolean
  no_overwrite: boolean
}

export interface VideoScene {
  image_path: string
  duration: number
  title?: string
  show_title: boolean
}

export interface VideoTitleCard {
  text: string
  subtitle?: string
  duration: number
  style: 'gold' | 'white' | 'neon' | 'minimal'
  background: string  // color hex or 'blur'
}

export interface VideoChapterTitles {
  enabled: boolean
  style: 'gold' | 'white' | 'neon' | 'minimal'
  position: 'top' | 'center' | 'bottom'
  duration: number
  font_size: 'small' | 'medium' | 'large'
}

export interface VideoBackgroundMusic {
  path: string
  volume: number       // 0-1
  fade_in: number      // seconds
  fade_out: number     // seconds
  duck_narration: boolean  // lower music when narration plays
}

export interface VideoLogoConfig {
  enabled: boolean
  image_path: string
  position: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'custom'
  custom_x?: number
  custom_y?: number
  opacity: number      // 0-1
  scale: number        // 0.01-1.0 relative to video width
  margin: number       // pixels from edge
  hide_during_intro: boolean
}

export interface VideoIntroConfig {
  enabled: boolean
  video_path: string
}

/**
 * Optional tail clip stitched after the post-audio segment. Unlike
 * `outro_card` (text), this takes a user-prepared video file — e.g.
 * a pre-made black-screen background with branding or silence.
 * Never receives effects: the runFinalComposition effect gate clears
 * at `sceneEndTime`, so anything beyond (post-audio + outro) stays
 * visually clean.
 */
export interface VideoOutroConfig {
  enabled: boolean
  video_path: string
}

/**
 * Named positions in the final video where a user-supplied clip can be
 * inserted. The four positions match the pipeline's existing concat
 * boundaries in `buildConcatList`, so adding clips at these points
 * doesn't require restructuring the assembly. Per-scene anchors
 * (e.g. "between scene 42 and 43") are deliberately out of scope for
 * the first cut — add `at_scene: number` to this union when needed.
 */
export type TimelineAnchor =
  | 'before_intro'   // very start, before the intro clip (or title if no intro)
  | 'after_intro'    // after intro, before the first story scene
  | 'after_scenes'   // after the last scene cycle, before post-audio fade/hold
  | 'after_outro'    // very end, after the outro clip — sleep-story black padding etc.

/**
 * A user-supplied video clip inserted at a named position in the final
 * render. Multiple clips sharing the same anchor play in list order.
 * Like `VideoOutroConfig`, these are ALWAYS effect-free — the existing
 * `sceneEndTime` gate covers after_scenes/after_outro; video.ts extends
 * the head-of-video gate to cover before_intro/after_intro.
 *
 * Portable-path token support (`${PROJECT}/foo`, `${NAME}/bar`) is
 * inherited from `resolveAssetPath` — saved presets travel across
 * machines without rewriting.
 */
export interface VideoTimelineClip {
  /** Stable identifier for drag-reorder and row tracking. */
  id: string
  video_path: string
  anchor: TimelineAnchor
  /** Per-row on/off so a preset can carry a clip without forcing it
   *  into every episode that uses the preset. */
  enabled: boolean
}

export interface VideoTitleImageConfig {
  enabled: boolean
  image_path: string
  duration: number        // default 5s
  transition_type?: string
  transition_duration?: number
}

export interface VideoSceneRecycling {
  seconds_per_scene: number  // default 10
  shuffle: boolean
  excluded_scenes: number[]
}

export interface VideoMusicConfig {
  enabled: boolean
  files: string[]              // multiple .mp3 paths
  volume: number               // 0-1 during narration
  post_narration_volume: number // 0-1 after narration ends
  fade_in: number
  fade_out: number
}

export interface VideoDurationConfig {
  mode: 'auto' | 'custom'
  min_duration: number    // seconds
  max_duration: number    // seconds
}

export interface VideoColorGrading {
  enabled: boolean
  preset: 'none' | 'warm-night' | 'cool-moonlight' | 'cinematic' | 'vintage' | 'dreamy-haze' | 'golden-hour' | 'noir'
  brightness: number      // -1.0 to 1.0, default 0
  contrast: number        // 0.0 to 3.0, default 1.0
  saturation: number      // 0.0 to 3.0, default 1.0
  warmth: number          // -1.0 to 1.0, negative=cool positive=warm, default 0
  tint: number            // -1.0 to 1.0, negative=green positive=magenta, default 0
}

export interface VideoVignetteConfig {
  enabled: boolean
  strength: number        // 0.0 to 1.0, default 0.4
}

export interface VideoChromaKeyConfig {
  enabled: boolean
  source_path: string     // path to green-screen video/image
  color: string           // hex color to key out, default '#00FF00'
  similarity: number      // 0.0 to 1.0, default 0.15
  blend: number           // 0.0 to 1.0, default 0.1
}

export interface VideoBackgroundNoise {
  enabled: boolean
  mode: 'preset' | 'custom'
  preset: 'white-noise' | 'pink-noise' | 'brown-noise'
  custom_file?: string    // path to custom ambience .mp3
  volume: number          // 0-1, default 0.15
  fade_in: number
  fade_out: number
}

export interface VideoFilmGrain {
  enabled: boolean
  strength: number        // 0-100, default 15
}

export interface VideoLetterbox {
  enabled: boolean
  ratio: '2.35:1' | '2.00:1' | '1.85:1'  // cinematic aspect ratios
  color: string           // bar color, default 'black'
}

// Subtitles — burned into the final video via FFmpeg's `subtitles=` filter
// (libass). Three sources feed a single on-disk SRT:
//   - 'chapters'  : derived from chapter audio file durations + their labels
//   - 'upload'    : user picked an external .srt / .vtt via FilePicker
//   - 'whisper'   : transcribed from the merged audio via OpenAI Whisper
export type VideoSubtitleSource = 'chapters' | 'upload' | 'whisper'

export interface VideoSubtitleStyle {
  font_family: string       // any libass-known face, default 'Helvetica'
  font_size_px: number      // approx pt at 1080p; libass scales internally
  color_hex: string         // primary text colour, default '#FFFFFF'
  outline_color_hex: string // stroke colour, default '#000000'
  outline_px: number        // stroke width, default 2
  background: 'none' | 'semi' | 'full'  // box behind text
  position: 'top' | 'center' | 'bottom' // vertical placement
  align: 'left' | 'center' | 'right'
  max_chars_per_line: number            // wrap target, default 42
  max_lines: number                     // libass `WrapStyle` + `MaxLines`
}

export interface VideoSubtitleConfig {
  enabled: boolean
  source: VideoSubtitleSource
  /** Absolute path to the SRT that should be burned in. Written by the
   *  backend when source = 'chapters' | 'whisper'; set to the user-picked
   *  file when source = 'upload'. */
  srt_path?: string
  style: VideoSubtitleStyle
}

export type SceneAnimationType = 'ken-burns' | 'parallax-drift' | 'breathe' | 'fade-in' | 'none'
export type ParallaxDirection = 'left' | 'right' | 'up' | 'down'

export interface VideoSceneAnimation {
  type: SceneAnimationType
  zoom_start: number          // %, default 100
  zoom_end: number            // %, default 108
  parallax_direction: ParallaxDirection  // default 'right'
  parallax_speed: number      // 1-5, default 2
  breathe_amplitude: number   // %, default 2
  breathe_base_zoom: number   // %, default 103
}

export type PostAudioBehavior = 'black-screen' | 'fade-to-black' | 'hold-last-scene' | 'continue-cycling'

export interface VideoPostAudio {
  behavior: PostAudioBehavior   // default 'fade-to-black'
  fade_duration: number         // seconds, default 5, only used for 'fade-to-black'
}


export interface GenerateVideoRequest {
  episode_id: string
  scenes: VideoScene[]
  narration_path: string
  logo?: VideoLogoConfig
  intro?: VideoIntroConfig
  outro?: VideoOutroConfig
  /**
   * User-supplied clips inserted at named positions in the final video.
   * Empty / missing array is a no-op — the pipeline behaves identically
   * to pre-timeline-clip presets, so existing presets keep working.
   */
  timeline_clips?: VideoTimelineClip[]
  title_image?: VideoTitleImageConfig
  scene_recycling: VideoSceneRecycling
  music?: VideoMusicConfig
  duration: VideoDurationConfig
  transition: string
  transition_duration: number
  resolution: '720p' | '1080p' | '1440p' | '4k'
  quality: 'compact' | 'fast' | 'medium' | 'high'
  /** Frame rate. 24 is cinematic, 30 is YouTube default, 60 is smooth motion.
   *  For still-image sleep stories 24 gives ~20 % smaller files with no
   *  perceptible difference. Defaults to 30 for back-compat with presets
   *  saved before this field existed. */
  fps?: 24 | 25 | 30 | 60
  /** Compression effort. Decoupled from `quality` so users can mix CRF
   *  (visual quality bar) with preset (render-time-vs-size trade). `slow`
   *  at the same CRF emits ~30 % smaller files than `ultrafast` because
   *  the encoder has more time to find savings. Defaults mirror the legacy
   *  quality→preset mapping when omitted. */
  encoding_effort?: 'ultrafast' | 'medium' | 'slow'
  /** Output codec. H.264 is the universal default (every player since 2005).
   *  HEVC (H.265) encodes ~30–40 % smaller at equal visual quality but
   *  requires QuickTime 10.4+ / modern browsers. Only recommended for users
   *  who control their playback environment. */
  codec?: 'h264' | 'h265'
  format: 'mp4' | 'mov' | 'webm'
  title_card?: VideoTitleCard
  outro_card?: { text: string; duration: number; style: string }
  chapter_titles: VideoChapterTitles
  scene_animation?: VideoSceneAnimation
  post_audio?: VideoPostAudio       // what happens after narration ends, default fade-to-black
  ken_burns?: boolean               // DEPRECATED — kept for backward compat, maps to scene_animation 'ken-burns'
  audio_gap?: number                // seconds of silence between narration chapters, default 5
  narration_chapters?: string[]     // individual chapter audio file paths (for gap insertion)
  merged_audio_path?: string        // path to pre-merged audio from audio-merge step (skips chapter concat)
  narration_volume?: number         // 0-1, default 1.0
  background_noise?: VideoBackgroundNoise
  color_grading?: VideoColorGrading
  vignette?: VideoVignetteConfig
  chroma_key?: VideoChromaKeyConfig
  film_grain?: VideoFilmGrain
  letterbox?: VideoLetterbox
  subtitles?: VideoSubtitleConfig
  exclude_intro_from_effects?: boolean  // default true — don't apply grading/vignette to intro
}

// ── Audio Merge ─────────────────────────────────────────────────────────────

// ── Video Generation ────────────────────────────────────────────────────────

export type VideoGenerationMode = 'text' | 'frames' | 'ingredients'

export interface GenerateVideoPromptsRequest {
  episode_id: string
  title: string
  model: string  // LLM model for prompt generation
  /** How many prompts to generate — typically matches scene count */
  count?: number
  /** Optional hint if the user wants a specific style (e.g. "slow dreamy camera moves") */
  style_hint?: string
}

export interface GenerateVideoRequest {
  episode_id: string
  model: string            // video model ID (e.g. 'veo-v2')
  mode: VideoGenerationMode
  aspect_ratio: 'landscape' | 'portrait'
  number_of_videos_per_prompt: number  // 1-4
  /** 'scene_prompts' | 'video_prompts' | 'manual' */
  prompt_source: 'scene_prompts' | 'video_prompts' | 'manual'
  /** Manual prompts, used when prompt_source='manual' */
  manual_prompts?: string[]
  /** For image-to-video: pick specific scene image filenames. If empty, uses all generated scene images. */
  scene_image_filenames?: string[]
  force: boolean
}

export interface AudioMergeIntro {
  enabled: boolean
  file: string                 // absolute path to intro audio
  volume: number               // 0-1, default 1.0
  gap_after: number            // seconds of silence between intro and first chapter, default 2
}

export interface AudioMergeRequest {
  episode_id: string
  chapters: string[]           // ordered audio file paths
  gap_duration: number         // seconds of silence between chapters, default 5
  normalize_volume: boolean    // apply loudnorm filter to equalize chapter volumes
  intro?: AudioMergeIntro      // optional audio intro prepended to narration
  music?: VideoMusicConfig     // optional background music
  background_noise?: VideoBackgroundNoise  // optional ambient noise
  narration_volume?: number    // 0-1, default 1.0
  write_mode?: 'overwrite' | 'new'  // how to handle an existing merged output; default 'overwrite'
}

// ── AI Models ───────────────────────────────────────────────────────────────

export type AiProvider = 'anthropic' | 'openai' | 'kie' | 'genaipro'

export const SUPPORTED_MODELS: Record<string, AiProvider> = {
  // Anthropic
  'claude-opus-4-6': 'anthropic',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5': 'anthropic',
  // OpenAI — current + legacy
  'gpt-5': 'openai',
  'gpt-5-mini': 'openai',
  'gpt-4.1': 'openai',
  'gpt-4.1-mini': 'openai',
  'gpt-4.1-nano': 'openai',
  'gpt-4o': 'openai',
  'gpt-4o-mini': 'openai',
  'o3': 'openai',
  'o3-mini': 'openai',
  'o4-mini': 'openai',
  // kie.ai (OpenAI-compatible)
  'deepseek-v3-kie': 'kie',
  'deepseek-r1-kie': 'kie',
  // genaipro (OpenAI-compatible gateway — LLMs + ElevenLabs TTS)
  'genaipro-gpt-4o': 'genaipro',
  'genaipro-gpt-4.1': 'genaipro',
  'genaipro-claude-sonnet-4': 'genaipro',
  'genaipro-claude-opus-4': 'genaipro',
}

/** Display labels for the frontend model selectors */
export const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-6':   'Claude Opus 4 [Anthropic]',
  'claude-sonnet-4-6': 'Claude Sonnet 4 [Anthropic]',
  'claude-haiku-4-5':  'Claude Haiku 4.5 [Anthropic]',
  'gpt-5':             'GPT-5 [OpenAI]',
  'gpt-5-mini':        'GPT-5 Mini [OpenAI]',
  'gpt-4.1':           'GPT-4.1 [OpenAI]',
  'gpt-4.1-mini':      'GPT-4.1 Mini [OpenAI]',
  'gpt-4.1-nano':      'GPT-4.1 Nano [OpenAI]',
  'gpt-4o':            'GPT-4o [OpenAI]',
  'gpt-4o-mini':       'GPT-4o Mini [OpenAI]',
  'o3':                'o3 [OpenAI reasoning]',
  'o3-mini':           'o3 Mini [OpenAI reasoning]',
  'o4-mini':           'o4 Mini [OpenAI reasoning]',
  'deepseek-v3-kie':   'DeepSeek V3 [kie.ai]',
  'deepseek-r1-kie':   'DeepSeek R1 [kie.ai]',
  'genaipro-gpt-4o':            'GPT-4o [genaipro]',
  'genaipro-gpt-4.1':           'GPT-4.1 [genaipro]',
  'genaipro-claude-sonnet-4':   'Claude Sonnet 4 [genaipro]',
  'genaipro-claude-opus-4':     'Claude Opus 4 [genaipro]',
}
