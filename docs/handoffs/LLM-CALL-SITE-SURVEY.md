# LLM call-site survey — what each Story Studio request asks for, and whether it's right

**Read-only survey. No code was changed.** Purpose: GenStudio is being changed so the
output shape (plain writing vs. machine-readable JSON) becomes a per-request choice
instead of being forced to JSON for everything. This document lists every place Story
Studio asks a language model for something, so the owner can decide what each call
site should ask for once that choice exists.

**How to read "needs":**
- **prose** — ordinary writing meant for a human to read (a chapter, a description, a caption).
- **structured** — labelled fields a program reads (a list of prompts, a set of scenes, a JSON object).
- **mixed / unclear** — genuinely ambiguous; flagged rather than guessed.

**How correctness was judged:** by what the code actually *does* with the answer —
`JSON.parse`/schema validation means it needs structured data; writing the text straight
to a file or showing it to the user means it needs prose — not by what the prompt text
asks for in English. Prompts and code disagree in several places below; those are the
real risk.

**Mechanism found in the code today:** Story Studio's own client
(`electron/server/lib/genstudio-client.ts`) already has a per-request `outputContract`
field (`{ mode: 'prose' }` / `{ mode: 'json_object', schema }` / `{ mode: 'json_schema' }`,
defined in `electron/server/lib/json-output-contract.ts`). **When a call site omits it,
the client defaults to `prose`** (confirmed at `genstudio-client.ts:3752-3753` and
`:3257-3258`). That default is what makes the bug findings below dangerous: several
call sites that actually need structured JSON never declare it, so as soon as GenStudio
starts honoring the per-request shape instead of forcing JSON for everything, those
calls will silently start getting prose back instead of the JSON their own parser
requires.

---

## 1. Call sites that need correction, most likely broken first

