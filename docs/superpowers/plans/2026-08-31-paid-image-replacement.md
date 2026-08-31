# Paid Image Replacement v1.4.92 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before any completion claim.

**Goal:** Ship Story Studio KH v1.4.92 with an Off-by-default image-only option that can buy at most one replacement per asset, 30 minutes after authoritative terminal failure, within a required per-Story-job additional-credit ceiling.

**Architecture:** Build on merged v1.4.91. Keep the same durable Story job, image asset identity, recovery checkpoint, task manifest, queue, GenStudio task control/settlement, and completion auditors. Add one machine-local setting, one snapshotted policy, an exact image output selector, one pure fail-closed eligibility/quote decision, one durable paid-wait branch that precedes generic restart terminalization, and one bounded per-job timer. Persist matching commitment identity in the job and manifest before POST; submit only through existing admission. Add no dependency, database, scheduler framework, provider retry loop, or audio/video behavior.

**Tech Stack:** Node/Express, TypeScript, Vue 3/Nuxt 4, atomic JSON jobs/manifests, GenStudio live catalogue/control/admission, `node:test`/`tsx`, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-08-31-paid-image-replacement-design.md`

## Starting Evidence

- Required worktree: `.worktrees/adaptive-image-queue-recovery`
- Required base: the exact synchronized `main` commit containing merged v1.4.91. Resolve and record the SHA before editing; do not begin from the original v1.4.90 base.
- Existing queue/restart owner: `electron/server/services/job-queue.ts`, especially `readPersistedJobs()`.
- Existing app setting store/routes: `electron/server/services/app-settings.ts` and `electron/server/routes/app-settings.ts`.
- Existing recovery identity: `params.genstudio_recovery.assets`, `electron/server/services/task-manifest.ts`, and `job.genstudio_jobs`.
- Existing image pricing fields: output rows expose `resolution`, `aspect_ratio`, `width`, `height`, `credits_per_image`, `price_version`, `reference_generation_credits`, and `reference_generation_price_version`; model rows expose the reference pair as a fallback only.
- Existing image price selection behavior: `frontend/utils/genstudio-credit-cost.ts`.
- Supported generators: `continuity_render`, `image_pool_generate`, and `thumb_images` through `electron/server/generators/images.ts`.

Before edits, re-read `AGENTS.md`, the spec, `docs/architecture/security-reliability.md`, merged v1.4.91 behavior, and `git status`. Preserve unrelated work and use only isolated temporary job/project roots in tests.

Establish focused baselines:

```bash
node scripts/testing/run-backend-tests.mjs \
  --only job-queue-genstudio-resume \
  --only image-route-exhausted-retry \
  --only genstudio-image-integration \
  --only genstudio-release-qualification \
  --only task-manifest-race

cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/settingsThroughput.test.ts \
  __tests__/jobsControls.test.ts \
  __tests__/usePresets.test.ts
cd ..
```

These are partial baselines, not release acceptance.

## Global Constraints

- The setting is machine-local, image-only, and Off by default. It never enters project config, generator/pipeline presets, saved preset payloads, or preset migrations.
- Enabling requires a positive safe whole-number `additional_credit_ceiling`; the fixed wait is 30 minutes and max is one replacement per asset.
- Eligible jobs snapshot policy outside request-controlled `params`. Current machine Off remains a commitment veto. A later global ceiling increase never raises an existing snapshot.
- Elapsed time alone never authorizes replacement. The original task must have fresh authoritative `failed` evidence, an allow-listed transient infrastructure failure, and finite balanced settlement with positive settled credits.
- Unknown/nonterminal/uncertain submission, refusal, validation, cancellation, auth, billing, missing/imbalanced settlement, missing artifact identity, or unavailable price fails closed.
- There is no `outputOptionId`. Persist and match `{resolution, aspect_ratio, width, height, reference_mode}` exactly.
- Normal requests use the matching output row’s normal price/version. Reference-guided requests use its reference price/version, or the model-level reference pair only when the row omits both. Missing half-pairs, zero/multiple matches, or mixed price modes block.
- Force a live image catalogue refresh and fresh verified account state immediately before commitment. Never use stale fallback or invent a price.
- Persist the same deterministic replacement scope in job and manifest before POST. Do not POST until both agree.
- `readPersistedJobs()` must recognize valid durable paid wait after explicit pause handling and before ordinary recovery, cancellation reconciliation, or generic interrupted-running terminalization.
- Boot/timer code may only preserve or durably queue the same Story job. It never calls GenStudio.
- Clear the in-memory timer on cancel, pause, clear, terminalization, commitment/requeue, or invalidated wait. Preserve durable evidence and artifacts.
- Reuse merged v1.4.91 queue/admission primitives. Do not change its fairness/tail contract.
- Deliver no audio/video paid recovery and no unsupported image surface.
- Every behavior task is RED, observed intended failure, minimal implementation, focused GREEN, then independent review.
- Release v1.4.92 independently: separate branch/PR/merge/full verification/main-built DMG after v1.4.91.

## Required Contracts

```ts
interface PaidImageReplacementSetting {
  enabled: boolean
  additional_credit_ceiling: number | null
}

