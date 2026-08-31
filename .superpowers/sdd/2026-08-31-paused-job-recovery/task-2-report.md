# Task 2 report — queue-origin paused-job recovery

## Status

Implemented and committed the Task 2 queue-origin recovery invariant in
`6df6f88a8148d619ba96eea5a2c6e5b47dfd374e` (`fix: recover queue-origin paused jobs invariantly`).

Only these Task 2 implementation files changed in that commit:

- `electron/server/services/job-queue.ts`
- `electron/server/__tests__/job-queue.test.ts`
- `electron/server/__tests__/job-queue-persistence-retention.test.ts`

No version, changelog, route, frontend, dependency, customer data, provider call,
packaging, push, merge, or other worktree was touched.

## TDD evidence

Focused command throughout:

```bash
node scripts/testing/run-backend-tests.mjs \
  --only job-queue.test --only job-queue-persistence-retention
```

- Baseline: **45 passed, 0 failed**; 2/2 selected files completed.
- First RED: **47 passed, 5 failed** of 52. The five intended failures were:
  false-state persisted load remained paused; Resume-before-load stranded the
  record; the second initialization caller observed the default before the
  durable read settled; false-state Resume remained transition-gated; and
  repeated false-state reconciliation did not place the held job in its lane.
- Narrow GREEN implementation exposed a second measurable RED: **51 passed,
  1 failed** of 52 because false-state load wrote two project snapshots instead
  of the required one.
- Primary GREEN after assigning queue-origin load mutation solely to the batch:
  **52 passed, 0 failed**.
- Final GREEN after the rollback regression and stall-origin preservation
  assertion: **53 passed, 0 failed**, 15 suites, 2/2 selected files completed,
  configured projects root byte-identical.
- Final `npm run typecheck:electron`: **passed**. The first typecheck correctly
  caught one missing test-only `Job` type import; that import was added and the
  command was rerun to exit 0.
- Final `git diff --check`: **passed**.

The load/Resume and initialization races use controllable deferred promises and
blocked reads. No sleep or wall-clock delay is used as race proof.

## Source decisions

- Queue pause initialization now uses one shared promise. The loaded flag is set
  only after the durable read resolves; concurrent callers await the same read.
- `setQueuePaused()` first awaits initialization, so no caller can act on the
  default `false` while a durable `true` is unresolved.
- Persisted project loading also awaits initialization, then performs the same
  queue-origin reconciliation after every completed project load.
- Every `setQueuePaused(false)` reconciles loaded queue-origin holds, even if the
  in-memory setting was already false. The old `true -> false` gate is gone.
- One narrow internal project-batched paused-to-queued transition owns field
  mutation, one atomic project snapshot, rollback, pending-lane insertion,
  update emission, and affected-lane collection. Task 4 can extend this seam;
  Task 2 call sites select queue-origin records only.
- Mutation is persisted before lane insertion or SSE emission. A failed project
  snapshot restores every in-memory field and pause-request membership and
  admits nothing from that project.
- Successful records enter lanes in the original candidate order. Pending
  insertion checks durable job ID, preventing duplicate ownership under repeated
  false-state reconciliation.
- Global Resume still pumps every lane once so ordinary queued work held by the
  global setting starts too. Project-load recovery pumps only affected lanes.
- Durable global `true` queue-origin records remain paused and untouched.
  Manual, stall, and originless pauses retain their prior load behavior and are
  never selected by global Resume.

## Diff self-review

- **Resume-before-load:** Resume finds no loaded record; load completes under
  authoritative false and releases the queue-origin record once.
- **Load-before-Resume:** load either releases under false or preserves under
  true; the following Resume releases every loaded queue-origin record even when
  its requested value is already false.
- **Initialization race:** a blocked durable-true read keeps both callers
  pending and performs exactly one settings read.
- **Persistence rollback:** forced atomic rename failure leaves the project
  paused in memory and on disk and inserts no pending record.
- **Deduplication/FIFO:** two concurrent false-state calls produce one project
  snapshot, one pending copy, FIFO positions 1 then 2, and one executor call.
