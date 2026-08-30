# Customer Job Status Language v1.4.88 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release Story Studio KH v1.4.88 with the normal Jobs experience describing work that “needs attention” or “needs another try,” while retaining `error`/`failed` as internal and diagnostic state.

**Architecture:** This is one presentation-only copy batch. Reuse the existing Jobs page, `StatusBadge`, terminal-notification, batch-notification, and Retry-all seams; change only their customer-visible strings and their focused regression assertions. Do not add a state machine, mapping layer, schema, dependency, route, retry rule, or settlement/completion logic.

**Tech Stack:** Vue 3/Nuxt 4 single-file components, TypeScript composables/utilities, Node `node:test` through `tsx`, npm release scripts, Electron Builder.

**Spec:** `/build/Developer/_handoffs/artifacts/provider-decline-copy-analysis/current-main-implementation-brief.md`, especially **Minimal approved customer-state contract**.

## Global Constraints

- Start from branch `fix/customer-job-status-language-v1488` at base commit `562ecf421b7d961e5b8c8397e062a00643be6052`; the inspected baseline is v1.4.87 and the focused suite is 53/53 passing.
- Preserve the v1.4.87 safety, settlement, retry, output-counting, completion-audit, recovery, and billing behavior exactly.
- Preserve persisted and API states (`error`, `failed`), types, variables, CSS selectors, route/filter keys, backend diagnostics, developer logs/comments, additive GenStudio attempt evidence, and the contents of collapsed **Technical details**.
- Preserve action-failure toasts such as `Failed to resume job`: those describe an action that could not complete, not the customer-facing status of a queued job.
- Normal Jobs surfaces must not label a terminal work state `Error`, `Failed`, `failures`, or “provider refused/declined/failed”; use `Needs attention` for a job/episode state and `needs another try` for the next action.
- Keep raw backend/provider reason text unchanged. The first diagnostic line may still contain backend language; this release changes Story Studio’s surrounding status labels, not diagnostic evidence.
- Do not change `frontend/components/GenStudioBatchLedger.vue`, `frontend/components/GenStudioRequestPreview.vue`, `GENSTUDIO_QUEUE_LABELS`, or the raw `item_progress.failed` line inside Technical details.
- Apply Ponytail full mode: one implementation task, existing seams, no new dependency or abstraction, no broad cleanup.
- TDD is mandatory: add the focused assertions, observe the expected RED failures, make the copy-only changes, and observe GREEN before versioning.
- Release as `1.4.88`: update `package.json`, both root version surfaces in `package-lock.json`, and add the newest-first `## v1.4.88 — 2026-08-31` entry to `CHANGELOG.md`.
- `npm run test:backend` is the full backend release gate. Never cite a filtered backend run as a green release suite.
- Visual checks are mandatory because automated source assertions cannot prove wrapping, badge geometry, focus, tooltip readability, or responsive layout.
- Build the final unsigned smoke DMG only from the main checkout after the PR is merged. Do not publish, upload, install, or represent it as a signed public release.

## File Map

| File | Responsibility in this change |
|---|---|
| `frontend/pages/projects/[slug]/jobs.vue` | Customer-visible Jobs page description, metrics, batch banner, filters, card labels/disclosures, button/help text, Retry/Repair tooltips, and page-owned toasts. |
| `frontend/components/StatusBadge.vue` | Maps the internal `error` status to the Jobs-card label `Needs attention`; it currently has no other production caller. |
| `frontend/composables/useJobs.ts` | Changes the queued/running → `error` terminal toast wording while preserving its error tone and transition behavior. |
| `frontend/composables/useBatchCompletionSignals.ts` | Changes the cross-page pipeline-completion toast from a failed count to an episode-attention count. |
| `frontend/utils/repair-triage.ts` | Changes only Retry-all tooltip/toast prose; triage inputs, piles, and fail-closed behavior stay untouched. |
| `frontend/__tests__/jobsControls.test.ts` | Serves as the focused source/render-contract detector for every normal Jobs surface and both notification composables. |
| `frontend/__tests__/repairTriage.test.ts` | Pins the pure Retry-all wording while retaining every safety assertion. |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | v1.4.88 release integrity and customer-facing What's New entry. |

## Exact Customer Copy Contract

Apply this matrix literally. Internal identifiers named in the left column remain unchanged unless they are displayed text.