interface PaidImageReplacementPolicySnapshot {
  enabled: boolean
  wait_minutes: 30
  max_replacements_per_asset: 1
  additional_credit_ceiling: number | null
  snapshotted_at: string
}

interface PaidImageOutputSelector {
  resolution: string
  aspect_ratio: string
  width: number
  height: number
  reference_mode: 'normal' | 'reference-guided'
}

interface PaidImageReplacementAttempt {
  asset_key: string
  state: 'waiting' | 'committed' | 'submitted' | 'succeeded' | 'failed' | 'blocked'
  original_task_id: string
  original_idempotency_key: string
  input_hash: string
  output_selector: PaidImageOutputSelector
  failure_code: string
  reserved_credits: number
  settled_credits: number
  released_credits: number
  terminal_observed_at: string
  eligible_at: string
  quoted_credits?: number
  price_version?: string
  replacement_scope?: string
  replacement_task_id?: string
  actual_settled_credits?: number
  reason?: string
}
```

## File Map

| File | Responsibility |
|---|---|
| `electron/server/services/app-settings.ts` | Strict Off default and validated machine setting. |
| `electron/server/routes/app-settings.ts` | GET/PUT machine recovery setting; no operational side effect. |
| `electron/server/models/types.ts` | Server policy, selector, attempt, and paid-wait types. |
| `electron/server/contracts/index.ts` | Additive renderer-visible job projection. |
| `electron/server/services/job-queue.ts` | Server-owned policy snapshot, durable paid-wait predicate, boot precedence, bounded timers, same-job recovery FIFO requeue, cleanup. |
| `electron/server/services/image-paid-replacement.ts` | Shared terminal/settlement/selector/live-price/ceiling/idempotency decision and commitment helper. |
| `electron/server/lib/genstudio-client.ts` | Narrow forced-live image catalogue read; reuse control/admission/settlement. |
| `electron/server/services/task-manifest.ts` | Additive replacement binding beside original asset identity. |
| `electron/server/generators/continuity-render.ts` | Shared paid gate after same-task and zero-settlement recovery. |
| `electron/server/generators/image-pool-generate.ts` | Same shared gate for durable pool assets; keep internal concurrency serial. |
| `electron/server/generators/images.ts` | Same shared gate for durable thumbnail assets only. |
| `frontend/components/ThisMacSettings.vue` | Off/On, required ceiling, fixed wait/max explanatory contract. |
| `frontend/pages/projects/[slug]/jobs.vue` | Waiting/committed/blocked/submitted/settled visibility. |
| `electron/server/__tests__/paid-image-replacement-settings.test.ts` | Defaults, validation, route, snapshot, modality, and preset boundary. |
| `electron/server/__tests__/paid-image-replacement-policy.test.ts` | Terminal, settlement, selector, live price, balance, ceiling, and durable identity matrix. |
| `electron/server/__tests__/paid-image-replacement-boot.test.ts` | `readPersistedJobs` precedence, before/after-due boot, duplicate delivery, and cleanup. |
| `electron/server/__tests__/paid-image-replacement-integration.test.ts` | Generator families, crash boundaries, artifacts, and unsupported modalities. |
| `frontend/__tests__/paidImageRecoverySettings.test.ts` | Settings/Jobs UI and preset isolation. |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | v1.4.92 release surfaces. |

---

### Task 1: Add the machine policy and keep it out of presets

**Files:**
- Create: `electron/server/__tests__/paid-image-replacement-settings.test.ts`
- Modify: `electron/server/services/app-settings.ts`
- Modify: `electron/server/routes/app-settings.ts`
- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/contracts/index.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test/read only: `frontend/composables/usePresets.ts`

- [ ] **Step 1: Write RED defaults and validation tests**

Assert absent or malformed storage returns exactly:

```ts
{ enabled: false, additional_credit_ceiling: null }
```

Assert enabled without a positive safe whole-number ceiling rejects without overwriting the prior valid value. Cover zero, negative, fractional, numeric string, `NaN`, infinity, and values above `Number.MAX_SAFE_INTEGER`. Disabled may store null or a valid retained ceiling, but never silently invent one.

Route GET/PUT must echo the actual validated stored record and return 400 for invalid writes. It must not enqueue, retry, cancel, or call a provider.

- [ ] **Step 2: Write RED job-snapshot and boundary tests**

Enqueue each supported image type with injected setting state and assert the server creates a policy snapshot outside `params` with fixed wait/max and timestamp. Enqueue audio, transcription, music, video, local, and unsupported image fixtures and assert no paid-image policy is attached.

Add behavior/source tests proving the setting key does not enter project config, generator presets, pipeline presets, `usePresets` save/apply payloads, or preset migrations. No existing stored preset is rewritten.

- [ ] **Step 3: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings
```

