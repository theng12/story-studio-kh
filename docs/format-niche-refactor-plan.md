# Format ↔ Niche Separation — Architecture Refactor Plan

> Status: **APPROVED** (2026-06-07). Phase A to begin as a dedicated, focused effort.
> This is the biggest structural change in the codebase. Read this whole doc before starting.

## The decision

Today **format** and **niche** both carry content, which conflates two independent things and
makes the format list confusing (3 near-duplicate "narration" formats). We're splitting them cleanly:

- **FORMAT = presentation only** — *how the video is built and assembled*: scene mechanism
  (`visualSource`), pipeline shape, chapter/length/scene-count structure, narrator-style picker,
  video/audio/merge defaults, aspect ratio, section labels, thumbnail layout. **Says nothing about
  what the content is.**
- **NICHE = all content** — *what the video says and how it feels*: ideas voice, vocabulary,
  emotional/pacing arc, script voice, title/logline rules, visual style mood, metadata voice,
  recency. Sleep → calm/slow/gentle; Historical → facts/sources/dates; Prayer → devotional; etc.

**User's stance on migration:** break existing projects if needed — get the architecture right
first, adapt projects/assets afterward. Correctness of the foundation > avoiding short-term breakage.

## Key finding (why this is feasible, not a rebuild)

The machinery already exists:
- `applyNicheToFormat()` (`electron/server/services/format-loader.ts:428-594`) already overlays
  niche content onto a format.
- **Every generator already reads the niche-MERGED format** (ideas/script/metadata/image-prompts).
  No consumer reads format and niche separately — they read the merged result.
- The `Niche` schema (`types.ts:633-876`) is already rich: vocabulary, scriptContext, scriptStructure
  (chapter count / pacing arc / additional rules), title/logline/theme rules, metadataDescription,
  visualStyleSheet, recencyAvoidance, referenceImages.

So the refactor is a **data migration + a polarity flip**, not new plumbing:
1. Strip content fields out of the 6 format JSONs → leave presentation shells.
2. Move that content into niche JSONs (schema already supports most of it; extend where needed).
3. Flip `applyNicheToFormat` from "niche AUGMENTS format content" to "niche PROVIDES content into a
   presentation-only format shell" (with neutral fallbacks when no niche is set).

## Target format list (6 → 4, presentation-only)

| Format | Mechanism (presentation only) | Absorbs |
|---|---|---|
| **Scenes** | AI scenes. `sceneAlignment: 'chapter'` (even distribution) or `'sentence'` (transcript-timed). Research + Character optional toggles. | narrative + narrated-scenes + narration-synced |
| **Listicle** | Independent chapters (`chaptersIndependent: true`, parallel expansion), badge visuals | listicle |
| **Continuity** | img2img character-locked sequential render | continuity-chain |
| **Stock Footage** | continuous narration over B-roll library pool | stock-footage |

Notes:
- **Narrative is scrapped** — "even distribution" is just `Scenes` with `sceneAlignment: 'chapter'`
  (or a fixed pacing band, e.g. 30s/30s).
- **Narration-synced merges into Scenes** — fiction-vs-factual is a NICHE difference; Research is an
  optional toggle, not a separate format.
- A merged `Scenes` format needs a new `sceneAlignment: 'chapter' | 'sentence'` presentation field
  to replace today's implicit (narrative) vs explicit (narrated/synced) split.

## Field split (from the full audit)

**FORMAT keeps (presentation):**
`id, name, description, builtin, schemaVersion, visualSource, sceneAlignment (NEW),
script.defaultChapterCount, script.chapterCountRange, script.defaultLengthMinutes,
script.lengthMinutesRange, script.durationPresets, script.defaultWordsPerMinute (?, see ambiguous),
script.narratorStyles (IDs + picker structure only), script.defaultNarratorStyleId,
script.defaultPerspective, script.chaptersIndependent, script.sectionLabel, script.videoDefaults,
script.audioDefaults, script.audioMergeDefaults, script.introDefaults,
imagePrompts.purposeNote, imagePrompts.characterReferenceMode, imagePrompts.recommendedAspect,
imagePrompts.alignment, imagePrompts.defaultScenesTotalRange, imagePrompts.defaultThumbnails,
imagePrompts.thumbnail.defaultTextStyle, imagePrompts.thumbnail.defaultFontStyle,
metadata.purposeNote, metadata.tagsContext, metadata.defaultMaxChars, metadata.defaultTitleCount,
metadata.defaultTitleMaxLength, metadata.defaultTagCount, metadata.defaultStarterTemplate`

