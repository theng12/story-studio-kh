# Episode Visual Workflow and App Audit Implementation Plan

> **For agentic workers:** Use the focused executing-plans or subagent-driven-development workflow task by task. The primary owner integrates shared contracts and runs suites serially; independent agents may audit separate pages. Checkboxes record evidence, not intent.

**Goal:** Keep both current visual sources and uniform pacing working, add deliberate variable pacing and scoped AI motion, reconcile older visual controls, and audit the complete customer workflow.

**Architecture:** Extend the existing episode visual-source, continuity pacing, scene selection, and job request records. One episode decision must drive the editor, generator, Pipeline, Jobs, Production Board, and final assembly. Reuse current source validation and paid-work recovery rather than creating a second configuration or orchestration system.

**Tech stack:** Nuxt/Vue, TypeScript/Express, Electron, episode JSON records, local FFmpeg, GenStudio's live catalogue and generation APIs.

**Spec:** The accepted design in this document is the baseline from the owner's September 11 discussion. Detailed boundary rules below are implementation recommendations to review as part of this plan. This delivery is planning only; no application code, episode data, jobs, or installed app are changed.

**Baseline:** `3694ac7801486a41cc76b40366ff369ce57694a5`, application `1.4.146`. Existing untracked Impeccable settings critique is unrelated and must remain untouched. No root `SPEC.md` exists. Read repository `AGENTS.md`, `README.md`, and current manifests before execution.

## Accepted design and global constraints

1. Exactly two customer-facing visual sources: **Scene Plan / Continuity** and **Image Pool**. Content Series Formulas describe content; they are not additional visual production modes.
2. **Uniform pacing remains a first-class current option**, for new and existing episodes. Variable pacing is additive and never automatically enabled by upgrading or selecting Scene Plan.
3. Within Scene Plan, pacing and AI motion are independent choices. Pacing: uniform or successive time periods. AI motion: off, opening only, selected scenes, or whole episode.
4. The visual-source decision belongs to the episode. Present it at the handover to visual work after narration preparation; allow it to be configured earlier, without inventing new prerequisite gates for unrelated steps.
5. The familiar order remains Ideas → optional Research → Script → Introduction → Thumbnail Prompts/Thumbnails → Audio → Audio Merge → Subtitles → Metadata → visual work → Video Assembly → upload review/scheduling. This is workflow guidance, not a new strict dependency chain: research remains optional; thumbnail and metadata work can remain independent; preserve existing introduction automation and optional features.
6. Scene Plan branch: visual timing/motion setup → character/reference preparation if required → plan → visual prompts → images/review → optional scoped motion prompts/clips/review → assembly. Image Pool branch: saved image selection/order/timing → assembly. Preserve applicable audio, subtitle, overlay, and output checks.
7. Generated plans, images, clips, saved selections, audio, captions, and finished videos are not automatically rewritten. Existing plan timing governs completion of its remaining scenes. Explicit replan/replacement retains existing safeguards and shows impact.
8. No project-wide pacing default. Reusable presets apply only through deliberate user action; absent pacing leaves the live episode setting unchanged. Existing Character Sheet presets with pacing must remain usable and announce the effect.
9. Consolidate automatic formula pacing/motion influence into explicit episode choices. Do not edit signed Content Packs, remove their content rules, or rewrite stored presets as a shortcut.
10. Model duration/resolution/reference limits, prices, and controls come from the current GenStudio catalogue and update on model changes. Scene hold duration is an editorial setting, distinct from supported AI clip duration.
11. Only the chosen motion scope may consume motion-prompt tokens or create clip requests. Intentional stills and branch-inapplicable stages are not failed or missing.
12. Preserve recovery versus regeneration, accepted-request identities, receipts, settlement tracking, output verification, source ownership checks, and partial-success isolation.
13. No paid probes, external uploads/publishing, source deletion, live-job interruption, or installed-app restart as part of planning or unattended test setup. Use fixtures and mocked provider responses; record any live verification not exercised.
14. No new dependencies, general workflow engine, global locks, or speculative compatibility system. Remove code only after verifying consumers, routes, registrations, persisted readers, and tests.
15. App-wide audit completion means every route has a recorded disposition and defined scenarios have evidence. It cannot establish that no undiscovered bugs exist.

