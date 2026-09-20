---
target: Story Studio Settings navigation and outdated controls
total_score: 31
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
timestamp: 2026-09-06T18-14-52Z
slug: frontend-pages-projects-slug-settings-vue
---
# Story Studio Settings review — 2026-09-07

Source: clean main 3b598be1, v1.4.119. Rendered evidence: separate read-only browser review of the running v1.4.117 app. The newer Channel Identity picker is already merged in v1.4.119; its older rendered dropdown is not a new implementation gap.

Two independent assessments: Settings source/design review and targeted mechanical detector. No production setting, generation, runtime restart, purchase, or application code was changed.

## Main finding

The main problem is oversized sections and misleading scope, not a lack of settings. Existing navigation has 12 entries (4 This Mac, 8 This Project). App & Connections combines nine throughput fields, image/subtitle paid-recovery preferences, appearance, remote access, credentials, and catalog diagnostics. Channel Identity combines formula/topic selection, production behavior, publishing, cadence, and episode defaults. Splitting these into focused destinations will help more than adding more cards or explanation.

## Recommended organization

Keep two explicit scopes and reuse existing components/endpoints. Use a compact section navigator with search that takes the user to the exact control. Show one focused section at a time; retain addressable links and clear Saved/Unsaved status.

This Mac: Connections (GenStudio and YouTube account setup); Performance & recovery (local workload controls and retry preferences); Appearance & notifications; Files & maintenance (shared Library, exports, FFmpeg, diagnostics).

This Project: Channel Identity (existing formula/topic picker); Production defaults (continuity, guide visibility, episode shape); Writing & style; Publishing (channel assignment, publishing profile and cadence); Project files & behavior (folder structure, project storage, confirmations and numbering). Use compact subsections rather than exposing all controls together. Scene rhythm remains an explicit per-episode choice; do not introduce a project pacing default.

Common controls stay visible. Timeouts, throughput estimates, server mode and diagnostic detail belong in clearly named Advanced sections. Advanced is navigation, not a new permission gate. Existing local choices and published account limits remain separate.

## Priority issues and evidence

1. P1: App & Connections is a catch-all. Source: frontend/components/ThisMacSettings.vue:1-58 and throughputFields at 529+. Separate connection setup from throughput/recovery. Do not present nine tuning choices before the connection a user came to edit.
2. P1: Scope banners overpromise. YouTube under This Mac includes project assignment (YouTubeConnectionSettings.vue:278-295,324-485). Storage under This Project includes shared Library and app export location (settings.vue:2770-2919; routes/library.ts:35-113). Put project assignment in Publishing and shared storage in Mac settings, with cross-links.
3. P1: Visible static claim “GenStudio itself accepts 12” (ThisMacSettings.vue:549,553) is historical local-lane guidance, not a live account fact. Replace with neutral local staging language; read published admission data if displaying current capacity. Preserve the user's local selection.
4. P2: Retired model-pricing and saved-voice editors remain behind literal v-if=false (settings.vue:75-227). Remove those panels and exclusively owned page plumbing after focused caller checks. Preserve active model configuration consumers and the globally reachable AppSettingsModal.
5. P2: Channel Identity remains broad even after the picker improvement. Separate production and publishing controls from choosing formula/topic packs. Reuse the v1.4.119 picker directly; do not build a second catalog or silently change selected products.

## Design assessment

The dark/gold visual language, named controls, explicit scope banner and sensitive-state feedback fit this production app. The information hierarchy within each oversized page is the weakness.

Heuristics (0–4): status visibility4, real-world match3, control3, consistency4, error prevention4, recognition3, efficiency2, minimalism2, recovery3, help3. Total31/40. This is a qualitative first review, not a measured usability result.

Power-user concern: finding one setting requires scanning a long page. First-time-user concern: technical throughput controls precede basic connection setup. Keep direct links, keyboard navigation and setting-level search; avoid adding confirmation steps for navigation or ordinary saves.

## Mechanical evidence

One targeted detector run returned 11 side-tab decorative-border warnings, exit2 (normal findings). Independent assessment classified5 as decorative and6 as semantic status callouts/false positives. These are low priority compared with navigation and scope. No overlay was injected: the evidence agent's browser was unavailable; the design agent separately inspected the live interface. No review server was started.

## Proposed order

First take the pending Claude image-permit task as a separate bounded engineering slice. Then simplify Settings navigation/scope, correct stale text and remove the proven hidden editor remnants. Finish with a focused rendered desktop/narrow and keyboard review. No new configuration framework, provider inventory, project migration or global generation gate is needed.

The owner already states the priority: easier navigation and removal of outdated content. No additional product interview is needed for this proposal. Implementation has not started in this review.
