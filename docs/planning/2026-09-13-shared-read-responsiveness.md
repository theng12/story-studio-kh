# Story Studio responsiveness audit — 2026-09-13

## Scope and status

User asks what remains pending and what audit/plan can improve slow clicks and operations. The owner subsequently authorized implementation. This file retains the pre-change baseline and execution evidence. Canonical main90ad1912/version1.4.155. Applicable AGENTS: evidence/logs first, preserve customer data and running jobs, model catalogue authority, cheap bounded delegation, minimal shared root-cause fixes, independent review, one verification suite, local-only release. No launcher changes. Existing critique preserved.

Prior batches 1.4.153–155 are integrated with verified installers. They include responsiveness/Store/Pipeline/archive improvements, durable All Jobs and bulk abandonment, bounded refunded image replacement, uploaded episode source-media cleanup and retained local-media status, and Scene Plan preset timing. Historical handoff statements about unshipped source cleanup or unavailable settings caching are superseded. Live end-to-end responsiveness and native-dialog validation remain. Optional image compression remains an experiment on copies, not an implemented conversion policy.

## Baseline observed on installed 1.4.155

The installed bundle and sampled process report1.4.155. No development tests/builds were running. Existing live request logs over the 15 minutes ending2026-09-13T01:51:02.456Z showed:

| Existing request | Samples | Median ms | Maximum ms |
| --- | ---: | ---: | ---: |
| Capi EP0156 audio sections | 3 | 46122 | 56859 |
| Capi EP0156 audio status | 1 | 34791 | 34791 |
| Capi EP0156 episode status | 1 | 47474 | 47474 |
| Capi episode list | 3 | 21814 | 27264 |
| Capi EP0156 subtitle status | 1 | 43171 | 43171 |
| GenStudio overview | 30 | 556 | 5832 |
| GenStudio admission | 106 | 11 | 10687 |
| Capi settings/config | 3 | 141 | 788 |

These are logged server request durations, not click-to-paint or isolated dependency durations. Sample sizes are small and workload is uncontrolled. Recovery operations can legitimately include provider work and are not equivalent to local status reads. No new customer operations were submitted by this audit.

Two process snapshots showed Story Studio main at102.9% and149.4% CPU (one core equals100% in ps). Five-second native sample: current physical footprint572.1MB, peak1.2GB; substantial filesystem callback activity, incomplete JS symbol attribution. This does not establish the exact costly function. Mac has16GB RAM, approximately6GB occupied by the memory compressor, about518MB swap in use. Compression/swap are evidence of memory demand, not proof of a current leak or that memory alone causes delays. Collect interval deltas and idle/active comparisons before assigning causality.

## Concrete lead

routes/audio.ts audio-status and audio-sections call getAudioStatus without ProjectFactsCache; audio-sections also calls findNarrationFile again. services/audio-reconciler.ts forwards its optional cache. generators/audio.ts findNarrationFile uses the episode-specific fast path only with a cache; without it, it recursively searches the whole project output tree. Reuse the existing request-scoped resolution if measurements confirm cost. Preserve renamed-folder/legacy narration behavior, Markdown precedence, selected model limits, and invalidation after generation/import. A source trace plus sampled filesystem activity is a lead, not an isolated benchmark.

## Execution order

1. Measure shared read paths first. Add temporary per-phase instrumentation in an isolated development process with representative fixture/copied metadata. Count narration/episode directory traversal, config reads, repeated status requests, hashing and outbound API time. Compare audio/status/list endpoints under matched idle/active load. Audit all callers before changing shared lookup behavior.
2. Fix the largest confirmed cause with existing helpers. Narrow reads to the selected episode, share duplicate in-flight reads where ownership/inputs match, avoid repeated expensive display-only work, and keep authoritative validation at generation/cleanup/payment boundaries. Do not guess cache freshness or remove completion/billing safeguards.
3. Measure visible interaction: click-to-feedback, page readiness, event-loop delay and renderer long tasks on project switch, Jobs, Audio, Subtitles, Scene Review, Upload, Store, Pipeline and Settings Browse. Keep content visible during refresh; ensure one click acknowledges work; dialogs retain reachable Close. Test keyboard and narrow layout.
4. Repeat on small/large projects, idle/active jobs, cold/warm navigation, rapid project switches and slow/failing network. Targets for ordinary controls: visible acknowledgement within100ms; ordinary warm page controls within1s where no expensive/provider work is required. Long operations show a phase promptly and allow navigation away where supported. Report median/p95 with sample count and matched workload; targets are not promised achieved timings.
5. Regression tests, independent review, full local verification one lane at a time, production build and canonical-main release. Validate installed performance under the same workload; report remaining provider delays separately. No paid calls, deletions, archival movement, purchases or customer restarts merely to benchmark.

