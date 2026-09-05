# AH-002 Task 1c implementation report

## Scope and checkpoint

- Worktree: `/build/Developer/story-studio-kh/.worktrees/agent-handoff-story-dag`
- Branch: `codex/agent-handoff-story-dag`
- Start: `5813c9732b56aab09f25265f4f153c1aa319fa6e` (Task 1b baseline).
- Implementation commit: `e19f931b06fcdc30902604303f37c0bd4b9d759d` (`fix: recover episode prerequisites in durable dependency order`).
- Version remains the already-selected unreleased `1.4.102`; added one matching changelog bullet, without another version bump.
- This report intentionally remains untracked. No push, merge, deployment, release packaging, real provider execution, or live-data mutation was performed.

## Root cause

Jobs Retry All independently reposted failed prerequisites and consumers. A failed subtitle row, Scene Plan row, and Scene Review row could therefore be submitted concurrently. The queue's ordinary pipeline chain advances one job, but did not persist a single recovery owner across pre-existing errors, repeated Retry All calls, source/stitch verification, and process restart. Manual subtitle purchase also created a new Story queue identity on each replay even though Task 1b protects provider/credit identity.

## Implemented behavior

`episode-recovery.ts` is a fixed six-edge episode coordinator, not a general workflow engine. Its atomic project-local `episode-recovery-plans.json` stores one plan per episode, saved job settings and exact section scope, stable queue identities, dispatched tombstones, verified completed prefix, and the first unresolved prerequisite.

Order is Audio Assembly → subtitle sections → local subtitle stitch → Scene Plan → required Contextual Cues → Scene Review. Existing failed downstream rows receive a deferred projection and keep their history. A missing configured job is a visible hold rather than permission to invent a paid model or settings.

Readiness uses existing Audio Assembly and episode status inspectors, actual parsed chapter subtitle cues, existing source-fingerprint auto-stitch, verified stitched timeline metadata/hash/coverage, and Scene Plan timeline drift. Local malformed metadata is repaired by safe re-stitching; malformed/empty chapter sources cannot be hidden by a complete-looking derivative. Active prerequisites and cancellation holds cannot release consumers using stale ready artifacts.

The job queue now supports durable, locked enqueue-once identities. It persists before pumping; terminal identities are reused, and a dispatched plan edge whose row was pruned does not become fresh generation. Managed DAG rows do not run competing ordinary pipeline chains. A saved non-DAG tail is dispatched once, only after the complete verified prefix, retaining the ordinary queue chain for its remaining steps.

Boot starts the coordinator after queue lanes and interrupted-job recovery. It observes subtitle errors automatically and managed terminal events without requiring an open browser. Pending completion events are retained across async audits. A 30-second unref recheck watches only unresolved plans, including manual local artifact/review changes and free settlement recovery. Waiting/free public states re-enter the same durable subtitle job, not a fresh job/request; this re-entry is gated against force, cancellation, abandonment, and paid-blocked states.

Jobs Retry All groups the relevant rows by project/episode and sends one server-owned intent per episode. After the cancellation review fix below, explicit intents contain only saved source job IDs. Individual dependent retries and managed backend Retry endpoints use the same plan. UI helpers do not manufacture a section list. Backend plan requests reject parameter overrides; dispatch intersects the actual missing list with the saved source allow-list. Empty intersections and malformed saved scopes fail closed, never become all chapters.

The Jobs status component displays the plan's plain prerequisite message, authoritative section counts, and Task 1b public per-section messages. `Buy missing subtitles now` is visible only for an eligible public manual action on a non-deferred error with exact missing sections. The user supplies a positive whole-number additional ceiling. The request goes to Task 1b's existing endpoint with only that ceiling; busy/sent UI guards plus a stable server queue identity protect double-click/replay, even after the first Story job is terminal.

## Task 1b boundary and assumptions

- No changes to `subtitle-recovery.ts`, settlement classification, price lookup, commitment ledgers, provider routing, replacement eligibility, or local paid settings.
- The coordinator consumes `params.subtitle_recovery.sections` public `state`, `message`, and `manual_action`; it assumes `waiting_settlement` and `free_recovery` permit another execution of the same non-forced, non-cancelled durable job. `paid_blocked` does not automatically requeue.
- Task 1b retains sole authority for free task reclamation, bounded automatic replacements when enabled, explicit manual purchase, and all financial checks.
- Existing subtitle parameters/recovery identity are retained, except automatic recovery clears force and removes an inherited manual purchase authorization. The manual endpoint itself constructs the authorized exact missing scope.
- Parent is integrating separately reviewed Task 1b provenance/settings/forced-rerun fixes afterward; this work was verified against the stated start commit, not those later fixes.

