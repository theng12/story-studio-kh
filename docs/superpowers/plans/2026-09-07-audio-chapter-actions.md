# Audio chapter actions implementation plan

**Goal:** Make one-chapter and bulk audio actions explicit, reachable and truthful about outdated subtitles.
**Approved design:** Owner approved direct chapter Generate/Regenerate, persistent selected-action bar, removal of conflicting checkbox/mode, compact everyday controls with expandable details, and audio-change tracking. Image-to-video work is paused. Audio quality classification and automatic gibberish replacement are not this batch.
**Architecture:** Reuse the existing audio generation API and confirmation/quote flow. The clicked action supplies force/no_overwrite; selection never implies all for replacement. Extend existing source signatures and completion checks rather than adding a recovery framework.
**Stack:** Vue/Nuxt, TypeScript/Node, existing file manifests and tests.

## Instructions snapshot / safeguards
- Start 8dc07c8a, isolated codex/audio-chapter-actions worktree. Canonical pre-existing untracked critique preserved.
- Live GenStudio catalogue owns limits, controls, voice eligibility and price; no new hardcoded model data.
- Explicit actions: Generate missing = force:false/no_overwrite:false; Regenerate selected = true/false; Create another version = true/true. Row actions target exactly one chapter. No selection is never permission to regenerate all.
- Keep valid old output until successful replacement. Alternate unselected version must not invalidate original source. Do not regenerate production audio or restart app for QA.
- Existing confirmation remains authoritative; quote and submitted action must describe the same selected scope.
- Source freshness is technical dependency state, not an audio-quality verdict; do not label silence/gap as confirmed gibberish.
- No launcher edits (Pinokio destination/examples requirements not applicable). No GitHub compute; check Actions disabled before push/PR. Standing reviewed+verified merge authority applies.

## Task 1 — chapter actions and layout (settings_implementation)
- [x] Reproduce competing local allowDuplicates and page generation_mode using existing source and focused UI tests.
- [x] Update frontend/pages/projects/[slug]/audio.vue and frontend/components/AudioChapterSelector.vue. Remove duplicate checkbox/mode; allow all chapter selection. Make row action explicit; sticky selection bar with model/voice, scope, primary Regenerate selected, Generate missing, More/new version.
- [x] Preserve missing-only episode action with explicit label/scope; do not silently use all for empty selected action.
- [x] Keep selected model/voice/chapters prominent; collapse delivery/request details with accessible native details, visible enforcement/error summary.
- [x] Consume optional subtitles_stale boolean from audio-sections rows; show Audio saved / Subtitles need updating with episode/chapter link.
- [x] Regression tests cover modes, scope, empty selection, row actions, quote invalidation, episode switch, keyboard/accessibility.

## Task 2 — source freshness (workflow_episode_continuity)
- [x] Trace current audio source grouping, TTS output success, transcription identity, assembly metadata, status/completion call sites.
- [x] Add tests demonstrating changed same-duration audio cannot reuse old transcript/stitch as current, failed replacement leaves good source current, new-version does not change active source, and a new transcript clears stale state.
- [x] Persist chapter source-byte signature with successful transcription using existing metadata where possible. Compare the active source, expose subtitles_stale on audio-sections. Do not rewrite all existing customer files.
- [x] Extend existing stitch and relevant completion checks so detected changed input is actionable and downstream cannot report the stale derivative current. Retain current intentional whole-track behavior; do not introduce broad new locks or speculative framework.
- [x] Coordinate exact fields with frontend; regression tests on source-change→status→regeneration→freshness.

## Task 3 — integration and review (root / whole_flow_qa)
- [x] Relevant baseline before code; focused checks immediately per batch, one suite at a time.
- [x] Independent code review, focused frontend/backend regression checks and rendered desktop+narrow UI QA using isolated fixtures/no paid submissions.
- [x] Fix findings; bump package+lock to1.4.123, matching changelog; record composed final verification: unchanged backend 4,855 tests/420 files from the official verify run, final frontend 1,491 tests/156 files, then lint, full typecheck, and build/release checks. The earlier complete `npm run verify` stopped only at a typography token and is retained as a setup-failure log.
- [ ] Verify Actions disabled, commit/push PR, independent review evidence+clean mergeability then merge, sync main.
- [ ] Official local release smoke from main, record results and update remaining-work handoff. No production app install/restart or assets changed.

## Completion evidence
Plan/tasks updated with focused and full test counts, review findings/resolution, rendered QA report, PR/commit and remaining limitations. No promise of detecting gibberish in this change.
