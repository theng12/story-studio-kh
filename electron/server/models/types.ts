/**
 * All TypeScript interfaces — ported from Python Pydantic models.
 */

import type { GenStudioRequestPreview } from '../lib/genstudio-request-preview.js'
import type { ContentPackProvenance } from '../content-packs/runtime-types.js'
import type { ContentPackItemKind } from '../content-packs/types.js'
import type { MotionScope } from '../contracts/motion-scope.js'
import type { ScenePacing, ScenePacingPeriod } from '../contracts/pacing.js'
import type { ContextualCueCorner } from '../contracts/contextual-cue-position.js'
import type { SketchHoldSetting } from '../lib/sketch-hold.js'
import type { SketchRevealSetting, SketchRevealType } from '../lib/sketch-reveal.js'
import type { AssignedPipelineModelPolicy, PipelinePolicyCheckpointStore } from '../lib/pipeline-model-policy.js'

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
  /** v1.0.469 — per-scene image-to-video CLIPS (Phase 2 of the motion-prompt
   *  feature). Heavy media (mp4s), so it migrates to the external media_root
   *  like images/video. Optional in stored project.json (older projects won't
   *  carry it) — readers must tolerate `undefined`. */
  video_assets: string
}

/** Linkage metadata: which generator produces which folder */
export const SUBFOLDER_LINKAGE: Record<keyof SubfolderNames, { label: string; generator: string; order: number }> = {
  script:        { label: 'Script',               generator: 'Script Generator',          order: 1 },
  metadata:      { label: 'YouTube Metadata',     generator: 'YouTube Finalizer',          order: 2 },
  scene_prompts: { label: 'Scene Prompts',        generator: 'Image Prompts Generator',   order: 3 },
  thumb_prompts: { label: 'Thumbnail Prompts',    generator: 'Image Prompts Generator',   order: 4 },
  images:        { label: 'Scene Images',         generator: 'Image Generator (Scenes)',  order: 5 },
  thumbnails:    { label: 'Thumbnail Images',     generator: 'Image Generator (Thumbs)',  order: 6 },
  audio:         { label: 'Audio Assets',         generator: 'Audio Generator (TTS)',     order: 7 },
  merged_audio:  { label: 'Audio Merge Output',   generator: 'Audio Assembly',            order: 8 },
  subtitles:     { label: 'Subtitles Output',     generator: 'Video Assembly (Subtitles)', order: 9 },
  video:         { label: 'Video Assembly Output', generator: 'Video Assembly',           order: 10 },
  video_assets:  { label: 'Video Assets',          generator: 'Scene Animator (i2v)',      order: 11 },
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
  video_assets:  '{code} - 11 Video Assets',
}

/**
 * The channel's audience-facing content language. Two values only: the
 * catalogue is deliberately not open-ended. An absent value keeps legacy
 * prompts byte-identical (English by convention, never an explicit directive).
 */
export type ContentLanguage = 'en' | 'km'

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
  // (Removed: output_root.) A channel's episodes always live at
  // `<projectDir>/episodes` — the channel's own folder — and that is now
  // computed, never stored. The flexible version let a project name any
  // folder it liked, which is how "Origin Field" came to point at
  // `../Origin Field/episodes`: a folder that did not exist, so the channel
  // rendered empty with nothing to explain it. A setting whose only observed
  // value across every real project was the default, and whose one
  // non-default use was a bug, is not a capability.
  // See `resolveOutputRoot()` in services/project-manager.ts.
  // Existing project.json files in the wild still carry the key; it is simply
  // ignored — never read, never rewritten.
  /**
   * Optional (Level B, opt-in). When set — a portable Named-Root token like
   * `${MEDIA}` or an absolute path — the HEAVY media subfolders (scene images,
   * thumbnails, audio, merged audio, final video) are written under this root
   * instead of the episodes folder, while light artifacts stay in the iCloud
   * project tree. Absent (the default) = everything under the episodes folder,
   * unchanged. See services/media-root.ts + docs/external-media-root-spec.md.
   */
  media_root?: string
  created_at: string
  /** Exact immutable versions selected by this project. Older projects omit
   * this and continue through the legacy catalog unchanged. */
  content_pack_versions?: Record<string, string>
  /** Qualified selected item → owning pack/kind. Kept separately from the
   * version map so an imported project can name an unavailable requirement
   * without guessing from an item id. */
  content_pack_items?: Record<string, { pack_id: string; kind: ContentPackItemKind }>
  /** Canonical signed selections mirrored from config in the same coordinated
   * transaction. Legacy/local ids may be stored here but create no pack pin. */
  active_style_preset_id?: string
  thumbnail_template_id?: string
  youtube_channel_url?: string

  /**
   * Free-text labels the owner gives this channel — "Khmer", "Sleep",
   * "History" — so the start page can search, filter and sort by what a
   * channel is rather than only by what it is called. Absent = no labels.
   *
   * Written only through `updateProject` (`UpdateProjectSchema`), which
   * normalises them: trimmed, whitespace-collapsed, empty dropped,
   * case-insensitively de-duplicated with the first spelling kept, and bounded
   * by both ceilings in `contracts/project-labels.ts`. A label is the owner's
   * own word and is never re-cased or re-ordered for him.
   */
  labels?: string[]

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
  /** One rendering engine serves every channel. This default determines how
   * fresh episode Continuity settings begin; per-episode Character Sheet
   * settings can still refine it. */
  continuity_mode?: 'character-continuity' | 'independent-stills' | 'explainer-stills'

  /**
   * Audience-facing language for generated prompts. Absent = legacy, no
   * directive (byte-identical to pre-1.4.320 prompts). The project setting
   * outranks the language of recipe examples/style references; those stay
   * authoritative for structure and voice only.
   */
  content_language?: ContentLanguage | null

  /**
   * Future-only introduction activation. Default OFF (absent/false): no
   * episode is given an automatic opening. When true, episodes created from
   * this point capture `intro_eligible: true` in their `episode_info.json`;
   * only those episodes ever receive the automatic Pipeline step. Existing
   * episodes are never backfilled or gated for a missing introduction.
   */
  auto_introduction_enabled?: boolean

  /**
   * Niche primitive — subject-domain layer orthogonal to Format. Format
   * answers "what shape of video" (reasons-explainer, sleep-story, listicle);
   * Niche answers "what subject domain" (plants, animals, fungi, insects).
   *
   * `niche_id` selects a base Niche profile from the built-in library
   * (electron/server/niches/*.json) or the user-custom library
   * (${PROJECTS_ROOT}/.niches/*.json). Optional — projects without a niche
   * keep working exactly as before; niche-aware generators detect the
   * absence and skip the niche-injection passes.
   *
   * `niche_overrides` is a deep-partial of the resolved Niche applied on
   * top of the base, mirroring `format_overrides`. Useful when a project
   * wants to tweak a niche's vocab pool or style sheet without forking
   * the whole JSON.
   */
  niche_id?: string
  /**
   * Whether this channel's Formula was an explicit choice (owner ruling,
   * 2026-10-25: a Formula is mandatory at creation, with "Generic — no
   * Formula" as a deliberate option).
   *
   *   'selected' — `niche_id` names the Formula the customer chose.
   *   'generic'  — the customer deliberately chose a channel with no Formula.
   *   absent     — nobody has chosen yet. This is every channel created before
   *                the ruling, and the state the in-app prompt exists for.
   *
   * Two values that both mean "no Formula" would be the §6 defect: without
   * this field "chose generic" and "never chose" are indistinguishable.
   */
  formula_choice?: 'selected' | 'generic'
  niche_overrides?: DeepPartial<Niche>
  /**
   * Reusable subject-domain packs layered under the Series Formula selected by
   * `niche_id`. Empty / absent uses the formula's defaultTopicPackIds. This is
   * additive and backward-compatible: every legacy flat niche is treated as a
   * Series Formula with no required packs.
   */
  topic_pack_ids?: string[]

  /**
   * v1.0.270 — content mode. 'format' (default) = the video format shapes
   * ideation + script (systemPromptRole, title/logline/theme rules, example
   * ideas, additionalRules). 'freeform' = the format drives ONLY the visual
   * pipeline; idea + script generation use neutral prompts so you're not boxed
   * into the format's narrative recipe. Applied centrally in format-loader's
   * getEffectiveFormatFor, so every content consumer (ideas/script/outline)
   * sees the neutralised narrative while visuals stay intact.
   */
  content_mode?: 'format' | 'freeform'
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
  // ── v1.0.95+ IdeaPromptShape — fully data-driven prompt assembly ─────
  //
  // Six optional fields control the SHAPE of generated ideas. When ANY
  // of them is set, the Ideas Generator's LLM prompt builds the matching
  // instruction from these values INSTEAD of using a hardcoded English
  // sentence. When unset, the prompt falls back to a minimal lenient
  // hint ("title fits the genre, matches the examples above") and the
  // example ideas do the heavy lifting.
  //
  // Niches override formats: format.idea.titleShapeRules is the format's
  // default; niche.titleShapeRules supersedes it if present. Same for
  // every other field below.
  //
  // Why: hardcoded prompt strings ("title — evocative, 5-10 words; pick
  // adjectives from mood vocab") were written assuming a literary
  // sleep-story format and silently coerced every other niche/format
  // toward that voice. The prayer-channel project kept producing
  // "Prayer at Sunset's Edge" — adjective-decorated, nature-flavoured —
  // because the LLM was told to use those rules. Now each format/niche
  // owns its own structure; the prompt builder is a thin reader.

  /** Hard rules for title shape. Each string is an imperative
   *  instruction to the LLM, dropped into the prompt verbatim under a
   *  "TITLE RULES" header. See prayer.json / devotional.json for
   *  authoring examples. */
  titleShapeRules?: string[]
  /** Word-count range for titles. */
  titleLengthRange?: [number, number]

  /** Hard rules for logline shape. Replaces the generic "1-2 sentences
   *  with a concrete image" instruction when set. */
  loglineShapeRules?: string[]
  /** Sentence count range for loglines. */
  loglineSentenceRange?: [number, number]

  /** Hard rules for the themes array (subject keywords for each idea). */
  themeShapeRules?: string[]
  /** Number of theme keywords per idea. Defaults to [2, 4]. */
  themeCountRange?: [number, number]

  /** How much should generated titles VARY structurally across a batch?
   *  - 'free'              → no rule (the LLM picks)
   *  - 'vary-all'          → "no two titles may share the same noun+
   *                          preposition structure" (sleep-story,
   *                          listicle, true-crime — formats where the
   *                          channel's signature IS the variety)
   *  - 'vary-subject-only' → "repeat the established structure; vary
   *                          only the subject X" (prayer channels:
   *                          every title is "Prayer for X", that's the
   *                          channel signature)
   *  Unset = same as 'free'. */
  structuralVariety?: 'free' | 'vary-all' | 'vary-subject-only'
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
  /** v1.0.101+ — Recommended duration values shown in the Script
   *  Generator's Duration dropdown. When unset, the page falls back to
   *  the legacy sleep-story-flavoured set [15, 20, 30, 45, 60, 90].
   *  Format authors should set this to values that make sense for their
   *  format's typical episode length (broll-narration: [5, 8, 10, 15,
   *  20, 30]; reasons-explainer: [8, 12, 15, 20]; kids-fairytale:
   *  [5, 8, 10, 15]). The format's `defaultLengthMinutes` should appear
   *  in this list so the dropdown shows the right value selected on
   *  fresh project load instead of falling through to "Custom...". */
  durationPresets?: number[]
  /**
   * Formula-owned scene-density progression. The opening can carry more
   * explanatory visual information, then the remaining documentary settles
   * into longer ambient holds. This is deliberately separate from a project's
   * explicit Character Sheet pacing selection, which remains an override.
   */
  visualPacingProfile?: {
    opening_duration_sec: number
    opening: { min_sec: number; max_sec: number }
    settled: { min_sec: number; max_sec: number }
  }
  /** Formula-owned image-to-video mix. It assigns stable, gentle, or limited
   * motion by scene role after visual prompts exist; still scenes remain valid
   * assembly inputs and do not spend an image-to-video render. */
  motionProfile?: SceneMotionProfile
  /** v1.0.102+ — Words-per-minute for narration of this format. Drives
   *  total-words estimation in the Script Generator (length × WPM).
   *  Sleep-story is slow (122); listicle/comedy are fast (155-165);
   *  prayer / mindfulness sit around 120-140 (deliberate, breath-paced).
   *  When unset the Script Generator falls back to the legacy hardcoded
   *  122 — keeping prior behaviour for any custom user formats that
   *  haven't been updated. */
  defaultWordsPerMinute?: number
  narratorStyles: NarratorStyle[]
  defaultNarratorStyleId: string
  /** v1.0.196 — default narrative point of view. The Script form's
   *  "Point of view" picker defaults to this. Omitted = the picker shows
   *  "Auto" and injects no perspective directive (the format keeps its own
   *  voice). 'first' for first-person POV formats like continuity-chain. */
  defaultPerspective?: 'first' | 'second' | 'third'
  /**
   * v1.0.71+: signals to chunked-narration whether chapters can be
   * expanded in PARALLEL (true — listicle / explainer where each chapter
   * is independent) or must be SEQUENTIAL (false / undefined — narrative
   * formats that need transition glue between chapters). Determines
   * which expansion strategy `chunked-narration.ts` uses when chapter
   * count exceeds the single-call threshold. Defaults to false; set to
   * true on listicle.json + any future explainer-style format.
   */
  chaptersIndependent?: boolean

  /**
   * v1.0.82+: user-facing label for the format's primary content unit.
   * Defaults to {singular: "Chapter", plural: "Chapters"} when absent
   * so every existing format keeps its current vocabulary. Explainer
   * formats override with their natural term — reasons-explainer uses
   * "Reason"/"Reasons", listicle uses "Topic"/"Topics" — so the UI
   * surfaces and the LLM-emitted section headings ("## Reason 01: …")
   * match the format's content type rather than always saying
   * "Chapter".
   *
   * Internal identifiers stay "chapter" everywhere (chapter_slug,
   * chapter_durations, audio_chapters.json, etc.) — the label is
   * presentation-only. Slugs are derived from the actual heading text,
   * so a "Reason 01" heading produces a "Reason_01" slug naturally
   * and the downstream audio/video pipelines pair on identity, not on
   * the literal word "Chapter".
   */
  sectionLabel?: {
    /** Capitalized singular for in-text display ("Chapter", "Reason"). */
    singular: string
    /** Capitalized plural for counts and lists ("Chapters", "Reasons"). */
    plural: string
  }

  /**
   * v1.0.71+: per-format defaults for the Video Assembly page form.
   * Applied at page load BEFORE any saved preset overrides them, so
   * a fresh listicle project gets snappier scene/transition timing
   * without the user having to dial it in by hand. Optional —
   * formats that omit the block fall through to the page's hardcoded
   * sleep-story-shaped defaults (10 s/scene, crossfade 1.5 s).
   */
  videoDefaults?: {
    /** Default `seconds_per_scene` on the Video Assembly page. */
    secondsPerScene?: number
    /** Default transition id (matches the transitions catalog —
     *  e.g. 'crossfade', 'fade', 'wipeleft'). */
    transitionType?: string
    /** Default transition duration in seconds. */
    transitionDurationSec?: number
    /**
     * Default video-generator aspect ratio, passed to the Gateway video model.
     * 'landscape' covers 16:9 channels (sleep-story, listicle); 'portrait'
     * is for vertical / Shorts-format channels; 'square' for 1:1 social
     * formats. Optional — formats that omit it fall back to 'landscape'.
     */
    aspectRatio?: 'landscape' | 'portrait' | 'square'
    /**
     * v1.0.102+ — Default duration in seconds for a new manually-added
     * timeline clip on the Video Assembly page. The hardcoded fallback
     * was 7200 (2-hour sleep-story ambient bed); prayer / explainer /
     * listicle channels need much shorter defaults. Optional — formats
     * that omit it fall back to 7200 for back-compat with the sleep-
     * story-shaped baseline.
     */
    defaultTimelineClipDurationSeconds?: number
  }

  /**
   * Per-format defaults for the Audio (TTS) generator page. Sleep-story
   * narration is calmer (0.93× speed); listicle / explainer channels want
   * faster pacing (~1.0×). Optional — formats that omit the block fall back
   * to the page's hardcoded sleep-story-shaped defaults.
   *
   * Saved presets still override these — preset.load() runs after seeding.
   *
   * Pace only. A format may NOT ship defaults for a model's published
   * `controls[]`: which controls exist and what they accept is a per-model
   * catalogue fact read live, and a format naming one would be Story Studio
   * asserting a capability GenStudio never published for the selected model.
   */
  audioDefaults?: {
    /** Default playback speed multiplier (typical range 0.85–1.2). */
    speed?: number
  }

  /** Narration pauses inside a chapter, seconds, from the Series Formula (Audio Generator's
   *  "Pause at a paragraph break"). Absent = the default every voice uses (1.5 / 1.0 s). */
  narrationPauses?: {
    paragraphSec?: number
    sentenceSec?: number
  }

  /**
   * Per-format defaults for the Audio Merge page. Sleep-story rarely
   * needs loudness normalization (the calm-narration pipeline already
   * targets a consistent peak); listicle / educational channels with
   * mixed-tone delivery often want EBU R128 normalization to keep
   * per-chapter peaks even.
   */
  audioMergeDefaults?: {
    /** Default state of the "Normalize loudness" toggle. */
    normalizeVolume?: boolean
    /** Default silence gap between chapters, seconds. */
    gapDurationSec?: number
    /** Default background music volume percentage (0–100%). */
    musicVolume?: number
  }

  /**
   * v1.0.71+: per-format defaults for the Introduction generator.
   * The legacy hardcoded shape was 350-word, sleep-story-flavoured
   * (Welcome → Story teaser → Community question → Subscribe →
   * Relaxation/breathing → Transition). Listicle / explainer
   * channels want a short host-personality intro instead — typically
   * ~50 words, no breathing exercise, just greeting + channel +
   * subscribe + transition.
   *
   * Applied:
   *   - On scripts page load BEFORE preset.load() runs (so a saved
   *     preset still wins).
   *   - In generators/episode.ts:generateIntroductionOnly when the
   *     request omits word_target / beats (defensive — most callers
   *     pass them, but pipeline batch defaults pick them up here).
   *
   * `exampleText` is baked into the LLM prompt as a style anchor
   * when present — LLMs match output style to in-prompt examples
   * far more reliably than to abstract beat lists, especially for
   * short host-personality intros. {host_name} and {channel_name}
   * placeholders are substituted at request time.
   */
  introDefaults?: {
    /** Target word count for the introduction. Sleep-story default
     *  ~350; listicle ~50. */
    wordTarget?: number
    /**
     * Ordered list of beats the intro should hit. Each beat becomes a
     * numbered bullet in the prompt.
     *
     * v1.4.73 — a beat may now be a `BEAT_LIBRARY` id, which brings the
     * catalogue's label and its on-screen explanation with it, or an object
     * pairing that id with the wording this channel wants it to cover. A bare
     * string the catalogue does not recognise keeps the original meaning: it
     * is the beat's label, verbatim. Nothing that already shipped changes
     * shape.
     *
     * NOTHING WRITES THIS FIELD DIRECTLY. It is set by
     * `applyNicheToFormat()` from the Formula's own `introDefaults`, because
     * `canonicalFormatId()` folds every project onto one format file and a
     * per-format opening therefore cannot vary by channel. See
     * `services/format-loader.ts`.
     */
    beats?: Array<string | { id: string; custom_text?: string }>
    /** Optional one-paragraph example the LLM matches style to.
     *  Supports {host_name} and {channel_name} placeholders. */
    exampleText?: string
  }
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
  /**
   * v1.0.81+: scene-to-narration alignment granularity for the
   * Compilation video-assembly path.
   *
   *   "chapter" (default) — current behavior. Scenes pair positionally
   *     to chapters; per-scene duration is uniform (`seconds_per_scene`)
   *     and chapter duration determines how many scenes are cycled.
   *
   *   "sentence" — reasons-explainer pacing. Scenes within a chapter
   *     are distributed across the chapter's sentences (computed from
   *     audio_sentences.json), and each scene's on-screen duration is
   *     the sum of its assigned sentences' durations. Produces 3-6s
   *     cuts aligned to spoken sentence breaks instead of uniform 10s
   *     cuts that drift across the narration.
   *
   * Format JSONs without this field default to "chapter" so the
   * narrative / listicle behaviour is unchanged. Only formats that
   * explicitly opt in (set "sentence") get the new sentence-aligned
   * path — typically narration-synced, where scenes track the audio.
   */
  alignment?: 'chapter' | 'sentence'
  /**
   * v1.0.224+: per-format YOUTUBE THUMBNAIL art direction. The thumbnail is
   * the highest-leverage CTR asset, and it used to be hardcoded toward a
   * single (sleep-story) gold/glowing aesthetic. This block lets each format
   * steer the thumbnail IMAGE concept independently of the scene
   * `defaultStyleTag` — a listicle wants a bold clickable cover, NOT the
   * minimalist white scene badge. The generator layers it: format → universal
   * YouTube CTR rules → optional reference-style replication → per-project
   * art-direction override. Optional: formats without it fall back to a
   * generic high-CTR directive.
   */
  thumbnail?: {
    /** Layout grammar used by the universal thumbnail prompt. Most formats
     *  use a single hero subject; annotated-collage keeps one central anchor
     *  while allowing small supporting callouts around it. */
    layout?: 'hero' | 'annotated-collage'
    /** What the thumbnail IMAGE depicts (subject, composition, energy) —
     *  NOT the title text. */
    conceptGuidance: string
    /** Composition rules (framing, palette, focal subject). */
    compositionRules?: string[]
    /** Default TEXT_STYLES key for the baked title (AI title mode). */
    defaultTextStyle?: string
    /** Default FONT_STYLES key for the baked title (AI title mode). */
    defaultFontStyle?: string
    /** Mood adjectives folded into the directive. */
    moodKeywords?: string[]
    /** Anti-patterns to explicitly avoid for this format. */
    avoid?: string[]
  }
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
  /** v1.0.199 — which Metadata Generator starter template this format opens
   *  with on a fresh episode ('pov' | 'explainer' | 'listicle' | 'minimal' or
   *  a future id). Lets a new format declare its metadata default in data
   *  instead of a hardcoded frontend mapping. Absent → frontend fallback. */
  defaultStarterTemplate?: string

  /** v1.0.103+ — Niche-supplied description-shape override. Merged in
   *  from Niche.metadataDescription via applyNicheToFormat. Lets a
   *  channel-shaped niche (prayer, devotional) override the generic
   *  description structure with a niche-tuned voice + rules + closing
   *  benediction. See buildDescriptionPrompt in lib/metadata-prompt.ts
   *  for how each field lands in the LLM prompt. */
  descriptionShape?: {
    voiceGuidance?: string
    descriptionShapeRules?: string[]
    closingBenediction?: string
    ctaShape?: string
    /**
     * What goes between sections, replacing the prompt's default instruction.
     *
     * Without this the builder always ended with "Use separator lines (──────)
     * between major sections", which flatly contradicts any description shape
     * that wants none — the model was handed both instructions and left to pick.
     */
    separatorRule?: string
  }
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

  /** Active production route for the narration-timed scene workflow. */
  visualSource?: 'timestamp-driven' | 'continuity-chain' | 'narrated-scenes'

  /**
   * Pairing mode for a scene-plan format. `sentence` uses audio timing;
   * `chapter` remains available to the active narrated-scenes route.
   */
  sceneAlignment?: 'chapter' | 'sentence'
}

// ── Niche primitive (subject-domain layer, orthogonal to Format) ───────────
//
// A Niche bundles the subject-matter context that should flow into every
// project covering that subject. Format answers "what shape of video";
// Niche answers "what subject domain". The two compose freely:
//
//   narrative × plants    → "Why It Sucks To Be Born As a Venus Flytrap"
//   narrative × animals   → "Why It Sucks To Be Born As a Komodo Dragon"
//   listicle  × plants    → "10 Weirdest Plants on Earth"
//   narrative × gemstones → "The Sleeping Caves" (a calm narrative episode)
//
// Layered with Format:
//   base format → project.format_overrides
//   base niche  → project.niche_overrides
// Niche injection happens at well-defined call sites in each generator
// (ideas vocab, script context, image-prompt style sheet, metadata tags) —
// it does NOT participate in the format-merge chain. Keeping the axes
// separate prevents the n×m JSON explosion you'd get if every
// format-niche combination needed its own file.
//
// Built-in niches: electron/server/niches/{id}.json (shipped via
// electron-builder extraResources). User-custom niches:
// ${PROJECTS_ROOT}/.niches/{id}.json (exportable single JSON files).

