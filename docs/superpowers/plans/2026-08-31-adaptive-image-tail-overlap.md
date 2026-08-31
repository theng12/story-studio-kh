# Adaptive Image Tail Overlap v1.4.91 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before any completion claim.

**Goal:** Ship Story Studio KH v1.4.91 with fair per-type image scheduling and at most one capacity-verified temporary overlap opened only by a provable Continuity Render final wave.

**Architecture:** Keep `job-queue.ts` as the only Story scheduler. Reuse its existing pending arrays, group counters, checkpoint/manifest evidence, and GenStudio admission snapshot. Add one ephemeral round-robin cursor, an exact asynchronous Continuity tail proof, and a single-flight refresh that may pump the existing group at base + 1 once. Do not add another scheduler, dependency, timer loop, estimator, image-pool fan-out, or paid recovery behavior.

**Tech Stack:** Node/Express, TypeScript, atomic JSON job/checkpoint/manifest state, GenStudio admission snapshots, `node:test`/`tsx`, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-08-31-adaptive-image-tail-overlap-design.md`

## Starting Evidence

- Required worktree: `.worktrees/adaptive-image-queue-recovery`
- Required starting base: `90954df443dd5f48eba3313cee61df17fd0d030b` (Story Studio v1.4.90)
- Existing queue owner: `electron/server/services/job-queue.ts`
- Existing Continuity progress/checkpoint publisher: `electron/server/generators/continuity-render.ts`
- Existing manifest reader: `electron/server/services/task-manifest.ts`
- Existing capacity authority: `electron/server/lib/genstudio-admission.ts` and `refreshGenStudioAdmission()` in `electron/server/lib/genstudio-client.ts`
- Existing pool generator: `electron/server/generators/image-pool-generate.ts`; its item loop is serial and must remain so.

Before edits, re-read `AGENTS.md`, the spec, `docs/architecture/security-reliability.md`, and `git status`. Record the exact branch/base and preserve unrelated work.

Establish a focused baseline:

```bash
node scripts/testing/run-backend-tests.mjs \
  --only image-episode-concurrency \
  --only job-queue-concurrency \
  --only job-queue-genstudio-resume \
  --only genstudio-admission \
  --only continuity-render-genstudio-retry
```

These are partial baselines, not release acceptance.

## Global Constraints

- `image_episode_concurrency` is the explicit normal base `N`; peak active image-group jobs is `N + 1`.
- Only a currently active `continuity_render` job may open the one temporary slot.
- `image_pool_generate` remains eligible to consume the next fairly selected slot after Continuity opens it, but its serial loop can never prove/open a tail. Do not edit it to add item fan-out.
- Counts alone are insufficient. Every `item_progress.active[].key` must map one-to-one through `params.genstudio_recovery.assets` and/or its corresponding manifest to one distinct accepted, real, nonterminal `image.generation` task.
- Reconcile `active.length`, `settling`, and the complete expected-count identity before any capacity refresh. Fail closed on missing, duplicate, ambiguous, pending, terminal, cancelled, or contradictory evidence.
- Capacity must be freshly verified and the full proof/queue state rechecked after the await.
- Selection is round-robin by image type, recovery FIFO before fresh FIFO within a type. Never rank by remaining work, scene count, percentage, model, price, age, or estimated duration; this is not global SRTF.
- Reuse existing queue, persistence, admission, pause/cancel, and completion primitives. Add no dependency or scheduler framework.
- No paid replacement/settings/pricing and no audio/video changes in this release.
- Every behavior task follows RED, observed intended failure, smallest implementation, focused GREEN, then review.
- Version only after behavior tests pass. Merge only after complete verification and independent review. Build the DMG only from synchronized `main` after merge.

## File Map

| File | Responsibility |
|---|---|
| `electron/server/services/job-queue.ts` | Round-robin image group pump, two FIFO classes, exact Continuity tail proof orchestration, one single-flight capacity gate, and base + one invariant. |
| `electron/server/generators/continuity-render.ts` | Preserve/publish the existing exact active-key progress and checkpoint transitions needed by the proof; change only if a RED test exposes an actual missing transition. |
| `electron/server/services/task-manifest.ts` | Reuse existing manifest read contract; avoid schema changes unless a narrow read helper is demonstrably necessary. |
| `electron/server/lib/genstudio-client.ts` | Reuse `refreshGenStudioAdmission()` unchanged unless a test-only injection seam is necessary. |
| `electron/server/__tests__/adaptive-image-tail-overlap.test.ts` | Fairness, mapping, count, capacity, race, opener/candidate, and base-limit coverage. |
| `electron/server/__tests__/image-episode-concurrency.test.ts` | Existing group-limit regression. |
| `electron/server/__tests__/job-queue-concurrency.test.ts` | Existing queue admission regression. |
| `electron/server/__tests__/job-queue-genstudio-resume.test.ts` | Existing recovery FIFO/restart regression. |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | v1.4.91 release surfaces. |

---

### Task 1: Make existing image-group admission fair

**Files:**
- Create: `electron/server/__tests__/adaptive-image-tail-overlap.test.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test: `electron/server/__tests__/image-episode-concurrency.test.ts`
- Test: `electron/server/__tests__/job-queue-concurrency.test.ts`
- Test: `electron/server/__tests__/job-queue-genstudio-resume.test.ts`