| # | Call site (plain English) | File : line | Needs | Currently asks for | Verdict / correction | How the result is consumed |
|---|---|---|---|---|---|---|
| 1 | **Scene Planning** — the core pass that splits narration into timed scenes and writes each scene's `visual_prompt` | `electron/server/services/scene-planner.ts:2069` (`planOneWindow`) | **structured** (a JSON object: `{"scenes":[{start_sec, end_sec, visual_prompt, ...}]}`) | Nothing — `callAi(...)` passes no `outputContract`/`jsonMode`, so it silently defaults to **prose** | **Needs correction.** The prompt text (built in `buildScenePlannerPrompt`, `scene-planner.ts:207-218`) explicitly instructs `"Output JSON schema: {...}"`, and the result is parsed by `parsePlannerJson` (`scene-planner.ts:362+`, does `JSON.parse`). Add `outputContract: { mode: 'json_object' }` (ideally with the schema). This is the highest-risk item in this survey — it is the main scene-planning pass, named by the owner, and it hard-fails (throws) on non-JSON. | `parsePlannerJson(raw)` → `JSON.parse`; feeds `normalizeScenes(...)` |
| 2 | **Style extraction** — "Create Format from sample scripts" (turns 1-3 sample scripts into a full channel Format definition) | `electron/server/routes/projects.ts:114` (route `POST /projects/:slug/formats/from-sample`) | **structured** (one large JSON object matching the Format schema) | Nothing — `callAiWithRetry(...)` has no `outputContract` | **Needs correction.** The prompt (`electron/server/lib/format-extraction-prompt.ts:107-155`) says *"YOUR OUTPUT MUST BE A SINGLE VALID JSON OBJECT... Return ONLY the JSON object"*. Result goes through `parseExtractedFormatJson` (`format-extraction-prompt.ts:163+`), a hard `JSON.parse`. Named explicitly by the owner as a risk area. | `parseExtractedFormatJson(raw)` → `JSON.parse` → saved as the project's Format |
| 3 | **Prompt Director** — rewrites every scene's image prompt to match a saved "Visual Recipe" composition (guide character + framed subject) | `electron/server/generators/prompt-director.ts:193-198` | **structured** (`{"scenes":[{id, prompt, emotion}]}`) | Nothing — `callAi(...)` has no `outputContract` | **Needs correction.** Both system-prompt builders (`buildSystemGuide`/`buildSystemScene`, lines 54-91) end with *"Return ONLY a JSON object, no prose or markdown"*, and the result is parsed by `parseDirectorJson` (lines 43-52), a hard `JSON.parse`. Not named by the owner but is functionally part of scene/image-prompt planning. | `parseDirectorJson(raw)` → `JSON.parse`; overwrites each scene's `visual_prompt` |
| 4 | **Idea generation** — the main "Generate Ideas" button on the Ideas page (titles, loglines, themes) | `electron/server/routes/ideas.ts:600` and `:633` (retry pass) | **structured** (a JSON array of idea objects) | Nothing — `callAiWithRetry(...)` has no `outputContract` | **Needs correction.** Result goes through `parseIdeas` (`ideas.ts:363-372`), which throws `'No JSON array found in AI response'` if it can't locate `[...]`. High-frequency, core feature; not named by the owner but should be. | `parseIdeas(raw)` → `JSON.parse` → `normalizeIdeas` → saved as stored ideas |
| 5 | **Idea Campaign** — batch idea generation tied to a Series Formula / coverage plan | `electron/server/generators/idea-campaign.ts:293` | **structured** (a JSON array of idea objects, keyed by `idea_key`) | Nothing — `callAiWithRetry(...)` has no `outputContract` | **Needs correction.** `parseArray` (`idea-campaign.ts:30-38`) throws if it can't find `[...]`. Same bug class as #4, separate code path. | `parseArray(raw)` → `JSON.parse` → matched against planned assignments |
| 6 | **Metadata template placeholder extraction** — when a project has a channel-locked metadata template, one small call fills in `{topic}`, `{summary}`, `{keywords}` etc. before the template is substituted | `electron/server/generators/metadata.ts:250-252` | **structured** (a JSON object of placeholder → short string) | Nothing — `callAiWithRetry(...)` has no `outputContract` | **Needs correction**, narrower blast radius (only projects using a metadata template hit this path). `buildExtractionPrompt` (`electron/server/lib/metadata-template.ts:72-103`) says *"Return STRICT JSON only"*; `parseExtractionResponse` (lines 110-134) is at least tolerant — on parse failure it silently fills every placeholder with `''` rather than throwing, so today's failure mode is silently blank metadata fields, not a hard error. This is arguably part of the "YouTube finalizer" chain the owner asked about. | `parseExtractionResponse(raw, keys)` → `JSON.parse` (falls back to `{}` on failure) |
| 7 | **Single image/thumbnail prompt regeneration** — the "regenerate just this one prompt" action on the Image Prompts page | `electron/server/routes/image-prompts-edit.ts:156` | **structured** (`{"title":..., "prompt":...}`) | Nothing — `callAiWithRetry(...)` has no `outputContract` | **Needs correction, lower risk.** Prompt (`image-prompts-edit.ts:309-310`) asks for JSON, but `parseSinglePromptResponse` (line 316+) has a graceful fallback: if it can't find `{...}` it treats the *entire raw response* as the prompt text and keeps the old title. So a prose reply degrades to "title unchanged, prompt = whatever the model wrote" rather than failing outright — worse output, not a crash. | `parseSinglePromptResponse(raw, fallback)` — tries `JSON.parse`, else uses raw text as-is |
| 8 | **Image Pool "suggest prompts from a topic"** | `electron/server/routes/broll-project.ts:625` (route `POST /projects/:slug/image-pool/suggest-prompts`) | **structured** (a JSON array of prompt strings) | Nothing — `callAiWithRetry(...)` has no `outputContract` | **Needs correction, lower risk.** System prompt says *"Output ONLY a JSON array of strings"*, but the parser (lines 630-641) already has a deliberate plain-text fallback (splits on newlines, strips bullets/numbering) for exactly this case. Today's failure mode is degraded formatting, not breakage. | Tries `JSON.parse` on a `[...]` slice; falls back to line-splitting |
| 9 | **Vision — thumbnail reference-image analysis** ("describe this reference image's composition") | `electron/server/routes/vision.ts:108-117` | **structured** (one JSON object: composition summary, palette, placement, etc.) | Uses the **deprecated** `jsonObject: true` flag instead of the current `outputContract` field | **Cosmetic correction.** Functionally correct today — `jsonObject: true` still maps to `JSON_OBJECT_OUTPUT_CONTRACT` internally (`genstudio-client.ts:3752-3753`) — but the field is marked `@deprecated` in `genstudio-client.ts:1190-1191` ("Preserved for older JSON Object callers"). Should be migrated to `outputContract: JSON_OBJECT_OUTPUT_CONTRACT` for consistency and so it isn't caught out if the deprecated path is ever removed. | `parseComposition(result.text)` → `JSON.parse` |
| 10 | **Research adapter documentation** — header comment | `electron/server/services/research/genstudio-web.ts:1-13` | n/a (doc-only) | Comment claims *"Today that is `POST /v1/chat/completions`"* is the live default route | **Confirmed wrong**, exactly as flagged. `resolveGenStudioChatTransport`'s actual default (`genstudio-client.ts:1266-1270`, `describeGenStudioChatTransport`) is `'responses'` (`POST /v1/chat/responses`), not `'completions'`. No functional impact — the actual request still goes through `resolveGenStudioChatTransport()` correctly regardless of what the comment says — but the comment is stale and, by its own admission in the next sentence, has already "misled a whole debugging session" once. Worth a one-line fix so it doesn't do it again. | n/a |

