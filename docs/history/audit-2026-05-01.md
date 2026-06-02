# AFK audit + fix session — 2026-05-01

You went AFK 3-4h with: **run audits, fix slowness/bugs, leave anything that needs your call in this file**. Here's the wrap-up.

## What I committed

5 focused commits on `main`. Run `git log --oneline -5` to see them all.

```
d931295 feat(upload+audio-merge): quota chip, reconcile UX, queue sync, perf
ea89db2 feat(youtube): listVideoStatuses + linked_videos for queue/reconcile flows
f1c45e1 feat(quota): per-account JSONL ledger for YouTube Data API quota
0403f37 perf(dashboard): parallel scan + iCloud-aware + loading indicator
e38086e fix(job-queue): persist interrupt-status mutation to disk on load
94441f4 perf(backend): parallelize sequential I/O in upload/scripts/audio/ideas routes
```

(The first three pre-date the AFK window — they bundle our earlier session work that was approved per-step but had been sitting uncommitted. The last three are pure AFK-window output.)

## Verification
- Type-check (`cd electron && npx tsc --noEmit`): **clean**
- Backend tests: **704 pass / 0 fail / 0 skipped** (was 1 skipped — the persist-on-load test was waiting for the bug fix it documents)
- Frontend tests: **93 pass / 0 fail**
- Live preview: queue tab renders correctly with all the per-row enrichment, no console errors

## What the audits found (and what I did about it)

### Backend slowness audit — 8 findings

| Finding | Verdict |
|---|---|
| 3× sequential `readSidecar` loops in upload.ts (apply-plan, sync-from-youtube, clear-schedule) | ✅ Fixed via Promise.all pre-batch; PATCH loops stay serial for rate-limit + per-row error reporting |
| 2× sequential `readFile` loops in scripts.ts (metadata version listing, json + txt fallback) | ✅ Fixed via Promise.all on file reads, parsing stays serial |
| Sequential `fs.stat` over audio chunks in audio.ts staleness check | ✅ Fixed via Promise.all + `.some()` early return preserved |
| Per-episode `resolveSubfolderNames` in ideas.ts migrate routes (re-reads project config N times) | ✅ Pre-batched into Map before the loop |
| Unbounded recursion in `findEpisodeDirs` (ideas.ts, both copies) | ✅ Added `FIND_EPISODES_DEPTH_LIMIT = 8` to prevent symlink/malformed-tree hangs |
| Dashboard scan unparallelized + no iCloud handling | ✅ (already done earlier in session) |
| Reconcile sidecar reads sequential | ✅ (already done earlier in session) |

### Frontend slowness + leak audit — 5 findings

| Finding | Verdict |
|---|---|
| `privacyChip(item)` called 4×/row inline in upload.vue | ✅ Pre-computed on `displayedQueueItems` |
| `playlistChipFor(item)` called 3×/row inline in upload.vue | ✅ Same enrichment |
| `weekdays.map(...).join(...)` inline in plans table | ✅ Extracted to `displayedPlans` computed |
| Non-stable `:key="rej.index"` on rejected paste rows in ideas.vue | **Audit misread** — `rej.index` is the row's source-line property, not Vue's positional index. Keys are stable. **No fix needed.** |
| `watch(customStyles, ..., { deep: true })` in scripts.vue | **Skipped** — feeds a 1-second debounced save; deep-watch overhead on a small CSS object is negligible vs the debounce window. Behaviour change isn't worth the perf delta. |

All `addEventListener`/`removeEventListener` pairs check out across the codebase. No leaks detected.

### Bug-shaped audit — 5 findings

| Finding | Verdict |
|---|---|
| **HIGH**: job-queue interrupt mutation not persisted (loadPersistedJobs mutates in-memory but never re-writes jobs.json) | ✅ Fixed: `persistJob(j)` inside the mutation branch with try/catch + warn log. Un-skipped the existing `__tests__/job-queue-stale-running-persist.test.ts` that was waiting for this fix; it now passes. |
| **MEDIUM**: 4× `useApi() as any` casts in composables (useSoftDeletedProjects, useLinkedProjects, useConfirmation, useConfirmSkip) | **NEEDS YOUR ATTENTION** — see below |
| **LOW**: Fire-and-forget boot migrations | Confirmed intentional (documented at boot/migrations.ts:3-6). No action. |

---

## NEEDS YOUR ATTENTION

### 1. `useApi() as any` casts (MEDIUM bug-shaped)

Four composables cast `useApi()` to `any`, hiding type errors and making future refactors unsafe:

- `frontend/composables/useSoftDeletedProjects.ts:27`
- `frontend/composables/useLinkedProjects.ts:53`
- `frontend/composables/useConfirmation.ts:79` — `(config.value as any)?.confirmation_preferences`
- `frontend/composables/useConfirmSkip.ts:46` — same pattern

**Why I didn't fix this autonomously:** the proper fix is to give `useApi()` a sound TypeScript signature, which means understanding what shape `useApi().get<T>()` etc. should return. That's an architectural call I shouldn't make blind. If you confirm the intended signature, I (or you) can drop the `as any` casts in a follow-up.

### 2. Pre-existing in-flight work in the worktree

When this session started, `git status` was clean. By the time I started looking, several files had uncommitted edits I didn't make:

- `electron/server/contracts/index.ts`
- `electron/server/generators/{ai-video,audio,images,youtube-upload}.ts`
- `electron/server/lib/{elevenlabs,fal,genaipro-veo,kie}-client.ts`
- `electron/server/lib/speed-tracker.ts` (NEW)
- `electron/server/models/types.ts`
- `electron/server/services/asset-status.ts`
- `frontend/components/AssetDownloadStrip.vue` (NEW)
- `frontend/components/ProgressBar.vue` (NEW)
- `frontend/composables/useFormat.ts`
- `frontend/pages/projects/[slug]/{audio,images,metadata,video}.vue`

The diffs read like an upload-progress / speed-tracking feature you were drafting. **I didn't touch any of these.** They'll either get committed by the session-end auto-commit-push hook (your safety net) or you can stage/commit them yourself when you're back. Worth a quick `git status` + `git diff` to confirm they're what you expect before the hook fires.

### 3. Things I considered but didn't ship

- **Reorder/refactor `customStyles` deep watch**: skipped per above (the debounce makes the deep-watch overhead irrelevant). Logged here so you know it was looked at.
- **Refactor `useApi()` signature**: see #1.

---

## Skipped / deferred (intentional)

- Generators (`ai-video`, `audio`, `images`, `youtube-upload`) — touched by your in-flight work; staying out of the way.
- Provider clients (elevenlabs, fal, kie, genaipro-veo) — same reason.
- Asset-status / pipeline business logic — too high blast-radius without your eyes on it.

---

## Final tally

- **6 commits** on `main` (3 from earlier session work that hadn't been committed + 3 pure AFK-window work)
- **704 backend tests pass, 0 skipped** (down from 1 skipped — the persist-on-load test now passes against the bug fix)
- **93 frontend tests pass**
- **Type-check clean**
- **No regressions in the live preview**

Per the standing instruction, please restart Electron from this worktree to pick up the backend changes (especially the dashboard parallel scan + iCloud-aware path, the job-queue persist fix, and the parallelized `readSidecar` loops). The frontend dev server has been HMR-ing my changes the whole time, so the UI is already current.

Welcome back.
