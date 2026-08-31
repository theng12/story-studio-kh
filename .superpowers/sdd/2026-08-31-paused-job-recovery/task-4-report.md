# Task 4 report — server-scoped bulk paused-job Resume

## Status and commit

Implemented Task 4 only in
`b0b6c9991071824f8ba07e310184073ecf0c8f7b`
(`feat: resume paused jobs by server scope`). The implementation commit changes
exactly:

- `electron/server/__tests__/jobs-resume-paused-routes.test.ts`
- `electron/server/__tests__/jobs-route-order.test.ts`
- `electron/server/services/job-queue.ts`
- `electron/server/routes/jobs.ts`

No UI, version, changelog, dependency, customer data, provider control,
replacement job, packaging, push, merge, later task, or unrelated worktree was
touched.

## RED evidence

Baseline route-order selection before tests: **3 passed, 0 failed**.

After adding the Task 4 service/route tests:

```text
node scripts/testing/run-backend-tests.mjs \
  --only jobs-resume-paused-routes --only jobs-route-order
3 passed, 5 failed of 8; 2/2 selected files completed
configured projects root byte-identical: true
```

The five intended failures were: both new route requests returned 404, both
service tests reported `resumePausedJobs is not a function`, and the route-order
guard reported the literal universal Resume route missing. The project literal
route was absent under the same structural assertion.

Self-review added a persisted retired-type/no-lane fixture. Its RED was
**3 passed, 1 failed of 4**: requested/resumed/skipped totals were already
correct, but `no-executor` counted 1 instead of 2. The shared transition now
classifies both an absent lane and a lane without an executor as
`no-executor` for explicit bulk requests.

## GREEN and verification evidence

Final focused GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only jobs-resume-paused-routes --only jobs-route-order
8 passed, 0 failed; 3 suites; 2/2 selected files completed
configured projects root byte-identical: true
```

Final required adjacent GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only job-queue --only jobs-stream --only jobs-route-order \
  --only jobs-resume-paused-routes
102 passed, 0 failed; 26 suites; 10/10 selected files completed
configured projects root byte-identical: true
```

One earlier adjacent run was **101/102** because the new test's pump observer
also saw an unrelated `script-only` pump released by its own global-queue setup.
The assertion was narrowed to its owned `broll_assemble` lane; the production
code did not change for that test-isolation correction.

Additional fresh checks before commit:

```text
npm run typecheck:electron
exit 0

npx eslint electron/server/services/job-queue.ts electron/server/routes/jobs.ts --quiet
exit 0

git diff --check
exit 0
```

All backend runs above are intentionally focused partial runs, not the release
gate.

## Implementation and self-review

- The routes accept only server-owned scope fields, reject extra fields such as
  client job-ID arrays, validate exact `JOB_TYPES`, and resolve concrete,
  all-project, and `_app_` scopes before loading or mutating jobs.
- Project scope cannot cross its route slug. Unknown scopes and invalid types
  return 404/400 before mutation. Literal routes register before job-ID
  wildcards.
- Explicit bulk Resume selects only paused records in the exact project/type
  scope, including manual, queue, stall, and legacy originless holds. Running,
  queued, and terminal records are not selected.
- The Task 2 `transitionPausedJobsToQueuedByProject` remains the only batch
  engine. Explicit options allow the user action while the global queue is held
  and require a registered executor; automatic queue/stall call sites retain
  their narrower origin and safety gates.
- Each successful project receives one atomic snapshot. A forced write failure
  restores every selected record in that project in memory and on disk while a
  different project succeeds. Successful lanes are pumped once each after
  durable transition.
- Concurrent identical calls produce one requested/resumed record, one project
  write, one lane pump, and one executor run. Pending insertion retains the
  existing durable job-ID dedupe and post-persistence superseding-intent check.
- Job IDs, params, output directory, Content Pack provenance, task-manifest
  data, and GenStudio/provider settlement evidence remain unchanged. SSE emits
  only the successfully resumed rows. Responses contain aggregate counts and
  approved reason names only, with no job IDs.
- No second transition engine, timer, provider call, dependency, persistence
  format, or compatibility layer was introduced.

No High/Critical self-review finding remains.

## Concerns and clean status

Independent Task 4 atomicity/API review remains for the primary task owner, as
required before Task 5. Full backend/release verification, version/changelog,
integration, and packaging remain assigned to later tasks.

Immediately after implementation commit `b0b6c999`, `git status --short` was
empty. The process audit found no surviving focused backend-test or `tsx --test`
process for this worktree.

## Independent-review corrections

Commit `3b79c973d1f71b24466ac400e3145cf7bfc00654`
(`fix: serialize bulk Resume ownership`) resolves both findings in
`task-4-review.md`.

### Review-fix RED evidence

The deterministic overlap and failed-persistence races began at:

```text
node scripts/testing/run-backend-tests.mjs --only jobs-resume-paused-routes
4 passed, 3 failed of 7; 1/1 selected file completed
configured projects root byte-identical: true
```

The three intended failures were:

- while an all-project request was blocked writing project A, a concrete
  project-B request still reported `{ requested: 1, resumed: 1 }` instead of
  observing that row as already owned;
- a later manual Pause was accepted while the failed bulk write was blocked,
  but rollback restored the original `stall` origin over `manual`;
