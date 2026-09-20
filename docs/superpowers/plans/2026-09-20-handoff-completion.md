# Story Studio handoff completion implementation plan

> **For agentic workers:** Use subagent-driven-development for task execution and independent review. Follow the task brief, repository rules, and the orchestrator's test reservation.

**Goal:** Close the migration handoff with verified repairs, disposition of every historical candidate, reviewed integration, and a verified local desktop artifact.

**Architecture:** Preserve the recovery worktree and existing changes. Work in small, independently reviewable batches, with parallel investigation or disjoint implementation and one serialized verification lane. Investigation tasks produce evidence and a bounded repair brief before uncertain behavior is changed.

**Tech Stack:** TypeScript, Node, Express, Vue/Nuxt, Electron, FFmpeg, existing node:test runners.

**Spec:** AGENTS.md; docs/handoffs/2026-09-20-new-computer.md; docs/audit/2026-09-20-bug-backlog.md; the owner's latest 2026-09-20 delegation ruling (Luna straightforward, Terra cross-file, Sol at most high for integrity/security/lifecycle).

**Execution checkpoint, 2026-09-21:** the scoped runtime repairs have independent
review and completed corrected full test lanes: 7,855 pass, 3 explicit skips,
0 failures across 7,858 tests; production build, typechecks and audits pass.
The TTS queue fixture also passes in the full backend gate. Universal media
resources are verified. Historical-candidate inventory is complete as an inventory,
not exhaustive behavioral closure (30 open and 2 partial rows remain). Integration
and main-built packaging are complete through PR #123 and its verified local
v1.4.213 artifact; the installed native app is open at fresh Library setup. See
[the evidence/status ledger](../../audit/2026-09-20-workflow-progress.md) for
accepted results, partial task completion, full-verification status and remaining
limitations. The unchecked task lists below are acceptance criteria for the whole
handoff, not a claim that every listed action is still untouched.

### Final task acceptance summary

Tasks 1–9 are accepted within their named repair/toolchain scopes; Task 10 is a
complete evidence inventory, not 89 closed defects. The selected repairs in
Tasks 11–13 are accepted, while their historical open/partial candidates retain
specific follow-up checks. Task 14's inherited findings were routed and scoped
re-reviews closed the resulting blockers; the Upload Center branch is already
patch-equivalent. Tasks 15–16 are complete for the local unsigned application
release. The original detailed checklists below are retained as planning history,
not a claim that every historical matrix was exhaustively executed.

## Global constraints

- Worktree: `<owner-home>/.codex/worktrees/story-studio-kh-recovery/story-studio-kh`; branch `codex/recover-interrupted-audit`.
- Preserve all existing uncommitted A1/A2 changes. Main stays clean until reviewed integration.
- Selected-model catalogue values stay live. No invented limits, provider dispatch, or stale episode state.
- Preserve customer files, purchased output, recovery evidence, quarantine bytes, ownership and signatures.
- No paid generation, real upload, hosted Actions, deployment, publication, tags, or destructive disposal.
- Workers do not commit, mutate branch/index state, or delegate. Orchestrator integrates under standing authorization only after gates.
- One suite at a time. Read-only workers never run suites. Every run records command, actual exit, completion line, count, and log.
- Orchestrator owns package versions, changelog, shared lockfiles, graph refresh, and final checks; dependency worker may edit manifests/locks only after an exclusive reservation.
- Parallel implementation is allowed only for disjoint write scopes. This follows the owner's explicit fanout instruction over the skill's serial-implementation default.
- No separate approval pause for already-authorized reversible work. Unrecorded product choices and missing private migration material remain explicit dependencies.
- A task is complete only after consequence-based verification, independent spec/quality review, and orchestrator acceptance. Source assertions alone do not prove rendered UI or real workflow behavior.
- Retain durable status in docs/audit/2026-09-20-workflow-progress.md; scratch reports live in this plan's ignored SDD directory.

