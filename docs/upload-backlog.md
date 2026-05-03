# Upload Center backlog

Prioritized list of follow-ups from the upload-feature audit on 2026-05-03.
Items are grouped by ROI band so you can pick a bundle and ship; discussion
notes live under each item as we work through them.

## How to read this

**Status flags** (in the heading):
- `[ ]` open — not started
- `[~]` in progress — partial implementation or design in flight
- `[x]` done — shipped (link the version + commit when it lands)
- `[?]` needs discussion — flagged for the next conversation; don't start
  implementing until the discussion thread below resolves

**Priority bands:**
- **P0 — Highest ROI for least code.** Small surface, high impact. Do first.
- **P1 — Medium effort, high value.** Worth a focused session each.
- **P2 — Architectural / long-tail.** Plan-mode work; defer until P0/P1 are
  cleared or the user explicitly wants to tackle one.

**For each item:**
- One-line summary from the audit
- Acceptance — what "done" actually looks like
- Files / starting points — where to begin reading code
- Discussion — empty until we have notes; user can append questions or
  flag things needing decisions before implementation

---

## P0 — Highest ROI for least code

### [x] C+G · Tombstone safety net (un-mark verb + auto-show 🪦 chip)

**Shipped:** v1.0.35 · commit `c031f57`

**Why bundled:** Together they make the recent tombstone work properly safe
to use. Without C, marking-by-accident is irreversible (the only path back
wipes the sidecar). Without G, takedowns hide unless the user thinks to
enable the chip.

**Acceptance:**
- New row action **"Un-mark deleted (keep link)"** appears on tombstoned
  rows, alongside "Restore: forget link". It clears `deleted_at` /
  `deleted_reason` on the sidecar but preserves `video_id`, `account_id`,
  and the rest. Backend: extend `POST /upload/queue/:code/mark-deleted`
  to accept `{ clear: true }` OR add a separate `/unmark-deleted` route.
- The 🪦 filter chip auto-activates on the Queue tab when the project has
  at least one tombstoned row, and auto-deactivates when the count reaches
  zero (similar to the existing orphan-banner auto-show). User can still
  manually toggle it.