- [ ] **Step 4: Implement strict setting and server-owned snapshot**

Reuse the app-setting JSON store with one key and strict parser. Add the smallest existing app-settings route extension. In async production enqueue, read the machine setting once only for `continuity_render`, `image_pool_generate`, and `thumb_images`; pass the sanitized snapshot to synchronous queue insertion through a server-only option. Never accept policy from request `params` or generator input.

Add the contracts above to server/renderer job types. Keep attempt lists bounded by the existing per-asset maximum. Current machine Off is checked again only before commitment, not used to erase old evidence.

- [ ] **Step 5: Run GREEN and preset scan**

```bash
node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings

rg -n "paid_image_replacement" \
  frontend/composables/usePresets.ts \
  electron/server/services/project-manager.ts \
  frontend/pages/projects
```

Inspect matches: only the explicit machine settings and Jobs projection are allowed; no preset/project-config persistence is allowed.

- [ ] **Step 6: Commit and independently review**

```bash
git add electron/server/services/app-settings.ts \
  electron/server/routes/app-settings.ts \
  electron/server/models/types.ts \
  electron/server/contracts/index.ts \
  electron/server/services/job-queue.ts \
  electron/server/__tests__/paid-image-replacement-settings.test.ts
git commit -m "feat: add bounded paid image recovery setting"
```

Review defaults, invalid-write preservation, eligible modalities, server ownership, preset exclusion, and no operational route side effect. Resolve findings before Task 2.

---

### Task 2: Resolve the exact selector and live published rate

**Files:**
- Create: `electron/server/services/image-paid-replacement.ts`
- Create: `electron/server/__tests__/paid-image-replacement-policy.test.ts`
- Modify: `electron/server/lib/genstudio-client.ts`
- Read/regress: `frontend/utils/genstudio-credit-cost.ts`

**Contract:** The candidate carries `PaidImageOutputSelector`, never an option ID. The live quote helper must match exactly one output row on `resolution`, `aspect_ratio`, `width`, and `height`, then select the price/version pair indicated by `reference_mode`.

- [ ] **Step 1: Write RED selector and price matrix**

Cover:

