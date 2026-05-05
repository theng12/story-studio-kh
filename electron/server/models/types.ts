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
   * Legacy multi-machine intent flag — kept as optional for back-compat
   * because existing project.json files in the wild may still have it set.
   * No code reads it anymore; cloud sync is configured app-wide via
   * Settings → Storage now. Field will quietly disappear on the next
   * project save (object spreads omit unknown keys); we don't migrate
   * proactively to keep the change blast radius small.
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

  /**
   * Format primitive (Phase 1 of the format/character/pattern system).
   *
   * `format_id` selects a base Format profile from the built-in library
   * (electron/server/formats/*.json) or the user-custom library
   * (${PROJECTS_ROOT}/.formats/*.json). Defaults to 'sleep-story' for
   * back-compat — every project that predates the format primitive
   * behaves exactly as before because sleep-story.json is the verbatim
   * extraction of the prior hardcoded prompts.
   *
   * `format_overrides` is a deep-partial of the resolved Format applied
   * on top of the base. Lets the user tweak narrator styles, keyword pool,
   * pacing arc, etc. without forking the whole format JSON.
   */
  format_id?: string
  format_overrides?: DeepPartial<Format>

  /**
   * Brand primitive — channel-level identity layer above Format. Selects
   * a brand profile from ${PROJECTS_ROOT}/.brands/{id}.json. Unset = no
   * brand, generators fall back to today's literal defaults.
   */
  brand_id?: string
}

// ── Format primitive (Phase 1 of format/character/pattern system) ──────────
//
// A Format bundles the channel-level "vibe": idea-generation persona, script
// system prompt + pacing arc + narrator styles, image-prompt visual style,
// metadata keywords + description structure. One Format applies project-wide;
// per-project overrides can flip individual fields without forking.
//
// Built-in formats live at electron/server/formats/{id}.json (shipped with
// the app via electron-builder.json extraResources). User-custom formats
// live at ${PROJECTS_ROOT}/.formats/{id}.json — exportable / shareable as
// single JSON files.
//
// See plans/format-and-character-system.md for the multi-phase rollout plan.

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface NarratorStyle {
  /** Stable id (e.g. 'A'…'J' for sleep-story; arbitrary slug otherwise). */
  id: string
  /** Short label shown in the picker. */
  label: string
  /** Long description that becomes the LLM's narrator-style instruction. */
  description: string
}

export interface IdeaFormat {
  /** Replaces the hardcoded "You are helping generate new story ideas for a sleep-story narration channel." */
  systemPromptRole: string
  audienceDefault: string
  /** Vocabulary hints — appear in the Ideas Generator picker as
   *  suggestions and feed Randomize / Surprise Me. */
  moodVocabulary: string[]
  themeVocabulary: string[]
  /**
   * Optional per-format genre + keyword pools (v1.0.66+). Older
   * formats without these fall through to the page's hardcoded
   * sleep-story-leaning defaults so they keep working unchanged.
   * Listicle / explainer / new formats populate them so the dropdowns
   * and randomizer reflect the channel's actual subject matter.
   */
  genreVocabulary?: string[]
  keywordVocabulary?: string[]
  /** Free-form rules block injected into the live LLM idea prompt. */
  guidanceText: string
  /** 1–2 example ideas baked into the PASTE_PROMPT to show the LLM the bar. */
  exampleIdeas?: Array<{
    title: string
    logline: string
    themes: string[]
    suggested_chapters: number
    suggested_length: string
    mood: string
  }>
}

export interface ScriptFormat {
  /** Replaces the hardcoded "You are a world-class sleep story author." */
  systemPromptRole: string
  /** Bullet rules following the role line in the system prompt. */
  additionalRules: string[]
  /**
   * Per-section pacing instructions. `{lastButOne}` and `{last}` are
   * substituted with chapter numbers at request time. Each entry becomes
   * a "- " bullet under "CHAPTER PACING:" in the narration prompt.
   */
  pacingArc: string[]
  /** One-line closing instruction inserted before the final-check block. */
  closingHint: string
  defaultChapterCount: number
  chapterCountRange: [number, number]
  defaultLengthMinutes: number
  lengthMinutesRange: [number, number]
  narratorStyles: NarratorStyle[]
  defaultNarratorStyleId: string
}

export interface ImagePromptFormat {
  /** Slot in the headline: "Generate ALL image prompts for {purposeNote}." */
  purposeNote: string
  /** Visual style hint — appears in the picker / override editor. */
  visualStyleHint: string
  /** Inclusive scene-count range (e.g. [24, 30] for sleep-story). */
  defaultScenesTotalRange: [number, number]
  defaultThumbnails: number
  /** Default image style tag appended to every prompt. */
  defaultStyleTag: string
  /** Future Phase 7 hook: how to inject character references. */
  characterReferenceMode: 'inline' | 'reference-image' | 'both'
  recommendedAspect: '16:9' | '9:16' | '1:1'
}

export interface YoutubeDescriptionStructure {
  musicLabel: string
  booksSectionLabel: string
  supportSection: string
  aiDisclosure: string
  defaultHashtags: string[]
  totalHashtagCount: number
}

