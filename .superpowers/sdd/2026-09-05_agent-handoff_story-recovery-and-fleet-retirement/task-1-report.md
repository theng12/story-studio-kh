# AH-001 / AH-002 implementation report

Date: 2026-09-05
Worktree: `codex/agent-handoff-story-recovery`
Baseline: `6cb90aca4e6e340f6f58c5691c4eb820160f3a08` (`v1.4.101`)
Implementation commit: `e3970ddc16f7dd40897e3d88508e2eea4a61281b`

## Root cause and scope

No project `logs/` files existed in this isolated worktree. AH-001 was therefore assessed against its durable candidate recovery tests. The v1.4.101 `recoverSafelySettledStallJobs` path already satisfies the described `201/201` failure: it reclaims accepted image work by its saved task identity, requires authoritative terminal evidence, deduplicates repeated recovery signals, transitions the stalled job to `done`, and lets pipeline continuation execute once. No second stall-recovery mechanism was added.

For AH-002, `generateSubtitlesTranscribe()` correctly verified individual chapter coverage, then caught any auto-stitch error, emitted `Auto-stitch skipped`, and returned. The queue consequently persisted a successful subtitle job even when the required stitched timeline or its metadata was missing/stale. The Jobs-page retry mapping also dropped the exact `sections` allow-list.

## Changes

- Subtitle jobs now require an auto-stitch result of `stitched` and a valid timeline-integrity sidecar. Any skip, failure, or invalid metadata marks the structured result incomplete and throws a recoverable job error; successful section SRTs remain untouched.
- Restored `params.sections` in Jobs-page subtitle Retry so a retry remains confined to its durable missing-section list.
- Added the separate machine-local `paid_subtitle_replacement` setting, defaulting exactly to `{ enabled: false, additional_credit_ceiling: null }`, with strict flat validation and dedicated GET/PUT routes.
- Added the corresponding This Mac control with the owner-provided label: `Automatically buy one replacement for a confirmed failed subtitle section`.
- Bumped the application release to `v1.4.102` and added the newest-first changelog entry.

## Red / green evidence

1. RED: `node scripts/testing/run-backend-tests.mjs --only subtitle-stitcher` failed because `requireWrittenSubtitleStitch` did not exist. The intended failure was a skipped auto-stitch being allowed to return.
2. GREEN: after the boundary was added, the same focused suite passed 6/6 tests.
3. RED: `node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings` failed the new subtitle-setting test with `expected 200, got 404`.
4. GREEN: after implementing the separate app setting and routes, that new setting test passed. The file still has an unrelated baseline failure in its existing frontend composable test because this worktree cannot resolve package `vue`.

## Verification

- `npm run check:changelog` — passed; package, lockfile, and newest changelog entry agree on `v1.4.102`.
- `npm run typecheck:electron` — passed.
- `npm run lint` — exit 0 with 1,775 pre-existing warnings and no errors.
- `node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume --only subtitle-stitcher` — passed; this includes the v1.4.101 AH-001 candidate recovery coverage and the new stitch guard. This is explicitly a partial run, not the release gate.
- `node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings` — the new subtitle-policy test passed; the suite remains non-green only due to the pre-existing unresolved frontend `vue` dependency noted above.
- `npm --prefix frontend run typecheck` — blocked before type checking: `nuxi: command not found` in this worktree.

No full verification suite, build, DMG, deployment, publication, provider call, or live-data operation was run.

## Self-review and concerns

The completed fix is deliberately fail-closed: subtitle jobs cannot claim completion without a verified stitched SRT, and the image paid-replacement setting is not reused for subtitles.

AH-002 is **not fully complete** against the entire handoff. The durable per-episode recovery-plan DAG, automated free transcription reconciliation, manual `Buy missing subtitles now` action, and bounded automatic paid replacement execution/settlement protocol still need implementation and the corresponding acceptance suite. The new machine setting and UI are a safe authorization boundary only; they do not yet submit paid replacement transcription work.

## Follow-up verification — 2026-09-05

- Ran `npm ci` and `npm --prefix frontend ci` as requested. Root install reports 3 audit findings (2 moderate, 1 high); frontend install reports none. Neither lockfile changed.
- `npm --prefix frontend run typecheck` now completes successfully.
- Added the real mounted This Mac UI test for the independent subtitle setting and its separate endpoint/body. The broad frontend runner currently has unrelated failing tests and an unresolved `~` alias in `frontend/__tests__/useProject.test.ts`; it is not a clean release suite.

The underlying AH-002 recovery-plan, paid commitment, settlement eligibility, and topological downstream advancement requirements remain unimplemented. This follow-up improves verified UI coverage only and does not widen the completed implementation claim.

## Task 1b partial implementation — 2026-09-05

