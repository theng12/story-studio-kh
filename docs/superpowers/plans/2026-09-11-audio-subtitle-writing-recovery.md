# Audio, Subtitle and Writing Recovery Implementation Plan

**Goal:** Make replacement audio flow cleanly through merge and targeted subtitles, and add explicit and opt-in automatic replacement of confirmed failed audio/writing work.

**Architecture:** Reuse Audio Generator's persistent action pattern, authoritative audio fingerprints and subtitle stitching. Extend the existing machine-local replacement settings and durable request evidence; keep paid confirmation at the provider boundary. No new provider routing or generation framework.

**Tech stack:** Vue/Nuxt, TypeScript/Express, atomic JSON stores, existing GenStudio client, local FFmpeg, existing Node test runners.

**Spec:** The owner's accepted request in this task: floating Audio Assembly controls; default replacement of merged audio with optional versioning; identify changed chapter audio and transcribe only stale/missing chapters; re-stitch for merge timing changes; recover first, then deliberately replace confirmed failed audio/writing items; separate automatic Audio/Writing toggles off by default and independent positive per-job ceilings, at most one automatic replacement per failed item. Completed files stay untouched. Submission uncertainty requires authoritative reconciliation, not elapsed-time inference.

## Global constraints and instruction snapshot

- Read project AGENTS: selected model's live catalogue owns capabilities, price and limits; no hardcoded provider/model options.
- Preserve episode-owned source paths and explicit choices; selected active audio is authoritative.
- Completion requires usable current artifacts; never infer freshness from file presence alone.
- No paid probes, production setting changes, live queue mutation, app restart, or unsolicited messages.
- One test suite at a time. Use focused checks while editing, full npm run verify before release.
- Runtime release needs package/lock bump and newest changelog; independent review; Actions disabled before repository integration; final unsigned DMG built and verified from merged canonical main.
- Base: 656c3b1d. Worktree: .worktrees/audio-writing-recovery. Existing unrelated critique file in main preserved.

## 1. Audio Assembly actions

Files: frontend/pages/projects/[slug]/audio-merge.vue and focused frontend tests; trace audio merge request/schema/generator defaults before changing backend.
- [x] Reproduce existing default-to-version behavior and locate output-choice UI.
- [x] Add persistent action bar using the established Audio Generator layout, readable current target and merge state. Keep replace/version choice beside action; native responsive controls and keyboard access.
- [x] Default new merge action to replacing current merge. New version remains explicit. Applying ordinary reusable settings must not silently override the requested default or carry another episode's output.
- [x] Test first merge, replace existing, explicit version, episode switch, pending/blocked/running states and duplicate click.

## 2. Subtitle freshness and narrow repair

Files: subtitle status route in electron/server/routes, services/subtitle-completion.ts and subtitle-stitcher.ts, generator per-chapter path, frontend/pages/projects/[slug]/subtitles.vue and focused tests.
- [x] Inspect SS0079 logs and read-only source evidence. Pin a test: replace Chapter_01 bytes or active filename while SRT remains; status must report only Chapter_01 stale.
- [x] Reuse inspectSubtitleSourceFreshness in status and completion so present and current counts differ honestly. Show stale chapter reason beside its action, and offer transcribe stale/missing only.
- [x] Evaluate fingerprint before existing-SRT skip; old accepted provider output must not be adopted for changed source bytes.
- [x] Preserve unchanged SRTs; re-transcribe changed Chapter_01 only and re-stitch the timeline with current merge timing.
- [x] Distinguish merge-only timing changes: restitch without ASR charges. Test replaced source, same bytes/new path, versioned active source, stale/unknown provenance, lost response, episode switch and unchanged complete output.

## 3. Confirmed failure replacement

Files: existing app-settings service/routes, ThisMacSettings.vue, Jobs actions, audio.ts, durable language client/call context, existing replacement-policy helpers and tests identified by the design audit.
- [x] Inventory authority, exact live quote/price support and durable checkpoints for Audio and Writing before selecting implementation seams.
- [x] Add separate machine-local Audio and Writing opt-ins with validated ceilings. Off stays off on upgrade; the image/subtitle switches never enable these.
- [x] Manual Jobs replacement scopes to original failed sections/requests, recovers accepted work first, preserves successful outputs and returns an actual queued/blocked outcome.
- [x] At automatic replacement: verify confirmed eligible terminal failure and complete settlement; resolve selected model and fresh provider price; atomically reserve allowance and a stable replacement identity before one physical submission; replay the same accepted identity across retry/restart.
- [x] Refuse uncertain, cancelled, active, malformed, authentication, configuration and unavailable-credit cases without buying replacement work. Disabling policy before confirmation revokes unsubmitted authority.
- [x] Show checking, replacement queued, recovered or concrete blocker. Keep intentional audio quality regeneration available separately.
- [x] Test opt-in/ceiling validation, concurrent budget accounting, single replacement cap, partial output preservation, restart, cancellation/Off and zero duplicate POSTs. If GenStudio lacks a required enforceable price/confirmation contract, document the exact contract gap and coordinate the existing GenStudio task; do not pretend a local estimate guarantees a spending ceiling.

