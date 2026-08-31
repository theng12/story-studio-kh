# Paused Job Recovery v1.4.90 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task with a fresh implementer and an independent reviewer for each task. Do not run parallel implementers against this shared worktree. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before any completion claim.

**Goal:** Ship Story Studio KH v1.4.90 with informational-only health monitoring, invariant-safe queue/stall recovery, and a fast, scoped one-click Resume for paused jobs.

**Architecture:** Keep the existing durable job queue as the only state owner. Add small origin-aware recovery predicates and one internal batched paused-to-queued transition in `job-queue.ts`; expose two scope-validating routes; reuse the shared Jobs page and filter utility for Paused filtering and busy feedback. Provider work remains owned by existing executors and reconciliation. No new dependency, service, replacement job, or persistence format is introduced.

**Tech Stack:** Node/Express, TypeScript, Vue 3/Nuxt 4, SSE, atomic JSON storage, `node:test`/`tsx`, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-08-31-paused-job-recovery-design.md`

## Starting Evidence

- Required branch: `fix/paused-job-recovery-v1490`
- Required base: `d5a3d87aa97962a755ba2779886afd644ad72752`
- Baseline version: `1.4.89`
- Focused backend baseline: 9/9 files, 79 tests, 22 suites, 0 failures:

```bash
node scripts/testing/run-backend-tests.mjs \
  --only job-queue --only jobs-stream --only jobs-route-order
```

- Focused frontend baseline: 33 tests, 1 suite, 0 failures:

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/useNetworkStatus.test.ts \
  __tests__/jobsControls.test.ts
cd ..
```

These are partial TDD baselines, not release gates. The release gate is `npm run verify`.

## Global Constraints

- Re-read repository `AGENTS.md`, this spec, diagnostics, and current branch status before implementation. Preserve unrelated work.
- Use Graphify's existing graph first for impact/caller checks; verify every material edge in source.
- Apply Ponytail full mode: delete the health-to-queue coupling, reuse `persistProjectSnapshot`, existing reconciliation, executors, SSE, filters, and busy sets; add no speculative abstraction or dependency.
- Do not read or mutate customer `jobs.json` in tests. Use the existing isolated test harness and temporary project roots.
- Keep `manual` and unknown-origin pauses manual. Keep global queue controls owner-controlled.
- No provider call may originate in health, bulk routes, or the recovery transition. No replacement Story job may be created.
- Every behavior task is sequential: RED test, verify intended failure, minimal implementation, focused GREEN, independent review, then the next task.
- Do not version until all behavior tasks are green and independently reviewed.
- Do not push/PR/merge/package until `npm run verify`, rendered QA, and final review are clean.
- Build the DMG only from synchronized `main` after merge, into the normal main-root `dist/` folder.

## File Map

| File | Responsibility |
|---|---|
| `frontend/composables/useNetworkStatus.ts` | Local engine reachability only; remove queue mutation and queue-sync state. |
| `frontend/layouts/dashboard.vue` | Remove the obsolete queue-sync warning class/consumer while preserving online/offline status. |
| `frontend/__tests__/useNetworkStatus.test.ts` | Prove all health outcomes issue zero queue-control POSTs. |
| `electron/server/services/job-queue.ts` | Single-flight queue-setting load, origin-aware boot/race recovery, stall gate, batched paused transition, one write/project and one pump/lane. |
| `electron/server/models/types.ts` | Reuse existing pause origin; change only if a narrow internal bulk result type truly belongs here. No new persisted recovery schema. |
| `electron/server/routes/jobs.ts` | Project and universal scoped bulk Resume routes and validation. |
| `electron/server/__tests__/job-queue.test.ts` | Existing pause semantics and idempotent queue-origin release. |
| `electron/server/__tests__/job-queue-persistence-retention.test.ts` | Boot/race/manual-pause persistence invariants and write-count coverage. |
| `electron/server/__tests__/job-queue-genstudio-resume.test.ts` | Stall recovery only after safe reconciliation, same identity, no unsafe resubmit. |
| `electron/server/__tests__/jobs-route-order.test.ts` | Static order guard for literal bulk routes before `:jobId`. |
| `electron/server/__tests__/jobs-stream.test.ts` | Existing SSE projection remains intact. |
| `electron/server/__tests__/jobs-resume-paused-routes.test.ts` | New route-level scope, validation, counts, and project isolation coverage. |
| `frontend/utils/job-presentation.ts` | Reuse exact filtering; only add a tiny pure paused-scope helper if tests prove duplicated expressions are otherwise unavoidable. |
| `frontend/pages/projects/[slug]/jobs.vue` | Paused chip/count, scoped bulk action, row/bulk busy feedback, request routing, responsive styles. |
| `frontend/__tests__/jobsControls.test.ts` | Shared Project/All Jobs source and pure-filter contract. |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | v1.4.90 release surfaces. |

