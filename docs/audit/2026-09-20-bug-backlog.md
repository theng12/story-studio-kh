# Bug candidates and repair plan — 2026-09-20

## Current checkpoint — 2026-09-21

Source **v1.4.213** has passed the corrected full backend/frontend/release/Content
Pack lanes and production build, with independent scoped review. Integration and
the main-built DMG are next. See [local release acceptance](../handoffs/2026-09-21-local-release.md)
for the current integration/artifact state, exact counts and explicit skips.

- A5 has accepted bounded audio-readiness/retranscription evidence; the broader
  historical contract and release integration remain open.
- A6 has accepted bounded manifest-uncertainty evidence; all-stage and release
  acceptance remain open.
- A8 deliberately preserves valid zero/no-op completion. Only narrow caller
  fixes are in scope; there is no blanket `expected > 0` change.
- The 89-row inventory is not 89 fixed bugs: many rows remain open,
  source-only, partial, dormant, duplicate, or retracted. No usable/released
  claim is made here.

The original tables and their older evidence are preserved below as dated
historical audit material.

Start from `codex/recover-interrupted-audit`, runtime checkpoint `fca27c95`.
This is a handoff inventory, not permission to implement every historical claim
blindly. The [new-computer handoff](../handoffs/2026-09-20-new-computer.md)
defines setup, migration, integration, and the next agent's working rules.

## Recovery-worktree update — 2026-09-21

The tables below preserve the original handoff evidence, not the latest patch
status. See [workflow progress](2026-09-20-workflow-progress.md) for current
verification and remaining limits. A1 containment, A2 no-ceiling requests and
retry/disclosure, A3 local Content Pack recovery, and A7 version reporting now
have uncommitted repairs with independently passing focused checks. A4 has
compatible dependency updates and four independently clean dependency audits.
None is yet an integrated release. A5, A6, A8 and substantive historical-candidate
reproduction remain open; 89 inventory rows must not be described as 89 bugs.

## How to read this backlog

**[MEASURED]** means the orchestrator inspected current source or observed a
command result. Source confirmation is identified separately from an executed
reproduction. **[REPORTED]** preserves an older allegation; it still needs
current caller tracing and a failing consequence-based check. **[ASSUMED]**
marks a missing fact used provisionally. Priorities and proposed fixes below
are engineering judgment, not measured outcomes.

Coverage: the original defect audit, its evolving FIX-PLAN, the takeover report,
the [earlier Settings critique](2026-09-06-settings-critique-recovered.md), migration documentation, four dependency audit
outputs, and targeted current-source checks. The complete original candidate
quotations are retained in [the companion appendix](2026-09-20-candidate-appendix.md).
[MEASURED] All 89 extracted source slices match the source bytes, and every
original OPEN-section bullet through Content packs is covered. This cannot establish that
there are no other bugs. Paid provider calls, real uploads, all project data,
every UI geometry, and every inherited commit were not exhaustively retested.

## A. Current evidence and proposed fixes

