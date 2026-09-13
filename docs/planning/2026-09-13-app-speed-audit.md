# Whole-app speed audit — 2026-09-13

## Authority, scope and safeguards

Owner requests speed audit and implementation across Story Studio. Base main faf2ea0c (1.4.159), isolated `.worktrees/app-speed-audit`, branch codex/app-speed-audit. Apply AGENTS: logs first, minimal shared fixes, preserve customer outputs/paid-work safeguards/live selected-model facts, no production mutations or restarts for benchmarks, independent review, one local test suite at a time, version/changelog and main-only verified DMG. Existing critique untracked file preserved. No launcher work. No new architecture or caching framework without measured need.

Skills: Ponytail full; systematic debugging; Impeccable optimize for measured incumbent UI refinements. Existing graph queried using vocabulary episode/config/settings/format/catalog/cache/admission/overview; graph sources are older than current code, so verify callers against actual source. Serena activated for targeted symbols.

## Baseline

Read-only existing server request logs since 09:00 UTC, 2026-09-13 (uncontrolled workload): episodes: 3 requests p50=4747ms,max11798ms; admission: 927 requests p50=27,p95=1407,max7850ms; overview: 190 requests p50=640,p95=1502ms; upload preview: 15 requests p50=2247,p95=3676ms; upload admission: 15 requests p50=227,p95=1043ms; niches: 1 request = 5305ms; effective-format: 2 requests max2194ms. Health/queue status mostly 0–1 ms. These are server durations, not click-to-paint proof.

Machine snapshot: swap 2287.94 MiB, reported system memory free 50%. Swap alone does not prove current pressure or causality. Avoid attributing lag to memory without interval evidence. No new provider calls for this baseline.

## Independent work

- shared_lookup_fix (Terra high): backend episode/list/config/effective-format root-cause audit, safe benchmark and minimal changes once evidence supports. Start faf2ea0c; deliver tested files and timings.
- read_path_inspector (Luna high): frontend shared shell/request duplication/waterfalls/mainthread audit; deliver proven reduction and scoped-state tests.
- Root: broad request/runtime inventory, integration, any nonoverlapping measured fix, rendered verification and release. Agents initially read-only; run tests only under one-owner scheduling.

## Audit matrix and execution

1. Shared page prerequisites: project/episode selection, formats, configuration. Trace costly filesystem work and share within existing request scope; benchmark small/large fixtures with identical outputs.
2. Background work: account, queue and status polling, duplicate requests, hidden/unmounted consumers. Preserve fresh authority at actual submission and model switches.
3. Large visual pages: existing Scene Review pagination and full image validity protections; inspect Scene Plan render scope and image payloads. Preserve selection and all-scene actions.
4. Other flows: Jobs, audio/subtitles, Upload, Pipeline, Store, Settings/storage. Rank from observed latency and shared impact; document verified-fast paths and unresolved remote delays.
5. Measure before/after with fixture or isolated development browser; focused regressions; independent review; one full npm run verify; authorized integration and canonical-main DMG. Do not claim every page is instant or every performance issue solved.

## Results and scope of measurements

- Episode visual-source reads now receive the request's existing ProjectFactsCache, including both sidecar and no-sidecar resolution. Cache ownership and alternate episode-folder lookup remain enforced. No global cache or longer freshness TTL introduced.
- Real `/episodes` route, 100 isolated episode folders, warm status cache, seven alternating before/after requests with exact response equality: median **149.28 → 87.15ms** (41.6% lower), `readFile` **605 → 205** per response (66.1% fewer). Baseline route loaded from faf2ea0c while other dependencies/fixture remained identical. This is a local fixture endpoint benchmark, not installed click-to-paint timing. Cold disk/media validation still costs work.
- Narrow visual-source fixture, 100 episodes, 8 workers, 7 runs: no-facts 500 reads vs request-facts 102 (79.6% fewer); median 112.16 → 50.36 ms. This excludes the rest of the list route.
- `/niches` now counts niche selections from existing project summaries: 2N→N project metadata reads, removing the sequential second loop's reads. Instrumented real route verifies one project.json read and unchanged project_count. `effective-format` resolves from its already-read ProjectMeta: 2 → 1 metadata reads. Verified Content Pack coordination locks are preserved.
- Episode selectors ignore historical completed-job snapshots only when completion predates the start of the successful list read. Missing timestamps/observed transitions remain conservative. Completion during an in-flight list schedules a follow-up; project keys remain scoped.
- Jobs advisory capacity cadence 5s → 15s: 12 → 4 recurring requests per minute, 13 → 5 including initial mount. Hidden windows skip advisory polls; visible return/explicit pause/resume refresh promptly. Local queue status remains 5s, live jobs still use SSE, actual backend submission verification unchanged. Stale local submission-block/wait-count indicators expire after 30s without a successful refresh; provider capacity keeps its separate existing authority/freshness guard.
- Independent review discovered pre-existing initial-slot capture during reactive project switches. Returned episode state now follows the current project; regression must inspect displayed rows and loading/error state, not only network counts.

