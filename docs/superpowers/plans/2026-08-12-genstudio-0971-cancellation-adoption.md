# GenStudio 0.97.1 Cancellation Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Story Studio's adoption of GenStudio 0.97.1 so every supported generation modality uses authoritative pre-dispatch cancellation, read-only idempotency recovery, and exact settlement facts before the production soak resumes.

**Architecture:** Extend the existing shared GenStudio client and server-owned job-control/reconciliation flow; do not add a second cancellation system. The client owns the six exact endpoint maps and strict response parsing, while the classifier and restart-safe reconciler consume persisted provider evidence and keep duplicate locks until every sibling is authoritative and terminal. The Jobs page continues to render server-issued controls and GenStudio-published settlement without deriving refunds or charges.

**Tech Stack:** TypeScript, Electron/Express server, Nuxt/Vue frontend, Node test runner, existing Mock GenStudio service.

**Source design:** `docs/superpowers/specs/2026-08-11-generation-guard-and-cancellation-design.md`, extended by the deployed GenStudio 0.97.1 contract verified from live OpenAPI and `/build/Developer/_handoffs/2026-08-12_to-gpt-storystudio_from-claude-genstudio_{cancel-api-contract,cancel-endpoints-final-paths,deployed-0971}.md`.

## Global Constraints

- Cancellation is allowed only when GenStudio publishes `dispatch_state: "pre_dispatch"`; `dispatch_state: "dispatched"` is monotone and never cancellable, including Video.
- Trust GenStudio's response: `200` is authoritative cancellation truth, `409` means too late and remains settling, and `404`/transport/malformed responses remain fail-closed. Never retry a cancellation POST.
- Support exactly these operation/resource pairs: Chat `/v1/chat/responses`, Image `/v1/images`, Video `/v1/videos`, TTS `/v1/jobs`, Transcription `/v1/transcriptions`, and Music `/v1/music/jobs`.
- Every modality has a read-only `GET .../by-idempotency-key/{key}` path. An unknown key never permits a fresh paid submission.
- Preserve only published `dispatch_state`, `reserved_credits`, `settled_credits`, `released_credits`, `cancellable`, `cancelled`, and `cancellation_note`. Never infer a refund, charge, reservation, provider, or terminal result.
- Persist exact provider job IDs and idempotency keys. Keep the Story duplicate lock until every accepted sibling is authoritative and terminal.
- Provider success still requires the registered output auditor; cancellation must not weaken verified completion or missing-only repair.
- Reuse the existing `JobRemoteOperation`, GenStudio client, classifier, queue, reconciler, contracts, mock service, and Jobs UI. Add no dependency or compatibility layer.
- Use TDD: each behavior test must fail for the missing 0.97.1 adoption before production code changes, then pass after the minimal implementation.
- Ship as Story Studio v1.0.824 with matching package/lock/changelog, full `npm run verify`, production dependency audits, unsigned artifact verification, independent review, and no push without separate owner authorization.

---

### Task 1: Adopt the six-modality GenStudio control contract

**Files:**
- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/contracts/index.ts`
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/__tests__/fixtures/mock-genstudio-service.ts`
- Test: `electron/server/__tests__/genstudio-client-boundary.test.ts`
- Test: `electron/server/__tests__/genstudio-video-tts-transcription-hardening.test.ts`
- Test: `electron/server/__tests__/genstudio-chat-durable.test.ts`

**Interfaces:**
- Produces `JobRemoteOperation = 'voice.tts' | 'audio.transcription' | 'image.generation' | 'video.generation' | 'chat.response' | 'music.generation'`.
- Extends `GenStudioJob` and `GenStudioCancellationFields` with `dispatch_state?: 'pre_dispatch' | 'dispatched'`, `reserved_credits?`, `settled_credits?`, and `released_credits?`.
- Produces `getGenStudioJobByIdempotencyKey(operation, baseUrl, apiKey, key, request, deadline)` for all six operations.
- Retains `getGenStudioCancellationStatus(...)` and `requestGenStudioCancellation(...)`, now covering all six operations with exact paths.

- [ ] **Step 1: Write failing boundary tests using complete 0.97.1 fixtures**

Add literal fixtures containing:

```ts
{
  id: 'job_cancel_0971',
  state: 'failed',
  dispatch_state: 'pre_dispatch',
  cancellable: false,
  cancelled: true,
  cancellation_note: 'Cancelled before dispatch',
  reserved_credits: 13,
  settled_credits: 0,
  released_credits: 13,
}
```

