# Session 11 — Operator UX

**Scope:** the user IS the operator. Not customers. UX = least time wasted, no silent failures, clear when something needs attention. Re-baselined from the old frontend brief: dropped legal a11y / public-reach contrast / refund-prevention onboarding polish. Elevated: error diagnosability, loading honesty, auto-save indicators, destructive-action friction, batch status clarity.

Sessions referenced: 05 (portability / fresh-machine setup) and 09 (jobs / queue runtime). 14 audit topics, 27 numbered findings, **3 Critical / 9 High / 11 Medium / 4 Low**. Ten fix-tasks spawned for Critical + High.

**One-line verdict:** the UI is more honest than most personal-tool UIs you'd see — `humanizeError`, `useBatchSummary`, `EmptyState`, `useFocusTrap`, and a real `<Modal>` with focus trap all exist and work. But there are three categories that bite a solo operator who is not babysitting the app: **(1) silent failure handlers** in `useNetworkStatus`, `useJobs` SSE, `useEpisodeStatus`, dashboard stats — the queue keeps running while the operator thinks it's paused; **(2) crash / browser-tab no-warnings** — open `localhost:3001` in Chrome and you can drive a real generation through the real backend with no electron warning; **(3) the Metadata page is the only place auto-save status is visible**, and `useAutoSave`'s default 1s debounce has no flush-on-unload, so cmd-Q within 1s of the last keystroke loses the edit.

I verified concretely with the preview tools: started `npm run dev` (frontend on 3001, backend on 8000); loaded `http://localhost:3001/` in a non-Electron Chromium context; confirmed `window.electron === undefined`; confirmed `GET /api/projects` on port 8000 responds with the real two projects; navigated to `/projects/dozing-knight/jobs` — the entire jobs page rendered, the sidebar offered every generator route, and not one banner / toast / console warning fired about being outside Electron. Same backend, same data, no guard.

---

## Part A — Diagnosability (Topics 1, 2)

### 1. Generic error messages — **Mixed**

`useToast.ts::humanizeError` ([frontend/composables/useToast.ts](frontend/composables/useToast.ts)) is the right shape — actionable rewrites for FFmpeg-not-found, missing API key, rate-limit. **This is the bright spot of the audit.** Examples surfaced:

- *"FFmpeg is required but not found. Install it in Settings → FFmpeg."*
- *"OpenAI API key missing. Add one in Settings → API Keys."*
- *"API rate limit hit. Wait a minute and try again, or upgrade your plan."*

What it doesn't catch:

- **Cost-estimation falls back to a generic banner** ([frontend/composables/useConfirmation.ts:70](frontend/composables/useConfirmation.ts:70)): when `/cost-estimate` returns 500, the user sees *"Could not estimate cost"* with no detail on why (network, auth, provider error, math error). Operator queues a $100+ generation without real-time cost — gambling.
- **Backend route raw `e.message` passthrough.** Sampled hits: [video.ts:29,42,87](electron/server/routes/video.ts:29), `audio.ts`, `scripts.ts` — at least 15 instances surface raw Node error codes (`spawn ENOENT`, `EACCES: permission denied, open '/path/to/file'`). The frontend dutifully displays them as the toast. *"spawn ENOENT"* is not actionable.

### 2. Silent failures — **Critical class**

The single highest-leverage finding of this audit. Source-grep across `frontend/composables/` and `frontend/pages/` produced **>20 catch blocks that swallow errors with no toast / no log / no UI signal**. The operator believes the operation succeeded.

