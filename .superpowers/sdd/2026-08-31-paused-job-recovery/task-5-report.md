# Task 5 report — Paused filtering and immediate Resume feedback

## Status and commit

Implemented Task 5 in `c7c388d08f98ccef2b2d8b114a5a0a60f76c8cad`
(`feat: filter and resume paused jobs`). The implementation commit changes
only:

- `frontend/__tests__/jobsControls.test.ts`
- `frontend/pages/projects/[slug]/jobs.vue`

No server route, queue, persistence, provider, dependency, version, changelog,
packaging artifact, customer job data, unrelated worktree, push, or merge was
touched.

## RED evidence

The initial Task 5 client contract run:

```text
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/jobsControls.test.ts
28 passed, 2 failed of 30
```

The two intended failures named the absent `typeScopedJobs` collection and
absent bulk paused-work action/busy behavior.

The narrow-layout follow-up began:

```text
30 passed, 1 failed of 31
```

The intended failure named the missing small-screen filter/action wrapping
rule.

## GREEN and verification evidence

Focused frontend verification:

```text
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/useNetworkStatus.test.ts __tests__/jobsControls.test.ts
39 passed, 0 failed; 1 suite
```

Full frontend lane:

```text
npm run test:frontend
1268 passed, 0 failed; 173 suites
frontend suite coverage: 136/136 file(s) completed, 1441 marks
```

Additional fresh checks:

```text
npm --prefix frontend run typecheck
exit 0

npx eslint 'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/__tests__/jobsControls.test.ts --quiet
exit 0

git diff --check
exit 0
```

## Implementation and self-review

- Paused is a native status chip. Its count, filtered rows, and paused bulk
  candidate count use `typeScopedJobs`, which first applies Project Jobs/All
  Jobs project scope and then the active job-type tab.
- Bulk Resume appears only in All or Paused status views when that scoped
  candidate count is nonzero. It sends only server-owned scope: the project
  route for Project Jobs, the universal route for All Jobs, and optional
  universal `project_slug`/`type` fields. It never sends row IDs.
- Row Resume joins the existing immutable per-row busy set before its POST;
  the button is disabled and reads `Rejoining…`. Bulk Resume takes a count
  snapshot, synchronously sets its own busy flag, disables itself, and reads
  `Rejoining N jobs…`. Both guards reject repeated invocation.
- Neither flow invents a queued row status. The bulk success toast consumes
  only aggregate `resumed`/`skipped` facts; normal SSE/server refresh remains
  the row projection authority.
- Existing status-chip selection continues to clear the failure-batch filter,
  including Paused. Existing queue Resume, repair/retry, disclosures,
  redaction, sorting, pagination, and job controls remain in place.
- The narrow breakpoint gives status filters their own wrapping row and lets
  native action buttons wrap rather than force horizontal overflow. Existing
  button focus/disabled behavior is reused.

## Impeccable detector and remaining work

The required detector was run once against the changed Jobs page. It reported
only pre-existing `side-tab` warnings for existing colored card borders, none
in the Task 5 diff. They are deliberately preserved: changing them would be
an unrelated Jobs redesign and conflicts with this task's surgical boundary.

Rendered desktop/narrow QA and independent code/UX review remain assigned to
the next review step. No Resume control was clicked against customer records.

## Review correction — narrow sort reachability

Independent Task 5 review and rendered QA rejected the prior revision with one
P1: the existing non-wrapping sort bar had a 611 px scroll width inside a 350 px
container at the required 390 px All Jobs viewport, so later sort buttons were
clipped and unreachable. The review found no other Task 5 issue.

### RED evidence

After adding the narrow sort-layout assertion:

```text
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/jobsControls.test.ts
31 passed, 1 failed of 32
```

The intended failure named the missing narrow `.sort-bar` wrapping rule.

### Correction and GREEN evidence

Implementation commit: `502750bc67cc94fcffc15f64907cf071450a3267`
(`fix: wrap Jobs sort controls on narrow screens`).

At the existing 760 px breakpoint, `.sort-bar` now wraps with a zero minimum
width and the `Sort by` label takes a full row. The existing full-width project
filter/select rule therefore remains first in All Jobs, followed by a readable
sort label and wrapping native sort buttons. Desktop layout is unchanged.

```text
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/useNetworkStatus.test.ts __tests__/jobsControls.test.ts
40 passed, 0 failed; 1 suite

npm run test:frontend
1269 passed, 0 failed; 173 suites
frontend suite coverage: 136/136 file(s) completed, 1442 marks

npm --prefix frontend run typecheck
exit 0

npx eslint 'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/__tests__/jobsControls.test.ts --quiet
exit 0

git diff --check
exit 0
```

The Impeccable detector was intentionally not rerun: it already completed for
Task 5, and this correction only fixes the reviewer-identified responsive
layout rule without introducing a new visual pattern. No customer job data or
state-changing control was touched.
