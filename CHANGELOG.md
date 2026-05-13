# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.0.88 — 2026-05-14

**Bound-style episode workflow — character continuity + style anchoring**
- New **✨ Describe from image** button on the Character editor. Upload a reference portrait, click describe, and a vision-LLM (Claude Sonnet or GPT-4o, whichever provider key you have configured) drafts a rigid appearance description for you — locked-in wording you can drop into every scene's LLM prompt so the model produces a recognisably-same critter across the whole episode. The biggest single lever for image continuity.
  - Each uploaded reference now renders as a thumbnail card (96×96) inside the editor instead of a filename chip, so the "which image am I describing?" question answers itself.
  - **Vision model picker** dropdown above the Describe button — choose between Claude Sonnet 4.6 (highest fidelity), GPT-4o (cheapest), GPT-4o mini (~$0.002 per call), and others. Models without a configured API key are visible-but-disabled with a "no key configured" hint. Your pick persists in localStorage across editor open/close + reloads.
  - Settings shortcut — when some providers have missing keys, an **Add keys →** link in the picker row opens the App Settings modal in-place (no full-page navigation).

**Character library — episode-code validation**
- Replaced the freeform "Episode codes" text input with a click-to-pick chip row that lists your project's actual episode codes (with titles for context). Eliminates the silent EP001 vs EP0001 footgun that previously hid characters from the Image Prompts / Scripts cast picker.
- Manual typing still supported (for episodes drafted but not yet accepted); a red inline warning fires when a typed code doesn't match any project episode ("Did you mean EP0001?").
- Smart placeholder shows your project's first two episode codes, not the generic EP001/EP002.

**Style Preview card — click-to-zoom, save-to-episode, persist-across-reloads**
- The rendered style sample is now a button — click it to zoom into a full-screen modal (~80vh, scaled to fit, model/aspect/tier metadata shown). Close with backdrop click, ✕ button, or Escape.
- New **💾 Save to episode** button on the preview card — copies the cached preview PNG into the active episode's scene-images or thumbnails folder with a self-describing filename like `EP0001_StylePreview_Scene_gpt-image-2_16-9_1k_v1.png`. Auto-bumps the version suffix on repeat saves so iterations don't overwrite each other. Disabled until an episode is picked.
- Style description textarea now **persists across page reloads + app restarts** via localStorage. Per-(project, kind) keys so the Scene tab and Thumbnail tab keep separate descriptions (each tab can target a different image model with a different natural style).

**Image model catalog — kie.ai slug fixes + i2i routing**
- Fixed Nano Banana 2 slug (`nano-banana-2`, not `google/nano-banana-2`) and refs field name (`image_input`, not `image_urls`). Same model that was 422'ing on every preview attempt now works end-to-end.
- Added image-to-image variant routing: GPT Image 2 (`gpt-image-2-image-to-image`, refs field `input_urls`) and original Nano Banana (`google/nano-banana-edit`, refs field `image_urls`) now auto-swap their model slug + payload shape when references are attached. Text-only generation still hits the cheaper t2i variant.
- New advisory **prompt-char cap** badges everywhere image prompts live:
  - Inline pill beside the model selector ("Prompt cap: ~5,000 chars" for Nano Banana 2 vs "~500" for Seedream)
  - Per-row char counter on every prompt — colour-coded green / yellow / red against the active model's cap so you spot oversized prompts before paying credits
  - **View all caps →** modal reference table (sorted strict-first) on both the Image Prompts and Image Generator pages
- Project config migration — kie.ai provider infrastructure fields (model slug, refs/aspect field names, endpoint, type) now always come from defaults, not from the per-project saved config. When kie.ai changes a slug (as they did with NB2), every existing project picks up the fix on next load. User-customisable fields (label, credits, tiers, prompt_char_cap) still preserve their customisations.
- Custom user-added image models (Settings → Add custom model) carry no cap by default — their counter renders neutral grey ("no documented cap") rather than misleading colours.

