# Credit-Floor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every new Story Studio submission after GenStudio refuses an account for insufficient credits, while preserving accepted work and enabling missing-only recovery.

**Architecture:** Extend the existing admission boundary with an API-key-scoped balance hold, use one exact 402 classifier at generator catch boundaries, terminalize rejected pre-dispatch evidence, and register Scene Plan's existing disk audit with restart finalization. Reuse existing queues, idempotency previews, and completion auditors; add no dependency or second scheduler.

**Tech Stack:** TypeScript, Node.js `node:test`, Electron backend, Nuxt frontend source tests, existing Mock GenStudio service.

## Global Constraints

- GenStudio remains authoritative for dispatch, settlement, and credit balance.
- Never abort or reclassify an accepted provider job.
- Never log, persist, or hash-display a raw API key.
- A 402 is terminal pre-dispatch evidence and costs no inferred amount.
- Retry preserves completed outputs and submits only missing targets.
- Use TDD for every production behavior change.
- No new dependency or parallel queue.

---

### Task 1: API-key-scoped admission hold

**Files:**
- Modify: `electron/server/lib/genstudio-admission.ts`
- Modify: `electron/server/lib/genstudio-client.ts`
- Test: `electron/server/__tests__/genstudio-admission.test.ts`

**Interfaces:**
- Produces: `isGenStudioInsufficientCredits(error: unknown): error is GenStudioApiError`
- Produces: `GenStudioAdmissionPool.noteInsufficientCredits(apiKey: string, error: Error): void`
- Extends: `GenStudioAccountCapacity.credit_balance?: number`

- [ ] Add failing admission tests for same-key waiter rejection, different-key isolation, unchanged-balance retention, and increased-balance release.
- [ ] Run the focused admission test and record the expected RED assertions.
- [ ] Implement the minimal keyed hold and forward `credit_balance` from account overview.
- [ ] Call the hold from the exact 402 branch; do not clear it from unrelated successful responses.
- [ ] Run the focused admission test GREEN and commit.

### Task 2: Definitive pre-dispatch evidence

**Files:**
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/services/job-queue.ts`
- Test: `electron/server/__tests__/genstudio-request-preview.test.ts`
- Test: `electron/server/__tests__/genstudio-client-boundary.test.ts`

**Interfaces:**
- Produces: a queue update keyed by the existing request preview's idempotency key.
- Persists: `state: 'failed'`, `dispatch_state: 'pre_dispatch'`, `queue_state: 'waiting_credits'`.

- [ ] Add a failing real-client boundary test proving 402 leaves one terminal preview with its original key and no provider ID/settlement.
- [ ] Run the focused test and record RED.
- [ ] Thread the existing operation/preview into the shared submission helper and update the pending record on 402.
- [ ] Verify the evidence is removable/retryable and does not trigger read-only provider reconciliation.
- [ ] Run focused tests GREEN and commit.

### Task 3: Scene Plan credit-floor stop

**Files:**
- Modify: `electron/server/generators/scene-plan.ts`
- Test: `electron/server/__tests__/scene-plan-genstudio.test.ts`
- Test: `electron/server/__tests__/scene-plan-completion.test.ts`

**Interfaces:**
- Consumes: `isGenStudioInsufficientCredits`.
- Preserves: existing bounded repair for actual incomplete settled output.

- [ ] Add a failing multi-pack test where pack one returns 402 and assert one POST, zero repair POSTs, zero later-pack POSTs, and preserved prior prompts.
- [ ] Run it RED.
- [ ] Rethrow 402 from `requestPromptPack` before missing-output classification.
- [ ] Make the terminal error name the saved count and missing-only Retry.
- [ ] Run Scene Plan focused tests GREEN and commit.

### Task 4: Batch-wide stop across modalities

**Files:**
- Modify only catch/worker boundaries in the affected generators under `electron/server/generators/` and `electron/server/lib/chunked-narration.ts`.
- Test: extend the existing focused generator suites and Mock GenStudio fixture.

**Interfaces:**
- Consumes: `isGenStudioInsufficientCredits`.
- Rule: set the batch fatal state and rethrow; workers must not claim another item.

- [ ] Add failing representative tests for parallel listicle, image, TTS, transcription, and video batches, each asserting no item after the first observed 402 is submitted.
- [ ] Run each test RED before touching its production boundary.
- [ ] Add the minimal fatal-error check to per-item catches/worker loops, including sibling image and scene-clip producers that share those patterns.
- [ ] Preserve accepted/completed item checkpoints and existing route-exhaustion retry behavior.
- [ ] Run all affected generator suites GREEN and commit.

### Task 5: Scene Plan restart auditor

**Files:**
- Modify: `electron/server/boot/executors.ts`
- Reuse: `electron/server/services/scene-prompt-checkpoint.ts`
- Test: `electron/server/__tests__/job-cancellation-reconciliation.test.ts`

**Interfaces:**
- Registers: `scene_plan_run` output auditor.
- Returns: `complete` only when every requested stable scene ID has the required visual or motion prompt.

- [ ] Add failing cold-restart tests for complete and partial settled Scene Plan evidence.
- [ ] Run them RED.
- [ ] Register a stage-aware auditor using the existing Scene Plan path resolver and prompt completion audit.
- [ ] Verify complete reaches Done once; partial reaches repair-required Error and retains outputs.
- [ ] Run reconciliation tests GREEN and commit.

### Task 6: Release and installed-app verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [ ] Run focused backend and frontend tests, both typechecks, lint, and `git diff --check`.
- [ ] Request an independent code review and address every Critical/Important finding with RED→GREEN evidence.
- [ ] Bump package and lock to v1.0.825 and add the newest-first changelog entry.
- [ ] Run `check:changelog`, `check:release`, full `npm run verify`, both production audits, `dist:smoke`, and `verify:artifact`.
- [ ] Commit, push main, replace the installed unsigned app with the verified artifact, restart Story Studio, and verify its displayed version.
- [ ] Resume the Scene Plan job with the configured full-credit key and prove it requests only the 698 missing prompts before continuing the soak.
