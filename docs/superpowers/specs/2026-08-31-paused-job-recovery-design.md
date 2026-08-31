# Paused Job Recovery v1.4.90 Design

**Status:** Owner-approved. This document is the authoritative behavior and safety contract for implementation.

## Outcome

Story Studio will stop turning transient local reachability and automatic stall protection into permanent operator work. Queue-owned holds heal whenever the global queue is running. Stall-owned holds resume only through the existing durable, evidence-gated recovery path. A user pause remains paused until the user explicitly resumes it. The Jobs workspace gains a deterministic Paused view and one action to rejoin all paused work in the scope the user is looking at.

This is a queue-recovery and Jobs-UX correction. It is not a second scheduler, a replacement-job system, a provider retry engine, or a new persistence layer.

## Evidence and Current Ownership

The inspected baseline is commit `d5a3d87aa97962a755ba2779886afd644ad72752` (v1.4.89).

- `frontend/composables/useNetworkStatus.ts` probes the local `/api/health` endpoint, but also POSTs `/api/system/queue/pause` after one failed probe and POSTs Resume on recovery. A local UI reachability reading is not authority to mutate paid work.
- `electron/server/services/job-queue.ts` persists pause origin as `manual`, `queue`, or `stall`. `setQueuePaused(false)` releases only loaded queue-origin jobs and only on an in-memory `true -> false` transition. Persisted queue-origin jobs loaded later remain paused even when the durable global setting is false.
- The same queue service already has the required safety foundations: durable job IDs, task manifests, GenStudio request identities, read-only provider reconciliation, stable-output checks, atomic per-project snapshots, one queue per lane, and executor-owned missing-output audits.
- `pauseJobForStall()` is currently called only by Continuity Render. It pauses at a cooperative boundary and does not cancel accepted provider work. Reconciliation can later prove accepted work settled, but nothing currently requeues the paused record.
- `frontend/pages/projects/[slug]/jobs.vue` is the shared Project Jobs and All Jobs surface. It already has page, project, job-type, status, and failure-batch filters, but no Paused status chip, no bulk resume route, and no busy state on row Resume.

The three supporting diagnostics remain source evidence:

- `/build/Developer/_handoffs/artifacts/story-studio-paused-jobs-diagnostic/pause-lifecycle.md`
- `/build/Developer/_handoffs/artifacts/story-studio-paused-jobs-diagnostic/resume-latency-bulk.md`
- `/build/Developer/_handoffs/artifacts/story-studio-paused-jobs-diagnostic/runtime-evidence.md`

## State Policy

| Pause origin | Who chose it | Automatic recovery | Explicit bulk Resume |
|---|---|---|---|
| `manual` | User pressed a row pause control | Never | Yes; the bulk action is an explicit user instruction |
| `queue` | The global queue hold | Always when the durable global queue setting is false | Yes |
| `stall` | Story Studio's Continuity Render circuit breaker | Only after safe provider reconciliation and stable-output eligibility | Yes |

Unknown or legacy missing origin is treated as manual. The implementation must not infer that an old paused record is safe to start.

### Health is informational only

`useNetworkStatus` may report whether the local Story Studio engine answers `/api/health`, update `lastChecked`, and retry its own probe. It must never call queue pause/resume endpoints or mutate queue state indirectly. Browser online/offline events remain hints to probe, not work-control signals. The dashboard may say the local engine is unavailable, but it must not claim a queue command failed because it will no longer send one.

Existing durable global queue state remains owner-controlled. There is no migration that silently clears a persisted `true` value: a genuine owner hold must not be mistaken for an old health hold.

### Queue-origin recovery is an invariant

The invariant is:

> Once the authoritative global queue setting is `false`, no loaded or subsequently loaded job may remain `paused` with `pause_origin === 'queue'`.

This is not conditional on observing a `true -> false` transition. It must hold when Resume is posted twice, when a project loads after Resume, when Resume races a project load, when the app crashes midway through release, and at boot with the global setting already false.

Queue-pause setting initialization must be single-flight. A caller that arrives while the setting is being read must await the same promise; it must not observe the default `false` before a durable `true` has loaded. Persisted-job loading must await this initialization before classifying queue-origin pauses. Both sides of the race enforce the invariant: global Resume releases all loaded queue-origin holds even if the setting was already false, and a project-load completion releases any queue-origin holds it just loaded when the setting is false.

Manual and stall holds are never released by the global Resume operation.

### Stall-origin recovery is evidence-gated