## Control placement and mechanics

- **Pipeline:** an episode visual-source summary and explicit configuration entry before visual stages. Mixed selections show source/settings per episode; selecting several episodes does not apply one episode's settings to the others. Existing manual stage selection remains deliberate.
- **Scene Plan:** canonical **Visual timing & motion** panel before plan/prompt generation. Uniform exposes the existing shortest/longest scene controls. Variable exposes ordered periods with a final “to end” period. Motion exposes the independent four-way scope choice and eligible count.
- **Character Sheet:** retain visual identity/reference settings; replace the competing pacing editor with the current pacing summary and link to the canonical panel. Applying an existing preset containing pacing still applies/announces that saved rhythm through the same episode write path.
- **Motion Review:** display the saved scope and eligible scene list; retain per-scene preview, regenerate, external MP4, Use clip, and Use still. Bulk buttons refer to the same eligible IDs used by the backend.
- **Image Pool:** retain selection/order/seconds-per-image and recycling. It has no AI-motion scope in this batch. Generated opening clips followed by an Image Pool remainder is a separate future feature.
- **Video Assembly:** show the selected source, actual timeline, and approved clip/still mixture. Do not maintain another pacing editor that contradicts Scene Plan timestamps. Keep existing Image Pool timing controls connected to its saved selection.
- **Jobs/Board:** use the episode's chosen branch and requested scene IDs for counts, readiness, retry, links, and completion. Generated-but-unselected clips remain assets, not a request to use them.
- **Mixed-source Board layout:** retain the existing table with the union of applicable visual columns, label each episode's source, and show “Not used” in branch-inapplicable cells. Row completion and summary denominators count only applicable requirements; a project-level format cannot mark an Image Pool row incomplete for missing Scene Plan assets. Apply the same rule to dashboard and Ideas completion filters.

### Recommended timing and state rules

- Label motion/pacing times as **narration timeline time**, beginning at the merged narration's zero. Convert existing measured scene coordinates explicitly; added title/opening video segments are not counted in this scope. Never substitute zero when an offset cannot be measured.
- Variable periods start at zero, increase strictly, have positive ordered duration ranges, and end with an open-ended final period. Reject gaps, overlaps, NaN/infinite values, and malformed persisted input with an actionable error.
- Truncate future periods when an episode ends early; never generate phantom scenes. Respect word/cue boundaries and show actual planned timing around a requested period boundary.
- For an existing scene that crosses an opening cutoff, do not split or regenerate it silently. Include whole scenes ending at or before the cutoff; show the crossing scene and allow explicit inclusion, with the resulting end time visible. Preview and dispatch must use identical inclusion rules.
- Before narration/plan timing exists, allow saving settings but show scene counts as unavailable, not zero or an exact estimate.
- Draft settings do not rewrite the current plan. Save next-plan pacing separately from the timing recorded in an existing plan using the smallest extension to existing episode records. Show when explicit replanning is required.
- Motion scope changes affect future eligible work and require explicit application to output choices if existing approved clips would fall outside scope. Do not delete those clips or silently alter a finished video.
- Persist stable scene IDs for a selected-scenes scope and validate them against the current plan. After replan, report removed/changed selections rather than guessing replacements by index.
- Queued/in-flight work keeps its submitted scope and source identities. Editing settings never broadens a running job or resubmits accepted requests; use existing job parameter snapshots.
- Distinguish formula-assigned motion hints (`motion_mode`) from an explicit output decision (`motion_choice`). Trace both before removing formula influence; preserve a user's Use still choice, and never treat a generated hint as proof that the user approved paid motion.
- A source choice and source readiness are different: Image Pool may be selected before usable images have been chosen. The UI must allow reaching selection while generation/render checks remain blocked until a valid selection exists.

## Evidence already found (not a completed audit)