**Metadata generator — switched to job queue**
- Clicking "Generate Metadata" now enqueues a `metadata` job instead of blocking on a synchronous LLM call. You can switch episodes mid-job (with the same confirm dialog the other generators use), let the job finish in the background, and come back later to find the metadata sidecar already written.
- If you switched away when the job finishes, the original episode's metadata is on disk — toast reads "Metadata for EP0001 generated — switch back to view." No more silent data corruption when you navigate mid-call.

**Episode-switch confirm — uniform across every generator**
- Filled in missing labels in the `JOB_TYPE_LABELS` map so the confirm dialog reads cleanly for every job type instead of falling back to raw type strings: outline_only → "outline", expand_chapters → "chapter expansion", scene_images / thumb_images → "scene images" / "thumbnail images", video_repair → "video repair", tiktok_upload / facebook_upload → "TikTok upload" / "Facebook upload".

**Script generator — preset persists intro state + form syncs to outline sidecar**
- Saving a script preset with the Introduction toggle unchecked now actually persists that bit — previously the snapshot dropped intro state silently and every reload restored `intro.enabled = true` from the default. Same fix carries the intro beats list.
- After an outline is generated, the chapter count + words-per-chapter + total-words + length inputs on the script form now mirror what's persisted in the outline sidecar. Previously the form would silently revert to format defaults on remount, forcing you to re-type the values you'd just committed before clicking Expand.

**Image Generator panel — scene preview thumbnails detect correctly**
- Fixed the row-level rendered-image binding for the Scene tab. Was reading a `scene_number` field that doesn't exist on the backend scan response; the thumbnail tab incidentally worked because it parsed the filename. Both tabs now use the canonical `number` field with a filename-regex fallback.

**Vision routes — auto-pick provider, not hardcoded Claude**
- `/analyze-style` and `/analyze-character` no longer default to `claude-sonnet-4-6` and hard-error if you only have an OpenAI key. They now honour an explicit `model` if you passed one AND have its key, else prefer Claude Sonnet if Anthropic key is set, else fall back to GPT-4o, else return a clear "configure a key" message. OpenAI-only users can use every vision feature out of the box.

**Smaller fixes**
- **Bug**: `useCharacters` composable accepted `string | (() => string)` but the Characters page passed a Vue `ComputedRef` (an object, not a function). The runtime `typeof === 'function'` check fell through and the ComputedRef got template-stringified into the URL as `[object Object]`, surfacing as "Project '[object Object]' not found" on every Create / Edit / Delete. The composable now also accepts `Ref<string> | ComputedRef<string>` via `isRef()`.
- **Bug**: `res.sendFile` was silently 404'ing on the style-preview cache route because the project path contains a space (`Story Studio KH`). Replaced with `fs.createReadStream` + explicit Content-Type/Length headers. The cached preview JPEGs now serve correctly from URLs containing spaces in any segment.
- **Bug**: NB2's `prompt_char_cap` now flows through the project-config merge so the cap pill displays correctly on existing projects.
- **Bug**: `providerParams` build in `generators/images.ts` only forwarded 4 fields (endpoint/poll/type/api_model), silently dropping `supports_reference_images`, `api_model_i2i`, `refs_field`, and `aspect_field` before they reached the provider call. GPT Image 2 + Nano Banana 2 + Nano Banana Pro + Flux Kontext had been reporting "model does NOT support references — they'll be ignored" despite all four declaring support in the type — a pre-existing bug that effectively masked reference support for every ref-capable kie.ai model except the original Nano Banana. Fixed both the generator's params build AND the kie provider's modelConfig forwarder to carry every relevant field end-to-end.

---

## v1.0.87 — 2026-05-13