- exact unique normal row returns that row’s `credits_per_image` and `price_version`;
- exact unique reference-guided row returns row reference credits/version;
- reference-guided row omitting both reference fields may use the model reference pair;
- row/model reference half-pair blocks;
- zero matches, duplicate matches, mismatched dimension/aspect/resolution, missing normal pair, model removed, or non-chargeable product blocks;
- normal mode never takes reference fields; reference-guided mode never takes normal fields;
- stale/fallback/unavailable catalogue blocks;
- selector must equal original manifest/request facts.

Use two deliberately similar output rows so the test proves all four fields participate in matching.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-policy
```

- [ ] **Step 3: Add one forced-live catalogue read**

In `genstudio-client.ts`, add a narrow function that invalidates only the relevant image catalogue cache key, invokes the existing refresh, and rejects unless the returned freshness is `live`. Do not create a local price table or quote endpoint abstraction.

Implement one pure selector matcher and price-pair resolver in `image-paid-replacement.ts`. Require finite nonnegative credits, a non-empty price version, exact request/manifest selector equality, and exactly one output row. Label returned values as published rate/version; actual settlement is a separate field.

- [ ] **Step 4: Run GREEN and adjacent price tests**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-policy \
  --only genstudio-image-integration \
  --only genstudio-release-qualification
```

- [ ] **Step 5: Commit and independently review**

```bash
git add electron/server/services/image-paid-replacement.ts \
  electron/server/lib/genstudio-client.ts \
  electron/server/__tests__/paid-image-replacement-policy.test.ts
git commit -m "feat: quote exact paid image replacements"
```

Reviewer verifies there is no `outputOptionId`, stale price, mixed normal/reference pair, ambiguous row, or invented fallback. Resolve findings before Task 3.

---

### Task 3: Create the terminal, settlement, ceiling, and durable commitment gate

**Files:**
- Modify: `electron/server/services/image-paid-replacement.ts`
- Modify: `electron/server/__tests__/paid-image-replacement-policy.test.ts`
- Modify: `electron/server/services/task-manifest.ts`

**Contract:** Expose one decision function whose terminal/settlement checks precede time:

```ts
type PaidImageReplacementDecision =
  | { action: 'not-eligible'; reason: string }
  | { action: 'recover-original' }
  | { action: 'safe-zero-settlement-retry' }
  | { action: 'wait'; attempt: PaidImageReplacementAttempt }
  | { action: 'commit'; attempt: PaidImageReplacementAttempt; scope: string }
  | { action: 'blocked'; reason: string }
```

- [ ] **Step 1: Write RED eligibility and settlement tests**

Table-drive original task states and settlement. Require fresh control `failed`, an exact allow-listed transient infrastructure/fleet code, real task/idempotency/hash/output identity, finite nonnegative credits, and `reserved = settled + released`.

Prove running/queued/unknown tasks recover original; uncertain submission blocks; cancellation/refusal/validation/auth/billing blocks; missing/imbalanced/nonfinite settlement blocks; exact zero settlement with full release uses only existing safe retry; positive settlement writes a durable wait. Elapsing 30 minutes without terminal evidence must still produce zero replacement POSTs.

Prove `terminal_observed_at` is written once and `eligible_at` is exactly +30 minutes; repeated evaluation cannot move either clock.

- [ ] **Step 2: Write RED ceiling and commitment tests**

At due time, re-read terminal evidence, re-audit output, require current setting On, call Task 2’s live price helper, and require fresh verified account state. Assert:

- artifact appearing during wait returns recovery/completion with no commitment;
- selected price above remaining job ceiling blocks;
- conservative sum includes every committed/submitted/succeeded/failed replacement quote;
- concurrent assets cannot commit over the ceiling;
- one asset cannot receive a second paid attempt;
- replacement failure cannot chain;
- repeated calls derive the same replacement scope for the same original task/asset.

