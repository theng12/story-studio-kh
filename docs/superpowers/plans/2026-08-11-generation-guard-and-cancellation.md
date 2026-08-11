# Generation Guard and Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Story Studio's generation guards understandable and make cancellation, local stopping, provider cancellation requests, reconciliation, and terminal history removal financially truthful.

**Architecture:** A pure server-side classifier owns every job control decision and is serialized with each job. Active cancellation uses a dedicated POST route; terminal removal keeps DELETE. GenStudio cancellation intent and results are recorded per provider task until the provider confirms terminal state, while a restart-safe read-only reconciler polls without consuming a generation worker slot and hands missing artifacts to the existing Repair paths. Frontends only render server controls and shared visible reason text.

**Tech Stack:** TypeScript, Node.js/Electron, Express, Vue 3/Nuxt, Node test runner, existing GenStudio client and queue persistence.

## Global Constraints

- Preserve active/per-target duplicate locks, exact idempotency replay, missing-only repair, verified completion, live catalog/capability checks, prerequisites, admission, credits, and pipeline ordering.
- Never claim provider work stopped, credits were released, or a charge was prevented without authoritative GenStudio evidence.
- Unknown or ambiguous provider state remains nonterminal, retains the duplicate lock, and never permits a fresh paid submission.
- GenStudio 0.93.1 is authoritative: TTS/Image/Transcription cancel only before an active execution attempt; Video may return nonterminal `cancellation_requested`; Chat and Music have no cancel endpoint.
- No frontend modality or cost truth tables. The server classifier is the single control authority.
- No new dependencies, compatibility framework, invented catalog fields, paid generation, credential mutation, or GenStudio deployment.
- Apply Ponytail full mode: reuse queue evidence, existing local-execution proof, SSE serialization, and current status components before adding code.
- Every production behavior begins with a regression test that is observed failing for the intended reason.
- Release exactly `1.0.822`: update root `package.json`, `package-lock.json`, and newest-first `CHANGELOG.md`; run the full repository release workflow.

---

### Task 1: Server-owned job control classifier

