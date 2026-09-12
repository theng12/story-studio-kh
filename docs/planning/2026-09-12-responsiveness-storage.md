# Responsiveness and storage batch

Owner authorization: execute the two September12 performance handoffs; fix archive Browse/scan usability. Source asset deletion and compression are advice/proposal scope until their retention behavior is decided. No live deletion, moves, paid calls, publishing or restarts for verification.

Base43389b9d, isolated worktree `.worktrees/app-responsiveness-storage`, branch `codex/app-responsiveness-storage`. Preserve canonical untracked critique and handoffs. Applicable AGENTS snapshot: model authority, honest unknown-vs-empty, verified completion, exact project ownership, single test process, local full verification, version/changelog and merged-main DMG. No Pinokio launcher changes; launcher-only workflow is inapplicable.

## Ownership

- shared_perf (Sol high): measured settings/shared backend bottlenecks; settings/service files and focused tests.
- store_pipeline (Terra high): purchase/install feedback and progress, Pipeline preflight/request-scoped scans; respective files/tests.
- storage_audit (Terra high): picker/archive errors, progress, reviewed selection and safe timeout handling; Settings archive UI/services/tests.
- root: project loading correctness/navigation, integration, UI verification, storage/compression proposal, review/release.

All agents start at43389b9d; deliver file changes with focused regression evidence and no commits/version changes. Root grants one test slot at a time. Root owns independent review of combined changes and official full verification.

## Evidence

September12 live request log: `/library/archive/preview` two requests around600400ms; `/system/pick-folder` max600035ms; `/projects/capi/pipeline/preflight`583626ms. These are real latency evidence, not proof that each cause is identical. No customer data touched.

## Scope and acceptance

1. Measure and fix proven shared request overhead. Preserve independently owned returned objects, write invalidation, concurrency and exact model freshness.
2. Unknown/loading project metadata cannot say a formula is absent; project switches must ignore obsolete responses and remain responsive.
3. Content Store shows truthful background queue/phase/outcome; duplicate clicks cannot buy or install twice.
4. Pipeline opens checking feedback promptly; run remains gated on authoritative validation, mixed eligible batches continue, stale checks cannot submit.
5. Archive lists only uploaded-proof-eligible reviewed videos, reports unreadable/failed scans honestly, gives picker/progress feedback, and preserves move verification. Source images/audio remain untouched.
6. Measure after results; focused tests, full local checks, rendered desktop/narrow inspection, independent review, version/changelog, PR/merge and verified local smoke DMG. No hosted CI.

## Storage proposal to explain

Final-video cleanup already supports durable upload history. Source pruning needs a separate explicit archived/local-sources-removed state rather than marking missing files present. Recommend external archive with verified copy first; same-volume moves free no space. Image compression must be opt-in with a sample comparison and compatibility check; no silent rewriting of reference bytes.

## Implementation and review record

Version 1.4.153 covers this application batch. The running app was verified as 1.4.152; earlier screenshots showing 1.4.151 do not represent the current runtime.

- Historical Jobs subtitle warning lookup was reading full chapter audio. Six concurrent reads took 43–65 seconds; an overlapping episode-list request took 119 seconds. A five-second main-thread sample attributed about 28% of samples to SHA hashing. Jobs now uses the existing timeline/SRT evidence without source-audio hashing, and queues these reads sequentially. Authoritative full validation remains in the execution paths.
- A 571,157-byte settings file measured 3.424 ms median read-plus-parse (p95 5.158 ms). A synthetic same-size settings fixture with the new cache measured 0.050 ms median warm getter access (p95 0.132 ms). These are local component measurements, not a live end-to-end speedup ratio.
- Header polling now requests one account overview instead of overview, jobs and credit activity. Jobs admission display honors the existing 15-second freshness period and shares slow requests. Dispatch validation still uses its authoritative path.
- Store installs reuse the signed delivery transaction, exposing process-local progress. Leaving a page does not stop installation; app exit/restart does. Active operations are deduplicated per release, terminal records expire after 15 minutes, and transient monitor errors do not authorize duplicate installs. Known refusal reasons and redacted unexpected-error logs share the synchronous route mapper.
- Pipeline confirmation paints before preflight, keeps submission disabled while checking, discards cancelled/foreign-project results, and shares project facts within a batch request.
- Archive scan uses the existing status endpoint rather than a request held open for ten minutes. It reports progress, supports stopping between files, refuses unreadable proof/source data, restores monitoring when returning to Settings, and binds a move to the reviewed source root. Only the approved list is re-hashed before movement; source/destination hashes and in-lock upload evidence checks remain.
- Project shell renders identity independently of settings and rejects obsolete same-project and cross-project responses. A loading catalog cannot display a false missing formula.

