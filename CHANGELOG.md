# Story Studio KH — Changelog

What's new in each release. Newest first.

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