- [ ] **Step 3: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-policy
```

- [ ] **Step 4: Implement fail-closed decision order**

Reuse the existing same-task recovery and zero-settlement predicates first. For positive settlement, persist one waiting attempt with immutable observed/due times. At due, rerun every identity/terminal/settlement/artifact/setting/price/account/ceiling condition before deriving a deterministic fresh scope from original terminal task identity.

Append `state: 'committed'` and its published credits/version/scope to the job, then durably checkpoint the job and write matching manifest binding before returning `commit`. No helper caller may POST before both durable records agree. On interrupted dual-write, re-entry repairs only the missing side using the same scope and never allocates a new scope.

Extend manifest entries additively:

```ts
replacement_of_task_id?: string
replacement_scope?: string
replacement_quoted_credits?: number
replacement_price_version?: string
replacement_committed_at?: string
```

Keep the current manifest schema version readable; do not bulk migrate or rewrite unrelated entries.

- [ ] **Step 5: Run GREEN and billing/idempotency regression**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-policy \
  --only image-route-exhausted-retry \
  --only genstudio-image-integration \
  --only genstudio-release-qualification \
  --only task-manifest-race
```

- [ ] **Step 6: Commit and independently review**

```bash
git add electron/server/services/image-paid-replacement.ts \
  electron/server/services/task-manifest.ts \
  electron/server/__tests__/paid-image-replacement-policy.test.ts
git commit -m "feat: commit paid image replacements safely"
```

Reviewer traces every condition to commitment, settlement arithmetic, one-attempt/ceiling concurrency, same deterministic scope across crashes, job+manifest durable-before-POST ordering, and artifact preservation. Resolve every Critical/High/Important finding before Task 4.

---

### Task 4: Preserve valid paid waits across runtime and boot

**Files:**
- Create: `electron/server/__tests__/paid-image-replacement-boot.test.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test: `electron/server/__tests__/job-queue-genstudio-resume.test.ts`

**Contract:** Add one explicit pure durable predicate and place it in `readPersistedJobs()` before generic interrupted-running classification:

```ts
function getValidPaidImageWait(
  job: Job,
): { attempt: PaidImageReplacementAttempt; dueAtMs: number } | null
```

The predicate requires running/un-finished eligible job, enabled valid snapshot, exactly one waiting attempt for the asset, complete original identity/hash/selector, valid balanced terminal settlement, exact +30-minute due time, exact checkpoint/manifest binding, no replacement scope/task/artifact, and no pause/cancel intent.

- [ ] **Step 1: Write RED predicate and source-order tests**

Create valid and malformed persisted fixtures for every predicate clause. Malformed state must return null, schedule no timer, and fall through to existing safe classification.

Add a structural source/behavior test proving the branch order is:

1. `pause_requested`;
2. valid paid wait;
3. ordinary recoverable audio/image;
4. cancellation/provider reconciliation;
5. generic `Interrupted by app restart` terminalization.

The test must fail if paid wait moves below the generic fallback or if ordinary recovery consumes a terminally failed paid checkpoint first.

- [ ] **Step 2: Write RED boot before/after due tests**

With injected clock/timer and isolated persisted jobs:

- boot before due preserves `running`, `finished_at: null`, `started_at`, duplicate lock, and evidence; occupies no lane; creates exactly one remaining-duration timer; makes no provider call;
- boot exactly at and after due durably queues the same job once, retains original `started_at`, enters recovery FIFO, creates no timer/provider call, and then uses normal pump;
- repeated `readPersistedJobs`, duplicate timer delivery, and boot/timer race produce one pending copy;
- persistence failure before requeue leaves the durable wait and no in-memory queued duplicate.

- [ ] **Step 3: Write RED cleanup tests**

For a scheduled wait, assert timer removal on cancel, explicit pause, clear, terminalization, commitment/requeue, and predicate invalidation. Turning machine setting Off must preserve durable attempt evidence, remove/prevent due work, and yield zero POSTs. Clearing a timer must never delete artifacts or durable evidence.

- [ ] **Step 4: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-boot \
  --only job-queue-genstudio-resume
```

- [ ] **Step 5: Implement precedence and one bounded timer map**

