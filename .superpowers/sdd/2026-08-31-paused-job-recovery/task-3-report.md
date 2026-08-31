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

## Independent-review correction

Commit `52cf1f721e47676c3170bc305129eb2cf687ffc1`
(`fix: harden stalled render recovery evidence`) resolves both findings in
`task-3-review.md`. This appendix supersedes the earlier repeated-trigger and
test-executor evidence above where the independent review found those fixtures
non-discriminating.

### Review-fix TDD evidence

The P1 regression began with a persisted `paused/stall` Continuity Render whose
provider task moved from `accepted` to `succeeded`, but whose durable
`local_execution_complete` fact was explicitly `false`. The focused RED was:

```text
node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume
12 passed, 2 failed of 14
```

The intended failure was `true !== false`: persisted load manufactured the
missing cooperative boundary and admitted the executor. The second failure was
a cascading assertion from that leaked asynchronous execution. After the
minimal loader guard, the same regression remained `paused/stall`, retained
`local_execution_complete: false`, reconciled the one original task to terminal,
called the executor zero times, and made zero generation POSTs.

The corrected matrix then added the missing positive and discriminating paths:

- A real production Continuity Render first created the scene manifest and
  provider task. Recovery reused the same Story job ID, exact provider task ID,
  exact request idempotency key, scene ID, manifest entry, and output path.
  Submission count stayed **1 → 1** and recovery made zero generation POSTs.
- A real production Continuity Render with
  `SITE_PLACEMENT_EXHAUSTED`, `reserved=7`, `settled=0`, and `released=7`
  entered the ordinary lane. The production executor's allow-list created the
  one permitted derived task/request identity. Submission count was **1 → 2**,
  exactly one new generation POST occurred, and an assertion at the fetch
  boundary proved that POST occurred only after normal executor admission.
  The original task and request identities remain retained in the Story job;
  the manifest alone advances to the new task/key used for the missing scene.
- Two direct calls to the evidence-gated recovery action while the same durable
  terminal job was eligible produced one executor run, one durable Story job,
  submission count **1 → 1**, and zero generation POSTs. The production action
  still has only its two authoritative call sites: persisted load and completed
  reconciliation; the direct export is test-only.
- Manual and legacy originless records were exercised while the global queue
  was running and remained paused. An otherwise unsafe queue-origin record was
  independently released through the Task 2 queue invariant and executed once,
  proving those origins did not pass through the stall predicate.
- A fully released historical fleet refusal is nonblocking only for Continuity
  Render and only under the same exact fleet-code, numeric zero-settlement, and
  full-release predicate used by admission. Unknown, content-refused, charged,
  partially released, cancelled, placeholder, and non-image evidence remain
  terminally unsafe.

Final fresh GREEN after commit `52cf1f72`:

```text
node scripts/testing/run-backend-tests.mjs \
  --only job-queue-genstudio-resume --only job-cancellation-reconciliation
41 passed, 0 failed; 3 suites; 2/2 selected files completed
configured projects root byte-identical: true

node scripts/testing/run-backend-tests.mjs \
  --only job-queue.test --only job-queue-persistence-retention
55 passed, 0 failed; 15 suites; 2/2 selected files completed
configured projects root byte-identical: true

npm run typecheck:electron
exit 0

git diff --check a2fa307d..HEAD
exit 0
```

Both backend commands are focused partial runs, not the release gate. No
version, changelog, later-task, customer-data, provider-control, package, push,
merge, or other-worktree change was made. The final status/process audit was
clean: no uncommitted Task 3 file remained after the report commit, and no
focused backend-test or `tsx` test process survived. No implementation concern
remains; independent re-review is still required before Task 4.
