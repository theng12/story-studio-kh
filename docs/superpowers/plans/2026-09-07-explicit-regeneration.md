# Explicit Regeneration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every current, explicit Regenerate action submit fresh paid work once while retaining the same idempotency identity across recovery and Jobs Retry.

**Architecture:** Each deliberate click supplies a stable `operation_id` correlation UUID. Routes validate that UUID, ignore client attempts to supply authority, and normalize one server-owned `generation_action: { id, kind: 'fresh' }` for authorized force/new-version actions; repeated delivery of the same operation rejoins its existing job. Generators fold that durable action ID into their existing per-item request identity; normal Generate/missing recovery keeps its current semantic identity. Pipeline forwards force into the selected generator parameters, while paused legacy video workflows are audited only.

**Tech Stack:** TypeScript, Express, Vue 3/Nuxt, Node test runner.

**Spec:** `<owner-home>/pinokio/_handoffs/2026-09-07_generator-regenerate-semantics-audit.md`

## Global Constraints

- No paid generation, production data writes, service restart, dependency, or framework change.
- A new direct user action gets a new action ID; retry/restart of that action keeps the ID.
- Ordinary Generate, missing-only recovery, active/uncertain rejoin, cancellation, and completion fencing remain unchanged.
- Release metadata is prepared for v1.4.124; commit, integration, and release verification remain coordinated after final review.
- Motion Review / image-to-video is owner-paused and inventory-only; no workflow change is included.

---

### Task 1: Durable explicit-action marker

**Files:**
- Modify: `electron/server/models/types.ts`
- Modify: existing audio/subtitle routes and generators owned by the audio/subtitle worker
- Test: focused audio/subtitle recovery tests

**Interfaces:**
- Consumes: client `operation_id` as correlation only; a new click creates a new UUID and an HTTP retransmission keeps it.
- Produces: `generation_action?: { id: string; kind: 'fresh' }` on server-created job params.
- Routes validate `operation_id`, discard any client `generation_action`, normalize the marker only for force/new-version, and reuse an existing matching job. Queue Retry copies the marker unchanged.

- [x] Write failing tests for new-click/new-ID, same-operation HTTP rejoin, Retry/same-ID, missing recovery/no marker, and no-manifest subtitle force.
- [x] Run the focused tests and confirm the expected identity failures.
- [x] Add the marker at the route boundary and consume it in existing identities/ledgers.
- [x] Re-run focused tests to green.

### Task 2: Script, opening, and prompt regeneration

**Files:**
- Modify: `electron/server/routes/scripts.ts`
- Modify: `electron/server/generators/episode.ts`
- Modify: `electron/server/generators/image-prompts.ts`
- Modify: `electron/server/routes/image-prompts-edit.ts`
- Modify: `electron/server/routes/scene-plan.ts`
- Modify: `electron/server/generators/scene-plan.ts`
- Modify: `frontend/pages/projects/[slug]/image-prompts.vue`
- Test: focused route/generator identity tests

**Interfaces:**
- Consumes: `generation_action` from Task 1.
- Produces: fresh request identities only for outline force, chapter regenerate, existing Introduction replacement, thumbnail-prompt force, and per-row visual/motion/prompt rewrites.

- [x] Write failing tests showing identical explicit actions currently compute/reuse the old identity.
- [x] Run the focused tests and record the red failures.
- [x] Stamp one action on each explicit route/job and pass it to the relevant `callAi` request identity.
- [x] Make unchecked Thumbnail Prompts preserve verified prompts (`fill_gaps`) and checked Force regenerate replace all under the fresh action.
- [x] Re-run focused tests to green; verify normal resumable prompt packs retain their saved semantic identities.

### Task 3: Image surfaces and motion inventory boundary

**Files:**
- Modify/test only the active image paths owned by the image QA worker.
- Inspect only: `electron/server/routes/ai-video.ts`, `electron/server/generators/ai-video.ts`, `frontend/pages/projects/[slug]/motion-review.vue`

**Interfaces:**
- Existing Images-board and continuity `force` paths stay intact.
- Non-continuity per-scene image regeneration receives the shared marker/action scope.

- [x] Add a failing caller test for non-continuity Regenerate replaying the stable scene identity.
- [x] Apply the marker to that explicit route/generator without changing missing-only image recovery.
- [x] Record Motion Review and retired AI-video identity defects as paused/deferred; make no workflow change.

### Task 4: Pipeline force forwarding

**Files:**
- Modify: `electron/server/routes/pipeline.ts`
- Test: `electron/server/__tests__/pipeline-step-skip.test.ts`

**Interfaces:**
- `force: true` continues to bypass completed-step filtering and additionally reaches every selected generator as `params.force = true`.
- Repair Missing continues to reject force and keeps its action-scoped recovery contract.

- [x] Add a failing route test asserting the queued root and every child link receive force for a normal forced batch.
- [x] Run the focused test and confirm the current “enqueued but not forced” failure.
- [x] Apply force once to the completed chain before enqueue; do not alter normal or repair chains.
- [x] Re-run focused pipeline tests to green.

### Task 5: Final focused verification and review

**Files:**
- Update: `<owner-home>/pinokio/_handoffs/2026-09-07_generator-regenerate-semantics-audit.md`

- [x] Run the coordinated focused backend/frontend tests only when the single lane is free.
- [x] Run type checks requested by the coordinator; do not start the full suite.
- [x] Re-scan every visible Regenerate label to its payload and every touched generator to its request identity.
- [x] Record exact commands, counts, exits, changed files, and remaining paused/deferred findings for root review.


## Evidence and remaining boundary

- Focused backend aggregate: `node scripts/testing/run-backend-tests.mjs --only explicit-chat-regeneration --only pipeline-explicit-regeneration --only pipeline-step-skip --only audio-subtitle-explicit-regeneration --only explicit-regeneration-actions` — exit 0, 39 tests and 4 suites passed (5 files), recorded in `<owner-home>/pinokio/_handoffs/logs/story-release-1.4.124/explicit-regeneration-focused-attempt4.log`.
- Targeted cleanup rerun: `node scripts/testing/run-backend-tests.mjs --only pipeline-explicit-regeneration` — exit 0, 1/1 passed; the fixture awaits job persistence before cleanup.
- Type checks: Electron and frontend each exited 0; frontend evidence is `<owner-home>/pinokio/_handoffs/logs/story-release-1.4.124/explicit-regeneration-typecheck-frontend-final2.exit`.
- Motion Review / image-to-video remains owner-paused and intentionally unchanged.
- Full `npm run verify`, independent final review, integration, and canonical-main packaging are release steps, not yet claimed here.