- RED: `node scripts/testing/run-backend-tests.mjs --only subtitle-paid-replacement` failed because the dedicated subtitle decision module did not exist.
- GREEN: the new pure, fail-closed decision seam distinguishes fully released zero-settlement free retries from eligible paid replacements; it rejects disabled policy, incomplete settlement, unavailable price, repeat sections, and a shared-ceiling overrun. The focused test passes.
- `npm run typecheck:electron` was rerun after the implementation and passes.

This commit does **not** yet wire the new decision seam into the merged/per-chapter provider POST branches or durable job/manifest commitment lifecycle. Therefore it does not satisfy Task 1b's full paid recovery behavior and must not be presented as doing so.

## Task 1b completion — fix round 4, 2026-09-05

Implementation commit: `5813c973` (`fix: durably bound paid subtitle recovery`). Starting commit: `4dbe4a64`. The worktree was clean at dispatch. Relevant repository requirements were the live-model authority rule, verified artifact completion, isolated/focused test workflow, and release integrity. This is part of the same unreleased `1.4.102` changeset; its existing package/lock version is retained and its newest changelog entry is extended. No Pinokio launcher or Task 1c dependency-DAG code was changed.

### Implemented behavior and durable authority

- Replaced the duplicate merged/per-chapter submission/replacement branches with `services/subtitle-recovery.ts`. Both generators now call the same provider boundary. The generator lost 420 net lines; total production code across this change is **44 lines smaller**, including the new 334-line engine. No dependency was added. This follows Ponytail's reuse/minimality discipline: existing atomic storage, path locks, task manifests, GenStudio client, and job checkpoints are reused.
- `.subtitle-recovery.json`, beside the episode's subtitle artifacts, holds a strict, atomic recovery ledger. Sections retain their input/output identity, original task/key, current key/task, submission state, and recovery-plan identity. Normal retries, separate Story jobs, and repeated clicks retain the episode plan and share its ceiling. A corrupt ledger or malformed budget cannot reset paid authority. A legacy incomplete identity may reconnect, but cannot authorize a purchase.
- Accepted tasks are read/polled by their saved task ID first, including when a local manifest says failed. A confirmation whose response/task checkpoint was lost is reclaimed by GenStudio's read-only idempotency lookup. An authoritative 404 permits only replay of that same saved identity. Unknown lookup/transport/settlement outcomes do not authorize a fresh replacement.
- The paid decision accepts only supported transient failures with a complete balanced reservation/settlement/release triad. Refusal, cancellation, malformed/auth requests, incomplete or unbalanced settlement, missing live quote cost/version, and disabled subtitle policy fail closed. The pure classifier no longer lets refunded refusal/cancellation or unbalanced settlement bypass eligibility.
- Immediately before every physical charged confirmation POST—including after admission or retry waits—the client invokes the authorization/checkpoint callback. It persists the original and replacement identity, ordinal 1, exact quote ID, quoted credits, price version, commitment timestamp, ceiling decision, and authorization source. The separate subtitle setting is re-read; the image setting is never consulted. The task ID is persisted before polling/download proceeds.
- One paid replacement per section is retained conservatively against the plan's shared ceiling. Concurrent missing sections cannot each spend the whole ceiling. A paid replacement that still fails stops with a precise needs-attention state and an explicit section re-run action. It cannot create another automatic replacement.
- Fully refunded transient failures and genuine quote expiry use durably derived free-retry keys, not paid allowance. A refunded replacement can retry under the same already-authorized ceiling while automatic purchasing is Off. Free retry loops remain bounded per invocation. HTTP 400/401/404/409/422 are not treated as free quote expiry. Expiry after a confirmation attempt first reconciles the saved key; it cannot retire an already-created task and charge again.
- Existing successful chapter skips and exact section selection remain intact. Explicit owner re-runs still generate fresh work, while restart of the same forced job reuses its identity. The existing full-track artifact check and per-chapter coverage/stitch integrity checks remain authoritative. Provider success is only `artifact_recovered`; `result.recovery_state: repaired` is written only at the generator's verified artifact/stitch completion boundary.

### Backend contract for Task 1c

`POST /projects/:slug/video-editor/subtitles/buy-missing/:jobId`

Body: `{ "additional_credit_ceiling": <positive safe integer> }`.

The route reads the authoritative failed subtitle job, refuses a running duplicate, takes `result.missing_sections` from that job, forces `force: false`, preserves the recovery-plan identity, and enqueues one manual purchase/recovery job. Caller-provided `sections` or `force` cannot widen it. The regular transcription route does not accept a raw `subtitle_purchase` override. Final Jobs-page placement is deliberately left to Task 1c.

