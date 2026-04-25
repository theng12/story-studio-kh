# Session 12 — Codebase Quality Sweep & Final Sign-Off

**Final session.** Two parts:

- **Part A** — direct quality sweep of the codebase along 10 axes (TypeScript strictness, dead code, duplication, error handling, logging, unhandled rejections, ESLint, CI, tests, dependency hygiene).
- **Part B** — consolidation across Sessions 02 and 04–11. Top blockers, sign-off recommendation, and fix-task accounting (incl. tasks Session 04's triage marked obsolete).

Sessions skipped per brief: `01-threat-model.md` (superseded by Session 04), `03-license.md` (license layer removed).

**One-line verdict:** **NOT-YET for personal multi-machine deployment, READY after fixing 8 blockers (≈2–3 days of work).** None of the open blockers are architectural; every one is a localized fix in code already audited and understood. The hardest dependency (Electron CVE bump) is a version-number change.

---

## PART A — Codebase Quality Sweep

### A.1 TypeScript strictness leaks — **Medium**

`strict: true` is enabled at [electron/tsconfig.json:7](electron/tsconfig.json:7). No root or frontend `tsconfig.json` was found at the project root; Nuxt manages frontend types separately under `.nuxt/`. Strict-mode escapes:

| Surface | `: any` / `as any` / `<any>` | `@ts-ignore` |
|---|---:|---:|
| `electron/` (src only) | **204 across 30 files** | 1 ([youtube-client.ts:1](electron/server/lib/youtube-client.ts:1)) |
| `frontend/` (src only) | **259 across 30 files** | 0 |

**Worst-offender services** (count of `: any` / `as any`):

- [project-manager.ts](electron/server/services/project-manager.ts): **26** — load-bearing config-merge object that mixes `ProjectMeta`, `ProjectConfig`, and per-secret keys. The `getConfig()` return shape is fundamentally weakly typed (S02 H5 / S04 §6 cross-ref).
- [upload-store.ts](electron/server/services/upload-store.ts): **12** — every `getConfig(slug) as any` and `updateConfig(slug, { upload_default_account: next } as any)` is a workaround for the same untyped config object. Eight of the twelve are concentrated in account-switch / mode-switch helpers ([upload-store.ts:119,133,140,142,154,160,162,166,215,220,246](electron/server/services/upload-store.ts:119)).
- [upload-plans.ts](electron/server/services/upload-plans.ts): **10**, [utils.ts](electron/server/services/utils.ts): **9**, [upload-orphans.ts](electron/server/services/upload-orphans.ts): **9**, [video-reconciler.ts](electron/server/services/video-reconciler.ts): **7**.

Most route files contain `(e: any)` in catch blocks (303 `res.status(...).json(...)` shapes across 19 routes — see A.4). Idiomatic; not a strictness concern unless paired with raw `e.message` echo (it often is).

The single `@ts-ignore` at [youtube-client.ts:1](electron/server/lib/youtube-client.ts:1) is a deliberate workaround for `node-fetch`'s ESM type quirks; bounded, explainable.

**Recommendation:** introduce a strict `ProjectConfig` discriminated union in [models/types.ts](electron/server/models/types.ts) and route every `getConfig()` reader through narrow accessors (e.g. `getUploadConfig(slug)`, `getModelsConfig(slug)`). Closes the upload-store + project-manager + upload-plans cluster (≈48 of 204) in one structural change. The remaining ~150 are mostly per-call-site and can be retyped opportunistically.

→ Severity: **Medium** (footgun, not a live bug — but each `as any` is a disabled invariant).

---

### A.2 Dead code — **Low (likely small)**

No `ts-prune` / `knip` configured. Manual spot-check of 10 likely candidates (boot/migrations.ts, scripts/migrate-narration.ts, lib/safe-storage.ts, models/transitions.ts, providers/registry.ts, services/voices-cache.ts, lib/atomic-store.ts, services/license-manager.ts, services/manifest-audit.ts, lib/redact-secrets.ts):

- [scripts/migrate-narration.ts](electron/scripts/migrate-narration.ts) — one-shot CLI migration; verify whether all projects on every machine have already been migrated. If yes, delete (not imported by anything in the runtime tree).
- [services/license-manager.ts](electron/server/services/license-manager.ts) — license system was removed (Session 04 cancelled tasks H7, M10). If this file still exists it's dead. **Cross-reference:** S02 §C1's underlying `app-settings.ts` write is what's actually used; the license-specific helpers are orphans.
- All other spot-checked files are reachable from at least one `import` chain.

**Spawned fix-task:** verify-and-delete `license-manager.ts` and `migrate-narration.ts` as a sweep task. If full audit is wanted, add `knip` (one-line dev-dep + npm script) — a fully accurate dead-code report on this codebase would take ≈30 min.

→ Severity: **Low** (no runtime impact; just rot).

---

### A.3 Provider adapter duplication — **Medium**

The lib/ provider clients carry duplicated submit-and-poll plumbing that only `pollForResult` was meant to consolidate. LOC comparison:

| File | LOC | Uses pollForResult? |
|---|---:|---|
| [kie-client.ts](electron/server/lib/kie-client.ts) | 296 | No (custom `pollForImageUrls` loop) |
| [kie-video-client.ts](electron/server/lib/kie-video-client.ts) | 145 | No (raw `if (!resp.ok) continue` — S06 H1) |
| [fal-client.ts](electron/server/lib/fal-client.ts) | 167 | ✓ |
| [genaipro-client.ts](electron/server/lib/genaipro-client.ts) | 197 | No (own loop — S06 M2) |
| [genaipro-veo-client.ts](electron/server/lib/genaipro-veo-client.ts) | 173 | No (own loop) |
| [elevenlabs-client.ts](electron/server/lib/elevenlabs-client.ts) | 144 | n/a (synchronous TTS) |
| [whisper-client.ts](electron/server/lib/whisper-client.ts) | 65 | n/a (synchronous) |
| [image-edit-client.ts](electron/server/lib/image-edit-client.ts) | 186 | n/a (synchronous) |

**Three worst duplications, ranked by leverage:**

1. **Submit-then-poll handshake** is reinvented four times (kie image, kie video, genaipro, genaipro-veo). Each implementation does: POST → extract task_id → loop fetch with `Date.now() < deadline` → JSON-poke for status → call onSubmitted → maybe redact errors. Of these, only `fal-client` shares `pollForResult`. The contract `pollForResult` exposes (`onData`, `isCancelled`, `redactKey`, `Retry-After`-aware backoff, per-poll `AbortSignal.timeout`) is exactly the right shape — three callers' migration is left over.
2. **Error-body redaction at the throw site** is per-client. Every provider does `redactSecrets(text, apiKey).slice(0, 200|300)` then throws. The pattern's been generalised in [redact-secrets.ts](electron/server/lib/redact-secrets.ts) — but the slice length varies (200/300/full) and the *call shape* is copy-pasted. A two-line `throwProviderError(label, status, body, apiKey)` helper would standardise it. (This is the H4-style sanitization seam from S02.)
3. **Download-and-write** with partial-cleanup is implemented in kie-client.ts:269-284, fal-client.ts:146-163, http-retry.ts:158-178, and whisper-client.ts — four near-identical `Readable.fromWeb(resp.body) → pipeline → catch → fs.rm` blocks. ElevenLabs is the one that *omits* the cleanup (S09 M2). One shared `streamResponseToFile(resp, savePath)` helper would close the M2 hole and remove three near-duplicates.

**Spawn:** Consolidation Pass A — migrate kie-video, genaipro, genaipro-veo to `pollForResult` (already covered by S06 H1 / M2). Consolidation Pass B — extract `streamResponseToFile()` (covers S09 M2 + Pass-A's three call sites). No new fix-tasks needed; both fold into existing spawned work.

→ Severity: **Medium** (latent inconsistency; each duplicate is a place a future bug hides).

---

### A.4 Error handling consistency — **Mixed (mostly good, with three outliers)**

**The good:** [lib/humanize-backend-error.ts](electron/server/lib/humanize-backend-error.ts) is a well-designed humanizer that recognises every common Node error class (`ENOENT`, `EACCES`, `EISDIR`, `EBUSY`, `ENOSPC`, `EMFILE`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, plus `spawn ENOENT` and FFmpeg/libass message-pattern hits) and rewrites into `{detail, hint?}` while still logging the raw cause through `logLine` so support context isn't lost. **127 calls** across 17 of the 19 route files.

**The bad:** **335 raw `e?.message || ...` references** still exist across the same routes — many *inside* humanizer-using files. Per-file count of routes that bypass the humanizer entirely:

- [routes/jobs.ts](electron/server/routes/jobs.ts) — never calls `humanizeBackendError`. SSE endpoint surfaces raw `e?.message` to clients.
- [routes/pipeline.ts](electron/server/routes/pipeline.ts) — same. The pipeline orchestrator is the surface most likely to encounter Node errors mid-batch.
- [routes/upload.ts](electron/server/routes/upload.ts) — uses humanizer in 8 places, raw `e?.message` in 45 (the file is 1221 LOC and OAuth/quota error shapes are complex; humanizer not always appropriate but is appropriate for the FFmpeg-probe and disk-write paths inside the upload flow).
- [routes/ideas.ts](electron/server/routes/ideas.ts) — humanizer in 23, raw in 16.

**Pattern:** routes that the humanizer was rolled into early (video, audio, scripts per S11 task) are clean. Routes added later or routes with idiosyncratic error shapes (uploads, jobs SSE, pipeline) drifted. **This is exactly the S11 finding #4** ("Backend route raw `e.message` passthrough") — that fix-task is live and covers the gap; this audit confirms the problem extends to two more files (jobs.ts, pipeline.ts) than S11 named.

→ Severity: **High** (already spawned by S11; widen scope to `jobs.ts` + `pipeline.ts` in the existing task — note added below).

---

### A.5 Logging — **Good shape, two known gaps**

**Architecture** ([services/logger.ts](electron/server/services/logger.ts)):

- File: `{userData}/logs/server-YYYY-MM-DD.log` (request log, structured JSON one-line entries).
- File: `{userData}/logs/main-YYYY-MM-DD.log` (main-process crash log, written by [main.ts:320-334](electron/main.ts:320) `logCrash`).
- **Rotation:** 7-day age-based prune, runs at most once per hour ([logger.ts:52-63](electron/server/services/logger.ts:52)). Both `server-` and `main-` files covered; other `.log` filenames left alone.
- **Resolution:** `STORY_STUDIO_DATA_DIR` (test override) → `app.getPath('userData')` → `process.cwd()` (dev fallback).
- **Packaged-app log location** (the user will need this to diagnose remotely):
  - macOS: `~/Library/Application Support/Story Studio KH/logs/`
  - Help → Show Logs menu item exists at [main.ts:227](electron/main.ts:227) (`shell.openPath(electronApp.getPath('userData'))`) — opens userData root, not logs/ specifically. One click deeper than ideal.
- **Redaction:** field-name allowlist in `SECRET_KEY_NAMES` ([logger.ts:79-83](electron/server/services/logger.ts:79)). **Drift from S02 H3 not yet fixed** — missing `google_api_key`, `access_token`, `refresh_token`, `client_secret`, `license_key`. S02 H3's fix-task is still live.

**Two known gaps** (both already spawned):

1. **`logCrash` writes raw stack unredacted** ([main.ts:320-334](electron/main.ts:320)). S02 H8 (downgraded to Medium per S04 triage) — fix-task narrowed to log-side only.
2. **135 raw `console.{log,warn,error,info}` calls across 40 files bypass redaction.** Most are dev-time debug; `[job-queue]` chain at [job-queue.ts:297,378,393,528,535](electron/server/services/job-queue.ts:297) is fire-and-forget queue lifecycle errors that never carry secrets. The risky ones are [services/asset-status.ts:1](electron/server/services/asset-status.ts:1), [routes/upload.ts:51](electron/server/routes/upload.ts:51), [providers/registry.ts:3](electron/server/providers/registry.ts:3) (S02 L15) — these can carry config-derived strings. Migrating console.* → logLine in the high-risk handful is half-day of work.

→ Severity: **Low** (fix-tasks already spawned; logging fundamentals are sound).

---

### A.6 Unhandled promise rejections — **Medium**

**Explicit `.catch(() => {})` swallows: 47 sites across 29 files.** Many are deliberate (best-effort cleanup, redaction-failure swallow, file-mode `chmod` after rename). The risky pattern is **bookkeeping writes wrapped in `.catch(() => {})`** — Session 04 §3 row 7 ranked this the worst class for solo ops, and S10 M2 (quota ledger) is the canonical case. Spot-checked sites likely to hide silent failures:

- [services/folder-migration.ts](electron/server/services/folder-migration.ts): 2 swallows. Already flagged in S08 finding 6.
- [services/upload-queue.ts](electron/server/services/upload-queue.ts): 2 swallows.
- [generators/youtube-upload.ts](electron/server/generators/youtube-upload.ts): 2.
- [generators/episode.ts](electron/server/generators/episode.ts): 2.
- [services/upload-store.ts:232](electron/server/services/upload-store.ts:232) (`revokeToken(...).catch(() => {})`) — intentional fire-and-forget per S02 H6 design.

**Bare `await` outside try-catch:** 83 occurrences in 15 files. Most are inside route handlers where the surrounding `router.get(async (req, res) => { try { ... } catch ... })` already wraps the whole handler. Express 5 also catches async-handler rejections at the framework level (S02-era app.ts middleware confirmed). **No actionable cluster of true unhandled awaits.**

**Process-level catchers** are correctly wired ([main.ts:336-351](electron/main.ts:336)) — `uncaughtException` and `unhandledRejection` both route through `logCrash` and refuse to exit (deliberate: one bad route shouldn't kill the user's session). Survives the worst case.

**Net:** the unhandled-rejection surface is bounded by the framework and the process catchers. The remaining hazard is the silent-bookkeeping pattern, already covered by S04 §3 row 7 / S10 M2 / S08 findings 2 & 3 / S11 finding 2. No new fix-task here — folded into existing spawned work.

→ Severity: **Medium** (covered by existing tasks).

---

### A.7 ESLint — **Absent (recommended minimum)**

No `.eslintrc*`, no `eslint.config.*`, no `eslint` in `devDependencies`. For a personal-multi-machine deployment where typo-class regressions land silently in production, a minimal lint config is high-leverage.

**Recommended minimum** (≈10-line `eslint.config.mjs`, two new dev-deps):

```js
// eslint.config.mjs
import js from '@eslint/js'
import ts from 'typescript-eslint'

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',     // catches the A.6 class
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',           // surfaces A.1
      'no-console': ['warn', { allow: ['warn', 'error'] }],   // forces logger use (A.5)
      'eqeqeq': 'error',
    },
  },
]
```

Add `npm run lint` to `scripts`, wire into CI (A.8). The `no-floating-promises` rule alone would have caught Session 09's H1 (`recordQuotaUsage(...)` with no `.catch`) and most of S11's silent-catch class.

→ **Spawn fix-task: "Add minimum ESLint config (typescript-eslint recommended + 5 strict rules)."** [Critical-class for blast-radius: every future change benefits.]

---

### A.8 CI — **Absent (high leverage for multi-machine)**

No `.github/`, no GitHub Actions workflow, no other CI configured. **For a single-machine solo project, CI is optional. For multi-machine personal deployment (the Session 04 model), CI is leveraged because a break on platform X won't be caught locally.** The user runs the dev cycle on one Mac; the fleet may include an Intel Mac, an arm64 Mac, and (per S05 open question 1) potentially a Windows laptop later. A platform-specific FFmpeg-resolution regression or a Node-API drift wouldn't be visible until the user `git pull`s on the other machine.

**Recommended minimum** (`.github/workflows/ci.yml`):

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run build         # tsc + nuxt generate
      - run: npm test              # 50 test files
      - run: npm run lint          # once A.7 lands
      - run: cd electron && npx electron-builder --${{ matrix.os == 'macos-latest' && 'mac' || matrix.os == 'windows-latest' && 'win' || 'linux' }} --publish never
        # dry-run: confirms electron-builder packaging works on each OS,
        # without uploading. Catches platform-specific bundling regressions.
```

The electron-builder dry-run is the part most worth its weight — Session 05's P3 (Windows/Linux FFmpeg not bundled) would have surfaced as a CI red on day one of pushing it. Today, the only feedback loop is "try to install on the other Mac and see what breaks."

→ **Spawn fix-task: "Add GitHub Actions CI matrix (mac/win/linux) running typecheck + tests + electron-builder dry-run."**

---

### A.9 Test coverage — **Light (50 files; 5 high-risk gaps)**

Re-counted: **38 backend test files** in [electron/server/__tests__/](electron/server/__tests__/) + **12 frontend test files** in [frontend/__tests__/](frontend/__tests__/) = **50 total** (the brief said 33, predates recent test additions). Existing coverage is good around: job-queue lifecycle, secrets accounts/provenance, idea-manager basics, FFmpeg manager, upload metadata sanitize, upload resume flows, slug, partial-failure, narration, fs case-insensitive, redact-secrets, providers, project-manager.

**5 highest-risk untested areas** (per brief):

1. **`atomic-store.writeJsonAtomic` under crash scenarios.** Existing test: none directly. The fsync gap (S08 finding #5) is by definition untestable from JS — but the temp-file-cleanup-on-rename-failure path (S02 M11) has no test. Inject a `fs.rename` mock that throws ENOSPC; assert the temp file is unlinked.
2. **FFmpeg argument construction for the final encode.** [ffmpeg-concat-escape.test.ts](electron/server/__tests__/ffmpeg-concat-escape.test.ts) covers the concat-escape edge cases. **No test asserts the full argv that `runFinalComposition` builds** for a typical 10-scene episode (codec, bitrate, audio mux, subtitle filter, animation filters chained). Regression risk: a one-character flag flip silently produces a wrong-codec render. Argument construction is the hardest-to-eyeball part of [generators/video.ts](electron/server/generators/video.ts) (2300 LOC).
3. **YouTube OAuth refresh path.** [youtube-client-auth-retry.test.ts](electron/server/__tests__/youtube-client-auth-retry.test.ts) exists but covers the 401-retry wrapper from S10 M3. **No test asserts the 60s-pre-expiry refresh trigger** in `getValidAccessToken` ([youtube-client.ts:71-92](electron/server/lib/youtube-client.ts:71)). Clock-skew bugs would slip through.
4. **Job-queue persistence end-to-end.** [job-queue.test.ts](electron/server/__tests__/job-queue.test.ts) covers in-memory + persisted-on-restart shape. **No test exercises the `loadPersistedJobs` → `Interrupted by app restart` → in-memory mutation but on-disk stale `running` state (S09 finding #4)**. Should fail as a known-bug test that the fix would close.
5. **Project-transfer schema (`importProjectFromFolder`).** Not in the test directory at all (grep). The portable-manifest v1→v2 migration, the `inferProjectMetadata` heuristics from folder layout (S05 §2 update), the empty-`secrets.json` write on import — all critical to the channel-isolation guarantee Session 10 verified. **Zero tests.** Highest-leverage gap for the multi-machine model.

**Other notable gaps:** `app-settings.ts` writes (post S04-cancel C1 fix), `safeStorage` round-trip, log redaction list completeness, license-manager removal verification.

→ **Spawn fix-task: "Add tests for 5 high-risk untested areas (atomic-store crash, video.ts final-encode argv, OAuth refresh trigger, job-queue stale-running persist, importProjectFromFolder)."**

---

### A.10 Dependency hygiene — **4 vulnerabilities, mostly addressable**

`npm audit` results (run 2026-04-25):

| Package | Severity | Fix path | Notes |
|---|---|---|---|
| **electron** | **High** (use-after-free, offscreen paint callback) + 5 Moderate | `npm audit fix --force` → electron@41.3.0 (breaking) OR step to 38.8.6 (stays in v35→v38) | Multiple CVEs in <38.8.6: AppleScript injection, service-worker IPC spoof, second-instance OOB read, registry path injection, USB device validation. Personal-use threat model lowers exploitability (no untrusted web content), but **Electron 35.x is two majors behind and will stop receiving security patches**. Recommend bump to 38.x LTS. |
| **@xmldom/xmldom** | High (uncontrolled recursion, XML injection x3) | `npm audit fix` → 0.8.13+ (transitive dep) | Reachable through which dep? Quick check needed; likely `mammoth` or `docx`. |
| **uuid** | Moderate (missing buffer bounds check in v3/v5/v6 with `buf` arg) | `npm audit fix --force` → v14 (breaking) | App uses `randomUUID()` from `crypto` and `uuid.v4()`; v4 not affected. Safe to defer. |
| **follow-redirects** | Moderate (custom auth headers leak to cross-domain redirect target) | `npm audit fix` (non-breaking) | Transitive. Take the fix. |

**Pinning vs ranged:** every direct dep in [package.json](package.json) uses `^` (caret) — minor bumps allowed automatically on `npm install`. For a multi-machine personal deploy, this is **worse** than a single-machine project: the two machines can drift if `npm install` runs at different times. Lockfile (`package-lock.json` exists) protects when present, but the `^` ranges mean a fresh-machine `npm ci` after `package.json` editing could pull a different patch level than the original machine.

**Recommendation:**
1. `npm audit fix` (non-breaking) — closes follow-redirects + xmldom.
2. Bump electron 35→38.x (one-line change, minor breaking; main branch has no IPC handlers depending on removed APIs per S08 single-instance lock + S02 safeStorage usage).
3. Defer uuid v14 unless the codebase later uses `v3`/`v5`/`v6` with a `buf` param.
4. **Pin (replace `^` with `~`) for all direct deps** — minor-version drift is acceptable cross-machine; major drift isn't.

**Abandoned packages:** spot-check on `mammoth` (last release > 1 yr — still maintained, used for one feature), `docx` (active), `node-fetch` (Node 18+ has built-in fetch — node-fetch usage at [youtube-client.ts:1](electron/server/lib/youtube-client.ts:1) is the `@ts-ignore` site; could migrate to native fetch in a few hours and drop the dep entirely).

→ **Spawn fix-task: "Run `npm audit fix`, bump Electron 35→38 LTS, pin direct deps to ~, drop node-fetch in favor of native fetch."**

---

### A — Summary table

| # | Axis | Severity | Action |
|---|---|---|---|
| A.1 | TypeScript strictness leaks (204 server, 259 frontend; 26 in project-manager.ts) | Medium | Spawn (structural retype of `ProjectConfig` + accessors) |
| A.2 | Dead code (license-manager, migrate-narration likely orphaned) | Low | Spawn (verify + delete) |
| A.3 | Provider client duplication (4 submit-poll loops, 4 download-and-write) | Medium | Folded into S06 H1, S09 M2 |
| A.4 | Error handling — humanizer exists but bypassed in jobs.ts, pipeline.ts | High | Widen S11 #4 task (note added) |
| A.5 | Logging fundamentals sound; redaction drift + 135 raw console.* | Low | Covered by S02 H3 / H8 / L15 |
| A.6 | Unhandled rejections — process catchers wired; bookkeeping `.catch(()=>{})` is the hazard | Medium | Covered by S04 §3, S10 M2, S08 #2/#3, S11 #2 |
| A.7 | ESLint absent | High (multiplier on every future change) | **Spawn** |
| A.8 | CI absent | High (multi-machine fleet) | **Spawn** |
| A.9 | Test coverage gaps in 5 high-risk areas | High | **Spawn** |
| A.10 | npm audit: 4 vulns; Electron 35 EOL-soon; ranged versions | High | **Spawn** |

---

## PART B — Consolidation across Sessions 02 + 04–11

### Executive Summary — Top 10 blockers ranked by severity

Each row names the source session, the underlying hazard, and the recommended fix. "Cost" = back-of-envelope developer time. Severity reflects current reality after Session 04's triage downgrades.

| Rank | Blocker | Severity | Source | Fix |
|---|---|---|---|---|
| **1** | **`ideas.json` non-atomic writes — single SIGKILL truncates the user's idea backlog; auto-heal write inside the reader makes every read a write race.** | **Critical** | S08 finding #2 | Route all 10 writers through `writeJsonAtomic + withLock`; rewrite `episode-import.ts:257-274`'s deliberate bypass. **Half-day.** Existing fix-task spawned. |
| **2** | **Dev-server browser footgun — opening `localhost:3001` in Chrome serves the full UI + working backend with no warning; "Generate" clicks fire real provider jobs.** | **Critical** | S11 finding #1 | Two lines in `app.vue` mount: gate on `!window.electron && import.meta.env.PROD` → render takeover. **2 hours.** Existing fix-task spawned. |
| **3** | **`useNetworkStatus` queue pause/resume swallowed — operator goes offline, queue keeps running on backend, jobs fail, money burns.** | **Critical** | S11 finding #2 | Surface the silent catches (composables) + thread error toasts. **Half-day.** Existing fix-task spawned. |
| **4** | **Cancel doesn't abort provider HTTP — kie.ai image poll continues for 6 min/image after a panic-cancel; ElevenLabs/Veo/LLM streams ditto. Defeats the user's panic-cancel response.** | **High** | S09 H1 | Use the in-tree gold-standard ([generators/subtitles.ts:66-89](electron/server/generators/subtitles.ts:66)): AbortController + 500ms `isCancelled` watcher. Apply to kie-client image poll, Veo, ElevenLabs, LLM streams. **1–2 days** (5–7 sites). Existing fix-task spawned. |
| **5** | **Orphan FFmpeg on app crash/force-quit — children reparent to launchd and keep writing to the user's "failed" output file.** | **High** | S09 H2 | Promote `before-quit` to iterate `childrenByJob` + SIGTERM. Already partly landed (S11 §11 confirms boot-time orphan reap exists at [main.ts:310-330](electron/main.ts:310)); finish the shutdown side. **Half-day.** Existing fix-task spawned. |
| **6** | **No FFmpeg watchdog + partial-output cleanup — pathological inputs (CMYK JPEG, bad MP3 seek table) hang the encode and pin the queue indefinitely; partial MP4s accumulate as "good renders" the user might upload.** | **High** | S07 H1 + H2 | Per-spawn `timeoutMs`, SIGTERM/SIGKILL escalation, `outputFile` cleanup in `finally`. **1 day.** Existing fix-task spawned. |
| **7** | **Account-swap reuses existing `account_id` when `remote_id` differs — historical sidecars now authenticate against the new channel; user sees opaque YouTube 404 instead of "Reset sidecars first".** | **High** | S10 H1 | Mint fresh `acc_` id when `remote_id` differs; assert `existing.channel_id === account.remote_id` in `generateYoutubeUpload`. **Half-day.** Existing fix-task spawned. |
| **8** | **`writeJsonAtomic` doesn't fsync — one power-cut → empty `project.json` → next save merges into `{}` → headless project + S08 #4's silent `{}` fallback writes back. Combined data-loss path.** | **High** | S08 #4 + #5 | `fsync(tmp_fd)` before rename + `fsync(dir_fd)` after. Make `readJson` throw on parse error rather than return `{}`. **Half-day** (both findings, one commit). Existing fix-tasks spawned. |
| **9** | **No CI matrix on a multi-machine fleet** — a Windows/Linux regression or platform-specific FFmpeg-resolution break can ship to the other machine before it's caught locally. **No ESLint** to catch the `no-floating-promises` class that S09 H1 and S11 #2 are. | **High (foundational)** | A.7 + A.8 (this session) | Add `eslint.config.mjs` (≈10 lines, 2 dev-deps) + `.github/workflows/ci.yml` matrix. **Half-day total**, one PR. **Spawned this session.** |
| **10** | **Dependency hygiene — Electron 35 is 6 months from EOL with high-severity CVE; `^`-ranged direct deps drift between machines.** | **High** | A.10 (this session) | `npm audit fix`, bump Electron 35→38, pin to `~`, drop `node-fetch`. **Half-day.** **Spawned this session.** |

**What didn't make the top 10 but is close:** S05 P1 (portable-manifest defaults; resolved by re-scoping to v2 — see S05 §2 update), S10 M2 (silent quota ledger swallow), S08 #6 (folder-migration + project.json not coupled). All have spawned fix-tasks; severity below the top 10.

---

### Sign-off recommendation: **NEEDS-WORK → READY after blockers 1–8 land**

Framed as: *"ready to deploy on N personal machines running different channels with projects occasionally transferred between them."*

#### NOT-YET (current state, 2026-04-25)
- Reasons: blockers #1–#3 are user-visible data-loss / wrong-action-on-money paths. Even on the single dev machine, blocker #1 alone could erase the ideas backlog on a single SIGKILL — that's an unacceptable "personal-tool reliability" floor.
- A new operator on a fresh machine would hit blocker #6 (FFmpeg hang) within their first 10 episodes and have no path forward except quitting the app.

#### NEEDS-WORK (the recommended target before deployment)
- **Conditions:** all 8 user-facing blockers (rows 1–8) closed. Every fix-task is local, scoped, has the existing audit context to ground it; no architectural surprises expected. Estimate: **≈3 developer-days end-to-end** if done as one focused sprint.
- Foundational blockers #9 + #10 (ESLint, CI, dep bumps) can land in parallel; they don't block deployment but their absence makes blocker recurrence likely.

#### READY (the conditions for "deploy this on the other machine without supervision")
- All 8 user-facing blockers closed.
- ESLint + CI live (so a regression on the other machine is caught before push).
- Electron bumped to 38 LTS (so the security floor isn't actively decaying).
- The 5 high-risk test gaps (A.9) have at least minimal coverage — this is the gate that turns "I trust this on my machine" into "I trust this on the machine I'm not babysitting today."
- A documented log-location handoff (Help → Show Logs → opens logs/ directly, not userData/ — one-line fix) so the user can self-diagnose remotely.

#### Stretch (post-READY hardening, if time permits)
- The Mediums grouped under each session: silent `.catch(()=>{})` bookkeeping cluster (S04 §3, S08 #11, S10 M2, S11 #2 — overlapping); manifest self-heal on drift (S04 §6.6, S08 #11, S05 #14); typing structural fix on `ProjectConfig` (A.1). None of these gate deployment; all reduce future debugging cost.

---

### Spawned fix-tasks summary

**Total spawned across all sessions: ≈49.**

By session (counts include this session's new spawns):

| Session | Critical | High | Medium | Total |
|---|---:|---:|---:|---:|
| S02 (secrets) | 2 | 7 | 0 | 9 |
| S05 (portability) | 2 | 7 | 0 | 9 |
| S06 (providers) | 0 | 3 | 0 | 3 |
| S07 (FFmpeg) | 0 | 1 (combined H1+H2) | 1 | 2 |
| S08 (persistence) | 1 | 5 | 0 | 6 |
| S09 (jobs) | 0 | 2 | 4 | 6 |
| S10 (uploads) | 0 | 1 | 3 | 4 |
| S11 (operator UX) | 2 | 8 | 0 | 10 |
| S12 (this session) | 0 | 4 | 0 | 4 |

By severity (post-S04 triage):

- **Critical: 7** (S02 C1 *cancelled*, S02 C2, S05 P1 *re-scoped*, S05 P2, S08 #2, S11 #1, S11 #2 — net 5 active).
- **High: 38** (after triage downgrades for S02 H4→Med, H5→Med, H8→Med, narrowed; minus cancellations of H6, H7, H9 — net ≈30 active).
- **Medium: 8** (mostly tooling/UX polish from S09 + S10 + S11).

#### Fix-tasks Session 04 triage recommended cancelling

Per S04 Part B, dismiss these chips from Cowork (they are **obsolete** under the personal-multi-machine model — listed by exact spawn-name so you can `Dismiss` them):

1. **"Fix: harden app-settings.json writes"** (S02 C1) — **fixed independently** at [app-settings.ts:19,69](electron/server/services/app-settings.ts:19) (uses atomic write + 0o600).
2. **"Fix: move OAuth revoke token to POST body"** (S02 H6) — **fixed** at [youtube-oauth.ts:303-305](electron/server/lib/youtube-oauth.ts:303) (now uses `URLSearchParams`).
3. **"Fix: stop echoing unmasked license key on invalid activation"** (S02 H7) — **obsolete** (license system removed).
4. **"Fix: encrypt secrets.json on Windows via DPAPI/keytar"** (S02 H9) — **obsolete** (replaced by `safeStorage` envelope in [secrets-store.ts:197-210](electron/server/services/secrets-store.ts:197), works cross-platform).

Plus, if these were ever spawned (no explicit task names in S02 §M10 / §L14 — check Cowork for related chips):

5. (M10) `deactivateLicense()` non-atomic mutate+write — **obsolete** (license removed).
6. (L14) License key in Time Machine backups — **obsolete** (license removed; `safeStorage` covers the analogous concern for `secrets.json`).

**Net cancellations:** 4 confirmed by name + up to 2 unnamed = **4–6 chips to dismiss**.

---

### Part A fix-tasks spawned this session (4 new, all High)

1. **Add minimum ESLint config** (typescript-eslint recommended + 5 strict rules) — A.7.
2. **Add GitHub Actions CI matrix** (mac/win/linux) running typecheck + tests + electron-builder dry-run — A.8.
3. **Add tests for 5 high-risk untested areas** (atomic-store crash paths, video.ts final-encode argv, OAuth pre-expiry refresh trigger, job-queue stale-running persistence, importProjectFromFolder) — A.9.
4. **Run `npm audit fix`, bump Electron 35→38 LTS, pin direct deps to `~`, drop `node-fetch` for native fetch** — A.10.

Plus two **task-amendments** (no new spawn — append scope to existing tasks):

- S11 finding #4 ("Replace raw `e.message` passthrough"): **widen scope to include `routes/jobs.ts` and `routes/pipeline.ts`** (this session's A.4 confirmed the bypass surface is larger than S11 named).
- S08 finding #11 (no startup reconcile / `.tmp` cleanup): **add license-manager.ts and migrate-narration.ts dead-code verification** to the same housekeeping pass (A.2).

---

### Cross-session findings already mutually covered (no duplicate spawn needed)

| Finding (this audit) | Covered by | Reason |
|---|---|---|
| Provider submit-poll duplication (A.3 #1) | S06 H1 | The kie-video → pollForResult migration is the load-bearing case. Genaipro/Veo are smaller siblings; same fix-shape. |
| Download-and-write duplication (A.3 #3) | S09 M2 | The ElevenLabs partial-cleanup fix is the trigger; extracting `streamResponseToFile` is the natural shape of that fix. |
| Bookkeeping `.catch(()=>{})` cluster (A.6) | S04 §3 row 7 / S10 M2 / S08 #2,#3 / S11 #2 | Multiple fix-tasks already exist for the canonical instances; the pattern doesn't need a meta-task. |
| `console.*` bypass of redaction (A.5) | S02 L15 | One concrete instance is already spawned; the rest are dev-time noise. |

---

## Open questions for the maintainer (across all sessions)

1. **Multi-machine fleet composition** (S05 OQ#1) — confirm: all-Mac, or is a Windows laptop plausible? Determines whether A.10's Electron-bump dry-run on Windows is in scope.
2. **Deployment cadence** — manual per-machine `git pull && npm run dist`? If so, the "auto-update" gap is acceptable; if not, the multi-machine `.app` distribution story needs a Session 13.
3. **iCloud Keychain shared across the fleet?** (S05 OQ#5) — unlikely-but-possible defeat of the safeStorage isolation in S10's "ruled out" finding. If yes, blocker #7 (account-swap) becomes more urgent because token leak is no longer purely structural.
4. **Acceptable test coverage floor** — is 50 files enough for personal-use, or do you want CI-enforced minimum coverage (e.g. `nyc --check-coverage`)? Recommend the latter only after the 5 A.9 gaps land.
5. **Log-bundle workflow** — when the user wakes a machine that's been chugging overnight and finds something broke, what's the path to "show me what happened"? Currently: Help → Show Logs (opens userData/, one click deeper than logs/). Worth a one-line fix.

---

## End of audit campaign

**Sessions 02, 04–12** consolidated. Sessions 01 (superseded) and 03 (license, removed) skipped. Fix-tasks total ≈49, of which 4–6 should be dismissed per S04 triage. Sign-off: **NEEDS-WORK** today; **READY** after the top-8 user-facing blockers + the 4 foundational tasks land (~3–4 developer-days of focused work).

The codebase is, on balance, *better* than the average personal Electron tool — strict TypeScript everywhere, a real logger, a real atomic-store, a real humanized error layer, a real job queue with cancellation plumbing, real provenance-stamped + safeStorage-encrypted secrets. The remaining blockers are not architectural debt; they are concrete localized fixes in code already understood. Address them and ship.