export interface MetadataFormat {
  /** Slot in the headline: "Generate {N} SEO titles for {purposeNote}." */
  purposeNote: string
  titleStyleHint: string
  titleHookRules: string[]
  tagsContext: string
  tagsHookRules: string[]
  /** Broad keywords mixed into the tags pool. */
  broadKeywords: string[]
  youtubeDescriptionStructure: YoutubeDescriptionStructure
  /**
   * Per-format batch defaults consumed by the Pipeline runner when the
   * Metadata page hasn't supplied explicit values. Sleep-story numbers
   * (5000-char descriptions, 5 titles, 100-char title cap, 15 tags) are
   * the historical defaults; listicle / educational typically want
   * tighter values. Optional for back-compat — the pipeline falls back
   * to the legacy hardcoded numbers when these are absent.
   */
  defaultMaxChars?: number
  defaultTitleCount?: number
  defaultTitleMaxLength?: number
  defaultTagCount?: number
}

export interface Format {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1

  idea: IdeaFormat
  script: ScriptFormat
  imagePrompts: ImagePromptFormat
  metadata: MetadataFormat

  /**
   * Optional addendum prepended to the per-project production_standards.txt
   * during prompt assembly. Lets a format declare format-specific style
   * guidelines without polluting the project's free-form standards file.
   */
  productionStandardsAddendum?: string
}

// ── Brand primitive (channel-level identity layer) ─────────────────────────
//
// A Brand sits ABOVE Format in the resolution chain. Format is "what shape
// of content" (sleep-story, adventure, true-crime). Brand is "whose channel
// it is" — channel name, narrator persona, default voice, logo, brand-style
// keywords for image prompts. Multiple projects can share one Brand
// (different episodes, same channel). Future steps (#5 pronunciation
// lexicon, #1 analytics persona, #3 comment-reply tone) hang off this.
//
// Resolution chain (extends today's Format chain):
//   base format → brand.format_overrides → project.format_overrides
//
// Brand also exposes direct fields the generators read at specific call
// sites (channel name, voice fallback, banned words). Those bypass the
// merge — they're consumed where they apply.
//
// User-defined brands live at ${PROJECTS_ROOT}/.brands/{id}.json. No
// built-in brands ship — brands are inherently per-channel.

export interface BrandChannel {
  /** Channel name. Replaces any literal channel-name reference in
   *  metadata templates via {channel_name} placeholder. */
  name?: string
  youtube_url?: string
  /** Channel handle, e.g. "@channelname". */
  handle?: string
}

export interface BrandColorPalette {
  primary?: string
  accent?: string
  background?: string
}

export interface BrandVisual {
  /** Absolute path to the channel logo on disk. Defaults the
   *  video-assembly logo when the project hasn't overridden. */
  logo_path?: string
  color_palette?: BrandColorPalette
  /** e.g. "Inter" — feeds video-assembly text styling. */
  font_family?: string
}

export interface BrandVoiceSettings {
  stability?: number
  similarity?: number
  speed?: number
}

export interface BrandNarration {
  /** 1-3 sentences. Prepended to the LLM system prompt for ideas /
   *  scripts / metadata when present. */
  persona?: string
  /** Default ElevenLabs (or other TTS provider) voice id. Used when
   *  the project hasn't picked a preset for the episode. */
  default_voice_id?: string
  default_voice_settings?: BrandVoiceSettings
}

export interface BrandImagePrompts {
  /** Tokens prepended to every image prompt, e.g. ["cinematic", "moody"]. */
  style_keywords?: string[]
  /** Long-form style reference appended as a "Style reference:" block. */
  style_sheet?: string
  negative_prompts?: string[]
}

export interface BrandMetadata {
  /** Boilerplate ending appended to YouTube descriptions. */
  description_outro_template?: string
  /** Format string for music/asset credits, e.g.
   *  "Music: {track_name} by {artist} — {license}". */
  attribution_template?: string
  /** Post-generation flag list. Matches surface as warnings (don't block). */
  banned_words?: string[]
}

/**
 * One entry in a brand's pronunciation lexicon. Applied as a pre-TTS
 * substitution pass on the narration text so a single mispronounced
 * proper noun doesn't force a full re-render.
 *
 * Match semantics (see lib/pronunciation.ts):
 *   - Word-boundary match for ASCII-only terms (so "Sok" inside
 *     "Sokhom" is left alone).
 *   - Substring match for terms containing non-ASCII characters (\b
 *     is ASCII-only and would skip valid Khmer / accented matches).
 *   - Case-insensitive by default. Set `case_sensitive: true` for
 *     terms where casing matters (rare).
 *
 * Replacement priority on TTS time: SSML (if provider supports + ssml
 * field is set) → alt_spelling → ipa-as-alt-spelling. Today only
 * alt_spelling is wired; ssml + ipa are stored for forward-compat.
 */
export interface BrandPronunciation {
  /** The word as it appears in the script (e.g. "Sokhom"). Required. */
  term: string
  /** TTS-friendly respelling (e.g. "Soh-Khohm"). Primary substitution. */
  alt_spelling?: string
  /** IPA notation (e.g. "/sɔːkˈhɔːm/"). Stored, not yet applied. */
  ipa?: string
  /** Full SSML override (e.g. <phoneme alphabet="ipa" ph="...">…</phoneme>).
   *  Stored, not yet applied — wiring deferred until SSML support lands
   *  in our TTS provider clients. */
  ssml?: string
  /** Default false. Match case-insensitively unless this is true. */
  case_sensitive?: boolean
}