- **Origin safety:** durable true, manual, stall, and legacy originless holds are
  preserved; queue release changes no job ID and does not create a replacement.
- **Provider/billing boundary:** the transition only performs normal lane
  admission. It calls no executor inline and no provider or reconciliation API.

No additional production abstraction, dependency, migration, retry loop, timer,
or persistence system was introduced.

## Clean/process status and concerns

- Immediately after implementation commit `6df6f88a`, `git status --short` was
  empty and no matching backend test/tsx process remained.
- The focused runner consistently exits successfully with 53/53, but after the
  summary work has already settled it can print an existing late `ENOENT` atomic
  rename warning from the unrelated final `JQ No Chat Retry Scope` fixture. Its
  helper observes terminal in-memory state before that fixture's last persistence
  finishes, then test-directory cleanup wins the race. Task 2 tests themselves
  drain their controlled executors; no process remains. Fixing that unrelated
  fixture was deliberately kept out of this commit.
- Per assignment, no sub-agent was used. Independent review remains for the
  primary reviewer before Task 3; this report records the required diff
  self-review only.
- Full backend/release verification, version/changelog work, integration, and
  packaging remain later plan tasks and were not run here.

## Independent-review correction

The two valid findings recorded in `task-2-review.md` were corrected in
`15c86f6b938e130cdc11ecbe0d32a383f61ce78a` (`fix: honor superseding paused job intent`).

### Follow-up TDD evidence

- Controlled-persistence RED: **40 passed, 2 failed** of 42 in
  `job-queue.test.ts`. Both failures were the intended stale-admission proof:
  after a manual pause or cancellation superseded queue release while its
  project snapshot was blocked, a same-lane marker received queue position 2
  instead of the required position 1.
- The two-record same-project/same-lane FIFO and the two-record rollback tests
  already passed at RED, confirming the existing batch grouping while the two
  superseding-intent races remained exposed.
- Direct-file GREEN after the minimal source change: **42 passed, 0 failed**.
- Final focused command
  `node scripts/testing/run-backend-tests.mjs --only job-queue.test --only job-queue-persistence-retention`:
  **55 passed, 0 failed**, 15 suites, 2/2 selected files completed, configured
  projects root byte-identical.
- Final `npm run typecheck:electron`: **passed** (exit 0).
- Final `git diff --check`: **passed**.

All new race tests use deferred promises and a blocked atomic rename. No sleep
or wall-clock delay is used to establish ordering.

### Follow-up source and test decisions

- After project persistence and before pending insertion or SSE emission, each
  durable candidate is revalidated as still `queued`, originless, and free of
  both job-local and tracked pause requests. A later manual pause or
  cancellation therefore owns the row and is not admitted by the stale batch.
- Revalidation remains inside the existing project batch. It adds no project
  write, per-record serialization, provider call, timer, retry, or new
  persistence abstraction.
- Two queue-origin records in one project and lane now prove FIFO order, exactly
  one project snapshot, exactly one affected-lane pump, one pending copy per job
  ID, and one executor call per record.
- A forced project snapshot failure now proves all-or-none rollback for two
  records in memory and on disk before either can be admitted.
- A narrow test-only pump observer follows the existing exported test-hook
  convention and restores the prior observer after the assertion.

### Follow-up diff self-review and final state

- Manual pause during the persistence await leaves the record paused with
  `pause_origin: 'manual'`; cancellation leaves it cancelled. Neither record is
  inserted or executed, and a following marker owns queue position 1.
- Job IDs, original candidate order, pending-ID deduplication, durable global
  true behavior, manual/stall/originless holds, rollback, and project-level
  write batching remain unchanged.
- The implementation changes only the final admission ownership check plus the
  test-only pump observer; no Task 3/4 behavior, version, or changelog changed.
- Four stale direct-test process trees left by earlier diagnostic runs were
  terminated by exact PID after they stopped advancing. The final process audit
  found no matching backend-test or job-queue process.
- Remaining scope concern: the plan assigns full backend/release verification,
  version/changelog, integration, and packaging to later tasks; none was added
  to this focused Task 2 correction.
