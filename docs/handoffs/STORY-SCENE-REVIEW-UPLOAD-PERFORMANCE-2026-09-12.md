# Scene Review, Upload Center and Content Store responsiveness — completed 2026-09-12 (v1.4.152)

## Status

- Work is COMPLETE on branch `codex/scene-review-upload-perf` (worktree
  `.worktrees/scene-review-upload-perf`, based on main `490e9d88`), version 1.4.152.
- Release gates run on the final code: backend suite 465/465 files, 5,152 tests, 0 failures;
  frontend lane 188/188 files, 1,724 tests; release lane 36 tests; lint 0 errors;
  changelog, typography, security, model-drift checks pass; backend + frontend typecheck clean.
- Two independent review rounds (read-only agent): 4 fix-first findings fixed, plus one
  regression the fixes introduced (legacy image fallback) fixed with a regression test.
- Integration status (filled in at the end of the session — see "Integration" below).
- The original investigation brief this file replaced is summarised under "Root causes".

## Owner-reported problems and what was done

1. **Scene Review loads slowly / feels clunky.** Measured: review JSON 2.0–2.7 s per poll,
   polled every 3.5 s regardless of whether the previous read finished; every visible
   thumbnail re-fetched 71× per session because one page-wide cache-buster changed on every
   poll. Fixed: per-asset `image_version` / `clip_version` / `audio_version` (size-mtime) from
   the review payload drive `<img :key>` and `?v=` URLs; versioned media served
   `Cache-Control: private, max-age=31536000, immutable`, unversioned stays `no-store`;
   single-flight poll (setTimeout re-armed after the read settles); per-scene probes stat at
   32-wide and full-decode at 4-wide (named folder first, legacy folder when the named copy is
   absent or corrupt); image route stays chunked (no Content-Length).
2. **Upload Center review dialog opens slowly (24–31 s live), Upload click slow.** Root cause:
   every preview and every upload admission SHA-256'd the whole rendered video (600–850 MB) in
   64 KB chunks — 12,800 sequential event-loop turns, each waiting behind other server work.
   Fixed: 4 MiB hash chunks; signature-keyed (size, mtime, inode) hash cache used ONLY by
   preview and upload admission (generator still hashes the open handle it sends from;
   storage-audit / remote-video / archive keep the uncached function); dialog opens on click
   in a "building" state, Close abandons the pending preview; Upload acknowledges the queued
   job immediately and reloads the list in the background; a local queued marker withholds a
   second Upload until a reload shows the job (or manual Refresh clears it).
3. **Close/Dismiss unreachable without scrolling; dismissing must not cancel.** Both review
   dialogs use `modal-flush` with a sticky header (Close) and sticky footer (primary action);
   verified at desktop and 375 px. Bulk review can be closed while queueing: queueing
   continues, a page strip shows "N of M queued" with Stop and Show; stopped-while-hidden
   stays visible with Show/Dismiss. Publishable sweep resolves the export root once per
   request (was 302 parses of the 571 KB settings file).
4. **Content Store loads slowly, no Select all, no install status, unclear if leaving cancels.**
   Measured (live log): overview 4.7 s warm / 13 s cold, each install 14 s (≈5 s of it
   rebuilding the overview), quotes 2.5 s. Fixed: overview asks GenStudio for account, catalog
   and receipts concurrently (shelves chained on catalog); install route `?overview=0` skips
   the rebuild; installed-tree fingerprint stats per directory in parallel; CRC-32 via
   `zlib.crc32` (JS loop was 36 MB/s, 6.8 s CPU per sweep); app-wide singleton install queue
   (`useContentInstallQueue`) survives navigation, refreshes the overview every 8 installs and
   once on drain, records each failure's reason; global strip in the layout
   (`ContentInstallStrip`); per-card queue state (Queued to install / Installing… / Installed /
   Install failed) on Owned, Updates and Discover; product page enqueues into the same queue;
   Discover "Select all N purchasable"; batch purchase dismissable while quoting/settling
   with a page strip, one overview read per batch.

## Measurements (identical isolated data, equal synthetic load, old vs new)