| Surface | Current customer copy | v1.4.88 copy |
|---|---|---|
| Project Jobs description | `understand failures` | `see what needs attention` |
| Hero terminal metric | `{n} errors` | `{n} job needs attention` / `{n} jobs need attention` |
| Project-wide repair tooltip | `To fix one failed job instead…` | `To help one job that needs attention instead…` |
| Batch headline | `{n} episode(s) failed` | `{n} episode needs attention` / `{n} episodes need attention` |
| Batch disclosure summary | `Show all failed episodes ({n})` | `Show all episodes needing attention ({n})` |
| Batch episode row | `failed at step {type}` | `needs attention at step {type}` |
| Batch review action | `Review failures →` | `Review jobs →` |
| Batch review tooltip | `Filter … to failed jobs … full error body…` | `Filter History below to jobs that need attention — use this to review each job’s details and choose whether to Retry.` |
| Batch Repair tooltip | `episode(s) that failed in this batch` | `episode(s) that need attention in this batch` |
| Batch explainer | `Review failures … jobs that truly errored — the provider never produced…` | `Review jobs is for work that still needs another try — no usable result was saved, so retrying may spend credits again.` |
| Status filter | `Failed` | `Needs attention` |
| Bulk Repair tooltip | `failed/cancelled … stay failed` | `jobs that need attention or were cancelled … missing items remain available for Retry` |
| Bulk Repair button | `Repair all failed ({n})` | `Repair available ({n})` |
| Active/history status badge | `Error` | `Needs attention` |
| Active/history diagnostic label | `Error:` | `What happened:` |
| Active/history diagnostic toggle | `Show full error` / `Hide full error` | `Show details` / `Hide details` |
| Repair-all completion toast | `anything still failed needs a Retry` | `anything still missing needs a Retry` |
| Repair “nothing missing” toast | `The original failure was temporary` | `The earlier problem was temporary` |
| Empty Retry-all toast/helper | `Nothing failed that can be retried.` | `No jobs need another try.` |
| Retry-all blocked reason | `{n} whose repair failed` | `{n} whose repair could not finish` |
| Retry-all completion toast | `any that were refused say so on their card` | `any that still need attention will say so on their card` |
| Repairable Retry tooltip | `Deletes this failed job and re-submits…` | `Re-submits this job as a fresh request…` |
| Whole-step Retry tooltip | `Deletes this failed job and re-submits it.` | `Re-submits this job as a fresh request.` |
| Per-job terminal toast | `{Job type} failed: {episode}` | `{Job type} needs attention: {episode}` |
| Pipeline terminal toast | `{success}/{total} succeeded, {failed} failed` | `{success}/{total} succeeded, {n} episode needs attention` / `{n} episodes need attention` |

---

### Task 1: Replace normal Jobs status names and release v1.4.88

**Files:**
- Modify: `frontend/__tests__/jobsControls.test.ts:1-190`
- Modify: `frontend/__tests__/repairTriage.test.ts:137-160`
- Modify: `frontend/pages/projects/[slug]/jobs.vue:6-295,350,588-604,692,903-919,1522-1640,1716-1723,2296-2320,2400-2460`
- Modify: `frontend/components/StatusBadge.vue:12-24`
- Modify: `frontend/composables/useJobs.ts:121-140`
- Modify: `frontend/composables/useBatchCompletionSignals.ts:95-103`
- Modify: `frontend/utils/repair-triage.ts:165-188`
- Modify: `package.json:3`
- Modify: `package-lock.json:3,9`
- Modify: `CHANGELOG.md:5`

**Interfaces:**
- Consumes: the existing `job.status === 'error'`, `batchSummary.failed`, `stats.error`, `describeRetryAllTriage()`, `announceTransitions()`, and `fireSignals()` data paths.
- Produces: copy only. Function signatures, return shapes, status keys, filtering, retry triage, completion outcomes, settlement data, and persisted records remain byte-for-byte compatible.

- [ ] **Step 1: Reconfirm scope and a clean start**

```bash
git status --short --branch
git rev-parse HEAD
node -p "require('./package.json').version"
```

Expected: branch `fix/customer-job-status-language-v1488`, HEAD `562ecf421b7d961e5b8c8397e062a00643be6052`, version `1.4.87`, and no uncommitted files except this plan.

- [ ] **Step 2: Add the RED customer-language detector**

In `frontend/__tests__/jobsControls.test.ts`, load the three additional production sources beside the existing `jobs` fixture:

```ts
const statusBadge = readFileSync(
  fileURLToPath(new URL('../components/StatusBadge.vue', import.meta.url)),
  'utf8',
)
const useJobsSource = readFileSync(
  fileURLToPath(new URL('../composables/useJobs.ts', import.meta.url)),
  'utf8',
)
const batchSignals = readFileSync(
  fileURLToPath(new URL('../composables/useBatchCompletionSignals.ts', import.meta.url)),
  'utf8',
)
```

Add one focused test which positively pins the new labels and negatively pins the exact legacy UI phrases. Keep the checks targeted; do not ban `error`/`failed` globally because internal keys, action-failure toasts, comments, and diagnostics deliberately keep them.

```ts
test('normal Jobs surfaces use attention language while internal status keys stay unchanged', () => {
  assert.match(statusBadge, /error: 'Needs attention'/)
  assert.match(jobs, /label: 'Needs attention'/)
  assert.match(jobs, /job.*need.*attention/s)
  assert.match(jobs, /episode.*need.*attention/s)
  assert.match(jobs, /Show all episodes needing attention/)
  assert.match(jobs, />Review jobs →<\/button>/)
  assert.match(jobs, /What happened:/)
  assert.match(jobs, /Show details/)
  assert.match(jobs, /Repair available/)
  assert.match(jobs, /No jobs need another try/)
  assert.match(useJobsSource, /\$\{label\} needs attention: \$\{job\.episode_id\}/)
  assert.match(batchSignals, /need.*attention/)

  for (const legacy of [
    /error: 'Error'/,
    /label: 'Failed'/,
    />Review failures/,
    /Repair all failed/,
    /<span class="error-label">Error:<\/span>/,
    /Show full error/,
    /Hide full error/,
    /Nothing failed that can be retried/,
    /Deletes this failed job/,
    /any that were refused say so on their card/,
  ]) {
    assert.doesNotMatch(`${statusBadge}\n${jobs}\n${useJobsSource}\n${batchSignals}`, legacy)
  }

  assert.match(jobs, /job\.status === 'error'/)
  assert.match(jobs, /statusFilter\.value = 'error'/)
  assert.match(jobs, /label="Technical details"/)
})
```

In `frontend/__tests__/repairTriage.test.ts`, extend the existing summary and empty-triage tests:

```ts
const repairCouldNotFinish = describeRetryAllTriage({
  retry: [],
  alreadyComplete: [],
  blocked: [{ job: job('repair-did-not-finish', 'audio'), reason: 'repair_failed' }],
})
assert.match(repairCouldNotFinish, /whose repair could not finish/)
assert.doesNotMatch(repairCouldNotFinish, /whose repair failed/)

assert.equal(
  describeRetryAllTriage({ retry: [], alreadyComplete: [], blocked: [] }),
  'No jobs need another try.',
)
```

- [ ] **Step 3: Run RED and confirm the failures are about legacy copy**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/jobsControls.test.ts \
  __tests__/repairTriage.test.ts \
  __tests__/useJobs.test.ts
cd ..
```

Expected: FAIL on `Error`, `Failed`, `Review failures`, repair/retry wording, the terminal toast, the batch toast, and the empty-triage sentence. Existing safety and state-machine tests must remain green. If a failure is a syntax/import error, fix the test and rerun until it fails for the intended copy mismatch.

- [ ] **Step 4: Apply the exact copy matrix with no behavior changes**

Edit only customer-visible literals in the five production files. Use singular/plural grammar where counts are displayed:

```vue
<strong>{{ stats.error }}</strong>
job{{ stats.error === 1 ? '' : 's' }} need{{ stats.error === 1 ? 's' : '' }} attention
```

```vue
<strong>
  {{ batchSummary.failed }} episode{{ batchSummary.failed === 1 ? '' : 's' }}
  need{{ batchSummary.failed === 1 ? 's' : '' }} attention
</strong>
```

```ts
const attention = `${failed} episode${failed === 1 ? '' : 's'} need${failed === 1 ? 's' : ''} attention`
const msg = failed > 0
  ? `Pipeline finished — ${success}/${total} succeeded, ${attention}`
  : `Pipeline finished — ${success}/${total} episodes complete`
