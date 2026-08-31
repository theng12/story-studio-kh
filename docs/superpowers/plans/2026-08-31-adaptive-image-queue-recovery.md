# Adaptive Image Queue Recovery v1.4.91 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before any completion claim.

**Goal:** Ship Story Studio KH v1.4.91 with fair, capacity-verified one-slot image tail overlap and an off-by-default, strictly bounded paid replacement for authoritatively failed image assets.

**Architecture:** Keep `job-queue.ts` as the only Story queue owner, extend its existing image group with round-robin/two-class FIFO admission, and consume one temporary permit only after a fresh verified `GenStudioAdmissionPool` snapshot. Keep paid recovery on the same durable Story job and task manifest; a small shared image-replacement helper validates terminal settlement, waits 30 minutes, forces a live image price read, commits one deterministic scope before POST, and preserves every valid artifact. Reuse app settings, job checkpoints, manifest recovery, SSE, and completion auditors; add no dependency or scheduler framework.

**Tech Stack:** Node/Express, TypeScript, Vue 3/Nuxt 4, atomic JSON task manifests and jobs, GenStudio durable jobs/catalog/admission, `node:test`/`tsx`, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-08-31-adaptive-image-queue-recovery-design.md`

## Starting Evidence

- Required worktree: `.worktrees/adaptive-image-queue-recovery`
- Required base: `90954df443dd5f48eba3313cee61df17fd0d030b`
- Baseline version: `1.4.90`
- Existing queue primitives: `electron/server/services/job-queue.ts`
- Existing capacity authority: `electron/server/lib/genstudio-admission.ts` and `genStudioAdmissionSnapshot()` / `refreshGenStudioAdmission()` in `electron/server/lib/genstudio-client.ts`
- Existing durable image recovery: `electron/server/lib/manifest-recovery.ts`, `electron/server/generators/continuity-render.ts`, `electron/server/generators/images.ts`, and `electron/server/generators/image-pool-generate.ts`

Establish focused baselines before editing production code:

```bash
node scripts/testing/run-backend-tests.mjs \
  --only image-episode-concurrency \
  --only job-queue-concurrency \
  --only job-queue-genstudio-resume \
  --only genstudio-admission \
  --only image-route-exhausted-retry \
  --only genstudio-image-integration

cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/settingsThroughput.test.ts \
  __tests__/jobsControls.test.ts \
  __tests__/usePresets.test.ts
cd ..
```

These are partial TDD baselines, never the release gate.

## Global Constraints

- Re-read repository `AGENTS.md`, the spec, `docs/architecture/security-reliability.md`, and current branch status before implementation.
- Apply Ponytail full mode: reuse the existing queue arrays, group counters, admission refresh, app-setting store, job checkpoint, manifest, deterministic image retry scope, Jobs SSE, and completion auditors. Add no dependency and no second queue/scheduler framework.
- Preserve unrelated work and never read or mutate customer `jobs.json` or real task manifests in tests; use the isolated temporary-project harness.
- `image_episode_concurrency` remains the explicit base. Adaptive image-group maximum is exactly base + 1 and at most one overflow.
- Tail eligibility requires an under-filled final wave of real accepted image task IDs, no unsubmitted/retrying/uncertain work, and exact progress/evidence reconciliation.
- Overflow requires a fresh verified account-overview capacity snapshot with available paid slots and provider queue headroom. Fallback or stale capacity never authorizes it.
- Queue choice is recovery-first FIFO within type and round-robin across image types. Never add SRTF, duration estimates, scene-count ranking, model ranking, or credit-price ranking.
- Paid replacement is image-only, Off by default, fixed at 30 minutes after authoritative terminal failure, maximum one per asset, and requires a positive whole-number additional-credit ceiling snapshotted per Story job.
- Elapsed time alone never authorizes a replacement. Unknown, uncertain, nonterminal, imbalanced settlement, refusal, validation, cancellation, auth, billing, and unavailable-price cases fail closed.
- Force a live image-catalog price read and fresh account read immediately before credit commitment. Never cache, copy, or invent model price/capability values.
- Persist the paid attempt and deterministic replacement scope before POST. Preserve valid artifacts and complete only through existing expected-versus-present audits.
- Never add the setting to project config, generator/pipeline presets, or preset migrations. Do not rewrite stored presets.
- Deliver no paid audio/video recovery and no adaptive audio/video queue behavior.
- Each behavior task is sequential: RED test, intended failure, minimal implementation, focused GREEN, independent review, then the next task.
- Do not version until all behavior/UI tasks are green and independently reviewed.
- Do not push, open/merge a PR, or package until `npm run verify`, rendered QA, and final billing/idempotency review are clean.
- Build the smoke DMG only from synchronized `main` after merge, into main’s normal `dist/` directory.

## File Map

| File | Responsibility |
|---|---|
| `electron/server/services/job-queue.ts` | Fair image-group admission, base+one permit, single-flight live capacity check, completion-biased recovery rejoin, paid-wait lifecycle, durable job checkpoint/SSE. |
| `electron/server/lib/genstudio-admission.ts` | Reuse snapshot facts unchanged unless a focused read-only helper is required; no second capacity model. |
| `electron/server/lib/genstudio-client.ts` | Add one force-live image-catalog refresh function; reuse task recovery, settlement, and retry-scope rules. |
| `electron/server/services/app-settings.ts` | Strict machine-level paid-image setting defaults and validation. |
| `electron/server/routes/app-settings.ts` | GET/PUT recovery setting contract; echo actual stored values. |
| `electron/server/boot/executors.ts` | Apply settings at boot only if a live queue setter is needed; do not add background work. |
| `electron/server/models/types.ts` | Server `Job` policy/attempt contracts and paid-wait projection. |
| `electron/server/contracts/index.ts` | Renderer-visible additive policy/attempt fields. |
| `electron/server/services/task-manifest.ts` | Optional replacement-of/scope/quote binding beside the existing asset identity. |
| `electron/server/services/image-paid-replacement.ts` | One shared pure decision/quote/commit helper for recovery-capable image generators; no timer loop or provider routing. |
| `electron/server/generators/continuity-render.ts` | Use shared paid gate after existing recovery and zero-settlement retry; checkpoint progress for tail checks. |
| `electron/server/generators/images.ts` | Same paid gate for durable scene/thumbnail assets; no change to unsupported preview flows. |
| `electron/server/generators/image-pool-generate.ts` | Same paid gate for durable pool assets. |
| `frontend/components/ThisMacSettings.vue` | Off-by-default setting, required ceiling, fixed 30-minute/one-attempt copy, responsive accessible validation. |
| `frontend/pages/projects/[slug]/jobs.vue` | Compact waiting/committed/blocked/submitted/settled paid-recovery state. |
| `frontend/composables/usePresets.ts` | Prefer no production change; regression test proves no setting key enters presets. |
| `electron/server/__tests__/adaptive-image-tail-overlap.test.ts` | Tail proof, live capacity, base+one, round-robin/FIFO, completion bias, and race coverage. |
| `electron/server/__tests__/paid-image-replacement-settings.test.ts` | Defaults, bounds, route, job snapshot, and preset exclusion. |
| `electron/server/__tests__/paid-image-replacement-policy.test.ts` | Terminal/settlement/price/budget/idempotency pure matrix. |
| `electron/server/__tests__/paid-image-replacement-integration.test.ts` | Generator, restart, crash-boundary, artifact, and no-audio/video integration. |
| `frontend/__tests__/paidImageRecoverySettings.test.ts` | Settings and Jobs customer-visible contract. |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | v1.4.91 release surfaces. |

---

### Task 1: Make image-group admission fair before adding overflow

**Files:**
- Create: `electron/server/__tests__/adaptive-image-tail-overlap.test.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test: `electron/server/__tests__/image-episode-concurrency.test.ts`
- Test: `electron/server/__tests__/job-queue-concurrency.test.ts`

