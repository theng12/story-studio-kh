# Story Studio KH — Format & Niche Contract

The schema reference for formats and niches, plus the **reverse index** showing which code reads which field. Use this when adding a new format, modifying an existing one, or debugging why a niche's vocab isn't landing where you expect. Last reviewed: 2026-05-21 (v1.0.114).

For the big picture see [overview.md](overview.md).

---

## Quick reference: existing formats

| File | id | visualSource | defaultChapterCount | Avg length |
|---|---|---|---|---|
| `sleep-story.json` | `sleep-story` | scene-images (default) | 10 | 45 min |
| `adventure.json` | `adventure` | scene-images | 10 | 45 min |
| `documentary.json` | `documentary` | scene-images | 8 | 30 min |
| `comedy.json` | `comedy` | scene-images | 6 | 25 min |
| `educational.json` | `educational` | scene-images | 8 | 30 min |
| `kids-fairytale.json` | `kids-fairytale` | scene-images | 6 | 20 min |
| `true-crime.json` | `true-crime` | scene-images | 8 | 45 min |
| `listicle.json` | `listicle` | scene-images | 10 | 30 min |
| `bound-explainer.json` | `bound-explainer` | scene-images | 6 | 12 min |
| `broll-narration.json` | `broll-narration` | **broll** | 1 | 10 min |

## Quick reference: existing niches

| File | id | Pairs well with | Tracks scripture? |
|---|---|---|---|
| `animals.json` | animals | bound-explainer | no |
| `plants.json` | plants | bound-explainer, listicle | no |
| `insects.json` | insects | bound-explainer | no |
| `fungi.json` | fungi | bound-explainer, listicle | no |
| `prayer.json` | prayer | broll-narration | yes (script + metadata) |
| `devotional.json` | devotional | broll-narration | yes |
| `preaching.json` | preaching | broll-narration | yes |
| `mindfulness.json` | mindfulness | broll-narration | no |
| `motivation.json` | motivation | broll-narration | no |
| `philosophy.json` | philosophy | broll-narration, documentary | no |
| `psychology.json` | psychology | educational, listicle | no |
| `history-narration.json` | history-narration | educational, documentary | no |

---

## The Format interface

Defined in `electron/server/models/types.ts`. Every format JSON declares these fields:

| Field | Type | Required? | Purpose |
|---|---|---|---|
| `id` | string | yes | Stable identifier. Used as `format_id` in project.json. Once published, never rename. |
| `name` | string | yes | Display name in the format picker |
| `description` | string | yes | One-paragraph purpose |
| `builtin` | boolean | yes | `true` for shipped formats. User-custom formats default `false` |
| `schemaVersion` | 1 | yes | Increment if breaking changes happen |
| `idea` | `IdeaFormat` | yes | Idea generation config — see below |
| `script` | `ScriptFormat` | yes | Narration generation config — see below |
| `imagePrompts` | `ImagePromptFormat` | yes | Scene image generation config (still required for broll formats even though unused — defaults are inert) |
| `metadata` | `MetadataFormat` | yes | YouTube metadata config |
| `productionStandardsAddendum` | string | optional | Format-specific style guidelines appended to the project's production standards |
| `visualSource` | `'scene-images' \| 'broll'` | optional (default `scene-images`) | **THE PIPELINE GATE.** Determines whether video assembly uses generated stills (scene-images) or stock footage (broll) |

### Nested `idea` (IdeaFormat)

- `systemPrompt` — base system prompt for idea generation
- `vocabPools` — { mood, theme, genre, keyword } arrays merged with niche vocab
- `titleShapeRules`, `loglineShapeRules`, `themeShapeRules` — generation constraints
- `exampleIdeas` — few-shot exemplars (replaced with niche `exampleTopics` when a niche is set)

### Nested `script` (ScriptFormat) — the biggest subsection

- `defaultChapterCount` — episode length in chapters
- `pacingArc` — { introWords, perChapterWords, conclusionWords }
- `narratorStyles` — array of style presets the picker offers
- `rules` — generation constraints (always-rules + never-rules)
- `audioDefaults` — { voiceId, stability, similarity, speed, model }
- `videoDefaults` — { secondsPerScene, transitionType, transitionDurationSec, aspectRatio, defaultTimelineClipDurationSeconds }
- `introDefaults` — script generator's intro/hook config
- `systemPromptRole` — text added to the system prompt to set narrator persona
- `idea.guidanceText` — appended to the user prompt (sets "what good output looks like")

### Nested `imagePrompts` (ImagePromptFormat)

- `visualStyle` — base style string (e.g. "soft watercolor", "evidence-board photoreal")
- `scenesPerChapter` — controls scene-count math
- `characterReferenceMode` — `'append'` / `'inline'` / `'none'`
- `alignment` — `'sentence-aligned'` / `'paragraph-aligned'` / `'paced'`