Independent reviews: storage_audit reviewed root/shared changes and caught the same-slug settings refresh race; root corrected it. shared_perf reviewed Store operations and caught missing error specificity/logging; store_pipeline reused the existing error mapper. Root caught archive unknown-as-empty proof reads, slow overlapping status polling and changed source-root handling; storage_audit corrected them. Root caught Pipeline cross-project preflight and submission results; store_pipeline scoped both. Final independent review found no remaining blocker. Root added archive monitoring guards for concurrent re-entry and unmount, plus a reviewed-file list (channel, episode, filename, size and recorded YouTube link); storage_audit independently reviewed that list without findings.

Rendered inspection: actual Vue template fragments and production styles were viewed through CUA at desktop and 375px. Archive checking/move controls, expanded uploaded-file review rows, install download/verification/failure text and Pipeline checking/Cancel states were readable and reachable. Fixture-only styling of product controls was removed before the final inspection. This verifies component geometry, not native folder dialogs or full live job execution.

Impeccable static scan: exit 2, 24 existing side-accent styling findings; all 24 snippets exist in base43389b9d and none were introduced. Existing visual identity was preserved. This is not a clean whole-app design audit.

Full local verification and merged-main packaging results will be recorded below when complete. Live after-install latency and native dialog checks remain a post-install validation condition; no customer files were moved/deleted and no paid requests were submitted for this batch.

## Storage guidance and next product decision

The current archive feature moves only final videos with acceptable channel-specific upload evidence, and verifies the copied bytes before removing the source. Use an external disk to free internal capacity; another folder on the same disk does not free capacity. The project cleanup feature has stronger fresh YouTube verification before deletion. Neither is a source-media purge.

Removing final video files can preserve upload history. Removing source images/audio currently makes those production stages unavailable. Do not use a manual Done override to pretend those files still exist. A future explicit source-cleanup feature should retain script, prompts, metadata, upload receipts and a small removal manifest, show “Uploaded · local sources removed”, exclude shared assets and active jobs, preview the exact byte/file inventory, and require explicit confirmation before removal. Re-rendering would require restoring the sources or deliberately regenerating them.

An external verified archive is the first recommendation. Optional image compression should be evaluated on representative copies, compare visible quality and renderer compatibility, and be offered for future assets or an explicitly selected conversion. Lossless WebP can reduce PNG storage, but real savings depend on content. Never rewrite original image bytes behind manifests or receipts; retaining both copies also consumes more space until the original’s disposition is chosen. No compression or source purge is included in this application batch.

## Verification run history

The first full verification attempt stopped at a type error in the asynchronous Store error projection; the projection was corrected to the existing structured error shape. The next attempt passed lint/type checking and progressed through the backend suite, then was stopped (exit 143) after the subtitle recovery test waited on an uncached-settings-read assumption. The production cache avoids that read. The test now observes physical confirmation, the settings-written event and ordered entry through the policy lock, with a 30-second timeout. Its full focused file passed 65/65 (exit 0); a deliberately ungated setter failed the mutation check (expected exit 1). No payment safeguard was removed. Interrupted runs are not release passes.

The subsequent complete backend run finished all 466 files: 5,161/5,164 tests passed, three failed (exit 1). Two new asynchronous Store route tests exposed teardown while a background install was still running and a failure projection that could leave the monitor nonterminal; the tests now await completion and the monitor always records a safe terminal failure even if presentation throws. The third failure was the no-new-fixed-sleeps guard; archive polling now uses the shared condition waiter and frontend install monitoring advances a fake clock. No timing baseline was weakened. The final verification runs all official lanes; frontend/release/content-pack/build gates precede the next complete backend run so any remaining failures surface sooner.

The full frontend lane then exposed seven outdated extracted-harness/source-shape assertions after Pipeline request scoping changed. Its harness now supplies the new counters and checking state, the assertion checks the captured repair mode, and an additional late-response regression protects another project’s receipt, selection and active controls. Focused Pipeline tests passed 23/23; independent review found no issue. The subsequent complete frontend lane passed 1,743/1,743 across189 files, and release tests passed36/36 across4 files. The Content Pack lane then completed 38/38 files: 366 passed, 2 skipped, 0 failed (368 tests total, exit 0). The production build and its changelog, typography, security, model-drift and release checks passed (exit 0). The final full backend run completed 466/466 files: 5,165/5,165 passed, 667 suites, 0 failures/skips/cancellations (exit 0; 1,476,514 ms). The harness confirmed the configured projects root remained byte-identical. All commands in the final frontend → release → Content Pack → build → backend chain exited 0. Lint and Electron/Nuxt type checks had already passed on the final production source before the final Pipeline test-harness updates (lint: 0 errors, 1,872 pre-existing warnings).

## Release disposition

All required local verification lanes and independent reviews are complete. Repository integration is authorized under the standing rule; GitHub Actions remains disabled. The final installer will be built only from integrated main using `npm run dist:smoke`. Post-merge commit, artifact filename/hash, and packaging/launch verification are recorded in the local evidence file `logs/responsiveness-storage/release-result.md`; the complete verification log is `logs/responsiveness-storage/verify-final.log`. These ignored evidence files are retained in the canonical checkout when the isolated worktree is removed. Native folder selection and live after-install latency remain the only deployment-dependent validation, not a claim made by the component fixtures.