**Contract:** Reuse the existing per-type pending arrays and group counters. Add one ephemeral image-type cursor and one common group pump. Within each type, jobs with existing `started_at` are recovery FIFO; never-started jobs are fresh FIFO. Do not create a priority queue or sort by job size.

- [ ] **Step 1: Write RED fairness tests**

Use deferred test executors so admission order is deterministic. With base two and both types continuously queued, prove alternating opportunity and FIFO:

```ts
assert.equal(peakActive, 2)
assert.deepEqual(started.slice(0, 4), [
  'continuity:c1',
  'pool:p1',
  'continuity:c2',
  'pool:p2',
])
assert.deepEqual(continuityStarts, ['c1', 'c2', 'c3'])
assert.deepEqual(poolStarts, ['p1', 'p2', 'p3'])
```

Add same-type fixtures proving an already-started recovery job precedes a fresh job while FIFO is preserved within each class. Add a source guard rejecting admission sorts/terms for `remaining`, `estimated`, `duration`, `sceneCount`, `percentage`, `SRTF`, or `shortest`.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only image-episode-concurrency \
  --only job-queue-concurrency \
  --only job-queue-genstudio-resume
```

Expected: the new fairness assertions fail against fixed type iteration; existing concurrency protections remain green.

- [ ] **Step 3: Implement one round-robin pump**

Add the smallest local state and helpers in `job-queue.ts`:

```ts
let imageEpisodeCursor = 0

function nextImageGroupJob(type: JobType): Job | null
function pumpImageEpisodeGroup(limit: number): void
```

`nextImageGroupJob` selects the first recovery item when present, otherwise the first fresh item, without reordering either class. `pumpImageEpisodeGroup` offers at most one head per type per visit, advances after each admitted job, stops after a full empty pass, and synchronously consumes group capacity before any executor await. Route enqueue, release, settings change, and recovered-job pumping through this one path. Leave every non-image group unchanged.

- [ ] **Step 4: Run GREEN**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only image-episode-concurrency \
  --only job-queue-concurrency \
  --only job-queue-genstudio-resume
```

- [ ] **Step 5: Commit and independently review**

```bash
git add electron/server/services/job-queue.ts \
  electron/server/__tests__/adaptive-image-tail-overlap.test.ts
git commit -m "fix: make image queue admission fair"
```

Review for per-type opportunity, FIFO stability, completion bias, synchronous permit consumption, unchanged non-image lanes, and absence of SRTF/estimation. Resolve findings and rerun Step 4.

---

### Task 2: Prove an exact Continuity final wave before refreshing capacity

**Files:**
- Modify: `electron/server/__tests__/adaptive-image-tail-overlap.test.ts`
- Modify: `electron/server/services/job-queue.ts`
- Modify only if RED proves necessary: `electron/server/generators/continuity-render.ts`
- Read/reuse: `electron/server/services/task-manifest.ts`

**Contract:** Produce an asynchronous proof, because manifest evidence is durable filesystem state:

```ts
interface ContinuityTailProof {
  job_id: string
  settling: number
  concurrency: number
  active_asset_keys: string[]
  provider_task_ids: string[]
}

async function proveContinuitySettlingTail(
  job: Job,
): Promise<ContinuityTailProof | null>
```

The helper is a fail-closed reader. It never mutates a job, manifest, or provider task.

- [ ] **Step 1: Write RED progress-reconciliation tests**

Cover valid and invalid whole-number/nonnegative fields. A proof must require:

```text
active.length = settling
total = completed + failed + settling + cancelled + not_submitted
not_submitted = 0
0 < settling < concurrency
```

All active keys must be non-empty, unique, and `state === 'running'`. Missing values, fractionals, negatives, duplicates, `waiting_retry`, full waves, or arithmetic mismatch return `null` and must not call the capacity refresh seam.

- [ ] **Step 2: Write RED one-to-one binding tests**