| ID / priority | Current evidence | Smallest proposed repair | Proof required before closing |
|---|---|---|---|
| A1 / high | **[MEASURED — source]** `electron/server/routes/video.ts:1765-1785` accepts `?path=`, calls `resolveAssetPath`, then `fs.stat` without a containment guard. `services/path-resolver.ts:65-68` returns plain paths unchanged. Neighboring previews use `isPreviewablePath` at `routes/video.ts:490,563,622`. This endpoint exposes existence/size/mtime; no private file was probed in this handoff. | Reuse the existing approved preview-root boundary before stat. Check symlinks and portable paths through the shared implementation; preserve legitimate project/shared/configured media paths. | A temporary sentinel outside allowed roots must yield refusal and no fingerprint. Inside-root and permitted-media files still work; removed files still invalidate caption checks. Test server-mode route admission too. |
| A2 / high | **[MEASURED — executed pure resolver + source]** `scene-prompt-batching.ts:168-177` rejects `null`, `undefined`, and `0`; direct calls reproduced all three refusals while `8192` returned `8192`. `generators/scene-plan.ts:715-718` uses this resolver. `scene-plan.vue:571-575` hides Next without a published budget but leaves All pending available. Owner decision 6 already allows models with no published ceiling. | Represent absence distinctly from malformed values; omit the request limit when unpublished. Resolve batching from an explicit configured choice without pretending it is the model's maximum. Update UI, Pipeline request snapshots, retries and motion handling consistently. | No-ceiling model succeeds through direct and Pipeline paths with no invented token field; malformed published values still fail; explicit batch choice and model changes work; saved paid-work recovery is preserved; rendered UI explains the choice. |
| A3 / high | **[MEASURED — source]** `content-packs/state.ts:75-104` preserves invalid bytes under a hash-named quarantine file, writes empty state, and returns that state without a recovery discriminator. `readContentPackState:108-113` exposes the same return shape as first install; registry/routes consume it. I/O errors correctly throw. | Preserve quarantine/locking/atomic writes. Carry recovery status to an actionable Store notice and a supported reconciliation/restore path. Do not report invalid/recovered state as an ordinary empty library. | Invalid vs missing vs I/O failure remain distinct; original bytes survive; notice/recovery is visible; installed identity/ownership/signature checks remain fail-closed; restart does not hide the incident. |
| A4 / high | **[MEASURED — dependency audit]** Root production audit exits 1: `@xmldom/xmldom` high, `sharp` high, `qs` moderate. Frontend production audit exits 1: `svgo` high, `devalue` moderate. These are vulnerable package results, not established exploitability in this app. | Trace each direct/transitive consumer and runtime/build exposure. Prefer safe patch/minor lockfile updates; do not run a blind force upgrade or weaken audit rules. | Root/frontend production and all-dependency audits, package/runtime closure, relevant media/import/render regressions, full required local suites/build and packaging checks. Record anything still unfixed explicitly. |
| A5 / medium-high | **[MEASURED — accepted ledger]** The focused audio-readiness/retranscription checks reject unrelated or stale assembly before provider work, including the corrected affected mixed run. The original broad predicate and its wider override/caller contract remain historical concerns, not a claim that all A5 evidence is untouched. | Retain the authoritative merged artifact/freshness rule and finish the remaining caller/override and integration review. | Noncanonical, stale, empty, malformed and unreadable audio cannot satisfy readiness; current valid merged audio can; no duplicate paid transcription on repair. |
| A6 / medium-high | **[MEASURED — accepted ledger]** Bounded manifest-uncertainty checks preserve an explicit unmeasurable outcome for exercised directory, manifest and stat faults, with frontend uncertainty evidence. Full all-stage and integrated release acceptance remain open. | Complete the remaining caller/UI review while preserving successful stage results and surfacing the affected stage. | Inject directory/read failures and prove the API/UI cannot report intact/empty; a genuinely unstarted episode remains legitimate. |
| A7 / low | **[MEASURED — source + launch output]** `/api/health` and `/api/server-info` use literal `version:'0.1.0'` at `app.ts:124,140`; the v1.4.210 launch smoke returned that value. | Use the existing application version source consistently, including packaged runtime. | Both routes agree with the packaged `app.asar/package.json`; startup/version diagnostics remain available. |
| A8 / contract review | **[MEASURED — source only]** `job-completion.ts:68` permits `expected >= 0`; a zero/zero declaration can be complete. This is not automatically a bug: an optional/no-op operation can validly expect zero. | Enumerate all callers and distinguish legitimate no-op completion from unmeasurable or missing required output. Do not change every zero to failure globally. | For each artifact-producing caller, empty/unmeasurable output fails while a deliberately skipped optional operation remains allowed. |

## B. Remaining candidates to reproduce

All entries in this section are **[REPORTED]** from the original audit or
FIX-PLAN. Old line numbers are locator hints, not verified current locations.
The appendix keeps exact source text; use symbols and callers to relocate it.
Do not inherit the older auditor's severity without checking reachability.