export interface Brand {
  /** Stable slug, unique within ${PROJECTS_ROOT}/.brands/. */
  id: string
  /** Display name. */
  name: string
  schemaVersion: 1

  channel?: BrandChannel
  visual?: BrandVisual
  narration?: BrandNarration
  imagePrompts?: BrandImagePrompts
  metadata?: BrandMetadata

  /** Pre-TTS substitution table. See BrandPronunciation. */
  pronunciation_lexicon?: BrandPronunciation[]

  /** Optional: this brand's preferred Format for new projects. */
  format_default_id?: string

  /** Format overrides applied between base format and project.format_overrides. */
  format_overrides?: DeepPartial<Format>
}

// ── Pattern primitive (Phase 4b of format/character/pattern system) ────────
//
// Pattern is the EPISODE-shape layer that composes ON TOP of Format. Format
// gives the channel-level vibe (Sleep / Adventure / Educational); Pattern
// gives the per-episode shape ("Fall asleep to X", "What it's like to be
// born as X", "The entire history of X explained"). Patterns cut across
// formats — "History of X explained" works for educational, comedy, sleep,
// and true crime alike. So they're a separate primitive picked at episode
// generation time, not at project setup time.
//
// Composition (in prompt-assembler.ts):
//   1. Format provides systemPromptRole + production rules + narrator pool
//   2. Pattern's openingDevice prepends to the body
//   3. Pattern's bodyStructure (when set) REPLACES format.script.pacingArc
//   4. Pattern's closingDevice appends to the final chapter instructions
//   5. Pattern's metadataKeywordAdditions extend the broad-keyword pool
//
// Built-in patterns ship at electron/server/patterns/{id}.json (extraResources
// entry mirrors formats). User-custom at ${PROJECTS_ROOT}/.patterns/{id}.json.

// ── Character primitive (Phase 5 of format/character/pattern system) ──────
//
// Character is the persistent CAST entity. The script generator stops
// inventing names every episode; the LLM is told the character roster
// (by name + description) and instructed to use them. The image generator
// gets consistent character descriptions per scene. Optional speech.voiceId
// enables per-character voice routing in Phase 6 (multi-character episodes).
//
// Storage: ${PROJECTS_ROOT}/${slug}/characters/{character-id}/character.json
//   plus reference image files alongside (referenced by relative paths so
//   the project folder stays self-contained for cross-machine transfer).
//
// Scope determines reuse — see the Character interface JSDoc for the full
// promotion model.

export interface CharacterSpeech {
  /** Free-form tonation hint injected into the script prompt (e.g. "soft, slow, contemplative"). */
  tonation?: string
  /** TTS provider voice id (e.g. ElevenLabs voice id). Phase 6 routing reads this. */
  voiceId?: string
  /** Provider id matching the voice — 'elevenlabs' | 'fal' | 'genaipro'. Optional; lets multi-provider projects route correctly. */
  voiceProvider?: string
}

export interface CharacterReferences {
  /** Relative paths (from the character folder) to reference image files. Phase 7 image-gen integration consumes these. */
  images?: string[]
  /** Style keywords appended to image prompts when this character appears (e.g. "cel-shaded", "photoreal"). */
  style_keywords?: string[]
}

export interface Character {
  /** Stable slug — file-system safe. */
  id: string
  /** Display name; flows into prompts verbatim ("Aria the Knight"). */
  name: string
  /** Free-text role: 'protagonist' | 'mentor' | 'antagonist' | 'narrator' | custom. */
  archetype?: string
  /** Physical + personality description; flows into prompts verbatim. */
  description: string

  /**
   * Scope determines reuse:
   *   'episode'  — bound to listed episode_codes only. Most common case
   *                (1 character per episode, never reused). Cheap to
   *                create + discard via the inline "+ Quick character"
   *                shortcut on the script page.
   *   'project'  — available to every episode in the project. The "brand
   *                character" / channel mascot use case. Auto-included
   *                in every episode's picker.
   *   'library'  — sourced from the global library; copied into the
   *                project on import. After copy, source becomes
   *                'imported' and scope becomes 'project'.
   *
   * Promotion (one click in the UI):
   *   episode → project: drop episode_codes
   *   project → library: copy to ${PROJECTS_ROOT}/.character-library/
   */
  scope: 'episode' | 'project'
  /** Required iff scope === 'episode'. */
  episode_codes?: string[]

  speech?: CharacterSpeech
  references?: CharacterReferences

  /** Provenance — purely informational, set on create + persists across edits. */
  source: 'project' | 'imported'
  schemaVersion: 1
  created_at: string
}

export interface Pattern {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1

  /** Title template with {X} placeholder — e.g. 'Fall asleep to {X}'. */
  titleTemplate: string

  /** Human label for what {X} represents in the picker UI. */
  subjectLabel: string

  /** Narrative POV the LLM should adopt. */
  pov: 'first' | 'second' | 'third' | 'mixed'