export interface NicheReferenceImage {
  /** Stable id within the niche (e.g. "venus-flytrap-master"). */
  id: string
  /** Human label shown in the references picker. */
  label: string
  /** Absolute path on disk OR http(s) URL. The image generator copies the
   *  file into the project's references folder on first use. */
  path: string
  /** How this reference should be applied. `master` = global style
   *  anchor; `character` = a recurring character/subject; `scene` = a
   *  template for a specific scene composition. */
  role: 'master' | 'character' | 'scene'
  /** Optional short description shown in tooltips. */
  description?: string
}

export interface NicheVocabulary {
  mood?: string[]
  theme?: string[]
  genre?: string[]
  keyword?: string[]
}

export interface NicheThumbnailProfile {
  /** Replaces the format's default thumbnail layout grammar. */
  layout?: 'hero' | 'annotated-collage'
  /** Replaces the format's concept guidance when set. */
  conceptGuidance?: string
  /** Replaces the format's composition rules when set. */
  compositionRules?: string[]
  /** Replaces the format's mood keywords when set. */
  moodKeywords?: string[]
  /** Replaces the format's avoid list when set. */
  avoid?: string[]
  /** Optional baked-title defaults understood by the thumbnail generator. */
  defaultTextStyle?: string
  defaultFontStyle?: string
}

/**
 * Formula-owned publishing defaults. These describe the episode-specific
 * metadata shape; recurring channel copy belongs to the project publishing
 * profile, not to an old per-page starter template.
 */
export interface NicheMetadataProfile {
  id: string
  label: string
  description: string
  descriptionSectionIds: string[]
  titleMode: 'use_idea_title' | 'paraphrase'
  descriptionMaxChars: number
  titleMaxLength: number
  tagCount: number
}

export interface IdeaAxis {
  /** Stable slug included in idea fingerprints, e.g. "economic-pressure". */
  id: string
  /** Human label shown in campaign coverage summaries. */
  label: string
  /** Reusable values supplied by the Series Formula itself. */
  values: string[]
}

/** A durable episode lane owned by a Series Formula. Idea Campaign stores
 * `ideaAxisValue` in `idea_dimensions`, so downstream surfaces can adapt the
 * same Formula without asking the user to choose a profile for every run. */
export interface FormulaEpisodeProfile {
  id: string
  label: string
  description: string
  ideaAxisValue: string
  /** Optional machine-enforced suffix applied after generation. */
  titleSuffix?: string
  /** Suffixes removed for profiles that must not claim another lane. */
  forbiddenTitleSuffixes?: string[]
  /** Formula narrator used when the user leaves the Script page on Auto. */
  narratorStyleId?: string
  titlePolicy?: string
  thumbnailPolicy?: string
  metadataPolicy?: string
  /** Runtime overrides carried by a declarative episode mode. */
  introDefaults?: Niche['introDefaults']
  scriptStructure?: Niche['scriptStructure']
  recencyAvoidance?: Niche['recencyAvoidance']
  ideaSystemPromptRole?: string
  ideaGuidanceText?: string
  scriptContext?: string
  scriptSystemPromptRole?: string
  scriptClosingHint?: string
}

/** Declarative binding between a Series Formula and the reusable production
 * primitives it recommends. The referenced style and thumbnail recipe remain
 * independent library entries; this contract only makes them travel as one
 * coherent channel system and is reusable by future Formula authors. */
export interface FormulaProductionKit {
  id: string
  label: string
  description: string
  episodeProfiles?: FormulaEpisodeProfile[]
}

export interface TopicCoverageGroup {
  subjects: string[]
  episodeObjects: string[]
  timePlaceScopes: string[]
  mechanisms: string[]
  evidenceLenses: string[]
}

export interface TopicCoverageTuple {
  episodeObject: string
  timePlaceScope: string
  mechanism: string
  evidenceLens: string
}

export interface TopicCoverageProfile {
  subject: string
  tuples: TopicCoverageTuple[]
}

export interface TopicPack {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1
  tagline?: string
  /** Empty means compatible with every Series Formula. */
  compatibleNicheIds: string[]
  /** Preferred Formula-oriented compatibility name. `compatibleNicheIds`
   * remains readable for built-ins and user packs created before Channel
   * Identity. A pack may use either field while the catalog migrates. */
  compatibleFormulaIds?: string[]
  /** Primary subjects used by the deterministic Idea Campaign planner. */
  subjects: string[]
  /** Maximum planned episodes that may use one subject from this pack. */
  maxSiblingsPerSubject?: number
  /** Secondary dimensions composed with the primary subject. */
  ideaAxes?: IdeaAxis[]
  /** Authored coherent tuple lanes for subject-level campaign coverage. */
  coverageGroups?: TopicCoverageGroup[]
  /** Complete authored coherent tuples for one subject, ordered for reservation. */
  coverageProfiles?: TopicCoverageProfile[]
  /** Signed Pack planning dimensions retained for deterministic campaigns. */
  episodeObjects?: string[]
  timePlaceScopes?: string[]
  mechanisms?: string[]
  evidenceLenses?: string[]
  exclusions?: string[]
  /** Strong examples appended to the Series Formula's example bar. */
  exampleTopics?: string[]
  /** Prompt context appended after the Series Formula's dominant voice. */
  promptContext?: string
  vocabulary?: NicheVocabulary
  youtubeTagsHint?: string[]
  tags?: string[]
}

export interface Niche {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1
  /** Every legacy niche is treated as a Series Formula when this is absent. */
  kind?: 'series-formula'
  /** Library-only grouping. It improves discovery without becoming a third
   * project setting alongside Series Formula and Topic Packs. */
  formulaFamily?: string
  /** Legacy profiles stay loadable for existing projects but are hidden from
   * new Formula selections once a successor Formula exists. */
  catalogStatus?: 'active' | 'legacy'
  successorFormulaId?: string
  /** Human-facing catalog label. The stable `id` remains migration-safe. */
  catalogName?: string

  /** Formula-owned narration perspective. It is selected with the channel
   * Formula, rather than repeatedly chosen for individual episodes. */
  perspectivePolicy?: string
  /** Non-negotiable writing rules that prevent recognisable AI cadence while
   * preserving the Formula's own voice, opening, and chapter flow. */
  narrativeQualityContract?: {
    openingPolicy: string
    forbiddenPatterns: string[]
    requiredHabits: string[]
    closingPolicy?: string
  }
  /** Optional Formula-owned opening configuration. Its absence means scripts
   * begin directly with the episode rather than exposing generic intro knobs.
   *
   * WORDING ONLY. This is the label and sentence the Introduction page shows
   * for the Formula's opening; it decides nothing. Until v1.4.73 its mere
   * presence decided whether the opening controls were drawn at all, which is
   * why twenty of twenty-two Formulas could not see the feature. The recipe
   * itself is `introDefaults` below.
   *
   * Kept structurally identical to the signed content-pack contract's
   * `openingProfile` (`contracts/index.ts`, `.strict()`), so a published
   * Formula and a built-in one describe their opening the same way. That is
   * also why the recipe is a SEPARATE field: widening this one would have
   * meant changing a signed-pack schema, and a pack that predates the change
   * would carry no recipe anyway. */
  openingProfile?: {
    id: string
    label: string
    description: string
  }

  /**
   * The opening this Formula actually writes — its length, and its ordered
   * beats.
   *
   * v1.4.73. `applyNicheToFormat()` copies this onto
   * `format.script.introDefaults`, which is the field `defaultSegmentRecipe()`
   * has read since v1.0.71 and which nothing has ever set. A beat is either a
   * `BEAT_LIBRARY` id — in which case the page shows the catalogue's
   * explanation for it — or, as an object, that id plus the wording this
   * Formula wants it to cover.
   *
   * Absent means the channel falls back to `DEFAULT_INTRODUCTION_BEATS`, the
   * long-form seven. No built-in Formula is in that position any more; a
   * channel running no Formula at all still is.
   *
   * Signed Content Packs may carry the same recipe as optional snake-case
   * data; older packs remain valid when it is absent.
   */
  introDefaults?: {
    /** Roughly how long the opening runs, in words. Clamped to 50–600. */
    wordTarget?: number
    /** Ordered beats: a catalogue id, or `{ id, custom_text }`. */
    beats?: Array<string | { id: string; custom_text?: string }>
    /** Style anchor baked into the prompt. `{host_name}` / `{channel_name}`. */
    exampleText?: string
  }
  /** Formula-owned defaults for the YouTube publishing package. */
  metadataProfile?: NicheMetadataProfile
  /** Optional coherent production bundle: reusable library references plus
   * Formula-owned episode profiles. */
  productionKit?: FormulaProductionKit

  /** Short tagline shown on the niche card / picker. */
  tagline?: string

  /** Example topics that feed the Ideas generator's "give me ideas in this
   *  niche" pass. Each entry is the canonical "subject" string (e.g.
   *  "Venus Flytrap", "Corpse Flower"). */
  exampleTopics: string[]
  /** Built-in Topic Packs recommended when a project has not chosen any. */
  defaultTopicPackIds?: string[]
  /** Optional allow-list used by pickers. Empty / absent accepts any pack
   *  whose compatibleNicheIds includes this formula. */
  compatibleTopicPackIds?: string[]
  /** Formula-owned axes composed with Topic Pack subjects for large campaigns. */
  ideaAxes?: IdeaAxis[]
  /** Present only on an effective, composed niche returned at runtime. */
  activeTopicPacks?: TopicPack[]

  /** Vocabulary pools merged INTO the format's vocab pools at ideas-
   *  generation time. Niche keywords append to format keywords; the
   *  randomizer draws from the union. */
  vocabulary?: NicheVocabulary

  /** v1.0.332 — art direction for THUMBNAIL images. Appended to the format's
   *  thumbnail conceptGuidance. Kept for third-party/user niches, but no
   *  built-in niche sets it any more: art direction is the customer's choice
   *  (`config.active_style_preset_id` / `config.thumbnail_template_id`), not
   *  something a channel type may dictate silently. */
  thumbnailStyleSheet?: string
  /** Niche-owned thumbnail layout and composition. This is separate from
   *  visual style: Business Economics can ask for an annotated central-subject
   *  diagram while still using any selected project art style. */
  thumbnailProfile?: NicheThumbnailProfile
  /** Long-form style sheet appended after the format's `visualStyleHint`
   *  in image-prompt assembly. Kept for third-party/user niches, but no
   *  built-in niche sets it any more — a channel type suggests a style, it
   *  never dictates one. See `recommendedVisualStyleIds`. */
  visualStyleSheet?: string

  /** Short keyword tags auto-added to every scene prompt and every
   *  newly-created character in projects that carry this niche. Mirrors
   *  the per-character `references.style_keywords` pattern but at niche
   *  scope. */
  defaultStyleKeywords?: string[]

  /** Pre-built reference image pack. Made available to the image
   *  generator as auto-attachable references — the user can opt in per
   *  scene rather than having them force-attached. */
  referenceImages?: NicheReferenceImage[]

  /** YouTube tag hints merged into the metadata generator's tag pool. */
  youtubeTagsHint?: string[]

  /** One-line audience descriptor merged into format's audience text. */
  audienceHint?: string

  /** Sentence-form context line injected into the script generator's
   *  system prompt: "This is a video about {niche.name}. {scriptContext}".
   *  Optional — when absent, generators just use the niche name + description. */
  scriptContext?: string

  // ── v1.0.280+ Content-ownership fields (format↔niche refactor, Phase A) ──
  //
  // After the polarity flip, FORMAT is presentation-only and the NICHE owns
  // ALL content (voice, persona, vocabulary, rules). These fields let a niche
  // fully OWN the idea/script/metadata persona that previously lived on the
  // format. Each is OPTIONAL and falls back to the format shell's neutral
  // value when unset, so:
  //   - a niche that sets them → its voice fully replaces the shell's generic
  //   - a niche that leaves them unset → composes scriptContext over the shell
  //     role (interim behaviour; Phase B authors the explicit personas)
  //   - no niche at all → the shell's neutral role IS the fallback
  //
  // applyNicheToFormat() reads these with shell fallback. See format-loader.ts.

  /** Full idea-generator system-prompt role. When set, REPLACES the format
   *  shell's generic idea role (not appended). The niche's complete voice for
   *  ideation. When unset, applyNicheToFormat composes scriptContext over the
   *  shell role. */
  ideaSystemPromptRole?: string
  /** Free-form idea guidance block (sleep-friendliness rules, do/don't list).
   *  When set, REPLACES the composed lead+format guidance. */
  ideaGuidanceText?: string
  /** Full script-writer system-prompt role / persona. When set, REPLACES the
   *  shell's generic script role (not appended). When unset, applyNicheToFormat
   *  appends scriptContext to the shell role (interim). */
  scriptSystemPromptRole?: string
  /** One-line closing instruction for the script (before the final-check
   *  block). Replaces the shell's neutral closingHint when set. */
  scriptClosingHint?: string
  /** Metadata title tone hint (replaces format.metadata.titleStyleHint). */
  metadataTitleStyleHint?: string
  /** Metadata title hook rules (replaces format.metadata.titleHookRules). */
  metadataTitleHookRules?: string[]
  /** Metadata tag hook rules (replaces format.metadata.tagsHookRules). */
  metadataTagsHookRules?: string[]
  /** Human-facing one-line visual style hint shown in the picker / override
   *  editor (replaces format.imagePrompts.visualStyleHint). Never folded into a
   *  generated prompt; a NEW channel gets it copied into its own editable
   *  "Channel default style" once (services/formula-starting-defaults.ts). */
  visualStyleHint?: string
  /** Scene length (seconds, [min, max]) a NEW channel of this type starts with
   *  — copied into the channel's own editable settings at creation. */
  startingSceneSeconds?: [number, number]
  /** A tiered starting rhythm (the existing `variable` shape); when present it
   *  supersedes `startingSceneSeconds` for a NEW channel. Copied into the
   *  channel's own editable settings once, never read at generation time. */
  startingScenePacing?: ScenePacing
  /**
   * The frame shape this Formula makes (owner, 2026-10-27).
   *
   * A vertical Quote Shorts channel and a landscape documentary need
   * different canvases, and until now only a built-in `Format` could say so.
   * This reaches `format.imagePrompts.recommendedAspect` in the loader, which
   * is the one field Scene Review, the Image Pool and Video Assembly already
   * read — so there is no second aspect control to keep in step.
   *
   * A STARTING value, exactly like `startingSceneSeconds`: a saved preset
   * still wins, and every page can change it.
   */
  aspectRatio?: '16:9' | '9:16' | '1:1'
  /** Starting background music volume (0–100%) in Audio Assembly for a NEW channel. */
  startingMusicVolume?: number
  /** Default "Pause between chapters" in Audio Assembly (seconds). Sleep
   *  formulas want a longer, calm gap; the customer can still change it. */
  chapterPauseSec?: number
  /** Default narration pause (seconds) at a paragraph break / after a sentence inside a chapter
   *  (Audio Generator), a per-channel override. Absent = the default every voice uses (1.5 / 1.0 s). */
  paragraphPauseSec?: number
  sentencePauseSec?: number
  /** Visual styles this channel type SUGGESTS, best first. Carried through
   *  from a signed pack's `recommended_visual_style_ids`. A suggestion is
   *  surfaced in Settings with a one-click "Use this style" — it is never
   *  written to the project automatically, and it never reaches a prompt
   *  unless the customer selects it. */
  recommendedVisualStyleIds?: string[]
  /** Narrator-voice picker for this niche. When set (non-empty), REPLACES the
   *  format shell's narrator styles so the Script page's "Narrator style"
   *  picker offers the niche's own personas (sleep: 10 literary voices;
   *  listicle-explainer: QI / documentary deadpan; prayer: pastoral). The
   *  frontend picker reads the niche-merged effective format, so it benefits
   *  with no frontend change. Resolution: niche.narratorStyles (if any) →
   *  format.script.narratorStyles (the shell's single neutral default). */
  narratorStyles?: NarratorStyle[]
  /** Default narrator style id, paired with narratorStyles. Must match one of
   *  the ids in narratorStyles when both are set. */
  defaultNarratorStyleId?: string

  // ── v1.0.95+ IdeaPromptShape — niche-level overrides ────────────────
  //
  // Same shape as Format.idea (see types.ts above). Niche overrides
  // format on any field it sets. Unset fields fall through to the
  // format's value (or to the lenient fallback if the format is also
  // silent). This is how "each niche owns its own structure" while
  // keeping format-level defaults for niches that don't need to
  // override.
  //
  // Authoring guide: see prayer.json (strict; locks "Prayer for X")
  // and devotional.json (strict; locks "{N} Lessons from {Ref}").
  // Niches that ride happily on the format default (plants, animals,
  // fungi, insects under reasons-explainer) leave these all unset.

  titleShapeRules?: string[]
  titleLengthRange?: [number, number]
  loglineShapeRules?: string[]
  loglineSentenceRange?: [number, number]
  themeShapeRules?: string[]
  themeCountRange?: [number, number]
  structuralVariety?: 'free' | 'vary-all' | 'vary-subject-only'

  // ── v1.0.103+ ScriptStructureShape — niche-level script overrides ──
  //
  // When a niche has a strongly-established multi-section script template
  // (prayer-channel videos: Reflection → Prayer → Blessing; devotional:
  // Verse → Reflection → Application), the niche can override the
  // format's chapter count + pacing arc + additional rules. Each field
  // is optional; unset falls through to format.script.
  //
  // Use case: broll-narration format ships with `defaultChapterCount: 1`
  // (single continuous narration) for the lenient general case, but the
  // prayer niche under broll-narration always produces 3-section videos.
  // Setting niche.scriptStructure here switches the script generator
  // to a 3-section flow ONLY for prayer projects — other niches under
  // broll-narration (mindfulness, motivation, etc.) keep the format's
  // single-chapter shape unless they opt in too.
  //
  // The fields mirror Format.script's structural triplet exactly.
  // Patterns still win over niche (they're a per-episode override —
  // see Pattern.bodyStructure semantics in script-prompt.ts).
  scriptStructure?: {
    /** Override Format.script.defaultChapterCount when the niche has
     *  a strong section convention (prayer: 3 sections). */
    defaultChapterCount?: number
    /** Override Format.script.chapterCountRange. */
    chapterCountRange?: [number, number]
    /** Override the Continuity Engine's short-form length defaults. */
    defaultLengthMinutes?: number
    lengthMinutesRange?: [number, number]
    /** Recommended long-form duration choices shown in Script Generator. */
    durationPresets?: number[]
    /** Formula-owned narration speed used for word-count estimation. */
    defaultWordsPerMinute?: number
    /** Whether factual chapters may be independently expanded in batches. */
    chaptersIndependent?: boolean
    /** Two-phase documentary visual pace applied when no episode override exists. */
    visualPacingProfile?: ScriptFormat['visualPacingProfile']
    /** Formula-owned scene motion mix for the narration-timed visual plan. */
    motionProfile?: ScriptFormat['motionProfile']
    /** App-owned motion behavior selected by a signed Content Pack. */
    motionProfileId?: string
    /** Replaces Format.script.pacingArc when set. Each string describes
     *  one chapter's narrative function. {last} / {lastButOne} / {n}
     *  placeholders work the same as on the format. */
    pacingArc?: string[]
    /** APPENDED to Format.script.additionalRules (not replacing) so the
     *  niche can layer niche-specific writing constraints (e.g. prayer:
     *  "Address God directly in second person inside the prayer body")
     *  without losing the format's baseline rules. */
    additionalRules?: string[]
  }

  // ── v1.0.103+ MetadataDescriptionShape — niche-level YouTube
  // description templates. Lets prayer / devotional / motivation
  // channels override the format's generic description structure with
  // a niche-tuned layout (opening hook → invitation → CTA with emoji →
  // benediction → hashtags). Each field is optional; unset falls
  // through to format.metadata.youtubeDescriptionStructure.
  metadataDescription?: {
    /** Shown to the LLM as "channel voice" guidance before the
     *  per-episode synopsis. One paragraph max. Example for prayer:
     *  "Open with a warm second-person question to the viewer about
     *  their current state ('Are you feeling overwhelmed by anxiety?')
     *  before the prayer's invitation. The description SPEAKS to the
     *  viewer, not the algorithm." */
    voiceGuidance?: string
    /** Hard rules dropped into the prompt verbatim. Same shape as the
     *  IdeaPromptShape titleShapeRules. Example for prayer: "Start
     *  with an open-hearted question or 'Dear beloved' style address",
     *  "Include the 🙏 emoji exactly once near the CTA",
     *  "Close with 'You are never alone. God's peace is with you
     *  always.' as the final non-hashtag line". */
    descriptionShapeRules?: string[]
    /** Closing line(s) appended to every description if the LLM
     *  doesn't already supply equivalent text. Verbatim copy. Prayer:
     *  "You are never alone. God's peace is with you always." */
    closingBenediction?: string
    /** CTA paragraph hint. Tone + structure guidance for the
     *  like-share-subscribe paragraph. Prayer: warm-pastoral, never
     *  "smash that subscribe button" / hype copy. */
    ctaShape?: string
  }

  /**
   * v1.0.106+ — declarative recency-avoidance rules. When set, the
   * generators (script first; image-prompts + metadata can follow if
   * the niche needs them) extract matching items from each completed
   * episode and inject "don't repeat these" instructions into the next
   * episode's prompt.
   *
   * Use case: prayer-channel niches that anchor each episode on ONE
   * scripture reference. Without recency tracking, the LLM cycles back
   * to the same 4-5 "comfort verses" (Psalm 91, Philippians 4:6-7,
   * Isaiah 41:10) every 2-3 episodes. With it, the LLM is told which
   * references were used in the last N episodes and steered toward a
   * fresh passage.
   *
   * The mechanism is generic: any niche can declare what to track
   * (regex pattern matching the items, human label for prompt copy,
   * default lookback window). Storage lives in
   * project.config.recency_log keyed by `kind` (the label). Multiple
   * niches with different `kind` values coexist in one project's log.
   */
  recencyAvoidance?: {
    /** App-owned extraction strategy selected by signed Content Packs. */
    strategyId?: string
    /**
     * Human-readable label for the kind of item being tracked. Used as
     * the `kind` discriminator in the project's recency_log AND in the
     * LLM prompt copy ("scripture references", "famous unsolved cases",
     * "popular quotes", etc.). Stable id — changing this orphans
     * existing log entries.
     */
    label: string
    /**
     * Regex pattern(s) (JS syntax, no leading/trailing slashes) used to
     * extract used items from the generated script text. Multiple
     * patterns are unioned (run independently, results merged). The
     * tracker dedupes and normalizes whitespace before logging.
     *
     * Prayer example (all 66 books of the Bible, chapter optional,
     * verse range optional):
     *   "\\b(?:[123]\\s+)?(?:Genesis|Exodus|…|Revelation)\\s+\\d+(?::\\d+(?:-\\d+)?)?"
     */
    extractPatterns: string[]
    /**
     * Default lookback window (number of recent episodes to consult
     * when building the avoidance list). Per-project overridable via
     * project.config.recency_lookback. Default 30 if both unset.
     */
    defaultLookback?: number
    /**
     * Prompt-instruction template injected into the script prompt
     * BEFORE generation. Placeholders:
     *   {label} → niche.recencyAvoidance.label
     *   {count} → number of items being avoided
     *   {items} → bullet-list of the recently-used items
     *
     * Default template (used when unset): "These {label} were used in
     * this channel's recent episodes — pick a DIFFERENT one for this
     * prompt:\n{items}".
     */
    instructionTemplate?: string
    /**
     * v1.0.108+ — which generator output scopes this rule applies to.
     * Defaults to ['script'] when unset (backward compat for pre-v1.0.108
     * niches like prayer's original block). Multi-scope rules let a niche
     * track items that appear across multiple generator outputs with one
     * shared regex + unified log.
     *
     * Use case: prayer's scripture regex catches `Psalm 91` whether it
     * lands in the script narration OR the YouTube description.
     * Declaring `scopes: ['script', 'metadata']` makes the cycler avoid
     * the verse on BOTH surfaces.
     *
     * Log entries stay unified by `kind` (the label) regardless of
     * scope — if an item appeared in episode 3's script, episode 4's
     * description avoids it too, and vice versa.
     */
    scopes?: Array<'script' | 'titles' | 'image_prompts' | 'metadata'>
  }

