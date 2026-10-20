# HANDOFF — Story Studio KH

## 1.4.344 — 2026-10-20 (gate running)

Merged fix/stale-verdict-freeze (032629f8: freshStoredExpectation returns a stored verdict's expected only when not stale; the boot freeze sweep and the on-demand youtube final-check route both go through it, so a rewritten final is never certified with the replaced file's shape; production report release343-freeze-stale-verdict-verification-20261020.md).

## 1.4.343 — 2026-10-20 (gated and landed)

Merged fix/final-length-gap three times: a9701e99 (first version), 3517fa36 (owner decision), then 11bf6e45 (production's hole in 3517fa36), merged here as 625046a0 → 7df584ac → e46f6caa. Owner decision (2026-10-20, verbatim: *"yes. it's my own settings. in fact, i want all already made videos to retain this. but for newer ones from now on to no longer use the silence thing but instead follows the rest of the sleep channels... so what's done is done."*): existing Sprout finals keep their long silent still tail and their branded intro; future episodes drop the 6000 s `after_scenes` clip. A final that matches what its own settings asked for PASSES.

**PRODUCTION ORDER: the freeze must run before the preset change.** 3517fa36 read the shape for a plan-less final from the CURRENT active preset, so dropping `clip-1776875775168-cl5s` would have measured SS0063's 9354 s final against a ~15 s tail and STOPPED it. 11bf6e45 binds the shape to the file: `<final>.finalcheck.expectation.json` beside the final, holding `after_narration_sec`, the intro's asset, its window and the black that asset carries (measured once, at freeze time). Taken ONCE, and only when `config.json` can be shown not to have been written since the final was (`settingsUnchangedSince`); read back ever after (render's own recorded plan → frozen record → settings-while-provably-unchanged, which also writes the freeze → else `expectation_unknown`). `freezeExistingPlanlessFinals()` sweeps every plan-less final at boot, idempotent (a freeze for the same bytes is never rewritten; one that no longer describes the bytes is replaced). Boot logs each record's path; `GET /projects/:slug/youtube/final-check` carries `frozen_expectation`. A final with no freeze whose settings moved reports "cannot be checked against what it was made for" — length and intro are not judged, everything else still is, and it does not pass. Also fixed (review's secondary point): the intro window now covers the Scene Plan's reserved opening, not just the asset's own length, since the renderer trims/pads the clip to it. Tests: 24 new across the three amendments (9 in 11bf6e45), all red first; `--only final --only video --only render --only youtube-upload-center --only opening` = 613 passed / 0 failed, 52/52 files; `npm run typecheck` exit 0; eslint --quiet exit 0. Not run by request: the chain, the DMG, main, push.

## 1.4.342 — 2026-10-20 (gated and landed)

Merged fix/nested-stage-deps (abfff8f8: workFolderDependencies derives final-stage inputs from argv incl. nested paths; moveCheckpointFinalStage verifies shas + every argv dependency before moving the whole set, else null → fresh final render; video.ts audio exclusion by work-folder name. Myth EP0012 job 637ffc7d restart).

## 1.4.341 — 2026-10-20 (gated and landed)

Merged fix/images-panel-race (039469f4: ImageGeneratorPanel boardRevision guards loadPrompts/loadScan success, catch and finally; sync episode watcher replaces the whole board; runOne refuses rows whose boardEpisodeId differs from the live episode).

## 1.4.340 — 2026-10-20 (gated and landed)

Merged fix/recovery-plan-read-and-binding (5c50c438: GET /projects/:slug/episodes/:code/recovery-plan read-only; extendPlanFromSelectedFailures rebinds a dispatched scene_plan_run node from a childless failed row to the explicitly selected row of the same plan).

## 1.4.339 — 2026-10-20 (gated and landed)

Merged fix/campaign-fill-count (2b0e50bc appendNewIdeas new-rows-only count; 1780f241 exhausted Topic Pack guidance; fb76501a params.rejected_assignments excluded by planIdeaAssignments, content rejections only).

## 1.4.338 — 2026-10-20 (gated and landed)

Merged fix/remix-pin-window (e59c4d48: planClosingTailRemix returns recover while an intent note exists; guardClosingTail recovers before use) and fix/collect-first-fresh-rows (de06d612: enqueue carries same-plan sibling scene_plan_run children; collect pass reads every saved key before the single deferred resend).

## 1.4.337 — 2026-10-20 (gated and landed)

Merged fix/continuation-leftout-and-restart (0f1cda0f: unusableLinkSkipReason at chain dispatch and job start; restart reconcile requeues interrupted writing jobs with incomplete audits) and fix/closing-tail-older-merges (48582cdf: planClosingTailRemix in video.ts guardClosingTail + pipeline preflight; re-mix to _vN via Audio Assembly, pinned only after narration/lead-in checks). Rebuilt after the first gate failed on H-17 (test encoded the pre-requeue rule; f6ed92c6): also merged fix/collect-first-saved-chat-children (97fae588, plus restart-requeue regression 5d6ab4c3) and fix/small-leftovers (lstat reason, Pipeline left-out display, planned chapter gap, re-mix durability/retry/preservation/admission lock, input refusals non-retryable). Production: History EP12-14, Myth EP13/14, Domnak DM13 need one assembly each; Myth EP14 continuation one Retry.

## 1.4.336 — 2026-10-20 (gated and landed)

Merged fix/legacy-unknown-recheck-and-check-read (3a9dd772: shouldRecheckStoredUnknownOutcome also covers failed + UNKNOWN_OUTCOME/submission-uncertain rows with absent hold fields; GET /projects/:slug/youtube/final-check full stored result). Production: Boundful 5864f738, Brain Wise a257d9f4, Capi b21f6250, Domnak 14c50bed settle on boot readback, then one Retry each.

## 1.4.335 — 2026-10-20 (gated and landed)

Merged fix/pipeline-leftout-steps (dd14feaa: preflight returns live runSteps; run-batch filters preflight.stepsLeftOut at admission; Myth EP0012 fa69e918 should be discarded, not retried) and fix/orphan-scan-complete (cbb3e152: readDirectory records non-ENOENT failures, streamTrashIndex reads every record, handoff records size/mtime/macos_trash_path; earlier handoffs report location unknown).

## 1.4.334 — 2026-10-20 (gated and landed)

Merged fix/drain-waits-before-pausing (e725a7f3: maybeInstall looks for a maintenance operation before claiming the drain; status maintenance_running) and fix/cleanup-sample-keeps-failures (7572ffa0 failures-first sample + failed-rollback record without upload proof; 710a032f GET /library/media-cleanup/orphans + POST .../orphans/restore). Never roll the mini back below 1.4.334: older builds misread proof-less cleanup record entries.

## 1.4.333 — 2026-10-19 (gated and landed)

Merged fix/final-check-long-video (a51b7fb0: POST /youtube/final-check answers 202, startFinalCheck one per file, row final_check.running; 022be139: app-update drain waits for runningFinalChecks, status final_checks_running). Production: Myth EP0008 check was cut by the 1.4.331 install drain at 15:50:27Z, not a timeout.

## 1.4.332 — 2026-10-19 (gated and landed)

Production bug-hunt bundles 1,2,4-9 (voice race 3455b199; metadata rejected retry edf6fa63; superseded upload + truncated listing + shared selectors 836a25b2/4f7d8c3d/5f8290ee; closing tail bb9c78a9; subtitle full-track staleness 6e29a845; merged audio non-mp3 a32fa3d3/4357a3e4; malformed final-check sidecar 9b9c7405) and the Story half of the dynamic chat deadline (a6a4dffc/b42758fe: expected_output_tokens, socket = max(setting, allowance) capped 4 h). Bundle 3 is Gateway 0.2.190.

## 1.4.331 — 2026-10-19 (gated and landed)

Merged fix/output-limit-audit (docs tip 5f156c57), fix/hunt-verified-success (803b0833: audio-reconciler reads .task-manifest.json; cleanup run results capped with item_count), fix/hunt-recovery-truth (ca3ac802: planEndSec one authority, comparePlanStamp everywhere, hold-aware stragglers, catalogue last-good restore + image warm-up), fix/final-check-unknown-speech-end (80ab9a66: speech_end_sec, scene plan source_merged_audio). Bug-hunt phase 2 (Kinds A, C, D, F, H). Next: ack identity binding, cleanup skip-cleaned, dynamic chat deadline.

## 1.4.330 — 2026-10-19 (gated and landed)

Merged fix/chat-evidence-readback (a2ab79e5: held chat rows re-read read-only by recheck), fix/recovery-dispatched-edge (8330594c: dispatched node with no job resolves or re-enqueues once; drift accepts raw or corrected transcript), fix/continuity-keyless-prepared (9d183243: keyless prepared rows rebuild the reserved key and ask the Gateway first), fix/cleanup-realpath-native (1e5d3270: assertReviewedIdentitySync uses realpathSync.native; 1.4.329 production failed 488/488), and the first output-limit-audit commit 31e63fef. The 128,000-token fallback (rest of fix/output-limit-audit) is deferred to the next release by the owner.

## 1.4.329 — 2026-10-19 (gated and landed)

Merged feat/video-status-read (88b13608: POST /projects/:slug/youtube/video-status, ≤50 ids, assigned-channel match, read-only, 502 YOUTUBE_STATUS_UNCHECKED) and fix/idea-batch-proven-failure-fresh (b784ad3c: isProvenChatFailure in genstudio-client; releaseSettledFailedIdeaBatch keeps settled_failed evidence and derives request_identity …:fresh:<dead job id>; one fresh send per run). Also fix/cleanup-preview-slim (a4e81aff: operations carry a bounded preview summary, file_count + 50-file sample; full preview stays server-side by preview_id; one 19-channel preview GET was 276 MB). Production: Boundful 5864f738, Brain a257d9f4, Capi b21f6250, Domnak 14c50bed each need one Retry after install.

## 1.4.328 — 2026-10-19 (gated and landed)

Merged fix/eligibility-exact-channel (43823dad: channels.list counts only the requested channel id; mismatch is unknown, uncached) and fix-hmh-retry-500 (32cedef8: /projects/:slug/jobs/:id/retry wraps recoverEpisode and answers 409 with the refusal; recoverEpisode writes a new plan once, after extension, before queue insertion). Production bug: HMH a0d4f382 Retry 500 from episode-recovery.ts repairRecoveryNodeParams on a stale [CIRCULAR] plan marker.

## 1.4.327 — 2026-10-19 (gated and landed)

Merged feat/new-channel-default-pacing (db046a1f, 688a9c75), feat/music-closing-tail (3593e2f4: lib/closing-tail.ts single source; tail baked once in the audio merge; narration vs master length separated), feat/youtube-eligibility-watch (c2cabea1: channels.list longUploadsStatus, 409 confirmable; thumbnail 403 skip; 24 h processing watch), feat/final-video-check (771a45d4: lib/final-video-check.ts, .finalcheck.json sidecar, final_check safety check, Warn default). publish.vue: postUploadWithAcknowledgements resends with every confirmable answer. Owner decision pending: thumbnail skipped on channels YouTube forbids thumbnails (bends the 2026-10-07 thumbnail-required rule).

## 1.4.326 — 2026-10-19 (gated and landed)

Full gate green on c1c7fbb8: lint, four checks, typecheck, test:backend, test:frontend, test:release, test:content-packs (gate-326-c1c7fbb8.log).

Merged feat/retention-20gb-autocleanup-switch (79e7fcd8: trash_handoff_gb 20 oldest-first in the daily handoff; log cap; Free up space panel switch on auto_cleanup_enabled) and fix/publication-unknown-keeps-last-confirmed (ded6acd1 + 05d8d96e: processingDetails failure → lifecycle failed; superseded failed/rejected video ids let one replacement through; linkYouTubeEpisodeVideo accepts superseded ids; empty videos.list stays unverified with unverified_since). Domnak DM0001–3 were abandoned by YouTube as too long (channel unverified at the time).

## 1.4.325 — 2026-10-19 (gated and landed)

Gate: lint, four checks; test:backend 7537 / 7535 pass / 1 fail — the no-new-wallclock-sleeps guard flagged a hand-rolled 5 ms poll in genstudio-catalog-cache.test.ts, replaced with waitFor (d6f2234d, re-run 32/32); typecheck, test:frontend, test:release, test:content-packs green (see gate-325-lanes-d6f2234d.log).

Merged: fix/tts-chargeable-passthrough (6af1082e, `parseGenStudioChargeable` on all seven catalogue parsers), fix/gateway-connection-cap (c86fc538, undici Agent connections 8 as global dispatcher; undici now a declared dependency; bodies cancelled; onBoot clears stale install_requested), fix/rejected-answer-fresh-key (dc79f25b, inner-quote JSON repair; rejected_idempotency_keys → fresh key; auditor repair detail), feat/jobs-history-paging (777878c2, ?view=active snapshots + /jobs/all/history; /jobs/all unchanged for callers).

## Stranded scene images, and a sample that never hides a failure (source only, not released)

Branch `fix/cleanup-sample-keeps-failures` from `main` (1.4.333, 59b9d17a). **SOURCE ONLY**: no version
bump, no changelog entry, no DMG, no push.

Production 2026-10-20: a running all-channel `shrink_images` run reported `failed_count: 2` while the
operation's `result.items` was the FIRST 50 outcomes — all `compressed` — so the two files that failed
and their reasons were nowhere the owner could look. Three changes:

- **The capped sample keeps every failure first**, then anything pending or refused, then settled
  outcomes (`addToOutcomeSample`; `PREVIEW_SAMPLE_FILES` is still 50, and the counters beside the
  sample stay exact — the panel's "and N more" line is `item_count` minus what the sample carries).
  Applied to the per-channel run, the all-channel run and the Clear Uploaded Videos sweep. The panel
  now says failures out loud with their reasons (`.cleanup-unresolved`), not only inside "View file
  outcomes".
- **A swap that fails and cannot be rolled back is named.** The compressed image could not replace the
  original AND the original could not be put back, so the file exists only in `_trash`, which empties
  after seven days. The failed item carries `original_path` (the `_trash` path) and a plain reason,
  and the episode's own cleanup record keeps it — even when the run has no upload proof, so
  `upload_proof: null` is now a readable record entry. **Do not downgrade past this**: a build older
  than this change calls such a record unreadable ("Repair it before cleaning more files") for that
  episode. `beforeCompressedSwap` is a new SYNCHRONOUS test seam (never awaited — the swap must stay
  inside one event-loop turn).
- **The reasons of a run that already finished cannot be recovered** — not by this change, and not by
  anything else: no run before 1.4.334 wrote them down, and a check cannot invent what was never
  recorded. What CAN be found is a stranded original:
  - `GET /api/library/media-cleanup/orphans` — read-only, bounded (50 per class). Walks every Trash
    root's `<root>/<slug>/<code>/images/scene_images/**` and classifies every file: `orphan` (one
    empty working path, and the Trash can put it back), `resolved` (the working path holds the
    original or its JPEG, or the episode's record says the file was deliberately removed),
    `ambiguous` (the Trash record and the scene-folder layout disagree), `unknown` (no single working
    path — no Trash record, unreadable episode), `unreadable` (cannot be read, or a delete stopped
    partway). Each class carries `count`, a bounded `items` sample and `more`; `scan_complete`,
    `scan_note`, `projects_scanned` / `projects_total` and `scanned` say whether the answer covers
    everything, so a zero-orphan answer from an incomplete scan can never look clean (AGENTS §6).
  - `POST /api/library/media-cleanup/orphans/restore` `{ id }` — explicit, one item, and only an item
    the check listed as an orphan. The move itself is `restoreTrashItem` (`POST /trash/restore`),
    which refuses when something already sits at the working path. Nothing is automatic.

### Follow-up: the check could still answer "clean" without looking (branch `fix/orphan-scan-complete`)

Production's source review found three ways, all fixed on `fix/orphan-scan-complete`:

- **A read that failed was swallowed.** `readdir` errors became `[]`, so an unreadable scene-image
  subtree (or a drive root) was silently skipped and the scan still said `scan_complete: true` with
  zero orphans. Now every directory and index read is logged: ENOENT ("nothing there") is fine and
  silent, anything else increments the new `read_failures` count, is named in `scan_note`, and makes
  the scan incomplete. `projects_scanned` counts the channels whose Trash really was readable.
- **The record lookup went through a page.** `listTrash` caps its listing at `MAX_ITEMS` (2000); a
  Trash with 162k shrink originals has a far longer index, so a record past that page looked like no
  record at all — an orphan that could not be restored. The scan now reads the index itself
  (`streamTrashIndex`, one line at a time) and matches the files it found, so nothing is out of reach
  and nothing is held in memory. Bounded output is still 50 per class.
- **An original that left Story's Trash disappeared from the check.** The retention handoff (7 days,
  or 20 GB oldest-first, on a timer independent of `auto_cleanup_enabled`) moves items to the MACOS
  Trash and used to record only `removed: 'macos-trash'` — no size, no destination — and the scan
  ignored `removed` entries entirely, so those originals produced a clean answer while sitting in a
  Trash nobody had looked at. Now: `handOver` records what it can (size, mtime, read before the move,
  and the Mac's Trash path when that exact name was free — `shell.trashItem` returns nothing and
  renames a collision, so a taken name claims no location), the scan reads `removed` entries too, and
  a scene image whose working path is empty is reported as moved with its location when a single
  macOS Trash file matches its exact name and size, and "location unknown" otherwise. **A file the
  macOS Trash holds is never offered for restore** (Story does not reach into the Mac's Trash, and a
  move back across drives could only be a copy-then-delete, which this codebase never does with the
  owner's media) — the location is named so the owner can drag it back in Finder. Every such item
  makes the scan incomplete.

**Records written before this branch say nothing about where a handoff went, and no new record can
cover those past moves**: they are reported as "moved to the macOS Trash", location unknown. Nothing
here can recover the per-file reasons of a finished run either.

## Jobs history: paged, searched and counted on the server (source only, not released)

Branch `feat/jobs-history-paging` from `origin/main` (1.4.323, d54f34b2). **SOURCE ONLY**: no version
bump, no changelog entry, no DMG, no push. The Jobs page still held every job of every channel and
filtered it in memory — ~14k rows, ~128 MB per read at production size, of which `output_lines` (which
no collapsed card renders) was the bulk — and the dashboard layout opened the same read on EVERY page.

**Compatibility decision: `/jobs/all` is unchanged.** Automation callers of `GET /api/jobs/all`
(`view=full` / `view=stream`) get byte-for-byte the same shape they get today. The live surfaces moved
to a NEW view instead — `?view=active` — and the finished half to NEW endpoints. Nothing was silently
re-pointed.

### What is on the wire now

- `GET /api/jobs/all?view=active` and `GET /api/projects/:slug/jobs?view=active` — queued/running/
  paused rows only. `stats` still describes the whole scope, counted from the raw queue without
  cloning a job. Both SSE snapshots (`/jobs/all/stream`, `/projects/:slug/jobs/stream`) now send this
  view. Measured on a 470-row, 4-channel fixture: **12,226 B against 1,789,685 B** for the
  history-carrying view (146×), warm read 2 ms.
- `GET /api/jobs/all/history` and `GET /api/projects/:slug/jobs/history` — the finished history:
  `status=` (display-status buckets, comma-separated; default every terminal bucket), `type=`,
  `batch=`, `q=` / `episode=` (episode code or title), `controls=` (row must offer one of these control
  actions), `since=` (finished at or after), `project=`, `cursor=`, `limit=` (≤500), `ids=1` (matching
  ids only — the cheap selector a bulk action takes), `all=1` (the whole matching set), `facets=1`
  (status/type/active/clearable counts). Newest finished first, keyset-paged; `total` is the matching
  count, not the page. **Only the returned page is serialized** — the filter and the sort read the raw
  queue.
- History rows are a new `row` view: `stream` minus `output_lines`, plus `summary_line`,
  `progress_counter`, `output_line_count` and a resolved `output_dir`. Measured: **1,362 B/row against
  3,814 B/row** in the stream view.
- The matching, display-status and row-reading rules live once, in
  `electron/server/contracts/jobs-history.ts`, imported by the endpoint and by the page
  (`utils/jobs-list.ts` and `utils/episode-recovery.ts` re-export from it).

### What the page does now

`useAllJobs` streams the live half (a finished job leaves the list but still moves the badge). The
universal Jobs list is `streamed live rows ++ /jobs/all/history?all=1` (`useJobHistory`), so the
page's own search, paging and "Select All Matching" still cover the whole scope; a chosen channel is
sent to the server, which is the difference between a fleet and a channel. Project mode is unchanged —
its per-project stream is bounded by the 750-row retention cap and several other surfaces
(`useNotifications`, `useEpisodeStatus`) read it. `useJobDetails` now also fetches a row's log, since a
history row no longer carries one.

### What is NOT done — the next increment

The page still fetches the whole matching history as slim rows (~19 MB projected at 14k rows, against
~128 MB) and pages it client-side. Rendering one page at a time needs the page's global computeds to
stop reading the full list first, or behaviour is lost:
- `stats`, `statusFilters`, `filterTabs`, `finishedCount`/`failedCount`, the empty state → already
  served by the endpoint's `facets`; wire them.
- the bulk-action scopes (`interruptedJobs`, `repairableFailedJobs`, `failedJobsForRetryAll`,
  `failedWaitingForCheck`, `providerCheckJobs`, `recoverableEpisodes`, `settleCompletedFailures`) →
  two narrow reads: `status=error,cancelled&all=1` and
  `status=done,error,cancelled&controls=recheck-provider-status,return-later&all=1` (the client's own
  predicates still re-apply over them).
- `hiddenJobsInScope` / `hiddenSettlingCount` and "Select All Matching"'s selected rows → need a
  by-ids read (a small `POST /api/jobs/rows { ids }` returning row-view jobs).
- counts are computed without the page's local hidden-job exclusion; a hidden finished job still counts
  in its status chip until that by-ids read exists.

### Verification (this branch)

`npx tsc -p electron/tsconfig.json --noEmit` 0 errors; `npm --prefix frontend run typecheck` 0 errors.
Backend: `run-backend-tests.mjs --only job` → 47 files, 467 tests, 467 pass, 0 fail (PARTIAL RUN);
`--only jobs` → 9 files, 55 tests, 55 pass; `--only episode-recovery --only queue --only stream
--only redact` → 30 files, 294 tests, 294 pass. Frontend: 49 affected files re-run, all pass —
`allJobsTransport` 13/13, `useJobDetails` 7/7, `jobsHistoryServerPath` 7/7 (new),
`jobsRetryAllManualFinish` 11/11, `jobsControls` 43/43, `jobCardProgressTracker` 52/52,
`uploadCenterPublish` 86/86, and the rest of the jobs/job-queue surface. **The full unfiltered suites
were NOT run** (not the release gate).

## 1.4.324 — 2026-10-19 (gated and landed)

Gate: lint, four checks pass; test:backend 7501 / 7499 pass / 1 fail — the failure was a race in circular-params-repair.test.ts (Retry before the failed worker settled, refused by the 1.4.319 guard), fixed test-only and re-run 9/9 three times; typecheck, test:frontend 2663/2663, test:release 63/63, test:content-packs 366 pass / 0 fail.

Merged `fix/reconcile-timings-retention` (d35dc0da). Incident: HMH0001 reconcile on the mini (1.4.320) turned 938 scenes into 899 — `reconcilePlanToSubtitles` stamped every word with its cue window, so scenes anchored in one cue tied at its start, the clamp gave the earlier one zero length, and `removeNonRenderableScenes` deleted 39 rows (19 approved, with images). The route promised to preserve every scene. Fix spreads tied starts to the next distinct anchor. Pre-reconcile plan preserved at `_orchestra/production18-20261016/serial-production/hmh-sceneplan-raw-20261019.json`; the 19 images stay on disk. Restoring HMH0001 is an owner decision.

## 1.4.323 — 2026-10-19 (gated and landed)

Full gate on main 3974bbdb: lint, four checks, typecheck, test:backend 7500 / 7499 pass / 0 fail (unfiltered), test:frontend 2663/2663, test:release 63/63, test:content-packs 366 pass / 0 fail — all exit 0.

Merged `fix/updater-resume` (b6e15a48): app-update keeps the staging `.part` for the same release (sha256), resumes with `Range: bytes=N-` + `If-Range: <sha256>` (206 append / 200 replace / 416 restart), no absolute 15-min deadline (30 s inactivity only), status reports downloaded_bytes/total_bytes. Why: the mini reaches the Gateway only via Tailscale DERP (~115 KB/s, mini advertises no endpoints); 1.4.320's updater aborted every attempt at ~41% and restarted from zero, so 1.4.321/322 never installed remotely. A 320 mini still needs one manual install or a direct path to get this fix.

## 1.4.322 — 2026-10-19 (gated and landed)

Full gate on main c9616daa: lint, four checks, typecheck, test:backend 7496 / 7495 pass / 0 fail (unfiltered), test:frontend 2663/2663, test:release 63/63, test:content-packs 366 pass / 0 fail — all exit 0. First attempt stopped at check:model-drift on the crash label 'genstudio-catalog-refresh' (renamed 'catalogue-refresh').

Merged on main: `fix/jobs-read-latency` (one serialization per job on GET /jobs/all, redactSecrets no-match fast path; CATALOG_REQUEST_TIMEOUT_MS 8 s → 30 s plus a 5-min TTS/chat catalogue refresh scheduler), `perf/overview-bulk-evidence` (per-request sidecar memo and listing-first path resolution; overview fs calls 21.6 → 2.4 per episode, same figures), `fix/upload-center-width` (`.uc-table { position: relative }` so sr-only spans cannot widen the document). Open owner decision: Jobs list still returns the whole fleet history per read (~128 MB at production size); paging would change client-side search/select-all.

## 1.4.321 gated and landed — 2026-10-19

Full gate on main: lint, the four checks, typecheck, test:backend 7484 tests / 7482 pass (the one
failure was the version bump un-escaping package.json's `\u2014`; restored in cf6d7cc1 and
source-manifest-integrity re-run 4/4), test:frontend 2663/2663, test:release 63/63,
test:content-packs 366 pass / 0 fail. Publication and the mini update follow via
`_orchestra/codex-takeover-20261012/tools/ship-story.py 1.4.321`. Source notes below.

### Source notes (prepared 2026-10-18)

Branch `release/1.4.321` in `_worktrees/story-studio-kh/release-321`, from `origin/main` `38644209`
(1.4.320, released), with `fix/upload-post-latency` (`ee4b8a9f`) merged in. SOURCE ONLY: no DMG, no
landing, no push. Version `1.4.321` in both `package.json` and `package-lock.json`; newest-first
changelog entry added; `check:changelog` exit 0.

Three fixes, all for the production mini going unresponsive while ten jobs ran (renders + YouTube
uploads) — GET /projects 49 s, /thumbnails 22 s, /app-update/status 45 s, preview-media streams
stalled:

1. **Upload POST no longer re-reads the render** (`ee4b8a9f`, merged from `fix/upload-post-latency`).
   The route SHA-256'd the whole 2–4 GB final on the request path; the job's own
   `resolveYouTubeSourceRevisionFromHandle` check is the one that matters. Already fixed on that
   branch, carried here unchanged.
2. **The Library path is no longer re-read for unrelated settings.** `services/project-manager.ts`:
   `invalidateProjectsRootCache` now takes the written KEY and drops the cache only for `library_root`
   / `projects_root_override` (`appSettingMovesProjectsRoot`). It used to drop on ANY app-settings
   write — including the hourly `retention_status` (`services/retention.ts`) and the queue pause flag
   — putting `existsSync` + `readFileSync` + `JSON.parse` back on the per-request path through
   `getProjectDir` → `routes/middleware.ts`.
3. **The two readiness sweeps fan out 4-wide, not 32.** One shared
   `EPISODE_PROBE_BATCH` in `services/utils.ts`, used by `services/publishing-overview.ts` (was
   `READINESS_BATCH = 32`) and `routes/youtube-upload-center.ts` `GET /youtube/publishable` (was
   `BATCH = 32`). Plus a 60 s single-flight result cache on `readPublishingOverview`
   (`PUBLISHING_OVERVIEW_TTL_MS`), invalidated by `POST /projects/:slug/youtube/sync` — the refresh
   the page's own button runs — so Refresh still shows the newest state.

`UV_THREADPOOL_SIZE` is UNCHANGED at 16 (`electron/boot-env.ts`). No evidence was found that 16 is
the wrong number: the stall is the fan-out width and the synchronous re-reads, not the pool size.
Raising it would multiply the outstanding fs queue behind the uploads rather than shorten it.

Verification run (all exit 0): `run-backend-tests.mjs --only publishing-overview --only
youtube-upload-center --only project-manager --only projects-root-cache --only episode-probe-batch`
→ 9 files, 247 tests, 247 pass, 0 fail (PARTIAL RUN); `--only request-path-blocking-io` → 14/14;
`npx tsc -p electron/tsconfig.json --noEmit` 0 errors; `npm --prefix frontend run typecheck` 0
errors. New focused tests: `publishing-overview-cache.test.ts`, `projects-root-cache.test.ts`,
`episode-probe-batch.test.ts`. **The full unfiltered backend gate has NOT been run** (the coordinator
owns it), and nothing is built or published.

Still open from 1.4.320: the mini's normal update, and the follow-up read times under real load
(this release is the fix to measure).

## Gated and landed on main — 2026-10-18 (1.4.320)

Main carries the reviewed 1.4.320 integration plus, folded into the same release: queued-job
reorder within a kind (Up/Down/Top, durable `queue_rank`) and one stable Jobs order
(`frontend/utils/jobs-list.ts` `orderJobsForDisplay`); Publishing Overview agreement with the Upload
Center (ready / on_youtube via `remoteVideoFor`, active uploads in_progress, processing videos keep
YouTube's accepted publishAt); automatic retention (`services/retention.ts`: `_trash` → macOS Trash
after `trash_handoff_days`, default 7; automatic Free up space via the button's own path, default ON;
expired logs and content-pack removals go to `_trash`). The 8 merged-tree backend failures and 12
frontend harness failures were superseded test expectations (no product change); see the test
commits on main.

Full gate on main `6c584d3d`'s product tree: lint, check:changelog/typography/security/model-drift,
typecheck, test:backend 7470 tests / 7469 pass / 0 fail (unfiltered), test:frontend 2663/2663,
test:release 63/63, test:content-packs 366 pass / 0 fail — all exit 0. Next: push, `dist:smoke`
from main, publication and the mini's normal update (`_orchestra/codex-takeover-20261012/tools/ship-story.py`).
Open after 320: upload POST response latency (>120 s while the job is accepted) and Publishing
Overview read time under load — production reported both; triage in progress.

## Historical — 1.4.320 source preparation (SUPERSEDED by the section above)

Branch `release/1.4.320-integration` in `_worktrees/story-studio-kh/release-320-integration`, from main
`285e2c7a3406858cb72c065dfa76c96644ebbaa3` (1.4.319, released and installed — see below; tree
`036c3d04…`). 70 changed product/test/config/doc paths (55 modified + 15 new) integrated SOURCE-only
and independently reviewed PASS (`story-320-integration/MERGED-SOURCE-FREEZE-20261018/`, review
`67df2cca…`): Finish missing-images admission/persistence (a "Finish missing images" save keeps its
admission and provider callbacks in one coordinated write, so a failed request cannot reappear on a
later save and a late callback cannot undo an accepted request) + Recovery stop-intent,
Image default landscape, image-prompts fail-fast, content-language future-only intros (no intro added
or changed for an existing episode), Telegram episode details, Publishing Overview Coverage/Calendar
tabs + search/sort/Week-Month-Year/paging, and Adaptive idea batching (one or more adaptive calls,
cap 100). Five shared files are carried as reviewed composites and three merged-tree tests as reviewed
re-anchors. Version `1.4.320` in both `package.json` and `package-lock.json`; newest-first changelog
entry added.

NOT RELEASED: the merged runtime is UNRUN. Still owed before any landing: the standalone Finish
RED/GREEN + 319-compatibility proof; the Image, Language and Publishing focused proofs; the mandatory
full unfiltered backend gate and the remaining 11 gates on the merged tree; the main-built DMG; the
post-build release lane; publication readback and install. No push or main landing yet.

**Correction (approved Finish-persistence fix + independent corrective review, 2026-10-18).** The
"70 … independently reviewed PASS" above is review `67df2cca…` of the **original** merged-source
freeze `1376925129…` and binds that freeze's bytes only. After it, **two** of the original 70 paths
changed (the other 68 are byte-identical): `electron/server/__tests__/queue-finish-persistence-admission.test.ts`
— `ffd24309…` (blob `a1983677…`) → `7906e0b1…` (blob `a80c1ac6…`), which adds to the case15 cleanup
at test line 352 an **expected-refusal** assertion
(`assert.rejects(…, error.code === 'CANCELLATION_STATUS_UNKNOWN')`, matching the product's deliberate
"waiting for authoritative provider settlement" control) on top of the earlier `6d51efa3…`
finally-359 `.catch(() => {})` guard — and `electron/server/services/job-queue.ts` — `0af27c87…`
(blob `1d5a5f6b…`) → `8ef3df8f…` (blob `94f17108…`), where the Finish write-failure reconciliation
now compares `observed` against the **canonical serialized** form of `attempted`
(`JSON.parse(JSON.stringify(attempted))`), so an acknowledged rename finalizes `published = true`
instead of fencing `JobPersistenceUncertainError`. The remaining paths are the four version-320
metadata files (package.json / package-lock.json / CHANGELOG.md / this HANDOFF). The corrected bytes
passed an independent corrective review (`aa3b`, PASS); the runtime fresh proof is UNRUN. Record:
`story-320-integration/INTEGRATION-FREEZE.md`,
`finish-persistence-proof-20261018/FINISH-CANDIDATE03-DIAGNOSIS.md`, and the corrected freeze
`MERGED-SOURCE-FREEZE-FINAL74-CORRECTED-20261018/`.

## Released and installed — 2026-10-18 (1.4.319)

Main `285e2c7a3406858cb72c065dfa76c96644ebbaa3` (tree `036c3d04c129e86af7ddcaf4c221eb94a6992c67`) is
pushed and installed; `origin/main` matches. The single accepted change is the queue admission fix:
Retry and a fresh start are refused with a truthful "still finishing locally" message while the
previous worker for the same project, episode and type is still settling locally after its row turned
terminal or was removed from history; episode recovery and Finish missing images share that refusal,
and a Jobs "Finish missing images" row no longer dispatches beside any other live Scene Review worker
for the episode, keeping its FIFO place.

Gates on the landing tree, all with captured exits: full backend **exit 0** — 722/722 files, 7127
tests, 7120 pass, 0 fail, 7 skipped; frontend **exit 0** — 313/313 files, 2637 tests; content packs
**exit 0** — 38/38 files, 368 tests, 366 pass, 2 skipped; electron typecheck, frontend typecheck, lint
and the five static checks (`check:changelog`, `check:typography`, `check:security`, `check:model-drift`,
`check:release`) all 0. Artifact from the main checkout: `dist/Story Studio KH 1.4.319-arm64.dmg`,
243,086,330 bytes, SHA-256 `47d73d8794b3d68dd4abfb632904fde83206729524ebc079eb8c1f6749925950`,
app.asar 1.4.319; the postbuild release lane (`test:release`) ran 63/63 tests across 7 files, exit 0.
One publish POST, HTTP 200, readback matched (published_at 1792321516). The mini installed 1.4.319
through its normal updater lifecycle (installed_at `2026-10-18T11:36:16.336717+00:00`, from 1.4.318,
boot complete true).

## Historical — 1.4.319 source preparation (SUPERSEDED — 1.4.319 is now released and installed; see the section above)

Branch `release/1.4.319` in `_worktrees/story-studio-kh/release-319`, from main
`44601361e37209d28a7356c0ea89a81f487c1a53` (1.4.318, released and installed; tree
`75518e819d24637ad95c8fce500233a074bc83a7`). One accepted change, integrated as an exact 2-file
candidate (patch sha256 `5659261fcd0ba0a74428b738267530b707812e09f251962b9c8282a96786f07c`,
commit `d46443bc`): queue admission now refuses a Retry or fresh start while the previous worker for
the same project, episode and type is still settling locally after its row turned terminal or was
removed from history, with a truthful "still finishing locally" message; episode recovery and Finish
missing images share that refusal; and a Jobs "Finish missing images" row no longer dispatches beside
any other live Scene Review worker for the episode, keeping its FIFO place and re-checking inside the
durable-write window. Version `1.4.319` in both `package.json` and `package-lock.json`; newest-first
changelog entry added.

Focused proof accepted by the parent (`queue-executor-admission-proof-20261018/coordinator-acceptance.json`,
four actual phase receipts): probe 1 pass exit 0; baseline — the pre-fix source at the pinned file
hashes plus the same 19 tests — RED exit 1 (19 tests, 3 pass, 16 fail), including the held-executor
false Retry admission at case 1 line 238; candidate 19 pass exit 0 (1/1 file); compatibility 19 pass
exit 0 (3/3 files; source and tree pins unchanged, process group absent). This is a focused proof,
not the release gate. Test 17 proves the immediate failed-write state and fixture cleanup only — not
later-flush or restart orphan prevention. Separate Finish persistence, image and Publishing work is
not included.

NOT RELEASED: the mandatory full unfiltered backend gate, the remaining release gates, a main-built
DMG, publication readback and install are still owed on this tree; no push or main landing yet.

## Released and installed — 2026-10-17 (1.4.317)

Main `39d12be55b22003098b93a42ab7f564007ae5087` is pushed (landed through
`land/1.4.317-into-main`; the landing tree was verified byte-identical to the tested worktree
`f749ece3` except main's own 316 handoff paragraph). Four independently reviewed source-accepted
candidates plus four accepted corrections found by running the gates:

- `d2f5cb91` (candidate `2778b799`) — Free Up Space becomes two all-channel actions (shrink images
  across every channel; clean up all channels in one step), removing the duplicated per-channel,
  per-category and conversion tools; `cleanup_all` reuses the existing registry, the `_trash`-only
  contract and the >7-day verified-own-channel-upload gate re-checked at mutation.
- `36aac7a7` (candidate `546943e1` + test correction `67ed4522`/`3c2eacff`) — global Publishing
  Overview (`GET /api/publishing/overview`): confirmed YouTube schedules, planned local dates and
  readiness kept distinct; coverage counts confirmed only; unreadable store is unknown, never zero;
  failed link read suppresses the recommendation; no provider write, no invented ETA.
- `e42d275e` (candidate `48968d0a`) — embedding vectors validated at the Gateway boundary (row
  count, index order, width, sparse/non-finite/all-zero/overflow refused, unit normalisation) plus
  an honest hint line.
- Version/changelog `99915045`; corrections `d2715232` (NuxtLink stub + retired SHA-256 pin) and
  `569ad3f3` (type-only `StoredIdea[]`, TS2322) and `39d12be5` (patch sha256 `a497d803…`: the
  review button no longer claims "Starting…" before the confirmation is accepted).

Gates on the landing tree, all with captured exits: full backend **exit 0** — 721/721 files, 7304
tests, 7303 pass, 0 fail, 1 skipped, projects root byte-identical; frontend exit 0 — 313/313 files,
2636 tests, 2636 pass; content packs exit 0 (368 tests, 366 pass, 2 skipped); electron typecheck,
frontend typecheck, lint and the five static checks all 0. Artifact from the main checkout:
`dist/Story Studio KH 1.4.317-arm64.dmg`, 243,073,904 bytes, SHA-256
`a694b9e9980a4a5671d3c4403bb4d0b4af32869f795a88b3e034b2fc22b19413`, app.asar 1.4.317, launch smoke
passed, release lane 57/57 after the build. One publish POST, HTTP 200, readback matched
(published_at 1792261454). The mini installed 1.4.317 through its updater lifecycle (installed_at
2026-10-17T21:50:21.837Z under request `2439aa2ccb2843a3a61db56678195239`). A prior
download-aborted error remained visible across check-ins; later automatic transfer and installation
completed. The exact attempt count and cause of the abort are unknown. No OS reboot, no kill, no
second install POST. All four SSD kit copies were refreshed by the parent (a0846).
Receipts: `_orchestra/codex-takeover-20261012/story-317-gate/`.

## Released and installed — 2026-10-18 (1.4.318)

Main/origin `44601361e37209d28a7356c0ea89a81f487c1a53`, tree `75518e819d24637ad95c8fce500233a074bc83a7`. The release contains the accepted Free Up Space Stop display fix: after an accepted Stop request the interface retains “Stopping…” despite an older in-flight running-status response. The current file still finishes through the existing cancellation boundary. This does not establish the cause of the original incident or faster backend cancellation.

Full unfiltered backend gate exit 0: 721/721 files, 7,108 tests, 7,101 pass, 0 fail, 7 skip; configured projects root byte-identical. Frontend exit 0: 313/313 files, 2,637 tests, all pass. Content packs exit 0: 38/38 files, 368 tests, 366 pass, 2 skip. Both typechecks, lint and five static checks exit 0. Existing discriminating old-component RED: 17 tests, 16 pass, 1 expected failure. Mock browser evidence has the limits recorded in `story-318-gate/ship-summary.md`; do not restore withdrawn timing/stale-payload claims.

Final DMG built from canonical main: `dist/Story Studio KH 1.4.318-arm64.dmg`, 243,073,666 bytes, SHA-256 `75baf05a08eaced20c07b669279694741e9f82bc7ad49421d6961eea88441e88`; bundled app.asar 1.4.318, 98-package closure, launch smoke passed, postbuild release lane 57/57 exit 0. One publication POST HTTP 200 with exact readback, published_at 1792284182.

Mini installation verified at 2026-10-18T02:11:35.695019Z: health ok, version 1.4.318, boot_complete true, updater installed/current318/from317/error null/install_requested false/staged app null. Original request `2c7ca3962b8f45b5b693f9382c39d307`; no repeat install POST, force, generic restart or pause change. Exact earlier aborted-download count and cause remain unknown. All four installation SSD Story318 copies were refreshed and verified; later Hub184 SSD work is separate. Preserve owner `p18-lane-pause.json` and owner pauses.

Receipts under `_orchestra/codex-takeover-20261012/story-318-gate/`: gate-summary.md, coordinator-gate-acceptance.md, coordinator-ship-acceptance.md, ship-summary.md, mini-installed-318.json, coordinator-mini-install-acceptance.md. SSD receipts under `ssd-refresh-20261017-story317/`. Source-only draft: no tests/builds/git mutations/live operations were run to produce this text.

## Source integrated; focused proof and visual checks next — 2026-10-17 (1.4.315)

Branch `release/1.4.315` from `main 9b3d08a9` (1.4.314, published). Six independently reviewed
source-accepted changes, integrated with **no merge conflicts**:

- `cef8f4a1` (chain `9b3d08a9` → `a6edc27b` → `cef8f4a1`) — Scene Review Finish/Replacement use the
  exported `secureOperationId()` (`crypto.randomUUID` → CSPRNG UUIDv4 from `getRandomValues` →
  truthful refusal) instead of refusing whenever `randomUUID` is absent, which is the plain-HTTP case.
  The four sibling request-identity sites (Pipeline ×3, Episode Builder, publish) share the helper.
  Review limit: every test on that branch was unrun at review time; the lanes must actually run.
- `d81f346e` — Free Up Space button spacing (one CSS line).
- `f80fce8e` — Settings left-rail scope colours (one file).
- `0047dcf9` — scene-image media type read from the bytes (`lib/image-media-type.ts` + 4 routes +
  client); two release-note items: an out-of-scope `source_path` returns 403 before the
  "Add a Gateway API Key first" 400, and containment now sits outside the vision route's try/catch so
  an `allowedPreviewRoots` throw surfaces as the app's 500 rather than the route's 502.
- `fa1a00d2` — the per-run Pipeline writing-model override is retired; the writing model comes from
  the selected preset through the Gateway, and the preset selector no longer overflows.
- `5249df37` — Character Sheet no longer carries the leftover preset scene-rhythm notice or applies
  pacing; Scene Plan's "Visual timing & motion" stays authoritative, the save boundary keeps the
  on-disk rhythm unless the payload claims it (`claim_pacing: true`), and old presets are stripped at
  the boundary, never rewritten.

Union check on the shared `frontend/pages/projects/[slug]/pipeline.vue`: the secure-identity helper is
present (5 references, including the import and the run/replacement call sites) and the per-run
override is gone (0 remnants). No conflict markers anywhere in the tree. On the server
`routes/pipeline.ts` the picker removal and the Character Sheet pacing boundary coexist: the
`character_sheet` header comment now says the preset's LOOK is applied and the episode's rhythm is
not, and `applyContinuityPresetForPipeline` carries the same boundary.

Still owed before release: focused proofs (UUID/frontend runner, the 10 MIME cases, the Pipeline
contract, the Character Sheet 10 cases), desktop/mobile light/dark visual evidence, the full backend /
frontend / content-pack lanes, types, lint and the five static checks, then main integration, a
main-built DMG, the post-build release lane, one pinned publish and a readback.

## Released; install pending the normal path — 2026-10-17 (1.4.313)

Main `4d4a15dd72d462b9cc64b3b03420cd266eebbeb2` is pushed. Two accepted changes:

- **Install now (don't wait)** (`63d39c3e` + `7ee410e4` + `d8c788cc`, final independent review
  ACCEPT): the update banner and Settings → Updates can install a staged version at once, pausing the
  queue instead of waiting for the drain, behind the existing confirmation. The immediate request is
  deliberate standing intent: a request recorded while version X was downloading installs the next
  offered version immediately, with no second confirmation.
- **Timeline-drift advisory** (`c3676bb2` + `f521d3bb`, final review ACCEPT): the Final Video
  step's advisory now uses the merged audio file the render itself selected, so a record describing a
  different file no longer raises a false drift warning. This is an annotation, not a refusal, and is
  **not** a production clearance for PR0002/PR0003 — intended audio selection is still unresolved.

Gates: full backend 708/708 files, 6974 tests, 6967 pass, 0 fail, 7 skipped, projects root
byte-identical; electron/frontend typecheck, lint 0 errors, five static checks, release lane 57/57
after the build. DMG from the main checkout: `dist/Story Studio KH 1.4.313-arm64.dmg`,
243,035,915 bytes, SHA-256 `21b2c7f8d1e3dbdb914adb1481af11af9005a23db38f202aa7c600f0346c4a65`,
app.asar 1.4.313, ad-hoc arm64, launch smoke passed. One publish POST, HTTP 200, readback matched.
Receipts: `story-313-gate/`.

Not in this release: the chained-video-effects fix `dda1e3cc` (final ACCEPT, held back only because
this gate was already green) and every unaccepted item (scene-plan wording `10067a5f`, the
pause-ownership follow-up, the effects recovery-identity follow-up). No install POST was issued for
the mini; the earlier denial stands.

## Source follow-up reviewed and committed separately — 2026-10-17 (updater pause ownership)

Isolated `fix/updater-pause-ownership` starts at release/1.4.313 `4d4a15dd`, which already
contains the accepted immediate-install commits `63d39c3e` / `7ee410e4` / `d8c788cc`.
The follow-up replaces boolean-only pause release with durable ownership checked under the
existing queue transition lock. Explicit owner Pause/Resume supersedes updater ownership,
including Pause while already paused; `job_queue_paused` remains a boolean for older builds.

Legacy `we_paused` alone cannot establish ownership. Preserve the hold and show recovery guidance
in Settings → Updates. The installing handoff must not leave that legacy flag authorizing an
older restored binary to lift an owner's later pause. On an actual rollback to an older binary,
a genuine updater hold may therefore remain until the owner presses Resume; its old UI has only
the general rollback error. New-source rollback tests do not prove the old binary safe.

Independent final source review ACCEPT followed corrections for a failed release losing its token
and ownership changes during suspended acquire/drain checks. Release failures retain the claim,
show recovery guidance and retry on the next boot. The unchanged real-queue regression on the
pre-fix base completed 4 tests: 1 pass, 3 behavioral failures (exit 1, 1/1 file complete, isolated
projects sentinel unchanged). Under the release owner's explicit serial window, the initial focused
run completed 3/3 files, 58/58 tests, exit 0. The corrected runtime run completed 3/3 files, 62 tests,
61 pass / 1 fail, exit 1: the added order test used an invalid `outline` queue key. Correcting only
that fixture to the existing serial `chapter-only` lane passed the queue-only rerun: 1/1 file,
5/5 tests, exit 0. All runtime race regressions passed, both sentinels stayed byte-identical, and
final Electron typecheck exited 0. These filtered checks are NOT the full backend release gate.

This is not a release: version allocation, complete release gates, main integration, push and
main-built DMG remain the release owner's work. No live pause/settings/HTTP/install or production
job edits were performed by this follow-up worker.

## Released; mini update requested — 2026-10-17 (1.4.316)

Main `2ea94d598a232ed2972cf18a152f7983597776cc` is pushed. Four independently reviewed source-accepted
candidates, plus five accepted test/type corrections found by running the gates:

- `cbb01a66` one explicit episode-owned merged-audio choice (single resolver; render, stitch, plan gate,
  Scene Review, audio-merge status and B-Roll agree where the owner has pinned; an accepted job keeps
  its snapshot; a vanished accepted track is refused, never substituted).
- `9be8c47d` two machine-wide Free up space controls — shrink images on all channels; clear uploaded
  final videos on all channels only when the upload is freshly verified on its own channel and the
  production is strictly older than 7 days, re-checked at mutation.
- `b9c7ee85` a normal install (including a remote "Update now") waits for a media cleanup to finish or
  be Stopped, even beyond 30 minutes; only the explicit "Install now (don't wait)" button bypasses it.
- `a7cc7270` + `ea105d20` YouTube schedules confirmed by instant rather than by comparing text.

Gates on the final tree, every one with a captured exit: full backend **exit 0** — 718/718 files, 7064
tests, 7057 pass, 0 fail, 7 skipped, projects root byte-identical; frontend lane exit 0, 312/312 files,
2623 pass; content packs exit 0, 368 tests, 366 pass, 2 skipped; electron typecheck, frontend typecheck,
lint and the five static checks all 0; wide focused coverage exit 0, 337/337. The gates caught five
candidate defects — a missing test hook, a `queued`-vs-`running` race, a bare fixture that could not
reach the code under test, a stale refusal regex and a TS1355 `as const` — each corrected under
independent review and re-gated. Earlier failing logs are preserved in `story-316-gate/`.

DMG from the main checkout: `dist/Story Studio KH 1.4.316-arm64.dmg`, 243,095,313 bytes, SHA-256
`7c09eb3fa192ecda2d4ccf4accbbf28603354f01722d7f5c3be739bd542c83f1`, app.asar 1.4.316, ad-hoc arm64,
launch smoke passed; the 1.4.315 DMG moved to `_trash/dist/` with its bytes preserved. One publish
POST, HTTP 200, readback matched. The mini's normal guarded update was requested once
(`update_request_id ebf86063fa0741908a5f300172c5b8f5`) under the owner's direct approval; the owner's
queue-pause state is untouched by this worker.

## Released; install pending the normal path — 2026-10-17 (1.4.315)

Main `d5188dc7f96614a8dda21e77ae73fa6555ac62ac` is pushed. Six independently reviewed source-accepted
changes plus three accepted test corrections, integrated with **no merge conflicts**:

- `cef8f4a1` (+`a6edc27b`) — Scene Review Finish/Replacement work over plain HTTP through the exported
  `secureOperationId()` (CSPRNG fallback instead of a refusal), shared by Pipeline, Episode Builder and
  publish. `d81f346e` Free Up Space spacing. `f80fce8e` Settings rail scope colours. `0047dcf9`
  scene-image media type read from the bytes (with the vision containment fix). `fa1a00d2` the per-run
  Pipeline writing-model override retired. `5249df37` (+`773cef2e`) Character Sheet pacing ownership.
- Post-gate corrections: `10e33309` (a stale UUID source pin), `93bc2bf3` (a pre-existing manual-redo
  test race), `032da5ed` (the new pacing test's fixed-ms sleeps replaced by a real lock signal — the
  only product-file change, a read-only queued-waiter test accessor in `lib/atomic-store.ts`,
  explicitly authorised as a targeted exception).

Gates, all with captured exits: full backend **exit 0**, 713/713 files, 7013 tests, 7006 pass, 0 fail,
7 skipped, projects root byte-identical (the first run on this tree failed with three defects — a stale
pin, the wall-clock guard, and a pre-existing settlement race — all three corrected and re-gated);
frontend lane exit 0, 312/312 files, 2621 pass; content packs exit 0, 368 tests 366 pass 2 skipped;
types, lint and the five static checks all 0; release lane 57/57 after the build. DMG from the main
checkout: `dist/Story Studio KH 1.4.315-arm64.dmg`, 243,038,510 bytes, SHA-256
`ab892e6c932d89889d8c5d76ba4402e0499c916ebe116ae92f17493150ebac6d`, app.asar 1.4.315, ad-hoc arm64,
launch smoke passed; the 1.4.314 DMG moved to `_trash/dist/` with its bytes preserved. One publish
POST, HTTP 200, readback matched. Receipts: `story-315-gate/`.

Visual evidence (isolated app, no production data): Settings rail dots/tint verified light, dark and at
375px; the Pipeline preset selector does not overflow at 1920/1280/375 with a long label; the UUID
helper returns a UUIDv4 with `crypto.randomUUID` removed; the Free Up Space button's 16px margin and
16px list gap verified at 1280 and 375 through a mocked API response (the fixture episode could not be
listed for real because the app resolves the project directory away from where it was written).
Screenshots in `agent-reports-20261016/story-315-proof/`.

The mini is on 1.4.314 by its own path and its queue is **held** (32 paused, 12 queued, 0 running).
This worker issued no install POST: machine-wide absence of a media-cleanup operation cannot be proven
through any existing read route, so the install stays held pending real evidence.

## Released; install pending the normal path — 2026-10-17 (1.4.312)

Main `dab23457f784fa1f3a9e52babaf414af4c675e53` is pushed. Two accepted product fixes:

- audio evidence identity (`2281552a`, independent review ACCEPT): a chapter part whose Gateway
  request was settled `not_created` is re-sent under the same idempotency key instead of failing as a
  mismatched identity, while a real id that disagrees stays fail-closed. Review limit: the actual
  manifest was not read, so the live DM0001 case is **not** claimed proven.
- scene-plan admission (`aa68e511`, narrow source review ACCEPT): the merged-audio record is read for
  the file the plan and the renderer actually use. Not a production clearance for PR0002/PR0003 —
  intended audio selection is still unresolved and the routes still have four selectors.

Gates: full backend 708/708 files, 6965 tests, 6958 pass, 0 fail, 7 skipped, projects root
byte-identical; electron/frontend typecheck, lint 0 errors, five static checks, content packs,
release lane 57/57 on main after the build. DMG from the main checkout:
`dist/Story Studio KH 1.4.312-arm64.dmg`, 243,033,360 bytes, SHA-256
`2fefe804c84451e39f7780034ce1cc30ba3affde2e90dd9b745d544683e0ae06`, app.asar 1.4.312, ad-hoc arm64,
launch smoke passed. One publish POST, HTTP 200, readback matched. Receipts: `story-312-gate/`.

The mini installed 1.4.311 by itself (verified read-only) and now offers 1.4.312; this worker issued
no install POST. Excluded: the advisory `c3676bb2`/`f521d3bb` pair and immediate-install
`63d39c3e`+`7ee410e4`+`d8c788cc` — both accepted, both slated for the next product release rather than
restarting this green gate.

## Released; install pending the normal path — 2026-10-17 (1.4.311)

Main `298870d53d009bf6a53aa582e13117ba814c1642` is pushed. This release is internal only: the three
test files that carried fixed-ms sleeps before an assertion now use deterministic waits
(`ff723989`, review passed: 32 tests, 10 repeats, typecheck), and the guard's transitional baseline
allowances for them were removed in a new commit (`124c3d80`) so the allowance is 0/0/0 rather than
the 2/1/1 recorded in 1.4.310's `603315a4`. No product source changed and no app behaviour differs.

Gates: full backend 707/707 files, 6959 tests, 6952 pass, 0 fail, 7 skipped, projects root
byte-identical (taken under a gate lease with no competing suite); electron and frontend typechecks,
lint 0 errors, check:changelog/typography/security/model-drift/release, content packs 366/368 pass
2 skipped, release lane 57/57 on main after the build.

DMG built from the main checkout: `dist/Story Studio KH 1.4.311-arm64.dmg`, 243,032,560 bytes,
SHA-256 `760f2cef64b8d2f6d5c038e0148875835a2061a132c9b2decfedf4f5a7a602a0`, bundled app.asar
1.4.311, ad-hoc arm64, launch smoke passed; the 1.4.310 DMG moved to `_trash/dist/`. Gateway
publication was one POST (HTTP 200) with a matching readback. Receipts: orchestra `story-311-gate/`.

The mini still reads 1.4.310 with the 1.4.311 update available; this worker did not request an
install (that action was denied earlier and the hold stands). Excluded, still under review:
immediate-install `63d39c3e` + guard `7ee410e4`, and audio evidence identity `2281552a`.

## Released and installed — 2026-10-17 (1.4.310)

Main `87ea6b5dca28163ad07d2c661d81335966c0fb14` is pushed; the mini reports 1.4.310 with
`boot_complete` true and an unpaused queue. Publication was one POST (HTTP 200) with a matching
readback. The worker's own guarded update POST was denied by the permission classifier and was not
worked around, so the install came from another authorized path — the exact cause is not proven and
is recorded as such. Evidence: `_orchestra/codex-takeover-20261012/story-310-gate/installed-evidence.json`
plus `agent-reports-20261016/story-310-release.md`.

## Source verified; DMG and install pending — 2026-10-17 (1.4.310)

Three accepted fixes on `release/1.4.310` (base `main` f9a4ba11 = 1.4.309): the script-only Pipeline
outline handoff (`7b297e55`, independently reviewed ACCEPT — a finished outline is no longer counted
as a competing chapter writer for the duration of its own chain dispatch), the trailing-comma repair
at the strict structured-output gate (`d2693566`, reviewed ACCEPT against the real DM0008 Gateway
answer), and the owner-resumed audio job requeue at boot (`143b85dc`, reviewed ACCEPT — a queued
Gateway audio/transcription job with unsettled evidence is requeued instead of diverted to
reconcile-only). Version and changelog are `1.4.310` in `package.json` and `package-lock.json`.

Gates on this tree: full backend 707/707 files, 6959 tests, 6952 pass, 0 fail, 7 skipped, configured
projects root byte-identical; electron typecheck, lint (0 errors), frontend typecheck; check:changelog,
check:typography, check:security, check:model-drift, check:release; content packs 368 tests, 366 pass,
2 skipped. The release lane's one failure is its built-bundle existence check, which only passes after
`npm run dist:smoke` (AGENTS: it runs after the DMG build). The guard `no-new-wallclock-sleeps` was
red on `main` before this release (three test files added after its baseline was written, plus a
baseline entry for `ttl-cache.test.ts`, deleted in v1.4.204); the baseline was reconciled with the
guard's own documented `UPDATE_TIMING_BASELINE=1` procedure and the three sleeps are fail-open
observation windows per its triage table. A deterministic `waitFor` conversion of those three files is
in progress separately and is expected to replace that baseline edit.

Not included: the immediate-install feature (`63d39c3e`, accepted with a follow-up guard pending).
DMG build, publication, and the mini's normal guarded update still have to be verified; the mini is
on 1.4.309 with an unpaused queue.

## Source candidate, not released — 2026-10-16 (immediate install, branch feat/install-update-immediately)

"Install now (don't wait)" (owner request, 2026-10-16): `POST /app-update/install-now` takes
`{immediately:true}`; the queue is paused, the state persisted (`immediate:true`), and `install()`
runs without the drain — from `ready` or `draining`, or as soon as staging finishes when pressed
while downloading. The banner and Settings → Updates both offer it behind the existing confirm.
Commits: `63d39c3e` (feature) and the guard fix below. Source-only: no version bump, no changelog
entry, no DMG, no install; the next release must add the CHANGELOG line.

Guard follow-up (independent re-review of the guard, 2026-10-17 — two blockers, both fixed):
B1 the claim was never freed when the quit was vetoed (`will-prevent-unload` aborts it), so after the
6-minute "did not quit" failure every later install — immediate, plain or automatic — stalled in
`draining` with intake paused; the quit-deadline timer now frees the claim (`installing = null`).
B2 a caller that paused intake and then lost the race returned without recording `we_paused`, so
after the restart `releaseOurPause` could not lift the updater's own pause and the owner's intake
stayed stopped; that caller now records the pause it took. Both regressions are covered by
deterministic tests (the quit deadline is a test seam, `_setQuitDeadlineForTesting`).

Concurrency guard (independent review N1, confirmed): a drain tick suspended in
`wouldNotResume`/`inFlightSubmits` could spawn a second helper and write `draining` over the
`installing` an immediate press had committed. `install()` now has one claimed in-flight hand-off
(`installing` in services/app-update.ts), `maybeInstall` re-reads the state after its `setPaused`
await and only claims the drain if the release has not moved on, and the drain tick re-reads the
phase before handing off. Two regression tests cover immediate+immediate (both held in `setPaused`)
and suspended drain+immediate; both fail on the pre-fix source.

Known, deliberate behaviour (review N2, no setting added): the immediate request is standing intent,
like the existing `install_requested` — a request recorded while release X downloads installs the
next offered release (Y) immediately, without a second confirmation. Say so in the release notes
when this ships.

## Released; install pending automatic drain — 2026-10-16 (1.4.306)

Product `58bd99f5200b6e66a3c4f75f0d229ffecc2e80fa` (custom narration guidance now carried into Pipeline outlines/runs) is on main and pushed, fast-forwarded from 80e34dfd via `land/1.4.306-into-main`. Gates: full backend 699/699 files, 6849 pass, 0 fail, 7 skipped; frontend 310/310 files, 2605 pass; content packs 38/38 files, 368 total, 366 pass, 2 skipped; release lane 6/6 files, 57 pass; check:changelog, typography, security, model-drift and check:release pass.

Primary-main DMG `dist/Story Studio KH 1.4.306-arm64.dmg`: 243,038,521 bytes, SHA-256 `16e6dafc00e6bfb95712b7d7d3903bd04cf6e67ebfb901c07d2ed908283a0ee0`; bundled app.asar reports 1.4.306, unsigned/ad-hoc arm64, launch smoke passed. The 1.4.305 DMG moved to `_trash/dist/`. Gateway publication returned 200 and its descriptor matches version, bytes and hash.

The mini (1.4.305) had a running `video_assembly` job (DL0011 final video), so no check or install was forced; it is left to the normal automatic drain. Queue at release: 1 running, 51 queued, 1 paused (owner), 26 done, 2 error; unchanged after ~17 minutes of polling. Confirm the mini reports 1.4.306 before assuming it is installed. Receipts: orchestra `story-306-gate/`.

## Released and installed — 2026-10-14 (1.4.305)

Product6f09611fbbb6b563d69182d6b16a53701decde10 is integrated/main/pushed. Allten source phases passed on exact runtime/test-equivalent reviewed e732: backend698/698files7050total7046pass4skip0fail, frontend310/310files2605pass, contentpacks38/38files368total366pass2skip, lint/types/allfive static checks. Main's only integration delta is the independently reviewed handoff preserving the304installed record. Earlier failed gates and focused RED/GREEN proof remain retained.

Primary-main DMG243,038,490bytes SHA2a330bc7d97984d62fa9ac5508a6b306b41168ca677627f3d172ff3ffd7ca4d7 passed read-onlymount, ad-hocarm64signature,98runtimepackages and isolatedboot/health/UploadCenter. AllCURRENT57installer checks across6files passed;54 was the priorrelease count and three runner regression checks were added. Signed Gatewaypublication200 and sole normalMiniupdate0b5427434e3a43c48e31266ae876b3d7 installed305; oneCheckNow consumed thatsameacceptedID, its caller timedout while the existing updater continued. Fresh health305/bootcomplete, updaterinstalled/noerror/queueunpaused/holdsfalse andthree livefrontendchunks byte-identical to packagedapp verified. Noforcedrestart, ownerpause/preset/voice change or rootepisodegeneration.

One installed Free Up Space summary GET returned200 in2.242seconds with allfour numeric measurements; no cleanup or repeated scanner. The exact previous stalled syscall remains unknown; the bounded source correction cannot preempt synchronous filesystem work and inherited discovery can omit inaccessible roots. OriginalDL11render84011dcd andSS63render1810f225 remain singularqueued. Production owns output proving when its queue reaches them and all actuallyneeded newmanual/preset work; no blanket regeneration.

This incremental release includes source-bound manual admission/replay and completed Idea, Voice, MusicLibrary, ImagePool, SongPool, Script/Document, first ScenePlan preset/sharedSaveApply/Pipeline repair and boundedFreeSpace. Eleven remaining manual lanes, other preset adapters, Introduction, MusicBuild, mixed Music planning, listen-back and actual output proving remain open. Receipts: orchestra story-305-gate/{source-phase-results,main-integration,artifact,release-result,publication,update-start,check-now,installed,free-space-once-result}.json. Priorpackagedapp retained _trash/builds/20261014-162339/dist/mac-arm64;304DMG retained by normalrelease script in_trash/dist.

## Source verified; packaging pending — 2026-10-14 (1.4.305)

Reviewed feature e7326cd02b1a97ab908b106fc58ee0e27b13b2bb passed all ten required source phases: lint, typecheck, full backend698/698files7050tests7046pass4skip0fail with configured projects root byte-identical; full frontend310/310files2605pass0fail; content packs38/38files368total366pass2skip; changelog, typography, security, model-drift and release checks. Prior failed gates and focused RED/GREEN evidence remain retained. Independent source reviews and the documentation-only integration resolution are complete. Main integration preserves the verified304installed history below; every other tracked file matches the tested feature.

Primary-main DMG, all54installer checks and installed305health/recovery still remain required. Story304 is installed until the normal update is verified. This release covers the documented completed manual lanes, first Scene Plan preset adapter, replay/partial-repair contracts and bounded Free Up Space; remaining manual/preset lanes and actual production output proof are still open. Production alone owns episode generation and accepted renders.

## Candidate preparation — 2026-10-14 (1.4.305; not released)

The candidate version metadata is set to 1.4.305 in `package.json` and `package-lock.json`. Version allocation was checked read-only against this worktree's primary/main refs and `origin`; the candidate version has no local or remote tag collision. Installed Story 304 remains authoritative. This branch is feature-only and is not main, released, or installed.

The reviewed scope is the shared source-bound manual admission/replay foundation and the Idea Campaign, Voice, Music Library, Image Pool, Song Pool, and Script/Document lanes, plus the first Scene Plan preset adapter and Pipeline replay/partial-repair behavior. This is not all-types completion or proof of live generation outcomes. Other preset adapters, Introduction, Music Build, mixed Music planning, listen-back, and eleven remaining user lanes remain open. Do not claim new defaults, preset migration, or changed cost/permission policy.

Free Up Space has a clean bounded independent review, retained real async-barrier RED/GREEN, six backend checks, focused frontend/Settings checks and compiler receipts. It remains a source candidate until the full release and installed checks pass. Its 30-second async deadline does not preempt synchronous filesystem calls, and inherited discovery may omit inaccessible roots; exact production stalled syscall remains unknown. The complete Story 305 release gates, final independent review, main integration/push, primary-main DMG, install, and production output proof remain pending. Research test preparations remain unrun and excluded from tracked source.

The first two full 305 attempts stopped with verified failures and are retained as failed/interrupted evidence, never passing gates. The bounded R2 correction preserves captured episode pacing/motion per field when an exact Scene Plan preset omits those fields, while explicit preset values still win. Pipeline also preserves an explicit numeric prompt cap without an intended image model. Actual mock-route RED/GREEN and 128 focused checks pass; independent final-diff review and a fresh full gate remain required. Stale automatic-preset/replay assertions and a fixture reconciliation race were corrected without changing runtime admission guards. Story 304 remains installed, with its main, DMG and normal-update receipts complete in orchestra `story-304-gate`; older preparation paragraphs below are historical.

The third full 305 backend run completed all 698 files and 7,050 tests: 7,044 passed, two failed and four skipped. Both failures were reproduced as stale test assumptions after exact Scene Plan preset authority. The bounded two-test correction preserves the source and motion fences and adds real paused-queue proof that the selected preset forwards its legible-text setting. All 17 focused tests pass; product runtime source is unchanged from the reviewed R2 checkpoint. This is not a passing full gate: final release checks, main integration, DMG and installation remain required.

The fourth full 305 gate passed lint, typecheck and all 698 backend files: 7,046 tests passed, four skipped and zero failed, with the configured projects root byte-identical. Frontend completed all 310 files but failed on 26 stale harness/assertion marks. The bounded 13-test-file correction reproduced those failures, restored missing harness dependencies and retained the preset, catalog, callback, source and confirmation contracts without changing product runtime. Its focused run passed 140 tests; the extra RED count was an asynchronous file-level error, not a removed test. Independent review also tightened the Script workspace ordering assertions so missing markers cannot pass as position -1. Full frontend and the remaining source/artifact gates still need to pass before release; unchanged full-backend evidence remains applicable to this frontend-test-only correction.

The continued gate then passed all 2,603 frontend tests and the 366 content-pack checks (two intentional skips), but the model-drift check found zero defaults in Music Library and Song Pool price classification. A real component reproduction also showed their UI treated an absent or null minimum-credit field as zero for a local model. The bounded correction keeps that state unknown, preserves explicit published zero and chargeable metadata, and still treats positive published prices as paid. Backend catalog parsing already rejects malformed or absent required pricing; its nullable positive-price checks now avoid invented defaults. Focused frontend 11/11, backend 17/17 and the model-drift check pass. Independent review and the appropriate final release gates remain required for this runtime correction; Story 304 is still installed.

## Released and installed — 2026-10-14 (1.4.304)

Saved legacy pacing recovery now accepts only the original owning run. Unknown chapter-submit responses preserve the captured body, target and operation identity for Retry, with usable error detail and secure HTTP-browser UUID support. A separate default-off machine preference exposes explicit source-bound replacement for unresolved missing chapters and Scene Review Replace Anyway; existing chapters and provider evidence remain. Active/paused/unwinding writer guards, same-action replay and changed-body conflict remain. This release covers those two lanes only; the remaining all-types manual-redo work is not shipped.

Independent slice/aggregate reviews are clean. Required source evidence: full backend685/685files6946total/6942pass/4skip; full frontend300/300files2506pass; contentpacks38/38files368total/366pass/2skip; lint/typecheck/changelog/typography/security/model-drift/release pass. Initial stale/timing fixture failures and their focused RED/GREEN resolutions are retained, not relabeled passed. The last change is only the supporting-text 12px shared token; unchanged script/template SHA, actual-label desktop/390px keyboard/layout proof and review confirm behavioral suites still apply. Orchestra story-304-gate/source-phase-results.json binds the aggregate.

Product6abb2230e74f1576662855fa7b3c801a14d2a1c9 is integrated/main/pushed. Primary-main DMG242,952,215bytes SHA80331833da1d0b3747890010556845acf4634e9dc728efc99bb3245ee01bad79 passed read-only mount, ad-hoc arm64 signature,98runtime packages and isolated boot; all54installer checks across6files passed. Signed Gateway publication200 and sole normalMiniupdate028a2fc550164e249444079285d495ec installed304. Fresh health304/bootcomplete, updaterinstalled/noerror/queueunpaused andthree livefrontendchunks byte-identical to build verified. Production received installedreceipt and owns DL14 missing10–15 (keep1–9) and EP0110 saved-source recovery; fixes dispatches noepisodes and changes noownerpresets/pauses. DL11/SS63originalrenders remain singularqueued. Receipts story-304-gate/{source-phase-results,artifact,release-result,publication,update-start,installed}.json. Previousbuilds retained _trash/builds/20261014-044201 and prior303DMG in_trash/dist. Remaining all-types work isisolated/sourceonly andnotincludedin304.


## Released and installed — 2026-10-13 (1.4.303)

Product source `fbfdbc18e942b8d574f63dbb1f0b372f0c0a9c67` is on main and pushed. Primary `dist/Story Studio KH 1.4.303-arm64.dmg` is verified: 242,960,561 bytes, SHA-256 `a1476bc32d7df4def778c574527f7aa608578fcfed02f82986ee55410f3f4755`. Gateway publication returned200 and one normal update command for `macmini-angkor` installed303 after normal check-in/drain. Fresh health reports1.4.303/boot complete; updater reports installed/noerror/no pending request/queue unpaused. The two corrected component messages were verified in the live served frontend chunk. The private sleep-story recipe is unchanged; existing DL11/SS63renders remain singularqueued and DL14remains the sole held refusal. No forced restart, manual pause or channel operation was performed.

The thumbnail picker/library distinguishes declared generated examples from synthetic layout placeholders, including indexed accessible names and existing hint/footer status. Layout, selection, recipes and generation remain unchanged. Independent review, desktop/390px actual-component/Modal/focus checks and focusedTDD7tests passed. Required checks: backend6,926total/6,922pass/4skip; frontend2,491pass; contentpacks368total/366pass/2skip; typecheck/lint/source+compiled build exit0. Initial isolated `npm run verify` stopped at the missing packaged-app precondition (53/54 installer tests); all54 installer tests subsequently passed against the actual303main-built app. No validation was weakened. Lint's1,964warnings and isolated late-persist guard warnings are inherited; no new runtime failure was established.

Artifact verification mounted the DMG read-only, checked ad-hoc arm64 signing and98runtime packages, and booted an isolated profile to health/UploadCenter. Both new component messages occur in the packaged frontend chunk. Source/artifact/provenance/install receipts are in orchestra `story-303-gate`. Previous derived output/app retained under `_trash/builds/20261013-194441`; previous302DMG/blockmap retained under `_trash/dist/` with timestamp20261013124500. Installation and retained jobs/library were verified normally; exact receipt is `story-303-gate/installed.json`.

## Released and installed — 2026-10-13 (1.4.302)

Product source `f525c8bf1e5b3e5c184251589f591305154abe02` is on main and pushed. Primary `dist/Story Studio KH 1.4.302-arm64.dmg` is verified (242,952,992 bytes; SHA-256 `8f0e1ac19365a321c2267e1c809d4781ce5556f3b9a7da974c01cb34034dd07b`) and published through Gateway. The mini installed it normally; health reports 1.4.302, boot complete, queue unpaused and no pending install request. No owner pause was changed.

The explicit retry fix widens an existing saved-source recovery plan to the requested later failed stage while preserving identity, settings and accepted work. Independent review is resolved. All ten source checks passed: backend 6,926 total / 6,922 passed / four skipped across 684 files; frontend 2,490 passed; content packs 368 total / 366 passed / two skipped; typecheck, lint and five static checks passed. The configured projects root remained byte-identical. The primary-main DMG build passed, followed by all 54 installer checks across six files.

Live proof on the installed app: DL0011 Scene Plan retry returned 202, widened the same recovery plan, verified all six prerequisites and adopted original render `84011dcd`; **zero new jobs** were created. SS0063 saved-parameter preflight also passes; its existing render `1810f225` and DL0011's render await the queue. Keep historical failed rows until replacements finish. No repair-coverage or paid regeneration.

Receipts: `~/Developer/_orchestra/codex-takeover-20261012/story-302-gate/` and `dl0011-retry-installed-302.json`. The owner’s iCloud Story Studio Agent Automation/HANDOFF.md records live production ownership. This closing documentation commit does not change the product source or replace its installer.

## Current work — 2026-10-13 (1.4.301 safety policy and lyrics release)

ChatGPT took over from Claude with the owner's explicit authorization. Release source `3c09ebd6` is integrated on main, pushed and published through Gateway after all gates passed. The mini subsequently installed 1.4.301 through its normal automatic drain; health and queue recovery were verified. Do not force an update or duplicate its queued jobs. Preserve the inherited `650da798` commit. Root owns integration and the single test-suite lease; workers do not publish.

- Fourteen Video Assembly / picture checks now use the existing policy; missing picture, merged narration and final-whole checks default Block. Five editorial checks default Warn. Explicit stored channel choices are preserved; no data or preset migration.
- Manual metadata/audio-merge and caption-gap readiness projections now match generator policy, including Scene Review and frontend readiness wording. Missing sections and failed subtitle verification remain separate blocking facts. Cache schema18 discards persisted statuses computed under the old caption-gap semantics on upgrade.
- SS0063 revealed a covered opening gap rejected at assembly preflight. Opening paths and both coverage checks passed independent review; no real scene plan was rewritten.
- DL0011 exposed a 3 ms audio/subtitle end difference. Reconciliation now uses the later end consistently, keeps measured source audio separately, and reports retained rows honestly. Focused regression and related checks passed; live continuation waits for release.
- Sung briefs target 250–350 words and 8–9 sections. Generation and preview share a per-pending-batch writing allowance clamped by live model limits; requested song duration is provisional, not guaranteed.
- Installer verification now retains its isolated launch/DMG scratch directories in unique project `_trash/release-*` folders after shutdown/detach, instead of deleting them. Failed moves preserve the original scratch path and report it.
- Final source gate passed: r8 backend 6,919 passed, four skipped, zero failed, all 684 files/900 suites completed (6,923 tests, exit 0; configured projects root byte-identical). r8 frontend 2,490/2,490 passed across 300 files, plus typecheck/lint exit 0. Five static checks and content packs passed in r7 on the same product source (366 passed, two intentional external-evidence skips, all 38 files). Earlier stale assertions were corrected and independently reviewed; focused fixture proof was 58/58. Final source fingerprint is retained in the external gate receipts.
- Independent source review is clear for video, manual audio policy, lyrics and timing. Source and artifact gates are complete: main dist:smoke exit 0, isolated launch/health/Upload Center and dependency/version validation passed, then all 54 release tests passed across six files (exit 0). Evidence: `~/Developer/_orchestra/codex-takeover-20261012/`. Shared production ownership/status is in the owner's iCloud `Story Studio Agent Automation/HANDOFF.md`.

- Installable artifact: `dist/Story Studio KH 1.4.301-arm64.dmg`, 242,948,066 bytes, SHA-256 `92b9343fab1e64a7d6f9a837297948cd11aa1ea1a49025db57922909be560a5c`; built from main source `3c09ebd6`. Gateway's published descriptor matches the version, bytes and hash. Unsigned/ad-hoc local-fleet build, not Developer ID notarized.
- Recovery: old build folders are retained at `_trash/build/pre-1.4.301-20261013-002115/`, old DMG under `_trash/dist/`, verification scratch under `_trash/release-c801zI` and `_trash/release-jAbHPn`. Main's ignored code-only graph was refreshed from the verified same-source extraction.
- Live follow-up: let non-resumable work drain normally. After the mini reports 1.4.301, reconcile existing SS0063 retry `1810f225` before any retry and continue DL0011 once using its saved approved plan; no paid regeneration or repair-coverage. External release receipt: `~/Developer/_orchestra/codex-takeover-20261012/story-release-1.4.301.json`.

## Earlier preparation — 2026-10-12 (1.4.301 thumbnail Block by default)

- `thumbnail_present` default block; `retired_media` protects text says it costs money; `job-queue.ts noteCurrentJobSafetyWarning` (genstudio-client `currentJobSafety` Warn → live job `result.safety_warnings`); `upload/publish.vue` reads `/projects/:slug/safety-checks` (`thumbnailRequired`). Refused by the permission system (owner approved, not built): unlocking the 14 Video Assembly / scene-picture checks, the 5 Warn defaults, manual-route / readiness / picture-step switch reads.

## Current work — 2026-10-12 (1.4.300 safety checks: Off / Warn / Block per channel)

Owner approved (direct, relayed verbatim by the coordinator): loudness off; a switch for every check. Inventory: `_orchestra/audit-20261012/safety-checks/CHECKS.md`; worker brief `BRIEF-WIRING.md` there.
- `services/safety-checks.ts`: `SAFETY_CHECKS` (id, group, name, protects, default, `locked` + `locked_reason`), `safetyMode(slug, id)`, `safetyModeFromConfig`, `safetyGate(slug, id, job, message)` (Block throws nonRetryable; Off/Warn log, Warn adds `result.safety_warnings`). Config `safety_checks: { id: mode }` (only changed rows). `services/scene-timeline-integrity.ts` has `safetyCarriesOn` for gates whose Block must keep a retryable error.
- Routes (routes/settings.ts): GET/PUT `/projects/:slug/safety-checks`, POST `/safety-checks/apply-to-all`. UI: `components/SafetyChecksSettings.vue`, Settings section `safety` (`#safety`); Video Assembly loudness note links there.
- Loudness: `LoudnessTarget.check` (absent = block); `channelLoudnessTarget` and `generateVideo` read `safetyMode(slug,'loudness')` (default off). `levelAndCheck` re-measures an unreadable encoded check once; unreadable or ≤ −69 LUFS still stops. `verifyFinalLoudness` same.
- New Block checks: `silent_narration` (`levelMergedAudio` with `slug`), `valid_video` no-sound in `youtube-upload.ts` (fast ebur128 without true peak). Upload test fixtures now use `tinyVideoWithSoundBytes()`.
- Wired areas (see commit messages safety/pipeline, safety/audio, safety/plan, safety/upload). Locked / not switchable yet: Video Assembly + scene-picture checks (the worker for that area was refused by the permission system), gateway_key, model_available, narration_script, ffmpeg, upload_quota, paid_not_repeated, model_limits, narration_parts, merged_audio_made, private_upload, not_on_youtube.
- Known gaps: manual `POST /generate/metadata` (routes/scripts.ts) and manual Audio Assembly route still apply the old chapter-marks / chapter-audio refusals; Upload Center page still disables Upload with no thumbnail; picture steps call `assertSubtitleTimelineComplete` without a job; readiness surfaces (`asset-status.ts`, `routes/video.ts`, `routes/scene-plan.ts`) still use the fixed 30 s gap.

## Current work — 2026-10-12 (1.4.299 channel singer)

- `LyricsSettingsSchema.singers` (≤ 3 × `{name, voice, seed}`, optional = off). `song-pool-generate`: `singerFor(brief)` = `singers[brief.seed % n]`; request prompt = brief prompt + `, ${voice}`, seed = the singer's (a retake uses `hashSeed(...take n)` and says the voice may shift); `SongRecord.singer`. Writer gets `lyrics.fixedSinger` → one extra user-prompt line: style = genre/instruments/mood, no voice words. Owner-approved recipe: seed 777777 + "warm smoky female alto vocal, clear diction, gentle vibrato" (yue2-samples same-singer test). UI: Music Formula Singer rows (Add Singer, default seed 777777). Test: `lyrics-flow.test.ts` (singer).

## Current work — 2026-10-12 (1.4.298 no zero-length scenes after re-align)

- `services/scene-plan-reconcile.ts` runs `removeNonRenderableScenes` after `reconcilePlanToSubtitles` (words carry their cue's start, so two scenes in one cue anchored to the same second). Test: `video-small-overlap-repair.test.ts` (last).

## Current work — 2026-10-12 (1.4.297 new section joins the audio selection)

- `generators/audio.ts` `selectNormalAudioSources`: a replacement for a slug with no `audio_chapters.json` row appends `{ slug, source_file(s) }` instead of refusing; Audio Assembly (next in the chain) times it. Test: `audio-chapter-parts-partial-rerun.test.ts` (last test). `audio-versions.ts useChapterTake` (manual take switch) still refuses a missing row.

## Current work — 2026-10-12 (1.4.296 lenient by default)

Owner 2026-10-12: "Maybe we are being too strict? Imperfection is often accepted. I'm very lenient." Guards now self-heal; hard stops kept: missing/silent audio, missing video, loudness beyond 20 %, anything public. Brief + evidence: `_orchestra/audit-20261012/lenient/`.
- Scene Plan drift: `services/scene-plan-reconcile.ts` `reconcileScenePlanTimings(slug, ep, { auto })` now re-stamps `source_timeline` (from the transcript cues) and `source_merged_audio`; `auto` refuses when plan end vs narration differ > 10 % (`AUTO_REALIGN_MIN_COVERAGE`). `realignDriftedScenePlan` is called from `generators/scene-plan.ts` ordinary continuation: caption drift, merged-audio drift, missing stamp and "does not cover" throw `realignable()`; the read is retried once after re-aligning. Pacing/opening/invalid-row refusals unchanged.
- Video Assembly (`generators/video.ts`): `repairableTimingOverlaps` has no size limit; overlaps or `audio_stale_reason` with a job → reconcile (auto) then rescan; stale pictures are logged and used (`scene_plan_coverage.ready` counts approved stale scenes); `scene_plan_timing.complete` no longer needs zero overlaps / no audio drift. `reconcilePlanToSubtitles` never moves scene 1 later.
- Narration: `assembleUnifiedNarration` lists a chapter number once (.md + .docx twin doubled mineepod EP0003–EP0005); `parseNarrationDocx` keeps the first section per slug; `selectNarrationSections` de-dupes. Audio activation: a section with incomplete replacement evidence is activated when every file is non-empty, decodes, `duration_s > 0`, `lufs !== null` and was not recorded under another voice model (`generators/audio.ts`).
- Images (free fleet only — `studio-hub::` model): `tryRecoverImageFromManifestEntry` turns an unconfirmable free request into `terminal-failed` (fresh identity); continuity-render's one-request guards skip free fleet; on the last automatic try a still-failing scene keeps its own earlier picture or copies the nearest neighbour's (≤ 10 % of scenes), `rendered_prompt` = neighbour's so Scene Review flags it.
- Writing: `genstudio-client.ts` `lostChatRequest`/`resendLostChat` — a chat job with unknown outcome / uncertain submission is resent ONCE under `story-chat-resend-<hash>` (live send, Retry replay, saved-key recovery, uncreated recovery); never a resend of a resend, never a capped paid replacement; `job-queue.ts` `noteCurrentJob()` logs it.
- Not built: queuing a quiet regeneration for stale pictures (Scene Review marks them); automatic whole-timeline rebuild when nothing is approved.

## Current work — 2026-10-12 (1.4.295 scene pictures low priority; listen-back 70 %)

- Owner's standing rule: thumbnails priority, scene images ALWAYS low, songs between; one generation per Mac. `ImageGenerationRequest.priority` / `GenStudioImageRequest.priority` (`'background'`, not in the idempotency key) is sent as the Gateway `priority` field. Set at the scene-picture call sites only: `generators/images.ts` (scene loop), `scene-image.ts`, `continuity-render.ts`, `image-pool-generate.ts`. Thumbnails, composition templates and previews stay normal. Gateway background = only idle Macs, never ahead of waiting normal work (`worker._background_room`); a background submit counts every waiting job against `max_queued_jobs` (429 with Retry-After when full).
- `STARTING_LYRICS.min_match` 0.7 (samples scored 96–99 %). Test: `lyrics-flow.test.ts`.

## Current work — 2026-10-12 (1.4.294 songs with lyrics)

Plan: `_orchestra/audit-20261012/lyrics-flow/PLAN.md`. Off on every channel until the owner picks one.
- Switch: `songFormula.lyrics` (`LyricsSettingsSchema`: `enabled`, `language`, `min_match` 0..1, `max_takes` 1..5, `in_description`), optional = off; `STARTING_LYRICS` (min_match 0.5, 3 takes). Edited on Music Formula ("Songs with lyrics").
- Briefs (`song-brief.ts`): with `ctx.lyrics` the writer uses `SYSTEM_SUNG` (originality rules), `SUNG_BRIEFS_PER_CALL` = 4, asks `sectionsFor(length_s)` sections (30 s each, 2..12); `checkBrief` requires a style line and ≥ 2 `[Section]` markers and checks `never` words in style + lyrics; prompt = `assembleSungPrompt` (style, BPM, key).
- Generator (`song-pool-generate.ts`): `sung` ⇒ model must sing (`requires_lyrics`/`supports_vocals`), `check_model` required (dialog: free `price_source: local` transcription models), request `instrumental: false` + lyrics, length from `musicDurationPlan`. `listenBack` → `transcribeWithGenStudio` (quote > 0 refused in `beforeConfirm`) → `lyricsMatch` (`services/lyrics-match.ts`, in-order LCS of words / lyric words). Under `min_match` with takes left: `sp.trashPoolFile` + retake (`:take<n>` identity, `hashSeed` seed). Final take kept `enabled: false` with `lyrics_check` `failed`|`unchecked` (no `lyrics_match` when unchecked) and the item fails loudly with `retry_scope` set.
- Episode side: `episodeLyrics`; `musicMetadataContext` says how many songs are sung; finalizer adds `<!-- youtube:lyrics:start -->` block (`renderLyrics`) when `in_description`; upload strips the marker (`upload-metadata.ts`); `fitYouTubeDescription` trims it from the end first.
- Window: `musicWindowSizer(..., { normal: sung })` — sung songs are normal priority (owner 2026-10-12: scene images are low priority, songs take their turn), window = the row's `fleet_cap` if the Gateway sets one, else `eligible_macs`. Instrumental top-ups unchanged (background). Gateway 0.2.171 has no default YuE2 cap (owner-settable `models` in provider-concurrency.local.json); Hub 0.6.168 fixes the YuE2 package (missing `LICENSE`). Tests: `lyrics-flow.test.ts` (mock Gateway gained `transcriptionQuoteCredits` and per-scenario transcript text).

## Earlier — 2026-10-12 (1.4.293 idea generator phases 2–3)

Plan: `_orchestra/audit-20261009/ideas-plan/PLAN.md` ("Built" note at its end). Builds on 1.4.285 (see below).
- `idea_upgrades` gained `variety_seeds`, `grow_packs`, `real_sources` (booleans, off) and `reference_categories` (string[], normalised to `Category:X`). `semantic_dedupe` now accepts `on`: in `generateIdeaCampaign`, after the Jaccard `filterGenerated`, `watchDuplicates` runs on what it kept and drops hits when the method is `meaning`; on any embeddings failure only the word check decides (logged). Imports still only report (`watchImportedIdeas` runs for shadow and on). Stats gain `rejected_meaning`, `packs_used`. Default `semantic_threshold` 0.84 (replay: `ideas-plan/calibration-20261012-na-history.txt`).
- #4: `varietySlots`/`renderVarietyBlock` in `freeform-idea-generation.ts`, appended to the freeform campaign prompt; each new idea stores `idea_dimensions.variety_seed`. Pack path: `planIdeaAssignments({ spreadPacks })` interleaves each planning round across packs (`spreadAcrossPacks`); fingerprints unchanged.
- #3: `services/grown-pack.ts` (file `.topic-packs/grown-<slug>.json`, a normal legacy user pack, never in `topic_pack_ids`; `withGrownPack` appends it in the campaign and in `computeIdeaSupply` only while `grow_packs` is on; Remove → `grown.rejected`). `services/topic-pack-grow.ts`: `growTopicPack` (helper model via `callHelperModel`, slug + meaning ≥ 0.90 dedupe against packs, grown, rejected and covered subjects, ≤ 40, fails with nothing written), run log in app-settings `idea_grow_runs` (last 10), `runAutoGrow` on the existing hourly tick in `electron/main.ts` (below `low_unused_subjects`, once a local day, stop + one alert after 3 runs < 5). No job type on purpose: a run is one helper call, the route answers synchronously.
- #5: `services/reference-pool.ts` (`projects/<slug>/reference-pool.json`, `generator=categorymembers&prop=description|pageprops`, ≤ 1 req/s, 429/503 backoff ×3, 7-day cache, cache on failure, ≤ 500 items; UA `StoryStudioKH/1.0 (idea reference lists)`). AGENTS.md §7 names it as the one-endpoint exception. Grow offers ≤ 150 unused articles and keeps only names on that list (source `wikipedia:<Category>` + URL); freeform campaigns get `REAL SUBJECTS YOU MAY USE` (3 × batch).
- Routes: `GET /projects/:slug/ideas/grown`, `POST …/ideas/grown/grow`, `POST …/ideas/grown/remove {subject}`, `POST …/ideas/reference-categories/suggest`, `GET …/ideas/reference-pool`, `POST …/ideas/reference-pool/refresh`. UI: `IdeaQualitySettings.vue` (3 new sections, categories textarea), `IdeaSupplyPanel.vue` (Grown subjects list).
- Tests: `idea-upgrades-p2.test.ts`, more in `idea-upgrades-campaign.test.ts` (meaning `on` via an embeddings proxy in front of the mock Gateway).
- Pilot: night-atlas-history only (owner 2026-10-12: "Do it") — see the plan's Built note for its settings. Every other channel at defaults. Not built: supply table in the daily digest.

## Current work — 2026-10-12 (1.4.291 backup and restore)

Delivery: `_orchestra/audit-20261009/story-backup/DELIVERY.md` (file inventory, sizes measured on the mini).
- `services/backup.ts`: `scanSources` classifies every file (records / `final_videos` / `narration_audio` / `all_thumbnails` / left out). Library walk: channel folders (have `project.json`) keep everything outside `episodes/` except `Exports` videos (opt-in), `_trash`, `.cache`, `cache`, `uploads-in-progress`; inside `episodes/` every non-media file is a record, media only for the upload thumbnail (pinned in `upload_metadata_overrides.json`, else the upload picker's choice), `living_masks/`, `img2img-references/`; Story-named audio/video/thumbnail subfolders feed the opt-in categories. Dot-stores and `_Project Assets` at the Library root are kept. App-wide = `APP_STORES` in the data folder plus `app-settings.json` written through `sanitizeAppSettings` (secret keys and `MACHINE_SETTINGS` removed). `config.json` is written through `sanitizeChannelConfig` (legacy `*_api_key`). `secrets.json`/`app-secrets.json` never copied.
- `runBackup`: copy to `_partial/<sha1(rel)>` with streaming sha256, fsync, utimes = source mtime, rename. Unchanged = same size + same mtime second on the drive. Replaced/removed copies → `_versions/<stamp>/`. Manifest checkpointed every 15 s (`complete:false`, previous entries kept) and written atomically at the end; removals are skipped on an interrupted run and under unreadable folders. The only delete is `pruneVersions` (route refuses automation keys, needs `confirm:true`).
- `restoreBackup`: refuses a channel that exists unless `replace` (then moved with `moveToTrashSync` to `<target>/_trash/<slug>/replaced-by-restore-<stamp>`, listed on the Trash page); shared/app files that exist are kept; `jobs.json` keeps terminal jobs only; app settings merged key by key (never overwriting) via `setAppSetting`; an empty `content-packs/state.json` is replaced (moved to `<Library>/_trash/_story-studio/restore/`, or the app trash across drives). `<Library>/_trash` is skipped via `TRASH_DIRNAME`. `use_as_library` → `setLibraryRoot`.
- `services/backup-runner.ts`: one task at a time (plan/backup/verify/restore), `/api/backup/status`; settings in app-settings `backup`; auto tick every 5 min from `electron/main.ts` (`autoBackupTick`: drive present, queue idle, 24 h since last complete or drive replugged, 1 h between unfinished auto attempts).
- UI: `BackupPanel.vue` (Settings → This Mac → Backup & restore), `RestoreFromBackup.vue` (also on `welcome.vue`). Tests: `backup-restore.test.ts` (end to end), `backup-routes.test.ts`.
- Not built: encrypted secrets export (Keychain-bound; owner signs in again). Files referenced from outside the Library by absolute path are not followed (Make channels self-contained first); a channel with `media_root` keeps its upload thumbnail on that drive, not backed up.

## Current work — 2026-10-11 (1.4.290 effects E2–E4: picture-aware moves and effects)

Plan: `_orchestra/audit-20261009/effects-plan/PLAN.md` ("Vision engine (shipped)" is the contract). Delivery: `_orchestra/audit-20261009/story-effects-e2e4/DELIVERY.md`. Engine: Hub 0.6.166 `vision-mlx` + Gateway 0.2.167 `POST /v1/vision/analyze`, `GET /v1/vision/models`.
- Client `lib/scene-vision-client.ts` (NOT `lib/vision-client.ts`, which is the chat-vision B-roll client). Test seam `_setVisionFetchForTesting`.
- `services/scene-analysis.ts`: switches `config.scene_analysis {depth, vision}` (per channel, off); models app setting `scene_analysis_models {depth, vision}` (empty = nothing runs). Cache `<episodeDir>/scene-analysis/<scene>.json` + `.depth.png` + `.<region>.png` (map size ≤518 px); valid while the still's SHA-256 matches; `models.depth/vision` recorded, a different pick → `tasksNeeded` re-asks, the old entry stays in use. One request per picture, 640 px JPEG q80, `source_job_id` from the image folder's task manifest, `priority: background`. Regions asked: sky water clouds fire ground grass tree plant (Hub outlines only what its caption names). Refinement in `saveAnalysis`: sky = depth-trim (median+0.06) + colour-trim + joined to the top; water = colour seed, nothing nearer than its row (reeds), grown by colour below sky edge +15%; fire = bright/warm/saturated pixels inside Florence's fire outline (or anywhere if the caption names fire); glow = soft falloff round flames; plants = tree∪grass∪plant minus sky/water, green only; horizon = strip 6–20% below the open-sky edge. Quality: depth range <0.15 unusable; subject box 2–70% and score ≥0.35 else depth subject; masks 2–85% (fire 0.05–25%).
- Runner: in-process queue (`queueSceneAnalysis`, 2 in flight, 503 → Retry-After ×3 then partial), NOT a Jobs-page job (ponytail note in the file). Triggers: Scene Review approve (`routes/scene-review.ts`), auto-approved scene images (`generators/scene-image.ts`), Effects Library "Analyse Scenes" (`POST …/effects-library/:ep/scene-analysis`), model change (`PUT /scene-analysis/models` → episodes analysed in the last 14 days).
- Moves: optional motion fields `depth {parallax_pct, direction}`, `rack {to, max_sigma_px}`, `aim {mode, target?, path?}` (absent on every older motion). `resolveVisionMotion()` is the one place that fills `aim.target/path` and chooses fallbacks (used by `prepareSceneClips` and both previews). Aim = `aimProgress()` in plan and zoompan (`+iw*dx*progress`); tour = plan only (`tourCentre`, 2%/s cap). Depth moves are a scene-stage pass in FFmpeg on the camera clip (`compileDepthStage`: depth map carried through the same camera move like an outline; eq of `t` + static lut/lut2 + displace, crop the margin; rack = maskedmerge of the clip and one gblur copy by |d−f(t)|). Native helper unchanged (v1). Depth only when the episode has transitions (Q9).
- E4: `follow` on any overlay (`FOLLOW_REGIONS`), `region.auto` (file in scene-analysis/). `resolveSceneStage(..., { found })`: hand outline `<scene>-<name>.png` wins, then found, else `keepsBand()` (not analysed → own band; analysed and absent → left out; fireflies outdoors with no plants → band). Living Picture label → part via `autoRegionFor`. Masked loops bake at band 0–1 (one bake shared); stars/shimmer use the found band.
- Catalogues (`video-editor/animations/catalog`, `effects/catalog`, effects-library GET) hide moves/effects the channel's switches do not allow (`offeredWithSwitches`); families are trimmed to offered members. The AnimationPicker preview of a picture-aware move redirects to the gallery clip.
- Gallery samples `electron/server/effects-gallery/` (extraResources → `effects-gallery`): `sample-river.jpg`, `sample-firepit.jpg` + their `scene-analysis/` made by the live engine on 2026-10-11 (re-make: analyseScene on those files). Tests check the hash still matches.
- Free Up Space category `scene_analysis` (uploaded episodes; through `trashRootFor`/`moveToTrashSync`).
- Golden: `effects-e2e4-off-golden.test.ts` vs `fixtures/effects-e2e4-off-golden.json` (captured from 1.4.287). Tests: `effects-e2e4.test.ts`.
- Known limits: Florence-2 Base outlines vary run to run (the same river picture gave sky 18–40% before refinement); at night far hills, mist and water share colour and depth, so water can include the mist band; a small flame the caption does not name is not found. Large is switchable in Settings when installed.

## Current work — 2026-10-11 (1.4.289 one Trash + Free Up Space progress)

Owner report 2026-10-11: per-channel `_trash` folders (17 channels to visit), and Free Up Space failing / no progress / "Verifying…" stuck. Delivery: `_orchestra/audit-20261009/story-trash/DELIVERY.md`.
- One Trash: `lib/trash-move.ts` is the only place a trash path is built. `trashRootFor(anchor, projectDir, slug)` = `<Library>/_trash/<slug>` when `anchor` is on the Library's drive (stat dev; path prefix when it does not exist), else `<anchor>/_trash/<slug>` (rename never crosses drives). `moveToTrashSync(file, target, kind)` appends `{id, from, to, kind, at}` to the trash folder's `.trash-index.jsonl` (Restore reads it). App-level: `_story-studio/<bucket>` (launch-agent plist; EXDEV → old `<data>/_trash`), Character Library: `_character-library/<id>/`. Guard test `universal-trash.test.ts` fails on any new `'_trash'` path literal outside the helper.
- `services/trash.ts`: `trashRoots()` (Library trash + other-drive media/exports trashes + an unmoved `<channel>/_trash`), `listTrash()` (per channel, per kind, items; legacy rows not restorable; an "older" row per channel for un-indexed bytes), `restoreTrashItem(id)` (refuses when the old place is taken). Routes `routes/trash.ts`: `GET /trash`, `POST /trash/restore`. Page `frontend/pages/trash.vue`, linked from the sidebar and home. **Superseded 2026-10-16 (owner, mini managed remotely):** `emptyTrash()` and the typed "EMPTY TRASH" section are gone; `POST /trash/empty` answers 410. The only permanent delete is `POST /trash/delete-permanently` (`deletePermanently`: index entries of the Library `_trash` or the app's own `<data>/_trash` only, `safelyInside` containment, no symlinks; body `{ids|'all', confirm: true, expected_count, expected_bytes}` must match what is measured or 409; never on a timer). `POST /trash/macos-trash` hands items to Electron's `shell.trashItem` (503 without Electron, no fallback) and needs the same `expected_count`/`expected_bytes` match. Both are owner-only: 403 for any automation key, and 403 unless `isOwnerRequest` (auth-session.ts) sees a valid `ssk_session` cookie or the per-boot `x-story-owner` secret that main.ts adds to the app window's own `/api/trash/` requests (a keyless loopback request is NOT the owner). Restore, Mac-Trash move and delete run through one promise chain (`serial`). Delete appends the `removed:'deleted'` line before `fs.rm`; if the rm stops partway, a `partial` line keeps the remainder listed and deletable but never restorable. The page has a "Free up space" card (total, items, oldest) with both actions for selected items or all. `<data>/_trash` is a listed, indexed root (no slug; all of it is the `_story-studio` channel, by bucket), so old app copies and downloads there can be deleted remotely when the Library is on another drive.
- Migration `migrateLegacyTrash()` runs at every boot (boot/migrations.ts): `<channel>/_trash` → `<Library>/_trash/<slug>/legacy` (one rename, or child by child with suffixes when legacy exists), `<anchor>/_trash/<slug>` on the Library's drive → `legacy/from-<anchor name>`, `<data>/_trash` → `_story-studio/legacy`. rmdir only when empty. Log: `<Library>/_trash/trash-migration.log`.
- Free Up Space: `relevantActiveJobs` = the episode's own queued/running/paused jobs only (was: any running Video Assembly on the Mac → every check failed on the mini, which always renders). `holdVideoAssemblyStarts` deleted. Preview = pass 1 listing (stat only; `sha256` filled lazily in `mutateReviewedFile`), pass 2 `verifying` finals (bytes progress). Operation fields `bytes_done/bytes_total/detail`. Identity re-check is size+mtime (+ the sync lstat/realpath check before the rename); archive mode still re-reads every byte. YouTube calls wrapped in `withTimeout` (`STORY_VERIFY_TIMEOUT_MS`, 60 s); hashing aborts after 60 s without a chunk (`STORY_HASH_STALL_MS`). Proofs use `resolveYouTubeSourceRevisionCached` (one read per final).
- Clear Uploaded Videos: `POST /projects/:slug/storage/bulk-cleanup-final/start` → `startTrackedCleanup` (same registry as media cleanup; `final_cleanup` holds the CleanupResult). The old synchronous route stays for API callers. Skipped items are now counted.

## Current work — 2026-10-11 (1.4.288 Scene Plan must reach the end of the narration)

Mini incidents: AF EP0136 Video Assembly "984.1s of narration has no planned scene"; BW EP0040/41 "1070.1s / 1199.1s … no planned scene"; BW EP0049 recovery "Unknown image model: flux-2-klein".
- Root cause, EP0136: plan built 2026-08-31 from 514 s of captions (188 cues); narration redone 2026-09-11 to 1505 s (333 cues). `inspectScenePlanCoverage` measures against the plan's own `total_duration_sec`; `plan_stale_vs_stitched` compares file mtimes and the plan file was re-saved later. Nothing compared the plan with the real narration until Video Assembly.
- Root cause, EP0040/41: July LLM-windowed plans (deepseek-v4-flash, 6/7 windows) reached the end but had zero-length rows at window seams (EP0040 #146 at 953.4 s, #162 at 1054.8 s; EP0041 #161 at 975.0 s). One zero-length row makes coverage `invalid-timing` with `blockingUncoveredSec = total`, which Video Assembly printed as "the whole narration has no planned scene". Not truncation and not chunking.
- `lib/scene-plan-timeline.ts`: `readNarrationRecord` (merged-audio completion record, else stitched `.srt.json` meta) and `planNarrationShortfallSec` (lead-in aware). Used by `asset-status` (scene_plan not done when short > `COVERAGE_FAIL_SEC`) and `runScenePlanJob` (non-retryable stop before any prompt with `attention: scene_plan_rebuild`).
- `routes/ideas.ts`: `video_ready` needs `scene_plan` as well as `scene_review` (scene-plan visual source). `routes/pipeline.ts` preflight: a Video-Assembly-only run is refused with `missing_prerequisite requires: scene_plan` when Scene Plan is not done (the single-step bypass skipped all prerequisites). On 2026-10-11 no episode on the mini was video_ready with scene_plan false, so nothing already queued changes.
- `generators/video.ts`: zero-length scenes are named as such.
- `services/genstudio-model-migration.ts`: `RETIRED_IMAGE_IDS` maps `flux-2-klein` → `studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit` (all image generators resolve through `resolveImageModelConfig`).
- Fresh timelines cannot be short: they are cut from the captions without an LLM and the last scene is stretched to max(last cue, merged audio).

## Current work — 2026-10-11 (1.4.287 effects E1 + Living Picture follow-ups)

Plan: `_orchestra/audit-20261009/effects-plan/PLAN.md` (phase E1 = no model; owner decisions at its end). Delivery: `_orchestra/audit-20261009/story-effects-e1/DELIVERY.md`.
- Bedtime dimming is an Effects Library overlay kind `bedtime-dimming` (not a request field): selectable per channel in Video Assembly's effect list (project look) or per episode. `runFinalComposition` pulls it out of both stack halves and draws it after the classic lens/letterbox, before the frame/old overlays/captions/logo, with `timeline` = the story span (intro excluded when the effects gate excludes it, held through the tail). eq of `t` only: contrast 1−d with brightness −0.437·d (exact luma scale above tv black), gamma_r/gamma_b ±0.75·warmth, saturation. Skipped (logged) when the story is under 10 min.
- Motions: optional `float` field on `SceneMotionDocument` (absent = old documents byte-identical); `floatOffset()` is the one formula for the zoompan terms and the native plan; `resolveSceneMotionDocument` adds `sceneIndex` to the seed. Family "Handheld float" (`float-gentle`, `float`), 103% base, 0.3% breath, never rotates.
- Transitions: `TransitionDef.engine` (`clip-ramp` ramp `blur|dip`, `matte` bleed `ink|watercolour`); `planTransitions` adds `ids` only when an engine id is present; `buildEngineTransitionFilterComplex` (lib/transition-filters.ts) builds a chunk with ramps/blur/maskedmerge+concat and the same frame count as the xfade chunk (tested on real FFmpeg). All inputs get `settb=AVTB` and bt709/tv tags (a differently tagged matte made FFmpeg convert its planes as chroma — the bleed became a ghost). Mattes come from `createBleedMatte` (effect-loops.ts), baked by `bakeTransitionMatte`. Engine chunk failure → that chunk re-renders with `fallbackXfadeKeywords` and a log line.
- Overlays: loop variants `aurora, moon-glow, sky-clouds, caustics, window-drops, paper, film-dust` (band versions); sprite variant `shooting-star` (SPRITE_VARIANTS, not an atmosphere variant) + kind `shooting-star` (overlay x/y/enable expressions of `t`; star start rounded to whole sprite lives so the looping sprite is at frame 0; `shootingStarAt()` is the JS mirror, parity-tested on real frames). `bloom.color_hex` optional (halation). Presets `bloom-gentle`, `water-shimmer`. LOOP_BAKE_VERSION stays 1: old loops are pinned apart from E1's.
- Living Picture: motions `fire` and `fire-glow` (mk2.sh fire section); `outline` param + wide resolution in `resolveSceneStage(file, library, { scenes, outlines, projectLook, notes })` — project look / whole episode / theme living pictures move every scene with `<scene>-<name>.png`. Outline drawing: `OutlineDrawer.vue`, `POST …/outlines` accepts `shapes` + `feather_px`. Gallery refresh now drops the Living Picture tile (`effectPreviewStageKey`). Effects Library gains a Transitions tab; exact preview accepts `transition_id` (`renderTransitionPreview` in routes/video.ts, also used by `preview-transition` for engine transitions).
- Golden: `effects-e1-off-golden.test.ts` compares every pre-E1 motion/overlay/transition/stack/look with `fixtures/effects-e1-off-golden.json` captured from 1.4.285. Other tests: `effects-e1.test.ts`, additions in `living-picture.test.ts`.
- Not built (E1): exact preview "at 10/50/90 %" for dimming (the gallery clip ramps in 6 s instead); watercolour pale edge bloom (matte only blends); real refraction for drops. E2–E4 (depth, Florence-2) next.

## Current work — 2026-10-11 (1.4.285 idea generator phase 1)

Plan: `_orchestra/audit-20261009/ideas-plan/PLAN.md` (owner decisions at its end). Phase 1 = #6 supply counter, #1 covered-topics map, #2 meaning check in WATCH-ONLY mode, plus Free Up Space "Full-quality audio of uploaded episodes" (`master_audio` category = `*.master.flac` in the merged-audio folder of uploaded episodes, to `_trash`).
- Settings: `idea_upgrades` in each channel's config.json, read by `services/idea-upgrades.ts` (all off/empty by default; `semantic_dedupe` accepts only `off|shadow` this release). Route `GET/PUT /projects/:slug/ideas/upgrades` (partial PUT; first switch-on backs up ideas.json + config.json to `_backups/idea-upgrades-<ISO>/`). Models are the owner's picks; nothing names a model.
- #6 `services/idea-supply.ts`: uses `resolveCampaignNiche` + `collectFormulaHistory` (exported from `generators/idea-campaign.ts`) and `subjectUseByPack` (planner fingerprints). `not-applicable` is never 0. Alerts: hourly from `electron/main.ts`, opt-in per channel, state in app-settings `idea_supply_alerts`.
- #1 `services/covered-topics.ts`: `projects/<slug>/covered-topics.json`, delta build 150 ideas per helper call, merge by name; helper model checked live (`resolveLivePipelineModel`), never substituted. Rendered into both campaign prompts via the existing append (`withNamesAvoidance`); empty when off, so prompts are byte-identical with switches off (`idea-upgrades-campaign.test.ts`).
- #2 `watchDuplicates` in `services/idea-similarity.ts` + `lib/embeddings-client.ts` (Gateway `POST /v1/embeddings`, Authorization header only). Watch-only: the Jaccard `filterGenerated` still decides. Falls back to wrapper-stripped Jaccard when no model / Gateway 503. Calibration (`ideas-plan/calibration-20261011.txt`): BGE-small cannot reach 90% caught at 2% false. Default 0.78 (coordinator, from BGE pairs: paraphrase ~0.84, different topic ~0.43-0.62; fixture `__tests__/fixtures/idea-meaning-calibration.json`); every candidate's nearest score is logged and stored for tuning after the pilot. Stats: `projects/<slug>/idea-campaign-stats.jsonl`.
- Import paths: paste-import, manual add and episode-folder import call `watchImportedIdeas` (the old orphan-adopt route was removed in 75c86fae, so episode-folder import is the surviving "adopt" path).
- Open: phase 2 (#4 variety, #3 grown packs), phase 3 (#5 Wikipedia). Supply table in the daily digest not done (banner + alerts only). DeepSeek channels (dozing-knight, story-sprout) stay off until the owner says so.

## Current work — 2026-10-11 (1.4.284 living pictures)

Phase E4's living pictures without Florence-2 (on hold): outlines are supplied by hand. New overlay kind `living-region` (`motion: flame|glow|steam|water|sky|pulse`, `strength` 0..3, `speed` 0.25..4; built-in id `living-region`) and an optional `region` on every overlay (`{ mask?: '<scene>-<label>.png', shapes?: ellipse|rect|polygon in 0..1, feather_px }`, `contracts/scene-effects.ts` + schema). An overlay with a region, or any living-region, is a **scene-stage** effect: `resolveEpisodeEffectStack` leaves it out of the timeline pass (note for non-scene scopes), `resolveSceneStage` lists it per scene, and `prepareSceneClips` draws it on the finished scene clip (`lib/scene-stage.ts`): the outline PNG is drawn at the still's size (`services/outline-masks.ts`), carried through the scene's own camera move by the same renderer (native helper or the FFmpeg chain), and merged on the clip's yuv420p planes (`regionMergeStatements`: full-size luma mask, half-size chroma mask) so pixels outside are bit-identical. The moving part is `compileLivingRegion` (displace maps from sine `geq` at 540 lines, scaled; `eq` flicker), ported from `_orchestra/living-mock/mk2.sh`. Outlines live in `<episode>/living_masks/`; `POST …/effects-library/:episode/outlines` validates (colour, empty, full, size, aspect vs the still) and feathers hard edges. Missing/invalid outline → effect skipped with a job-log line, never a failed render. Render fingerprint gains `scene_stage` only when a scene uses one (mask size+mtime included). Exact preview and the gallery take a `stage` argument in `renderEffectPreview`. The Metal helper is unchanged (no v3 kernels): the flow is FFmpeg on top of the native clip. Not built: a shape editor in the UI (shapes via the effects file/API only); Florence-2 auto-outlines. Tests: `living-picture.test.ts`. Demo clips: `_orchestra/living-mock/story-render/`.

## Current work — 2026-10-08 (1.4.262 publish dates follow episode order)

Owner report 2026-10-08: "I assembled 172, then 245, then 390 … now 173–176 stay behind 245 and 390." `scheduleEpisodeWithActivePlan` gave each finished episode the slot after the latest future claim, which is finish order. The fix: `upload-plans.episodeOrderShifts(claims)` (pure) hands the same future dates back out in episode-code order. The pool is `episode-autoschedule.movableLocalClaims`: future local dates of accepted episodes with no active `youtube_upload` job and no `remoteVideoFor` video on the assigned channel. An unreadable sidecar counts as not movable. Two callers:
- Auto-schedule writes its new slot, then re-deals the pool with CAS writes (`applyScheduleAssignmentsWithRollback`). The walk and the re-deal run under the Upload Center's `youtube/upload-center-plan.lock`.
- Plan preview (`previewUploadCenterPlan`) adds the shifted existing episodes to `assignments` (with `previous_publish_at`) and returns `order_shifted`. So the reviewed and fenced preview is exactly what apply writes.
No new dates are produced, so the plan horizon and "never before now" hold. Relayout is unchanged (it already assigns in code order). Story records no manual-date flag (`setScheduledFor` has no source field), so there is nothing to exempt. Publish page shows "Dates follow episode order; N episodes shifted". Tests: `episode-order-schedule.test.ts`. Two route tests that pinned "future claims stay in place" were updated to the new rule.

Also from the 1.4.261 report (`app-update.ts`): staging and download leftovers now move to Story's Trash, `<Library>/_trash/_story-studio/app-update/` (superseded 2026-10-16; the 15-day Trash Folder is gone, see below), and `_trash/app-update` is never touched. The idle gate (`queueIdle`: `maybeInstall` and `install('idle')`) waits for `QueueControl.loaded()`, which is wired to the new `job-queue.areBootJobsLoaded()`. That flag is set when `resumeInterruptedJobsAtBoot` finishes (in `finally`, so a failed scan never blocks updates forever). No queue-load signal existed before; `isBootComplete()` covers migrations only.

## Current work — 2026-10-08 (1.4.261 app update queue gate; Trash Folder superseded 2026-10-16)

**Previous app versions (owner, 2026-10-16; replaces 1.4.261's self-emptying 15-day Trash Folder):** the swap helper keeps the replaced app (and a failed new one) in `<data>/previous-apps/` (`previousAppsDir()`, env `SU_KEEP`). `keepPreviousApps()` keeps the last 2 previous versions (by `compareVersions`) and MOVES older copies and failed ones into the Library `_trash` (`_story-studio/app/`, recorded for Restore; EXDEV → `<data>/_trash/app`). `migrateTrashFolder()` first renames the old helper's rollback copies (`<date>/app/Story Studio KH.app-*`) into `previous-apps` (a day whose copy cannot go there stays put), then moves the rest of the old `<data>/Trash Folder` into `_story-studio/trash-folder/` once (renames, collision-safe names, folders removed only when empty). `keepPreviousApps` never moves the running app (`appBundle`, or the copy `process.execPath` is inside). Both run once per launch from `startAppUpdater`, never on the 30-minute timer. `purgeTrashFolder` and `TRASH_FOLDER_DAYS` are deleted, and app-update.ts deletes nothing (guard test in `app-update.test.ts`). If `previous-apps` is on another volume than the app, the old app (and a failed new one) stays beside the target as a hidden `.Story Studio KH.app-<old>-previous` / `-failed-…` and is never deleted; `keepPreviousApps` counts those copies too. Free up space's "Old app copies" line measures `previous-apps`. Also in 1.4.261 (owner, 2026-10-08, "queue the update so it starts after generation is completed and nothing is in queue"): automatic installs no longer drain. `maybeInstall()` waits, pausing nothing and with no ceiling, until `jobsLeft()` (running + queued + paused jobs, all projects) is 0; it rechecks every 30 s (`IDLE_POLL_MS`; a poll rather than `jobEvents`: the 60 s settle needs a timer anyway, the poll also sees Clear and a queue Resume, and events would gain at most 30 s), installs after the queue has stayed empty for 60 s (`IDLE_SETTLE_MS`, covers the gap between pipeline steps), and `install('idle')` re-checks right before spawning the helper. Housekeeping is not a queue job (YouTube status sync, digest scheduler, episode-recovery recheck, quota rechecks, the updater's check), so nothing is excluded; a test fails if a job type of that kind is added. Install Now and the Gateway's Update Now keep the 30-minute drain. `install_window` is retired (setting and UI). A quota-parked job is queued work and keeps the update waiting. (The old open item about staging leftovers is resolved: they go to Story's Trash, where the owner deletes them permanently from Story → Trash.)

## Current work — 2026-10-07 (1.4.260 remediation candidate)

Candidate source builds on `3e1fb6bc` / 1.4.259. Audit loading repairs skip portable normalization no-ops, bound independent path requests and audio probes, coalesce same-file duration probes, reject stale episode/path results, and invalidate signed catalogue listings on nested file changes. Boot health requests have a real 15-second ceiling; updater headers/body have a 30-second inactivity and 15-minute total ceiling and keep retryable partials recoverable. Gateway manual update commands carry an additive request receipt, persisted together with the actual verified download attempt and reported across failure/rollback/restart. An old failure cannot acknowledge a fresh command.

API key is now called Gateway API Key; the release signing key is now the App Update Key. Settings → This Mac names the connection credential; About → Updates shows the first 16 fingerprint characters and points to Gateway → Settings → App Update Key. Code identifiers and existing credential/signing fields remain unchanged.

Source gates for this source revision pass. Lint, typecheck, changelog, typography, security, model-drift and release source checks exited 0. Backend completed 631/631 files and 6,319 tests (6,315 pass, 0 fail/cancelled, 4 skip); frontend completed 294/294 files and 2,472 tests (all pass); Content Packs completed 38/38 files and 368 tests (366 pass, 0 fail/cancelled, 2 skip). The full backend log also records the configured projects root byte-identical. Evidence and the remaining delivery state are in `/build/Developer/_orchestra/codex-remediation-20261007/story-delivery-receipt.json`.

At source verification, UI and package validation were pending coordinator integration. The first retained baseline UI attempt is invalid because its synthetic profile had no configured Library and route middleware correctly redirected it to Welcome before Video Assembly mounted; the external seed/harness was corrected but had not been rerun. Current delivery status and exact commit, artifact and installation evidence are authoritative in `/build/Developer/_orchestra/codex-remediation-20261007/story-delivery-receipt.json`. At that checkpoint, the mini's read-only health check reported 1.4.259; the old pending-install note below is historical, not current evidence.

## Current work — 2026-10-07 (1.4.259 assembled)

Source release **1.4.259** builds on `cb0ce422` / 1.4.258 (its approach kept: re-narrate → transcribe repaired chapters → one Audio Assembly → local stitch) and merges, `--no-ff` in this order: `fix/retry-restart-stuck` (auto-retry per owner policy, restart resumes writing steps/uploads, install waits for running jobs, Quit asks first, stale subtitles count as missing in recovery), `feat/self-contained-channels`, `fix/done-means-done`, `fix/youtube-and-storage`, `perf/next-tier` (S1–S15), `fix/ux-sweep` and `feat/remote-update`.

Conflict resolutions:
- `episode-recovery.ts` / `audio.ts` (perf vs 1.4.258): 1.4.258's logic kept; perf intent re-applied — `currentJobs()` (with observed terminal snapshots) is a raw `findJobs` episode filter, the S12 blocked-plan input stamp / 10-min backstop and unchanged-save skip stay, `observedJobs` flows through `advance()`, 1.4.258's stamped-refresh condition is evaluated lazily inside the boot `findJobs` predicate; `queueSubtitlesAfterNarration` uses ONE type-filtered `getJobs`.
- `episode-media-cleanup.ts` / `storage-audit.ts` (youtube-storage vs self-contained): both import sets kept; the `_trash` summary still reads the external finals root (channel-local Exports trash into the project's own `_trash`).
- `board.vue`, `upload/publish.vue` (ux-sweep): both sides' board changes kept; the publish hint keeps "checked automatically every 30 minutes" (youtube-storage) over "nothing checks on its own".
- ux-sweep's Jobs "More actions" fold is **reverted**: Recover, Repair, Queue and Remove From List stay visible, never folded (owner rule 2026-10-03; `jobsControls.test.ts` asserts it).

Added in assembly:
- 1.4.258 review fixes: `recoverEpisode` takes `priorMerge`/`savedMerge` only from finished merges without `audio_quality_refresh` and strips that marker from the copied params; "Narration refresh source could not be verified…" is written once on the check job's own lines; `chapter-repair-chain.test.ts` covers re-narrate → scoped check → one merge with saved mix → local stitch (no extra ASR) plus the stale-SRT, quality-refresh and refusal cases.
- Job persistence: a jobs.json write that threw before its first await left a settled `state.writing` that was never cleared (that project's jobs.json was never written again; in tests `_waitForJobPersistenceForTesting` spun forever — `episode-recovery.test.ts` hung the gate). The drain now yields first, and a failed hydrate clears its cached promise. That un-masked an unhandled rejection from cancellation reconciliation's failure-path save, now caught at its scheduler.
- Remote updates: a quit for an update skips the "jobs are running, quit?" dialog (`isQuittingForUpdate()`); checks every **30 minutes** (plus startup and Check Now); failures remembered by release **signature** — a not-ready download (HTTP error, short/mismatched file, dropped stream; the Gateway serves whole files without Range, so the next check starts from zero) records nothing, any other install failure retries after 2 intervals, only a failed health check (rollback) skips that signature, and a re-publish is always tried.
- perf S8 lint error (`await-thenable` in pending-approvals) fixed.

Gate (worktree, final commit): typecheck exit 0. Backend exit 0, 6,438 tests / 6,437 pass / 0 fail / 1 skip, 630/630 files. Frontend exit 0, 2,472 tests / 0 fail, 294/294 files. Content-packs exit 0, 368 tests / 366 pass / 0 fail / 2 skip, 38/38 files. check:changelog/typography/security/model-drift/release pass. Lint 0 errors (1,831 existing warnings). `npm run dist:smoke` built and launch-smoked `Story Studio KH 1.4.259-arm64.dmg` (242,373,879 bytes, sha256 `12296af07a9fe84396554c78a1917662db5e010d68d0844886f4eb03104e0cd7`); release lane after the build 54/54. Not installed anywhere; the owner installs on the mini (from 1.4.259 on, the Gateway updater can).

## Current work — 2026-10-07 (1.4.258 chapter repair chain)

Source release **1.4.258** builds on `067ca170` / 1.4.257. The owner explicitly keeps **re-narrate → transcribe repaired chapters → Audio Assembly**. Standalone chapter checks validate complete, playable episode-owned source audio without requiring the full episode mix; bulk/Pipeline and whole-track transcription retain the assembly gate. Chapter-local success never proves full-episode/stitch completion. Saved source hashes govern reuse.

Narration follow-ups are deduplicated by their owned parent, and caption workers for one episode run serially so a second chapter is not lost or racing the same manifests. Existing episode recovery coalesces known chapter checks, uses prior owned mix settings, and locally restitches after assembly. Compact source/QA acknowledgements survive Clear Finished; current-source mismatches, missing accepted job identities and paid/unknown provider evidence stay fail-closed. No new ASR for unselected chapters or downstream generation is authorized by this repair.

Independent review and focused regression evidence are in the local operations receipts. Final full gates, main packaging and installed state are recorded in `<owner-home>/Developer/story-studio-operations/chapter-repair-release-receipt.json`. Existing Story Sprout repair/assembly jobs must be reconciled and preserved before install; never cancel or repeat them to demonstrate the fix. Authentication is preserved: the owner declined session-secret rotation and will handle it later. Cleanup goes to central `<owner-home>/Developer/_trash`.

## Current work — 2026-10-07 (1.4.257 assembled)

Source release **1.4.257** builds on `238a1a37` / 1.4.256 and assembles: `perf/episode-list-and-niches` (incl. `perf/scene-poll-and-streams`: paced episode-status re-audit, last list on reopen, slim job streams, skipped no-op poll/config writes, ffmpeg at nice 10 with libx264 threads capped, plain-page Back), `fix/partial-stops` (free-fleet scene prompts/images retry 60 s / 300 s, key-scoped unresolved checks, drifted free prepared images rebuilt), `fix/narration-parts-free-up-space` (narration parts kept until chosen in Free up space) and only the CSS line of `fix/free-up-space-card-width` (`.settings-content` column `minmax(0, 1fr)`; that branch's own version bump was dropped).

Added in assembly:
- `scene_plan_run` auto-retry judges the model the run actually uses: a Pipeline run's `pipeline_model_policy.scene_plan.assigned_model` (bare product id, overrides `params.model`), so Pipeline-started runs retry. **Owner decision 2026-10-07:** paid chat scene prompt runs also auto-retry with the same 60 s / 300 s delays; each retry first collects the earlier request by its saved idempotency key, so nothing is paid twice. Paid IMAGE work stays fail-closed and manual.
- Pipeline ↻, EpisodeSelector ↻ and the scripts page's cold-cache deep link now `revalidate()`; Shift-click on ↻ is the full `?refresh=1` rebuild, as on the Board. (Error-notice Retry buttons still call `refresh()`.)

Gate (worktree, before build): typecheck exit 0. Backend exit 0, 6,314 tests / 6,310 pass / 0 fail / 4 skip, 609/609 files. Frontend exit 0, 2,403 tests / 0 fail, 280/280 files. Content-packs exit 0, 368 tests / 366 pass / 0 fail / 2 skip, 38/38 files. check:changelog/typography/security/model-drift/release pass. Not installed anywhere; the owner installs on the mini.

## Current work — 2026-10-06 (local update integration)

Source release **1.4.256** builds on `a3c2e722` / 1.4.255 from the other Mac. The Production Board has native stage navigation, a keyboard-focusable scrolling region, and a separate saved YouTube publishing column/filter. Upload transitions refresh through surgical episode invalidation; historical terminal snapshots do not trigger repeated scans. Independent review found no unresolved code issues. Full backend: exit 0, 6,154 tests / 6,150 pass / 0 fail / 4 skip, 604/604 files completed. Full frontend: exit 0, 2,385 tests / 0 fail, 276/276 files completed. Content-packs: exit 0, 368 tests / 366 pass / 0 fail / 2 skip, 38/38 files completed. Typechecks pass; lint reports 0 errors and 1,778 existing warnings. Final main packaging/release-lane evidence and this Mac's current installed state are recorded in `<owner-home>/Developer/story-studio-operations/story-update-integration-plan.json`.

At recovery, this Mac was running **1.4.254** on **8766**, with **4 running scene jobs, 73 queued, and 1 paused**. The owner authorizes restart, including forced termination if normal quit stalls, for this update. Prefer the existing cooperative queue checkpoint first, retain accepted-task identities and unknown-outcome fences, back up receipts/manifests/jobs and profile, verify restored work after launch, then restore original admission through the official global Resume. Manual pauses remain explicit; stalled rows require evidence-proven recovery. History EP0005/EP0007 were queued for Finish missing images after their Gateway tasks were confirmed finished; the earlier UNKNOWN_OUTCOME evidence does not authorize bypassing reconciliation.

Installer tests now isolate their temporary trash as well as their install target. Safe cleanup for this session goes to the owner's central `<owner-home>/Developer/_trash`; retained trash is never tidied. The unrelated untracked `.impeccable/critique` file remains untouched.

## Upstream 1.4.255 — 2026-10-06

Source release **1.4.255**, based on `dcea61ad` (1.4.254), addresses the owner's unattended Pipeline workflow on the separate 2 TB Mac mini. See `docs/superpowers/plans/2026-10-06-autonomous-pipeline.md` for scope and safeguards. The installable artifact is `dist/Story Studio KH 1.4.255-arm64.dmg`; the coordinating handoff under `/build/Developer/_orchestra/` records its final build/verification status. This release has not been installed on the mini.

- Bulk preflight shares project facts and overlaps independent episode reads with at most eight workers. Start performs a fresh preflight, and admission checks current completion evidence; immutable snapshots cannot schedule duplicate paid work or skip removed artifacts.
- Scene Plan checkpoints usable rows from typed token-truncation errors. Disk-rejected duplicate/invalid IDs remain writable by missing-only repair. Ordinary repair continues when the missing count decreases and stops after two consecutive settled passes without improvement; unresolved requests, Pause, Cancel and final completion audits remain authoritative.
- Scene Review persists the exact image model and seed in task manifests. A stale free-fleet prepared reservation can be renewed only after its exact key is authoritatively absent and its original request facts validate. Paid, accepted and uncertain work remains protected. Free scene images use bounded missing-only retries and the Gateway's deadline rather than an automatic ten-minute hold.
- Evidence: owner-supplied screenshots/status log show Story **1.4.254**, 339 scenes, 34 finished, 174 prepared-request mismatch failures and 131 not submitted, followed by the automatic stall hold. Model/seed drift reproduces this error class; the exact historical discriminator needs the mini's manifest.
- Remote access: the mini's recorded server port **8765** refused connections during diagnosis; SSH stopped at host-key verification. The owner was asked for Server Mode status. Credentials were neither stored nor printed, and no production jobs/settings were changed. Do not restart/install over active mini jobs merely to verify this release.
- Installer-test safety: a temporary install target alone does **not** isolate trash. `install-local.test.mjs` now copies the real installer into a private temporary project with miniature source/target apps, and both default/overridden trash paths stay there. `STORY_STUDIO_INSTALL_TRASH` permits an explicitly isolated trash location; normal installs retain project `_trash/app`. The read-only built-bundle existence check requires the main build before the release test lane. Local incident/recovery details are in `_orchestra/audit-20261006/RELEASE-TEST-INCIDENT.md`; do not run an older installer test against real shared trash.

Older release/install statements below are historical. The cross-repo current baseline is `/build/Developer/_orchestra/HANDOFF-20261005.md`; the mini's 1.4.254 install is now confirmed by the owner's screenshots.

**Written:** 2026-09-23 · **against:** v1.4.219 · branch `codex/stabilization-takeover` @ `734ccd70` (record-only commits after this pin leave the app unchanged) · `main` @ `eced221b`

**Brought current 2026-09-28** by the coordinating session: release **1.4.235**, one change with a
long reach. **A locked model's reason is now shown verbatim instead of being replaced by a fixed
sentence about the account.** `genStudioModelLockReason` mapped every reason that was not
`requires_paid_account` to *"Locked for this GenStudio account."* — so when the fleet-hardening work
made the gateway publish a truthful outage reason (*"No Mac offering this model is reachable — every
Studio Hub location that offers it is offline or not taking customer work."*), Story would have
overwritten it and sent the owner to billing for a power cut. The paid-account sentence is unchanged
when that is what the endpoint says; a locked model with no stated reason says only that it is
temporarily unavailable, and never anything about an account. The three named call sites pass the
value through already, and a source-level test pins that no caller re-substitutes the billing
sentence. Built into an unsigned DMG at 1.4.235 and measured; the typecheck lane was **red at HEAD (fixed in 1.4.242)
before this change** (269 errors, all under `electron/server/**`, the largest block in
`content-packs/legacy-adapters.ts`) and was verified identical on a pristine `900bbffe` checkout in a
temporary worktree, so it is recorded as pre-existing rather than caused here — see *WHERE THINGS
STAND*.

**Previous release: 1.4.234**, which closed the last two reveal gaps: which closes the last two reveal gaps 1.4.232 named. **Holds now snap to narration lines and music beats** — `audio_sentences.json` is read once *before* the render fingerprint (it used to be read after, which is what made its line ends unreachable for the plan, since the fingerprint hashes the resolved plan), each scene's candidates are offsets from its own start, a candidate the scene does not cover is never offered, and **a snapped hold is exempt from the "never shorter than the window" guard** because clamping it back would silently undo the snap. **The Image Pool reveals too, and its pace changes the image count**: the pace decides how long one still stays and the play order is built from that number, so a slower pace needs fewer images to cover the same narration; the pool's scenes are rebuilt after the opening is measured, so its plan is resolved there and folded into the recovery fingerprint.

**Previous release, kept as the record: 1.4.233**, `main` @ the 1.4.233 commit, installed **1.4.233**. **1.4.233 is the correction pass the reveal work needed:** the library is **19 presets — 15 wipes, 3 palettes, 1 draw-on** — and both the 1.4.229 notes and the design document said twenty, a number the release's own receipts already contradicted (76 clips across four paces is 19 × 4). A test now pins the composition, the three reveal routes are driven over HTTP (catalogue, plan, per-scene choice), and two stale sentences are gone (the audio switch announced twice in this header, and the wrong count in the 1.4.229 summary). **1.4.232 wires the reveal effects end to end** — the engine shipped in 1.4.229 and nothing could choose one. Video Assembly now has a Reveal panel (on/off, pace, how often the look changes, an episode seed, a cap per effect, the pool of arrivals), it lists the **planned arrivals** from the same resolver the render calls, and a single scene can be rerolled with the choice saved in that episode's own scene plan. The payout is measured: **72 s from 6 images where the 5 s/image baseline needs 15 — 9 fewer, 2.5×** (`docs/receipts/reveal-episode-slow-20260927/`), and three frames sampled inside one hold differ, so it drifts rather than freezing. `kind: 'reveal'` makes presets portable Content Packs. Two limitations are named in `docs/reveal-effects.md`: holds do not yet snap to narration lines or beats (the plan is resolved before those are read, and the render fingerprint depends on that order), and the Image Pool path recycles stills on its own timing so reveals do not apply there. **1.4.231 ships the published `audio` switch end to end:** Studio Hub 0.6.83 gave its LTX lane a boolean `audio` parameter (default on, with the lane's own note), gateway-kh 0.2.60 relayed it on the video row as `controls`, and Motion Review renders a switch for every boolean parameter the *selected* model publishes — never from a family name, never from `generates_audio`, which answers a different question. The operator's choice travels in the request body, the recovery hash and the idempotency key (so a retry can never re-attach to the other half of the switch), rides in Motion Review presets, and is honoured by an unattended Pipeline run when the model it resolves publishes it. The three clip routes refuse a value the priced row does not publish, and a queued job that outlives a catalogue change drops it with a line in the job log. **A silent clip is not cheaper or faster** — the lane denoises picture and sound in one pass — and the page says so with the lane's own sentence rather than implying a saving. Measured through the installed app: `/api/app-settings/genstudio/video-models` serves the LTX row with the switch, freshly fetched. The retired `/generate/video` lane has no caller and was left alone rather than half-wired. Before that: **1.4.230** closed WIRE-3 and fixed the feature it was hiding. **1.4.230 closed WIRE-3 and fixed a feature it was hiding:** the thumbnail-reference vision picker gated on `max_input_images >= 1` and `supported_detail_levels`, neither of which any gateway publishes, so **no model was ever eligible and the feature could not run**. The gate now rests on `supports_vision === true` plus availability, the per-image limits are enforced only when a model states them, and the menu is told whose choice each number is (`detail_source` / `reference_limits_source`). `availability_reason` and `available_again_at` — never published by any catalogue since the old GenStudio — are deleted, and a catalogue refusal now carries the gateway's own `activation_blockers` into the operator's sentence. The retirement family stays published (gateway 0.2.59) and Story's surfaces for it are unchanged, ready for the first retiring model the owner actually uses. **1.4.229 ships the reveal-effects ENGINE and nothing that calls it yet** — 19 presets in three families (geometric / palette / draw-on), an FFmpeg `xfade` compiler, per-episode pacing with hold snapping, and seeded selection with the design's rules, all verified by rendering (76 clips across every preset and pace, plus a byte-identical determinism check) and 24 tests. What is NOT wired: no UI chooses a reveal, no Content Pack kind carries one, and the assembly does not use a reveal clip yet — so the image-count saving the design is built around is **not** realised in this release. `docs/reveal-effects.md` is the design of record and its last section is the next slice, in order. 1.4.228 carries the published video aspect ratio end to end: `GenStudioVideoVariant.aspect_ratio` travels in the transport, the scene-clip selector picks the row whose ratio matches the request, the request carries that row's ratio instead of a hardcoded `16:9`/`9:16`, and Motion Review derives its ratio and size options from the published rows so it cannot offer a pair no row carries. A video lane's canvases are pairs on the model's 64-pixel grid (Studio Hub 0.6.81), so `16:9` at `448p` was refused by the lane and `16:9` at `288p` came back 2:1 while the label said 16:9. This header said 1.4.225 before that (and the app on disk had been 1.4.226); it now follows the app. The pin above is the state this file was *originally written against* and is kept as that record — everything below it is current. This header had said 1.4.219 for three releases while the app on disk was 1.4.224, which is the "a stale handoff is worse than none" failure this file's own rule names.

**Read this first.** This file is the cold-start briefing for a session that knows nothing about the last one.
If it disagrees with the code, the code wins — and then fix this file. The authoritative record of *what happened
and why* is [`Story Studio Project Status.md`](../../Story Studio Project Status.md) (queue, candidate rows, review
log) plus [`docs/handoffs/deepseek-reports/`](../handoffs/deepseek-reports/) (one report per packet). Keep both
out of scope unless a task needs them.

## WHERE THINGS STAND

| Thing | State |
|---|---|
| Current release | **1.4.245 — "Free up space" findable, no folder picker.** Owner report: no button visible and 2 folder pickers. Cause: `MediaCleanupPanel` sat below "Your Library" and "Archive uploaded videos" (two folder pickers) on Settings → Files & maintenance, behind a manual "Find uploaded episodes" click, defaulting to the "archive to another folder" mode that requires Browse. Now: panel first on that tab, sidebar link + per-episode link in Upload Center Publish, auto-loads uploads, primary "Free up space for N selected" (preset `archive_episode`) with the `_trash` path (`preview.trash_roots`) and freed bytes in the review and confirm; advanced review defaults to `remove` (trash); old archive-videos box collapsed. Full `npm test` green (backend 5772, frontend 1976, release 48, content-packs 368; exit 0). DMG `dist/Story Studio KH 1.4.245-arm64.dmg` (242,046,966 bytes, sha256 `cf3c9b36e27f5c69d8a00965d74fca48b0d4fc6456698bf02d820c8de04af870`), built after the commit, NOT installed. Previous (1.4.244): **1.4.244 — "Archive episode", trash instead of delete, AAC music.** Owner decisions 2026-09-30 (Mac mini, 2 TB nearly full): generated MUSIC is stored as AAC; scene images become JPEG only through a deliberate archive after the episode's upload is confirmed; thumbnails always stay original; **nothing the app removes is hard-deleted — originals go to `_trash`, which the owner empties.** (1) `generators/music-generate.ts` `saveMusicTrack`: a RIFF/WAVE body → bundled ffmpeg native `aac` 256k `.m4a` (NOT `aac_at`: +0.125 s drift on concat); other bodies (MP3) pass through; an encode failure keeps the raw bytes under the old `.mp3` name and warns (the track is paid). Narration stays MP3, new narration 192k → 96k (`genstudio-client.ts` `completeTtsJobToFile`). (2) "Free up space" extended, not rebuilt (`episode-media-cleanup.ts`, `routes/media-cleanup.ts`, `MediaCleanupPanel.vue`): `mode:'remove'` and the storage-audit final-video clear now go through `lib/trash-move.ts` (`<projectDir>/_trash/<code>/<category>/<source_kind>/<relative>`, or `<anchor>/_trash/<slug>/…` on a media/external root — same device; a failed rename skips the file, there is no delete fallback; a taken name gets a timestamp suffix; existing trash is never touched). New `mode:'compress'`: scene images only (`thumb_dir` was dropped from every category), `sharp` mozjpeg q90 → `<name>.partial-<pid>` → decodable + same dimensions + under 80% of the original → original to `_trash`, JPEG takes the ORIGINAL filename (the app sniffs real bytes; renaming would break ~12 name checks) and its mtime; JPEGs are skipped (idempotent). Preview `preset:'archive_episode'` = images + chapter_audio + motion_clips + final_video (live YouTube proof unchanged) and stamps `archived_at` in `local_media_cleanup.json`; the panel's "Select all uploaded and not yet archived" reads it. Mini load: one cleanup at a time SERVER-wide, `sharp.concurrency(1)`/`cache(false)` for the run, refuses while any `video_assembly` job is active on the server (`jq.activeJobsOfType`). `videoSourceMediaType` now labels by real bytes (a JPEG under `.png` is `image/jpeg`). **Still hard deletes, deliberately left:** `hardDeleteSoftDeletedProject` (owner-triggered whole-project delete), the "archive to another folder" mode (verified copy, then unlink), `chunked-sidecar-cleanup.ts` `fs.rm` of resume sidecars, and scratch/temp files. Full `npm test` green (backend 5772 tests, frontend 1975, release 48, content-packs 368; exit 0). DMG `dist/Story Studio KH 1.4.244-arm64.dmg` (242,049,388 bytes, sha256 `73843827a34822a56f80864dde834427f74d346ccc23e721b533f47ab06a82ba`), built after the commit, NOT installed. |
| Previous release | **1.4.243 — real prices in the pickers, provider cost per job, and an estimate before Run Batch.** Consumes gateway 0.2.82–0.2.84 (`_orchestra/audit-20260930/CONTRACT-pricing.md`): every catalogue row carries `price_source` (`provider` \| `provider_page` \| `local` \| `unpublished`), `price_usd` (by unit), `price_as_of`, and for `provider_page` a `price_url` plus `price_variants` (`usd` or the page's own `unit_text`). **The zero `credits_*` fields on those rows are parser shapes, never prices** — every `describe*Rate/UnitCost` in `frontend/utils/genstudio-credit-cost.ts` asks `describeUsdPrice` (`frontend/utils/genstudio-price-usd.ts`) first and a row with no `price_source` (older gateway) keeps the credit display exactly as before. Parsed once by `parseGenStudioPriceTruth` (`electron/server/lib/genstudio-client.ts`), spread into the six row parsers (chat, image, video, tts, transcription, music); malformed truth is never read as free. Display: provider → `$0.075 / 1M input tokens · … · as of 2026-09-30`; page → `… · from pricing page, <date>` + link (`PriceDetails.vue`, http(s) only) + a "Varies:" list, never picking one; `local` → *Free — your fleet*; `unpublished` → *Price not published* (basis `not-published`, neutral, not styled as a warning). Audio's "minimum N credits" and Motion Review's "Listed cost N credits" are hidden for such rows (they were the zero shapes). Job `cost_usd`/`cost_source:"provider"` is carried into `genstudio_jobs` (`providerCostUsd`) and shown in the Jobs ledger; absent prints nothing. **Run Batch estimate** (pipeline.vue, `estimateBatchUsd`): only steps whose unit maps to something Story Studio knows — `scene_review` per_image × scenes still to render (all with Force), `motion_review` per_video × scenes — and local steps are free; everything else (token-priced chat steps, thumbnails/audio quantities, unpublished, per_second, variants-only rows, model policy overrides) is listed as *not included* with its reason. Labelled an estimate; no new gateway call (prices are on the rows the pickers already load). Tests: `electron/server/__tests__/genstudio-price-truth.test.ts`, `frontend/__tests__/genStudioPriceUsd.test.ts` (estimate arithmetic mutation-proved: `×`→`+`, dropped unknown-quantity guard, dropped unit mapping, dropped scene-count guard, dropped variants branch each go red). ⚠ `npm version` round-trips `package.json` and strips the `\u2014` escape in `description` — restored by hand (source-manifest-integrity guards it). Known flake under full-suite load: `audio-subtitle-explicit-regeneration.test.ts` (passes alone 3/3). Lanes: backend **5756 / 5755 pass / 0 fail / 1 skip** (529 files), frontend **1974**, release **48**, content-packs **368 / 366 pass / 2 skip**, typecheck green, lint 0 errors. DMG (unsigned, not installed, drives not refreshed): `dist/Story Studio KH 1.4.243-arm64.dmg` (242,039,503 B, sha256 `2309606d350ba7c72c1b739ebea1b215fb15e0f1e9d03d40423df24d84caa888`). Not done: the chat-completion (synchronous) envelope's cost, Web Research credit rates (separate fields), Motion Review's per-scene USD. **The release before it:** **1.4.242 — typecheck is green (was 269 errors) and is now part of `npm test`.** All 269 came from ONE edge: `models/types.ts` typed `GenerateVideoRequest.scene_reveal` as `import('../lib/reveal-assembly.js').SceneRevealSettings`, and `reveal-assembly` imports `style-effect-loader` → the whole server; `frontend/pages/projects/[slug]/research.vue` imports `services/research/provenance` → `models/types`, so the frontend compiler (`frontend/tsconfig.json`, deliberately `strict: false`) type-checked 516 server files under rules zod cannot infer under (`strictNullChecks` off → `never`/`unknown`). `SceneRevealSettings` now lives in `lib/reveal-selection.ts` (leaf: contracts + seeded-random); erased type-only import, no runtime change. **Guard against regrowth:** `npm test` runs `npm run typecheck` first (`verify` no longer repeats it). If the frontend graph ever drags a service in again the errors return as TS2339 on `never` in `electron/server/**` — trace with `cd frontend && npx vue-tsc --noEmit -p tsconfig.json --explainFiles`. Lanes identical to 1.4.241: backend **5750 / 5749 pass / 0 fail / 1 skip**, frontend **1953**, release **48**, content-packs **368 / 366 pass / 2 skip**, lint 0 errors. Known flake seen once under full-suite load: `episode-status-cache.test.ts` "STALE: bumping a watched folder mtime" (passes alone 3/3 and on rerun). DMG (unsigned, not installed, drives not refreshed): `dist/Story Studio KH 1.4.242-arm64.dmg` (242,042,117 B, sha256 `ccea643944bfd1f978e62253dc1b71c7ffd14abd63e155a308ca4f0319dd6bca`). **The release before it:** **1.4.241 — Story's side of the gateway job envelope** (`dispatch_state`, `cancellable`, `cancelled`, `waiting`, `recovery_*`; contract in `_orchestra/audit-20260930/CONTRACT-job-envelope.md`, every field optional so an older gateway still works): a job with `waiting` reads *Waiting for a free Mac — next try HH:MM* and is never coloured stale (no timeout, HANDOFF 1a); `failed + cancelled:true` (or a legacy `state:"cancelled"`, normalised in `requestJsonWithRetry`) is terminal in every wait loop; a `failed` job with `recovery_required` / `recovery_state=="unknown_outcome"` is held ~5 min by the loops through `createGenStudioJobPoller().settled()` and recorded as `reconciling`, so a later `succeeded` is honoured; one shared list for the uncertain/quota codes (`isSubmissionUncertainCode`, `isQuotaExhaustedCode`), `LOCATION_*` retry-by-hand only (deliberately not fleet-busy: no wait stacked on the gateway's), held failures never auto-resubmitted (`isFleetBusyFailure`, paid image replacement, stall retry); PNG/JPEG/WebP accepted; Test connection reads `{models}`. **1.4.240 — the UI audit fixes:** error-toast regexes anchored to HTTP context with the raw text on hover; "Cannot reach the GenStudio gateway" replaces "check your internet connection"; `useUnsavedGuard` (leave / project switch / Scene Plan episode switch / window close, with a Stay-or-Discard dialog from `will-prevent-unload` in `electron/main.ts`) on Scene Plan, Introduction and Sound Design; Jobs "Checking again in …" (not an estimate); confirmations for Remove music track, Clear failed, reference/anchor removals and force-regenerate thumbnails (never skippable); *Open job* on failure toasts plus failures from other channels via `useAllJobs`; SSE retried from the poll timer; Pipeline episode selection kept per channel in sessionStorage; dead code removed (11 `loading-label`, `/imagestudio/models` + `isCatalog`, the local-voice branch of `VoicePicker`, the Scene half of `images.vue`). Lanes at 1.4.241: backend **5750 / 5749 pass / 0 fail / 1 skip**, frontend **1953**, release **48**, content-packs **368 / 366 pass / 2 skip**, lint 0 errors; typecheck was at the pre-existing 269 `electron/server/**` errors (fixed in 1.4.242). DMGs (unsigned, **not installed, drives not refreshed**): `dist/Story Studio KH 1.4.241-arm64.dmg` (242,041,911 B, sha256 `53cc3dadae48f82414775095b5758dbd10c0027e27d6bf53a4b84828df05ebee`); 1.4.240 (242,050,342 B, sha256 `62e58d32b0b69ec4cb7f430d1155d3309b5ce06621a84b2dbeac420ae0139304`) is in `_trash/dist/`. **Still open, by owner decision or by scope:** a batch cost quote on Pipeline *Run Batch* (owner: skip — reversed 2026-09-30, shipped as an estimate in 1.4.243), `PreviewPromptRow.vue` is now unused (left in place), the local-render-size (`imagestudio:`) leftovers in `images.vue`, and the gateway must actually publish the envelope fields before *waiting*/cancel/grace show anything. **The release before it:** **1.4.238 — installing keeps the app it replaces.** `bash scripts/release/install-local.sh` is now the install: it quits the app, **creates `_trash/app` if missing**, moves the installed bundle there named with its version, copies the built one, strips quarantine, launches and re-reads the version. The hand-typed four-command version assumed `_trash/app` existed; twice it did not and the install carried on, writing the new app over the old — that is how **1.4.236 was lost** on 1.4.237. The folder is the owner's to empty, so the script creates it every time and **stops** if the old bundle cannot be moved. `scripts/release/__tests__/install-local.test.mjs` (4 tests) drives it against a temp target and is **proved to fail on the restored defect** (2 of 4 red: the keep, and the folder being created). Lanes: backend **5735 / 5734 pass / 0 fail / 1 skip**, frontend **1940**, release **48** (44 before, 4 new), content-packs **366**. DMG `dist/Story Studio KH 1.4.238-arm64.dmg` (242,032,360 B, sha256 `4d719cb2f033cf0cdd844f6472d5e1902c1cee20802e973c078de7c4b8080625`). **Installed with the script, from the exact state that lost 1.4.236** — `_trash/app` absent — and 1.4.237 is at `_trash/app/Story Studio KH.app-1.4.237`. **The release before it, kept as the record it is:** **1.4.237 — the titlebar strip stays put, so the traffic lights stop landing on the logo.** `layouts/default.vue`'s `.top-bar` declared `position` **twice** — `sticky`, then `relative` added later in the same rule for the version chip — and the second won, so the bar scrolled away with the page and the content slid under the window's traffic lights. Found in the **built** CSS, per §3.2, where the minifier had kept the loser: `…flex-shrink:0;position:relative;top:0` with `sticky` thrown away. `sticky` is itself a positioned value, so `relative` bought nothing; after the fix the built rule reads `…flex-shrink:0;position:sticky;top:0`. `frontend/__tests__/titlebarReservation.test.ts` (4 tests) rejects **any** rule that sets a property twice — one instance was this bug and the shape is invisible, because the losing declaration is still there to read — and pins the strip sticky with a positioned ancestor for the chip. Backend gate **5735 / 5734 pass / 0 fail / 1 skip**, frontend lane **1940 pass / 0 fail**, DMG `dist/Story Studio KH 1.4.237-arm64.dmg` (242,037,202 B, sha256 `b6ce41d3dd2e52c23d9aace4e49531a87e776412d2cb43d99eabe82c70b2d3ad`). **The release before it, kept as the record it is:** **1.4.236 — a retired model can no longer be swapped for a different one, and an image job that names no model is refused rather than given a retired default.** Two sites, both of the same shape: an `||` that turned *"this must fail before anything is charged"* into a silent substitution. `music-generate.ts` resolved `models.find(m => m.id === params.model) \|\| models[0]` — under a comment reading exactly *"a retired product must fail here, before anything is charged"* — so a job naming a dead model was moved to whichever model the account lists first, a different product at a different price, and charged. `images.ts` resolved `req.model \|\| 'grok-imagine'`, a hardcoded id since retired, and the Images form's own initial value is `model: ''`, so generating before touching the picker reached it. Both rules are now named functions (`resolveMusicModel`, `requestedImageModelName`) so a test calls them instead of reading source; **the old expression was restored to confirm the new tests go red on it — 3 failed**, and 24/24 pass after. **Deliberately unchanged:** a music job naming *no* model still takes `models[0]`, because `frontend/pages/projects/[slug]/music.vue` sends no id and prices `models[0]` on screen beside that model's own name — refusing there would leave the shown price describing a model nothing uses. Backend gate **5735 tests, 5734 pass, 0 fail, 1 skip, 527/527 files, exit 0** (full suite, no partial banner); frontend lane **215/215 files, 1936 tests**; release lane **5/5 files, 44 tests**; content-packs lane **38/38 files, 368 tests** (2 skipped) — all fail 0. DMG `dist/Story Studio KH 1.4.236-arm64.dmg` (**242,037,044 B**, sha256 `1d69b17c0cbc33a3b75afab820319258f9be2b80c445b7a0c4185a1aa3cebb8d`, ad-hoc signed, mounted read-only, 98-package closure, launch smoke served `/api/health` + Upload Center on port 64782 in 2,603 ms), built from `main` at `36ff4a52` and pushed; the 1.4.235 DMG moved to `_trash/dist/` by the build. **Installed on this staging machine on the owner's instruction** — `/Applications/Story Studio KH.app` reads **1.4.236**, 1.4.235 preserved at `_trash/app/`. **The release before it, kept as the record it is:** **1.4.235** — `package.json` + `package-lock.json` (text edits, never a JSON round-trip), CHANGELOG entry added, frontend lane **215/215 files, 1936 tests**, release lane **44/44**, content-packs lane **368 tests / 38 files**, unsigned DMG `dist/Story Studio KH 1.4.235-arm64.dmg` (242,037,591 B, sha256 `d8d46abc7912921a9e810c31582401806b080fb8e45ad9422d59995cc859fa9a`, launch smoke served `/api/health` + Upload Center). **The one change:** a locked model's reason is shown verbatim. **The release before it, kept as the record it is:** **1.4.234** — landed in `main` (`7c98a875`), DMG `dist/Story Studio KH 1.4.234-arm64.dmg` (242,041,337 B, sha256 `2a596dbd75258d2c4ea66b2fcb1b618297c4d7fe7c6b5abf2b8a0264f38214a1`), **installed and running** (`/api/health` → `1.4.234`, `boot_complete: true`). Closes the two reveal gaps 1.4.232 named: holds snap to narration lines and beats, and the Image Pool reveals with its pace deciding the image count. **The release before it, kept as the record it is:** **1.4.233** — landed in `main` (`00585ce6`), DMG `dist/Story Studio KH 1.4.233-arm64.dmg` (242,045,394 B, sha256 `b6f61fe9ef84960c6713b91c3903c719c0a1ecf4350b8940314016d60a3e4d38`), **installed and running** (`/api/health` → `1.4.233`, `boot_complete: true`). The correction pass the reveal work needed: the library is **19 presets (15 wipes, 3 palettes, 1 draw-on)**, not the twenty two documents claimed — a test pins the composition now — and the three reveal routes are driven over HTTP. **The release before it, kept as the record it is:** **1.4.232** — landed in `main` (`40f5052b`), DMG `dist/Story Studio KH 1.4.232-arm64.dmg` (242,045,129 B, sha256 `ffa80b61820904535c06b66b32cfd75e668b886914223cf706814bc4edf99d83`, ad-hoc signed, mounted read-only, 98-package closure, launch smoke served `/api/health` + Upload Center), **installed and running** (`/api/health` → `1.4.232`, `boot_complete: true`). ⚠ The install step's `mv` of the old bundle into `_trash/app/` failed because that folder did not exist; `ditto` overwrote the 1.4.231 bundle in place. Nothing was deleted, the previous DMG is in `_trash/dist/`, and `_trash/app/` now exists so the next install moves rather than overwrites. **Reveal effects end to end:** the settings, the plan the render uses, the per-scene reroll, `kind: 'reveal'` packs, and the assembly integration whose durations come from the pace plan. Measured on a six-scene Slow sequence: 72 s from 6 images, 2.5× fewer than the 5 s/image baseline. **Two source-form defects found and fixed in the same change:** the `reveal` kind's validation runs the engine's own `normalizeSceneReveal` rather than a second schema, and `package.json`'s description had lost its escaped em-dash — the guard `source-manifest-integrity.test.ts` caught a JSON round-trip this session performed in 1.4.231, and the source form is restored. **The previous release, kept as the record it is:** **1.4.231** — landed in `main` (`e0c3c5e9`), DMG `dist/Story Studio KH 1.4.231-arm64.dmg` (242,043,567 B, sha256 `f2b29e45fc5b8d9ba234abfcb927b710414ce562e78565af9638731d4237d01a`, ad-hoc signed, DMG mounted read-only, 98-package closure, launch smoke test served `/api/health` + Upload Center), **installed and running** — `/api/health` answers `{"status":"ok","version":"1.4.231","boot_complete":true}`. **The published `audio` switch, end to end:** a switch is rendered from the model's own published `controls` list, the operator's choice travels on the request + recovery hash + idempotency key, and the lane's own note is shown verbatim (picture and sound are denoised together, so a silent clip is not cheaper or faster). A value the priced row does not publish is refused before anything is queued. Needs **gateway-kh 0.2.60** and **Studio Hub 0.6.83**; against an older gateway no model publishes a switch, so no control shows and nothing is sent. Carried forward from 1.4.227, still true: **a published limit names its author (HUB-20, our half):** `max_output_tokens_source` is read from the gateway (`provider | model | curated | gateway | worker_default | unknown`), carried through `/api/models`, and Scene Plan renders *"That limit is the worker's fallback, not the model's own figure"* beside the allowance — the measured case is the local chat lane, whose checkpoint ships no `generation_config.json` and whose 16,384 is the Hub's fallback. An absent or unrecognised label stays `null`: "we were not told" is not "the model said so". |
| Pending release | **None. 1.4.244 (and 1.4.243) is committed and pushed (`main`) and its DMG is built; it is NOT installed on this Mac** (the coordinator installs once at the end). 1.4.238 was committed, pushed, installed and running on this staging machine**, and 1.4.237 is kept in `_trash/app/`. `/Applications/Story Studio KH.app` reads **1.4.236**; the previous bundles are preserved at `_trash/app/` (1.4.235 and 1.4.234, nothing `rm`d), and the app's own `logs/server-*.log` shows the fresh 1.4.236 launch serving its pages. `dist/` holds exactly `Story Studio KH 1.4.236-arm64.dmg`; the 1.4.235 DMG is in `_trash/dist/`. This machine is a staging machine by the owner's word, so installing here is authorized; that authorization does **not** extend to any other Mac. (This row claimed *"1.4.231 is committed, installed and running"* for four releases after 1.4.231 shipped — the same stale-row failure the row above records, in the same table.) |
| Version decision | Application/desktop change → bump `package.json` **and** `package-lock.json` in the same change set + add a newest-first `## vX.Y.Z` entry to `CHANGELOG.md` + `npm run check:changelog`. Content-Pack-only change → its own `.sspack`, **no** bump (floor: [`content-packs/release-floor.json`](../../content-packs/release-floor.json)). Mixed → app path only for the runtime part. |
| Branch convention | Work on `codex/stabilization-takeover`. Ship by cherry-picking onto `land/<version>-into-main` from `origin/main`, then fast-forward `main` and push. **Never merge the working branch wholesale**: it also carries another effort's commits that are deliberately not in `main`. |
| Endpoint | Story Studio talks to **exactly one** endpoint — the owner's **gateway-kh** app (`http://127.0.0.1:8787` default), which fronts the provider. Not a GenStudio account. |
| Distribution media | `dist/Story Studio KH 1.4.231-arm64.dmg` is the current artefact (231 MB); the 1.4.230 DMG moved to `_trash/dist/` automatically. The paragraph below about the drives is unchanged and still true. **The four SSDs carry 1.4.219 and are six releases behind** — verified 2026-09-26 rather than assumed: all four drives are **mounted**, and each holds `Video Generation Kit/Story Studio/Story Studio KH 1.4.219-arm64.dmg`, byte-identical at 242,034,101 B with sha256 `5bace95337641c91ef033d8e3459f12bc1130024b90d9e8a4143a36f0ee144ba` — exactly what this row has always claimed. `[CORRECTED]` This row used to say the drives were unmounted and their contents "not verifiable from this machine". They were mounted the whole time, and the claim was the stale half, not the numbers. Refreshing a drive's kit is **Studio Hub KH's** release step, so it is theirs to run, not ours. No Developer ID/notarization — the owner's decision. |
| Installed app | **1.4.231**, launched by LaunchServices, backend on a random loopback port (measured 59910 this launch — it is random per launch, not fixed). **Update it automatically** — never wait for the owner to ask. ⚠ Launching Electron from a *script* needs `ELECTRON_RUN_AS_NODE` unset (`env -u ELECTRON_RUN_AS_NODE open -a …`) or it exits silently with no output and no crash report. It is **not** set in `launchd`, so Finder/Dock launches are unaffected — but an agent session that has it set will think it broke the app. |

## THE WORKING LOOP

Run in this order. Anything marked ⚠ has burned us before.

| Step | Command (copy it) | Notes / ⚠ footguns |
|---|---|---|
| 1. Dev loop | `npm run dev` | ⚠ The dev Electron app runs **compiled** `electron/dist`. Backend edits need `npm run build:electron` **and a restart**; only the frontend hot-reloads. ⚠ Unset `ELECTRON_RUN_AS_NODE` or Electron exits silently (`env -u ELECTRON_RUN_AS_NODE …`). |
| 1b. Isolated app (real rendering) | `cd frontend && npx nuxt dev --port 3000` then `env -u ELECTRON_RUN_AS_NODE PATH="$PWD/bundled/ffmpeg:$PATH" STORY_STUDIO_DATA_DIR=/tmp/<qa> npx electron . --user-data-dir=/tmp/<qa> --remote-debugging-port=9334` | ⚠ Without `bundled/ffmpeg` on `PATH` the audio step fails `spawn ffmpeg ENOENT` and assembly is blocked. A disposable Library keeps the owner's data out of it — but see DO NOT TOUCH: exports still default to his real Library root. |
| 2. Iterate | `node scripts/testing/run-backend-tests.mjs --only <substring>` · `npm run typecheck:electron` · `npm run lint` | ⚠ An `--only` run prints `PARTIAL RUN` and **is not a gate**; never quote it as one. One suite at a time across all work. ⚠ No wallclock sleeps in tests — use `waitFor` in `electron/server/__tests__/_timing.ts`. |
| 3. Full source gates | `npm run test:backend` (every backend file) · `npm run test:frontend` · `npm run test:content-packs` · `npm run typecheck` | Report real exit status, completion line and counts; do not narrow the backend gate. `test:release` includes a built-bundle check: run it after step 5 against the main build. |
| 4. Build | `npm run build` | Runs changelog, typography, security, model-drift and release checks, then builds frontend + electron, then re-checks security/release against the built output. |
| 5. Release artefact | `npm run dist:smoke` | Runs `fetch:ffmpeg` → `npm run build` → `check:release --built --package-input` → electron-builder → `verify-desktop-artifact`. Writes `dist/Story Studio KH <version>-arm64.dmg`. ⚠ Do **not** package from a git worktree whose `node_modules` is a symlink — electron-builder does not follow it and ships an app with no runtime deps (the v1.4.68 defect). ⚠ After any build, `git status` must be clean. **`NEW-11` is solved, and the build was never the cause:** `npx asar extract-file <app>.asar package.json` writes the extracted file into the **current directory**, so run from the repo root it overwrites the source manifest with the packaged one — no `scripts`, no `devDependencies`, `\u2014` unescaped, no trailing newline. The build scripts' snapshot/restore is kept as cheap insurance, but the guard that actually catches it is `electron/server/__tests__/source-manifest-integrity.test.ts` (proved to fail 4/4 on the defect). **Never run `asar extract-file` with `package.json` as the target from inside the repository.** |
| 6. Install (only when asked) | `bash scripts/release/install-local.sh` — **a script, not four hand-typed commands.** It quits the app, **creates `_trash/app` if it is missing**, moves the installed bundle there named with the version it was, copies the built one, strips quarantine, launches, and re-reads the installed version. Pass a path to install something other than `dist/mac-arm64/Story Studio KH.app`; `STORY_STUDIO_INSTALL_TARGET` redirects the destination, which is what the tests use. **Why it is a script:** the hand-typed version assumed `_trash/app` existed, and twice it did not — after 1.4.232 (*"the `mv` … failed because that folder did not exist; `ditto` overwrote the 1.4.231 bundle in place"*) and again on 1.4.237, when **1.4.236 was overwritten**. The folder was gone because `_trash/` is the owner's to empty and he had. **A procedure that breaks when the owner tidies his own trash is the wrong procedure**, so the folder is created every time and a failed move now stops the install instead of quietly becoming an overwrite. `scripts/release/__tests__/install-local.test.mjs` drives it against a temp target — never `/Applications`, never the app someone is using — and its guard is proved to fail on the restored defect. Verify afterwards with the app's own `/api/health` + its server log, not by assuming. |
| 7. Land | cherry-pick the release commits onto `land/<version>-into-main` (from `origin/main`) → run the gates on that tree → `git checkout main && git merge --ff-only land/<version>-into-main` → `git push origin main` → cherry-pick the record/dossier commits back to the working branch | `origin` = `https://github.com/theng12/story-studio-kh.git`. Never rewrite published history. |
| 8. Acceptance harness (optional) | `npx tsx scripts/developer/serve-mock-genstudio.ts --port 8799` (long-lived fake gateway: queue a scenario, clear queued answers, publish an alternate language catalogue, read accounting) and `ACCEPT_APP_URL=… ACCEPT_SLUG=… ACCEPT_MOCK_URL=http://127.0.0.1:8799 npx tsx scripts/developer/accept-01-driver.ts --leg script\|audio\|subtitles\|scene-plan\|images\|assemble\|metadata` | The driver hosts or attaches to the mock, points the app at it, and drives the app's own routes. Zero spend. `_timing.ts`, not sleeps. |

## PATHS

| Path | What it is |
|---|---|
| repo root | `/build/Developer/story-studio-kh` |
| `electron/server/` | Express backend; job queue, generators, content-store client |
| `frontend/` | Nuxt 4 / Vue frontend |
| `bundled/ffmpeg/` | `ffmpeg` 8.1 + `ffprobe`; prepend to `PATH` for dev runs |
| `dist/` | DMG + blockmap output (git-ignored); the handoff folder for the owner |
| `Story Studio Project Status.md` | **source of truth**: queue, candidate rows, review log, release state |
| `docs/handoffs/deepseek-reports/` | one report per packet (`ACCEPT-01.md`, `DS-*.md`, `WIRE-*.md`) |
| `_handoffs/` | letters to/from gateway-kh (read-only thread) |
| `docs/tasks/HANDOFF.md` | this file |
| `_trash/` | Holds `README.md` plus `app/`, which carries the replaced app bundles **1.4.219 → 1.4.224** (per the never-`rm` rule), and `new11-evidence/`, which holds the manifest a stray `asar extract-file` overwrote on 2026-09-26 (see step 5). The earlier 1.4.217/218 bundles and DMG evidence copies are still **not on disk and not accounted for** — who removed them is not recorded; do not infer an agent or the owner did it. The retired commit `8051fc28` is still recoverable from Git. |
| `scripts/developer/` | `serve-mock-genstudio.ts`, `accept-01-driver.ts`, `probe-video-assembly-status.ts`, `measure-job-persistence-cost.ts` |
| `STORY_STUDIO_DATA_DIR` | dev/QA Library (projects, cache, app settings). A disposable QA Library does **not** survive a reboot — `/tmp` copies are gone as of this writing. |
| `--user-data-dir` | Electron profile; the app's `app-settings.json` and secret store live here |
| Default Library root | `~/Documents/Story Studio KH` — `_Project Assets/` and `Exports/` (final videos land here **outside** the project tree) |
| Installed app | **1.4.231**, launched by LaunchServices, backend on a random loopback port (measured 59910 this launch — it is random per launch, not fixed). **Update it automatically** — never wait for the owner to ask. ⚠ Launching Electron from a *script* needs `ELECTRON_RUN_AS_NODE` unset (`env -u ELECTRON_RUN_AS_NODE open -a …`) or it exits silently with no output and no crash report. It is **not** set in `launchd`, so Finder/Dock launches are unaffected — but an agent session that has it set will think it broke the app. |

## RULES THAT COST US TIME

Each is an instruction, not advice.

- **Never `rm`. Every removal moves to `_trash/`** — the owner's words, covering your own cleanup as much as his requests; keep the sub-structure and say where it went.
- **Never rewrite published history.** To delete a branch or ref, record its name and SHA in a note under `_trash/` first.
- **Treat `_trash/` as the owner's.** Never delete or tidy anything inside it, and never restore something he removed from it.
- **Strip `ELECTRON_RUN_AS_NODE`** when launching Electron (dev or packaged); with it set the app exits immediately with no output and looks broken.
- **Do not package from a symlinked-`node_modules` worktree** — the app ships with no runtime dependencies and dies at launch.
- **Put `bundled/ffmpeg` on `PATH`** before any run that generates or assembles audio; otherwise you get `spawn ffmpeg ENOENT` and assembly blocks with a precise missing-file list.
- **Rebuild and restart after backend edits** — the app runs compiled output, so a source edit alone changes nothing you can observe.
- **TTS parts are sized by the model's published character limit, and by nothing else.** Owner decision, 2026-09-26: no internal spoken-minutes cap, because the 900-second wall that killed a long part is being raised at its source. That number is **Studio Hub's** (`PEER_PROXY_TIMEOUT_S` in its `hub/standalone.py`), published per lane as `deadline_seconds`; the gateway deliberately reads the lane's figure (`gateway/adapters/studio_hub.py::lane_deadline_seconds`) so it follows the Hub automatically. Do not add a seconds-per-word bound of ours, and do not cap a part to fit a deadline the lane owns.
- **A window of scenes is ONE response, so the output ceiling sizes it too.** The auto window size used to read only the *input* budget, so a 262,144-in / 4,096-out lane was asked for 30 scenes it could not return (fixed in 1.4.221). Before adding any batch, ask what one response can carry.
- **A provider's `finish_reason` can lie; usage does not.** A Studio Hub lane reported `stop` on an answer that had used its entire 4,096-token ceiling and stopped mid-sentence (2026-09-26). Treat "usage ≥ the ceiling the request asked for" as truncation, whatever the reason says — and never hand a provider's word for "complete" to the customer unverified.
- **One suite at a time**, and never quote an `--only` run as a gate: it prints `PARTIAL RUN` precisely so this cannot be confused.
- **No wallclock sleeps in tests.** Use `waitFor`; a fixed sleep asserts the scheduler, not the product.
- **Gates cannot see geometry, CSS or dev wiring.** When the complaint is visual, screenshot the render; when a declaration seems not to apply, check the **built** CSS for specificity, not the source. `:deep()` on a teleported dialog never matches.
- **Episode state must not survive an episode change** — replace the field or blank it, never `if (newValue) field = newValue`, and announce the change.
- **Provider is display, never dispatch.** One endpoint only; never infer a provider from an id or name; never hardcode a limit the catalogue publishes (read it live on every selection change).
- **`pacing` is NOT in Character Sheet presets** (owner, 2026-10-17; it was in them 2026-08-18 → 2026-10-17, and out before that — the timing editor is Scene Plan's "Visual timing & motion", and Scene Review reads the episode's rhythm back from the plan) and **scene rhythm stays per-episode** (no project default) — both are owner decisions; do not "fix" them back. Details in `AGENTS.md` §5.
- **A metadata Retry with no saved action must mint a fresh request identity** (`NEW-14`), or the provider replays the same short answer and the promise "Retry to generate the missing fields" is false.
- **Scene Plan's timeline step is model-free and is audited on its timeline** (`NEW-12`), not on the visual prompts it is not asked to write.
- **Episode status watches the project tree *and* the Library export root** (`NEW-13`); a cache schema change must bump `SCHEMA_VERSION` in `electron/server/services/episode-status-cache.ts` so old rows are recomputed.
- **After any packaging run, `git status` must be clean** — the build scripts restore a rewritten manifest and log it (`NEW-11`); if they log it, the culprit step is still unknown.
- **`npm run check:changelog` must pass** — runtime version, lockfile and the newest What's New entry have to agree.
- **Typography gate:** no source text below 12px. **Model-drift gate:** no hardcoded catalogue values outside annotated exceptions.
- **Content Packs:** one unrecognised kind discards the whole catalogue, on both sides. Local→wire kinds: `series-formula→series_formula`, `topic-pack→topic_pack`, `visual-style→visual_style`, `thumbnail-recipe→thumbnail_recipe`, **`lettering-style→font_pack`** (the only non-mechanical one), `metadata-formula→metadata_formula`. `niche_bundle` is retired by the publisher but kept only so old archives read — see OPEN.
- **No paid call, upload, publish, deploy or installed-app replacement without the owner's explicit go-ahead.** Commit/push of finished work is standing-authorized; releases were authorized per version (1.4.217–219).

## DO NOT TOUCH

| Area | Why |
|---|---|
| `_trash/` — including anything you think belongs back in the repo | The owner's; he may empty it at any time. It is not durable: as of this writing it holds only `README.md`. Never restore what is no longer there. |
| `main`'s history, `land/*` branches, anything already pushed | Published history is never rewritten. |
| Other repositories and worktrees (Studio Hub KH, gateway-kh, any `codex/*` branch from another effort) | Not ours; `codex/content-pack-delivery`'s commit is deliberately absent from `main`. |
| `~/Documents/Story Studio KH` | The owner's real Library, `_Project Assets/` and final-video `Exports/`. Normal app use only; never reorganise or clear. |
| The four SSDs (`KH-STUDIO-*`) | The owner handed the SSD/installer kit to Studio Hub KH. |
| `/Applications/Story Studio KH.app` | Replace only on the owner's instruction, and keep the old bundle in `_trash/`. |
| `_handoffs/` letters | A thread with another party — read them, never rewrite someone else's letter. |
| `content-packs/authoring-registry.json` at baseline revision 289 | The authoring record was retired by the owner's decision; do not re-add `8051fc28`'s sources. |

## OPEN / IN FLIGHT

| Item | Honest state |
|---|---|
| **HUB-20, our half** | **SHIPPED in 1.4.227.** The label is read (both producers' vocabularies), `/api/models` forwards it, and Scene Plan renders the provenance beside the number. `electron/server/__tests__/published-limit-source.test.ts` and the frontend `modelTokenBudget` suite pin it; the backend gate is **5,664 tests / 5,663 pass / 0 fail / 1 skip** and the frontend suite **1,920 pass / 0 fail**. |
| **WIRE-3** | **Still open, and now measurable from both sides.** The gateway publishes `max_output_tokens_source` and this app reads it; the wider row of fields Story's `GenStudioChatModel` declares but the gateway never sends is not closed. The honest next step is a field-by-field diff of that interface against `gateway/catalog.py::_chat_row` and a decision per field — publish it, or delete the declaration. |
| **Video lane (Hub side)** | Studio Hub **0.6.76–0.6.80** shipped the Video worker, and the first through-the-chain run used *this app's exact wire shape* (upload → `POST /v1/videos/generations` with `reference_asset_id`): succeeded, 704×448, 4.04 s with audio, 385.9 s, artifact verified. **This app needs no change for it** — it reads `/v1/videos/models` and `video_url`, both already published. |
| `NEW-11` | Mitigated, **not** root-caused: packaging rewrote the checkout's `package.json` once; both build scripts now snapshot and restore both manifests, but the step that does it is unidentified. Reason not recorded — a clean `electron-builder --dir`, including its `@electron/rebuild` phase, left both manifests byte-identical, and `fetch:ffmpeg` takes its present-binaries fast path. |
| `niche_bundle` deferred cleanup | Owner: *"leave as is. but add a note to remove it in the future once i start generation on a new work machine."* Notes are in both kind lists and in the status file's **Deferred cleanups**. |
| Paid generation / upload / signed distribution | **Owner-attested, not machine-verified by us.** He reports real paid generation and a real upload already work with an earlier build; he says a Developer ID is not needed. No paid call was made from this repo. |
| **NEW-11** root cause — mine | Next concrete step: instrument one packaging run (`npm run dist:smoke`) to hash both manifests at each phase (install, rebuild, frontend build, electron build, electron-builder, ffmpeg fetch) and name the step that rewrites `package.json`. The restore guard makes it harmless meanwhile; the reason is still unrecorded. |
| **Independent-audit triage — mine, the largest open item** | ~90 findings (~26 high/medium) against §8/§6/§4, unverified except four spot-checks. Next step: take the highest-severity claims one at a time, verify each against the current source, and record verdicts with file:line — the ones that hold become fixes shipped the usual way, the ones that do not are recorded as refuted, with the evidence. |
| Independent review | An **independent audit exists and is unresolved**: [`docs/audit/2026-09-23-independent-audit.md`](../audit/2026-09-23-independent-audit.md) — dated 2026-09-23, scoped to this branch at `734ccd70` / v1.4.219, no code changed, claiming ~90 findings (~26 high/medium) against AGENTS §8, §6 and §4 and challenging the gate evidence. **Treat it as leads, not facts** (the audit says the same of itself): its line numbers are those of `734ccd70`, and this handoff's author spot-checked four concrete claims — the hardcoded `~$0.005` price in `PreviewPromptRow.vue:38` **confirmed**; `'grok-imagine'` **exists but in `generators/images.ts:318`**, not the `routes/images.ts` path cited; `'deepseek-v4-flash'` at `audio.ts:710` **not found** (that id appears only in test fixtures); the frontend statistic is in the right range (168 of 213 frontend test files reference `readFile`/`readFileSync`). Every packet in `docs/handoffs/deepseek-reports/` is otherwise `self-accepted` by its author. |
| Platform coverage | Proven on this **one Mac** (arm64, current macOS, ffmpeg 8.1) only. No Intel, Windows or Linux run. |
| ACCEPT-01 walkthrough | Ran against the repo's **mock** gateway. Partly superseded by the STORY-2 run (2026-09-26), which drove the **real** gateway end to end for outline, chapters and thumbnail prompts on the local model and receipted where it stopped (metadata, at the audio gate). Real cost accounting, real speech timing, a real upload and long-form quality remain unproven end to end. |
| `_trash/` | Now holds only `README.md`; the 1.4.217/218 bundles, the earlier DMGs and the evidence copies are no longer on disk. **Who removed them, and when, is not recorded** — do not infer an agent or the owner did it. The retired commit `8051fc28` itself is still recoverable from Git. |
| SSD copies | Verified on 2026-09-22, before the drives were unmounted. Current contents unverified. |

## SECRETS

**None are in this repo, this file, or any build script.** Do not search for them and do not print them.

| What | Where it actually lives |
|---|---|
| Gateway API Key | The app's own secret store — **Settings → This Mac → Gateway API Key**; written to `app-secrets.json` under the app's `--user-data-dir` on the owner's machine. Ask the owner; he holds it. |
| YouTube credentials | The owner (connected through the app's own connection flow, never by hand here). |
| Acceptance harness key | The mock gateway publishes its own fixture key (`MOCK_GENSTUDIO_FULL_KEY` in the test fixture). It is a test constant, not a secret. |