Prove the strict parser preserves every valid field, rejects an invalid `dispatch_state`, and drops negative/non-numeric settlement values. Prove exact cancel/status/by-key paths for all six operations, including generic TTS `/v1/jobs/...`. A cancellation POST must execute once even when the response is lost.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/genstudio-client-boundary.test.ts \
  server/__tests__/genstudio-video-tts-transcription-hardening.test.ts \
  server/__tests__/genstudio-chat-durable.test.ts
```

Expected failures: Chat/Music are not valid `JobRemoteOperation` values, only four endpoint maps exist, and parser output omits `dispatch_state` plus the settlement triad.

- [ ] **Step 3: Implement the minimal shared client extension**

Use exact endpoint maps:

```ts
const CONTROL_RESOURCES: Record<JobRemoteOperation, string> = {
  'chat.response': '/v1/chat/responses',
  'image.generation': '/v1/images',
  'video.generation': '/v1/videos',
  'voice.tts': '/v1/jobs',
  'audio.transcription': '/v1/transcriptions',
  'music.generation': '/v1/music/jobs',
}
```

Derive status, cancel, and by-key paths from this one map. Keep cancellation `maxAttempts = 1`; status and by-key calls remain read-only. Validate numeric settlement fields as finite and non-negative, and accept only the two published dispatch states.

- [ ] **Step 4: Forward exact contract fields into durable Story evidence**

Add `dispatch_state` to every server/renderer job-evidence contract. Forward it and the settlement triad in `recordGenStudioEvidence`, `recordRemoteCancellation`, and serialized responses only when GenStudio supplied valid values. Remove the stale comment claiming Chat/Music omit settlement.

- [ ] **Step 5: Run focused tests and typechecks GREEN**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/genstudio-client-boundary.test.ts \
  server/__tests__/genstudio-video-tts-transcription-hardening.test.ts \
  server/__tests__/genstudio-chat-durable.test.ts
cd .. && npm run typecheck:electron && git diff --check
```

- [ ] **Step 6: Commit Task 1**

```bash
git add electron/server/models/types.ts electron/server/contracts/index.ts electron/server/lib/genstudio-client.ts electron/server/__tests__
git commit -m "feat: adopt GenStudio 0.97 cancellation contract"
```

---

### Task 2: Make controls and reconciliation authoritative across all six modalities

**Files:**
- Modify: `electron/server/services/job-control.ts`
- Modify: `electron/server/services/job-cancellation-reconciler.ts`
- Modify: `electron/server/services/job-queue.ts`
- Modify: `frontend/pages/projects/[slug]/jobs.vue`
- Test: `electron/server/__tests__/job-control.test.ts`
- Test: `electron/server/__tests__/job-cancellation-reconciliation.test.ts`
- Test: `electron/server/__tests__/job-cancel.test.ts`
- Test: `frontend/__tests__/jobsControls.test.ts`

**Interfaces:**
- Consumes the Task 1 six-operation type, strict status/cancel/by-key client calls, `dispatch_state`, and settlement fields.
- Produces one server-issued `request-remote-cancel` control only for exact `pre_dispatch` targets with `cancellable: true` and a registered output auditor.
- Produces restart-safe read-only reconciliation for IDs or persisted idempotency keys across all six operations.

- [ ] **Step 1: Write classifier RED tests**

Use table cases proving:

```text
Video + dispatched + cancellable=true -> no cancellation target
Chat + pre_dispatch + cancellable=true -> exact Chat target
Music + pre_dispatch + cancellable=true -> exact Music target
Any operation + missing/invalid dispatch_state -> fail-closed Return later
Any operation + pre_dispatch + cancellable=false -> no cancellation target
Mixed pre-dispatch and dispatched siblings -> cancel only eligible targets and keep the job locked
```

Also prove the customer reason says dispatched work continues settling and never promises a refund.

- [ ] **Step 2: Run classifier test and verify RED**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/job-control.test.ts
```

Expected failures: Video is still admitted from post-dispatch states; Chat/Music are unsupported; `dispatch_state` is ignored.

- [ ] **Step 3: Implement the minimal classifier correction**

Delete `VIDEO_POST_DISPATCH_STATES` and state-name inference for cancellation eligibility. For every remote operation, require exactly:

```ts
entry.dispatch_state === 'pre_dispatch' && entry.cancellable === true
```

Treat `dispatch_state === 'dispatched'` or `cancellable === false` as continuing settlement. Treat absent/unknown dispatch state as ambiguous and keep the duplicate lock. Preserve existing local stop, Pause, terminal-history, multi-target, and auditor gates.

- [ ] **Step 4: Write reconciliation RED tests**

Prove behavior through the real reconciler/queue seam:

```text
pending Chat ID -> GET status, cancel only while pre_dispatch, no generation POST
pending Music ID -> same
pending ID-less evidence with saved key -> modality by-key GET, adopt returned durable ID
404 by-key -> pending/locked, zero generation POSTs
409 cancel -> pending/settling; read-only polling continues
200 cancelled -> raw settlement recorded; terminal only after every sibling settles
dispatched target -> no cancel POST
restart -> same durable cancellation record and same exact key
```

The output auditor remains the only path from provider success to Story `done`.

- [ ] **Step 5: Run reconciler tests and verify RED**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/job-cancellation-reconciliation.test.ts \
  server/__tests__/job-cancel.test.ts
```