  /**
   * v1.0.105+ — id of the ThumbnailTemplate this niche pairs with by
   * default. The compose endpoint resolves the effective template as:
   *   project.config.thumbnail_template_id → niche.defaultThumbnailTemplateId → null
   * So a project can override its niche's default ("use the centered-
   * hero-headline template on a prayer project") via the project
   * config key, and a niche without a defaultThumbnailTemplateId
   * simply has no compose-time default — the user picks one in the
   * dialog gallery.
   *
   * Templates live in their own library at
   * electron/server/thumbnail-templates/{id}.json (see template-loader).
   */
  defaultThumbnailTemplateId?: string

}

/**
 * First-class thumbnail template (v1.0.105+). Decoupled from niches so
 * any template can be used on any project — prayer can use the true-
 * crime style and vice versa.
 *
 * Library layout (mirrors niche-loader):
 *   - Built-in: electron/server/thumbnail-templates/{id}.json
 *   - User-custom: ${PROJECTS_ROOT}/.thumbnail-templates/{id}.json
 *
 * Templates are pure layout — no project- or episode-specific data.
 * The compose endpoint takes (source image, template, optional text
 * overrides, optional logo path) and renders a fresh thumbnail.
 */
export interface ThumbnailTemplate {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1

  /** Short tagline for the gallery preview card. One sentence. */
  tagline?: string

  /**
   * Niches this template was designed for. The gallery picker uses
   * this advisory — templates whose `recommendedNicheIds` includes the
   * project's niche float to the top of the list, but ANY template
   * can be used on ANY niche. The user is in charge.
   */
  recommendedNicheIds?: string[]

  /**
   * v1.0.724+ — thumbnail recipes add a repeatable AI-art composition
   * contract and real finished examples. Keep the template type for backwards
   * compatibility: legacy templates remain valid for manual composition,
   * while a template with `recipe` appears in the browsable catalog.
   */
  category?: string
  /** Search aliases for the catalog; describe the click grammar, not a channel. */
  tags?: string[]
  /** Two or more original finished examples, served from frontend/public. */
  previewImages?: string[]
  recipe?: ThumbnailRecipeProfile

  // ── Layout ────────────────────────────────────────────────────────
  /** YouTube standard is 16:9 (1920×1080). Other ratios reserved for
   *  Shorts / square poster variants. */
  aspectRatio?: '16:9' | '9:16' | '1:1'
  /** Canvas size in px. Defaults to 1920×1080 (16:9). The compose
   *  endpoint resizes the input portrait to fit before painting
   *  overlays. */
  canvas?: { width: number; height: number }
  /** Optional gradient dim overlay to improve text legibility on
   *  busy portraits. */
  backgroundDimGradient?: {
    side: 'left' | 'right' | 'top' | 'bottom' | 'full'
    /** Fraction of the canvas covered by the gradient (0..1). 0.5 =
     *  the right half (for side='right'). Default 0.6. */
    coverage?: number
    /** Hex color the gradient fades TO at the dim end. Default '#000000'. */
    color?: string
    /** Max opacity at the dim end (0..1). Default 0.7. */
    strength?: number
  }
  /** Text overlays, painted in array order (later zones layer on top). */
  textZones?: ThumbnailTextZone[]
  /** Decorative strokes (horizontal rules, divider lines). Painted
   *  between the dim gradient and the text zones. */
  accentStrokes?: ThumbnailAccentStroke[]
  /** Optional logo / mark overlay. Image URL resolved at compose
   *  time from a project asset. */
  logoSlot?: ThumbnailLogoSlot
}

/**
 * The image-generation half of a ThumbnailTemplate. This profile tells the
 * prompt generator the visual system, including the complete headline, that
 * the selected image model must render.
 */
export interface ThumbnailRecipeProfile {
  layout: 'hero' | 'annotated-collage'
  conceptGuidance: string
  compositionRules?: string[]
  requiredElements?: string[]
  avoid?: string[]
  /** The selected image model renders the selected headline inside the image. */
  titleMode?: 'ai'
  /**
   * Controls which truthful text belongs inside the finished thumbnail.
   * Episode-title recipes preserve the familiar full-title cover treatment.
   * Short-hook and curiosity-hook recipes generate an editable thumbnail headline
   * per variation while leaving the full YouTube title and metadata untouched.
   */
  headlineMode?: 'episode-title' | 'short-hook' | 'curiosity-hook'
  /** Recipe-owned guardrails for generated short thumbnail hooks. */
  headlineGuidance?: string
  defaultTextStyle?: string
  defaultFontStyle?: string
  defaultTextPosition?: 'top' | 'center' | 'bottom' | 'bottom-left'
  /** Reusable editorial headline shapes shown in the catalog. */
  headlineFormats?: string[]
  /** Optional visual-language hint; never replaces the project art style. */
  visualStyleGuidance?: string
}

/**
 * One text overlay on a niche thumbnail. Rendered as SVG `<text>` and
 * composited via sharp. `name` drives substitution: 'title' uses the
 * episode title; every other name falls back to
 * `defaultText` with `{episode_title}` / `{episode_code}` / `{niche_name}`
 * placeholders supported.
 */
export interface ThumbnailTextZone {
  name: string
  defaultText?: string
  /** Horizontal anchor edge. 'left' = x measured from the LEFT edge;
   *  'right' = x measured from the RIGHT edge; 'center' = relative to
   *  canvas.width / 2. */
  x: 'left' | 'center' | 'right'
  /** Vertical anchor edge, same semantics. */
  y: 'top' | 'middle' | 'bottom'
  /** Px offset from the anchored edge (or from center). */
  xOffset?: number
  yOffset?: number
  /** Max paint width in px. Word-wraps within this width. */
  maxWidth: number
  /** CSS font-family chain. Must resolve through the system font
   *  catalog at render time. Examples: "Impact, 'Arial Black', sans-serif",
   *  "'Cormorant Garamond', Georgia, serif". */
  fontFamily: string
  fontSize: number
  fontWeight?: 'normal' | 'bold' | 'black' | number
  /** Hex color. Default '#ffffff'. */
  fill?: string
  /** Px tracking between glyphs. */
  letterSpacing?: number
  uppercase?: boolean
  /** Line-height multiplier. Default 1.1. */
  lineHeight?: number
  /** SVG text-anchor. Usually inferred from `x` but can be overridden. */
  textAnchor?: 'start' | 'middle' | 'end'
  /** Optional drop shadow for legibility on busy backgrounds. */
  shadow?: { dx?: number; dy?: number; blur?: number; color?: string }
  /**
   * Tweak the word-wrap heuristic for this zone. The composer estimates
   * character widths from a fontSize+weight+per-character-class table
   * (Node has no librsvg font readback). When a custom font wraps too
   * early or too late, dial this UP (>1) to fit more text per line
   * (e.g. condensed fonts) or DOWN (<1) to wrap sooner (e.g. extra-
   * wide display fonts). Default 1.0 — leave unset for stock Impact /
   * Arial Black / Georgia which the estimator is tuned against.
   */
  wrapTuningMultiplier?: number
}

/** Decorative stroke (horizontal rule / divider) on a niche thumbnail. */
export interface ThumbnailAccentStroke {
  /** Horizontal anchor of the stroke's centerpoint. */
  x: 'left' | 'center' | 'right'
  xOffset?: number
  /** Y position in px from the top of the canvas. */
  y: number
  /** Stroke length in px. */
  width: number
  /** Stroke thickness in px. Default 4. */
  thickness?: number
  /** Hex color. Default '#ffffff'. */
  color?: string
}

/** Logo / mark overlay slot on a niche thumbnail. */
export interface ThumbnailLogoSlot {
  x: 'left' | 'center' | 'right'
  y: 'top' | 'middle' | 'bottom'
  xOffset?: number
  yOffset?: number
  /** Render width in px (height auto-derived to preserve aspect). */
  width: number
}

// v1.0.166 — Pattern primitive removed with the Pattern system. Title shaping
// now happens at idea-time via the Ideas page's title_template field.

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

export interface CharacterChannelProfile {
  /** Channel-specific delivery and voice selection. Falls back to speech when absent. */
  speech?: CharacterSpeech
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
   *   'project'  — available to every episode in the project. The channel
   *                mascot use case. Auto-included
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
  /** Per-channel voice overrides, keyed by project/channel slug. */
  channel_profiles?: Record<string, CharacterChannelProfile>
  references?: CharacterReferences

  /**
   * Channel assignment labels. The persisted key remains `projects` so older
   * installations can read the data, but each slug represents one channel.
   * Undefined/empty = available in the library but not assigned to a channel.
   * Per-project on-disk characters leave this undefined — their folder
   * location IS their assignment. See docs/character-unification-spec.md.
   */
  projects?: string[]

  /**
   * Provenance — purely informational, set on create + persists across edits.
   *   'project'  — authored in a project (or the canonical library record).
   *   'imported' — snapshot-copied into a project via import-to/:slug.
   *   'library'  — surfaced into a project's unified view by assignment
   *                (lives in the app-level library, tagged with this slug).
   */
  source: 'project' | 'imported' | 'library'
  schemaVersion: 1
  created_at: string
}

/**
 * Portable manifest (schema v2). Cached as `cache/manifest.json` inside the
 * project folder whenever project metadata changes, so it travels with the
 * folder when the user syncs via iCloud / Google Drive / OneDrive.
 *
 * It used to ALSO be written as `.story-studio-project.json` at the root of a
 * project's episodes folder, but only when that folder sat outside the project
 * directory. Episodes always live at `<projectDir>/episodes` now, so that
 * write could never fire again and is gone; files of that name still exist on
 * disk from older versions and are simply ignored.
 *
 * Schema v2 is intentionally small — just enough structure for another
 * machine to recognise the folder and line up episode codes with folder
 * names. Presets, production standards, YouTube templates, voice presets,
 * and "required named roots" are NOT manifest/cloud data. Presets have one
 * local app-owned list; machine paths and secrets are configured locally.
 * This keeps the manifest ≤1 KB and avoids conflicting configuration copies.
 *
 * Back-compat note: v1 manifests (with the preset bag) may still exist on
 * disk. The extra payload is not part of this type and is not carried
 * forward; a v2 manifest is written from `ProjectMeta` every time.
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
  last_seen_manifest_mtime?: number
}

export interface CreateProjectRequest {
  name: string
  /**
   * 2026-10-28 — the channel folder name, chosen outright.
   *
   * Optional. When present it is validated as safe Latin (`a-z`, `0-9`, single
   * hyphens) and must be free; a clash is refused rather than silently renamed.
   * When absent the slug is derived from `name`, falling back to
   * `channel-<short id>` for a name with no Latin characters. There is no rename
   * API: this only names a NEW channel, and nothing stored is rewritten.
   */
  slug?: string
  /**
   * v1.4.20 — how often this channel publishes, set when the channel is made.
   *
   * An Upload Plan is keyed `platform:account_id` and so cannot exist before a
   * YouTube account is connected — a channel can predate its account by
   * months. Storing the cadence on the CHANNEL means a new channel has a
   * publishing rhythm from day one, and the plan is created from it the moment
   * an account is connected. See services/publish-cadence.ts.
   */
  publish_cadence?: {
    schedule: {
      weekdays: number[]
      time_local: string
      timezone: string
      interval_weeks?: number
      monthly_day?: number
      start_date?: string
      end_date?: string
    }
    defaults?: { privacy_status: 'private' | 'unlisted' | 'public'; language?: string; made_for_kids?: boolean }
  }
  /** v1.4.20 — write a publish time onto each episode as its render finishes. */
  auto_schedule_on_render?: boolean
  template?: string
  episode_prefix?: string
  episode_digits?: number
  season_prefix?: string
  season_size?: number
  // (Removed: output_root. A channel's episodes always live in the channel's
  // own folder, so there is nothing for the create form to choose. See
  // ProjectMeta above for why the choice was withdrawn.)
  // (Removed: portable. Legacy multi-machine flag — accepted on the
  // wire for back-compat with old clients but ignored by createProject.)
  portable?: boolean
  /** Accepted for old API clients; new channels always start on Continuity. */
  format_id?: string
  continuity_mode?: 'character-continuity' | 'independent-stills' | 'explainer-stills'
  /**
   * Optional starter niche (subject-domain) for the new project. Picked
   * via the Niche picker in the Create Project wizard. Persisted to the
   * project meta as `niche_id`. Unset = no niche, format defaults apply
   * unchanged. Validated server-side: unknown ids are silently dropped
   * rather than rejecting the create, matching how format_id behaves.
   */
  niche_id?: string
  /**
   * The wizard's explicit Formula choice. `'generic'` means the customer
   * deliberately chose a channel with no Formula (owner ruling, 2026-10-25);
   * `'selected'` accompanies a `niche_id`. Absent keeps older API clients and
   * tests working, and leaves the project in the "never chose" state the
   * in-app prompt is for.
   */
  formula_choice?: 'selected' | 'generic'
  /** Optional Topic Packs under niche_id; absent uses formula defaults. */
  topic_pack_ids?: string[]
  /** Audience-facing language. Absent keeps legacy prompts unchanged. */
  content_language?: ContentLanguage
  /** Future-only automatic introductions; absent = OFF. */
  auto_introduction_enabled?: boolean
}

export interface UpdateProjectRequest {
  name?: string
  episode_prefix?: string
  episode_digits?: number
  season_size?: number
  season_prefix?: string
  folder_template?: string
  subfolder_names?: SubfolderNames
  // (Removed: output_root. Episodes are not relocatable — see ProjectMeta.)
  // (Removed: portable. Accepted on the wire for back-compat; updateProject
  // ignores it. Cloud sync is now configured app-wide via Storage tab.)
  portable?: boolean
  youtube_channel_url?: string
  format_id?: string
  continuity_mode?: 'character-continuity' | 'independent-stills' | 'explainer-stills'
  format_overrides?: DeepPartial<Format>
  content_mode?: 'format' | 'freeform'
  /** Audience-facing language. `null` clears back to legacy (no directive). */
  content_language?: ContentLanguage | null
  /** Future-only automatic introductions; false turns it off. */
  auto_introduction_enabled?: boolean
  /**
   * The owner's labels for this channel. Normalised on the way in
   * (`contracts/project-labels.ts`); `[]` clears them. See `ProjectMeta.labels`.
   */
  labels?: string[]
}

/**
 * iCloud-aware sync state for a project candidate.
 *
 *   'ready'       — project.json + config.json read successfully.
 *   'downloading' — project.json is an iCloud placeholder OR the read
 *                   timed out (30s). All metadata fields except `slug`
 *                   and the episodes path may be empty/absent. The home page
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
   * ABSOLUTE path to where this channel's episodes live — always
   * `<projectDir>/episodes`, COMPUTED by `resolveOutputRoot()` at the moment
   * the list is built.
   *
   * This is not, and can no longer be, a setting. The stored
   * `project.json.output_root` was deleted along with the ability to choose
   * a folder; this field keeps its name only because it is what the home
   * page has always read, and because there is no longer any stored value it
   * could be confused with. Read it as "where the episodes are", never as
   * "where someone said to put them" — nothing writes it back.
   */
  output_root?: string
  /**
   * Whether that folder exists on disk right now. Kept deliberately: the
   * point of the deletion was to stop a channel pointing somewhere that is
   * not there, NOT to stop saying so. When `false` the home page names the
   * folder it looked for. Nothing creates the folder to make this true.
   */
  output_root_exists?: boolean
  /** iCloud sync state — see `ProjectSummaryStatus`. */
  status?: ProjectSummaryStatus
  /** v1.0.302 — the project's configured `format_id` (raw; may be a legacy
   *  alias). The home page maps it to a friendly format name for the card
   *  badge. Undefined for projects with no format_id set (→ shown as the
   *  default format). */
  format_id?: string
  /** The project's selected niche, already read with this list row's metadata. */
  niche_id?: string
  /**
   * Whether the Formula was a deliberate choice — the same three states as
   * `ProjectMeta.formula_choice`. Absent is "never chose", which the card must
   * not render as Generic. Read with this row's metadata.
   */
  formula_choice?: 'selected' | 'generic'
  /**
   * The Formula's display name, resolved ONCE per list by the `/projects`
   * route from the Formulas installed on this machine: the alias-resolved
   * store Formula's name, the stored id when that Formula is not installed,
   * `Generic — no Formula` for a deliberate Generic choice, `No Formula chosen`
   * when no choice was ever recorded. Not set by `listProjects` itself — the
   * route adds it, because the catalogue is a heavier read than a channel row.
   */
  formula_name?: string
  /** The qualified Formula id the stored `niche_id` reads as (alias-resolved).
   *  The card's search matches it; nothing dispatches on it. */
  formula_id?: string
  /** The owner's labels for this channel, already read with this row's
   *  metadata. Undefined = none set. See `ProjectMeta.labels`. */
  labels?: string[]
  /** Audience language, already read with this row's metadata. Undefined =
   *  legacy (no directive), the same meaning it has on `ProjectMeta`. */
  content_language?: ContentLanguage | null
  /**
   * When this channel was last WORKED ON — the newest modification time of its
   * own work files and its episodes (scripts, sidecars, text artifacts,
   * media/generation activity), as an ISO string. See
   * `services/channel-recency.ts` for the exact definition and what it ignores.
   *
   * Read with this row so the start page can sort by it without a second pass
   * over the Library. `null` means UNKNOWN — the folder could not be read —
   * which is deliberately not the same answer as "a long time ago" and is
   * sorted last rather than treated as the oldest. The field is omitted (not
   * null) when the caller did not ask for it: only the channel-list route does
   * (`listProjects({ recency: true })`), because it is the only screen that
   * renders the sort and the walk is not free.
   */
  last_worked_at?: string | null
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
  /**
   * Provider request overrides for this tier. This is intentionally a
   * structured object rather than a model-specific field so resolution tiers
   * can map to provider inputs such as `{ input_params: { quality: 'high' } }`
   * without teaching every caller about each provider's vocabulary.
   */
  provider_params?: Record<string, unknown>
}

/**
 * One published `(resolution, aspect_ratio)` combination, copied verbatim from
 * GenStudio's `ImageOutputOptionResponse`.
 *
 * A row IS the combination: its `width`/`height` are the real output size and
 * its credits are the price of THAT combination. Rows are never split into
 * separate resolution and ratio lists and recombined — that would advertise
 * pairings GenStudio has not declared valid.
 */
export interface ImageOutputOption {
  resolution: string
  aspect_ratio: string
  width: number
  height: number
  is_default: boolean
  /** Price of this combination. Absent = GenStudio published none for the row. */
  credits_per_image?: number
  /** Undiscounted price of this combination, when a promotion is running. */
  base_credits_per_image?: number
  price_version?: string
  /** Full effective rate when this combination is rendered from reference images. */
  reference_generation_credits?: number
  reference_generation_price_version?: string
}

export interface ImageModelConfig {
  label: string
  /**
   * Default cost per image. For variable-priced models with `tiers`, this
   * mirrors the credits of `default_tier` so legacy callers (no tier in
   * request) get a sensible default. The cost calculator looks up
   * `tiers[tier_id].credits` first, then falls through to this.
   *
   * ABSENT when GenStudio publishes no price for the product. It is never
   * zero-filled: a customer cannot tell an invented 0 apart from a free model.
   */
  credits_per_image?: number
  /**
   * Optional price tiers. When present, the UI renders a tier picker
   * (resolution / speed / etc.) and the cost calculator routes requests
   * to the tier-specific credit cost. Absent = single flat price.
   */
  tiers?: ImageModelTier[]
  /** Tier id whose credits == credits_per_image. Required when `tiers` is set. */
  default_tier?: string
  /** Optional provider request fields shared by every call for this model. */
  provider_params?: Record<string, unknown>
  /** Extra fields merged into a jobs-style provider's `input` object. */
  input_params?: Record<string, unknown>
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
   * Soft per-prompt character cap based on the provider's documented limit
   * (approximate — providers don't always publish exact numbers, and some
   * silently truncate vs. error). Used by the UI to warn users when a
   * generated image prompt would be rejected or silently clipped by the
   * provider so they can shorten before paying credits. Absent = treat as
   * "no documented cap" (rendering shows "—"). NEVER enforced server-side
   * — kept advisory so the provider's behaviour stays the single source
   * of truth and we don't ship false-positive blocks when a cap shifts.
   */
  prompt_char_cap?: number
  /**
   * Some kie.ai models split text-to-image and image-to-image into TWO
   * distinct slugs (e.g. `gpt-image-2-text-to-image` vs
   * `gpt-image-2-image-to-image`, `google/nano-banana` vs
   * `google/nano-banana-edit`). When set, kie-client uses this slug
   * instead of `api_model` whenever reference images are attached to the
   * request. Absent = same slug handles both modes (NB2, Flux Kontext).
   */
  api_model_i2i?: string
  /**
   * Per-model name of the request-body field that carries reference image
   * URLs. kie.ai's catalog is inconsistent — `image_urls` (most), `image_input`
   * (Nano Banana 2 family), `input_urls` (GPT Image 2 i2i), `inputImages`
   * (Flux Kontext). Defaults to `image_urls` when absent.
   */
  refs_field?: string
  /**
   * Some kie.ai endpoints require hosted URLs for refs instead of accepting
   * base64 data URLs directly. When true, local references are first uploaded
   * to kie.ai's temporary file service before the generation task is created.
   */
  refs_upload?: boolean
  /**
   * Per-model name of the request-body field that carries the aspect-ratio
   * string. Most kie.ai models use `aspect_ratio` (default); the original
   * Nano Banana family uses `image_size`. Absent = `aspect_ratio`.
   */
  aspect_field?: string
  /**
   * Published capability mirror (v1.0.788). Every field below is copied
   * verbatim from GenStudio's live image catalogue by
   * `services/image-model-resolver.ts` — none of it is synthesised, and a
   * field GenStudio does not publish is simply absent rather than guessed.
   * Absent therefore means "not published", never "false" or "zero", and
   * saved projects that predate these fields degrade to the same
   * "capability unknown" path instead of breaking.
   */
  /** Ceiling on references this model accepts. 0 = references unsupported. */
  max_reference_images?: number
  /** Floor an image-to-image-only model requires before it will render. */
  min_reference_images?: number
  /**
   * Longest-edge pixel ceiling for a reference image. Absent = the model
   * publishes none, so nothing local may impose one.
   *
   * Carried down to generators (not just the provider) because a generator can
   * be submitting a reference IT produced: `generators/continuity-render.ts`
   * attaches the episode's own composition template, which this app renders at
   * the model's published OUTPUT size — larger, on every current product, than
   * this reference ceiling. Knowing the number is what lets it fit its own
   * artefact instead of failing the batch with advice to go and resize a file
   * the customer never made.
   */
  reference_image_max_dimension?: number
  /** Explicit img2img declaration where a model separates it from references. */
  supports_image_to_image?: boolean
  /** Whether a deterministic seed is honoured. Absent = not published. */
  supports_seed?: boolean
  /** Ratios the model publishes. Empty/absent = nothing published to validate against. */
  aspect_ratios?: string[]
  /**
   * Ratio the model itself declares as its default.
   *
   * NOT the ratio used for an omitted request. Owner decision 2026-10-17:
   * a missing ratio prefers 16:9 when the live catalogue publishes a
   * renderable 16:9, then falls back to this published default — see
   * `contracts/genstudio-image-defaults.ts`. Do not "fix" that back to
   * "never default to 16:9 locally"; that was the previous, reversed rule.
   */
  default_aspect_ratio?: string
  /** Resolution label used when a request names none. Never invented locally. */
  default_resolution?: string
  /**
   * Valid `(resolution, aspect_ratio)` combinations, each with its own
   * dimensions and price. Absent = the model publishes none, so the flow runs
   * on aspect ratio alone and GenStudio applies its own default resolution.
   */
  output_options?: ImageOutputOption[]
  /** Live availability at resolve time. */
  available?: boolean
  /** Account cannot submit to this model without qualifying. */
  qualification_only?: boolean
  /** Whether submissions to this model consume credits. */
  chargeable?: boolean
}