**NICHE takes (content):**
`idea.systemPromptRole, idea.audienceDefault, idea.moodVocabulary, idea.themeVocabulary,
idea.genreVocabulary, idea.keywordVocabulary, idea.guidanceText, idea.exampleIdeas,
idea.titleShapeRules, idea.titleLengthRange, idea.loglineShapeRules, idea.loglineSentenceRange,
idea.themeShapeRules, idea.themeCountRange, idea.structuralVariety,
script.systemPromptRole, script.additionalRules, script.pacingArc, script.closingHint,
imagePrompts.visualStyleHint, imagePrompts.defaultStyleTag, imagePrompts.thumbnail.conceptGuidance,
imagePrompts.thumbnail.compositionRules, imagePrompts.thumbnail.moodKeywords,
imagePrompts.thumbnail.avoid, metadata.titleStyleHint, metadata.titleHookRules,
metadata.tagsHookRules, metadata.broadKeywords, metadata.youtubeDescriptionStructure,
metadata.descriptionShape`

**AMBIGUOUS / SPLIT (decide during Phase A):**
- `script.narratorStyles`: picker structure + IDs → FORMAT; the human descriptions → NICHE.
- `script.defaultWordsPerMinute`: leans content (sleep 122, explainer 155, prayer 130) → likely NICHE,
  but it drives word-count math → keep a FORMAT fallback.
- `script.defaultChapterCount` / `chapterCountRange`: lean PRESENTATION (video segmentation), but
  niche already overrides them via `scriptStructure` — keep FORMAT default + NICHE override.
- `productionStandardsAddendum`: structure FORMAT; any writing-rule text → NICHE.

## Phasing

### Phase A — Architecture flip (foundational)
- Add `sceneAlignment` to the Format schema; create the merged **Scenes** format shell.
- Strip content from all 6 format JSONs → 4 presentation shells (Scenes, Listicle, Continuity, Stock Footage).
- Rework `applyNicheToFormat`: format provides shape; niche provides ALL content; neutral fallback
  content when a project has no niche (so a format-only project still produces *something* sane).
- Update pipeline.vue / dashboard.vue / useProjectFlow.ts / VideoPipelineTabs.vue for the 4-format set
  (collapse the visualSource handling: scene-images + narrated-scenes + timestamp-driven → one "Scenes"
  with sceneAlignment deciding the chain).
- Backend tests for the new merge polarity + each format shell + fallback path.

### Phase B — Niche library buildout
- Author real content niches carrying the content lifted from old formats:
  Sleep (from narrative/narrated content), Historical/Explainer (from narration-synced + history-narration),
  Prayer/Devotional (from stock-footage content), Hustle/POV (from continuity-chain content),
  Listicle-voice (from listicle content), plus the existing 12 niches re-homed.
- Each niche becomes a COMPLETE content profile (not just an overlay).

### Phase C — Migration + UI
- Format picker → 4 presentation options with clear "how it's built" descriptions.
- Niche picker → promoted to the primary CONTENT chooser (it now decides voice/emotion/vocab).
- Project migration: assign a niche to every project; break-and-adapt is acceptable. Provide a clear
  "this project needs a niche" surfacing rather than silent wrong output.
- The unified video-assembly wizard (separate track, tasks #23-26) proceeds in parallel.

## Migration surface (what becomes stale)
- `project.json`: `format_id` (4 of the 6 ids disappear — narrative/narrated-scenes/narration-synced),
  `format_overrides` (may now belong in niche), `niche_id` (becomes mandatory-ish), `content_mode`.
- `config.json`: `recency_log` (keyed by niche label — survives if labels stable).
- Chunked sidecar `generation_params`: immutable snapshots — old episodes keep their frozen state, safe.

## Files to touch (Phase A core)
- `electron/server/models/types.ts` — Format + Niche schema (add sceneAlignment; possibly move fields).
- `electron/server/formats/*.json` — strip to shells; delete narrative/narrated-scenes/narration-synced,
  add `scenes.json`.
- `electron/server/services/format-loader.ts` — `applyNicheToFormat` polarity flip + neutral fallback.
- `electron/server/niches/*.json` — receive migrated content (Phase B mostly).
- `frontend/pages/projects/[slug]/pipeline.vue`, `layouts/dashboard.vue`,
  `composables/useProjectFlow.ts`, `components/VideoPipelineTabs.vue` — 4-format visualSource handling.
- Generators (ideas/script/metadata/image-prompts) — mostly unchanged (they read merged format), but
  audit the fallback path when no niche is set.

## Parallel track (independent of this refactor)
- Unified video-assembly wizard — tasks #23-26 (assets-check / intro / effects / subtitles / export
  for the transcript flow, + format/flow overview as wizard step 1). Still needed regardless.