## 4. Integration and release

- [x] Review each bounded change independently; inspect rendered Audio Assembly/Subtitles/Settings/Jobs at desktop and narrow width.
- [x] Run focused regressions and every full verification lane; inspect actual exit status and test counts (see the resumed-lane receipt below).
- [ ] Bump version/changelog together, integrate reviewed branch with Actions disabled, synchronize canonical main, build npm run dist:smoke and verify bundled version/dependencies/launch.
- [ ] Clean own branches/worktree and test processes. Report remaining provider reconciliation separately from application fixes.

## Dispatch ledger

- audio_assembly_actions (Sol high): Audio Assembly frontend and tests; starts base656c3b1d. Completion evidence: focused mounted tests + visual check.
- subtitle_freshness (Terra high): subtitle source/current status, timestamp, narrow repair and settings; starts base656c3b1d. Completion evidence: failing source-change regression, passing focused checks and rendered QA.
- replacement_design (Sol high): replacement contract audit, then manual Jobs action/exact request map and focused tests. Final independent review of automatic policy.
- Primary: plan, automatic policy/client/queue integration, review and release. Tests are serialized by explicit slot handoff.

## Execution findings and accepted addition

- Audio overwrite previously wrote the base filename while status selected highest `_vN`. Fixed to replace the actual active merge. Persistent output controls wait for authoritative merge status; reviewed at desktop, tablet, phone and deep scroll.
- Subtitle freshness existed in the shared inspector but was omitted from status and checked after the SRT skip. Focused source-change regression now passes; stale sources cannot be stitched until updated.
- Owner additionally requested a visible last stitch/re-stitch date/time (2026-09-12). Subtitle agent owns source-backed timestamp + unknown/stale distinctions.
- GenStudio task 01a0905f-2610-77f0-a8d9-8ca7a439495c implements optional `max_charge_credits` on TTS/Chat; authenticated fresh `/v1/account/overview` advertises `max_charge_credits_supported_operations`. Old server/missing support blocks automation. No live restart/deploy/paid call authorized. Chat cap includes token/reasoning/search maximum; TTS uses fresh quote `maximum_credits`. HTTP409 MAX_CHARGE_EXCEEDED is a no-dispatch blocker.
- Story stores immutable cap/key per exact request fingerprint before POST, holds unknown spend, releases only authoritative balanced settlement, and restores accepted replacement requests across crash/retry. Separate audio/writing settings remain off by default.
- Review identified and fixed audio uncertainty exclusion and restore paths; new restart/uncertainty integration tests in progress. Manual writing replacement needs per-original-key replacement mapping rather than one shared batch scope.

## Verification ledger (focused, not release gate)

- Subtitle backend 39/39; initial RED reproduced stale-SRT skip. Frontend 5/5 initially, then settings/subtitle combined11/11.
- Audio merge filename regression RED then2/2; workspace3/3; selection safety3/3; rendered geometry inspected.
- Settings backend6/6; parser preserves existing validation errors and independent defaults.
- Automatic writing integration8/8 before final restart strengthening; needs repeat with added crash tests.
- Backend typecheck exit0 before final recovery changes. Full verify/release still pending.

## Final review corrections

- Max-one applies to automatic attempts, not a lifetime ban on deliberate manual replacement. A new confirmed failed manual child may be replaced explicitly; repeated clicks on the same source return its existing child. Ordinary retry retains its exact manual request map and provider evidence.
- A private SHA-256 connection fingerprint binds automatic receipts to the original API origin and credential. Connection changes cannot turn a missing lookup into a new purchase on another account.
- An exact manual replacement key takes precedence over an automatic same-payload fingerprint. Web-search choices participate in writing identity without changing historical non-search hashes.
- Stitch timestamp stays visible beside stale warnings, includes seconds, and reports unavailable for metadata without a valid timestamp. Unavailable freshness shows unknown counts rather than green completion.
- Final focused manual Jobs backend6/6 and frontend37/37 passed. Timestamp routes172/172 and subtitle UI8/8 passed. Lint exit0 (existing warning backlog remains). New identity regressions and full release suite pending.