## Model and effort policy

| Role | Initial model / effort | Escalation |
|---|---|---|
| Planning, architecture, independent review, verification, integration | GPT-6 Astra orchestrator | Split unresolved contracts into smaller investigations |
| Involved cross-file implementation | GPT-5.6 Terra / high | Sol / high only when integrity/security/lifecycle warrants it |
| Straightforward implementation/environment/inventory | GPT-5.6 Luna / medium | Terra / high if complexity exceeds the brief |
| Data-integrity, security, lifecycle implementation | GPT-5.6 Sol / high maximum | Narrow task; orchestrator resolves architecture |

Choose by actual result quality, not a quota of models used. A slow or incomplete assignment gets a narrower brief or a different model. Silence is not evidence of failure; check durable reports before interrupting.

## Review focus

1. Switching from an explicit output allowance to an unpublished maximum: request and displayed allowance agree (Task 2).
2. Corrupt pack state followed by restart: recovery remains visible and original bytes survive (Task 5).
3. Valid-looking stale audio or unreadable filesystem: errors cannot become ready/intact (Tasks 7-8).
4. Zero expected artifacts: optional no-op remains valid, unknown required output does not (Task 9).
5. Interrupted paid generation / provider success followed by local failure: recovery preserves completed work (Tasks 10-12).

## Scheduling and test lane

Wave 1: Tasks 1, 2, 3 and 4 run concurrently with disjoint scopes; Task 14 inventory can run read-only alongside them.
Wave 2: After dependency triage and source freeze, update dependencies, implement the Task 5 design and Task 6 repair. Tests serialize; dependency installation cannot overlap any test/build.
Wave 3: Tasks 7-9 reproduce and repair one contract at a time. Task 10 triage proceeds read-only.
Wave 4: Tasks 11-13 investigate historical candidates and repair only reproduced survivors in bounded batches.
Wave 5: Task 14 whole-history review, Task 15 final gates, Task 16 integration/artifact/handoff.

The orchestrator grants the test lane by explicit agent message. A worker without the lane may edit its own files and produce runnable tests, then report READY_FOR_TESTS. Read-only review never needs the lane. Targeted checks precede full gates; do not repeat full suites for documentation/whitespace changes.

### Task 1: Restore the local media toolchain

**Owner:** Luna / medium. **Depends on:** none. **Write scope:** ignored bundled/ffmpeg outputs and task report only.
**Inputs:** scripts/fetch-ffmpeg.mjs, scripts/testing/run-backend-tests.mjs, existing media binary resolver.
**Produces:** verified native binary paths and exact test environment; no application code change.

- [ ] Inspect fetch script, platform and existing output/temp paths before running its cleanup.
- [ ] Run `npm run fetch:ffmpeg`; preserve pinned hash verification. If download/hash validation fails, report source/error and use no unverified substitute.
- [ ] Execute both resulting binaries with `-version`, inspect architectures, and trace how backend tests resolve them.
- [ ] Return exact environment needed by the verification lane, plus command exits. No full suite in this task.

### Task 2: Finish and verify no-ceiling Scene Plan behavior (A2)

**Owner:** Terra / high. **Depends on:** existing A2 patch. **Write scope:** frontend/pages/projects/[slug]/scene-plan.vue, frontend/utils/model-token-budget.ts, frontend/__tests__/modelTokenBudget.test.ts, frontend/__tests__/scenePlanWorkspace.test.ts, electron/server/services/scene-prompt-batching.ts, electron/server/generators/scene-plan.ts, corresponding scene-prompt tests.
**Inputs:** current uncommitted diff and backlog A2.
**Produces:** truthful selected allowance UI and request/recovery behavior.