**Files:**
- Backend: [electron/server/routes/upload.ts](../electron/server/routes/upload.ts) (mark-deleted route region)
- Frontend: [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (row-kebab menu + chip auto-toggle in `loadQueue` callback)

**Discussion:** _none yet_

---

### [x] D · Apply preview before commit

**Shipped:** v1.0.35 · commit `c031f57`

**Why:** Today the scope picker says "All unuploaded (47)" and you click —
no preview of which episode lands in which slot. Confidence drops as N
grows.

**Acceptance:**
- Scope picker grows a "Preview" expansion (or a small inline table) that
  runs `plans.computeSlots()` client-side against the chosen scope and
  shows the episode → slot mapping (first 10 + "...+N more"). User then
  clicks the verb button to commit, or closes to cancel.
- No backend change required; `computeSlots` is already pure.

**Files:**
- [electron/server/services/upload-plans.ts](../electron/server/services/upload-plans.ts) (`computeSlots` — confirm it's safe to call from frontend or expose via a new GET)
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (`scope-popover` template + `scopeOptions` computed)

**Discussion:** _none yet_

---

### [x] F · Auto-Sync from YouTube on 24h cooldown

**Shipped:** v1.0.35 · commit `c031f57`. Cooldown stored in localStorage
per project (`upload:lastAutoSync:<slug>`). Manual sync button also
stamps the cooldown so it doesn't double-fire.

**Why:** Sync is opt-in today. Takedowns / drift go undetected until the
user remembers to click the button.

**Acceptance:**
- On entering the Queue tab, if the last sync ran > 24h ago AND the
  project has at least one uploaded sidecar, fire `sync-from-youtube`
  silently in the background.
- Result: any tombstones or drift that accumulated overnight surface in
  toasts (the existing toast logic) without user action.
- Persist `last_auto_sync_at` per project (project config or a tiny
  sidecar) so the cooldown survives refresh.

**Cost:** ~1 quota unit per linked sidecar per run. Capped by sidecar
count, not user behaviour.

**Files:**
- [electron/server/routes/upload.ts](../electron/server/routes/upload.ts) (sync-from-youtube around line 1670; add a `last_auto_sync_at` to project config)
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (Queue tab `watch(activeTab)` callback)

**Discussion:** _none yet_

---

## P1 — Medium effort, high value

### [x] B · Schedule-map drift fix in sync-from-youtube

**Shipped:** v1.0.36 · commit `75a51d1`

**Why:** When YouTube's `publishAt` changes, sync updates the sidecar's
`scheduled_for` but never the `upload_item_schedule` map. Local "I planned
this for Tuesday" can quietly disagree with reality.

**Acceptance:**
- Inside the sync drift loop, when sidecar.scheduled_for is updated, also
  update the schedule map's entry for that episode_code (or delete it if
  YouTube reports no `publishAt`).
- Idempotent: re-running sync without drift is still a no-op.

**Files:**
- [electron/server/routes/upload.ts](../electron/server/routes/upload.ts) (sync drift loop ~line 1718)
- [electron/server/services/upload-plans.ts](../electron/server/services/upload-plans.ts) (`writeItemSchedule`)

**Discussion:** _none yet_

---

### [x] H · Restore "Apply + Upload" as a fourth verb in the scope popover

**Shipped:** v1.0.36 · commit `75a51d1`. Four verbs now: 📅 Apply
(schedule only), ☁️ Upload only (skip re-apply), 🚀 Apply + Upload
(combo, the common case), ↩ Unapply.

**Why:** v1.0.32 split the bundled "Apply + Upload all" button into
separate verbs because the old one was misleading on quota. Splitting
helped clarity but cost ergonomics — the common case ("apply this plan
and upload as many as quota allows") is now two clicks of friction.

**Acceptance:**
- Add **"Apply + Upload (quota-capped)"** as a fourth button in the
  Plans-tab modal AND the Upload-Plan-modal. Runs Apply, then Upload,
  with the same scope, quota-capped. Toast summarises both phases.
- The two existing single-verb buttons stay — this is additive.
- Only enabled in apply-plan mode (same gate as today).

**Files:**
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (`scope-popover` template + `runScopedAction`)

**Discussion:** _none yet_

---

### [x] 9 · Imports as first-class scope-picker citizens (documented)

**Shipped:** v1.0.36 · commit `75a51d1`. Went with the documented-limitation
option — every scope-picker tooltip now ends with "Imports are not
included — manage them via the per-row Upload button or the selection
bulk bar." Full first-class support deferred (low ROI for personal use).

**Why:** Imports have no `episode_code` so the scope picker silently
excludes them — they get the bulk bar but not the Plans modal. For users
who upload trailers or one-offs from the imports folder, the plan
workflow is invisible to them.

**Acceptance:**
- Scope picker counts include imports (use `id` instead of `episode_code`
  where appropriate). The backend `apply` / `mark-deleted` /
  `link-existing` endpoints already operate on episode_codes — extend
  the apply path to also accept import ids.
- OR (simpler): document explicitly in the scope picker tooltip that
  imports are managed only via the bulk bar.

**Files:**
- [electron/server/services/upload-plans.ts](../electron/server/services/upload-plans.ts) (`writeItemSchedule` already accepts arbitrary keys; just need the wire-up)
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (scope picker computed)

**Discussion:** _Decide: full first-class support, or just document the
limitation? Imports are a small minority of uploads for most projects._

---

### [x] 10 · Page-aware metadata enrichment for off-page selections

**Shipped:** v1.0.36 · commit `75a51d1`. New "👁 View selected" button on
the bulk bar pulls the entire selection (across pages) into a single
enriched view via `?episode_codes=` post-filter on /upload/queue.
Toggles back to paginated browsing via "↺ Show all".

**Why:** The "✓ Ready / ⚠ Missing" badges + thumbnail status are
computed only for visible page rows. Selecting on page 1 + paginating
to page 3 + reading the bulk bar — count is right, but you can't see
the badges of off-page rows.

**Acceptance:**
- When the bulk bar shows N selected, show a "View selected" button that
  switches to a synthesised view of just-the-selected rows (across pages),
  fetched in one round-trip with full enrichment.

**Cost:** one extra enriched-fetch per "view selected" click; bounded by
selection size.

**Files:**
- [electron/server/routes/upload.ts](../electron/server/routes/upload.ts) (`/upload/queue` enrichment + maybe a new `episode_codes[]` filter)
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (bulk bar)

**Discussion:** _none yet_

---

## P2 — Architectural / long-tail

### [x] A · Rename Reconcile / unify with Queue's Link-existing flow

**Shipped:** v1.0.37 · commit `582a3c0`. Tab renamed to **"Match unlinked"**;
header copy now spells out the asymmetry: "Sync = is what we already
linked still accurate? · Match unlinked = are there channel videos we
don't know about?". Internal route id (`'reconcile'`) kept for code
stability; only user-facing copy + the inline banner button hint changed.

**Why:** "Sync" and "Reconcile" sound the same to a fresh reader. They're
solving asymmetric problems (drift on linked vs. matching unlinked). The
recent per-row "🔗 Link existing video" makes the Reconcile tab partially
redundant for the single-video case.

**Acceptance (locked 2026-05-03):**
- **A1 — Rename only.** Rename the Reconcile tab to **"Match unlinked"**
  and rewrite its description / copy so the asymmetry vs. Sync is
  obvious ("Sync = is what we have still accurate? · Match unlinked =
  are there channel videos we don't know about?"). Don't fold the
  single-video flow into the Queue modal.

**Why locked this way:** Folding (A2) would force re-building the
fuzzy-match scan-and-suggest surface inside the Queue modal — lots of
code for marginal UX benefit, since the per-row Link Video modal already
covers the single-video case. A1 gets ~80% of the clarity benefit for
~5% of the work.

**Files:**
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (tab label + description copy)

---

### [x] E · "Uploaded elsewhere" with external account note

**Shipped:** v1.0.38 · commit `f765151`. Extended
`mark-legacy-uploaded` (+ bulk variant) with optional `external_url`
+ `note` fields stored in a parallel `youtube_legacy_uploaded_meta`
config map (boolean flag stays put — no migration). Legacy-marked
episodes now appear as queue rows with a 🔗 External pill (URL as
primary tooltip, note as secondary; click opens URL or, when no URL
is set, an edit modal where the user can paste one in or unmark).
Missing Video tab's "Mark as uploaded" button replaced with a
dedicated modal that captures URL + note in the same step.

**Why:** Today: mark-legacy-uploaded (no video_id) OR link-existing-video
(full sidecar). Sometimes you want the in-between: "this is on a
different account, leave it alone but record where".

**Acceptance (locked 2026-05-03):**
- **Extend** `mark-legacy-uploaded` with two optional fields — additive,
  not a rename. Existing call sites keep working.
  - `external_url?: string`
  - `note?: string`
- **Soft URL validation:** `external_url` must start with `http://` or
  `https://`. Otherwise free-text. Don't try to fully parse the URL.
- **Surface in the UI:** new row pill (similar to the playlist pill)
  reading "🔗 External" with the URL as tooltip and the note as
  secondary tooltip text. Click pill opens the URL. Don't add a new
  column — the pill rides next to the existing chips.

**Why locked this way:** Extending keeps backward compat clean. A row
pill matches the existing visual language (privacy, playlist, tombstone
all use pills) so users don't have to learn a new affordance.

**Files:**
- [electron/server/routes/upload.ts](../electron/server/routes/upload.ts) (mark-legacy-uploaded route)
- Legacy-uploaded sidecar shape (search for `legacy_uploaded` or similar)
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (queue table row chip stack)

---

### [x] I · Promote per-item schedule map into the sidecar

**Shipped:** v1.0.39 · commit `1e325ed`. Sidecar gains
`readSidecarRaw` + `setScheduledFor` helpers; planning-only stubs
(video_id='') carry `scheduled_for` pre-upload and get overwritten
by the real sidecar at upload time. `upload-plans.ts`
`readItemSchedule`/`writeItemSchedule` rewired to walk per-episode
sidecars (legacy map only carries `import:*` keys post-migration).
New service `upload-schedule-migration.ts` runs at boot, marks each
project with `upload_item_schedule_migrated_v1` once swept; orphan
codes referencing deleted ideas are dropped, `import:*` keys
preserved. `buildQueueIndex` switched to `readSidecarRaw` for
episode rows so planning stubs surface in the queue with
`schedule_source: 'planned'`.

**Why:** `config.upload_item_schedule` is a separate config blob. Sidecar
is the right home — single source of truth per episode. Reduces drift
risks (#B becomes a non-issue).

**Acceptance (locked 2026-05-03):**
- **Boot-time eager sweep (I-eager).** On Electron app start, walk every
  project's `upload_item_schedule` map and migrate each entry into the
  matching sidecar. After migration, the map is empty and the project
  config is rewritten without it. One-shot, idempotent.
- Plans + per-row schedule edit are rewritten to write through the
  sidecar going forward.
- The old `upload_item_schedule` config field stays on disk for one
  release as a no-op back-compat surface; can be deleted entirely after
  v1.0.X+1.

**Why locked this way:** Lazy migrate-on-read leaves an indefinite window
where truth is split between sidecar and map. For a personal-use app
with small project counts the boot cost (tens of ms) is invisible, so
the "single moment of truth" property of an eager sweep wins. Bonus: it
makes #B's drift fix a non-issue going forward — there's no map to
disagree with reality.

**Files:**
- [electron/server/services/upload-sidecar.ts](../electron/server/services/upload-sidecar.ts) (sidecar schema gains `scheduled_for` writes from this path)
- [electron/server/services/upload-plans.ts](../electron/server/services/upload-plans.ts) (`readItemSchedule` / `writeItemSchedule` callers redirect to sidecar)
- Boot sweep: a new function in [electron/server/boot/](../electron/server/boot/) that runs once after migrations.

---

### [x] J · CategoryId as a project setting

**Shipped:** v1.0.37 · commit `582a3c0`. New `ProjectConfig.category_id`
threaded through `snippetFromMeta` at all call sites (4 in upload.ts,
2 in the executor). `GET /upload/youtube-categories` endpoint with
7-day on-disk cache at `<userData>/youtube-category-cache/<region>.json`,
soft fallback to stale cache when YouTube fetch fails. Settings →
Project dropdown auto-loads; lazy-loaded on tab entry.

**Why:** Hard-coded to 22 ("People & Blogs"). Fine for sleep-stories but
not universal.

**Acceptance (locked 2026-05-03):**
- Add `category_id?: number` to `ProjectConfig` (default `22`).
- Surface as a Settings → Project field showing the user-friendly
  category name (e.g. "People & Blogs (22)") with a dropdown of all
  categories from YouTube's API.
- **Cache TTL: 7 days.** Categories essentially never change. Cache on
  disk per-account in `<userData>/youtube-category-cache/<accountId>.json`
  alongside the existing per-account caches.
- **Soft fallback when API unreachable:** if the YouTube call fails,
  accept any positive integer the user types and log a warning. Never
  block save just because the validation lookup was momentarily down.
- **Per-project, not per-account.** Category is content-driven. One
  channel might host both "Education" and "Entertainment" depending on
  the project.

**Why locked this way:** Per-project scopes are how the rest of
ProjectConfig already works — consistency wins. Soft-fallback validation
prevents transient YouTube outages from locking the user out of saving.
7-day cache is essentially "forever" for a stable enum without making
the cache field invisible to the user.

**Files:**
- [electron/server/models/types.ts](../electron/server/models/types.ts) (ProjectConfig)
- [electron/server/lib/upload-metadata.ts](../electron/server/lib/upload-metadata.ts) (categoryId hard-code at ~line 234)
- [frontend/pages/projects/[slug]/settings.vue](../frontend/pages/projects/[slug]/settings.vue) (new field on Project tab)
- New service for the categories cache (mirror existing per-account cache patterns)

---

### [x] K · Typed `deleted_reason` enum

**Shipped:** v1.0.37 · commit `582a3c0`. Closed union
`'sync_404' | 'manual' | 'takedown' | 'duplicate'` typed at write sites;
`UploadSidecar.deleted_reason` widened to `DeletedReason | string` on
the read side so old sidecars from v1.0.34/35/36 with arbitrary strings
keep parsing.

**Why:** Free-form string today (`'sync_404' | 'manual' | <whatever>`).
Easy to drift as new detection paths add their own.

**Acceptance (locked 2026-05-03):**
- Replace the free-form `deleted_reason?: string` on `UploadSidecar`
  with a typed union:
  ```ts
  export type DeletedReason = 'sync_404' | 'manual' | 'takedown' | 'duplicate'
  ```
  - `sync_404` — auto-detected by sync-from-youtube (existing)
  - `manual` — user clicked Mark as deleted upstream (existing)
  - `takedown` — future hook for when YouTube returns a takedown reason
    via the API (currently out of scope; reserve the value)
  - `duplicate` — future hook for cross-project dedup detection (also
    reserved)
- Existing `deleted_reason` strings on disk are still accepted on read
  via a `string` widening at the read boundary — only new writes use
  the typed values.

**Why locked this way:** Adding the future-proof values now is essentially
free; reserving them avoids a follow-up refactor when those features
land. Read-side widening means no migration is needed for old sidecars.

**Files:**
- [electron/server/services/upload-sidecar.ts](../electron/server/services/upload-sidecar.ts)

**Discussion:** _Trivial; bundle with the next sidecar-touching commit._

---

### [x] L · Renumber rollback

**Shipped:** v1.0.38 · commit `f765151`. `adoptBulkRenumber` now writes
`.renumber-undo.json` to the project root as Stage 0 before any
disk/state mutations. New `upload-renumber-undo.ts` service owns the
sidecar lifecycle + the inverse operation (deletes adopted ideas +
sidecars + folders, applies the inverse rename patch, renames disk
folders back). Routes: `GET /upload/renumber-undo` (status for
banner), `POST /upload/renumber-undo/revert` (full undo), `DELETE
/upload/renumber-undo` (manual dismiss). Unlinked Uploads tab gains
an amber banner + Revert/Dismiss buttons + a confirmation modal
listing every planned undo. Boot-time auto-cleans sidecars >30 days
old via `cleanupStaleUndoSidecars` hooked into
`electron/server/boot/migrations.ts`.

**Why:** The atomic three-stage commit is fine for 99% of cases but the
failure mode is bad — half-renumbered project with no rollback path.

**Acceptance (locked 2026-05-03):**
- **Stage 0:** before Stage 1's fs renames, dump the rollback plan to
  `.renumber-undo.json` in the project root. Shape:
  ```jsonc
  {
    "schema_version": 1,
    "performed_at": "2026-05-03T20:30:00.000Z",
    "rename_plan": [{ "old_code": "TN0001", "new_code": "TN0042" }, ...],
    "adopted": [{ "video_id": "...", "code": "TN0001" }, ...]
  }
  ```
- **"Revert renumber" button** on the Unlinked Uploads tab, visible
  while the sidecar exists. Confirmation modal listing what will be
  undone.
- **Full undo** — rolls back EVERY stage: orphan adoptions removed (idea
  + sidecar deleted), ideas.json patch reverted, disk folders renamed
  back. End state matches pre-renumber exactly.
- **Auto-cleanup:** the sidecar self-deletes after **30 days** (cron-
  style check on Electron boot, or on next renumber attempt). Long
  enough to notice and revert; short enough not to clutter long-lived
  projects. The user can also manually click "All good, dismiss" to
  delete the sidecar early.

**Why locked this way:** Half-undo (only fs renames, leave orphans)
leaves the project in a state the user didn't ask for — full undo is
the only honest "rollback". 30-day auto-clean is a reasonable middle
ground between "forever" (clutter) and "next session" (too short to
catch issues that surface days later).

**Files:**
- [electron/server/services/upload-orphans.ts](../electron/server/services/upload-orphans.ts) (`adoptBulkRenumber`)
- New revert function in the same file or a new `upload-renumber-undo.ts`
- [frontend/pages/projects/[slug]/upload.vue](../frontend/pages/projects/[slug]/upload.vue) (Unlinked Uploads tab — banner + revert button)
- Boot-time cleanup hook (auto-delete sidecars > 30d old)

---

## Out of scope (YouTube API limits we surface poorly, not real backlog)

These come from the audit but are YouTube-side limits we'd need to
*surface*, not *fix*. Captured here so they don't get re-raised:

- **Video content replacement is impossible** (YouTube does not permit
  re-uploading a video_id with new content). We could add a clearer
  warning when the user clicks Upload on an already-uploaded row, but
  the underlying limit is permanent.
- **Multi-language / localized snippets** — YouTube supports them, our
  metadata generator produces one. Out of scope for personal-use builds.
- **End screens, cards, comments-disabled, made-for-kids** — set in
  YouTube Studio post-upload. Adding our own surface duplicates YT
  Studio without much value.
- **Channel rename / migration** — sidecar `channel_id` can become stale.
  Rare; documented as a manual fix-up if it ever comes up.
- **Multi-account-per-project** — explicit design choice (one project =
  one channel). If you need multiple channels, use multiple projects.
- **Cross-project dedup** — also explicit. Projects are isolated.

---

## Changelog

When items ship, add a one-line entry here so it's easy to scan what's
been done across versions.

- **v1.0.35** (2026-05-03) — P0 bundle: **C+G** tombstone safety net
  (un-mark verb + auto-show 🪦 chip), **D** Apply preview, **F** auto-Sync
  on 24h cooldown.
- **v1.0.36** (2026-05-03) — P1 bundle: **B** schedule-map drift fix in
  sync, **H** four-verb scope popover (📅 Apply / ☁️ Upload only /
  🚀 Apply + Upload / ↩ Unapply), **9** imports limitation documented in
  picker tooltips, **10** "👁 View selected" bulk-bar action.
- **v1.0.37** (2026-05-03) — P2 starter bundle: **K** typed
  `DeletedReason` enum, **A** Reconcile tab renamed to "Match unlinked"
  with asymmetry-clear copy, **J** YouTube category as project setting
  with 7-day cache + soft fallback dropdown.
- **v1.0.38** (2026-05-03) — P2 next bundle: **E** "Uploaded elsewhere"
  with optional URL + note (🔗 External pill on queue rows), **L**
  renumber rollback (`.renumber-undo.json` Stage-0 sidecar + Revert
  banner + 30-day auto-cleanup).
- **v1.0.39** (2026-05-03) — P2 final: **I** per-item schedule map
  promoted into per-episode sidecars (planning stubs cover not-yet-
  uploaded rows; boot-time eager-sweep migration; legacy map only
  retains `import:*` keys post-migration).
- **v1.0.40** (2026-05-04) — UX polish bundle from beta-test feedback:
  **Compact codes** bulk renumber-down (Ideas tab → "↓ Compact codes" →
  preview modal listing the rename plan, reuses the v1.0.38
  `.renumber-undo.json` infrastructure for 30-day Revert support);
  **stronger Remove safeguard** for accepted ideas (confirm dialog
  warning that the on-disk folder + assets are NOT auto-deleted, then
  10 s undo toast — up from 5 s); **Missing Video cache invalidation**
  on idea remove / dismiss / accept / reset, plus the ↻ Refresh button
  now passes `?nocache=1` so it actually re-scans instead of returning
  the cached snapshot.
- **v1.0.47** (2026-05-04) — Video-assembly silent-failure harness +
  diagnostic instrumentation. Beta-test report: clicking Generate Video
  with the YouTube Fast preset (fps=30) produced no dialog, no toast,
  no progress — completely silent. Static-analysis trace ruled out
  every obvious code path; the failure is somewhere only runtime can
  expose. Two-layer fix: **(A)** defensive try/catch around
  `generateVideo()` so any future thrown error becomes a visible
  toast + console.error, removing the "click does nothing" UX
  forever. **(B)** structured `console.log` instrumentation through
  `runGenerateVideo` and `confirmGeneration` so the next test prints
  exactly which step swallows the failure. Logs are temporary —
  stripped in a follow-up commit once the root cause is identified
  and fixed.
- **v1.0.46** (2026-05-04) — Public-video safety + bigger preview
  modal: two new overlay chips (👁 Public / 🔒 Not yet public) on
  the queue toolbar. Apply-plan **server-side** refuses to PATCH
  rows whose sidecar carries `privacy_status: 'public'` — the prior
  PATCH would silently unpublish a live YouTube video by setting
  `privacyStatus: 'private'` alongside the new `publishAt`. Skips
  are reported per-row (`skipped_public`) and surfaced in the apply
  toast + the scope-picker preview ("👁 N public episode(s) will be
  skipped by Apply"). Local item-schedule map also excludes public
  codes so the queue stays in sync with reality. Pre-upload preview
  modal scales with the viewport (`min(960px, 100vw - 48px)`) and
  the zoomed thumbnail now flips the row into a column so meta /
  description stay readable instead of getting squeezed.
- **v1.0.45** (2026-05-04) — Reseason: change `season_size` and have
  every episode folder rebalanced into the new grouping in one click.
  Settings → Project → "Episodes per Group" now shows a "↻ Rebalance
  N/group" button when the value differs from the saved one — opens
  a preview modal listing every move (`Season 002/TN0011 → Season
  001/TN0011`), confirm runs the bulk fs move + commits the new
  size + cleans up emptied old `Season NNN/` parent dirs. External-
  root mirror is rebalanced in the same step (uses the v1.0.43
  cascade pattern). New `.reseason-undo.json` safety net at the
  project root with sibling Revert banner on Unlinked Uploads tab —
  30-day TTL, boot-time auto-cleanup. Regular Save no longer commits
  a dirty `season_size` (that path silently broke folder lookups
  before this release; now reset + toast nudges the user toward the
  Rebalance button).
- **v1.0.44** (2026-05-04) — Hotfix: pre-upload preview modal threw
  "get is not defined" when clicked. `openUploadPreview` in upload.vue
  used a bare `get` reference, but upload.vue doesn't destructure
  `get` at the top of `<script setup>` like other pages do — every
  other handler in this file does an inline
  `const { get: apiGet } = useApi()`. Fixed to follow the same
  pattern. Caught during v1.0.43 beta testing.
- **v1.0.43** (2026-05-04) — External root rename cascade: every code-
  changing operation (Compact codes, single Renumber, orphan-renumber
  bulk, and the renumber-undo revert) now also renames the matching
  folder + inner files inside `external_final_video_root` when
  configured. Closes a silent reliability bug where renamed episodes
  couldn't find their final video at upload time because the external
  mirror still carried the old code. Failures are non-fatal warnings
  (drive unmounted / unset on this machine / cross-fs EXDEV → all
  surfaced in the result's errors array, project-tree state stays
  correct). Revert path also cleans up external dirs left behind by
  adopted orphans being undone.
- **v1.0.42** (2026-05-04) — Apply-plan skip-claimed-slots: repeat
  applies of a plan now SKIP timestamps already claimed by other
  episodes instead of double-booking them. Episodes inside the apply
  target release their old slots so they can re-claim them. The
  scope-picker preview reflects the same skip logic — what you see
  is what Apply will write. Standalone "preview the plan" tester
  keeps the raw N-slots-from-start_date behaviour. Surfaces a clear
  "ran out of free slots within 2-year horizon" error when the plan's
  density can't accommodate the apply.
- **v1.0.41** (2026-05-04) — Thumbnail control bundle: **per-episode
  thumbnail pin** lives in `upload_metadata_overrides.json` and wins
  over the auto-pick rule (highest `_v{N}`) at upload time. Images
  page picker — click any thumb tile to open the existing lightbox,
  use the new 📌 Pin / Unpin button to lock the variant that gets
  uploaded. Pinned thumbs get a corner badge + amber outline in the
  grid. **Pre-upload preview modal** opens on per-row Upload click
  (bulk paths skip it), showing the exact title / description / tags /
  thumbnail + quota cost before the upload fires. Pinned filenames
  migrate automatically through Renumber, Compact, and orphan-renumber
  cascades via a new `rewriteSelectedThumbnailOnRename` helper. ↻
  Update metadata re-pushes the resolved thumbnail for free (the
  generator's `setThumbnail` runs on both fresh-upload + metadata-
  only branches).