---

### Task 1: Make local health monitoring informational only

**Files:**
- Modify: `frontend/__tests__/useNetworkStatus.test.ts`
- Modify: `frontend/composables/useNetworkStatus.ts`
- Modify: `frontend/layouts/dashboard.vue`

- [ ] **Step 1: Add the RED contract**

Rewrite the existing health tests so successful, failed, repeated-failed, and recovery probes all assert:

```ts
assert.equal(fetchCalls.filter(url => url.includes('/api/system/queue/')).length, 0)
```

Retain assertions for `online`, `lastChecked`, browser-event re-probing, and `navigator.onLine` not being authoritative. Add a source assertion that the composable contains neither `/system/queue/pause` nor `/system/queue/resume` and no longer exports `queueSyncFailed`.

- [ ] **Step 2: Run RED**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test __tests__/useNetworkStatus.test.ts
cd ..
```

Expected: failures identify the queue POSTs and obsolete queue-sync state, not a test-loader problem.

- [ ] **Step 3: Apply the smallest deletion**

Delete `syncQueueState`, `queueSyncFailed`, `lastSyncedPaused`, and the queue POST from `refresh()`. Keep one health GET, `online`, `lastChecked`, interval/event lifecycle, and `refresh`. Remove only `networkQueueSyncFailed` and its `queue-warn` class binding from the dashboard layout; preserve online/offline rendering and accessibility.

- [ ] **Step 4: Run GREEN and residual search**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test __tests__/useNetworkStatus.test.ts
cd ..
rg -n "queueSyncFailed|lastSyncedPaused|system/queue/(pause|resume)" \
  frontend/composables/useNetworkStatus.ts frontend/layouts/dashboard.vue frontend/__tests__/useNetworkStatus.test.ts
```

Expected: test green; residual search has no production coupling.

- [ ] **Step 5: Independent review**

Reviewer verifies health still updates the status UI and no queue mutation moved elsewhere. Fix findings and rerun the focused test before Task 2.

---

### Task 2: Make queue-origin release invariant across idempotent Resume, boot, and races

**Files:**
- Modify: `electron/server/__tests__/job-queue.test.ts`
- Modify: `electron/server/__tests__/job-queue-persistence-retention.test.ts`
- Modify: `electron/server/services/job-queue.ts`

- [ ] **Step 1: Add RED queue invariant tests**

Cover all of these with isolated temporary projects:

1. `setQueuePaused(false)` releases loaded queue-origin paused jobs even when the in-memory setting was already false.
2. A persisted queue-origin pause loads as queued when the durable global setting is false.
3. A persisted queue-origin pause remains paused when the durable setting is true.
4. A manual-origin and an originless paused record remain paused under both false-state load and global Resume.
5. Resume racing an in-flight project load cannot leave a queue-origin record paused.
6. Repeated false-state reconciliation queues one copy of the same job ID and invokes the executor once.
7. Concurrent callers of queue-state initialization await one durable read and never observe the default before it resolves.

Use a blocking test seam or the existing app-settings/store seam for the race. Do not use sleeps as proof when a controllable promise can establish order.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only job-queue.test --only job-queue-persistence-retention
```

Expected: new false-state load/idempotence/race assertions fail against transition-only recovery.

- [ ] **Step 3: Implement one invariant path**

In `job-queue.ts`:

- replace the early `queuePauseLoaded = true` race with a single shared initialization promise and mark loaded only after the setting is resolved;
- make persisted-job loading await that initialization before classifying paused records;
- extract one internal queue-origin release operation that acts only when `queuePaused === false`;
- call it after each project load and on every `setQueuePaused(false)`, regardless of `wasPaused`;
- retain the existing global-pause behavior and leave manual/stall/originless records untouched;
- deduplicate queue insertion by job ID and preserve FIFO among the records being released;
- batch project persistence and lane pumps as defined by the spec.

Do not add a migration or clear a durable `true` setting automatically.

- [ ] **Step 4: Run GREEN and existing pause regression**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only job-queue.test --only job-queue-persistence-retention
```

