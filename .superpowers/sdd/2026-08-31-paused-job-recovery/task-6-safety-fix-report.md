# Task 6 final-review safety fix report

## Scope and implementation commit

Fixed only the three findings in `task-6-final-review.md` in implementation
commit `6a010a987db9c8501f994049e17ce934d733b1ef`
(`fix: harden automatic stall recovery`). The implementation commit changes:

- `electron/server/services/job-queue.ts`
- `electron/server/__tests__/job-queue-genstudio-resume.test.ts`
- `electron/server/__tests__/job-cancellation-reconciliation.test.ts`

No UI, version, changelog, dependency, schema, compatibility layer, customer
data, provider route, replacement job, timer, packaging, push, merge, or other
worktree was touched. The recovery controller still performs no provider call
and invokes no executor inline.

## RED evidence

The first production-executor and lane-composition RED was:

```text
node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume
16 passed, 6 failed of 22; 1/1 selected file completed
configured projects root byte-identical: true
```

The intended failures were five unsafe Continuity records (missing, corrupt,
wrong-file, wrong-task, and wrong-request manifest ownership) being admitted,
plus a same-project queue/stall lane being pumped twice. The unsafe cases
either completed or errored instead of remaining paused; the mixed lane
reported two pumps instead of one.

The generic-finalizer RED was:

```text
node scripts/testing/run-backend-tests.mjs --only job-cancellation-reconciliation
25 passed, 1 failed of 26; 1/1 selected file completed
configured projects root byte-identical: true
```

A fully released `SITE_CAPACITY_UNAVAILABLE` Continuity failure incorrectly
finished Done and invoked the output auditor instead of retaining provider
failure classification as Error.

After restoring the generic finalizer, the positive executor-owned retry
exposed its own stale execution-boundary defect. A direct assertion at the
production image POST failed because `local_execution_complete` was `true`
instead of `false`; that focused run was **21 passed, 1 failed of 22**. A later
missing recorded request-identity case was also proved independently at RED:
**22 passed, 1 failed of 23**, with the job finishing Done instead of staying
Paused.

All RED runs were focused partial runs, not the release gate.

## GREEN and submission evidence

Final Task 3 safety GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only job-queue-genstudio-resume --only job-cancellation-reconciliation
49 passed, 0 failed; 3 suites; 2/2 selected files completed
configured projects root byte-identical: true
```

- Each missing, corrupt, wrong-file, wrong-task, wrong-request, and
  missing-request ownership case retains the exact durable job ID and provider
  task evidence, remains `paused/stall`, starts zero executors, retains the one
  original provider submission, and makes zero recovery image-generation
  POSTs.
- A healthy succeeded manifest starts the actual production Continuity
  executor once, reclaims the original task into the exact expected scene file,
  retains one total provider submission, and makes zero recovery POSTs.
- A fully released `SITE_PLACEMENT_EXHAUSTED` failure starts that executor once
  and makes exactly one executor-owned image-generation POST: two total
  submissions including the original failed task. The replacement task and
  idempotency key are both derived fresh while the original durable evidence
  remains unchanged.
- Two genuinely eligible direct triggers execute one durable job once. An
  accepted task is reconciled to terminal before admission and then reclaimed
  with zero new POSTs. Unknown/unreachable evidence and an unproven local
  boundary remain paused.
- One load containing queue-origin and stall-origin jobs in the same project
  and Continuity lane records one lane pump and executes each original durable
  job ID once. Reconciliation completion retains its independent pump path.
- The generic finalizer again classifies a fully released failed provider task
  as Error and does not call the success auditor.

Required adjacent GREEN:

```text
node scripts/testing/run-backend-tests.mjs \
  --only job-queue.test --only job-queue-persistence-retention
55 passed, 0 failed; 15 suites; 2/2 selected files completed
configured projects root byte-identical: true

node scripts/testing/run-backend-tests.mjs \
  --only jobs-resume-paused-routes --only jobs-route-order
12 passed, 0 failed; 4 suites; 2/2 selected files completed
configured projects root byte-identical: true

npm run typecheck:electron
exit 0

npx eslint electron/server/services/job-queue.ts \
  electron/server/__tests__/job-queue-genstudio-resume.test.ts \
  electron/server/__tests__/job-cancellation-reconciliation.test.ts --quiet
exit 0

git diff --check
exit 0
```

These backend commands are focused Task 2/3/4 partial suites. Per assignment,
the interrupted whole-branch release verifier was not rerun here.

## Minimal implementation and self-review

- Automatic Continuity stall admission now uses the existing task manifest,
  GenStudio recovery checkpoint, recorded request preview, and image validator.
  Every missing target filename must have one matching manifest task and
  idempotency key, one matching checkpoint asset, and one matching provider
  evidence record with the same idempotency key. Any absent, corrupt,
  ambiguous, or mismatched evidence fails closed.
- Persisted project loading collects queue-origin and safe stall-origin release
  lanes, unions them, and pumps each lane once. The existing stall helper still
  pumps by default for independent reconciliation completion.
- The generic cancellation finalizer again treats every non-cancelled failed
  provider task as failure and requires every provider task to succeed before
  output audit. The fleet predicate remains only in stall eligibility and the
  existing Continuity executor-owned retry policy.
- Normal executor admission clears the prior local completion boundary before
  execution. This prevents asynchronous provider recording from terminalizing
  a newly re-admitted run against stale completion state.
- No new schema, persistence format, provider operation, executor, retry
  controller, service, dependency, or compatibility branch was introduced.

Diff self-review found no High/Critical issue and `git diff --check` was clean.
No implementation concern remains. Independent final re-review and the full
release gate remain with the primary task owner.

The final worktree audit before the report checkpoint showed an empty
`git status --short`. The process audit found no surviving backend-test,
`tsx --test`, typecheck, or executor process whose command referenced this
worktree. Unrelated processes in other named worktrees were left untouched.