## Focused TDD and verification evidence

Tests were added before implementation. Observed reds included missing coordinator/dispatch APIs, missing durable queue API, 404 recovery route, duplicate manual queue IDs, active prerequisites incorrectly releasing Scene Review, missing actual stitch verifier, absent frontend component/helper, malformed section scope accepted, and lost subtitle-only non-DAG pipeline tail. Each was followed by the focused green run. Fixture-only corrections were distinguished from implementation failures (notably authoritative queue mutation rather than editing a serialized copy, and the real numeric `expected_sections` public result).

Final/regression commands (all from this worktree unless noted):

1. `node scripts/testing/run-backend-tests.mjs --only episode-recovery --only job-queue-genstudio-resume --only job-queue-auto-retry --only pipeline-integration --only subtitle-autostitch --only subtitle-stitcher --only subtitle-recovery-engine --only jobs-route-order`
   - Exit **0**, **120 tests passed / 0 failed**, 9 suites; completion: `suite coverage: 8/8 file(s) completed, 120 test(s) + 9 suite(s) = 129 marks`.
   - **8 selected, 377 skipped; PARTIAL RUN, not the release gate.** `configured projects root byte-identical: true`.
   - Existing auto-retry fixture emitted an asynchronous ENOENT rename warning after its temporary project cleanup; it did not fail the test. Included here rather than describing the output as warning-free.
2. After the final scope/tail fixes: `node scripts/testing/run-backend-tests.mjs --only episode-recovery`
   - Exit **0**, **14 tests passed / 0 failed**; `suite coverage: 1/1 file(s) completed, 14 test(s) + 0 suite(s) = 14 marks`.
   - **1 selected, 384 skipped; PARTIAL RUN, not the release gate.** `configured projects root byte-identical: true`.
   - Covers topology/defer, stitch barrier, serialized plan restart, real queue module reload, repeated/concurrent enqueue, exact sections/empty scope, malformed scope, source parsing, local fresh metadata repair, downstream once-only, preserved ordinary tail once-only, due same-job settlement retry, paid-block hold, active/cancel holds, persisted plan/retry API, and manual terminal replay.
3. From `frontend`: `../node_modules/.bin/tsx --test --import ./__tests__/setup.ts __tests__/episodeRecovery.test.ts __tests__/jobsControls.test.ts __tests__/paidImageRecoverySettings.test.ts`
   - Exit **0**, **39 tests passed / 0 failed**, completion `tests 39`, `pass 39`, `fail 0`.
   - New tests mount the real SFC in happy-dom, assert eligible/manual versus uncertain settlement visibility, authoritative X/Y count, bounded single POST under a double click, and episode grouping without scope mutation. Existing Jobs controls and separate paid-setting regression tests also passed.
4. `npm run typecheck:electron`: exit **0**.
5. `npm --prefix frontend run typecheck`: exit **0** (Nuxt reads the configured dev proxy settings; no application server or live data writes).
6. `npx eslint electron/server/services/episode-recovery.ts electron/server/services/job-queue.ts electron/server/routes/jobs.ts electron/server/routes/video.ts electron/server/boot/executors.ts electron/server/__tests__/episode-recovery.test.ts --quiet`: exit **0**, no lint errors. This is not the full lint gate.
7. `npm run check:changelog`: exit **0**, `package, lockfile, and newest What's New entry agree on v1.4.102`.
8. `git diff --check`: exit **0**.

Dependency setup used local `npm ci --ignore-scripts` and frontend equivalent. Root npm installation reported pre-existing audit totals of 2 moderate and 1 high; frontend reported zero. This was dependency setup, not a clean security-audit claim. Tests requiring Electron reused the already-installed exact sibling Electron runtime artifact after the local package attempted an unavailable download. Neither package manifests nor lockfiles changed.

## Self-review and qualification limits