| Finding | Source | Disposition |
|---|---|---|
| Scene Plan and Image Pool already share an episode source reader and assembly routes | `electron/server/services/video-visual-source.ts`; `electron/server/routes/video.ts` | Extend and reuse |
| Image Pool source is currently coupled to its selection sidecar | `video-visual-source.ts` | Separate choice from readiness minimally; retain validation |
| Formula pacing can initialize new Character Sheet state and generator pacing; motion profiles also enter generation | `frontend/pages/projects/[slug]/character-sheet.vue`; `services/scene-plan-pacing.ts`; `services/format-loader.ts`; `services/scene-motion-profile.ts` | Remove implicit production influence after explicit-episode resolution is in place |
| Uniform and two-phase pacing exist; the general custom editor only exposes one band | `services/scene-planner.ts`; `frontend/composables/useContinuityConfig.ts`; `electron/server/routes/continuity.ts` | Extend existing contract, preserve uniform results |
| Bulk motion prompt controls are Next N/All pending, and clip eligibility has no time scope | `frontend/pages/projects/[slug]/scene-plan.vue`; `motion-review.vue`; `electron/server/routes/scene-review.ts` | Share scope resolution before either paid stage |
| Pipeline checks Image Pool mainly when Video Assembly is selected | `electron/server/routes/pipeline.ts` | Resolve branch before validating/planning all visual stages |
| Uniform defaults diverge: the canonical pacing contract resolves 1–3 seconds, while a generator fallback uses 3–12 when pacing is absent | `services/scene-plan-pacing.ts`; `generators/scene-plan.ts` | One canonical resolver for new planning; preserve existing plan timings |
| Motion generation still reads project-wide enable/intensity values and assigns formula profiles automatically | `generators/scene-plan.ts` | Explicit episode settings govern new work; preserve submitted job snapshots |
| Board columns and Ideas completion derive from project format; motion readiness examines all scenes | `frontend/pages/projects/[slug]/board.vue`; `frontend/composables/useProjectFlow.ts`; `electron/server/routes/ideas.ts`; `services/asset-status.ts` | Make row completion, applicable counts, and motion readiness episode-aware |
| Renderer already selects current approved clips or exact stills, with duration fitting | `electron/server/generators/video.ts` | Reuse; verify short clips and mixed output |
| Older internal source names remain, while `canonicalFormatId()` currently resolves every format ID to Continuity | `electron/server/services/format-loader.ts` | Trace actual reachability; names alone do not prove dead behavior or an extra customer mode |

## Execution milestones

### 1. Baseline, inventory, and old-control reconciliation

**Files:** `AGENTS.md`, `docs/README.md`, `docs/planning/README.md`, `frontend/pages/`, sidebar/workflow registration, `services/format-loader.ts`, `services/scene-plan-pacing.ts`, `services/motion-profiles.ts`, `services/video-visual-source.ts`, and existing visual tests.

- [ ] Record the execution commit/worktree, applicable instructions, relevant current logs, and unrelated changes. Inspect recorded failures before making fixes.
- [ ] Compare this baseline with current main and previous completed handoffs; retain already-working fixes rather than rebuilding them.
- [ ] Inventory every page and entry route, including redirects and retired shells. Create a route coverage table in `docs/planning/visual-workflow-audit-evidence.md` with route, reachable entry, tested states, result, evidence, and remaining issue.
- [ ] Trace each old pacing/motion producer and consumer, preset application, format alias, feature gate, and sidecar reader. Classify each as active/reused, replaced by explicit episode settings, proven dead, or unresolved.
- [ ] Establish focused baseline results for pacing, visual source, Pipeline prerequisites, motion generation, and assembly. Record exit status/counts; do not call a filtered run a full release pass.

**Exit evidence:** exact affected-route/file map, reproducible baseline defects, and deletion inventory. No broad format removal or data migration based only on a name.

### 2. One episode source and explicit pacing authority

**Modify:** `electron/server/services/video-visual-source.ts`, `electron/server/routes/video.ts`, `electron/server/routes/continuity.ts`, `electron/server/contracts/pacing.ts`, `frontend/composables/useContinuityConfig.ts`, `electron/server/services/scene-plan-pacing.ts`, and their existing tests.