## Delegation record

pending_performance_inventory, Luna high, read-only main90ad1912: shipped/deferred handoff inventory, no edits or tests. Completed; root corrected its stale source-cleanup proposal interpretation using1.4.154 implementation and release evidence. Root collected resource/log samples. No agent-owned processes remain.

Evidence: story-main.sample.txt here; source log in the installed app’s logs/server-2026-09-13.log. No production code changed during the baseline.

## Authorized implementation — 1.4.156

Worktree .worktrees/shared-read-responsiveness, branch codex/shared-read-responsiveness, base90ad1912. Root owns benchmark, bounded streaming hash, integration and release. shared_lookup_fix (Terra high) owns narration default request-scoped lookup + realfilesystem regressions. pending_performance_inventory (Luna high) owns audio status/repair response scoping and duplicate selector reload removal. read_path_inspector (Luna high) owns shared episode-status scope correctness and tests. Each started at90ad1912; deliver files and focused evidence, no commits or customer operations. Full suites run only by root, one at a time. Independent cross-review required. No launcher changes or new dependencies.

Lookup benchmark ran actual base function and updated function against isolated real filesystem fixtures, 7 calls per variant/case. For405 episode folders with8 media subfolders each, present narration:3650 directory reads ->0; median 355.69 ms -> 1.66 ms. Missing narration:3650 ->2 reads; median 305.66 ms -> 2.74 ms. Ten-episode fixture:95 ->0 reads for present;95 ->2 for missing. This is lookup-only local fixture performance, not a measured end-to-end user-page speedup. Legacy renamed-folder fallback regression remains covered.

Streaming hash benchmark used256MiB split across2 source files, separate before/after processes. Digest identical. One recorded pair:357.44ms ->181.63ms; peak RSS506912KiB ->335488KiB; maximum sampled event-loop delay110.62ms ->12.10ms. Process overhead includes the measurement harness. This establishes bounded-source-memory behavior and reduced blocking in this fixture, not a guarantee for every audio file or machine. No hash cache or mtime substitution was introduced. All byte verification remains authoritative.

The inspector confirmed an unnecessary chapter-list refresh from audioStatus.total. The child already watches episode/model; refresh-key now depends only on deliberate refreshes. Current repair increments it explicitly. Audio status/repair responses are scoped by project, episode and sequence; shared episode status clears old rows synchronously and keeps fresh selection gates unknown until resolved. The expensive per-episode invalidation contract is preserved because it detects externally edited script files.

Focused checks passed: narration lookup and generation compatibility 5/5 (backend, 2 files, exit 0); streaming audio identity 2/2 (backend, exit 0); audio response safety 6/6 and shared episode status 4/4 (frontend, exit 0). The first full verification was stopped with exit 143 after exposing legacy root narration coexisting with a canonical episode directory. A bounded direct legacy-path probe and regression fix that case; the focused compatibility check passed before restarting the full gate. Independent reviews found no blockers in the streaming hash, response guards, cache scope, or final legacy fallback. Final full `npm run verify` exited 0: backend 5,206 passed (470/470 files), frontend 1,787 passed (195/195 files), release 36 passed (4/4 files), content packs 366 passed and 2 skipped (38/38 files). Total 7,395 passed, 2 skipped, 0 failed. Lint reported 0 errors and 1,884 existing warnings; both type checks, changelog, typography, security, model-drift, production build and desktop release checks passed. The final lookup benchmark was repeated after the legacy fix, with 7 calls per case and the counts/timings above; both benchmark processes exited 0. GitHub Actions remain disabled; no hosted checks or paid calls ran. Live installed multi-tab idle/active timing remains a post-install validation condition; no paid work, archive moves, deletion or restarts are used for benchmarking.