export interface AudioModelConfig {
  label: string
  /**
   * Which provider to route this model to. Optional for backward compat —
   * if missing, the audio generator falls back to prefix-based detection
   * (`genaipro-*` → genaipro, `eleven_*` → elevenlabs, else fal).
   */
  provider?: 'fal' | 'genaipro' | 'elevenlabs' | 'voicestudio' | 'genstudio' | 'macos' | 'fishaudio' | 'kie'
}

/** One exact duration/resolution pair published by GenStudio for a motion clip. */
export interface SceneClipVariantSelection {
  operation: string
  duration_seconds: number
  resolution: string
  /**
   * The published aspect ratio of that row, where the catalogue states one per row.
   *
   * Optional because most products publish a ratio list rather than a ratio per variant.
   * Where it IS published it is part of the row's identity: a Studio Hub video lane's 448p
   * class carries both 704x448 (11:7) and 448x448 (1:1), so the duration and resolution
   * alone do not name one picture.
   */
  aspect_ratio?: string
}

export interface VoicePreset {
  name: string
  voice_id: string
  providers: Array<'elevenlabs' | 'fal' | 'genaipro' | 'kie' | 'fishaudio' | 'genstudio'>
}

/**
 * User-saved image-style description, typically captured from
 * `/analyze-style` (vision-LLM extraction off a reference image) and named
 * for reuse across episodes. The dropdown on image-prompts.vue shows
 * these in a "Custom" optgroup beside installed Content Pack styles.
 *
 * Stored on ProjectConfig (per-project) — not a global library — because
 * style choice is tightly coupled to a project's visual identity. A future
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
  /**
   * Optional rendered preview PNG for this preset. v1.0.89+. Filename
   * (e.g. "bound-cartoon.png") inside the project's `style-previews/`
   * directory — kept relative so the file moves with the project across
   * machines via iCloud. When set, the Image Generator's preset dropdown
   * shows the actual sample inline without a re-render. Absent on
   * presets that were imported from text-only sources (e.g. /analyze-style).
   */
  preview_filename?: string
  /** v1.0.432+ — optional multi-sample gallery copied into the project. */
  preview_files?: string[]
  /** Image model the preview PNG was rendered against. Surfaced as a hint
   *  so users know the saved sample may not match a render under different
   *  model/aspect/tier settings. */
  preview_model?: string
  preview_aspect_ratio?: string
  preview_tier?: string
  /** Saved-against timestamp (separate from `created_at` because a preset
   *  can be saved description-only first, then have a preview attached
   *  later). */
  preview_saved_at?: string
  /**
   * Owner, 2026-10-25 — the hash of the style TEXT the three previews on screen
   * were made from.
   *
   * A channel style's three previews are not stored here: they live in the
   * shared content-addressed store, keyed by the hash of the style text, so the
   * same text in seventeen channels is one set of three images generated once
   * (`services/channel-style-previews.ts`). This field is only the POINTER that
   * makes an edit visible: when the hash of `description` no longer matches it,
   * the previews on screen were made from text this style no longer has, and
   * they are shown as out of date rather than as current.
   *
   * Absent on presets whose previews predate the three framings — their
   * `preview_files` are shown capped at three and out of date, and are never
   * deleted.
   */
  preview_source_hash?: string
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

/**
 * A customer-controlled, project-scoped narration review policy. This is
 * deliberately separate from Audio/Subtitles presets: a preset chooses reusable
 * request controls, while this choice authorizes an operational workflow.
 */
export interface AudioQualityProjectConfig {
  mode: 'off' | 'flag_issues' | 'check_and_repair'
  /** Published alternate transcription model selected by the customer. */
  alternate_transcription_model?: string
}

/**
 * What Story Studio did with a project's retired LLM lineup (2026-10-03), written once.
 * The lineup itself stays on disk under `llm_lineup` and is never read again.
 */
export interface LlmLineupMigration {
  /** The ONE writing model kept for steps that had none: a matching Gateway pool, or the lineup's first model. */
  model: string
  /** True when `model` is a Gateway pool whose members matched the lineup. */
  pool: boolean
  /** Pipeline steps whose saved preset had no writing model and now has `model`. */
  steps: string[]
  migrated_at: string
  /** Set when the owner closes the one-time notice on the Pipeline page. */
  notice_dismissed_at?: string
}

/**
 * The channel's own identity, stored on the channel (2026-10-21).
 *
 * LOCAL only: the app's own record of the channel's handle, About text and
 * art, so the owner can see and edit them here. Never written back to a
 * channel on any platform. The length and character rules are the app's own
 * input rules, not a statement about what any platform accepts.
 *
 * The channel's NAME is not one of these fields — it stays authoritative in
 * `ProjectMeta.name` (project.json), changed through `pm.updateProject`, so
 * there is one name for a channel and no second copy to drift.
 *
 * `logo`/`banner` hold a PORTABLE token — "${CHANNEL}/assets/profile/<kind>-<digest>.<ext>"
 * — never an absolute path and never a path from another machine, so the art
 * travels with the channel folder.
 */
export interface ChannelProfileConfig {
  /** The channel's handle, stored without a leading "@". */
  handle?: string
  /** The channel's About text. */
  description?: string
  /** Portable token of the logo art. */
  logo?: string
  /** Portable token of the banner art. */
  banner?: string
}

export type SceneClipRenderer = 'image_to_video' | 'sketch_draw' | 'text_to_video'
export type VisualLane = 'still' | 'sketch_draw' | 'image_to_video' | 'text_to_video' | 'imported'
export type SketchDrawPenMode = 'none' | 'plain' | 'name' | 'logo'
export interface MotionPresentationSettings {
  renderer: SceneClipRenderer
  pen: SketchDrawPenMode
  /** The channel DEFAULT closing hold; an episode may carry its own (`sketch_hold.json`). Absent means auto. */
  hold?: SketchHoldSetting
  /**
   * How the finished drawing arrives — one style, or a Mix resolved per scene. This is the
   * CHANNEL DEFAULT only: an episode that has chosen its own reveal (in its own
   * `sketch_reveal.json`) ignores it. ABSENT means the channel has never chosen one, which is what
   * keeps every clip rendered before this control existed fresh.
   */
  reveal?: SketchRevealSetting
}

export interface ProjectConfig {
  /**
   * Thumbnail text layer — draw a real headline onto a copy of a text-free thumbnail
   * (owner, 2026-10-24). Absent means off, so every existing channel is untouched and the
   * routes still work: the page decides what to show, the server never gates on this.
   */
  thumbnail_text_layer_enabled?: boolean
  /** 1.4.300 — per-channel Off / Warn / Block for each safety check; only changed rows are saved. */
  safety_checks?: Record<string, 'off' | 'warn' | 'block'>
  /**
   * The channel's local identity — handle, About text and the logo/banner
   * art the app shows for this channel. See `ChannelProfileConfig`; the
   * channel's name stays in `ProjectMeta.name`.
   */
  channel_profile?: ChannelProfileConfig
  /** Channel presentation selections only; images, duration and branding resolve live. */
  motion_presentation?: MotionPresentationSettings
  /**
   * The Facebook / Instagram / TikTok accounts this channel posts with, keyed by
   * platform. Absent = the channel has not connected that platform. The account
   * ids are opaque platform identities; the credentials stay in app-secrets.
   */
  social_accounts?: Partial<Record<'facebook' | 'instagram' | 'tiktok', string>>
  /**
   * The platforms this channel posts to by default, pre-ticked on every upload.
   * Absent or `[]` = post nowhere. This is only a DEFAULT: the per-upload tick
   * decides, and a cleared tick never posts.
   */
  social_platforms?: Array<'facebook' | 'instagram' | 'tiktok'>
  llm_lineup_migration?: LlmLineupMigration
  /** Historical project files may contain retired fields; Story ignores them. */
  [key: string]: any
  genstudio_api_key?: string
  google_api_key?: string
  /**
   * YouTube videoCategories.list ID applied to every fresh upload
   * + metadata-only PATCH for this project. Default 24 ("Entertainment")
   * as of v1.0.77 (was 22 "People & Blogs"). Set per-project on
   * Settings → Project.
   */
  category_id?: number
  /**
   * v1.0.77 — Per-project override for YouTube's "altered or synthetic
   * content" disclosure. When true, fresh uploads include
   * `status.containsSyntheticMedia: true` in the videos.insert body.
   * Undefined = inherit the app-level default (which itself defaults to
   * true since Story Studio's primary use is AI-generated content).
   */
  mark_as_ai_generated?: boolean
  image_models: Record<string, ImageModelConfig>
  image_pricing_last_updated: string
  voice_presets: VoicePreset[]
  /** Per-project list of favourited voice_ids, pinned to the top of the picker. */
  voice_favourites?: string[]
  /** User-saved image-style descriptions (typically from `/analyze-style`). */
  style_presets?: StylePreset[]
  /**
   * v1.0.518 — the project's ACTIVE art style. Id of the `style_presets`
   * entry (or a legacy style id already materialized in `style_presets`)
   * that is auto-applied to every generated image prompt for this project.
   * When set, it fully replaces the format+niche style tag; the style's
   * preview image is also fed into img2img generation as a reference. Unset
   * = fall back to the format+niche merged tag. Resolved via
   * services/art-style-resolver.ts.
   */
  active_style_preset_id?: string
  audio_models: Record<string, AudioModelConfig>
  audio_pricing_last_updated: string
  confirmation_preferences?: ConfirmationPreferences
  /** Optional narration inspection/repair workflow. Missing means Off. */
  audio_quality?: AudioQualityProjectConfig
  /** Optional, reviewed documentary annotation layer. Disabled by default. */
  contextual_cues?: ContextualCueProjectConfig
  /** Optional, reviewed sound-design layer. Disabled by default. */
  sound_design?: SoundDesignProjectConfig
  /**
   * Optional final-video review marks (owner, 2026-10-29). Absent or false = off, so every
   * existing channel is untouched: no mark is written, no review state is shown, and nothing in
   * production reads it. A mark is a review note only — it authorises no upload or publish.
   */
  final_review?: { enabled: boolean }

  /** App-level B-Roll pool used by the B-Roll picker and Video Assembly. */
  broll_pool_id?: string
  /** Per-channel usage log for B-Roll repeat avoidance. */
  broll_usage_log?: BrollUsageEntry[]
  /** How many recent uploads to consult when avoiding repeats (default 10). */
  broll_lookback?: number
  /** Channel-locked metadata template (LLM fills placeholders only). */
  /**
   * The channel's default metadata formula — the architecture its YouTube
   * write-ups are built to (2026-08-27). Unset means the pre-formula behaviour,
   * which is why adding this changes no existing channel's output. A single
   * episode can override it; see `metadata_formula_id` on the metadata job.
   */
  metadata_formula_id?: string
  metadata_template?: MetadataTemplate

  /**
   * v1.0.104+ — absolute path to this project's channel-logo PNG.
   * Used by the thumbnail composer's logoSlot. Saved here so the
   * user only picks the file once per project; the Compose dialog
   * pre-fills from this value.
   */
  channel_logo_path?: string
  /**
   * v1.0.105+ — explicit thumbnail-template override for this project.
   * Wins over `niche.defaultThumbnailTemplateId` in the compose
   * resolution chain, so a prayer-niche project can opt into the
   * `centered-hero-headline` style (or any other library template)
   * without touching the niche JSON. Empty / unset = use the niche's
   * default.
   */
  thumbnail_template_id?: string

  /**
   * v1.0.106+ — recency-avoidance log. Generic across niches: each
   * entry records WHAT was used (kind matches niche.recencyAvoidance.label),
   * the item itself (extracted from the generated script), the episode
   * it appeared in, and when. Capped at 500 entries (trimmed oldest-
   * first) so storage stays bounded even on long-running channels.
   *
   * The pre-generation builder reads the last N entries (where N comes
   * from `recency_lookback`, or the niche's `defaultLookback`, or 30)
   * matching the active niche's `kind` and tells the LLM to avoid them.
   */
  recency_log?: RecencyLogEntry[]
  /**
   * Per-project override for the recency-avoidance lookback window.
   * Falls back to niche.recencyAvoidance.defaultLookback (typically 30),
   * which falls back to a hard-coded 30. Larger = stricter avoidance,
   * bigger prompt; smaller = more repetition tolerance, smaller prompt.
   */
  recency_lookback?: number

  /**
   * v1.0.107+ — background music pool. Files live in
   * {projectDir}/music/ (auto-discovered — drop in via Finder OR add
   * via the UI). This config block holds the cycling strategy + state
   * (cursor, usage log) + per-track metadata (enabled / label) layered
   * on top of the disk-resident files.
   *
   * Strategies:
   *   - 'sequential'        — E1=track1, E2=track2, ..., wraps via cursor
   *   - 'random-no-repeat'  — random pick from tracks NOT used in the
   *                           last N episodes (N = music_pool_lookback)
   *   - 'manual'            — no auto-pick; user picks every episode
   *                           (matches pre-v1.0.107 behaviour)
   */
  music_pool_strategy?: 'sequential' | 'random-no-repeat' | 'manual'
  /** Position in the sequential rotation. 0-indexed; the next pick is
   *  tracks[cursor % tracks.length]. Advances when a merge job actually
   *  USES the pool's pick (not on every page open). */
  music_pool_cursor?: number
  /** How many recent episodes the 'random-no-repeat' strategy
   *  consults. Default 5 — a small lookback because pools are usually
   *  5-15 tracks (a 30-episode lookback on a 5-track pool blocks
   *  everything). */
  music_pool_lookback?: number
  /** Recent usage log used by 'random-no-repeat' to avoid recent picks
   *  AND to attribute the cycler's choice to the right episode. Capped
   *  at 100 entries (trimmed oldest-first). */
  music_pool_usage_log?: MusicPoolUsageEntry[]
  /** Per-track metadata layered on top of the auto-discovered file
   *  list. Tracks not present in the folder are pruned from this array
   *  on every read so renames/deletes via Finder don't leak orphaned
   *  metadata. */
  music_pool_tracks?: MusicPoolTrack[]
  /**
   * v1.4.37 — the channel's MUSIC LIBRARY, kept separate from the
   * narration-bed pool above. See `MusicLibraryTrack` for why they are not one
   * thing. Pruned on every read the same way, so a Finder delete cannot leak
   * orphaned metadata.
   */
  music_library_tracks?: MusicLibraryTrack[]
  music_library_usage_log?: MusicLibraryUsageEntry[]
}

/** v1.0.107+ — per-track metadata in the background-music pool. */
export interface MusicPoolTrack {
  /** Filename relative to {projectDir}/music/. The disk path is the
   *  source of truth; this entry adds an enabled flag + optional human
   *  label on top. */
  filename: string
  /** Whether this track is eligible for auto-cycling. Disabled tracks
   *  stay in the pool (file kept on disk) but are skipped by
   *  pickNext(). Default true. */
  enabled: boolean
  /** Optional human-friendly label shown in the pool UI ("Soft Piano
   *  Loop", "Pad Wash 2 — calm"). Falls back to the filename. */
  label?: string
  /**
   * v1.0.108+ — optional per-track volume/fade overrides. When set,
   * a merge job sourced from the pool uses these instead of the form's
   * global music settings. Useful when a louder ambient bed needs its
   * own level (e.g. one track masters quieter than the rest of the
   * pool). All three fields are independent — set only what you want
   * to override.
   *   - volume:               0–100 (UI scale, % during narration)
   *   - post_narration_volume 0–100 (UI scale, % after narration ends)
   *   - fade_in / fade_out:   seconds, 0–10 typical
   */
  volume?: number
  post_narration_volume?: number
  fade_in?: number
  fade_out?: number
}

/** v1.0.107+ — one entry in the music-pool usage log. */
export interface MusicPoolUsageEntry {
  filename: string
  episode_code: string
  used_at: string
}

/**
 * v1.4.37 — one track in a channel's MUSIC LIBRARY.
 *
 * NOT the same thing as `MusicPoolTrack`, and deliberately not merged with it.
 * `MusicPoolTrack` describes the background bed that ducks under narration
 * ({projectDir}/music/, one track chosen per episode). This describes a
 * channel's record collection ({projectDir}/music-library/), which a music-mix
 * video is BUILT FROM — many tracks per video, chosen to fill a runtime.
 *
 * The owner ruled both stay, with their own pages, because they are different
 * jobs. Overloading one folder would put a narration bed into a mix.
 */
export interface MusicLibraryTrack {
  /** Filename relative to {projectDir}/music-library/. Disk is the truth. */
  filename: string
  /** Human title shown in the tracklist. Written by the planner alongside the
   *  prompt, so distinct titles cost nothing extra. Falls back to filename. */
  title: string
  /** Eligible for automatic mix selection. A disabled track stays on disk. */
  enabled: boolean
  /** Seconds, measured from the file — the mix builder fills a runtime with it. */
  duration_sec?: number
  /**
   * Tracks that came back from ONE GenStudio request share this id.
   *
   * Suno returns two complete songs per charge, and because both come from the
   * same instruction they sound like cousins — same mood, same instruments,
   * similar tempo. Played back to back a listener hears one song repeating, so
   * the mix builder keeps siblings apart. This id is the only way it can know.
   */
  sibling_group?: string
  /** Which take of its request this was (1-based), for naming and ordering. */
  sibling_index?: number
  /** The brief that produced it, so a library can be filtered by top-up run. */
  brief_id?: string
  /** Free-form mood tags for filtering and for the mix builder's arc. */
  tags?: string[]
  /** GenStudio job id, when generated. Absent for a file dropped in via Finder. */
  genstudio_job_id?: string
  /** ISO timestamp this row was created. */
  added_at?: string
}

/** One recorded use of a library track in a rendered mix. */
export interface MusicLibraryUsageEntry {
  filename: string
  episode_code: string
  used_at: string
}

/**
 * One entry in the recency-avoidance log. Generic across niches —
 * `kind` is the discriminator (matches niche.recencyAvoidance.label).
 */
export interface RecencyLogEntry {
  /** Episode this item appeared in. */
  episode_code: string
  /** ISO timestamp when the entry was appended. */
  used_at: string
  /** Discriminator matching the niche's recencyAvoidance.label. */
  kind: string
  /** The extracted item itself ("Psalm 91", "Philippians 4:6-7", etc.). */
  item: string
}

/** Per-clip usage record for B-Roll repeat-avoidance (project-scoped). */
export interface BrollUsageEntry {
  clip_sha: string
  clip_filename: string
  episode_code: string
  used_at: string
}

/** Channel-locked metadata template. */
export interface MetadataTemplate {
  title?: string
  description?: string
  tags?: string[]
}

export interface SafeProjectConfig {
  llm_lineup_migration?: LlmLineupMigration
  has_genstudio_key: boolean
  has_google_key?: boolean
  /** @deprecated v1.0.150 — removed alongside the standalone Chatterbox provider. */
  chatterbox_enabled?: boolean
  /** @deprecated v1.0.150 — removed alongside the standalone Chatterbox provider. */
  chatterbox_reference_id?: string
  image_models: Record<string, ImageModelConfig>
  image_pricing_last_updated: string
  voice_presets: VoicePreset[]
  voice_favourites?: string[]
  style_presets?: StylePreset[]
  audio_models: Record<string, AudioModelConfig>
  audio_pricing_last_updated: string
  confirmation_preferences?: ConfirmationPreferences
  audio_quality?: AudioQualityProjectConfig
  broll_pool_id?: string
  broll_lookback?: number
  /**
   * The channel's default metadata formula — the architecture its YouTube
   * write-ups are built to (2026-08-27). Unset means the pre-formula behaviour,
   * which is why adding this changes no existing channel's output. A single
   * episode can override it; see `metadata_formula_id` on the metadata job.
   */
  metadata_formula_id?: string
  metadata_template?: MetadataTemplate
}

export interface UpdateApiKeysRequest {
  [key: string]: string | undefined
  genstudio_api_key?: string
  google_api_key?: string
}