  /** Instruction prepended to the script body — sets the opening device. */
  openingDevice: string

  /**
   * Per-chapter body shape. When set, OVERRIDES format.script.pacingArc.
   * `{X}` is substituted with the user's subject. `{lastButOne}` and
   * `{last}` are substituted with chapter numbers (same as Format).
   */
  bodyStructure?: string[]

  /** Instruction appended to the final-chapter instructions. */
  closingDevice: string

  /** Suggested length range — when set, tightens format.script.lengthMinutesRange. */
  suggestedLengthMinutes?: [number, number]

  /** Empty array = works with any format. Otherwise lists format ids that pair best. */
  preferredFormats?: string[]

  /** Tags appended to the metadata broad-keyword pool when this pattern is used. */
  metadataKeywordAdditions?: string[]
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
  // (Removed: portable. Legacy multi-machine flag — accepted on the
  // wire for back-compat with old clients but ignored by createProject.)
  portable?: boolean
  /**
   * v1.0.68+: optional starter format for the new project. Picked
   * via the Channel Format card grid in the Create Project wizard.
   * Persisted to the project meta as `format_id`; if unset, falls
   * through to the legacy default ('sleep-story').
   */
  format_id?: string
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
  // (Removed: portable. Accepted on the wire for back-compat; updateProject
  // ignores it. Cloud sync is now configured app-wide via Storage tab.)
  portable?: boolean
  youtube_channel_url?: string
  format_id?: string
  format_overrides?: DeepPartial<Format>
  brand_id?: string
}

/**
 * iCloud-aware sync state for a project candidate.
 *
 *   'ready'       — project.json + config.json read successfully.
 *   'downloading' — project.json is an iCloud placeholder OR the read
 *                   timed out (30s). All metadata fields except `slug`
 *                   and `output_root` may be empty/absent. The home page
 *                   renders these as greyed-out rows with a "Syncing
 *                   from iCloud" pill, and polls /api/projects every 5s
 *                   until they promote to 'ready'.
 *   'error'       — corrupt JSON, permission denied, etc. The home page
 *                   shows a red pill (existing error path).
 *
 * Absent/undefined `status` from older backend builds is treated as
 * 'ready' by the frontend so cross-version response shapes stay safe.
 */
export type ProjectSummaryStatus = 'ready' | 'downloading' | 'error'