- First full verification stopped at backend typecheck: queue lookup is Job|null while manual-key helper allowed only Job|undefined. Widened the helper to accept null (already safely handled by optional chaining) and restarted full verification. No suite had run yet.
- Final identity focused suites: recovery6/6 and boundary56/56, both exit0. Independent automatic/manual money-path review closed with no remaining findings.
- GenStudio cap contract merged as PR145, e33ed769, v1.24.84; full backend4693 passed/1 skipped, final affected145 and frontend335+705 passed in its own task. Live remains1.24.83 until owner restart; Story checks actual authenticated support every automatic attempt.

- Full verification passed lint/backend+frontend types then was intentionally stopped during backend tests (exit143) after independent trace proved ordinary Audio Retry could mint fresh work for CLOUD_SUBMISSION_UNCERTAIN. Generalize the current-manifest uncertainty recovery guard beyond manual replacement children and add an executor-level zero-POST regression before restarting the full suite. Intermediate full run is not a passing release gate.

- Ordinary audio uncertainty fix now preserves current provider evidence across queue retry and bypasses fresh identity creation. Executor-level regression passed1/1, exit0, proving zero extra provider POSTs. Full verification restarted with final product diff.

- Final uncertainty review required complete, unique task/key evidence for every current checkpoint and an executor-level contradiction rejection. Focused executor1/1 passed with missing-second-checkpoint, same-task/different-key, zero-POST exact recovery and normal terminal-retry cases. Independent review closed clean before final full-suite restart.
- Rendered QA: timestamp/stale-warning coexist; settings audio/writing cards; true390px CSS viewport has no right overflow (initial Retina harness clipping was a measurement artifact). Screenshots are retained in canonical logs/audio-writing-recovery. All QA servers/browser processes stopped.

- Complete backend run finished exit1: 5138/5140 passed across462/462 files, no skips; configured project root byte-identical. Both remaining failures were stale test fixtures: moved Merge-button binding (updated exact predicate), and a fake provider ID audited as not_created before an older synthetic success. Corrected the latter to a real mock running task with a settlement callback during the disk audit; preserved production recency merge. Focused scene repair25/25, replacement recovery6/6, manual replacement6/6, readiness3/3 all exit0; root independently reviewed fixture correction and audio agent reviewed readiness assertion. Full verification restarted.

## Final release verification

- Final backend production diff: full official suite **5140/5140 passed**, **462/462 files**, no skips; configured projects root byte-identical. Lint exit0 (1864 existing warnings, zero errors), backend and frontend typecheck exit0.
- The same `npm run verify` then stopped on one stale frontend source assertion (1711/1712): its exact accessibility label omitted the newly implemented stale-chapter `Update` branch. Corrected only that test regex; independent audio-agent review confirmed the actual three-state label. No backend/runtime code changed after its passing suite.
- Resumed all remaining official full lanes with `npm run test:frontend && npm run test:release && npm run test:content-packs && npm run build`, **exit0**: frontend1712/1712 across185/185 files; release36/36 across4/4; content-packs366 passed,2 skipped across38/38. The two skips require external `STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT` artifacts and are unrelated to this runtime batch. All changelog, typography, production security, model-drift, release-source and built-startup checks and both production builds passed.
- This is complete lane-by-lane release evidence, not a claim that the initially interrupted `npm run verify` returned zero. Backend was not unnecessarily repeated for a frontend-test-only correction.
- Evidence: canonical `logs/audio-writing-recovery/verify.log` (backend and initial frontend), `verify-resumed.log` (remaining final full lanes/build). Focused/earlier failed runs remain separate evidence.
- Copy-only final polish clarifies bulk subtitles update missing **or outdated** sections. Subtitle agent confirmed the existing generator skips only current SRTs; all final frontend tests/build used this wording.

- Final Jobs visual QA found and fixed one feedback bug: local blocked outcome vanished on the failed source card when its toast expired. Preserve that local reason until another attempt replaces it, but let later status `done` supersede the old warning. Focused Jobs37/37 passed; independent replacement-agent review clean. True390 CSS viewport measured390/390/390 inner/client/scroll width, Replace button remained fully inside viewport, disabled checking→queued and blocked outcomes verified using mocks. Desktop screenshots independently inspected by root. All QA services/browser processes stopped.
- Final frontend-only feedback fix triggers frontend typecheck + full frontend suite + production build again; unchanged backend/release/content-pack lanes retain their completed evidence.

- Final Jobs feedback diff: frontend typecheck, full frontend1712/1712 and full production build/check chain all completed **exit0**. Independent state-precedence review clean. Source implementation and validation complete; post-merge packaging and cleanup receipt belongs in canonical logs/audio-writing-recovery.