Insert the valid-wait branch in `readPersistedJobs()` after explicit pause handling and before ordinary recovery/cancellation/generic terminalization. Before due, keep the same running job outside active lane counts and schedule one keyed timer. At/after due, persist same-job `queued` first, retain `started_at`, insert once into the recovery class, and invoke the merged v1.4.91 normal pump.

Use one per-job timeout map with injected test seams. Scheduling the same job replaces or ignores the existing timer. Timer callback only revalidates predicate, durably requeues, and pumps. It never reads price, calls task control, calls admission, or POSTs. Centralize cleanup calls in existing cancel/pause/clear/terminal/commit/requeue paths; add no interval or polling loop.

- [ ] **Step 6: Run GREEN and restart regressions**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-boot \
  --only job-queue-genstudio-resume \
  --only job-queue-concurrency \
  --only adaptive-image-tail-overlap \
  --only no-new-wallclock-sleeps
```

- [ ] **Step 7: Commit and independently review**

```bash
git add electron/server/services/job-queue.ts \
  electron/server/__tests__/paid-image-replacement-boot.test.ts
git commit -m "feat: resume durable paid image waits"
```

Reviewer inspects exact branch precedence, malformed fallthrough, before/after-due persistence, duplicate delivery, timer cleanup, no provider call from loader/timer, and preserved v1.4.91 fairness. Resolve findings before Task 5.

---

### Task 5: Integrate the shared gate with supported image generators

**Files:**
- Create: `electron/server/__tests__/paid-image-replacement-integration.test.ts`
- Modify: `electron/server/generators/continuity-render.ts`
- Modify: `electron/server/generators/image-pool-generate.ts`
- Modify: `electron/server/generators/images.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test: `electron/server/__tests__/image-route-exhausted-retry.test.ts`
- Test: `electron/server/__tests__/job-queue-genstudio-resume.test.ts`

- [ ] **Step 1: Write RED generator and crash-boundary tests**

For Continuity, Pool, and durable thumbnail assets, prove:

1. same-task recovery runs first;
2. exact zero-settlement/full-release uses existing safe retry;
3. positive terminal infrastructure settlement yields durable wait and releases the Story image lane;
4. before due, no replacement POST;
5. due re-entry submits only the already committed deterministic scope through normal admission;
6. usable artifact appearing at any point completes/preserves it without replacement;
7. partial batch replacement touches only the missing asset;
8. replacement failure records evidence and never chains another paid attempt.

Cover crashes before commitment, between job/manifest writes, after both writes before POST, after POST before acceptance, after acceptance before artifact, and after artifact before completion audit. Every recovery must produce at most one replacement scope/task identity.

Add explicit audio, transcription, music, video, unsupported image, cancel, pause, and current-setting-Off fixtures proving no paid-image attempt/POST. Use injected clocks, durable temp roots, and deferred calls; do not sleep for 30 minutes or perform paid/live requests.

- [ ] **Step 2: Run RED**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-integration \
  --only paid-image-replacement-policy \
  --only paid-image-replacement-boot \
  --only image-route-exhausted-retry
```

- [ ] **Step 3: Wire one typed waiting result and committed submit path**

At each supported generator’s existing terminal branch:

1. recover/reconcile original task;
2. run exact zero-settlement retry;
3. call shared paid decision;
4. on `wait`, checkpoint and return the queue’s typed paid-wait result;
5. on `commit`, verify job+manifest binding and submit only its scope/key;
6. record accepted/state/settlement under existing manifest/job evidence;
7. validate/download to the original expected output;
8. complete only through existing expected-versus-present audit.

`runJob` keeps a waiting job `running`/unfinished and duplicate-locked, releases its image lane in `finally`, and delegates timer handling to Task 4. Do not put paid logic in the generic GenStudio retry loop. Do not change Pool’s internal serial concurrency. No audio/video module may import the helper.

- [ ] **Step 4: Run GREEN and complete adjacent recovery suite**

```bash
node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-integration \
  --only paid-image-replacement-policy \
  --only paid-image-replacement-boot \
  --only paid-image-replacement-settings \
  --only image-route-exhausted-retry \
  --only job-queue-genstudio-resume \
  --only genstudio-image-integration \
  --only genstudio-release-qualification \
  --only adaptive-image-tail-overlap \
  --only no-new-wallclock-sleeps