Expected: all selected files complete, including the unchanged “global Resume preserves manually paused jobs” test.

- [ ] **Step 5: Independent review**

Reviewer traces both interleavings (Resume-before-load and load-before-Resume), persistence rollback, duplicate queue ownership, and durable-true preservation. Address findings before Task 3.

---

### Task 3: Auto-recover stall-origin jobs only through authoritative safe reconciliation

**Files:**
- Modify: `electron/server/__tests__/job-queue-genstudio-resume.test.ts`
- Modify: `electron/server/services/job-queue.ts`

- [ ] **Step 1: Add RED safety matrix**

Use Continuity Render fixtures with stable scene IDs/manifests. Prove:

1. A paused stall-origin render with succeeded/reclaimable terminal evidence requeues as the same job ID and executes once.
2. A paused stall-origin render with unsettled accepted evidence remains paused until the mock GenStudio reconciliation reports terminal; only then may it requeue.
3. Reconciliation unreachable/unknown leaves it paused and calls no executor.
4. Unstable output identity, cancellation context, or unsafe/charged-unknown settlement leaves it paused.
5. Manual and queue origins with otherwise identical evidence do not take the stall path.
6. Repeated reconciliation completion cannot enqueue or execute the same durable job twice.
7. Recorded succeeded tasks are reclaimed by their original task IDs and no replacement provider submission occurs in the recovery controller.

The mock provider's submission count and the existing executor/manifest assertions are the evidence; do not infer safety only from final status.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume
```

Expected: safe stall fixtures remain paused on the baseline; unsafe fixtures remain protected.

- [ ] **Step 3: Add the narrow gate**

Add one internal predicate/action used by two call sites only: persisted paused-job load and successful reconciliation completion. Require `stall` origin, global queue running, registered executor, local safe boundary, stable output identity, no cancellation context, and no unresolved/unsafe provider settlement. Requeue the same object through the normal lane; do not call a provider or executor inline.

Let the existing executor reclaim succeeded task IDs and apply its exact failure/settlement retry allow-list. If the gate cannot prove safety, leave the record paused and preserve its evidence/reason.

- [ ] **Step 4: Run GREEN plus adjacent reconciliation tests**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only job-queue-genstudio-resume --only job-cancellation-reconciliation
```

Expected: new stall matrix and existing reconciliation coverage pass with zero duplicate submissions.

- [ ] **Step 5: Independent billing/recovery review**

Reviewer specifically checks for any path that can call a provider before normal `pump()`/executor admission, reuse an unsafe identity, retry unknown settlement, or override a manual pause. Resolve every High/Critical finding before Task 4.

---

### Task 4: Add server-side scoped bulk Resume with one write per project and one pump per lane

**Files:**
- Create: `electron/server/__tests__/jobs-resume-paused-routes.test.ts`
- Modify: `electron/server/__tests__/jobs-route-order.test.ts`
- Modify: `electron/server/services/job-queue.ts`
- Modify: `electron/server/routes/jobs.ts`

- [ ] **Step 1: Add RED service and route tests**

Test both route contracts and the queue service:

- project route affects only its route slug;
- universal all-project scope, concrete project filter, and `_app_` scope;
- optional exact type filter;
- invalid/unknown project and type reject before mutation;
- all pause origins are eligible because the button is an explicit user action;
- terminal/running/queued records are not selected;
- original job IDs, params, output paths, manifests, and provider evidence remain unchanged;
- one request/double invocation cannot duplicate pending ownership;
- one atomic snapshot write per affected project and one pump per affected lane;
- one project's forced persistence failure rolls back that project while successful projects remain resumed;
- response aggregate counts/reasons are accurate and customer-safe;
- literal `/resume-paused` routes register before `/:jobId` wildcards.