### Nested `metadata` (MetadataFormat)

- `titleRules` — title generation constraints (length, capitalization, hooks)
- `tagRules` — tag generation constraints (count, broad vs niche)
- `descriptionTemplate` — structural template (intro, body, CTA, hashtags)
- `broadKeywords` — always-include tag pool

---

## The Niche interface

Niches are **overlays**. They don't run their own pipeline; they merge into a format at runtime via `applyNicheToFormat()`. Every niche JSON declares:

| Field | Type | Required? | Purpose |
|---|---|---|---|
| `id` | string | yes | Stable identifier (used as `niche_id` in project.json) |
| `name` | string | yes | Display name |
| `description` | string | yes | One-paragraph purpose & subject domain |
| `builtin` | boolean | yes | Same convention as formats |
| `schemaVersion` | 1 | yes | Same |
| `tagline` | string | optional | Short tagline for card display |
| `exampleTopics` | string[] | yes | Subject strings (e.g. "Venus Flytrap", "Komodo Dragon"). **Replaces format's `exampleIdeas` when a niche is set** |
| `vocabulary` | `NicheVocabulary` | optional | { mood, theme, genre, keyword } pools merged with format vocab |
| `visualStyleSheet` | string | optional | Long-form style instructions appended to image prompts. **Irrelevant for broll formats** |
| `defaultStyleKeywords` | string[] | optional | Auto-added style tags |
| `negativePromptAddendum` | string | optional | Negative-prompt rules |
| `referenceImages` | `NicheReferenceImage[]` | optional | Pre-built reference image pack |
| `youtubeTagsHint` | string[] | optional | Tags merged into metadata's tag pool |
| `audienceHint` | string | optional | One-line audience descriptor (e.g. "Christians seeking short guided prayers") |
| `scriptContext` | string | optional | Context line injected into script generator's system prompt |
| `titleShapeRules` | string[] | optional | Niche-level title rules (overrides format) |
| `titleLengthRange` | `[number, number]` | optional | Word-count range |
| `loglineShapeRules` | string[] | optional | Logline rules |
| `loglineSentenceRange` | `[number, number]` | optional | Sentence count |
| `themeShapeRules` | string[] | optional | Theme keyword rules |
| `themeCountRange` | `[number, number]` | optional | Theme count |
| `structuralVariety` | `'free' \| 'vary-all' \| 'vary-subject-only'` | optional | Title variety constraint |
| `scriptStructure` | object | optional | Script overrides — `{ defaultChapterCount, chapterRules, pacingArc }` |
| `metadataDescription` | object | optional | Description template override — `{ template, voiceGuidance, closingBenediction }` |
| `recencyAvoidance` | object | optional | Cross-episode dedup — `{ patternRegex, lookback, scopes: ['script' \| 'titles' \| 'image_prompts' \| 'metadata'], steerToward, kind }` |
| `defaultFormatId` | string | optional | When project picker shows niche-first, this format auto-selects |
| `defaultThumbnailTemplateId` | string | optional | Auto-select this thumbnail template for the project |

---

## The merge model: `applyNicheToFormat`

Defined in `electron/server/services/format-loader.ts`. Conceptual flow:

```
formatClone = deep clone of format
if niche:
  formatClone.idea.vocabPools = merge(formatClone.idea.vocabPools, niche.vocabulary)
  formatClone.idea.exampleIdeas = niche.exampleTopics  // REPLACE
  formatClone.idea.titleShapeRules = niche.titleShapeRules ?? formatClone.idea.titleShapeRules
  formatClone.script.systemPromptRole = niche.scriptContext + formatClone.script.systemPromptRole  // PREPEND
  formatClone.script.defaultChapterCount = niche.scriptStructure?.defaultChapterCount ?? formatClone.script.defaultChapterCount
  formatClone.imagePrompts.visualStyle += niche.visualStyleSheet  // APPEND
  formatClone.metadata.broadKeywords = [...formatClone.metadata.broadKeywords, ...niche.youtubeTagsHint]
  formatClone.metadata.description.template = niche.metadataDescription?.template ?? formatClone.metadata.description.template
  ...
return formatClone
```

The merged result is the "effective format" — everything downstream sees this, not the raw format.

**Endpoint:** `GET /api/projects/:slug/effective-format` returns this merged object. The frontend uses it for everything format-related (page defaults, sidebar gating, etc.).

---

## The reverse index: which code reads which field

When a field doesn't seem to be doing anything, find it in this table to know where to look.

### Format fields