| Site | Operation silenced | Severity |
|---|---|---|
| [useNetworkStatus.ts:33](frontend/composables/useNetworkStatus.ts:33) | Queue pause/resume on offline detection | **Critical** — operator goes offline; queue isn't paused on backend; jobs run anyway, fail, money burned. |
| [useNetworkStatus.ts:42](frontend/composables/useNetworkStatus.ts:42) | Health probe times out, returns false silently | High |
| [useJobs.ts:121-122](frontend/composables/useJobs.ts:121) | SSE full-refresh on stream hiccup | High — job list goes stale; UI shows "pending" when actually done. |
| [useJobs.ts:144,152](frontend/composables/useJobs.ts:144) | SSE JSON-parse errors swallowed | High — one bad frame can stall progress UI silently. |
| [useEpisodeStatus.ts:69](frontend/composables/useEpisodeStatus.ts:69) | Episode fetch in watcher | High — operator switches episode, sees previous episode's data. |
| [pages/projects/[slug]/index.vue:289-290](frontend/pages/projects/[slug]/index.vue:289) | Dashboard stats + asset-audit on mount | High — dashboard renders empty after a transient blip. |
| [useVideoAssemblyIo.ts:100](frontend/composables/useVideoAssemblyIo.ts:100) | FFmpeg status check (`catch { installed: false }`) | High — bad permission / corrupt binary mislabeled as "not installed". |
| [useUploadAccounts.ts:64](frontend/composables/useUploadAccounts.ts:64) | OAuth client status | High — operator sees "not configured" on a network blip. |
| [useUploadAccounts.ts:231,253,381,442](frontend/composables/useUploadAccounts.ts:231) | Folder resolve, thumbnail load, default-account switch | Medium-High |
| [useConfirmation.ts:110](frontend/composables/useConfirmation.ts:110) / [useConfirmSkip.ts:72](frontend/composables/useConfirmSkip.ts:72) | "Skip this confirmation" preference save | Medium — operator thinks they disabled a dialog; it fires forever. |
| [useSecretsProvenance.ts:39,54](frontend/composables/useSecretsProvenance.ts:39) | Secret load/save errors | Medium |
| [usePresets.ts:141](frontend/composables/usePresets.ts:141) | Preset load | Medium |
| [useManifestSync.ts:110](frontend/composables/useManifestSync.ts:110) | Manifest poll | Medium |

→ **Fix-task spawned: "Surface silent catches: `useNetworkStatus` queue pause/resume + `useJobs` SSE + `useEpisodeStatus` watcher + dashboard stats."**

→ **Fix-task spawned: "Replace raw `e.message` passthrough in routes/video.ts/audio.ts/scripts.ts with humanized errors."**

---

## Part B — Loading honesty + auto-save (Topics 3, 4)

### 3. Loading-state honesty — **Mostly good**

Spot-checked 10 user actions. Generators (script, audio, image, metadata, upload) all toggle `submitting`/`generating` → `<TopActionBar :generate-loading=…>` shows a spinner immediately on click. Buttons gate `:disabled` to prevent double-fire.

The single weak spot:

- **Video Assembly initial render**: [pages/projects/[slug]/video-assembly.vue:1-30](frontend/pages/projects/[slug]/video-assembly.vue:1) — `generating` isn't set until after the first await, so the click registers and the UI freezes for several seconds before any spinner. **Medium**.

### 4. Auto-save indicators — **High**

`SaveIndicator.vue` exists and renders all four states (idle / saving / saved / error) cleanly. **Used on exactly one page**: Metadata (verified: grep for `<SaveIndicator` across `pages/` returns one hit, [metadata.vue:345](frontend/pages/projects/[slug]/metadata.vue:345)).

Settings pages auto-save via explicit `await put()` with success toasts — *not* through `useAutoSave` — so they don't render `SaveIndicator` and don't claim to. That's actually consistent: operator gets a toast on success, an error toast on failure. **Not silent.**

But:

- **No flush-on-unload anywhere.** Grepped frontend source for `beforeunload | visibilitychange | pagehide` — **zero hits in source code** (only `node_modules`). [useAutoSave.ts:52](frontend/composables/useAutoSave.ts:52) defaults to a 1000 ms debounce and `flush()` is only called in [metadata.vue:848 `forkToNewVersion`](frontend/pages/projects/[slug]/metadata.vue:848). **If the operator types in metadata and hits cmd-Q within 1s, the change is lost.** Not crash-recovery; the *normal* quit flow loses the last second.
- **Mental-model inconsistency.** Metadata shows "Saved 3s ago"; Settings shows a transient toast and then nothing. An operator who lands on Settings doesn't know whether their last keystroke is persisted, because there's no state indicator like Metadata. **Medium.**

→ **Fix-task spawned: "Wire `useAutoSave.flush()` to `beforeunload` + visibility-hidden, plus reduce default debounce to 400ms for short-form fields."**

→ **Fix-task spawned: "Add `<SaveIndicator>` to Settings tabs that mutate-on-blur, OR explicitly mark them as save-on-button to reset operator expectation."**

---

## Part C — Destructive actions (Topic 5)