**Interfaces:**
- Consumes: existing `queues`, `IMAGE_EPISODE_TYPES`, `IMAGE_EPISODE_GROUP`, `groupActive`, `groupLimit`, `pump`, `pumpGroup`, and `releaseSlot` in `job-queue.ts`.
- Produces: one image-group round-robin cursor and a single `pumpImageEpisodeGroup(limit: number): void` path used by enqueue, slot release, setting changes, boot recovery, and later adaptive admission.

- [ ] **Step 1: Write RED fairness and base-limit tests**

Build isolated executors for `continuity_render` and `image_pool_generate` whose deferred promises expose exact start order. Assert:

```ts
assert.equal(peakActive, base)
assert.deepEqual(started.slice(0, 4), [
  'continuity:c1',
  'pool:p1',
  'continuity:c2',
  'pool:p2',
])
assert.deepEqual(
  started.filter(value => value.startsWith('continuity:')),
  ['continuity:c1', 'continuity:c2', 'continuity:c3'],
  'each type remains FIFO',
)
```

Add a recovery fixture with `started_at` already set and a fresh fixture in the same type. Prove recovery FIFO is selected first, then fresh FIFO, without comparing item counts or durations. Add a source assertion rejecting `remainingTime`, `estimatedDuration`, `SRTF`, `shortest`, or a sort over progress/scene count in image admission.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only image-episode-concurrency \
  --only job-queue-concurrency
```

Expected: the fixed set iteration lets one type consume the group budget or does not honor the recovery/fresh classes; existing base-limit tests remain green.

- [ ] **Step 3: Implement one round-robin group pump**

Keep the existing queue arrays. Do not introduce a priority queue. Add an ephemeral cursor and select one head per type per turn:

```ts
let imageEpisodeCursor = 0

function imageQueueClass(job: Job): 0 | 1 {
  return job.started_at ? 0 : 1 // recovery/completion first, then never-started
}

function nextImageJob(type: JobType): Job | null {
  const pending = queues[type].pending
  const recovery = pending.findIndex(job => imageQueueClass(job) === 0)
  const index = recovery >= 0 ? recovery : 0
  return pending.length ? pending.splice(index, 1)[0]! : null
}
```

`pumpImageEpisodeGroup(limit)` must visit `IMAGE_EPISODE_TYPES` round-robin, start at most one head per visit, advance the cursor after every selection, stop after one full empty pass, and consume the group budget synchronously before any executor yields. Delegate every image-group call from `pump()`/`pumpGroup()` to this function. Leave thumbnail/audio/video/text/local lanes unchanged.

Within each class, retain array order; do not sort by timestamps or remaining work. When boot/reconciliation reinserts already-started work, its existing `started_at` places it in the recovery class.

- [ ] **Step 4: Run GREEN and starvation regression**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only image-episode-concurrency \
  --only job-queue-concurrency \
  --only job-queue-genstudio-resume
```