| Path | Old | New |
|---|---|---|
| Review JSON, 288 scenes | 1.8–2.3 s | 0.7–0.9 s |
| Preview, first hash | 61 s | 2.5 s |
| Preview, repeat | 61 s | 0.5 s |
| Publishable list, 302 episodes | 1.6 s | 1.1 s |
| Control (one-turn request) | 16 ms | 20 ms |

Content Store overview cannot be timed outside Electron (GenStudio key is Keychain-bound);
its changes are structural and pinned by tests. Live-app after-numbers require installing
1.4.152; none were taken on the running 1.4.151.

## Files (26 modified, 8 new)

Backend: `electron/server/routes/scene-review.ts`, `routes/youtube-upload-center.ts`,
`routes/content-store.ts`, `services/youtube-source-video.ts`, `services/content-store.ts`,
`services/content-store-delivery.ts`, `services/external-video-store.ts`, `services/utils.ts`,
`lib/image-validation.ts`, `content-packs/archive.ts`, `content-packs/installer.ts`.
Frontend: `pages/projects/[slug]/scene-review.vue`, `pages/projects/[slug]/upload/publish.vue`,
`pages/content-store.vue`, `pages/content-store/[productId].vue`, `layouts/default.vue`,
`composables/useContentStore.ts`, `composables/useBatchPurchase.ts`,
`composables/useContentInstallQueue.ts` (new), `components/content-store/ContentInstallStrip.vue`
(new), `ContentProductCard.vue`, `ContentStoreShelf.vue`, `ContentBatchPurchaseDialog.vue`.
Tests (new): `youtube-source-video-revision-cache`, `scene-review-media-versions`,
`content-store-overview-performance` (backend); `contentInstallQueueShared`,
`contentStoreBackgroundWork`, `sceneReviewMediaFreshness` (frontend) plus additions to
`uploadCenterPublish`, `sceneReviewPreview`, `contentStoreDetail`.

## Known limits / candidates for a next session (owner's decision)

- `getAppSetting` re-reads and zod-parses the 571 KB app-settings file on every call, across
  many hot paths (admission polling 3,628 calls/day at 1.2 s avg in the log). A signature
  cache would help everything, but it changes object aliasing for every settings reader —
  needs its own review, not a rider.
- The Content Store install snapshot verifies 115 packs per overview; the per-version memo
  works in the live process but could not be measured in isolation (keyring differs).
- Live `/api/health` is requested ~17× on page load by the frontend (pre-existing).
- `ContentProductDetail` has no queue-status prop: after the queue installs a pack, its Install
  button stays live until the next overview lands (a redundant enqueue, not a double install).
- Scratch profiling harness and gotchas are in memory `isolated-backend-profiling-harness`;
  the event-loop turn-delay diagnosis in memory `event-loop-turn-delay-pattern`.

## Integration

- Commit `e551a5e2` on `codex/scene-review-upload-perf`, pushed; PR
  https://github.com/theng12/story-studio-kh/pull/111 merged into main as `43389b9d`
  (GitHub Actions confirmed disabled; no hosted compute).
- DMG: built from merged main with `npm run dist:smoke` (unsigned — Developer ID / notarization
  credentials are not configured in the session shell; `npm run check:public-release` says so).
  Artifact path and version verification are recorded at the end of this file.
- Not done: no live installation, deployment, tagging or provider writes (no authority).

## Artifact

- `dist/Story Studio KH 1.4.152-arm64.dmg` (241,819,112 bytes,
  sha256 a3d4819b59e9ca3fec2dc559a266c5ea290e77a4f312980a32e9f8e5791dbd19), built 2026-09-12 20:26
  from main `43389b9d`; bundled app and `app.asar` both report 1.4.152; ad-hoc signature (no
  Developer ID); `verify-desktop-artifact` passed including the launch smoke test.
- Not installed on this Mac; the running app is still 1.4.151. Install it to take the live
  after-measurements (Scene Review poll count, review-dialog open time, Content Store overview).
- Worktree `.worktrees/scene-review-upload-perf` removed after merge; remote branch kept.