```

- [ ] **Step 5: Commit and independently review**

```bash
git add electron/server/generators/continuity-render.ts \
  electron/server/generators/image-pool-generate.ts \
  electron/server/generators/images.ts \
  electron/server/services/job-queue.ts \
  electron/server/__tests__/paid-image-replacement-integration.test.ts
git commit -m "feat: replace confirmed failed images once"
```

Reviewer traces all provider POST sites, admitted executor ownership, same-task/zero-settlement precedence, durable scope binding, crash recovery, artifact preservation, Pool serial behavior, and absence of audio/video imports. Resolve findings before Task 6.

---

### Task 6: Add explicit settings and Jobs visibility

**Files:**
- Create: `frontend/__tests__/paidImageRecoverySettings.test.ts`
- Modify: `frontend/components/ThisMacSettings.vue`
- Modify: `frontend/pages/projects/[slug]/jobs.vue`
- Test: `frontend/__tests__/jobsControls.test.ts`
- Test: `frontend/__tests__/usePresets.test.ts`

- [ ] **Step 1: Write RED settings and Jobs tests**

Assert initial GET renders Off with no guessed ceiling. Enabling without a positive whole number blocks PUT. Valid save sends exactly:

```ts
{
  paid_image_replacement: {
    enabled: true,
    additional_credit_ceiling: 50,
  },
}
```

Assert the copy communicates confirmed failure, original-task reconnect first, 30-minute wait, exact current published price refresh, per-job credit limit, one replacement per image, and “Time alone never proves a task stopped.” It must expose no audio/video option or preset save/apply path.

For Jobs fixtures, assert customer-safe waiting, committed published credits/version, blocked reason, submitted, succeeded/failed, and actual settled credits. Keep task/idempotency IDs inside existing Technical details only; never label a replacement “free” or “duplicate-proof.”

- [ ] **Step 2: Run RED**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/paidImageRecoverySettings.test.ts \
  __tests__/jobsControls.test.ts \
  __tests__/usePresets.test.ts
cd ..
```

- [ ] **Step 3: Implement the smallest native UI**

Add one section to `ThisMacSettings.vue`: native labeled On/Off control, numeric input `min="1" step="1"` required only when enabled, inline validation, fixed wait/max copy, busy/disabled Save, and `aria-live="polite"` result. Apply the server’s echoed record after save. Keep this save independent from throughput settings.

In Jobs, render one compact line from the latest bounded attempt using existing time/credit formatters and Technical details. Do not add a component library, modal, new filter, card reorder, or new polling path; reuse SSE.

- [ ] **Step 4: Run GREEN and production build**

```bash
cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/paidImageRecoverySettings.test.ts \
  __tests__/jobsControls.test.ts \
  __tests__/usePresets.test.ts
cd ..
npm run build
```

- [ ] **Step 5: Perform rendered accessibility QA**

Use test fixtures only; do not submit live images. Inspect This Mac settings and Project/All Jobs at desktop, approximately 390 px, and 200% zoom. Verify Off default, invalid enabled-without-ceiling state, saved On state, all attempt states, keyboard focus, labels/errors, no horizontal overflow/clipping, and no spending control receives initial focus. Capture screenshots or exact observations in PR evidence.

- [ ] **Step 6: Commit and independently review**

```bash
git add frontend/components/ThisMacSettings.vue \
  'frontend/pages/projects/[slug]/jobs.vue' \
  frontend/__tests__/paidImageRecoverySettings.test.ts
git commit -m "feat: expose paid image recovery controls"
```

Reviewer checks spend wording, quote-versus-settlement distinction, keyboard/narrow layout, current Off behavior, IDs under Technical details, and preset isolation. Resolve findings before Task 7.

---

### Task 7: Release and independently verify v1.4.92

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump exact release surfaces**