**Image Generator — per-prompt control + true thumbnail/scene split**
- Each tab is now a fully independent panel (📸 Thumbnails first / 🎞 Scenes second) instead of two views of the same form.
- New per-row controls inside each panel:
  - Inline preview thumbnail of the rendered image (or ⊘ placeholder if not yet generated)
  - **Generate** button (when no image exists) → **Regenerate** button (when one does), per row
  - Color-coded status badge: *Not yet* / *Generating…* / *Rendered* / *Error*
  - Click the row to expand and read the full prompt text
- Bulk action stays at the top of each tab: "Generate All N Thumbnails" / "Generate All N Scenes" — same backend job as before, just scoped to the active tab.
- Long episodes paginate at 25 per page (matches the Image Prompts list pagination from v1.0.86). 250-scene Bound episodes render as 10 pages with « ‹ Page N/M › » jump controls.
- Every per-row generation goes through the job queue with the existing `scene_number` / `thumb_number` filter — appears in the Jobs panel with the standard "Scene 03/24: kie.ai 4 cr · saved 2 variants" log lines, retryable on error.

**Pipeline — split Images step**
- Pipeline page now exposes three checkboxes instead of one: 📸 Thumbnail Images, 🎞 Scene Images, and 📸 Images (all, legacy). The split steps default on; the legacy unified step defaults off so a fresh pipeline run renders thumbs + scenes via the two specific job types.
- Backend `routes/pipeline.ts` accepts `thumb_images` and `scene_images` as valid steps; both reuse the `image_generator_presets` list (one preset drives either step or both). The unified `images` step stays accepted on the wire so any saved pipeline preset that uses it still runs end-to-end.
- Per-step missing-count badge (`Missing thumbnails (4)`, `Missing scenes (8)`) tracks each side independently — a partially-rendered episode no longer falsely reads as "everything missing."

**Image Prompts — multiplication-form layout**
- The Scenes-per-chapter dropdown (1 / 2 / 3 / 4 / Custom total) is gone. Replaced with three always-visible fields: **Reason count** (auto from outline), **Scenes per Reason** (free integer 1–100), and **Total** (read-only math display).
- Type any number into "Scenes per Reason" — the total updates live. 32 per reason × 8 reasons = 256 prompts; no more "Custom total" mode juggling.
- Format-aware seeding redivides the format's `defaultScenesTotalRange` low end by the chapter count to land at a sensible starting value (bound-explainer's [60, 180] range with 8 reasons → 8 scenes per reason).

**Image Prompts — job-queue path**
- `POST /generate/image-prompts` no longer runs the LLM call synchronously. It enqueues an `image_prompts` job and returns the queued Job stub. The frontend polls `GET /jobs/:id` and refreshes the PromptReviewPanel on completion.
- Result: generation now appears in the Jobs panel with per-batch progress (`[chunked] [w1] scenes 1-10: got 10/10 (1/25 batches done)…`), surfaces real error states, and is cancellable mid-flight from the standard Jobs panel.
- Side effect: the v1.0.86 chunked-batch fix (renumber-not-filter) now actually fires when the user clicks Generate from the page — previously only the pipeline runner reached the chunked path.

**Internal**
- Backend pipeline (`scene_images` / `thumb_images` step types) and frontend pipeline UI fully type-aligned. No-op no-preset run-batch calls validate cleanly against the new step IDs.
- All session work since v1.0.86 verified live (typecheck clean across all touched files; the 5 remaining strict-mode `form.style_tag possibly undefined` warnings in image-prompts.vue are pre-existing, on lines untouched this release).

---

## v1.0.86 — 2026-05-13

**Image Prompts — chunked batches no longer drop most scenes**
- Fixed: requesting 250 scene prompts (or any count above 50, the chunked threshold) silently returned only a handful. Symptom: "I typed 250, got 5 in the docx." Root cause was the chunked path filtering scenes by their LLM-assigned `number` field — if the model numbered every batch 1–10 instead of "11 through 20" as instructed (which LLMs do constantly regardless of how clearly you ask), the post-filter dropped everything except the first batch's overlap. Now the orchestrator takes the first N scenes the LLM returned in any numbering and *renumbers* them to the batch's expected range. Every batch contributes its full quota.
- Job log gets clearer too — `[chunked] [w2] scenes 11-20: got 10/10 (truncated from 13)` tells you when a model over-produced for a batch.