- Deliberately preserved paid safeguards, original failed history, model choices, optional cue/review policy, normal unrelated retry behavior, and the existing generation/stitch/status authorities. No new dependency or configurable workflow framework.
- Repeated automatic triggers and restart cannot grant a new generation epoch. Completed/cancelled plans retain tombstones. The review fix below adds the explicit cancelled-source retry exception, preserving the retired plan and original cancelled rows. A genuinely new intentional generation cycle after arbitrary source/model changes still uses the explicit generator workflows; automatic plan reset/new-epoch semantics are not introduced here.
- The fixed section-coverage DAG is aimed at the per-chapter subtitle workflow named in AH-002. No separate end-to-end qualification for legacy full-track (`per_chapter: false`) subtitle recovery was performed.
- The boot/event watcher is wired in production but was not exercised as a real background long-running scheduler integration test. Focused tests exercise the actual durable queue and artifact helpers and direct coordinator dispatch, with serialized/reloaded identities and repeated calls. Timer cadence, real app restart with queued provider work, and real completion-event timing still require parent integration/release qualification.
- No real screenshot/browser layout review or provider-paid end-to-end session was run. Component DOM/accessibility structure is tested; that cannot prove visual geometry or real provider settlement behavior.
- The 120-test regression batch preceded only the last malformed-scope/non-DAG-tail changes; the final 14-test coordinator run and final typecheck/lint validate those changes. No full backend/frontend/release/package gate was run, per task boundary.
- Parent should independently review the coordinator state lifetime, active-job adoption versus legacy pipeline handoff, and integration with the separately fixed Task 1b engine before shipping. This is a committed implementation handoff, not a release-ready declaration.

## Exit checklist

Applicable AGENTS requirements used: preserve selected model/provider authority and verified completion, exact missing scope, TDD/focused iteration, no competing Story suite, matching changelog/version, no live writes. Launcher instructions are not applicable: no Pinokio launcher files were touched. Parent explicitly prohibited integration/release actions, so the branch is kept local. Verified post-commit Git status contains only `?? task-1c-report.md`.

## Independent-review correction: cancelled Retry bypass

The parent identified a Critical bypass in `e19f931b`: cancelled dependent rows were deliberately excluded from frontend grouping and the individual plan branch. That sent them through the legacy delete-and-generator-POST path. A cancelled subtitle could consequently repost saved `force`, and cancelled Scene Plan/Scene Review could skip topology. This was a real implementation defect, not an intentional cancellation policy.

Correction commit: `35a142c2a0aaf228724086fccb40c8d6c25e5f17` (`fix: route cancelled episode retries through recovery intent`), on top of `e19f931b06fcdc30902604303f37c0bd4b9d759d`.

- All dependent types, including cancelled rows, now enter the same episode grouping and single Retry path. Requests carry only `source_job_ids`; removed the dead raw subtitle/Audio Assembly/Scene Review generator retry mappings rather than leaving a future bypass fallback.
- Both project and universal queue Retry routes resolve saved dependent source identity and call the coordinator. They do not resume/delete the cancelled job.
- The recovery endpoint accepts no settings, force, model, or section overrides. Source IDs must resolve inside the selected project/episode to a failed/cancelled recoverable job; abandoned or unrelated identities fail closed.
- Only explicit selection of a cancelled source can create a new recovery plan. The prior plan is retained in `retired_plans`, original cancelled rows are untouched, prior explicit source IDs remain deduplication tombstones, and concurrent/repeated identical intents reuse one plan. Automatic calls still exclude cancelled rows and cannot create an epoch from them.
- Selected source settings outrank a newer unrelated history row. Cancelled source `force` is cleared in the new descriptor; exact section scope is preserved and still narrowed against actual missing coverage. The original row retains its own force and cancellation evidence unchanged.
- New plans still stop at Audio Assembly/section/stitch prerequisites and use the durable queue once-only primitive. No paid-engine source was edited, no provider was called, and no source cancellation/settlement evidence was discarded.

Focused red/green evidence:

- Frontend RED: cancelled rows appeared in `other`; no saved IDs in grouped intent (2 failures / 4 tests). GREEN: `../node_modules/.bin/tsx --test --import ./__tests__/setup.ts __tests__/episodeRecovery.test.ts __tests__/jobsControls.test.ts` from frontend, exit **0**, **36 passed / 0 failed**. The added test checks grouping all three cancelled types, saved-ID single Retry guard, and removal of raw subtitle POST. Existing mounted-component/manual tests remain green.
- Backend RED after correcting duplicate fixture IDs: source-intent route returned **400 rather than 202**. Further focused reds proved inherited cancelled Scene Plan/Review force was still true and a newer unrelated subtitle row replaced selected scope. All corrected in the coordinator.
- Final backend command: `node scripts/testing/run-backend-tests.mjs --only episode-recovery --only jobs-route-order`, exit **0**, **22 passed / 0 failed**, 1 suite; completion `suite coverage: 2/2 file(s) completed, 22 test(s) + 1 suite(s) = 23 marks`. **2 selected, 383 skipped; PARTIAL RUN, not the release gate.** Configured projects root byte-identical **true**.
- New service/route tests cover concurrent cancelled Retry All, individual-first Retry for each of subtitles/Scene Plan/Scene Review, universal Retry replay, unchanged original rows, archived cancelled plan, exact scopes/force false, first unresolved Audio Assembly, subtitle-only first queue dispatch, invalid source/override rejection, and no automatic selection of unrelated cancelled rows.
- Final `npm run typecheck:electron`: exit **0**. `npm --prefix frontend run typecheck`: exit **0**. `git diff --check`: exit **0**.

The initial report's scheduler/UI-geometry/provider qualification limits still apply. This correction uses the same public Task 1b API and introduces no automatic permission to buy replacements for cancelled work.

## Re-review correction: inherited pipeline force

The reviewer found an Important remaining hole in `35a142c2`: direct cancelled source descriptors cleared force, but `pipeline_chain` children lacked that source marker and the non-DAG tail was copied wholesale. A cancelled subtitle source could therefore carry a child Scene Review `force: true` into fresh durable dispatch.

Correction commit: `30261b4971bae2d15509de6bf6ebb1d88c2002e2` (`fix: clear forced generation throughout cancelled recovery chains`).

The final descriptors of a plan derived from explicit cancelled intent are now normalized after source precedence resolution. Every DAG node and every non-DAG tail descriptor receives `force: false`. Existing audio `no_overwrite` is also set false: source inspection confirmed that `generators/audio.ts` generates a new version under that option even if force is false. Legacy `generation_mode: regenerate/new_version` becomes `skip`. Model, exact sections/indices, voice, reference strength, and other non-regeneration settings remain unchanged. Original cancelled source objects and their force/cancellation evidence are not mutated.

The added RED test failed on the pipeline child retaining true rather than false. The GREEN regression asserts copied Scene Plan and Scene Review settings, multiple tail nodes, source immutability, real queued Scene Review `force: false`, persisted queue params on disk, and the ordinary tail's queued params and remaining chain. Continuity Render reads `params.force === true` to choose its fresh attempt scope; the tested false value takes its resume/missing path, not force re-render identity. No generator/provider execution was performed.

- `node scripts/testing/run-backend-tests.mjs --only episode-recovery`: exit **0**, **19 passed / 0 failed**, completion `suite coverage: 1/1 file(s) completed, 19 test(s) + 0 suite(s) = 19 marks`. **1 selected / 384 skipped; PARTIAL RUN, not the release gate**. Configured projects root byte-identical **true**.
- `npm run typecheck:electron`: exit **0**.
- `git diff --check`: exit **0**.
- No frontend code changed in this correction; no additional UI test/typecheck run was necessary. No paid-engine source, dependency, provider, deployment, push, merge, or live-data changes.

## Final whole-branch review correction: terminal retries, finalizer handoff, whole-track mode

Base was `6c923e67`, which already integrated the reviewed paid engine. Implementation: `44c65cadd8c5c6d45b7c62aee2819c4d70ea8134` (`fix: resume recovery edges and preserve subtitle mode and handoff`).

### Three reproduced causes

1. Existing failed recovery edges were returned unchanged unless they exposed the narrow automatic free/waiting states. Explicit Retry therefore could not repair ordinary transport/download or Scene Plan failures.
2. The queue's warning-only subtitle failure handler already queued a directly-following metadata/finalizer chain, but the episode plan copied and later dispatched it under a different ID. That could duplicate the finalizer and its paid children.
3. The coordinator assumed chapter coverage for `per_chapter: false`, despite the generator using the single public section `merged` and writing `CODE_whisper.srt`. Intersecting that with chapter gaps blocked reclaim; requiring chapter stitching also blocked subtitle-only completion.

### Behavior now

