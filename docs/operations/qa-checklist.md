# Story Studio KH — QA Checklist

Use this checklist before shipping any release. Generation QA uses one
GenStudio URL and API key; Story Studio contains no direct provider, local
model, or Studio Hub generation fallback.

---

## Pre-Test Setup

- [ ] Quit any running instance of Story Studio KH
- [ ] Backup or clear user data: `~/Library/Application Support/Story Studio KH/`
- [ ] Gather a valid GenStudio URL and API key with the scopes needed by the test
- [ ] Confirm at least 5 GB free disk space
- [ ] Internet connection is stable
- [ ] Confirm the bundled FFmpeg and FFprobe pass Settings → FFmpeg validation

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

## Phase 2 — Bundled FFmpeg Validation

- [ ] Open any project → Audio Assembly tab (or any page that scans audio)
- [ ] Settings → FFmpeg reports the bundled media engine and exact version
- [ ] Re-check status validates both FFmpeg and FFprobe without downloading a replacement
- [ ] Audio and video probes use the bundled binaries after a clean installation

## Phase 4 — Project Creation

- [ ] From home screen, click "+ New Project"
- [ ] Step 1: name "QA Test Series", prefix "QA", season size 13
- [ ] Step 2: connect the GenStudio URL and API key
- [ ] Step 3: choose output folder (or accept the default in `~/Library/Application Support/Story Studio KH/projects/`)
- [ ] Review + Create
- [ ] Land on project dashboard; project shows in home grid on return
- [ ] Verify on disk: `~/Library/Application Support/Story Studio KH/projects/qa-test-series/` contains `project.json`, `config.json`, `production_standards.txt`, and an `episodes/` dir
- [ ] Create a second project "Another QA" → coexists independently

## Phase 5 — GenStudio Connection

- [ ] Settings → App & Connections shows the GenStudio URL and a saved-key indicator
- [ ] Test connection reports the account, plan, scopes, and live catalogs
- [ ] Paste an invalid key → Test returns a clear authentication or scope error
- [ ] Verify project files and diagnostics never contain the API-key secret

## Phase 6 — Ideas Generator

- [ ] Ideas tab → generator panel visible
- [ ] Fill: Genre Fantasy, Mood contemplative, Count 3, and choose a published GenStudio LLM
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

### Thumbnail Generator tab
- [ ] Thumbnail Generator tab → select episode
- [ ] Generate thumbnail images → wait for `done`
- [ ] Verify PNGs in `06 Thumbnail Images/`

### Scene Plan and Scene Review
- [ ] Scene Plan builds a deterministic narration timeline, then generates unique visual prompts
- [ ] Scene Review generates only missing scene images through GenStudio and checkpoints each verified image
- [ ] Incomplete or unapproved scenes remain pending and block Video Assembly

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

## Phase 11 — YouTube Finalizer

- [ ] Finish Audio Assembly, then open YouTube Finalizer and select the episode
- [ ] Before Audio Assembly is complete, Finalize YouTube Package stays blocked and names the missing timing dependency
- [ ] With incomplete subtitles, the page shows a warning but still permits finalization
- [ ] Finalize YouTube Package → one queued job creates title + description + tags
- [ ] Verify the description uses approved outline titles and measured Audio Assembly timestamps
- [ ] Verify only research sources selected on the Research page appear under SOURCES & FURTHER READING
- [ ] Edit Preview inline
- [ ] Autosave/fork → disk shows `{CODE}_Metadata.json` + `{CODE}_Metadata.txt` (v1) or `_v2.json`/`_v2.txt`
- [ ] Version dropdown in Preview shows saved versions; switch between them

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

- [ ] Models tab: live GenStudio LLM, image, TTS, voice, transcription, and video counts load
- [ ] Performance is absent; GenStudio account admission is authoritative
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
- [ ] Locally queued GenStudio work remains queued and resumes admission
- [ ] Accepted GenStudio work resumes polling its saved job ID and idempotency key without a duplicate submission
- [ ] Only non-recoverable local execution is marked `error: "Interrupted by app restart"`; Retry remains available

## Phase 17 — Error Scenarios

- [ ] Paste a bad GenStudio key → attempt generation → red error banner with clear authentication message
- [ ] Disable internet mid-generation → job marked as error with a network-ish message
- [ ] Retry a polling/download failure → the accepted GenStudio job ID and idempotency key are reused
- [ ] Confirm an uncertain GenStudio job never falls back to another route
- [ ] Try generating scene images before Scene Plan prompts exist → clear blocking error

## Phase 18 — Multi-Project & Cleanup

- [ ] Create 3 projects, do a small operation in each → each isolated (own jobs, ideas, keys)
- [ ] Delete a project from Settings → confirm dialog
- [ ] Folder removed from `~/Library/Application Support/Story Studio KH/projects/`; other projects unaffected
- [ ] No orphan files left in user data directory

---

## Automated Tests

Before manual QA, run the full verification and deterministic GenStudio
qualification from the project root.

```bash
cd /path/to/story-studio
npm run verify
node scripts/qualify-genstudio-release.mjs
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