**Consumes:** current source state, saved continuity pacing, existing plan timings, saved Image Pool selection. **Produces:** one validated episode source choice plus an explicit uniform/period pacing choice consumed by every visual entry point.

- [ ] Add failing regression fixtures for selecting an empty Image Pool, a saved uniform band, explicit legacy two-phase pacing, a preset with no band, malformed state, and rapid episode switches.
- [ ] Extend existing records rather than introducing a parallel project configuration. Reading an old episode must not write/backfill files. Existing explicit settings and saved plan timings win.
- [ ] Remove formula-as-implicit-default from production resolution. Keep legacy explicit episode two-phase values readable and offer their editable equivalent; keep signed pack bytes unchanged.
- [ ] Make the canonical pacing resolver supply the current uniform contract for new planning in every supported entry path. Remove the divergent 3–12-second generator fallback rather than replacing saved episode bands or existing plan timings.
- [ ] Preserve preset semantics: stored pacing applies with a notice; absent/partial pacing leaves current choice untouched. Update the repository's control-location instructions while retaining the owner's preset rule.
- [ ] Validate source choice independently from readiness; a missing pool selection is a clear unready state, not a switch back to Scene Plan.
- [ ] Run focused tests, review, and checkpoint the completed change.

**Acceptance:** changing content formula or mounting a page cannot silently choose variable pacing or AI motion; choosing Image Pool before selecting images is usable and cannot bypass render checks.

### 3. Visual editor and variable scene planning

**Modify:** `frontend/pages/projects/[slug]/scene-plan.vue`, `character-sheet.vue`, `electron/server/services/scene-planner.ts`, `electron/server/generators/scene-plan.ts`, `electron/server/routes/scene-plan.ts`. **Extend tests:** `scene-pacing-overshoot.test.ts`, `scene-planner-salvage.test.ts`, `frontend/__tests__/continuityPresetPacing.test.ts`; add focused visual settings runtime tests.

- [ ] Pin uniform output with identical cues and current saved min/max; prove the new mode does not change that result.
- [ ] Add variable-period fixtures: a short episode, an intro gap, a cue crossing a boundary, the final short scene, three periods, and invalid ranges. Assert full timeline coverage with no overlap or unaccounted loss.
- [ ] Extend the current time-based pacing resolver from two phases to ordered periods, preserving cue-aligned planning. Keep editorial hold limits independent of video model durations.
- [ ] Build the canonical panel with uniform selected for an otherwise unconfigured episode and motion off unless explicitly saved. Preserve existing saved episode choices; never auto-save on mount.
- [ ] Show before/after scene counts and replan implications when a plan exists. Apply changes to new planning only until the user explicitly requests replan.
- [ ] Replace Character Sheet's duplicate rhythm editor with a summary/link while keeping its preset Apply behavior intact.
- [ ] Verify real rendered controls, keyboard focus, error text, narrow windows, reloads, and project/episode changes. Review and checkpoint.

**Acceptance:** uniform and variable pacing are equally available; choosing a new style does not silently choose a rhythm; an existing plan's missing scenes still use its saved timestamps.

### 4. Shared scope for motion prompts and clips

**Modify:** `electron/server/generators/scene-plan.ts`, `electron/server/generators/scene-clip.ts`, `electron/server/routes/scene-review.ts`, `frontend/pages/projects/[slug]/motion-review.vue`, `scene-plan.vue`, and existing job parameter types. **Create only if needed:** one small shared pure `electron/server/services/scene-motion-scope.ts` helper, not a new scheduler.

**Proposed helper contract:** resolve stable eligible scene IDs from the validated current plan and saved scope. Keep existing image/prompt/approval/model eligibility checks after scope resolution.

```ts
type MotionScope =
  | { mode: 'off' }
  | { mode: 'opening'; end_sec: number }
  | { mode: 'selected'; scene_ids: string[] }
  | { mode: 'all' }
// resolveMotionScope(scenes, scope) returns eligible IDs and crossing/invalid IDs.
// Scene time inputs have already been converted to the labelled narration timeline.
```

**Behavior fixture for the helper and both dispatch paths:**