A stall-origin record may automatically rejoin only when all of the following are true:

1. It is still `paused` with `pause_origin === 'stall'`; the global queue is not paused; and no later manual pause or cancellation intent superseded it.
2. Its executor is registered, its local execution reached the cooperative boundary, and its output naming is stable enough for the existing manifest/task-ID recovery path.
3. It has no cancellation context and no provider outcome whose settlement is unknown.
4. Every previously accepted provider task has been checked through the existing read-only authoritative reconciliation path. Pending, unreachable, ambiguous, or partially published settlement leaves the record paused and schedules no new provider submission.
5. The existing executor remains the sole authority for reclaiming succeeded work and deciding whether a genuinely unsubmitted or fully released item can be submitted. The recovery controller must not call GenStudio, manufacture retry identities, or submit provider work itself.

For Continuity Render, the current stable scene IDs and task manifest satisfy the output-identity requirement. A succeeded task is reclaimed by its recorded ID. A failed task is retried only if the executor's existing exact allow-list and settlement proof permit it. An unknown code, charged/partially released failure, content refusal, or uncertain submission remains fail-closed. This preserves the same durable job ID, task identities, output directory, file names, partial files, duplicate lock, and credit evidence.

If a stalled job loads with already-terminal evidence and satisfies the gate, it may rejoin immediately. If evidence is unsettled, reconciliation runs first and invokes the same gate only after an authoritative terminal result. A reconciliation error or inability to reach GenStudio leaves the job paused with an actionable reason; it never starts a replacement request.

No new timer, retry daemon, recovery record, or dependency is needed. Reuse the existing boot load, reconciliation completion, executor, and queue admission seams.

## Explicit Bulk Resume

### Exact client scope

The shared Jobs page has two page scopes and two meaningful narrowing controls:

1. **Page scope:** Project Jobs is fixed to its route slug; All Jobs starts with all projects.
2. **Project filter:** available only in All Jobs; `all`, a concrete project slug, or `_app_`.
3. **Job-type tab:** `all` or one exact job type.
4. **Status chip:** controls which state is visible.

The bulk action targets paused records in the selected page/project and job-type scope. Status is the target state, not a second request parameter:

- show `Resume paused work (N)` only while status is **All** or **Paused**;
- hide it on Running, Queued, Needs attention, Done, and Cancelled so it never acts on rows hidden behind another status view;
- selecting **Paused** clears the existing failure-batch filter, as every status-chip selection already does;
- compute status-chip counts after applying page/project and job-type scope, so the Paused count equals the rows the Paused view can show;
- failure-batch scope is error-only and never participates in paused selection.

The UI sends scope, not arbitrary job IDs. This prevents a stale browser snapshot from choosing records the server no longer considers paused.

### Routes and request contract

- `POST /api/projects/:slug/jobs/resume-paused` with optional body `{ type?: JobType }`.
- `POST /api/jobs/all/resume-paused` with optional body `{ project_slug?: string, type?: JobType }`.

Project routes cannot cross their slug. The universal route validates an optional project slug against the same project scopes used by the universal jobs snapshot, including `_app_`. `type` is omitted for All and otherwise must be a registered `JobType`; invalid scopes return 400/404 without changing a job.

Successful responses are `202` with aggregate customer-safe facts:

```ts
{
  requested: number
  resumed: number
  skipped: number
  skipped_reasons?: Array<{
    reason: 'no-executor' | 'persistence-failed'
    count: number
  }>
}
```

The normal response does not expose internal job IDs. Existing SSE updates remain the authoritative row projection.

### Atomicity and efficiency

The queue service snapshots selected paused records once. For every affected project it:

1. validates every selected record before mutation;
2. applies the same field transition as single `resumeJob()` to the same in-memory records;
3. writes one atomic `jobs.json` project snapshot;
4. rolls that project's in-memory changes back if the write fails;
5. only after durable success, appends the existing records to their existing lanes and emits their SSE updates.

After all project groups finish, it calls `pump()` once per affected lane, not once per record. There is one persistence write per affected project, not one per job. Partial success across projects is allowed and reported by counts; within one project the batch is all-or-none. The service does not run an executor inline.

The same internal batch transition should release multiple queue-origin records during global/boot recovery so those paths also avoid N full rewrites and N pumps. Single-row Resume remains one row, one project write, and one lane pump.

### Immediate feedback