```

Change `StatusBadge`’s existing `error` mapping directly because repository search proves the component’s only production callers are the two Jobs-card sites. Do not add a prop or a second status-label abstraction.

For the error disclosure, change only `Error:` and `Show/Hide full error`; preserve `customerJobText(...)`, `firstErrorLine(...)`, the native button, `aria-expanded`, `aria-controls`, focus styles, and the diagnostic body.

For `repair-triage.ts`, change only strings returned by `describeRetryAllTriage()`. Preserve `RepairRecord`, `TriageBlockReason`, `triageFailedJobsForRetryAll()`, all three piles, and every safety branch.

For `useJobs.ts`, keep the existing `showError(...)` channel and change only its message to `${label} needs attention: ${job.episode_id}`. Do not alter transition detection, statistics, SSE, polling, or completion notices.

- [ ] **Step 5: Run GREEN and the complete frontend lane**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/jobsControls.test.ts \
  __tests__/repairTriage.test.ts \
  __tests__/useJobs.test.ts
cd ..
npm run test:frontend
```

Expected: focused tests pass with zero failures, then the complete frontend lane passes. Inspect the focused output and confirm every new detector assertion ran; a zero-test run is a failure.

- [ ] **Step 6: Run a bounded residual-copy audit**

```bash
rg -n \
  "understand failures|>Review failures|Repair all failed|<span class=\"error-label\">Error:|Show full error|Hide full error|Nothing failed that can be retried|Deletes this failed job|any that were refused say so on their card|error: 'Error'|label: 'Failed'" \
  'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/components/StatusBadge.vue \
  frontend/composables/useJobs.ts \
  frontend/composables/useBatchCompletionSignals.ts \
  frontend/utils/repair-triage.ts
```

Expected: no matches. Then review the full diff and explicitly confirm that remaining `error`/`failed` occurrences are only internal keys/types/classes, action-failure messages, comments/logs, dynamic backend diagnostics, or Technical-details content.

- [ ] **Step 7: Bump and document v1.4.88**

```bash
npm version 1.4.88 --no-git-tag-version
```

Add this newest-first changelog entry directly above v1.4.87:

```markdown
## v1.4.88 — 2026-08-31

- **Jobs now say what needs attention instead of exposing internal Error and Failed state names.** Cards, filters, batch summaries, action help, and completion notices use the next useful customer action. The underlying queue states, retry and repair safety, settlement evidence, and full diagnostics under Technical details are unchanged.
```

Verify version surfaces:

```bash
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
node -p "require('./package-lock.json').packages[''].version"
npm run check:changelog
```

Expected: all three print `1.4.88`; changelog check exits 0.

- [ ] **Step 8: Run full release verification**

```bash
npm run verify
```

Expected: lint, Electron/frontend typechecks, full backend/frontend/release/content-pack tests, changelog/typography/security/model-drift/release checks, frontend generation, and Electron production build all exit 0. Do not substitute focused tests for this command.

- [ ] **Step 9: Perform wide/narrow Jobs UI QA and inspect the detector boundary**

```bash
npm run dev
```

Using an existing project with at least one `error`-status job and, if available, a settled mixed pipeline batch, inspect both **This project** and **All projects** at approximately 1440 px and 390 px widths. Do not edit `jobs.json` or customer data to manufacture a state.

Verify with Technical details collapsed:

- card badge, hero metric, filter chip, batch headline, batch disclosure summary/row, Review button, Repair available button, diagnostic label, and disclosure toggle match the copy table;
- button labels do not clip, the `Needs attention` chip wraps without covering the job identity/actions, filters remain keyboard reachable, and focus rings remain visible;
- hover/focus each changed tooltip and exercise a safe no-op/empty Retry-all path where available; terminal and batch toasts use the new language;
- no default Story-authored label says `Error`, `Failed`, `failures`, or provider refused/declined/failed;
- dynamic backend diagnostic text is unchanged and may still use those words;
- opening Technical details still shows the complete diagnostic attempt ledger, raw failed states/codes, counts, and settlement evidence.

Capture one wide and one narrow screenshot for review. If the available local data does not contain a batch or terminal toast, record that exact manual gap; the focused detector still gates its literal, but do not mutate customer data or claim the unobserved state was visually verified.

- [ ] **Step 10: Review the complete change and create one checkpoint commit**

```bash
git diff --check
git diff --stat
git diff -- \
  'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/components/StatusBadge.vue \
  frontend/composables/useJobs.ts \
  frontend/composables/useBatchCompletionSignals.ts \
  frontend/utils/repair-triage.ts \
  frontend/__tests__/jobsControls.test.ts \
  frontend/__tests__/repairTriage.test.ts \
  package.json package-lock.json CHANGELOG.md
git status --short
```