Prefer exported test seams/counters over timing assertions. If a new test-only seam is needed, keep it explicitly test-scoped and reset it after each case.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only jobs-resume-paused-routes --only jobs-route-order
```

Expected: missing routes/service fail; route-order test identifies literal placement requirement.

- [ ] **Step 3: Implement the shared batch transition**

Implement one queue-level `resumePausedJobs(scope)` operation. Group selected records by project, validate before mutation, persist one project snapshot, roll back a failed project, then enqueue/emit successful records. Collect affected lanes in a Set and pump each once after durable transitions. Reuse this helper for queue-origin multi-release without broadening explicit bulk scope.

Add the two routes exactly as specified. Validate `type` and optional universal `project_slug` against server-owned scopes. Return `202` aggregates without job IDs. Do not accept arbitrary client job-ID arrays.

- [ ] **Step 4: Run GREEN and the complete focused backend baseline**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only jobs-resume-paused-routes --only jobs-route-order
node scripts/testing/run-backend-tests.mjs \
  --only job-queue --only jobs-stream --only jobs-route-order --only jobs-resume-paused-routes
```

Expected: all selected files and tests complete; project data-root byte-identity guard remains true.

- [ ] **Step 5: Independent atomicity/API review**

Reviewer checks rollback, route authorization/scope, route order, no arbitrary IDs, aggregate redaction, one-write/one-pump instrumentation, and SSE consistency. Fix and rerun before Task 5.

---

### Task 5: Add deterministic Paused filtering and immediate row/bulk feedback

**Files:**
- Modify: `frontend/__tests__/jobsControls.test.ts`
- Modify: `frontend/utils/job-presentation.ts` only if a pure helper removes proven duplicate scope logic
- Modify: `frontend/pages/projects/[slug]/jobs.vue`

- [ ] **Step 1: Add RED client-scope and interaction assertions**

Add pure/filter and rendered/source contract tests for:

- a Paused status chip and count;
- counts narrowed by page/project plus active job-type tab;
- Project Jobs bulk route and All Jobs all-project/concrete-project/`_app_` payloads;
- no arbitrary job IDs in the request;
- action visible only for status All or Paused and count greater than zero;
- selecting Paused clears failure-batch scope;
- row `Rejoining…` disabled state begins before awaiting POST;
- bulk `Rejoining N jobs…` disabled state begins before awaiting POST;
- double click issues one request;
- success uses returned resumed/skipped counts; failure restores controls;
- existing SSE, filters, redaction, repair/retry, and global Resume controls stay intact.

Avoid a new component. The existing shared page is already the correct single implementation for both scopes.

- [ ] **Step 2: Run RED**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test __tests__/jobsControls.test.ts
cd ..
```

Expected: failures name missing Paused/bulk/busy behavior.

- [ ] **Step 3: Implement the minimal UI**

- Extend the status union/constant with `paused` and label `Paused`.
- Derive `typeScopedJobs` after page/project scope and use it for status counts, filtered rows, and paused candidate count.
- Show `Resume paused work (N)` only for All/Paused status and `N > 0`.
- Select the route/payload deterministically from page scope, universal project filter, and active type.
- Reuse the per-row busy Set for Resume and add one boolean/count snapshot for bulk busy state.
- Keep projected status server/SSE-owned; show immediate button feedback without inventing queued state.
- Add only the responsive CSS needed for stable wrapping and focus visibility.

- [ ] **Step 4: Run GREEN and complete frontend lane**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/useNetworkStatus.test.ts \
  __tests__/jobsControls.test.ts
cd ..
npm run test:frontend
```

Expected: focused and full frontend coverage-floor runs pass.

- [ ] **Step 5: Rendered responsive/accessibility QA**

Run the development app without altering customer job data:

```bash
npm run dev
```

Inspect Project Jobs and All Jobs with existing paused evidence at desktop width and approximately 390 px. Do not click Resume on customer records. Use browser devtools/state inspection or a nonpersistent test fixture to inspect busy styling.

Verify:

- Paused chip count matches the selected project and type;
- All/Paused visibility rule prevents hidden-row actions;
- row and bulk labels do not shift card geometry, clip, or overflow;
- status/actions wrap without horizontal page overflow;
- native buttons are tab-reachable, focus-visible, correctly named, and disabled while busy;
- project dropdown and type/status controls remain usable;
- Technical details and job-card action disclosures remain unaffected.

Capture one desktop and one narrow screenshot as review evidence. If no safe existing paused row is available, record the visual gap and use an isolated test fixture; never manufacture state in a customer project.

- [ ] **Step 6: Independent UX review**

Reviewer inspects screenshots and the page diff for responsive geometry, hidden-row scope, busy-state immediacy, accessibility, and accidental Jobs redesign. Fix before Task 6.

---

### Task 6: Version, fully verify, integrate, build the main-root DMG, and clean up

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Review the complete behavior diff before versioning**