Expected failures: reconciler supports four status operations, special-cases Chat, and keeps Music unsupported.

- [ ] **Step 6: Implement six-modality reconciliation and evidence adoption**

Replace the four-operation set and Chat-only branch with Task 1's shared status/by-key functions. If evidence ID starts with `pending:` or is absent, require its persisted `request.idempotency_key`; a returned durable job ID replaces the pending evidence through existing `recordGenStudioJob`. A missing key or 404 stays pending. Never create a fresh idempotency key or generation POST.

Persist `dispatch_state`, settlement fields, cancellation response, and redacted reconciliation errors. A successful cancel may terminalize only after all accepted siblings are terminal and local execution/output auditing has completed.

- [ ] **Step 7: Update Jobs contracts/copy and test behavior**

Ensure `RJob.genstudio_jobs[]` and `remote_cancellations` include the new fields and Music operation. Render the server-issued control unchanged. Settlement display prefers direct per-job fields before account-history fallback and never says “released” without a published `released_credits` value. Remove any post-dispatch Video best-effort wording.

Run:

```bash
cd frontend && npx tsx --import ./__tests__/setup.ts --test __tests__/jobsControls.test.ts
cd .. && npm run typecheck
```

- [ ] **Step 8: Run the full Task 2 focused suite GREEN**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/job-control.test.ts \
  server/__tests__/job-cancellation-reconciliation.test.ts \
  server/__tests__/job-cancel.test.ts \
  server/__tests__/job-queue.test.ts \
  server/__tests__/genstudio-video-tts-transcription-hardening.test.ts
cd .. && npm run typecheck && git diff --check
```

- [ ] **Step 9: Commit Task 2**

```bash
git add electron/server/services electron/server/__tests__ frontend/pages/projects/'[slug]'/jobs.vue frontend/__tests__/jobsControls.test.ts
git commit -m "fix: reconcile GenStudio cancellation across modalities"
```

---

### Task 3: Release, conformance proof, and handoff closeout

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Move after adoption passes: the three pending GenStudio cancellation handoffs into `/build/Developer/_handoffs/_handoff-trash/`

**Interfaces:**
- Consumes reviewed Task 1–2 code.
- Produces Story Studio v1.0.824 release evidence and an unsigned arm64 DMG for owner testing.

- [ ] **Step 1: Independently review Tasks 1–2**

Generate a whole-branch review package from v1.0.823 to current HEAD. The reviewer must verify exact 0.97.1 paths/fields, one-shot cancel POST behavior, fail-closed 404/transport/malformed behavior, removal of post-dispatch Video cancellation, six-modality key lookup, sibling-lock semantics, and no inferred settlement.

- [ ] **Step 2: Fix every Critical or Important finding and re-review once**

Use one bounded fix wave. Re-run only covering tests during the fix loop, then obtain an independent clean verdict before release metadata.

- [ ] **Step 3: Bump release metadata to v1.0.824**

Update both package files and add a newest-first changelog entry describing authoritative six-modality cancellation, idempotency recovery, exact settlement, and removal of post-dispatch Video cancellation.

- [ ] **Step 4: Run full release verification**

```bash
npm run verify
npm audit --omit=dev
npm --prefix frontend audit --omit=dev
npm run dist:smoke
npm run verify:artifact
git diff --check
```

All commands must exit 0; both production audits must report zero vulnerabilities. The unsigned artifact is accepted for owner testing.

- [ ] **Step 5: Verify live contract read-only**

Read `http://127.0.0.1:8000/openapi.json` without an API key. Confirm version 0.97.1 and all twelve cancel/by-key paths. Do not submit or cancel a live job during release verification.

- [ ] **Step 6: Commit release and archive completed handoffs**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v1.0.824"
```

Only after focused/full verification and live read-only conformance pass, move the three pending cancellation/deployment handoffs into `_handoff-trash/`. Do not delete them. Do not push, tag, publish, or start the soak.