- [ ] Reproduce explicit numeric allowance -> no-ceiling model switch with current watcher/normalizer and request assembly.
- [ ] Preserve explicit user allowance when valid; display it as user-chosen, never as a published model ceiling. For auto with no ceiling, omit max_output_tokens and display omission.
- [ ] Use the same resolved allowance for batch sizing/disclosure; retain configured batch when no numeric budget exists.
- [ ] Add behavior checks for auto/no ceiling, explicit/no ceiling, malformed published value, model switch, direct and Pipeline requests, persisted request snapshot and paid-work retry. Reuse existing mocks; no provider calls.
- [ ] With the reserved lane, record failing-before and passing-after focused checks. Report missing integration/visual evidence explicitly.
- [ ] Independent reviewer checks current A2 diff. Rendered validation belongs to Task 15 if unavailable during this task.

### Task 3: Audit and close A1 containment review

**Owner:** Astra orchestrator independent review. **Depends on:** existing A1 patch. **Write scope:** report only.
**Inputs:** routes/video.ts fingerprint diff, lib/preview-roots.ts diff, subtitle-preflight-fingerprint-containment.test.ts, existing containment/freshness tests.
**Produces:** spec and quality verdicts with concrete findings.

- [ ] Review guard before metadata access and shared canonicalization, including symlink, missing-file and configured media roots.
- [ ] Check regression assertions cover admitted and refused requests including server mode.
- [ ] Inspect only affected callers needed to evaluate shared helper changes; identify evidence gaps without treating them as proven runtime bugs.
- [ ] Return findings with path:line, severity and acceptance test. Do not run suites or implement changes.

### Task 4: Dependency exposure and safe update brief (A4)

**Owner:** Sol / high. **Depends on:** none for audit; implementation waits for exclusive manifest/lock reservation.
**Write scope:** report during triage; root/frontend manifests and lockfiles only during approved implementation window.
**Inputs:** root/frontend lockfiles; npm audit JSON; imports of sharp, mammoth/XML parsing; Nuxt build consumers.

- [ ] Run root/frontend production and all-dependency audits; retain exact findings and exit statuses.
- [ ] Trace all affected installed copies and direct/transitive consumers; distinguish shipped runtime from build tooling and unknown exploitability.
- [ ] Propose minimal compatible patch/minor updates using published advisory information. No force upgrades or suppressed audit rules.
- [ ] After reservation, update dependencies, install consistently, repeat all four audits and relevant media/import/render checks.
- [ ] Independent review of lockfile and dependency closure; Task 15 verifies built/package runtime.

### Task 5: Content Pack corruption recovery contract and repair (A3)

**Owner:** Astra / high design, Sol / high implementation; separate Astra review.
**Depends on:** Wave 1 verification ready. **Files:** electron/server/content-packs/state.ts, related state schema/registry/routes, frontend/composables/useContentStore.ts and existing Store notices, content-pack-state.test.ts.

- [ ] Trace invalid/missing/I/O states through registry and Store response; map lock/transaction boundaries using graph and source.
- [ ] Specify the smallest persistent recovery signal with a visible notice and supported reconciliation action; original quarantine bytes remain intact.
- [ ] Before implementing, record exact schema/API transition and backward compatibility in the task brief.
- [ ] Test invalid bytes, missing state, read error, restart, repeated recovery, retained installed versions, and failure of ownership/signature checks.
- [ ] Render the notice/action and verify recovery cannot activate unverified content. Independent security/recovery review before acceptance.

### Task 6: Correct health/version reporting (A7)

**Owner:** Luna / medium. **Depends on:** media setup complete; independent of Task 5.
**Files:** electron/server/app.ts, existing application-version helper, focused health route test.

- [ ] Trace existing app version source across dev and packaged runtime.
- [ ] Replace both literals with that source; do not duplicate a version constant.
- [ ] Test both route values against the real package version, including build output where supported.
- [ ] Independent review; final bundled app.asar comparison occurs in Task 16.

### Task 7: Reproduce and repair audio readiness (A5)

**Owner:** Sol / high. **Depends on:** media tools and stable dependencies.
**Files:** electron/server/services/audio-workflow-readiness.ts, generators/subtitles.ts, existing authoritative merged completion helper, audio-workflow-readiness.test.ts.