**Image Prompts — Total Scene Prompts cap raised 200 → 500**
- Fixed: the **Total Scene Prompts** input had a hidden HTML5 `max="200"` that silently clipped typed values like 250 down to 200 when the input blurred. The chunked path handles 500+ scenes fine — the cap was a leftover from before chunking shipped. Bound-explainer at sentence-aligned pacing legitimately wants 150–250 scenes per video; sleep-story epics can exceed 300.

---

## v1.0.85 — 2026-05-12

**Hotfix — Script expansion rejected with "'chapters' must be an array"**
- Fixed: clicking **Expand all** / **Expand selected** on the Script Generator's outline review panel surfaced the toast `'chapters' must be an array of chapter numbers.` and refused to queue the job. Affected every format equally (bound-explainer / listicle / sleep-story / …) — the bug just hadn't been hit until the bound-explainer flow exercised the outline-review path in v1.0.83+.
- Root cause: the `/generate/expand-chapters` route validated `req.body.chapters` as if it were the filter array, but the OutlineReviewPanel sends that field as the chapter-COUNT (an integer from the script form, e.g. `8`) and puts the filter list under `chapters_to_expand` — which is also where the executor reads it. The route comment at the call site even called out this collision: *"Filter array goes under chapters_to_expand to avoid colliding with the chapter-count semantic of `chapters`…"*. Route was just checking the wrong field.
- Route now validates `req.body.chapters_to_expand` (the actual filter array) and ignores `chapters` (the count). Range check, integer check, de-dup, and empty-array normalization all still happen against the right field.

---

## v1.0.84 — 2026-05-12

**Hotfix — Browse button + page sluggishness fixed**
- Fixed: the FilePicker Browse button (Intro Video, Outro Video, music files, anywhere FilePicker is mounted) felt sluggish for several seconds before the native dialog opened. Pages with frequent credit-balance polling (every project page via the dashboard layout) compounded the problem — clicks queued behind in-flight external API calls.
- Root cause: the server-side credit-balance cache was 5 seconds, exactly equal to the frontend's poll interval. The cache expired moments before every poll, so every poll missed cache and re-fetched all four external balance APIs (Kie / fal / ElevenLabs / GenAIPro) in parallel. Each provider has its own 5-second timeout, so a single slow provider could push `/projects/:slug/health` to 2–5 seconds. The browser's HTTP/1.1 connection limit then held FilePicker's POST behind those pending GETs, which is the lag you saw before the dialog appeared.
- Bumped the credit cache TTL to 30 seconds. Measured impact: cold call still ~3.6s, but warm calls now ~15–50ms (200× faster) and the cache stays warm across the 5-second poll cycle, so ~83% of polls bypass the external fetch entirely. Browse button responds instantly.
- Credit display can be up to 30s stale now, but job completions still call `invalidateCreditCache(provider)` so post-generation numbers stay fresh.

---

## v1.0.83 — 2026-05-12

**Format-aware labels propagated to Ideas, Image Prompts, and Video Assembly**
- The reactive `useSectionLabel(formatId)` composable shipped in v1.0.82 (Script Generator) now drives labels on three more pages, so a bound-explainer project sees "Reasons" everywhere it would have said "Chapters", and a listicle project sees "Topics":
  - **Ideas Generator** — table column header (Ch → Rea/Top), paste-preview row header, idea-editor form field, all rebind to the active format's term.
  - **Image Prompts** — "Scenes per Chapter" → "Scenes per Reason"/"Scenes per Topic". Per-option labels ("1 per chapter") and the chapter-count form field follow.
  - **Video Assembly** — the "Align scenes to chapter audio" toggle, the hint line beneath it, the "Per-scene chapter assignments" modal title and body copy, and the auto-fill / clear-all button tooltips all switch on the format.
