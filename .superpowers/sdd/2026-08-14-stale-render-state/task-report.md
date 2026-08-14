# Stale Scene Render State

## Root cause

`continuity-render` cleared `.render_status.json` only from its in-process
`finally`. A crash/restart or terminal-history removal can bypass that code,
leaving `active: true`. Scene Review then trusted that sidecar without proving
that the owning queue job was still active.

## Invariant implemented

- A settled Scene Render job (terminal, or paused with no unsettled provider
  evidence) changes only its status sidecar to `active: false` and empties
  `in_flight`; it never deletes or edits rendered images.
- A terminal-history removal/clear performs the same display-state cleanup.
- Active status includes `job_id`; Scene Review displays it only when that
  exact queued/running batch remains active. A paused owner remains visible
  and retains the duplicate-submission lock, but no longer runs the active
  five-minute image poll.
- Resume behavior is unchanged: the existing image audit and missing-only
  selection continue to preserve valid files and submit only missing work.

## Follow-up control and race correction

- Scene Review no longer sends `DELETE /jobs/:id` for a live render. It reads
  the server-provided control classification and sends only `POST /pause` for
  "Pause new submissions" or `POST /cancel` for an eligible cancellation.
  The UI names those actions separately and exposes explicit Resume for a
  paused owner.
- Every Scene Review image entry point stays locked while the owner is queued,
  running, or paused. A resume remains explicit; completed images are still
  preserved and the existing missing-only audit remains authoritative.
- The sidecar writer and ownership-checked cleanup now share the atomic-store
  per-file lock and atomic write. A deterministic interleaving regression
  proves an old cleanup cannot overwrite a newer batch marker.

## Cross-process locking correction

- The sidecar critical section uses the project’s existing atomic lock-file
  pattern: exclusive publish, an owner token, and a recovery guard. A stale
  lock is recoverable only after its local PID is old and OS-proven dead; live,
  corrupt, foreign-host, and otherwise unknown owners fail closed. Recovery
  re-checks ownership while holding the non-stealable guard, and release only
  unlinks its exact owner record.
- A genuine two-`tsx`-process test pauses an old cleanup after its read while
  a newer writer attempts to update the same status file. The newer writer
  waits, then the final marker remains active for the newer job.
- A second two-process regression gives a live owner an old timestamp. The
  contender remains blocked until that owner releases; it cannot replace the
  live owner solely because the marker is old.
- Paused ownership no longer drives `Queuing…` or a spinner. The paused banner
  stays explicit with Resume, in-flight thumbnail spinners stop, and empty or
  preview regeneration controls are visibly disabled until the owner settles,
  is cancelled, or is explicitly resumed.

## Final Scene Review SSE reconciliation correction

- A paused Scene Review GET snapshot no longer wins forever over the global
  Jobs stream. When the stream contains the same `job_id`, its queued/running
  state restores the banner, spinner, poll, and eligible controls; terminal
  stream state clears the owner and those active affordances.
- The reconciliation is keyed by `job_id`, retaining the cached paused owner
  only until the stream has a newer record for that exact batch. Pause/cancel
  classifications and duplicate-submission locks are unchanged.

## Same-episode successor correction

- If the matching cached batch is terminal in SSE, Scene Review now falls
  through to another queued or running render batch for the same episode. The
  terminal record suppresses only its own stale cached snapshot; it cannot
  clear banner, spinner, poll, or controls for the successor batch.

## Safety boundary

The new cleanup does local sidecar reads/writes only. It sends no provider
requests, no cancellation requests, and performs no image/project-data
deletion. Tests use temporary local projects and no provider calls.

## Verification

- RED then GREEN: `scene-render-status.test.ts` now covers terminal, restart,
  removal, paused-owner visibility, and the deterministic serialized race.
- Local mock-only control/queue/state suites: `job-cancel.test.ts`,
  `job-queue.test.ts`, and `scene-render-status.test.ts` — 77 pass, including
  both genuine cross-process ownership regressions.
- Focused frontend suites: `sceneReviewPreview.test.ts`,
  `sceneRenderJobState.test.ts`, and `useJobs.test.ts` — 28 pass, including
  paused snapshot → terminal old batch → queued/running successor
  reconciliation.
- Both `npm run typecheck:electron` and `npm --prefix frontend run typecheck`
  completed in the local toolchain; `npm run lint` and `git diff --check` were
  also run.

## Release gate

Version remains `1.0.841`. Mandatory release metadata is intentionally
deferred; independent re-review returned GO for `72b063a2` with no
Critical/Important findings. The reviewer replayed an aged but still-live
cross-process owner and confirmed the contender waited and retained the newer
active marker. Corrupt and foreign-owner probes also failed closed without
changing status.
