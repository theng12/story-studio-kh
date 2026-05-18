# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.0.108 — 2026-05-17

**Eight-feature batch: format-mismatch banner + music polish + playlist LLM + recency-log page + multi-scope recency + thumbnail visual editor**

Big user-driven release. Eight items from your pending list, all answered.

### 1. Format-level chapter-count mismatch banner

Sibling of the niche-level mismatch banner from v1.0.106 — but for projects WITHOUT a niche scriptStructure override. Fires above the outline-review panel when the saved outline's chapter count diverges from `format.script.defaultChapterCount`. Cyan accent, one-click "Set chapters to N" button. Suppressed when the niche banner is already firing so only one CTA appears at a time.

### 2. Music Pool — preview playback in the panel

Per-row ▶/■ Play/Stop button on every track in the Music Pool panel. Single-instance audio so multiple tracks can't play simultaneously; reuses `/audio-editor/preview-audio` (no new endpoint). Stops on component unmount so audio doesn't bleed into the next page.

### 3. Playlist LLM-description magic button

**The app already creates YouTube playlists** (Upload page, since v1.0.94) — what was missing was the magic-write description. v1.0.108 adds it:

- **New endpoint:** `POST /api/projects/:slug/upload/playlists/generate-description` takes a playlist title + (optional) `video_count`, pulls niche + format context, returns ~500-char description.
- **New button:** "✨ Generate with AI" next to the Description field in the create-playlist card. Disabled until the title is non-empty (the LLM needs the title for context). Char counter under the textarea with a warn flag when over YouTube's 5000-char cap.
- Prayer/devotional/preaching channels get descriptions that match their `metadataDescription.voiceGuidance` + (optionally) end with the niche's `closingBenediction`. Other niches get a neutral playlist pitch.

### 4. Music Pool — per-track volume / fade overrides

`MusicPoolTrack` schema gains four optional override fields: `volume` / `post_narration_volume` / `fade_in` / `fade_out`. Useful when a louder ambient bed needs its own level (one track masters quieter than the rest of the pool, etc.).

