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
  /** v1.0.469 — per-scene image-to-video CLIPS (Phase 2 of the motion-prompt
   *  feature). Heavy media (mp4s), so it migrates to the external media_root
   *  like images/video. Optional in stored project.json (older projects won't
   *  carry it) — readers must tolerate `undefined`. */
  video_assets: string
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
  /**
   * Optional (Level B, opt-in). When set — a portable Named-Root token like
   * `${MEDIA}` or an absolute path — the HEAVY media subfolders (scene images,
   * thumbnails, audio, merged audio, final video) are written under this root
   * instead of `output_root`, while light artifacts stay in the iCloud project
   * tree. Absent (the default) = everything under `output_root`, unchanged.
   * See services/media-root.ts + docs/external-media-root-spec.md.
   */
  media_root?: string
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
   * Niche primitive — subject-domain layer orthogonal to Format. Format
   * answers "what shape of video" (bound-explainer, sleep-story, listicle);
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
  niche_overrides?: DeepPartial<Niche>

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
   *  20, 30]; bound-explainer: [8, 12, 15, 20]; kids-fairytale:
   *  [5, 8, 10, 15]). The format's `defaultLengthMinutes` should appear
   *  in this list so the dropdown shows the right value selected on
   *  fresh project load instead of falling through to "Custom...". */
  durationPresets?: number[]
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
   * formats override with their natural term — bound-explainer uses
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
     * Default video-generator aspect ratio (passed to Veo / Sora / fal-video).
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
   */
  audioDefaults?: {
    /** Default playback speed multiplier (typical range 0.85–1.2). */
    speed?: number
    /** ElevenLabs / fal stability slider (0–1). */
    stability?: number
    /** ElevenLabs / fal similarity-boost slider (0–1). */
    similarity?: number
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
    /** Ordered list of beats the intro should hit. Each beat becomes
     *  a numbered bullet in the prompt. */
    beats?: string[]
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
   *   "sentence" — Bound-style explainer pacing. Scenes within a chapter
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

  /**
   * v1.0.89+: Visual source for the video assembly step.
   *   - 'scene-images' (default, omitted): per-scene AI-generated stills,
   *     the original Story Studio path. Used by sleep-story, bound-
   *     explainer, listicle, true-crime, etc.
   *   - 'broll': pulls clips from an app-level B-Roll pool. Used by
   *     prayer / devotional / narration-over-stock formats where every
   *     frame is human-shot footage instead of generated art.
   *   - 'timestamp-driven' (v1.0.141+): scenes are placed against the
   *     ACTUAL audio timeline (stitched per-chapter SRTs + the merge
   *     gap from audio_chapters.json) rather than evenly distributed.
   *     One scene per LLM-decided natural beat in the script; each
   *     scene's duration matches the spoken-word window it covers.
   *     Adds Research / Scene Plan / Scene Review pages to the
   *     sidebar; hides Scene Prompts / Scene Generator / Video
   *     Generator (same gating as 'broll').
   * Drives sidebar visibility, pipeline step set, and which
   * generator the Video Assembly button triggers.
   *
   *   'continuity-chain' (v1.0.187+) — like 'timestamp-driven' (audio →
   *     subtitles → timed scene plan), but scenes render SEQUENTIALLY via
   *     img2img: a dropped-in character sheet anchors identity and each
   *     scene can reference the previous scene's render for visual
   *     continuity. User-set pacing guardrails (min/max seconds) drive a
   *     "feels live" cut density. Same sidebar gating as 'timestamp-driven'
   *     (Scene Plan / Scene Review / unified Video Assembly) PLUS a Character
   *     Sheet page. Research is available too (optional — handy when the
   *     niche is factual).
   */
  visualSource?: 'scene-images' | 'broll' | 'timestamp-driven' | 'continuity-chain' | 'narrated-scenes' | 'image-pool'

  /**
   * v1.0.280+ (format-niche refactor, Phase A) — top-level presentation switch
   * for the unified `scenes` format. Decides how scenes pair to the script
   * across the WHOLE pipeline (sidebar chain, generator picks, video assembly),
   * not just the image-prompt assembler.
   *
   *   'chapter'  — scenes distribute evenly across chapters (the historical
   *                'narrative' / 'narrated-scenes' behaviour). One scene per
   *                LLM-decided beat per chapter; per-scene duration uniform.
   *   'sentence' — scenes time to the actual audio (the historical
   *                'narration-synced' / timestamp-driven behaviour). Each
   *                scene spans the sentence window it covers; cut density
   *                tracks the narration cadence.
   *
   * Independent of `visualSource`:
   *   - scenes format + sceneAlignment 'chapter'  → even-distribution stills
   *   - scenes format + sceneAlignment 'sentence' → timestamp-aligned stills
   *   - continuity-chain format + sceneAlignment 'sentence' (only useful pair) →
   *     sequential img2img chained to the timed plan
   *
   * Relationship to `imagePrompts.alignment` (the older field): the existing
   * field continues to drive the Compilation step's scene→sentence pairing
   * math; the new top-level field is the pipeline switch that decides which
   * sidebar/generator chain runs in the first place. New format JSONs should
   * set this field; legacy formats without it fall through to the value
   * inferred from `visualSource` ('timestamp-driven'/'continuity-chain' ⇒
   * 'sentence'; everything else ⇒ 'chapter').
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

export interface Niche {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1

  /** Short tagline shown on the niche card / picker. */
  tagline?: string

  /** Example topics that feed the Ideas generator's "give me ideas in this
   *  niche" pass. Each entry is the canonical "subject" string (e.g.
   *  "Venus Flytrap", "Corpse Flower"). */
  exampleTopics: string[]

  /** Vocabulary pools merged INTO the format's vocab pools at ideas-
   *  generation time. Niche keywords append to format keywords; the
   *  randomizer draws from the union. */
  vocabulary?: NicheVocabulary

  /** v1.0.332 — art direction for THUMBNAIL images, separate from the scene
   *  `visualStyleSheet`. Appended to the format's thumbnail conceptGuidance so
   *  a niche can render thumbnails in a different art style than its scenes
   *  (e.g. sketchy-ink covers over thick-paint scenes). */
  thumbnailStyleSheet?: string
  /** Long-form style sheet appended after the format's `visualStyleHint`
   *  in image-prompt assembly. Use this to lock the rendering convention
   *  for every scene in this niche (e.g. "all plants drawn with soft
   *  watercolor wash over thick line art"). */
  visualStyleSheet?: string

  /** Short keyword tags auto-added to every scene prompt and every
   *  newly-created character in projects that carry this niche. Mirrors
   *  the per-character `references.style_keywords` pattern but at niche
   *  scope. */
  defaultStyleKeywords?: string[]

  /** Negative-prompt addendum merged into the project's negative prompt
   *  (e.g. "no human characters, no animals in main frame" for the
   *  plants niche). */
  negativePromptAddendum?: string

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
   *  editor (replaces format.imagePrompts.visualStyleHint). The longer
   *  `visualStyleSheet` continues to feed the baked-in defaultStyleTag. */
  visualStyleHint?: string
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
  // fungi, insects under bound-explainer) leave these all unset.

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

  /**
   * @deprecated v1.0.105 — inline `thumbnailTemplate` on the niche
   * is preserved for backwards compat (old niche JSONs keep working;
   * the loader promotes the inline template into the library cache
   * under a synthetic id). For NEW niches, declare
   * `defaultThumbnailTemplateId` and put the template in
   * electron/server/thumbnail-templates/{id}.json.
   */
  thumbnailTemplate?: Omit<ThumbnailTemplate, 'id' | 'name' | 'description' | 'builtin' | 'schemaVersion'>
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
 * Portable manifest (schema v2). Written as `.story-studio-project.json` at
 * the root of a project's `output_root` whenever project metadata changes.
 * Travels with the folder when the user syncs via iCloud / Google Drive /
 * OneDrive.
 *
 * Schema v2 is intentionally small — just enough structure for another
 * machine to recognise the folder and line up episode codes with folder
 * names. Presets, production standards, YouTube templates, voice presets,
 * and "required named roots" are NOT manifest/cloud data. Presets have one
 * local app-owned list; machine paths and secrets are configured locally.
 * This keeps the manifest ≤1 KB and avoids conflicting configuration copies.
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
  /** Accepted for old API clients; new channels always start on Continuity. */
  format_id?: string
  /**
   * Optional starter niche (subject-domain) for the new project. Picked
   * via the Niche picker in the Create Project wizard. Persisted to the
   * project meta as `niche_id`. Unset = no niche, format defaults apply
   * unchanged. Validated server-side: unknown ids are silently dropped
   * rather than rejecting the create, matching how format_id behaves.
   */
  niche_id?: string
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
  content_mode?: 'format' | 'freeform'
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
  /** v1.0.302 — the project's configured `format_id` (raw; may be a legacy
   *  alias). The home page maps it to a friendly format name for the card
   *  badge. Undefined for projects with no format_id set (→ shown as the
   *  default format). */
  format_id?: string
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
}