```bash
git diff --check
git status --short
git diff --stat
git diff -- electron/server/services/job-queue.ts electron/server/routes/jobs.ts \
  frontend/composables/useNetworkStatus.ts frontend/layouts/dashboard.vue \
  'frontend/pages/projects/[slug]/jobs.vue'
```

Confirm the spec acceptance matrix, no dependency changes, no customer data, no replacement jobs, and no provider call from control code.

- [ ] **Step 2: Bump and document v1.4.90**

```bash
npm version 1.4.90 --no-git-tag-version
```

Add a newest-first `## v1.4.90 — 2026-08-31` entry explaining that automatic holds now recover safely, manual pauses stay manual, and Paused work can be filtered/rejoined in one click. Verify:

```bash
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
node -p "require('./package-lock.json').packages[''].version"
npm run check:changelog
```

Expected: all versions `1.4.90`; changelog check green.

- [ ] **Step 3: Run the full release gate**

```bash
npm run verify
```

Expected: lint, Electron/frontend typechecks, all four complete test lanes with coverage floors, changelog/typography/security/model-drift/release checks, frontend generation, and Electron build all pass. A filtered run is not a substitute.

- [ ] **Step 4: Final independent review**

Request code review against the design spec, acceptance matrix, complete diff, focused outputs, full verification output, and rendered screenshots. Resolve every issue and rerun affected checks plus `npm run verify` after material changes.

- [ ] **Step 5: Commit, push, PR, and merge under the standing integration rule**

```bash
git diff --check
git status --short
git add -- \
  electron/server/services/job-queue.ts \
  electron/server/routes/jobs.ts \
  electron/server/__tests__/job-queue.test.ts \
  electron/server/__tests__/job-queue-persistence-retention.test.ts \
  electron/server/__tests__/job-queue-genstudio-resume.test.ts \
  electron/server/__tests__/jobs-resume-paused-routes.test.ts \
  electron/server/__tests__/jobs-route-order.test.ts \
  frontend/composables/useNetworkStatus.ts \
  frontend/layouts/dashboard.vue \
  'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/utils/job-presentation.ts \
  frontend/__tests__/useNetworkStatus.test.ts \
  frontend/__tests__/jobsControls.test.ts \
  package.json package-lock.json CHANGELOG.md
git commit -m "fix: recover paused jobs safely"
git push -u origin fix/paused-job-recovery-v1490
paused_recovery_pr_url=$(gh pr create --base main --head fix/paused-job-recovery-v1490 \
  --title "fix: recover paused jobs safely" --fill)
gh pr checks "$paused_recovery_pr_url" --watch
gh pr view "$paused_recovery_pr_url" --json mergeable,reviewDecision,statusCheckRollup
gh pr merge "$paused_recovery_pr_url" --merge --delete-branch
```

Do not merge with unresolved checks, review, or mergeability. Never force-push. Do not publish, deploy, tag, upload, or install.

- [ ] **Step 6: Synchronize main and build the required DMG from the main root**

From `<owner-home>/Developer/story-studio-kh`:

```bash
git switch main
git pull --ff-only
git status --short --branch
npm run dist:smoke
```

Verify the artifact in the normal main-root `dist/` folder with the repository's artifact verifier and record its absolute path, size, and SHA-256. Do not build the final DMG from the feature worktree.

- [ ] **Step 7: Clean up only this completed feature workspace**

After merge, main sync, and DMG verification:

```bash
git -C <owner-home>/Developer/story-studio-kh worktree remove \
  <owner-home>/Developer/story-studio-kh/.worktrees/paused-job-recovery-v1490
git -C <owner-home>/Developer/story-studio-kh worktree prune
git -C <owner-home>/Developer/story-studio-kh worktree list
git -C <owner-home>/Developer/story-studio-kh status --short --branch
```

Delete the local feature branch only if the PR merge did not already do so and only after verifying its commit is reachable from main. Preserve the unrelated `youtube-upload-center-redesign` worktree and every other unowned workspace.

## Final Evidence to Report

- merged PR URL and merge commit;
- v1.4.90 version/changelog proof;
- focused RED/GREEN commands and counts;
- `npm run verify` completion counts and exit status;
- independent review result and any corrected findings;
- desktop/narrow screenshots and accessibility observations;
- main-root DMG absolute path, size, and SHA-256;
- clean main status and worktree inventory;
- explicit confirmation that customer job data, deployment, publishing, tagging, upload, and installation were untouched.
