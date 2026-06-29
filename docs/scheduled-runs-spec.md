# Phase 1 — Scheduled unattended pipeline runs (spec)

Status: draft / proposed. Goal: let the app produce episodes on a recurring
schedule with no human at the keyboard ("2 episodes every night at 1am").

This reuses three things that already exist, so it's mostly assembly:

- **The tick pattern** — `electron/server/services/digest-scheduler.ts` (a
  60-second `setInterval` that fires once/day when the wall clock crosses a
  configured local time, deduped by `last_fired_date`).
- **The work trigger** — `POST /projects/:slug/pipeline/run-batch` in
  `electron/server/routes/pipeline.ts:888` (enqueues a full step chain for N
  episodes; async; idempotent; dedup-guarded; disk-space pre-checked).
- **The settings/persistence + boot wiring** — `job-notifier.ts`
  (`getNotifierSettings`/`setNotifierSettings` over `app-settings.json`) and
  `main.ts:637` (`startDigestScheduler(dispatcher)` mounted at boot).

---

## 1. Architecture decisions

### 1a. Refactor `run-batch` into a reusable function (prerequisite)
The batch logic currently lives *inside* the Express handler at
`pipeline.ts:888`. The scheduler runs in-process and should NOT make an HTTP
call back to localhost. Extract the body into a service:

```
// electron/server/services/run-batch.ts
export interface RunBatchInput { episode_ids: string[]; steps: BatchStep[]; force?: boolean }
export interface RunBatchResult { batch_id; enqueued; total_jobs_planned; skipped; steps_skipped_as_done; ... }
export async function runBatch(slug: string, input: RunBatchInput): Promise<RunBatchResult>
// throws RunBatchError (with .status + .detail) for the 400 cases (missing preset,
// no voice, not enough disk) so the route can map them to HTTP responses.
```

The route at `pipeline.ts:888` becomes a thin wrapper: parse body → call
`runBatch` → map result/`RunBatchError` to JSON. **No behavior change** for the
existing `/remote` UI. The scheduler calls `runBatch` directly.

> Why: single source of truth, unit-testable without Express, and the
> scheduler inherits all the safety rails (preset validation, voice check,
> disk pre-check, dedup) for free.

### 1b. In-process service, not a separate daemon
Build it alongside `digest-scheduler.ts`. Job queue, presets, and generators
all live in this process — splitting out would be a rewrite. The app must be
running (same constraint the digest already lives with).

### 1c. Multiple schedules, stored per-machine in `app-settings.json`
The user runs several channels. Support an **array** of schedule entries
(different project / time / steps / count), persisted under a new
`schedules` key via the existing `getAppSetting`/`setAppSetting` helpers —
mirroring how `digest` config is stored.

---

## 2. Data model

New key in `app-settings.json` (new `schedule-config.ts` service, same shape
of helpers as `job-notifier.ts`):

```ts
export interface ScheduleEntry {
  id: string                 // uuid
  enabled: boolean
  label: string              // "Sleep stories — nightly"
  project_slug: string
  time_local: string         // "01:00" (24h, machine-local)
  days: number[]             // 0–6 (Sun–Sat); [] or [0..6] = every day
  steps: BatchStep[]         // same VALID_STEPS the run-batch route accepts
  max_episodes: number       // how many to enqueue per fire (the "N")
  force: boolean             // default false — skip already-done steps
  selection: 'oldest-accepted-with-work'  // v1 strategy (see §4); leave room to grow
  last_fired_date?: string   // YYYY-MM-DD local — dedupe, exactly like digest
  notify_on_fire?: boolean   // send a Telegram/desktop "kicked off N episodes" note
}

export interface ScheduleSettings { schedules: ScheduleEntry[] }
```

Backwards-compatible: missing key → `{ schedules: [] }` → scheduler is a no-op.

---

## 3. The tick (clone of digest-scheduler)

`electron/server/services/run-scheduler.ts`:

```
startRunScheduler()           // mounted in main.ts after installJobNotifier()
stopRunScheduler()
tick()  every 60s:
  load ScheduleSettings (try/catch → return on error)
  const now = new Date(); const today = localYmd(now)
  for each entry where entry.enabled:
    if !dayMatches(now, entry.days) continue
    if !isFireWindow(now, entry.time_local) continue       // reuse digest's 5-min window helper
    if entry.last_fired_date === today continue              // dedupe
    const episodeIds = await selectEpisodes(entry)           // §4
    if episodeIds.length === 0:
       setLastFired(entry.id, today)                          // mark fired even when empty (quiet)
       continue
    try:
       const result = await runBatch(entry.project_slug, { episode_ids: episodeIds, steps: entry.steps, force: entry.force })
       setLastFired(entry.id, today)
       if entry.notify_on_fire: dispatch("Scheduled run: enqueued {result.enqueued} episode(s) for {project}")
    catch (e):
       // DO NOT set last_fired — let next minute's tick retry within the window
       console.error('[run-scheduler] fire failed', e)
```

Reuse `isFireWindow` and `localYmd` verbatim from digest-scheduler (extract
them to a small shared `lib/local-time.ts` so both schedulers import one copy).