| Area | Candidate failures to check | Repair direction / acceptance evidence |
|---|---|---|
| Completion and paid output | Contextual Cues `expected:1/completed:1` without artifact read-back; self-referential metadata completion; stitched-SRT integrity checks gated on `max_cue_gap_sec`; malformed/partial whole-track subtitle coverage; word/animated caption fallback not declared degraded. | Audit authoritative artifacts and usable content, not an executor's assertion. Pin complete, partial, empty, stale, malformed, provider-failure and retry behavior. Preserve owner decision that required stitched subtitles cannot be replaced by a whole-track shortcut. |
| Audio and writing | Existing MP3 skipped after narration edit; `outline_only` rejecting legitimately extra outline chapters and retrying cached failure. | Trace source identity and existing owner contract. Preserve valid paid output, regenerate only proven stale/missing items, and avoid permanent retry loops. |
| Scene Plan | Pipeline default timeline stage replacing a partly completed plan and losing paid prompts. | Reproduce with stable scene IDs, existing approved prompts and partial completion. Separate intentional rebuild from continuation; preserve reusable valid output and make destructive editorial replacement explicit. |
| Publishing metadata | New metadata version written/audited but fixed old version read for upload. | One authoritative latest-valid metadata resolution shared by generation, board and upload; prove v1/v2 and malformed-latest cases. |
| Queue recovery | Five-second cancellation reconciliation loop when key unavailable; restart-interrupted paid jobs described as ordinary failure; pipeline skip after inline Character Sheet write. | Reproduce provider evidence and lifecycle first. Keep unsettled work recoverable; truthful status/action messaging; bounded scheduling where justified; skip must not silently mutate unrelated state. |
| Queue transport/performance | Full-job clone on persistence/SSE with unbounded output; polling fallback never reconnects SSE; missing snapshot-error event. | Measure realistic large histories before optimizing. Test disconnect/reconnect and stale response suppression; bound retained output without losing required audit/provider evidence. |
| Jobs UI | Paused dispatch called needs attention; invalid legacy retry and bulk retry admission; dead `scene_images` tabs; filtered-empty state says no jobs; `_app_` Finish missing images URL; subtitle Retry tooltip points to absent Repair. | Align controls with actual route/admission rules, use truthful empty/status text, preserve per-project/all-project scope, and verify rendered interactions. |
| False empty/error states | Scene Review, Research, Pipeline, Audio, Subtitles, AudioChapterSelector, Video Assembly, Scene Plan and Jobs allegedly collapse load failure/unknown into missing or ready. Some suppress a pre-spend Introduction warning. | Represent loading, empty, error and unknown separately; preserve last valid data when appropriate and provide retry. Inject failure at each named read, not just happy-path snapshots. |
| Model options and limits | Motion Review forces 16:9; image catalog parser invents a ratio; Images fallback ratio list; per-row cap from retired config; hidden 100 MiB transcription cap; fixed single-chapter repair token allowance. | Follow the selected model's live published fields, show enforced limits, and omit/disable honest absences. Do not infer capability or route from provider/name. Retired View all caps modal is already removed. |
| Settings and controls | Scene Plan wrong busy-label prop; Video Assembly output option `needsChoice` ignored/error toast for notice; FFmpeg status not loaded; competing category watchers; Use app default omits a key instead of clearing AI disclosure; hidden Script warnings; Sync Folders instruction without control. | Reproduce actual save/request/response and navigation. Explicit clearing must survive JSON transport; restore correct busy/choice/error affordances without adding a configuration framework. |
| Remaining UI details | Scene Review preview badge has no consumer; Research missing `claims` crash; job-type label maps drift; purchase dialog clipped footer; sticky save bar in overflow-hidden ancestor. | Trace handler/prop/data shape and use shared labels. Verify keyboard/focus, short viewport and visible purchase/cancel actions in rendered UI. |
| Geometry | Long subtitle filename/cue preview; Settings folder-template grid; Scene Plan, Video Assembly, Audio, Scene Review, Research and Pipeline grids clipped by dashboard overflow. | Measure current rendered desktop/narrow layouts. Fix the responsible grid/flex/scroll container; source assertions cannot prove visibility. |
| YouTube archive/admission | Old-channel manual tombstone blocks re-upload; MOVE proof accepts mtime alone; archive breadcrumb ignores channel. | Exercise channel changes, deliberate forget, file-byte changes with preserved timestamps, and exact operation ownership. Preserve deletion-grade proof and duplicate-upload warning policy. |
| YouTube scheduling | Remote schedule PATCH succeeds before local receipt fails; fixed 24-hour stepping stalls in sub-hour DST; legacy plan-apply can privatize public video. | Inject post-provider local failure and prove recoverable, idempotent receipts; test Lord Howe DST boundaries; preserve privacy status unless explicitly changed. Establish legacy route reachability before retiring it. |
| Storage safety | Same-size destination accepted as complete copy, then source removed. | Same-size/different-byte sentinel test; verify content identity before deleting source, retain partial outputs and actionable recovery. |
| Content Pack lifecycle | Crash orphan blocks reinstall; damaged installed copy cannot repair; boot activates retained inactive packs; prune removes rollback target/no-active versions; exact hash reports wrong active version. | Crash/failure-injection tests with exact signed identity/ownership. Confirm prune runtime reachability first. Preserve rollback and purchased content; do not bypass signatures or commerce anchors. |
| Diagnostics/dead paths | Unused debug route returns absolute paths; dead migrations file; dev/CORS classification; stale EpisodeStatus field documentation. | Check imports, route registration, framework discovery and actual consumers before deletion. Do not remove customer/protective state just because a field is old. |
| Settings design | Earlier Impeccable critique recommends clearer This Mac/This Project scope, focused navigation, removal of retired hidden editors and stale GenStudio capacity wording. | Recheck current layout: critique was against much older versions. Reuse existing controls; inspect desktop/narrow/keyboard behavior. Scene rhythm remains per-episode. |

## C. Completed, superseded, or deliberately preserved

**[MEASURED]** These commits are in the recovery branch. Their subjects and
recorded fixes establish why old open rows must not be applied automatically;
the 70 inherited commits still require integration review as a whole.