Expected: exact base peak, alternating type opportunity, FIFO in each class, recovery before fresh, and unchanged adjacent lanes.

- [ ] **Step 5: Commit and independent review**

```bash
git add electron/server/services/job-queue.ts \
  electron/server/__tests__/adaptive-image-tail-overlap.test.ts
git commit -m "fix: make image queue admission fair"
```

Reviewer verifies no SRTF/size estimate, no new queue structure, no changed non-image group, and no starvation under repeated enqueue/release. Resolve findings and rerun Step 4 before Task 2.

---

### Task 2: Admit at most one capacity-verified settling tail overflow

**Files:**
- Modify: `electron/server/__tests__/adaptive-image-tail-overlap.test.ts`
- Modify: `electron/server/services/job-queue.ts`
- Modify: `electron/server/generators/image-pool-generate.ts`
- Test: `electron/server/__tests__/genstudio-admission.test.ts`
- Test: `electron/server/__tests__/image-episode-concurrency.test.ts`

**Interfaces:**
- Consumes: `refreshGenStudioAdmission(apiKey)`, `GenStudioAdmissionSnapshot`, `getApiKey('genstudio')`, `checkpointJobState(job)`, `recordGenStudioJob(jobId, snapshot)`, and Task 1’s `pumpImageEpisodeGroup(limit)`.
- Produces: `isSettlingImageTail(job: Job): boolean` and `requestAdaptiveImageTailAdmission(): void`; only the latter may grant one base+one permit.

- [ ] **Step 1: Add RED tail proof and capacity matrix**

Cover:

```ts
assert.equal(isSettlingImageTail(fullFinalWave), false)
assert.equal(isSettlingImageTail(underfilledAcceptedFinalWave), true)
assert.equal(isSettlingImageTail(withUnsubmittedItem), false)
assert.equal(isSettlingImageTail(withWaitingRetry), false)
assert.equal(isSettlingImageTail(withPendingIdempotencyOnlyEntry), false)
assert.equal(isSettlingImageTail(withUnmappedOrImbalancedCounts), false)
```

At queue level, assert base `2` reaches peak `3` only for one eligible tail plus a fresh snapshot containing `capacity_verified: true`, `limitSource: 'account-overview'`, `available_paid_slots: 1`, queue headroom, and no hold. Assert peak remains `2` for fallback, stale/unreachable refresh, zero available slots, near-full provider queue, global pause, malformed item progress, and concurrent duplicate checks. Assert lowering base while three jobs run starts nothing else until active falls below the new applicable limit.

Use deferred capacity responses and executor gates; do not prove races with sleeps.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only genstudio-admission \
  --only image-episode-concurrency
```

Expected: no overflow exists on the baseline; the new peak-three assertion fails while all fail-closed cases remain protected.

- [ ] **Step 3: Implement the pure tail predicate**

Derive eligibility only from existing progress and provider evidence:

```ts
function isSettlingImageTail(job: Job): boolean {
  const progress = job.item_progress
  if (job.status !== 'running' || !progress || progress.total < 1) return false
  if ((progress.not_submitted ?? 0) !== 0) return false
  if (progress.active.some(item => item.state === 'waiting_retry')) return false

  const remaining = progress.total - progress.completed - progress.failed
    - (progress.cancelled ?? 0)
  const acceptedUnsettled = (job.genstudio_jobs || []).filter(entry =>
    entry.operation === 'image.generation'
      && !entry.id.startsWith('pending:')
      && !isSettledProviderEntry(entry))

  return remaining > 0
    && remaining === acceptedUnsettled.length
    && remaining < progress.concurrency
}
```

Use the repository’s shared provider-state predicate rather than inventing `isSettledProviderEntry`. Require exact count reconciliation including `settling` when present. A pending preview, uncertain state, duplicate active ID, or malformed count returns false.

Bring `image_pool_generate` onto the existing additive `item_progress` contract: publish total, completed, failed, settling, not-submitted, configured concurrency, and active asset keys from its current worker loop. Do not introduce a second progress store. Continuity Render already publishes these facts; adjust it only if the RED count-reconciliation test exposes a missing transition.

- [ ] **Step 4: Add a one-shot single-flight capacity gate**

`requestAdaptiveImageTailAdmission()` must:

1. no-op unless the image group is exactly at base, no overflow is active, a pending image-group job exists, and at least one active image job still satisfies the tail predicate;
2. share one in-flight refresh promise so simultaneous checkpoints cannot mint two permits;
3. read the GenStudio key and call `refreshGenStudioAdmission()`;
4. re-check queue/tail/pending facts after the await;
5. require the exact live snapshot gates from the spec;
6. consume the permit by calling `pumpImageEpisodeGroup(base + 1)` once.

Do not persist the permit; `groupActive[IMAGE_EPISODE_GROUP] > imageEpisodeConcurrency` is the active overflow proof. Trigger this check after image `checkpointJobState`, image `recordGenStudioJob`, image enqueue, and image slot release. These are existing events, so add no interval or polling loop.

- [ ] **Step 5: Run GREEN and verify no wall-clock scheduler**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only genstudio-admission \
  --only image-episode-concurrency \
  --only no-new-wallclock-sleeps

rg -n "setInterval|while \(true\)|SRTF|shortest.*job|estimated.*duration" \
  <(git diff -U0 -- electron/server/services/job-queue.ts)
```