export interface AudioModelConfig {
  label: string
  cost_per_1k_chars: number
  /**
   * Which provider to route this model to. Optional for backward compat —
   * if missing, the audio generator falls back to prefix-based detection
   * (`genaipro-*` → genaipro, `eleven_*` → elevenlabs, else fal).
   */
  provider?: 'fal' | 'genaipro' | 'elevenlabs' | 'voicestudio' | 'genstudio' | 'macos' | 'fishaudio' | 'kie'
  /**
   * Soft outer provider-request boundary. Story Studio splits only when a
   * provider's public API limit requires it. GenStudio and clone-capable
   * VoiceStudio models accept chapter-scale outer requests; VoiceStudio owns
   * their smaller model-sized chunks, joins, and final speed processing.
   */
  tts_soft_max_chars?: number
}

export interface VideoModelConfig {
  label: string
  credits_per_video: number
  provider: string  // 'kie-video' | 'fal-video'
  /** Story Studio supports image-to-video only. */
  modes: Array<'frames'>
  /** Max duration in seconds, if known */
  max_duration?: number
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
 * these in a "Custom" optgroup beside the built-in style presets.
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
   * entry (or a built-in style id the frontend seeds into `style_presets`)
   * that is auto-applied to every generated image prompt for this project.
   * When set, it fully replaces the format+niche style tag; the style's
   * preview image is also fed into img2img generation as a reference. Unset
   * = fall back to the format+niche merged tag. Resolved via
   * services/art-style-resolver.ts.
   */
  active_style_preset_id?: string
  audio_models: Record<string, AudioModelConfig>
  audio_pricing_last_updated: string
  video_models?: Record<string, VideoModelConfig>
  video_pricing_last_updated?: string
  confirmation_preferences?: ConfirmationPreferences

