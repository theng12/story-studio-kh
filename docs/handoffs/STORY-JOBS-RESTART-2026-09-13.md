# Story Studio 1.4.154 — Jobs, image recovery and media cleanup

## Current status

Owner resumed after restart on 2026-09-13 and approved the Free up space proposal alongside the remaining fixes. Implementation and independent reviews are complete. All local verification lanes and the production build have passed. Repository integration and the merged-main installer are the remaining steps; this is not yet an installer release claim. No customer jobs or media were changed during development.

- Canonical repository: `<owner-home>/Developer/story-studio-kh`
- Working branch: `codex/jobs-abandon-scope`
- Working directory: `<owner-home>/Developer/story-studio-kh/.worktrees/jobs-abandon-scope`
- Base: `5837707d3b0fd99af7a9b56306a9ee3829c8081c`, released 1.4.153 / PR112
- Target application version: 1.4.154; package, lockfile and changelog updated
- Preserve the canonical checkout’s pre-existing untracked Impeccable critique.

The prior 1.4.153 release already addressed shared settings performance, Content Store purchase/install feedback, Pipeline confirmation responsiveness and background uploaded-export archive scans. Do not redo that release. The separate local-source cleanup workflow below is new.

## Delivered behavior in the branch

### Jobs

All Jobs unions Library projects with valid durable direct-child job stores, keeping per-project and global listings consistent. SSE subscribes before reading its snapshot; buffered updates and removals survive initial reads. Read failures remain visible instead of appearing as an empty queue. Confirmed action responses update both frontend queues immediately; count-only bulk clears request an authoritative refresh.

Active and history cards have checkboxes. Select needs attention and Select all matching operate on the current filters across pages. Abandon and clear selected uses one confirmation and the existing per-job controls, reports progress and partial failures, and keeps unsuccessful rows selected. It preserves files, billing records and accepted provider evidence. Narrow layouts wrap the job identity so project names remain readable.

### Image recovery

The existing enabled automatic replacement policy admits one terminal, fully refunded generic `IMAGE_FAILED` replacement when exact identity, settlement and missing artifact checks pass. It remains bounded across restart-shaped attempts. Uncertain submissions, refusals, cancellations and charged generic failures are excluded. All three image generators recheck the current On/Off setting at the final provider submission boundary. This does not automatically alter existing customer jobs.

### Free up space

Settings has an uploaded-only episode list and explicit category selection: generated images, chapter audio, merged audio, motion clips, final video. Upload Center links to it. A background scan reviews exact files and bytes. Archive verifies each copy before removal; Remove local files requires an explicit final confirmation. Progress, Stop, retained operation IDs and per-file outcomes allow navigation away while the app remains open.

Only reviewed private episode media is eligible. Active work, shared/pool roots, links, changed/newer media, archive collisions and unverified final exports are excluded. Current ready upload records back source eligibility; final exports also require exact source identity and a fresh YouTube check. Scripts, prompts, subtitles, settings, upload records and billing evidence remain.

Per-file pending intent is written before destructive work, followed by the actual outcome. Restart does not promise automatic operation resumption: uncertain outcomes remain reviewable. Same-drive archives report bytes moved separately from reclaimed space. Archive paths include project and episode identity.

Local availability is separate from asset readiness. Pipeline, Board and episode selectors show cleaned-media state without marking missing media complete. Ordinary Pipeline preflight and final queue admission block deliberate cleanup; explicit Force re-run still checks prerequisites and spending rules. A per-episode cleanup/admission lock prevents races with new work; synchronous retries fail clearly during the short destructive section. Renamed episode folders retain cleanup history, restored current-path files clear retirement, and repeated cleanup after renaming counts each logical file once.

## Review and verification evidence

Independent read-only reviews covered Jobs transport, bulk actions, image retry boundaries, storage UI, storage deletion/admission races and title-folder behavior. Findings were fixed and rechecked. No remaining material findings at the start of the final full run.

Focused checks before the full gate:

- Jobs frontend: 84 tests, 0 failures, exit 0; backend jobs-stream: 13 tests, 0 failures, exit 0.
- Image replacement policy/integration: 75 tests, 0 failures, exit 0.
- Storage service: 17 tests, 0 failures, exit 0 before the final rename/re-clean additions.
- Pipeline cleanup integration: 7 tests, 0 failures, exit 0.
- Cleanup UI/status presentation: 7 tests, 0 failures, exit 0.
- Lint: exit 0 with existing warning debt; typecheck: exit 0 before the last small storage amendments.
- Backend focused harnesses confirmed the configured projects root remained byte-identical. These are partial runs, not release gates.

Rendered checks used actual Vue templates/styles with synthetic data in headless Chromium, not live customer operations. Desktop 1440 px and narrow 390 px screenshots showed no horizontal overflow; expanded long paths and visible action controls were inspected. Cleanup DOM tests cover project switching, repeated confirmation, cancellation, stale selection, dismissal/remount and interrupted outcomes. Impeccable’s mechanical detector found no new cleanup-panel issues; its 13 Jobs side-border warnings refer to existing status styling retained intentionally.

One agent accidentally launched an aggregate backend run with the wrong argument form; that process tree was terminated and is not verification evidence. Only the root-owned final run counts below. Run one suite process at a time.

Final full command: `npm run verify`
Log: `logs/jobs-abandon-scope/verify-1.4.154-final.log`

The first full backend pass completed all 468 files / 5,199 tests with two test failures: a source assertion used the old retry variable name, and the timing ratchet rejected new fixed-delay test helpers. Those tests were corrected without weakening their production assertions. The final focused rerun passed 34/34 tests across cleanup, Pipeline admission, image retry and the timing ratchet, exit 0, with the projects root byte-identical. It also covers the final parent-directory link-swap check and logical history deduplication. The complete backend repeat passed 5,200/5,200 tests in all 468 files, exit 0, with the configured projects root byte-identical. The frontend gate then exposed two outdated selector tests; only those tests changed: the compiled-component harness now binds the real local-media label helper and checks its rendered label, and the source assertion includes the added suffix. Independent review found no issues. The full frontend repeat passed 1,767/1,767 tests across 192 files, exit 0. The release gate exposed a literal home path in an older handoff; it was replaced with the required placeholder, also used in this batch’s new documents. The release repeat passed 36/36 tests across 4 files, exit 0. No production source changed after the full backend pass. Remaining official lanes are run sequentially; the earlier aggregate command itself exited 1 and is not claimed as a passing run.

Additional logs: `logs/jobs-abandon-scope/verify-1.4.154-remaining.log` (frontend result and first release result; initial output excerpt was truncated), `logs/jobs-abandon-scope/verify-1.4.154-release-build.log` (release repeat, Content Packs and build).
GitHub Actions were confirmed disabled (`enabled: false`) before integration preparation. Do not use hosted compute.

## Final local verification

- Backend: 468/468 files, 5,200 tests, 0 failures; exit 0; configured projects root byte-identical.
- Frontend: 192/192 files, 1,767 tests, 0 failures; exit 0.
- Release: 4/4 files, 36 tests, 0 failures; exit 0.
- Content Packs: 38/38 files, 368 tests, 0 failures; exit 0.
- Total: 7,371 tests. Full lanes, not filtered runs.
- Lint: exit 0, zero errors with 1,884 existing warnings. Typecheck: exit 0.
- Production build: exit 0, including changelog, typography, security (source and built), model-drift and desktop release checks.
- Aggregate verification stopped at the documented stale test failures; subsequent complete affected lanes passed. No claim that the original aggregate command exited 0.

## Remaining release work

1. Local verification is complete as recorded above; preserve the logs.
2. Commit, push, create/update PR and merge only when reviewed and verified. Standing owner authorization covers repository integration; no force push, hosted compute, deployment or paid calls.
3. Synchronize canonical main and run official `npm run dist:smoke`. Verify the versioned arm64 DMG, app/asar versions, dependency and launch smoke checks. Never deliver a worktree-built DMG as main.
4. Record PR/commit/artifact/checksum, retain useful logs and remove only the integrated disposable worktree. Do not install/restart the running customer app or execute cleanup on customer media.

Image compression remains a separate optional experiment on copies; no originals are converted. Source deletion is user-operated, not automatic. This batch does not claim all application performance or provider reliability issues are eliminated.