export interface UpdateConfigRequest {
  /** 1.4.300 — per-channel Off / Warn / Block for each safety check. */
  safety_checks?: Record<string, 'off' | 'warn' | 'block'>
  /** Server-written only (the HTTP schema strips it). */
  llm_lineup_migration?: LlmLineupMigration
  image_models?: Record<string, ImageModelConfig>
  voice_presets?: VoicePreset[]
  voice_favourites?: string[]
  audio_models?: Record<string, AudioModelConfig>
  confirmation_preferences?: ConfirmationPreferences
  audio_quality?: AudioQualityProjectConfig
  active_style_preset_id?: string
  thumbnail_template_id?: string
  /**
   * Declared rather than cast, for the same reason as the music fields below:
   * `applyConfigRequest` is a pass-through with an exclude list, so this was
   * always written correctly — the style-preset routes reached it through
   * `as any` only because the interface was never widened. Declaring it means a
   * write of the three previews' source pointer is type-checked instead of
   * trusted (`services/channel-style-previews.ts`).
   */
  style_presets?: StylePreset[]
  /**
   * v1.4.37 — declared rather than cast. `applyConfigRequest` is a pass-through
   * with an exclude list, not an allowlist, so these were always written
   * correctly; the older music-pool writes reach it via `as any` only because
   * this interface was never widened. Declaring them means the music library's
   * writes are type-checked instead of trusted.
   */
  music_library_tracks?: MusicLibraryTrack[]
  music_library_usage_log?: MusicLibraryUsageEntry[]
  /**
   * Scene Plan batch tuning, per channel. Declared rather than cast for the
   * same reason as the music fields above. Defaults (300 / 0.75 / 250) live in
   * `services/scene-prompt-batching.ts`; there is deliberately no upper bound
   * on any of them in code, because a hardcoded batch ceiling is exactly what
   * these replaced.
   */
  scene_prompt_tokens_per_scene?: number
  scene_prompt_output_safety_fraction?: number
  scene_prompt_batch_size?: number
  /**
   * Research page → "Approve claims automatically". When true, a research run
   * that produces claims marks them approved through the SAME transition a
   * hand triage uses, stamped `review.completed_by: 'auto-approval'` so the
   * provenance never reads as a person. Absent = off; the default lives in
   * `lib/research-verification.ts` (researchAutoApproveEnabled), not here.
   */
  research_auto_approve_claims?: boolean
  /**
   * E2–E4 (1.4.288) — scene analysis for this channel (Effects Library). Off unless set. `depth`
   * (3D photo, rack focus) is its own switch (owner); `vision` finds the subject, points of interest
   * and outlines (sky, water, flames…). The models are picked app-wide.
   */
  scene_analysis?: { depth?: boolean; vision?: boolean }
  /**
   * Still Posts (owner, 2026-10-27) — the channel's cast, handle override and logo file. Declared
   * rather than cast for the same reason as the music fields above: `applyConfigRequest` is a
   * pass-through, and declaring the write makes it type-checked instead of trusted.
   */
  still_posts?: Record<string, any>
  still_post_presets?: Array<Record<string, any>>
  still_post_last_preset?: string
  /** The channel's optional final-video review switch (owner, 2026-10-29). Absent = off. */
  final_review?: { enabled: boolean }
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export const JOB_TYPES = [
  'idea_campaign', 'broll_select', 'introduction-only', 'chapter-only',
  'outline_only', 'expand_chapters', 'image_prompts', 'thumb_images', 'images_repair', 'audio', 'audio_merge',
  'metadata', 'video_assembly',
  'subtitles_transcribe', 'youtube_upload', 'youtube_playlist_update',
  'youtube_thumbnail_refresh', 'broll_normalize', 'broll_assemble',
  /** Post one finished episode to the Facebook / Instagram / TikTok accounts the owner ticked. */
  'social_publish',
  'research_run', 'scene_plan_run',
  'scene_image_generate', 'scene_clip_generate',
  'scene_clips_batch', 'continuity_render',
  'composition_generate', 'contextual_cues',
  'image_pool_generate',
  /** v1.4.37 — top up a channel's music library from one style brief. */
  'music_generate',
  /** v1.4.37 — assemble one music video from the library. Spends nothing. */
  'music_video',
  /** Episode Builder: stitch an episode's songs and hand it to Video Assembly. Spends nothing. */
  'music_episode_build',
  /** Episode Builder: rewrite scene prompts with the writing model the owner picked at the click. */
  'music_scene_polish',
  /** Translate a finished/scripted episode into another language (English ↔ Khmer). */
  'translate_episode',
  /** Still Posts (2026-10-27): write a batch of posts from one brief. Spends writing tokens only. */
  'still_post_write',
  /** Still Posts: draw the missing artwork with reference to image, then burn in text/handle/logo. */
  'still_post_render',
] as const

export type JobType = typeof JOB_TYPES[number]
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'

export type JobControlAction =
  | 'cancel-before-submit'
  | 'stop-local'
  | 'request-remote-cancel'
  | 'pause-submissions'
  | 'return-later'
  | 'clear-history'
  /** v1.2.6 — re-ask GenStudio for the current state of stored non-terminal evidence. */
  | 'recheck-provider-status'
  /**
   * v1.2.8 — the owner override. Stops tracking an unfinished job locally
   * without waiting for, or claiming, provider confirmation. Always offered on
   * an unfinished job, because every other route out of a job can legitimately
   * be closed and a job with no way out at all is not acceptable.
   */
  | 'force-abandon'
  | 'none'

export type JobControlCode =
  | 'READY'
  | 'PROVIDER_WORK_ALREADY_STARTED'
  | 'CANCELLATION_STATUS_UNKNOWN'
  | 'REMOTE_CANCELLATION_NOT_SUPPORTED'
  | 'JOB_NOT_AT_SAFE_LOCAL_STOP'
  /** v1.2.6 — Story Studio asked GenStudio and could not get an answer. */
  | 'PROVIDER_STATUS_UNREACHABLE'
  /** v1.2.8 — available on the owner's say-so, not on provider evidence. */
  | 'OWNER_OVERRIDE'

export type JobRemoteOperation =
  | 'voice.tts'
  | 'audio.transcription'
  | 'image.generation'
  | 'video.generation'
  | 'chat.response'
  | 'music.generation'

export interface JobControl {
  action: JobControlAction
  enabled: boolean
  label: string
  reason: string
  code: JobControlCode
  financial_effect: 'no-provider-request' | 'local-only' | 'remote-result-required' | 'provider-work-may-settle' | 'history-only' | 'none'
  targets?: Array<{ operation: JobRemoteOperation; provider_job_id: string }>
}

export interface JobControlCapabilities {
  remoteCancellationAudited: boolean
}

/** Per-provider-task cancellation evidence, keyed by `${operation}:${provider_job_id}`. */
export interface JobRemoteCancellation {
  /**
   * `absent` (v1.2.8) means GenStudio answered the status lookup and said it
   * has no such task. It is terminal, and it is deliberately distinct from
   * `unknown`, which means Story Studio could not get an answer at all.
   */
  status: 'queued' | 'submitting' | 'requested' | 'reconciling' | 'confirmed' | 'rejected' | 'unknown' | 'absent'
  operation: JobRemoteOperation
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
  /** Redacted local explanation when Story cannot yet read provider status. */
  reconciliation_error?: string
}

/**
 * Snapshot of an account as it was at resolution time. Labels are captured
 * up-front so later renames don't retroactively change what the job card shows.
 */
export interface AccountUsage {
  id: string
  label: string
}

/**
 * What one item of a list-shaped job is doing right now.
 *
 * `waiting_retry` is its own state on purpose. A provider that declined to
 * take the work and will be asked again is the single case where nothing is
 * happening and nothing is wrong, and it is exactly the case a bare spinner
 * misrepresents as a hang.
 */
export interface JobItemAttempt {
  /** Human label for the item — a section name, a scene number. */
  label: string
  /**
   * Stable identifier the UI can match a row against — an audio section slug.
   * Optional because not every list-shaped job has one; a view without it
   * falls back to `label`.
   */
  key?: string
  state: 'running' | 'waiting_retry'
  /** 1-based, so the first line of a card reads "attempt 1 of 4". */
  attempt: number
  max_attempts: number
  /** ISO instant the wait ends. Set only while `waiting_retry`. */
  retry_at?: string
  /** Why it is waiting, phrased for the operator. */
  reason?: string
}

/**
 * Live per-item counts for a job that works through a list.
 *
 * Deliberately additive to `progress` rather than a replacement: a percentage
 * says how far, this says what is actually happening and whether the run is
 * pacing itself on purpose.
 */
export interface JobItemProgress {
  /** Requests this run staged. */
  total: number
  /** Requests that produced their output. */
  completed: number
  /** Requests that gave up after their final attempt. */
  failed: number
  /** Accepted provider work still settling or saving locally. */
  settling?: number
  /** Provider work GenStudio confirms was cancelled by the customer. */
  cancelled?: number
  /** Items in the episode scope that Story has not submitted. */
  not_submitted?: number
  /**
   * How many items this run may have in flight at once. `1` is the visible
   * evidence that the run is feeding a metered provider one at a time, rather
   * than being mysteriously slow.
   */
  concurrency: number
  /** One entry per in-flight item; never longer than `concurrency`. */
  active: JobItemAttempt[]
}

/** Machine setting frozen at eligible image enqueue; never accepted in params. */
export interface PaidImageReplacementPolicySnapshot {
  enabled: boolean
  wait_minutes: 30
  max_replacements_per_asset: 1
  additional_credit_ceiling: number | null
  snapshotted_at: string
}

/** One durable, bounded paid replacement decision for an image asset. */
export interface PaidImageReplacementAttempt {
  asset_key: string
  manifest_dir: string
  manifest_key: string
  output_path: string
  state: 'waiting' | 'committed' | 'submitted' | 'succeeded' | 'failed' | 'blocked'
  original_task_id: string
  original_idempotency_key: string
  input_hash: string
  output_selector: import('../services/task-manifest.js').PaidImageOutputSelector
  reference_inputs: import('../services/task-manifest.js').PaidImageReferenceInput[]
  reference_identity_hash: string
  failure_code: string
  reserved_credits: number
  settled_credits: number
  released_credits: number
  terminal_observed_at: string
  eligible_at: string
  quoted_credits?: number
  price_version?: string
  replacement_scope?: string
  replacement_committed_at?: string
  replacement_task_id?: string
  actual_settled_credits?: number
  reason?: string
  /** Allow-listed renderer explanation; never derived from provider prose. */
  public_reason?: 'original_failure_not_eligible' | 'replacement_disabled' | 'not_verified' | 'budget_limit'
}

export interface GenerationReplacementAttempt {
  kind: 'audio' | 'writing'
  item_key: string
  /** Private SHA-256 binding to the accepting API origin and credential. */
  connection_fingerprint?: string
  original_task_id: string
  original_idempotency_key: string
  idempotency_key: string
  max_credits: number
  state: 'committed' | 'submitted' | 'succeeded' | 'failed'
  task_id?: string
  settled_credits?: number
  revision: number
}

export interface FinalRenderRemoteWaitReceiptV1 {
  version: 1
  phase: 'remote_wait'
  revision: number
  job_id: string
  intent_id: string
  story_attempt: number
  gateway_attempt_key: string
  request_body_sha256: string
  request_body_bytes: number
  packet_sha256: string
  render_fingerprint: string
  submission_scope_sha256: string
  destination_fence_sha256: string
  source_generation_fence_sha256: string
  gateway_job_id: string | null
  committed_at: string
  cancel_requested_at: string | null
}

/** Immutable local snapshot committed before any final-render network send. */
export interface FinalRenderIntentStagedReceiptV2 {
  version: 2
  phase: 'intent_staged'
  revision: 1 | 2
  job_id: string
  intent_id: string
  story_instance_id: string
  story_attempt: 1
  gateway_attempt_key: string
  packet_sha256: string
  staging_manifest_sha256: string
  submission_scope_sha256: string
  destination_fence_sha256: string
  source_generation_fence_sha256: string
  committed_at: string
  cancel_requested_at: string | null
}

export interface FinalRenderTransportReceiptV3 {
  version: 3
  phase: 'request_persisted' | 'send_may_start' | 'send_unknown' | 'lookup_not_found' | 'remote_wait'
    | 'output_ready' | 'importing' | 'imported' | 'acknowledged' | 'recovery_hold' | 'refused'
    | 'remote_failed'
  revision: number
  job_id: string
  intent_id: string
  story_instance_id: string
  story_attempt: 1
  gateway_attempt_key: string
  packet_sha256: string
  staging_manifest_sha256: string
  submission_scope_sha256: string
  destination_fence_sha256: string
  source_generation_fence_sha256: string
  committed_at: string
  cancel_requested_at: string | null
  request_body_sha256: string
  request_body_bytes: number
  gateway_job_id: string | null
  transport_revision_sha256: string
}

export type FinalRenderRemoteWaitReceipt =
  | FinalRenderRemoteWaitReceiptV1
  | FinalRenderIntentStagedReceiptV2
  | FinalRenderTransportReceiptV3

export interface PublicFinalRenderWait {
  state: 'intent_staged' | 'request_persisted' | 'send_may_start' | 'send_unknown' | 'remote_wait'
    | 'output_ready' | 'importing' | 'imported' | 'acknowledged' | 'recovery_hold'
  cancellation_requested: boolean
  gateway_id_known: boolean
  committed_at: string | null
}

export interface Job {
  job_id: string
  project_slug: string
  type: JobType
  episode_id: string
  title: string
  status: JobStatus
  /** Cooperative Story-side pause. Running provider requests already accepted
   * upstream finish and checkpoint their artifact; no new item is submitted. */
  pause_requested?: boolean
  /** Distinguishes a user-paused job from one paused by the global queue hold.
   * Global Resume may restart only `queue` jobs; `manual` jobs stay paused. */
  pause_origin?: 'manual' | 'queue' | 'stall'
  /** The owner pressed Resume while a pause was still taking effect (work
   * already sent was finishing). The job continues on its own the moment its
   * paused checkpoint is saved. Cleared by that transition or a new Pause. */
  resume_after_pause?: boolean
  /** Executor reached a local boundary; remote cancellation settlement may now finalize this job. */
  local_execution_complete?: boolean
  /** Every server-authoritative action currently available; `control` remains the primary compatibility view. */
  controls?: JobControl[]
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  output_lines: string[]
  /** Immutable Content Pack selection captured before queue insertion. */
  content_pack_provenance?: ContentPackProvenance[]
  /** Queue-owned retry state. Only jobs proven to use local/free compute are
   * eligible; cloud/API jobs remain one-shot and require manual Retry. */
  auto_retry?: {
    eligible: boolean
    reason: string
    attempt: number
    max_attempts: number
    next_retry_at?: string
    exhausted?: boolean
  }
  /** Server-owned optional paid image recovery authorisation. */
  paid_image_replacement?: PaidImageReplacementPolicySnapshot
  /** Jobs.json is authoritative for this bounded paid image replacement state. */
  paid_image_replacement_attempts?: PaidImageReplacementAttempt[]
  /** Durable per-item holds for opt-in audio/writing replacements. */
  generation_replacement_attempts?: GenerationReplacementAttempt[]
  /** Private durable fence for a future whole-video fleet submission. */
  final_render_remote_wait?: FinalRenderRemoteWaitReceipt
  /** Renderer-safe projection; derived at serialization and never persisted as authority. */
  final_render_wait?: PublicFinalRenderWait
  /** Structured executor outcome. `complete: false` is a queue-enforced
   * failure declaration and can never be persisted as a green Done job. */
  result?: Record<string, any>
  progress?: number
  /**
   * Live per-item state for jobs that work through a list.
   *
   * `progress` alone answers "how far", which is not the question a long run
   * actually raises. A ten-section audio job that legitimately takes several
   * minutes and a wedged one look identical without this: the operator cannot
   * see which section is in flight, that the run is feeding the provider one
   * at a time deliberately, or that a section is sitting out a rate-limit wait
   * rather than hung. That ambiguity has already had a slow provider call
   * misdiagnosed as a hang. Optional and additive — jobs persisted before it
   * shipped simply omit it.
   */
  item_progress?: JobItemProgress
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
  /** Derived at the server boundary for each snapshot; never trusted from a client. */
  control?: JobControl
  /**
   * Server-issued replacement identity for an explicit Retry of a known
   * terminal GenStudio language job. Kept outside request params so a normal
   * generator POST cannot mint it.
   */
  genstudio_chat_retry_scope?: string
  /**
   * Chat idempotency keys whose SETTLED Gateway answer this app rejected locally (a parse or
   * output-contract failure). The key is derived from request content, so without this the next
   * attempt recomputes the same key, the Gateway replays the same unusable text, and the step
   * fails identically on every attempt until the retry budget runs out — the DM0008 loop, and
   * Nature EP0013's image_prompts job (2026-10-19). A key listed here is never used again: the
   * next attempt derives a fresh one and asks for a new generation. Kept outside request params
   * so no request body can name a key, and carried onto an explicit Retry's new job so a fresh
   * Retry cannot walk back into an answer already refused. Optional and additive — jobs persisted
   * before it shipped simply omit it.
   */
  rejected_idempotency_keys?: string[]
  /** Private exact-key map for the explicit Jobs failed-item replacement. */
  manual_failed_item_replacement?: {
    source_job_id: string
    requests: Array<{
      original_task_id: string
      original_idempotency_key: string
      /** Stable generator key that is replaced; differs after a replacement itself fails. */
      prepared_idempotency_key?: string
      replacement_idempotency_key: string
    }>
  }
  /**
   * Server-issued marker for a Retry that must only reclaim an earlier
   * idempotency key. It never permits a new provider submission.
   */
  genstudio_chat_recovery?: true
  /** Server-extracted pending key; never accepted from a request body. */
  genstudio_chat_recovery_key?: string
  /** The proven workflow call that owns the saved pending key. */
  genstudio_chat_recovery_purpose?: 'outline' | 'narrative-repair' | 'narrative-batch'
  /** Narrative repair slots proven by the stored request preview. */
  genstudio_chat_recovery_chapters?: number[]
  /** Server-retained proof for the one manual same-key POST after a verified absence. */
  genstudio_chat_recovery_preview?: GenStudioRequestPreview
  /** Proven pending keys; normal/listicle calls may recover only by exact membership. */
  genstudio_chat_recovery_keys?: string[]
  queue_position?: number
  /** Durable manual position inside this job's own type lane, assigned when
   * the owner moves a queued job. Jobs without it keep their enqueue order and
   * wait behind the explicitly ordered ones after a restart. */
  queue_rank?: number
  /**
   * Which account served each provider the job called. Keyed by canonical
   * providerId (`openai`, `fal`, …). Populated by the resolver whenever
   * `ResolveContext.jobId` is passed — see registry.ts `resolveApiKeyForProviderId`.
   * Same provider on repeat calls overwrites with the latest resolution.
   */
  accounts_used?: Record<string, AccountUsage>
  /**
   * Durable GenStudio-side job evidence. The remote boundary owns billing;
   * Story records only values returned by GenStudio and never derives rates.
   * Historical jobs simply omit this additive field.
   */
  genstudio_jobs?: Array<{
    /** Story pre-submit receipt identity; retained when the request preview is pruned. */
    request_key?: string
    id: string
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
    /** GenStudio's structured failure classification; never inferred from prose. */
    failure_class?: string | null
    /** GenStudio's published reason, retained for audit without driving policy. */
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
    /**
     * A pending transcription placeholder was checked with its confirmation
     * key and, only after a 404, its legacy direct-submission key. This is
     * Story Studio's durable proof that this particular absence is final.
     */
    transcription_absence_verified_at?: string
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
     * Redacted preview of the request Story Studio submitted for this call.
     * Built by lib/genstudio-request-preview.ts, which guarantees no
     * credential can reach it and bounds prompt text. Optional and additive:
     * only the newest few entries retain it, and historical jobs omit it.
     */
    request?: GenStudioRequestPreview
  }>
  /** Persisted cancellation state belongs to an exact GenStudio target, not a whole Story job. */
  remote_cancellations?: Record<string, JobRemoteCancellation>
  /** Redacted reason the restart-safe provider reconciliation is still waiting. */
  reconciliation_error?: string
  /**
   * v1.2.8 — the owner chose to stop tracking this job without provider
   * confirmation.
   *
   * Deliberately a JOB-level marker and not a rewrite of `genstudio_jobs`.
   * Abandoning teaches Story Studio nothing about the provider, so the
   * provider evidence is left exactly as it stands: output may still land and
   * stays recoverable, and credits already spent are unaffected. What the
   * marker changes is only Story Studio's own bookkeeping — this job stops
   * holding the queue, stops being re-asked about, can be removed from
   * history, and can be run again.
   */
  force_abandoned?: {
    at: string
    /** What was still unsettled at the moment it was abandoned, for the audit trail. */
    unsettled: string[]
  }
  /**
   * v1.2.6 — the result of the last provider re-check run for a FINISHED job
   * whose stored evidence was still non-terminal.
   *
   * `genstudio_jobs` is only a snapshot of what GenStudio reported while the
   * job ran. An entry that was mid-flight when the snapshot was written stayed
   * mid-flight forever, because reconciliation only ever ran for running or
   * paused jobs. That left the dismiss gate asserting "durable provider work
   * is still settling" about work that had settled long before. The gate now
   * re-asks GenStudio, and this records the answer so the control can tell
   * "still checking" from "could not reach GenStudio" from "GenStudio says it
   * genuinely has not finished" instead of merging all three into one claim
   * Story Studio had not earned.
   */
  history_evidence_check?: {
    state: 'checking' | 'unreachable' | 'unsettled'
    /** ISO8601 of when this check started (`checking`) or returned. */
    at: string
    /** Redacted reason. Present for `unreachable`. */
    detail?: string
  }
  /**
   * 2026-10-16 — accepted music tasks the Gateway finished whose songs never reached the library
   * (no complete recovery receipt, no pool row with the task id). While non-empty the history is
   * kept: removing it would 404 the item's "Recover existing result". Computed from disk by
   * `musicResultsAwaitingImport` after a provider re-check and after each recovery.
   */
  music_results_awaiting_import?: string[]
  /**
   * A failed job whose work was finished later (a later run or a repair saved
   * every file it was meant to make). The row stays as history but no longer
   * needs attention. Set only by `services/stale-failures.ts`; cleared when the
   * row runs again.
   */
  resolved?: { at: string; reason: string }
  /**
   * This step did not run because the channel's own settings switch it off
   * (`lib/optional-steps.ts`). AGENTS.md §8: "Optional steps are skipped only
   * through explicit project configuration. A skipped optional step is not
   * missing." A skipped job is `done` — nothing failed, nothing was thrown away —
   * and the marker is what makes it read `skipped` instead of `done` in the Jobs
   * list. Required work is never marked this way, and a step that is merely
   * missing output is never skipped.
   */
  skipped?: { at: string; reason: string }
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
  paused: number
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
  /** Creative constraint level. Defaults to guided for new callers while
   * strict preserves the legacy highly-directed prompt. */
  creative_mode?: 'strict' | 'guided' | 'open'
  /** User-authored creative brief. In open mode this is the primary artistic
   * direction; technical output/schema requirements still apply. */
  creative_direction?: string
  /** Optional creative lenses selected in the Ideas workspace. They are
   * inspiration prompts, never hard constraints or replacements for the
   * user's freeform brief. */
  creative_lenses?: string[]
  /**
   * Compare generated concepts against the complete saved Ideas history and
   * the current batch. Defaults to true. False is an explicit opt-out for a
   * creator who intentionally wants a sequel, remake, or recurring topic.
   */
  avoid_repeated_ideas?: boolean
  /**
   * v1.0.165+ — optional title template. When set (e.g. "Fall asleep to
   * {X}"), the idea-generator prompt instructs the LLM to shape EVERY
   * generated title to it, replacing the literal {X} with a concrete
   * subject the LLM picks fresh per idea. Empty / unset = freeform
   * LLM titling. Replaced the Pattern preset system.
   */
  title_template?: string
  /**
   * Pin the per-idea chapter / item count (v1.0.70+).
   *
   * Most useful for listicle / explainer formats where the title
   * encodes the count ("10 sleep mysteries explained", "7 plane
   * crashes that changed aviation"). When set:
   *   - suggested_chapters on every generated idea will equal this value
   *   - the title's leading number (when one is natural) MUST equal
   *     this value
   *   - downstream Script generation prefills its chapter field from
   *     the same number so the on-screen output matches the title
   *
   * Unset (legacy) = LLM picks per-idea within format range.
   */
  items_per_listicle?: number
}

export interface StoryIdea {
  title: string
  logline: string
  themes: string[]
  suggested_chapters: number
  suggested_length: string
  mood: string
  /** Stable conceptual identity reserved before generation. */
  idea_fingerprint?: string
  /** Series Formula and Topic Packs that produced this concept. */
  series_formula_id?: string
  topic_pack_ids?: string[]
  /** Reserved coverage dimensions used to make the idea distinct. */
  idea_dimensions?: Record<string, string>
  /** Durable queued campaign identity; Retry fills only this campaign's gaps. */
  campaign_id?: string
}

export interface GenerateScriptRequest {
  episode_id: string
  title: string
  length: number
  model: string
  style: string
  creative_mode?: 'strict' | 'guided' | 'open'
  creative_direction?: string
  chapters: number
  total_words?: number
  words_per_chapter?: number
  /**
   * Character primitive (Phase 5): when set, the script generator passes
   * the named cast into the prompt — the LLM uses these names + descriptions
   * instead of inventing characters. Empty array = today's "LLM invents
   * the cast" behavior (back-compat). Image-prompt generation also folds
   * each character's description into the per-scene prompts.
   */
  character_ids?: string[]
  /** v1.0.196 — narrative point of view override. As of v1.0.327 expanded
   *  to 8 specific variants ('first', 'first-subject', 'first-plural',
   *  'second', 'second-immersive', 'third', 'third-omniscient',
   *  'third-documentary'). Special values:
   *    - 'auto' / absent → use the format's defaultPerspective
   *    - 'none' (v1.0.328) → inject NO POV directive at all; let the LLM
   *       decide based on the format/niche prose
   */
  perspective?: string
  /** v1.0.328 — optional free-text POV directive the user can write when the
   *  presets don't quite fit ("write from the koala's perspective but slip
   *  into observing the human researcher in chapter 3"). Appended verbatim to
   *  the format's additional rules; combines with `perspective` if both are
   *  set (preset gives shape, custom adds nuance). Empty / undefined = no
   *  extra note added. */
  custom_perspective?: string
}

export interface GenerateImagesRequest {
  episode_id: string
  model: string
  mode: string // 'scenes' | 'thumbs'
  aspect_ratio: string
  /**
   * Resolution LABEL of the published `output_options[]` row the customer
   * chose, alongside `aspect_ratio`. The pair is one published combination —
   * it is validated against the model's rows, never recombined locally.
   */
  resolution?: string
  /** Selected variable-price/provider tier (for example `1k` or `2k`). */
  tier?: string
  scene_number?: number
  thumb_number?: number
  force: boolean
  /**
   * Explicit render dimensions for LOCAL Image Studio models. When both are
   * set the provider renders at exactly these pixels (rounded to /16) instead
   * of deriving size from `aspect_ratio` — the Scene/Thumbnail Generator's
   * Size control sends a downscaled width/height to cut local GPU/VAE memory
   * and render time. Cloud providers ignore these (they use the aspect string)
   * and the UI omits them for cloud models.
   */
  width?: number
  height?: number
  /** Optional deterministic image seed. */
  seed?: number
  /**
   * v1.0.416+ — optional extra guidance appended to the THUMBNAIL prompt at
   * render time (Thumbnail Generator tab). Lets the user nudge a render
   * ("bigger title", "push subject closer") without editing/reprompting the
   * stored prompt. Ignored for scenes.
   */
  extra_details?: string
  /** Optional explicit recipe/template for one render. Project default is the fallback. */
  thumbnail_template_id?: string
  /** Thumbnail img2img adaptation strength. Strong preserves more layout,
   *  loose uses the source as broad inspiration. */
  reference_strength?: 'loose' | 'balanced' | 'strong'
  image_mode?: 'text2img' | 'img2img'
  reference_sources?: {
    master?: boolean
    per_scene?: boolean
    characters?: boolean
    chain?: boolean
    thumbnail?: boolean
  }
}

export interface GenerateAudioRequest {
  episode_id: string
  model: string
  voice?: string
  sections: string
  speed: number
  /**
   * Values for the selected model's published `controls[]`, keyed by the name
   * GenStudio published. Never enumerated here — the catalogue owns the names,
   * the types and the ranges (lib/tts-controls.ts).
   */
  controls?: Record<string, number | boolean | string>
  /**
   * How the words should be read — the model's own free-text delivery/emotion
   * instruction (owner, 2026-10-29). Not a Story Studio vocabulary: whether the
   * selected model takes one, what it may contain, and how long it may be are
   * published by the Gateway per model (lib/tts-controls.ts). The generator
   * resolves it against the live row before anything is sent, and refuses a
   * non-empty instruction on a model that publishes none rather than dropping
   * it silently.
   */
  delivery_instruction?: string
  force: boolean
  no_overwrite: boolean
  /** Server-stamped, action-scoped staged candidate; public Audio requests never carry it. */
  quality_repair?: {
    action_id: string
    source_fingerprint: string
    verification_credit_ceiling: number
  }
  /** Re-narrate: once the narration is saved, re-make these chapters' subtitles (generators/audio.ts). */
  then_subtitles?: boolean
  /**
   * Server-only (automatic subtitle redo, 1.4.264): per chapter, the script sentences its
   * subtitles show were skipped. Only the part(s) holding them are narrated again.
   */
  redo_sentences?: Record<string, string[]>
  /** Server-only (Repair): activate and join chapters whose parts are all on disk; never submits TTS. */
  join_only?: boolean
  /** Join pauses inside a chapter, seconds (Audio Generator; default from the Series Formula). */
  paragraph_pause_sec?: number
  sentence_pause_sec?: number
  /** Server-only raw alternate-ASR check over selected active audio. */
  quality_check?: {
    action_id: string
    source_fingerprint: string
    verification_credit_ceiling: number
  }
}

export interface VideoScene {
  image_path: string
  /** Exact Scene Plan window hydrated by unified assembly preflight. */
  duration?: number
  title?: string
  show_title: boolean
  /** Echoed-through scene number (1-based) for diagnostics. */
  scene_number?: number
  /** Optional section hint retained for title/diagnostic metadata. */
  chapter_slug?: string
  /** Stable scene_plan.json id for this exact still or approved motion clip. */
  plan_scene_id?: string
  /** Internal proof that duration was hydrated from the authoritative plan. */
  __scene_plan_duration?: boolean
  /** Internal, per-request: chapter → act index, filled while the reveal plan is resolved so a
   *  scene's act is its chapter's first-appearance order rather than a second pass over the list. */
  __revealChapterOrder?: Map<string, number>
  /** The scene plan's own start on the stitched-audio timeline, when the caller supplies it. Read
   *  by the reveal planner so a hold can snap to the narration line or beat at its own clock. */
  start_sec?: number
  /** Follow narration clips hold their final frame during assembly, including
   * transition tails after a nominally long clip. */
  clip_shortfall_mode?: 'hold'
}

export interface VideoTitleCard {
  enabled?: boolean
  text: string
  subtitle?: string
  duration: number
  style: 'gold' | 'white' | 'neon' | 'minimal'
  background: string  // color hex or 'blur'
  /** Optional still or looping video rendered behind the card text. */
  background_media_path?: string
}

export interface VideoOutroCard {
  enabled?: boolean
  text: string
  duration: number
  style: 'gold' | 'white' | 'neon' | 'minimal'
  /** Optional still or looping video rendered behind the card text. */
  background_media_path?: string
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
  /** Author's channel id. The only reliable way to tell whether a reply came
   *  from THIS channel — display names are not unique and can be changed. */
  author_channel_id?: string
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
  /** YouTube's own moderation status for the top comment, when it tells us.
   *  Only the channel owner sees this. Absent is NOT "published" — it means
   *  YouTube did not say, and `is_public` is the weaker fallback. */
  moderation_status?: 'published' | 'heldForReview' | 'likelySpam' | 'rejected'
}

export interface CommentThreadsResult {
  /** ISO-8601 timestamp the snapshot was fetched. */
  fetched_at: string
  video_id: string
  threads: CommentThread[]
  /** True when there are more threads beyond `threads.length`. v1 caps at
   *  one page (100 threads) so this surfaces "open in YouTube for the rest". */
  has_more: boolean
  /** True when YouTube refused because commenting is off for this video.
   *  Distinct from an empty list: "nobody commented" and "nobody CAN comment"
   *  are different facts, and only the second explains why replying fails. */
  comments_disabled?: boolean
  /**
   * Where the next sweep resumes. Additive and optional: absent means there is
   * nothing further to read, which is not the same as a token we failed to
   * record.
   */
  next_page_token?: string
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
  /** 1.4.264: cut the logo to rounded corners or a circle (made once per render). Absent = 'none'. */
  shape?: 'none' | 'rounded' | 'circle'
  /** Rounded corners: radius as a % of the logo's shorter side (1–50, default 20). */
  corner_radius_pct?: number
}

export interface VideoIntroConfig {
  enabled: boolean
  video_path: string
  /** Exact reserved opening length from Scene Plan. The clip is trimmed/padded. */
  duration?: number
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
  /**
   * v1.0.415+ — when true, B-roll *video* scenes play for their own full
   * natural length (probed with ffprobe) instead of being trimmed/looped to
   * `seconds_per_scene`. Still images are unaffected (they have no natural
   * length and keep using the per-scene duration). Default false/undefined to
   * preserve the uniform "seconds per scene" behaviour for existing presets.
   */
  broll_natural_duration?: boolean
}

export interface VideoMusicConfig {
  enabled: boolean
  /** Audio Assembly presets: 'pool' = the project's Music Pool picks one track per episode. */
  source?: 'pool' | 'manual'
  files: string[]              // multiple .mp3 paths
  /**
   * LINEAR GAIN — the bed's level under the voice. 1 = as loud as the
   * narration, 0.08 = 8% of it. NOT a percentage: `Audio Assembly presets`,
   * the form and the Music Pool panel all store percent (0–100), and that
   * value is converted exactly once, where the preset is merged into this
   * request (`lib/audio-gain.ts`). Never convert at the generator boundary.
   */
  volume: number               // linear gain (0–1 typical)
  /** LINEAR GAIN after the narration ends — same unit and same boundary as `volume`. */
  post_narration_volume: number // linear gain
  fade_in: number
  fade_out: number
  /**
   * v1.0.397 — optional music "intro lead-in". When `lead_in_enabled`, the
   * SAME background track plays at full volume for the first `lead_in_seconds`,
   * then ducks (over a short fade) to `volume` exactly as the narration begins —
   * the narration is delayed by that many seconds. Lets a single uploaded track
   * double as the intro sting, with no separate intro file or manual trimming.
   */
  lead_in_enabled?: boolean
  lead_in_seconds?: number     // seconds of full-volume music before narration
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
  /** LINEAR GAIN (1 = unchanged) — a preset's percent is converted when it is merged. */
  volume: number          // linear gain, default 0.15
  fade_in: number
  fade_out: number
}

/**
 * Compilation video layout (v1.0.63+ / Path C, compilation-mode channel mode).
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
  /** LINEAR GAIN (1 = unchanged) — a preset's percent is converted when it is merged. */
  volume: number          // linear gain
  fade_in: number         // seconds
  fade_out: number        // seconds
  /** When true (default), short clips repeat to fill the timeline. */
  loop?: boolean
}