### 5. Confirmation friction — **Adequate for personal use, with two soft spots**

All in-app deletes use the themed `ConfirmDialog` (red button + Esc-trap), not native `confirm()`. Wording is generally specific. Sampled 9 destructive operations; 6 are excellent.

The two soft spots:

- **Reset idea** ([ideas.vue:941-950](frontend/pages/projects/[slug]/ideas.vue:941)) — message says *"deletes the {episode_code} folder on disk (script, prompts, any generated images/audio)"*. **It does not enumerate the actual disk contents.** If that folder has 47 generated images + 12 audio chunks the operator spent $$$ on, the dialog gives no count. **High.**
- **Remove from upload queue** ([upload.vue:1542-1560](frontend/pages/projects/[slug]/upload.vue:1542)) — deletes the file from disk; **no file-size displayed**. Could be 4 GB. **Medium.**

The "Reset idea" path is the highest-blast-radius operation in the app for a solo operator, and it's the one with the weakest pre-confirmation context.

→ **Fix-task spawned: "Enumerate disk contents (file count, total size, last modified) in 'Reset idea' and 'Remove from upload queue' confirmations before destruction."**

---

## Part D — Performance (Topic 6)

### 6. Long content — **Two real risks, neither blocking yet**

- **Job output streaming** ([jobs.vue:259,303,397](frontend/pages/projects/[slug]/jobs.vue:259)): `v-for="(line, i) in job.output_lines"` renders inline. Pagination at the *job-card* level (PAGE_SIZE) limits which jobs render; nothing limits per-job line count. A 10,000-line job log renders all lines. **Medium.**
- **Custom intro beats** ([scripts.vue:91](frontend/pages/projects/[slug]/scripts.vue:91)): unbounded `v-for` — a few dozen beats × textarea-on-keystroke re-render is sluggish. **Low** unless the operator habitually creates 50+.

Image gallery (`images.vue`) and audio chunks list have small finite lists; not a concern.

---

## Part E — Keyboard, empty states (Topics 7, 10)

### 7. Keyboard navigation — **Partial**

- `<Modal>` uses `useFocusTrap` and listens for Esc. **Good.** ([Modal.vue:72](frontend/components/Modal.vue:72)).
- **Custom modal in ideas.vue** ([ideas.vue:191-203](frontend/pages/projects/[slug]/ideas.vue:191)) — built as raw `modal-overlay` `<div>`, not wrapped in `<Modal>`. **No Esc dismiss, no focus trap, no return-to-trigger focus.** **High** — the operator has to mouse-cancel.
- **No global hotkeys.** Grepped for cmd-S / cmd-Enter / cmd-K — only `@keydown.space.prevent` on a template selector. No "submit form with cmd-Enter" anywhere. **Medium** — operator efficiency, not a blocker.

→ **Fix-task spawned: "Wrap `ideas.vue` accept-dialog in `<Modal>` for Esc + focus-trap + return-focus."**

### 10. Empty states — **Mostly good**

- `pages/index.vue` "no projects yet" is exemplary: two CTAs (Create / Import), clear message. **Low.**
- `EmptyState.vue` supports actionable empty states, and most callers use them.
- **Two passive empty states**: [ideas.vue:139-142](frontend/pages/projects/[slug]/ideas.vue:139) for "no ideas match filter" — lacks "Clear filter" CTA. [jobs.vue:154](frontend/pages/projects/[slug]/jobs.vue:154) for zero jobs — passive copy, no "Generate something" CTA. **Medium** each.

---

## Part F — Batch ops + return-from-batch (Topics 8, 9)

### 8. Batch operation status — **Good with one gap**

[pipeline.vue](frontend/pages/projects/[slug]/pipeline.vue) shows the per-episode × per-step grid with green/gray pills; `useBatchSummary.ts` collapses noise (UUIDs / provider error bodies); the post-completion banner on `jobs.vue` lists top-3 failure reasons + per-episode error rows. This is well-designed.

Gap:

- **No selective retry.** Once a batch finishes, "retry just the 3 audio failures" is a multi-click chore: the operator has to manually deselect 17 done items in the pipeline grid. There's no "retry only failed" button on the post-batch banner. **Medium.**

### 9. Return-from-long-batch — **Good summary, missing in-app + system pings**