Machine/plain states are persisted in `job.params.subtitle_recovery.sections[slug]`: `free_recovery`, `free_retry`, `waiting_settlement`, `paid_wait`, `paid_commitment`, `paid_blocked`, `artifact_recovered`, and `needs_attention`, each with a readable message. `manual_action` is `buy_missing_subtitles` for bounded eligible purchase, or `rerun_subtitle_section` when a new deliberate re-run/review is needed rather than another automatic replacement. The latter uses the existing explicit `force: true`, exact-section transcription action. `job.result` carries ready/expected/missing section coverage plus terminal `recovery_state: repaired | needs_attention`.

### Exact red/green evidence

All commands below used `scripts/testing/run-backend-tests.mjs`, isolated temporary settings/projects, and fake HTTP transport. No paid provider call was made.

1. RED: `--only subtitle-paid-replacement --only subtitle-recovery-engine`: exit **1**, `tests 9`, `pass 1`, `fail 8`. The pure decision incorrectly returned `commit` for an unbalanced reservation; the engine did not exist. After implementing the boundary and correcting the test's initially incomplete Job fixture, GREEN was exit **0**, `tests 9`, `pass 9`, `fail 0`, coverage **2/2 files**.
2. RED: `--only subtitle-recovery-engine`: exit **1**, `tests 15`, `pass 14`, `fail 1`; `subtitlePurchaseParams is not a function`. The exact-scope manual action was then implemented.
3. RED: `--only subtitle-recovery-engine`: exit **1**, `tests 20`, `pass 18`, `fail 2`. A fully refunded replacement incorrectly stopped when the owner switched Off, and valid JSON with an invalid manifest schema authorized fresh work. Both were fixed by retaining/refunding the bounded authorization correctly and using the strict manifest reader.
4. RED: `--only subtitle-recovery-engine`: exit **1**, `tests 25`, `pass 19`, `fail 6` (the previous two failures plus HTTP 400/404/409/422 incorrectly becoming free expiry). Expiry classification was narrowed; auth 401 was already correctly blocked.
5. RED: `--only subtitle-recovery-engine`: exit **1**, `tests 31`, `pass 27`, `fail 4`. Three real regressions were exposed: separately originated sections exceeded a common ceiling (`2 !== 1`), a missing original key authorized purchase, and a malformed commitment budget authorized purchase. The fourth was an incomplete HTTP fixture (`Project not found: _app_`), corrected by creating an isolated real project. GREEN afterward: exit **0**, `tests 33`, `pass 33`, `fail 0`, coverage **2/2 files** including the pure decision tests.
6. RED: `--only subtitle-recovery-engine`: exit **1**, `tests 32`, `pass 31`, `fail 1`; expiry after confirm created **two** tasks rather than reclaiming the first. Added read-only key reconciliation before retiring the quote commitment. Final GREEN: `--only subtitle-recovery-engine --only subtitle-paid-replacement`, exit **0**, `tests 34`, `pass 34`, `fail 0`; `suite coverage: 2/2 file(s) completed, 34 test(s) + 0 suite(s) = 34 marks`.

The final engine tests additionally cover accepted-task free recovery despite stale local state, Off/manual purchase, shared concurrent ceilings, repeated calls, free zero-settlement retries, unavailable price, paid-attempt exhaustion, artifact expiry, explicit re-run restart identity, corrupt ledger/manifest, and three crash boundaries: before the charged POST, after confirmation with a lost response, and after provider success with a failed task-ID disk write. The HTTP test exercises the real route and enqueue boundary and proves caller scope cannot override the saved missing set.

Source-pattern tests that demanded the old unconditional fresh-submission branches were removed/replaced by real engine behavior tests. The existing provider-isolation assertion now reads the shared engine as well as its generator caller.

### Verification

- `node scripts/testing/run-backend-tests.mjs --only subtitle-recovery-engine --only subtitle-paid-replacement --only subtitles-genstudio-retry --only subtitles-retranscribe --only subtitle-stitcher --only subtitle-completion --only subtitle-episode-concurrency --only genstudio-fleet-busy --only task-manifest --only job-queue-genstudio-resume`: **exit 0**, `tests 102`, `pass 102`, `fail 0`; `suite coverage: 10/10 file(s) completed, 102 test(s) + 10 suite(s) = 112 marks`. Includes AH-001's existing safely settled stall recovery and subtitle completion/stitch regression coverage.
- `node scripts/testing/run-backend-tests.mjs --only genstudio-client-boundary --only genstudio-video-tts-transcription-hardening --only paid-image-replacement-settings`: **exit 0**, `tests 86`, `pass 86`, `fail 0`; `suite coverage: 3/3 file(s) completed, 86 test(s) + 0 suite(s) = 86 marks`. The earlier partial run across the boundary/engine/retry files reported **92/93**, with one stale source-location assertion; the final boundary run above verifies its correction.
- Final focused engine/eligibility run: **34/34**, exit **0**, as recorded above. Filtered runs are explicitly **not the full backend release gate**; the overlapping counts must not be added as unique tests.
- `npm run typecheck:electron`: **exit 0**, rerun after final production edits.
- `npm run lint -- --format json`: **exit 0**, **0 errors / 1,772 warnings** repository-wide; the new recovery module has **0 warnings**. The initial lint run before removing new explicit-any annotations had 1,777 warnings. No unrelated warning cleanup was attempted.
- `npm run build`: **exit 0**. Source changelog, typography, security, model-drift, release checks; Nuxt production generation; Electron production build; built security/release checks passed. Existing Nuxt ineffective-dynamic-import/plugin-timing warnings remain. `npm run build:electron`, `npm run check:security -- --built`, and `npm run check:release -- --built` were rerun after the final backend edits and all exited **0**.
- `npm run check:changelog`: **exit 0**, package, lockfile, and newest What's New entry agree on **v1.4.102**.
- `git diff --check`: **exit 0** before committing.