export interface ProjectSummary {
  name: string
  slug: string
  episode_prefix: string
  created_at: string
  has_api_keys: boolean
  // (Removed from new responses: portable. Optional field stays in the
  // type so old client builds parsing the response don't break.)
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
  /** iCloud sync state — see `ProjectSummaryStatus`. */
  status?: ProjectSummaryStatus
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Variant tier for variable-priced image models — lets one entry describe
 * a model whose cost depends on resolution (1K/2K/4K), rendering speed
 * (turbo/balanced/quality), or any other axis the provider charges for.
 *
 * Only models with multiple price points need `tiers`. Flat-priced models
 * keep using `credits_per_image` alone — readers fall back to it when no
 * `tier` is specified in the request, and `default_tier` mirrors that
 * legacy value for the variable-priced case.
 */
export interface ImageModelTier {
  /** Stable id used in API requests (e.g. '1k', '4k', 'turbo'). */
  id: string
  /** Display label for the tier picker (e.g. '1K', 'Turbo'). */
  label: string
  /** Credits charged per image in this tier. */
  credits: number
}

export interface ImageModelConfig {
  label: string
  /**
   * Default cost per image. For variable-priced models with `tiers`, this
   * mirrors the credits of `default_tier` so legacy callers (no tier in
   * request) get a sensible default. The cost calculator looks up
   * `tiers[tier_id].credits` first, then falls through to this.
   */
  credits_per_image: number
  /**
   * Optional price tiers. When present, the UI renders a tier picker
   * (resolution / speed / etc.) and the cost calculator routes requests
   * to the tier-specific credit cost. Absent = single flat price.
   */
  tiers?: ImageModelTier[]
  /** Tier id whose credits == credits_per_image. Required when `tiers` is set. */
  default_tier?: string
  endpoint: string
  poll: string
  type: string // 'jobs' | 'flux' | '4o' | 'gpt-image'
  api_model: string
  /**
   * Phase 8 — declares this model accepts reference images for img2img /
   * Flux Kontext / IP-Adapter-style character consistency. When true, the
   * image generator forwards `referenceImagePaths` from the request into
   * the provider call. When false/absent, references are silently ignored
   * (text-only generation). The CharacterPicker UI surfaces this so users
   * know which models will actually consume their character refs.
   */
  supports_reference_images?: boolean
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
  provider?: 'fal' | 'genaipro' | 'elevenlabs' | 'chatterbox'
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

/**
 * User-saved image-style description, typically captured from
 * `/analyze-style` (vision-LLM extraction off a reference image) and named
 * for reuse across episodes. The dropdown on image-prompts.vue shows
 * these in a "Custom" optgroup beside the built-in style presets.
 *
 * Stored on ProjectConfig (per-project) — not a global library — because
 * style choice is tightly coupled to a channel's brand identity. A future
 * audit might add a project → library promotion flow, but YAGNI today.
 */
export interface StylePreset {
  /** File-system-safe slug. Generated server-side from the name on save. */
  id: string
  /** Display name shown in the picker (e.g. "Watercolor sunset"). */
  name: string
  /** The full multi-sentence style description that gets folded into image prompts. */
  description: string
  /** Vision model that produced the description, if extracted via /analyze-style. Free-form for manually-typed presets. */
  source_model?: string
  /** Reference image relative path (project-portable), if the description was derived from one. Cleared when the project is exported. */
  source_reference?: string
  /** ISO timestamp of creation. */
  created_at: string
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
  /**
   * Per-project gate for the self-hosted Chatterbox TTS provider. Off by
   * default so the chatterbox-* models stay hidden from projects that
   * don't use it. Base URL itself lives per-machine in the app secrets
   * store under provider id `chatterbox` (so moving the project to a
   * machine without Tailscale doesn't carry a stale URL).
   */
  chatterbox_enabled?: boolean
  /** Reference clip UUID returned by Chatterbox's /api/upload-reference. */
  chatterbox_reference_id?: string
  /**
   * YouTube videoCategories.list ID applied to every fresh upload
   * + metadata-only PATCH for this project. Default 22 ("People &
   * Blogs") for back-compat. Set per-project on Settings → Project.
   * See [docs/upload-backlog.md] item J.
   */
  category_id?: number
  image_models: Record<string, ImageModelConfig>
  image_pricing_last_updated: string
  voice_presets: VoicePreset[]
  /** Per-project list of favourited voice_ids, pinned to the top of the picker. */
  voice_favourites?: string[]
  /** User-saved image-style descriptions (typically from `/analyze-style`). */
  style_presets?: StylePreset[]
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
  chatterbox_enabled?: boolean
  chatterbox_reference_id?: string
  image_models: Record<string, ImageModelConfig>
  image_pricing_last_updated: string
  voice_presets: VoicePreset[]
  voice_favourites?: string[]
  style_presets?: StylePreset[]
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

export type JobType = 'script-only' | 'introduction-only' | 'chapter-only' | 'image_prompts' | 'images' | 'scene_images' | 'thumb_images' | 'images_repair' | 'audio' | 'audio_merge' | 'metadata' | 'video' | 'video_repair' | 'video_assembly' | 'subtitles_transcribe' | 'youtube_upload' | 'youtube_playlist_update'
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
  /**
   * Live transfer metrics for jobs that move bytes (YouTube uploads, asset
   * downloads). All four fields are optional and additive — missing on jobs
   * that don't transfer anything, and on rehydrated jobs from before the
   * field shipped. The job `type` disambiguates direction (upload vs
   * download); UI labels accordingly.
   */
  bytes_done?: number
  bytes_total?: number       // undefined when Content-Length absent → indeterminate UI
  speed_bps?: number          // rolling 5-second average
  eta_seconds?: number        // undefined when bytes_total unknown
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
  /**
   * Optional pattern preset to apply to title style. When set, the
   * idea-generator prompt instructs the LLM to produce titles that
   * match the pattern's titleTemplate (e.g. "Fall asleep to {X}").
   * Empty / unset = LLM uses its default freeform titling.
   */
  pattern_id?: string
  /**
   * Optional subject filler for the pattern's {X} placeholder. Used as
   * a hint to the LLM ("the {X} value should be a place / era / etc.")
   * — generated ideas substitute real concrete values per-title rather
   * than literally "{X}". Ignored when pattern_id is empty.
   */
  pattern_subject?: string
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
  /**
   * Pattern primitive (Phase 4b): when set, the script generator composes
   * the named Pattern (episode template) on top of the project's effective
   * Format. `pattern_subject` is the {X} value the pattern's titleTemplate
   * substitutes ("London" for "The entire history of London explained").
   * Both optional — generation works without a pattern.
   */
  pattern_id?: string
  pattern_subject?: string
  /**
   * Character primitive (Phase 5): when set, the script generator passes
   * the named cast into the prompt — the LLM uses these names + descriptions
   * instead of inventing characters. Empty array = today's "LLM invents
   * the cast" behavior (back-compat). Image-prompt generation also folds
   * each character's description into the per-scene prompts.
   */
  character_ids?: string[]
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
  /** Per-scene chapter assignment for chapter-aligned video assembly
   *  (Workstream B + per-scene swap, v1.0.57+). When set on every
   *  scene, the backend groups scenes by `chapter_slug` instead of
   *  positional even-splitting them across chapters. Frontend reads
   *  this from `${episode}/scene_chapter_assignments.json` and stamps
   *  it on each scene before sending the assembly payload.
   *  Optional — old projects without it fall back to even-split. */
  chapter_slug?: string
  /** Echoed-through scene number (1-based) so the backend can quote
   *  it in alignment plan logs without re-deriving from index. */
  scene_number?: number
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
  /** Animation preset (v1.0.56+). Default 'none' keeps the legacy
   *  static drawtext exactly as before — no animation, just hard
   *  on/off via `enable=` gate. Other values transform the title's
   *  alpha or x/y coordinates over the first or last `animation_duration`
   *  seconds for a smoother enter/exit. Zoom is intentionally NOT
   *  offered — drawtext fontsize is static; zoom would require an
   *  extra render pass and isn't worth the complexity for a chapter
   *  card that's only on screen for a few seconds. */
  animation?: 'none' | 'fade-in-out' | 'slide-from-left' | 'slide-from-right' | 'slide-up'
  /** Animation transition seconds. For fade-in-out, applied to BOTH
   *  enter and exit (so total fade time is 2× this value). For slide
   *  presets, this is the duration of the slide-in only — exit is
   *  hard-cut at `duration` end. Default 0.5; clamped at runtime to
   *  `duration / 2` so a fade can never overlap itself. */
  animation_duration?: number
}

export interface VideoBackgroundMusic {
  path: string
  volume: number       // 0-1
  fade_in: number      // seconds
  fade_out: number     // seconds
  duck_narration: boolean  // lower music when narration plays
}

// ── YouTube Comments ───────────────────────────────────────────────────────
//
// Normalized shape for YouTube commentThreads — exposes the top-level
// comment + a slice of its replies for the Comments inbox tab. The
// reply assistant produces 1-3 LLM-drafted candidates that the user
// can edit and post via the same client.

export interface CommentReply {
  /** YouTube comment id — needed when posting a reply (parentId). */
  id: string
  author: string
  /** Avatar URL (small, square). May be empty for some authors. */
  author_avatar?: string
  /** Plain-text content. We deliberately use textOriginal (not textDisplay)
   *  to avoid baking YouTube's HTML-escaped + auto-linked output back into
   *  prompts and reply UIs. */
  text: string
  like_count: number
  published_at: string
  updated_at: string
}

export interface CommentThread {
  /** YouTube commentThread id (different from the comment id). */
  id: string
  video_id: string
  /** The top-level comment that started this thread. */
  top_comment: CommentReply
  /** Total reply count YouTube knows about; may exceed `replies.length`
   *  when we capped pagination. */
  reply_count: number
  /** Most-recent N replies (capped at 5 in v1). */
  replies: CommentReply[]
  /** Whether the channel can post a reply on this thread. False on
   *  threads where commenting is disabled or restricted. */
  can_reply: boolean
  /** False when the comment is held for review or marked spam. UI hides
   *  these to avoid wasting a reply on a comment the public can't see. */
  is_public: boolean
}

export interface CommentThreadsResult {
  /** ISO-8601 timestamp the snapshot was fetched. */
  fetched_at: string
  video_id: string
  threads: CommentThread[]
  /** True when there are more threads beyond `threads.length`. v1 caps at
   *  one page (100 threads) so this surfaces "open in YouTube for the rest". */
  has_more: boolean
}

// ── YouTube Analytics ──────────────────────────────────────────────────────
//
// Per-episode performance metrics fetched from the YouTube Analytics API.
// Surfaced on the Upload Center → Analytics tab and fed back into the Ideas
// + Metadata generators as few-shot examples ("here's what worked").
//
// Stored cache key: ${userData}/analytics-cache/{slug}_{accountId}.json
// (per-machine, not synced across iCloud — analytics pull from the API
// freshly per machine).

export interface EpisodeAnalytics {
  /** YouTube video id (matches the upload sidecar). */
  video_id: string
  /** Title at the time of fetch (snapshot — channel renames don't propagate). */
  title: string
  /** ISO-8601 publish timestamp from YouTube. */
  published_at: string
  /** Total views in the requested date range. */
  views: number
  /** Total minutes watched in the requested date range. */
  watch_minutes: number
  /** Average view duration (seconds) — engagement quality signal. */
  avg_view_seconds: number
  /** Average percentage of the video watched (0-100) — retention signal. */
  avg_view_percentage: number
  /** Click-through rate from impressions (0-100). May be undefined when
   *  YouTube hasn't computed it (very new videos / restricted accounts). */
  ctr_percentage?: number
  /** Total impressions in the date range. */
  impressions?: number
  likes: number
  comments: number
  shares: number
}

export interface AnalyticsResult {
  /** ISO-8601 timestamp of when this snapshot was fetched from YouTube. */
  fetched_at: string
  /** Date range honoured by YouTube (inclusive). */
  start_date: string
  end_date: string
  /** Per-video rows, sorted by views descending. */
  rows: EpisodeAnalytics[]
  /** Channel-level totals across the same date range, for the dashboard
   *  header card. Optional — older cached results from before this field
   *  shipped won't have it. */
  totals?: {
    views: number
    watch_minutes: number
    avg_view_percentage: number
  }
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
 * Common fields every timeline clip carries regardless of source kind.
 * Existing presets predate the discriminator and do NOT carry a `kind`
 * field; readers MUST treat absence as `'video'` so old configs keep
 * working without a migration write.
 */
interface VideoTimelineClipBase {
  /** Stable identifier for drag-reorder and row tracking. */
  id: string
  anchor: TimelineAnchor
  /** Per-row on/off so a preset can carry a clip without forcing it
   *  into every episode that uses the preset. */
  enabled: boolean
}

/**
 * The original video-source timeline clip — a user-supplied .mp4/.mov
 * inserted at a named position. The pipeline normalises it to match
 * the project resolution/fps, strips audio (`-an`), and concats it
 * alongside the scene clips.
 */
export interface VideoTimelineClipVideo extends VideoTimelineClipBase {
  /** Discriminator. Optional for back-compat with presets saved before
   *  the static variant existed — readers default missing kind to 'video'. */
  kind?: 'video'
  video_path: string
}

/**
 * Static-image timeline clip — the operator points at a single still
 * image plus a duration; the pipeline synthesises the segment via
 * `ffmpeg -loop 1 -i image.jpg -t <dur>` instead of re-encoding a
 * pre-rendered multi-hour MP4. Result: drastically smaller intermediate
 * files (≈10-20 MB for 2 hours of static at 1080p instead of ≈2 GB),
 * near-instant prep wall-clock (libx264 emits effectively-empty
 * P-frames after the first keyframe), and a much faster authoring
 * loop (swap the image instead of re-rendering).
 *
 * Audio for this segment is NOT carried by the clip — like every
 * timeline clip, audio is stripped during prep. The post-narration
 * ambient/music tail comes from the separate `music` config (which
 * already loops via `-stream_loop -1`).
 */
export interface VideoTimelineClipStatic extends VideoTimelineClipBase {
  kind: 'static'
  /** Path to the still image (JPG/PNG/WebP). */
  image_path: string
  /** How long to display the image, in seconds. */
  duration_sec: number
}

/**
 * A user-supplied timeline clip inserted at a named position in the
 * final render. Multiple clips sharing the same anchor play in list
 * order. Like `VideoOutroConfig`, these are ALWAYS effect-free — the
 * existing `sceneEndTime` gate covers after_scenes/after_outro;
 * video.ts extends the head-of-video gate to cover
 * before_intro/after_intro.
 *
 * Portable-path token support (`${PROJECT}/foo`, `${NAME}/bar`) is
 * inherited from `resolveAssetPath` — saved presets travel across
 * machines without rewriting.
 */
export type VideoTimelineClip = VideoTimelineClipVideo | VideoTimelineClipStatic

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

// Overlay layers — generalisation of the legacy single-slot
// `chroma_key` field. Each layer composites a video / image / GIF on
// top of the base render. Layers stack in array order (index 0 first,
// drawn under later layers). Sources with native alpha (`.mov` ProRes
// 4444, `.webm` VP9, RGBA `.png`, `.gif`) skip chroma-key entirely;
// sources without alpha use the per-layer chroma_key block.
//
// The legacy `chroma_key` field is still accepted for one release —
// the request handler synthesises a single-layer overlay from it
// before the filter-graph step so renders stay byte-identical for
// existing projects.
export interface VideoOverlay {
  /** Stable id for ordering / removal (UUID or short hash). */
  id: string
  enabled: boolean
  /** Resolved via existing `resolveAssetPath` (handles portable + bundled prefixes). */
  source_path: string
  /** Optional. Omit / null when the source has native alpha. */
  chroma_key?: { color: string; similarity: number; blend: number } | null
  /** 0..1, default 1. Wired via `colorchannelmixer=aa=…` like the logo overlay. */
  opacity?: number
  /** How to fit the source into the output canvas. Default 'cover' (fills frame). */
  scale?: 'cover' | 'contain' | 'native'
  /** Percentage-of-canvas-width scaling (v1.0.63+). When set, takes
   *  precedence over `scale`. Height is computed to preserve aspect
   *  ratio (`-1` in the FFmpeg scale filter). Used by compilation-mode
   *  scene foregrounds; not surfaced in the manual overlay UI. */
  scale_pct?: number
  /** FFmpeg overlay-filter `x:y` coordinates as expressions. Default '0:0'. */
  position?: { x: string; y: string }
  /** Named position anchor (v1.0.63+). When set, overrides `position`
   *  with auto-computed centred/anchored coordinates that account for
   *  the (potentially scaled) source dimensions. Used by compilation-
   *  mode foregrounds. */
  position_anchor?: ForegroundPosition
  /** Optional time-range. Combined with the global effects gate (intro/outro). */
  time_range?: { start_s: number; end_s: number | null }
  /** When true (default), short clips repeat to fill the timeline (`-stream_loop -1`). */
  loop?: boolean
}
export interface VideoOverlaysConfig {
  enabled: boolean
  layers: VideoOverlay[]
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

/**
 * Compilation video layout (v1.0.63+ / Path C, BrainWise channel mode).
 *
 * Two layouts now coexist in the pipeline:
 *
 *  - 'standard' — base video built from scene clips concatenated together.
 *    Each scene fills the full canvas, optionally with Ken Burns / fade /
 *    chapter-title drawtext on top. The original sleep-story model.
 *
 *  - 'compilation' — base video is a looping background plate (typically
 *    a starfield .mp4). Scene images render as time-bound overlays
 *    centred (or anchored) inside the frame, sized to a percentage of
 *    canvas width. Each chapter gets one scene image; its overlay is
 *    enabled only during that chapter's narration time-range. Suitable
 *    for listicle / explainer / "100 X explained" channels where each
 *    topic is independent and the visual continuity comes from the bg.
 *
 * Sleep stories stay 'standard' — the byte-identical regression check
 * for that path is part of Chunk A's verification.
 */
export type VideoLayout = 'standard' | 'compilation'

export interface BackgroundPlate {
  enabled: boolean
  /** Absolute path to a video or image. Videos loop via -stream_loop -1
   *  to fill the total duration. Images are still-rendered. */
  source_path: string
  loop: boolean
  opacity: number       // 0-1, default 1
}

export type ForegroundPosition = 'center' | 'top-third' | 'bottom-third' | 'lower-right' | 'lower-left'

export interface ForegroundDefaults {
  /** Foreground width as a fraction of the canvas width. Height is
   *  scaled to preserve aspect ratio. 0.1–0.8; default 0.5 (half frame). */
  scale_pct: number
  position: ForegroundPosition
  /** Optional chroma-key for foregrounds with a solid background.
   *  Default: white-key at 0.15 similarity / 0.10 blend. Set to null
   *  if the foreground sources have a real alpha channel. */
  chroma_key?: { color: string; similarity: number; blend: number } | null
}

// Multi-track ambient layering (v1.0.55+). Each entry is one ambient
// loop (rain, fire crackle, wind, distant thunder) that gets its own
// volume, fade, and loop control. Layered together via FFmpeg amix
// alongside narration + music + the legacy single background_noise.
//
// Distinct from `VideoMusicConfig.files`, which is multiple files
// CONCATENATED (one after another) at one shared volume — useful for
// long-playlist music. Ambient tracks are PARALLEL streams playing
// simultaneously — the model that lets "rain + fire" coexist.
//
// Per-track ducking under narration and per-track time-range gating
// are intentionally deferred to v2; the existing music ducking is
// usually enough for sleep-story scenes.
export interface AmbientTrack {
  /** Stable id for ordering / removal. */
  id: string
  enabled: boolean
  source_path: string     // absolute path; portable schemes resolve via resolveAssetPath
  volume: number          // 0-1
  fade_in: number         // seconds
  fade_out: number        // seconds
  /** When true (default), short clips repeat to fill the timeline. */
  loop?: boolean
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
   *  the encoder has more time to find savings. `hardware` routes the
   *  encode through Apple's Media Engine via h264_videotoolbox — ~8-15×
   *  faster than libx264 medium on M-series Macs, with a small file-size
   *  penalty that's invisible on sleep-story-style footage. Defaults
   *  mirror the legacy quality→preset mapping when omitted. */
  encoding_effort?: 'ultrafast' | 'medium' | 'slow' | 'hardware'
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
  audio_gap?: number                // seconds of silence between narration chapters, default 5
  narration_chapters?: string[]     // individual chapter audio file paths (for gap insertion)
  merged_audio_path?: string        // path to pre-merged audio from audio-merge step (skips chapter concat)
  narration_volume?: number         // 0-1, default 1.0
  background_noise?: VideoBackgroundNoise
  color_grading?: VideoColorGrading
  vignette?: VideoVignetteConfig
  chroma_key?: VideoChromaKeyConfig
  /** Multi-layer overlay system (v1.0.53+). Replaces the single-slot
   *  `chroma_key` field, which is still accepted for one release for
   *  backward compatibility. */
  overlays?: VideoOverlaysConfig
  /** Compilation-mode video layout (v1.0.63+). When 'compilation', the
   *  base video is a looping background plate and scene images render
   *  as chapter-aligned foreground overlays. Default 'standard'
   *  (legacy scene-clip pipeline, byte-identical). */
  video_layout?: VideoLayout
  /** Looping background plate for compilation mode. Required when
   *  video_layout === 'compilation'. */
  background_plate?: BackgroundPlate
  /** Foreground sizing + positioning defaults for compilation mode. */
  foreground_defaults?: ForegroundDefaults
  /** When true, scene clips are partitioned across chapters and each
   *  chapter's assigned scenes cycle within its own audio duration —
   *  i.e. chapter N's narration plays with chapter N's scene images.
   *  Off by default (sleep-story safe; chapter alignment is the new
   *  content-type feature, not the old loose-cycling default).
   *  Requires `chapter_durations` to be populated; falls back to
   *  legacy uniform cycling if missing. */
  align_visuals_to_chapters?: boolean
  /** Per-chapter audio durations in playback order. Frontend reads
   *  these from `${episode}/audio_chapters.json` (written by the
   *  Audio Merge step) and forwards on the request so the backend
   *  doesn't need to re-probe. */
  chapter_durations?: Array<{ slug: string; duration_s: number }>
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
  /** Multi-track ambient layering (v1.0.55+). Each entry plays in
   *  parallel — drop in rain + fire + distant thunder simultaneously.
   *  Mixed alongside narration/music/background_noise via FFmpeg amix. */
  ambient_tracks?: AmbientTrack[]
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

// Models that the OpenAI-key check would otherwise mark "available" but
// the user's account can't actually call. The frontend treats any model
// with a reason here as disabled and shows the reason as a tooltip.
// Edit this map (or remove an entry) once account access changes.
export const KNOWN_UNAVAILABLE_REASONS: Record<string, string> = {
  'gpt-5':      'Your OpenAI account does not have GPT-5 access. Use GPT-4o or Claude.',
  'gpt-5-mini': 'Your OpenAI account does not have GPT-5 access. Use GPT-4o-mini or Claude Haiku.',
}