- Internal vocabulary (slugs, `audio_chapters.json`, `chapter_slug` references, file naming) stays "chapter" everywhere — these are presentation-only changes. Same stability guarantee as v1.0.82.

---

## v1.0.82 — 2026-05-12

**Format-aware section vocabulary (Chapters / Reasons / Topics)**
- New `script.sectionLabel: { singular, plural }` field on the Format primitive. Tells the LLM, the script docx parsers, and the UI what to call the format's primary content unit. Sleep-story / kids-fairytale / documentary / adventure stay as **Chapter / Chapters** (the field is optional and defaults to "Chapter"). Explainer formats opt in: **bound-explainer = Reason / Reasons**, **listicle = Topic / Topics**.
- Script generator's LLM prompts now use the format's term. Bound-explainer scripts come back with `## Reason 01: Can't Move Without Bursting` headings instead of `## Chapter 01: …`; listicle scripts use `## Topic 01: …`. Pacing-arc copy, regen prompts, and the chunked-narration outline + batch prompts all switched over.
- Bound-explainer + listicle JSONs hand-edited so the additionalRules / closingHint copy speaks the right vocabulary too ("Open each reason with a hook sentence", "Each topic must be self-contained", etc.) — the LLM gets a coherent instruction set instead of a Frankenstein of "chapter" + "reason" mentions.
- Script docx parsers (`splitNarrationIntoChapters`, `parseNarrationDocx`) broadened to accept `Chapter|Reason|Topic|Section|Part|Lesson|Bit|Beat` as the section keyword. Internal slugs still normalize to `Chapter_NN` so audio MP3 filenames, `audio_chapters.json`, video assembly pairing, and existing sentence-aligned sidecars work unchanged across all formats.
- New frontend composable `useSectionLabel(formatId)` returns `{ Singular, Plural, singular, plural }` for the active format. Reactively updates when the project's format changes. Wired into the Script Generator page so the form labels read **"Reasons"**, **"Words/Reason"**, **"6 reasons × 200 words/reason"** for bound-explainer projects (and **"Topics"** for listicle, **"Chapters"** for everything else).

**How to verify**
1. Open a bound-explainer project → Script Generator page. The form field reads **"Reasons"** (not "Chapters"); the recommended-range chip shows **"Reasons 3–10"**; the summary line reads **"6 reasons × 200 words/reason"**.
2. Generate a script → the saved narration docx has `## Reason 01: …` headings.
3. The downstream audio / sentence-timing / video assembly pipeline is unchanged — slugs still resolve to `Chapter_NN` internally so all existing sidecars and sentence-alignment paths work without modification.

**Internal vocabulary stays stable**
The on-disk filenames (`{code}_Chapter_NN.docx`, `{code}_Chapter_NN.mp3`), the `audio_chapters.json` slug keys, and the chapter_slug references in scene metadata all still say "chapter". This is presentation-layer-only: a sleep-story-era project switching to bound-explainer keeps its existing audio assets working without renames. Only the user-visible labels and LLM-emitted heading text adapt to the format's term.

---

## v1.0.81 — 2026-05-12