For each active key, fixtures must exercise checkpoint-only ID, manifest-only ID, and agreeing checkpoint+manifest ID. Prove rejection for:

- absent `params.genstudio_recovery`, wrong version/route/operation, or missing asset key;
- pending/blank task ID;
- checkpoint/manifest task-ID disagreement;
- checkpoint/manifest idempotency-key disagreement;
- output path or input-hash mismatch;
- missing, duplicate, wrong-operation, terminal, or cancelled `genstudio_jobs` evidence;
- two active keys mapping to one provider task;
- a count-perfect job with one unmapped active key.

The valid result must satisfy:

```ts
assert.equal(proof.active_asset_keys.length, progress.settling)
assert.equal(new Set(proof.provider_task_ids).size, progress.settling)
```

- [ ] **Step 3: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs --only adaptive-image-tail-overlap
```

Expected: the new proof function is absent or count-only behavior fails exact binding cases.

- [ ] **Step 4: Implement the proof in the tested order**

Validate all progress arithmetic first. Then, for each active key, resolve its `params.genstudio_recovery.assets[key]` checkpoint and corresponding manifest entry using existing helpers. Require at least one real accepted task ID; if both surfaces publish ID/key they must agree. Resolve exactly one matching nonterminal `image.generation` entry from `job.genstudio_jobs`, and enforce distinct IDs with a set.

Only return a proof after exact equality across active keys, distinct task IDs, `settling`, and `active.length`. Do not guess by filename, newest task, array position, or counts. Do not refresh capacity inside this helper.

If Continuity currently misses an exact progress checkpoint transition exposed by the test, add only that checkpoint update. Do not modify provider retry, settlement, output naming, or internal worker concurrency.

- [ ] **Step 5: Run GREEN and adjacent recovery tests**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only job-queue-genstudio-resume \
  --only continuity-render-genstudio-retry
```

- [ ] **Step 6: Commit and independently review**

```bash
git add electron/server/services/job-queue.ts \
  electron/server/generators/continuity-render.ts \
  electron/server/__tests__/adaptive-image-tail-overlap.test.ts
git commit -m "feat: prove continuity image tails"
```

Stage `continuity-render.ts` only if it changed. Reviewer traces every active key through checkpoint/manifest/provider evidence and confirms all arithmetic precedes network access. Resolve findings before Task 3.

---

### Task 3: Admit one temporary slot through fresh authoritative capacity

**Files:**
- Modify: `electron/server/__tests__/adaptive-image-tail-overlap.test.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test: `electron/server/__tests__/genstudio-admission.test.ts`
- Test: `electron/server/__tests__/image-episode-concurrency.test.ts`
- Preserve unchanged: `electron/server/generators/image-pool-generate.ts`

**Contract:** Add one event-driven single-flight gate:

```ts
function requestAdaptiveImageTailAdmission(): void
```

It may call `pumpImageEpisodeGroup(base + 1)` once only after Task 2 proves an active Continuity opener and a freshly refreshed snapshot passes every authoritative capacity field.

- [ ] **Step 1: Write RED capacity and race tests**

With injected/deferred refresh responses, prove peak is `base + 1` only when all are true: the image group is exactly at base, a candidate remains pending, a Continuity proof exists, global queue is running, and the fresh snapshot reports `capacity_verified: true`, `limitSource: 'account-overview'`, `available_paid_slots > 0`, `queue_near_capacity: false`, `submissions_blocked: false`, and `retry_after_ms: 0`.

Prove no overflow for missing API key, stale/fallback/unreachable/malformed refresh, zero paid slots, provider queue pressure, rate/credit hold, pause during await, candidate removed during await, opener completed/changed during await, base changed during await, existing overflow, or two concurrent trigger events. Use deferred promises, not sleeps.

Add explicit opener/candidate tests:

```ts
assert.equal(await canOpenTail(poolSerialTail), false)
assert.deepEqual(startedAfterContinuityOpens, ['image_pool_generate:p1'])
```

The first proves Pool cannot open. The second proves Pool remains a fair candidate that may consume an overflow opened by Continuity.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only genstudio-admission \
  --only image-episode-concurrency
```

- [ ] **Step 3: Implement the single-flight gate**

Before refresh, require group active exactly equals current base, no existing overflow, at least one pending candidate, and at least one successful Task 2 Continuity proof. Share one in-flight promise for simultaneous triggers. After `await refreshGenStudioAdmission(apiKey)`, recompute base, group active, pending candidate, global pause, and the complete asynchronous proof from fresh persisted job/manifest facts. Then require every snapshot field and call the existing fair pump with `base + 1`.