| Field | Read by |
|---|---|
| `visualSource` | `frontend/layouts/dashboard.vue` (sidebar gating), `frontend/pages/projects/[slug]/video-assembly.vue` (wrong-pipeline banner), `frontend/pages/projects/[slug]/video.vue` (same), `frontend/pages/projects/[slug]/broll.vue` (mount condition) |
| `idea.systemPrompt` | `electron/server/generators/episode.ts` (idea step) |
| `idea.vocabPools` | Same |
| `idea.titleShapeRules` | Same |
| `script.defaultChapterCount` | `electron/server/generators/script-*.ts`, `frontend/pages/projects/[slug]/scripts.vue` (mismatch banner) |
| `script.pacingArc` | Script generator |
| `script.audioDefaults` | `electron/server/generators/audio.ts`, `frontend/pages/projects/[slug]/audio.vue` |
| `script.videoDefaults.secondsPerScene` | `frontend/pages/projects/[slug]/video-assembly.vue:applyVideoFormatDefaultsIfNoPreset` |
| `script.videoDefaults.transitionType/Duration` | Same |
| `script.videoDefaults.aspectRatio` | `frontend/pages/projects/[slug]/video.vue:applyVideoFormatDefaultsIfNoPreset` |
| `script.videoDefaults.defaultTimelineClipDurationSeconds` | Video-assembly page (broll uses 600s, sleep-story 7200s) |
| `script.introDefaults` | Intro generator + script editor |
| `script.systemPromptRole` | Script + chapter generators |
| `imagePrompts.visualStyle` | `electron/server/generators/image-prompts.ts` |
| `imagePrompts.scenesPerChapter` | Same |
| `imagePrompts.characterReferenceMode` | Same |
| `metadata.titleRules` | `electron/server/generators/metadata.ts` |
| `metadata.tagRules` | Same |
| `metadata.descriptionTemplate` | Same |
| `metadata.broadKeywords` | Same |
| `productionStandardsAddendum` | `electron/server/services/standards-merger.ts` |

### Niche fields