  /**
   * v1.0.89+: App-level B-Roll pool this project draws stock footage
   * from when format.visualSource === 'broll'. Empty / undefined means
   * "no pool subscribed yet" — the Video Assembly B-Roll picker shows
   * a "Pick a pool" prompt linking to /broll-library.
   */
  broll_pool_id?: string
  /** Per-channel usage log for B-Roll repeat avoidance. */
  broll_usage_log?: BrollUsageEntry[]
  /** How many recent uploads to consult when avoiding repeats (default 10). */
  broll_lookback?: number
  /** Channel-locked metadata template (LLM fills placeholders only). */
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
  video_models?: Record<string, VideoModelConfig>
  video_pricing_last_updated?: string
  confirmation_preferences?: ConfirmationPreferences
  broll_pool_id?: string
  broll_lookback?: number
  metadata_template?: MetadataTemplate
}

export interface UpdateApiKeysRequest {
  [key: string]: string | undefined
  genstudio_api_key?: string
  google_api_key?: string
}

export interface UpdateConfigRequest {
  image_models?: Record<string, ImageModelConfig>
  voice_presets?: VoicePreset[]
  voice_favourites?: string[]
  audio_models?: Record<string, AudioModelConfig>
  video_models?: Record<string, VideoModelConfig>
  confirmation_preferences?: ConfirmationPreferences
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export const JOB_TYPES = [
  'broll_select', 'script-only', 'introduction-only', 'chapter-only',
  'outline_only', 'expand_chapters', 'image_prompts', 'images',
  'scene_images', 'thumb_images', 'images_repair', 'audio', 'audio_merge',
  'metadata', 'video', 'video_repair', 'video_assembly',
  'subtitles_transcribe', 'youtube_upload', 'youtube_playlist_update',
  'youtube_thumbnail_refresh', 'broll_normalize', 'broll_assemble',
  'broll_autotag', 'broll_fetch', 'research_run', 'scene_plan_run',
  'scene_image_generate', 'scene_images_batch', 'scene_clip_generate',
  'scene_clips_batch', 'continuity_render',
  'prompt_director', 'composition_generate', 'expression_markup',
  'image_pool_generate',
] as const

export type JobType = typeof JOB_TYPES[number]
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'

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
  /** Cooperative Story-side pause. Running provider requests already accepted
   * upstream finish and checkpoint their artifact; no new item is submitted. */
  pause_requested?: boolean
  /** Distinguishes a user-paused job from one paused by the global queue hold.
   * Global Resume may restart only `queue` jobs; `manual` jobs stay paused. */
  pause_origin?: 'manual' | 'queue'
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  output_lines: string[]
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
  /** Structured executor outcome. `complete: false` is a queue-enforced
   * failure declaration and can never be persisted as a green Done job. */
  result?: Record<string, any>
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
   * Durable GenStudio-side job evidence. The remote boundary owns billing;
   * Story records only values returned by GenStudio and never derives rates.
   * Historical jobs simply omit this additive field.
   */
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
    routing_status_code?: string | null
    location?: string
    queue_state?: 'waiting_local' | 'submitting' | 'accepted' | 'waiting_account_capacity'
      | 'running' | 'completing' | 'succeeded' | 'failed' | 'waiting_credits' | 'cancelled'
    updated_at: string
  }>
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
  generate_image_prompts: boolean
  generate_youtube_desc: boolean
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
  /** Provider-published inference-step control (GenStudio currently 2-8). */
  image_steps?: number
  /** Optional deterministic image seed. */
  seed?: number
  /**
   * v1.0.416+ — optional extra guidance appended to the THUMBNAIL prompt at
   * render time (Thumbnail Generator tab). Lets the user nudge a render
   * ("bigger title", "push subject closer") without editing/reprompting the
   * stored prompt. Ignored for scenes.
   */
  extra_details?: string
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
  stability: number
  similarity: number
  force: boolean
  no_overwrite: boolean
  /** Fish Audio S2-Pro only — render the saved expressive (tagged) narration. */
  use_expression?: boolean
  /** Fish Audio only — 0–1 expressiveness (temperature). Higher = less monotone. */
  fish_temperature?: number
  /** Fish Audio S2-Pro only — auto-insert pause tags at sentence/paragraph breaks. */
  fish_autopace?: boolean
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
  files: string[]              // multiple .mp3 paths
  volume: number               // 0-1 during narration
  post_narration_volume: number // 0-1 after narration ends
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
  /** Unified assembly always hydrates this to `scene_plan` before rendering. */
  scene_pool_mode?: 'scene_plan'
  /** Where this final assembly runs. Remote is strict: it never falls back
   * to the control-centre Mac when no external Render Studio is available. */
  render_target?: 'remote' | 'local'
  music?: VideoMusicConfig
  /** @deprecated v1.0.354 — Target Duration removed. The video body always
   *  equals the narration; an optional post-audio tail is the only extension.
   *  Kept optional so old presets that still carry it load without error; the
   *  assembler ignores it entirely. */
  duration?: VideoDurationConfig
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
  outro_card?: VideoOutroCard
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
  /** Per-chapter audio durations in playback order. Frontend reads
   *  these from `${episode}/audio_chapters.json` (written by the
   *  Audio Merge step) and forwards on the request so the backend
   *  doesn't need to re-probe. */
  chapter_durations?: Array<{ slug: string; duration_s: number }>
  film_grain?: VideoFilmGrain
  letterbox?: VideoLetterbox
  frame?: VideoFrameConfig
  subtitles?: VideoSubtitleConfig
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

