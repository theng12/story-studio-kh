# Task 3 report — evidence-gated stall recovery

## Status and scope

Implemented Task 3 only in commit
`5078deaed1aab428a81ac1c977efbdf483a850ed`
(`fix: safely recover stalled scene renders`). The implementation changes only:

- `electron/server/services/job-queue.ts`
- `electron/server/__tests__/job-queue-genstudio-resume.test.ts`

No version, changelog, route, frontend, dependency, customer data, provider
control call, replacement Story job, packaging, push, merge, or other worktree
was touched.

## TDD evidence

Baseline:

```text
node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume
8 passed, 0 failed; 1/1 selected file completed
```

RED after adding the stall safety matrix:

```text
node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume
11 passed, 2 failed of 13
```

The two intended failures were the safe cases: already-terminal stall evidence
remained paused, and accepted evidence remained paused after authoritative
reconciliation became terminal. Unreachable, unstable-identity,
cancellation-context, unsafe-settlement, manual-origin, and queue-origin
fixtures stayed protected at RED.

Final focused GREEN after the dedupe/manifest-reclaim assertion:

```text
node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume
13 passed, 0 failed; 3 suites; 1/1 selected file completed
configured projects root byte-identical: true
```

Final required adjacent GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only job-queue-genstudio-resume --only job-cancellation-reconciliation
38 passed, 0 failed; 3 suites; 2/2 selected files completed
configured projects root byte-identical: true
```

Additional checks:

```text
npm run typecheck:electron
exit 0

git diff --check
exit 0
```

These are correctly reported as focused partial runs, not the release gate.

## Billing and identity evidence

- Already-terminal fixture: mock image submissions were **1 before load and 1
  after completion**. Recovery made zero POSTs. The executor read the stable
  scene manifest, used the original provider task ID, and performed one GET
  against that exact ID.
- Accepted-then-terminal fixture: mock image submissions were **1 before
  reconciliation and 1 after completion**. Three concurrent load/recovery
  triggers produced one reconciliation GET, one executor manifest-reclaim GET,
  one durable Story job execution, and zero POSTs.
- Unreachable fixture: mock image submissions were **1 before the failed status
  read and 1 afterward**. The record remained `paused/stall`, kept its
  reconciliation reason, admitted no executor, and made zero POSTs.
- Unsafe/local-boundary/cancellation/manual/queue/originless fixtures use no
  provider submission. Their executor count stayed zero.
- Every safe fixture retained the original Story `job_id`, provider task ID,
  stable scene ID, output directory, and `.task-manifest.json` entry. No
  replacement job or request identity is created by the controller.

## Implementation and self-review

- One internal action, `recoverSafelySettledStallJobs`, has exactly two call
  sites: persisted-project load and completed authoritative reconciliation.
- The gate requires `paused/stall`, the global queue running, Continuity Render,
  a registered executor, the completed cooperative local boundary, stable
  output identity, no current pause/cancel intent, no cancellation context,
  durable non-placeholder task IDs, and terminal provider evidence.
- Succeeded entries are reclaimable. Failed entries pass only the existing
  fleet-capacity code set with complete zero-settlement/full-release evidence;
  charged, partially released, unpublished settlement, content refusal,
  cancellation, pending, unknown, and mixed unsafe evidence fail closed.
- The controller delegates mutation, atomic persistence, pending-ID
  deduplication, and stale-intent revalidation to the Task 2 batched transition.
  It calls neither a provider nor an executor. Successful records enter the
  existing lane and execute only through normal `pump()` admission.
- Manual, queue, and originless records are not selected by the stall action.
  Task 2's separate queue-origin invariant remains unchanged.

No High/Critical self-review finding remains. Independent billing/recovery
review is still required by the primary task owner before Task 4. Full backend
and release verification remain assigned to later plan tasks.

## Clean and process status

Immediately after implementation commit `5078deae`, `git status --short` was
empty. The process audit found no surviving `run-backend-tests` or focused
`tsx` test process; only the audit shell and its own `rg` command appeared.