### Preserved boundaries and remaining qualification

The default setting remains Off. Successful files, image authorization, exact section selection, cancellation/pause checks, strict completion/stitch guards, and the existing GenStudio admission/idempotency protocols are preserved. There were no dependency changes, live project changes, paid calls, pushes, merges, tags, deployments, or DMGs. No test/dev child process is intentionally left running.

The full unfiltered backend/frontend/release/content-pack suites have **not** been run, so this is not a release-ready/full-suite claim. No live provider contract or paid end-to-end qualification was performed; the engine intentionally refuses a quote without both an authoritative cost and price version. Task 1c still owns the durable dependency DAG, topological Retry All, and final Jobs-page action placement. Those omissions are intentional scope boundaries, not claims that AH-002 as a whole is finished.

## Task 1b review fixes — replacement provenance, Off race, ledger-only rerun

Starting commit: `d669fc69`. Addressed the Critical persisted-provenance finding and both Important follow-ups without changing Task 1c.

- `readLedger()` now rejects malformed replacement original task/key, unverified identity, non-boolean failure flags, absent or ineligible/unbalanced settlement, unrelated replacement key lineage, and disagreement with an existing commitment's original/input/output identity. Optional confirmation/free-retry fields are type-checked. These checks run before any provider request, not merely at charged confirmation. The ledger remains a local recovery record, not a cryptographic attestation against an attacker who can rewrite all local authority consistently.
- The canonical subtitle setting writer and every paid physical confirmation share the existing atomic-store mutex mechanism. The gate includes final policy reads, durable commitment/checkpoint writes, and the physical confirm request; it excludes admission/retry waits. Off either wins before confirmation and blocks it, or waits for the already-authorized request to cross the gate before acknowledging. Validation failures before the physical POST are not treated as retryable transport failures. Free/manual recovery distinctions remain unchanged.
- Forced rerun considers the surviving recovery ledger as well as the task manifest when creating its job-scoped fresh key. A new explicit rerun therefore cannot replay the original key when only the manifest was lost; restarting that same forced job still reclaims its saved identity.

Exact RED: `node scripts/testing/run-backend-tests.mjs --only subtitle-recovery-engine --only subtitle-paid-replacement` exited **1**, `tests 45`, `pass 34`, `fail 11`; `suite coverage: 2/2 file(s) completed, 45 test(s) + 0 suite(s) = 45 marks`. All nine new corrupt-provenance cases failed: invalid original fields reached the quote, permissive truthy/absent flags and unverified/unrelated identities could confirm, and malformed settlement/failure was rejected only after provider access. The Off interleaving acknowledged `off` instead of remaining `pending`. The ledger-only forced rerun created one billed identity instead of the required two distinct deliberate identities.

Exact final GREEN: the same focused command exited **0**, `tests 45`, `pass 45`, `fail 0`; `suite coverage: 2/2 file(s) completed, 45 test(s) + 0 suite(s) = 45 marks`. The Off regression was strengthened after initial green to pause the final On settings snapshot **before POST**, proving that an Off mutation cannot slip between that snapshot and physical confirmation; the final 45/45 run includes this stronger version. The pending-quote Off test now uses the canonical setting writer. Every corrupted ledger case asserts zero provider calls and zero confirms; the rerun case also verifies same-job restart reuse.

Additional verification: `node scripts/testing/run-backend-tests.mjs --only genstudio-video-tts-transcription-hardening --only paid-image-replacement-settings` exited **0**, `tests 31`, `pass 31`, `fail 0`; `suite coverage: 2/2 file(s) completed, 31 test(s) + 0 suite(s) = 31 marks`. Both harness runs reported configured project-root bytes unchanged. `npm run typecheck:electron` and `git diff --check` exited **0** after the final edits. These filtered runs are not the full release gate. No live provider calls, live-data changes, pushes, merges, deployments, or DAG changes were made. The existing unreleased v1.4.102 changeset is retained.