- Explicit saved-source Retry can requeue the failed first unresolved edge **as the same durable job**, under its existing lock, after persistence and before pumping. No new job/plan/provider identity, budget ledger, generation epoch, or settings snapshot is minted. Cancellation and abandonment still block re-entry. Automatic observation retains its narrow public free/waiting eligibility and never loops ordinary terminal failures. Duplicate explicit intents for an already queued/running managed edge reuse the plan instead of failing source validation or duplicating queue admission.
- A previous forced but **failed** operation can be explicitly re-entered as that same job with unchanged prior params and provider IDs; this is not a new forced operation. Automatic recovery still rejects force. The separately fixed cancelled-source retry still creates normalized `force: false` descriptors, and cancelled rows are never resumed.
- The failure handler, successful subtitle-to-metadata handler, and coordinator now share `subtitle-finalizer-<source-job-id>` as a durable handoff ID. A persisted source handoff tombstone is copied/adopted into the plan, so terminal tail history pruning cannot grant another tail. The intentional warning-only YouTube Finalizer behavior is preserved; the original subtitle remains failed/repairable while the same finalizer continues once.
- Whole-track mode uses its authoritative single `merged` scope. An old chapter selector is ignored exactly as the whole-track generator ignores it; no chapter jobs are invented. Valid parsed `CODE_whisper.srt` cues complete a subtitle-only recovery without manufacturing a chapter stitch. The existing section-mode source/hash/metadata verification remains unchanged.
- **Owner-approved product boundary:** if downstream Scene Plan is requested, it still requires a genuine verified per-section stitch. A recovered whole track without one remains held with: “Whole-track transcription is complete. Scene Plan requires a verified per-section subtitle stitch; no chapter transcription was started.” An existing valid chapter stitch is used/preserved. No whole-track-to-chapter conversion or invented metadata was added.
- No edits to `subtitle-recovery.ts`, payment/settlement implementation, or the separately owned `subtitles.ts` fresh-status correction. The paid-engine test file only gained a consumer regression invoking its existing public API with mocked HTTP.

### Focused proof

Initial RED run: **3 failures / 63 tests**: explicit Retry remained error; whole-track expected/missing scope was empty; warning finalizer count was 2 instead of 1. Additional RED assertions caught ignored whole-track selectors, absent persisted handoff tombstones, and explicit prior-force re-entry remaining held. The queue-position test was corrected to compare its original position, since the global test lane also contained other fixture jobs; it never assumed an empty process-wide lane after that correction.

- `node scripts/testing/run-backend-tests.mjs --only episode-recovery --only job-queue.test.ts --only subtitle-recovery-engine`: exit **0**, **113 passed / 0 failed**, 13 suites; completion `suite coverage: 3/3 file(s) completed, 113 test(s) + 13 suite(s) = 126 marks`. **3 selected / 382 skipped; PARTIAL RUN, not release gate**. Configured projects root byte-identical **true**. This preceded only the last ignored-selector/handoff-tombstone/prior-force refinements.
- Final queue/coordinator regression after those refinements: `node scripts/testing/run-backend-tests.mjs --only episode-recovery --only job-queue.test.ts --only job-queue-genstudio-resume --only job-queue-auto-retry`: exit **0**, **90 passed / 0 failed**, 17 suites; completion `suite coverage: 4/4 file(s) completed, 90 test(s) + 17 suite(s) = 107 marks`. **4 selected / 381 skipped; PARTIAL RUN, not release gate**. Configured projects root byte-identical **true**.
- The new queue regression runs the actual subtitle failure handler with stubbed executors, then coordinator recovery and serialized restart. It asserts one finalizer, one paid-child executor run, one persisted handoff identity/tombstone, and no duplicate tail.
- Coordinator tests cover explicit download/transport/Scene Plan failures, unchanged saved request/budget IDs, repeated concurrent retry, restart serialization, unchanged queue position/no duplicate admission, whole-track failure/retry/success, canonical merged scope, precise downstream stitch hold, and preserved existing chapter sources/stitch.
- Public Task 1b regression recovers an accepted `merged` task after mocked transport and SRT download outages, serializes/reloads job state between calls, obtains the same SRT, and records **zero fresh POSTs and zero confirmations**. No live/provider calls occurred.
- Final `npm run typecheck:electron`: exit **0**. Final `git diff --check`: exit **0**. No frontend implementation changed, so the requested conditional frontend rerun was not needed.
- The existing auto-retry fixture emitted its known asynchronous ENOENT temporary-project cleanup warning during the final batch; the suite finished successfully. This is not a warning-free or full-release-gate claim.

The earlier real-app scheduler, screenshot geometry, and real-provider qualification limitations remain. No push, merge, deploy, full suite, or live-data writes were performed in this correction.