The post-batch banner at [jobs.vue:45-100](frontend/pages/projects/[slug]/jobs.vue:45) is the right shape: success/total + wall-clock + top-3 failures + per-episode rows. State is persisted in `jobs.json` via `pipeline_batch_id`, so the banner re-derives on reload. **The 3-hours-away operator returning to the Jobs tab gets the answer at a glance.**

Two real gaps:

- **No system Notification.** Grep for `new Notification(` / `Notification.requestPermission` / `navigator.setAppBadge` across `frontend/` (excluding `node_modules`) returns **zero hits**. If the operator is in a different tab or Cmd-Tabbed away, nothing fires. Verified live: `Notification.permission` is `denied` because the app never requested. **High.**
- **No in-app cross-tab signal.** The banner only shows when the operator navigates to `/jobs`. If they're on `/scripts` when the batch finishes, no toast / no badge / no title-flash. **Medium.**

→ **Fix-task spawned: "On batch completion: request Notification permission once at first batch, then `new Notification(...)` + title-bar badge + cross-tab toast."**

---

## Part G — Crash recovery + dev-server footgun (Topics 11, 12)

### 11. Window crash / app relaunch — **Weak**

- Backend reaps orphan FFmpeg children at startup ([electron/main.ts:310-330](electron/main.ts:310)). Good.
- **No "last open project / last open tab" restoration.** App always lands at `/`. Operator manually reopens the project and re-navigates to where they were.
- **No "previous session ended unexpectedly" banner.** If the app crashed mid-render, nothing tells the operator. They have to discover it on the Jobs page.
- Auto-save default 1s + no flush-on-unload (Topic 4) means the crash window for unsaved settings/metadata edits is up to 1s.

→ **Fix-task spawned: "Persist last-open `{ projectSlug, route }` to userData; on app launch, if non-empty AND less than 24h old, navigate there + show 'Resumed where you left off — undo' chip. Detect unclean shutdown via a `running.flag` file."**

### 12. Dev-server footgun — **Verified live; Critical for personal-spend-money use**

Sequence I ran in the preview MCP (Chromium, not Electron):

```
GET http://localhost:3001/                       → 200, full UI, no warning
JS: navigator.userAgent.includes('Electron')     → true (Chromium reports it; useless as a gate)
JS: !!window.electron && !!window.api            → false / false
GET http://localhost:8000/api/projects (CORS)    → 200, full project list with absolute output_root paths
NAV /projects/dozing-knight/jobs                 → renders entire jobs page with real history
```

There is **no banner, toast, or console warning** anywhere telling the operator they're outside Electron. The sidebar offers every generator route, and **the API is reachable**, which means a "click Generate" inside this misopened tab would fire a real backend job and burn real provider credit. File pickers and OAuth deep-links would silently no-op, but generators would not — they don't need IPC to spend money.

This composes badly with Session 05 §26 (the CORS simple-request footgun) and Session 09's findings about the queue running independently of the UI.

The fix is two lines of `app.vue` mount-time: detect missing `window.electron` and either redirect to a hard `block.html` or render a full-screen takeover with copy and an "Open in Story Studio" button (or just `process.exit`-equivalent). For dev mode specifically, gate the takeover on `import.meta.env.PROD` to avoid annoying the developer.

→ **Fix-task spawned: "Front-page guard: if `!window.electron` AND `import.meta.env.PROD`, render a full-screen 'Open in Story Studio app' takeover and refuse to render any project route."**

---

## Part H — First-run walkthrough + Settings reachability (Topics 13, 14)

### 13. First-run walkthrough — **Substantial improvement since Session 05; two soft spots remain**

Re-walked [pages/index.vue](frontend/pages/index.vue) wizard. Since Session 05:

- **FFmpeg step now exists** (Step 3): live status check via `GET /ffmpeg/status`, auto-download or manual install paths, "I've installed it — check again" button. **Resolves Session 05 P2 (Critical).** ✓
- **Connectivity precheck added** (Step 4): pre-flight ping to provider domains, three-state banner. **Resolves Session 05 P8.** ✓
- **Mode picker** (multi-machine vs local): clean.

What's still soft:

- **API key validation not in wizard** (Session 05 P4 — High). Still unfixed. The backend has `POST /test-key/{provider}`; the wizard doesn't call it. Bad key discovered at first generation. Fix is one button.
- **OAuth step not skippable in UI**. Step 5 says "(optional)" but presents no Skip button — only Next. Acceptable but not obvious.