**Sentence-aligned video pacing (Bound-style explainers)**
- New format flag `imagePrompts.alignment: "chapter" | "sentence"` on the Format primitive. Default `"chapter"` keeps every existing format (sleep-story, listicle, TerraNash) on the legacy pacing. **bound-explainer** opts in to `"sentence"` so its scene cuts land on spoken sentence breaks instead of drifting across uniform 10s blocks.
- New audio sidecar `audio_sentences.json` written next to `audio_chapters.json` by Audio Assembly. Contains per-section sentence-level start/end times derived from a char-length-weighted apportionment of each chapter's measured audio duration. Provider-agnostic — works with ElevenLabs direct, fal.ai, and GenAIPro alike (no `with-timestamps` API dependency).
- Video Assembly's standard scene-clip pipeline now consumes the sidecar when the project's format opts in. Each scene's on-screen duration becomes the sum of its assigned sentences' durations; chapters with N scenes and M sentences pair scenes to sentence-windows `[i*M/N, (i+1)*M/N)`. Scenes with explicit `chapter_slug` flow into their declared chapter; scenes without slug get positional even-split (mirrors legacy `buildConcatList` behavior).
- Job log gains diagnostic lines when sentence alignment is active: scene count mapped, total sentence count, target scene-track duration. Missing or invalid sidecars fall back to uniform per-scene duration with a clear "re-run Audio Merge to emit it" hint.

**How to use**
1. Create a project with format=**Bound-style Explainer** + niche=Plants/Animals/Fungi/Insects.
2. Generate ideas → script → image prompts → images → audio → **Audio Assembly** (this is the step that writes both sidecars). 
3. Run Video Assembly. The job log will show "Sentence alignment: ON — N scene(s) mapped to M sentence(s)" when active.
4. The resulting MP4 cuts every ~3-7 seconds aligned to sentence breaks, matching the Bound channel's pacing register.

**Limitations**
- Char-length apportionment is a heuristic, not true word-level alignment. Empirically within ±300ms per sentence vs. ElevenLabs ground truth, which is below the visual-pacing tolerance, but not suitable for subtitle rendering. A future revision can swap in true ElevenLabs `with-timestamps` data with no caller-side changes.
- Compilation-mode (per-chapter foreground overlay path) still uses chapter-level pacing. Sentence alignment only affects the standard sequential scene-clip path.

---

## v1.0.80 — 2026-05-12

**Hotfix — project creation accepts niche_id**
- Fixed: Creating a new project with a niche picked failed with `Invalid request body: (root) — Unrecognized key(s) in object: 'niche_id'`. The v1.0.79 `CreateProjectSchema` was `.strict()` and didn't list `niche_id`, so the field was rejected at the API boundary even though every downstream layer (route handler, project-manager, types) knew about it. Schema now allows `niche_id` (optional, ≤80 chars). Niche selection at project-creation time works as intended.

---

## v1.0.79 — 2026-05-12

**Bound-style explainer format**
- New built-in format **"Bound-style Explainer"** — short 10–15 min "Why It Sucks To Be Born As X" videos in the Bound / In The Black Media YouTube style. Each chapter is one self-contained reason in a numbered countdown; image prompts target the channel's signature look (thick black ink outline, flat fills, hand-drawn curved arrow, handwritten caption). Pick it in the Format dropdown when creating a project.
- 5 narrator styles included (Bound-style deadpan, sardonic explainer, curious naturalist, dark-comedy host, documentary deadpan). Defaults to 6 chapters, ~12 min length, 4-second per-scene pacing.

**Niche primitive — subject-domain layer**
- New orthogonal axis to Format. Format decides *what shape* the video takes (sleep-story, listicle, bound-explainer); **Niche** decides *what subject domain* it covers (plants, animals, fungi, insects, or your own). Generators automatically layer niche vocabulary, visual style sheet, and YouTube tag hints on top of the format's defaults.
- 4 built-in niches shipped: **Plants**, **Animals**, **Fungi**, **Insects & Arthropods** — each with 20 example topics, vocabulary pools, a long-form visual style sheet, default style keywords, negative-prompt addendum, and YouTube tag hints. Layer any of these onto any format (e.g. bound-explainer × plants for plant explainers; sleep-story × gemstones for TerraNash; listicle × animals for nature listicles).
- New **Niches** page (sidebar → 🌿 Niches) browses every built-in + user-custom niche and creates new ones. Custom niches live in `${PROJECTS_ROOT}/.niches/{id}.json`, shadow built-ins by id, and travel with the user's projects folder.
- New **Niche** picker in project creation wizard + Settings → Format tab. Optional — leave empty for format-default behavior.
- Full CRUD API: `GET/POST/PUT/DELETE /api/niches`, `PUT /api/projects/:slug/niche`, `GET /api/projects/:slug/effective-niche`.
- Niche layering integrates at one call site (`getEffectiveFormatFor`) so every existing generator picks up niche context without per-generator wiring: idea-generator vocabulary merges, script system-prompt context line, image-prompt style-sheet append, metadata broad-keyword merge.

