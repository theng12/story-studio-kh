# Story Studio KH — QA Checklist

Use this checklist before shipping any release. Cover each phase end-to-end with real API keys.

---

## Pre-Test Setup

- [ ] Quit any running instance of Story Studio KH
- [ ] Backup or clear user data: `~/Library/Application Support/Story Studio KH/`
- [ ] Gather valid API keys: OpenAI, Anthropic, kie.ai, fal.ai
- [ ] Confirm at least 5 GB free disk space
- [ ] Internet connection is stable
- [ ] For the FFmpeg flow, optionally uninstall ffmpeg (`brew uninstall ffmpeg`) to test the download dialog

---

## Phase 1 — App Installation & Launch

- [ ] Double-click `Story Studio KH <version>-arm64.dmg` → mounts without "damaged" warning
- [ ] Drag `Story Studio KH.app` to Applications
- [ ] Launch from Applications → window opens with:
  - [ ] Title bar reads "Story Studio KH"
  - [ ] Traffic lights visible in the top-left with ~38 px clearance
  - [ ] Sidebar brand reads "Story Studio KH"
  - [ ] No blank area; content renders
- [ ] Drag the window by the dark bar at the top → window moves
- [ ] Close (red dot) and relaunch from Dock → reopens to same state

## Phase 2 — FFmpeg Detection

- [ ] Open any project → Audio Assembly tab (or any page that scans audio)
- [ ] If ffmpeg is installed: green "FFmpeg installed" badge, no dialog, scan works
- [ ] If ffmpeg is NOT installed: dialog prompts with "Download FFmpeg Automatically"
- [ ] Click Download → progress indicator, then success
- [ ] Retry the scan → now succeeds

## Phase 4 — Project Creation

- [ ] From home screen, click "+ New Project"
- [ ] Step 1: name "QA Test Series", prefix "QA", season size 13
- [ ] Step 2: paste all 4 API keys
- [ ] Step 3: choose output folder (or accept the default in `~/Library/Application Support/Story Studio KH/projects/`)
- [ ] Review + Create
- [ ] Land on project dashboard; project shows in home grid on return
- [ ] Verify on disk: `~/Library/Application Support/Story Studio KH/projects/qa-test-series/` contains `project.json`, `config.json`, `production_standards.txt`, and an `episodes/` dir
- [ ] Create a second project "Another QA" → coexists independently

## Phase 5 — API Keys

- [ ] Settings → API Keys tab
- [ ] Saved keys show a "set" indicator
- [ ] Click "Test" next to each key → valid ✓ or a descriptive error
- [ ] Paste an invalid key → Test returns a clear error ("Invalid API key" or similar)

## Phase 6 — Ideas Generator

- [ ] Ideas tab → generator panel visible
- [ ] Fill: Genre Fantasy, Mood contemplative, Count 3, Model claude-sonnet (or any)
- [ ] Click Generate → job queues, ideas appear within ~60 s
- [ ] Ideas table renders with columns (Code, Title, Status, Mood)
- [ ] Expand a row → logline + themes shown
- [ ] Click Accept → modal → "Folders Only" creates the 9 episode subfolders
- [ ] Verify on disk: `{project}/{CODE} - {title}/` contains 9 subfolders + `episode_info.json`
- [ ] Dismiss an idea → status updates
- [ ] Reset the accepted one → folder deleted, status returns to "new"
- [ ] Accept again → same episode code is reused (recycled number)

## Phase 7 — Script Generator

- [ ] Scripts tab → select accepted episode
- [ ] Choose model, style (e.g. B), 8 chapters, 45 min, Intro enabled
- [ ] Click Generate → confirmation dialog (if cost confirmation is on)
- [ ] Confirm → job queues, runs ~2–3 min
- [ ] Job completes with `done` status
- [ ] Verify `{CODE}_Script_Narration.docx` exists in `{CODE} - 01 Script/`

> Note: Scripts tab only writes the narration docx. Prompt generation and metadata
> live on their own tabs (see Phases 8 and 11).

## Phase 8 — Thumbnail/Scene Prompts + Thumbnail/Scene Generators

### Thumbnail Prompts tab
- [ ] Thumbnail Prompts tab → select episode
- [ ] Style tag, aspect ratio, thumbnail count/text settings
- [ ] Click Generate Thumbnail Prompts → thumbnail prompts appear for review
- [ ] Edit one prompt inline → Save → persists on reload
- [ ] Verify `{CODE}_Thumbnail_Prompts.docx` exists in `04 Thumbnail Prompts/`

### Scene Prompts tab
- [ ] Scene Prompts tab → select episode
- [ ] Style tag, aspect ratio, scenes per chapter
- [ ] Click Generate Scene Prompts → scene prompts appear for review
- [ ] Verify `{CODE}_Scene_Prompts.docx` exists in `03 Scene Prompts/`

### Thumbnail Generator tab
- [ ] Thumbnail Generator tab → select episode
- [ ] Generate thumbnail images → wait for `done`
- [ ] Verify PNGs in `06 Thumbnail Images/`

### Scene Generator tab
- [ ] Scene Generator tab → select episode
- [ ] Generate scene images → wait for `done`
- [ ] Verify PNGs in `05 Scene Images/`

## Phase 9 — Audio Generator

- [ ] Audio Generator tab → select episode, sections "all", voice preset
- [ ] Generate → job queues, takes ~3–8 min
- [ ] Verify chaptered MP3s in `07 Audio Assets/` (Introduction + Chapter 1 … N)
- [ ] Click preview ▶ on a chapter → audio plays in browser player
- [ ] Change voice preset, queue another episode → confirms voice changed per job