Expected: only one overflow, all capacity failures closed, no new interval/scan, and no size/duration ranking.

- [ ] **Step 6: Commit and independent concurrency review**

```bash
git add electron/server/services/job-queue.ts \
  electron/server/generators/image-pool-generate.ts \
  electron/server/__tests__/adaptive-image-tail-overlap.test.ts
git commit -m "feat: overlap one verified image tail"
```

Reviewer checks every await/re-check race, live-capacity provenance, base changes, global pause, one-overflow proof, and that provider admission still gates every eventual POST. Fix findings and rerun Step 5.

---

### Task 3: Add the machine-level paid image policy without presets

**Files:**
- Create: `electron/server/__tests__/paid-image-replacement-settings.test.ts`
- Modify: `electron/server/services/app-settings.ts`
- Modify: `electron/server/routes/app-settings.ts`
- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/contracts/index.ts`
- Modify: `electron/server/services/job-queue.ts`

**Interfaces:**
- Produces: `PaidImageReplacementSetting`, `PaidImageReplacementPolicySnapshot`, `PaidImageReplacementAttempt`, `getPaidImageReplacementSetting()`, `setPaidImageReplacementSetting(value)`, and a server-owned job snapshot outside `params`.
- Consumes: existing `getAppSetting`, `setAppSetting`, `enqueue()`, `enqueuePrepared()`, app-settings route error handling, and renderer `Job` projection.

- [ ] **Step 1: Write RED defaults, validation, route, snapshot, and preset tests**

Assert exact defaults and bounds:

```ts
assert.deepEqual(await getPaidImageReplacementSetting(), {
  enabled: false,
  additional_credit_ceiling: null,
})

await assert.rejects(
  setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: null }),
  /positive whole-number credit ceiling/i,
)
```

Test enabled with positive whole credits, disabled with null/retained valid ceiling, rejection of zero, negative, fractional, string, NaN, and excessive non-safe integers, and that rejected writes preserve the last valid record. Route GET/PUT must echo actual stored values and return 400 for invalid input.

Enqueue one eligible image job and assert:

```ts
assert.deepEqual(job.paid_image_replacement?.policy, {
  enabled: true,
  wait_minutes: 30,
  max_replacements_per_asset: 1,
  additional_credit_ceiling: 50,
  snapshotted_at: clock.iso,
})
assert.equal('paid_image_replacement' in job.params, false)
```

Enqueue audio/video and assert no paid-image policy is attached. Add source/behavior tests proving neither setting key appears in project config, `usePresets` payloads, generator presets, pipeline presets, or stored-preset rewrite logic.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings
```

Expected: setting functions, route, and job fields are absent.

- [ ] **Step 3: Add strict settings and additive contracts**

Use one JSON app-setting record:

```ts
export const PAID_IMAGE_REPLACEMENT_KEY = 'paid_image_replacement'
export const PAID_IMAGE_REPLACEMENT_DEFAULT = {
  enabled: false,
  additional_credit_ceiling: null,
} as const
```

Reject an enabled record without a positive safe whole-number ceiling. Do not supply a credit default. Add `GET /app-settings/recovery` and `PUT /app-settings/recovery`; no route call starts, retries, or cancels a job.

Add the exact spec interfaces to server/renderer Job contracts. The bounded attempt list lives at `job.paid_image_replacement.attempts`; provider IDs remain visible only under existing Technical details serialization.

- [ ] **Step 4: Snapshot only on eligible production enqueue**

In async `enqueue()`, read the machine setting once for `continuity_render`, `image_pool_generate`, or `thumb_images`, construct the fixed policy snapshot, and pass it to synchronous `enqueuePrepared()` through a server-only `EnqueueOptions` field. Test insertion can inject the field explicitly. Do not read settings in a generator or accept the snapshot from `params`/HTTP request bodies.

Current machine Off remains a future submission veto, but it does not mutate historical snapshots.

- [ ] **Step 5: Run GREEN and preset residual scan**

```bash
node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings

rg -n "paid_image_replacement" \
  frontend/composables/usePresets.ts \
  frontend/pages/projects \
  electron/server/services/project-manager.ts
```

Expected: focused tests pass; production matches are limited to the machine settings surface and explicit job projection, with no preset/project-config storage.

- [ ] **Step 6: Commit and independent product-boundary review**

```bash
git add electron/server/services/app-settings.ts \
  electron/server/routes/app-settings.ts \
  electron/server/models/types.ts \
  electron/server/contracts/index.ts \
  electron/server/services/job-queue.ts \
  electron/server/__tests__/paid-image-replacement-settings.test.ts
git commit -m "feat: add bounded paid image recovery setting"
```

Reviewer checks defaults, invalid writes, server-owned snapshot, preset exclusion, and zero audio/video attachment. Resolve findings before Task 4.

---