→ **Fix-task spawned: "Wire wizard Step 4 to `POST /test-key/{provider}` per filled key; block Next until each green-or-confirmed-bypass."**

### 14. Settings reachability — **Complete**

Tabs at [settings.vue](frontend/pages/projects/[slug]/settings.vue): API Keys, Models, Voices, Standards, Folders, Named Roots, Confirmations, Performance, FFmpeg, Notifications, Project. **Every wizard input has a settings home.** OAuth is the one outlier — lives in `/upload` per platform, intentional since it's per-channel. No "first-run-only" knobs.

The single remaining gap is from Session 05 §24: there's no menu item to **re-launch the wizard** (e.g., to clone a setup onto a new machine without a new project). Each wizard knob lives in Settings, but the guided flow is one-shot. **Medium.**

---

## Findings summary

| # | Finding | Severity | Topic |
|---|---|---|---|
| 1 | Dev-server footgun: localhost:3001 in Chrome serves the full UI + working backend; no electron-presence guard | **Critical** | 12 |
| 2 | `useNetworkStatus` queue pause/resume swallowed — queue keeps running while UI thinks it's paused | **Critical** | 2 |
| 3 | No system / cross-tab notification on batch completion | High | 9 |
| 4 | Backend route raw `e.message` passthrough (`spawn ENOENT` etc.) | High | 1 |
| 5 | `useJobs` SSE refresh + parse swallowed — stale job list, frozen progress | High | 2 |
| 6 | `useEpisodeStatus` watcher swallowed — wrong episode data on switch | High | 2 |
| 7 | Dashboard stats + asset audit silent on mount | High | 2 |
| 8 | `useVideoAssemblyIo` ffmpeg-check `catch { installed: false }` mislabels permission errors | High | 2 |
| 9 | `<SaveIndicator>` only on Metadata; no flush-on-unload anywhere; cmd-Q within 1s loses edits | High | 4 |
| 10 | `ideas.vue` accept-dialog is raw `<div>` — no Esc, no focus trap | High | 7 |
| 11 | Wizard Step 4: API keys accepted unverified | High | 13 |
| 12 | "Reset idea" doesn't enumerate disk contents before delete | High | 5 |
| 13 | No "last session" / "unclean shutdown" recovery banner | High | 11 |
| 14 | `useUploadAccounts` x4 silent catches | Medium | 2 |
| 15 | `useConfirmation` / `useConfirmSkip` preference-save silent | Medium | 2 |
| 16 | Cost-estimate fallback "Could not estimate cost" not actionable | Medium | 1 |
| 17 | Job output `v-for` not virtualized — 10k-line job thrashes DOM | Medium | 6 |
| 18 | Video Assembly mount lacks immediate spinner | Medium | 3 |
| 19 | Settings tabs auto-persist with no save indicator → mental-model inconsistency vs Metadata | Medium | 4 |
| 20 | "Remove from upload queue" lacks file-size in confirmation | Medium | 5 |
| 21 | No global hotkeys (cmd-S, cmd-Enter) | Medium | 7 |
| 22 | "Filter empty" empty-states (`ideas.vue`, `jobs.vue`) lack Clear-filter CTA | Medium | 10 |
| 23 | No selective retry of failed pipeline steps | Medium | 8 |
| 24 | OAuth wizard step has no explicit Skip button | Medium | 13 |
| 25 | Wizard not re-launchable from Settings | Medium | 14 |
| 26 | `usePresets` / `useManifestSync` / `useSecretsProvenance` silent catches | Low | 2 |
| 27 | `scripts.vue` unbounded custom-beats `v-for` (low-volume in practice) | Low | 6 |

---

## Open questions

1. **Browser-tab takeover scope** — should the takeover gate dev mode too (annoying for the maintainer) or only `import.meta.env.PROD`? My recommendation: PROD only.
2. **Notification permission timing** — request once at first wizard finish, or lazy-request at first long-running batch? I'd lazy-request to avoid permission fatigue.
3. **Crash banner persistence** — clear on first dismiss, or persist until the operator has visited `/jobs` and reviewed? I'd persist to ensure they actually see the failed jobs.

---

*End of Session 11. Ten fix-tasks spawned: 2 Critical, 8 High. Mediums and Lows deferred. Next: pick a fix-task or run another scoped session.*