// ── Video Generation ────────────────────────────────────────────────────────

export type VideoGenerationMode = 'frames'

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
  model: string            // video model ID (e.g. 'kie-veo3-fast')
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
  narration_volume?: number    // 0-1, default 1.0
  write_mode?: 'overwrite' | 'new'  // how to handle an existing merged output; default 'overwrite'
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
// the prompt context so factual claims in the final script are
// traceable to real sources.

export type ResearchSourceProvider = 'perplexity' | 'llm-only'

/** One factual claim the research adapter returned, with status flags
 *  the user can toggle in the Research page UI. */
export interface ResearchClaim {
  /** Stable id for UI editing. Generated client-side as `claim_<rand>`. */
  id: string
  /** The claim itself, written as a short declarative sentence. */
  text: string
  /** User-controlled state. Defaults to 'unreviewed' on adapter output;
   *  the script generator only uses claims marked 'verified'. */
  status: 'unreviewed' | 'verified' | 'ignored'
  /** Source citation indices (offsets into ResearchOutput.citations).
   *  Empty for LLM-only-with-disclaimers adapter output where the LLM
   *  recommends manual verification rather than naming a URL. */
  citation_indices: number[]
  /** Adapter-supplied confidence ("high" | "medium" | "low" | "unknown")
   *  that the user can use to triage which claims need the closest review. */
  confidence?: 'high' | 'medium' | 'low' | 'unknown'
  /** Adapter-supplied note explaining the claim's nuance / caveat —
   *  most useful for LLM-only-with-disclaimers output. */
  note?: string
}