---

## v1.0.78 — 2026-05-10

**Audio Generator script detection — iCloud resilience**
- Fixed: "Generate Audio" button stayed greyed with "Generate the script first" message even when the script docx was sitting on disk. Root cause was iCloud transience — when iCloud hadn't yet materialized the script subfolder locally, the directory read returned empty, the cache stored `script: false`, and that false stuck forever (the parent folder's mtime didn't bump when iCloud later delivered the file).
- The status-detection compute now distinguishes "folder is genuinely empty" from "folder couldn't be read" and refuses to cache results derived from a failed read. Stale states recover automatically on the next page navigation instead of getting frozen until you click Shift+↻.
- New inline **"↻ Rescan from disk"** link appears under the disabled "Generate Audio" button when no script is detected for the selected episode. One click forces a full project rescan — useful after an iCloud sync arrives but the watcher hasn't picked it up. Toasts a confirmation when the script becomes detectable.

---

## v1.0.77 — 2026-05-09

**YouTube — AI content disclosure + Entertainment default**
- New project setting **"Mark uploads as AI-generated content"** (Settings → YouTube). When on, fresh uploads include YouTube's `status.containsSyntheticMedia` flag, satisfying YouTube's altered/synthetic content disclosure requirement. Default: ON.
- Default video category for new uploads switched from **People & Blogs (22)** to **Entertainment (24)** — the right bucket for narrative AI / story content.
- New backfill action: **Settings → YouTube → "Apply current settings to all uploaded videos"**. Walks every previously uploaded video on the project and PATCHes the AI disclosure flag + category, preserving privacy and schedule. Dry-run preview shows what would change before you commit.
- App-level defaults under **App Settings → YouTube defaults** set the per-project starting values for new projects.

**What's New modal**
- New **Help → What's New** menu item. Auto-shows once on first launch after upgrade. Shows entries from this CHANGELOG.md.

---

## v1.0.76 — 2026-05-09

**Audio Generator regression fix**
- Fixed: "Generate Audio" disabled with "no script exists" message when the script docx was actually present on disk. Root cause: the episode-status cache stored entries with empty watched-folder snapshots when project.json reads transiently failed, then served `script: false` forever (mtime check thought nothing changed). Cache now refuses to persist entries with no resolved folders, and any pre-existing poisoned entries are dropped on hydrate.
- Per-episode invalidate on every page load — `useEpisodeStatus` now passes `?invalidate=<CODE>` to `/projects/:slug/episodes` so the selected episode always reflects current disk state. Catches iCloud cases where the parent folder mtime didn't bump when the file inside changed.

**App Settings slow-load fix**
- Fixed: App Settings modal stuck on "Loading…" for ~10 s on every launch. The v1.0.75 z-image migration was walking every project's getConfig on every boot. Now gated by a marker file in `<userData>/migrations.json` — runs once per machine, then zero overhead.

---

## v1.0.75 — 2026-05-09

**kie.ai Z-Image fix**
- Fixed: Z-Image image generation failed with "model not found" because the `api_model` was set to `tongyi/z-image-text-to-image` but kie.ai's API expects the literal string `z-image`. Default catalog updated and a one-shot boot migration rewrites existing projects' `image_models.z-image.api_model`.
- Z-Image is now usable as the cheapest option at 0.8 credits ($0.004) per image.