## Audit disposition

| Surface | Evidence / action |
| --- | --- |
| Shared episode picker, generator prerequisites, Pipeline/boards | Repeated shared file reads and duplicate completion refresh fixed; request-scoped facts, explicit refresh and verified completion retained. |
| Scene Plan | Already bounds initial scene rendering to 60; status/deep-link fetch independent of full episode list in 1.4.158. Shared list optimization applies. Full timeline and output validation remain necessary. |
| Scene Review | Already bounds scene rendering to 40, lazy thumbnails, active-only single-flight refresh; full-decode image validation optimized in 1.4.158. Shared list optimization applies. No unchecked images marked complete. |
| Jobs / app background requests | Admission: 927 logged reads (many HTTP 304), queue fast 0–1 ms. Reduced advisory polling; retained authority at dispatch. |
| Settings / Series Formula browsing | Removed second per-project metadata scan; published pack verification still serialized under existing lock. No evidence justifying bypassing that lock. |
| Upload Center | Overview/publishable logs roughly 100 ms; preview median 2247 ms includes exact source revision hashing. Current source uses cached verified revision and visible-page enrichment. No hash/confirmation safeguard removed to fake speed. |
| Audio/Subtitles/Video/Store/storage | Existing scoped reads, media identity/verification and durable operation safeguards retained. Shared episode improvements apply; this pass does not claim measured end-to-end improvement for every action. |
| Memory | Swap alone insufficient evidence of current pressure; no memory-pressure root cause established. No global memory cache added. |

## Verification and release

Focused checks: backend visual-source/sidecar/list: 23 pass; metadata/catalog/effective-format: 41 pass. Frontend completion freshness and Jobs cadence/lifecycle tests cover historical snapshots, in-flight races, project changes, hidden windows, nonoverlap, expiry, and manual actions. After review fixes: useEpisodes 12 pass; Jobs polling 5 pass. Isolated Electron renders the actual Jobs warning fragment at 600px with no overflow, shows current warnings and hides expired facts; screenshots and output saved in logs.

Independent read-only reviewer: pending_performance_inventory, starting faf2ea0c; approved backend/Jobs cadence; identified project-slot and stale-warning gaps addressed in this batch. Final re-review approved with no remaining integration blockers; reviewer ran no tests or long-lived processes.

Initial full verify was deliberately stopped (143) after review findings; it is not a passing release gate. Final `npm run verify` exited 0: backend 5223/472 files; frontend 1804/197 files; release 36/4 files; Content Packs 366 passed + 2 skipped/38 files. Total 7429 passed, 0 failed, 2 skipped. Lint (existing warnings), Electron/frontend type checks, changelog, typography, security (source + built), model drift, release contracts and production builds passed. GitHub Actions confirmed disabled before integration. Integration and canonical-main 1.4.160 DMG pending; final artifact evidence will be saved under canonical `logs/app-speed-audit-1.4.160/release-result.md`. Benchmark scripts/logs are under `logs/app-speed-audit/`; no live customer/project mutations, paid calls, uploads or app restarts performed for the audit. Impeccable detector reports existing inherited accent-border styling; no layout/style changes made as part of performance scope.