- [ ] Trace readiness into transcription admission and actual selected merged artifact.
- [ ] Build disposable cases for unrelated nonempty audio, superseded take, malformed/empty/unreadable audio and current merged audio.
- [ ] If an invalid artifact reaches readiness/admission, reuse the authoritative artifact/freshness resolver at the shared boundary.
- [ ] Verify valid paid transcript/audio is reused and only proven stale work is regenerated. If downstream admission already blocks the allegation, record that disposition instead of speculative code.
- [ ] Independent review with failing/passing workflow evidence.

### Task 8: Make failed manifest measurements explicit (A6)

**Owner:** Sol / high implementation, Astra orchestrator review.
**Files:** electron/server/services/manifest-audit.ts, its route consumer, frontend consumer discovered by caller trace, focused manifest audit tests.

- [ ] Trace stage results to route/UI and reproduce directory/read errors.
- [ ] Define explicit failed/unmeasurable result through existing typed response; preserve successfully measured stages.
- [ ] Test error is never reported intact or unstarted, genuine never-started remains valid, and retry can recover.
- [ ] Render affected state if UI changes, then independent review.

### Task 9: Audit zero-item completion contract (A8)

**Owner:** Sol / high, Astra orchestrator independent review for any shared contract change.
**Files:** electron/server/services/job-completion.ts and only proven affected artifact-producing callers.

- [ ] Enumerate requireJobCompletion callers using graph and source; classify explicit optional skip, legitimate no-op, required artifacts, and unmeasurable expectation.
- [ ] Produce caller table with evidence and exact expected behavior before any global predicate change.
- [ ] Add regression cases for a valid optional zero and an invalid required empty result.
- [ ] Repair only misdeclaring callers or introduce a minimal discriminator if evidence requires it; no blanket expected > 0 replacement.

### Task 10: Disposition every historical candidate

**Owner:** Luna / medium mechanical ledger; Terra / high source classifications.
**Depends on:** none for enumeration; final disposition uses Tasks 11-13.
**Files:** docs/audit/2026-09-20-candidate-appendix.md, evidence audit-candidates.json, FIX-PLAN.md, bug backlog, new candidate-disposition ledger.

- [ ] Give each of the 89 retained candidates one row: ID, source, prior disposition, current evidence, reproducer, next task, status.
- [ ] Use states reported/source-confirmed/reproduced/implemented/verified/resolved/retracted/blocked. Do not infer resolved from a commit subject alone.
- [ ] Preserve additions outside the 89 separately; identify duplicate allegations explicitly.
- [ ] Every row ends with a supported disposition or a specific remaining check. Unverified candidates cannot be presented as bugs.

### Task 11: Paid-output, queue and completion survivors

**Owner:** Sol / high; Astra orchestrator independent review for lifecycle changes.
**Depends on:** Tasks 7-10.
**Scope:** backlog completion/audio-writing/Scene Plan/queue recovery/transport rows.

- [ ] Split Task 10 survivors into one brief per behavior: completion read-back, stale audio/script, continuation preserving prompts, restart recovery, cancellation reconciliation, SSE reconnect/history growth.
- [ ] Reproduce with disposable state and fake provider; preserve stable IDs, paid receipts and partial artifacts.
- [ ] Implement only demonstrated root causes, then test complete/partial/stale/provider-failure/retry outcomes relevant to that behavior.
- [ ] Measure transport performance before optimizing; review and accept each behavior independently.

### Task 12: Publishing, archive and Content Pack lifecycle survivors

**Owner:** Sol / high; Astra orchestrator reviews deletion/ownership/provider effects.
**Depends on:** Tasks 5 and 10.
**Scope:** metadata latest version; archive/admission; scheduling/receipts/DST; copy identity; pack orphan/repair/activation/rollback/prune.