Review against the spec and copy matrix. Confirm no backend, schema, settlement, retry, completion, ledger, or Technical-details change exists. Then commit:

```bash
git add \
  'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/components/StatusBadge.vue \
  frontend/composables/useJobs.ts \
  frontend/composables/useBatchCompletionSignals.ts \
  frontend/utils/repair-triage.ts \
  frontend/__tests__/jobsControls.test.ts \
  frontend/__tests__/repairTriage.test.ts \
  package.json package-lock.json CHANGELOG.md \
  docs/superpowers/plans/2026-08-31-customer-job-status-language.md
git commit -m "fix: use customer job status language"
```

- [ ] **Step 11: Independent code review, fix round, and final evidence**

Request review of `562ecf421b7d961e5b8c8397e062a00643be6052..HEAD` against this plan and the approved brief. The reviewer must check copy-table completeness, default-versus-Technical-details boundaries, grammar at 1/N, accessibility, preservation of action-failure messages, no state/behavior changes, TDD evidence, and release integrity.

Resolve every Critical/Important finding. For any copy gap, add or tighten the RED assertion first, observe RED, apply the smallest fix, rerun GREEN, then rerun:

```bash
npm run verify
git diff --check
git status --short
```

Expected: full verify exits 0, diff check is clean, and the worktree contains only intentional committed work. Amend only if the fix belongs to this single coherent release commit; otherwise add a narrowly named fix commit.

- [ ] **Step 12: Push, open the PR, wait for checks, and merge**

```bash
git push -u origin fix/customer-job-status-language-v1488
gh pr create \
  --base main \
  --head fix/customer-job-status-language-v1488 \
  --title "fix: use customer job status language" \
  --body "Replaces normal Jobs-page Error/Failed status labels with needs-attention/needs-another-try language across cards, filters, batch UI, tooltips, and toasts. Internal states, diagnostics, retry/repair safety, settlement, and Technical details are unchanged. Releases v1.4.88. Verified with npm run verify plus wide/narrow Jobs UI QA."
gh pr checks --watch
```

After checks and required review are green:

```bash
gh pr merge --merge --delete-branch
```

Expected: one merge commit on `main`, matching the repository’s recent PR workflow. Do not merge with failing/pending required checks and do not publish a release from the feature worktree.

- [ ] **Step 13: Build and verify the v1.4.88 smoke DMG from main**

```bash
cd /build/Developer/story-studio-kh
git status --short --branch
git pull --ff-only origin main
node -p "require('./package.json').version"
npm run dist:smoke
npm run verify:artifact -- \
  --app "dist/mac-arm64/Story Studio KH.app" \
  --dmg "dist/Story Studio KH 1.4.88-arm64.dmg"
shasum -a 256 "dist/Story Studio KH 1.4.88-arm64.dmg"
```

Expected: clean `main`, version `1.4.88`, unsigned smoke build exits 0, exact artifact `dist/Story Studio KH 1.4.88-arm64.dmg`, bundled app/`app.asar`/What's New versions all `1.4.88`, and a recorded byte size/SHA-256. This artifact is a local smoke artifact, not a signed distributable.

If a public candidate is separately authorized and the protected Apple credentials are present, use `npm run dist:public` from the same clean main commit and run the repository’s signing, notarization, stapling, and Gatekeeper checks. Never substitute the unsigned smoke DMG for that public flow.

## Self-Review

- **Spec coverage:** The single task covers cards, filters, batch banner/disclosure, default buttons, tooltips, page and cross-page toasts, Retry/Repair prose, versioning, full verification, visual QA, review, PR/merge, and main-checkout DMG. It explicitly preserves the approved work-state, settlement, retry, completion, and diagnostic contracts.
- **Ponytail check:** No new runtime helper, state, schema, prop, dependency, component, migration, or backend edit is planned. `StatusBadge` is changed at its existing mapping because its only production callers are the two Jobs-card sites.
- **Boundary check:** Developer logs/comments, action-failure messages, persisted/internal values, backend reason text, and collapsed Technical details remain untouched.
- **Completeness scan:** Every implementation step includes literal copy, tests, commands, expected outcomes, review scope, and artifact path.
- **Type consistency:** No interface or type changes are introduced. Existing `error`/`failed` keys and `batchSummary.failed` continue to drive the same behavior; only rendered strings change.