```ts
const scenes = [
  { id: 'a', start_sec: 0, end_sec: 8 },
  { id: 'b', start_sec: 8, end_sec: 16 },
  { id: 'c', start_sec: 16, end_sec: 24 },
]
// opening end=16 -> eligible ['a','b']; off -> []; selected ['c'] -> ['c'].
// opening end=12 -> eligible ['a'], crossing ['b']; no implicit split or submission.
// unknown selected ID -> visible validation error; never fall back to all scenes.
```

- [ ] Add regression tests proving prompt and clip dispatch receive the same scoped IDs, including empty/off scope and a stale selected ID.
- [ ] Apply the helper before LLM prompt packing and before image-to-video job creation, including individual, bulk, and Pipeline paths. Keep manual explicit per-scene actions labelled with their scope.
- [ ] Remove project-wide motion enable/intensity and formula auto-assignment as implicit decisions for new work. Existing submitted jobs retain their own request parameters; missing episode scope does not authorize new paid work through a project toggle.
- [ ] Store scope/IDs in existing job parameters so retries and restarts cannot expand the batch after settings changes. Retry only unfinished required items; recovery reconnects accepted work.
- [ ] Recompute variant choices and quotes when model changes. Show actual eligible counts and duration fitting; retain existing hold-final-frame/manual-loop behavior with explicit labels.
- [ ] Make Use still and Use clip deliberate output choices. Applying a narrower scope to existing clips shows what will change; files and paid receipts remain.
- [ ] Verify cancelled, partially completed, provider-failed, expired-result, repeated-click, and restart cases with mocks. Review and checkpoint.

**Acceptance:** opening-only never submits later-scene motion prompts or clips; out-of-scope stills are valid; no accepted request is duplicated; generated work is not silently deleted or selected.

### 5. Pipeline, Production Board, Jobs, and assembly integration

**Modify:** `electron/server/routes/pipeline.ts`, the current Pipeline step execution/skip helpers, `electron/server/services/asset-status.ts`, `electron/server/generators/video.ts`, `frontend/pages/projects/[slug]/pipeline.vue`, `board.vue`, `jobs.vue`, `video-assembly.vue`, `image-pool.vue` as necessary.

- [ ] Write mixed-batch tests: one uniform Scene Plan episode, one variable opening-motion episode, one ready Image Pool episode, and one blocked episode. Assert only the blocked episode remains unqueued; each accepted episode gets its own applicable work.
- [ ] Resolve branch before preflight, counts, preset validation, and job expansion—not only before the final encode. Skip branch-inapplicable selected stages with an explicit receipt, never report them as failed.
- [ ] Keep manual stage selection. A branch choice does not authorize automatically generating every stage; missing prerequisites remain actionable for that episode.
- [ ] Ensure stale queued work is not retargeted when source/settings change. Use existing snapshots and revalidation, with a clear stale-settings reason rather than silently doing different work.
- [ ] Align Board cells, Jobs badges, pending filters, completion checks, repair targets, and deep links with the chosen branch and scoped required artifacts.
- [ ] Update `all_motion_reviewed`, motion pending counts, and Ideas/dashboard `all_done` to use only applicable scoped requirements. Off-scope scenes do not need placeholder clips or artificial approvals. Verify the mixed-source Board layout defined above.
- [ ] Preserve explicit optional Contextual Cues/Sound Design behavior during source changes: do not drop enabled, valid episode effects merely because Image Pool is selected, and do not make a Scene Plan mandatory for Image Pool because a historical plan happens to exist. Validate enabled effects against their actual timing/source dependencies and report any stale dependency explicitly.
- [ ] Render fixture videos for uniform stills, variable stills, mixed motion/stills, and Image Pool recycling using local fixture media. Verify duration, order, boundary frames, audio/caption alignment, short-clip fitting, subtitle-off output, and correct source stamps.
- [ ] Preserve upload render freshness checks so changing a draft setting alone cannot falsely replace or reclassify an existing finished video. Review and checkpoint.

**Acceptance:** editor preview, accepted job counts, required artifacts, and final video agree. Image Pool needs neither scene images nor motion prompts; Scene Plan still verifies its own required images.