---

## 2. Confirmed correct — no action needed

These were checked because the owner listed them, or because the survey encountered
them; all correctly declare (or correctly default to) the shape their consumer needs.

| Call site | File : line | Needs | What it does |
|---|---|---|---|
| Research (model-knowledge mode) | `services/research/genstudio.ts:44-51` | structured | Passes `outputContract: JSON_OBJECT_OUTPUT_CONTRACT` explicitly. **This is the opposite of what the task brief expected to find** — the comment at the call site (line 45-49) says this contract was *just added* ("the model-knowledge adapter now declares the same one" as the web adapter), so whatever prompted the brief's assumption that this was still missing has already been fixed in the code as it stands today. |
| Research (web-search mode) | `services/research/genstudio-web.ts:90-98` | structured | Same contract, correctly passed. Confirmed correct — only the header comment above it is wrong (see §1, row 10). |
| Chapter expansion (narrative + listicle + one-shot repair) | `lib/chunked-narration.ts:1109-1116`, `1155-1157`, `1316-1320` | prose | No `outputContract` set → **correctly** defaults to prose. Output is markdown (`## Chapter NN: Title` blocks) parsed by `parseAndWriteBatch` → `splitNarrationIntoChapters`, never `JSON.parse`. This is the exact "chapter expansion" workflow the owner said failed live — on Story Studio's side it is already asking correctly; the live failure was GenStudio forcing JSON regardless of the (correct, implicit) prose request. |
| Outline generation (the one JSON call chapter expansion depends on) | `lib/chunked-narration.ts:958-962`, via `callForJsonArray` (line 1692+) | structured | Explicitly passes `outlineOutputContract(totalChapters)`. Correct. |
| Thumbnail prompt generation | `generators/image-prompts.ts:492-501` | structured | Explicitly passes `thumbnailPromptsOutputContract(count)`. Correct. |
| Scene Plan prompt-pack regeneration (batch "regenerate these specific scene ids") | `generators/scene-plan.ts:934-945` | structured | Explicitly passes `scenePromptPackOutputContract(sceneIds, kind)`. Correct. Distinct from the main scene-planner window pass (§1 row 1), which is broken. |
| Video prompts | `routes/ai-video.ts:99-107` | structured | Explicitly passes `videoPromptsOutputContract(nClips)`. Correct. |
| Contextual cues | `generators/contextual-cues.ts:140` | structured | Explicitly passes `CONTEXTUAL_CUES_OUTPUT_CONTRACT`. Correct. |
| Metadata: description / titles / tags (both the batch generator and the interactive routes) | `generators/metadata.ts:279-282, 362-363, 405-406`; `routes/scripts.ts:978-980, 1059, 1112` | prose | No `outputContract` → defaults to prose. All three are consumed as plain text (description trimmed as-is; titles/tags split on newlines with numbering stripped). Correct. |
| Narration script / image prompts / YouTube description (legacy `generateEpisode` path, still used by `generateScriptOnly`) | `generators/episode.ts:664-667, 676-679, 963-965` | prose | No `outputContract` → correct default; all three write markdown/plain text straight to docx or a description field. |
| Single-scene visual prompt regeneration | `services/scene-planner.ts:1620` (`generateVisualPromptOnly`) | prose | Correct default; output is cleaned prose (strips fences/quotes) written straight into `scene.visual_prompt`. |
| Single-scene motion prompt regeneration | `services/scene-planner.ts:1682` (`generateMotionPromptOnly`) | prose | Correct default; system prompt itself says *"No JSON... natural prose"*, matching the (implicit) prose request. |
| Legacy narration docx normalizer | `services/docx-normalizer.ts:177-179` | prose | Correct default; output is a full restructured markdown document, parsed by heading regex (`splitNarrationIntoChapters`), never JSON. |
| Audio expression / performance-tag markup (Fish S2) | `services/audio-expression.ts:276-278` | prose | Correct default; returns the narration text with `[tag]` markup inserted, validated by token-diffing against the original, never JSON. |
| Playlist description generator | `routes/upload.ts:157-159` | prose | Correct default; plain text returned as-is. |
| YouTube comment reply drafts | `routes/upload.ts:286`, `lib/reply-drafter.ts` | prose | Correct default; `parseReplyDrafts` splits on blank lines/numbering, never JSON. |

