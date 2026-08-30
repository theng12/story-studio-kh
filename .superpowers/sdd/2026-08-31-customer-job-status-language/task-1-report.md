# Customer Job Status Language v1.4.88 — Task 1 Evidence

## Result

Implemented the approved customer-facing Jobs copy change and release metadata for v1.4.88. The normal Jobs interface now describes terminal work as needing attention and the next action as needing another try. Internal states, filtering keys, triage behavior, retry/repair safeguards, settlement evidence, and the collapsed **Technical details** diagnostic content remain unchanged.

## TDD evidence

Baseline focused command:

```sh
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/jobsControls.test.ts \
  __tests__/repairTriage.test.ts \
  __tests__/useJobs.test.ts
```

Baseline: 53 tests passed.

After adding the focused copy detector and before changing production literals, the same command was RED: 54 tests ran, 51 passed, and 3 failed only for legacy customer copy (`Error`, `whose repair failed`, and `Nothing failed that can be retried.`). There were no syntax, import, or state-machine failures.

After the literal-only implementation, the focused command was GREEN: 54 tests passed in 3 suites. The complete frontend lane was then GREEN: 1,261 tests passed in 173 suites, with 136/136 discovered files completing. The complete frontend lane was rerun after the final residual-copy cleanup and remained green.

The focused detector positively checks the new badge/filter/metric/batch/disclosure/retry language and negatively checks the exact legacy phrases. It also pins that `job.status === 'error'`, `statusFilter.value = 'error'`, and the **Technical details** label remain present.

## Production scope and preservation

- `StatusBadge` maps the existing `error` status key to `Needs attention`.
- Jobs-page metrics, filters, batch UI, repair/retry help and completion notices use the approved copy matrix, including singular/plural wording.
- Per-job and pipeline terminal notices retain their existing error/info delivery channels while using attention wording.
- Retry-all triage changes only returned prose; its input/output shapes, three safety piles, and retry decision branches were not changed.
- Raw provider/backend diagnostics and the complete Technical-details ledger remain available unchanged. Internal `error`/`failed` statuses, CSS classes, route/filter keys, dynamic diagnostic output, comments/logs, action-failure messages, and Technical-details item counts were deliberately preserved.

One adjacent internal comment was reworded from `Repair all failed` to `bulk repair` because the required source-level detector deliberately rejects that exact legacy customer phrase anywhere in its scanned source set. This has no runtime effect.

## Bounded source audit

Ran the approved exact residual search across the five production targets for all specified legacy customer phrases. It returned no matches (ripgrep exit 1 with empty output, the expected no-match result).

Reviewed the remaining broad `error`/`failed` matches. They are internal state keys/types/classes, retry/repair safety logic, action-failure text, comments/logging, dynamic backend diagnostics, or item progress inside **Technical details**. A successful no-op Retry-all notice that still said `every failed job` was also changed to `every job needing attention`; it does not alter retry behavior.

## Release integrity and verification

- `package.json`, both root lockfile version surfaces, and the newest changelog entry all report `1.4.88`.
- `npm run check:changelog`: passed.
- `npm run verify`: passed (lint with 0 errors; Electron/frontend typechecks; full backend, frontend, release, and content-pack lanes; changelog, typography, security, model-drift, and release checks; production frontend generation; Electron production build). The frontend lane reported 1,261 passing tests; release reported 36 passing tests; content packs reported 185 passing tests and 2 intentional skips.
- `git diff --check`: passed with no whitespace errors.

No development server was started and no customer data was mutated. The coordinator owns the requested live wide/narrow visual QA and screenshots, so this task does not claim them.

## Impeccable detector

Ran the required detector on the changed UI targets:

```sh
node /build/.codex/skills/impeccable/scripts/detect.mjs --json \
  'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/components/StatusBadge.vue
```

It returned 11 `side-tab` warnings in pre-existing Jobs-page CSS (`border-left` accents, lines 2815–3262) and no copy-related finding. Those styles are outside this literal-only, behavior-preserving copy task and were intentionally not changed.

## Deferred review

No independent subagent review was run because the task explicitly prohibited subagents. A coordinator/reviewer should perform the deferred visual QA and final independent review before merge.

## Round 1 review correction

An independent review correctly identified that a developer comment had been changed only to satisfy an overly broad source detector. The original comment at `frontend/pages/projects/[slug]/jobs.vue:1514` has been restored exactly. The detector's legacy pattern is now `/>Repair all failed/`, which targets rendered button markup and permits developer commentary as required.

Commands and results after this correction:

```sh
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/jobsControls.test.ts \
  __tests__/repairTriage.test.ts \
  __tests__/useJobs.test.ts
```

Result: passed — 54 tests, 3 suites, 0 failures.

```sh
git diff --check
```

Result: passed — no whitespace errors.

```sh
rg -n "understand failures|>Review failures|>Repair all failed|<span class=\"error-label\">Error:|Show full error|Hide full error|Nothing failed that can be retried|Deletes this failed job|any that were refused say so on their card|error: 'Error'|label: 'Failed'" \
  'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/components/StatusBadge.vue \
  frontend/composables/useJobs.ts \
  frontend/composables/useBatchCompletionSignals.ts \
  frontend/utils/repair-triage.ts
```

Result: no matches (ripgrep exit 1 with empty output, expected for this audit).