- **Override drawer** in the Music Pool panel — ⚙ toggle on each track row opens an inline drawer with four number inputs. Empty/blank clears the override (track inherits the merge form's globals). ● dot replaces ⚙ when any override is set so you can spot which tracks diverge from globals at a glance.
- **Auto-pick applies overrides.** When the cycler pre-fills `music.files` from a track with overrides, `refreshPoolPeek` also sets the form's `music.volume` / `fade_in` / etc. to the track's values. So your "louder ambient bed" episode gets its louder volume automatically.

### 5. Recency log management page

Standalone `/projects/:slug/recency` page that surfaces the **full** log (not just the lookback-filtered slice the Script Generator strip shows):

- Active rule summary card (niche id, kind, lookback source)
- Filter by kind dropdown + free-text search across item/episode
- Per-entry remove button (surgical — re-enables that specific item)
- Bulk "Clear all <kind> entries" + "Clear entire log"
- Empty / inactive-niche states with concrete next-step copy
- Linked from the Script Generator's recency strip via a new **Manage log →** link (only renders when `log_size > 0`)

Backend: `GET /recency?full=1` returns the full log + per-kind counts; `DELETE /recency/entry` removes one tuple.

### 6. Multi-scope recency (script + titles + image prompts + metadata)

The recency system used to scan narration only. v1.0.108 makes it generic across all four generator outputs. **The schema, log entries, and avoidance list all stay unified by `kind`** — if `Psalm 91` was used in episode 3's script, episode 4's description avoids it too (and vice versa). No more separate-bucket fragmentation.

- New `Niche.recencyAvoidance.scopes?: Array<'script' | 'titles' | 'image_prompts' | 'metadata'>` field. Default `['script']` for backward compat with v1.0.106-era niche JSONs.
- New service helpers: `getAvoidanceForScope(slug, scope)` / `prependAvoidanceToPrompt(slug, scope, prompt)` / `recordUsageForScope(slug, episode_code, scope, text)`. Existing `applyRecencyToFormat` now scope-gates to `'script'`.
- Wired into three new generator paths:
  - **metadata.ts** description + titles (post-gen `recordUsageForScope`)
  - **routes/scripts.ts** `/metadata/description` + `/metadata/all` batch
  - **image-prompts.ts** generator (prepend + post-gen scan of the joined scene/thumbnail prompts)

### 7. Prayer / Devotional / Preaching niches all track scripture across script + description

- **Prayer.json** — added `scopes: ['script', 'metadata']` to its existing scripture-ref rule. Same regex, two surfaces.
- **Devotional.json** — populated for the first time. 30-episode lookback. Instruction template steers toward 9 lesser-known teaching passages (2 Corinthians 4:7-10, Romans 12:1-2, James 1:19-20, etc.).
- **Preaching.json** — populated for the first time. 40-episode lookback (preaching channels rotate more slowly). Template steers toward 9 less-frequently-preached passages (2 Kings 6, Nehemiah 8, Acts 17, etc.).
- History / motivation / philosophy / psychology niches NOT yet populated — what to track for those is fuzzier without concrete repetition examples. User-driven JSON edits when the pattern surfaces.

### 8. Thumbnail template visual editor (MVP)

Inline visual editor on the Thumbnail Templates page. Click **Edit** on any gallery card → the gallery collapses, the editor expands in place. Drag any text zone on a scaled-down 1920×1080 canvas, adjust properties inline, save.

- **Drag-to-reposition** with anchor-preserving offset math. Dragging a right-anchored zone right *decreases* `xOffset` (the offset is measured FROM the right edge). Same logic for top/bottom/center. The layout's intent stays intact.
- **Keyboard nudges**: arrow keys ±1px, Shift+arrow ±10px on the selected zone. Ignored when an input/textarea/select is focused so typing into the property fields doesn't bleed into nudging.
- **Properties panel** on the selected zone: font size, max width, fill color (color picker), letter spacing, font weight (400-900 dropdown), uppercase toggle. Saves to local state on each edit; commits on Save.
- **Fork-on-first-save for built-ins**: built-in templates in the app bundle stay pristine. Saving an edit to a built-in creates a `*-custom` copy in `${PROJECTS_ROOT}/.thumbnail-templates/`; subsequent edits save there. The original built-in remains reachable as the un-suffixed id.
- **Unsaved-changes pill** in the editor header. **Cancel** confirms before discarding edits. **Save** also sets the project default to the saved id so the next compose uses the edited copy.

Backend additions:
- `POST /thumbnail-templates/:id/fork` — clones a built-in to user library
- `PUT /thumbnail-templates/:id` — saves edits (refuses built-ins; fork first)
- `DELETE /thumbnail-templates/:id` — removes user-library template (refuses built-ins)

### Audit pass

- `tsc -p electron --noEmit`: 0 errors across all four commits
- `cd frontend && npx nuxt build`: clean throughout
- Devotional + preaching JSONs parse cleanly with the new `scopes` field
- Per-track override applies cleanly when auto-pick picks a track with overrides set
- Editor drag math verified against all 9 anchor combinations (left/center/right × top/middle/bottom)

### What's NOT in this release

- **Drag-to-resize for thumbnail zones** — `maxWidth` is editable via a number input in the properties panel instead of corner-drag. Drag-corner-resize is a polish iteration.
- **Reset-to-default for forked templates** — not yet wired. Easy follow-up: DELETE the user-library copy, gallery re-shows the built-in.
- **History / motivation / philosophy / psychology recency rules** — what to track for these is fuzzier without concrete examples. Add a `recencyAvoidance` block in those niche JSONs once you spot a repetition pattern.
- **Image-prompts recency** is wired (the plumbing exists) but no niche populates an `image_prompts` scope yet. Same JSON-edit pattern.

---

## v1.0.107 — 2026-05-17

**Audio-assembly music pool + Server Mode usability fixes + Unlink button**

User-driven release. Five user-reported asks, all answered:

### 1. Background music pool with auto-cycling

User: *"i have like 5-10 background music i wanna cycle within the audio assembly. is that something i can do yet? right now i know i can just swap them out but it's tedious."*

New project-level music pool with three cycling strategies. Files live in `{projectDir}/music/` — drop new tracks in via Finder OR use the new in-app "Add music…" picker (server copies the file into the pool folder). Mirrors the recency-tracker / broll-usage-log pattern.

- **`MusicPoolPanel`** on the Audio Merge page (above the music files block). Strategy dropdown, lookback knob, cursor reset, per-track enable / rename / remove, last-used timestamp per track, "Show folder in Finder ↗" path copy.
- **Three strategies:** `sequential` (default — E1=track1, E2=track2, wraps via cursor), `random-no-repeat` (random pick from tracks NOT used in last N episodes; falls back to least-recently-used when the pool is exhausted instead of returning null), `manual` (per-episode picks, pre-v1.0.107 behaviour).
- **Auto-pick on episode load.** When strategy != manual and the music files list is empty, the panel pre-fills the form with the cycler's pick. Banner shows the choice + reason (*"sequential cursor 3 / 5"* or *"random pick from 3 of 5 — avoiding last 2 episodes' tracks"*) + **Pick another** + **Skip** controls. Never trumps a user's manual curation.
- **Cursor advances only on successful merge** — the audio-merge job reads `music_pool_track` from the request and calls `recordPick()` after the file lands on disk. Opening + closing an episode without merging doesn't advance state.
- New endpoints: `GET/PUT /api/projects/:slug/music-pool`, `POST/PATCH/DELETE /music-pool/tracks[/:filename]`, `GET /music-pool/peek-next`, `POST /music-pool/record-pick`.
- New `ProjectConfig` fields: `music_pool_strategy` / `music_pool_cursor` / `music_pool_lookback` (default 5) / `music_pool_usage_log` (capped at 100, trimmed oldest-first) / `music_pool_tracks` (per-track metadata, auto-pruned when files disappear from disk).
- Idempotency window: re-recording the same `(filename, episode_code)` pair within 24 h doesn't double-advance the cursor.

### 2. Unlink from this Mac (for linked iCloud projects)

User: *"is there a way to one day just unlink a project? i'm scared it might get deleted."*

Backend has supported this since v1.0.93 (`DELETE /api/linked-projects`); UI was never wired. v1.0.107 adds the missing button.

- Settings → Project → new danger-zone block **🔗 Unlink from this Mac**, visible ONLY when `projectIsLinked === true` (i.e. the project's folder lives outside the default `PROJECTS_ROOT`).
- Copy spells out the safety guarantees explicitly: folder + all contents stay on disk, iCloud sync behaviour unchanged, other Macs that linked the same folder are unaffected, re-add via "Add existing project folder…" on All Projects.
- Confirm dialog repeats the absolute folder path so you know exactly what's being unlinked.
- After success: `navigateTo('/')` bounces back to All Projects (the slug is no longer addressable on this Mac).

### 3. Server Mode credential lockout fixed

User: *"i can't seem to be able to create credentials"* + greyed-out username / password fields in the desktop app.

**Root cause:** `isServerMode()` checked only the meta tag injected by Express. But the desktop Electron BrowserWindow loads `http://127.0.0.1:PORT/` via `mainWindow.loadURL`, so it sees the same HTML the server serves to remote browsers — including the meta tag. Once you ever toggled "Enable on next launch", the desktop window started treating itself as a remote client and locked the credentials fieldset.

**Fix:** `isServerMode()` now ALSO checks `window.electron.isElectron` (set by `electron/preload.cjs`). Inside the Electron BrowserWindow → desktop, credentials editable regardless of server-mode config. Remote browsers don't load the preload → property is falsy → meta tag stays authoritative.

### 4. Server Mode rate limit bumped 5/min → 30/min (configurable up to 1000)

User: *"is there a way to allow for more than 30 tries before locking out?"*

Hardcoded `MAX_ATTEMPTS = 5` was way too tight for personal-use over Tailscale. Autofill loops and typo retries tripped it constantly.

- `checkLoginRateLimit(ip, maxAttempts = 30)` — caller passes the cap.
- New schema field: `server_mode.auth.login_max_attempts_per_minute` (default 30, range 1–1000).
- New route: `PUT /api/app-settings/server-mode/rate-limit` — writes only the cap, no need to re-enter the password to bump it.
- 429 response names the cap: *"Too many login attempts (max 30/min). Wait a minute and try again."*
- New UI knob in the Server Mode panel under credentials. Type a number, blur/Enter saves. Hint copy explains the default + suggests checking for stale autofill if you keep hitting it.
- Legacy auth blocks without the field migrate cleanly on first read (default-fill in both `getServerModeConfig` + `getServerModeSettingsSafe`). `setServerModeCredentials` preserves the existing cap when not passed (so "Change Password" doesn't reset it).

### 5. `npm run reset-server-auth` — one-command credential recovery

User: *"what happens if i forgot my passwords afterwards."*

`password_hash` is scrypt (one-way) — no recovery from the hash. Pre-v1.0.107 the workaround was hand-editing `~/Library/Application Support/Story Studio KH/app-settings.json` to delete the auth block. Easy to mess up the JSON syntax.

- New `scripts/reset-server-auth.ts` + `npm run reset-server-auth` alias.
- Resolves the settings path via the same chain the app uses (`STORY_STUDIO_DATA_DIR` → Electron userData → XDG fallback).
- Writes a timestamped `.bak-{ISO}.json` backup before touching the file.
- Deletes the `server_mode.auth` block.
- By default sets `server_mode.enabled = false` so the next launch boots in **desktop mode** (where the credential UI is editable). Pass `--keep-enabled` to leave the toggle on.
- Login page footnote now points at the command alongside the "sit at the host Mac" guidance, with a monospace code chip.

### 6. Bonus: outline prompt commits to specifics

Companion fix surfaced while debugging the scripture-recency feature. The outline prompt now explicitly asks the LLM to NAME specific items (verse, case, quote, date, study) in the beats when the pacing arc requires citing one — instead of writing vague placeholders like *"Invoke a scriptural promise"*. Bad/good examples included in the prompt so the LLM has scaffolding for any niche.

### Audit pass

- `tsc -p electron --noEmit`: 0 errors
- `cd frontend && npx nuxt build`: clean
- `npm run reset-server-auth` smoke-tested against a synthetic `app-settings.json`: auth deleted, port/bind preserved, backup written

### What's NOT in this release

- **No auto-update channel.** Updates are still manual-install per the personal-use stance. To push a fix to a remote-server-mode Mac, install the new DMG on that Mac (or `git pull && npm run dist`).
- **Music pool: no preview-in-browser playback yet.** The existing per-row Play button still works for files in `music.files`; the pool panel doesn't have its own preview. Trivial follow-up if it matters.
- **Other niches' `recencyAvoidance` blocks.** Only prayer is populated; populate the rest as you collect reference scripts.

---

## v1.0.106 — 2026-05-17

**Recency avoidance + Script Generator niche visibility**

Three patches landing in one release, all answering the same underlying user question: *"how do I know the niche layer is doing something — and how do I stop the LLM from repeating itself?"*

### Recency avoidance — stop repeating scripture every 2-3 episodes

User reported: prayer scripture verses (Psalm 91, Philippians 4:6-7, Isaiah 41:10) cycling every 2-3 episodes. LLMs have no cross-episode memory, so without a guardrail they default to the same 4-5 "comfort verses". v1.0.106 adds a generic recency-avoidance layer modeled after `broll_usage_log`.

#### New schemas

- **`Niche.recencyAvoidance`** — declarative tracking rules per niche. Fields:
  - `label` — human label, used as the discriminator in the project log AND in the LLM prompt copy ("scripture references", "famous unsolved cases", etc.)
  - `extractPatterns: string[]` — regex patterns (JS syntax, no slashes) that pull used items out of generated script text. Multiple patterns are unioned. Prayer ships with a 66-book Bible regex matching `Psalm 91`, `1 Peter 5:7`, `Song of Solomon 2`, all numbered + named books.
  - `defaultLookback` — how many recent episodes to consult when building the avoid-list. Prayer ships 30.
  - `instructionTemplate` — prompt copy with `{label}` / `{count}` / `{items}` placeholders. Prayer's template not only lists "avoid these" but actively steers the LLM toward 10 underused but powerful passages (Lamentations 3:22-24, Zephaniah 3:17, Habakkuk 3:17-19, 2 Cor 12:9, Hebrews 4:14-16, 1 Peter 5:7, Romans 8:28, James 1:2-4, Isaiah 43:1-3, Psalm 34:18, Psalm 139:7-12).
- **`ProjectConfig.recency_log`** — flat array of `{ episode_code, used_at, kind, item }` entries. Capped at 500 (trimmed oldest-first). Multiple niche `kind`s share one log; readers filter.
- **`ProjectConfig.recency_lookback`** — per-project override of the niche default. Empty / 0 = inherit niche default = 30.

#### Backend wiring

- **`services/recency-tracker.ts`** — new service. `extractItems` / `getRecentItems` / `buildAvoidanceInstruction` / `recordUsage` / `clearLog` / `applyRecencyToFormat` (clones format + appends instruction onto `format.script.additionalRules` so it flows through `systemPrompt()` in episode.ts).
- **`generators/episode.ts`** — all 4 generator entry points (one-shot, chapter-only regen, image-prompts-only, expand-chapters wrapper) call `applyRecencyToFormat` before building the script prompt. After the unified narration docx is reassembled, `recordRecencyForEpisode` scans it and appends matches to the log. Fail-soft: a malformed regex or unreadable docx logs a warning, never fails the parent job. Idempotent: re-running the same episode dedupes by `(episode_code, kind, item)`.
- **`GET/PUT/DELETE /api/projects/:slug/recency`** — new routes for reading state, updating per-project lookback, clearing the log.

#### UI

A new **green recency strip** under the niche overlay on the Script Generator:

- *"🔁 Avoiding repetition — the next prompt will tell the LLM to skip N scripture references used in the last 30 episodes."*
- **See list ↓** expander → pill grid of every reference currently on the avoid-list
- **Lookback knob** inline — type a number to override project-wide; blank = inherit; shows resolution source ("your override / niche default / built-in default")
- **Clear log** link with confirmation when you want a fresh start
- Auto-refreshes after each chapter expansion (polls every 4s for 30s after `onExpansionQueued` fires, so the post-generation log additions appear without a manual reload)

#### What you'll see on day 1 vs day N

- **First episode**: strip shows *"Avoiding 0 scripture references"*. LLM picks freely.
- **Episodes 2-30**: each new episode sees a growing avoid-list. By episode 10, ~10-30 distinct references are off-limits; LLM reaches into less-common passages.
- **Episode 31+**: oldest entries fall off (default 30-episode window). Episode 1's verses become eligible again. Natural rotation.

#### Generic by design

Only `prayer.json` has `recencyAvoidance` populated today. Architecture is generic — any future niche drops its own `recencyAvoidance` block (different regex, different label, different lookback) and inherits the full system: prompt injection, post-generation logging, UI strip, lookback knob, clear-log. No code changes.

### Script Generator — Niche overlay indicator

Until this release, the Script Generator showed only the *merged* numbers (chapter range `3-5` for prayer) with no signal that the niche was driving the override. v1.0.106 adds a visible amber **🎯 Niche overlay active** card directly under the format-context card:

- Chips for each override: `Chapter count 3` · `Range 3–5` · `Pacing arc 3 sections` · `+7 rules layered on format`
- **See what changed ↓** toggle expands to show the full pacing-arc text (all 3 prayer sections verbatim) + the full additional-rules list (POV switching, scripture anchor, Amen pause, no-denomination, etc.)
- Footer ties the overlay back to what you'll see in the outline review panel: *"one row per chapter, so for this niche you'll see 3 rows once the outline is generated"*

### Script Generator — Outline-vs-niche mismatch banner

When you've already got an outline on disk and its chapter count doesn't match the niche's recommended `defaultChapterCount`, a cyan info banner appears above the outline-review panel:

- *"📑 Outline doesn't match the niche's structure — this outline has 1 chapter, but Prayer recommends 3 (one per pacing-arc section). Bump Chapters in the form above to 3 and regenerate the outline to use the full 3-section structure."*
- One-click **Set chapters to 3** button bumps the form and recomputes derived word counts so you can immediately regenerate

Fires when `outline.totalChapters !== niche.scriptStructure.defaultChapterCount`. Common case: outline was generated before v1.0.103 added the niche-structure merge, or before the project's niche was set. Hidden otherwise.

### Audit pass

- `tsc -p electron --noEmit`: 0 errors
- `cd frontend && npx nuxt build`: clean
- All new endpoints (GET/PUT/DELETE `/recency`) register cleanly through the existing router pipeline

### What's NOT in this release

- **Recency tracking on other niches.** Only prayer ships `recencyAvoidance`. Other niches (true-crime, listicle, motivation) can adopt the same system whenever you collect reference scripts — declare a regex + label in the niche JSON, no code changes.
- **Recency for image prompts / titles / metadata.** v1.0.106 scans the narration text only. Tracking image prompts ("don't keep using the same lighting setup") or title patterns is the same architectural pattern with a different extract regex; can layer on later if a use case shows up.
- **Settings page for browsing the full log.** Today's UI surfaces the active avoid-list + lookback + clear-log. The full historical log is accessible via `project.config.recency_log` directly; a UI viewer can land if/when users want to spot-check episodes.

---

## v1.0.105 — 2026-05-17

**Thumbnail templates are now a first-class browsable library, decoupled from niches**

User asked: *"does it actually have a preview, style or layout to show the user. and they can then follow it? like say if i want to use a truecrime thumbnail style but for the prayer one. that should be allowed right? like i can use it. but this also means i can browse and view it before selecting?"* — and the honest answer in v1.0.104 was: no preview, no library, template locked to the niche. v1.0.105 fixes all three.

### Architecture: templates are their own thing now

- **New `ThumbnailTemplate` top-level type** in `electron/server/models/types.ts`. Each template is a self-contained JSON file with `id`, `name`, `description`, `tagline`, `recommendedNicheIds`, and the layout fields (canvas, gradient, textZones, accentStrokes, logoSlot) that used to live inline on `Niche.thumbnailTemplate`.
- **New library at `electron/server/thumbnail-templates/`** mirrors the niche-loader layout (built-in dir + `${PROJECTS_ROOT}/.thumbnail-templates/` user dir). Two templates ship:
  - `portrait-block-right.json` — the layout from v1.0.104 prayer (left portrait + right-aligned title block + bottom subtitle banner + accent rule + top-left logo). Recommended for prayer; usable on any niche.
  - `centered-hero-headline.json` — full-canvas dim, one big yellow centered all-caps headline at 168px, no subtitle banner, logo slot bottom-right. Recommended for true-crime / motivation / history / educational; usable anywhere.
- **New `thumbnail-template-loader` service** with the same shape as `niche-loader`: `loadTemplate(id)`, `listTemplates()`, `getEffectiveTemplateFor(project, niche, config)`, mtime-keyed user cache, console-warn on malformed files.
- **Resolution chain** (the chain the compose route walks):
  1. Body `template_id` (per-compose override from the gallery picker)
  2. `project.config.thumbnail_template_id` (saved project default)
  3. `niche.defaultThumbnailTemplateId` (niche's recommended default)
  4. `niche.thumbnailTemplate` (legacy inline — auto-promoted into the library cache under `legacy:{nicheId}` so old niches keep working)
  5. 422 — user picks one in the dialog gallery
- **Niche schema**: new optional `defaultThumbnailTemplateId` field. The old inline `thumbnailTemplate` field is now marked deprecated but still loads via the legacy bridge — no migration forced.
- **`prayer.json` migrated**: inline 50-line `thumbnailTemplate` block removed, replaced with `"defaultThumbnailTemplateId": "portrait-block-right"`.

### Visual previews

- **`GET /api/thumbnail-templates/:id/preview.png`** — on-demand preview render. Composites the template's SVG overlay over a synthetic placeholder portrait (a generated SVG: radial gradient + soft warm "lit area" + faint `PLACEHOLDER PORTRAIT` watermark) so each gallery card shows what the template's title shape actually looks like, not just a name. Cached per-process for the placeholder, fresh-rendered per request. 5-minute `Cache-Control` so card thumbnails stay snappy.

### Gallery picker UI

- **New `ThumbnailTemplatePicker.vue` component** with two modes:
  - **Compact strip** — horizontally-scrolling cards, embedded at the top of the Compose dialog. Clicking a card immediately PUTs `thumbnail_template_id` to project config so the next compose remembers the pick.
  - **Full grid** — three-up responsive grid, used on the standalone Thumbnail Templates page (see below).
- **★ recommendation badge** — templates whose `recommendedNicheIds` includes the project's active niche float to the top of the gallery and get a yellow ★ marker. Advisory only; every template stays clickable. The user is in charge.
- **Active state** — currently-selected card gets a blue accent border + ✓ checkmark badge in the corner.

### Standalone management page

- **`/projects/:slug/thumbnail-templates`** — new full-page gallery for browsing + setting the project default. Top card shows what's currently active (which template + what resolved it: project override / niche default / legacy inline / library default), with a "Clear project override" button when the override is what's driving the choice. Below that, the full grid of templates. Below that, a "Add your own template" how-to pointing at the `{PROJECTS_ROOT}/.thumbnail-templates/` directory.
- **Linked from**:
  - "Browse all →" in the Compose dialog template-picker section header
  - Settings → Niche tab — added a hint paragraph linking to the page

### Compose dialog rewrite

- Gallery picker moved to the top of the dialog. The dialog's intro line now shows the **active template's name + description** instead of generic prayer-flavoured copy. Title-text hint reads from the actual selected template's zone spec (e.g. *"Rendered as ALL CAPS, wrapped to fit a 1600px column at 168px."* on the hero-headline template, vs *"… 980px column at 132px."* on portrait-block-right).
- The compose POST now sends `template_id` so the user can preview a different template without changing their saved project default. Title / subtitle / logo fields stay shared across templates — switching templates re-reads the new zone defaults but doesn't wipe user-entered text.
- "No template" state replaces the v1.0.104 "no niche template" warning — fires only when literally no template applies (project has none, niche has no default, no legacy inline). The fix is one click in the gallery above.

### Audit pass

- `tsc -p electron --noEmit`: 0 errors
- `cd frontend && npx nuxt build`: clean
- Both built-in templates load + render preview PNGs cleanly
- Legacy bridge tested: a niche with the deprecated inline `thumbnailTemplate` field still resolves via the `legacy:{nicheId}` synthetic id

### What's NOT in this release

- **Template editor UI.** Adding a new template means dropping a JSON file in `${PROJECTS_ROOT}/.thumbnail-templates/`. Visual editor (drag-the-zone-around) is deferred — the v1.0.105 surface is library + browse + apply; authoring stays JSON for now.
- **Templates beyond the 2 built-ins.** The schema is generic and the library auto-discovers JSON files; populate it incrementally as you collect reference layouts.

---

## v1.0.104 — 2026-05-17

**Niche-templated thumbnail composer (prayer ships the first template)**

User shared the Abiding Faith thumbnail layout — left subject portrait, right bold all-caps title, bottom "NIGHT PRAYER" with horizontal rule, top-left brain-cross logo — and asked: *"do we have a text editor applicator? like we can also add thumbnail editor/fixer-upper?"* v1.0.104 ships exactly that. Generate a thumbnail portrait → click **✏️ Compose with text…** → get back a thumbnail with the niche's text shape baked in. Character image stays; only the overlay is rendered fresh, so you can re-compose freely with different titles or after re-rolling the portrait.

### New niche schema

- **`Niche.thumbnailTemplate`** — declares the text-overlay layout for the channel's thumbnails. Fields:
  - `aspectRatio` + `canvas` — defaults to 1920×1080 (YouTube 16:9). Shorts (9:16) and square (1:1) are reserved.
  - `backgroundDimGradient` — optional gradient overlay on one side of the canvas for text legibility. Prayer uses `side: right, coverage: 0.6, strength: 0.72` to darken the right where the title sits.
  - `textZones[]` — each zone declares position (`x: left/center/right` + `y: top/middle/bottom` + offsets), `maxWidth`, font stack (`fontFamily` + `fontSize` + `fontWeight`), uppercase/letter-spacing, drop shadow, and the new **`wrapTuningMultiplier`** knob (see below). `name: 'title'` substitutes the episode title; `name: 'subtitle'` falls back to the zone's `defaultText`.
  - `accentStrokes[]` — decorative horizontal rules.
  - `logoSlot` — anchor + size for an optional channel-logo overlay.
- **`ThumbnailTextZone.wrapTuningMultiplier`** — Node has no librsvg font-metric readback, so the composer estimates character widths from a per-class table (narrow `i`/`l`/`1` vs wide `M`/`W`/`m`/`w`) tuned for Impact / Arial Black at YouTube thumbnail scale. When a custom font wraps too early or too late, dial this knob up (>1) to fit more text per line or down (<1) to wrap sooner — no code change, just edit the niche JSON.

Future niches drop a JSON with the same shape; zero code changes downstream. Niches without a `thumbnailTemplate` just show a one-line warning in the Compose dialog with a deep link to Settings → Niche.

### Backend

- **`POST /api/projects/:slug/episodes/:code/thumbnails/compose`** — new route in `routes/images.ts`. Body: `{ source_filename, title_text?, subtitle_text?, logo_path? }`. Resolves the project's effective niche, throws 422 if no `thumbnailTemplate` (with a copy-paste pointer to the prayer.json reference), composites via sharp + SVG, writes `${source}_composed_v{N}.png` next to the source so the picker grid auto-sorts the new file alongside its parent.
- **`lib/thumbnail-composer.ts`** — pure helper for the SVG/composite logic. Handles gradient direction (`side: left/right/top/bottom/full`), accent-stroke positioning, multi-line text wrap with per-character width estimation, optional `<feDropShadow>` filter per zone, and the optional logo overlay (resized to `logoSlot.width`, composited at the anchored position).

### Frontend

- **`ThumbnailComposeDialog.vue`** — new component, mounted on the Images page. Opens from `✏️ Compose with text…` on the thumb grid header. Fetches `/effective-niche` on open and adapts the form: source-thumbnail picker, title-text input (defaults to the episode title), subtitle-banner input (defaults to the niche's `defaultText`), and — when the niche template declares a `logoSlot` — a **channel-logo picker** that uses the existing `pickFile()` composable and saves the chosen path to the project's config (`channel_logo_path`). Pick once, reuse for every compose in this project.
- **Inline preview + one-click pin.** After a successful compose, the dialog renders the composited image inline with `📌 Pin this for upload`. Pin → toasts "Pinned for upload" and updates the grid badge without a page reload. Re-compose with different text any time; each compose writes a new versioned file so you don't lose previous attempts.
- **Wrap-policy hint.** When the niche template has a `title` zone, the hint under the title field reads e.g. *"Rendered as ALL CAPS, wrapped to fit a 980px column at 132px."* so you can predict the layout before composing.

### Prayer niche template (first one populated)

Matches the user's reference layout:
- Right-anchored 132px Impact title, dimmed-right gradient (60% coverage, 72% strength) for legibility on lit-background portraits
- Centered 68px subtitle banner at the bottom with 18px letter-spacing (`NIGHT PRAYER`)
- 520px horizontal accent rule above the subtitle banner
- Top-left logo slot at 132×auto, 56px in from each edge

### Audit pass

- `tsc -p electron --noEmit`: 0 errors
- `cd frontend && npx nuxt build`: clean
- Niche JSON parses with both the new `thumbnailTemplate` and the legacy fields

### What's NOT in this release

- **Logo design + supply.** v1.0.104 lets you PICK a logo file; it doesn't generate one. You supply your own PNG with transparency.
- **Other niches' thumbnailTemplate.** Only `prayer.json` is populated. Every other niche keeps working as-is; the Compose dialog just shows the no-template banner with a Settings link.
- **Real font metric readback.** Estimator is heuristic with a tuning knob; the day a custom font wraps wrong, dial `wrapTuningMultiplier` instead of waiting for a code change.

---

## v1.0.103 — 2026-05-17

**Niche-as-first-class, round 2: prayer-channel script structure + description voice + two UX papercuts**

User shared a full real prayer-channel video script (3 sections: Reflection & Invitation → Prayer of Protection → Declaration & Blessing) plus the matching YouTube description (🙏 emoji, 25+ hashtags, "You are never alone" benediction) and asked: *"can you help me make sure my abiding faith style script structure and the metadata can be adaptive to this formats?"* This release adds two new niche-level schema layers so prayer (and every future niche) owns its own script shape AND its own description voice — without code changes.

### New niche schemas

- **`Niche.scriptStructure`** — declares the structural shape the script generator should follow. Fields: `defaultChapterCount`, `chapterCountRange`, `pacingArc` (per-section beats), `additionalRules` (appended to the format's script rules). Prayer ships with 3 chapters in a 3-5 range, a pacing arc of `Reflection & Invitation → Prayer of Protection & Strength → Declaration & Blessing`, and 7 additional rules covering POV switching ("you" → "we" in the middle act), the scripture-anchor rule, an "Amen" pause after each chapter, denomination-neutrality, and the repetition pattern the user's reference scripts actually use.
- **`Niche.metadataDescription`** — declares the description-shape voice. Fields: `voiceGuidance`, `descriptionShapeRules`, `closingBenediction`, `ctaShape`. Prayer ships with pastoral second-person voice rules ("single 🙏 emoji, no all-caps hype, no SleepStory hashtags"), a warm-pastoral CTA tone, and `closingBenediction = "You are never alone. God's peace is with you always."` — which the LLM now anchors as the final non-hashtag line of every prayer-channel description.

Both override structures merge through `applyNicheToFormat()` the same way every other niche-level field does. Future niches just drop a JSON file in `electron/server/niches/` populating these blocks — zero code changes.

### Backend wiring

- **`models/types.ts`** — added `Niche.scriptStructure?` and `Niche.metadataDescription?`. Added a mirroring `Format.metadata.descriptionShape?` so the merged-format payload carries the niche voice into the prompt builder.
- **`services/format-loader.ts`** — `applyNicheToFormat()` extended. `scriptStructure` fields REPLACE format defaults; `additionalRules` APPENDS so format-level rules still apply. `metadataDescription` becomes `format.metadata.descriptionShape` so downstream prompt builders see one stable surface.
- **`lib/metadata-prompt.ts`** — the YouTube-description prompt now leads with a `CHANNEL VOICE` block built from `descriptionShape`, BEFORE the section instructions. Without this, prayer descriptions were still inheriting sleep-story phrasing because the section instructions read top-to-bottom and the niche voice was buried at the end. Voice first, sections second.

### Frontend UX papercuts

- **Banner clip** under macOS traffic lights — the unclean-shutdown banner was being chopped by the `hiddenInset` title bar at the dashboard header. `padding-top: 0 → 16px` on `.main-content` so banners clear the title-bar overlay region cleanly.
- **Script Outline Review — cursor-jump bug** — typing space or Enter inside a chapter's "Key facts" or "Beats" textarea was jumping the cursor to the end of the last word. Cause: the textarea was bound via `:value="arr.join('\n')"` + `@input` that re-split → mutate → re-stringify on every keystroke, which Vue saw as a content replacement and re-positioned the cursor. Fixed with a per-row buffer pattern (`Record<number, string>` keyed by chapter `n`), commits on blur. No split/trim/filter until the user leaves the field. Same fix for both Facts and Beats columns.
- **Script Outline Review — Expand silently failed when outline was still in Draft** — clicking Expand on a Draft outline produced nothing visible. Cause: button was `disabled` when `!canExpand` (which required `approvedAt`), no surfacing of why. Fixed: button stays enabled, gets an amber `is-needs-approval` style so the state is visible, and clicking opens an inline confirm: *"This outline is still in Draft. Approve it and expand?"* → one click does both.

### Audit pass

- `tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build`: clean.
- `prayer.json` parses with both new schemas; legacy niche JSONs (no `scriptStructure` / `metadataDescription`) pass through unchanged.

### What's NOT in this release (intentional)

- **Phase 3 — thumbnail composer.** The user shared a thumbnail template alongside the script/metadata (left subject portrait, right bold all-caps title, bottom "NIGHT PRAYER" with horizontal rule, top-left logo). A niche-templated thumbnail-text overlay endpoint + Compose modal on the Images page is designed but deferred to v1.0.104 to keep this release focused on the two structural-prompt fixes that ship value end-to-end today.
- **Other niches' scriptStructure / metadataDescription.** Only prayer.json is populated — the rest of the niche library can adopt these blocks incrementally as concrete scripts arrive (true-crime, listicle, educational, etc.). The fields are optional; legacy niches keep working as-is.

---

## v1.0.102 — 2026-05-17

**Comprehensive sweep: every remaining sleep-story-era hardcoded assumption removed**

User: *"i want our new planned route to focus on flexibility and remove hardcoded feature and instead apply niche/type based settings to match and adapt for future niche expansion as well."*

Three-surface audit (backend + frontend + migrations/tests) found 15 concrete items. v1.0.102 fixes them all, plus adds two new Format schema fields so future format authors get the right defaults out of the box.

### Schema additions (Format.script)

- **`defaultWordsPerMinute`** — Each format declares its own narration pace. Sleep-story 122 (slow); broll-narration / mindfulness / kids 130 (breath-paced); listicle 155 / comedy 165 (fast); etc. Replaces the hardcoded `122` in `scripts.vue` which was making prayer/devotional projects estimate word counts at the wrong pace.
- **`videoDefaults.defaultTimelineClipDurationSeconds`** — Each format declares a sensible default for new manually-added timeline clips on the Video Assembly page. Sleep-story keeps the 7200-sec (2-hour) ambient bed; broll-narration is 600 (10 min); listicle/educational/kids-fairytale 60; etc. Was hardcoded `?? 7200` everywhere, giving prayer projects a 2-hour black-screen default on every new clip.

All 10 format JSONs populated with both new fields. Format JSON authors of future custom niches just set them — zero code changes needed downstream.

### Backend fixes

- **`routes/scripts.ts:827 + :1014`** — `max_chars || 5000` fallback now reads `format.metadata.defaultMaxChars` first (matches the pattern in `pipeline.ts:414` which was format-aware already).
- **`lib/metadata-prompt.ts:197`** — Hardcoded `['#SleepStory', '#BedtimeStory']` hashtag fallback removed. When neither user config nor format ship hashtag examples, the prompt now asks the LLM for "N relevant hashtags derived from this specific episode's subject matter" instead of biasing toward sleep-story.
- **`routes/ideas.ts:735`** — Paste-ideas validator's `'45 min'` fallback for missing `suggested_length` is now passed in from the caller, which reads `format.script.defaultLengthMinutes` (10 min for broll-narration, etc.). Signature: `validatePastedIdea(raw, idx, defaultLengthMin = 45)`.
- **`generators/image-prompts.ts:112`** — Last-resort `return 10` chapter fallback now consults `format.script.defaultChapterCount` first (1 for broll-narration's single-continuous narration; 10 for sleep-story; per-format for everyone else).

### Frontend HIGH (silently producing wrong-flavoured output)

- **`scripts.vue`**: `wordsPerMinute` was a hardcoded `const 122`; now a computed reading `formatContext.defaultWordsPerMinute` (legacy 122 fallback). All 6 call sites updated to `.value`. Total-words estimation, duration-from-words snap, and the "~N w/m" badge all reflect the format's actual narration pace.
- **`ideas.vue`** Add/Edit Idea editor: `suggested_chapters: 10` + `suggested_length: '45 min'` form defaults are now computeds reading `activeFormat.script.defaultChapterCount` / `defaultLengthMinutes`. The `FormatLite` type gained an optional `script` block so the data is typed properly.
- **`video-assembly.vue`** new manual timeline clip: `duration_sec ?? 7200` becomes `duration_sec ?? formatDefaultTimelineClipDurationSec.value` — hydrated from `format.script.videoDefaults.defaultTimelineClipDurationSeconds` during the existing `applyVideoFormatDefaultsIfNoPreset()` pass.

### Frontend MED

- **Silent `'sleep-story'` format-id fallbacks** in `scripts.vue`, `image-prompts.vue`, `video-assembly.vue`: defensive fallbacks for the rare case where `project.format_id` is missing/corrupt. The fallback stays (sane safety net) but now logs a `console.warn` so debug-mode catches the case. Production with healthy project meta sees no change.
- **`metadata.vue` Tags placeholder**: hardcoded `"e.g. sleep story, bedtime story, relaxation"` replaced with a computed reading `format.metadata.broadKeywords` (top 5). Prayer projects now see `"e.g. prayer, devotional, daily prayer, christian meditation, morning prayer"` etc.

### Audit pass

- `tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build`: clean.
- All 10 format JSONs parse with the two new fields.

### What's NOT in this release (intentional)

- `index.vue:1335` — `DEFAULT_FORMAT_ID = 'sleep-story'` for new-project creation. That's a sane default for "user just installed the app and hasn't picked a format yet" and changing it would require a different UX (mandatory format picker at create time).
- `scripts.vue:1297` — `ep.suggested_length === '60 min' ? 60 : 45` narrow code path for parsing episode legacy data. Low-impact + hard to reach.
- Comments referencing "sleep-story default" in various files — documentation only, no runtime impact.

---

## v1.0.101 — 2026-05-16

**Script Generator's Duration dropdown is now format-driven**

User reported: *"inside the script generator for the prayer video... the default there didn't follow. it's also hardcoded for sleep stories and it defaults to 45 minutes script."*

The Duration dropdown shipped a hardcoded sleep-story-flavoured option list — `15 / 20 / 30 / 45 / 60 / 90 minutes` — even though the format-default hydration (added back in v1.0.72) correctly read each format's `defaultLengthMinutes` and updated `form.length`. For broll-narration (prayer / devotional / motivation projects with `defaultLengthMinutes: 10`), the form value was correct (10) but the dropdown showed `Custom...` selected with `10` in a custom input — confusing and wrong-flavoured.

Same architectural pattern as v1.0.95's `IdeaPromptShape` refactor: lift the hardcoded behaviour into format JSON. Each format now ships a `script.durationPresets: number[]` field with values appropriate to its typical episode length:

| Format | Duration presets (minutes) |
|---|---|
| broll-narration | 5, 8, 10, 15, 20, 30 |
| bound-explainer | 8, 10, 12, 15, 18 |
| kids-fairytale | 10, 15, 20, 25, 30, 40 |
| educational | 15, 20, 30, 45, 60, 75 |
| comedy | 10, 15, 20, 25, 30, 45, 60 |
| documentary | 20, 30, 45, 60, 75 |
| listicle | 10, 15, 20, 30, 45, 60, 90 |
| sleep-story | 20, 30, 45, 60, 90, 120 |
| adventure | 20, 30, 45, 60, 90, 120 |
| true-crime | 25, 30, 45, 60, 75, 90 |

Each format's `defaultLengthMinutes` is present in its own preset list, so on fresh project load the dropdown reflects the format's natural default (broll-narration shows `10 minutes` selected, not `Custom...`).

**Scripts page changes**:
- `<select v-model="durationSelect">` options are now rendered from `durationOptions` (a computed from `formatContext.durationPresets`)
- The hardcoded `STANDARD_DURATIONS = new Set([15, 20, 30, 45, 60, 90])` constant is gone. The "is this a recognised preset?" check now reads from `standardDurationSet` (also computed from the format's `durationPresets`).
- Custom input `max` bumped from `180` to `240` so users on a long-form format with a custom value have room to type larger numbers.
- Plural-aware label: shows `1 minute` not `1 minutes` if anyone ever sets a single-minute preset.

**Authoring future formats**: when you add a new format JSON later, set `script.durationPresets` to the duration values the user is most likely to pick. The default should appear in the list. Without the field, the dropdown silently falls back to the legacy sleep-story set so existing custom formats keep working.

**Audit pass**
- `tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build`: clean.
- All 10 format JSONs parse cleanly with the new field.

---

## v1.0.100 — 2026-05-16

**Unclean-shutdown banner now auto-dismisses after 30s**

The "Story Studio quit unexpectedly last time. Some jobs may not have finished — review them in Jobs" banner used to sit at the top of every page after a crash until you manually clicked ✕. Across multiple navigations within the same session it became visual noise.

v1.0.100 changes it to a 30-second auto-dismiss with a visible countdown chip on the right (`30s`, `29s`, …) and a thin yellow progress bar along the bottom that drains over the window. After the countdown expires, the banner persists the dismissal (same write the manual ✕ already did) so it doesn't re-appear within the same crash-recovery session. A fresh crash sets a new `unclean_shutdown` flag and the banner returns — that's the only way it comes back.

Manual ✕ still works for immediate dismissal. No backend changes — the `PATCH /last-session { unclean_shutdown_dismissed: true }` call is the same; only the trigger surface changed.

**Audit pass**
- `cd frontend && npx nuxt build`: clean.
- Banner tested with `unclean_shutdown=true` on the dev branch — countdown ticks, progress bar drains, banner disappears at 0s.

---

## v1.0.99 — 2026-05-16

**Server-mode audit pass — tests, diagnostic surface, mirror-folder workflow**

The Mac-mini-as-render-server feature has been shippable for a while (auth, session-cookie, file-system gating, SSE-over-LAN, portable paths all work) but had zero test coverage and no in-UI diagnostic when you're connected from another machine. v1.0.99 closes those gaps before you start depending on it for real renders.

**Regression tests (25 / 25 passing)** — new `electron/server/__tests__/auth-session.test.ts` + `security-host-guard.test.ts`:
- `hashPassword` / `verifyPassword` roundtrip, wrong-password rejection, malformed-stored-hash safety, distinct-salts-per-call
- `signSession` / `verifySession` roundtrip, tampered-body rejection, expired-cookie rejection, wrong-secret rejection, malformed-input safety
- `parseCookieHeader` handling of multi-cookie headers + whitespace
- `checkLoginRateLimit` allowing 5 / blocking 6th, per-IP independence
- Host-header guard allowing loopback variants, blocking external hosts (DNS-rebind), bypassing entirely in server mode

These tests run as part of `npm run test:backend` so future refactors of the auth or security layers can't silently regress the Mac mini deployment path.

**Server Status diagnostic card** in Settings → Server Mode:
- Live readout from `GET /api/server-info` showing bind, port, uptime, credentials-configured boolean, session TTL, platform/Node version
- One-click **↻ Refresh** so you can confirm the daemon is alive from your laptop without SSHing in
- Endpoint is intentionally unauthenticated and safe: returns booleans for credential state (never hash material), and the bind/port info is what the user typed into the URL to reach the page

**`SERVER_MODE.md` updates**:
- New "Mirror your folder layout on both Macs (recommended)" section explaining the laptop-vs-mini picker mismatch and the simple workflow workaround (identical `~/Projects/StoryStudio/` paths on both machines via iCloud / rsync / Syncthing). The portable-path layer handles assets INSIDE a project; mirror-folder handles the root.
- New "Diagnostic from anywhere" subsection pointing at the new Settings card

**No code-path bugs found** during the audit. Code is well-architected:
- `loadServerModeConfig()` correctly prioritises explicit `enabled: false` from the JSON over the env var (lets you disable from the web UI without SSHing in to unload launchd)
- `requireSession` middleware has the right loopback bypass — local Electron window on the mini works without a login dialog
- `requireAllowedHost` correctly bypasses in server mode (Tailscale + session auth take over from DNS-rebind defence)
- File-system endpoints (`/system/browse-dir`, `/system/validate-path`, `/system/pick-*`) all sit BELOW `requireSession` in `app.ts` — properly gated
- SSE streams over LAN with 15s keepalive — no localhost-only assumptions
- Scrypt + timing-safe-compare on password verify, HMAC-SHA256 on session signing — both correct

**Audit pass**
- `tsc -p electron --noEmit`: 0 errors.
- `npx tsx --test electron/server/__tests__/auth-session.test.ts electron/server/__tests__/security-host-guard.test.ts`: 25 / 25 passing.
- `cd frontend && npx nuxt build`: clean.

---

## v1.0.98 — 2026-05-16

**Niche vocab now surfaces in the Ideas Generator chip inputs and Randomize**

Real bug spotted on the prayer project: v1.0.97 added 133 prayer-specific keywords to `prayer.json` (Lord, Sabbath, "Prayer Before Bed", "the lonely", etc.), but clicking the Keywords chip-input on the Ideas Generator showed ONLY broll-narration's 105 format-level keywords — the niche pool was invisible. Same for the genre / mood / theme chips: format-only.

Root cause: `vocabFor()` in `ideas.vue` read exclusively from `activeFormat.idea.{genre,mood,theme,keyword}Vocabulary`. The backend's `applyNicheToFormat()` merges niche vocab into the format for the LLM prompt, but the frontend's `/formats` endpoint returns raw (un-niche-merged) format objects. So the LLM saw the merged pool, the UI didn't.

Fix:
- `vocabFor()` now merges format pool + active niche pool (de-duplicated) client-side, mirroring the backend's merge. The Keywords chip input on a prayer-niche project now shows ~238 unique entries (105 format + 133 niche, with overlaps de-duped) instead of 105.
- **Randomize** picks from the merged pool too — so a Randomize click on a prayer project pulls from prayer-specific vocab ("Sabbath", "the weary", "Prayer Before Bed") instead of only generic broll-narration vocab ("morning", "evening", "family").
- The "From {Source}" label next to each chip-input field now reads `B-Roll Narration + Prayer` when both contribute, `Prayer` when only the niche has vocab for that field, `B-Roll Narration` when only the format does. Tooltip explains the merge.

**No backend changes.** The LLM prompt assembly was already correct — only the frontend visibility was lagging.

**Audit pass**
- `tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build`: clean.

---

## v1.0.97 — 2026-05-16

**Massive vocab expansion across every niche + every format**

The Randomize button picks one genre + one mood + one theme + one audience + 3-5 keywords on each click. With keyword pools of 13-35 entries (the prior baseline), random combinations got repetitive fast. v1.0.97 expands every vocab pool — keywords most heavily, with mood and theme bumped modestly along the way — so each Randomize click pulls from a much wider, niche-appropriate vocabulary.

**New keyword counts (was → is):**

| | Niches | |
|---|---|---|
| prayer | 20 → **133** | spiritual needs, life situations, scripture concepts, times, people-to-pray-for |
| devotional | 14 → **110** | books of the Bible, biblical figures, specific passages, theological concepts |
| motivation | 15 → **108** | discipline concepts, habit-design vocab, finance/fitness/career touchstones, named authors |
| preaching | 14 → **109** | books, figures, doctrines, expository concepts, parables |
| psychology | 14 → **110** | cognitive biases, attachment styles, neurochemistry, therapy modalities, named researchers |
| philosophy | 17 → **109** | schools, named philosophers, key concepts in each tradition, primary texts |
| mindfulness | 13 → **101** | breath techniques, body parts, awareness states, MBSR/MBCT terminology, named teachers |
| history-narration | 15 → **128** | named civilizations, figures, eras, locations, primary sources |
| animals | 21 → **103** | species, behaviors, anatomical structures, ecological concepts, named extremes |
| plants | 20 → **96** | photosynthesis modes, structures, dispersal, named species, allelopathic vocab |
| fungi | 19 → **102** | spore biology, named species, decay types, host-jumping vocab, fermentation lineage |
| insects | 20 → **108** | metamorphosis, venom delivery, named species, parasitoid behaviors |
| | Formats | |
| sleep-story | 35 → **100** | cozy nouns, rural rhythm, atmospheric items, slow-pace verbs |
| listicle | 30 → **120** | listicle-friendly subject domains (illusions, paradoxes, weird animals, cold cases) |
| bound-explainer | 25 → **87** | anatomical handicaps, ecological niche failures, named hardships |
| broll-narration | 14 → **105** | spoken-word topics across prayer/devotional/motivation/mindfulness — covers every niche on this format |
| documentary | 29 → **101** | named sites, primary sources, methodologies, named cases |
| educational | 28 → **108** | named phenomena, principles, named studies, methodology terms |
| comedy | 25 → **97** | bureaucratic absurdities, corporate jargon, small-town irritations |
| adventure | 25 → **103** | named locations, named extremes, equipment, danger vocab |
| true-crime | 28 → **115** | forensic methods, named procedures, surveillance vocab, witness types |
| kids-fairytale | 32 → **116** | gentle creatures, magical objects, simple settings, kindness-friendly props |

**Mood and theme pools also bumped** across every file (modestly — typically +10-20 entries per pool). Genre pools left mostly as-is since those are well-bounded by nature.

**Authoring future niches**: when you add a new niche later, fill `vocabulary.mood`, `vocabulary.theme`, `vocabulary.genre`, and `vocabulary.keyword` as generously as you can. The Randomize button pulls from the union of format + niche pools, so more entries = more variety per click without changing any code.

**Audit pass**
- All 22 niche + format JSONs parse cleanly.
- `tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build`: clean.

---

## v1.0.96 — 2026-05-16

**Niche / Pattern hierarchy now reads top-down on the Ideas Generator**

The three layers of control that drive idea generation —

- **Layer 1 · Format** (`what shape of video`: sleep-story / broll-narration / listicle / bound-explainer)
- **Layer 2 · Niche** (`what subject domain`: prayer / motivation / plants)
- **Layer 3 · Pattern** (`specific title template`: "Fall asleep to {X}")

— should read top-down in the form too. v1.0.96 swaps the Pattern picker and Niche picker on the Ideas Generator so Niche sits above Pattern. Niche is broader (filters the entire prompt's vocab + example bar + title shape rules); Pattern is narrower (locks the title template within that niche). The previous order had Pattern first, which made the picker feel like Pattern was the more dominant control — opposite of how the resolution actually works.

**Niche library merged into Settings → Niche**

There were two separate niche surfaces:

- The **sidebar /niches page** — full library: browse all niches, view example topics + script context + visual style, create custom niches, delete custom niches.
- The **Settings → Niche tab** — read-only picker: pick one niche to assign to the current project.

Both gone as separate surfaces. The Niche tab inside Settings now has two sub-tabs:

- **Project niche** — the picker + Save flow (same as before).
- **Niche library** — the full browse / create custom / delete custom flow (moved over from the sidebar page). Each tile shows: name + tagline + description, example topics, vocabulary stats, title-rule count, generator context, plus a "Use on this project" button that flips the picker over in one click.

The sidebar's "🌽 Niches" link is gone. Old bookmarks/deep-links to `/niches` land on a friendly "moved" stub that points back at the projects list. One source for niche stuff: each project's Settings.

**Niche tile shows v1.0.95 title rule count**

Each niche card in the library now shows how many `titleShapeRules` it ships with (e.g. `21 title rules` for prayer, `16` for devotional). Custom niches with no rules show no badge — that's fine, the format defaults still drive the prompt. Useful for spotting at a glance which niches are "strict" vs "lenient" without opening the JSON.

**Audit pass**
- `tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build`: clean.
- All routes resolve; `/niches` deep-link lands on the moved-stub page.

---

## v1.0.95 — 2026-05-16

**Architectural refactor: every format and niche now owns its own LLM prompt shape**

User said: *"i need each format for each niche to stay within their own niche and new niche or format will have it's own applied structure instead. does this mean a lot of refactor? if so i think should must still do it."* — and they were right. The prior versions had hardcoded English assumptions baked into `buildPrompt()` (the LLM-prompt assembler) that were written when sleep-story was the only format. Niche/format overrides were retrofitted as escape hatches and kept leaking the sleep-story voice into prayer/devotional/motivation channels.

v1.0.95 removes ALL hardcoded title/logline/theme assumptions from the prompt builder. Every voice rule now lives in the format JSON or the niche JSON. New niches you author later just write a JSON file — zero code changes.

**The new IdeaPromptShape (six optional fields on both Format.idea and Niche)**

```ts
{
  titleShapeRules?: string[]                    // hard rules dropped verbatim into the prompt
  titleLengthRange?: [min, max]                 // word count
  loglineShapeRules?: string[]
  loglineSentenceRange?: [min, max]
  themeShapeRules?: string[]
  themeCountRange?: [min, max]
  structuralVariety?: 'free' | 'vary-all' | 'vary-subject-only'
}
```

Niches override formats on any field they set. Unset fields fall through to the format default. Unset on the format too → minimal lenient prompt fallback that just points the LLM at the example ideas as the bar.

**The 10 format files now own their style:**

- `sleep-story` — Literary evocative noun phrases. `"The {Noun}'s {Noun}"`, `"The {Adjective} {Place}"`. `structuralVariety: vary-all`.
- `listicle` — Number-led counts. `"{N} {Plural Subject} Explained"`. `vary-all`.
- `bound-explainer` — Channel signature lock. `"Why It Sucks To Be Born As {Species}"` exclusively. `vary-subject-only`.
- `documentary` — Real subjects, attribution-rich. `"The {Subject} of {Place} Who {Verbed}"`. `vary-all`.
- `educational` — Question-led. `"Why {Phenomenon}: {Angle}"`, `"The Hidden {Aspect} of {Familiar Thing}"`. `vary-all`.
- `comedy` — Specific absurd situations. `"The {Subject} That {Absurd Thing}"`. `vary-all`.
- `adventure` — Immediate stakes. `"{N} Days Adrift in {Locale}"`, `"The Last {Event} of {Place}"`. `vary-all`.
- `true-crime` — Evidence-led. `"The {Object} That Solved {Case}"`, dignity rules for victims. `vary-all`.
- `kids-fairytale` — Cute creature + gently-funny problem. `"The {Creature} Who {Action}"`. `vary-all`.
- `broll-narration` — Intentionally LENIENT (your choice). The 8 niches under it each own their own title shape.

**The 12 niche files — 8 with explicit title rules:**

- `prayer` (21 rules, length 3-9) — `"Prayer for X"`, `"Morning/Evening Prayer for X"`, etc. Forbidden: nature/scenery modifiers, atmospheric adjectives, allegorical objects.
- `devotional` (16 rules, length 4-10) — Scripture-anchored teaching. `"A Thought on {Book Ch:Verse}"`, `"{N} Lessons from {Ref}"`.
- `motivation` (length 3-8) — Discipline-leaning. `"Why X Beats Y"`, `"The {N}% Rule"`, `"Show Up When X"`.
- `preaching` (length 4-11) — Passage-anchored. `"What {Author} Means by '{Quoted Phrase}'"`, `"{N} Truths from {Book Ch}"`.
- `psychology` (length 4-10) — Behavior-led. `"The Real Reason You {Behavior}"`, `"What {Phenomenon} Actually Is"`.
- `philosophy` (length 4-11) — Thinker-on-topic. `"{Philosopher} on {Topic}"`, `"The Stoic View of {X}"`.
- `mindfulness` (length 3-9) — Practice + duration. `"A {Duration} {Practice}"`, `"{Technique} for {Situation}"`.
- `history-narration` (length 4-11) — Specific event/figure. `"The Real Reason {Specific Event}"`, `"What {Place} Actually Looked Like"`.

Plant/animal/fungus/insect niches stay simple — they ride on the `bound-explainer` format's `"Why It Sucks To Be Born As {Species}"` shape without needing their own overrides.

**The prompt builder is now a thin reader**

`buildPrompt()` in `routes/ideas.ts` was 60 lines of hardcoded English ("title — evocative, 5–10 words; pick adjectives that fit the format's tone", "No two titles may share the same noun+preposition structure", etc.). Now it's a thin assembler that reads `format.idea.{titleShapeRules,titleLengthRange,loglineShapeRules,...}` and emits the prompt. When a field is set, that rule lands verbatim. When unset, a minimal lenient fallback ("title matches the EXAMPLES above") takes its place.

Backend log line per generation now shows all the active rules:

```
[ideas-gen] effective: format=broll-narration niche=prayer examples=19 title{rules=21,len=3-9w} logline{rules=0} themes{rules=0} variety=vary-subject-only prefix="Daily Prayer | " suffix=""
```

This makes future regressions of the "prayer titles are coming out poetic" class catchable from a single log line.

**Authoring a new niche or format = writing one JSON**

To add a new niche the user invents later — say "trivia-shorts" or "sourdough-baking" — they just create a JSON file in `electron/server/niches/` with the niche metadata + the `titleShapeRules` / etc. fields tuned to that niche's voice. Zero code changes needed.

**Audit pass**
- `tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build` (Vite prod): clean.
- All 10 format JSONs + all 12 niche JSONs parse cleanly.
- Prayer-niche project on broll-narration format: titles should now match the AF001-AF020 reference bar (no "Sunset's Edge" / "Moonlit Waters" / "in the Garden" decoration).

---

## v1.0.94 — 2026-05-16

**Niches can now lock the SHAPE of generated titles (real prayer titles, not "Prayer at Sunset's Edge")**

v1.0.93 wired the prayer niche's example topics into the LLM prompt + made the niche lead the prompt voice. Titles improved but still came out poetic ("Daily Prayer | Prayer for Healing at Sunset's Edge", "A Quiet Prayer in the Garden", "Reflections of Hope in Moonlit Waters"). Investigation showed the actual culprit was buried in the prompt's generic title instructions:

- Line 240 of `buildPrompt()`: `"title — evocative, 5–10 words; pick adjectives that fit the format's tone"` — the LLM read "evocative" as "use poetic imagery", "5–10 words" forced padding (a 3-word "Prayer for Strength" got bulked out to "A Prayer at Sunset's Edge"), and "pick adjectives from mood vocab" decorated every title with "Reflective", "Quiet", "Gentle".
- Line 249's rule: `"No two titles may share the same noun+preposition structure"` — for a prayer channel this rule is EXACTLY WRONG. Real prayer channels repeat "Prayer for X" intentionally as the channel signature (your reference: AF001-AF020 all share that structure). The rule was actively pushing the LLM to diverge into nature metaphors to "vary".

Fix: niches gain two new fields:

- **`titleShapeRules: string[]`** — When set, REPLACES the generic title instruction block in the Ideas Generator's LLM prompt. Each string is dropped into the prompt as an imperative rule under a "TITLE RULES (niche-specific, MUST follow)" header. The prompt's "no two titles share structure" rule is also swapped for "vary only the SUBJECT, never the structure" when these rules are active.
- **`titleLengthRange: [min, max]`** — Optional word-count range override (prayer is 3-9 words; devotional is 4-10).

**Prayer niche** ships with 21 strict rules locking titles to the established shapes:
- `Prayer for X` · `A Prayer for X` · `Morning Prayer for X` · `Evening Prayer for X` · `Prayer Before X` · `Prayer of X`
- `X` is required to be a spiritual need, life situation, emotional state, or specific person
- Explicit FORBIDDEN list: no nature/scenery modifiers, no atmospheric adjectives in titles, no allegorical objects ("Pebble's Journey", "Whispers of…"), no possessive nature phrases ("A Bird's…", "The Piano Tuner's…")

**Devotional niche** ships with 16 rules locking titles to scripture-anchored teaching shapes:
- `A Thought on {Book Chapter:Verse}` · `Today's Verse: {Ref}` · `Why {Ref} Still Matters` · `{N} Lessons from {Ref}` · `What {Book/Figure} Teaches Us About X` · `A Devotion on X`
- Every title must point at a concrete scripture reference OR concrete pastoral teaching subject — no vague abstractions, no poetic decoration

Other niches (motivation, preaching, psychology, philosophy, mindfulness, history-narration) can opt in by adding `titleShapeRules` to their JSON. Without the field they continue to use the generic prompt — back-compat preserved.

**Backend debug-log line** now also reports whether niche title rules are active so future regressions are catchable from server output:

```
[ideas-gen] effective: format=broll-narration niche=prayer examples=19 titleRules=21 titleLen=3-9w prefix="Daily Prayer | " suffix=""
```

**Audit pass**
- `tsc -p electron --noEmit`: 0 errors.
- Prayer niche parses: 21 title rules, length range 3-9.
- Devotional niche parses: 16 title rules, length range 4-10.

---

## v1.0.93 — 2026-05-16

**Ideas Generator: stop reverting to sleep-story on every navigation**

A real, frustrating bug the user reported on the Abiding Faith prayer project. Four overlapping symptoms — form silently reverting to fantasy/sleep-story defaults on every tab switch, generated titles still flavoured like poetic nature content even with the Prayer niche set, saved ideas occasionally disappearing from the list, "project missing" flashes. Two independent read-only audits surfaced the root causes; this release fixes all four.

- **Preset auto-apply no longer races project state on Ideas.** `usePresets()` gained an `autoApplyOnLoad?: boolean` option (defaults true for back-compat). The Ideas Generator passes `false` — presets populate the dropdown but the form stays driven by the project meta until you click **Apply**. No more silent overwriting of your project's niche every time you navigate back.
- **One sequenced mount in `ideas.vue`** replaces five fire-and-forget `onMounted()` calls that used to race each other. Project state hydrates first; reference data + ideas list load in parallel after; presets load last (inert until applied).
- **Hydration error banners** surface every failure mode with a specific recovery action (Retry / "Open Format settings →" / "Back to projects"). Replaces the three `catch { }` blocks that used to swallow network blips and leave the page in a half-loaded state. `loadIdeas()` only updates the local list when the backend actually returned an `ideas` array — a transient blip preserves your previously-loaded view instead of blanking it.

**New "Effective channel state" card at the top of the Ideas Generator**

A small three-row card showing exactly what's driving the next generation:

```
Format     B-Roll Narration                       [Change]
Niche      prayer                                 [Change project niche]
Title wrap "Daily Prayer | <title>"
```

Falling-back values (e.g. `Format: sleep-story · ⚠ falling back — project meta has no format_id`) get a yellow warning chip with a one-click jump to where each is edited. You catch state drift BEFORE spending an API call. Replaces guesswork ("why are my prayer ideas about mountains?") with visibility.

**Niche now LEADS the LLM prompt, format supports**

Previously the niche merge appended its audience hint after the format's and never touched the Ideas page's `systemPromptRole` / `guidanceText`. The LLM read format vocab first ("calm, dream-like imagery") and niche vocab as a late afterthought → compromise outputs like "Daily Prayer | The Piano Tuner's Evening Prayer". Now `applyNicheToFormat()`:

- Prepends the niche's `scriptContext` to `idea.systemPromptRole` as a "NICHE CONTEXT — this is the dominant voice" block
- Prepends the niche's voice cue to `idea.guidanceText`
- Promotes the niche's `audienceHint` to the lead audience line (format audience trails in parens)

Niche owns the voice. Format owns the structure. For a Prayer-niche project on B-Roll Narration format, titles now actually land as "Morning Prayer for Strength" / "A Prayer for Anxious Hearts" — modelled on the niche's 19 example topics that v1.0.92's exampleTopics fix already exposed but the prompt's main guidance block was still drowning out.

**Per-device presets + apply-time path check on Audio Merge / Video Assembly**

A separate cross-device fix: presets that contain absolute file paths (intro/outro videos, music beds, logos, chroma sources, ambient tracks) no longer leak across Macs without warning.

- Every saved preset is now stamped with `machine_label` (hostname, same string the portable manifest already uses).
- Picker filters to "this Mac" by default; one-click toggle reveals presets from other Macs with a `· ⌂ <hostname>` chip per option.
- Legacy presets without a label pass through both views and are tagged `(legacy)` — re-save to claim them. No forced migration.
- New `GET /api/system/machine-label` endpoint surfaces the hostname; new `useMachineLabel` composable caches it module-level so all `usePresets()` instances share one fetch.
- New `usePresetPathValidation` composable round-trips every path field through the existing `/api/system/validate-path` endpoint and surfaces broken paths in an inline banner above the form with **Pick replacement** buttons per row. Audio Merge wires it to intro/music/ambience/noise picks; Video Assembly wires it to the bundle preset (intro/outro/title image/logo/chroma source/background plate/timeline clips).
- Cross-device banner appears separately on the picker when the active preset is from another Mac, even if no paths are broken — informs you before Generate.

**Niche promoted to its own Settings tab**

The NichePicker was nested inside Settings → Format as a sub-section, with no anchor in the top-level tab list. Several users couldn't find it (the exact bug the user reported on this project). Promoted to its own **"Niche"** tab between Format and Standards. The Format tab now shows a "Niche moved →" pointer card with a one-click jump for anyone landing in the old spot.

**Channel title prefix/suffix on Ideas Generator (synced with Metadata Generator)**

The metadata page already had a channel-level title wrap (`broll_channel_title_prefix` / `broll_channel_title_suffix` on project config). v1.0.93 extends the same wrap to the Ideas Generator using the same config keys — one source of truth for "Morning Prayer:" across both the brainstorm and the final YouTube title. Edit in either surface, both stay in sync. Live preview line so you see the result before clicking Generate.

**Niche `exampleTopics` now reach the LLM's example bar**

A niche file's `exampleTopics` array (e.g. prayer.json ships with 19 entries like "Morning Prayer for Strength", "A Prayer for Anxious Hearts") used to live only in the picker preview UI — the LLM never saw them. Now `applyNicheToFormat()` synthesises full `exampleIdeas` rows from the niche's topics (title from niche + themes/mood from niche vocab + chapter count/length from format defaults) and replaces the format's example ideas for that generation. The LLM matches output style to the niche's bar instead of the format's two generic examples.

**Backend debug-log line on every Ideas generation**

One line per generation in the server log: `[ideas-gen] effective: format=X niche=Y examples=N prefix="..."`. Catches future regressions of the "why are my prayer ideas about mountains?" class without parsing the full prompt.

**Audit pass (per the polish-quality-bar memory)**
- `npx tsc -p electron --noEmit`: 0 errors.
- `cd frontend && npx nuxt build` (Vite production build): clean.
- Backend `GET /api/system/machine-label`: returns current hostname.
- Niche merge: prayer.json's 19 `exampleTopics` now reach the LLM as `exampleIdeas` with synthesised theme + mood + chapter count.
- Manual smoke against a real prayer-niche project: titles land in the expected `Daily Prayer | Morning Prayer for X` shape after the changes.

---

## v1.0.92 — 2026-05-15

**Search inside every Episode Selector**

A 380-episode project's dropdown was unsearchable — the native `<select>` only supports "first letter jumps to next match," which is useless when you have 200 prayer episodes that all start with `EP`. v1.0.92 adds a real search input above the selector across every tab that uses it (Scripts, Audio, Subtitles, Images, Image Prompts, Video, Video Assembly, Metadata, Upload — every per-episode generator surface):

- Case-insensitive substring match against either the episode code (`TN0042`) or the title (`Morning Prayer for Anxiety`).
- "**N of M shown**" badge live-updates as you type so you can see how aggressive your filter is.
- Press **Esc** or click the **✕** chip to clear.
- Empty-results state is surfaced inside the placeholder option (`No episodes match "xyz" — clear search or adjust filter`) so a too-narrow filter never looks like a broken dropdown.
- Hidden entirely on small projects (≤5 episodes) — no clutter for the channels that don't need it.

**Auto-normalize on new B-Roll pools now defaults to OFF**

Previous default was ON, which silently kicked a long ffmpeg encode queue the moment you registered a fresh pool. For a 200-clip pool on an external SSD that's 1–3 hours of CPU + disk and you wouldn't know until you opened the (previously invisible — see v1.0.91) Pool jobs panel. Now the create-pool checkbox starts **unchecked**, with helper copy explaining the trade-off and pointing at the **⚡ Normalize all** button as the explicit path. Originals are never modified either way — normalized variants live alongside in `.broll-normalized/`.

**Per-clip and bulk rename on B-Roll Library**

Stock-footage clips arrive named `pexels-video-1234567-large.mp4`, which is unsearchable and unlovable. v1.0.92 adds two rename surfaces:

- **Per-clip ✏ Rename** — opens a small modal with live client-side validation (extension required, no path separators, no leading dot, no reserved chars). Renames the file on disk, follows the matching `.broll-normalized/` variant, and rewrites the sidecar entry atomically.
- **✏ Bulk rename** — toolbar action that opens a template-driven modal. Type a pattern like `prayer_{n:3}.{ext}` and see a **live preview** of the first 8 results before any disk write happens (`pexels-video-...` → `prayer_001.mp4`). Tokens supported: `{n}` (1-based index), `{n:NN}` (zero-padded), `{ext}` (original extension), `{orig}` (original basename), `{sha}` (first 8 chars of content hash). Per-row error surface on apply — collisions, invalid names, and "no change" all show with their reason in an expandable details panel.

**NichePicker on the Ideas Generator (per-batch override)**

The project's saved niche under Settings → Niche is your default flavour, but sometimes you want one batch of ideas in a different domain — generate 5 prayer ideas, then 5 motivation ideas, on the same channel, without bouncing back to Settings each time. v1.0.92 adds a niche dropdown inside the Ideas Generator form that defaults to the project's saved niche but lets you override it for this generation only:

- Pre-loaded with the project's saved `niche_id` so the picker reflects your current effective state out of the box.
- When you pick a different niche an inline **"↪ Overriding the project's saved niche (`<id>`) for this generation only"** banner appears with a one-click **Reset to project default** link.
- Picking **No niche** while your project has one saved sends `__none__` to force "no niche layer" for this call — the project meta stays untouched.
- Last-used override is persisted per-project so re-running the generator picks up where you left off.

Backend plumbing: `getEffectiveFormat[For]` now takes an optional `{ nicheIdOverride }` so any caller can layer a different niche per-request without persisting it on the project. The `/generate/ideas` route plumbs the picker's value through. Other niche-aware generators (script, images, metadata) continue to read the project's saved niche — only Ideas Generator surfaces the override for now.

**Audit pass (per the polish-quality-bar memory)**
- `npx tsc -p electron --noEmit`: 0 errors.
- `npm run build:frontend` (Vite production build): clean — caught nothing new but kept in the loop after v1.0.89's duplicate-`apiGet`.
- Every touched Vue SFC parses cleanly.
- New backend routes (`/clips/:filename/rename`, `/clips/rename-bulk`) covered by manual smoke against a real pool — single rename + bulk rename on a 12-clip test pool both moved disk + sidecar + `.broll-normalized/` correctly.
- Episode Selector search verified against a 380-episode TerraNash project: filter shrinks from 380 → 4 → 1 instantly as the user types.

---

## v1.0.91 — 2026-05-15

**B-Roll pool jobs are no longer invisible**

The B-Roll Library's normalize and auto-tag jobs were enqueued under the app-level scope (`project_slug='_app_'`), but the per-project Jobs panel filters by exact project_slug match. Net effect: every normalize / auto-tag job ran silently — no progress, no errors, no log lines reachable from the UI. Verified in this release against an existing pool: **101 such jobs** had run on your `nature-b-roll` pool and you had no way to see any of them.

Fix: new `/api/jobs/app` endpoint family that surfaces app-scope jobs alongside an SSE stream. Plus an inline **Pool jobs** panel on the B-Roll Library page that:

- Lists running + queued jobs at the top of the section, with live progress lines (ffmpeg time stamps for normalize, vision-LLM output for auto-tag).
- Shows the last 6 recent done / error / cancelled jobs underneath for trail context.
- Auto-collapses to a count badge when nothing's in flight; click the header to expand.
- Colour-codes status: running (blue), queued (grey), done (green), error (red).
- Streams via Server-Sent Events so updates land instantly with no polling.

**Clip grid auto-refreshes when relevant jobs finish**

Previously, after a normalize or auto-tag job completed, the user had to click ↻ Re-scan to see the new `✓ 24fps` badge or the new tags. Now the page subscribes to the app-jobs stream and refreshes the clip list automatically when any `broll_normalize` or `broll_autotag` job for the active pool transitions to done. Tags appear; normalized badges flip; no manual refresh needed.

**No regression risk**

The existing `/projects/:slug/jobs` route still filters by project_slug exactly — per-project Jobs panels stay clean. App-level jobs live in their own endpoint, and the new endpoint is purely additive.

**Audit pass (per the polish-quality-bar memory)**
- `npx tsc -p electron --noEmit`: 0 errors.
- Vue SFC parse: clean.
- `npm run build:frontend` (Vite production build): clean. ← *new in v1.0.91's audit checklist after v1.0.89's duplicate-`apiGet` slipped past dev-only smoke.*
- Endpoint smoke: `GET /api/jobs/app` returns 101 historical jobs from the user's real pool; new normalize job queued and surfaced within a second.

---

## v1.0.90 — 2026-05-15

**8 new niches for narration-led channels**

The `broll-narration` format is intentionally broad — any topic where the spoken word is the primary content and B-Roll is rotating ambient texture. v1.0.90 adds 8 built-in niches that compose with that format (or any other) to give the Ideas Generator + script generator + metadata pools real subject-domain context:

- **Prayer** — Christian prayer (morning / evening / family / anxiety / healing / protection). Pastoral tone, second-person address, short.
- **Devotional** — scripture-anchored reflections built around one passage. More instructional than raw prayer.
- **Motivation** — discipline / mindset / consistency narration. Direct, earned, not hustle-clichéd. Pairs with cinematic running / sunrise / weight-room B-Roll or stylised anime cuts for younger audiences.
- **Preaching** — short sermon-style exposition of a passage. Observation → interpretation → application structure.
- **Psychology** — pop-psych narration on habits, anxiety, cognitive bias, relationships. Research-grounded but jargon-free.
- **Philosophy** — Stoicism / Taoism / Buddhism / existentialism. Thoughtful, unhurried, ends in a question rather than a conclusion.
- **Mindfulness** — guided meditation / breath-paced practice / body scan. Breath cadence built into the writing itself.
- **History Narration** — short narrated history facts. Anchored to real dates / names / places; no contemporary political framing.

Pick any of these on a project's Niche dropdown at creation (or later via Settings). They merge cleanly with the existing 4 niches (Animals / Plants / Insects / Fungi) so explainer-format channels still work unchanged.

**Default to the idea title — only paraphrase on request**

Metadata Generator's title strategy now defaults to **Use idea title** instead of AI paraphrase. The title you picked at Ideas Generator time stays the title — no LLM rewrite, no surprise SEO variants. You can flip to AI paraphrase (the previous default) when you specifically want 5 SEO-rewritten alternatives to compare.

Also more honest on the metadata page: the radio options reordered with "Use idea title" first, and "AI paraphrase" labelled with what it actually does ("generate N SEO-rewritten variants and pick the first") instead of pretending to be the canonical mode.

**Channel-level title prefix (and improved suffix)**

New per-project **Channel prefix** + **Channel suffix** inputs that wrap every produced title — for any title mode. Saves you from retyping "Morning Prayer: " or " | Daily Prayer Channel" on every episode. Applied uniformly to:

- `use_idea_title` mode: `prefix + idea_title + suffix`
- `manual` mode: `prefix + manual_title + suffix`
- `paraphrase` mode: each of the N LLM-generated titles is wrapped too — channel consistency on every variant

Both fields are saved per metadata preset so different channels in your project list can carry different boilerplate. Live preview line shows the final wrapped output before you click Generate. The existing `metadata_template` path (Phase 4) still wins when set — it composes the full string from the template, no double-wrapping.

**Audit passes (verified before release)**
- `npx tsc -p electron --noEmit`: 0 errors.
- Every touched Vue SFC parses cleanly.
- New niches load through `/api/niches`: 12 total (4 original + 8 new) surface correctly.
- Metadata title flow tested: idea-title default + prefix/suffix wrapping renders as expected in the live preview.

---

## v1.0.89 — 2026-05-15

**B-Roll prayer-channel workflow (Phases 1-5 + polish)**

A complete narration-over-stock-footage pipeline for prayer / devotional / meditation channels. Five phases shipped end-to-end:

*Phase 1 — Pool Library* (sidebar entry: 🎬 B-Roll Library)
- Register one or more stock-footage pools, each pointed at a folder (typically your portable SSD). The app indexes every clip via ffprobe (duration, resolution, fps, sha256) and generates thumbnails at midpoint.
- Tags live in a `.story-studio-broll.json` sidecar inside the folder so they travel with the SSD across machines.
- Drop-in scan: drop new clips into the folder via Finder, click ↻ Re-scan — content-hashed so renames preserve tags + normalize state.
- Auto-normalize on import: each new clip queues a job that re-encodes to 1080p @ 24fps (or 30 if configured) at H.264 CRF 20, preserving the source audio for later mixing. The normalized variant lives in `.broll-normalized/` so originals stay untouched.
- Offline handling: when the SSD is unplugged the library shows clips with cached thumbnails + tags but disables scan/edit until reconnect.

*Phase 2 — `broll-narration` format*
- New built-in format that hides Scene Prompts / Scene Generator from the sidebar (irrelevant when your visuals come from a B-Roll pool, not AI image generation) and surfaces a 🎬 B-Roll Picker sidebar entry instead.
- Project subscribes to one pool via Settings or the picker page. Multiple projects can share a pool; their cross-episode repeat-avoidance histories stay independent.

*Phase 3 — Selection + assembly*
- Per-episode B-Roll picker page (`/projects/:slug/broll`) supports four selection modes: random (shuffle the pool), tagged (any-tag match), themed (all-tags match), and **manual (click-to-add tiles + reorder + per-clip duration override)**.
- Pacing: timed segments (each clip plays N seconds, looping if too short) OR rotate-on-end (each clip plays its native duration, capped at 15s).
- Repeat avoidance: within-episode always on; cross-episode lookback configurable per channel (default 10). When the pool is too small and exclude window wipes everything, the selector auto-relaxes with a clear warning instead of returning empty.
- Assembly executor: builds an FFmpeg filtergraph for 1080p H.264 output, picks the normalized variant when present (concat-fast path) or falls back to scale+pad of the original at render time.

*Phase 4 — Channel-locked metadata templates*
- New per-project template editor at `/projects/:slug/metadata-template`. Author title / description / tag-list patterns with `{placeholder}` tokens. When set, the Metadata Generator switches from three LLM calls to ONE small extraction call that fills the placeholders — title and description stay editorially consistent across every upload from that channel.
- Recognised placeholders: `{topic}`, `{topic_tag}`, `{summary}`, `{keywords}` (LLM-filled), plus `{episode_code}`, `{date}`, `{date_long}` (deterministic, no LLM call).
- ~3× cheaper per episode (1 LLM call vs 3). Brand consistency without re-rolling the wheel on every upload.

*Phase 5 — Vision-LLM auto-tag*
- New ✨ Auto-tag button per clip + ✨ Auto-tag untagged (N) bulk button on the B-Roll Library page. Reuses the cached thumbnail JPEG (no re-extraction from source) and asks the vision LLM for 3–7 short subject/setting/mood tags.
- Auto-picks model: Claude Sonnet if Anthropic key configured, else GPT-4o-mini. ~$0.002 per clip on mini.
- Existing user tags are preserved by default (unioned with vision tags). Pass `replace_tags: true` to clobber.

**B-Roll polish** (v1.0.89 ships with the full set, not staged across patches)

- **B-Roll audio volume slider** (0–100%) actually mixes now. Per-clip audio probe via ffprobe; clips without audio get a generated silence track of matching duration so the amix branch is uniform. Volume filter ducks the concatted B-Roll audio under the full-volume narration. Default 0% (muted) — best for prayer; bump to 10–20% for ambient texture.
- **Per-clip camera motion** (zoom-in / zoom-out / pan-left / pan-right / pan-up / pan-down / static). Three modes: fixed (one motion across the whole episode), rotate (cycle through a pool), or random (pick from pool per segment). Uses `scale=eval=frame` + center crop so output frame size stays a constant 1920×1080 — libx264-safe.
- **Crossfade transitions** between clips. Picks any FFmpeg xfade family (crossfade, dissolve, wipe, slide, shape) with a configurable 0.1–2.0 s duration. Hard-cut "none" stays the cheapest-render default. Unknown transition IDs fall back to hard cut with a clear log line.
- **Subtitle burn-in**: when the episode has an SRT/ASS/VTT in its subtitles dir, the assembly path automatically appends a subtitles filter — same UX as the existing scene-images video assembly.
- **Auto-relax for cross-episode exhaustion**: when the repeat-avoidance log wipes the pool, the selector retries without the exclude list and surfaces a warning explaining why. Better than returning empty.
- **Manual-mode validation**: backend verifies every filename exists in the pool; warns about skipped clips by name. Empty `manual_selection` falls through to the algorithmic path (manual is opt-in).

**Audit passes (verified before this release)**
- `npx tsc -p electron --noEmit`: 0 errors.
- Every touched Vue SFC parses cleanly.
- End-to-end smoke: pool create → scan mixed-spec clips → tag → subscribe → manual pick with rotated motion + crossfade transition → assemble → ffprobe output: H.264 1920×1080 @ 24fps + AAC stereo as configured, duration matches narration bound.
- 6 edge cases verified: missing clip filename, empty manual selection, invalid transition ID, no narration on disk, offline pool folder, pool-exhaustion auto-relax.

**Other fixes from prior fix cycles bundled into this release**
- `useCharacters` composable now accepts `Ref<string> | ComputedRef<string>` in addition to `string` and `() => string` — fixes the "Project '[object Object]' not found" error when creating / editing characters.
- Style Preview cache route uses `fs.createReadStream` instead of `res.sendFile` — sidesteps Express's silent 404 on paths containing spaces (`Story Studio KH`).
- kie.ai slug fixes: `nano-banana-2` (not `google/nano-banana-2`); GPT Image 2 in i2i mode routes to `gpt-image-2-image-to-image` with `input_urls` refs field. Project config migration auto-propagates infra fields from defaults so existing projects pick up provider-side slug changes.
- Metadata generator wired to the job queue — navigate away mid-job without corruption.
- Provider supports_reference_images flag now threaded correctly through the kie provider call. GPT Image 2 + Nano Banana 2 + Nano Banana Pro + Flux Kontext renders now actually consume the reference images attached, instead of silently dropping them.

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