export interface VideoFilmGrain {
  enabled: boolean
  strength: number        // 0-100, default 15
}

/** Self-contained archival-film treatment; deliberately separate from grade, vignette, and grain. */
export interface VideoAgedArchiveFilm {
  enabled: boolean
  strength: number        // 1-100, default 45
}

export interface VideoLetterbox {
  enabled: boolean
  ratio: '2.35:1' | '2.00:1' | '1.85:1'  // cinematic aspect ratios
  color: string           // bar color, default 'black'
  /** 1.4.282 — `fit` (default) keeps the whole picture; `cover` draws the bars over it. */
  mode?: 'fit' | 'cover'
}

export interface VideoFrameConfig {
  enabled: boolean
  /** Empty space between the output edge and frame, percent of short side. */
  inset_pct: number
  /** Border thickness in pixels at 1080p; scales with output resolution. */
  border_width: number
  /** Media corner radius in pixels at 1080p; scales with output resolution. */
  corner_radius: number
  border_color: string
  background_color: string
  /** Optional still or looping video used instead of the solid board color. */
  background_path?: string
  fit?: 'cover' | 'contain'
}

// Subtitles — burned into the final video via FFmpeg's `subtitles=` filter
// (libass). Three sources feed a single on-disk SRT:
//   - 'chapters'  : derived from chapter audio file durations + their labels
//   - 'upload'    : user picked an external .srt / .vtt via FilePicker
//   - 'whisper'   : transcribed from merged audio through GenStudio KH
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
  /** Precise caption anchor as percentages of the video canvas. When both are
   * present, they override the coarse position/alignment anchors. */
  position_x_pct?: number
  position_y_pct?: number
  /** Protected edge area for precise placement, clamped to 5-20%. */
  safe_margin_pct?: number
  max_chars_per_line: number            // wrap target, default 42
  max_lines: number                     // libass `WrapStyle` + `MaxLines`
  /** v1.0.353 — entrance animation per caption line. 'none' = static (the
   *  `force_style` path); the rest render a full ASS file (`ass=` filter). */
  animation?: 'none' | 'fade' | 'pop' | 'slide-up'
}

export interface VideoSubtitleConfig {
  enabled: boolean
  source: VideoSubtitleSource
  /** Absolute path to the SRT that should be burned in. Written by the
   *  backend when source = 'chapters' | 'whisper'; set to the user-picked
   *  file when source = 'upload'. */
  srt_path?: string
  style: VideoSubtitleStyle
  /** v1.0.423 — drop caption cues before the story starts (sleep-story intro:
   *  welcome / CTA / breathing) so the burned-in track has no intro captions.
   *  The full SRT sidecar (for YouTube upload) is untouched — only the burn is
   *  trimmed. Requires the episode to have an "Introduction" chapter. */
  hide_during_intro?: boolean
}

/**
 * A scene animation id.
 *
 * Until v1.2.0 this was a five-name union that had been wrong for a long time:
 * the catalogue offered twenty-four animations and the renderer implemented all
 * twenty-four, so any project using one of the other nineteen — every plain
 * pan, every diagonal, `pulse`, `blur-focus`, both rotations — held a value
 * this type said was impossible. It compiled only because the value reached the
 * renderer as a `string`.
 *
 * It is now a string, and the REGISTRY is the authority on which ids exist:
 * `findSceneMotion()` resolves one, and an id it does not know renders static
 * rather than failing. A closed union here would have to be regenerated every
 * time the library grows, which is the coupling this release exists to remove.
 */
export type SceneAnimationType = string
export type ParallaxDirection = 'left' | 'right' | 'up' | 'down'

/** One overlay applied to a render, chosen from the built-in effect library. */
export interface AppliedSceneOverlay {
  /** Registry id, e.g. `vignette-soft`. Unknown ids are skipped, never fatal. */
  id: string
  enabled: boolean
  /**
   * Field-level overrides on top of the built-in's document. Validated
   * strictly at the API boundary, clamped leniently when read back off disk.
   */
  params?: Record<string, unknown>
  /**
   * 1.4.282 — set when this entry was a classic Video Assembly checkbox
   * (Vignette, Film Grain, Letterbox). It renders exactly where the checkbox
   * did — see `contracts/effects-look.ts`.
   */
  legacy_slot?: 'vignette' | 'film_grain' | 'letterbox'
}

export interface SceneEffectsConfig {
  enabled: boolean
  overlays: AppliedSceneOverlay[]
}

export interface VideoSceneAnimation {
  type: SceneAnimationType
  zoom_start: number          // %, default 100
  zoom_end: number            // %, default 108
  parallax_direction: ParallaxDirection  // default 'right'
  parallax_speed: number      // 1-5, default 2
  breathe_amplitude: number   // %, default 2
  breathe_base_zoom: number   // %, default 103
}

// 'hard-cut' (v1.0.354): the video ends the instant the narration does — no
// tail. 'continue-cycling' is retained only so pre-v1.0.354 presets keep
// loading; with Target Duration removed it now behaves identically to 'hard-cut'.
export type PostAudioBehavior = 'black-screen' | 'fade-to-black' | 'hold-last-scene' | 'continue-cycling' | 'hard-cut'

export interface VideoPostAudio {
  behavior: PostAudioBehavior   // default 'fade-to-black'
  fade_duration: number         // seconds, default 5, only used for 'fade-to-black'
  /** v1.0.354 — length (seconds) of the tail for 'black-screen' (black) and
   *  'hold-last-scene' (frozen final frame). Replaces the old Target-Duration
   *  padding that used to size this section. Default 4. Ignored otherwise. */
  tail_seconds?: number
  /**
   * How the background music behaves over the tail. The tail's LENGTH is
   * `tail_seconds` / `fade_duration` above — there is no second length here.
   *
   * These are a reusable look, so they ride in the Video Assembly preset beside
   * the behavior they belong to (AGENTS.md §5). Audio Assembly reads this block
   * from the same preset the renderer reads it from, so there is one mix and one
   * place the owner sets the close.
   */
  closing_music?: VideoClosingMusic
}

/**
 * The closing tail's music controls — what the bed does AFTER the narration
 * ends. Every one is optional, and absent means the tuned default, so a preset
 * saved before this existed closes exactly as it should with nothing touched.
 *
 * The levels reuse Audio Assembly's own vocabulary rather than a parallel set:
 * `VideoMusicConfig.volume` is the bed under the voice (the ducked level) and
 * `post_narration_volume` is the level it returns to once the voice stops — the
 * "normal BGM level" the duck release rises back to.
 */
export interface VideoClosingMusic {
  /**
   * Level for the tail, as a PERCENTAGE of the bed's normal post-narration
   * level: 100 = exactly the level Audio Assembly already set for after the
   * narration, 50 = half of it, 0 = silent. Default 100.
   */
  volume?: number
  /**
   * Seconds the bed takes to rise from its under-narration level back up to
   * that level once the last word lands. 0 = the historical instant step.
   * Default 1.5.
   */
  duck_release_sec?: number
  /**
   * Seconds of fade-out over the END OF THE TAIL, on a smooth curve (never a
   * cut). Falls back to the Audio Assembly music's own `fade_out`, then 5.
   */
  fade_out_sec?: number
}


export interface GenerateVideoRequest {
  episode_id: string
  /** Replaced from the approved Scene Plan immediately before rendering. */
  scenes: VideoScene[]
  /** Replaced from merged episode audio immediately before rendering. */
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
  /** Unified assembly hydrates this from the episode's persisted source. */
  scene_pool_mode?: 'scene_plan' | 'image_pool'
  music?: VideoMusicConfig
  /** @deprecated v1.0.354 — Target Duration removed. The video body always
   *  equals the narration; an optional post-audio tail is the only extension.
   *  Kept optional so old presets that still carry it load without error; the
   *  assembler ignores it entirely. */
  duration?: VideoDurationConfig
  transition: string
  transition_duration: number
  /** Names the frame's SHORT edge — 1080p is 1080 tall in landscape and 1080
   *  wide in portrait. The long edge comes from `aspect_ratio`. */
  resolution: '720p' | '1080p' | '1440p' | '4k'
  /**
   * The shape of the frame, as a `W:H` string — `'16:9'`, `'9:16'`, `'1:1'`
   * (v1.4.15). Deliberately NOT a closed union: the assembler parses the ratio
   * rather than matching it against a list, so a shape nobody has asked for yet
   * needs no code. The picker offers the common ones and seeds itself from the
   * project format's `imagePrompts.recommendedAspect`.
   *
   * Absent (every preset saved before this release) means 16:9, which is the
   * only shape Story Studio could produce until now.
   */
  aspect_ratio?: string
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
  /** Optional video bitrate cap in kbit/s (0/absent = quality-based, the long-standing behaviour).
   *  Hardware encodes target it; software encodes keep their CRF and cap peaks at it. */
  video_bitrate_kbps?: number
  /** Final loudness (1.4.270): integrated LUFS target and true-peak ceiling (dBTP). Absent = -14 / -1. */
  loudness_lufs?: number
  true_peak_db?: number
  /** 1.4.274: how far the finished video may miss that level and still pass, in % (absent = 10%). Never changes the levelling. */
  loudness_tolerance_pct?: number
  /** Light sharpening of stills smaller than the canvas while they are upscaled (e.g. 720p scenes in a
   *  1080p render). Absent/'off' = unchanged. Once per still, never per frame. */
  upscale_sharpen?: 'off' | 'light'
  format: 'mp4' | 'mov' | 'webm'
  title_card?: VideoTitleCard
  outro_card?: VideoOutroCard
  chapter_titles: VideoChapterTitles
  scene_animation?: VideoSceneAnimation
  /**
   * Reveal effects for this episode, decided in 1.4.229 and wired here in 1.4.232.
   *
   * Absent or `enabled: false` is the shipped behaviour: every scene is a still with the camera
   * move above. When it is on, each scene's arrival comes from the reveal engine and the scene's
   * duration comes from the pace plan rather than the uniform recycling default — which is what
   * lets one image carry 10–15 s and an episode need roughly 2.4× fewer of them.
   *
   * Typed as the engine's own settings object (`lib/reveal-selection.ts`) so the request and the
   * planner cannot drift: a field the planner reads but the request cannot carry would be a
   * control that does nothing.
   */
  scene_reveal?: import('../lib/reveal-selection.js').SceneRevealSettings
  post_audio?: VideoPostAudio       // what happens after narration ends, default fade-to-black
  audio_gap?: number                // seconds of silence between narration chapters, default 5
  narration_chapters?: string[]     // individual chapter audio file paths (for gap insertion)
  merged_audio_path?: string        // path to pre-merged audio from audio-merge step (skips chapter concat)
  /** LINEAR GAIN (1 = the recorded level), never a percentage — a preset's percent is converted before this request is built. */
  narration_volume?: number         // linear gain, default 1.0
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
  /** Per-chapter audio durations in playback order. Frontend reads
   *  these from `${episode}/audio_chapters.json` (written by the
   *  Audio Merge step) and forwards on the request so the backend
   *  doesn't need to re-probe. */
  chapter_durations?: Array<{ slug: string; duration_s: number }>
  film_grain?: VideoFilmGrain
  aged_archive_film?: VideoAgedArchiveFilm
  letterbox?: VideoLetterbox
  frame?: VideoFrameConfig
  subtitles?: VideoSubtitleConfig
  /** Hydrated exclusively from approved contextual_cues.json at preflight. */
  contextual_cues?: ContextualCue[]
  /** Hydrated exclusively from approved sound_design.json at preflight. */
  sound_design?: { cues: SoundDesignCue[]; ducking_profile: SoundDesignSettings['ducking_profile'] }
  /**
   * v1.2.0 — overlays chosen from the declarative effect library.
   *
   * Purely additive: an absent or empty list renders exactly as before, so
   * every preset and every saved config written before this release is
   * unaffected. Each entry names a built-in and may patch its fields; the
   * document itself is never persisted, so a later change to a built-in
   * reaches projects that selected it.
   */
  scene_effects?: SceneEffectsConfig
  exclude_intro_from_effects?: boolean  // default true — don't apply grading/vignette to intro
  /** @deprecated Whole-Introduction skipping is retired. New plans persist an
   * exact opening_reserved_sec in scene_plan.json. */
  skip_intro_scenes?: boolean
  /** v1.0.468 — per-project image-to-video defaults. `default_motion_level`
   *  (1–4, see MOTION_SPECS) sets this channel's baseline motion intensity for
   *  generated motion prompts — e.g. 2 (Gentle) for sleep stories, higher for
   *  more dynamic channels. `motion_prompts_enabled` (default true) toggles
   *  whether the scene planner generates a motion_prompt per scene at all. */
  default_motion_level?: number
  motion_prompts_enabled?: boolean
  /**
   * v1.0.509 — fast "prompt model" for SHORT prompt-generation tasks (per-scene
   * motion prompts, thumbnail prompts). These are simple, short outputs that
   * don't need the strong planning/script model, so pointing them at a fast /
   * cheap model (Haiku, a mini, or a fast local) speeds up the phases with the
   * most calls. Empty/unset → each task falls back to its own model (the scene
   * plan model for motion; the Thumbnail Prompts page's picker for thumbnails).
   */
  prompt_model?: string
}

// ── Audio Merge ─────────────────────────────────────────────────────────────

export interface AudioMergeIntro {
  enabled: boolean
  file: string                 // absolute path to intro audio
  /**
   * LINEAR GAIN, not a percentage: 1 = unchanged, 0.5 = half. A preset/form
   * stores percent (0–100) and `routes/pipeline.ts` converts exactly once when
   * it merges that preset into this request (`lib/audio-gain.ts`). Never divide
   * at the generator boundary and never infer the unit from the value.
   */
  volume: number               // linear gain, default 1.0
  gap_after: number            // seconds of silence between intro and first chapter, default 2
}

export interface AudioMergeRequest {
  episode_id: string
  chapters: string[]           // ordered audio file paths
  gap_duration: number         // seconds of silence between chapters, default 5
  /**
   * v1.0.317 — seconds of silence to insert BETWEEN PARTS of the SAME chapter
   * (the _part1/_part2/... files a long chapter gets split into). 0 = back-to-
   * back concat (current/legacy behaviour). 0.3-1.0s reads as a natural breath
   * — cloud TTS chunks end and start mid-sentence-flow with no audio padding,
   * so back-to-back concat sounds rushed. The chapter-level `gap_duration`
   * still controls transitions between DIFFERENT chapters.
   */
  chunk_silence_sec?: number
  normalize_volume: boolean    // apply loudnorm filter to equalize chapter volumes
  intro?: AudioMergeIntro      // optional audio intro prepended to narration
  music?: VideoMusicConfig     // optional background music
  background_noise?: VideoBackgroundNoise  // optional ambient noise
  /** Multi-track ambient layering (v1.0.55+). Each entry plays in
   *  parallel — drop in rain + fire + distant thunder simultaneously.
   *  Mixed alongside narration/music/background_noise via FFmpeg amix. */
  ambient_tracks?: AmbientTrack[]
  /** LINEAR GAIN, not a percentage (1 = the recorded level). A preset's percent is converted before this request is built. */
  narration_volume?: number    // linear gain, default 1.0
  write_mode?: 'overwrite' | 'new'  // how to handle an existing merged output; default 'overwrite'
  /** Server-only: bake at most this long a closing tail, whatever the saved Video Assembly preset asks for (a re-mix for one render). */
  closing_tail_sec_cap?: number
  /**
   * Server-only: the `post_audio` block of the render this merge is for (a Pipeline run's Video Assembly preset, or the
   * render a re-mix serves). Outranks anything saved, so the tail baked is the tail that render draws.
   */
  closing_post_audio?: VideoPostAudio
  /** The Music Pool track this merge uses (the page's pick, or the merge's own for a Pipeline run); recorded after a good merge. */
  music_pool_track?: string
  /**
   * Server-only follow-up after a verified audio-quality candidate is selected.
   * Browser requests are stripped at the route boundary.  The merge keeps its
   * original mix settings, then refreshes only the proven candidate chapters'
   * raw subtitle evidence and stitched timeline.
   */
  audio_quality_refresh?: {
    action_id: string
    source_fingerprint: string
    sections: string[]
    /** Server-stamped post-promotion map; never accepted from the browser. */
    promoted_files?: Record<string, string[]>
  }
}

// ── AI Models ───────────────────────────────────────────────────────────────

// ── Research types (v1.0.142+ — timestamp-driven pipeline) ──────────────
//
// Output of the research-and-fact-check phase that runs BEFORE script
// generation on episodes using the `explainer-fact-checked` format
// (visualSource: 'timestamp-driven'). Persisted to two sidecars in the
// episode dir:
//   - `research.json` — machine-readable, source of truth
//   - `research.md`   — human-readable, for the user to read alongside
//
// The script generator in v1.0.143+ reads `research.json` when present
// and injects its `claims` (filtered to `status === 'verified'`) into
// the prompt context, so only the claims the user kept reach the script.
//
// NOTE on provenance: Research has TWO modes and they make different promises.
//
//   • 'model-knowledge' (default, provider `llm-only`) — an ordinary GenStudio
//     language product with no web access. Claims are model-generated
//     statements the user triages, NOT statements the app checked against a
//     live source, and most runs return no citations at all.
//   • 'web-search' (provider `genstudio-web`) — a GenStudio language product
//     that searched the web and returned provider citations in the RESPONSE
//     ENVELOPE. Sources are provider evidence for the run as a whole; claim-to-
//     citation mapping is not available yet.
//
// No UI, message, or sidecar text may overstate either one: model-knowledge
// output was never checked for the user, and web-mode sources back the RUN,
// not any individual claim.

export type ResearchSourceProvider = 'llm-only' | 'genstudio-web'