### Task 4: Build the terminal, quote, ceiling, and idempotency gate

**Files:**
- Create: `electron/server/services/image-paid-replacement.ts`
- Create: `electron/server/__tests__/paid-image-replacement-policy.test.ts`
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/services/task-manifest.ts`

**Interfaces:**
- Consumes: shared terminal/settlement predicates, `tryRecoverImageFromManifestEntry`/control lookup, `resolveImageRetryScope`, `listImageModelsSnapshot`, `refreshGenStudioAdmission`, `recordTaskStrict`, and `checkpointJobState`.
- Produces:

```ts
export interface PaidImageReplacementCandidate {
  assetKey: string
  outputPath: string
  modelId: string
  outputOptionId: string | null
  referenceGuided: boolean
  inputHash: string
  manifestEntry: TaskManifestEntry
  terminalEvidence: NonNullable<Job['genstudio_jobs']>[number]
}

export type PaidImageReplacementDecision =
  | { action: 'not-eligible'; reason: string }
  | { action: 'wait'; eligibleAt: string }
  | { action: 'recover-original' }
  | { action: 'safe-zero-settlement-retry' }
  | { action: 'commit'; attempt: PaidImageReplacementAttempt; scope: string }
  | { action: 'blocked'; reason: string }

export async function decidePaidImageReplacement(
  job: Job,
  candidate: PaidImageReplacementCandidate,
  now?: Date,
): Promise<PaidImageReplacementDecision>
```

- [ ] **Step 1: Write the RED decision table**

Table-drive every state from the spec. Minimum assertions:

```ts
assert.equal((await decide(running)).action, 'recover-original')
assert.equal((await decide(submissionUncertain)).action, 'blocked')
assert.equal((await decide(zeroSettledFullyReleased)).action, 'safe-zero-settlement-retry')
assert.equal((await decide(positiveSettledAtMinute29)).action, 'wait')
assert.equal((await decide(positiveSettledAtMinute30)).action, 'commit')
assert.equal((await decide(missingSettlement)).action, 'blocked')
assert.equal((await decide(contentRefusal)).action, 'blocked')
assert.equal((await decide(settingOff)).action, 'blocked')
assert.equal((await decide(priceExceedsCeiling)).action, 'blocked')
```

Also prove live catalogue failure/stale fallback/missing price/missing price version/model removal/unverified balance block; a valid artifact appearing during wait returns recovery/completion rather than commit; two calls for the same asset return the same durable attempt/scope; a second asset cannot push committed quote sum over the job ceiling; one replacement per asset remains enforced after restart serialization.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-policy
```

Expected: helper and force-live price reader do not exist.

- [ ] **Step 3: Add one force-live image catalogue read**

In `genstudio-client.ts`, add a narrow function that invalidates only the current image-catalog cache key, performs the existing shared refresh, and returns `GenStudioCatalogSnapshot<GenStudioImageModel[]>`. It must reject unless `freshness === 'live'`; stale fallback is not a quote.

Do not create a price table. Resolve the selected model and exact output/reference option from the returned row and require non-negative `credits_per_image`, `chargeable !== false`, and non-empty `price_version`. A non-chargeable zero-cost product stays on normal retry, not paid replacement.

- [ ] **Step 4: Implement the fail-closed shared gate**

Implement the decision order exactly:

1. validate eligible image job policy and current machine On;
2. validate stable asset/manifest/input identity;
3. recover/re-read the original task and preserve same-task work;
4. require `failed`, exact retryable infrastructure code, and balanced finite settlement;
5. route exact zero settlement/full release to existing safe retry;
6. persist `terminal_observed_at` once and return `wait` until `+30m`;
7. re-audit output at due time;
8. force live product/price and fresh verified account balance/capacity;
9. enforce one attempt and conservative committed-credit sum;
10. derive one fresh deterministic scope from the original terminal task ID;
11. append `state: 'committed'` synchronously, then `checkpointJobState(job)` and `recordTaskStrict(...)` before returning `commit`.

If either durable write fails, return/throw before POST. On re-entry, reconcile the job attempt and manifest binding by copying the same deterministic scope to the missing side; never POST until both durable records agree. The in-memory commitment may remain and conservatively consume budget until the job reloads; it must never lead to uncheckpointed spend.

- [ ] **Step 5: Extend the manifest additively**

Add optional fields only:

```ts
replacement_of_task_id?: string
replacement_scope?: string
replacement_quoted_credits?: number
replacement_price_version?: string
replacement_committed_at?: string
```

Existing manifests remain schema version 1 and readable. Do not migrate or rewrite entries until that asset is legitimately updated.

- [ ] **Step 6: Run GREEN and billing regression**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-policy \
  --only image-route-exhausted-retry \
  --only genstudio-image-integration \
  --only genstudio-release-qualification
```

Expected: complete decision matrix green, exact existing zero-charge retry unchanged, and no duplicate-scope regression.

- [ ] **Step 7: Commit and independent billing/idempotency review**

```bash
git add electron/server/services/image-paid-replacement.ts \
  electron/server/lib/genstudio-client.ts \
  electron/server/services/task-manifest.ts \
  electron/server/__tests__/paid-image-replacement-policy.test.ts
