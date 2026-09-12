# Jobs scope and bulk abandon

Owner report: abandoning/clearing feels slow; no selection or automatic selection for bulk abandon/clear; All Jobs is empty while project Jobs lists work. Fix within existing recovery/billing safeguards. No live jobs abandoned or cleared during development.

Base5837707d; worktree.jobs-abandon-scope; branch codex/jobs-abandon-scope. RootAGENTS snapshot: preserve unrelatedwork; logsfirst; exactprojectscope and honestloading; modelauthority and verifiedcompletion; onetestprocess; independentreview; full localgates/version/changelog; authorizedPRmerge and merged-main unsignedDMG; Actionsdisabled. No Pinokio launcher work.

Evidence: September12live serverlog recent abandon requests88–184ms; GET/jobs/all131–209ms; DELETE/jobs/all8–85ms. Screenshot1.4.152; source1.4.153 includes sharedperformancefixes. Need distinguish requestreceipt vs frontendtransports and persistentlisting.

Owners: jobs_scope Terrahigh backend listing/scopes/stream tests; jobs_transport Terrahigh frontendcomposables/transport tests; rootJobs selection/actions/UI, integration/release. Allstart5837707d. Deliverfailingregression/rootcause/minimalfix; rootcoordinates onefocusedtestslot thenfullsuite.

Plan: diagnose all-project visibility and slowfeedback; add explicitly scoped selection/autoselect eligible jobs and bulk abandon plusclear via existingcontrols, keep outcomes truthful/partialfailures visible; verify mixedprojects/states/latecallbacks/repeatedclicks; renderedinspection; reviews;1.4.154release.

Paused at owner request for restart. Current implementation, focused checks, three open review findings and resume instructions: docs/handoffs/STORY-JOBS-RESTART-2026-09-13.md. No release claim.


## Resumed approved batch — 2026-09-13

Owner resumed after restart and approved Free up space proposal. Extend this plan; no competing planning system. AGENTS snapshot: exact model authority, verified completion, no unsafe customer mutations, local-only compute, independent review, full official gates, version/changelog and merged-main DMG. Existing 1.4.153 is finished; do not repeat prior work. No launcher changes. Ponytail full: reuse retention proofs, file locks, atomic writes and existing background-operation patterns; no dependencies. Graphify corpus not present in this worktree; targeted source/symbol reads used instead.

### Scope and owners
- Jobs (jobs_finish, Terra high, base5837707d shared worktree): finish three recorded review defects, preserve existing selection/scope fixes; exact focused frontend + jobs-stream regressions.
- Image retry (image_retry, Terra high, same base): allow one confirmed fully refunded generic IMAGE_FAILED retry under enabled existing policy if identity/settlement/artifact and durable retry cap prove safe. Preserve charged generic failure, refusal, cancelled, uncertain guards. Focused policy/integration tests, no paid calls.
- Free up space backend (storage_backend, Sol high, same base): new episode-media-cleanup service/routes/tests. Fast uploaded-episode list, async preview and run, exact selected files/categories, verified uploaded evidence, active/shared exclusion, archive or explicit remove, per-file intent/outcome sidecar and Stop. Fixture-only mutations.
- Root: Settings cleanup component and Upload Center shortcut, separate local-media state in episode list/Pipeline/Board/selector, ordinary Pipeline avoids regenerating deliberate cleanup, explicit regeneration remains available with prerequisites; rendered checks, integration and release.

### Storage accepted design / boundaries
Publishing and local availability remain separate. Keep upload IDs/receipts, scripts, prompts, subtitles, settings, billing history. No fabricated source completion booleans. Categories: images, chapter_audio, merged_audio, motion_clips, final_video. Review exact files and bytes before destructive action; archive verifies copy before source removal. Reject active jobs, shared/pool assets, symlinks/hardlinks, changed files, unverified uploads, archive collisions. Pending per-file intent precedes removal; restart reports actual outcomes. Background work continues on navigation; restart interrupts safely, no false promise of resume. No automatic deletion. Source compression is optional separate future experiment on copies, not this batch's implementation.

### Root implementation tasks
- [x] Settings component: uploaded-only list; explicit episode/category selections; preview progress/stop/error; exact file review; archive destination and removal confirmation; persistent operation ID per project and truthful background result. Use existing useApi and native folder picker. Add Upload Center link to Settings#free-up-space.
- [x] Local-media status: surface read-only cleanup metadata alongside real asset readiness; display neutral archive/removal labels in Pipeline/Board/selector without inferring the current publishing channel; ordinary Pipeline preflight excludes deliberate retired media with clear reason, force re-run explicit path continues to normal prerequisite checks. Recheck at dispatch.
- [x] Meaningful root frontend regression checks for scope switches/stale replies/repeated click/confirm/cancel/background restore; backend integration for pipeline cleaned vs untouched without fabricating assets.
- [x] Independent review covering deletion safety, pipeline rebuild behavior, transient retry cap and Jobs races; resolve every material finding.
- [ ] Full local verify (one test process), rendered desktop/narrow checks, version1.4.154 and changelog, Actions-disabled check, commit/push/PR/merge under standing authorization, merged-main official unsigned DMG and smoke verification.


## Final review checkpoint

All recorded transport findings are resolved. Storage review additionally fixed sidecar lookup after failed title sync, shared admission/removal races (including synchronous Retry), request-cache reuse, current-path restoration after rename, archive scope naming and repeated logical-file history counting. UI review fixed stopped-scan wording, dismissed-review restoration and truthful partial/pending labels. All full local lanes passed (7,371 tests), as did the production build. Integration and merged-main installer remain; final release details belong in the handoff and retained release logs.