| Field | Read by |
|---|---|
| `exampleTopics` | `applyNicheToFormat` (replaces format's `exampleIdeas`) |
| `vocabulary` | Same (merges into format vocab pools) |
| `visualStyleSheet` | `image-prompts.ts` generator (appended to prompts) |
| `defaultStyleKeywords` | Image-prompts generator |
| `negativePromptAddendum` | Image generators |
| `referenceImages` | Image-prompts generator + character library |
| `youtubeTagsHint` | Metadata generator |
| `audienceHint` | Metadata generator + script generator |
| `scriptContext` | `applyNicheToFormat` (prepends to format's `script.systemPromptRole`) |
| `titleShapeRules` | Idea generator (overrides format) |
| `loglineShapeRules` | Same |
| `themeShapeRules` | Same |
| `structuralVariety` | Idea generator |
| `scriptStructure` | Script generator (overrides `defaultChapterCount`, chapter rules) |
| `metadataDescription` | Metadata generator |
| `recencyAvoidance` | `electron/server/services/recency-tracker.ts` (cross-episode dedup) |
| `defaultFormatId` | Project picker — auto-selects format when niche picked first |
| `defaultThumbnailTemplateId` | Compose dialog — auto-selects template |

---

## Adding a new format: checklist

1. **Create the JSON** at `electron/server/formats/<id>.json`
2. **Set `visualSource`** explicitly (don't rely on default). Decide whether this format uses generated images or stock footage
3. **Fill in all required fields** (idea, script, imagePrompts even for broll, metadata). Use an existing format as a starting template
4. **Decide chapter count + pacing arc** — `defaultChapterCount × perChapterWords` should produce a script that, at ~150 WPM TTS, lands in your target video length
5. **Test the idea step** — does the LLM produce coherent titles/loglines with your format's prompts? Iterate on `idea.systemPrompt` and `vocabPools`
6. **Test the script step** — does pacing arc produce the expected length? Adjust `perChapterWords`
7. **If `visualSource: 'broll'`**:
   - Test the broll page works (selection + assemble)
   - You don't need to test image-prompts or scene-images — they won't run
8. **If `visualSource: 'scene-images'`**:
   - Test image-prompts produce coherent scenes
   - Test the video-assembly page renders correctly
9. **Audit format-aware code** (see [pipeline-audit.md](../history/pipeline-audit.md)) — does any code path need a new branch for this format?
10. **Document in this file's quick-reference table** (top of doc)

---

## Adding a new niche: checklist

1. **Create the JSON** at `electron/server/niches/<id>.json`
2. **`exampleTopics`** — at least 15-20 diverse subjects. These become the format's example ideas
3. **`vocabulary`** — domain-specific mood/theme/keyword pools (10+ each)
4. **`scriptContext`** — one-paragraph voice/audience instruction. Will be prepended to the format's system prompt
5. **`audienceHint`** — one sentence: "X seeking Y"
6. **If subject domain has recurring elements** (e.g. scripture refs for prayer, species names for animals):
   - Add `recencyAvoidance.patternRegex` to detect them
   - Set `recencyAvoidance.scopes` — typically `['script']`, add `'metadata'` if descriptions also need dedup
   - Set `lookback` (how many episodes back to remember)
   - Add `steerToward` (a list to bias generation toward when the recency list is long)
7. **`defaultFormatId`** — which format pairs best?
8. **Optionally**: thumbnail-template recommendations via `defaultThumbnailTemplateId`
9. **Test idea + script generation** with this niche on its default format
10. **Document in the quick-reference table** above

---

## Scene-plan timing contract (v1.0.521)

An episode that has a `scene_plan.json` (Scene Plan page) gets **plan-exact order and timing in BOTH assemblers**:

- **Timestamp assembler** (`generators/timestamp-video-assemble.ts`, Scene Review → Assemble / `timestamp_assemble` pipeline step): always plan-exact — one image/clip per scene, `end_sec − start_sec` windows, hard-fail on missing images, window-anchored crossfades.
- **Video Assembly page** (`generators/video.ts`, `video_assembly` job): when the scene pool is the Scene Plan renders and **every** request scene matches a plan scene id (matched by id / image basename, not absolute path), the render enters **plan-strict mode** — plan order, exact windows, no recycling/shuffle/chapter-align, no scene reuse, crossfades anchored on plan boundaries (prepared clips carry a +transition tail so dissolves never shorten a scene). A narration longer than the plan is covered by the post-audio fade/hold tail, never by repeating scenes.

**Recycling, shuffle, seconds-per-scene, and chapter alignment apply ONLY to classic / combined / image-pool / broll pools** — pools whose filenames never match plan scene ids, so plan-strict cannot trip on them. Switching the pool selector to Classic/Combined is the explicit opt-out back to recycled pacing. The ordering contract is pinned by `__tests__/video-plan-order.test.ts`; the decoder-safe stills concat by `__tests__/timestamp-still-concat.test.ts`.

**Re-sync after re-generating audio (v1.0.523):** if the audio is re-generated / subtitles re-stitched *after* the plan was made, the plan's start/end drift out of sync with the voice (e.g. a stale intro-skip offset → a uniform 28s shift). **Scene Plan → "🎯 Reconcile timings"** (`POST …/scene-plan/:ep/reconcile-timings`, `reconcilePlanToSubtitles` in `services/scene-planner.ts`) re-anchors every scene to the current stitched SRT by **matching its transcript text**, resetting start/end to the real cue times — preserving every scene id, image, and prompt (no re-plan, no forfeited images). Unmatched scenes are interpolated between matched neighbours and reported. Pinned by `__tests__/reconcile-plan-subtitles.test.ts`. Repair-coverage heals *gaps*; reconcile heals *drift* — reconcile first when the whole plan is shifted.

**Audio-coverage contract (v1.0.522):** every second of narration must have a scene. Plans are generated (and one-click repaired via Scene Plan → "Repair coverage" / `POST …/scene-plan/:ep/repair-coverage`) to full coverage against the **ffprobed merged audio**: internal gaps close by holding the preceding scene (starts never move — they anchor sync), the last scene extends to the real audio end, and `total_duration_sec` is the audio duration, not the last SRT cue. Both assemblers **refuse to render** when more than `COVERAGE_FAIL_SEC` (2s) of narration is uncovered — the timestamp assembler over the whole timeline, video.ts plan-strict with a head-gap exemption when intro/title content covers it (intro-skip). A ≤2s remainder is absorbed by holding scenes to the next scene's start / the audio end, so video length always equals audio length. Math lives in `services/scene-planner.ts` (`computePlanCoverage` / `repairPlanCoverage`), pinned by `__tests__/scene-plan-coverage.test.ts`.

---

## Common pitfalls

- **Forgetting to set `visualSource`** — defaults to `scene-images`. If your format is meant for stock footage, you MUST set `'broll'` explicitly, otherwise the user lands on the wrong pages
- **Treating niches as alternatives to formats** — niches are OVERLAYS. Every project has BOTH a format AND a niche
- **Hardcoding paths to `sleep-story`** — `DEFAULT_FORMAT_ID = 'sleep-story'` exists as a fallback in `format-loader.ts` but should never appear in user-facing code paths. If you see it, the resolution chain broke
- **Modifying built-in JSON in user library** — built-in formats/niches live in `electron/server/{formats,niches}/`. User-custom formats go into `{PROJECTS_ROOT}/.formats/` (forked copies). Don't write to the bundle path
- **Niche overriding pipeline choice** — niches CAN override script structure, metadata templates, etc. but they CANNOT change `visualSource`. That's format-level by design