git commit -m "feat: gate paid image replacement"
```

Reviewer traces every path to POST, balanced settlement math, live-price provenance, current Off veto, concurrent ceiling commitment, durable-before-POST ordering, restart identity, and one-attempt limit. Resolve every Critical/High/Important finding before Task 5.

---

### Task 5: Wire the shared gate into recovery-capable image generators

**Files:**
- Create: `electron/server/__tests__/paid-image-replacement-integration.test.ts`
- Modify: `electron/server/generators/continuity-render.ts`
- Modify: `electron/server/generators/images.ts`
- Modify: `electron/server/generators/image-pool-generate.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test: `electron/server/__tests__/job-queue-genstudio-resume.test.ts`
- Test: `electron/server/__tests__/image-route-exhausted-retry.test.ts`

**Interfaces:**
- Consumes: Task 4’s `decidePaidImageReplacement`, existing generator manifest/recovery functions, `checkpointJobState`, normal queue admission, and job persistence.
- Produces: one same-job waiting/rejoin lifecycle and a generator callback that submits only a previously committed scope.

- [ ] **Step 1: Write RED end-to-end crash and modality tests**

For each supported generator family—Continuity, Image Pool, and `generateImages` thumbnails—cover:

1. terminal positive-settlement infrastructure failure records waiting at T and zero replacement POSTs before T+30m;
2. elapsed 30m with original status changed back to nonterminal/unknown produces zero replacement POSTs;
3. due + valid terminal/settlement/live quote/budget submits exactly one deterministic replacement key;
4. crash before commitment, between the job and manifest commitment writes, after both commitments before POST, after POST before accepted callback, after accepted callback before artifact, and after artifact before completion audit produces at most one replacement task identity;
5. a usable file appearing during wait completes without replacement;
6. partial batch replacement touches only the missing asset;
7. replacement failure records terminal evidence and never chains another paid attempt;
8. queue pause/cancel/current setting Off prevents not-yet-submitted replacement;
9. audio, transcription, music, and video fixtures create no paid-image attempt and no replacement POST;
10. unsupported image surfaces remain manual.

Use injected clocks/deferred promises and mock GenStudio calls; no 30-minute sleep.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-integration \
  --only job-queue-genstudio-resume \
  --only image-route-exhausted-retry
```

Expected: paid waiting/commit paths are absent while existing safe recovery remains green.

- [ ] **Step 3: Add one typed paid-wait result to the queue lifecycle**

Use a narrow typed signal from the generator when Task 4 returns `wait`. `runJob` must keep the same job active for duplicate-lock purposes, set `finished_at: null`, persist/emit the waiting attempt, release the image lane in `finally`, and schedule one due callback from durable `eligible_at`.

The callback:

- performs no provider call;
- checks that the job is still active, not cancelled/paused, and still has the waiting attempt;
- durably transitions the same job back to `queued`, inserts it into its type’s recovery FIFO once, and rolls the in-memory transition back if persistence fails;
- calls the normal image group pump.

On boot, reconstruct only these due callbacks from active persisted jobs. Use a per-job timeout map with injectable clock/timer seams; this is a bounded wake-up mechanism, not a polling service. Repeated scheduling replaces/ignores the same job ID. Clearing/cancelling/terminalizing a job clears its timer.

- [ ] **Step 4: Wire each generator after existing recovery**

At the current terminal-failure branch in each supported generator:

1. let same-task recovery run first;
2. let exact zero-settlement/full-release retry run second;
3. call the shared paid decision only for the remaining exact terminal infrastructure case;
4. on `wait`, persist and yield to the queue lifecycle;
5. on `commit`, submit using only the returned persisted scope/idempotency key;
6. on accepted/state/settlement updates, update the existing manifest and job attempt;
7. validate/download under the original expected filename/input hash;
8. run the existing complete/missing audit.

Do not add paid logic to the GenStudio client’s generic retry loop; modality and customer authorization belong at the image asset boundary.

- [ ] **Step 5: Feed tail admission from existing checkpoints**

Ensure supported image generators call `checkpointJobState(job)` whenever `item_progress` crosses into or out of the final accepted wave. `recordGenStudioJob` already fires for accepted/state changes; do not add a second progress event bus. The queue’s Task 2 single-flight check remains the only overflow authority.

- [ ] **Step 6: Run GREEN and full adjacent recovery suite**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-integration \
  --only paid-image-replacement-policy \
  --only adaptive-image-tail-overlap \
  --only job-queue-genstudio-resume \
  --only image-route-exhausted-retry \
  --only genstudio-image-integration \
  --only genstudio-release-qualification \
  --only no-new-wallclock-sleeps
```

Expected: all crash boundaries produce at most one replacement identity, completed files are preserved, unsupported modalities submit nothing, and no real-time wait is introduced.

- [ ] **Step 7: Commit and independent recovery review**

```bash
git add electron/server/generators/continuity-render.ts \
  electron/server/generators/images.ts \
  electron/server/generators/image-pool-generate.ts \
  electron/server/services/job-queue.ts \
  electron/server/__tests__/paid-image-replacement-integration.test.ts
git commit -m "feat: recover failed image assets once"
```

Reviewer verifies provider calls occur only inside admitted executors, wait callbacks never call providers, same-task recovery precedes fresh identity, artifacts survive, timer reload is idempotent, and no audio/video path imports the helper. Resolve findings before Task 6.