export interface ResearchCitation {
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
  /** When the research run completed. ISO8601. */
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
}

/** Options passed to ResearchAdapter.run(). */
export interface ResearchRunOptions {
  topic: string
  specific_questions?: string
  /** Cap on the number of distinct sources the adapter should consult.
   *  Adapters round / interpret as appropriate. */
  max_sources?: number
  /** v1.0.175 — optional text model id for the LLM-only adapter. Lets the
   *  user pick any provider (kie.ai, OpenAI, DeepSeek, Anthropic…) instead
   *  of the hardcoded Anthropic default. The web-search adapter (Perplexity)
   *  ignores this — it's bound to search-capable models. Unset = the
   *  adapter's own default. */
  model?: string
}

// ── Continuity-chain config (v1.0.189+ — continuity-chain pipeline) ─────
//
// Per-episode settings for the continuity-chain format, set on the Character
// Sheet page and persisted to `<episode_dir>/continuity.json`. Consumed by the
// density-paced scene planner (CC3) and the sequential renderer (CC4).

/** v1.0.260 — "Visual Recipe": a composition spec the Prompt Director uses to
 *  rewrite every scene's planner prompt into an explainer layout — the actual
 *  subject framed as the centerpiece, with the guide character at the side
 *  pointing at it, expression matched to the beat. Lives in continuity.json
 *  (per-episode) and is savable as a preset for reuse across episodes. The
 *  layout itself is anchored at render time by the composition template image
 *  (img2img-references/composition.png) when references.composition is on. */
export interface VisualRecipe {
  /** Master switch — when off, the Director is a no-op and scenes render from
   *  the planner's prompt as before. */
  enabled: boolean
  /** v1.0.263 — composition style:
   *   'guide' — explainer: the subject is framed and a recurring GUIDE character
   *             stands at the side pointing at it, expression per beat.
   *   'scene' — scene-accurate: NO recurring character. Each scene depicts its
   *             real subject; generic anonymous figures appear only when the
   *             narration involves a person, otherwise none. (guide_character_id
   *             + emotion fields are ignored in this mode.) */
  mode: 'guide' | 'scene'
  /** Natural-language composition directive (the framing, where the guide
   *  stands, the look). Woven into every rewritten prompt. */
  directive: string
  /** Which anchor character plays the side "guide / explainer". Empty = first
   *  anchor character. Ignored when mode is 'scene'. */
  guide_character_id: string
  /** 'auto' — the Director derives each scene's emotion from the narration
   *  beat; 'fixed' — every scene uses `fixed_emotion`. Per-scene overrides
   *  (ScenePlanEntry.emotion_locked) win over both. */
  emotion_mode: 'auto' | 'fixed'
  /** The single emotion used when emotion_mode is 'fixed'. */
  fixed_emotion: string
}