---

## 3. Not currently an LLM call site (owner was unsure — confirmed here)

- **Sound design.** `services/sound-design.ts`, `services/sound-design-resolver.ts`,
  `lib/sound-design-mixer.ts`, `routes/sound-design.ts` — searched fully; no `callAi`,
  no `callChatWithGenStudio`, nothing. Cue placement is rule-based (density/spacing
  settings), not LLM-generated. **Not a current call site**, so nothing to correct here.
- **B-roll stock-footage query direction.** `services/broll-shot-director.ts` has a
  fully-built prompt (`buildShotPrompt`) and a tolerant JSON parser (`parseShotJson`,
  correctly scoped to expect structured output — `{"beats":[{index, queries}]}`), but
  **nothing in the codebase calls `buildShotPrompt`/`parseShotJson`** — grepped for
  every reference outside the file itself and its own tests; none found. This matches
  the file's own header comment: *"Executable direction is fail-closed pending a typed
  GenStudio API."* It's finished code waiting to be wired up, not a live bug. Worth
  knowing about if/when it gets wired in: it already declares the shape correctly
  in its design (would need `outputContract: { mode: 'json_object' }` when connected).
- **YouTube finalizer itself.** `services/youtube-metadata-finalizer.ts` — no LLM call.
  It's deterministic: it computes chapter timestamps from Audio Assembly's measured
  durations and inserts real research-source citations. The LLM-driven parts of the
  "YouTube package" the owner is thinking of are the separate description/title/tags
  calls (§2, correct) and the metadata-template extraction call (§1 row 6, needs
  correction) — the finalizer just stitches deterministic blocks around their output.

---

## 4. Not named by the owner, found by this survey

Everything in §1 rows 3-9 and the correct-but-unlisted rows in §2 (outline generation,
scene prompt-pack regen, video prompts, legacy episode-path image prompts/YouTube
description, single-scene visual/motion regen, docx normalizer, audio expression
markup, playlist description, reply drafts) — none of these were on the owner's
original list. The two most consequential additions:

- **Prompt Director** (§1 row 3) and **Idea generation + Idea Campaign** (§1 rows 4-5)
  are broken in the same way as the named "Scene planning" and "Style extraction"
  items, and are all high-traffic features.

## 5. What could not be fully determined

- **Format extraction (§1 row 2) — schema strictness.** The prompt asks for a JSON
  object matching a large, hand-described Format schema, but `parseExtractedFormatJson`
  does no schema validation beyond "is it valid JSON" — unlike `outputContract`'s
  `json_object` mode, which supports an optional `schema` for local validation
  (`json-output-contract.ts:14-17`). Whether the correction should be a bare
  `{ mode: 'json_object' }` or a full schema (like `outlineOutputContract` /
  `thumbnailPromptsOutputContract` elsewhere) is a design choice, not something the
  code answers on its own.
- **Research's internal shape.** Research's contract is `json_object` overall (correct,
  confirmed), but the object it produces mixes free-text fields (a prose summary) with
  structured ones (claims list, citations, outline) in the same envelope. That's a
  reasonable design — the whole answer is one JSON object either way — but flagging it
  as "mixed" internally in case the eventual per-request shape choice is expected to be
  a single prose/structured toggle rather than "structured envelope with some prose-y
  string fields inside."
- **Whether every hard-fail site in §1 is currently masked by GenStudio always forcing
  JSON.** This survey did not call the API (as instructed) and cannot confirm from
  Story Studio's code alone whether GenStudio's current behavior is "always coerce to
  JSON regardless of what's asked" (which would explain why rows 1-6 haven't visibly
  broken production yet, the same way chapter expansion did) or something narrower.
  That question belongs to GenStudio's own codebase, out of scope here.

---

## Summary for prioritization

Fix, in order: **scene planning's main window pass → style extraction → prompt
director → idea generation → idea campaign → metadata template extraction** (all
missing `outputContract`, all consumed with `JSON.parse` that throws on non-JSON
except the metadata-template one, which silently blanks fields instead). Then the two
lower-risk tolerant-fallback sites (image prompt single regen, image-pool suggest
prompts) for correctness/quality even though they don't currently crash. Then the two
cosmetic items (vision's deprecated `jsonObject` flag, the stale route comment in
`genstudio-web.ts`). Everything else surveyed is already correct.