---

### Task 6: Add explicit settings and Jobs visibility

**Files:**
- Create: `frontend/__tests__/paidImageRecoverySettings.test.ts`
- Modify: `frontend/components/ThisMacSettings.vue`
- Modify: `frontend/pages/projects/[slug]/jobs.vue`
- Test: existing `frontend/__tests__/jobsControls.test.ts`

**Interfaces:**
- Consumes: `GET/PUT /app-settings/recovery`, renderer `Job.paid_image_replacement`, existing API composable, native settings fields, Jobs card/status components, and SSE updates.
- Produces: accessible Off/On + ceiling controls and one compact job recovery-state projection.

- [ ] **Step 1: Write RED source/behavior tests**

Assert initial GET renders Off with empty/no-guessed ceiling, enabling without a positive whole number blocks PUT, valid save sends exactly:

```ts
{
  paid_image_replacement: {
    enabled: true,
    additional_credit_ceiling: 50,
  },
}
```

Assert the panel includes the exact facts `30 minutes`, `one replacement per image`, and wording that time alone never proves a task stopped. Assert it contains no audio/video toggle and no preset save/apply call.

For Jobs fixtures assert customer-safe waiting, committed, blocked, submitted, and settled copy; no internal task/idempotency IDs outside Technical details; actual settlement is distinct from committed quote.

- [ ] **Step 2: Run RED**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/paidImageRecoverySettings.test.ts \
  __tests__/jobsControls.test.ts
cd ..
```

Expected: new settings and card states are absent.

- [ ] **Step 3: Implement the smallest settings panel**

Add one section to `ThisMacSettings.vue` with:

- native labeled checkbox/switch;
- numeric input using `min="1"`, `step="1"`, required only when enabled;
- inline validation before PUT;
- fixed explanatory copy from the spec;
- disabled/busy Save and an `aria-live="polite"` result;
- server response applied back to the form.

Do not add a component library, composable, or modal. Keep the setting independent from concurrency save so a validation error cannot block unrelated settings.

- [ ] **Step 4: Render additive Jobs state**

Read the latest bounded attempt and render one compact status line. Use existing time/credit formatters and Technical details disclosure. Do not add a new Jobs filter or reorder cards. Preserve all existing controls, pagination, SSE, and customer-language redaction.

- [ ] **Step 5: Run GREEN and build**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/paidImageRecoverySettings.test.ts \
  __tests__/jobsControls.test.ts
cd ..
npm run build
```

Expected: focused UI tests and production build pass.

- [ ] **Step 6: Rendered accessibility QA**

Run the app against test fixtures only—no live image submission. Inspect This Mac settings and Project/All Jobs at desktop, approximately 390 px, and 200% zoom for:

- Off default;
- invalid enabled-without-ceiling state;
- saved On + ceiling;
- waiting, blocked, committed, submitted, and settled cards;
- visible keyboard focus, readable labels/errors, no horizontal overflow, no clipped controls, and no spending control receiving initial focus.

Capture screenshots or record exact observed dimensions/states in the PR evidence. Fix visual defects and repeat the focused UI test/build.

- [ ] **Step 7: Commit and independent UX review**

```bash
git add frontend/components/ThisMacSettings.vue \
  frontend/pages/projects/[slug]/jobs.vue \
  frontend/__tests__/paidImageRecoverySettings.test.ts
git commit -m "feat: expose paid image recovery controls"
```

Reviewer checks spend wording, no false safety/free claim, keyboard/focus, narrow layout, actual-versus-quoted credits, and preset isolation. Resolve findings before Task 7.

---

### Task 7: Version v1.4.91 and run complete release verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Test: full repository release gates

**Interfaces:**
- Consumes: all completed tasks and repository release scripts.
- Produces: consistent v1.4.91 release metadata and reproducible verification evidence.

- [ ] **Step 1: Bump all version surfaces**

Set exactly `1.4.91` in `package.json`, `package-lock.json` root `version`, and `package-lock.json` root package `version`. Add newest-first `## v1.4.91 — 2026-08-31` customer-facing changelog bullets that say:

- image episodes can overlap by one only when the current episode is in a confirmed final wave and GenStudio reports room;
- paid image replacement is optional, Off by default, waits after confirmed failure, obeys the customer’s credit ceiling, and never retries from elapsed time alone;
- audio and video behavior is unchanged.

Do not claim guaranteed speedup, no duplicate charges, free retry, or worker loss.

- [ ] **Step 2: Run release-integrity checks**

```bash
npm run check:changelog
git diff --check
```

Expected: version/changelog alignment and whitespace checks pass.

- [ ] **Step 3: Run the complete release gate**

```bash
npm run verify
```

Expected: the unfiltered repository verification suite exits 0. A filtered `PARTIAL RUN` is not acceptable evidence.

- [ ] **Step 4: Re-run the financial/concurrency focus after full verify**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only adaptive-image-tail-overlap \
  --only paid-image-replacement \
  --only genstudio-admission \
  --only image-route-exhausted-retry \
  --only genstudio-image-integration \
  --only job-queue-genstudio-resume