Do not persist a permit: `groupActive[IMAGE_EPISODE_GROUP] > base` is the overflow fact. Existing enqueue, eligible checkpoint/evidence, and image slot release events may request another check. Add no interval, daemon, or busy loop. The temporary slot admits only a Story executor; the eventual POST still uses normal `GenStudioAdmissionPool` admission.

Do not modify `image-pool-generate.ts`. Its current serial loop is why it cannot open a tail; adding pool fan-out is out of scope.

- [ ] **Step 4: Run GREEN and no-framework guards**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only genstudio-admission \
  --only image-episode-concurrency \
  --only job-queue-concurrency \
  --only no-new-wallclock-sleeps

git diff --exit-code 90954df443dd5f48eba3313cee61df17fd0d030b -- \
  electron/server/generators/image-pool-generate.ts

git diff -U0 90954df443dd5f48eba3313cee61df17fd0d030b -- \
  electron/server/services/job-queue.ts | \
  rg "setInterval|while \(true\)|SRTF|shortest|estimated.*duration"
```

Expected: tests pass; Pool generator has no diff; the final scan has no matches (an `rg` exit code of 1 is expected).

- [ ] **Step 5: Commit and independently review**

```bash
git add electron/server/services/job-queue.ts \
  electron/server/__tests__/adaptive-image-tail-overlap.test.ts
git commit -m "feat: overlap one verified image tail"
```

Reviewer checks exact mapping before refresh, complete post-await recheck, single-flight race handling, base decreases, pause, one-overflow proof, Pool candidate-but-not-opener behavior, and unchanged provider admission. Resolve every finding and rerun Step 4.

---

### Task 4: Release and independently verify v1.4.91

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump exact release surfaces**

Set `1.4.91` in `package.json`, root `package-lock.json.version`, and root package `package-lock.json.packages[""].version`. Add newest-first `## v1.4.91 — 2026-08-31` changelog copy describing per-type fairness and one verified Continuity final-wave overlap. State that the explicit base remains the normal limit. Do not claim guaranteed speedup or mention paid replacement.

- [ ] **Step 2: Run focused and complete verification**

```bash
npm run check:changelog

node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only image-episode-concurrency \
  --only job-queue-concurrency \
  --only job-queue-genstudio-resume \
  --only genstudio-admission \
  --only continuity-render-genstudio-retry \
  --only no-new-wallclock-sleeps

npm run verify
git diff --check
git status --short
```

The unfiltered `npm run verify` is mandatory. Capture exact commands, exit codes, and relevant test counts for PR evidence. Confirm no dependency change other than lockfile version metadata and no paid/audio/video/pool-fanout source diff.

- [ ] **Step 3: Commit the release metadata**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v1.4.91"
```

- [ ] **Step 4: Obtain final independent review**

Request a clean-context concurrency/safety review against this spec and the branch diff. The reviewer must explicitly assess Critical/High/Important findings, exact active-key proof, stale-await races, fairness/starvation, one-overflow invariant, opener/candidate distinction, and release claims. Resolve every finding, rerun all affected focused tests plus `npm run verify`, and commit fixes before integration.

---

### Task 5: Integrate v1.4.91 and build the main DMG

- [ ] **Step 1: Confirm clean integration preconditions**

```bash
git status --short
git log --oneline --decorate -8
gh pr checks --watch
```

Require a clean branch, completed independent review, passing verification/checks, and mergeability. Never force-push.

- [ ] **Step 2: Push, create/update, and merge the v1.4.91 PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
gh pr checks --watch
gh pr merge --merge --delete-branch
```

If a PR already exists, update it instead of creating a duplicate. Stop on unresolved checks/review/mergeability. Do not publish, tag, deploy, install, or submit paid work.

- [ ] **Step 3: Synchronize main and build the release artifact**

From the main repository checkout, fast-forward `main`, confirm `HEAD` contains the merged PR and version `1.4.91`, then run:

```bash
npm run dist:smoke
```

Verify the arm64 DMG exists in main’s normal `dist/`, its filename/version is `1.4.91`, and bundled `app.asar` reports `1.4.91`. Record the merged PR URL, merge commit, DMG absolute path, size, checksum if the project normally records one, and smoke output. Do not sign/notarize or publish.

## Definition of Done

- Per-type round-robin and recovery/fresh FIFO tests pass without SRTF.
- Exact one-to-one Continuity active-key/provider-task proof precedes every capacity refresh.
- One fresh, post-await-revalidated capacity gate allows at most base + one.
- Pool may consume an opened slot but remains serial and cannot open one.
- No paid recovery or audio/video behavior is present.
- v1.4.91 is independently reviewed, fully verified, merged, synchronized to main, and its main-built DMG is verified.