/**
 * Which research route produced (or should produce) an output.
 *
 *   'model-knowledge' — the model's own training knowledge, no web access.
 *   'web-search'      — a web-search-capable GenStudio language product.
 *
 * ABSENT means 'model-knowledge': every sidecar written before this field
 * existed came from the no-web-access route, so the missing value has exactly
 * one honest reading. Never default an unknown value to 'web-search'.
 */
export type ResearchMode = 'model-knowledge' | 'web-search'

/** How strongly GenStudio could tie a web-research response to retrieved pages. */
export type ResearchEvidenceLevel =
  | 'attributed_claim_citations'
  | 'claim_citations'
  | 'source_urls_only'

/**
 * Domain allow/block lists forwarded to GenStudio's `web_search` block.
 * Only meaningful when the selected product advertises
 * `supports_domain_filters`; ignored (and hidden in the UI) otherwise.
 */
export interface ResearchWebSearchSettings {
  allowed_domains?: string[]
  blocked_domains?: string[]
}

/**
 * What a web-mode run ACTUALLY cost and did, as reported by GenStudio.
 *
 * Every field is optional because GenStudio does not always report them, and
 * Story Studio must never compute a customer charge locally: an absent value
 * is surfaced as "not reported", never as zero and never as an estimate.
 */
export interface ResearchWebRunReport {
  /** Pages the provider reported retrieving. These are run-level evidence,
   * not citations: they prove a page was opened but attribute no claim. */
  source_urls?: string[]
  /** GenStudio's published strength of the returned research evidence. */
  research_evidence_level?: ResearchEvidenceLevel
  /** Envelope `web_searches_executed` — searches the provider actually ran. */
  web_searches_executed?: number
  /**
   * Envelope `web_search_credit_cost`.
   *
   * This is the WEB-SEARCH ADD-ON cost, NOT the run's total charge. The
   * earlier `credits_charged` name (a guess) implied otherwise, which is why
   * it was retired. Surfaces must label it as the search cost.
   */
  web_search_credit_cost?: number
  /**
   * Envelope `research_ran_at` — when GenStudio finished the research run.
   *
   * Preferred over the sidecar's locally stamped `generated_at` for the
   * displayed "Research ran on", because it is GenStudio's own record of the
   * run rather than the moment this app wrote a file.
   */
  research_ran_at?: string
  /**
   * Envelope `citation_claims` — explicit claim-to-source linkage.
   *
   * In GenStudio's published contract but not populated by any provider yet,
   * so it is parsed and persisted without driving any per-claim display. The
   * Research page keeps citing the RUN. When a provider starts filling this,
   * the data is already here.
   */
  citation_claims?: Array<{ claim_id: string; citation_ids: string[] }>
  /** The per-search rate the catalogue published at run time. Recorded for
   *  the record; it is a RATE, never multiplied into a total by this app. */
  credits_per_search?: number
  /** The flat per-request web-research rate the catalogue published at run
   *  time, charged on top of the per-search figure. Also a RATE, also never
   *  multiplied into a total by this app. */
  credits_per_request?: number
  /** The domain filters that were actually sent with the request. */
  allowed_domains?: string[]
  blocked_domains?: string[]
  // ── Retired guesses, read-only ────────────────────────────────────────
  // v1.0.764 shipped these two invented names before GenStudio published the
  // contract. Sidecars written by that release still carry them, so they are
  // still READ (see readResearchWebRun) and never written again.
  /** @deprecated Read-only back-compat for v1.0.764 sidecars. */
  searches_performed?: number
  /** @deprecated Read-only back-compat for v1.0.764 sidecars. */
  credits_charged?: number
}

/** One factual claim the research adapter returned, with status flags
 *  the user can toggle in the Research page UI. */
export interface ResearchClaim {
  /** Stable id for UI editing. Generated client-side as `claim_<rand>`. */
  id: string
  /** The claim itself, written as a short declarative sentence. */
  text: string
  /** User-controlled triage state. Defaults to 'unreviewed' on adapter
   *  output; the script generator only uses claims marked 'verified'.
   *
   *  v1.0.761 — this IS the research-level state too: research counts as
   *  reviewed once no claim is 'unreviewed', and as complete once at least
   *  one is 'verified'. See lib/research-verification.ts. */
  status: 'unreviewed' | 'verified' | 'ignored'
  /** Source citation indices (offsets into ResearchOutput.citations).
   *  Usually EMPTY: the llm-only adapter is instructed not to fabricate URLs,
   *  so most claims arrive with no citation at all. Surfaces are expected to
   *  show that absence rather than imply a source exists. */
  citation_indices: number[]
  /** Adapter-supplied confidence ("high" | "medium" | "low" | "unknown")
   *  that the user can use to triage which claims need the closest review. */
  confidence?: 'high' | 'medium' | 'low' | 'unknown'
  /** Adapter-supplied note explaining the claim's nuance / caveat —
   *  most useful for LLM-only-with-disclaimers output. */
  note?: string
}

export interface ResearchCitation {
  /** GenStudio's own id for this source within the run (`citation-1`, ...).
   *  This is what `ResearchWebRunReport.citation_claims` points at, so it is
   *  what makes a per-claim link resolvable. Absent for model-knowledge runs
   *  and for research stored before per-claim attribution existed, where
   *  there is nothing to resolve. */
  source_id?: string
  /** Display title of the source (article headline, paper title, etc.). */
  title: string
  /** URL the user can open. Always present for web-search adapters;
   *  empty string for LLM-only-with-disclaimers (which has no URL). */
  url: string
  /** Adapter-supplied snippet — the passage / quote the adapter cited
   *  from when forming the claim. Helps the user spot-check without
   *  opening every URL. */
  snippet?: string
  /** v1.0.197 — include this source in the YouTube description's SOURCES
   *  block. Toggled per-source on the Research page (bulk: all / verified-
   *  backing / none). Absent = included (default-on for existing research). */
  include_in_description?: boolean
  /** Publisher / site name, when the provider supplies one. NOT reliable
   *  today — GenStudio's citation envelope frequently omits it, so surfaces
   *  must treat absence as normal rather than as a defect. */
  publisher?: string
  /** ISO8601 publication date, when the provider supplies one. Same
   *  reliability caveat as `publisher`.
   *
   *  There is deliberately NO `retrieved_at`: GenStudio does not fetch the
   *  page itself (the upstream provider does), so a per-source fetch timestamp
   *  would be falsely precise. Run-level recency comes from
   *  ResearchOutput.generated_at. */
  published_at?: string
  /** Character offsets of the cited span inside the provider's answer text,
   *  when reported. STORED ONLY — claim-to-citation mapping is not available
   *  yet, so nothing may render a per-claim link from these. Kept so a future
   *  release can map spans without a schema migration. */
  start_index?: number
  end_index?: number
}

/** Adapter's recommended episode structure: a starting point for the
 *  script generator, NOT a binding outline. The user can edit / regen
 *  the actual outline in the Script Generator later. */
export interface ResearchStructureSection {
  heading: string
  /** Short summary of what this section should cover. */
  brief: string
  /** Which claim ids belong here. */
  claim_ids: string[]
}

export interface ResearchOutput {
  schema_version: 1
  /** Which adapter produced this. Surfaced in the Research page UI so
   *  the user remembers what tool generated the citations. */
  source_provider: ResearchSourceProvider
  /** Provider-specific model id (e.g. `perplexity/sonar-pro` for OR,
   *  `sonar-medium-online` for direct Perplexity, or the underlying
   *  LLM id for llm-only). Useful for cost-tracing in the future. */
  source_model?: string
  /** Which research route produced this. ABSENT means 'model-knowledge' —
   *  every sidecar written before this field existed came from the no-web-
   *  access route. Read it through readResearchMode() rather than inline, so
   *  legacy sidecars are never mislabelled. */
  research_mode?: ResearchMode
  /** What a web-mode run actually cost and did, as GenStudio reported it.
   *  Absent for model-knowledge runs, and for web runs where GenStudio
   *  reported nothing. */
  web_run?: ResearchWebRunReport
  /** When Story Studio wrote this sidecar. ISO8601.
   *
   *  This is the FALLBACK answer to "how recent are these web sources?", not
   *  the preferred one: when the envelope supplied `web_run.research_ran_at`,
   *  that is GenStudio's own record of the run and wins. Either way the answer
   *  is run-level — there is no per-source retrieval timestamp, on purpose
   *  (see ResearchCitation.published_at). Read both through
   *  services/research/provenance.ts :: researchRanAt(). */
  generated_at: string
  /** The episode topic the research was framed around. */
  topic: string
  /** User-supplied 'specifically answer these' questions, joined into
   *  the adapter's prompt. Empty string means topic-only research. */
  specific_questions?: string
  /** The claims the adapter returned. The Research page UI flips
   *  status flags in-place; user clicks Save to persist. */
  claims: ResearchClaim[]
  /** Sources. Indexed by ResearchClaim.citation_indices. */
  citations: ResearchCitation[]
  /** Recommended episode structure. Script generator uses this as a
   *  default outline when present. */
  structure?: ResearchStructureSection[]
  /** Adapter's free-form summary of the topic — surfaces above the
   *  claims list as context. */
  summary?: string
  /** v1.0.761 — WHO finished the per-claim triage. Provenance only: the
   *  completion rule is derived from the claim statuses above, never from
   *  this. Written/read exclusively through lib/research-verification.ts. */
  review?: ResearchReviewRecord
  /** @deprecated v1.0.761 — the retired v1.0.760 research-level attestation
   *  ("someone checked these claims against the cited sources"). It was false
   *  for an llm-only adapter that returns no citations, and it duplicated the
   *  per-claim triage. Ignored on read and stripped on write; declared only so
   *  legacy sidecars still type-check when they are loaded. */
  verification?: unknown
}

/** Who finished the per-claim review of a research sidecar.
 *  - 'human'         — a person triaged the claims on the Research page.
 *  - 'pipeline-auto' — an unattended one-click Pipeline run accepted the
 *                      remaining claims so the batch could complete. Recorded
 *                      distinctly on purpose: the app must never pretend a
 *                      human read the claims.
 *  - 'auto-approval' — the project's "Approve claims automatically" setting
 *                      (config `research_auto_approve_claims`) accepted the
 *                      claims as the run finished. Also automatic, but it is
 *                      a standing choice on the Research page rather than an
 *                      unattended batch, so it carries its own value and its
 *                      own wording — the two must never borrow each other's
 *                      sentence. */
export type ResearchReviewedBy = 'human' | 'pipeline-auto' | 'auto-approval'

/**
 * v1.0.761 — review PROVENANCE, persisted inside the research sidecar
 * (`{code} - 11 Research/research.json`) so it travels with the artifact it
 * describes.
 *
 * This records who completed the triage. Generating or regenerating research
 * clears it — new claims have never been read.
 */
export interface ResearchReviewRecord {
  /** Human vs. automatic. See ResearchReviewedBy. */
  completed_by: ResearchReviewedBy
  /** ISO8601 timestamp of the moment the triage was completed. */
  completed_at: string
  /** Plain-language note about how the review was completed. */
  note?: string
}

/** Options passed to ResearchAdapter.run(). */
export interface ResearchRunOptions {
  topic: string
  specific_questions?: string
  /** Cap on the number of distinct sources the adapter should consult.
   *  Adapters round / interpret as appropriate. */
  max_sources?: number
  /** v1.0.175 — optional GenStudio language-product id. Unset = the adapter's
   *  own default (resolved against the live catalogue, never a literal). */
  model?: string
  /** Which route to run. Unset = 'model-knowledge' (the unchanged default). */
  mode?: ResearchMode
  /** Web-mode domain filters. Only sent when the selected product advertises
   *  `supports_domain_filters`; silently dropped otherwise. */
  web_search?: ResearchWebSearchSettings
  request_identity?: string
  pipeline_model_policy?: AssignedPipelineModelPolicy
  pipeline_policy_checkpoint?: PipelinePolicyCheckpointStore
  pipeline_policy_checkpoint_key?: string
}

// ── Continuity-chain config (v1.0.189+ — continuity-chain pipeline) ─────
//
// Per-episode settings for the continuity-chain format, set on the Character
// Sheet page and persisted to `<episode_dir>/continuity.json`. Consumed by the
// density-paced scene planner (CC3) and the sequential renderer (CC4).

export interface ContinuityConfig {
  schema_version: 1
  /** Project character IDs that anchor every scene's look in this episode.
   *  Their reference images feed the img2img 'characters' reference source. */
  anchor_character_ids: string[]
  /** Also use the per-episode uploaded sheet (img2img-references/master.png)
   *  as a reference for every scene. */
  use_episode_sheet: boolean
  /** Explicit episode pacing for the next plan. Existing plan times stay unchanged. */
  pacing: ScenePacing & {
    opening_duration_sec?: number
    settled_min_sec?: number
    settled_max_sec?: number
  }
  /** Optional for legacy records; new bulk motion work defaults to off. */
  motion_scope?: MotionScope
  /** Prompt direction intensity, 1–4; independent of provider clip duration. */
  motion_level?: number
  /** Which references each scene's sequential render attaches (independent
   *  toggles, matching images.ts reference_sources). */
  references: {
    /** chain mode — the previous scene's render seeds the next (continuity). */
    prev_render: boolean
    /** the episode master sheet, on every scene. */
    sheet: boolean
    /** the anchor characters' reference images. */
    characters: boolean
    /** v1.0.229 — an optional style-reference image (img2img-references/
     *  style.png): the look/palette/rendering the scenes should match,
     *  attached to every scene alongside the subject references. */
    style?: boolean
    /** v1.0.260 — the composition template image (img2img-references/
     *  composition.png): the LAYOUT every scene is structured against.
     *  Attached as an img2img reference on every scene when on. */
    composition?: boolean
  }
  /** img2img denoise / strength (0..1). Lower = closer to the references
   *  (more consistent, risks near-identical frames); higher = more variation. */
  denoise_strength: number
  /** v1.0.243 — "Style Bible": a persistent style description appended to
   *  EVERY scene's prompt at RENDER time (medium, art style, rendering,
   *  lighting feel, colour grade). Unlike the planner's plan-time style, this
   *  is applied at render, so editing it + re-rendering needs no re-plan, and
   *  it also reinforces style for text-weighted providers alongside style.png. */
  style_bible?: string
  /** v1.0.243 — negative prompt appended at render time where the provider
   *  supports it (local ImageStudio today; cloud providers currently ignore
   *  it). Things to avoid: extra fingers, text/watermarks, etc. */
  negative_prompt?: string
  /** ISO8601 of the last save. */
  updated_at: string
}

// ── Scene Plan types (v1.0.143+ — timestamp-driven pipeline) ────────────
//
// Output of the LLM scene planner. Persisted to
// `<episode_dir>/scene_plan.json`. v1.0.144's Scene Review page reads
// this + writes back with approval flags. v1.0.145's video assembler
// consumes the approved plan to render the final video.

/**
 * v1.0.336 — coarse classification of what a continuity scene depicts. Drives
 * whether the anchored guide character appears in the rendered image:
 *   - 'character'   → the recurring guide is on screen, reacting/exploring.
 *   - 'event'       → the historical action itself (soldiers marching, a storm).
 *   - 'environment' → a place/setting with no character.
 *   - 'map'         → a map, route, or diagram.
 *   - 'artifact'    → a single object/document/detail in focus.
 * Non-'character' scenes render WITHOUT the character sheet / anchor refs so the
 * guide stays selective (and special) instead of appearing in every shot.
 */
export type SceneType = 'character' | 'event' | 'environment' | 'map' | 'artifact'

/** How Scene Plan interprets narration before writing image prompts. Art style
 * remains owned by the Character Sheet; this controls what visual idea is used. */
export type SceneCreativeProfile = 'narrative' | 'balanced' | 'editorial' | 'spiritual' | 'abstract' | 'custom'

/** A concrete visual-thinking approach assigned to one scene. Assignments are
 * made across the whole episode before prompt packs are submitted, preventing
 * adjacent scenes from repeatedly using the same metaphor or composition. */
export type SceneCreativeStrategy =
  | 'literal-narrative'
  | 'documentary'
  | 'editorial-metaphor'
  | 'symbolic'
  | 'poetic-environment'
  | 'character-psychology'
  | 'spiritual-allegory'
  | 'surreal'
  | 'conceptual-collage'
  | 'minimal-graphic'

export interface SceneCreativeDirection {
  profile: SceneCreativeProfile
  /** 1 = restrained, 4 = experimental. Profile boundaries still apply. */
  intensity: 1 | 2 | 3 | 4
  /** Used by the Custom profile; other profiles retain this for later reuse. */
  strategies: SceneCreativeStrategy[]
  /** Optional positive and negative channel-level creative guidance. */
  recurring_motifs?: string
  avoid_cliches?: string
  custom_direction?: string
}

export interface ScenePlanEntry {
  /** Stable id for UI editing — survives reorder / split / merge. */
  id: string
  /** 1-based position in the final video. Recomputed on save. */
  scene_index: number
  /** Start time on the stitched-audio timeline, in seconds. */
  start_sec: number
  /** End time on the stitched-audio timeline, in seconds. */
  end_sec: number
  /** The chunk of transcript this scene covers — taken verbatim
   *  from the stitched SRT cues that fall in the [start, end] window.
   *  The image generator uses this as the primary semantic anchor for
   *  the visual prompt. */
  transcript_segment: string
  /** The visual prompt the image generator will use. LLM-generated
   *  initially; user-editable in the Scene Plan UI. */
  visual_prompt: string
  /** v1.0.144+ — set by the Scene Review page when the user approves
   *  this scene's image. Video assembly is blocked until every scene
   *  is approved. */
  approved?: boolean
  /** v1.0.144+ — path to the generated image file once it exists. */
  image_path?: string
  /** v1.0.359 — the `visual_prompt` value the current `image_path` was rendered
   *  from. Stamped by the continuity renderer when it writes image_path. If it
   *  later differs from `visual_prompt` (user re-prompted in Scene Plan, or
   *  edited+saved in Scene Review without re-rendering), the image is STALE —
   *  Scene Review flags it. Absent on images rendered before this shipped. */
  rendered_prompt?: string
  /** Changes whenever the still is replaced, even when the prompt is identical. */
  image_version?: string
  /** SHA-256 of the registered still's bytes, so re-registering the same file never touches approval. */
  image_sha256?: string
  /** Reason the LLM picked this scene boundary, used as a hint in
   *  the Scene Plan UI ("Topic shift to <X>", "Named entity intro:
   *  <Y>"). Optional. */
  boundary_reason?: string
  /** v1.0.468 — image-to-video motion instruction for animating this scene's
   *  generated image into a short clip. Generated cohesively with
   *  `visual_prompt` (the planner sees the image prompt as context) and biased
   *  by the motion-intensity level (see MOTION_SPECS). Slight motion only —
   *  slow camera drift / gentle ambient / subtle script-driven subject motion.
   *  User-editable in Scene Plan + Scene Review. Phase 1: text only; the clip
   *  itself (Phase 2) will be generated from image_path + this prompt. */
  motion_prompt?: string
  /** Formula-owned motion assignment. Still means the approved image is held
   * in assembly; gentle and limited receive distinct image-to-video prompts. */
  motion_mode?: SceneMotionMode
  /** v1.0.470 — Phase 2: path to the animated clip (mp4) rendered from
   *  `image_path` + `motion_prompt` via an image-to-video model. Written by the
   *  scene-clip generator into the "11 Video Assets" folder. Absent until the
   *  scene is animated. */
  clip_path?: string
  /**
   * v1.4.232 — this scene's manual reveal choice, when the operator made one.
   *
   * Absent is the normal case and means "derived": the reveal planner computes this scene's arrival
   * from the episode seed, pool and coherence mode, so a re-render reproduces it without anything
   * stored. A stored choice wins over the derivation, and `reroll` makes a second choice a *new*
   * one rather than the same pick written twice — the same shape `RevealOverride` carries.
   */
  reveal?: { preset_id: string; reroll?: number }
  /** v1.0.470 — the `motion_prompt` value the current `clip_path` was rendered
   *  from. If it later differs from `motion_prompt` (user re-prompted), the clip
   *  is STALE — Scene Review flags it, mirroring `rendered_prompt` for images. */
  rendered_motion_prompt?: string
  /** image_version used as the clip's first frame; enables source-image stale checks. */
  clip_source_image_version?: string
  clip_renderer?: SceneClipRenderer | 'external'
  /** Actual input identity and Scene Plan window at render/upload start. */
  clip_source_image_sha256?: string
  clip_scene_window_seconds?: number
  /** Required, exact local-render provenance. Provider receipts remain independent. */
  clip_sketch?: {
    helper_version: number
    fps: number
    frames: number
    width: number
    height: number
    pen_fingerprint: string
    /** Resolved closing hold, in frames, this clip was rendered with. Absent on helper-v2 clips (old 15% hold). */
    hold_frames?: number
    /** Identity of the hold setting it was resolved from; evidence only, freshness compares the frames. */
    hold_fingerprint?: string
    /** The reveal type this clip actually resolved to. Absent on clips rendered before reveal styles. */
    reveal_type?: SketchRevealType
  }
  /** The exact paid clip duration accepted for this scene. External clips clear
   * this provider receipt; it is not a catalogue limit or preset value. */
  clip_requested_duration_seconds?: number
  /** Duration measured from the completed clip's video stream. */
  clip_duration_seconds?: number
  /** Follow narration clips hold their final frame during assembly, including
   * transition tails after a nominally long clip. */
  clip_shortfall_mode?: 'hold'
  /** Motion Review decision. New clips start as `pending`; the operator can
   *  approve the clip or intentionally keep the still. Missing means a legacy
   *  pre-review clip and remains accepted for backward compatibility. */
  motion_choice?: 'pending' | 'clip' | 'still'
  /** v1.0.336 — what this scene depicts (see SceneType). The continuity
   *  renderer uses it to decide whether the anchored guide character appears.
   *  Set by the planner; user-overridable in Scene Review. Absent on plans made
   *  before this field → renderer treats the scene as 'character' (prior
   *  behaviour: the guide appears everywhere). */
  scene_type?: SceneType
  /** v1.0.336 — true when the user hand-set `scene_type` in Scene Review; a
   *  re-plan / re-classify keeps their choice instead of overwriting it. */
  scene_type_locked?: boolean
  /**
   * Scene Review "Reference to Image" — ids of THIS episode's characters that
   * appear in this scene (AGENTS.md §4). Episode state, never preset state.
   *
   * Absent = the episode-level default from the render request applies.
   * An empty array = this scene renders from the prompt alone, which is the
   * intended answer for a scene nobody is in — not a silent fallback. The
   * renderer refuses ids on a non-character scene and never drops a scene's
   * references without saying so.
   */
  reference_character_ids?: string[]
  /** Creative interpretation assigned before the visual-prompt pass. This is
   * independent of scene_type and is retained by missing-prompt repairs. */
  creative_strategy?: SceneCreativeStrategy
  /** v1.4.360 — which visual lane renders this scene. */
  visual_lane?: VisualLane
  /** v1.4.360 — text-to-video motion prompt (channel style + action + camera). */
  video_prompt?: string
  /** v1.4.360 — prompt value from which `clip_path` was rendered when T2V. */
  rendered_video_prompt?: string
  /** v1.4.360 — whether this scene is marked as a key moment for motion allocation.
   *  The CUSTOMER's own answer; it always wins over the planner's suggestion. */
  key_moment?: boolean
  /** The planner's suggestion, shown as a suggestion the customer may change. Never
   *  presented as the customer's choice. Used only where `key_moment` is unset. */
  key_moment_suggested?: boolean
  /** v1.4.360 — strategy when scene exceeds model clip length: hold last frame or chain clips. */
  fill_mode?: 'chain' | 'hold'
  /** v1.4.360 — cheap backup still image made for every scene including T2V. */
  backup_still_path?: string
  backup_still_prompt?: string
  backup_still_version?: string
  backup_still_sha256?: string
}

export type SceneMotionMode = 'still' | 'gentle' | 'limited'

export interface SceneMotionProfile {
  id: string
  label: string
  description: string
  opening_duration_sec: number
  opening: Record<SceneMotionMode, number>
  settled: Record<SceneMotionMode, number>
}

export interface ScenePlan {
  /** Settings used to build these timestamps; draft changes do not rewrite them. */
  pacing?: ScenePacing
  /** A render of this plan auto-approved its images; images filled in later are approved too. */
  auto_approve_generated?: boolean