- A row Resume click synchronously adds its job ID to the existing per-row busy set before awaiting HTTP, disables the button, and changes its label to `Rejoining…`.
- Bulk Resume synchronously sets one `bulkResumeBusy` state, disables only that action, and labels it `Rejoining N jobs…`.
- Double click or repeated invocation while busy sends one request.
- Success copy reports the server's resumed/skipped counts; failure restores the control and preserves the projected job state. No optimistic durable status is invented before the server response/SSE.

## Persistence, Billing, and Completion Invariants

- Never create a replacement Story job for recovery. `job_id` is unchanged.
- Never change episode, type, params, content-pack provenance, task identities, output paths, file names, saved files, manifests, or provider evidence merely to resume.
- Never call a provider from a route, health composable, reconciler completion hook, or bulk controller. Only the registered executor may act after normal queue admission.
- Never auto-requeue unresolved, charged-unknown, or submission-uncertain provider work.
- Never weaken duplicate ownership, cancellation reconciliation, completion auditors, missing-output audits, or credit settlement gates.
- Never auto-resume a manual or unknown-origin pause.
- Queue recovery must be idempotent. Repeated Resume, repeated project load, duplicate SSE delivery, or boot/route races must not enqueue the same durable record twice.
- A persistence failure means the affected project remains paused in memory and on disk.

## UX and Accessibility Contract

- Add a visible **Paused** status chip with the same native-button, `aria-pressed`, focus-ring, and keyboard behavior as the existing chips.
- Keep row and bulk actions as native buttons with a disabled busy state; busy text must remain legible and must not shift card layout materially.
- On wide layouts, the bulk Resume action shares the status action area without displacing filters. On narrow layouts, filters/actions wrap into full-width readable rows with no horizontal page overflow, clipped labels, or unreachable controls.
- Preserve the existing project/type/status navigation, SSE refresh, sort, pagination, Technical details, and customer-safe identifier redaction.
- Rendered QA must inspect Project Jobs and All Jobs at desktop and approximately 390 px widths, keyboard focus, disabled/busy appearance, wrapping, and screen-reader names. Source assertions alone do not satisfy this requirement.

## Release and Delivery

Release as **v1.4.90**:

- bump `package.json` and both root version surfaces in `package-lock.json`;
- add the newest-first `CHANGELOG.md` entry explaining automatic recovery, Paused filtering, and one-click rejoin in customer language;
- add no production or development dependency;
- run focused tests during TDD and the complete `npm run verify` release gate;
- obtain independent code review and address every finding;
- push the verified branch, create/update a pull request, and merge only when checks/review/mergeability are clean;
- synchronize the main checkout after merge;
- build and verify the unsigned smoke DMG from the **main repository root** into its normal `dist/` folder;
- remove the merged feature worktree/branch only after merge, main sync, DMG verification, and clean-status checks. Do not touch unrelated worktrees.

Publishing, uploading, installing, tagging, or changing customer job data is outside this release.

## Non-goals

- No automatic global pause based on frontend health.
- No “resume every paused job at startup.”
- No auto-resume for manual or unknown-origin pauses.
- No replacement job IDs, provider requests from control routes, or blanket retry of failed tasks.
- No new database, queue, state machine, timer service, dependency, or compatibility layer.
- No redesign of Jobs cards, billing copy, retry/repair semantics, global queue controls, or provider settlement display.
- No mutation of existing customer `jobs.json` during development or QA.

## Acceptance Matrix

| Scenario | Required result |
|---|---|
| `/api/health` fails once or repeatedly | Offline/reachability UI updates; zero queue-control POSTs |
| Durable global setting false + loaded queue-origin pause | Same job requeues once |
| Global Resume called while state already false | Loaded queue-origin pauses requeue once |
| Project loads after or during global Resume | Queue-origin pauses cannot remain stranded |
| Manual pause through boot/global Resume | Remains paused |
| Stall pause with unsettled provider task | Remains paused while read-only reconciliation continues |
| Stall pause after authoritative safe settlement | Same durable job requeues once through normal lane |
| Stall pause with unknown/unsafe settlement | Remains paused; no provider submission |
| Bulk project scope | Only paused jobs in that project and selected type rejoin |
| Bulk universal + project filter | Only paused jobs in selected universal project scope and type rejoin |
| Bulk universal all projects | One write per affected project; one pump per affected lane |
| Double-click row or bulk Resume | One request |
| Project persistence failure | That project's records stay paused; other projects may succeed; counts are accurate |
| Paused filter | Count and rows match current page/project + type scope |