**Concurrency:** the job queue serializes heavy jobs already, so firing N
chains just fills the queue; no extra throttle needed in v1. Idempotency +
the per-(project,episode,type) dedup in `enqueue` (`job-queue.ts:702`) mean a
re-fire or an overlap with a manual `/remote` run can't double-produce.

---

## 4. Episode selection (the one genuinely new bit of logic)

`run-batch` takes explicit `episode_ids`. The `/remote` page passes *all*
accepted episodes and leans on idempotency. For a scheduler we want "produce
**N** per night," so we pick a bounded set:

**v1 strategy `oldest-accepted-with-work`:**
1. `const ideas = await im.getIdeas(slug, 'accepted')` (same call run-batch uses at `pipeline.ts:971`).
2. Keep those with an `episode_code`.
3. For each, `computeEpisodeStatus(slug, code)` and drop ones where every
   `entry.steps` step is already done (reuse `isStepAlreadyDone` — the same
   predicate run-batch uses at `pipeline.ts:1008`).
4. Drop episodes whose first step is already queued/running (`jq.isDuplicate`).
5. Sort oldest-first (by idea creation / accepted order) and take
   `entry.max_episodes`.

This makes a nightly entry walk the backlog N at a time without re-touching
finished episodes. Selection is a pure-ish helper → unit-testable with a fake
ideas list + status fn.

> Open question for you: when the backlog is empty, just go quiet (recommended)
> or send a "nothing to produce tonight" note? `notify_on_fire` covers the
> first; a `notify_when_empty` flag could cover the second if you want it.

---

## 5. Settings UI

Add a "Scheduled runs" card. Two reasonable homes:
- **Settings → Automation** (global, matches where digest config lives), or
- a section on the existing **`/remote`** page (it's already the
  "operate this channel" surface, phone-friendly over Tailscale).

Recommend: list of schedule entries with enable toggle, project picker, time,
day chips, step multiselect (reuse the same step list the `/remote` "Full
run / Up to review" control builds), `max_episodes`, force toggle, and a
**"Run this schedule now"** button (fires the same `runBatch` path immediately,
without touching `last_fired_date` — mirrors digest's `sendDigestNow`).

New routes (thin, mirror the notifier settings routes):
```
GET    /app-settings/schedules
PUT    /app-settings/schedules
POST   /app-settings/schedules/:id/run-now
```

---

## 6. Keep-awake (operational requirement)

Both Phase-1 and the future Phase-2 need the Mac awake. The scheduler can't
fire if the machine is asleep. Options, simplest first:
- **Manual:** System Settings → Energy → "Prevent automatic sleeping" (Mac
  mini: trivial; iMac: same). Document this.
- **App-managed (nice-to-have):** when at least one schedule is enabled, hold a
  power-assertion so the app keeps the Mac awake. Electron's `powerSaveBlocker`
  (`powerSaveBlocker.start('prevent-app-suspension')`) does this with no native
  deps — start it when ≥1 schedule is enabled, stop when none are. Note this
  prevents *system* sleep, not display sleep, which is what we want.

Recommend documenting the manual route for v1 and adding `powerSaveBlocker`
as a fast follow.

---

## 7. Edge cases / safety

- **Cost runaway:** `max_episodes` is the hard cap per fire. The disk pre-check
  in `runBatch` still applies. Consider a global "max scheduled episodes/day"
  ceiling later.
- **App restart inside the fire window:** `last_fired_date` dedupe handles it
  (same as digest).
- **Missing preset / no voice:** `runBatch` throws `RunBatchError`; the tick
  logs it and (recommended) sends one Telegram alert so a misconfigured
  schedule doesn't silently no-op every night. Don't set `last_fired` so it
  retries — but cap retries by the 5-min window naturally closing.
- **Clock/timezone:** all local-time, like digest. No UTC conversion.
- **Overlap with manual runs:** `enqueue` dedup prevents duplicates; safe.

---

## 8. Testing

- `run-scheduler.test.ts` — `tick()` with a fake clock + fake
  `ScheduleSettings`: fires in window, skips outside, dedupes on
  `last_fired_date`, respects `days` and `enabled`, marks-fired-when-empty,
  does-not-mark-on-error. (Mirror the existing digest tests if present.)
- `selectEpisodes` — pure unit test with a fake ideas list + status fn:
  caps at `max_episodes`, drops done, drops already-queued, oldest-first.
- `run-batch.ts` — move/extend the existing route-level expectations into the
  extracted function; assert `RunBatchError` for the three 400 paths.

---

## 9. Build order (smallest shippable steps)

1. Extract `runBatch()` from the route (§1a) + tests. Ship — pure refactor,
   no user-visible change.
2. Add `schedule-config.ts` (data model + get/set) + `lib/local-time.ts`
   (shared `isFireWindow`/`localYmd`). 
3. Add `run-scheduler.ts` + `selectEpisodes` + tests; mount in `main.ts`
   next to `startDigestScheduler`. Behind enabled flag → no-op until
   configured.
4. Add the settings routes + UI card + "Run now".
5. `powerSaveBlocker` keep-awake (fast follow).

Each step is independently shippable; after step 3 you can hand-edit a
schedule into `app-settings.json` and it works before the UI exists (good for
your own dogfooding on the Mac mini).
```