- [ ] Create separate bounded briefs for each surviving allegation.
- [ ] Test same-size/different-byte files before deletion-grade decisions; no real customer deletion.
- [ ] Simulate provider success/local receipt failure and verify recoverable idempotence; no live upload or schedule change.
- [ ] Exercise channel change, Lord Howe DST, exact signed identity and crash interruption as applicable.
- [ ] Independently review and verify each repair before integration.

### Task 13: UI, catalogue controls, and false-empty states

**Owner:** Terra / high with Impeccable; Astra orchestrator independent review.
**Depends on:** Task 10, stable backend response contracts.
**Scope:** Jobs, Settings, Scene Review, Research, Pipeline, Audio, Subtitles, Video Assembly, Content Store; named backlog survivors only.

- [ ] Partition by shared component/response contract to avoid conflicting edits.
- [ ] Reproduce selected-model changes, load failures, stale episode data, short viewport and keyboard interactions.
- [ ] Repair the smallest shared source; use live catalogue values and truthful empty/error/loading states.
- [ ] Verify with behavior tests plus rendered desktop/narrow/keyboard checks. Source snapshots alone do not close geometry.
- [ ] Reusable Scene Plan guidance is a separate feature: request the missing persistence choice when that task becomes ready, while continuing independent work.

### Task 14: Review inherited history and Upload Center branch

**Owner:** Luna / medium inventory; Astra orchestrator independent subsystem review and final synthesis.
**Depends on:** inventory may run now, final review waits for stable repairs.
**Inputs:** 70-commit inventory plus recovery commits, main/recovery refs, origin/codex/upload-center-clarity.

- [ ] Group inherited runtime diffs by security, paid work, model contracts, content packs, publishing, UI and documentation; track reviewed ranges.
- [ ] Review final behavior including reverts, not every intermediate patch as if it survived.
- [ ] Compare the Upload Center unique commit against current recovery; record keep/merge/supersede rationale.
- [ ] Route findings into bounded repair tasks and obtain scoped re-review.
- [ ] Orchestrator independent review covers combined diff, deferred findings, compatibility and test evidence.

### Task 15: Serialized release verification and isolated app smoke

**Owner:** orchestrator alone executes tests/typechecks/builds; independent reviewers inspect evidence without competing runs.
**Depends on:** frozen accepted source, toolchain, stable dependencies and version/changelog.

- [x] Reserve verification lane exclusively; record HEAD, dirty diff and environment.
- [x] Run `npm run verify`, retaining each stage's actual exit/count/completion line. Diagnose failures; do not weaken gates. Original failures are retained; corrected full lanes and build passed separately.
- [x] Repeat four dependency audits, check packaged runtime closure, and run isolated build/startup smoke using disposable Library.
- [x] Render A2 and changed recovery/UI states; verify backend address and version. No real credentials, paid jobs or upload were used.
- [x] Refresh code-only graph after structural changes; keep graphs ignored and note extraction limitations.
- [x] Separate missing customer data/credentials/external evidence from code failures; three explicit skips remain documented.

### Task 16: Integrate, produce local artifact, and close handoff

**Owner:** Astra orchestrator. **Depends on:** accepted Task 14 and green applicable Task 15 gates.

- [x] Recheck remote state, Actions disabled, mergeability, independent review, version and changelog.
- [x] Commit reviewed work, push/create and attach PR #123, then merge under existing authorization after gates. No force push.
- [x] Build official unsigned smoke artifact from main with `npm run dist:smoke`; no public signing/publication.
- [x] Verify root dist/ versioned arm64 filename, bundled app.asar version, startup and dependency closure against main.
- [x] Update handoff/backlog with exact commits, artifact hash, tests, candidate dispositions, and remaining product/account setup.
- [x] Resolve old-machine migration choice: owner selected a fresh setup on this Mac. No prior Library or private backup is required.
- [x] Verify isolated packaged startup and installed native first-run screen, then hand off normal Library/account setup without inventing credentials or ownership.