  schema_version: 1
  /** Last time any plan content was updated. ISO8601. */
  generated_at: string
  /** When the deterministic timeline was built. Prompt passes do not change
   * this, so the UI can distinguish rebuilding from prompt progress. */
  timeline_built_at?: string
  /** Model id used for the planner pass. */
  planner_model?: string
  /** The Formula profile used to classify each scene's motion behavior. */
  motion_profile?: SceneMotionProfile
  /** Stitched SRT filename this plan was built against. Drift-detection
   *  in the Scene Plan UI compares this to the current stitched SRT. */
  source_stitched_srt?: string
  /**
   * v1.4.0 — the IDENTITY of the caption timeline this plan's scene times were
   * derived from: cue boundaries only, never the words.
   *
   * The stitched SRT is the input Scene Plan is generated from, and v1.4.0 made
   * re-stitching automatic. A re-stitch that corrects a wrong intro lead-in
   * moves every cue, and this plan's scene times still follow the old timing —
   * so the two disagree and nothing else on disk could prove it. A filename
   * (`source_stitched_srt`) cannot: it is identical before and after.
   *
   * Absent on every plan built before v1.4.0, and absence is treated as "not
   * known to be stale" rather than "stale". See `lib/scene-plan-timeline.ts`
   * for why that asymmetry is deliberate.
   */
  source_timeline?: {
    sha256: string
    total_cues: number
    first_cue_start_sec: number
    last_cue_end_sec: number
  }
  /**
   * 1.4.276 — length of the merged narration this plan was timed against. A
   * re-narrated chapter re-merges the audio without necessarily re-stitching
   * the captions, so `source_timeline` alone can still match. Compared by
   * `compareMergedAudio` (lib/scene-plan-timeline.ts); absent = not known stale.
   */
  source_merged_audio?: { duration_sec: number }
  /** Total duration the plan covers — should match the stitched SRT
   *  total_duration_sec at generation time. */
  total_duration_sec: number
  /** Whether the research.json sidecar was injected as context when
   *  the LLM planned. Surfaces in the UI so the user knows. */
  research_used: boolean
  /** Ordered scenes. scene_index reflects current order. */
  scenes: ScenePlanEntry[]
  /** v1.0.226 — how many LLM time-windows the chunked planner assembled this
   *  plan from. 1 for short episodes; >1 for long ones planned in segments so
   *  the model's output never truncates. */
  planned_in_windows?: number
  /** Explicit staged workflow state. Timeline generation never needs an LLM. */
  planning_stage?: 'timeline' | 'visual' | 'motion'
  /** Opening visuals reserved before scene 1. Zero means visuals start at 0. */
  opening_reserved_sec?: number
  opening_mode?: 'branded-opening' | 'from-start'
  /** v1.3.1 — how `opening_reserved_sec` was decided.
   *
   *  `'measured'`  the reserve was probed from the project's real opening
   *                clips when the timeline was built, so it equals the
   *                renderer's `preSceneDuration` and the render plays those
   *                clips as they are.
   *  absent        a legacy plan whose reserve was a number someone typed (or
   *                a preset asserted). The renderer keeps stretching the intro
   *                to fill it, exactly as it always has. The owner has
   *                explicitly accepted these episodes as they are; nothing
   *                rewrites them. */
  opening_source?: 'measured'
  /** Last durable Hub Chat batch IDs, useful for support and recovery. */
  visual_prompt_batch_id?: string
  motion_prompt_batch_id?: string
  /**
   * v1.4.368 — a translated episode's plan was retimed onto its OWN narration by
   * `services/translation-timeline-rebase.ts`. Recorded so the rule is auditable and so a Retry
   * recomputes from these recorded shares instead of from the times it already rewrote.
   */
  translation_rebase?: TranslationTimelineRebase
  /** Exact creative setup used by the visual-prompt pass. Stored with the plan
   * so retries remain reproducible even after the active preset changes. */
  creative_direction?: SceneCreativeDirection
}

/**
 * v1.4.368 — provenance of a cross-language timeline rebase.
 *
 * The chapter windows are the anchor (the only points where the source and target narrations are
 * known to coincide); each scene's `share` is its length as a fraction of its chapter's scenes in
 * the SOURCE plan. Together they reproduce the retime from scratch, which is what makes a Retry
 * idempotent and makes a re-merge after a re-narration land in the right place.
 */
export interface TranslationTimelineRebase {
  schema_version: 1
  /** The one rule applied: a scene keeps its share of its chapter. */
  rule: 'chapter-share'
  source_slug: string
  source_episode_id: string
  rebased_at: string
  narration: { filename: string; duration_sec: number; lead_in_sec: number }
  chapters: Array<{
    slug: string
    source_start_sec: number
    source_end_sec: number
    target_start_sec: number
    target_end_sec: number
  }>
  scenes: Array<{ id: string; chapter: string; share: number; source_start_sec: number; source_end_sec: number }>
  /** Scenes the target narration has no chapter for. Kept here as the audit trail, never rendered. */
  dropped: Array<{ id: string; chapter: string; scene_index: number; image_path?: string }>
}

// ── Contextual cues (v1.0.742+) ───────────────────────────────────────────
//
// A reviewed editorial layer for documentary-style location/date/context
// labels. This deliberately lives beside the Scene Plan instead of inside
// subtitles: subtitle timing remains narration, while cues are optional visual
// annotations that Video Assembly renders exactly as approved.
export type ContextualCueKind = 'location_date' | 'historical_context' | 'person' | 'chapter'
/**
 * Re-exported from `contracts/contextual-cue-position.ts`, which the frontend
 * imports too. Spelling the four corners out a second time here is what let
 * "four are legal" and "two are reachable" coexist; there is now one list.
 */
export type ContextualCuePlacement = ContextualCueCorner
export type ContextualCueTransition = 'fade' | 'slide' | 'dissolve'
export type ContextualCueStatus = 'proposed' | 'approved' | 'disabled'
export type ContextualCueDensity = 'restrained' | 'standard' | 'editorial'
/** A reviewed visual treatment; never an instruction for Video Assembly to reinterpret a cue. */
export type ContextualCueTemplate = 'documentary-label' | 'map-pin' | 'archival-caption' | 'chapter-plate'

export interface ContextualCue {
  id: string
  scene_id: string
  /**
   * v1.4.365 — the words the narration says as this label appears.
   *
   * Replaces the drift that made every label "scene start + 0.15s" regardless
   * of what the viewer is hearing. Resolved against the episode's own subtitle
   * cues by `contracts/cue-anchor.ts` on every read; the stored `start_sec` is
   * kept for v1 readers and for a plan that cannot supply caption timing, but
   * a cue carrying an anchor is re-timed from it. Absent on every cue written
   * before this shipped, which is exactly why reading a v1 file still renders
   * it where it was.
   */
  anchor_word?: string
  /** Seconds into the scene, used only when `anchor_word` finds no caption. */
  anchor_offset_sec?: number
  start_sec: number
  end_sec: number
  title: string
  subtitle?: string
  kind: ContextualCueKind
  /**
   * Quick corner preset. Still the only thing most cues carry, and still what
   * renders when no precise anchor is set — every cue written before v1.3.0
   * has exactly this and nothing else, and renders byte-identically.
   */
  placement: ContextualCuePlacement
  /**
   * Precise anchor as a percentage of the frame, deliberately named and
   * scaled to match `VideoSubtitleStyle.position_x_pct` / `position_y_pct`:
   * 0–100, `y` measured from the TOP, and BOTH must be set for either to
   * apply. Unset (the default, and the state of every pre-1.3.0 cue) means
   * "use `placement`".
   *
   * Additive on purpose. Nothing rewrites a stored cue to carry these; a cue
   * gains them only when a person drags it or a proposal stamps the setting
   * they chose.
   */
  position_x_pct?: number | null
  position_y_pct?: number | null
  template: ContextualCueTemplate
  entrance: ContextualCueTransition
  exit: ContextualCueTransition
  status: ContextualCueStatus
  created_at: string
  updated_at: string
}

/** A cue an automatic pass declined to approve, and the validator detail(s) why. Never a silent drop. */
export interface ContextualCueAutoApprovalHold {
  cue_id: string
  reasons: string[]
}

export interface ContextualCueTimeline {
  /**
   * 1 for every file written before v1.4.365, and still readable byte for byte.
   * 2 is written by every save from then on: cues carry `scene_id` + a spoken
   * `anchor_word`, and their absolute seconds are derived rather than trusted.
   * Nothing rewrites a stored v1 file to compensate (AGENTS.md §5, trap 2).
   */
  schema_version: 1 | 2
  generated_at: string
  source_scene_plan_generated_at: string
  cues: ContextualCue[]
  /**
   * Set only by an automatic proposal pass (a preset's `auto_approve`) that
   * held one or more cues back from approval. Replaced on every new proposal;
   * a manual timeline save (PUT /contextual-cues/:episodeId) drops it, since a
   * human has taken over review at that point.
   */
  auto_approval_holds?: ContextualCueAutoApprovalHold[]
}

export interface ContextualCueProjectConfig {
  enabled: boolean
  /**
   * READ-ONLY COMPATIBILITY. Ignored: nothing in the app reads it any more.
   *
   * v1.4.365 — owner decision 2026-10-28. There were TWO auto-approve
   * switches: this project-level one and the preset's `auto_approve`, and the
   * page offered both, one of them disabled depending on the other. The preset
   * is the one that survives, because it travels with the model and density it
   * shares a preset with, and because AGENTS.md §5 already settled that
   * `auto_approve` is preset data and is announced when a preset sets it.
   *
   * A channel config on disk still carries this key. It is read safely (the
   * normaliser tolerates it) and has no effect; nothing rewrites the file.
   */
  auto_approve_cues?: boolean
}

/**
 * Reusable proposal controls for the Contextual Cues workspace. These are
 * deliberately separate from the project-wide on/off switch: a project may
 * be enabled while individual editors use different saved cue presets.
 */
export interface ContextualCueProposalSettings {
  model: string
  density: ContextualCueDensity
  placement: ContextualCuePlacement
  /**
   * Default precise anchor stamped onto every cue a proposal creates, exactly
   * as `placement` already is. This is how "keep labels off my logo" is said
   * once instead of per cue; a reviewer can still drag any single cue
   * afterwards. Unset means new cues carry only their corner.
   */
  position_x_pct?: number | null
  position_y_pct?: number | null
  /**
   * Explicit opt-in for trusted presets, remembered per browser/preset —
   * independent from the persisted project default `auto_approve_cues`
   * above. Defaults to human review.
   */
  auto_approve: boolean
}

// ── Sound Design (v1.0.746+) ──────────────────────────────────────────────
//
// A project-level, reviewed audio overlay timeline. It is intentionally
// separate from Video Assembly: Sound Design owns authoring/review; Video
// Assembly only consumes approved, locally available cues at final mix time.
export type SoundDesignCueKind = 'bed' | 'spot'
export type SoundDesignCueStatus = 'proposed' | 'matched' | 'approved' | 'excluded'
/**
 * `minimal | balanced | rich` used to live here. v1.4.365 deleted it: nothing
 * read it. A control that changes no output is worse than no control, because
 * the customer sets it and expects a difference.
 */
export type SoundDesignDensity = never

export interface SoundDesignProjectConfig {
  enabled: boolean
}

/** Saved setup for the dedicated Sound Design workspace. */
export interface SoundDesignSettings {
  max_spots_per_minute: number
  default_bed_gain_db: number
  default_spot_gain_db: number
  ducking_profile: 'gentle' | 'standard' | 'strong'
}

/**
 * Where a cue's audio comes from.
 *
 * `pool` is the channel's own SFX folder (3D B-Roll pools). `gateway` is the
 * Gateway's shared sound library — Openverse, CC0-first — whose entries carry
 * the licence and author that a per-clip credit line needs. v1 cues have
 * neither field and are read as `pool`, which is what they always were.
 */
export type SoundDesignCueSource = 'pool' | 'gateway'

/** The credit facts a Gateway-library clip carries. Never invented for a pool clip. */
export interface SoundDesignCredit {
  /** e.g. `cc0`, `by`, `by-sa`. */
  licence: string
  licence_version?: string
  author?: string
  /** The upstream landing page, so the credit is checkable. */
  source_url?: string
  source?: string
  title?: string
}

export interface SoundDesignCue {
  id: string
  kind: SoundDesignCueKind
  label: string
  /**
   * v1.4.365 — the Scene Plan scene this cue belongs to, and the spoken words
   * its window is anchored to. Same rule and same resolver as a contextual
   * cue: the absolute seconds below are derived from these, so a Scene Plan
   * re-run moves the sound with its scene instead of leaving it on a stale
   * clock. Absent on every v1 cue.
   */
  scene_id?: string
  anchor_word?: string
  anchor_offset_sec?: number
  start_sec: number
  /** Required for beds; optional spots are one-shots anchored at start_sec. */
  end_sec?: number
  /** Defaults to `pool` when absent — the v1 shape. */
  source?: SoundDesignCueSource
  /** Pool id, for a `pool` cue. */
  pool_id?: string
  /** The clip's filename in a pool, or its sha256 in the Gateway library. */
  clip: string
  /** Set only for a `gateway` cue; never guessed for a pool clip. */
  credit?: SoundDesignCredit
  gain_db: number
  status: SoundDesignCueStatus
  created_at: string
  updated_at: string
}

export interface SoundDesignTimeline {
  /** 1 = every file written before v1.4.365. 1 and 2 both read; 2 is written. */
  schema_version: 1 | 2
  generated_at: string
  source_scene_plan_generated_at: string
  /** Snapshot of the approved mix policy; presets remain reusable separately. */
  settings: SoundDesignSettings
  cues: SoundDesignCue[]
}

/**
 * What a SCENE prompt writer is told about the episode it is writing for.
 *
 * A scene prompt reaches the image model VERBATIM and ALONE — no narration, no
 * episode title, no neighbouring scene — so the writer has to name the subject
 * itself, and the episode's own title and opening narration are the honest
 * source for what that subject is (WI0004: 46 saved prompts described a
 * zipper's teeth, 29 never said "zipper", and the render came back as human
 * teeth). Assembled from THIS episode's own metadata and its own opening
 * narration, then passed down; nothing here is cached, so an episode change
 * cannot carry the previous episode's title into the next one's prompts.
 *
 * Episode-level state, never a reusable setting: it belongs in no preset.
 */
export interface EpisodePromptContext {
  /** The episode's title, as its own metadata holds it. */
  title?: string
  /** A short passage of this episode's own opening narration. */
  subject?: string
}

/** Options passed to the scene planner. */
export interface ScenePlanRunOptions {
  /** Path to the stitched SRT (output of the subtitle stitcher). */
  stitched_srt_path: string
  /** Path to research.json — included as context when present. */
  research_path?: string
  /** Path to the narration docx — included as context when present
   *  (richer than the SRT-only transcript). */
  narration_docx_path?: string
  /** LLM model id (anything supported by callAi). */
  model: string
  /**
   * This episode's own title + a short passage of its opening narration, sent
   * with the subject-naming rule so a scene prompt never loses what the image
   * is of. Resolved by the CALLER (it holds the episode's metadata and SRT) and
   * read per call — never carried over from a previous episode. Absent = the
   * planner was told nothing about the episode, and says nothing.
   */
  episode_context?: EpisodePromptContext
  /** Target scene count. Adapters interpret as a guideline, not strict. */
  target_scene_count?: number
  /** v1.0.242 — how richly the LLM writes each `visual_prompt`. 1 = concise
   *  one-liner … 4 = vivid cinematic paragraph. Defaults to 2 (the historical
   *  "2-3 sentences" behaviour) when unset. Drives the length + coverage spec
   *  injected into the planner prompt. */
  detail_level?: number
  /** v1.0.242 — global visual-style guidance woven into EVERY scene's
   *  visual_prompt (medium, art style, rendering, colour treatment). Free text
   *  from the user; empty/undefined = no style override. */
  style_prompt?: string
  /** v1.0.242 — extra free-text instructions the planner must follow for all
   *  scenes (e.g. recurring props, things to always/never show). */
  custom_instructions?: string
  /** The prompt-BODY character ceiling each visual prompt is written under:
   *  the effective image-model cap minus the exact text the writer's style
   *  lead and the renderer append. Absent = no limit in force. */
  prompt_char_cap?: number
  /** The model's published figure, when one was read live. Never set for a
   *  limit the customer chose, and never for a legacy numeric allowance. */
  prompt_char_cap_published?: number
  /** Characters reserved on top of the body (style lead + render assembly). */
  prompt_char_cap_reserved?: number
  /** Where the ceiling came from: the model's published figure, a chosen
   *  limit, or a numeric allowance saved by an older version. */
  prompt_char_cap_source?: 'model' | 'chosen' | 'saved'
  /** v1.0.193 (continuity-chain) — density pacing guardrails. When set, the
   *  planner segments scenes to fit [min_sec, max_sec] (the user's per-episode
   *  band from continuity.json) and cuts denser on busy passages for a "live"
   *  feel, instead of leaning on target_scene_count. */
  pacing?: {
    min_sec: number
    max_sec: number
    mode?: 'live' | 'documentary' | 'variable'
    periods?: ScenePacingPeriod[]
    /** Optional Formula-owned handoff from a denser opening to ambient holds. */
    opening_duration_sec?: number
    settled_min_sec?: number
    settled_max_sec?: number
  }
  /** v1.0.337 — % of scenes that feature the recurring guide character
   *  (continuity-chain). Per-project (config.json `character_density`).
   *  0 = no guide; 100 = guide in every scene; ~40 (default) = selective. */
  character_density?: number
  /** v1.0.226 — progress callback for the chunked planner; fires once per
   *  time-window as its scenes come back (done, total windows, cumulative
   *  scene count). Lets the generator surface live progress + per-window logs. */
  onProgress?: (done: number, total: number, scenesSoFar: number) => void
  /** v1.0.245 — plan ONLY this time range (used by per-scene "Re-plan this
   *  scene" to fix an over-long / auto-filled segment). When set, only cues
   *  overlapping [start_sec, end_sec] are planned and the returned scenes cover
   *  exactly that span; the caller splices them back into the existing plan. */
  range?: { start_sec: number; end_sec: number }
  /** v1.0.423 — skip everything before this timeline position when planning
   *  (sleep-story "Introduction" chapter). Unlike `range`, this only sets the
   *  START: cues ending at/before it are dropped, the chain seeds here, and
   *  coverage still runs to the full episode end. Computed by the caller as the
   *  story-start (lead-in + Introduction duration + gap) via computeStoryStartSec.
   *  Ignored when `range` is set (re-plan wins). */
  skip_until_sec?: number
  /** v1.0.245 — non-fatal warning callback (e.g. "window 3 failed twice — split
   *  into N cue-aligned scenes with empty prompts"). The generator surfaces
   *  these in the Jobs log so a degraded window is never silent. */
  onWarn?: (message: string) => void
  /**
   * v1.0.285 — per-window scene-count tuning for local-model reliability.
   *
   *   'auto'  (default) — sizes off the selected product's PUBLISHED context
   *           window: available input under 64,000 tokens gets small windows
   *           (10 scenes), everything else full windows (30 scenes). This used
   *           to switch on a `chatstudio:` / `lmstudio:*` model-id prefix — a
   *           capability guess from a name, which AGENTS.md's first rule
   *           forbids. See `resolveTargetScenesPerWindow` in scene-planner.ts.
   *   'full'  — always 30 scenes per window. Fewer LLM calls, richer
   *           cross-scene cohesion, but larger JSON output that smaller
   *           local models may truncate.
   *   'small' — always 10 scenes per window. ~3× more LLM calls but each
   *           output is ~3× smaller. Best for local models that hit
   *           max-tokens truncation OR produce malformed JSON on big
   *           outputs (the symptom: empty visual_prompts after the
   *           fallback fires).
   *
   * Background: when a window's LLM call fails twice, the planner falls
   * back to cue-aligned subdivision with EMPTY visual_prompts so the
   * timeline is still complete and the user can re-plan individually.
   * Small windows fail less often.
   *
   * Ignored entirely when `planning_mode === 'two-pass'` — two-pass uses
   * deterministic cue-walking for the split step, no LLM JSON output to size.
   */
  window_size?: 'auto' | 'full' | 'small'
  /**
   * v1.0.508 — cross-window narrative continuity ("story so far").
   *
   * true (default) — each window's prompt carries a rolling recap of scenes
   *   planned in earlier windows, so visual continuity (recurring characters,
   *   setting, tone) carries across window seams. Because window N depends on
   *   window N-1's output, the windows MUST be planned SEQUENTIALLY.
   *
   * false — drop the recap; each window is planned purely from its own cues +
   *   fixed time bounds, so the windows are INDEPENDENT and are planned in
   *   PARALLEL (big speedup on multi-window episodes). The trade-off is weaker
   *   continuity across seams (the model can't see what earlier windows chose).
   *   Parallelism is gated by model: direct paid cloud fans out; free/proxy
   *   tiers stay serial to avoid 429 storms.
   */
  cross_window_context?: boolean
  /**
   * v1.0.291 — planning architecture.
   *
   *   'single-pass' (default) — the historical flow: chunked LLM windows
   *           produce {timing + transcript + visual_prompt} JSON in one
   *           call per window. Works great on cloud models; on small local
   *           models the JSON output requirement causes routine failures
   *           (empty visual_prompts after the fallback path fires).
   *
   *   'two-pass' — deterministic cue-walking produces the scene split
   *           (timing + transcript only, no LLM), then a separate per-scene
   *           LLM call generates each visual_prompt as plain prose (with
   *           configurable neighbor context for continuity). No structured
   *           JSON output anywhere, so even small local models that can't
   *           reliably emit JSON produce usable plans.
   *
   * NOT SELECTED BY ANY SHIPPED UI, AND NOT BY ANY MODEL ID (corrected
   * 2026-09-26 — this block claimed otherwise and gateway-kh read it as
   * current). The Scene Plan form sent `planning_mode` only between v1.0.291
   * and v1.0.551, when "simplify staged scene planning" removed it along with
   * `window_size`; the id check that exposed it died earlier still, with the
   * LM Studio provider in v1.0.459. `planScenesTwoPass` and this parameter
   * remain reachable by an API caller or a saved run, but nothing infers the
   * mode from a model id, a name, or a provider, and nothing may: AGENTS.md's
   * first rule. Reintroducing it is an owner decision, and its trigger would
   * be a published capability field, never a string match on an id.
   */
  planning_mode?: 'single-pass' | 'two-pass'
  /**
   * v1.0.291 — when `planning_mode === 'two-pass'`, controls how many
   * surrounding scenes feed into each per-scene prompt LLM call.
   *
   *   - `back` (default 2): how many previous-scene `visual_prompt`s the
   *     model sees for continuity. The previous prompt is the strongest
   *     signal for visual consistency (same character, same setting).
   *   - `forward` (default 1): how many upcoming-scene `transcript_segment`s
   *     the model sees so it can frame the current scene as a setup for
   *     what's coming.
   *
   * Larger windows give better continuity at the cost of bigger per-call
   * input. The Scene Plan dropdown that mapped Minimal=0/0, Standard=2/1,
   * Rich=3/2 was removed in v1.0.551 with the rest of the two-pass controls;
   * a caller naming these two fields is the only way they are set today.
   */
  neighbor_context_back?: number
  neighbor_context_forward?: number
  /**
   * The selected model's published context window (GenStudio's
   * `context_window_tokens`), used ONLY by the single-pass chunked planner
   * to size its per-window scene count in `window_size: 'auto'` mode — see
   * `TARGET_SCENES_PER_WINDOW` in scene-planner.ts. Every window's prompt
   * re-sends the full narration + research plus, in `cross_window_context`
   * mode, a "story so far" recap that grows with each planned window; a
   * model with a small published context window needs a smaller window to
   * keep that combined input inside its budget. Undefined/0 = GenStudio
   * published nothing usable for this model — `auto` falls back to the
   * smaller, safer window rather than assume a large context it was never
   * told about. Never converted into a character/word limit. Ignored by
   * `planScenesTwoPass` (no window sizing there).
   */
  context_window_tokens?: number
  /**
   * The selected model's published max output allowance (GenStudio's
   * `max_output_tokens`), paired with `context_window_tokens` to compute the
   * available input budget via `availableInputTokens` (scene-prompt-batching.ts)
   * for the same `window_size: 'auto'` sizing. Ignored by `planScenesTwoPass`.
   */
  max_output_tokens?: number
}