### 6. App-wide workflow audit and concrete fixes

Audit groups in order below; each group is a separately reviewable fix batch. Do not combine speculative redesign with a confirmed defect. Record passed scenarios as well as failures so coverage is visible.

| Order | Pages / surfaces | Required checks |
|---|---|---|
| A | Shared episode/project selectors, presets, model menus, dialogs, navigation | Delayed responses cannot overwrite current selection; Apply versus Save; absent preset fields; live model limits/quotes; keyboard/overflow; disabled controls explain missing prerequisites |
| B | Jobs (project/all), Pipeline, Production Board, notifications | Fixed action positions; scoped recovery without navigation; Resume all matches individual Resume; partial success; hide/restore retains settlement; clear finished vs failed; failed-job links select exact episode; run receipt lets user stay |
| C | Audio, Audio Merge, Subtitles | Generate vs Regenerate; playback at affected chapter/time; generator deep links; fresh request after deliberate replacement; stale audio invalidates correct captions; merge/stitch timing; no reuse of superseded transcript; counts agree |
| D | Character Sheet, Scene Plan/Review, Motion Review, Image Pool, Contextual Cues, Sound Design | New branch/pacing/scope combinations; reference ownership; exact image/clip variants; missing-only repair; optional stage behavior; source/prompt freshness; pool selection persistence; independent-scene and character-locked modes |
| E | Video Assembly and every Upload subpage | Episode-owned audio/subtitles/overlays; preview/encode agreement; source choice; render progress; local file verification; metadata/thumbnail choice; private/custom/planned scheduling; upload progress; reconciliation; cleanup cannot trust stale upload proof |
| F | Ideas, Research, Scripts, Introduction, Thumbnail Prompts/Generator, Finalizer/metadata | Prerequisites; exact selection; edit/save; partial chapter completion; optional research; model allowance updates; thumbnail/scene separation; safe restart and regeneration |
| G | Settings, Presets, project dashboard/home/onboarding, content store, character/assets/music libraries, usage and remaining routes | Persist/restore; imports; navigation; renamed/retired entry points; reachable primary controls; no foreign episode state; no unexpected provider calls |

For **every reachable page**, cover empty, ready, incomplete/stale, running, paused (where supported), failed, recovered, and finished states where applicable. Exercise reload, rapid episode/project switch, repeated click, provider-offline response, and long content. Mark a state not applicable with a reason rather than implying it passed.

- [ ] Inventory and classify all routes, including `remote.vue`, B-roll-named routes, template/library routes, nested Upload pages, and redirects. Investigate reachability before removal; some old names back current Image Pool behavior.
- [ ] For each confirmed bug: record reproduction → focused failing regression where meaningful → minimal fix → passing result → rendered verification when UI is involved → independent review.
- [ ] Audit direct and queued entry points for identical prerequisites and scoped output verification. Use fake credentials/mock APIs and disposable episode data, not the owner's live queue.
- [ ] Verify narrow and standard desktop layouts, long lists, zoom, keyboard traversal, and overflow in the actual rendered interface. Source assertions alone are insufficient.
- [ ] Maintain the evidence ledger after each group. Record GenStudio-owned defects as exact contract/evidence handoffs and verify Story behavior independently; do not change provider dispatch here.

**Exit evidence:** all baseline routes have a disposition; all defined high-risk scenarios pass or have a specific unresolved entry; confirmed in-scope defects are fixed and reviewed. Do not describe untested live provider behavior as verified.

### 7. Targeted cleanup and documentation

- [ ] Remove superseded duplicate controls and implicit formula production consumers only after the new explicit path is covered. Check code references, route registration, saved-data readers, and tests before deleting helpers or aliases.
- [ ] Preserve deliberate uniform pacing, optional steps, content formulas, explicit presets, and Image Pool internals even when older names remain. Remove a name only with verified replacement of all runtime consumers.
- [ ] Update page guidance, Pipeline labels, Jobs wording, diagrams, and relevant `AGENTS.md` control-location rules to match actual behavior. Keep historical decisions as history, not active contradictory instructions.
- [ ] Update prior handoffs with links to proof of resolution instead of claiming their entire scope is finished because one symptom changed.
- [ ] Review the final diff for unnecessary abstractions/dependencies and unrelated changes. Record actual files/lines removed if useful; do not set a deletion quota.

