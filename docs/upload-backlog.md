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

### [ ] B · Schedule-map drift fix in sync-from-youtube

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

### [ ] H · Restore "Apply + Upload" as a fourth verb in the scope popover

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

### [ ] 9 · Imports as first-class scope-picker citizens

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

### [ ] 10 · Page-aware metadata enrichment for off-page selections

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

### [ ] A · Rename Reconcile / unify with Queue's Link-existing flow

**Why:** "Sync" and "Reconcile" sound the same to a fresh reader. They're
solving asymmetric problems (drift on linked vs. matching unlinked). The
recent per-row "🔗 Link existing video" makes the Reconcile tab partially
redundant for the single-video case.

**Acceptance:**
- Either: rename Reconcile to "Match unlinked" with copy-fix making the
  asymmetry explicit, OR: fold the single-video adoption flow into the
  Queue's Link Video modal and demote Reconcile to a bulk-only secondary
  tab.

**Discussion:** _Big change to surface area; defer until P0/P1 land so
we have stable copy to migrate from._

---

### [ ] E · "Uploaded elsewhere" with external account note

**Why:** Today: mark-legacy-uploaded (no video_id) OR link-existing-video
(full sidecar). Sometimes you want the in-between: "this is on a
different account, leave it alone but record where".

**Acceptance:**
- Extend the legacy-uploaded marker to accept an optional `external_url`
  + `note` field. Surface in the row's hover/title so the user remembers
  why they marked it.

**Files:**
- [electron/server/routes/upload.ts](../electron/server/routes/upload.ts) (mark-legacy-uploaded route)
- Sidecar schema or a separate "external link" sidecar variant

**Discussion:** _none yet_

---

### [ ] I · Promote per-item schedule map into the sidecar

**Why:** `config.upload_item_schedule` is a separate config blob. Sidecar
is the right home — single source of truth per episode. Reduces drift
risks (#B becomes a non-issue).

**Acceptance:**
- Migrate on next read (write to sidecar, leave the old map for one
  release of back-compat, then drop).
- Plans + per-row schedule edit both write through the sidecar.

**Files:**
- [electron/server/services/upload-sidecar.ts](../electron/server/services/upload-sidecar.ts)
- [electron/server/services/upload-plans.ts](../electron/server/services/upload-plans.ts)

**Discussion:** _Migration is the risky bit; need a one-time boot-time
sweep that handles existing project configs._

---

### [ ] J · CategoryId as a project setting

**Why:** Hard-coded to 22 ("People & Blogs"). Fine for sleep-stories but
not universal.

**Acceptance:**
- Add `category_id` to ProjectConfig (default 22).
- Surface as a Settings → Project field. Validate against YouTube's
  category list (cached).

**Files:**
- [electron/server/models/types.ts](../electron/server/models/types.ts) (ProjectConfig)
- [electron/server/lib/upload-metadata.ts](../electron/server/lib/upload-metadata.ts) (categoryId hard-code at ~line 234)
- [frontend/pages/projects/[slug]/settings.vue](../frontend/pages/projects/[slug]/settings.vue)

**Discussion:** _none yet_

---

### [ ] K · Typed `deleted_reason` enum

**Why:** Free-form string today (`'sync_404' | 'manual' | <whatever>`).
Easy to drift as new detection paths add their own.

**Acceptance:**
- Move to a typed union; use the type at all write sites.

**Files:**
- [electron/server/services/upload-sidecar.ts](../electron/server/services/upload-sidecar.ts)

**Discussion:** _Trivial; bundle with the next sidecar-touching commit._

---

### [ ] L · Renumber rollback

**Why:** The atomic three-stage commit is fine for 99% of cases but the
failure mode is bad — half-renumbered project with no rollback path.

**Acceptance:**
- Stage 0: dump the old → new code map as a sidecar (e.g.
  `.renumber-undo.json` in the project root) before Stage 1.
- "Revert renumber" button visible on the Unlinked Uploads tab while
  that sidecar exists. Deletes itself when the user confirms everything
  looks right.

**Files:**
- [electron/server/services/upload-orphans.ts](../electron/server/services/upload-orphans.ts) (`adoptBulkRenumber`)

**Discussion:** _none yet_

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