## Phase 10 — Audio Assembly (merge + music + ambience + intro)

- [ ] Audio Assembly tab → scan assets, all chapters listed in order
- [ ] Reorder chapters if needed
- [ ] Silence gap 5 s, Normalize Volume ON
- [ ] Click Generate Merged → `audio_merge` job runs ~3–5 min
- [ ] Verify `{CODE}_merged_audio.mp3` in `08 Merged Audio/`
- [ ] Preview plays full merged audio
- [ ] Re-generate with Background Music (Browse…, pick a file, set volume) → merge succeeds with music layered
- [ ] Re-generate with Ambience (Browse… or preset noise) → merge succeeds with ambience layered
- [ ] Re-generate with Intro audio enabled (Browse…) → merged file begins with the intro clip
- [ ] When merged audio exists, Generate button opens modal: Replace / Save as new version / Cancel — try "Save as new version" → `{CODE}_merged_audio_v2.mp3` lands alongside v1
- [ ] Save preset with current config, switch episodes, apply preset → config restored correctly

## Phase 11 — Metadata Generator

- [ ] Metadata Generator tab → select episode
- [ ] Section 1 (Titles): platform preset, count 5, Generate Title Options → 5 options appear, click one to set Preview title
- [ ] Section 2 (Description): toggle sections, reorder, Generate Description → description fills Preview
- [ ] Section 3 (Tags): count 15, Generate Tags → tags fill Preview
- [ ] Or: Generate All → titles + description + tags in one pass
- [ ] Edit Preview inline
- [ ] Click ➕ Save as v{n} → success toast; disk shows `{CODE}_Metadata.json` + `{CODE}_Metadata.txt` (v1) or `_v2.json`/`_v2.txt`
- [ ] Version dropdown in Preview shows saved versions; switch between them
- [ ] Save a template (section layout) → appears in Template dropdown, switches correctly

## Phase 12 — Jobs Dashboard

- [ ] Jobs tab → Active section on top (running + queued); History section below (done + error + cancelled)
- [ ] Filter by type (Scripts, Images, Audio, etc.) → list narrows
- [ ] Sort by Created/Duration/Status/Episode works
- [ ] Click a done job → Show output expands full log
- [ ] Running job shows progress bar + `N / Total` counter next to it
- [ ] Errored job shows a red banner with the first error line inline (no click needed)
- [ ] Cancel a queued job → status → `cancelled`
- [ ] Retry an errored job → re-queues
- [ ] Clear finished → done/error/cancelled removed; running/queued stay

## Phase 13 — Dashboard Stats

- [ ] Project dashboard → hero stats correct (Ideas, Episodes, Ready, Time Saved)
- [ ] Asset rings/bars reflect on-disk file counts per category
- [ ] Session stats update after a new generation

## Phase 14 — Settings

- [ ] Models tab: pricing table editable, save persists across reload
- [ ] Voices tab: add/remove presets, save persists
- [ ] Standards tab: production standards + intro format editable, save persists, presets switchable
- [ ] Folders tab: subfolder template shown; editing `{code}` templates works, revert to defaults
- [ ] Confirmations tab: toggle per-generator cost dialog — confirm behavior matches

## Phase 15 — Pipeline (Auto-Production)

- [ ] Pipeline tab → select a fresh episode (no assets) or one with partial assets
- [ ] Step list shows current done/missing per step
- [ ] Enable all steps (or a subset to control cost)
- [ ] Click Start Pipeline → orchestration queues jobs in order
- [ ] Jobs appear in Jobs → Active; step panel logs progress per step
- [ ] On success: "Pipeline complete" message
- [ ] On error: pipeline halts with a clear step + message; Resume button picks up from that step

## Phase 16 — Persistence & Restart

- [ ] Queue a job so it's running/queued
- [ ] Cmd+Q to quit
- [ ] Relaunch → projects, ideas, jobs history, API keys, FFmpeg detection, Audio Assembly presets all preserved
- [ ] Previously-running jobs marked `error: "Interrupted by app restart"`, Retry button works

## Phase 17 — Error Scenarios

- [ ] Paste a bad API key → attempt generation → red error banner with clear "invalid key" message
- [ ] Disable internet mid-generation → job marked as error with a network-ish message
- [ ] Try generating scene images before creating scene prompts → clear "Could not find scene prompts for {code}. Generate the prompts first." error
- [ ] Uninstall ffmpeg, try audio merge → FFmpeg download dialog appears

## Phase 18 — Multi-Project & Cleanup

- [ ] Create 3 projects, do a small operation in each → each isolated (own jobs, ideas, keys)
- [ ] Delete a project from Settings → confirm dialog
- [ ] Folder removed from `~/Library/Application Support/Story Studio KH/projects/`; other projects unaffected
- [ ] No orphan files left in user data directory

---

## Automated Tests

Before manual QA, run `npm test` from project root. All automated tests must pass.

```bash
cd /path/to/story-studio
npm test
```

Expected: all tests pass, 0 failures.

---

## Release Gate

Ship only if:
- [x] All automated tests green
- [x] All 18 manual phases complete without blocking issues
- [x] Fresh install works on a test machine (or fresh user account)
- [ ] DMG filename is `Story Studio KH <version>-arm64.dmg`; bundle name is `Story Studio KH.app`
- [ ] Apple Developer signing + notarization validated for public distribution