| Historical allegation | Disposition / evidence |
|---|---|
| Arbitrary preview-file reads and vision source-path uploads | Shared `isPreviewablePath` boundary exists in video preview routes, audio-merge and vision before reads; commit `68ef99ae`. **The separate fingerprint endpoint remains A1.** Do not ask again for the already selected preview roots. |
| Ordinary-success queue audit ignored | `ebaf4e97` is the scoped correction after an earlier overbroad fix/revert. Inspect final caller behavior, not the reverted patch. |
| Truncated B-Roll reported complete | `90f2ee57`; `auditBrollAssemblyOutput` is registered for `broll_assemble` in `boot/executors.ts:230-232`. |
| Subtitle freshness and stitch-retry gap | `65033c2e` and `71455fe4`; current subtitle source hashing is present. Retest distinct remaining subtitle candidates separately. |
| Thumbnail upload completion bookkeeping | `69a2bf3c`. |
| Prefix episode-folder matching | `e5d44208`; do not restore a broad startsWith matcher. |
| ffprobe N/A masks real format duration | `e5ad89aa`; current `probeDurationSeconds` parses stream then format independently. |
| Music duration unknown silently totals zero | `94790ee4`; current result carries `unmeasured_enabled_tracks` alongside the measured floor. |
| Unreadable folder shown as 0 B; versioned final video missed; unmeasurable opening clip | `e2d1aabc`, `56839410`, `13d0eb34`. |
| Missing API key presented as empty catalog | `84051ee7`; current health model route returns 400 with setup guidance. |
| Episode state and preset leakage | `e5ba4176`, `2e4f9a4f`, `f5210027`, `1969446e`, `31970717`, `e4cab6cb` record successive fixes. Verify any alleged survivor against those changes; do not reimplement the original twelve-site list wholesale. |
| View all caps modal | Removed by `eb1116d3`. |
| Cross-project duplicate upload | Owner selected warning with click-through, implemented by `8ece74bd`. Do not turn it into an unrequested global hard block. |
| Missing published output ceiling | General submission path fixed by `08aa6ee0`; **Scene Plan remains A2**. Old live model counts/names are historical, not a current inventory. |
| Cancellation Set cleanup | Repaired and reviewed at `fca27c95`; preserve active-worker lifetime and deterministic-ID/in-place-retry guards. |
| Orphan ttl-cache | Removed by `51efc9b1`. Retired endpoint data stays on disk unread; do not mass-migrate it. |

**[MEASURED — recorded owner decisions]** Character Sheet pacing remains in
presets; project-wide rhythm defaults remain forbidden. Whole-track subtitles
do not substitute for the required stitched timeline. Unknown thumbnail width
behavior was explicitly closed as deliberate; do not reverse it as a generic
zero-value cleanup. A separate reusable Scene Plan guidance box is requested,
but its persistence location needs clarification. See FIX-PLAN's owner decisions.

**[REPORTED — explicitly retracted historical audit claims]** Log redaction
bypass, polling epoch race, refusal of every archive root outside the Library,
and clearing `preflightSummary` were disproven in the original audit. Preserve
them as negative evidence. An arbitrary external archive chosen by the owner
is valid; an absurdly broad filesystem root is not.

## D. Dependency repair detail

**[MEASURED]** Snapshot date: 2026-09-20. Audit JSON is retained in the
[handoff evidence directory](../handoffs/evidence/2026-09-20/).
All four npm audit commands exited 1. Do not confuse the
frontend manifest's production dependency category with proof a transitive
package is reachable in the shipped static frontend.

| Scope | Package | Severity / relation | Advisory-reported affected range |
|---|---|---|---|
| Root production | `@xmldom/xmldom` | high, transitive | `<=0.8.14` |
| Root production | `sharp` | high, direct | `<0.35.4` |
| Root production | `qs` | moderate, transitive | `2.2.5 - 6.15.3` |
| Frontend production | `svgo` | high, transitive | `4.0.0 - 4.0.2` |
| Frontend production | `devalue` | moderate, transitive | `<5.9.1` |
| Additional root dev/build | `fast-uri` | high, transitive | `3.0.0 - 3.1.5` |
| Additional root dev/build | `js-yaml` | high, transitive | `4.0.0 - 4.3.1` |
| Additional root dev/build | `joi` | low, transitive | `18.0.0 - 18.2.4` |

The snapshot reports fixes available. Confirm current upstream versions and
lockfile compatibility when implementing; an advisory range is not itself a
tested upgrade recommendation. Keep runtime and build-only remediation evidence
separate, and check all duplicate installed versions.

## E. Close an item only with evidence

For each bounded repair, record current source/callers, the failure reproduction,
the chosen contract, a check that fails before and passes after, independent
review, affected local suites and required full gate, visual verification where
applicable, version/changelog changes, and the exact integrated commit/artifact.
Keep valid paid partial output, provider evidence, balances/purchases, and
customer files intact. Never resolve a failed proof by weakening the completion
contract or suppressing the warning.