Set `1.4.92` in `package.json`, root `package-lock.json.version`, and root package `package-lock.json.packages[""].version`. Add newest-first `## v1.4.92 — 2026-08-31` changelog copy stating: optional image-only setting; Off default; authoritative failed-task evidence; fixed 30-minute wait; exact current published price; one replacement per image; required per-job additional-credit ceiling; audio/video unchanged. Do not claim worker loss, guaranteed delivery, free retry, or impossible duplicate charge.

- [ ] **Step 2: Run release integrity and full verification**

```bash
npm run check:changelog

node scripts/testing/run-backend-tests.mjs \
  --only paid-image-replacement-settings \
  --only paid-image-replacement-policy \
  --only paid-image-replacement-boot \
  --only paid-image-replacement-integration \
  --only image-route-exhausted-retry \
  --only job-queue-genstudio-resume \
  --only genstudio-image-integration \
  --only genstudio-release-qualification \
  --only adaptive-image-tail-overlap \
  --only no-new-wallclock-sleeps

cd frontend
node ../node_modules/tsx/dist/cli.mjs --import ./__tests__/setup.ts --test \
  __tests__/paidImageRecoverySettings.test.ts \
  __tests__/jobsControls.test.ts \
  __tests__/usePresets.test.ts
cd ..

npm run verify
git diff --check
git status --short
```

The unfiltered `npm run verify` is mandatory. Capture exact commands, exit codes, relevant counts, rendered QA, and confirmation that no paid network request occurred. Confirm no new dependency and no audio/video paid-recovery import.

- [ ] **Step 3: Commit release metadata**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v1.4.92"
```

- [ ] **Step 4: Obtain final independent review**

Request clean-context billing/idempotency/recovery and UX review against this spec and the complete diff. Require explicit assessment of every POST path, durable-before-POST writes, exact selector/reference pricing, live catalogue/account provenance, ceiling concurrency, `readPersistedJobs` precedence, boot before/after due, timer cleanup, artifacts, preset boundary, and modality boundary. Resolve every Critical/High/Important finding and rerun affected focused tests plus `npm run verify`.

---

### Task 8: Integrate v1.4.92 and build the main DMG

- [ ] **Step 1: Confirm clean integration preconditions**

```bash
git status --short
git log --oneline --decorate -8
gh pr checks --watch
```

Require a clean branch based on merged v1.4.91, completed reviews, passing verification/checks, and mergeability. Never force-push.

- [ ] **Step 2: Push, create/update, and merge the separate v1.4.92 PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
gh pr checks --watch
gh pr merge --merge --delete-branch
```

If a PR exists, update it rather than duplicating it. Stop on unresolved checks/review/mergeability. Do not publish, deploy, tag, sign/notarize, install, activate billing, or make paid provider calls.

- [ ] **Step 3: Synchronize main and build the release artifact**

From the main repository checkout, fast-forward `main`, confirm `HEAD` contains the v1.4.92 merge and all version surfaces report `1.4.92`, then run:

```bash
npm run dist:smoke
```

Verify the arm64 DMG exists in main’s normal `dist/`, filename/version is `1.4.92`, and bundled `app.asar` reports `1.4.92`. Record PR URL, merge commit, absolute DMG path, size, checksum if normally recorded, and smoke output. Do not publish.

## Definition of Done

- Off default, required ceiling, eligible image-only snapshot, and preset exclusion are proven.
- Terminal/settlement evidence precedes time; 30 minutes alone never authorizes spend.
- Exact `{resolution, aspect_ratio, width, height, reference_mode}` matching selects the correct live normal/reference price and version.
- Durable wait predicate and restart precedence preserve valid waits before generic terminalization.
- Boot before/after due and all timer cleanup/idempotency cases pass.
- Job and manifest agree on one deterministic scope before every replacement POST; ceiling and one-attempt guards survive crashes/restarts.
- Existing artifacts, zero-settlement retry, v1.4.91 scheduling, and unsupported modalities remain protected.
- v1.4.92 is independently reviewed, fully verified, separately merged, synchronized to main, and its main-built DMG is verified.