---

## v1.0.74 — 2026-05-09

**Server Mode — switch back to desktop from the web UI**
- New **"Disable Server Mode & Switch to Desktop"** button in Settings → Server Mode. One click flips the toggle and restarts the app in normal desktop mode.
- JSON `enabled: false` now wins over the `STORY_STUDIO_SERVER_MODE=1` env var. So even with launchd respawning the app, an explicit disable takes effect.
- Networking fields (Enable / Port / Bind) are now editable from the web UI. Credentials remain locked from the web (a typo'd password while logged in remotely = total lockout).
- Three-state status pill in the panel: `running` / `enabled (next launch)` / `disabled` so it's clear when the persisted intent diverges from what's actually running.

---

## v1.0.73 — 2026-05-09

**Server Mode — headless web UI for the Mac mini**
- New "server mode" lets Story Studio KH run on a headless Mac mini (display unplugged, autologin, on the network) and be accessed from any other machine's browser at `http://mac-mini.tailnet:8765/`. Comparable to qBittorrent's WebUI.
- Custom login page with username + password (scrypt-hashed) and signed session cookies. Loopback bypass means walking up to the mini still works without logging in.
- In-app file browser modal replaces native macOS folder/file pickers when you're connected via the web — click through the mini's filesystem from your iMac browser.
- Connection banner with sign-out + latency dot in the bottom-right of every page.
- Setup walkthrough: see `SERVER_MODE.md` for launchd plist + auto-login + Tailscale steps.

---

## v1.0.72 — 2026-05-08

**GenAIPro TTS migration + dead-code cleanup**
- Fixed: TTS jobs returning `401 token_is_empty`. GenAIPro migrated their entire API from `genaipro.vn` to `genaipro.io`; the old domain stopped honoring Bearer auth headers post-migration. Base URL updated in three places (TTS client, credits probe, connectivity precheck).
- Removed dead `genaipro-veo` provider (Veo video) — extracted shared `downloadVideo` helper to its own module so kie + fal video providers continue to work.
- Removed orphaned `genaipro-gpt-*` and `genaipro-claude-*` model entries that never had a backend handler.
- Default video model is now `kie-veo3-fast` (was `veo-v2`).

---

## v1.0.71 — 2026-05-04

**Chunked narration + format-aware audio defaults**
- Zero-byte chunk resume guard for chunked-narration TTS jobs — partial files left by an interrupted run no longer make the resume path skip the chunk.
- Audio knobs (speed / stability / similarity) now seed from the project's format JSON. Sleep-story defaults (0.93× / 1.0 / 1.0) only apply to sleep formats; listicle/explainer channels get a 1.0× pace by default.
- Long-job pings + chunked-mode pre-flight cost estimate.

---

## v1.0.70 — 2026-05-02

**Channel Format picker carousel**
- Format picker on project create + Settings is now a carousel with previews instead of a dropdown.
- Listicle format gets explicit item-count input.
- Title ⟷ chapter-count sync — typing a chapter count in the title updates the chapter spinner and vice versa.

---

## v1.0.69 — 2026-05-02

**Format parity + correctness pass**
- Walked every generator (script, image-prompts, metadata, video assembly) to make sure each one honors the project's Channel Format consistently. Listicle / explainer projects no longer fall back to sleep-story defaults silently.
- Various small bug fixes around per-format vocabulary and idea generation.

---

## v1.0.68 — 2026-05-01

**Pipeline batch parity + Channel Format picker on create**
- "Run Pipeline" batches now respect every per-format setting end-to-end (matches what you get when running each generator individually).
- Channel Format picker added to the New Project flow so the format is set from day one rather than retrofitted later.

---

*Older entries have not been backfilled into this changelog. Check `git log --oneline` for the full history.*