export interface ContinuityConfig {
  schema_version: 1
  /** Project character IDs that anchor every scene's look in this episode.
   *  Their reference images feed the img2img 'characters' reference source. */
  anchor_character_ids: string[]
  /** Also use the per-episode uploaded sheet (img2img-references/master.png)
   *  as a reference for every scene. */
  use_episode_sheet: boolean
  /** User-set pacing guardrails (seconds). The paced planner cuts scenes so
   *  each lands within [min_sec, max_sec]; the LLM picks where to cut, denser
   *  where the narration is busy ("feels live"). */
  pacing: { min_sec: number; max_sec: number }
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
     *  composition.png): the explainer LAYOUT (subject framed centrepiece +
     *  guide character at the side) every scene is structured against. Attached
     *  as an img2img reference on every scene when on. */
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
  /** v1.0.260 — explainer composition recipe (guide-at-side + framed subject).
   *  Drives the Prompt Director; absent/disabled = scenes render from the bare
   *  planner prompt as before. */
  recipe?: VisualRecipe
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
  /** Reason the LLM picked this scene boundary, used as a hint in
   *  the Scene Plan UI ("Topic shift to <X>", "Named entity intro:
   *  <Y>"). Optional. */
  boundary_reason?: string
  /** v1.0.260 — the planner's ORIGINAL subject-only prompt, preserved when the
   *  Prompt Director recomposes `visual_prompt` into the explainer layout
   *  (subject-in-frame + guide-at-side). Lets the recipe be re-applied or
   *  reverted idempotently. Absent on plans made before the recipe ran — treat
   *  `visual_prompt` as the raw source in that case. */
  visual_prompt_raw?: string
  /** v1.0.468 — image-to-video motion instruction for animating this scene's
   *  generated image into a short clip. Generated cohesively with
   *  `visual_prompt` (the planner sees the image prompt as context) and biased
   *  by the motion-intensity level (see MOTION_SPECS). Slight motion only —
   *  slow camera drift / gentle ambient / subtle script-driven subject motion.
   *  User-editable in Scene Plan + Scene Review. Phase 1: text only; the clip
   *  itself (Phase 2) will be generated from image_path + this prompt. */
  motion_prompt?: string
  /** v1.0.470 — Phase 2: path to the animated clip (mp4) rendered from
   *  `image_path` + `motion_prompt` via an image-to-video model. Written by the
   *  scene-clip generator into the "11 Video Assets" folder. Absent until the
   *  scene is animated. */
  clip_path?: string
  /** v1.0.470 — the `motion_prompt` value the current `clip_path` was rendered
   *  from. If it later differs from `motion_prompt` (user re-prompted), the clip
   *  is STALE — Scene Review flags it, mirroring `rendered_prompt` for images. */
  rendered_motion_prompt?: string
  /** image_version used as the clip's first frame; enables source-image stale checks. */
  clip_source_image_version?: string
  /** Motion Review decision. New clips start as `pending`; the operator can
   *  approve the clip or intentionally keep the still. Missing means a legacy
   *  pre-review clip and remains accepted for backward compatibility. */
  motion_choice?: 'pending' | 'clip' | 'still'
  /** v1.0.260 — the guide character's expression for this scene (e.g. curiosity,
   *  wonder, care, concern), auto-derived by the Prompt Director from the beat
   *  and user-overridable in the Scene Plan / Scene Review UI. */
  emotion?: string
  /** v1.0.260 — true when the user hand-set `emotion`; the Director keeps that
   *  value on the next apply instead of re-deriving it. */
  emotion_locked?: boolean
  /** v1.0.336 — what this scene depicts (see SceneType). The continuity
   *  renderer uses it to decide whether the anchored guide character appears.
   *  Set by the planner; user-overridable in Scene Review. Absent on plans made
   *  before this field → renderer treats the scene as 'character' (prior
   *  behaviour: the guide appears everywhere). */
  scene_type?: SceneType
  /** v1.0.336 — true when the user hand-set `scene_type` in Scene Review; a
   *  re-plan / re-classify keeps their choice instead of overwriting it. */
  scene_type_locked?: boolean
  /** Creative interpretation assigned before the visual-prompt pass. This is
   * independent of scene_type and is retained by missing-prompt repairs. */
  creative_strategy?: SceneCreativeStrategy
}

export interface ScenePlan {
  schema_version: 1
  /** Last time any plan content was updated. ISO8601. */
  generated_at: string
  /** When the deterministic timeline was built. Prompt passes do not change
   * this, so the UI can distinguish rebuilding from prompt progress. */
  timeline_built_at?: string
  /** Model id used for the planner pass. */
  planner_model?: string
  /** Stitched SRT filename this plan was built against. Drift-detection
   *  in the Scene Plan UI compares this to the current stitched SRT. */
  source_stitched_srt?: string
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
  /** Last durable Hub Chat batch IDs, useful for support and recovery. */
  visual_prompt_batch_id?: string
  motion_prompt_batch_id?: string
  /** Exact creative setup used by the visual-prompt pass. Stored with the plan
   * so retries remain reproducible even after the active preset changes. */
  creative_direction?: SceneCreativeDirection
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
  /** v1.0.193 (continuity-chain) — density pacing guardrails. When set, the
   *  planner segments scenes to fit [min_sec, max_sec] (the user's per-episode
   *  band from continuity.json) and cuts denser on busy passages for a "live"
   *  feel, instead of leaning on target_scene_count. */
  pacing?: { min_sec: number; max_sec: number; mode?: 'live' }
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
   *   'auto'  (default) — picks based on the model: local `lmstudio:*`
   *           models get small windows (10 scenes), cloud models get full
   *           windows (30 scenes).
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
   * Frontend exposes 'two-pass' only when an `lmstudio:*` model is
   * selected — cloud users have no reason to take the per-scene
   * request-overhead hit, and single-pass cross-scene cohesion is better
   * with cloud-grade models that can hold all 30 scenes in context.
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
   * input. Frontend dropdown maps: Minimal=0/0, Standard=2/1, Rich=3/2.
   */
  neighbor_context_back?: number
  neighbor_context_forward?: number
}