```

Expected: focused files pass with no zero-test match. This remains supplemental to Step 3.

- [ ] **Step 5: Final independent review**

Provide the spec, plan, complete diff, RED/GREEN evidence, `npm run verify` output, rendered QA evidence, and residual searches to an independent reviewer. Require explicit review of:

- base+one race safety and fresh capacity provenance;
- per-type round-robin/recovery-first FIFO with no SRTF;
- terminal/settlement/live-price/current-setting/ceiling gates;
- durable-before-POST and crash identity;
- artifact preservation/completion audit;
- no preset, audio, or video delivery;
- version/changelog and UX wording.

Resolve every finding, rerun affected focused tests, then rerun `npm run verify` if production code changed.

- [ ] **Step 6: Commit the release surfaces**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release Story Studio v1.4.91"
```

Confirm `git status --short` is clean and the branch contains only reviewed implementation/release commits.

---

### Task 8: Integrate through PR and build the smoke DMG from main

**Files:**
- No source edits expected after the verified release commit.
- Artifact after merge: `dist/Story Studio KH-1.4.91-arm64.dmg` in the main checkout, using the repository’s exact Electron Builder filename if punctuation differs.

**Interfaces:**
- Consumes: verified clean feature branch and repository standing integration authorization.
- Produces: merged PR, synchronized clean `main`, and verified main-built v1.4.91 smoke DMG.

- [ ] **Step 1: Push and create/update the PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
```

If a PR already exists, use `gh pr view` and update its body rather than creating another. Include spec/plan paths, safety invariants, `npm run verify`, focused tests, rendered QA, and independent review evidence.

- [ ] **Step 2: Wait for clean checks/review/mergeability**

```bash
gh pr checks --watch
gh pr view --json mergeStateStatus,reviewDecision,statusCheckRollup
```

Expected: required checks pass, review is resolved, and merge state is clean. Do not merge while any check, review, or mergeability state is unresolved. Never force-push.

- [ ] **Step 3: Merge and synchronize main**

```bash
gh pr merge --merge --delete-branch
git -C /build/Developer/story-studio-kh pull --ff-only origin main
```

Verify the merge commit contains v1.4.91 and the main checkout is clean before packaging.

- [ ] **Step 4: Build from main only**

```bash
cd /build/Developer/story-studio-kh
npm run dist:smoke
```

Do not copy a worktree-built artifact into main. This is the unsigned smoke build; do not run `dist:public`, sign, notarize, publish, upload, install, or tag.

- [ ] **Step 5: Verify artifact identity**

```bash
cd /build/Developer/story-studio-kh
find dist -maxdepth 1 -type f -name '*1.4.91*arm64*.dmg' -print
node -p "require('./package.json').version"
story_v1491_extract=$(mktemp -d)
npx asar extract dist/mac-arm64/'Story Studio KH.app'/Contents/Resources/app.asar "$story_v1491_extract"
node -p "require('$story_v1491_extract/package.json').version"
git status --short
```

Expected: one versioned arm64 DMG is present, main package and bundled `app.asar` both report `1.4.91`, and source status is clean. If the app bundle path differs, resolve the actual main-built path with `find dist -path '*Story Studio KH.app/Contents/Resources/app.asar' -print` and inspect that exact file.

- [ ] **Step 6: Cleanup and handoff**

Remove only the merged `adaptive-image-queue-recovery` worktree/local branch after merge, main sync, DMG proof, and clean-status checks. Report:

- PR and merge commit;
- v1.4.91 version/changelog;
- exact verification commands/results;
- independent review outcome;
- rendered QA states;
- exact DMG path and bundled version;
- deliberate exclusions: audio/video paid recovery, unsupported image surfaces, SRTF, more than one overflow, dependencies, public publish/install/tag.

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 cover explicit base lanes, one settling-only overflow, authoritative capacity, per-type round-robin/two-class FIFO, no SRTF, and completion bias. Tasks 3–6 cover Off-by-default image-only authorization, fixed wait, ceiling, preset boundary, settlement/live-price/idempotency guards, artifacts, restart, UX, and no audio/video delivery. Tasks 7–8 cover v1.4.91, changelog, full verification, independent review, PR/merge, main sync, and main-built DMG.
- **Ponytail check:** One existing queue, one ephemeral cursor, one single-flight capacity read, one shared image policy helper, existing job/manifest state, existing app settings, and bounded per-job due timers. No dependency, database, generic scheduler, priority queue, pricing cache, provider router, or cross-modality abstraction.
- **Completeness scan:** Every task names its exact inputs, outputs, tests, commands, and stopping conditions. Unsupported surfaces are explicit non-goals, not hidden steps inside this release.
- **Type consistency:** `PaidImageReplacementSetting`, `PaidImageReplacementPolicySnapshot`, `PaidImageReplacementAttempt`, `PaidImageReplacementCandidate`, `PaidImageReplacementDecision`, `decidePaidImageReplacement`, `isSettlingImageTail`, `requestAdaptiveImageTailAdmission`, and `pumpImageEpisodeGroup` use the same names and responsibilities throughout.

## Execution Handoff

Execute with `superpowers:subagent-driven-development` for fresh task-level implementation and independent review, or `superpowers:executing-plans` for sequential inline batches with checkpoints. Do not run parallel implementers against `job-queue.ts`, the shared image generators, app-settings contracts, or release surfaces.