**Files:**
- Create: `electron/server/services/job-control.ts`
- Create: `electron/server/services/job-cancellation-auditors.ts`
- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/services/job-retry-policy.ts`
- Test: `electron/server/__tests__/job-control.test.ts`

**Interfaces:**
- Produces: `classifyJobControl(job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations'>, capabilities: JobControlCapabilities): JobControl`.
- Produces: `isProvenLocalStopCapableJob(job: Pick<Job, 'type' | 'params'>): boolean`.
- Produces: `registerJobCancellationAuditor`, `hasJobCancellationAuditor`, and `JobCancellationAuditor`; Task 5 registers production auditors.
- Produces: `JobControl`, `JobControlAction`, `JobControlCode`, and `JobRemoteCancellation` types.
- Later tasks serialize `job.control = classifyJobControl(job, { remoteCancellationAudited: hasJobCancellationAuditor(job.type) })` and mutate only the per-target `job.remote_cancellations`; the frontend never recomputes these decisions.

- [ ] **Step 1: Write the classifier behavior tests**

Create table-driven tests with literal expected actions/reasons for:

```ts
[
  { status: 'queued', evidence: [], action: 'cancel-before-submit' },
  { status: 'paused', evidence: [], action: 'cancel-before-submit' },
  { status: 'running', type: 'video_assembly', action: 'stop-local' },
  { status: 'running', type: 'audio_merge', action: 'stop-local' },
  { status: 'running', operation: 'voice.tts', state: 'accepted', cancellable: true, action: 'request-remote-cancel' },
  { status: 'running', operation: 'image.generation', state: 'reserved', cancellable: true, action: 'request-remote-cancel' },
  { status: 'running', operation: 'audio.transcription', state: 'accepted', cancellable: true, action: 'request-remote-cancel' },
  { status: 'running', operation: 'video.generation', state: 'running', action: 'request-remote-cancel' },
  { status: 'running', operation: 'chat.response', state: 'running', action: 'return-later' },
  { status: 'running', operation: 'image.generation', state: 'running', cancellable: false, action: 'pause-submissions' },
  { status: 'running', operation: 'image.generation', state: 'submitting', action: 'return-later' },
  { status: 'running', remoteCancellation: 'requested', action: 'return-later' },
  { status: 'done', action: 'clear-history' },
  { status: 'error', action: 'clear-history' },
  { status: 'cancelled', action: 'clear-history' },
]
```

Also prove that “no GenStudio evidence” does not make an unknown cloud model local, mixed batch evidence fails closed, and `remoteCancellationAudited: false` never exposes request-cancellation even with an accepted ID. Local model identifiers alone are insufficient for `stop-local`: only `video_assembly`, `audio_merge`, `broll_normalize`, and `broll_assemble` may enter the initial stop-capable set after their real child/cooperative-stop tests pass; all other local text/image/audio jobs remain Pause/Return later until separately proven.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/job-control.test.ts
```

Expected: failure because `job-control.ts`, `JobControl`, and `remote_cancellations` do not exist.

- [ ] **Step 3: Implement the minimal types and pure classifier**

Use these public shapes:

```ts
export type JobControlAction =
  | 'cancel-before-submit'
  | 'stop-local'
  | 'request-remote-cancel'
  | 'pause-submissions'
  | 'return-later'
  | 'clear-history'
  | 'none'

export type JobControlCode =
  | 'READY'
  | 'PROVIDER_WORK_ALREADY_STARTED'
  | 'CANCELLATION_STATUS_UNKNOWN'
  | 'REMOTE_CANCELLATION_NOT_SUPPORTED'
  | 'JOB_NOT_AT_SAFE_LOCAL_STOP'

export interface JobControl {
  action: JobControlAction
  enabled: boolean
  label: string
  reason: string
  code: JobControlCode
  financial_effect: 'no-provider-request' | 'local-only' | 'remote-result-required' | 'provider-work-may-settle' | 'history-only' | 'none'
  targets?: Array<{ operation: JobRemoteOperation; provider_job_id: string }>
}

export type JobRemoteOperation = 'voice.tts' | 'audio.transcription' | 'image.generation' | 'video.generation'

export interface JobControlCapabilities {
  remoteCancellationAudited: boolean
}

export interface JobRemoteCancellation {
  status: 'queued' | 'submitting' | 'requested' | 'reconciling' | 'confirmed' | 'rejected' | 'unknown'
  operation: JobRemoteOperation
  provider_job_id: string
  requested_at: string
  updated_at: string
  http_status?: number
  state?: string
  cancellable?: boolean
  cancelled?: boolean
  cancellation_requested?: boolean
  cancellation_note?: string | null
  failure_code?: string | null
  released_credits?: number
}
```

Add `remote_cancellations?: Record<string, JobRemoteCancellation>` keyed by `${operation}:${provider_job_id}` and the derived `control` field to `Job`. Extend every `genstudio_jobs` contract shape with published optional `cancellable`, `cancelled`, `cancellation_requested`, `cancellation_note`, and `released_credits`. Keep cost/local-model proof reusable, but make stop capability a stricter positive allowlist backed by behavior tests; never equate “local” with “cooperatively stoppable.” For a multi-item job, the classifier returns the exact eligible targets and its reason names any already-started items that will continue settling; it never treats a job-wide intent as proof that every target was cancelled. Video is the only operation eligible for request-cancellation after dispatch, and no type is eligible without `remoteCancellationAudited`.

- [ ] **Step 4: Run focused tests and typecheck GREEN**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/job-control.test.ts
npm run typecheck:electron
git diff --check
```

- [ ] **Step 5: Commit the task**

```bash
git add electron/server/services/job-control.ts electron/server/services/job-cancellation-auditors.ts electron/server/services/job-retry-policy.ts electron/server/models/types.ts electron/server/__tests__/job-control.test.ts
git commit -m "feat: classify safe job controls"
```

---

### Task 2: Split cancellation from terminal history removal

**Files:**
- Modify: `electron/server/services/job-queue.ts`
- Modify: `electron/server/routes/jobs.ts`
- Modify: `electron/server/contracts/index.ts`
- Test: `electron/server/__tests__/job-cancel.test.ts`
- Test: `electron/server/__tests__/job-queue.test.ts`
- Test: `electron/server/__tests__/jobs-route-order.test.ts`
- Test: all existing direct `cancelJob()` call sites under `electron/server/__tests__/`

**Interfaces:**
- Consumes: `classifyJobControl()` and `JobControl` from Task 1.
- Produces: `requestJobCancellation(projectSlug: string, jobId: string): Promise<Job>`; for remote work it atomically queues one record per exact target.
- Produces: `removeTerminalJob(projectSlug: string, jobId: string): boolean`.
- Produces routes `POST /projects/:slug/jobs/:jobId/cancel`, `POST /jobs/all/:jobId/cancel`, and terminal-only DELETE at the existing item URLs.

- [ ] **Step 1: Write route and queue RED tests**

Prove observable behavior:

```ts
// queued/no evidence: POST cancel -> 200, cancelled, no provider evidence
// running proven local: POST cancel -> 200, SIGTERM, cancelled
// every initial stop-local type (video_assembly, audio_merge, broll_normalize,
// broll_assemble) proves its real child/cooperative stop; an unproven local
// text/image/audio executor is not offered stop-local
// running remote noncancellable: POST cancel -> 409 with { code, control, detail }
// mixed/multi-target batch: each eligible provider id is queued exactly once;
// already-started/noncancellable ids remain settling and are named in the reason
// terminal: POST cancel -> 409
// active: DELETE -> 409 and job remains active
// terminal: DELETE -> 200 and row is removed; files/result/evidence are untouched
// wrong project slug: POST and DELETE -> 404; no cross-project mutation
// universal /jobs/all routes enforce the same classifier
```

Update old tests that used `cancelJob()` as fixture cleanup to call the appropriate explicit API (`requestJobCancellation` for live fixtures, `removeTerminalJob` for terminal fixtures). Do not preserve an ambiguous exported alias.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/job-cancel.test.ts server/__tests__/job-queue.test.ts server/__tests__/jobs-route-order.test.ts
```

Expected: new POST routes are absent and DELETE still cancels active work.

- [ ] **Step 3: Implement explicit queue operations and route contracts**

`requestJobCancellation` must:

```ts
const control = classifyJobControl(job, {
  remoteCancellationAudited: hasJobCancellationAuditor(job.type),
})
if (!control.enabled) throw new JobControlError(control)
if (control.action === 'cancel-before-submit') return cancelQueuedBeforeSubmit(job)
if (control.action === 'stop-local') return stopLocalJob(job)
if (control.action === 'request-remote-cancel') return queueRemoteCancellationTargets(job, control.targets || [])
throw new JobControlError(control)
```

`removeTerminalJob` accepts only `done|error|cancelled`. The route maps ownership failure to 404 and invalid state to 409 with the classifier payload. Concurrent repeated POSTs must leave one `queued|submitting|requested` record per target. `Job.status` remains `running` with `finished_at: null` throughout remote cancellation/reconciliation; do not add a new `JobStatus`. Serialize `control` freshly in `getJob`, list snapshots, SSE updates, and enqueue responses rather than persisting a stale derived value. Add the exact `control`, `remote_cancellations`, and GenStudio cancellation-field shapes to `electron/server/contracts/index.ts` so SSE/snapshot/enqueue consumers share the same API contract.

- [ ] **Step 4: Run focused tests, adjacent stream tests, and typecheck GREEN**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/job-cancel.test.ts server/__tests__/job-queue.test.ts server/__tests__/jobs-route-order.test.ts server/__tests__/jobs-stream.test.ts server/__tests__/job-queue-persistence-retention.test.ts
npm run typecheck:electron
git diff --check
```

- [ ] **Step 5: Commit the task**

```bash
git add electron/server/services/job-queue.ts electron/server/routes/jobs.ts electron/server/contracts/index.ts electron/server/__tests__
git commit -m "fix: separate job cancellation from removal"
```

---

### Task 3: Preserve authoritative GenStudio cancellation results

**Files:**
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/services/job-queue.ts`
- Modify: `electron/server/__tests__/fixtures/mock-genstudio-service.ts`
- Test: `electron/server/__tests__/genstudio-video-tts-transcription-hardening.test.ts`
- Test: `electron/server/__tests__/genstudio-image-integration.test.ts`
- Test: `electron/server/__tests__/genstudio-release-qualification.test.ts`

**Interfaces:**
- Consumes: `JobRemoteCancellation` and queue request state from Tasks 1–2.
- Produces: `requestGenStudioCancellation(operation, baseUrl, apiKey, providerJobId, request, deadline): Promise<GenStudioJob>` with typed published response fields.
- Produces: queue functions `claimRemoteCancellation(storyJobId, operation, providerJobId): boolean` and `recordRemoteCancellation(storyJobId, operation, providerJobId, evidence)`.

- [ ] **Step 1: Extend the mock with the real 0.93.1 cancellation contract**

Add zero-cost handlers for:

```text
POST /v1/jobs/:id/cancel
POST /v1/images/:id/cancel
POST /v1/transcriptions/:id/cancel
POST /v1/videos/:id/cancel
```

Fixtures must cover terminal cancellation with positive `released_credits`, terminal cancellation with zero/missing release, pre-execution 409, Video `cancellation_requested: true` while nonterminal, terminal success/failure racing the cancel request, transport close, and repeated cancellation.

- [ ] **Step 2: Write client RED tests**

Assert real boundary behavior:

```ts
// TTS/Image/Transcription confirmed cancel records raw response then terminal cancellation.
// Their 409 keeps the operation polling/reconciling and never emits queue_state=cancelled.
// Video cancellation_requested keeps polling until GET reports terminal state.
// Race-to-succeeded returns the generated result; race-to-failed preserves provider failure.
// Transport/timeout records unknown and makes zero replacement POSTs.
// Missing/zero released_credits produces no release assertion or synthetic value.
// Repeated request is idempotent at the same provider job id.
// Two accepted targets in one Story batch each post once and retain separate outcomes.
// Simultaneous user clicks cannot make a second cancellation POST for either target.
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/genstudio-video-tts-transcription-hardening.test.ts server/__tests__/genstudio-image-integration.test.ts server/__tests__/genstudio-release-qualification.test.ts
```

Expected: current helper suppresses response/errors and immediately emits local cancellation.

- [ ] **Step 4: Implement typed cancellation and nonterminal reconciliation**

Replace the swallowing helper with an operation map that contains only the four published routes. Parse and retain these fields only when actually present:

```ts
type GenStudioCancellationFields = {
  state: string
  cancellable?: boolean
  cancelled?: boolean
  cancellation_requested?: boolean
  cancellation_note?: string | null
  failure_code?: string | null
  released_credits?: number
}
```

The route only queues exact targets. The poller that already owns each target and API key atomically calls `claimRemoteCancellation(storyJobId, operation, providerJobId)`; only the successful claimant sends the cancellation POST and records its response/error. Other pollers only observe status. This is the single concurrency-ownership rule for route clicks, polling, and restart recovery. Pollers continue status polling unless the returned provider state is terminal and must not call `onQueueState('cancelled')` from Story intent alone. The Story job remains `running` until **every accepted required target**, including targets excluded from `control.targets` because they are already noncancellable, reaches authoritative terminal state. Only then may the queue choose `cancelled`, `error`, or verified `done`; a 409, Video pending response, timeout, transport error, or any still-settling sibling retains `running`, `finished_at: null`, and the duplicate lock.

- [ ] **Step 5: Run focused tests and typecheck GREEN**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/genstudio-video-tts-transcription-hardening.test.ts server/__tests__/genstudio-image-integration.test.ts server/__tests__/genstudio-release-qualification.test.ts
npm run typecheck:electron
git diff --check
```

- [ ] **Step 6: Commit the task**

```bash
git add electron/server/lib/genstudio-client.ts electron/server/models/types.ts electron/server/services/job-queue.ts electron/server/__tests__/fixtures/mock-genstudio-service.ts electron/server/__tests__/genstudio-video-tts-transcription-hardening.test.ts electron/server/__tests__/genstudio-image-integration.test.ts electron/server/__tests__/genstudio-release-qualification.test.ts
git commit -m "fix: preserve provider cancellation truth"
```

---

### Task 4: Complete accepted-ID and cancellation-signal producer boundaries

**Files:**
- Modify: `electron/server/providers/types.ts`
- Modify: `electron/server/providers/video/genstudio.ts`
- Modify: `electron/server/generators/ai-video.ts`
- Modify: `electron/server/generators/scene-image.ts`
- Modify: `electron/server/generators/composition-template.ts`
- Verify without unnecessary production edits: `electron/server/generators/audio.ts`, `subtitles.ts`, `images.ts`, `scene-images-batch.ts`, `continuity-render.ts`, `image-pool-generate.ts`, `scene-clip.ts`
- Test: `electron/server/__tests__/genstudio-video-tts-transcription-hardening.test.ts`
- Test: `electron/server/__tests__/genstudio-release-qualification.test.ts`
- Test: create `electron/server/__tests__/generation-control-wiring.test.ts`

**Interfaces:**
- Consumes: the per-target claim/record boundary inside the GenStudio client from Task 3 and the existing queue-local `isCancelled(jobId)` probe for proven local stops.
- Produces: `VideoGenerationRequest.onJobAccepted?: (taskId: string, idempotencyKey: string, variantIndex: number) => void | Promise<void>`.
- Produces: durable accepted-ID/key records before polling for every queue-backed path enabled for remote request-cancellation.

- [ ] **Step 1: Write producer-wiring RED tests**

Use real generator/provider seams to prove:

```ts
// scene_image_generate observes queue-local stop through isCancelled instead of a constant false,
// while its accepted GenStudio target separately reaches the per-target client claim path.
// its accepted task ID and idempotency key are persisted before the first poll.
// composition-template observes cancellation and persists a prepared/key record before POST.
// generic GenStudio Video invokes onJobAccepted before its first status GET.
// ai-video writes the variant manifest accepted ID/key before provider completion.
// accepted-ID absence keeps classifyJobControl from exposing request-remote-cancel.
// audio, both subtitle modes, scene/thumbnail images, scene-images batch,
// continuity, image-pool, and direct scene clip all checkpoint the exact
// accepted id/key before their first provider status poll.
```

The mutation that restores `isCancelled: () => false` or removes the generic Video callback must fail these tests.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/generation-control-wiring.test.ts server/__tests__/genstudio-video-tts-transcription-hardening.test.ts server/__tests__/genstudio-release-qualification.test.ts
```

- [ ] **Step 3: Add the smallest callback and signal wiring**

Forward `onJobAccepted` from `VideoGenerationRequest` through only the GenStudio video provider, passing the explicit zero-based variant index. In `ai-video.ts`, map that index to `${stem}_v${index + 1}.mp4` manifest records containing `provider`, `task_id`, `idempotency_key`, `operation: 'video'`, and `last_state: 'accepted'` before polling completes. Replace Scene Image's constant false probe with the queue-owned local-stop probe; its remote-cancellation behavior remains the distinct Task 3 per-target claim performed inside the GenStudio client after the accepted ID exists. Persist the accepted idempotency key. Bring Composition Template to the same prepared/accepted boundary without changing its generation result. Exercise every listed producer's existing prepared/accepted callback in the inventory test; change production only where the test proves its accepted-ID boundary is absent.

- [ ] **Step 4: Run the producer inventory tests and typecheck GREEN**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/generation-control-wiring.test.ts server/__tests__/genstudio-video-tts-transcription-hardening.test.ts server/__tests__/genstudio-release-qualification.test.ts server/__tests__/genstudio-image-integration.test.ts
npm run typecheck:electron
git diff --check
```

- [ ] **Step 5: Commit the task**

```bash
git add electron/server/providers/types.ts electron/server/providers/video/genstudio.ts electron/server/generators/ai-video.ts electron/server/generators/scene-image.ts electron/server/generators/composition-template.ts electron/server/__tests__
git commit -m "fix: checkpoint cancellable provider work"
```

---

### Task 5: Restart-safe read-only cancellation reconciliation

**Files:**
- Create: `electron/server/services/job-cancellation-reconciler.ts`
- Modify: `electron/server/services/job-cancellation-auditors.ts`
- Modify: `electron/server/services/job-queue.ts`
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/boot/executors.ts`
- Test: create `electron/server/__tests__/job-cancellation-reconciliation.test.ts`
- Test: `electron/server/__tests__/job-queue-persistence-retention.test.ts`
- Test: `electron/server/__tests__/job-queue-concurrency.test.ts`

**Interfaces:**
- Consumes: persisted per-target `remote_cancellations`, accepted GenStudio evidence, and existing task manifests/Repair paths.
- Produces: `reconcilePendingJobCancellation(job: Job, apiKey: string): Promise<JobCancellationReconcileOutcome>` using operation-specific GenStudio status/cancel endpoints and registered output auditors.
- Consumes the Task 1 registry: `registerJobCancellationAuditor(type: JobType, auditor: JobCancellationAuditor): void`, where `JobCancellationAuditor = (job: Job) => Promise<'complete' | 'repair-required'>`.
- Invariant: a reconciliation-only job retains its active duplicate lock but is not counted in the normal generation worker lane.

- [ ] **Step 1: Write restart and capacity RED tests**

Persist realistic jobs and prove:

```ts
// requested/unknown remote cancellation restores as nonterminal reconciling.
// it remains visible and isDuplicate(...) remains true.
// Retry, Remove, and fresh enqueue remain blocked.
// normal queue capacity can run an unrelated job while reconciliation polls.
// reconciler performs operation-specific status GETs and, only for a persisted
// unperformed cancellation intent whose live target is still contractually
// cancellable, the same idempotent cancellation POST; it submits zero generation POSTs.
// confirmed cancelled -> Story cancelled; provider failed -> Story error.
// provider succeeded -> the registered producer auditor decides verified Done
// versus Story error with a visible Repair-first result.
// completed artifacts/evidence survive settlement and terminal history removal.
// no registered auditor -> fail closed and never expose remote cancellation for that type.
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/job-cancellation-reconciliation.test.ts server/__tests__/job-queue-persistence-retention.test.ts server/__tests__/job-queue-concurrency.test.ts
```

- [ ] **Step 3: Implement a small reconciliation registry**

Do not create a second queue. On load, jobs with any target in `queued|submitting|requested|reconciling|unknown` enter a persisted reconciliation set while `Job.status` stays `running` and `finished_at` stays null. The service first reads the published operation status. If a persisted `queued` intent is still cancellable, or a lost-response `submitting` intent is proven by the read to remain cancellable, it atomically claims and sends the same idempotent cancellation request for that provider job ID; it never sends a generation POST. It then uses published status GET endpoints, emits normal job SSE updates, and retains the duplicate lock until every required accepted target is authoritative terminal.

Register the smallest output-audit callback beside each existing executor in `boot/executors.ts`:

```text
audio -> getAudioStatus(...).missing.length === 0
subtitles_transcribe -> inspectSubtitleCompletion(..., { require_per_section: true }).complete
images|scene_images|thumb_images -> getImageStatus(...) expected sets have zero missing
scene_image_generate|scene_images_batch|continuity_render -> auditSceneImageCompletion(...)
composition_generate -> composition.png exists and is nonempty/decodable
image_pool_generate -> its genstudio_recovery asset keys resolve to nonempty pool files
scene_clip_generate|scene_clips_batch -> auditSceneClipCompletion(...)
video -> getVideoStatus(...).total > 0 && present === total
```

Task 4 checkpoints the asset keys and plan paths these callbacks require. When every provider target succeeds, run the registered auditor: `complete` permits verified Done; `repair-required` preserves files/evidence and terminalizes Story as Error with `{ provider_settled: 'succeeded', repair_required: true }`, directing the user to the existing zero-resubmission Repair path. Unsupported types have no auditor, remain fail-closed, and never receive `request-remote-cancel` from the classifier. Unsupported/missing API access stays nonterminal with visible reason. Reconciliation polling is owned by the persisted set, not a generation queue lane.

- [ ] **Step 4: Run focused tests and typecheck GREEN**

```bash
cd electron && STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/job-cancellation-reconciliation.test.ts server/__tests__/job-queue-persistence-retention.test.ts server/__tests__/job-queue-concurrency.test.ts server/__tests__/job-cancel.test.ts
npm run typecheck:electron
git diff --check
```

- [ ] **Step 5: Commit the task**

```bash
git add electron/server/services/job-cancellation-reconciler.ts electron/server/services/job-cancellation-auditors.ts electron/server/services/job-queue.ts electron/server/lib/genstudio-client.ts electron/server/boot/executors.ts electron/server/__tests__
git commit -m "fix: reconcile pending cancellations after restart"
```

---

### Task 6: Render truthful controls and visible generation guards

**Files:**
- Modify: `frontend/composables/useJobs.ts`
- Modify: `frontend/composables/useAllJobs.ts`
- Modify: `frontend/pages/projects/[slug]/jobs.vue`
- Modify: `frontend/pages/remote.vue`
- Modify: `frontend/components/TopActionBar.vue`
- Modify: `frontend/components/ImageGeneratorPanel.vue`
- Modify: `frontend/components/AudioChapterSelector.vue`
- Modify only where a missing status is confirmed: `frontend/pages/projects/[slug]/images.vue`, `audio.vue`, `pipeline.vue`, `scene-plan.vue`
- Test: create `frontend/__tests__/jobsControls.test.ts`
- Test: `frontend/__tests__/universalJobs.test.ts`
- Test: `frontend/__tests__/useJobs.test.ts`
- Test: `frontend/__tests__/topActionBarFeedback.test.ts`
- Test: create `frontend/__tests__/generationGuardVisibility.test.ts`

**Interfaces:**
- Consumes: serialized `job.control` and `job.remote_cancellations` from Tasks 1–5.
- Consumes the exact shared `JobEnqueuedResponse.control`, `remote_cancellations`, and extended `genstudio_jobs` fields added to `electron/server/contracts/index.ts`.
- Produces no frontend modality truth table; both Jobs surfaces render the returned action/label/reason.
- `TopActionBar` associates persistent `generateStatus` text with its primary action through `aria-describedby`.

- [ ] **Step 1: Write frontend RED tests**

Behavior assertions:

```ts
// active cancellation sends POST `${jobQueuePath(job)}/cancel`.
// terminal Remove sends DELETE to the item path.
// jobs.vue contains no COST_INCURRING_TYPES or REMOTE_CANCELLABLE_TYPES.
// remote.vue contains no unqualified Stop/Stop all provider claim.
// remote.vue renders the same per-row server controls as Jobs.
// its bulk action POSTs only enabled cancel-before-submit, stop-local, and
// request-remote-cancel rows; leaves return-later/unsupported rows untouched;
// and reports exact requested/skipped counts without a provider-stop promise.
// labels come from server control: Cancel before submission, Stop local work,
// Request cancellation, Pause new submissions, Return later, Remove.
// cancellation-requested remains active and visually says Story is reconciling.
// terminal copy says files and billing records are unchanged.
// TopActionBar renders status visibly and associates it with the disabled CTA.
// Image panel says completed images are preserved and only missing scenes submit.
// Audio section shows duplicate/prerequisite reason as text, not title-only.
// Pipeline and Scene Plan expose their already-computed blocking reason beside the action.
```

- [ ] **Step 2: Run frontend tests and verify RED**

```bash
cd frontend && npx tsx --import ./__tests__/setup.ts --test __tests__/jobsControls.test.ts __tests__/universalJobs.test.ts __tests__/useJobs.test.ts __tests__/topActionBarFeedback.test.ts __tests__/generationGuardVisibility.test.ts
```

- [ ] **Step 3: Replace client truth tables with server controls**

Render controls using a single action dispatcher:

```ts
if (control.action === 'cancel-before-submit' || control.action === 'stop-local' || control.action === 'request-remote-cancel') {
  await post(`${jobQueuePath(job)}/cancel`, {})
} else if (control.action === 'clear-history') {
  await del(jobQueuePath(job))
}
```

`pause-submissions` uses the existing Pause endpoint. `return-later` is explanatory/navigation behavior and does not mutate job state. Remove both frontend sets and all refund/provider-stop inference. Show `control.reason` as readable text. Display raw cancellation/settlement fields only through the existing GenStudio evidence components, and only say credits were released when the published positive field exists.

- [ ] **Step 4: Make shared guard reasons persistent and accessible**

Keep the existing Popover as supplemental help, but render `generateStatus` persistently beside or below the TopActionBar CTA and connect it with a stable generated id through `aria-describedby`. Fill only confirmed blank/generic statuses on Images, Audio, Pipeline, and Scene Plan; reuse `useJobs().isJobActiveFor`, existing `blockingIssues`, and existing missing-only counts. Do not create a new page-local status store.

- [ ] **Step 5: Run frontend tests and Nuxt typecheck GREEN**

```bash
cd frontend && npx tsx --import ./__tests__/setup.ts --test __tests__/jobsControls.test.ts __tests__/universalJobs.test.ts __tests__/useJobs.test.ts __tests__/topActionBarFeedback.test.ts __tests__/generationGuardVisibility.test.ts
npm --prefix frontend run typecheck
git diff --check
```

- [ ] **Step 6: Commit the task**

```bash
git add frontend/composables frontend/pages frontend/components frontend/__tests__
git commit -m "feat: explain safe generation controls"
```

---

### Task 7: Release integrity, full verification, and packaged visual QA

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Update implementation plan checkboxes as execution evidence.

**Interfaces:**
- Consumes all prior tasks.
- Produces Story Studio KH `1.0.822`, a clean release commit, pushed branch/main according to the accepted release workflow, and an unsigned test DMG.

- [ ] **Step 1: Add the release metadata**

Set both package versions to `1.0.822`. Add newest-first:

```markdown
## v1.0.822

- Made job controls financially truthful: cancellation, local stopping, provider cancellation requests, reconciliation, and history removal are now distinct actions.
- Preserved provider cancellation outcomes and resumed pending reconciliation safely after restarts without duplicate generation.
- Added visible explanations for duplicate, prerequisite, reconciliation, post-dispatch, and missing-only generation guards.
```

- [ ] **Step 2: Run release metadata gates**

```bash
npm run check:changelog
npm run check:release
git diff --check
```

- [ ] **Step 3: Run the full verification suite**

```bash
npm run verify
npm audit --omit=dev
npm --prefix frontend audit --omit=dev
```

Expected: verification exits 0; lint may report the repository's existing warning count but must report zero errors; both production audits report zero vulnerabilities.

- [ ] **Step 4: Build and verify the unsigned soak artifact**

```bash
npm run dist:smoke
npm run verify:artifact
shasum -a 256 "dist/Story Studio KH 1.0.822-arm64.dmg"
```

- [ ] **Step 5: Perform packaged visual QA without paid calls**

Launch the packaged app and capture/inspect:

```text
Jobs: Cancel before submission; Stop local work; Request cancellation;
Cancellation requested/reconciling; provider work cannot be cancelled;
terminal Remove; Clear finished.
Shared action bar: named prerequisite, duplicate lock, reconciliation block,
and missing-only preservation copy.
Remote page at narrow width: no generic Stop/Stop all provider promise.
```

Verify keyboard focus, readable adjacent reasons, no color-only state, no overflow/clipping, and no live provider generation submission.

- [ ] **Step 6: Run independent final review and fix one consolidated wave**

The reviewer compares the full branch to the approved spec, with special attention to paid-work identity, classify→cancel races, restart locks, release language, and frontend/server authority. Any Critical/Important findings are fixed in one consolidated TDD wave and re-reviewed once.

- [ ] **Step 7: Commit and push the release**

```bash
git add package.json package-lock.json CHANGELOG.md docs/superpowers/plans/2026-08-11-generation-guard-and-cancellation.md
git commit -m "release: v1.0.822"
git push
```

Report the commit, artifact path/SHA-256, verification counts, visually checked states, any intentionally deferred GenStudio contract work, and whether the production soak is cleared to resume.