- a later queued-job cancellation reached `cancelled` before the forced bulk
  failure, but rollback restored `paused` over `cancelled`.

The controls use promise barriers around exact project rename operations and
microtask advancement only where `requestJobCancellation()` first awaits the
already-loaded project. No sleep or wall-clock delay establishes ordering.

### Review-fix GREEN evidence

Final focused GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only jobs-resume-paused-routes --only jobs-route-order
11 passed, 0 failed; 4 suites; 2/2 selected files completed
configured projects root byte-identical: true
```

Final adjacent GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only job-queue --only jobs-stream --only jobs-route-order \
  --only jobs-resume-paused-routes
105 passed, 0 failed; 27 suites; 10/10 selected files completed
configured projects root byte-identical: true
```

The adjacent run exited 0 but printed the already-documented late
`jq-no-chat-retry-scope` temporary-directory cleanup warning after that
fixture's assertions settled. The same unrelated warning is recorded in the
Task 2 report; no process survived and the configured projects-root guard
remained byte-identical.

Additional fresh checks:

```text
npm run typecheck:electron
exit 0

npx eslint electron/server/services/job-queue.ts electron/server/routes/jobs.ts --quiet
exit 0

git diff --check
exit 0
```

### Corrected ownership and rollback behavior

- The shared batch transition now claims every eligible job ID synchronously,
  before its first project persistence await. Explicit service selection and
  Task 2/3 direct transition calls both honor the same claim set.
- Overlapping all-project/project requests therefore cannot re-transition,
  rewrite, re-emit, re-pump, or re-execute the same durable row. The controlled
  test proves one project-B queued snapshot, one Resume log line, one queued
  SSE update, one lane pump, and one executor run.
- Claims are released in `finally`, including persistence failures. They are
  in-memory coordination only and add no durable state or persistence format.
- Failed project persistence restores a snapshot only while the row still has
  the batch-owned queued state. A later accepted manual Pause or cancellation
  is never overwritten; its already-waiting `persistJob()` writes the latest
  state after the failed bulk lock releases.
- Other rows in the same failed project still roll back, preserving the
  existing all-or-none bulk transition. Successful projects remain successful,
  lane pumping remains once per affected lane, and no provider or executor is
  called inline.

No open implementation concern remains. Independent re-review is required
before Task 5. Immediately after commit `3b79c973`, the worktree was clean and
the process audit found no surviving focused backend-test or `tsx --test`
process for this worktree.

## Re-review boundary correction

Implementation commit `107e650aaffb8fabe3dddcd5bb07b321ea9a4fcd`
(`fix: revalidate bulk Resume at project boundary`) resolves the remaining P1
appended in `task-4-review.md`.

### Boundary-fix RED evidence

The deterministic two-project cancellation race began at:

```text
node scripts/testing/run-backend-tests.mjs --only jobs-resume-paused-routes
7 passed, 1 failed of 8; 3 suites; 1/1 selected file completed
configured projects root byte-identical: true
```

The test blocked project A's exact snapshot rename, completed and durably
verified cancellation of already-claimed project B, then released project A.
Before the correction, bulk Resume falsely returned
`{ requested: 2, resumed: 2, skipped: 0 }` instead of resuming only A and
counting B as skipped. The promise barriers establish ordering without sleeps
or wall-clock timing.

### Boundary-fix GREEN and verification evidence

Final focused GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only jobs-resume-paused-routes --only jobs-route-order
12 passed, 0 failed; 4 suites; 2/2 selected files completed
configured projects root byte-identical: true
```

Final adjacent Task 2/3 and Task 4 GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only job-queue --only jobs-stream --only jobs-route-order \
  --only jobs-resume-paused-routes
106 passed, 0 failed; 27 suites; 10/10 selected files completed
configured projects root byte-identical: true
```

Additional fresh checks:

```text
npm run typecheck:electron
exit 0

npx eslint electron/server/services/job-queue.ts electron/server/routes/jobs.ts \
  electron/server/__tests__/jobs-resume-paused-routes.test.ts --quiet
exit 0

git diff --check
exit 0
```

All backend runs above are focused partial runs, not the release gate.

### Corrected project-boundary behavior and concerns

- Each claimed row is revalidated immediately before its project's synchronous
  snapshot/mutation boundary: the live map must still own the same object, the
  transition claim must still exist, status must still be paused, and neither
  Pause nor Cancel state may supersede Resume.
- A cancellation completed while an earlier project persists therefore remains
  cancelled in memory and on disk. It receives no Resume log, snapshot write,
  queued SSE event, lane pump, or executor call.
- The initial server-owned selection remains the truthful `requested` count;
  only durable eligible rows count as `resumed`, and a superseded row contributes
  to `skipped` without adding a new customer-visible reason outside the approved
  response contract.
- Per-project atomicity still applies to every row eligible at that mutation
  boundary, with one snapshot write per affected project and partial success
  across projects. Claim release and the prior persistence-failure rollback
  protections are unchanged.

No open implementation concern remains. Independent re-review is still required
before Task 5. Immediately after implementation commit `107e650a`, the worktree
was clean and the process audit found no surviving focused backend-test or
`tsx --test` process for this worktree.
