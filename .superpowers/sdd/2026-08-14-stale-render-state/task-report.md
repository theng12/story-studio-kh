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
  exact queued/running batch remains active. Older terminal history cannot
  deactivate a newer batch's marker for the same episode.
- Resume behavior is unchanged: the existing image audit and missing-only
  selection continue to preserve valid files and submit only missing work.

## Safety boundary

The new cleanup does local sidecar reads/writes only. It sends no provider
requests, no cancellation requests, and performs no image/project-data
deletion. Tests use temporary local projects and no provider calls.

## Verification

- RED then GREEN: `scene-render-status.test.ts` (6 tests covering reader
  ownership, terminal, active, newer-batch protection, restart, and removal).
- `job-cancel.test.ts` + `job-queue-persistence-retention.test.ts`: 37 pass.
- `job-queue-stale-running-persist.test.ts` + focused new tests: 7 pass.
- `scene-image-batch-selection.test.ts`: 3 pass.
- `npm run typecheck:electron`: pass.
- `npm run lint`: pass with the repository's pre-existing warnings; full lint
  cannot satisfy zero warnings (1,721 baseline warnings). The new helper
  passes zero-warning lint and `git diff --check` passes.