### 8. Final verification, integration, and installer

- [ ] Run focused checks after each code batch. For backend iteration use `node scripts/testing/run-backend-tests.mjs --only <actual-test-file-substring>`; this is explicitly a partial run.
- [ ] At release, run `npm run verify` once serially against the final candidate. Record each lane's exit status and completion/test counts, plus lint/typecheck/build results. Fix actual regressions; do not weaken gates.
- [ ] Confirm `npm run check:changelog`, model-drift, security, and release checks apply to the final version. Runtime changes require matching package/package-lock version bumps and newest-first changelog entries.
- [ ] Independently review the final diff and scenario evidence, including source choice, uniform compatibility, scope/retry safety, and existing episode behavior.
- [ ] Verify GitHub Actions remains disabled, then commit/push/PR/merge under standing authorization when local verification and review are complete. Never force-push or override unresolved required checks.
- [ ] Synchronize main; build the local installer with `npm run dist:smoke` from main. Verify versioned arm64 DMG, bundled app/asar version, dependencies, and isolated launch. Do not restart the user's installed app or active queue.
- [ ] Remove only this work's clean merged branches/worktrees and stop its test processes. Preserve unrelated files and other agents' work.
- [ ] Final handoff: shipped version/commit/PR/DMG, completed audit coverage, concrete remaining limitations, and any live tests not performed. Mark completed items with evidence; archive this plan only when its scope is actually closed.

## Completion scenarios that must be demonstrated

| Scenario | Required outcome |
|---|---|
| New uniform + motion off | Current still-image workflow, unchanged pacing behavior |
| New uniform + opening motion | Existing image cadence; only opening prompts/clips requested |
| New variable + motion off | Faster/slower periods with zero clip requests |
| New variable + opening motion | Period-based images, scoped clips, complete still remainder |
| Selected scenes / whole episode motion | Exact stable selection / every eligible scene; live model validation |
| Image Pool with valid selection | Pool slideshow covers narration; no Scene Plan prerequisite |
| Image Pool with missing/changed file | Visible recover/select action; no silent source substitution |
| Existing partial plan | Valid images retained; missing scenes follow saved plan timing |
| Existing uniform preset / preset without pacing | Explicit band applies / current band stays unchanged, with truthful notice |
| Formula change / application upgrade | Does not silently activate variable pacing or motion |
| Mixed batch with one blocker | Valid episodes progress; only blocked episode remains |
| Interrupted scoped generation | Resume/recover accepted IDs; never widen scope or duplicate submissions |
| Existing completed video | Remains intact; any new render is an explicit action |

## Decision and authority boundaries

Already accepted: two visual sources, optional variable pacing, independent motion scope, explicit episode ownership, preservation of generated work, consolidation of conflicting old visual controls, complete audit and fixes for confirmed defects.

Routine technical choices and confirmed fixes proceed during execution. Bring a concrete proposal only if investigation requires materially changing paid-work behavior, auto-approval, publishing/deletion, content-authoring semantics, or combining Image Pool with generated motion. Do not ask again whether the owner wants a reported bug fixed.

**Starting point:** milestone 1, then the episode source/pacing authority in milestone 2. This establishes a trustworthy shared decision before adding more UI. No new installer is needed for this planning document.

## Progress

- [x] Accepted requirements consolidated and current source paths inspected (2026-09-11).
- [x] Independent read-only planning review completed; source/default, project-motion, scoped-status, mixed-row, and optional-effects findings incorporated (2026-09-11).
- [ ] Milestone 1: baseline/inventory complete.
- [ ] Milestone 2: episode settings complete.
- [ ] Milestone 3: pacing editor/planner complete.
- [ ] Milestone 4: motion scope complete.
- [ ] Milestone 5: integration complete.
- [ ] Milestone 6: app-wide audit complete.
- [ ] Milestone 7: cleanup/docs complete.
- [ ] Milestone 8: verified, merged, packaged, and handed off.
